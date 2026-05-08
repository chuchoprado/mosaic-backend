# Mosaic Backend

Node.js + TypeScript + Fastify backend for the Mosaic parental control platform.

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Framework | Fastify 4 |
| Language | TypeScript 5 (strict) |
| Database | PostgreSQL 15 via Supabase |
| Cache / Timers | Redis (ioredis) |
| Auth | Supabase Auth + custom RS256 agent JWTs |
| Storage | Cloudflare R2 (S3-compatible) |
| Push notifications | Firebase Cloud Messaging |
| Deploy | Railway |

## Prerequisites

- Node.js >= 20
- A Supabase project (free tier works for development)
- Redis (local via Docker, or Railway plugin, or Upstash)
- Cloudflare R2 bucket (or any S3-compatible store)
- Firebase project with FCM enabled

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in all values in `.env`. See comments in the file for where to find each value.

### 3. Generate agent JWT keys

```bash
openssl genrsa -out agent_private.pem 2048
openssl rsa -in agent_private.pem -pubout -out agent_public.pem
```

Copy the contents into `AGENT_JWT_PRIVATE_KEY` and `AGENT_JWT_PUBLIC_KEY` in `.env`.
Use `\n` for newlines in the .env file (single-line string).

### 4. Initialize the database

Run the schema SQL against your Supabase project:

```bash
# Using psql directly
psql "$DATABASE_URL" -f src/db/schema.sql

# Or paste src/db/schema.sql into Supabase SQL Editor
```

### 5. Start development server

```bash
npm run dev
```

The server starts at `http://localhost:3000`.

Test the health endpoint:

```bash
curl http://localhost:3000/health
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled output (production) |
| `npm run typecheck` | Run tsc without emitting |
| `npm test` | Run test suite (vitest) |

## Project Structure

```
backend/
├── src/
│   ├── index.ts              # Entry point — Fastify setup, plugin registration
│   ├── api/                  # Route handlers
│   │   ├── auth.ts           # Register, login, refresh, logout
│   │   ├── family.ts         # Family profile & settings
│   │   ├── children.ts       # Child user CRUD
│   │   ├── devices.ts        # Device registration & management
│   │   ├── tasks.ts          # Task CRUD
│   │   ├── submissions.ts    # Task submissions + photo upload
│   │   ├── approvals.ts      # Parent approval/rejection
│   │   ├── sessions.ts       # Unlock session management
│   │   ├── rules.ts          # Per-device rules
│   │   ├── agent.ts          # macOS Lock Agent endpoints
│   │   └── notifications.ts  # FCM token management
│   ├── middleware/
│   │   └── auth.ts           # JWT auth middleware + agent token issuance
│   ├── services/
│   │   ├── ruleEngine.ts     # Device state evaluation logic
│   │   └── timerService.ts   # Redis-backed session timer management
│   ├── lib/
│   │   ├── redis.ts          # Redis client + session helpers
│   │   ├── supabase.ts       # Supabase admin client + postgres sql tag
│   │   ├── firebase.ts       # FCM push notification helpers
│   │   └── r2.ts             # Cloudflare R2 presigned URL helpers
│   └── db/
│       └── schema.sql        # Full PostgreSQL schema (idempotent)
├── .env.example              # Environment variable template
├── package.json
├── tsconfig.json
└── README.md
```

## Key Concepts

### Rule Engine

`src/services/ruleEngine.ts` evaluates device state on every agent poll.

Priority (highest wins):
1. Bedtime schedule — always locks
2. Lock schedule (school hours, etc.) — locks
3. Daily budget exhausted — locks
4. Active approved session — unlocks
5. Default — locked

Results are cached in Redis for 10 seconds to avoid DB load from 30s polls.

### Session Timers

`src/services/timerService.ts` uses Redis TTL keys. When a key expires:
- Redis fires a keyspace notification
- Backend catches the event via `redisSubscriber`
- Session is marked ended in PostgreSQL
- Device state cache is invalidated
- Agent picks up `state: "locked"` on next poll (within 30s)

### Agent Authentication

The macOS Lock Agent uses a long-lived RS256 JWT (30-day expiry) issued at device registration. This is separate from Supabase Auth tokens (HS256). The middleware auto-detects the algorithm from the token header.

### Offline Safety

If the agent loses network connectivity:
- It serves from its local encrypted state cache
- Active sessions expire based on the locally cached `sessionExpiresAt` timestamp
- After 5 minutes offline, the agent applies "fail-secure" (locks device)
- When connectivity is restored, it polls the backend and accepts server state as authoritative

## Deploy to Railway

### First deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and link to project
railway login
railway link

# Set environment variables
railway variables set NODE_ENV=production
railway variables set PORT=3000
# ... set all other variables from .env.example

# Deploy
railway up
```

### Add Redis

In Railway dashboard: New → Database → Redis. The `REDIS_URL` variable is automatically injected.

### Environment variables required in production

All variables from `.env.example` must be set. Critical ones:
- `DATABASE_URL` — Supabase connection string
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- `REDIS_URL`
- `AGENT_JWT_PRIVATE_KEY`, `AGENT_JWT_PUBLIC_KEY`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

## API Documentation

See `../docs/technical/API_SPEC.md` for the full endpoint reference.

## Architecture

See `../docs/technical/ARCHITECTURE.md` for system architecture, data flows, and design decisions.

## Database Schema

See `../docs/technical/DATABASE_SCHEMA.md` for the full schema with RLS policies and migrations.
