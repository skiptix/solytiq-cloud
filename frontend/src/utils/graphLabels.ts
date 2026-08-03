// ---------------------------------------------------------------------------
// Label placement for the Net view (components/graph/NeuralGraph.tsx).
//
// A graph label can't use a fixed world-space font size: at the zoom where a
// hundred-term Knowledge Base fits on screen that size is illegibly small, and
// at the zoom where it's legible the labels overlap into mush. So labels are
// COUNTER-SCALED (constant on-screen size at any zoom) and then greedily
// OCCLUSION-CULLED against each other, highest priority first. Zoom out and
// only the hubs stay labelled; zoom in and the rest fade in as room opens up.
//
// Pure and dependency-free — no DOM, no React — so it's trivially unit-testable,
// matching utils/graphLayout.ts's and utils/forceSimulation.ts's convention.
// The caller owns applying the result to elements.
// ---------------------------------------------------------------------------

/** On-screen font size (px) a label renders at, whatever the zoom. */
export const LABEL_BASE_PX = 11;
/** Slightly larger for the hovered/selected node, so focus reads immediately. */
export const LABEL_FOCUS_PX = 12.5;
/** Rough advance width per character as a fraction of font size, for the heading font. */
export const LABEL_CHAR_WIDTH = 0.55;
/** Horizontal breathing room added to a label's measured box, screen px. */
export const LABEL_PAD_X = 12;
/** Vertical gap between the dot's edge and the label, screen px. */
export const LABEL_GAP_Y = 5;
/** Occlusion grid cell, screen px. Coarser = cheaper, and a little more spacious. */
export const LABEL_CELL = 20;
/** White halo behind the text so a label crossing an edge stays readable, screen px. */
export const LABEL_HALO_PX = 3.5;
/** Longest label rendered; anything past this is truncated by the caller. */
export const LABEL_MAX_CHARS = 28;

export interface LabelCandidate {
  srn: string;
  /** The dot's radius in world units. */
  radius: number;
  /** Character count of the (already truncated) label text. */
  length: number;
}

export interface LabelCamera { x: number; y: number; k: number }
export interface LabelViewport { w: number; h: number }
export interface LabelPoint { x: number; y: number }

export interface LabelPlacement {
  srn: string;
  visible: boolean;
  /** World-space font size — divided by zoom, so on-screen size stays constant. */
  fontSize: number;
  /** World-space y offset from the node's center. */
  y: number;
  /** World-space halo width — counter-scaled with the text, or it swallows the glyphs. */
  strokeWidth: number;
}

export interface PlanLabelsOptions {
  /** The hovered (or selected) node — always placed first, so focus never loses to a hub. */
  focus?: string | null;
  /** When set, anything outside it is dimmed by the renderer and gets no label at
   *  all. A ghosted label still occupies the pixels the focused neighbourhood needs. */
  highlight?: Set<string> | null;
}

/**
 * Decides every label's size, offset and visibility for one frame.
 *
 * `candidates` must already be in static priority order (root first, then
 * best-connected first) — when space runs out the labels that survive should be
 * the ones that orient you. Focus/neighbour promotion is applied on top of that
 * order here rather than by the caller.
 */
export function planLabels(
  candidates: LabelCandidate[],
  positions: Map<string, LabelPoint>,
  camera: LabelCamera,
  viewport: LabelViewport,
  options: PlanLabelsOptions = {}
): LabelPlacement[] {
  const { focus = null, highlight = null } = options;
  const { k } = camera;
  const occupied = new Set<string>();

  /** Greedy first-come-first-served claim over a coarse screen-space grid. */
  const claim = (x0: number, y0: number, x1: number, y1: number): boolean => {
    const c0 = Math.floor(x0 / LABEL_CELL), c1 = Math.floor(x1 / LABEL_CELL);
    const r0 = Math.floor(y0 / LABEL_CELL), r1 = Math.floor(y1 / LABEL_CELL);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) if (occupied.has(`${c}:${r}`)) return false;
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) occupied.add(`${c}:${r}`);
    return true;
  };

  // Hovering must reveal that neighbourhood's labels intact, whatever the zoom
  // or how crowded that corner of the graph is — so focus, then its neighbours,
  // then everything else in the caller's order (Array#sort is stable).
  const order = focus
    ? [...candidates].sort((a, b) => rankFor(a.srn, focus, highlight) - rankFor(b.srn, focus, highlight))
    : candidates;

  const out: LabelPlacement[] = [];
  for (const item of order) {
    const focused = item.srn === focus;
    const px = focused ? LABEL_FOCUS_PX : LABEL_BASE_PX;
    const placement: LabelPlacement = {
      srn: item.srn,
      visible: false,
      fontSize: px / k,
      y: item.radius + (LABEL_GAP_Y + px) / k,
      strokeWidth: LABEL_HALO_PX / k,
    };
    out.push(placement);

    const p = positions.get(item.srn);
    if (!p || (highlight && !highlight.has(item.srn))) continue;

    const sx = viewport.w / 2 + camera.x + p.x * k;
    const sy = viewport.h / 2 + camera.y + p.y * k;
    const boxW = item.length * px * LABEL_CHAR_WIDTH + LABEL_PAD_X;
    const boxH = px + 6;
    const top = sy + item.radius * k + LABEL_GAP_Y;
    // Offscreen labels are skipped without claiming — a node just past the edge
    // must not suppress a visible one that overlaps where it would have been.
    if (sx < -boxW || sx > viewport.w + boxW || top < -boxH || top > viewport.h + boxH) continue;

    placement.visible = claim(sx - boxW / 2, top, sx + boxW / 2, top + boxH);
  }
  return out;
}

function rankFor(srn: string, focus: string, highlight: Set<string> | null): number {
  if (srn === focus) return 0;
  return highlight?.has(srn) ? 1 : 2;
}
