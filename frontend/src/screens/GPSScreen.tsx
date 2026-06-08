import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import type { GpsTrackData, GpsMetricPoint } from '../types';
import {
  apiGetGpsFiles, apiUploadGpsFile, apiGetGpsTrackData,
  apiDownloadGpsFile, apiDeleteGpsFile, apiSmoothAndSaveGpsFile,
} from '../api/client';
import useGpsStore from '../store/useGpsStore';
import Icon from '../components/Icon';
import GPSMergeWizard from '../components/GPSMergeWizard';

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
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [dims, setDims] = useState({ w: 800, h: 190 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const e = entries[0].contentRect;
      setDims({ w: Math.max(100, e.width), h: Math.max(50, e.height) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const PAD = { l: 8, r: 8, t: 32, b: 24 };
  const cw = dims.w - PAD.l - PAD.r;
  const ch = dims.h - PAD.t - PAD.b;

  const elevProf = trackData.elevationProfile;
  const maxDist = elevProf.length > 0 ? elevProf[elevProf.length - 1].distance : 1;

  const toX = (dist: number) => PAD.l + (dist / maxDist) * cw;

  // Metrics to show
  const metrics: Array<{
    key: string;
    color: string;
    label: string;
    unit: string;
    values: (number | null)[];
  }> = [];

  // Elevation always present
  const elevVals = elevProf.map(p => p.elevation);
  const elevMin = Math.min(...elevVals);
  const elevMax = Math.max(...elevVals);
  metrics.push({ key: 'elevation', color: '#5e4dbb', label: 'Elevation', unit: 'm', values: elevVals });

  if (trackData.metricsAvailable.hr && trackData.hrProfile) {
    const vals = trackData.hrProfile.map((p: GpsMetricPoint) => p.value);
    metrics.push({ key: 'hr', color: '#ef4444', label: 'HR', unit: 'bpm', values: vals });
  }
  if (trackData.metricsAvailable.cadence && trackData.cadenceProfile) {
    const vals = trackData.cadenceProfile.map((p: GpsMetricPoint) => p.value);
    metrics.push({ key: 'cadence', color: '#10b981', label: 'Cadence', unit: 'rpm', values: vals });
  }
  if (trackData.metricsAvailable.power && trackData.powerProfile) {
    const vals = trackData.powerProfile.map((p: GpsMetricPoint) => p.value);
    metrics.push({ key: 'power', color: '#f59e0b', label: 'Power', unit: 'W', values: vals });
  }

  // Normalize each metric to [0,1]
  const normalizedMetrics = metrics.map(m => {
    const validVals = m.values.filter((v): v is number => v != null);
    const min = validVals.length > 0 ? Math.min(...validVals) : 0;
    const max = validVals.length > 0 ? Math.max(...validVals) : 1;
    const range = max - min || 1;
    return { ...m, min, max, range, normalized: m.values.map(v => v != null ? (v - min) / range : null) };
  });

  const toY = (norm: number | null) => {
    if (norm == null) return null;
    return PAD.t + (1 - norm) * ch;
  };

  // Build paths
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

  // Elevation area
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

  // Hover marker info
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

  // X axis ticks
  const xTicks = 5;

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Legend row */}
      <div style={{
        position: 'absolute', top: 6, left: PAD.l, right: PAD.r,
        display: 'flex', gap: 12, zIndex: 2, pointerEvents: 'none',
      }}>
        {metrics.map(m => (
          <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 3, borderRadius: 2, background: m.color }} />
            <span style={{ fontSize: 10, color: '#e0d8ff', fontFamily: 'Inter, sans-serif', fontWeight: 500 }}>
              {m.label}
            </span>
          </div>
        ))}
      </div>

      <svg
        ref={svgRef}
        width={dims.w}
        height={dims.h}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onHover(null)}
      >
        <defs>
          <linearGradient id="multiline-elev-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5e4dbb" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#5e4dbb" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => {
          const y = PAD.t + (1 - frac) * ch;
          return (
            <line key={frac} x1={PAD.l} y1={y} x2={PAD.l + cw} y2={y}
              stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} />
          );
        })}

        {/* X-axis distance labels */}
        {Array.from({ length: xTicks + 1 }, (_, i) => {
          const dist = (i / xTicks) * maxDist;
          const x = toX(dist);
          return (
            <text key={i} x={x} y={dims.h - 6} textAnchor="middle"
              style={{ fontSize: 9, fill: 'rgba(200,190,255,0.7)', fontFamily: 'Inter, sans-serif' }}>
              {dist >= 1000 ? `${(dist / 1000).toFixed(1)}k` : Math.round(dist)}m
            </text>
          );
        })}

        {/* Elevation area fill */}
        {areaD && <path d={areaD} fill="url(#multiline-elev-grad)" />}

        {/* Lines for each metric */}
        {paths.map(p => (
          p.pathD ? <path key={p.key} d={p.pathD} fill="none" stroke={p.color} strokeWidth={p.key === 'elevation' ? 2 : 1.5} opacity={0.9} /> : null
        ))}

        {/* Hover cursor line */}
        {hovX != null && (
          <line x1={hovX} y1={PAD.t} x2={hovX} y2={PAD.t + ch}
            stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="4,3" />
        )}

        {/* Hover dots */}
        {hovX != null && hoveredIdx != null && normalizedMetrics.map(m => {
          const norm = m.normalized[hoveredIdx];
          const y = toY(norm);
          if (y == null) return null;
          return (
            <circle key={m.key} cx={hovX} cy={y} r={4}
              fill={m.color} stroke="rgba(8,5,18,0.72)" strokeWidth={2} />
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {hovX != null && hoveredIdx != null && (
        <div style={{
          position: 'absolute',
          top: PAD.t,
          left: Math.min(hovX + 10, dims.w - 140),
          background: 'rgba(8,5,18,0.85)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          padding: '6px 10px',
          pointerEvents: 'none',
          zIndex: 10,
          fontFamily: 'Inter, sans-serif',
          fontSize: 11,
          minWidth: 120,
        }}>
          <div style={{ color: 'rgba(200,190,255,0.7)', marginBottom: 4, fontSize: 10 }}>
            {fmtDist(elevProf[hoveredIdx]?.distance)}
          </div>
          {normalizedMetrics.map(m => {
            const val = m.values[hoveredIdx];
            if (val == null) return null;
            return (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                <span style={{ color: m.color, fontWeight: 600 }}>
                  {Math.round(val)} {m.unit}
                </span>
              </div>
            );
          })}
          {/* Show elevation range context */}
          {elevVals.length > 0 && (
            <div style={{ color: 'rgba(160,150,200,0.6)', fontSize: 9, marginTop: 3 }}>
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

  // Smooth wizard state
  const [smoothWizardOpen, setSmoothWizardOpen] = useState(false);
  const [smoothSigma, setSmoothSigma] = useState(5);
  const [smoothMode, setSmoothMode] = useState<'new' | 'replace'>('new');
  const [smoothName, setSmoothName] = useState('');
  const [smoothSaving, setSmoothSaving] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const cursorMarkerRef = useRef<L.CircleMarker | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  // ── Load files on mount (only once, if store is empty)
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    apiGetGpsFiles()
      .then(data => setFiles(data))
      .catch(() => {});
  }, [setFiles]);

  // ── Listen for external GPS changes (e.g. from AI assistant)
  useEffect(() => {
    const handler = () => {
      apiGetGpsFiles().then(data => setFiles(data)).catch(() => {});
    };
    window.addEventListener('gps-files-changed', handler);
    return () => window.removeEventListener('gps-files-changed', handler);
  }, [setFiles]);

  // ── Init Leaflet via callback ref
  const mapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      leafletRef.current?.remove();
      leafletRef.current = null;
      return;
    }
    mapContainerRef.current = node;
    if (!leafletRef.current) {
      const map = L.map(node, { zoomControl: true }).setView([47, 10], 5);
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>',
        maxZoom: 17,
      }).addTo(map);
      leafletRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
      setTimeout(() => map.invalidateSize(), 400);
      const ro = new ResizeObserver(() => leafletRef.current?.invalidateSize());
      ro.observe(node);
    }
  }, []);

  // ── Cleanup Leaflet on unmount
  useEffect(() => {
    return () => {
      leafletRef.current?.remove();
      leafletRef.current = null;
      polylineRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      cursorMarkerRef.current = null;
    };
  }, []);

  // ── Sync from URL param
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

  // ── Sidebar upload button trigger
  useEffect(() => {
    const handler = () => fileInputRef.current?.click();
    window.addEventListener('gps-upload-trigger', handler);
    return () => window.removeEventListener('gps-upload-trigger', handler);
  }, []);

  // ── Window-level drag-and-drop
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

  // ── Draw polyline when trackData changes
  useEffect(() => {
    const map = leafletRef.current;
    if (!map) return;
    polylineRef.current?.remove(); polylineRef.current = null;
    startMarkerRef.current?.remove(); startMarkerRef.current = null;
    endMarkerRef.current?.remove(); endMarkerRef.current = null;
    cursorMarkerRef.current?.remove(); cursorMarkerRef.current = null;
    if (!trackData || trackData.points.length === 0) return;
    const lls: L.LatLngTuple[] = trackData.points.map(p => [p.lat, p.lon]);
    polylineRef.current = L.polyline(lls, { color: '#5e4dbb', weight: 3.5, opacity: 0.92 }).addTo(map);
    startMarkerRef.current = L.circleMarker(lls[0], { radius: 7, fillColor: '#22c55e', color: '#fff', weight: 2.5, fillOpacity: 1 }).addTo(map);
    if (lls.length > 1) {
      endMarkerRef.current = L.circleMarker(lls[lls.length - 1], { radius: 7, fillColor: '#ef4444', color: '#fff', weight: 2.5, fillOpacity: 1 }).addTo(map);
    }
    map.fitBounds(L.latLngBounds(lls), { padding: [30, 30], maxZoom: 16 });
    setTimeout(() => map.invalidateSize(), 80);
  }, [trackData]);

  // ── Move cursor marker on chart hover
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
    await apiDeleteGpsFile(selectedId);
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
      const selectedFile = files.find(f => f.id === selectedId);
      const baseName = selectedFile ? selectedFile.name.replace(/\.(gpx|fit)$/i, '') : 'route';
      const nameToUse = smoothMode === 'new' ? (smoothName.trim() || `${baseName}_smoothed`) : undefined;
      const file = await apiSmoothAndSaveGpsFile(selectedId, smoothSigma, smoothMode, nameToUse);
      if (smoothMode === 'new') {
        setFiles(prev => [file, ...prev]);
      } else {
        setFiles(prev => prev.map(f => f.id === selectedId ? file : f));
        // Reload track data since file was replaced
        setTrackLoading(true);
        setTrackData(null);
        try {
          const data = await apiGetGpsTrackData(selectedId);
          setTrackData(data);
        } catch { /* ignore */ }
        setTrackLoading(false);
      }
      window.dispatchEvent(new CustomEvent('gps-files-changed'));
      setSmoothWizardOpen(false);
      setSmoothName('');
      setSmoothSigma(5);
      setSmoothMode('new');
    } catch (err) {
      console.error('Smooth-save failed:', err);
    }
    setSmoothSaving(false);
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const selectedFile = useMemo(() => files.find(f => f.id === selectedId) ?? null, [files, selectedId]);

  return (
    <>
      <style>{`
        @keyframes gpsPageIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes mapFadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        height: '100%', overflow: 'hidden',
        animation: 'gpsPageIn 380ms cubic-bezier(0.23,1,0.32,1) both',
        fontFamily: 'Inter, sans-serif',
      }}>

        {/* ── Secondary Toolbar ──────────────────────────────────────────────── */}
        <div style={{
          height: 46, flexShrink: 0, borderBottom: '1px solid #e8e4f0',
          background: 'rgba(253,248,255,0.97)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10,
        }}>
          <button
            onClick={() => { if (selectedId) setSmoothWizardOpen(true); }}
            disabled={!selectedId}
            style={{
              height: 30, padding: '0 14px', borderRadius: 8,
              border: '1px solid #c4b8f0', background: '#F5F3FF', color: '#5e4dbb',
              fontSize: 12, fontWeight: 600, cursor: selectedId ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', gap: 6, transition: 'all 150ms',
              fontFamily: 'Hanken Grotesk, sans-serif', flexShrink: 0,
              opacity: selectedId ? 1 : 0.5,
            }}
            onMouseEnter={e => { if (selectedId) e.currentTarget.style.background = '#ede9ff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
          >
            <Icon name="auto_fix_high" size={14} color="#5e4dbb" />
            Smooth Elevation
          </button>

          {uploading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 120, height: 4, borderRadius: 4, background: '#ede9ff', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${uploadProgress}%`, background: '#5e4dbb', borderRadius: 4, transition: 'width 200ms' }} />
              </div>
              <span style={{ fontSize: 11, color: '#787584', whiteSpace: 'nowrap' }}>{uploadProgress}%</span>
            </div>
          )}

          <div style={{ flex: 1 }} />

          <button
            onClick={() => setMergeWizardOpen(true)}
            style={{
              height: 30, padding: '0 14px', borderRadius: 8,
              border: '1px solid #e8e4f0', background: 'transparent', color: '#484552',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, transition: 'all 150ms',
              fontFamily: 'Hanken Grotesk, sans-serif', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.borderColor = '#c4b8f0'; e.currentTarget.style.color = '#5e4dbb'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#e8e4f0'; e.currentTarget.style.color = '#484552'; }}
          >
            <Icon name="merge" size={14} color="#787584" />
            Merge Routes
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

          {/* ── Left Info Panel ──────────────────────────────────────────────── */}
          <div style={{
            width: 300, flexShrink: 0, borderRight: '1px solid #e8e4f0',
            display: 'flex', flexDirection: 'column', background: '#faf9ff',
            overflowY: 'auto',
          }}>
            {!selectedFile ? (
              /* Empty state */
              <div style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', padding: '32px 24px', textAlign: 'center',
              }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 20, background: '#ede9ff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
                }}>
                  <Icon name="route" size={30} color="#5e4dbb" />
                </div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>
                  {files.length === 0 ? 'No routes yet' : 'Select a route'}
                </div>
                <div style={{ fontSize: 12, color: '#787584', lineHeight: 1.6, fontFamily: 'Inter, sans-serif' }}>
                  {files.length === 0
                    ? 'Upload a .GPX or .FIT file to preview it on the map.'
                    : 'Click a route in the sidebar to see details here.'}
                </div>
              </div>
            ) : (
              /* Route details */
              <div style={{ display: 'flex', flexDirection: 'column' }}>

                {/* Route header */}
                <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 5 }}>
                    <span style={{
                      background: selectedFile.fileType === 'gpx' ? '#ede9ff' : '#ccfbf1',
                      color: selectedFile.fileType === 'gpx' ? '#5e4dbb' : '#0d9488',
                      borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700,
                      fontFamily: 'Hanken Grotesk, sans-serif', letterSpacing: '0.03em',
                      flexShrink: 0, marginTop: 3,
                    }}>{selectedFile.fileType.toUpperCase()}</span>
                    <span style={{
                      fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 700,
                      color: '#1c1b22', lineHeight: 1.3, wordBreak: 'break-all',
                    }}>{selectedFile.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
                    {fmtDate(selectedFile.createdAt)}
                  </div>
                </div>

                {/* Stats grid */}
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {([
                      { label: 'Distance', value: fmtDist(selectedFile.metadata?.totalDistance), icon: 'straighten' },
                      { label: 'Elevation Gain', value: fmtElev(selectedFile.metadata?.totalElevationGain), icon: 'landscape' },
                      ...(selectedFile.metadata?.duration != null ? [{ label: 'Duration', value: fmtDuration(selectedFile.metadata.duration) ?? '—', icon: 'schedule' }] : []),
                      ...(selectedFile.metadata?.pointCount != null ? [{ label: 'Points', value: String(selectedFile.metadata.pointCount), icon: 'pin_drop' }] : []),
                    ] as Array<{ label: string; value: string; icon: string }>).map(stat => (
                      <div key={stat.label} style={{
                        background: '#fff', borderRadius: 8, padding: '10px 12px',
                        border: '1px solid #e8e4f0',
                      }}>
                        <div style={{ fontSize: 10, color: '#b0acbe', fontFamily: 'Inter, sans-serif', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Icon name={stat.icon} size={10} color="#c9c4d5" />
                          {stat.label}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Download original */}
                <div style={{ padding: '10px 16px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
                  <button
                    onClick={downloadOriginal}
                    disabled={downloading}
                    style={{
                      width: '100%', padding: '8px 0', borderRadius: 8,
                      border: '1px solid #E5E7EB', background: 'transparent', color: '#484552',
                      fontSize: 12, fontWeight: 600,
                      cursor: !downloading ? 'pointer' : 'default',
                      transition: 'all 150ms', fontFamily: 'Hanken Grotesk, sans-serif',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                    onMouseEnter={e => { if (!downloading) e.currentTarget.style.background = '#f1ecf6'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="download" size={13} color="#787584" />
                    Download Original
                  </button>
                </div>

                {/* Delete */}
                <div style={{ padding: '12px 16px', flexShrink: 0 }}>
                  {deleteConfirm === 'selected' ? (
                    <div style={{ background: '#fff5f5', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#ba1a1a', marginBottom: 6, fontFamily: 'Hanken Grotesk, sans-serif' }}>
                        Delete this route?
                      </div>
                      <div style={{ fontSize: 11.5, color: '#9e7070', marginBottom: 12, fontFamily: 'Inter, sans-serif' }}>
                        This action cannot be undone.
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 7, border: '1px solid #e8e4f0', background: '#fff', color: '#484552', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}
                        >Cancel</button>
                        <button
                          onClick={handleDeleteSelected}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 7, border: 'none', background: '#ba1a1a', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif' }}
                        >Delete</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm('selected')}
                      style={{
                        width: '100%', padding: '8px 0', borderRadius: 8,
                        border: '1px solid #fca5a5', background: 'transparent', color: '#ba1a1a',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        transition: 'all 150ms', fontFamily: 'Hanken Grotesk, sans-serif',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fff5f5'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <Icon name="delete" size={13} color="#ba1a1a" />
                      Delete Route
                    </button>
                  )}
                </div>

              </div>
            )}
          </div>

          {/* ── Map area ───────────────────────────────────────────────────────── */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#e8e4f0' }}>
            <div ref={mapCallbackRef} style={{ position: 'absolute', inset: 0 }} />

            {/* No-selection overlay */}
            {!selectedId && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', zIndex: 5,
                background: 'rgba(253,248,255,0.72)', backdropFilter: 'blur(4px)',
                pointerEvents: 'none',
              }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 600, color: '#787584' }}>
                  {files.length === 0 ? 'Upload a route to get started' : 'Select a route from the sidebar'}
                </div>
              </div>
            )}

            {/* Track loading overlay */}
            {trackLoading && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(253,248,255,0.65)', backdropFilter: 'blur(4px)', zIndex: 10,
              }}>
                <div style={{ fontSize: 13, color: '#787584', fontFamily: 'Inter, sans-serif' }}>Loading route…</div>
              </div>
            )}

            {/* Multi-metric chart overlay */}
            {selectedId && trackData && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, height: 200,
                zIndex: 10, background: 'rgba(8,5,18,0.72)', backdropFilter: 'blur(6px)',
                animation: 'mapFadeIn 400ms ease both',
              }}>
                <MultiLineMapChart
                  trackData={trackData}
                  hoveredIdx={hoveredIdx}
                  onHover={setHoveredIdx}
                />
              </div>
            )}
          </div>

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
            background: 'rgba(94,77,187,0.10)', backdropFilter: 'blur(3px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
          }}>
            <div style={{ border: '3px dashed #5e4dbb', borderRadius: 24, padding: '48px 72px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, background: 'rgba(253,248,255,0.85)' }}>
              <div style={{ width: 72, height: 72, borderRadius: 22, background: '#ede9ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="upload" size={34} color="#5e4dbb" />
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#5e4dbb' }}>
                Drop to upload route
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#9d8dff' }}>
                .GPX and .FIT files supported
              </div>
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
        {smoothWizardOpen && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(8,5,18,0.45)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
            onClick={e => { if (e.target === e.currentTarget) setSmoothWizardOpen(false); }}
          >
            <div style={{
              background: '#fff', borderRadius: 16, padding: '24px',
              width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
              border: '1px solid #e8e4f0', fontFamily: 'Inter, sans-serif',
            }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 4 }}>
                Smooth Elevation
              </div>
              <div style={{ fontSize: 12, color: '#787584', marginBottom: 20 }}>
                Apply Gaussian smoothing to reduce GPS noise in the elevation profile.
              </div>

              {/* Sigma slider */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    Smoothing Strength
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#5e4dbb', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    σ = {smoothSigma}
                  </span>
                </div>
                <input
                  type="range" min={1} max={30} value={smoothSigma}
                  onChange={e => setSmoothSigma(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#5e4dbb', cursor: 'pointer' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#b0acbe', marginTop: 3 }}>
                  <span>Subtle (1)</span>
                  <span>Heavy (30)</span>
                </div>
              </div>

              {/* Mode cards */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif', marginBottom: 8 }}>
                  Save As
                </div>
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
                        border: `2px solid ${smoothMode === opt.value ? '#5e4dbb' : '#e8e4f0'}`,
                        background: smoothMode === opt.value ? '#F5F3FF' : '#fff',
                        textAlign: 'left', transition: 'all 150ms',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <Icon name={opt.icon} size={14} color={smoothMode === opt.value ? '#5e4dbb' : '#b0acbe'} />
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: smoothMode === opt.value ? '#5e4dbb' : '#484552', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                          {opt.label}
                        </span>
                      </div>
                      <div style={{ fontSize: 10.5, color: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
                        {opt.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Name input (only for new mode) */}
              {smoothMode === 'new' && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#484552', fontFamily: 'Hanken Grotesk, sans-serif', marginBottom: 6 }}>
                    New File Name <span style={{ fontWeight: 400, color: '#b0acbe' }}>(optional)</span>
                  </div>
                  <input
                    type="text"
                    value={smoothName}
                    onChange={e => setSmoothName(e.target.value)}
                    placeholder={`${(selectedFile?.name ?? 'route').replace(/\.(gpx|fit)$/i, '')}_smoothed`}
                    style={{
                      width: '100%', padding: '8px 12px', borderRadius: 8, boxSizing: 'border-box',
                      border: '1px solid #e8e4f0', fontSize: 12, fontFamily: 'Inter, sans-serif',
                      color: '#1c1b22', outline: 'none', background: '#faf9ff',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#e8e4f0'; }}
                  />
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setSmoothWizardOpen(false)}
                  style={{
                    flex: 1, padding: '9px 0', borderRadius: 9,
                    border: '1px solid #e8e4f0', background: '#fff', color: '#484552',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSmoothApply}
                  disabled={smoothSaving}
                  style={{
                    flex: 2, padding: '9px 0', borderRadius: 9,
                    border: 'none', background: smoothSaving ? '#c4b8f0' : '#5e4dbb', color: '#fff',
                    fontSize: 13, fontWeight: 600, cursor: smoothSaving ? 'default' : 'pointer',
                    fontFamily: 'Hanken Grotesk, sans-serif', transition: 'background 150ms',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                  onMouseEnter={e => { if (!smoothSaving) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (!smoothSaving) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  <Icon name="auto_fix_high" size={14} color="#fff" />
                  {smoothSaving ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
