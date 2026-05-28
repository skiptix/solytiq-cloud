import { useState } from 'react';
import useAppStore, { apiEmptyTrash } from '../store/useAppStore';
import Icon from '../components/Icon';
import type { TrashedTask, TrashedList, TrashedFolder } from '../types';

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

function taskCount(list: TrashedList['list']) {
  return list.sections.reduce((acc, s) => acc + s.tasks.length, 0);
}

type TrashTab = 'all' | 'tasks' | 'lists' | 'folders';

interface TrashModalProps {
  onClose: () => void;
}

export default function TrashModal({ onClose }: TrashModalProps) {
  const {
    trashTasks, restoreFromTrash, deleteFromTrash,
    trashLists, restoreListFromTrash, deleteListFromTrash,
    trashFolders, restoreFolderFromTrash, deleteFolderFromTrash,
  } = useAppStore();

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<TrashTab>('all');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptyLoading, setEmptyLoading] = useState(false);

  const totalCount = trashTasks.length + trashLists.length + trashFolders.length;
  const q = search.trim().toLowerCase();

  const filteredTasks = trashTasks.filter(t =>
    !q || t.task.title.toLowerCase().includes(q) || (t.meta.listName ?? '').toLowerCase().includes(q)
  );
  const filteredLists = trashLists.filter(t =>
    !q || t.list.name.toLowerCase().includes(q)
  );
  const filteredFolders = trashFolders.filter(t =>
    !q || t.folder.name.toLowerCase().includes(q)
  );

  type AnyTrashItem =
    | { kind: 'task'; deletedAt: string; item: TrashedTask }
    | { kind: 'list'; deletedAt: string; item: TrashedList }
    | { kind: 'folder'; deletedAt: string; item: TrashedFolder };

  const allItems: AnyTrashItem[] = [
    ...filteredTasks.map(t => ({ kind: 'task' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredLists.map(t => ({ kind: 'list' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredFolders.map(t => ({ kind: 'folder' as const, deletedAt: t.deletedAt, item: t })),
  ].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

  const visibleItems = tab === 'all'
    ? allItems
    : tab === 'tasks'
      ? allItems.filter(i => i.kind === 'task')
      : tab === 'lists'
        ? allItems.filter(i => i.kind === 'list')
        : allItems.filter(i => i.kind === 'folder');

  const handleEmptyTrash = async () => {
    setEmptyLoading(true);
    try {
      await apiEmptyTrash();
    } catch {
      // ignore api failure, clear locally
    }
    trashTasks.forEach(t => deleteFromTrash(t.id));
    trashLists.forEach(t => deleteListFromTrash(t.id));
    trashFolders.forEach(t => deleteFolderFromTrash(t.id));
    setEmptyLoading(false);
    setConfirmEmpty(false);
  };

  const TABS: { id: TrashTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: totalCount },
    { id: 'tasks', label: 'Tasks', count: trashTasks.length },
    { id: 'lists', label: 'Lists', count: trashLists.length },
    { id: 'folders', label: 'Folders', count: trashFolders.length },
  ];

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden', position: 'relative' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="delete" size={18} color="#ba1a1a" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>Trash</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 }}>
              {totalCount} deleted item{totalCount !== 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        {/* Toolbar — search + filter pills, always visible */}
        <div style={{ padding: '12px 20px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f7f4fc', borderRadius: 10, padding: '8px 14px', marginBottom: 10 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {TABS.filter(t => t.id === 'all' || t.count > 0).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: tab === t.id ? '#5e4dbb' : '#f1ecf6', color: tab === t.id ? '#fff' : '#787584', transition: 'all 150ms' }}>
                {t.label}
              </button>
            ))}
            {totalCount > 0 && (
              <button
                onClick={() => setConfirmEmpty(true)}
                style={{ marginLeft: 'auto', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#ba1a1a', background: '#fff5f5', border: '1px solid #ffdad6', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
                Empty Trash
              </button>
            )}
          </div>
        </div>

        {/* Items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
          {totalCount === 0 ? (
            <div style={{ padding: '48px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#f7f4fc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="delete" size={28} color="#c9c4d5" />
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>Trash is empty.</div>
            </div>
          ) : visibleItems.length === 0 ? (
            <div style={{ padding: '32px 12px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No matching items.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
              {visibleItems.map(entry => {
                if (entry.kind === 'task') {
                  const item = entry.item as TrashedTask;
                  return (
                    <TaskTrashRow
                      key={`task-${item.id}`}
                      item={item}
                      onRestore={() => restoreFromTrash(item.id)}
                      onDelete={() => deleteFromTrash(item.id)} />
                  );
                }
                if (entry.kind === 'list') {
                  const item = entry.item as TrashedList;
                  return (
                    <ListTrashRow
                      key={`list-${item.id}`}
                      item={item}
                      onRestore={() => restoreListFromTrash(item.id)}
                      onDelete={() => deleteListFromTrash(item.id)} />
                  );
                }
                const item = entry.item as TrashedFolder;
                return (
                  <FolderTrashRow
                    key={`folder-${item.id}`}
                    item={item}
                    onRestore={() => restoreFolderFromTrash(item.id)}
                    onDelete={() => deleteFolderFromTrash(item.id)} />
                );
              })}
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
                This will permanently delete all {totalCount} item{totalCount !== 1 ? 's' : ''} in the trash. This cannot be undone.
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

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function ActionButtons({ onRestore, onDelete, hov }: { onRestore: () => void; onDelete: () => void; hov: boolean }) {
  return (
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
  );
}

function TaskTrashRow({ item, onRestore, onDelete }: { item: TrashedTask; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const PCOLS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? '#fff5f5' : '#fafafa', border: `1px solid ${hov ? '#ffdad6' : '#f1ecf6'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name="task_alt" size={15} color="#ba1a1a" />
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
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </div>
  );
}

function ListTrashRow({ item, onRestore, onDelete }: { item: TrashedList; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const count = taskCount(item.list);

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? '#f5f3ff' : '#fafafa', border: `1px solid ${hov ? '#e0d9ff' : '#f1ecf6'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.list.emoji
          ? <span style={{ fontSize: 16 }}>{item.list.emoji}</span>
          : <Icon name="format_list_bulleted" size={15} color="#5e4dbb" />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.list.name}
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe', marginTop: 2 }}>
          List · {count} task{count !== 1 ? 's' : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </div>
  );
}

function FolderTrashRow({ item, onRestore, onDelete }: { item: TrashedFolder; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const listCount = (item.folder.listIds ?? []).length;

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? '#fffbeb' : '#fafafa', border: `1px solid ${hov ? '#fde68a' : '#f1ecf6'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.folder.emoji
          ? <span style={{ fontSize: 16 }}>{item.folder.emoji}</span>
          : <Icon name="folder" size={15} color="#d97706" />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.folder.name}
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe', marginTop: 2 }}>
          Folder · {listCount} list{listCount !== 1 ? 's' : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </div>
  );
}
