import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { ProductCard, PRODUCT_IMAGE_FALLBACK } from '@/components/ProductCard';
import { Reveal } from '@/components/Reveal';
import { FadeSwap, HomeProductSkeleton } from '@/components/Skeletons';
import { linkHref } from '@/lib/router';
import { responsiveSrc } from '@/lib/img';
import {
  fetchProducts,
  fetchHeroSlides,
  isRetailVisible,
  type CatalogProduct,
  type HeroSlideRow,
} from '@/lib/catalog';
import { preloadImage } from '@/lib/image';
import { captureHeroLqip } from '@/lib/heroLqip';

/* Hero — a crossfade carousel of full-bleed imagery. ONLY the hero images
   animate: each slide is its own absolutely-positioned layer, the incoming one
   fading up over the outgoing one inside an overflow-hidden section. There is
   no sliding track, no text animation and no parallax. Autoplay every 3s,
   ~450ms crossfade, touch swipe, and every manual interaction resets the
   autoplay timer. A single fixed "Explore Now" CTA sits bottom-center on top of
   the hero image — it is NOT part of the carousel.

   WHY CROSSFADE AND NOT A SLIDING TRACK
   A translateX track has to reveal the neighbouring slide while it is still
   arriving, so an image that has not finished downloading slides in as a black
   rectangle. Crossfading lets the carousel simply WAIT: the outgoing slide
   stays fully painted until the incoming one has decoded, then the new image
   fades up over it. The hero is never empty, never black, and never flickers.

   LOADING, END TO END
   - The loading state is the hero's OWN dark DSLANG treatment, and nothing else:
     no blurred preview, no LQIP, no skeleton, no spinner. `.hero-shell` paints
     that dark surface on the box itself, so the very first frame — before React
     has booted and before a single hero byte is requested — already looks like
     the finished hero rather than like a placeholder.
   - The photograph is held at opacity 0 until it has decoded, and a black
     `.hero-curtain` sits ABOVE it at opacity 1. Because the dark surface is a
     sibling painted on top rather than a background painted behind, it can
     genuinely fade OUT while the photo fades in underneath, so the two are seen
     dissolving into one another instead of the black being covered by a
     cut. The curtain is lifted as soon as any photo is revealed, and never
     returns for a carousel step — only the photographs crossfade after that.
   - A carousel step keeps the CURRENT photo on screen until the incoming one
     has decoded, then crossfades. The incoming layer is painted with nothing at
     all while a photo sits beneath it, so it cannot flash a dark rectangle over
     the photo it is fading into.
   - Only the outgoing and incoming layers carry a `src` at any moment, so a
     slide that is neither is never downloaded and never keeps a decoded bitmap.
     The next slide is warmed with a single request, which is what makes the
     crossfade instant.
   - Slides without an image URL are skipped, a slide whose image errors is
     dropped immediately (never leaving the carousel pointing past the end),
     and if NOTHING can be shown the hero renders the branded placeholder.
   - The container's aspect ratio/height comes from CSS alone, so the hero
     occupies exactly the same box before, during and after loading: no
     layout shift, ever.

   ONE PRODUCT SECTION, AND ONLY ONE
   The homepage is the hero plus a single "THE COLLECTION" grid, and that is
   deliberate. It previously carried a "New Arrivals" teaser, and a separate
   /new-drops page existed too; both were the same small T-shirt catalogue under
   different names, so the brand was showing one set of clothes three times and
   offering three ways into it. Now: the hero introduces the collection, this one
   grid shows it, and "View All" continues into /collections, which remains the
   full browsing surface. So there is exactly ONE grid here — no second teaser, no
   category rail, and no per-category block. The grid shows every retail-visible
   product rather than a slice, because with a catalogue this small a truncated
   teaser would make "View All" open a page showing exactly what was already on
   screen, which is the thing this section used to get wrong. Nothing is filtered
   out here by category: the heading says THE COLLECTION, so the section shows the
   collection, and CollectionPage owns the category filters. If the catalogue is
   ever empty the whole section is omitted rather than rendered as an empty box. */
const SLIDE_TRANSITION_MS = 450;
const SLIDE_INTERVAL_MS = 3000;
const SWIPE_THRESHOLD_PX = 48;

/** Guards the autoplay against firing again while a slow image is still
 *  decoding. Without it, a 3s interval would keep advancing `target` and skip
 *  straight past slides that had not loaded yet. */
const AUTOPLAY_SLOW_MS = 1500;

/** Inline style carrying the crossfade duration, so the image fade and the
 *  settling zoom can never drift apart (a zoom still running when a layer
 *  changes role is a visible snap). */
const HERO_REVEAL_STYLE = { '--hero-reveal-ms': `${SLIDE_TRANSITION_MS}ms` } as React.CSSProperties;

export function HomePage() {
  // `null` means "the hero_slides request is still in flight", which is NOT the
  // same as "there is nothing to show". Collapsing the two is what used to put
  // a big dark branded placeholder on screen for the whole round trip — the
  // black block this loading state exists to replace. While pending the hero
  // renders no photograph and simply holds its own dark treatment.
  const [slides, setSlides] = useState<HeroSlideRow[] | null>(null);
  const [failedSlides, setFailedSlides] = useState<ReadonlySet<string>>(new Set());
  // Carousel state is keyed by slide id rather than index: a slide that fails
  // and is filtered out shifts every index after it, and an index-keyed
  // carousel then crossfades to the wrong photo.
  const [targetId, setTargetId] = useState('');
  const [frontId, setFrontId] = useState('');
  const [revealedId, setRevealedId] = useState('');
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(new Set());
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [productsError, setProductsError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHeroSlides()
      .then((s) => {
        if (cancelled) return;
        // A slide with no image URL can never render — drop it up front so it
        // can never show a bare black slide.
        setSlides(s.filter((row) => Boolean(row.image_url && row.image_url.trim())));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('HomePage: failed to load hero slides.', err);
        // Resolved-but-empty, which the hero renders as the branded
        // placeholder rather than as a loading state.
        setSlides([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProductsLoaded(false);
    setProductsError(false);
    fetchProducts()
      .then((all) => {
        if (cancelled) return;
        setProducts(all.filter((p) => isRetailVisible(p)));
        setProductsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('HomePage: failed to load products.', err);
        setProductsLoaded(true);
        setProductsError(true);
      });
    return () => { cancelled = true; };
  }, [loadKey]);

  // Order for THE COLLECTION grid, and nothing else. Fully deterministic — no
  // randomness and no clock reads — so the homepage is identical on every render
  // and across reloads, which is what keeps ProductCard's index-based reveals
  // and image preloading stable:
  //   1. admin-featured products first (the explicit "put this on the home page"
  //      signal),
  //   2. then products the admin has flagged as a new drop,
  //   3. then the admin's own catalogue order (sort_order), which fetchProducts
  //      already returns,
  //   4. then id, so the order is total and can never depend on the order rows
  //      happened to come back in from the API.
  // Steps 1-2 are ORDERING of product data, not storefront presentation: nothing
  // here claims a product is new, and no label is rendered from either flag.
  // Every retail-visible product is included — nothing is hidden or sliced away.
  const collection = useMemo(() => {
    const list = [...products];
    list.sort((a, b) => {
      const feat = Number(Boolean(b.featured)) - Number(Boolean(a.featured));
      if (feat !== 0) return feat;
      const drop = Number(Boolean(b.new_drop)) - Number(Boolean(a.new_drop));
      if (drop !== 0) return drop;
      const order = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (order !== 0) return order;
      return a.id.localeCompare(b.id);
    });
    return list;
  }, [products]);

  // Slides to actually show: every non-failed slide with an image URL. A slide
  // is moved to `failedSlides` when its image request errors, so the carousel
  // can never get stuck on a broken image (or a permanent black slide).
  const usableSlides = useMemo(
    () => (slides ?? []).filter((s) => s.image_url && !failedSlides.has(s.id)),
    [slides, failedSlides]
  );

  const isUsable = useCallback(
    (id: string) => usableSlides.some((s) => s.id === id),
    [usableSlides]
  );

  // A slide's readiness belongs to the <img> that is currently showing it. When
  // a layer drops its `src` the element is blank again, so the flag has to go
  // with it — otherwise the next time the slide is shown it would be painted at
  // opacity 1 over an empty <img> and the crossfade would collapse to a hard cut.
  const mountedIds = useMemo(
    () =>
      new Set(
        [revealedId, frontId].filter((id) => id && isUsable(id))
      ),
    [revealedId, frontId, isUsable]
  );

  useEffect(() => {
    setReadyIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (mountedIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [mountedIds]);

  const indexOfId = useCallback(
    (id: string) => usableSlides.findIndex((s) => s.id === id),
    [usableSlides]
  );

  const stepFrom = useCallback(
    (id: string, delta: number) => {
      if (usableSlides.length === 0) return '';
      const from = indexOfId(id);
      const start = from >= 0 ? from : 0;
      return usableSlides[(start + delta + usableSlides.length) % usableSlides.length].id;
    },
    [usableSlides, indexOfId]
  );

  // A fresh slide set is a fresh chance for every photo, so failure tracking
  // starts over. (The carousel position is reset by the effect below, which
  // also has to cope with slides being dropped at runtime.)
  useEffect(() => {
    setFailedSlides(new Set());
  }, [slides]);

  // Point the carousel at a slide that still exists. Runs on a fresh slide set
  // (start at the first) and whenever a slide is dropped for failing, so the
  // carousel can never be left pointing at a slide that is no longer in the
  // rotation. Falls back to the first usable slide rather than "" so the hero
  // recovers on its own.
  useEffect(() => {
    if (usableSlides.length === 0) {
      setTargetId('');
      return;
    }
    setTargetId((current) =>
      current && isUsable(current) ? current : usableSlides[0].id
    );
  }, [usableSlides, isUsable]);

  // A slide that was on screen and then failed is not on screen any more;
  // hand the visible slot back to whatever is still loaded (or to the incoming
  // one, which may already be fully painted underneath).
  useEffect(() => {
    if (revealedId && !isUsable(revealedId)) {
      setRevealedId(frontId && isUsable(frontId) ? frontId : '');
    }
  }, [isUsable, revealedId, frontId]);

  // Start a crossfade whenever the target is not what is on screen. The
  // incoming layer is mounted at opacity 0 and is NOT advanced until its image
  // has decoded, which is what keeps the current photo visible instead of
  // fading to black while bytes stream in.
  useEffect(() => {
    if (frontId) return; // a crossfade is already in flight
    if (!targetId || targetId === revealedId) return;
    if (!isUsable(targetId)) return;
    setFrontId(targetId);
  }, [frontId, targetId, revealedId, isUsable]);

  // Promote the incoming layer once it has decoded and the fade has run. The
  // outgoing layer loses its `src` at the same moment — it is already fully
  // covered by the layer above it, so nothing can flash.
  useEffect(() => {
    if (!frontId || !readyIds.has(frontId)) return;
    const t = window.setTimeout(() => {
      setRevealedId(frontId);
      setFrontId('');
    }, SLIDE_TRANSITION_MS);
    return () => window.clearTimeout(t);
  }, [frontId, readyIds]);

  const handleImageReady = useCallback((id: string, url: string) => {
    // The bytes are here now. `captureHeroLqip` still runs (the hero no longer
    // paints a blurred preview, but the capture costs no request — the response
    // is `immutable`-cached — and keeps the runtime cache warm). Off the
    // critical path, so it never delays the reveal.
    captureHeroLqip(url);
    setReadyIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const handleImageError = useCallback((id: string) => {
    setFailedSlides((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Warm the NEXT slide so a crossfade is instant. Deliberately only one image
  // ahead: the old hero preloaded every slide up front, which on mobile meant
  // downloading several 250 kB photographs before the shopper had seen the
  // first one. A single `Image()` also dedupes against the <img> that will
  // render it, so each URL is fetched exactly once.
  useEffect(() => {
    if (usableSlides.length <= 1) return;
    const next = stepFrom(frontId || revealedId || targetId, 1);
    if (!next) return;
    preloadImage(next);
  }, [usableSlides.length, stepFrom, frontId, revealedId, targetId]);

  // Autoplay. Re-armed from scratch whenever the hero settles on a slide, so
  // the 3s is measured from "this photo is on screen" rather than from "the
  // timer fired" — a slow image therefore extends the dwell instead of
  // skipping the slide it was still loading.
  useEffect(() => {
    if (usableSlides.length <= 1) return;
    if (frontId) return; // still crossfading
    if (targetId !== revealedId) return; // waiting on the incoming image
    const t = window.setTimeout(() => {
      setTargetId((current) => stepFrom(current, 1));
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [usableSlides.length, frontId, targetId, revealedId, stepFrom]);

  // Safety net: if a crossfade never completes — the incoming image hangs on a
  // slow connection — retry it rather than leaving the hero on a frozen slide
  // for good. Bounded so it cannot loop.
  useEffect(() => {
    if (!frontId || !targetId) return;
    if (frontId === targetId) return;
    const t = window.setTimeout(() => {
      setTargetId(frontId);
    }, AUTOPLAY_SLOW_MS);
    return () => window.clearTimeout(t);
  }, [frontId, targetId, readyIds]);

  const goTo = useCallback((id: string) => {
    if (!isUsable(id)) return;
    setTargetId(id);
  }, [isUsable]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || usableSlides.length <= 1) return;
    setTargetId((current) => stepFrom(current, dx > 0 ? -1 : 1));
  };

  const activeId = frontId || revealedId;

  // The hero's loading state, as one flag. The black curtain is DOWN only while
  // there is genuinely no photograph on screen yet, and comes up the instant one
  // starts to fade in. It deliberately stays down for a resolved-but-empty hero
  // only when that is a real empty state (the branded placeholder is the content
  // then, not a loading indicator) — see `heroIsEmptyState`.
  const heroIsEmptyState = slides !== null && usableSlides.length === 0;
  // True as soon as EITHER the outgoing photo is fully painted or the incoming
  // one has decoded and begun fading. Keying off the incoming photo's readiness
  // (not off its promotion) is what makes the two dissolves run at the same time
  // rather than the black sitting still for a beat and then lifting.
  const heroHasPhoto = Boolean(
    (revealedId && readyIds.has(revealedId)) || (frontId && readyIds.has(frontId))
  );
  const showCurtain = !heroIsEmptyState && !heroHasPhoto;

  return (
    <div>
      {/* ============ HERO — mobile 1:1 full-bleed, desktop landscape ============ */}
      <section className="w-full overflow-hidden">
        {/* `hero-shell` paints the hero's own dark DSLANG treatment, which is
            its loading state: it is on screen from the very first frame — before
            React boots and before any hero byte is requested — so the box always
            looks like the finished hero rather than like a placeholder. No
            blurred preview, no skeleton, no spinner. The aspect ratio / height
            come from these classes alone and never depend on the image, so the
            hero box is identical before, during and after loading. */}
        <div
          className="hero-shell relative w-full aspect-square md:aspect-auto md:h-[78vh] md:min-h-[520px] overflow-hidden"
          style={HERO_REVEAL_STYLE}
        >
          {heroIsEmptyState ? (
            // Genuinely nothing to show (the request resolved with no usable
            // slides, or every one of them failed). A pending request never
            // reaches this branch — see the `slides === null` note above.
            <img
              src={PRODUCT_IMAGE_FALLBACK}
              alt=""
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
            />
          ) : (
            <>
              {usableSlides.map((s) => {
                // Only the outgoing and incoming layers carry a `src`. A slide
                // that is neither is never downloaded, and by the time it would
                // be dropped it is already fully covered by the layer above it,
                // so removing it cannot flash.
                const isFront = s.id === frontId;
                const isRevealed = s.id === revealedId && s.id !== frontId;
                // The <img> element itself is NEVER unmounted — only its `src` is
                // added and removed. Remounting it would restart from a blank
                // element while `readyIds` still says "loaded", so the layer
                // would jump straight to opacity 1 over an empty <img> and the
                // crossfade would read as a hard cut. Reusing the element keeps
                // decode state and readiness in agreement, and dropping the
                // `src` while the layer is fully covered releases the decoded
                // bitmap so only one or two photographs are ever in memory.
                const isMounted = isFront || isRevealed;
                const ready = isMounted && readyIds.has(s.id);
                // Is a fully painted photo already sitting underneath this layer?
                const coveredByBase = isFront && Boolean(revealedId) && revealedId !== frontId;
                // The incoming layer sits above the outgoing one, so it is the
                // only one that can ever be seen crossfading in. Expressed as
                // z-index rather than DOM order because the slides render in
                // database order, which does not follow the rotation.
                const zIndex = isFront ? 2 : isRevealed ? 1 : 0;
                return (
                  <div
                    key={s.id}
                    aria-hidden="true"
                    className={`hero-layer absolute inset-0 overflow-hidden select-none pointer-events-none touch-pan-y${
                      coveredByBase ? ' hero-layer-clear' : ''
                    }`}
                    style={{ zIndex }}
                    onTouchStart={handleTouchStart}
                    onTouchEnd={handleTouchEnd}
                  >
                    <img
                      src={isMounted ? s.image_url : undefined}
                      alt=""
                      loading="eager"
                      fetchPriority={!revealedId && isFront ? 'high' : 'auto'}
                      decoding="async"
                      draggable={false}
                      onLoad={() => handleImageReady(s.id, s.image_url)}
                      onError={() => handleImageError(s.id)}
                      {...responsiveSrc(s.image_url, [480, 768, 1200])}
                      className={`hero-image absolute inset-0 w-full h-full object-cover select-none pointer-events-none ${
                        isFront ? 'hero-zoom' : ''
                      }`}
                      style={{ opacity: ready ? 1 : 0 }}
                      data-revealing={isFront && !ready ? 'true' : 'false'}
                    />
                  </div>
                );
              })}

              {usableSlides.length > 1 && (
                <div className="absolute top-3 right-2 md:right-4 lg:right-6 xl:right-8 z-10 flex items-center gap-2">
                  {usableSlides.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => goTo(s.id)}
                      aria-label={`Slide ${i + 1}`}
                      className={`h-1 transition-all duration-200 ${
                        s.id === activeId ? 'w-8 bg-white' : 'w-4 bg-white/40 hover:bg-white/70'
                      }`}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* THE LOADING STATE. A real black surface painted ON TOP of the
              photograph rather than as a background behind it, so it can fade
              out while the photograph fades in underneath and the two are seen
              dissolving together. z-5 sits above the photo layers (z 0-2) and
              below the grain (z-6) and the text/CTA (z-10), so the hero's own
              content is never dimmed by it. Kept mounted at opacity 0 once a
              photo has arrived, and pointer-events-none so it can never
              intercept a swipe, a tap or the CTA. */}
          <div
            className="hero-curtain absolute inset-0 z-[5] pointer-events-none select-none"
            style={{ opacity: showCurtain ? 1 : 0 }}
            data-lifted={showCurtain ? 'false' : 'true'}
            aria-hidden="true"
          />

          {/* Editorial grain + soft bottom scrim — decorative only, never
              intercepts swipes/clicks (pointer-events-none). */}
          <div className="absolute inset-0 z-[6] pointer-events-none select-none hero-grain" aria-hidden="true" />
          <div
            className="absolute inset-x-0 bottom-0 h-3/5 md:h-2/3 bg-gradient-to-t from-black/55 via-black/15 to-transparent pointer-events-none select-none"
            aria-hidden="true"
          />

          {/* Fixed CTA — bottom-center overlay on the hero, never inside the
              carousel layers, so it does not move with the slides. */}
          <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-6 md:pb-8 pointer-events-none">
            <a
              href={linkHref('/collections')}
              className="pointer-events-auto inline-flex items-center gap-2 uppercase font-semibold tracking-[0.14em] md:tracking-wide-2 text-[10px] md:text-[11px] px-5 md:px-6 py-2.5 md:py-3 bg-black/40 border border-white/50 text-white rounded-md hover:bg-black/50 hover:border-white/70 transition-colors select-none animate-rise backdrop-blur-sm"
            >
              Explore Now <ArrowRight size={14} strokeWidth={2} />
            </a>
          </div>
        </div>
      </section>

      {/* ============ THE COLLECTION ============ */}
      {/* The one product section on the homepage, sitting directly under the
          full-bleed hero. The horizontal padding matches the product grids on
          CollectionPage and the PDP's related grid, so cards share one left edge
          with the hero's content rather than floating in a narrower column, and
          the top padding is small so the section reads as a continuation of the
          hero instead of a separate band. */}
      {productsError ? (
        <section className="shell pt-10 md:pt-16 pb-12 md:pb-20 flex flex-col items-center text-center">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-crimson">Couldn't Load Products</p>
          <p className="mt-2 text-sm text-crimson">The collection failed to load. Please try again.</p>
          <button
            onClick={() => setLoadKey((k) => k + 1)}
            className="mt-8 btn-dark text-[14px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
          >
            Try Again
          </button>
        </section>
      ) : (
        <FadeSwap loading={!productsLoaded} skeleton={<HomeProductSkeleton />}>
      {collection.length > 0 && (
        <section className="mx-auto w-full px-2 md:px-4 lg:px-6 xl:px-8 pt-10 md:pt-14 pb-14 md:pb-20">
        <Reveal className="mb-4 md:mb-7">
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
              THE COLLECTION
            </h2>
            <a
              href={linkHref('/collections')}
              className="shrink-0 font-label text-[10px] md:text-[11px] uppercase tracking-ultra font-semibold text-bone hover:text-bone-dim transition-colors"
            >
              View All →
            </a>
          </div>
        </Reveal>
          <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-5 gap-x-0.5 gap-y-5 md:gap-x-8 md:gap-y-8">
            {collection.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}
        </FadeSwap>
      )}
    </div>
  );
}