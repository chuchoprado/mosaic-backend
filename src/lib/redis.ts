import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? 'mosaic:';

// Main client for reads/writes
export const redisClient = new Redis(REDIS_URL, {
  keyPrefix: KEY_PREFIX,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
});

redisClient.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

redisClient.on('connect', () => {
  console.info('[Redis] Connected');
});

// Separate subscriber client (cannot be used for commands while subscribed)
export const redisSubscriber = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
});

redisSubscriber.on('error', (err) => {
  console.error('[Redis Subscriber] Connection error:', err.message);
});

// ── Key builders ──────────────────────────────────────────────────────────────
// These functions produce the un-prefixed keys (redisClient adds the prefix automatically).

export const RedisKeys = {
  /** Active session state for a device */
  session: (deviceId: string) => `session:${deviceId}`,

  /** Device state cache (avoids DB query on every agent poll) */
  deviceState: (deviceId: string) => `device_state:${deviceId}`,

  /** Agent rate limit counter */
  agentHeartbeat: (deviceId: string) => `agent_hb:${deviceId}`,

  /** Daily usage minutes for a device */
  dailyUsage: (deviceId: string, date: string) => `usage:${deviceId}:${date}`,
} as const;

// ── Session data stored in Redis ──────────────────────────────────────────────

export interface RedisSessionData {
  sessionId: string;
  childId: string;
  deviceId: string;
  familyId: string;
  endsAt: string;       // ISO8601
  unlockMinutes: number;
  startedAt: string;    // ISO8601
}

export async function setSession(
  deviceId: string,
  data: RedisSessionData,
  ttlSeconds: number,
): Promise<void> {
  const key = RedisKeys.session(deviceId);
  await redisClient.set(key, JSON.stringify(data), 'EX', ttlSeconds);
}

export async function getSession(deviceId: string): Promise<RedisSessionData | null> {
  const key = RedisKeys.session(deviceId);
  const raw = await redisClient.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as RedisSessionData;
}

export async function deleteSession(deviceId: string): Promise<void> {
  const key = RedisKeys.session(deviceId);
  await redisClient.del(key);
}

export async function getSessionTTL(deviceId: string): Promise<number> {
  const key = RedisKeys.session(deviceId);
  return redisClient.ttl(key);
}
