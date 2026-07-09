import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import Icon from './Icon';
import CreatorBubble from './CreatorBubble';
import MarkdownView from './MarkdownView';
import useMembersStore from '../store/useMembersStore';

const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };

interface TaskDetailPopupProps {
  task: Task;
  anchor?: { x: number; y: number } | null;
  onEdit: (task: Task) => void;
  onGoToList?: (listId: string) => void;
  onClose: () => void;
}

export default function TaskDetailPopup({ task, anchor, onEdit, onGoToList, onClose }: TaskDetailPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const creator = useMembersStore(s => task.creatorId ? s.members[task.creatorId] : undefined);
  const stripeColor = task.priority ? PRIORITY_COLORS[task.priority] : '#5e4dbb';

  const pos = (() => {
    if (!anchor) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const pw = 320, ph = 300;
    let left = anchor.x + 12;
    let top = anchor.y;
    if (left + pw > window.innerWidth - 16) left = anchor.x - pw - 12;
    if (top + ph > window.innerHeight - 16) top = anchor.y - ph;
    return { top, left };
  })();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const today = new Date(); today.setHours(0,0,0,0);
  const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const friendlyDate = (iso?: string) => {
    if (!iso) return '';
    if (iso === localIso(today)) return 'Today';
    const d = new Date(iso.slice(0, 10) + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 1099 }} onClick={onClose} />
      <div ref={popupRef}
        style={{ position: 'fixed', ...pos, zIndex: 1100, width: 320, background: '#fff', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', overflow: 'hidden', animation: 'modalIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <div style={{ height: 4, background: stripeColor }} />
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', lineHeight: 1.35, flex: 1 }}>{task.title}</div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, display: 'flex', padding: 2 }}>
              <Icon name="close" size={16} color="#787584" />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {task.deadline && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="calendar_today" size={13} color="#787584" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{friendlyDate(task.deadline)}</span>
              </div>
            )}
            {task.priority && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="flag" size={13} color={PRIORITY_COLORS[task.priority]} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: PRIORITY_COLORS[task.priority], fontWeight: 600 }}>{task.priority} priority</span>
              </div>
            )}
            {task.badge && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="label" size={13} color="#787584" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{task.badge}</span>
              </div>
            )}
            {task._listName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="format_list_bulleted" size={13} color="#787584" />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>{task._listName}</span>
              </div>
            )}
            {task.creatorId && creator && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CreatorBubble creatorId={task.creatorId} taskHovered={true} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#484552' }}>
                  {creator.fullName || creator.username}
                </span>
              </div>
            )}
            {task.note && (
              <div style={{ marginTop: 4, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', lineHeight: 1.5, background: '#faf9ff', borderRadius: 8, padding: '8px 10px' }}>
                {task.noteMarkdown ? <MarkdownView source={task.note} fontSize={12} /> : task.note}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button onClick={() => onEdit(task)}
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer' }}>
              Edit Task
            </button>
            {task._source === 'list' && task._listId && onGoToList && (
              <button onClick={() => onGoToList(task._listId!)}
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', background: '#f1ecf6', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer' }}>
                Go to list
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
