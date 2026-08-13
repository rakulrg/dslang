import { useEffect, useState } from 'react';
import { Minus, Plus, MessageCircle, ChevronDown, Check } from 'lucide-react';
import { Button } from '@/components/Button';
import { ProductCard } from '@/components/ProductCard';
import {
  fetchProducts,
  fetchProduct,
  formatPrice,
  buildWhatsAppUrl,
  type CatalogProduct,
} from '@/lib/catalog';
import type { ProductColorRow, ProductSizeRow, SizeChartRow } from '@/lib/types';
import { linkHref } from '@/lib/router';
import { notFound } from '@/lib/notFound';

const ACCORDION = [
  { title: 'Size Chart', body: 'size' },
  { title: 'Shipping Info', body: 'shipping' },
  { title: 'Return Policy', body: 'returns' },
];

export function ProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<CatalogProduct | null | undefined>(undefined);
  const [related, setRelated] = useState<CatalogProduct[]>([]);

  const [colorIdx, setColorIdx] = useState(0);
  const [size, setSize] = useState('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [openAcc, setOpenAcc] = useState<string | null>('size');

  useEffect(() => {
    setProduct(undefined);
    setColorIdx(0);
    setSize('');
    setQty(1);
    setImgIdx(0);
    fetchProduct(slug)
      .then((p) => {
        setProduct(p);
        if (p) {
          fetchProducts()
            .then((all) => setRelated(all.filter((x) => x.slug !== p.slug).slice(0, 3)))
            .catch(() => {});
        }
      })
      .catch(() => setProduct(null));
  }, [slug]);

  if (product === null) return notFound();
  if (product === undefined) {
    return (
      <div className="pt-32 mx-auto max-w-[1400px] px-5 md:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-14">
          <div className="aspect-[3/4] bg-paper-3 border border-line animate-pulse" />
          <div className="space-y-4">
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
  const images = color.images;
  const canBuy = size !== '';

  const handleBuy = () => {
    if (!canBuy) return;
    const url = buildWhatsAppUrl({
      name: product.name,
      code: product.code,
      color: color.name,
      size,
      quantity: qty,
      price: product.price,
    });
    window.open(url, '_blank');
  };

  const discount = product.mrp
    ? Math.round(((product.mrp - product.price) / product.mrp) * 100)
    : null;

  const toggleAcc = (t: string) => setOpenAcc((o) => (o === t ? null : t));

  return (
    <div className="pt-20 md:pt-24">
      {/* Breadcrumb */}
      <div className="mx-auto max-w-[1400px] px-5 md:px-8 pt-6">
        <nav className="text-[11px] uppercase tracking-wide-2 text-grey flex items-center gap-2">
          <a href={linkHref('/shop')} className="hover:text-bone-dim transition-colors">Shop</a>
          <span>/</span>
          <span className="text-bone-dim">{product.name}</span>
        </nav>
      </div>

      <div className="mx-auto max-w-[1400px] px-5 md:px-8 py-8 md:py-12 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-14">
        {/* GALLERY */}
        <div className="flex flex-col-reverse md:flex-row gap-3 md:gap-4">
          {/* Thumbnails */}
          <div className="flex md:flex-col gap-3 overflow-x-auto md:overflow-visible no-scrollbar">
            {images.map((img: string, i: number) => (
              <button
                key={i}
                onClick={() => setImgIdx(i)}
                className={`relative shrink-0 w-16 h-20 md:w-20 md:h-24 overflow-hidden border transition-colors ${
                  i === imgIdx ? 'border-crimson' : 'border-line hover:border-bone-dim'
                }`}
              >
                <img src={img} alt={`${product.name} view ${i + 1}`} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
          {/* Main image */}
          <div className="relative flex-1 aspect-[3/4] overflow-hidden bg-paper-3 border border-line group">
            <img
              src={images[imgIdx]}
              alt={`${product.name} — ${color.name}`}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
            {product.badge && (
              <span className="absolute top-4 left-4 bg-crimson text-white text-[10px] uppercase tracking-wide-2 font-semibold px-2.5 py-1">
                {product.badge}
              </span>
            )}
          </div>
        </div>

        {/* INFO — clean layout, normal font name, no description */}
        <div className="md:py-2">
          <p className="text-[11px] uppercase tracking-ultra text-crimson mb-3">{product.drop_label}</p>
          <h1 className="text-2xl md:text-3xl font-semibold text-bone leading-tight">
            {product.name}
          </h1>
          <p className="text-[11px] uppercase tracking-wide-2 text-grey mt-2">{product.code}</p>

          {/* Price */}
          <div className="mt-5 flex items-center gap-3">
            <span className="text-2xl font-medium text-bone">{formatPrice(product.price)}</span>
            {product.mrp && (
              <>
                <span className="text-grey line-through text-lg">{formatPrice(product.mrp)}</span>
                <span className="text-crimson text-xs uppercase tracking-wide-2 font-semibold">
                  Save {discount}%
                </span>
              </>
            )}
          </div>

          {/* Color */}
          <div className="mt-8">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wide-2 text-grey">Color</span>
              <span className="text-[11px] uppercase tracking-wide-2 text-bone-dim">{color.name}</span>
            </div>
            <div className="flex items-center gap-3">
              {product.colors.map((c: ProductColorRow, i: number) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setColorIdx(i);
                    setImgIdx(0);
                  }}
                  className={`relative w-9 h-9 border transition-all ${
                    i === colorIdx ? 'border-crimson ring-1 ring-crimson ring-offset-2 ring-offset-paper' : 'border-line hover:border-bone-dim'
                  }`}
                  aria-label={c.name}
                  title={c.name}
                  style={{ backgroundColor: c.hex }}
                >
                  {i === colorIdx && (
                    <Check
                      size={14}
                      className="absolute inset-0 m-auto"
                      strokeWidth={2.5}
                      style={{ color: c.name === 'White' ? '#0a0a0a' : '#f5f5f5' }}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Size */}
          <div className="mt-7">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wide-2 text-grey">Size</span>
              <button
                onClick={() => setOpenAcc('size')}
                className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-crimson transition-colors"
              >
                Size Chart
              </button>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {product.sizes.map((s: ProductSizeRow) => (
                <button
                  key={s.id}
                  onClick={() => s.available && setSize(s.size_label)}
                  disabled={!s.available}
                  className={`min-w-[3.25rem] px-3 py-3 text-sm font-medium border transition-all duration-200 ${
                    !s.available
                      ? 'border-line text-grey line-through cursor-not-allowed bg-paper-2'
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
          <div className="mt-7">
            <span className="text-[11px] uppercase tracking-wide-2 text-grey block mb-3">Quantity</span>
            <div className="inline-flex items-center border border-line">
              <button
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="w-11 h-11 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30"
                disabled={qty <= 1}
                aria-label="Decrease quantity"
              >
                <Minus size={16} strokeWidth={2} />
              </button>
              <span className="w-12 text-center text-bone font-medium tabular-nums">{qty}</span>
              <button
                onClick={() => setQty((q) => Math.min(10, q + 1))}
                className="w-11 h-11 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30"
                disabled={qty >= 10}
                aria-label="Increase quantity"
              >
                <Plus size={16} strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Buy Now */}
          <div className="mt-8">
            <Button
              onClick={handleBuy}
              disabled={!canBuy}
              variant="primary"
              className="w-full py-5 text-sm"
            >
              <MessageCircle size={18} strokeWidth={2} />
              {canBuy ? 'Buy Now Via WhatsApp' : 'Select A Size To Continue'}
            </Button>
            {!canBuy && (
              <p className="mt-3 text-[11px] uppercase tracking-wide-2 text-crimson/80">
                Pick a size to unlock checkout
              </p>
            )}
            <p className="mt-3 text-xs text-grey leading-relaxed">
              Your order details open directly in WhatsApp. Confirm and pay there.
            </p>
          </div>

          {/* Quick specs */}
          <div className="mt-8 grid grid-cols-3 gap-4 border-t border-line pt-6">
            <div>
              <dt className="text-[10px] uppercase tracking-wide-2 text-grey">Fabric</dt>
              <dd className="mt-1 text-sm text-bone-dim">{product.fabric}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide-2 text-grey">Fit</dt>
              <dd className="mt-1 text-sm text-bone-dim">{product.fit}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide-2 text-grey">Care</dt>
              <dd className="mt-1 text-sm text-bone-dim leading-snug">{product.care}</dd>
            </div>
          </div>

          {/* Accordion */}
          <div className="mt-8 border-t border-line">
            {ACCORDION.map((a) => (
              <div key={a.title} className="border-b border-line">
                <button
                  onClick={() => toggleAcc(a.title)}
                  className="w-full flex items-center justify-between py-4 text-left"
                >
                  <span className="text-[11px] uppercase tracking-wide-2 text-bone-dim font-medium">
                    {a.title}
                  </span>
                  <ChevronDown
                    size={16}
                    className={`text-grey transition-transform duration-300 ${
                      openAcc === a.title ? 'rotate-180' : ''
                    }`}
                    strokeWidth={1.8}
                  />
                </button>
                {openAcc === a.title && (
                  <div className="pb-5 text-sm text-grey leading-relaxed animate-slide-down">
                    {a.body === 'size' && (
                      <div className="overflow-x-auto no-scrollbar">
                        {product.size_chart.length > 0 ? (
                          <table className="w-full text-left">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wide-2 text-grey">
                                <th className="py-2 pr-4 font-medium">Size</th>
                                <th className="py-2 pr-4 font-medium">Chest (in)</th>
                                <th className="py-2 pr-4 font-medium">Length (in)</th>
                                <th className="py-2 font-medium">Shoulder (in)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {product.size_chart.map((r: SizeChartRow) => (
                                <tr key={r.id} className="text-bone-dim border-t border-line">
                                  <td className="py-2.5 pr-4 font-medium text-bone">{r.size_label}</td>
                                  <td className="py-2.5 pr-4">{Number(r.chest)}</td>
                                  <td className="py-2.5 pr-4">{Number(r.length)}</td>
                                  <td className="py-2.5">{Number(r.shoulder)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <p>Size chart not available for this product.</p>
                        )}
                        <p className="mt-4 text-xs text-grey">
                          All measurements are approximate. For a regular fit, size down.
                        </p>
                      </div>
                    )}
                    {a.body === 'shipping' && (
                      <div className="space-y-2">
                        <p>Ships pan-India in 2–5 business days via tracked courier.</p>
                        <p>Free shipping on orders over ₹1,499. Flat ₹60 below that.</p>
                        <p>Cash on delivery available in select regions — confirm on WhatsApp.</p>
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
            ))}
          </div>
        </div>
      </div>

      {/* Related */}
      {related.length > 0 && (
        <section className="border-t border-line py-16 md:py-24">
          <div className="mx-auto max-w-[1400px] px-5 md:px-8">
            <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone mb-8 md:mb-12">
              More From Drop 01
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-8">
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
