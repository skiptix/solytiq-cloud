import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Task } from '../types';
import useAppStore from '../store/useAppStore';
import useAuthStore from '../store/useAuthStore';
import TaskItem, { QuickAdd } from '../components/TaskItem';
import TaskDialog from '../components/TaskDialog';
import { apiAddListTask, apiCreateSection, apiUpdateSection, apiDeleteSection, apiCreateSublistTask, apiLinkListAsTask, apiReorderSectionTasks, apiReorderListSections, apiUpdateListTask } from '../api/client';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';

export default function ListScreen() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { lists, listsLoading, updateList, updateListTask, deleteListTask, addToTrash, setLists } = useAppStore();
  const list = lists.find(l => l.id === listId);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null);
  // Section reordering (distinct from moving a task between sections)
  const [sectionDragId, setSectionDragId] = useState<string | null>(null);
  const [sectionDragOverId, setSectionDragOverId] = useState<string | null>(null);

  // Section management state
  const [hoverSectionId, setHoverSectionId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<{ id: string; label: string; emoji: string } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionLabel, setNewSectionLabel] = useState('');
  const [newSectionEmoji, setNewSectionEmoji] = useState('');
  const newSectionInputRef = useRef<HTMLInputElement>(null);

  if (!list) {
    if (listsLoading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>List not found</div>
          <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Go to Dashboard</button>
        </div>
      </div>
    );
  }

  const isOwner = list.userId === currentUserId;
  const allTasks = list.sections.flatMap(s => s.tasks);
  const totalCount = allTasks.length;
  const completedCount = allTasks.filter(t => t.checked).length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const toggle = (id: number) => {
    const section = list.sections.find(s => s.tasks.some(t => t.id === id));
    if (!section) return;
    const sectionId = section.id;
    const current = section.tasks.find(t => t.id === id);
    if (!current) return;
    const newChecked = !current.checked;

    // Flip the checkbox (optimistic update + API persistence + rollback live in the store).
    updateListTask(listId!, id, { checked: newChecked });

    // Auto-sort: keep unchecked items on top and slide checked ones to the bottom,
    // preserving each group's relative order (stable partition). Persist the order.
    let newOrder: number[] = [];
    setLists(prev => prev.map(l => l.id !== listId ? l : {
      ...l,
      sections: l.sections.map(s => {
        if (s.id !== sectionId) return s;
        const tasks = s.tasks.map(t => t.id === id ? { ...t, checked: newChecked } : t);
        const reordered = [...tasks.filter(t => !t.checked), ...tasks.filter(t => t.checked)];
        newOrder = reordered.map(t => t.id);
        return { ...s, tasks: reordered };
      }),
    }));
    if (newOrder.length > 1) {
      apiReorderSectionTasks(listId!, sectionId, newOrder).catch(e => console.error('auto-sort reorder failed', e));
    }
  };
  const deleteTask = (id: number) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    addToTrash({ ...t, _source: 'list', _listId: listId, _listName: list.name }, { src: 'list', listId: listId, listName: list.name });
    deleteListTask(listId!, id);
  };

  const handleAddTask = async (sectionId: string, data: Partial<Task> & { title: string }) => {
    // Handle sublist creation via /list command
    if (data.linkedListType === 'sublist' && data.linkedListId === '__pending__' && (data as Record<string,unknown>).__sublistName) {
      const sublistName = (data as Record<string,unknown>).__sublistName as string;
      const parentDepth = list.depth ?? 0;
      try {
        const res = await apiCreateSublistTask(listId!, sectionId, data.title, sublistName, parentDepth + 1, list.workspaceId);
        const savedTask: Task = { ...res.task, id: Number(res.task.id) };
        setLists(prev => [
          ...prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, savedTask] }) }),
        ]);
        // Add the new sublist to the store
        if (res.list) {
          setLists(prev => [...prev, { ...res.list, sections: [] }]);
        }
      } catch (e) {
        console.error('createSublistTask failed', e);
      }
      return;
    }

    // Handle link to existing list via /link command
    if (data.linkedListType === 'link' && data.linkedListId) {
      try {
        const res = await apiLinkListAsTask(listId!, sectionId, data.title, data.linkedListId, list.workspaceId);
        const savedTask: Task = { ...res.task, id: Number(res.task.id) };
        setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, savedTask] }) }));
      } catch (e) {
        console.error('linkListAsTask failed', e);
      }
      return;
    }

    const tempId = Date.now();
    const tempTask: Task = { id: tempId, title: data.title, checked: false, deadline: data.deadline, priority: data.priority, badge: data.badge, note: data.note };
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, tempTask] }) }));
    try {
      const res = await apiAddListTask(listId!, sectionId, { ...data, workspaceId: list.workspaceId });
      const savedTask: Task = { ...res.task, id: Number(res.task.id) };
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.map(t => t.id === tempId ? savedTask : t) }) }));
    } catch (e) {
      console.error('addListTask failed', e);
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: s.tasks.filter(t => t.id !== tempId) }) }));
    }
  };

  const handleAddSection = async () => {
    const label = newSectionLabel.trim();
    if (!label) return;
    const sectionId = `section_${Date.now()}`;
    const emoji = newSectionEmoji || undefined;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: [...l.sections, { id: sectionId, label, emoji, tasks: [] }] }));
    setAddingSection(false);
    setNewSectionLabel('');
    setNewSectionEmoji('');
    try {
      await apiCreateSection(listId!, { id: sectionId, label, emoji });
    } catch (e) {
      console.error('createSection failed', e);
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.filter(s => s.id !== sectionId) }));
    }
  };

  const handleUpdateSection = async (sectionId: string, label: string, emoji: string) => {
    const trimmed = label.trim();
    setEditingSection(null);
    if (!trimmed) return;
    const prevList = list;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, label: trimmed, emoji: emoji || undefined }) }));
    // Backend keeps emoji on null but stores '' as-is, so '' clears it for display purposes.
    apiUpdateSection(sectionId, { label: trimmed, emoji }).catch(e => {
      console.error('updateSection failed', e);
      setLists(prev => prev.map(l => l.id !== listId ? l : prevList));
    });
  };

  const handleDeleteSection = async (sectionId: string) => {
    const prevList = list;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.filter(s => s.id !== sectionId) }));
    apiDeleteSection(sectionId).catch(e => {
      console.error('deleteSection failed', e);
      setLists(prev => prev.map(l => l.id !== listId ? l : prevList));
    });
  };

  const handleUpdateTitle = () => {
    const trimmed = newTitle.trim();
    if (trimmed && trimmed !== list.name) {
      updateList(list.id, { name: trimmed });
    }
    setEditingTitle(false);
  };

  const clearDragState = () => {
    setDraggedId(null); setDragOverId(null);
    setDraggedSectionId(null); setDragOverSectionId(null);
    setSectionDragId(null); setSectionDragOverId(null);
  };

  const handleSectionDrop = (targetSectionId: string) => {
    if (!sectionDragId || sectionDragId === targetSectionId) { clearDragState(); return; }
    let newOrder: string[] = [];
    setLists(prev => prev.map(l => {
      if (l.id !== listId) return l;
      const arr = [...l.sections];
      const from = arr.findIndex(s => s.id === sectionDragId);
      const to = arr.findIndex(s => s.id === targetSectionId);
      if (from === -1 || to === -1) return l;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      newOrder = arr.map(s => s.id);
      return { ...l, sections: arr };
    }));
    if (newOrder.length > 0) {
      apiReorderListSections(listId!, newOrder).catch(e => console.error('reorder sections failed', e));
    }
    clearDragState();
  };

  const handleDrop = (targetSectionId: string, targetId: number) => {
    if (!draggedId || !draggedSectionId) return;

    if (draggedSectionId === targetSectionId) {
      // Same section — reorder
      if (draggedId === targetId) { clearDragState(); return; }
      let reorderedIds: number[] = [];
      setLists(prev => prev.map(l => l.id !== listId ? l : {
        ...l,
        sections: l.sections.map(s => {
          if (s.id !== targetSectionId) return s;
          const arr = [...s.tasks];
          const from = arr.findIndex(t => t.id === draggedId);
          const to = arr.findIndex(t => t.id === targetId);
          if (from === -1 || to === -1) return s;
          const [moved] = arr.splice(from, 1);
          arr.splice(to, 0, moved);
          reorderedIds = arr.map(t => t.id);
          return { ...s, tasks: arr };
        }),
      }));
      if (reorderedIds.length > 0) {
        apiReorderSectionTasks(listId!, targetSectionId, reorderedIds).catch(e =>
          console.error('reorder tasks failed', e)
        );
      }
    } else {
      // Cross-section move — remove from source, insert before targetId in destination
      const srcId = draggedSectionId;
      const movedId = draggedId;
      let movedTask: Task | undefined;
      let newTargetIds: number[] = [];
      setLists(prev => prev.map(l => {
        if (l.id !== listId) return l;
        movedTask = l.sections.find(s => s.id === srcId)?.tasks.find(t => t.id === movedId);
        if (!movedTask) return l;
        const captured = movedTask;
        return {
          ...l,
          sections: l.sections.map(s => {
            if (s.id === srcId) return { ...s, tasks: s.tasks.filter(t => t.id !== movedId) };
            if (s.id === targetSectionId) {
              const arr = [...s.tasks];
              const toIdx = arr.findIndex(t => t.id === targetId);
              arr.splice(toIdx === -1 ? arr.length : toIdx, 0, captured);
              newTargetIds = arr.map(t => t.id);
              return { ...s, tasks: arr };
            }
            return s;
          }),
        };
      }));
      if (movedTask) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiUpdateListTask(listId!, movedId, { sectionId: targetSectionId } as any)
          .then(() => { if (newTargetIds.length > 1) apiReorderSectionTasks(listId!, targetSectionId, newTargetIds).catch(() => {}); })
          .catch(e => console.error('move task to section failed', e));
      }
    }
    clearDragState();
  };

  const handleDropOnSection = (targetSectionId: string) => {
    if (!draggedId || !draggedSectionId || draggedSectionId === targetSectionId) { clearDragState(); return; }
    const srcId = draggedSectionId;
    const movedId = draggedId;
    let movedTask: Task | undefined;
    setLists(prev => prev.map(l => {
      if (l.id !== listId) return l;
      movedTask = l.sections.find(s => s.id === srcId)?.tasks.find(t => t.id === movedId);
      if (!movedTask) return l;
      const captured = movedTask;
      return {
        ...l,
        sections: l.sections.map(s => {
          if (s.id === srcId) return { ...s, tasks: s.tasks.filter(t => t.id !== movedId) };
          if (s.id === targetSectionId) return { ...s, tasks: [...s.tasks, captured] };
          return s;
        }),
      };
    }));
    if (movedTask) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apiUpdateListTask(listId!, movedId, { sectionId: targetSectionId } as any).catch(e =>
        console.error('move task to section failed', e)
      );
    }
    clearDragState();
  };

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>

        {/* Hero */}
        <div style={{ background: list.colorBg ?? '#F9FAFB', border: `1px solid ${list.color ?? '#E5E7EB'}40`, borderRadius: 16, padding: '20px 24px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                {list.emoji && <span style={{ fontSize: 24 }}>{list.emoji}</span>}
                {editingTitle ? (
                  <input
                    autoFocus
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onBlur={handleUpdateTitle}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleUpdateTitle();
                      if (e.key === 'Escape') setEditingTitle(false);
                    }}
                    style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', border: 'none', borderBottom: `2px solid ${list.color || '#5e4dbb'}`, outline: 'none', background: 'transparent', padding: '0 0 2px', width: '100%', maxWidth: 400 }}
                  />
                ) : (
                  <h1
                    onClick={() => { if (isOwner) { setEditingTitle(true); setNewTitle(list.name); } }}
                    style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', cursor: isOwner ? 'pointer' : 'default' }}>
                    {list.name}
                  </h1>
                )}
              </div>
              {list.subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginBottom: 6 }}>{list.subtitle}</div>}
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>{completedCount} of {totalCount} done</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 40, fontWeight: 700, color: list.color ?? '#5e4dbb', lineHeight: 1 }}>{pct}%</div>
            </div>
          </div>
          <div style={{ marginTop: 14, height: 6, background: 'rgba(0,0,0,0.08)', borderRadius: 9999, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#10B981' : (list.color ?? '#5e4dbb'), borderRadius: 9999, transition: 'width 600ms ease-in-out' }} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}><strong style={{ color: '#1c1b22' }}>{completedCount}</strong> completed</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}><strong style={{ color: '#1c1b22' }}>{totalCount - completedCount}</strong> remaining</div>
          </div>
        </div>

        {/* Sections */}
        {list.sections.map(section => {
          const isSectionDropTarget = dragOverSectionId === section.id && draggedSectionId !== null && draggedSectionId !== section.id;
          const isSectionReorderTarget = sectionDragOverId === section.id && sectionDragId !== null && sectionDragId !== section.id;
          const isBeingDraggedSection = sectionDragId === section.id;
          return (
          <div
            key={section.id}
            style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              opacity: isBeingDraggedSection ? 0.4 : 1,
              borderTop: isSectionReorderTarget ? '2px solid #9d8dff' : '2px solid transparent',
              borderRadius: isSectionReorderTarget ? 4 : 0,
              transition: 'opacity 150ms, border-color 120ms',
            }}
            onDragOver={e => {
              if (sectionDragId && sectionDragId !== section.id) { e.preventDefault(); setSectionDragOverId(section.id); return; }
              if (draggedId && draggedSectionId !== section.id) { e.preventDefault(); setDragOverSectionId(section.id); }
            }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDragOverSectionId(null); setSectionDragOverId(null); } }}
            onDrop={e => { e.preventDefault(); if (sectionDragId) handleSectionDrop(section.id); else handleDropOnSection(section.id); }}
          >
            {/* Section header */}
            <div
              onMouseEnter={() => setHoverSectionId(section.id)}
              onMouseLeave={() => { setHoverSectionId(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
              {isOwner && (
                <button
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setSectionDragId(section.id); }}
                  onDragEnd={clearDragState}
                  title="Drag to reorder section"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0,
                    border: 'none', background: 'transparent', cursor: 'grab', padding: 0, marginLeft: -4,
                    opacity: hoverSectionId === section.id ? 1 : 0,
                    pointerEvents: hoverSectionId === section.id ? 'auto' : 'none',
                    transition: 'opacity 180ms ease',
                  }}>
                  <Icon name="drag_indicator" size={15} color="#c9c4d5" />
                </button>
              )}
              {section.emoji && editingSection?.id !== section.id && <span key={section.emoji} style={{ fontSize: 14, animation: 'modalIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>{section.emoji}</span>}

              {editingSection?.id === section.id ? (
                /* Inline edit — label + emoji */
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, animation: 'menuItemIn 160ms ease both' }}>
                  <EmojiSelector
                    value={editingSection.emoji}
                    onChange={em => setEditingSection(s => s ? { ...s, emoji: em } : null)}
                    direction="down"
                    size={26}
                  />
                  <input
                    autoFocus
                    value={editingSection.label}
                    onChange={e => setEditingSection(s => s ? { ...s, label: e.target.value } : null)}
                    onBlur={() => handleUpdateSection(section.id, editingSection.label, editingSection.emoji)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleUpdateSection(section.id, editingSection.label, editingSection.emoji);
                      if (e.key === 'Escape') setEditingSection(null);
                    }}
                    style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5e5e5e', border: 'none', borderBottom: '1.5px solid #5e4dbb', outline: 'none', background: 'transparent', padding: '0 2px 1px', minWidth: 80 }}
                  />
                  <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
                </div>
              ) : (
                /* Normal label */
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5e5e5e' }}>{section.label}</span>
                  <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
                </div>
              )}

              {/* Edit / Delete icons — fade + slide in on hover */}
              {(() => {
                const visible = hoverSectionId === section.id && editingSection?.id !== section.id;
                return (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'translateX(0)' : 'translateX(6px)',
                    pointerEvents: visible ? 'auto' : 'none',
                    transition: 'opacity 180ms ease, transform 180ms ease',
                  }}>
                    <button
                      onClick={() => setEditingSection({ id: section.id, label: section.label, emoji: section.emoji ?? '' })}
                      title="Edit section"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', transition: 'background 120ms' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Icon name="edit" size={13} color="#9d8dff" />
                    </button>
                    <button
                      onClick={() => handleDeleteSection(section.id)}
                      title="Delete section"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', transition: 'background 120ms' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#ffeaea')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Icon name="delete" size={13} color="#ba1a1a" />
                    </button>
                  </div>
                );
              })()}
            </div>

            {/* Tasks */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 2, background: '#F9FAFB', borderRadius: 12,
              border: isSectionDropTarget ? '1.5px solid #9d8dff' : '1px solid #E5E7EB',
              overflow: 'hidden', transition: 'border-color 120ms',
              boxShadow: isSectionDropTarget ? '0 0 0 3px rgba(157,141,255,0.15)' : 'none',
            }}>
              {section.tasks.length === 0 ? (
                <div style={{ padding: '16px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: isSectionDropTarget ? '#9d8dff' : '#b0acbe', textAlign: 'center', transition: 'color 120ms' }}>
                  {isSectionDropTarget ? 'Drop here to move' : 'No tasks in this section.'}
                </div>
              ) : (
                <div style={{ padding: '4px' }}>
                  {section.tasks.map(task => {
                    const enrichedTask = { ...task, _source: 'list' as const, _listId: listId, _listName: list.name };
                    return (
                      <TaskItem key={task.id} task={enrichedTask}
                        onToggle={toggle} onDelete={deleteTask}
                        onUpdate={(id, upd) => updateListTask(listId!, id, upd)}
                        onRowClick={t => setSelectedTask(t)}
                        onDragStart={id => { setDraggedId(id); setDraggedSectionId(section.id); }}
                        onDragOver={id => setDragOverId(id)}
                        onDrop={id => handleDrop(section.id, id)}
                        onDragEnd={clearDragState}
                        isDragging={draggedId === task.id}
                        isDragOver={dragOverId === task.id && draggedId !== task.id}
                        hideListBadge
                        availableLists={lists}
                        currentListId={listId} />
                    );
                  })}
                </div>
              )}
              <div style={{ borderTop: section.tasks.length > 0 ? '1px solid #f1ecf6' : 'none' }}>
                <QuickAdd placeholder="Add new item… (type / for commands)" onAdd={data => handleAddTask(section.id, data)} availableLists={lists} currentListId={listId} />
              </div>
            </div>
          </div>
          );
        })}

        {list.sections.length === 0 && !addingSection && (
          <div style={{ textAlign: 'center', padding: '32px 16px 8px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
            No sections yet. Add one below.
          </div>
        )}

        {/* Add Section — full-width at bottom */}
        {addingSection ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative', animation: 'sectionFadeUp 220ms ease both' }}>
            {/* Emoji selector */}
            <EmojiSelector value={newSectionEmoji} onChange={setNewSectionEmoji} direction="up" />
            <input
              ref={newSectionInputRef}
              autoFocus
              value={newSectionLabel}
              onChange={e => setNewSectionLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddSection(); if (e.key === 'Escape') { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); } }}
              placeholder="Section name…"
              style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #5e4dbb', borderRadius: 8, padding: '7px 12px', outline: 'none', color: '#1c1b22', background: '#fff' }}
            />
            <button onClick={handleAddSection} disabled={!newSectionLabel.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#fff', background: newSectionLabel.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: newSectionLabel.trim() ? 'pointer' : 'default' }}>
              Add
            </button>
            <button onClick={() => { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); }}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 500, color: '#787584', background: 'transparent', border: '1px solid #e8e4f0', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setAddingSection(true)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#787584', background: '#f1f0f4', border: '1.5px dashed #d4cfe8', borderRadius: 10, padding: '11px', cursor: 'pointer', width: '100%', transition: 'all 150ms' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#ebe6f5'; e.currentTarget.style.color = '#5e4dbb'; e.currentTarget.style.borderColor = '#9d8dff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#f1f0f4'; e.currentTarget.style.color = '#787584'; e.currentTarget.style.borderColor = '#d4cfe8'; }}>
            <Icon name="add" size={15} color="inherit" />
            Add section
          </button>
        )}
      </div>

      {selectedTask && (
        <TaskDialog
          task={selectedTask}
          onUpdate={(id, upd) => updateListTask(listId!, id, upd)}
          onDelete={deleteTask}
          onClose={() => setSelectedTask(null)}
        />
      )}

    </div>
  );
}
