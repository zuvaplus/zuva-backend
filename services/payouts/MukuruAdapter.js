'use strict';

const PayoutProvider = require('./PayoutProvider');
const { ProviderNotConfiguredError } = PayoutProvider;

/**
 * ============================================================
 *  MukuruAdapter — Zimbabwe cash pickup (STUB)
 * ============================================================
 *  MukuruPay enterprise onboarding is still pending, so there are no
 *  API docs to build against yet. This shell exists so PayoutRouter
 *  can route ZW → Mukuru today and the real integration slots in
 *  without touching callers.
 *
 *  TODO(mukuru): once enterprise API docs arrive —
 *    - confirm auth scheme (MUKURU_API_KEY is a placeholder env var)
 *    - implement initiatePayout: create a cash-pickup order, return
 *      the pickup reference the creator presents at a Mukuru branch
 *    - implement verifyWebhookSignature + parseWebhookEvent for
 *      collection/expiry callbacks
 *    - implement getPayoutStatus
 */
class MukuruAdapter extends PayoutProvider {
  get name() { return 'mukuru'; }

  async initiatePayout() {
    throw new ProviderNotConfiguredError(
      'Mukuru payouts (Zimbabwe cash pickup) are not yet configured — ' +
      'MukuruPay enterprise onboarding is pending. No funds were moved.'
    );
  }

  // No docs yet — reject every webhook until verification is implemented.
  verifyWebhookSignature() {
    return false;
  }

  parseWebhookEvent() {
    return null;
  }

  async getPayoutStatus() {
    throw new Error('Mukuru payout status polling is not yet configured.');
  }
}

module.exports = MukuruAdapter;
