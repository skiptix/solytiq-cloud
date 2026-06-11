import type { NominatimResult } from '../types';

const BASE = 'https://nominatim.openstreetmap.org';

export function parseCoordInput(input: string): [number, number] | null {
  const m = input.trim().match(/^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

export async function searchNominatim(
  query: string,
  viewbox?: { south: number; west: number; north: number; east: number },
  signal?: AbortSignal,
): Promise<NominatimResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '6',
    addressdetails: '1',
  });
  if (viewbox) {
    params.set('viewbox', `${viewbox.west},${viewbox.south},${viewbox.east},${viewbox.north}`);
    params.set('bounded', '0');
  }
  const res = await fetch(`${BASE}/search?${params}`, {
    headers: { 'Accept-Language': 'de,en', 'User-Agent': 'Solytiq-Cloud/1.0' },
    signal,
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json() as Promise<NominatimResult[]>;
}
