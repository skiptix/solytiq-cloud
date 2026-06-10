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

function findNearestPoint(pts: GpsTrackPoint[], lat: number, lon: number): number {
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
  const [history, setHistory] = useState<GpsTrackPoint[][]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState<'new' | 'replace' | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Refs — used in Leaflet event handlers to avoid stale closures
  const editPointsRef = useRef<GpsTrackPoint[] | null>(null);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const historyArrRef = useRef<GpsTrackPoint[][]>([]);
  const historyIdxRef = useRef(-1);

  // Leaflet refs
  const leafletRef = useRef<L.Map | null>(null);
  const editPolylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.Marker | null>(null);
  const endMarkerRef = useRef<L.Marker | null>(null);
  const trimPolyBeforeRef = useRef<L.Polyline | null>(null);
  const trimPolyAfterRef = useRef<L.Polyline | null>(null);

  // Keep refs in sync with state
  useEffect(() => { editPointsRef.current = editPoints; }, [editPoints]);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current = trimEnd; }, [trimEnd]);
  useEffect(() => { historyArrRef.current = history; }, [history]);
  useEffect(() => { historyIdxRef.current = historyIdx; }, [historyIdx]);

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
        setHistory([simplified]);
        setHistoryIdx(0);
        historyArrRef.current = [simplified];
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = L.map(node, { editable: true as any, zoomControl: false }).setView([47, 10], 5);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      leafletRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
      const ro = new ResizeObserver(() => leafletRef.current?.invalidateSize());
      ro.observe(node);
    }
  }, []);

  // ── Build/rebuild map layers from points ─────────────────────────────────
  const rebuildMap = useCallback((pts: GpsTrackPoint[], ts: number, te: number) => {
    const map = leafletRef.current;
    if (!map || pts.length === 0) return;

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

    // Vertex drag end — push history snapshot
    map.on('editable:vertex:dragend', () => {
      pushHistoryRef.current?.(editPointsRef.current!);
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
      pushHistoryRef.current?.(newPts);
      // Rebuild trim visualization (not full rebuild)
      updateTrimPolysRef.current?.(newPts, trimStartRef.current, newTe);
    };

    map.on('editable:vertex:deleted', syncAfterChange);
    map.on('editable:vertex:new', syncAfterChange);

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
      rebuildMapRef.current?.(editPointsRef.current!, clamped, trimEndRef.current);
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
      rebuildMapRef.current?.(editPointsRef.current!, trimStartRef.current, clamped);
    });
    endMarkerRef.current = eMkr;

    map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon] as L.LatLngTuple)), { padding: [40, 40], maxZoom: 16 });
    setTimeout(() => map.invalidateSize(), 80);
  }, []);

  // Keep refs to functions to avoid stale closures in Leaflet handlers
  const rebuildMapRef = useRef(rebuildMap);
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { rebuildMapRef.current = rebuildMap; }, [rebuildMap]);

  const updateTrimPolysRef = useRef<((pts: GpsTrackPoint[], ts: number, te: number) => void) | null>(null);
  const pushHistoryRef = useRef<((pts: GpsTrackPoint[]) => void) | null>(null);

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
  const pushHistory = useCallback((pts: GpsTrackPoint[]) => {
    setHistory(prev => {
      const truncated = prev.slice(0, historyIdxRef.current + 1);
      const next = [...truncated, pts];
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

  function undo() {
    if (historyIdxRef.current <= 0) return;
    const newIdx = historyIdxRef.current - 1;
    const pts = historyArrRef.current[newIdx];
    historyIdxRef.current = newIdx;
    setHistoryIdx(newIdx);
    setEditPoints(pts);
    editPointsRef.current = pts;
    const te = Math.min(trimEndRef.current, pts.length - 1);
    setTrimEnd(te);
    trimEndRef.current = te;
    rebuildMap(pts, trimStartRef.current, te);
  }

  function redo() {
    if (historyIdxRef.current >= historyArrRef.current.length - 1) return;
    const newIdx = historyIdxRef.current + 1;
    const pts = historyArrRef.current[newIdx];
    historyIdxRef.current = newIdx;
    setHistoryIdx(newIdx);
    setEditPoints(pts);
    editPointsRef.current = pts;
    rebuildMap(pts, trimStartRef.current, trimEndRef.current);
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
        .leaflet-bottom.leaflet-right { bottom: 158px !important; }
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
                setHistory([originalPoints]);
                setHistoryIdx(0);
                historyArrRef.current = [originalPoints];
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
                • Drag any point on the route to move it<br />
                • Click midpoint dots to add a new point<br />
                • Click a vertex + Delete key to remove it<br />
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

          {/* Edit mode badge */}
          <div style={{
            position: 'absolute', top: 14, right: 14, zIndex: 1000,
            background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.75)', borderRadius: 10,
            padding: '7px 12px', fontSize: 11, color: '#5e4dbb', fontFamily: 'Inter, sans-serif',
            boxShadow: '0 2px 12px rgba(94,77,187,0.10)',
          }}>
            <span style={{ fontWeight: 600 }}>Edit Mode</span> — drag points to reshape
          </div>

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
