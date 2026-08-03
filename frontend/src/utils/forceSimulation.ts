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
  /** Personal-space radius used for overlap resolution. Defaults to `radius`,
   *  but callers pass a larger footprint when a node's real visual extent is
   *  bigger than its dot — a 10px dot with a 120px label needs room for the
   *  label, or the layout looks fine and reads as mush. */
  collisionRadius: number;
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
  /** See SimNode.collisionRadius — defaults to `radius` when omitted. */
  collisionRadius?: number;
  /** A caller-supplied pinned position (e.g. a previously dragged node) — applied as fx/fy. */
  pinned?: { x: number; y: number };
}

const REPULSION = 2600;
const MIN_DISTANCE = 8;
const CENTER_STRENGTH = 0.012;
const DAMPING = 0.82;
const MAX_VELOCITY = 40;
const JITTER = 1.1;
// Extra breathing room on top of the two nodes' collision radii.
const SEPARATION_PADDING = 14;
// How hard an actual overlap is pushed apart. Unlike the inverse-square
// repulsion this is a *constraint*, not an exploratory force, so it is
// deliberately NOT alpha-scaled (see the tick() comment) — a cooled-down
// layout must still refuse to let two nodes sit on top of each other.
const SEPARATION_STRENGTH = 0.5;
// Floor applied to alpha for repulsion only. Without it, repulsion decays to
// ~4% of nominal once the layout cools while the springs stay at full
// strength — so every sibling set slowly collapses back onto its parent's
// ring and the whole graph ends up an unreadable knot. Springs set the
// distance; repulsion has to stay strong enough to hold the spread.
const REPULSION_ALPHA_FLOOR = 0.55;
// Seeding: siblings are fanned around their parent using the golden angle so
// even a large child set starts spread out instead of heaped on one spot and
// having to slowly untangle itself.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Below this speed a node's velocity snaps to zero rather than continuing to
// integrate — without this, ambient jitter never quite settles and every
// node reads as constantly, visibly vibrating instead of calm and alive.
const VELOCITY_TOLERANCE = 0.03;
// d3-force-style cooling: the simulation starts "hot" (alpha=1) so a fresh
// layout spreads out properly, then eases down toward a low resting floor
// over a couple of seconds — never all the way to zero, so the graph keeps
// a small, slow, perpetual drift rather than either constant motion or a
// completely frozen layout. Repulsion/centering/jitter all scale with alpha;
// springs stay at full strength so the settled shape holds together.
const ALPHA_MIN = 0.045;
const ALPHA_DECAY = 0.965;
const ALPHA_REHEAT = 0.5;

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
  /** Cooling factor — see ALPHA_* above. Starts hot so a fresh layout settles quickly. */
  private alpha = 1;

  constructor(seed = 42) {
    this.rand = mulberry32(seed);
  }

  /** Merges in a new node/link set: existing nodes keep their live position
   *  (so the layout doesn't jump when filters change), new nodes seed near
   *  their first link partner (or the origin), and stale nodes are dropped.
   *  Adding a genuinely new node gently reheats the simulation so it settles
   *  into place instead of snapping there instantly. */
  setData(nodeSpecs: SimNodeSpec[], links: SimLink[]) {
    const wanted = new Set(nodeSpecs.map((n) => n.id));
    for (const id of this.nodes.keys()) if (!wanted.has(id)) this.nodes.delete(id);

    // Each node's seed anchor: the first link it appears on, and that link's
    // rest length — so a new node lands roughly where the springs want it
    // rather than at an arbitrary 40-70px from its neighbor.
    const anchor = new Map<string, { other: string; distance: number }>();
    for (const l of links) {
      if (!anchor.has(l.target)) anchor.set(l.target, { other: l.source, distance: l.distance });
      if (!anchor.has(l.source)) anchor.set(l.source, { other: l.target, distance: l.distance });
    }

    const existingSpecs: SimNodeSpec[] = [];
    const newSpecs: SimNodeSpec[] = [];
    for (const spec of nodeSpecs) (this.nodes.has(spec.id) ? existingSpecs : newSpecs).push(spec);

    for (const spec of existingSpecs) {
      const existing = this.nodes.get(spec.id)!;
      existing.radius = spec.radius;
      existing.collisionRadius = spec.collisionRadius ?? spec.radius;
      existing.depth = spec.depth;
      if (spec.pinned) { existing.fx = spec.pinned.x; existing.fy = spec.pinned.y; }
      else if (existing.fx !== undefined && !this.userPinned.has(spec.id)) { existing.fx = undefined; existing.fy = undefined; }
    }

    // Shallowest first, so a parent is already placed by the time its children
    // are seeded around it and the whole tree fans out in one pass.
    newSpecs.sort((a, b) => a.depth - b.depth);
    const seededPerAnchor = new Map<string, number>();
    for (const spec of newSpecs) {
      const anchorId = anchor.get(spec.id)?.other;
      const siblingIndex = anchorId ? (seededPerAnchor.get(anchorId) ?? 0) : 0;
      if (anchorId) seededPerAnchor.set(anchorId, siblingIndex + 1);
      const seedNear = spec.pinned ?? this.seedPosition(spec, anchor.get(spec.id), siblingIndex);
      this.nodes.set(spec.id, {
        id: spec.id, x: seedNear.x, y: seedNear.y, vx: 0, vy: 0,
        fx: spec.pinned?.x, fy: spec.pinned?.y, radius: spec.radius,
        collisionRadius: spec.collisionRadius ?? spec.radius, depth: spec.depth,
      });
    }
    this.links = links.filter((l) => this.nodes.has(l.source) && this.nodes.has(l.target));
    if (newSpecs.length > 0) this.alpha = Math.max(this.alpha, ALPHA_REHEAT);
  }

  /** IDs the user has explicitly pinned by dragging (survives setData's node-position preservation even without a fresh `pinned` spec each call). */
  private userPinned = new Set<string>();

  private seedPosition(
    spec: SimNodeSpec,
    anchor: { other: string; distance: number } | undefined,
    siblingIndex: number
  ): { x: number; y: number } {
    const neighbor = anchor ? this.nodes.get(anchor.other) : undefined;
    if (!neighbor) {
      const angle = this.rand() * Math.PI * 2;
      const radius = spec.depth * 90 + this.rand() * 40;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }
    // Fan siblings by the golden angle rather than at random: random angles
    // clump (that's what random does), and a clumped seed on a large child set
    // takes a long, visibly messy time to untangle.
    const angle = siblingIndex * GOLDEN_ANGLE + this.rand() * 0.25;
    const radius = (anchor?.distance ?? 80) * (0.9 + this.rand() * 0.2);
    return { x: neighbor.x + Math.cos(angle) * radius, y: neighbor.y + Math.sin(angle) * radius };
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

    // Cool toward the resting floor — never all the way to 0, so a small
    // perpetual drift always remains (see ALPHA_* docs above).
    this.alpha = ALPHA_MIN + (this.alpha - ALPHA_MIN) * ALPHA_DECAY;
    const alpha = this.alpha;

    // Pairwise repulsion (Coulomb-like), O(n^2) — fine at the node counts this renderer handles (<=~400).
    // Repulsion is floored (REPULSION_ALPHA_FLOOR) rather than fully
    // alpha-scaled: the springs never cool, so letting repulsion decay to
    // nothing means a settled layout is one where only the springs have a
    // say — every child collapses onto its parent's rest circle and the graph
    // reads as a solid blob. The overlap term below is a separate, entirely
    // unscaled constraint.
    const spread = Math.max(alpha, REPULSION_ALPHA_FLOOR);
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) { dx = this.rand() - 0.5; dy = this.rand() - 0.5; distSq = 0.01; }
        const dist = Math.max(Math.sqrt(distSq), MIN_DISTANCE);
        const minSeparation = a.collisionRadius + b.collisionRadius + SEPARATION_PADDING;
        const overlap = dist < minSeparation ? (minSeparation - dist) * SEPARATION_STRENGTH : 0;
        const force = (REPULSION / (dist * dist)) * spread + overlap;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a.fx === undefined) { a.vx += fx * dt; a.vy += fy * dt; }
        if (b.fx === undefined) { b.vx -= fx * dt; b.vy -= fy * dt; }
      }
    }

    // Springs along hierarchy + relation links — kept at full strength
    // (not alpha-scaled) so the settled shape actually holds together once
    // the other forces cool down, rather than slowly drifting apart.
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

    // Gentle centering (deeper nodes pulled less, so leaves fan outward) + a
    // faint ambient jitter so the graph never fully freezes — both scaled by
    // alpha, so once the layout has settled this becomes a slow, subtle
    // breathing motion rather than the constant, rapid drift of a fixed jitter.
    for (const node of list) {
      if (node.fx !== undefined) { node.x = node.fx; node.y = node.fy!; node.vx = 0; node.vy = 0; continue; }
      const centerPull = (CENTER_STRENGTH / (1 + node.depth * 0.5)) * alpha;
      node.vx += -node.x * centerPull * dt;
      node.vy += -node.y * centerPull * dt;
      node.vx += (this.rand() - 0.5) * JITTER * alpha * dt;
      node.vy += (this.rand() - 0.5) * JITTER * alpha * dt;

      node.vx *= DAMPING;
      node.vy *= DAMPING;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_VELOCITY) { node.vx = (node.vx / speed) * MAX_VELOCITY; node.vy = (node.vy / speed) * MAX_VELOCITY; }
      else if (speed < VELOCITY_TOLERANCE) { node.vx = 0; node.vy = 0; }

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
