'use strict';

const { verifyToken } = require('@clerk/backend');

module.exports = function createAuthMiddleware(pool) {

  /**
   * ensureWallet — self-healing wallet creation. Nothing in the backend
   * creates wallet rows at signup, so any user whose row was inserted
   * manually (or before wallet provisioning existed) has no wallet and
   * every wallet-touching route 404s. Instead, create a zero-balance
   * wallet on first authenticated access.
   *
   * Concurrency-safe: INSERT ... ON CONFLICT (user_id) DO NOTHING means
   * two simultaneous first requests race harmlessly — one inserts, the
   * other falls through to the SELECT. Requires the unique index on
   * wallets(user_id) (see schema/migrations/2026-07-26-wallet-backfill.sql).
   *
   * A zero-balance wallet is ledger-consistent by construction: the
   * update_wallet_balance trigger recomputes balances from ledger
   * history, and an empty history sums to exactly the 0 we insert.
   */
  async function ensureWallet(userId) {
    const inserted = await pool.query(
      `INSERT INTO wallets
         (id, user_id, balance_suns, total_earned_suns, total_spent_suns, total_cashed_out_suns)
       VALUES (gen_random_uuid(), $1, 0, 0, 0, 0)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [userId]
    );
    if (inserted.rows.length) {
      console.log(`[wallet] self-healed: created zero-balance wallet for user ${userId}`);
      return inserted.rows[0].id;
    }
    // Lost the race to a concurrent request — the wallet exists now.
    const existing = await pool.query(
      'SELECT id FROM wallets WHERE user_id = $1',
      [userId]
    );
    return existing.rows[0]?.id ?? null;
  }

  /**
   * requireAuth — manually extracts and verifies the Bearer token from the
   * Authorization header via @clerk/backend's verifyToken, then attaches
   * req.user from the database. Never redirects — this is an API backend,
   * so every failure path returns JSON.
   *
   * After this middleware, req.user = { id, role, email, username, countryCode, walletId }
   */
  async function requireAuth(req, res, next) {
    try {
      const authHeader = req.headers.authorization || '';
      const [scheme, token] = authHeader.split(' ');

      if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      let payload;
      try {
        payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY,
        });
      } catch (err) {
        // TEMPORARY DEBUG LOGGING — remove once the 401 root cause is confirmed.
        console.error('verifyToken failed:', {
          message: err?.message,
          reason: err?.reason,
          longMessage: err?.longMessage,
        });
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const clerkUserId = payload.sub;
      if (!clerkUserId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Look up the user in our database by their Clerk user ID
      const result = await pool.query(
        `SELECT u.id, u.role, u.email, u.username, u.country_code AS "countryCode",
                w.id AS "walletId"
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         WHERE u.clerk_user_id = $1
           AND u.deleted_at IS NULL
           AND u.status = 'active'
         LIMIT 1`,
        [clerkUserId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User not found' });
      }

      req.user = result.rows[0];
      req.clerkUserId = clerkUserId;

      // Self-heal missing wallets so no user can ever hit "Wallet not found"
      if (!req.user.walletId) {
        req.user.walletId = await ensureWallet(req.user.id);
      }

      next();
    } catch (err) {
      console.error('requireAuth error:', err);
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

  /**
   * requireAdmin — extends requireAuth by also checking the user has admin role.
   * Replaces the spoofable x-admin-email header check.
   */
  async function requireAdmin(req, res, next) {
    await requireAuth(req, res, async () => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    });
  }

  /**
   * optionalAuth — for routes usable by both signed-in and anonymous callers
   * (e.g. video reports). Verifies the Bearer token the same way as
   * requireAuth when one is present, but never blocks the request: a
   * missing, invalid, or unrecognized token just leaves req.user/
   * req.clerkUserId unset instead of trusting an unverified client claim.
   */
  async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return next();
    }

    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      const clerkUserId = payload.sub;
      if (!clerkUserId) return next();

      const result = await pool.query(
        `SELECT u.id, u.role, u.email, u.username, u.country_code AS "countryCode",
                w.id AS "walletId"
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         WHERE u.clerk_user_id = $1
           AND u.deleted_at IS NULL
           AND u.status = 'active'
         LIMIT 1`,
        [clerkUserId]
      );

      if (result.rows.length > 0) {
        req.user = result.rows[0];
        req.clerkUserId = clerkUserId;
        if (!req.user.walletId) {
          req.user.walletId = await ensureWallet(req.user.id);
        }
      }
    } catch (err) {
      // Invalid/expired token on an optional-auth route — proceed anonymously
      // rather than blocking, same as if no token had been sent at all.
    }
    next();
  }

  return { requireAuth, requireAdmin, optionalAuth };
};
