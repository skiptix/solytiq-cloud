// Which attachment formats can be previewed inline, shared by the Task dialog,
// the Milestone editor, and the AttachmentPreview modal. Kept out of the
// component file so the modal module only exports a component (fast-refresh).

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text';

const TEXT_MIMES = ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/x-sh'];
const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'ini', 'conf', 'toml'];

export function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/** Which preview to render for a file, or null when it isn't previewable. */
export function previewKind(mimeType: string, name: string): PreviewKind | null {
  const m = (mimeType || '').toLowerCase();
  const ext = extOf(name);
  if (m.startsWith('image/')) return 'image';           // svg renders via <img>, which can't execute script
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/') || TEXT_MIMES.includes(m) || TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

export function isPreviewable(mimeType: string, name: string): boolean {
  return previewKind(mimeType, name) !== null;
}
