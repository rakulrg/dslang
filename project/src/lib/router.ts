import { useEffect, useState, useCallback } from 'react';

// Never let the browser restore the previous scroll position automatically on
// refresh, back, or forward. All scrolling is controlled by the app (scroll to
// top on navigation, scroll to field/error on validation).
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

export interface Route {
  path: string;
  segments: string[];
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const clean = raw.split('?')[0];
  const path = clean.startsWith('/') ? clean : `/${clean}`;
  const segments = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  return { path, segments };
}

export function useRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    // Hard refresh: always start at the top, never at a restored position.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });

    const onChange = () => {
      setRoute(parseHash());
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    const target = to.startsWith('/') ? to : `/${to}`;
    if (window.location.hash === `#${target}`) {
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
      return;
    }
    window.location.hash = target;
  }, []);

  return { route, navigate };
}

export function linkHref(to: string): string {
  const target = to.startsWith('/') ? to : `/${to}`;
  return `#${target}`;
}
