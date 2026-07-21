import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createPortal, flushSync } from 'react-dom';
import type {
  MarkdownBlock, MarkdownBlockType, MarkdownTodoBlock, MarkdownImageBlock, MarkdownLinkBlock,
  MarkdownHeadingBlock, MarkdownParagraphBlock, MarkdownBulletListItemBlock, MarkdownNumberedListItemBlock, MarkdownQuoteBlock,
  MarkdownDividerBlock,
} from '../types';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import { useMobile } from '../hooks/useBreakpoint';
import Icon from '../components/Icon';
import { renderInline } from '../components/MarkdownView';
import { toggleWrap, formatMarkerForKeyDown } from '../utils/textFormatting';
import { apiUploadMarkdownImage, markdownImageUrl, type ShareInfo } from '../api/client';
import ItemSettingsModal, { type ItemSettingsUpdates } from '../modals/ItemSettingsModal';
import MarkdownListAIAssist from '../components/AIAssistant/MarkdownListAIAssist';
import SaveStatusDot from '../components/SaveStatusDot';

// Matches TaskItem.tsx's hand-drawn checkmark so a `/todo` block's checkbox
// looks identical to a task row in the To-Do screen.
function Checkmark() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
      <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Slash commands ───────────────────────────────────────────────────────────
interface SlashCommand {
  cmd: string;
  label: string;
  icon: string;
  type: MarkdownBlockType;
  level?: 1 | 2 | 3;
  /** For `type: 'divider'` only — inserts it already set to the 2-column side-by-side layout. */
  columns?: boolean;
}
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: 'h1', label: 'Heading 1', icon: 'format_h1', type: 'heading', level: 1 },
  { cmd: 'h2', label: 'Heading 2', icon: 'format_h2', type: 'heading', level: 2 },
  { cmd: 'h3', label: 'Heading 3', icon: 'format_h3', type: 'heading', level: 3 },
  { cmd: 'bullet', label: 'Bulleted list', icon: 'format_list_bulleted', type: 'bulleted-list-item' },
  { cmd: 'number', label: 'Numbered list', icon: 'format_list_numbered', type: 'numbered-list-item' },
  { cmd: 'todo', label: 'To-do', icon: 'check_box', type: 'todo' },
  { cmd: 'quote', label: 'Quote', icon: 'format_quote', type: 'quote' },
  { cmd: 'divider', label: 'Divider', icon: 'horizontal_rule', type: 'divider' },
  { cmd: 'columns', label: '2 columns', icon: 'view_column', type: 'divider', columns: true },
  { cmd: 'image', label: 'Image', icon: 'image', type: 'image' },
  { cmd: 'link', label: 'Link', icon: 'link', type: 'link' },
];

let blockSeq = 0;
function newBlockId(): string {
  blockSeq += 1;
  return `blk_${Date.now()}_${blockSeq}`;
}

function makeEmptyBlock(type: MarkdownBlockType, level?: 1 | 2 | 3): MarkdownBlock {
  const id = newBlockId();
  switch (type) {
    case 'heading': return { id, type, level: level ?? 3, text: '' };
    case 'todo': return { id, type, text: '', checked: false, taskId: null };
    case 'divider': return { id, type };
    default: return { id, type: type as 'paragraph' | 'bulleted-list-item' | 'numbered-list-item' | 'quote', text: '' };
  }
}

type TextBlock = MarkdownHeadingBlock | MarkdownParagraphBlock | MarkdownBulletListItemBlock | MarkdownNumberedListItemBlock | MarkdownTodoBlock | MarkdownQuoteBlock;
const TEXT_BLOCK_TYPES = new Set<MarkdownBlockType>(['heading', 'paragraph', 'bulleted-list-item', 'numbered-list-item', 'todo', 'quote']);
function hasText(block: MarkdownBlock): block is TextBlock {
  return TEXT_BLOCK_TYPES.has(block.type);
}

// ── Image upload modal ───────────────────────────────────────────────────────
interface ImageUploadModalProps {
  markdownListId: string;
  isMobile: boolean;
  onUploaded: (image: { id: string }) => void;
  onClose: () => void;
}
function ImageUploadModal({ markdownListId, isMobile, onUploaded, onClose }: ImageUploadModalProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) { setError('Please choose an image file (PNG, JPEG, WEBP or GIF).'); return; }
    setUploading(true);
    setError('');
    try {
      const image = await apiUploadMarkdownImage(markdownListId, file, setProgress);
      onUploaded(image);
    } catch (e) {
      console.error('image upload failed', e);
      setError('Upload failed. Please try again.');
      setUploading(false);
    }
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget && !uploading) onClose(); }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: isMobile ? '100%' : 440, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Add image</span>
          <button onClick={onClose} disabled={uploading} style={{ background: 'none', border: 'none', cursor: uploading ? 'default' : 'pointer', display: 'flex', padding: 2, opacity: uploading ? 0.4 : 1 }}>
            <Icon name="close" size={18} color="var(--color-text-tertiary)" />
          </button>
        </div>
        <div style={{ padding: 24 }}>
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            onClick={() => !uploading && fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border)'}`, borderRadius: 14, padding: '40px 20px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: uploading ? 'default' : 'pointer',
              background: dragOver ? 'var(--color-surface-tint)' : 'var(--color-purple-pale-7)', transition: 'all 150ms',
            }}>
            <Icon name={uploading ? 'progress_activity' : 'add_photo_alternate'} size={32} color="var(--color-accent-purple-light)" />
            {uploading ? (
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>Uploading… {progress}%</span>
            ) : (
              <>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Drag & drop an image</span>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>or click to browse — PNG, JPEG, WEBP or GIF, up to 15MB</span>
              </>
            )}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          </div>
          {error && <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--color-error-bg)', borderRadius: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function MarkdownListScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useMobile();
  const { getDetail, update, remove } = useMarkdownListsStore();

  const [mdId, setMdId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  const [isPublic, setIsPublic] = useState(false);
  const [fullWidth, setFullWidth] = useState(false);
  const [shareInfo, setShareInfo] = useState<{ enabled?: boolean; token?: string | null; hasPassword?: boolean; expiresAt?: string | null }>({});
  const [showSettings, setShowSettings] = useState(false);
  const [todoListId, setTodoListId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<MarkdownBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [slashMenu, setSlashMenu] = useState<{ blockId: string; query: string } | null>(null);
  const [uploadTargetBlockId, setUploadTargetBlockId] = useState<string | null>(null);
  const [linkEditingBlockId, setLinkEditingBlockId] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState({ url: '', title: '', description: '' });
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  // Columns layout (up to 2 sections side by side, see `divider.layout`):
  // which handle is currently being dragged (its divider + which side it's
  // on), and which columns row is hovered (reveals both outside handles plus
  // the row's Stack/delete control bar together, since the pair is one unit).
  const [dragColumnHandle, setDragColumnHandle] = useState<{ dividerId: string; col: 0 | 1 } | null>(null);
  const [hoveredColumnsRowId, setHoveredColumnsRowId] = useState<string | null>(null);
  // Which block currently shows a raw, editable textarea. Every other
  // text-bearing block shows its formatted (bold/italic/strikethrough)
  // rendering instead — click it to switch into edit mode.
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  // Right-click context menu anchored at a viewport position, targeting one
  // block (its Split/Stack/Swap options are resolved from that block's
  // current section/columns membership — see contextMenuItems below).
  const [contextMenu, setContextMenu] = useState<{ blockId: string; x: number; y: number } | null>(null);
  // Which context-menu item's flyout submenu (the "Turn into" type switcher) is
  // currently open. Reset whenever the menu opens/closes.
  const [ctxSubmenuOpen, setCtxSubmenuOpen] = useState(false);
  // "Reorder" mode: when on, every block's drag grip is shown so blocks can be
  // dragged to reorder; when off (default) the grips stay hidden for a clean,
  // no-movement reading/editing experience (toggled from the header button).
  const [reorderMode, setReorderMode] = useState(false);

  const blockRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    getDetail(id).then(md => {
      if (cancelled) return;
      setMdId(md.id);
      setName(md.name);
      setEmoji(md.emoji);
      setColor(md.color);
      setSubtitle(md.subtitle ?? undefined);
      setIsPublic(Boolean(md.isPublic));
      setFullWidth(Boolean(md.fullWidth));
      setShareInfo({ enabled: md.shareEnabled, token: md.shareToken, hasPassword: md.shareHasPassword, expiresAt: md.shareExpiresAt });
      setTodoListId(md.todoListId ?? null);
      const initialBlocks = md.content.blocks.length > 0 ? md.content.blocks : [makeEmptyBlock('paragraph')];
      setBlocks(initialBlocks);
      // A brand-new, still-empty document opens ready to type into; an
      // existing document opens fully in its formatted, read-at-a-glance form.
      if (initialBlocks.length === 1 && hasText(initialBlocks[0]) && initialBlocks[0].text === '') {
        setFocusedBlockId(initialBlocks[0].id);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setNotFound(true); setLoading(false); }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // At most one PUT in flight at a time: a fast typist can trigger the
  // debounced content save and an immediate todo-checkbox save close
  // together, and without this guard their responses could land out of
  // order — an older response's blocks would clobber newer local edits.
  // A save requested while one is already in flight is queued and coalesced
  // into a single trailing call with the latest blocks once the current one
  // settles (never a growing backlog).
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<MarkdownBlock[] | null>(null);

  const persist = useCallback(async (nextBlocks: MarkdownBlock[]) => {
    if (!mdId) return;
    if (savingRef.current) { pendingSaveRef.current = nextBlocks; return; }
    savingRef.current = true;
    setSaveState('saving');
    try {
      const res = await update(mdId, { content: { version: 1, blocks: nextBlocks } });
      setTodoListId(res.todoListId ?? null);
      setBlocks(res.content.blocks.length > 0 ? res.content.blocks : [makeEmptyBlock('paragraph')]);
      setSaveState('saved');
    } catch (e) {
      console.error('markdown list save failed', e);
      setSaveState('error');
    } finally {
      savingRef.current = false;
      const queued = pendingSaveRef.current;
      if (queued) { pendingSaveRef.current = null; void persist(queued); }
    }
  }, [mdId, update]);

  const scheduleSave = useCallback((nextBlocks: MarkdownBlock[]) => {
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(nextBlocks); }, 800);
  }, [persist]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Dismiss the right-click menu on Escape or when the page scrolls/resizes
  // (its fixed position would otherwise drift away from the block it targets).
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  const updateBlocks = useCallback((mutator: (prev: MarkdownBlock[]) => MarkdownBlock[]) => {
    setBlocks(prev => {
      const next = mutator(prev);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  // Switches a block into edit mode (raw textarea, vs. its formatted preview)
  // and focuses it, synchronously. `flushSync` matters twice over here: for a
  // block that's currently showing its formatted preview, setting
  // `focusedBlockId` doesn't render the textarea until React commits — without
  // flushSync the ref wouldn't exist yet when `.focus()` runs below. And for a
  // NEWLY CREATED block, the caller must have already flushSync'd its own
  // insertion into `blocks` first (see addBlockAfter) so this block exists in
  // the tree at all before this function's own flush tries to focus it —
  // otherwise a fast typist's next keystroke could land on the still-focused
  // PREVIOUS block before the browser paints the new one.
  const focusBlock = (blockId: string, atEnd = true) => {
    flushSync(() => setFocusedBlockId(blockId));
    const el = blockRefs.current[blockId];
    if (el) { el.focus(); if (atEnd) { const len = el.value.length; el.setSelectionRange(len, len); } }
  };

  const applyFormatToBlock = (block: TextBlock, marker: '**' | '*' | '~~', el: HTMLTextAreaElement) => {
    const { next, selStart, selEnd } = toggleWrap(block.text, el.selectionStart ?? 0, el.selectionEnd ?? 0, marker);
    updateBlockText(block.id, next);
    requestAnimationFrame(() => {
      const now = blockRefs.current[block.id];
      if (!now) return;
      now.focus();
      now.setSelectionRange(selStart, selEnd);
    });
  };

  const addBlockAfter = (afterId: string, block: MarkdownBlock) => {
    flushSync(() => {
      updateBlocks(prev => {
        const idx = prev.findIndex(b => b.id === afterId);
        const next = [...prev];
        next.splice(idx === -1 ? next.length : idx + 1, 0, block);
        return next;
      });
    });
    focusBlock(block.id, false);
  };

  const deleteBlock = (blockId: string) => {
    updateBlocks(prev => (prev.length <= 1 ? prev : prev.filter(b => b.id !== blockId)));
  };

  const updateBlockText = (blockId: string, text: string) => {
    updateBlocks(prev => prev.map(b => (b.id === blockId && hasText(b)) ? { ...b, text } as MarkdownBlock : b));
  };

  const toggleTodo = (block: MarkdownTodoBlock) => {
    setBlocks(prev => {
      const next = prev.map(b => (b.id === block.id && b.type === 'todo') ? { ...b, checked: !b.checked } : b);
      void persist(next);
      return next;
    });
  };

  const moveBlock = (fromId: string, toId: string) => {
    updateBlocks(prev => {
      const fromIdx = prev.findIndex(b => b.id === fromId);
      const toIdx = prev.findIndex(b => b.id === toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const toggleColumnsLayout = (dividerId: string, layout: 'stack' | 'columns') => {
    updateBlocks(prev => prev.map(b => (b.id === dividerId && b.type === 'divider') ? { ...b, layout } : b));
  };

  // Swaps the two sections flanking a `layout: 'columns'` divider — the only
  // possible reorder with exactly 2 boxes. A section is the contiguous run of
  // blocks between this divider and its nearest neighboring divider (or the
  // start/end of the document), so swapping is just reslicing the flat array.
  const swapColumns = (dividerId: string) => {
    updateBlocks(prev => {
      const dIdx = prev.findIndex(b => b.id === dividerId);
      if (dIdx === -1) return prev;
      let leftStart = 0;
      for (let k = dIdx - 1; k >= 0; k--) { if (prev[k].type === 'divider') { leftStart = k + 1; break; } }
      let rightEnd = prev.length;
      for (let k = dIdx + 1; k < prev.length; k++) { if (prev[k].type === 'divider') { rightEnd = k; break; } }
      const leftBlocks = prev.slice(leftStart, dIdx);
      const rightBlocks = prev.slice(dIdx + 1, rightEnd);
      if (leftBlocks.length === 0 || rightBlocks.length === 0) return prev;
      return [...prev.slice(0, leftStart), ...rightBlocks, prev[dIdx], ...leftBlocks, ...prev.slice(rightEnd)];
    });
  };

  // Splits a block's own section in two side-by-side columns by inserting a
  // `columns` divider immediately before it: everything above the block (within
  // the same section) becomes the left column, this block onward the right.
  // Only meaningful when the block isn't already the first in its section
  // (otherwise the left column would be empty) — the context menu enforces that.
  const splitBeforeBlock = (blockId: string) => {
    updateBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx <= 0 || prev[idx - 1].type === 'divider') return prev;
      const next = [...prev];
      next.splice(idx, 0, { id: newBlockId(), type: 'divider', layout: 'columns' });
      return next;
    });
  };

  // Converts a text-bearing block to another text-bearing type IN PLACE — keeps
  // the same block id and its text, only changing how it renders (e.g. H1 → H2,
  // paragraph → quote). Used by the right-click "Turn into" submenu.
  type TextConvertType = 'heading' | 'paragraph' | 'bulleted-list-item' | 'numbered-list-item' | 'todo' | 'quote';
  const changeBlockType = (blockId: string, type: TextConvertType, level?: 1 | 2 | 3) => {
    updateBlocks(prev => prev.map(b => {
      if (b.id !== blockId || !hasText(b)) return b;
      const text = b.text;
      if (type === 'heading') return { id: b.id, type, level: level ?? 3, text };
      if (type === 'todo') return { id: b.id, type, text, checked: b.type === 'todo' ? b.checked : false, taskId: b.type === 'todo' ? b.taskId : null };
      return { id: b.id, type, text };
    }));
  };

  const filteredCommands = (query: string) => {
    const q = query.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
  };

  const applyCommand = (blockId: string, command: SlashCommand) => {
    setSlashMenu(null);
    if (command.type === 'image') {
      updateBlocks(prev => prev.map(b => (b.id === blockId && hasText(b)) ? { ...b, text: '' } as MarkdownBlock : b));
      setUploadTargetBlockId(blockId);
      return;
    }
    if (command.type === 'link') {
      updateBlocks(prev => prev.map(b => (b.id === blockId && hasText(b)) ? { ...b, text: '' } as MarkdownBlock : b));
      setLinkDraft({ url: '', title: '', description: '' });
      setLinkEditingBlockId(blockId);
      return;
    }
    if (command.type === 'divider') {
      const nextParagraph = makeEmptyBlock('paragraph');
      flushSync(() => {
        updateBlocks(prev => {
          const idx = prev.findIndex(b => b.id === blockId);
          const next = [...prev];
          next[idx] = command.columns ? { id: blockId, type: 'divider', layout: 'columns' } : { id: blockId, type: 'divider' };
          next.splice(idx + 1, 0, nextParagraph);
          return next;
        });
      });
      focusBlock(nextParagraph.id, false);
      return;
    }
    updateBlocks(prev => prev.map(b => b.id === blockId ? makeEmptyBlockKeepingId(b.id, command) : b));
    focusBlock(blockId, false);
  };

  function makeEmptyBlockKeepingId(id: string, command: SlashCommand): MarkdownBlock {
    if (command.type === 'heading') return { id, type: 'heading', level: command.level ?? 3, text: '' };
    if (command.type === 'todo') return { id, type: 'todo', text: '', checked: false, taskId: null };
    return { id, type: command.type as 'paragraph' | 'bulleted-list-item' | 'numbered-list-item' | 'quote', text: '' };
  }

  const handleImageUploaded = (blockId: string, image: { id: string }) => {
    updateBlocks(prev => prev.map(b => b.id === blockId ? ({ id: blockId, type: 'image', imageId: image.id } as MarkdownImageBlock) : b));
    setUploadTargetBlockId(null);
  };

  const saveLinkBlock = () => {
    if (!linkEditingBlockId || !linkDraft.url.trim()) return;
    const blockId = linkEditingBlockId;
    updateBlocks(prev => prev.map(b => b.id === blockId ? ({
      id: blockId, type: 'link', url: linkDraft.url.trim(),
      title: linkDraft.title.trim() || undefined, description: linkDraft.description.trim() || undefined,
    } as MarkdownLinkBlock) : b));
    setLinkEditingBlockId(null);
  };

  const handleTextChange = (block: MarkdownBlock, text: string) => {
    updateBlockText(block.id, text);
    if (block.type === 'paragraph' && text.startsWith('/') && !text.includes(' ')) {
      setSlashMenu({ blockId: block.id, query: text.slice(1) });
    } else if (slashMenu?.blockId === block.id) {
      setSlashMenu(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, block: MarkdownBlock, index: number) => {
    const formatMarker = formatMarkerForKeyDown(e);
    if (formatMarker && hasText(block)) { e.preventDefault(); applyFormatToBlock(block, formatMarker, e.currentTarget); return; }
    if (slashMenu?.blockId === block.id) {
      if (e.key === 'Escape') { e.preventDefault(); setSlashMenu(null); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const match = filteredCommands(slashMenu.query)[0];
        if (match) applyCommand(block.id, match);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const continued: MarkdownBlockType[] = ['bulleted-list-item', 'numbered-list-item', 'todo'];
      const nextType: MarkdownBlockType = continued.includes(block.type) ? block.type : 'paragraph';
      // A second Enter on an empty list/todo item exits the list instead of
      // continuing it — otherwise there'd be no way to leave a list.
      if (continued.includes(block.type) && hasText(block) && block.text === '') {
        updateBlocks(prev => prev.map(b => b.id === block.id ? makeEmptyBlockKeepingId(b.id, { cmd: '', label: '', icon: '', type: 'paragraph' }) : b));
        return;
      }
      addBlockAfter(block.id, makeEmptyBlock(nextType));
      return;
    }
    if (e.key === 'Backspace') {
      const el = e.currentTarget;
      if (el.selectionStart === 0 && el.selectionEnd === 0 && hasText(block) && block.text === '' && index > 0) {
        e.preventDefault();
        const prevBlock = blocks[index - 1];
        deleteBlock(block.id);
        focusBlock(prevBlock.id, true);
      }
    }
  };

  const handleNameSave = () => {
    const trimmed = nameDraft.trim();
    setNameEditing(false);
    if (!mdId || !trimmed || trimmed === name) return;
    setName(trimmed);
    void update(mdId, { name: trimmed });
  };

  const handleDelete = () => {
    if (!mdId) return;
    void remove(mdId);
    navigate('/dashboard');
  };

  const handleSettingsChange = (updates: ItemSettingsUpdates) => {
    if (!mdId) return;
    if (updates.emoji !== undefined) setEmoji(updates.emoji);
    if (updates.color !== undefined) setColor(updates.color);
    if (updates.isPublic !== undefined) setIsPublic(updates.isPublic);
    if (updates.fullWidth !== undefined) setFullWidth(updates.fullWidth);
    // Markdown lists don't expose the Folder tab (no folder-nesting UI yet),
    // so `folderId` never actually arrives here in practice — the cast just
    // satisfies ItemSettingsUpdates' shared shape (folderId: string | null)
    // against the store's Partial<MarkdownList> (folderId?: string).
    void update(mdId, updates as Parameters<typeof update>[1]);
  };

  if (loading) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading…</div>;
  }
  if (notFound || !mdId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Icon name="notes" size={40} color="var(--color-border-strong)" />
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Markdown list not found</div>
        <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>Back to Dashboard</button>
      </div>
    );
  }

  // Contiguous run numbering for numbered-list-item blocks.
  const numberByBlockId: Record<string, number> = {};
  let runCount = 0;
  for (const b of blocks) {
    if (b.type === 'numbered-list-item') { runCount += 1; numberByBlockId[b.id] = runCount; }
    else runCount = 0;
  }

  const blockIndexById: Record<string, number> = {};
  blocks.forEach((b, i) => { blockIndexById[b.id] = i; });

  // Blocks are grouped into outlined sections; a `/divider` block closes the
  // current section and opens a new one, so a divider is what splits the
  // outline rather than each block carrying its own.
  const sections: MarkdownBlock[][] = [[]];
  const sectionDividers: MarkdownBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'divider') { sectionDividers.push(b); sections.push([]); }
    else sections[sections.length - 1].push(b);
  }

  // A divider can only offer the "side by side" toggle when it actually has
  // a non-empty section on both sides to pair up.
  const dividerCanColumnsById: Record<string, boolean> = {};
  sectionDividers.forEach((d, i) => {
    dividerCanColumnsById[d.id] = (sections[i]?.length ?? 0) > 0 && (sections[i + 1]?.length ?? 0) > 0;
  });

  // Which section each non-divider block lives in, and each divider's order
  // among the dividers — used by the right-click menu to resolve a block's
  // available Split/Stack/Swap options from its live columns membership.
  const sectionIdxByBlockId: Record<string, number> = {};
  sections.forEach((sec, si) => sec.forEach(b => { sectionIdxByBlockId[b.id] = si; }));

  // Resolves the columns context for a block: whether it's currently inside a
  // side-by-side pair (→ Swap/Stack, on `columnsDivider`), can flip an existing
  // neighbouring divider to columns (→ Split, on `splitDivider`), or can split
  // its own section at itself (→ Split, inserting a divider before `splitBefore`).
  type ColumnsCtx = { columnsDivider?: MarkdownDividerBlock; splitDivider?: MarkdownDividerBlock; splitBefore?: string };
  const columnsContextForBlock = (block: MarkdownBlock): ColumnsCtx => {
    if (block.type === 'divider') {
      const d = block as MarkdownDividerBlock;
      if (d.layout === 'columns' && dividerCanColumnsById[d.id]) return { columnsDivider: d };
      if (dividerCanColumnsById[d.id]) return { splitDivider: d };
      return {};
    }
    const si = sectionIdxByBlockId[block.id];
    if (si === undefined) return {};
    const closing = sectionDividers[si] as MarkdownDividerBlock | undefined;      // divider after this section
    const opening = sectionDividers[si - 1] as MarkdownDividerBlock | undefined;  // divider before this section
    const isLeft = closing?.type === 'divider' && closing.layout === 'columns' && (sections[si]?.length ?? 0) > 0 && (sections[si + 1]?.length ?? 0) > 0;
    const isRight = opening?.type === 'divider' && opening.layout === 'columns' && (sections[si - 1]?.length ?? 0) > 0 && (sections[si]?.length ?? 0) > 0;
    if (isLeft) return { columnsDivider: closing };
    if (isRight) return { columnsDivider: opening };
    // Not in a columns pair — offer a split. Prefer splitting this section at
    // the block itself; fall back to pairing with a non-empty neighbour.
    const sec = sections[si] ?? [];
    if (sec.findIndex(b => b.id === block.id) > 0) return { splitBefore: block.id };
    if (opening && (sections[si - 1]?.length ?? 0) > 0) return { splitDivider: opening };
    if (closing && (sections[si + 1]?.length ?? 0) > 0) return { splitDivider: closing };
    return {};
  };

  interface ContextMenuItem { icon: string; label: string; onClick?: () => void; danger?: boolean; active?: boolean; submenu?: ContextMenuItem[]; }
  const TURN_INTO_OPTIONS: { icon: string; label: string; type: TextConvertType; level?: 1 | 2 | 3 }[] = [
    { icon: 'notes', label: 'Text', type: 'paragraph' },
    { icon: 'format_h1', label: 'Heading 1', type: 'heading', level: 1 },
    { icon: 'format_h2', label: 'Heading 2', type: 'heading', level: 2 },
    { icon: 'format_h3', label: 'Heading 3', type: 'heading', level: 3 },
    { icon: 'format_list_bulleted', label: 'Bulleted list', type: 'bulleted-list-item' },
    { icon: 'format_list_numbered', label: 'Numbered list', type: 'numbered-list-item' },
    { icon: 'check_box', label: 'To-do', type: 'todo' },
    { icon: 'format_quote', label: 'Quote', type: 'quote' },
  ];
  const contextMenuItemsForBlock = (block: MarkdownBlock): ContextMenuItem[] => {
    const ctx = columnsContextForBlock(block);
    const items: ContextMenuItem[] = [];
    if (ctx.columnsDivider) {
      const id = ctx.columnsDivider.id;
      items.push({ icon: 'swap_horiz', label: 'Swap columns', onClick: () => swapColumns(id) });
      items.push({ icon: 'view_agenda', label: 'Stack vertically', onClick: () => toggleColumnsLayout(id, 'stack') });
    } else if (ctx.splitDivider) {
      const id = ctx.splitDivider.id;
      items.push({ icon: 'view_column', label: 'Split side by side', onClick: () => toggleColumnsLayout(id, 'columns') });
    } else if (ctx.splitBefore) {
      const id = ctx.splitBefore;
      items.push({ icon: 'view_column', label: 'Split into columns here', onClick: () => splitBeforeBlock(id) });
    }
    if (hasText(block)) {
      const cur = block as TextBlock;
      items.push({
        icon: 'sync_alt', label: 'Turn into',
        submenu: TURN_INTO_OPTIONS.map(o => ({
          icon: o.icon, label: o.label,
          active: cur.type === o.type && (o.type !== 'heading' || (cur as MarkdownHeadingBlock).level === o.level),
          onClick: () => changeBlockType(block.id, o.type, o.level),
        })),
      });
    }
    if (block.type !== 'divider' && blocks.length > 1) {
      items.push({ icon: 'delete', label: 'Delete block', danger: true, onClick: () => deleteBlock(block.id) });
    } else if (block.type === 'divider') {
      items.push({ icon: 'delete', label: 'Remove divider', danger: true, onClick: () => deleteBlock(block.id) });
    }
    return items;
  };

  const openContextMenu = (block: MarkdownBlock, e: React.MouseEvent) => {
    // Let the native menu through for the actively-edited textarea (copy /
    // paste / spellcheck) — the custom menu is for the block chrome/preview.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (contextMenuItemsForBlock(block).length === 0) return;
    e.preventDefault();
    setCtxSubmenuOpen(false);
    setContextMenu({ blockId: block.id, x: e.clientX, y: e.clientY });
  };

  // Vertical center (px from the block row's top) of a block's first text line,
  // so the drag grip and delete button line up with the content regardless of
  // block type — a heading's line sits much lower than a paragraph's, which the
  // old fixed padding ignored. Mirrors the paddings in `headingStyleFor` and
  // the per-type content wrappers below.
  const firstLineCenter = (block: MarkdownBlock): number => {
    if (block.type === 'heading') {
      const sizes = { 1: 26, 2: 21, 3: 17 } as const;
      return 4 /* wrapper */ + 10 /* heading pad-top */ + (sizes[block.level] * 1.35) / 2;
    }
    if (block.type === 'divider') return 4 + 10 + 0.75;      // the hr line
    if (block.type === 'image') return 4 + 8 + 10;           // near the image top
    if (block.type === 'link') return 4 + 8 + (13.5 * 1.4) / 2;
    const base = isMobile ? 14.5 : 15;                       // paragraph/list/todo/quote
    return 4 + 6 + (base * 1.6) / 2;
  };

  const renderBlock = (block: MarkdownBlock, index: number) => {
    const hovered = hoveredBlockId === block.id;
    const lineCenter = firstLineCenter(block);
    return (
      <div key={block.id}
        onMouseEnter={() => setHoveredBlockId(block.id)}
        onMouseLeave={() => setHoveredBlockId(prev => prev === block.id ? null : prev)}
        onContextMenu={e => openContextMenu(block, e)}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (dragBlockId && dragBlockId !== block.id) moveBlock(dragBlockId, block.id); setDragBlockId(null); }}
        style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span
          draggable={reorderMode}
          onDragStart={() => { if (reorderMode) setDragBlockId(block.id); }}
          title="Drag to reorder"
          style={{ cursor: reorderMode ? 'grab' : 'default', flexShrink: 0, width: 15, overflow: 'hidden', display: 'flex', alignItems: 'center', height: 15, marginTop: Math.max(0, lineCenter - 7.5), opacity: reorderMode ? 1 : 0, pointerEvents: reorderMode ? 'auto' : 'none', transition: 'opacity 160ms ease, margin-top 200ms cubic-bezier(0.22,1,0.36,1)' }}>
          <Icon name="drag_indicator" size={15} color="var(--color-primary)" />
        </span>

        <div style={{
          flex: 1, minWidth: 0, position: 'relative',
          borderRadius: block.type === 'image' ? 8 : 0,
          padding: block.type === 'divider' ? '4px 14px' : block.type === 'image' ? 8 : '4px 6px',
          // Only clip for images (rounds off the photo's corners) —
          // everything else may host an absolutely positioned popover (the
          // slash-command menu) that must be free to overflow.
          overflow: block.type === 'image' ? 'hidden' : 'visible',
        }}>
          {block.type === 'divider' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <hr style={{ flex: 1, border: 'none', borderTop: '1.5px solid var(--color-border)', margin: '10px 0' }} />
              {dividerCanColumnsById[block.id] && (
                <button
                  onClick={() => toggleColumnsLayout(block.id, 'columns')}
                  title="Arrange the sections above and below side by side"
                  style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999, border: `1px solid ${hovered ? 'var(--color-primary)' : 'var(--color-border)'}`, background: hovered ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', transition: 'background 160ms ease, border-color 160ms ease' }}>
                  <Icon name="view_column" size={13} color={hovered ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: hovered ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>Side by side</span>
                </button>
              )}
            </div>
          ) : block.type === 'image' ? (
            <div>
              <img src={markdownImageUrl(mdId, block.imageId)} alt={block.caption ?? ''} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
              <input value={block.caption ?? ''} placeholder="Add a caption…"
                onChange={e => updateBlocks(prev => prev.map(b => b.id === block.id ? { ...b, caption: e.target.value } as MarkdownBlock : b))}
                style={{ marginTop: 6, padding: '0 4px 4px', width: '100%', fontFamily: 'var(--font-body)', fontSize: 12.5, fontStyle: 'italic', color: 'var(--color-text-tertiary)', border: 'none', outline: 'none', background: 'transparent' }} />
            </div>
          ) : block.type === 'link' ? (
            <a href={block.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'flex', flexDirection: 'column', gap: 3, textDecoration: 'none', padding: '8px 2px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-primary)' }}>
                <Icon name="link" size={14} color="var(--color-primary)" /> {block.title || block.url}
              </span>
              {block.description && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{block.description}</span>}
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.url}</span>
            </a>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              {block.type === 'bulleted-list-item' && <span style={{ paddingTop: 9, color: 'var(--color-text-tertiary)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>•</span>}
              {block.type === 'numbered-list-item' && <span style={{ paddingTop: 8, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, flexShrink: 0, minWidth: 16 }}>{numberByBlockId[block.id]}.</span>}
              {block.type === 'todo' && (
                <div onClick={() => toggleTodo(block)}
                  style={{ marginTop: 8, width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: block.checked ? 'var(--color-primary)' : 'var(--color-border-strong)', background: block.checked ? 'var(--color-primary)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
                  {block.checked && <Checkmark />}
                </div>
              )}
              {block.type === 'quote' && <span style={{ width: 3, alignSelf: 'stretch', background: 'var(--color-border-strong)', borderRadius: 2, flexShrink: 0, marginTop: 8, marginBottom: 8 }} />}
              {hasText(block) && (focusedBlockId === block.id ? (
                <AutoTextarea
                  innerRef={el => { blockRefs.current[block.id] = el; }}
                  value={block.text}
                  placeholder={index === 0 && blocks.length === 1 ? "Type '/' for commands, or just start writing…" : ''}
                  onChange={v => handleTextChange(block, v)}
                  onKeyDown={e => handleKeyDown(e, block, index)}
                  onBlur={() => setFocusedBlockId(prev => (prev === block.id ? null : prev))}
                  style={headingStyleFor(block, isMobile)}
                />
              ) : (
                <div
                  onClick={() => focusBlock(block.id, true)}
                  style={{ ...headingStyleFor(block, isMobile), cursor: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: '1.6em' }}>
                  {block.text
                    ? renderInline(block.text, block.id)
                    : <span style={{ color: 'var(--color-text-quaternary)' }}>{index === 0 && blocks.length === 1 ? "Type '/' for commands, or just start writing…" : ' '}</span>}
                </div>
              ))}
            </div>
          )}

          {slashMenu?.blockId === block.id && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', border: '1px solid var(--color-border)', minWidth: 220, maxHeight: 260, overflowY: 'auto', zIndex: 210, animation: 'menuIn 140ms ease both' }}>
            {filteredCommands(slashMenu.query).length === 0 && (
              <div style={{ padding: '10px 14px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)' }}>No matching command</div>
            )}
            {filteredCommands(slashMenu.query).map(cmd => (
              <button key={cmd.cmd} onMouseDown={e => { e.preventDefault(); applyCommand(block.id, cmd); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                <Icon name={cmd.icon} size={16} color="var(--color-primary)" />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)' }}>{cmd.label}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>/{cmd.cmd}</span>
              </button>
            ))}
            </div>
          )}

          {linkEditingBlockId === block.id && (
            <div style={{ marginTop: 6, padding: 14, border: '1.5px solid var(--color-border)', borderRadius: 12, background: 'var(--color-purple-pale-7)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input autoFocus value={linkDraft.url} onChange={e => setLinkDraft(d => ({ ...d, url: e.target.value }))} placeholder="https://…"
                style={{ fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <input value={linkDraft.title} onChange={e => setLinkDraft(d => ({ ...d, title: e.target.value }))} placeholder="Title (optional)"
                style={{ fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <input value={linkDraft.description} onChange={e => setLinkDraft(d => ({ ...d, description: e.target.value }))} placeholder="Description (optional)"
                style={{ fontFamily: 'var(--font-body)', fontSize: 13, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setLinkEditingBlockId(null)} style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 7, padding: '7px 14px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={saveLinkBlock} disabled={!linkDraft.url.trim()}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-white)', background: linkDraft.url.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: linkDraft.url.trim() ? 'pointer' : 'not-allowed' }}>Save link</button>
              </div>
            </div>
          )}
        </div>

        <button onClick={() => deleteBlock(block.id)} title="Delete block"
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, marginTop: Math.max(0, lineCenter - 11), borderRadius: 5, border: 'none', background: 'transparent', cursor: 'pointer', opacity: hovered ? 1 : 0, transition: 'opacity 120ms ease, margin-top 200ms cubic-bezier(0.22,1,0.36,1), background 120ms ease' }}
          onMouseEnter={e => { if (hovered) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Icon name="close" size={13} color="var(--color-text-quaternary)" />
        </button>
      </div>
    );
  };

  // Renders a `layout: 'columns'` divider's two flanking sections as a
  // side-by-side grid (capped at 2 boxes). An always-visible toolbar sits above
  // the row with a one-click **Swap** (the only possible reorder with exactly
  // 2 boxes), **Stack** (un-split), and **Remove**. Each box also carries a
  // top grip handle so it can be dragged onto the other box to swap — while a
  // drag is in flight the target column lights up so the drop is obvious.
  const renderColumnsRow = (leftBlocks: MarkdownBlock[], rightBlocks: MarkdownBlock[], divider: MarkdownDividerBlock) => {
    const rowHovered = hoveredColumnsRowId === divider.id;
    const dragging = dragColumnHandle?.dividerId === divider.id;

    const toolbarBtn: React.CSSProperties = {
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999,
      border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer',
      fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)',
      transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
    };
    const hoverIn = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'var(--color-surface-tint)'; e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; };
    const hoverOut = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; };

    return (
      <div key={divider.id}
        onMouseEnter={() => setHoveredColumnsRowId(divider.id)}
        onMouseLeave={() => setHoveredColumnsRowId(prev => prev === divider.id ? null : prev)}
        style={{ animation: 'viewSwitchIn 260ms cubic-bezier(0.22,1,0.36,1) both' }}>
        {/* Toolbar — always visible so the controls are never a mystery */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
          {!isMobile && (
            <button onClick={() => swapColumns(divider.id)} title="Swap the two columns" style={toolbarBtn} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
              <Icon name="swap_horiz" size={14} color="currentColor" />
              <span>Swap</span>
            </button>
          )}
          <button onClick={() => toggleColumnsLayout(divider.id, 'stack')} title="Stack sections vertically" style={toolbarBtn} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
            <Icon name="view_agenda" size={13} color="currentColor" />
            <span>Stack</span>
          </button>
          <button onClick={() => deleteBlock(divider.id)} title="Remove divider" style={{ ...toolbarBtn, padding: '5px 8px' }} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
            <Icon name="close" size={13} color="currentColor" />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {[leftBlocks, rightBlocks].map((sideBlocks, colIdx) => {
            const col = colIdx as 0 | 1;
            const isDropTarget = dragging && dragColumnHandle!.col !== col;
            const isSource = dragging && dragColumnHandle!.col === col;
            return (
              <div key={colIdx}
                onDragOver={e => { if (dragging) e.preventDefault(); }}
                onDrop={e => {
                  e.preventDefault();
                  if (dragColumnHandle && dragColumnHandle.dividerId === divider.id && dragColumnHandle.col !== col) swapColumns(divider.id);
                  setDragColumnHandle(null);
                }}
                style={{
                  position: 'relative', minWidth: 0,
                  border: `1.5px solid ${isDropTarget ? 'var(--color-primary)' : 'var(--color-border-alt)'}`,
                  borderRadius: 12,
                  background: isDropTarget ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)',
                  boxShadow: isDropTarget ? '0 0 0 3px rgba(var(--color-primary-rgb), 0.12)' : 'none',
                  opacity: isSource ? 0.55 : 1,
                  padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2,
                  transition: 'border-color 140ms ease, background 140ms ease, box-shadow 140ms ease, opacity 140ms ease',
                }}>
                {!isMobile && (
                  <div style={{ display: 'flex', justifyContent: 'center', height: rowHovered || dragging ? 16 : 0, marginBottom: rowHovered || dragging ? 2 : 0, overflow: 'hidden', opacity: rowHovered || dragging ? 1 : 0, transition: 'opacity 140ms ease, height 200ms cubic-bezier(0.22,1,0.36,1), margin-bottom 200ms cubic-bezier(0.22,1,0.36,1)' }}>
                    <span
                      draggable
                      onDragStart={() => setDragColumnHandle({ dividerId: divider.id, col })}
                      onDragEnd={() => setDragColumnHandle(null)}
                      title="Drag onto the other column to swap"
                      style={{ cursor: 'grab', display: 'flex', alignItems: 'center', gap: 2, padding: '0 12px', borderRadius: 999, lineHeight: 1 }}>
                      <Icon name="drag_indicator" size={14} color="var(--color-border-strong)" />
                    </span>
                  </div>
                )}
                {sideBlocks.map(b => renderBlock(b, blockIndexById[b.id]))}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center', padding: isMobile ? '20px 16px 80px' : '40px 24px 120px' }}>
      <div style={{ width: '100%', maxWidth: fullWidth ? 1400 : 760, transition: 'max-width 320ms cubic-bezier(0.22,1,0.36,1)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 24 }}>
          <span style={{ fontSize: 34, lineHeight: 1.2 }}>{emoji || '📝'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {nameEditing ? (
                <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                  onBlur={handleNameSave} onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setNameEditing(false); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', border: 'none', borderBottom: '2px solid var(--color-primary)', outline: 'none', width: '100%', background: 'transparent' }} />
              ) : (
                <h1 onClick={() => { setNameDraft(name); setNameEditing(true); }}
                  style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', margin: 0, cursor: 'text', overflowWrap: 'break-word' }}>
                  {name}
                </h1>
              )}
              <SaveStatusDot state={saveState} />
            </div>
            {subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => setReorderMode(r => !r)}
            title={reorderMode ? 'Done reordering' : 'Reorder blocks'}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 32, width: isMobile ? 32 : undefined, padding: isMobile ? 0 : '0 11px', borderRadius: 8, border: `1px solid ${reorderMode ? 'var(--color-primary)' : 'var(--color-border)'}`, background: reorderMode ? 'var(--color-primary)' : 'var(--color-white)', cursor: 'pointer', transition: 'all 120ms', flexShrink: 0 }}
            onMouseEnter={e => { if (!reorderMode) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
            onMouseLeave={e => { if (!reorderMode) e.currentTarget.style.background = 'var(--color-white)'; }}>
            <Icon name="swap_vert" size={15} color={reorderMode ? 'var(--color-white)' : 'var(--color-primary)'} />
            {!isMobile && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: reorderMode ? 'var(--color-white)' : 'var(--color-primary)' }}>{reorderMode ? 'Done' : 'Reorder'}</span>}
          </button>
          {todoListId && (
            <button
              onClick={() => navigate(`/list/${todoListId}`)}
              title="Open this page's Todo list"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 32, width: isMobile ? 32 : undefined, padding: isMobile ? 0 : '0 11px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', transition: 'all 120ms', animation: 'menuIn 160ms ease both', flexShrink: 0 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-green-pale-1)'; e.currentTarget.style.borderColor = 'var(--color-success)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
              <Icon name="checklist" size={15} color="var(--color-success)" />
              {!isMobile && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-success)' }}>Todo list</span>}
            </button>
          )}
          <MarkdownListAIAssist
            markdownListId={mdId}
            markdownListName={name}
            onUpdated={(updatedBlocks, updatedTodoListId) => {
              setBlocks(updatedBlocks.length > 0 ? updatedBlocks : [makeEmptyBlock('paragraph')]);
              setTodoListId(updatedTodoListId);
            }}
          />
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setMenuOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer' }}>
              <Icon name="more_vert" size={16} color="var(--color-text-tertiary)" />
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
                <div style={{ position: 'absolute', top: 38, right: 0, background: 'var(--color-white)', borderRadius: 10, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', border: '1px solid var(--color-border)', minWidth: 180, zIndex: 200, overflow: 'hidden', animation: 'menuIn 160ms ease both' }}>
                  {todoListId && (
                    <button onClick={() => { setMenuOpen(false); navigate(`/list/${todoListId}`); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                      <Icon name="check_circle" size={16} color="var(--color-text-tertiary)" /> View Todo list
                    </button>
                  )}
                  <button onClick={() => { setMenuOpen(false); setShowSettings(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-text-primary)', textAlign: 'left' }}>
                    <Icon name="tune" size={16} color="var(--color-text-tertiary)" /> More settings…
                  </button>
                  <button onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, color: 'var(--color-error)', textAlign: 'left' }}>
                    <Icon name="delete" size={16} color="var(--color-error)" /> Delete
                  </button>
                </div>
              </>
            )}
          </div>
          </div>
        </div>

        {/* Blocks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(() => {
            // A `layout: 'columns'` divider consumes the section right after
            // it too, rendering both as one side-by-side row instead of the
            // usual stacked section-then-divider sequence — everything else
            // renders exactly as before.
            const rows: React.ReactNode[] = [];
            let i = 0;
            while (i < sections.length) {
              const sectionBlocks = sections[i];
              const divider = sectionDividers[i] as MarkdownDividerBlock | undefined;
              const nextSection = sections[i + 1];
              if (divider?.layout === 'columns' && sectionBlocks.length > 0 && nextSection && nextSection.length > 0) {
                rows.push(renderColumnsRow(sectionBlocks, nextSection, divider));
                i += 2;
                continue;
              }
              if (sectionBlocks.length > 0) {
                rows.push(
                  <div key={`section-${i}`} style={{ border: '1px solid var(--color-border-alt)', borderRadius: 12, background: 'var(--color-surface-gray)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2, animation: 'viewSwitchIn 260ms cubic-bezier(0.22,1,0.36,1) both' }}>
                    {sectionBlocks.map(block => renderBlock(block, blockIndexById[block.id]))}
                  </div>
                );
              }
              if (divider) rows.push(<Fragment key={`divider-${divider.id}`}>{renderBlock(divider, blockIndexById[divider.id])}</Fragment>);
              i += 1;
            }
            return rows;
          })()}
        </div>

        <button onClick={() => { const b = makeEmptyBlock('paragraph'); addBlockAfter(blocks[blocks.length - 1]?.id ?? '', b); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '9px 12px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-tertiary)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Icon name="add" size={16} color="var(--color-text-tertiary)" /> Add block
        </button>
      </div>

      {showSettings && mdId && (
        <ItemSettingsModal
          kind="markdownList"
          name={name}
          emoji={emoji}
          color={color}
          isPublic={isPublic}
          fullWidth={fullWidth}
          itemId={mdId}
          share={shareInfo}
          onShareUpdated={(s: ShareInfo) => setShareInfo({ enabled: s.enabled, token: s.token, hasPassword: s.hasPassword, expiresAt: s.expiresAt })}
          onVisibilityApplied={(p: boolean) => setIsPublic(p)}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {uploadTargetBlockId && (
        <ImageUploadModal
          markdownListId={mdId}
          isMobile={isMobile}
          onUploaded={image => handleImageUploaded(uploadTargetBlockId, image)}
          onClose={() => setUploadTargetBlockId(null)}
        />
      )}

      {showDeleteDialog && createPortal(
        <div onClick={() => setShowDeleteDialog(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete "{name}"?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              This markdown list{todoListId ? ' and its Todo list' : ''} will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {contextMenu && (() => {
        const targetBlock = blocks.find(b => b.id === contextMenu.blockId);
        const items = targetBlock ? contextMenuItemsForBlock(targetBlock) : [];
        if (items.length === 0) return null;
        const MENU_W = 224;
        const SUB_W = 190;
        const estH = items.length * 40 + 10;
        const left = Math.min(contextMenu.x, window.innerWidth - MENU_W - 10);
        const top = Math.min(contextMenu.y, window.innerHeight - estH - 10);
        // Flip the flyout to the parent's left edge when it would overflow.
        const subOnLeft = left + MENU_W + SUB_W + 12 > window.innerWidth;
        const itemStyle = (danger?: boolean): React.CSSProperties => ({
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 12px', background: 'none',
          border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-heading)',
          fontSize: 13, fontWeight: 500, color: danger ? 'var(--color-error)' : 'var(--color-text-primary)',
          transition: 'background 120ms ease',
        });
        return createPortal(
          <>
            <div onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 1190 }} />
            <div style={{ position: 'fixed', left, top, minWidth: MENU_W, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', border: '1px solid var(--color-border)', padding: 5, zIndex: 1200, animation: 'menuIn 150ms cubic-bezier(0.22,1,0.36,1) both' }}>
              {items.map((item, ii) => {
                if (item.submenu) {
                  // Outer "bridge" wrapper is transparent and carries a 6px side
                  // padding so the pointer can travel from the parent row to the
                  // card without crossing a dead zone that would collapse it.
                  const bridgePos: React.CSSProperties = subOnLeft
                    ? { right: '100%', paddingRight: 6 }
                    : { left: '100%', paddingLeft: 6 };
                  return (
                    <div key={ii} style={{ position: 'relative' }}
                      onMouseEnter={() => setCtxSubmenuOpen(true)}
                      onMouseLeave={() => setCtxSubmenuOpen(false)}>
                      <button style={{ ...itemStyle(), background: ctxSubmenuOpen ? 'var(--color-surface-tint)' : 'none' }}>
                        <Icon name={item.icon} size={16} color="var(--color-primary)" />
                        <span style={{ flex: 1 }}>{item.label}</span>
                        <Icon name={subOnLeft ? 'chevron_left' : 'chevron_right'} size={16} color="var(--color-text-quaternary)" />
                      </button>
                      {ctxSubmenuOpen && (
                        <div style={{ position: 'absolute', top: -5, ...bridgePos, zIndex: 1201 }}>
                          <div style={{ minWidth: SUB_W, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', border: '1px solid var(--color-border)', padding: 5, animation: 'menuIn 140ms cubic-bezier(0.22,1,0.36,1) both', transformOrigin: subOnLeft ? 'right top' : 'left top' }}>
                            {item.submenu.map((sub, si) => (
                              <button key={si}
                                onClick={() => { sub.onClick?.(); setContextMenu(null); }}
                                style={{ ...itemStyle(), background: sub.active ? 'var(--color-surface-tint)' : 'none', color: sub.active ? 'var(--color-primary)' : 'var(--color-text-primary)', fontWeight: sub.active ? 600 : 500 }}
                                onMouseEnter={e => { if (!sub.active) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = sub.active ? 'var(--color-surface-tint)' : 'none'; }}>
                                <Icon name={sub.icon} size={16} color={sub.active ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                                <span style={{ flex: 1 }}>{sub.label}</span>
                                {sub.active && <Icon name="check" size={15} color="var(--color-primary)" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <button key={ii}
                    onClick={() => { item.onClick?.(); setContextMenu(null); }}
                    style={itemStyle(item.danger)}
                    onMouseEnter={e => (e.currentTarget.style.background = item.danger ? 'var(--color-error-bg)' : 'var(--color-surface-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                    <Icon name={item.icon} size={16} color={item.danger ? 'var(--color-error)' : 'var(--color-primary)'} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </>,
          document.body
        );
      })()}
    </div>
  );
}

function headingStyleFor(block: MarkdownBlock, isMobile: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)', fontSize: isMobile ? 14.5 : 15, color: 'var(--color-text-primary)', lineHeight: 1.6,
    border: 'none', outline: 'none', background: 'transparent', width: '100%', resize: 'none', padding: '6px 0',
    // Smoothly morph when a block is converted to another type via the
    // right-click "Turn into" menu (e.g. H1 → H2 eases its size/weight).
    transition: 'font-size 240ms cubic-bezier(0.22,1,0.36,1), padding 240ms cubic-bezier(0.22,1,0.36,1), color 180ms ease, font-weight 180ms ease',
  };
  if (block.type === 'heading') {
    const sizes = { 1: 26, 2: 21, 3: 17 } as const;
    return { ...base, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: sizes[block.level], padding: '10px 0 4px' };
  }
  if (block.type === 'quote') return { ...base, fontStyle: 'italic', color: 'var(--color-text-secondary)' };
  // Matches TaskItem.tsx's checked-title treatment: opacity + strikethrough together.
  if (block.type === 'todo' && block.checked) return { ...base, opacity: 0.4, textDecoration: 'line-through' };
  return base;
}

// Auto-resizing single-column textarea shared by every text-bearing block.
interface AutoTextareaProps {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  style: React.CSSProperties;
  innerRef: (el: HTMLTextAreaElement | null) => void;
}
function AutoTextarea({ value, placeholder, onChange, onKeyDown, onBlur, style, innerRef }: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(resize, [value]);
  return (
    <textarea
      ref={el => { ref.current = el; innerRef(el); }}
      value={value}
      placeholder={placeholder}
      rows={1}
      autoFocus
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={resize}
      onBlur={onBlur}
      style={style}
    />
  );
}
