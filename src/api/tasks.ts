/**
 * Tasks Router
 *
 * Handles full CRUD for tasks:
 *   GET    /tasks          — list tasks (parent: all family; child: own tasks)
 *   POST   /tasks          — create task (parent only)
 *   GET    /tasks/:taskId  — get single task
 *   PATCH  /tasks/:taskId  — update task (parent only)
 *   DELETE /tasks/:taskId  — archive task (parent only)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { invalidateDeviceStateCache } from '../services/ruleEngine.js';

// ── Validation schemas ────────────────────────────────────────────────────────

const CreateTaskSchema = z.object({
  childId:         z.string().uuid(),
  title:           z.string().min(1).max(200),
  description:     z.string().max(2000).optional(),
  dueDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  dueTime:         z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  unlockMinutes:   z.number().int().min(1).max(1440),
  requiresPhoto:   z.boolean().default(false),
  recurrenceRule:  z.string().max(500).optional().nullable(),
  icon:            z.string().max(100).default('checkmark.circle'),
  color:           z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366F1'),
  sortOrder:       z.number().int().default(0),
});

const UpdateTaskSchema = z.object({
  title:         z.string().min(1).max(200).optional(),
  description:   z.string().max(2000).optional().nullable(),
  dueDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  dueTime:       z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  unlockMinutes: z.number().int().min(1).max(1440).optional(),
  requiresPhoto: z.boolean().optional(),
  recurrenceRule:z.string().max(500).optional().nullable(),
  icon:          z.string().max(100).optional(),
  color:         z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  status:        z.enum(['active', 'paused', 'archived']).optional(),
  sortOrder:     z.number().int().optional(),
});

const ListTasksQuerySchema = z.object({
  childId: z.string().uuid().optional(),
  status:  z.enum(['active', 'completed', 'archived', 'paused']).default('active'),
  limit:   z.coerce.number().int().min(1).max(100).default(50),
  cursor:  z.string().optional(),
});

// ── Route handler ─────────────────────────────────────────────────────────────

export async function tasksRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /tasks ────────────────────────────────────────────
  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest, reply) => {
      const query = ListTasksQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: query.error.message },
        });
      }

      const { childId, status, limit, cursor } = query.data;
      const { user } = request;

      // Children can only see their own tasks
      const effectiveChildId = user.role === 'child' ? user.id : childId;

      // Cursor decoding
      let cursorId: string | null = null;
      let cursorCreatedAt: string | null = null;
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
            id: string;
            createdAt: string;
          };
          cursorId = decoded.id;
          cursorCreatedAt = decoded.createdAt;
        } catch {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'Invalid cursor' },
          });
        }
      }

      const tasks = await sql<{
        id: string;
        childId: string;
        childName: string;
        title: string;
        description: string | null;
        dueDate: string | null;
        dueTime: string | null;
        unlockMinutes: number;
        requiresPhoto: boolean;
        recurrenceRule: string | null;
        status: string;
        icon: string;
        color: string;
        sortOrder: number;
        createdAt: Date;
        pendingSubmissionId: string | null;
      }[]>`
        SELECT
          t.id,
          t.child_id,
          u.display_name AS child_name,
          t.title,
          t.description,
          t.due_date,
          t.due_time,
          t.unlock_minutes,
          t.requires_photo,
          t.recurrence_rule,
          t.status,
          t.icon,
          t.color,
          t.sort_order,
          t.created_at,
          (
            SELECT ts.id FROM task_submissions ts
            WHERE ts.task_id = t.id AND ts.status = 'pending'
            LIMIT 1
          ) AS pending_submission_id
        FROM tasks t
        JOIN users u ON u.id = t.child_id
        WHERE
          t.family_id = ${user.familyId}
          AND t.status = ${status}
          ${effectiveChildId ? sql`AND t.child_id = ${effectiveChildId}` : sql``}
          ${cursorId && cursorCreatedAt
            ? sql`AND (t.created_at, t.id) < (${cursorCreatedAt}::TIMESTAMPTZ, ${cursorId}::UUID)`
            : sql``
          }
        ORDER BY t.sort_order ASC, t.created_at DESC
        LIMIT ${limit + 1}
      `;

      const hasMore = tasks.length > limit;
      const items   = hasMore ? tasks.slice(0, limit) : tasks;

      const nextCursor = hasMore && items.length > 0
        ? Buffer.from(JSON.stringify({
            id:        items[items.length - 1]!.id,
            createdAt: items[items.length - 1]!.createdAt.toISOString(),
          })).toString('base64')
        : null;

      return reply.send({
        tasks: items.map(t => ({
          id:              t.id,
          childId:         t.childId,
          childName:       t.childName,
          title:           t.title,
          description:     t.description,
          dueDate:         t.dueDate,
          dueTime:         t.dueTime,
          unlockMinutes:   t.unlockMinutes,
          requiresPhoto:   t.requiresPhoto,
          recurrenceRule:  t.recurrenceRule,
          status:          t.status,
          icon:            t.icon,
          color:           t.color,
          sortOrder:       t.sortOrder,
          pendingSubmission: t.pendingSubmissionId
            ? { id: t.pendingSubmissionId }
            : null,
          createdAt: t.createdAt.toISOString(),
        })),
        nextCursor,
        hasMore,
      });
    },
  );

  // ── POST /tasks ───────────────────────────────────────────
  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const body = CreateTaskSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { user } = request;
      const d = body.data;

      // Verify child belongs to this family
      const childRows = await sql<{ id: string }[]>`
        SELECT id FROM users
        WHERE id = ${d.childId}
          AND family_id = ${user.familyId}
          AND role = 'child'
          AND is_active = TRUE
        LIMIT 1
      `;

      if (!childRows[0]) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Child not found in your family' },
        });
      }

      const rows = await sql<{ id: string; createdAt: Date }[]>`
        INSERT INTO tasks (
          family_id, child_id, created_by,
          title, description,
          due_date, due_time,
          unlock_minutes, requires_photo,
          recurrence_rule, icon, color, sort_order
        )
        VALUES (
          ${user.familyId}, ${d.childId}, ${user.id},
          ${d.title}, ${d.description ?? null},
          ${d.dueDate ?? null}, ${d.dueTime ?? null},
          ${d.unlockMinutes}, ${d.requiresPhoto},
          ${d.recurrenceRule ?? null}, ${d.icon}, ${d.color}, ${d.sortOrder}
        )
        RETURNING id, created_at
      `;

      const task = rows[0]!;

      // Invalidate device state caches for this child's devices
      await invalidateCachesForChild(d.childId);

      return reply.status(201).send({
        id:             task.id,
        childId:        d.childId,
        title:          d.title,
        description:    d.description ?? null,
        dueDate:        d.dueDate ?? null,
        dueTime:        d.dueTime ?? null,
        unlockMinutes:  d.unlockMinutes,
        requiresPhoto:  d.requiresPhoto,
        recurrenceRule: d.recurrenceRule ?? null,
        status:         'active',
        icon:           d.icon,
        color:          d.color,
        createdAt:      task.createdAt.toISOString(),
      });
    },
  );

  // ── GET /tasks/:taskId ────────────────────────────────────
  fastify.get(
    '/:taskId',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
      const { taskId } = request.params;
      const { user } = request;

      const rows = await sql<{
        id: string;
        childId: string;
        childName: string;
        createdBy: string;
        title: string;
        description: string | null;
        dueDate: string | null;
        dueTime: string | null;
        unlockMinutes: number;
        requiresPhoto: boolean;
        recurrenceRule: string | null;
        status: string;
        icon: string;
        color: string;
        createdAt: Date;
        updatedAt: Date;
      }[]>`
        SELECT
          t.id, t.child_id, u.display_name AS child_name, t.created_by,
          t.title, t.description, t.due_date, t.due_time,
          t.unlock_minutes, t.requires_photo, t.recurrence_rule,
          t.status, t.icon, t.color, t.created_at, t.updated_at
        FROM tasks t
        JOIN users u ON u.id = t.child_id
        WHERE t.id = ${taskId}
          AND t.family_id = ${user.familyId}
          ${user.role === 'child' ? sql`AND t.child_id = ${user.id}` : sql``}
        LIMIT 1
      `;

      const task = rows[0];
      if (!task) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Task not found' },
        });
      }

      return reply.send({
        id:             task.id,
        childId:        task.childId,
        childName:      task.childName,
        title:          task.title,
        description:    task.description,
        dueDate:        task.dueDate,
        dueTime:        task.dueTime,
        unlockMinutes:  task.unlockMinutes,
        requiresPhoto:  task.requiresPhoto,
        recurrenceRule: task.recurrenceRule,
        status:         task.status,
        icon:           task.icon,
        color:          task.color,
        createdAt:      task.createdAt.toISOString(),
        updatedAt:      task.updatedAt.toISOString(),
      });
    },
  );

  // ── PATCH /tasks/:taskId ──────────────────────────────────
  fastify.patch(
    '/:taskId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
      const { taskId } = request.params;
      const { user } = request;

      const body = UpdateTaskSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const d = body.data;

      // Build dynamic SET clause — only update provided fields
      const updates: Record<string, unknown> = {};
      if (d.title           !== undefined) updates.title            = d.title;
      if (d.description     !== undefined) updates.description      = d.description;
      if (d.dueDate         !== undefined) updates.due_date         = d.dueDate;
      if (d.dueTime         !== undefined) updates.due_time         = d.dueTime;
      if (d.unlockMinutes   !== undefined) updates.unlock_minutes   = d.unlockMinutes;
      if (d.requiresPhoto   !== undefined) updates.requires_photo   = d.requiresPhoto;
      if (d.recurrenceRule  !== undefined) updates.recurrence_rule  = d.recurrenceRule;
      if (d.icon            !== undefined) updates.icon             = d.icon;
      if (d.color           !== undefined) updates.color            = d.color;
      if (d.status          !== undefined) updates.status           = d.status;
      if (d.sortOrder       !== undefined) updates.sort_order       = d.sortOrder;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
        });
      }

      const rows = await sql<{ id: string; childId: string }[]>`
        UPDATE tasks
        SET ${sql(updates)}, updated_at = NOW()
        WHERE id = ${taskId}
          AND family_id = ${user.familyId}
        RETURNING id, child_id
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Task not found' },
        });
      }

      await invalidateCachesForChild(rows[0].childId);

      return reply.send({ id: rows[0].id, updated: true });
    },
  );

  // ── DELETE /tasks/:taskId ─────────────────────────────────
  fastify.delete(
    '/:taskId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
      const { taskId } = request.params;
      const { user } = request;

      const rows = await sql<{ childId: string }[]>`
        UPDATE tasks
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE id = ${taskId}
          AND family_id = ${user.familyId}
          AND status != 'archived'
        RETURNING child_id
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Task not found' },
        });
      }

      await invalidateCachesForChild(rows[0].childId);

      return reply.status(204).send();
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Invalidate device state caches for all devices belonging to a child.
 */
async function invalidateCachesForChild(childId: string): Promise<void> {
  const devices = await sql<{ id: string }[]>`
    SELECT id FROM devices WHERE child_id = ${childId} AND is_active = TRUE
  `;
  await Promise.all(devices.map(d => invalidateDeviceStateCache(d.id)));
}
