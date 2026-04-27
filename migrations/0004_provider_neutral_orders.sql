ALTER TABLE orders ADD COLUMN payment_provider TEXT;
ALTER TABLE orders ADD COLUMN provider_checkout_id TEXT;
ALTER TABLE orders ADD COLUMN provider_checkout_url TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_payment_provider ON orders(payment_provider);
