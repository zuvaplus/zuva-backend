# Zuva Backend — CLAUDE.md

## Overview
Node.js 22 / Express 5 REST API for Zuva.TV — a tipping-economy streaming platform.
Currency unit: **Suns** (1000 Suns = $1 USD). Payouts via Chimoney API.

## Stack
| Layer | Tech |
|-------|------|
| Runtime | Node.js >=22 |
| Framework | Express 5 |
| Database | PostgreSQL via `pg` (hosted on Supabase) |
| Payments | Chimoney API (via `axios`) |
| Deployment | Railway |

## Key Files
- `server.js` — Express app bootstrap: helmet, CORS, morgan, rate limiters, auth shim, routes, health checks, error handler, graceful shutdown
- `zuva-api.js` — All route handlers and DB queries (single-file API)
- `package.json` — Dependencies and Node engine pin (`>=22`)
- `railway.json` — Railway deployment config

## Required Environment Variables
```
DATABASE_URL=postgresql://user:pass@host:5432/zuva
CHIMONEY_API_KEY=your_chimoney_key
CHIMONEY_BASE_URL=https://api.chimoney.io/v0.2
PLATFORM_WALLET_ID=00000000-0000-0000-0000-000000000001
JWT_SECRET=your_jwt_secret
NODE_ENV=production          # switches CORS to zuva.tv
PORT=3000                    # Railway sets this automatically
TURNSTILE_SECRET_KEY=your_turnstile_secret_key  # verifies /api/creator-signup submissions
```

## Architecture Notes

### Database
`pg.Pool` is configured with `ssl: { rejectUnauthorized: false }` for Supabase + Railway TLS compatibility.

### Rate Limiting
- `/api/*` — 100 requests per 15 minutes
- `/api/suns/*` — 20 requests per 15 minutes (stricter for financial endpoints)

### CORS
- **Development** (`NODE_ENV !== 'production'`): allows `localhost:3001`, `localhost:3000`
- **Production**: allows `https://zuva.tv`, `https://www.zuva.tv`

### Auth (Temporary Shim)
`req.user` is hardcoded in `server.js`. Replace with JWT middleware before production:
```js
app.use(verifyJWT);  // sets req.user from Authorization: Bearer <token>
```

### Health Checks
Both `/health` and `/healthz` return:
```json
{ "status": "ok", "uptime": 123.4, "timestamp": "2025-01-01T00:00:00.000Z" }
```

### Graceful Shutdown
Handles `SIGTERM` and `SIGINT` — closes HTTP server then pg pool. Railway sends SIGTERM on deploys.

## Running Locally
```bash
npm install
cp .env.example .env   # fill in values
npm run dev            # node --watch server.js
```

## Suns Economy Constants (zuva-api.js)
- `SUNS_PER_USD = 1000`
- `MIN_CASHOUT_SUNS = 10000` ($10 minimum)
- `EXCHANGE_RATE_SAFETY_SPREAD = 0.99` (1% FX buffer on payouts)
