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
    'inline-flex items-center justify-center gap-2 text-[11px] md:text-xs uppercase tracking-wide-2 font-semibold transition-all duration-150 px-6 py-4 disabled:opacity-40 disabled:cursor-not-allowed select-none active:scale-[0.98]';
  const variants = {
    primary: 'bg-crimson text-white hover:bg-crimson-dark hover:glow-crimson focus-visible:glow-crimson disabled:hover:bg-crimson',
    outline: 'border border-bone-dim text-bone hover:bg-bone hover:text-ink hover:glow-white disabled:hover:bg-transparent disabled:hover:text-bone disabled:hover:glow-white',
    ghost: 'border border-line text-bone-dim hover:border-crimson hover:text-crimson',
    'outline-light': 'border border-white/60 text-white hover:bg-white hover:text-ink',
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
