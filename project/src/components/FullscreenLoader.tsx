import { useEffect, useState } from 'react';
import { LoadingDots } from '@/components/LoadingDots';

/** Full-screen overlay for the initial boot loading state. Fades out on resolve. */
export function FullscreenLoader({ visible }: { visible: boolean }) {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (visible) {
      setGone(false);
      return;
    }
    if (!gone) {
      const t = window.setTimeout(() => setGone(true), 300);
      return () => window.clearTimeout(t);
    }
  }, [visible, gone]);

  if (gone) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-paper transition-opacity duration-300 ease-out"
      style={visible ? { opacity: 1 } : { opacity: 0 }}
      aria-hidden="true"
    >
      <LoadingDots />
    </div>
  );
}