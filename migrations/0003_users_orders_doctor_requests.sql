CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  display_name TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'English',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctor_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_reference_id TEXT,
  doctor_id TEXT NOT NULL,
  patient_email TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_reference_id) REFERENCES cases(reference_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_reference_id TEXT,
  doctor_request_id INTEGER,
  amount_usd INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_reference_id) REFERENCES cases(reference_id),
  FOREIGN KEY (doctor_request_id) REFERENCES doctor_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_doctor_requests_status ON doctor_requests(status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_case_reference_id ON orders(case_reference_id);
