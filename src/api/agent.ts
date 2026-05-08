/**
 * Agent Router
 *
 * Endpoints consumed exclusively by the macOS Lock Agent daemon.
 * All routes require the `agent` JWT role.
 *
 *   GET  /agent/state      — current enforcement state for this device
 *   POST /agent/heartbeat  — liveness check
 *   POST /agent/event      — report tamper events / state changes
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { evaluateDeviceState } from '../services/ruleEngine.js';

// ── Validation schemas ────────────────────────────────────────────────────────

const HeartbeatSchema = z.object({
  agentVersion:     z.string().max(50),
  osVersion:        z.string().max(50),
  currentLocalState:z.enum(['locked', 'unlocked', 'unknown']),
  uptimeSeconds:    z.number().int().min(0),
  timestamp:        z.string().datetime(),
});

const AgentEventSchema = z.object({
  eventType: z.enum([
    'agent_restart',
    'state_applied',
    'state_apply_failed',
    'clock_skew_detected',
    'safe_mode_boot',
    'mdm_profile_removed',
    'network_extension_disabled',
    'vpn_detected',
    'session_expired_locally',
    'offline_lock_applied',
    'token_refresh_needed',
  ]),
  severity:  z.enum(['info', 'warning', 'error', 'critical']),
  timestamp: z.string().datetime(),
  metadata:  z.record(z.unknown()).optional().default({}),
});

// ── Route handler ─────────────────────────────────────────────────────────────

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /agent/state ──────────────────────────────────────
  fastify.get(
    '/state',
    { preHandler: [fastify.authenticate, fastify.requireAgent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;
      const deviceId = user.deviceId!;

      // Verify device is still registered and active
      const deviceRows = await sql<{ id: string; isActive: boolean }[]>`
        SELECT id, is_active
        FROM devices
        WHERE id = ${deviceId}
          AND family_id = ${user.familyId}
        LIMIT 1
      `;

      if (!deviceRows[0]) {
        return reply.status(410).send({
          error: {
            code: 'DEVICE_DEREGISTERED',
            message: 'This device has been removed from Mosaic',
          },
        });
      }

      if (!deviceRows[0].isActive) {
        return reply.status(410).send({
          error: {
            code: 'DEVICE_INACTIVE',
            message: 'Device has been deactivated',
          },
        });
      }

      // Evaluate current enforcement state via Rule Engine
      const state = await evaluateDeviceState(deviceId);

      return reply.send({
        deviceId,
        state:      state.state,
        reason:     state.reason,
        serverTime: state.serverTime,
        session:    state.state === 'unlocked' && state.sessionId
          ? {
              id:              state.sessionId,
              endsAt:          state.sessionId
                ? new Date(Date.now() + (state.remainingSeconds ?? 0) * 1000).toISOString()
                : null,
              remainingSeconds: state.remainingSeconds,
            }
          : null,
        enforcement: {
          allowedApps:                  state.allowedApps,
          allowedDomains:               state.allowedDomains,
          blockAllNetworkExceptAllowed: state.state === 'locked',
        },
        nextPollSeconds: state.nextPollSeconds,
      });
    },
  );

  // ── POST /agent/heartbeat ─────────────────────────────────
  fastify.post(
    '/heartbeat',
    { preHandler: [fastify.authenticate, fastify.requireAgent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;
      const deviceId = user.deviceId!;

      const body = HeartbeatSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { agentVersion, osVersion, currentLocalState } = body.data;

      // Update last heartbeat and agent metadata in DB
      const rows = await sql<{ id: string }[]>`
        UPDATE devices
        SET
          last_heartbeat_at = NOW(),
          agent_version     = ${agentVersion},
          os_version        = ${osVersion},
          current_state     = ${currentLocalState}::device_state
        WHERE id = ${deviceId}
          AND family_id = ${user.familyId}
          AND is_active = TRUE
        RETURNING id
      `;

      if (!rows[0]) {
        return reply.status(410).send({
          error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found or inactive' },
        });
      }

      // Write audit log entry for heartbeat (low-priority, fire-and-forget)
      sql`
        INSERT INTO audit_log (family_id, device_id, actor_role, action, metadata)
        VALUES (
          ${user.familyId},
          ${deviceId},
          'agent',
          'device_heartbeat',
          ${JSON.stringify({ agentVersion, osVersion, currentLocalState })}::JSONB
        )
      `.catch(() => {});  // don't fail the response if audit log write fails

      return reply.send({
        acknowledged: true,
        serverTime:   new Date().toISOString(),
      });
    },
  );

  // ── POST /agent/event ─────────────────────────────────────
  fastify.post(
    '/event',
    { preHandler: [fastify.authenticate, fastify.requireAgent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;
      const deviceId = user.deviceId!;

      const body = AgentEventSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { eventType, severity, metadata } = body.data;

      // Map event type to audit_action
      const auditAction = isTamperEvent(eventType) ? 'tamper_event' : 'device_heartbeat';

      // Write to audit log
      await sql`
        INSERT INTO audit_log (
          family_id, device_id, actor_role,
          action, entity_type, metadata
        )
        VALUES (
          ${user.familyId},
          ${deviceId},
          'agent',
          ${auditAction}::audit_action,
          'device',
          ${JSON.stringify({ eventType, severity, ...metadata })}::JSONB
        )
      `;

      // For critical tamper events: send FCM push to parent
      const actions: Array<{ type: string; reason: string }> = [];

      if (severity === 'critical' || severity === 'error') {
        await notifyParentsOfTamper(user.familyId, deviceId, eventType).catch(() => {});
      }

      // For clock_skew_detected: instruct agent to lock immediately
      if (eventType === 'clock_skew_detected') {
        actions.push({ type: 'lock_immediately', reason: 'clock_skew_detected' });
      }

      // For agent_restart after tamper indicators: force state re-evaluation
      if (eventType === 'agent_restart' || eventType === 'network_extension_disabled') {
        actions.push({ type: 'apply_state', reason: eventType });
      }

      return reply.send({
        acknowledged: true,
        actions,
      });
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTamperEvent(eventType: string): boolean {
  return [
    'safe_mode_boot',
    'mdm_profile_removed',
    'network_extension_disabled',
    'clock_skew_detected',
    'vpn_detected',
    'agent_restart',
  ].includes(eventType);
}

async function notifyParentsOfTamper(
  familyId: string,
  deviceId: string,
  eventType: string,
): Promise<void> {
  // Get device name and parent tokens
  const rows = await sql<{ deviceName: string; tokens: string[] }[]>`
    SELECT
      d.device_name,
      ARRAY_AGG(nt.token) FILTER (WHERE nt.token IS NOT NULL AND nt.is_active = TRUE) AS tokens
    FROM devices d
    LEFT JOIN notification_tokens nt ON nt.family_id = d.family_id
    LEFT JOIN users u ON u.id = nt.user_id AND u.role = 'parent'
    WHERE d.id = ${deviceId}
      AND d.family_id = ${familyId}
    GROUP BY d.device_name
    LIMIT 1
  `;

  const result = rows[0];
  if (!result?.tokens?.length) return;

  const { sendPushNotification } = await import('../lib/firebase.js');
  await sendPushNotification(result.tokens, {
    title: 'Security Alert',
    body:  `${result.deviceName}: ${formatTamperEvent(eventType)}`,
    data:  {
      type:      'tamper_event',
      eventType,
      deviceId,
    },
  });
}

function formatTamperEvent(eventType: string): string {
  const labels: Record<string, string> = {
    safe_mode_boot:              'Device booted in Safe Mode',
    mdm_profile_removed:         'Mosaic configuration profile was removed',
    network_extension_disabled:  'Content filter was disabled',
    clock_skew_detected:         'System clock was changed',
    vpn_detected:                'Unauthorized VPN detected',
    agent_restart:               'Mosaic agent was restarted unexpectedly',
  };
  return labels[eventType] ?? `Security event: ${eventType}`;
}
