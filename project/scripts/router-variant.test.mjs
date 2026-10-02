/**
 * BEHAVIOURAL tests for the new hash-router query helpers.
 *
 * These run the REAL `src/lib/router.ts` (Node 26 strips the types natively),
 * against a minimal `window` double that models the parts of the browser these
 * functions depend on:
 *
 *   - assigning `location.hash`  -> pushes a history entry + fires `hashchange`
 *   - `location.replace(url)`    -> replaces the entry + fires `hashchange`
 *   - `history.replaceState()`   -> changes the URL and fires NOTHING
 *
 * The last distinction is the whole point of `replaceHashQuery`: the PDP writes
 * the selected colour/size into the URL on every swatch click, and if that went
 * through `navigate` it would re-render the page, scroll to the top and pile up
 * Back-button entries. These tests assert it does none of that.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * Minimal window double
 * ------------------------------------------------------------------ */
function installWindow(initialHash = '#/') {
  const listeners = new Set();
  const calls = { replace: 0, replaceState: 0, hashAssign: 0 };

  let hash = initialHash;

  const fire = () => listeners.forEach((fn) => fn());

  const location = {
    get hash() {
      return hash;
    },
    set hash(next) {
      calls.hashAssign += 1;
      hash = next;
      fire();
    },
    replace(next) {
      calls.replace += 1;
      hash = next;
      fire();
    },
  };

  const history = {
    scrollRestoration: 'auto',
    replaceState(_state, _title, url) {
      calls.replaceState += 1;
      // A real replaceState on a same-document URL updates location.hash but
      // deliberately does NOT emit hashchange.
      hash = url.startsWith('#') ? url : `#${url}`;
    },
  };

  const win = {
    location,
    history,
    addEventListener(type, fn) {
      if (type === 'hashchange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'hashchange') listeners.delete(fn);
    },
    scrollTo() {},
  };

  globalThis.window = win;
  return { win, calls, listeners };
}

const { readHashQuery, replaceHashQuery, clearHashQuery, replaceRoute, linkHref } =
  await import('../src/lib/router.ts');

/* ------------------------------------------------------------------ *
 * readHashQuery
 * ------------------------------------------------------------------ */
test('readHashQuery: parses colour + size off a product deep link', () => {
  installWindow('#/product/oversized-tee?color=black&size=XL');
  const q = readHashQuery();
  assert.equal(q.get('color'), 'black');
  assert.equal(q.get('size'), 'XL');
});

test('readHashQuery: a route with no query yields empty params', () => {
  installWindow('#/collections');
  assert.equal(readHashQuery().toString(), '');
});

test('readHashQuery: a bare path never throws and has no params', () => {
  installWindow('#/');
  assert.equal(readHashQuery().get('color'), null);
});

test('readHashQuery: decodes percent-encoded values with spaces', () => {
  installWindow('#/product/tee?color=Indigo%20Blue&size=2%20XL');
  const q = readHashQuery();
  assert.equal(q.get('color'), 'Indigo Blue');
  assert.equal(q.get('size'), '2 XL');
});

test('readHashQuery: keeps the path out of the params (path/query split)', () => {
  // A colour literally named "x" must not be confused with the path, and a
  // query key must never leak into routing.
  installWindow('#/product/tee?color=x&size=y');
  const q = readHashQuery();
  assert.deepEqual([...q.keys()].sort(), ['color', 'size']);
  assert.equal(q.get('product'), null);
});

/* ------------------------------------------------------------------ *
 * replaceHashQuery
 * ------------------------------------------------------------------ */
test('replaceHashQuery: writes both params and keeps the route path', () => {
  const { win } = installWindow('#/product/oversized-tee');
  replaceHashQuery({ color: 'Black', size: 'XL' });
  assert.equal(win.location.hash, '#/product/oversized-tee?color=Black&size=XL');
});

test('replaceHashQuery: preserves an unrelated existing param', () => {
  const { win } = installWindow('#/product/tee?color=Black&ref=hero');
  replaceHashQuery({ size: 'L' });
  const q = new URLSearchParams(win.location.hash.split('?')[1]);
  assert.equal(q.get('color'), 'Black');
  assert.equal(q.get('ref'), 'hero');
  assert.equal(q.get('size'), 'L');
});

test('replaceHashQuery: a null value REMOVES the key (invalid-variant cleanup)', () => {
  const { win } = installWindow('#/product/tee?color=Nebula&size=XXL');
  replaceHashQuery({ color: null });
  const q = new URLSearchParams(win.location.hash.split('?')[1]);
  assert.equal(q.get('color'), null);
  assert.equal(q.get('size'), 'XXL');
  assert.equal(win.location.hash.includes('color='), false);
});

test('replaceHashQuery: empty string and undefined also remove the key', () => {
  const { win } = installWindow('#/product/tee?color=Nebula&size=M');
  replaceHashQuery({ color: '', size: undefined });
  assert.equal(win.location.hash, '#/product/tee');
});

test('replaceHashQuery: when every param is dropped the query is not left dangling', () => {
  const { win } = installWindow('#/product/tee?color=Black&size=M');
  clearHashQuery('color', 'size');
  assert.equal(win.location.hash, '#/product/tee');
  assert.equal(win.location.hash.includes('?'), false);
});

test('replaceHashQuery: does NOT navigate - no hash assignment, no hashchange, no history entry', () => {
  const { win, calls, listeners } = installWindow('#/product/tee?color=Black&size=M');
  let fired = 0;
  win.addEventListener('hashchange', () => { fired += 1; });

  replaceHashQuery({ color: 'Indigo Blue', size: '2XL' });

  assert.equal(calls.hashAssign, 0, 'must not assign location.hash');
  assert.equal(calls.replace, 0, 'must not call location.replace');
  assert.equal(calls.replaceState, 1, 'must go through history.replaceState');
  assert.equal(fired, 0, 'must not fire hashchange (no re-render, no scroll reset)');
  assert.equal(listeners.size, 1, 'no listener was added or removed');
  assert.equal(win.location.hash, '#/product/tee?color=Indigo+Blue&size=2XL');
});

test('replaceHashQuery: repeated clicks on the same variant do not duplicate keys', () => {
  const { win } = installWindow('#/product/tee');
  for (let i = 0; i < 5; i += 1) replaceHashQuery({ color: 'Black', size: 'XL' });
  const q = new URLSearchParams(win.location.hash.split('?')[1]);
  assert.deepEqual([...q.entries()].sort(), [['color', 'Black'], ['size', 'XL']]);
});

test('replaceHashQuery: switching size keeps colour and replaces only the size', () => {
  const { win } = installWindow('#/product/tee?color=Black&size=M');
  replaceHashQuery({ size: 'L' });
  const q = new URLSearchParams(win.location.hash.split('?')[1]);
  assert.equal(q.get('color'), 'Black');
  assert.equal(q.get('size'), 'L');
});

test('replaceHashQuery: overwrites, never appends a duplicate colour', () => {
  const { win } = installWindow('#/product/tee?color=Black&size=M');
  replaceHashQuery({ color: 'Sand' });
  const q = new URLSearchParams(win.location.hash.split('?')[1]);
  assert.equal(q.getAll('color').length, 1);
  assert.equal(q.get('color'), 'Sand');
});

test('replaceHashQuery: works from a bare "#/" route', () => {
  const { win } = installWindow('#/');
  replaceHashQuery({ color: 'Black' });
  assert.equal(win.location.hash, '#/?color=Black');
});

test('replaceHashQuery: works when the page was loaded with no hash at all', () => {
  const { win } = installWindow('');
  replaceHashQuery({ color: 'Black', size: 'S' });
  assert.equal(win.location.hash, '#/?color=Black&size=S');
});

/* ------------------------------------------------------------------ *
 * replaceRoute - the /collection -> /collections canonicalization
 * ------------------------------------------------------------------ */
test('replaceRoute: rewrites the URL without leaving a Back entry', () => {
  const { win, calls } = installWindow('#/collection');
  replaceRoute('/collections');
  assert.equal(win.location.hash, '#/collections');
  assert.equal(calls.replace, 1, 'must use location.replace');
  assert.equal(calls.hashAssign, 0, 'must not push a new history entry');
  assert.equal(calls.replaceState, 0);
});

test('replaceRoute: normalises a missing leading slash', () => {
  const { win } = installWindow('#/shop');
  replaceRoute('collections');
  assert.equal(win.location.hash, '#/collections');
});

test('replaceRoute: is a no-op when already canonical (no re-redirect loop)', () => {
  const { win, calls } = installWindow('#/collections');
  replaceRoute('/collections');
  assert.equal(calls.replace, 0);
  assert.equal(calls.hashAssign, 0);
  assert.equal(win.location.hash, '#/collections');
});

test('replaceRoute: does fire hashchange so the router picks the new route up', () => {
  const { win } = installWindow('#/collection');
  let fired = 0;
  win.addEventListener('hashchange', () => { fired += 1; });
  replaceRoute('/collections');
  assert.equal(fired, 1);
});

/* ------------------------------------------------------------------ *
 * linkHref - unchanged behaviour
 * ------------------------------------------------------------------ */
test('linkHref: builds a hash href and always has a leading slash', () => {
  assert.equal(linkHref('/collections'), '#/collections');
  assert.equal(linkHref('collections'), '#/collections');
});
