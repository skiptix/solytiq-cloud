import { useState, useRef, useEffect } from 'react';
import type { Task } from '../types';
import Icon from './Icon';
import CalendarPicker from './CalendarPicker';
import { DeleteConfirmModal } from './TaskItem';
import useAppStore from '../store/useAppStore';
import { apiCreateList, apiCreateSection, apiAddListTask, apiUpdateTask, apiUpdateListTask } from '../api/client';

const PRIORITIES = ['High', 'Medium', 'Low'] as const;
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  Work: { bg: '#f9e287', color: '#6e5e0d' },
  Personal: { bg: '#F5F3FF', color: '#5e4dbb' },
  Urgent: { bg: '#ffdad6', color: '#ba1a1a' },
  Tip: { bg: '#eff6ff', color: '#1D4ED8' },
};
const TAGS = ['Work', 'Personal', 'Urgent', 'Tip'] as const;

function localIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function friendlyDate(iso?: string) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  if (iso === localIso(today)) return 'Today';
  const tom = new Date(today); tom.setDate(tom.getDate() + 1);
  if (iso === localIso(tom)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function Checkmark() {
  return (
    <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
      <path d="M1 4.5L4.5 8L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmallCheck() {
  return (
    <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
      <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface TaskDialogProps {
  task: Task;
  onUpdate: (id: number, updates: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}

export default function TaskDialog({ task, onUpdate, onDelete, onClose }: TaskDialogProps) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.note ?? '');
  const [deadline, setDeadline] = useState(task.deadline ?? '');
  const [priority, setPriority] = useState<string>(task.priority ?? '');
  const [tag, setTag] = useState(task.badge ?? '');
  const [checked, setChecked] = useState(task.checked);
  const [showCal, setShowCal] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [linkedListId, setLinkedListId] = useState(task.linkedListId ?? null);
  const [newSubItem, setNewSubItem] = useState('');
  const [addingSubItem, setAddingSubItem] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const { lists, updateListTask, loadFromApi } = useAppStore();

  const linkedList = linkedListId ? lists.find(l => l.id === linkedListId) : null;
  const subItems = linkedList?.sections.flatMap(s => s.tasks) ?? [];

  const resizeTA = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (titleRef.current) resizeTA(titleRef.current);
    if (notesRef.current) resizeTA(notesRef.current);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !showCal) onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, showCal]);

  const save = (updates: Partial<Task>) => onUpdate(task.id, updates);

  const handleAddSubItem = async () => {
    if (!newSubItem.trim()) return;
    const itemTitle = newSubItem.trim();
    setNewSubItem('');
    setAddingSubItem(false);

    try {
      let listId = linkedListId;
      let sectionId: string;

      if (!listId) {
        setCreatingList(true);
        const newListId = `list_${crypto.randomUUID()}`;
        const newSecId = `sec_${crypto.randomUUID()}`;
        const res = await apiCreateList({ id: newListId, name: title, color: '#5e4dbb', isPublic: false });
        const actualListId = res.list?.id ?? newListId;
        const secRes = await apiCreateSection(actualListId, { id: newSecId, label: 'Tasks' });
        const actualSecId = secRes.section?.id ?? newSecId;
        // Route to the correct update API based on task source so list tasks
        // don't hit the dash-only PUT /api/tasks/:id endpoint and get a 404.
        if (task._source === 'list' && task._listId) {
          await apiUpdateListTask(task._listId, task.id, { linkedListId: actualListId, linkedListType: 'sublist' });
        } else {
          await apiUpdateTask(task.id, { linkedListId: actualListId, linkedListType: 'sublist' });
        }
        setLinkedListId(actualListId);
        listId = actualListId;
        sectionId = actualSecId;
        setCreatingList(false);
      } else {
        // List already linked. Resolve the section ID; if the list isn't in the
        // current store snapshot (e.g. workspace filter), reload first.
        let currentLinkedList = linkedList;
        if (!currentLinkedList) {
          await loadFromApi();
          currentLinkedList = useAppStore.getState().lists.find(l => l.id === listId) ?? null;
        }
        sectionId = currentLinkedList?.sections[0]?.id ?? '';
        if (!sectionId) return;
      }

      await apiAddListTask(listId, sectionId, { title: itemTitle });
      await loadFromApi();
    } catch (err) {
      console.error('Failed to add sub-item:', err);
      setCreatingList(false);
    }
  };

  return (
    <>
      <div
        ref={backdropRef}
        onClick={e => { if (e.target === backdropRef.current) onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px 20px',
        }}>

        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: '#fff', borderRadius: 18, width: '100%', maxWidth: 660,
            maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 32px 80px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.08)',
            animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both',
          }}>

          {/* Priority accent stripe */}
          <div style={{ height: 3, background: priority ? PRIORITY_COLORS[priority] : '#F0EEF8', flexShrink: 0, transition: 'background 200ms' }} />

          {/* Scrollable body */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '28px 32px 36px' }}>

            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 26 }}>
              <div
                onClick={() => { const next = !checked; setChecked(next); save({ checked: next }); }}
                style={{
                  width: 24, height: 24, minWidth: 24, borderRadius: 7,
                  border: `2px solid ${checked ? '#5e4dbb' : '#c9c4d5'}`,
                  background: checked ? '#5e4dbb' : 'transparent',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 150ms', marginTop: 4, flexShrink: 0,
                }}>
                {checked && <Checkmark />}
              </div>

              <textarea
                ref={titleRef}
                value={title}
                onChange={e => { setTitle(e.target.value); resizeTA(e.target); }}
                onBlur={() => { if (title.trim() && title !== task.title) save({ title: title.trim() }); }}
                style={{
                  flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700,
                  color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none',
                  resize: 'none', lineHeight: 1.3, padding: 0, overflowY: 'hidden',
                  textDecoration: checked ? 'line-through' : 'none',
                  opacity: checked ? 0.4 : 1, transition: 'opacity 200ms',
                }}
                rows={1}
              />

              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 2 }}>
                <button
                  onClick={() => setShowDelete(true)}
                  title="Delete task"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#ffdad6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="delete" size={17} color="#ba1a1a" />
                </button>
                <button
                  onClick={onClose}
                  title="Close"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="close" size={18} color="#787584" />
                </button>
              </div>
            </div>

            {/* Properties panel */}
            <div style={{ background: '#faf9ff', borderRadius: 12, marginBottom: 28, border: '1px solid #F0EEF8', overflow: 'hidden' }}>
              <PropRow icon="calendar_today" label="Due date">
                <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                  <button
                    onClick={() => setShowCal(c => !c)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: deadline ? '#F5F3FF' : 'transparent',
                      border: `1px solid ${deadline ? '#c4b5fd' : 'transparent'}`,
                      borderRadius: 8, padding: '5px 10px', cursor: 'pointer', transition: 'all 120ms',
                    }}
                    onMouseEnter={e => { if (!deadline) { (e.currentTarget.style.background = '#F5F3FF'); (e.currentTarget.style.borderColor = '#e2d9f3'); } }}
                    onMouseLeave={e => { if (!deadline) { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.borderColor = 'transparent'); } }}>
                    <Icon name="calendar_today" size={13} color={deadline ? '#5e4dbb' : '#c9c4d5'} />
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: deadline ? '#5e4dbb' : '#c9c4d5', fontWeight: deadline ? 500 : 400 }}>
                      {deadline ? friendlyDate(deadline) : 'No date'}
                    </span>
                  </button>
                  {deadline && (
                    <button
                      onClick={() => { setDeadline(''); setShowCal(false); save({ deadline: undefined }); }}
                      style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 3, display: 'inline-flex', alignItems: 'center' }}>
                      <Icon name="close" size={12} color="#b9b3cb" />
                    </button>
                  )}
                  {showCal && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 1300, animation: 'menuIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
                      <CalendarPicker
                        value={deadline}
                        onChange={d => { setDeadline(d); setShowCal(false); save({ deadline: d || undefined }); }}
                        onClear={() => { setDeadline(''); setShowCal(false); save({ deadline: undefined }); }}
                      />
                    </div>
                  )}
                </div>
              </PropRow>

              <PropRow icon="flag" label="Priority">
                <div style={{ display: 'flex', gap: 6 }}>
                  {PRIORITIES.map(p => (
                    <button key={p}
                      onClick={() => { const next = priority === p ? '' : p; setPriority(next); save({ priority: (next as Task['priority']) || undefined }); }}
                      style={{
                        padding: '4px 12px', borderRadius: 8,
                        border: `1px solid ${priority === p ? PRIORITY_COLORS[p] : '#E5E7EB'}`,
                        background: priority === p ? `${PRIORITY_COLORS[p]}18` : 'transparent',
                        fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600,
                        color: priority === p ? PRIORITY_COLORS[p] : '#787584',
                        cursor: 'pointer', transition: 'all 120ms',
                      }}>
                      {p}
                    </button>
                  ))}
                </div>
              </PropRow>

              <PropRow icon="label" label="Tag" last={!task._listName}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {TAGS.map(t => {
                    const c = BADGE_COLORS[t];
                    const active = tag === t;
                    return (
                      <button key={t}
                        onClick={() => { const next = tag === t ? '' : t; setTag(next); save({ badge: next || undefined }); }}
                        style={{
                          padding: '4px 12px', borderRadius: 9999,
                          border: `1px solid ${active ? c.color : '#E5E7EB'}`,
                          background: active ? c.bg : 'transparent',
                          fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600,
                          color: active ? c.color : '#787584',
                          cursor: 'pointer', transition: 'all 120ms',
                        }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              </PropRow>

              {task._listName && (
                <PropRow icon="format_list_bulleted" label="In list" last>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' }}>{task._listName}</span>
                </PropRow>
              )}
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 28 }}>
              <SectionLabel>Notes</SectionLabel>
              <textarea
                ref={notesRef}
                value={notes}
                onChange={e => { setNotes(e.target.value); resizeTA(e.target); }}
                onBlur={() => { if (notes !== (task.note ?? '')) save({ note: notes || undefined }); }}
                placeholder="Add notes, context, or any details…"
                style={{
                  width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552',
                  background: 'transparent', border: 'none', outline: 'none', resize: 'none',
                  lineHeight: 1.75, padding: 0, overflowY: 'hidden', minHeight: 72,
                }}
                rows={3}
              />
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: '#F0EEF8', marginBottom: 24 }} />

            {/* Sub-items */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <SectionLabel>Sub-items</SectionLabel>
                {subItems.length > 0 && (
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5' }}>
                    {subItems.filter(t => t.checked).length}/{subItems.length}
                  </span>
                )}
                {creatingList && (
                  <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid #5e4dbb', borderTopColor: 'transparent', animation: 'spin 0.6s linear infinite' }} />
                )}
              </div>

              {subItems.map(sub => (
                <div key={sub.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #faf9ff' }}>
                  <div
                    onClick={() => linkedListId && updateListTask(linkedListId, sub.id, { checked: !sub.checked })}
                    style={{
                      width: 18, height: 18, minWidth: 18, borderRadius: 5,
                      border: `1.5px solid ${sub.checked ? '#5e4dbb' : '#c9c4d5'}`,
                      background: sub.checked ? '#5e4dbb' : 'transparent',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 150ms', flexShrink: 0,
                    }}>
                    {sub.checked && <SmallCheck />}
                  </div>
                  <span style={{
                    fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', flex: 1,
                    textDecoration: sub.checked ? 'line-through' : 'none',
                    opacity: sub.checked ? 0.45 : 1,
                  }}>
                    {sub.title}
                  </span>
                </div>
              ))}

              {addingSubItem ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', marginTop: subItems.length > 0 ? 4 : 0 }}>
                  <div style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px dashed #c9c4d5', flexShrink: 0 }} />
                  <input
                    autoFocus
                    value={newSubItem}
                    onChange={e => setNewSubItem(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddSubItem(); }
                      if (e.key === 'Escape') { setAddingSubItem(false); setNewSubItem(''); }
                    }}
                    onBlur={() => { if (!newSubItem.trim()) setAddingSubItem(false); else handleAddSubItem(); }}
                    placeholder="New sub-item…"
                    style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', background: 'transparent', border: 'none', outline: 'none', padding: 0 }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAddingSubItem(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    marginTop: subItems.length > 0 ? 8 : 0,
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
                    opacity: 0.55, transition: 'opacity 150ms',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '0.55')}>
                  <Icon name="add" size={16} color="#5e4dbb" />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5e4dbb' }}>Add sub-item</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showDelete && (
        <DeleteConfirmModal
          task={{ ...task, title }}
          onConfirm={() => { onDelete(task.id); setShowDelete(false); onClose(); }}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </>
  );
}

function PropRow({ icon, label, children, last = false }: { icon: string; label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(229,231,235,0.5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 130, flexShrink: 0 }}>
        <Icon name={icon} size={14} color="#b9b3cb" />
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>{label}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
        {children}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#c9c4d5', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'inline-block' }}>
      {children}
    </div>
  );
}
