import type { ReactNode } from 'react';

/**
 * Shared design atoms for the Operations & Inventory admin sections.
 * All styling uses the DSLANG Tailwind v4 tokens (paper/line/bone/crimson).
 */

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-line rounded overflow-hidden ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-line">
          {title && <h3 className="font-display text-base sm:text-lg tracking-wide-2 text-bone uppercase">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneCls =
    tone === 'good' ? 'text-green-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-crimson' : 'text-bone';
  return (
    <div className="bg-white border border-line rounded p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">{label}</p>
      <p className={`mt-1.5 font-price text-2xl leading-none ${toneCls}`}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-grey">{sub}</p>}
    </div>
  );
}

export function Chip({ label, cls = 'bg-paper-3 text-bone-dim', className = '' }: { label: ReactNode; cls?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-0.5 rounded whitespace-nowrap ${cls} ${className}`}>
      {label}
    </span>
  );
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return <div className="bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">{message}</div>;
}

export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="text-center py-16 px-6">
      <p className="font-label text-2xl uppercase tracking-wide-2 text-grey">{title}</p>
      {sub && <p className="mt-2 text-sm text-grey">{sub}</p>}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  variant = 'primary',
  disabled,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const base =
    'inline-flex items-center gap-1.5 text-[10px] sm:text-[11px] uppercase tracking-wide-2 font-semibold px-3 sm:px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const cls =
    variant === 'primary'
      ? 'bg-bone text-white hover:bg-ink'
      : variant === 'danger'
        ? 'bg-crimson text-white hover:bg-crimson/80'
        : 'border border-line text-bone-dim hover:text-bone hover:bg-paper-2';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${cls} ${className}`}>
      {children}
    </button>
  );
}

export function RangePills<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 bg-paper-3 border border-line rounded-full p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-[10px] uppercase tracking-wide-2 font-semibold rounded-full transition-colors ${
            value === o.value ? 'bg-bone text-white' : 'text-bone-dim hover:text-bone'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function MiniBar({
  labels,
  values,
  formatter = (n: number) => String(n),
  height = 140,
}: {
  labels: string[];
  values: number[];
  formatter?: (n: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...values.map((v) => Number(v) || 0));
  return (
    <div>
      <div className="flex items-end gap-1" style={{ height }}>
        {values.map((v, i) => {
          const h = Math.max(2, (Number(v) / max) * (height - 16));
          return (
            <div key={i} className="flex-1 min-w-0 relative group" title={`${labels[i] ?? ''}: ${formatter(Number(v) || 0)}`}>
              <div
                className="w-full bg-bone/80 group-hover:bg-bone rounded-t-sm transition-colors"
                style={{ height: h }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-end gap-1">
        {labels.map((l, i) => (
          <span key={i} className="flex-1 min-w-0 text-center text-[9px] text-grey leading-tight truncate">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Donut({ segments }: { segments: Array<{ label: string; value: number; color: string }> }) {
  const total = segments.reduce((acc, s) => acc + Math.max(0, Number(s.value) || 0), 0) || 1;
  let acc = 0;
  const stops = segments
    .filter((s) => Number(s.value) > 0)
    .map((s) => {
      const start = (acc / total) * 360;
      acc += Math.max(0, Number(s.value) || 0);
      const end = (acc / total) * 360;
      return `${s.color} ${start}deg ${end}deg`;
    })
    .join(', ');
  return (
    <div className="flex items-center gap-4">
      <div
        className="w-28 h-28 rounded-full shrink-0"
        style={{ background: stops ? `conic-gradient(${stops})` : 'var(--color-paper-3)' }}
      />
      <div className="space-y-1.5 min-w-0">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-bone-dim truncate">{s.label}</span>
            <span className="ml-auto text-bone font-semibold tabular-nums">{Math.round((Number(s.value) || 0))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide-2 text-grey whitespace-nowrap ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 text-sm text-bone align-middle ${className}`}>{children}</td>;
}

/** Empty-value friendly number formatting (real DB numbers only). */
export function fmtNum(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN');
}