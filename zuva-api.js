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
const { randomUUID: uuidv4 } = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const { RekognitionClient, DetectModerationLabelsCommand } = require('@aws-sdk/client-rekognition');
const nodemailer = require('nodemailer');
require('dotenv').config();

const router = express.Router();

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
const SUNS_PER_USD        = 1000;  // 1000 Suns = $1.00 USD
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
//  ROUTE 2: POST /api/suns/purchase — TEMPORARILY DISABLED
//  Chimoney (our pay-in provider) shut down in May 2026 and no
//  replacement checkout provider has been selected yet. The route
//  is kept so the frontend gets a clean, machine-readable 503
//  instead of a 404; the sun_purchases table and its RLS policies
//  are untouched, ready for the next provider.
// ============================================================
router.post('/suns/purchase', requireAuth, (_req, res) => {
  res.status(503).json({
    error: 'Suns purchases are coming soon',
    code:  'PURCHASES_NOT_LIVE',
  });
});


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
      .isInt({ min: 1000 })
      .withMessage('Cashout amount must be at least 1,000 Suns ($1 USD); regional minimums also apply'),
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
//  DISCOVERY ENGINE  —  Routes added in v1.1
// ============================================================

// ─── SQL identifier whitelists ──────────────────────────────────
// Postgres can't parameterize table/view names ($1 etc. only binds values),
// so orientation is mapped through these fixed lookup tables instead of
// being interpolated directly — a lookup can only ever produce one of
// these exact literal strings, never arbitrary input.
const CONTENT_TABLE_BY_ORIENTATION = {
  vertical:  'vertical_content',
  landscape: 'landscape_content',
};
const TRENDING_VIEW_BY_ORIENTATION = {
  vertical:  'trending_vertical_24h',
  landscape: 'trending_landscape_24h',
};

// ─── Discovery constants ──────────────────────────────────────
// Feed composition: what percentage of each slot type
const FEED_MIX = {
  TRENDING:     0.50,   // 50% — Suns earned in the last 24 hours
  PERSONALIZED: 0.40,   // 40% — matches user's highest-weighted tags
  WILDCARD:     0.10,   // 10% — random content for serendipitous discovery
};

// Interest weight constants (must match the PostgreSQL function)
const INTEREST_DECAY  = 0.97;
const INTEREST_INCREMENT = 1.0;

// Tags to increment per video completion (max 5 to prevent noise)
const MAX_TAGS_PER_COMPLETION = 5;


// ============================================================
//  ROUTE 8: POST /api/feed/view-complete
//  Called by the client when a user finishes (or nearly finishes)
//  watching a video. This is the event that drives the interest graph.
//
//  "Completion" rules:
//    - Vertical content:   watched ≥ 80% of duration
//    - Landscape content:  watched ≥ 70% of duration
//    - Partial views still record to content_views for analytics
//    - Only COMPLETED views update user_interests (tag weights)
//
//  The client should fire this endpoint:
//    - When the IntersectionObserver detects the user scrolled AWAY
//      from a vertical video (captures how far they got)
//    - When the video's 'ended' event fires for landscape content
//    - When the user manually closes the player
// ============================================================
router.post('/feed/view-complete',
  requireAuth,
  [
    body('contentId').isUUID().withMessage('Invalid content ID'),
    body('orientation').isIn(['vertical', 'landscape']).withMessage('Invalid orientation'),
    body('watchDurationSeconds').isInt({ min: 0 }).withMessage('Invalid watch duration'),
    body('totalDurationSeconds').isInt({ min: 1 }).withMessage('Invalid total duration'),
  ],
  validate,
  async (req, res) => {
    const {
      contentId,
      orientation,
      watchDurationSeconds,
      totalDurationSeconds,
    } = req.body;
    const userId = req.user.id;

    // Determine if this counts as a "completion" for interest-weight purposes
    const completionThreshold = orientation === 'vertical' ? 0.80 : 0.70;
    const watchRatio          = watchDurationSeconds / totalDurationSeconds;
    const isCompleted         = watchRatio >= completionThreshold;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // ── Step 1: Fetch content tags ─────────────────────────
      // We need the content's ai_generated_tags to know which
      // interests to reinforce in the user's interest graph.
      const table  = CONTENT_TABLE_BY_ORIENTATION[orientation]; // orientation validated via isIn(['vertical','landscape']) above
      const tagRes = await client.query(
        `SELECT ai_generated_tags, creator_id FROM ${table} WHERE id = $1`,
        [contentId]
      );

      if (!tagRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Content not found' });
      }

      const { ai_generated_tags: tags, creator_id: creatorId } = tagRes.rows[0];

      // ── Step 2: Record the view in content_views ───────────
      // Always recorded — even partial views count for analytics.
      await client.query(`
        INSERT INTO content_views
          (viewer_id, content_id, orientation, watch_duration_seconds, completed, country_code)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, contentId, orientation, watchDurationSeconds, isCompleted,
          req.user.countryCode || null]);

      // ── Step 3: Increment view_count on content ────────────
      await client.query(
        `UPDATE ${table} SET view_count = view_count + 1 WHERE id = $1`,
        [contentId]
      );

      // ── Step 4: Update user_interests (only on completion) ─
      // We call upsert_user_interest() once per tag.
      // We limit to MAX_TAGS_PER_COMPLETION tags to avoid weighting
      // noise from content that has many generic tags.
      let updatedTags = [];
      if (isCompleted && tags && tags.length > 0) {
        const tagsToProcess = tags.slice(0, MAX_TAGS_PER_COMPLETION);
        updatedTags         = tagsToProcess;

        for (const tag of tagsToProcess) {
          await client.query(
            'SELECT upsert_user_interest($1, $2, $3)',
            [userId, tag.toLowerCase(), orientation]
          );
        }
      }

      await client.query('COMMIT');

      res.json({
        success:       true,
        contentId,
        orientation,
        watchRatio:    parseFloat(watchRatio.toFixed(3)),
        isCompleted,
        interestsUpdated: updatedTags,
        message: isCompleted
          ? `Interests updated: [${updatedTags.join(', ')}]`
          : `Partial view recorded (${Math.round(watchRatio * 100)}% — threshold ${completionThreshold * 100}%)`,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('view-complete error:', err.message);
      res.status(500).json({ error: 'Could not record view' });
    } finally {
      client.release();
    }
  }
);


// ============================================================
//  ROUTE 9: GET /api/feed/recommended
//  The Discovery Engine — returns a curated mixed feed.
//
//  Query params:
//    orientation  'vertical' | 'landscape' | 'both' (default: 'both')
//    limit        total items to return (default: 30)
//    offset       for pagination (default: 0)
//
//  Algorithm:
//    Given limit = 30:
//      trending_n     = Math.floor(30 × 0.50) = 15 items
//      personalized_n = Math.floor(30 × 0.40) = 12 items
//      wildcard_n     = 30 - 15 - 12          = 3  items  (remainder)
//
//    Each bucket is fetched separately via SQL, then:
//      1. Results are deduplicated by content ID across all three buckets
//      2. Trending content anchors the top positions
//      3. Personalized content fills the middle
//      4. Wildcard items are randomly distributed at the end
//
//  For unauthenticated users: returns trending + wildcard only
//  (no personalization without an interest graph to query)
// ============================================================
router.get('/feed/recommended',
  requireAuth,
  async (req, res) => {
    const orientation = req.query.orientation || 'both';
    const limit       = Math.min(parseInt(req.query.limit) || 30, 100);
    const userId      = req.user.id;

    // ── Slot allocation ─────────────────────────────────────
    const trendingN     = Math.floor(limit * FEED_MIX.TRENDING);
    const personalizedN = Math.floor(limit * FEED_MIX.PERSONALIZED);
    const wildcardN     = limit - trendingN - personalizedN;  // absorbs rounding

    // Track IDs already allocated to avoid cross-bucket duplicates
    const usedIds = new Set();

    try {
      // ── BUCKET 1: TRENDING ─────────────────────────────────
      // Uses the trending_vertical_24h / trending_landscape_24h views
      // which pre-join tip sums. Falls back to most-viewed if no
      // tips have been made in the last 24h (common early on).
      const trendingResults = await fetchTrending(db, orientation, trendingN);
      trendingResults.forEach(r => usedIds.add(r.id));

      // ── BUCKET 2: PERSONALIZED ─────────────────────────────
      // Fetches the user's top-weighted tags, then finds content
      // whose ai_generated_tags array overlaps — weighted by how
      // well the content matches the user's interest profile.
      const personalizedResults = await fetchPersonalized(
        db, userId, orientation, personalizedN, usedIds
      );
      personalizedResults.forEach(r => usedIds.add(r.id));

      // ── BUCKET 3: WILDCARD ──────────────────────────────────
      // Pure random content the user hasn't already seen in this
      // feed response. This is the discovery valve — it surfaces
      // creators and genres outside the user's current interest graph.
      const wildcardResults = await fetchWildcard(
        db, orientation, wildcardN, usedIds
      );

      // ── Assembly ────────────────────────────────────────────
      // Tag each item with its source bucket for client-side
      // analytics (you want to know which bucket drives engagement).
      const feed = [
        ...trendingResults.map(r => ({ ...r, _bucket: 'trending' })),
        ...personalizedResults.map(r => ({ ...r, _bucket: 'personalized' })),
        ...wildcardResults.map(r => ({ ...r, _bucket: 'wildcard' })),
      ];

      // ── Feed diagnostics (strip from production if needed) ──
      const diagnostics = {
        requested:    limit,
        delivered:    feed.length,
        trending:     trendingResults.length,
        personalized: personalizedResults.length,
        wildcard:     wildcardResults.length,
        mix: {
          trending_pct:     ((trendingResults.length / feed.length) * 100).toFixed(1) + '%',
          personalized_pct: ((personalizedResults.length / feed.length) * 100).toFixed(1) + '%',
          wildcard_pct:     ((wildcardResults.length / feed.length) * 100).toFixed(1) + '%',
        },
      };

      res.json({ success: true, feed, diagnostics });

    } catch (err) {
      console.error('recommended feed error:', err.message);
      res.status(500).json({ error: 'Could not generate recommended feed' });
    }
  }
);


// ============================================================
//  ROUTE 10: GET /api/feed/user-interests
//  Returns the user's current interest graph for display
//  (useful for a "Your Tastes" profile section)
// ============================================================
router.get('/feed/user-interests', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  try {
    const { rows } = await db.query(`
      SELECT
        tag,
        weight,
        view_count,
        vertical_completions,
        landscape_completions,
        updated_at,
        -- Normalise weight to 0–100 for display
        ROUND((weight / NULLIF((SELECT MAX(weight) FROM user_interests WHERE user_id = $1), 0)) * 100) AS strength_pct
      FROM user_interests
      WHERE user_id = $1
      ORDER BY weight DESC
      LIMIT $2
    `, [req.user.id, limit]);

    res.json({ success: true, interests: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch interests' });
  }
});


// ============================================================
//  ROUTE: GET /api/user/role
//  Looks up a user's role by their Clerk user ID, sent via the
//  x-clerk-user-id header. Used by the frontend navbar/sidebar to
//  pick between the viewer and creator navigation experience.
//
//  Requires a clerk_user_id column mapping Clerk identities to
//  internal user rows. Run this migration if it doesn't exist yet:
//    ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;
//    CREATE INDEX IF NOT EXISTS users_clerk_user_id_idx ON users(clerk_user_id);
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
//  HELPERS  —  The three feed bucket fetchers
//
//  These are module-level async functions (not route handlers).
//  Each returns a plain array of content row objects.
//  They accept a `usedIds` Set to enforce cross-bucket deduplication.
// ============================================================

/**
 * fetchTrending
 * Returns content with the highest Sun earnings in the last 24h.
 * Falls back to highest all-time view_count if the tips table is sparse.
 */
async function fetchTrending(db, orientation, limit) {
  if (limit <= 0) return [];

  // Build orientation filter — one or both tables
  const orientations = orientation === 'both' ? ['vertical', 'landscape']
                     : [orientation];

  const results = [];

  for (const o of orientations) {
    const view   = TRENDING_VIEW_BY_ORIENTATION[o]; // o is always 'vertical' or 'landscape' — see orientations above
    const perO   = Math.ceil(limit / orientations.length);

    const { rows } = await db.query(`
      SELECT
        id, creator_id, title, duration_seconds,
        cloudfront_url, thumbnail_url, ai_generated_tags,
        view_count, like_count, total_tips_suns,
        orientation, trending_suns_24h, trending_tip_count_24h,
        -- If nothing trended today, fall back to all-time popularity
        CASE
          WHEN trending_suns_24h > 0 THEN trending_suns_24h
          ELSE view_count * 0.1           -- synthetic score for fallback
        END AS sort_score
      FROM ${view}
      ORDER BY sort_score DESC
      LIMIT $1
    `, [perO]);

    results.push(...rows);
  }

  return results;
}

/**
 * fetchPersonalized
 * Scores content by how well its tags overlap with the user's
 * interest graph. The relevance_score is a SUM of the user's
 * weight for each matching tag — so content tagged with both
 * 'nollywood' (weight 8.2) and 'crime' (weight 5.1) scores 13.3.
 *
 * Filters out content the user has already watched (content_views).
 * Filters out content already allocated to the trending bucket (usedIds).
 */
async function fetchPersonalized(db, userId, orientation, limit, usedIds) {
  if (limit <= 0) return [];

  // Convert usedIds Set to an array for the SQL NOT IN clause
  // If empty, use a dummy UUID to avoid syntax errors
  const excluded = usedIds.size > 0
    ? [...usedIds]
    : ['00000000-0000-0000-0000-000000000000'];

  const orientations = orientation === 'both' ? ['vertical', 'landscape'] : [orientation];
  const results = [];

  for (const o of orientations) {
    const table = CONTENT_TABLE_BY_ORIENTATION[o]; // o is always 'vertical' or 'landscape' — see orientations above
    const perO  = Math.ceil(limit / orientations.length);

    // This query is the core of the personalisation engine.
    // It joins content against the user's interest weights via tag overlap.
    //
    // UNNEST(c.ai_generated_tags) expands the tags array into rows so we
    // can JOIN against user_interests on a single tag value.
    // The GROUP BY + SUM aggregates the matching weights into a relevance score.
    const { rows } = await db.query(`
      SELECT
        c.id,
        c.creator_id,
        c.title,
        c.duration_seconds,
        c.cloudfront_url,
        c.thumbnail_url,
        c.ai_generated_tags,
        c.view_count,
        c.like_count,
        c.total_tips_suns,
        $3::text                        AS orientation,
        SUM(ui.weight)                  AS relevance_score,
        ARRAY_AGG(DISTINCT ui.tag)      AS matched_tags   -- tags that matched (for debugging)
      FROM ${table} c
      -- Expand the tags array into individual rows for join
      JOIN LATERAL UNNEST(c.ai_generated_tags) AS tag(val) ON TRUE
      -- Match against user's interest weights
      JOIN user_interests ui
        ON ui.tag     = tag.val
        AND ui.user_id = $1
      WHERE
        c.moderation_status = 'approved'
        AND c.published_at  IS NOT NULL
        AND c.deleted_at    IS NULL
        -- Exclude content already in the trending bucket
        AND c.id            NOT IN (SELECT UNNEST($4::uuid[]))
        -- Exclude content this user has already completed
        AND c.id NOT IN (
          SELECT content_id FROM content_views
          WHERE viewer_id  = $1
            AND orientation = $3
            AND completed   = TRUE
        )
      GROUP BY c.id, c.creator_id, c.title, c.duration_seconds,
               c.cloudfront_url, c.thumbnail_url, c.ai_generated_tags,
               c.view_count, c.like_count, c.total_tips_suns
      ORDER BY relevance_score DESC
      LIMIT $2
    `, [userId, perO, o, excluded]);

    results.push(...rows);
  }

  return results;
}

/**
 * fetchWildcard
 * Pure randomness via ORDER BY RANDOM().
 * Filters out content already allocated to trending + personalized.
 * This intentionally surfaces creators and tags the user has
 * never interacted with, breaking the filter-bubble effect.
 *
 * In production at scale: replace RANDOM() with a reservoir
 * sampling approach or a pre-computed random bucket refreshed hourly,
 * because ORDER BY RANDOM() is slow on large tables (full sequential scan).
 */
async function fetchWildcard(db, orientation, limit, usedIds) {
  if (limit <= 0) return [];

  const excluded    = usedIds.size > 0 ? [...usedIds] : ['00000000-0000-0000-0000-000000000000'];
  const orientations = orientation === 'both' ? ['vertical', 'landscape'] : [orientation];
  const results = [];

  for (const o of orientations) {
    const table = CONTENT_TABLE_BY_ORIENTATION[o]; // o is always 'vertical' or 'landscape' — see orientations above
    const perO  = Math.ceil(limit / orientations.length);

    const { rows } = await db.query(`
      SELECT
        id, creator_id, title, duration_seconds,
        cloudfront_url, thumbnail_url, ai_generated_tags,
        view_count, like_count, total_tips_suns,
        $3::text AS orientation
      FROM ${table}
      WHERE moderation_status = 'approved'
        AND published_at      IS NOT NULL
        AND deleted_at        IS NULL
        AND id NOT IN (SELECT UNNEST($2::uuid[]))
      ORDER BY RANDOM()
      LIMIT $1
    `, [perO, excluded, o]);

    results.push(...rows);
  }

  return results;
}


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
//  -- If this table predates AWS Rekognition moderation / report-triggered
//  -- review, add 'flagged' and 'under_review' to the existing status
//  -- CHECK constraint (see moderateVideo() / moderateReportedVideo() below).
//
//  CREATE TABLE video_reports (
//    id                SERIAL PRIMARY KEY,
//    video_id          UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
//    reason            TEXT NOT NULL,
//    reporter_clerk_id TEXT,
//    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
//  );
//
//  NOTE: moderateVideo() (upload-time) only ever sets 'published' or
//  'rejected' automatically. moderateReportedVideo() (report-triggered,
//  see POST /video/:id/report) sets 'under_review' when the report count
//  crosses REPORT_THRESHOLD, then 'published' or 'rejected' once AI
//  re-review completes — or leaves it at 'under_review' if that re-review
//  itself fails, for manual follow-up. 'flagged' is still not produced by
//  any automated path — reserved for future use (e.g. manual admin
//  flagging). See GET /admin/moderation-queue.
// ============================================================

const VALID_VIDEO_CATEGORIES = ['Comedy', 'Drama', 'Music', 'News', 'Sports', 'Lifestyle', 'Education', 'Other'];

// ── Content moderation: AWS Rekognition (thumbnail-based first pass) ──
// Rekognition's video moderation API (StartContentModeration) requires the
// video to already live in S3, which Cloudflare Stream doesn't give us.
// As a workaround, this runs Rekognition's synchronous IMAGE moderation
// (DetectModerationLabels) against the video's Cloudflare Stream thumbnail:
//   - labels found at/above MinConfidence 75 -> status = 'rejected'
//   - no labels found                        -> status = 'published'
// This is a weak signal — a single frame can't vouch for an entire video —
// but per product decision a clean thumbnail is treated as sufficient for
// auto-publish. Never throws: any failure (thumbnail not ready yet, AWS
// error, etc.) is caught and leaves the video at its current 'pending'
// status rather than crashing the upload request.
async function moderateVideo(cloudflareVideoId) {
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
      await db.query(`UPDATE videos SET status = 'rejected' WHERE cloudflare_video_id = $1`, [cloudflareVideoId]);
      return { safe: false, labels };
    }

    await db.query(`UPDATE videos SET status = 'published' WHERE cloudflare_video_id = $1`, [cloudflareVideoId]);
    return { safe: true };
  } catch (err) {
    console.error('moderateVideo error (video stays pending):', err.response?.data ?? err.message);
    return { safe: null, error: err.message };
  }
}

// ── POST /api/upload/video ───────────────────────────────────
// Identity comes from the x-clerk-user-id header (requireClerkUser), same
// as /api/channel/update — a client-supplied creator_id field is accepted
// for compatibility but is checked against the authenticated user rather
// than trusted, so a caller can't upload as someone else.
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
    body('tags').optional().isString().withMessage('tags must be a comma-separated string'),
    body('creator_id').optional().isUUID().withMessage('Invalid creator_id'),
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

    const { title, description, category } = req.body;
    const tags = (req.body.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

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

      // Note: cf.thumbnail is only reliably populated once Cloudflare finishes
      // processing — GET /upload/status/:videoId re-syncs it once ready.
      // Custom thumbnail uploads aren't wired up yet (no image storage is
      // configured in this backend) — Cloudflare's auto-generated thumbnail
      // is used regardless of what the frontend's optional thumbnail field sends.
      const { rows } = await db.query(`
        INSERT INTO videos
          (creator_id, title, description, category, tags, cloudflare_video_id, thumbnail_url, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        req.user.id, title, description || null, category, tags,
        cf.uid, cf.thumbnail || null, durationSeconds,
      ]);

      let video = rows[0];

      // Run moderation before responding so the client gets the true final
      // status immediately rather than a stale 'pending'. moderateVideo()
      // never throws — on failure the video simply stays 'pending'.
      const moderation = await moderateVideo(cf.uid);
      let message;
      if (moderation.safe === true) {
        video = { ...video, status: 'published' };
        message = 'Video uploaded successfully and is now live.';
      } else if (moderation.safe === false) {
        video = { ...video, status: 'rejected' };
        message = 'Video uploaded but did not pass content moderation and has been rejected.';
      } else {
        message = 'Video uploaded successfully and is pending review.';
      }

      res.status(201).json({ success: true, video, moderation, message });
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

      if (durationSeconds !== video.duration_seconds || thumbnailUrl !== video.thumbnail_url) {
        await db.query(
          'UPDATE videos SET duration_seconds = $1, thumbnail_url = $2 WHERE id = $3',
          [durationSeconds, thumbnailUrl, video.id]
        );
      }

      res.json({
        success: true,
        processing_status: cf.status, // { state, pctComplete, errorReasonCode, errorReasonText }
        video: { ...video, duration_seconds: durationSeconds, thumbnail_url: thumbnailUrl },
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
        SELECT id, title, thumbnail_url, duration_seconds, view_count, category, created_at
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
        category: row.category, tags: row.tags, cloudflare_video_id: row.cloudflare_video_id,
        thumbnail_url: row.thumbnail_url, duration_seconds: row.duration_seconds,
        status: row.status, view_count: row.view_count, created_at: row.created_at,
        like_count: row.like_count ?? 0, comment_count: row.comment_count ?? 0,
      };
      const creator = {
        id: row.c_id, username: row.c_username, display_name: row.c_display_name,
        avatar_url: row.c_avatar_url, follower_count: row.c_follower_count,
      };

      // Viewer engagement state — anonymous viewers get false/false.
      let viewer = { has_liked: false, is_subscribed: false };
      if (req.user) {
        const { rows: v } = await db.query(`
          SELECT
            EXISTS (SELECT 1 FROM video_likes   WHERE video_id = $1 AND user_id = $2)       AS has_liked,
            EXISTS (SELECT 1 FROM subscriptions WHERE creator_id = $3 AND subscriber_id = $2) AS is_subscribed
        `, [video.id, req.user.id, video.creator_id]);
        viewer = v[0];
      }

      const { rows: related } = await db.query(`
        SELECT id, title, thumbnail_url, duration_seconds, view_count, created_at
        FROM videos
        WHERE category = $1 AND status = 'published' AND id != $2
        ORDER BY created_at DESC
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

// ── Report-triggered AI re-review ─────────────────────────────
// Number of reports a video needs before it's auto-hidden ('under_review')
// and sent back through AWS Rekognition. Read once at startup — restart
// the process to pick up a changed REPORT_THRESHOLD.
const REPORT_THRESHOLD = parseInt(process.env.REPORT_THRESHOLD, 10) || 3;

// Re-runs the same thumbnail-based Rekognition check as moderateVideo()
// (see the NOTE there on why this only checks the thumbnail, not the full
// video), but for an already-published video that just crossed the report
// threshold. Always emails the admin with the outcome. Never throws —
// covers its own DB/Rekognition/email failures so the caller (the report
// route, which does not await this) can't be broken by it.
async function moderateReportedVideo(videoId, cloudflareVideoId) {
  let videoInfo;
  try {
    const { rows } = await db.query(`
      SELECT v.title,
             COALESCE(u.display_name, u.username, 'Unknown') AS creator_name,
             (SELECT COUNT(*)::int FROM video_reports vr WHERE vr.video_id = v.id) AS report_count
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
      <li><strong>Report count:</strong> ${videoInfo.report_count}</li>
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

// ── POST /api/video/:id/report ───────────────────────────────
const VALID_REPORT_REASONS = ['Inappropriate content', 'Copyright violation', 'Spam', 'Other'];

router.post('/video/:id/report',
  optionalAuth,
  [
    param('id').isUUID().withMessage('Invalid video ID'),
    body('reason').isIn(VALID_REPORT_REASONS).withMessage('Invalid report reason'),
  ],
  validate,
  async (req, res) => {
    try {
      const videoCheck = await db.query('SELECT id, cloudflare_video_id FROM videos WHERE id = $1', [req.params.id]);
      if (!videoCheck.rows.length) return res.status(404).json({ error: 'Video not found' });
      const video = videoCheck.rows[0];

      await db.query(
        'INSERT INTO video_reports (video_id, reason, reporter_clerk_id) VALUES ($1, $2, $3)',
        [req.params.id, req.body.reason, req.clerkUserId || null]
      );

      const { rows: countRows } = await db.query(
        'SELECT COUNT(*)::int AS count FROM video_reports WHERE video_id = $1',
        [req.params.id]
      );
      const reportCount = countRows[0].count;
      const thresholdReached = reportCount >= REPORT_THRESHOLD;

      if (thresholdReached) {
        await db.query(`UPDATE videos SET status = 'under_review' WHERE id = $1`, [video.id]);
        // Not awaited — moderateReportedVideo does its own thumbnail fetch,
        // AWS call, and email send, none of which the reporting user should
        // have to wait on. It has full internal error handling and never
        // throws, but .catch() here is a defensive backstop.
        moderateReportedVideo(video.id, video.cloudflare_video_id).catch((err) => {
          console.error('moderateReportedVideo unexpected error:', err.message);
        });
      }

      res.status(201).json({ success: true, report_count: reportCount, threshold_reached: thresholdReached });
    } catch (err) {
      console.error('video report error:', err.message);
      res.status(500).json({ error: 'Could not submit report' });
    }
  }
);


// ============================================================
//  ADMIN ROUTES
//  All routes below require an x-admin-email header matching
//  ADMIN_EMAIL (see the requireAdmin guard above for the caveat
//  that this is a spoofable, temporary check).
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
 *   POST /api/suns/cashout   { amountSuns: 1000, channel: 'mobile_money_mpesa', phoneNumber: '+254...', localCurrencyCode: 'KES' }
 *   GET  /api/wallet/balance
 *   GET  /api/suns/ledger
 */