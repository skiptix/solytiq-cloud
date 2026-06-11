import type { GpsTrackPoint } from '../types';

export interface SurfaceBreakdown {
  road: number;    // % paved/asphalt
  gravel: number;  // % gravel/unpaved/track
  path: number;    // % dirt/path/singletrack
  unknown: number; // % unknown
}

const PAVED_SURFACES = new Set(['asphalt', 'paved', 'concrete', 'cobblestone', 'sett', 'paving_stones', 'metal', 'wood', 'tar', 'concrete:plates', 'concrete:lanes']);
const GRAVEL_SURFACES = new Set(['gravel', 'unpaved', 'compacted', 'fine_gravel', 'rock', 'pebblestone', 'gravel;unpaved', 'fine_gravel;unpaved']);
const DIRT_SURFACES = new Set(['dirt', 'ground', 'sand', 'mud', 'clay', 'grass', 'earth', 'woodchips', 'natural', 'soil']);
const PAVED_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road']);

function classifyWay(tags: Record<string, string>): keyof SurfaceBreakdown {
  const surface = (tags['surface'] ?? '').toLowerCase();
  const highway = (tags['highway'] ?? '').toLowerCase();
  const tracktype = (tags['tracktype'] ?? '').toLowerCase();

  if (PAVED_SURFACES.has(surface)) return 'road';
  if (GRAVEL_SURFACES.has(surface)) return 'gravel';
  if (DIRT_SURFACES.has(surface)) return 'path';

  if (PAVED_HIGHWAYS.has(highway)) return 'road';
  if (highway === 'track') {
    if (tracktype === 'grade1' || tracktype === 'grade2') return 'gravel';
    if (tracktype) return 'path';
    return 'gravel';
  }
  if (highway === 'path' || highway === 'footway' || highway === 'bridleway' || highway === 'cycleway') return 'path';

  return 'unknown';
}

export async function fetchSurfaceBreakdown(
  points: GpsTrackPoint[],
  signal: AbortSignal,
): Promise<SurfaceBreakdown | null> {
  if (points.length < 2) return null;

  // Sample max 60 evenly-spaced points
  const maxSamples = 60;
  const step = Math.max(1, Math.floor(points.length / maxSamples));
  const sample: GpsTrackPoint[] = [];
  for (let i = 0; i < points.length; i += step) sample.push(points[i]);
  if (sample[sample.length - 1] !== points[points.length - 1]) sample.push(points[points.length - 1]);

  const coordStr = sample.map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
  const overpassQuery = `[out:json][timeout:18];way[highway](around:35,${coordStr});out tags;`;

  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(overpassQuery)}`,
      signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { elements: Array<{ tags?: Record<string, string> }> };

    const counts: Record<keyof SurfaceBreakdown, number> = { road: 0, gravel: 0, path: 0, unknown: 0 };
    let total = 0;
    for (const el of data.elements) {
      if (el.tags?.highway) {
        const cat = classifyWay(el.tags);
        counts[cat]++;
        total++;
      }
    }
    if (total === 0) return { road: 0, gravel: 0, path: 0, unknown: 100 };

    const pct = (n: number) => Math.round((n / total) * 100);
    const road = pct(counts.road);
    const gravel = pct(counts.gravel);
    const path = pct(counts.path);
    const unknown = 100 - road - gravel - path;
    return { road, gravel, path, unknown: Math.max(0, unknown) };
  } catch {
    return null;
  }
}
