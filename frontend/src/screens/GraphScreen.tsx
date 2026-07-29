import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Node as RFNode, type Edge as RFEdge, type Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMobile } from '../hooks/useBreakpoint';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useGraphStore from '../store/useGraphStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import Icon from '../components/Icon';
import RenameDialog from '../components/RenameDialog';
import FlowGraph from '../components/graph/FlowGraph';
import SigmaGraph from '../components/graph/SigmaGraph';
import GraphControls from '../components/graph/GraphControls';
import NodeInspector from '../components/graph/NodeInspector';
import { shouldUseSigma } from '../utils/graphLayout';
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
    <div style={{ display: 'flex', gap: 14, height: '100%', width: '100%', minWidth: 0, flexDirection: isMobile ? 'column' : 'row' }}>
      {!isMobile && <GraphControls isMobile={isMobile} />}
      <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 400, position: 'relative', background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.04)', overflow: 'hidden', animation: 'cardIn 320ms cubic-bezier(0.22,1,0.36,1) both' }}>
        {focusSrn && (
          <button
            onClick={() => { focusNode(null); if (workspaceId) void loadWorkspaceGraph(workspaceId); }}
            style={{ position: 'absolute', top: 12, left: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', boxShadow: '0 2px 8px rgba(var(--color-black-rgb), 0.06)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer', transition: 'all 150ms' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
          >
            <Icon name="arrow_back" size={14} /> Full graph
          </button>
        )}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-heading)', fontSize: 13 }}>
            <div style={{ width: 16, height: 16, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            Loading…
          </div>
        )}
        {!loading && allNodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', animation: 'sectionFadeUp 320ms ease both' }}>
            <Icon name="hub" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>No connections yet</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Link boards, pages, and tasks together to see them appear here.</div>
          </div>
        )}
        {!loading && allNodes.length > 0 && (
          nodes.length === 0 ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', animation: 'sectionFadeUp 320ms ease both' }}>
              <Icon name="visibility_off" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Nothing matches your filters</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, maxWidth: 280, textAlign: 'center' }}>Try showing unconnected nodes or widening the entity-type filter.</div>
            </div>
          ) : useSigma
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
  const [creating, setCreating] = useState(false);

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

  const createCanvas = useCallback(async (name: string) => {
    if (!workspaceId || !name.trim()) { setCreating(false); return; }
    const r = await apiCreateCanvas({ workspaceId, name: name.trim() });
    setCanvases((c) => [r.canvas, ...c]);
    setCreating(false);
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
