import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task, List } from '../types';
import Icon from '../components/Icon';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiGetLists } from '../api/client';

interface MoveTaskModalProps {
  task: Task;
  onClose: () => void;
}

/** Picker for "Move to another to-do" — spans every workspace the user belongs
 *  to (a task can move across workspaces), grouped by workspace so a large
 *  to-do directory stays navigable. */
export default function MoveTaskModal({ task, onClose }: MoveTaskModalProps) {
  const { moveTaskToList, moveTaskToDashboard } = useAppStore();
  const { workspaces } = useWorkspaceStore();
  const [lists, setLists] = useState<List[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    apiGetLists().then(res => setLists(res.lists)).catch(() => setLists([]));
  }, []);

  const workspaceName = useCallback((id?: string) => workspaces.find(w => w.id === id)?.name ?? 'Other', [workspaces]);

  const filtered = useMemo(() => {
    if (!lists) return [];
    const q = query.trim().toLowerCase();
    return lists
      .filter(l => l.id !== task._listId && l.parentTaskId !== task.id)
      .filter(l => !q || l.name.toLowerCase().includes(q))
      .sort((a, b) => workspaceName(a.workspaceId).localeCompare(workspaceName(b.workspaceId)) || a.name.localeCompare(b.name));
  }, [lists, query, task._listId, task.id, workspaceName]);

  const grouped = useMemo(() => {
    const groups = new Map<string, List[]>();
    for (const l of filtered) {
      const key = workspaceName(l.workspaceId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(l);
    }
    return Array.from(groups.entries());
  }, [filtered, workspaceName]);

  const pick = (listId: string) => {
    moveTaskToList(task.id, listId);
    onClose();
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 220ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(94,77,187,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 4px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="drive_file_move" size={19} color="#5e4dbb" />
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Move to another to-do</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          </div>
        </div>

        <div style={{ padding: '14px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '9px 12px' }}>
            <Icon name="search" size={15} color="#b0acbe" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search to-dos…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22' }}
            />
          </div>
        </div>

        <div style={{ padding: '12px 22px 0', overflowY: 'auto', flex: 1 }}>
          {task._source === 'list' && (
            <button
              onClick={() => { moveTaskToDashboard(task.id); onClose(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff', cursor: 'pointer', textAlign: 'left', marginBottom: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="today" size={15} color="#5e4dbb" />
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>Move to Dashboard</div>
            </button>
          )}

          {lists === null && (
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '12px 2px' }}>Loading to-dos…</div>
          )}
          {lists !== null && filtered.length === 0 && (
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '12px 2px' }}>No matching to-dos.</div>
          )}

          {grouped.map(([wsName, wsLists]) => (
            <div key={wsName} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#b0acbe', marginBottom: 6, paddingLeft: 2 }}>{wsName}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {wsLists.map(l => (
                  <button
                    key={l.id}
                    onClick={() => pick(l.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff', cursor: 'pointer', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                      {l.emoji ?? <Icon name="format_list_bulleted" size={15} color={l.color ?? '#5e4dbb'} />}
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 22px 20px' }}>
          <button
            onClick={onClose}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#484552' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
