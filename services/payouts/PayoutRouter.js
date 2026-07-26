'use strict';

const FlutterwaveAdapter = require('./FlutterwaveAdapter');
const MukuruAdapter      = require('./MukuruAdapter');
const WiPayAdapter       = require('./WiPayAdapter');
const WiseAdapter        = require('./WiseAdapter');

/**
 * ============================================================
 *  PayoutRouter — picks the payout provider for a creator
 * ============================================================
 *  Routing is by the creator's country code (users.country_code):
 *    - African mobile money + NG bank  → Flutterwave
 *    - ZW (cash pickup)                → Mukuru
 *    - Caribbean                       → WiPay
 *    - GB / US / CA / AU (diaspora)    → Wise
 *
 *  Each provider has a minimum payout in USD; requests below it are
 *  rejected before any money moves.
 */

// Errors callers can safely surface to the end user (4xx material).
class PayoutRoutingError extends Error {}

const flutterwave = new FlutterwaveAdapter();
const mukuru      = new MukuruAdapter();
const wipay       = new WiPayAdapter();
const wise        = new WiseAdapter();

const ADAPTERS_BY_NAME = {
  [flutterwave.name]: flutterwave,
  [mukuru.name]:      mukuru,
  [wipay.name]:       wipay,
  [wise.name]:        wise,
};

const CARIBBEAN = ['JM', 'TT', 'BB', 'GY', 'LC', 'GD', 'DO', 'HT', 'BS', 'KY'];
const DIASPORA  = ['GB', 'US', 'CA', 'AU'];

// Minimum payout per provider, in USD.
const MIN_PAYOUT_USD = {
  flutterwave: 5,
  mukuru:      5,
  wipay:       20,
  wise:        20,
};

function adapterForCountry(countryCode) {
  if (!countryCode) {
    throw new PayoutRoutingError(
      'No country is set on your account — add your country before cashing out.'
    );
  }
  const cc = countryCode.toUpperCase();

  if (flutterwave.supportsCountry(cc)) return flutterwave;
  if (cc === 'ZW')                     return mukuru;
  if (CARIBBEAN.includes(cc))          return wipay;
  if (DIASPORA.includes(cc))           return wise;

  throw new PayoutRoutingError(
    `Payouts are not yet available in your country (${cc}).`
  );
}

/**
 * Resolve the adapter for a payout request and sanity-check the method
 * against what that corridor supports.
 *
 * @param {{ countryCode: string, method: string }} args
 * @returns {{ adapter: import('./PayoutProvider'), provider: string, minUSD: number }}
 */
function route({ countryCode, method }) {
  const adapter = adapterForCountry(countryCode);

  // Method/provider compatibility. Flutterwave method-vs-corridor checks
  // (e.g. NG is bank-only) happen inside the adapter, which knows its corridors.
  if (adapter === mukuru && method !== 'cash_pickup') {
    throw new PayoutRoutingError('Zimbabwe payouts are cash pickup only.');
  }
  if ((adapter === wipay || adapter === wise) && method !== 'bank_transfer') {
    throw new PayoutRoutingError('This corridor supports bank transfer payouts only.');
  }

  return {
    adapter,
    provider: adapter.name,
    minUSD: MIN_PAYOUT_USD[adapter.name],
  };
}

/**
 * @throws {PayoutRoutingError} when amountUSD is under the corridor minimum
 */
function enforceMinimum(routeInfo, amountUSD) {
  if (amountUSD < routeInfo.minUSD) {
    throw new PayoutRoutingError(
      `Minimum payout for your region is $${routeInfo.minUSD} USD ` +
      `(${routeInfo.minUSD * 1000} Suns); you requested $${amountUSD.toFixed(2)}.`
    );
  }
}

function getAdapterByName(name) {
  return ADAPTERS_BY_NAME[name] ?? null;
}

/**
 * The payout methods available to a creator in a given country, for
 * GET /api/payouts/options. `configured: false` means the route exists
 * but the provider can't move money yet (no API keys / onboarding
 * pending) — the frontend shows these disabled with a "coming soon" badge.
 *
 * Returns [] for unsupported countries.
 */
function optionsForCountry(countryCode) {
  let adapter;
  try {
    adapter = adapterForCountry(countryCode);
  } catch (err) {
    if (err instanceof PayoutRoutingError) return [];
    throw err;
  }

  const minUSD = MIN_PAYOUT_USD[adapter.name];
  const base = {
    provider:   adapter.name,
    minUSD,
    minSuns:    minUSD * 1000, // 1000 Suns = $1
    configured: adapter.isConfigured(),
  };

  if (adapter === flutterwave) {
    const corridor = FlutterwaveAdapter.corridors[countryCode.toUpperCase()];
    return [{
      ...base,
      method:   corridor.type === 'bank' ? 'bank_transfer' : 'mobile_money',
      network:  corridor.network,
      currency: corridor.currency,
    }];
  }
  if (adapter === mukuru) {
    return [{ ...base, method: 'cash_pickup', network: null, currency: null }];
  }
  // WiPay + Wise corridors are bank settlement
  return [{ ...base, method: 'bank_transfer', network: null, currency: null }];
}

module.exports = {
  route,
  enforceMinimum,
  getAdapterByName,
  optionsForCountry,
  PayoutRoutingError,
  MIN_PAYOUT_USD,
};
