import { useEffect, useState, useCallback } from 'react';
import {
  Bell,
  LogOut,
  Mail,
  ShoppingBag,
  TrendingUp,
  Newspaper,
  Check,
  ExternalLink,
  Settings,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { linkHref } from '@/lib/router';
import { fetchProducts, formatPrice, type CatalogProduct } from '@/lib/catalog';
import { LoadingDots } from '@/components/LoadingDots';

interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'drop' | 'restock' | 'news';
  product_slug: string | null;
  is_pinned: boolean;
  goes_live_at: string;
  created_at: string;
}

interface Subscriber {
  id: string;
  email: string;
  wants_drop_alerts: boolean;
  wants_restock_alerts: boolean;
  wants_general_news: boolean;
}

const TYPE_META: Record<string, { label: string; icon: typeof TrendingUp; color: string; bg: string }> = {
  drop: { label: 'New Drop', icon: ShoppingBag, color: 'text-bone', bg: 'bg-bone/10' },
  restock: { label: 'Restock', icon: TrendingUp, color: 'text-amber-600', bg: 'bg-amber-50' },
  news: { label: 'News', icon: Newspaper, color: 'text-blue-600', bg: 'bg-blue-50' },
};

export function SubscriberDashboard() {
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null | undefined>(undefined);
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoadError('');
    try {
      const [{ data: subData }, { data: annData }, { data: readsData }] = await Promise.all([
        supabase.from('subscribers').select('*').eq('id', user.id).maybeSingle(),
        supabase.from('drop_announcements').select('*').order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
        supabase.from('announcement_reads').select('announcement_id').eq('subscriber_id', user.id),
      ]);

      setSubscriber(subData as Subscriber | null);
      setAnnouncements((annData as Announcement[]) ?? []);
      setReadIds(new Set((readsData ?? []).map((r: { announcement_id: string }) => r.announcement_id)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your updates.');
    }

    fetchProducts().then(setProducts).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (user) loadAll();
  }, [user, loadAll]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.hash = '#/';
  };

  const markRead = async (annId: string) => {
    if (readIds.has(annId)) return;
    setReadIds((prev) => new Set(prev).add(annId));
    // Sign-in accounts without a subscribers row (e.g. the auto-bootstrapped
    // admin) have no FK target for announcement_reads — persist only for real
    // subscribers and never let the write bubble up as an unhandled rejection.
    if (!subscriber) return;
    try {
      await supabase.from('announcement_reads').insert({ announcement_id: annId, subscriber_id: user!.id });
    } catch {
      // Read-state persistence is best-effort; the optimistic UI already updated.
    }
  };

  const markAllRead = async () => {
    const unread = (announcements ?? []).filter((a) => !readIds.has(a.id));
    if (unread.length === 0) return;
    setReadIds((prev) => new Set([...prev, ...unread.map((a) => a.id)]));
    if (!subscriber) return;
    // Insert one at a time to avoid UNIQUE (announcement_id, subscriber_id)
    // violations if a row was already created by another tab/session.
    await Promise.all(
      unread.map((a) =>
        supabase
          .from('announcement_reads')
          .insert({ announcement_id: a.id, subscriber_id: user!.id })
          .then(({ error }) => {
            // Ignore duplicate-key errors; surface anything else.
            if (error && !error.message.includes('duplicate key')) throw error;
          })
      )
    );
  };

  const togglePref = async (key: 'wants_drop_alerts' | 'wants_restock_alerts' | 'wants_general_news') => {
    if (!subscriber) return;
    const updated = { ...subscriber, [key]: !subscriber[key] };
    setSubscriber(updated);
    await supabase.from('subscribers').update({ [key]: updated[key] }).eq('id', user!.id);
  };

  if (user === null) {
    return (
      <div className="min-h-screen bg-paper-2 flex items-center justify-center px-5">
        <div className="text-center">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Sign In Required</p>
          <p className="mt-3 text-sm text-grey">
            Log in with the email you used to subscribe to view your drop updates.
          </p>
          <a
            href={linkHref('/')}
            className="mt-6 inline-block btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
          >
            Back To Store
          </a>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-paper-2 flex items-center justify-center px-5">
        <div className="text-center">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Couldn't Load Your Updates</p>
          <p className="mt-3 text-sm text-grey">{loadError}</p>
          <button
            onClick={() => loadAll()}
            className="mt-6 inline-block btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (subscriber === undefined) {
    return (
      <div className="min-h-screen bg-paper-2 flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const unreadCount = (announcements ?? []).filter((a) => !readIds.has(a.id)).length;
  const sorted = [...(announcements ?? [])].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="min-h-screen bg-paper-2">
      {/* Header */}
      <header className="bg-white border-b border-line sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-5 md:px-8 h-16 flex items-center justify-between">
          <a href={linkHref('/')} className="font-brand text-2xl tracking-[0.03em] text-bone leading-none">
            DSLANG
          </a>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setPrefsOpen(!prefsOpen)}
              className="text-bone-dim hover:text-bone transition-colors"
              aria-label="Settings"
            >
              <Settings size={18} strokeWidth={1.8} />
            </button>
            <a
              href={linkHref('/collection')}
              className="text-[11px] uppercase tracking-wide-2 font-medium text-bone-dim hover:text-bone transition-colors hidden sm:block"
            >
              Collection
            </a>
            <button
              onClick={handleLogout}
              className="text-bone-dim hover:text-bone transition-colors"
              aria-label="Sign out"
            >
              <LogOut size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 md:px-8 py-8 md:py-12">
        {/* Welcome */}
        <div className="mb-8">
          <p className="font-label text-[11px] uppercase tracking-ultra text-grey mb-2">My Account</p>
          <h1 className="font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none">
            Drop Updates
          </h1>
          <div className="mt-3 flex items-center gap-2 text-sm text-bone-soft">
            <Mail size={14} strokeWidth={1.6} className="text-grey" />
            <span>{user?.email}</span>
          </div>
        </div>

        {/* Preferences panel */}
        {prefsOpen && subscriber && (
          <div className="mb-8 bg-white border border-line rounded p-6 animate-slide-down">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-xl tracking-wide-2 text-bone uppercase">Notification Settings</h2>
              <button onClick={() => setPrefsOpen(false)} className="text-grey hover:text-bone text-sm">Close</button>
            </div>
            <div className="space-y-3">
              <PrefToggle
                icon={ShoppingBag}
                label="New Drop Alerts"
                description="Get notified when a new drop goes live."
                checked={subscriber.wants_drop_alerts}
                onToggle={() => togglePref('wants_drop_alerts')}
              />
              <PrefToggle
                icon={TrendingUp}
                label="Restock Alerts"
                description="Know when sold-out pieces are back in stock."
                checked={subscriber.wants_restock_alerts}
                onToggle={() => togglePref('wants_restock_alerts')}
              />
              <PrefToggle
                icon={Newspaper}
                label="General News"
                description="Brand updates, stories, and behind-the-scenes."
                checked={subscriber.wants_general_news}
                onToggle={() => togglePref('wants_general_news')}
              />
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 md:gap-4 mb-8">
          <StatCard label="Unread" value={unreadCount} icon={Bell} />
          <StatCard label="Total" value={announcements?.length ?? 0} icon={Newspaper} />
          <StatCard label="Products" value={products.length} icon={ShoppingBag} />
        </div>

        {/* Mark all read */}
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="mb-4 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors"
          >
            <Check size={14} strokeWidth={2} /> Mark all as read
          </button>
        )}

        {/* Announcements */}
        {announcements === null ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 bg-white border border-line rounded animate-pulse" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-20 bg-white border border-line rounded">
            <Bell size={32} className="text-grey mx-auto mb-4" strokeWidth={1.5} />
            <p className="font-label text-2xl uppercase tracking-wide-2 text-grey">No updates yet</p>
            <p className="mt-2 text-sm text-grey">New drops and restocks will show up here first.</p>
            <a
              href={linkHref('/collection')}
              className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors"
            >
              Browse The Collection <ExternalLink size={13} />
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            {sorted.map((ann) => {
              const meta = TYPE_META[ann.type] ?? TYPE_META.news;
              const isRead = readIds.has(ann.id);
              const linkedProduct = ann.product_slug ? products.find((p) => p.slug === ann.product_slug) : null;
              return (
                <div
                  key={ann.id}
                  className={`bg-white border rounded p-5 md:p-6 transition-all ${
                    isRead ? 'border-line' : 'border-bone/30 shadow-[0_2px_12px_rgba(0,0,0,0.05)]'
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <div className={`shrink-0 w-10 h-10 rounded flex items-center justify-center ${meta.bg}`}>
                      <meta.icon size={18} className={meta.color} strokeWidth={1.8} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-label text-[10px] uppercase tracking-wide-2 font-semibold ${meta.color}`}>
                          {meta.label}
                        </span>
                        {ann.is_pinned && (
                          <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone bg-paper-2 px-2 py-0.5 rounded">
                            Pinned
                          </span>
                        )}
                        {!isRead && (
                          <span className="w-2 h-2 bg-bone rounded-full shrink-0" />
                        )}
                      </div>
                      <h3 className="mt-2 text-lg font-semibold text-bone leading-tight">{ann.title}</h3>
                      <p className="mt-2 text-sm text-bone-soft leading-relaxed">{ann.body}</p>

                      {linkedProduct && (
                        <a
                          href={linkHref(`/product/${linkedProduct.slug}`)}
                          className="mt-3 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors"
                        >
                          View {linkedProduct.name} — {formatPrice(linkedProduct.price)}
                          <ExternalLink size={12} />
                        </a>
                      )}

                      <div className="mt-3 flex items-center gap-3">
                        <span className="text-[11px] text-grey">
                          {new Date(ann.goes_live_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                        {!isRead && (
                          <button
                            onClick={() => markRead(ann.id)}
                            className="text-[11px] uppercase tracking-wide-2 font-medium text-bone-dim hover:text-bone transition-colors"
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mx-auto max-w-4xl px-5 md:px-8 pt-6 pb-10">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-5 text-[11px] text-grey">
          <a href={linkHref('/terms-and-conditions')} className="underline hover:text-bone transition-colors">Terms &amp; Conditions</a>
          <a href={linkHref('/privacy-policy')} className="underline hover:text-bone transition-colors">Privacy Policy</a>
          <a href={linkHref('/refund-and-cancellation')} className="underline hover:text-bone transition-colors">Refund &amp; Cancellation</a>
          <a href={linkHref('/return-policy')} className="underline hover:text-bone transition-colors">Return Policy</a>
          <a href={linkHref('/shipping-policy')} className="underline hover:text-bone transition-colors">Shipping Policy</a>
        </div>
      </div>
    </div>
  );
}

function PrefToggle({
  icon: Icon,
  label,
  description,
  checked,
  onToggle,
}: {
  icon: typeof Bell;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-line last:border-0">
      <div className="flex items-center gap-3">
        <Icon size={18} className="text-bone-dim" strokeWidth={1.6} />
        <div>
          <p className="text-sm font-medium text-bone">{label}</p>
          <p className="text-xs text-grey">{description}</p>
        </div>
      </div>
      <button
        onClick={onToggle}
        className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-bone' : 'bg-paper-3'}`}
        aria-label={`Toggle ${label}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Bell }) {
  return (
    <div className="bg-white border border-line rounded p-4 text-center">
      <Icon size={18} className="text-bone mx-auto mb-2" strokeWidth={1.6} />
      <p className="font-label text-2xl font-semibold text-bone tabular-nums">{value}</p>
      <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-1">{label}</p>
    </div>
  );
}
