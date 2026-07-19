'use strict';

const { verifyToken } = require('@clerk/backend');

module.exports = function createAuthMiddleware(pool) {

  /**
   * requireAuth — manually extracts and verifies the Bearer token from the
   * Authorization header via @clerk/backend's verifyToken, then attaches
   * req.user from the database. Never redirects — this is an API backend,
   * so every failure path returns JSON.
   *
   * After this middleware, req.user = { id, role, email, countryCode, walletId }
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
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const clerkUserId = payload.sub;
      if (!clerkUserId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Look up the user in our database by their Clerk user ID
      const result = await pool.query(
        `SELECT u.id, u.role, u.email, u.country_code AS "countryCode",
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

  return { requireAuth, requireAdmin };
};
