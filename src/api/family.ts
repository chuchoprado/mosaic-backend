import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';

const UpdateFamilySchema = z.object({
  name:                  z.string().min(1).max(100).optional(),
  defaultUnlockMinutes:  z.number().int().min(1).max(1440).optional(),
  timezone:              z.string().max(100).optional(),
});

export async function familyRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const families = await sql<{
        id: string;
        name: string;
        defaultUnlockMinutes: number;
        timezone: string;
        plan: string;
        createdAt: Date;
      }[]>`
        SELECT id, name, default_unlock_minutes, timezone, plan, created_at
        FROM families
        WHERE id = ${user.familyId}
        LIMIT 1
      `;

      const family = families[0];
      if (!family) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Family not found' },
        });
      }

      const members = await sql<{
        id: string;
        displayName: string;
        role: string;
        isPrimaryParent: boolean;
        avatarUrl: string | null;
        birthYear: number | null;
        isActive: boolean;
      }[]>`
        SELECT id, display_name, role, is_primary_parent, avatar_url, birth_year, is_active
        FROM users
        WHERE family_id = ${user.familyId}
        ORDER BY role DESC, display_name ASC
      `;

      return reply.send({
        id:                   family.id,
        name:                 family.name,
        defaultUnlockMinutes: family.defaultUnlockMinutes,
        timezone:             family.timezone,
        plan:                 family.plan,
        members:              members.map(m => ({
          id:              m.id,
          displayName:     m.displayName,
          role:            m.role,
          isPrimaryParent: m.isPrimaryParent,
          avatarUrl:       m.avatarUrl,
          birthYear:       m.birthYear,
          isActive:        m.isActive,
        })),
        createdAt: family.createdAt.toISOString(),
      });
    },
  );

  fastify.patch(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = UpdateFamilySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const d = body.data;
      const updates: Record<string, unknown> = {};
      if (d.name                 !== undefined) updates.name                   = d.name;
      if (d.defaultUnlockMinutes !== undefined) updates.default_unlock_minutes = d.defaultUnlockMinutes;
      if (d.timezone             !== undefined) updates.timezone               = d.timezone;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
        });
      }

      await sql`
        UPDATE families SET ${sql(updates)} WHERE id = ${user.familyId}
      `;

      return reply.send({ updated: true });
    },
  );
}
