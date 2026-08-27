import { useEffect, useState, useRef, useCallback, memo } from 'react';
import { Minus, Plus, MessageCircle, ChevronDown, ChevronLeft, ChevronRight, ShoppingBag, CheckCircle2, X, AlertTriangle, Lock } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  getProductSpecs,
  getWholesaleSlabs,
  getWholesaleTier,
  buildWholesaleWhatsAppUrl,
  formatPerUnit,
  formatPrice,
  type CatalogProduct,
  type WholesaleSkuLine,
} from '@/lib/catalog';
import type { ProductColorRow, ProductSizeRow, SizeChartRow } from '@/lib/types';
import { notFound } from '@/lib/notFound';
import { useCart } from '@/lib/cart';

const SIZE_LABELS = ['M', 'L', 'XL'] as const;
type SizeLabel = (typeof SIZE_LABELS)[number];

const ACCORDION = [
  { title: 'Wholesale Info', body: 'wholesale' },
  { title: 'Size Chart', body: 'sizechart' },
  { title: 'Care Instructions', body: 'care' },
];

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

/* ---- Wholesale Quantity Matrix ---- */

function MatrixCell({
  label,
  qty,
  stock,
  onChange,
}: {
  label: string;
  qty: number;
  stock: number;
  onChange: (qty: number) => void;
}) {
  const disabled = stock <= 0;
  const atCap = disabled || qty >= stock;
  const shown = String(qty);

  return (
    <div className="flex items-center justify-center">
      {disabled ? (
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide-2 text-grey/60 line-through">
          {label}-S/O
        </span>
      ) : (
        <div className="inline-flex items-center border border-line bg-white">
          <button
            onClick={() => onChange(Math.max(0, qty - 1))}
            disabled={qty <= 0}
            className="w-7 h-8 md:w-8 md:h-9 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={`Decrease ${label}`}
          >
            <Minus size={13} strokeWidth={2} />
          </button>
          <span className="w-7 md:w-8 text-center text-sm font-semibold tabular-nums text-bone select-none">
            {shown}
          </span>
          <button
            onClick={() => onChange(qty + 1)}
            disabled={atCap}
            className="w-7 h-8 md:w-8 md:h-9 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={`Increase ${label}`}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- Product Page ---- */

export function ProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<CatalogProduct | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [related, setRelated] = useState<CatalogProduct[]>([]);

  const [colorIdx, setColorIdx] = useState(0);
  const [matrix, setMatrix] = useState<Record<string, Record<string, number>>>({});
  const [imgIdx, setImgIdx] = useState(0);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [openAcc, setOpenAcc] = useState<string | null>(null);
  const [addedFeedback, setAddedFeedback] = useState(false);

  const { addItem, open: openCart } = useCart();

  useEffect(() => {
    setProduct(undefined);
    setLoadError(false);
    setColorIdx(0);
    setMatrix({});
    setImgIdx(0);
    fetchProduct(slug)
      .then((p) => {
        setProduct(p);
        if (p) {
          const firstColor = p.colors[0];
          if (firstColor) setColorIdx(0);
          fetchProducts()
            .then((all) => setRelated(all.filter((x) => x.slug !== p.slug).slice(0, 3)))
            .catch(() => {});
        }
      })
      .catch(() => {
        setProduct(null);
        setLoadError(true);
      });
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
          <p className="mt-5 text-sm uppercase tracking-wide-2 text-grey">
            Failed to load product.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-8 inline-flex items-center text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-4 hover:bg-crimson-dark transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return notFound();
  }
  if (product === undefined) {
    return (
      <div className="mx-auto max-w-[1500px] px-6 md:px-12 lg:px-16 xl:px-20 py-5 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-[1.8fr_1fr] gap-8 lg:gap-8">
          <div className="aspect-[4/5] bg-paper-3 border border-line animate-pulse" />
          <div className="space-y-4 mt-6 lg:mt-0">
            <div className="h-10 bg-paper-3 animate-pulse" />
            <div className="h-6 w-32 bg-paper-3 animate-pulse" />
            <div className="h-8 w-40 bg-paper-3 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  const color = product.colors[colorIdx];
  if (!color) return notFound();
  const images = color.images.filter((image) => image.trim().length > 0);
  const safeImgIdx = Math.max(0, Math.min(imgIdx, images.length - 1));

  const specs = getProductSpecs(product);
  const slabs = getWholesaleSlabs(product);
  const moq = slabs.moq;

  const sizes = product.sizes.filter((s) => s.color_id === color.id);

  const stockFor = (colorId: string, size: string): number =>
    product.sizes.find((s) => s.color_id === colorId && s.size_label === size)?.stock ?? 0;

  const setCell = (colorId: string, size: string, qty: number) => {
    setMatrix((prev) => ({ ...prev, [colorId]: { ...(prev[colorId] ?? {}), [size]: qty } }));
  };

  const totalQty = Object.values(matrix).reduce(
    (sum, sizesMap) => sum + Object.values(sizesMap).reduce((a, b) => a + b, 0),
    0
  );

  const tier = getWholesaleTier(totalQty, slabs);
  const belowMoq = totalQty > 0 && totalQty < moq;
  const canOrder = totalQty >= moq;

  const buildLines = (): WholesaleSkuLine[] =>
    Object.entries(matrix).flatMap(([colorId, sizesMap]) =>
      product.colors
        .filter((c) => c.id === colorId)
        .flatMap((c) =>
          Object.entries(sizesMap)
            .filter(([, qty]) => qty > 0)
            .map(([size, qty]) => ({
              name: product.name,
              code: product.code,
              color: c.name,
              size,
              qty,
              price50: slabs.price50,
              price100: slabs.price100,
              image: c.images[0] ?? '',
              slug: product.slug,
            }))
        )
    );

  const handleRequestOrder = () => {
    if (!canOrder) return;
    const lines = buildLines();
    for (const line of lines) {
      addItem(
        {
          productId: product.id,
          slug: product.slug,
          name: product.name,
          code: product.code,
          price: slabs.price50,
          price50: slabs.price50,
          price100: slabs.price100,
          image: line.image,
          color: line.color,
          size: line.size,
          stock: stockFor(product.colors.find((c) => c.name === line.color)?.id ?? color.id, line.size),
        },
        line.qty
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

  const toggleAcc = (t: string) => setOpenAcc((o) => (o === t ? null : t));

  const sizeChart = product.size_chart;
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
            <h1 className="text-2xl md:text-4xl lg:text-3xl xl:text-4xl font-semibold text-bone leading-tight">
              {product.name}
            </h1>
            <p className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey mt-1 lg:mt-1.5">{product.code}</p>

            {/* Product info — admin-entered details only; empty values are hidden */}
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4">
              {specs.fabric && <Spec label="Fabric" value={specs.fabric} />}
              {specs.gsm && <Spec label="GSM" value={`${specs.gsm}`} />}
              {specs.wash && <Spec label="Wash" value={specs.wash} />}
              {specs.fit && <Spec label="Fit" value={specs.fit} />}
              {specs.printType && <Spec label="Print" value={specs.printType} />}
              <Spec label="Sizes" value={SIZE_LABELS.join(' / ')} />
              <Spec label="Colors" value={product.colors.map((c) => c.name).join(', ')} />
            </div>

            {/* Wholesale pricing */}
            <div className="mt-5 border border-line bg-paper-2 p-4 md:p-5">
              <p className="font-label text-[10px] uppercase tracking-[0.18em] text-grey mb-3">
                Wholesale Pricing (per piece)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className={`border p-3 text-center ${totalQty >= slabTier(moq) ? 'border-crimson bg-white' : 'border-line bg-white'}`}>
                  <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">{moq} PCS</p>
                  <p className="font-price text-lg md:text-xl text-bone mt-1">{formatPerUnit(slabs.price50)}</p>
                </div>
                <div className={`border p-3 text-center ${totalQty >= 100 ? 'border-crimson bg-white' : 'border-line bg-white'}`}>
                  <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">100 PCS</p>
                  <p className="font-price text-lg md:text-xl text-crimson mt-1">{formatPerUnit(slabs.price100)}</p>
                  {totalQty >= 100 && (
                    <p className="font-label text-[9px] uppercase tracking-wide-2 text-crimson mt-1">
                      Applied
                    </p>
                  )}
                </div>
              </div>
              <p className="mt-3 text-[11px] text-bone-soft leading-relaxed">
                Mixed sizes &amp; colors. {moq} PCS minimum; the 100 PCS rate unlocks automatically.
              </p>
            </div>

            {/* Wholesale quantity matrix */}
            <div className="mt-5">
              <div className="flex items-center justify-between mb-2">
                <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">
                  Wholesale Quantity
                </span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 text-bone-soft">
                  Add pieces per color &amp; size
                </span>
              </div>
              <div className="border border-line overflow-hidden">
                <div className="grid grid-cols-[1.3fr_repeat(3,1fr)] bg-paper-2 border-b border-line">
                  <span className="px-3 py-2 font-label text-[10px] uppercase tracking-wide-2 text-grey">Color</span>
                  {SIZE_LABELS.map((s) => (
                    <span key={s} className="px-1 py-2 text-center font-label text-[11px] uppercase tracking-wide-2 text-bone font-semibold">
                      {s}
                    </span>
                  ))}
                </div>
                {product.colors.map((c) => (
                  <div key={c.id} className="grid grid-cols-[1.3fr_repeat(3,1fr)] border-b border-line last:border-0">
                    <div className="px-3 py-2 flex items-center gap-2 min-w-0">
                      <span className="w-3 h-3 border border-line shrink-0" style={{ backgroundColor: c.hex }} />
                      <span className="text-[11px] md:text-xs text-bone truncate">{c.name}</span>
                    </div>
                    {SIZE_LABELS.map((s) => (
                      <div key={`${c.id}-${s}`} className="px-1 py-2">
                        <MatrixCell
                          label={`${c.name} ${s}`}
                          qty={matrix[c.id]?.[s] ?? 0}
                          stock={stockFor(c.id, s)}
                          onChange={(q) => setCell(c.id, s, q)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
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
                    {totalQty >= moq && slabs.price50 > 0 ? `${formatPerUnit(tier.unitPrice)} × ${totalQty}` : '—'}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2">
                  <span className="font-label text-[11px] uppercase tracking-wide-2 text-white/70">Total</span>
                  <span className="font-price text-2xl md:text-3xl text-crimson tabular-nums">
                    {totalQty >= moq ? formatPrice(tier.total) : formatPrice(0)}
                  </span>
                </div>
              </div>

              {/* MOQ status */}
              <div className="mt-3 space-y-2">
                {totalQty === 0 && (
                  <p className="font-label text-[11px] uppercase tracking-wide-2 text-bone-soft">
                    Build a mix of {moq} PCS or more to place a wholesale order.
                  </p>
                )}
                {belowMoq && (
                  <p className="flex items-center gap-2 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3">
                    <AlertTriangle size={16} strokeWidth={1.8} className="shrink-0" />
                    Minimum wholesale order is {moq} PCS. Add {moq - totalQty} more PCS — mix any colors and sizes.
                  </p>
                )}
                {canOrder && totalQty < 100 && (
                  <p className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-3">
                    <CheckCircle2 size={16} strokeWidth={1.8} className="shrink-0" />
                    Wholesale MOQ reached.
                  </p>
                )}
                {totalQty >= 100 && (
                  <p className="flex items-center gap-2 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3 font-medium">
                    <CheckCircle2 size={16} strokeWidth={1.8} className="shrink-0" />
                    You unlocked the {formatPerUnit(slabs.price100)} wholesale price.
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
                {addedFeedback ? 'Added to Wholesale Order' : 'Request Wholesale Order'}
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
                  <Lock size={12} strokeWidth={2} /> Order unlocks at {moq} PCS.
                </p>
              )}
              <div className="pt-3 border-t border-line">
                <p className="text-[11px] leading-relaxed text-bone-soft">
                  Wholesale orders are confirmed via WhatsApp. We'll confirm availability, pricing and delivery details before dispatch.
                </p>
              </div>
            </div>

            {/* Accordion */}
            <div className="mt-6 border-t border-line">
              {ACCORDION.map((a) => (
                (a.body !== 'sizechart' || sizeChart.length > 0) && (
                <div key={a.title} className="border-b border-line">
                  <button
                    onClick={() => toggleAcc(a.title)}
                    className="w-full flex items-center justify-between py-4 text-left"
                  >
                    <span className="font-label text-[11px] uppercase tracking-wide-2 text-bone-dim font-medium">
                      {a.title}
                    </span>
                    <ChevronDown
                      size={16}
                      className={`text-grey transition-transform duration-200 ${
                        openAcc === a.title ? 'rotate-180' : ''
                      }`}
                      strokeWidth={1.8}
                    />
                  </button>
                  {openAcc === a.title && (
                    <div className="pb-5 text-sm text-grey leading-relaxed animate-slide-down">
                      {a.body === 'sizechart' && (
                        <div className="overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0">
                          <table className="w-full text-sm min-w-[320px]">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wide-2 text-grey border-b border-line">
                                <th className="text-left py-2 pr-4 font-medium">Size</th>
                                <th className="text-left py-2 pr-4 font-medium">Chest (in)</th>
                                <th className="text-left py-2 pr-4 font-medium">Length (in)</th>
                                <th className="text-left py-2 font-medium">Shoulder (in)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sizeChart.map((r: SizeChartRow) => (
                                <tr key={r.id} className="border-b border-line last:border-0">
                                  <td className="py-2.5 pr-4 font-medium text-bone">{r.size_label}</td>
                                  <td className="py-2.5 pr-4 text-bone-dim">{r.chest}</td>
                                  <td className="py-2.5 pr-4 text-bone-dim">{r.length}</td>
                                  <td className="py-2.5 text-bone-dim">{r.shoulder}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {a.body === 'wholesale' && (
                        <div className="space-y-2">
                          <p>MOQ {moq} PCS per design — mixed sizes (M / L / XL) and colors allowed.</p>
                          <p>Slab pricing: {moq} PCS at {formatPerUnit(slabs.price50)}; 100+ PCS at {formatPerUnit(slabs.price100)}.</p>
                          <p>Pan-India delivery. Orders confirmed personally on WhatsApp before dispatch.</p>
                          <p>Retailers and resellers: build your mix on this page and request the order — no account needed.</p>
                        </div>
                      )}
                      {a.body === 'care' && (
                        <p className="space-y-2">{product.care}</p>
                      )}
                    </div>
                  )}
                </div>
                )
              ))}
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

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-label text-[10px] uppercase tracking-wide-2 text-grey">{label}</dt>
      <dd className="mt-0.5 text-sm text-bone-dim leading-snug">{value}</dd>
    </div>
  );
}

function slabTier(moq: number): number {
  return moq;
}