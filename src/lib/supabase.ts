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

// Direct Postgres connection — only available when DATABASE_URL is set.
// Falls back gracefully to supabaseAdmin for all operations in dev.
export const sql = DATABASE_URL
  ? postgres(DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
      onnotice: () => {},
      transform: {
        column: {
          from: postgres.toCamel,
          to: postgres.fromCamel,
        },
      },
    })
  : null;
