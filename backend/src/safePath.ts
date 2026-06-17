import path from 'path';

/**
 * Resolve a relative file path against a base directory, and ensure the result
 * stays within the base directory. Returns `null` if the resolved path escapes
 * the base (path traversal attempt).
 */
export function safeResolve(baseDir: string, relativePath: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, relativePath);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null;
  }
  return resolved;
}
