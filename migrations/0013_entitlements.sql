CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'free',
  product_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT DEFAULT 'creem',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_checkout_id TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_status ON entitlements(status);
CREATE INDEX IF NOT EXISTS idx_entitlements_provider_subscription_id ON entitlements(provider_subscription_id);
