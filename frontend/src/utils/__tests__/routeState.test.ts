import { describe, it, expect } from 'vitest';
import type { NamedPin, OverpassPoi } from '../../types';
import {
  WAYPOINT_ATTACH_TOLERANCE_M,
  findById,
  findNearestPointWithinMeters,
  findNearestPointIndex,
  poiMarkerToNamedPin,
  namedPinToPoiMarker,
  buildRouteStateFromEditor,
  diffPoiMarkers,
  extendAnchorIndexByDistance,
} from '../routeState';

const track = [
  { lat: 54.3000, lon: 10.1200, ele: 10 },
  { lat: 54.3050, lon: 10.1250, ele: 14 },
  { lat: 54.3100, lon: 10.1300, ele: 12 },
];

describe('identity helpers — no exact coordinate equality', () => {
  it('findById matches by stable ID', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    expect(findById(items, 'b')).toBe(items[1]);
    expect(findById(items, 'missing')).toBeNull();
    expect(findById(items, null)).toBeNull();
  });

  it('findNearestPointWithinMeters matches within tolerance, not exactly', () => {
    // ~2 m offset from track[1] — must still match
    const idx = findNearestPointWithinMeters(track, 54.305018, 10.125, WAYPOINT_ATTACH_TOLERANCE_M);
    expect(idx).toBe(1);
  });

  it('findNearestPointWithinMeters returns -1 outside tolerance', () => {
    // ~100 m away from everything
    const idx = findNearestPointWithinMeters(track, 54.3059, 10.1250, WAYPOINT_ATTACH_TOLERANCE_M);
    expect(idx).toBe(-1);
  });

  it('findNearestPointIndex always returns the closest point', () => {
    expect(findNearestPointIndex(track, 54.3101, 10.1301)).toBe(2);
  });
});

describe('extendAnchorIndexByDistance', () => {
  // Points ~111 m apart along a meridian
  const dense = Array.from({ length: 21 }, (_, i) => ({ lat: 54.3 + i * 0.001, lon: 10.12 }));

  it('stops after roughly the requested distance, not at the route ends', () => {
    const next = extendAnchorIndexByDistance(dense, 10, 1, dense.length - 1, 400);
    const prev = extendAnchorIndexByDistance(dense, 10, -1, 0, 400);
    // 400 m ≈ 4 points of ~111 m; must NOT reach the bounds (0 / 20)
    expect(next).toBeGreaterThan(10);
    expect(next).toBeLessThan(16);
    expect(prev).toBeLessThan(10);
    expect(prev).toBeGreaterThan(4);
  });

  it('clamps to the bound index on short tracks', () => {
    expect(extendAnchorIndexByDistance(dense, 1, -1, 0, 4000)).toBe(0);
    expect(extendAnchorIndexByDistance(dense, 19, 1, 20, 4000)).toBe(20);
  });

  it('returns the immediate neighbour for sparse tracks (points farther than the cap)', () => {
    const sparse = [
      { lat: 54.30, lon: 10.12 },
      { lat: 54.32, lon: 10.12 }, // ~2.2 km apart
      { lat: 54.34, lon: 10.12 },
    ];
    expect(extendAnchorIndexByDistance(sparse, 1, 1, 2, 400)).toBe(2);
    expect(extendAnchorIndexByDistance(sparse, 1, -1, 0, 400)).toBe(0);
  });
});

describe('PoiMarker ↔ NamedPin conversion', () => {
  it('preserves IDs, original coordinates and route links both ways', () => {
    const pin: NamedPin = {
      id: 'pin_1', lat: 54.31, lon: 10.13, ele: 12, name: 'Cafe',
      description: 'Coffee', sym: 'food', highlighted: true, addedToRoute: true,
      originalLat: 54.3101, originalLon: 10.1302, linkedControlPointId: 'ctrl_7',
    };
    const marker = namedPinToPoiMarker(pin);
    // The marker keeps the ORIGINAL POI coordinate, not the snapped one
    expect(marker.lat).toBe(54.3101);
    expect(marker.lon).toBe(10.1302);
    expect(marker.id).toBe('pin_1');
    expect(marker.category).toBe('food');
    expect(marker.linkedControlPointId).toBe('ctrl_7');

    const roundtrip = poiMarkerToNamedPin(marker);
    expect(roundtrip.id).toBe('pin_1');
    expect(roundtrip.name).toBe('Cafe');
    expect(roundtrip.sym).toBe('food');
    expect(roundtrip.highlighted).toBe(true);
    expect(roundtrip.addedToRoute).toBe(true);
    expect(roundtrip.linkedControlPointId).toBe('ctrl_7');
    expect(roundtrip.originalLat).toBe(54.3101);
  });
});

describe('buildRouteStateFromEditor', () => {
  const pins: NamedPin[] = [
    {
      id: 'poi_route', lat: 54.3050, lon: 10.1250, name: 'Route Stop', sym: 'food',
      highlighted: false, addedToRoute: true,
      originalLat: 54.30502, originalLon: 10.12502, linkedControlPointId: 'wp_1',
    },
    {
      id: 'poi_pin', lat: 54.3000, lon: 10.1290, name: 'Pin Only', sym: 'flag',
      highlighted: true, addedToRoute: false,
    },
  ];
  const waypoints = [{ id: 'wp_1', lat: 54.3050, lon: 10.1250, offRoad: false }];

  it('separates track geometry, route controls and POI markers', () => {
    const state = buildRouteStateFromEditor({ points: track, waypoints, pins, profile: 'gravel' });
    expect(state.version).toBe(1);
    expect(state.trackPoints).toHaveLength(3);
    expect(state.poiMarkers).toHaveLength(2);
    // start + linked stop + destination
    expect(state.routeControls.map(c => c.kind)).toEqual(['start', 'stop', 'destination']);
    const stop = state.routeControls[1];
    expect(stop.id).toBe('wp_1');
    expect(stop.linkedPoiId).toBe('poi_route');
    // Control keeps the POI's original coordinate and the snapped one separately
    expect(stop.originalLat).toBe(54.30502);
    expect(stop.snappedLat).toBe(54.3050);
  });

  it('pin-only POIs do not become route controls or course points', () => {
    const state = buildRouteStateFromEditor({ points: track, waypoints, pins, profile: 'gravel' });
    expect(state.routeControls.some(c => c.linkedPoiId === 'poi_pin')).toBe(false);
    expect(state.coursePoints).toHaveLength(1);
    expect(state.coursePoints[0].poiId).toBe('poi_route');
    expect(state.coursePoints[0].distanceAlongRouteM).toBeGreaterThan(0);
  });

  it('unlinked shaping waypoints become via controls; off-road becomes offgrid', () => {
    const state = buildRouteStateFromEditor({
      points: track,
      waypoints: [
        { id: 'wp_via', lat: 54.3050, lon: 10.1250, offRoad: false },
        { id: 'wp_off', lat: 54.3100, lon: 10.1300, offRoad: true },
      ],
      pins: [],
      profile: 'mtb',
    });
    const kinds = Object.fromEntries(state.routeControls.map(c => [c.id, c.kind]));
    expect(kinds['wp_via']).toBe('via');
    expect(kinds['wp_off']).toBe('offgrid');
    expect(state.routeControls.find(c => c.id === 'wp_off')!.followWays).toBe(false);
  });

  it('produces a valid empty state for an empty plan with pins preserved', () => {
    const state = buildRouteStateFromEditor({ points: [], waypoints: [], pins, profile: 'road' });
    expect(state.trackPoints).toHaveLength(0);
    expect(state.routeControls).toHaveLength(0);
    expect(state.poiMarkers).toHaveLength(2);
    expect(state.metadata.pointCount).toBe(0);
  });
});

describe('diffPoiMarkers', () => {
  const poi = (id: string, lat: number, lon: number): OverpassPoi =>
    ({ id, lat, lon, category: 'food', name: id, tags: {} });

  it('only adds new markers, moves changed ones and removes stale ones', () => {
    const existing = new Map([
      ['osm-node-1', { lat: 54.30, lon: 10.12 }],
      ['osm-node-2', { lat: 54.31, lon: 10.13 }],
      ['osm-node-3', { lat: 54.32, lon: 10.14 }],
    ]);
    const incoming = [
      poi('osm-node-1', 54.30, 10.12),   // unchanged
      poi('osm-node-2', 54.3105, 10.13), // moved
      poi('osm-node-4', 54.33, 10.15),   // new
    ];
    const { toAdd, toMove, toRemove } = diffPoiMarkers(existing, incoming);
    expect(toAdd.map(p => p.id)).toEqual(['osm-node-4']);
    expect(toMove.map(p => p.id)).toEqual(['osm-node-2']);
    expect(toRemove).toEqual(['osm-node-3']);
  });

  it('does not recreate any markers when the response is identical', () => {
    const existing = new Map([['osm-node-1', { lat: 54.30, lon: 10.12 }]]);
    const { toAdd, toMove, toRemove } = diffPoiMarkers(existing, [poi('osm-node-1', 54.30, 10.12)]);
    expect(toAdd).toHaveLength(0);
    expect(toMove).toHaveLength(0);
    expect(toRemove).toHaveLength(0);
  });
});
