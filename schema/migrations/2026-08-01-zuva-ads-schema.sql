-- =============================================================
--  Migration: Zuva Ads — direct-sold advertising schema
--
--  Run in the Supabase SQL editor.
--  Idempotent — safe to re-run.
--
--  Zuva Ads is a direct-sold advertising product for African &
--  Caribbean small businesses (diaspora-facing: an advertiser's city/
--  country is free text like "Toronto"/"Canada", not the ISO
--  users.country_code format — advertisers aren't Zuva users). It is
--  separate from, and does not depend on, any future programmatic
--  (GAM/AdSense) integration.
--
--  Table relationships (parent → child, all ON DELETE CASCADE):
--
--    advertisers
--      │  A business account. One advertiser can run multiple
--      │  campaigns over time (e.g. a new campaign each month).
--      ▼
--    ad_campaigns
--      │  One paid flight: a package tier, a targeting spec (content
--      │  categories / cities / countries), an impressions goal, and
--      │  a period_start/period_end window. advertiser_id is
--      │  denormalized onto ad_creatives and ad_impressions below
--      │  (not just reachable via campaign_id) so both tables can be
--      │  queried/filtered per-advertiser without a join back through
--      │  ad_campaigns.
--      ▼
--    ad_creatives
--      │  The actual video/image asset(s) for a campaign — a campaign
--      │  can have more than one for A/B testing (the `label` column).
--      │  Dexter must set is_approved = true before a campaign goes
--      │  active; is_active lets a creative be paused independently
--      │  of the campaign (e.g. swapping in a "Version B").
--      ▼
--    ad_impressions
--      One row per ad view event, referencing both the campaign and
--      the specific creative shown. viewer_session_id is an anonymous
--      session identifier — this table intentionally has NO user_id/
--      viewer_id column, so impressions can never be tied back to a
--      Zuva account.
--
--  Column-vocabulary note (flagging, not enforcing): ad_campaigns.
--  target_categories is a free TEXT[], but the example values given
--  for this migration ("food_beverage", "lifestyle") don't match
--  videos.content_category's actual vocabulary (entertainment, music,
--  comedy, drama_series, documentary, discussion_debate, interview,
--  lifestyle_culture, news, nature, other — see
--  2026-07-26-feed-ranking.sql / 2026-07-26-categories-and-ai-
--  disclosure.sql). "food_beverage"/"hair_beauty"/etc. are this
--  migration's own business_category vocabulary (what kind of
--  business the advertiser runs), not a content category. Similarly
--  target_cities/target_countries store free-text names ("Toronto",
--  "Canada"), not users.country_code's 2-letter ISO format. None of
--  this blocks the migration — target_categories/target_cities/
--  target_countries have no CHECK constraint, exactly as specified —
--  but whatever ad-matching logic gets built against these arrays
--  will need to reconcile both vocabulary gaps against the viewer/
--  content data it's matching against.
-- =============================================================


-- ── 1. advertisers ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advertisers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name           TEXT NOT NULL,
  contact_name            TEXT NOT NULL,
  email                   TEXT NOT NULL UNIQUE,
  phone                   TEXT,
  city                    TEXT NOT NULL,
  country                 TEXT NOT NULL,
  business_category       TEXT NOT NULL CHECK (business_category IN (
                              'food_beverage', 'hair_beauty', 'fashion_apparel',
                              'events_entertainment', 'professional_services',
                              'money_remittance', 'education', 'africa_based_brand', 'other'
                            )),
  package_tier            TEXT NOT NULL CHECK (package_tier IN ('starter', 'growth', 'brand')),
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'paused', 'cancelled')),
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  monthly_amount_usd      NUMERIC(10,2) NOT NULL,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS advertisers_status_idx ON advertisers (status);

-- No separate index on email: the UNIQUE constraint above already
-- creates one (a duplicate explicit index would just waste writes).


-- ── 2. ad_campaigns ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id           UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending_creative'
                            CHECK (status IN (
                              'pending_creative', 'active', 'paused', 'completed', 'cancelled'
                            )),
  package_tier            TEXT NOT NULL CHECK (package_tier IN ('starter', 'growth', 'brand')),
  target_categories       TEXT[],
  target_cities           TEXT[],
  target_countries        TEXT[],
  impressions_goal        INTEGER,
  impressions_delivered   INTEGER NOT NULL DEFAULT 0,
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  ad_unit                 TEXT NOT NULL DEFAULT 'preroll_main'
                            CHECK (ad_unit IN ('preroll_main', 'flares_preroll', 'homepage_banner')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_campaigns_advertiser_id_idx ON ad_campaigns (advertiser_id);
CREATE INDEX IF NOT EXISTS ad_campaigns_status_idx ON ad_campaigns (status);
-- Composite, not two separate indexes — period_start/period_end are
-- queried together as a date-range pair ("campaigns active during X").
CREATE INDEX IF NOT EXISTS ad_campaigns_period_idx ON ad_campaigns (period_start, period_end);


-- ── 3. ad_creatives ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ad_creatives (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  advertiser_id           UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  type                    TEXT NOT NULL CHECK (type IN ('video', 'image')),
  file_url                TEXT NOT NULL,
  cloudflare_asset_id     TEXT,
  duration_seconds        INTEGER,
  width                   INTEGER,
  height                  INTEGER,
  click_through_url       TEXT,
  is_approved             BOOLEAN NOT NULL DEFAULT FALSE,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  label                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_creatives_campaign_id_idx ON ad_creatives (campaign_id);


-- ── 4. ad_impressions ────────────────────────────────────────
-- Intentionally no user_id/viewer_id column — viewer_session_id is an
-- anonymous, session-scoped identifier only.

CREATE TABLE IF NOT EXISTS ad_impressions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  creative_id             UUID NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  advertiser_id           UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  viewer_session_id       TEXT,
  content_id              UUID,
  city                    TEXT,
  country                 TEXT,
  ad_unit                 TEXT,
  was_skipped             BOOLEAN DEFAULT FALSE,
  skip_time_seconds       INTEGER,
  completed               BOOLEAN DEFAULT FALSE,
  clicked                 BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_impressions_campaign_id_idx ON ad_impressions (campaign_id);
CREATE INDEX IF NOT EXISTS ad_impressions_advertiser_id_idx ON ad_impressions (advertiser_id);
CREATE INDEX IF NOT EXISTS ad_impressions_created_at_idx ON ad_impressions (created_at);


-- ── 5. updated_at trigger ────────────────────────────────────
-- No updated_at-maintaining trigger exists anywhere else in this
-- schema yet (grepped zuva-api.js and every migration — nothing), so
-- this is a new, simple one, styled after the existing recount_*
-- trigger functions in 2026-07-26-engagement.sql (CREATE OR REPLACE
-- FUNCTION ... RETURNS TRIGGER, DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER for idempotent re-runs).

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_advertisers_updated_at ON advertisers;
CREATE TRIGGER trg_advertisers_updated_at
  BEFORE UPDATE ON advertisers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_ad_campaigns_updated_at ON ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_updated_at
  BEFORE UPDATE ON ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 6. RLS ────────────────────────────────────────────────────
-- Matches schema/rls-policies.sql's established pattern: the Express
-- backend connects with the service_role key, which bypasses RLS
-- entirely, so these policies only guard direct anon/authenticated
-- Supabase client calls (which nothing in this app makes today — see
-- that file's own header comment. In practice this is defense-in-
-- depth, not live-enforced traffic control, same caveat as every
-- other table's RLS in this codebase).

ALTER TABLE advertisers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_creatives  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_impressions ENABLE ROW LEVEL SECURITY;

-- advertisers / ad_campaigns / ad_creatives: service-role only.
-- Deliberately NO policies of any kind (not even SELECT) — with RLS
-- enabled and zero policies defined, Postgres denies all access to
-- every role except service_role (which bypasses RLS altogether).
-- This is the same "no client-facing write policies" mechanism
-- rls-policies.sql already relies on for backend-only writes; here
-- it's applied to reads too, since none of this data is public.

-- ad_impressions: service role has full access via the same RLS-
-- bypass as above. On top of that, allow the `authenticated` Supabase
-- role to INSERT — this is the one exception, for a frontend impression-
-- tracking beacon that fires directly rather than through the Express
-- backend. NOTE: "their own impression records" (as specified) can't
-- actually be enforced by a WITH CHECK clause here, because this table
-- deliberately has no user_id/viewer_id column to check auth.uid()
-- against (see the table comment above) — viewer_session_id is an
-- anonymous string, not a Supabase Auth identity. So this policy
-- allows any authenticated caller to insert any impression row; it
-- cannot be scoped tighter than that without adding an identifying
-- column, which would undercut the anonymity this table is designed
-- for. Flagging rather than silently narrowing or widening the ask:
-- if signed-out/anonymous viewers (the homepage and /feed are both
-- browsable signed-out) also need to fire impressions, this policy
-- as written will reject them — let me know if an `anon` INSERT
-- policy should be added too.
DROP POLICY IF EXISTS "ad_impressions_insert_authenticated" ON ad_impressions;
CREATE POLICY "ad_impressions_insert_authenticated"
  ON ad_impressions FOR INSERT
  TO authenticated
  WITH CHECK (true);


-- ── Verify ───────────────────────────────────────────────────
-- Expect 4 rows:
--   SELECT tablename FROM pg_tables
--   WHERE tablename IN ('advertisers', 'ad_campaigns', 'ad_creatives', 'ad_impressions');
--
-- Expect 4 rows, all relrowsecurity = true:
--   SELECT relname AS table, relrowsecurity AS rls_enabled
--   FROM pg_class
--   WHERE relname IN ('advertisers', 'ad_campaigns', 'ad_creatives', 'ad_impressions');
--
-- Expect 2 rows:
--   SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_advertisers%' OR tgname LIKE 'trg_ad_campaigns%';
--
-- Expect 1 row:
--   SELECT policyname FROM pg_policies WHERE tablename = 'ad_impressions';
