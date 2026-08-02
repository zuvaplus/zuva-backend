'use strict';
require('dotenv').config();

const express        = require('express');
const helmet         = require('helmet');
const morgan         = require('morgan');
const {
  apiLimiter,
  walletLimiter,
  feedLimiter,
  purchaseLimiter,
  tipLimiter,
  sunsLimiter,
  uploadLimiter,
  commentLimiter,
  adsServeLimiter,
  adsImpressionLimiter,
} = require('./src/middleware/rateLimiter');
const { Pool }       = require('pg');
const { router: zuvaRoutes, pool: apiPool, writeDoubleEntry } = require('./zuva-api');
const createPayoutWebhookRouter = require('./services/payouts/webhookRouter');
const createAdsRouter = require('./routes/ads');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Railway's reverse proxy ─────────────────────────────
// Required so express-rate-limit can read X-Forwarded-For correctly.
// Without this, rate limiting throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────
const corsMiddleware = require('./src/middleware/cors');
app.use(corsMiddleware);

// ─── Request logging ──────────────────────────────────────────
app.use(morgan('combined'));

// ─── Body parsing ─────────────────────────────────────────────
// `verify` stashes the raw bytes on req.rawBody — payout providers sign
// webhooks over the exact body they sent, so HMAC verification must run
// on the original bytes, never a re-serialization of the parsed JSON.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Auth middleware (requires real Clerk JWT + database user lookup) ──
const createAuthMiddleware = require('./src/middleware/requireAuth');
const { requireAuth, requireAdmin, optionalAuth } = createAuthMiddleware(apiPool);
app.set('requireAuth', requireAuth);
app.set('requireAdmin', requireAdmin);
app.set('optionalAuth', optionalAuth);

// ─── Payout provider webhooks ─────────────────────────────────
// Registered BEFORE every rate limiter (specific-before-global is the
// established ordering here): a provider retrying a burst of transfer
// events must never be throttled into a missed status update. Each
// request is authenticated by the adapter's signature check instead.
app.use('/api/webhooks/payouts', createPayoutWebhookRouter(apiPool, writeDoubleEntry));

// ─── Routes ───────────────────────────────────────────────────
// Specific-path limiters are mounted before the global catch-all
// so a request to /api/suns/tip hits tipLimiter first, then
// sunsLimiter, then apiLimiter — all three buckets consumed.
// Comment creation only — 5/min. Scoped by method + path shape so the
// GET comments list and the other /api/video/* routes aren't throttled.
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/video\/[^/]+\/comments\/?$/.test(req.path)) {
    return commentLimiter(req, res, next);
  }
  next();
});

app.use('/api/suns/purchase', purchaseLimiter); //  10 req / 1 hour
app.use('/api/suns/cashout',  purchaseLimiter); //  10 req / 1 hour
app.use('/api/suns/tip',      tipLimiter);      //   5 req / 1 min
app.use('/api/suns',          sunsLimiter);     //  20 req / 15 min
app.use('/api/feed',          feedLimiter);     //  60 req / 1 min
app.use('/api/wallet',        walletLimiter);   //  20 req / 15 min
app.use('/api/upload',        uploadLimiter);   //  10 req / 1 hour
app.use('/api/ads/serve',      adsServeLimiter);      //  60 req / 1 min
app.use('/api/ads/impression', adsImpressionLimiter); //  10 req / 1 min
app.use('/api',               apiLimiter, zuvaRoutes); // 100 req / 15 min (global)

// Zuva Ads routes — mounted after the rate limiting middleware above
// (both the ads-specific limiters and the global apiLimiter, which
// also applies here since /api/ads/* falls under the /api prefix
// zuvaRoutes didn't match and fell through from).
app.use('/api/ads', createAdsRouter(apiPool));

// ─── Health checks ────────────────────────────────────────────
const healthBody = () => ({
  status:    'ok',
  uptime:    process.uptime(),
  timestamp: new Date().toISOString(),
});
app.get('/health',  (_req, res) => res.json(healthBody()));
app.get('/healthz', (_req, res) => res.json(healthBody()));

// ─── Global error handler ─────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  console.error('[error]', err.message, err.stack);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Zuva backend running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

// ─── Graceful shutdown ────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    try {
      // Close the pg pool exported from zuva-api (if accessible)
      const { pool } = require('./zuva-api');
      if (pool && typeof pool.end === 'function') await pool.end();
    } catch (_) { /* pool not exported — that's fine */ }
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit if graceful close takes too long
  setTimeout(() => { process.exit(1); }, 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
