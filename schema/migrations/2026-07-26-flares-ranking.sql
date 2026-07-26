-- =============================================================
--  Migration: Flares ranking (flare_swipe_events)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  Deliberately separate from watch_events (see 2026-07-26-feed-ranking.sql)
--  — Flares ranking is a fully independent system from the main feed's,
--  different signals and different philosophy (immersive session length
--  vs. satisfaction/discovery), so it gets its own event table rather
--  than reusing/extending watch_events.
-- =============================================================

CREATE TABLE IF NOT EXISTS flare_swipe_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id               UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  watched_seconds        INTEGER NOT NULL CHECK (watched_seconds >= 0),
  video_duration_seconds INTEGER NOT NULL CHECK (video_duration_seconds > 0),
  -- true if the viewer left before a "reasonable completion" threshold
  -- (< 75% watched) — the inverse-penalty signal for computeFlareScore.
  swiped_away            BOOLEAN NOT NULL DEFAULT false,
  -- true if this event represents a rewatch within the same session
  -- (the player looped back to 0 and kept playing while still active).
  looped                 BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS flare_swipe_events_video_idx ON flare_swipe_events (video_id);

ALTER TABLE flare_swipe_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "flare_swipe_events_select_own" ON flare_swipe_events;
CREATE POLICY "flare_swipe_events_select_own"
  ON flare_swipe_events FOR SELECT
  USING (auth.uid() = user_id);

-- ── Verify ───────────────────────────────────────────────────
-- Expect 1 row:
--   SELECT tablename FROM pg_tables WHERE tablename = 'flare_swipe_events';
