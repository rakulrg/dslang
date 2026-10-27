/**
 * Technical SEO contract.
 *
 * The storefront is a client-rendered Vite/React app, so everything search
 * engines and social cards read before JavaScript boots lives in `index.html`
 * plus the static files in `public/`. These assertions pin that contract: one
 * canonical homepage, indexable metadata, valid Organization/WebSite/WebPage
 * structured data, a sitemap that exposes only the canonical public URL, and a
 * robots file that keeps private surfaces out of the crawl.
 *
 * Deliberately offline and source-level: `npm test` must not depend on the
 * network or the live database. The deployed URLs are verified separately.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const HTML = read('index.html');
const APP = read('src/App.tsx');
const HOME = read('src/pages/HomePage.tsx');
const POLICIES = read('src/lib/policies.tsx');
const ROBOTS = read('public/robots.txt');
const SITEMAP = read('public/sitemap.xml');
const VERCEL = JSON.parse(read('vercel.json'));

const SITE = 'https://dslang.in/';
const TITLE = 'DSLANG | Premium Streetwear Clothing India';

/** Contents of a `<meta property|name="..." content="...">` tag. */
function meta(attr, key) {
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content="([^"]*)"`, 'i');
  return re.exec(HTML)?.[1] ?? null;
}

/** PNG IHDR width/height, so the asset contract checks the real pixels. */
function pngSize(rel) {
  const path = join(ROOT, rel);
  assert.ok(existsSync(path), `${rel} is missing`);
  const buf = readFileSync(path);
  assert.match(buf.subarray(1, 4).toString('ascii'), /PNG/, `${rel} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: statSync(path).size };
}

/* ================================================================== *
 * Canonical homepage metadata
 * ================================================================== */
test('SEO: the homepage declares one apex canonical URL', () => {
  const canonicals = [...HTML.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(canonicals, [SITE], 'exactly one canonical, pointing at the apex domain');
  assert.doesNotMatch(HTML, /rel="canonical"[^>]*https:\/\/www\./i, 'the canonical must not use www');
});

test('SEO: title and description identify DSLANG as a clothing brand', () => {
  const title = /<title>([^<]*)<\/title>/i.exec(HTML)?.[1] ?? '';
  assert.equal(title, TITLE);
  assert.match(title, /DSLANG/);
  assert.match(title, /Streetwear/i);
  assert.match(title, /Clothing/i);
  assert.ok(title.length <= 60, `title is ${title.length} chars; keep it under 60 so Google does not truncate it`);

  const description = meta('name', 'description');
  assert.ok(description, 'meta description is missing');
  assert.match(description, /clothing/i);
  assert.match(description, /India/i);
  assert.ok(description.length >= 80, 'description is too thin to earn a useful snippet');
  assert.ok(description.length <= 165, `description is ${description.length} chars; keep it under 165`);
  assert.doesNotMatch(description, /new drops/i);
});

test('SEO: the homepage is explicitly indexable', () => {
  const robots = meta('name', 'robots');
  assert.ok(robots, 'robots meta is missing');
  assert.match(robots, /\bindex\b/);
  assert.match(robots, /\bfollow\b/);
  assert.doesNotMatch(robots, /\bnoindex\b/i, 'the homepage must never carry noindex');
  assert.doesNotMatch(robots, /\bnofollow\b/i);
  assert.match(robots, /max-image-preview:large/);
  assert.equal(/<meta[^>]+name="googlebot"[^>]+noindex/i.test(HTML), false, 'googlebot must not be blocked');
});

test('SEO: the document language and viewport are set for India', () => {
  assert.match(HTML, /<html lang="en-IN">/);
  assert.match(HTML, /name="viewport"[^>]*width=device-width/);
});

/* ================================================================== *
 * Open Graph / Twitter cards
 * ================================================================== */
test('SEO: Open Graph and Twitter cards point at local, sized assets', () => {
  assert.equal(meta('property', 'og:site_name'), 'DSLANG');
  assert.equal(meta('property', 'og:locale'), 'en_IN');
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:url'), SITE);
  assert.equal(meta('property', 'og:title'), TITLE);
  assert.match(meta('property', 'og:description') ?? '', /clothing/i);

  const image = meta('property', 'og:image');
  assert.equal(image, 'https://dslang.in/og-image.png', 'the OG image must be served from the canonical domain');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.equal(meta('property', 'og:image:type'), 'image/png');
  assert.ok(meta('property', 'og:image:alt'));

  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:title'), TITLE);
  assert.equal(meta('name', 'twitter:image'), image);
  assert.ok(meta('name', 'twitter:image:alt'));

  // No third-party stock photo may stand in for the brand's own card.
  assert.doesNotMatch(HTML, /images\.pexels\.com/, 'social metadata must not depend on an external stock image');
});

/* ================================================================== *
 * Structured data
 * ================================================================== */
test('SEO: JSON-LD parses and describes the Organization, WebSite and WebPage', () => {
  const blocks = [...HTML.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  assert.equal(blocks.length, 1, 'expected one JSON-LD block');
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data['@context'], 'https://schema.org');
  assert.ok(Array.isArray(data['@graph']), 'structured data must be a @graph');

  const nodes = data['@graph'];
  const byType = (type) => nodes.find((node) => {
    const t = node['@type'];
    if (Array.isArray(t)) return t.includes(type);
    return t === type;
  });
  const organization = byType('Organization');
  const website = byType('WebSite');
  const webpage = byType('WebPage');
  assert.ok(organization && website && webpage, 'Organization, WebSite and WebPage are all required');

  assert.equal(organization['@id'], 'https://dslang.in/#organization');
  assert.equal(organization.name, 'DSLANG');
  assert.equal(organization.url, SITE);
  assert.equal(organization.logo.url, 'https://dslang.in/brand-logo.png');
  assert.equal(organization.logo.width, 512);
  assert.equal(organization.logo.height, 512);

  assert.equal(website['@id'], 'https://dslang.in/#website');
  assert.equal(website.url, SITE);
  assert.equal(website.name, 'DSLANG');
  assert.equal(website.inLanguage, 'en-IN');
  assert.deepEqual(website.publisher, { '@id': organization['@id'] });

  assert.equal(webpage['@id'], 'https://dslang.in/#webpage');
  assert.equal(webpage.url, SITE);
  assert.equal(webpage.name, TITLE);
  assert.equal(webpage.inLanguage, 'en-IN');
  assert.deepEqual(webpage.isPartOf, { '@id': website['@id'] });
  assert.deepEqual(webpage.about, { '@id': organization['@id'] });
  assert.equal(webpage.primaryImageOfPage.url, 'https://dslang.in/og-image.png');

  // Every cross-reference must resolve inside the graph; a dangling @id is
  // silently dropped by validators and loses the entity relationship.
  const ids = new Set(nodes.map((node) => node['@id']));
  for (const node of nodes) {
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && value['@id']) {
        assert.ok(ids.has(value['@id']), `unresolved @id reference: ${value['@id']}`);
      }
    }
  }

  // Structured data must describe the same canonical domain as the page.
  for (const url of [organization.url, website.url, webpage.url, organization.logo.url]) {
    assert.ok(url.startsWith('https://dslang.in/'), `${url} is not on the canonical domain`);
  }
});

/* ================================================================== *
 * The initial HTML is not an empty shell
 * ================================================================== */
test('SEO: the initial HTML contains brand content before React boots', () => {
  const root = /<div id="root">([\s\S]*?)<\/div>\s*<script\s+type="module"/i.exec(HTML)?.[1];
  assert.ok(root, 'could not isolate the #root fallback');
  assert.ok(root.trim().length > 0, '#root must not be an empty container in the served HTML');
  assert.match(root, /<h1[^>]*>[^<]*DSLANG[^<]*Premium Streetwear Clothing in India/i);
  assert.match(root, /streetwear/i);
  assert.match(root, /hoodies|tees|joggers/i);
  assert.match(root, /href="#\/collections"/, 'the fallback must link to the collection');
  assert.match(root, /href="#\/about"/);
  assert.match(root, /href="#\/contact"/);
});

test('SEO: the rendered homepage also exposes a single hidden H1', () => {
  const h1 = /<h1 className="sr-only">([^<]+)<\/h1>/.exec(HOME)?.[1];
  assert.ok(h1, 'HomePage must render an sr-only H1');
  assert.match(h1, /^DSLANG/);
  assert.match(h1, /Streetwear/i);
  // The fallback is replaced on mount, so the runtime H1 must be exactly one.
  assert.equal((HOME.match(/<h1\b/g) ?? []).length, 1);
});

test('SEO: the client-side default title matches the static document title', () => {
  const appTitle = /const DEFAULT_TITLE = '([^']+)';/.exec(APP)?.[1];
  assert.equal(appTitle, TITLE, 'the SPA must not overwrite the crawlable title with a different one');
});

test('SEO: policy pages name the same canonical domain', () => {
  assert.match(POLICIES, /export const POLICY_SITE = 'dslang\.in';/);
  assert.doesNotMatch(POLICIES, /www\.dslang\.in/);
});

/* ================================================================== *
 * robots.txt
 * ================================================================== */
test('SEO: robots.txt allows the storefront and blocks private surfaces', () => {
  const lines = ROBOTS.split(/\r?\n/).map((line) => line.trim());
  assert.ok(lines.includes('User-agent: *'));
  assert.ok(lines.includes('Allow: /'), 'the public storefront must remain crawlable');

  const disallowed = lines.filter((line) => line.startsWith('Disallow:')).map((line) => line.slice('Disallow:'.length).trim());
  for (const path of ['/admin', '/account', '/cart', '/checkout', '/payment/', '/order-status', '/my-orders', '/track-order', '/api/']) {
    assert.ok(disallowed.includes(path), `${path} must stay out of the crawl`);
  }
  assert.equal(disallowed.includes('/'), false, 'robots.txt must not disallow the whole site');

  assert.ok(lines.includes('Sitemap: https://dslang.in/sitemap.xml'), 'the sitemap must be declared on the apex domain');
  assert.doesNotMatch(ROBOTS, /www\.dslang\.in/);
});

/* ================================================================== *
 * sitemap.xml
 * ================================================================== */
test('SEO: the sitemap lists only the canonical public homepage', () => {
  const locs = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [SITE], 'only the canonical homepage is a valid standalone URL while the app uses hash routes');
  for (const loc of locs) {
    assert.match(loc, /^https:\/\/dslang\.in\//, 'sitemap URLs must use HTTPS on the apex domain');
    assert.doesNotMatch(loc, /[#?]/, 'fragments and query strings are not separate sitemap URLs');
    assert.doesNotMatch(loc, /www\./);
    assert.doesNotMatch(loc, /admin|account|checkout|payment|order-status|my-orders|track-order|cart|api/i);
  }
  assert.match(SITEMAP, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, 'the homepage entry needs a lastmod');
  assert.match(SITEMAP, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
});

/* ================================================================== *
 * The SPA rewrite must not swallow the SEO files or brand assets
 * ================================================================== */
test('SEO: the Vercel rewrite leaves static SEO files and brand assets alone', () => {
  const [rule] = VERCEL.rewrites ?? [];
  assert.ok(rule, 'vercel.json must define the SPA fallback');
  assert.equal(rule.destination, '/index.html');
  for (const excluded of ['assets/', 'api/', 'robots.txt', 'sitemap.xml', 'og-image', 'brand-logo', 'apple-touch-icon', 'favicon']) {
    assert.ok(rule.source.includes(excluded), `${excluded} must bypass the SPA rewrite`);
  }
});

/* ================================================================== *
 * Brand assets referenced by the metadata actually exist
 * ================================================================== */
test('SEO: the referenced brand assets exist at the sizes the metadata claims', () => {
  assert.deepEqual(
    { ...pngSize('public/og-image.png'), bytes: undefined },
    { width: 1200, height: 630, bytes: undefined },
  );
  assert.deepEqual(
    { ...pngSize('public/brand-logo.png'), bytes: undefined },
    { width: 512, height: 512, bytes: undefined },
  );
  assert.deepEqual(
    { ...pngSize('public/apple-touch-icon.png'), bytes: undefined },
    { width: 180, height: 180, bytes: undefined },
  );
  assert.deepEqual(
    { ...pngSize('public/favicon-48x48.png'), bytes: undefined },
    { width: 48, height: 48, bytes: undefined },
  );
  for (const rel of ['public/og-image.png', 'public/brand-logo.png', 'public/apple-touch-icon.png', 'public/favicon-48x48.png']) {
    assert.ok(pngSize(rel).bytes > 0);
  }
  assert.match(HTML, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
  assert.match(HTML, /<link rel="icon"[^>]+href="\/favicon\.png"/);
});
