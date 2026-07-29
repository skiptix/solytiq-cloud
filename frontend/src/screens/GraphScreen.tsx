import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Node as RFNode, type Edge as RFEdge, type Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMobile } from '../hooks/useBreakpoint';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useGraphStore from '../store/useGraphStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import Icon from '../components/Icon';
import FlowGraph from '../components/graph/FlowGraph';
import SigmaGraph from '../components/graph/SigmaGraph';
import GraphControls from '../components/graph/GraphControls';
import NodeInspector from '../components/graph/NodeInspector';
import { shouldUseSigma, nodeColor } from '../utils/graphLayout';
import { apiGetCanvases, apiCreateCanvas, apiGetCanvas, apiUpdateCanvas, apiCreateLink } from '../api/client';
import type { GraphNode, GraphCanvas } from '../types';

function ExploreView({ isMobile }: { isMobile: boolean }) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { loadWorkspaceGraph, loadLocalGraph, focusSrn, focusNode, visibleNodes, visibleEdges, loading, allNodes } = useGraphStore();
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    if (workspaceId) void loadWorkspaceGraph(workspaceId);
  }, [workspaceId, loadWorkspaceGraph]);

  const nodes = visibleNodes();
  const edges = visibleEdges();
  const useSigma = shouldUseSigma(nodes.length) && !focusSrn;

  const handleNodeClick = useCallback((n: GraphNode) => setSelected(n), []);
  const handleFocus = useCallback((srn: string) => {
    void loadLocalGraph(srn);
    setSelected(null);
  }, [loadLocalGraph]);

  if (!workspaceId) return null;

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', flexDirection: isMobile ? 'column' : 'row' }}>
      {!isMobile && <GraphControls isMobile={isMobile} />}
      <div style={{ flex: 1, minHeight: 400, position: 'relative', background: '#fff', borderRadius: 14, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
        {focusSrn && (
          <button
            onClick={() => { focusNode(null); if (workspaceId) void loadWorkspaceGraph(workspaceId); }}
            style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            <Icon name="arrow_back" size={14} /> Full graph
          </button>
        )}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)' }}>Loading…</div>
        )}
        {!loading && allNodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)' }}>
            <Icon name="hub" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600 }}>No connections yet</div>
            <div style={{ fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Link boards, pages, and tasks together to see them appear here.</div>
          </div>
        )}
        {!loading && allNodes.length > 0 && (
          useSigma
            ? <SigmaGraph nodes={nodes} edges={edges} onNodeClick={handleNodeClick} />
            : <FlowGraph nodes={nodes} edges={edges} focusSrn={focusSrn} mode={focusSrn ? 'local' : 'explore'} onNodeClick={handleNodeClick} />
        )}
      </div>
      {selected && !isMobile && <NodeInspector node={selected} onClose={() => setSelected(null)} onFocus={handleFocus} />}
    </div>
  );
}

function CanvasView({ isMobile }: { isMobile: boolean }) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [canvases, setCanvases] = useState<GraphCanvas[]>([]);
  const [active, setActive] = useState<GraphCanvas | null>(null);
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    apiGetCanvases(workspaceId).then((r) => setCanvases(r.canvases)).catch(() => setCanvases([]));
  }, [workspaceId]);

  const openCanvas = useCallback(async (id: string) => {
    const r = await apiGetCanvas(id);
    setActive(r.canvas);
    setRfNodes(r.canvas.layout.nodes.map((n) => ({
      id: n.srn, position: { x: n.x, y: n.y },
      data: { label: n.srn.split(':').slice(-1)[0] },
      style: { padding: 8, borderRadius: 8, border: '2px solid var(--color-primary)', fontSize: 12, background: '#fff' },
    })));
    setRfEdges([]);
  }, []);

  const createCanvas = useCallback(async () => {
    if (!workspaceId) return;
    const name = window.prompt('Canvas name');
    if (!name?.trim()) return;
    const r = await apiCreateCanvas({ workspaceId, name: name.trim() });
    setCanvases((c) => [r.canvas, ...c]);
    void openCanvas(r.canvas.id);
  }, [workspaceId, openCanvas]);

  const persistLayout = useCallback(async (nodes: RFNode[]) => {
    if (!active) return;
    setSaving(true);
    try {
      const layout = { version: 1 as const, nodes: nodes.map((n) => ({ srn: n.id, x: n.position.x, y: n.position.y })), groups: active.layout.groups ?? [], notes: active.layout.notes ?? [] };
      const r = await apiUpdateCanvas(active.id, { layout, version: active.version });
      setActive(r.canvas);
    } catch {
      // conflict or transient failure — the canvas stays open, next drag retries with the latest version
    } finally {
      setSaving(false);
    }
  }, [active]);

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
      <div style={{ padding: 20 }}>
        <button onClick={createCanvas} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 16 }}>
          + New canvas
        </button>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {canvases.map((c) => (
            <button key={c.id} onClick={() => void openCanvas(c.id)} style={{ padding: 16, borderRadius: 12, border: '1px solid var(--color-border)', background: '#fff', textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700, fontFamily: 'var(--font-heading)' }}>{c.emoji ?? '⬡'} {c.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{c.layout.nodes.length} nodes</div>
            </button>
          ))}
          {canvases.length === 0 && <div style={{ color: 'var(--color-text-quaternary)', fontSize: 13 }}>No canvases yet — create one to start arranging your graph freely. Dragging a connection between two nodes creates a real, backlink-visible relation.</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', position: 'relative', background: '#fff', borderRadius: 14, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', gap: 8 }}>
        <button onClick={() => setActive(null)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          ← All canvases
        </button>
        <span style={{ padding: '6px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{saving ? 'Saving…' : active.name}</span>
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
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
        onNodeDragStop={(_, __, nodes) => void persistLayout(nodes.length ? rfNodes : rfNodes)}
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
    <div style={{ padding: isMobile ? 12 : 24, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, margin: 0 }}>Net</h1>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--color-surface-tint)', borderRadius: 10 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none',
                background: view === t.key ? '#fff' : 'transparent', fontWeight: 600, fontSize: 12.5, cursor: 'pointer',
                color: view === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              }}
            >
              <Icon name={t.icon} size={15} color={view === t.key ? nodeColor('list') : 'var(--color-text-tertiary)'} />
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === 'explore' ? <ExploreView isMobile={isMobile} /> : <CanvasView isMobile={isMobile} />}
      </div>
    </div>
  );
}
