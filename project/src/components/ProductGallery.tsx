import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

/* Shared product galleries used by both the retail (D2C) and wholesale
 * product pages. The SwipeGallery is the touch/mobile view, DesktopGallery the
 * thumbnail view, LightboxViewer the fullscreen viewer. */

/* ---- Swipe Gallery ---- */

export const SwipeGallery = memo(function SwipeGallery({
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

export function DesktopGallery({
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

export function LightboxViewer({
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