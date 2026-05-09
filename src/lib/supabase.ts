import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Direct Postgres connection. Throws a clear error at startup if DATABASE_URL is missing.
export const sql: ReturnType<typeof postgres> = DATABASE_URL
  ? postgres(DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      onnotice: () => {},
      transform: {
        column: {
          from: postgres.toCamel,
          to: postgres.fromCamel,
        },
      },
    })
  : new Proxy({} as ReturnType<typeof postgres>, {
      get() {
        throw new Error('DATABASE_URL is not set. Add it to .env to use direct SQL queries.');
      },
      apply() {
        throw new Error('DATABASE_URL is not set. Add it to .env to use direct SQL queries.');
      },
    });
