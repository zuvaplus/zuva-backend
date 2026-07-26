-- =============================================================
--  Migration: Main feed ranking (watch_events, content_category,
--  viewer country/language preferences)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  This is the missing signal the whole ranking model depends on:
--  watch_events records granular watch behavior (periodic progress
--  pings + pause/unload), not just a single on-leave event, so
--  completion rate can be computed per video from real data.
-- =============================================================

-- ── 1. watch_events ──────────────────────────────────────────
-- One row per progress ping (roughly every 10-15s of playback) or
-- per pause/unload. user_id is nullable — anonymous viewers still
-- contribute completion-rate signal, they just can't be personalized to.
CREATE TABLE IF NOT EXISTS watch_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id               UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  watched_seconds        INTEGER NOT NULL CHECK (watched_seconds >= 0),
  video_duration_seconds INTEGER NOT NULL CHECK (video_duration_seconds > 0),
  -- Stored (not generated) — computed once at insert time from whatever
  -- watched_seconds/video_duration_seconds the client reported, capped at
  -- 100 so a late/duplicate ping past the end can't skew averages above it.
  completion_pct         NUMERIC(5,2) NOT NULL CHECK (completion_pct >= 0 AND completion_pct <= 100),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS watch_events_video_idx ON watch_events (video_id);

ALTER TABLE watch_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "watch_events_select_own" ON watch_events;
CREATE POLICY "watch_events_select_own"
  ON watch_events FOR SELECT
  USING (auth.uid() = user_id);

-- ── 2. videos.content_category ───────────────────────────────
-- Separate from the existing `category` column (VALID_VIDEO_CATEGORIES —
-- Comedy/Drama/Music/News/Sports/Lifestyle/Education/Other), which stays
-- as-is for now. content_category is the richer taxonomy the ranking
-- model reasons about, notably distinguishing the "Documentary &
-- Discussion" umbrella (documentary, discussion_debate, interview,
-- lifestyle_culture — grouped in code as DOC_DISCUSSION_CATEGORIES, not
-- a DB-level concept) which gets protected placement and different
-- score weighting. See the NOTE in CLAUDE.md about reconciling these
-- two category fields eventually.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS content_category TEXT NOT NULL DEFAULT 'other'
  CHECK (content_category IN (
    'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
    'discussion_debate', 'interview', 'lifestyle_culture', 'news', 'other'
  ));

-- Speeds up the category-floor queries (WHERE content_category IN (...)
-- AND status = 'published' ORDER BY created_at/score).
CREATE INDEX IF NOT EXISTS videos_content_category_idx
  ON videos (content_category, status)
  WHERE status = 'published';

-- ── 3. users.preferred_country / preferred_languages ─────────
-- Distinct from the existing users.country_code (the viewer's account/
-- profile country) — these represent a *content* preference, which may
-- differ (e.g. diaspora viewers). Nullable/empty by default; nothing
-- populates preferred_languages yet (no settings UI was requested), so
-- until a settings page writes to it, the language half of the ranking
-- boost has no signal to match against — see CLAUDE.md note.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_languages TEXT[] NOT NULL DEFAULT '{}';

-- ── Verify ───────────────────────────────────────────────────
-- Expect 1 row:
--   SELECT tablename FROM pg_tables WHERE tablename = 'watch_events';
-- Expect 3 rows:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'videos' AND column_name = 'content_category'
--   UNION ALL
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name IN ('preferred_country', 'preferred_languages');
