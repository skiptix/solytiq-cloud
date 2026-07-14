// ---------------------------------------------------------------------------
// Apps registry — the catalog of optional, admin-installable features shown
// in the "Discover Apps" dialog (Settings → System). An app starts out
// uninstalled: its screens/nav are hidden and its API routes 404 for every
// user (including admins) until an admin installs it, at which point it
// behaves exactly as if it were always part of the product.
//
// Adding a new app later means: add an entry to APPS_REGISTRY, then gate its
// router with `router.use(requireAppInstalled('<id>'))`.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from 'express';
import { query } from './db';

export interface AppDef {
  id: string;
  name: string;
  description: string;
  icon: string;       // Material Symbols name
  category: string;
  accentColor: string;
}

export const APPS_REGISTRY: AppDef[] = [
  {
    id: 'gps',
    name: 'GPS Routes',
    description: 'Plan routes, upload GPX/FIT tracks, smooth and edit them, and browse everything on the map.',
    icon: 'route',
    category: 'Tools',
    accentColor: '#0d9488',
  },
  {
    id: 'files',
    name: 'File Sharing',
    description: 'Upload files and share them with anyone via a public, optionally password-protected link.',
    icon: 'folder_shared',
    category: 'Sharing',
    accentColor: '#1D4ED8',
  },
  {
    id: 'mcp',
    name: 'Claude MCP',
    description: 'Let users connect Claude as a custom connector via OAuth, so it can see and manage their Solytiq data.',
    icon: 'smart_toy',
    category: 'Integrations',
    accentColor: '#5e4dbb',
  },
];

export function getAppDef(appId: string): AppDef | undefined {
  return APPS_REGISTRY.find(a => a.id === appId);
}

export async function getInstalledAppIds(): Promise<string[]> {
  const r = await query<{ app_id: string }>('SELECT app_id FROM installed_apps');
  return r.rows.map(row => row.app_id);
}

export async function isAppInstalled(appId: string): Promise<boolean> {
  const r = await query('SELECT 1 FROM installed_apps WHERE app_id = $1', [appId]);
  return r.rows.length > 0;
}

/** Gates an entire router (or a public route) behind an app's installed
 *  state. 404s rather than 403s — an uninstalled app should look like it
 *  doesn't exist, not like a permission wall. */
export function requireAppInstalled(appId: string) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (await isAppInstalled(appId)) { next(); return; }
    res.status(404).json({ error: 'not_found' });
  };
}
