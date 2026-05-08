/**
 * Sessions Router
 *
 * GET    /sessions                    — list sessions (parent)
 * GET    /sessions/active/:deviceId   — get active session for device
 * DELETE /sessions/:sessionId         — revoke active session (parent)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { getActiveSession, endSession, getRemainingTime } from '../services/timerService.js';

const EndSessionSchema = z.object({
  reason: z.string().max(200).optional(),
});

const ListSessionsQuerySchema = z.object({
  deviceId:   z.string().uuid().optional(),
  childId:    z.string().uuid().optional(),
  activeOnly: z.coerce.boolean().default(false),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
});

export async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /sessions ─────────────────────────────────────────
  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const query = ListSessionsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: query.error.message },
        });
      }

      const { deviceId, childId, activeOnly, limit } = query.data;

      const sessions = await sql<{
        id: string;
        deviceId: string;
        deviceName: string;
        childId: string;
        childName: string;
        startedAt: Date;
        endsAt: Date;
        endedAt: Date | null;
        isActive: boolean;
        unlockMinutes: number;
        endReason: string | null;
        approvalId: string | null;
      }[]>`
        SELECT
          s.id,
          s.device_id,
          d.device_name,
          s.child_id,
          u.display_name AS child_name,
          s.started_at,
          s.ends_at,
          s.ended_at,
          s.is_active,
          s.unlock_minutes,
          s.end_reason,
          s.approval_id
        FROM sessions s
        JOIN devices d ON d.id = s.device_id
        JOIN users   u ON u.id = s.child_id
        WHERE s.family_id = ${user.familyId}
          ${deviceId  ? sql`AND s.device_id = ${deviceId}` : sql``}
          ${childId   ? sql`AND s.child_id  = ${childId}`  : sql``}
          ${activeOnly ? sql`AND s.is_active = TRUE AND s.ends_at > NOW()` : sql``}
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      `;

      // Enrich active sessions with remaining seconds from Redis
      const enriched = await Promise.all(sessions.map(async (s) => {
        let remainingSeconds: number | null = null;
        if (s.isActive && s.endsAt > new Date()) {
          remainingSeconds = await getRemainingTime(s.id);
        }
        return {
          id:              s.id,
          deviceId:        s.deviceId,
          deviceName:      s.deviceName,
          childId:         s.childId,
          childName:       s.childName,
          startedAt:       s.startedAt.toISOString(),
          endsAt:          s.endsAt.toISOString(),
          endedAt:         s.endedAt?.toISOString() ?? null,
          isActive:        s.isActive,
          remainingSeconds,
          unlockMinutes:   s.unlockMinutes,
          endReason:       s.endReason,
          approvalId:      s.approvalId,
        };
      }));

      return reply.send({ sessions: enriched });
    },
  );

  // ── GET /sessions/active/:deviceId ────────────────────────
  fastify.get(
    '/active/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      // Verify device belongs to this family
      const deviceRows = await sql<{ id: string }[]>`
        SELECT id FROM devices
        WHERE id = ${deviceId}
          AND family_id = ${user.familyId}
          ${user.role === 'child' ? sql`AND child_id = ${user.id}` : sql``}
        LIMIT 1
      `;

      if (!deviceRows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Device not found' },
        });
      }

      const session = await getActiveSession(deviceId);
      return reply.send({ session });
    },
  );

  // ── DELETE /sessions/:sessionId ───────────────────────────
  fastify.delete(
    '/:sessionId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      const { sessionId } = request.params;
      const { user } = request;

      // Verify session belongs to this family
      const rows = await sql<{ id: string; isActive: boolean }[]>`
        SELECT id, is_active
        FROM sessions
        WHERE id = ${sessionId}
          AND family_id = ${user.familyId}
        LIMIT 1
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Session not found' },
        });
      }

      if (!rows[0].isActive) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Session is not active' },
        });
      }

      await endSession(sessionId, 'parent_revoked');

      return reply.send({
        id:        sessionId,
        endedAt:   new Date().toISOString(),
        endReason: 'parent_revoked',
      });
    },
  );
}
