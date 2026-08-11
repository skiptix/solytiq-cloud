import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { useMobile } from '../hooks/useBreakpoint';
import { apiGetAppsCatalog, apiInstallApp, apiUninstallApp, ApiError, type AppCatalogEntry } from '../api/client';
import Spinner from '@/components/animate-ui/Spinner';
import MotionButton from '@/components/animate-ui/MotionButton';
import MotionIn from '@/components/animate-ui/MotionIn';
import { motion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, EASE_STANDARD } from '@/components/animate-ui/motionTokens';

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
    <MotionIn
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: hov ? -2 : 0, scale: 1, boxShadow: hov ? '0 8px 24px rgba(var(--color-black-rgb), 0.08)' : '0 1px 3px rgba(var(--color-black-rgb), 0.03)' }}
      transition={{ opacity: { duration: 0.32, ease: EASE_SETTLE }, scale: { duration: 0.32, ease: EASE_SETTLE }, y: { duration: 0.2 }, boxShadow: { duration: 0.2 } }}
      style={{
        background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 16, padding: 18,
        display: 'flex', flexDirection: 'column', gap: 12,
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
          <motion.span
            title="Installed"
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: [0, 1, 1], scale: [0.3, 1.25, 1] }}
            transition={{ duration: 0.42, times: [0, 0.6, 1], ease: EASE_SPRING }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: 'var(--color-green-pale-5)', flexShrink: 0 }}>
            <Icon name="check" size={14} color="var(--color-success)" />
          </motion.span>
        )}
      </div>

      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, flex: 1, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {app.description}
      </div>

      {confirmingUninstall ? (
        <MotionIn initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: EASE_STANDARD }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        </MotionIn>
      ) : app.installed ? (
        <MotionButton onClick={onUninstallClick} disabled={installing}
          whileHover={{ borderColor: 'var(--color-red-tint-2)', color: 'var(--color-error)', background: 'var(--color-red-pale-3)' }}
          transition={{ duration: 0.15 }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
          <Icon name="remove_circle_outline" size={14} color="currentColor" />
          Uninstall
        </MotionButton>
      ) : (
        <MotionButton onClick={onInstall} disabled={installing}
          animate={{ background: installing ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
          transition={{ duration: 0.15 }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 0', borderRadius: 9, border: 'none', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', cursor: installing ? 'wait' : 'pointer' }}>
          {installing
            ? <><Spinner size={13} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.4)" indicatorColor="var(--color-white)" durationMs={700} display="inline-block" /> Installing…</>
            : <><Icon name="add_circle" size={14} color="var(--color-white)" /> Install</>
          }
        </MotionButton>
      )}
    </MotionIn>
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
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.22, ease: EASE_STANDARD }}
      style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(var(--color-purple-deep-5-rgb), 0.55)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 0 : 28 }}>
      <MotionIn
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 22, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.36, ease: EASE_SETTLE }}
        style={{ background: 'var(--color-purple-pale-3)', borderRadius: isMobile ? 0 : 22, width: '100%', maxWidth: 1100, height: isMobile ? '100%' : '92vh', maxHeight: isMobile ? '100%' : '92vh', boxShadow: '0 24px 70px rgba(var(--color-black-rgb), 0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

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
            <MotionButton
              onClick={onClose}
              whileHover={{ background: 'var(--color-border)' }}
              transition={{ duration: 0.15 }}
              style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--color-surface-tint-2)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            >
              <Icon name="close" size={17} color="var(--color-text-secondary)" />
            </MotionButton>
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
                  <MotionButton key={t.id} onClick={() => setStatusFilter(t.id)}
                    animate={{ background: active ? 'var(--color-primary)' : 'transparent', color: active ? 'var(--color-white)' : 'var(--color-primary)' }}
                    transition={{ duration: 0.15 }}
                    style={{ padding: '6px 13px', borderRadius: 8, border: 'none', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    {t.label}
                  </MotionButton>
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
              <Spinner size={32} thickness={3} durationMs={700} />
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
      </MotionIn>
    </motion.div>,
    document.body
  );
}
