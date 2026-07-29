import { describe, expect, it } from 'vitest';
import { chunkText, contentHash, estimateTokens, flattenMarkdownBlocks, planEmbeddingWork } from '../knowledge/chunker';

describe('chunkText', () => {
  it('returns an empty array for empty/null/undefined text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('Hello world.');
    expect(chunks).toEqual([{ index: 0, content: 'Hello world.' }]);
  });

  it('packs multiple short paragraphs into one chunk', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
  });

  it('splits into a new chunk once the running total would exceed maxChars', () => {
    const para = 'x'.repeat(60);
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, 100);
    // Each paragraph alone (60) fits; two together (60+2+60=122) exceed 100, so it splits after the first.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 100)).toBe(true);
  });

  it('hard-splits a single paragraph that alone exceeds maxChars, on a word boundary', () => {
    const para = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '); // no double-newlines
    const chunks = chunkText(para, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(40);
      expect(c.content.startsWith(' ')).toBe(false);
      expect(c.content.endsWith(' ')).toBe(false);
    }
    // Rejoining (with the space the split consumed) reconstructs the original text losslessly.
    expect(chunks.map((c) => c.content).join(' ')).toBe(para);
  });

  it('assigns sequential zero-based indices', () => {
    const para = 'x'.repeat(60);
    const chunks = chunkText([para, para, para].join('\n\n'), 100);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('contentHash', () => {
  it('is deterministic for the same input', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('differs for different input', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 4 characters, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('flattenMarkdownBlocks', () => {
  it('joins text-bearing blocks with blank lines, in order', () => {
    const out = flattenMarkdownBlocks([
      { id: 'b1', type: 'heading', text: 'Title' },
      { id: 'b2', type: 'paragraph', text: 'Body text.' },
    ]);
    expect(out).toBe('Title\n\nBody text.');
  });

  it('skips blocks with no text (dividers, images without captions)', () => {
    const out = flattenMarkdownBlocks([
      { id: 'b1', type: 'paragraph', text: 'Keep me.' },
      { id: 'b2', type: 'divider' },
      { id: 'b3', type: 'paragraph', text: '' },
    ]);
    expect(out).toBe('Keep me.');
  });

  it('flattens table rows into pipe-separated lines', () => {
    const out = flattenMarkdownBlocks([
      { id: 'b1', type: 'table', rows: [['Name', 'Score'], ['Alice', '9']] },
    ]);
    expect(out).toBe('Name | Score\n\nAlice | 9');
  });
});

describe('planEmbeddingWork', () => {
  it('flags every chunk as needing embedding when there is no prior state', () => {
    const planned = planEmbeddingWork([{ index: 0, content: 'a' }, { index: 1, content: 'b' }], []);
    expect(planned.every((p) => p.needsEmbedding)).toBe(true);
    expect(planned.every((p) => p.embedding === null)).toBe(true);
  });

  it('reuses a prior embedding when the content hash at that index is unchanged', () => {
    const hash = contentHash('unchanged');
    const planned = planEmbeddingWork(
      [{ index: 0, content: 'unchanged' }],
      [{ index: 0, contentHash: hash, embedding: [0.1, 0.2] }]
    );
    expect(planned[0].needsEmbedding).toBe(false);
    expect(planned[0].embedding).toEqual([0.1, 0.2]);
  });

  it('flags a chunk as needing re-embedding when its text changed at the same index', () => {
    const planned = planEmbeddingWork(
      [{ index: 0, content: 'new text' }],
      [{ index: 0, contentHash: contentHash('old text'), embedding: [0.1, 0.2] }]
    );
    expect(planned[0].needsEmbedding).toBe(true);
    expect(planned[0].embedding).toBeNull();
  });

  it('re-embeds a chunk whose prior row has no embedding yet (pgvector was unavailable at the time)', () => {
    const hash = contentHash('same');
    const planned = planEmbeddingWork(
      [{ index: 0, content: 'same' }],
      [{ index: 0, contentHash: hash, embedding: null }]
    );
    expect(planned[0].needsEmbedding).toBe(true);
  });

  it('flags a brand-new trailing chunk (document grew) as needing embedding, independent of earlier ones', () => {
    const hash0 = contentHash('first');
    const planned = planEmbeddingWork(
      [{ index: 0, content: 'first' }, { index: 1, content: 'second (new)' }],
      [{ index: 0, contentHash: hash0, embedding: [1] }]
    );
    expect(planned[0].needsEmbedding).toBe(false);
    expect(planned[1].needsEmbedding).toBe(true);
  });
});
