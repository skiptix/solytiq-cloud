import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Task } from '../types';
import useAppStore from '../store/useAppStore';
import TaskItem, { QuickAdd, EditModal } from '../components/TaskItem';
import TaskDetailPopup from '../components/TaskDetailPopup';
import { apiAddListTask } from '../api/client';
import Icon from '../components/Icon';

export default function ListScreen() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { lists, updateListTask, deleteListTask, addToTrash, setLists } = useAppStore();
  const list = lists.find(l => l.id === listId);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<{ x: number; y: number } | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

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
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                {list.emoji && <span style={{ fontSize: 24 }}>{list.emoji}</span>}
                <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em' }}>{list.name}</h1>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
              {section.emoji && <span style={{ fontSize: 14 }}>{section.emoji}</span>}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5e5e5e' }}>{section.label}</span>
                <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
              </div>
            </div>
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

        {list.sections.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 16px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>
            No sections yet. <Icon name="add_circle" size={14} color="#9d8dff" /> Add a section via the sidebar.
          </div>
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
