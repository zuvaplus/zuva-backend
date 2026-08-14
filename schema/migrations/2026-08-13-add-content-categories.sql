-- =============================================================
--  Migration: widen videos.content_category to 4 new values
--
--  Run in the Supabase SQL editor.
--  Idempotent — safe to re-run (DROP CONSTRAINT IF EXISTS + re-ADD).
--
--  Adds: sports, tech_innovation, science_education, health_wellness.
--  'sports' did not previously exist in this taxonomy (it existed only
--  in the older, separate `videos.category` / VideoCategory system —
--  unrelated to this constraint). sustainable_development is
--  intentionally NOT added here — handled as a hashtag, not a category.
--
--  Existing 11 values and their order are unchanged; the 4 new values
--  are appended. This is the same DROP+ADD pattern used the last time
--  this constraint was widened, in
--  2026-07-26-categories-and-ai-disclosure.sql (which superseded the
--  original version in 2026-07-26-feed-ranking.sql) — this migration
--  supersedes that one in turn.
-- =============================================================

ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_content_category_check;
ALTER TABLE videos ADD CONSTRAINT videos_content_category_check
  CHECK (content_category IN (
    'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
    'discussion_debate', 'interview', 'lifestyle_culture', 'news', 'nature',
    'sports', 'tech_innovation', 'science_education', 'health_wellness', 'other'
  ));

-- ── Verify ───────────────────────────────────────────────────
-- Expect the CHECK clause to list all 15 values:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'videos_content_category_check';
