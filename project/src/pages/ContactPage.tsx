import { MessageCircle, Mail, MapPin } from 'lucide-react';
import { Button } from '@/components/Button';
import { linkHref } from '@/lib/router';
import {
  INSTAGRAM_URL,
  EMAIL,
  buildWhatsAppGeneralUrl,
} from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { Instagram } from '@/components/icons/Instagram';

export function ContactPage() {
  const { settings } = useSiteSettings();
  const whatsapp = settings.whatsapp_number;
  const CHANNELS = [
    {
      icon: MessageCircle,
      label: 'WhatsApp',
      value: `+91 ${whatsapp}`,
      note: 'Fastest reply. Wholesale enquiries, order confirmation & delivery updates.',
      href: `https://wa.me/${whatsapp}`,
    },
    {
      icon: Instagram,
      label: 'Instagram',
      value: '@dslang.in',
      note: 'New drops, restocks, and the latest wholesale catalogue.',
      href: INSTAGRAM_URL,
    },
    {
      icon: Mail,
      label: 'Email',
      value: EMAIL,
    note: 'Store registrations, bulk enquiries & partnerships.',
    href: `mailto:${EMAIL}`,
  },
];

  return (
    <div className="pb-12 md:pb-20">
      <div className="mx-auto px-6 md:px-12 lg:px-20 xl:px-28">
        {/* Header */}
        <h1 className="mt-6 font-display text-5xl md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
          Let's Talk
        </h1>
        <p className="mt-4 text-bone-dim max-w-xl leading-relaxed">
          A store, a reseller, or a bulk buyer — reach out and the DSLANG wholesale team replies fast. No bots, no call centres.
        </p>

        {/* Channels */}
        <div className="mt-8 md:mt-10 grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-5">
          {CHANNELS.map((c, i) => (
            <a
              key={c.label}
              href={c.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group min-w-0 border border-line bg-paper-2 p-5 md:p-6 hover:border-crimson transition-colors duration-150 animate-fade-up"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <c.icon size={24} className="text-crimson mb-3" strokeWidth={1.5} />
              <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey mb-2">{c.label}</h3>
              <p className="font-label font-bold text-lg uppercase tracking-[0.04em] text-bone group-hover:text-crimson transition-colors overflow-wrap-anywhere">
                {c.value}
              </p>
              <p className="mt-3 text-sm text-bone-soft leading-relaxed">{c.note}</p>
            </a>
          ))}
        </div>

        {/* Wholesale CTA */}
        <section className="mt-10 md:mt-14 border border-line bg-paper-2 p-6 md:p-10 text-center">
          <MessageCircle size={28} className="text-crimson mx-auto mb-3" strokeWidth={1.5} />
          <h2 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-[0.95]">
            Wholesale Enquiry
          </h2>
          <p className="mt-4 text-bone-dim max-w-md mx-auto leading-relaxed">
            Pick any product, build a mix of {settings.default_moq}+ PCS, and request your wholesale order — it opens straight in WhatsApp. We confirm availability, pricing and dispatch in one chat.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button
              href={buildWhatsAppGeneralUrl("Hi DSLANG! I'd like to discuss a wholesale order for my store.")}
              external
              variant="primary"
            >
              <MessageCircle size={16} strokeWidth={2} /> Start A Chat
            </Button>
            <Button href={linkHref('/collection')} variant="outline">
              Browse Collection
            </Button>
          </div>
        </section>

        {/* Location note */}
        <div className="mt-8 flex items-center gap-3 text-bone-soft text-sm">
          <MapPin size={16} strokeWidth={1.6} className="text-crimson" />
          <span>Manufactured in Tiruppur, Tamil Nadu. Pan-India dispatch.</span>
        </div>
      </div>
    </div>
  );
}