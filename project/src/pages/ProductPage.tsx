import { useEffect, useState, useRef, useCallback, memo } from 'react';
import { Minus, Plus, MessageCircle, ChevronDown, ChevronLeft, ChevronRight, ShoppingBag, Zap, CheckCircle2, X } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  formatPrice,
  buildWhatsAppUrl,
  type CatalogProduct,
} from '@/lib/catalog';
import type { ProductColorRow, ProductSizeRow, SizeChartRow } from '@/lib/types';
import { notFound } from '@/lib/notFound';
import { useCart } from '@/lib/cart';

const ACCORDION = [
  { title: 'Size Chart', body: 'sizechart' },
  { title: 'Shipping Info', body: 'shipping' },
  { title: 'Return Policy', body: 'returns' },
];

const SIZE_PRIORITY = ['M', 'L', 'XL'] as const;

function findFirstAvailableSize(sizes: ProductSizeRow[]): string {
  for (const label of SIZE_PRIORITY) {
    if (sizes.some((s) => s.size_label === label && s.available)) return label;
  }
  return '';
}

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

/* ---- Product Page ---- */

export function ProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<CatalogProduct | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [related, setRelated] = useState<CatalogProduct[]>([]);

  const [colorIdx, setColorIdx] = useState(0);
  const [size, setSize] = useState('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [openAcc, setOpenAcc] = useState<string | null>(null);
  const [addedFeedback, setAddedFeedback] = useState(false);
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [customer, setCustomer] = useState({ name: '', phone: '', city: '', address: '' });

  const { addItem, open: openCart } = useCart();

  useEffect(() => {
    setProduct(undefined);
    setLoadError(false);
    setColorIdx(0);
    setSize('');
    setQty(1);
    setImgIdx(0);
    fetchProduct(slug)
      .then((p) => {
        setProduct(p);
        if (p) {
          const firstColor = p.colors[0];
          if (firstColor) {
            setColorIdx(0);
            const colorSizes = p.sizes.filter((s) => s.color_id === firstColor.id);
            setSize(findFirstAvailableSize(colorSizes));
          }
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
  const canBuy = size !== '';

  const colorSizes = product.sizes.filter((s) => s.color_id === color.id);
  const selectedSize = colorSizes.find((s) => s.size_label === size);
  const maxQty = selectedSize ? selectedSize.stock : 1;

  const handleAddToCart = () => {
    if (!canBuy || !selectedSize) return;
    addItem({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      code: product.code,
      price: product.price,
      image: images[0] ?? '',
      color: color.name,
      size,
      stock: selectedSize.stock,
    }, qty);
    setAddedFeedback(true);
    setTimeout(() => setAddedFeedback(false), 2500);
  };

  const handleOrderSubmit = () => {
    if (!canBuy || !selectedSize) return;
    if (!customer.name || !customer.phone || !customer.city || !customer.address) return;

    const item = {
      productId: product.id,
      slug: product.slug,
      name: product.name,
      code: product.code,
      price: product.price,
      image: images[0] ?? '',
      color: color.name,
      size,
      stock: selectedSize.stock,
    };
    addItem(item, qty);

    const orderUrl = buildWhatsAppUrl({
      name: product.name,
      code: product.code,
      color: color.name,
      size,
      quantity: qty,
      price: product.price,
      customerName: customer.name,
      phone: customer.phone,
      city: customer.city,
      address: customer.address,
      notes: `${qty} unit(s) selected`,
    });
    window.open(orderUrl, '_blank', 'noopener,noreferrer');
    setShowOrderForm(false);
    openCart();
  };

  const discount = product.mrp
    ? Math.round(((product.mrp - product.price) / product.mrp) * 100)
    : null;

  const toggleAcc = (t: string) => setOpenAcc((o) => (o === t ? null : t));

  const sizeChart = product.size_chart;

  return (
    <div>
      <div className="mx-auto max-w-[1500px] px-6 md:px-12 lg:px-16 xl:px-20 pt-0 pb-5 md:pt-0 md:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-[1.8fr_1fr] gap-3 md:gap-8 lg:gap-8">
          {/* GALLERY */}
          <div>
            {/* Mobile: swipe gallery with dots */}
            <div className="lg:hidden">
              <SwipeGallery
                images={images}
                productName={product.name}
                colorName={color.name}
                onImageClick={openImageViewer}
                onIndexChange={handleIndexChange}
              />
            </div>
            {/* Desktop: thumbnails + main image */}
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
          <h1 className="text-2xl md:text-4xl lg:text-3xl xl:text-4xl font-semibold text-bone leading-tight">
            {product.name}
          </h1>
          <p className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey mt-1 lg:mt-1.5">{product.code}</p>

          {/* Price */}
          <div className="mt-3 md:mt-6 lg:mt-4 flex items-center gap-3">
            <span className="font-price text-crimson text-2xl md:text-3xl lg:text-2xl xl:text-3xl">{formatPrice(product.price)}</span>
            {product.mrp && (
              <>
                <span className="font-price text-grey line-through text-lg md:text-xl lg:text-base">{formatPrice(product.mrp)}</span>
                <span className="font-label text-crimson text-xs md:text-sm uppercase tracking-wide-2 font-semibold">
                  Save {discount}%
                </span>
              </>
            )}
          </div>

          {/* Color */}
          <div className="mt-5 md:mt-8 lg:mt-5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">Color</span>
              <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-bone-dim">{color.name}</span>
            </div>
            <div className="flex items-center gap-2.5 md:gap-3">
              {product.colors.map((c: ProductColorRow, i: number) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setColorIdx(i);
                    setImgIdx(0);
                    setQty(1);
                    const nextSizes = product.sizes.filter((s) => s.color_id === c.id);
                    setSize(findFirstAvailableSize(nextSizes));
                  }}
                  className="relative w-10 h-10 md:w-11 md:h-11 lg:w-10 lg:h-10 flex items-center justify-center"
                  aria-label={c.name}
                  title={c.name}
                >
                  <span
                    className={`block w-6 h-6 md:w-6 md:h-6 border transition-all ${
                      i === colorIdx ? 'border-crimson ring-1 ring-crimson ring-offset-1 ring-offset-paper' : 'border-line hover:border-bone-dim'
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Size */}
          <div className="mt-4 md:mt-7 lg:mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey">Size</span>
            </div>
            <div className="flex flex-wrap gap-2.5 md:gap-3">
              {colorSizes.map((s: ProductSizeRow) => (
                <button
                  key={s.id}
                  onClick={() => { if (s.available) { setSize(s.size_label); setQty(1); } }}
                  disabled={!s.available}
                  className={`font-label min-w-[3.25rem] md:min-w-[3.5rem] lg:min-w-[3.25rem] px-3 md:px-3.5 lg:px-3 py-2 md:py-2.5 lg:py-2 text-sm md:text-sm lg:text-[13px] font-medium border transition-all duration-200 ${
                    !s.available
                      ? 'border-line text-grey/50 line-through cursor-not-allowed bg-paper-2'
                      : size === s.size_label
                        ? 'bg-bone text-paper border-bone'
                        : 'border-line text-bone-dim hover:border-bone-dim hover:text-bone'
                  }`}
                >
                  {s.size_label}
                </button>
              ))}
            </div>
          </div>

          {/* Quantity */}
          <div className="mt-4 md:mt-7 lg:mt-4">
            <span className="font-label text-[11px] md:text-xs uppercase tracking-wide-2 text-grey block mb-2">Quantity</span>
            <div className="inline-flex items-center border border-line">
              <button
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="w-10 h-10 md:w-11 md:h-11 lg:w-10 lg:h-10 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30"
                disabled={qty <= 1}
                aria-label="Decrease quantity"
              >
                <Minus size={15} strokeWidth={2} />
              </button>
              <span className="w-11 text-center text-bone font-medium tabular-nums text-sm">{qty}</span>
              <button
                onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
                className="w-10 h-10 md:w-11 md:h-11 lg:w-10 lg:h-10 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30"
                disabled={qty >= maxQty}
                aria-label="Increase quantity"
              >
                <Plus size={15} strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Add to Cart + Buy Now */}
          <div className="mt-5 md:mt-8 lg:mt-5 space-y-2 lg:space-y-2">
            <div className="flex flex-col sm:flex-row gap-2.5 lg:gap-2.5">
              <button
                onClick={handleAddToCart}
                disabled={!canBuy}
                className="flex-1 inline-flex items-center justify-center gap-2 border border-bone-dim text-bone text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold py-3.5 md:py-4 lg:py-3.5 px-5 transition-all duration-150 hover:bg-bone hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-bone"
              >
                {addedFeedback ? <CheckCircle2 size={16} strokeWidth={2} /> : <ShoppingBag size={16} strokeWidth={1.8} />}
                {addedFeedback ? 'Added to Cart' : 'Add to Cart'}
              </button>
              <button
                onClick={() => {
                  if (!canBuy) return;
                  setShowOrderForm((prev) => !prev);
                }}
                disabled={!canBuy}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold py-3.5 md:py-4 lg:py-3.5 px-5 transition-all duration-150 hover:bg-crimson-dark disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-crimson"
              >
                <Zap size={16} strokeWidth={2} />
                Order via WhatsApp
              </button>
            </div>
            {showOrderForm && (
              <div className="rounded border border-line bg-paper-2 p-4 space-y-3">
                <p className="text-[11px] uppercase tracking-wide-2 text-bone-dim">Customer details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input value={customer.name} onChange={(e) => setCustomer((p) => ({ ...p, name: e.target.value }))} placeholder="Full name" className="rounded border border-line bg-white px-3 py-2.5 text-sm text-bone outline-none" />
                  <input value={customer.phone} onChange={(e) => setCustomer((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone number" className="rounded border border-line bg-white px-3 py-2.5 text-sm text-bone outline-none" />
                  <input value={customer.city} onChange={(e) => setCustomer((p) => ({ ...p, city: e.target.value }))} placeholder="City" className="rounded border border-line bg-white px-3 py-2.5 text-sm text-bone outline-none sm:col-span-2" />
                  <textarea value={customer.address} onChange={(e) => setCustomer((p) => ({ ...p, address: e.target.value }))} placeholder="Delivery address" rows={3} className="rounded border border-line bg-white px-3 py-2.5 text-sm text-bone outline-none sm:col-span-2" />
                </div>
                <button
                  onClick={handleOrderSubmit}
                  className="w-full inline-flex items-center justify-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold py-3 rounded transition-colors hover:bg-ink"
                >
                  <MessageCircle size={16} strokeWidth={2} />
                  Continue to WhatsApp
                </button>
              </div>
            )}
            {!canBuy && (
              <p className="font-label text-[11px] uppercase tracking-wide-2 text-crimson/80">
                Select a size to unlock checkout
              </p>
            )}
            {addedFeedback && (
              <p className="text-sm text-green-600 flex items-center gap-1.5">
                <CheckCircle2 size={16} /> Added to cart — <button onClick={openCart} className="underline font-medium">view cart</button>
              </p>
            )}
            <div className="pt-3 border-t border-line">
              <p className="text-[11px] leading-relaxed text-bone-soft">
                Orders are confirmed via WhatsApp. We'll contact you shortly to confirm availability and delivery details.
              </p>
            </div>
          </div>

          {/* Fabric / Fit / Care */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 border-t border-line pt-5">
            <div>
              <dt className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Fabric</dt>
              <dd className="mt-1 text-sm text-bone-dim">{product.fabric}</dd>
            </div>
            <div>
              <dt className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Fit</dt>
              <dd className="mt-1 text-sm text-bone-dim">{product.fit}</dd>
            </div>
            <div>
              <dt className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Care</dt>
              <dd className="mt-1 text-sm text-bone-dim leading-snug">{product.care}</dd>
            </div>
          </div>

          {/* Accordion: Size Chart + Shipping Info + Return Policy */}
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
                    {a.body === 'shipping' && (
                      <div className="space-y-2">
                        <p>Ships pan-India in 2–5 business days via tracked courier.</p>
                        <p>Free shipping on orders above ₹999.</p>
                        <p>Customer confirmation happens on WhatsApp before dispatch.</p>
                      </div>
                    )}
                    {a.body === 'returns' && (
                      <div className="space-y-2">
                        <p>7-day exchange for size issues only — item must be unworn with tags intact.</p>
                        <p>No returns on discounted or sale items.</p>
                        <p>Reach out on WhatsApp to start an exchange.</p>
                      </div>
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
              You May Also Like
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
