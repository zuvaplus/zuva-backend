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

### Admin Routes
`/api/admin/*` routes are gated by `requireAdmin`, created in `server.js` (`src/middleware/
requireAuth.js`) and exposed to `zuva-api.js` via an `app.get('requireAdmin')` bridge. It verifies
the caller's Clerk JWT (same as `requireAuth`) and then checks the resolved `users` row has
`role === 'admin'`. A `requireAdmin` function also exists directly in `zuva-api.js`, but it's just
that bridge — there is no separate header-based implementation live anywhere.

The older `x-admin-email`-header-against-`ADMIN_EMAIL` check this section used to describe is gone
from the request path. Don't reintroduce header-based admin checks for new routes — use `requireAdmin`
from `server.js`.

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

## Creator Dashboard Support
- `GET /api/creator/videos` — the authenticated creator's own videos, every status
  (unlike `GET /api/channel/:username`, which only shows published ones)
- `creator_links` table (title/url/position, max 10 enforced in the POST route) —
  management-only for now (`GET/POST/PATCH/DELETE /api/creator/links`, reorder via
  `PATCH /api/creator/links/reorder`); a future public read path will let the
  watch-page links shelf render them once that ships
- `PATCH /api/channel/update` now also accepts `avatar_url` (validated http(s) URL)

## Creator Application Lifecycle
- `unconfirmed` → (emailed confirm link, `GET /api/creator-signup/confirm/:token`,
  renders a branded HTML page) → `pending` → admin approve/reject
- Approval (PATCH /api/admin/applications/:id) is transactional: matches the users
  row by LOWER(email) → sets role='creator' (admins keep role) + links
  `approved_user_id`; no user yet → `awaiting_signup=TRUE` and the role is applied
  automatically at first sign-in (see below). Applicants get on-brand
  approval/rejection emails (amber `#f37b0d`, vantablack) via sendApplicantEmail
  (never throws, same contract as sendAdminEmail).
- **Self-healing user creation** (`ensureUser` in src/middleware/requireAuth.js):
  nothing creates users rows from Clerk sign-ins, so a verified session with no
  users row = first sign-in → row created from the Clerk API profile
  (role='creator' if an approved application awaits that email, else 'viewer'),
  then ensureWallet runs. Requires a UNIQUE index on users.clerk_user_id
  (migration 2026-07-26-application-flow.sql).
- Upload endpoints (`POST /api/upload/video`, `GET /api/upload/status/:id`) require
  role='creator' (requireCreator, mounted before multer so non-creators never
  stream bytes).

## Main Feed Ranking
- `GET /api/feed?limit=&offset=` — optionalAuth, replaces the old `GET
  /feed/recommended` "Discovery Engine", which was dead code referencing tables
  (`vertical_content`, `landscape_content`, `content_views`, `user_interests`) and a
  function (`upsert_user_interest`) that don't exist against the real schema — that
  predates the current single `videos` table design and was never reconciled with
  it, which is why it 500'd with "Could not generate recommended feed" and why
  `POST /feed/view-complete` silently failed on every call. Both routes, and
  `GET /feed/user-interests` (unused by any frontend page), were removed outright
  rather than fixed in place
- `computeFeedScore(video, viewer)` combines, per video: completion rate (avg of
  `watch_events.completion_pct` — highest weight), `tips_received` (SUM of
  `tips.amount_suns` by `content_id` — highest of the engagement-only signals),
  comments, likes, view count, a gentle recency decay (long half-life — long-form
  ages well), and a small additive country-match boost (`users.preferred_country`
  vs. the creator's `country_code`, never a filter). See `FEED_WEIGHTS` in
  zuva-api.js for exact coefficients
- **Documentary & Discussion umbrella** — `documentary`, `discussion_debate`,
  `interview`, `lifestyle_culture` from `content_category`. A code-level grouping
  only (`DOC_DISCUSSION_CATEGORIES`), not a DB concept. Gets completion weighted
  even more heavily and view count de-emphasized in `computeFeedScore`, plus a
  guaranteed ~1-in-8 floor per page in `buildRankedFeed`/`assembleFeedRound` (a
  further ~1-in-6 slice is reserved for general category diversity so no single
  category — Documentary & Discussion or otherwise — can dominate a page)
- Feed assembly happens in application memory over a capped candidate pool
  (`FEED_CANDIDATE_POOL_SIZE = 500`, most recent published non-Flare videos) —
  fine for this catalog size pre-launch; revisit (push scoring into SQL, or
  paginate the candidate fetch) once the catalog is large enough that this stops
  being cheap
- **Known gap**: no per-video or per-creator language field exists anywhere in the
  schema yet (captions live only in Cloudflare Stream, not our DB), so the
  "language" half of the country/language boost is a documented no-op —
  `users.preferred_languages` is stored but nothing reads it yet. Only the country
  half is live
- `POST /api/feed/watch-progress` — optionalAuth, writes one `watch_events` row per
  call. Fired by the client every 10-15s during playback plus on pause/unload —
  this granular signal is what `computeFeedScore`'s completion rate depends on;
  there is no separate "on-leave" completion event like the old `view-complete`
  route had
- `videos.content_category` is a **separate column from the older `category`**
  (`VALID_VIDEO_CATEGORIES` — Comedy/Drama/Music/News/Sports/Lifestyle/Education/
  Other), which stays as-is and is still used for admin/related-videos. Two
  category-like fields now coexist on `videos` — reconcile eventually, not done
  as part of this task. `content_category` now has 11 values (added `nature`;
  `news` already existed) — see `CONTENT_CATEGORIES` in zuva-api.js
- `GET /api/feed` also takes optional `content_category` and `country` (2-letter
  `users.country_code`) query params — both filter the SQL candidate pool before
  scoring, orthogonal to which ranking path a viewer gets. Reached from the
  frontend homepage's category/country bar via `/feed?content_category=` or
  `/feed?country=`
- **Homepage fallback ranking** — anonymous viewers, or signed-in viewers with
  zero `watch_events` rows, don't get `buildRankedFeed`'s personalized path at
  all (it would just collapse to a flat, identical-every-visit "trending +
  recency" order with no signal to personalize against). Instead
  `buildFallbackFeed` takes the top `FALLBACK_TOP_PER_CATEGORY` (15) scored
  candidates *per content_category* — so "across all categories" holds
  regardless of the raw score distribution — and shuffles them with
  `seededShuffle`/`mulberry32`, seeded from `Math.floor(Date.now() /
  (FALLBACK_RESEED_BUCKET_MINUTES * 60000))` (20-minute buckets). Deterministic
  *within* a bucket (concurrent anonymous viewers see the same order, not a
  different shuffle per request) and automatically different once the bucket
  rolls over — server-side time-bucketed reseeding, not `Math.random()` per
  request. The route decides which path to use per-request (`useFallback = !req.user
  || !hasHistory`, where `hasHistory` comes from an `EXISTS (SELECT 1 FROM
  watch_events WHERE user_id = ...)` check) — the frontend never needs to know
  which one it got

## AI-content disclosure
- Self-disclosure only — **no automated detection**. `videos.contains_synthetic_media`
  (`BOOLEAN NOT NULL DEFAULT false`), required (not `.optional()`) on
  `POST /api/upload/video` — the client form has no default selection either, so
  every new upload has to make an active Yes/No choice
- `computeFeedScore` / `computeFlareScore` never read this column — confirmed by
  grep, not just by construction — it has zero effect on ranking, discoverability,
  or monetization, exactly per spec
- Only surfaced on `GET /api/video/:id` (the long-form watch page badge) — not
  added to the `GET /api/feed` / `GET /api/flares/feed` response shapes, since
  nothing renders it there

## Publishing & tiered reporting (moderation)
- **All new uploads publish immediately** — `POST /api/upload/video` inserts
  `videos.status = 'published'` directly. There is no pre-approval gate of any
  kind. The old upload-time AWS Rekognition thumbnail check (`moderateVideo()`)
  was removed entirely, not just bypassed — it could reject a video or strand
  it at `'pending'` on a transient AWS/thumbnail failure, which in practice
  behaved like an unintentional manual-approval requirement. Moderation is now
  entirely post-publish, driven by reports
- `videos.status` (not `moderation_status` — that name only exists in dead
  legacy code referencing tables that were never real) already had
  `'under_review'` in its CHECK constraint before this change; the migration
  reasserts it defensively anyway for a clean positive confirmation
- **`video_reports`** — widened from its original shape (`reason` free text,
  `reporter_clerk_id`) rather than replaced: `reporter_id` (→ `users.id`,
  nullable), `category` (9-value enum — see `REPORT_CATEGORIES`),
  `additional_details`, `resolved_at`, `resolution` (`'restored'|'removed'`).
  `reason`/`reporter_clerk_id` stay in place for historical rows but nothing
  writes to them anymore; `reason`'s `NOT NULL` was relaxed so new inserts can
  omit it. `id` stays `SERIAL` (not migrated to UUID — changing a live PK's
  type is disproportionate risk for this table)
- **Severity tiers** (`REPORT_TIERS` in zuva-api.js) — each category belongs to
  exactly one tier, thresholds count only *pending* (`resolved_at IS NULL`)
  reports in that tier's categories for the video being reported (so a
  resolved-and-restored video isn't permanently primed to re-trigger from
  stale history):
  - `nudity`, `minors` → 1 pending report → `under_review`, priority admin email
  - `violence`, `animal_cruelty` → 2 pending reports → same
  - `hate_speech`, `misinformation`, `spam`, `other` → `REPORT_THRESHOLD`
    (existing, default 3) pending reports → `under_review` **and** triggers
    `moderateReportedVideo()`'s AI re-review, same as before
  - The two higher-severity tiers deliberately do **not** trigger the AI
    re-review — a wrongly-cleared Rekognition re-scan auto-republishing a
    nudity/minors or violence/animal_cruelty report would be dangerous for
    exactly the categories where speed-to-human-eyes matters most. They hide
    the video and email the admin immediately instead, with no automated
    re-publish path
  - `copyright` never reaches tier logic or `video_reports` at all —
    `POST /video/:id/report` intercepts it and returns a response pointing at
    the existing takedown-notice process (`legal@zuva.tv`, matching
    `terms/page.tsx`'s `LEGAL_CONTACT`) instead
- **`GET /api/admin/reports?category=&status=&page=&limit=`** — report-centric
  paginated queue (status defaults to `pending`), distinct from the older
  `GET /admin/moderation-queue` (video-centric, unpaginated, shows videos
  currently `under_review`/`flagged`) which is untouched
- **`GET /api/admin/reports/stats?from=&to=`** — defaults to the last 30 days.
  Category counts are scoped by `created_at` (when filed); resolution time and
  the restored/removed ratio are scoped by `resolved_at` (when resolved) —
  deliberately different date columns per stat, since a report filed just
  before the range but resolved inside it should count toward resolution
  stats, not category volume
- **`POST /api/admin/reports/:id/resolve`** (`:id` is the `video_reports`
  integer id, not a UUID) — resolving *one* report closes out **every**
  still-pending report against the same video in one transaction (an admin is
  deciding the video's fate, not adjudicating each report row — multiple
  people may have reported the same video). `'removed'` → `videos.status =
  'rejected'` + `users.violation_count += 1` for the creator. `'restored'` →
  `videos.status = 'published'`
- `users.violation_count` only accumulates right now — no Community
  Guidelines page or enforcement ladder exists anywhere in either repo to act
  on it yet (confirmed by search before writing this). The migration and this
  route only build the counter itself, ready to feed a ladder later

## Flares (short-form vertical feed)
- Same `videos` table/Cloudflare Stream pipeline as long-form uploads — `is_flare`
  boolean flags which feed a row belongs to; the main `/feed` browse grid and
  `/flares` swipe feed are otherwise fully separate experiences (frontend concern)
- `FLARE_MAX_DURATION_SECONDS = 90`, enforced twice: synchronously in
  `POST /api/upload/video` when Cloudflare already knows the duration (deletes the
  Cloudflare video + rejects with 400), and again in `GET /upload/status/:videoId`
  once Cloudflare reports it asynchronously (flips `status` to `'rejected'`,
  response includes `flare_rejected: true`)
- `GET /api/flares/feed?cursor=&limit=&exclude=` — optionalAuth, now ranked by
  `computeFlareScore(flare)`: primarily completion/watch-through rate, loop rate
  (`flare_swipe_events.looped` — rewatches are a strong positive signal), and an
  inverse penalty for swipe-away rate (`swiped_away`, true if the viewer left
  before 75% watched). Likes/comments/tips carry much lighter weight than the main
  feed — completion behavior dominates for short-form, on purpose. See
  `FLARE_WEIGHTS` in zuva-api.js
- **Deliberately independent from the main feed's scoring** — no shared scoring
  function, `computeFlareScore`/`buildRankedFlaresFeed`/`assembleFlaresPage` never
  call into `computeFeedScore`/`buildRankedFeed`/`assembleFeedRound` or vice versa.
  Flares optimizes for immersive session length; the main feed optimizes for
  satisfaction/discovery with protected category placement — different products,
  different goals, per an explicit design decision
- Light exploration mix-in (`FLARE_EXPLORATION_RATIO = 0.15`) — a softer touch than
  the main feed's guaranteed category floor: ~15% of each page is nudged toward
  candidates whose category AND creator both differ from what's already
  score-picked, so the swipe feed doesn't fully lock a viewer into one narrow loop.
  Falls back to next-best-scored candidates if the pool is too small/homogeneous
  to find enough genuinely different picks
- `cursor` is an opaque base64-encoded offset, not true keyset pagination — a
  score that shifts as new `flare_swipe_events` land isn't a stable sort key to
  page against, so this is the standard approach for score-ranked feeds (same as
  Reddit/HN-style "hot" pagination). `exclude` is a client-supplied comma-separated
  list of already-seen video IDs (capped at 200) — session tracking is
  caller-driven, not server-persisted, so it works for anonymous viewers too
- `POST /api/flares/swipe-event` — optionalAuth, writes one `flare_swipe_events`
  row per call. Fired by the client on swipe-away, loop detection, and
  periodically during playback (same cadence as the main feed's watch-progress
  ping)
- Likes/comments/tips/subscriptions are the exact same endpoints long-form videos
  use — nothing Flare-specific there

## Video Captions (Cloudflare Stream)
- No local table — Cloudflare Stream is the sole source of truth for which caption
  tracks exist on a video (same philosophy as `thumbnail_url`/`duration_seconds`
  being synced FROM Cloudflare rather than owned here). The public player already
  embeds Cloudflare's own iframe (`iframe.cloudflarestream.com/{uid}`), which shows
  a native CC toggle automatically once tracks exist — no custom player work needed.
- `GET/POST /api/upload/video/:videoId/captions`, `DELETE .../captions/:language` —
  creator-only, ownership-checked against `videos.creator_id`
- Cloudflare's captions API only accepts WebVTT — `srtToVtt()` in zuva-api.js
  losslessly converts `.srt` uploads (strips numeric cue-sequence lines, swaps the
  comma decimal separator for VTT's required period) before the PUT; `.vtt` uploads
  pass through unchanged
- `CAPTION_LANGUAGES` whitelist (en/fr/pt/sw/ar/es/ht/yo/ha/zu/am) must stay in sync
  with the matching list in `zuva-frontend/components/VideoUploadForm.tsx`

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
