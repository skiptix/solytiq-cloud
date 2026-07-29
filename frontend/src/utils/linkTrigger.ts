// ── `[[entity link]]` typeahead helpers ───────────────────────────────────────
// Mirrors utils/mention.ts's `@`-mention pattern exactly, but for the Graph
// Layer's inline `[[type:id|Label]]` link tokens. Pure string math — the UI
// (LinkPicker, keyboard nav) lives in the components that use these.

import type { EntityIndexEntry } from '../types';
import { formatSrn } from './srn';

export interface LinkTriggerContext {
  /** Index of the first `[` of the `[[` that opened this trigger. */
  at: number;
  /** The text typed after `[[`, up to the caret. */
  query: string;
}

/**
 * Detect an in-progress `[[query` immediately before the caret. Returns null
 * unless the query has no `]` or newline yet (an already-closed `[[...]]`
 * token no longer matches) and is short enough to plausibly still be a search.
 */
export function detectLinkTrigger(text: string, caret: number): LinkTriggerContext | null {
  if (caret < 0 || caret > text.length) return null;
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('[[');
  if (at === -1) return null;
  const query = upto.slice(at + 2);
  if (query.length > 60 || /[\]\n]/.test(query)) return null;
  return { at, query };
}

/**
 * Replace the `[[query` token (from `at` through `caret`) with a full,
 * ID-anchored `[[type:id|Title]]` token and report the new caret position
 * (just after the closing `]]`).
 */
export function applyLinkToken(text: string, at: number, caret: number, entity: EntityIndexEntry): { value: string; caret: number } {
  const srn = formatSrn(entity.entityType, entity.entityId);
  const label = (entity.title || 'Untitled').replace(/[[\]|]/g, ' ').trim();
  const insert = `[[${srn.slice('srn:'.length)}|${label}]]`;
  const value = text.slice(0, at) + insert + text.slice(caret);
  return { value, caret: at + insert.length };
}
