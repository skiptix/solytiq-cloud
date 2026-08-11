// ---------------------------------------------------------------------------
// EntryInspector — the authoring surface for one Knowledge Base entry, opened
// by clicking its node on the Knowledge net.
//
// Floats as an overlay over the canvas rather than pushing it into a sidebar,
// matching NodeInspector's treatment on the main Net: the graph is the page,
// and the inspector is a lens over it.
//
// Buffered like TaskDialog for the metadata fields (term/summary/aliases persist
// on Save), but the BODY autosaves through BlockEditor's own change stream —
// a long definition shouldn't be lost because the panel got closed.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import type { KnowledgeEntry, MarkdownBlock, ResolvedLink } from '../../types';
import Icon from '../Icon';
import BlockEditor from '../markdown/BlockEditor';
import SaveStatusDot from '../SaveStatusDot';
import EntityChip from '../EntityChip';
import { makeEmptyBlock } from '../../utils/markdownBlocks';
import { ENTRY_TYPE_OPTIONS } from '../../utils/knowledgeEntryTypes';
import { knowledgeEntryImageUrl, apiUploadKnowledgeEntryImage, ensureAssetTicket } from '../../api/client';
import { panelVariantsRight, crossFadeVariants } from '@/components/animate-ui/motionTokens';
import type { MentionMember } from '../../utils/mention';

const ORIGIN_LABEL: Record<string, string> = {
  ai: 'Written by the assistant',
  extracted: 'Accepted from a concept scan',
};

interface EntryInspectorProps {
  entry: KnowledgeEntry;
  relations: ResolvedLink[];
  canWrite: boolean;
  isMobile: boolean;
  mentionMembers: MentionMember[];
  onSaveMeta: (updates: Partial<Pick<KnowledgeEntry, 'term' | 'aliases' | 'entryType' | 'summary' | 'emoji' | 'properties'>>) => Promise<void>;
  onSaveContent: (blocks: MarkdownBlock[]) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
  onOpenRelation: (deepLink: string) => void;
}

export default function EntryInspector({
  entry, relations, canWrite, isMobile, mentionMembers,
  onSaveMeta, onSaveContent, onDelete, onClose, onOpenRelation,
}: EntryInspectorProps) {
  const [term, setTerm] = useState(entry.term);
  const [summary, setSummary] = useState(entry.summary ?? '');
  const [entryType, setEntryType] = useState(entry.entryType);
  const [aliases, setAliases] = useState<string[]>(entry.aliases);
  const [aliasDraft, setAliasDraft] = useState('');
  const [blocks, setBlocks] = useState<MarkdownBlock[]>(
    entry.content.blocks.length > 0 ? (entry.content.blocks as MarkdownBlock[]) : [makeEmptyBlock('paragraph')]
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [metaDirty, setMetaDirty] = useState(false);
  const [error, setError] = useState('');
  const [reorderMode, setReorderMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // S4: a short-lived per-entry image ticket (client.ts's asset-ticket
  // cache) must be minted before any `/image` block in this entry can render
  // — see knowledgeEntryImageUrl. Reset per entry.id, same as the buffer below.
  const [imagesReady, setImagesReady] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Switching to a different entry rebuilds the buffer. Keyed on id rather than
  // on the whole entry so a background sync refresh can't wipe an in-progress
  // edit of the entry currently open.
  useEffect(() => {
    setTerm(entry.term);
    setSummary(entry.summary ?? '');
    setEntryType(entry.entryType);
    setAliases(entry.aliases);
    setAliasDraft('');
    setBlocks(entry.content.blocks.length > 0 ? (entry.content.blocks as MarkdownBlock[]) : [makeEmptyBlock('paragraph')]);
    setMetaDirty(false);
    setError('');
    setConfirmDelete(false);
    setImagesReady(false);
    let cancelled = false;
    ensureAssetTicket(`kbimg:${entry.id}`)
      .catch(() => { /* best-effort — an entry with no images doesn't need one */ })
      .finally(() => { if (!cancelled) setImagesReady(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persistContent = useCallback(async (next: MarkdownBlock[]) => {
    setSaveState('saving');
    try {
      await onSaveContent(next);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [onSaveContent]);

  const handleBlocksChange = useCallback((next: MarkdownBlock[]) => {
    setBlocks(next);
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistContent(next); }, 800);
  }, [persistContent]);

  const handleBlocksChangeImmediate = useCallback((next: MarkdownBlock[]) => {
    setBlocks(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void persistContent(next);
  }, [persistContent]);

  const addAlias = () => {
    const a = aliasDraft.trim();
    if (!a) return;
    if (!aliases.some(x => x.toLowerCase() === a.toLowerCase())) {
      setAliases([...aliases, a]);
      setMetaDirty(true);
    }
    setAliasDraft('');
  };

  const saveMeta = async () => {
    setError('');
    try {
      await onSaveMeta({ term: term.trim(), summary: summary.trim() || null, entryType, aliases });
      setMetaDirty(false);
    } catch (e) {
      // The one expected failure is a duplicate term (409) — surfacing the
      // server's message keeps the dictionary's uniqueness rule legible.
      setError(e instanceof Error ? e.message : 'Could not save this entry');
    }
  };

  const label = (text: string) => (
    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-quaternary)', marginBottom: 6 }}>{text}</div>
  );
  const fieldStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-body)', fontSize: 13,
    border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none',
    background: canWrite ? 'var(--color-white)' : 'var(--color-surface-gray)', color: 'var(--color-text-primary)',
  };

  return (
    <motion.aside
      variants={panelVariantsRight}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{
      position: 'absolute', top: 12, right: 12, bottom: 12,
      width: isMobile ? 'calc(100% - 24px)' : 400, maxWidth: 'calc(100% - 24px)',
      background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)',
      boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.16)', zIndex: 6,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '14px 14px 10px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
        <span style={{ fontSize: 22, lineHeight: 1.1, flexShrink: 0 }}>{entry.emoji || '📖'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            value={term}
            disabled={!canWrite}
            onChange={e => { setTerm(e.target.value); setMetaDirty(true); }}
            placeholder="Term"
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', border: 'none', outline: 'none', background: 'transparent', padding: 0 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>
              {ENTRY_TYPE_OPTIONS.find(o => o.key === entryType)?.label ?? entryType}
            </span>
            {ORIGIN_LABEL[entry.origin] && (
              <span title={ORIGIN_LABEL[entry.origin]} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 999, background: 'var(--color-surface-tint)', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 600, color: 'var(--color-primary)' }}>
                <Icon name={entry.origin === 'ai' ? 'auto_awesome' : 'travel_explore'} size={11} color="var(--color-primary)" />
                {entry.origin === 'ai' ? 'AI' : 'Scanned'}
              </span>
            )}
            <SaveStatusDot state={saveState} />
          </div>
        </div>
        <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2, flexShrink: 0 }}>
          <Icon name="close" size={18} color="var(--color-text-tertiary)" />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          {label('Summary')}
          <textarea
            value={summary}
            disabled={!canWrite}
            onChange={e => { setSummary(e.target.value); setMetaDirty(true); }}
            placeholder="One line an assistant can quote verbatim."
            rows={2}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 4 }}>
            This is what gets carried into the assistant's context — keep it short and factual.
          </div>
        </div>

        <div>
          {label('Type')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {ENTRY_TYPE_OPTIONS.map(o => {
              const active = entryType === o.key;
              return (
                <button key={o.key}
                  disabled={!canWrite}
                  onClick={() => { setEntryType(o.key); setMetaDirty(true); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 9px', borderRadius: 999,
                    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: active ? 'var(--color-surface-tint)' : 'var(--color-white)',
                    color: active ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600,
                    cursor: canWrite ? 'pointer' : 'default', transition: 'all 140ms',
                  }}>
                  <Icon name={o.icon} size={12} color={active ? 'var(--color-primary)' : 'var(--color-text-quaternary)'} />
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          {label('Also known as')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: aliases.length ? 6 : 0 }}>
            {aliases.map(a => (
              <span key={a} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, background: 'var(--color-surface-tint)', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)' }}>
                {a}
                {canWrite && (
                  <button onClick={() => { setAliases(aliases.filter(x => x !== a)); setMetaDirty(true); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
                    <Icon name="close" size={11} color="var(--color-primary)" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {canWrite && (
            <input
              value={aliasDraft}
              onChange={e => setAliasDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } }}
              onBlur={addAlias}
              placeholder="Add an alias, then press Enter"
              style={fieldStyle}
            />
          )}
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 4 }}>
            Aliases resolve to this entry on lookup, so "MCP" can find "Model Context Protocol".
          </div>
        </div>

        {metaDirty && canWrite && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => void saveMeta()}
              style={{ flex: 1, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              Save details
            </button>
          </div>
        )}
        {error && (
          <div style={{ padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>
        )}

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            {label('Definition')}
            {canWrite && (
              <button onClick={() => setReorderMode(r => !r)} title={reorderMode ? 'Done reordering' : 'Reorder blocks'}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 7, border: `1px solid ${reorderMode ? 'var(--color-primary)' : 'var(--color-border)'}`, background: reorderMode ? 'var(--color-primary)' : 'var(--color-white)', cursor: 'pointer', marginBottom: 6 }}>
                <Icon name="swap_vert" size={13} color={reorderMode ? 'var(--color-white)' : 'var(--color-primary)'} />
              </button>
            )}
          </div>
          {imagesReady ? (
            <BlockEditor
              blocks={blocks}
              onChange={handleBlocksChange}
              onChangeImmediate={handleBlocksChangeImmediate}
              imageUrl={imageId => knowledgeEntryImageUrl(entry.id, imageId)}
              uploadImage={(file, onProgress) => apiUploadKnowledgeEntryImage(entry.id, file, onProgress)}
              isMobile={isMobile}
              reorderMode={reorderMode}
              mentionMembers={mentionMembers}
              placeholder="Define this term. Type '/' for blocks, or '[[' to link a board, page or task."
            />
          ) : (
            <div style={{ padding: '24px 0', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</div>
          )}
        </div>

        <div>
          {label(`Relations (${relations.length})`)}
          {relations.length === 0 ? (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', lineHeight: 1.5 }}>
              No relations yet. Type <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>[[</code> in the definition to link something — that creates a real relation you'll see on the net.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {relations.map(l => (
                <EntityChip
                  key={l.id}
                  entity={l.neighbor}
                  onClick={l.neighbor?.deepLink ? () => onOpenRelation(l.neighbor!.deepLink!) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      {canWrite && (
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-surface-tint-2)', display: 'flex', justifyContent: 'flex-end' }}>
          <AnimatePresence mode="wait" initial={false}>
            {confirmDelete ? (
              <motion.div key="confirm" variants={crossFadeVariants} initial="initial" animate="animate" exit="exit" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Delete "{entry.term}"?</span>
                <button onClick={() => setConfirmDelete(false)}
                  style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--color-border-alt)', background: 'transparent', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={onDelete}
                  style={{ padding: '6px 12px', borderRadius: 7, border: 'none', background: 'var(--color-error)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
              </motion.div>
            ) : (
              <motion.button key="trigger" onClick={() => setConfirmDelete(true)} variants={crossFadeVariants} initial="initial" animate="animate" exit="exit"
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', background: 'transparent', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, color: 'var(--color-error)', cursor: 'pointer' }}>
                <Icon name="delete" size={14} color="var(--color-error)" /> Delete entry
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.aside>
  );
}
