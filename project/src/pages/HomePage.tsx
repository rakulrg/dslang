import { useEffect, useState, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { ProductCard } from '@/components/ProductCard';
import { linkHref } from '@/lib/router';
import {
  fetchProducts,
  fetchHeroSlides,
  type CatalogProduct,
  type HeroSlideRow,
} from '@/lib/catalog';
import { preloadImage } from '@/lib/image';

const FALLBACK_HERO: HeroSlideRow[] = [
  {
    id: 'f1',
    image_url:
      'https://images.pexels.com/photos/30636000/pexels-photo-30636000.jpeg?auto=compress&cs=tinysrgb&w=1600',
    eyebrow: '',
    title: 'Wear The\nStruggle',
    subtitle: 'Limited run. Once it sells out, it is gone.',
    sort_order: 0,
    active: true,
    created_at: '',
  },
];

export function HomePage() {
  // Start empty (clean neutral hero) so no fallback/old image can flash before
  // the real slide data arrives. FALLBACK_HERO is only used if the fetch fails.
  const [slides, setSlides] = useState<HeroSlideRow[]>([]);
  // `target` is the slide navigation wants; `shown` is the slide whose image
  // has fully loaded and is therefore safe to display. They are kept separate
  // so an un-loaded incoming image can never flash over the current one.
  const [target, setTarget] = useState(0);
  const [shown, setShown] = useState(-1);
  const [products, setProducts] = useState<CatalogProduct[]>([]);

  useEffect(() => {
    fetchHeroSlides()
      .then((s) => setSlides(s.length > 0 ? s : FALLBACK_HERO))
      .catch(() => setSlides(FALLBACK_HERO));
    fetchProducts()
      .then(setProducts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (slides.length === 0) return;
    setTarget((t) => Math.min(t, slides.length - 1));
    // Warm the cache for every slide up front so slide changes never stall.
    slides.forEach((s) => {
      if (s.image_url) void preloadImage(s.image_url).catch(() => {});
    });
  }, [slides]);

  // Reveal a slide only after its image has fully loaded (or failed); while it
  // loads, the previously shown slide simply remains stable — never a flash
  // of the old asset for this slide, and never a blank pop-in mid-transition.
  useEffect(() => {
    const url = slides[target]?.image_url;
    if (!url) return;
    let cancelled = false;
    preloadImage(url)
      .catch(() => {})
      .then(() => { if (!cancelled) setShown(target); });
    return () => { cancelled = true; };
  }, [target, slides]);

  const next = useCallback(
    () => setTarget((t) => (slides.length > 0 ? (t + 1) % slides.length : 0)),
    [slides.length]
  );

  useEffect(() => {
    if (slides.length <= 1) return;
    const id = setInterval(next, 6000);
    return () => clearInterval(id);
  }, [next, slides.length]);

  return (
    <div>
      {/* HERO */}
      <section className="relative h-[50vh] md:h-[88vh] min-h-[320px] md:min-h-[520px] w-full overflow-hidden bg-paper-2">
        {slides.map((s, i) => (
          <div
            key={s.id}
            className={`absolute inset-0 transition-opacity duration-300 ${
              i === shown ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <img
              src={s.image_url}
              alt={s.title}
              loading="eager"
              decoding="async"
              className={`absolute inset-0 w-full h-full object-cover ${
                i === shown ? 'scale-105' : 'scale-100'
              } transition-transform duration-[6000ms] ease-out`}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/15 to-black/5" />
          </div>
        ))}

        <div className="relative z-10 h-full mx-auto px-6 md:px-12 lg:px-20 xl:px-28 flex flex-col justify-end pb-10 md:pb-14">
          {slides[shown] && (
            <div key={shown} className="max-w-2xl animate-fade-up">
              {slides[shown].eyebrow && (
                <p className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-white mb-2 md:mb-3 font-medium">
                  {slides[shown].eyebrow}
                </p>
              )}
              <h1 className="font-display text-[12vw] md:text-[5.5rem] leading-[0.88] uppercase tracking-wide-2 text-white text-shadow-dark whitespace-pre-line">
                {slides[shown].title}
              </h1>
              <div className="mt-5 md:mt-7 flex flex-wrap items-center gap-3">
                <Button href={linkHref('/shop')} variant="primary">
                  Shop The Drop <ArrowRight size={15} strokeWidth={2} />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Slide indicators */}
        {slides.length > 1 && (
          <div className="absolute bottom-6 right-5 md:right-8 z-10 flex items-center gap-2">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => setTarget(i)}
                aria-label={`Slide ${i + 1}`}
                className={`h-1 transition-all duration-200 ${
                  i === target ? 'w-10 bg-white' : 'w-5 bg-white/40 hover:bg-white/70'
                }`}
              />
            ))}
          </div>
        )}
      </section>

      {/* ALL PRODUCTS */}
      {products.length > 0 && (
        <section className="pt-4 md:pt-8 pb-8 md:pb-12 mx-auto px-2 md:px-12 lg:px-20 xl:px-28">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {products.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
