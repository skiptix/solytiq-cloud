import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import 'leaflet-editable';
import L from 'leaflet';
import type { GpsFile, GpsTrackPoint } from '../types';
import { apiGetGpsFiles, apiGetGpsTrackData, apiSaveEditedGpsTrack } from '../api/client';
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

// ─── Snap-to-ways routing (FOSSGIS OSRM, free, no API key) ───────────────────
type RoutingProfile = 'bike' | 'foot' | 'car';

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
}

interface OsrmResponse {
  code: string;
  routes?: Array<{ geometry: { coordinates: [number, number][] } }>;
  waypoints?: Array<{ location: [number, number] }>;
}

async function fetchRoutedPath(
  coords: Array<{ lat: number; lon: number }>,
  profile: RoutingProfile,
): Promise<{ points: Array<{ lat: number; lon: number }>; snapped: Array<{ lat: number; lon: number }> } | null> {
  const pairStr = coords.map(p => `${p.lon},${p.lat}`).join(';');
  const url = `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${pairStr}?overview=full&geometries=geojson&steps=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as OsrmResponse;
    if (data.code !== 'Ok' || !data.routes?.[0]) return null;
    return {
      points: data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
      snapped: (data.waypoints ?? []).map(w => ({ lat: w.location[1], lon: w.location[0] })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function simplifyLeg(line: Array<{ lat: number; lon: number }>): Array<{ lat: number; lon: number }> {
  if (line.length <= 3) return line;
  return rdp(line.map(p => ({ lat: p.lat, lon: p.lon, ele: 0 })), 0.00005);
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

// Build the replacement span [anchorPrev?, …leg1, wp, …leg2, anchorNext?] from routed geometry
function buildRoutedSpan(
  anchorPrev: GpsTrackPoint | null,
  anchorNext: GpsTrackPoint | null,
  wpEle: number,
  routedPts: Array<{ lat: number; lon: number }>,
  via: { lat: number; lon: number },
): { span: GpsTrackPoint[]; wpPoint: GpsTrackPoint } {
  const wpPoint: GpsTrackPoint = { lat: via.lat, lon: via.lon, ele: wpEle };
  if (anchorPrev && anchorNext) {
    let splitIdx = findNearestPoint(routedPts, via.lat, via.lon);
    splitIdx = Math.max(1, Math.min(routedPts.length - 2, splitIdx));
    const leg1 = interpolateEle(simplifyLeg(routedPts.slice(0, splitIdx + 1)), anchorPrev.ele, wpEle).slice(1, -1);
    const leg2 = interpolateEle(simplifyLeg(routedPts.slice(splitIdx)), wpEle, anchorNext.ele).slice(1, -1);
    return { span: [anchorPrev, ...leg1, wpPoint, ...leg2, anchorNext], wpPoint };
  }
  if (anchorPrev) {
    const leg = interpolateEle(simplifyLeg(routedPts), anchorPrev.ele, wpEle).slice(1, -1);
    return { span: [anchorPrev, ...leg, wpPoint], wpPoint };
  }
  const leg = interpolateEle(simplifyLeg(routedPts), wpEle, anchorNext!.ele).slice(1, -1);
  return { span: [wpPoint, ...leg, anchorNext!], wpPoint };
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

  // Snap-to-ways routing + edited waypoints
  const [waypoints, setWaypoints] = useState<EditWaypoint[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapProfile, setSnapProfile] = useState<RoutingProfile>('bike');
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [activeWpId, setActiveWpId] = useState<string | null>(null);
  const [popupXY, setPopupXY] = useState<{ x: number; y: number } | null>(null);
  const [coordsCopied, setCoordsCopied] = useState(false);

  // Refs — used in Leaflet event handlers to avoid stale closures
  const editPointsRef = useRef<GpsTrackPoint[] | null>(null);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const historyArrRef = useRef<HistoryEntry[]>([]);
  const historyIdxRef = useRef(-1);
  const waypointsRef = useRef<EditWaypoint[]>([]);
  const snapEnabledRef = useRef(true);
  const snapProfileRef = useRef<RoutingProfile>('bike');
  const dragWpIdRef = useRef<string | null>(null);
  const routingErrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leaflet refs
  const leafletRef = useRef<L.Map | null>(null);
  const editPolylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.Marker | null>(null);
  const endMarkerRef = useRef<L.Marker | null>(null);
  const trimPolyBeforeRef = useRef<L.Polyline | null>(null);
  const trimPolyAfterRef = useRef<L.Polyline | null>(null);
  const waypointMarkersRef = useRef<L.Marker[]>([]);
  const pendingFitRef = useRef<L.LatLngBounds | null>(null);

  // Keep refs in sync with state
  useEffect(() => { editPointsRef.current = editPoints; }, [editPoints]);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current = trimEnd; }, [trimEnd]);
  useEffect(() => { historyArrRef.current = history; }, [history]);
  useEffect(() => { historyIdxRef.current = historyIdx; }, [historyIdx]);
  useEffect(() => { waypointsRef.current = waypoints; }, [waypoints]);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { snapProfileRef.current = snapProfile; }, [snapProfile]);

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
      map.on('click', () => setActiveWpId(null));
      leafletRef.current = map;
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

    // Remember whether the grabbed vertex is an existing edited waypoint
    map.on('editable:vertex:dragstart', (e) => {
      const ll = (e as EditableVertexEvent).vertex.getLatLng();
      dragWpIdRef.current = waypointsRef.current.find(w => w.lat === ll.lat && w.lon === ll.lng)?.id ?? null;
    });

    // Vertex drag — update state on each move for live stats
    map.on('editable:vertex:drag', () => {
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
    });

    // Vertex drag end — snap to ways / register waypoint / push history
    map.on('editable:vertex:dragend', (e) => {
      handleVertexDragEndRef.current?.((e as EditableVertexEvent).vertex.getIndex());
    });

    // Vertex add/delete — sync editPoints with new poly state
    const syncAfterChange = () => {
      const lls = poly.getLatLngs() as L.LatLng[];
      const prevActive = editPointsRef.current!.slice(trimStartRef.current, trimEndRef.current + 1);
      const newActive: GpsTrackPoint[] = lls.map((ll, i) => ({
        ...(prevActive[i] ?? prevActive[prevActive.length - 1] ?? { lat: ll.lat, lon: ll.lng, ele: 0 }),
        lat: ll.lat,
        lon: ll.lng,
      }));
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

    // Re-dragging an existing waypoint re-routes its whole leg (anchor to anchor);
    // a fresh drag connects through the immediate neighbours
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
      const newWps = [...waypointsRef.current.filter(w => w.id !== wpId), wp];
      editPointsRef.current = newPts;
      trimEndRef.current = newTe;
      waypointsRef.current = newWps;
      setEditPoints(newPts);
      setTrimEnd(newTe);
      setWaypoints(newWps);
      pushHistoryRef.current?.(newPts, newWps);
      rebuildMapRef.current?.(newPts, ts, newTe, { fit: false });
    };

    const finishStraight = () => {
      const span = [
        ...(anchorPrev ? [anchorPrev] : []),
        dragged,
        ...(anchorNext ? [anchorNext] : []),
      ];
      finish([...pts.slice(0, spanStart), ...span, ...pts.slice(spanEnd + 1)], dragged);
    };

    if (offRoad || (!anchorPrev && !anchorNext)) {
      finishStraight();
      return;
    }

    const straightDist =
      (anchorPrev ? haversineClient(anchorPrev.lat, anchorPrev.lon, dragged.lat, dragged.lon) : 0) +
      (anchorNext ? haversineClient(dragged.lat, dragged.lon, anchorNext.lat, anchorNext.lon) : 0);
    if (straightDist > 50000) {
      flashRoutingError('Segment too long to snap — kept straight line');
      finishStraight();
      return;
    }

    setRoutingBusy(true);
    const coords = [anchorPrev, dragged, anchorNext].filter((p): p is GpsTrackPoint => !!p);
    const routed = await fetchRoutedPath(coords, snapProfileRef.current);
    setRoutingBusy(false);

    // Track changed while routing was in flight — discard to avoid corrupting state
    if (editPointsRef.current !== pts) return;

    if (!routed || routed.points.length < 2) {
      flashRoutingError('Routing unavailable — kept straight line');
      finishStraight();
      return;
    }

    const wpPos = anchorPrev ? 1 : 0;
    const via = routed.snapped[wpPos] ?? { lat: dragged.lat, lon: dragged.lon };
    const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, dragged.ele, routed.points, via);
    finish([...pts.slice(0, spanStart), ...span, ...pts.slice(spanEnd + 1)], wpPoint);
  }, [flashRoutingError]);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { handleVertexDragEndRef.current = handleVertexDragEnd; }, [handleVertexDragEnd]);

  // ── Waypoint popup ────────────────────────────────────────────────────────
  const openWpPopup = useCallback((wpId: string) => {
    const map = leafletRef.current;
    const wp = waypointsRef.current.find(w => w.id === wpId);
    if (!map || !wp) return;
    const pt = map.latLngToContainerPoint([wp.lat, wp.lon]);
    setPopupXY({ x: pt.x, y: pt.y });
    setCoordsCopied(false);
    setActiveWpId(wpId);
  }, []);

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { openWpPopupRef.current = openWpPopup; }, [openWpPopup]);

  // Keep the popup glued to its waypoint while panning/zooming
  useEffect(() => {
    const map = leafletRef.current;
    if (!map || !activeWpId) return;
    const update = () => {
      const wp = waypointsRef.current.find(w => w.id === activeWpId);
      if (!wp) return;
      const pt = map.latLngToContainerPoint([wp.lat, wp.lon]);
      setPopupXY({ x: pt.x, y: pt.y });
    };
    map.on('move', update);
    map.on('zoomend', update);
    return () => {
      map.off('move', update);
      map.off('zoomend', update);
    };
  }, [activeWpId]);

  const popupData = useMemo(() => {
    if (!activeWpId || !editPoints) return null;
    const wp = waypoints.find(w => w.id === activeWpId);
    if (!wp) return null;
    const idx = findNearestPoint(editPoints, wp.lat, wp.lon);
    const p = editPoints[idx];
    if (!p || p.lat !== wp.lat || p.lon !== wp.lon) return null;
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
  }, [activeWpId, editPoints, waypoints, trimStart]);

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

    setRoutingBusy(true);
    const coords = [anchorPrev, wpPt, anchorNext].filter((p): p is GpsTrackPoint => !!p);
    const routed = await fetchRoutedPath(coords, snapProfileRef.current);
    setRoutingBusy(false);
    if (editPointsRef.current !== pts) return;
    if (!routed || routed.points.length < 2) {
      flashRoutingError('Routing unavailable — waypoint kept off-road');
      return;
    }
    const wpPos = anchorPrev ? 1 : 0;
    const via = routed.snapped[wpPos] ?? { lat: wpPt.lat, lon: wpPt.lon };
    const { span, wpPoint } = buildRoutedSpan(anchorPrev, anchorNext, wpPt.ele, routed.points, via);
    apply([...pts.slice(0, spanStart), ...span, ...pts.slice(spanEnd + 1)], wpPoint);
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 8 }}>
                {([
                  { value: 'bike' as const, label: 'Bike', icon: 'directions_bike' },
                  { value: 'foot' as const, label: 'Foot', icon: 'directions_walk' },
                  { value: 'car' as const, label: 'Car', icon: 'directions_car' },
                ]).map(opt => {
                  const active = snapProfile === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setSnapProfile(opt.value)}
                      style={{
                        padding: '6px 0', borderRadius: 8, cursor: 'pointer',
                        border: `1.5px solid ${active ? '#5e4dbb' : '#e8e4f0'}`,
                        background: active ? '#f5f3ff' : '#fff',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                        transition: 'all 150ms',
                      }}
                    >
                      <Icon name={opt.icon} size={14} color={active ? '#5e4dbb' : '#b0acbe'} />
                      <span style={{ fontSize: 10, fontWeight: 600, color: active ? '#5e4dbb' : '#787584', fontFamily: 'Hanken Grotesk, sans-serif' }}>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 10.5, color: '#b0acbe', marginTop: 8, lineHeight: 1.5 }}>
              Dragged points connect along mapped ways. Click a waypoint dot on the map to switch it to off-road.
            </div>
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
                setActiveWpId(null);
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
                • Click midpoint dots to add a new point<br />
                • Click a waypoint dot for details &amp; off-road<br />
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

            {routingBusy && (
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
                Routing…
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
                  Waypoint
                </span>
                <button
                  onClick={() => setActiveWpId(null)}
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
                  {popupData.wp.lat.toFixed(6)}, {popupData.wp.lon.toFixed(6)}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(`${popupData.wp.lat.toFixed(6)}, ${popupData.wp.lon.toFixed(6)}`).catch(() => {});
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

              {/* Mode toggle */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                {([
                  { off: false, label: 'Follow ways', icon: 'alt_route' },
                  { off: true, label: 'Off-road', icon: 'do_not_step' },
                ]).map(opt => {
                  const active = popupData.wp.offRoad === opt.off;
                  return (
                    <button
                      key={opt.label}
                      disabled={routingBusy || active}
                      onClick={() => toggleWaypointMode(popupData.wp.id)}
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
