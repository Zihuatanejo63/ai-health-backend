-- Structured error logs for monitoring and debugging.
-- Never store: symptom details, health profiles, insurance data,
-- Gemini prompts/responses, API keys, or magic link tokens.

CREATE TABLE IF NOT EXISTS error_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  route TEXT,
  method TEXT,
  status INTEGER,
  client_hash TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_error_logs_event_type ON error_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at);
