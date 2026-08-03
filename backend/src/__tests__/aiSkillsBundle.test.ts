// ---------------------------------------------------------------------------
// AI Skills — .zip bundle extraction (aiSkills/bundle.ts).
//
// parseSkillBundle is a pure function (no DB), so these build small in-memory
// zips with AdmZip and assert directly — no mocking needed. The zip-slip and
// zip-bomb guards are the security-sensitive part of this feature (an admin
// upload is trusted input, but "trusted" doesn't mean "never buggy"), so those
// get the most coverage.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { parseSkillBundle } from '../aiSkills/bundle';

function buildZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('parseSkillBundle', () => {
  it('extracts SKILL.md at the archive root', () => {
    const buf = buildZip({ 'SKILL.md': '# My Skill\n\nDo the thing.' });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.skillMd).toContain('Do the thing.');
  });

  it('finds SKILL.md one folder deep (the common "zip a folder" shape)', () => {
    const buf = buildZip({ 'my-skill/SKILL.md': '# Nested\n\nBody text.' });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.skillMd).toContain('Body text.');
  });

  it('matches SKILL.md case-insensitively', () => {
    const buf = buildZip({ 'skill.md': '# Lower\n\ncontent' });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
  });

  it('rejects an archive with no SKILL.md', () => {
    const buf = buildZip({ 'README.md': '# Not a skill' });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SKILL\.md/);
  });

  it('rejects an empty archive', () => {
    const buf = new AdmZip().toBuffer();
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(false);
  });

  it('rejects SKILL.md that is empty', () => {
    const buf = buildZip({ 'SKILL.md': '   \n  ' });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(false);
  });

  it('captures a text reference file alongside SKILL.md, relative to its own folder', () => {
    const buf = buildZip({
      'my-skill/SKILL.md': '# Skill\n\nBody.',
      'my-skill/reference/checklist.md': '- step one\n- step two',
    });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.files).toHaveLength(1);
      expect(result.bundle.files[0].path).toBe('reference/checklist.md');
      expect(result.bundle.files[0].content).toContain('step one');
    }
  });

  it('does not pull in a sibling file outside the SKILL.md folder', () => {
    const buf = buildZip({
      'my-skill/SKILL.md': '# Skill\n\nBody.',
      'unrelated/other.md': 'should not be captured',
    });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.files).toHaveLength(0);
  });

  it('skips (not fails on) a binary/unsupported file extension, reporting it as skipped', () => {
    const buf = buildZip({
      'SKILL.md': '# Skill\n\nBody.',
      'logo.png': 'not really a png but has a binary-ish extension',
    });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.files).toHaveLength(0);
      expect(result.bundle.skippedCount).toBe(1);
    }
  });

  it('rejects a zip-slip path escaping the archive root', () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# Skill\n\nBody.'));
    // AdmZip's own addFile sanitizes '..' in some versions, so construct the
    // entry name via addFile with a path that still contains a literal '..'
    // segment pre-normalization to exercise isSafeZipPath's rejection path.
    zip.addFile('../../etc/passwd', Buffer.from('evil'));
    const buf = zip.toBuffer();
    const result = parseSkillBundle(buf);
    // Either AdmZip refused to add the traversal entry (so this degenerates to
    // the plain single-file case) or our own guard rejects it outright — both
    // are an acceptable outcome, but it must NEVER surface the escaped path as
    // a captured reference file.
    if (result.ok) {
      expect(result.bundle.files.some((f) => f.path.includes('..'))).toBe(false);
    } else {
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects an archive with too many entries', () => {
    const files: Record<string, string> = { 'SKILL.md': '# Skill\n\nBody.' };
    for (let i = 0; i < 305; i++) files[`reference/f${i}.md`] = 'x';
    const buf = buildZip(files);
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many/i);
  });

  it('rejects an archive whose total uncompressed size exceeds the cap', () => {
    const big = 'x'.repeat(3 * 1024 * 1024); // 3MB, repeated across a few files to clear 10MB
    const buf = buildZip({
      'SKILL.md': '# Skill\n\nBody.',
      'reference/a.txt': big,
      'reference/b.txt': big,
      'reference/c.txt': big,
      'reference/d.txt': big,
    });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/large/i);
  });

  it('skips (does not store) a single reference file over the per-file size cap', () => {
    const huge = 'x'.repeat(300 * 1024); // over the 256KB per-file cap
    const buf = buildZip({
      'SKILL.md': '# Skill\n\nBody.',
      'reference/huge.md': huge,
    });
    const result = parseSkillBundle(buf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.files).toHaveLength(0);
      expect(result.bundle.skippedCount).toBe(1);
    }
  });

  it('rejects a buffer that is not a valid zip', () => {
    const result = parseSkillBundle(Buffer.from('this is not a zip file'));
    expect(result.ok).toBe(false);
  });
});
