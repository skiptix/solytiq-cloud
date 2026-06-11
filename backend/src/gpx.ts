// Pure GPX parsing / writing / route-state logic for the GPS routes.
// Kept free of express/db imports so it can be unit-tested in isolation.
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';

// ─── Track / waypoint types ──────────────────────────────────────────────────
export interface GpsPoint {
  lat: number; lon: number; ele: number; time?: string;
  hr?: number; cadence?: number; power?: number;
}

export interface GpsWaypoint {
  id: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym: string;
  highlighted?: boolean;
  addedToRoute?: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
  linkedControlPointId?: string | null;
  distanceAlongRouteM?: number;
}

// Named waypoint input (from frontend route editor)
export interface WaypointInput {
  id?: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym?: string;
  highlighted?: boolean;
  addedToRoute?: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
  linkedControlPointId?: string | null;
  distanceAlongRouteM?: number;
}

// ─── Route Planner State v1 ──────────────────────────────────────────────────
export type RouteControlKind = 'start' | 'destination' | 'stop' | 'via' | 'through' | 'offgrid';
export type RouteProfile = 'road' | 'gravel' | 'mtb' | 'hike';

export interface RouteStateTrackPoint {
  id: string;
  lat: number;
  lon: number;
  ele: number;
  time?: string;
  hr?: number;
  cadence?: number;
  power?: number;
  distanceM?: number;
}

export interface RouteControlPoint {
  id: string;
  order: number;
  kind: RouteControlKind;
  profile: RouteProfile;
  originalLat: number;
  originalLon: number;
  snappedLat?: number;
  snappedLon?: number;
  followWays: boolean;
  linkedPoiId?: string | null;
  spanBeforeId?: string | null;
  spanAfterId?: string | null;
}

export type PoiMarkerCategory = 'food' | 'fuel' | 'bicycle' | 'shopping' | 'kiosk' | 'flag' | 'generic';

export interface PoiMarker {
  id: string;
  source: 'custom' | 'osm' | 'imported_gpx' | 'search';
  sourceId?: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  category: PoiMarkerCategory;
  highlighted: boolean;
  addedToRoute: boolean;
  linkedControlPointId?: string | null;
  showLabel?: boolean;
}

export interface RouteSpan {
  id: string;
  fromControlId: string;
  toControlId: string;
  profile: RouteProfile;
  followWays: boolean;
  status: 'routed' | 'offgrid' | 'failed';
  points: RouteStateTrackPoint[];
  distanceM: number;
  elevationGainM: number;
  error?: string;
}

export interface CoursePoint {
  id: string;
  poiId?: string;
  controlPointId?: string;
  distanceAlongRouteM: number;
  snappedTrackPointId?: string;
  name: string;
  category: string;
}

export interface GpsRouteStateV1 {
  version: 1;
  trackPoints: RouteStateTrackPoint[];
  routeControls: RouteControlPoint[];
  routeSpans: RouteSpan[];
  poiMarkers: PoiMarker[];
  coursePoints: CoursePoint[];
  metadata: {
    totalDistance?: number;
    totalElevationGain?: number;
    duration?: number | null;
    pointCount?: number;
  };
}

// ─── Geometry helpers ────────────────────────────────────────────────────────
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function computeMetadata(points: GpsPoint[]) {
  if (points.length === 0) return null;
  let totalDistance = 0, totalElevationGain = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    const δ = points[i].ele - points[i - 1].ele;
    if (δ > 0) totalElevationGain += δ;
  }
  const startTime = points[0].time ?? null;
  const endTime = points[points.length - 1].time ?? null;
  const duration = startTime && endTime
    ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
    : null;
  return {
    totalDistance: Math.round(totalDistance),
    totalElevationGain: Math.round(totalElevationGain),
    duration,
    startTime,
    pointCount: points.length,
  };
}

export function buildElevationProfile(points: GpsPoint[]) {
  let cum = 0;
  return points.map((p, i) => {
    if (i > 0) cum += haversine(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
    return { distance: Math.round(cum), elevation: p.ele, idx: i };
  });
}

// ─── GPX symbol mapping ──────────────────────────────────────────────────────
export const GPX_SYM_MAP: Record<string, string> = {
  food: 'Restaurant',
  fuel: 'Gas Station',
  bicycle: 'Bike Shop',
  shopping: 'Grocery Store',
  kiosk: 'Convenience Store',
  flag: 'Flag',
  generic: 'Waypoint',
};

export const GPX_SYM_TO_APP: Record<string, string> = {
  'Restaurant': 'food',
  'Gas Station': 'fuel',
  'Bike Shop': 'bicycle',
  'Grocery Store': 'shopping',
  'Convenience Store': 'kiosk',
  'Flag': 'flag',
  'Waypoint': 'generic',
};

const POI_CATEGORIES: PoiMarkerCategory[] = ['food', 'fuel', 'bicycle', 'shopping', 'kiosk', 'flag', 'generic'];

function asPoiCategory(sym: string | undefined): PoiMarkerCategory {
  return POI_CATEGORIES.includes(sym as PoiMarkerCategory) ? (sym as PoiMarkerCategory) : 'generic';
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── GPX writer ──────────────────────────────────────────────────────────────
// Wahoo-friendly layout: <metadata>, then all <wpt> (original POI coordinates),
// then <trk> with the snapped/dense route geometry.
export function writeGpx(points: GpsPoint[], name = 'Route', waypoints: WaypointInput[] = []): string {
  const safeName = escXml(name);
  // <wpt> elements MUST appear before <trk> per GPX 1.1 spec (required for Wahoo)
  const wptXml = waypoints.map(w => {
    const lat = w.originalLat ?? w.lat;
    const lon = w.originalLon ?? w.lon;
    const elePart = w.ele != null ? `\n      <ele>${Number(w.ele).toFixed(2)}</ele>` : '';
    const descPart = w.description ? `\n      <desc>${escXml(w.description)}</desc>` : '';
    const symPart = w.sym ? `\n      <sym>${GPX_SYM_MAP[w.sym] ?? 'Waypoint'}</sym>` : '';

    // Solytiq extensions for full roundtrip
    const extAttrs: string[] = [];
    if (w.id) extAttrs.push(`id="${escXml(w.id)}"`);
    if (w.addedToRoute !== undefined) extAttrs.push(`addedToRoute="${w.addedToRoute}"`);
    if (w.highlighted !== undefined) extAttrs.push(`highlighted="${w.highlighted}"`);
    if (w.offRoad !== undefined) extAttrs.push(`offRoad="${w.offRoad}"`);
    if (w.pointId) extAttrs.push(`pointId="${escXml(w.pointId)}"`);
    if (w.originalLat !== undefined) extAttrs.push(`originalLat="${w.originalLat.toFixed(7)}"`);
    if (w.originalLon !== undefined) extAttrs.push(`originalLon="${w.originalLon.toFixed(7)}"`);
    if (w.linkedControlPointId) extAttrs.push(`linkedControlPointId="${escXml(w.linkedControlPointId)}"`);
    if (w.distanceAlongRouteM !== undefined) extAttrs.push(`distanceAlongRouteM="${Math.round(w.distanceAlongRouteM)}"`);

    const extensions = extAttrs.length > 0
      ? `\n      <extensions>\n        <solytiq:poi ${extAttrs.join(' ')} />\n      </extensions>`
      : '';

    return `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${elePart}\n      <name>${escXml(w.name)}</name>${descPart}${symPart}\n      <type>User Waypoint</type>${extensions}\n  </wpt>`;
  }).join('\n');
  const trkpts = points.map(p => {
    const eleLine = `        <ele>${p.ele.toFixed(2)}</ele>`;
    const timeLine = p.time ? `\n        <time>${p.time}</time>` : '';
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n${eleLine}${timeLine}\n      </trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Solytiq Cloud" xmlns="http://www.topografix.com/GPX/1/1" xmlns:solytiq="https://solytiq.cloud/gpx/1/0">\n  <metadata><name>${safeName}</name></metadata>\n${wptXml ? wptXml + '\n' : ''}  <trk>\n    <name>${safeName}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;
}

// ─── GPX parser ──────────────────────────────────────────────────────────────
export interface ParsedGpxData {
  points: GpsPoint[];
  waypoints: GpsWaypoint[];
  routePoints: GpsPoint[];
  name?: string;
}

export function parseGpxFull(content: string): ParsedGpxData {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['trkpt', 'trkseg', 'trk', 'wpt', 'rte', 'rtept'].includes(name),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = parser.parse(content);
  const gpx = result.gpx ?? result;

  const name = gpx?.metadata?.name ? String(gpx.metadata.name) : undefined;

  const waypoints: GpsWaypoint[] = [];
  if (gpx?.wpt) {
    const wpts = Array.isArray(gpx.wpt) ? gpx.wpt : [gpx.wpt];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wpts.forEach((wp: any, index: number) => {
      const lat = parseFloat(wp['@_lat']);
      const lon = parseFloat(wp['@_lon']);
      if (isNaN(lat) || isNaN(lon)) return;

      const wpName = wp.name ? String(wp.name) : 'Waypoint';
      const sym = wp.sym ? (GPX_SYM_TO_APP[wp.sym] ?? 'generic') : 'generic';

      // Stable fallback ID when the Solytiq extension is missing
      let id = crypto.createHash('sha1').update(`${lat}:${lon}:${wpName}:${index}`).digest('hex');
      let addedToRoute = false;
      let highlighted = false;
      let offRoad = false;
      let pointId: string | null = null;
      let originalLat: number | undefined;
      let originalLon: number | undefined;
      let linkedControlPointId: string | null = null;
      let distanceAlongRouteM: number | undefined;

      // Accept both the new <solytiq:poi> and the legacy <solytiq:waypoint> extension
      const ext = wp.extensions?.['solytiq:poi'] ?? wp.extensions?.['solytiq:waypoint'];
      if (ext) {
        if (ext['@_id']) id = ext['@_id'];
        if (ext['@_addedToRoute']) addedToRoute = ext['@_addedToRoute'] === 'true';
        if (ext['@_highlighted']) highlighted = ext['@_highlighted'] === 'true';
        if (ext['@_offRoad']) offRoad = ext['@_offRoad'] === 'true';
        if (ext['@_pointId']) pointId = ext['@_pointId'];
        if (ext['@_originalLat']) originalLat = parseFloat(ext['@_originalLat']);
        if (ext['@_originalLon']) originalLon = parseFloat(ext['@_originalLon']);
        if (ext['@_linkedControlPointId']) linkedControlPointId = ext['@_linkedControlPointId'];
        if (ext['@_distanceAlongRouteM']) {
          const d = parseFloat(ext['@_distanceAlongRouteM']);
          if (Number.isFinite(d)) distanceAlongRouteM = d;
        }
      }

      waypoints.push({
        id, lat, lon,
        ele: parseFloat(wp.ele) || 0,
        name: wpName,
        description: wp.desc ? String(wp.desc) : undefined,
        sym,
        addedToRoute,
        highlighted,
        offRoad,
        pointId,
        originalLat,
        originalLon,
        linkedControlPointId,
        distanceAlongRouteM,
      });
    });
  }

  const points: GpsPoint[] = [];
  if (gpx?.trk) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trks: any[] = Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk];
    for (const trk of trks) {
      if (!trk?.trkseg) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs: any[] = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
      for (const seg of segs) {
        if (!seg?.trkpt) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trkpts: any[] = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
        for (const pt of trkpts) {
          const lat = parseFloat(pt['@_lat']);
          const lon = parseFloat(pt['@_lon']);
          if (isNaN(lat) || isNaN(lon)) continue;
          points.push({
            lat, lon,
            ele: parseFloat(pt.ele) || 0,
            time: pt.time ? String(pt.time) : undefined,
          });
        }
      }
    }
  }

  // <rte>/<rtept> — route control candidates from external planners
  const routePoints: GpsPoint[] = [];
  if (gpx?.rte) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtes: any[] = Array.isArray(gpx.rte) ? gpx.rte : [gpx.rte];
    for (const rte of rtes) {
      if (!rte?.rtept) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rtepts: any[] = Array.isArray(rte.rtept) ? rte.rtept : [rte.rtept];
      for (const pt of rtepts) {
        const lat = parseFloat(pt['@_lat']);
        const lon = parseFloat(pt['@_lon']);
        if (isNaN(lat) || isNaN(lon)) continue;
        routePoints.push({ lat, lon, ele: parseFloat(pt.ele) || 0 });
      }
    }
  }

  return { points, waypoints, routePoints, name };
}

// Backwards-compatible alias used by older call sites
export function parseGpx(content: string): { points: GpsPoint[]; waypoints: GpsWaypoint[] } {
  const { points, waypoints } = parseGpxFull(content);
  return { points, waypoints };
}

// ─── Route state construction / validation ──────────────────────────────────
function waypointToPoiMarker(w: GpsWaypoint): PoiMarker {
  return {
    id: w.id,
    source: 'imported_gpx',
    lat: w.originalLat ?? w.lat,
    lon: w.originalLon ?? w.lon,
    ele: w.ele,
    name: w.name,
    description: w.description,
    category: asPoiCategory(w.sym),
    highlighted: w.highlighted ?? false,
    addedToRoute: w.addedToRoute ?? false,
    linkedControlPointId: w.linkedControlPointId ?? null,
  };
}

export function computeRouteStateMetadata(state: GpsRouteStateV1): GpsRouteStateV1['metadata'] {
  const pts = state.trackPoints;
  let totalDistance = 0, totalElevationGain = 0;
  for (let i = 1; i < pts.length; i++) {
    totalDistance += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const δ = pts[i].ele - pts[i - 1].ele;
    if (δ > 0) totalElevationGain += δ;
  }
  const startTime = pts[0]?.time;
  const endTime = pts[pts.length - 1]?.time;
  const duration = startTime && endTime
    ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
    : null;
  return {
    totalDistance: Math.round(totalDistance),
    totalElevationGain: Math.round(totalElevationGain),
    duration,
    pointCount: pts.length,
  };
}

export function emptyRouteState(): GpsRouteStateV1 {
  return {
    version: 1,
    trackPoints: [],
    routeControls: [],
    routeSpans: [],
    poiMarkers: [],
    coursePoints: [],
    metadata: { totalDistance: 0, totalElevationGain: 0, duration: null, pointCount: 0 },
  };
}

// Build a route state from parsed GPX. A valid file without track points yields
// a valid *empty* planning state — never an error.
export function buildRouteStateFromGpx(parsed: ParsedGpxData): GpsRouteStateV1 {
  const trackPoints: RouteStateTrackPoint[] = [];
  let cum = 0;
  parsed.points.forEach((p, i) => {
    if (i > 0) cum += haversine(parsed.points[i - 1].lat, parsed.points[i - 1].lon, p.lat, p.lon);
    trackPoints.push({
      id: `tp_${i}`,
      lat: p.lat, lon: p.lon, ele: p.ele,
      time: p.time, hr: p.hr, cadence: p.cadence, power: p.power,
      distanceM: Math.round(cum),
    });
  });

  const poiMarkers = parsed.waypoints.map(waypointToPoiMarker);

  const routeControls: RouteControlPoint[] = [];
  if (parsed.routePoints.length >= 2) {
    parsed.routePoints.forEach((p, i) => {
      routeControls.push({
        id: `ctrl_${i}`,
        order: i,
        kind: i === 0 ? 'start' : i === parsed.routePoints.length - 1 ? 'destination' : 'via',
        profile: 'gravel',
        originalLat: p.lat,
        originalLon: p.lon,
        followWays: true,
      });
    });
  } else if (trackPoints.length > 0) {
    const first = trackPoints[0];
    const last = trackPoints[trackPoints.length - 1];
    routeControls.push({
      id: 'ctrl_start', order: 0, kind: 'start', profile: 'gravel',
      originalLat: first.lat, originalLon: first.lon,
      snappedLat: first.lat, snappedLon: first.lon, followWays: true,
    });
    if (trackPoints.length > 1) {
      routeControls.push({
        id: 'ctrl_destination', order: 1, kind: 'destination', profile: 'gravel',
        originalLat: last.lat, originalLon: last.lon,
        snappedLat: last.lat, snappedLon: last.lon, followWays: true,
      });
    }
  }

  const state: GpsRouteStateV1 = {
    version: 1,
    trackPoints,
    routeControls,
    routeSpans: [],
    poiMarkers,
    coursePoints: [],
    metadata: {},
  };
  state.metadata = computeRouteStateMetadata(state);
  return state;
}

const ROUTE_CONTROL_KINDS: RouteControlKind[] = ['start', 'destination', 'stop', 'via', 'through', 'offgrid'];
const ROUTE_PROFILES: RouteProfile[] = ['road', 'gravel', 'mtb', 'hike'];
const SPAN_STATUSES = ['routed', 'offgrid', 'failed'];
const POI_SOURCES = ['custom', 'osm', 'imported_gpx', 'search'];

function isValidLat(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90; }
function isValidLon(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180; }
function isNonEmptyString(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 500; }

// Structural validation for client-supplied route state. Returns an error
// message, or null if the state is valid.
export function validateRouteState(state: unknown): string | null {
  if (state == null || typeof state !== 'object') return 'route_state must be an object';
  const s = state as Record<string, unknown>;
  if (s.version !== 1) return 'route_state.version must be 1';
  for (const key of ['trackPoints', 'routeControls', 'routeSpans', 'poiMarkers', 'coursePoints'] as const) {
    if (!Array.isArray(s[key])) return `route_state.${key} must be an array`;
  }
  const trackPoints = s.trackPoints as unknown[];
  if (trackPoints.length > 200000) return 'too many track points';
  for (const tp of trackPoints) {
    const p = tp as Record<string, unknown>;
    if (!isNonEmptyString(p.id) || !isValidLat(p.lat) || !isValidLon(p.lon) || typeof p.ele !== 'number') {
      return 'invalid track point';
    }
  }
  for (const rc of s.routeControls as unknown[]) {
    const c = rc as Record<string, unknown>;
    if (!isNonEmptyString(c.id) || !isValidLat(c.originalLat) || !isValidLon(c.originalLon)) return 'invalid route control';
    if (!ROUTE_CONTROL_KINDS.includes(c.kind as RouteControlKind)) return 'invalid route control kind';
    if (!ROUTE_PROFILES.includes(c.profile as RouteProfile)) return 'invalid route control profile';
  }
  for (const sp of s.routeSpans as unknown[]) {
    const span = sp as Record<string, unknown>;
    if (!isNonEmptyString(span.id) || !isNonEmptyString(span.fromControlId) || !isNonEmptyString(span.toControlId)) return 'invalid route span';
    if (!SPAN_STATUSES.includes(span.status as string)) return 'invalid route span status';
    if (!Array.isArray(span.points)) return 'invalid route span points';
  }
  for (const pm of s.poiMarkers as unknown[]) {
    const m = pm as Record<string, unknown>;
    if (!isNonEmptyString(m.id) || !isValidLat(m.lat) || !isValidLon(m.lon) || !isNonEmptyString(m.name)) return 'invalid poi marker';
    if (!POI_SOURCES.includes(m.source as string)) return 'invalid poi marker source';
    if (!POI_CATEGORIES.includes(m.category as PoiMarkerCategory)) return 'invalid poi marker category';
  }
  for (const cp of s.coursePoints as unknown[]) {
    const c = cp as Record<string, unknown>;
    if (!isNonEmptyString(c.id) || typeof c.distanceAlongRouteM !== 'number' || !isNonEmptyString(c.name)) return 'invalid course point';
  }
  if (s.metadata != null && typeof s.metadata !== 'object') return 'invalid metadata';
  return null;
}
