import { describe, expect, it } from 'vitest';
import { buildParentIndex, buildRenderedHierarchy, workspaceRootSrn } from '../graphHierarchy';
import type { GraphNode } from '../../types';
import type { HierarchySource } from '../graphHierarchy';

function makeNode(srn: string, type: GraphNode['type'] = 'task'): GraphNode {
  return {
    srn, type, id: srn.split(':')[2], title: srn, emoji: null, color: null, deepLink: null,
    degree: 0, pagerank: 0, community: null, status: null, isArchived: false,
  };
}

const SOURCE: HierarchySource = {
  workspaceId: 'ws1',
  folders: [{ id: 'folder1' }],
  lists: [
    { id: 'list1', folderId: 'folder1', sections: [{ id: 'sec1', tasks: [{ id: 1 }, { id: 2 }] }] },
    { id: 'list2', folderId: null, sections: [{ id: 'sec2', tasks: [{ id: 3 }] }] },
  ],
  timelines: [{ id: 'tl1', folderId: null, milestones: [{ id: 'm1' }] }],
  markdownLists: [{ id: 'md1', folderId: 'folder1' }],
  dashTaskIds: [99],
};

describe('buildParentIndex', () => {
  const parents = buildParentIndex(SOURCE);
  const root = workspaceRootSrn('ws1');

  it('chains list -> section -> task through a folder up to the workspace root', () => {
    expect(parents.get('srn:task:1')).toBe('srn:section:sec1');
    expect(parents.get('srn:section:sec1')).toBe('srn:list:list1');
    expect(parents.get('srn:list:list1')).toBe('srn:folder:folder1');
    expect(parents.get('srn:folder:folder1')).toBe(root);
  });

  it('a folderless list attaches directly to the workspace root', () => {
    expect(parents.get('srn:list:list2')).toBe(root);
  });

  it('milestones attach to their timeline, which attaches to the root', () => {
    expect(parents.get('srn:milestone:m1')).toBe('srn:timeline:tl1');
    expect(parents.get('srn:timeline:tl1')).toBe(root);
  });

  it('markdown pages honor their folder like lists do', () => {
    expect(parents.get('srn:markdownList:md1')).toBe('srn:folder:folder1');
  });

  it('dashboard tasks attach directly to the workspace root', () => {
    expect(parents.get('srn:task:99')).toBe(root);
  });
});

describe('buildRenderedHierarchy', () => {
  const fullIndex = buildParentIndex(SOURCE);
  const root = workspaceRootSrn('ws1');

  it('every rendered node gets a hierarchy edge, guaranteeing no visual orphan', () => {
    const nodes = [makeNode('srn:task:1'), makeNode('srn:section:sec1', 'section'), makeNode('srn:list:list1', 'list'), makeNode('srn:folder:folder1', 'folder')];
    const h = buildRenderedHierarchy(nodes, fullIndex, 'ws1');
    expect(h.edges).toHaveLength(4); // one per rendered node, root -> folder -> list -> section -> task
    expect(h.parentOf.get('srn:task:1')).toBe('srn:section:sec1');
  });

  it('skips over filtered-out ancestors to the nearest still-rendered one', () => {
    // section and list are filtered out of the rendered set — task should jump straight to the folder.
    const nodes = [makeNode('srn:task:1'), makeNode('srn:folder:folder1', 'folder')];
    const h = buildRenderedHierarchy(nodes, fullIndex, 'ws1');
    expect(h.parentOf.get('srn:task:1')).toBe('srn:folder:folder1');
  });

  it('falls all the way back to the workspace root when nothing else is rendered', () => {
    const nodes = [makeNode('srn:task:1')];
    const h = buildRenderedHierarchy(nodes, fullIndex, 'ws1');
    expect(h.parentOf.get('srn:task:1')).toBe(root);
  });

  it('computes depth from the workspace root', () => {
    const nodes = [makeNode('srn:task:1'), makeNode('srn:section:sec1', 'section'), makeNode('srn:list:list1', 'list'), makeNode('srn:folder:folder1', 'folder')];
    const h = buildRenderedHierarchy(nodes, fullIndex, 'ws1');
    expect(h.depthOf.get(root)).toBe(0);
    expect(h.depthOf.get('srn:folder:folder1')).toBe(1);
    expect(h.depthOf.get('srn:list:list1')).toBe(2);
    expect(h.depthOf.get('srn:section:sec1')).toBe(3);
    expect(h.depthOf.get('srn:task:1')).toBe(4);
  });

  it('tallies direct child counts per parent, including the workspace root', () => {
    const nodes = [makeNode('srn:list:list2', 'list'), makeNode('srn:folder:folder1', 'folder')];
    const h = buildRenderedHierarchy(nodes, fullIndex, 'ws1');
    expect(h.childCount.get(root)).toBe(2); // list2 + folder1 both attach directly to root
  });
});
