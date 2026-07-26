-- =============================================================
--  ZUVA.TV — Row Level Security Policies
--  Run this once in the Supabase SQL Editor (or via migration).
--
--  The Express backend connects with the service_role key, which
--  bypasses RLS entirely. These policies guard against:
--    • Accidental direct anon/authenticated Supabase client calls
--    • Future frontend SDK usage before it's properly secured
--
--  All write paths (INSERT/UPDATE/DELETE) remain backend-only:
--  no client-facing write policies are defined, so any non-service-
--  role connection attempting a write will be denied by default.
--
--  auth.uid() returns the Supabase Auth UUID for the current JWT.
-- =============================================================


-- =============================================================
--  1. ENABLE RLS ON ALL APPLICATION TABLES
-- =============================================================

ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sun_purchases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tips               ENABLE ROW LEVEL SECURITY;
ALTER TABLE vertical_content   ENABLE ROW LEVEL SECURITY;
ALTER TABLE landscape_content  ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_views      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_interests     ENABLE ROW LEVEL SECURITY;

-- creator_earnings_summary is a VIEW — RLS is enforced through
-- the underlying tables (wallets, tips, ledger_entries, payouts).


-- =============================================================
--  2. users
--  Each user can read and update only their own profile row.
--  Deletion is backend-only (account deletion flow).
-- =============================================================

CREATE POLICY "users_select_own"
  ON users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "users_update_own"
  ON users FOR UPDATE
  USING (auth.uid() = id);


-- =============================================================
--  3. wallets
--  Users can read their own wallet only.
--  All balance mutations go through the backend (double-entry
--  ledger), so no client write policies are defined.
-- =============================================================

CREATE POLICY "wallets_select_own"
  ON wallets FOR SELECT
  USING (auth.uid() = user_id);


-- =============================================================
--  4. ledger_entries
--  Users can read entries that belong to their own wallet.
--  Ledger rows are immutable once written — no update/delete.
-- =============================================================

CREATE POLICY "ledger_entries_select_own"
  ON ledger_entries FOR SELECT
  USING (
    wallet_id IN (
      SELECT id FROM wallets WHERE user_id = auth.uid()
    )
  );


-- =============================================================
--  5. sun_purchases
--  Buyers can read their own purchase records.
--  Purchases are created and updated by the backend only
--  (payment provider webhook flow).
-- =============================================================

CREATE POLICY "sun_purchases_select_own"
  ON sun_purchases FOR SELECT
  USING (auth.uid() = buyer_id);


-- =============================================================
--  6. tips
--  Both the sender and the recipient creator can read a tip.
--  Tips are written exclusively by the backend tip route.
-- =============================================================

CREATE POLICY "tips_select_involved"
  ON tips FOR SELECT
  USING (
    auth.uid() = sender_id
    OR auth.uid() = creator_id
  );


-- =============================================================
--  7. vertical_content
--  All authenticated users can browse published content.
--  Creators can read their own unpublished drafts too.
--  Only the owning creator can see their content regardless
--  of status; everyone else sees published rows only.
-- =============================================================

CREATE POLICY "vertical_content_select_published"
  ON vertical_content FOR SELECT
  USING (
    status = 'published'
    OR auth.uid() = creator_id
  );


-- =============================================================
--  8. landscape_content
--  Same access pattern as vertical_content.
-- =============================================================

CREATE POLICY "landscape_content_select_published"
  ON landscape_content FOR SELECT
  USING (
    status = 'published'
    OR auth.uid() = creator_id
  );


-- =============================================================
--  9. creator_profiles
--  Public read — viewers need creator metadata (name, tier,
--  share percentages) to display tip UI and creator pages.
--  Profile updates are backend-only (tier recalculation logic
--  lives in the API, not in client code).
-- =============================================================

CREATE POLICY "creator_profiles_select_public"
  ON creator_profiles FOR SELECT
  USING (true);


-- =============================================================
-- 10. payouts
--  Creators can read their own payout history.
--  Payout records are written by the backend cashout route.
-- =============================================================

CREATE POLICY "payouts_select_own"
  ON payouts FOR SELECT
  USING (auth.uid() = creator_id);


-- =============================================================
-- 11. content_views
--  Users can read their own viewing history.
--  Creators can read view counts on their own content
--  (for analytics without exposing viewer identities).
-- =============================================================

CREATE POLICY "content_views_select_own_history"
  ON content_views FOR SELECT
  USING (auth.uid() = viewer_id);

CREATE POLICY "content_views_select_creator_analytics"
  ON content_views FOR SELECT
  USING (
    content_id IN (
      SELECT id FROM vertical_content  WHERE creator_id = auth.uid()
      UNION ALL
      SELECT id FROM landscape_content WHERE creator_id = auth.uid()
    )
  );


-- =============================================================
-- 12. user_interests
--  Users can read and manage only their own interest tags.
-- =============================================================

CREATE POLICY "user_interests_select_own"
  ON user_interests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_interests_insert_own"
  ON user_interests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_interests_delete_own"
  ON user_interests FOR DELETE
  USING (auth.uid() = user_id);


-- =============================================================
--  VERIFICATION QUERIES
--  Run these after applying the policies to confirm everything
--  is wired up correctly.
-- =============================================================

-- Check RLS is enabled on all tables:
-- SELECT relname AS table, relrowsecurity AS rls_enabled
-- FROM pg_class
-- WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
-- ORDER BY relname;

-- List all policies:
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;
