-- ============================================================
-- Mosaic Backend — Complete Database Schema
-- Run this in Supabase SQL Editor or via psql
--
-- Usage:
--   psql $DATABASE_URL -f src/db/schema.sql
--
-- This file is the canonical schema. It is safe to run on a
-- fresh database. For incremental changes use migrations/.
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('parent', 'child');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE device_platform AS ENUM ('macos', 'ios', 'android', 'windows');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE device_state AS ENUM ('locked', 'unlocked', 'offline', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('active', 'completed', 'archived', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_end_reason AS ENUM (
    'expired', 'parent_revoked', 'agent_error', 'rule_change', 'manual_end'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM (
    'task_created', 'task_updated', 'task_archived',
    'submission_created', 'submission_approved', 'submission_rejected',
    'session_started', 'session_ended',
    'device_registered', 'device_heartbeat', 'tamper_event',
    'rule_updated', 'family_settings_updated',
    'user_created', 'parent_login', 'agent_login'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS families (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT NOT NULL,
  default_unlock_minutes  INTEGER NOT NULL DEFAULT 60
    CHECK (default_unlock_minutes > 0 AND default_unlock_minutes <= 1440),
  timezone                TEXT NOT NULL DEFAULT 'UTC',
  plan                    TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id         UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role              user_role NOT NULL,
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  birth_year        SMALLINT
    CHECK (birth_year > 1990 AND birth_year <= EXTRACT(YEAR FROM NOW())),
  is_primary_parent BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT child_requires_birth_year
    CHECK (role != 'child' OR birth_year IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS devices (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  family_id             UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform              device_platform NOT NULL,
  device_name           TEXT NOT NULL,
  hardware_id           TEXT UNIQUE,
  agent_token_hash      TEXT,
  current_state         device_state NOT NULL DEFAULT 'unknown',
  last_heartbeat_at     TIMESTAMPTZ,
  last_state_change_at  TIMESTAMPTZ,
  os_version            TEXT,
  agent_version         TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  family_id        UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by       UUID NOT NULL REFERENCES users(id),
  title            TEXT NOT NULL CHECK (LENGTH(title) BETWEEN 1 AND 200),
  description      TEXT CHECK (LENGTH(description) <= 2000),
  due_date         DATE,
  due_time         TIME,
  recurrence_rule  TEXT,
  unlock_minutes   INTEGER NOT NULL
    CHECK (unlock_minutes > 0 AND unlock_minutes <= 1440),
  requires_photo   BOOLEAN NOT NULL DEFAULT FALSE,
  status           task_status NOT NULL DEFAULT 'active',
  icon             TEXT DEFAULT 'checkmark.circle',
  color            TEXT DEFAULT '#6366F1',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id           UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  note                TEXT CHECK (LENGTH(note) <= 1000),
  evidence_photo_key  TEXT,
  status              submission_status NOT NULL DEFAULT 'pending',
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  device_id           UUID REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id         UUID NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE CASCADE,
  reviewer_id           UUID NOT NULL REFERENCES users(id),
  family_id             UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  approved              BOOLEAN NOT NULL,
  comment               TEXT CHECK (LENGTH(comment) <= 500),
  unlock_minutes_granted INTEGER CHECK (unlock_minutes_granted > 0),
  reviewed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  child_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  approval_id    UUID REFERENCES approvals(id),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  end_reason     session_end_reason,
  unlock_minutes INTEGER NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT session_ends_after_starts CHECK (ends_at > started_at)
);

CREATE TABLE IF NOT EXISTS rules (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id            UUID NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  family_id            UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  emergency_apps       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  allowed_domains      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  lock_schedule        JSONB NOT NULL DEFAULT '[]'::JSONB,
  bedtime_start        TIME,
  bedtime_end          TIME,
  max_session_minutes  INTEGER CHECK (max_session_minutes > 0 AND max_session_minutes <= 1440),
  daily_budget_minutes INTEGER CHECK (daily_budget_minutes > 0 AND daily_budget_minutes <= 1440),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by           UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id),
  actor_role  user_role,
  device_id   UUID REFERENCES devices(id),
  action      audit_action NOT NULL,
  entity_type TEXT,
  entity_id   UUID,
  metadata    JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_tokens (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id          UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token              TEXT NOT NULL,
  platform           TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_fingerprint TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at       TIMESTAMPTZ,
  UNIQUE (user_id, device_fingerprint)
);

CREATE TABLE IF NOT EXISTS daily_usage (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id        UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  family_id        UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  usage_date       DATE NOT NULL,
  unlocked_minutes INTEGER NOT NULL DEFAULT 0,
  tasks_completed  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, usage_date)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_family_id ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(family_id, role);
CREATE INDEX IF NOT EXISTS idx_devices_family_id ON devices(family_id);
CREATE INDEX IF NOT EXISTS idx_devices_child_id ON devices(child_id);
CREATE INDEX IF NOT EXISTS idx_devices_hardware_id ON devices(hardware_id) WHERE hardware_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_family_id ON tasks(family_id);
CREATE INDEX IF NOT EXISTS idx_tasks_child_id ON tasks(child_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(child_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_submissions_family_id ON task_submissions(family_id);
CREATE INDEX IF NOT EXISTS idx_submissions_child_id ON task_submissions(child_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON task_submissions(family_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON task_submissions(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_family_id ON approvals(family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(device_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_rules_family_id ON rules(family_id);
CREATE INDEX IF NOT EXISTS idx_audit_family_id ON audit_log(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_device_id ON audit_log(device_id, created_at DESC) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_tokens_user_id ON notification_tokens(user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_daily_usage_device ON daily_usage(device_id, usage_date DESC);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_families_updated_at
    BEFORE UPDATE ON families FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_devices_updated_at
    BEFORE UPDATE ON devices FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auto-create rules row when a device is registered
CREATE OR REPLACE FUNCTION create_default_rules()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO rules (device_id, family_id)
  VALUES (NEW.id, NEW.family_id)
  ON CONFLICT (device_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN
  CREATE TRIGGER trg_device_create_rules
    AFTER INSERT ON devices FOR EACH ROW
    EXECUTE FUNCTION create_default_rules();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Helper functions for RLS
CREATE OR REPLACE FUNCTION auth_family_id()
RETURNS UUID AS $$
  SELECT family_id FROM users WHERE id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION auth_user_role()
RETURNS user_role AS $$
  SELECT role FROM users WHERE id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE families            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_submissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_usage         ENABLE ROW LEVEL SECURITY;

-- families
DROP POLICY IF EXISTS families_select ON families;
CREATE POLICY families_select ON families FOR SELECT USING (id = auth_family_id());
DROP POLICY IF EXISTS families_update ON families;
CREATE POLICY families_update ON families FOR UPDATE
  USING (id = auth_family_id() AND auth_user_role() = 'parent');

-- users
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users FOR UPDATE USING (id = auth.uid());

-- devices
DROP POLICY IF EXISTS devices_select ON devices;
CREATE POLICY devices_select ON devices FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS devices_insert ON devices;
CREATE POLICY devices_insert ON devices FOR INSERT
  WITH CHECK (family_id = auth_family_id() AND auth_user_role() = 'parent');
DROP POLICY IF EXISTS devices_update ON devices;
CREATE POLICY devices_update ON devices FOR UPDATE
  USING (family_id = auth_family_id() AND auth_user_role() = 'parent');

-- tasks
DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (family_id = auth_family_id() AND auth_user_role() = 'parent');
DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (family_id = auth_family_id() AND auth_user_role() = 'parent');

-- task_submissions
DROP POLICY IF EXISTS submissions_select ON task_submissions;
CREATE POLICY submissions_select ON task_submissions FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS submissions_insert ON task_submissions;
CREATE POLICY submissions_insert ON task_submissions FOR INSERT
  WITH CHECK (family_id = auth_family_id() AND child_id = auth.uid() AND auth_user_role() = 'child');

-- approvals
DROP POLICY IF EXISTS approvals_select ON approvals;
CREATE POLICY approvals_select ON approvals FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS approvals_insert ON approvals;
CREATE POLICY approvals_insert ON approvals FOR INSERT
  WITH CHECK (family_id = auth_family_id() AND auth_user_role() = 'parent');

-- sessions
DROP POLICY IF EXISTS sessions_select ON sessions;
CREATE POLICY sessions_select ON sessions FOR SELECT USING (family_id = auth_family_id());

-- rules
DROP POLICY IF EXISTS rules_select ON rules;
CREATE POLICY rules_select ON rules FOR SELECT USING (family_id = auth_family_id());
DROP POLICY IF EXISTS rules_update ON rules;
CREATE POLICY rules_update ON rules FOR UPDATE
  USING (family_id = auth_family_id() AND auth_user_role() = 'parent');

-- audit_log
DROP POLICY IF EXISTS audit_select ON audit_log;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (family_id = auth_family_id() AND auth_user_role() = 'parent');

-- notification_tokens
DROP POLICY IF EXISTS notif_tokens_select ON notification_tokens;
CREATE POLICY notif_tokens_select ON notification_tokens FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notif_tokens_insert ON notification_tokens;
CREATE POLICY notif_tokens_insert ON notification_tokens FOR INSERT
  WITH CHECK (user_id = auth.uid() AND family_id = auth_family_id());
DROP POLICY IF EXISTS notif_tokens_update ON notification_tokens;
CREATE POLICY notif_tokens_update ON notification_tokens FOR UPDATE USING (user_id = auth.uid());

-- daily_usage
DROP POLICY IF EXISTS daily_usage_select ON daily_usage;
CREATE POLICY daily_usage_select ON daily_usage FOR SELECT USING (family_id = auth_family_id());
