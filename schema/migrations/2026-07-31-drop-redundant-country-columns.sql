-- =============================================================
--  Migration: drop redundant users.country / users.country_name
--
--  Run in the Supabase SQL editor.
--  Idempotent — safe to re-run.
--
--  These two columns were added directly via the Supabase SQL editor
--  in preparation for the admin analytics routes, then judged redundant
--  with the existing users.country_code (2-letter ISO, already the
--  join key for feed ranking, /api/channel/update, and /api/admin/users).
--  Analytics uses country_code for grouping and derives the display
--  name from a hardcoded Node mapping instead of a DB column — see the
--  COUNTRY_NAMES map in zuva-api.js.
-- =============================================================

ALTER TABLE users DROP COLUMN IF EXISTS country;
ALTER TABLE users DROP COLUMN IF EXISTS country_name;

-- ── Verify ───────────────────────────────────────────────────
-- Expect 0 rows:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name IN ('country', 'country_name');
