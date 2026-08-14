// ---------------------------------------------------------------------------
// Quick Add — item-title normalization.
//
// Pure, dependency-free, side-effect-free (the same discipline as
// knowledge/chunker.ts and knowledgeBase/extract.ts): every function here is a
// string→string transform with no DB and no HTTP, so the memory key and the
// matching signals are unit-testable without a live database.
//
// `titleKey()` is the identity a Quick Add memory row is keyed on. It has to be
// stable enough that "Fix login bug", "fix   login bug!" and "Fix Login Bug"
// collapse to ONE memory (otherwise the same recurring item never accumulates
// evidence) and strict enough that two genuinely different items never do.
// ---------------------------------------------------------------------------

/** Hard cap on a stored key — a board's memory index shouldn't be widened by a pathological title. */
const MAX_KEY_LENGTH = 300;

/**
 * Words carried by almost every task title. They're dropped from `tokenize()`
 * (which powers the word-overlap signal) because a shared "the" is not
 * evidence of anything, but they are deliberately KEPT in `titleKey()` — two
 * items differing only by a stopword really are different items.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in',
  'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with',
]);

/**
 * Lowercase, strip accents, replace every non-alphanumeric run with a single
 * space, collapse whitespace. Unicode letters/digits survive (so a German or
 * Cyrillic title normalizes rather than being erased), emoji and punctuation
 * do not.
 */
export function normalizeTitle(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    // Combining marks left behind by NFKD — "Fällig" → "fallig", so an accented
    // and unaccented spelling of the same word share one memory.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The primary key a memory row is stored under. Empty string = not memorable. */
export function titleKey(raw: string): string {
  return normalizeTitle(raw).slice(0, MAX_KEY_LENGTH);
}

/** Meaningful words of a title, de-duped, stopwords and 1-character noise removed. */
export function tokenize(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of normalizeTitle(raw).split(' ')) {
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Jaccard overlap of two titles' meaningful words, 0..1. Deliberately
 * word-level rather than character-level: it's the signal trigram similarity
 * is worst at — "login bug" vs "bug in the login form" share both content
 * words but relatively few trigrams across the whole string.
 */
export function tokenOverlap(a: string, b: string): number {
  const left = tokenize(a);
  const right = new Set(tokenize(b));
  if (left.length === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  const union = left.length + right.size - shared;
  return union === 0 ? 0 : shared / union;
}
