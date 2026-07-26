'use strict';

const PayoutProvider = require('./PayoutProvider');
const { ProviderNotConfiguredError } = PayoutProvider;

/**
 * ============================================================
 *  WiPayAdapter — Caribbean local bank settlement (STUB)
 * ============================================================
 *  Target currencies: JMD, TTD, BBD, GYD, XCD. Shell only — the WiPay
 *  merchant/payout agreement isn't finalized, so nothing here calls out.
 *
 *  TODO(wipay): when the WiPay account is live —
 *    - confirm auth scheme (WIPAY_API_KEY is a placeholder env var)
 *    - implement initiatePayout for local bank settlement per island
 *      (routing/branch codes differ by territory)
 *    - implement verifyWebhookSignature + parseWebhookEvent
 *    - implement getPayoutStatus
 */
class WiPayAdapter extends PayoutProvider {
  get name() { return 'wipay'; }

  async initiatePayout() {
    throw new ProviderNotConfiguredError(
      'WiPay payouts (Caribbean bank settlement) are not yet configured — ' +
      'provider onboarding is in progress. No funds were moved.'
    );
  }

  // No integration yet — reject every webhook until verification is implemented.
  verifyWebhookSignature() {
    return false;
  }

  parseWebhookEvent() {
    return null;
  }

  async getPayoutStatus() {
    throw new Error('WiPay payout status polling is not yet configured.');
  }
}

module.exports = WiPayAdapter;
