import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Minus, Plus, ShoppingBag, CheckCircle2, Zap, Share2, Check, Link as LinkIcon, X, ChevronDown } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  getRetailPrice,
  getMrp,
  isRetailVisible,
  getSizesForColor,
  getVariantStock,
  formatPrice,
  type CatalogProduct,
} from '@/lib/catalog';
import { notFound } from '@/lib/notFound';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { useRouter } from '@/lib/router';
import { LoadingDots } from '@/components/LoadingDots';
import { SwipeGallery, DesktopGallery, LightboxViewer } from '@/components/ProductGallery';

/**
 * Retail (D2C) product page — the default experience for influencer traffic.
 * Wholesale pricing, MOQ/pack logic and wholesale CTAs are completely absent.
 * Stock is per color/size (product_sizes variant rows); quantity is capped at
 * the selected variant's stock.
 */

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
        const p = await fetchProduct(slug);
        if (cancelled) return;
        setProduct(p);
        if (p) {
          fetchProducts()
            .then((all) => {
              if (!cancelled) {
                setRelated(
                  all
                    .filter((x) => x.slug !== p.slug && isRetailVisible(x))
                    .slice(0, 4)
                );
              }
            })
            .catch(() => {});
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
            className="mt-8 font-label text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-3.5 hover:bg-crimson-dark transition-colors"
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
  if (!isRetailVisible(product)) return notFound();

  const color = product.colors[colorIdx];
  if (!color) return notFound();
  const images = color.images.filter((image) => image.trim().length > 0);
  if (images.length === 0) return notFound();
  const safeImgIdx = Math.max(0, Math.min(imgIdx, images.length - 1));

  const retailPrice = getRetailPrice(product);
  const mrp = getMrp(product);
  const showMrp = mrp !== null && mrp > retailPrice;

  const colorSizes = getSizesForColor(product, color.id);
  // Prefer an M/L/XL ordering; fall back to whatever rows exist.
  const sizeOptions = colorSizes.map((s) => s.size_label);
  const selectedSizeRow = colorSizes.find((s) => s.size_label === size) ?? null;
  const selectedStock = selectedSizeRow ? Number(selectedSizeRow.stock ?? 0) : 0;

  const sizeDetail = (label: string): number => {
    const row = colorSizes.find((s) => s.size_label === label);
    return row ? Math.max(0, Number(row.stock ?? 0)) : 0;
  };

  const cappedQty = selectedStock > 0 ? Math.min(qty, selectedStock) : qty;

  const performAdd = (): boolean => {
    if (!selectedSizeRow || selectedStock < 1) return false;
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
    window.setTimeout(() => setAddedFeedback(false), 1800);
  };

  const handleBuyNow = () => {
    if (performAdd()) navigate('/checkout');
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
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {/* Brand / category */}
                <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-1.5">
                  {product.badge ? `New · ${category}` : category}
                </p>
                <h1 className="text-2xl md:text-4xl lg:text-3xl xl:text-4xl font-semibold text-bone leading-tight">
                  {product.name}
                </h1>
                <p className="font-label text-sm md:text-base uppercase tracking-wide-2 text-grey mt-1">{product.code}</p>

                {/* Price */}
                <div className="mt-3 flex items-baseline flex-wrap gap-x-3 gap-y-1">
                  <span className="font-price text-xl md:text-2xl text-bone">
                    {retailPrice > 0 ? formatPrice(retailPrice) : '—'}
                  </span>
                  {showMrp && (
                    <span className="font-price text-base md:text-lg text-grey line-through">
                      {formatPrice(mrp)}
                    </span>
                  )}
                  {showMrp && (
                    <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-grey">
                      {Math.round(((mrp - retailPrice) / mrp) * 100)}% OFF
                    </span>
                  )}
                </div>
              </div>

            {/* Share */}
            {(() => {
              const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${window.location.hash.startsWith('#') ? '#' : ''}/#/product/${product.slug}` : '';
              const waUrl = `https://wa.me/?text=${encodeURIComponent(`${product.name} — ${shareUrl}`)}`;
              const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
              const xUrl = `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(product.name)}`;
              const hasShareApi = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

              const handleShare = () => {
                if (hasShareApi) {
                  navigator.share({ title: product.name, text: product.name, url: shareUrl }).catch(() => {});
                  return;
                }
                setShowShare((s) => !s);
              };

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
                <div className="shrink-0">
                  <button
                    onClick={handleShare}
                    className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson transition-colors"
                  >
                    <Share2 size={15} strokeWidth={1.8} /> Share
                  </button>
                  {showShare && !hasShareApi && (
                    <div className="mt-2 border border-line bg-paper-3 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={shareUrl}
                          onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 min-w-0 border border-line bg-white px-3 py-2 text-xs text-bone focus:border-crimson focus:outline-none"
                        />
                        <button
                          onClick={handleCopyLink}
                          className="inline-flex items-center gap-1.5 shrink-0 bg-crimson text-white text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-2 hover:bg-crimson-dark transition-colors"
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
                  )}
                </div>
              );
            })()}
            </div>

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
                    className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone underline underline-offset-4 decoration-line hover:text-crimson transition-colors"
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
                      onClick={() => setSize(label)}
                      className={`min-w-14 lg:min-w-12 border px-5 py-3 lg:px-4 lg:py-2.5 text-sm lg:text-xs uppercase tracking-wide-2 font-medium transition-colors ${
                        oos
                          ? 'border-line text-grey/40 line-through cursor-not-allowed'
                          : isSelected
                            ? 'border-bone bg-bone text-paper'
                            : 'border-line text-bone hover:border-bone'
                      }`}
                      disabled={oos}
                      title={oos ? `Out of stock` : undefined}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {sizeOptions.length === 0 && (
                <p className="text-xs text-grey mt-2">Sizes for this color are unavailable right now.</p>
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
                      onClick={() => setColorIdx(i)}
                      className={`w-8 h-8 lg:w-6 lg:h-6 shrink-0 border transition-all ${selected ? 'ring-1 ring-bone ring-offset-2 ring-offset-paper' : 'border-line hover:border-bone-dim'} disabled:opacity-40 disabled:cursor-not-allowed`}
                      style={{ backgroundColor: c.hex }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Quantity */}
            <div className="mt-4 flex items-center gap-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Qty</p>
              <div className="inline-flex items-center border border-line bg-white">
                <button
                  onClick={() => setQty(Math.max(1, qty - 1))}
                  className="w-11 h-12 lg:w-9 lg:h-10 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
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
                    if (selectedStock > 0) return Math.min(next, Math.max(selectedStock, 1));
                    return next;
                  })}
                  className="w-11 h-12 lg:w-9 lg:h-10 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
                  aria-label="Increase quantity"
                >
                  <Plus size={16} strokeWidth={2} className="lg:w-[14px] lg:h-[14px]" />
                </button>
              </div>
            </div>

            {/* CTAs — simple & compact (outline Add to Bag, filled Buy Now) */}
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={handleAddToCart}
                disabled={!selectedSizeRow || selectedStock < 1}
                className="w-full inline-flex items-center justify-center gap-2 border border-bone-dim bg-transparent text-bone text-xs lg:text-[11px] uppercase tracking-wide-2 font-semibold py-4 lg:py-3.5 px-5 transition-colors hover:border-bone disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {addedFeedback ? <CheckCircle2 size={15} strokeWidth={1.8} /> : <ShoppingBag size={15} strokeWidth={1.8} />}
                {addedFeedback ? 'Added to Bag' : 'Add to Bag'}
              </button>
              <button
                onClick={handleBuyNow}
                disabled={!selectedSizeRow || selectedStock < 1}
                className="w-full inline-flex items-center justify-center gap-2 bg-bone text-paper text-xs lg:text-[11px] uppercase tracking-wide-2 font-semibold py-4 lg:py-3.5 px-5 transition-colors hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Zap size={15} strokeWidth={1.8} />
                Buy Now
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

      {/* Size Chart modal */}
      {sizeChartOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end md:items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Size chart"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setSizeChartOpen(false)}
          />
          <div className="relative w-full max-w-md bg-white shadow-xl border border-line">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <p className="font-label text-[10px] uppercase tracking-ultra text-grey">Size Chart</p>
              <button
                type="button"
                onClick={() => setSizeChartOpen(false)}
                className="w-9 h-9 inline-flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
                aria-label="Close size chart"
              >
                <X size={18} strokeWidth={2} />
              </button>
            </div>
            <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
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
                        <td className="py-3 pr-2 font-medium text-bone uppercase">{row.size_label}</td>
                        <td className="py-3 px-2 text-right text-bone-soft tabular-nums">{row.chest}</td>
                        <td className="py-3 px-2 text-right text-bone-soft tabular-nums">{row.length}</td>
                        <td className="py-3 pl-2 text-right text-bone-soft tabular-nums">{row.shoulder}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-grey">Size chart isn't available for this product yet.</p>
              )}
              <p className="mt-3 text-[10px] uppercase tracking-[0.14em] text-[#0a0a0a]/55">Measurements in inches.</p>
            </div>
          </div>
        </div>
      )}

      {/* Related */}
      {related.length > 0 && (
        <section className="border-t border-line py-12 md:py-16">
          <div className="mx-auto px-3 md:px-12 lg:px-16 xl:px-20">
            <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone mb-4 md:mb-10">
              You Might Also Like
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-8">
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
        className="w-full flex items-center justify-between py-3.5 text-left text-[12px] uppercase tracking-wide-2 font-medium text-bone hover:text-crimson transition-colors"
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