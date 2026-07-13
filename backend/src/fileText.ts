// ---------------------------------------------------------------------------
// Shared file → text extraction.
//
// Single source of truth for turning an uploaded file (PDF, spreadsheet, text,
// image) into text/base64 the AI can read. Used by both the internal AI file
// upload endpoint (routes/ai.ts) and the MCP `read_file` tool (aiTools.ts) so
// external agents read documents exactly the way Sol does.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require('pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX: {
  read: (buf: Buffer, opts: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_csv: (sheet: unknown) => string };
} = require('xlsx');

// Cap on extracted text length, mirroring the internal AI file limit. Raised
// from the original 50,000 so a full-length contract or report (tens of
// pages) fits in one call without truncation for the common case.
export const MAX_TEXT_CHARS = 150000;

// Extensions whose MIME type is often wrong/ambiguous in the browser
// (e.g. .ts files arrive as video/mp2t) but are really plain text.
export const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'md', 'markdown',
  'html', 'htm',
  'csv',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sql', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'txt', 'log', 'env',
]);

export interface ExtractedFile {
  /** Extracted text, a base64 data URL (images), or a placeholder note. */
  contentText: string | null;
  /** True when contentText is an image data URL suitable for vision models. */
  isImage: boolean;
}

/** Cap `text` to maxChars, appending a visible notice instead of cutting it silently. */
function capWithNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... truncated — ${omitted} more characters omitted (${text.length} total). Use the read_file tool with an offset to read the rest.]`;
}

/**
 * Extract readable content from a file buffer based on its MIME type and name.
 * Never throws — parse failures degrade to a bracketed placeholder string so
 * callers always get something back. Truncation (when the extracted text
 * exceeds maxChars) is always flagged in the returned text rather than done
 * silently, so a caller — or the model reading it — knows content is missing
 * instead of mistaking a partial document for the whole thing.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
  maxChars: number = MAX_TEXT_CHARS
): Promise<ExtractedFile> {
  const ext = (originalname.split('.').pop() ?? '').toLowerCase();
  const isXlsx = ext === 'xlsx' || ext === 'xls'
    || mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mimetype === 'application/vnd.ms-excel';
  const isTextByExt = TEXT_EXTENSIONS.has(ext);

  if (mimetype === 'application/pdf') {
    try {
      const parsed = await pdfParse(buffer);
      return { contentText: capWithNotice(parsed.text, maxChars), isImage: false };
    } catch {
      return { contentText: '[PDF could not be parsed]', isImage: false };
    }
  }

  if (isXlsx) {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheets = workbook.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        return `Sheet: ${name}\n${csv}`;
      }).join('\n\n');
      return { contentText: capWithNotice(sheets, maxChars), isImage: false };
    } catch {
      return { contentText: '[XLSX could not be parsed]', isImage: false };
    }
  }

  if (mimetype.startsWith('text/') || isTextByExt) {
    return { contentText: capWithNotice(buffer.toString('utf-8'), maxChars), isImage: false };
  }

  if (mimetype.startsWith('image/')) {
    // Store as base64 data URL for vision models (cap at 4 MB raw)
    if (buffer.length <= 4 * 1024 * 1024) {
      return { contentText: `data:${mimetype};base64,${buffer.toString('base64')}`, isImage: true };
    }
    return { contentText: '[Image too large for AI context — max 4 MB]', isImage: false };
  }

  return {
    contentText: `[Unsupported file type: ${mimetype} (.${ext}). Supported: PDF, XLSX, CSV, HTML, Markdown, TypeScript/JS, images]`,
    isImage: false,
  };
}
