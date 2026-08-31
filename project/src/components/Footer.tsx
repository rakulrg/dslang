import { MessageCircle, Mail, MapPin } from 'lucide-react';
import { Instagram } from '@/components/icons/Instagram';
import { linkHref } from '@/lib/router';
import { INSTAGRAM_URL, EMAIL } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';

const QUICK_LINKS = [
  { label: 'Collection', to: '/collection' },
  { label: 'New Drops', to: '/new-drops' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'Stock DSLANG', to: '/stock-dslang' },
  { label: 'Wholesale', to: '/wholesale' },
  { label: 'Contact', to: '/contact' },
];

export function Footer() {
  const { settings } = useSiteSettings();
  const whatNumber = settings.whatsapp_number;
  const wholesaleNotes = [
    `Min. order 8 packs (48 PCS)`,
    'Mixed Sizes & Colors',
    `${settings.delivery_note} Delivery`,
    settings.dispatch_note,
  ];
  return (
    <footer className="border-t border-line bg-ink text-white">
      <div className="mx-auto px-6 md:px-12 lg:px-20 xl:px-28 py-10 md:py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr] gap-8 md:gap-10">
          <div>
            <a href={linkHref('/')} className="font-brand text-3xl tracking-[0.03em] text-white leading-none">
              DSLANG<span className="text-crimson">.</span>
            </a>
            <p className="mt-2 font-label text-[11px] uppercase tracking-[0.22em] text-white/50">
              Slang of Design
            </p>
            <p className="mt-4 max-w-xs text-sm text-white/70 leading-relaxed">
              Premium oversized streetwear. Wholesale for stores, resellers and multi-brand retailers.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="Instagram">
                <Instagram size={18} strokeWidth={1.6} />
              </a>
              <a href={`https://wa.me/${whatNumber}`} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="WhatsApp">
                <MessageCircle size={18} strokeWidth={1.6} />
              </a>
              <a href={`mailto:${EMAIL}`} className="w-10 h-10 flex items-center justify-center border border-white/20 text-white/70 hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="Email">
                <Mail size={18} strokeWidth={1.6} />
              </a>
            </div>
          </div>

          <div>
            <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-white/40 mb-4">Quick Links</h4>
            <ul className="space-y-3">
              {QUICK_LINKS.map((l) => (
                <li key={l.to}>
                  <a href={linkHref(l.to)} className="text-sm text-white/70 hover:text-crimson transition-colors duration-150">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-white/40 mb-4">Wholesale</h4>
            <ul className="space-y-3">
              {wholesaleNotes.map((n) => (
                <li key={n} className="text-sm text-white/70">{n}</li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-white/40 mb-4">Contact</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <a href={`https://wa.me/${whatNumber}`} target="_blank" rel="noopener noreferrer" className="text-white/70 hover:text-crimson transition-colors duration-150">
                  WhatsApp +91 {whatNumber}
                </a>
              </li>
              <li>
                <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="text-white/70 hover:text-crimson transition-colors duration-150">
                  @dslang.in
                </a>
              </li>
              <li>
                <a href={`mailto:${EMAIL}`} className="text-white/70 hover:text-crimson transition-colors duration-150">
                  {EMAIL}
                </a>
              </li>
            </ul>
            <div className="mt-5 flex items-start gap-2 text-sm text-white/50">
              <MapPin size={15} strokeWidth={1.6} className="mt-0.5 shrink-0 text-crimson" />
              <span>Tiruppur, Tamil Nadu, India</span>
            </div>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-white/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-xs text-white/40">© 2026 DSLANG. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <span className="font-label text-[10px] uppercase tracking-[0.2em] text-white/50">Wholesale Only</span>
            <a href={linkHref('/policies')} className="text-xs text-white/40 hover:text-white/70 transition-colors">
              Policies
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}