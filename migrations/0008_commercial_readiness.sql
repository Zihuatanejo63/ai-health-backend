-- Enhance users table for real auth
-- The existing users table has: id INTEGER PK, email TEXT, display_name TEXT, preferred_language TEXT, created_at TEXT
-- Add missing columns for session-based auth

-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check manually or use ALTER TABLE
-- These may fail if columns already exist (idempotent for fresh deploys; safe for D1 apply)

ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Sessions table: server-side session management
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Auth tokens: magic link tokens, password reset tokens, etc.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_email_purpose ON auth_tokens(email, purpose);

-- Entitlements: server-side subscription/entitlement state
CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT DEFAULT 'creem',
  creem_customer_id TEXT,
  creem_checkout_id TEXT,
  creem_subscription_id TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, plan)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_creem_subscription ON entitlements(creem_subscription_id);

-- Payment events: idempotent webhook processing
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT DEFAULT 'creem',
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Checkout sessions: track checkout creation for binding users
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'plus_monthly',
  product_id TEXT,
  provider TEXT DEFAULT 'creem',
  provider_checkout_id TEXT,
  checkout_url TEXT,
  status TEXT DEFAULT 'pending',
  amount INTEGER,
  currency TEXT DEFAULT 'usd',
  raw_response TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_user_id ON checkout_sessions(user_id);

-- Symptom checks: server-side storage with encrypted payload
CREATE TABLE IF NOT EXISTS symptom_checks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  risk_level TEXT,
  recommended_care TEXT,
  primary_concern TEXT,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_symptom_checks_user_id ON symptom_checks(user_id);

-- Health profiles: encrypted server-side storage
CREATE TABLE IF NOT EXISTS health_profiles (
  user_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insurance profiles: encrypted server-side storage
CREATE TABLE IF NOT EXISTS insurance_profiles (
  user_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Coverage checklists: encrypted server-side storage
CREATE TABLE IF NOT EXISTS coverage_checklists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  care_type TEXT,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_coverage_checklists_user_id ON coverage_checklists(user_id);

-- API logs: if not already exists (from 0005)
-- CREATE TABLE IF NOT EXISTS api_logs (...)
