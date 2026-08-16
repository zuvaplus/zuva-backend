'use strict';

/**
 * ============================================================
 *  scripts/seedVideos.js
 * ============================================================
 *  One-off seed script: pulls 20 stock videos from Pexels across
 *  African/Caribbean-themed searches, uploads each to Cloudflare
 *  Stream, waits for processing, and inserts a row into the live
 *  `videos` table via the same DATABASE_URL/pg pattern zuva-api.js
 *  uses (no @supabase/supabase-js — that's not a dependency
 *  anywhere in this codebase, and DATABASE_URL already points at
 *  the same Supabase Postgres instance).
 *
 *  All seeded rows are attributed to the `founder` test account
 *  (00000000-0000-0000-0000-000000000002) — a purpose-built seed
 *  creator, not a real person's account.
 *
 *  Temp files go to os.tmpdir() (not a literal /tmp — that path
 *  doesn't exist on this Windows machine outside of a POSIX
 *  emulation layer, and Node's fs module doesn't go through one).
 *
 *  Run: node scripts/seedVideos.js
 * ============================================================
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

// Hardcoded per explicit instruction — a Pexels API key, not a financial
// or account credential.
const PEXELS_API_KEY = 'nTGDzZXf8oCfzWy8RCMsnfBN07eWbnVFZafvweIDq3A5hvrZQuIS7JDd';

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DATABASE_URL } = process.env;
if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !DATABASE_URL) {
  console.error('Missing required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// `founder` / test@zuva.tv — dedicated seed/test creator account confirmed
// against the live `users` table before writing this script.
const CREATOR_ID = '00000000-0000-0000-0000-000000000002';

const CLOUDFLARE_STREAM_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`;

// `category` = old VALID_VIDEO_CATEGORIES taxonomy (required by app-level
// validation on the real upload route, though not DB-enforced).
// `contentCategory` = new content_category taxonomy (DB CHECK-enforced) —
// values below match what the content-categories task actually asked for.
const SEARCHES = [
  { query: 'Africa market', count: 3, titleBase: 'African Market Life', category: 'Lifestyle', contentCategory: 'documentary', tags: ['africa', 'market', 'culture'], description: 'A vibrant look at everyday market life across Africa.' },
  { query: 'Kenya nature', count: 2, titleBase: 'Kenya Nature', category: 'Education', contentCategory: 'documentary', tags: ['kenya', 'nature', 'landscape'], description: 'Sweeping views of Kenya’s natural landscapes.' },
  { query: 'Nigeria city', count: 3, titleBase: 'Nigeria City Life', category: 'Lifestyle', contentCategory: 'documentary', tags: ['nigeria', 'city', 'urban'], description: 'The energy and rhythm of city life in Nigeria.' },
  { query: 'Ghana culture', count: 2, titleBase: 'Ghana Culture', category: 'Lifestyle', contentCategory: 'documentary', tags: ['ghana', 'culture', 'tradition'], description: 'A glimpse into the rich cultural traditions of Ghana.' },
  { query: 'Caribbean beach', count: 3, titleBase: 'Caribbean Beach', category: 'Lifestyle', contentCategory: 'documentary', tags: ['caribbean', 'beach', 'ocean'], description: 'Sun, sand, and sea along the Caribbean coastline.' },
  { query: 'Jamaica', count: 2, titleBase: 'Jamaica', category: 'Lifestyle', contentCategory: 'documentary', tags: ['jamaica', 'caribbean'], description: 'Scenes of everyday life and scenery in Jamaica.' },
  { query: 'African dance', count: 3, titleBase: 'African Dance', category: 'Music', contentCategory: 'health_wellness', tags: ['africa', 'dance', 'music'], description: 'Energetic dance and movement rooted in African tradition.' },
  { query: 'East Africa wildlife', count: 2, titleBase: 'East Africa Wildlife', category: 'Education', contentCategory: 'science_education', tags: ['wildlife', 'safari', 'eastafrica'], description: 'Wildlife and ecosystems of East Africa in their natural habitat.' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchPexels(query, count) {
  const res = await axios.get('https://api.pexels.com/videos/search', {
    headers: { Authorization: PEXELS_API_KEY },
    params: { query, orientation: 'landscape', size: 'medium', per_page: count },
  });
  return res.data.videos || [];
}

function pickVideoFile(video) {
  const files = video.video_files || [];
  return files.find((f) => f.quality === 'hd')
    || [...files].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
}

async function downloadVideo(url, destPath) {
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

async function uploadToStream(filePath, originalName) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), originalName);
  const res = await axios.post(CLOUDFLARE_STREAM_BASE, form, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, ...form.getHeaders() },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (!res.data?.success) {
    throw new Error(`Cloudflare Stream upload failed: ${JSON.stringify(res.data?.errors)}`);
  }
  return res.data.result.uid;
}

async function waitForStreamReady(uid, maxMs = 120000, intervalMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await axios.get(`${CLOUDFLARE_STREAM_BASE}/${uid}`, {
      headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
    });
    const result = res.data?.result;
    const state = result?.status?.state;
    if (state === 'ready') return result;
    if (state === 'error') throw new Error(`Cloudflare Stream reported a processing error for ${uid}`);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for Cloudflare Stream to finish processing ${uid}`);
}

async function insertVideoRow({ title, description, category, contentCategory, tags, cloudflareUid, thumbnailUrl, durationSeconds }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO videos
       (id, creator_id, title, description, category, content_category, tags,
        cloudflare_video_id, thumbnail_url, duration_seconds, status, is_flare,
        contains_synthetic_media, view_count, like_count, comment_count, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published', false, false, 0, 0, 0, $11)`,
    [id, CREATOR_ID, title, description, category, contentCategory, tags,
      cloudflareUid, thumbnailUrl, durationSeconds, new Date().toISOString()]
  );
  return id;
}

async function main() {
  const results = { attempted: 0, succeeded: 0, failed: [] };
  let seedIndex = 0;

  for (const search of SEARCHES) {
    console.log(`\n=== Pexels search: "${search.query}" (need ${search.count}) ===`);
    let videos;
    try {
      videos = await searchPexels(search.query, search.count);
    } catch (err) {
      console.error(`  Pexels search failed for "${search.query}": ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
      continue;
    }
    if (!videos.length) {
      console.log(`  No results for "${search.query}" — skipping.`);
      continue;
    }

    const picked = videos.slice(0, search.count);
    for (let i = 0; i < picked.length; i++) {
      seedIndex++;
      const title = `${search.titleBase} #${i + 1}`;
      results.attempted++;
      console.log(`\n--- [${title}] ---`);

      const file = pickVideoFile(picked[i]);
      if (!file) {
        console.error(`  No usable video_file found — skipping.`);
        results.failed.push(title);
        continue;
      }

      const tempPath = path.join(os.tmpdir(), `zuva_seed_${seedIndex}.mp4`);
      let downloadedOk = false;
      try {
        console.log(`  Downloading ${file.link} (${file.quality}, ${file.width}x${file.height})...`);
        await downloadVideo(file.link, tempPath);
        downloadedOk = true;
        console.log(`  Downloaded -> ${tempPath}`);

        console.log('  Uploading to Cloudflare Stream...');
        const uid = await uploadToStream(tempPath, `${title}.mp4`);
        console.log(`  Uploaded. Stream uid: ${uid}`);

        // Clean up the local file now that Stream has it, per spec.
        fs.unlink(tempPath, () => {});
        downloadedOk = false; // already cleaned up, don't try again in finally

        console.log('  Waiting for Stream processing...');
        const ready = await waitForStreamReady(uid);
        const thumbnailUrl = ready.thumbnail || null;
        console.log(`  Ready. thumbnail: ${thumbnailUrl}`);

        const durationSeconds = Math.round(picked[i].duration || 0);

        const insertedId = await insertVideoRow({
          title,
          description: search.description,
          category: search.category,
          contentCategory: search.contentCategory,
          tags: search.tags,
          cloudflareUid: uid,
          thumbnailUrl,
          durationSeconds,
        });
        console.log(`  Inserted into videos table: id=${insertedId}`);
        results.succeeded++;
      } catch (err) {
        console.error(`  FAILED "${title}": ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        results.failed.push(title);
      } finally {
        if (downloadedOk) fs.unlink(tempPath, () => {});
      }
    }
  }

  console.log('\n\n===== SUMMARY =====');
  console.log(`Total attempted: ${results.attempted}`);
  console.log(`Total succeeded: ${results.succeeded}`);
  console.log(`Total failed:    ${results.failed.length}`);
  if (results.failed.length) {
    console.log('Failed videos:');
    results.failed.forEach((t) => console.log(`  - ${t}`));
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
