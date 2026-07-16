import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { useMobile } from '../hooks/useBreakpoint';
import { apiGetAppsCatalog, apiInstallApp, apiUninstallApp, ApiError, type AppCatalogEntry } from '../api/client';

interface AppsStoreModalProps {
  onClose: () => void;
}

type StatusFilter = 'all' | 'installed' | 'available';

// How long the optimistic "installing…" spinner shows before the app flips
// to Installed — purely a moment of ceremony, not real work.
const INSTALL_ANIM_MS = 700;

function AppCard({
  app, installing, confirmingUninstall, onInstall, onUninstallClick, onUninstallConfirm, onUninstallCancel,
}: {
  app: AppCatalogEntry;
  installing: boolean;
  confirmingUninstall: boolean;
  onInstall: () => void;
  onUninstallClick: () => void;
  onUninstallConfirm: () => void;
  onUninstallCancel: () => void;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 16, padding: 18,
        display: 'flex', flexDirection: 'column', gap: 12,
        boxShadow: hov ? '0 8px 24px rgba(var(--color-black-rgb), 0.08)' : '0 1px 3px rgba(var(--color-black-rgb), 0.03)',
        transform: hov ? 'translateY(-2px)' : 'none',
        transition: 'box-shadow 200ms, transform 200ms',
        animation: 'cardIn 320ms cubic-bezier(0.22,1,0.36,1) both',
      }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${app.accentColor}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={app.icon} size={22} color={app.accentColor} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>{app.name}</div>
          <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: app.accentColor, background: `${app.accentColor}14`, padding: '2px 8px', borderRadius: 9999, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {app.category}
          </span>
        </div>
        {app.installed && !confirmingUninstall && (
          <span title="Installed" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: 'var(--color-green-pale-5)', flexShrink: 0, animation: 'appInstalledPop 420ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <Icon name="check" size={14} color="var(--color-success)" />
          </span>
        )}
      </div>

      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, flex: 1, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {app.description}
      </div>

      {confirmingUninstall ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'sectionFadeUp 160ms ease both' }}>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)', lineHeight: 1.4 }}>
            This hides {app.name} for every user. Uninstall?
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onUninstallCancel}
              style={{ flex: 1, padding: '8px 0', borderRadius: 9, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={onUninstallConfirm}
              style={{ flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', background: 'var(--color-error)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', cursor: 'pointer' }}>
              Uninstall
            </button>
          </div>
        </div>
      ) : app.installed ? (
        <button onClick={onUninstallClick} disabled={installing}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-red-tint-2)'; e.currentTarget.style.color = 'var(--color-error)'; e.currentTarget.style.background = 'var(--color-red-pale-3)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.background = 'var(--color-white)'; }}>
          <Icon name="remove_circle_outline" size={14} color="currentColor" />
          Uninstall
        </button>
      ) : (
        <button onClick={onInstall} disabled={installing}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 0', borderRadius: 9, border: 'none', background: installing ? 'var(--color-border-strong)' : 'var(--color-primary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', cursor: installing ? 'wait' : 'pointer', transition: 'background 150ms' }}>
          {installing
            ? <><span style={{ width: 13, height: 13, border: '2px solid rgba(var(--color-white-rgb), 0.4)', borderTopColor: 'var(--color-white)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /> Installing…</>
            : <><Icon name="add_circle" size={14} color="var(--color-white)" /> Install</>
          }
        </button>
      )}
    </div>
  );
}

export default function AppsStoreModal({ onClose }: AppsStoreModalProps) {
  const isMobile = useMobile();
  const [apps, setApps] = useState<AppCatalogEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGetAppsCatalog().then(res => setApps(res.apps)).catch(() => setApps([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = useMemo(() => {
    if (!apps) return [];
    return Array.from(new Set(apps.map(a => a.category))).sort();
  }, [apps]);

  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = search.trim().toLowerCase();
    return apps.filter(a => {
      if (statusFilter === 'installed' && !a.installed) return false;
      if (statusFilter === 'available' && a.installed) return false;
      if (categoryFilter !== 'all' && a.category !== categoryFilter) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [apps, search, statusFilter, categoryFilter]);

  const install = (appId: string) => {
    setError(null);
    setInstallingIds(prev => new Set(prev).add(appId));
    setTimeout(async () => {
      try {
        await apiInstallApp(appId);
        setApps(prev => prev && prev.map(a => a.id === appId ? { ...a, installed: true } : a));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to install — please try again.');
      } finally {
        setInstallingIds(prev => { const next = new Set(prev); next.delete(appId); return next; });
      }
    }, INSTALL_ANIM_MS);
  };

  const uninstall = async (appId: string) => {
    setError(null);
    setConfirmUninstallId(null);
    setInstallingIds(prev => new Set(prev).add(appId));
    try {
      await apiUninstallApp(appId);
      setApps(prev => prev && prev.map(a => a.id === appId ? { ...a, installed: false } : a));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to uninstall — please try again.');
    } finally {
      setInstallingIds(prev => { const next = new Set(prev); next.delete(appId); return next; });
    }
  };

  const statusTabs: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'installed', label: 'Installed' },
    { id: 'available', label: 'Available' },
  ];

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(var(--color-purple-deep-5-rgb), 0.55)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 0 : 28, animation: 'backdropIn 220ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-purple-pale-3)', borderRadius: isMobile ? 0 : 22, width: '100%', maxWidth: 1100, height: isMobile ? '100%' : '92vh', maxHeight: isMobile ? '100%' : '92vh', boxShadow: '0 24px 70px rgba(var(--color-black-rgb), 0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both' }}>

        {/* Header */}
        <div style={{ padding: isMobile ? '18px 16px 14px' : '24px 28px 18px', borderBottom: '1px solid var(--color-purple-pale-32)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="apps" size={19} color="var(--color-primary)" />
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>Discover Apps</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>Install optional features for everyone on this instance.</div>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 150ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-surface-tint-2)')}
            >
              <Icon name="close" size={17} color="var(--color-text-secondary)" />
            </button>
          </div>

          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--color-white)', border: '1.5px solid var(--color-border-alt)', borderRadius: 12, padding: '10px 14px', marginBottom: 14 }}>
            <Icon name="search" size={16} color="var(--color-text-quaternary)" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search apps…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', padding: 0 }}>
                <Icon name="close" size={14} color="var(--color-text-quaternary)" />
              </button>
            )}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-tint)', borderRadius: 10, padding: 3 }}>
              {statusTabs.map(t => {
                const active = statusFilter === t.id;
                return (
                  <button key={t.id} onClick={() => setStatusFilter(t.id)}
                    style={{ padding: '6px 13px', borderRadius: 8, border: 'none', background: active ? 'var(--color-primary)' : 'transparent', color: active ? 'var(--color-white)' : 'var(--color-primary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'all 150ms' }}>
                    {t.label}
                  </button>
                );
              })}
            </div>
            {categories.length > 1 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setCategoryFilter('all')}
                  style={{ padding: '5px 12px', borderRadius: 9999, border: `1.5px solid ${categoryFilter === 'all' ? 'var(--color-primary)' : 'var(--color-border)'}`, background: categoryFilter === 'all' ? 'var(--color-surface-tint)' : 'var(--color-white)', color: categoryFilter === 'all' ? 'var(--color-primary)' : 'var(--color-text-tertiary)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  All categories
                </button>
                {categories.map(c => (
                  <button key={c} onClick={() => setCategoryFilter(c)}
                    style={{ padding: '5px 12px', borderRadius: 9999, border: `1.5px solid ${categoryFilter === c ? 'var(--color-primary)' : 'var(--color-border)'}`, background: categoryFilter === c ? 'var(--color-surface-tint)' : 'var(--color-white)', color: categoryFilter === c ? 'var(--color-primary)' : 'var(--color-text-tertiary)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px' : '22px 28px 28px' }}>
          {error && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--color-red-pale-5)', border: '1px solid var(--color-red-tint-2)', marginBottom: 16 }}>
              <Icon name="error" size={15} color="var(--color-error)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-error)' }}>{error}</span>
            </div>
          )}

          {apps === null ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
              <div style={{ width: 32, height: 32, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '80px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="search_off" size={26} color="var(--color-primary)" />
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>No apps match</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Try a different search or filter.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(250px, 1fr))', gap: 16 }}>
              {filtered.map(app => (
                <AppCard
                  key={app.id}
                  app={app}
                  installing={installingIds.has(app.id)}
                  confirmingUninstall={confirmUninstallId === app.id}
                  onInstall={() => install(app.id)}
                  onUninstallClick={() => setConfirmUninstallId(app.id)}
                  onUninstallConfirm={() => uninstall(app.id)}
                  onUninstallCancel={() => setConfirmUninstallId(null)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
