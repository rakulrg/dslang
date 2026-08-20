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

  return (
    <div>
      {/* HERO */}
      <section className="relative h-[50vh] md:h-[88vh] min-h-[320px] md:min-h-[520px] w-full overflow-hidden bg-paper-2">
        {slides.map((s, i) => (
          <div
            key={s.id}
            className={`absolute inset-0 transition-opacity duration-300 ${
              i === slide ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <img
              src={s.image_url}
              alt={s.title}
              loading="eager"
              decoding="async"
              className={`absolute inset-0 w-full h-full object-cover ${
                i === slide ? 'scale-105' : 'scale-100'
              } transition-transform duration-[6000ms] ease-out`}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/15 to-black/5" />
          </div>
        ))}

        <div className="relative z-10 h-full mx-auto px-6 md:px-12 lg:px-20 xl:px-28 flex flex-col justify-end pb-10 md:pb-14">
          <div key={slide} className="max-w-2xl animate-fade-up">
            {slides[slide].eyebrow && (
              <p className="font-label text-[10px] md:text-[11px] uppercase tracking-ultra text-white mb-2 md:mb-3 font-medium">
                {slides[slide].eyebrow}
              </p>
            )}
            <h1 className="font-display text-[12vw] md:text-[5.5rem] leading-[0.88] uppercase tracking-wide-2 text-white text-shadow-dark whitespace-pre-line">
              {slides[slide].title}
            </h1>
            <div className="mt-5 md:mt-7 flex flex-wrap items-center gap-3">
              <Button href={linkHref('/shop')} variant="primary">
                Shop The Drop <ArrowRight size={15} strokeWidth={2} />
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
                className={`h-1 transition-all duration-200 ${
                  i === slide ? 'w-10 bg-white' : 'w-5 bg-white/40 hover:bg-white/70'
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
