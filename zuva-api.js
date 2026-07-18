/**
 * ============================================================
 *  ZUVA.TV  —  Core API  (Node.js / Express)
 *  Suns Economy: Purchase, Tip, Cash Out
 * ============================================================
 *  Install dependencies:
 *    npm install express pg axios dotenv express-validator
 *
 *  Required .env variables:
 *    DATABASE_URL=postgresql://user:pass@host:5432/zuva
 *    CHIMONEY_API_KEY=your_chimoney_key
 *    CHIMONEY_BASE_URL=https://api.chimoney.io/v0.2
 *    PLATFORM_WALLET_ID=00000000-0000-0000-0000-000000000001
 *    JWT_SECRET=your_jwt_secret
 * ============================================================
 */

'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const axios      = require('axios');
const { randomUUID: uuidv4 } = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
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

// ─── Chimoney client ──────────────────────────────────────────
const chimoney = axios.create({
  baseURL: process.env.CHIMONEY_BASE_URL,
  headers: {
    'X-API-KEY': process.env.CHIMONEY_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// ─── Constants ────────────────────────────────────────────────
const SUNS_PER_USD        = 1000;  // 1000 Suns = $1.00 USD
const PLATFORM_WALLET_ID  = process.env.PLATFORM_WALLET_ID;
const MIN_CASHOUT_SUNS    = 10000; // minimum 10,000 Suns ($10) to cash out

// ── Safety spread on outbound exchange rates ──────────────────
// Applied to the Chimoney rate at the moment a creator clicks Cashout.
// If the live rate is 1000 KES/USD, we use 990 KES/USD (1% less).
// This 1% buffer absorbs rate movement between when the creator
// confirms and when Chimoney actually clears the payment (minutes
// to hours). The surplus accrues to the platform as FX hedging.
// To adjust: change the multiplier (0.99 = 1%, 0.98 = 2%, etc.)
// NEVER set above 1.0 — that would expose Zuva to rate loss.
const EXCHANGE_RATE_SAFETY_SPREAD = 0.99;

// Supported pay-in currencies and their live-to-USD rate fetch
const SUPPORTED_FIAT_CURRENCIES = ['USD', 'GBP', 'CAD', 'AUD'];

// ─── Middleware: simple auth guard (replace with your JWT middleware) ───
const requireAuth = (req, res, next) => {
  // In production: verify JWT from Authorization header
  // and attach req.user = { id, walletId, role }
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const requireCreator = (req, res, next) => {
  if (req.user?.role !== 'creator' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Creator account required' });
  }
  next();
};

// ─── Middleware: admin guard ────────────────────────────────────
// TEMPORARY, same tradeoff as requireAuth above: this trusts a caller-
// supplied header instead of verifying a signed session, so anyone who
// knows ADMIN_EMAIL can spoof it. Replace with real Clerk session
// verification (e.g. @clerk/backend, checking the verified session's
// email) before this goes to production.
const requireAdmin = (req, res, next) => {
  const callerEmail = req.headers['x-admin-email'];
  if (!process.env.ADMIN_EMAIL || callerEmail !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ─── Validation error handler ─────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};


// ============================================================
//  UTILITY: Fetch live exchange rate (fiat → USD)
//  In production use a reliable provider: Open Exchange Rates,
//  Wise API, or Chimoney's own rates endpoint.
// ============================================================
async function getFiatToUsdRate(currencyCode) {
  if (currencyCode === 'USD') return 1.0;
  try {
    // Chimoney exposes an exchange rates endpoint
    const resp = await chimoney.get('/info/exchange-rates');
    const rates = resp.data?.data;
    if (rates && rates[currencyCode]) {
      return parseFloat(rates[currencyCode]);
    }
    throw new Error(`Rate not found for ${currencyCode}`);
  } catch (err) {
    throw new Error(`Could not fetch exchange rate for ${currencyCode}: ${err.message}`);
  }
}


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
//    opts           — { contentId, relatedUserId, chimoneyRef, memo, rate }
// ============================================================
async function writeDoubleEntry(client, {
  debitWalletId,
  creditWalletId,
  amountSuns,
  type,
  transactionRef,
  contentId        = null,
  relatedUserId    = null,
  chimoneyRef      = null,
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
      contentId, relatedUserId, chimoneyRef, exchangeRate, memo]);

  // Insert CREDIT row (money arrives at creditWallet)
  await client.query(`
    INSERT INTO ledger_entries
      (wallet_id, direction, amount_suns, type, transaction_ref,
       content_id, related_user_id, chimoney_payment_ref, usd_exchange_rate, memo)
    VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7, $8, $9)
  `, [creditWalletId, amountSuns, type, transactionRef,
      contentId, relatedUserId, chimoneyRef, exchangeRate, memo]);

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
//  Diaspora user buys Suns with fiat currency.
//
//  Flow:
//    1. Validate request
//    2. Fetch live exchange rate (fiat → USD)
//    3. Calculate Suns to issue (fiat × fiatToUsd × SUNS_PER_USD)
//    4. Create a pending sun_purchase record
//    5. Call Chimoney to create a payment checkout link
//    6. Return the Chimoney checkout URL to the frontend
//    7. Chimoney calls our webhook (/api/webhooks/chimoney) on payment success
//    8. Webhook: write double-entry ledger, mark purchase complete
// ============================================================
router.post('/suns/purchase',
  requireAuth,
  [
    body('fiatAmount')
      .isFloat({ min: 1.00 })
      .withMessage('Minimum purchase is $1.00'),
    body('fiatCurrency')
      .isIn(SUPPORTED_FIAT_CURRENCIES)
      .withMessage(`Currency must be one of: ${SUPPORTED_FIAT_CURRENCIES.join(', ')}`),
  ],
  validate,
  async (req, res) => {
    const { fiatAmount, fiatCurrency } = req.body;
    const buyerId = req.user.id;

    try {
      // ── Step 1: Get live exchange rate ──────────────────────
      const fiatToUsdRate = await getFiatToUsdRate(fiatCurrency);
      const usdEquivalent = parseFloat(fiatAmount) * fiatToUsdRate;

      // ── Step 2: Calculate Suns ──────────────────────────────
      // Floor to nearest whole Sun (no fractional Suns in the ledger)
      const sunsPurchased = Math.floor(usdEquivalent * SUNS_PER_USD);

      if (sunsPurchased < 1000) {
        return res.status(400).json({
          error: 'Minimum purchase is equivalent to 1,000 Suns ($1.00 USD)',
        });
      }

      // ── Step 3: Create pending purchase record ──────────────
      const purchaseId = uuidv4();
      await db.query(`
        INSERT INTO sun_purchases
          (id, buyer_id, fiat_amount, fiat_currency, suns_purchased, fiat_to_usd_rate)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [purchaseId, buyerId, fiatAmount, fiatCurrency, sunsPurchased, fiatToUsdRate]);

      // ── Step 4: Call Chimoney to initiate payment ───────────
      // Chimoney's payment/initiate creates a hosted checkout page.
      // The user is redirected there to complete payment.
      // Chimoney notifies us via webhook when payment clears.
      const chimoneyPayload = {
        valueInUSD:    usdEquivalent,
        currency:      fiatCurrency,
        amount:        parseFloat(fiatAmount),
        paymentType:   'card',  // Chimoney supports card, bank, mobile money
        redirect_url:  `${process.env.APP_URL}/purchase-success?id=${purchaseId}`,
        meta: {
          purchaseId,
          buyerId,
          sunsPurchased,
          platform: 'zuva.tv',
        },
      };

      const chimoneyResp = await chimoney.post('/payment/initiate', chimoneyPayload);
      const { paymentLink, issueID } = chimoneyResp.data?.data || {};

      if (!paymentLink) {
        throw new Error('Chimoney did not return a payment link');
      }

      // ── Step 5: Update purchase record with Chimoney details ─
      await db.query(`
        UPDATE sun_purchases
        SET chimoney_payment_id = $1, chimoney_checkout_url = $2, chimoney_response = $3
        WHERE id = $4
      `, [issueID, paymentLink, JSON.stringify(chimoneyResp.data), purchaseId]);

      // Return checkout URL — frontend redirects user here
      res.json({
        success:        true,
        purchaseId,
        sunsPurchased,
        fiatAmount:     parseFloat(fiatAmount),
        fiatCurrency,
        usdEquivalent:  usdEquivalent.toFixed(2),
        checkoutUrl:    paymentLink,
        message: `Pay ${fiatCurrency} ${fiatAmount} to receive ${sunsPurchased.toLocaleString()} Suns`,
      });

    } catch (err) {
      console.error('sun purchase error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Purchase initiation failed. Please try again.' });
    }
  }
);


// ============================================================
//  ROUTE 3: POST /api/webhooks/chimoney
//  Chimoney calls this when a payment_initiate is completed.
//  This is where Suns are actually credited to the user's wallet.
//
//  SECURITY: Verify Chimoney's webhook signature before processing.
//  Chimoney sends an X-Chimoney-Signature header — validate it.
// ============================================================
router.post('/webhooks/chimoney', async (req, res) => {
  const { issueID, status, meta } = req.body;

  // TODO: Verify webhook signature
  // const sig = req.headers['x-chimoney-signature'];
  // if (!verifyChimoneySignature(sig, req.body)) return res.sendStatus(401);

  if (status !== 'paid' && status !== 'success') {
    // Chimoney sends webhooks for all status changes; ignore non-success ones
    return res.sendStatus(200);
  }

  const { purchaseId, buyerId, sunsPurchased } = meta || {};
  if (!purchaseId || !buyerId || !sunsPurchased) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check purchase hasn't already been processed (idempotency guard)
    const { rows } = await client.query(
      'SELECT status FROM sun_purchases WHERE id = $1 FOR UPDATE',
      [purchaseId]
    );
    if (!rows.length || rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.sendStatus(200); // already processed, return 200 so Chimoney stops retrying
    }

    // Get buyer's wallet ID
    const walletRes = await client.query(
      'SELECT id FROM wallets WHERE user_id = $1', [buyerId]
    );
    const buyerWalletId = walletRes.rows[0]?.id;
    if (!buyerWalletId) throw new Error(`Wallet not found for user ${buyerId}`);

    // Get platform wallet ID
    const platformWalletRes = await client.query(
      'SELECT id FROM wallets WHERE user_id = $1', [PLATFORM_WALLET_ID]
    );
    const platformWalletId = platformWalletRes.rows[0]?.id;

    const transactionRef = uuidv4();

    // ── Write double entry ─────────────────────────────────────
    // DEBIT platform reserve (Suns are "created" from a platform reserve concept)
    // CREDIT buyer's wallet
    // Note: In a real system the "platform reserve" is a dedicated account
    // representing the total Suns in circulation. We use the platform wallet.
    await writeDoubleEntry(client, {
      debitWalletId:  platformWalletId,
      creditWalletId: buyerWalletId,
      amountSuns:     parseInt(sunsPurchased),
      type:           'sun_purchase',
      transactionRef,
      chimoneyRef:    issueID,
      memo:           `Purchase of ${sunsPurchased} Suns via Chimoney`,
    });

    // Update purchase record
    await client.query(`
      UPDATE sun_purchases
      SET status = 'completed', completed_at = NOW(), ledger_transaction_ref = $1
      WHERE id = $2
    `, [transactionRef, purchaseId]);

    // Update wallet lifetime stats
    await client.query(`
      UPDATE wallets SET total_earned_suns = total_earned_suns + $1 WHERE id = $2
    `, [sunsPurchased, buyerWalletId]);

    await client.query('COMMIT');
    console.log(`✓ ${sunsPurchased} Suns credited to user ${buyerId} (purchase ${purchaseId})`);
    res.sendStatus(200);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  } finally {
    client.release();
  }
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
//  Creator cashes out their Suns balance to mobile money or bank.
//
//  Flow:
//    1. Validate request and check minimum cashout amount
//    2. Verify creator's wallet has sufficient balance
//    3. Fetch live USD → local currency exchange rate from Chimoney
//    4. Calculate fiat payout amount (Suns ÷ 100 = USD, then to local)
//    5. Debit creator wallet, credit platform payout record
//    6. Call Chimoney payout API to send funds
//    7. Update payout record with Chimoney's response
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
      .isInt({ min: MIN_CASHOUT_SUNS })
      .withMessage(`Minimum cashout is ${MIN_CASHOUT_SUNS} Suns ($${MIN_CASHOUT_SUNS / SUNS_PER_USD} USD)`),
    body('channel')
      .isIn(['mobile_money_mpesa','mobile_money_mtn','mobile_money_airtel',
             'mobile_money_ecocash','bank_transfer','chimoney_wallet'])
      .withMessage('Invalid payout channel'),
    body('phoneNumber')
      .optional()
      .isMobilePhone()
      .withMessage('Invalid phone number'),
    body('bankAccountRef')
      .optional()
      .isString(),
    body('localCurrencyCode')
      .isLength({ min: 3, max: 3 })
      .withMessage('Provide a valid ISO 4217 currency code (e.g. KES, GHS, JMD)'),
  ],
  validate,
  async (req, res) => {
    const {
      amountSuns,
      channel,
      phoneNumber,
      bankAccountRef,
      localCurrencyCode,
    } = req.body;
    const creatorId = req.user.id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // ── Step 1: Lock and verify creator wallet balance ───────
      const walletRes = await client.query(`
        SELECT w.id, w.balance_suns, cp.tier, cp.creator_share_pct, cp.platform_share_pct
        FROM wallets w
        JOIN creator_profiles cp ON cp.user_id = w.user_id
        WHERE w.user_id = $1
        FOR UPDATE OF w
      `, [creatorId]);

      if (!walletRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Creator wallet not found' });
      }

      const wallet = walletRes.rows[0];

      if (wallet.balance_suns < amountSuns) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient balance',
          balance_suns: wallet.balance_suns,
          requested_suns: amountSuns,
        });
      }

      // ── Step 2: Calculate fiat payout amount ─────────────────
      // amountSuns ÷ 100 = USD value
      // USD × exchange_rate = local currency amount
      const usdAmount = amountSuns / SUNS_PER_USD;

      // Fetch live rate from Chimoney and apply 1% safety spread
      // ── Why a safety spread? ────────────────────────────────────
      // The rate we show the creator at click-time may shift before
      // Chimoney actually clears the payment. The 1% buffer (EXCHANGE_RATE_SAFETY_SPREAD = 0.99)
      // means Zuva pays out at 99% of the mid-market rate.
      // Example: live rate = 1302.50 KES/USD
      //   Effective rate    = 1302.50 × 0.99 = 1289.47 KES/USD
      //   Creator receives  = usdAmount × 1289.47 KES
      //   Platform retains  = usdAmount × 13.03 KES (the FX buffer)
      // The buffer is logged per-payout and accrues to the platform wallet.
      // NEVER set EXCHANGE_RATE_SAFETY_SPREAD above 1.0.
      let rawExchangeRate  = 1.0;   // mid-market rate straight from Chimoney
      let exchangeRate     = 1.0;   // rate applied after spread (this is what we pay out at)
      let localAmount      = usdAmount;
      let fxBufferAmount   = 0;     // local-currency units held as FX hedging buffer

      if (localCurrencyCode !== 'USD') {
        const ratesResp = await chimoney.get('/info/exchange-rates');
        const rates     = ratesResp.data?.data;
        if (!rates || !rates[localCurrencyCode]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Unsupported payout currency: ${localCurrencyCode}` });
        }

        rawExchangeRate   = parseFloat(rates[localCurrencyCode]);
        exchangeRate      = rawExchangeRate * EXCHANGE_RATE_SAFETY_SPREAD;

        const rawLocal    = usdAmount * rawExchangeRate;
        localAmount       = usdAmount * exchangeRate;
        fxBufferAmount    = rawLocal - localAmount;

        console.log(
          `[FX:cashout] ${localCurrencyCode} ` +
          `raw=${rawExchangeRate.toFixed(4)} ` +
          `spread=${((1 - EXCHANGE_RATE_SAFETY_SPREAD) * 100).toFixed(1)}% ` +
          `effective=${exchangeRate.toFixed(4)} ` +
          `buffer=${fxBufferAmount.toFixed(2)} ${localCurrencyCode}`
        );
      }

      // ── Step 3: Create payout record (before calling Chimoney) ─
      const payoutId       = uuidv4();
      const transactionRef = uuidv4();

      await client.query(`
        INSERT INTO payouts (
          id, creator_id, amount_suns, creator_suns, platform_suns,
          tier_at_payout, creator_pct_at_payout,
          usd_amount, local_currency_code, local_currency_amount, exchange_rate,
          channel, payout_phone, payout_bank_ref,
          status, ledger_transaction_ref
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'processing',$15)
      `, [
        payoutId, creatorId,
        amountSuns,
        amountSuns,  // creator_suns = full amount (commission already deducted at tip time)
        0,           // platform_suns = 0 at cashout (already collected)
        wallet.tier, wallet.creator_share_pct,
        usdAmount.toFixed(2), localCurrencyCode,
        localAmount.toFixed(2), exchangeRate.toFixed(6),
        channel, phoneNumber || null, bankAccountRef || null,
        transactionRef,
      ]);

      // ── Step 4: Debit creator wallet ─────────────────────────
      // We debit creator wallet → platform "outgoing" account.
      // This records that the money has left the platform's custody.
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
        chimoneyRef:    null,  // filled in after Chimoney responds
        exchangeRate,
        memo: `Cashout: ${amountSuns} Suns → ${localAmount.toFixed(2)} ${localCurrencyCode} via ${channel}`,
      });

      // ── Step 5: Call Chimoney payout API ─────────────────────
      let chimoneyPayload;
      let chimoneyEndpoint;

      if (channel.startsWith('mobile_money')) {
        // Map our channel to Chimoney's mobile money network name
        const networkMap = {
          mobile_money_mpesa:  'mpesa',
          mobile_money_mtn:    'mtn',
          mobile_money_airtel: 'airtel',
          mobile_money_ecocash:'ecocash',
        };
        chimoneyEndpoint = '/payouts/mobile-money';
        chimoneyPayload  = {
          valueInUSD: usdAmount,
          receiver: [{
            phone:      phoneNumber,
            network:    networkMap[channel],
            countryCode: localCurrencyCode === 'KES' ? 'KE'
                       : localCurrencyCode === 'GHS' ? 'GH'
                       : localCurrencyCode === 'ZWL' ? 'ZW'
                       : undefined,
            valueInUSD: usdAmount,
          }],
          meta: { payoutId, creatorId, platform: 'zuva.tv' },
        };
      } else if (channel === 'bank_transfer') {
        chimoneyEndpoint = '/payouts/bank';
        chimoneyPayload  = {
          valueInUSD: usdAmount,
          receiver: [{
            bankAccountNumber: bankAccountRef,
            valueInUSD:        usdAmount,
          }],
          meta: { payoutId, creatorId, platform: 'zuva.tv' },
        };
      } else {
        // chimoney_wallet — fastest, no conversion fee
        chimoneyEndpoint = '/payouts/chimoney';
        chimoneyPayload  = {
          chimoneys: [{
            email:      req.user.email,
            valueInUSD: usdAmount,
          }],
          meta: { payoutId, creatorId, platform: 'zuva.tv' },
        };
      }

      const chimoneyResp = await chimoney.post(chimoneyEndpoint, chimoneyPayload);
      const issueID      = chimoneyResp.data?.data?.issueID;

      // ── Step 6: Update payout with Chimoney response ─────────
      await client.query(`
        UPDATE payouts
        SET status = 'processing', chimoney_issue_id = $1, chimoney_response = $2, processed_at = NOW()
        WHERE id = $3
      `, [issueID, JSON.stringify(chimoneyResp.data), payoutId]);

      // Update creator wallet lifetime cashout stat
      await client.query(`
        UPDATE wallets SET total_cashed_out_suns = total_cashed_out_suns + $1 WHERE user_id = $2
      `, [amountSuns, creatorId]);

      await client.query('COMMIT');

      res.json({
        success:        true,
        payoutId,
        transactionRef,
        amountSuns,
        usdAmount:      usdAmount.toFixed(2),
        localAmount:    localAmount.toFixed(2),
        localCurrency:  localCurrencyCode,
        exchangeRate:   exchangeRate.toFixed(4),
        channel,
        chimoneyIssueId: issueID,
        status:         'processing',
        message: `${amountSuns} Suns (${localAmount.toFixed(2)} ${localCurrencyCode}) sent via Chimoney. Usually arrives within minutes.`,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('cashout error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Cashout failed. Your balance has not been changed.' });
    } finally {
      client.release();
    }
  }
);


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
      const table  = orientation === 'vertical' ? 'vertical_content' : 'landscape_content';
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
    const view   = o === 'vertical' ? 'trending_vertical_24h' : 'trending_landscape_24h';
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
    const table = o === 'vertical' ? 'vertical_content' : 'landscape_content';
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
    const table = o === 'vertical' ? 'vertical_content' : 'landscape_content';
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
//    id                SERIAL PRIMARY KEY,
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
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('email').trim().isEmail().withMessage('A valid email is required'),
    body('country').trim().notEmpty().withMessage('Country is required'),
    body('primaryPlatform').trim().notEmpty().withMessage('Primary platform is required'),
    body('socialHandle').trim().notEmpty().withMessage('Social media handle is required'),
    body('contentCategory').trim().notEmpty().withMessage('Content category is required'),
    body('followerCount').trim().notEmpty().withMessage('Follower count range is required'),
    body('marketingConsent').optional().isBoolean(),
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
      // Applications are auto-approved on submission (no manual review step) —
      // the admin Applications tab still lists every application and can
      // reject/re-approve after the fact.
      await db.query(`
        INSERT INTO creator_applications
          (full_name, email, country, primary_platform, social_handle, content_category, follower_count, marketing_consent, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', NOW())
      `, [
        fullName, email, country, primaryPlatform, socialHandle,
        contentCategory, followerCount, Boolean(marketingConsent),
      ]);

      res.status(201).json({ success: true });
    } catch (err) {
      console.error('creator signup error:', err.message);
      res.status(500).json({ error: 'Could not submit application' });
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
             content_category, follower_count, status, created_at
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
router.patch('/admin/applications/:id',
  requireAdmin,
  [
    param('id').isInt().withMessage('Invalid application ID'),
    body('status').isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE creator_applications SET status = $1 WHERE id = $2 RETURNING id, status`,
        [req.body.status, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Application not found' });
      res.json({ success: true, application: rows[0] });
    } catch (err) {
      console.error('admin application update error:', err.message);
      res.status(500).json({ error: 'Could not update application' });
    }
  }
);

// ── GET /api/admin/content ───────────────────────────────────
// Content lives in two tables (vertical_content / landscape_content) —
// this unions both and tags each row with its orientation so the
// PATCH/DELETE routes below know which table to act on.
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
             c.published_at, c.moderation_status AS status,
             COALESCE(c.reports_count, 0) AS reports_count
      FROM (
        SELECT id, 'vertical'::text AS orientation, title, creator_id, published_at, moderation_status, reports_count
        FROM vertical_content
        UNION ALL
        SELECT id, 'landscape'::text AS orientation, title, creator_id, published_at, moderation_status, reports_count
        FROM landscape_content
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

// ── PATCH /api/admin/content/:id?orientation=vertical|landscape ──
router.patch('/admin/content/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid content ID'),
    query('orientation').isIn(['vertical', 'landscape']).withMessage('orientation query param is required'),
    body('status').isIn(['pending', 'approved', 'rejected', 'flagged']).withMessage('Invalid status'),
  ],
  validate,
  async (req, res) => {
    const table = req.query.orientation === 'vertical' ? 'vertical_content' : 'landscape_content';
    try {
      const { rows } = await db.query(
        `UPDATE ${table} SET moderation_status = $1 WHERE id = $2 RETURNING id, moderation_status AS status`,
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

// ── DELETE /api/admin/content/:id?orientation=vertical|landscape ──
// Soft-deletes (sets deleted_at) instead of a hard DELETE, so it doesn't
// break FK references from tips/ledger_entries. The public feed queries
// already filter on deleted_at IS NULL, so this hides the content
// immediately, same as setting status to 'rejected'.
router.delete('/admin/content/:id',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Invalid content ID'),
    query('orientation').isIn(['vertical', 'landscape']).withMessage('orientation query param is required'),
  ],
  validate,
  async (req, res) => {
    const table = req.query.orientation === 'vertical' ? 'vertical_content' : 'landscape_content';
    try {
      const { rows } = await db.query(
        `UPDATE ${table} SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Content not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('admin content delete error:', err.message);
      res.status(500).json({ error: 'Could not remove content' });
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
module.exports = router;

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