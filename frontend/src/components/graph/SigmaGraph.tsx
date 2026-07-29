// WebGL renderer for large graphs (> SIGMA_THRESHOLD_NODES, see graphLayout.ts).
// Uses the low-level `sigma` + `graphology` APIs directly (rather than
// @react-sigma/core's React bindings) since that surface is the most stable
// across versions and this component's lifecycle (mount container, run
// ForceAtlas2 in a Web Worker, tear down on unmount) is simple enough not to
// need a wrapper. @react-sigma/core stays a listed dependency for a future
// richer integration (hover cards, in-canvas React overlays).
import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import type { GraphNode, GraphEdge } from '../../types';
import { nodeColor, nodeSize } from '../../utils/graphLayout';

export default function SigmaGraph({
  nodes, edges, onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (node: GraphNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const graph = new Graph({ multi: false, type: 'directed' });

    for (const n of nodes) {
      if (graph.hasNode(n.srn)) continue;
      graph.addNode(n.srn, {
        label: n.title || 'Untitled',
        size: Math.max(nodeSize(n.degree), 3),
        color: nodeColor(n.type, n.status),
        x: Math.random(), y: Math.random(),
      });
    }
    for (const e of edges) {
      if (!graph.hasNode(e.src) || !graph.hasNode(e.dst) || graph.hasEdge(e.src, e.dst)) continue;
      graph.addEdge(e.src, e.dst, { size: 1, color: e.crossWorkspace ? '#d97706' : '#e8e4f0' });
    }

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelRenderedSizeThreshold: 6,
      defaultEdgeType: 'arrow',
    });
    sigma.on('clickNode', ({ node }) => {
      const found = nodes.find((n) => n.srn === node);
      if (found) onNodeClick(found);
    });
    sigmaRef.current = sigma;

    const layout = new FA2Layout(graph, { settings: { gravity: 1, scalingRatio: 10 } });
    layout.start();
    layoutRef.current = layout;
    // Stop after 2s, matching the design doc's "auto-stops on convergence or
    // after ~2s" rule — FA2Layout has no built-in convergence signal here, so
    // a fixed timeout is the pragmatic stand-in.
    const stopTimer = setTimeout(() => layout.stop(), 2000);

    return () => {
      clearTimeout(stopTimer);
      layout.stop();
      layout.kill();
      sigma.kill();
      sigmaRef.current = null;
      layoutRef.current = null;
    };
  }, [nodes, edges, onNodeClick]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <button
        onClick={() => {
          if (!layoutRef.current) return;
          layoutRef.current.start();
          setTimeout(() => layoutRef.current?.stop(), 2000);
        }}
        style={{
          position: 'absolute', bottom: 12, left: 12, zIndex: 5, padding: '6px 12px', borderRadius: 8,
          border: '1px solid var(--color-border)', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}
      >
        Recompute layout
      </button>
    </div>
  );
}
