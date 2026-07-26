-- =============================================================
--  Migration: Flares (short-form vertical feed)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  Flares share the existing videos table / Cloudflare Stream pipeline
--  with long-form uploads — is_flare just flags which feed a row
--  belongs to; no new table.
--
--  NOTE on duration_seconds: this column already exists on `videos` per
--  the current codebase (used throughout zuva-api.js — upload insert,
--  GET /upload/status, GET /api/video/:id, etc.). Included below as
--  IF NOT EXISTS purely for safety in case your live schema predates
--  that — expect this specific line to be a no-op.
-- =============================================================

ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_flare         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

-- Speeds up the Flares feed's WHERE is_flare = true AND status = 'published'
-- filter + created_at ordering (the hot-score ORDER BY can't be indexed
-- directly since it's a runtime expression, but this index still lets
-- Postgres cheaply narrow to the Flares/published rows before sorting).
CREATE INDEX IF NOT EXISTS videos_flares_feed_idx
  ON videos (is_flare, status, created_at DESC)
  WHERE is_flare = true;

-- ── Verify ───────────────────────────────────────────────────
-- Expect 2 rows:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'videos' AND column_name IN ('is_flare', 'duration_seconds');
