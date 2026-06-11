import type { OverpassPoi, PoiCategory } from '../types';

export const OVERPASS_QUERIES: Record<PoiCategory, string> = {
  food:     'node["amenity"~"cafe|restaurant|bar|fast_food"]',
  fuel:     'node["amenity"="fuel"]',
  bicycle:  'node["shop"="bicycle"]',
  shopping: 'node["shop"~"supermarket|convenience"]',
  kiosk:    'node["shop"="kiosk"]',
};

function detectCategory(tags: Record<string, string>): PoiCategory {
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'bicycle') return 'bicycle';
  if (tags.shop === 'kiosk') return 'kiosk';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'shopping';
  return 'food';
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchFromOverpass(
  query: string,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal,
      });
      // 429 / 504 → try next endpoint; anything else → return as-is
      if (res.status === 429 || res.status === 504) {
        lastErr = new Error(`Overpass HTTP ${res.status} from ${endpoint}`);
        continue;
      }
      return res;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function queryOverpass(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<OverpassPoi[]> {
  if (categories.length === 0) return [];
  const bbox = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  const lines = categories.map(cat => `${OVERPASS_QUERIES[cat]}(${bbox});`).join('\n  ');
  const query = `[out:json][timeout:25];\n(\n  ${lines}\n);\nout body;`;
  const res = await fetchFromOverpass(query, signal);
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json() as {
    elements?: Array<{
      id: number; lat: number; lon: number;
      tags?: Record<string, string>;
    }>;
  };
  return (data.elements ?? [])
    .filter(el => el.lat != null && el.lon != null)
    .map(el => {
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
}
