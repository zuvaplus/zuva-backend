'use strict';

const PayoutProvider = require('./PayoutProvider');
const { ProviderNotConfiguredError } = PayoutProvider;

/**
 * ============================================================
 *  WiseAdapter — diaspora bank transfers (STUB)
 * ============================================================
 *  Target corridors: GB, US, CA, AU bank accounts. Shell only — the
 *  Wise Platform/Business API agreement isn't set up yet.
 *
 *  TODO(wise): when the Wise business account + API token exist —
 *    - WISE_API_TOKEN is a placeholder env var; Wise also needs a
 *      profile id and (for production) SCA signing keys
 *    - implement initiatePayout: quote → recipient account → transfer
 *      → fund, per Wise's multi-step transfer flow
 *    - implement verifyWebhookSignature (Wise signs webhooks with a
 *      public-key signature, not an HMAC) + parseWebhookEvent
 *    - implement getPayoutStatus
 */
class WiseAdapter extends PayoutProvider {
  get name() { return 'wise'; }

  async initiatePayout() {
    throw new ProviderNotConfiguredError(
      'Wise payouts (UK/US/CA/AU bank transfers) are not yet configured — ' +
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
    throw new Error('Wise payout status polling is not yet configured.');
  }
}

module.exports = WiseAdapter;
