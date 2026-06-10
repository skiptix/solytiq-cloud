import type { OverpassPoi, PoiCategory } from '../types';

// OSM-Tags pro Kategorie
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
  return 'food'; // cafe, restaurant, bar, fast_food
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

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    signal,
  });

  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json() as { elements?: Array<{
    id: number; lat: number; lon: number;
    tags?: Record<string, string>;
  }> };

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
