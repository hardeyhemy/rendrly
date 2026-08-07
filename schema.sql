CREATE TABLE IF NOT EXISTS api_keys (
  key        TEXT PRIMARY KEY,
  email      TEXT,
  plan       TEXT NOT NULL DEFAULT 'free',
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys (email);
