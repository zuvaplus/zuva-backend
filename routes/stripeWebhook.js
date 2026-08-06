'use strict';

/**
 * ============================================================
 *  POST /api/webhooks/stripe — Suns purchase webhook
 * ============================================================
 *  Separate from zuva-backend/routes/ads.js's own Stripe webhook
 *  (POST /api/ads/advertise/webhook) — different product line
 *  (consumer Suns top-ups vs B2B Ads billing), own Stripe Dashboard
 *  webhook endpoint, own signing secret. Same "separate endpoint"
 *  decision already confirmed for the Ads webhook.
 *
 *  Required environment variables:
 *    STRIPE_SUNS_WEBHOOK_SECRET — this endpoint's own Stripe Dashboard
 *      signing secret. Distinct from routes/ads.js's STRIPE_WEBHOOK_SECRET
 *      — every registered Stripe webhook endpoint gets its own secret,
 *      even when pointed at the same Stripe account/API key.
 *    STRIPE_SECRET_KEY — already exists (shared with zuva-api.js and
 *      routes/ads.js — one Stripe account, one secret key, multiple
 *      webhook endpoints).
 *
 *  Raw body: this route was asked to be "mounted before express.json()"
 *  with a route-specific express.raw() parser, on the assumption that
 *  no raw-body handling exists yet. One already does, and it's not
 *  positioned that way: server.js's global express.json({ verify })
 *  hook (mounted once, before every route) captures the exact raw byte
 *  buffer of every request into req.rawBody before parsing — the same
 *  mechanism services/payouts/webhookRouter.js and routes/ads.js's own
 *  webhook already rely on for their signature checks. This file uses
 *  req.rawBody directly; no new body-parsing middleware was added
 *  anywhere, and this router is mounted AFTER express.json() in
 *  server.js, same as those other two.
 *
 *  Nodemailer transport/helpers below are duplicated from zuva-api.js
 *  (not exported there) — same reasoning as routes/ads.js's own
 *  duplicate copy: zuva-api.js only exports { router, pool,
 *  writeDoubleEntry}, and widening that surface felt out of scope for
 *  a new route file. This is now a third copy of the same ~50 lines
 *  across the codebase; consolidating into one shared module is a
 *  reasonable future cleanup, not attempted here since it would mean
 *  touching two other already-working files for a purely cosmetic win.
 */

const express = require('express');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const { randomUUID } = require('crypto');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

let mailTransport = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
} else {
  console.error('[suns-webhook/mail] GMAIL_USER / GMAIL_APP_PASSWORD not set — purchase confirmation emails will not be sent.');
}

// Never throws — a broken mail setup must not fail webhook processing,
// same contract as every other sendMail-style helper in this codebase.
async function sendMail(to, subject, htmlBody) {
  if (!mailTransport) {
    console.error(`[suns-webhook/mail] Skipping email "${subject}" to ${to} — mail transport not configured.`);
    return;
  }
  try {
    await mailTransport.sendMail({ from: process.env.GMAIL_USER, to, subject, html: htmlBody });
  } catch (err) {
    console.error(`[suns-webhook/mail] Failed to send email "${subject}" to ${to}:`, err.message);
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

// Same branded shell as zuva-api.js's brandedEmailHtml (duplicated —
// see the file header note above).
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

const APP_URL = process.env.APP_URL || 'https://zuva.tv';

module.exports = function createStripeWebhookRouter(pool, writeDoubleEntry) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    if (!stripe || !process.env.STRIPE_SUNS_WEBHOOK_SECRET) {
      console.error('webhooks/stripe: Stripe not configured');
      return res.status(400).json({ error: 'Webhook not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        process.env.STRIPE_SUNS_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('webhooks/stripe signature verification failed:', err.message);
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // Only ours — this endpoint could in principle receive other
        // Checkout Session completions if the Stripe Dashboard webhook
        // is ever scoped too broadly; ack and skip rather than error.
        if (session.metadata?.purchase_type !== 'suns') {
          return res.sendStatus(200);
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Look up by the Stripe session id, stored on creation in
          // chimoney_payment_id (repurposed — see POST /suns/purchase's
          // own comment on this table's real, undocumented columns).
          const { rows } = await client.query(
            `SELECT id, buyer_id, suns_purchased, status
             FROM sun_purchases
             WHERE chimoney_payment_id = $1
             FOR UPDATE`,
            [session.id]
          );

          if (!rows.length) {
            await client.query('ROLLBACK');
            console.error(`webhooks/stripe: no sun_purchases row for session ${session.id}`);
            return res.sendStatus(200); // nothing to reconcile — ack so Stripe stops retrying
          }

          const purchase = rows[0];
          if (purchase.status === 'completed') {
            await client.query('ROLLBACK');
            return res.sendStatus(200); // already processed — idempotent redelivery
          }

          const buyerWalletRes = await client.query(
            'SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE',
            [purchase.buyer_id]
          );
          const buyerWalletId = buyerWalletRes.rows[0]?.id;
          if (!buyerWalletId) throw new Error(`Wallet not found for user ${purchase.buyer_id}`);

          const platformWalletRes = await client.query(
            'SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE',
            [process.env.PLATFORM_WALLET_ID]
          );
          const platformWalletId = platformWalletRes.rows[0]?.id;
          if (!platformWalletId) throw new Error('Platform wallet not found');

          const transactionRef = randomUUID();

          // Suns are "minted" from the platform wallet into the buyer's,
          // same double-entry shape the pre-removal Chimoney flow used
          // (see git history, commit 8b8305a) and the same
          // writeDoubleEntry every other money route in this codebase
          // goes through.
          await writeDoubleEntry(client, {
            debitWalletId:  platformWalletId,
            creditWalletId: buyerWalletId,
            amountSuns:     purchase.suns_purchased,
            type:           'sun_purchase',
            transactionRef,
            providerRef:    session.id,
            memo: `Purchase of ${purchase.suns_purchased} Suns via Stripe`,
          });

          await client.query(
            `UPDATE sun_purchases
             SET status = 'completed', completed_at = NOW(), ledger_transaction_ref = $1
             WHERE id = $2`,
            [transactionRef, purchase.id]
          );

          // total_purchased_suns only — NOT total_earned_suns, which is
          // reserved for creator tip income and stays untouched here.
          const { rows: walletRows } = await client.query(
            `UPDATE wallets
             SET total_purchased_suns = total_purchased_suns + $1
             WHERE id = $2
             RETURNING balance_suns`,
            [purchase.suns_purchased, buyerWalletId]
          );
          const newBalance = walletRows[0]?.balance_suns ?? null;

          await client.query('COMMIT');

          const customerEmail = session.customer_details?.email || session.customer_email;
          const usdPaid = ((session.amount_total ?? 0) / 100).toFixed(2);
          if (customerEmail) {
            sendMail(
              customerEmail,
              'Your Suns are ready ☀️',
              brandedEmailHtml({
                heading: 'Your Suns are ready!',
                paragraphs: [
                  `You paid <strong>$${escapeHtml(usdPaid)} USD</strong> for <strong>${purchase.suns_purchased.toLocaleString()} Suns</strong>.`,
                  newBalance !== null
                    ? `Your new wallet balance is <strong>${newBalance.toLocaleString()} Suns</strong>.`
                    : 'They’ve been added to your wallet.',
                ],
                ctaText: 'Go to Zuva',
                ctaUrl:  `${APP_URL}/wallet`,
              })
            );
          }
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(`webhooks/stripe error handling ${event.type}:`, err.message);
      // NOT 200 — the signature already verified, so this is a
      // transient processing failure (e.g. a DB hiccup), not an
      // unrecognized/unhandled event. A 5xx makes Stripe retry with
      // backoff instead of silently losing a payment confirmation —
      // same reasoning as routes/ads.js's own webhook.
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
};
