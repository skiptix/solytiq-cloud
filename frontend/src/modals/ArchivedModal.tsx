import { useState, useEffect, useMemo } from 'react';
import type { List } from '../types';
import { apiGetArchivedLists, apiUnarchiveList } from '../api/client';
import useWorkspaceStore from '../store/useWorkspaceStore';
import Icon from '../components/Icon';

function friendlyTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ArchivedModalProps {
  onClose: () => void;
}

export default function ArchivedModal({ onClose }: ArchivedModalProps) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGetArchivedLists(currentWorkspaceId ?? undefined)
      .then((res) => { if (!cancelled) setLists(res.lists); })
      .catch(() => { if (!cancelled) setLists([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentWorkspaceId]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => lists.filter((l) => !q || l.name.toLowerCase().includes(q)), [lists, q]);

  const handleUnarchive = async (list: List) => {
    setUnarchivingId(list.id);
    try {
      await apiUnarchiveList(list.id);
      setLists((prev) => prev.filter((l) => l.id !== list.id));
    } catch {
      // leave it in the list — the user can retry
    } finally {
      setUnarchivingId(null);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden', position: 'relative' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-orange-pale-5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="archive" size={18} color="var(--color-warning-alt)" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Archived</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Lists hidden from your workspace — kept forever until you unarchive them.</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--color-surface-tint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 12, display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search archived lists…"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 9999, padding: '8px 14px 8px 34px', outline: 'none', background: 'var(--color-surface-neutral)' }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--color-primary)')} onBlur={(e) => (e.target.style.borderColor = 'var(--color-border)')} />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
          {loading ? (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '40px 0', textAlign: 'center' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: 'var(--color-text-quaternary)' }}>
              <Icon name="archive" size={32} color="var(--color-purple-tint-3)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>
                {lists.length === 0 ? 'No archived lists' : 'No matches'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filtered.map((list) => (
                <div key={list.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px', borderRadius: 10 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-tint-3)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: list.colorBg ?? 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                    {list.emoji ?? '📋'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>Archived {list.archivedAt ? friendlyTime(list.archivedAt) : ''}</div>
                  </div>
                  <button onClick={() => handleUnarchive(list)} disabled={unarchivingId === list.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: unarchivingId === list.id ? 'default' : 'pointer', flexShrink: 0 }}>
                    <Icon name="unarchive" size={13} color="var(--color-primary)" />
                    {unarchivingId === list.id ? 'Unarchiving…' : 'Unarchive'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
