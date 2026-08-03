// ---------------------------------------------------------------------------
// AI Skill .zip bundle extraction.
//
// A bundle is a .zip containing a SKILL.md (at the root, or one level deep
// inside a single wrapping folder — the common shape when a zip is made by
// right-clicking a "my-skill/" folder) plus optional text reference files
// alongside it. Reference files only — nothing extracted here is ever
// executed (see index.ts's ai_skills migration comment) — so this module's
// only job is to get plain text safely out of an untrusted zip:
//   - zip-slip: every entry path is validated to stay under the bundle root
//     before it's ever joined with anything.
//   - zip-bomb: total declared uncompressed size and entry count are capped
//     BEFORE any entry is read, using adm-zip's central-directory metadata.
//   - binary noise: only text-like extensions are captured; anything else
//     (images, executables, archives-within-archives) is silently skipped
//     and reported back as a count, not stored.
// ---------------------------------------------------------------------------

import AdmZip from 'adm-zip';

const MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_BYTES = 256 * 1024; // 256KB per reference file
const MAX_ENTRY_COUNT = 300;

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.html', '.htm',
]);

export interface ParsedSkillBundle {
  skillMd: string;
  files: { path: string; content: string }[];
  skippedCount: number;
}

export type ParseBundleResult = { ok: true; bundle: ParsedSkillBundle } | { ok: false; error: string };

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** True if `entryName` (a zip-internal path, always '/'-separated) would stay
 *  inside the bundle root once normalized — rejects `../` escapes and
 *  absolute paths without ever touching the filesystem. */
function isSafeZipPath(entryName: string): boolean {
  if (!entryName || entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return false;
  const parts = entryName.split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      depth--;
      if (depth < 0) return false;
    } else {
      depth++;
    }
  }
  return true;
}

export function parseSkillBundle(buffer: Buffer): ParseBundleResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { ok: false, error: 'Could not read this file as a .zip archive' };
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) return { ok: false, error: 'The .zip archive is empty' };
  if (entries.length > MAX_ENTRY_COUNT) return { ok: false, error: `Too many files in the archive (max ${MAX_ENTRY_COUNT})` };

  let totalSize = 0;
  for (const e of entries) {
    if (!isSafeZipPath(e.entryName)) return { ok: false, error: `Unsafe path in archive: "${e.entryName}"` };
    totalSize += e.header.size; // declared uncompressed size, from the central directory — read before extraction
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return { ok: false, error: `Archive is too large uncompressed (max ${MAX_TOTAL_UNCOMPRESSED_BYTES / (1024 * 1024)}MB)` };
    }
  }

  // Locate SKILL.md, case-insensitively, at the root or one directory deep.
  const skillMdEntry = entries.find((e) => {
    const segs = e.entryName.split('/').filter(Boolean);
    return segs.length <= 2 && segs[segs.length - 1]?.toLowerCase() === 'skill.md';
  });
  if (!skillMdEntry) return { ok: false, error: 'The .zip archive must contain a SKILL.md file (at the root, or one folder deep)' };

  // Every other file is stored relative to SKILL.md's own directory, so a
  // single wrapping folder in the zip doesn't leak into stored paths.
  const rootPrefix = skillMdEntry.entryName.includes('/')
    ? skillMdEntry.entryName.slice(0, skillMdEntry.entryName.lastIndexOf('/') + 1)
    : '';

  const skillMd = zip.readAsText(skillMdEntry, 'utf8');
  if (!skillMd.trim()) return { ok: false, error: 'SKILL.md is empty' };

  const files: { path: string; content: string }[] = [];
  let skippedCount = 0;
  for (const e of entries) {
    if (e === skillMdEntry) continue;
    if (!e.entryName.startsWith(rootPrefix)) continue; // outside the skill's own folder (e.g. a sibling at the zip root)
    const relPath = e.entryName.slice(rootPrefix.length);
    if (!relPath) continue;
    if (!isTextFile(relPath) || e.header.size > MAX_FILE_BYTES) { skippedCount++; continue; }
    files.push({ path: relPath, content: zip.readAsText(e, 'utf8') });
  }

  return { ok: true, bundle: { skillMd, files, skippedCount } };
}
