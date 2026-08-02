'use strict';

/**
 * ============================================================
 *  ZUVA ADS — direct-sold advertising routes
 * ============================================================
 *  Mounted at /api/ads in server.js. Talks to the advertisers /
 *  ad_campaigns / ad_creatives / ad_impressions tables added by
 *  schema/migrations/2026-08-01-zuva-ads-schema.sql.
 *
 *  AUDIT NOTES (Part 1 of the task this file was built from) — two
 *  assumptions in the original spec didn't match this codebase, so
 *  this file follows what's actually here instead:
 *
 *   1. There is no routes/ folder anywhere else in this repo and no
 *      "identical pattern" to copy from one — every other endpoint
 *      lives in one big router file, zuva-api.js, mounted directly at
 *      /api in server.js. The one exception, and the actual closest
 *      precedent for a *separate* route file needing DB access, is
 *      services/payouts/webhookRouter.js: a factory function that
 *      takes the shared pg pool as an argument and returns a Router.
 *      This file follows that exact factory pattern.
 *
 *   2. There is no Supabase JS client (@supabase/supabase-js) used
 *      anywhere in this codebase — grepped, zero matches. Every route
 *      talks to Postgres directly via a raw `pg` Pool (see zuva-api.js's
 *      `db = new Pool(...)`), connected with a connection string that
 *      already carries service-role-equivalent privileges and bypasses
 *      RLS entirely (see schema/rls-policies.sql's own header comment).
 *      So "use the service role Supabase client, not the anon client"
 *      for the impression route's campaign update is already true of
 *      every write in this file — there's no separate anon-vs-service
 *      client distinction to make; it's all one pool.
 *
 *  requireAdmin is bridged from server.js exactly like the bridge in
 *  zuva-api.js (`req.app.get('requireAdmin')`) — not re-implemented.
 *  The shared `validate` (422-on-failure) middleware and the
 *  CONTENT_CATEGORIES list are duplicated below rather than imported,
 *  because zuva-api.js only exports { router, pool, writeDoubleEntry }
 *  and this task's instructions said not to modify existing routes —
 *  adding new exports there felt like it crossed that line. Flagging
 *  the duplication risk: if CONTENT_CATEGORIES in zuva-api.js ever
 *  changes, this copy needs updating too.
 *
 *  Geo-targeting semantics (confirmed with the user before writing
 *  this, since the original spec's "prefer... but don't exclude
 *  empty" wording was ambiguous about non-empty non-matching targets):
 *  target_cities/target_countries are a HARD filter when non-empty —
 *  a campaign that set specific cities/countries only serves to those.
 *  An empty (or NULL) target_cities/target_countries runs everywhere.
 *  country is treated identically to city (the original spec listed
 *  country as an accepted query param but never actually used it in
 *  the matching logic — confirmed this was an omission, not
 *  intentional, and extended the same logic to it).
 * ============================================================
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

// Duplicated from zuva-api.js's CONTENT_CATEGORIES — see file header note.
const CONTENT_CATEGORIES = [
  'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
  'discussion_debate', 'interview', 'lifestyle_culture', 'news', 'nature', 'other',
];

const PACKAGE_TIERS = ['starter', 'growth', 'brand'];
const MONTHLY_AMOUNT_USD_BY_TIER = { starter: 19, growth: 59, brand: 149 };
// Midpoints of each tier's stated impressions range.
const IMPRESSIONS_GOAL_BY_TIER = { starter: 6500, growth: 27500, brand: 80000 };

// Duplicated from zuva-api.js's `validate` — same 422-with-errors-array shape.
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    return res.status(422).json({
      error: [...new Set(list.map((e) => e.msg))].join('; '),
      errors: list,
    });
  }
  next();
};

module.exports = function createAdsRouter(pool) {
  const router = express.Router();

  // Bridged from server.js exactly like zuva-api.js's own requireAdmin —
  // real Clerk JWT verification + role === 'admin' DB check.
  function requireAdmin(req, res, next) {
    return req.app.get('requireAdmin')(req, res, next);
  }

  // ============================================================
  //  PUBLIC — GET /api/ads/serve
  //  Called by the video player before every video. Picks the
  //  best-paced eligible campaign for the given content_category/
  //  city/country, then that campaign's active approved creative.
  //  Does NOT increment impressions_delivered — that only happens
  //  once POST /api/ads/impression confirms the ad actually played.
  // ============================================================
  router.get('/serve',
    [
      query('content_category').trim().isIn(CONTENT_CATEGORIES).withMessage('Invalid content_category'),
      query('city').optional().trim().notEmpty().withMessage('city must not be empty if provided'),
      query('country').optional().trim().notEmpty().withMessage('country must not be empty if provided'),
    ],
    validate,
    async (req, res) => {
      const { content_category: contentCategory } = req.query;
      const city = req.query.city || null;
      const country = req.query.country || null;

      try {
        // Hard filter: a campaign with a non-empty target_cities/
        // target_countries only serves to those; empty/NULL means
        // "runs everywhere" and always passes. Tie-break among
        // everything left by pacing — lowest delivered/goal ratio
        // first, so no campaign starves while another over-delivers.
        const { rows: campaignRows } = await pool.query(
          `SELECT id, advertiser_id
           FROM ad_campaigns
           WHERE status = 'active'
             AND period_start <= CURRENT_DATE
             AND period_end >= CURRENT_DATE
             AND impressions_delivered < impressions_goal
             AND target_categories @> ARRAY[$1]::text[]
             AND (
               $2::text IS NULL
               OR target_cities IS NULL
               OR target_cities = '{}'
               OR target_cities @> ARRAY[$2]::text[]
             )
             AND (
               $3::text IS NULL
               OR target_countries IS NULL
               OR target_countries = '{}'
               OR target_countries @> ARRAY[$3]::text[]
             )
           ORDER BY (impressions_delivered::float / NULLIF(impressions_goal, 0)) ASC
           LIMIT 1`,
          [contentCategory, city, country]
        );

        if (!campaignRows.length) {
          return res.json({ ad: null });
        }
        const campaign = campaignRows[0];

        // Multiple approved+active creatives on one campaign is the
        // A/B-testing case (see the `label` column) — no ordering was
        // specified for that case, so this picks one at random for a
        // roughly even split across variants.
        const { rows: creativeRows } = await pool.query(
          `SELECT id, type, file_url, duration_seconds, click_through_url
           FROM ad_creatives
           WHERE campaign_id = $1 AND is_approved = true AND is_active = true
           ORDER BY RANDOM()
           LIMIT 1`,
          [campaign.id]
        );

        if (!creativeRows.length) {
          return res.json({ ad: null });
        }
        const creative = creativeRows[0];

        res.json({
          ad: {
            campaign_id: campaign.id,
            creative_id: creative.id,
            advertiser_id: campaign.advertiser_id,
            type: creative.type,
            file_url: creative.file_url,
            duration_seconds: creative.duration_seconds,
            click_through_url: creative.click_through_url,
            skip_after_seconds: 5,
          },
        });
      } catch (err) {
        console.error('ads/serve error:', err.message);
        res.status(500).json({ error: 'Could not fetch ad' });
      }
    }
  );

  // ============================================================
  //  PUBLIC — POST /api/ads/impression
  //  Fired when an ad actually plays. Rate-limited to 10/min/IP in
  //  server.js — the tightest limiter in this file, since this is
  //  the one write path a malicious client could hammer to inflate
  //  (or, via was_skipped/completed, misreport) an advertiser's
  //  delivered impressions.
  //
  //  Beyond format validation, this also checks that creative_id
  //  actually belongs to campaign_id and that advertiser_id actually
  //  matches the campaign's advertiser_id — not explicitly requested,
  //  but a client that supplied three independently-valid-but-
  //  unrelated UUIDs would otherwise write a row attributing an
  //  impression to the wrong advertiser and inflate the wrong
  //  campaign's counter; the FK constraints alone only check that
  //  each id exists, not that the three cohere. Added in service of
  //  the "prevent impression fraud" goal already stated for this
  //  route, not as unrequested scope.
  // ============================================================
  router.post('/impression',
    [
      body('campaign_id').isUUID().withMessage('campaign_id must be a valid UUID'),
      body('creative_id').isUUID().withMessage('creative_id must be a valid UUID'),
      body('advertiser_id').isUUID().withMessage('advertiser_id must be a valid UUID'),
      body('content_id').optional({ nullable: true }).isUUID().withMessage('content_id must be a valid UUID'),
      body('city').optional({ nullable: true }).isString(),
      body('country').optional({ nullable: true }).isString(),
      body('ad_unit').optional({ nullable: true }).isString(),
      body('was_skipped').optional().isBoolean().withMessage('was_skipped must be a boolean'),
      body('skip_time_seconds').optional({ nullable: true }).isInt({ min: 0 }).withMessage('skip_time_seconds must be a non-negative integer'),
      body('completed').optional().isBoolean().withMessage('completed must be a boolean'),
      body('clicked').optional().isBoolean().withMessage('clicked must be a boolean'),
      body('viewer_session_id').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const {
        campaign_id: campaignId, creative_id: creativeId, advertiser_id: advertiserId,
        content_id: contentId, city, country, ad_unit: adUnit,
        was_skipped: wasSkipped, skip_time_seconds: skipTimeSeconds,
        completed, clicked, viewer_session_id: viewerSessionId,
      } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the campaign row now — it's about to be incremented,
        // and this same query confirms campaign/creative/advertiser
        // actually cohere (see the file-header note above).
        const { rows: campaignRows } = await client.query(
          `SELECT c.id, c.impressions_goal, c.status
           FROM ad_campaigns c
           JOIN ad_creatives cr ON cr.id = $2 AND cr.campaign_id = c.id
           WHERE c.id = $1 AND c.advertiser_id = $3
           FOR UPDATE OF c`,
          [campaignId, creativeId, advertiserId]
        );

        if (!campaignRows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'campaign_id, creative_id, and advertiser_id do not match a real campaign' });
        }

        await client.query(
          `INSERT INTO ad_impressions
             (campaign_id, creative_id, advertiser_id, viewer_session_id, content_id,
              city, country, ad_unit, was_skipped, skip_time_seconds, completed, clicked)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            campaignId, creativeId, advertiserId, viewerSessionId || null, contentId || null,
            city || null, country || null, adUnit || null,
            Boolean(wasSkipped), skipTimeSeconds ?? null, Boolean(completed), Boolean(clicked),
          ]
        );

        const { rows: updatedRows } = await client.query(
          `UPDATE ad_campaigns
           SET impressions_delivered = impressions_delivered + 1
           WHERE id = $1
           RETURNING impressions_delivered, impressions_goal, status`,
          [campaignId]
        );
        const updated = updatedRows[0];

        // impressions_goal is nullable — a plain `>=` comparison against
        // null would coerce to 0 in JS and false-trigger completion, so
        // this checks for null explicitly first.
        if (
          updated.impressions_goal != null &&
          updated.impressions_delivered >= updated.impressions_goal &&
          updated.status !== 'completed'
        ) {
          await client.query(
            `UPDATE ad_campaigns SET status = 'completed' WHERE id = $1`,
            [campaignId]
          );
        }

        await client.query('COMMIT');
        res.json({ success: true });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('ads/impression error:', err.message);
        res.status(500).json({ error: 'Could not record impression' });
      } finally {
        client.release();
      }
    }
  );

  // ============================================================
  //  ADMIN — all routes below require requireAdmin (see the bridge
  //  at the top of this file).
  // ============================================================

  // ── GET /api/ads/admin/advertisers ───────────────────────────
  router.get('/admin/advertisers', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*,
                COUNT(c.id) FILTER (WHERE c.status = 'active')::int AS active_campaigns_count
         FROM advertisers a
         LEFT JOIN ad_campaigns c ON c.advertiser_id = a.id
         GROUP BY a.id
         ORDER BY a.created_at DESC`
      );
      res.json({ success: true, advertisers: rows });
    } catch (err) {
      console.error('ads/admin/advertisers fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch advertisers' });
    }
  });

  // ── POST /api/ads/admin/advertisers ──────────────────────────
  router.post('/admin/advertisers',
    requireAdmin,
    [
      body('business_name').trim().notEmpty().withMessage('business_name is required'),
      body('contact_name').trim().notEmpty().withMessage('contact_name is required'),
      body('email').trim().isEmail().withMessage('A valid email is required'),
      body('phone').optional({ nullable: true }).isString(),
      body('city').trim().notEmpty().withMessage('city is required'),
      body('country').trim().notEmpty().withMessage('country is required'),
      body('business_category').trim().notEmpty().withMessage('business_category is required'),
      body('package_tier').trim().isIn(PACKAGE_TIERS).withMessage('package_tier must be starter, growth, or brand'),
      body('notes').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const {
        business_name: businessName, contact_name: contactName, email, phone,
        city, country, business_category: businessCategory, package_tier: packageTier, notes,
      } = req.body;

      try {
        const { rows } = await pool.query(
          `INSERT INTO advertisers
             (business_name, contact_name, email, phone, city, country,
              business_category, package_tier, status, monthly_amount_usd, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10)
           RETURNING *`,
          [
            businessName, contactName, email, phone || null, city, country,
            businessCategory, packageTier, MONTHLY_AMOUNT_USD_BY_TIER[packageTier], notes || null,
          ]
        );
        res.status(201).json({ success: true, advertiser: rows[0] });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'An advertiser with this email already exists' });
        }
        console.error('ads/admin/advertisers create error:', err.message);
        res.status(500).json({ error: 'Could not create advertiser' });
      }
    }
  );

  // ── PATCH /api/ads/admin/advertisers/:id ─────────────────────
  router.patch('/admin/advertisers/:id',
    requireAdmin,
    [
      param('id').isUUID().withMessage('Invalid advertiser ID'),
      body('status').optional().isIn(['pending', 'active', 'paused', 'cancelled']).withMessage('Invalid status'),
      body('package_tier').optional().isIn(PACKAGE_TIERS).withMessage('package_tier must be starter, growth, or brand'),
      body('monthly_amount_usd').optional().isFloat({ min: 0 }).withMessage('monthly_amount_usd must be a non-negative number'),
      body('notes').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const { status, notes, package_tier: packageTier, monthly_amount_usd: monthlyAmountUsd } = req.body;
      try {
        const { rows } = await pool.query(
          `UPDATE advertisers
           SET status = COALESCE($1, status),
               notes = COALESCE($2, notes),
               package_tier = COALESCE($3, package_tier),
               monthly_amount_usd = COALESCE($4, monthly_amount_usd)
           WHERE id = $5
           RETURNING *`,
          [status || null, notes ?? null, packageTier || null, monthlyAmountUsd ?? null, req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Advertiser not found' });
        res.json({ success: true, advertiser: rows[0] });
      } catch (err) {
        console.error('ads/admin/advertisers update error:', err.message);
        res.status(500).json({ error: 'Could not update advertiser' });
      }
    }
  );

  // ── GET /api/ads/admin/campaigns ─────────────────────────────
  router.get('/admin/campaigns', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*, a.business_name AS advertiser_business_name
         FROM ad_campaigns c
         JOIN advertisers a ON a.id = c.advertiser_id
         ORDER BY c.created_at DESC`
      );
      res.json({ success: true, campaigns: rows });
    } catch (err) {
      console.error('ads/admin/campaigns fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch campaigns' });
    }
  });

  // ── POST /api/ads/admin/campaigns ────────────────────────────
  router.post('/admin/campaigns',
    requireAdmin,
    [
      body('advertiser_id').isUUID().withMessage('advertiser_id must be a valid UUID'),
      body('name').trim().notEmpty().withMessage('name is required'),
      body('package_tier').trim().isIn(PACKAGE_TIERS).withMessage('package_tier must be starter, growth, or brand'),
      body('target_categories').optional().isArray().withMessage('target_categories must be an array'),
      body('target_cities').optional().isArray().withMessage('target_cities must be an array'),
      body('target_countries').optional().isArray().withMessage('target_countries must be an array'),
      body('period_start').isISO8601().withMessage('period_start must be a valid date'),
      body('period_end').isISO8601().withMessage('period_end must be a valid date')
        .custom((value, { req }) => {
          if (new Date(value) <= new Date(req.body.period_start)) {
            throw new Error('period_end must be after period_start');
          }
          return true;
        }),
      body('ad_unit').optional().isIn(['preroll_main', 'flares_preroll', 'homepage_banner']).withMessage('Invalid ad_unit'),
    ],
    validate,
    async (req, res) => {
      const {
        advertiser_id: advertiserId, name, package_tier: packageTier,
        target_categories: targetCategories, target_cities: targetCities, target_countries: targetCountries,
        period_start: periodStart, period_end: periodEnd, ad_unit: adUnit,
      } = req.body;

      try {
        const { rows } = await pool.query(
          `INSERT INTO ad_campaigns
             (advertiser_id, name, status, package_tier, target_categories, target_cities,
              target_countries, impressions_goal, period_start, period_end, ad_unit)
           VALUES ($1, $2, 'pending_creative', $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'preroll_main'))
           RETURNING *`,
          [
            advertiserId, name, packageTier,
            targetCategories || null, targetCities || null, targetCountries || null,
            IMPRESSIONS_GOAL_BY_TIER[packageTier], periodStart, periodEnd, adUnit || null,
          ]
        );
        res.status(201).json({ success: true, campaign: rows[0] });
      } catch (err) {
        if (err.code === '23503') {
          return res.status(400).json({ error: 'advertiser_id does not match a real advertiser' });
        }
        console.error('ads/admin/campaigns create error:', err.message);
        res.status(500).json({ error: 'Could not create campaign' });
      }
    }
  );

  // ── PATCH /api/ads/admin/campaigns/:id ───────────────────────
  router.patch('/admin/campaigns/:id',
    requireAdmin,
    [
      param('id').isUUID().withMessage('Invalid campaign ID'),
      body('status').optional().isIn(['pending_creative', 'active', 'paused', 'completed', 'cancelled']).withMessage('Invalid status'),
      body('target_categories').optional().isArray().withMessage('target_categories must be an array'),
      body('target_cities').optional().isArray().withMessage('target_cities must be an array'),
      body('target_countries').optional().isArray().withMessage('target_countries must be an array'),
      body('period_start').optional().isISO8601().withMessage('period_start must be a valid date'),
      body('period_end').optional().isISO8601().withMessage('period_end must be a valid date'),
      body('impressions_goal').optional().isInt({ min: 0 }).withMessage('impressions_goal must be a non-negative integer'),
    ],
    validate,
    async (req, res) => {
      const {
        status, target_categories: targetCategories, target_cities: targetCities,
        target_countries: targetCountries, period_start: periodStart, period_end: periodEnd,
        impressions_goal: impressionsGoal,
      } = req.body;
      try {
        const { rows } = await pool.query(
          `UPDATE ad_campaigns
           SET status = COALESCE($1, status),
               target_categories = COALESCE($2, target_categories),
               target_cities = COALESCE($3, target_cities),
               target_countries = COALESCE($4, target_countries),
               period_start = COALESCE($5, period_start),
               period_end = COALESCE($6, period_end),
               impressions_goal = COALESCE($7, impressions_goal)
           WHERE id = $8
           RETURNING *`,
          [
            status || null, targetCategories || null, targetCities || null, targetCountries || null,
            periodStart || null, periodEnd || null, impressionsGoal ?? null, req.params.id,
          ]
        );
        if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
        res.json({ success: true, campaign: rows[0] });
      } catch (err) {
        console.error('ads/admin/campaigns update error:', err.message);
        res.status(500).json({ error: 'Could not update campaign' });
      }
    }
  );

  // ── GET /api/ads/admin/campaigns/:id/stats ───────────────────
  router.get('/admin/campaigns/:id/stats',
    requireAdmin,
    [param('id').isUUID().withMessage('Invalid campaign ID')],
    validate,
    async (req, res) => {
      const campaignId = req.params.id;
      try {
        const { rows: campaignRows } = await pool.query(
          `SELECT c.*, a.business_name AS advertiser_business_name
           FROM ad_campaigns c
           JOIN advertisers a ON a.id = c.advertiser_id
           WHERE c.id = $1`,
          [campaignId]
        );
        if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
        const campaign = campaignRows[0];

        const { rows: aggRows } = await pool.query(
          `SELECT
             COUNT(*)::int AS total_impressions,
             COUNT(*) FILTER (WHERE completed)::int AS completed_count,
             COUNT(*) FILTER (WHERE was_skipped)::int AS skipped_count,
             COUNT(*) FILTER (WHERE clicked)::int AS clicked_count
           FROM ad_impressions
           WHERE campaign_id = $1`,
          [campaignId]
        );
        const agg = aggRows[0];
        const total = agg.total_impressions;

        const { rows: byDayRows } = await pool.query(
          `SELECT DATE(created_at) AS day, COUNT(*)::int AS impressions
           FROM ad_impressions
           WHERE campaign_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY DATE(created_at)
           ORDER BY day`,
          [campaignId]
        );

        res.json({
          success: true,
          campaign,
          total_impressions: total,
          completion_rate: total > 0 ? agg.completed_count / total : 0,
          skip_rate: total > 0 ? agg.skipped_count / total : 0,
          click_rate: total > 0 ? agg.clicked_count / total : 0,
          impressions_by_day: byDayRows,
          percent_of_goal_delivered: campaign.impressions_goal
            ? (campaign.impressions_delivered / campaign.impressions_goal) * 100
            : null,
        });
      } catch (err) {
        console.error('ads/admin/campaigns/stats error:', err.message);
        res.status(500).json({ error: 'Could not fetch campaign stats' });
      }
    }
  );

  // ── POST /api/ads/admin/creatives ────────────────────────────
  router.post('/admin/creatives',
    requireAdmin,
    [
      body('campaign_id').isUUID().withMessage('campaign_id must be a valid UUID'),
      body('advertiser_id').isUUID().withMessage('advertiser_id must be a valid UUID'),
      body('type').trim().isIn(['video', 'image']).withMessage('type must be video or image'),
      body('file_url').trim().notEmpty().withMessage('file_url is required'),
      body('cloudflare_asset_id').optional({ nullable: true }).isString(),
      body('duration_seconds').optional({ nullable: true }).isInt({ min: 0 }).withMessage('duration_seconds must be a non-negative integer'),
      body('width').optional({ nullable: true }).isInt({ min: 0 }),
      body('height').optional({ nullable: true }).isInt({ min: 0 }),
      body('click_through_url').optional({ nullable: true }).isString(),
      body('label').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const {
        campaign_id: campaignId, advertiser_id: advertiserId, type, file_url: fileUrl,
        cloudflare_asset_id: cloudflareAssetId, duration_seconds: durationSeconds,
        width, height, click_through_url: clickThroughUrl, label,
      } = req.body;

      try {
        const { rows } = await pool.query(
          `INSERT INTO ad_creatives
             (campaign_id, advertiser_id, type, file_url, cloudflare_asset_id,
              duration_seconds, width, height, click_through_url, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            campaignId, advertiserId, type, fileUrl, cloudflareAssetId || null,
            durationSeconds ?? null, width ?? null, height ?? null, clickThroughUrl || null, label || null,
          ]
        );
        res.status(201).json({ success: true, creative: rows[0] });
      } catch (err) {
        if (err.code === '23503') {
          return res.status(400).json({ error: 'campaign_id or advertiser_id does not match a real row' });
        }
        console.error('ads/admin/creatives create error:', err.message);
        res.status(500).json({ error: 'Could not create creative' });
      }
    }
  );

  // ── PATCH /api/ads/admin/creatives/:id/approve ───────────────
  router.patch('/admin/creatives/:id/approve',
    requireAdmin,
    [param('id').isUUID().withMessage('Invalid creative ID')],
    validate,
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: creativeRows } = await client.query(
          `UPDATE ad_creatives SET is_approved = true WHERE id = $1 RETURNING *`,
          [req.params.id]
        );
        if (!creativeRows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Creative not found' });
        }
        const creative = creativeRows[0];

        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS approved_count FROM ad_creatives
           WHERE campaign_id = $1 AND is_approved = true`,
          [creative.campaign_id]
        );

        let campaignStatus = null;
        if (countRows[0].approved_count === 1) {
          const { rows: campaignRows } = await client.query(
            `UPDATE ad_campaigns SET status = 'active'
             WHERE id = $1 AND status = 'pending_creative'
             RETURNING status`,
            [creative.campaign_id]
          );
          campaignStatus = campaignRows[0]?.status || null;
        }

        if (!campaignStatus) {
          const { rows: currentRows } = await client.query(
            `SELECT status FROM ad_campaigns WHERE id = $1`,
            [creative.campaign_id]
          );
          campaignStatus = currentRows[0]?.status || null;
        }

        await client.query('COMMIT');
        res.json({ success: true, creative, campaign_status: campaignStatus });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('ads/admin/creatives/approve error:', err.message);
        res.status(500).json({ error: 'Could not approve creative' });
      } finally {
        client.release();
      }
    }
  );

  // ── PATCH /api/ads/admin/creatives/:id ────────────────────────
  router.patch('/admin/creatives/:id',
    requireAdmin,
    [
      param('id').isUUID().withMessage('Invalid creative ID'),
      body('is_active').optional().isBoolean().withMessage('is_active must be a boolean'),
      body('click_through_url').optional({ nullable: true }).isString(),
      body('label').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const { is_active: isActive, click_through_url: clickThroughUrl, label } = req.body;
      try {
        const { rows } = await pool.query(
          `UPDATE ad_creatives
           SET is_active = COALESCE($1, is_active),
               click_through_url = COALESCE($2, click_through_url),
               label = COALESCE($3, label)
           WHERE id = $4
           RETURNING *`,
          [isActive ?? null, clickThroughUrl ?? null, label ?? null, req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Creative not found' });
        res.json({ success: true, creative: rows[0] });
      } catch (err) {
        console.error('ads/admin/creatives update error:', err.message);
        res.status(500).json({ error: 'Could not update creative' });
      }
    }
  );

  // ── GET /api/ads/admin/dashboard ─────────────────────────────
  // impressions-this-month/all-time come from ad_impressions (the
  // event log), not from summing ad_campaigns.impressions_delivered —
  // that column is a lifetime-per-campaign counter with no timestamp
  // granularity, so it can't be period-filtered (same lesson as
  // videos.view_count vs watch_events in the earlier analytics work).
  router.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM advertisers WHERE status = 'active') AS active_advertisers_count,
           (SELECT COUNT(*)::int FROM ad_campaigns WHERE status = 'active') AS active_campaigns_count,
           (SELECT COUNT(*)::int FROM ad_impressions
              WHERE created_at >= date_trunc('month', NOW())) AS impressions_this_month,
           (SELECT COUNT(*)::int FROM ad_impressions) AS impressions_all_time,
           (SELECT COALESCE(SUM(monthly_amount_usd), 0) FROM advertisers WHERE status = 'active') AS revenue_this_month,
           (SELECT COALESCE(SUM(
              monthly_amount_usd * (
                EXTRACT(YEAR FROM AGE(NOW(), created_at)) * 12
                + EXTRACT(MONTH FROM AGE(NOW(), created_at))
              )
            ), 0) FROM advertisers) AS revenue_all_time_estimated`
      );

      const { rows: endingSoon } = await pool.query(
        `SELECT c.*, a.business_name AS advertiser_business_name
         FROM ad_campaigns c
         JOIN advertisers a ON a.id = c.advertiser_id
         WHERE c.status = 'active'
           AND c.period_end BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
         ORDER BY c.period_end ASC`
      );

      const { rows: nearlyFulfilled } = await pool.query(
        `SELECT c.*, a.business_name AS advertiser_business_name
         FROM ad_campaigns c
         JOIN advertisers a ON a.id = c.advertiser_id
         WHERE c.status = 'active'
           AND c.impressions_goal IS NOT NULL
           AND c.impressions_delivered >= c.impressions_goal * 0.9
         ORDER BY (c.impressions_delivered::float / NULLIF(c.impressions_goal, 0)) DESC`
      );

      const summary = rows[0];
      res.json({
        success: true,
        active_advertisers_count: summary.active_advertisers_count,
        active_campaigns_count: summary.active_campaigns_count,
        impressions_this_month: summary.impressions_this_month,
        impressions_all_time: summary.impressions_all_time,
        revenue_this_month: Number(summary.revenue_this_month),
        revenue_all_time_estimated: Number(summary.revenue_all_time_estimated),
        campaigns_ending_soon: endingSoon,
        campaigns_nearly_fulfilled: nearlyFulfilled,
      });
    } catch (err) {
      console.error('ads/admin/dashboard error:', err.message);
      res.status(500).json({ error: 'Could not fetch dashboard summary' });
    }
  });

  return router;
};
