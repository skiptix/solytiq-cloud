import { describe, expect, it, beforeEach } from 'vitest';
import useGraphStore from '../useGraphStore';
import type { GraphNode, GraphEdge } from '../../types';

const NODE = (over: Partial<GraphNode>): GraphNode => ({
  srn: 'srn:task:1', type: 'task', id: '1', title: 'Task', emoji: null, color: null, deepLink: null,
  degree: 1, pagerank: 0, community: null, status: 'open', isArchived: false, ...over,
});
const EDGE = (over: Partial<GraphEdge>): GraphEdge => ({
  id: 'lnk_1', src: 'srn:task:1', dst: 'srn:list:1', linkType: 'links_to', origin: 'manual',
  weight: 1, sourceBlockId: null, crossWorkspace: false, ...over,
});

function seed(nodes: GraphNode[], edges: GraphEdge[]) {
  useGraphStore.setState({ allNodes: nodes, allEdges: edges, loaded: true });
}

describe('useGraphStore filters (client-side, no network)', () => {
  beforeEach(() => {
    useGraphStore.setState({
      allNodes: [], allEdges: [], hidden: { nodes: 0, edges: 0 }, truncated: false,
      filters: { entityTypes: [], linkTypes: [], showCompleted: true, showOrphans: false, depth: 2 },
      focusSrn: null, selectedSrn: null,
    });
  });

  it('shows everything with no filters applied', () => {
    seed([NODE({ srn: 'srn:task:1', id: '1' }), NODE({ srn: 'srn:list:1', id: '1', type: 'list' })], [EDGE({})]);
    expect(useGraphStore.getState().visibleNodes()).toHaveLength(2);
  });

  it('entityTypes filter narrows to selected types', () => {
    seed([NODE({ srn: 'srn:task:1' }), NODE({ srn: 'srn:list:1', type: 'list' })], []);
    useGraphStore.getState().setFilter('showOrphans', true);
    useGraphStore.getState().setFilter('entityTypes', ['list']);
    const visible = useGraphStore.getState().visibleNodes();
    expect(visible).toHaveLength(1);
    expect(visible[0].type).toBe('list');
  });

  it('hides orphan (degree-0 / unconnected) nodes by default', () => {
    seed(
      [NODE({ srn: 'srn:task:1' }), NODE({ srn: 'srn:list:1', type: 'list' }), NODE({ srn: 'srn:task:2', id: '2' })],
      [EDGE({ src: 'srn:task:1', dst: 'srn:list:1' })]
    );
    // task:2 has no edge touching it — an orphan.
    expect(useGraphStore.getState().visibleNodes().map((n) => n.srn)).not.toContain('srn:task:2');
  });

  it('showOrphans=true reveals unconnected nodes', () => {
    seed([NODE({ srn: 'srn:task:1' })], []);
    useGraphStore.getState().setFilter('showOrphans', true);
    expect(useGraphStore.getState().visibleNodes()).toHaveLength(1);
  });

  it('hides structural part_of edges by default (the "not a hairball" default)', () => {
    seed(
      [NODE({ srn: 'srn:task:1' }), NODE({ srn: 'srn:list:1', type: 'list' })],
      [EDGE({ linkType: 'part_of' })]
    );
    useGraphStore.getState().setFilter('showOrphans', true);
    expect(useGraphStore.getState().visibleEdges()).toHaveLength(0);
  });

  it('linkTypes filter, when set, overrides the part_of default and shows only the chosen types', () => {
    seed(
      [NODE({ srn: 'srn:task:1' }), NODE({ srn: 'srn:list:1', type: 'list' })],
      [EDGE({ linkType: 'part_of' }), EDGE({ id: 'lnk_2', linkType: 'blocks' })]
    );
    useGraphStore.getState().setFilter('showOrphans', true);
    useGraphStore.getState().setFilter('linkTypes', ['part_of']);
    expect(useGraphStore.getState().visibleEdges().map((e) => e.linkType)).toEqual(['part_of']);
  });

  it('an edge touching a filtered-out node is not shown, even if it matches linkTypes', () => {
    seed(
      [NODE({ srn: 'srn:task:1' }), NODE({ srn: 'srn:list:1', type: 'list' })],
      [EDGE({})]
    );
    useGraphStore.getState().setFilter('entityTypes', ['task']); // drops the list node
    expect(useGraphStore.getState().visibleEdges()).toHaveLength(0);
  });

  it('resetFilters restores the defaults', () => {
    useGraphStore.getState().setFilter('entityTypes', ['task']);
    useGraphStore.getState().setFilter('depth', 4);
    useGraphStore.getState().resetFilters();
    expect(useGraphStore.getState().filters).toEqual({ entityTypes: [], linkTypes: [], showCompleted: true, showOrphans: false, depth: 2 });
  });
});
