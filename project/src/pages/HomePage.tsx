import { useEffect, useState, useCallback } from 'react';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button, SectionHeading } from '@/components/Button';
import { ProductCard } from '@/components/ProductCard';
import { linkHref } from '@/lib/router';
import {
  fetchProducts,
  fetchHeroSlides,
  buildWhatsAppGeneralUrl,
  INSTAGRAM_URL,
  type CatalogProduct,
  type HeroSlideRow,
} from '@/lib/catalog';
import { Instagram } from '@/components/icons/Instagram';

const FALLBACK_HERO: HeroSlideRow[] = [
  {
    id: 'f1',
    image_url:
      'https://images.pexels.com/photos/30636000/pexels-photo-30636000.jpeg?auto=compress&cs=tinysrgb&w=1600',
    eyebrow: 'Drop 01 — Limited Run',
    title: 'Wear The\nStruggle',
    subtitle: 'Limited run. Once it sells out, it is gone.',
    sort_order: 0,
    active: true,
    created_at: '',
  },
];

const UGC_IMAGES = [
  'https://images.pexels.com/photos/5975344/pexels-photo-5975344.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
  'https://images.pexels.com/photos/15984691/pexels-photo-15984691.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
  'https://images.pexels.com/photos/18856590/pexels-photo-18856590.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
  'https://images.pexels.com/photos/16649942/pexels-photo-16649942.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
  'https://images.pexels.com/photos/30186079/pexels-photo-30186079.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
  'https://images.pexels.com/photos/13046261/pexels-photo-13046261.jpeg?auto=compress&cs=tinysrgb&h=400&w=400',
];

export function HomePage() {
  const [slides, setSlides] = useState<HeroSlideRow[]>(FALLBACK_HERO);
  const [slide, setSlide] = useState(0);
  const [products, setProducts] = useState<CatalogProduct[]>([]);

  useEffect(() => {
    fetchHeroSlides()
      .then((s) => { if (s.length > 0) setSlides(s); })
      .catch(() => {});
    fetchProducts()
      .then(setProducts)
      .catch(() => {});
  }, []);

  const next = useCallback(() => setSlide((s) => (s + 1) % slides.length), [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const id = setInterval(next, 6000);
    return () => clearInterval(id);
  }, [next, slides.length]);

  const featured = products.filter((p) => p.featured);
  const gridProducts = featured.length > 0 ? featured : products;

  return (
    <div>
      {/* HERO */}
      <section className="relative h-[88vh] min-h-[520px] w-full overflow-hidden bg-paper-2">
        {slides.map((s, i) => (
          <div
            key={s.id}
            className={`absolute inset-0 transition-opacity duration-1000 ${
              i === slide ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <img
              src={s.image_url}
              alt={s.title}
              decoding="async"
              className={`absolute inset-0 w-full h-full object-cover ${
                i === slide ? 'scale-105' : 'scale-100'
              } transition-transform duration-[6000ms] ease-out`}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/15 to-black/5" />
          </div>
        ))}

        <div className="relative z-10 h-full mx-auto max-w-[1400px] px-5 md:px-8 flex flex-col justify-end pb-14 md:pb-20">
          <div key={slide} className="max-w-2xl animate-fade-up">
            <p className="text-[10px] md:text-[11px] uppercase tracking-ultra text-white mb-3 md:mb-4 font-medium">
              {slides[slide].eyebrow}
            </p>
            <h1 className="font-display text-[12vw] md:text-[5.5rem] leading-[0.88] uppercase tracking-wide-2 text-white text-shadow-dark whitespace-pre-line">
              {slides[slide].title}
            </h1>
            <div className="mt-7 md:mt-9 flex flex-wrap items-center gap-3">
              <Button href={linkHref('/shop')} variant="primary">
                Shop The Drop <ArrowRight size={15} strokeWidth={2} />
              </Button>
              <Button
                href={buildWhatsAppGeneralUrl('Hi DSLANG! I want to join the drop list. Please add me.')}
                external
                variant="outline-light"
              >
                Join Drop List
              </Button>
            </div>
          </div>
        </div>

        {/* Slide indicators */}
        {slides.length > 1 && (
          <div className="absolute bottom-6 right-5 md:right-8 z-10 flex items-center gap-2">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => setSlide(i)}
                aria-label={`Slide ${i + 1}`}
                className={`h-1 transition-all duration-500 ${
                  i === slide ? 'w-10 bg-white' : 'w-5 bg-white/40 hover:bg-white/70'
                }`}
              />
            ))}
          </div>
        )}
      </section>

      {/* FEATURED DESIGNS */}
      {gridProducts.length > 0 && (
        <section className="py-10 md:py-16 mx-auto max-w-[1400px] px-5 md:px-8">
          <SectionHeading eyebrow="Limited Run" title="Featured Designs" />
          <div className="mt-6 md:mt-10 grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {gridProducts.slice(0, 4).map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* BEST SELLERS GRID */}
      {gridProducts.length > 0 && (
        <section className="py-10 md:py-16 mx-auto max-w-[1400px] px-5 md:px-8">
          <div className="flex items-end justify-between gap-6 mb-6 md:mb-10">
            <SectionHeading eyebrow="Limited Run" title="Best Sellers" />
            <a
              href={linkHref('/shop')}
              className="hidden sm:flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-crimson transition-colors group"
            >
              View All <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" strokeWidth={2} />
            </a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {gridProducts.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* INSTAGRAM / UGC STRIP */}
      <section className="py-10 md:py-16">
        <div className="mx-auto max-w-[1400px] px-5 md:px-8">
          <div className="text-center mb-8 md:mb-12">
            <SectionHeading eyebrow="@dslang.in" title="Follow The Drop" align="center" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 md:gap-3">
            {UGC_IMAGES.map((src, i) => (
              <a
                key={i}
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="relative aspect-square overflow-hidden group bg-paper-3 border border-line"
              >
                <img
                  src={src}
                  alt="DSLANG on Instagram"
                  loading="lazy"
              decoding="async"
                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors duration-300 flex items-center justify-center">
                  <Instagram
                    size={22}
                    className="text-white opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    strokeWidth={1.6}
                  />
                </div>
              </a>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button href={INSTAGRAM_URL} external variant="outline">
              <Instagram size={15} strokeWidth={1.8} /> Follow @dslang.in
            </Button>
          </div>
        </div>
      </section>

      {/* WHATSAPP COMMUNITY BLOCK */}
      <section className="border-t border-line bg-paper-2">
        <div className="mx-auto max-w-[1400px] px-5 md:px-8 py-12 md:py-20 text-center">
          <MessageCircle size={32} className="text-crimson mx-auto mb-5" strokeWidth={1.6} />
          <p className="text-[11px] uppercase tracking-ultra text-crimson mb-4 font-medium">Join The List</p>
          <h2 className="font-display text-4xl md:text-7xl uppercase tracking-wide-2 text-bone leading-[0.95]">
            Never Miss A Drop
          </h2>
          <p className="mt-6 text-sm md:text-base text-bone-dim max-w-lg mx-auto leading-relaxed">
            Get first access to every drop and restock alerts.
          </p>
          <div className="mt-8">
            <Button
              href={buildWhatsAppGeneralUrl('Hi DSLANG! I want to join the drop list. Please add me.')}
              external
              variant="primary"
            >
              <MessageCircle size={16} strokeWidth={2} /> Join WhatsApp Drop List
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
