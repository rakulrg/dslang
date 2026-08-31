import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getPackConfig, MIN_PACKS, MIN_ORDER_PCS, TIER_100_PCS } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';

const POLICY_TABS = [
  { id: 'wholesale', label: 'Wholesale Terms' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'returns', label: 'Returns & Claims' },
  { id: 'privacy', label: 'Privacy' },
];

const CONTENT = (pack: ReturnType<typeof getPackConfig>): Record<string, { q: string; a: string }[]> => ({
  wholesale: [
    { q: 'Minimum Order Quantity', a: `Every wholesale order is accepted from ${MIN_ORDER_PCS} PCS (${MIN_PACKS} packs) of the same design. You order in whole colour packs — 1 pack = ${pack.packSize} PCS, always packed as ${pack.m} M · ${pack.l} L · ${pack.xl} XL. Sizes are not sold separately, and any mix of colours counts toward the same order.` },
    { q: 'Wholesale Pricing', a: `Each design carries two wholesale slabs: the ${MIN_ORDER_PCS}–${TIER_100_PCS - 6} PCS price and the better ${TIER_100_PCS}+ PCS price, shown per piece on the product page. Orders of ${TIER_100_PCS}+ PCS automatically get the higher tier across the entire order.` },
    { q: 'How To Order', a: 'Pick whole colour packs on the product page or add them to the wholesale order. Request the order on WhatsApp with your store name, city and delivery address — our team confirms availability and sends a final quote before dispatch.' },
    { q: 'Who Can Order', a: 'We work with streetwear stores, boutiques, online resellers and independent brands. Wholesale pricing and minimums apply to all confirmed wholesale orders.' },
  ],
  shipping: [
    { q: 'Processing Time', a: 'Wholesale orders are processed within 2–4 working days of confirmation on WhatsApp. You will receive a tracking link once your order ships.' },
    { q: 'Dispatch', a: 'Dispatched from Tiruppur, Tamil Nadu. Pan-India delivery takes 3–7 business days depending on your location. Remote areas may take up to 10 days.' },
    { q: 'Shipping Charges', a: 'Shipping is quoted per order on WhatsApp based on weight and destination. Bulk orders often qualify for subsidised rates — confirm before dispatch.' },
    { q: 'Order Confirmation', a: 'Nothing ships without your confirmation. Every order is personally reviewed by the DSLANG team on WhatsApp before dispatch.' },
  ],
  returns: [
    { q: 'Quality Check', a: 'Every piece is quality-checked before dispatch. If you receive a damaged or incorrect item, contact us on WhatsApp within 48 hours of delivery with photos. We will replace it at no cost.' },
    { q: 'Exchange Policy', a: '7-day exchange for size issues on wholesale orders. The items must be unworn, unwashed, and have all original tags intact. Reach out on WhatsApp within 7 days of delivery to arrange an exchange.' },
    { q: 'Sale Or Clearance Lots', a: 'Clearance and labelled-final-sale lots are non-returnable and non-exchangeable.' },
    { q: 'Claims', a: 'Damage, shortage or dispatch-error claims must be raised within 48 hours of delivery. Claims received later cannot be processed.' },
  ],
  privacy: [
    { q: 'What We Collect', a: 'When you place a wholesale order via WhatsApp, we collect your store name, contact number, city and delivery address — only what is needed to process and ship your order.' },
    { q: 'How We Use It', a: 'Your information is used solely for order processing, delivery and order-related communication. We do not share your details with any marketplace or third-party marketing.' },
    { q: 'No Third-Party Sharing', a: 'We never sell or share your personal or business information with third parties for marketing. Courier partners receive only the details needed to deliver your order.' },
    { q: 'Your Data', a: 'You can request deletion of your contact information from our records at any time by messaging us on WhatsApp.' },
  ],
});

export function PoliciesPage() {
  const [tab, setTab] = useState('wholesale');
  const [open, setOpen] = useState<number | null>(0);
  const { settings } = useSiteSettings();
  const content = CONTENT(getPackConfig());

  return (
    <div className="pt-4 pb-12 md:pt-8 md:pb-20">
      <div className="mx-auto max-w-[1000px] px-5 md:px-8">
        <h1 className="font-display text-5xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
          Policies
        </h1>

        {/* Tabs */}
        <div className="mt-6 md:mt-8 flex flex-wrap gap-3 border-b border-line pb-4">
          {POLICY_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setOpen(0); }}
              className={`font-label text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 border transition-colors duration-150 ${
                tab === t.id
                  ? 'bg-bone text-paper border-bone'
                  : 'border-line text-bone-dim hover:border-bone-dim hover:text-bone'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Accordion */}
        <div className="mt-8">
          {content[tab].map((item, i) => (
            <div key={i} className="border-b border-line">
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between gap-4 py-5 text-left"
              >
                <span className="font-label text-xl md:text-2xl uppercase tracking-wide-2 text-bone">
                  {item.q}
                </span>
                <ChevronDown
                  size={18}
                  className={`shrink-0 text-grey transition-transform duration-300 ${open === i ? 'rotate-180' : ''}`}
                  strokeWidth={1.8}
                />
              </button>
              {open === i && (
                <div className="pb-5 text-bone-dim leading-relaxed animate-slide-down">
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-8 border-t border-line pt-6 text-sm text-grey">
          <p>Questions about any of this? Message us on WhatsApp at +91 {settings.whatsapp_number} — we are happy to clarify.</p>
        </div>
      </div>
    </div>
  );
}