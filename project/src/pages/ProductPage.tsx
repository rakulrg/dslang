import { useEffect, useState, useRef, useCallback, memo } from 'react';
import { Minus, Plus, MessageCircle, ChevronLeft, ChevronRight, ShoppingBag, CheckCircle2, X, AlertTriangle, Lock } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  getWholesaleSlabs,
  getWholesaleTier,
  getPackConfig,
  packToQuantities,
  buildWholesaleWhatsAppUrl,
  formatPerUnit,
  formatPrice,
  MIN_PACKS,
  MIN_ORDER_PCS,
  TIER_100_PCS,
  type CatalogProduct,
  type WholesaleSkuLine,
} from '@/lib/catalog';
import { notFound } from '@/lib/notFound';
import { useCart } from '@/lib/cart';
import { LoadingDots } from '@/components/LoadingDots';

/* ---- Swipe Gallery ---- */

const SwipeGallery = memo(function SwipeGallery({
  images,
  productName,
  colorName,
  onImageClick,
  onIndexChange,
  showDotRow = true,
}: {
  images: string[];
  productName: string;
  colorName: string;
  onImageClick: () => void;
  onIndexChange: (i: number) => void;
  showDotRow?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: 0, behavior: 'instant' });
    activeIdxRef.current = 0;
    setActiveIdx(0);
  }, [colorName]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    slideRefs.current = Array.from(container.children) as HTMLDivElement[];
  }, [colorName]);

  useEffect(() => {
    const container = scrollRef.current;
    const slides = slideRefs.current.filter(Boolean) as HTMLDivElement[];
    if (!container || slides.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const i = slides.indexOf(entry.target as HTMLDivElement);
            if (i !== -1 && i !== activeIdxRef.current) {
              activeIdxRef.current = i;
              setActiveIdx(i);
              onIndexChange(i);
              break;
            }
          }
        }
      },
      { root: container, threshold: 0.5 },
    );

    slides.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [colorName, onIndexChange]);

  const scrollTo = useCallback((i: number) => {
    slideRefs.current[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    if (activeIdxRef.current !== i) {
      activeIdxRef.current = i;
      setActiveIdx(i);
      onIndexChange(i);
    }
  }, [onIndexChange]);

  const prev = useCallback(() => {
    const i = Math.max(0, activeIdxRef.current - 1);
    scrollTo(i);
  }, [scrollTo]);

  const next = useCallback(() => {
    const i = Math.min(images.length - 1, activeIdxRef.current + 1);
    scrollTo(i);
  }, [scrollTo, images.length]);

  return (
    <div className="flex flex-col">
      <div className="-mx-6 w-[calc(100%+3rem)] md:mx-0 md:w-full md:max-w-[550px]">
        <div className="group/gallery relative">
          <div
            ref={scrollRef}
            className="flex overflow-x-auto no-scrollbar"
            style={{ WebkitOverflowScrolling: 'touch', scrollSnapType: 'x mandatory' }}
          >
            {images.map((img, i) => (
              <Slide
                key={`${colorName}-${i}`}
                img={img}
                productName={productName}
                colorName={colorName}
                slideIndex={i}
                onImageClick={onImageClick}
              />
            ))}
          </div>
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                className="hidden md:flex absolute left-3 top-1/2 -translate-y-1/2 z-10 h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white opacity-0 group-hover/gallery:opacity-100 transition-opacity backdrop-blur-sm hover:bg-black/60"
                aria-label="Previous image"
              >
                <ChevronLeft size={20} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); next(); }}
                className="hidden md:flex absolute right-3 top-1/2 -translate-y-1/2 z-10 h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white opacity-0 group-hover/gallery:opacity-100 transition-opacity backdrop-blur-sm hover:bg-black/60"
                aria-label="Next image"
              >
                <ChevronRight size={20} />
              </button>
            </>
          )}
        </div>
      </div>
      {showDotRow && <DotRow images={images} activeIdx={activeIdx} scrollTo={scrollTo} />}
    </div>
  );
});

const Slide = memo(function Slide({
  img,
  productName,
  colorName,
  slideIndex,
  onImageClick,
}: {
  img: string;
  productName: string;
  colorName: string;
  slideIndex: number;
  onImageClick: () => void;
}) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const touchHandled = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    touchHandled.current = false;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = Math.abs(e.changedTouches[0].clientX - touchStart.current.x);
    const dy = Math.abs(e.changedTouches[0].clientY - touchStart.current.y);
    touchStart.current = null;
    if (dx < 10 && dy < 10) {
      touchHandled.current = true;
      onImageClick();
    }
  }, [onImageClick]);

  return (
    <div
      className="relative shrink-0 w-full cursor-pointer"
      style={{ flex: '0 0 100%', scrollSnapAlign: 'center', aspectRatio: '4 / 5' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onClick={() => { if (!touchHandled.current) onImageClick(); }}
    >
      <img
        src={img}
        alt={`${productName} — ${colorName} ${slideIndex + 1}`}
        loading="eager"
        fetchPriority={slideIndex === 0 ? 'high' : 'auto'}
        decoding="async"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
        draggable={false}
      />
    </div>
  );
});

const DotRow = memo(function DotRow({
  images,
  activeIdx,
  scrollTo,
}: {
  images: string[];
  activeIdx: number;
  scrollTo: (i: number) => void;
}) {
  if (images.length <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 pt-2 pb-0">
      {images.map((_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => scrollTo(i)}
          className={`w-2 h-2 rounded-full transition-colors ${i === activeIdx ? 'bg-bone' : 'bg-grey/30'}`}
          aria-label={`View image ${i + 1}`}
        />
      ))}
    </div>
  );
});

/* ---- Desktop Gallery (vertical thumbnails + main image) ---- */

function DesktopGallery({
  images,
  productName,
  colorName,
  onImageClick,
  onIndexChange,
}: {
  images: string[];
  productName: string;
  colorName: string;
  onImageClick: () => void;
  onIndexChange: (i: number) => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    setActiveIdx(0);
    onIndexChange(0);
  }, [colorName, onIndexChange]);

  const select = (i: number) => {
    setActiveIdx(i);
    onIndexChange(i);
  };

  return (
    <div className="flex gap-2.5">
      {images.length > 1 && (
        <div className="flex flex-col gap-[10px] shrink-0">
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => select(i)}
              className={`w-[90px] h-[113px] shrink-0 overflow-hidden border transition-all duration-150 ${
                i === activeIdx ? 'border-bone' : 'border-line opacity-60 hover:opacity-100'
              }`}
            >
              <img src={img} alt="" className="w-full h-full object-cover" draggable={false} />
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onImageClick}
          className="relative block w-full max-w-[650px] mx-auto cursor-zoom-in border border-line overflow-hidden"
          style={{ aspectRatio: '4 / 5' }}
        >
          <img
            src={images[activeIdx]}
            alt={`${productName} — ${colorName}`}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
            draggable={false}
          />
        </button>
      </div>
    </div>
  );
}

/* ---- Lightbox Viewer ---- */

function LightboxViewer({
  images,
  idx,
  setIdx,
  onClose,
  productName,
  colorName,
}: {
  images: string[];
  idx: number;
  setIdx: (i: number) => void;
  onClose: () => void;
  productName: string;
  colorName: string;
}) {
  const touchStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setIdx(Math.max(0, idx - 1));
      if (e.key === 'ArrowRight') setIdx(Math.min(images.length - 1, idx + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, images.length, onClose, setIdx]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) setIdx(Math.min(images.length - 1, idx + 1));
      else setIdx(Math.max(0, idx - 1));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`${productName} enlarged image`}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute right-4 top-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label="Close image viewer"
      >
        <X size={22} />
      </button>

      {images.length > 1 && idx > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setIdx(idx - 1); }}
          className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          aria-label="Previous image"
        >
          <ChevronLeft size={22} />
        </button>
      )}

      {images.length > 1 && idx < images.length - 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setIdx(idx + 1); }}
          className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          aria-label="Next image"
        >
          <ChevronRight size={22} />
        </button>
      )}

      <img
        src={images[idx]}
        alt={`${productName} — ${colorName}`}
        className="max-h-full max-w-full select-none object-contain"
        onClick={(e) => e.stopPropagation()}
        key={`${images[idx]}-${idx}`}
      />

      {images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); setIdx(i); }}
              className={`w-2 h-2 rounded-full transition-colors ${i === idx ? 'bg-white' : 'bg-white/30'}`}
              aria-label={`View image ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Wholesale Color-Pack Stepper ---- */

function PackStepper({
  label,
  packs,
  work,
}: {
  label: string;
  packs: number;
  work: (next: number) => void;
}) {
  return (
    <div className="inline-flex items-center border border-line bg-white">
      <button
        onClick={() => work(Math.max(0, packs - 1))}
        disabled={packs <= 0}
        className="w-10 h-11 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={`Decrease ${label} packs`}
      >
        <Minus size={15} strokeWidth={2} />
      </button>
      <span className="w-10 text-center text-base font-semibold tabular-nums text-bone select-none">
        {packs}
      </span>
      <button
        onClick={() => work(packs + 1)}
        className="w-10 h-11 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
        aria-label={`Increase ${label} packs`}
      >
        <Plus size={15} strokeWidth={2} />
      </button>
    </div>
  );
}

/* ---- Product Page ---- */

export function ProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<CatalogProduct | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [related, setRelated] = useState<CatalogProduct[]>([]);

  const [colorIdx, setColorIdx] = useState(0);
  const [packsByColor, setPacksByColor] = useState<Record<string, number>>({});
  const [imgIdx, setImgIdx] = useState(0);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [addedFeedback, setAddedFeedback] = useState(false);

  const { addItem, open: openCart } = useCart();

  useEffect(() => {
    let cancelled = false;
    setProduct(undefined);
    setLoadError(false);
    setColorIdx(0);
    setPacksByColor({});
    setImgIdx(0);
    fetchProduct(slug)
      .then((p) => {
        if (cancelled) return;
        setProduct(p);
        if (p) {
          const init: Record<string, number> = {};
          for (const c of p.colors) init[c.id] = 0;
          setPacksByColor(init);
          fetchProducts()
            .then((all) => { if (!cancelled) setRelated(all.filter((x) => x.slug !== p.slug).slice(0, 3)); })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProduct(null);
        setLoadError(true);
      });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (!isImageViewerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsImageViewerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isImageViewerOpen]);

  const openImageViewer = useCallback(() => setIsImageViewerOpen(true), []);
  const handleIndexChange = useCallback((i: number) => setImgIdx(i), []);

  if (product === null) {
    if (loadError) {
      return (
        <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-5">
          <p className="font-display text-5xl md:text-7xl uppercase tracking-wide-2 text-bone leading-none">!</p>
          <p className="mt-5 text-sm uppercase tracking-wide-2 text-grey">Failed to load product.</p>
          <button
            onClick={() => {
              setProduct(undefined);
              setLoadError(false);
              fetchProduct(slug)
                .then((p) => { setProduct(p); if (p) { const init: Record<string, number> = {}; for (const c of p.colors) init[c.id] = 0; setPacksByColor(init); } })
                .catch(() => { setProduct(null); setLoadError(true); });
            }}
            className="mt-8 inline-flex items-center text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-3.5 hover:bg-crimson-dark transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }
    return notFound();
  }
  if (product === undefined) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const color = product.colors[colorIdx];
  if (!color) return notFound();
  const images = color.images.filter((image) => image.trim().length > 0);
  const safeImgIdx = Math.max(0, Math.min(imgIdx, images.length - 1));

  const slabs = getWholesaleSlabs(product);
  const packCfg = getPackConfig();

  const setPacks = (colorIndex: number, packs: number) => {
    const c = product.colors[colorIndex];
    if (!c) return;
    setPacksByColor((prev) => ({ ...prev, [c.id]: Math.max(0, Math.floor(packs)) }));
  };

  const colorLines = product.colors.map((c) => {
    const packs = packsByColor[c.id] ?? 0;
    return { color: c, ...packToQuantities(packs, packCfg) };
  });

  const totalQty = colorLines.reduce((sum, cl) => sum + cl.qty, 0);
  const belowMinTotal = totalQty > 0 && totalQty < MIN_ORDER_PCS;
  const canOrder = totalQty >= MIN_ORDER_PCS;

  const tier = getWholesaleTier(totalQty, slabs);

  const buildLines = (): WholesaleSkuLine[] =>
    colorLines
      .filter((cl) => cl.packs > 0)
      .map((cl) => ({
        productId: product.id,
        name: product.name,
        code: product.code,
        color: cl.color.name,
        colorHex: cl.color.hex,
        image: cl.color.images[0] ?? '',
        slug: product.slug,
        packs: cl.packs,
        m: cl.m,
        l: cl.l,
        xl: cl.xl,
        qty: cl.qty,
        price50: slabs.price50,
        price100: slabs.price100,
      }));

  const handleRequestOrder = () => {
    if (!canOrder) return;
    const lines = buildLines();
    if (lines.length === 0) return;
    for (const line of lines) {
      addItem(
        {
          productId: product.id,
          slug: product.slug,
          name: product.name,
          code: product.code,
          price50: slabs.price50,
          price100: slabs.price100,
          image: line.image,
          color: line.color,
          colorHex: line.colorHex,
        },
        line.packs
      );
    }
    setAddedFeedback(true);
    setTimeout(() => setAddedFeedback(false), 2500);
    openCart();
  };

  const handleWhatsApp = () => {
    if (!canOrder) return;
    const url = buildWholesaleWhatsAppUrl({ lines: buildLines() });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const category = (product.category || 'tee').toLowerCase();

  return (
    <div>
      <div className="mx-auto max-w-[1500px] px-6 md:px-12 lg:px-16 xl:px-20 pt-0 pb-5 md:pt-0 md:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-[1.65fr_1fr] gap-3 md:gap-8 lg:gap-10">
          {/* GALLERY */}
          <div>
            <div className="lg:hidden">
              <SwipeGallery
                images={images}
                productName={product.name}
                colorName={color.name}
                onImageClick={openImageViewer}
                onIndexChange={handleIndexChange}
              />
            </div>
            <div className="hidden lg:block">
              <DesktopGallery
                images={images}
                productName={product.name}
                colorName={color.name}
                onImageClick={openImageViewer}
                onIndexChange={handleIndexChange}
              />
            </div>
          </div>

          {/* INFO */}
          <div className="mt-1 md:mt-6 lg:mt-0">
            <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-1.5">
              Wholesale · {category}
            </p>
            <h1 className="text-3xl md:text-5xl lg:text-4xl xl:text-5xl font-semibold text-bone leading-tight">
              {product.name}
            </h1>
            <p className="font-label text-sm md:text-base uppercase tracking-wide-2 text-grey mt-1.5 lg:mt-2">{product.code}</p>

            {/* Colors */}
            <div className="mt-4 border-t border-line pt-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mb-2.5">
                Colors — tap to preview
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {product.colors.map((c, i) => {
                  const hasImages = c.images.filter((x) => x.trim()).length > 0;
                  const selected = i === colorIdx;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!hasImages}
                      onClick={() => setColorIdx(i)}
                      className={`inline-flex items-center gap-3 border px-4 py-3 text-xs md:text-sm uppercase tracking-wide-2 transition-colors ${
                        selected
                          ? 'border-crimson text-bone'
                          : 'border-line text-grey hover:border-bone-dim hover:text-bone'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                      title={c.name}
                    >
                      <span
                        className={`w-8 h-8 border shrink-0 ${selected ? 'border-crimson' : 'border-line'}`}
                        style={{ backgroundColor: c.hex }}
                      />
                      {c.name}
                      {packsByColor[c.id] > 0 && (
                        <span className="font-label text-[10px] md:text-xs tabular-nums font-semibold">
                          {packsByColor[c.id]} pack{packsByColor[c.id] !== 1 ? 's' : ''}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Wholesale pricing */}
            <div className="mt-5">
              <p className="font-label text-[10px] uppercase tracking-[0.18em] text-grey mb-2">
                Wholesale Pricing
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className={`border p-3 text-center transition-colors ${canOrder && totalQty < TIER_100_PCS ? 'border-crimson bg-white' : 'border-line bg-white'}`}>
                  <p className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">{MIN_ORDER_PCS}–{TIER_100_PCS - 6} PCS</p>
                  <p className="font-price text-xl md:text-2xl text-bone mt-1">{slabs.price50 > 0 ? formatPerUnit(slabs.price50) : '—'}</p>
                  <p className="mt-1 font-label text-[9px] uppercase tracking-wide-2 text-grey/70">
                    wholesale rate
                  </p>
                </div>
                <div className={`border p-3 text-center transition-colors ${totalQty >= TIER_100_PCS ? 'border-crimson bg-white' : 'border-line bg-white'}`}>
                  <p className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">{TIER_100_PCS}+ PCS</p>
                  <p className="font-price text-xl md:text-2xl text-crimson mt-1">{slabs.price100 > 0 ? formatPerUnit(slabs.price100) : '—'}</p>
                  <p className="mt-1 font-label text-[9px] uppercase tracking-wide-2 text-grey/70">
                    best rate
                  </p>
                  {totalQty >= TIER_100_PCS && (
                    <p className="font-label text-[9px] uppercase tracking-wide-2 text-crimson mt-1">
                      Applied
                    </p>
                  )}
                </div>
              </div>
              <p className="mt-3 text-[11px] text-bone-soft leading-relaxed">
                Mixed colors allowed. Each color pack is fixed at {packCfg.packSize} PCS ({packCfg.m} M · {packCfg.l} L · {packCfg.xl} XL) — sizes are not sold separately. Minimum order: {MIN_PACKS} packs ({MIN_ORDER_PCS} PCS).
              </p>
            </div>

            {/* Color pack selection */}
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">
                  Order in Color Packs
                </span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 text-bone-soft">
                  1 pack = {packCfg.packSize} PCS ({packCfg.m} M · {packCfg.l} L · {packCfg.xl} XL)
                </span>
              </div>
              <div className="border border-line divide-y divide-line">
                {product.colors.map((c, i) => {
                  const line = colorLines[i];
                  const selected = i === colorIdx;
                  const hasImages = c.images.filter((x) => x.trim()).length > 0;
                  return (
                    <div key={c.id} className="grid items-center gap-x-3 px-3 py-3 grid-cols-[minmax(0,1fr)_auto_auto]">
                      <button
                        type="button"
                        disabled={!hasImages}
                        onClick={() => setColorIdx(i)}
                        className="flex items-center gap-2 min-w-0 overflow-hidden"
                        title={hasImages ? `View ${c.name} images` : c.name}
                      >
                        <span
                          className={`w-4 h-4 border shrink-0 ${selected ? 'border-crimson' : 'border-line'}`}
                          style={{ backgroundColor: c.hex }}
                        />
                        <span className={`text-xs md:text-sm truncate min-w-0 ${selected ? 'text-bone font-semibold' : 'text-bone'}`}>
                          {c.name}
                        </span>
                      </button>
                      <PackStepper
                        label={`${c.name} packs`}
                        packs={line.packs}
                        work={(next) => setPacks(i, next)}
                      />
                      <span className="font-label text-xs md:text-sm tabular-nums text-bone font-semibold text-right whitespace-nowrap">
                        {line.qty} PCS
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Totals + validation */}
              <div className="mt-4 bg-ink p-4 md:p-5 text-white">
                <div className="flex items-center justify-between">
                  <span className="font-label text-[10px] uppercase tracking-wide-2 text-white/50">Total Quantity</span>
                  <span className="font-price text-xl md:text-2xl text-white tabular-nums">{totalQty} PCS</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-label text-[10px] uppercase tracking-wide-2 text-white/50">Wholesale Price</span>
                  <span className="font-price text-base md:text-lg text-white/90 tabular-nums">
                    {canOrder && tier.unitPrice > 0 ? `${formatPerUnit(tier.unitPrice)} × ${totalQty}` : '—'}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
                  <span className="font-label text-[11px] uppercase tracking-wide-2 text-white/70">Total</span>
                  <span className="font-price text-2xl md:text-3xl text-crimson tabular-nums">
                    {canOrder ? formatPrice(tier.total) : formatPrice(0)}
                  </span>
                </div>
              </div>

              {/* Order status */}
              <div className="mt-3 space-y-2">
                {totalQty === 0 && (
                  <p className="font-label text-[11px] uppercase tracking-wide-2 text-bone-soft">
                    Pick whole color packs to build your order — minimum order is {MIN_PACKS} packs ({MIN_ORDER_PCS} PCS).
                  </p>
                )}
                {belowMinTotal && (
                  <p className="flex items-center gap-2 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3">
                    <AlertTriangle size={16} strokeWidth={1.8} className="shrink-0" />
                    <span>
                      Minimum wholesale order is {MIN_PACKS} packs ({MIN_ORDER_PCS} PCS). Add {MIN_ORDER_PCS - totalQty} more PCS (
                      {Math.ceil((MIN_ORDER_PCS - totalQty) / packCfg.packSize)} more pack{Math.ceil((MIN_ORDER_PCS - totalQty) / packCfg.packSize) !== 1 ? 's' : ''}) across any colors.
                    </span>
                  </p>
                )}
                {canOrder && totalQty < TIER_100_PCS && (
                  <p className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-3">
                    <CheckCircle2 size={16} strokeWidth={1.8} className="shrink-0" />
                    Order ready — {MIN_ORDER_PCS} PCS minimum reached. Add {TIER_100_PCS - totalQty} more PCS to unlock the {TIER_100_PCS}+ PCS rate.
                  </p>
                )}
                {totalQty >= TIER_100_PCS && (
                  <p className="flex items-center gap-2 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3 font-medium">
                    <CheckCircle2 size={16} strokeWidth={1.8} className="shrink-0" />
                    You unlocked the {TIER_100_PCS}+ PCS wholesale price ({slabs.price100 > 0 ? formatPerUnit(slabs.price100) : '—'}).
                  </p>
                )}
              </div>
            </div>

            {/* CTAs */}
            <div className="mt-5 space-y-2">
              <button
                onClick={handleRequestOrder}
                disabled={!canOrder}
                className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold py-4 px-5 transition-all duration-150 hover:bg-crimson-dark disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {addedFeedback ? <CheckCircle2 size={16} strokeWidth={2} /> : <ShoppingBag size={16} strokeWidth={1.8} />}
                {addedFeedback ? 'Added to Wholesale Order' : 'Place Wholesale Order'}
              </button>
              <button
                onClick={handleWhatsApp}
                disabled={!canOrder}
                className="w-full inline-flex items-center justify-center gap-2 border border-bone-dim text-bone text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold py-4 px-5 transition-all duration-150 hover:bg-bone hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <MessageCircle size={16} strokeWidth={2} />
                Order On WhatsApp
              </button>
              {!canOrder && totalQty > 0 && (
                <p className="flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-grey">
                  <Lock size={12} strokeWidth={2} /> Order unlocks at {MIN_ORDER_PCS} PCS (whole color packs only).
                </p>
              )}
              <div className="pt-3 border-t border-line">
                <p className="text-[11px] leading-relaxed text-bone-soft">
                  Wholesale orders are confirmed via WhatsApp. We'll confirm availability, pricing and delivery details before dispatch.
                </p>
              </div>
            </div>

            {/* Wholesale info */}
            <div className="mt-6 border-t border-line">
              <div className="pt-4 space-y-2 text-sm text-grey leading-relaxed">
                <p>Minimum order: {MIN_PACKS} packs ({MIN_ORDER_PCS} PCS) per design — mixed colors allowed.</p>
                <p>Color packs are fixed: each included color ships as {packCfg.m} M · {packCfg.l} L · {packCfg.xl} XL per {packCfg.packSize}-PCS pack. Sizes are not sold separately.</p>
                <p>Slab pricing: {MIN_ORDER_PCS}–{TIER_100_PCS - 6} PCS at {slabs.price50 > 0 ? formatPerUnit(slabs.price50) : '—'}; {TIER_100_PCS}+ PCS at {slabs.price100 > 0 ? formatPerUnit(slabs.price100) : '—'}.</p>
                <p>Pan-India delivery. Orders confirmed personally on WhatsApp before dispatch — no account needed.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isImageViewerOpen && images[safeImgIdx] && (
        <LightboxViewer
          images={images}
          idx={safeImgIdx}
          setIdx={setImgIdx}
          onClose={() => setIsImageViewerOpen(false)}
          productName={product.name}
          colorName={color.name}
        />
      )}

      {/* Related */}
      {related.length > 0 && (
        <section className="border-t border-line py-12 md:py-16">
          <div className="mx-auto px-3 md:px-12 lg:px-16 xl:px-20">
            <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone mb-4 md:mb-10">
              More Wholesale Designs
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-8">
              {related.map((p, i) => (
                <ProductCard key={p.id} product={p} index={i} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}