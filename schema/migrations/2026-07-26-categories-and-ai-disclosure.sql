-- =============================================================
--  Migration: new content categories (nature) + AI-content
--  self-disclosure (contains_synthetic_media)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
-- =============================================================

-- ── 1. content_category: add 'nature' ─────────────────────────
-- 'news' already exists in the taxonomy (added in the earlier feed-
-- ranking migration) — nothing to add there. Postgres has no
-- "ALTER CHECK" — the only way to widen an inline CHECK is to drop and
-- recreate it. The DROP below targets the auto-generated constraint
-- name Postgres assigned to the original inline CHECK
-- (`<table>_<column>_check`, the default naming convention) — if that
-- constraint was ever renamed manually this DROP is a no-op and the
-- ADD below will fail loudly rather than silently leaving 'nature'
-- unsupported, which is the safer failure mode here.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_content_category_check;
ALTER TABLE videos ADD CONSTRAINT videos_content_category_check
  CHECK (content_category IN (
    'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
    'discussion_debate', 'interview', 'lifestyle_culture', 'news',
    'nature', 'other'
  ));

-- ── 2. AI-content self-disclosure ─────────────────────────────
-- Self-disclosure only — no automated detection. Required at upload
-- going forward (validated server-side, no default in the client
-- form), defaults existing rows to false since nothing about legacy
-- content was ever disclosed either way.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS contains_synthetic_media BOOLEAN NOT NULL DEFAULT false;

-- ── Verify ───────────────────────────────────────────────────
-- Expect content_category's CHECK to mention 'nature':
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'videos_content_category_check';
-- Expect 1 row:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'videos' AND column_name = 'contains_synthetic_media';
