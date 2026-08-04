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
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const { randomUUID } = require('crypto');

// Duplicated from zuva-api.js's CONTENT_CATEGORIES — see file header note.
const CONTENT_CATEGORIES = [
  'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
  'discussion_debate', 'interview', 'lifestyle_culture', 'news', 'nature', 'other',
];

const PACKAGE_TIERS = ['starter', 'growth', 'brand'];
const MONTHLY_AMOUNT_USD_BY_TIER = { starter: 19, growth: 59, brand: 149 };
// Midpoints of each tier's stated impressions range.
const IMPRESSIONS_GOAL_BY_TIER = { starter: 6500, growth: 27500, brand: 80000 };

// Same 9 values as the DB CHECK constraint on advertisers.business_category
// (schema/migrations/2026-08-01-zuva-ads-schema.sql). The existing POST
// /admin/advertisers route below only validates .notEmpty() on this field
// and leans on the DB constraint to reject bad values — not modified here
// (existing route), but these new /advertise/* routes validate against the
// real list up front for a cleaner 422 instead of a DB-constraint 500.
const BUSINESS_CATEGORIES = [
  'food_beverage', 'hair_beauty', 'fashion_apparel', 'events_entertainment',
  'professional_services', 'money_remittance', 'education', 'africa_based_brand', 'other',
];

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

// ============================================================
//  /advertise page support — Nodemailer, Stripe, rate limiters
// ============================================================
//  AUDIT NOTES (this section's own "Part 1"):
//
//   1. FRONTEND_URL vs APP_URL — the task asked for a new FRONTEND_URL
//      env var for building the Stripe success/cancel URLs, but
//      zuva-api.js already has APP_URL serving exactly that purpose
//      (with a `|| 'https://zuva.tv'` fallback — see its creator-signup
//      confirmation-link usage). Reused APP_URL instead of introducing a
//      second, differently-named env var for the same concept.
//
//   2. Nodemailer — duplicated (mailTransport, sendMail, escapeHtml,
//      brandedEmailHtml) rather than imported from zuva-api.js, same
//      reasoning as the CONTENT_CATEGORIES duplication above: zuva-api.js
//      doesn't export these, and adding new exports there felt like
//      modifying an existing file's surface for this task's purposes.
//
//   3. Stripe webhook raw body — the task assumed no raw-body handling
//      exists yet and asked for a route-specific express.raw() mounted
//      before the JSON middleware. One already exists, just not via
//      express.raw(): server.js's global `express.json({ verify: (req,
//      _res, buf) => { req.rawBody = buf; } })` captures the exact raw
//      bytes of every request body before parsing — the same mechanism
//      services/payouts/webhookRouter.js already relies on for its own
//      signature checks. The webhook route below uses req.rawBody
//      directly; no body-parsing middleware changes were needed anywhere.
//
//   4. Rate limiting — the original ads-routes task had explicit "mount
//      in server.js" / "add to rateLimiter.js" instructions; this one
//      doesn't, and "do not modify any existing pages, routes, or
//      components" is stated as a hard constraint here. So the two new
//      limiters below are defined locally and applied route-level,
//      rather than centralized in src/middleware/rateLimiter.js.
//
//  Required environment variables:
//    Backend:  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//              STRIPE_PRICE_ID_STARTER, STRIPE_PRICE_ID_GROWTH,
//              STRIPE_PRICE_ID_BRAND (APP_URL already exists — see note 1)
//    Frontend: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (used only as a
//              presence check to show/hide the card-payment option —
//              Stripe Checkout is a hosted redirect, so the frontend
//              never actually calls the Stripe SDK with this key)
// ============================================================

const APP_URL = process.env.APP_URL || 'https://zuva.tv';

let mailTransport = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
} else {
  console.error('[ads/mail] GMAIL_USER / GMAIL_APP_PASSWORD not set — Zuva Ads emails will not be sent.');
}

// Never throws — a broken mail setup must not fail the request that
// triggered it (same contract as zuva-api.js's sendAdminEmail/sendApplicantEmail).
async function sendMail(to, subject, htmlBody) {
  if (!mailTransport) {
    console.error(`[ads/mail] Skipping email "${subject}" to ${to} — mail transport not configured.`);
    return;
  }
  try {
    await mailTransport.sendMail({ from: process.env.GMAIL_USER, to, subject, html: htmlBody });
  } catch (err) {
    console.error(`[ads/mail] Failed to send email "${subject}" to ${to}:`, err.message);
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same branded shell as zuva-api.js's brandedEmailHtml (duplicated — see
// the audit note above). Callers must escapeHtml() any interpolated
// user-supplied content themselves.
function brandedEmailHtml({ heading, paragraphs, ctaText, ctaUrl }) {
  const cta = ctaText && ctaUrl
    ? `<tr><td style="padding:14px 0 6px;">
         <a href="${ctaUrl}" style="display:inline-block;background:#f37b0d;color:#000000;font-weight:bold;font-size:14px;text-decoration:none;padding:13px 30px;border-radius:10px;">${ctaText}</a>
       </td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:36px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#0d0d0d;border:1px solid rgba(243,123,13,0.3);border-radius:16px;padding:36px 32px;font-family:Arial,Helvetica,sans-serif;text-align:left;">
        <tr><td style="color:#f37b0d;font-size:22px;font-weight:bold;padding-bottom:6px;">Zuva.tv ☀️</td></tr>
        <tr><td style="color:#ffffff;font-size:19px;font-weight:bold;padding-bottom:14px;">${heading}</td></tr>
        ${paragraphs.map((p) => `<tr><td style="color:#b3b3b3;font-size:14px;line-height:1.65;padding-bottom:12px;">${p}</td></tr>`).join('')}
        ${cta}
        <tr><td style="color:#555555;font-size:11px;line-height:1.5;padding-top:22px;border-top:1px solid rgba(255,255,255,0.06);">
          Zuva.tv — African &amp; Caribbean streaming, powered by the Suns economy.<br/>
          If this email wasn't meant for you, you can safely ignore it.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// undefined (not a thrown error) when STRIPE_SECRET_KEY isn't set —
// routes below check for this and return a clear 503 instead of
// crashing the module at require time, mirroring mailTransport above.
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const STRIPE_PRICE_ID_BY_TIER = {
  starter: process.env.STRIPE_PRICE_ID_STARTER,
  growth: process.env.STRIPE_PRICE_ID_GROWTH,
  brand: process.env.STRIPE_PRICE_ID_BRAND,
};

const advertiseInquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many inquiries, please try again later.' },
});

const advertiseCheckoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts, please try again later.' },
});

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
        `SELECT c.*, a.business_name AS advertiser_business_name,
                EXISTS (
                  SELECT 1 FROM ad_creatives cr
                  WHERE cr.campaign_id = c.id AND cr.is_approved = true
                ) AS has_approved_creative
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

  // ── GET /api/ads/admin/creatives ─────────────────────────────
  router.get('/admin/creatives', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cr.id, cr.label, cr.type, cr.file_url, cr.cloudflare_asset_id,
                cr.duration_seconds, cr.click_through_url, cr.is_approved,
                cr.is_active, cr.created_at,
                c.id AS campaign_id, c.name AS campaign_name,
                a.id AS advertiser_id, a.business_name AS advertiser_name
         FROM ad_creatives cr
         JOIN ad_campaigns c ON c.id = cr.campaign_id
         JOIN advertisers a ON a.id = c.advertiser_id
         ORDER BY cr.created_at DESC`
      );
      res.json({ success: true, creatives: rows });
    } catch (err) {
      console.error('ads/admin/creatives fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch creatives' });
    }
  });

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

  // ============================================================
  //  PUBLIC — POST /api/ads/advertise/inquiry
  //  The /advertise page's "Get Payment Link" (mobile money / African
  //  bank transfer) path. No Flutterwave API integration exists yet —
  //  this creates a pending advertiser row and emails Dexter to send a
  //  Flutterwave payment link by hand within 24h, exactly as specced.
  // ============================================================
  router.post('/advertise/inquiry',
    advertiseInquiryLimiter,
    [
      body('business_name').trim().notEmpty().withMessage('business_name is required'),
      body('contact_name').trim().notEmpty().withMessage('contact_name is required'),
      body('email').trim().isEmail().withMessage('A valid email is required'),
      body('phone').optional({ nullable: true }).isString(),
      body('city').trim().notEmpty().withMessage('city is required'),
      body('country').trim().notEmpty().withMessage('country is required'),
      body('business_category').trim().isIn(BUSINESS_CATEGORIES).withMessage('Invalid business_category'),
      body('package_tier').trim().isIn(PACKAGE_TIERS).withMessage('package_tier must be starter, growth, or brand'),
      body('referral_source').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      const {
        business_name: businessName, contact_name: contactName, email, phone,
        city, country, business_category: businessCategory, package_tier: packageTier,
        referral_source: referralSource,
      } = req.body;

      try {
        await pool.query(
          `INSERT INTO advertisers
             (business_name, contact_name, email, phone, city, country,
              business_category, package_tier, status, monthly_amount_usd, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
          [
            businessName, contactName, email, phone || null, city, country,
            businessCategory, packageTier, MONTHLY_AMOUNT_USD_BY_TIER[packageTier],
            // advertisers has no dedicated referral_source column — folded
            // into notes rather than dropping data the form explicitly collected.
            referralSource ? `Referral source: ${referralSource}` : null,
          ]
        );

        const safeBusinessName = escapeHtml(businessName);
        const safeContactName = escapeHtml(contactName);

        sendMail(
          'hello@zuva.tv',
          'New Zuva Ads inquiry — payment link requested',
          brandedEmailHtml({
            heading: 'New Zuva Ads inquiry — payment link requested',
            paragraphs: [
              'Please send a Flutterwave payment link within 24 hours.',
              `<strong>Business:</strong> ${safeBusinessName}<br/>` +
              `<strong>Contact:</strong> ${safeContactName} (${escapeHtml(email)})<br/>` +
              `<strong>Phone:</strong> ${escapeHtml(phone || 'Not provided')}<br/>` +
              `<strong>Location:</strong> ${escapeHtml(city)}, ${escapeHtml(country)}<br/>` +
              `<strong>Category:</strong> ${escapeHtml(businessCategory)}<br/>` +
              `<strong>Package:</strong> ${escapeHtml(packageTier)} ($${MONTHLY_AMOUNT_USD_BY_TIER[packageTier]}/month)<br/>` +
              `<strong>Referral source:</strong> ${escapeHtml(referralSource || 'Not provided')}`,
            ],
          })
        );

        sendMail(
          email,
          'Thank you for your interest in Zuva Ads',
          brandedEmailHtml({
            heading: `Thanks, ${safeContactName}!`,
            paragraphs: [
              `We have received your inquiry for the <strong>${escapeHtml(packageTier)}</strong> package and will send your payment link to this email within 24 hours.`,
              'Questions? Reply to this email or contact <a href="mailto:hello@zuva.tv" style="color:#f37b0d;">hello@zuva.tv</a>.',
            ],
          })
        );

        res.json({ success: true, message: 'Inquiry received' });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'An advertiser with this email already exists' });
        }
        console.error('ads/advertise/inquiry error:', err.message);
        res.status(500).json({ error: 'Could not submit inquiry' });
      }
    }
  );

  // ============================================================
  //  PUBLIC — POST /api/ads/advertise/stripe-checkout
  //  The /advertise page's "Pay with Card" path. No advertiser row is
  //  created here — only once the webhook below confirms payment.
  //  Business details ride along as Checkout Session metadata.
  // ============================================================
  router.post('/advertise/stripe-checkout',
    advertiseCheckoutLimiter,
    [
      body('business_name').trim().notEmpty().withMessage('business_name is required'),
      body('contact_name').trim().notEmpty().withMessage('contact_name is required'),
      body('email').trim().isEmail().withMessage('A valid email is required'),
      body('phone').optional({ nullable: true }).isString(),
      body('city').trim().notEmpty().withMessage('city is required'),
      body('country').trim().notEmpty().withMessage('country is required'),
      body('business_category').trim().isIn(BUSINESS_CATEGORIES).withMessage('Invalid business_category'),
      body('package_tier').trim().isIn(PACKAGE_TIERS).withMessage('package_tier must be starter, growth, or brand'),
      body('referral_source').optional({ nullable: true }).isString(),
      // Client-generated, reused across retries of the same checkout
      // attempt (see AdvertisePaymentModal.tsx) — optional so older
      // clients/direct API callers don't break; falls back to a
      // server-generated key (with a warning) that loses retry
      // protection for that one request but still degrades safely.
      body('idempotency_key').optional({ nullable: true }).isString(),
    ],
    validate,
    async (req, res) => {
      if (!stripe) {
        return res.status(503).json({ error: 'Card payments are not configured yet — use the payment-link option instead.' });
      }

      const {
        business_name: businessName, contact_name: contactName, email, phone,
        city, country, business_category: businessCategory, package_tier: packageTier,
        referral_source: referralSource, idempotency_key: idempotencyKey,
      } = req.body;

      const priceId = STRIPE_PRICE_ID_BY_TIER[packageTier];
      if (!priceId) {
        console.error(`ads/advertise/stripe-checkout: no STRIPE_PRICE_ID_* configured for tier "${packageTier}"`);
        return res.status(503).json({ error: 'Card payments for this package are not configured yet — use the payment-link option instead.' });
      }

      let idKey = idempotencyKey;
      if (!idKey) {
        console.warn('ads/advertise/stripe-checkout: no idempotency_key from client — generating a server-side one (loses retry protection for this request)');
        idKey = randomUUID();
      }

      try {
        // Two distinct derived keys, not one shared key — reusing the
        // exact same idempotency key across two different Stripe API
        // calls makes the second call fail with a "keys can only be
        // used once, and the parameters do not match" error.
        const customer = await stripe.customers.create({
          email,
          name: businessName,
          phone: phone || undefined,
        }, { idempotencyKey: `${idKey}-customer` });

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customer.id,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${APP_URL}/advertise/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${APP_URL}/advertise`,
          metadata: {
            business_name: businessName,
            contact_name: contactName,
            // Not in the task's literal metadata list, but phone has
            // nowhere else to travel to the webhook below, and the
            // advertisers.phone column would otherwise always end up
            // null for every card-paying advertiser.
            phone: phone || '',
            city,
            country,
            business_category: businessCategory,
            package_tier: packageTier,
            referral_source: referralSource || '',
          },
        }, { idempotencyKey: `${idKey}-checkout` });

        res.json({ url: session.url });
      } catch (err) {
        console.error('ads/advertise/stripe-checkout error:', err.message);
        res.status(500).json({ error: 'Could not start checkout' });
      }
    }
  );

  // ============================================================
  //  PUBLIC — POST /api/ads/advertise/webhook
  //  Stripe webhook. checkout.session.completed activates the
  //  advertiser; customer.subscription.deleted cancels them and their
  //  active campaigns. See the audit note above this file's Nodemailer/
  //  Stripe section for why no new raw-body middleware was needed.
  // ============================================================
  router.post('/advertise/webhook', async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('ads/advertise/webhook: Stripe not configured');
      return res.status(400).json({ error: 'Webhook not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('ads/advertise/webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};
        const packageTier = meta.package_tier;
        const monthlyAmountUsd = MONTHLY_AMOUNT_USD_BY_TIER[packageTier] ?? null;
        const customerEmail = session.customer_details?.email || session.customer_email;

        if (!customerEmail || !packageTier || !monthlyAmountUsd) {
          console.error('ads/advertise/webhook: checkout.session.completed missing required metadata/email', {
            sessionId: session.id, meta,
          });
        } else {
          // Stripe documents webhook delivery as at-least-once, so a
          // redelivered event must not 500 on advertisers.email's UNIQUE
          // constraint — upsert to the same end state instead of a plain INSERT.
          await pool.query(
            `INSERT INTO advertisers
               (business_name, contact_name, email, phone, city, country,
                business_category, package_tier, status, stripe_customer_id,
                stripe_subscription_id, monthly_amount_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11)
             ON CONFLICT (email) DO UPDATE SET
               status = 'active',
               stripe_customer_id = EXCLUDED.stripe_customer_id,
               stripe_subscription_id = EXCLUDED.stripe_subscription_id,
               package_tier = EXCLUDED.package_tier,
               monthly_amount_usd = EXCLUDED.monthly_amount_usd`,
            [
              meta.business_name || 'Unknown business', meta.contact_name || 'Unknown contact',
              customerEmail, meta.phone || null, meta.city || null, meta.country || null,
              meta.business_category || 'other', packageTier,
              session.customer, session.subscription, monthlyAmountUsd,
            ]
          );

          const safeBusinessName = escapeHtml(meta.business_name || 'your business');

          sendMail(
            customerEmail,
            'Welcome to Zuva Ads — next steps',
            brandedEmailHtml({
              heading: 'Welcome to Zuva Ads!',
              paragraphs: [
                `Payment confirmed for <strong>${safeBusinessName}</strong>. Thank you for advertising with Zuva.`,
                'You will receive a creative upload link within 24 hours. Your campaign goes live within 48 hours of creative approval.',
                'Questions? Contact <a href="mailto:hello@zuva.tv" style="color:#f37b0d;">hello@zuva.tv</a>.',
              ],
            })
          );

          sendMail(
            'hello@zuva.tv',
            'New Zuva Ads subscriber',
            brandedEmailHtml({
              heading: 'New Zuva Ads subscriber',
              paragraphs: [
                `<strong>${safeBusinessName}</strong> — ${escapeHtml(packageTier)} — ${escapeHtml(meta.city || '')}, ${escapeHtml(meta.country || '')}.`,
                'Check /admin to create their campaign.',
              ],
            })
          );
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const { rows } = await pool.query(
          `UPDATE advertisers SET status = 'cancelled' WHERE stripe_customer_id = $1 RETURNING id`,
          [subscription.customer]
        );
        if (rows.length) {
          await pool.query(
            `UPDATE ad_campaigns SET status = 'cancelled' WHERE advertiser_id = $1 AND status = 'active'`,
            [rows[0].id]
          );
        }
      } else if (event.type === 'invoice.payment_failed') {
        // Notification-only, deliberately not auto-pausing the advertiser
        // or their campaigns: Stripe already retries a failed renewal on
        // its own schedule before eventually firing
        // customer.subscription.deleted if every retry fails. Auto-pausing
        // here (and resuming on a later invoice.payment_succeeded, which
        // isn't handled either) would need to be built and tested as a
        // pair to avoid leaving an advertiser stuck paused after their
        // card issue resolves itself — safer for now to just make sure
        // Dexter knows, and decide manually.
        const invoice = event.data.object;
        const { rows } = await pool.query(
          `SELECT business_name, email FROM advertisers WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
        const advertiser = rows[0];
        sendMail(
          'hello@zuva.tv',
          'Zuva Ads payment failed',
          brandedEmailHtml({
            heading: 'A Zuva Ads renewal payment failed',
            paragraphs: [
              advertiser
                ? `<strong>${escapeHtml(advertiser.business_name)}</strong> (${escapeHtml(advertiser.email)}) — Stripe will retry automatically. No action needed unless retries are exhausted (customer.subscription.deleted will fire then).`
                : `Stripe customer ${escapeHtml(invoice.customer)} — no matching advertiser row found.`,
            ],
          })
        );
      } else if (event.type === 'customer.subscription.updated') {
        // Only act on the specific false -> true transition, not every
        // update (proration adjustments, Stripe metadata syncing, etc.
        // all fire this same event type and would otherwise be noise).
        const subscription = event.data.object;
        const wasCancelling = event.data.previous_attributes?.cancel_at_period_end === false;
        if (wasCancelling && subscription.cancel_at_period_end === true) {
          const { rows } = await pool.query(
            `SELECT business_name, email FROM advertisers WHERE stripe_customer_id = $1`,
            [subscription.customer]
          );
          const advertiser = rows[0];
          const periodEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString().slice(0, 10)
            : 'unknown date';
          // Deliberately not changing advertisers.status here — the
          // customer paid for the full period, so the campaign should
          // keep running until it actually ends. No "cancelling soon"
          // state exists in the status enum, and adding one is a schema
          // change beyond what this fix covers.
          sendMail(
            'hello@zuva.tv',
            'Zuva Ads subscription set to cancel',
            brandedEmailHtml({
              heading: 'A Zuva Ads subscription is cancelling at period end',
              paragraphs: [
                advertiser
                  ? `<strong>${escapeHtml(advertiser.business_name)}</strong> (${escapeHtml(advertiser.email)}) — active until ${periodEnd}, then cancels automatically.`
                  : `Stripe customer ${escapeHtml(subscription.customer)} — no matching advertiser row found. Active until ${periodEnd}.`,
              ],
            })
          );
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(`ads/advertise/webhook error handling ${event.type}:`, err.message);
      // Deliberately NOT 200 here (task said 200 for handled events,
      // 400 for signature failures — this is a third case it didn't
      // cover): the signature already verified, so this is a transient
      // processing failure (e.g. a DB hiccup). A 5xx makes Stripe retry
      // with backoff instead of silently losing a payment confirmation.
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
};
