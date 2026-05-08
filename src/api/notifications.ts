import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { sendPushNotification } from '../lib/firebase.js';

const RegisterTokenSchema = z.object({
  token:             z.string().min(1).max(1000),
  platform:          z.enum(['ios', 'android', 'web']),
  deviceFingerprint: z.string().max(200).optional(),
});

export async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.post(
    '/tokens',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = RegisterTokenSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } });
      }

      const { token, platform, deviceFingerprint } = body.data;

      const rows = await sql<{ id: string; createdAt: Date }[]>`
        INSERT INTO notification_tokens (user_id, family_id, token, platform, device_fingerprint)
        VALUES (${user.id}, ${user.familyId}, ${token}, ${platform}, ${deviceFingerprint ?? null})
        ON CONFLICT (user_id, device_fingerprint)
        DO UPDATE SET
          token      = EXCLUDED.token,
          platform   = EXCLUDED.platform,
          is_active  = TRUE,
          last_used_at = NOW()
        RETURNING id, created_at
      `;

      return reply.status(201).send({
        id:           rows[0]!.id,
        token,
        platform,
        isActive:     true,
        registeredAt: rows[0]!.createdAt.toISOString(),
      });
    },
  );

  fastify.delete(
    '/tokens/:tokenId',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply) => {
      const { tokenId } = request.params;
      const { user } = request;

      await sql`
        UPDATE notification_tokens
        SET is_active = FALSE
        WHERE id = ${tokenId} AND user_id = ${user.id}
      `;

      return reply.status(204).send();
    },
  );

  fastify.post(
    '/test',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const rows = await sql<{ token: string }[]>`
        SELECT token FROM notification_tokens
        WHERE user_id = ${user.id} AND is_active = TRUE
      `;

      if (rows.length === 0) {
        return reply.send({ sent: 0, failed: 0 });
      }

      const tokens = rows.map(r => r.token);
      const result = await sendPushNotification(tokens, {
        title: 'Mosaic Test Notification',
        body:  'Push notifications are working correctly.',
        data:  { type: 'test' },
      });

      return reply.send(result);
    },
  );
}
