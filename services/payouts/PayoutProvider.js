'use strict';

/**
 * ============================================================
 *  PayoutProvider — base contract every payout adapter implements
 * ============================================================
 *  A "provider" is an external money-movement service (Flutterwave,
 *  Mukuru, WiPay, Wise). The PayoutRouter picks one per request based
 *  on the creator's country and payout method; callers only ever talk
 *  to this interface.
 *
 *  Amounts are always in USD — 100 Suns = $1. Currency conversion to
 *  the creator's local currency is the provider's job, not ours.
 * ============================================================
 */
/**
 * Thrown by adapters when the provider can't be used yet (missing API
 * keys, onboarding pending). Callers treat this as a clean, expected
 * failure: the cashout route re-credits the creator's Suns and returns
 * a structured 503 instead of a generic error.
 */
class ProviderNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

class PayoutProvider {
  /** Machine name used in webhook URLs (/api/webhooks/payouts/:provider). */
  get name() {
    throw new Error('PayoutProvider subclass must define name');
  }

  /**
   * Whether this provider has everything it needs (API keys, onboarding)
   * to actually move money. Surfaced as `configured` on
   * GET /api/payouts/options so the frontend can show disabled
   * "coming soon" methods. Defaults to false — an adapter must opt in.
   */
  isConfigured() {
    return false;
  }

  /**
   * Initiate a payout to a creator.
   *
   * @param {object}  args
   * @param {string}  args.creatorId        internal users.id (UUID)
   * @param {number}  args.amountUSD        payout amount in USD
   * @param {string}  args.method           'mobile_money' | 'bank_transfer' | 'cash_pickup'
   * @param {object}  args.recipientDetails provider-specific recipient info:
   *                    { countryCode, msisdn?, bankAccountNumber?, bankCode?,
   *                      firstName?, lastName?, email? }
   * @param {string}  args.idempotencyKey   caller-generated UUID; sent to the
   *                                        provider so retries can never double-pay
   * @returns {Promise<{ provider: string, providerReference: string|null,
   *                     status: 'pending'|'processing', raw: object }>}
   */
  // eslint-disable-next-line no-unused-vars
  async initiatePayout({ creatorId, amountUSD, method, recipientDetails, idempotencyKey }) {
    throw new Error(`${this.name}: initiatePayout not implemented`);
  }

  /**
   * Verify an inbound webhook actually came from this provider.
   * Must be computed over the RAW request body (req.rawBody, captured in
   * server.js) — never the re-serialized parsed body.
   *
   * @param {import('express').Request} req
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  verifyWebhookSignature(req) {
    throw new Error(`${this.name}: verifyWebhookSignature not implemented`);
  }

  /**
   * Normalize a verified webhook into what the ledger cares about.
   * Return null for events that aren't payout status changes.
   *
   * @param {import('express').Request} req
   * @returns {{ reference: string, providerReference: string|null,
   *             outcome: 'completed'|'failed' } | null}
   *          reference = the idempotency key we sent at initiation.
   */
  // eslint-disable-next-line no-unused-vars
  parseWebhookEvent(req) {
    throw new Error(`${this.name}: parseWebhookEvent not implemented`);
  }

  /**
   * Poll the provider for the current status of a payout.
   * @param {string} providerReference  the provider's own transfer id
   * @returns {Promise<{ status: string, raw: object }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getPayoutStatus(providerReference) {
    throw new Error(`${this.name}: getPayoutStatus not implemented`);
  }
}

module.exports = PayoutProvider;
module.exports.ProviderNotConfiguredError = ProviderNotConfiguredError;
