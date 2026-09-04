import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import { buildWhatsAppGeneralUrl } from '@/lib/catalog';

const STEPS = [
  { n: '01', t: 'Browse', d: 'Browse the collection and new drops.', detail: 'The retail store runs on the full catalog — heavy quality, oversized fits.' },
  { n: '02', t: 'Pick', d: 'Choose colour, size and quantity.', detail: 'Pick from M / L / XL per colour. Stock is live per size.' },
  { n: '03', t: 'Checkout', d: 'Add to bag and place the order.', detail: 'Add to bag, enter delivery details and place your order in seconds.' },
  { n: '04', t: 'Confirm', d: 'We confirm on WhatsApp.', detail: 'You get an order reference and we confirm dispatch details quickly.' },
  { n: '05', t: 'Dispatch', d: 'We ship in 24–48 hrs.', detail: 'Packed and dispatched pan-India with tracking.' },
  { n: '06', t: 'Wear', d: 'Join the slang.', detail: 'Easy size exchanges within 7 days of delivery.' },
];

export function HowItWorksPage() {
  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <div className="border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">The Process</p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            How It Works
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            From browsing to doorstep — how ordering your DSLANG piece works.
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

        {/* Highlights */}
        <div className="mt-10 max-w-4xl border-t border-line pt-8 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">M / L / XL</p>
            <p className="mt-2 text-sm text-bone-soft">Live per-colour size stock.</p>
          </div>
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">24–48 HRS</p>
            <p className="mt-2 text-sm text-bone-soft">Dispatch across India.</p>
          </div>
          <div className="border border-line p-5">
            <p className="font-display text-2xl uppercase tracking-wide-2 text-bone">7-DAY SWAP</p>
            <p className="mt-2 text-sm text-bone-soft">Easy size exchanges.</p>
          </div>
        </div>

        <div className="mt-10 max-w-4xl flex flex-wrap gap-3">
          <Button href={linkHref('/collection')} variant="primary">
            Shop The Collection <ArrowRight size={15} strokeWidth={2} />
          </Button>
          <Button
            href={buildWhatsAppGeneralUrl('Hi DSLANG! I have a question about ordering.')}
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