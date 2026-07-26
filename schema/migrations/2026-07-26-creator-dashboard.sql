-- =============================================================
--  Migration: creator dashboard support (creator_links)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  Note: no other schema changes are needed for the creator dashboard —
--  users.avatar_url already exists (2026-07-26-engagement.sql), and the
--  "my videos" list and video counters reuse existing videos columns.
-- =============================================================

CREATE TABLE IF NOT EXISTS creator_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS creator_links_creator_position_idx
  ON creator_links (creator_id, position);

ALTER TABLE creator_links ENABLE ROW LEVEL SECURITY;

-- Reads only (matches rls-policies.sql conventions) — the backend uses
-- the service role and bypasses this; writes stay backend-only. Once the
-- future watch-page links shelf ships, a public-read policy can be added
-- for published creators; not needed while only the owner reads them.
DROP POLICY IF EXISTS "creator_links_select_own" ON creator_links;
CREATE POLICY "creator_links_select_own"
  ON creator_links FOR SELECT
  USING (auth.uid() = creator_id);

-- ── Verify ───────────────────────────────────────────────────
-- Expect 1 row:
--   SELECT tablename FROM pg_tables WHERE tablename = 'creator_links';
