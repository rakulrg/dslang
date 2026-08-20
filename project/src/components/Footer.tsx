import { MessageCircle, Mail } from 'lucide-react';
import { Instagram } from '@/components/icons/Instagram';
import { linkHref } from '@/lib/router';
import { INSTAGRAM_URL, WHATSAPP_NUMBER, EMAIL } from '@/lib/catalog';

const FOOTER_LINKS = [
  { label: 'Sale', to: '/shop' },
  { label: 'Profile', to: '/account' },
  { label: 'Orders', to: '/account' },
  { label: 'Contact Us', to: '/contact' },
  { label: 'Privacy Policy', to: '/policies' },
  { label: 'Shipping Policy', to: '/policies' },
  { label: 'Terms of Service', to: '/policies' },
  { label: 'Return / Refund Policy', to: '/policies' },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-paper-2">
      <div className="mx-auto px-6 md:px-12 lg:px-20 xl:px-28 py-8 md:py-10">
        <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr] gap-8 md:gap-10">
          <div>
            <a href={linkHref('/')} className="font-brand text-3xl tracking-[0.03em] text-bone leading-none">
              DSLANG<span className="text-crimson">.</span>
            </a>
            <p className="mt-4 max-w-sm text-sm text-bone-soft leading-relaxed">
              Premium street essentials for everyday movement.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="Instagram">
                <Instagram size={18} strokeWidth={1.6} />
              </a>
              <a href={`https://wa.me/${WHATSAPP_NUMBER}`} target="_blank" rel="noopener noreferrer" className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="WhatsApp">
                <MessageCircle size={18} strokeWidth={1.6} />
              </a>
              <a href={`mailto:${EMAIL}`} className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-150" aria-label="Email">
                <Mail size={18} strokeWidth={1.6} />
              </a>
            </div>
          </div>

          <div>
            <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-grey mb-4">Navigation</h4>
            <ul className="space-y-3">
              {FOOTER_LINKS.map((l) => (
                <li key={`${l.label}-${l.to}`}>
                  <a href={linkHref(l.to)} className="text-sm text-bone-dim hover:text-crimson transition-colors duration-150">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-label text-[11px] uppercase tracking-wide-2 text-grey mb-4">Contact</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <a href={`https://wa.me/${WHATSAPP_NUMBER}`} target="_blank" rel="noopener noreferrer" className="text-bone-dim hover:text-crimson transition-colors duration-150">
                  WhatsApp +91 99446 76178
                </a>
              </li>
              <li>
                <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="text-bone-dim hover:text-crimson transition-colors duration-150">
                  @dslang.in
                </a>
              </li>
              <li>
                <a href={`mailto:${EMAIL}`} className="text-bone-dim hover:text-crimson transition-colors duration-150">
                  {EMAIL}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-line flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-xs text-grey">© 2026 DSLANG. All rights reserved.</p>
          <a href={linkHref('/policies')} className="text-xs text-grey hover:text-bone-dim transition-colors">
            Shipping · Returns · Terms
          </a>
        </div>
      </div>
    </footer>
  );
}
