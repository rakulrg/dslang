import { MessageCircle, Mail, MapPin } from 'lucide-react';
import { Button } from '@/components/Button';
import {
  INSTAGRAM_URL,
  WHATSAPP_NUMBER,
  EMAIL,
  buildWhatsAppGeneralUrl,
} from '@/lib/catalog';
import { Instagram } from '@/components/icons/Instagram';

const CHANNELS = [
  {
    icon: MessageCircle,
    label: 'WhatsApp',
    value: '+91 99446 76178',
    note: 'Fastest reply. Order confirmations & delivery questions.',
    href: `https://wa.me/${WHATSAPP_NUMBER}`,
  },
  {
    icon: Instagram,
    label: 'Instagram',
    value: '@dslang.in',
    note: 'Drops, restocks, and behind-the-scenes.',
    href: INSTAGRAM_URL,
  },
  {
    icon: Mail,
    label: 'Email',
    value: EMAIL,
    note: 'Wholesale & partnership enquiries.',
    href: `mailto:${EMAIL}`,
  },
];

export function ContactPage() {
  return (
    <div className="pt-28 md:pt-36 pb-20 md:pb-32">
      <div className="mx-auto max-w-[1400px] px-5 md:px-8">
        {/* Header */}
        <p className="text-[11px] uppercase tracking-ultra text-crimson mb-5">Get In Touch</p>
        <h1 className="font-display text-5xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
          Let's Talk
        </h1>
        <p className="mt-6 text-bone-dim max-w-xl leading-relaxed">
          Questions about a drop, a size, or a wholesale order? Reach out — we reply fast and we keep it real. No bots, no call centres.
        </p>

        {/* Channels */}
        <div className="mt-12 md:mt-16 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          {CHANNELS.map((c, i) => (
            <a
              key={c.label}
              href={c.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group border border-line bg-paper-2 p-6 md:p-8 hover:border-crimson transition-colors duration-300 animate-fade-up"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <c.icon size={28} className="text-crimson mb-5" strokeWidth={1.5} />
              <h3 className="text-[11px] uppercase tracking-wide-2 text-grey mb-2">{c.label}</h3>
              <p className="font-condensed text-2xl uppercase tracking-wide-2 text-bone group-hover:text-crimson transition-colors">
                {c.value}
              </p>
              <p className="mt-3 text-sm text-bone-soft leading-relaxed">{c.note}</p>
            </a>
          ))}
        </div>

        {/* WhatsApp CTA */}
        <section className="mt-16 md:mt-20 border border-line bg-paper-2 p-8 md:p-14 text-center">
          <MessageCircle size={32} className="text-crimson mx-auto mb-5" strokeWidth={1.5} />
          <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-[0.95]">
            Order On WhatsApp
          </h2>
          <p className="mt-5 text-bone-dim max-w-md mx-auto leading-relaxed">
            Pick any product, hit Buy Now, and your order opens straight in WhatsApp. We confirm availability and walk you through payment and delivery — all in one chat.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button
              href={buildWhatsAppGeneralUrl('Hi DSLANG! I have a question about a product.')}
              external
              variant="primary"
            >
              <MessageCircle size={16} strokeWidth={2} /> Start A Chat
            </Button>
            <Button href="#/shop" variant="outline">
              Browse Products
            </Button>
          </div>
        </section>

        {/* Location note */}
        <div className="mt-12 flex items-center gap-3 text-bone-soft text-sm">
          <MapPin size={16} strokeWidth={1.6} className="text-crimson" />
          <span>Based in Tamil Nadu, India. Shipping pan-India.</span>
        </div>
      </div>
    </div>
  );
}
