CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  public_name TEXT NOT NULL,
  country TEXT NOT NULL,
  license_region TEXT NOT NULL,
  license_number TEXT,
  license_lookup_url TEXT,
  specialty TEXT NOT NULL,
  languages TEXT NOT NULL DEFAULT '[]',
  consultation_request_fee_usd INTEGER NOT NULL,
  profile_status TEXT NOT NULL DEFAULT 'draft',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_method TEXT,
  institution_name TEXT,
  institution_email_domain TEXT,
  public_profile_url TEXT,
  notes TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctor_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  result TEXT NOT NULL,
  checked_by TEXT,
  evidence_url TEXT,
  notes TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

ALTER TABLE doctor_requests ADD COLUMN doctor_record_id TEXT;
ALTER TABLE orders ADD COLUMN doctor_record_id TEXT;

CREATE INDEX IF NOT EXISTS idx_doctors_verification_status ON doctors(verification_status);
CREATE INDEX IF NOT EXISTS idx_doctors_profile_status ON doctors(profile_status);
CREATE INDEX IF NOT EXISTS idx_doctors_specialty ON doctors(specialty);
CREATE INDEX IF NOT EXISTS idx_doctor_verifications_doctor_id ON doctor_verifications(doctor_id);
CREATE INDEX IF NOT EXISTS idx_doctor_requests_doctor_record_id ON doctor_requests(doctor_record_id);
CREATE INDEX IF NOT EXISTS idx_orders_doctor_record_id ON orders(doctor_record_id);

INSERT OR IGNORE INTO doctors (
  id,
  full_name,
  public_name,
  country,
  license_region,
  license_number,
  license_lookup_url,
  specialty,
  languages,
  consultation_request_fee_usd,
  profile_status,
  verification_status,
  verification_method,
  notes
) VALUES
  (
    'doc-1',
    'Sarah Jenkins',
    'Dr. Sarah Jenkins, MD',
    'United States',
    'State medical board lookup required',
    NULL,
    NULL,
    'Dermatology',
    '["English","Spanish"]',
    120,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify license number, official registry, and identity before live use.'
  ),
  (
    'doc-2',
    'Michael Chen',
    'Dr. Michael Chen, FACP',
    'United States',
    'State medical board lookup required',
    NULL,
    NULL,
    'Internal Medicine',
    '["English","Mandarin"]',
    140,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify license number, official registry, and identity before live use.'
  ),
  (
    'doc-3',
    'Emily Rivera',
    'Dr. Emily Rivera, DO',
    'Mexico',
    'National/state medical registry lookup required',
    NULL,
    NULL,
    'Family Medicine',
    '["English","Spanish"]',
    100,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify license number, official registry, and identity before live use.'
  ),
  (
    'doc-4',
    'James Patel',
    'Dr. James Patel, MD',
    'United Kingdom',
    'GMC lookup required',
    NULL,
    NULL,
    'Cardiology',
    '["English","Hindi"]',
    180,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify GMC registration, identity, and practice eligibility before live use.'
  ),
  (
    'doc-5',
    'Amina Haddad',
    'Dr. Amina Haddad, MD',
    'United Arab Emirates',
    'Local health authority lookup required',
    NULL,
    NULL,
    'Pediatrics',
    '["Arabic","English","French"]',
    130,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify license number, official registry, and identity before live use.'
  ),
  (
    'doc-6',
    'Hana Mori',
    'Dr. Hana Mori, MD',
    'Japan',
    'Local physician registry lookup required',
    NULL,
    NULL,
    'Dermatology',
    '["Japanese","English"]',
    110,
    'hidden',
    'pending',
    'manual_official_registry_required',
    'Seeded from MVP mock data. Must verify license number, official registry, and identity before live use.'
  );

UPDATE doctor_requests
SET doctor_record_id = doctor_id
WHERE doctor_record_id IS NULL
  AND doctor_id IN (SELECT id FROM doctors);

UPDATE orders
SET doctor_record_id = (
  SELECT doctor_requests.doctor_record_id
  FROM doctor_requests
  WHERE doctor_requests.id = orders.doctor_request_id
)
WHERE doctor_record_id IS NULL
  AND doctor_request_id IS NOT NULL;
