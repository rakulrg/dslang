import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Minus, Plus, ShoppingBag, CheckCircle2, Zap, Share2, Check, Link as LinkIcon, X, ChevronDown } from 'lucide-react';
import { ProductCard, PRODUCT_IMAGE_FALLBACK } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  getRetailPrice,
  getMrp,
  isRetailVisible,
  getSizesForColor,
  formatPrice,
  type CatalogProduct,
} from '@/lib/catalog';
import { notFound } from '@/lib/notFound';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { linkHref, useRouter } from '@/lib/router';
import { SkeletonProductPage } from '@/components/Skeletons';
import { SwipeGallery, DesktopGallery, LightboxViewer } from '@/components/ProductGallery';

/**
 * Retail (D2C) product page.
 * Stock is per color/size (product_sizes variant rows); quantity is capped at
 * the selected variant's stock.
 */

/** Pick the sensible default colour + size on page load: the first colour that
 * has at least one size in stock, and within it the first in-stock size. If
 * every variant is sold out, fall back to the first colour/size as before —
 * the CTAs already render OUT OF STOCK from the stock counts. */
function firstAvailableVariant(
  product: CatalogProduct
): { colorIdx: number; size: string } {
  for (let i = 0; i < product.colors.length; i++) {
    const sizes = getSizesForColor(product, product.colors[i].id);
    const inStock = sizes.find((s) => Number(s.stock ?? 0) >= 1);
    if (inStock) return { colorIdx: i, size: inStock.size_label };
  }
  // Fully sold out (or no stock rows at all) — pick the first colour that has
  // any size rows and default to its first listed size.
  for (let i = 0; i < product.colors.length; i++) {
    const sizes = getSizesForColor(product, product.colors[i].id);
    if (sizes.length > 0) return { colorIdx: i, size: sizes[0].size_label };
  }
  return { colorIdx: 0, size: '' };
}

export function RetailProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<CatalogProduct | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [related, setRelated] = useState<CatalogProduct[]>([]);

  const [colorIdx, setColorIdx] = useState(0);
  const [size, setSize] = useState<string>('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [addedFeedback, setAddedFeedback] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sizeChartOpen, setSizeChartOpen] = useState(false);
  const [openInfo, setOpenInfo] = useState<string | null>('details');

  const { addItem } = useD2cCart();
  const { openCart } = useCartDrawer();
  const { navigate } = useRouter();

  useEffect(() => {
    let cancelled = false;
    setProduct(undefined);
    setLoadError(false);
    setColorIdx(0);
    setSize('');
    setQty(1);
    setImgIdx(0);
    const load = async () => {
      try {
        // The product detail (fresh) and the related catalog (shared cache)
        // are independent of each other — fetch both in parallel.
        const [p, catalog] = await Promise.all([
          fetchProduct(slug),
          fetchProducts().catch(() => [] as CatalogProduct[]),
        ]);
        if (cancelled) return;
        setProduct(p);
        if (p) {
          const def = firstAvailableVariant(p);
          setColorIdx(def.colorIdx);
          setSize(def.size);
          setRelated(catalog.filter((x) => x.slug !== p.slug && isRetailVisible(x)).slice(0, 4));
        }
      } catch {
        if (cancelled) return;
        setProduct(null);
        setLoadError(true);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [slug]);

  const openImageViewer = useCallback(() => setIsImageViewerOpen(true), []);
  const handleIndexChange = useCallback((i: number) => setImgIdx(i), []);

  // Lock body scroll while the size-chart modal is open.
  useEffect(() => {
    if (!sizeChartOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSizeChartOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [sizeChartOpen]);

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
                .then((p) => setProduct(p))
                .catch(() => { setProduct(null); setLoadError(true); });
            }}
            className="mt-8 btn-dark font-label text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
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
      <div className="mx-auto max-w-[1500px] px-6 md:px-12 lg:px-16 xl:px-20 pt-0 pb-5 md:pt-0 md:pb-16">
        <SkeletonProductPage />
      </div>
    );
  }
  if (!isRetailVisible(product)) return notFound();

  const color = product.colors[colorIdx] ?? product.colors[0];
  if (!color) return notFound();
  const images = color.images.filter((image) => image.trim().length > 0);
  const safeImgIdx = images.length > 0 ? Math.max(0, Math.min(imgIdx, images.length - 1)) : 0;

  const retailPrice = getRetailPrice(product);
  const mrp = getMrp(product);
  const showMrp = mrp !== null && mrp > retailPrice;

  const colorSizes = getSizesForColor(product, color.id);
  const sizeOptions = colorSizes.map((s) => s.size_label);
  const selectedSizeRow = colorSizes.find((s) => s.size_label === size) ?? null;
  const selectedStock = selectedSizeRow ? Number(selectedSizeRow.stock ?? 0) : 0;
  const stockAvailable = selectedSizeRow !== null && selectedStock >= 1;
const colorInStock = colorSizes.some((s) => Number(s.stock ?? 0) >= 1);

  const sizeDetail = (label: string): number => {
    const row = colorSizes.find((s) => s.size_label === label);
    return row ? Math.max(0, Number(row.stock ?? 0)) : 0;
  };

  const cappedQty = stockAvailable ? Math.min(qty, selectedStock) : 1;

  const selectSize = (label: string) => {
    setSize(label);
    setQty(1);
  };

  const selectColor = (i: number) => {
    setColorIdx(i);
    setImgIdx(0);
    const sizes = getSizesForColor(product, product.colors[i].id);
    const first = sizes.find((s) => Number(s.stock ?? 0) >= 1) ?? sizes[0];
    setSize(first ? first.size_label : '');
    setQty(1);
  };

  const performAdd = (): boolean => {
    if (!selectedSizeRow || !stockAvailable) return false;
    addItem({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      code: product.code,
      image: color.images[0] ?? '',
      colorId: color.id,
      color: color.name,
      colorHex: color.hex,
      sizeLabel: size,
      quantity: cappedQty,
      unitPrice: retailPrice,
      mrp,
      stock: selectedStock,
    });
    return true;
  };

  const handleAddToCart = () => {
    if (!performAdd()) return;
    setAddedFeedback(true);
    openCart();
    window.setTimeout(() => setAddedFeedback(false), 500);
  };

  const handleBuyNow = () => {
    if (performAdd()) navigate('/checkout');
  };

  const productShareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${linkHref(`/product/${product.slug}`)}`
    : '';

  const openShare = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({ title: product.name, text: product.name, url: productShareUrl }).catch(() => {});
      return;
    }
    setShowShare((s) => !s);
  };

  const shareIcon = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openShare(); }}
      aria-label="Share product"
      className="absolute bottom-2.5 right-2.5 md:bottom-3 md:right-3 z-10 h-9 w-9 md:h-10 md:w-10 inline-flex items-center justify-center rounded-full bg-white/85 text-bone shadow-sm hover:bg-white transition-colors"
    >
      <Share2 size={15} strokeWidth={1.8} />
    </button>
  );

  return (
    <div className="animate-fade-in">
      <div className="mx-auto max-w-[1500px] px-6 md:px-12 lg:px-16 xl:px-20 pt-0 pb-5 md:pt-0 md:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-[1.65fr_1fr] gap-3 md:gap-8 lg:gap-10">
          {/* GALLERY — an image-less product still renders: the DSLANG fallback is
              shown in place of the swiper and the lightbox stays closed. */}
          <div>
            <div className="lg:hidden">
              {images.length > 0 ? (
                <SwipeGallery
                  images={images}
                  productName={product.name}
                  colorName={color.name}
                  onImageClick={openImageViewer}
                  onIndexChange={handleIndexChange}
                  overlay={shareIcon}
                />
              ) : (
                <div className="relative w-full aspect-[4/5] border border-line bg-paper-3 overflow-hidden">
                  <img
                    src={PRODUCT_IMAGE_FALLBACK}
                    alt={product.name}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {shareIcon}
                </div>
              )}
            </div>
            <div className="hidden lg:block">
              {images.length > 0 ? (
                <DesktopGallery
                  images={images}
                  productName={product.name}
                  colorName={color.name}
                  onImageClick={openImageViewer}
                  onIndexChange={handleIndexChange}
                  overlay={shareIcon}
                />
              ) : (
                <div className="relative w-full max-w-[650px] mx-auto aspect-[4/5] border border-line bg-paper-3 overflow-hidden">
                  <img
                    src={PRODUCT_IMAGE_FALLBACK}
                    alt={product.name}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {shareIcon}
                </div>
              )}
            </div>
          </div>

          {/* INFO */}
          <div className="mt-1 md:mt-6 lg:mt-0">
            <div>
              <h1 className="text-[19px] md:text-[25px] font-semibold text-bone leading-tight">
                {product.name}
              </h1>

                {/* Price — selling price + strike MRP + save badge (red only
                    while a sale is active). */}
                <div className="mt-3 flex items-baseline flex-wrap gap-x-3 gap-y-1">
                  <span className={`font-price text-2xl md:text-3xl font-semibold ${showMrp ? 'text-crimson' : 'text-bone'}`}>
                    {retailPrice > 0 ? formatPrice(retailPrice) : '—'}
                  </span>
                  {showMrp && (
                    <span className="font-price text-lg md:text-xl text-grey line-through">
                      {formatPrice(mrp)}
                    </span>
                  )}
                  {showMrp && (
                    <span className="font-label text-[11px] uppercase tracking-wide-2 font-semibold text-crimson">
                      Save {Math.round(((mrp - retailPrice) / mrp) * 100)}%
                    </span>
                  )}
                </div>
              </div>

            {showShare && typeof navigator !== 'undefined' && typeof navigator.share !== 'function' && (
              (() => {
                const shareUrl = productShareUrl;
                const waUrl = `https://wa.me/?text=${encodeURIComponent(`${product.name} — ${shareUrl}`)}`;
                const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
                const xUrl = `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(product.name)}`;

                const handleCopyLink = async () => {
                  try {
                    await navigator.clipboard.writeText(shareUrl);
                    setLinkCopied(true);
                    window.setTimeout(() => setLinkCopied(false), 1800);
                  } catch {
                    const ta = document.createElement('textarea');
                    ta.value = shareUrl;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    setLinkCopied(true);
                    window.setTimeout(() => setLinkCopied(false), 1800);
                  }
                };

                return (
                  <div className="mt-3 w-full border border-line bg-paper-3 p-3 sm:p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={shareUrl}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 border border-line bg-white px-3 py-2 text-xs text-bone focus:border-bone focus:outline-none"
                      />
                      <button
                        onClick={handleCopyLink}
                        className="inline-flex items-center gap-1.5 shrink-0 btn-dark text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-2"
                      >
                        {linkCopied ? <Check size={12} strokeWidth={2.5} /> : <LinkIcon size={12} strokeWidth={2} />}
                        {linkCopied ? 'Copied' : 'Copy Link'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a href={waUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 border border-line hover:border-bone-dim text-bone-dim hover:text-bone transition-colors">WhatsApp</a>
                      <a href={fbUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 border border-line hover:border-bone-dim text-bone-dim hover:text-bone transition-colors">Facebook</a>
                      <a href={xUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 border border-line hover:border-bone-dim text-bone-dim hover:text-bone transition-colors">X</a>
                      <button onClick={() => { navigator.clipboard.writeText(shareUrl).then(() => { window.open('https://www.instagram.com/', '_blank'); }).catch(() => window.open('https://www.instagram.com/', '_blank')); }} className="text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 border border-line hover:border-bone-dim text-bone-dim hover:text-bone transition-colors">Instagram</button>
                    </div>
                  </div>
                );
              })()
            )}

            {/* Size + size chart */}
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">
                  Select Size
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSizeChartOpen(true)}
                    className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone underline underline-offset-4 decoration-line hover:text-bone transition-colors"
                  >
                    Size Chart
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {sizeOptions.map((label) => {
                  const stock = sizeDetail(label);
                  const isSelected = label === size;
                  const oos = stock <= 0;
                  return (
                    <button
                      key={label}
                      type="button"
                      disabled={oos}
                      onClick={() => selectSize(label)}
                      title={oos ? 'Out of stock' : undefined}
                      aria-pressed={isSelected}
                      className={`min-w-10 lg:min-w-9 border px-3 py-2 lg:py-1.5 text-xs lg:text-[11px] uppercase tracking-wide-2 font-medium transition-colors rounded-lg ${
                        isSelected
                          ? 'border-bone bg-bone text-paper'
                          : oos
                            ? 'border-line bg-paper-2 text-grey line-through decoration-[1.5px] opacity-50 cursor-not-allowed'
                            : 'border-line text-bone hover:border-bone'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {sizeOptions.length > 0 && !colorInStock && (
                <p className="text-xs text-grey mt-2">All sizes in this colour are unavailable right now.</p>
              )}
              {sizeOptions.length === 0 && (
                <p className="text-xs text-grey mt-2">Sizes for this colour are unavailable right now.</p>
              )}
            </div>

            {/* Colors — square swatches only (names shown above, not inside each swatch) */}
            <div className="mt-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mb-2">
                Colour — <span className="text-bone">{color.name}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2.5">
                {product.colors.map((c, i) => {
                  const hasImages = c.images.filter((x) => x.trim()).length > 0;
                  const selected = i === colorIdx;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!hasImages}
                      aria-label={`Colour ${c.name}`}
                      title={c.name}
                      onClick={() => selectColor(i)}
                      className={`w-8 h-8 lg:w-7 lg:h-7 shrink-0 border rounded-lg transition-all ${selected ? 'ring-1 ring-bone ring-offset-2 ring-offset-paper' : 'border-line hover:border-bone-dim'} disabled:opacity-40 disabled:cursor-not-allowed`}
                      style={{ backgroundColor: c.hex }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Quantity */}
            <div className="mt-4 flex items-center gap-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Qty</p>
              <div className={`inline-flex items-center border border-line bg-white ${!stockAvailable ? 'opacity-45 pointer-events-none' : ''}`}>
                <button
                  onClick={() => setQty(Math.max(1, qty - 1))}
                  className="w-11 h-12 lg:w-9 lg:h-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
                  aria-label="Decrease quantity"
                >
                  <Minus size={16} strokeWidth={2} className="lg:w-[14px] lg:h-[14px]" />
                </button>
                <span className="w-11 lg:w-9 text-center text-base lg:text-sm font-semibold tabular-nums text-bone select-none">
                  {cappedQty}
                </span>
                <button
                  onClick={() => setQty((q) => {
                    const next = q + 1;
                    return Math.min(next, stockAvailable ? selectedStock : 1);
                  })}
                  className="w-11 h-12 lg:w-9 lg:h-10 flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
                  aria-label="Increase quantity"
                >
                  <Plus size={16} strokeWidth={2} className="lg:w-[14px] lg:h-[14px]" />
                </button>
              </div>
            </div>

            {/* CTAs — always the same two solid black buttons with identical
                styling. When the selected size/colour is out of stock, ONLY
                the label switches to OUT OF STOCK (performAdd already no-ops,
                so clicks do nothing). Never grey/disabled. */}
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={handleAddToCart}
                aria-disabled={!stockAvailable}
                className="w-full btn-dark text-xs lg:text-[11px] uppercase tracking-wide-2 font-semibold py-4 lg:py-3.5 px-5 active:scale-[0.98]"
              >
                {stockAvailable && addedFeedback ? <CheckCircle2 size={15} strokeWidth={1.8} /> : <ShoppingBag size={15} strokeWidth={1.8} />}
                {stockAvailable ? (addedFeedback ? 'Added to Bag' : 'Add to Bag') : 'OUT OF STOCK'}
              </button>
              <button
                onClick={handleBuyNow}
                aria-disabled={!stockAvailable}
                className="w-full btn-dark text-xs lg:text-[11px] uppercase tracking-wide-2 font-semibold py-4 lg:py-3.5 px-5 active:scale-[0.98]"
              >
                <Zap size={15} strokeWidth={1.8} /> {stockAvailable ? 'Buy Now' : 'OUT OF STOCK'}
              </button>
            </div>

            {/* Description */}
            {product.description?.trim() && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mb-1.5">Description</p>
                <p className="text-sm text-bone-soft leading-relaxed whitespace-pre-line">{product.description}</p>
              </div>
            )}

            {/* Expandable info sections */}
            <div className="mt-5 border-t border-line divide-y divide-line">
              <InfoSection
                id="details"
                open={openInfo === 'details'}
                onToggle={() => setOpenInfo(openInfo === 'details' ? null : 'details')}
                title="Product Details"
              >
                <div className="space-y-1.5 text-[12px] text-grey leading-relaxed">
                  {product.details?.trim() && <p>{product.details}</p>}
                  {product.fabric?.trim() && <p>Fabric: {product.fabric}</p>}
                  {product.gsm ? <p>GSM: {product.gsm}</p> : null}
                  {product.wash?.trim() && <p>Wash: {product.wash}</p>}
                  {product.fit?.trim() && <p>Fit: {product.fit}</p>}
                </div>
              </InfoSection>
              <InfoSection
                id="shipping"
                open={openInfo === 'shipping'}
                onToggle={() => setOpenInfo(openInfo === 'shipping' ? null : 'shipping')}
                title="Shipping & Delivery"
              >
                <div className="space-y-1.5 text-[12px] text-grey leading-relaxed">
                  <p>Order dispatch typically 24–48 hrs.</p>
                  <p>Pan-India delivery.</p>
                </div>
              </InfoSection>
              <InfoSection
                id="returns"
                open={openInfo === 'returns'}
                onToggle={() => setOpenInfo(openInfo === 'returns' ? null : 'returns')}
                title="Returns & Exchange"
              >
                <div className="space-y-1.5 text-[12px] text-grey leading-relaxed">
                  <p>Free size exchange within 7 days of delivery.</p>
                </div>
              </InfoSection>
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

      {/* Size Chart modal — centered, not a bottom sheet. Sits above the
          announcement bar (z-100) + navbar (z-50) so the heavy backdrop blur
          covers the whole page including those fixed elements. */}
      {sizeChartOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center p-4 md:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Size chart"
        >
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-2xl"
            onClick={() => setSizeChartOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl max-h-[calc(100dvh-2rem)] md:max-h-[calc(100dvh-3rem)] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-3 shrink-0">
              <p className="font-label text-[10px] uppercase tracking-ultra text-grey">Size Chart</p>
              <button
                type="button"
                onClick={() => setSizeChartOpen(false)}
                className="w-9 h-9 inline-flex items-center justify-center text-bone-dim hover:text-bone transition-colors"
                aria-label="Close size chart"
              >
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              {product.size_chart && product.size_chart.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2.5 text-left font-label text-[10px] uppercase tracking-wide-2 text-grey pr-2">Size</th>
                      <th className="py-2.5 text-right font-label text-[10px] uppercase tracking-wide-2 text-grey px-2">Chest</th>
                      <th className="py-2.5 text-right font-label text-[10px] uppercase tracking-wide-2 text-grey px-2">Length</th>
                      <th className="py-2.5 text-right font-label text-[10px] uppercase tracking-wide-2 text-grey pl-2">Shoulder</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.size_chart.map((row) => (
                      <tr key={row.id} className="border-b border-line/60">
                        <td className="py-2.5 pr-2 font-medium text-bone uppercase">{row.size_label}</td>
                        <td className="py-2.5 px-2 text-right text-bone-soft tabular-nums">{row.chest}</td>
                        <td className="py-2.5 px-2 text-right text-bone-soft tabular-nums">{row.length}</td>
                        <td className="py-2.5 pl-2 text-right text-bone-soft tabular-nums">{row.shoulder}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-grey">Size chart isn't available for this product yet.</p>
              )}
              <p className="mt-2.5 text-[10px] uppercase tracking-[0.14em] text-[#0a0a0a]/55">Measurements in inches.</p>

              {/* How To Measure — compact list: small icon + label + one-line instruction */}
              <div className="mt-4 pt-4 border-t border-line">
                <p className="font-label text-[10px] uppercase tracking-ultra text-grey mb-3">How To Measure</p>
                <ul className="space-y-2.5">
                  <li className="flex items-center gap-3">
                    <span className="w-10 h-10 shrink-0 flex items-center justify-center rounded border border-line bg-paper-3 p-1">
                      <MeasurementFigure kind="chest" />
                    </span>
                    <p className="text-xs leading-snug text-bone-dim">
                      <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">Chest</span>
                      <span className="text-[#0a0a0a]/55"> — across the chest, armpit to armpit.</span>
                    </p>
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="w-10 h-10 shrink-0 flex items-center justify-center rounded border border-line bg-paper-3 p-1">
                      <MeasurementFigure kind="length" />
                    </span>
                    <p className="text-xs leading-snug text-bone-dim">
                      <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">Length</span>
                      <span className="text-[#0a0a0a]/55"> — highest shoulder point to bottom hem.</span>
                    </p>
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="w-10 h-10 shrink-0 flex items-center justify-center rounded border border-line bg-paper-3 p-1">
                      <MeasurementFigure kind="shoulder" />
                    </span>
                    <p className="text-xs leading-snug text-bone-dim">
                      <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">Shoulder</span>
                      <span className="text-[#0a0a0a]/55"> — shoulder point to shoulder point.</span>
                    </p>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Related */}
      {related.length > 0 && (
        <section className="border-t border-line py-12 md:py-16">
          <div className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8">
            <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone mb-4 md:mb-10">
              You Might Also Like
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-0.5 gap-y-6 md:gap-x-8 md:gap-y-10">
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

/** Minimal flat-lay tee outline, with a crimson measurement line overlaid for
 * chest / length / shoulder so the illustrated dimension reads at a glance. */
const TEE_OUTLINE =
  'M72 36 Q100 44 128 36 L152 40 Q164 46 158 62 L142 58 L142 178 Q142 190 130 190 L70 190 Q58 190 58 178 L58 58 L42 62 Q36 46 48 40 L72 36 Z';

function MeasurementFigure({ kind }: { kind: 'chest' | 'length' | 'shoulder' }) {
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={`How to measure - ${kind}`} className="w-full h-full block">
      <path
        d={TEE_OUTLINE}
        fill="#faf8f4"
        stroke="#0a0a0a"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <g stroke="#c1121f" strokeWidth="2.5" strokeLinecap="round">
        {kind === 'chest' && (
          <>
            <line x1="52" y1="100" x2="148" y2="100" />
            <line x1="52" y1="94" x2="52" y2="106" />
            <line x1="148" y1="94" x2="148" y2="106" />
          </>
        )}
        {kind === 'length' && (
          <>
            <line x1="46" y1="26" x2="46" y2="194" />
            <line x1="40" y1="26" x2="52" y2="26" />
            <line x1="40" y1="194" x2="52" y2="194" />
          </>
        )}
        {kind === 'shoulder' && (
          <>
            <line x1="42" y1="32" x2="158" y2="32" />
            <line x1="42" y1="26" x2="42" y2="38" />
            <line x1="158" y1="26" x2="158" y2="38" />
          </>
        )}
      </g>
    </svg>
  );
}

function InfoSection({
  id,
  open,
  onToggle,
  title,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`info-${id}`}
        className="w-full flex items-center justify-between py-3.5 text-left text-[12px] uppercase tracking-wide-2 font-medium text-bone hover:text-bone transition-colors"
      >
        <span>{title}</span>
        <ChevronDown
          size={15}
          strokeWidth={1.8}
          className={`text-grey transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div id={`info-${id}`} className="pb-4 -mt-1">{children}</div>}
    </div>
  );
}