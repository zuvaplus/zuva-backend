-- =============================================================
--  Migration: wallets.total_purchased_suns + transaction_type enum value
--
--  Run in the Supabase SQL editor.
--  Idempotent — safe to re-run.
--
--  total_purchased_suns tracks Suns bought via Stripe, kept separate
--  from total_earned_suns (creator tip earnings) so a future wallet-
--  history UI can distinguish the two. Same INTEGER type as every
--  other wallet counter — confirmed directly against the live DB:
--    SELECT column_name, data_type, numeric_precision, numeric_scale
--    FROM information_schema.columns WHERE table_name = 'wallets'
--    AND column_name IN ('balance_suns','total_earned_suns',
--      'total_spent_suns','total_cashed_out_suns');
--  returned `integer` (precision 32, scale 0) for all four.
-- =============================================================

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS total_purchased_suns INTEGER NOT NULL DEFAULT 0;

-- ledger_entries.type is a native transaction_type enum (per its own
-- code comment in zuva-api.js). 'sun_purchase' was already used by the
-- pre-Chimoney-removal purchase flow (see git history, commit 8b8305a),
-- so this value almost certainly already exists — IF NOT EXISTS makes
-- this a safe no-op either way.
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'sun_purchase';

-- ── Verify ───────────────────────────────────────────────────
-- Expect 1 row:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'wallets' AND column_name = 'total_purchased_suns';
--
-- Expect 'sun_purchase' present in the list:
--   SELECT enumlabel FROM pg_enum
--   WHERE enumtypid = 'transaction_type'::regtype
--   ORDER BY enumlabel;
