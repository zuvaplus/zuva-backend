# Zuva Backend — CLAUDE.md

## Overview
Node.js 22 / Express 5 REST API for Zuva.TV — a tipping-economy streaming platform.
Currency unit: **Suns** (1000 Suns = $1 USD). Payouts via regional provider adapters
(Flutterwave live; Mukuru/WiPay/Wise stubbed) — see `services/payouts/`.

## Stack
| Layer | Tech |
|-------|------|
| Runtime | Node.js >=22 |
| Framework | Express 5 |
| Database | PostgreSQL via `pg` (hosted on Supabase) |
| Payouts | Provider adapters in `services/payouts/` (Flutterwave v4 live; Mukuru, WiPay, Wise stubs) |
| Pay-ins | None yet — `POST /api/suns/purchase` returns 503 `PURCHASES_NOT_LIVE` (Chimoney shut down May 2026) |
| Deployment | Railway |

## Key Files
- `server.js` — Express app bootstrap: helmet, CORS, morgan, rate limiters, auth shim, routes, health checks, error handler, graceful shutdown
- `zuva-api.js` — All route handlers and DB queries (single-file API)
- `package.json` — Dependencies and Node engine pin (`>=22`)
- `railway.json` — Railway deployment config

## Required Environment Variables
```
DATABASE_URL=postgresql://user:pass@host:5432/zuva
FLUTTERWAVE_SECRET_KEY=your_flutterwave_secret_key          # payouts: African mobile money + NGN bank
FLUTTERWAVE_WEBHOOK_SECRET_HASH=your_webhook_secret_hash    # verifies /api/webhooks/payouts/flutterwave
# FLUTTERWAVE_BASE_URL=...                                  # defaults to the developer sandbox
MUKURU_API_KEY=placeholder                                  # ZW cash pickup (stub adapter)
WIPAY_API_KEY=placeholder                                   # Caribbean bank settlement (stub adapter)
WISE_API_TOKEN=placeholder                                  # GB/US/CA/AU bank transfers (stub adapter)
PLATFORM_WALLET_ID=00000000-0000-0000-0000-000000000001
JWT_SECRET=your_jwt_secret
NODE_ENV=production          # switches CORS to zuva.tv
PORT=3000                    # Railway sets this automatically
TURNSTILE_SECRET_KEY=your_turnstile_secret_key  # verifies /api/creator-signup submissions
ADMIN_EMAIL=your_admin_email@zuva.tv            # gates /api/admin/* routes (see Auth note below)
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_stream_api_token  # /api/upload/video, /api/upload/status/:id
AWS_ACCESS_KEY_ID=your_aws_access_key_id        # Rekognition content moderation (see below)
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=us-east-1
GMAIL_USER=your_gmail_address@gmail.com         # admin moderation email alerts (see below)
GMAIL_APP_PASSWORD=your_16_char_app_password    # Google Account → Security → App passwords
REPORT_THRESHOLD=3                              # reports before a video is auto-hidden for AI re-review
```

## Architecture Notes

### Input Validation & SQL Injection
Every POST/PATCH route validates its body/params with `express-validator`; the shared `validate`
middleware returns **422** (not 200-range, not a generic 400) with the `errors` array on failure. All
DB queries use `$1`/`$2`-style parameterized values — none are built by concatenating or
template-interpolating user input into the SQL string. The only place table/column *names* are
selected dynamically (Postgres can't parameterize identifiers) is via small whitelist lookup objects
(`CONTENT_TABLE_BY_ORIENTATION`, `TRENDING_VIEW_BY_ORIENTATION`,
`ADMIN_CONTENT_TABLE_BY_ORIENTATION`/`_STATUS_COLUMN_BY_ORIENTATION`) keyed off an already-validated
value — a lookup miss just fails the query, it can never inject arbitrary SQL. No ORDER BY/LIMIT
clause anywhere is built from user input (all are static or `$N`-parameterized).

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

### Admin Routes (Temporary Header Check)
`/api/admin/*` routes (`requireAdmin` in `zuva-api.js`) check an `x-admin-email` header against
`ADMIN_EMAIL`. This is spoofable by anyone who knows the admin's email — it exists to unblock the
admin dashboard UI before real session verification is wired up. Replace with a real Clerk session
check (e.g. `@clerk/backend`, verifying the caller's session token server-side) before production.

### Identity via x-clerk-user-id (Temporary, Same Caveat)
`/api/user/role`, `/api/channel/update`, and `/api/upload/video` resolve the caller by looking up
`users.clerk_user_id` from an `x-clerk-user-id` header (`requireClerkUser` in `zuva-api.js`). Same
spoofability caveat as the admin check above — replace with verified Clerk session tokens before
production.

### Video Upload (Cloudflare Stream)
`POST /api/upload/video` proxies the uploaded file (up to 2GB) through this server to Cloudflare
Stream via `multer` (disk storage, temp files cleaned up after) and the `form-data` package. This is
simple but means a 2GB upload ties up a request on this server for as long as the upload takes —
Railway's own proxy/request timeout is outside this app's control and may cut off very large or slow
uploads. If that becomes a problem, switch to Cloudflare's "direct creator upload" flow (this server
requests a one-time upload URL, the browser uploads straight to Cloudflare) instead of proxying bytes
through here.

Custom thumbnail uploads from the frontend aren't persisted anywhere yet — no image storage (e.g.
Supabase Storage) is wired up in this backend, so Cloudflare's auto-generated thumbnail is always
used regardless of what the frontend's optional thumbnail field sends.

New videos insert with `status = 'pending'`, then `moderateVideo()` runs automatically (synchronously,
before the upload request responds) and flips status to `'published'` or `'rejected'` — see Content
Moderation below. If moderation itself fails for any reason, the video is left at `'pending'`, and
there is currently no separate route that manually flips a video to `'published'` from that state.

### Content Moderation (AWS Rekognition)
`moderateVideo(cloudflareVideoId)` in `zuva-api.js` runs automatically at the end of
`POST /api/upload/video`. AWS Rekognition's video moderation API (`StartContentModeration`) requires
the video to already live in S3, which Cloudflare Stream doesn't give us — as a workaround, this calls
the synchronous *image* API (`DetectModerationLabels`) against the video's Cloudflare Stream thumbnail
(`https://videodelivery.net/{id}/thumbnails/thumbnail.jpg`) as a first-pass check:
- Labels found at/above `MinConfidence: 75` → `status = 'rejected'`
- No labels found → `status = 'published'` (auto-publish — a product decision; a single thumbnail
  frame can't fully vouch for an entire video, so this is a weak signal by design)
- Any failure (thumbnail not ready yet, AWS error, network issue) → caught, video stays `'pending'`,
  request does not crash

`'flagged'` is a valid `videos.status` value but is **not** produced by any automated path — reserved
for future use (e.g. manual admin flagging). The admin dashboard's Content tab
(`GET/PATCH/DELETE /api/admin/content`) covers `videos` (`?orientation=upload`) as well as the older
`vertical_content`/`landscape_content` tables.

### Report-Triggered AI Re-Review
`POST /api/video/:id/report` counts total reports for the video after inserting the new one. Once the
count reaches `REPORT_THRESHOLD` (default 3), the video is immediately set to `status = 'under_review'`
(hidden — same visibility gate as everywhere else: `status = 'published'` required to show) and
`moderateReportedVideo(videoId, cloudflareVideoId)` is fired without being awaited, so the reporting
user's request doesn't wait on it. That function re-runs the same thumbnail-based Rekognition check as
`moderateVideo()`:
- Labels found → `status = 'rejected'` (stays hidden), admin emailed **"Video Rejected by AI"**
- Clean → `status = 'published'` (goes live again), admin emailed **"Reported Video Cleared by AI"**
- Rekognition/thumbnail fetch throws → status left at `'under_review'`, admin emailed
  **"Video Needs Manual Review"**

`GET /api/admin/moderation-queue` returns videos with `status IN ('under_review', 'flagged')`, ordered
by report count descending — `'rejected'` is intentionally excluded since it's already a terminal,
hidden state needing no further action.

### Admin Email Alerts (Gmail SMTP via nodemailer)
`sendAdminEmail(subject, htmlBody)` in `zuva-api.js` sends to `ADMIN_EMAIL` via Gmail SMTP
(`GMAIL_USER` / `GMAIL_APP_PASSWORD` — the password must be a Google **App Password**, not the account
login password). Never throws: if mail isn't configured or sending fails, it logs and returns, so a
broken mail setup can't break the moderation flow that triggered it (the DB status change already
happened by the time the email is attempted).

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

## Engagement Layer (likes / comments / subscriptions)
- Tables: `video_likes`, `comments` (one-level replies via `parent_comment_id`; status
  visible/hidden/deleted), `subscriptions` — see `schema/migrations/2026-07-26-engagement.sql`
- Denormalized counters (`videos.like_count`, `videos.comment_count`, `users.follower_count`)
  are trigger-recomputed from the source tables — never incremented in app code
- Routes: POST/DELETE `/api/video/:id/like` (idempotent), POST/GET `/api/video/:id/comments`
  (paginated, replies nested; soft delete keeps rows, body nulled), DELETE `/api/comments/:id`
  (own only), POST/DELETE `/api/creator/:id/subscribe`, admin `GET /api/admin/comments` +
  `PATCH /api/admin/comments/:id` (visible|hidden)
- `GET /api/video/:id` runs optionalAuth and returns `viewer.has_liked` / `viewer.is_subscribed`
- Comment creation is limited to 5/min (commentLimiter, mounted in server.js before the
  global limiter, method+path scoped so GETs aren't throttled)

## Suns Economy Constants
- `SUNS_PER_USD = 1000` (zuva-api.js)
- Minimum cashout is per-corridor, in USD (`MIN_PAYOUT_USD` in `services/payouts/PayoutRouter.js`):
  $5 for Flutterwave and Mukuru corridors, $20 for WiPay and Wise corridors
- FX conversion happens provider-side: payouts are initiated in USD and settled in
  the creator's local currency at the provider's rate (no in-house FX spread anymore)

## Payout Architecture (`services/payouts/`)
- `PayoutProvider.js` — adapter contract: `initiatePayout`, `verifyWebhookSignature`,
  `parseWebhookEvent`, `getPayoutStatus`
- `FlutterwaveAdapter.js` — live; v4 direct transfers, mobile money corridors
  (GH/KE/TZ/UG/RW/ZM/MW/ET/CM/CI/SN) + NGN bank; HMAC-SHA256 webhook verification
- `MukuruAdapter.js` / `WiPayAdapter.js` / `WiseAdapter.js` — stubs that throw a
  descriptive "not yet configured" error; webhooks always rejected until implemented
- `PayoutRouter.js` — country-code routing (African corridors → Flutterwave, ZW → Mukuru,
  Caribbean → WiPay, GB/US/CA/AU → Wise) + per-corridor minimum enforcement
- `webhookRouter.js` — `POST /api/webhooks/payouts/:provider`; signature check → 401 on
  failure; `completed` finalizes, `failed` re-credits Suns atomically. Mounted in server.js
  BEFORE all rate limiters. Requires `req.rawBody` (captured by the `express.json` verify
  hook in server.js) — do not remove that hook.
- Cashout flow (`POST /api/suns/cashout`): route → atomic debit + `pending` payout row in one
  transaction → `initiatePayout` with a `crypto.randomUUID()` idempotency key → `processing`,
  or atomic re-credit + `failed` if initiation throws. Webhook finalizes the terminal state.
  Requires `recipientFirstName`/`recipientLastName` (legal name, stored on the payout row,
  passed to the provider for KYC). An unconfigured provider (missing API keys) throws
  `ProviderNotConfiguredError` → re-credit + structured 503 `PAYOUTS_NOT_CONFIGURED`; the
  app boots and runs fine with no provider keys set at all.
- `GET /api/payouts/options` — creator's methods by country with `configured` flags;
  `GET /api/payouts/history` — creator's last 50 payouts
- `scripts/flutterwave-sandbox-test.js` — end-to-end sandbox payout test (GHS MTN + KES
  M-Pesa); prints setup instructions and exits 0 if no sandbox key is configured
- Migration required before deploy: `schema/migrations/2026-07-25-payout-providers.sql`
  (adds `provider`, `provider_reference`, `provider_response`, `idempotency_key` to `payouts`)
