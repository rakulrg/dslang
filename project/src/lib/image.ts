/**
 * Image loading helpers with a small in-memory cache.
 *
 * `preloadImage` warms the browser HTTP cache for a URL. The cache dedupes
 * concurrent calls for the same URL (two consumers preloading the same image
 * trigger only ONE network request) and remembers successful loads, so
 * revisiting the same slide/card never refetches. Failed loads are evicted so
 * a later attempt can retry (e.g. after a transient network hiccup).
 */
const preloadCache = new Map<string, Promise<string>>();

export function preloadImage(src: string): Promise<string> {
  const cached = preloadCache.get(src);
  if (cached) return cached;

  const promise = new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error(`Image failed to load: ${src}`));
    img.src = src;
  });

  preloadCache.set(src, promise);
  // Evict on failure so the URL can be retried later. Success stays cached.
  promise.catch(() => {
    preloadCache.delete(src);
  });

  return promise;
}

/** Preloads many images in parallel. Never rejects — resolves with the lists
 *  of successfully loaded and failed URLs so callers can react to failures. */
export async function preloadImages(srcs: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const unique = Array.from(new Set(srcs.filter((s) => typeof s === 'string' && s.trim().length > 0)));
  const settled = await Promise.allSettled(unique.map((src) => preloadImage(src)));
  const ok: string[] = [];
  const failed: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') ok.push(unique[i]);
    else failed.push(unique[i]);
  });
  return { ok, failed };
}