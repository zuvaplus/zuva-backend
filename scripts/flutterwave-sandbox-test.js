'use strict';
/**
 * ============================================================
 *  Flutterwave sandbox payout test
 *  Usage:  node scripts/flutterwave-sandbox-test.js
 * ============================================================
 *  Exercises the FlutterwaveAdapter end-to-end against the developer
 *  sandbox (developersandbox-api.flutterwave.com): a GHS/MTN and a
 *  KES/M-Pesa mobile-money payout, then polls each transfer's status.
 *
 *  Test-only phone numbers — nothing real is paid in the sandbox.
 *  Exits cleanly with setup instructions if no sandbox key is set.
 */
require('dotenv').config();

const { randomUUID } = require('crypto');
const FlutterwaveAdapter = require('../services/payouts/FlutterwaveAdapter');

if (!process.env.FLUTTERWAVE_SECRET_KEY) {
  console.log(`
Flutterwave sandbox test — no credentials found.

To run this test, add sandbox keys to zuva-backend/.env:

  FLUTTERWAVE_SECRET_KEY=<your sandbox secret key>
  # FLUTTERWAVE_BASE_URL is not needed — the adapter already defaults
  # to https://developersandbox-api.flutterwave.com

Get the key: https://app.flutterwave.com → switch to Test/Sandbox mode
→ Settings → API Keys. (Webhook testing additionally needs
FLUTTERWAVE_WEBHOOK_SECRET_HASH, but this script doesn't use it.)

Nothing was executed. Exiting.
`);
  process.exit(0);
}

const adapter = new FlutterwaveAdapter();

// Sandbox test payouts — Flutterwave's sandbox accepts test msisdns and
// simulates disbursement without moving real money.
const CASES = [
  {
    label: 'Ghana — MTN mobile money (GHS)',
    args: {
      creatorId: 'sandbox-test-creator',
      amountUSD: 5,
      method: 'mobile_money',
      recipientDetails: {
        countryCode: 'GH',
        msisdn: '233700000001', // test number, includes country code
        firstName: 'Ama',
        lastName: 'Mensah',
      },
    },
  },
  {
    label: 'Kenya — M-Pesa mobile money (KES)',
    args: {
      creatorId: 'sandbox-test-creator',
      amountUSD: 5,
      method: 'mobile_money',
      recipientDetails: {
        countryCode: 'KE',
        msisdn: '254700000001', // test number, includes country code
        firstName: 'Wanjiku',
        lastName: 'Kamau',
      },
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;

  for (const { label, args } of CASES) {
    const idempotencyKey = randomUUID();
    console.log(`\n━━━ ${label} ━━━`);
    console.log(`  amount: $${args.amountUSD} USD · msisdn: ${args.recipientDetails.msisdn}`);
    console.log(`  idempotency key: ${idempotencyKey}`);

    try {
      const result = await adapter.initiatePayout({ ...args, idempotencyKey });
      console.log(`  ✓ initiated — provider reference: ${result.providerReference}`);

      // Poll status a few times; sandbox transfers usually settle fast.
      for (let attempt = 1; attempt <= 5; attempt++) {
        await sleep(3000);
        const { status } = await adapter.getPayoutStatus(result.providerReference);
        console.log(`  status poll ${attempt}: ${status}`);
        if (status === 'SUCCESSFUL' || status === 'FAILED') {
          if (status === 'FAILED') failures++;
          break;
        }
      }
    } catch (err) {
      failures++;
      console.error(`  ✗ FAILED: ${err.message}`);
      if (err.response?.data) {
        console.error('  provider response:', JSON.stringify(err.response.data, null, 2));
      }
    }
  }

  console.log(`\n${failures === 0 ? '✓ all sandbox payouts initiated' : `✗ ${failures} case(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
