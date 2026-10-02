/**
 * Hero LQIP (low-quality image placeholder) generator.
 *
 * The homepage hero used to paint a bare `bg-ink` (#0a0a0a) rectangle until the
 * first hero photo finished downloading, which on mobile reads as a broken
 * black slab. The fix is a blur-up: a ~0.5 kB blurred preview OF THE ACTUAL
 * hero photo, painted immediately, with the full-resolution image crossfaded
 * over it once decoded.
 *
 * This script produces those previews as committed artifacts so the placeholder
 * costs ZERO network requests and is available at first paint — even before
 * React boots, via an inline `--hero-lqip` custom property in index.html.
 *
 * How the preview is made: the real hero image is downloaded, downscaled to a
 * ~24px-wide canvas, re-blurred on the way back up, and encoded as a WebP data
 * URI. A tiny canvas is used as the image processor so the repo gains no image
 * dependency (no sharp/imagemin/vite-imagetools).
 *
 * Outputs (both committed):
 *   src/lib/heroLqip.generated.ts  — url -> data-URI map, keyed by storage object
 *                                    filename so it survives bucket/host moves.
 *   index.html                     — the FIRST slide's preview is inlined into
 *                                    `:root{--hero-lqip:...}` between the
 *                                    HERO_LQIP_START/END markers, so the hero
 *                                    shell is never black even pre-hydration.
 *
 * Re-run after changing hero images in the admin panel:
 *   node scripts/generate-hero-lqip.mjs
 *
 * Options:
 *   --url <u>        Generate for an explicit URL (repeatable). Skips the DB.
 *   --offline        Do not contact the database; use URLs already in the
 *                    committed map, refreshed from the db-snapshots CSV.
 *   --dry-run        Print what would happen, write nothing.
 *   --no-inline      Skip the index.html inlining.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(ROOT, 'src', 'lib', 'heroLqip.generated.ts');
const INDEX_HTML = join(ROOT, 'index.html');
const SNAPSHOT = join(ROOT, 'db-snapshots', 'hero_slides_text_20260917.csv');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LQIP_WIDTH = 32; // px, width of the downscaled source
const LQIP_UPSCALE = 4; // upscaled back up so the browser's bilinear filter has
//                        something smooth to work with, then blurred again
const START_MARKER = '/*HERO_LQIP_START*/';
const END_MARKER = '/*HERO_LQIP_END*/';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const all = (f) => argv.reduce((acc, a, i) => (a === f ? [...acc, argv[i + 1]] : acc), []);

const log = (...a) => console.log(...a);

/* -------------------------------------------------------------------------- */
/* URL sources                                                                 */
/* -------------------------------------------------------------------------- */

/** Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY out of the local env files.
 *  The storefront only ever uses the public anon key, which is enough for
 *  PostgREST to read the active hero rows. */
async function readEnv() {
  const out = {};
  for (const file of ['.env', '.env.local']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2].trim().replace(/^["']|["']$/g, '');
      out[m[1]] = value;
    }
  }
  return out;
}

async function urlsFromDatabase() {
  const env = await readEnv();
  const base = (env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.VITE_SUPABASE_ANON_KEY || '';
  if (!base || !key) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not found in .env');
  const url =
    `${base}/rest/v1/hero_slides` +
    `?select=image_url,sort_order&active=eq.true&order=sort_order.asc`;
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`hero_slides query failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.map((r) => r.image_url).filter(Boolean);
}

/** Fallback so the script still works with no DB access: the URL column of the
 *  committed hero snapshot. */
async function urlsFromSnapshot() {
  const text = await readFile(SNAPSHOT, 'utf8');
  return text
    .split('\n')
    .map((l) => {
      const cells = l.split(',');
      return cells[cells.length - 1].trim();
    })
    .filter((u) => /^https?:\/\//.test(u));
}

/* -------------------------------------------------------------------------- */
/* Preview rendering                                                           */
/* -------------------------------------------------------------------------- */

/** Runs inside the browser: downscale -> upscale -> blur -> tiny WebP data URI.
 *  The aspect ratio of the SOURCE is preserved, so painting the preview with the
 *  same `object-cover` as the real image crops identically and the crossfade
 *  lands perfectly in register (no jump, no layout shift). */
function renderLqipInPage({ src, width, upscale, dataUrl }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const sw = img.naturalWidth;
        const sh = img.naturalHeight;
        const w = Math.max(1, width);
        const h = Math.max(1, Math.round((sh / sw) * w));

        // 1. heavy downscale to ~24px — this is where the detail is destroyed.
        const small = document.createElement('canvas');
        small.width = w;
        small.height = h;
        const sctx = small.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(img, 0, 0, w, h);

        // 2. back up to a still-tiny size through a blur filter. The blur is
        //    baked into the pixels so the page never needs a CSS filter
        //    (a full-bleed backdrop-filter is expensive on mobile GPUs).
        const out = document.createElement('canvas');
        out.width = w * upscale;
        out.height = h * upscale;
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.filter = `blur(${Math.max(1, Math.round(w * upscale * 0.06))}px)`;
        // Overscan by a couple of px so the blur doesn't fade to transparency
        // at the edges (which would show the container colour as a vignette).
        octx.drawImage(small, -2, -2, out.width + 4, out.height + 4);
        octx.filter = 'none';

        // 3. encode. WebP first, JPEG fallback for old Safari.
        let uri = '';
        for (const [type, quality] of [['image/webp', 0.4], ['image/jpeg', 0.35]]) {
          uri = out.toDataURL(type, quality);
          if (uri.startsWith(`data:${type}`)) break;
        }
        resolve({ ok: true, dataUri: uri, sourceWidth: sw, sourceHeight: sh });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    };
    img.onerror = () => resolve({ ok: false, error: 'image decode failed' });
    img.src = dataUrl;
  });
}

async function renderAll(urls) {
  if (!existsSync(CHROME)) {
    throw new Error(
      `Chrome not found at ${CHROME}. Set CHROME_PATH to a Chrome/Edge binary, ` +
        `or install one of the playwright browsers.`
    );
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const out = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) {
        log(`  ! ${short(url)} -> HTTP ${res.status} (skipped)`);
        out.push({ url, skipped: true });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const dataUrl = `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
      const r = await page.evaluate(renderLqipInPage, {
        src: url,
        width: LQIP_WIDTH,
        upscale: LQIP_UPSCALE,
        dataUrl,
      });
      if (!r.ok || !r.dataUri || r.dataUri.length < 32) {
        log(`  ! ${short(url)} -> ${r.error || 'empty preview'} (skipped)`);
        out.push({ url, skipped: true });
        continue;
      }
      const bytes = Math.round((r.dataUri.length - r.dataUri.indexOf(',') - 1) * 0.75);
      log(`  + ${short(url)} -> ${bytes} B preview (source ${r.sourceWidth}x${r.sourceHeight})`);
      out.push({ url, dataUri: r.dataUri, bytes, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight });
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

const short = (u) => u.slice(u.lastIndexOf('/') + 1).slice(0, 48);

/** The lookup key. Deliberately the storage object filename (query/hash
 *  stripped, lowercased) so a preview keeps matching if the Supabase host or
 *  bucket path ever changes. Hero uploads are uuid-named, so this is
 *  effectively collision-free. Mirrored by `heroLqipKey` in src/lib/heroLqip.ts
 *  — scripts/hero-lqip.test.mjs asserts the two stay identical. */
export function lqipKey(url) {
  if (typeof url !== 'string') return '';
  const withoutQuery = url.split(/[?#]/)[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  const name = segments.length ? segments[segments.length - 1] : '';
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

function renderModule(results) {
  const entries = results
    .filter((r) => !r.skipped && r.dataUri)
    .map((r) => `  ${JSON.stringify(lqipKey(r.url))}: ${JSON.stringify(r.dataUri)},`);
  const first = results.find((r) => !r.skipped && r.dataUri);

  return `/**
 * GENERATED FILE — do not edit by hand.
 * Run \`node scripts/generate-hero-lqip.mjs\` to regenerate.
 * Produced by scripts/generate-hero-lqip.mjs.
 *
 * ${entries.length} blurred preview(s) of the real hero photographs, as
 * self-contained data URIs. Painting one costs zero network requests, which is
 * what keeps the hero from flashing a black slab on a cold mobile load.
 */

/** Storage object filename -> blurred preview data URI. */
export const HERO_LQIP: Readonly<Record<string, string>> = {
${entries.join('\n')}\n};

/** image_url of the slide the hero opens on, inlined into index.html so the
 *  shell is painted before React boots. Empty when the DB was unreachable. */
export const HERO_LQIP_FIRST_URL = ${JSON.stringify(first ? first.url : '')};
`;
}

function renderIndexHtml(html, firstDataUri) {
  if (!html.includes(START_MARKER) || !html.includes(END_MARKER)) {
    throw new Error(
      `index.html is missing the ${START_MARKER} / ${END_MARKER} markers; ` +
        `cannot inline the hero preview.`
    );
  }
  const decl = firstDataUri
    ? `:root{--hero-lqip:url("${firstDataUri}");}`
    : `:root{--hero-lqip:none;}`;
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  return html.slice(0, start + START_MARKER.length) + decl + html.slice(end);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const dryRun = has('--dry-run');
  const explicit = all('--url').filter((u) => /^https?:\/\//.test(u));

  let urls = explicit;
  let source = 'explicit --url';
  if (!urls.length) {
    if (has('--offline')) {
      urls = await urlsFromSnapshot();
      source = 'db-snapshots CSV (offline)';
    } else {
      try {
        urls = await urlsFromDatabase();
        source = 'live hero_slides';
      } catch (err) {
        log(`! could not read hero_slides (${err.message}); falling back to the snapshot CSV`);
        urls = await urlsFromSnapshot();
        source = 'db-snapshots CSV (fallback)';
      }
    }
  }

  // Preserve slide order, drop duplicates and blanks.
  urls = Array.from(new Set(urls.map((u) => String(u).trim()).filter(Boolean)));
  if (!urls.length) {
    log('! no hero image URLs found — nothing to generate.');
    return;
  }
  log(`hero images (${urls.length}) from ${source}`);
  const results = await renderAll(urls);

  const usable = results.filter((r) => !r.skipped);
  if (!usable.length) {
    log('! every hero image failed to decode — leaving the committed map untouched.');
    process.exitCode = 1;
    return;
  }
  const total = usable.reduce((a, r) => a + r.bytes, 0);
  log(`total preview weight: ${total} B across ${usable.length} image(s)`);

  if (dryRun) {
    log('--dry-run: nothing written.');
    return;
  }

  await writeFile(GENERATED, renderModule(usable), 'utf8');
  log(`wrote ${GENERATED.replace(ROOT + '\\', '')}`);

  if (!has('--no-inline')) {
    const html = await readFile(INDEX_HTML, 'utf8');
    const next = renderIndexHtml(html, usable[0].dataUri);
    if (next !== html) {
      await writeFile(INDEX_HTML, next, 'utf8');
      log(`inlined the first preview into index.html (${usable[0].bytes} B)`);
    } else {
      log('index.html already up to date');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
