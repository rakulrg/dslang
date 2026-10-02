/**
 * Hero blur-up previews (LQIP).
 *
 * WHY THIS EXISTS
 * The homepage hero used to paint a bare `bg-ink` (#0a0a0a) rectangle until the
 * first hero photo finished downloading. On a cold mobile load that is a large
 * black block, and it reads as broken rather than as "loading".
 *
 * The fix is a blur-up: a ~1 kB blurred preview OF THE ACTUAL PHOTO, painted
 * straight away, with the full-resolution image crossfaded over it once decoded.
 * Because the preview is a data URI it costs ZERO network requests, which is
 * what makes it safe to show instantly on mobile.
 *
 * WHERE PREVIEWS COME FROM, in priority order:
 *   1. `heroLqip.generated.ts` — committed, produced by
 *      `node scripts/generate-hero-lqip.mjs` from the live `hero_slides` rows.
 *      This covers today's hero and is the only source that exists before any
 *      JavaScript runs (the first preview is also inlined into index.html as
 *      `--hero-lqip`, so the hero shell is never black even pre-hydration).
 *   2. `sessionStorage` — previews captured at runtime by `captureHeroLqip`.
 *      Supabase Storage serves `access-control-allow-origin: *` and
 *      `cache-control: immutable`, so once a hero photo has been seen the
 *      browser already holds the bytes: re-reading them costs no request, and
 *      the tiny preview survives navigation within the session. This is what
 *      makes the feature self-healing for photos uploaded after the last
 *      generator run, instead of degrading to a flat gradient.
 *   3. Nothing — the caller falls back to `.hero-preview-fallback`, a soft
 *      DSLANG-dark gradient. Never a solid black block, never a random photo.
 *
 * `heroLqipKey` MUST stay byte-identical to `lqipKey` in the generator;
 * scripts/hero-lqip.test.mjs asserts the two agree.
 */
import { HERO_LQIP, HERO_LQIP_FIRST_URL } from './heroLqip.generated';

export { HERO_LQIP_FIRST_URL };

/** Storage object filename -> blurred preview data URI (committed previews). */
export const GENERATED_HERO_LQIP = HERO_LQIP;

/** sessionStorage key for runtime-captured previews. */
const SESSION_KEY = 'dslang_hero_lqip_v1';

/** Must match LQIP_WIDTH / LQIP_UPSCALE in scripts/generate-hero-lqip.mjs. */
const CAPTURE_WIDTH = 32;
const CAPTURE_UPSCALE = 4;

/** Keep the session cache small: a handful of hero photos at ~1.4 kB each. */
const MAX_CACHED = 12;

/** Storage object filename, query/hash stripped, lowercased. Using the object
 *  name (rather than the full URL) means a preview keeps matching if the
 *  Supabase host or bucket path changes. Hero uploads are uuid-named, so this is
 *  effectively collision-free. */
export function heroLqipKey(url: string): string {
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

/* -------------------------------------------------------------------------- */
/* Runtime-captured previews                                                   */
/* -------------------------------------------------------------------------- */

const captured = new Map<string, string>();
let sessionLoaded = false;

function loadSession(): void {
  if (sessionLoaded) return;
  sessionLoaded = true;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.startsWith('data:image/') && value.length < 20000) {
        captured.set(key, value);
      }
    }
  } catch {
    /* private mode / disabled storage — previews just stay in memory */
  }
}

function persistSession(): void {
  try {
    const payload: Record<string, string> = {};
    // Most-recent first, so the cap keeps what is actually in use.
    for (const [key, value] of Array.from(captured.entries()).slice(-MAX_CACHED)) {
      payload[key] = value;
    }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* over quota / disabled — memory cache still serves this page view */
  }
}

/**
 * The blurred preview to paint for `url`, or `undefined` when none is known yet
 * (the caller should then use the brand fallback gradient).
 *
 * Synchronous by design: the hero renders during the first paint and must not
 * wait a microtask to know what its background is.
 */
export function heroLqipFor(url: string): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  loadSession();
  const key = heroLqipKey(url);
  if (!key) return undefined;
  return HERO_LQIP[key] ?? captured.get(key);
}

/**
 * Derives a tiny blurred preview for a hero photo that has no committed
 * preview, and remembers it for the rest of the session.
 *
 * Deliberately fetch-based rather than canvas-from-the-<img>-element: Supabase
 * Storage sends `access-control-allow-origin: *`, so a `cors` read of an
 * already-cached URL is free and produces an untainted canvas. Drawing the live
 * `<img>` instead would taint the canvas (it is fetched in no-CORS mode) and
 * would require putting `crossorigin` on the hero image itself, which risks
 * breaking the hero outright if a CORS header ever regresses. This path can
 * only ever help: every failure is swallowed.
 *
 * Call it once a hero photo has loaded. It does not block anything.
 */
export function captureHeroLqip(url: string): void {
  if (typeof url !== 'string' || !url) return;
  loadSession();
  const key = heroLqipKey(url);
  if (!key || HERO_LQIP[key] || captured.has(key)) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const run = () => {
    void deriveLqip(url)
      .then((dataUri) => {
        if (!dataUri) return;
        captured.set(key, dataUri);
        persistSession();
      })
      .catch(() => {
        /* no preview is a perfectly fine outcome; the gradient stands in */
      });
  };

  // Never compete with the crossfade or the LCP for main-thread time.
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 4000 });
  else window.setTimeout(run, 1200);
}

async function deriveLqip(url: string): Promise<string | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) return null;
  const blob = await res.blob();

  // Decode straight to the tiny size — the browser never materialises the full
  // bitmap, so this is cheap even for a 1920px hero photo.
  const probe = await createImageBitmap(blob);
  const w = Math.max(1, CAPTURE_WIDTH);
  const h = Math.max(1, Math.round((probe.height / probe.width) * w));
  probe.close();

  const small = await createImageBitmap(blob, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
  });

  const out = document.createElement('canvas');
  out.width = w * CAPTURE_UPSCALE;
  out.height = h * CAPTURE_UPSCALE;
  const ctx = out.getContext('2d');
  if (!ctx) {
    small.close();
    return null;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = `blur(${Math.max(1, Math.round(out.width * 0.06))}px)`;
  // Overscan slightly so the blur never fades to transparency at the edges,
  // which would show the layer underneath as a vignette.
  ctx.drawImage(small, -2, -2, out.width + 4, out.height + 4);
  ctx.filter = 'none';
  small.close();

  for (const [type, quality] of [['image/webp', 0.4], ['image/jpeg', 0.35]] as const) {
    const uri = out.toDataURL(type, quality);
    if (uri.startsWith(`data:${type}`) && uri.length > 64) return uri;
  }
  return null;
}
