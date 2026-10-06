/**
 * Storefront regression tests for the UI/UX audit items.
 *
 * These assert the fixes as CONTRACTS against the real source, because they are
 * properties of React components that need a browser to execute. The behavioural
 * parts that CAN run headlessly (the hash-router query helpers the PDP depends
 * on) are covered for real in `router-variant.test.mjs`.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const PDP = read('src/pages/RetailProductPage.tsx');
const ROUTER = read('src/lib/router.ts');
const APP = read('src/App.tsx');
const HOME = read('src/pages/HomePage.tsx');
const COLLECTION = read('src/pages/CollectionPage.tsx');
const CONTACT = read('src/pages/ContactPage.tsx');
const HTML = read('index.html');
const CSS = read('src/index.css');
const SEARCH = read('src/components/SearchDialog.tsx');
const CHECKOUT = read('src/pages/CheckoutPage.tsx');
const STATUS = read('src/pages/OrderStatusPage.tsx');
const TRACK = read('src/pages/TrackOrderPage.tsx');
// The variant-image resolver is app-wide, not Track Order's: every surface that
// renders an order line (Track Order, My Orders, Order Status, the confirmation
// page and Admin) goes through this one module so a thumbnail is identical
// everywhere. Asserted here in its real home.
const ORDER_IMAGES = read('src/lib/orderImages.ts');
const NAVBAR = read('src/components/Navbar.tsx');
const FOOTER = read('src/components/Footer.tsx');

/** Source with comments removed, so a contract assertion can never be satisfied
 *  (or broken) by prose in a doc block. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ================================================================== *
 * PDP deep links
 * ================================================================== */
test('PDP: the selected colour and size are written to the URL', () => {
  assert.match(PDP, /const COLOR_PARAM = 'color'/);
  assert.match(PDP, /const SIZE_PARAM = 'size'/);
  // Both user actions that can change the selection must sync it.
  assert.match(PDP, /const selectSize = \(label: string\) => \{[\s\S]{0,200}syncVariantToUrl\(/);
  assert.match(PDP, /const selectColor = \(i: number\) => \{[\s\S]{0,400}syncVariantToUrl\(/);
  // ...and so must the initial render, so a reload normalises the address bar.
  assert.match(PDP, /const resolved = resolveVariantFromUrl\(p\);[\s\S]{0,300}syncVariantToUrl\(/);
});

test('PDP: a reload / shared link restores the selection from the URL', () => {
  assert.match(PDP, /function resolveVariantFromUrl\(product: CatalogProduct\)/);
  assert.match(PDP, /readHashQuery\(\)/);
  // Matched case- and whitespace-insensitively so ?color=Black and ?color=black
  // are the same link.
  assert.match(PDP, /c\.name\.trim\(\)\.toLowerCase\(\) === wantColor\.toLowerCase\(\)/);
  assert.match(PDP, /s\.size_label\.trim\(\)\.toLowerCase\(\) === wantSize\.toLowerCase\(\)/);
});

test('PDP: a same-path URL edit re-resolves the variant without a remount', () => {
  // Routing keys the page on the path, so a hash edit that keeps the same
  // product (pasting a shared link into the address bar, Back/Forward between
  // variants) never remounts it. The page has to listen for that itself.
  assert.match(PDP, /addEventListener\('hashchange', onHashChange\)/);
  assert.match(PDP, /removeEventListener\('hashchange', onHashChange\)/);
  // It must re-resolve rather than read stale state, and it must apply both
  // halves of the selection.
  assert.match(PDP, /const onHashChange = \(\) => \{[\s\S]{0,400}resolveVariantFromUrl\(p\)/);
  assert.match(PDP, /onHashChange[\s\S]{0,400}setColorIdx\(resolved\.colorIdx\);[\s\S]{0,80}setSize\(resolved\.size\)/);
  // Critically: the outgoing page's listener still fires after navigating away.
  // Without this guard it would rewrite the query of the page just requested.
  assert.match(PDP, /if \(currentPath\(\) !== `\/product\/\$\{slug\}`\) return;/);
  // ...and because the writes use replaceState, our own URL updates can never
  // loop back through this handler.
  assert.match(ROUTER, /replaceState/);
  assert.equal(/hash\s*=/.test(/function replaceHashQuery[\s\S]*?\n}/.exec(ROUTER)?.[0] ?? ''), false,
    'replaceHashQuery must not assign location.hash (that would fire hashchange)');
});

test('PDP: the URL carries the human colour name, never an internal id', () => {
  assert.match(PDP, /\[COLOR_PARAM\]: colorName\.trim\(\) \|\| null/);
  assert.match(PDP, /syncVariantToUrl\(color\.name, label\)/);
  assert.match(PDP, /syncVariantToUrl\(product\.colors\[i\]\.name, nextSize\)/);
  // Nothing may serialize a colour id into the address bar.
  assert.equal(
    /syncVariantToUrl\([^)]*colors\[[^\]]*\]\.id/.test(PDP),
    false,
    'a product_colors.id must never reach the URL',
  );
  assert.equal(/replaceHashQuery\(\{[^}]*\.id/.test(PDP), false);
});

test('PDP: an invalid colour or size degrades to a valid default', () => {
  // Unknown colour -> the normal auto-selected default, and the bad key removed.
  assert.match(PDP, /if \(colorIdx === -1\) \{[\s\S]{0,200}return \{ \.\.\.fallback, corrected: true \};/);
  // Known colour, unknown/absent size -> that colour's first in-stock size.
  assert.match(PDP, /return \{ colorIdx, size: defaultSizeForColor\(product, product\.colors\[colorIdx\]\.id\), corrected: true \};/);
  // A product with no stock rows at all still gets a usable selection.
  assert.match(PDP, /return \{ colorIdx: 0, size: '' \};/);
});

test('PDP: the share link is built from the CURRENT variant, not from stale state', () => {
  assert.match(
    PDP,
    /const variantQuery = `[\s\S]{0,20}\$\{COLOR_PARAM\}=\$\{encodeURIComponent\(color\.name\)\}&\$\{SIZE_PARAM\}=\$\{encodeURIComponent\(size\)\}`/,
  );
  assert.match(PDP, /productShareUrl = typeof window !== 'undefined'[\s\S]{0,200}variantQuery/);
  assert.match(PDP, /navigator\.share\(\{ title: product\.name, text: product\.name, url: productShareUrl \}\)/);
});

test('PDP: changing a colour resets the size to one that exists in it', () => {
  assert.match(PDP, /const sizes = getSizesForColor\(product, product\.colors\[i\]\.id\);[\s\S]{0,220}setSize\(nextSize\)/);
  assert.match(PDP, /setQty\(1\);/);
});

/* ================================================================== *
 * The purchase bar was removed: one add path, no reserved strip.
 * ================================================================== */
test('PRODUCT: the fixed mobile purchase bar is gone, with no replacement', () => {
  // No second Add to Bag surface on any breakpoint.
  assert.doesNotMatch(PDP, /MOBILE-ONLY STICKY PURCHASE BAR/);
  assert.doesNotMatch(PDP, /lg:hidden fixed inset-x-0 bottom-0/);
  assert.doesNotMatch(PDP, /bottom-0 z-40 border-t border-line bg-white\/95/);
  // The safe-area reservation that only existed for that bar is gone with it.
  assert.doesNotMatch(PDP, /calc\(env\(safe-area-inset-bottom, 0px\) \+ 0\.75rem\)/);
});

test('PRODUCT: the in-page Add to Bag survives and stays the single call site', () => {
  // The bar shared this handler; with it gone there must be exactly one.
  assert.match(PDP, /onClick=\{handleAddToCart\}/);
  assert.equal(
    (PDP.match(/onClick=\{handleAddToCart\}/g) ?? []).length,
    1,
    'exactly one add call site: the in-page button',
  );
  // The stock guard and the added-feedback label are unchanged.
  assert.match(PDP, /aria-disabled=\{!stockAvailable\}/);
  assert.match(PDP, /\{stockAvailable \? \(addedFeedback \? 'Added to Bag' : 'Add to Bag'\) : 'OUT OF STOCK'\}/);
});

test('PRODUCT: no bottom space is reserved for a bar that no longer exists', () => {
  // The page ROOT: the shell wrapper whose bottom padding is the page's own.
  // (Line 237 above the product grid is a different shell — the breadcrumbs —
  // and legitimately keeps its own `md:pb-16`.)
  // The padding is conditional: when the "You Might Also Like" section renders it
  // carries its own py-12 md:py-16, so the wrapper adds none and the seam is not
  // padded twice. This test pins the no-Related branch, which is what pads the
  // page before the footer.
  const root = /related\.length > 0 \? '([^']*)' : 'shell pt-0 pb-(\d+)(?: md:pt-0)?'/.exec(PDP);
  assert.ok(root, 'product page root wrapper not found');
  const px = Number(root[2]) * 4;
  // The no-Related branch carries no bottom padding of its own to double up.
  assert.doesNotMatch(root[1], /\bpb-/, 'the related branch must not pad the seam twice');
  // It is the page's natural padding at EVERY width — no `md:`/`lg:` variant,
  // because there is nothing left to reserve space for.
  assert.equal(
    /className="shell pt-0 pb-\d+ (?:md|lg):pb-/.test(PDP),
    false,
    'a breakpoint still overrides the page bottom padding (bar reservation left behind)',
  );
  assert.equal(px, 64, `expected pb-16 (64px), got ${px}px`);
  // The 96px mobile reservation for the bar is gone for good.
  assert.doesNotMatch(PDP, /\bpb-24\b/, 'the old mobile-only bar reservation is still present');
});

/* ================================================================== *
 * One canonical collection URL
 * ================================================================== */
test('ROUTES: /collections is the canonical shop route', () => {
  assert.match(APP, /segments\[0\] === 'collections'/);
  // The legacy URLs still render the page, then rewrite in place.
  assert.match(APP, /segments\[0\] === 'collection' \|\| segments\[0\] === 'shop'/);
  // ...and /new-drops is canonicalized onto it too, so no legacy URL renders a
  // second shop page of its own.
  assert.match(APP, /segments\[0\] === 'new-drops'\) \{\s*replaceRoute\('\/collections'\)/);
  assert.match(APP, /replaceRoute\('\/collections'\)/);
  assert.match(NAVBAR, /label: 'Collection', to: '\/collections'/);
  assert.match(FOOTER, /label: 'Collection', to: '\/collections'/);
  assert.equal(/to: '\/collection'/.test(NAVBAR + FOOTER), false, 'no link may still point at /collection');
});

/* ===========================================================================
 * Authenticated drawer hierarchy
 * ======================================================================== */

test('NAV: the drawer has one customer entry, MY ACCOUNT, not a top-level My Orders', () => {
  // Orders and log out live INSIDE My Account, so the drawer keeps a single
  // customer entry point. A top-level "My Orders" item is what this replaces.
  assert.match(NAVBAR, /My Account/);
  assert.match(NAVBAR, /navigate\('\/account'\)/);
  // The drawer must not navigate straight to /my-orders any more.
  assert.doesNotMatch(NAVBAR, /navigate\('\/my-orders'\)/);
  // The top-level links are unchanged, minus New Drops (see the single-
  // destination contract below).
  for (const label of ['Collection', 'Track Order', 'About']) {
    assert.match(NAVBAR, new RegExp(`label: '${label}'`));
  }
  assert.match(NAVBAR, /linkHref\('\/contact'\)/);
});

test('NAV: the ACCOUNT group and ADMIN PANEL stay gated on the real admin check', () => {
  assert.match(NAVBAR, /const showAdminPanel = !!user && !isAdminLoading && isAdmin;/);
  assert.match(NAVBAR, /\{user \? \(/);
  // Signed-out keeps the bare LOGIN affordance and no account heading.
  assert.match(NAVBAR, /onOpenLogin\('signin'\)/);
  // Admin Panel only renders behind that gate.
  const panel = NAVBAR.slice(NAVBAR.indexOf('showAdminPanel &&'));
  assert.match(panel, /navigate\('\/admin'\)/);
});

test('ACCOUNT: /account exposes customer identity, Orders and Log Out', () => {
  const DASH = read('src/pages/SubscriberDashboard.tsx');
  // Customer identity comes from the existing Supabase session only.
  assert.match(DASH, /const \{ user, signOut \} = useAuth\(\)/);
  assert.match(DASH, /Customer ID/);
  assert.match(DASH, /\{user\?\.id\}/);
  // Orders reuse the existing MyOrdersPage via the nested route.
  assert.match(DASH, /linkHref\('\/account\/orders'\)/);
  assert.match(APP, /segments\[1\] === 'orders'/);
  // Log out reuses the context sign-out, not the raw client.
  assert.match(DASH, /onClick=\{handleLogout\}/);
  assert.match(DASH, /await signOut\(\)/);
  // No live call to the raw client — only the explanatory comment may name it.
  const dashCode = DASH.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(dashCode, /supabase\.auth\.signOut\(\)/);
});

test('ACCOUNT: the legacy /my-orders route still resolves', () => {
  // Removed from the NAV, kept as a route so existing links/bookmarks work.
  assert.match(APP, /segments\[0\] === 'my-orders'\) return <MyOrdersPage \/>/);
});

test('ROUTES: the legacy redirect replaces the history entry, so Back cannot loop', () => {
  assert.match(ROUTER, /export function replaceRoute\(to: string\): void/);
  assert.match(ROUTER, /window\.location\.replace\(next\)/);
  assert.match(APP, /replaceRoute\('\/collections'\)/);
  assert.match(APP, /import \{ useRouter, replaceRoute \} from '@\/lib\/router'/);
  // Guarded so an already-canonical URL is never rewritten onto itself.
  assert.match(ROUTER, /if \(window\.location\.hash === next\) return;/);
});

test('ROUTES: the page title is right on the canonical URL too', () => {
  assert.match(APP, /path\.startsWith\('\/collections'\)/);
});

/* ================================================================== *
 * One Collection destination
 *
 * The catalogue is a small T-shirt range, so "New Drops" and "New Arrivals" were
 * two more names for the same clothes. These lock in that Collection is the only
 * way in, that the homepage no longer competes with it, and that no leftover
 * drop/arrival presentation survives anywhere a shopper can see it.
 * ================================================================== */
test('NAV + FOOTER: New Drops is not a destination anywhere', () => {
  // Header (desktop row AND the mobile drawer share one NAV_LINKS array, so this
  // covers both) and the footer.
  assert.doesNotMatch(code(NAVBAR), /New Drops/i, 'the header/mobile menu must not offer New Drops');
  assert.doesNotMatch(code(FOOTER), /New Drops/i, 'the footer must not offer New Drops');
  // No link anywhere may still point at the retired route.
  assert.equal(/'\/new-drops'/.test(NAVBAR + FOOTER), false, 'no nav/footer link may target /new-drops');
  // ...and no `<a href>` in either file hardcodes it either.
  assert.equal(/new-drops/.test(code(NAVBAR) + code(FOOTER)), false,
    'no nav/footer CODE may reference /new-drops (comments excluded)');
});

test('ROUTES: the New Drops page is retired, and its URL still resolves', () => {
  // The page file itself is gone, so no second shop page can ever render.
  assert.equal(
    existsSync(join(ROOT, 'src/pages/NewDropsPage.tsx')),
    false,
    'NewDropsPage.tsx must be deleted',
  );
  assert.doesNotMatch(APP, /NewDropsPage/);
  // The URL is not a 404: it renders Collection for the frame before redirecting.
  assert.match(APP, /segments\[0\] === 'new-drops'\) return <CollectionPage \/>/);
  // ...and no "New Drops" page title is left behind.
  assert.doesNotMatch(code(APP), /New Drops/);
  // The title on the legacy URL is the collection title, even pre-redirect.
  assert.match(APP, /path\.startsWith\('\/new-drops'\)/);
});

test('HOME: the hero is intact and the page adds exactly ONE product section', () => {
  const home = code(HOME);
  // The hero's loading/fade implementation is untouched: readiness-gated
  // crossfade, the black curtain, and the CTA into the collection.
  assert.match(home, /const showCurtain = !heroIsEmptyState && !heroHasPhoto;/);
  assert.match(home, /hero-curtain/);
  assert.match(home, /const heroHasPhoto = Boolean\(/);
  assert.match(home, /Explore Now/);
  assert.match(home, /href=\{linkHref\('\/collections'\)\}/);
  // The restored section: one grid, one heading, one way onward.
  assert.equal(
    (home.match(/<ProductCard\b/g) ?? []).length,
    1,
    'exactly one product grid on the homepage - no duplicate product section',
  );
  assert.equal(
    (home.match(/grid-cols-2 md:grid-cols-4/g) ?? []).length,
    1,
    'exactly one product grid layout',
  );
  assert.match(home, />\s*THE COLLECTION\s*</, 'the section heading must be THE COLLECTION');
  assert.match(home, /View All →/);
  // ...and it is a real grid of the current collection, not a stub.
  assert.match(home, /\{collection\.map\(\(p, i\) => \(/);
  assert.match(home, /<ProductCard key=\{p\.id\} product=\{p\} index=\{i\} \/>/);
});

test('HOME: the section is never labelled a drop or an arrival', () => {
  const home = code(HOME);
  // The old "New Arrivals" teaser and its supporting copy are gone for good.
  assert.doesNotMatch(home, /New Arrivals/i);
  assert.doesNotMatch(home, /LATEST DROP|latest drop/i);
  assert.doesNotMatch(home, /pieces selected|totalPieces/, 'the teaser counter is gone');
  // A section heading that duplicates its own eyebrow, or a second name for the
  // same catalogue, is exactly what this cleanup removed.
  assert.equal(/The Collection<\/span>/.test(home), false, 'no eyebrow label duplicating the heading');
  // Nothing renders a per-product "new" badge from the new_drop flag.
  assert.doesNotMatch(home, />New Drop</);
});

test('HOME: the section shows every retail-visible product, unfiltered', () => {
  const home = code(HOME);
  // No slice: a truncated teaser would make "View All" open a page showing
  // exactly what was already on screen.
  assert.doesNotMatch(home, /\.slice\(0,/, 'the grid must not truncate the collection');
  // No hardcoded category: the heading says THE COLLECTION, and CollectionPage
  // owns category filtering. Filtering here would hide products.
  assert.doesNotMatch(home, /category/, 'the homepage must not filter by category');
  // Retail visibility (published + retail-only) is still respected.
  assert.match(home, /isRetailVisible/);
  // The grid is omitted entirely when the catalogue is empty, never rendered
  // as an empty box.
  assert.match(home, /\{collection\.length > 0 && \(/);
  // Loading and failure still have real states rather than a blank band.
  assert.match(home, /HomeProductSkeleton/);
  assert.match(home, /Couldn't Load Products/);
});

test('HOME: the collection grid order is deterministic and honours admin intent', () => {
  const memo = /const collection = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[products\]\);/.exec(code(HOME));
  assert.ok(memo, 'expected a memo keyed on products');
  const body = memo[1];
  const cmp = /\.sort\(\(a, b\) => \{([\s\S]*?)\n {4}\}\)/.exec(body);
  assert.ok(cmp, 'expected a comparator inside the memo');
  const order = cmp[1];
  const featuredAt = order.indexOf('Boolean(b.featured)');
  const dropAt = order.indexOf('Boolean(b.new_drop)');
  const sortOrderAt = order.indexOf('a.sort_order');
  assert.ok(featuredAt >= 0, 'admin-featured products must be ranked first');
  assert.ok(dropAt > featuredAt, 'admin-flagged drops rank after featured');
  assert.ok(sortOrderAt > dropAt, "then the admin's own catalogue order");
  // A total tie-break, so the order can never depend on API row order.
  assert.match(order, /a\.id\.localeCompare\(b\.id\)/);
  // No randomness and no clock reads inside the memo.
  assert.equal(/Math\.random|Date\.now/.test(memo[0]), false, 'the order must be reproducible');
  // ...and it is ordering only: no product count is rendered from it.
  assert.doesNotMatch(code(HOME), /\{collection\.length\} of/);
});

test('STOREFRONT: no leftover drop / arrival presentation in shopper-facing copy', () => {
  // Collection page: heading, filters, counter and empty state.
  assert.doesNotMatch(code(COLLECTION), /new drop|new arrival|latest drop/i);
  // Contact page copy.
  assert.doesNotMatch(code(CONTACT), /new drop|new arrival/i);
  // SEO / meta description.
  assert.doesNotMatch(HTML, /new drops/i);
  // The whole storefront, minus the account dashboard and admin — both of which
  // legitimately surface the product-level `new_drop` flag (a subscriber
  // notification preference and an admin product field), not a browse
  // destination, and both of which must keep working.
  const shopper = ['src/components/Navbar.tsx', 'src/components/Footer.tsx',
    'src/components/ProductCard.tsx', 'src/components/SearchDialog.tsx',
    'src/pages/HomePage.tsx', 'src/pages/CollectionPage.tsx',
    'src/pages/RetailProductPage.tsx', 'src/pages/ContactPage.tsx']
    .map((f) => code(read(f)))
    .join('\n');
  assert.doesNotMatch(shopper, /new drop|new arrival|latest drop/i);
  // Product cards must not badge a "new drop" either.
  assert.doesNotMatch(code(read('src/components/ProductCard.tsx')), /new_drop/);
});

test('PDP: the page does not pad the accordion→"You Might Also Like" seam twice', () => {
  // The page wrapper carries pb-16 so there is room before the footer, but the
  // Related section has its own py-12 md:py-16. When both applied, the same seam
  // was padded twice: measured 113px from the last accordion to the heading on a
  // phone (64 + 48 + 1px rule) and 129px on desktop (64 + 64 + 1px) — read as a
  // dead strip. The wrapper drops pb-16 whenever the Related section renders, so
  // the section follows the accordions and keeps only its own intentional gap.
  const src = code(PDP);

  // The wrapper's bottom padding must be conditional on Related NOT rendering.
  assert.match(
    src,
    /related\.length > 0 \? 'shell pt-0' : 'shell pt-0 pb-16/,
    'the page wrapper must drop pb-16 when the Related section renders',
  );

  // The Related section still owns its own padding, so the gap before the
  // footer (and after the last card) is preserved rather than collapsed.
  assert.match(
    src,
    /<section className="border-t border-line py-12 md:py-16">/,
    'the Related section must keep its own py-12 md:py-16',
  );

  // No reintroduced reservation: the two boxes that meet at this seam must not
  // pad it with a min-height, a fixed height, a flex spacer or extra padding.
  // (Scope matters — the product body legitimately contains flex-1 controls.)
  const wrapperTag = /<div className=\{related\.length[^\n]*\}>/.exec(src)?.[0] ?? '';
  const relatedTag = /<section className="border-t border-line[^"]*"/.exec(src)?.[0] ?? '';
  assert.ok(wrapperTag && relatedTag, 'could not isolate the accordion→Related seam boxes');
  for (const [name, tag] of [['page wrapper', wrapperTag], ['related section', relatedTag]]) {
    assert.doesNotMatch(
      tag,
      /min-h-|\bh-\[|flex-1|spacer/,
      `the ${name} must not reserve vertical space at this seam`,
    );
  }
  // The wrapper's non-related branch is still the page's own footer padding,
  // and the related branch must carry NO bottom padding of its own.
  const branches = /related\.length > 0 \? '([^']*)' : '([^']*)'/.exec(src);
  assert.ok(branches, 'wrapper padding is not conditional');
  assert.doesNotMatch(branches[1], /\bpb-|\bmb-/, 'the related branch must add no bottom padding');
  assert.match(branches[2], /\bpb-16\b/, 'the no-related branch keeps its footer padding');
});

test('COLLECTION: the cards are the same card as the homepage, not a second design', () => {
  // Both pages render the ONE ProductCard, so image ratio, Save badge, clamped
  // title, price/strike-through and colour dots cannot differ by construction.
  assert.match(code(COLLECTION), /<ProductCard key=\{p\.id\} product=\{p\} index=\{i\} \/>/);
  assert.match(code(HOME), /<ProductCard key=\{p\.id\} product=\{p\} index=\{i\} \/>/);
  // Identical card call site: no `immediate`, no extra props on either.
  assert.doesNotMatch(code(COLLECTION), /<ProductCard[^>]*\bimmediate\b/);
  assert.doesNotMatch(code(COLLECTION), /<ProductCard[^>]*\bpriority\b/);

  // ...and an IDENTICAL grid, so the two pages space their cards the same way.
  const grid = (src) => /className="(grid grid-cols-2 md:grid-cols-4[^"]*)"/.exec(code(src))?.[1];
  assert.ok(grid(COLLECTION), 'collection grid not found');
  assert.equal(grid(COLLECTION), grid(HOME), 'the collection and homepage grids must be the same class string');
  assert.match(grid(COLLECTION), /gap-y-5/, 'row gap must match the homepage');
  assert.match(grid(COLLECTION), /md:gap-y-8/, 'desktop row gap must match the homepage');

  // The loading ghost tracks the real grid, or the page jumps on load.
  const SKELETON = code(read('src/components/Skeletons.tsx'));
  const skelGrid = /className="(grid grid-cols-2 md:grid-cols-4[^"]*)"/.exec(SKELETON)?.[1];
  assert.equal(skelGrid, grid(HOME), 'the skeleton grid must match the real grid');
});

test('COLLECTION: the grid is NOT inside .shell, so cards are the same width as the homepage', () => {
  // The card component and the grid class string were already identical, but
  // the grid sat inside `.shell` (padding-inline 1.25/2/3rem, max-width 1600px)
  // while the homepage's grid is full-bleed with px-2 / md:px-4 / lg:px-6 /
  // xl:px-8. That made every collection card narrower and broke parity above
  // 1600px. The grid now lives in a section with the homepage's own horizontal
  // padding. (Vertical padding stays on the page wrapper, as it always was.)
  const src = code(HOME);
  const homeSection = /<section className="(mx-auto w-full[^"]*)"/.exec(src)?.[1];
  assert.ok(homeSection, 'homepage product section not found');
  // The horizontal part, up to the first vertical-spacing class.
  const homeH = homeSection.split(' ').filter((c) => /^(mx-auto|w-full|px-\d|md:px-\d|lg:px-\d|xl:px-\d)$/.test(c)).join(' ');
  assert.ok(homeH.includes('px-2') && homeH.includes('xl:px-8'), 'homepage padding not parsed');

  const colSrc = code(COLLECTION);
  const colSection = /<section className="([^"]*)"/.exec(colSrc)?.[1];
  assert.ok(colSection, 'collection section not found');
  const colH = colSection.split(' ').filter((c) => /^(mx-auto|w-full|px-\d|md:px-\d|lg:px-\d|xl:px-\d)$/.test(c)).join(' ');
  assert.equal(
    colH,
    homeH,
    'the collection grid must use the homepage section padding, or cards are a different width',
  );

  // Guard the specific regression: nothing may reintroduce .shell's wider
  // gutter around the grid. The error state may still use .shell; the grid may not.
  const gridAt = colSrc.indexOf('className="grid grid-cols-2');
  assert.ok(gridAt > -1, 'collection grid not found');
  const sectionAt = colSrc.indexOf(`<section className="${colSection}"`);
  assert.ok(sectionAt > -1 && sectionAt < gridAt, 'the grid must live inside that section');
  assert.doesNotMatch(
    colSrc.slice(sectionAt, gridAt),
    /className="[^"]*\bshell\b/,
    'the product grid must sit outside .shell, or its cards are narrower than the homepage',
  );
});

test('COLLECTION: filters, sorting and product data are untouched', () => {
  // The category rail, its state and the filtered list all still exist exactly
  // as before — only the card presentation was touched.
  assert.match(code(COLLECTION), /const \[filter, setFilter\] = useState\('all'\)/);
  assert.match(code(COLLECTION), /const activeCat = filter === 'all' \? null : filter;/);
  assert.match(code(COLLECTION), /const filtered = \(products \?\? \[\]\)\.filter\(\(p\) => \{/);
  assert.match(code(COLLECTION), /\{filtered\.length\} \{filtered\.length === 1 \? 'Design' : 'Designs'\}/);
  // Retail visibility still governs what is shown.
  assert.match(code(COLLECTION), /isRetailVisible/);
  // No price/formatting logic was duplicated into the page.
  assert.doesNotMatch(code(COLLECTION), /getRetailPrice|getMrp|formatPrice/);
});

test('STOREFRONT: the product flag and its admin/account surfaces are untouched', () => {
  // `new_drop` is PRODUCT DATA, not presentation: it still exists in the type,
  // is still selected by the catalogue query, and still drives the admin field.
  const TYPES = read('src/lib/types.ts');
  const CATALOG = read('src/lib/catalog.ts');
  const ADMIN = read('src/pages/admin/AdminDashboard.tsx');
  assert.match(TYPES, /new_drop\?: boolean;/);
  assert.match(CATALOG, /cols\.push\('new_drop'\)/);
  assert.match(ADMIN, /New Drop/);
  // The subscriber "New Drop Alerts" preference is a notification setting tied
  // to that flag — removing it would remove functionality, not presentation.
  assert.match(read('src/pages/SubscriberDashboard.tsx'), /New Drop Alerts/);
  // Every product and card still exists: the collection still maps them all.
  assert.match(code(COLLECTION), /\{filtered\.map\(\(p, i\) => \(\s*<ProductCard key=\{p\.id\} product=\{p\} index=\{i\} \/>/);
});

/* ================================================================== *
 * Horizontal overflow is fixed at the source
 * ================================================================== */
test('OVERFLOW: the global html/body scrollbar suppression is removed', () => {
  const css = code(CSS);
  const start = css.indexOf('@layer base');
  const end = css.indexOf('@layer', start + 10);
  const base = css.slice(start, end);
  assert.ok(base.length > 0, 'expected an @layer base block');
  assert.equal(
    /overflow-x:\s*(hidden|clip)/.test(base),
    false,
    'html/body must not suppress horizontal overflow - that only hides the bug',
  );
  assert.equal(/overscroll-behavior-x/.test(base), false);
  // The narrow-page guard stays.
  assert.match(base, /max-width: 100%/);
  assert.match(APP, /<main className="flex-1 pt-\[80px\] md:pt-\[88px\]">/);
  assert.equal(/<main[^>]*overflow-x-hidden/.test(APP), false, 'main must not clip the page either');
});

test('OVERFLOW: the one real 100vw offender is gone, and scrolling surfaces own their clipping', () => {
  assert.equal(/100vw/.test(code(SEARCH)), false, 'a fixed overlay must use a percentage of its containing block');
  assert.match(SEARCH, /w-\[calc\(100%_-_2rem\)\]/);
  assert.match(SEARCH, /max-h-\[75dvh\]/);
  // Every remaining overflow-x-hidden is on an internal scroll body, which is
  // correct: it stops a long label widening a drawer, not the page.
  const scoped = ['src/components/CartDrawer.tsx', 'src/components/Navbar.tsx', 'src/components/SearchDialog.tsx']
    .map((f) => code(read(f)))
    .join('\n');
  let clipped = 0;
  for (const m of scoped.matchAll(/className="([^"]*overflow-x-hidden[^"]*)"/g)) {
    assert.match(m[1], /overflow-y-auto/, 'a clipping container must be a scroll container, not a page wrapper');
    clipped += 1;
  }
  assert.ok(clipped >= 3, 'the drawer, the mobile nav and the search results all clip their own scroll body');
  // ...and the rails that genuinely scroll are opted in, not clipped.
  const rails = ['src/components/ProductGallery.tsx', 'src/pages/CollectionPage.tsx']
    .map((f) => code(read(f)))
    .join('\n');
  assert.match(rails, /overflow-x-auto/);
});

/* ================================================================== *
 * Mobile viewport height
 * ================================================================== */
test('VIEWPORT: full-height shells use dvh, not the oversized 100vh', () => {
  const shells = ['src/App.tsx', 'src/layouts/AdminLayout.tsx', 'src/pages/admin/AdminDashboard.tsx', 'src/pages/SubscriberDashboard.tsx']
    .map((f) => read(f))
    .join('\n');
  assert.equal(/\b(min-)?h-screen\b/.test(shells), false, 'h-screen maps to the largest viewport on mobile');
  assert.match(shells, /min-h-dvh/);
  // dvh is Tailwind's dynamic viewport unit, not an arbitrary value.
  assert.equal(/h-\[100dvh\]/.test(shells), false);
});

/* ================================================================== *
 * Post-checkout Track Order
 * ================================================================== */
test('TRACK CTA: every post-checkout state with a live order can reach tracking', () => {
  // A confirmed order offers tracking straight from its own screen.
  assert.match(CHECKOUT, /navigate\(`\/track-order\/\$\{encodeURIComponent\(result\.ref\)\}`\)/);
  // An unpaid payment no longer sits on a result screen of its own — there is no
  // pending/failed checkout state to carry a CTA. The customer is back on the
  // checkout form, and their order stays reachable from the order-status page.
  assert.equal((CHECKOUT.match(/navigate\(`\/track-order\//g) || []).length, 1);
  assert.match(STATUS, /navigate\(`\/track-order\/\$\{encodeURIComponent\(snap\.ref\)\}`\)/);
  // Never for an expired (swept + restocked) order - there is nothing to track.
  assert.match(STATUS, /stock_restored_at/);
  assert.match(STATUS, /Start New Order/);
});

test('TRACK CTA: the phone stays out of the URL', () => {
  // Only the ref travels; TrackOrderPage recovers the phone from this browser's
  // own checkout history, so no PII is ever put in a link or a browser history.
  assert.equal(/\/track-order\/[^`]*phone/.test(CHECKOUT), false);
  assert.match(TRACK, /refFromRoute/);
  assert.match(TRACK, /peekTrackHint|addCheckoutHistory|trackHistory/);
  // The tracking form itself is still ref + phone.
  assert.match(TRACK, /phone/);
});

/* ================================================================== *
 * Track Order: ordered-product imagery
 * ================================================================== */

test('TRACK: each ordered product shows its own variant image', () => {
  // Resolved from the public catalogue by the item's `code` (or `product_id`)
  // + ordered `color`, taking that colour's first image -- the same frame
  // RetailProductPage puts in the cart for the colour the shopper picked.
  assert.match(ORDER_IMAGES, /import \{[^}]*cleanImageUrls[^}]*fetchProducts[^}]*\} from '@\/lib\/catalog'/);
  assert.match(ORDER_IMAGES, /function buildImageIndex\(products: CatalogProduct\[\]\)/);
  assert.match(ORDER_IMAGES, /byColor\.set\(color\.name\.trim\(\)\.toLowerCase\(\), first\)/);
  assert.match(ORDER_IMAGES, /cleanImageUrls\(color\.images\)\[0\]/);
  assert.match(ORDER_IMAGES, /byColor\.get\(color\)/);
  // ...and Track Order consumes that shared resolver rather than its own copy.
  assert.match(TRACK, /useOrderImages, imageForItem/);
  assert.match(TRACK, /imageForItem\(imageIndex, /);
  // Rendered per item row, with the existing PDP/drawer treatment.
  assert.match(TRACK, /w-\[76px\] h-\[96px\] shrink-0 overflow-hidden bg-paper-3 border border-line/);
  assert.match(TRACK, /className="w-full h-full object-cover"/);
});

test('TRACK: the product image does not widen the possession-gated API', () => {
  // The RPC already returns name/code/color/size_label/quantity/line_total.
  // The image must come from the already-public catalogue, NOT from a widened
  // projection, and never from cart state.
  assert.match(ORDER_IMAGES, /fetchProducts\(\)/);
  // The image resolver itself must not touch cart state or browser storage.
  // (peekCheckoutHistory legitimately uses sessionStorage, so scope the check
  // to the resolver rather than any one page file.)
  assert.doesNotMatch(ORDER_IMAGES, /localStorage|sessionStorage|useD2cCart/);
  // Existing name / colour / size / qty / price survive untouched.
  const rows = TRACK.slice(TRACK.indexOf('Your Products'));
  assert.match(rows, /\{it\.name\}/);
  assert.match(rows, /\{it\.color\} · \{it\.size_label\} × \{it\.quantity\}/);
  assert.match(rows, /formatPrice\(it\.line_total\)/);
});

test('TRACK: a missing or failed image degrades to a neutral block', () => {
  // No placeholder, no random image, and never a broken-image glyph.
  assert.match(TRACK, /aria-hidden=\{!image\}/);
  assert.match(TRACK, /onError=\{\(e\) => \{[\s\S]*?style\.visibility = 'hidden'/);
  // A failed catalogue load must not break the page either — that fallback now
  // lives in the shared resolver rather than in Track Order itself.
  assert.match(ORDER_IMAGES, /catch\(\(\) => \{/);
});

/* ================================================================== *
 * Nothing regressed on the admin side
 * ================================================================== */
test('ADMIN: the admin shell still renders outside the storefront chrome', () => {
  assert.match(APP, /if \(isAdminPath\) \{\s*return <AdminLayout bootLoading=\{loading && protectingRoute\}>\{renderPage\(\)\}<\/AdminLayout>;/);
  assert.match(APP, /const isAdminPath = segments\[0\] === 'admin';/);
  // Protected routes still wait for auth, public routes still do not flash.
  assert.match(APP, /const protectingRoute = segments\[0\] === 'account' \|\| segments\[0\] === 'admin';/);
  assert.match(APP, /if \(!isAdmin\) return null; \/\/ Redirect to \/account handled by useEffect/);
});
