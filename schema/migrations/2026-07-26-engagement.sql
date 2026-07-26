-- =============================================================
--  Migration: watch-page engagement layer
--  (video likes, comments with one-level replies, subscriptions)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
-- =============================================================

-- ── 1. Tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS video_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (video_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  -- One level of nesting only: replies point at a top-level comment,
  -- never at another reply (enforced in the API).
  parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'visible'
                      CHECK (status IN ('visible', 'hidden', 'deleted')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (creator_id, subscriber_id),
  CHECK (creator_id <> subscriber_id)
);

-- ── 2. Denormalized counters ─────────────────────────────────

ALTER TABLE videos ADD COLUMN IF NOT EXISTS like_count    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS follower_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS avatar_url     TEXT;

-- Counter triggers recompute from the source-of-truth tables (same
-- philosophy as the update_wallet_balance trigger: counts can never
-- drift, because they are always re-derived, never incremented).

CREATE OR REPLACE FUNCTION recount_video_likes() RETURNS TRIGGER AS $$
BEGIN
  UPDATE videos SET like_count = (
    SELECT COUNT(*) FROM video_likes vl
    WHERE vl.video_id = COALESCE(NEW.video_id, OLD.video_id)
  )
  WHERE id = COALESCE(NEW.video_id, OLD.video_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recount_video_likes ON video_likes;
CREATE TRIGGER trg_recount_video_likes
  AFTER INSERT OR DELETE ON video_likes
  FOR EACH ROW EXECUTE FUNCTION recount_video_likes();

-- Only 'visible' comments count toward comment_count, so soft deletes
-- and admin hides (status UPDATEs) must retrigger the recount too.
CREATE OR REPLACE FUNCTION recount_video_comments() RETURNS TRIGGER AS $$
BEGIN
  UPDATE videos SET comment_count = (
    SELECT COUNT(*) FROM comments c
    WHERE c.video_id = COALESCE(NEW.video_id, OLD.video_id)
      AND c.status = 'visible'
  )
  WHERE id = COALESCE(NEW.video_id, OLD.video_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recount_video_comments ON comments;
CREATE TRIGGER trg_recount_video_comments
  AFTER INSERT OR DELETE OR UPDATE OF status ON comments
  FOR EACH ROW EXECUTE FUNCTION recount_video_comments();

CREATE OR REPLACE FUNCTION recount_followers() RETURNS TRIGGER AS $$
BEGIN
  UPDATE users SET follower_count = (
    SELECT COUNT(*) FROM subscriptions s
    WHERE s.creator_id = COALESCE(NEW.creator_id, OLD.creator_id)
  )
  WHERE id = COALESCE(NEW.creator_id, OLD.creator_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recount_followers ON subscriptions;
CREATE TRIGGER trg_recount_followers
  AFTER INSERT OR DELETE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION recount_followers();

-- ── 3. Indexes for the API's query patterns ──────────────────
-- (the UNIQUE constraints above already index video_likes(video_id, ...)
--  and subscriptions(creator_id, ...))

-- Top-level comment pages, newest first
CREATE INDEX IF NOT EXISTS comments_video_top_level_idx
  ON comments (video_id, created_at DESC)
  WHERE parent_comment_id IS NULL;

-- Reply lookup for a page of parents
CREATE INDEX IF NOT EXISTS comments_parent_idx
  ON comments (parent_comment_id, created_at ASC)
  WHERE parent_comment_id IS NOT NULL;

-- Admin "recent comments" listing
CREATE INDEX IF NOT EXISTS comments_recent_idx
  ON comments (created_at DESC);

-- "Who do I subscribe to" lookups from the subscriber side
CREATE INDEX IF NOT EXISTS subscriptions_subscriber_idx
  ON subscriptions (subscriber_id);

-- ── 4. RLS (matches rls-policies.sql conventions: backend uses the
--        service role and bypasses these; reads are belt-and-suspenders
--        for any future direct Supabase client, writes stay backend-only
--        by defining no write policies) ─────────────────────────────

ALTER TABLE video_likes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "video_likes_select_own" ON video_likes;
CREATE POLICY "video_likes_select_own"
  ON video_likes FOR SELECT
  USING (auth.uid() = user_id);

-- Comments on published videos are public content — but only while
-- 'visible'. Hidden/deleted bodies are never client-readable directly.
DROP POLICY IF EXISTS "comments_select_visible" ON comments;
CREATE POLICY "comments_select_visible"
  ON comments FOR SELECT
  USING (status = 'visible');

DROP POLICY IF EXISTS "subscriptions_select_own" ON subscriptions;
CREATE POLICY "subscriptions_select_own"
  ON subscriptions FOR SELECT
  USING (auth.uid() = subscriber_id OR auth.uid() = creator_id);

-- ── Verify ───────────────────────────────────────────────────
-- Expect 3 rows:
--   SELECT tablename FROM pg_tables
--   WHERE tablename IN ('video_likes','comments','subscriptions');
-- Expect 3 rows:
--   SELECT tgname FROM pg_trigger
--   WHERE tgname LIKE 'trg_recount%';
