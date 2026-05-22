import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Task } from '../types';
import useAppStore from '../store/useAppStore';
import useAuthStore from '../store/useAuthStore';
import TaskItem, { QuickAdd, EditModal } from '../components/TaskItem';
import TaskDetailPopup from '../components/TaskDetailPopup';
import { apiAddListTask, apiCreateSection, apiUpdateSection, apiDeleteSection } from '../api/client';
import Icon from '../components/Icon';

export default function ListScreen() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { lists, updateList, updateListTask, deleteListTask, addToTrash, setLists } = useAppStore();
  const list = lists.find(l => l.id === listId);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<{ x: number; y: number } | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  // Section management state
  const [hoverSectionId, setHoverSectionId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<{ id: string; label: string } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionLabel, setNewSectionLabel] = useState('');
  const newSectionInputRef = useRef<HTMLInputElement>(null);

  if (!list) {
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

  const toggle = (id: number) => updateListTask(listId!, id, { checked: !allTasks.find(t => t.id === id)?.checked });
  const deleteTask = (id: number) => {
    const t = allTasks.find(t => t.id === id);
    if (!t) return;
    addToTrash({ ...t, _source: 'list', _listId: listId, _listName: list.name }, { src: 'list', listId: listId, listName: list.name });
    deleteListTask(listId!, id);
  };

  const handleAddTask = async (sectionId: string, data: Partial<Task> & { title: string }) => {
    const tempId = Date.now();
    const tempTask: Task = { id: tempId, title: data.title, checked: false, deadline: data.deadline, priority: data.priority, badge: data.badge, note: data.note };
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, tasks: [...s.tasks, tempTask] }) }));
    try {
      const res = await apiAddListTask(listId!, sectionId, data);
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
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: [...l.sections, { id: sectionId, label, tasks: [] }] }));
    setAddingSection(false);
    setNewSectionLabel('');
    try {
      await apiCreateSection(listId!, { id: sectionId, label });
    } catch (e) {
      console.error('createSection failed', e);
      setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.filter(s => s.id !== sectionId) }));
    }
  };

  const handleUpdateSection = async (sectionId: string, label: string) => {
    const trimmed = label.trim();
    setEditingSection(null);
    if (!trimmed) return;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.map(s => s.id !== sectionId ? s : { ...s, label: trimmed }) }));
    apiUpdateSection(sectionId, { label: trimmed }).catch(e => console.error('updateSection failed', e));
  };

  const handleDeleteSection = async (sectionId: string) => {
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, sections: l.sections.filter(s => s.id !== sectionId) }));
    apiDeleteSection(sectionId).catch(e => console.error('deleteSection failed', e));
  };

  const handleUpdateTitle = () => {
    const trimmed = newTitle.trim();
    if (trimmed && trimmed !== list.name) {
      updateList(list.id, { name: trimmed });
    }
    setEditingTitle(false);
  };

  const handleDrop = (sectionId: string, targetId: number) => {
    if (!draggedId || draggedId === targetId) return;
    setLists(prev => prev.map(l => l.id !== listId ? l : {
      ...l,
      sections: l.sections.map(s => {
        if (s.id !== sectionId) return s;
        const arr = [...s.tasks];
        const from = arr.findIndex(t => t.id === draggedId);
        const to = arr.findIndex(t => t.id === targetId);
        if (from === -1 || to === -1) return s;
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        return { ...s, tasks: arr };
      }),
    }));
    setDraggedId(null); setDragOverId(null);
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
        {list.sections.map(section => (
          <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Section header */}
            <div
              onMouseEnter={() => setHoverSectionId(section.id)}
              onMouseLeave={() => { setHoverSectionId(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
              {section.emoji && <span style={{ fontSize: 14 }}>{section.emoji}</span>}

              {editingSection?.id === section.id ? (
                /* Inline edit */
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    autoFocus
                    value={editingSection.label}
                    onChange={e => setEditingSection(s => s ? { ...s, label: e.target.value } : null)}
                    onBlur={() => handleUpdateSection(section.id, editingSection.label)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleUpdateSection(section.id, editingSection.label);
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
                      onClick={() => setEditingSection({ id: section.id, label: section.label })}
                      title="Rename section"
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, background: '#F9FAFB', borderRadius: 12, border: '1px solid #E5E7EB', overflow: 'hidden' }}>
              {section.tasks.length === 0 ? (
                <div style={{ padding: '16px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center' }}>No tasks in this section.</div>
              ) : (
                <div style={{ padding: '4px' }}>
                  {section.tasks.map(task => {
                    const enrichedTask = { ...task, _source: 'list' as const, _listId: listId, _listName: list.name };
                    return (
                      <TaskItem key={task.id} task={enrichedTask}
                        onToggle={toggle} onDelete={deleteTask}
                        onUpdate={(id, upd) => updateListTask(listId!, id, upd)}
                        onRowClick={(t, e) => { setSelectedTask(t); setSelectedAnchor({ x: e.clientX, y: e.clientY }); }}
                        onDragStart={id => setDraggedId(id)}
                        onDragOver={id => setDragOverId(id)}
                        onDrop={id => handleDrop(section.id, id)}
                        onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                        isDragging={draggedId === task.id}
                        isDragOver={dragOverId === task.id && draggedId !== task.id} />
                    );
                  })}
                </div>
              )}
              <div style={{ borderTop: section.tasks.length > 0 ? '1px solid #f1ecf6' : 'none' }}>
                <QuickAdd placeholder="Add new item…" onAdd={data => handleAddTask(section.id, data)} />
              </div>
            </div>
          </div>
        ))}

        {list.sections.length === 0 && !addingSection && (
          <div style={{ textAlign: 'center', padding: '32px 16px 8px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
            No sections yet. Add one below.
          </div>
        )}

        {/* Add Section — full-width at bottom */}
        {addingSection ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              ref={newSectionInputRef}
              autoFocus
              value={newSectionLabel}
              onChange={e => setNewSectionLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddSection(); if (e.key === 'Escape') { setAddingSection(false); setNewSectionLabel(''); } }}
              placeholder="Section name…"
              style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #5e4dbb', borderRadius: 8, padding: '7px 12px', outline: 'none', color: '#1c1b22', background: '#fff' }}
            />
            <button onClick={handleAddSection} disabled={!newSectionLabel.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#fff', background: newSectionLabel.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: newSectionLabel.trim() ? 'pointer' : 'default' }}>
              Add
            </button>
            <button onClick={() => { setAddingSection(false); setNewSectionLabel(''); }}
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
        <TaskDetailPopup task={selectedTask} anchor={selectedAnchor}
          onEdit={t => { setSelectedTask(null); setEditingTask(t); }}
          onGoToList={() => {}}
          onClose={() => setSelectedTask(null)} />
      )}
      {editingTask && (
        <EditModal task={editingTask} onSave={upd => { updateListTask(listId!, editingTask.id, upd); setEditingTask(null); }} onClose={() => setEditingTask(null)} />
      )}

    </div>
  );
}
