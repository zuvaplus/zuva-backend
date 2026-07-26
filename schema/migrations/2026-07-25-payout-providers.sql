-- =============================================================
--  Migration: provider-adapter payout architecture
--  (Chimoney → Flutterwave / Mukuru / WiPay / Wise)
--
--  Run this in the Supabase SQL editor BEFORE deploying the
--  backend change — the new cashout flow writes provider,
--  idempotency_key, and recipient name columns on every payout.
--  Chimoney-era columns are intentionally kept for historical rows.
--  The whole file is idempotent — safe to re-run.
-- =============================================================

-- ── 1. New payout columns ────────────────────────────────────
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS provider             TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference   TEXT,
  ADD COLUMN IF NOT EXISTS provider_response    JSONB,
  ADD COLUMN IF NOT EXISTS idempotency_key      UUID,
  ADD COLUMN IF NOT EXISTS recipient_first_name TEXT,
  ADD COLUMN IF NOT EXISTS recipient_last_name  TEXT;

-- One payout attempt per idempotency key; webhooks look payouts up by it.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_idempotency_key_idx
  ON payouts (idempotency_key);

-- ── 2. Relax FX columns ──────────────────────────────────────
-- The new flow initiates payouts in USD and lets the provider convert,
-- so local amount / FX rate are unknown at insert time.
ALTER TABLE payouts ALTER COLUMN local_currency_amount DROP NOT NULL;
ALTER TABLE payouts ALTER COLUMN exchange_rate         DROP NOT NULL;

-- ── 3. Allow the new status lifecycle ────────────────────────
-- New flow: pending → processing → completed | failed.
-- Handles both storage shapes without needing to know which one exists:
--   * text/varchar column → drop any CHECK mentioning status, add ours
--   * enum column         → add any missing enum values
DO $$
DECLARE
  col_type TEXT;
  con      RECORD;
BEGIN
  SELECT atttypid::regtype::text INTO col_type
  FROM pg_attribute
  WHERE attrelid = 'public.payouts'::regclass
    AND attname = 'status'
    AND NOT attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION 'payouts.status column not found';
  END IF;

  IF col_type IN ('text', 'character varying') THEN
    FOR con IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.payouts'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE public.payouts DROP CONSTRAINT %I', con.conname);
    END LOOP;

    ALTER TABLE public.payouts ADD CONSTRAINT payouts_status_check
      CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
  ELSE
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', col_type, 'pending');
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', col_type, 'processing');
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', col_type, 'completed');
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', col_type, 'failed');
  END IF;
END $$;

-- ── Verify (run after; expect 6 rows and one constraint row) ─
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'payouts'
--    AND column_name IN ('provider','provider_reference','provider_response',
--                        'idempotency_key','recipient_first_name','recipient_last_name');
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.payouts'::regclass AND contype = 'c'
--    AND pg_get_constraintdef(oid) ILIKE '%status%';
