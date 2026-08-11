import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReactFlow, Background, Controls, type Node as RFNode, type Edge as RFEdge, type Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMobile } from '../hooks/useBreakpoint';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useGraphStore from '../store/useGraphStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import Icon from '../components/Icon';
import RenameDialog from '../components/RenameDialog';
import LinkPicker from '../components/LinkPicker';
import { RF_NODE_TYPES } from '../components/graph/FlowGraph';
import SigmaGraph from '../components/graph/SigmaGraph';
import NeuralGraph, { type NeuralGraphHandle } from '../components/graph/NeuralGraph';
import GraphToolbar from '../components/graph/GraphToolbar';
import { shouldUseSigma } from '../utils/graphLayout';
import useGraphHierarchy from '../hooks/useGraphHierarchy';
import { buildWorkspaceRootNode, type NetRenderNode } from '../utils/graphHierarchy';
import { useEntitySearch } from '../hooks/useEntitySearch';
import { apiGetCanvases, apiCreateCanvas, apiGetCanvas, apiUpdateCanvas, apiCreateLink, apiGetWorkspaceGraph, apiGetEntityLinks } from '../api/client';
import type { GraphNode, GraphCanvas, EntityIndexEntry } from '../types';
import Spinner from '@/components/animate-ui/Spinner';

function ExploreView({ isMobile }: { isMobile: boolean }) {
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId));
  const { loadWorkspaceGraph, focusSrn, focusNode, visibleNodes, visibleEdges, loading, allNodes } = useGraphStore();
  const [selected, setSelected] = useState<NetRenderNode | null>(null);
  const positionOverrides = useUserPrefsStore((s) => (workspaceId ? s.graphNodePositions[workspaceId] : undefined));
  const setGraphNodePosition = useUserPrefsStore((s) => s.setGraphNodePosition);
  const clearGraphNodePositions = useUserPrefsStore((s) => s.clearGraphNodePositions);
  const markdownWorkspaceId = useMarkdownListsStore((s) => s.workspaceId);
  const loadMarkdownLists = useMarkdownListsStore((s) => s.load);
  const graphRef = useRef<NeuralGraphHandle>(null);

  useEffect(() => {
    if (workspaceId) void loadWorkspaceGraph(workspaceId);
  }, [workspaceId, loadWorkspaceGraph]);

  // The hierarchy needs each markdown page's folder — loaded separately from
  // the workspace-scoped app store (useMarkdownListsStore.load), same as
  // MarkdownListsScreen does.
  useEffect(() => {
    if (workspaceId && markdownWorkspaceId !== workspaceId) void loadMarkdownLists(workspaceId);
  }, [workspaceId, markdownWorkspaceId, loadMarkdownLists]);

  const nodes = visibleNodes();
  const relationEdges = visibleEdges();
  const useSigma = shouldUseSigma(nodes.length);
  const hierarchy = useGraphHierarchy(nodes, workspaceId);

  const rootNode = useMemo(
    () => (workspaceId ? buildWorkspaceRootNode(workspaceId, workspace?.name ?? 'Workspace', workspace?.emoji) : null),
    [workspaceId, workspace?.name, workspace?.emoji]
  );
  const renderNodes: NetRenderNode[] = useMemo(() => (rootNode ? [rootNode, ...nodes] : nodes), [rootNode, nodes]);

  const handleNodeClick = useCallback((n: NetRenderNode) => {
    if (n.type === 'workspace') { graphRef.current?.resetCamera(); return; }
    setSelected(n);
  }, []);
  const handleNodeOpen = useCallback((n: NetRenderNode) => {
    if (n.type !== 'workspace' && n.deepLink) navigate(n.deepLink);
  }, [navigate]);
  const handleDeselect = useCallback(() => setSelected(null), []);
  const handleNodePin = useCallback((srn: string, x: number, y: number) => {
    if (workspaceId) setGraphNodePosition(workspaceId, srn, x, y);
  }, [workspaceId, setGraphNodePosition]);
  const handlePickSearchResult = useCallback((entity: EntityIndexEntry) => {
    graphRef.current?.centerOn(entity.srn);
    focusNode(null);
    const found = nodes.find((n) => n.srn === entity.srn);
    setSelected(found ?? null);
  }, [nodes, focusNode]);

  // A deep-link into a specific node (e.g. the Dashboard mini-map's "Open" ->
  // focusNode(srn) -> navigate('/graph')) — select it and pan the camera over
  // once the simulation has actually seeded a position for it. A short poll
  // rather than a single rAF: the force-sim's own data-sync effect commits
  // asynchronously after this component's first paint.
  useEffect(() => {
    if (!focusSrn) return;
    const found = nodes.find((n) => n.srn === focusSrn);
    if (!found) return;
    setSelected(found);
    let attempts = 0;
    const tryCenter = () => {
      attempts += 1;
      if (graphRef.current?.hasNode(focusSrn)) { graphRef.current.centerOn(focusSrn); return; }
      if (attempts < 15) setTimeout(tryCenter, 60);
    };
    tryCenter();
    focusNode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSrn, nodes]);

  if (!workspaceId || !rootNode || !hierarchy) return null;
  const hasCustomLayout = !!positionOverrides && Object.keys(positionOverrides).length > 0;
  const isEmpty = !loading && allNodes.length === 0;

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', minWidth: 0, borderRadius: 14, border: '1px solid var(--color-border)', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.04)', overflow: 'hidden', animation: 'cardIn 320ms cubic-bezier(0.22,1,0.36,1) both' }}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-heading)', fontSize: 13, zIndex: 4, background: 'var(--color-white)' }}>
          <Spinner size={16} thickness={2} durationMs={600} />
          Loading…
        </div>
      )}
      {isEmpty && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', animation: 'sectionFadeUp 320ms ease both', zIndex: 4, background: 'var(--color-white)' }}>
          <Icon name="hub" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Nothing here yet</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Create a board, page, or timeline in this workspace to see it take shape here.</div>
        </div>
      )}
      {!loading && !isEmpty && (
        nodes.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', animation: 'sectionFadeUp 320ms ease both', zIndex: 4, background: 'var(--color-white)' }}>
            <Icon name="visibility_off" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Nothing matches your filters</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Try widening the entity-type filter.</div>
          </div>
        ) : useSigma
          ? <SigmaGraph nodes={nodes} edges={relationEdges} onNodeClick={handleNodeClick} />
          : <NeuralGraph
              ref={graphRef}
              nodes={renderNodes}
              hierarchy={hierarchy}
              relationEdges={relationEdges}
              workspaceRootSrn={rootNode.srn}
              workspaceId={workspaceId}
              selectedSrn={selected?.srn}
              onNodeClick={handleNodeClick}
              onNodeOpen={handleNodeOpen}
              onBackgroundClick={handleDeselect}
              pinnedPositions={positionOverrides}
              onNodePin={handleNodePin}
            />
      )}

      <GraphToolbar
        workspaceId={workspaceId}
        hasCustomLayout={hasCustomLayout && !useSigma}
        onResetLayout={() => clearGraphNodePositions(workspaceId)}
        onPickResult={handlePickSearchResult}
        isMobile={isMobile}
      />
    </div>
  );
}

function CanvasView({ isMobile }: { isMobile: boolean }) {
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [canvases, setCanvases] = useState<GraphCanvas[]>([]);
  const [active, setActive] = useState<GraphCanvas | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addActiveIndex, setAddActiveIndex] = useState(0);

  // Single source of truth for "what should be persisted" — several different
  // event paths (a drag ending, the Remove button, Add-node) can each end up
  // asking to save, sometimes from a closure that predates a just-applied
  // state update (e.g. XYFlow can fire onNodeDragStop for the same gesture
  // that triggered a node's removal). Reading the ref here instead of a
  // captured `rfNodes` argument means every save always writes the CURRENT
  // node list, so a stale caller can never resurrect an already-removed node.
  const rfNodesRef = useRef<RFNode[]>([]);
  useEffect(() => { rfNodesRef.current = rfNodes; }, [rfNodes]);
  const activeRef = useRef<GraphCanvas | null>(null);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (!workspaceId) return;
    apiGetCanvases(workspaceId).then((r) => setCanvases(r.canvases)).catch(() => setCanvases([]));
  }, [workspaceId]);

  const persistLayout = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return;
    setSaving(true);
    try {
      const layout = {
        version: 1 as const,
        nodes: rfNodesRef.current.map((n) => ({ srn: n.id, x: n.position.x, y: n.position.y })),
        groups: current.layout.groups ?? [], notes: current.layout.notes ?? [],
      };
      const r = await apiUpdateCanvas(current.id, { layout, version: current.version });
      setActive(r.canvas);
    } catch {
      // conflict or transient failure — the canvas stays open, next save retries with the latest version
    } finally {
      setSaving(false);
    }
  }, []);

  const openNode = useCallback((node: GraphNode) => {
    if (node.deepLink) navigate(node.deepLink);
  }, [navigate]);

  const removeNode = useCallback((srn: string) => {
    const next = rfNodesRef.current.filter((n) => n.id !== srn);
    rfNodesRef.current = next; // update the ref synchronously so persistLayout (below) can never race ahead of it
    setRfNodes(next);
    setRfEdges((eds) => eds.filter((e) => e.source !== srn && e.target !== srn));
    void persistLayout();
  }, [persistLayout]);

  const buildEntityRfNode = useCallback((srn: string, x: number, y: number, node: GraphNode | null): RFNode => {
    if (node) {
      return {
        id: srn, type: 'entity', position: { x, y },
        data: { node, focused: false, onRemove: () => removeNode(srn), onOpen: () => openNode(node) } as unknown as Record<string, unknown>,
      };
    }
    // The entity is no longer resolvable (deleted, or access revoked) — keep its
    // saved position as an inert placeholder rather than silently dropping it.
    return {
      id: srn, position: { x, y },
      data: { label: srn.split(':').slice(-1)[0] },
      style: { padding: 8, borderRadius: 8, border: '1.5px dashed var(--color-border)', fontSize: 12, color: 'var(--color-text-quaternary)', background: 'var(--color-surface-tint-3)' },
    };
  }, [removeNode, openNode]);

  const openCanvas = useCallback(async (id: string) => {
    const r = await apiGetCanvas(id);
    setActive(r.canvas);
    const placedSrns = new Set(r.canvas.layout.nodes.map((n) => n.srn));
    let bySrn = new Map<string, GraphNode>();
    let liveEdges: RFEdge[] = [];
    if (workspaceId) {
      try {
        const g = await apiGetWorkspaceGraph(workspaceId, { limit: 2000 });
        bySrn = new Map(g.nodes.map((n) => [n.srn, n]));
        liveEdges = g.edges
          .filter((e) => placedSrns.has(e.src) && placedSrns.has(e.dst))
          .map((e) => ({ id: e.id, source: e.src, target: e.dst, style: { stroke: e.crossWorkspace ? 'var(--color-warning)' : 'var(--color-purple-tint-3, #c4b8f0)', strokeWidth: 1.5 } }));
      } catch {
        // real-node enrichment + edges are best-effort — the canvas still opens with bare placeholders
      }
    }
    setRfNodes(r.canvas.layout.nodes.map((n) => buildEntityRfNode(n.srn, n.x, n.y, bySrn.get(n.srn) ?? null)));
    setRfEdges(liveEdges);
  }, [workspaceId, buildEntityRfNode]);

  const createCanvas = useCallback(async (name: string) => {
    if (!workspaceId || !name.trim()) { setCreating(false); return; }
    const r = await apiCreateCanvas({ workspaceId, name: name.trim() });
    setCanvases((c) => [r.canvas, ...c]);
    setCreating(false);
    void openCanvas(r.canvas.id);
  }, [workspaceId, openCanvas]);

  const { results: addResults, loading: addLoading } = useEntitySearch(adding ? addQuery : '', {
    workspaceId: workspaceId ?? undefined, excludeSrns: rfNodes.map((n) => n.id),
  });

  const addEntityToCanvas = useCallback((entity: EntityIndexEntry) => {
    const nds = rfNodesRef.current;
    if (!nds.some((n) => n.id === entity.srn)) {
      const idx = nds.length;
      const x = 40 + (idx % 5) * 210;
      const y = 40 + Math.floor(idx / 5) * 140;
      const node: GraphNode = {
        srn: entity.srn, type: entity.entityType, id: entity.entityId, title: entity.title,
        emoji: entity.emoji, color: entity.color, deepLink: entity.deepLink,
        degree: 0, pagerank: 0, community: null, status: entity.status, isArchived: entity.isArchived,
      };
      const next = [...nds, buildEntityRfNode(entity.srn, x, y, node)];
      rfNodesRef.current = next; // synchronous, same reasoning as removeNode above
      setRfNodes(next);
      void persistLayout();

      // Connect it to whatever's already on the canvas, not just future nodes —
      // openCanvas() only computes edges once at load time, so a freshly-added
      // node needs its own lookup against the nodes already placed.
      const placedSrns = new Set(next.map((n) => n.id));
      apiGetEntityLinks(entity.entityType, entity.entityId)
        .then((r) => {
          const newEdges: RFEdge[] = Object.values(r.linksByType).flat()
            .filter((l) => l.neighbor && placedSrns.has(l.direction === 'out' ? l.dst : l.src))
            .map((l) => ({
              id: l.id, source: l.direction === 'out' ? l.src : l.dst, target: l.direction === 'out' ? l.dst : l.src,
              style: { stroke: l.isCrossWorkspace ? 'var(--color-warning)' : 'var(--color-purple-tint-3, #c4b8f0)', strokeWidth: 1.5 },
            }));
          if (newEdges.length) setRfEdges((eds) => [...eds, ...newEdges.filter((e) => !eds.some((existing) => existing.id === e.id))]);
        })
        .catch(() => { /* edge enrichment is best-effort — the node is already placed either way */ });
    }
    setAdding(false);
    setAddQuery('');
    setAddActiveIndex(0);
  }, [buildEntityRfNode, persistLayout]);

  const onConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    try {
      await apiCreateLink({ src: connection.source, dst: connection.target, linkType: 'relates_to' });
      setRfEdges((eds) => [...eds, { id: `${connection.source}-${connection.target}`, source: connection.source!, target: connection.target! }]);
    } catch {
      // creation failed (permission/visibility) — no drawn edge without a real link, by design
    }
  }, []);

  if (!workspaceId) return null;

  if (!active) {
    return (
      <div style={{ padding: '4px 2px', height: '100%', overflowY: 'auto', animation: 'sectionFadeUp 320ms cubic-bezier(0.22,1,0.36,1) both' }}>
        <button
          onClick={() => setCreating(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 18, transition: 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)' }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Icon name="add" size={16} color="var(--color-white)" /> New canvas
        </button>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {canvases.map((c, i) => (
            <button
              key={c.id}
              onClick={() => void openCanvas(c.id)}
              style={{ padding: 16, borderRadius: 12, border: '1.5px solid var(--color-purple-pale-34)', background: 'var(--color-white)', textAlign: 'left', cursor: 'pointer', transition: 'border-color 150ms, background 150ms, transform 150ms cubic-bezier(0.34,1.56,0.64,1)', animation: `menuItemIn 200ms ease ${i * 30}ms both` }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-purple-pale-34)'; e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <div style={{ fontWeight: 700, fontFamily: 'var(--font-heading)', fontSize: 13.5, color: 'var(--color-text-primary)' }}>{c.emoji ?? '⬡'} {c.name}</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{c.layout.nodes.length} nodes</div>
            </button>
          ))}
          {canvases.length === 0 && (
            <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 20px', color: 'var(--color-text-quaternary)', textAlign: 'center' }}>
              <Icon name="dashboard_customize" size={36} color="var(--color-purple-tint-3, #c4b8f0)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>No canvases yet</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 320 }}>Create one to start arranging your graph freely. Dragging a connection between two nodes creates a real, backlink-visible relation.</div>
            </div>
          )}
        </div>
        {creating && (
          <RenameDialog
            value=""
            title="New Canvas"
            onSave={(name) => void createCanvas(name)}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', position: 'relative', background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.04)', overflow: 'hidden', animation: 'cardIn 320ms cubic-bezier(0.22,1,0.36,1) both' }}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => setActive(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', boxShadow: '0 2px 8px rgba(var(--color-black-rgb), 0.06)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer', transition: 'all 150ms' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
        >
          <Icon name="arrow_back" size={14} /> All canvases
        </button>
        <span style={{ padding: '6px 10px', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>{saving ? 'Saving…' : active.name}</span>
      </div>

      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 5 }}>
        <button
          onClick={() => setAdding((a) => !a)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', boxShadow: '0 2px 8px rgba(var(--color-black-rgb), 0.06)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-white)', cursor: 'pointer' }}
        >
          <Icon name="add" size={14} color="var(--color-white)" /> Add node
        </button>
        {adding && (
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 260, padding: 8, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-white)', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', animation: 'menuIn 160ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <input
              autoFocus
              value={addQuery}
              onChange={(e) => { setAddQuery(e.target.value); setAddActiveIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAdding(false); setAddQuery(''); return; }
                if (!addResults.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); setAddActiveIndex((i) => (i + 1) % addResults.length); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setAddActiveIndex((i) => (i - 1 + addResults.length) % addResults.length); }
                else if (e.key === 'Enter') { e.preventDefault(); addEntityToCanvas(addResults[addActiveIndex]); }
              }}
              placeholder="Search a board, task, page…"
              style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 12.5, border: '1px solid var(--color-border)', borderRadius: 7, padding: '6px 8px', outline: 'none', boxSizing: 'border-box' }}
            />
            <LinkPicker
              query={addQuery}
              results={addResults}
              loading={addLoading}
              activeIndex={addActiveIndex}
              onHover={setAddActiveIndex}
              onPick={addEntityToCanvas}
              emptyHint="Type to find something to place on this canvas"
              style={{ position: 'static', width: '100%', boxShadow: 'none', border: 'none', padding: 0, marginTop: 6, animation: 'none' }}
            />
          </div>
        )}
      </div>

      {rfNodes.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', pointerEvents: 'none', zIndex: 1 }}>
          <Icon name="dashboard_customize" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>This canvas is empty</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Click "Add node" to place a board, task, or page here, then drag to arrange and drag between them to connect.</div>
        </div>
      )}

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={RF_NODE_TYPES}
        onNodesChange={(changes) => setRfNodes((nds) => {
          const next = [...nds];
          for (const ch of changes) {
            if (ch.type === 'position' && ch.position) {
              const idx = next.findIndex((n) => n.id === ch.id);
              if (idx >= 0) next[idx] = { ...next[idx], position: ch.position };
            }
          }
          return next;
        })}
        onNodeDragStop={() => void persistLayout()}
        onConnect={(c) => void onConnect(c)}
        nodesConnectable
        nodesDraggable
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} color="var(--color-purple-pale-34, #f0edff)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export default function GraphScreen() {
  const isMobile = useMobile();
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const view = useUserPrefsStore((s) => (workspaceId ? s.graphViewByWorkspace[workspaceId] : undefined)) ?? 'explore';
  const setGraphViewForWorkspace = useUserPrefsStore((s) => s.setGraphViewForWorkspace);

  const setView = useCallback((v: 'explore' | 'canvas') => {
    if (workspaceId) setGraphViewForWorkspace(workspaceId, v);
  }, [workspaceId, setGraphViewForWorkspace]);

  const tabs = useMemo(() => ([
    { key: 'explore' as const, label: 'Explore', icon: 'hub' },
    { key: 'canvas' as const, label: 'Canvas', icon: 'dashboard_customize' },
  ]), []);

  if (!workspaceId) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Select a workspace to see its graph.</div>;
  }

  return (
    <div style={{ padding: isMobile ? 12 : 24, height: '100%', width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>Net</h1>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--color-surface-tint)', borderRadius: 10 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none',
                background: view === t.key ? 'var(--color-white)' : 'transparent', fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer',
                color: view === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                boxShadow: view === t.key ? '0 1px 4px rgba(var(--color-black-rgb), 0.08)' : 'none',
                transition: 'all 150ms',
              }}
            >
              <Icon name={t.icon} size={15} color={view === t.key ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {view === 'explore' ? <ExploreView isMobile={isMobile} /> : <CanvasView isMobile={isMobile} />}
      </div>
    </div>
  );
}
