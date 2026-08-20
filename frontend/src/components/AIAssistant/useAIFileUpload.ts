import { useCallback, useState } from 'react';
import type { AIFile } from '../../types';
import { apiUploadAIFile, apiDeleteAIFile } from '../../api/client';

// Shared between AIChatWindow (desktop + the old mobile sheet) and
// AIMobileChat (the mobile floating overlay) — extracted rather than
// duplicated because it's real, non-trivial logic (validation, size limits,
// per-file progress), not a handful of lines a second copy would be cheaper
// than.

const ACCEPTED_MIME_PREFIXES = ['application/pdf', 'text/', 'image/'];
const ACCEPTED_MIME_EXACT = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
// Extensions whose MIME type may be wrong in the browser (e.g. .ts → video/mp2t)
const ACCEPTED_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs',
  'md', 'markdown',
  'html', 'htm',
  'csv',
  'xlsx', 'xls',
  'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'py', 'rb', 'go', 'rs',
  'txt', 'log',
]);

export const FILE_INPUT_ACCEPT = '.pdf,.xlsx,.xls,.csv,.html,.htm,.md,.markdown,.ts,.tsx,.js,.jsx,.txt,.json,.yaml,.yml,.xml,.sql,.log,image/*';

export function getExt(name: string) {
  return (name.split('.').pop() ?? '').toLowerCase();
}

export function isAccepted(file: File) {
  if (ACCEPTED_MIME_PREFIXES.some((p) => file.type === p || file.type.startsWith(p))) return true;
  if (ACCEPTED_MIME_EXACT.has(file.type)) return true;
  return ACCEPTED_EXTENSIONS.has(getExt(file.name));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(mime: string, name: string): string {
  if (mime === 'application/pdf') return 'picture_as_pdf';
  if (mime.startsWith('image/')) return 'image';
  const ext = getExt(name);
  if (ext === 'xlsx' || ext === 'xls') return 'table_chart';
  if (ext === 'csv') return 'table_rows';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'code';
  if (ext === 'md' || ext === 'markdown') return 'article';
  if (ext === 'html' || ext === 'htm') return 'html';
  return 'description';
}

export interface UploadingFile {
  name: string;
  progress: number;
  id: string;
}

interface UseAIFileUploadOptions {
  sessionId: string | null;
  onAddFile: (file: AIFile) => void;
  onRemoveFile: (id: string) => void;
}

export function useAIFileUpload({ sessionId, onAddFile, onRemoveFile }: UseAIFileUploadOptions) {
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadFile = useCallback(async (file: File) => {
    if (!isAccepted(file)) {
      setUploadError(`Unsupported type. Use PDF, XLSX, CSV, HTML, Markdown, TypeScript, or images.`);
      setTimeout(() => setUploadError(null), 4000);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('File too large — max 25 MB.');
      setTimeout(() => setUploadError(null), 4000);
      return;
    }

    const tempId = crypto.randomUUID();
    setUploadingFiles((prev) => [...prev, { name: file.name, progress: 0, id: tempId }]);
    setUploadError(null);

    try {
      const result = await apiUploadAIFile(file, sessionId, (pct) => {
        setUploadingFiles((prev) => prev.map((u) => u.id === tempId ? { ...u, progress: pct } : u));
      });
      onAddFile(result);
    } catch {
      setUploadError(`Failed to upload "${file.name}". Please try again.`);
      setTimeout(() => setUploadError(null), 4000);
    } finally {
      setUploadingFiles((prev) => prev.filter((u) => u.id !== tempId));
    }
  }, [sessionId, onAddFile]);

  const uploadFiles = useCallback(async (files: File[]) => {
    for (const file of files.slice(0, 3)) await uploadFile(file);
  }, [uploadFile]);

  const handleRemoveFile = useCallback(async (id: string) => {
    onRemoveFile(id);
    await apiDeleteAIFile(id).catch(() => {});
  }, [onRemoveFile]);

  return { uploadingFiles, uploadError, uploadFile, uploadFiles, handleRemoveFile };
}
