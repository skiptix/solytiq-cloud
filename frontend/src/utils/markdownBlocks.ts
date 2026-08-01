// ---------------------------------------------------------------------------
// Pure block constructors/predicates shared by every host of the block editor
// (Markdown Pages, Knowledge Base entries) and by the editor itself.
//
// These live outside components/markdown/BlockEditor.tsx deliberately: a file
// that exports both a component and plain functions breaks Fast Refresh, and
// hosts legitimately need `makeEmptyBlock` to seed an empty document before the
// editor ever mounts.
// ---------------------------------------------------------------------------

import type {
  MarkdownBlock, MarkdownBlockType, MarkdownTodoBlock, MarkdownHeadingBlock, MarkdownParagraphBlock,
  MarkdownBulletListItemBlock, MarkdownNumberedListItemBlock, MarkdownQuoteBlock,
} from '../types';
import { makeEmptyTableBlock } from './markdownTable';

let blockSeq = 0;
export function newBlockId(): string {
  blockSeq += 1;
  return `blk_${Date.now()}_${blockSeq}`;
}

export function makeEmptyBlock(type: MarkdownBlockType, level?: 1 | 2 | 3): MarkdownBlock {
  const id = newBlockId();
  switch (type) {
    case 'heading': return { id, type, level: level ?? 3, text: '' };
    case 'todo': return { id, type, text: '', checked: false, taskId: null };
    case 'divider': return { id, type };
    case 'table': return makeEmptyTableBlock(id);
    default: return { id, type: type as 'paragraph' | 'bulleted-list-item' | 'numbered-list-item' | 'quote', text: '' };
  }
}

export type TextBlock =
  | MarkdownHeadingBlock | MarkdownParagraphBlock | MarkdownBulletListItemBlock
  | MarkdownNumberedListItemBlock | MarkdownTodoBlock | MarkdownQuoteBlock;

const TEXT_BLOCK_TYPES = new Set<MarkdownBlockType>(['heading', 'paragraph', 'bulleted-list-item', 'numbered-list-item', 'todo', 'quote']);

export function hasText(block: MarkdownBlock): block is TextBlock {
  return TEXT_BLOCK_TYPES.has(block.type);
}
