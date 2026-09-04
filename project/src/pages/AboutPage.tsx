import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import { Instagram } from '@/components/icons/Instagram';
import { INSTAGRAM_URL } from '@/lib/catalog';

export function AboutPage() {
  const SPECS = [
    { k: 'Origin', v: 'Tiruppur, Tamil Nadu' },
    { k: 'Fabric', v: 'Heavy 240 GSM Combed Cotton' },
    { k: 'Fits', v: 'Oversized · M / L / XL' },
    { k: 'Curation', v: 'Original In-House Graphics' },
    { k: 'Dispatch', v: 'Pan-India · 24–48 hrs' },
    { k: 'Stock', v: 'Live Per Size & Colour' },
  ];
  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-5 md:px-12 lg:px-20 xl:px-28">
        <div className="border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">
            About DSLANG
          </p>
          <h1 className="font-display text-4xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            The Slang Of Design
          </h1>
          <p className="mt-4 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            Premium oversized streetwear, designed in-house and built to be worn — not just seen.
          </p>
        </div>

        <div className="mt-8 md:mt-12 grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12 max-w-6xl">
          <div>
            <p className="text-bone-soft leading-relaxed text-sm md:text-base">
              DSLANG designs original streetwear collections in-house — every graphic starts from a
              concept and is developed as a finished piece. Heavy 240 GSM combed cotton, oversized
              boxy cuts, and curated colourways built for real everyday wear.
            </p>
            <p className="mt-4 text-bone-soft leading-relaxed text-sm md:text-base">
              Each drop ships in M / L / XL with live per-size stock, across India in 24–48 hours.
              Sizing is simple to swap within 7 days of delivery.
            </p>
            <p className="mt-4 text-bone-soft leading-relaxed text-sm md:text-base">
              Manufacturing in Tiruppur, Tamil Nadu. Delivered pan-India.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button href={linkHref('/collection')} variant="primary">
                Shop The Collection <ArrowRight size={15} strokeWidth={2} />
              </Button>
              <Button href={linkHref('/contact')} variant="outline">
                Contact DSLANG
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
                Dropping Weekly · All Over India
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