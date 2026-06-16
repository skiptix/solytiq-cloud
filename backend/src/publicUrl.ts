// ---------------------------------------------------------------------------
// Resolves the public origin of this deployment (e.g. https://solytiq.example).
//
// OAuth metadata (issuer, endpoints) and the MCP resource pointer must be
// absolute, externally reachable URLs. Behind Nginx the backend sees an
// internal host, so prefer the operator-configured PUBLIC_URL / FRONTEND_URL
// and only fall back to the request's forwarded host (trust proxy is enabled
// in index.ts, so req.protocol honours X-Forwarded-Proto).
// ---------------------------------------------------------------------------

import { Request } from 'express';

export function getPublicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
