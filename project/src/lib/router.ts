import { useEffect, useState, useCallback } from 'react';

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
