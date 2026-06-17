import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/app/uploads';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Creates a multer disk-storage config that writes files to `UPLOAD_DIR`
 * with a `<prefix>_<uuid>.<ext>` filename.
 *
 * @param prefix — short prefix to namespace file types, e.g. `'ta'`, `'ma'`, `'gps'`.
 *                 Pass `''` to omit the prefix (plain UUID).
 */
export function createUploadStorage(prefix: string): multer.StorageEngine {
  return multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = prefix ? `${prefix}_${crypto.randomUUID()}${ext}` : `${crypto.randomUUID()}${ext}`;
      cb(null, name);
    },
  });
}

/** Standard 200 MB limit used across all upload endpoints. */
export const UPLOAD_SIZE_LIMIT = 200 * 1024 * 1024;

/**
 * Pre-configured multer instance.
 */
export function createUpload(prefix: string): multer.Multer {
  return multer({ storage: createUploadStorage(prefix), limits: { fileSize: UPLOAD_SIZE_LIMIT } });
}
