-- password_hash column was already added to users directly in production
-- before this migration ran there; ALTER would fail with duplicate column.
-- Kept as a no-op so migration history stays consistent.
SELECT 1;
