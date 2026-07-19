'use strict';

/**
 * Rate limiters — all five in one place.
 * Paths are derived from the actual routes registered in zuva-api.js:
 *
 *   /api/wallet/*            → walletLimiter   (auth-gated identity)
 *   /api/feed/*              → feedLimiter      (content / streaming)
 *   /api/suns/purchase       → purchaseLimiter  (buy Suns)
 *   /api/suns/cashout        → purchaseLimiter  (cash out Suns)
 *   /api/suns/tip            → tipLimiter       (tip a creator)
 *   /api/suns/* (catch-all)  → sunsLimiter      (ledger + anything else)
 *   /api/*      (global)     → apiLimiter       (everything else)
 *
 * Mount order in server.js matters: most-specific paths first.
 */

const rateLimit = require('express-rate-limit');

// ── Global — all /api/* routes ────────────────────────────────
// 100 requests per 15 minutes per IP.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ── /api/wallet/* — auth-gated identity endpoints ─────────────
// 20 requests per 15 minutes. Mirrors Clerk / JWT token-check cadence.
const walletLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wallet requests, please try again later.' },
});

// ── /api/feed/* — content & streaming endpoints ───────────────
// 60 requests per 1 minute. Covers recommended feed, view-complete, interests.
const feedLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many feed requests, please slow down.' },
});

// ── /api/suns/purchase + /api/suns/cashout ────────────────────
// 10 requests per 1 hour. Strict cap on payment initiation.
const purchaseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Payment request limit reached, please try again later.' },
});

// ── /api/suns/tip ─────────────────────────────────────────────
// 5 requests per 1 minute. Prevents tip-spam abuse.
const tipLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tip requests, please wait a moment.' },
});

// ── /api/suns/* catch-all (ledger + anything else under suns) ─
// 20 requests per 15 minutes.
const sunsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many Sun transactions, please slow down.' },
});

// ── /api/upload/* — video upload endpoints ────────────────────
// 10 requests per 1 hour. Each upload proxies up to 2GB through this
// server to Cloudflare Stream, so this cap is deliberately strict.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload requests, please try again later.' },
});

module.exports = {
  apiLimiter,
  walletLimiter,
  feedLimiter,
  purchaseLimiter,
  tipLimiter,
  sunsLimiter,
  uploadLimiter,
};
