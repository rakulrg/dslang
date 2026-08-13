import type { ReactNode } from 'react';

export function Button({
  children,
  href,
  onClick,
  variant = 'primary',
  className = '',
  disabled,
  external,
  type,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: 'primary' | 'outline' | 'ghost' | 'outline-light';
  className?: string;
  disabled?: boolean;
  external?: boolean;
  type?: 'button' | 'submit';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold transition-all duration-300 px-6 py-4 disabled:opacity-40 disabled:cursor-not-allowed select-none';
  const variants = {
    primary: 'bg-crimson text-white hover:bg-crimson-dark disabled:hover:bg-crimson',
    outline: 'border border-bone-dim text-bone hover:bg-bone hover:text-paper disabled:hover:bg-transparent disabled:hover:text-bone',
    ghost: 'border border-line text-bone-dim hover:border-crimson hover:text-crimson',
    'outline-light': 'border border-white/60 text-white hover:bg-white hover:text-bone',
  };

  if (href) {
    return (
      <a
        href={href}
        className={`${base} ${variants[variant]} ${className}`}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  align = 'left',
}: {
  eyebrow?: string;
  title: string;
  align?: 'left' | 'center';
}) {
  return (
    <div className={align === 'center' ? 'text-center' : ''}>
      {eyebrow && (
        <p className="text-[11px] uppercase tracking-ultra text-crimson mb-3">{eyebrow}</p>
      )}
      <h2 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-[0.95]">
        {title}
      </h2>
    </div>
  );
}
