// ---------------------------------------------------------------------------
// NeuralGraph — the Net view's primary renderer. A hand-rolled SVG force
// simulation (see utils/forceSimulation.ts) instead of a static layout, so
// the graph continuously drifts like a living network rather than sitting
// frozen. The workspace root is always pinned at the world origin and every
// other node is connected to it through the structural hierarchy
// (hooks/useGraphHierarchy.ts) — items -> sections -> lists -> folders ->
// workspace — with real entity_links relations layered on top as a second,
// more prominent edge class.
//
// Positions are pushed to the DOM imperatively every animation frame
// (SVG `transform` attributes, not React state) so 60fps motion never
// triggers a React re-render; React only re-renders on hover/selection
// changes, which are rare.
// ---------------------------------------------------------------------------

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { GraphEdge } from '../../types';
import type { GraphHierarchy, NetRenderNode } from '../../utils/graphHierarchy';
import { hierarchyLinkDistance, nodeColor, nodeIcon, nodeSize } from '../../utils/graphLayout';
import { LABEL_MAX_CHARS, planLabels, type LabelCandidate } from '../../utils/graphLabels';
import useForceSimulation from '../../hooks/useForceSimulation';
import type { SimLink, SimNodeSpec } from '../../utils/forceSimulation';
import Icon from '../Icon';
import NodeInspector from './NodeInspector';
import PopIn from '../animate-ui/PopIn';
import MotionButton from '../animate-ui/MotionButton';
import { animate, motion, useReducedMotion } from '../animate-ui/motion';
import { EASE_OUT_CUBIC, EASE_SPRING, EASE_STANDARD } from '../animate-ui/motionTokens';

const MIN_K = 0.2;
const MAX_K = 3;
const ROOT_RADIUS = 32;

// ── spacing ────────────────────────────────────────────────────────────
// Hierarchy spring lengths come from utils/graphLayout.ts's
// hierarchyLinkDistance (pure + tested) — see that module for why a fixed rest
// length collapses large sibling sets into an unreadable ring.
const HIERARCHY_SPRING_STRENGTH = 0.12;
const RELATION_DISTANCE = 150;
const RELATION_SPRING_STRENGTH = 0.045;
/** Personal space beyond the dot itself, so labels have somewhere to live. */
const NODE_CLEARANCE = 16;

// ── labels ─────────────────────────────────────────────────────────────
// Label sizing/culling math lives in utils/graphLabels.ts (pure + tested);
// this file only applies its output to the DOM. See that module's header for
// why labels are counter-scaled and occlusion-culled rather than drawn at a
// fixed size.
/** Frames between occlusion passes — motion is slow, so this is imperceptible. */
const LABEL_PASS_INTERVAL = 3;

export interface NeuralGraphHandle {
  centerOn: (srn: string) => void;
  resetCamera: () => void;
  /** Whether the simulation has (yet) seeded a position for this node — lets a caller poll until a just-requested centerOn can actually take effect. */
  hasNode: (srn: string) => boolean;
}

interface Camera { x: number; y: number; k: number }

interface NeuralGraphProps {
  /** Includes the synthetic workspace-root node (type 'workspace'). */
  nodes: NetRenderNode[];
  hierarchy: GraphHierarchy;
  relationEdges: GraphEdge[];
  workspaceRootSrn: string;
  workspaceId: string;
  selectedSrn?: string | null;
  onNodeClick: (node: NetRenderNode) => void;
  onNodeOpen: (node: NetRenderNode) => void;
  onBackgroundClick?: () => void;
  pinnedPositions?: Record<string, { x: number; y: number }>;
  onNodePin?: (srn: string, x: number, y: number) => void;
}

function worldToScreen(cam: Camera, w: number, h: number, x: number, y: number) {
  return { x: w / 2 + cam.x + x * cam.k, y: h / 2 + cam.y + y * cam.k };
}
function screenToWorld(cam: Camera, w: number, h: number, sx: number, sy: number) {
  return { x: (sx - w / 2 - cam.x) / cam.k, y: (sy - h / 2 - cam.y) / cam.k };
}

const NeuralGraph = forwardRef<NeuralGraphHandle, NeuralGraphProps>(function NeuralGraph(
  { nodes, hierarchy, relationEdges, workspaceRootSrn, workspaceId, selectedSrn, onNodeClick, onNodeOpen, onBackgroundClick, pinnedPositions, onNodePin },
  ref
) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const nodeElRefs = useRef(new Map<string, SVGGElement>());
  /** Keyed by the edge's own unique id (not src__dst — two edges, e.g. a
   *  hierarchy edge and a relation edge, can share the same endpoints). */
  const edgeElRefs = useRef(new Map<string, { el: SVGLineElement; src: string; dst: string }>());
  const [size, setSize] = useState({ w: 800, h: 600 });
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const [hoveredSrn, setHoveredSrn] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ srn: string; x: number; y: number } | null>(null);
  const [anchorPos, setSelectedAnchor] = useState<{ x: number; y: number } | null>(null);
  // Derived rather than cleared by an effect: an anchor only means anything
  // while something is selected, so tying it to selectedSrn at render removes
  // the reset-state-in-an-effect round trip entirely.
  const selectedAnchor = selectedSrn ? anchorPos : null;

  const nodeBySrn = useMemo(() => new Map(nodes.map((n) => [n.srn, n])), [nodes]);
  const selectedNode = selectedSrn ? nodeBySrn.get(selectedSrn) : null;

  /** Root -> ... -> node, inclusive. Feeds the details popup's breadcrumb. */
  const breadcrumbFor = useCallback((srn: string): NetRenderNode[] => {
    const chain: NetRenderNode[] = [];
    let cur: string | undefined = srn;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n = nodeBySrn.get(cur);
      if (!n) break;
      chain.unshift(n);
      if (cur === workspaceRootSrn) break;
      cur = hierarchy.parentOf.get(cur);
    }
    return chain;
  }, [nodeBySrn, hierarchy, workspaceRootSrn]);

  // ── container sizing ──────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: Math.max(box.width, 100), h: Math.max(box.height, 100) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── camera application + smooth tween helper ───────────────────────
  const applyCamera = useCallback(() => {
    if (viewportRef.current) {
      const c = cameraRef.current;
      viewportRef.current.setAttribute('transform', `translate(${size.w / 2 + c.x} ${size.h / 2 + c.y}) scale(${c.k})`);
    }
  }, [size.w, size.h]);
  useEffect(() => { applyCamera(); }, [applyCamera]);

  // Motion's imperative `animate()` over the plain camera object, rather than
  // a hand-rolled rAF tween. Same curve (EASE_OUT_CUBIC is `1 - (1-p)^3`
  // spelled as its bezier), but it runs inside Motion's frame scheduler
  // alongside every other animation instead of racing it, and the returned
  // controls replace the manual cancelAnimationFrame bookkeeping.
  const tweenRef = useRef<{ stop: () => void } | null>(null);
  const animateCameraTo = useCallback((target: Camera, ms = 420) => {
    tweenRef.current?.stop();
    tweenRef.current = animate(cameraRef.current, target, {
      duration: ms / 1000,
      ease: EASE_OUT_CUBIC,
      onUpdate: applyCamera,
    });
  }, [applyCamera]);
  useEffect(() => () => tweenRef.current?.stop(), []);

  // ── simulation data ──────────────────────────────────────────────
  // infoWeight (see GraphNode) is an opt-in bonus — unset/0 for ordinary Net
  // nodes, so this is a strict no-op there and only changes sizing where a
  // caller (the Knowledge page) actually populates it.
  const visualDegree = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.srn, (hierarchy.childCount.get(n.srn) ?? 0) + n.degree + (hierarchy.parentOf.has(n.srn) ? 1 : 0) + (n.infoWeight ?? 0));
    return m;
  }, [nodes, hierarchy]);

  const nodeSpecs: SimNodeSpec[] = useMemo(() => nodes.map((n) => {
    const isRoot = n.srn === workspaceRootSrn;
    const radius = isRoot ? ROOT_RADIUS : Math.max(nodeSize(visualDegree.get(n.srn) ?? 0), 8);
    const depth = hierarchy.depthOf.get(n.srn) ?? 0;
    const pin = isRoot ? { x: 0, y: 0 } : pinnedPositions?.[n.srn];
    return { id: n.srn, radius, collisionRadius: radius + NODE_CLEARANCE, depth, pinned: pin };
  }), [nodes, hierarchy, visualDegree, workspaceRootSrn, pinnedPositions]);

  const radiusBySrn = useMemo(() => new Map(nodeSpecs.map((s) => [s.id, s.radius])), [nodeSpecs]);

  /** Each child's slot among its siblings — what lets hierarchyLinkDistance()
   *  turn a fixed rest length into a count-aware set of shells. Sorted so the
   *  assignment is stable across re-renders and the layout doesn't churn. */
  const siblingSlot = useMemo(() => {
    const byParent = new Map<string, string[]>();
    for (const e of hierarchy.edges) {
      const arr = byParent.get(e.src);
      if (arr) arr.push(e.dst); else byParent.set(e.src, [e.dst]);
    }
    const slots = new Map<string, { index: number; count: number }>();
    for (const children of byParent.values()) {
      children.sort();
      children.forEach((c, index) => slots.set(c, { index, count: children.length }));
    }
    return slots;
  }, [hierarchy]);

  const links: SimLink[] = useMemo(() => {
    const out: SimLink[] = hierarchy.edges.map((e) => {
      const { index, count } = siblingSlot.get(e.dst) ?? { index: 0, count: 1 };
      const distance = hierarchyLinkDistance({
        parentRadius: radiusBySrn.get(e.src) ?? 10,
        siblingIndex: index,
        siblingCount: count,
        depth: e.depth,
      });
      return { source: e.src, target: e.dst, distance, strength: HIERARCHY_SPRING_STRENGTH };
    });
    for (const e of relationEdges) {
      if (nodeBySrn.has(e.src) && nodeBySrn.has(e.dst)) out.push({ source: e.src, target: e.dst, distance: RELATION_DISTANCE, strength: RELATION_SPRING_STRENGTH });
    }
    return out;
  }, [hierarchy, relationEdges, nodeBySrn, siblingSlot, radiusBySrn]);

  // ── highlight set (hover, falling back to selection) ────────────────
  const focusSrn = hoveredSrn ?? selectedSrn ?? null;
  const highlightNeighbors = useMemo(() => {
    if (!focusSrn) return null;
    const set = new Set<string>([focusSrn]);
    for (const l of links) {
      if (l.source === focusSrn) set.add(l.target);
      if (l.target === focusSrn) set.add(l.source);
    }
    return set;
  }, [focusSrn, links]);

  // ── label sizing + occlusion culling ────────────────────────────────
  // Everything here is imperative and driven off the RAF loop for the same
  // reason node positions are: it runs continuously and must never trigger a
  // React re-render. The hover/selection state it needs is mirrored into refs
  // rather than closed over, so the pass always sees current values without
  // the callback identity changing every frame.
  const highlightRef = useRef(highlightNeighbors);
  const focusRef = useRef(focusSrn);
  const sizeRef = useRef(size);
  useEffect(() => { highlightRef.current = highlightNeighbors; }, [highlightNeighbors]);
  useEffect(() => { focusRef.current = focusSrn; }, [focusSrn]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  const labelElRefs = useRef(new Map<string, SVGTextElement>());
  const labelPassFrame = useRef(0);

  /** Static priority order: the root first, then best-connected first — so when
   *  space is tight the labels that survive are the ones that orient you. */
  const labelOrder = useMemo<LabelCandidate[]>(() => nodes
    .map((n) => ({
      srn: n.srn,
      radius: n.srn === workspaceRootSrn ? ROOT_RADIUS : Math.max(nodeSize(visualDegree.get(n.srn) ?? 0), 8),
      length: Math.min((n.title || 'Untitled').length, LABEL_MAX_CHARS),
      isRoot: n.srn === workspaceRootSrn,
      weight: visualDegree.get(n.srn) ?? 0,
    }))
    .sort((a, b) => (Number(b.isRoot) - Number(a.isRoot)) || (b.weight - a.weight) || a.srn.localeCompare(b.srn)),
  [nodes, visualDegree, workspaceRootSrn]);

  /**
   * Last visibility this pass decided per label, so the fade below only starts
   * on an actual change. The `<text>` cannot be a `motion.text` with a
   * declarative opacity: this pass owns opacity frame by frame, and a React
   * re-render carrying Motion's own idea of the value would clobber it.
   * Motion's imperative `animate()` on the element is the right half of the
   * API for that — it replaces the CSS `transition: opacity 220ms` this used
   * to lean on, without handing the property to the declarative renderer.
   */
  const labelVisible = useRef(new Map<string, boolean>());
  const labelFades = useRef(new Map<string, { stop: () => void }>());

  const updateLabels = useCallback((positions: Map<string, { x: number; y: number }>) => {
    const plan = planLabels(labelOrder, positions, cameraRef.current, sizeRef.current, {
      focus: focusRef.current,
      highlight: highlightRef.current,
    });
    for (const placement of plan) {
      const el = labelElRefs.current.get(placement.srn);
      if (!el) continue;
      if (labelVisible.current.get(placement.srn) !== placement.visible) {
        labelVisible.current.set(placement.srn, placement.visible);
        labelFades.current.get(placement.srn)?.stop();
        labelFades.current.set(placement.srn, animate(
          el,
          { opacity: placement.visible ? 1 : 0 },
          { duration: 0.22, ease: EASE_STANDARD }
        ));
      }
      // Skip the layout writes for a label nobody can see — most of them, most
      // of the time, on a large graph.
      if (!placement.visible) continue;
      el.style.fontSize = `${placement.fontSize}px`;
      el.style.strokeWidth = `${placement.strokeWidth}px`;
      el.setAttribute('y', String(placement.y));
    }
  }, [labelOrder]);

  useEffect(() => {
    const fades = labelFades.current;
    return () => { for (const f of fades.values()) f.stop(); fades.clear(); };
  }, []);

  // ── RAF-driven imperative position updates ──────────────────────────
  // moved() only re-renders React when a screen position shifts by more than
  // a fraction of a pixel — now that the simulation settles (see
  // utils/forceSimulation.ts's alpha cooling), a stationary node shouldn't
  // still be forcing 60 renders/sec on whatever's anchored to it.
  const moved = (a: { x: number; y: number } | null, b: { x: number; y: number }) =>
    !a || Math.abs(a.x - b.x) > 0.2 || Math.abs(a.y - b.y) > 0.2;

  const onTick = useCallback((positions: Map<string, { x: number; y: number }>) => {
    for (const [srn, el] of nodeElRefs.current) {
      const p = positions.get(srn);
      if (p) el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
    for (const { el, src, dst } of edgeElRefs.current.values()) {
      const a = positions.get(src);
      const b = positions.get(dst);
      if (a && b) {
        el.setAttribute('x1', a.x.toFixed(1)); el.setAttribute('y1', a.y.toFixed(1));
        el.setAttribute('x2', b.x.toFixed(1)); el.setAttribute('y2', b.y.toFixed(1));
      }
    }
    labelPassFrame.current = (labelPassFrame.current + 1) % LABEL_PASS_INTERVAL;
    if (labelPassFrame.current === 0) updateLabels(positions);
    if (tooltip) {
      const p = positions.get(tooltip.srn);
      if (p) {
        const screen = worldToScreen(cameraRef.current, size.w, size.h, p.x, p.y);
        setTooltip((t) => (t && t.srn === tooltip.srn && moved(t, screen) ? { ...t, x: screen.x, y: screen.y } : t));
      }
    }
    if (selectedSrn) {
      const p = positions.get(selectedSrn);
      if (p) {
        const screen = worldToScreen(cameraRef.current, size.w, size.h, p.x, p.y);
        setSelectedAnchor((a) => (moved(a, screen) ? screen : a));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooltip?.srn, selectedSrn, size.w, size.h, updateLabels]);

  const simRef = useForceSimulation(nodeSpecs, links, onTick, true);

  useImperativeHandle(ref, () => ({
    centerOn: (srn: string) => {
      const pos = simRef.current.nodes.get(srn);
      if (!pos) return;
      const k = Math.max(cameraRef.current.k, 1.1);
      animateCameraTo({ x: -pos.x * k, y: -pos.y * k, k });
    },
    resetCamera: () => animateCameraTo({ x: 0, y: 0, k: 1 }),
    hasNode: (srn: string) => simRef.current.nodes.has(srn),
  }), [animateCameraTo, simRef]);

  // ── pan / zoom / drag interaction ───────────────────────────────────
  // Pointer Events + setPointerCapture, not raw mouse events on `window` —
  // capture guarantees this element keeps receiving move/up for the given
  // pointer no matter what ends up under the cursor (including a fast
  // release outside the dragged node, or a re-render swapping listeners
  // mid-gesture), which is what a plain window-level mousemove/mouseup pair
  // can't promise. That gap was the cause of a node getting stuck to the
  // cursor after release instead of dropping where the user let go.
  const dragState = useRef<{ mode: 'pan' | 'node'; srn?: string; startX: number; startY: number; moved: boolean; pointerId: number } | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const before = screenToWorld(cameraRef.current, size.w, size.h, mx, my);
    const factor = Math.exp(-e.deltaY * 0.0016);
    const k = Math.min(Math.max(cameraRef.current.k * factor, MIN_K), MAX_K);
    cameraRef.current = { x: mx - size.w / 2 - before.x * k, y: my - size.h / 2 - before.y * k, k };
    applyCamera();
  }, [applyCamera, size.w, size.h]);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== undefined && e.button !== 0) return; // left button / primary touch only
    const targetEl = (e.target as Element).closest('[data-srn]');
    const srn = targetEl?.getAttribute('data-srn') ?? undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Seed lastPointer to the down position so the first pan delta is measured
    // from here, not from wherever the pointer happened to be at the end of a
    // previous, unrelated gesture. Without this, a move event that crosses the
    // moved-threshold in one jump (routine — pointermove is coarser than 3px)
    // pans by the distance from that stale point instead of the real delta,
    // which reads as the camera "flipping" the instant a drag starts.
    lastPointer.current = { x: e.clientX, y: e.clientY };
    if (srn && srn !== workspaceRootSrn) {
      dragState.current = { mode: 'node', srn, startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    } else {
      dragState.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    }
  }, [workspaceRootSrn]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) { lastPointer.current = { x: e.clientX, y: e.clientY }; return; }

    if (drag.mode === 'pan') {
      const mdx = e.clientX - lastPointer.current.x, mdy = e.clientY - lastPointer.current.y;
      cameraRef.current = { ...cameraRef.current, x: cameraRef.current.x + mdx, y: cameraRef.current.y + mdy };
      applyCamera();
    } else if (drag.mode === 'node' && drag.srn) {
      const rect = containerRef.current!.getBoundingClientRect();
      const world = screenToWorld(cameraRef.current, size.w, size.h, e.clientX - rect.left, e.clientY - rect.top);
      simRef.current.pin(drag.srn, world.x, world.y);
    }
    lastPointer.current = { x: e.clientX, y: e.clientY };
  }, [applyCamera, size.w, size.h, simRef]);

  const endDrag = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (drag.mode === 'node' && drag.srn && drag.moved) {
      const pos = simRef.current.nodes.get(drag.srn);
      if (pos) onNodePin?.(drag.srn, pos.x, pos.y);
    } else if (drag.mode === 'pan' && !drag.moved) {
      onBackgroundClick?.();
    } else if (drag.mode === 'node' && drag.srn && !drag.moved) {
      const node = nodeBySrn.get(drag.srn);
      if (node) onNodeClick(node);
    }
    dragState.current = null;
  }, [simRef, onNodePin, onBackgroundClick, onNodeClick, nodeBySrn]);

  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, node: NetRenderNode) => {
    e.stopPropagation();
    onNodeOpen(node);
  }, [onNodeOpen]);

  const zoomBy = useCallback((factor: number) => {
    const k = Math.min(Math.max(cameraRef.current.k * factor, MIN_K), MAX_K);
    animateCameraTo({ ...cameraRef.current, k }, 180);
  }, [animateCameraTo]);

  // ── render ───────────────────────────────────────────────────────
  const hierarchyEdgeList = hierarchy.edges;
  const hoveredNode = hoveredSrn ? nodeBySrn.get(hoveredSrn) : null;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'grab', touchAction: 'none',
        // Panning/dragging on a canvas full of <text> labels otherwise
        // triggers the browser's native text-selection highlight on every
        // click-drag, which has nothing to do with selecting a node.
        userSelect: 'none', WebkitUserSelect: 'none', MozUserSelect: 'none',
      }}
    >
      <svg
        width={size.w} height={size.h}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ display: 'block', background: 'var(--color-white)', touchAction: 'none', userSelect: 'none' }}
      >
        <defs>
          <pattern id="netDotGrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1.3" cy="1.3" r="1.3" fill="var(--color-border, #e8e4f0)" />
          </pattern>
        </defs>
        <g ref={viewportRef}>
          {/* World-space dotted grid — pans/zooms with the content, same convention as the Canvas tab's React Flow <Background>. */}
          <rect x={-6000} y={-6000} width={12000} height={12000} fill="url(#netDotGrid)" />
          <g>
            {hierarchyEdgeList.map((e) => (
              <line
                key={e.id}
                ref={(el) => { if (el) edgeElRefs.current.set(e.id, { el, src: e.src, dst: e.dst }); else edgeElRefs.current.delete(e.id); }}
                stroke="var(--color-purple-pale-34, #ece8f4)"
                strokeWidth={highlightNeighbors && highlightNeighbors.has(e.src) && highlightNeighbors.has(e.dst) ? 1.75 : 1}
                opacity={!highlightNeighbors ? 0.85 : (highlightNeighbors.has(e.src) && highlightNeighbors.has(e.dst) ? 0.9 : 0.15)}
              />
            ))}
            {relationEdges.map((e) => {
              if (!nodeBySrn.has(e.src) || !nodeBySrn.has(e.dst)) return null;
              const active = !!highlightNeighbors && highlightNeighbors.has(e.src) && highlightNeighbors.has(e.dst);
              return (
                <motion.line
                  key={`r:${e.id}`}
                  ref={(el) => { const key = `r:${e.id}`; if (el) edgeElRefs.current.set(key, { el, src: e.src, dst: e.dst }); else edgeElRefs.current.delete(key); }}
                  stroke={e.crossWorkspace ? 'var(--color-warning)' : 'var(--color-primary)'}
                  strokeWidth={active ? 2.5 : 1.5}
                  strokeDasharray={active ? '5 4' : undefined}
                  // Dash flow marks the highlighted neighbourhood. Purely
                  // decorative, so reduced motion drops it entirely — which is
                  // what the `.net-edge-flow` media-query override did.
                  animate={active && !reduceMotion ? { strokeDashoffset: [0, -24] } : { strokeDashoffset: 0 }}
                  transition={{ duration: 0.9, ease: 'linear', repeat: Infinity }}
                  opacity={!highlightNeighbors ? 0.5 : (active ? 0.95 : 0.08)}
                />
              );
            })}
          </g>
          <g>
            {nodes.map((n) => (
              <NetNode
                key={n.srn}
                node={n}
                radius={radiusBySrn.get(n.srn) ?? 10}
                isRoot={n.srn === workspaceRootSrn}
                isPinned={!!pinnedPositions?.[n.srn]}
                selected={n.srn === selectedSrn}
                hovered={n.srn === hoveredSrn}
                dimmed={!!highlightNeighbors && !highlightNeighbors.has(n.srn)}
                registerRef={(el) => { if (el) nodeElRefs.current.set(n.srn, el); else nodeElRefs.current.delete(n.srn); }}
                registerLabelRef={(el) => { if (el) labelElRefs.current.set(n.srn, el); else labelElRefs.current.delete(n.srn); }}
                onDoubleClick={(e) => handleNodeDoubleClick(e, n)}
                onEnter={() => { setHoveredSrn(n.srn); setTooltip({ srn: n.srn, x: 0, y: 0 }); }}
                onLeave={() => { setHoveredSrn(null); setTooltip(null); }}
              />
            ))}
          </g>
        </g>
      </svg>

      {tooltip && hoveredNode && hoveredSrn !== selectedSrn && (
        // Static anchor wrapper (unanimated) — kept separate from PopIn's own
        // animated transform so the fixed translate(-50%,-100%) positioning
        // isn't clobbered by Motion's per-frame transform composition.
        <div style={{ position: 'absolute', left: tooltip.x, top: tooltip.y - 14, transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 6 }}>
          <PopIn
            duration={120}
            ease="spring"
            style={{
              padding: '6px 10px', borderRadius: 9,
              background: 'rgba(28, 27, 34, 0.92)', color: '#fff', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600,
              whiteSpace: 'nowrap', boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
            }}
          >
            {hoveredNode.title || (hoveredNode.type === 'workspace' ? 'Workspace' : 'Untitled')}
            {hoveredNode.type !== 'workspace' && (
              <span style={{ opacity: 0.7, fontWeight: 500, marginLeft: 6, textTransform: 'capitalize' }}>{hoveredNode.type}</span>
            )}
          </PopIn>
        </div>
      )}

      {selectedNode && selectedAnchor && (
        <NodeInspector
          node={selectedNode}
          breadcrumb={breadcrumbFor(selectedNode.srn)}
          anchor={selectedAnchor}
          containerSize={size}
          workspaceId={workspaceId}
          onClose={() => onBackgroundClick?.()}
          onCenter={() => { const pos = simRef.current.nodes.get(selectedNode.srn); if (pos) { const k = Math.max(cameraRef.current.k, 1.1); animateCameraTo({ x: -pos.x * k, y: -pos.y * k, k }); } }}
          onBreadcrumbClick={(crumb) => onNodeClick(crumb)}
        />
      )}

      <ZoomControls onZoomIn={() => zoomBy(1.35)} onZoomOut={() => zoomBy(1 / 1.35)} onCenter={() => animateCameraTo({ x: 0, y: 0, k: 1 })} />
    </div>
  );
});

export default NeuralGraph;

// ── NetNode ────────────────────────────────────────────────────────────

interface NetNodeProps {
  node: NetRenderNode;
  radius: number;
  isRoot: boolean;
  isPinned: boolean;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  registerRef: (el: SVGGElement | null) => void;
  registerLabelRef: (el: SVGTextElement | null) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
}

const NetNode = memo(function NetNode({ node, radius, isRoot, isPinned, selected, hovered, dimmed, registerRef, registerLabelRef, onDoubleClick, onEnter, onLeave }: NetNodeProps) {
  const reduceMotion = useReducedMotion();
  const color = nodeColor(node.type, node.status);
  const icon = nodeIcon(node.type);
  const scale = hovered ? 1.22 : selected ? 1.1 : 1;
  const iconSize = Math.max(Math.round(radius * 0.95), 10);

  return (
    <g ref={registerRef} data-srn={node.srn} style={{ cursor: isRoot ? 'default' : 'grab' }} onDoubleClick={onDoubleClick} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <motion.g
        animate={{ scale, opacity: dimmed ? 0.18 : 1 }}
        transition={{ scale: { duration: 0.18, ease: EASE_SPRING }, opacity: { duration: 0.2 } }}
        style={{ transformOrigin: 'center', transformBox: 'fill-box' }}>
        {isRoot && (
          <motion.circle
            r={radius + 10}
            fill={color}
            // The root's slow breath. Values come from the netRootGlow
            // keyframe, not from the `opacity={0.16}` attribute that used to
            // sit here — CSS opacity outranks the SVG attribute, so 0.16 only
            // ever showed under `prefers-reduced-motion`, where the keyframe
            // was switched off and the glow all but vanished. Reduced motion
            // now holds the loop's own resting value instead.
            animate={reduceMotion ? { opacity: 0.55 } : { opacity: [0.55, 0.85, 0.55], scale: [1, 1.12, 1] }}
            transition={{ duration: 3.2, ease: 'easeInOut', repeat: Infinity }}
            style={{ transformOrigin: 'center', transformBox: 'fill-box' }} />
        )}
        {(hovered || selected) && !isRoot && (
          <circle r={radius + 6} fill="none" stroke={color} strokeWidth={1.5} opacity={0.4} />
        )}
        <circle
          r={radius}
          fill={color}
          opacity={node.isArchived ? 0.45 : 1}
          stroke={selected ? 'var(--color-text-primary)' : 'rgba(255,255,255,0.55)'}
          strokeWidth={selected ? 2 : 1.5}
          style={{ filter: hovered ? `drop-shadow(0 4px 14px ${color}99)` : `drop-shadow(0 1px 4px rgba(0,0,0,0.14))` }}
        />
        {radius >= 7 && (
          <foreignObject x={-iconSize / 2} y={-iconSize / 2} width={iconSize} height={iconSize} style={{ pointerEvents: 'none', overflow: 'visible' }}>
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={Math.round(iconSize * 0.62)} color="#fff" />
            </div>
          </foreignObject>
        )}
        {isPinned && !isRoot && (
          <circle cx={radius * 0.72} cy={-radius * 0.72} r={4} fill="var(--color-white)" stroke={color} strokeWidth={1.5} />
        )}
      </motion.g>
      {/* `y`, `font-size` and `opacity` are owned by NeuralGraph's imperative
          label pass (counter-scaling + occlusion culling) — deliberately not
          set here, or a React re-render would clobber the pass's decision. */}
      <text
        ref={registerLabelRef}
        textAnchor="middle"
        style={{
          fontFamily: 'var(--font-heading)', fontWeight: hovered || selected ? 700 : 600,
          fill: hovered || selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          opacity: 0, pointerEvents: 'none',
          paintOrder: 'stroke', stroke: 'var(--color-white)', strokeLinejoin: 'round',
        }}
      >
        {(node.title || (isRoot ? 'Workspace' : 'Untitled')).slice(0, LABEL_MAX_CHARS)}
      </text>
    </g>
  );
});

// ── Zoom / center controls — matches the app's floating-button convention (see GraphScreen's existing "Reset layout" pill). ──

function ZoomControls({ onZoomIn, onZoomOut, onCenter }: { onZoomIn: () => void; onZoomOut: () => void; onCenter: () => void }) {
  const btnProps = {
    style: {
      width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-secondary)',
    } as React.CSSProperties,
    whileHover: { background: 'var(--color-surface-tint)', color: 'var(--color-primary)' },
    transition: { duration: 0.12 },
  };
  return (
    // Bottom-left, not bottom-right — the global AI Assistant bubble is
    // fixed at bottom:30/right:30 of the viewport (AIAssistant/index.tsx)
    // and would otherwise sit on top of these controls.
    <div style={{
      position: 'absolute', bottom: 16, left: 16, zIndex: 5, display: 'flex', flexDirection: 'column',
      borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-white)',
      boxShadow: '0 2px 10px rgba(var(--color-black-rgb), 0.08)', overflow: 'hidden',
    }}>
      <MotionButton title="Zoom in" onClick={onZoomIn} {...btnProps}><Icon name="add" size={17} /></MotionButton>
      <div style={{ height: 1, background: 'var(--color-divider)' }} />
      <MotionButton title="Zoom out" onClick={onZoomOut} {...btnProps}><Icon name="remove" size={17} /></MotionButton>
      <div style={{ height: 1, background: 'var(--color-divider)' }} />
      <MotionButton title="Center on workspace" onClick={onCenter} {...btnProps}><Icon name="filter_center_focus" size={16} /></MotionButton>
    </div>
  );
}
