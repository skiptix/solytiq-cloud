import { useState } from 'react';
import useAppStore, { apiEmptyTrash } from '../store/useAppStore';
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

interface TrashModalProps {
  onClose: () => void;
}

export default function TrashModal({ onClose }: TrashModalProps) {
  const { trashTasks, restoreFromTrash, deleteFromTrash } = useAppStore();
  const [search, setSearch] = useState('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptyLoading, setEmptyLoading] = useState(false);

  const visible = search.trim()
    ? trashTasks.filter(t => t.task.title.toLowerCase().includes(search.toLowerCase()) || (t.meta.listName ?? '').toLowerCase().includes(search.toLowerCase()))
    : trashTasks;

  const sorted = [...visible].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

  const handleEmptyTrash = async () => {
    setEmptyLoading(true);
    try {
      await apiEmptyTrash();
    } catch {
      // ignore api failure, clear locally
    }
    // Clear all locally (deleteFromTrash one by one, or reset directly via setDashTasks/setLists doesn't make sense here)
    // Instead we use the store method via each item
    trashTasks.forEach(t => deleteFromTrash(t.id));
    setEmptyLoading(false);
    setConfirmEmpty(false);
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="delete" size={18} color="#ba1a1a" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>Trash</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>
              {trashTasks.length} deleted item{trashTasks.length !== 1 ? 's' : ''}
            </div>
          </div>
          {trashTasks.length > 0 && (
            <button
              onClick={() => setConfirmEmpty(true)}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
              Empty Trash
            </button>
          )}
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Search */}
        {trashTasks.length > 0 && (
          <div style={{ padding: '12px 20px 8px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f7f4fc', borderRadius: 10, padding: '8px 14px' }}>
              <Icon name="search" size={16} color="#787584" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search trash…"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }} />
              {search && (
                <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
                  <Icon name="close" size={14} color="#787584" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {trashTasks.length === 0 ? (
            <div style={{ padding: '48px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#f7f4fc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="delete" size={28} color="#c9c4d5" />
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>Trash is empty.</div>
            </div>
          ) : sorted.length === 0 ? (
            <div style={{ padding: '32px 12px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No matching items.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
              {sorted.map(item => (
                <TrashRow
                  key={item.id}
                  item={item}
                  onRestore={() => restoreFromTrash(item.id)}
                  onDelete={() => deleteFromTrash(item.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Empty confirm overlay */}
        {confirmEmpty && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, zIndex: 10 }}>
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Icon name="warning" size={26} color="#ba1a1a" />
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Empty the trash?</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.6, marginBottom: 24 }}>
                This will permanently delete all {trashTasks.length} item{trashTasks.length !== 1 ? 's' : ''} in the trash. This cannot be undone.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button onClick={() => setConfirmEmpty(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleEmptyTrash} disabled={emptyLoading} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: emptyLoading ? 'wait' : 'pointer' }}>
                  {emptyLoading ? 'Deleting…' : 'Empty Trash'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TrashRow({ item, onRestore, onDelete }: { item: { id: number; task: { title: string; note?: string; priority?: string }; meta: { src: string; listName?: string }; deletedAt: string }; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const PCOLS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? '#fff5f5' : '#fafafa', border: `1px solid ${hov ? '#ffdad6' : '#f1ecf6'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name="delete" size={15} color="#ba1a1a" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#484552', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'line-through' }}>
          {item.task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe' }}>
            {item.meta.src === 'list' ? item.meta.listName : 'Dashboard'} · {friendlyTime(item.deletedAt)}
          </span>
          {item.task.priority && (
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, fontWeight: 600, color: PCOLS[item.task.priority] }}>{item.task.priority}</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button
          onClick={onRestore}
          title="Restore"
          style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="restore" size={13} color="#5e4dbb" /> Restore
        </button>
        <button
          onClick={onDelete}
          title="Delete permanently"
          style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: hov ? '#ffdad6' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}>
          <Icon name="delete_forever" size={15} color="#ba1a1a" />
        </button>
      </div>
    </div>
  );
}
