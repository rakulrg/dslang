import { MessageCircle, Mail } from 'lucide-react';
import { Instagram } from '@/components/icons/Instagram';
import { linkHref } from '@/lib/router';
import { INSTAGRAM_URL, WHATSAPP_NUMBER, EMAIL } from '@/lib/catalog';

const FOOTER_LINKS = [
  { label: 'Shop All', to: '/shop' },
  { label: 'Contact', to: '/contact' },
  { label: 'Policies', to: '/policies' },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-paper-2">
      {/* Marquee tagline */}
      <div className="overflow-hidden border-b border-line py-4">
        <div className="flex whitespace-nowrap animate-marquee">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex shrink-0 items-center">
              {['Limited Drops', 'Premium Cotton', 'No Restocks', 'Small Batch'].map(
                (t) => (
                  <span
                    key={t}
                    className="font-condensed text-2xl uppercase tracking-wide-2 text-grey px-8 flex items-center gap-8"
                  >
                    {t}
                    <span className="text-crimson">/</span>
                  </span>
                )
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-5 md:px-8 py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
          {/* Brand */}
          <div className="md:col-span-2">
            <a
              href={linkHref('/')}
              className="font-display text-3xl tracking-wide-2 text-bone leading-none"
            >
              DSLANG<span className="text-crimson">.</span>
            </a>
            <p className="mt-5 text-sm text-bone-soft leading-relaxed max-w-sm">
              Limited drop streetwear. Once it sells out, it is gone.
            </p>
            <div className="mt-6 flex items-center gap-4">
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-300"
                aria-label="Instagram"
              >
                <Instagram size={18} strokeWidth={1.6} />
              </a>
              <a
                href={`https://wa.me/${WHATSAPP_NUMBER}`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-300"
                aria-label="WhatsApp"
              >
                <MessageCircle size={18} strokeWidth={1.6} />
              </a>
              <a
                href={`mailto:${EMAIL}`}
                className="w-10 h-10 flex items-center justify-center border border-line text-bone-dim hover:border-crimson hover:text-crimson transition-colors duration-300"
                aria-label="Email"
              >
                <Mail size={18} strokeWidth={1.6} />
              </a>
            </div>
          </div>

          {/* Quick links */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wide-2 text-grey mb-5">Quick Links</h4>
            <ul className="space-y-3">
              {FOOTER_LINKS.map((l) => (
                <li key={l.to}>
                  <a
                    href={linkHref(l.to)}
                    className="text-sm text-bone-dim hover:text-crimson transition-colors duration-300"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wide-2 text-grey mb-5">Get In Touch</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <a
                  href={`https://wa.me/${WHATSAPP_NUMBER}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bone-dim hover:text-crimson transition-colors duration-300"
                >
                  WhatsApp +91 99446 76178
                </a>
              </li>
              <li>
                <a
                  href={INSTAGRAM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bone-dim hover:text-crimson transition-colors duration-300"
                >
                  @dslang.in
                </a>
              </li>
              <li>
                <a
                  href={`mailto:${EMAIL}`}
                  className="text-bone-dim hover:text-crimson transition-colors duration-300"
                >
                  {EMAIL}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-line flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <p className="text-xs text-grey">
            © 2026 DSLANG. All rights reserved.
          </p>
          <a
            href={linkHref('/policies')}
            className="text-xs text-grey hover:text-bone-dim transition-colors"
          >
            Shipping · Returns · Terms
          </a>
        </div>
      </div>
    </footer>
  );
}
