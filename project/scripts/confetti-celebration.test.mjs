/**
 * Order-success celebration regression tests.
 *
 * The burst and the mark are pure CSS, so there is no code path to execute —
 * there are only invariants that a later edit can silently break and that
 * nothing else in the repo would notice. They are asserted against the real
 * source files rather than restated, so changing the source fails here.
 *
 * The invariants are chosen from the two bugs this effect actually shipped with,
 * plus the failure modes that are easy to reintroduce:
 *
 *   * a NEGATIVE dx aimed pieces off the side of the screen, where the clipped
 *     wrapper swallowed them, so the burst looked thinner than the paper count
 *     suggested and no count-based test caught it;
 *   * leaving `left`/`right` as `auto` made right-hand pieces hang off-screen,
 *     so the two bursts were not mirror images even though they shared a table.
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

const COMPONENT = 'src/components/ConfettiBurst.tsx';
const CSS = 'src/index.css';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';

const component = read(COMPONENT);
const css = read(CSS);
const checkout = read(CHECKOUT);

/** The piece table, re-executed rather than described: this mirrors
 *  buildPieces() so the tests can check real numbers. Every tunable is READ BACK
 *  OUT of the component rather than restated here, so retuning the burst fails
 *  these assertions on purpose instead of leaving them checking a stale copy of
 *  a formula the component no longer uses. */
const TOTAL_MS = Number(component.match(/const TOTAL_MS = (\d+);/)?.[1]);
const MAX_REACH_VW = Number(component.match(/const MAX_REACH_VW = (\d+);/)?.[1]);
const PER_CANNON = Number(component.match(/const PER_CANNON = (\d+);/)?.[1]);
const MAX_STAGGER_MS = Number(component.match(/const MAX_STAGGER_MS = (\d+);/)?.[1]);
const MAX_HEIGHT_VH = Number(component.match(/const MAX_HEIGHT_VH = (\d+);/)?.[1]);
const MIN_HEIGHT_VH = Number(component.match(/const MIN_HEIGHT_VH = (\d+);/)?.[1]);
const SKY_CHANCE = Number(component.match(/const SKY_CHANCE = ([\d.]+);/)?.[1]);

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SEED = Number(component.match(/buildPieces\((\d+), PER_CANNON\)/)?.[1]);

function buildPieces(count) {
  const rand = makeRandom(SEED);
  const out = [];
  for (let i = 0; i < count; i++) {
    const spread = count === 1 ? 0 : i / (count - 1);
    const dx = 5 + (MAX_REACH_VW - 5) * spread + (rand() - 0.5) * 3;
    const sky = rand() < SKY_CHANCE;
    const apex = sky
      ? -(MIN_HEIGHT_VH + 6 + rand() * (MAX_HEIGHT_VH - MIN_HEIGHT_VH - 6))
      : -(MAX_HEIGHT_VH - (MAX_HEIGHT_VH - MIN_HEIGHT_VH) * spread);
    const delay = Math.round(rand() * MAX_STAGGER_MS);
    const drift = 0.26 + rand() * 0.38;
    const rotation = Math.round((rand() * 2 - 1) * (360 + rand() * 900));
    out.push([+dx.toFixed(2), +apex.toFixed(1), +drift.toFixed(2), rotation, TOTAL_MS - delay, delay]);
  }
  return out;
}

test('the generator constants are all present and sane', () => {
  // A regex that stops matching yields NaN, and NaN silently satisfies most
  // comparisons below, so the readings are asserted explicitly.
  for (const [name, v] of Object.entries({ TOTAL_MS, MAX_REACH_VW, PER_CANNON, MAX_STAGGER_MS, MAX_HEIGHT_VH, MIN_HEIGHT_VH, SKY_CHANCE, SEED })) {
    assert.ok(Number.isFinite(v), `${name} must be readable from ConfettiBurst.tsx, got ${v}`);
  }
  assert.ok(MAX_HEIGHT_VH <= 96, 'the tallest piece must stay clear of the top edge, or it gets clipped');
  assert.ok(MIN_HEIGHT_VH >= 30, 'the shallowest piece must still climb, or the middle of a wide screen gets paper at knee height');
});

test('every piece ends at exactly the 3s mark', () => {
  for (const [, , , , dur, delay] of buildPieces(PER_CANNON)) {
    assert.equal(dur + delay, TOTAL_MS, 'duration + delay must sum to the celebration length');
  }
});

test('every piece reaches the screen edge and stays inside it', () => {
  for (const [dx, apex] of buildPieces(PER_CANNON)) {
    // The regression that shipped: a negative dx is off-screen on launch and the
    // clipped wrapper deletes it silently.
    assert.ok(dx > 0, `dx must be inward and positive, got ${dx}`);
    assert.ok(dx <= MAX_REACH_VW + 1.5, `dx must not exceed the cone, got ${dx}`);
    // Upward is negative; must clear the top edge before fading, and must not be
    // so shallow that the burst reads as a floor-level splash.
    assert.ok(apex < 0, `apex must be upward, got ${apex}`);
    assert.ok(apex >= -100, `apex must not be clipped at the top, got ${apex}`);
    assert.ok(apex <= -25, `apex must reach the upper viewport, got ${apex}`);
  }
});

test('the two cones meet across the middle instead of leaving a dead band', () => {
  // Capping reach below 50vw leaves the centre of the screen bare at desktop
  // widths, which is the most visible way to under-fill the viewport.
  assert.ok(MAX_REACH_VW > 50, `cones must cross the midline, got ${MAX_REACH_VW}vw`);
});

test('a meaningful share of pieces populates the upper band', () => {
  const pieces = buildPieces(PER_CANNON);
  const high = pieces.filter(([, apex]) => apex <= -68);
  assert.ok(
    high.length >= Math.floor(PER_CANNON * 0.25),
    `expected the upper band to be populated, only ${high.length}/${PER_CANNON} pieces reach above -68vh`,
  );
});

test('the piece count is dense enough to read as a burst at desktop width', () => {
  assert.ok(PER_CANNON * 2 >= 80, `expected at least 80 pieces total, got ${PER_CANNON * 2}`);
});

test('the burst is one shot: no loop and no JS timers', () => {
  // Scoped to the .confetti rule, not the whole stylesheet: marquee, loading
  // pulse and the card shine are SUPPOSED to loop. Only the burst must not.
  const rule = css.match(/\.confetti \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(rule, /animation:\s*confetti-corner-pop var\(--dur\) linear both;/);
  assert.ok(!/infinite/.test(rule), 'the burst must not loop');
  assert.match(rule, /animation-delay:\s*var\(--delay\);/);
  // Comments are stripped first: the component's own docblock NAMES these
  // functions to explain why it does not use them, so a raw text scan would
  // fail on the very documentation that proves the point.
  const code = component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'useEffect', 'useState']) {
    assert.ok(!new RegExp(bad).test(code), `confetti must not use ${bad}; the burst is declarative CSS`);
  }
});

test('the celebration layer is fixed to the viewport and cannot eat clicks or scroll', () => {
  const wrap = css.match(/\.confetti-wrap \{([\s\S]*?)\}/)?.[1] ?? '';
  assert.match(wrap, /position:\s*fixed/);
  assert.match(wrap, /inset:\s*0/);
  assert.match(wrap, /pointer-events:\s*none/);
  assert.match(wrap, /overflow:\s*hidden/);
});

test('both cannons pin their pieces to the correct inner edge', () => {
  // With left/right as auto, a right-hand piece falls back to the static
  // position inside a zero-width box and hangs off-screen.
  assert.match(css, /\.confetti-cannon--left \.confetti \{ left: 0; \}/);
  assert.match(css, /\.confetti-cannon--right \.confetti \{ right: 0; \}/);
});

test('the right cannon mirrors the left through --dir', () => {
  assert.match(css, /\.confetti-cannon--left \{[\s\S]*?--dir:\s*1;/);
  assert.match(css, /\.confetti-cannon--right \{[\s\S]*?--dir:\s*-1;/);
});

test('both cannons render the same shared trajectory table', () => {
  assert.match(component, /const PIECES = buildPieces\(\d+, PER_CANNON\);/);
  assert.equal((component.match(/\{PIECES\.map\(/g) ?? []).length, 1, 'one table, rendered by two emitters');
  assert.match(component, /<Burst side="left" \/>/);
  assert.match(component, /<Burst side="right" \/>/);
});

test('the celebration is mounted exactly once per confirmation', () => {
  assert.equal((checkout.match(/<ConfettiBurst \/>/g) ?? []).length, 1);
});

test('the keyframe timeline matches the requested 0.4 / 2.3 / 3.0s phases', () => {
  const frames = [...css.matchAll(/@keyframes confetti-corner-pop \{([\s\S]*?)\n\}/g)][0]?.[1] ?? '';
  const stops = [...frames.matchAll(/^\s*([\d.]+)% \{/gm)].map((m) => Number(m[1]));
  assert.equal(stops.length, 4, 'expected exactly the four phase stops');
  // Asserted as ELAPSED TIME against the real duration constant, so shortening
  // the celebration cannot silently retune the phases, and so the stops cannot
  // be nudged to prettier-looking round percentages that mean the wrong moment.
  assert.ok(Math.abs((stops[1] / 100) * TOTAL_MS - 400) <= 1, `pop ends at ${((stops[1] / 100) * TOTAL_MS).toFixed(0)}ms, want 400ms`);
  assert.ok(Math.abs((stops[2] / 100) * TOTAL_MS - 2300) <= 1, `spread ends at ${((stops[2] / 100) * TOTAL_MS).toFixed(0)}ms, want 2300ms`);
  assert.equal(stops[0], 0);
  assert.equal(stops[3], 100);
  // Each stop must declare the easing for the phase it ENDS, or the next phase
  // inherits `linear` and the burst stops reading as a pop.
  assert.equal((frames.match(/animation-timing-function:/g) ?? []).length, 3);
});

test('the burst crosses the midline at its widest, not only at the very end', () => {
  // The regression: the apex keyframe used to travel 0.82 of --dx, so the widest
  // the burst ever got was short of the middle and the two cones left a ~75px
  // dead band down the centre of a 1280px screen. The apex frame is the widest
  // the burst gets, so that is where the crossing has to happen.
  const factor = Number(css.match(/76\.67% \{[\s\S]*?var\(--dx\) \* var\(--dir\) \* ([\d.]+)\)/)?.[1]);
  assert.ok(Number.isFinite(factor), 'must read the horizontal factor off the apex keyframe');
  assert.ok(
    factor * MAX_REACH_VW > 50,
    `at the apex the widest piece reaches only ${(factor * MAX_REACH_VW).toFixed(1)}vw; the cones must pass 50vw`,
  );
  // ...but it must not have completed the whole travel either, or the last
  // quarter second would be a separate inward slide rather than a fade.
  assert.ok(factor < 1, `apex reaches ${factor} of the travel; the fade must still carry the last ${((1 - factor) * 100).toFixed(0)}%`);
});

test('the burst fades out rather than cutting off', () => {
  const frames = [...css.matchAll(/@keyframes confetti-corner-pop \{([\s\S]*?)\n\}/g)][0]?.[1] ?? '';
  const opacities = [...frames.matchAll(/opacity:\s*([\d.]+);/g)].map((m) => Number(m[1]));
  assert.deepEqual(opacities, [0, 1, 1, 0], 'opacity must be 0 -> 1 -> 1 -> 0');
});

test('reduced motion removes the burst and keeps the mark legible', () => {
  const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n');
  assert.match(reduce, /\.confetti \{[^}]*animation:\s*none !important;[^}]*opacity:\s*0 !important;/);
  // Killing the badge animation leaves the declared start state, which would
  // otherwise render an invisible check inside a shrunken disc.
  assert.match(reduce, /\.order-placed-badge__disc \{[^}]*transform:\s*none !important;/);
  assert.match(reduce, /\.order-placed-badge__check path \{[^}]*stroke-dashoffset:\s*0 !important;/);
});

test('the celebration palette is the five-colour set, with no dark particles', () => {
  const stock = [...component.matchAll(/fill: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]);
  const unique = [...new Set(stock)].map((h) => h.toLowerCase());
  assert.deepEqual(unique.sort(), ['#57c4dc', '#8ac63c', '#d20a2e', '#f2b417', '#fff6e6'].sort());

  // Nothing dark: a near-black chip over the dark page reads as dirt, not as
  // celebration. Checked as perceived luminance rather than a hex blocklist,
  // but the bar is set for the DARKEST brand colour (crimson, ~55) rather than
  // for ivory, because DSLANG red is the one colour the brief fixes by name. A
  // particle darker than the brand red would be a new colour nobody asked for.
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const hex of unique) {
    assert.ok(luminance(hex) > 50, `${hex} (luminance ${luminance(hex).toFixed(0)}) is too dark to read as celebration paper`);
  }
  // Nothing achromatic either: a grey or black particle reads as a rendering
  // artefact rather than paper, whatever its luminance.
  for (const hex of unique) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread >= 20, `${hex} is grey/near-black, not celebration paper`);
  }
});

test('the brand colour leads and the accents stay rare', () => {
  const stock = [...component.matchAll(/fill: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1].toLowerCase());
  const count = (hex) => stock.filter((h) => h === hex).length;
  const crimson = count('#d20a2e');
  const lime = count('#8ac63c');
  const cyan = count('#57c4dc');
  assert.ok(crimson > lime, 'crimson must outweigh each accent');
  assert.ok(crimson > cyan, 'crimson must outweigh each accent');
  assert.ok(lime <= stock.length / 8 + 1 && cyan <= stock.length / 8 + 1, 'accents must stay at roughly one piece in eight');
});

test('no confetti colour is defined as a theme token', () => {
  // The theme is black / white / crimson; a one-shot flourish must not be able to
  // move that. Crimson is exempt because it is ALREADY a theme token
  // (--color-crimson) and reusing that exact value is correct — what must not
  // happen is the celebration INTRODUCING new tokens. So the real invariant is
  // that the four non-brand colours are absent from the token namespace.
  const themeTokens = [...css.matchAll(/--color-[a-z0-9-]+:\s*(#[0-9A-Fa-f]{3,8})/gi)].map((m) => m[1].toLowerCase());
  const stock = [...component.matchAll(/fill: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1].toLowerCase());
  for (const hex of new Set(stock)) {
    if (hex === '#d20a2e') continue;
    assert.ok(!themeTokens.includes(hex), `${hex} must not become a --color- token`);
  }
  // And nothing in the celebration may redefine the brand token itself.
  assert.ok(
    !component.includes('--color-crimson'),
    'the component must consume the brand colour as a literal, not redefine the token',
  );
});

test('the mark is a DSLANG red disc with a white check, drawn not borrowed', () => {
  assert.match(checkout, /className="order-placed-badge"/);
  assert.match(checkout, /className="order-placed-badge__disc"/);
  assert.match(checkout, /className="order-placed-badge__check"/);
  assert.match(checkout, /<path d="M20 6\.5 9\.2 17\.3 4 12\.1" \/>/);
  // The success mark must not reuse the outlined bone icon any more.
  const success = checkout.slice(checkout.indexOf('<ConfettiBurst />'), checkout.indexOf('Order Confirmed'));
  assert.ok(!/CheckCircle2/.test(success), 'the order-placed mark must be the animated badge, not the outlined icon');
});

test('the badge keeps the old icon box so the confirmation cannot shift', () => {
  const badge = css.match(/\.order-placed-badge \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(badge, /height:\s*3\.5rem/);
  assert.match(badge, /width:\s*3\.5rem/);
  assert.match(badge, /display:\s*inline-flex/);
  assert.match(badge, /align-items:\s*center/);
  assert.match(badge, /justify-content:\s*center/);
  // The disc, not the wrapper, carries the round shape: it is absolutely
  // positioned over the same box, so the two must be the same size or the circle
  // would not be centred.
  const disc = css.match(/\.order-placed-badge__disc \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(disc, /border-radius:\s*9999px/);
  assert.match(disc, /inset:\s*0/);
  assert.match(disc, /background:\s*#d20a2e;/i);
  assert.match(css, /\.order-placed-badge__check path \{[^}]*stroke:\s*#ffffff;/i);
});

test('the badge stays legible above the confetti but below interactive chrome', () => {
  const badge = css.match(/\.order-placed-badge \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const z = Number(badge.match(/z-index:\s*(\d+);/)?.[1]);
  assert.ok(z > 50, 'paper must not be able to cover the check');
  assert.ok(z < 60, 'the badge must stay below the drawer');
});

test('the check dash length fully clears the path', () => {
  const dasharray = Number(css.match(/stroke-dasharray:\s*([\d.]+);/)?.[1]);
  // The path is ~23 long; a dasharray below the true length would leave a stub.
  assert.ok(dasharray > 23, `dasharray ${dasharray} must exceed the path length`);
  const dashoffset = Number(css.match(/stroke-dashoffset:\s*([\d.]+);/)?.[1]);
  assert.equal(dashoffset, dasharray, 'the check must start fully hidden');
});

test('the badge settles rather than bouncing', () => {
  const frames = css.match(/@keyframes order-badge-pop \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const scales = [...frames.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(scales, [0.72, 1.12, 0.985, 1], 'one overshoot, one settle, then still');
  const overshoots = scales.filter((s) => s > 1).length;
  assert.equal(overshoots, 1, 'a spring reads as cartoon next to a restrained celebration');
});

test('the check is decorative, so it is hidden from assistive tech', () => {
  const mark = checkout.slice(checkout.indexOf('order-placed-badge__check'), checkout.indexOf('Order Confirmed'));
  assert.match(mark, /aria-hidden="true"/);
  assert.match(mark, /focusable="false"/);
});
