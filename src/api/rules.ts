/**
 * Rules Router
 *
 * GET /rules/:deviceId — get device rules
 * PUT /rules/:deviceId — update device rules
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { invalidateDeviceStateCache } from '../services/ruleEngine.js';

const LockScheduleEntrySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime:   z.string().regex(/^\d{2}:\d{2}$/),
  label:     z.string().max(100).optional(),
});

const UpdateRulesSchema = z.object({
  emergencyApps:     z.array(z.string().max(200)).max(50).optional(),
  allowedDomains:    z.array(z.string().max(253)).max(100).optional(),
  lockSchedule:      z.array(LockScheduleEntrySchema).max(50).optional(),
  bedtimeStart:      z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  bedtimeEnd:        z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  maxSessionMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  dailyBudgetMinutes:z.number().int().min(1).max(1440).nullable().optional(),
});

export async function rulesRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /rules/:deviceId ──────────────────────────────────
  fastify.get(
    '/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      const rows = await sql<{
        emergencyApps: string[];
        allowedDomains: string[];
        lockSchedule: unknown;
        bedtimeStart: string | null;
        bedtimeEnd: string | null;
        maxSessionMinutes: number | null;
        dailyBudgetMinutes: number | null;
        updatedAt: Date;
      }[]>`
        SELECT
          r.emergency_apps,
          r.allowed_domains,
          r.lock_schedule,
          r.bedtime_start,
          r.bedtime_end,
          r.max_session_minutes,
          r.daily_budget_minutes,
          r.updated_at
        FROM rules r
        JOIN devices d ON d.id = r.device_id
        WHERE r.device_id = ${deviceId}
          AND d.family_id = ${user.familyId}
        LIMIT 1
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Device or rules not found' },
        });
      }

      const r = rows[0];
      return reply.send({
        deviceId,
        emergencyApps:      r.emergencyApps,
        allowedDomains:     r.allowedDomains,
        lockSchedule:       r.lockSchedule,
        bedtimeStart:       r.bedtimeStart,
        bedtimeEnd:         r.bedtimeEnd,
        maxSessionMinutes:  r.maxSessionMinutes,
        dailyBudgetMinutes: r.dailyBudgetMinutes,
        updatedAt:          r.updatedAt.toISOString(),
      });
    },
  );

  // ── PUT /rules/:deviceId ──────────────────────────────────
  fastify.put(
    '/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      const body = UpdateRulesSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      // Verify device belongs to this family
      const deviceRows = await sql<{ id: string }[]>`
        SELECT id FROM devices
        WHERE id = ${deviceId} AND family_id = ${user.familyId}
        LIMIT 1
      `;

      if (!deviceRows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Device not found' },
        });
      }

      const d = body.data;
      const updates: Record<string, unknown> = { updated_by: user.id };

      if (d.emergencyApps     !== undefined) updates.emergency_apps      = JSON.stringify(d.emergencyApps);
      if (d.allowedDomains    !== undefined) updates.allowed_domains     = JSON.stringify(d.allowedDomains);
      if (d.lockSchedule      !== undefined) updates.lock_schedule       = JSON.stringify(d.lockSchedule);
      if (d.bedtimeStart      !== undefined) updates.bedtime_start       = d.bedtimeStart;
      if (d.bedtimeEnd        !== undefined) updates.bedtime_end         = d.bedtimeEnd;
      if (d.maxSessionMinutes !== undefined) updates.max_session_minutes = d.maxSessionMinutes;
      if (d.dailyBudgetMinutes!== undefined) updates.daily_budget_minutes= d.dailyBudgetMinutes;

      await sql`
        UPDATE rules
        SET ${sql(updates)}
        WHERE device_id = ${deviceId}
      `;

      // Invalidate cache so agent picks up changes on next poll
      await invalidateDeviceStateCache(deviceId);

      return reply.send({ deviceId, updated: true });
    },
  );
}
