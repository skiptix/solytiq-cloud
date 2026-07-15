import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createPortal, flushSync } from 'react-dom';
import type {
  MarkdownBlock, MarkdownBlockType, MarkdownTodoBlock, MarkdownImageBlock, MarkdownLinkBlock,
  MarkdownHeadingBlock, MarkdownParagraphBlock, MarkdownBulletListItemBlock, MarkdownNumberedListItemBlock, MarkdownQuoteBlock,
} from '../types';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import { useMobile } from '../hooks/useBreakpoint';
import Icon from '../components/Icon';
import { renderInline } from '../components/MarkdownView';
import { toggleWrap, formatMarkerForKeyDown } from '../utils/textFormatting';
import { apiUploadMarkdownImage, markdownImageUrl, type ShareInfo } from '../api/client';
import ItemSettingsModal, { type ItemSettingsUpdates } from '../modals/ItemSettingsModal';

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget && !uploading) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: isMobile ? '100%' : 440, boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f1ecf6' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Add image</span>
          <button onClick={onClose} disabled={uploading} style={{ background: 'none', border: 'none', cursor: uploading ? 'default' : 'pointer', display: 'flex', padding: 2, opacity: uploading ? 0.4 : 1 }}>
            <Icon name="close" size={18} color="#787584" />
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
              border: `2px dashed ${dragOver ? '#5e4dbb' : '#e8e4f0'}`, borderRadius: 14, padding: '40px 20px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: uploading ? 'default' : 'pointer',
              background: dragOver ? '#F5F3FF' : '#faf9fc', transition: 'all 150ms',
            }}>
            <Icon name={uploading ? 'progress_activity' : 'add_photo_alternate'} size={32} color="#9d8dff" />
            {uploading ? (
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>Uploading… {progress}%</span>
            ) : (
              <>
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#1c1b22' }}>Drag & drop an image</span>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>or click to browse — PNG, JPEG, WEBP or GIF, up to 15MB</span>
              </>
            )}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          </div>
          {error && <div style={{ marginTop: 12, padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a' }}>{error}</div>}
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
  // Which block currently shows a raw, editable textarea. Every other
  // text-bearing block shows its formatted (bold/italic/strikethrough)
  // rendering instead — click it to switch into edit mode.
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);

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
          next[idx] = { id: blockId, type: 'divider' };
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
    // Markdown lists don't expose the Folder tab (no folder-nesting UI yet),
    // so `folderId` never actually arrives here in practice — the cast just
    // satisfies ItemSettingsUpdates' shared shape (folderId: string | null)
    // against the store's Partial<MarkdownList> (folderId?: string).
    void update(mdId, updates as Parameters<typeof update>[1]);
  };

  if (loading) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#787584', fontFamily: 'Inter, sans-serif', fontSize: 14 }}>Loading…</div>;
  }
  if (notFound || !mdId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Icon name="notes" size={40} color="#c9c4d5" />
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Markdown list not found</div>
        <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer' }}>Back to Dashboard</button>
      </div>
    );
  }

  const saveLabel = saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Failed to save' : saveState === 'saved' ? 'Saved' : '';

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

  const renderBlock = (block: MarkdownBlock, index: number) => {
    const hovered = hoveredBlockId === block.id;
    return (
      <div key={block.id}
        onMouseEnter={() => setHoveredBlockId(block.id)}
        onMouseLeave={() => setHoveredBlockId(prev => prev === block.id ? null : prev)}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (dragBlockId && dragBlockId !== block.id) moveBlock(dragBlockId, block.id); setDragBlockId(null); }}
        style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span
          draggable
          onDragStart={() => setDragBlockId(block.id)}
          title="Drag to reorder"
          style={{ cursor: 'grab', flexShrink: 0, width: 15, overflow: 'hidden', display: 'flex', alignItems: 'center', paddingTop: 12, opacity: hovered ? 1 : 0, transition: 'opacity 120ms' }}>
          <Icon name="drag_indicator" size={15} color="#c9c4d5" />
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
            <hr style={{ border: 'none', borderTop: '1.5px solid #e8e4f0', margin: '10px 0' }} />
          ) : block.type === 'image' ? (
            <div>
              <img src={markdownImageUrl(mdId, block.imageId)} alt={block.caption ?? ''} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
              <input value={block.caption ?? ''} placeholder="Add a caption…"
                onChange={e => updateBlocks(prev => prev.map(b => b.id === block.id ? { ...b, caption: e.target.value } as MarkdownBlock : b))}
                style={{ marginTop: 6, padding: '0 4px 4px', width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 12.5, fontStyle: 'italic', color: '#787584', border: 'none', outline: 'none', background: 'transparent' }} />
            </div>
          ) : block.type === 'link' ? (
            <a href={block.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'flex', flexDirection: 'column', gap: 3, textDecoration: 'none', padding: '8px 2px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#5e4dbb' }}>
                <Icon name="link" size={14} color="#5e4dbb" /> {block.title || block.url}
              </span>
              {block.description && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584' }}>{block.description}</span>}
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.url}</span>
            </a>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              {block.type === 'bulleted-list-item' && <span style={{ paddingTop: 9, color: '#787584', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>•</span>}
              {block.type === 'numbered-list-item' && <span style={{ paddingTop: 8, color: '#787584', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, flexShrink: 0, minWidth: 16 }}>{numberByBlockId[block.id]}.</span>}
              {block.type === 'todo' && (
                <div onClick={() => toggleTodo(block)}
                  style={{ marginTop: 8, width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: block.checked ? '#5e4dbb' : '#c9c4d5', background: block.checked ? '#5e4dbb' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 }}>
                  {block.checked && <Checkmark />}
                </div>
              )}
              {block.type === 'quote' && <span style={{ width: 3, alignSelf: 'stretch', background: '#c9c4d5', borderRadius: 2, flexShrink: 0, marginTop: 8, marginBottom: 8 }} />}
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
                    : <span style={{ color: '#b0acbe' }}>{index === 0 && blocks.length === 1 ? "Type '/' for commands, or just start writing…" : ' '}</span>}
                </div>
              ))}
            </div>
          )}

          {slashMenu?.blockId === block.id && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.16)', border: '1px solid #e8e4f0', minWidth: 220, maxHeight: 260, overflowY: 'auto', zIndex: 210, animation: 'menuIn 140ms ease both' }}>
            {filteredCommands(slashMenu.query).length === 0 && (
              <div style={{ padding: '10px 14px', fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#b0acbe' }}>No matching command</div>
            )}
            {filteredCommands(slashMenu.query).map(cmd => (
              <button key={cmd.cmd} onMouseDown={e => { e.preventDefault(); applyCommand(block.id, cmd); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                <Icon name={cmd.icon} size={16} color="#5e4dbb" />
                <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22' }}>{cmd.label}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontSize: 11, color: '#b0acbe' }}>/{cmd.cmd}</span>
              </button>
            ))}
            </div>
          )}

          {linkEditingBlockId === block.id && (
            <div style={{ marginTop: 6, padding: 14, border: '1.5px solid #e8e4f0', borderRadius: 12, background: '#faf9fc', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input autoFocus value={linkDraft.url} onChange={e => setLinkDraft(d => ({ ...d, url: e.target.value }))} placeholder="https://…"
                style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <input value={linkDraft.title} onChange={e => setLinkDraft(d => ({ ...d, title: e.target.value }))} placeholder="Title (optional)"
                style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <input value={linkDraft.description} onChange={e => setLinkDraft(d => ({ ...d, description: e.target.value }))} placeholder="Description (optional)"
                style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 10px', outline: 'none' }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setLinkEditingBlockId(null)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 7, padding: '7px 14px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={saveLinkBlock} disabled={!linkDraft.url.trim()}
                  style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#fff', background: linkDraft.url.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: linkDraft.url.trim() ? 'pointer' : 'not-allowed' }}>Save link</button>
              </div>
            </div>
          )}
        </div>

        <button onClick={() => deleteBlock(block.id)} title="Delete block"
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, marginTop: 12, borderRadius: 5, border: 'none', background: 'transparent', cursor: 'pointer', opacity: hovered ? 1 : 0, transition: 'opacity 120ms' }}>
          <Icon name="close" size={13} color="#b0acbe" />
        </button>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center', padding: isMobile ? '20px 16px 80px' : '40px 24px 120px' }}>
      <div style={{ width: '100%', maxWidth: 760 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 34, lineHeight: 1.2 }}>{emoji || '📝'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {nameEditing ? (
              <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                onBlur={handleNameSave} onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setNameEditing(false); }}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', border: 'none', borderBottom: '2px solid #5e4dbb', outline: 'none', width: '100%', background: 'transparent' }} />
            ) : (
              <h1 onClick={() => { setNameDraft(name); setNameEditing(true); }}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 28, fontWeight: 700, color: '#1c1b22', margin: 0, cursor: 'text', overflowWrap: 'break-word' }}>
                {name}
              </h1>
            )}
            {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', marginTop: 4 }}>{subtitle}</div>}
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setMenuOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid #e8e4f0', background: '#fff', cursor: 'pointer' }}>
              <Icon name="more_vert" size={16} color="#787584" />
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
                <div style={{ position: 'absolute', top: 38, right: 0, background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', border: '1px solid #e8e4f0', minWidth: 180, zIndex: 200, overflow: 'hidden', animation: 'menuIn 160ms ease both' }}>
                  {todoListId && (
                    <button onClick={() => { setMenuOpen(false); navigate(`/list/${todoListId}`); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}>
                      <Icon name="check_circle" size={16} color="#787584" /> View Todo list
                    </button>
                  )}
                  <button onClick={() => { setMenuOpen(false); setShowSettings(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#1c1b22', textAlign: 'left' }}>
                    <Icon name="tune" size={16} color="#787584" /> More settings…
                  </button>
                  <button onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#ba1a1a', textAlign: 'left' }}>
                    <Icon name="delete" size={16} color="#ba1a1a" /> Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: saveState === 'error' ? '#ba1a1a' : '#b0acbe', marginBottom: 24, height: 14 }}>{saveLabel}</div>

        {/* Blocks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sections.map((sectionBlocks, i) => (
            <Fragment key={`section-${i}`}>
              {sectionBlocks.length > 0 && (
                <div style={{ border: '1px solid #E5E7EB', borderRadius: 12, background: '#F9FAFB', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {sectionBlocks.map(block => renderBlock(block, blockIndexById[block.id]))}
                </div>
              )}
              {sectionDividers[i] && renderBlock(sectionDividers[i], blockIndexById[sectionDividers[i].id])}
            </Fragment>
          ))}
        </div>

        <button onClick={() => { const b = makeEmptyBlock('paragraph'); addBlockAfter(blocks[blocks.length - 1]?.id ?? '', b); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '9px 12px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#787584' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Icon name="add" size={16} color="#787584" /> Add block
        </button>
      </div>

      {showSettings && mdId && (
        <ItemSettingsModal
          kind="markdownList"
          name={name}
          emoji={emoji}
          color={color}
          isPublic={isPublic}
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
        <div onClick={() => setShowDeleteDialog(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="#ba1a1a" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete "{name}"?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
              This markdown list{todoListId ? ' and its Todo list' : ''} will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function headingStyleFor(block: MarkdownBlock, isMobile: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: 'Inter, sans-serif', fontSize: isMobile ? 14.5 : 15, color: '#1c1b22', lineHeight: 1.6,
    border: 'none', outline: 'none', background: 'transparent', width: '100%', resize: 'none', padding: '6px 0',
  };
  if (block.type === 'heading') {
    const sizes = { 1: 26, 2: 21, 3: 17 } as const;
    return { ...base, fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, fontSize: sizes[block.level], padding: '10px 0 4px' };
  }
  if (block.type === 'quote') return { ...base, fontStyle: 'italic', color: '#484552' };
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
