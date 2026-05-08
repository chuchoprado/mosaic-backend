/**
 * Timer Service
 *
 * Manages unlock session timers using Redis TTL keys.
 * When a Redis key expires, a keyspace notification fires and we update the DB.
 *
 * Redis key pattern:  mosaic:session:{deviceId}
 * Value:              JSON-serialized RedisSessionData
 * TTL:                Session duration in seconds
 */

import { sql } from '../lib/supabase.js';
import {
  redisClient,
  redisSubscriber,
  setSession,
  getSession,
  deleteSession,
  getSessionTTL,
  type RedisSessionData,
} from '../lib/redis.js';
import { invalidateDeviceStateCache } from './ruleEngine.js';

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? 'mosaic:';
const MAX_SESSION_SECONDS = parseInt(
  process.env.MAX_SESSION_DURATION_SECONDS ?? '86400',
  10,
);

// ── Session lifecycle ─────────────────────────────────────────────────────────

export interface StartSessionParams {
  deviceId:      string;
  childId:       string;
  familyId:      string;
  durationMinutes: number;
  approvalId?:   string;
}

export interface SessionInfo {
  sessionId:       string;
  deviceId:        string;
  childId:         string;
  endsAt:          Date;
  remainingSeconds: number;
  unlockMinutes:   number;
}

/**
 * Start an unlock session for a device.
 * 1. Writes session record to PostgreSQL (authoritative)
 * 2. Sets Redis key with TTL (fast expiry detection)
 * 3. Invalidates device state cache
 */
export async function startSession(params: StartSessionParams): Promise<SessionInfo> {
  const { deviceId, childId, familyId, durationMinutes, approvalId } = params;

  // Clamp to safety ceiling
  const clampedMinutes = Math.min(durationMinutes, MAX_SESSION_SECONDS / 60);
  const durationSeconds = clampedMinutes * 60;

  const endsAt = new Date(Date.now() + durationSeconds * 1000);

  // ── End any existing active session for this device ────────
  await endActiveSessionsForDevice(deviceId, 'rule_change');

  // ── Write to PostgreSQL ────────────────────────────────────
  const rows = await sql<{ id: string }[]>`
    INSERT INTO sessions (
      device_id, child_id, family_id, approval_id,
      ends_at, unlock_minutes, is_active
    )
    VALUES (
      ${deviceId}, ${childId}, ${familyId}, ${approvalId ?? null},
      ${endsAt.toISOString()}, ${clampedMinutes}, TRUE
    )
    RETURNING id
  `;

  const sessionId = rows[0]?.id;
  if (!sessionId) {
    throw new Error('Failed to create session record in database');
  }

  // ── Write to Redis with TTL ────────────────────────────────
  const sessionData: RedisSessionData = {
    sessionId,
    childId,
    deviceId,
    familyId,
    endsAt:        endsAt.toISOString(),
    unlockMinutes: clampedMinutes,
    startedAt:     new Date().toISOString(),
  };

  await setSession(deviceId, sessionData, durationSeconds);

  // ── Invalidate state cache ─────────────────────────────────
  await invalidateDeviceStateCache(deviceId);

  // ── Update device current_state in DB ─────────────────────
  await sql`
    UPDATE devices
    SET current_state = 'unlocked', last_state_change_at = NOW()
    WHERE id = ${deviceId}
  `;

  return {
    sessionId,
    deviceId,
    childId,
    endsAt,
    remainingSeconds: durationSeconds,
    unlockMinutes:    clampedMinutes,
  };
}

/**
 * Get the active session for a device, if one exists.
 * Reads from Redis (fast) and falls back to PostgreSQL if Redis miss.
 */
export async function getActiveSession(deviceId: string): Promise<SessionInfo | null> {
  // ── Try Redis first ────────────────────────────────────────
  const redisData = await getSession(deviceId);
  if (redisData) {
    const ttl = await getSessionTTL(deviceId);
    if (ttl > 0) {
      return {
        sessionId:       redisData.sessionId,
        deviceId:        redisData.deviceId,
        childId:         redisData.childId,
        endsAt:          new Date(redisData.endsAt),
        remainingSeconds: ttl,
        unlockMinutes:   redisData.unlockMinutes,
      };
    }
  }

  // ── Fall back to PostgreSQL ────────────────────────────────
  const rows = await sql<{
    id: string;
    childId: string;
    endsAt: Date;
    unlockMinutes: number;
  }[]>`
    SELECT id, child_id, ends_at, unlock_minutes
    FROM sessions
    WHERE device_id = ${deviceId}
      AND is_active = TRUE
      AND ends_at > NOW()
    ORDER BY ends_at DESC
    LIMIT 1
  `;

  if (!rows[0]) return null;

  const session = rows[0];
  const remainingSeconds = Math.max(
    0,
    Math.floor((session.endsAt.getTime() - Date.now()) / 1000),
  );

  if (remainingSeconds <= 0) return null;

  // Re-warm Redis cache
  const sessionData: RedisSessionData = {
    sessionId:     session.id,
    childId:       session.childId,
    deviceId,
    familyId:      '',  // not needed for cache
    endsAt:        session.endsAt.toISOString(),
    unlockMinutes: session.unlockMinutes,
    startedAt:     new Date().toISOString(),
  };
  await setSession(deviceId, sessionData, remainingSeconds);

  return {
    sessionId:       session.id,
    deviceId,
    childId:         session.childId,
    endsAt:          session.endsAt,
    remainingSeconds,
    unlockMinutes:   session.unlockMinutes,
  };
}

/**
 * Explicitly end a session (parent revokes, rule change, etc.)
 */
export async function endSession(
  sessionId: string,
  reason: 'parent_revoked' | 'rule_change' | 'manual_end' | 'agent_error',
): Promise<void> {
  const rows = await sql<{ deviceId: string }[]>`
    UPDATE sessions
    SET
      ended_at  = NOW(),
      end_reason = ${reason},
      is_active  = FALSE
    WHERE id = ${sessionId}
      AND is_active = TRUE
    RETURNING device_id
  `;

  const deviceId = rows[0]?.deviceId;
  if (!deviceId) return;  // already ended

  await deleteSession(deviceId);
  await invalidateDeviceStateCache(deviceId);

  await sql`
    UPDATE devices
    SET current_state = 'locked', last_state_change_at = NOW()
    WHERE id = ${deviceId}
  `;
}

/**
 * Get remaining seconds for a session by ID.
 * Returns 0 if session is not found or has expired.
 */
export async function getRemainingTime(sessionId: string): Promise<number> {
  // Look up device_id for this session to check Redis
  const rows = await sql<{ deviceId: string; endsAt: Date }[]>`
    SELECT device_id, ends_at
    FROM sessions
    WHERE id = ${sessionId}
      AND is_active = TRUE
    LIMIT 1
  `;

  if (!rows[0]) return 0;

  const { deviceId, endsAt } = rows[0];

  // Prefer Redis TTL (more accurate sub-second)
  const ttl = await getSessionTTL(deviceId);
  if (ttl > 0) return ttl;

  // Fall back to DB calculation
  return Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function endActiveSessionsForDevice(
  deviceId: string,
  reason: 'rule_change' | 'parent_revoked',
): Promise<void> {
  await sql`
    UPDATE sessions
    SET ended_at = NOW(), end_reason = ${reason}, is_active = FALSE
    WHERE device_id = ${deviceId}
      AND is_active = TRUE
  `;
  await deleteSession(deviceId);
}

/**
 * Handle session expiry event from Redis keyspace notification.
 * Called when a Redis key with pattern `session:{deviceId}` expires.
 */
async function handleSessionExpiry(deviceId: string): Promise<void> {
  console.info(`[TimerService] Session expired for device: ${deviceId}`);

  // Mark session as ended in DB (via expiry reason)
  const rows = await sql<{ id: string }[]>`
    UPDATE sessions
    SET ended_at = NOW(), end_reason = 'expired', is_active = FALSE
    WHERE device_id = ${deviceId}
      AND is_active = TRUE
      AND ends_at <= NOW() + INTERVAL '5 seconds'
    RETURNING id
  `;

  if (rows.length > 0) {
    await invalidateDeviceStateCache(deviceId);
    await sql`
      UPDATE devices
      SET current_state = 'locked', last_state_change_at = NOW()
      WHERE id = ${deviceId}
    `;
    console.info(`[TimerService] Marked ${rows.length} session(s) expired for device: ${deviceId}`);
  }
}

// ── Redis keyspace listener setup ─────────────────────────────────────────────

/**
 * Subscribe to Redis keyspace notifications for session key expiry.
 * Must be called once at server startup.
 *
 * Requires Redis to have `notify-keyspace-events` set to at least `KEx`.
 * We configure this programmatically.
 */
export async function startRedisKeyspaceListener(): Promise<void> {
  // Enable keyspace notifications for expired events
  // "K" = keyspace events, "x" = expired events
  await redisClient.config('SET', 'notify-keyspace-events', 'KEx');

  const db = 0;  // Redis database index
  const prefix = KEY_PREFIX.replace(/:$/, '');  // strip trailing colon
  const pattern = `__keyevent@${db}__:expired`;

  await redisSubscriber.psubscribe(pattern);

  redisSubscriber.on('pmessage', (_pattern, _channel, key) => {
    // key format: "mosaic:session:{deviceId}"
    const sessionKeyPrefix = `${prefix}:session:`;
    if (key.startsWith(sessionKeyPrefix)) {
      const deviceId = key.slice(sessionKeyPrefix.length);
      handleSessionExpiry(deviceId).catch(err => {
        console.error('[TimerService] Error handling session expiry:', err);
      });
    }
  });

  console.info('[TimerService] Redis keyspace listener started');
}
