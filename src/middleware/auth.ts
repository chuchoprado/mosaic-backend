import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase.js';

export type UserRole = 'parent' | 'child' | 'agent';

export interface AuthenticatedUser {
  id: string;
  familyId: string;
  role: UserRole;
  email?: string;
  deviceId?: string;
}

// Override @fastify/jwt's generic user type with our own
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthenticatedUser;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

const AGENT_JWT_PUBLIC_KEY = process.env.AGENT_JWT_PUBLIC_KEY!;

/**
 * Verify a Supabase Auth token using the admin SDK — handles HS256 and ES256.
 * Returns the authenticated user or throws on invalid token.
 */
async function verifySupabaseToken(token: string): Promise<AuthenticatedUser> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    throw new Error(error?.message ?? 'Invalid Supabase token');
  }

  const user = data.user;
  const meta = user.app_metadata ?? {};

  const role = meta.role as UserRole | undefined;
  const familyId = meta.family_id as string | undefined;

  if (!role || !familyId) {
    throw new Error('Token missing role or family_id claims');
  }

  return {
    id:      user.id,
    familyId,
    role,
    email:   user.email,
  };
}

/**
 * Decode and validate a JWT from the Authorization header.
 * Supports two token types:
 *   1. Supabase Auth tokens (any alg — validated via Supabase Admin SDK)
 *   2. Agent tokens (RS256, issued by our API for the macOS daemon)
 */
async function verifyToken(token: string): Promise<AuthenticatedUser> {
  // Peek at the header to determine algorithm without verifying
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new Error('Malformed token');
  }

  const algorithm = decoded.header.alg;

  if (algorithm === 'RS256' && AGENT_JWT_PUBLIC_KEY) {
    // Try as agent token first — verify with our RS256 public key
    try {
      const payload = jwt.verify(token, AGENT_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
      }) as jwt.JwtPayload;

      if (payload.sub && payload.family_id && payload.device_id) {
        return {
          id:       payload.sub,
          familyId: payload.family_id as string,
          role:     'agent',
          deviceId: payload.device_id as string,
        };
      }
    } catch {
      // Not a valid agent token — fall through to Supabase verification
    }
  }

  // All other tokens: verify via Supabase Admin SDK (supports HS256 + ES256)
  return verifySupabaseToken(token);
}

// ── Fastify hooks ──────────────────────────────────────────────────────────────

/**
 * authMiddleware plugin — registers decorators and preHandler factories.
 */
async function authMiddlewarePlugin(fastify: FastifyInstance): Promise<void> {
  // Decorator: extract and verify JWT, attach user to request
  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' },
        });
      }

      const token = authHeader.slice(7);
      try {
        request.user = await verifyToken(token);
      } catch (err) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: err instanceof Error ? err.message : 'Invalid token',
          },
        });
      }
    },
  );

  // Decorator: require parent role
  fastify.decorate(
    'requireParent',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      if (request.user.role !== 'parent') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Parent role required' },
        });
      }
    },
  );

  // Decorator: require child role
  fastify.decorate(
    'requireChild',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      if (request.user.role !== 'child') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Child role required' },
        });
      }
    },
  );

  // Decorator: require agent role
  fastify.decorate(
    'requireAgent',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      if (request.user.role !== 'agent') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Agent role required' },
        });
      }
    },
  );

  // Decorator: require parent or child (any user)
  fastify.decorate(
    'requireUser',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      if (request.user.role === 'agent') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'User role required' },
        });
      }
    },
  );
}

export const authMiddleware = fp(authMiddlewarePlugin, {
  name: 'auth-middleware',
});

// ── Type augmentation for decorators ──────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    authenticate:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireParent: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireChild:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAgent:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireUser:   (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ── Agent token issuance ──────────────────────────────────────────────────────

/**
 * Issue a long-lived RS256 JWT for the macOS Lock Agent.
 * Called once at device registration.
 */
export function issueAgentToken(params: {
  deviceId: string;
  familyId: string;
  agentUserId: string;
}): { token: string; expiresAt: Date } {
  const AGENT_JWT_PRIVATE_KEY = process.env.AGENT_JWT_PRIVATE_KEY!;
  if (!AGENT_JWT_PRIVATE_KEY) {
    throw new Error('AGENT_JWT_PRIVATE_KEY not configured');
  }

  const expiry = (process.env.AGENT_JWT_EXPIRY ?? '30d') as jwt.SignOptions['expiresIn'];
  const token = jwt.sign(
    {
      family_id: params.familyId,
      device_id: params.deviceId,
      role:      'agent',
    },
    AGENT_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256' as jwt.Algorithm,
      subject:   params.agentUserId,
      expiresIn: expiry,
      issuer:    'mosaic-backend',
    },
  );

  // Parse expiry for the response
  const decoded = jwt.decode(token) as jwt.JwtPayload;
  const expiresAt = new Date((decoded.exp ?? 0) * 1000);

  return { token, expiresAt };
}
