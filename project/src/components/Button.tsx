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
    'btn-soft inline-flex items-center justify-center gap-2 uppercase font-semibold select-none active:scale-[0.98]';
  const variants = {
    primary: 'btn-dark text-[11px] md:text-xs tracking-wide-2 px-6 py-4',
    outline:
      'border border-bone-dim text-bone hover:bg-bone hover:text-paper disabled:hover:bg-transparent disabled:hover:text-bone text-[11px] md:text-xs tracking-wide-2 px-6 py-4',
    ghost: 'border border-line text-bone-dim hover:border-bone hover:text-bone text-[11px] md:text-xs tracking-wide-2 px-6 py-4',
    'outline-light':
      'border border-white/60 text-white hover:bg-white hover:text-bone text-[11px] md:text-xs tracking-wide-2 px-6 py-4',
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
