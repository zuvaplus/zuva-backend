-- =============================================================
--  Migration: saved_videos (bookmarks) table
--
--  Run in the Supabase SQL editor.
--  Idempotent — safe to re-run.
--
--  Backs the new /saved page and the video watch page's Save button.
--  Mirrors video_likes' shape exactly (2026-07-26-engagement.sql) —
--  same UNIQUE(video_id, user_id) + ON DELETE CASCADE pattern. No
--  denormalized counter/trigger here: nothing in this task's UI shows
--  a "save count" anywhere, unlike like_count.
-- =============================================================

CREATE TABLE IF NOT EXISTS saved_videos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (video_id, user_id)
);

-- "My saved videos, most recently saved first" — the /saved page's only
-- query pattern.
CREATE INDEX IF NOT EXISTS saved_videos_user_idx
  ON saved_videos (user_id, created_at DESC);

ALTER TABLE saved_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saved_videos_select_own" ON saved_videos;
CREATE POLICY "saved_videos_select_own"
  ON saved_videos FOR SELECT
  USING (auth.uid() = user_id);

-- ── Verify ───────────────────────────────────────────────────
-- Expect 1 row:
--   SELECT tablename FROM pg_tables WHERE tablename = 'saved_videos';
