// Transactional order emails for DSLANG — sent via Resend (the same provider
// the hosted Supabase Auth uses for its verification/SMTP mail), from the
// brand sender noreply@dslang.in.
//
// Single-fire contract: every AUTOMATIC trigger calls sendOrderEmail WITHOUT
// `force`, so it refuses to send a second time for the same kind (guarded on
// retail_orders.last_email_kind, written on each successful send):
//   * 'confirmed' — online: fired by the winning paid-flip in cashfree-webhook
//     or cashfree-status (whichever commits first; the other matches zero rows);
//     COD: fired by cod-order-mail, which requires a confirmed `cod_pending`
//     order plus the customer's order ref AND 10-digit phone.
//   * 'shipped'    — NOT automatic. Shipment success does not mail the customer
//     on its own; an operator triggers it from Admin ("Email Customer" /
//     "Resend Email"), which calls WITH `force` so support can re-notify at any
//     time. A shipped email is also refused outright without an AWB, so it can
//     never announce a parcel the customer cannot look up.
//
// Fail-open safety: never crashes a caller if emailing is unavailable. With no
// RESEND_API_KEY configured this returns {skipped:true} and the order flow
// proceeds untouched (deployed stacks that lack the key keep working).

export type OrderEmailKind = 'confirmed' | 'shipped';

export interface SendOrderEmailResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  email?: string;
  kind?: OrderEmailKind;
}

const DEFAULT_FROM = 'DSLANG <noreply@dslang.in>';
const FALLBACK_ORIGIN = 'https://dslang.in';

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inr(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '₹0';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `₹${n}`;
  }
}

function trackOrderUrl(ref: string): string {
  const origin = Deno.env.get('APP_ORIGIN') || FALLBACK_ORIGIN;
  return `${origin}/#/track-order/${encodeURIComponent(ref)}`;
}

function customerAddress(customer: Record<string, unknown>): string[] {
  return [
    customer.address,
    [customer.city, customer.state].filter(Boolean).join(', '),
    customer.pincode,
    customer.country && String(customer.country) !== 'India' ? String(customer.country) : null,
  ].filter(Boolean).map(String);
}

function shell(body: string): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DSLANG</title>
</head>
<body style="margin:0;padding:0;background:#f3f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ea;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td align="center" style="padding:0 0 16px;">
              <span style="font-size:20px;font-weight:800;letter-spacing:4px;color:#1a1a1a;">DSLANG</span>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #e5e0d4;border-radius:12px;padding:24px;font-size:14px;line-height:1.55;color:#1a1a1a;">
              ${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 0 0;font-size:11px;line-height:1.6;color:#6b6b6b;">
              <p style="margin:0;">DSLANG · Made in India</p>
              <p style="margin:4px 0 0;">Questions? hello.dslang@gmail.com · <a href="https://wa.me/919944676178" style="color:#6b6b6b;">WhatsApp support</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function cta(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td style="background:#0f766e;border-radius:8px;">
      <a href="${esc(url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;letter-spacing:0.5px;">${esc(label)}</a>
    </td>
  </tr></table>`;
}

function itemsList(items: Array<Record<string, unknown>>): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const rows = (items as Array<Record<string, unknown>>)
    .map((it) => {
      const name = [it.name, it.color && String(it.color) !== 'Default' ? it.color : null, it.size_label]
        .filter(Boolean)
        .map(String)
        .join(' · ');
      return `<tr>
        <td style="padding:7px 0;border-bottom:1px solid #f0ece2;color:#1a1a1a;">${esc(name)}</td>
        <td align="right" style="padding:7px 0;border-bottom:1px solid #f0ece2;color:#6b6b6b;white-space:nowrap;">× ${esc(it.quantity ?? it.qty ?? 1)}</td>
        <td align="right" style="padding:7px 0;border-bottom:1px solid #f0ece2;color:#1a1a1a;white-space:nowrap;">${inr(it.line_total ?? it.amount ?? it.unit_price)}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0;">
    <tr><td colspan="3" style="padding:7px 0 4px;border-bottom:2px solid #1a1a1a;color:#6b6b6b;font-size:11px;letter-spacing:1px;font-weight:600;">ITEMS</td></tr>
    ${rows}
  </table>`;
}

function totalsBlock(order: Record<string, unknown>): string {
  const isCod = Boolean(order.is_cod);
  const rows: string[] = [];
  rows.push(
    `<tr><td align="right" style="padding:4px 0;">Subtotal</td><td align="right" style="padding:4px 0;width:90px;">${inr(order.subtotal)}</td></tr>`
  );
  if (Number(order.discount) > 0) {
    rows.push(
      `<tr><td align="right" style="padding:4px 0;">Discount</td><td align="right" style="padding:4px 0;color:#15803d;">−${inr(order.discount)}</td></tr>`
    );
  }
  rows.push(`<tr><td align="right" style="padding:4px 0;">Shipping</td><td align="right" style="padding:4px 0;">${inr(order.shipping)}</td></tr>`);
  rows.push(
    `<tr><td align="right" style="padding:7px 0 0;font-weight:700;">Order Total</td><td align="right" style="padding:7px 0 0;font-weight:700;">${inr(order.total_amount)}</td></tr>`
  );
  if (isCod) {
    // COD IS FULL-PAYMENT-ON-DELIVERY. One rule, no variants: Rs 0 collected
    // upfront and the whole amount owed to the delivery agent.
    //
    // The retired advance/partial model (a Rs 100 advance collected online, the
    // balance due later) used to be rendered here as a two-row "Amount
    // collected" + "Pay at delivery" split. That branch is GONE and is not
    // coming back: there is no customer-facing way to prepay any part of a COD
    // order, no checkout path that can produce one, and no admin control that
    // can set one. New COD orders always carry amount_paid_upfront = 0, so the
    // removed branch was unreachable from new checkout and only ever described a
    // retired model.
    //
    // `amount_due_on_delivery` is the AUTHORITATIVE stored remainder and is used
    // verbatim — never recomputed here. For a current COD order it equals
    // total_amount, which is exactly "subtotal + shipping - promo". Reading the
    // stored column (rather than assuming total_amount) is what keeps this
    // truthful for the handful of pre-existing rows, without reintroducing the
    // advance wording for anyone.
    rows.push(
      `<tr><td align="right" style="padding:6px 0 0;font-weight:700;color:#0f766e;">Pay on delivery</td><td align="right" style="padding:6px 0 0;font-weight:700;color:#0f766e;width:90px;">${inr(order.amount_due_on_delivery ?? order.total_amount)}</td></tr>`
    );
  } else {
    // ONLINE.
    if (Number(order.payment_discount) > 0) {
      rows.push(
        `<tr><td align="right" style="padding:3px 0;color:#0f766e;">Online payment discount</td><td align="right" style="padding:3px 0;color:#0f766e;">−${inr(order.payment_discount)}</td></tr>`
      );
    }
    // CLOSING FIGURE: what the customer ACTUALLY paid.
    //
    // The rows above stop at "Order Total", which is the pre-online-discount
    // order total. For a 649 + 49 = 698 order with the Rs 50 online discount the
    // customer is charged 648, but the email used to end on a bolded "698" with
    // a bare "-50" beneath it — leaving the real figure to be inferred, and
    // making the wrong number the most prominent one on the page.
    //
    // `amount_paid_upfront` is the AUTHORITATIVE amount the gateway actually
    // collected (it is the same field cashfree-webhook/cashfree-status match the
    // settled amount against before flipping the order to paid). It is read
    // straight off the order row and NEVER recomputed here, so a promo discount
    // and the Rs 50 are each already netted out exactly once — the template
    // cannot double-apply a discount, and it cannot drift from the charge.
    //
    // Rendered only when a positive figure is actually recorded. A row with no
    // settled amount must not claim the customer paid anything, so it is
    // omitted rather than printed as a misleading zero.
    const paid = Number(order.amount_paid_upfront);
    if (Number.isFinite(paid) && paid > 0) {
      rows.push(
        `<tr><td align="right" style="padding:8px 0 0;font-weight:700;border-top:1px solid #e5e0d4;">Amount Paid</td><td align="right" style="padding:8px 0 0;font-weight:700;width:90px;border-top:1px solid #e5e0d4;">${inr(paid)}</td></tr>`
      );
    }
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 0;">
    ${rows.join('')}
  </table>`;
}

function addressBlock(customer: Record<string, unknown>): string {
  const lines = customerAddress(customer);
  if (lines.length === 0) return '';
  return `<p style="margin:16px 0 4px;color:#6b6b6b;font-size:11px;letter-spacing:1px;font-weight:600;">DELIVERY ADDRESS</p>
  <p style="margin:0;color:#1a1a1a;">${esc(customer.name)}<br />${lines.map(esc).join('<br />')}<br />${esc(customer.phone)}</p>`;
}

function renderConfirmed(order: Record<string, unknown>): string {
  const c = (order.customer as Record<string, unknown> | null) ?? {};
  // COD is one sentence, always the same: nothing was collected now and the
  // full stored remainder is owed on arrival. The retired partial-payment split
  // — where an order that had already been partly charged got different
  // wording from one that had not — is removed with the rest of that model.
  const paidLine = order.is_cod
    ? `Your order is confirmed as Cash on Delivery. Please keep ${inr(order.amount_due_on_delivery ?? order.total_amount)} ready for the delivery agent.`
    : Number(order.payment_discount) > 0
      ? `Your online payment of ${inr(order.amount_paid_upfront ?? order.total_amount)} has been received.`
      : 'Your payment has been received.';
  return `<p style="margin:0 0 12px;">Hi ${esc(c.name) || 'there'},</p>
  <p style="margin:0 0 12px;">Thanks for your DSLANG order <strong>${esc(order.ref)}</strong>. Here's what you ordered:</p>
  ${itemsList(order.items as Array<Record<string, unknown>>)}
  ${totalsBlock(order)}
  <p style="margin:14px 0 0;">${paidLine}</p>
  ${addressBlock(c)}
  ${cta(trackOrderUrl(String(order.ref ?? '')), 'Track your order')}
  <p style="margin:0;color:#6b6b6b;">We review every order by hand and confirm stock before dispatch — most orders leave within 24–48 hours.</p>`;
}

function renderShipped(order: Record<string, unknown>): string {
  const c = (order.customer as Record<string, unknown>) ?? {};
  // Never name a courier we do not know. The old fallback hard-coded 'Delhivery',
  // which would have told a customer their DTDC parcel was being tracked by
  // Delhivery. An unnamed courier simply reads "Courier" or is omitted.
  const courier = String(order.courier_name ?? '').trim();
  const awb = String(order.awb_number ?? order.tracking_id ?? '').trim();
  const link = String(order.tracking_url ?? '').trim();
  // Only a real http(s) link is rendered as a link.
  const safeLink = /^https?:\/\//i.test(link) ? link : '';
  const courierRow = courier
    ? `<tr>
      <td style="padding:10px 12px;color:#6b6b6b;font-size:11px;letter-spacing:1px;font-weight:600;white-space:nowrap;">COURIER</td>
      <td style="padding:10px 12px;color:#1a1a1a;">${esc(courier)}</td>
    </tr>`
    : '';
  return `<p style="margin:0 0 12px;">Hi ${esc(c.name) || 'there'},</p>
  <p style="margin:0 0 12px;">Good news — your DSLANG order <strong>${esc(order.ref)}</strong> has been shipped!</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;background:#f7f5ee;border:1px solid #f0ece2;border-radius:8px;">
    ${courierRow}
    <tr>
      <td style="padding:10px 12px;color:#6b6b6b;font-size:11px;letter-spacing:1px;font-weight:600;white-space:nowrap;">AWB / TRACKING NO.</td>
      <td style="padding:10px 12px;color:#1a1a1a;font-weight:600;">${esc(awb || '—')}</td>
    </tr>
  </table>
  ${cta(trackOrderUrl(String(order.ref ?? '')), 'Track on dslang.in')}
  ${safeLink ? `<p style="margin:0;color:#6b6b6b;font-size:12px;">Prefer the courier's page? <a href="${esc(safeLink)}" style="color:#0f766e;">Track on ${esc(courier || 'the courier')} directly</a>.</p>` : ''}
  <p style="margin:14px 0 0;color:#6b6b6b;">${inr(order.total_amount)} total${order.is_cod ? ` — ${inr(order.amount_due_on_delivery ?? order.total_amount)} due on delivery` : ''}. Reach us anytime on WhatsApp at 919944676178.</p>`;
}

export function orderEmailSubject(order: Record<string, unknown>, kind: OrderEmailKind): string {
  const ref = String(order.ref ?? '');
  return kind === 'shipped'
    ? `Your DSLANG order ${ref} has been shipped`
    : `Your DSLANG order ${ref} is confirmed`;
}

function sendViaResend(opts: { to: string; subject: string; html: string }): Promise<{ ok: boolean; error?: string }> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return Promise.resolve({ ok: false, error: 'RESEND_API_KEY not configured.' });
  const from = Deno.env.get('EMAIL_FROM') || DEFAULT_FROM;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html }),
  }).then(async (res) => {
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = String(j?.message ?? j?.error ?? '');
      } catch {
        /* keep generic */
      }
      return { ok: false, error: `Resend ${res.status}: ${detail || res.statusText}` };
    }
    return { ok: true };
  }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : 'Unknown Resend error.' }));
}

/**
 * Sends a transactional order email and (on success) stamps the per-order
 * audit trail (last_email_kind + last_email_sent_at) so Admin can show when a
 * customer was last notified. Never throws — callers tolerate failures.
 */
export async function sendOrderEmail(
  supabase: { from: (table: string) => any },
  order: Record<string, unknown>,
  kind: OrderEmailKind,
  opts?: { force?: boolean }
): Promise<SendOrderEmailResult> {
  const email = String((order.customer as Record<string, unknown> | null)?.email ?? '').trim();
  if (!email) {
    return { ok: false, skipped: true, error: 'No customer email on order.', kind };
  }
  if (!opts?.force && String(order.last_email_kind ?? '') === kind) {
    return { ok: true, skipped: true, kind };
  }

  // A "shipped" email is a promise that a parcel is moving. Without an AWB there
  // is nothing to hand the customer, so the mail is refused outright — this holds
  // even under `force` (a human clicking the button in Admin), because a shipment
  // notice without a tracking number is exactly the false signal we must not send.
  if (kind === 'shipped' && !String(order.awb_number ?? order.tracking_id ?? '').trim()) {
    return {
      ok: false,
      skipped: true,
      kind,
      error: 'No AWB/tracking number on this order yet — add shipping details before sending a shipment email.',
    };
  }

  const html = shell(kind === 'shipped' ? renderShipped(order) : renderConfirmed(order));
  const subject = orderEmailSubject(order, kind);
  const sent = await sendViaResend({ to: email, subject, html });

  if (sent.ok) {
    try {
      await supabase
        .from('retail_orders')
        .update({ last_email_kind: kind, last_email_sent_at: new Date().toISOString() })
        .eq('id', String(order.id));
    } catch {
      /* stamp is best-effort — never fail the caller because a column is missing */
    }
  }
  return { ok: sent.ok, email, kind, error: sent.ok ? undefined : sent.error };
}
