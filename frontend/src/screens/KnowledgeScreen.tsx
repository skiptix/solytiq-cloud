// ---------------------------------------------------------------------------
// KnowledgeScreen (/knowledge) — the workspace's single Knowledge Base,
// rendered as a net.
//
// The page IS the graph: the base sits pinned at the centre (the same role the
// synthetic workspace node plays on the main Net), every term orbits it, and
// clicking a term opens EntryInspector as an overlay rather than pushing the
// canvas aside.
//
// Edges shown here are REAL entity_links, never canvas-only lines — the same
// invariant graph_canvases holds. Typing `[[Board]]` in a definition is what
// creates them, so the net can never drift from the relations the rest of the
// app sees.
// ---------------------------------------------------------------------------

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from '@/components/animate-ui/motion';
import { useNavigate } from 'react-router-dom';
import { useMobile } from '../hooks/useBreakpoint';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useKnowledgeBaseStore from '../store/useKnowledgeBaseStore';
import useAuthStore from '../store/useAuthStore';
import Icon from '../components/Icon';
import EntryInspector from '../components/knowledge/EntryInspector';
import { buildKnowledgeRootNode, buildRenderedHierarchy, type NetRenderNode } from '../utils/graphHierarchy';
import { blockTextLength } from '../utils/markdownBlocks';
import { ENTRY_TYPE_OPTIONS } from '../utils/knowledgeEntryTypes';
import { apiGetWorkspaceGraph, apiGetEntityLinks, apiGetWorkspaceMembers } from '../api/client';
import type { GraphEdge, GraphNode, MarkdownBlock, ResolvedLink, KnowledgeEntry } from '../types';
import type { MentionMember } from '../utils/mention';
import Spinner from '@/components/animate-ui/Spinner';

// A term's bubble grows with how much its definition actually holds — summary,
// aliases, and written block content — not just its explicit relation degree.
// Chars-per-unit and the cap are tuned so a rich entry noticeably out-sizes a
// stub without ever swamping a well-connected term's degree-based size (see
// nodeSize() in utils/graphLayout.ts, which this feeds into as bonus degree).
const INFO_WEIGHT_CHARS_PER_UNIT = 40;
const INFO_WEIGHT_MAX = 14;

function contentInfoWeight(entry: KnowledgeEntry): number {
  const chars = (entry.summary?.length ?? 0) + entry.aliases.join(' ').length + blockTextLength(entry.content?.blocks ?? []);
  const structureBonus = (entry.content?.blocks?.length ?? 0) * 0.5;
  return Math.min(chars / INFO_WEIGHT_CHARS_PER_UNIT + structureBonus, INFO_WEIGHT_MAX);
}

// Lazily loaded for the same reason the main Net's renderers are: the force
// simulation and its SVG layer shouldn't grow the bundle for anyone who never
// opens this page.
const NeuralGraph = lazy(() => import('../components/graph/NeuralGraph'));

const KB_ROOT_PREFIX = 'srn:knowledgeBase:';
const ENTRY_PREFIX = 'srn:knowledgeEntry:';

/** Entry id out of `srn:knowledgeEntry:<id>`, or null for any other node. */
function entryIdFromSrn(srn: string): string | null {
  return srn.startsWith(ENTRY_PREFIX) ? srn.slice(ENTRY_PREFIX.length) : null;
}

export default function KnowledgeScreen() {
  const isMobile = useMobile();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore(s => s.currentWorkspaceId);
  const workspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.currentWorkspaceId));
  const currentUserId = useAuthStore(s => s.userId);

  const {
    base, entries, suggestions, canWrite, loading, scanning,
    load, create, createEntry, updateEntry, saveEntryContent, removeEntry,
    scan, loadSuggestions, decideSuggestion,
  } = useKnowledgeBaseStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relations, setRelations] = useState<ResolvedLink[]>([]);
  const [neighborNodes, setNeighborNodes] = useState<GraphNode[]>([]);
  const [relationEdges, setRelationEdges] = useState<GraphEdge[]>([]);
  const [creating, setCreating] = useState(false);
  const [newTerm, setNewTerm] = useState('');
  const [createError, setCreateError] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [members, setMembers] = useState<MentionMember[]>([]);
  const graphRef = useRef<{ centerOn: (srn: string) => void; resetCamera: () => void; hasNode: (srn: string) => boolean } | null>(null);

  // Term search — filters the loaded entries client-side and, on pick, centers
  // + selects the matching node so NeuralGraph's own selection highlighting
  // (dim-neighbors, glow) does the actual "highlighting" for free.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Term-type filter, next to the search bar — same "empty = show all" convention
  // as the main Net's GraphControls entityTypes filter.
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const typeFilterRef = useRef<HTMLDivElement>(null);
  const toggleTypeFilter = useCallback((key: string) => {
    setTypeFilter((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);
  useEffect(() => {
    if (!typeFilterOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (typeFilterRef.current && !typeFilterRef.current.contains(e.target as Node)) setTypeFilterOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [typeFilterOpen]);

  useEffect(() => { if (workspaceId) void load(workspaceId); }, [workspaceId, load]);

  // `shortcut:create-knowledge-entry` — the screen owns this one because the
  // add dialog only makes sense while the Knowledge page is open.
  useEffect(() => {
    const onCreate = () => { if (canWrite) { setCreating(true); setCreateError(''); } };
    window.addEventListener('shortcut:create-knowledge-entry', onCreate);
    return () => window.removeEventListener('shortcut:create-knowledge-entry', onCreate);
  }, [canWrite]);
  useEffect(() => { if (base) void loadSuggestions(); }, [base, loadSuggestions]);

  useEffect(() => {
    if (!workspaceId) { setMembers([]); return; }
    let alive = true;
    apiGetWorkspaceMembers(workspaceId)
      .then(r => { if (alive) setMembers(r.members.filter(m => m.userId !== currentUserId).map(m => ({ id: m.userId, username: m.username, fullName: m.fullName ?? null }))); })
      .catch(() => { /* mentions simply stay unavailable */ });
    return () => { alive = false; };
  }, [workspaceId, currentUserId]);

  // Real relations for the net. The workspace graph payload is server-cached
  // and keyed on the workspace's sync cursor, so re-fetching it after an edit
  // is cheap and can never serve a stale generation.
  const entrySrnSet = useMemo(() => new Set(entries.map(e => `${ENTRY_PREFIX}${e.id}`)), [entries]);

  const reloadGraph = useCallback(async () => {
    if (!workspaceId || !base) { setRelationEdges([]); setNeighborNodes([]); return; }
    try {
      const g = await apiGetWorkspaceGraph(workspaceId, { limit: 2000 });
      const bySrn = new Map(g.nodes.map(n => [n.srn, n]));
      // `entry_of` is structural (the hierarchy already draws it) — showing it
      // as a relation would bury the authored ones under scaffolding.
      const touching = g.edges.filter(e =>
        e.linkType !== 'entry_of' && (entrySrnSet.has(e.src) || entrySrnSet.has(e.dst))
      );
      setRelationEdges(touching);
      // Anything an entry points at is worth rendering too — that's the whole
      // point of a definition that references a board.
      const neighbors = new Map<string, GraphNode>();
      for (const e of touching) {
        for (const srn of [e.src, e.dst]) {
          if (entrySrnSet.has(srn) || srn.startsWith(KB_ROOT_PREFIX)) continue;
          const n = bySrn.get(srn);
          if (n) neighbors.set(srn, n);
        }
      }
      setNeighborNodes([...neighbors.values()]);
    } catch {
      setRelationEdges([]);
      setNeighborNodes([]);
    }
  }, [workspaceId, base, entrySrnSet]);

  useEffect(() => { void reloadGraph(); }, [reloadGraph]);

  // The selected entry's own relation list, for the inspector.
  useEffect(() => {
    if (!selectedId) { setRelations([]); return; }
    let alive = true;
    apiGetEntityLinks('knowledgeEntry', selectedId)
      .then(r => {
        if (!alive) return;
        setRelations(Object.entries(r.linksByType)
          .filter(([type]) => type !== 'entry_of')
          .flatMap(([, links]) => links));
      })
      .catch(() => { if (alive) setRelations([]); });
    return () => { alive = false; };
  }, [selectedId, entries]);

  const rootNode = useMemo(
    () => (base && workspaceId ? buildKnowledgeRootNode(base.id, base.name, base.emoji, workspaceId) : null),
    [base, workspaceId]
  );

  // "empty filter = show all" — same convention as the main Net's GraphControls.
  // Filtered-out entries just aren't rendered; buildRenderedHierarchy walks any
  // neighbor whose owning entry got hidden up to the nearest still-rendered
  // ancestor (root, here), so nothing goes visually orphaned.
  const visibleEntries = useMemo(
    () => (typeFilter.length === 0 ? entries : entries.filter(e => typeFilter.includes(e.entryType))),
    [entries, typeFilter]
  );

  const entryNodes: NetRenderNode[] = useMemo(() => visibleEntries.map(e => ({
    srn: `${ENTRY_PREFIX}${e.id}`,
    type: 'knowledgeEntry' as const,
    id: e.id,
    title: e.term,
    emoji: e.emoji,
    color: e.color,
    deepLink: `/knowledge?entry=${e.id}`,
    // Degree drives node size, so a well-connected term reads as a hub.
    degree: relationEdges.filter(r => r.src === `${ENTRY_PREFIX}${e.id}` || r.dst === `${ENTRY_PREFIX}${e.id}`).length,
    // A richly-written term reads as bigger even with few explicit relations.
    infoWeight: contentInfoWeight(e),
    pagerank: 0,
    community: null,
    status: null,
    isArchived: false,
    workspaceId: workspaceId ?? undefined,
  })), [visibleEntries, relationEdges, workspaceId]);

  const renderNodes: NetRenderNode[] = useMemo(
    () => (rootNode ? [rootNode, ...entryNodes, ...neighborNodes] : []),
    [rootNode, entryNodes, neighborNodes]
  );

  // Everything hangs off the base: entries directly, and any referenced entity
  // beneath the entry that references it, so a board pulled in by a definition
  // reads as belonging to that definition rather than floating loose.
  const hierarchy = useMemo(() => {
    if (!base || !rootNode) return null;
    const parentIndex = new Map<string, string>();
    for (const e of entries) parentIndex.set(`${ENTRY_PREFIX}${e.id}`, rootNode.srn);
    for (const n of neighborNodes) {
      const owner = relationEdges.find(r => r.dst === n.srn && entrySrnSet.has(r.src))?.src
        ?? relationEdges.find(r => r.src === n.srn && entrySrnSet.has(r.dst))?.dst;
      parentIndex.set(n.srn, owner ?? rootNode.srn);
    }
    return buildRenderedHierarchy([...entryNodes, ...neighborNodes] as GraphNode[], parentIndex, rootNode.srn);
  }, [base, rootNode, entries, entryNodes, neighborNodes, relationEdges, entrySrnSet]);

  const selectedEntry = entries.find(e => e.id === selectedId) ?? null;

  // Polls briefly for the force simulation to have seeded a position for this
  // node (it may not exist yet on the very first render after data loads).
  const centerOnEntry = useCallback((srn: string) => {
    let attempts = 0;
    const tryCenter = () => {
      attempts += 1;
      if (graphRef.current?.hasNode(srn)) { graphRef.current.centerOn(srn); return; }
      if (attempts < 15) setTimeout(tryCenter, 60);
    };
    tryCenter();
  }, []);

  // Deep link: /knowledge?entry=<id> (what entity_index stores for an entry).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('entry');
    if (id && entries.some(e => e.id === id)) {
      setSelectedId(id);
      centerOnEntry(`${ENTRY_PREFIX}${id}`);
      window.history.replaceState({}, '', '/knowledge');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  // `shortcut:search-knowledge-terms` focuses the search bar (see registry.ts).
  useEffect(() => {
    const onSearchShortcut = () => searchInputRef.current?.focus();
    window.addEventListener('shortcut:search-knowledge-terms', onSearchShortcut);
    return () => window.removeEventListener('shortcut:search-knowledge-terms', onSearchShortcut);
  }, []);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return visibleEntries
      .filter(e => e.term.toLowerCase().includes(q) || e.aliases.some(a => a.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [visibleEntries, searchQuery]);

  const handlePickSearchResult = useCallback((entryId: string) => {
    setSelectedId(entryId);
    centerOnEntry(`${ENTRY_PREFIX}${entryId}`);
    setSearchQuery('');
    setSearchOpen(false);
    searchInputRef.current?.blur();
  }, [centerOnEntry]);

  const handleNodeClick = useCallback((n: NetRenderNode) => {
    if (n.type === 'knowledgeBase') { graphRef.current?.resetCamera(); setSelectedId(null); return; }
    const id = entryIdFromSrn(n.srn);
    if (id) { setSelectedId(id); return; }
    // A referenced board/page/task — open it rather than trying to edit it here.
    if (n.deepLink) navigate(n.deepLink);
  }, [navigate]);

  const handleNodeOpen = useCallback((n: NetRenderNode) => {
    if (n.type === 'knowledgeEntry' || n.type === 'knowledgeBase') return;
    if (n.deepLink) navigate(n.deepLink);
  }, [navigate]);

  const handleCreate = async () => {
    const term = newTerm.trim();
    if (!term) { setCreating(false); return; }
    setCreateError('');
    try {
      const entry = await createEntry({ term });
      setNewTerm('');
      setCreating(false);
      setSelectedId(entry.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not add that term');
    }
  };

  const handleScan = async () => {
    const res = await scan();
    if (!res) { setScanMessage('Scan failed — try again in a moment.'); return; }
    setScanMessage(res.proposed === 0
      ? 'No new terms found. Everything that repeats is already defined.'
      : `Found ${res.proposed} new candidate${res.proposed === 1 ? '' : 's'} to review.`);
    if (res.proposed > 0) setShowSuggestions(true);
  };

  const handleSaveMeta = useCallback(async (updates: Partial<KnowledgeEntry>) => {
    if (!selectedId) return;
    await updateEntry(selectedId, updates);
  }, [selectedId, updateEntry]);

  const handleSaveContent = useCallback(async (blocks: MarkdownBlock[]) => {
    if (!selectedId) return;
    await saveEntryContent(selectedId, blocks);
    // A definition's [[...]] links become real relations on save, so the net
    // has to re-read them or the new edge wouldn't appear until a reload.
    void reloadGraph();
  }, [selectedId, saveEntryContent, reloadGraph]);

  const handleDeleteEntry = useCallback(async () => {
    if (!selectedId) return;
    const id = selectedId;
    setSelectedId(null);
    await removeEntry(id);
    void reloadGraph();
  }, [selectedId, removeEntry, reloadGraph]);

  if (!workspaceId) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-body)' }}>Select a workspace to open its Knowledge Base.</div>;
  }

  const pad = isMobile ? 12 : 24;

  // ── Not created yet ────────────────────────────────────────────────────────
  if (!loading && !base) {
    return (
      <div style={{ padding: pad, height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>
        <div style={{ maxWidth: 460, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Icon name="neurology" size={48} color="var(--color-purple-tint-3, #c4b8f0)" />
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 19, fontWeight: 700, color: 'var(--color-text-primary)' }}>No Knowledge Base here yet</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
            A Knowledge Base is this workspace's dictionary — the terms, people, projects and systems you actually talk about.
            The assistant and any connected MCP client look terms up here first, so a definition you write once is a definition they stop guessing at.
          </div>
          {canWrite ? (
            <button onClick={() => void create(workspaceId)}
              style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', borderRadius: 9, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>
              <Icon name="add" size={16} color="var(--color-white)" /> Add the Knowledge Base
            </button>
          ) : (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)' }}>
              Only members of this workspace can add one.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: pad, height: '100%', width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16, animation: 'sectionFadeUp 360ms cubic-bezier(0.22,1,0.36,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>
            {base?.emoji || '🧠'} {base?.name ?? 'Knowledge'}
          </h1>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', whiteSpace: 'nowrap' }}>
            {entries.length} term{entries.length === 1 ? '' : 's'} in {workspace?.name ?? 'this workspace'}
          </span>
        </div>
        {canWrite && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {suggestions.length > 0 && (
              <button onClick={() => setShowSuggestions(s => !s)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-warning)', background: 'var(--color-white)', color: 'var(--color-warning)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <Icon name="rate_review" size={15} color="var(--color-warning)" />
                {suggestions.length} to review
              </button>
            )}
            <button onClick={() => void handleScan()} disabled={scanning}
              title="Scan this workspace for terms that repeat, and propose them"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: scanning ? 'default' : 'pointer', opacity: scanning ? 0.6 : 1 }}>
              <Icon name="travel_explore" size={15} color="var(--color-text-tertiary)" />
              {scanning ? 'Scanning…' : 'Find concepts'}
            </button>
            <button onClick={() => { setCreating(true); setCreateError(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <Icon name="add" size={15} color="var(--color-white)" /> Add term
            </button>
          </div>
        )}
      </div>

      {scanMessage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 9, background: 'var(--color-surface-tint)', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', animation: 'menuIn 160ms ease both' }}>
          <Icon name="info" size={15} color="var(--color-primary)" />
          <span style={{ flex: 1 }}>{scanMessage}</span>
          <button onClick={() => setScanMessage('')} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
            <Icon name="close" size={14} color="var(--color-text-quaternary)" />
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', borderRadius: 14, border: '1px solid var(--color-border)', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.04)', overflow: 'hidden', background: 'var(--color-white)' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-quaternary)', fontFamily: 'var(--font-heading)', fontSize: 13, zIndex: 4, background: 'var(--color-white)' }}>
            <Spinner size={16} thickness={2} durationMs={600} />
            Loading…
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center', zIndex: 3 }}>
            <Icon name="menu_book" size={40} color="var(--color-purple-tint-3, #c4b8f0)" />
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>No terms defined yet</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', maxWidth: 340, lineHeight: 1.6 }}>
              Add the first term, or run <strong>Find concepts</strong> to see what this workspace already talks about repeatedly.
            </div>
          </div>
        )}

        {!loading && entries.length > 0 && rootNode && hierarchy && (
          <Suspense fallback={null}>
            <NeuralGraph
              ref={graphRef}
              nodes={renderNodes}
              hierarchy={hierarchy}
              relationEdges={relationEdges}
              workspaceRootSrn={rootNode.srn}
              workspaceId={workspaceId}
              selectedSrn={selectedId ? `${ENTRY_PREFIX}${selectedId}` : undefined}
              onNodeClick={handleNodeClick}
              onNodeOpen={handleNodeOpen}
              onBackgroundClick={() => setSelectedId(null)}
            />
          </Suspense>
        )}

        {!loading && entries.length > 0 && (
          <div style={{ position: 'absolute', top: 12, left: 12, width: isMobile ? 'calc(100% - 24px)' : 300, zIndex: 5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--color-white)', border: '1px solid var(--color-border)', boxShadow: '0 4px 16px rgba(var(--color-black-rgb), 0.10)' }}>
                <Icon name="search" size={16} color="var(--color-text-quaternary)" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 120)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && searchMatches[0]) handlePickSearchResult(searchMatches[0].id);
                    if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false); searchInputRef.current?.blur(); }
                  }}
                  placeholder="Search terms…"
                  style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}
                />
                {searchQuery && (
                  <button onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, flexShrink: 0 }}>
                    <Icon name="close" size={14} color="var(--color-text-quaternary)" />
                  </button>
                )}
              </div>
              {searchOpen && searchQuery.trim() && (
                <div style={{ marginTop: 6, background: 'var(--color-white)', borderRadius: 10, border: '1px solid var(--color-border)', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', overflow: 'hidden', animation: 'menuIn 140ms ease both' }}>
                  {searchMatches.length === 0 ? (
                    <div style={{ padding: '10px 12px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)' }}>No terms match "{searchQuery.trim()}"</div>
                  ) : (
                    searchMatches.map(e => (
                      <button key={e.id}
                        onMouseDown={ev => ev.preventDefault()}
                        onClick={() => handlePickSearchResult(e.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', borderTop: '1px solid var(--color-surface-tint-2)', cursor: 'pointer', textAlign: 'left' }}
                        onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                        onMouseLeave={ev => { ev.currentTarget.style.background = 'none'; }}>
                        <span style={{ fontSize: 15, flexShrink: 0 }}>{e.emoji || '📖'}</span>
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.term}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div ref={typeFilterRef} style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setTypeFilterOpen(o => !o)}
                title="Filter by term type"
                style={{
                  width: 38, height: 38, borderRadius: 10, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: typeFilter.length > 0 ? 'var(--color-primary)' : 'var(--color-white)',
                  border: '1px solid var(--color-border)', boxShadow: '0 4px 16px rgba(var(--color-black-rgb), 0.10)', cursor: 'pointer',
                }}
              >
                <Icon name="filter_list" size={16} color={typeFilter.length > 0 ? 'var(--color-white)' : 'var(--color-text-quaternary)'} />
                {typeFilter.length > 0 && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4, minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7,
                    background: 'var(--color-primary)', color: 'var(--color-white)', border: '1.5px solid var(--color-white)',
                    fontFamily: 'var(--font-heading)', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{typeFilter.length}</span>
                )}
              </button>
              {typeFilterOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 190, background: 'var(--color-white)', borderRadius: 10, border: '1px solid var(--color-border)', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', padding: 8, animation: 'menuIn 140ms ease both' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 6px' }}>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 700, color: 'var(--color-text-secondary)' }}>Term type</span>
                    {typeFilter.length > 0 && (
                      <button onClick={() => setTypeFilter([])} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Reset</button>
                    )}
                  </div>
                  {ENTRY_TYPE_OPTIONS.map(opt => {
                    const active = typeFilter.length === 0 || typeFilter.includes(opt.key);
                    return (
                      <button
                        key={opt.key}
                        onClick={() => toggleTypeFilter(opt.key)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 6px', borderRadius: 6, border: 'none',
                          background: active ? 'var(--color-surface-tint)' : 'transparent', opacity: active ? 1 : 0.45, cursor: 'pointer', textAlign: 'left',
                          fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)', transition: 'background 120ms, opacity 120ms',
                        }}
                      >
                        <Icon name={opt.icon} size={14} color="var(--color-text-tertiary)" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <AnimatePresence>
          {selectedEntry && (
            <EntryInspector
              key="entry-inspector"
              entry={selectedEntry}
              relations={relations}
              canWrite={canWrite}
              isMobile={isMobile}
              mentionMembers={members}
              onSaveMeta={handleSaveMeta}
              onSaveContent={handleSaveContent}
              onDelete={() => void handleDeleteEntry()}
              onClose={() => setSelectedId(null)}
              onOpenRelation={navigate}
            />
          )}
        </AnimatePresence>

        {showSuggestions && suggestions.length > 0 && (
          <div style={{ position: 'absolute', top: 64, left: 12, width: isMobile ? 'calc(100% - 24px)' : 340, maxHeight: 'calc(100% - 76px)', overflowY: 'auto', background: 'var(--color-white)', borderRadius: 14, border: '1px solid var(--color-border)', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.16)', zIndex: 5, animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
              <Icon name="rate_review" size={16} color="var(--color-primary)" />
              <span style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>Suggested terms</span>
              <button onClick={() => setShowSuggestions(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
                <Icon name="close" size={16} color="var(--color-text-tertiary)" />
              </button>
            </div>
            <div style={{ padding: '8px 14px 12px', fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', lineHeight: 1.5 }}>
              Found by scanning this workspace. Nothing here is visible to the assistant until you accept it.
            </div>
            {suggestions.map(s => (
              <div key={s.id} style={{ padding: '10px 14px', borderTop: '1px solid var(--color-surface-tint-2)' }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{s.term}</div>
                {s.evidence[0] && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 3, lineHeight: 1.5 }}>
                    “{s.evidence[0].snippet}”
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={() => void decideSuggestion(s.id, true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 11px', borderRadius: 7, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                    <Icon name="check" size={13} color="var(--color-white)" /> Add
                  </button>
                  <button onClick={() => void decideSuggestion(s.id, false)}
                    style={{ padding: '5px 11px', borderRadius: 7, border: '1px solid var(--color-border-alt)', background: 'transparent', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 500, cursor: 'pointer' }}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {creating && (
          <div onClick={() => setCreating(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(var(--color-black-rgb), 0.14)', backdropFilter: 'blur(3px)', zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: 'var(--color-white)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 380, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15.5, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>Add a term</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                What does this workspace call it? You can add the definition next.
              </div>
              <input autoFocus value={newTerm}
                onChange={e => { setNewTerm(e.target.value); setCreateError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="e.g. Q3 Rollout"
                style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-body)', fontSize: 13.5, border: '1px solid var(--color-border)', borderRadius: 8, padding: '9px 11px', outline: 'none' }} />
              {createError && (
                <div style={{ marginTop: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{createError}</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                <button onClick={() => setCreating(false)}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border-alt)', background: 'transparent', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 500, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => void handleCreate()} disabled={!newTerm.trim()}
                  style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: newTerm.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, cursor: newTerm.trim() ? 'pointer' : 'not-allowed' }}>Add</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
