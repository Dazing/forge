-- 001_initial.sql
-- Migration fixture for the dashboard domain.
-- This is a test fixture for database-risk task shapes, not a production schema.

CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value INTEGER NOT NULL
);

-- Deterministic seed rows (mirrors test/fixtures/seed.ts and src/server/main.ts SEED)
INSERT OR IGNORE INTO dashboard_items (id, label, value)
VALUES
  ('orders', 'Orders', 128),
  ('revenue', 'Revenue', 4250),
  ('users', 'Active Users', 97);
