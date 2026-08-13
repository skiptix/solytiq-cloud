import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useRef, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, EASE_STANDARD, LAYOUT_TRANSITION, listItemVariants } from '@/components/animate-ui/motionTokens';
import { useMobile } from '../hooks/useBreakpoint';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useParams, useNavigate } from 'react-router-dom';
import type { Task } from '../types';
import useAppStore from '../store/useAppStore';
import useSharedItemsStore from '../store/useSharedItemsStore';
import useAuthStore from '../store/useAuthStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import TaskItem, { QuickAdd } from '../components/TaskItem';
import TaskDialog from '../components/TaskDialog';
import TaskTimelineView from '../components/TaskTimelineView';
import { apiAddListTask, apiCreateSection, apiUpdateSection, apiDeleteSection, apiCreateSublistTask, apiLinkListAsTask, apiReorderSectionTasks, apiReorderListSections, apiUpdateListTask } from '../api/client';
import Icon from '../components/Icon';
import SaveStatusDot from '../components/SaveStatusDot';
import EmojiSelector from '../components/EmojiSelector';
import AutomationsButton from '../components/AutomationsButton';
import Spinner from '@/components/animate-ui/Spinner';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import MotionDraggable from '../components/animate-ui/MotionDraggable';

// ── Pull-to-refresh indicator (mobile only) ────────────────────────
// Purely presentational: height/opacity/rotation driven by usePullToRefresh's
// live pull distance. Matches the app's existing circular-spinner language for
// the "refreshing" state; a rotating arrow gives the "pull further" affordance
// before that, the same way native pull-to-refresh does.
function PullToRefreshIndicator({ pullDistance, threshold, refreshing, settling }: { pullDistance: number; threshold: number; refreshing: boolean; settling: boolean }) {
  const height = refreshing ? threshold : pullDistance;
  if (height <= 0 && !settling) return null;
  const progress = Math.min(1, pullDistance / threshold);
  const pastThreshold = pullDistance >= threshold;
  return (
    <MotionIn animate={{ height }} // While the finger is dragging, height follows the pointer with no tween;
    // it only eases once the gesture is released (refreshing/settling).
    transition={(refreshing || settling) ? { duration: 0.2, ease: 'easeInOut' } : { duration: 0 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      {refreshing ? (
        <Spinner size={22} thickness={2.5} durationMs={600} />
      ) : (
        <MotionIn transition={{ duration: 0.12 }} style={{ opacity: 0.4 + progress * 0.6, transform: `rotate(${pastThreshold ? 180 : 0}deg) scale(${0.7 + progress * 0.3})`, }}>
          <Icon name="arrow_downward" size={20} color="var(--color-primary)" />
        </MotionIn>
      )}
    </MotionIn>
  );
}

export default function ListScreen() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { lists, listsLoading, updateList, updateListTask, deleteListTask, addToTrash, setLists, loadFromApi } = useAppStore();
  const sharedLists = useSharedItemsStore(s => s.lists);
  // Fall back to a list shared with me (from another workspace) when it isn't in
  // the active workspace's data.
  const list = lists.find(l => l.id === listId) ?? sharedLists.find(l => l.id === listId);
  const isMobile = useMobile();

  // Pull-down-to-refresh (mobile only) — re-pulls this workspace's tasks/lists;
  // the live SSE sync keeps things current already, but a manual refresh is
  // still the expected mobile gesture (and recovers a dropped connection).
  const handleRefresh = useCallback(async () => {
    await loadFromApi(useWorkspaceStore.getState().currentWorkspaceId ?? undefined);
  }, [loadFromApi]);
  const { containerRef: scrollRef, pullDistance, refreshing, settling: pullSettling, threshold: pullThreshold } = usePullToRefresh({ onRefresh: handleRefresh, disabled: !isMobile });

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

  // "New item" shortcut — focuses the first section's quick-add field.
  useEffect(() => {
    const onCreateItem = () => {
      document.querySelector<HTMLInputElement>('[data-quickadd-root] input')?.focus();
    };
    window.addEventListener('shortcut:create-item', onCreateItem);
    return () => window.removeEventListener('shortcut:create-item', onCreateItem);
  }, []);

  const isOwner = list?.userId === currentUserId;
  const allTasks = list ? list.sections.flatMap(s => s.tasks) : [];
  const totalCount = allTasks.length;
  const completedCount = allTasks.filter(t => t.checked).length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const viewMode: 'list' | 'kanban' | 'timeline' =
    list?.viewMode === 'kanban' || list?.viewMode === 'timeline' ? list.viewMode : 'list';
  // Kanban's side-scrolling columns don't work on a mobile-width screen — a
  // list whose stored view_mode is 'kanban' (set on desktop, shared across
  // devices) renders as List here instead, without touching the stored value
  // so desktop still sees Kanban next time.
  const effectiveViewMode: 'list' | 'kanban' | 'timeline' = isMobile && viewMode === 'kanban' ? 'list' : viewMode;
  const setViewMode = useCallback((v: 'list' | 'kanban' | 'timeline') => {
    if (list && v !== viewMode) updateList(list.id, { viewMode: v });
  }, [list, viewMode, updateList]);

  // "1" / "2" / "3" shortcuts — switch between List / Kanban / Timeline view.
  useEffect(() => {
    const onList = () => setViewMode('list');
    const onKanban = () => setViewMode('kanban');
    const onTimeline = () => setViewMode('timeline');
    window.addEventListener('shortcut:view-list', onList);
    window.addEventListener('shortcut:view-kanban', onKanban);
    window.addEventListener('shortcut:view-timeline', onTimeline);
    return () => {
      window.removeEventListener('shortcut:view-list', onList);
      window.removeEventListener('shortcut:view-kanban', onKanban);
      window.removeEventListener('shortcut:view-timeline', onTimeline);
    };
  }, [setViewMode]);

  // "r" shortcut — the desktop equivalent of the mobile pull-to-refresh gesture.
  useEffect(() => {
    const onRefreshShortcut = () => { void handleRefresh(); };
    window.addEventListener('shortcut:refresh-board', onRefreshShortcut);
    return () => window.removeEventListener('shortcut:refresh-board', onRefreshShortcut);
  }, [handleRefresh]);

  let pageTitle = 'Loading board...';
  if (!list && !listsLoading) {
    pageTitle = 'Board not found';
  } else if (list) {
    const openTasks = totalCount - completedCount;
    const taskBadge = openTasks > 0 ? `(${openTasks})` : '(Done)';
    const prefix = list.emoji ? `${list.emoji} ` : '';
    pageTitle = `${prefix}${list.name} ${taskBadge}`;
  }
  usePageTitle(pageTitle);

  if (!list) {
    if (listsLoading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={32} thickness={3} durationMs={700} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Board not found</div>
          <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Go to Dashboard</button>
        </div>
      </div>
    );
  }

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
    <div ref={scrollRef} style={{ flex: 1, height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      {isMobile && <PullToRefreshIndicator pullDistance={pullDistance} threshold={pullThreshold} refreshing={refreshing} settling={pullSettling} />}
      <div style={{ maxWidth: effectiveViewMode === 'list' ? 680 : 1400, margin: '0 auto', padding: isMobile ? '16px 12px 48px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>

        {/* View switcher (top-left) + Automations entry point (top-right) —
            Kanban's side-scrolling columns aren't offered on mobile at all. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', background: 'var(--color-surface-tint)', borderRadius: 10, padding: 3, gap: 2, flexWrap: 'wrap', maxWidth: '100%' }}>
            {(['list', 'kanban', 'timeline'] as const).filter(v => !(isMobile && v === 'kanban')).map(v => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 6,
                  fontFamily: 'var(--font-heading)', fontSize: isMobile ? 11.5 : 12.5, fontWeight: 600,
                  color: effectiveViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                  background: effectiveViewMode === v ? 'var(--color-white)' : 'transparent',
                  boxShadow: effectiveViewMode === v ? '0 1px 4px rgba(var(--color-primary-rgb), 0.18)' : 'none',
                  border: 'none', borderRadius: 8, padding: isMobile ? '6px 9px' : '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}>
                <Icon name={v === 'list' ? 'format_list_bulleted' : v === 'kanban' ? 'view_kanban' : 'view_timeline'} size={15} color={effectiveViewMode === v ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                {v === 'list' ? 'List' : v === 'kanban' ? 'Kanban' : 'Timeline'}
              </button>
            ))}
          </div>
          {list && <AutomationsButton ownerType="list" ownerId={list.id} isMobile={isMobile} />}
        </div>

        {/* Hero */}
        <div style={{ background: list.colorBg ?? 'var(--color-surface-gray)', border: `1px solid ${list.color ?? 'var(--color-border-alt)'}40`, borderRadius: 16, padding: '20px 24px', position: 'relative', overflow: 'hidden' }}>
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
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', border: 'none', borderBottom: `2px solid ${list.color || 'var(--color-primary)'}`, outline: 'none', background: 'transparent', padding: '0 0 2px', width: '100%', maxWidth: isMobile ? '100%' : 400 }}
                  />
                ) : (
                  <h1
                    onClick={() => { if (isOwner) { setEditingTitle(true); setNewTitle(list.name); } }}
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', cursor: isOwner ? 'pointer' : 'default' }}>
                    {list.name}
                  </h1>
                )}
                <SaveStatusDot />
              </div>
              {list.subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>{list.subtitle}</div>}
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{completedCount} of {totalCount} done</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 40, fontWeight: 700, color: list.color ?? 'var(--color-primary)', lineHeight: 1 }}>{pct}%</div>
            </div>
          </div>
          <div style={{ marginTop: 14, height: 6, background: 'rgba(var(--color-black-rgb), 0.08)', borderRadius: 9999, overflow: 'hidden' }}>
            <MotionIn transition={{ duration: 0.6 }} style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--color-success)' : (list.color ?? 'var(--color-primary)'), borderRadius: 9999, }} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}><strong style={{ color: 'var(--color-text-primary)' }}>{completedCount}</strong> completed</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)' }}><strong style={{ color: 'var(--color-text-primary)' }}>{totalCount - completedCount}</strong> remaining</div>
          </div>
        </div>

        {/* Sections — List view (stacked) */}
        {effectiveViewMode === 'list' && <MotionIn key="view-list" style={{ display: 'flex', flexDirection: 'column', gap: 24 }} initial={{ opacity: 0, y: 8, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
        {list.sections.map(section => {
          const isSectionDropTarget = dragOverSectionId === section.id && draggedSectionId !== null && draggedSectionId !== section.id;
          const isSectionReorderTarget = sectionDragOverId === section.id && sectionDragId !== null && sectionDragId !== section.id;
          const isBeingDraggedSection = sectionDragId === section.id;
          return (
          <motion.div
            key={section.id}
            layout="position"
            animate={{
              opacity: isBeingDraggedSection ? 0.4 : 1,
              borderTopColor: isSectionReorderTarget ? 'var(--color-accent-purple-light)' : 'transparent',
              borderRadius: isSectionReorderTarget ? 4 : 0,
            }}
            transition={{ ...LAYOUT_TRANSITION, opacity: { duration: 0.15 }, borderTopColor: { duration: 0.12 } }}
            style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              borderTopWidth: 2, borderTopStyle: 'solid',
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
                <MotionDraggable
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setSectionDragId(section.id); }}
                  onDragEnd={clearDragState}
                  title="Drag to reorder section"
                  transition={{ duration: 0.18 }} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0,
                    border: 'none', background: 'transparent', cursor: 'grab', padding: 0, marginLeft: -4,
                    opacity: hoverSectionId === section.id ? 1 : 0,
                    pointerEvents: hoverSectionId === section.id ? 'auto' : 'none',
                  }}>
                  <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
                </MotionDraggable>
              )}
              {section.emoji && editingSection?.id !== section.id && (
                <motion.span
                  key={section.emoji}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2, ease: EASE_SPRING }}
                  style={{ fontSize: 14 }}
                >
                  {section.emoji}
                </motion.span>
              )}

              {editingSection?.id === section.id ? (
                /* Inline edit — label + emoji */
                <MotionIn style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16, ease: EASE_STANDARD }}>
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
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-gray-deep-1)', border: 'none', borderBottom: '1.5px solid var(--color-primary)', outline: 'none', background: 'transparent', padding: '0 2px 1px', minWidth: 80 }}
                  />
                  <div style={{ flex: 1, height: 1, background: 'var(--color-border-alt)' }} />
                </MotionIn>
              ) : (
                /* Normal label */
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-gray-deep-1)' }}>{section.label}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--color-border-alt)' }} />
                </div>
              )}

              {/* Edit / Delete icons — fade + slide in on hover */}
              {(() => {
                const visible = hoverSectionId === section.id && editingSection?.id !== section.id;
                return (
                  <MotionIn transition={{ duration: 0.18 }} style={{
                    display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                    opacity: visible ? 1 : 0,
                    transform: visible ? 'translateX(0)' : 'translateX(6px)',
                    pointerEvents: visible ? 'auto' : 'none',
                  }}>
                    <MotionButton
                      onClick={() => setEditingSection({ id: section.id, label: section.label, emoji: section.emoji ?? '' })}
                      title="Edit section"
                      transition={{ duration: 0.12 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-purple-pale-39)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Icon name="edit" size={13} color="var(--color-accent-purple-light)" />
                    </MotionButton>
                    <MotionButton
                      onClick={() => handleDeleteSection(section.id)}
                      title="Delete section"
                      transition={{ duration: 0.12 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-red-pale-6)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Icon name="delete" size={13} color="var(--color-error)" />
                    </MotionButton>
                  </MotionIn>
                );
              })()}
            </div>

            {/* Tasks */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--color-surface-gray)', borderRadius: 12,
              border: isSectionDropTarget ? '1.5px solid var(--color-accent-purple-light)' : '1px solid var(--color-border-alt)',
              overflow: 'hidden',
              boxShadow: isSectionDropTarget ? '0 0 0 3px rgba(var(--color-accent-purple-light-rgb), 0.15)' : 'none',
            }}>
              {section.tasks.length === 0 ? (
                <MotionIn transition={{ duration: 0.12 }} style={{ padding: '16px', fontFamily: 'var(--font-body)', fontSize: 13, color: isSectionDropTarget ? 'var(--color-accent-purple-light)' : 'var(--color-text-quaternary)', textAlign: 'center', }}>
                  {isSectionDropTarget ? 'Drop here to move' : 'No tasks in this section.'}
                </MotionIn>
              ) : (
                <div style={{ padding: '4px' }}>
                  <AnimatePresence initial={false}>
                  {section.tasks.map(task => {
                    const enrichedTask = { ...task, _source: 'list' as const, _listId: listId, _listName: list.name };
                    return (
                      <motion.div key={task.id} layout="position" variants={listItemVariants} initial="initial" animate="animate" exit="exit" transition={LAYOUT_TRANSITION}>
                        <TaskItem task={enrichedTask}
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
                      </motion.div>
                    );
                  })}
                  </AnimatePresence>
                </div>
              )}
              <div data-quickadd-root style={{ borderTop: section.tasks.length > 0 ? '1px solid var(--color-surface-tint-2)' : 'none' }}>
                <QuickAdd placeholder="Add new item… (type / for commands)" onAdd={data => handleAddTask(section.id, data)} availableLists={lists} currentListId={listId} />
              </div>
            </div>
          </motion.div>
          );
        })}

        {list.sections.length === 0 && !addingSection && (
          <div style={{ textAlign: 'center', padding: '32px 16px 8px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>
            No sections yet. Add one below.
          </div>
        )}

        {/* Add Section — full-width at bottom */}
        {addingSection ? (
          <MotionIn style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
            {/* Emoji selector */}
            <EmojiSelector value={newSectionEmoji} onChange={setNewSectionEmoji} direction="up" />
            <input
              ref={newSectionInputRef}
              autoFocus
              value={newSectionLabel}
              onChange={e => setNewSectionLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddSection(); if (e.key === 'Escape') { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); } }}
              placeholder="Section name…"
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-primary)', borderRadius: 8, padding: '7px 12px', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-white)' }}
            />
            <button onClick={handleAddSection} disabled={!newSectionLabel.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-white)', background: newSectionLabel.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: newSectionLabel.trim() ? 'pointer' : 'default' }}>
              Add
            </button>
            <button onClick={() => { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); }}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-tertiary)', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
          </MotionIn>
        ) : (
          <MotionButton onClick={() => setAddingSection(true)}
            transition={{ duration: 0.15 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-purple-pale-28)', border: '1.5px dashed var(--color-purple-tint-6)', borderRadius: 10, padding: '11px', cursor: 'pointer', width: '100%', }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-pale-35)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-light)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-purple-pale-28)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.borderColor = 'var(--color-purple-tint-6)'; }}>
            <Icon name="add" size={15} color="inherit" />
            Add section
          </MotionButton>
        )}
        </MotionIn>}

        {/* Sections — Kanban view (columns) */}
        {effectiveViewMode === 'kanban' && (
          <MotionIn key="view-kanban" style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 12, alignItems: 'flex-start' }} initial={{ opacity: 0, y: 8, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
            {list.sections.map((section, idx) => {
              const isSectionDropTarget = dragOverSectionId === section.id && draggedSectionId !== null && draggedSectionId !== section.id;
              const isSectionReorderTarget = sectionDragOverId === section.id && sectionDragId !== null && sectionDragId !== section.id;
              const isBeingDraggedSection = sectionDragId === section.id;
              return (
                <motion.div
                  key={section.id}
                  layout="position"
                  initial={{ opacity: 0, y: 12, scale: 0.96 }}
                  animate={{
                    opacity: isBeingDraggedSection ? 0.4 : 1,
                    y: 0,
                    scale: 1,
                    borderLeftColor: isSectionReorderTarget ? 'var(--color-accent-purple-light)' : 'transparent',
                    borderRadius: isSectionReorderTarget ? 4 : 0,
                  }}
                  transition={{
                    ...LAYOUT_TRANSITION,
                    // The staggered `cardIn` entrance and the live drag/drop
                    // feedback share this element, so they share one transition
                    // object with per-property overrides rather than fighting
                    // over a single duration.
                    opacity: { duration: 0.15 },
                    borderLeftColor: { duration: 0.12 },
                    y: { duration: 0.24, delay: (idx * 40) / 1000, ease: EASE_SETTLE },
                    scale: { duration: 0.24, delay: (idx * 40) / 1000, ease: EASE_SETTLE },
                  }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 8, width: 280, flexShrink: 0,
                    borderLeftWidth: 2, borderLeftStyle: 'solid',
                  }}
                  onDragOver={e => {
                    if (sectionDragId && sectionDragId !== section.id) { e.preventDefault(); setSectionDragOverId(section.id); return; }
                    if (draggedId && draggedSectionId !== section.id) { e.preventDefault(); setDragOverSectionId(section.id); }
                  }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDragOverSectionId(null); setSectionDragOverId(null); } }}
                  onDrop={e => { e.preventDefault(); if (sectionDragId) handleSectionDrop(section.id); else handleDropOnSection(section.id); }}
                >
                  {/* Column header */}
                  <div
                    onMouseEnter={() => setHoverSectionId(section.id)}
                    onMouseLeave={() => setHoverSectionId(null)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
                    {isOwner && (
                      <MotionDraggable
                        draggable
                        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setSectionDragId(section.id); }}
                        onDragEnd={clearDragState}
                        title="Drag to reorder column"
                        transition={{ duration: 0.18 }} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0,
                          border: 'none', background: 'transparent', cursor: 'grab', padding: 0, marginLeft: -4,
                          opacity: hoverSectionId === section.id ? 1 : 0,
                          pointerEvents: hoverSectionId === section.id ? 'auto' : 'none',
                        }}>
                        <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
                      </MotionDraggable>
                    )}
                    {section.emoji && editingSection?.id !== section.id && <span style={{ fontSize: 14 }}>{section.emoji}</span>}

                    {editingSection?.id === section.id ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
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
                          style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-gray-deep-1)', border: 'none', borderBottom: '1.5px solid var(--color-primary)', outline: 'none', background: 'transparent', padding: '0 2px 1px', minWidth: 80 }}
                        />
                      </div>
                    ) : (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-gray-deep-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.label}</span>
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', flexShrink: 0 }}>{section.tasks.length}</span>
                      </div>
                    )}

                    {(() => {
                      const visible = hoverSectionId === section.id && editingSection?.id !== section.id;
                      return (
                        <MotionIn transition={{ duration: 0.18 }} style={{
                          display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                          opacity: visible ? 1 : 0,
                          pointerEvents: visible ? 'auto' : 'none',
                        }}>
                          <button
                            onClick={() => setEditingSection({ id: section.id, label: section.label, emoji: section.emoji ?? '' })}
                            title="Edit column"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer' }}>
                            <Icon name="edit" size={13} color="var(--color-accent-purple-light)" />
                          </button>
                          <button
                            onClick={() => handleDeleteSection(section.id)}
                            title="Delete column"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer' }}>
                            <Icon name="delete" size={13} color="var(--color-error)" />
                          </button>
                        </MotionIn>
                      );
                    })()}
                  </div>

                  {/* Cards — scroll independently within the column */}
                  <MotionIn transition={{ duration: 0.12 }} style={{
                    display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--color-surface-gray)', borderRadius: 12,
                    border: isSectionDropTarget ? '1.5px solid var(--color-accent-purple-light)' : '1px solid var(--color-border-alt)',
                    overflowY: 'auto', maxHeight: 'calc(100vh - 340px)',
                    boxShadow: isSectionDropTarget ? '0 0 0 3px rgba(var(--color-accent-purple-light-rgb), 0.15)' : 'none',
                  }}>
                    {section.tasks.length === 0 ? (
                      <MotionIn transition={{ duration: 0.12 }} style={{ padding: '16px', fontFamily: 'var(--font-body)', fontSize: 13, color: isSectionDropTarget ? 'var(--color-accent-purple-light)' : 'var(--color-text-quaternary)', textAlign: 'center', }}>
                        {isSectionDropTarget ? 'Drop here to move' : 'No tasks.'}
                      </MotionIn>
                    ) : (
                      <div style={{ padding: '4px' }}>
                        <AnimatePresence initial={false}>
                        {section.tasks.map(task => {
                          const enrichedTask = { ...task, _source: 'list' as const, _listId: listId, _listName: list.name };
                          return (
                            <motion.div key={task.id} layout="position" variants={listItemVariants} initial="initial" animate="animate" exit="exit" transition={LAYOUT_TRANSITION}>
                              <TaskItem task={enrichedTask}
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
                            </motion.div>
                          );
                        })}
                        </AnimatePresence>
                      </div>
                    )}
                    <div data-quickadd-root style={{ borderTop: section.tasks.length > 0 ? '1px solid var(--color-surface-tint-2)' : 'none' }}>
                      <QuickAdd placeholder="Add task…" onAdd={data => handleAddTask(section.id, data)} availableLists={lists} currentListId={listId} />
                    </div>
                  </MotionIn>
                </motion.div>
              );
            })}

            {/* Add column */}
            <MotionIn initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.24, delay: (list.sections.length * 40) / 1000, ease: EASE_SETTLE }} style={{ width: 280, flexShrink: 0 }}>
              {addingSection ? (
                <MotionIn style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--color-surface-gray)', border: '1.5px solid var(--color-primary)', borderRadius: 12, padding: 10 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_SETTLE }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EmojiSelector value={newSectionEmoji} onChange={setNewSectionEmoji} direction="down" />
                    <input
                      ref={newSectionInputRef}
                      autoFocus
                      value={newSectionLabel}
                      onChange={e => setNewSectionLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddSection(); if (e.key === 'Escape') { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); } }}
                      placeholder="Column name…"
                      style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 10px', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-white)' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={handleAddSection} disabled={!newSectionLabel.trim()}
                      style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-white)', background: newSectionLabel.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '8px', cursor: newSectionLabel.trim() ? 'pointer' : 'default' }}>
                      Add
                    </button>
                    <button onClick={() => { setAddingSection(false); setNewSectionLabel(''); setNewSectionEmoji(''); }}
                      style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-tertiary)', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </MotionIn>
              ) : (
                <MotionButton onClick={() => setAddingSection(true)}
                  transition={{ duration: 0.15 }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-purple-pale-28)', border: '1.5px dashed var(--color-purple-tint-6)', borderRadius: 10, padding: '11px', cursor: 'pointer', width: '100%', }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-pale-35)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.borderColor = 'var(--color-accent-purple-light)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-purple-pale-28)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.borderColor = 'var(--color-purple-tint-6)'; }}>
                  <Icon name="add" size={15} color="inherit" />
                  Add column
                </MotionButton>
              )}
            </MotionIn>
          </MotionIn>
        )}

        {/* Timeline view — tasks laid out left-to-right by creation → completion/today */}
        {effectiveViewMode === 'timeline' && (
          <TaskTimelineView
            list={list}
            isMobile={isMobile}
            onToggle={toggle}
            onRowClick={t => setSelectedTask(t)}
          />
        )}
      </div>

      <AnimatePresence>
        {selectedTask && (
          <TaskDialog
            key="task-dialog"
            task={selectedTask}
            onUpdate={(id, upd) => updateListTask(listId!, id, upd)}
            onDelete={deleteTask}
            onClose={() => setSelectedTask(null)}
            isPublic={list.isPublic}
          />
        )}
      </AnimatePresence>

    </div>
  );
}
