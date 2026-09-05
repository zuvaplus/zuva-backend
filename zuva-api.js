/**
 * ============================================================
 *  ZUVA.TV  —  Core API  (Node.js / Express)
 *  Suns Economy: Purchase, Tip, Cash Out
 * ============================================================
 *  Install dependencies:
 *    npm install express pg axios dotenv express-validator multer form-data @aws-sdk/client-rekognition
 *
 *  Required .env variables:
 *    DATABASE_URL=postgresql://user:pass@host:5432/zuva
 *    FLUTTERWAVE_SECRET_KEY=...            (payouts — African corridors)
 *    FLUTTERWAVE_WEBHOOK_SECRET_HASH=...
 *    PLATFORM_WALLET_ID=00000000-0000-0000-0000-000000000001
 *    JWT_SECRET=your_jwt_secret
 * ============================================================
 */

'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const axios      = require('axios');
const multer     = require('multer');
const FormData   = require('form-data');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const { randomUUID: uuidv4, createHash } = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const { RekognitionClient, DetectModerationLabelsCommand } = require('@aws-sdk/client-rekognition');
const nodemailer = require('nodemailer');
const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
const Stripe = require('stripe');
require('dotenv').config();

const router = express.Router();

// ─── Stripe (Suns purchases) ────────────────────────────────────
// undefined (not thrown) when STRIPE_SECRET_KEY isn't set — POST
// /suns/purchase checks for this and returns a clear 503 instead of
// crashing the module at require time. Same guarded-init pattern
// routes/ads.js already uses for its own Stripe client (a separate
// require('stripe')(...) call there — the SDK has no shared-instance
// state to reuse across files).
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ─── Database pool ────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL is not set — the API cannot connect to Postgres.');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000, // fail fast with a clear error instead of hanging
});

db.on('error', (err) => {
  // Fired on idle-client errors (e.g. a dropped connection) — log instead of crashing the process.
  console.error('[db] Unexpected pool error:', err.message);
});

// Verify connectivity on boot so a bad DATABASE_URL or network issue surfaces immediately
// in the deploy logs instead of on the first API request.
//
// NOTE: ENETUNREACH here almost always means Railway can't route to Supabase's direct
// connection host (db.<project>.supabase.co), which is IPv6-only unless you've purchased
// Supabase's IPv4 add-on. Fix: in the Supabase dashboard, use the "Connection pooler"
// (Supavisor) connection string instead — host aws-0-<region>.pooler.supabase.com,
// username postgres.<project-ref> — and set that as DATABASE_URL in Railway. That host
// resolves over IPv4 and works from Railway's network.
db.query('SELECT 1')
  .then(() => console.log('[db] Connected to Postgres'))
  .catch((err) => console.error('[db] Failed to connect to Postgres:', err.message));

// ─── Payout providers (Flutterwave / Mukuru / WiPay / Wise) ────
const PayoutRouter = require('./services/payouts/PayoutRouter');
const { ProviderNotConfiguredError } = require('./services/payouts/PayoutProvider');

// ─── Cloudflare Stream client ──────────────────────────────────
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  console.error('[cloudflare] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set — video upload will fail.');
}
const cloudflareStream = axios.create({
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream`,
  headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  // Large uploads can take a while — don't let axios time the request out client-side.
  // Railway's own proxy timeout still applies and is outside this app's control.
  timeout: 0,
});

// ─── AWS Rekognition client (content moderation) ────────────────
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
  console.error('[rekognition] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION not set — content moderation will fail (videos stay pending).');
}
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ─── Mail (Gmail SMTP via nodemailer) — admin moderation alerts ─
let mailTransport = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
} else {
  console.error('[mail] GMAIL_USER / GMAIL_APP_PASSWORD not set — admin moderation emails will not be sent.');
}

// Never throws — a failed/unconfigured email should not break whatever
// moderation action triggered it (the DB status change already happened).
async function sendAdminEmail(subject, htmlBody) {
  if (!mailTransport || !process.env.ADMIN_EMAIL) {
    console.error(`[mail] Skipping email "${subject}" — mail transport or ADMIN_EMAIL not configured.`);
    return;
  }
  try {
    await mailTransport.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.ADMIN_EMAIL,
      subject,
      html: htmlBody,
    });
  } catch (err) {
    console.error(`[mail] Failed to send admin email "${subject}":`, err.message);
  }
}

// Send to an arbitrary recipient (applicants) — same never-throws
// contract as sendAdminEmail: a broken mail setup must not break the
// application/approval flow that triggered it.
async function sendApplicantEmail(to, subject, htmlBody) {
  if (!mailTransport) {
    console.error(`[mail] Skipping applicant email "${subject}" — mail transport not configured.`);
    return;
  }
  try {
    await mailTransport.sendMail({ from: process.env.GMAIL_USER, to, subject, html: htmlBody });
  } catch (err) {
    console.error(`[mail] Failed to send applicant email "${subject}" to ${to}:`, err.message);
  }
}

// On-brand applicant email shell: vantablack background, amber accent,
// table layout for email-client compatibility. All interpolated user
// content must be escapeHtml()'d by the caller.
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

// Minimal HTML escaping for user-supplied strings (video title, creator
// name) interpolated into email bodies below.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Video upload middleware (multer) ──────────────────────────
// Disk storage (not memory) so a 2GB upload doesn't get buffered in RAM.
// Files are streamed to Cloudflare Stream then deleted — see POST /upload/video.
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `zuva-upload-${uuidv4()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB, matches the frontend's stated cap
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/avi'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─── Caption upload middleware (multer) ────────────────────────
// Memory storage — caption files are plain text (SRT/VTT), never more
// than a few hundred KB, so buffering in RAM is fine (unlike video).
const captionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — generous for a subtitle file
  fileFilter: (req, file, cb) => {
    const allowed = ['.srt', '.vtt'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Curated caption languages matching Zuva's African & Caribbean audience.
// Values are the BCP-47-ish codes Cloudflare Stream's captions API expects.
const CAPTION_LANGUAGES = ['en', 'fr', 'pt', 'sw', 'ar', 'es', 'ht', 'yo', 'ha', 'zu', 'am'];

// Cloudflare Stream's captions endpoint only accepts WebVTT — SRT is a
// different (if closely related) format, so creators uploading .srt need
// a lossless conversion first: strip the numeric cue-sequence lines SRT
// uses and VTT doesn't, and swap the comma decimal separator in
// timestamps for VTT's required period.
function srtToVtt(srtText) {
  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const body = normalized
    .split('\n')
    .filter((line) => !/^\d+$/.test(line.trim()))
    .join('\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

// ─── Constants ────────────────────────────────────────────────
const SUNS_PER_USD        = 100; // 1 Sun = $0.01 USD
const PLATFORM_WALLET_ID  = process.env.PLATFORM_WALLET_ID;

// Minimum cashout is corridor-dependent — see MIN_PAYOUT_USD in
// services/payouts/PayoutRouter.js ($5 Flutterwave/Mukuru, $20 WiPay/Wise).
// FX conversion happens provider-side: payouts are initiated in USD and the
// provider settles in the creator's local currency at its own rate.

// ─── Middleware: auth guard (real Clerk JWT verification) ───────
// The actual middleware is created in server.js and stored on the app.
// This bridge makes it available to routes in this router file.
function requireAuth(req, res, next) {
  return req.app.get('requireAuth')(req, res, next);
}

const requireCreator = (req, res, next) => {
  if (req.user?.role !== 'creator' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Creator account required' });
  }
  next();
};

// ─── Auth middleware bridges (real Clerk JWT verification) ──────
// The actual middleware is created in server.js and stored on the app.
// These bridges make it available to routes in this router file.
function requireAdmin(req, res, next) {
  return req.app.get('requireAdmin')(req, res, next);
}

function requireClerkUser(req, res, next) {
  return req.app.get('requireAuth')(req, res, next);
}

function optionalAuth(req, res, next) {
  return req.app.get('optionalAuth')(req, res, next);
}

// ─── Validation error handler ─────────────────────────────────
// 422 Unprocessable Entity: the request was well-formed but failed field
// validation, as distinct from a 400 (malformed request) or 404/403.
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    // `error` carries the human-readable message(s) — every frontend fetch
    // helper surfaces body.error, so validation failures show as e.g.
    // "Invalid application ID" instead of a generic "Request failed (422)".
    return res.status(422).json({
      error: [...new Set(list.map((e) => e.msg))].join('; '),
      errors: list,
    });
  }
  next();
};


// ============================================================
//  UTILITY: Execute a double-entry ledger transaction
//
//  This is the core financial function. It ALWAYS creates
//  paired entries inside a single PostgreSQL transaction.
//  If either INSERT fails, both are rolled back automatically.
//
//  Parameters:
//    client         — pg client (must be within a transaction block)
//    debitWalletId  — wallet money is leaving
//    creditWalletId — wallet money is arriving
//    amountSuns     — amount to move
//    type           — transaction_type enum value
//    transactionRef — UUID linking the paired entries
//    opts           — { contentId, relatedUserId, providerRef, memo, rate }
// ============================================================
// NOTE: the ledger_entries column is still named chimoney_payment_ref for
// historical reasons — it now holds ANY payment provider's reference.
// Renaming it is optional cleanup (needs a coordinated migration + deploy).
async function writeDoubleEntry(client, {
  debitWalletId,
  creditWalletId,
  amountSuns,
  type,
  transactionRef,
  contentId        = null,
  relatedUserId    = null,
  providerRef      = null,
  memo             = null,
  exchangeRate     = null,
}) {
  // Insert DEBIT row (money leaves debitWallet)
  await client.query(`
    INSERT INTO ledger_entries
      (wallet_id, direction, amount_suns, type, transaction_ref,
       content_id, related_user_id, chimoney_payment_ref, usd_exchange_rate, memo)
    VALUES ($1, 'debit', $2, $3, $4, $5, $6, $7, $8, $9)
  `, [debitWalletId, amountSuns, type, transactionRef,
      contentId, relatedUserId, providerRef, exchangeRate, memo]);

  // Insert CREDIT row (money arrives at creditWallet)
  await client.query(`
    INSERT INTO ledger_entries
      (wallet_id, direction, amount_suns, type, transaction_ref,
       content_id, related_user_id, chimoney_payment_ref, usd_exchange_rate, memo)
    VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7, $8, $9)
  `, [creditWalletId, amountSuns, type, transactionRef,
      contentId, relatedUserId, providerRef, exchangeRate, memo]);

  // The update_wallet_balance() DB trigger fires after each INSERT
  // and recomputes both wallets' balances from the full ledger history.
  // The CHECK (balance_suns >= 0) constraint on wallets will ROLLBACK
  // this entire transaction if the debit would cause a negative balance.
}


// ============================================================
//  ROUTE 1: GET /api/wallet/balance
//  Returns the authenticated user's current Sun balance
// ============================================================
router.get('/wallet/balance', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        w.balance_suns,
        w.total_earned_suns,
        w.total_spent_suns,
        w.total_cashed_out_suns,
        -- USD equivalent at current rate (display only)
        ROUND(w.balance_suns::numeric / $1, 2) AS balance_usd_equivalent
      FROM wallets w
      WHERE w.user_id = $2
    `, [SUNS_PER_USD, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Wallet not found' });
    res.json({ success: true, wallet: rows[0] });
  } catch (err) {
    console.error('balance error:', err);
    res.status(500).json({ error: 'Could not fetch balance' });
  }
});


// ============================================================
//  ROUTE 2: POST /api/suns/purchase
//  Buyer purchases Suns with a card via Stripe Checkout (USD-only for
//  v1 — see the note on FiatCurrency/getFiatToUsdRate's removal in
//  git history; no FX-rate dependency needed this way). Mirrors the
//  pre-Chimoney-removal flow's shape (create a pending sun_purchases
//  row, return a checkout URL, credit Suns from the webhook once
//  payment is confirmed) but the Stripe session is created FIRST so
//  its real session id can go straight into the one INSERT below,
//  instead of insert-then-update.
//
//  sun_purchases has no stripe_session_id/amount_suns/usd_amount/
//  clerk_user_id columns — those names don't exist on the live table
//  (confirmed via the pre-removal code, the only source of truth since
//  this table predates the migration-file convention). Using the real
//  columns instead: buyer_id (DB UUID, matching every other money
//  route — tips/cashout/writeDoubleEntry all key off req.user.id, never
//  a raw Clerk id), suns_purchased, fiat_amount/fiat_currency (fixed to
//  'USD'), and chimoney_payment_id/chimoney_checkout_url repurposed to
//  hold the Stripe session id/url — same "don't rename, just repurpose"
//  precedent already used on ledger_entries.chimoney_payment_ref.
// ============================================================
router.post('/suns/purchase',
  requireAuth,
  [
    body('amountSuns')
      .isInt({ min: 50, max: 100000 })
      .withMessage('Amount must be between 50 and 100,000 Suns'),
  ],
  validate,
  async (req, res) => {
    if (!stripe) {
      return res.status(503).json({
        error: 'Suns purchases are coming soon',
        code:  'PURCHASES_NOT_LIVE',
      });
    }

    const amountSuns = req.body.amountSuns;
    const usdAmount = amountSuns / SUNS_PER_USD;
    const buyerId = req.user.id;
    const appUrl = process.env.APP_URL || 'https://zuva.tv';

    try {
      // No client-supplied idempotency key exists yet (the frontend
      // isn't wired to this route — see the task this was built for),
      // so this derives one from (buyer, amount, current minute) rather
      // than a fresh UUID per call, which would give zero real retry
      // protection. Once the frontend calls this directly, switching to
      // a client-generated key reused across retries (the pattern
      // routes/ads.js's Stripe checkout already uses) would be the
      // more robust upgrade — flagging this as the interim approach.
      const idempotencyKey = createHash('sha256')
        .update(`suns-purchase:${buyerId}:${amountSuns}:${Math.floor(Date.now() / 60000)}`)
        .digest('hex');

      const metadata = {
        clerk_user_id: req.clerkUserId || '',
        amount_suns: String(amountSuns),
        usd_amount: usdAmount.toFixed(2),
        purchase_type: 'suns',
      };

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(usdAmount * 100), // cents
            product_data: {
              name: 'Zuva Suns',
              description: `${amountSuns} Suns for your Zuva wallet`,
            },
          },
          quantity: 1,
        }],
        success_url: `${appUrl}/wallet/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/wallet`,
        customer_email: req.user.email,
        metadata,
        payment_intent_data: { metadata },
      }, { idempotencyKey });

      const purchaseId = uuidv4();
      await db.query(`
        INSERT INTO sun_purchases
          (id, buyer_id, fiat_amount, fiat_currency, suns_purchased, fiat_to_usd_rate,
           status, chimoney_payment_id, chimoney_checkout_url)
        VALUES ($1, $2, $3, 'USD', $4, 1, 'pending', $5, $6)
      `, [purchaseId, buyerId, usdAmount, amountSuns, session.id, session.url]);

      res.json({
        checkoutUrl:   session.url,
        purchaseId,
        sunsPurchased: amountSuns,
        usdAmount:     usdAmount.toFixed(2),
      });
    } catch (err) {
      console.error('suns purchase error:', err.message);
      res.status(500).json({ error: 'Could not start purchase. Please try again.' });
    }
  }
);


// ============================================================
//  ROUTE 4: POST /api/suns/tip
//  Viewer sends Suns to a creator (on or off specific content).
//
//  Commission math:
//    Rising Star  (0-999 followers):    creator gets 60%, Zuva gets 40%
//    Shining Sun  (1k-9,999 followers): creator gets 70%, Zuva gets 30%
//    Solar Elite  (10k+ verified):      creator gets 85%, Zuva gets 15%
//
//  NOTE: Tips split IMMEDIATELY at time of tip.
//  The creator's wallet receives only their share.
//  Zuva's commission goes straight to the platform wallet.
//  This means the creator's balance is always their spendable amount.
// ============================================================
router.post('/suns/tip',
  requireAuth,
  [
    body('creatorId').isUUID().withMessage('Invalid creator ID'),
    body('amountSuns').isInt({ min: 10 }).withMessage('Minimum tip is 10 Suns'),
    body('contentId').optional().isUUID(),
    body('message').optional().isString().isLength({ max: 280 }),
  ],
  validate,
  async (req, res) => {
    const { creatorId, amountSuns, contentId, orientation, message } = req.body;
    const senderId = req.user.id;

    if (senderId === creatorId) {
      return res.status(400).json({ error: 'You cannot tip yourself' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // ── Fetch sender wallet ─────────────────────────────────
      const senderWalletRes = await client.query(
        'SELECT id, balance_suns FROM wallets WHERE user_id = $1 FOR UPDATE',
        [senderId]
      );
      const senderWallet = senderWalletRes.rows[0];
      if (!senderWallet) throw new Error('Sender wallet not found');
      if (senderWallet.balance_suns < amountSuns) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient Suns',
          balance: senderWallet.balance_suns,
          required: amountSuns,
        });
      }

      // ── Fetch creator profile and wallet ────────────────────
      const creatorRes = await client.query(`
        SELECT cp.creator_share_pct, cp.platform_share_pct, cp.tier,
               w.id AS wallet_id
        FROM creator_profiles cp
        JOIN wallets w ON w.user_id = cp.user_id
        WHERE cp.user_id = $1
        FOR UPDATE OF w
      `, [creatorId]);

      if (!creatorRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Creator not found' });
      }
      const creator = creatorRes.rows[0];

      // ── Fetch platform wallet ───────────────────────────────
      const platformWalletRes = await client.query(
        'SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE',
        [PLATFORM_WALLET_ID]
      );
      const platformWalletId = platformWalletRes.rows[0]?.id;

      // ── Calculate split ─────────────────────────────────────
      //  amountSuns = totalTip (what leaves the sender's wallet)
      //  creatorSuns + platformSuns must equal amountSuns exactly.
      //  We use floor() for the creator and give the remainder to the platform
      //  to avoid any fractional Sun or rounding loss.
      const creatorSuns  = Math.floor(amountSuns * creator.creator_share_pct / 100);
      const platformSuns = amountSuns - creatorSuns;  // always exact, no rounding error

      const transactionRef = uuidv4();

      // ── Double entry 1: Sender → Creator ───────────────────
      await writeDoubleEntry(client, {
        debitWalletId:  senderWallet.id,
        creditWalletId: creator.wallet_id,
        amountSuns:     creatorSuns,
        type:           'creator_tip',
        transactionRef,
        contentId:      contentId || null,
        relatedUserId:  creatorId,
        memo: `Tip from viewer: ${creatorSuns} Suns (${creator.creator_share_pct}% of ${amountSuns})`,
      });

      // ── Double entry 2: Sender → Platform (commission) ─────
      if (platformSuns > 0) {
        await writeDoubleEntry(client, {
          debitWalletId:  senderWallet.id,
          creditWalletId: platformWalletId,
          amountSuns:     platformSuns,
          type:           'platform_commission',
          transactionRef,
          contentId:      contentId || null,
          relatedUserId:  creatorId,
          memo: `Commission on tip: ${platformSuns} Suns (${creator.platform_share_pct}%)`,
        });
      }

      // ── Record tip ──────────────────────────────────────────
      await client.query(`
        INSERT INTO tips
          (sender_id, creator_id, content_id, orientation, amount_suns, message, transaction_ref)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [senderId, creatorId, contentId || null, orientation || null,
          amountSuns, message || null, transactionRef]);

      // ── Update content tip stats if content_id provided ─────
      if (contentId && orientation === 'vertical') {
        await client.query(`
          UPDATE vertical_content
          SET tip_count = tip_count + 1, total_tips_suns = total_tips_suns + $1
          WHERE id = $2
        `, [amountSuns, contentId]);
      } else if (contentId && orientation === 'landscape') {
        await client.query(`
          UPDATE landscape_content
          SET tip_count = tip_count + 1, total_tips_suns = total_tips_suns + $1
          WHERE id = $2
        `, [amountSuns, contentId]);
      }

      // ── Update creator wallet lifetime stats ─────────────────
      await client.query(`
        UPDATE wallets SET total_earned_suns = total_earned_suns + $1 WHERE user_id = $2
      `, [creatorSuns, creatorId]);

      // ── Update sender wallet lifetime stats ──────────────────
      await client.query(`
        UPDATE wallets SET total_spent_suns = total_spent_suns + $1 WHERE user_id = $2
      `, [amountSuns, senderId]);

      await client.query('COMMIT');

      res.json({
        success:        true,
        transactionRef,
        totalSent:      amountSuns,
        creatorReceived: creatorSuns,
        platformFee:    platformSuns,
        creatorTier:    creator.tier,
        split: `${creator.creator_share_pct}/${creator.platform_share_pct}`,
        message: `${creatorSuns} Suns sent to creator (${creator.creator_share_pct}% after ${creator.platform_share_pct}% platform fee)`,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('tip error:', err.message);
      res.status(500).json({ error: 'Tip failed. Your Suns were not deducted.' });
    } finally {
      client.release();
    }
  }
);


// ============================================================
//  ROUTE 5: POST /api/suns/cashout
//  Creator cashes out their Suns balance. Provider-routed:
//  services/payouts/PayoutRouter.js picks Flutterwave / Mukuru /
//  WiPay / Wise from the creator's country code.
//
//  Flow:
//    1. Route + enforce the corridor's minimum (USD)
//    2. Atomically debit the creator's Suns (double-entry inside one
//       transaction; the wallets CHECK constraint makes an overdraft
//       impossible) and insert the payout row as 'pending'
//    3. Call the provider's initiatePayout with a fresh idempotency key
//       (crypto.randomUUID — the uuid package breaks on Railway)
//    4. Success → payout 'processing' + provider reference stored
//       Failure → Suns re-credited atomically, payout 'failed'
//    5. Provider webhook (/api/webhooks/payouts/:provider) finalizes:
//       'completed', or 'failed' + re-credit
//
//  NOTE: The cashout amount is ALREADY the creator's post-commission balance.
//  The commission was deducted at the time each tip was received.
//  There is NO second commission deduction at cashout.
// ============================================================
router.post('/suns/cashout',
  requireAuth,
  requireCreator,
  [
    body('amountSuns')
      .isInt({ min: 100 })
      .withMessage('Cashout amount must be at least 100 Suns ($1 USD); regional minimums also apply'),
    // Legacy network-suffixed channels are accepted and collapse to
    // 'mobile_money' — the corridor (creator country) decides the network.
    body('channel')
      .isIn(['mobile_money', 'bank_transfer', 'cash_pickup',
             'mobile_money_mpesa', 'mobile_money_mtn', 'mobile_money_airtel',
             'mobile_money_ecocash'])
      .withMessage('Invalid payout channel'),
    body('phoneNumber')
      .optional()
      .isMobilePhone()
      .withMessage('Invalid phone number'),
    body('bankAccountRef')
      .optional()
      .isString(),
    body('bankCode')
      .optional()
      .isString(),
    // Legal name — payout partners require the recipient's real name for
    // KYC/AML compliance; it must match the creator's government ID.
    body('recipientFirstName')
      .isString().trim().isLength({ min: 1, max: 100 })
      .withMessage('Legal first name is required (max 100 characters)'),
    body('recipientLastName')
      .isString().trim().isLength({ min: 1, max: 100 })
      .withMessage('Legal last name is required (max 100 characters)'),
    // Kept for request-shape compatibility; the destination currency is
    // now determined by the provider corridor, not the client.
    body('localCurrencyCode')
      .optional()
      .isLength({ min: 3, max: 3 }),
  ],
  validate,
  async (req, res) => {
    const {
      amountSuns, channel, phoneNumber, bankAccountRef, bankCode,
      recipientFirstName, recipientLastName,
    } = req.body;
    const creatorId = req.user.id;

    // ── Step 1: Route to a provider + enforce corridor minimum ──
    const method    = channel.startsWith('mobile_money') ? 'mobile_money' : channel;
    const usdAmount = amountSuns / SUNS_PER_USD;

    let routeInfo;
    try {
      routeInfo = PayoutRouter.route({ countryCode: req.user.countryCode, method });
      PayoutRouter.enforceMinimum(routeInfo, usdAmount);
    } catch (err) {
      if (err instanceof PayoutRouter.PayoutRoutingError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const idempotencyKey = uuidv4(); // crypto.randomUUID under the hood
    const payoutId       = uuidv4();
    const transactionRef = uuidv4();

    // ── Step 2: Atomic debit + pending payout record ─────────────
    // Everything money-related happens inside one transaction: the
    // FOR UPDATE lock + CHECK (balance_suns >= 0) constraint guarantee
    // the debit can never overdraw, and the payout row commits with the
    // debit or not at all.
    const client = await db.connect();
    let wallet;
    try {
      await client.query('BEGIN');

      const walletRes = await client.query(`
        SELECT w.id, w.balance_suns, cp.tier, cp.creator_share_pct
        FROM wallets w
        JOIN creator_profiles cp ON cp.user_id = w.user_id
        WHERE w.user_id = $1
        FOR UPDATE OF w
      `, [creatorId]);

      if (!walletRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Creator wallet not found' });
      }
      wallet = walletRes.rows[0];

      if (wallet.balance_suns < amountSuns) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient balance',
          balance_suns: wallet.balance_suns,
          requested_suns: amountSuns,
        });
      }

      await client.query(`
        INSERT INTO payouts (
          id, creator_id, amount_suns, creator_suns, platform_suns,
          tier_at_payout, creator_pct_at_payout,
          usd_amount, local_currency_code,
          channel, payout_phone, payout_bank_ref,
          status, ledger_transaction_ref,
          provider, idempotency_key,
          recipient_first_name, recipient_last_name
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15,$16,$17)
      `, [
        payoutId, creatorId,
        amountSuns,
        amountSuns,  // creator_suns = full amount (commission already deducted at tip time)
        0,           // platform_suns = 0 at cashout (already collected)
        wallet.tier, wallet.creator_share_pct,
        usdAmount.toFixed(2),
        'USD',       // we initiate in USD; the provider settles in local currency
        method, phoneNumber || null, bankAccountRef || null,
        transactionRef,
        routeInfo.provider, idempotencyKey,
        recipientFirstName, recipientLastName,
      ]);

      const platformWalletRes = await client.query(
        'SELECT id FROM wallets WHERE user_id = $1', [PLATFORM_WALLET_ID]
      );
      const platformWalletId = platformWalletRes.rows[0]?.id;

      await writeDoubleEntry(client, {
        debitWalletId:  wallet.id,
        creditWalletId: platformWalletId,  // platform tracks total paid out
        amountSuns,
        type:           'creator_payout',
        transactionRef,
        providerRef:    idempotencyKey,
        memo: `Cashout: ${amountSuns} Suns ($${usdAmount.toFixed(2)}) via ${routeInfo.provider} (${method})`,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('cashout debit error:', err.message);
      return res.status(500).json({ error: 'Cashout failed. Your balance has not been changed.' });
    } finally {
      client.release();
    }

    // ── Step 3: Initiate the payout with the provider ────────────
    // The Suns are already debited; from here a failure must re-credit.
    try {
      const result = await routeInfo.adapter.initiatePayout({
        creatorId,
        amountUSD: usdAmount,
        method,
        recipientDetails: {
          countryCode:       req.user.countryCode,
          msisdn:            phoneNumber,            // must include country code
          bankAccountNumber: bankAccountRef,
          bankCode:          bankCode || null,
          firstName:         recipientFirstName,     // legal name, collected at cashout
          lastName:          recipientLastName,
          email:             req.user.email,
        },
        idempotencyKey,
      });

      await db.query(`
        UPDATE payouts
        SET status = 'processing', provider_reference = $1, provider_response = $2,
            processed_at = NOW()
        WHERE id = $3
      `, [result.providerReference, JSON.stringify(result.raw ?? null), payoutId]);

      return res.json({
        success:   true,
        payoutId,
        transactionRef,
        amountSuns,
        usdAmount: usdAmount.toFixed(2),
        provider:  routeInfo.provider,
        channel:   method,
        status:    'processing',
        message: `${amountSuns} Suns ($${usdAmount.toFixed(2)} USD) payout initiated via ${routeInfo.provider}. ` +
                 `You'll receive it in your local currency once the provider confirms.`,
      });
    } catch (err) {
      const notConfigured = err instanceof ProviderNotConfiguredError;
      if (notConfigured) {
        console.log(`cashout: ${routeInfo.provider} not configured — re-crediting ${amountSuns} Suns to ${creatorId}`);
      } else {
        console.error('cashout initiate error:', err.response?.data || err.message);
      }

      // ── Re-credit the Suns atomically and mark the payout failed ──
      const revClient = await db.connect();
      try {
        await revClient.query('BEGIN');
        const platformWalletRes = await revClient.query(
          'SELECT id FROM wallets WHERE user_id = $1', [PLATFORM_WALLET_ID]
        );
        await writeDoubleEntry(revClient, {
          debitWalletId:  platformWalletRes.rows[0]?.id,
          creditWalletId: wallet.id,
          amountSuns,
          type:           'creator_payout',
          transactionRef: uuidv4(),
          providerRef:    idempotencyKey,
          memo: `Payout ${payoutId} could not be initiated — Suns returned`,
        });
        await revClient.query(`
          UPDATE payouts SET status = 'failed', processed_at = NOW() WHERE id = $1
        `, [payoutId]);
        await revClient.query('COMMIT');
      } catch (revErr) {
        await revClient.query('ROLLBACK');
        // The payout row stays 'pending' with the debit applied — flag loudly
        // for manual reconciliation rather than guessing.
        console.error(`[CRITICAL] cashout ${payoutId}: initiate failed AND re-credit failed:`, revErr.message);
        return res.status(500).json({
          error: 'Cashout failed and could not be automatically reversed. Support has been notified — do not retry.',
          payoutId,
        });
      } finally {
        revClient.release();
      }

      // Provider not configured (pre-launch) is an expected state, not an
      // upstream failure: structured 503 so the frontend can message it.
      if (notConfigured) {
        return res.status(503).json({
          error: `${err.message} Your Suns have been returned to your balance.`,
          code: 'PAYOUTS_NOT_CONFIGURED',
        });
      }

      return res.status(502).json({
        error: 'Cashout could not be initiated with the payout provider. Your Suns have been returned to your balance.',
      });
    }
  }
);


// ============================================================
//  ROUTE: GET /api/payouts/options
//  The authenticated creator's available cashout methods, routed
//  from their country code. `configured: false` methods exist but
//  can't move money yet (provider keys/onboarding pending) — the
//  frontend shows them disabled with a "coming soon" badge.
// ============================================================
router.get('/payouts/options', requireAuth, requireCreator, (req, res) => {
  const countryCode = req.user.countryCode ?? null;
  res.json({
    success: true,
    countryCode,
    methods: PayoutRouter.optionsForCountry(countryCode),
  });
});


// ============================================================
//  ROUTE: GET /api/payouts/history
//  The authenticated creator's payouts, newest first. `failed`
//  payouts had their Suns re-credited (initiation failure or
//  provider webhook failure) — the frontend notes this.
// ============================================================
router.get('/payouts/history', requireAuth, requireCreator, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, amount_suns, usd_amount, channel, provider, status,
             created_at, processed_at
      FROM payouts
      WHERE creator_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);
    res.json({ success: true, payouts: rows });
  } catch (err) {
    console.error('payout history error:', err.message);
    res.status(500).json({ error: 'Could not fetch payout history' });
  }
});


// ============================================================
//  ROUTE 6: GET /api/suns/ledger
//  Returns the authenticated user's transaction history
// ============================================================
router.get('/suns/ledger', requireAuth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const { rows } = await db.query(`
      SELECT
        le.id,
        le.direction,
        le.amount_suns,
        le.type,
        le.transaction_ref,
        le.memo,
        le.created_at,
        u.display_name AS counterparty_name,
        u.username     AS counterparty_username
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      LEFT JOIN users u ON u.id = le.related_user_id
      WHERE w.user_id = $1
      ORDER BY le.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, parseInt(limit), offset]);

    res.json({ success: true, transactions: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch ledger' });
  }
});


// ============================================================
//  ROUTE 7: GET /api/creator/earnings/:creatorId
//  Creator dashboard earnings summary
// ============================================================
router.get('/creator/earnings/:creatorId',
  requireAuth,
  [param('creatorId').isUUID()],
  validate,
  async (req, res) => {
    // Creators can only see their own earnings (admins can see any)
    if (req.user.id !== req.params.creatorId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const { rows } = await db.query(
        'SELECT * FROM creator_earnings_summary WHERE creator_id = $1',
        [req.params.creatorId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Creator not found' });

      const creator = rows[0];
      // Add USD equivalent for display
      creator.balance_usd = (creator.balance_suns / SUNS_PER_USD).toFixed(2);
      creator.earned_usd  = (creator.total_earned_suns / SUNS_PER_USD).toFixed(2);

      res.json({ success: true, earnings: creator });
    } catch (err) {
      res.status(500).json({ error: 'Could not fetch earnings' });
    }
  }
);




// ============================================================
//  MAIN FEED RANKING
//
//  Replaces the old "Discovery Engine" above, which referenced tables
//  (vertical_content, landscape_content, content_views, user_interests)
//  and a function (upsert_user_interest) that don't exist against the
//  real schema — that code predates the current single `videos` table
//  design and was never reconciled with it, which is why GET
//  /feed/recommended 500'd with "Could not generate recommended feed"
//  and POST /feed/view-complete silently failed on every call. Both are
//  replaced below by GET /api/feed and POST /api/feed/watch-progress,
//  built against the real videos/users/tips/watch_events tables.
//
//  Signals combined by computeFeedScore, per video:
//    - completion rate  (avg of watch_events.completion_pct)  — highest weight
//    - tips_received    (SUM(tips.amount_suns) by content_id) — highest of the engagement signals
//    - comments         (videos.comment_count)                — weighted higher for Documentary & Discussion
//    - likes            (videos.like_count)
//    - view_count       (videos.view_count)                   — de-emphasized for Documentary & Discussion
//    - recency          gentle exponential decay, long half-life
//    - country match    small additive boost, never a filter
//
//  See CLAUDE.md for the full writeup, including the two known gaps:
//  no per-video language signal exists yet (so the "language" half of
//  the country/language boost is inert), and `content_category` is a
//  separate column from the older `category` (VALID_VIDEO_CATEGORIES).
// ============================================================

// content_category taxonomy. Separate from VALID_VIDEO_CATEGORIES (the
// older `category` column), which stays as-is — see the migration file
// for why these two fields coexist.
const CONTENT_CATEGORIES = [
  'entertainment', 'music', 'comedy', 'drama_series', 'documentary',
  'discussion_debate', 'interview', 'lifestyle_culture', 'news', 'nature',
  'sports', 'tech_innovation', 'science_education', 'health_wellness', 'other',
];

// The older `category` column's taxonomy — moved up here (was declared
// much further down, near the upload route) because GET /api/feed's
// `category` query param filter needs it at module-load time, when the
// route's express-validator array is built, not just at request time.
const VALID_VIDEO_CATEGORIES = ['Comedy', 'Drama', 'Music', 'News', 'Sports', 'Lifestyle', 'Education', 'Other'];

// Categories that get protected feed placement (the floor, below) and
// different score weighting: completion rate matters even more, raw
// view count matters less — so genuinely informative/enriching content
// doesn't get buried by pure engagement optimization. Originally just
// the "Documentary & Discussion" umbrella (documentary, discussion_debate,
// interview, lifestyle_culture); generalized under this broader name
// when sports/tech_innovation/science_education/health_wellness were
// added with the same protection as an explicit requirement. A
// code-level grouping only, not a DB concept.
const PROTECTED_CATEGORIES = [
  'documentary', 'discussion_debate', 'interview', 'lifestyle_culture',
  'sports', 'tech_innovation', 'science_education', 'health_wellness',
];

// Feed page composition. "Page" here means each successive window of
// `limit` items in the assembled feed, not just the first one — see
// buildRankedFeed, which assembles the whole ordered feed in rounds of
// `limit` so the floors hold on every page a viewer scrolls to, not just
// page one.
const PROTECTED_FLOOR_RATIO = 1 / 8;  // ~1 in 8 reserved for PROTECTED_CATEGORIES — same ratio as before the rename, unchanged
const DIVERSITY_FLOOR_RATIO = 1 / 6;  // a further slice reserved so one category can't dominate a page

// Gentle recency decay — long-form ages well, so this half-life is long
// (a video this many days old has its recency contribution halved).
const FEED_RECENCY_HALF_LIFE_DAYS = 21;

// Relative weights — see the header comment above for the reasoning
// behind each. Coefficients, not hard caps: an extreme outlier on one
// signal (e.g. a huge tip) can still out-rank typical values on another,
// which is expected of a linear heuristic score like this one.
const FEED_WEIGHTS = {
  COMPLETION:                100,  // highest overall — the single strongest signal
  COMPLETION_PROTECTED:      150,  // even more so for PROTECTED_CATEGORIES
  TIPS:                       40,  // highest of the engagement-only signals — a Sun spent is the strongest signal
  COMMENTS:                   12,
  COMMENTS_PROTECTED:         24,  // comments signal engagement-with-ideas for these categories specifically
  LIKES:                      10,
  VIEWS:                      10,
  VIEWS_PROTECTED:             2,  // de-emphasized — a high-completion, modest-view video in a protected category should still win
  RECENCY:                    10,
  COUNTRY_MATCH_BOOST:         6,  // small and additive, never a filter
};

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * computeFeedScore(video, viewer)
 * video:  { content_category, avg_completion_pct, tips_received, like_count,
 *           comment_count, view_count, created_at, creator_country_code }
 * viewer: { preferred_country, preferred_languages } | null (anonymous/no prefs)
 */
function computeFeedScore(video, viewer) {
  const isProtected = PROTECTED_CATEGORIES.includes(video.content_category);

  const completion = clamp01((video.avg_completion_pct ?? 0) / 100);
  const completionWeight = isProtected
    ? FEED_WEIGHTS.COMPLETION_PROTECTED
    : FEED_WEIGHTS.COMPLETION;

  const tipsScore    = Math.log10(1 + (video.tips_received ?? 0));
  const likesScore   = Math.log10(1 + (video.like_count ?? 0));
  const commentsScore = Math.log10(1 + (video.comment_count ?? 0));
  const commentsWeight = isProtected ? FEED_WEIGHTS.COMMENTS_PROTECTED : FEED_WEIGHTS.COMMENTS;
  const viewsScore   = Math.log10(1 + (video.view_count ?? 0));
  const viewsWeight  = isProtected ? FEED_WEIGHTS.VIEWS_PROTECTED : FEED_WEIGHTS.VIEWS;

  const ageDays = Math.max(0, (Date.now() - new Date(video.created_at).getTime()) / 86400000);
  const recency = Math.pow(0.5, ageDays / FEED_RECENCY_HALF_LIFE_DAYS);

  // Language has no per-video signal to match against yet (see header
  // comment) — only country contributes today.
  let affinityBoost = 0;
  if (viewer?.preferred_country && video.creator_country_code
      && viewer.preferred_country === video.creator_country_code) {
    affinityBoost += FEED_WEIGHTS.COUNTRY_MATCH_BOOST;
  }

  return (
    completion * completionWeight +
    tipsScore * FEED_WEIGHTS.TIPS +
    likesScore * FEED_WEIGHTS.LIKES +
    commentsScore * commentsWeight +
    viewsScore * viewsWeight +
    recency * FEED_WEIGHTS.RECENCY +
    affinityBoost
  );
}

/**
 * assembleFeedRound
 * Builds one page-sized (`limit`) round out of the still-unused scored
 * candidates: first the PROTECTED_CATEGORIES floor, then a general
 * diversity floor (a few slots reserved for categories not yet
 * represented in this round), then the rest filled by pure score. The
 * round is re-sorted by score at the end so the floor items don't read
 * as a visibly separate block bolted onto the page.
 */
function assembleFeedRound(scoredProtected, scoredAll, usedIds, limit) {
  const chosen = [];
  const protectedFloorCount = Math.max(1, Math.round(limit * PROTECTED_FLOOR_RATIO));
  const diversityFloorCount = Math.max(1, Math.round(limit * DIVERSITY_FLOOR_RATIO));

  for (const c of scoredProtected) {
    if (chosen.length >= protectedFloorCount) break;
    if (usedIds.has(c.id)) continue;
    chosen.push(c);
    usedIds.add(c.id);
  }

  const categoryCounts = new Map();
  for (const c of chosen) {
    categoryCounts.set(c.content_category, (categoryCounts.get(c.content_category) || 0) + 1);
  }

  let diversityAdded = 0;
  for (const c of scoredAll) {
    if (diversityAdded >= diversityFloorCount || chosen.length >= limit) break;
    if (usedIds.has(c.id)) continue;
    if ((categoryCounts.get(c.content_category) || 0) >= 1) continue;
    chosen.push(c);
    usedIds.add(c.id);
    categoryCounts.set(c.content_category, 1);
    diversityAdded++;
  }

  for (const c of scoredAll) {
    if (chosen.length >= limit) break;
    if (usedIds.has(c.id)) continue;
    chosen.push(c);
    usedIds.add(c.id);
  }

  chosen.sort((a, b) => b._score - a._score);
  return chosen;
}

/**
 * buildRankedFeed
 * Scores every candidate once, then assembles the full ordered feed in
 * `limit`-sized rounds (each with its own category floors applied) until
 * there's enough to satisfy `offset + limit`, then slices that window.
 * Works identically for anonymous viewers (viewer = null) — with no
 * preferred_country and no watch/tip/like history to speak of yet, the
 * score collapses to trending + recency + the same category floors,
 * which is exactly the "don't personalize into nothing" fallback.
 */
function buildRankedFeed(candidates, viewer, offset, limit) {
  const scored = candidates.map((v) => ({ ...v, _score: computeFeedScore(v, viewer) }));
  const scoredAll = [...scored].sort((a, b) => b._score - a._score);
  const scoredProtected = scoredAll.filter((v) => PROTECTED_CATEGORIES.includes(v.content_category));

  const usedIds = new Set();
  const assembled = [];
  while (assembled.length < offset + limit && usedIds.size < candidates.length) {
    const round = assembleFeedRound(scoredProtected, scoredAll, usedIds, limit);
    if (round.length === 0) break; // no more unused candidates
    assembled.push(...round);
  }

  return assembled.slice(offset, offset + limit);
}

// Candidate pool cap — this platform is pre-launch with a modest video
// count, so scoring/assembling in application memory over the most
// recent N published videos is simple and fast. Revisit (push scoring
// into SQL, or paginate the candidate fetch) once the catalog is large
// enough that fetching this many rows per request stops being cheap.
const FEED_CANDIDATE_POOL_SIZE = 500;

// ── Homepage fallback: shuffled top-ranked mix ──────────────────
// For anonymous viewers, or signed-in viewers with zero watch_events —
// the personalized buildRankedFeed above collapses to a flat,
// deterministic "trending + recency" order for someone with no signal
// to personalize against, which looks stale on every repeat visit. This
// fallback instead takes the top-scored candidates *per category* (so
// "across all categories" holds regardless of the raw score
// distribution) and shuffles them with a seed derived from the current
// time bucket — deterministic *within* that bucket (many concurrent
// anonymous viewers see the same order, not a different shuffle per
// request) and automatically different once the bucket rolls over.
const FALLBACK_RESEED_BUCKET_MINUTES = 20; // within the requested 15-30 min window
const FALLBACK_TOP_PER_CATEGORY = 15;

// mulberry32 — small, fast, deterministic PRNG. Not cryptographic (and
// doesn't need to be); only used to turn an integer seed into a stable
// shuffle order.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(array, seed) {
  const rand = mulberry32(seed);
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildFallbackFeed(candidates, offset, limit) {
  const scored = candidates
    .map((v) => ({ ...v, _score: computeFeedScore(v, null) }))
    .sort((a, b) => b._score - a._score);

  const categoryCounts = new Map();
  const pool = [];
  for (const v of scored) {
    const count = categoryCounts.get(v.content_category) || 0;
    if (count >= FALLBACK_TOP_PER_CATEGORY) continue;
    categoryCounts.set(v.content_category, count + 1);
    pool.push(v);
  }

  const bucketSeed = Math.floor(Date.now() / (FALLBACK_RESEED_BUCKET_MINUTES * 60000));
  return seededShuffle(pool, bucketSeed).slice(offset, offset + limit);
}

// ============================================================
//  GET /api/feed
//  Scored, category-floor-adjusted, paginated main feed. Works for
//  anonymous viewers (optionalAuth) — see buildFallbackFeed above for
//  anonymous/no-history viewers, buildRankedFeed for everyone else.
//  Excludes Flares (is_flare = true) entirely; Flares has its own
//  separate feed and ranking (GET /api/flares/feed).
//
//  Optional query params:
//    content_category  filters to one CONTENT_CATEGORIES value
//    category           filters to one VALID_VIDEO_CATEGORIES value —
//                       the older taxonomy (Comedy/Drama/Music/...),
//                       separate from content_category. Backs /category/:name.
//    country           filters to one creator country_code (2-letter)
//    sort              latest|oldest|most_viewed|most_liked — bypasses
//                       the personalized/fallback ranking below entirely
//                       in favor of a plain ORDER BY + LIMIT/OFFSET query.
//                       Omitted (the normal case — see VideoGrid.tsx,
//                       which only sends this once a viewer explicitly
//                       picks a sort option) preserves the existing
//                       computeFeedScore/buildFallbackFeed behavior as
//                       the default, unranked-by-recency experience.
//  content_category/category/country apply to the candidate pool before
//  scoring when unsorted — orthogonal to which ranking path is used.
// ============================================================
const FEED_SORT_ORDER_BY = {
  latest:      'v.created_at DESC, v.id DESC',
  oldest:      'v.created_at ASC, v.id ASC',
  most_viewed: 'v.view_count DESC, v.created_at DESC, v.id DESC',
  most_liked:  'v.like_count DESC, v.created_at DESC, v.id DESC',
};

router.get('/feed',
  optionalAuth,
  [
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('content_category').optional().trim().isIn(CONTENT_CATEGORIES).withMessage('Invalid content_category'),
    query('category').optional().trim().isIn(VALID_VIDEO_CATEGORIES).withMessage('Invalid category'),
    query('country').optional().trim().isLength({ min: 2, max: 2 }).withMessage('country must be a 2-letter code'),
    query('sort').optional().isIn(Object.keys(FEED_SORT_ORDER_BY)).withMessage('Invalid sort'),
  ],
  validate,
  async (req, res) => {
    const limit  = req.query.limit || 30;
    const offset = req.query.offset || 0;
    const contentCategoryFilter = req.query.content_category || null;
    const categoryFilter = req.query.category || null;
    const countryFilter = req.query.country || null;
    const sort = req.query.sort || null;

    try {
      // Explicit sort — a plain, unranked query. No candidate-pool cap,
      // no personalization: just ORDER BY + real LIMIT/OFFSET pagination
      // over the whole catalog, matching what "Most Viewed" etc. should
      // actually mean.
      if (sort) {
        const { rows: sorted } = await db.query(`
          SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
                 v.duration_seconds, v.view_count, v.like_count, v.comment_count,
                 v.category, v.content_category, v.tags, v.created_at,
                 u.id AS creator_id, u.username AS creator_username,
                 u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
                 COALESCE(u.follower_count, 0) AS creator_follower_count
          FROM videos v
          JOIN users u ON u.id = v.creator_id
          WHERE v.status = 'published' AND v.is_flare = false
            AND ($3::text IS NULL OR v.content_category = $3)
            AND ($4::text IS NULL OR u.country_code = $4)
            AND ($5::text IS NULL OR v.category = $5)
          ORDER BY ${FEED_SORT_ORDER_BY[sort]}
          LIMIT $1 OFFSET $2
        `, [limit, offset, contentCategoryFilter, countryFilter, categoryFilter]);

        const page = sorted.map((r) => ({
          id: r.id, title: r.title, description: r.description,
          cloudflare_video_id: r.cloudflare_video_id, thumbnail_url: r.thumbnail_url,
          duration_seconds: r.duration_seconds, view_count: r.view_count,
          like_count: r.like_count, comment_count: r.comment_count,
          category: r.category, content_category: r.content_category,
          tags: r.tags, created_at: r.created_at,
          creator: {
            id: r.creator_id, username: r.creator_username, display_name: r.creator_display_name,
            avatar_url: r.creator_avatar_url, follower_count: r.creator_follower_count,
          },
        }));

        return res.json({ success: true, feed: page });
      }

      let viewer = null;
      let hasHistory = false;
      if (req.user) {
        const { rows: viewerRows } = await db.query(
          `SELECT preferred_country, preferred_languages,
                  EXISTS (SELECT 1 FROM watch_events WHERE user_id = $1) AS has_history
           FROM users WHERE id = $1`,
          [req.user.id]
        );
        viewer = viewerRows[0] || null;
        hasHistory = viewer?.has_history === true;
      }

      const { rows } = await db.query(`
        SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
               v.duration_seconds, v.view_count, v.like_count, v.comment_count,
               v.category, v.content_category, v.tags, v.created_at,
               u.id AS creator_id, u.username AS creator_username,
               u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
               u.country_code AS creator_country_code,
               COALESCE(u.follower_count, 0) AS creator_follower_count,
               COALESCE(we.avg_completion_pct, 0) AS avg_completion_pct,
               COALESCE(t.tips_received, 0) AS tips_received
        FROM videos v
        JOIN users u ON u.id = v.creator_id
        LEFT JOIN (
          SELECT video_id, AVG(completion_pct) AS avg_completion_pct
          FROM watch_events
          GROUP BY video_id
        ) we ON we.video_id = v.id
        LEFT JOIN (
          SELECT content_id, SUM(amount_suns) AS tips_received
          FROM tips
          WHERE content_id IS NOT NULL
          GROUP BY content_id
        ) t ON t.content_id = v.id
        WHERE v.status = 'published' AND v.is_flare = false
          AND ($2::text IS NULL OR v.content_category = $2)
          AND ($3::text IS NULL OR u.country_code = $3)
          AND ($4::text IS NULL OR v.category = $4)
        ORDER BY v.created_at DESC
        LIMIT $1
      `, [FEED_CANDIDATE_POOL_SIZE, contentCategoryFilter, countryFilter, categoryFilter]);

      const useFallback = !req.user || !hasHistory;
      const assembled = useFallback
        ? buildFallbackFeed(rows, offset, limit)
        : buildRankedFeed(rows, viewer, offset, limit);

      const page = assembled.map((r) => ({
        id: r.id, title: r.title, description: r.description,
        cloudflare_video_id: r.cloudflare_video_id, thumbnail_url: r.thumbnail_url,
        duration_seconds: r.duration_seconds, view_count: r.view_count,
        like_count: r.like_count, comment_count: r.comment_count,
        category: r.category, content_category: r.content_category,
        tags: r.tags, created_at: r.created_at,
        creator: {
          id: r.creator_id, username: r.creator_username, display_name: r.creator_display_name,
          avatar_url: r.creator_avatar_url, follower_count: r.creator_follower_count,
        },
      }));

      res.json({ success: true, feed: page });
    } catch (err) {
      console.error('feed error:', err.message);
      res.status(500).json({ error: 'Could not generate feed' });
    }
  }
);

// Shared videos+creator row -> FeedItem mapper for the three /api/me/*
// lists below — same shape GET /api/feed already returns, so the
// frontend can point FeedCard at any of these with no changes.
function mapVideoFeedRow(r) {
  return {
    id: r.id, title: r.title, description: r.description,
    cloudflare_video_id: r.cloudflare_video_id, thumbnail_url: r.thumbnail_url,
    duration_seconds: r.duration_seconds, view_count: r.view_count,
    like_count: r.like_count, comment_count: r.comment_count,
    category: r.category, content_category: r.content_category,
    tags: r.tags, created_at: r.created_at,
    creator: {
      id: r.creator_id, username: r.creator_username, display_name: r.creator_display_name,
      avatar_url: r.creator_avatar_url, follower_count: r.creator_follower_count,
    },
  };
}

// Cap for all three /api/me/* lists below — no pagination UI on any of
// them (single fetch, like GET /api/channel/:username), so this is
// just a sane ceiling against unbounded growth, not a real page size.
const MY_LIST_LIMIT = 100;

// ── GET /api/me/following ─────────────────────────────────────
// Latest videos from creators the viewer subscribes to.
router.get('/me/following',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
               v.duration_seconds, v.view_count, v.like_count, v.comment_count,
               v.category, v.content_category, v.tags, v.created_at,
               u.id AS creator_id, u.username AS creator_username,
               u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
               COALESCE(u.follower_count, 0) AS creator_follower_count
        FROM videos v
        JOIN users u ON u.id = v.creator_id
        JOIN subscriptions s ON s.creator_id = v.creator_id
        WHERE s.subscriber_id = $1 AND v.status = 'published' AND v.is_flare = false
        ORDER BY v.created_at DESC
        LIMIT $2
      `, [req.user.id, MY_LIST_LIMIT]);

      res.json({ success: true, feed: rows.map(mapVideoFeedRow) });
    } catch (err) {
      console.error('following feed error:', err.message);
      res.status(500).json({ error: 'Could not load following feed' });
    }
  }
);

// ── GET /api/me/history ───────────────────────────────────────
// Distinct watched videos, most-recently-watched first. A video
// watched multiple times is deduped and ordered by its latest watch.
router.get('/me/history',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
               v.duration_seconds, v.view_count, v.like_count, v.comment_count,
               v.category, v.content_category, v.tags, v.created_at,
               u.id AS creator_id, u.username AS creator_username,
               u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
               COALESCE(u.follower_count, 0) AS creator_follower_count
        FROM (
          SELECT video_id, MAX(created_at) AS last_watched_at
          FROM watch_events
          WHERE user_id = $1
          GROUP BY video_id
        ) we
        JOIN videos v ON v.id = we.video_id
        JOIN users u ON u.id = v.creator_id
        WHERE v.status = 'published' AND v.is_flare = false
        ORDER BY we.last_watched_at DESC
        LIMIT $2
      `, [req.user.id, MY_LIST_LIMIT]);

      res.json({ success: true, feed: rows.map(mapVideoFeedRow) });
    } catch (err) {
      console.error('history feed error:', err.message);
      res.status(500).json({ error: 'Could not load watch history' });
    }
  }
);

// ── GET /api/me/saved ──────────────────────────────────────────
// Bookmarked videos, most-recently-saved first (saved_videos —
// 2026-08-17-saved-videos.sql).
router.get('/me/saved',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
               v.duration_seconds, v.view_count, v.like_count, v.comment_count,
               v.category, v.content_category, v.tags, v.created_at,
               u.id AS creator_id, u.username AS creator_username,
               u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
               COALESCE(u.follower_count, 0) AS creator_follower_count
        FROM saved_videos sv
        JOIN videos v ON v.id = sv.video_id
        JOIN users u ON u.id = v.creator_id
        WHERE sv.user_id = $1 AND v.status = 'published' AND v.is_flare = false
        ORDER BY sv.created_at DESC
        LIMIT $2
      `, [req.user.id, MY_LIST_LIMIT]);

      res.json({ success: true, feed: rows.map(mapVideoFeedRow) });
    } catch (err) {
      console.error('saved feed error:', err.message);
      res.status(500).json({ error: 'Could not load saved videos' });
    }
  }
);

// ── GET /api/me/followed-creators ─────────────────────────────
// Distinct creators the viewer subscribes to, most-recently-followed
// first — backs the homepage's story-style avatar row (id/username/
// avatar only, not their videos; that's GET /api/me/following above).
router.get('/me/followed-creators',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT u.id, u.username, u.display_name, u.avatar_url
        FROM subscriptions s
        JOIN users u ON u.id = s.creator_id
        WHERE s.subscriber_id = $1
        ORDER BY s.created_at DESC
        LIMIT $2
      `, [req.user.id, MY_LIST_LIMIT]);

      res.json({ success: true, creators: rows });
    } catch (err) {
      console.error('followed-creators error:', err.message);
      res.status(500).json({ error: 'Could not load followed creators' });
    }
  }
);

// ── GET /api/me ─────────────────────────────────────────────
// The signed-in user's own full account record — backs /settings.
// req.user (from requireAuth) only carries {id, role, email, username,
// countryCode, walletId}, not the rest of these columns, so this does
// its own lookup rather than reusing req.user directly.
router.get('/me',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT id, username, email, role, display_name, avatar_url, bio,
               country_code, preferred_country, preferred_languages,
               COALESCE(follower_count, 0) AS follower_count, created_at
        FROM users
        WHERE id = $1
      `, [req.user.id]);

      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('me fetch error:', err.message);
      res.status(500).json({ error: 'Could not load account' });
    }
  }
);

// ── PATCH /api/me/preferences ───────────────────────────────
// preferred_country/preferred_languages exist on users (see
// computeFeedScore's country-match boost + its "language has no
// per-video signal yet" note) but until now nothing ever wrote them —
// only ever read for ranking. This is their first real write path.
router.patch('/me/preferences',
  requireAuth,
  [
    body('preferred_country').optional({ nullable: true }).trim()
      .isLength({ min: 2, max: 2 }).withMessage('preferred_country must be a 2-letter code'),
    body('preferred_languages').optional({ nullable: true }).isArray()
      .withMessage('preferred_languages must be an array of language codes'),
    body('preferred_languages.*').optional().isString().trim().isLength({ min: 2, max: 8 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { preferred_country, preferred_languages } = req.body;
      const { rows } = await db.query(`
        UPDATE users
        SET preferred_country   = COALESCE($1, preferred_country),
            preferred_languages = COALESCE($2, preferred_languages)
        WHERE id = $3
        RETURNING id, username, email, role, display_name, avatar_url, bio,
                  country_code, preferred_country, preferred_languages,
                  COALESCE(follower_count, 0) AS follower_count, created_at
      `, [preferred_country ?? null, preferred_languages ?? null, req.user.id]);

      res.json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('preferences update error:', err.message);
      res.status(500).json({ error: 'Could not update preferences' });
    }
  }
);

// ============================================================
//  POST /api/feed/watch-progress
//  Records one granular watch_events row — the missing signal
//  computeFeedScore's completion rate depends on. The client fires this
//  periodically (every 10-15s of playback) and on pause/unload, not just
//  once at the end, so completion rate reflects real viewing behavior
//  rather than a single on-leave guess. Anonymous viewers still
//  contribute signal (user_id is nullable) — optionalAuth, not requireAuth.
// ============================================================
router.post('/feed/watch-progress',
  optionalAuth,
  [
    body('videoId').isUUID().withMessage('Invalid video ID'),
    body('watchedSeconds').isInt({ min: 0 }).withMessage('Invalid watched seconds'),
    body('videoDurationSeconds').isInt({ min: 1 }).withMessage('Invalid video duration'),
  ],
  validate,
  async (req, res) => {
    const { videoId, watchedSeconds, videoDurationSeconds } = req.body;
    const completionPct = Math.min(100, (watchedSeconds / videoDurationSeconds) * 100);

    try {
      await db.query(`
        INSERT INTO watch_events (video_id, user_id, watched_seconds, video_duration_seconds, completion_pct)
        VALUES ($1, $2, $3, $4, $5)
      `, [videoId, req.user?.id || null, watchedSeconds, videoDurationSeconds, completionPct.toFixed(2)]);

      res.json({ success: true });
    } catch (err) {
      console.error('watch-progress error:', err.message);
      res.status(500).json({ error: 'Could not record watch progress' });
    }
  }
);


// ============================================================
//  ROUTE: GET /api/user/role
//  Looks up the authenticated user's role. Identity comes from
//  requireAuth (real Clerk JWT verification via @clerk/backend's
//  verifyToken, bridged from server.js — see the note above
//  requireAdmin's definition in this file), which resolves the users
//  row by clerk_user_id and attaches it as req.user before this handler
//  runs. Used by the frontend navbar/sidebar to pick between the viewer
//  and creator navigation experience.
// ============================================================
router.get('/user/role', requireAuth, async (req, res) => {
  // id/username are included so the frontend can source its own DB user id
  // (e.g. as creator_id on video upload) and channel URL without guessing
  // or trusting an unverified value.
  res.json({ success: true, role: req.user.role, id: req.user.id, username: req.user.username });
});


// ============================================================
//  ROUTE: GET /api/search?q=<query>
//  Searches creators (users), videos (vertical_content +
//  landscape_content, matched on title and tags), and tags.
//  Returns up to 10 of each, grouped as { creators, videos, tags }.
//
//  Assumes users has avatar_url and follower_count columns. Add
//  if missing:
//    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
//    ALTER TABLE users ADD COLUMN IF NOT EXISTS follower_count INTEGER NOT NULL DEFAULT 0;
// ============================================================
router.get('/search',
  [query('q').trim().notEmpty().withMessage('q query param is required')],
  validate,
  async (req, res) => {
    const like = `%${req.query.q}%`;

    try {
      const [creatorsResult, videosResult, tagsResult] = await Promise.all([
        db.query(`
          SELECT id, username, display_name, avatar_url,
                 COALESCE(follower_count, 0) AS follower_count
          FROM users
          WHERE role = 'creator'
            AND (username ILIKE $1 OR display_name ILIKE $1)
          ORDER BY follower_count DESC NULLS LAST
          LIMIT 10
        `, [like]),

        db.query(`
          SELECT c.id, c.orientation, c.title, c.thumbnail_url, c.view_count,
                 COALESCE(u.display_name, u.username, 'Unknown') AS creator_name
          FROM (
            SELECT id, 'vertical'::text AS orientation, title, thumbnail_url,
                   view_count, creator_id, ai_generated_tags
            FROM vertical_content
            WHERE moderation_status = 'approved' AND deleted_at IS NULL
            UNION ALL
            SELECT id, 'landscape'::text AS orientation, title, thumbnail_url,
                   view_count, creator_id, ai_generated_tags
            FROM landscape_content
            WHERE moderation_status = 'approved' AND deleted_at IS NULL
          ) c
          LEFT JOIN users u ON u.id = c.creator_id
          WHERE c.title ILIKE $1
             OR EXISTS (SELECT 1 FROM UNNEST(c.ai_generated_tags) AS tg WHERE tg ILIKE $1)
          ORDER BY c.view_count DESC
          LIMIT 10
        `, [like]),

        db.query(`
          SELECT tag, COUNT(*) AS uses FROM (
            SELECT UNNEST(ai_generated_tags) AS tag FROM vertical_content
            WHERE moderation_status = 'approved' AND deleted_at IS NULL
            UNION ALL
            SELECT UNNEST(ai_generated_tags) AS tag FROM landscape_content
            WHERE moderation_status = 'approved' AND deleted_at IS NULL
          ) t
          WHERE tag ILIKE $1
          GROUP BY tag
          ORDER BY uses DESC
          LIMIT 10
        `, [like]),
      ]);

      res.json({
        success:  true,
        creators: creatorsResult.rows,
        videos:   videosResult.rows,
        tags:     tagsResult.rows.map((r) => r.tag),
      });
    } catch (err) {
      console.error('search error:', err.message);
      res.status(500).json({ error: 'Could not perform search' });
    }
  }
);


// ============================================================
//  ROUTE 11: POST /api/creator-signup
//  Public creator application form, protected by Cloudflare Turnstile.
//
//  Run this SQL once against the database before using this route:
//
//  CREATE TABLE creator_applications (
//    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- live table is UUID, not SERIAL
//    full_name         TEXT NOT NULL,
//    email             TEXT NOT NULL,
//    country           TEXT NOT NULL,
//    primary_platform  TEXT NOT NULL,
//    social_handle     TEXT NOT NULL,
//    content_category  TEXT NOT NULL,
//    follower_count    TEXT NOT NULL,
//    marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
//    status             TEXT NOT NULL DEFAULT 'pending'
//                          CHECK (status IN ('pending', 'approved', 'rejected')),
//    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
//  );
//
//  If the table already exists from before the admin dashboard, add the
//  status column with:
//    ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
//    ALTER TABLE creator_applications ADD CONSTRAINT creator_applications_status_check
//      CHECK (status IN ('pending', 'approved', 'rejected'));
// ============================================================
router.post('/creator-signup',
  [
    body('fullName').trim().notEmpty().isLength({ max: 100 }).withMessage('Full name is required (max 100 characters)'),
    body('email').trim().isEmail().withMessage('A valid email is required'),
    body('country').trim().notEmpty().withMessage('Country is required'),
    body('primaryPlatform').trim().notEmpty().withMessage('Primary platform is required'),
    body('socialHandle').trim().notEmpty().isLength({ max: 100 }).withMessage('Social media handle is required (max 100 characters)'),
    body('contentCategory').trim().notEmpty().withMessage('Content category is required'),
    body('followerCount').trim().notEmpty().withMessage('Follower count range is required'),
    body('marketingConsent').optional().isBoolean().withMessage('marketingConsent must be a boolean'),
    body('turnstileToken').notEmpty().withMessage('Turnstile verification token is required'),
  ],
  validate,
  async (req, res) => {
    const {
      fullName, email, country, primaryPlatform, socialHandle,
      contentCategory, followerCount, marketingConsent, turnstileToken,
    } = req.body;

    // ── Verify the Turnstile token before touching the database ────
    try {
      const verifyRes = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({
          secret:   process.env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
          remoteip: req.ip,
        }),
        { timeout: 10000 }
      );

      if (!verifyRes.data?.success) {
        return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
      }
    } catch (err) {
      console.error('turnstile verification error:', err.message);
      return res.status(400).json({ error: 'Bot verification failed. Please try again.' });
    }

    try {
      // Lifecycle: 'unconfirmed' → (emailed confirm link) → 'pending' →
      // (admin review) → 'approved' | 'rejected'. The confirmation_token
      // column default (gen_random_uuid) mints the token.
      const { rows } = await db.query(`
        INSERT INTO creator_applications
          (full_name, email, country, primary_platform, social_handle, content_category, follower_count, marketing_consent, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unconfirmed', NOW())
        RETURNING confirmation_token
      `, [
        fullName, email, country, primaryPlatform, socialHandle,
        contentCategory, followerCount, Boolean(marketingConsent),
      ]);

      // Confirm link goes through the frontend domain — Next's /api/*
      // rewrite proxies it to this backend, keeping zuva.tv in the email.
      const appUrl = process.env.APP_URL || 'https://zuva.tv';
      const confirmUrl = `${appUrl}/api/creator-signup/confirm/${rows[0].confirmation_token}`;
      const firstName = escapeHtml(fullName.split(' ')[0]);

      await sendApplicantEmail(
        email,
        'Confirm your Zuva creator application',
        brandedEmailHtml({
          heading: `One more step, ${firstName}!`,
          paragraphs: [
            `Thanks for applying to become a creator on <strong style="color:#f37b0d;">Zuva.tv</strong>.`,
            `Tap the button below to confirm your application — once confirmed, our team will review it and get back to you by email.`,
          ],
          ctaText: 'Confirm My Application',
          ctaUrl: confirmUrl,
        })
      );

      res.status(201).json({
        success: true,
        message: 'Check your email to confirm your application.',
      });
    } catch (err) {
      console.error('creator signup error:', err.message);
      res.status(500).json({ error: 'Could not submit application' });
    }
  }
);


// ============================================================
//  ROUTE: GET /api/creator-signup/confirm/:token
//  The emailed confirmation link. Flips 'unconfirmed' → 'pending' and
//  renders a tiny branded HTML page (this is a browser navigation, not
//  an API call). Used tokens / unknown tokens get a friendly page too.
// ============================================================
function confirmPageHtml(title, message) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Zuva.tv</title></head>
  <body style="margin:0;background:#000000;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:460px;margin:14vh auto 0;padding:40px 32px;background:#0d0d0d;border:1px solid rgba(243,123,13,0.3);border-radius:16px;text-align:center;">
      <div style="color:#f37b0d;font-size:24px;font-weight:bold;margin-bottom:10px;">Zuva.tv ☀️</div>
      <div style="color:#ffffff;font-size:19px;font-weight:bold;margin-bottom:12px;">${title}</div>
      <div style="color:#b3b3b3;font-size:14px;line-height:1.6;margin-bottom:24px;">${message}</div>
      <a href="${process.env.APP_URL || 'https://zuva.tv'}" style="display:inline-block;background:#f37b0d;color:#000;font-weight:bold;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:10px;">Back to Zuva</a>
    </div>
  </body></html>`;
}

router.get('/creator-signup/confirm/:token',
  [param('token').isUUID().withMessage('Invalid confirmation link')],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        UPDATE creator_applications
        SET status = 'pending', confirmed_at = NOW()
        WHERE confirmation_token = $1 AND status = 'unconfirmed'
        RETURNING full_name, email
      `, [req.params.token]);

      if (!rows.length) {
        return res.status(404).send(confirmPageHtml(
          'Link expired or already used',
          'This confirmation link is no longer valid. If you already confirmed, there is nothing more to do — our team is reviewing your application.'
        ));
      }

      // Heads-up to the admin that a confirmed application awaits review.
      sendAdminEmail(
        'New creator application ready for review',
        `<p><strong>${escapeHtml(rows[0].full_name)}</strong> (${escapeHtml(rows[0].email)}) confirmed their creator application. Review it in the admin dashboard.</p>`
      );

      res.send(confirmPageHtml(
        'Application confirmed!',
        `Thanks, ${escapeHtml(rows[0].full_name.split(' ')[0])} — your application is now with our review team. We'll email you as soon as there's a decision.`
      ));
    } catch (err) {
      console.error('application confirm error:', err.message);
      res.status(500).send(confirmPageHtml(
        'Something went wrong',
        'We could not confirm your application just now. Please try the link again in a few minutes.'
      ));
    }
  }
);


// ============================================================
//  VIDEO UPLOAD, CHANNEL, AND PLAYER ROUTES
//
//  Run this SQL once against the database before using these routes
//  (requires the pgcrypto extension for gen_random_uuid — enabled by
//  default on Supabase, otherwise: CREATE EXTENSION IF NOT EXISTS pgcrypto;):
//
//  CREATE TABLE videos (
//    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//    creator_id           UUID NOT NULL REFERENCES users(id),
//    title                TEXT NOT NULL,
//    description          TEXT,
//    category             TEXT NOT NULL,
//    tags                 TEXT[] NOT NULL DEFAULT '{}',
//    cloudflare_video_id  TEXT NOT NULL,
//    thumbnail_url        TEXT,
//    duration_seconds     INTEGER,
//    status               TEXT NOT NULL DEFAULT 'pending'
//                           CHECK (status IN ('pending', 'published', 'rejected', 'flagged', 'under_review')),
//    view_count           INTEGER NOT NULL DEFAULT 0,
//    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
//  );
//  -- If this table predates report-triggered review, add 'flagged' and
//  -- 'under_review' to the existing status CHECK constraint (see
//  -- moderateReportedVideo() below).
//
//  CREATE TABLE video_reports (
//    id                  SERIAL PRIMARY KEY,
//    video_id            UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
//    reporter_id         UUID REFERENCES users(id) ON DELETE SET NULL,
//    -- The migration adds this as TEXT + CHECK (matching every other
//    -- categorical column in this schema, e.g. content_category) via
//    -- ADD COLUMN IF NOT EXISTS — but on the live DB it turned out
//    -- video_reports.category already existed as a genuine Postgres
//    -- enum type with these exact 9 values, so the ADD COLUMN was a
//    -- no-op and the CHECK below is redundant (harmless) with the
//    -- enum's own restriction. Either representation behaves
//    -- identically from the application's side — just noting it here
//    -- so this comment doesn't mislead a future reader inspecting the
//    -- real schema.
//    category            TEXT NOT NULL CHECK (category IN (
//                           'nudity', 'minors', 'violence', 'animal_cruelty',
//                           'hate_speech', 'misinformation', 'spam', 'copyright', 'other'
//                         )),
//    additional_details  TEXT,
//    resolved_at         TIMESTAMPTZ,
//    resolution          TEXT CHECK (resolution IN ('restored', 'removed')),
//    -- Legacy columns kept for historical rows, no longer written to:
//    reason              TEXT,
//    reporter_clerk_id   TEXT,
//    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
//  );
//
//  NOTE: all new uploads publish immediately (status = 'published' at
//  insert, see POST /upload/video) — there is no pre-approval gate.
//  Moderation is entirely post-publish and report-driven:
//  computeReportTier() (see POST /video/:id/report) sets 'under_review'
//  once a category's pending-report count crosses its tier threshold
//  (1 for nudity/minors, 2 for violence/animal_cruelty, REPORT_THRESHOLD
//  for hate_speech/misinformation/spam/other). Only the lowest tier also
//  triggers moderateReportedVideo()'s AI re-review; the two higher-
//  severity tiers hide the video and alert admins immediately instead,
//  deliberately without an automated re-publish path. An admin resolves
//  the case via POST /api/admin/reports/:id/resolve ('restored' ->
//  'published', 'removed' -> 'rejected', and increments the creator's
//  users.violation_count on removal). 'flagged' is still not produced by
//  any automated path — reserved for future use (e.g. manual admin
//  flagging). See GET /admin/moderation-queue and GET /api/admin/reports.
// ============================================================

// VALID_VIDEO_CATEGORIES now declared near CONTENT_CATEGORIES, above —
// see the note there for why (GET /api/feed's category filter needs it
// at module-load time). See CONTENT_CATEGORIES near the feed-ranking
// code above (search "MAIN FEED RANKING") for the richer taxonomy
// videos.content_category
// uses — required on upload, distinct from the category field above.

// Flares (short-form vertical feed) share this same videos table/upload
// pipeline — is_flare just flags which feed a row belongs to. Enforced at
// two points: synchronously here if Cloudflare already knows the duration,
// and again in GET /upload/status/:videoId once Cloudflare reports it
// asynchronously (see the NOTE there).
const FLARE_MAX_DURATION_SECONDS = 90;

// ── Content moderation: post-publish only ─────────────────────
// There used to be an upload-time AWS Rekognition thumbnail check here
// (moderateVideo(), a synchronous gate that could reject a video or
// strand it at 'pending' on a transient AWS/thumbnail failure). Removed —
// per product decision, all new uploads publish immediately
// (see POST /upload/video) and moderation is entirely post-publish,
// driven by the tiered reporting system (computeReportTier(),
// POST /video/:id/report). The Rekognition client is still used by
// moderateReportedVideo() below, for the lowest-severity report tier
// only (hate_speech/misinformation/spam/other) — see its own comment.

// ── POST /api/upload/video ───────────────────────────────────
// Identity comes from requireClerkUser, which just bridges to the same
// real requireAuth/Clerk JWT verification used everywhere else (see the
// note above requireAdmin's definition in this file) — not a header
// read. Same as /api/channel/update — a client-supplied creator_id
// field is accepted for compatibility but is checked against the
// authenticated user rather than trusted, so a caller can't upload as
// someone else.
router.post('/upload/video',
  requireClerkUser,
  // Role gate BEFORE multer — a non-creator gets a clear 403 without the
  // server ever accepting (up to 2GB of) upload bytes from them.
  requireCreator,
  videoUpload.single('video'),
  [
    body('title').trim().notEmpty().isLength({ max: 200 }).withMessage('Title is required (max 200 characters)'),
    body('description').optional().trim().isLength({ max: 2000 }).withMessage('Description must be at most 2000 characters'),
    body('category').trim().isIn(VALID_VIDEO_CATEGORIES).withMessage('Invalid category'),
    body('content_category').trim().isIn(CONTENT_CATEGORIES).withMessage('Invalid content_category'),
    // Self-disclosure, required — no default in the client form, so this
    // must be explicitly present on every upload rather than .optional().
    body('contains_synthetic_media').isBoolean().withMessage('contains_synthetic_media is required'),
    body('tags').optional().isString().withMessage('tags must be a comma-separated string'),
    body('creator_id').optional().isUUID().withMessage('Invalid creator_id'),
    body('is_flare').optional().isBoolean().withMessage('is_flare must be a boolean'),
  ],
  validate,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'A video file is required (field name "video", mp4/mov/avi, up to 2GB)' });
    }

    if (req.body.creator_id && req.body.creator_id !== req.user.id) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'creator_id must match the authenticated user' });
    }
    if (req.user.role !== 'creator' && req.user.role !== 'admin') {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Creator account required' });
    }

    const { title, description, category, content_category: contentCategory } = req.body;
    const tags = (req.body.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    const isFlare = req.body.is_flare === true || req.body.is_flare === 'true';
    const containsSyntheticMedia = req.body.contains_synthetic_media === true || req.body.contains_synthetic_media === 'true';

    try {
      // ── Upload the file to Cloudflare Stream ────────────────
      const form = new FormData();
      form.append('file', fs.createReadStream(req.file.path), req.file.originalname);

      const cfRes = await cloudflareStream.post('', form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (!cfRes.data?.success) {
        console.error('cloudflare stream upload failed:', JSON.stringify(cfRes.data?.errors));
        return res.status(502).json({ error: 'Video upload to Cloudflare Stream failed' });
      }

      const cf = cfRes.data.result;
      const durationSeconds = cf.duration > 0 ? Math.round(cf.duration) : null;

      // Flares are capped at 90s. Cloudflare sometimes reports duration
      // immediately (checked here); if it doesn't yet (durationSeconds is
      // null below), GET /upload/status/:videoId re-checks once Cloudflare
      // reports it asynchronously and rejects the video at that point instead.
      if (isFlare && durationSeconds !== null && durationSeconds > FLARE_MAX_DURATION_SECONDS) {
        cloudflareStream.delete(`/${cf.uid}`).catch((delErr) =>
          console.error('flare over-cap cleanup: could not delete Cloudflare video:', delErr.message)
        );
        return res.status(400).json({
          error: `Flares must be ${FLARE_MAX_DURATION_SECONDS} seconds or under (this video is ${durationSeconds}s).`,
        });
      }

      // Note: cf.thumbnail is only reliably populated once Cloudflare finishes
      // processing — GET /upload/status/:videoId re-syncs it once ready.
      // Custom thumbnail uploads aren't wired up yet (no image storage is
      // configured in this backend) — Cloudflare's auto-generated thumbnail
      // is used regardless of what the frontend's optional thumbnail field sends.
      //
      // status = 'published' directly, no pre-approval gate — there used to
      // be an upload-time AWS Rekognition thumbnail check here
      // (moderateVideo(), now removed) that could reject or strand a video
      // at 'pending'. Moderation is now entirely post-publish, driven by
      // the tiered reporting system below (see computeReportTier() and
      // POST /video/:id/report) rather than a synchronous gate on every upload.
      const { rows } = await db.query(`
        INSERT INTO videos
          (creator_id, title, description, category, content_category, tags, cloudflare_video_id, thumbnail_url, duration_seconds, is_flare, contains_synthetic_media, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'published')
        RETURNING *
      `, [
        req.user.id, title, description || null, category, contentCategory, tags,
        cf.uid, cf.thumbnail || null, durationSeconds, isFlare, containsSyntheticMedia,
      ]);

      const video = rows[0];
      res.status(201).json({ success: true, video, message: 'Video uploaded successfully and is now live.' });
    } catch (err) {
      console.error('video upload error:', err.response?.data ?? err.message);
      res.status(500).json({ error: 'Could not upload video' });
    } finally {
      fs.unlink(req.file.path, () => {}); // best-effort temp file cleanup
    }
  }
);

// ── GET /api/upload/status/:videoId ──────────────────────────
// Polls Cloudflare Stream for encoding progress and syncs duration_seconds /
// thumbnail_url once available. Does not touch the moderation `status`
// column — see the NOTE above this section.
router.get('/upload/status/:videoId',
  requireClerkUser,
  requireCreator,
  [param('videoId').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM videos WHERE id = $1', [req.params.videoId]);
      if (!rows.length) return res.status(404).json({ error: 'Video not found' });
      const video = rows[0];

      const cfRes = await cloudflareStream.get(`/${video.cloudflare_video_id}`);
      const cf = cfRes.data?.result;
      if (!cf) return res.status(502).json({ error: 'Could not reach Cloudflare Stream' });

      const durationSeconds = cf.duration > 0 ? Math.round(cf.duration) : video.duration_seconds;
      const thumbnailUrl    = cf.thumbnail || video.thumbnail_url;

      // NOTE: Flare duration enforcement, part 2. POST /upload/video already
      // rejects synchronously when Cloudflare reports duration immediately;
      // when it doesn't (durationSeconds was null at insert time), this poll
      // is where the real duration first becomes known — so a Flare that
      // turns out to be over the cap gets caught and rejected here instead.
      const flareRejected =
        video.is_flare && video.status !== 'rejected' &&
        durationSeconds !== null && durationSeconds > FLARE_MAX_DURATION_SECONDS;

      if (flareRejected) {
        await db.query(
          `UPDATE videos SET duration_seconds = $1, thumbnail_url = $2, status = 'rejected' WHERE id = $3`,
          [durationSeconds, thumbnailUrl, video.id]
        );
      } else if (durationSeconds !== video.duration_seconds || thumbnailUrl !== video.thumbnail_url) {
        await db.query(
          'UPDATE videos SET duration_seconds = $1, thumbnail_url = $2 WHERE id = $3',
          [durationSeconds, thumbnailUrl, video.id]
        );
      }

      res.json({
        success: true,
        processing_status: cf.status, // { state, pctComplete, errorReasonCode, errorReasonText }
        video: {
          ...video,
          duration_seconds: durationSeconds,
          thumbnail_url: thumbnailUrl,
          status: flareRejected ? 'rejected' : video.status,
        },
        ...(flareRejected ? {
          flare_rejected: true,
          flare_max_duration_seconds: FLARE_MAX_DURATION_SECONDS,
        } : {}),
      });
    } catch (err) {
      console.error('upload status error:', err.response?.data ?? err.message);
      res.status(500).json({ error: 'Could not fetch upload status' });
    }
  }
);

// ── Captions / subtitles (Cloudflare Stream captions API) ────────
// No local table — Cloudflare is the sole source of truth for which
// caption tracks exist on a video, same philosophy as thumbnail_url/
// duration_seconds being synced FROM Cloudflare rather than owned here.
// The player already renders via Cloudflare's own iframe embed
// (iframe.cloudflarestream.com/{uid}), which shows a native CC toggle
// automatically once tracks exist — no custom player work needed.

// Shared ownership guard: video must exist and belong to the caller.
async function getOwnVideo(videoId, creatorId) {
  const { rows } = await db.query(
    'SELECT id, creator_id, cloudflare_video_id FROM videos WHERE id = $1',
    [videoId]
  );
  const video = rows[0];
  if (!video || video.creator_id !== creatorId) return null;
  return video;
}

// ── GET /api/upload/video/:videoId/captions ──────────────────────
router.get('/upload/video/:videoId/captions',
  requireClerkUser,
  requireCreator,
  [param('videoId').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      const video = await getOwnVideo(req.params.videoId, req.user.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      const cfRes = await cloudflareStream.get(`/${video.cloudflare_video_id}/captions`);
      const tracks = (cfRes.data?.result ?? []).map((c) => ({
        language: c.language,
        label: c.label,
        status: c.status,
      }));
      res.json({ success: true, captions: tracks });
    } catch (err) {
      console.error('captions list error:', err.response?.data ?? err.message);
      res.status(500).json({ error: 'Could not fetch captions' });
    }
  }
);

// ── POST /api/upload/video/:videoId/captions ──────────────────────
// Accepts .srt or .vtt (field "file") + a "language" code; converts SRT
// to WebVTT if needed (Cloudflare's captions API only accepts VTT) and
// PUTs it to Cloudflare. Creators can call this once per language to
// build up multiple caption tracks on the same video.
router.post('/upload/video/:videoId/captions',
  requireClerkUser,
  requireCreator,
  captionUpload.single('file'),
  [
    param('videoId').isUUID().withMessage('Invalid video ID'),
    body('language').isIn(CAPTION_LANGUAGES).withMessage(`language must be one of: ${CAPTION_LANGUAGES.join(', ')}`),
  ],
  validate,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'A caption file is required (field "file", .srt or .vtt)' });
    }

    try {
      const video = await getOwnVideo(req.params.videoId, req.user.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      const raw = req.file.buffer.toString('utf-8');
      const isSrt = path.extname(req.file.originalname).toLowerCase() === '.srt'
        && !raw.trim().startsWith('WEBVTT');
      const vtt = isSrt ? srtToVtt(raw) : raw;

      const form = new FormData();
      form.append('file', Buffer.from(vtt, 'utf-8'), {
        filename: `${req.body.language}.vtt`,
        contentType: 'text/vtt',
      });

      await cloudflareStream.put(
        `/${video.cloudflare_video_id}/captions/${req.body.language}`,
        form,
        { headers: form.getHeaders() }
      );

      res.status(201).json({ success: true, language: req.body.language });
    } catch (err) {
      console.error('caption upload error:', err.response?.data ?? err.message);
      res.status(502).json({ error: 'Could not upload caption track to Cloudflare Stream' });
    }
  }
);

// ── DELETE /api/upload/video/:videoId/captions/:language ──────────
router.delete('/upload/video/:videoId/captions/:language',
  requireClerkUser,
  requireCreator,
  [
    param('videoId').isUUID().withMessage('Invalid video ID'),
    param('language').isIn(CAPTION_LANGUAGES).withMessage('Invalid language code'),
  ],
  validate,
  async (req, res) => {
    try {
      const video = await getOwnVideo(req.params.videoId, req.user.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      await cloudflareStream.delete(`/${video.cloudflare_video_id}/captions/${req.params.language}`);
      res.json({ success: true });
    } catch (err) {
      console.error('caption delete error:', err.response?.data ?? err.message);
      res.status(502).json({ error: 'Could not delete caption track' });
    }
  }
);

// ── GET /api/creator/videos ──────────────────────────────────
// The authenticated creator's OWN videos, every status included (unlike
// GET /api/channel/:username, which only ever shows published ones) —
// this is what the creator dashboard's "My Videos" list uses.
router.get('/creator/videos', requireAuth, requireCreator, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, creator_id, title, description, category, tags,
             cloudflare_video_id, thumbnail_url, duration_seconds, status,
             view_count, COALESCE(like_count, 0) AS like_count,
             COALESCE(comment_count, 0) AS comment_count, created_at
      FROM videos
      WHERE creator_id = $1
      ORDER BY created_at DESC
    `, [req.user.id]);
    res.json({ success: true, videos: rows });
  } catch (err) {
    console.error('creator videos fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch your videos' });
  }
});

// ── Creator links (title + URL "shelf" — management only for now;
//    the future watch-page links shelf will read these once it ships) ──
const MAX_CREATOR_LINKS = 10;

router.get('/creator/links', requireAuth, requireCreator, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, url, position FROM creator_links
       WHERE creator_id = $1 ORDER BY position ASC, created_at ASC`,
      [req.user.id]
    );
    res.json({ success: true, links: rows });
  } catch (err) {
    console.error('creator links fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch links' });
  }
});

router.post('/creator/links',
  requireAuth,
  requireCreator,
  [
    body('title').trim().notEmpty().isLength({ max: 100 }).withMessage('Title is required (max 100 characters)'),
    body('url').trim().isURL({ protocols: ['http', 'https'], require_protocol: true })
      .isLength({ max: 500 }).withMessage('A valid http(s) URL is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: countRows } = await db.query(
        'SELECT COUNT(*)::int AS count FROM creator_links WHERE creator_id = $1',
        [req.user.id]
      );
      if (countRows[0].count >= MAX_CREATOR_LINKS) {
        return res.status(400).json({ error: `You can add up to ${MAX_CREATOR_LINKS} links` });
      }

      const { rows } = await db.query(`
        INSERT INTO creator_links (creator_id, title, url, position)
        VALUES ($1, $2, $3, COALESCE(
          (SELECT MAX(position) + 1 FROM creator_links WHERE creator_id = $1), 0
        ))
        RETURNING id, title, url, position
      `, [req.user.id, req.body.title, req.body.url]);

      res.status(201).json({ success: true, link: rows[0] });
    } catch (err) {
      console.error('creator link create error:', err.message);
      res.status(500).json({ error: 'Could not add link' });
    }
  }
);

// Reorder must be declared BEFORE the /:id routes below — otherwise
// Express would match "reorder" as the :id segment first.
router.patch('/creator/links/reorder',
  requireAuth,
  requireCreator,
  [
    body('orderedIds').isArray({ min: 1 }).withMessage('orderedIds must be a non-empty array'),
    body('orderedIds.*').isUUID().withMessage('orderedIds must contain valid link IDs'),
  ],
  validate,
  async (req, res) => {
    const orderedIds = req.body.orderedIds;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: owned } = await client.query(
        'SELECT id FROM creator_links WHERE creator_id = $1 FOR UPDATE',
        [req.user.id]
      );
      const ownedIds = new Set(owned.map((r) => r.id));
      const sameSet =
        orderedIds.length === ownedIds.size && orderedIds.every((id) => ownedIds.has(id));
      if (!sameSet) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'orderedIds must match your existing links exactly' });
      }

      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE creator_links SET position = $1 WHERE id = $2 AND creator_id = $3',
          [i, orderedIds[i], req.user.id]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('creator links reorder error:', err.message);
      res.status(500).json({ error: 'Could not reorder links' });
    } finally {
      client.release();
    }
  }
);

router.patch('/creator/links/:id',
  requireAuth,
  requireCreator,
  [
    param('id').isUUID().withMessage('Invalid link ID'),
    body('title').optional().trim().notEmpty().isLength({ max: 100 }).withMessage('Title must be 1-100 characters'),
    body('url').optional().trim().isURL({ protocols: ['http', 'https'], require_protocol: true })
      .isLength({ max: 500 }).withMessage('A valid http(s) URL is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        UPDATE creator_links
        SET title = COALESCE($1, title), url = COALESCE($2, url)
        WHERE id = $3 AND creator_id = $4
        RETURNING id, title, url, position
      `, [req.body.title ?? null, req.body.url ?? null, req.params.id, req.user.id]);

      if (!rows.length) return res.status(404).json({ error: 'Link not found' });
      res.json({ success: true, link: rows[0] });
    } catch (err) {
      console.error('creator link update error:', err.message);
      res.status(500).json({ error: 'Could not update link' });
    }
  }
);

router.delete('/creator/links/:id',
  requireAuth,
  requireCreator,
  [param('id').isUUID().withMessage('Invalid link ID')],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(
        'DELETE FROM creator_links WHERE id = $1 AND creator_id = $2 RETURNING id',
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Link not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('creator link delete error:', err.message);
      res.status(500).json({ error: 'Could not delete link' });
    }
  }
);

// ── GET /api/channel/:username ───────────────────────────────
router.get('/channel/:username',
  [param('username').trim().notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { rows: creatorRows } = await db.query(`
        SELECT id, username, display_name, bio, country_code, avatar_url,
               COALESCE(follower_count, 0) AS follower_count, role, created_at
        FROM users
        WHERE username = $1
      `, [req.params.username]);

      if (!creatorRows.length) return res.status(404).json({ error: 'Creator not found' });
      const creator = creatorRows[0];

      const { rows: videos } = await db.query(`
        SELECT id, title, thumbnail_url, duration_seconds, view_count, like_count, category, created_at
        FROM videos
        WHERE creator_id = $1 AND status = 'published'
        ORDER BY created_at DESC
      `, [creator.id]);

      res.json({ success: true, creator, videos });
    } catch (err) {
      console.error('channel fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch channel' });
    }
  }
);

// ── PATCH /api/channel/update ────────────────────────────────
router.patch('/channel/update',
  requireClerkUser,
  [
    body('display_name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('display_name must be 1-100 characters'),
    body('bio').optional().trim().isLength({ max: 500 }).withMessage('bio must be at most 500 characters'),
    body('country_code').optional().trim().isLength({ min: 2, max: 2 }).withMessage('country_code must be a 2-letter ISO code'),
    body('avatar_url').optional().trim()
      .isURL({ protocols: ['http', 'https'], require_protocol: true })
      .isLength({ max: 500 }).withMessage('avatar_url must be a valid http(s) URL'),
  ],
  validate,
  async (req, res) => {
    const { display_name, bio, country_code, avatar_url } = req.body;
    try {
      const { rows } = await db.query(`
        UPDATE users
        SET display_name = COALESCE($1, display_name),
            bio           = COALESCE($2, bio),
            country_code  = COALESCE($3, country_code),
            avatar_url    = COALESCE($4, avatar_url)
        WHERE id = $5
        RETURNING id, username, display_name, bio, country_code, avatar_url, role
      `, [display_name ?? null, bio ?? null, country_code ?? null, avatar_url ?? null, req.user.id]);

      res.json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('channel update error:', err.message);
      res.status(500).json({ error: 'Could not update channel' });
    }
  }
);

// ============================================================
//  FLARES RANKING
//
//  Deliberately independent from the main feed's computeFeedScore/
//  buildRankedFeed above — no shared scoring function, no
//  cross-contamination between the two. Flares optimizes for immersive
//  session length (completion/loop/swipe-away behavior dominates the
//  score); the main feed optimizes for satisfaction/discovery with
//  protected category placement. Different products, different goals.
// ============================================================

// Short-form content ages faster than long-form — a shorter half-life
// than the main feed's FEED_RECENCY_HALF_LIFE_DAYS.
const FLARE_RECENCY_HALF_LIFE_DAYS = 3;

// Lighter weight on likes/comments/tips than the main feed on purpose —
// completion/loop/swipe-away behavior dominates for this format, matching
// how short-form ranking actually works in practice.
const FLARE_WEIGHTS = {
  COMPLETION:          60,
  LOOP_RATE:           45, // rewatches are a strong positive signal
  SWIPE_AWAY_PENALTY:  50, // inverse penalty
  LIKES:                4,
  COMMENTS:             3,
  TIPS:                 8,
  RECENCY:              8,
};

// A light touch, not the main feed's guaranteed category floor — Flares
// is meant to feel effortless, not curated-for-balance. ~15% of each
// page is nudged toward categories/creators not already present among
// that page's top-scored picks.
const FLARE_EXPLORATION_RATIO = 0.15;

function computeFlareScore(flare) {
  const completion    = clamp01((flare.avg_completion_pct ?? 0) / 100);
  const loopRate      = clamp01(flare.loop_rate ?? 0);
  const swipeAwayRate = clamp01(flare.swipe_away_rate ?? 0);

  const likesScore    = Math.log10(1 + (flare.like_count ?? 0));
  const commentsScore = Math.log10(1 + (flare.comment_count ?? 0));
  const tipsScore      = Math.log10(1 + (flare.tips_received ?? 0));

  const ageDays = Math.max(0, (Date.now() - new Date(flare.created_at).getTime()) / 86400000);
  const recency = Math.pow(0.5, ageDays / FLARE_RECENCY_HALF_LIFE_DAYS);

  return (
    completion * FLARE_WEIGHTS.COMPLETION +
    loopRate * FLARE_WEIGHTS.LOOP_RATE -
    swipeAwayRate * FLARE_WEIGHTS.SWIPE_AWAY_PENALTY +
    likesScore * FLARE_WEIGHTS.LIKES +
    commentsScore * FLARE_WEIGHTS.COMMENTS +
    tipsScore * FLARE_WEIGHTS.TIPS +
    recency * FLARE_WEIGHTS.RECENCY
  );
}

/**
 * assembleFlaresPage
 * Fills most of the page purely by score, then swaps a small
 * exploration share in from candidates whose category AND creator both
 * differ from what's already chosen — "outside the demonstrated
 * pattern" in the lightest sense that's actually computable from a
 * single page's candidates, no separate viewer-history lookup needed.
 * Tops up with next-best-scored candidates if the pool is too small/
 * homogeneous to find enough genuinely different picks.
 */
function assembleFlaresPage(scoredCandidates, limit) {
  const sorted = [...scoredCandidates].sort((a, b) => b._score - a._score);
  const explorationCount = Math.round(limit * FLARE_EXPLORATION_RATIO);
  const scoreCount = Math.max(0, limit - explorationCount);

  const chosen = sorted.slice(0, scoreCount);
  const chosenIds = new Set(chosen.map((c) => c.id));
  const chosenCategories = new Set(chosen.map((c) => c.content_category));
  const chosenCreators = new Set(chosen.map((c) => c.creator_id));

  const explorationPicks = [];
  for (const c of sorted) {
    if (explorationPicks.length >= explorationCount) break;
    if (chosenIds.has(c.id)) continue;
    if (chosenCategories.has(c.content_category) && chosenCreators.has(c.creator_id)) continue;
    explorationPicks.push(c);
    chosenIds.add(c.id);
  }
  for (const c of sorted) {
    if (chosen.length + explorationPicks.length >= limit) break;
    if (chosenIds.has(c.id)) continue;
    explorationPicks.push(c);
    chosenIds.add(c.id);
  }

  return [...chosen, ...explorationPicks].sort((a, b) => b._score - a._score);
}

/**
 * buildRankedFlaresFeed
 * Same round-based "assemble a page at a time, slice the offset window"
 * shape as the main feed's buildRankedFeed, but a fully separate
 * implementation — no shared code path between the two ranking systems.
 */
function buildRankedFlaresFeed(candidates, offset, limit) {
  const scored = candidates.map((v) => ({ ...v, _score: computeFlareScore(v) }));
  const remaining = [...scored];
  const assembled = [];

  while (assembled.length < offset + limit && remaining.length > 0) {
    const round = assembleFlaresPage(remaining, Math.min(limit, remaining.length));
    if (round.length === 0) break;
    assembled.push(...round);
    const roundIds = new Set(round.map((r) => r.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (roundIds.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }

  return assembled.slice(offset, offset + limit);
}

// Same reasoning as FEED_CANDIDATE_POOL_SIZE above — pre-launch catalog
// size makes in-memory scoring simple and fast; revisit at scale.
const FLARE_CANDIDATE_POOL_SIZE = 300;

// ── GET /api/flares/feed ──────────────────────────────────────
// Paginated feed for the vertical Flares experience (/flares) — a
// TikTok-style short-form swipe feed, completely separate from the
// long-form browse grid. Flares live in the same `videos` table as
// long-form uploads (is_flare just flags which feed a row belongs to)
// and share the exact same like/comment/tip/subscribe backend; this
// route returns the ranked list.
//
// Deliberately NOT true keyset/cursor pagination: computeFlareScore
// isn't a stable sort key to page against (it changes as new
// flare_swipe_events land), so this uses an offset encoded as an opaque
// base64 "cursor" instead — correct and standard for score-ranked feeds
// (this is how Reddit/HN-style "hot" pagination works), just not
// literal keyset pagination.
//
// "Already seen this session" exclusion is caller-driven rather than
// server-persisted: the client keeps a capped list of recently-seen
// video IDs (session/localStorage) and sends it as `exclude` — simple,
// works for anonymous viewers too, no session table needed.
router.get('/flares/feed',
  optionalAuth,
  [
    query('cursor').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 30 }).toInt(),
    query('exclude').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const limit = req.query.limit || 10;
      let offset = 0;
      if (req.query.cursor) {
        const decoded = parseInt(Buffer.from(req.query.cursor, 'base64').toString('utf-8'), 10);
        if (Number.isInteger(decoded) && decoded >= 0) offset = decoded;
      }

      // Cap the exclude list so a runaway client can't blow up the query —
      // 200 is generous for "seen this session" while staying cheap.
      const excludeIds = (req.query.exclude || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
        .slice(0, 200);

      const { rows } = await db.query(`
        SELECT v.id, v.title, v.description, v.cloudflare_video_id, v.thumbnail_url,
               v.duration_seconds, v.view_count, v.like_count, v.comment_count,
               v.category, v.content_category, v.tags, v.created_at, v.creator_id,
               u.username AS creator_username,
               u.display_name AS creator_display_name, u.avatar_url AS creator_avatar_url,
               COALESCE(u.follower_count, 0) AS creator_follower_count,
               COALESCE(fe.avg_completion_pct, 0) AS avg_completion_pct,
               COALESCE(fe.loop_rate, 0) AS loop_rate,
               COALESCE(fe.swipe_away_rate, 0) AS swipe_away_rate,
               COALESCE(t.tips_received, 0) AS tips_received
        FROM videos v
        JOIN users u ON u.id = v.creator_id
        LEFT JOIN (
          SELECT video_id,
                 AVG(LEAST(100, (watched_seconds::float / NULLIF(video_duration_seconds, 0)) * 100)) AS avg_completion_pct,
                 AVG(CASE WHEN looped THEN 1 ELSE 0 END) AS loop_rate,
                 AVG(CASE WHEN swiped_away THEN 1 ELSE 0 END) AS swipe_away_rate
          FROM flare_swipe_events
          GROUP BY video_id
        ) fe ON fe.video_id = v.id
        LEFT JOIN (
          SELECT content_id, SUM(amount_suns) AS tips_received
          FROM tips
          WHERE content_id IS NOT NULL
          GROUP BY content_id
        ) t ON t.content_id = v.id
        WHERE v.status = 'published' AND v.is_flare = true
          AND ($2::uuid[] IS NULL OR NOT (v.id = ANY($2::uuid[])))
        ORDER BY v.created_at DESC
        LIMIT $1
      `, [FLARE_CANDIDATE_POOL_SIZE, excludeIds.length ? excludeIds : null]);

      const page = buildRankedFlaresFeed(rows, offset, limit);
      const hasMore = offset + limit < rows.length;

      const mapped = page.map((r) => ({
        id: r.id, title: r.title, description: r.description,
        cloudflare_video_id: r.cloudflare_video_id, thumbnail_url: r.thumbnail_url,
        duration_seconds: r.duration_seconds, view_count: r.view_count,
        like_count: r.like_count, comment_count: r.comment_count,
        category: r.category, tags: r.tags, created_at: r.created_at,
        creator: {
          id: r.creator_id, username: r.creator_username, display_name: r.creator_display_name,
          avatar_url: r.creator_avatar_url, follower_count: r.creator_follower_count,
        },
      }));

      const nextCursor = hasMore
        ? Buffer.from(String(offset + limit), 'utf-8').toString('base64')
        : null;

      res.json({ success: true, flares: mapped, nextCursor });
    } catch (err) {
      console.error('flares feed error:', err.message);
      res.status(500).json({ error: 'Could not fetch Flares feed' });
    }
  }
);

// ── GET /api/flares/story-row ───────────────────────────────────
// Backs the Instagram-Stories-style row atop /flares: followed creators
// who've posted a Flare within the last 7 days, most-recent-Flare-first.
// Distinct from GET /api/me/followed-creators (that's all followed
// creators in follow order, with no awareness of Flares at all) — this
// reuses the same subscriptions join that endpoint uses, plus the same
// videos.is_flare filter GET /api/flares/feed uses, just combined and
// narrowed to "posted in the last 7 days." Flares themselves are still
// permanent (no TTL) — the 7-day window only limits which creators
// surface here, same as Instagram's own "recent stories" row.
router.get('/flares/story-row',
  requireAuth,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT id, username, display_name, avatar_url, latest_flare_id, latest_flare_at
        FROM (
          SELECT DISTINCT ON (u.id)
                 u.id, u.username, u.display_name, u.avatar_url,
                 v.id AS latest_flare_id, v.created_at AS latest_flare_at
          FROM subscriptions s
          JOIN users u ON u.id = s.creator_id
          JOIN videos v ON v.creator_id = u.id
          WHERE s.subscriber_id = $1
            AND v.status = 'published' AND v.is_flare = true
            AND v.created_at >= NOW() - INTERVAL '7 days'
          ORDER BY u.id, v.created_at DESC
        ) latest
        ORDER BY latest_flare_at DESC
      `, [req.user.id]);

      res.json({ success: true, creators: rows });
    } catch (err) {
      console.error('flares story-row error:', err.message);
      res.status(500).json({ error: 'Could not load Flares story row' });
    }
  }
);

// ── POST /api/flares/swipe-event ────────────────────────────────
// Records one flare_swipe_events row — fired by the client on
// swipe-away (leaving before 75% watched), loop detection (the player
// looped back to 0 and kept playing while still the active slide), and
// periodically during playback (same "every 10-15s" cadence as the main
// feed's watch-progress ping). Anonymous viewers still contribute
// signal — optionalAuth, not requireAuth.
router.post('/flares/swipe-event',
  optionalAuth,
  [
    body('videoId').isUUID().withMessage('Invalid video ID'),
    body('watchedSeconds').isInt({ min: 0 }).withMessage('Invalid watched seconds'),
    body('videoDurationSeconds').isInt({ min: 1 }).withMessage('Invalid video duration'),
    body('swipedAway').optional().isBoolean(),
    body('looped').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    const { videoId, watchedSeconds, videoDurationSeconds } = req.body;
    const swipedAway = req.body.swipedAway === true || req.body.swipedAway === 'true';
    const looped = req.body.looped === true || req.body.looped === 'true';

    try {
      await db.query(`
        INSERT INTO flare_swipe_events
          (video_id, user_id, watched_seconds, video_duration_seconds, swiped_away, looped)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [videoId, req.user?.id || null, watchedSeconds, videoDurationSeconds, swipedAway, looped]);

      res.json({ success: true });
    } catch (err) {
      console.error('flares swipe-event error:', err.message);
      res.status(500).json({ error: 'Could not record swipe event' });
    }
  }
);

// ── GET /api/video/:id ────────────────────────────────────────
// Only serves published videos (matches the visibility convention used by
// the existing feed queries) and increments view_count on every fetch.
// Also returns up to 6 related videos from the same category, plus the
// viewer's engagement state (has_liked / is_subscribed — false for
// anonymous viewers, resolved via optionalAuth for signed-in ones).
router.get('/video/:id',
  optionalAuth,
  [param('id').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        WITH updated AS (
          UPDATE videos SET view_count = view_count + 1
          WHERE id = $1 AND status = 'published'
          RETURNING *
        )
        SELECT updated.*,
               u.id AS c_id, u.username AS c_username, u.display_name AS c_display_name,
               u.avatar_url AS c_avatar_url, COALESCE(u.follower_count, 0) AS c_follower_count
        FROM updated
        LEFT JOIN users u ON u.id = updated.creator_id
      `, [req.params.id]);

      if (!rows.length) return res.status(404).json({ error: 'Video not found' });
      const row = rows[0];

      const video = {
        id: row.id, creator_id: row.creator_id, title: row.title, description: row.description,
        category: row.category, content_category: row.content_category, tags: row.tags,
        cloudflare_video_id: row.cloudflare_video_id,
        thumbnail_url: row.thumbnail_url, duration_seconds: row.duration_seconds,
        status: row.status, view_count: row.view_count, created_at: row.created_at,
        like_count: row.like_count ?? 0, comment_count: row.comment_count ?? 0,
        contains_synthetic_media: row.contains_synthetic_media ?? false,
      };
      const creator = {
        id: row.c_id, username: row.c_username, display_name: row.c_display_name,
        avatar_url: row.c_avatar_url, follower_count: row.c_follower_count,
      };

      // Viewer engagement state — anonymous viewers get false/false/false.
      let viewer = { has_liked: false, is_subscribed: false, has_saved: false };
      if (req.user) {
        const { rows: v } = await db.query(`
          SELECT
            EXISTS (SELECT 1 FROM video_likes   WHERE video_id = $1 AND user_id = $2)       AS has_liked,
            EXISTS (SELECT 1 FROM subscriptions WHERE creator_id = $3 AND subscriber_id = $2) AS is_subscribed,
            EXISTS (SELECT 1 FROM saved_videos  WHERE video_id = $1 AND user_id = $2)       AS has_saved
        `, [video.id, req.user.id, video.creator_id]);
        viewer = v[0];
      }

      const { rows: related } = await db.query(`
        SELECT v.id, v.title, v.thumbnail_url, v.duration_seconds, v.view_count, v.created_at,
               u.username AS creator_username, u.display_name AS creator_display_name
        FROM videos v
        JOIN users u ON u.id = v.creator_id
        WHERE v.category = $1 AND v.status = 'published' AND v.id != $2
        ORDER BY v.created_at DESC
        LIMIT 6
      `, [video.category, video.id]);

      res.json({ success: true, video, creator, viewer, related_videos: related });
    } catch (err) {
      console.error('video fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch video' });
    }
  }
);


// ============================================================
//  ENGAGEMENT: likes, comments, subscriptions
// ============================================================

// Shared guard: the video must exist and be published before any
// engagement writes land on it.
async function getPublishedVideo(videoId) {
  const { rows } = await db.query(
    `SELECT id, creator_id FROM videos WHERE id = $1 AND status = 'published'`,
    [videoId]
  );
  return rows[0] ?? null;
}

// ── POST /api/video/:id/like ──────────────────────────────────
// Idempotent: liking an already-liked video is a no-op success, not an
// error (ON CONFLICT DO NOTHING against the UNIQUE(video_id, user_id)).
// The like_count trigger recounts from video_likes on insert/delete.
router.post('/video/:id/like',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      const video = await getPublishedVideo(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      await db.query(`
        INSERT INTO video_likes (video_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT (video_id, user_id) DO NOTHING
      `, [video.id, req.user.id]);

      const { rows } = await db.query('SELECT like_count FROM videos WHERE id = $1', [video.id]);
      res.json({ success: true, liked: true, like_count: rows[0].like_count });
    } catch (err) {
      console.error('like error:', err.message);
      res.status(500).json({ error: 'Could not like video' });
    }
  }
);

// ── DELETE /api/video/:id/like ────────────────────────────────
router.delete('/video/:id/like',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      await db.query(
        'DELETE FROM video_likes WHERE video_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      const { rows } = await db.query('SELECT like_count FROM videos WHERE id = $1', [req.params.id]);
      res.json({ success: true, liked: false, like_count: rows[0]?.like_count ?? 0 });
    } catch (err) {
      console.error('unlike error:', err.message);
      res.status(500).json({ error: 'Could not unlike video' });
    }
  }
);

// ── POST /api/video/:id/save ──────────────────────────────────
// Bookmarking — same idempotent shape as like/unlike above, against
// saved_videos (2026-08-17-saved-videos.sql). No counter column: no UI
// anywhere shows a "save count", unlike like_count.
router.post('/video/:id/save',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      const video = await getPublishedVideo(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      await db.query(`
        INSERT INTO saved_videos (video_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT (video_id, user_id) DO NOTHING
      `, [video.id, req.user.id]);

      res.json({ success: true, saved: true });
    } catch (err) {
      console.error('save error:', err.message);
      res.status(500).json({ error: 'Could not save video' });
    }
  }
);

// ── DELETE /api/video/:id/save ────────────────────────────────
router.delete('/video/:id/save',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid video ID')],
  validate,
  async (req, res) => {
    try {
      await db.query(
        'DELETE FROM saved_videos WHERE video_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      res.json({ success: true, saved: false });
    } catch (err) {
      console.error('unsave error:', err.message);
      res.status(500).json({ error: 'Could not unsave video' });
    }
  }
);

// ── POST /api/video/:id/comments ──────────────────────────────
// One level of nesting only: a reply's parent must be a top-level
// comment on the same video. Rate-limited to 5/min in server.js
// (registered before the global limiter, per the mount-order pattern).
router.post('/video/:id/comments',
  requireAuth,
  [
    param('id').isUUID().withMessage('Invalid video ID'),
    body('body')
      .isString().trim().isLength({ min: 1, max: 2000 })
      .withMessage('Comment must be 1–2000 characters'),
    body('parentCommentId')
      .optional()
      .isUUID().withMessage('Invalid parent comment ID'),
  ],
  validate,
  async (req, res) => {
    try {
      const video = await getPublishedVideo(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      const { body: commentBody, parentCommentId } = req.body;

      if (parentCommentId) {
        const { rows: parents } = await db.query(
          `SELECT id, video_id, parent_comment_id, status FROM comments WHERE id = $1`,
          [parentCommentId]
        );
        const parent = parents[0];
        if (!parent || parent.video_id !== video.id || parent.status === 'hidden') {
          return res.status(404).json({ error: 'Comment not found' });
        }
        if (parent.parent_comment_id !== null) {
          return res.status(400).json({ error: 'Replies to replies are not supported' });
        }
      }

      const { rows } = await db.query(`
        INSERT INTO comments (video_id, user_id, parent_comment_id, body)
        VALUES ($1, $2, $3, $4)
        RETURNING id, video_id, parent_comment_id, body, status, created_at
      `, [video.id, req.user.id, parentCommentId ?? null, commentBody]);

      const comment = {
        ...rows[0],
        is_own: true,
        user: {
          id: req.user.id,
          username: req.user.username,
          display_name: req.user.username, // display_name isn't on req.user; frontend falls back
          avatar_url: null,
        },
      };
      // Fill real display name + avatar for the response
      const { rows: u } = await db.query(
        'SELECT display_name, avatar_url FROM users WHERE id = $1', [req.user.id]
      );
      if (u[0]) {
        comment.user.display_name = u[0].display_name;
        comment.user.avatar_url = u[0].avatar_url;
      }

      res.status(201).json({ success: true, comment });
    } catch (err) {
      console.error('comment create error:', err.message);
      res.status(500).json({ error: 'Could not post comment' });
    }
  }
);

// ── GET /api/video/:id/comments?page=&limit= ──────────────────
// Public. Top-level comments newest-first, replies nested oldest-first.
// Soft-deleted top-level comments are kept (body → null) so their
// replies don't orphan; deleted replies and anything 'hidden' are
// omitted entirely.
router.get('/video/:id/comments',
  optionalAuth,
  [
    param('id').isUUID().withMessage('Invalid video ID'),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
  ],
  validate,
  async (req, res) => {
    try {
      const page   = parseInt(req.query.page ?? '1', 10);
      const limit  = parseInt(req.query.limit ?? '20', 10);
      const offset = (page - 1) * limit;
      const viewerId = req.user?.id ?? null;

      const { rows: parents } = await db.query(`
        SELECT c.id, c.parent_comment_id, c.status, c.created_at,
               CASE WHEN c.status = 'deleted' THEN NULL ELSE c.body END AS body,
               (c.user_id = $4) AS is_own,
               u.id AS u_id, u.username, u.display_name, u.avatar_url
        FROM comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.video_id = $1
          AND c.parent_comment_id IS NULL
          AND c.status <> 'hidden'
        ORDER BY c.created_at DESC
        LIMIT $2 OFFSET $3
      `, [req.params.id, limit + 1, offset, viewerId]);

      const hasMore = parents.length > limit;
      const pageParents = parents.slice(0, limit);

      let repliesByParent = {};
      if (pageParents.length) {
        const parentIds = pageParents.map((p) => p.id);
        const { rows: replies } = await db.query(`
          SELECT c.id, c.parent_comment_id, c.status, c.created_at, c.body,
                 (c.user_id = $2) AS is_own,
                 u.id AS u_id, u.username, u.display_name, u.avatar_url
          FROM comments c
          JOIN users u ON u.id = c.user_id
          WHERE c.parent_comment_id = ANY($1)
            AND c.status = 'visible'
          ORDER BY c.created_at ASC
        `, [parentIds, viewerId]);

        repliesByParent = replies.reduce((acc, r) => {
          (acc[r.parent_comment_id] ??= []).push(shapeComment(r));
          return acc;
        }, {});
      }

      function shapeComment(r) {
        return {
          id: r.id,
          parent_comment_id: r.parent_comment_id,
          body: r.body,
          status: r.status,
          created_at: r.created_at,
          is_own: r.is_own === true,
          user: { id: r.u_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url },
        };
      }

      const comments = pageParents.map((p) => ({
        ...shapeComment(p),
        replies: repliesByParent[p.id] ?? [],
      }));

      const { rows: counts } = await db.query(
        'SELECT comment_count FROM videos WHERE id = $1', [req.params.id]
      );

      res.json({
        success: true,
        comments,
        comment_count: counts[0]?.comment_count ?? 0,
        has_more: hasMore,
        page,
      });
    } catch (err) {
      console.error('comments fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch comments' });
    }
  }
);

// ── DELETE /api/comments/:id ──────────────────────────────────
// Soft delete of the caller's OWN comment: status → 'deleted', row kept
// so replies don't orphan. The comment_count trigger recounts (only
// 'visible' rows count). Responses always null the body of deleted rows.
router.delete('/comments/:id',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid comment ID')],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        UPDATE comments SET status = 'deleted'
        WHERE id = $1 AND user_id = $2 AND status = 'visible'
        RETURNING id
      `, [req.params.id, req.user.id]);

      if (!rows.length) {
        // Either it doesn't exist, isn't theirs, or is already deleted/hidden.
        const { rows: exists } = await db.query(
          'SELECT user_id FROM comments WHERE id = $1', [req.params.id]
        );
        if (exists.length && exists[0].user_id !== req.user.id) {
          return res.status(403).json({ error: 'You can only delete your own comments' });
        }
        return res.status(404).json({ error: 'Comment not found' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('comment delete error:', err.message);
      res.status(500).json({ error: 'Could not delete comment' });
    }
  }
);

// ── POST /api/creator/:id/subscribe ───────────────────────────
// Idempotent, like the like route. The DB CHECK also blocks
// self-subscription, but we return a friendly 400 before hitting it.
router.post('/creator/:id/subscribe',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid creator ID')],
  validate,
  async (req, res) => {
    try {
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot subscribe to yourself' });
      }
      const { rows: target } = await db.query(
        `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
        [req.params.id]
      );
      if (!target.length) return res.status(404).json({ error: 'Creator not found' });

      await db.query(`
        INSERT INTO subscriptions (creator_id, subscriber_id)
        VALUES ($1, $2)
        ON CONFLICT (creator_id, subscriber_id) DO NOTHING
      `, [req.params.id, req.user.id]);

      const { rows } = await db.query(
        'SELECT COALESCE(follower_count, 0) AS follower_count FROM users WHERE id = $1',
        [req.params.id]
      );
      res.json({ success: true, subscribed: true, follower_count: rows[0].follower_count });
    } catch (err) {
      console.error('subscribe error:', err.message);
      res.status(500).json({ error: 'Could not subscribe' });
    }
  }
);

// ── DELETE /api/creator/:id/subscribe ─────────────────────────
router.delete('/creator/:id/subscribe',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid creator ID')],
  validate,
  async (req, res) => {
    try {
      await db.query(
        'DELETE FROM subscriptions WHERE creator_id = $1 AND subscriber_id = $2',
        [req.params.id, req.user.id]
      );
      const { rows } = await db.query(
        'SELECT COALESCE(follower_count, 0) AS follower_count FROM users WHERE id = $1',
        [req.params.id]
      );
      res.json({ success: true, subscribed: false, follower_count: rows[0]?.follower_count ?? 0 });
    } catch (err) {
      console.error('unsubscribe error:', err.message);
      res.status(500).json({ error: 'Could not unsubscribe' });
    }
  }
);

// ── Tiered reporting ───────────────────────────────────────────
// Reports are self-selected into one of nine plain-language categories
// by the reporter. 'copyright' never reaches this tier logic at all —
// see the route below, which intercepts it before any DB write.
const REPORT_CATEGORIES = [
  'nudity', 'minors', 'violence', 'animal_cruelty', 'hate_speech',
  'misinformation', 'spam', 'copyright', 'other',
];

// Number of *pending* (unresolved) reports the lowest-severity tier
// needs before a video is auto-hidden and sent back through AWS
// Rekognition. Read once at startup — restart the process to pick up a
// changed REPORT_THRESHOLD.
const REPORT_THRESHOLD = parseInt(process.env.REPORT_THRESHOLD, 10) || 3;

// Each category belongs to exactly one severity tier. Thresholds count
// only *pending* reports (resolved_at IS NULL) in that tier's categories
// for the video being reported — once an admin resolves a case, those
// reports stop counting, so a video that was reviewed and restored isn't
// permanently primed to re-trigger from stale history.
//
// The two higher-severity tiers hide the video and alert admins for
// immediate human review, deliberately WITHOUT triggering the automated
// Rekognition re-review — a wrongly-cleared AI re-scan auto-republishing
// a nudity/minors or violence/animal_cruelty report would be dangerous
// for exactly the categories where speed-to-human-eyes matters most.
// Only the lowest tier (the pre-existing behavior) keeps the AI re-check.
const REPORT_TIERS = [
  { categories: ['nudity', 'minors'], threshold: 1, triggersAiReview: false },
  { categories: ['violence', 'animal_cruelty'], threshold: 2, triggersAiReview: false },
  { categories: ['hate_speech', 'misinformation', 'spam', 'other'], threshold: REPORT_THRESHOLD, triggersAiReview: true },
];

function reportTierForCategory(category) {
  return REPORT_TIERS.find((tier) => tier.categories.includes(category)) ?? null;
}

// Re-runs the same thumbnail-based Rekognition check the old upload-time
// moderateVideo() used to (removed — see the NOTE above the videos
// CREATE TABLE comment), but for an already-published video that just
// crossed the lowest report tier's threshold. Always emails the admin
// with the outcome. Never throws — covers its own DB/Rekognition/email
// failures so the caller (the report route, which does not await this)
// can't be broken by it.
async function moderateReportedVideo(videoId, cloudflareVideoId) {
  let videoInfo;
  try {
    const { rows } = await db.query(`
      SELECT v.title,
             COALESCE(u.display_name, u.username, 'Unknown') AS creator_name,
             (SELECT COUNT(*)::int FROM video_reports vr WHERE vr.video_id = v.id AND vr.resolved_at IS NULL) AS pending_report_count
      FROM videos v
      LEFT JOIN users u ON u.id = v.creator_id
      WHERE v.id = $1
    `, [videoId]);
    videoInfo = rows[0];
  } catch (err) {
    console.error('moderateReportedVideo: could not load video context:', err.message);
    return;
  }
  if (!videoInfo) return;

  const details = `
    <ul>
      <li><strong>Title:</strong> ${escapeHtml(videoInfo.title)}</li>
      <li><strong>Creator:</strong> ${escapeHtml(videoInfo.creator_name)}</li>
      <li><strong>Pending reports:</strong> ${videoInfo.pending_report_count}</li>
  `;

  try {
    const thumbnailUrl = `https://videodelivery.net/${cloudflareVideoId}/thumbnails/thumbnail.jpg`;
    const imageRes = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const imageBytes = Buffer.from(imageRes.data);

    const result = await rekognition.send(new DetectModerationLabelsCommand({
      Image: { Bytes: imageBytes },
      MinConfidence: 75,
    }));
    const labels = result.ModerationLabels || [];

    if (labels.length > 0) {
      await db.query(`UPDATE videos SET status = 'rejected' WHERE id = $1`, [videoId]);
      const labelList = labels.map((l) => `${escapeHtml(l.Name)} (${l.Confidence.toFixed(1)}%)`).join(', ');
      await sendAdminEmail(
        'Video Rejected by AI',
        `<p>A reported video was automatically rejected after AI re-review and remains hidden.</p>${details}
         <li><strong>Labels found:</strong> ${labelList}</li></ul>`
      );
    } else {
      await db.query(`UPDATE videos SET status = 'published' WHERE id = $1`, [videoId]);
      await sendAdminEmail(
        'Reported Video Cleared by AI',
        `<p>A reported video passed AI re-review and has been republished.</p>${details}</ul>`
      );
    }
  } catch (err) {
    console.error('moderateReportedVideo error (video stays under_review):', err.response?.data ?? err.message);
    await sendAdminEmail(
      'Video Needs Manual Review',
      `<p>AI re-review failed for a reported video — it is hidden (status 'under_review') pending manual review.</p>${details}
       <li><strong>Error:</strong> ${escapeHtml(err.message || 'Unknown error')}</li></ul>`
    );
  }
}

// Matches the frontend's terms/page.tsx LEGAL_CONTACT constant — not
// sourced from an env var, same as that page's hardcoded value.
const LEGAL_CONTACT_EMAIL = 'legal@zuva.tv';

// ── POST /api/video/:id/report ───────────────────────────────
router.post('/video/:id/report',
  optionalAuth,
  [
    param('id').isUUID().withMessage('Invalid video ID'),
    body('category').isIn(REPORT_CATEGORIES).withMessage('Invalid report category'),
    body('additional_details').optional().trim().isLength({ max: 1000 }).withMessage('Details must be at most 1000 characters'),
  ],
  validate,
  async (req, res) => {
    // Copyright isn't handled through the report pipeline — no
    // video_reports row is written for it. Point the reporter at the
    // existing takedown-notice process instead (see terms/page.tsx
    // section 13, "or to submit a copyright takedown notice").
    if (req.body.category === 'copyright') {
      return res.json({
        success: true,
        redirect: 'copyright_process',
        contactEmail: LEGAL_CONTACT_EMAIL,
        message: `Copyright issues are handled through our takedown notice process, not this form. Please email ${LEGAL_CONTACT_EMAIL} with the details.`,
      });
    }

    try {
      const videoCheck = await db.query(
        'SELECT id, cloudflare_video_id, title FROM videos WHERE id = $1',
        [req.params.id]
      );
      if (!videoCheck.rows.length) return res.status(404).json({ error: 'Video not found' });
      const video = videoCheck.rows[0];
      const category = req.body.category;

      await db.query(
        'INSERT INTO video_reports (video_id, reporter_id, category, additional_details) VALUES ($1, $2, $3, $4)',
        [video.id, req.user?.id || null, category, req.body.additional_details || null]
      );

      const tier = reportTierForCategory(category);
      const { rows: countRows } = await db.query(
        `SELECT COUNT(*)::int AS count FROM video_reports
         WHERE video_id = $1 AND category = ANY($2::text[]) AND resolved_at IS NULL`,
        [video.id, tier.categories]
      );
      const tierPendingCount = countRows[0].count;
      const thresholdReached = tierPendingCount >= tier.threshold;

      if (thresholdReached) {
        await db.query(`UPDATE videos SET status = 'under_review' WHERE id = $1`, [video.id]);

        if (tier.triggersAiReview) {
          // Not awaited — moderateReportedVideo does its own thumbnail
          // fetch, AWS call, and email send, none of which the reporting
          // user should have to wait on. It has full internal error
          // handling and never throws, but .catch() here is a defensive
          // backstop.
          moderateReportedVideo(video.id, video.cloudflare_video_id).catch((err) => {
            console.error('moderateReportedVideo unexpected error:', err.message);
          });
        } else {
          // High-severity tiers — hide immediately, alert admins for
          // priority human review, no automated re-review/re-publish path.
          sendAdminEmail(
            'PRIORITY: Video Hidden — Needs Immediate Review',
            `<p>A video was automatically hidden after reaching the report threshold for a high-severity category.</p>
             <ul>
               <li><strong>Title:</strong> ${escapeHtml(video.title)}</li>
               <li><strong>Category:</strong> ${escapeHtml(category)}</li>
               <li><strong>Pending reports in this category group:</strong> ${tierPendingCount}</li>
             </ul>`
          ).catch((err) => console.error('priority report email failed:', err.message));
        }
      }

      res.status(201).json({
        success: true,
        category,
        tier_pending_count: tierPendingCount,
        threshold_reached: thresholdReached,
      });
    } catch (err) {
      console.error('video report error:', err.message);
      res.status(500).json({ error: 'Could not submit report' });
    }
  }
);


// ============================================================
//  ADMIN ROUTES
//  All routes below require requireAdmin (bridged from server.js —
//  see the note above its definition): real Clerk JWT verification via
//  requireAuth, then a role === 'admin' check against the users row.
// ============================================================

// ── GET /api/admin/applications ──────────────────────────────
router.get('/admin/applications', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, full_name, email, country, primary_platform, social_handle,
             content_category, follower_count, status, created_at,
             awaiting_signup, approved_user_id, confirmed_at
      FROM creator_applications
      ORDER BY created_at DESC
    `);
    res.json({ success: true, applications: rows });
  } catch (err) {
    console.error('admin applications fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch applications' });
  }
});

// ── PATCH /api/admin/applications/:id ────────────────────────
// Approval actually makes the applicant a creator, atomically:
//   • users row matched by email (case-insensitive) → role = 'creator'
//     (admins keep their role) + application linked via approved_user_id
//   • no users row yet → awaiting_signup = TRUE; the self-healing user
//     creation in requireAuth applies the creator role at first sign-in
// Applicants get an on-brand approval/rejection email after commit.
router.patch('/admin/applications/:id',
  requireAdmin,
  [
    // The live creator_applications.id column is UUID (verified in
    // Supabase 2026-07-26) — an isInt() here 422'd every approval.
    param('id').isUUID().withMessage('Invalid application ID'),
    body('status').isIn(['approved', 'rejected']).withMessage('Invalid status'),
  ],
  validate,
  async (req, res) => {
    const targetStatus = req.body.status;
    const client = await db.connect();
    let application;
    try {
      await client.query('BEGIN');

      const { rows: apps } = await client.query(
        `SELECT id, full_name, email, status FROM creator_applications WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!apps.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Application not found' });
      }
      application = apps[0];

      if (targetStatus === 'approved') {
        const { rows: users } = await client.query(
          `SELECT id, role FROM users
           WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1`,
          [application.email]
        );

        if (users.length) {
          const user = users[0];
          if (user.role !== 'creator' && user.role !== 'admin') {
            await client.query(
              `UPDATE users SET role = 'creator' WHERE id = $1`,
              [user.id]
            );
          }
          await client.query(
            `UPDATE creator_applications
             SET status = 'approved', approved_user_id = $1, awaiting_signup = FALSE
             WHERE id = $2`,
            [user.id, application.id]
          );
          application.approved_user_id = user.id;
          application.awaiting_signup = false;
        } else {
          // Applicant hasn't signed in to zuva.tv yet — approval still
          // lands; first sign-in picks it up (see ensureUser in requireAuth).
          await client.query(
            `UPDATE creator_applications
             SET status = 'approved', approved_user_id = NULL, awaiting_signup = TRUE
             WHERE id = $1`,
            [application.id]
          );
          application.approved_user_id = null;
          application.awaiting_signup = true;
        }
      } else {
        await client.query(
          `UPDATE creator_applications
           SET status = 'rejected', awaiting_signup = FALSE
           WHERE id = $1`,
          [application.id]
        );
        application.awaiting_signup = false;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('admin application update error:', err.message);
      return res.status(500).json({ error: 'Could not update application' });
    } finally {
      client.release();
    }

    // ── Applicant email — after commit, never blocks the response ──
    const appUrl = process.env.APP_URL || 'https://zuva.tv';
    const firstName = escapeHtml(application.full_name.split(' ')[0]);
    if (targetStatus === 'approved') {
      sendApplicantEmail(
        application.email,
        "Welcome to Zuva — you're approved! ☀️",
        brandedEmailHtml({
          heading: `You're in, ${firstName}!`,
          paragraphs: [
            `Your creator application has been <strong style="color:#f37b0d;">approved</strong> — welcome to the Zuva creator family.`,
            application.awaiting_signup
              ? `Sign in at zuva.tv with this email address (${escapeHtml(application.email)}) and your creator access will be ready the moment you arrive.`
              : `Your account has been upgraded — sign in and you'll find your channel and upload tools waiting.`,
            `Upload your first video, grow your audience across Africa, the Caribbean, and the diaspora, and earn Suns from day one.`,
          ],
          ctaText: 'Sign In & Start Creating',
          ctaUrl: `${appUrl}/sign-in`,
        })
      );
    } else {
      sendApplicantEmail(
        application.email,
        'An update on your Zuva creator application',
        brandedEmailHtml({
          heading: `Thank you for applying, ${firstName}`,
          paragraphs: [
            `After careful review, we aren't able to approve your creator application right now.`,
            `This isn't a closed door — creators grow, and so do we. You're warmly invited to reapply in the future as your content and audience develop.`,
            `In the meantime, you're always welcome on Zuva as a viewer — watch, tip, and support the creators you love.`,
          ],
          ctaText: 'Visit Zuva',
          ctaUrl: appUrl,
        })
      );
    }

    res.json({
      success: true,
      application: {
        id: application.id,
        status: targetStatus,
        approved_user_id: application.approved_user_id ?? null,
        awaiting_signup: application.awaiting_signup ?? false,
      },
    });
  }
);

// ── GET /api/admin/content ───────────────────────────────────
// Content lives in three tables — vertical_content, landscape_content
// (the older CloudFront-based system), and videos (Cloudflare Stream
// uploads, orientation tagged 'upload') — this unions all three and tags
// each row with its orientation so the PATCH/DELETE routes below know
// which table to act on. `status` reflects moderation_status for the
// older tables and the AWS Rekognition-driven `status` column for videos
// (see moderateVideo() and GET /admin/moderation-queue).
//
// Run these migrations if your tables predate the admin dashboard:
//   ALTER TABLE vertical_content  ADD COLUMN IF NOT EXISTS reports_count INTEGER NOT NULL DEFAULT 0;
//   ALTER TABLE landscape_content ADD COLUMN IF NOT EXISTS reports_count INTEGER NOT NULL DEFAULT 0;
// If moderation_status has a CHECK constraint, make sure 'flagged' is
// included alongside pending/approved/rejected.
router.get('/admin/content', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.orientation, c.title, c.creator_id,
             COALESCE(u.display_name, u.username, 'Unknown') AS creator_name,
             c.published_at, c.status,
             c.reports_count
      FROM (
        SELECT id, 'vertical'::text AS orientation, title, creator_id, published_at,
               moderation_status AS status, COALESCE(reports_count, 0) AS reports_count
        FROM vertical_content
        UNION ALL
        SELECT id, 'landscape'::text AS orientation, title, creator_id, published_at,
               moderation_status AS status, COALESCE(reports_count, 0) AS reports_count
        FROM landscape_content
        UNION ALL
        SELECT v.id, 'upload'::text AS orientation, v.title, v.creator_id, v.created_at AS published_at,
               v.status,
               (SELECT COUNT(*) FROM video_reports vr WHERE vr.video_id = v.id) AS reports_count
        FROM videos v
      ) c
      LEFT JOIN users u ON u.id = c.creator_id
      ORDER BY c.published_at DESC NULLS LAST
    `);
    res.json({ success: true, content: rows });
  } catch (err) {
    console.error('admin content fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch content' });
  }
});

// Whitelist for the admin content routes below — orientation is validated
// via isIn() first, then only ever used as a key into these fixed maps, so
// the table/column names spliced into SQL below can never be arbitrary input.
const ADMIN_CONTENT_TABLE_BY_ORIENTATION = {
  vertical:  'vertical_content',
  landscape: 'landscape_content',
  upload:    'videos',
};
const ADMIN_CONTENT_STATUS_COLUMN_BY_ORIENTATION = {
  vertical:  'moderation_status',
  landscape: 'moderation_status',
  upload:    'status',
};

// ── PATCH /api/admin/content/:id?orientation=vertical|landscape|upload ──
// Status vocabulary differs by table and is passed straight through
// without translation: vertical/landscape use pending/approved/rejected/
// flagged (moderation_status column); videos use pending/published/
// rejected/flagged (status column). Send the value matching the table
// you're targeting.
router.patch('/admin/content/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid content ID'),
    query('orientation').isIn(['vertical', 'landscape', 'upload']).withMessage('orientation query param is required'),
    body('status').isIn(['pending', 'approved', 'published', 'rejected', 'flagged', 'under_review']).withMessage('Invalid status'),
  ],
  validate,
  async (req, res) => {
    const table = ADMIN_CONTENT_TABLE_BY_ORIENTATION[req.query.orientation];
    const statusColumn = ADMIN_CONTENT_STATUS_COLUMN_BY_ORIENTATION[req.query.orientation];
    try {
      const { rows } = await db.query(
        `UPDATE ${table} SET ${statusColumn} = $1 WHERE id = $2 RETURNING id, ${statusColumn} AS status`,
        [req.body.status, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Content not found' });
      res.json({ success: true, content: rows[0] });
    } catch (err) {
      console.error('admin content update error:', err.message);
      res.status(500).json({ error: 'Could not update content' });
    }
  }
);

// ── DELETE /api/admin/content/:id?orientation=vertical|landscape|upload ──
// vertical_content/landscape_content: soft-deletes (sets deleted_at)
// instead of a hard DELETE, so it doesn't break FK references from tips/
// ledger_entries. The public feed queries already filter on
// deleted_at IS NULL, so this hides the content immediately.
// videos: has no deleted_at column and visibility is already gated purely
// by status = 'published' (see /api/channel/:username and /api/video/:id),
// so "remove" just sets status = 'rejected' — equally immediate, no schema
// change needed.
router.delete('/admin/content/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid content ID'),
    query('orientation').isIn(['vertical', 'landscape', 'upload']).withMessage('orientation query param is required'),
  ],
  validate,
  async (req, res) => {
    try {
      let rows;
      if (req.query.orientation === 'upload') {
        ({ rows } = await db.query(
          `UPDATE videos SET status = 'rejected' WHERE id = $1 RETURNING id`,
          [req.params.id]
        ));
      } else {
        const table = ADMIN_CONTENT_TABLE_BY_ORIENTATION[req.query.orientation];
        ({ rows } = await db.query(
          `UPDATE ${table} SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          [req.params.id]
        ));
      }
      if (!rows.length) return res.status(404).json({ error: 'Content not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('admin content delete error:', err.message);
      res.status(500).json({ error: 'Could not remove content' });
    }
  }
);

// ── GET /api/admin/moderation-queue ──────────────────────────
// Videos actively needing admin attention: 'under_review' (report-
// triggered — see moderateReportedVideo(); includes videos AI re-review
// couldn't resolve, left there deliberately for manual follow-up) and
// 'flagged' (not currently produced by any automated path, reserved for
// future use — see the NOTE above the videos CREATE TABLE comment).
// 'rejected' is intentionally excluded: it's a terminal, already-hidden
// state that doesn't need further action.
router.get('/admin/moderation-queue', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.id, v.title, v.status, v.cloudflare_video_id, v.thumbnail_url, v.category, v.created_at,
             v.creator_id, COALESCE(u.display_name, u.username, 'Unknown') AS creator_name,
             (SELECT COUNT(*)::int FROM video_reports vr WHERE vr.video_id = v.id) AS reports_count
      FROM videos v
      LEFT JOIN users u ON u.id = v.creator_id
      WHERE v.status IN ('under_review', 'flagged')
      ORDER BY reports_count DESC
    `);
    res.json({ success: true, videos: rows });
  } catch (err) {
    console.error('moderation queue fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch moderation queue' });
  }
});

// ── GET /api/admin/reports ───────────────────────────────────
// Paginated report queue — the primary interface for the tiered
// reporting system (see REPORT_TIERS / POST /video/:id/report above).
// Distinct from GET /admin/moderation-queue (video-centric, shows
// videos currently under_review) — this is report-centric, showing
// individual report rows so admins can work a specific category's
// backlog and see reporter-supplied details.
router.get('/admin/reports',
  requireAdmin,
  [
    query('category').optional().isIn(REPORT_CATEGORIES).withMessage('Invalid category'),
    query('status').optional().isIn(['pending', 'resolved']).withMessage('status must be pending or resolved'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  validate,
  async (req, res) => {
    const page   = req.query.page || 1;
    const limit  = req.query.limit || 20;
    const offset = (page - 1) * limit;
    const status   = req.query.status || 'pending';
    const category = req.query.category || null;

    try {
      const { rows } = await db.query(`
        SELECT vr.id, vr.video_id, vr.category, vr.additional_details, vr.created_at,
               vr.resolved_at, vr.resolution,
               v.title AS video_title, v.status AS video_status, v.thumbnail_url,
               v.creator_id, COALESCE(cu.display_name, cu.username, 'Unknown') AS creator_name,
               vr.reporter_id, COALESCE(ru.display_name, ru.username) AS reporter_name
        FROM video_reports vr
        JOIN videos v ON v.id = vr.video_id
        LEFT JOIN users cu ON cu.id = v.creator_id
        LEFT JOIN users ru ON ru.id = vr.reporter_id
        WHERE ($3::text IS NULL OR vr.category = $3)
          AND (
            ($4 = 'pending'  AND vr.resolved_at IS NULL)
            OR ($4 = 'resolved' AND vr.resolved_at IS NOT NULL)
          )
        ORDER BY vr.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit + 1, offset, category, status]);

      const hasMore = rows.length > limit;
      res.json({ success: true, reports: rows.slice(0, limit), page, limit, has_more: hasMore });
    } catch (err) {
      console.error('admin reports fetch error:', err.message);
      res.status(500).json({ error: 'Could not fetch reports' });
    }
  }
);

// ── GET /api/admin/reports/stats ─────────────────────────────
// Defaults to the last 30 days if from/to aren't given. Category counts
// are scoped by when the report was *filed* (created_at); resolution
// time and the restored/removed ratio are scoped by when it was
// *resolved* (resolved_at) — a report filed just before the range but
// resolved inside it still counts toward resolution stats, not category
// volume, which is the more intuitive read for each respectively.
router.get('/admin/reports/stats',
  requireAdmin,
  [
    query('from').optional().isISO8601().withMessage('from must be an ISO date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO date'),
  ],
  validate,
  async (req, res) => {
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    try {
      const { rows: byCategory } = await db.query(`
        SELECT category, COUNT(*)::int AS count
        FROM video_reports
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY category
        ORDER BY count DESC
      `, [from, to]);

      const { rows: resolutionRows } = await db.query(`
        SELECT
          COUNT(*)::int AS resolved_count,
          COUNT(*) FILTER (WHERE resolution = 'restored')::int AS restored_count,
          COUNT(*) FILTER (WHERE resolution = 'removed')::int  AS removed_count,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::float AS avg_resolution_seconds
        FROM video_reports
        WHERE resolved_at IS NOT NULL AND resolved_at BETWEEN $1 AND $2
      `, [from, to]);

      res.json({
        success: true,
        range: { from: from.toISOString(), to: to.toISOString() },
        by_category: byCategory,
        resolved_count: resolutionRows[0].resolved_count,
        restored_count: resolutionRows[0].restored_count,
        removed_count: resolutionRows[0].removed_count,
        avg_resolution_seconds: resolutionRows[0].avg_resolution_seconds,
      });
    } catch (err) {
      console.error('admin reports stats error:', err.message);
      res.status(500).json({ error: 'Could not fetch report stats' });
    }
  }
);

// ── POST /api/admin/reports/:id/resolve ──────────────────────
// Resolving one report closes out every still-pending report against
// the same video — an admin reviewing a case is deciding the video's
// fate, not adjudicating each report row individually (multiple people
// may have reported the same video for the same or different reasons).
// 'removed' -> videos.status = 'rejected' (the existing terminal hidden
// state) and increments the creator's users.violation_count for
// repeat-violation tracking (feeds a future enforcement ladder — see the
// migration's NOTE; no such ladder exists yet to act on the count).
// 'restored' -> videos.status = 'published'.
router.post('/admin/reports/:id/resolve',
  requireAdmin,
  [
    param('id').isInt().withMessage('Invalid report ID'),
    body('resolution').isIn(['restored', 'removed']).withMessage('resolution must be restored or removed'),
  ],
  validate,
  async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: reportRows } = await client.query(
        'SELECT video_id FROM video_reports WHERE id = $1',
        [req.params.id]
      );
      if (!reportRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Report not found' });
      }
      const videoId = reportRows[0].video_id;
      const resolution = req.body.resolution;

      const { rows: closedReports } = await client.query(
        `UPDATE video_reports
         SET resolved_at = NOW(), resolution = $2
         WHERE video_id = $1 AND resolved_at IS NULL
         RETURNING id`,
        [videoId, resolution]
      );

      const newStatus = resolution === 'removed' ? 'rejected' : 'published';
      const { rows: videoRows } = await client.query(
        `UPDATE videos SET status = $2 WHERE id = $1 RETURNING id, creator_id`,
        [videoId, newStatus]
      );
      if (!videoRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Video not found' });
      }
      const video = videoRows[0];

      if (resolution === 'removed') {
        await client.query(
          'UPDATE users SET violation_count = violation_count + 1 WHERE id = $1',
          [video.creator_id]
        );
      }

      await client.query('COMMIT');
      res.json({
        success: true,
        video_id: videoId,
        new_status: newStatus,
        resolution,
        reports_closed: closedReports.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('admin report resolve error:', err.message);
      res.status(500).json({ error: 'Could not resolve report' });
    } finally {
      client.release();
    }
  }
);

// ── GET /api/admin/comments ──────────────────────────────────
// Recent comments across all videos (newest first, capped at 100) so
// admins can spot abuse. Includes hidden/deleted for full visibility.
router.get('/admin/comments', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.body, c.status, c.created_at, c.parent_comment_id,
             c.video_id, v.title AS video_title,
             c.user_id, COALESCE(u.display_name, u.username, 'Unknown') AS commenter_name,
             u.email AS commenter_email
      FROM comments c
      LEFT JOIN videos v ON v.id = c.video_id
      LEFT JOIN users  u ON u.id = c.user_id
      ORDER BY c.created_at DESC
      LIMIT 100
    `);
    res.json({ success: true, comments: rows });
  } catch (err) {
    console.error('admin comments fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch comments' });
  }
});

// ── PATCH /api/admin/comments/:id ────────────────────────────
// Moderation toggle: 'hidden' pulls a comment (and its replies, which
// the list queries exclude when the parent is hidden) from public view;
// 'visible' restores it. 'deleted' stays user-only — admins hide.
router.patch('/admin/comments/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid comment ID'),
    body('status').isIn(['visible', 'hidden']).withMessage('Status must be visible or hidden'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(`
        UPDATE comments SET status = $1
        WHERE id = $2 AND status <> 'deleted'
        RETURNING id, status
      `, [req.body.status, req.params.id]);

      if (!rows.length) return res.status(404).json({ error: 'Comment not found' });
      res.json({ success: true, comment: rows[0] });
    } catch (err) {
      console.error('admin comment status error:', err.message);
      res.status(500).json({ error: 'Could not update comment' });
    }
  }
);

// ── GET /api/admin/users ─────────────────────────────────────
// Assumes users has email, country_code, role, created_at columns
// (evidenced elsewhere in this file) plus a status column for
// suspension, which likely needs adding:
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
//   ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended'));
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, display_name, email, country_code, role, status, created_at
      FROM users
      ORDER BY created_at DESC
    `);
    res.json({ success: true, users: rows });
  } catch (err) {
    console.error('admin users fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

// ── PATCH /api/admin/users/:id ───────────────────────────────
// Suspended users are expected to be blocked at login/upload time by
// checking this status column — that check lives wherever auth and
// upload requests are handled (the requireAuth shim here is a stand-in
// until real session verification is wired up).
router.patch('/admin/users/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid user ID'),
    body('status').isIn(['active', 'suspended']).withMessage('Invalid status'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE users SET status = $1 WHERE id = $2 RETURNING id, status`,
        [req.body.status, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('admin user update error:', err.message);
      res.status(500).json({ error: 'Could not update user' });
    }
  }
);

// ── DELETE /api/admin/users/:id ──────────────────────────────
// Permanently deletes the account, as specified. If the user has related
// financial rows (wallets, tips, ledger entries), this fails with a
// foreign-key violation (Postgres code 23503) rather than silently
// cascading — surfaced as 409 so the admin can suspend instead of
// destroying ledger history.
router.delete('/admin/users/:id',
  requireAdmin,
  [param('id').isUUID().withMessage('Invalid user ID')],
  validate,
  async (req, res) => {
    try {
      const { rowCount } = await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({
          error: 'Cannot permanently delete a user with existing wallet or transaction history. Suspend the account instead.',
        });
      }
      console.error('admin user delete error:', err.message);
      res.status(500).json({ error: 'Could not delete user' });
    }
  }
);


// ============================================================
//  ADMIN ANALYTICS
// ============================================================
//  Three read-only dashboards. All admin-only (requireAdmin — real Clerk
//  JWT verification plus a role === 'admin' DB check, bridged from
//  server.js; see the note above requireAdmin's definition in this
//  file). Same guard as every other /api/admin/* route.
//
//  Column-name assumptions surfaced against watch_events/tips/video_likes/
//  comments (per request, flagging before writing rather than guessing):
//   - watch_events' duration column is `watched_seconds`, not
//     `watch_duration_seconds` — that name doesn't exist anywhere in the
//     schema (see the 2026-07-26-feed-ranking.sql migration).
//   - tips' amount column is `amount_suns`, not `amount`.
//   - The "likes" table is actually named `video_likes` (2026-07-26-
//     engagement.sql), not `likes`.
//   - watch_events has ONE ROW PER ~10-15s PROGRESS PING OR PAUSE/UNLOAD
//     (see that migration's own comment), not one row per view. So
//     `total_views` everywhere below (COUNT of watch_events rows,
//     exactly as specified for the countries route) measures ping/
//     engagement volume, not unique views — it will run higher than,
//     and isn't period-filterable in the same way as, videos.view_count
//     (a separate lifetime counter incremented once per view-complete
//     event at line ~2474, which the spec's period-filtering requirement
//     made unusable here since it carries no per-increment timestamp).
//     Same caveat applies to the creators route's total_views, which had
//     no explicit formula in the spec — it mirrors the countries route's
//     definition for consistency.
//   - tips.created_at is assumed to exist (every other transactional
//     table in this schema has one, and period-filtering requires it)
//     but no pre-existing query in this file reads that column, so it
//     hasn't been directly verified against the live DB the way the
//     other assumptions above were (those are confirmed by existing
//     queries elsewhere in this file).
//   - total_suns_earned (creators route) sums tips.amount_suns, which is
//     the GROSS amount tipped to the creator, not their net post-split
//     take — the actual creator_share_pct/platform_share_pct split
//     happens at tip time and only the running total lands on
//     wallets.total_earned_suns (lifetime, not period-filterable, not
//     per-tip). This will read higher than what the creator actually
//     received in Suns.
//   - Rows with no country_code set (never populated at signup) are
//     excluded from country grouping in both the countries and creators
//     routes — there's no "unknown" bucket in the spec's shape.
//   - total_users/new_users_this_period exclude soft-deleted users
//     (deleted_at IS NOT NULL), matching the one other place in this
//     file that filters on deleted_at (line ~2802).
//   - creators route's video_count is period-filtered (videos created
//     in the period), matching "All KPIs filtered by period except
//     subscriber_count" — the spec didn't give it an explicit formula.
//   - Country display names come from the i18n-iso-countries package
//     (English) rather than a hardcoded map, per instruction — it covers
//     the full ISO 3166-1 list, not just the 66-country COUNTRIES set
//     the frontend's signup dropdown uses, since diaspora tippers (the
//     whole point of suns_flow) can be anywhere.
// ============================================================

const ANALYTICS_PERIOD_DAYS = { '7d': 7, '30d': 30, all: null };

// Returns a Date lower-bound for the period, or null for 'all' (no lower bound).
function analyticsPeriodSince(period) {
  const days = ANALYTICS_PERIOD_DAYS[period];
  return days == null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Validates period by hand rather than express-validator + the shared
// `validate` middleware (which returns 422 for every other route in this
// file, by design — see the comment above its definition) because the
// analytics spec explicitly asked for 400 on an invalid period.
function requireValidPeriod(req, res, next) {
  if (req.query.period !== undefined && !(req.query.period in ANALYTICS_PERIOD_DAYS)) {
    return res.status(400).json({ error: 'period must be 7d, 30d, or all' });
  }
  next();
}

function countryDisplayName(code) {
  if (!code) return null;
  return countries.getName(code, 'en') || code;
}

// ── GET /api/admin/analytics/overview ────────────────────────
router.get('/admin/analytics/overview',
  requireAdmin,
  requireValidPeriod,
  async (req, res) => {
    const period = req.query.period || '30d';
    const since = analyticsPeriodSince(period);

    try {
      const { rows } = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE deleted_at IS NULL) AS total_users,
          (SELECT COUNT(*)::int FROM users WHERE role = 'creator' AND deleted_at IS NULL) AS total_creators,
          (SELECT COUNT(*)::int FROM videos) AS total_videos,
          (SELECT COUNT(*)::int FROM videos WHERE is_flare = true) AS total_flares,
          (SELECT COALESCE(SUM(watched_seconds), 0)::float / 3600
             FROM watch_events
             WHERE $1::timestamptz IS NULL OR created_at >= $1) AS total_watch_hours,
          (SELECT COALESCE(SUM(balance_suns), 0)::int FROM wallets) AS suns_in_circulation,
          (SELECT COALESCE(SUM(amount_suns), 0)::int
             FROM tips
             WHERE $1::timestamptz IS NULL OR created_at >= $1) AS suns_tipped_this_period,
          (SELECT COUNT(*)::int FROM users
             WHERE deleted_at IS NULL AND ($1::timestamptz IS NULL OR created_at >= $1)) AS new_users_this_period,
          (SELECT COUNT(*)::int FROM videos
             WHERE $1::timestamptz IS NULL OR created_at >= $1) AS new_videos_this_period
      `, [since]);

      const row = rows[0];
      res.json({
        total_users:              row.total_users,
        total_creators:           row.total_creators,
        total_videos:             row.total_videos,
        total_flares:             row.total_flares,
        total_watch_hours:        Math.round(row.total_watch_hours * 100) / 100,
        suns_in_circulation:      row.suns_in_circulation,
        suns_tipped_this_period:  row.suns_tipped_this_period,
        new_users_this_period:    row.new_users_this_period,
        new_videos_this_period:   row.new_videos_this_period,
      });
    } catch (err) {
      console.error('admin analytics overview error:', err.message);
      res.status(500).json({ error: 'Could not fetch analytics overview' });
    }
  }
);

// ── GET /api/admin/analytics/countries ───────────────────────
router.get('/admin/analytics/countries',
  requireAdmin,
  requireValidPeriod,
  async (req, res) => {
    const period = req.query.period || '30d';
    const since = analyticsPeriodSince(period);

    try {
      const { rows: byCountryRows } = await db.query(`
        WITH viewer_stats AS (
          SELECT u.country_code,
                 COUNT(*)::int AS total_views,
                 COALESCE(SUM(we.watched_seconds), 0)::int AS total_watch_seconds
          FROM watch_events we
          JOIN users u ON u.id = we.user_id
          WHERE u.country_code IS NOT NULL
            AND ($1::timestamptz IS NULL OR we.created_at >= $1)
          GROUP BY u.country_code
        ),
        sent_stats AS (
          SELECT u.country_code,
                 COALESCE(SUM(t.amount_suns), 0)::int AS suns_sent
          FROM tips t
          JOIN users u ON u.id = t.sender_id
          WHERE u.country_code IS NOT NULL
            AND ($1::timestamptz IS NULL OR t.created_at >= $1)
          GROUP BY u.country_code
        ),
        received_stats AS (
          SELECT u.country_code,
                 COALESCE(SUM(t.amount_suns), 0)::int AS suns_received
          FROM tips t
          JOIN users u ON u.id = t.creator_id
          WHERE u.country_code IS NOT NULL
            AND ($1::timestamptz IS NULL OR t.created_at >= $1)
          GROUP BY u.country_code
        )
        SELECT
          COALESCE(v.country_code, s.country_code, r.country_code) AS country_code,
          COALESCE(v.total_views, 0) AS total_views,
          COALESCE(v.total_watch_seconds, 0) AS total_watch_seconds,
          COALESCE(s.suns_sent, 0) AS suns_sent,
          COALESCE(r.suns_received, 0) AS suns_received
        FROM viewer_stats v
        FULL OUTER JOIN sent_stats s ON s.country_code = v.country_code
        FULL OUTER JOIN received_stats r ON r.country_code = COALESCE(v.country_code, s.country_code)
        ORDER BY total_views DESC
      `, [since]);

      const by_country = byCountryRows
        .filter((r) => r.total_views > 0 || r.suns_sent > 0 || r.suns_received > 0)
        .map((r) => ({
          country_code: r.country_code,
          country_name: countryDisplayName(r.country_code),
          total_views: r.total_views,
          total_watch_minutes: Math.round((r.total_watch_seconds / 60) * 100) / 100,
          suns_sent: r.suns_sent,
          suns_received: r.suns_received,
        }));

      const { rows: flowRows } = await db.query(`
        SELECT
          su.country_code AS from_country_code,
          cu.country_code AS to_country_code,
          COALESCE(SUM(t.amount_suns), 0)::int AS suns_total,
          COUNT(*)::int AS tip_count
        FROM tips t
        JOIN users su ON su.id = t.sender_id
        JOIN users cu ON cu.id = t.creator_id
        WHERE su.country_code IS NOT NULL AND cu.country_code IS NOT NULL
          AND su.country_code <> cu.country_code
          AND ($1::timestamptz IS NULL OR t.created_at >= $1)
        GROUP BY su.country_code, cu.country_code
        ORDER BY suns_total DESC
        LIMIT 50
      `, [since]);

      const suns_flow = flowRows.map((r) => ({
        from_country_code: r.from_country_code,
        from_country_name: countryDisplayName(r.from_country_code),
        to_country_code: r.to_country_code,
        to_country_name: countryDisplayName(r.to_country_code),
        suns_total: r.suns_total,
        tip_count: r.tip_count,
      }));

      const { rows: domesticRows } = await db.query(`
        SELECT COALESCE(SUM(t.amount_suns), 0)::int AS domestic_tips_total
        FROM tips t
        JOIN users su ON su.id = t.sender_id
        JOIN users cu ON cu.id = t.creator_id
        WHERE su.country_code IS NOT NULL AND cu.country_code IS NOT NULL
          AND su.country_code = cu.country_code
          AND ($1::timestamptz IS NULL OR t.created_at >= $1)
      `, [since]);

      res.json({
        by_country,
        suns_flow,
        domestic_tips_total: domesticRows[0].domestic_tips_total,
      });
    } catch (err) {
      console.error('admin analytics countries error:', err.message);
      res.status(500).json({ error: 'Could not fetch country analytics' });
    }
  }
);

// ── GET /api/admin/analytics/creators ────────────────────────
const CREATOR_SORT_COLUMNS = {
  views:      'total_views',
  suns:       'total_suns_earned',
  comments:   'total_comments',
  likes:      'total_likes',
  watch_time: 'total_watch_seconds',
};

router.get('/admin/analytics/creators',
  requireAdmin,
  requireValidPeriod,
  [
    query('sort').optional().isIn(Object.keys(CREATOR_SORT_COLUMNS)).withMessage('sort must be one of views, suns, comments, likes, watch_time'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req, res) => {
    const period = req.query.period || '30d';
    const since = analyticsPeriodSince(period);
    const sortColumn = CREATOR_SORT_COLUMNS[req.query.sort || 'views'];
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const offset = (page - 1) * limit;

    try {
      const { rows } = await db.query(`
        WITH watch_stats AS (
          SELECT v.creator_id,
                 COUNT(we.id)::int AS total_views,
                 COALESCE(SUM(we.watched_seconds), 0)::int AS total_watch_seconds
          FROM videos v
          JOIN watch_events we ON we.video_id = v.id
          WHERE $1::timestamptz IS NULL OR we.created_at >= $1
          GROUP BY v.creator_id
        ),
        tip_stats AS (
          SELECT t.creator_id,
                 COALESCE(SUM(t.amount_suns), 0)::int AS total_suns_earned
          FROM tips t
          WHERE $1::timestamptz IS NULL OR t.created_at >= $1
          GROUP BY t.creator_id
        ),
        comment_stats AS (
          SELECT v.creator_id,
                 COUNT(c.id)::int AS total_comments
          FROM videos v
          JOIN comments c ON c.video_id = v.id AND c.status = 'visible'
          WHERE $1::timestamptz IS NULL OR c.created_at >= $1
          GROUP BY v.creator_id
        ),
        like_stats AS (
          SELECT v.creator_id,
                 COUNT(vl.id)::int AS total_likes
          FROM videos v
          JOIN video_likes vl ON vl.video_id = v.id
          WHERE $1::timestamptz IS NULL OR vl.created_at >= $1
          GROUP BY v.creator_id
        ),
        video_stats AS (
          SELECT creator_id, COUNT(*)::int AS video_count
          FROM videos
          WHERE $1::timestamptz IS NULL OR created_at >= $1
          GROUP BY creator_id
        )
        SELECT
          u.id AS creator_id, u.username, u.display_name, u.country_code,
          u.avatar_url, COALESCE(u.follower_count, 0) AS subscriber_count,
          COALESCE(ws.total_views, 0) AS total_views,
          COALESCE(ws.total_watch_seconds, 0) AS total_watch_seconds,
          COALESCE(ts.total_suns_earned, 0) AS total_suns_earned,
          COALESCE(cs.total_comments, 0) AS total_comments,
          COALESCE(ls.total_likes, 0) AS total_likes,
          COALESCE(vs.video_count, 0) AS video_count,
          COUNT(*) OVER()::int AS total_count
        FROM users u
        LEFT JOIN watch_stats   ws ON ws.creator_id = u.id
        LEFT JOIN tip_stats     ts ON ts.creator_id = u.id
        LEFT JOIN comment_stats cs ON cs.creator_id = u.id
        LEFT JOIN like_stats    ls ON ls.creator_id = u.id
        LEFT JOIN video_stats   vs ON vs.creator_id = u.id
        WHERE u.role = 'creator' AND u.deleted_at IS NULL
        ORDER BY ${sortColumn} DESC, u.id ASC
        LIMIT $2 OFFSET $3
      `, [since, limit, offset]);

      const creators = rows.map((r) => ({
        creator_id: r.creator_id,
        username: r.username,
        display_name: r.display_name,
        country_code: r.country_code,
        country_name: countryDisplayName(r.country_code),
        avatar_url: r.avatar_url,
        total_views: r.total_views,
        total_watch_minutes: Math.round((r.total_watch_seconds / 60) * 100) / 100,
        total_suns_earned: r.total_suns_earned,
        total_comments: r.total_comments,
        total_likes: r.total_likes,
        video_count: r.video_count,
        subscriber_count: r.subscriber_count,
      }));

      res.json({
        creators,
        total: rows[0]?.total_count ?? 0,
        page,
        limit,
      });
    } catch (err) {
      console.error('admin analytics creators error:', err.message);
      res.status(500).json({ error: 'Could not fetch creator analytics' });
    }
  }
);

// ============================================================
//  EXPORT
// ============================================================
// writeDoubleEntry is exported for the payout webhook router (server.js),
// which re-credits Suns on provider-reported failures.
module.exports = { router, pool: db, writeDoubleEntry };

/**
 * Attach to your Express app like this:
 *
 *   const app = require('express')();
 *   const zuvaRoutes = require('./zuva-api');
 *   app.use('/api', zuvaRoutes);
 *
 * Then test with:
 *   POST /api/suns/purchase  { fiatAmount: 10, fiatCurrency: 'GBP' }
 *   POST /api/suns/tip       { creatorId: '...', amountSuns: 500 }
 *   POST /api/suns/cashout   { amountSuns: 100, channel: 'mobile_money_mpesa', phoneNumber: '+254...', localCurrencyCode: 'KES' }
 *   GET  /api/wallet/balance
 *   GET  /api/suns/ledger
 */