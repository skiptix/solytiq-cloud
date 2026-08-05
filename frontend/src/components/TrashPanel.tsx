import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import useAppStore, { apiEmptyTrash } from '../store/useAppStore';
import Icon from './Icon';
import { listItemVariants, modalVariants, LAYOUT_TRANSITION } from '../utils/motionTokens';
import type { TrashedTask, TrashedList, TrashedFolder, TrashedTimeline, TrashedMilestone } from '../types';

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

type TrashTab = 'all' | 'tasks' | 'lists' | 'timelines' | 'milestones' | 'folders';

/**
 * Content-only Trash view — no backdrop/header/close button of its own —
 * embedded as a tab inside WorkspaceSettingsModal (see the "Trash & Archived"
 * tab). Previously a standalone modal (modals/TrashModal.tsx); moved inline
 * per the sidebar clean-up that folded Trash into workspace settings.
 */
export default function TrashPanel() {
  const {
    trashTasks, restoreFromTrash, deleteFromTrash,
    trashLists, restoreListFromTrash, deleteListFromTrash,
    trashTimelines, restoreTimelineFromTrash, deleteTimelineFromTrash,
    trashMilestones, restoreMilestoneFromTrash, deleteMilestoneFromTrash,
    trashFolders, restoreFolderFromTrash, deleteFolderFromTrash,
  } = useAppStore();

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<TrashTab>('all');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptyLoading, setEmptyLoading] = useState(false);

  const totalCount = trashTasks.length + trashLists.length + trashTimelines.length + trashMilestones.length + trashFolders.length;
  const q = search.trim().toLowerCase();

  const filteredTasks = trashTasks.filter(t =>
    !q || t.task.title.toLowerCase().includes(q) || (t.meta.listName ?? '').toLowerCase().includes(q)
  );
  const filteredLists = trashLists.filter(t =>
    !q || t.list.name.toLowerCase().includes(q)
  );
  const filteredTimelines = trashTimelines.filter(t =>
    !q || t.timeline.name.toLowerCase().includes(q)
  );
  const filteredMilestones = trashMilestones.filter(t =>
    !q || t.milestone.title.toLowerCase().includes(q)
  );
  const filteredFolders = trashFolders.filter(t =>
    !q || t.folder.name.toLowerCase().includes(q)
  );

  type AnyTrashItem =
    | { kind: 'task'; deletedAt: string; item: TrashedTask }
    | { kind: 'list'; deletedAt: string; item: TrashedList }
    | { kind: 'timeline'; deletedAt: string; item: TrashedTimeline }
    | { kind: 'milestone'; deletedAt: string; item: TrashedMilestone }
    | { kind: 'folder'; deletedAt: string; item: TrashedFolder };

  const allItems: AnyTrashItem[] = [
    ...filteredTasks.map(t => ({ kind: 'task' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredLists.map(t => ({ kind: 'list' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredTimelines.map(t => ({ kind: 'timeline' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredMilestones.map(t => ({ kind: 'milestone' as const, deletedAt: t.deletedAt, item: t })),
    ...filteredFolders.map(t => ({ kind: 'folder' as const, deletedAt: t.deletedAt, item: t })),
  ].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

  const visibleItems = tab === 'all'
    ? allItems
    : allItems.filter(i => i.kind === tab.slice(0, -1));

  const handleEmptyTrash = async () => {
    setEmptyLoading(true);
    try {
      await apiEmptyTrash();
    } catch {
      // ignore api failure, clear locally
    }
    trashTasks.forEach(t => deleteFromTrash(t.id));
    trashLists.forEach(t => deleteListFromTrash(t.id));
    trashTimelines.forEach(t => deleteTimelineFromTrash(t.id));
    trashMilestones.forEach(t => deleteMilestoneFromTrash(t.id));
    trashFolders.forEach(t => deleteFolderFromTrash(t.id));
    setEmptyLoading(false);
    setConfirmEmpty(false);
  };

  const TABS: { id: TrashTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: totalCount },
    { id: 'tasks', label: 'Tasks', count: trashTasks.length },
    { id: 'lists', label: 'Boards', count: trashLists.length },
    { id: 'timelines', label: 'Timelines', count: trashTimelines.length },
    { id: 'milestones', label: 'Milestones', count: trashMilestones.length },
    { id: 'folders', label: 'Folders', count: trashFolders.length },
  ];

  return (
    <div style={{ position: 'relative' }}>
      {/* Toolbar — search + filter pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-purple-pale-11)', borderRadius: 10, padding: '8px 14px', marginBottom: 10 }}>
        <Icon name="search" size={16} color="var(--color-text-tertiary)" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search trash…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }} />
        {search && (
          <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
            <Icon name="close" size={14} color="var(--color-text-tertiary)" />
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {TABS.filter(t => t.id === 'all' || t.count > 0).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 9999, padding: '5px 12px', cursor: 'pointer', background: tab === t.id ? 'var(--color-primary)' : 'var(--color-surface-tint-2)', color: tab === t.id ? 'var(--color-white)' : 'var(--color-text-tertiary)', transition: 'all 150ms' }}>
            {t.label}
          </button>
        ))}
        {totalCount > 0 && (
          <button
            onClick={() => setConfirmEmpty(true)}
            style={{ marginLeft: 'auto', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-error)', background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-error-bg)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', transition: 'all 150ms' }}>
            Empty Trash
          </button>
        )}
      </div>

      {/* Items */}
      <div style={{ maxHeight: 420, overflowY: 'auto', padding: '2px 2px 4px' }}>
        {totalCount === 0 ? (
          <div style={{ padding: '40px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--color-purple-pale-11)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="delete" size={28} color="var(--color-border-strong)" />
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>Trash is empty.</div>
          </div>
        ) : visibleItems.length === 0 ? (
          <div style={{ padding: '32px 12px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>No matching items.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
            <AnimatePresence initial={false}>
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
              if (entry.kind === 'timeline') {
                const item = entry.item as TrashedTimeline;
                return (
                  <TimelineTrashRow
                    key={`timeline-${item.id}`}
                    item={item}
                    onRestore={() => restoreTimelineFromTrash(item.id)}
                    onDelete={() => deleteTimelineFromTrash(item.id)} />
                );
              }
              if (entry.kind === 'milestone') {
                const item = entry.item as TrashedMilestone;
                return (
                  <MilestoneTrashRow
                    key={`milestone-${item.id}`}
                    item={item}
                    onRestore={() => restoreMilestoneFromTrash(item.id)}
                    onDelete={() => deleteMilestoneFromTrash(item.id)} />
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
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Empty confirm overlay — covers just this panel, not the whole settings modal */}
      <AnimatePresence>
        {confirmEmpty && (
          <motion.div
            variants={modalVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ position: 'absolute', inset: 0, background: 'rgba(var(--color-white-rgb), 0.97)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 10, borderRadius: 12 }}
          >
            <div style={{ textAlign: 'center', maxWidth: 300 }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                <Icon name="warning" size={24} color="var(--color-error)" />
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Empty the trash?</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 20 }}>
                This will permanently delete all {totalCount} item{totalCount !== 1 ? 's' : ''} in the trash. This cannot be undone.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button onClick={() => setConfirmEmpty(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleEmptyTrash} disabled={emptyLoading} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: emptyLoading ? 'wait' : 'pointer' }}>
                  {emptyLoading ? 'Deleting…' : 'Empty Trash'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
        style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
        <Icon name="restore" size={13} color="var(--color-primary)" /> Restore
      </button>
      <button
        onClick={onDelete}
        title="Delete permanently"
        style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: hov ? 'var(--color-error-bg)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 150ms' }}>
        <Icon name="delete_forever" size={15} color="var(--color-error)" />
      </button>
    </div>
  );
}

function TaskTrashRow({ item, onRestore, onDelete }: { item: TrashedTask; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const PCOLS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };

  return (
    <motion.div
      layout
      variants={listItemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={LAYOUT_TRANSITION}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? 'var(--color-error-bg-alt)' : 'var(--color-surface-neutral)', border: `1px solid ${hov ? 'var(--color-error-bg)' : 'var(--color-surface-tint-2)'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name="task_alt" size={15} color="var(--color-error)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'line-through' }}>
          {item.task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>
            {item.meta.src === 'list' ? item.meta.listName : 'Dashboard'} · {friendlyTime(item.deletedAt)}
          </span>
          {item.task.priority && (
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600, color: PCOLS[item.task.priority] }}>{item.task.priority}</span>
          )}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </motion.div>
  );
}

function ListTrashRow({ item, onRestore, onDelete }: { item: TrashedList; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const count = taskCount(item.list);

  return (
    <motion.div
      layout
      variants={listItemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={LAYOUT_TRANSITION}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? 'var(--color-surface-tint)' : 'var(--color-surface-neutral)', border: `1px solid ${hov ? 'var(--color-purple-pale-38)' : 'var(--color-surface-tint-2)'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.list.emoji
          ? <span style={{ fontSize: 16 }}>{item.list.emoji}</span>
          : <Icon name="format_list_bulleted" size={15} color="var(--color-primary)" />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.list.name}
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>
          Board · {count} task{count !== 1 ? 's' : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </motion.div>
  );
}

function TimelineTrashRow({ item, onRestore, onDelete }: { item: TrashedTimeline; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const count = item.timeline.milestones?.length ?? 0;

  return (
    <motion.div
      layout
      variants={listItemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={LAYOUT_TRANSITION}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? 'var(--color-blue-pale-2)' : 'var(--color-surface-neutral)', border: `1px solid ${hov ? 'var(--color-blue-tint-2)' : 'var(--color-surface-tint-2)'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-blue-pale-9)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.timeline.emoji
          ? <span style={{ fontSize: 16 }}>{item.timeline.emoji}</span>
          : <Icon name="timeline" size={15} color="var(--color-blue-mid-7)" />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.timeline.name}
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>
          Timeline · {count} milestone{count !== 1 ? 's' : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </motion.div>
  );
}

function MilestoneTrashRow({ item, onRestore, onDelete }: { item: TrashedMilestone; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const dot = item.milestone.color ?? 'var(--color-blue-mid-7)';
  const timelineName = useAppStore(s => s.timelines.find(t => t.id === item.timelineId)?.name);

  return (
    <motion.div
      layout
      variants={listItemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={LAYOUT_TRANSITION}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? 'var(--color-blue-pale-3)' : 'var(--color-surface-neutral)', border: `1px solid ${hov ? 'var(--color-blue-tint-1)' : 'var(--color-surface-tint-2)'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-blue-pale-7)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.milestone.emoji
          ? <span style={{ fontSize: 16 }}>{item.milestone.emoji}</span>
          : <Icon name="flag" size={15} color={dot} />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.milestone.title}
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>
          Milestone{timelineName ? ` · ${timelineName}` : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </motion.div>
  );
}

function FolderTrashRow({ item, onRestore, onDelete }: { item: TrashedFolder; onRestore: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const listCount = (item.folder.listIds ?? []).length;

  return (
    <motion.div
      layout
      variants={listItemVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={LAYOUT_TRANSITION}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: hov ? 'var(--color-yellow-pale-1)' : 'var(--color-surface-neutral)', border: `1px solid ${hov ? 'var(--color-yellow-tint-2)' : 'var(--color-surface-tint-2)'}`, transition: 'all 150ms' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-yellow-tint-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {item.folder.emoji
          ? <span style={{ fontSize: 16 }}>{item.folder.emoji}</span>
          : <Icon name="folder" size={15} color="var(--color-warning)" />
        }
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.folder.name}
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', marginTop: 2 }}>
          Folder · {listCount} list{listCount !== 1 ? 's' : ''} · {friendlyTime(item.deletedAt)}
        </div>
      </div>
      <ActionButtons onRestore={onRestore} onDelete={onDelete} hov={hov} />
    </motion.div>
  );
}
