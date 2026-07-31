import { useMemo } from 'react';
import useAppStore from '../store/useAppStore';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import { buildParentIndex, buildRenderedHierarchy, workspaceRootSrn, type GraphHierarchy } from '../utils/graphHierarchy';
import type { GraphNode } from '../types';

/**
 * Wires the app's already-loaded structural data (lists/folders/timelines
 * from useAppStore, markdown pages from useMarkdownListsStore) into the pure
 * graphHierarchy builder, scoped to the active workspace. See
 * utils/graphHierarchy.ts for why this lives client-side rather than as
 * entity_links rows.
 */
export default function useGraphHierarchy(nodes: GraphNode[], workspaceId: string | null): GraphHierarchy | null {
  const lists = useAppStore((s) => s.lists);
  const folders = useAppStore((s) => s.folders);
  const timelines = useAppStore((s) => s.timelines);
  const dashTasks = useAppStore((s) => s.dashTasks);
  const markdownLists = useMarkdownListsStore((s) => s.markdownLists);

  const fullParentIndex = useMemo(() => {
    if (!workspaceId) return null;
    return buildParentIndex({
      workspaceId,
      lists: lists.filter((l) => l.workspaceId === workspaceId).map((l) => ({
        id: l.id,
        folderId: l.folderId ?? null,
        parentTaskId: l.parentTaskId ?? null,
        sections: l.sections.map((s) => ({ id: s.id, tasks: s.tasks.map((t) => ({ id: t.id })) })),
      })),
      folders: folders.filter((f) => f.workspaceId === workspaceId).map((f) => ({ id: f.id })),
      timelines: timelines.filter((t) => t.workspaceId === workspaceId).map((t) => ({
        id: t.id, folderId: t.folderId ?? null, milestones: t.milestones.map((m) => ({ id: m.id })),
      })),
      markdownLists: markdownLists.filter((m) => m.workspaceId === workspaceId).map((m) => ({
        id: m.id, folderId: m.folderId ?? null, todoListId: m.todoListId ?? null,
      })),
      dashTaskIds: dashTasks.filter((t) => t.workspaceId === workspaceId).map((t) => t.id),
    });
  }, [workspaceId, lists, folders, timelines, dashTasks, markdownLists]);

  return useMemo(() => {
    if (!workspaceId || !fullParentIndex) return null;
    return buildRenderedHierarchy(nodes, fullParentIndex, workspaceId);
  }, [nodes, fullParentIndex, workspaceId]);
}

export { workspaceRootSrn };
