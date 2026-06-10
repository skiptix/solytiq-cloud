import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import 'leaflet-editable';
import L from 'leaflet';
import type { GpsFile, GpsTrackPoint, PoiCategory, OverpassPoi, NominatimResult, NamedPin } from '../types';
import { apiGetGpsFiles, apiGetGpsTrackData, apiSaveEditedGpsTrack, apiGpsRoute } from '../api/client';
import { queryOverpass } from '../utils/overpass';
import { searchNominatim, parseCoordInput } from '../utils/nominatim';
import { POI_CATEGORY_CONFIG, createPoiDivIcon, createPinDivIcon } from '../utils/poiCategories';
import useGpsStore from '../store/useGpsStore';
import Icon from '../components/Icon';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtDist(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
function fmtElev(m: number) { return `${Math.round(m)} m`; }

function haversineClient(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ramer-Douglas-Peucker simplification
function perpDist(p: GpsTrackPoint, a: GpsTrackPoint, b: GpsTrackPoint): number {
  const dx = b.lat - a.lat, dy = b.lon - a.lon;
  if (dx === 0 && dy === 0) return Math.hypot(p.lat - a.lat, p.lon - a.lon);
  const t = Math.max(0, Math.min(1, ((p.lat - a.lat) * dx + (p.lon - a.lon) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.lat - (a.lat + t * dx), p.lon - (a.lon + t * dy));
}

function rdp(pts: GpsTrackPoint[], eps: number): GpsTrackPoint[] {
  if (pts.length < 3) return pts;
  let maxD = 0, maxI = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > eps) {
    return [...rdp(pts.slice(0, maxI + 1), eps).slice(0, -1), ...rdp(pts.slice(maxI), eps)];
  }
  return [pts[0], pts[pts.length - 1]];
}

function simplifyTrack(pts: GpsTrackPoint[], tol = 0.00015): GpsTrackPoint[] {
  if (pts.length <= 50) return pts;
  const simplified = rdp(pts, tol);
  if (simplified.length < 30 && pts.length >= 30) return simplifyTrack(pts, tol / 2);
  return simplified;
}

function findNearestPoint(pts: Array<{ lat: number; lon: number }>, lat: number, lon: number): number {
  let nearestIdx = 0, minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].lat - lat, pts[i].lon - lon);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }
  return nearestIdx;
}

function createDotIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.25);cursor:grab;"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// ─── Snap-to-ways routing (FOSSGIS Valhalla, free, no API key) ────────────────
// Same operator and fair-use policy as the OSRM instance previously used, but
// Valhalla exposes bicycle_type (Mountain/Cross/Road) and sac_scale-aware
// pedestrian costing — which is what MTB / Gravel / Road / Hike need.
type RoutingProfile = 'mtb' | 'gravel' | 'road' | 'hike';

const ROUTING_PROFILES: Record<RoutingProfile, { costing: 'bicycle' | 'pedestrian'; options: Record<string, number | string> }> = {
  // All available paths incl. singletrack — surface restrictions off
  mtb: { costing: 'bicycle', options: { bicycle_type: 'Mountain', use_roads: 0.1, use_hills: 0.6, avoid_bad_surfaces: 0 } },
  // Cyclocross tires: gravel/forest tracks yes, technical MTB trails no
  gravel: { costing: 'bicycle', options: { bicycle_type: 'Cross', use_roads: 0.2, use_hills: 0.5, avoid_bad_surfaces: 0.25 } },
  // Race bike: paved roads only (1.0 would forbid even start/end on gravel)
  road: { costing: 'bicycle', options: { bicycle_type: 'Road', use_roads: 0.9, use_hills: 0.6, avoid_bad_surfaces: 0.9 } },
  // Hiking paths up to difficult alpine sac_scale
  hike: { costing: 'pedestrian', options: { max_hiking_difficulty: 6 } },
};

interface EditWaypoint {
  id: string;
  lat: number;
  lon: number;
  offRoad: boolean;
  // Track points the last routing/straightening connected through — used to re-route the same leg
  anchorPrev: { lat: number; lon: number } | null;
  anchorNext: { lat: number; lon: number } | null;
}

interface HistoryEntry {
  points: GpsTrackPoint[];
  waypoints: EditWaypoint[];
}

interface EditableVertexEvent extends L.LeafletEvent {
  vertex: L.Marker & { getIndex: () => number };
  cancel: () => void;
}

interface ValhallaResponse {
  trip?: { legs?: Array<{ shape: string }> };
}

// Valhalla shapes are Google polylines with 6 decimal digits precision
function decodePolyline6(str: string): Array<{ lat: number; lon: number }> {
  let index = 0, lat = 0, lon = 0;
  const out: Array<{ lat: number; lon: number }> = [];
  while (index < str.length) {
    let b: number, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return out;
}

// One leg per consecutive location pair, so the via point is exactly the
// boundary between legs[0] and legs[1] — no nearest-point splitting needed.
// Goes through the backend proxy: the public Valhalla server's CORS policy
// blocks direct browser requests from third-party origins.
async function fetchRoutedPath(
  coords: Array<{ lat: number; lon: number }>,
  profile: RoutingProfile,
): Promise<{ legs: Array<Array<{ lat: number; lon: number }>> } | null> {
  const prof = ROUTING_PROFILES[profile];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  const attempt = async (opts: Record<string, number | string>) => {
    const data = (await apiGpsRoute({
      locations: coords.map(c => ({ lat: c.lat, lon: c.lon })),
      costing: prof.costing,
      costing_options: { [prof.costing]: opts },
    }, ctrl.signal)) as ValhallaResponse;
    const legs = (data.trip?.legs ?? []).map(l => decodePolyline6(l.shape));
    return legs.length === coords.length - 1 && !legs.some(l => l.length < 2) ? { legs } : null;
  };

  try {
    // Try with profile-specific options; fall back to costing defaults if rejected
    return (await attempt(prof.options)) ?? (await attempt({}));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Elevation lookup (Open-Meteo Copernicus DEM, free, no API key) ───────────
async function fetchElevations(coords: Array<{ lat: number; lon: number }>): Promise<number[] | null> {
  if (coords.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < coords.length; i += 100) {
    const chunk = coords.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(c => c.lat.toFixed(6)).join(',')}&longitude=${chunk.map(c => c.lon.toFixed(6)).join(',')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { elevation?: number[] };
      if (!Array.isArray(data.elevation) || data.elevation.length !== chunk.length) return null;
      out.push(...data.elevation);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// Replace a span's elevations with real DEM values. Where an end of the span is
// an existing track point (pinned), the GPX↔DEM offset is blended out along the
// span so the chart profile stays continuous at the seams.
async function withDemElevation(span: GpsTrackPoint[], pinStart: boolean, pinEnd: boolean): Promise<GpsTrackPoint[]> {
  if (span.length === 0) return span;
  const dem = await fetchElevations(span.map(p => ({ lat: p.lat, lon: p.lon })));
  if (!dem) return span;
  const cum: number[] = [0];
  for (let i = 1; i < span.length; i++) {
    cum.push(cum[i - 1] + haversineClient(span[i - 1].lat, span[i - 1].lon, span[i].lat, span[i].lon));
  }
  const total = cum[cum.length - 1] || 1;
  const offStart = pinStart ? span[0].ele - dem[0] : 0;
  const offEnd = pinEnd ? span[span.length - 1].ele - dem[dem.length - 1] : 0;
  return span.map((p, i) => {
    const t = cum[i] / total;
    return { ...p, ele: dem[i] + offStart * (1 - t) + offEnd * t };
  });
}

// ─── Reverse geocoding (Nominatim, click-driven so well within fair use) ─────
interface NominatimReverse {
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&format=jsonv2&zoom=16`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimReverse;
    const a = data.address ?? {};
    const main = data.name || a.road || a.path || a.hamlet || a.isolated_dwelling;
    const locality = a.village || a.town || a.city || a.municipality || a.county;
    const label = [main, locality].filter(Boolean).join(', ');
    return label || data.display_name?.split(',').slice(0, 2).join(',').trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Approximate distance (m) from a point to a segment, equirectangular projection
function distToSegmentM(p: { lat: number; lon: number }, a: GpsTrackPoint, b: GpsTrackPoint): number {
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const ax = a.lon * kx, ay = a.lat * ky;
  const bx = b.lon * kx, by = b.lat * ky;
  const px = p.lon * kx, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplifyLeg(line: Array<{ lat: number; lon: number }>): Array<{ lat: number; lon: number }> {
  if (line.length <= 3) return line;
  return rdp(line.map(p => ({ lat: p.lat, lon: p.lon, ele: 0 })), 0.00005);
}

// Find the leg anchors (nearest existing waypoints) on either side of an edit
// position. Returns indices into pts; defaults to ts/te when no waypoint exists.
// prevBound: waypoints at index ≤ prevBound qualify as aPrev
// nextBound: waypoints at index ≥ nextBound qualify as aNext
function findLegAnchors(
  pts: GpsTrackPoint[],
  wps: EditWaypoint[],
  ts: number,
  te: number,
  prevBound: number,
  nextBound: number,
): { aPrevIdx: number; aNextIdx: number } {
  let aPrevIdx = ts;
  let aNextIdx = te;
  for (const wp of wps) {
    const wpi = findNearestPoint(pts, wp.lat, wp.lon);
    if (wpi >= ts && wpi <= prevBound && wpi > aPrevIdx) aPrevIdx = wpi;
    if (wpi <= te && wpi >= nextBound && wpi < aNextIdx) aNextIdx = wpi;
  }
  return { aPrevIdx, aNextIdx };
}

// Distribute elevation linearly along a routed leg by cumulative distance
function interpolateEle(line: Array<{ lat: number; lon: number }>, eleStart: number, eleEnd: number): GpsTrackPoint[] {
  if (line.length === 0) return [];
  const cum: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    cum.push(cum[i - 1] + haversineClient(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon));
  }
  const total = cum[cum.length - 1] || 1;
  return line.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: eleStart + (eleEnd - eleStart) * (cum[i] / total) }));
}

// Build the replacement span [anchorPrev?, …leg1, wp, …leg2, anchorNext?] from
// routed legs. Elevation is linearly interpolated as a baseline; callers then
// swap in real DEM values via withDemElevation.
function buildRoutedSpan(
  anchorPrev: GpsTrackPoint | null,
  anchorNext: GpsTrackPoint | null,
  wpEle: number,
  legs: Array<Array<{ lat: number; lon: number }>>,
): { span: GpsTrackPoint[]; wpPoint: GpsTrackPoint } {
  if (anchorPrev && anchorNext) {
    const via = legs[1][0];
    const wpPoint: GpsTrackPoint = { lat: via.lat, lon: via.lon, ele: wpEle };
    const leg1 = interpolateEle(simplifyLeg(legs[0]), anchorPrev.ele, wpEle).slice(1, -1);
    const leg2 = interpolateEle(simplifyLeg(legs[1]), wpEle, anchorNext.ele).slice(1, -1);
    return { span: [anchorPrev, ...leg1, wpPoint, ...leg2, anchorNext], wpPoint };
  }
  if (anchorPrev) {
    const via = legs[0][legs[0].length - 1];
    const wpPoint: GpsTrackPoint = { lat: via.lat, lon: via.lon, ele: wpEle };
    const leg = interpolateEle(simplifyLeg(legs[0]), anchorPrev.ele, wpEle).slice(1, -1);
    return { span: [anchorPrev, ...leg, wpPoint], wpPoint };
  }
  const via = legs[0][0];
  const wpPoint: GpsTrackPoint = { lat: via.lat, lon: via.lon, ele: wpEle };
  const leg = interpolateEle(simplifyLeg(legs[0]), wpEle, anchorNext!.ele).slice(1, -1);
  return { span: [wpPoint, ...leg, anchorNext!], wpPoint };
}

// Simplified route-point dot — sits beneath the leaflet-editable vertex handle
function createPtDotIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #8a7ad6;box-shadow:0 1px 6px rgba(94,77,187,0.30);box-sizing:border-box;"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function createClickPinIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:#5e4dbb;border:3px solid #fff;box-shadow:0 0 0 4px rgba(94,77,187,0.22), 0 2px 8px rgba(0,0,0,0.25);box-sizing:border-box;"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function createWpIcon(offRoad: boolean): L.DivIcon {
  const color = offRoad ? '#f59e0b' : '#5e4dbb';
  const border = offRoad ? '2.5px dashed #fff' : '3px solid #fff';
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:${border};box-shadow:0 2px 10px rgba(94,77,187,0.35);cursor:pointer;box-sizing:border-box;"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function fmtDurationHM(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`;
}

function gradeAt(pts: GpsTrackPoint[], idx: number): number | null {
  const a = pts[Math.max(0, idx - 1)];
  const b = pts[Math.min(pts.length - 1, idx + 1)];
  const run = haversineClient(a.lat, a.lon, b.lat, b.lon);
  if (run < 1) return null;
  return ((b.ele - a.ele) / run) * 100;
}

function gradeColor(g: number): string {
  const a = Math.abs(g);
  return a < 3 ? '#22c55e' : a < 8 ? '#f59e0b' : '#ef4444';
}

// ─── EditElevationChart ───────────────────────────────────────────────────────
interface EditElevChartProps {
  points: GpsTrackPoint[];
  trimStart: number;
  trimEnd: number;
  hoveredIdx: number | null;
  onHover: (idx: number | null) => void;
  onTrimStartChange: (idx: number) => void;
  onTrimEndChange: (idx: number) => void;
}

function EditElevationChart({ points, trimStart, trimEnd, hoveredIdx, onHover, onTrimStartChange, onTrimEndChange }: EditElevChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 140 });
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const draggingRef = useRef<'start' | 'end' | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(e => {
      const r = e[0].contentRect;
      setDims({ w: Math.max(100, r.width), h: Math.max(50, r.height) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const PAD = { l: 10, r: 10, t: 20, b: 22 };
  const cw = dims.w - PAD.l - PAD.r;
  const ch = dims.h - PAD.t - PAD.b;
  const n = points.length;

  // Build elevation profile
  const elevData = useMemo(() => {
    const elev = points.map(p => p.ele);
    const minE = Math.min(...elev);
    const maxE = Math.max(...elev);
    const range = maxE - minE || 1;
    return { elev, minE, maxE, range };
  }, [points]);

  const cumDist = useMemo(() => {
    const cum: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      cum.push(cum[i - 1] + haversineClient(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
    }
    return cum;
  }, [points]);

  const toX = (idx: number) => PAD.l + (n > 1 ? (idx / (n - 1)) : 0) * cw;
  const toY = (e: number) => PAD.t + (1 - (e - elevData.minE) / elevData.range) * ch;

  const buildPath = (from: number, to: number): string => {
    if (from > to) return '';
    const pts = [];
    for (let i = from; i <= to; i++) {
      pts.push(`${toX(i).toFixed(1)},${toY(elevData.elev[i]).toFixed(1)}`);
    }
    return `M${pts.join('L')}`;
  };

  const buildArea = (from: number, to: number): string => {
    if (from > to) return '';
    const bottom = PAD.t + ch;
    let d = `M${toX(from).toFixed(1)},${bottom.toFixed(1)}`;
    for (let i = from; i <= to; i++) {
      d += `L${toX(i).toFixed(1)},${toY(elevData.elev[i]).toFixed(1)}`;
    }
    d += `L${toX(to).toFixed(1)},${bottom.toFixed(1)}Z`;
    return d;
  };

  const idxFromX = useCallback((clientX: number): number => {
    if (!svgRef.current) return 0;
    const rect = svgRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left - PAD.l) / Math.max(1, cw)));
    return Math.round(frac * (n - 1));
  }, [cw, n, PAD.l]);

  const handleStartMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = 'start';
    setDragging('start');
  }, []);

  const handleEndMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = 'end';
    setDragging('end');
  }, []);

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = draggingRef.current;
    if (d) {
      const idx = idxFromX(e.clientX);
      if (d === 'start') onTrimStartChange(Math.max(0, Math.min(idx, trimEnd - 1)));
      else onTrimEndChange(Math.min(n - 1, Math.max(idx, trimStart + 1)));
    } else {
      const idx = idxFromX(e.clientX);
      onHover(Math.max(0, Math.min(idx, n - 1)));
    }
  };

  const handleSvgMouseUp = () => {
    draggingRef.current = null;
    setDragging(null);
  };

  const startX = toX(trimStart);
  const endX = toX(trimEnd);
  const hovX = hoveredIdx != null ? toX(hoveredIdx) : null;

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', userSelect: 'none' }}>
      <svg
        ref={svgRef}
        width={dims.w}
        height={dims.h}
        style={{ display: 'block', cursor: dragging ? 'ew-resize' : 'crosshair' }}
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
        onMouseLeave={() => { handleSvgMouseUp(); onHover(null); }}
      >
        <defs>
          <linearGradient id="edit-elev-grad-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5e4dbb" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#5e4dbb" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="edit-elev-grad-dim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b0acbe" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#b0acbe" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD.t + (1 - f) * ch;
          return <line key={f} x1={PAD.l} y1={y} x2={PAD.l + cw} y2={y} stroke="rgba(94,77,187,0.08)" strokeWidth={0.8} />;
        })}

        {/* Dim areas */}
        {trimStart > 0 && <path d={buildArea(0, trimStart)} fill="url(#edit-elev-grad-dim)" />}
        {trimEnd < n - 1 && <path d={buildArea(trimEnd, n - 1)} fill="url(#edit-elev-grad-dim)" />}

        {/* Active area */}
        {trimStart <= trimEnd && <path d={buildArea(trimStart, trimEnd)} fill="url(#edit-elev-grad-active)" />}

        {/* Dim lines */}
        {trimStart > 0 && <path d={buildPath(0, trimStart)} fill="none" stroke="#c4b8f0" strokeWidth={1.5} opacity={0.5} />}
        {trimEnd < n - 1 && <path d={buildPath(trimEnd, n - 1)} fill="none" stroke="#c4b8f0" strokeWidth={1.5} opacity={0.5} />}

        {/* Active line */}
        {trimStart <= trimEnd && (
          <path d={buildPath(trimStart, trimEnd)} fill="none" stroke="#5e4dbb" strokeWidth={2} />
        )}

        {/* Hovered cursor */}
        {hovX != null && !dragging && (
          <line x1={hovX} y1={PAD.t} x2={hovX} y2={PAD.t + ch} stroke="rgba(94,77,187,0.4)" strokeWidth={1.5} strokeDasharray="4,3" />
        )}

        {/* Trim region highlight */}
        <rect
          x={startX} y={PAD.t}
          width={Math.max(0, endX - startX)} height={ch}
          fill="rgba(94,77,187,0.06)" stroke="none"
        />

        {/* X-axis labels */}
        {Array.from({ length: 6 }, (_, i) => {
          const idx = Math.round((i / 5) * (n - 1));
          const x = toX(idx);
          return (
            <text key={i} x={x} y={dims.h - 5} textAnchor="middle" style={{ fontSize: 9, fill: 'rgba(80,60,140,0.55)', fontFamily: 'Inter,sans-serif' }}>
              {i + 1}
            </text>
          );
        })}

        {/* Trim start handle — wide invisible hit zone + visible line */}
        <line x1={startX} y1={PAD.t - 4} x2={startX} y2={PAD.t + ch + 4} stroke="transparent" strokeWidth={12} style={{ cursor: 'ew-resize' }} onMouseDown={handleStartMouseDown} />
        <line x1={startX} y1={PAD.t - 4} x2={startX} y2={PAD.t + ch + 4} stroke="#22c55e" strokeWidth={2} strokeDasharray="4,2" style={{ pointerEvents: 'none' }} />
        {/* Start handle dot */}
        <circle cx={startX} cy={PAD.t + ch / 2} r={6} fill="#22c55e" stroke="#fff" strokeWidth={2} style={{ cursor: 'ew-resize' }} onMouseDown={handleStartMouseDown} />

        {/* Trim end handle */}
        <line x1={endX} y1={PAD.t - 4} x2={endX} y2={PAD.t + ch + 4} stroke="transparent" strokeWidth={12} style={{ cursor: 'ew-resize' }} onMouseDown={handleEndMouseDown} />
        <line x1={endX} y1={PAD.t - 4} x2={endX} y2={PAD.t + ch + 4} stroke="#ef4444" strokeWidth={2} strokeDasharray="4,2" style={{ pointerEvents: 'none' }} />
        <circle cx={endX} cy={PAD.t + ch / 2} r={6} fill="#ef4444" stroke="#fff" strokeWidth={2} style={{ cursor: 'ew-resize' }} onMouseDown={handleEndMouseDown} />
      </svg>

      {/* Elevation range label */}
      <div style={{
        position: 'absolute', top: 4, right: PAD.r + 4,
        fontSize: 9, color: 'rgba(80,60,140,0.55)', fontFamily: 'Inter,sans-serif',
        pointerEvents: 'none',
      }}>
        {Math.round(elevData.minE)}–{Math.round(elevData.maxE)} m
      </div>

      {/* Hover readout — distance + elevation at the cursor */}
      {hovX != null && hoveredIdx != null && !dragging && points[hoveredIdx] && (
        <div style={{
          position: 'absolute', top: 6,
          left: Math.min(Math.max(hovX + 10, PAD.l), Math.max(PAD.l, dims.w - 130)),
          background: 'rgba(255,255,255,0.95)', borderRadius: 8, padding: '4px 9px',
          border: '1px solid rgba(94,77,187,0.15)', boxShadow: '0 2px 10px rgba(94,77,187,0.12)',
          fontSize: 10.5, fontFamily: 'Inter, sans-serif', pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          <span style={{ color: '#787584' }}>{fmtDist(cumDist[hoveredIdx] ?? 0)}</span>
          <span style={{ color: '#1c1b22', fontWeight: 700, marginLeft: 8 }}>{Math.round(points[hoveredIdx].ele)} m</span>
        </div>
      )}
    </div>
  );
}

// ─── GPSEditScreen ────────────────────────────────────────────────────────────
export default function GPSEditScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setFiles = useGpsStore(s => s.setFiles);

  const [loading, setLoading] = useState(true);
  const [fileInfo, setFileInfo] = useState<GpsFile | null>(null);
  const [editName, setEditName] = useState('');
  const [originalPoints, setOriginalPoints] = useState<GpsTrackPoint[] | null>(null);
  const [editPoints, setEditPoints] = useState<GpsTrackPoint[] | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState<'new' | 'replace' | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Named Pins
  const [namedPins, setNamedPins] = useState<NamedPin[]>([]);
  const namedPinsRef = useRef<NamedPin[]>([]);
  const namedPinMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const [editingPin, setEditingPin] = useState<string | null>(null); // id des Pins im Rename-Mode

  // ── POI Layer
  const [activePoi, setActivePoi] = useState<Set<PoiCategory>>(new Set());
  const [poiLoading, setPoiLoading] = useState(false);
  const poiLayerRef = useRef<L.LayerGroup | null>(null);
  const poiFetchControllerRef = useRef<AbortController | null>(null);
  const poiFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Add-Pin Dialog (erscheint wenn POI oder Suche-Ergebnis angeklickt)
  const [addPinDialog, setAddPinDialog] = useState<{
    lat: number; lon: number; ele?: number;
    suggestedName: string; suggestedSym: PoiCategory | 'flag' | 'generic';
    poi?: OverpassPoi;  // original POI data für Popup-Infos
  } | null>(null);
  const [addPinName, setAddPinName] = useState('');
  const [addPinMode, setAddPinMode] = useState<'pin' | 'route'>('pin');

  // ── Search (identisch zu GPSScreen)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchPinRef = useRef<L.Marker | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);

  // Snap-to-ways routing + edited waypoints
  const [waypoints, setWaypoints] = useState<EditWaypoint[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapProfile, setSnapProfile] = useState<RoutingProfile>('mtb');
  const [busy, setBusy] = useState<string | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  // Popup target: an edited waypoint (by id) or a plain route point (by position)
  const [activeSel, setActiveSel] = useState<
    | { kind: 'wp'; id: string }
    | { kind: 'pt'; lat: number; lon: number }
    | null
  >(null);
  const [popupXY, setPopupXY] = useState<{ x: number; y: number } | null>(null);
  const [coordsCopied, setCoordsCopied] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const routingBusy = busy != null;

  // Map-click popup (place name + elevation + add-to-route)
  const [mapClick, setMapClick] = useState<{ lat: number; lon: number; ele: number | null; name: string | null; loading: boolean } | null>(null);
  const [mapClickXY, setMapClickXY] = useState<{ x: number; y: number } | null>(null);

  // Refs — used in Leaflet event handlers to avoid stale closures
  const editPointsRef = useRef<GpsTrackPoint[] | null>(null);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const historyArrRef = useRef<HistoryEntry[]>([]);
  const historyIdxRef = useRef(-1);
  const waypointsRef = useRef<EditWaypoint[]>([]);
  const snapEnabledRef = useRef(true);
  const snapProfileRef = useRef<RoutingProfile>('mtb');
  const dragWpIdRef = useRef<string | null>(null);
  const dragWpMarkerRef = useRef<L.Marker | null>(null);
  const routingErrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leaflet refs
  const leafletRef = useRef<L.Map | null>(null);
  const editPolylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.Marker | null>(null);
  const endMarkerRef = useRef<L.Marker | null>(null);
  const trimPolyBeforeRef = useRef<L.Polyline | null>(null);
  const trimPolyAfterRef = useRef<L.Polyline | null>(null);
  const waypointMarkersRef = useRef<L.Marker[]>([]);
  const ptDotMarkersRef = useRef<L.Marker[]>([]);
  const pendingFitRef = useRef<L.LatLngBounds | null>(null);
  const hoverMarkerRef = useRef<L.CircleMarker | null>(null);
  const clickPinRef = useRef<L.Marker | null>(null);
  const mapClickHandlerRef = useRef<((e: L.LeafletMouseEvent) => void) | null>(null);

  // Keep refs in sync with state
  useEffect(() => { editPointsRef.current = editPoints; }, [editPoints]);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current = trimEnd; }, [trimEnd]);
  useEffect(() => { historyArrRef.current = history; }, [history]);
  useEffect(() => { historyIdxRef.current = historyIdx; }, [historyIdx]);
  useEffect(() => { waypointsRef.current = waypoints; }, [waypoints]);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { snapProfileRef.current = snapProfile; }, [snapProfile]);
  useEffect(() => { namedPinsRef.current = namedPins; }, [namedPins]);

  // ── Load data on mount ────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    Promise.all([apiGetGpsFiles(), apiGetGpsTrackData(id)])
      .then(([files, trackData]) => {
        const file = files.find(f => f.id === id);
        if (!file) { navigate('/gps'); return; }
        setFileInfo(file);
        setEditName(file.name.replace(/\.(gpx|fit)$/i, ''));
        const simplified = simplifyTrack(trackData.points, 0.00015);
        setOriginalPoints(simplified);
        setEditPoints(simplified);
        editPointsRef.current = simplified;
        const te = simplified.length - 1;
        setTrimStart(0);
        setTrimEnd(te);
        trimStartRef.current = 0;
        trimEndRef.current = te;
        setHistory([{ points: simplified, waypoints: [] }]);
        setHistoryIdx(0);
        historyArrRef.current = [{ points: simplified, waypoints: [] }];
        historyIdxRef.current = 0;
      })
      .catch(() => navigate('/gps'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      leafletRef.current?.remove();
      leafletRef.current = null;
      searchPinRef.current?.remove();
      poiLayerRef.current?.clearLayers();
      poiFetchControllerRef.current?.abort();
      searchControllerRef.current?.abort();
      if (poiFetchTimerRef.current) clearTimeout(poiFetchTimerRef.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // ── Map setup callback ────────────────────────────────────────────────────
  const mapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      leafletRef.current?.remove();
      leafletRef.current = null;
      return;
    }
    if (!leafletRef.current) {
      const map = L.map(node, { editable: true, zoomControl: false } as L.MapOptions).setView([47, 10], 5);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);

      const poiLayer = L.layerGroup().addTo(map);
      poiLayerRef.current = poiLayer;

      map.on('click', e => mapClickHandlerRef.current?.(e as L.LeafletMouseEvent));
      leafletRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 100);
      const ro = new ResizeObserver(() => {
        const m = leafletRef.current;
        if (!m) return;
        m.invalidateSize();
        // A fitBounds requested while the container had zero size (e.g. on a hard
        // page refresh) is deferred until the map actually has dimensions —
        // fitting a 0×0 map poisons the view with NaN and blanks it permanently.
        if (pendingFitRef.current) {
          const s = m.getSize();
          if (s.x > 0 && s.y > 0) {
            m.fitBounds(pendingFitRef.current, { padding: [40, 40], maxZoom: 16 });
            pendingFitRef.current = null;
          }
        }
      });
      ro.observe(node);
    }
  }, []);

  // ── Build/rebuild map layers from points ─────────────────────────────────
  const rebuildMap = useCallback((pts: GpsTrackPoint[], ts: number, te: number, opts?: { fit?: boolean }) => {
    const map = leafletRef.current;
    if (!map || pts.length === 0) return;
    const shouldFit = opts?.fit !== false;

    // Remove old layers
    editPolylineRef.current?.remove();
    startMarkerRef.current?.remove();
    endMarkerRef.current?.remove();
    trimPolyBeforeRef.current?.remove();
    trimPolyAfterRef.current?.remove();

    // Dim "before" segment
    if (ts > 0) {
      trimPolyBeforeRef.current = L.polyline(
        pts.slice(0, ts + 1).map(p => [p.lat, p.lon] as L.LatLngTuple),
        { color: '#b0acbe', weight: 3, opacity: 0.50, dashArray: '6,4' },
      ).addTo(map);
    } else {
      trimPolyBeforeRef.current = null;
    }

    // Dim "after" segment
    if (te < pts.length - 1) {
      trimPolyAfterRef.current = L.polyline(
        pts.slice(te).map(p => [p.lat, p.lon] as L.LatLngTuple),
        { color: '#b0acbe', weight: 3, opacity: 0.50, dashArray: '6,4' },
      ).addTo(map);
    } else {
      trimPolyAfterRef.current = null;
    }

    // Active editable segment
    const activeLls: L.LatLngTuple[] = pts.slice(ts, te + 1).map(p => [p.lat, p.lon]);
    const poly = L.polyline(activeLls, {
      color: '#5e4dbb', weight: 5, opacity: 0.95,
      lineJoin: 'round', lineCap: 'round',
    }).addTo(map);

    // Enable vertex editing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (poly as any).enableEdit();
    editPolylineRef.current = poly;

    // Re-bind editable events — clear previous handlers first, otherwise every
    // rebuild stacks another set referencing detached polylines
    map.off('editable:vertex:dragstart');
    map.off('editable:vertex:drag');
    map.off('editable:vertex:dragend');
    map.off('editable:vertex:deleted');
    map.off('editable:vertex:new');
    map.off('editable:vertex:rawclick');

    // Clicking a vertex opens the point popup instead of leaflet-editable's
    // default behaviour (instantly deleting the vertex)
    map.on('editable:vertex:rawclick', (e) => {
      const ev = e as EditableVertexEvent;
      ev.cancel();
      openPtPopupRef.current?.(trimStartRef.current + ev.vertex.getIndex());
    });

    // Remember whether the grabbed vertex is an existing edited waypoint
    map.on('editable:vertex:dragstart', (e) => {
      const ll = (e as EditableVertexEvent).vertex.getLatLng();
      const wp = waypointsRef.current.find(w => w.lat === ll.lat && w.lon === ll.lng);
      dragWpIdRef.current = wp?.id ?? null;
      // Cache the marker so the drag handler can move it in real-time
      dragWpMarkerRef.current = wp
        ? (waypointMarkersRef.current.find(m => {
            const mll = m.getLatLng();
            return mll.lat === ll.lat && mll.lng === ll.lng;
          }) ?? null)
        : null;
    });

    // Vertex drag — update state on each move for live stats
    map.on('editable:vertex:drag', (e) => {
      const ev = e as EditableVertexEvent;
      const lls = poly.getLatLngs() as L.LatLng[];
      const newPts = [...editPointsRef.current!];
      lls.forEach((ll, i) => {
        const idx = trimStartRef.current + i;
        if (idx < newPts.length) {
          newPts[idx] = { ...newPts[idx], lat: ll.lat, lon: ll.lng };
        }
      });
      editPointsRef.current = newPts;
      setEditPoints(newPts);
      // Keep the waypoint dot marker in sync with the vertex handle during drag
      if (dragWpMarkerRef.current) {
        const vi = ev.vertex.getIndex();
        const ll = lls[vi];
        if (ll) dragWpMarkerRef.current.setLatLng(ll);
      }
    });

    // Vertex drag end — snap to ways / register waypoint / push history
    map.on('editable:vertex:dragend', (e) => {
      handleVertexDragEndRef.current?.((e as EditableVertexEvent).vertex.getIndex());
    });

    // Vertex add/delete — sync editPoints with new poly state
    const syncAfterChange = () => {
      const lls = poly.getLatLngs() as L.LatLng[];
      const prevActive = editPointsRef.current!.slice(trimStartRef.current, trimEndRef.current + 1);
      // Match unchanged vertices to their previous track points by exact
      // position, so ele/time stay aligned across an insert or delete
      let j = 0;
      const freshIdx: number[] = [];
      const newActive: GpsTrackPoint[] = lls.map((ll, i) => {
        let k = j;
        while (k < prevActive.length && (prevActive[k].lat !== ll.lat || prevActive[k].lon !== ll.lng)) k++;
        if (k < prevActive.length) { j = k + 1; return prevActive[k]; }
        freshIdx.push(i);
        return { lat: ll.lat, lon: ll.lng, ele: NaN };
      });
      // Baseline elevation for new points: mean of the nearest known neighbours
      for (const i of freshIdx) {
        let p = i - 1; while (p >= 0 && Number.isNaN(newActive[p].ele)) p--;
        let q = i + 1; while (q < newActive.length && Number.isNaN(newActive[q].ele)) q++;
        const a = p >= 0 ? newActive[p].ele : null;
        const b = q < newActive.length ? newActive[q].ele : null;
        newActive[i] = { ...newActive[i], ele: a != null && b != null ? (a + b) / 2 : a ?? b ?? 0 };
      }
      const newPts = [
        ...editPointsRef.current!.slice(0, trimStartRef.current),
        ...newActive,
        ...editPointsRef.current!.slice(trimEndRef.current + 1),
      ];
      const newTe = trimStartRef.current + newActive.length - 1;
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      // Drop waypoints whose track point no longer exists (deleted vertex)
      const liveWps = waypointsRef.current.filter(w => newPts.some(p => p.lat === w.lat && p.lon === w.lon));
      if (liveWps.length !== waypointsRef.current.length) {
        waypointsRef.current = liveWps;
        setWaypoints(liveWps);
      }
      pushHistoryRef.current?.(newPts, liveWps);
      // Rebuild trim visualization (not full rebuild)
      updateTrimPolysRef.current?.(newPts, trimStartRef.current, newTe);
      // Real DEM elevation for newly added points — patches the chart when done
      if (freshIdx.length > 0) {
        patchDemElevationsRef.current?.(freshIdx.map(i => ({ lat: newActive[i].lat, lon: newActive[i].lon })));
      }
    };

    map.on('editable:vertex:deleted', syncAfterChange);
    map.on('editable:vertex:new', syncAfterChange);

    // Edited waypoint markers — sit beneath the vertex handles, click opens popup
    waypointMarkersRef.current.forEach(m => m.remove());
    waypointMarkersRef.current = [];
    for (const wp of waypointsRef.current) {
      const idx = findNearestPoint(pts, wp.lat, wp.lon);
      const p = pts[idx];
      if (!p || p.lat !== wp.lat || p.lon !== wp.lon) continue;
      if (idx < ts || idx > te) continue;
      const mkr = L.marker([wp.lat, wp.lon], { icon: createWpIcon(wp.offRoad), zIndexOffset: -200 });
      mkr.on('click', () => openWpPopupRef.current?.(wp.id));
      mkr.addTo(map);
      waypointMarkersRef.current.push(mkr);
    }

    // Simplified set of visible route-point dots. They sit beneath the vertex
    // handles purely as visual anchors — clicks land on the vertex handle,
    // which the rawclick interception routes to the point popup.
    ptDotMarkersRef.current.forEach(m => m.remove());
    ptDotMarkersRef.current = [];
    const activePts = pts.slice(ts, te + 1);
    const dotPts = activePts.length > 50 ? simplifyTrack(activePts, 0.0006) : activePts;
    for (const p of dotPts) {
      if (p === pts[ts] || p === pts[te]) continue;
      if (waypointsRef.current.some(w => w.lat === p.lat && w.lon === p.lon)) continue;
      const mkr = L.marker([p.lat, p.lon], { icon: createPtDotIcon(), interactive: false, zIndexOffset: -400 });
      mkr.addTo(map);
      ptDotMarkersRef.current.push(mkr);
    }

    // Draggable start marker
    const sMkr = L.marker([pts[ts].lat, pts[ts].lon], {
      icon: createDotIcon('#22c55e'),
      draggable: true,
    }).addTo(map);
    sMkr.on('dragend', e => {
      const ll = (e.target as L.Marker).getLatLng();
      const nearestIdx = findNearestPoint(editPointsRef.current!, ll.lat, ll.lng);
      const clamped = Math.max(0, Math.min(nearestIdx, trimEndRef.current - 1));
      trimStartRef.current = clamped;
      setTrimStart(clamped);
      sMkr.setLatLng([editPointsRef.current![clamped].lat, editPointsRef.current![clamped].lon]);
      rebuildMapRef.current?.(editPointsRef.current!, clamped, trimEndRef.current, { fit: false });
    });
    startMarkerRef.current = sMkr;

    // Draggable end marker
    const eMkr = L.marker([pts[te].lat, pts[te].lon], {
      icon: createDotIcon('#ef4444'),
      draggable: true,
    }).addTo(map);
    eMkr.on('dragend', e => {
      const ll = (e.target as L.Marker).getLatLng();
      const nearestIdx = findNearestPoint(editPointsRef.current!, ll.lat, ll.lng);
      const clamped = Math.min(editPointsRef.current!.length - 1, Math.max(nearestIdx, trimStartRef.current + 1));
      trimEndRef.current = clamped;
      setTrimEnd(clamped);
      eMkr.setLatLng([editPointsRef.current![clamped].lat, editPointsRef.current![clamped].lon]);
      rebuildMapRef.current?.(editPointsRef.current!, trimStartRef.current, clamped, { fit: false });
    });
    endMarkerRef.current = eMkr;

    // Fit bounds — deferred if the container has no size yet (fresh page load),
    // since fitting a 0×0 map corrupts the view with NaN coordinates
    if (shouldFit) {
      const bounds = L.latLngBounds(pts.map(p => [p.lat, p.lon] as L.LatLngTuple));
      const size = map.getSize();
      if (size.x > 0 && size.y > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
      } else {
        pendingFitRef.current = bounds;
      }
    }
    setTimeout(() => map.invalidateSize(), 80);
  }, []);

  // Keep refs to functions to avoid stale closures in Leaflet handlers
  const rebuildMapRef = useRef(rebuildMap);
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { rebuildMapRef.current = rebuildMap; }, [rebuildMap]);

  const updateTrimPolysRef = useRef<((pts: GpsTrackPoint[], ts: number, te: number) => void) | null>(null);
  const pushHistoryRef = useRef<((pts: GpsTrackPoint[], wps: EditWaypoint[]) => void) | null>(null);
  const handleVertexDragEndRef = useRef<((vertexIdx: number) => void) | null>(null);
  const openWpPopupRef = useRef<((wpId: string) => void) | null>(null);
  const openPtPopupRef = useRef<((gi: number) => void) | null>(null);
  const patchDemElevationsRef = useRef<((targets: Array<{ lat: number; lon: number }>) => void) | null>(null);

  // ── Update trim polylines (light — doesn't touch edit poly or markers) ───
  const updateTrimPolys = useCallback((pts: GpsTrackPoint[], ts: number, te: number) => {
    const map = leafletRef.current;
    if (!map) return;
    trimPolyBeforeRef.current?.remove();
    trimPolyAfterRef.current?.remove();
    if (ts > 0) {
      trimPolyBeforeRef.current = L.polyline(
        pts.slice(0, ts + 1).map(p => [p.lat, p.lon] as L.LatLngTuple),
        { color: '#b0acbe', weight: 3, opacity: 0.5, dashArray: '6,4' },
      ).addTo(map);
    } else { trimPolyBeforeRef.current = null; }
    if (te < pts.length - 1) {
      trimPolyAfterRef.current = L.polyline(
        pts.slice(te).map(p => [p.lat, p.lon] as L.LatLngTuple),
        { color: '#b0acbe', weight: 3, opacity: 0.5, dashArray: '6,4' },
      ).addTo(map);
    } else { trimPolyAfterRef.current = null; }
  }, []);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { updateTrimPolysRef.current = updateTrimPolys; }, [updateTrimPolys]);

  // ── History management ────────────────────────────────────────────────────
  const pushHistory = useCallback((pts: GpsTrackPoint[], wps: EditWaypoint[]) => {
    setHistory(prev => {
      const truncated = prev.slice(0, historyIdxRef.current + 1);
      const next = [...truncated, { points: pts, waypoints: wps }];
      historyArrRef.current = next;
      return next;
    });
    setHistoryIdx(prev => {
      const next = prev + 1;
      historyIdxRef.current = next;
      return next;
    });
  }, []);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { pushHistoryRef.current = pushHistory; }, [pushHistory]);

  // ── Patch freshly added points with real DEM elevation ───────────────────
  const patchDemElevations = useCallback(async (targets: Array<{ lat: number; lon: number }>) => {
    const eles = await fetchElevations(targets);
    if (!eles) return;
    const cur = editPointsRef.current;
    if (!cur) return;
    let changed = false;
    const next = cur.map(p => {
      const k = targets.findIndex(t => t.lat === p.lat && t.lon === p.lon);
      if (k >= 0 && p.ele !== eles[k]) { changed = true; return { ...p, ele: eles[k] }; }
      return p;
    });
    if (!changed) return;
    // Amend the history entry this edit produced, so undo/redo keeps the value
    const hIdx = historyIdxRef.current;
    const hArr = historyArrRef.current;
    if (hArr[hIdx]?.points === cur) {
      const amended = [...hArr];
      amended[hIdx] = { ...amended[hIdx], points: next };
      historyArrRef.current = amended;
      setHistory(amended);
    }
    editPointsRef.current = next;
    setEditPoints(next);
  }, []);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { patchDemElevationsRef.current = patchDemElevations; }, [patchDemElevations]);

  function restoreHistoryEntry(newIdx: number) {
    const entry = historyArrRef.current[newIdx];
    historyIdxRef.current = newIdx;
    setHistoryIdx(newIdx);
    setEditPoints(entry.points);
    editPointsRef.current = entry.points;
    setWaypoints(entry.waypoints);
    waypointsRef.current = entry.waypoints;
    const te = Math.min(trimEndRef.current, entry.points.length - 1);
    setTrimEnd(te);
    trimEndRef.current = te;
    const ts = Math.min(trimStartRef.current, Math.max(0, te - 1));
    setTrimStart(ts);
    trimStartRef.current = ts;
    rebuildMap(entry.points, ts, te, { fit: false });
  }

  function undo() {
    if (historyIdxRef.current <= 0) return;
    restoreHistoryEntry(historyIdxRef.current - 1);
  }

  function redo() {
    if (historyIdxRef.current >= historyArrRef.current.length - 1) return;
    restoreHistoryEntry(historyIdxRef.current + 1);
  }

  // ── Snap-to-ways drag handling ────────────────────────────────────────────
  const flashRoutingError = useCallback((msg: string) => {
    setRoutingError(msg);
    if (routingErrTimerRef.current) clearTimeout(routingErrTimerRef.current);
    routingErrTimerRef.current = setTimeout(() => setRoutingError(null), 4000);
  }, []);

  const handleVertexDragEnd = useCallback(async (vertexIdx: number) => {
    const pts = editPointsRef.current;
    if (!pts) return;
    const ts = trimStartRef.current;
    const te = trimEndRef.current;
    const gi = ts + vertexIdx;
    if (gi < 0 || gi >= pts.length) return;
    const dragged = pts[gi];

    const existing = dragWpIdRef.current
      ? waypointsRef.current.find(w => w.id === dragWpIdRef.current) ?? null
      : null;
    dragWpIdRef.current = null;

    // Re-dragging an existing waypoint re-routes its whole leg (anchor to anchor).
    // A fresh drag replans the entire leg between the nearest existing waypoints
    // (Komoot-style: the new point takes priority, old sub-points in the leg are
    // replaced by the freshly routed path).
    let aPrevIdx: number | null = gi > ts ? gi - 1 : null;
    let aNextIdx: number | null = gi < te ? gi + 1 : null;
    if (existing?.anchorPrev) {
      const i = findNearestPoint(pts, existing.anchorPrev.lat, existing.anchorPrev.lon);
      if (i >= ts && i < gi) aPrevIdx = i;
    }
    if (existing?.anchorNext) {
      const i = findNearestPoint(pts, existing.anchorNext.lat, existing.anchorNext.lon);
      if (i > gi && i <= te) aNextIdx = i;
    }
    // For new vertex drags (interior points only), extend the anchors to the
    // nearest existing waypoints so the whole leg gets re-planned cleanly
    if (!existing && gi > ts && gi < te) {
      const legAnchors = findLegAnchors(pts, waypointsRef.current, ts, te, gi - 1, gi + 1);
      aPrevIdx = legAnchors.aPrevIdx;
      aNextIdx = legAnchors.aNextIdx;
    }
    const anchorPrev = aPrevIdx != null ? pts[aPrevIdx] : null;
    const anchorNext = aNextIdx != null ? pts[aNextIdx] : null;
    const spanStart = aPrevIdx ?? gi;
    const spanEnd = aNextIdx ?? gi;

    const offRoad = existing ? existing.offRoad : !snapEnabledRef.current;
    const wpId = existing?.id ?? `wp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const finish = (newPts: GpsTrackPoint[], wpPoint: GpsTrackPoint) => {
      const newTe = te + (newPts.length - pts.length);
      const wp: EditWaypoint = {
        id: wpId, lat: wpPoint.lat, lon: wpPoint.lon, offRoad,
        anchorPrev: anchorPrev ? { lat: anchorPrev.lat, lon: anchorPrev.lon } : null,
        anchorNext: anchorNext ? { lat: anchorNext.lat, lon: anchorNext.lon } : null,
      };
      // Remove waypoints strictly inside the replaced span — those track points
      // no longer exist after the leg is re-routed (new point has priority)
      const newWps = waypointsRef.current.filter(w => {
        if (w.id === wpId) return false;
        const wpi = findNearestPoint(pts, w.lat, w.lon);
        return wpi <= spanStart || wpi >= spanEnd;
      }).concat([wp]);
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      waypointsRef.current = newWps;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      setWaypoints(newWps);
      pushHistoryRef.current?.(newPts, newWps);
      rebuildMapRef.current?.(newPts, ts, newTe, { fit: false });
    };

    // Straight connection — the moved point still gets a real DEM elevation
    const finishStraight = async () => {
      const span = [
        ...(anchorPrev ? [anchorPrev] : []),
        dragged,
        ...(anchorNext ? [anchorNext] : []),
      ];
      setBusy('Elevation…');
      const span2 = await withDemElevation(span, !!anchorPrev, !!anchorNext);
      setBusy(null);
      if (editPointsRef.current !== pts) return;
      finish([...pts.slice(0, spanStart), ...span2, ...pts.slice(spanEnd + 1)], dragged);
    };

    if (offRoad || (!anchorPrev && !anchorNext)) {
      await finishStraight();
      return;
    }

    const straightDist =
      (anchorPrev ? haversineClient(anchorPrev.lat, anchorPrev.lon, dragged.lat, dragged.lon) : 0) +
      (anchorNext ? haversineClient(dragged.lat, dragged.lon, anchorNext.lat, anchorNext.lon) : 0);
    if (straightDist > 50000) {
      flashRoutingError('Segment too long to snap — kept straight line');
      await finishStraight();
      return;
    }

    setBusy('Routing…');
    try {
      const coords = [anchorPrev, dragged, anchorNext].filter((p): p is GpsTrackPoint => !!p);
      const routed = await fetchRoutedPath(coords, snapProfileRef.current);

      // Track changed while routing was in flight — discard to avoid corrupting state
      if (editPointsRef.current !== pts) return;

      if (!routed) {
        setBusy(null);
        flashRoutingError('Routing unavailable — kept straight line');
        await finishStraight();
        return;
      }

      const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, dragged.ele, routed.legs);
      const wpIdxInSpan = span.indexOf(wpPoint);
      const span2 = await withDemElevation(span, !!anchorPrev, !!anchorNext);
      if (editPointsRef.current !== pts) return;
      finish([...pts.slice(0, spanStart), ...span2, ...pts.slice(spanEnd + 1)], span2[wpIdxInSpan]);
    } finally {
      setBusy(null);
    }
  }, [flashRoutingError]);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { handleVertexDragEndRef.current = handleVertexDragEnd; }, [handleVertexDragEnd]);

  // ── Waypoint / route-point popup ──────────────────────────────────────────
  const openWpPopup = useCallback((wpId: string) => {
    const map = leafletRef.current;
    const wp = waypointsRef.current.find(w => w.id === wpId);
    if (!map || !wp) return;
    const pt = map.latLngToContainerPoint([wp.lat, wp.lon]);
    setPopupXY({ x: pt.x, y: pt.y });
    setCoordsCopied(false);
    setMapClick(null);
    setActiveSel({ kind: 'wp', id: wpId });
  }, []);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { openWpPopupRef.current = openWpPopup; }, [openWpPopup]);

  // Plain route points open the same popup; edited waypoints take precedence
  const openPtPopup = useCallback((gi: number) => {
    const map = leafletRef.current;
    const pts = editPointsRef.current;
    const p = pts?.[gi];
    if (!map || !p) return;
    const wp = waypointsRef.current.find(w => w.lat === p.lat && w.lon === p.lon);
    if (wp) { openWpPopup(wp.id); return; }
    const cp = map.latLngToContainerPoint([p.lat, p.lon]);
    setPopupXY({ x: cp.x, y: cp.y });
    setCoordsCopied(false);
    setMapClick(null);
    setActiveSel({ kind: 'pt', lat: p.lat, lon: p.lon });
  }, [openWpPopup]);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { openPtPopupRef.current = openPtPopup; }, [openPtPopup]);

  // Keep the popup glued to its point while panning/zooming
  useEffect(() => {
    const map = leafletRef.current;
    if (!map || !activeSel) return;
    const update = () => {
      let lat: number, lon: number;
      if (activeSel.kind === 'wp') {
        const wp = waypointsRef.current.find(w => w.id === activeSel.id);
        if (!wp) return;
        lat = wp.lat; lon = wp.lon;
      } else {
        lat = activeSel.lat; lon = activeSel.lon;
      }
      const pt = map.latLngToContainerPoint([lat, lon]);
      setPopupXY({ x: pt.x, y: pt.y });
    };
    map.on('move', update);
    map.on('zoomend', update);
    return () => {
      map.off('move', update);
      map.off('zoomend', update);
    };
  }, [activeSel]);

  const popupData = useMemo(() => {
    if (!activeSel || !editPoints) return null;
    let lat: number, lon: number, wp: EditWaypoint | null = null;
    if (activeSel.kind === 'wp') {
      wp = waypoints.find(w => w.id === activeSel.id) ?? null;
      if (!wp) return null;
      lat = wp.lat; lon = wp.lon;
    } else {
      lat = activeSel.lat; lon = activeSel.lon;
    }
    const idx = findNearestPoint(editPoints, lat, lon);
    const p = editPoints[idx];
    if (!p || p.lat !== lat || p.lon !== lon) return null;
    let dist = 0, gain = 0;
    for (let i = trimStart + 1; i <= idx; i++) {
      dist += haversineClient(editPoints[i - 1].lat, editPoints[i - 1].lon, editPoints[i].lat, editPoints[i].lon);
      const d = editPoints[i].ele - editPoints[i - 1].ele;
      if (d > 0) gain += d;
    }
    let durationS: number | null = null;
    const t0 = editPoints[trimStart]?.time, t1 = p.time;
    if (t0 && t1) {
      const d = (new Date(t1).getTime() - new Date(t0).getTime()) / 1000;
      if (Number.isFinite(d) && d > 0) durationS = d;
    }
    return { wp, point: p, idx, dist, gain, durationS, grade: gradeAt(editPoints, idx) };
  }, [activeSel, editPoints, waypoints, trimStart]);

  // ── Delete the popup's point from the route ───────────────────────────────
  function deleteActivePoint() {
    const sel = activeSel;
    const pts = editPointsRef.current;
    if (!sel || !pts || routingBusy) return;
    let lat: number, lon: number;
    if (sel.kind === 'wp') {
      const wp = waypointsRef.current.find(w => w.id === sel.id);
      if (!wp) return;
      lat = wp.lat; lon = wp.lon;
    } else {
      lat = sel.lat; lon = sel.lon;
    }
    const idx = pts.findIndex(p => p.lat === lat && p.lon === lon);
    const ts = trimStartRef.current, te = trimEndRef.current;
    if (idx < ts || idx > te || te - ts < 2) return;
    const newPts = [...pts.slice(0, idx), ...pts.slice(idx + 1)];
    const newTe = te - 1;
    const newWps = waypointsRef.current.filter(w => !(w.lat === lat && w.lon === lon));
    editPointsRef.current = newPts;
    trimEndRef.current = newTe;
    waypointsRef.current = newWps;
    setEditPoints(newPts);
    setTrimEnd(newTe);
    setWaypoints(newWps);
    setActiveSel(null);
    pushHistory(newPts, newWps);
    rebuildMap(newPts, ts, newTe, { fit: false });
  }

  // ── Toggle a waypoint between follow-ways and off-road ────────────────────
  async function toggleWaypointMode(wpId: string) {
    const pts = editPointsRef.current;
    if (!pts || routingBusy) return;
    const wp = waypointsRef.current.find(w => w.id === wpId);
    if (!wp) return;
    const wpIdx = findNearestPoint(pts, wp.lat, wp.lon);
    const ts = trimStartRef.current, te = trimEndRef.current;
    let aPrevIdx: number | null = wpIdx > ts ? wpIdx - 1 : null;
    let aNextIdx: number | null = wpIdx < te ? wpIdx + 1 : null;
    if (wp.anchorPrev) {
      const i = findNearestPoint(pts, wp.anchorPrev.lat, wp.anchorPrev.lon);
      if (i >= ts && i < wpIdx) aPrevIdx = i;
    }
    if (wp.anchorNext) {
      const i = findNearestPoint(pts, wp.anchorNext.lat, wp.anchorNext.lon);
      if (i > wpIdx && i <= te) aNextIdx = i;
    }
    const anchorPrev = aPrevIdx != null ? pts[aPrevIdx] : null;
    const anchorNext = aNextIdx != null ? pts[aNextIdx] : null;
    const wpPt = pts[wpIdx];
    const targetOffRoad = !wp.offRoad;
    const spanStart = aPrevIdx ?? wpIdx;
    const spanEnd = aNextIdx ?? wpIdx;

    if (!anchorPrev && !anchorNext) {
      const newWps = waypointsRef.current.map(w => w.id === wpId ? { ...w, offRoad: targetOffRoad } : w);
      waypointsRef.current = newWps;
      setWaypoints(newWps);
      return;
    }

    const apply = (newPts: GpsTrackPoint[], newWpPt: GpsTrackPoint) => {
      const newTe = te + (newPts.length - pts.length);
      const newWp: EditWaypoint = {
        ...wp, lat: newWpPt.lat, lon: newWpPt.lon, offRoad: targetOffRoad,
        anchorPrev: anchorPrev ? { lat: anchorPrev.lat, lon: anchorPrev.lon } : wp.anchorPrev,
        anchorNext: anchorNext ? { lat: anchorNext.lat, lon: anchorNext.lon } : wp.anchorNext,
      };
      const newWps = waypointsRef.current.map(w => w.id === wpId ? newWp : w);
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      waypointsRef.current = newWps;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      setWaypoints(newWps);
      pushHistory(newPts, newWps);
      rebuildMap(newPts, ts, newTe, { fit: false });
      const map = leafletRef.current;
      if (map) {
        const cp = map.latLngToContainerPoint([newWpPt.lat, newWpPt.lon]);
        setPopupXY({ x: cp.x, y: cp.y });
      }
    };

    if (targetOffRoad) {
      const span = [...(anchorPrev ? [anchorPrev] : []), wpPt, ...(anchorNext ? [anchorNext] : [])];
      apply([...pts.slice(0, spanStart), ...span, ...pts.slice(spanEnd + 1)], wpPt);
      return;
    }

    setBusy('Routing…');
    try {
      const coords = [anchorPrev, wpPt, anchorNext].filter((p): p is GpsTrackPoint => !!p);
      const routed = await fetchRoutedPath(coords, snapProfileRef.current);
      if (editPointsRef.current !== pts) return;
      if (!routed) {
        flashRoutingError('Routing unavailable — waypoint kept off-road');
        return;
      }
      const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, wpPt.ele, routed.legs);
      const wpIdxInSpan = span.indexOf(wpPoint);
      const span2 = await withDemElevation(span, !!anchorPrev, !!anchorNext);
      if (editPointsRef.current !== pts) return;
      apply([...pts.slice(0, spanStart), ...span2, ...pts.slice(spanEnd + 1)], span2[wpIdxInSpan]);
    } finally {
      setBusy(null);
    }
  }

  // ── Map click: dismiss an open waypoint popup, or drop an inspection pin ──
  const handleMapClick = useCallback((e: L.LeafletMouseEvent) => {
    if ((e.originalEvent?.detail ?? 1) > 1) return; // second click of a dblclick zoom
    if (activeSel) { setActiveSel(null); return; }
    const map = leafletRef.current;
    if (!map) return;
    const lat = e.latlng.lat, lon = e.latlng.lng;
    const cp = map.latLngToContainerPoint([lat, lon]);
    setMapClickXY({ x: cp.x, y: cp.y });
    setMapClick({ lat, lon, ele: null, name: null, loading: true });
    Promise.all([fetchElevations([{ lat, lon }]), reverseGeocode(lat, lon)]).then(([eles, name]) => {
      setMapClick(prev => prev && prev.lat === lat && prev.lon === lon
        ? { ...prev, ele: eles?.[0] ?? null, name, loading: false }
        : prev);
    });
  }, [activeSel]);

  useEffect(() => { mapClickHandlerRef.current = handleMapClick; }, [handleMapClick]);

  // Inspection pin + keep the click popup glued to its spot while panning/zooming
  const mcLat = mapClick?.lat, mcLon = mapClick?.lon;
  useEffect(() => {
    const map = leafletRef.current;
    if (!map || mcLat == null || mcLon == null) return;
    const pin = L.marker([mcLat, mcLon], { icon: createClickPinIcon(), interactive: false, zIndexOffset: 400 }).addTo(map);
    clickPinRef.current = pin;
    const update = () => {
      const cp = map.latLngToContainerPoint([mcLat, mcLon]);
      setMapClickXY({ x: cp.x, y: cp.y });
    };
    map.on('move', update);
    map.on('zoomend', update);
    return () => {
      map.off('move', update);
      map.off('zoomend', update);
      pin.remove();
      clickPinRef.current = null;
    };
  }, [mcLat, mcLon]);

  // ── Chart hover → position marker on the map ──────────────────────────────
  useEffect(() => {
    const map = leafletRef.current;
    if (!map) return;
    const p = hoveredIdx != null && editPoints ? editPoints[hoveredIdx] : null;
    if (!p) {
      hoverMarkerRef.current?.setStyle({ opacity: 0, fillOpacity: 0 });
      return;
    }
    const ll: L.LatLngTuple = [p.lat, p.lon];
    if (hoverMarkerRef.current) {
      hoverMarkerRef.current.setLatLng(ll);
      hoverMarkerRef.current.setStyle({ opacity: 1, fillOpacity: 1 });
    } else {
      hoverMarkerRef.current = L.circleMarker(ll, {
        radius: 8, fillColor: '#5e4dbb', color: '#fff', weight: 2.5, fillOpacity: 1, interactive: false,
      }).addTo(map);
    }
  }, [hoveredIdx, editPoints]);

  // ── Add a clicked map point into the route (Komoot-style leg re-planning) ─
  // Instead of inserting between the two nearest consecutive track points (which
  // creates a V-shaped detour), we find the nearest existing *waypoints* on
  // either side and re-plan the entire leg between them through the new point.
  // Old intermediate track points in that leg are discarded (new point has
  // priority, as with Komoot / Google Maps route editing).
  async function addClickedPointToRoute() {
    const mc = mapClick;
    const pts = editPointsRef.current;
    if (!mc || !pts || routingBusy) return;
    const ts = trimStartRef.current, te = trimEndRef.current;
    if (te - ts < 1) return;

    // Find the active segment closest to the clicked point
    let best = ts, bestD = Infinity;
    for (let i = ts; i < te; i++) {
      const d = distToSegmentM(mc, pts[i], pts[i + 1]);
      if (d < bestD) { bestD = d; best = i; }
    }

    // Leg anchors: nearest existing waypoints (or start/end) on either side of
    // the clicked segment — the whole leg between them will be re-routed
    const { aPrevIdx, aNextIdx } = findLegAnchors(pts, waypointsRef.current, ts, te, best, best + 1);
    const anchorPrev = pts[aPrevIdx];
    const anchorNext = pts[aNextIdx];

    const newPt: GpsTrackPoint = { lat: mc.lat, lon: mc.lon, ele: mc.ele ?? (anchorPrev.ele + anchorNext.ele) / 2 };
    const offRoad = !snapEnabledRef.current;
    const wpId = `wp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setMapClick(null);

    const finish = (newPts: GpsTrackPoint[], wpPoint: GpsTrackPoint) => {
      const newTe = te + (newPts.length - pts.length);
      const wp: EditWaypoint = {
        id: wpId, lat: wpPoint.lat, lon: wpPoint.lon, offRoad,
        anchorPrev: { lat: anchorPrev.lat, lon: anchorPrev.lon },
        anchorNext: { lat: anchorNext.lat, lon: anchorNext.lon },
      };
      // Remove waypoints strictly inside the replaced leg — they no longer
      // correspond to any track point after the re-plan
      const newWps = waypointsRef.current.filter(w => {
        const wpi = findNearestPoint(pts, w.lat, w.lon);
        return wpi <= aPrevIdx || wpi >= aNextIdx;
      }).concat([wp]);
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      waypointsRef.current = newWps;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      setWaypoints(newWps);
      pushHistory(newPts, newWps);
      rebuildMap(newPts, ts, newTe, { fit: false });
    };

    const finishStraight = async () => {
      const span = [anchorPrev, newPt, anchorNext];
      setBusy('Elevation…');
      const span2 = await withDemElevation(span, true, true);
      setBusy(null);
      if (editPointsRef.current !== pts) return;
      finish([...pts.slice(0, aPrevIdx), ...span2, ...pts.slice(aNextIdx + 1)], newPt);
    };

    const straightDist =
      haversineClient(anchorPrev.lat, anchorPrev.lon, newPt.lat, newPt.lon) +
      haversineClient(newPt.lat, newPt.lon, anchorNext.lat, anchorNext.lon);
    if (offRoad || straightDist > 200000) {
      if (straightDist > 200000) flashRoutingError('Leg too long to snap — connected with straight lines');
      await finishStraight();
      return;
    }

    setBusy('Routing…');
    try {
      const routed = await fetchRoutedPath([anchorPrev, newPt, anchorNext], snapProfileRef.current);
      if (editPointsRef.current !== pts) return;
      if (!routed) {
        setBusy(null);
        flashRoutingError('Routing unavailable — connected with straight lines');
        await finishStraight();
        return;
      }
      const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, newPt.ele, routed.legs);
      const wpIdxInSpan = span.indexOf(wpPoint);
      const span2 = await withDemElevation(span, true, true);
      if (editPointsRef.current !== pts) return;
      finish([...pts.slice(0, aPrevIdx), ...span2, ...pts.slice(aNextIdx + 1)], span2[wpIdxInSpan]);
    } finally {
      setBusy(null);
    }
  }

  function renderEditPoiMarkers(poiList: OverpassPoi[]) {
    const layer = poiLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    poiList.forEach(poi => {
      const icon = L.divIcon({
        className: '',
        html: createPoiDivIcon(poi.category),
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker([poi.lat, poi.lon], { icon })
        .on('click', () => {
          setAddPinDialog({
            lat: poi.lat, lon: poi.lon,
            suggestedName: poi.name,
            suggestedSym: poi.category,
            poi,
          });
          setAddPinName(poi.name);
          setAddPinMode('pin');
        })
        .addTo(layer);
    });
  }

  // Fetch POIs wenn Karte bewegt wird oder Kategorien sich ändern (identisch zu GPSScreen)
  useEffect(() => {
    const map = leafletRef.current;
    if (!map) return;

    function scheduleFetch() {
      if (poiFetchTimerRef.current) clearTimeout(poiFetchTimerRef.current);
      poiFetchTimerRef.current = setTimeout(() => {
        const zoom = map?.getZoom();
        if (!zoom || zoom < 13 || activePoi.size === 0) {
          poiLayerRef.current?.clearLayers();
          return;
        }
        if (map) doFetch(map.getBounds());
      }, 600);
    }

    map.on('moveend', scheduleFetch);
    map.on('zoomend', scheduleFetch);

    scheduleFetch();

    return () => {
      map.off('moveend', scheduleFetch);
      map.off('zoomend', scheduleFetch);
      if (poiFetchTimerRef.current) clearTimeout(poiFetchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePoi, mapReady]);

  async function doFetch(bounds: L.LatLngBounds) {
    poiFetchControllerRef.current?.abort();
    const ctrl = new AbortController();
    poiFetchControllerRef.current = ctrl;
    setPoiLoading(true);
    try {
      // Add small buffer (approx 100m) to catch POIs right at the edge
      const PAD = 0.001;
      const result = await queryOverpass(
        bounds.getSouth() - PAD, bounds.getWest() - PAD,
        bounds.getNorth() + PAD, bounds.getEast() + PAD,
        [...activePoi], ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      renderEditPoiMarkers(result);
    } catch { /* ignore */ }
    finally { if (!ctrl.signal.aborted) setPoiLoading(false); }
  }

  function handleSearchChange(q: string) {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!q.trim()) { setSearchResults([]); return; }

    const coords = parseCoordInput(q);
    if (coords) {
      setSearchResults([]);
      const map = leafletRef.current;
      if (map) map.flyTo([coords[0], coords[1]], 15, { animate: true, duration: 1.2 });
      setAddPinDialog({
        lat: coords[0], lon: coords[1],
        suggestedName: `${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`,
        suggestedSym: 'generic',
      });
      setAddPinName(`${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`);
      setAddPinMode('pin');
      return;
    }

    searchDebounceRef.current = setTimeout(async () => {
      searchControllerRef.current?.abort();
      const ctrl = new AbortController();
      searchControllerRef.current = ctrl;
      setSearchLoading(true);
      try {
        const map = leafletRef.current;
        const bounds = map?.getBounds();
        const results = await searchNominatim(q, bounds ? {
          south: bounds.getSouth(), west: bounds.getWest(),
          north: bounds.getNorth(), east: bounds.getEast(),
        } : undefined, ctrl.signal);
        if (!ctrl.signal.aborted) setSearchResults(results.slice(0, 5));
      } catch { /* ignore */ }
      finally { if (!ctrl.signal.aborted) setSearchLoading(false); }
    }, 400);
  }

  function handleSearchSelectEdit(r: NominatimResult) {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    const map = leafletRef.current;
    if (!map || isNaN(lat) || isNaN(lon)) return;
    map.flyTo([lat, lon], 15, { animate: true, duration: 1.2 });

    setAddPinDialog({
      lat, lon,
      suggestedName: r.display_name.split(',')[0],
      suggestedSym: 'generic',
    });
    setAddPinName(r.display_name.split(',')[0]);
    setAddPinMode('pin');

    setSearchResults([]);
    setSearchOpen(false);
  }

  function handleAddPin() {
    const d = addPinDialog;
    if (!d) return;

    const pin: NamedPin = {
      id: crypto.randomUUID(),
      lat: d.lat, lon: d.lon, ele: d.ele,
      name: addPinName.trim() || d.suggestedName,
      sym: d.suggestedSym,
      highlighted: false,
      addedToRoute: addPinMode === 'route',
    };

    setNamedPins(prev => [...prev, pin]);
    renderNamedPinMarker(pin);

    if (addPinMode === 'route') {
      // Den nächstgelegenen Punkt auf der Route finden und als Waypoint einfügen
      insertWaypointAt(d.lat, d.lon, d.ele);
    }

    setAddPinDialog(null);
    setAddPinName('');
  }

  async function insertWaypointAt(lat: number, lon: number, ele?: number) {
    const pts = editPointsRef.current;
    if (!pts || routingBusy) return;
    const ts = trimStartRef.current, te = trimEndRef.current;
    if (te - ts < 1) return;

    let best = ts, bestD = Infinity;
    for (let i = ts; i < te; i++) {
      const d = distToSegmentM({ lat, lon }, pts[i], pts[i + 1]);
      if (d < bestD) { bestD = d; best = i; }
    }

    const { aPrevIdx, aNextIdx } = findLegAnchors(pts, waypointsRef.current, ts, te, best, best + 1);
    const anchorPrev = pts[aPrevIdx];
    const anchorNext = pts[aNextIdx];

    const newPt: GpsTrackPoint = { lat, lon, ele: ele ?? (anchorPrev.ele + anchorNext.ele) / 2 };
    const wpId = `wp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const apply = (newPts: GpsTrackPoint[], wpPoint: GpsTrackPoint) => {
      const newTe = te + (newPts.length - pts.length);
      const wp: EditWaypoint = {
        id: wpId, lat: wpPoint.lat, lon: wpPoint.lon, offRoad: !snapEnabledRef.current,
        anchorPrev: { lat: anchorPrev.lat, lon: anchorPrev.lon },
        anchorNext: { lat: anchorNext.lat, lon: anchorNext.lon },
      };
      const newWps = waypointsRef.current.filter(w => {
        const wpi = findNearestPoint(pts, w.lat, w.lon);
        return wpi <= aPrevIdx || wpi >= aNextIdx;
      }).concat([wp]);
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      waypointsRef.current = newWps;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      setWaypoints(newWps);
      pushHistory(newPts, newWps);
      rebuildMap(newPts, ts, newTe, { fit: false });
    };

    if (!snapEnabledRef.current) {
      const span = [anchorPrev, newPt, anchorNext];
      const span2 = await withDemElevation(span, true, true);
      apply([...pts.slice(0, aPrevIdx), ...span2, ...pts.slice(aNextIdx + 1)], newPt);
      return;
    }

    setBusy('Routing…');
    try {
      const routed = await fetchRoutedPath([anchorPrev, newPt, anchorNext], snapProfileRef.current);
      if (editPointsRef.current !== pts) return;
      if (!routed) {
        const span = [anchorPrev, newPt, anchorNext];
        const span2 = await withDemElevation(span, true, true);
        apply([...pts.slice(0, aPrevIdx), ...span2, ...pts.slice(aNextIdx + 1)], newPt);
        return;
      }
      const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, newPt.ele, routed.legs);
      const span2 = await withDemElevation(span, true, true);
      const wpIdxInSpan = span.indexOf(wpPoint);
      if (editPointsRef.current !== pts) return;
      apply([...pts.slice(0, aPrevIdx), ...span2, ...pts.slice(aNextIdx + 1)], span2[wpIdxInSpan]);
    } finally {
      setBusy(null);
    }
  }

  function renderNamedPinMarker(pin: NamedPin) {
    const map = leafletRef.current;
    if (!map) return;

    namedPinMarkersRef.current.get(pin.id)?.remove();

    const icon = L.divIcon({
      className: '',
      html: createPinDivIcon(pin.sym, pin.highlighted, 30),
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

    const marker = L.marker([pin.lat, pin.lon], { icon, zIndexOffset: 200 })
      .on('click', () => {
        setEditingPin(pin.id);
      })
      .addTo(map);

    namedPinMarkersRef.current.set(pin.id, marker);
  }

  function removeNamedPinMarker(pinId: string) {
    namedPinMarkersRef.current.get(pinId)?.remove();
    namedPinMarkersRef.current.delete(pinId);
  }

  function computePinDistance(pin: NamedPin, points: GpsTrackPoint[]): number | null {
    if (points.length === 0) return null;
    const nearestIdx = findNearestPoint(points, pin.lat, pin.lon);
    let dist = 0;
    for (let i = 1; i <= nearestIdx; i++) {
      dist += haversineClient(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);
    }
    return Math.round(dist);
  }

  // ── Build map once editPoints are loaded ──────────────────────────────────
  const mapBuiltRef = useRef(false);
  useEffect(() => {
    // leafletRef.current is set synchronously by mapCallbackRef before effects run
    if (!editPoints || !leafletRef.current || mapBuiltRef.current) return;
    mapBuiltRef.current = true;
    rebuildMap(editPoints, trimStart, trimEnd);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editPoints]);

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave(mode: 'new' | 'replace') {
    if (!id || !editPoints || saving) return;
    setSaving(mode);
    setSaveError(null);
    setSaveMenuOpen(false);
    try {
      const finalPoints = editPoints.slice(trimStart, trimEnd + 1);
      const result = await apiSaveEditedGpsTrack(id, finalPoints, {
        saveAs: mode,
        name: mode === 'new' ? editName.trim() || undefined : undefined,
        waypoints: namedPins.map(p => ({
          lat: p.lat, lon: p.lon, ele: p.ele,
          name: p.name,
          description: p.description,
          sym: p.sym,
          highlighted: p.highlighted,
        })),
      });
      // Update store
      if (mode === 'new') {
        setFiles(prev => [result, ...prev]);
      } else {
        setFiles(prev => prev.map(f => f.id === id ? result : f));
      }
      window.dispatchEvent(new CustomEvent('gps-files-changed'));
      navigate(`/gps?file=${result.id}`);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveError('Failed to save. Please try again.');
    } finally {
      setSaving(null);
    }
  }

  // ── Live stats ────────────────────────────────────────────────────────────
  const liveStats = useMemo(() => {
    if (!editPoints) return null;
    const trimmed = editPoints.slice(trimStart, trimEnd + 1);
    let dist = 0, elev = 0;
    for (let i = 1; i < trimmed.length; i++) {
      dist += haversineClient(trimmed[i - 1].lat, trimmed[i - 1].lon, trimmed[i].lat, trimmed[i].lon);
      const δ = trimmed[i].ele - trimmed[i - 1].ele;
      if (δ > 0) elev += δ;
    }
    return { distance: Math.round(dist), elevGain: Math.round(elev), points: trimmed.length };
  }, [editPoints, trimStart, trimEnd]);

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  const secBtnStyle: React.CSSProperties = {
    width: '100%', padding: '7px 0', borderRadius: 8,
    border: '1px solid #e8e4f0', background: '#fff', color: '#484552',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'Hanken Grotesk, sans-serif',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    transition: 'background 150ms',
  };

  const mapCtrlBtn: React.CSSProperties = {
    width: 36, height: 36, borderRadius: 9,
    background: 'rgba(255,255,255,0.88)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255,255,255,0.75)',
    boxShadow: '0 2px 12px rgba(94,77,187,0.10)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
    transition: 'box-shadow 150ms, background 150ms',
  };

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf9ff', fontFamily: 'Inter, sans-serif', color: '#787584', fontSize: 14 }}>
        Loading route…
      </div>
    );
  }

  return (
    <>
      <style>{`
        .leaflet-div-icon { background: transparent !important; border: none !important; }
        .leaflet-editing-icon {
          background: #5e4dbb !important; border: 2.5px solid white !important;
          border-radius: 50% !important; width: 10px !important; height: 10px !important;
          margin-left: -5px !important; margin-top: -5px !important;
        }
        .leaflet-middle-icon {
          background: rgba(94,77,187,0.45) !important; border: 2px solid white !important;
          border-radius: 50% !important;
        }
        .gps-map-ctrl:hover { box-shadow: 0 4px 18px rgba(94,77,187,0.18) !important; background: rgba(255,255,255,0.97) !important; }
        @keyframes wpPopIn { from { opacity: 0; transform: translate(-50%, -100%) scale(0.96); } to { opacity: 1; transform: translate(-50%, -100%) scale(1); } }
        @keyframes wpSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#faf9ff', fontFamily: 'Inter, sans-serif' }}>

        {/* ── Edit Sidebar ────────────────────────────────────────────────── */}
        <div style={{
          width: 280, flexShrink: 0,
          background: '#faf9ff', borderRight: '1px solid #e8e4f0',
          display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <button
              onClick={() => navigate(`/gps?file=${id}`)}
              style={{
                ...secBtnStyle, width: 'auto', padding: '5px 10px', marginBottom: 10,
                fontSize: 11, color: '#787584', border: '1px solid #e8e4f0',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              <Icon name="arrow_back" size={13} color="#787584" />
              Route Map
            </button>
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Route name"
              style={{
                width: '100%', padding: '7px 10px', boxSizing: 'border-box',
                background: '#fff', border: '1px solid #e8e4f0',
                borderRadius: 8, fontSize: 13, fontWeight: 600,
                color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif',
                outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#e8e4f0'; }}
            />
          </div>

          {/* Live Stats */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.06em', marginBottom: 8 }}>CURRENT STATS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {([
                { label: 'Distance', value: liveStats ? fmtDist(liveStats.distance) : '—' },
                { label: 'Elev Gain', value: liveStats ? fmtElev(liveStats.elevGain) : '—' },
                { label: 'Points', value: liveStats ? String(liveStats.points) : '—' },
              ]).map(s => (
                <div key={s.label} style={{ background: '#fff', borderRadius: 8, padding: '7px 8px', border: '1px solid #e8e4f0' }}>
                  <div style={{ fontSize: 9, color: '#b0acbe', marginBottom: 3 }}>{s.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Trim section */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.06em', marginBottom: 6 }}>TRIM ROUTE</div>
            <div style={{ fontSize: 11, color: '#787584', marginBottom: 10, lineHeight: 1.5 }}>
              Drag the green/red handles on the map or chart to trim start/end.
            </div>
            {editPoints && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                <div style={{ background: '#fff', borderRadius: 8, padding: '7px 10px', border: '1px solid #e8e4f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
                    <span style={{ fontSize: 9, color: '#b0acbe' }}>Start</span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    pt {trimStart + 1}
                  </div>
                </div>
                <div style={{ background: '#fff', borderRadius: 8, padding: '7px 10px', border: '1px solid #e8e4f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
                    <span style={{ fontSize: 9, color: '#b0acbe' }}>End</span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    pt {trimEnd + 1} / {editPoints.length}
                  </div>
                </div>
              </div>
            )}
            <button
              onClick={() => {
                if (!editPoints) return;
                const te = editPoints.length - 1;
                setTrimStart(0); setTrimEnd(te);
                trimStartRef.current = 0; trimEndRef.current = te;
                updateTrimPolys(editPoints, 0, te);
                startMarkerRef.current?.setLatLng([editPoints[0].lat, editPoints[0].lon]);
                endMarkerRef.current?.setLatLng([editPoints[te].lat, editPoints[te].lon]);
              }}
              style={{ ...secBtnStyle, fontSize: 11 }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              Reset Trim
            </button>
          </div>

          {/* Routing */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.06em', marginBottom: 8 }}>ROUTING</div>
            <button
              onClick={() => setSnapEnabled(v => !v)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 10px', borderRadius: 8, border: '1px solid #e8e4f0',
                background: '#fff', cursor: 'pointer', transition: 'background 150ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>Snap to ways</span>
              <div style={{
                width: 32, height: 18, borderRadius: 10, position: 'relative', flexShrink: 0,
                background: snapEnabled ? '#5e4dbb' : '#d8d4e4', transition: 'background 180ms',
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: snapEnabled ? 16 : 2,
                  width: 14, height: 14, borderRadius: '50%', background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left 180ms',
                }} />
              </div>
            </button>
            {snapEnabled && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
                  {([
                    { value: 'mtb' as const, label: 'MTB', icon: 'directions_bike', desc: 'All available paths & trails' },
                    { value: 'gravel' as const, label: 'Gravel', icon: 'terrain', desc: 'Gravel tracks, no MTB trails' },
                    { value: 'road' as const, label: 'Road', icon: 'pedal_bike', desc: 'Paved roads for road cycling' },
                    { value: 'hike' as const, label: 'Hike', icon: 'hiking', desc: 'Hiking paths & alpine trails' },
                  ]).map(opt => {
                    const active = snapProfile === opt.value;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setSnapProfile(opt.value)}
                        title={opt.desc}
                        style={{
                          padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                          border: `1.5px solid ${active ? '#5e4dbb' : '#e8e4f0'}`,
                          background: active ? '#f5f3ff' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          transition: 'all 150ms',
                        }}
                      >
                        <Icon name={opt.icon} size={14} color={active ? '#5e4dbb' : '#b0acbe'} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: active ? '#5e4dbb' : '#787584', fontFamily: 'Hanken Grotesk, sans-serif' }}>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: '#9c6bde', marginTop: 6, fontWeight: 500 }}>
                  {({
                    mtb: 'All available paths & trails',
                    gravel: 'Gravel tracks, no MTB trails',
                    road: 'Paved roads for road cycling',
                    hike: 'Hiking paths & alpine trails',
                  })[snapProfile]}
                </div>
              </>
            )}
            <div style={{ fontSize: 10.5, color: '#b0acbe', marginTop: 8, lineHeight: 1.5 }}>
              Dragged points connect along mapped ways. Click a waypoint dot to switch it to off-road, or click anywhere on the map to add a point.
            </div>
          </div>

          {/* ── NAMED PINS / WEGPUNKTE ─────────────────────────── */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.06em', marginBottom: 8 }}>
              WEGPUNKTE {namedPins.length > 0 && `(${namedPins.length})`}
            </div>

            {namedPins.length === 0 ? (
              <div style={{ fontSize: 11, color: '#b0acbe', fontStyle: 'italic', marginBottom: 8 }}>
                Noch keine Wegpunkte. Klicke auf einen POI oder nutze die Suche.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {namedPins.map((pin) => {
                  const cfg = POI_CATEGORY_CONFIG[pin.sym as PoiCategory];
                  const isEditing = editingPin === pin.id;
                  // Distanz vom Track-Start berechnen
                  const dist = computePinDistance(pin, editPoints ?? []);

                  return (
                    <div key={pin.id} style={{
                      background: pin.highlighted ? '#faf7ff' : '#fff',
                      border: `1px solid ${pin.highlighted ? '#c4b8f0' : '#e8e4f0'}`,
                      borderRadius: 8, padding: '8px 10px',
                    }}>
                      {isEditing ? (
                        /* Rename Mode */
                        <div>
                          <input
                            autoFocus
                            value={pin.name}
                            onChange={e => setNamedPins(prev => prev.map(p => p.id === pin.id ? { ...p, name: e.target.value } : p))}
                            onBlur={() => setEditingPin(null)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingPin(null); }}
                            style={{
                              width: '100%', boxSizing: 'border-box',
                              padding: '5px 8px', borderRadius: 6,
                              border: '1px solid #5e4dbb', fontSize: 12,
                              fontFamily: 'Inter, sans-serif', color: '#1c1b22',
                              outline: 'none',
                            }}
                          />
                        </div>
                      ) : (
                        /* Display Mode */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {/* Category Icon */}
                          <span
                            className="material-symbols-outlined"
                            style={{ fontSize: 14, color: cfg?.fg ?? '#5e4dbb', flexShrink: 0,
                              fontVariationSettings: "'FILL' 1,'wght' 400" }}
                          >
                            {cfg?.icon ?? 'push_pin'}
                          </span>

                          {/* Name + Distance */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {pin.name}
                            </div>
                            <div style={{ fontSize: 10, color: '#b0acbe', display: 'flex', gap: 4, alignItems: 'center' }}>
                              {dist != null && <span>@ {fmtDist(dist)}</span>}
                              <span style={{
                                background: pin.addedToRoute ? '#ede9ff' : '#f1f5f9',
                                color: pin.addedToRoute ? '#5e4dbb' : '#64748b',
                                borderRadius: 3, padding: '1px 4px', fontSize: 9, fontWeight: 600,
                              }}>
                                {pin.addedToRoute ? 'Route-Stop' : 'Pin'}
                              </span>
                            </div>
                          </div>

                          {/* Actions */}
                          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                            {/* Highlight Toggle */}
                            <button
                              onClick={() => {
                                const updated = { ...pin, highlighted: !pin.highlighted };
                                setNamedPins(prev => prev.map(p => p.id === pin.id ? updated : p));
                                // Marker neu rendern
                                renderNamedPinMarker(updated);
                              }}
                              title={pin.highlighted ? 'Highlight entfernen' : 'Hervorheben'}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', borderRadius: 4 }}
                            >
                              <Icon name="star" size={13} color={pin.highlighted ? '#5e4dbb' : '#c4b8f0'} />
                            </button>

                            {/* Rename */}
                            <button
                              onClick={() => setEditingPin(pin.id)}
                              title="Umbenennen"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', borderRadius: 4 }}
                            >
                              <Icon name="edit" size={13} color="#b0acbe" />
                            </button>

                            {/* Auf Karte fokussieren */}
                            <button
                              onClick={() => leafletRef.current?.flyTo([pin.lat, pin.lon], 16, { animate: true, duration: 0.8 })}
                              title="Auf Karte anzeigen"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', borderRadius: 4 }}
                            >
                              <Icon name="my_location" size={13} color="#b0acbe" />
                            </button>

                            {/* Löschen */}
                            <button
                              onClick={() => {
                                setNamedPins(prev => prev.filter(p => p.id !== pin.id));
                                removeNamedPinMarker(pin.id);
                              }}
                              title="Entfernen"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', borderRadius: 4 }}
                            >
                              <Icon name="delete" size={13} color="#fca5a5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Manuellen Wegpunkt an Karten-Mitte setzen */}
            <button
              onClick={() => {
                const map = leafletRef.current;
                if (!map) return;
                const center = map.getCenter();
                setAddPinDialog({
                  lat: center.lat, lon: center.lng,
                  suggestedName: 'Wegpunkt',
                  suggestedSym: 'generic',
                });
                setAddPinName('Wegpunkt');
                setAddPinMode('pin');
              }}
              style={{
                width: '100%', padding: '7px 0', borderRadius: 8,
                border: '1px dashed #c4b8f0', background: 'transparent', color: '#5e4dbb',
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'Hanken Grotesk, sans-serif',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                transition: 'all 150ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="add_location" size={13} color="#5e4dbb" />
              Wegpunkt an Kartenmitte
            </button>
          </div>

          {/* Undo/Redo */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button
                disabled={!canUndo}
                onClick={undo}
                style={{ ...secBtnStyle, flex: 1, opacity: canUndo ? 1 : 0.45 }}
                onMouseEnter={e => { if (canUndo) e.currentTarget.style.background = '#f5f3ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
              >
                <Icon name="undo" size={13} color={canUndo ? '#5e4dbb' : '#c4b8f0'} />
                Undo
              </button>
              <button
                disabled={!canRedo}
                onClick={redo}
                style={{ ...secBtnStyle, flex: 1, opacity: canRedo ? 1 : 0.45 }}
                onMouseEnter={e => { if (canRedo) e.currentTarget.style.background = '#f5f3ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
              >
                <Icon name="redo" size={13} color={canRedo ? '#5e4dbb' : '#c4b8f0'} />
                Redo
              </button>
            </div>
            <button
              onClick={() => {
                if (!originalPoints) return;
                setEditPoints(originalPoints);
                editPointsRef.current = originalPoints;
                const te = originalPoints.length - 1;
                setTrimStart(0); setTrimEnd(te);
                trimStartRef.current = 0; trimEndRef.current = te;
                setWaypoints([]);
                waypointsRef.current = [];
                setActiveSel(null);
                setHistory([{ points: originalPoints, waypoints: [] }]);
                setHistoryIdx(0);
                historyArrRef.current = [{ points: originalPoints, waypoints: [] }];
                historyIdxRef.current = 0;
                rebuildMap(originalPoints, 0, te);
              }}
              style={{ ...secBtnStyle, color: '#ba1a1a', borderColor: '#fca5a5', fontSize: 11 }}
              onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              Reset to Original
            </button>
          </div>

          {/* How to edit hint */}
          <div style={{ padding: '10px 16px', flex: 1, overflowY: 'auto' }}>
            <div style={{ background: '#ede9ff', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#5e4dbb', marginBottom: 4 }}>How to edit</div>
              <div style={{ fontSize: 11, color: '#5e4dbb', lineHeight: 1.65, opacity: 0.8 }}>
                • Drag any point — it snaps to mapped ways<br />
                • Click anywhere on the map to add a point<br />
                • Click midpoint dots for a quick insert<br />
                • Click any point for details, off-road &amp; delete<br />
                • Hover the chart to find the spot on the map<br />
                • Drag the green/red markers to trim
              </div>
            </div>
            {fileInfo && (
              <div style={{ marginTop: 10, fontSize: 10, color: '#b0acbe' }}>
                Original: {fileInfo.name}
                {originalPoints && <><br />{originalPoints.length} pts (simplified)</>}
              </div>
            )}
          </div>

          {/* Save / Discard footer */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid #e8e4f0', flexShrink: 0 }}>
            {saveError && (
              <div style={{ fontSize: 11, color: '#ba1a1a', marginBottom: 8, padding: '6px 10px', background: '#fff5f5', borderRadius: 6, border: '1px solid #fca5a5' }}>
                {saveError}
              </div>
            )}
            <button
              onClick={() => navigate(`/gps?file=${id}`)}
              style={{ ...secBtnStyle, marginBottom: 6, fontSize: 12 }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            >
              Discard Changes
            </button>

            {/* Save split button */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', gap: 1, borderRadius: 9, overflow: 'hidden', border: '1.5px solid #5e4dbb' }}>
                <button
                  onClick={() => handleSave('new')}
                  disabled={!!saving}
                  style={{
                    flex: 1, padding: '9px 12px',
                    background: saving ? '#c4b8f0' : '#5e4dbb', color: '#fff',
                    fontSize: 12, fontWeight: 600, border: 'none',
                    cursor: saving ? 'default' : 'pointer',
                    fontFamily: 'Hanken Grotesk, sans-serif', transition: 'background 150ms',
                  }}
                  onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  {saving === 'new' ? 'Saving…' : 'Save as New'}
                </button>
                <button
                  onClick={() => setSaveMenuOpen(o => !o)}
                  disabled={!!saving}
                  style={{
                    padding: '9px 10px',
                    background: saving ? '#c4b8f0' : '#5e4dbb', color: '#fff',
                    border: 'none', borderLeft: '1px solid rgba(255,255,255,0.25)',
                    cursor: saving ? 'default' : 'pointer',
                    transition: 'background 150ms',
                  }}
                  onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  <Icon name="expand_more" size={14} color="#fff" />
                </button>
              </div>

              {saveMenuOpen && (
                <div style={{
                  position: 'absolute', bottom: 44, left: 0, right: 0,
                  background: '#fff', borderRadius: 10,
                  border: '1px solid #e8e4f0',
                  boxShadow: '0 8px 24px rgba(94,77,187,0.12)',
                  overflow: 'hidden', zIndex: 10,
                }}>
                  {([
                    { mode: 'new' as const, label: 'Save as New Route', desc: 'Keep the original intact' },
                    { mode: 'replace' as const, label: 'Replace Original', desc: 'Overwrite the source file' },
                  ]).map(opt => (
                    <button
                      key={opt.mode}
                      onClick={() => { setSaveMenuOpen(false); handleSave(opt.mode); }}
                      style={{
                        width: '100%', padding: '10px 14px', textAlign: 'left',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        borderBottom: opt.mode === 'new' ? '1px solid #f0edf8' : 'none',
                        transition: 'background 150ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>{opt.label}</div>
                      <div style={{ fontSize: 10, color: '#b0acbe', marginTop: 1 }}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {saving === 'replace' && (
              <div style={{ textAlign: 'center', fontSize: 11, color: '#787584', marginTop: 6 }}>
                Replacing original…
              </div>
            )}
          </div>
        </div>

        {/* ── Map + Chart area ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Leaflet map — leaves 150px at bottom for chart */}
          <div
            ref={mapCallbackRef}
            style={{ position: 'absolute', inset: 0, bottom: 150 }}
          />

          {/* POI Category Toggle Buttons */}
          <div style={{
            position: 'absolute',
            top: 72, left: '50%', transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            gap: 6,
            background: 'rgba(255,255,255,0.88)',
            backdropFilter: 'blur(16px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.75)',
            borderRadius: 10,
            padding: '6px 8px',
            boxShadow: '0 4px 16px rgba(94,77,187,0.10)',
          }}>
            {(Object.entries(POI_CATEGORY_CONFIG) as Array<[PoiCategory, typeof POI_CATEGORY_CONFIG[PoiCategory]]>).map(([cat, cfg]) => {
              const active = activePoi.has(cat);
              return (
                <button
                  key={cat}
                  title={cfg.label}
                  onClick={() => setActivePoi(prev => {
                    const next = new Set(prev);
                    active ? next.delete(cat) : next.add(cat);
                    return next;
                  })}
                  style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: active ? cfg.bg : 'transparent',
                    border: active ? `1.5px solid ${cfg.borderColor}` : '1.5px solid transparent',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 150ms',
                    opacity: active ? 1 : 0.45,
                  }}
                >
                  {/* Material Symbol direkt im HTML — das funktioniert da Schriftart global geladen */}
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 16, color: active ? cfg.fg : '#787584', lineHeight: 1,
                      fontVariationSettings: "'FILL' 1, 'wght' 400" }}
                  >
                    {cfg.icon}
                  </span>
                </button>
              );
            })}

            {/* Loading-Indicator */}
            {poiLoading && (
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#5e4dbb', opacity: 0.7,
                alignSelf: 'center', marginLeft: 2,
                animation: 'pulse 1s ease-in-out infinite',
              }} />
            )}
          </div>

          {/* Zoom-Hinweis wenn Zoom zu niedrig */}
          {activePoi.size > 0 && leafletRef.current && leafletRef.current.getZoom() < 13 && (
            <div style={{
              position: 'absolute',
              top: 60, left: '50%', transform: 'translateX(-50%)',
              zIndex: 1000,
              background: 'rgba(255,255,255,0.88)',
              backdropFilter: 'blur(12px)',
              border: '1px solid #e8e4f0',
              borderRadius: 8, padding: '6px 14px',
              fontSize: 11, color: '#787584', fontFamily: 'Inter, sans-serif',
              whiteSpace: 'nowrap',
            }}>
              Weiter reinzoomen um POIs zu sehen
            </div>
          )}

          {/* Search Bar — floating, top-center */}
          <div style={{
            position: 'absolute',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1001,
            width: Math.min(360, window.innerWidth - 200),
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.95)',
              backdropFilter: 'blur(20px) saturate(180%)',
              border: `1px solid ${searchOpen ? '#c4b8f0' : 'rgba(255,255,255,0.75)'}`,
              borderRadius: 12,
              boxShadow: '0 4px 20px rgba(94,77,187,0.12)',
              transition: 'border-color 150ms',
              overflow: 'hidden',
            }}>
              {/* Input Row */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
                <Icon name={searchLoading ? 'progress_activity' : 'search'} size={16} color="#787584" />
                <input
                  value={searchQuery}
                  onChange={e => {
                    const q = e.target.value;
                    setSearchQuery(q);
                    handleSearchChange(q);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                  placeholder="Ort, Adresse oder 53.123, 10.456"
                  style={{
                    flex: 1, border: 'none', outline: 'none', background: 'transparent',
                    fontSize: 13, color: '#1c1b22', fontFamily: 'Inter, sans-serif',
                    padding: '10px 0',
                  }}
                />
                {searchQuery && (
                  <button
                    onMouseDown={e => { e.preventDefault(); setSearchQuery(''); setSearchResults([]); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    <Icon name="close" size={14} color="#b0acbe" />
                  </button>
                )}
              </div>

              {/* Results Dropdown */}
              {searchOpen && searchResults.length > 0 && (
                <div style={{ borderTop: '1px solid #e8e4f0', maxHeight: 240, overflowY: 'auto' }}>
                  {searchResults.map(r => (
                    <button
                      key={r.place_id}
                      onMouseDown={() => handleSearchSelectEdit(r)}
                      style={{
                        width: '100%', padding: '8px 14px', textAlign: 'left',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        borderBottom: '1px solid #f5f3ff', transition: 'background 100ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#faf9ff'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                        {r.display_name.split(',')[0]}
                      </div>
                      <div style={{ fontSize: 10, color: '#b0acbe', marginTop: 1 }}>
                        {r.display_name.split(',').slice(1, 3).join(',').trim()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Edit mode badge + zoom controls (top-right) */}
          <div style={{
            position: 'absolute', top: 14, right: 14, zIndex: 1000,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.75)', borderRadius: 10,
              padding: '7px 12px', fontSize: 11, color: '#5e4dbb', fontFamily: 'Inter, sans-serif',
              boxShadow: '0 2px 12px rgba(94,77,187,0.10)',
            }}>
              <span style={{ fontWeight: 600 }}>Edit Mode</span> — drag points to reshape
            </div>
            <button
              className="gps-map-ctrl"
              onClick={() => leafletRef.current?.zoomIn()}
              title="Zoom In"
              style={mapCtrlBtn}
            >
              <Icon name="add" size={16} color="#5e4dbb" />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={() => leafletRef.current?.zoomOut()}
              title="Zoom Out"
              style={mapCtrlBtn}
            >
              <Icon name="remove" size={16} color="#5e4dbb" />
            </button>

            {busy && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(255,255,255,0.75)', borderRadius: 10,
                padding: '6px 10px', fontSize: 11, color: '#5e4dbb', fontWeight: 600,
                boxShadow: '0 2px 12px rgba(94,77,187,0.10)', fontFamily: 'Inter, sans-serif',
              }}>
                <div style={{
                  width: 11, height: 11, borderRadius: '50%',
                  border: '2px solid rgba(94,77,187,0.25)', borderTopColor: '#5e4dbb',
                  animation: 'wpSpin 700ms linear infinite',
                }} />
                {busy}
              </div>
            )}
            {routingError && (
              <div style={{
                background: 'rgba(255,245,245,0.92)', backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid #fca5a5', borderRadius: 10,
                padding: '6px 10px', fontSize: 11, color: '#ba1a1a', fontWeight: 500,
                boxShadow: '0 2px 12px rgba(186,26,26,0.10)', fontFamily: 'Inter, sans-serif',
                maxWidth: 230, textAlign: 'right',
              }}>
                {routingError}
              </div>
            )}
          </div>

          {/* Waypoint popup — adapted from the route-planner card, Luminous List style */}
          {popupData && popupXY && (
            <div style={{
              position: 'absolute', left: popupXY.x, top: popupXY.y - 16, zIndex: 1100,
              transform: 'translate(-50%, -100%)', width: 272, boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.92)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.75)', borderRadius: 14,
              boxShadow: '0 8px 32px rgba(94,77,187,0.18), inset 0 1px 0 rgba(255,255,255,0.90)',
              padding: '12px 14px', fontFamily: 'Inter, sans-serif',
              animation: 'wpPopIn 180ms ease both',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>
                  {popupData.wp ? 'Waypoint' : 'Route Point'}
                </span>
                <button
                  onClick={() => setActiveSel(null)}
                  style={{
                    width: 24, height: 24, borderRadius: 7, border: 'none',
                    background: 'transparent', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f0edf8'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name="close" size={15} color="#787584" />
                </button>
              </div>

              {/* Coordinates + copy */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 11.5, color: '#787584' }}>
                  {popupData.point.lat.toFixed(6)}, {popupData.point.lon.toFixed(6)}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(`${popupData.point.lat.toFixed(6)}, ${popupData.point.lon.toFixed(6)}`).catch(() => {});
                    setCoordsCopied(true);
                    setTimeout(() => setCoordsCopied(false), 1500);
                  }}
                  title="Copy coordinates"
                  style={{
                    width: 22, height: 22, borderRadius: 6, border: 'none',
                    background: 'transparent', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f0edf8'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name={coordsCopied ? 'check' : 'content_copy'} size={13} color={coordsCopied ? '#22c55e' : '#787584'} />
                </button>
              </div>

              {/* Mode toggle — only for edited waypoints */}
              {popupData.wp && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                {([
                  { off: false, label: 'Follow ways', icon: 'alt_route' },
                  { off: true, label: 'Off-road', icon: 'do_not_step' },
                ]).map(opt => {
                  const active = popupData.wp!.offRoad === opt.off;
                  return (
                    <button
                      key={opt.label}
                      disabled={routingBusy || active}
                      onClick={() => toggleWaypointMode(popupData.wp!.id)}
                      style={{
                        padding: '7px 0', borderRadius: 8,
                        border: `1.5px solid ${active ? '#5e4dbb' : '#e8e4f0'}`,
                        background: active ? '#5e4dbb' : '#fff',
                        color: active ? '#fff' : '#787584',
                        fontSize: 11, fontWeight: 600,
                        cursor: routingBusy || active ? 'default' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        fontFamily: 'Hanken Grotesk, sans-serif', transition: 'all 150ms',
                        opacity: routingBusy && !active ? 0.55 : 1,
                      }}
                    >
                      <Icon name={opt.icon} size={13} color={active ? '#fff' : '#787584'} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              )}

              {/* Stats rows — label left, value right */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif', flexShrink: 0 }}>From start:</span>
                  <span style={{ fontSize: 12, color: '#484552', textAlign: 'right' }}>
                    {fmtDist(popupData.dist)}
                    {' '}
                    <span style={{ color: '#787584' }}>
                      ({popupData.durationS != null ? `${fmtDurationHM(popupData.durationS)}, ` : ''}↗ {Math.round(popupData.gain)} m)
                    </span>
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>Elevation:</span>
                  <span style={{ fontSize: 12, color: '#484552' }}>{Math.round(popupData.point.ele)} m</span>
                </div>
                {popupData.grade != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>Grade:</span>
                    <span style={{ fontSize: 12, color: '#484552', display: 'flex', alignItems: 'center', gap: 6 }}>
                      ~ {Math.round(popupData.grade)} %
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: gradeColor(popupData.grade), display: 'inline-block' }} />
                    </span>
                  </div>
                )}
              </div>

              {/* Delete point */}
              <button
                onClick={deleteActivePoint}
                disabled={routingBusy}
                style={{
                  width: '100%', marginTop: 10, padding: '7px 0', borderRadius: 8,
                  border: '1px solid #fca5a5', background: '#fff', color: '#ba1a1a',
                  fontSize: 11.5, fontWeight: 600,
                  cursor: routingBusy ? 'default' : 'pointer',
                  fontFamily: 'Hanken Grotesk, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  transition: 'background 150ms', opacity: routingBusy ? 0.55 : 1,
                }}
                onMouseEnter={e => { if (!routingBusy) e.currentTarget.style.background = '#fff5f5'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
              >
                <Icon name="delete" size={13} color="#ba1a1a" />
                Delete point
              </button>

              {/* Pointer */}
              <div style={{
                position: 'absolute', bottom: -6, left: '50%',
                width: 12, height: 12, background: 'rgba(255,255,255,0.92)',
                borderRight: '1px solid rgba(255,255,255,0.75)',
                borderBottom: '1px solid rgba(255,255,255,0.75)',
                transform: 'translateX(-50%) rotate(45deg)',
              }} />
            </div>
          )}

          {addPinDialog && (
            <div style={{
              position: 'absolute',
              // Mittig über der Karte positioniert
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1200,
              width: 300,
              background: 'rgba(255,255,255,0.97)',
              backdropFilter: 'blur(20px)',
              border: '1px solid #e8e4f0',
              borderRadius: 14,
              padding: 20,
              boxShadow: '0 8px 32px rgba(94,77,187,0.18)',
              fontFamily: 'Inter, sans-serif',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {addPinDialog.poi && (
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 18, color: POI_CATEGORY_CONFIG[addPinDialog.suggestedSym as PoiCategory]?.fg ?? '#5e4dbb',
                        fontVariationSettings: "'FILL' 1,'wght' 400" }}
                    >
                      {POI_CATEGORY_CONFIG[addPinDialog.suggestedSym as PoiCategory]?.icon ?? 'push_pin'}
                    </span>
                  )}
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    Wegpunkt hinzufügen
                  </span>
                </div>
                <button
                  onClick={() => setAddPinDialog(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  <Icon name="close" size={16} color="#b0acbe" />
                </button>
              </div>

              {/* POI-Infos wenn von POI-Klick */}
              {addPinDialog.poi && (() => {
                const tags = addPinDialog.poi!.tags;
                const addr = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
                const hours = tags['opening_hours'];
                return (
                  <div style={{ background: '#f8f7ff', borderRadius: 8, padding: '8px 10px', marginBottom: 12, fontSize: 11, color: '#787584' }}>
                    {addr && <div>📍 {addr}</div>}
                    {hours && <div>🕐 {hours}</div>}
                  </div>
                );
              })()}

              {/* Name Input */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#484552', marginBottom: 5 }}>Name</div>
                <input
                  autoFocus
                  value={addPinName}
                  onChange={e => setAddPinName(e.target.value)}
                  placeholder="Wegpunkt benennen..."
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '7px 10px', borderRadius: 8,
                    border: '1px solid #e8e4f0', fontSize: 13,
                    fontFamily: 'Inter, sans-serif', color: '#1c1b22',
                    outline: 'none', background: '#faf9ff',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = '#e8e4f0'; }}
                />
              </div>

              {/* Mode Auswahl */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#484552', marginBottom: 6 }}>Typ</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {([
                    { mode: 'pin', icon: 'push_pin', label: 'Informativer Pin', desc: 'Erscheint im GPX als POI, ändert die Route nicht' },
                    { mode: 'route', icon: 'route', label: 'Route-Stop', desc: 'Route fährt durch diesen Punkt' },
                  ] as const).map(opt => (
                    <button
                      key={opt.mode}
                      onClick={() => setAddPinMode(opt.mode)}
                      style={{
                        padding: '10px 8px', borderRadius: 9, cursor: 'pointer', textAlign: 'left',
                        border: `2px solid ${addPinMode === opt.mode ? '#5e4dbb' : '#e8e4f0'}`,
                        background: addPinMode === opt.mode ? '#F5F3FF' : '#fff',
                        transition: 'all 150ms',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                        <Icon name={opt.icon} size={13} color={addPinMode === opt.mode ? '#5e4dbb' : '#b0acbe'} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: addPinMode === opt.mode ? '#5e4dbb' : '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                          {opt.label}
                        </span>
                      </div>
                      <div style={{ fontSize: 9.5, color: '#b0acbe', lineHeight: 1.4 }}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setAddPinDialog(null)}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid #e8e4f0', background: '#fff', color: '#484552', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif' }}
                >
                  Abbrechen
                </button>
                <button
                  onClick={() => handleAddPin()}
                  style={{ flex: 2, padding: '8px 0', borderRadius: 8, border: 'none', background: '#5e4dbb', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif' }}
                >
                  Hinzufügen
                </button>
              </div>
            </div>
          )}

          {/* Map click popup — place name, elevation, add-to-route */}
          {mapClick && mapClickXY && (
            <div style={{
              position: 'absolute', left: mapClickXY.x, top: mapClickXY.y - 16, zIndex: 1100,
              transform: 'translate(-50%, -100%)', width: 272, boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.92)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.75)', borderRadius: 14,
              boxShadow: '0 8px 32px rgba(94,77,187,0.18), inset 0 1px 0 rgba(255,255,255,0.90)',
              padding: '12px 14px', fontFamily: 'Inter, sans-serif',
              animation: 'wpPopIn 180ms ease both',
            }}>
              {/* Header — place name from reverse geocoding */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <span style={{
                  fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700,
                  color: mapClick.loading ? '#b0acbe' : '#1c1b22', lineHeight: 1.3,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {mapClick.loading ? 'Looking up place…' : mapClick.name ?? 'Dropped pin'}
                </span>
                <button
                  onClick={() => setMapClick(null)}
                  style={{
                    width: 24, height: 24, borderRadius: 7, border: 'none',
                    background: 'transparent', cursor: 'pointer', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f0edf8'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name="close" size={15} color="#787584" />
                </button>
              </div>

              {/* Coordinates + copy */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 11.5, color: '#787584' }}>
                  {mapClick.lat.toFixed(6)}, {mapClick.lon.toFixed(6)}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(`${mapClick.lat.toFixed(6)}, ${mapClick.lon.toFixed(6)}`).catch(() => {});
                    setCoordsCopied(true);
                    setTimeout(() => setCoordsCopied(false), 1500);
                  }}
                  title="Copy coordinates"
                  style={{
                    width: 22, height: 22, borderRadius: 6, border: 'none',
                    background: 'transparent', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f0edf8'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name={coordsCopied ? 'check' : 'content_copy'} size={13} color={coordsCopied ? '#22c55e' : '#787584'} />
                </button>
              </div>

              {/* Elevation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>Elevation:</span>
                <span style={{ fontSize: 12, color: '#484552' }}>
                  {mapClick.ele != null ? `${Math.round(mapClick.ele)} m` : mapClick.loading ? '…' : '—'}
                </span>
              </div>

              {/* Add to route */}
              <button
                onClick={addClickedPointToRoute}
                disabled={routingBusy}
                style={{
                  width: '100%', padding: '8px 0', borderRadius: 9, border: 'none',
                  background: routingBusy ? '#c4b8f0' : '#5e4dbb', color: '#fff',
                  fontSize: 12, fontWeight: 600, cursor: routingBusy ? 'default' : 'pointer',
                  fontFamily: 'Hanken Grotesk, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  transition: 'background 150ms',
                }}
                onMouseEnter={e => { if (!routingBusy) e.currentTarget.style.background = '#4d3da8'; }}
                onMouseLeave={e => { if (!routingBusy) e.currentTarget.style.background = '#5e4dbb'; }}
              >
                <Icon name="add_location_alt" size={14} color="#fff" />
                Add to route
              </button>
              <div style={{ fontSize: 10, color: '#b0acbe', marginTop: 6, textAlign: 'center' }}>
                {snapEnabled ? 'Replans the nearest leg through this point — old sub-points replaced' : 'Connects with straight lines (snap off)'}
              </div>

              {/* Pointer */}
              <div style={{
                position: 'absolute', bottom: -6, left: '50%',
                width: 12, height: 12, background: 'rgba(255,255,255,0.92)',
                borderRight: '1px solid rgba(255,255,255,0.75)',
                borderBottom: '1px solid rgba(255,255,255,0.75)',
                transform: 'translateX(-50%) rotate(45deg)',
              }} />
            </div>
          )}

          {/* Elevation chart with trim handles */}
          {editPoints && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: 150, zIndex: 1000,
              background: 'rgba(255,255,255,0.88)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              borderTop: '1px solid rgba(255,255,255,0.68)',
              boxShadow: '0 -4px 24px rgba(94,77,187,0.08)',
            }}>
              <EditElevationChart
                points={editPoints}
                trimStart={trimStart}
                trimEnd={trimEnd}
                hoveredIdx={hoveredIdx}
                onHover={setHoveredIdx}
                onTrimStartChange={(idx) => {
                  setTrimStart(idx);
                  trimStartRef.current = idx;
                  if (editPointsRef.current) {
                    updateTrimPolys(editPointsRef.current, idx, trimEndRef.current);
                    startMarkerRef.current?.setLatLng([editPointsRef.current[idx].lat, editPointsRef.current[idx].lon]);
                  }
                }}
                onTrimEndChange={(idx) => {
                  setTrimEnd(idx);
                  trimEndRef.current = idx;
                  if (editPointsRef.current) {
                    updateTrimPolys(editPointsRef.current, trimStartRef.current, idx);
                    endMarkerRef.current?.setLatLng([editPointsRef.current[idx].lat, editPointsRef.current[idx].lon]);
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
