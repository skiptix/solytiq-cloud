import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import type { GpsFile, GpsTrackData, GpsMetricPoint } from '../types';
import {
  apiGetGpsFiles, apiUploadGpsFile, apiGetGpsTrackData,
  apiSmoothGpsElevation, apiDownloadGpsFile, apiDeleteGpsFile,
} from '../api/client';
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
function fmtMetricValue(v: number | null | undefined, metric: string): string {
  if (v == null) return '—';
  if (metric === 'elevation') return `${Math.round(v)} m`;
  if (metric === 'hr') return `${Math.round(v)} bpm`;
  if (metric === 'cadence') return `${Math.round(v)} rpm`;
  if (metric === 'power') return `${Math.round(v)} W`;
  return String(Math.round(v));
}

const METRIC_COLORS: Record<string, string> = {
  elevation: '#5e4dbb',
  hr: '#ef4444',
  cadence: '#10b981',
  power: '#f59e0b',
};

// ─── Gaussian smooth (client-side for preview) ───────────────────────────────
function gaussianPreview(values: number[], sigma: number): number[] {
  if (sigma <= 1) return values;
  const win = Math.ceil(3 * sigma);
  return values.map((_, i) => {
    let wV = 0, wT = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(values.length - 1, i + win); j++) {
      const w = Math.exp(-((j - i) ** 2) / (2 * sigma ** 2));
      wV += values[j] * w; wT += w;
    }
    return wT > 0 ? wV / wT : values[i];
  });
}

// ─── MetricsChart (SVG) ───────────────────────────────────────────────────────
interface MetricsChartProps {
  profile: Array<{ distance: number; elevation?: number; value?: number | null }>;
  smoothedValues?: number[] | null;
  color: string;
  hoveredIdx: number | null;
  onHover: (idx: number | null) => void;
  label: string;
}

function MetricsChart({ profile, smoothedValues, color, hoveredIdx, onHover, label }: MetricsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 130 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const e = entries[0].contentRect;
      setDims({ w: Math.max(100, e.width), h: Math.max(50, e.height) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const PAD = { l: 52, r: 16, t: 12, b: 28 };
  const cw = dims.w - PAD.l - PAD.r;
  const ch = dims.h - PAD.t - PAD.b;

  const values = profile.map(p => p.elevation ?? p.value ?? 0).filter(v => v != null) as number[];
  const maxDist = profile.length > 0 ? profile[profile.length - 1].distance : 1;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const rangeVal = maxVal - minVal || 1;

  const toX = (dist: number) => PAD.l + (dist / maxDist) * cw;
  const toY = (val: number) => PAD.t + (1 - (val - minVal) / rangeVal) * ch;

  const pathD = profile.map((p, i) => {
    const v = p.elevation ?? p.value ?? minVal;
    return `${i === 0 ? 'M' : 'L'}${toX(p.distance).toFixed(1)},${toY(v).toFixed(1)}`;
  }).join(' ');

  const areaD = profile.length > 0 ? [
    `M${toX(profile[0].distance).toFixed(1)},${(PAD.t + ch).toFixed(1)}`,
    pathD.replace(/^M/, 'L'),
    `L${toX(profile[profile.length - 1].distance).toFixed(1)},${(PAD.t + ch).toFixed(1)}Z`,
  ].join(' ') : '';

  const smoothedPathD = smoothedValues
    ? profile.map((p, i) => {
        const v = smoothedValues[i] ?? (p.elevation ?? p.value ?? minVal);
        return `${i === 0 ? 'M' : 'L'}${toX(p.distance).toFixed(1)},${toY(v).toFixed(1)}`;
      }).join(' ')
    : null;

  const hoveredPoint = hoveredIdx != null ? profile[hoveredIdx] : null;
  const hoveredVal = hoveredPoint ? (hoveredPoint.elevation ?? hoveredPoint.value ?? null) : null;
  const hovX = hoveredPoint ? toX(hoveredPoint.distance) : null;

  const xTicks = 5;
  const yTicks = 4;

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || profile.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, (px - PAD.l) / (rect.width - PAD.l - PAD.r)));
    const targetDist = fraction * maxDist;
    let nearest = 0, minDiff = Infinity;
    for (let i = 0; i < profile.length; i++) {
      const diff = Math.abs(profile[i].distance - targetDist);
      if (diff < minDiff) { minDiff = diff; nearest = i; }
    }
    onHover(nearest);
  }, [profile, maxDist, PAD.l, PAD.r, onHover]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg ref={svgRef} width={dims.w} height={dims.h} style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove} onMouseLeave={() => onHover(null)}>
        <defs>
          <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Y grid lines */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const v = minVal + (i / yTicks) * rangeVal;
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={y} x2={PAD.l + cw} y2={y}
                stroke="#e8e4f0" strokeWidth={0.8} strokeDasharray={i === 0 ? '0' : '3,3'} />
              <text x={PAD.l - 6} y={y + 4} textAnchor="end"
                style={{ fontSize: 9, fill: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        {/* X tick labels */}
        {Array.from({ length: xTicks + 1 }, (_, i) => {
          const dist = (i / xTicks) * maxDist;
          const x = toX(dist);
          return (
            <text key={i} x={x} y={dims.h - 6} textAnchor="middle"
              style={{ fontSize: 9, fill: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
              {dist >= 1000 ? `${(dist / 1000).toFixed(1)}k` : Math.round(dist)}
            </text>
          );
        })}
        {/* Area fill */}
        {areaD && <path d={areaD} fill={`url(#grad-${label})`} />}
        {/* Original line */}
        {pathD && <path d={pathD} fill="none" stroke={smoothedValues ? `${color}60` : color} strokeWidth={smoothedValues ? 1.5 : 2} />}
        {/* Smoothed overlay */}
        {smoothedPathD && <path d={smoothedPathD} fill="none" stroke={color} strokeWidth={2} />}
        {/* Hover vertical line */}
        {hovX != null && (
          <line x1={hovX} y1={PAD.t} x2={hovX} y2={PAD.t + ch} stroke={color} strokeWidth={1.5} strokeDasharray="4,3" opacity={0.7} />
        )}
        {/* Hover dot */}
        {hovX != null && hoveredVal != null && (
          <circle cx={hovX} cy={toY(hoveredVal)} r={4} fill={color} stroke="#fff" strokeWidth={2} />
        )}
      </svg>
      {/* Tooltip */}
      {hovX != null && hoveredPoint && hoveredVal != null && (
        <div style={{
          position: 'absolute', top: PAD.t - 2, left: hovX + 10,
          background: '#fff', border: '1px solid #e8e4f0', borderRadius: 7,
          padding: '4px 8px', pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 10,
          fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#484552',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ fontWeight: 600, color }}>{fmtMetricValue(hoveredVal, label)}</span>
          <span style={{ color: '#b0acbe', marginLeft: 6 }}>{fmtDist(hoveredPoint.distance)}</span>
        </div>
      )}
    </div>
  );
}

// ─── FileCard ─────────────────────────────────────────────────────────────────
interface FileCardProps {
  file: GpsFile;
  selected: boolean;
  checked: boolean;
  combineMode: boolean;
  onSelect: () => void;
  onCheck: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}
function FileCard({ file, selected, checked, combineMode, onSelect, onCheck, onDelete }: FileCardProps) {
  const [hov, setHov] = useState(false);
  const m = file.metadata;
  return (
    <div
      onClick={combineMode ? onCheck : onSelect}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: selected ? '#F5F3FF' : hov ? '#faf9ff' : '#fff',
        border: `1px solid ${selected ? '#c4b8f0' : '#E5E7EB'}`,
        borderLeft: `3px solid ${selected ? '#5e4dbb' : 'transparent'}`,
        borderRadius: 10, padding: '10px 12px', marginBottom: 6,
        cursor: 'pointer', transition: 'all 150ms', position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        {combineMode && (
          <div
            onClick={onCheck}
            style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              border: `1.5px solid ${checked ? '#5e4dbb' : '#c9c4d5'}`,
              background: checked ? '#5e4dbb' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 120ms',
            }}
          >
            {checked && <Icon name="check" size={10} color="#fff" />}
          </div>
        )}
        <span style={{
          background: file.fileType === 'gpx' ? '#ede9ff' : '#ccfbf1',
          color: file.fileType === 'gpx' ? '#5e4dbb' : '#0d9488',
          borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700,
          fontFamily: 'Hanken Grotesk, sans-serif', letterSpacing: '0.02em',
        }}>{file.fileType.toUpperCase()}</span>
        <button
          onClick={onDelete}
          title="Delete"
          style={{
            marginLeft: 'auto', width: 22, height: 22, borderRadius: '50%',
            border: 'none', background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hov ? 1 : 0, transition: 'opacity 150ms',
          }}
          onMouseEnter={e => { (e.currentTarget.style.background = '#fff5f5'); }}
          onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); }}
        >
          <Icon name="delete" size={13} color="#ba1a1a" />
        </button>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: '#1c1b22', fontFamily: 'Inter, sans-serif', lineHeight: 1.4, wordBreak: 'break-all' }}>
        {file.name}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
        {m?.totalDistance != null && (
          <span style={{ fontSize: 10.5, color: '#787584', fontFamily: 'Inter, sans-serif' }}>
            {fmtDist(m.totalDistance)}
          </span>
        )}
        {m?.totalElevationGain != null && (
          <span style={{ fontSize: 10.5, color: '#787584', fontFamily: 'Inter, sans-serif' }}>
            ↑{fmtElev(m.totalElevationGain)}
          </span>
        )}
        {m?.duration != null && (
          <span style={{ fontSize: 10.5, color: '#787584', fontFamily: 'Inter, sans-serif' }}>
            {fmtDuration(m.duration)}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: '#b0acbe', fontFamily: 'Inter, sans-serif', marginTop: 4 }}>
        {fmtDate(file.createdAt)}
      </div>
    </div>
  );
}

// ─── GPSScreen ────────────────────────────────────────────────────────────────
export default function GPSScreen() {
  const navigate = useNavigate();
  const location = useLocation();

  const [files, setFiles] = useState<GpsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trackData, setTrackData] = useState<GpsTrackData | null>(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [activeMetric, setActiveMetric] = useState<'elevation' | 'hr' | 'cadence' | 'power'>('elevation');
  const [sigma, setSigma] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [mergeWizardOpen, setMergeWizardOpen] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const cursorMarkerRef = useRef<L.CircleMarker | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load files on mount
  useEffect(() => {
    apiGetGpsFiles()
      .then(data => { setFiles(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // ── Init Leaflet via callback ref (handles lazy-mount inside conditional JSX)
  const mapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    mapContainerRef.current = node;
    if (node && !leafletRef.current) {
      const map = L.map(node, { zoomControl: true }).setView([47, 10], 5);
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> contributors',
        maxZoom: 17,
      }).addTo(map);
      leafletRef.current = map;
      setTimeout(() => map.invalidateSize(), 150);
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

  // ── Sync from URL param (handles sidebar clicks + direct links)
  useEffect(() => {
    const fileId = new URLSearchParams(location.search).get('file');
    if (fileId && fileId !== selectedIdRef.current) {
      selectFile(fileId);
    } else if (!fileId && selectedIdRef.current) {
      selectedIdRef.current = null;
      setSelectedId(null);
      setTrackData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // ── Sidebar upload button trigger
  useEffect(() => {
    const handler = () => fileInputRef.current?.click();
    window.addEventListener('gps-upload-trigger', handler);
    return () => window.removeEventListener('gps-upload-trigger', handler);
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
    navigate(`/gps?file=${id}`, { replace: true });
    setTrackData(null);
    setTrackLoading(true);
    setHoveredIdx(null);
    setActiveMetric('elevation');
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

  async function downloadSmoothed() {
    if (!selectedId || downloading) return;
    setDownloading(true);
    try {
      const blob = await apiSmoothGpsElevation(selectedId, sigma);
      const sel = files.find(f => f.id === selectedId);
      const base = sel ? sel.name.replace(/\.(gpx|fit)$/i, '') : 'route';
      triggerDownload(blob, `${base}_smoothed_s${sigma}.gpx`);
    } catch (err) { console.error(err); }
    setDownloading(false);
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

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    await apiDeleteGpsFile(id);
    setFiles(prev => prev.filter(f => f.id !== id));
    window.dispatchEvent(new CustomEvent('gps-files-changed'));
    if (selectedId === id) {
      selectedIdRef.current = null;
      setSelectedId(null); setTrackData(null);
      navigate('/gps', { replace: true });
      polylineRef.current?.remove(); polylineRef.current = null;
      startMarkerRef.current?.remove(); startMarkerRef.current = null;
      endMarkerRef.current?.remove(); endMarkerRef.current = null;
    }
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Smooth preview for chart overlay (client-side, instant)
  const smoothedElevValues = useMemo(() => {
    if (!trackData || sigma <= 1) return null;
    const raw = trackData.elevationProfile.map(p => p.elevation);
    return gaussianPreview(raw, sigma);
  }, [trackData, sigma]);

  const activeProfile: Array<{ distance: number; value: number | null }> | null = useMemo(() => {
    if (!trackData) return null;
    if (activeMetric === 'elevation') return trackData.elevationProfile.map(p => ({ distance: p.distance, value: p.elevation }));
    const src: (typeof trackData.hrProfile) = activeMetric === 'hr' ? trackData.hrProfile : activeMetric === 'cadence' ? trackData.cadenceProfile : trackData.powerProfile;
    return src?.map((p: GpsMetricPoint) => ({ distance: p.distance, value: p.value })) ?? null;
  }, [trackData, activeMetric]);

  const selectedFile = files.find(f => f.id === selectedId) ?? null;

  const metricTabs: Array<{ key: 'elevation' | 'hr' | 'cadence' | 'power'; label: string; icon: string }> = [
    { key: 'elevation', label: 'Elevation', icon: 'landscape' },
    ...(trackData?.metricsAvailable.hr ? [{ key: 'hr' as const, label: 'Heart Rate', icon: 'favorite' }] : []),
    ...(trackData?.metricsAvailable.cadence ? [{ key: 'cadence' as const, label: 'Cadence', icon: 'rotate_right' }] : []),
    ...(trackData?.metricsAvailable.power ? [{ key: 'power' as const, label: 'Power', icon: 'bolt' }] : []),
  ];

  return (
    <div
      style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: 'Inter, sans-serif' }}
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { e.preventDefault(); setIsDragOver(false); handleUpload(e.dataTransfer.files); }}
    >
      {/* ── Left Panel ─────────────────────────────────────────────────────── */}
      <div style={{
        width: 272, flexShrink: 0, borderRight: '1px solid #e8e4f0',
        display: 'flex', flexDirection: 'column', background: '#f7f2fc', overflowY: 'hidden',
      }}>
        {/* Panel header */}
        <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #e8e4f0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>
              GPS Routes
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setMergeWizardOpen(true)}
                title="Merge routes"
                style={{
                  height: 28, padding: '0 10px', borderRadius: 7,
                  border: '1px solid #e8e4f0', background: 'transparent', color: '#484552',
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4, transition: 'all 150ms',
                  fontFamily: 'Hanken Grotesk, sans-serif',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#F5F3FF'; e.currentTarget.style.borderColor = '#c4b8f0'; e.currentTarget.style.color = '#5e4dbb'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#e8e4f0'; e.currentTarget.style.color = '#484552'; }}
              >
                <Icon name="merge" size={13} color="#787584" />
                Merge
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Upload GPS file"
                style={{
                  height: 28, padding: '0 10px', borderRadius: 7,
                  border: 'none', background: '#5e4dbb', color: '#fff',
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4, transition: 'background 150ms',
                  fontFamily: 'Hanken Grotesk, sans-serif',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#4d3da8'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; }}
              >
                <Icon name="upload" size={13} color="#fff" />
                Upload
              </button>
            </div>
          </div>
          {/* Upload progress */}
          {uploading && (
            <div style={{ height: 4, borderRadius: 4, background: '#ede9ff', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${uploadProgress}%`, background: '#5e4dbb', borderRadius: 4, transition: 'width 200ms' }} />
            </div>
          )}
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 4px' }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#b0acbe', fontSize: 13 }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: '#b0acbe', fontSize: 12 }}>
              <Icon name="route" size={28} color="#c9c4d5" />
              <div style={{ marginTop: 8 }}>No routes yet</div>
            </div>
          ) : files.map(f => (
            <FileCard
              key={f.id}
              file={f}
              selected={selectedId === f.id}
              checked={false}
              combineMode={false}
              onSelect={() => selectFile(f.id)}
              onCheck={() => {}}
              onDelete={e => handleDelete(f.id, e)}
            />
          ))}
        </div>

      </div>

      {/* ── Main Area ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fdf8ff', position: 'relative' }}>

        {/* Drag overlay */}
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(94,77,187,0.09)', border: '2px dashed #5e4dbb',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
            pointerEvents: 'none',
          }}>
            <div style={{ width: 60, height: 60, borderRadius: 18, background: '#ede9ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="upload" size={28} color="#5e4dbb" />
            </div>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#5e4dbb' }}>
              Drop GPX or FIT file here
            </span>
          </div>
        )}

        {!selectedId ? (
          /* ── Empty state ─────────────────────────────────────────────────── */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 32, textAlign: 'center',
          }}>
            <div style={{
              width: 88, height: 88, borderRadius: 28, background: '#ede9ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24,
            }}>
              <Icon name="route" size={40} color="#5e4dbb" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', marginBottom: 10 }}>
              {files.length === 0 ? 'Upload your first route' : 'Select a route to view'}
            </div>
            <div style={{ fontSize: 14, color: '#787584', maxWidth: 300, lineHeight: 1.6, marginBottom: 24 }}>
              {files.length === 0
                ? 'Upload a .GPX or .FIT file to preview it on the map, inspect elevation, and clean up GPS data.'
                : 'Click a file in the library to see it on the map with elevation profile and tools.'}
            </div>
            {files.length === 0 && (
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '10px 24px', borderRadius: 10, border: 'none', background: '#5e4dbb', color: '#fff',
                  fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'background 150ms',
                  fontFamily: 'Hanken Grotesk, sans-serif', display: 'flex', alignItems: 'center', gap: 8,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#4d3da8'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#5e4dbb'; }}
              >
                <Icon name="upload" size={16} color="#fff" />
                Browse files
              </button>
            )}
            <div style={{ marginTop: 16, fontSize: 12, color: '#c9c4d5' }}>
              Supports .GPX and .FIT formats
            </div>
          </div>
        ) : (
          <>
            {/* ── File info strip ────────────────────────────────────────────── */}
            {selectedFile && (
              <div style={{
                padding: '9px 20px', borderBottom: '1px solid #e8e4f0',
                display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
                background: 'rgba(253,248,255,0.95)', backdropFilter: 'blur(8px)',
              }}>
                <span style={{
                  background: selectedFile.fileType === 'gpx' ? '#ede9ff' : '#ccfbf1',
                  color: selectedFile.fileType === 'gpx' ? '#5e4dbb' : '#0d9488',
                  borderRadius: 5, padding: '2px 8px', fontSize: 10.5, fontWeight: 700,
                  fontFamily: 'Hanken Grotesk, sans-serif',
                }}>{selectedFile.fileType.toUpperCase()}</span>
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>
                  {selectedFile.name}
                </span>
                {selectedFile.metadata?.totalDistance != null && (
                  <span style={{ fontSize: 12, color: '#787584' }}>
                    <span style={{ color: '#c9c4d5', marginRight: 4 }}>dist</span>
                    {fmtDist(selectedFile.metadata.totalDistance)}
                  </span>
                )}
                {selectedFile.metadata?.totalElevationGain != null && (
                  <span style={{ fontSize: 12, color: '#787584' }}>
                    <span style={{ color: '#c9c4d5', marginRight: 4 }}>↑</span>
                    {fmtElev(selectedFile.metadata.totalElevationGain)}
                  </span>
                )}
                {selectedFile.metadata?.duration != null && (
                  <span style={{ fontSize: 12, color: '#787584' }}>
                    <span style={{ color: '#c9c4d5', marginRight: 4 }}>time</span>
                    {fmtDuration(selectedFile.metadata.duration)}
                  </span>
                )}
              </div>
            )}

            {/* ── Map ──────────────────────────────────────────────────────────── */}
            <div style={{ flex: '0 0 52%', position: 'relative', background: '#e8e4f0', overflow: 'hidden' }}>
              <div ref={mapCallbackRef} style={{ position: 'absolute', inset: 0 }} />
              {trackLoading && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(253,248,255,0.7)', backdropFilter: 'blur(4px)', zIndex: 10,
                }}>
                  <div style={{ fontSize: 13, color: '#787584', fontFamily: 'Inter, sans-serif' }}>Loading route…</div>
                </div>
              )}
            </div>

            {/* ── Bottom: Chart + Tools ────────────────────────────────────────── */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTop: '1px solid #e8e4f0' }}>

              {/* Metric tabs */}
              {trackData && metricTabs.length > 1 && (
                <div style={{
                  display: 'flex', gap: 2, padding: '6px 16px 0', flexShrink: 0,
                  borderBottom: '1px solid #e8e4f0', background: '#faf9ff',
                }}>
                  {metricTabs.map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveMetric(tab.key)}
                      style={{
                        padding: '5px 12px 7px', borderRadius: '6px 6px 0 0',
                        border: `1px solid ${activeMetric === tab.key ? '#e8e4f0' : 'transparent'}`,
                        borderBottom: activeMetric === tab.key ? '1px solid #faf9ff' : '1px solid transparent',
                        background: activeMetric === tab.key ? '#faf9ff' : 'transparent',
                        color: activeMetric === tab.key ? METRIC_COLORS[tab.key] : '#787584',
                        fontSize: 11.5, fontWeight: activeMetric === tab.key ? 600 : 500,
                        cursor: 'pointer', transition: 'all 150ms',
                        fontFamily: 'Inter, sans-serif', display: 'flex', alignItems: 'center', gap: 5,
                        marginBottom: activeMetric === tab.key ? -1 : 0,
                      }}
                    >
                      <Icon name={tab.icon} size={12} color={activeMetric === tab.key ? METRIC_COLORS[tab.key] : '#b0acbe'} />
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Chart */}
              <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0 0' }}>
                {trackData && activeProfile ? (
                  <MetricsChart
                    profile={activeProfile.map((p, i) => ({ distance: p.distance, elevation: activeMetric === 'elevation' ? (p.value ?? 0) : undefined, value: activeMetric !== 'elevation' ? p.value : undefined, idx: i }))}
                    smoothedValues={activeMetric === 'elevation' ? smoothedElevValues : null}
                    color={METRIC_COLORS[activeMetric]}
                    hoveredIdx={hoveredIdx}
                    onHover={setHoveredIdx}
                    label={activeMetric}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#c9c4d5', fontSize: 12 }}>
                    {trackLoading ? 'Loading…' : 'No chart data'}
                  </div>
                )}
              </div>

              {/* Tools bar */}
              <div style={{
                padding: '8px 16px', borderTop: '1px solid #e8e4f0', flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: 14, background: '#faf9ff', flexWrap: 'wrap',
              }}>
                {/* Smooth control */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, color: '#787584', fontFamily: 'Inter, sans-serif', whiteSpace: 'nowrap' }}>
                    <Icon name="auto_fix" size={12} color="#787584" /> Smooth σ
                  </span>
                  <input
                    type="range" min={1} max={30} value={sigma}
                    onChange={e => setSigma(Number(e.target.value))}
                    style={{ width: 90, accentColor: '#5e4dbb', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 11, color: '#5e4dbb', fontWeight: 600, fontFamily: 'Inter, sans-serif', minWidth: 18 }}>{sigma}</span>
                </div>

                <div style={{ width: 1, height: 18, background: '#e8e4f0', flexShrink: 0 }} />

                <button
                  onClick={downloadSmoothed}
                  disabled={!trackData || downloading}
                  style={{
                    padding: '5px 12px', borderRadius: 7, border: '1px solid #c4b8f0',
                    background: '#F5F3FF', color: '#5e4dbb', fontSize: 11.5, fontWeight: 600,
                    cursor: trackData && !downloading ? 'pointer' : 'default',
                    transition: 'all 150ms', fontFamily: 'Hanken Grotesk, sans-serif',
                    opacity: trackData && !downloading ? 1 : 0.5,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                  onMouseEnter={e => { if (trackData && !downloading) { e.currentTarget.style.background = '#ede9ff'; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#F5F3FF'; }}
                >
                  <Icon name="download" size={13} color="#5e4dbb" />
                  Smoothed GPX
                </button>

                <button
                  onClick={downloadOriginal}
                  disabled={!selectedId || downloading}
                  style={{
                    padding: '5px 12px', borderRadius: 7, border: '1px solid #E5E7EB',
                    background: 'transparent', color: '#484552', fontSize: 11.5, fontWeight: 600,
                    cursor: selectedId && !downloading ? 'pointer' : 'default',
                    transition: 'all 150ms', fontFamily: 'Hanken Grotesk, sans-serif',
                    opacity: selectedId && !downloading ? 1 : 0.5,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                  onMouseEnter={e => { if (selectedId && !downloading) e.currentTarget.style.background = '#f1ecf6'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name="download" size={13} color="#787584" />
                  Original
                </button>

                {/* Smooth hint */}
                {sigma > 1 && trackData && (
                  <span style={{ fontSize: 10.5, color: '#10b981', fontFamily: 'Inter, sans-serif', marginLeft: 'auto' }}>
                    ✓ Preview shows smoothed overlay
                  </span>
                )}
              </div>
            </div>
          </>
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

      {/* Merge wizard */}
      {mergeWizardOpen && (
        <GPSMergeWizard
          files={files}
          onClose={() => setMergeWizardOpen(false)}
          onMerged={file => { setFiles(prev => [file, ...prev]); setMergeWizardOpen(false); }}
        />
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div
          onClick={() => setDeleteConfirm(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 14, padding: '24px 28px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.14)', maxWidth: 320,
              animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both',
            }}
          >
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>
              Delete file?
            </div>
            <div style={{ fontSize: 13, color: '#787584', marginBottom: 20 }}>
              "{files.find(f => f.id === deleteConfirm)?.name}" will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDeleteConfirm(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #E5E7EB', background: 'transparent', color: '#484552', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
              >Cancel</button>
              <button
                onClick={e => handleDelete(deleteConfirm, e as React.MouseEvent)}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#ba1a1a', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
