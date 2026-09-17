import { MessageCircle, Mail, MapPin } from 'lucide-react';
import { INSTAGRAM_URL, EMAIL } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { Instagram } from '@/components/icons/Instagram';

export function ContactPage() {
  const { settings } = useSiteSettings();
  const whatsapp = settings.whatsapp_number;
  // The stored number already includes the 91 country code — display it
  // without duplicating the prefix.
  const digits = whatsapp.replace(/\D/g, '');
  const whatsappDisplay = digits.length >= 11 && digits.startsWith('91') ? digits.slice(2) : digits;
  const CHANNELS = [
    {
      icon: MessageCircle,
      label: 'WhatsApp',
      value: `+91 ${whatsappDisplay}`,
      note: 'Fastest reply. Order confirmation & delivery updates.',
      href: `https://wa.me/${digits}`,
    },
    {
      icon: Instagram,
      label: 'Instagram',
      value: '@dslang.in',
      note: 'New drops, restocks, and behind-the-scenes.',
      href: INSTAGRAM_URL,
    },
    {
      icon: Mail,
      label: 'Email',
      value: EMAIL,
      note: 'New drops, returns & order support.',
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
            A question about an order, a product or a drop — reach out and the DSLANG team replies fast. No bots, no call centres.
          </p>

        {/* Channels */}
        <div className="mt-8 md:mt-10 grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-5">
          {CHANNELS.map((c, i) => (
            <a
              key={c.label}
              href={c.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group min-w-0 border border-line bg-paper-2 p-5 md:p-6 hover:border-bone-dim transition-colors duration-150 animate-fade-up"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <c.icon size={24} className="text-bone mb-3" strokeWidth={1.5} />
              <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey mb-2">{c.label}</h3>
              <p className="font-label font-bold text-lg uppercase tracking-[0.04em] text-bone group-hover:text-bone transition-colors overflow-wrap-anywhere">
                {c.value}
              </p>
              <p className="mt-3 text-sm text-bone-soft leading-relaxed">{c.note}</p>
            </a>
          ))}
        </div>

        {/* Location note */}
        <div className="mt-8 flex items-center gap-3 text-bone-soft text-sm">
          <MapPin size={16} strokeWidth={1.6} className="text-bone-soft" />
          <span>Manufactured in Tiruppur, Tamil Nadu. Pan-India dispatch.</span>
        </div>
      </div>
    </div>
  );
}