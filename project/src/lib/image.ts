/**
 * Image loading helpers with a small in-memory cache.
 *
 * `preloadImage` warms the browser HTTP cache for a URL. The cache dedupes
 * concurrent calls for the same URL (two consumers preloading the same image
 * trigger only ONE network request) and remembers successful loads, so
 * revisiting the same slide/card never refetches. Failed loads are evicted so
 * a later attempt can retry (e.g. after a transient network hiccup).
 *
 * The hero used to call a batch variant here to warm EVERY slide up front,
 * which on mobile meant downloading several photographs before the shopper had
 * seen the first one. It now preloads one image ahead via `preloadImage`, which
 * is all a crossfade needs.
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
