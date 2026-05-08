/**
 * Rule Engine
 *
 * Determines the current enforcement state for a device by applying all
 * configured rules in priority order. This is the single source of truth
 * that the agent polls every 30 seconds.
 *
 * Priority order (highest to lowest):
 *   1. Bedtime schedule     — always lock if bedtime is active
 *   2. Lock schedule        — lock during configured school/activity hours
 *   3. Device inactive      — device or child account deactivated
 *   4. Active session       — approved session unlocks the device
 *   5. Default              — locked
 */

import { sql } from '../lib/supabase.js';
import { getSession, getSessionTTL, RedisKeys, redisClient } from '../lib/redis.js';

export interface DeviceEnforcementState {
  state:            'locked' | 'unlocked';
  reason:           string;
  remainingSeconds: number | null;  // null when locked
  allowedApps:      string[];       // bundle IDs always accessible (emergency apps)
  allowedDomains:   string[];       // domains accessible even when locked
  sessionId:        string | null;
  serverTime:       string;         // ISO8601, used by agent for clock validation
  nextPollSeconds:  number;
}

interface DeviceRow {
  id:        string;
  familyId:  string;
  childId:   string;
  isActive:  boolean;
  currentState: string;
}

interface RulesRow {
  emergencyApps:     string[];
  allowedDomains:    string[];
  lockSchedule:      LockScheduleEntry[];
  bedtimeStart:      string | null;   // "HH:MM"
  bedtimeEnd:        string | null;   // "HH:MM"
  maxSessionMinutes: number | null;
  dailyBudgetMinutes:number | null;
}

interface LockScheduleEntry {
  dayOfWeek:  number;   // 0 = Sunday, 6 = Saturday
  startTime:  string;   // "HH:MM"
  endTime:    string;   // "HH:MM"
  label?:     string;
}

interface SessionRow {
  id:            string;
  endsAt:        Date;
  unlockMinutes: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse "HH:MM" string into total minutes since midnight.
 */
function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Get current time-of-day in minutes since midnight in a given timezone.
 */
function currentMinutesInTimezone(timezone: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

/**
 * Get current day-of-week (0=Sunday) in a given timezone.
 */
function currentDayOfWeekInTimezone(timezone: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const day = formatter.format(now);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.indexOf(day);
}

/**
 * Check if bedtime is currently active.
 * Handles overnight bedtime (e.g., 22:00 → 07:00 next day).
 */
function isBedtimeActive(
  bedtimeStart: string,
  bedtimeEnd: string,
  timezone: string,
): boolean {
  const currentMins  = currentMinutesInTimezone(timezone);
  const startMins    = timeToMinutes(bedtimeStart);
  const endMins      = timeToMinutes(bedtimeEnd);

  if (startMins > endMins) {
    // Overnight: e.g., 22:00 → 07:00
    return currentMins >= startMins || currentMins < endMins;
  } else {
    // Same day: e.g., 12:00 → 14:00
    return currentMins >= startMins && currentMins < endMins;
  }
}

/**
 * Check if any lock schedule entry is currently active.
 */
function isScheduledLockActive(
  schedule: LockScheduleEntry[],
  timezone: string,
): boolean {
  if (schedule.length === 0) return false;

  const currentDay  = currentDayOfWeekInTimezone(timezone);
  const currentMins = currentMinutesInTimezone(timezone);

  return schedule.some(entry => {
    if (entry.dayOfWeek !== currentDay) return false;
    const startMins = timeToMinutes(entry.startTime);
    const endMins   = timeToMinutes(entry.endTime);
    return currentMins >= startMins && currentMins < endMins;
  });
}

/**
 * Get today's total unlocked minutes for a device (from Redis, falls back to DB).
 */
async function getTodayUsageMinutes(deviceId: string, timezone: string): Promise<number> {
  const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    .format(new Date()); // "YYYY-MM-DD"

  const redisKey = RedisKeys.dailyUsage(deviceId, todayDate);
  const cached   = await redisClient.get(redisKey);
  if (cached !== null) return parseInt(cached, 10);

  // Fall back to DB
  const rows = await sql<{ totalMinutes: number }[]>`
    SELECT COALESCE(SUM(unlock_minutes), 0)::INTEGER AS total_minutes
    FROM sessions
    WHERE device_id = ${deviceId}
      AND DATE(started_at AT TIME ZONE ${timezone}) = ${todayDate}::DATE
      AND is_active = FALSE
  `;

  const minutes = rows[0]?.totalMinutes ?? 0;
  // Cache for 60s
  await redisClient.set(redisKey, String(minutes), 'EX', 60);
  return minutes;
}

// ── Main export ───────────────────────────────────────────────────────────────

const DEVICE_STATE_CACHE_TTL = 10; // seconds — short TTL so approval is fast

/**
 * Evaluate the enforcement state for a device.
 * Results are cached in Redis for DEVICE_STATE_CACHE_TTL seconds.
 */
export async function evaluateDeviceState(
  deviceId: string,
): Promise<DeviceEnforcementState> {
  const serverTime = new Date().toISOString();

  // ── Check Redis cache first ────────────────────────────────
  const cacheKey = RedisKeys.deviceState(deviceId);
  const cached   = await redisClient.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as DeviceEnforcementState;
    // Re-calculate remainingSeconds from the live TTL, not the cached value
    if (parsed.state === 'unlocked' && parsed.sessionId) {
      const ttl = await getSessionTTL(deviceId);
      if (ttl <= 0) {
        // Session expired between cache writes — fall through to full evaluation
      } else {
        return {
          ...parsed,
          remainingSeconds: ttl,
          serverTime,
        };
      }
    } else {
      return { ...parsed, serverTime };
    }
  }

  // ── Load device + rules + family timezone ─────────────────
  const deviceRows = await sql<(DeviceRow & { timezone: string })[]>`
    SELECT
      d.id, d.family_id, d.child_id, d.is_active,
      d.current_state,
      f.timezone
    FROM devices d
    JOIN families f ON f.id = d.family_id
    WHERE d.id = ${deviceId}
    LIMIT 1
  `;

  const device = deviceRows[0];
  if (!device) {
    return locked('device_not_found', [], [], null, serverTime);
  }

  if (!device.isActive) {
    return locked('device_inactive', [], [], null, serverTime);
  }

  const rulesRows = await sql<RulesRow[]>`
    SELECT
      emergency_apps,
      allowed_domains,
      lock_schedule,
      bedtime_start,
      bedtime_end,
      max_session_minutes,
      daily_budget_minutes
    FROM rules
    WHERE device_id = ${deviceId}
    LIMIT 1
  `;

  const rules = rulesRows[0] ?? {
    emergencyApps:      [],
    allowedDomains:     [],
    lockSchedule:       [],
    bedtimeStart:       null,
    bedtimeEnd:         null,
    maxSessionMinutes:  null,
    dailyBudgetMinutes: null,
  };

  const tz = device.timezone ?? 'UTC';

  // ── Rule 1: Bedtime ────────────────────────────────────────
  if (rules.bedtimeStart && rules.bedtimeEnd) {
    if (isBedtimeActive(rules.bedtimeStart, rules.bedtimeEnd, tz)) {
      const result = locked(
        'bedtime',
        rules.emergencyApps,
        rules.allowedDomains,
        null,
        serverTime,
      );
      await cacheState(cacheKey, result);
      return result;
    }
  }

  // ── Rule 2: Lock schedule ──────────────────────────────────
  if (isScheduledLockActive(rules.lockSchedule, tz)) {
    const result = locked(
      'schedule',
      rules.emergencyApps,
      rules.allowedDomains,
      null,
      serverTime,
    );
    await cacheState(cacheKey, result);
    return result;
  }

  // ── Rule 3: Daily budget exhausted ────────────────────────
  if (rules.dailyBudgetMinutes !== null) {
    const usedMinutes = await getTodayUsageMinutes(deviceId, tz);
    if (usedMinutes >= rules.dailyBudgetMinutes) {
      const result = locked(
        'daily_budget_exhausted',
        rules.emergencyApps,
        rules.allowedDomains,
        null,
        serverTime,
      );
      await cacheState(cacheKey, result);
      return result;
    }
  }

  // ── Rule 4: Active session ─────────────────────────────────
  const sessionData = await getSession(deviceId);
  if (sessionData) {
    const ttl = await getSessionTTL(deviceId);
    if (ttl > 0) {
      // Apply max session cap if configured
      const effectiveTTL = rules.maxSessionMinutes !== null
        ? Math.min(ttl, rules.maxSessionMinutes * 60)
        : ttl;

      const result: DeviceEnforcementState = {
        state:            'unlocked',
        reason:           'active_session',
        remainingSeconds: effectiveTTL,
        allowedApps:      [],  // all apps allowed during session
        allowedDomains:   [],  // all domains allowed during session
        sessionId:        sessionData.sessionId,
        serverTime,
        // Poll more frequently when session is near expiry
        nextPollSeconds:  effectiveTTL < 120 ? 10 : 30,
      };

      await cacheState(cacheKey, result);
      return result;
    }
    // TTL expired — fall through to locked
  }

  // ── Rule 5: Default — locked ──────────────────────────────
  const result = locked(
    'no_active_session',
    rules.emergencyApps,
    rules.allowedDomains,
    null,
    serverTime,
  );
  await cacheState(cacheKey, result);
  return result;
}

function locked(
  reason: string,
  allowedApps: string[],
  allowedDomains: string[],
  sessionId: string | null,
  serverTime: string,
): DeviceEnforcementState {
  return {
    state:            'locked',
    reason,
    remainingSeconds: null,
    allowedApps,
    allowedDomains,
    sessionId,
    serverTime,
    nextPollSeconds:  30,
  };
}

async function cacheState(
  key: string,
  state: DeviceEnforcementState,
): Promise<void> {
  // Use raw client (no key prefix) since RedisKeys already includes prefix logic
  await redisClient.set(key, JSON.stringify(state), 'EX', DEVICE_STATE_CACHE_TTL);
}

/**
 * Invalidate the device state cache. Call this whenever:
 * - A session is created or ended
 * - Rules are updated
 * - A task is created or modified
 */
export async function invalidateDeviceStateCache(deviceId: string): Promise<void> {
  const cacheKey = RedisKeys.deviceState(deviceId);
  await redisClient.del(cacheKey);
}
