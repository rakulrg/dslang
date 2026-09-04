import type { ReactNode } from 'react';

/**
 * Shared primitives + business constants for the DSLANG legal/policy pages.
 * Keeps all five policy pages visually identical and consistent with the
 * DSLANG design system (typed display headings, label-eyebrows, comfortable
 * reading column, generous line height, responsive type).
 *
 * Business facts here come from the values already configured in the project
 * (EMAIL / INSTAGRAM_URL / WHATSAPP_NUMBER in lib/catalog.ts, site_settings
 * whatsapp_number) plus the operating address supplied by the owner. DSLANG is
 * NOT a formally registered company, so wording is deliberately neutral — no
 * CIN / GST / registration number / registered office is invented.
 */

export const POLICY_SITE = 'www.dslang.in';
export const POLICY_BUSINESS = 'DSLANG';
/** Neutral operating-address wording (not a "registered office"). */
export const POLICY_ADDRESS =
  'DSLANG, operating from Main Road, Vaduvur, Needamangalam, Thiruvarur District, Tamil Nadu – 614019, India';

interface PolicyPageShellProps {
  eyebrow: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}

/** Page chrome shared by every policy page. */
export function PolicyPageShell({ eyebrow, title, intro, children }: PolicyPageShellProps) {
  return (
    <div className="pt-4 pb-12 md:pt-8 md:pb-20">
      <div className="mx-auto max-w-[1000px] px-5 md:px-8">
        <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">
          {eyebrow}
        </p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-[0.95]">
          {title}
        </h1>
        {intro && (
          <p className="mt-5 text-bone-dim max-w-2xl leading-relaxed text-sm md:text-base">
            {intro}
          </p>
        )}
        <div className="mt-8 md:mt-10 border-t border-line pt-8 md:pt-10 text-sm md:text-[15px] text-bone-soft leading-relaxed space-y-6">
          {children}
        </div>
      </div>
    </div>
  );
}

export function PolicySection({
  num,
  title,
  children,
}: {
  num?: number | string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2 className="font-label text-base md:text-lg uppercase tracking-wide-2 text-bone font-semibold">
        {num !== undefined ? `${num}. ` : ''}
        {title}
      </h2>
      {children && <div className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}

export function PolicySubheading({ title }: { title: string }) {
  return (
    <h3 className="pt-1 font-label text-[13px] md:text-sm uppercase tracking-wide-2 text-bone font-semibold">
      {title}
    </h3>
  );
}

export function PolicyP({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

/** Numbered list rendered with the site's label/number styling. */
export function PolicyOl({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="font-label text-crimson font-semibold shrink-0">{(i + 1).toString().padStart(2, '0')}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Bulleted list with the site's label-marker style. */
export function PolicyUl({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="block w-1.5 h-1.5 rounded-full bg-crimson shrink-0 mt-2" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function PolicyNote({ children }: { children: ReactNode }) {
  return (
    <p className="border border-line bg-paper-2 px-4 py-3 text-sm text-grey leading-relaxed">
      {children}
    </p>
  );
}