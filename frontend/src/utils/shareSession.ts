// ---------------------------------------------------------------------------
// S4 — public share pages (SharedListPage, SharedTimelinePage,
// SharedMarkdownListPage, SharedFolderPage, SharePage) exchange a visitor's
// share-link password for a short-lived, opaque session ticket via ONE POST
// (a request body, never logged the way a URL is), then use that ticket —
// never the password itself — as `?session=` on every subsequent content/
// download/image request. See backend/src/shareSessions.ts for the server
// side of this; before it existed, the plaintext password rode as
// `?password=` on every single request to these public, unauthenticated
// endpoints.
// ---------------------------------------------------------------------------

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export type ShareKind = 'file' | 'list' | 'timeline' | 'markdownList' | 'folder';

export class ShareSessionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Exchange a share's password for a session ticket. Throws ShareSessionError
 *  (status 401 = wrong password, 404 = not found, 410 = expired) on failure. */
export async function verifySharePassword(kind: ShareKind, token: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/share/verify-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, token, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ShareSessionError(res.status, (body as { error?: string }).error ?? 'Verification failed');
  }
  const data = (await res.json()) as { session: string };
  return data.session;
}
