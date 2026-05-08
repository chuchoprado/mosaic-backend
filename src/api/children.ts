import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { supabaseAdmin } from '../lib/supabase.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const CreateChildSchema = z.object({
  displayName: z.string().min(1).max(100),
  birthYear:   z.number().int().min(1990).max(new Date().getFullYear()),
  pin:         z.string().regex(/^\d{4,6}$/).optional(),
});

const UpdateChildSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  birthYear:   z.number().int().optional(),
  isActive:    z.boolean().optional(),
});

export async function childrenRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const children = await sql<{
        id: string;
        displayName: string;
        birthYear: number;
        avatarUrl: string | null;
        isActive: boolean;
        createdAt: Date;
      }[]>`
        SELECT id, display_name, birth_year, avatar_url, is_active, created_at
        FROM users
        WHERE family_id = ${user.familyId}
          AND role = 'child'
        ORDER BY display_name ASC
      `;

      // Enrich with device info
      const enriched = await Promise.all(children.map(async (child) => {
        const devices = await sql<{
          id: string;
          deviceName: string;
          currentState: string;
          lastHeartbeatAt: Date | null;
        }[]>`
          SELECT id, device_name, current_state, last_heartbeat_at
          FROM devices
          WHERE child_id = ${child.id} AND is_active = TRUE
        `;

        const pendingCount = await sql<{ count: number }[]>`
          SELECT COUNT(*)::INTEGER AS count
          FROM task_submissions
          WHERE child_id = ${child.id} AND status = 'pending'
        `;

        return {
          id:          child.id,
          displayName: child.displayName,
          birthYear:   child.birthYear,
          avatarUrl:   child.avatarUrl,
          isActive:    child.isActive,
          devices:     devices.map(d => ({
            id:              d.id,
            deviceName:      d.deviceName,
            currentState:    d.currentState,
            lastHeartbeatAt: d.lastHeartbeatAt?.toISOString() ?? null,
          })),
          pendingSubmissions: pendingCount[0]?.count ?? 0,
          createdAt: child.createdAt.toISOString(),
        };
      }));

      return reply.send({ children: enriched });
    },
  );

  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = CreateChildSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { displayName, birthYear, pin } = body.data;

      // Generate a unique family code and dummy email for the child auth account
      const familyCode = `MOSAIC-${randomBytes(2).toString('hex').toUpperCase()}`;
      const childEmail = `child-${randomBytes(8).toString('hex')}@internal.mosaic.app`;
      const childPassword = randomBytes(16).toString('hex');  // random, child uses PIN

      const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.createUser({
          email:         childEmail,
          password:      childPassword,
          email_confirm: true,
          app_metadata:  {
            role:      'child',
            family_id: user.familyId,
            pin_hash:  pin ? await bcrypt.hash(pin, 10) : null,
            family_code: familyCode,
          },
        });

      if (authError || !authData.user) {
        throw new Error(authError?.message ?? 'Failed to create child auth account');
      }

      const childId = authData.user.id;

      await sql`
        INSERT INTO users (id, family_id, role, display_name, birth_year)
        VALUES (${childId}, ${user.familyId}, 'child', ${displayName}, ${birthYear})
      `;

      return reply.status(201).send({
        id:          childId,
        displayName,
        birthYear,
        familyCode,
        isActive:    true,
        createdAt:   new Date().toISOString(),
      });
    },
  );

  fastify.get(
    '/:childId',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { childId: string } }>, reply) => {
      const { childId } = request.params;
      const { user } = request;

      const effectiveChildId = user.role === 'child' ? user.id : childId;

      const rows = await sql<{
        id: string;
        displayName: string;
        birthYear: number;
        avatarUrl: string | null;
        isActive: boolean;
        createdAt: Date;
      }[]>`
        SELECT id, display_name, birth_year, avatar_url, is_active, created_at
        FROM users
        WHERE id = ${effectiveChildId}
          AND family_id = ${user.familyId}
          AND role = 'child'
        LIMIT 1
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Child not found' },
        });
      }

      const c = rows[0];
      return reply.send({
        id:          c.id,
        displayName: c.displayName,
        birthYear:   c.birthYear,
        avatarUrl:   c.avatarUrl,
        isActive:    c.isActive,
        createdAt:   c.createdAt.toISOString(),
      });
    },
  );

  fastify.patch(
    '/:childId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { childId: string } }>, reply) => {
      const { childId } = request.params;
      const { user } = request;

      const body = UpdateChildSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const d = body.data;
      const updates: Record<string, unknown> = {};
      if (d.displayName !== undefined) updates.display_name = d.displayName;
      if (d.birthYear   !== undefined) updates.birth_year   = d.birthYear;
      if (d.isActive    !== undefined) updates.is_active     = d.isActive;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
        });
      }

      const rows = await sql<{ id: string }[]>`
        UPDATE users
        SET ${sql(updates)}
        WHERE id = ${childId}
          AND family_id = ${user.familyId}
          AND role = 'child'
        RETURNING id
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Child not found' },
        });
      }

      return reply.send({ id: childId, updated: true });
    },
  );

  fastify.delete(
    '/:childId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { childId: string } }>, reply) => {
      const { childId } = request.params;
      const { user } = request;

      const rows = await sql<{ id: string }[]>`
        UPDATE users
        SET is_active = FALSE
        WHERE id = ${childId}
          AND family_id = ${user.familyId}
          AND role = 'child'
        RETURNING id
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Child not found' },
        });
      }

      return reply.status(204).send();
    },
  );
}
