'use strict';
require('dotenv').config();

const express        = require('express');
const helmet         = require('helmet');
const morgan         = require('morgan');
const rateLimit      = require('express-rate-limit');
const { Pool }       = require('pg');
const zuvaRoutes     = require('./zuva-api');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security headers ─────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────
const corsMiddleware = require('./src/middleware/cors');
app.use(corsMiddleware);
app.options('*', corsMiddleware);

// ─── Request logging ──────────────────────────────────────────
app.use(morgan('combined'));

// ─── Rate limiters ────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const sunsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Sun transactions, please slow down.' },
});

// ─── Body parsing ─────────────────────────────────────────────
app.use(express.json());

// ─── Temporary auth shim — replace with real JWT middleware later ───
app.use((req, _res, next) => {
  req.user = {
    id:          '00000000-0000-0000-0000-000000000002',
    role:        'creator',
    email:       'test@zuva.tv',
    countryCode: 'NG',
  };
  next();
});

// ─── Routes ───────────────────────────────────────────────────
app.use('/api/suns', sunsLimiter);
app.use('/api', apiLimiter, zuvaRoutes);

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
