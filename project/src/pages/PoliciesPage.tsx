import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FREE_SHIPPING_THRESHOLD } from '@/lib/catalog';

const POLICY_TABS = [
  { id: 'shipping', label: 'Shipping' },
  { id: 'returns', label: 'Returns' },
  { id: 'terms', label: 'Terms' },
  { id: 'privacy', label: 'Privacy' },
];

const CONTENT: Record<string, { q: string; a: string }[]> = {
  shipping: [
    { q: 'Processing Time', a: 'Orders are processed within 24–48 hours of confirmation on WhatsApp. You will receive a tracking link once your order ships.' },
    { q: 'Delivery Time', a: 'Pan-India delivery takes 2–5 business days depending on your location. Remote areas may take up to 7 days.' },
    { q: 'Shipping Charges', a: `Free shipping on orders over ₹${FREE_SHIPPING_THRESHOLD}. A flat ₹60 applies on orders below that. COD is available in select regions — confirm on WhatsApp before ordering.` },
    { q: 'Order Confirmation', a: 'Since checkout happens on WhatsApp, every order is personally confirmed by our team before dispatch. Nothing ships without your confirmation.' },
  ],
  returns: [
    { q: 'Exchange Policy', a: '7-day exchange for size issues only. The item must be unworn, unwashed, and have all original tags intact. Reach out on WhatsApp within 7 days of delivery to start an exchange.' },
    { q: 'Non-Returnable Items', a: 'Discounted, sale, or clearance items are final sale and cannot be exchanged or returned.' },
    { q: 'Damaged Or Wrong Item', a: 'If you receive a damaged or incorrect item, contact us on WhatsApp within 48 hours of delivery with a photo. We will replace it at no cost.' },
    { q: 'Refunds', a: 'Refunds are issued only in cases where a replacement is not available. Refunds are processed to the original payment method within 5–7 business days.' },
  ],
  terms: [
    { q: 'How To Order', a: 'Browse products on the site, add items to your cart, and place your order directly through WhatsApp. There is no on-site payment gateway — all purchases are confirmed and completed via WhatsApp.' },
    { q: 'Pricing', a: 'All prices are listed in Indian Rupees (₹) and are inclusive of applicable taxes. Prices may change between drops. The price confirmed on WhatsApp at the time of order is final.' },
    { q: 'Product Representation', a: 'We do our best to represent colours and fits accurately, but fabric colours may vary slightly from screen to screen due to photography lighting and display settings.' },
    { q: 'Wholesale Enquiries', a: 'DSLANG runs a growing wholesale network across Tamil Nadu. For wholesale pricing and minimum order quantities, reach out on WhatsApp or email.' },
  ],
  privacy: [
    { q: 'What We Collect', a: 'When you place an order via WhatsApp, we collect your name, contact number, and delivery address — only what is needed to ship your order.' },
    { q: 'How We Use It', a: 'Your information is used solely for order processing, delivery, and order-related communication. We do not send promotional messages without your consent.' },
    { q: 'No Third-Party Sharing', a: 'We never sell or share your personal information with third parties for marketing. Courier partners receive only the details needed to deliver your order.' },
    { q: 'Your Data', a: 'You can request deletion of your contact information from our records at any time by messaging us on WhatsApp.' },
  ],
};

export function PoliciesPage() {
  const [tab, setTab] = useState('shipping');
  const [open, setOpen] = useState<number | null>(0);

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
              className={`text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 border transition-colors duration-150 ${
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
          {CONTENT[tab].map((item, i) => (
            <div key={i} className="border-b border-line">
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between gap-4 py-5 text-left"
              >
                <span className="font-condensed text-xl md:text-2xl uppercase tracking-wide-2 text-bone">
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
          <p>Questions about any of this? Message us on WhatsApp at +91 99446 76178 — we are happy to clarify.</p>
        </div>
      </div>
    </div>
  );
}
