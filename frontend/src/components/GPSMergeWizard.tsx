import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { GpsFile, GapMode } from '../types';
import { apiUploadGpsFile, apiMergeGpsFilesDownload, apiMergeGpsFilesSave } from '../api/client';
import Icon from './Icon';
import ModalIn from './animate-ui/ModalIn';
import MotionButton from './animate-ui/MotionButton';
import MotionIn from './animate-ui/MotionIn';
import { motion } from './animate-ui/motion';

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

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <ModalIn
        duration={260}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-white)', borderRadius: 18, width: 560, maxWidth: '95vw', maxHeight: '90vh',
          display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(var(--color-black-rgb), 0.18)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--color-purple-pale-18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Merge Routes
            </div>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="close" size={18} color="var(--color-text-tertiary)" />
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
                      background: done ? 'var(--color-primary)' : active ? 'var(--color-surface-tint-4)' : 'var(--color-surface-tint)',
                      border: `2px solid ${done ? 'var(--color-primary)' : active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      fontSize: 11, fontWeight: 700, color: done ? 'var(--color-white)' : active ? 'var(--color-primary)' : 'var(--color-text-quaternary)',
                      flexShrink: 0,
                    }}>
                      {done ? '✓' : n}
                    </div>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: active ? 600 : 400, color: active ? 'var(--color-primary)' : done ? 'var(--color-text-secondary)' : 'var(--color-text-quaternary)', whiteSpace: 'nowrap' }}>
                      {label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div style={{ width: 24, height: 1, background: done ? 'var(--color-primary)' : 'var(--color-border)', flexShrink: 0 }} />
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
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                  Select routes from your library
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)' }}>
                  Choose 2–5 routes to merge. Use drag or the arrows to set the order.
                </div>
              </div>

              {/* Library list */}
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden', maxHeight: 220, overflowY: 'auto', marginBottom: 14 }}>
                {allFiles.length === 0 && (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-quaternary)', fontSize: 12, fontFamily: 'var(--font-body)' }}>
                    No routes yet. Upload files below.
                  </div>
                )}
                {allFiles.map(file => {
                  const checked = selectedIds.includes(file.id);
                  const disabled = !checked && selectedIds.length >= 5;
                  return (
                    <MotionIn
                      key={file.id}
                      onClick={() => !disabled && toggleSelect(file.id)}
                      animate={{ background: checked ? 'var(--color-surface-tint-3)' : 'transparent' }}
                      whileHover={!disabled && !checked ? { background: 'var(--color-purple-pale-5)' } : undefined}
                      transition={{ duration: 0.12 }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                        borderBottom: '1px solid var(--color-surface-tint)', cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.45 : 1,
                      }}
                    >
                      {/* Checkbox */}
                      <div style={{
                        width: 17, height: 17, borderRadius: 5, flexShrink: 0,
                        border: `1.5px solid ${checked ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                        background: checked ? 'var(--color-primary)' : 'var(--color-white)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {checked && <Icon name="check" size={11} color="var(--color-white)" />}
                      </div>
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? 'var(--color-purple-pale-21)' : 'var(--color-teal-tint-1)', color: file.fileType === 'gpx' ? 'var(--color-primary)' : 'var(--color-teal-deep-2)', letterSpacing: '0.04em', flexShrink: 0 }}>
                        {file.fileType.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-heading)' }}>
                        {file.name.replace(/\.(gpx|fit)$/i, '')}
                      </span>
                      {file.metadata?.totalDistance != null && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {fmtDist(file.metadata.totalDistance)}
                        </span>
                      )}
                    </MotionIn>
                  );
                })}
              </div>

              {/* Upload new */}
              <MotionButton
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || selectedIds.length >= 5}
                whileHover={selectedIds.length < 5 ? { background: 'var(--color-surface-tint-3)' } : undefined}
                transition={{ duration: 0.15 }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px',
                  borderRadius: 8, border: '1.5px dashed var(--color-accent-purple-soft)', background: 'transparent',
                  color: 'var(--color-primary)', fontSize: 12.5, fontWeight: 600, cursor: selectedIds.length < 5 ? 'pointer' : 'default',
                  fontFamily: 'var(--font-heading)', opacity: selectedIds.length >= 5 ? 0.4 : 1,
                  marginBottom: selectedIds.length > 0 ? 16 : 0,
                }}
              >
                <Icon name="upload" size={14} color="var(--color-primary)" />
                {uploading ? 'Uploading…' : 'Upload new .GPX or .FIT'}
              </MotionButton>
              <input ref={fileInputRef} type="file" accept=".gpx,.fit" style={{ display: 'none' }} multiple onChange={e => handleUpload(e.target.files)} />

              {/* Selected order */}
              {selectedIds.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
                          borderRadius: 8, background: dragOverIdx === idx ? 'var(--color-surface-tint-4)' : 'var(--color-purple-pale-10)',
                          border: `1.5px solid ${dragOverIdx === idx ? 'var(--color-primary)' : 'var(--color-border)'}`,
                          cursor: 'grab', transition: 'all 120ms',
                        }}
                      >
                        <Icon name="drag_indicator" size={16} color="var(--color-accent-purple-soft)" />
                        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-quaternary)', minWidth: 16 }}>
                          {idx + 1}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? 'var(--color-purple-pale-21)' : 'var(--color-teal-tint-1)', color: file.fileType === 'gpx' ? 'var(--color-primary)' : 'var(--color-teal-deep-2)', letterSpacing: '0.04em' }}>
                          {file.fileType.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-heading)' }}>
                          {file.name.replace(/\.(gpx|fit)$/i, '')}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <button onClick={() => moveUp(idx)} disabled={idx === 0} style={{ width: 20, height: 16, border: 'none', background: 'transparent', cursor: idx === 0 ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: idx === 0 ? 0.25 : 1 }}>
                            <Icon name="keyboard_arrow_up" size={14} color="var(--color-text-tertiary)" />
                          </button>
                          <button onClick={() => moveDown(idx)} disabled={idx === selectedIds.length - 1} style={{ width: 20, height: 16, border: 'none', background: 'transparent', cursor: idx === selectedIds.length - 1 ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: idx === selectedIds.length - 1 ? 0.25 : 1 }}>
                            <Icon name="keyboard_arrow_down" size={14} color="var(--color-text-tertiary)" />
                          </button>
                        </div>
                        <button onClick={() => setSelectedIds(prev => prev.filter(x => x !== file.id))} style={{ width: 20, height: 20, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, flexShrink: 0 }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-red-pale-8)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <Icon name="close" size={13} color="var(--color-text-quaternary)" />
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
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                  Handle gaps between routes
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', lineHeight: 1.6 }}>
                  Choose how each pair of consecutive routes is connected. A gap occurs when the end of one route doesn't match the start of the next.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selectedFiles.map((file, idx) => (
                  <div key={file.id}>
                    {/* Route block */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'var(--color-surface-tint-3)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-white)' }}>{idx + 1}</span>
                      </div>
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? 'var(--color-purple-pale-21)' : 'var(--color-teal-tint-1)', color: file.fileType === 'gpx' ? 'var(--color-primary)' : 'var(--color-teal-deep-2)', letterSpacing: '0.04em' }}>
                        {file.fileType.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-heading)' }}>
                        {file.name.replace(/\.(gpx|fit)$/i, '')}
                      </span>
                      {file.metadata?.totalDistance != null && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', flexShrink: 0 }}>
                          {fmtDist(file.metadata.totalDistance)}
                        </span>
                      )}
                    </div>

                    {/* Gap connector (between consecutive routes) */}
                    {idx < selectedFiles.length - 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: 'var(--color-accent-purple-soft)' }}>
                          <Icon name="arrow_downward" size={16} color="var(--color-accent-purple-soft)" />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', marginBottom: 5 }}>
                            Gap between route {idx + 1} and {idx + 2}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {(['skip', 'straight'] as GapMode[]).map(mode => (
                              <MotionButton
                                key={mode}
                                onClick={() => setGapModes(prev => { const a = [...prev]; a[idx] = mode; return a; })}
                                animate={{
                                  borderColor: gapModes[idx] === mode ? 'var(--color-primary)' : 'var(--color-border)',
                                  background: gapModes[idx] === mode ? 'var(--color-surface-tint-4)' : 'transparent',
                                  color: gapModes[idx] === mode ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                                }}
                                transition={{ duration: 0.12 }}
                                style={{
                                  padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                                  borderWidth: 1.5, borderStyle: 'solid',
                                  fontSize: 12, fontWeight: gapModes[idx] === mode ? 600 : 400,
                                  fontFamily: 'var(--font-body)',
                                  display: 'flex', alignItems: 'center', gap: 5,
                                }}
                              >
                                <Icon name={mode === 'skip' ? 'remove' : 'timeline'} size={12} color={gapModes[idx] === mode ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                                {mode === 'skip' ? 'Skip gap' : 'Straight line'}
                              </MotionButton>
                            ))}
                          </div>
                          <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--color-border-strong)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
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
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                  Name your merged route
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)' }}>
                  Choose a name and save to your library or just download.
                </div>
              </div>

              <motion.input
                value={outputName}
                onChange={e => setOutputName(e.target.value)}
                placeholder="Route name…"
                autoFocus
                whileFocus={{ borderColor: 'var(--color-primary)' }}
                transition={{ duration: 0.2 }}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '10px 14px',
                  borderWidth: 1.5, borderStyle: 'solid', borderColor: 'var(--color-accent-purple-soft)', borderRadius: 10, fontSize: 14,
                  fontFamily: 'var(--font-heading)', color: 'var(--color-text-primary)',
                  outline: 'none', background: 'var(--color-surface-tint-3)', marginBottom: 20,
                }}
              />

              {/* Summary */}
              <div style={{ background: 'var(--color-purple-pale-10)', borderRadius: 12, padding: '14px 16px', display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Routes</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-primary)', fontFamily: 'var(--font-heading)' }}>{selectedIds.length}</div>
                </div>
                {totalDist > 0 && (
                  <div>
                    <div style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Total distance</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>{fmtDist(totalDist)}</div>
                  </div>
                )}
                {totalElev > 0 && (
                  <div>
                    <div style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Elevation gain</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>↑{Math.round(totalElev)} m</div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-body)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Format</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: 'var(--font-heading)' }}>GPX</div>
                </div>
              </div>

              {/* Gap summary */}
              {gapModes.some(m => m === 'straight') && (
                <div style={{ fontSize: 11.5, color: 'var(--color-success)', fontFamily: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 5, padding: '6px 0' }}>
                  <Icon name="timeline" size={13} color="var(--color-success)" />
                  {gapModes.filter(m => m === 'straight').length} straight-line connector{gapModes.filter(m => m === 'straight').length > 1 ? 's' : ''} will be added.
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--color-purple-pale-18)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--color-purple-pale-1)', flexShrink: 0 }}>
          <MotionButton
            onClick={() => { if (step === 1) onClose(); else setStep(s => (s - 1) as 1 | 2 | 3); }}
            whileHover={{ background: 'var(--color-surface-tint)' }}
            transition={{ duration: 0.15 }}
            style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-heading)' }}
          >
            {step === 1 ? 'Cancel' : '← Back'}
          </MotionButton>

          <div style={{ display: 'flex', gap: 8 }}>
            {step < 3 ? (
              <MotionButton
                onClick={() => canAdvance && setStep(s => (s + 1) as 2 | 3)}
                disabled={!canAdvance}
                animate={{ background: canAdvance ? 'var(--color-primary)' : 'var(--color-border)' }}
                whileHover={canAdvance ? { background: 'var(--color-purple-mid-11)' } : undefined}
                transition={{ duration: 0.15 }}
                style={{
                  padding: '9px 22px', borderRadius: 9, border: 'none',
                  color: canAdvance ? 'var(--color-white)' : 'var(--color-text-quaternary)',
                  fontSize: 13, fontWeight: 600, cursor: canAdvance ? 'pointer' : 'default',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                {step === 1 ? `Next → (${selectedIds.length} route${selectedIds.length !== 1 ? 's' : ''})` : 'Next →'}
              </MotionButton>
            ) : (
              <>
                <MotionButton
                  onClick={() => handleMerge(false)}
                  disabled={!outputName.trim() || merging}
                  whileHover={outputName.trim() && !merging ? { background: 'var(--color-surface-tint)' } : undefined}
                  transition={{ duration: 0.15 }}
                  style={{
                    padding: '9px 18px', borderRadius: 9, border: '1px solid var(--color-border)',
                    background: 'transparent', color: 'var(--color-text-secondary)',
                    fontSize: 13, fontWeight: 600, cursor: outputName.trim() && !merging ? 'pointer' : 'default',
                    fontFamily: 'var(--font-heading)', display: 'flex', alignItems: 'center', gap: 6,
                    opacity: !outputName.trim() || merging ? 0.5 : 1,
                  }}
                >
                  <Icon name="download" size={14} color="var(--color-text-secondary)" />
                  Download GPX
                </MotionButton>
                <MotionButton
                  onClick={() => handleMerge(true)}
                  disabled={!outputName.trim() || merging}
                  animate={{ background: outputName.trim() && !merging ? 'var(--color-primary)' : 'var(--color-border)' }}
                  whileHover={outputName.trim() && !merging ? { background: 'var(--color-purple-mid-11)' } : undefined}
                  transition={{ duration: 0.15 }}
                  style={{
                    padding: '9px 22px', borderRadius: 9, border: 'none',
                    color: outputName.trim() && !merging ? 'var(--color-white)' : 'var(--color-text-quaternary)',
                    fontSize: 13, fontWeight: 600, cursor: outputName.trim() && !merging ? 'pointer' : 'default',
                    fontFamily: 'var(--font-heading)', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <Icon name="save" size={14} color={outputName.trim() && !merging ? 'var(--color-white)' : 'var(--color-text-quaternary)'} />
                  {merging ? 'Saving…' : 'Save to Library'}
                </MotionButton>
              </>
            )}
          </div>
        </div>
      </ModalIn>
    </div>,
    document.body
  );
}
