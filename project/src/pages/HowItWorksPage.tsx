import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import { buildWhatsAppGeneralUrl, getPackConfig } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';

export function HowItWorksPage() {
  const { settings } = useSiteSettings();
  const moq = settings.default_moq;
  const minOrderQty = settings.min_order_quantity;
  const pack = getPackConfig();
  const STEPS = [
    { n: '01', t: 'Browse', d: 'Explore the DSLANG wholesale collection.', detail: 'Open /collection and search designs and colorways that fit your store.' },
    { n: '02', t: 'Select', d: 'Pick whole color packs.', detail: 'Each color pack ships as a fixed mix — 1 pack = 6 PCS (2 M · 2 L · 2 XL). Sizes are not sold separately.' },
    { n: '03', t: 'Mix', d: `Mix color packs within the ${moq} PCS MOQ.`, detail: `Every included color starts at one full pack. Order acceptance starts from ${minOrderQty} PCS (${minOrderQty / pack.packSize} packs).` },
    { n: '04', t: 'Order', d: 'Submit your wholesale order via WhatsApp.', detail: 'Use the wholesale order sheet on any product, then send it straight to our WhatsApp with the color-pack breakdown.' },
    { n: '05', t: 'Confirm', d: 'We confirm availability, pricing and delivery.', detail: 'Our team confirms your order, final pricing and the delivery timeline on WhatsApp.' },
    { n: '06', t: 'Dispatch', d: 'Order dispatched across India.', detail: 'Packed and dispatched pan-India with tracking once the order is confirmed.' },
  ];
  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <div className="border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">The Process</p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            How Wholesale Works
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            From browsing to dispatch — a simple wholesale process built for retail stores and resellers.
          </p>
        </div>

        <div className="mt-8 md:mt-12 space-y-4 md:space-y-6 max-w-4xl">
          {STEPS.map((s) => (
            <div key={s.n} className="grid grid-cols-[auto_1fr] md:grid-cols-[90px_180px_1fr] items-start gap-4 md:gap-8 border border-line bg-paper-2 p-5 md:p-7">
              <span className="font-display text-4xl md:text-5xl text-crimson leading-none">{s.n}</span>
              <div>
                <p className="font-label text-lg md:text-xl uppercase tracking-[0.04em] font-bold text-bone">
                  {s.t}
                </p>
                <p className="mt-1 text-sm text-bone-soft leading-relaxed">{s.d}</p>
              </div>
              <p className="hidden md:block text-sm text-bone-dim leading-relaxed md:col-span-1 md:row-start-1 md:col-start-3 row-start-2 col-start-2">
                {s.detail}
              </p>
              <p className="md:hidden text-sm text-bone-dim leading-relaxed col-start-2">
                {s.detail}
              </p>
            </div>
          ))}
        </div>

        {/* MOQ note */}
        <div className="mt-10 max-w-4xl border-t border-line pt-8 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">MOQ {moq} PCS</p>
            <p className="mt-2 text-sm text-bone-soft">Minimum wholesale order per design.</p>
          </div>
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">Mixed Sizes &amp; Colors</p>
            <p className="mt-2 text-sm text-bone-soft">Any combination across M, L and XL.</p>
          </div>
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">Pan India</p>
            <p className="mt-2 text-sm text-bone-soft">Dispatched across India on confirmation.</p>
          </div>
        </div>

        <div className="mt-10 max-w-4xl flex flex-wrap gap-3">
          <Button href={linkHref('/collection')} variant="primary">
            Browse Collection <ArrowRight size={15} strokeWidth={2} />
          </Button>
          <Button
            href={buildWhatsAppGeneralUrl("Hi DSLANG! I want to understand the wholesale process and place my first order.")}
            external
            variant="outline"
          >
            <MessageCircle size={15} strokeWidth={2} /> Ask On WhatsApp
          </Button>
        </div>
      </div>
    </div>
  );
}