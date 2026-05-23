ALTER TABLE orders ADD COLUMN gross_amount_usd INTEGER;
ALTER TABLE orders ADD COLUMN platform_fee_rate_bps INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE orders ADD COLUMN platform_fee_usd INTEGER;
ALTER TABLE orders ADD COLUMN doctor_payout_usd INTEGER;
ALTER TABLE orders ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN payout_method TEXT;
ALTER TABLE orders ADD COLUMN payout_reference TEXT;
ALTER TABLE orders ADD COLUMN paid_out_at TEXT;
ALTER TABLE orders ADD COLUMN service_status TEXT NOT NULL DEFAULT 'pending_confirmation';

CREATE TABLE IF NOT EXISTS ledger_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  amount_usd INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_payout_status ON orders(payout_status);
CREATE INDEX IF NOT EXISTS idx_orders_service_status ON orders(service_status);
CREATE INDEX IF NOT EXISTS idx_ledger_events_order_id ON ledger_events(order_id);

UPDATE orders
SET gross_amount_usd = COALESCE(gross_amount_usd, amount_usd),
    platform_fee_usd = COALESCE(platform_fee_usd, ROUND(amount_usd * 0.3)),
    doctor_payout_usd = COALESCE(doctor_payout_usd, amount_usd - ROUND(amount_usd * 0.3)),
    payout_status = COALESCE(payout_status, 'pending'),
    service_status = COALESCE(service_status, 'pending_confirmation')
WHERE gross_amount_usd IS NULL
   OR platform_fee_usd IS NULL
   OR doctor_payout_usd IS NULL;
