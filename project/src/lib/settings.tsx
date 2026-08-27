import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { supabase } from './supabase';

export interface SiteSettings {
  announcement_text: string;
  announcement_active: boolean;
  whatsapp_number: string;
  default_moq: number;
  dispatch_note: string;
  delivery_note: string;
  // Wholesale order minimums (admin-controlled)
  min_order_quantity: number;
  per_color_minimum: number;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  announcement_text: 'SAME DAY DISPATCH • FOR RESELLERS & WHOLESALE ONLY • PAN INDIA DELIVERY',
  announcement_active: true,
  whatsapp_number: '919944676178',
  default_moq: 50,
  dispatch_note: 'Same Day Dispatch',
  delivery_note: 'Pan India',
  min_order_quantity: 48,
  per_color_minimum: 6,
};

// Module-level cache so synchronous builders (WhatsApp URLs, MOQ gates) can
// read admin-controlled values without awaiting an async fetch.
let cachedSettings: SiteSettings | null = null;

export function getSiteSettings(): SiteSettings {
  return cachedSettings ?? DEFAULT_SETTINGS;
}

export function setCachedSettings(s: SiteSettings) {
  cachedSettings = s;
}

export async function fetchSiteSettings(): Promise<SiteSettings> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as
    | {
        announcement_text?: string | null;
        announcement_active?: boolean | null;
        whatsapp_number?: string | null;
        default_moq?: number | null;
        dispatch_note?: string | null;
        delivery_note?: string | null;
        min_order_quantity?: number | null;
        per_color_minimum?: number | null;
      }
    | null;

  if (!row) return DEFAULT_SETTINGS;

  const settings: SiteSettings = {
    announcement_text: row.announcement_text ?? DEFAULT_SETTINGS.announcement_text,
    announcement_active: row.announcement_active ?? DEFAULT_SETTINGS.announcement_active,
    whatsapp_number: (row.whatsapp_number ?? '').trim() || DEFAULT_SETTINGS.whatsapp_number,
    default_moq: Number(row.default_moq ?? 0) || DEFAULT_SETTINGS.default_moq,
    dispatch_note: row.dispatch_note ?? DEFAULT_SETTINGS.dispatch_note,
    delivery_note: row.delivery_note ?? DEFAULT_SETTINGS.delivery_note,
    min_order_quantity: Number(row.min_order_quantity ?? 0) || DEFAULT_SETTINGS.min_order_quantity,
    per_color_minimum: Number(row.per_color_minimum ?? 0) || DEFAULT_SETTINGS.per_color_minimum,
  };

  cachedSettings = settings;
  return settings;
}

interface SiteSettingsContextValue {
  settings: SiteSettings;
  loaded: boolean;
  reload: () => Promise<void>;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  reload: async () => {},
});

export function SiteSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SiteSettings>(cachedSettings ?? DEFAULT_SETTINGS);
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

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the module cache in sync so sync consumers read fresh values even if
  // the provider re-renders with a reloaded snapshot.
  useEffect(() => {
    cachedSettings = settings;
  }, [settings]);

  return (
    <SiteSettingsContext.Provider value={{ settings, loaded, reload }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}