import { useState, useEffect, useRef, useCallback } from 'react';
import type { GpsFile, GapMode } from '../types';
import { apiUploadGpsFile, apiMergeGpsFilesDownload, apiMergeGpsFilesSave } from '../api/client';
import Icon from './Icon';

function fmtDist(m?: number | null) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

interface Props {
  files: GpsFile[];
  onClose: () => void;
  onMerged: (file: GpsFile) => void;
}

export default function GPSMergeWizard({ files: libraryFiles, onClose, onMerged }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [allFiles, setAllFiles] = useState<GpsFile[]>(libraryFiles);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [gapModes, setGapModes] = useState<GapMode[]>([]);
  const [outputName, setOutputName] = useState('merged_route');
  const [merging, setMerging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragSrcIdx = useRef<number | null>(null);

  useEffect(() => {
    setAllFiles(prev => {
      const existing = new Set(libraryFiles.map(f => f.id));
      const fresh = prev.filter(f => !existing.has(f.id));
      return [...libraryFiles, ...fresh];
    });
  }, [libraryFiles]);

  useEffect(() => {
    const needed = Math.max(0, selectedIds.length - 1);
    setGapModes(prev => {
      const next = prev.slice(0, needed);
      while (next.length < needed) next.push('skip');
      return next;
    });
  }, [selectedIds.length]);

  const selectedFiles = selectedIds.map(id => allFiles.find(f => f.id === id)).filter(Boolean) as GpsFile[];
  const totalDist = selectedFiles.reduce((s, f) => s + (f.metadata?.totalDistance ?? 0), 0);
  const totalElev = selectedFiles.reduce((s, f) => s + (f.metadata?.totalElevationGain ?? 0), 0);

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setSelectedIds(prev => { const a = [...prev]; [a[index - 1], a[index]] = [a[index], a[index - 1]]; return a; });
  }

  function moveDown(index: number) {
    setSelectedIds(prev => {
      if (index >= prev.length - 1) return prev;
      const a = [...prev]; [a[index], a[index + 1]] = [a[index + 1], a[index]]; return a;
    });
  }

  const handleDragStart = useCallback((idx: number, e: React.DragEvent) => {
    dragSrcIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((idx: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIdx(idx);
  }, []);

  const handleDrop = useCallback((toIdx: number) => {
    const fromIdx = dragSrcIdx.current;
    if (fromIdx == null || fromIdx === toIdx) { setDragOverIdx(null); return; }
    setSelectedIds(prev => {
      const a = [...prev];
      const [item] = a.splice(fromIdx, 1);
      a.splice(toIdx, 0, item);
      return a;
    });
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  }, []);

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < Math.min(fileList.length, 5 - selectedIds.length); i++) {
        const uploaded = await apiUploadGpsFile(fileList[i], () => {});
        setAllFiles(prev => [uploaded, ...prev]);
        setSelectedIds(prev => prev.length < 5 ? [...prev, uploaded.id] : prev);
        window.dispatchEvent(new CustomEvent('gps-files-changed'));
      }
    } catch (err) { console.error('Wizard upload:', err); }
    setUploading(false);
  }

  async function handleMerge(saveToLibrary: boolean) {
    if (selectedIds.length < 2 || merging) return;
    setMerging(true);
    try {
      if (saveToLibrary) {
        const file = await apiMergeGpsFilesSave(selectedIds, outputName, gapModes);
        onMerged(file);
        window.dispatchEvent(new CustomEvent('gps-files-changed'));
      } else {
        const blob = await apiMergeGpsFilesDownload(selectedIds, outputName, gapModes);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${outputName}.gpx`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        onClose();
      }
    } catch (err) { console.error('Merge error:', err); }
    setMerging(false);
  }

  const canAdvance = step === 1 ? selectedIds.length >= 2 : step === 2;

  // ── Step headers
  const STEPS = ['Add Routes', 'Connect Routes', 'Save'];

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 18, width: 560, maxWidth: '95vw', maxHeight: '90vh',
          display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
          animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f0ecff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22' }}>
              Merge Routes
            </div>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="close" size={18} color="#787584" />
            </button>
          </div>
          {/* Step indicator */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {STEPS.map((label, i) => {
              const n = i + 1;
              const active = step === n;
              const done = step > n;
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: done ? '#5e4dbb' : active ? '#ede9ff' : '#f5f3ff',
                      border: `2px solid ${done ? '#5e4dbb' : active ? '#5e4dbb' : '#e8e4f0'}`,
                      fontSize: 11, fontWeight: 700, color: done ? '#fff' : active ? '#5e4dbb' : '#b0acbe',
                      flexShrink: 0,
                    }}>
                      {done ? '✓' : n}
                    </div>
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: active ? 600 : 400, color: active ? '#5e4dbb' : done ? '#484552' : '#b0acbe', whiteSpace: 'nowrap' }}>
                      {label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div style={{ width: 24, height: 1, background: done ? '#5e4dbb' : '#e8e4f0', flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* ── Step 1: Add Routes ─────────────────────────────────────────── */}
          {step === 1 && (
            <div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22', marginBottom: 4 }}>
                  Select routes from your library
                </div>
                <div style={{ fontSize: 12, color: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
                  Choose 2–5 routes to merge. Use drag or the arrows to set the order.
                </div>
              </div>

              {/* Library list */}
              <div style={{ border: '1px solid #e8e4f0', borderRadius: 10, overflow: 'hidden', maxHeight: 220, overflowY: 'auto', marginBottom: 14 }}>
                {allFiles.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center', color: '#b0acbe', fontSize: 12, fontFamily: 'Inter, sans-serif' }}>
                    No routes yet. Upload files below.
                  </div>
                )}
                {allFiles.map(file => {
                  const checked = selectedIds.includes(file.id);
                  const disabled = !checked && selectedIds.length >= 5;
                  return (
                    <div
                      key={file.id}
                      onClick={() => !disabled && toggleSelect(file.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                        borderBottom: '1px solid #f5f3ff', cursor: disabled ? 'default' : 'pointer',
                        background: checked ? '#faf9ff' : 'transparent',
                        opacity: disabled ? 0.45 : 1, transition: 'background 120ms',
                      }}
                      onMouseEnter={e => { if (!disabled && !checked) e.currentTarget.style.background = '#faf8ff'; }}
                      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Checkbox */}
                      <div style={{
                        width: 17, height: 17, borderRadius: 5, flexShrink: 0,
                        border: `1.5px solid ${checked ? '#5e4dbb' : '#c9c4d5'}`,
                        background: checked ? '#5e4dbb' : '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {checked && <Icon name="check" size={11} color="#fff" />}
                      </div>
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? '#ede9fe' : '#ccfbf1', color: file.fileType === 'gpx' ? '#5e4dbb' : '#0d9488', letterSpacing: '0.04em', flexShrink: 0 }}>
                        {file.fileType.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#1c1b22', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                        {file.name.replace(/\.(gpx|fit)$/i, '')}
                      </span>
                      {file.metadata?.totalDistance != null && (
                        <span style={{ fontSize: 11, color: '#b0acbe', fontFamily: 'Inter, sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {fmtDist(file.metadata.totalDistance)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Upload new */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || selectedIds.length >= 5}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px',
                  borderRadius: 8, border: '1.5px dashed #c4b8f0', background: 'transparent',
                  color: '#5e4dbb', fontSize: 12.5, fontWeight: 600, cursor: selectedIds.length < 5 ? 'pointer' : 'default',
                  fontFamily: 'Hanken Grotesk, sans-serif', opacity: selectedIds.length >= 5 ? 0.4 : 1,
                  transition: 'all 150ms', marginBottom: selectedIds.length > 0 ? 16 : 0,
                }}
                onMouseEnter={e => { if (selectedIds.length < 5) e.currentTarget.style.background = '#faf9ff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <Icon name="upload" size={14} color="#5e4dbb" />
                {uploading ? 'Uploading…' : 'Upload new .GPX or .FIT'}
              </button>
              <input ref={fileInputRef} type="file" accept=".gpx,.fit" style={{ display: 'none' }} multiple onChange={e => handleUpload(e.target.files)} />

              {/* Selected order */}
              {selectedIds.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Merge order ({selectedIds.length}/5)
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {selectedFiles.map((file, idx) => (
                      <div
                        key={file.id}
                        draggable
                        onDragStart={e => handleDragStart(idx, e)}
                        onDragOver={e => handleDragOver(idx, e)}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={() => handleDrop(idx)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                          borderRadius: 8, background: dragOverIdx === idx ? '#ede9ff' : '#f7f4ff',
                          border: `1.5px solid ${dragOverIdx === idx ? '#5e4dbb' : '#e8e4f0'}`,
                          cursor: 'grab', transition: 'all 120ms',
                        }}
                      >
                        <Icon name="drag_indicator" size={16} color="#c4b8f0" />
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 700, color: '#b0acbe', minWidth: 16 }}>
                          {idx + 1}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? '#ede9fe' : '#ccfbf1', color: file.fileType === 'gpx' ? '#5e4dbb' : '#0d9488', letterSpacing: '0.04em' }}>
                          {file.fileType.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 500, color: '#1c1b22', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                          {file.name.replace(/\.(gpx|fit)$/i, '')}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <button onClick={() => moveUp(idx)} disabled={idx === 0} style={{ width: 20, height: 16, border: 'none', background: 'transparent', cursor: idx === 0 ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: idx === 0 ? 0.25 : 1 }}>
                            <Icon name="keyboard_arrow_up" size={14} color="#787584" />
                          </button>
                          <button onClick={() => moveDown(idx)} disabled={idx === selectedIds.length - 1} style={{ width: 20, height: 16, border: 'none', background: 'transparent', cursor: idx === selectedIds.length - 1 ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: idx === selectedIds.length - 1 ? 0.25 : 1 }}>
                            <Icon name="keyboard_arrow_down" size={14} color="#787584" />
                          </button>
                        </div>
                        <button onClick={() => setSelectedIds(prev => prev.filter(x => x !== file.id))} style={{ width: 20, height: 20, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, flexShrink: 0 }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <Icon name="close" size={13} color="#b0acbe" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Connect Routes ─────────────────────────────────────── */}
          {step === 2 && (
            <div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22', marginBottom: 4 }}>
                  Handle gaps between routes
                </div>
                <div style={{ fontSize: 12, color: '#b0acbe', fontFamily: 'Inter, sans-serif', lineHeight: 1.6 }}>
                  Choose how each pair of consecutive routes is connected. A gap occurs when the end of one route doesn't match the start of the next.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selectedFiles.map((file, idx) => (
                  <div key={file.id}>
                    {/* Route block */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#faf9ff', borderRadius: 8, border: '1px solid #e8e4f0' }}>
                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{idx + 1}</span>
                      </div>
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? '#ede9fe' : '#ccfbf1', color: file.fileType === 'gpx' ? '#5e4dbb' : '#0d9488', letterSpacing: '0.04em' }}>
                        {file.fileType.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#1c1b22', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Hanken Grotesk, sans-serif' }}>
                        {file.name.replace(/\.(gpx|fit)$/i, '')}
                      </span>
                      {file.metadata?.totalDistance != null && (
                        <span style={{ fontSize: 11, color: '#b0acbe', fontFamily: 'Inter, sans-serif', flexShrink: 0 }}>
                          {fmtDist(file.metadata.totalDistance)}
                        </span>
                      )}
                    </div>

                    {/* Gap connector (between consecutive routes) */}
                    {idx < selectedFiles.length - 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: '#c4b8f0' }}>
                          <Icon name="arrow_downward" size={16} color="#c4b8f0" />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: '#b0acbe', fontFamily: 'Inter, sans-serif', marginBottom: 5 }}>
                            Gap between route {idx + 1} and {idx + 2}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {(['skip', 'straight'] as GapMode[]).map(mode => (
                              <button
                                key={mode}
                                onClick={() => setGapModes(prev => { const a = [...prev]; a[idx] = mode; return a; })}
                                style={{
                                  padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                                  border: `1.5px solid ${gapModes[idx] === mode ? '#5e4dbb' : '#e8e4f0'}`,
                                  background: gapModes[idx] === mode ? '#ede9ff' : 'transparent',
                                  color: gapModes[idx] === mode ? '#5e4dbb' : '#787584',
                                  fontSize: 12, fontWeight: gapModes[idx] === mode ? 600 : 400,
                                  fontFamily: 'Inter, sans-serif', transition: 'all 120ms',
                                  display: 'flex', alignItems: 'center', gap: 5,
                                }}
                              >
                                <Icon name={mode === 'skip' ? 'remove' : 'timeline'} size={12} color={gapModes[idx] === mode ? '#5e4dbb' : '#b0acbe'} />
                                {mode === 'skip' ? 'Skip gap' : 'Straight line'}
                              </button>
                            ))}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 10.5, color: '#c9c4d5', fontFamily: 'Inter, sans-serif', lineHeight: 1.5 }}>
                            {gapModes[idx] === 'skip'
                              ? 'Routes are joined directly at the cut point.'
                              : 'A straight-line segment bridges the gap on the map.'}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 3: Save ──────────────────────────────────────────────── */}
          {step === 3 && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#1c1b22', marginBottom: 4 }}>
                  Name your merged route
                </div>
                <div style={{ fontSize: 12, color: '#b0acbe', fontFamily: 'Inter, sans-serif' }}>
                  Choose a name and save to your library or just download.
                </div>
              </div>

              <input
                value={outputName}
                onChange={e => setOutputName(e.target.value)}
                placeholder="Route name…"
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '10px 14px',
                  border: '1.5px solid #c4b8f0', borderRadius: 10, fontSize: 14,
                  fontFamily: 'Hanken Grotesk, sans-serif', color: '#1c1b22',
                  outline: 'none', background: '#faf9ff', marginBottom: 20,
                  transition: 'border-color 200ms',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = '#5e4dbb'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#c4b8f0'; }}
              />

              {/* Summary */}
              <div style={{ background: '#f7f4ff', borderRadius: 12, padding: '14px 16px', display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: '#b0acbe', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Routes</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#5e4dbb', fontFamily: 'Hanken Grotesk, sans-serif' }}>{selectedIds.length}</div>
                </div>
                {totalDist > 0 && (
                  <div>
                    <div style={{ fontSize: 10.5, color: '#b0acbe', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Total distance</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>{fmtDist(totalDist)}</div>
                  </div>
                )}
                {totalElev > 0 && (
                  <div>
                    <div style={{ fontSize: 10.5, color: '#b0acbe', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Elevation gain</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>↑{Math.round(totalElev)} m</div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 10.5, color: '#b0acbe', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Format</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#1c1b22', fontFamily: 'Hanken Grotesk, sans-serif' }}>GPX</div>
                </div>
              </div>

              {/* Gap summary */}
              {gapModes.some(m => m === 'straight') && (
                <div style={{ fontSize: 11.5, color: '#10b981', fontFamily: 'Inter, sans-serif', display: 'flex', alignItems: 'center', gap: 5, padding: '6px 0' }}>
                  <Icon name="timeline" size={13} color="#10b981" />
                  {gapModes.filter(m => m === 'straight').length} straight-line connector{gapModes.filter(m => m === 'straight').length > 1 ? 's' : ''} will be added.
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #f0ecff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fdfcff', flexShrink: 0 }}>
          <button
            onClick={() => { if (step === 1) onClose(); else setStep(s => (s - 1) as 1 | 2 | 3); }}
            style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid #e8e4f0', background: 'transparent', color: '#484552', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', transition: 'all 150ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {step === 1 ? 'Cancel' : '← Back'}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            {step < 3 ? (
              <button
                onClick={() => canAdvance && setStep(s => (s + 1) as 2 | 3)}
                disabled={!canAdvance}
                style={{
                  padding: '9px 22px', borderRadius: 9, border: 'none',
                  background: canAdvance ? '#5e4dbb' : '#e8e4f0',
                  color: canAdvance ? '#fff' : '#b0acbe',
                  fontSize: 13, fontWeight: 600, cursor: canAdvance ? 'pointer' : 'default',
                  fontFamily: 'Hanken Grotesk, sans-serif', transition: 'all 150ms',
                }}
                onMouseEnter={e => { if (canAdvance) e.currentTarget.style.background = '#4d3da8'; }}
                onMouseLeave={e => { if (canAdvance) e.currentTarget.style.background = '#5e4dbb'; }}
              >
                {step === 1 ? `Next → (${selectedIds.length} route${selectedIds.length !== 1 ? 's' : ''})` : 'Next →'}
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleMerge(false)}
                  disabled={!outputName.trim() || merging}
                  style={{
                    padding: '9px 18px', borderRadius: 9, border: '1px solid #e8e4f0',
                    background: 'transparent', color: '#484552',
                    fontSize: 13, fontWeight: 600, cursor: outputName.trim() && !merging ? 'pointer' : 'default',
                    fontFamily: 'Hanken Grotesk, sans-serif', transition: 'all 150ms', display: 'flex', alignItems: 'center', gap: 6,
                    opacity: !outputName.trim() || merging ? 0.5 : 1,
                  }}
                  onMouseEnter={e => { if (outputName.trim() && !merging) e.currentTarget.style.background = '#f5f3ff'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Icon name="download" size={14} color="#484552" />
                  Download GPX
                </button>
                <button
                  onClick={() => handleMerge(true)}
                  disabled={!outputName.trim() || merging}
                  style={{
                    padding: '9px 22px', borderRadius: 9, border: 'none',
                    background: outputName.trim() && !merging ? '#5e4dbb' : '#e8e4f0',
                    color: outputName.trim() && !merging ? '#fff' : '#b0acbe',
                    fontSize: 13, fontWeight: 600, cursor: outputName.trim() && !merging ? 'pointer' : 'default',
                    fontFamily: 'Hanken Grotesk, sans-serif', transition: 'all 150ms', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                  onMouseEnter={e => { if (outputName.trim() && !merging) e.currentTarget.style.background = '#4d3da8'; }}
                  onMouseLeave={e => { if (outputName.trim() && !merging) e.currentTarget.style.background = '#5e4dbb'; }}
                >
                  <Icon name="save" size={14} color={outputName.trim() && !merging ? '#fff' : '#b0acbe'} />
                  {merging ? 'Saving…' : 'Save to Library'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
