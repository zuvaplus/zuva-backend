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
} = require('./src/middleware/rateLimiter');
const { Pool }       = require('pg');
const { router: zuvaRoutes, pool: apiPool } = require('./zuva-api');

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
app.use(express.json());

// ─── Clerk JWT middleware ──────────────────────────────────────
// Validates Clerk session tokens from the frontend automatically.
const { clerkMiddleware } = require('@clerk/express');
app.use(clerkMiddleware());

// ─── Auth middleware (requires real Clerk JWT + database user lookup) ──
const createAuthMiddleware = require('./src/middleware/requireAuth');
const { requireAuth, requireAdmin } = createAuthMiddleware(apiPool);
app.set('requireAuth', requireAuth);
app.set('requireAdmin', requireAdmin);

// ─── Routes ───────────────────────────────────────────────────
// Specific-path limiters are mounted before the global catch-all
// so a request to /api/suns/tip hits tipLimiter first, then
// sunsLimiter, then apiLimiter — all three buckets consumed.
app.use('/api/suns/purchase', purchaseLimiter); //  10 req / 1 hour
app.use('/api/suns/cashout',  purchaseLimiter); //  10 req / 1 hour
app.use('/api/suns/tip',      tipLimiter);      //   5 req / 1 min
app.use('/api/suns',          sunsLimiter);     //  20 req / 15 min
app.use('/api/feed',          feedLimiter);     //  60 req / 1 min
app.use('/api/wallet',        walletLimiter);   //  20 req / 15 min
app.use('/api/upload',        uploadLimiter);   //  10 req / 1 hour
app.use('/api',               apiLimiter, zuvaRoutes); // 100 req / 15 min (global)

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
