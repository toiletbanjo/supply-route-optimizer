import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const SRO = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/geo.js']);
const g = SRO.core.geo;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

const TAIPEI = { lat: 25.0330, lon: 121.5654 };
// Point `mi` miles east (+) or west (-) of p along p's parallel (a great circle would bend
// toward the equator, which moves a chord by ~0.02 mi over 20 mi).
const alongParallel = (p, mi) => ({ lat: p.lat, lon: p.lon + mi / (g.MI_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180)) });
const KAOHSIUNG = { lat: 22.6273, lon: 120.3014 };

test('haversine: Taipei to Kaohsiung straight line', () => {
  const d = g.haversineMi(TAIPEI, KAOHSIUNG);
  // Independent check with the spherical law of cosines on the same radius.
  const r = Math.PI / 180;
  const c = Math.acos(Math.sin(TAIPEI.lat * r) * Math.sin(KAOHSIUNG.lat * r) +
    Math.cos(TAIPEI.lat * r) * Math.cos(KAOHSIUNG.lat * r) * Math.cos((KAOHSIUNG.lon - TAIPEI.lon) * r));
  near(d, c * 3958.7613, 1e-3, 'law of cosines');
  // About 297 km: published straight-line figures for the two city centres.
  assert.ok(d > 182 && d < 190, String(d));
  near(d * 1.609344, 296.8, 1.0, 'km');
  assert.equal(g.haversineMi(TAIPEI, TAIPEI), 0);
  near(g.haversineMi(KAOHSIUNG, TAIPEI), d, 1e-9, 'symmetric');
  near(g.haversineMi({ lat: 23, lon: 121 }, { lat: 24, lon: 121 }), 69.09, 0.01, 'one degree of latitude');
  // alternative point shapes
  near(g.haversineMi([25.0330, 121.5654], { lat: 22.6273, lng: 120.3014 }), d, 1e-9, 'array / lng');
});

test('bearing and destination', () => {
  near(g.bearing({ lat: 23, lon: 121 }, { lat: 24, lon: 121 }), 0, 1e-9, 'north');
  near(g.bearing({ lat: 0, lon: 121 }, { lat: 0, lon: 122 }), 90, 1e-9, 'east at the equator');
  near(g.bearing({ lat: 24, lon: 121 }, { lat: 23, lon: 121 }), 180, 1e-9, 'south');
  near(g.bearing({ lat: 0, lon: 122 }, { lat: 0, lon: 121 }), 270, 1e-9, 'west');
  const b = g.bearing(TAIPEI, KAOHSIUNG);
  assert.ok(b > 200 && b < 212, 'Kaohsiung is south-southwest of Taipei: ' + b);
  const p = g.destination(TAIPEI, 45, 100);
  near(g.haversineMi(TAIPEI, p), 100, 1e-6, 'distance back');
  near(g.bearing(TAIPEI, p), 45, 1e-6, 'bearing back');
  const q = g.destination({ lat: 23, lon: 121 }, 0, 69.0935);
  near(q.lat, 24, 0.001);
  near(q.lon, 121, 1e-9);
});

test('pointInCircle', () => {
  const c = { lat: 23.5, lon: 121, radiusMi: 5 };
  assert.equal(g.pointInCircle(g.destination(c, 30, 4.9), c), true);
  assert.equal(g.pointInCircle(g.destination(c, 30, 5.1), c), false);
  assert.equal(g.pointInCircle(c, c), true);
});

test('segmentCircleMiles', () => {
  const c = { lat: 23.5, lon: 121 };
  const r = 5;
  // through the centre = diameter (east-west and north-south)
  near(g.segmentCircleMiles(g.destination(c, 90, 20), g.destination(c, 270, 20), c, r), 10, 0.02, 'E-W through centre');
  near(g.segmentCircleMiles(g.destination(c, 0, 20), g.destination(c, 180, 20), c, r), 10, 0.02, 'N-S through centre');
  // chord at offset 3 -> 2 * sqrt(25 - 9) = 8
  const off = g.destination(c, 0, 3);
  near(g.segmentCircleMiles(alongParallel(off, 20), alongParallel(off, -20), c, r), 8, 0.01, 'chord');
  // misses
  const far = g.destination(c, 0, 6);
  assert.equal(g.segmentCircleMiles(alongParallel(far, 20), alongParallel(far, -20), c, r), 0);
  // starts at the centre -> radius
  near(g.segmentCircleMiles(c, g.destination(c, 90, 20), c, r), 5, 0.01, 'from centre');
  // fully inside -> its own length
  const a = g.destination(c, 90, 1), b = g.destination(c, 270, 2);
  near(g.segmentCircleMiles(a, b, c, r), g.haversineMi(a, b), 0.01, 'inside');
  // stops short of the circle
  assert.equal(g.segmentCircleMiles(g.destination(c, 90, 20), g.destination(c, 90, 6), c, r), 0);
  // degenerate
  assert.equal(g.segmentCircleMiles(c, c, c, r), 0);
  assert.equal(g.segmentCircleMiles(a, b, c, 0), 0);
});

test('segment distance and intersection', () => {
  const c = { lat: 23.5, lon: 121, radiusMi: 5 };
  const off = g.destination(c, 0, 3);
  const p1 = alongParallel(off, 20), p2 = alongParallel(off, -20);
  near(g.segmentDistanceMi(p1, p2, c), 3, 0.005);
  assert.equal(g.segmentIntersectsCircle(p1, p2, c), true);
  assert.equal(g.segmentIntersectsCircle(p1, p2, { lat: c.lat, lon: c.lon, radiusMi: 2.9 }), false);
  // endpoint inside counts
  assert.equal(g.segmentIntersectsCircle(c, g.destination(c, 0, 50), c), true);
});

test('polylines: length, miles in circle, intersection', () => {
  const c = { lat: 23.5, lon: 121, radiusMi: 5 };
  // zig-zag that crosses the circle twice through the centre: 2 x diameter
  const line = [g.destination(c, 270, 20), g.destination(c, 90, 20), g.destination(c, 90, 30)];
  const zig = [g.destination(c, 270, 20), g.destination(c, 90, 20), c, g.destination(c, 0, 20)];
  near(g.polylineMilesInCircle(line, c), 10, 0.02, 'straight');
  near(g.polylineMilesInCircle(zig, c), 10 + 5 + 5, 0.05, 'zig-zag');
  assert.equal(g.polylineIntersectsCircle(line, c), true);
  assert.equal(g.polylineIntersectsCircle([g.destination(c, 0, 10), g.destination(c, 0, 20)], c), false);
  assert.equal(g.polylineMilesInCircle([], c), 0);
  near(g.polylineLength(line), 50, 0.05, 'length');
  assert.equal(g.polylineLength([c]), 0);
  // [lat, lon] arrays work too
  near(g.polylineMilesInCircle(line.map((p) => [p.lat, p.lon]), c), 10, 0.02, 'arrays');
});

test('interpolateAlong', () => {
  const a = { lat: 23, lon: 121 }, b = g.destination(a, 0, 10), c = g.destination(b, 90, 10);
  const pts = [a, b, c];
  const start = g.interpolateAlong(pts, 0);
  near(start.lat, a.lat, 1e-12); near(start.lon, a.lon, 1e-12); near(start.bearing, 0, 1e-6);
  const mid = g.interpolateAlong(pts, 0.5);           // the corner
  near(g.haversineMi(mid, b), 0, 0.01, 'corner');
  const q = g.interpolateAlong(pts, 0.75);
  near(g.haversineMi(q, b), 5, 0.02, 'three quarters');
  near(q.bearing, 90, 0.2, 'heading east');
  const end = g.interpolateAlong(pts, 1);
  near(end.lat, c.lat, 1e-12); near(end.lon, c.lon, 1e-12);
  const over = g.interpolateAlong(pts, 2);            // clamped
  near(over.lat, c.lat, 1e-12);
  assert.equal(g.interpolateAlong([], 0.5), null);
  const one = g.interpolateAlong([a], 0.5);
  assert.equal(one.lat, a.lat);
  const same = g.interpolateAlong([a, a], 0.5);
  assert.equal(same.lat, a.lat);
  // duplicate points do not break the heading
  near(g.interpolateAlong([a, a, b], 0.5).bearing, 0, 1e-6);
});

test('nearestGrid with filter', () => {
  const grid = [
    { id: 'G1', lat: 23.0, lon: 121.0, rallyCandidate: false },
    { id: 'G2', lat: 23.1, lon: 121.0, rallyCandidate: true },
    { id: 'G3', lat: 24.0, lon: 121.0, rallyCandidate: true }
  ];
  const p = { lat: 23.01, lon: 121.0 };
  const n1 = g.nearestGrid(p, grid);
  assert.equal(n1.id, 'G1');
  assert.equal(n1.gridId, 'G1');
  assert.equal(n1.index, 0);
  near(n1.distMi, 0.691, 0.002);
  const n2 = g.nearestGrid(p, grid, (x) => x.rallyCandidate);
  assert.equal(n2.id, 'G2');
  assert.equal(g.nearestGrid(p, grid, () => false), null);
  assert.equal(g.nearestGrid(p, []), null);
});

test('pointInPolygon: rings, holes, multipolygons, GeoJSON', () => {
  const square = [[120, 22], [122, 22], [122, 24], [120, 24], [120, 22]];   // GeoJSON [lon, lat]
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, square), true);
  assert.equal(g.pointInPolygon({ lat: 25, lon: 121 }, square), false);
  assert.equal(g.pointInPolygon({ lat: 23, lon: 119 }, square), false);
  const hole = [[120.5, 22.5], [121.5, 22.5], [121.5, 23.5], [120.5, 23.5], [120.5, 22.5]];
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, [square, hole]), false);
  assert.equal(g.pointInPolygon({ lat: 22.2, lon: 121 }, [square, hole]), true);
  const other = [[[[123, 22], [124, 22], [124, 23], [123, 22]]]];
  assert.equal(g.pointInPolygon({ lat: 22.3, lon: 123.8 }, [[square], ...other]), true);
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square] } };
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, feature), true);
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[hole]] } }] };
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, fc), true);
  assert.equal(g.pointInPolygon({ lat: 22.2, lon: 121 }, fc), false);
  // object vertices
  const objRing = square.map(([lon, lat]) => ({ lat, lon }));
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, objRing), true);
  assert.equal(g.pointInPolygon({ lat: 23, lon: 121 }, null), false);
});

test('bounding boxes', () => {
  const bb = g.bboxOf([{ lat: 23, lon: 121 }, [24, 122]]);
  assert.deepEqual({ ...bb }, { minLat: 23, maxLat: 24, minLon: 121, maxLon: 122 });
  assert.equal(g.bboxNearCircle(bb, { lat: 23.5, lon: 121.5, radiusMi: 1 }), true);
  assert.equal(g.bboxNearCircle(bb, { lat: 25.5, lon: 121.5, radiusMi: 5 }), false);
  // a circle just outside the box but reaching into it
  assert.equal(g.bboxNearCircle(bb, { lat: 24.05, lon: 121.5, radiusMi: 5 }), true);
});

test('encoded polylines round trip (Google reference example)', () => {
  const pts = g.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  near(pts[0][0], 38.5, 1e-9); near(pts[0][1], -120.2, 1e-9);
  near(pts[1][0], 40.7, 1e-9); near(pts[1][1], -120.95, 1e-9);
  near(pts[2][0], 43.252, 1e-9); near(pts[2][1], -126.453, 1e-9);
  assert.equal(g.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});
