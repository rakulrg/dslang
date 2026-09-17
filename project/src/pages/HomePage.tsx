import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { ProductCard, PRODUCT_IMAGE_FALLBACK } from '@/components/ProductCard';
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
import { preloadImages } from '@/lib/image';

/* Hero — a single horizontal image track. ONLY the hero images slide: a
   translateX on the track inside its own overflow-hidden section. There is no
   text, no overlays and no fade/blur/zoom/scale/parallax/3D. Autoplay every
   3s, ~450ms transition, touch swipe, and every manual interaction resets the
   autoplay timer. A single fixed "Explore Now" CTA sits at the bottom-center
   on top of the hero image — it is NOT part of the sliding track.

   Loading safety: slides without an image URL are skipped, any slide whose
   image fails to load is dropped immediately (with the carousel never left
   pointing past the end), the active + next image are preloaded so transitions
   are instant, and if NOTHING can be shown the hero renders the branded
   placeholder instead of a bare black screen. */
const SLIDE_TRANSITION_MS = 450;
const SLIDE_INTERVAL_MS = 3000;
const SWIPE_THRESHOLD_PX = 48;

export function HomePage() {
  const [slides, setSlides] = useState<HeroSlideRow[]>([]);
  const [failedSlides, setFailedSlides] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState(0);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [productsError, setProductsError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const timerRef = useRef<number | null>(null);
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
      .catch((err) => console.error('HomePage: failed to load hero slides.', err));
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

  // Slides to actually show: every non-failed slide with an image URL. A slide
  // is moved to `failedSlides` when its image request errors, so the carousel
  // can never get stuck on a broken image (or a permanent black slide).
  const usableSlides = useMemo(
    () => slides.filter((s) => s.image_url && !failedSlides.has(s.id)),
    [slides, failedSlides]
  );

  // Whenever a fresh slide set loads, reset failure tracking and start at 0.
  useEffect(() => {
    setFailedSlides(new Set());
    setTarget(0);
  }, [slides]);

  // Keep the active index in range when slides are dropped/fail.
  useEffect(() => {
    if (usableSlides.length === 0) return;
    setTarget((t) => Math.min(t, usableSlides.length - 1));
  }, [usableSlides.length]);

  // Warm every slide image once up front (deduped, so each URL hits the
  // network exactly once). Slides that fail to preload are dropped before
  // they are ever painted.
  useEffect(() => {
    let cancelled = false;
    preloadImages(usableSlides.map((s) => s.image_url)).then(({ failed }) => {
      if (cancelled || failed.length === 0) return;
      const failedIds = new Set(failed);
      setFailedSlides((prev) => {
        const next = new Set(prev);
        for (const s of usableSlides) {
          if (failedIds.has(s.image_url)) next.add(s.id);
        }
        return next.size === prev.size ? prev : next;
      });
    });
    return () => { cancelled = true; };
  }, [usableSlides]);

  // Preload the ACTIVE and NEXT slide on every change, so sliding into the
  // next image is instant (no flash/black while bytes stream in).
  useEffect(() => {
    if (usableSlides.length === 0) return;
    const nextIndex = (target + 1) % usableSlides.length;
    preloadImages([usableSlides[target].image_url, usableSlides[nextIndex].image_url]);
  }, [target, usableSlides]);

  const handleImageError = useCallback((id: string) => {
    setFailedSlides((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Autoplay: advance every 3s. The timer is restarted by every manual
  // interaction (indicators, swipe) via restartTimer().
  const restartTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (usableSlides.length <= 1) return;
    timerRef.current = window.setInterval(() => {
      setTarget((t) => (t + 1) % usableSlides.length);
    }, SLIDE_INTERVAL_MS);
  }, [usableSlides.length]);

  useEffect(() => {
    restartTimer();
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [restartTimer]);

  const goTo = useCallback(
    (i: number) => {
      if (usableSlides.length === 0) return;
      setTarget(((i % usableSlides.length) + usableSlides.length) % usableSlides.length);
      restartTimer();
    },
    [usableSlides.length, restartTimer]
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || usableSlides.length <= 1) return;
    setTarget((t) => (t + (dx > 0 ? -1 : 1) + usableSlides.length) % usableSlides.length);
    restartTimer();
  };

  const featured = useMemo(() => products.filter((p) => p.featured).slice(0, 4), [products]);
  const newDrops = useMemo(() => {
    const flagged = products.filter((p) => p.new_drop).slice(0, 4);
    if (flagged.length > 0) return flagged;
    return [...products]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 4);
  }, [products]);
  const collection = useMemo(() => (featured.length > 0 ? featured : products.slice(0, 4)), [featured, products]);

  return (
    <div>
      {/* ============ HERO — mobile 1:1 full-bleed, desktop landscape ============ */}
      <section className="w-full overflow-hidden bg-ink">
        <div className="relative w-full aspect-square md:aspect-auto md:h-[78vh] md:min-h-[520px] overflow-hidden bg-ink">
          {usableSlides.length === 0 ? (
            <img
              src={PRODUCT_IMAGE_FALLBACK}
              alt=""
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
            />
          ) : (
            <>
              <div
                className="absolute inset-0 flex select-none touch-pan-y"
                style={{
                  transform: `translate3d(-${target * 100}%, 0, 0)`,
                  transition: `transform ${SLIDE_TRANSITION_MS}ms ease`,
                }}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
              >
                {usableSlides.map((s, i) => (
                  <div key={s.id} className="relative w-full h-full shrink-0 bg-ink">
                    {s.image_url && (
                      <img
                        src={s.image_url}
                        alt=""
                        loading={Math.abs(i - target) <= 1 ? 'eager' : 'lazy'}
                        fetchPriority={i === target ? 'high' : 'auto'}
                        decoding="async"
                        draggable={false}
                        onError={() => handleImageError(s.id)}
                        {...responsiveSrc(s.image_url, [480, 768, 1200])}
                        className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
                      />
                    )}
                  </div>
                ))}
              </div>

              {usableSlides.length > 1 && (
                <div className="absolute top-3 right-2 md:right-4 lg:right-6 xl:right-8 z-10 flex items-center gap-2">
                  {usableSlides.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => goTo(i)}
                      aria-label={`Slide ${i + 1}`}
                      className={`h-1 transition-all duration-200 ${
                        i === target ? 'w-8 bg-white' : 'w-4 bg-white/40 hover:bg-white/70'
                      }`}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Editorial grain + soft bottom scrim — decorative only, never
              intercepts swipes/clicks (pointer-events-none). */}
          <div className="absolute inset-0 z-[6] pointer-events-none select-none hero-grain" aria-hidden="true" />
          <div
            className="absolute inset-x-0 bottom-0 h-3/5 md:h-2/3 bg-gradient-to-t from-black/55 via-black/15 to-transparent pointer-events-none select-none"
            aria-hidden="true"
          />

          {/* Editorial micro-labels — brand mark and tagline. Positioned at the
              edges (aligned to the section padding below), clear of the image
              subject and the bottom-center CTA. */}
          <div className="absolute top-3.5 md:top-6 left-2 md:left-4 lg:left-6 xl:left-8 z-10 flex flex-col items-start gap-1 pointer-events-none select-none" aria-hidden="true">
            <span className="font-display uppercase tracking-wide-2 text-white leading-none text-lg md:text-2xl text-shadow-dark">DSLANG</span>
            <span className="font-label uppercase tracking-ultra text-[8px] md:text-[10px] text-white/70">Slang of Design</span>
          </div>

          <div className="hidden lg:block absolute right-6 xl:right-8 top-1/2 -translate-y-1/2 z-10 pointer-events-none select-none" aria-hidden="true">
            <span className="font-label uppercase tracking-ultra text-[10px] text-white/60 writing-vertical">
              DS / Archive — Worldwide Dept.
            </span>
          </div>

          <div className="hidden lg:flex absolute left-6 xl:left-8 bottom-8 z-10 items-center gap-3 pointer-events-none select-none" aria-hidden="true">
            <span className="h-px w-8 bg-white/40" />
            <span className="font-label uppercase tracking-ultra text-[10px] text-white/75">EST. 2025</span>
          </div>

          {/* Fixed CTA — bottom-center overlay on the hero, never inside the
              sliding track, so it does not move with the slides. */}
          <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-6 md:pb-8 pointer-events-none">
            <a
              href={linkHref('/collection')}
              className="pointer-events-auto inline-flex items-center gap-2 uppercase font-semibold tracking-[0.14em] md:tracking-wide-2 text-[10px] md:text-[11px] px-5 md:px-6 py-2.5 md:py-3 bg-black/30 border border-white/40 text-white rounded-md hover:bg-black/40 hover:border-white/60 transition-colors select-none"
            >
              Explore Now <ArrowRight size={14} strokeWidth={2} />
            </a>
          </div>
        </div>
      </section>

      {/* ============ COLLECTION ============ */}
      {productsError ? (
        <section className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28 pt-10 md:pt-16 pb-12 md:pb-20 flex flex-col items-center text-center">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Couldn't Load Products</p>
          <p className="mt-2 text-sm text-grey">The collection failed to load. Please try again.</p>
          <button
            onClick={() => setLoadKey((k) => k + 1)}
            className="mt-8 btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
          >
            Try Again
          </button>
        </section>
      ) : (
        <FadeSwap loading={!productsLoaded} skeleton={<HomeProductSkeleton />}>
      {collection.length > 0 && (
        <section className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8 pt-6 md:pt-10 pb-2">
          <div className="flex items-end justify-between mb-3 md:mb-6 md:px-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 md:gap-3 mb-2 md:mb-3">
                <span className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-grey">01</span>
                <span className="h-px w-8 md:w-12 bg-bone/25" aria-hidden="true" />
                <span className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-bone-dim">The Collection</span>
              </div>
              <h2 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none">
                New In
              </h2>
            </div>
            <a
              href={linkHref('/collection')}
              className="shrink-0 font-label text-[10px] md:text-[11px] uppercase tracking-ultra font-semibold text-bone hover:text-bone-dim transition-colors"
            >
              View All →
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-0.5 gap-y-5 md:gap-x-8 md:gap-y-8">
            {collection.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
          <div className="mt-5 md:mt-8 flex items-center justify-between border-t border-line pt-2.5 md:pt-3">
            <span className="font-label text-[9px] md:text-[10px] uppercase tracking-ultra text-grey">
              {collection.length} pieces — new arrivals
            </span>
            <span className="hidden md:inline font-label text-[9px] md:text-[10px] uppercase tracking-ultra text-grey">Slang of Design</span>
          </div>
        </section>
      )}

      {newDrops.length > 0 && (
        <section className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8 pt-10 md:pt-14 pb-12 md:pb-20">
          <div className="flex items-end justify-between mb-3 md:mb-6 md:px-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 md:gap-3 mb-2 md:mb-3">
                <span className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-grey">02</span>
                <span className="h-px w-8 md:w-12 bg-bone/25" aria-hidden="true" />
                <span className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-bone-dim">New Drops</span>
              </div>
              <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
                Fresh Off The Print Table
              </h2>
            </div>
            <a
              href={linkHref('/new-drops')}
              className="shrink-0 font-label text-[10px] md:text-[11px] uppercase tracking-ultra font-semibold text-bone hover:text-bone-dim transition-colors"
            >
              View All →
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-0.5 gap-y-5 md:gap-x-8 md:gap-y-8">
            {newDrops.map((p, i) => (
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