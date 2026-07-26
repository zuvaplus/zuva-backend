'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const PayoutProvider = require('./PayoutProvider');
const { ProviderNotConfiguredError } = PayoutProvider;

/**
 * ============================================================
 *  FlutterwaveAdapter — African mobile money + Nigerian bank
 *  Flutterwave v4 "direct transfers" API.
 *  Docs: https://developer.flutterwave.com/docs/mobile-money-1
 * ============================================================
 *  Corridors (country → network/currency) supported here. The msisdn
 *  MUST include the country calling code (e.g. Ghana numbers start
 *  with 233) — Flutterwave rejects local-format numbers.
 */
const CORRIDORS = {
  // countryCode: { type, network, currency }
  GH: { type: 'mobile_money', network: 'MTN',         currency: 'GHS' },
  KE: { type: 'mobile_money', network: 'MPESA',       currency: 'KES' },
  TZ: { type: 'mobile_money', network: 'AIRTEL',      currency: 'TZS' },
  UG: { type: 'mobile_money', network: 'MPS',         currency: 'UGX' },
  RW: { type: 'mobile_money', network: 'MPS',         currency: 'RWF' },
  ZM: { type: 'mobile_money', network: 'MPS',         currency: 'ZMW' },
  MW: { type: 'mobile_money', network: 'AIRTELMW',    currency: 'MWK' },
  ET: { type: 'mobile_money', network: 'ETBAMOLE',    currency: 'ETB' },
  CM: { type: 'mobile_money', network: 'ORANGEMONEY', currency: 'XAF' },
  CI: { type: 'mobile_money', network: 'WAVE',        currency: 'XOF' },
  SN: { type: 'mobile_money', network: 'EMONEY',      currency: 'XOF' },
  NG: { type: 'bank',         network: null,          currency: 'NGN' },
};

class FlutterwaveAdapter extends PayoutProvider {
  constructor() {
    super();
    this.http = axios.create({
      // Sandbox by default; set FLUTTERWAVE_BASE_URL to the production
      // base URL from your Flutterwave dashboard when going live.
      baseURL: process.env.FLUTTERWAVE_BASE_URL || 'https://developersandbox-api.flutterwave.com',
      timeout: 20_000,
    });
  }

  get name() { return 'flutterwave'; }

  static get corridors() { return CORRIDORS; }

  isConfigured() {
    return Boolean(process.env.FLUTTERWAVE_SECRET_KEY);
  }

  supportsCountry(countryCode) {
    return Boolean(CORRIDORS[countryCode]);
  }

  // Every v4 request wants Bearer auth plus idempotency + trace headers.
  buildHeaders(idempotencyKey) {
    return {
      Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'X-Trace-Id': crypto.randomUUID(),
    };
  }

  async initiatePayout({ creatorId, amountUSD, method, recipientDetails, idempotencyKey }) {
    // Fail BEFORE any HTTP call when no key exists (pre-launch state) —
    // same structured error the stub adapters throw, so the cashout route
    // re-credits the Suns and returns a clean 503 instead of a mystery 401
    // from the provider or a request built around `Bearer undefined`.
    if (!this.isConfigured()) {
      throw new ProviderNotConfiguredError(
        'Flutterwave payouts are not yet configured — FLUTTERWAVE_SECRET_KEY is not set. ' +
        'No funds were moved.'
      );
    }

    const { countryCode, msisdn, bankAccountNumber, bankCode, firstName, lastName } =
      recipientDetails;

    const corridor = CORRIDORS[countryCode];
    if (!corridor) {
      throw new Error(`Flutterwave: no corridor configured for country ${countryCode}`);
    }

    let recipient;
    let transferType;

    if (corridor.type === 'mobile_money') {
      if (method !== 'mobile_money') {
        throw new Error(`Flutterwave: ${countryCode} only supports mobile money payouts`);
      }
      if (!msisdn) {
        throw new Error('Flutterwave: msisdn (phone number with country code) is required');
      }
      transferType = 'mobile_money';
      recipient = {
        name: { first: firstName, last: lastName },
        mobile_money: {
          network: corridor.network,
          msisdn,
          // XAF/XOF corridors require the country to disambiguate the currency zone
          country: countryCode,
        },
      };
    } else {
      // NG — bank transfer corridor
      if (method !== 'bank_transfer') {
        throw new Error(`Flutterwave: ${countryCode} only supports bank transfer payouts`);
      }
      if (!bankAccountNumber || !bankCode) {
        throw new Error('Flutterwave: bankAccountNumber and bankCode are required for NGN payouts');
      }
      transferType = 'bank';
      recipient = {
        name: { first: firstName, last: lastName },
        bank: {
          account_number: bankAccountNumber,
          code: bankCode,
          country: countryCode,
        },
      };
    }

    const payload = {
      action: 'instant',
      type: transferType,
      // Our idempotency key doubles as the transfer reference so the
      // webhook can be matched back to the payouts row unambiguously.
      reference: idempotencyKey,
      narration: 'Zuva.tv creator payout',
      payment_instruction: {
        source_currency: 'USD',
        destination_currency: corridor.currency,
        amount: {
          applies_to: 'source_currency',
          value: amountUSD,
        },
        recipient,
      },
    };

    const resp = await this.http.post('/direct-transfers', payload, {
      headers: this.buildHeaders(idempotencyKey),
    });

    return {
      provider: this.name,
      providerReference: resp.data?.data?.id ?? null,
      status: 'processing',
      raw: resp.data,
    };
  }

  /**
   * v4 signs webhooks by HMAC-SHA256-ing the raw body with the secret
   * hash configured on the dashboard, sent base64-encoded in the
   * `flutterwave-signature` header.
   */
  verifyWebhookSignature(req) {
    const signature  = req.headers['flutterwave-signature'];
    const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
    if (!signature || !secretHash || !req.rawBody) return false;

    const expected = crypto
      .createHmac('sha256', secretHash)
      .update(req.rawBody)
      .digest('base64');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  parseWebhookEvent(req) {
    const { type, data } = req.body || {};
    if (type !== 'transfer.disburse' || !data) return null;

    const status = String(data.status || '').toUpperCase();
    if (status !== 'SUCCESSFUL' && status !== 'FAILED') return null; // intermediate states — ignore

    return {
      reference: data.reference,           // = the idempotency key we sent
      providerReference: data.id ?? null,
      outcome: status === 'SUCCESSFUL' ? 'completed' : 'failed',
    };
  }

  async getPayoutStatus(providerReference) {
    const resp = await this.http.get(`/transfers/${providerReference}`, {
      headers: this.buildHeaders(crypto.randomUUID()),
    });
    return { status: resp.data?.data?.status ?? 'UNKNOWN', raw: resp.data };
  }
}

module.exports = FlutterwaveAdapter;
