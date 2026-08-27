import { useState, type FormEvent } from 'react';
import { MessageCircle, CheckCircle2 } from 'lucide-react';
import { buildWhatsAppGeneralUrl } from '@/lib/catalog';
import { getSiteSettings } from '@/lib/settings';

const inputCls =
  'w-full rounded border border-line bg-white px-3 py-3 text-sm text-bone placeholder:text-grey focus:outline-none focus:border-crimson transition-colors';

export function WholesaleEnquiryForm() {
  const [form, setForm] = useState({
    name: '',
    businessName: '',
    phone: '',
    email: '',
    city: '',
    state: '',
    gstin: '',
    products: '',
    quantity: '',
  });
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.businessName.trim() || !form.phone.trim() || !form.city.trim() || !form.state.trim()) {
      setError('Please fill in your name, business name, WhatsApp number, city and state.');
      return;
    }

    setBusy(true);

    // Enquiry goes to WhatsApp as a pre-filled wholesale enquiry message.
    const details = [
      `Business: ${form.businessName.trim()}`,
      `Contact: ${form.name.trim()}`,
      `WhatsApp: ${form.phone.trim()}`,
      form.email.trim() ? `Email: ${form.email.trim()}` : null,
      `City: ${form.city.trim()}, ${form.state.trim()}`,
      form.gstin.trim() ? `GSTIN: ${form.gstin.trim()}` : null,
      `Interested In: ${form.products.trim() || 'Full wholesale collection'}`,
      form.quantity.trim() ? `Approximate Quantity: ${form.quantity.trim()} PCS` : null,
    ].filter(Boolean).join('\n');

    const message = [
      "Hi DSLANG! I'd like to send a wholesale enquiry.",
      '',
      details,
      '',
      'Please share availability and wholesale pricing.',
    ].join('\n');

    const url = buildWhatsAppGeneralUrl(message);

    window.open(url, '_blank', 'noopener,noreferrer');
    setBusy(false);
    setSent(true);
  };

  if (sent) {
    return (
      <div className="border border-line bg-paper-2 p-6 md:p-8 text-center">
        <CheckCircle2 size={32} className="text-crimson mx-auto mb-4" strokeWidth={1.6} />
        <p className="font-display text-2xl md:text-3xl uppercase tracking-wide-2 text-bone">
          Enquiry Sent
        </p>
        <p className="mt-3 text-sm text-bone-soft max-w-sm mx-auto leading-relaxed">
          Thank you. The DSLANG wholesale team will contact you on WhatsApp.
        </p>
        <p className="mt-4 text-xs text-grey">
          Didn't open WhatsApp? Send us a message directly at +91 {getSiteSettings().whatsapp_number}.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border border-line bg-paper-2 p-5 md:p-8 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Name *</label>
          <input value={form.name} onChange={set('name')} placeholder="Your name" className={inputCls} />
        </div>
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Shop / Business Name *</label>
          <input value={form.businessName} onChange={set('businessName')} placeholder="Store or business name" className={inputCls} />
        </div>
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">WhatsApp Number *</label>
          <input value={form.phone} onChange={set('phone')} placeholder="+91 XXXXX XXXXX" inputMode="tel" className={inputCls} />
        </div>
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Email</label>
          <input type="email" value={form.email} onChange={set('email')} placeholder="business@example.com" className={inputCls} />
        </div>
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">City *</label>
          <input value={form.city} onChange={set('city')} placeholder="City" className={inputCls} />
        </div>
        <div>
          <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">State *</label>
          <input value={form.state} onChange={set('state')} placeholder="State" className={inputCls} />
        </div>
      </div>
      <div>
        <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">GSTIN (optional)</label>
        <input value={form.gstin} onChange={set('gstin')} placeholder="GSTIN (if registered)" className={inputCls} />
      </div>
      <div>
        <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Interested Products</label>
        <textarea
          value={form.products}
          onChange={set('products')}
          placeholder="Which designs are you interested in? (e.g. Create Over Consume, Fallen Halo)"
          rows={2}
          className={inputCls}
        />
      </div>
      <div>
        <label className="mb-1.5 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Approximate Order Quantity (PCS)</label>
        <input value={form.quantity} onChange={set('quantity')} placeholder="e.g. 50, 100, 200" inputMode="numeric" className={inputCls} />
      </div>

      {error && (
        <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-crimson-dark transition-colors disabled:opacity-60"
      >
        <MessageCircle size={16} strokeWidth={2} />
        {busy ? 'Sending…' : 'Send Wholesale Enquiry'}
      </button>
      <p className="text-center text-[11px] text-grey">
        Submitting opens a pre-filled WhatsApp message to DSLANG ({getSiteSettings().whatsapp_number.replace(/^91/, '+91 ')}). No spam — wholesale only.
      </p>
    </form>
  );
}