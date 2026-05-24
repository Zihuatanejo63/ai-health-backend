-- Add password_hash column for email+password authentication
ALTER TABLE users ADD COLUMN password_hash TEXT;
