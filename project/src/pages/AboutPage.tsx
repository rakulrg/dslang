import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import { buildWhatsAppGeneralUrl } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { Instagram } from '@/components/icons/Instagram';
import { INSTAGRAM_URL } from '@/lib/catalog';

export function AboutPage() {
  const { settings } = useSiteSettings();
  const SPECS = [
    { k: 'Wholesale Pricing', v: 'Clean slab pricing per design' },
    { k: 'MOQ', v: `${settings.default_moq} PCS` },
    { k: 'Mix', v: 'Mixed Sizes & Colors' },
    { k: 'Curation', v: 'Original In-House Graphics' },
    { k: 'Colorways', v: 'Multiple per design' },
    { k: 'Delivery', v: `${settings.delivery_note}, Pan India` },
  ];
  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <div className="border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">
            For Retailers, Resellers &amp; Multi-Brand Stores
          </p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            Stock DSLANG
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            Bring DSLANG to your store. Premium oversized streetwear built for modern retail.
          </p>
        </div>

        <div className="mt-8 md:mt-12 grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12 max-w-6xl">
          <div>
            <p className="text-bone-soft leading-relaxed text-sm md:text-base">
              DSLANG builds premium streetwear collections for modern retailers, resellers and multi-brand
              stores across India. Every design is original, developed in-house, and produced with a
              premium finish that moves on a retail rack.
            </p>
            <p className="mt-4 text-bone-soft leading-relaxed text-sm md:text-base">
              We build collections to move on a retail rack — curated colorways, retail-friendly M / L / XL
              sizing, and a simple wholesale process: pick designs, mix colors and sizes up to your MOQ, and
              order direct on WhatsApp.
            </p>
            <p className="mt-4 text-bone-soft leading-relaxed text-sm md:text-base">
              Manufacturing in Tiruppur, Tamil Nadu. Delivered pan-India.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button href={linkHref('/collection')} variant="primary">
                Start Wholesale Order <ArrowRight size={15} strokeWidth={2} />
              </Button>
              <Button
                href={buildWhatsAppGeneralUrl("Hi DSLANG! I'd like to stock DSLANG in my store.")}
                external
                variant="outline"
              >
                <MessageCircle size={15} strokeWidth={2} /> Order On WhatsApp
              </Button>
            </div>

            <div className="mt-8 flex items-center gap-4">
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson transition-colors"
              >
                <Instagram size={16} strokeWidth={1.6} /> @dslang.in
              </a>
              <span className="text-grey text-[11px] uppercase tracking-wide-2">·</span>
              <span className="text-grey text-[11px] uppercase tracking-wide-2">
                Instagram → Website → Wholesale Order
              </span>
            </div>
          </div>

          <div className="border border-line bg-paper-2">
            <div className="px-5 py-4 border-b border-line">
              <p className="font-label text-[10px] uppercase tracking-ultra text-crimson">At A Glance</p>
            </div>
            <dl className="grid grid-cols-2 divide-x divide-y divide-line">
              {SPECS.map((s) => (
                <div key={s.k} className="px-5 py-4">
                  <dt className="font-label text-[10px] uppercase tracking-wide-2 text-grey">{s.k}</dt>
                  <dd className="mt-1 font-label text-sm md:text-base uppercase tracking-[0.04em] font-bold text-bone">
                    {s.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}