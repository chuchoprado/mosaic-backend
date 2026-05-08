/**
 * Auth Router
 *
 * POST /auth/register    — create family + primary parent
 * POST /auth/login       — email/password login
 * POST /auth/refresh     — refresh access token
 * POST /auth/logout      — invalidate session
 * POST /auth/child-pin   — child PIN login
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin, sql } from '../lib/supabase.js';

const RegisterSchema = z.object({
  email:       z.string().email(),
  password:    z.string().min(8),
  displayName: z.string().min(1).max(100),
  familyName:  z.string().min(1).max(100),
  timezone:    z.string().max(100).default('UTC'),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
});

const RefreshSchema = z.object({
  refreshToken: z.string(),
});

const ChildPinSchema = z.object({
  familyCode: z.string().regex(/^MOSAIC-[A-Z0-9]{4}$/),
  pin:        z.string().regex(/^\d{4,6}$/),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /auth/register ───────────────────────────────────
  fastify.post(
    '/register',
    async (request: FastifyRequest, reply) => {
      const body = RegisterSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { email, password, displayName, familyName, timezone } = body.data;

      // 1. Create auth user in Supabase
      const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,  // skip email confirmation for MVP
          app_metadata:  { role: 'parent' },
        });

      if (authError || !authData.user) {
        if (authError?.message?.includes('already registered')) {
          return reply.status(409).send({
            error: { code: 'CONFLICT', message: 'Email already registered' },
          });
        }
        return reply.status(400).send({
          error: { code: 'REGISTRATION_FAILED', message: authError?.message ?? 'Unknown error' },
        });
      }

      const userId = authData.user.id;

      // 2. Create family + user profile in one transaction
      try {
        const result = await sql.begin(async (tx) => {
          const familyRows = await tx<{ id: string }[]>`
            INSERT INTO families (name, timezone)
            VALUES (${familyName}, ${timezone})
            RETURNING id
          `;
          const familyId = familyRows[0]!.id;

          // Update Supabase auth metadata with family_id
          await supabaseAdmin.auth.admin.updateUserById(userId, {
            app_metadata: { role: 'parent', family_id: familyId },
          });

          await tx`
            INSERT INTO users (id, family_id, role, display_name, is_primary_parent)
            VALUES (${userId}, ${familyId}, 'parent', ${displayName}, TRUE)
          `;

          return { familyId, familyName };
        });

        // 3. Sign in to get tokens
        const { data: signInData, error: signInError } =
          await supabaseAdmin.auth.signInWithPassword({ email, password });

        if (signInError || !signInData.session) {
          return reply.status(500).send({
            error: { code: 'INTERNAL_ERROR', message: 'Registration succeeded but login failed' },
          });
        }

        return reply.status(201).send({
          user: {
            id:          userId,
            email,
            displayName,
            role:        'parent',
            familyId:    result.familyId,
          },
          family: {
            id:   result.familyId,
            name: result.familyName,
          },
          session: {
            accessToken:  signInData.session.access_token,
            refreshToken: signInData.session.refresh_token,
            expiresAt:    signInData.session.expires_at,
          },
        });
      } catch (err) {
        // Rollback: delete auth user
        await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
        throw err;
      }
    },
  );

  // ── POST /auth/login ──────────────────────────────────────
  fastify.post(
    '/login',
    async (request: FastifyRequest, reply) => {
      const body = LoginSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { email, password } = body.data;

      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.session) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
        });
      }

      const userId  = data.user.id;
      const appMeta = data.user.app_metadata as { role?: string; family_id?: string };

      return reply.send({
        user: {
          id:       userId,
          email:    data.user.email,
          role:     appMeta.role ?? 'parent',
          familyId: appMeta.family_id,
        },
        session: {
          accessToken:  data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt:    data.session.expires_at,
        },
      });
    },
  );

  // ── POST /auth/refresh ────────────────────────────────────
  fastify.post(
    '/refresh',
    async (request: FastifyRequest, reply) => {
      const body = RefreshSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { data, error } = await supabaseAdmin.auth.refreshSession({
        refresh_token: body.data.refreshToken,
      });

      if (error || !data.session) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Refresh token expired or invalid' },
        });
      }

      return reply.send({
        accessToken:  data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt:    data.session.expires_at,
      });
    },
  );

  // ── POST /auth/logout ─────────────────────────────────────
  fastify.post(
    '/logout',
    { preHandler: [fastify.authenticate] },
    async (_request, reply) => {
      // Token is stateless JWT — Supabase handles invalidation server-side.
      // Client should discard tokens.
      return reply.status(204).send();
    },
  );

  // ── POST /auth/child-pin ──────────────────────────────────
  fastify.post(
    '/child-pin',
    async (request: FastifyRequest, reply) => {
      const body = ChildPinSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      // In a full implementation, family_code and hashed PIN would be stored.
      // For MVP, this is a placeholder that returns 501.
      return reply.status(501).send({
        error: { code: 'NOT_IMPLEMENTED', message: 'Child PIN auth coming soon' },
      });
    },
  );
}
