import { usePageTitle } from "../hooks/usePageTitle";
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import type { GpsTrackData, GpsMetricPoint, PoiCategory, NominatimResult } from '../types';
import {
  apiGetGpsFiles, apiUploadGpsFile, apiGetGpsTrackData,
  apiDownloadGpsFile, apiDeleteGpsFile, apiSmoothAndSaveGpsFile, apiCreateNewGpsRoute,
  apiGetGpsPois,
} from '../api/client';
import useGpsStore from '../store/useGpsStore';
import Icon from '../components/Icon';
import GPSMergeWizard from '../components/GPSMergeWizard';
import { searchNominatim, parseCoordInput } from '../utils/nominatim';
import { POI_CATEGORY_CONFIG, createPoiDivIcon, createPinDivIcon } from '../utils/poiCategories';
import { diffPoiMarkers } from '../utils/routeState';
import { buildPoiPopupElement, buildSafeTooltipElement } from '../utils/poiPopup';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDist(m?: number | null) {
  if (m == null) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}
function fmtElev(m?: number | null) {
  if (m == null) return '—';
  return `${Math.round(m)} m`;
}
function fmtDuration(s?: number | null) {
  if (s == null) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── MultiLineMapChart ────────────────────────────────────────────────────────
interface MultiLineMapChartProps {
  trackData: GpsTrackData;
  hoveredIdx: number | null;
  onHover: (idx: number | null) => void;
}

function MultiLineMapChart({ trackData, hoveredIdx, onHover }: MultiLineMapChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 150 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const e = entries[0].contentRect;
      setDims({ w: Math.max(100, e.width), h: Math.max(50, e.height) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const PAD = { l: 8, r: 8, t: 28, b: 22 };
  const cw = dims.w - PAD.l - PAD.r;
  const ch = dims.h - PAD.t - PAD.b;

  const elevProf = trackData.elevationProfile;
  const maxDist = elevProf.length > 0 ? elevProf[elevProf.length - 1].distance : 1;
  const toX = (dist: number) => PAD.l + (dist / maxDist) * cw;

  const metrics: Array<{ key: string; color: string; label: string; unit: string; values: (number | null)[] }> = [];
  const elevVals = elevProf.map(p => p.elevation);
  const elevMin = Math.min(...elevVals);
  const elevMax = Math.max(...elevVals);
  metrics.push({ key: 'elevation', color: 'var(--color-primary)', label: 'Elevation', unit: 'm', values: elevVals });

  if (trackData.metricsAvailable.hr && trackData.hrProfile) {
    metrics.push({ key: 'hr', color: 'var(--color-red-mid-2)', label: 'HR', unit: 'bpm', values: trackData.hrProfile.map((p: GpsMetricPoint) => p.value) });
  }
  if (trackData.metricsAvailable.cadence && trackData.cadenceProfile) {
    metrics.push({ key: 'cadence', color: 'var(--color-success)', label: 'Cadence', unit: 'rpm', values: trackData.cadenceProfile.map((p: GpsMetricPoint) => p.value) });
  }
  if (trackData.metricsAvailable.power && trackData.powerProfile) {
    metrics.push({ key: 'power', color: 'var(--color-warning-alt)', label: 'Power', unit: 'W', values: trackData.powerProfile.map((p: GpsMetricPoint) => p.value) });
  }

  const normalizedMetrics = metrics.map(m => {
    const validVals = m.values.filter((v): v is number => v != null);
    const min = validVals.length > 0 ? Math.min(...validVals) : 0;
    const max = validVals.length > 0 ? Math.max(...validVals) : 1;
    const range = max - min || 1;
    return { ...m, min, max, range, normalized: m.values.map(v => v != null ? (v - min) / range : null) };
  });

  const toY = (norm: number | null) => norm == null ? null : PAD.t + (1 - norm) * ch;

  const paths = normalizedMetrics.map(m => {
    let d = '';
    let first = true;
    m.normalized.forEach((norm, i) => {
      const y = toY(norm);
      if (y == null) return;
      const x = toX(elevProf[i]?.distance ?? 0);
      d += first ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
      first = false;
    });
    return { ...m, pathD: d };
  });

  const elevMetric = normalizedMetrics[0];
  const areaD = elevMetric && elevProf.length > 0 ? (() => {
    const firstX = toX(elevProf[0].distance);
    const lastX = toX(elevProf[elevProf.length - 1].distance);
    const bottom = PAD.t + ch;
    let d = `M${firstX.toFixed(1)},${bottom.toFixed(1)}`;
    elevMetric.normalized.forEach((norm, i) => {
      const y = toY(norm);
      if (y == null) return;
      const x = toX(elevProf[i].distance);
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    });
    d += `L${lastX.toFixed(1)},${bottom.toFixed(1)}Z`;
    return d;
  })() : '';

  const hovX = hoveredIdx != null ? toX(elevProf[hoveredIdx]?.distance ?? 0) : null;

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || elevProf.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, (px - PAD.l) / Math.max(1, rect.width - PAD.l - PAD.r)));
    const targetDist = fraction * maxDist;
    let nearest = 0, minDiff = Infinity;
    for (let i = 0; i < elevProf.length; i++) {
      const diff = Math.abs(elevProf[i].distance - targetDist);
      if (diff < minDiff) { minDiff = diff; nearest = i; }
    }
    onHover(nearest);
  }, [elevProf, maxDist, PAD.l, PAD.r, onHover]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 6, left: PAD.l, right: PAD.r, display: 'flex', gap: 12, zIndex: 2, pointerEvents: 'none' }}>
        {metrics.map(m => (
          <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 3, borderRadius: 2, background: m.color }} />
            <span style={{ fontSize: 10, color: 'var(--color-primary)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>{m.label}</span>
          </div>
        ))}
      </div>
      <svg ref={svgRef} width={dims.w} height={dims.h} style={{ display: 'block', cursor: 'crosshair' }} onMouseMove={handleMouseMove} onMouseLeave={() => onHover(null)}>
        <defs>
          <linearGradient id="gps-elev-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map(frac => {
          const y = PAD.t + (1 - frac) * ch;
          return <line key={frac} x1={PAD.l} y1={y} x2={PAD.l + cw} y2={y} stroke="rgba(var(--color-primary-rgb), 0.10)" strokeWidth={0.8} />;
        })}
        {Array.from({ length: 6 }, (_, i) => {
          const dist = (i / 5) * maxDist;
          const x = toX(dist);
          return (
            <text key={i} x={x} y={dims.h - 5} textAnchor="middle" style={{ fontSize: 9, fill: 'rgba(var(--color-purple-deep-1-rgb), 0.55)', fontFamily: 'var(--font-body)' }}>
              {dist >= 1000 ? `${(dist / 1000).toFixed(1)}k` : Math.round(dist)}m
            </text>
          );
        })}
        {areaD && <path d={areaD} fill="url(#gps-elev-grad)" />}
        {paths.map(p => p.pathD ? <path key={p.key} d={p.pathD} fill="none" stroke={p.color} strokeWidth={p.key === 'elevation' ? 2 : 1.5} opacity={0.9} /> : null)}
        {hovX != null && <line x1={hovX} y1={PAD.t} x2={hovX} y2={PAD.t + ch} stroke="rgba(var(--color-primary-rgb), 0.45)" strokeWidth={1.5} strokeDasharray="4,3" />}
        {hovX != null && hoveredIdx != null && normalizedMetrics.map(m => {
          const norm = m.normalized[hoveredIdx];
          const y = toY(norm);
          if (y == null) return null;
          return <circle key={m.key} cx={hovX} cy={y} r={4} fill={m.color} stroke="rgba(var(--color-white-rgb), 0.90)" strokeWidth={2} />;
        })}
      </svg>
      {hovX != null && hoveredIdx != null && (
        <div style={{
          position: 'absolute', top: PAD.t, left: Math.min(hovX + 10, dims.w - 140),
          background: 'rgba(var(--color-white-rgb), 0.75)', backdropFilter: 'blur(16px) saturate(160%)',
          WebkitBackdropFilter: 'blur(16px) saturate(160%)', border: '1px solid rgba(var(--color-white-rgb), 0.70)',
          borderRadius: 10, padding: '6px 10px', pointerEvents: 'none', zIndex: 10,
          fontFamily: 'var(--font-body)', fontSize: 11, minWidth: 110,
          boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.12), inset 0 1px 0 rgba(var(--color-white-rgb), 0.90)',
        }}>
          <div style={{ color: 'rgba(var(--color-purple-deep-1-rgb), 0.65)', marginBottom: 4, fontSize: 10 }}>{fmtDist(elevProf[hoveredIdx]?.distance)}</div>
          {normalizedMetrics.map(m => {
            const val = m.values[hoveredIdx];
            if (val == null) return null;
            return (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                <span style={{ color: m.color, fontWeight: 600 }}>{Math.round(val)} {m.unit}</span>
              </div>
            );
          })}
          {elevVals.length > 0 && (
            <div style={{ color: 'rgba(var(--color-purple-deep-1-rgb), 0.50)', fontSize: 9, marginTop: 3 }}>
              Range: {Math.round(elevMin)}–{Math.round(elevMax)}m
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── GPSScreen ────────────────────────────────────────────────────────────────
export default function GPSScreen() {
  usePageTitle("GPS");
  const navigate = useNavigate();
  const location = useLocation();

  const files = useGpsStore(s => s.files);
  const setFiles = useGpsStore(s => s.setFiles);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trackData, setTrackData] = useState<GpsTrackData | null>(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [mergeWizardOpen, setMergeWizardOpen] = useState(false);
  const [chartCollapsed, setChartCollapsed] = useState(false);

  const [smoothWizardOpen, setSmoothWizardOpen] = useState(false);
  const [smoothSigma, setSmoothSigma] = useState(5);
  const [smoothMode, setSmoothMode] = useState<'new' | 'replace'>('new');
  const [smoothName, setSmoothName] = useState('');
  const [smoothSaving, setSmoothSaving] = useState(false);

  // ── POI Layer
  const [activePoi, setActivePoi] = useState<Set<PoiCategory>>(() => {
    try { const s = localStorage.getItem('gps_active_poi'); if (s) return new Set(JSON.parse(s) as PoiCategory[]); } catch (err) { console.error('📍 Failed to parse active POI from localStorage:', err); }
    return new Set();
  });
  useEffect(() => { localStorage.setItem('gps_active_poi', JSON.stringify([...activePoi])); }, [activePoi]);
  const [poiLoading, setPoiLoading] = useState(false);
  const [mapZoom, setMapZoom] = useState(5);
  // ── Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const pendingFitRef = useRef<L.LatLngBounds | null>(null);
  const [mapType, setMapType] = useState<'street' | 'satellite'>('street');
  const [planningNew, setPlanningNew] = useState(false);
  const baseTileRef = useRef<L.TileLayer | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const cursorMarkerRef = useRef<L.CircleMarker | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);
  const poiLayerRef = useRef<L.LayerGroup | null>(null);
  // Fetched POI markers by POI ID — diffed per response instead of clearing the layer
  const poiMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  // Saved route POIs (from the persisted route state)
  const savedPinMarkersRef = useRef<L.Marker[]>([]);
  const poiFetchControllerRef = useRef<AbortController | null>(null);
  const poiFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchPinRef = useRef<L.Marker | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const activePoisRef = useRef<Set<PoiCategory>>(new Set());
  useEffect(() => { activePoisRef.current = activePoi; }, [activePoi]);

  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    apiGetGpsFiles().then(data => setFiles(data)).catch(err => console.error('📍 Failed to load GPS files:', err));
  }, [setFiles]);

  useEffect(() => {
    const handler = () => { apiGetGpsFiles().then(data => setFiles(data)).catch(err => console.error('📍 Failed to reload GPS files:', err)); };
    window.addEventListener('gps-files-changed', handler);
    return () => window.removeEventListener('gps-files-changed', handler);
  }, [setFiles]);

  const mapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      leafletRef.current?.remove();
      leafletRef.current = null;
      return;
    }
    if (!leafletRef.current) {
      const map = L.map(node, { zoomControl: false }).setView([47, 10], 5);
      baseTileRef.current = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);
      const poiLayer = L.layerGroup().addTo(map);
      poiLayerRef.current = poiLayer;
      map.on('zoomend', () => setMapZoom(map.getZoom()));
      leafletRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
      setTimeout(() => map.invalidateSize(), 400);
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
            m.fitBounds(pendingFitRef.current, { padding: [30, 30], maxZoom: 16 });
            pendingFitRef.current = null;
          }
        }
      });
      ro.observe(node);
    }
  }, []);

  useEffect(() => {
    const poiMarkers = poiMarkersRef.current;
    return () => {
      leafletRef.current?.remove();
      leafletRef.current = null;
      polylineRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      cursorMarkerRef.current = null;
      searchPinRef.current?.remove();
      poiLayerRef.current?.clearLayers();
      poiMarkers.clear();
      poiFetchControllerRef.current?.abort();
      searchControllerRef.current?.abort();
      clearTimeout(poiFetchTimerRef.current!);
      clearTimeout(searchDebounceRef.current!);
    };
  }, []);

  useEffect(() => {
    const fileId = new URLSearchParams(location.search).get('file');
    if (fileId && fileId !== selectedIdRef.current) {
      selectFile(fileId);
    } else if (!fileId && selectedIdRef.current) {
      selectedIdRef.current = null;
      setSelectedId(null);
      setTrackData(null);
      setDeleteConfirm(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    const handler = () => fileInputRef.current?.click();
    window.addEventListener('gps-upload-trigger', handler);
    return () => window.removeEventListener('gps-upload-trigger', handler);
  }, []);

  // Chart collapse/expand — invalidate map size after animation
  useEffect(() => {
    const t = setTimeout(() => leafletRef.current?.invalidateSize(), 310);
    return () => clearTimeout(t);
  }, [chartCollapsed, selectedId, trackData]);

  const dragCounter = useRef(0);
  const handleUploadRef = useRef(handleUpload);
  useEffect(() => { handleUploadRef.current = handleUpload; });
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragCounter.current++;
      if (dragCounter.current === 1) setIsDragOver(true);
    };
    const onLeave = () => {
      dragCounter.current--;
      if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragOver(false); }
    };
    const onOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);
      if (e.dataTransfer?.files?.length) handleUploadRef.current(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    const map = leafletRef.current;
    if (!map) return;
    polylineRef.current?.remove(); polylineRef.current = null;
    startMarkerRef.current?.remove(); startMarkerRef.current = null;
    endMarkerRef.current?.remove(); endMarkerRef.current = null;
    cursorMarkerRef.current?.remove(); cursorMarkerRef.current = null;
    savedPinMarkersRef.current.forEach(m => m.remove());
    savedPinMarkersRef.current = [];

    // Saved route POIs — original coordinates, names and categories from the
    // persisted route state (GPX waypoints as fallback for older files)
    if (trackData) {
      const savedPois = trackData.routeState?.poiMarkers?.length
        ? trackData.routeState.poiMarkers
        : (trackData.waypoints ?? []).map(w => ({
            id: w.id, lat: w.lat, lon: w.lon, name: w.name,
            description: w.description, category: w.sym, highlighted: w.highlighted,
          }));
      for (const poi of savedPois) {
        const icon = L.divIcon({ className: '', html: createPinDivIcon(poi.category, poi.highlighted ?? false, 28), iconSize: [28, 28], iconAnchor: [14, 14] });
        const marker = L.marker([poi.lat, poi.lon], { icon, zIndexOffset: 250 });
        const cfg = (POI_CATEGORY_CONFIG as Record<string, typeof POI_CATEGORY_CONFIG[PoiCategory]>)[poi.category];
        marker.bindPopup(
          buildPoiPopupElement({ name: poi.name, description: poi.description, category: cfg ?? null }),
          { maxWidth: 260, className: 'solytiq-poi-popup' },
        );
        marker.addTo(map);
        savedPinMarkersRef.current.push(marker);
      }
    }

    if (!trackData || trackData.points.length === 0) return;
    const lls: L.LatLngTuple[] = trackData.points.map(p => [p.lat, p.lon]);
    polylineRef.current = L.polyline(lls, { color: '#5e4dbb', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }).addTo(map);
    startMarkerRef.current = L.circleMarker(lls[0], { radius: 9, fillColor: '#22c55e', color: '#fff', weight: 3, fillOpacity: 1 }).addTo(map);
    if (lls.length > 1) {
      endMarkerRef.current = L.circleMarker(lls[lls.length - 1], { radius: 9, fillColor: '#ef4444', color: '#fff', weight: 3, fillOpacity: 1 }).addTo(map);
    }
    const bounds = L.latLngBounds(lls);
    const size = map.getSize();
    if (size.x > 0 && size.y > 0) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    } else {
      // Container not laid out yet (hard refresh) — defer until it has a size
      pendingFitRef.current = bounds;
    }
    setTimeout(() => map.invalidateSize(), 80);
  }, [trackData]);

  useEffect(() => {
    const map = leafletRef.current;
    if (!map || !trackData) {
      cursorMarkerRef.current?.remove(); cursorMarkerRef.current = null;
      return;
    }
    if (hoveredIdx == null) {
      cursorMarkerRef.current?.setStyle({ fillOpacity: 0, opacity: 0 });
      return;
    }
    const p = trackData.points[hoveredIdx];
    if (!p) return;
    const ll: L.LatLngTuple = [p.lat, p.lon];
    if (cursorMarkerRef.current) {
      cursorMarkerRef.current.setLatLng(ll);
      cursorMarkerRef.current.setStyle({ fillOpacity: 1, opacity: 1 });
    } else {
      cursorMarkerRef.current = L.circleMarker(ll, {
        radius: 8, fillColor: '#5e4dbb', color: '#fff', weight: 2.5, fillOpacity: 1,
      }).addTo(map);
    }
  }, [hoveredIdx, trackData]);

  // ── POI Layer fetch & render ──────────────────────────────────────────────
  const doPoiFetch = useCallback(async (bounds: L.LatLngBounds, zoom: number) => {
    poiFetchControllerRef.current?.abort();
    const ctrl = new AbortController();
    poiFetchControllerRef.current = ctrl;
    setPoiLoading(true);
    try {
      const { pois: result } = await apiGetGpsPois({
        bbox: {
          south: bounds.getSouth(), west: bounds.getWest(),
          north: bounds.getNorth(), east: bounds.getEast(),
        },
        categories: [...activePoisRef.current],
        zoom,
      }, ctrl.signal);

      if (ctrl.signal.aborted) return;
      const layer = poiLayerRef.current;
      if (!layer) return;
      // Diff by POI ID — only add/move/remove what actually changed
      const existing = new Map([...poiMarkersRef.current].map(([poiId, m]) => {
        const ll = m.getLatLng();
        return [poiId, { lat: ll.lat, lon: ll.lng }] as const;
      }));
      const { toAdd, toMove, toRemove } = diffPoiMarkers(existing, result);
      for (const poiId of toRemove) {
        const m = poiMarkersRef.current.get(poiId);
        if (m) { layer.removeLayer(m); poiMarkersRef.current.delete(poiId); }
      }
      for (const poi of toMove) {
        poiMarkersRef.current.get(poi.id)?.setLatLng([poi.lat, poi.lon]);
      }
      toAdd.forEach(poi => {
        const icon = L.divIcon({ className: '', html: createPoiDivIcon(poi.category), iconSize: [28, 28], iconAnchor: [14, 14] });
        const marker = L.marker([poi.lat, poi.lon], { icon });
        const tags = poi.tags;
        const address = [
          tags['addr:street'] && tags['addr:housenumber'] ? `${tags['addr:street']} ${tags['addr:housenumber']}` : tags['addr:street'],
          tags['addr:city'] || tags['addr:town'],
        ].filter(Boolean).join(', ');
        const cfg = POI_CATEGORY_CONFIG[poi.category as PoiCategory];
        marker.bindPopup(
          buildPoiPopupElement({
            name: poi.name,
            category: cfg ?? null,
            address: address || null,
            openingHours: tags['opening_hours'] ?? null,
            phone: tags['phone'] || tags['contact:phone'] || null,
            website: tags['website'] || tags['contact:website'] || null,
          }),
          { maxWidth: 260, className: 'solytiq-poi-popup' },
        );
        layer.addLayer(marker);
        poiMarkersRef.current.set(poi.id, marker);
      });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') console.error('📍 POI fetch failed:', err);
    } finally { if (!ctrl.signal.aborted) setPoiLoading(false); }
  }, []);

  useEffect(() => {
    const map = leafletRef.current;
    if (!map) return;
    const scheduleFetch = () => {
      clearTimeout(poiFetchTimerRef.current!);
      poiFetchTimerRef.current = setTimeout(() => {
        if (activePoisRef.current.size === 0 || map.getZoom() < 13) {
          poiLayerRef.current?.clearLayers();
          poiMarkersRef.current.clear();
          return;
        }
        doPoiFetch(map.getBounds(), map.getZoom());
      }, 600);
    };
    map.on('moveend', scheduleFetch);
    map.on('zoomend', scheduleFetch);
    scheduleFetch();
    return () => {
      map.off('moveend', scheduleFetch);
      map.off('zoomend', scheduleFetch);
      clearTimeout(poiFetchTimerRef.current!);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePoi, doPoiFetch]);

  // ── Search ────────────────────────────────────────────────────────────────
  function placeSearchPin(lat: number, lon: number, label: string) {
    const map = leafletRef.current;
    if (!map) return;
    searchPinRef.current?.remove();
    const icon = L.divIcon({ className: '', html: `<div style="background:var(--color-primary);color:var(--color-white);border:2px solid var(--color-white);border-radius:50%;width:14px;height:14px;box-shadow:0 2px 8px rgba(var(--color-primary-rgb), 0.4);"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    // `label` is untrusted third-party search-result text (Nominatim
    // `display_name`) — pass a DOM node, never the raw string, so Leaflet's
    // tooltip doesn't fall into its innerHTML-assignment path (see poiPopup.ts).
    searchPinRef.current = L.marker([lat, lon], { icon }).bindTooltip(buildSafeTooltipElement(label), { permanent: false, direction: 'top' }).addTo(map);
  }

  function handleSearchChange(q: string) {
    clearTimeout(searchDebounceRef.current!);
    if (!q.trim()) { setSearchResults([]); return; }
    const coords = parseCoordInput(q);
    if (coords) {
      setSearchResults([]);
      const map = leafletRef.current;
      if (map) {
        map.flyTo(coords, 15, { animate: true, duration: 1.2 });
        placeSearchPin(coords[0], coords[1], `${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`);
      }
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
        const results = await searchNominatim(q, bounds ? { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() } : undefined, ctrl.signal);
        if (!ctrl.signal.aborted) setSearchResults(results.slice(0, 5));
      } catch (err) {
        if ((err as DOMException)?.name !== 'AbortError') console.error('📍 Search failed:', err);
      } finally { if (!ctrl.signal.aborted) setSearchLoading(false); }
    }, 400);
  }

  function handleSearchSelect(r: NominatimResult) {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    const map = leafletRef.current;
    if (!map || isNaN(lat) || isNaN(lon)) return;
    map.flyTo([lat, lon], 15, { animate: true, duration: 1.2 });
    placeSearchPin(lat, lon, r.display_name.split(',')[0]);
    setSearchResults([]);
    setSearchOpen(false);
  }

  async function handlePlanNewRoute() {
    setPlanningNew(true);
    try {
      const file = await apiCreateNewGpsRoute('New Route');
      navigate(`/gps/${file.id}/edit`);
    } catch (err) { console.error('Failed to create route:', err); }
    finally { setPlanningNew(false); }
  }

  function handleMapTypeToggle() {
    const map = leafletRef.current;
    if (!map) return;
    const next = mapType === 'street' ? 'satellite' : 'street';
    baseTileRef.current?.remove();
    if (next === 'satellite') {
      baseTileRef.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, USGS, NOAA',
        maxZoom: 19,
      }).addTo(map);
    } else {
      baseTileRef.current = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);
    }
    setMapType(next);
  }

  async function selectFile(id: string) {
    if (selectedIdRef.current === id) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setDeleteConfirm(null);
    navigate(`/gps?file=${id}`, { replace: true });
    setTrackData(null);
    setTrackLoading(true);
    setHoveredIdx(null);
    try {
      const data = await apiGetGpsTrackData(id);
      setTrackData(data);
    } catch (err) { console.error(err); }
    setTrackLoading(false);
    setTimeout(() => leafletRef.current?.invalidateSize(), 80);
  }

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    setUploading(true); setUploadProgress(0);
    try {
      const uploaded = await apiUploadGpsFile(file, pct => setUploadProgress(pct));
      setFiles(prev => [uploaded, ...prev]);
      window.dispatchEvent(new CustomEvent('gps-files-changed'));
    } catch (err) { console.error('Upload failed:', err); }
    setUploading(false); setUploadProgress(0);
  }

  async function downloadOriginal() {
    if (!selectedId || downloading) return;
    setDownloading(true);
    try {
      const blob = await apiDownloadGpsFile(selectedId);
      triggerDownload(blob, files.find(f => f.id === selectedId)?.name ?? 'route.gpx');
    } catch (err) { console.error(err); }
    setDownloading(false);
  }

  async function handleDeleteSelected() {
    if (!selectedId) return;
    try {
      await apiDeleteGpsFile(selectedId);
    } catch (err) {
      console.error('📍 Failed to delete GPS file:', err);
      return;
    }
    setFiles(prev => prev.filter(f => f.id !== selectedId));
    window.dispatchEvent(new CustomEvent('gps-files-changed'));
    selectedIdRef.current = null;
    setSelectedId(null); setTrackData(null); setDeleteConfirm(null);
    navigate('/gps', { replace: true });
    polylineRef.current?.remove(); polylineRef.current = null;
    startMarkerRef.current?.remove(); startMarkerRef.current = null;
    endMarkerRef.current?.remove(); endMarkerRef.current = null;
  }

  async function handleSmoothApply() {
    if (!selectedId || smoothSaving) return;
    setSmoothSaving(true);
    try {
      const sel = files.find(f => f.id === selectedId);
      const baseName = sel ? sel.name.replace(/\.(gpx|fit)$/i, '') : 'route';
      const nameToUse = smoothMode === 'new' ? (smoothName.trim() || `${baseName}_smoothed`) : undefined;
      const file = await apiSmoothAndSaveGpsFile(selectedId, smoothSigma, smoothMode, nameToUse);
      if (smoothMode === 'new') {
        setFiles(prev => [file, ...prev]);
      } else {
        setFiles(prev => prev.map(f => f.id === selectedId ? file : f));
        setTrackLoading(true);
        setTrackData(null);
        try { const data = await apiGetGpsTrackData(selectedId); setTrackData(data); } catch (err) { console.error('📍 Failed to reload track data after smooth:', err); }
        setTrackLoading(false);
      }
      window.dispatchEvent(new CustomEvent('gps-files-changed'));
      setSmoothWizardOpen(false);
      setSmoothName(''); setSmoothSigma(5); setSmoothMode('new');
    } catch (err) { console.error('Smooth-save failed:', err); }
    setSmoothSaving(false);
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const selectedFile = useMemo(() => files.find(f => f.id === selectedId) ?? null, [files, selectedId]);

  const CHART_H = 160;
  const chartVisible = !!(selectedId && trackData && !chartCollapsed);

  // Shared glassmorphic button style for map controls
  const mapCtrlBtn = (enabled = true): React.CSSProperties => ({
    width: 36, height: 36, borderRadius: 9,
    background: 'rgba(var(--color-white-rgb), 0.88)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(var(--color-white-rgb), 0.75)',
    boxShadow: '0 2px 12px rgba(var(--color-primary-rgb), 0.10)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.45,
    transition: 'box-shadow 150ms, background 150ms',
  });

  return (
    <>
      <style>{`
        @keyframes gpsPageIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes mapFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .gps-map-ctrl:hover { box-shadow: 0 4px 18px rgba(var(--color-primary-rgb), 0.18) !important; background: rgba(var(--color-white-rgb), 0.97) !important; }
      `}</style>

      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        height: '100%', overflow: 'hidden', position: 'relative',
        animation: 'gpsPageIn 380ms cubic-bezier(0.23,1,0.32,1) both',
        fontFamily: 'var(--font-body)',
      }}>
        {/* ── Map fills full area ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', isolation: 'isolate' }}>
          {/* Leaflet map */}
          <div ref={mapCallbackRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />

          {/* ── Floating Info Card (top-left, only when file selected) ─────── */}
          {selectedFile && (
            <div style={{
              position: 'absolute', top: 16, left: 16, zIndex: 1000,
              width: 300, boxSizing: 'border-box',
              background: 'rgba(var(--color-white-rgb), 0.88)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(var(--color-white-rgb), 0.75)',
              borderRadius: 14, padding: '14px 16px',
              boxShadow: '0 4px 32px rgba(var(--color-primary-rgb), 0.12), inset 0 1px 0 rgba(var(--color-white-rgb), 0.90)',
              animation: 'mapFadeIn 300ms ease both',
            }}>
              {/* File type badge + name */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <span style={{
                  background: selectedFile.fileType === 'gpx' ? 'var(--color-surface-tint-4)' : 'var(--color-teal-tint-1)',
                  color: selectedFile.fileType === 'gpx' ? 'var(--color-primary)' : 'var(--color-teal-deep-2)',
                  borderRadius: 4, padding: '2px 6px', fontSize: 9,
                  fontWeight: 700, letterSpacing: '0.04em',
                  fontFamily: 'var(--font-heading)', flexShrink: 0, marginTop: 2,
                }}>
                  {selectedFile.fileType.toUpperCase()}
                </span>
                <span style={{
                  fontFamily: 'var(--font-heading)', fontSize: 13,
                  fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.3, wordBreak: 'break-word',
                }}>
                  {selectedFile.name.replace(/\.(gpx|fit)$/i, '')}
                </span>
              </div>

              {/* Stats row */}
              <div style={{ display: 'flex', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', marginBottom: 2 }}>Distance</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>
                    {fmtDist(selectedFile.metadata?.totalDistance)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', marginBottom: 2 }}>Elev Gain</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>
                    {fmtElev(selectedFile.metadata?.totalElevationGain)}
                  </div>
                </div>
                {selectedFile.metadata?.duration != null && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', marginBottom: 2 }}>Time</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>
                      {fmtDuration(selectedFile.metadata.duration)}
                    </div>
                  </div>
                )}
              </div>

              {/* Action buttons — 3 columns, unless delete confirm shown */}
              {deleteConfirm === 'selected' ? (
                <div style={{ background: 'var(--color-error-bg-alt)', border: '1px solid var(--color-red-tint-1)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-error)', marginBottom: 4, fontFamily: 'var(--font-heading)' }}>Delete this route?</div>
                  <div style={{ fontSize: 11, color: 'var(--color-red-mid-3)', marginBottom: 10, fontFamily: 'var(--font-body)' }}>This action cannot be undone.</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      style={{ flex: 1, padding: '6px 0', borderRadius: 7, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-body)' }}
                    >Cancel</button>
                    <button
                      onClick={handleDeleteSelected}
                      style={{ flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', background: 'var(--color-error)', color: 'var(--color-white)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-heading)' }}
                    >Delete</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  {/* Edit */}
                  <button
                    onClick={() => navigate(`/gps/${selectedId}/edit`)}
                    style={{
                      height: 32, borderRadius: 8, border: 'none',
                      background: 'var(--color-primary)', color: 'var(--color-white)',
                      fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      fontFamily: 'var(--font-heading)', transition: 'background 150ms',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-primary)'; }}
                  >
                    <Icon name="edit" size={12} color="var(--color-white)" />
                    Edit
                  </button>
                  {/* Download */}
                  <button
                    onClick={downloadOriginal}
                    disabled={downloading}
                    style={{
                      height: 32, borderRadius: 8, border: '1px solid var(--color-border)',
                      background: 'var(--color-white)', color: 'var(--color-text-secondary)',
                      fontSize: 11, fontWeight: 600,
                      cursor: downloading ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      fontFamily: 'var(--font-heading)', transition: 'background 150ms',
                      opacity: downloading ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { if (!downloading) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-white)'; }}
                  >
                    <Icon name="download" size={12} color="var(--color-text-tertiary)" />
                    Save
                  </button>
                  {/* Delete */}
                  <button
                    onClick={() => setDeleteConfirm('selected')}
                    style={{
                      height: 32, borderRadius: 8, border: '1px solid var(--color-red-tint-1)',
                      background: 'transparent', color: 'var(--color-error)',
                      fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      fontFamily: 'var(--font-heading)', transition: 'background 150ms',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-error-bg-alt)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="delete" size={12} color="var(--color-error)" />
                    Delete
                  </button>
                </div>
              )}

              {/* Upload progress */}
              {uploading && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 4, background: 'var(--color-surface-tint-4)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${uploadProgress}%`, background: 'var(--color-primary)', borderRadius: 4, transition: 'width 200ms' }} />
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{uploadProgress}%</span>
                </div>
              )}
            </div>
          )}

          {/* ── Search + POI toggles (unified card, top-center) ─────────────── */}
          <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1001, width: 340 }}>
            <div style={{
              background: 'rgba(var(--color-white-rgb), 0.95)', backdropFilter: 'blur(20px) saturate(180%)',
              border: `1px solid ${searchOpen ? 'var(--color-accent-purple-soft)' : 'rgba(var(--color-white-rgb), 0.75)'}`,
              borderRadius: 14, boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.12)',
              transition: 'border-color 150ms', overflow: 'hidden',
            }}>
              {/* Search row */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
                <Icon name={searchLoading ? 'progress_activity' : 'search'} size={16} color="var(--color-text-tertiary)" />
                <input
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); handleSearchChange(e.target.value); }}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                  placeholder="Place, address or 53.123, 10.456"
                  style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-body)', padding: '10px 0' }}
                />
                {searchQuery && (
                  <button onMouseDown={e => { e.preventDefault(); setSearchQuery(''); setSearchResults([]); searchPinRef.current?.remove(); searchPinRef.current = null; }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <Icon name="close" size={14} color="var(--color-text-quaternary)" />
                  </button>
                )}
              </div>
              {/* Divider */}
              <div style={{ height: 1, background: 'var(--color-surface-tint-4)', margin: '0 10px' }} />
              {/* POI category toggles row */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', gap: 4 }}>
                {(Object.entries(POI_CATEGORY_CONFIG) as Array<[PoiCategory, typeof POI_CATEGORY_CONFIG[PoiCategory]]>).map(([cat, cfg]) => {
                  const active = activePoi.has(cat);
                  return (
                    <button key={cat} title={cfg.label} onClick={() => setActivePoi(prev => { const next = new Set(prev); active ? next.delete(cat) : next.add(cat); return next; })} style={{ flex: 1, height: 30, borderRadius: 7, background: active ? cfg.bg : 'transparent', border: active ? `1.5px solid ${cfg.borderColor}` : '1.5px solid var(--color-purple-pale-24)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', opacity: active ? 1 : 0.5 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 15, color: active ? cfg.fg : 'var(--color-text-quaternary)', lineHeight: 1, fontVariationSettings: "'FILL' 1, 'wght' 400" }}>{cfg.icon}</span>
                    </button>
                  );
                })}
                {poiLoading && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.7, animation: 'pulse 1s ease-in-out infinite', marginLeft: 4, flexShrink: 0 }} />}
              </div>
              {/* Search results dropdown */}
              {searchOpen && searchResults.length > 0 && (
                <div style={{ borderTop: '1px solid var(--color-border)', maxHeight: 240, overflowY: 'auto' }}>
                  {searchResults.map(r => (
                    <button key={r.place_id} onMouseDown={() => handleSearchSelect(r)} style={{ width: '100%', padding: '8px 14px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', borderBottom: '1px solid var(--color-surface-tint)', transition: 'background 100ms' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>{r.display_name.split(',')[0]}</div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-quaternary)', marginTop: 1 }}>{r.display_name.split(',').slice(1, 3).join(',').trim()}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {activePoi.size > 0 && mapZoom < 13 && (
            <div style={{ position: 'absolute', top: 110, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: 'rgba(var(--color-white-rgb), 0.88)', backdropFilter: 'blur(12px)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '6px 14px', fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)', whiteSpace: 'nowrap' }}>
              Zoom in to see POIs
            </div>
          )}

          {/* ── Map action controls (top-right) ───────────────────────────── */}
          <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="gps-map-ctrl"
              onClick={() => selectedId && !selectedFile?.smoothed && setSmoothWizardOpen(true)}
              disabled={!selectedId || !!selectedFile?.smoothed}
              title={selectedFile?.smoothed ? 'Elevation already smoothed' : 'Smooth Elevation'}
              style={mapCtrlBtn(!!selectedId && !selectedFile?.smoothed)}
            >
              <Icon name="auto_fix_high" size={16} color={selectedFile?.smoothed ? 'var(--color-text-quaternary)' : 'var(--color-primary)'} />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={() => setMergeWizardOpen(true)}
              title="Merge Routes"
              style={mapCtrlBtn()}
            >
              <Icon name="merge" size={16} color="var(--color-primary)" />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={() => fileInputRef.current?.click()}
              title="Upload Route"
              style={mapCtrlBtn()}
            >
              <Icon name="upload" size={16} color="var(--color-primary)" />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={handleMapTypeToggle}
              title={mapType === 'street' ? 'Satellite View' : 'Street Map'}
              style={{ ...mapCtrlBtn(), ...(mapType === 'satellite' ? { background: 'var(--color-primary)', border: '1px solid var(--color-purple-mid-12)' } : {}) }}
            >
              <Icon name={mapType === 'street' ? 'satellite_alt' : 'map'} size={16} color={mapType === 'satellite' ? 'var(--color-white)' : 'var(--color-primary)'} />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={handlePlanNewRoute}
              disabled={planningNew}
              title="Plan new route"
              style={{ ...mapCtrlBtn(!planningNew) }}
            >
              <Icon name={planningNew ? 'progress_activity' : 'add_road'} size={16} color="var(--color-primary)" />
            </button>

            {/* Zoom controls — replaces the default Leaflet control (was hidden under the info card) */}
            <div style={{ height: 1, background: 'rgba(var(--color-primary-rgb), 0.18)', margin: '4px 6px' }} />
            <button
              className="gps-map-ctrl"
              onClick={() => leafletRef.current?.zoomIn()}
              title="Zoom In"
              style={mapCtrlBtn()}
            >
              <Icon name="add" size={16} color="var(--color-primary)" />
            </button>
            <button
              className="gps-map-ctrl"
              onClick={() => leafletRef.current?.zoomOut()}
              title="Zoom Out"
              style={mapCtrlBtn()}
            >
              <Icon name="remove" size={16} color="var(--color-primary)" />
            </button>
          </div>

          {/* ── Empty state (no file selected) ────────────────────────────── */}
          {!selectedId && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              zIndex: 5, pointerEvents: 'none',
            }}>
              <div style={{
                background: 'rgba(var(--color-white-rgb), 0.82)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(var(--color-white-rgb), 0.75)',
                borderRadius: 16, padding: '24px 32px',
                textAlign: 'center',
                boxShadow: '0 4px 24px rgba(var(--color-primary-rgb), 0.10)',
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 14,
                  background: 'var(--color-surface-tint-4)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
                }}>
                  <Icon name="route" size={24} color="var(--color-primary)" />
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6 }}>
                  {files.length === 0 ? 'No routes yet' : 'Select a route'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)' }}>
                  {files.length === 0
                    ? 'Upload a GPX or FIT file from the sidebar'
                    : 'Click a route in the sidebar to preview it'}
                </div>
              </div>
            </div>
          )}

          {/* ── Track loading overlay ─────────────────────────────────────── */}
          {trackLoading && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(var(--color-page-bg-rgb), 0.65)', backdropFilter: 'blur(4px)', zIndex: 10,
            }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)' }}>Loading route…</div>
            </div>
          )}

          {/* ── Elevation chart toggle button ─────────────────────────────── */}
          {selectedId && trackData && (
            <button
              onClick={() => setChartCollapsed(c => !c)}
              style={{
                position: 'absolute',
                bottom: chartVisible ? CHART_H + 10 : 12,
                left: '50%', transform: 'translateX(-50%)',
                zIndex: 1001, height: 24, padding: '0 12px',
                background: 'rgba(var(--color-white-rgb), 0.88)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid rgba(var(--color-white-rgb), 0.75)',
                borderRadius: 20, fontSize: 11, fontWeight: 600,
                color: 'var(--color-primary)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
                transition: 'bottom 280ms cubic-bezier(0.23,1,0.32,1)',
                boxShadow: '0 2px 10px rgba(var(--color-primary-rgb), 0.10)',
                fontFamily: 'var(--font-body)',
              }}
            >
              <Icon name={chartCollapsed ? 'expand_less' : 'expand_more'} size={14} color="var(--color-primary)" />
              {chartCollapsed ? 'Elevation' : 'Hide'}
            </button>
          )}

          {/* ── Elevation chart strip (bottom) ────────────────────────────── */}
          {selectedId && trackData && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: chartCollapsed ? 0 : CHART_H,
              overflow: 'hidden',
              transition: 'height 280ms cubic-bezier(0.23,1,0.32,1)',
              zIndex: 1000,
              background: 'rgba(var(--color-white-rgb), 0.70)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              borderTop: '1px solid rgba(var(--color-white-rgb), 0.68)',
              boxShadow: '0 -6px 32px rgba(var(--color-primary-rgb), 0.08)',
            }}>
              <MultiLineMapChart
                trackData={trackData}
                hoveredIdx={hoveredIdx}
                onHover={setHoveredIdx}
              />
            </div>
          )}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".gpx,.fit"
          style={{ display: 'none' }}
          onChange={e => handleUpload(e.target.files)}
          onClick={e => { (e.target as HTMLInputElement).value = ''; }}
        />

        {/* Full-window drag overlay */}
        {isDragOver && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 500, pointerEvents: 'none',
            background: 'rgba(var(--color-primary-rgb), 0.10)', backdropFilter: 'blur(3px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
          }}>
            <div style={{ border: '3px dashed var(--color-primary)', borderRadius: 24, padding: '48px 72px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, background: 'rgba(var(--color-page-bg-rgb), 0.85)' }}>
              <div style={{ width: 72, height: 72, borderRadius: 22, background: 'var(--color-surface-tint-4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="upload" size={34} color="var(--color-primary)" />
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-primary)' }}>Drop to upload route</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-accent-purple-light)' }}>.GPX and .FIT files supported</div>
            </div>
          </div>
        )}

        {/* Merge wizard */}
        {mergeWizardOpen && (
          <GPSMergeWizard
            files={files}
            onClose={() => setMergeWizardOpen(false)}
            onMerged={file => { setFiles(prev => [file, ...prev]); setMergeWizardOpen(false); }}
          />
        )}

        {/* Smooth wizard modal */}
        {smoothWizardOpen && createPortal(
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(var(--color-purple-deep-6-rgb), 0.45)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={e => { if (e.target === e.currentTarget) setSmoothWizardOpen(false); }}
          >
            <div style={{ background: 'var(--color-white)', borderRadius: 16, padding: '24px', width: 380, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', border: '1px solid var(--color-border)', fontFamily: 'var(--font-body)' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>Smooth Elevation</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 20 }}>Apply Gaussian smoothing to reduce GPS noise in the elevation profile.</div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)' }}>Smoothing Strength</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', fontFamily: 'var(--font-heading)' }}>σ = {smoothSigma}</span>
                </div>
                <input type="range" min={1} max={30} value={smoothSigma} onChange={e => setSmoothSigma(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-quaternary)', marginTop: 3 }}>
                  <span>Subtle (1)</span><span>Heavy (30)</span>
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', marginBottom: 8 }}>Save As</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {([
                    { value: 'new', label: 'Save as New Route', icon: 'add_circle', desc: 'Keep the original' },
                    { value: 'replace', label: 'Override Current', icon: 'sync', desc: 'Replace original file' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setSmoothMode(opt.value)}
                      style={{
                        padding: '12px 10px', borderRadius: 10, cursor: 'pointer',
                        border: `2px solid ${smoothMode === opt.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        background: smoothMode === opt.value ? 'var(--color-surface-tint)' : 'var(--color-white)',
                        textAlign: 'left', transition: 'all 150ms',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <Icon name={opt.icon} size={14} color={smoothMode === opt.value ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: smoothMode === opt.value ? 'var(--color-primary)' : 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)' }}>{opt.label}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)' }}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              {smoothMode === 'new' && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', marginBottom: 6 }}>
                    New File Name <span style={{ fontWeight: 400, color: 'var(--color-text-quaternary)' }}>(optional)</span>
                  </div>
                  <input
                    type="text" value={smoothName} onChange={e => setSmoothName(e.target.value)}
                    placeholder={`${(selectedFile?.name ?? 'route').replace(/\.(gpx|fit)$/i, '')}_smoothed`}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, boxSizing: 'border-box', border: '1px solid var(--color-border)', fontSize: 12, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)', outline: 'none', background: 'var(--color-surface-tint-3)' }}
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setSmoothWizardOpen(false)}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-heading)' }}
                >Cancel</button>
                <button
                  onClick={handleSmoothApply}
                  disabled={smoothSaving}
                  style={{
                    flex: 2, padding: '9px 0', borderRadius: 9, border: 'none',
                    background: smoothSaving ? 'var(--color-accent-purple-soft)' : 'var(--color-primary)', color: 'var(--color-white)',
                    fontSize: 13, fontWeight: 600, cursor: smoothSaving ? 'default' : 'pointer',
                    fontFamily: 'var(--font-heading)', transition: 'background 150ms',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                  onMouseEnter={e => { if (!smoothSaving) e.currentTarget.style.background = 'var(--color-purple-mid-11)'; }}
                  onMouseLeave={e => { if (!smoothSaving) e.currentTarget.style.background = 'var(--color-primary)'; }}
                >
                  <Icon name="auto_fix_high" size={14} color="var(--color-white)" />
                  {smoothSaving ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </>
  );
}
