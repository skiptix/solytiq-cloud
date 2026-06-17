import type { Response } from 'express';
import path from 'path';
import fs from 'fs';

const SAFE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'];

/**
 * Sanitise a filename for use in Content-Disposition headers.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\s\-_.]/g, '_');
}

/**
 * Send a file to the client with secure headers (Content-Disposition,
 * X-Content-Type-Options, Cache-Control, CSP sandbox for safe types).
 *
 * `mode`:
 *  - `'auto'`  (default) — inline for safe MIME types, attachment otherwise.
 *  - `'attachment'`       — always force download.
 */
export function sendFileDownload(
  res: Response,
  filePath: string,
  originalName: string,
  mimeType: string,
  mode: 'auto' | 'attachment' = 'auto',
): void {
  const isSafe = SAFE_MIMES.includes(mimeType);
  const disposition = mode === 'attachment' ? 'attachment' : isSafe ? 'inline' : 'attachment';
  const encoded = encodeURIComponent(sanitizeFilename(originalName));

  res.setHeader('Content-Disposition', `${disposition}; filename="${encoded}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  if (mode === 'auto' && isSafe) {
    const ct = mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : mimeType;
    res.setHeader('Content-Type', ct);
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src 'self' data: blob:;",
    );
  } else {
    res.setHeader('Content-Type', 'application/octet-stream');
  }

  res.sendFile(filePath);
}

/**
 * Resolve a relative file path against the upload directory and verify it exists.
 * Returns the absolute path or `null` if the file is missing.
 */
export function resolveUploadPath(uploadDir: string, relativePath: string): string | null {
  const abs = path.join(path.resolve(uploadDir), relativePath);
  return fs.existsSync(abs) ? abs : null;
}
