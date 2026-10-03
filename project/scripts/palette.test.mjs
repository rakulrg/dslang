/**
 * Palette lock: the site's colour identity is black, white and crimson.
 *
 * Two experiments have been tried and reverted -- a gold accent for active and
 * "premium" states, and a Plum Smoke / Cocoa Earth warm-neutral pair. This file
 * exists so neither can quietly creep back in, and so the one deliberate
 * exception (neutral greys for text hierarchy) stays deliberate rather than
 * drifting.
 *
 * The distinction this file protects:
 *   - BRAND colour: crimson only, reserved for sale/discount messaging and for
 *     ERROR states. It is not an emphasis colour: red text must always be
 *     telling the reader something went wrong, never "this part is important".
 *   - NEUTRAL ramp: the black/white/grey tokens, for text hierarchy, hairlines
 *     and surfaces. Greys are not a fourth brand colour, but they must stay
 *     genuinely neutral -- a warm tint is how a "subtle" accent sneaks back in.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CSS = read('src/index.css');
const PRODUCT_CARD = read('src/components/ProductCard.tsx');
const PDP = read('src/pages/RetailProductPage.tsx');
const COLLECTION = read('src/pages/CollectionPage.tsx');
const CONTACT = read('src/pages/ContactPage.tsx');
const FOOTER = read('src/components/Footer.tsx');
const NAVBAR = read('src/components/Navbar.tsx');
const BUTTON = read('src/components/Button.tsx');
const LOGIN = read('src/components/LoginModal.tsx');
const SAVE_PROMPT = read('src/components/SaveDetailsPrompt.tsx');

/** Every .tsx/.ts/.css file under src/, so a stray utility cannot hide. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts|css)$/.test(entry)) out.push(full);
  }
  return out;
}
const SRC_FILES = walk(join(ROOT, 'src'));

const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Tokens that were tried and reverted. None of these may come back. */
const RETIRED = [
  'plum-smoke',
  'cocoa-earth',
  'accent-gold',
  'accent-gold-ink',
  'accent-gold-bright',
];
const RETIRED_HEX = [
  '918e8e', '3d2c2c', '9c7c1e', '8a6d12', 'c9a227',
];

const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** max-min channel spread: 0 for a pure neutral, high for a saturated hue. */
const chroma = (hex) => {
  const [r, g, b] = channels(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

const themeTokens = () =>
  [...CSS.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => ({
    name: m[1],
    hex: m[2].toLowerCase(),
  }));

test('RETIRED: the experimental colour tokens are gone from the theme', () => {
  const names = themeTokens().map((t) => t.name);
  for (const dead of RETIRED) {
    assert.ok(!names.includes(dead), `--color-${dead} is still defined`);
  }
  const hexes = themeTokens().map((t) => t.hex);
  for (const dead of RETIRED_HEX) {
    assert.ok(!hexes.includes(dead), `${dead} is still a theme token`);
  }
});

test('RETIRED: no experimental colour survives anywhere in src/', () => {
  const offenders = [];
  for (const file of SRC_FILES) {
    const body = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    for (const dead of RETIRED) {
      if (body.includes(dead)) offenders.push(`${rel}: ${dead}`);
    }
    for (const dead of RETIRED_HEX) {
      if (body.toLowerCase().includes(dead)) offenders.push(`${rel}: #${dead}`);
    }
  }
  assert.deepEqual(offenders, [], 'experimental colour references remain');
});

test('RETIRED: the reverted elements are back on their original colours', () => {
  // Each of these was changed by a colour experiment and has been restored.
  // Asserted individually so a future edit cannot quietly re-tint them.
  assert.match(
    COLLECTION,
    /filter === f\.value\s*\?\s*'bg-bone text-white border-bone'/,
    'the selected filter pill should be solid black again',
  );
  assert.match(
    PDP,
    /isSelected\s*\?\s*'border-bone bg-bone text-paper'/,
    'the selected size should be solid black again',
  );
  assert.match(PDP, /bg-paper-2 text-grey line-through/, 'out-of-stock stays grey');
  assert.match(FOOTER, /tracking-\[0\.22em\] text-white\/50/, 'footer eyebrow back to white/50');
  assert.match(
    FOOTER,
    /border-white\/20 text-white\/70 hover:border-white hover:text-white/,
    'footer social hovers back to white',
  );
  assert.match(NAVBAR, /tracking-\[0\.2em\] text-grey font-semibold/, 'drawer eyebrow back to grey');
  assert.match(NAVBAR, /isActive\(l\.to\) \? 'text-bone' :/, 'drawer active link back to black');
  assert.match(CONTACT, /tracking-wide-2 text-grey mb-2/, 'contact labels back to grey');
  assert.match(BUTTON, /ghost: 'border border-line text-bone-dim hover:border-bone/, 'ghost button back to black');
  for (const [name, src] of [['LoginModal.tsx', LOGIN], ['SaveDetailsPrompt.tsx', SAVE_PROMPT]]) {
    assert.ok(/hover:border-bone\/30/.test(src), `${name} hover border should be back to black/30`);
  }
  // Placeholders return to the exact grey each field used before. The PDP has
  // no text input, so these are asserted on the six files that do.
  for (const [name, src] of Object.entries({
    'CartDrawer.tsx': read('src/components/CartDrawer.tsx'),
    'LoginModal.tsx': LOGIN,
    'SearchDialog.tsx': read('src/components/SearchDialog.tsx'),
    'CheckoutPage.tsx': read('src/pages/CheckoutPage.tsx'),
    'OrderStatusPage.tsx': read('src/pages/OrderStatusPage.tsx'),
    'TrackOrderPage.tsx': read('src/pages/TrackOrderPage.tsx'),
  })) {
    assert.ok(
      !/placeholder:text-plum-smoke/.test(src),
      `${name} still has a plum smoke placeholder`,
    );
    assert.ok(/placeholder:text-grey/.test(src), `${name} placeholder should be grey again`);
  }
  // The active nav underline paints from currentColor again.
  const css = code(CSS);
  assert.ok(
    !/aria-current='page'::after\s*\{[^}]*background/.test(css),
    'the nav underline should no longer override its colour',
  );
});

test('IDENTITY: black, white and crimson are the palette', () => {
  const tokens = themeTokens();
  const byName = Object.fromEntries(tokens.map((t) => [t.name, t.hex]));
  assert.equal(byName.ink, '#0a0a0a', 'black');
  assert.equal(byName.paper, '#ffffff', 'white');
  assert.equal(byName['bone-dim'], '#4a4a4a');
  assert.equal(byName.bone, '#1a1a1a');
  // Crimson is the one and only brand hue.
  assert.equal(byName.crimson, '#d20a2e');
  const chromatic = tokens.filter((t) => chroma(t.hex) > 20);
  assert.deepEqual(
    chromatic.map((t) => t.name),
    ['crimson'],
    'crimson must be the only saturated colour in the theme',
  );
});

test('NEUTRALS: the grey ramp stays genuinely neutral', () => {
  // The surviving greys are text hierarchy and hairlines, not a brand colour.
  // This is the backstop against a SATURATED addition (the gold token scored
  // 126). It cannot catch a near-neutral warm tint on its own -- plum smoke was
  // only chroma 3 -- which is why the denylist above is the primary guard.
  // The cap is set by the warmest pre-existing token, --color-sand at 18.
  for (const t of themeTokens()) {
    if (t.name === 'crimson') continue;
    assert.ok(
      chroma(t.hex) <= 20,
      `--color-${t.name} (${t.hex}) is tinted; the neutral ramp must stay neutral`,
    );
  }
});

test('CRIMSON: the sale/discount and error signals are intact and unshared', () => {
  // The discount badge is the one crimson-filled element.
  assert.match(
    PRODUCT_CARD,
    /bg-crimson text-white[^']*uppercase font-bold[^']*Save \{discountPct\}%/,
  );
  // The struck-through MRP beside it stays neutral, so red never means two things.
  assert.match(PRODUCT_CARD, /font-price text-\[11px\] text-grey line-through/);
  // Crimson is not used for general emphasis anywhere it would dilute the sale.
  for (const [name, src] of [
    ['ContactPage.tsx', CONTACT],
    ['Footer.tsx', FOOTER],
    ['Navbar.tsx', NAVBAR],
  ]) {
    assert.ok(
      !/text-crimson/.test(src),
      `${name} uses crimson as a text colour; it is reserved for sale messaging`,
    );
  }

  // CollectionPage is the one exception, and only because a failed load has to
  // read as an ERROR rather than as another section heading. Crimson on an error
  // is the same signal it already carries in LoginModal and the admin panel, so
  // this is not red picking up a third meaning -- but emphasis is still banned,
  // so every occurrence is required to live inside the error branch. A blanket
  // `/text-crimson/` ban cannot tell the two apart, which is why the ban is
  // narrowed here instead of the error state being left grey.
  const errBranch = COLLECTION.match(/\{error && \([\s\S]*?\n {8}\)\}/);
  assert.ok(errBranch, 'CollectionPage error branch could not be located');
  const allCrimson = (COLLECTION.match(/text-crimson/g) ?? []).length;
  const branchCrimson = (errBranch[0].match(/text-crimson/g) ?? []).length;
  assert.ok(allCrimson > 0, 'the failed-collection state must be flagged in crimson');
  assert.equal(
    allCrimson,
    branchCrimson,
    'crimson text in CollectionPage may only appear inside the error state',
  );
});

test('HAIRLINES: structural borders never take a brand colour', () => {
  for (const [name, src] of [
    ['ProductCard.tsx', PRODUCT_CARD],
    ['CollectionPage.tsx', COLLECTION],
    ['ContactPage.tsx', CONTACT],
    ['Button.tsx', BUTTON],
  ]) {
    assert.ok(
      !/border-crimson/.test(src),
      `${name} must not use crimson for structural borders`,
    );
  }
  assert.match(CSS, /--color-line: #e5e3dd/);
  assert.match(CSS, /--color-line-2: #d6d4cc/);
});
