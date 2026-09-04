import { useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { ProductCard } from '@/components/ProductCard';
import { linkHref } from '@/lib/router';
import {
  fetchProducts,
  fetchHeroSlides,
  isRetailVisible,
  type CatalogProduct,
  type HeroSlideRow,
} from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { preloadImage } from '@/lib/image';

const WHY_DSLANG = [
  { title: 'Oversized Fit', body: 'Boxy, heavy-weight cuts that hold their shape wear after wear.' },
  { title: 'Heavy Quality', body: 'Premium 240 GSM combed cotton — built to last, designed to flex.' },
  { title: 'Fresh Drops', body: 'New colourways and graphics drop regularly — never stuck on repeat.' },
  { title: 'Easy Delivery', body: 'Pan-India dispatch in 24–48 hrs with simple size exchanges.' },
];

const STEPS = [
  { n: '01', t: 'Browse', d: 'Explore the streetwear collection and new drops.' },
  { n: '02', t: 'Pick', d: 'Choose your colour and M / L / XL size.' },
  { n: '03', t: 'Checkout', d: 'Add to bag, enter delivery details and place the order.' },
  { n: '04', t: 'Wear', d: 'Your piece ships in 24–48 hrs straight to your door.' },
];

export function HomePage() {
  const [slides, setSlides] = useState<HeroSlideRow[]>([]);
  const [target, setTarget] = useState(0);
  const [shown, setShown] = useState(-1);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const { settings } = useSiteSettings();

  useEffect(() => {
    fetchHeroSlides()
      .then((s) => setSlides(s))
      .catch(() => {});
    fetchProducts()
      .then((all) => setProducts(all.filter((p) => isRetailVisible(p))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (slides.length === 0) return;
    setTarget((t) => Math.min(t, slides.length - 1));
  }, [slides]);

  useEffect(() => {
    const url = slides[target]?.image_url;
    if (!url) return;
    let cancelled = false;
    preloadImage(url)
      .then(() => { if (!cancelled) setShown(target); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [target, slides]);

  const next = useCallback(
    () => setTarget((t) => (slides.length > 0 ? (t + 1) % slides.length : 0)),
    [slides.length]
  );

  useEffect(() => {
    if (slides.length <= 1) return;
    const id = setInterval(next, 7000);
    return () => clearInterval(id);
  }, [next, slides.length]);

  const featured = useMemo(() => products.filter((p) => p.featured).slice(0, 4), [products]);
  const newDrops = useMemo(() => {
    const flagged = products.filter((p) => p.new_drop).slice(0, 4);
    if (flagged.length > 0) return flagged;
    return [...products]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 4);
  }, [products]);
  const collection = useMemo(() => (featured.length > 0 ? featured : products.slice(0, 4)), [featured, products]);

  const slide = slides[target];
  const heroEyebrow = slide?.eyebrow?.trim() || 'DSLANG';
  const heroTitle = slide?.title?.trim() || 'SLANG OF DESIGN';
  const heroSubtitle = slide?.subtitle?.trim() || 'New Drops, Heavy Quality';
  const ctaText = slide?.cta_text?.trim() || 'Shop The Collection';
  const ctaUrl = slide?.cta_url?.trim() || linkHref('/collection');
  const ctaExternal = ctaUrl.startsWith('http');

  return (
    <div>
      {/* ============ HERO — mobile 1:1 full-bleed, desktop landscape ============ */}
      <section className="w-full overflow-hidden bg-ink">
        <div className="relative w-full aspect-square md:aspect-auto md:h-[78vh] md:min-h-[520px] overflow-hidden bg-paper-3">
            {slides.map((s, i) => (
              <div
                key={s.id}
                className={`absolute inset-0 transition-opacity duration-300 ${
                  i === shown ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <img
                  src={s.image_url}
                  alt=""
                  loading={i === shown ? 'eager' : 'lazy'}
                  fetchPriority={i === shown ? 'high' : 'low'}
                  decoding="async"
                  className={`absolute inset-0 w-full h-full object-cover ${
                    i === shown ? 'scale-105' : 'scale-100'
                  } transition-transform duration-[7000ms] ease-out`}
                />
              </div>
            ))}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/20" />

            <div key={shown} className="absolute inset-x-0 bottom-0 z-10 p-5 md:p-8 text-center animate-fade-up">
              <div className="mx-auto w-full max-w-4xl">
              <p className="font-label text-[10px] md:text-xs uppercase tracking-ultra text-white/70 mb-2 font-medium">
                {heroEyebrow}
              </p>
              <h1 className="font-display text-[clamp(2rem,9vw,4rem)] leading-[0.88] uppercase tracking-wide-2 text-white text-shadow-dark text-balance break-words">
                {heroTitle}
              </h1>
              <p className="mt-3 font-label text-[11px] md:text-sm uppercase tracking-[0.28em] text-white/90">
                {heroSubtitle}
              </p>
              <div className="mt-6 md:mt-7 flex flex-wrap justify-center gap-3">
                {ctaExternal ? (
                  <Button href={ctaUrl} external variant="primary">
                    {ctaText} <ArrowRight size={15} strokeWidth={2} />
                  </Button>
                ) : (
                  <Button href={ctaUrl} variant="primary">
                    {ctaText} <ArrowRight size={15} strokeWidth={2} />
                  </Button>
                )}
                <Button href={linkHref('/stock-dslang')} variant="outline-light">
                  Explore DSLANG
                </Button>
              </div>
              </div>
            </div>

            {slides.length > 1 && (
              <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                {slides.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setTarget(i)}
                    aria-label={`Slide ${i + 1}`}
                    className={`h-1 transition-all duration-200 ${
                      i === target ? 'w-8 bg-white' : 'w-4 bg-white/40 hover:bg-white/70'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
      </section>

      {/* ============ COLLECTION ============ */}
      {collection.length > 0 && (
        <section className="mx-auto px-2 md:px-12 lg:px-20 xl:px-28 pt-10 md:pt-16 pb-2">
          <div className="flex items-end justify-between px-2 md:px-0 mb-4 md:mb-8">
            <div>
              <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">The Collection</p>
              <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
                New In
              </h2>
            </div>
            <a
              href={linkHref('/collection')}
              className="font-label text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
            >
              View All →
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {collection.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* ============ NEW DROPS ============ */}
      {newDrops.length > 0 && (
        <section className="mx-auto px-2 md:px-12 lg:px-20 xl:px-28 pt-10 md:pt-16 pb-8 md:pb-12">
          <div className="flex items-end justify-between px-2 md:px-0 mb-4 md:mb-8">
            <div>
              <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">Latest Drops</p>
              <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
                Fresh Off The Print Table
              </h2>
            </div>
            <a
              href={linkHref('/new-drops')}
              className="font-label text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
            >
              View All →
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {newDrops.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* ============ WHY DSLANG ============ */}
      <section className="py-12 md:py-20 mx-auto px-5 md:px-12 lg:px-20 xl:px-28 bg-concrete border-y border-line">
        <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">Why DSLANG</p>
        <h2 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-[0.9] max-w-3xl">
          Made For The Spot
        </h2>
        <div className="mt-8 md:mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          {WHY_DSLANG.map((w) => (
            <div key={w.title} className="border border-line bg-white p-5 md:p-7">
              <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">
                {w.title}
              </p>
              <p className="mt-3 text-sm text-bone-soft leading-relaxed">{w.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section className="py-12 md:py-20 mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">The Process</p>
        <h2 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-[0.9]">
          How It Works
        </h2>
        <div className="mt-8 md:mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          {STEPS.map((s) => (
            <div key={s.n} className="border-t border-line pt-4">
              <p className="font-display text-2xl text-crimson">{s.n}</p>
              <p className="mt-2 font-label text-sm uppercase tracking-[0.14em] font-semibold text-bone">
                {s.t}
              </p>
              <p className="mt-2 text-xs text-bone-dim leading-relaxed">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Button href={linkHref('/how-it-works')} variant="outline">
            See Full Process <ArrowRight size={15} strokeWidth={2} />
          </Button>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="bg-ink py-14 md:py-20">
        <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28 max-w-5xl text-center">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-3">New Drops Weekly</p>
          <h2 className="font-display text-4xl md:text-7xl uppercase tracking-wide-2 text-white leading-[0.9]">
            Ready To Wear The Slang?
          </h2>
          <p className="mt-5 text-sm md:text-base text-white/70 max-w-2xl mx-auto leading-relaxed">
            Shop the latest streetwear drops — oversized fits, heavy quality, shipped pan-India in 24–48 hrs.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button href={linkHref('/collection')} variant="primary">
              Shop Now <ArrowRight size={15} strokeWidth={2} />
            </Button>
            <Button href={linkHref('/contact')} variant="outline-light">
              Talk To Us
            </Button>
          </div>
          <p className="mt-8 text-[11px] uppercase tracking-[0.2em] text-white/50">
            Pan-India delivery · {settings.delivery_note} Dispatch · Easy size exchanges
          </p>
        </div>
      </section>
    </div>
  );
}