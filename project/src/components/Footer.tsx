import { useState } from 'react';
import { MessageCircle, Mail, ChevronDown } from 'lucide-react';
import { Instagram } from '@/components/icons/Instagram';
import { linkHref } from '@/lib/router';
import { INSTAGRAM_URL, EMAIL } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';

const SHOP_LINKS = [
  { label: 'Collection', to: '/collection' },
  { label: 'New Drops', to: '/new-drops' },
];

const INFO_LINKS = [
  { label: 'About DSLANG', to: '/stock-dslang' },
  { label: 'Track Order', to: '/track-order' },
  { label: 'Contact', to: '/contact' },
];

const POLICY_LINKS = [
  { label: 'Terms & Conditions', to: '/terms-and-conditions' },
  { label: 'Privacy Policy', to: '/privacy-policy' },
  { label: 'Refund & Cancellation', to: '/refund-and-cancellation' },
  { label: 'Return Policy', to: '/return-policy' },
  { label: 'Shipping Policy', to: '/shipping-policy' },
];

const SECTIONS = [
  { key: 'shop', title: 'Shop', links: SHOP_LINKS },
  { key: 'info', title: 'Info', links: INFO_LINKS },
  { key: 'legal', title: 'Legal', links: POLICY_LINKS },
];

function FooterLinkList({ links }: { links: { label: string; to: string }[] }) {
  return (
    <ul className="space-y-3">
      {links.map((l) => (
        <li key={l.to}>
          <a href={linkHref(l.to)} className="text-sm text-white/70 hover:text-white transition-colors duration-150">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Footer() {
  const { settings } = useSiteSettings();
  const whatNumber = settings.whatsapp_number;
  const [open, setOpen] = useState<string | null>(null);

  const toggle = (key: string) => setOpen((current) => (current === key ? null : key));

  return (
    <footer className="border-t border-line bg-ink text-white">
      <div className="mx-auto px-6 md:px-12 lg:px-20 xl:px-28 py-10 md:py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-x-8 md:gap-x-10">
          <div className="pb-6 md:pb-0">
            <a href={linkHref('/')} className="font-brand text-3xl tracking-[0.03em] text-white leading-none">
              DSLANG
            </a>
            <p className="mt-2 font-label text-[11px] uppercase tracking-[0.22em] text-white/50">
              Slang of Design
            </p>
            <p className="mt-4 max-w-xs text-sm text-white/70 leading-relaxed">
              Streetwear designed with intent.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-white hover:text-white transition-colors duration-150" aria-label="Instagram">
                <Instagram size={18} strokeWidth={1.6} />
              </a>
              <a href={`https://wa.me/${whatNumber}`} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-white hover:text-white transition-colors duration-150" aria-label="WhatsApp">
                <MessageCircle size={18} strokeWidth={1.6} />
              </a>
              <a href={`mailto:${EMAIL}`} className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-white hover:text-white transition-colors duration-150" aria-label="Email">
                <Mail size={18} strokeWidth={1.6} />
              </a>
            </div>
          </div>

          {SECTIONS.map((s) => (
            <div key={s.key} className="border-b border-white/10 md:border-0">
              <button
                type="button"
                onClick={() => toggle(s.key)}
                aria-expanded={open === s.key}
                aria-controls={`footer-${s.key}`}
                className="w-full md:w-auto flex items-center justify-between py-3 md:py-0 md:pointer-events-none text-left"
              >
                <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-white/40">{s.title}</h4>
                <ChevronDown
                  size={16}
                  className={`shrink-0 md:hidden text-white/50 transition-transform duration-200 ${open === s.key ? 'rotate-180' : ''}`}
                />
              </button>
              <div
                id={`footer-${s.key}`}
                className={`md:mt-4 overflow-hidden md:block ${open === s.key ? 'block' : 'hidden'}`}
              >
                <div className="pb-4 md:pb-0">
                  <FooterLinkList links={s.links} />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 pt-6 border-t border-white/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-xs text-white/40">© {new Date().getFullYear()} DSLANG. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}