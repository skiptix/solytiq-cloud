// ---------------------------------------------------------------------------
// S6 — XLSX parsing sandbox (xlsxSandbox.ts). Uses the `xlsx` package itself
// ONLY to AUTHOR a valid fixture buffer in this test file's own main-thread
// scope (the write path is not what the unpatched advisories concern —
// parsing untrusted input is). Every actual PARSE under test still goes
// through parseXlsxInWorker(), exactly the path fileText.ts now uses.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx');
import { parseXlsxInWorker } from '../xlsxSandbox';
import { extractTextFromBuffer } from '../fileText';

function buildXlsxFixture(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Score'],
    ['Alice', 42],
    ['Bob', 7],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// SheetJS's `XLSX.read()` auto-detects format and is deliberately lenient —
// arbitrary text bytes are silently accepted as a one-cell CSV sheet rather
// than rejected (confirmed empirically: neither an empty buffer nor plain
// text throws). A buffer that STARTS with the OOXML zip signature ('PK\x03\x04',
// the real xlsx container format) but isn't a valid zip is what reliably
// throws — this is the genuinely "malformed" case worth testing.
function corruptZipFixture(): Buffer {
  return Buffer.from('PK\x03\x04');
}

describe('parseXlsxInWorker', () => {
  it('parses a valid XLSX buffer into a per-sheet CSV dump', async () => {
    const buffer = buildXlsxFixture();
    const result = await parseXlsxInWorker(buffer);
    expect(result).toContain('Sheet: Sheet1');
    expect(result).toContain('Name,Score');
    expect(result).toContain('Alice,42');
    expect(result).toContain('Bob,7');
  });

  it('handles a workbook with multiple sheets', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'First');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['y']]), 'Second');
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const result = await parseXlsxInWorker(buffer);
    expect(result).toContain('Sheet: First');
    expect(result).toContain('Sheet: Second');
  });

  it('rejects cleanly (never hangs, never throws synchronously) on a malformed/corrupt-zip buffer', async () => {
    await expect(parseXlsxInWorker(corruptZipFixture())).rejects.toThrow();
  });

  it('does not throw synchronously — always returns a promise even for bad input', () => {
    // The call itself (before any await) must never throw — a caller doing
    // `parseXlsxInWorker(x).catch(...)` must always have something to
    // attach to, never a thrown exception that skips the .catch entirely.
    expect(() => { void parseXlsxInWorker(corruptZipFixture()).catch(() => {}); }).not.toThrow();
  });

  it("SheetJS's own leniency: arbitrary text bytes parse as a one-cell CSV sheet rather than rejecting — documented so this isn't mistaken for a sandbox bug", async () => {
    const arbitraryText = Buffer.from('just some plain text, not a real spreadsheet', 'utf-8');
    const result = await parseXlsxInWorker(arbitraryText);
    expect(result).toContain('Sheet: Sheet1');
    expect(result).toContain('just some plain text');
  });

  it('enforces its timeout — an unreasonably small budget rejects rather than hanging', async () => {
    const buffer = buildXlsxFixture();
    await expect(parseXlsxInWorker(buffer, 1)).rejects.toThrow(/timed out/i);
  }, 10000);

  it('multiple concurrent parses do not interfere with each other (independent workers)', async () => {
    const good = buildXlsxFixture();
    const bad = corruptZipFixture();
    const results = await Promise.allSettled([
      parseXlsxInWorker(good),
      parseXlsxInWorker(bad),
      parseXlsxInWorker(good),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') expect(results[0].value).toContain('Alice,42');
    if (results[2].status === 'fulfilled') expect(results[2].value).toContain('Alice,42');
  });
});

describe('extractTextFromBuffer — XLSX integration (fileText.ts)', () => {
  it('extracts sheet content for a .xlsx file via mimetype', async () => {
    const buffer = buildXlsxFixture();
    const result = await extractTextFromBuffer(
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'report.xlsx'
    );
    expect(result.isImage).toBe(false);
    expect(result.contentText).toContain('Alice,42');
  });

  it('extracts sheet content for a .xls file via extension fallback', async () => {
    const buffer = buildXlsxFixture();
    const result = await extractTextFromBuffer(buffer, 'application/octet-stream', 'legacy.xls');
    expect(result.contentText).toContain('Alice,42');
  });

  it('degrades to a placeholder (never throws) for a corrupt XLSX', async () => {
    const result = await extractTextFromBuffer(corruptZipFixture(), 'application/vnd.ms-excel', 'broken.xls');
    expect(result.contentText).toBe('[XLSX could not be parsed]');
    expect(result.isImage).toBe(false);
  });
});
