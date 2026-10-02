/**
 * Hero loading contract.
 *
 * The homepage hero used to paint a large black block on a cold load: while the
 * `hero_slides` request was in flight it rendered a dark branded placeholder,
 * and once the slides arrived it sat on `bg-ink` until the photograph decoded.
 *
 * The loading state is now the hero's OWN dark DSLANG treatment — no blurred
 * preview, no LQIP, no skeleton, no spinner — and a black curtain above the
 * photograph fades out as the photograph fades in once it has decoded.
 *
 * This file locks the properties that make that work, so the fix cannot be
 * quietly undone by a later edit. It is deliberately offline and source-level:
 * `npm test` must not depend on the live database or the network.
 *
 * The pixel-level behaviour (no flash, no layout shift, a clean fade) is
 * verified in a real browser with the hero photographs throttled.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CSS = read('src/index.css');
const HOME = read('src/pages/HomePage.tsx');
const HTML = read('index.html');
const LQIP_LIB = read('src/lib/heroLqip.ts');
const LQIP_GENERATED = read('src/lib/heroLqip.generated.ts');
const GENERATOR = read('scripts/generate-hero-lqip.mjs');

/** The hero block in HomePage.tsx, from the section comment to the start of the
 *  product section. Keeps the assertions below from matching the "THE
 *  COLLECTION" grid code that follows the hero in the same file. */
const HERO = HOME.slice(HOME.indexOf('/* Hero'), HOME.indexOf('{/* ============ THE COLLECTION'));

/** Compiles a `export function name(url: string): string { ... }` out of a
 *  source file so the two copies of the lookup-key rule can be compared
 *  directly instead of being kept in sync by hand. */
function compileKeyFn(source, name) {
  const at = source.indexOf(`export function ${name}(`);
  assert.notEqual(at, -1, `${name} not found`);
  let i = source.indexOf('{', at);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  const body = source
    .slice(at, i + 1)
    .replace('export function', 'function')
    .replace(/\((\w+): string\)/g, '($1)')
    .replace(/\): string \{/g, ') {');
  return new Function(`${body}; return ${name};`)();
}

/* -------------------------------------------------------------------------- */
/* The previews themselves                                                     */
/* -------------------------------------------------------------------------- */

const ENTRIES = [...LQIP_GENERATED.matchAll(/"([^"]+)":\s*"(data:image\/[a-z+]+;base64,[^"]+)"/g)];

test('LQIP: there is a committed blurred preview for every hero photo', () => {
  assert.ok(ENTRIES.length > 0, 'heroLqip.generated.ts has no previews — re-run scripts/generate-hero-lqip.mjs');
});

test('LQIP: every preview is a self-contained image data URI', () => {
  for (const [, key, uri] of ENTRIES) {
    assert.match(uri, /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/, `${key} is not a valid image data URI`);
  }
});

test('LQIP: previews stay small enough to be free (a blur-up budget of 4 kB each)', () => {
  for (const [, key, uri] of ENTRIES) {
    const bytes = Math.round(((uri.length - uri.indexOf(',') - 1) * 3) / 4);
    assert.ok(bytes > 100, `${key} looks empty (${bytes} B)`);
    assert.ok(bytes < 4096, `${key} is ${bytes} B — too big to inline; lower LQIP_WIDTH/quality`);
  }
});

test('LQIP: previews are keyed by storage object filename, not by full URL', () => {
  for (const [, key] of ENTRIES) {
    assert.doesNotMatch(key, /^https?:/, `key ${key} is a URL — it would break if the bucket host changed`);
    assert.match(key, /\.[a-z0-9]+$/, `key ${key} has no file extension`);
  }
});

/* -------------------------------------------------------------------------- */
/* Pre-paint: the dark loading state is on screen before JavaScript even runs   */
/* -------------------------------------------------------------------------- */

test('PRE-PAINT: no blurred preview is inlined into index.html any more', () => {
  // The hero's loading state is its own dark treatment, not a preview of the
  // photograph, so there must be no preview data URI in the document at all.
  assert.doesNotMatch(
    HTML,
    /--hero-lqip\s*:\s*url\(\s*["']?data:/i,
    'a blurred preview is still inlined into index.html — the hero must not show one'
  );
  assert.doesNotMatch(HTML, /--hero-lqip\s*:\s*url\(\s*["']?https?:/i, '--hero-lqip must not reference a network image');
});

test('PRE-PAINT: no stylesheet or component paints a blurred preview', () => {
  // The preview visual is gone, so nothing may reference the custom property
  // that used to carry it, and no layer may take a preview from the runtime.
  assert.doesNotMatch(CSS, /--hero-lqip/, 'no stylesheet may paint --hero-lqip');
  assert.doesNotMatch(CSS, /--hero-slide-lqip/, 'no stylesheet may paint a per-slide preview');
  assert.doesNotMatch(HERO, /hero-slide-lqip/, 'the hero must not pass a preview to a slide layer');
  assert.doesNotMatch(HERO, /heroLqipFor\(/, 'the hero must not look up or paint a blurred preview');
  assert.doesNotMatch(HERO, /--hero-lqip/, 'the hero must not read an inlined preview');
});

test('PRE-PAINT: index.html still carries exactly one (inert) --hero-lqip declaration', () => {
  // Kept, because scripts/generate-hero-lqip.mjs rewrites between the markers
  // and throws if they are missing. The generator still owns
  // src/lib/heroLqip.generated.ts, so the markers have to stay.
  const declarations = HTML.match(/--hero-lqip\s*:/g) || [];
  assert.equal(declarations.length, 1, `expected one --hero-lqip declaration, found ${declarations.length}`);
  assert.match(
    HTML,
    /:root\{--hero-lqip:none;\}/,
    'the declaration must be inert (`none`) so no preview can be painted'
  );
  assert.ok(HTML.includes('/*HERO_LQIP_START*/') && HTML.includes('/*HERO_LQIP_END*/'), 'the generator markers must remain');
});

test('PRE-PAINT: the shell paints the dark loading treatment, not a preview', () => {
  const shell = /\.hero-shell\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(shell, 'index.css has no .hero-shell rule');
  const rule = shell[1];
  assert.match(rule, /background-color:\s*var\(--color-ink\)/, '.hero-shell must paint the dark loading treatment itself');
  // No image at all: no preview layer, no `cover` sizing for one.
  assert.doesNotMatch(rule, /var\(--hero-lqip/, '.hero-shell must not paint a preview');
});

/* -------------------------------------------------------------------------- */
/* The loading state is the dark treatment, fading into the photograph          */
/* -------------------------------------------------------------------------- */

test('LOADING STATE: a black curtain sits above the photographs and fades out', () => {
  assert.match(HERO, /className="hero-curtain/, 'the hero must render the black loading curtain');
  assert.match(HERO, /style=\{\{ opacity: showCurtain \? 1 : 0 \}\}/, 'the curtain must fade out (opacity 1 -> 0)');
  const curtain = /\.hero-curtain\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(curtain, 'index.css has no .hero-curtain rule');
  assert.match(curtain[1], /background-color:\s*var\(--color-ink\)/, 'the curtain must be the dark surface');
  assert.match(curtain[1], /transition:\s*opacity var\(--hero-reveal-ms/, 'the curtain must fade on the shared reveal duration');
});

test('LOADING STATE: the curtain is below the grain and the hero text', () => {
  // It dims the photograph while it fades, but must never dim or hide the
  // hero's own content, nor sit above the decorative grain.
  assert.match(HERO, /hero-curtain absolute inset-0 z-\[5\][^>]*pointer-events-none/, 'the curtain must be pointer-events-none');
  const at = HERO.indexOf('hero-curtain');
  const grain = HERO.indexOf('hero-grain');
  assert.ok(at > -1 && grain > at, 'the curtain must be painted before (beneath) the grain overlay');
});

test('LOADING STATE: the curtain lifts as soon as a photo is painting', () => {
  // Keyed on readiness of either the outgoing or the incoming photo, so the
  // black and the photograph dissolve at the same time instead of the black
  // holding still and then snapping away.
  assert.match(
    HOME,
    /\(revealedId && readyIds\.has\(revealedId\)\) \|\| \(frontId && readyIds\.has\(frontId\)\)/,
    'the curtain must lift as soon as a photograph is ready, whichever layer it is in'
  );
  assert.match(HOME, /const showCurtain = !heroIsEmptyState && !heroHasPhoto;/, 'the curtain must not cover the branded empty state');
});

test('LOADING STATE: the curtain is never a spinner, skeleton or blur', () => {
  const curtain = /\.hero-curtain\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(curtain);
  assert.doesNotMatch(curtain[1], /animation|blur|filter/, 'the loading state is a plain fade, not an animation or a blur');
  assert.doesNotMatch(HERO, /hero-curtain[^>]*backdrop-blur/, 'the loading state must not be a blur');
});

/* -------------------------------------------------------------------------- */
/* The hero is never a black block                                             */
/* -------------------------------------------------------------------------- */

test('NO BLACK BLOCK: the hero box is .hero-shell, not a bare bg-ink surface', () => {
  assert.match(HERO, /className="hero-shell/, 'the hero box must use .hero-shell so the inlined preview applies');
  assert.doesNotMatch(
    HERO,
    /\bbg-ink\b/,
    'nothing in the hero may paint a solid ink surface — the shell composes its own background'
  );
  assert.doesNotMatch(HERO, /style=\{\{[^}]*backgroundColor:\s*'#0a0a0a'/, 'the hero must not hard-code an ink background');
});

test('NO BLACK BLOCK: "request pending" is not the same state as "nothing to show"', () => {
  assert.match(
    HOME,
    /useState<HeroSlideRow\[\] \| null>\(null\)/,
    'the slides state must distinguish pending (null) from resolved-empty ([])'
  );
  assert.match(
    HERO,
    /slides !== null && usableSlides\.length === 0/,
    'the branded placeholder must only render once the request has resolved — while pending it is the old black block'
  );
});

test('NO BLACK BLOCK: an incoming layer is fully transparent over a painted photo', () => {
  // The incoming layer sits ABOVE the current photo. If it painted its preview
  // or its background colour, it would replace the photo with a blur (or with
  // near-black) the instant it mounted, which reads as a hard cut.
  assert.match(HERO, /hero-layer-clear/, 'the incoming layer must be able to drop its own background');
  const clear = /\.hero-layer-clear\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(clear, 'index.css has no .hero-layer-clear rule');
  assert.match(clear[1], /background-color:\s*transparent/, 'a transparent layer must not keep the near-black --color-ink');
  assert.match(clear[1], /background-image:\s*none/, 'a transparent layer must not keep the preview or the wash');
});

test('NO BLACK BLOCK: no spinner, skeleton or stock placeholder in the hero', () => {
  for (const forbidden of ['animate-spin', 'LoadingDots', 'dslang-loading-dot', 'animate-pulse', 'SkeletonBox']) {
    assert.ok(!HERO.includes(forbidden), `the hero must not add a ${forbidden} loader`);
  }
  assert.ok(!/hero-placeholder/.test(HOME), 'the hero must not use the orphaned /hero/hero-placeholder-*.svg mock-ups');
  assert.ok(
    !/https?:\/\/(images\.pexels|placehold|via\.placeholder|unsplash)/.test(HERO),
    'the hero must not fall back to an unrelated stock or placeholder photograph'
  );
});

/* -------------------------------------------------------------------------- */
/* Crossfade behaviour                                                         */
/* -------------------------------------------------------------------------- */

test('CROSSFADE: the carousel holds the current photo until the next one is ready', () => {
  // The incoming layer only becomes visible via `ready`, which is set from the
  // image's own load event — never from a timer.
  assert.match(HERO, /style=\{\{ opacity: ready \? 1 : 0 \}\}/, 'the hero image must be held at opacity 0 until it is ready');
  assert.match(HERO, /onLoad=\{\(\) => handleImageReady\(s\.id, s\.image_url\)\}/, 'readiness must come from the image load event');
  assert.match(HERO, /const ready = isMounted && readyIds\.has\(s\.id\)/, 'readiness must be scoped to the layer that is showing the photo');
  assert.match(
    HOME,
    /if \(!frontId \|\| !readyIds\.has\(frontId\)\) return;/,
    'a crossfade must not be promoted before its image has decoded'
  );
});

test('CROSSFADE: readiness is dropped with the src, so a re-shown slide fades in again', () => {
  // Keeping every <img> mounted (and only toggling src) is what stops a slide
  // that comes back around from painting at opacity 1 over a blank element.
  assert.match(HERO, /src=\{isMounted \? s\.image_url : undefined\}/, 'the <img> must persist and only its src be toggled');
  assert.match(HOME, /mountedIds/, 'a slide that stops being shown must give up its readiness flag');
});

test('CROSSFADE: the fade and the settling zoom share one duration', () => {
  assert.match(HOME, /'--hero-reveal-ms': `\$\{SLIDE_TRANSITION_MS\}ms`/, 'the reveal duration must come from SLIDE_TRANSITION_MS');
  assert.match(CSS, /\.hero-image\s*\{[^}]*transition:\s*opacity var\(--hero-reveal-ms/, '.hero-image must fade on the shared duration');
  assert.match(CSS, /\.hero-zoom\s*\{[^}]*animation:\s*heroZoom var\(--hero-reveal-ms/, 'the zoom must end exactly when the layer is promoted, or it snaps');
});

test('CROSSFADE: a failed image drops the slide and the carousel recovers', () => {
  assert.match(HERO, /onError=\{\(\) => handleImageError\(s\.id\)\}/);
  assert.match(HOME, /setFailedSlides\(/, 'a failed image must be removed from the rotation');
  assert.match(HOME, /!isUsable\(revealedId\)/, 'a failed slide must not be left on screen');
});

/* -------------------------------------------------------------------------- */
/* Stability and cost                                                          */
/* -------------------------------------------------------------------------- */

test('STABILITY: the hero box is sized by CSS alone, so loading cannot shift layout', () => {
  assert.match(HERO, /aspect-square md:aspect-auto md:h-\[78vh\] md:min-h-\[520px\]/);
  // No width/height attributes, no aspect ratio read from the image, no padding
  // hack keyed to a known image size.
  assert.doesNotMatch(HERO, /width=\{|height=\{|aspectRatio|pt-\[\d+px\]/, 'hero sizing must not depend on the image');
});

test('COST: the carousel is not prefetched wholesale', () => {
  assert.doesNotMatch(
    HERO,
    /preloadImages\(/,
    'preloading every slide downloads several photos before the shopper sees the first one'
  );
  assert.match(HOME, /preloadImage\(next\)/, 'only the next slide should be warmed');
});

test('COST: idle slides carry no src, so decoded photographs are not retained', () => {
  assert.match(HERO, /isMounted \? s\.image_url : undefined/);
  assert.doesNotMatch(HERO, /loading=\{[^}]*lazy[^}]*\}[^>]*\n[^>]*hero-image/, 'a hero image must not be lazily deferred while on screen');
});

test('RESERVED: the hero keeps its CTA and indicators, and has no corner brand mark', () => {
  for (const marker of ['Explore Now', 'Slide ${i + 1}', 'SWIPE_THRESHOLD_PX']) {
    assert.ok(HOME.includes(marker), `hero lost its "${marker}"`);
  }
  assert.match(HERO, /href=\{linkHref\('\/collections'\)\}/, 'the hero CTA must still go to the collection');
  assert.match(HERO, /hero-grain/, 'the editorial grain overlay must stay');

  // The top-left brand mark and tagline ("DSLANG" / "Slang of Design") were
  // removed from the hero on every breakpoint. Checked against the RENDERED
  // markup only: the words still legitimately appear in this file's comments and
  // elsewhere in the app (header, footer, page title), so the assertion is that
  // no hero element renders them.
  assert.doesNotMatch(HERO, />\s*DSLANG\s*</, 'the hero must not render a corner "DSLANG" wordmark');
  assert.doesNotMatch(HERO, /Slang of Design/, 'the hero must not render the "Slang of Design" tagline');
  assert.doesNotMatch(
    HERO,
    /top-3\.5 md:top-6 left-2 md:left-4/,
    'the hero must not keep the top-left corner container for the removed brand mark'
  );
});

/* -------------------------------------------------------------------------- */
/* The generator and the runtime must agree                                    */
/* -------------------------------------------------------------------------- */

test('GENERATOR: the runtime and the build script derive the same lookup key', () => {
  const runtimeKey = compileKeyFn(LQIP_LIB, 'heroLqipKey');
  const generatorKey = compileKeyFn(GENERATOR, 'lqipKey');
  const cases = [
    'https://fryxswzrpqujivtbguim.supabase.co/storage/v1/object/public/product-images/hero/abc-123.JPG',
    'https://fryxswzrpqujivtbguim.supabase.co/storage/v1/object/public/product-images/hero/abc-123.jpg?width=400',
    'https://fryxswzrpqujivtbguim.supabase.co/storage/v1/object/public/product-images/hero/a%20b.webp#frag',
    'https://other-host.example/hero/only-name.png',
    '',
    'not-a-url',
  ];
  for (const url of cases) {
    assert.equal(runtimeKey(url), generatorKey(url), `key mismatch for ${JSON.stringify(url)}`);
  }
  assert.equal(runtimeKey(cases[0]), 'abc-123.jpg');
  assert.equal(runtimeKey('nonsense'), 'nonsense');
});

test('GENERATOR: the preview geometry is documented in both places', () => {
  const genWidth = /const LQIP_WIDTH = (\d+)/.exec(GENERATOR);
  const libWidth = /const CAPTURE_WIDTH = (\d+)/.exec(LQIP_LIB);
  assert.ok(genWidth && libWidth);
  assert.equal(libWidth[1], genWidth[1], 'the runtime preview size must match the generator, or previews differ per source');
});
