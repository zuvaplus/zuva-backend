-- =============================================================
--  Migration: tiered video reporting + instant publish support
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  NOTE on naming: the request that drove this migration referred to
--  "the moderation_status enum" — the real column on `videos` is
--  called `status` (moderation_status only exists in dead legacy code
--  referencing tables that were never real — see the "MAIN FEED
--  RANKING" comment block earlier in zuva-api.js). 'under_review'
--  already exists in videos.status's CHECK constraint (added when
--  report-triggered review was first built) — reasserted below anyway,
--  defensively, so this migration gives a clean positive confirmation
--  either way.
-- =============================================================

-- ── 1. videos.status — confirm 'under_review' (defensive, likely a no-op) ──
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_status_check
  CHECK (status IN ('pending', 'published', 'rejected', 'flagged', 'under_review'));

-- ── 2. video_reports — widen the existing table for category-based
--       tiered severity + resolution tracking ──────────────────────
-- Existing columns (id SERIAL, video_id, reason TEXT NOT NULL,
-- reporter_clerk_id TEXT, created_at) are left in place rather than
-- dropped — `reason`/`reporter_clerk_id` just stop being written to by
-- new reports (reason's NOT NULL is relaxed below so inserts can omit
-- it); historical rows keep their data for reference.
ALTER TABLE video_reports ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE video_reports ADD COLUMN IF NOT EXISTS reporter_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE video_reports ADD COLUMN IF NOT EXISTS additional_details TEXT;
ALTER TABLE video_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE video_reports ADD COLUMN IF NOT EXISTS resolution TEXT;

ALTER TABLE video_reports ADD COLUMN IF NOT EXISTS category TEXT;
-- Backfill pre-existing rows (free-text `reason`, no category) to
-- 'other' so category can go NOT NULL going forward without losing history.
UPDATE video_reports SET category = 'other' WHERE category IS NULL;
ALTER TABLE video_reports ALTER COLUMN category SET NOT NULL;

ALTER TABLE video_reports DROP CONSTRAINT IF EXISTS video_reports_category_check;
ALTER TABLE video_reports ADD CONSTRAINT video_reports_category_check
  CHECK (category IN (
    'nudity', 'minors', 'violence', 'animal_cruelty', 'hate_speech',
    'misinformation', 'spam', 'copyright', 'other'
  ));

ALTER TABLE video_reports DROP CONSTRAINT IF EXISTS video_reports_resolution_check;
ALTER TABLE video_reports ADD CONSTRAINT video_reports_resolution_check
  CHECK (resolution IN ('restored', 'removed'));

-- Report-trigger counts are scoped to *pending* (unresolved) reports per
-- severity tier — see computeReportTier() in zuva-api.js — so this index
-- covers both that lookup and the admin queue's per-category filter.
CREATE INDEX IF NOT EXISTS video_reports_video_pending_idx
  ON video_reports (video_id, category)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS video_reports_category_idx ON video_reports (category, resolved_at);
CREATE INDEX IF NOT EXISTS video_reports_created_at_idx ON video_reports (created_at);

ALTER TABLE video_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "video_reports_select_own" ON video_reports;
CREATE POLICY "video_reports_select_own"
  ON video_reports FOR SELECT
  USING (auth.uid() = reporter_id);

-- ── 3. users.violation_count ──────────────────────────────────
-- Incremented once per "removed" report resolution (see
-- POST /api/admin/reports/:id/resolve) — a persistent record for
-- repeat-violation tracking. Feeds a future enforcement ladder; this
-- migration only adds the counter itself, not any automated action
-- based on it (no Community Guidelines / enforcement-ladder content
-- exists in the codebase yet to hook into).
ALTER TABLE users ADD COLUMN IF NOT EXISTS violation_count INTEGER NOT NULL DEFAULT 0;

-- ── Verify ───────────────────────────────────────────────────
-- Expect the definition to include 'under_review':
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'videos_status_check';
-- Expect 6 rows:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'video_reports'
--     AND column_name IN ('reporter_id','additional_details','resolved_at','resolution','category','id')
--   UNION ALL
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name = 'violation_count';
