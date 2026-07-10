import { Router, Request, Response } from 'express';
import { authenticate, requireAdmin } from '../middleware';
import { query } from '../db';
import { APPS_REGISTRY, getAppDef, getInstalledAppIds } from '../appsRegistry';

const router = Router();

// GET /api/apps — admin-only full catalog with metadata + installed flags.
// Powers the "Discover Apps" dialog grid. (Non-admin clients only ever see
// the lightweight `installedApps` id list via GET /api/auth/feature-flags.)
router.get('/', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const installedIds = new Set(await getInstalledAppIds());
    const apps = APPS_REGISTRY.map(a => ({ ...a, installed: installedIds.has(a.id) }));
    res.json({ apps });
  } catch (err) {
    console.error('apps GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/apps/:appId/install
router.post('/:appId/install', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { appId } = req.params;
    if (!getAppDef(appId)) {
      res.status(404).json({ error: 'Unknown app' });
      return;
    }
    await query(
      `INSERT INTO installed_apps (app_id, installed_by) VALUES ($1, $2)
       ON CONFLICT (app_id) DO NOTHING`,
      [appId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('apps install error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/apps/:appId/uninstall — data (GPS tracks, shared files) is kept
// on disk/in the DB; uninstalling only hides the feature, reversible by
// installing again.
router.post('/:appId/uninstall', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { appId } = req.params;
    if (!getAppDef(appId)) {
      res.status(404).json({ error: 'Unknown app' });
      return;
    }
    await query('DELETE FROM installed_apps WHERE app_id = $1', [appId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('apps uninstall error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
