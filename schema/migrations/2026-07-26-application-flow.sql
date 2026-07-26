-- =============================================================
--  Migration: creator application lifecycle
--  (email confirmation → pending review → approval wiring)
--
--  Run in the Supabase SQL editor BEFORE deploying the backend.
--  Idempotent — safe to re-run.
--
--  New lifecycle: unconfirmed → pending → approved | rejected
--    * submissions start 'unconfirmed' with a confirmation token
--    * the emailed confirm link flips them to 'pending'
--    * approval links the matching users row (approved_user_id) and
--      grants role='creator'; if the applicant hasn't signed up yet,
--      awaiting_signup=TRUE and first sign-in applies the role
-- =============================================================

-- ── 1. New application columns ───────────────────────────────
ALTER TABLE creator_applications
  ADD COLUMN IF NOT EXISTS approved_user_id   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS awaiting_signup    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmation_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS confirmed_at       TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS creator_applications_confirmation_token_idx
  ON creator_applications (confirmation_token);

-- Rows that predate confirmation are treated as already confirmed.
UPDATE creator_applications SET confirmed_at = created_at WHERE confirmed_at IS NULL;

-- ── 2. Status vocabulary now includes 'unconfirmed' ──────────
DO $$
DECLARE con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.creator_applications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.creator_applications DROP CONSTRAINT %I', con.conname);
  END LOOP;

  ALTER TABLE public.creator_applications ADD CONSTRAINT creator_applications_status_check
    CHECK (status IN ('unconfirmed', 'pending', 'approved', 'rejected'));
END $$;

-- ── 3. Case-insensitive email matching (approval + sign-in hook) ──
CREATE INDEX IF NOT EXISTS creator_applications_email_lower_idx
  ON creator_applications (LOWER(email));
CREATE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (LOWER(email));

-- ── 4. Unique clerk_user_id — required by the self-healing user
--       creation's ON CONFLICT (skipped if any unique index exists) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'public.users'::regclass
      AND i.indisunique
      AND a.attname = 'clerk_user_id'
  ) THEN
    CREATE UNIQUE INDEX users_clerk_user_id_unique_idx ON users (clerk_user_id);
  END IF;
END $$;

-- ── 5. Legacy column relaxation ──────────────────────────────
-- users.password_hash is NOT NULL from the pre-Clerk auth-shim era but
-- nothing reads or writes it anymore — Clerk owns authentication. Left
-- NOT NULL it would break self-healing user creation at first sign-in
-- (found by the pre-flight query below on 2026-07-26).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ── Verify ───────────────────────────────────────────────────
-- Expect the four new columns:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'creator_applications'
--     AND column_name IN ('approved_user_id','awaiting_signup',
--                         'confirmation_token','confirmed_at');
--
-- PRE-FLIGHT for self-healing user creation — paste me this result:
-- lists users columns that are NOT NULL with no default. The code
-- supplies id, clerk_user_id, email, username, display_name, avatar_url,
-- role, status; anything else in this list would break first-sign-in
-- user creation and needs a default added.
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'users' AND is_nullable = 'NO' AND column_default IS NULL;
