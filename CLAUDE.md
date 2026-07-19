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

## Suns Economy Constants (zuva-api.js)
- `SUNS_PER_USD = 1000`
- `MIN_CASHOUT_SUNS = 10000` ($10 minimum)
- `EXCHANGE_RATE_SAFETY_SPREAD = 0.99` (1% FX buffer on payouts)
