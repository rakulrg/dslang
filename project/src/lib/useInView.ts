import { useEffect, useRef, useState } from 'react';

const DEFAULT_OPTIONS: IntersectionObserverInit = {
  threshold: 0.15,
  rootMargin: '0px 0px -40px 0px',
};

export function useInView<T extends Element>(
  options: IntersectionObserverInit = DEFAULT_OPTIONS,
  enabled = true
) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(!enabled);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            io.disconnect();
            return;
          }
        }
      },
      options
    );
    io.observe(el);
    return () => io.disconnect();
  }, [options, inView, enabled]);

  return { ref, inView };
}