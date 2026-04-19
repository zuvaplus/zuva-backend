'use strict';

/**
 * Per-route rate limiters.
 *
 * The global apiLimiter (100 req / 15 min) lives inline in server.js and is
 * NOT redefined here — only the four per-route limiters that are missing from
 * the current setup are exported from this file.
 *
 * NOTE ON ROUTE PATHS
 * The existing zuva-api.js routes use /suns/tip, /suns/cashout, /suns/purchase.
 * The target config uses /api/auth, /api/content, /api/payments, /api/tips.
 * Wire these limiters to whichever route prefixes your router actually exposes.
 * The names below match the target spec; adjust mount paths in server.js as needed.
 */

const rateLimit = require('express-rate-limit');

// ── /api/auth ─────────────────────────────────────────────────
// 20 requests per 15 minutes — guards sign-in / token refresh endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

// ── /api/content ──────────────────────────────────────────────
// 60 requests per 1 minute — allows reasonable browsing/streaming load.
const contentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many content requests, please slow down.' },
});

// ── /api/payments ─────────────────────────────────────────────
// 10 requests per 1 hour — strict limit for payment initiation endpoints.
const paymentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Payment request limit reached, please try again later.' },
});

// ── /api/tips ─────────────────────────────────────────────────
// 5 requests per 1 minute — prevents tip-spam abuse.
const tipsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tip requests, please wait a moment.' },
});

module.exports = { authLimiter, contentLimiter, paymentsLimiter, tipsLimiter };
