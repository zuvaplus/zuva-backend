-- =============================================================
--  Migration: wallet self-healing support + backfill
--
--  Run in Supabase BEFORE deploying the ensureWallet change.
--  1. Unique index on wallets(user_id) — required by the code's
--     INSERT ... ON CONFLICT (user_id), and enforces the
--     one-wallet-per-user invariant the whole ledger assumes.
--  2. Backfill: zero-balance wallets for every existing user
--     without one (e.g. rows inserted manually before any wallet
--     provisioning existed).
--  Idempotent — safe to re-run.
-- =============================================================

-- Pre-check: this must return 0 rows, or the unique index cannot be
-- created (duplicate wallets for one user need manual merging first).
--   SELECT user_id, COUNT(*) FROM wallets GROUP BY user_id HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_id_key ON wallets (user_id);

INSERT INTO wallets
  (id, user_id, balance_suns, total_earned_suns, total_spent_suns, total_cashed_out_suns)
SELECT gen_random_uuid(), u.id, 0, 0, 0, 0
FROM users u
LEFT JOIN wallets w ON w.user_id = u.id
WHERE w.id IS NULL
  AND u.deleted_at IS NULL;

-- ── Verify ───────────────────────────────────────────────────
-- Expect 0:
--   SELECT COUNT(*) FROM users u
--   LEFT JOIN wallets w ON w.user_id = u.id
--   WHERE w.id IS NULL AND u.deleted_at IS NULL;
