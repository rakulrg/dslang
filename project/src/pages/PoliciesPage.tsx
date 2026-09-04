import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSiteSettings } from '@/lib/settings';

const POLICY_TABS = [
  { id: 'shipping', label: 'Shipping' },
  { id: 'returns', label: 'Returns & Claims' },
  { id: 'privacy', label: 'Privacy' },
];

const CONTENT: Record<string, { q: string; a: string }[]> = {
  shipping: [
    { q: 'Processing Time', a: 'Orders are processed within 24–48 hours of confirmation and dispatched from Tiruppur, Tamil Nadu.' },
    { q: 'Dispatch', a: 'Pan-India delivery takes 3–7 business days depending on your location. Remote areas may take up to 10 days.' },
    { q: 'Shipping Charges', a: 'Shipping is shown at checkout as a flat rate. You will receive a tracking link once your order ships.' },
    { q: 'Order Confirmation', a: 'Every order is personally reviewed by the DSLANG team. We confirm dispatch details on WhatsApp before your order leaves.' },
  ],
  returns: [
    { q: 'Quality Check', a: 'Every piece is quality-checked before dispatch. If you receive a damaged or incorrect item, contact us on WhatsApp within 48 hours of delivery with photos. We will replace it at no cost.' },
    { q: 'Exchange Policy', a: '7-day size exchange. The item must be unworn, unwashed, and have all original tags intact. Reach out on WhatsApp within 7 days of delivery to arrange an exchange.' },
    { q: 'Sale Or Clearance Lots', a: 'Clearance and labelled-final-sale items are non-returnable and non-exchangeable.' },
    { q: 'Claims', a: 'Damage, shortage or dispatch-error claims must be raised within 48 hours of delivery. Claims received later cannot be processed.' },
  ],
  privacy: [
    { q: 'What We Collect', a: 'When you place an order, we collect your name, contact number, delivery address and order details — only what is needed to process and ship your order.' },
    { q: 'How We Use It', a: 'Your information is used solely for order processing, delivery and order-related communication. We do not share your details with any marketplace or third-party marketing.' },
    { q: 'No Third-Party Sharing', a: 'We never sell or share your personal information with third parties for marketing. Courier partners receive only the details needed to deliver your order.' },
    { q: 'Your Data', a: 'You can request deletion of your contact information from our records at any time by messaging us on WhatsApp.' },
  ],
};

export function PoliciesPage() {
  const [tab, setTab] = useState('shipping');
  const [open, setOpen] = useState<number | null>(0);
  const { settings } = useSiteSettings();
  const content = CONTENT[tab] ?? [];

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
          {content.map((item, i) => (
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