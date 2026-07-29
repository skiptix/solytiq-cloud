// ---------------------------------------------------------------------------
// Pure text-chunking + embedding-plan helpers for the Knowledge Layer. Kept
// dependency-free and side-effect-free (no DB, no HTTP) so they're trivially
// unit-testable — the DB/HTTP orchestration lives in embeddingWorker.ts.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

export interface Chunk {
  index: number;
  content: string;
}

const MAX_CHUNK_CHARS = 2000;

/**
 * Split text into paragraph-aligned chunks up to `maxChars` each. Paragraphs
 * (blank-line-separated) are packed greedily; a single paragraph longer than
 * `maxChars` is hard-split on word boundaries rather than dropped. No
 * fixed-size sliding-window overlap — chunk boundaries stay at natural
 * paragraph breaks, which is simpler to reason about and to test
 * deterministically than an overlapping window.
 */
export function chunkText(text: string | null | undefined, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const clean = (text ?? '').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let current = '';

  const flush = () => { if (current) { out.push(current); current = ''; } };

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    flush();
    if (para.length <= maxChars) {
      current = para;
    } else {
      for (const piece of hardSplit(para, maxChars)) out.push(piece);
    }
  }
  flush();

  return out.map((content, index) => ({ index, content }));
}

/** Split an oversized paragraph on the last space before the limit, never mid-word when avoidable. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Stable content hash for change detection (skip re-embedding unchanged chunks). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Rough token estimate (~4 chars/token) — good enough for a soft monthly budget, not billing-accurate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MarkdownBlockLike {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** Flatten a Markdown page's blocks into one chunkable document, in reading order. Mirrors routes/markdownLists.ts's collectBlockText but stays dependency-free (no import from a route file). */
export function flattenMarkdownBlocks(blocks: MarkdownBlockLike[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = typeof block.text === 'string' ? block.text : undefined;
    if (text?.trim()) parts.push(text.trim());
    if (block.type === 'table' && Array.isArray(block.rows)) {
      for (const row of block.rows as unknown[]) {
        if (!Array.isArray(row)) continue;
        const cells = row.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
        if (cells.length) parts.push(cells.join(' | '));
      }
    }
  }
  return parts.join('\n\n');
}

export interface ExistingChunkRow {
  index: number;
  contentHash: string;
  embedding: number[] | null;
}

export interface PlannedChunk {
  index: number;
  content: string;
  contentHash: string;
  embedding: number[] | null;
  /** True when this chunk is new or its text changed since the last embed — the worker only pays the provider for these. */
  needsEmbedding: boolean;
}

/**
 * Diff a freshly-chunked document against its previously-stored chunks so the
 * embedding worker only calls the provider for chunks that are new or whose
 * text actually changed — chunks at the same index with an unchanged content
 * hash reuse their prior embedding for free. Pure — no DB/HTTP.
 */
export function planEmbeddingWork(chunks: Chunk[], existing: ExistingChunkRow[]): PlannedChunk[] {
  const byIndex = new Map(existing.map((e) => [e.index, e]));
  return chunks.map((c) => {
    const hash = contentHash(c.content);
    const prior = byIndex.get(c.index);
    const reusable = !!prior && prior.contentHash === hash && prior.embedding !== null;
    return {
      index: c.index,
      content: c.content,
      contentHash: hash,
      embedding: reusable ? prior!.embedding : null,
      needsEmbedding: !reusable,
    };
  });
}
