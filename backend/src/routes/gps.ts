import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { query } from '../db';
import { authenticate } from '../middleware';
import {
  GpsPoint, WaypointInput, GpsRouteStateV1, ParsedGpxData,
  computeMetadata, buildElevationProfile,
  parseGpxFull, writeGpx,
  buildRouteStateFromGpx, computeRouteStateMetadata, validateRouteState,
} from '../gpx';

export { haversine, buildElevationProfile, parseGpx, writeGpx } from '../gpx';

// ─── FIT parser types ────────────────────────────────────────────────────────
interface FitRecord {
  position_lat?: number; position_long?: number;
  altitude?: number; enhanced_altitude?: number;
  heart_rate?: number; cadence?: number; power?: number;
  timestamp?: Date | string;
}
type FitParserInstance = {
  parse(buf: Buffer, cb: (err: Error | null, data: { records?: FitRecord[] }) => void): void;
};
type FitParserCtor = new (opts?: object) => FitParserInstance;
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _fitLib: any = require('fit-file-parser');
const FitParserClass = (_fitLib.default ?? _fitLib) as FitParserCtor;

// ─── Storage ─────────────────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/app/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `gps_${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.gpx' || ext === '.fit') cb(null, true);
    else cb(new Error('Only .gpx and .fit files are allowed'));
  },
});

const router = Router();
router.use(authenticate);

// ─── Internal types ──────────────────────────────────────────────────────────
interface GpsFileRow {
  id: string; user_id: string; original_name: string; file_type: string;
  file_path: string; file_size: number; metadata: Record<string, unknown> | null;
  created_at: string; smoothed: boolean; route_state: GpsRouteStateV1 | null;
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function gaussianSmooth(points: GpsPoint[], sigma: number): GpsPoint[] {
  const win = Math.ceil(3 * sigma);
  return points.map((p, i) => {
    let wEle = 0, wTotal = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j++) {
      const d = j - i;
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      wEle += points[j].ele * w;
      wTotal += w;
    }
    return { ...p, ele: wTotal > 0 ? wEle / wTotal : p.ele };
  });
}


function parseFit(buffer: Buffer): Promise<GpsPoint[]> {
  return new Promise((resolve, reject) => {
    const fitParser = new FitParserClass({ force: true, speedUnit: 'km/h', lengthUnit: 'km', temperatureUnit: 'celsius', elapsedRecordField: true, mode: 'list' });
    fitParser.parse(buffer, (error, data) => {
      if (error) { reject(error); return; }
      const records: FitRecord[] = data?.records ?? [];
      const SEMI_TO_DEG = 180 / Math.pow(2, 31);
      const points: GpsPoint[] = records
        .filter(r => r.position_lat != null && r.position_long != null)
        .map(r => {
          let lat = r.position_lat as number;
          let lon = r.position_long as number;
          // Convert from semicircles if values are out of degree range
          if (Math.abs(lat) > 90) lat = lat * SEMI_TO_DEG;
          if (Math.abs(lon) > 180) lon = lon * SEMI_TO_DEG;
          const ts = r.timestamp;
          return {
            lat, lon,
            ele: (r.altitude ?? r.enhanced_altitude ?? 0),
            time: ts ? (ts instanceof Date ? ts.toISOString() : String(ts)) : undefined,
            hr: r.heart_rate ?? undefined,
            cadence: r.cadence ?? undefined,
            power: r.power ?? undefined,
          };
        });
      resolve(points);
    });
  });
}

async function readAndParse(filePath: string, fileType: string): Promise<ParsedGpxData> {
  const abs = path.join(UPLOAD_DIR, path.basename(filePath));
  if (fileType === 'fit') {
    const points = await parseFit(await fs.promises.readFile(abs));
    return { points, waypoints: [], routePoints: [] };
  }
  return parseGpxFull(await fs.promises.readFile(abs, 'utf-8'));
}

function rowToGpsFile(row: GpsFileRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.original_name,
    fileType: row.file_type as 'gpx' | 'fit',
    size: row.file_size,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/gps — list user's GPS files
router.get('/', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const result = await query<GpsFileRow>('SELECT * FROM gps_files WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ files: result.rows.map(r => ({ id: r.id, userId: r.user_id, name: r.original_name, fileType: r.file_type, size: r.file_size, metadata: r.metadata, createdAt: r.created_at, smoothed: r.smoothed ?? false })) });
  } catch (err) { console.error('GPS list:', err); res.status(500).json({ error: 'Failed to list GPS files' }); }
});

// POST /api/gps/upload — upload a .gpx or .fit file
router.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).userId as string;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const fileType = ext === 'fit' ? 'fit' : 'gpx';
  try {
    let points: GpsPoint[];
    try {
      if (fileType === 'fit') {
        points = await parseFit(fs.readFileSync(file.path));
      } else {
        const parsed = parseGpxFull(fs.readFileSync(file.path, 'utf-8'));
        points = parsed.points;
      }
    } catch {
      points = [];
    }
    const metadata = computeMetadata(points);
    const id = crypto.randomUUID();
    const relPath = path.basename(file.path);
    await query(
      'INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, file.originalname, fileType, relPath, file.size, metadata ? JSON.stringify(metadata) : null],
    );
    res.json({ file: { id, userId, name: file.originalname, fileType, size: file.size, metadata, createdAt: new Date().toISOString() } });
  } catch (err) {
    fs.unlink(file.path, () => {});
    console.error('GPS upload:', err);
    res.status(500).json({ error: 'Failed to process GPS file' });
  }
});

// GET /api/gps/:id/data — parse and return full track data
router.get('/:id/data', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const result = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });

    const parsed = await readAndParse(row.file_path, row.file_type);
    const { points, waypoints } = parsed;

    // Persisted editing state wins; otherwise derive one from the GPX itself.
    // A valid but empty planning file yields a valid empty state — not an error.
    const routeState: GpsRouteStateV1 = row.route_state ?? buildRouteStateFromGpx(parsed);

    const elevationProfile = buildElevationProfile(points);
    const metadata = computeMetadata(points);
    const metricsAvailable = {
      hr: points.some(p => p.hr != null),
      cadence: points.some(p => p.cadence != null),
      power: points.some(p => p.power != null),
    };
    const hrProfile = metricsAvailable.hr
      ? points.map((p, i) => ({ idx: i, distance: elevationProfile[i].distance, value: p.hr ?? null }))
      : null;
    const cadenceProfile = metricsAvailable.cadence
      ? points.map((p, i) => ({ idx: i, distance: elevationProfile[i].distance, value: p.cadence ?? null }))
      : null;
    const powerProfile = metricsAvailable.power
      ? points.map((p, i) => ({ idx: i, distance: elevationProfile[i].distance, value: p.power ?? null }))
      : null;

    res.json({
      points,
      waypoints,
      routeState,
      elevationProfile,
      metadata,
      metricsAvailable,
      hrProfile,
      cadenceProfile,
      powerProfile,
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'GPS file not found on disk' });
    console.error('GPS data:', err); res.status(500).json({ error: 'Failed to parse GPS file' });
  }
});

// POST /api/gps/:id/smooth — apply Gaussian elevation smoothing, return GPX download
router.post('/:id/smooth', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const sigma = Math.max(1, Math.min(50, parseFloat(String(req.body.sigma)) || 5));
    const result = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    const { points } = await readAndParse(row.file_path, row.file_type);
    if (points.length === 0) return res.status(422).json({ error: 'No GPS points found' });
    const smoothed = gaussianSmooth(points, sigma);
    const baseName = path.basename(row.original_name, path.extname(row.original_name));
    const outName = `${baseName}_smoothed`;
    const gpx = writeGpx(smoothed, outName);
    const sanitizedName = outName.replace(/[^\w\s\-_.]/g, '_');
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedName)}.gpx"`);
    res.send(gpx);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'GPS file not found on disk' });
    console.error('GPS smooth:', err); res.status(500).json({ error: 'Failed to smooth GPS file' });
  }
});

// POST /api/gps/:id/smooth-save — smooth and save (new file or replace in-place)
router.post('/:id/smooth-save', async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { sigma = 5, mode = 'new', name: newName } = req.body as { sigma?: number; mode?: 'new' | 'replace'; name?: string };
    const sigmaNum = Math.min(30, Math.max(1, Number(sigma) || 5));

    const result = await query<{ id: string; user_id: string; original_name: string; file_type: string; file_path: string; file_size: number; metadata: Record<string,unknown>|null; created_at: string }>(
      'SELECT * FROM gps_files WHERE id=$1 AND user_id=$2', [id, userId]
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const row = result.rows[0];
    const filePath = path.join(UPLOAD_DIR, path.basename(row.file_path));

    const { points } = await readAndParse(row.file_path, row.file_type);
    const smoothed = gaussianSmooth(points, sigmaNum);
    const baseName = row.original_name.replace(/\.(gpx|fit)$/i, '');

    if (mode === 'replace') {
      const gpx = writeGpx(smoothed, baseName);
      fs.writeFileSync(filePath, gpx, 'utf8');
      const newSize = Buffer.byteLength(gpx, 'utf8');
      const metadata = computeMetadata(smoothed);
      await query('UPDATE gps_files SET metadata=$1, file_size=$2, file_type=$3, smoothed=true WHERE id=$4',
        [metadata ? JSON.stringify(metadata) : null, newSize, 'gpx', id]);
      const outName = baseName.endsWith('.gpx') ? baseName : `${baseName}.gpx`;
      res.json({ file: { id, userId, name: outName, fileType: 'gpx', size: newSize, metadata, createdAt: row.created_at, smoothed: true } });
    } else {
      const safeName = ((newName || `${baseName}_smoothed`)).replace(/[^\w\s\-_.]/g, '').trim() || `${baseName}_smoothed`;
      const outName = safeName.endsWith('.gpx') ? safeName : `${safeName}.gpx`;
      const gpx = writeGpx(smoothed, safeName);
      const newId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const filename = `gps_${newId}.gpx`;
      const fullPath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(fullPath, gpx, 'utf8');
      const newSize = Buffer.byteLength(gpx, 'utf8');
      const metadata = computeMetadata(smoothed);
      await query('INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata, smoothed) VALUES ($1,$2,$3,$4,$5,$6,$7,true)',
        [newId, userId, outName, 'gpx', filename, newSize, metadata ? JSON.stringify(metadata) : null]);
      res.json({ file: { id: newId, userId, name: outName, fileType: 'gpx', size: newSize, metadata, createdAt: new Date().toISOString(), smoothed: true } });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'GPS file not found on disk' });
    console.error('GPS smooth-save:', err); res.status(500).json({ error: 'Failed to smooth and save GPS file' });
  }
});

// PATCH /api/gps/:id/rename — rename a GPS file
router.patch('/:id/rename', async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { name } = req.body as { name: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await query<{ id: string; user_id: string; original_name: string; file_type: string; file_size: number; metadata: Record<string,unknown>|null; created_at: string }>(
      'UPDATE gps_files SET original_name=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [name.trim(), id, userId]
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const row = result.rows[0];
    res.json({ file: { id: row.id, userId: row.user_id, name: row.original_name, fileType: row.file_type, size: row.file_size, metadata: row.metadata, createdAt: row.created_at } });
  } catch (err) { console.error('GPS rename:', err); res.status(500).json({ error: 'Failed to rename GPS file' }); }
});

// POST /api/gps/new — create an empty route for planning from scratch
router.post('/new', async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { name = 'New Route' } = req.body as { name?: string };
    const safeName = name.replace(/[^\w\s\-_.()]/g, '').trim().slice(0, 200) || 'New Route';
    const id = crypto.randomUUID();
    const filename = `gps_${id.replace(/-/g, '')}.gpx`;
    const fullPath = path.join(UPLOAD_DIR, filename);
    const gpxContent = writeGpx([], safeName);
    fs.writeFileSync(fullPath, gpxContent, 'utf8');
    const fileSize = Buffer.byteLength(gpxContent, 'utf8');
    await query(
      'INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, `${safeName}.gpx`, 'gpx', filename, fileSize, null],
    );
    res.json({ file: { id, userId, name: `${safeName}.gpx`, fileType: 'gpx', size: fileSize, metadata: null, createdAt: new Date().toISOString(), smoothed: false } });
  } catch (err) {
    console.error('GPS new route:', err);
    res.status(500).json({ error: 'Failed to create new route' });
  }
});

// POST /api/gps/combine — merge multiple files; optional gap handling and save-to-library
router.post('/combine', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const { ids, name = 'combined', gapMode, save: saveToLibrary = false } = req.body as {
      ids: string[]; name: string;
      gapMode?: Array<'skip' | 'straight'>;
      save?: boolean;
    };
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 10) {
      return res.status(400).json({ error: 'Between 2 and 10 file IDs required' });
    }
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    const result = await query<GpsFileRow>(
      `SELECT * FROM gps_files WHERE user_id = $1 AND id IN (${placeholders})`,
      [userId, ...ids],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No files found' });
    // Preserve the caller-specified order
    const rowMap = new Map(result.rows.map(r => [r.id, r]));
    const orderedRows = ids.map(id => rowMap.get(id)).filter(Boolean) as GpsFileRow[];
    const segments: GpsPoint[][] = [];
    for (const row of orderedRows) {
      const { points } = await readAndParse(row.file_path, row.file_type);
      segments.push(points);
    }
    const allPoints: GpsPoint[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length === 0) continue;
      if (i > 0 && allPoints.length > 0) {
        const mode = (gapMode?.[i - 1]) ?? 'skip';
        if (mode === 'straight') {
          const last = allPoints[allPoints.length - 1];
          const first = seg[0];
          const STEPS = 10;
          for (let s = 1; s < STEPS; s++) {
            const t = s / STEPS;
            allPoints.push({
              lat: last.lat + (first.lat - last.lat) * t,
              lon: last.lon + (first.lon - last.lon) * t,
              ele: last.ele + (first.ele - last.ele) * t,
            });
          }
        }
      }
      allPoints.push(...seg);
    }
    const safeName = String(name).replace(/[^\w\s\-_.]/g, '').trim() || 'combined';
    const gpx = writeGpx(allPoints, safeName);
    if (saveToLibrary) {
      const id = `gps_${Date.now()}`;
      const filename = `gps_${crypto.randomUUID()}.gpx`;
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filePath, gpx);
      const fileSize = Buffer.byteLength(gpx, 'utf8');
      const metadata = computeMetadata(allPoints);
      await query(
        'INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, userId, `${safeName}.gpx`, 'gpx', filename, fileSize, metadata ? JSON.stringify(metadata) : null],
      );
      return res.json({ file: { id, userId, name: `${safeName}.gpx`, fileType: 'gpx', size: fileSize, metadata, createdAt: new Date().toISOString() } });
    }
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.gpx"`);
    res.send(gpx);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'GPS file not found on disk' });
    console.error('GPS combine:', err); res.status(500).json({ error: 'Failed to combine GPS files' });
  }
});

// GET /api/gps/:id/download — download raw original file
router.get('/:id/download', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const result = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    const abs = path.join(UPLOAD_DIR, path.basename(row.file_path));
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not on disk' });
    const mime = row.file_type === 'fit' ? 'application/octet-stream' : 'application/gpx+xml';
    res.setHeader('Content-Type', mime);
    const sanitizedName = String(row.original_name).replace(/[^\x20-\x7E]/g, '').replace(/[^\w\s\-_.]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedName)}"`);
    res.sendFile(abs);
  } catch (err) { console.error('GPS download:', err); res.status(500).json({ error: 'Failed to download' }); }
});

// PUT /api/gps/:id/points — save edited track points as new or replaced GPX file
router.put('/:id/points', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const { id } = req.params;
    const { points, saveAs = 'new', name, waypoints = [], routeState } = req.body as {
      points: GpsPoint[];
      saveAs?: 'new' | 'replace';
      name?: string;
      waypoints?: WaypointInput[];
      routeState?: GpsRouteStateV1;
    };

    // Empty planning routes are valid — only malformed content is rejected
    if (!Array.isArray(points)) {
      return res.status(400).json({ error: 'points must be an array' });
    }
    for (const p of points) {
      if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || typeof p.ele !== 'number') {
        return res.status(400).json({ error: 'Each point must have lat, lon, ele as numbers' });
      }
    }

    let validatedRouteState: GpsRouteStateV1 | null = null;
    if (routeState !== undefined) {
      const stateError = validateRouteState(routeState);
      if (stateError) return res.status(400).json({ error: `Invalid route state: ${stateError}` });
      validatedRouteState = routeState;
      validatedRouteState.metadata = computeRouteStateMetadata(validatedRouteState);
    }

    const validWaypoints: WaypointInput[] = Array.isArray(waypoints)
      ? waypoints.filter(w =>
          typeof w.lat === 'number' && typeof w.lon === 'number' &&
          typeof w.name === 'string' && w.name.trim().length > 0,
        )
      : [];

    const origResult = await query<GpsFileRow>(
      'SELECT * FROM gps_files WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    const origFile = origResult.rows[0];

    const baseName = origFile.original_name.replace(/\.(gpx|fit)$/i, '');
    const outputName = saveAs === 'new'
      ? (name?.trim() || `${baseName}_edited`)
      : baseName;

    const gpxContent = writeGpx(points, outputName, validWaypoints);
    const newFileName = `gps_${crypto.randomUUID()}.gpx`;
    const newFilePath = path.join(UPLOAD_DIR, newFileName);
    fs.writeFileSync(newFilePath, gpxContent, 'utf8');
    const fileSize = Buffer.byteLength(gpxContent, 'utf8');
    const metadata = computeMetadata(points);

    // Both the GPX (interoperable) and route_state (rich editing state) are saved.
    // Without an explicit state from the client, derive one so reopen still works.
    const stateToSave = validatedRouteState
      ?? buildRouteStateFromGpx(parseGpxFull(gpxContent));
    const routeStateJson = JSON.stringify(stateToSave);

    if (saveAs === 'replace') {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(origFile.file_path))); } catch { /* ignore */ }
      await query(
        `UPDATE gps_files SET file_path = $1, original_name = $2, file_size = $3, metadata = $4, route_state = $5 WHERE id = $6 AND user_id = $7`,
        [newFileName, `${outputName}.gpx`, fileSize, JSON.stringify(metadata), routeStateJson, id, userId],
      );
      const updated = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1', [id]);
      return res.json({ file: rowToGpsFile(updated.rows[0]) });
    } else {
      const newId = crypto.randomUUID();
      await query(
        `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata, route_state) VALUES ($1, $2, $3, 'gpx', $4, $5, $6, $7)`,
        [newId, userId, `${outputName}.gpx`, newFileName, fileSize, JSON.stringify(metadata), routeStateJson],
      );
      const inserted = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1', [newId]);
      return res.json({ file: rowToGpsFile(inserted.rows[0]) });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'GPS file not found on disk' });
    console.error('GPS edit save:', err);
    res.status(500).json({ error: 'Failed to save edited GPS track' });
  }
});

// PUT /api/gps/:id/route-state — persist editing state without rewriting the GPX
router.put('/:id/route-state', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const { routeState } = req.body as { routeState?: GpsRouteStateV1 };
    const stateError = validateRouteState(routeState);
    if (stateError) return res.status(400).json({ error: `Invalid route state: ${stateError}` });
    const state = routeState as GpsRouteStateV1;
    state.metadata = computeRouteStateMetadata(state);
    const result = await query<GpsFileRow>(
      'UPDATE gps_files SET route_state = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [JSON.stringify(state), req.params.id, userId],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('GPS route-state save:', err);
    res.status(500).json({ error: 'Failed to save route state' });
  }
});

// DELETE /api/gps/:id
router.delete('/:id', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const result = await query<GpsFileRow>('DELETE FROM gps_files WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    fs.unlink(path.join(UPLOAD_DIR, path.basename(row.file_path)), () => {});
    res.json({ ok: true });
  } catch (err) { console.error('GPS delete:', err); res.status(500).json({ error: 'Failed to delete' }); }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeCache = new LRUCache<string, any>({
  max: 1000,
  ttl: 1000 * 60 * 30, // 30 minutes for successful routes
});

// Negative cache: failed route attempts are remembered briefly so a stuck
// upstream doesn't get hammered with identical retries.
const routeFailCache = new LRUCache<string, { status: number; error: string; code: string }>({
  max: 1000,
  ttl: 1000 * 60 * 2, // 2 minutes
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poiCache = new LRUCache<string, any>({
  max: 1000,
  ttl: 1000 * 60 * 10, // 10 minutes
});

const VALHALLA_LOCATION_TYPES = ['break', 'through', 'via', 'break_through'];

class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// POST /api/gps/route — proxy to the FOSSGIS Valhalla routing service.
// The public server's CORS policy blocks browser requests from third-party
// origins, so the backend forwards them instead. No API key; fair-use applies.
// Supports ordered Valhalla location types (break/through/via/break_through)
// and separate routing vs. display coordinates (display_lat/display_lon).
router.post('/route', async (req, res) => {
  const { locations, costing, costing_options: costingOptions } = (req.body ?? {}) as {
    locations?: Array<{
      lat?: unknown; lon?: unknown;
      display_lat?: unknown; display_lon?: unknown;
      type?: unknown; name?: unknown; id?: unknown;
    }>;
    costing?: unknown;
    costing_options?: unknown;
  };
  if (
    !Array.isArray(locations) || locations.length < 2 || locations.length > 25 ||
    locations.some(l =>
      typeof l?.lat !== 'number' || typeof l?.lon !== 'number' ||
      l.lat < -90 || l.lat > 90 || l.lon < -180 || l.lon > 180 ||
      (l.type !== undefined && !VALHALLA_LOCATION_TYPES.includes(l.type as string)) ||
      (l.display_lat !== undefined && (typeof l.display_lat !== 'number' || l.display_lat < -90 || l.display_lat > 90)) ||
      (l.display_lon !== undefined && (typeof l.display_lon !== 'number' || l.display_lon < -180 || l.display_lon > 180)),
    ) ||
    (costing !== 'bicycle' && costing !== 'pedestrian')
  ) {
    return res.status(400).json({ error: 'Invalid routing request', code: 'invalid_request' });
  }

  const roundedLocs = locations.map(l => ({
    lat: Number((l.lat as number).toFixed(6)),
    lon: Number((l.lon as number).toFixed(6)),
    ...(typeof l.type === 'string' ? { type: l.type } : {}),
    ...(typeof l.display_lat === 'number' && typeof l.display_lon === 'number'
      ? { display_lat: Number(l.display_lat.toFixed(6)), display_lon: Number(l.display_lon.toFixed(6)) }
      : {}),
    ...(typeof l.name === 'string' ? { name: l.name.slice(0, 100) } : {}),
  }));

  const cacheKey = JSON.stringify({
    locs: roundedLocs.map(l => ({ lat: l.lat, lon: l.lon, type: (l as { type?: string }).type ?? 'break' })),
    costing,
    costingOptions,
  });
  const cached = routeCache.get(cacheKey);
  if (cached) return res.json(cached);
  const cachedFail = routeFailCache.get(cacheKey);
  if (cachedFail) return res.status(cachedFail.status).json({ error: cachedFail.error, code: cachedFail.code });

  const VALHALLA_URL = process.env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de/route';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callValhalla = async (locs: any[]) => {
    let upstream: Response;
    try {
      upstream = await fetch(VALHALLA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'solytiq-cloud' },
        body: JSON.stringify({
          locations: locs,
          costing,
          ...(costingOptions && typeof costingOptions === 'object' ? { costing_options: costingOptions } : {}),
        }),
        signal: AbortSignal.timeout(12000),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new RouteError(504, 'upstream_timeout', 'Routing service timed out');
      }
      throw new RouteError(502, 'upstream_unavailable', 'Routing service unavailable');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await upstream.json().catch(() => null)) as any;
    if (upstream.ok && data?.trip) return data;
    // Valhalla "no route found" family (442 = no route, 440/443/444 = unreachable points)
    if (data?.error_code != null && [440, 442, 443, 444].includes(Number(data.error_code))) {
      throw new RouteError(422, 'no_route', String(data.error ?? 'No route found'));
    }
    throw new RouteError(502, 'upstream_unavailable', `Valhalla error ${upstream.status}`);
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finalData: any;
    if (locations.length <= 3) {
      finalData = await callValhalla(roundedLocs);
    } else {
      // Chunking for more than 3 locations if needed, or try all at once first
      try {
        finalData = await callValhalla(roundedLocs);
      } catch (err) {
        if (err instanceof RouteError && err.code !== 'no_route') throw err;
        console.warn('Valhalla full route failed, trying chunks:', err);
        // Overlapping triplets: [0,1,2], [2,3,4], [4,5,6]...
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allLegs: any[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let tripMeta: any = null;
        for (let i = 0; i < roundedLocs.length - 1; i += 2) {
          const chunk = roundedLocs.slice(i, i + 3);
          if (chunk.length < 2) break;
          const data = await callValhalla(chunk);
          if (!tripMeta) tripMeta = data.trip;
          allLegs.push(...data.trip.legs);
        }
        finalData = { trip: { ...tripMeta, legs: allLegs } };
      }
    }

    routeCache.set(cacheKey, finalData);
    res.json(finalData);
  } catch (err) {
    const status = err instanceof RouteError ? err.status : 502;
    const code = err instanceof RouteError ? err.code : 'upstream_unavailable';
    const message = err instanceof RouteError ? err.message : 'Routing service unavailable';
    console.error('Valhalla routing error:', err);
    routeFailCache.set(cacheKey, { status, error: message, code });
    res.status(status).json({ error: message, code });
  }
});

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const OVERPASS_QUERIES: Record<string, string> = {
  food:     'node["amenity"~"cafe|restaurant|bar|fast_food"]',
  fuel:     'node["amenity"="fuel"]',
  bicycle:  'node["shop"="bicycle"]',
  shopping: 'node["shop"~"supermarket|convenience"]',
  kiosk:    'node["shop"="kiosk"]',
};

function detectCategory(tags: Record<string, string>): string {
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'bicycle') return 'bicycle';
  if (tags.shop === 'kiosk') return 'kiosk';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'shopping';
  return 'food';
}

const MAX_POI_RESULTS = 750;

router.post('/pois', async (req, res) => {
  const { bbox, categories, zoom } = (req.body ?? {}) as {
    bbox?: { south: number; west: number; north: number; east: number };
    categories?: string[];
    zoom?: number;
  };

  if (
    !bbox || typeof zoom !== 'number' || !Array.isArray(categories) ||
    [bbox.south, bbox.west, bbox.north, bbox.east].some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
    bbox.south < -90 || bbox.north > 90 || bbox.west < -180 || bbox.east > 180 ||
    bbox.south >= bbox.north || bbox.west >= bbox.east
  ) {
    return res.status(400).json({ error: 'Invalid POI request' });
  }

  // Normalize against the allowlist; unknown categories are dropped
  const normalizedCategories = [...new Set(categories.filter(c => c in OVERPASS_QUERIES))].sort();
  if (normalizedCategories.length === 0) return res.json({ pois: [], truncated: false, cached: false });

  if (zoom < 13) return res.json({ pois: [], truncated: false, cached: false });

  // Guard bbox area to prevent huge queries
  const area = (bbox.north - bbox.south) * (bbox.east - bbox.west);
  if (area > 0.1) { // roughly 30x30km max
    return res.status(400).json({ error: 'BBox area too large' });
  }

  // Round bbox into tile buckets so panning by a few pixels hits the cache
  const roundedBbox = {
    south: Number(bbox.south.toFixed(4)),
    west: Number(bbox.west.toFixed(4)),
    north: Number(bbox.north.toFixed(4)),
    east: Number(bbox.east.toFixed(4)),
  };

  const cacheKey = JSON.stringify({ roundedBbox, categories: normalizedCategories, zoomBucket: Math.floor(zoom) });
  const cached = poiCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const overpassBbox = `${roundedBbox.south.toFixed(5)},${roundedBbox.west.toFixed(5)},${roundedBbox.north.toFixed(5)},${roundedBbox.east.toFixed(5)}`;
  const lines = normalizedCategories.map(cat => `${OVERPASS_QUERIES[cat]}(${overpassBbox});`).join('\n  ');
  const query = `[out:json][timeout:10];\n(\n  ${lines}\n);\nout body ${MAX_POI_RESULTS + 1};`;

  try {
    let response: Response | null = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(12000),
        });
        if (upstream.ok) {
          response = upstream;
          break;
        }
        // Log non-ok statuses too — silent 429/504 skips made outages invisible
        console.warn(`Overpass endpoint ${endpoint} returned HTTP ${upstream.status}`);
      } catch (err) {
        console.error(`Overpass endpoint ${endpoint} failed:`, err);
      }
    }

    if (!response) return res.status(502).json({ error: 'Overpass service unavailable' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elements: any[] = data.elements ?? [];
    // Deduplicate by OSM object identity (node-123 / way-123 / relation-123)
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pois: any[] = [];
    for (const el of elements) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      const osmId = `${el.type ?? 'node'}-${el.id}`;
      if (seen.has(osmId)) continue;
      seen.add(osmId);
      const tags = el.tags ?? {};
      pois.push({
        id: `osm-${osmId}`,
        lat,
        lon,
        category: detectCategory(tags),
        name: tags.name || tags.brand || tags.operator || 'Unbekannt',
        // Only the fields the frontend actually renders
        tags: {
          ...(tags['addr:street'] ? { 'addr:street': tags['addr:street'] } : {}),
          ...(tags['addr:housenumber'] ? { 'addr:housenumber': tags['addr:housenumber'] } : {}),
          ...(tags['addr:city'] ? { 'addr:city': tags['addr:city'] } : {}),
          ...(tags['addr:town'] ? { 'addr:town': tags['addr:town'] } : {}),
          ...(tags.opening_hours ? { opening_hours: tags.opening_hours } : {}),
          ...(tags.phone ? { phone: tags.phone } : {}),
          ...(tags['contact:phone'] ? { 'contact:phone': tags['contact:phone'] } : {}),
          ...(tags.website ? { website: tags.website } : {}),
          ...(tags['contact:website'] ? { 'contact:website': tags['contact:website'] } : {}),
        },
      });
      if (pois.length >= MAX_POI_RESULTS) break;
    }

    const result = { pois, truncated: elements.length > MAX_POI_RESULTS, cached: false };
    poiCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Overpass query error:', err);
    res.status(502).json({ error: 'Overpass service unavailable' });
  }
});

export default router;
