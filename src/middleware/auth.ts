import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';

export type UserRole = 'parent' | 'child' | 'agent';

export interface AuthenticatedUser {
  id: string;
  familyId: string;
  role: UserRole;
  email?: string;
  // Agent-specific
  deviceId?: string;
}

// Extend Fastify request type to include user
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;
const AGENT_JWT_PUBLIC_KEY = process.env.AGENT_JWT_PUBLIC_KEY!;

/**
 * Decode and validate a JWT from the Authorization header.
 * Supports two token types:
 *   1. Supabase Auth tokens (HS256, for parent/child users)
 *   2. Agent tokens (RS256, issued by our API for the macOS daemon)
 */
function verifyToken(token: string): AuthenticatedUser {
  // Peek at the header to determine algorithm without verifying
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new Error('Malformed token');
  }

  const algorithm = decoded.header.alg;

  if (algorithm === 'RS256') {
    // Agent token — verify with our RS256 public key
    if (!AGENT_JWT_PUBLIC_KEY) {
      throw new Error('Agent JWT public key not configured');
    }

    const payload = jwt.verify(token, AGENT_JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
    }) as jwt.JwtPayload;

    if (!payload.sub || !payload.family_id || !payload.device_id) {
      throw new Error('Agent token missing required claims');
    }

    return {
      id:       payload.sub,
      familyId: payload.family_id as string,
      role:     'agent',
      deviceId: payload.device_id as string,
    };
  }

  if (algorithm === 'HS256') {
    // Supabase Auth token — verify with shared JWT secret
    if (!SUPABASE_JWT_SECRET) {
      throw new Error('Supabase JWT secret not configured');
    }

    const payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;

    if (!payload.sub) {
      throw new Error('Token missing sub claim');
    }

    // Supabase stores custom claims in `app_metadata` or at root level
    const role = (payload.role ?? payload.app_metadata?.role) as UserRole | undefined;
    const familyId = (payload.family_id ?? payload.app_metadata?.family_id) as string | undefined;

    if (!role || !familyId) {
      throw new Error('Token missing role or family_id claims');
    }

    return {
      id:      payload.sub,
      familyId,
      role,
      email:   payload.email as string | undefined,
    };
  }

  throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
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
        request.user = verifyToken(token);
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

  const expiry = process.env.AGENT_JWT_EXPIRY ?? '30d';
  const token = jwt.sign(
    {
      family_id: params.familyId,
      device_id: params.deviceId,
      role:      'agent',
    },
    AGENT_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256',
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
