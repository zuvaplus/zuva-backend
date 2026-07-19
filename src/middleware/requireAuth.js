'use strict';

const { getAuth } = require('@clerk/express');

module.exports = function createAuthMiddleware(pool) {

  async function requireAuth(req, res, next) {
    try {
      const auth = getAuth(req);

      if (!auth || !auth.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const result = await pool.query(
        `SELECT u.id, u.role, u.email, u.country_code AS "countryCode",
                w.id AS "walletId"
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         WHERE u.clerk_user_id = $1
           AND u.deleted_at IS NULL
           AND u.status = 'active'
         LIMIT 1`,
        [auth.userId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User not found' });
      }

      req.user = result.rows[0];
      req.clerkUserId = auth.userId;
      next();
    } catch (err) {
      console.error('requireAuth error:', err);
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

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
