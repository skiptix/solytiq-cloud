import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseGpxFull, writeGpx, buildRouteStateFromGpx, validateRouteState,
  computeRouteStateMetadata, emptyRouteState, GpsRouteStateV1,
} from '../gpx';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

describe('parseGpxFull', () => {
  it('imports <wpt> waypoints as POIs alongside <trkpt> geometry', () => {
    const parsed = parseGpxFull(fixture('gpx-with-wpt.gpx'));
    expect(parsed.points).toHaveLength(4);
    expect(parsed.waypoints).toHaveLength(2);
    expect(parsed.name).toBe('Coastal Loop');

    const cafe = parsed.waypoints[0];
    expect(cafe.name).toBe('Cafe Stop');
    expect(cafe.description).toBe('Coffee and refill');
    expect(cafe.sym).toBe('food');
    expect(cafe.lat).toBeCloseTo(54.31, 6);

    const shop = parsed.waypoints[1];
    expect(shop.sym).toBe('bicycle');
  });

  it('generates stable fallback IDs for waypoints without Solytiq extensions', () => {
    const a = parseGpxFull(fixture('gpx-with-wpt.gpx'));
    const b = parseGpxFull(fixture('gpx-with-wpt.gpx'));
    expect(a.waypoints[0].id).toBe(b.waypoints[0].id);
    expect(a.waypoints[0].id).not.toBe(a.waypoints[1].id);
  });

  it('parses a valid empty planning route without error', () => {
    const parsed = parseGpxFull(fixture('empty-route.gpx'));
    expect(parsed.points).toHaveLength(0);
    expect(parsed.waypoints).toHaveLength(0);
  });

  it('reads Solytiq <solytiq:poi> and legacy <solytiq:waypoint> extensions', () => {
    const parsed = parseGpxFull(fixture('gpx-with-solytiq-extensions.gpx'));
    expect(parsed.waypoints).toHaveLength(2);

    const poi = parsed.waypoints[0];
    expect(poi.id).toBe('poi_123');
    expect(poi.addedToRoute).toBe(true);
    expect(poi.highlighted).toBe(true);
    expect(poi.linkedControlPointId).toBe('ctrl_456');
    expect(poi.originalLat).toBeCloseTo(47.50001, 6);
    expect(poi.originalLon).toBeCloseTo(11.00002, 6);
    expect(poi.distanceAlongRouteM).toBe(15320);

    const legacy = parsed.waypoints[1];
    expect(legacy.id).toBe('legacy_pin_1');
    expect(legacy.addedToRoute).toBe(false);
  });
});

describe('buildRouteStateFromGpx', () => {
  it('builds a route state with track points, POI markers and minimal controls', () => {
    const state = buildRouteStateFromGpx(parseGpxFull(fixture('gpx-with-wpt.gpx')));
    expect(state.version).toBe(1);
    expect(state.trackPoints).toHaveLength(4);
    expect(state.poiMarkers).toHaveLength(2);
    expect(state.poiMarkers[0].source).toBe('imported_gpx');
    expect(state.poiMarkers[0].category).toBe('food');
    // Minimal start + destination controls created from the track
    expect(state.routeControls).toHaveLength(2);
    expect(state.routeControls[0].kind).toBe('start');
    expect(state.routeControls[1].kind).toBe('destination');
    expect(state.metadata.pointCount).toBe(4);
    expect(state.metadata.totalDistance).toBeGreaterThan(0);
    expect(validateRouteState(state)).toBeNull();
  });

  it('returns a valid empty route state for an empty planning file', () => {
    const state = buildRouteStateFromGpx(parseGpxFull(fixture('empty-route.gpx')));
    expect(state.trackPoints).toHaveLength(0);
    expect(state.routeControls).toHaveLength(0);
    expect(state.poiMarkers).toHaveLength(0);
    expect(state.metadata.pointCount).toBe(0);
    expect(validateRouteState(state)).toBeNull();
  });

  it('preserves POI route links and original coordinates from extensions', () => {
    const state = buildRouteStateFromGpx(parseGpxFull(fixture('gpx-with-solytiq-extensions.gpx')));
    const poi = state.poiMarkers.find(p => p.id === 'poi_123')!;
    expect(poi.addedToRoute).toBe(true);
    expect(poi.highlighted).toBe(true);
    expect(poi.linkedControlPointId).toBe('ctrl_456');
    // PoiMarker keeps the ORIGINAL coordinate, not the snapped one
    expect(poi.lat).toBeCloseTo(47.50001, 6);
    expect(poi.lon).toBeCloseTo(11.00002, 6);
  });
});

describe('writeGpx', () => {
  it('writes <wpt> before <trk> and round-trips waypoint data', () => {
    const gpx = writeGpx(
      [
        { lat: 54.3, lon: 10.12, ele: 10 },
        { lat: 54.31, lon: 10.13, ele: 12 },
      ],
      'Roundtrip',
      [{
        id: 'poi_1', lat: 54.305, lon: 10.125, ele: 11, name: 'Café & "Bar"',
        description: 'Nice <spot>', sym: 'food', highlighted: true, addedToRoute: true,
        originalLat: 54.3051, originalLon: 10.1251,
        linkedControlPointId: 'ctrl_9', distanceAlongRouteM: 1234.6,
      }],
    );

    expect(gpx.indexOf('<wpt')).toBeGreaterThan(-1);
    expect(gpx.indexOf('<wpt')).toBeLessThan(gpx.indexOf('<trk>'));

    const parsed = parseGpxFull(gpx);
    expect(parsed.points).toHaveLength(2);
    expect(parsed.waypoints).toHaveLength(1);
    const wp = parsed.waypoints[0];
    expect(wp.id).toBe('poi_1');
    expect(wp.name).toBe('Café & "Bar"');
    expect(wp.description).toBe('Nice <spot>');
    expect(wp.sym).toBe('food');
    expect(wp.highlighted).toBe(true);
    expect(wp.addedToRoute).toBe(true);
    expect(wp.linkedControlPointId).toBe('ctrl_9');
    expect(wp.distanceAlongRouteM).toBe(1235);
    // The <wpt> coordinate is the ORIGINAL POI position
    expect(wp.lat).toBeCloseTo(54.3051, 6);
    expect(wp.lon).toBeCloseTo(10.1251, 6);
  });

  it('writes a parseable GPX for an empty route', () => {
    const gpx = writeGpx([], 'Empty Plan');
    const parsed = parseGpxFull(gpx);
    expect(parsed.points).toHaveLength(0);
    expect(parsed.name).toBe('Empty Plan');
  });
});

describe('validateRouteState', () => {
  const valid = (): GpsRouteStateV1 => ({
    version: 1,
    trackPoints: [{ id: 'tp_0', lat: 47, lon: 11, ele: 800 }],
    routeControls: [{
      id: 'c1', order: 0, kind: 'start', profile: 'gravel',
      originalLat: 47, originalLon: 11, followWays: true,
    }],
    routeSpans: [{
      id: 's1', fromControlId: 'c1', toControlId: 'c1', profile: 'gravel',
      followWays: true, status: 'routed', points: [], distanceM: 0, elevationGainM: 0,
    }],
    poiMarkers: [{
      id: 'p1', source: 'custom', lat: 47, lon: 11, name: 'Pin',
      category: 'flag', highlighted: false, addedToRoute: false,
    }],
    coursePoints: [{ id: 'cp1', distanceAlongRouteM: 0, name: 'Pin', category: 'flag' }],
    metadata: {},
  });

  it('accepts a structurally valid state and the empty state', () => {
    expect(validateRouteState(valid())).toBeNull();
    expect(validateRouteState(emptyRouteState())).toBeNull();
  });

  it('rejects malformed states with a reason', () => {
    expect(validateRouteState(null)).toMatch(/object/);
    expect(validateRouteState({ ...valid(), version: 2 })).toMatch(/version/);
    expect(validateRouteState({ ...valid(), trackPoints: [{ id: 'x', lat: 999, lon: 0, ele: 0 }] })).toMatch(/track point/);
    expect(validateRouteState({ ...valid(), routeControls: [{ ...valid().routeControls[0], kind: 'nonsense' }] })).toMatch(/kind/);
    expect(validateRouteState({ ...valid(), routeSpans: [{ ...valid().routeSpans[0], status: 'broken' }] })).toMatch(/status/);
    expect(validateRouteState({ ...valid(), poiMarkers: [{ ...valid().poiMarkers[0], category: 'castle' }] })).toMatch(/category/);
  });
});

describe('computeRouteStateMetadata', () => {
  it('computes distance and elevation gain across track points', () => {
    const state = emptyRouteState();
    state.trackPoints = [
      { id: 'a', lat: 54.30, lon: 10.12, ele: 10 },
      { id: 'b', lat: 54.31, lon: 10.12, ele: 25 },
      { id: 'c', lat: 54.32, lon: 10.12, ele: 15 },
    ];
    const meta = computeRouteStateMetadata(state);
    expect(meta.pointCount).toBe(3);
    // Two ~1.11 km legs along a meridian
    expect(meta.totalDistance).toBeGreaterThan(2100);
    expect(meta.totalDistance).toBeLessThan(2350);
    expect(meta.totalElevationGain).toBe(15);
  });
});
