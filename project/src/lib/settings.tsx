import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { get } from './rest';

export interface SiteSettings {
  announcement_text: string;
  announcement_active: boolean;
  whatsapp_number: string;
  // Flat shipping charged on retail (D2C) orders.
  shipping_flat_rate: number;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  // NO hardcoded announcement copy — the announcement bar must only ever show
  // whatever the admin typed in Settings. Defaults are empty/inactive so a
  // loading state or a missing row renders nothing instead of stale text.
  announcement_text: '',
  announcement_active: false,
  whatsapp_number: '919944676178',
  shipping_flat_rate: 0,
};

// Module-level cache so synchronous builders (WhatsApp URLs) can read
// admin-controlled values without awaiting an async fetch.
let cachedSettings: SiteSettings | null = null;

// Local mirror of the last-known settings so the announcement bar (and other
// sync consumers) can render IMMEDIATELY on page load — before the Supabase
// fetch resolves — without ever falling back to hardcoded copy. Values are
// always overwritten by the fresh DB row the moment the fetch lands.
const SETTINGS_CACHE_KEY = 'dslang_site_settings_v1';

function readNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadCachedSettings(): SiteSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== 'object') return null;
    return {
      announcement_text: typeof p.announcement_text === 'string' ? p.announcement_text : '',
      announcement_active: typeof p.announcement_active === 'boolean' ? p.announcement_active : false,
      whatsapp_number: typeof p.whatsapp_number === 'string' ? p.whatsapp_number : '',
      shipping_flat_rate: readNumber(p.shipping_flat_rate, 0),
    };
  } catch {
    return null;
  }
}

function persistSettingsCache(settings: SiteSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full/blocked — the cache is an optimization, never a requirement.
  }
}

export function getSiteSettings(): SiteSettings {
  return cachedSettings ?? DEFAULT_SETTINGS;
}

// Merchandise subtotal at or above which retail shipping becomes FREE (₹0).
// Kept in one place so Cart, Checkout, and the server-side order totals match.
export const FREE_SHIPPING_THRESHOLD = 999;

/** Retail shipping cost for a given merchandise subtotal (before discount).
 * >= FREE_SHIPPING_THRESHOLD => ₹0; otherwise the configured flat rate. */
export function computeShipping(subtotal: number): number {
  const base = getSiteSettings().shipping_flat_rate || 0;
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : base;
}

export async function fetchSiteSettings(): Promise<SiteSettings> {
  const rows = await get<Record<string, unknown>>('site_settings', { id: 'eq.1', limit: '1' }, { select: '*' });
  const row = (rows[0] ?? null) as {
    announcement_text?: string | null;
    announcement_active?: boolean | null;
    whatsapp_number?: string | null;
    shipping_flat_rate?: number | null;
  } | null;

  if (!row) return DEFAULT_SETTINGS;

  const settings: SiteSettings = {
    announcement_text: row.announcement_text ?? DEFAULT_SETTINGS.announcement_text,
    announcement_active: row.announcement_active ?? DEFAULT_SETTINGS.announcement_active,
    whatsapp_number: (row.whatsapp_number ?? '').trim() || DEFAULT_SETTINGS.whatsapp_number,
    shipping_flat_rate: Number(row.shipping_flat_rate ?? 0) || 0,
  };

  cachedSettings = settings;
  persistSettingsCache(settings);
  return settings;
}

/** Persists an admin edit of the single site_settings row (id = 1). The row is
 * admin-writable via RLS (site_settings_write_admin); updates never touch
 * product pricing (that lives on products). */
export async function saveSiteSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const payload: Record<string, unknown> = {};
  const keys: (keyof SiteSettings)[] = [
    'announcement_text',
    'announcement_active',
    'whatsapp_number',
    'shipping_flat_rate',
  ];
  for (const key of keys) {
    if (patch[key] !== undefined) payload[key] = patch[key] as unknown;
  }

  // Admin-only write path: load the supabase-js client on demand so the heavy
  // client never ships in the storefront's initial bundle.
  const { supabase } = await import('./supabase');
  const { error } = await supabase.from('site_settings').update(payload).eq('id', 1);
  if (error) throw error;

  const settings = await fetchSiteSettings();
  cachedSettings = settings;
  return settings;
}

interface SiteSettingsContextValue {
  settings: SiteSettings;
  loaded: boolean;
  reload: () => Promise<void>;
  save: (patch: Partial<SiteSettings>) => Promise<SiteSettings>;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  reload: async () => {},
  save: async (patch) => patch as SiteSettings,
});

export function SiteSettingsProvider({ children }: { children: ReactNode }) {
  // Synchronous hydration: on repeat visits the last-known settings (from the
  // local cache) are available before ANY fetch, so the announcement bar,
  // WhatsApp links etc. render immediately. The DB fetch replaces them the
  // moment it resolves. Never a hardcoded fallback — no cache => empty defaults.
  const [settings, setSettings] = useState<SiteSettings>(() => {
    const cached = loadCachedSettings();
    if (cached) cachedSettings = cached;
    return cachedSettings ?? DEFAULT_SETTINGS;
  });
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await fetchSiteSettings();
      setSettings(next);
    } catch {
      // Keep current/defaults; the storefront must never crash because of this.
    } finally {
      setLoaded(true);
    }
  }, []);

  const save = useCallback(async (patch: Partial<SiteSettings>) => {
    const next = await saveSiteSettings(patch);
    setSettings(next);
    return next;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the module cache in sync so sync consumers read fresh values even if
  // the provider re-renders with a reloaded snapshot.
  useEffect(() => {
    cachedSettings = settings;
  }, [settings]);

  return (
    <SiteSettingsContext.Provider value={{ settings, loaded, reload, save }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}