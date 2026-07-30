// ---------------------------------------------------------------------------
// A small, dependency-free 2D force simulation driving the Net view's "neural
// network" motion — nodes gently repel each other, hierarchy/relation links
// pull along springs, everything drifts toward the workspace root at the
// center, and a tiny constant jitter keeps the whole graph subtly breathing
// instead of ever fully freezing. Pure simulation state; no DOM/RAF here (see
// hooks/useForceSimulation.ts for the render loop) so it's trivially
// unit-testable, matching utils/graphLayout.ts's convention.
// ---------------------------------------------------------------------------

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Set while the user is dragging the node, or it was previously dropped
   *  and pinned — the simulation never moves a fixed node, everything else
   *  reacts to it as an anchor. */
  fx?: number;
  fy?: number;
  radius: number;
  /** Hops from the workspace root — deeper nodes get a weaker pull to center, so they fan outward. */
  depth: number;
}

export interface SimLink {
  source: string;
  target: string;
  /** Rest length of the spring. */
  distance: number;
  /** Spring stiffness, roughly 0..1. */
  strength: number;
}

export interface SimNodeSpec {
  id: string;
  radius: number;
  depth: number;
  /** A caller-supplied pinned position (e.g. a previously dragged node) — applied as fx/fy. */
  pinned?: { x: number; y: number };
}

const REPULSION = 2600;
const MIN_DISTANCE = 8;
const CENTER_STRENGTH = 0.012;
const DAMPING = 0.86;
const MAX_VELOCITY = 40;
const JITTER = 2.2;

// Deterministic PRNG (mulberry32) so simulations are reproducible in tests —
// cosmetic jitter has no need for crypto-grade randomness.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ForceSimulation {
  nodes = new Map<string, SimNode>();
  links: SimLink[] = [];
  private rand: () => number;

  constructor(seed = 42) {
    this.rand = mulberry32(seed);
  }

  /** Merges in a new node/link set: existing nodes keep their live position
   *  (so the layout doesn't jump when filters change), new nodes seed near
   *  their first link partner (or the origin), and stale nodes are dropped. */
  setData(nodeSpecs: SimNodeSpec[], links: SimLink[]) {
    const wanted = new Set(nodeSpecs.map((n) => n.id));
    for (const id of this.nodes.keys()) if (!wanted.has(id)) this.nodes.delete(id);

    const firstNeighbor = new Map<string, string>();
    for (const l of links) {
      if (!firstNeighbor.has(l.target)) firstNeighbor.set(l.target, l.source);
      if (!firstNeighbor.has(l.source)) firstNeighbor.set(l.source, l.target);
    }

    for (const spec of nodeSpecs) {
      const existing = this.nodes.get(spec.id);
      if (existing) {
        existing.radius = spec.radius;
        existing.depth = spec.depth;
        if (spec.pinned) { existing.fx = spec.pinned.x; existing.fy = spec.pinned.y; }
        else if (existing.fx !== undefined && !this.userPinned.has(spec.id)) { existing.fx = undefined; existing.fy = undefined; }
        continue;
      }
      const seedNear = spec.pinned ?? this.seedPosition(spec, firstNeighbor.get(spec.id));
      this.nodes.set(spec.id, {
        id: spec.id, x: seedNear.x, y: seedNear.y, vx: 0, vy: 0,
        fx: spec.pinned?.x, fy: spec.pinned?.y, radius: spec.radius, depth: spec.depth,
      });
    }
    this.links = links.filter((l) => this.nodes.has(l.source) && this.nodes.has(l.target));
  }

  /** IDs the user has explicitly pinned by dragging (survives setData's node-position preservation even without a fresh `pinned` spec each call). */
  private userPinned = new Set<string>();

  private seedPosition(spec: SimNodeSpec, neighborId?: string): { x: number; y: number } {
    const neighbor = neighborId ? this.nodes.get(neighborId) : undefined;
    const angle = this.rand() * Math.PI * 2;
    const radius = neighbor ? 40 + this.rand() * 30 : spec.depth * 70 + this.rand() * 40;
    const base = neighbor ?? { x: 0, y: 0 };
    return { x: base.x + Math.cos(angle) * radius, y: base.y + Math.sin(angle) * radius };
  }

  pin(id: string, x: number, y: number) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.fx = x; n.fy = y; n.vx = 0; n.vy = 0;
    this.userPinned.add(id);
  }

  unpin(id: string) {
    const n = this.nodes.get(id);
    if (n) { n.fx = undefined; n.fy = undefined; }
    this.userPinned.delete(id);
  }

  isPinned(id: string): boolean {
    return this.userPinned.has(id);
  }

  /** Advances the simulation by one step. `dt` is a normalized frame factor (1 = a nominal 16ms frame). */
  tick(dt = 1) {
    const list = [...this.nodes.values()];
    const n = list.length;
    if (n === 0) return;

    // Pairwise repulsion (Coulomb-like), O(n^2) — fine at the node counts this renderer handles (<=~400).
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) { dx = this.rand() - 0.5; dy = this.rand() - 0.5; distSq = 0.01; }
        const dist = Math.max(Math.sqrt(distSq), MIN_DISTANCE);
        const minSeparation = a.radius + b.radius + 18;
        const force = REPULSION / (dist * dist) + (dist < minSeparation ? (minSeparation - dist) * 0.6 : 0);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a.fx === undefined) { a.vx += fx * dt; a.vy += fy * dt; }
        if (b.fx === undefined) { b.vx -= fx * dt; b.vy -= fy * dt; }
      }
    }

    // Springs along hierarchy + relation links.
    for (const l of this.links) {
      const a = this.nodes.get(l.source);
      const b = this.nodes.get(l.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const displacement = dist - l.distance;
      const force = displacement * l.strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (a.fx === undefined) { a.vx += fx * dt; a.vy += fy * dt; }
      if (b.fx === undefined) { b.vx -= fx * dt; b.vy -= fy * dt; }
    }

    // Gentle centering (deeper nodes pulled less, so leaves fan outward) + ambient jitter so the graph never fully freezes.
    for (const node of list) {
      if (node.fx !== undefined) { node.x = node.fx; node.y = node.fy!; node.vx = 0; node.vy = 0; continue; }
      const centerPull = CENTER_STRENGTH / (1 + node.depth * 0.5);
      node.vx += -node.x * centerPull * dt;
      node.vy += -node.y * centerPull * dt;
      node.vx += (this.rand() - 0.5) * JITTER * dt;
      node.vy += (this.rand() - 0.5) * JITTER * dt;

      node.vx *= DAMPING;
      node.vy *= DAMPING;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_VELOCITY) { node.vx = (node.vx / speed) * MAX_VELOCITY; node.vy = (node.vy / speed) * MAX_VELOCITY; }

      node.x += node.vx * dt;
      node.y += node.vy * dt;
    }
  }

  positions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes.values()) out.set(n.id, { x: n.x, y: n.y });
    return out;
  }
}
