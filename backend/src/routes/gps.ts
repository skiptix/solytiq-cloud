import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { LRUCache } from 'lru-cache';
import { query } from '../db';
import { authenticate } from '../middleware';

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
interface GpsPoint {
  lat: number; lon: number; ele: number; time?: string;
  hr?: number; cadence?: number; power?: number;
}
interface GpsWaypoint {
  id: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym: string;
  highlighted?: boolean;
  addedToRoute?: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
}
interface GpsFileRow {
  id: string; user_id: string; original_name: string; file_type: string;
  file_path: string; file_size: number; metadata: Record<string, unknown> | null;
  created_at: string; smoothed: boolean;
}

// ─── Utilities ───────────────────────────────────────────────────────────────
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeMetadata(points: GpsPoint[]) {
  if (points.length === 0) return null;
  let totalDistance = 0, totalElevationGain = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    const δ = points[i].ele - points[i - 1].ele;
    if (δ > 0) totalElevationGain += δ;
  }
  const startTime = points[0].time ?? null;
  const endTime = points[points.length - 1].time ?? null;
  const duration = startTime && endTime
    ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
    : null;
  return {
    totalDistance: Math.round(totalDistance),
    totalElevationGain: Math.round(totalElevationGain),
    duration,
    startTime,
    pointCount: points.length,
  };
}

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

export function buildElevationProfile(points: GpsPoint[]) {
  let cum = 0;
  return points.map((p, i) => {
    if (i > 0) cum += haversine(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
    return { distance: Math.round(cum), elevation: p.ele, idx: i };
  });
}

// Named waypoint input (from frontend route editor)
interface WaypointInput {
  id?: string;
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  description?: string;
  sym?: string;
  highlighted?: boolean;
  addedToRoute?: boolean;
  offRoad?: boolean;
  pointId?: string | null;
  originalLat?: number;
  originalLon?: number;
}

const GPX_SYM_MAP: Record<string, string> = {
  food: 'Restaurant',
  fuel: 'Gas Station',
  bicycle: 'Bike Shop',
  shopping: 'Grocery Store',
  kiosk: 'Convenience Store',
  flag: 'Flag',
  generic: 'Waypoint',
};

const GPX_SYM_TO_APP: Record<string, string> = {
  'Restaurant': 'food',
  'Gas Station': 'fuel',
  'Bike Shop': 'bicycle',
  'Grocery Store': 'shopping',
  'Convenience Store': 'kiosk',
  'Flag': 'flag',
  'Waypoint': 'generic',
};

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function writeGpx(points: GpsPoint[], name = 'Route', waypoints: WaypointInput[] = []): string {
  const safeName = escXml(name);
  // <wpt> elements MUST appear before <trk> per GPX 1.1 spec (required for Wahoo)
  const wptXml = waypoints.map(w => {
    const elePart = w.ele != null ? `\n      <ele>${Number(w.ele).toFixed(2)}</ele>` : '';
    const descPart = w.description ? `\n      <desc>${escXml(w.description)}</desc>` : '';
    const symPart = w.sym ? `\n      <sym>${GPX_SYM_MAP[w.sym] ?? 'Waypoint'}</sym>` : '';

    // Solytiq extensions for full roundtrip
    const extAttrs: string[] = [];
    if (w.id) extAttrs.push(`id="${escXml(w.id)}"`);
    if (w.addedToRoute !== undefined) extAttrs.push(`addedToRoute="${w.addedToRoute}"`);
    if (w.highlighted !== undefined) extAttrs.push(`highlighted="${w.highlighted}"`);
    if (w.offRoad !== undefined) extAttrs.push(`offRoad="${w.offRoad}"`);
    if (w.pointId) extAttrs.push(`pointId="${escXml(w.pointId)}"`);
    if (w.originalLat !== undefined) extAttrs.push(`originalLat="${w.originalLat.toFixed(7)}"`);
    if (w.originalLon !== undefined) extAttrs.push(`originalLon="${w.originalLon.toFixed(7)}"`);

    const extensions = extAttrs.length > 0
      ? `\n      <extensions>\n        <solytiq:waypoint ${extAttrs.join(' ')} />\n      </extensions>`
      : '';

    return `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">${elePart}\n      <name>${escXml(w.name)}</name>${descPart}${symPart}\n      <type>User Waypoint</type>${extensions}\n  </wpt>`;
  }).join('\n');
  const trkpts = points.map(p => {
    const eleLine = `        <ele>${p.ele.toFixed(2)}</ele>`;
    const timeLine = p.time ? `\n        <time>${p.time}</time>` : '';
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">\n${eleLine}${timeLine}\n      </trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Solytiq Cloud" xmlns="http://www.topografix.com/GPX/1/1" xmlns:solytiq="https://solytiq.cloud/gpx/1/0">\n  <metadata><name>${safeName}</name></metadata>\n${wptXml ? wptXml + '\n' : ''}  <trk>\n    <name>${safeName}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;
}

// ─── Parsers ─────────────────────────────────────────────────────────────────
interface ParsedGpxData {
  points: GpsPoint[];
  waypoints: GpsWaypoint[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseGpx(content: string): ParsedGpxData {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['trkpt', 'trkseg', 'trk', 'wpt'].includes(name),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = parser.parse(content);
  const gpx = result.gpx ?? result;

  const waypoints: GpsWaypoint[] = [];
  if (gpx?.wpt) {
    const wpts = Array.isArray(gpx.wpt) ? gpx.wpt : [gpx.wpt];
    wpts.forEach((wp: any, index: number) => {
      const lat = parseFloat(wp['@_lat']);
      const lon = parseFloat(wp['@_lon']);
      if (isNaN(lat) || isNaN(lon)) return;

      const name = wp.name ? String(wp.name) : 'Waypoint';
      const sym = wp.sym ? (GPX_SYM_TO_APP[wp.sym] ?? 'generic') : 'generic';

      // Fallback stable ID if Solytiq extension is missing
      let id = crypto.createHash('sha1').update(`${lat}:${lon}:${name}:${index}`).digest('hex');
      let addedToRoute = false;
      let highlighted = false;
      let offRoad = false;
      let pointId = null;
      let originalLat = undefined;
      let originalLon = undefined;

      const ext = wp.extensions?.['solytiq:waypoint'];
      if (ext) {
        if (ext['@_id']) id = ext['@_id'];
        if (ext['@_addedToRoute']) addedToRoute = ext['@_addedToRoute'] === 'true';
        if (ext['@_highlighted']) highlighted = ext['@_highlighted'] === 'true';
        if (ext['@_offRoad']) offRoad = ext['@_offRoad'] === 'true';
        if (ext['@_pointId']) pointId = ext['@_pointId'];
        if (ext['@_originalLat']) originalLat = parseFloat(ext['@_originalLat']);
        if (ext['@_originalLon']) originalLon = parseFloat(ext['@_originalLon']);
      }

      waypoints.push({
        id, lat, lon,
        ele: parseFloat(wp.ele) || 0,
        name,
        description: wp.desc ? String(wp.desc) : undefined,
        sym,
        addedToRoute,
        highlighted,
        offRoad,
        pointId,
        originalLat,
        originalLon,
      });
    });
  }

  const points: GpsPoint[] = [];
  if (gpx?.trk) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trks: any[] = Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk];
    for (const trk of trks) {
      if (!trk?.trkseg) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs: any[] = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
      for (const seg of segs) {
        if (!seg?.trkpt) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trkpts: any[] = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
        for (const pt of trkpts) {
          const lat = parseFloat(pt['@_lat']);
          const lon = parseFloat(pt['@_lon']);
          if (isNaN(lat) || isNaN(lon)) continue;
          points.push({
            lat, lon,
            ele: parseFloat(pt.ele) || 0,
            time: pt.time ? String(pt.time) : undefined,
          });
        }
      }
    }
  }
  return { points, waypoints };
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
  const abs = path.join(UPLOAD_DIR, filePath);
  if (fileType === 'fit') {
    const points = await parseFit(fs.readFileSync(abs));
    return { points, waypoints: [] };
  }
  return parseGpx(fs.readFileSync(abs, 'utf-8'));
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
        const parsed = parseGpx(fs.readFileSync(file.path, 'utf-8'));
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

    const { points, waypoints } = await readAndParse(row.file_path, row.file_type);

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
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(outName)}.gpx"`);
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
    const filePath = path.join(UPLOAD_DIR, row.file_path);

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
      const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const abs = path.join(UPLOAD_DIR, row.file_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File not on disk' });
    const mime = row.file_type === 'fit' ? 'application/octet-stream' : 'application/gpx+xml';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_name)}"`);
    res.sendFile(abs);
  } catch (err) { console.error('GPS download:', err); res.status(500).json({ error: 'Failed to download' }); }
});

// PUT /api/gps/:id/points — save edited track points as new or replaced GPX file
router.put('/:id/points', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const { id } = req.params;
    const { points, saveAs = 'new', name, waypoints = [] } = req.body as {
      points: GpsPoint[];
      saveAs?: 'new' | 'replace';
      name?: string;
      waypoints?: WaypointInput[];
    };

    if (!Array.isArray(points) || points.length < 2) {
      return res.status(400).json({ error: 'points must be an array with at least 2 entries' });
    }
    for (const p of points) {
      if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || typeof p.ele !== 'number') {
        return res.status(400).json({ error: 'Each point must have lat, lon, ele as numbers' });
      }
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

    if (saveAs === 'replace') {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, origFile.file_path)); } catch { /* ignore */ }
      await query(
        `UPDATE gps_files SET file_path = $1, original_name = $2, file_size = $3, metadata = $4 WHERE id = $5 AND user_id = $6`,
        [newFileName, `${outputName}.gpx`, fileSize, JSON.stringify(metadata), id, userId],
      );
      const updated = await query<GpsFileRow>('SELECT * FROM gps_files WHERE id = $1', [id]);
      return res.json({ file: rowToGpsFile(updated.rows[0]) });
    } else {
      const newId = crypto.randomUUID();
      await query(
        `INSERT INTO gps_files (id, user_id, original_name, file_type, file_path, file_size, metadata) VALUES ($1, $2, $3, 'gpx', $4, $5, $6)`,
        [newId, userId, `${outputName}.gpx`, newFileName, fileSize, JSON.stringify(metadata)],
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

// DELETE /api/gps/:id
router.delete('/:id', async (req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId as string;
    const result = await query<GpsFileRow>('DELETE FROM gps_files WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    fs.unlink(path.join(UPLOAD_DIR, row.file_path), () => {});
    res.json({ ok: true });
  } catch (err) { console.error('GPS delete:', err); res.status(500).json({ error: 'Failed to delete' }); }
});

const routeCache = new LRUCache<string, any>({
  max: 1000,
  ttl: 1000 * 60 * 30, // 30 minutes
});

const poiCache = new LRUCache<string, any>({
  max: 1000,
  ttl: 1000 * 60 * 30, // 30 minutes
});

// POST /api/gps/route — proxy to the FOSSGIS Valhalla routing service.
// The public server's CORS policy blocks browser requests from third-party
// origins, so the backend forwards them instead. No API key; fair-use applies.
router.post('/route', async (req, res) => {
  const { locations, costing, costing_options: costingOptions } = (req.body ?? {}) as {
    locations?: Array<{ lat?: unknown; lon?: unknown }>;
    costing?: unknown;
    costing_options?: unknown;
  };
  if (
    !Array.isArray(locations) || locations.length < 2 || locations.length > 25 ||
    locations.some(l => typeof l?.lat !== 'number' || typeof l?.lon !== 'number' || l.lat < -90 || l.lat > 90 || l.lon < -180 || l.lon > 180) ||
    (costing !== 'bicycle' && costing !== 'pedestrian')
  ) {
    return res.status(400).json({ error: 'Invalid routing request' });
  }

  const roundedLocs = locations.map(l => ({
    lat: Number((l.lat as number).toFixed(6)),
    lon: Number((l.lon as number).toFixed(6)),
  }));

  const cacheKey = JSON.stringify({ roundedLocs, costing, costingOptions });
  const cached = routeCache.get(cacheKey);
  if (cached) return res.json(cached);

  const VALHALLA_URL = process.env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de/route';

  const callValhalla = async (locs: Array<{ lat: number; lon: number }>) => {
    const upstream = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'solytiq-cloud' },
      body: JSON.stringify({
        locations: locs,
        costing,
        ...(costingOptions && typeof costingOptions === 'object' ? { costing_options: costingOptions } : {}),
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = (await upstream.json().catch(() => null)) as any;
    if (!upstream.ok || !data || !data.trip) {
      throw new Error(`Valhalla error ${upstream.status}`);
    }
    return data;
  };

  try {
    let finalData: any;
    if (locations.length <= 3) {
      finalData = await callValhalla(roundedLocs);
    } else {
      // Chunking for more than 3 locations if needed, or try all at once first
      try {
        finalData = await callValhalla(roundedLocs);
      } catch (err) {
        console.warn('Valhalla full route failed, trying chunks:', err);
        // Overlapping triplets: [0,1,2], [2,3,4], [4,5,6]...
        const allLegs: any[] = [];
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
    console.error('Valhalla routing error:', err);
    res.status(502).json({ error: 'Routing service unavailable' });
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

router.post('/pois', async (req, res) => {
  const { bbox, categories, zoom } = (req.body ?? {}) as {
    bbox?: { south: number; west: number; north: number; east: number };
    categories?: string[];
    zoom?: number;
  };

  if (!bbox || !Array.isArray(categories) || categories.length === 0 || zoom === undefined) {
    return res.status(400).json({ error: 'Invalid POI request' });
  }

  if (zoom < 13) return res.json({ pois: [], truncated: false, cached: false });

  // Guard bbox area to prevent huge queries
  const area = (bbox.north - bbox.south) * (bbox.east - bbox.west);
  if (area > 0.1) { // roughly 30x30km max
    return res.status(400).json({ error: 'BBox area too large' });
  }

  // Round bbox for better caching
  const roundedBbox = {
    south: Number(bbox.south.toFixed(4)),
    west: Number(bbox.west.toFixed(4)),
    north: Number(bbox.north.toFixed(4)),
    east: Number(bbox.east.toFixed(4)),
  };

  const cacheKey = JSON.stringify({ roundedBbox, categories: [...categories].sort(), zoomBucket: Math.floor(zoom) });
  const cached = poiCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const overpassBbox = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
  const lines = categories.map(cat => `${OVERPASS_QUERIES[cat] || ''}(${overpassBbox});`).filter(Boolean).join('\n  ');
  const query = `[out:json][timeout:25];\n(\n  ${lines}\n);\nout body 1000;`; // Cap at 1000

  try {
    let response: Response | null = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(20000),
        });
        if (upstream.status === 429 || upstream.status === 504) continue;
        if (upstream.ok) {
          response = upstream;
          break;
        }
      } catch (err) {
        console.error(`Overpass endpoint ${endpoint} failed:`, err);
      }
    }

    if (!response) return res.status(502).json({ error: 'Overpass service unavailable' });

    const data = await response.json() as any;
    const elements = data.elements ?? [];
    const pois = elements
      .filter((el: any) => el.lat != null && el.lon != null)
      .map((el: any) => {
        const tags = el.tags ?? {};
        return {
          id: `osm-${el.id}`,
          lat: el.lat,
          lon: el.lon,
          category: detectCategory(tags),
          name: tags.name || tags.brand || tags.operator || 'Unbekannt',
          tags,
        };
      });

    const result = { pois, truncated: elements.length >= 1000, cached: false };
    poiCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Overpass query error:', err);
    res.status(502).json({ error: 'Overpass service unavailable' });
  }
});

export default router;
