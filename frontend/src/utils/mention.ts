// ── @-mention typeahead helpers ───────────────────────────────────────────────
// Shared by the notes editor and the markdown-list block editor. Pure string
// math — the UI (popover, keyboard nav) lives in the components that use these.

export interface MentionMember {
  id: string;
  username: string;
  fullName?: string | null;
}

export interface MentionContext {
  /** Index of the `@` that opened this mention. */
  at: number;
  /** The text typed after the `@`, up to the caret. */
  query: string;
}

/**
 * Detect an in-progress `@mention` immediately before the caret. Returns null
 * unless the `@` is at the start of the text or right after whitespace, and the
 * text between it and the caret has no whitespace (so a finished "@bob " no
 * longer matches — the space closed it).
 */
export function detectMention(text: string, caret: number): MentionContext | null {
  if (caret < 0 || caret > text.length) return null;
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  const before = at === 0 ? ' ' : upto[at - 1];
  if (!/\s/.test(before)) return null; // @ mid-word (e.g. an email) isn't a mention
  const query = upto.slice(at + 1);
  if (query.length > 40 || /\s/.test(query)) return null;
  // Only letters/digits/._- are valid username characters.
  if (query && !/^[A-Za-z0-9_.-]*$/.test(query)) return null;
  return { at, query };
}

/**
 * Replace the `@query` token (from `at` through `caret`) with `@username ` and
 * report the new caret position (just after the inserted trailing space).
 */
export function applyMention(text: string, at: number, caret: number, username: string): { value: string; caret: number } {
  const insert = `@${username} `;
  const value = text.slice(0, at) + insert + text.slice(caret);
  return { value, caret: at + insert.length };
}

/** Rank members by a mention query: prefix matches first, then substring. */
export function filterMentionMembers(members: MentionMember[], query: string, limit = 6): MentionMember[] {
  const q = query.toLowerCase();
  if (!q) return members.slice(0, limit);
  const scored = members
    .map((m) => {
      const uname = m.username.toLowerCase();
      const fname = (m.fullName ?? '').toLowerCase();
      let score = -1;
      if (uname.startsWith(q)) score = 0;
      else if (fname.startsWith(q)) score = 1;
      else if (uname.includes(q)) score = 2;
      else if (fname.includes(q)) score = 3;
      return { m, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.m);
}
