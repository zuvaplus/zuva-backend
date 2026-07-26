'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { getAdapterByName } = require('./PayoutRouter');

/**
 * ============================================================
 *  POST /api/webhooks/payouts/:provider
 * ============================================================
 *  Single inbound webhook endpoint for all payout providers. The
 *  :provider param picks the adapter, which must verify the request
 *  signature (over req.rawBody) before anything is processed —
 *  unverified webhooks get a 401 and touch nothing.
 *
 *  Outcomes:
 *    completed → payout marked completed, creator lifetime cashout
 *                stat updated
 *    failed    → creator's Suns re-credited atomically (reverse
 *                double entry), payout marked failed
 *
 *  Mounted in server.js BEFORE the global /api rate limiter —
 *  provider retry bursts must never be throttled into missed events.
 */
module.exports = function createPayoutWebhookRouter(pool, writeDoubleEntry) {
  const router = express.Router();

  router.post('/:provider', async (req, res) => {
    const adapter = getAdapterByName(req.params.provider);
    if (!adapter) {
      return res.status(404).json({ error: 'Unknown payout provider' });
    }

    if (!adapter.verifyWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const event = adapter.parseWebhookEvent(req);
    if (!event) {
      // Verified but not a payout status change (or an intermediate
      // state) — ack so the provider stops retrying.
      return res.sendStatus(200);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the payout row; only act if it's still in flight. A repeat
      // delivery of the same event finds a terminal status and no-ops.
      const { rows } = await client.query(
        `SELECT p.id, p.creator_id, p.amount_suns, p.status,
                w.id AS creator_wallet_id
         FROM payouts p
         JOIN wallets w ON w.user_id = p.creator_id
         WHERE p.idempotency_key = $1
         FOR UPDATE OF p`,
        [event.reference]
      );

      if (!rows.length) {
        await client.query('ROLLBACK');
        console.error(`[payout-webhook] ${adapter.name}: no payout for reference ${event.reference}`);
        return res.sendStatus(200); // not ours / already purged — don't make the provider retry forever
      }

      const payout = rows[0];
      if (payout.status !== 'pending' && payout.status !== 'processing') {
        await client.query('ROLLBACK');
        return res.sendStatus(200); // already terminal — duplicate delivery
      }

      if (event.outcome === 'completed') {
        await client.query(
          `UPDATE payouts
           SET status = 'completed',
               provider_reference = COALESCE($1, provider_reference),
               processed_at = NOW()
           WHERE id = $2`,
          [event.providerReference, payout.id]
        );
        await client.query(
          `UPDATE wallets SET total_cashed_out_suns = total_cashed_out_suns + $1
           WHERE id = $2`,
          [payout.amount_suns, payout.creator_wallet_id]
        );
      } else {
        // failed → return the Suns: reverse of the cashout double entry
        // (platform wallet back to creator wallet, same atomic guarantees).
        const platformWalletRes = await client.query(
          'SELECT id FROM wallets WHERE user_id = $1',
          [process.env.PLATFORM_WALLET_ID]
        );
        const platformWalletId = platformWalletRes.rows[0]?.id;
        if (!platformWalletId) throw new Error('Platform wallet not found');

        await writeDoubleEntry(client, {
          debitWalletId:  platformWalletId,
          creditWalletId: payout.creator_wallet_id,
          amountSuns:     payout.amount_suns,
          type:           'creator_payout',
          transactionRef: randomUUID(),
          relatedUserId:  payout.creator_id,
          providerRef:    event.providerReference,
          memo: `Payout ${payout.id} failed at ${adapter.name} — Suns returned`,
        });

        await client.query(
          `UPDATE payouts
           SET status = 'failed',
               provider_reference = COALESCE($1, provider_reference),
               processed_at = NOW()
           WHERE id = $2`,
          [event.providerReference, payout.id]
        );
      }

      await client.query('COMMIT');
      console.log(`[payout-webhook] ${adapter.name}: payout ${payout.id} → ${event.outcome}`);
      res.sendStatus(200);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[payout-webhook] ${adapter.name} error:`, err.message);
      // 500 → provider retries later, which is what we want on a transient DB error
      res.status(500).json({ error: 'Webhook processing failed' });
    } finally {
      client.release();
    }
  });

  return router;
};
