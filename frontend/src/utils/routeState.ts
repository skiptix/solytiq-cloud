// Route Planner State v1 helpers — pure functions, no Leaflet/React imports,
// so they can be unit-tested in isolation.
//
// Identity rules: route points and POIs are identified by stable ID first.
// Nearest-point matching within a meter tolerance is only a fallback —
// exact lat/lon equality is never used as identity.
import type {
  GpsRouteStateV1, GpsTrackPoint, NamedPin, PoiMarker, RouteControlPoint, OverpassPoi,
} from '../types';

export const WAYPOINT_ATTACH_TOLERANCE_M = 5;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findById<T extends { id: string }>(items: T[], id: string | null | undefined): T | null {
  if (!id) return null;
  return items.find(item => item.id === id) ?? null;
}

// Index of the nearest point, or -1 when none is within `toleranceM` meters.
export function findNearestPointWithinMeters(
  pts: Array<{ lat: number; lon: number }>,
  lat: number,
  lon: number,
  toleranceM: number = WAYPOINT_ATTACH_TOLERANCE_M,
): number {
  let nearestIdx = -1, minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineM(pts[i].lat, pts[i].lon, lat, lon);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }
  return minDist <= toleranceM ? nearestIdx : -1;
}

// Unbounded nearest-point search (always returns an index for non-empty input)
export function findNearestPointIndex(
  pts: Array<{ lat: number; lon: number }>,
  lat: number,
  lon: number,
): number {
  let nearestIdx = 0, minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineM(pts[i].lat, pts[i].lon, lat, lon);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }
  return nearestIdx;
}

// Walk outward from `fromIdx` along the track until roughly `maxDistM` meters
// are covered (or `boundIdx` is reached). Used to pick local re-routing anchors
// so editing a point only replans the surrounding stretch of an existing
// route — never the whole track.
export function extendAnchorIndexByDistance(
  pts: Array<{ lat: number; lon: number }>,
  fromIdx: number,
  direction: -1 | 1,
  boundIdx: number,
  maxDistM: number,
): number {
  let idx = fromIdx;
  let dist = 0;
  while (idx !== boundIdx) {
    const next = idx + direction;
    if (next < 0 || next >= pts.length) break;
    dist += haversineM(pts[idx].lat, pts[idx].lon, pts[next].lat, pts[next].lon);
    idx = next;
    if (dist >= maxDistM) break;
  }
  return idx;
}

// ─── PoiMarker ↔ NamedPin conversion ────────────────────────────────────────
// The editor's pin model (NamedPin) predates Route Planner State v1; these
// adapters keep both in sync without losing the original POI coordinates.
export function poiMarkerToNamedPin(m: PoiMarker): NamedPin {
  return {
    id: m.id,
    lat: m.lat,
    lon: m.lon,
    ele: m.ele,
    name: m.name,
    description: m.description,
    sym: m.category,
    highlighted: m.highlighted,
    addedToRoute: m.addedToRoute,
    originalLat: m.lat,
    originalLon: m.lon,
    linkedControlPointId: m.linkedControlPointId ?? null,
  };
}

export function namedPinToPoiMarker(p: NamedPin, source: PoiMarker['source'] = 'custom'): PoiMarker {
  return {
    id: p.id,
    source,
    lat: p.originalLat ?? p.lat,
    lon: p.originalLon ?? p.lon,
    ele: p.ele,
    name: p.name,
    description: p.description,
    category: p.sym,
    highlighted: p.highlighted,
    addedToRoute: p.addedToRoute,
    linkedControlPointId: p.linkedControlPointId ?? null,
  };
}

// ─── Editor state → GpsRouteStateV1 ─────────────────────────────────────────
export interface EditorWaypointLike {
  id: string;
  lat: number;
  lon: number;
  offRoad: boolean;
}

// Build a persistable Route Planner State from the editor's dense track,
// shaping waypoints (route controls) and named pins (POI markers).
export function buildRouteStateFromEditor(opts: {
  points: GpsTrackPoint[];
  waypoints: EditorWaypointLike[];
  pins: NamedPin[];
  profile: GpsRouteStateV1['routeControls'][number]['profile'];
}): GpsRouteStateV1 {
  const { points, waypoints, pins, profile } = opts;

  const cum: number[] = [];
  let total = 0;
  points.forEach((p, i) => {
    if (i > 0) total += haversineM(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
    cum.push(total);
  });

  const trackPoints = points.map((p, i) => ({
    id: p.id ?? `tp_${i}`,
    lat: p.lat,
    lon: p.lon,
    ele: p.ele,
    time: p.time,
    hr: p.hr,
    cadence: p.cadence,
    power: p.power,
    distanceM: Math.round(cum[i]),
  }));

  const poiMarkers = pins.map(p => namedPinToPoiMarker(p));
  const pinByControlId = new Map(
    pins.filter(p => p.linkedControlPointId).map(p => [p.linkedControlPointId as string, p]),
  );

  // Route controls: start, the shaping/via waypoints ordered along the track,
  // and destination.
  const controls: RouteControlPoint[] = [];
  if (points.length > 0) {
    controls.push({
      id: 'ctrl_start', order: 0, kind: 'start', profile,
      originalLat: points[0].lat, originalLon: points[0].lon,
      snappedLat: points[0].lat, snappedLon: points[0].lon,
      followWays: true,
    });
  }
  const ordered = [...waypoints]
    .map(w => ({ w, idx: points.length > 0 ? findNearestPointIndex(points, w.lat, w.lon) : 0 }))
    .sort((a, b) => a.idx - b.idx);
  ordered.forEach(({ w }, i) => {
    const linkedPin = pinByControlId.get(w.id) ?? null;
    controls.push({
      id: w.id, order: i + 1,
      kind: w.offRoad ? 'offgrid' : linkedPin ? 'stop' : 'via',
      profile,
      originalLat: linkedPin?.originalLat ?? w.lat,
      originalLon: linkedPin?.originalLon ?? w.lon,
      snappedLat: w.lat, snappedLon: w.lon,
      followWays: !w.offRoad,
      linkedPoiId: linkedPin?.id ?? null,
    });
  });
  if (points.length > 1) {
    const last = points[points.length - 1];
    controls.push({
      id: 'ctrl_destination', order: controls.length, kind: 'destination', profile,
      originalLat: last.lat, originalLon: last.lon,
      snappedLat: last.lat, snappedLon: last.lon,
      followWays: true,
    });
  }

  // Course points: pins on the route, positioned by nearest track point
  const coursePoints = pins
    .filter(p => p.addedToRoute && points.length > 0)
    .map(p => {
      const idx = findNearestPointIndex(points, p.lat, p.lon);
      return {
        id: `cp_${p.id}`,
        poiId: p.id,
        controlPointId: p.linkedControlPointId ?? undefined,
        distanceAlongRouteM: Math.round(cum[idx] ?? 0),
        snappedTrackPointId: trackPoints[idx]?.id,
        name: p.name,
        category: p.sym,
      };
    });

  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    const δ = points[i].ele - points[i - 1].ele;
    if (δ > 0) gain += δ;
  }

  return {
    version: 1,
    trackPoints,
    routeControls: controls,
    routeSpans: [],
    poiMarkers,
    coursePoints,
    metadata: {
      totalDistance: Math.round(total),
      totalElevationGain: Math.round(gain),
      duration: null,
      pointCount: points.length,
    },
  };
}

// ─── POI marker diffing ──────────────────────────────────────────────────────
// Compute the marker churn for a fresh POI fetch: which markers to add, move,
// or remove — instead of clearing and recreating the whole layer.
export function diffPoiMarkers(
  existing: Map<string, { lat: number; lon: number }>,
  incoming: OverpassPoi[],
): {
  toAdd: OverpassPoi[];
  toMove: OverpassPoi[];
  toRemove: string[];
} {
  const incomingIds = new Set(incoming.map(p => p.id));
  const toAdd: OverpassPoi[] = [];
  const toMove: OverpassPoi[] = [];
  for (const poi of incoming) {
    const cur = existing.get(poi.id);
    if (!cur) toAdd.push(poi);
    else if (cur.lat !== poi.lat || cur.lon !== poi.lon) toMove.push(poi);
  }
  const toRemove = [...existing.keys()].filter(id => !incomingIds.has(id));
  return { toAdd, toMove, toRemove };
}
