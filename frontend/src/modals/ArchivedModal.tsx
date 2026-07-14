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
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden', position: 'relative' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#FEF3E2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="archive" size={18} color="#f59e0b" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Archived</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>Lists hidden from your workspace — kept forever until you unarchive them.</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: '#f5f3ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 12, display: 'flex', pointerEvents: 'none' }}>
              <Icon name="search" size={15} color="#b0acbe" />
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search archived lists…"
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 9999, padding: '8px 14px 8px 34px', outline: 'none', background: '#fafafa' }}
              onFocus={(e) => (e.target.style.borderColor = '#5e4dbb')} onBlur={(e) => (e.target.style.borderColor = '#e8e4f0')} />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
          {loading ? (
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '40px 0', textAlign: 'center' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: '#b0acbe' }}>
              <Icon name="archive" size={32} color="#d8d2e8" />
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#787584' }}>
                {lists.length === 0 ? 'No archived lists' : 'No matches'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filtered.map((list) => (
                <div key={list.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px', borderRadius: 10 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#faf9ff')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: list.colorBg ?? '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                    {list.emoji ?? '📋'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>Archived {list.archivedAt ? friendlyTime(list.archivedAt) : ''}</div>
                  </div>
                  <button onClick={() => handleUnarchive(list)} disabled={unarchivingId === list.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: unarchivingId === list.id ? 'default' : 'pointer', flexShrink: 0 }}>
                    <Icon name="unarchive" size={13} color="#5e4dbb" />
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
