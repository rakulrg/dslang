import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import { buildWhatsAppGeneralUrl } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { WholesaleEnquiryForm } from '@/components/WholesaleEnquiryForm';

export function WholesalePage() {
  const { settings } = useSiteSettings();
  const OFFER = [
    { k: `MOQ ${settings.default_moq} PCS`, v: 'Minimum order per design — no single-color pressure.' },
    { k: 'Fixed Size Ratio', v: `Every color pack ships as ${settings.pack_m} M + ${settings.pack_l} L + ${settings.pack_xl} XL — sizes are never sold separately.` },
    { k: 'Mixed Colors', v: 'Split your quantity across every colorway of a design.' },
    { k: 'Slab Pricing', v: `${settings.default_moq}+ PCS earns the wholesale rate; 100+ PCS unlocks the better per-piece rate.` },
    { k: `${settings.delivery_note} Delivery`, v: 'Dispatched across India after WhatsApp confirmation.' },
    { k: 'WhatsApp Orders', v: 'Every order is confirmed personally by the DSLANG team.' },
  ];
  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <div className="border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">Wholesale Only</p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            Wholesale
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            Premium streetwear for stores and resellers. Transparent MOQ, mixed colors &amp; sizes,
            and wholesale pricing on every product.
          </p>
        </div>

        {/* Offer grid */}
        <div className="mt-8 md:mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          {OFFER.map((o) => (
            <div key={o.k} className="border border-line bg-concrete p-5 md:p-6">
              <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">{o.k}</p>
              <p className="mt-2 text-sm text-bone-soft leading-relaxed">{o.v}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12 max-w-6xl">
          <div>
            <div className="flex items-end justify-between mb-4">
              <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
                Wholesale Enquiry
              </h2>
            </div>
            <p className="mb-6 text-sm text-bone-soft leading-relaxed max-w-md">
              Tell us your store, city and rough quantity. The DSLANG wholesale team responds on WhatsApp.
            </p>
            <WholesaleEnquiryForm />
          </div>

          <div>
            <div className="flex items-end justify-between mb-4">
              <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
                Faster Route
              </h2>
            </div>
            <div className="border border-line bg-paper-2 p-6 md:p-8">
              <p className="text-sm text-bone-soft leading-relaxed">
                Skip the form and go straight to the collection. Pick whole color packs per design, and
                request your wholesale order — pricing shows live as you build your cart.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button href={linkHref('/collection')} variant="primary">
                  Browse Collection <ArrowRight size={15} strokeWidth={2} />
                </Button>
                <Button
                  href={buildWhatsAppGeneralUrl("Hi DSLANG! I'd like to discuss a wholesale order for my store.")}
                  external
                  variant="outline"
                >
                  <MessageCircle size={15} strokeWidth={2} /> WhatsApp Us
                </Button>
              </div>
              <div className="mt-6 border-t border-line pt-5">
                <a
                  href={linkHref('/how-it-works')}
                  className="font-label text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
                >
                  How Wholesale Works →
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}