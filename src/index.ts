import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { redisClient } from './lib/redis.js';
import { supabaseAdmin } from './lib/supabase.js';
import { initFirebase } from './lib/firebase.js';

// Route handlers
import { authRoutes } from './api/auth.js';
import { familyRoutes } from './api/family.js';
import { childrenRoutes } from './api/children.js';
import { devicesRoutes } from './api/devices.js';
import { tasksRoutes } from './api/tasks.js';
import { submissionsRoutes } from './api/submissions.js';
import { approvalsRoutes } from './api/approvals.js';
import { sessionsRoutes } from './api/sessions.js';
import { rulesRoutes } from './api/rules.js';
import { agentRoutes } from './api/agent.js';
import { notificationsRoutes } from './api/notifications.js';

import { authMiddleware } from './middleware/auth.js';
import { startRedisKeyspaceListener } from './services/timerService.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const LOG_PRETTY = process.env.LOG_PRETTY === 'true';

async function buildServer() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: LOG_PRETTY
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    trustProxy: true,
  });

  // ── Plugins ────────────────────────────────────────────────

  await server.register(cors, {
    origin: NODE_ENV === 'production'
      ? ['https://app.mosaic.app', 'https://www.mosaic.app']
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await server.register(rateLimit, {
    global: true,
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    keyGenerator: (request) => {
      const userId = (request as { userId?: string }).userId;
      return userId ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry after ${context.after}`,
      },
    }),
  });

  await server.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB max for evidence photos
      files: 1,
    },
  });

  // JWT plugin — validates both Supabase JWTs and our agent JWTs
  await server.register(jwt, {
    secret: process.env.SUPABASE_JWT_SECRET!,
    // We'll handle dual-secret validation in the auth middleware
    decode: { complete: true },
  });

  // ── Authentication decorator ────────────────────────────────
  await server.register(authMiddleware);

  // ── Health check ────────────────────────────────────────────
  server.get('/health', { logLevel: 'silent' }, async (_request, reply) => {
    const redisOk = await redisClient.ping().then(() => true).catch(() => false);

    return reply.send({
      status: 'ok',
      version: '1.0.0',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      services: { redis: redisOk ? 'up' : 'degraded' },
    });
  });

  // ── API Routes (all prefixed with /v1) ──────────────────────
  const API_PREFIX = '/v1';

  await server.register(authRoutes,          { prefix: `${API_PREFIX}/auth` });
  await server.register(familyRoutes,        { prefix: `${API_PREFIX}/family` });
  await server.register(childrenRoutes,      { prefix: `${API_PREFIX}/children` });
  await server.register(devicesRoutes,       { prefix: `${API_PREFIX}/devices` });
  await server.register(tasksRoutes,         { prefix: `${API_PREFIX}/tasks` });
  await server.register(submissionsRoutes,   { prefix: `${API_PREFIX}/submissions` });
  await server.register(approvalsRoutes,     { prefix: `${API_PREFIX}/approvals` });
  await server.register(sessionsRoutes,      { prefix: `${API_PREFIX}/sessions` });
  await server.register(rulesRoutes,         { prefix: `${API_PREFIX}/rules` });
  await server.register(agentRoutes,         { prefix: `${API_PREFIX}/agent` });
  await server.register(notificationsRoutes, { prefix: `${API_PREFIX}/notifications` });

  // ── Global error handler ────────────────────────────────────
  server.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled error');

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: error.message },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: error.validation,
        },
      });
    }

    const statusCode = error.statusCode ?? 500;
    const code = statusCode === 500 ? 'INTERNAL_ERROR' : error.message;

    return reply.status(statusCode).send({
      error: {
        code,
        message: NODE_ENV === 'production' && statusCode === 500
          ? 'An unexpected error occurred'
          : error.message,
        requestId: reply.request.id,
      },
    });
  });

  // ── 404 handler ─────────────────────────────────────────────
  server.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
  });

  return server;
}

async function main() {
  // Initialize external services
  initFirebase();

  // Start Redis keyspace listener — non-fatal if Redis unavailable
  await startRedisKeyspaceListener().catch((err) => {
    console.warn('[Redis] Keyspace listener unavailable:', err.message);
  });

  const server = await buildServer();

  // ── Graceful shutdown ────────────────────────────────────────
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await server.close();
      await redisClient.quit();
      server.log.info('Graceful shutdown complete.');
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Mosaic backend listening on ${HOST}:${PORT}`);
  } catch (err) {
    server.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main();
