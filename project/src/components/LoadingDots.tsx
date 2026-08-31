import type { CSSProperties } from 'react';

/**
 * Minimal universal DSLANG loading indicator: four small brand-red dots that
 * blink/pulse in sequence. Pure CSS keyframes, animated via opacity only
 * (respects prefers-reduced-motion).
 *
 * Use as a full-page loader (centres in an area that is at least full-height)
 * or as a small inline loader within a component.
 */
export function LoadingDots({ className = '' }: { className?: string }) {
  const dot: CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: '50%',
    backgroundColor: 'var(--color-crimson)',
    display: 'inline-block',
  };

  return (
    <div
      className={`flex items-center justify-center gap-2 ${className}`}
      role="status"
      aria-label="Loading"
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="dslang-loading-dot"
          style={{
            ...dot,
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}
