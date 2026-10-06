import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const FILES = ['src/core/ns.js', 'src/core/util.js', 'src/data/grid.json', 'src/data/roads_graph.json',
  'src/core/geo.js', 'src/core/road_router.js', 'src/core/roads.js'];
const SRO = loadScripts(FILES);
const R = SRO.core.roads;
const grid = SRO.data.grid;
const gp = (id) => grid.find((g) => g.id === id);

const TAIPEI = [25.0478, 121.5170];
const KAOHSIUNG = [22.6273, 120.3014];
const HSINCHU_CLOSED = { id: 'Z-1', kind: 'closed', lat: 24.80, lon: 120.97, radiusMi: 15000 / 1609.344 };
const PENGHU = [23.5700, 119.5800];

function hav(a, b) { return R.haversineM(a, b); }
function minDistToCenter(coords, c) {
  let m = Infinity;
  for (const p of coords) m = Math.min(m, hav(p, [c.lat, c.lon]));
  return m;
}

test('graph loads once and exposes the network lines', () => {
  const G = R.graph();
  assert.ok(G && G.nodeCount > 7000 && G.edgeCount > 11000);
  assert.equal(R.graph(), G, 'lazy load is memoized');
  const lines = R.networkLines();
  const total = Object.values(lines).reduce((s, arr) => s + arr.length, 0);
  assert.equal(total, G.edgeCount);
  assert.ok(lines.motorway.length > 1000 && lines.trunk.length > 1000 && lines.primary.length > 5000);
});

test('Taipei -> Kaohsiung is about 355 km, mostly freeway', () => {
  const r = R.route(TAIPEI, KAOHSIUNG);
  assert.equal(r.source, 'osm-roads');
  assert.equal(r.offRoad, false);
  assert.equal(r.reachable, true);
  assert.ok(r.meters > 340000 && r.meters < 375000, 'km ' + r.meters / 1000);
  const kmh = r.meters / 1000 / (r.seconds / 3600);
  assert.ok(kmh > 78, 'average speed implies freeway, got ' + kmh.toFixed(1) + ' km/h');
  assert.ok(Math.abs(r.miles - r.meters / 1609.344) < 1e-9 && Math.abs(r.minutes - r.seconds / 60) < 1e-9);
  assert.ok(r.coords.length > 200, 'follows road geometry');
  assert.deepEqual([...r.coords[0]], TAIPEI, 'starts at the real point (connector)');
  assert.deepEqual([...r.coords[r.coords.length - 1]], KAOHSIUNG);
  assert.ok(r.snapMeters[0] < 500 && r.snapMeters[1] < 1500);
  // no long straight jumps: every step is a road vertex step (15 m simplification keeps < 25 km)
  for (let i = 1; i < r.coords.length; i++) assert.ok(hav(r.coords[i - 1], r.coords[i]) < 25000);
});

test('a closed zone forces a longer detour that stays out of the circle', () => {
  const plain = R.route(TAIPEI, KAOHSIUNG);
  const detour = R.route(TAIPEI, KAOHSIUNG, { closed: [HSINCHU_CLOSED] });
  assert.equal(detour.source, 'osm-roads');
  assert.ok(detour.meters > plain.meters + 80000, 'detour ' + detour.meters / 1000 + ' km');
  assert.ok(minDistToCenter(detour.coords, HSINCHU_CLOSED) > 15000, 'never enters the closed circle');
  // same answer as the router's own blocked-circle routing (within snapping/connector differences)
  const ref = R.graph().route(TAIPEI, KAOHSIUNG, { blocked: [{ lat: 24.80, lon: 120.97, radiusM: 15000 }] });
  assert.ok(Math.abs(detour.roadMeters - ref.meters) / ref.meters < 0.03, `ours ${detour.roadMeters} router ${ref.meters}`);
  // risk zones never change the path
  const risk = R.route(TAIPEI, KAOHSIUNG, { closed: [Object.assign({}, HSINCHU_CLOSED, { kind: 'risk' })] });
  assert.equal(risk, plain);
});

test('results are cached by endpoints and closed-zone set', () => {
  R.clearCache();
  const a = gp('G-GRANITE'), b = gp('G-LOTUS');
  const r1 = R.route(a, b);
  const s1 = R.cacheStats();
  const r2 = R.route({ lat: a.lat + 1e-7, lng: a.lon }, [b.lat, b.lon]);
  const s2 = R.cacheStats();
  assert.equal(r2, r1, 'same object for the same rounded endpoints');
  assert.equal(s2.hits, s1.hits + 1);
  const r3 = R.route(a, b, { closed: [HSINCHU_CLOSED] });
  assert.equal(R.cacheStats().misses, s2.misses + 1, 'different closures miss');
  assert.notEqual(r3, r1);
  // zone order and ids do not matter, only geometry
  const z2 = { id: 'other', kind: 'closed', lat: 23.0, lon: 120.3, radiusMi: 2 };
  const k1 = R.closedKey([HSINCHU_CLOSED, z2]), k2 = R.closedKey([z2, Object.assign({}, HSINCHU_CLOSED, { id: 'x' })]);
  assert.equal(k1, k2);
});

test('straight fallback for a point far from the road graph', () => {
  const r = R.route(PENGHU, TAIPEI);
  assert.equal(r.source, 'straight');
  assert.equal(r.reason, 'far-from-road');
  assert.equal(r.offRoad, true);
  assert.equal(r.reachable, true);
  assert.equal(r.coords.length, 2);
  assert.ok(r.snapMeters[0] > 5000);
  assert.ok(Math.abs(r.meters - hav(PENGHU, TAIPEI) * 1.3) < 1);
  assert.ok(Math.abs(r.seconds - r.meters / (25 * 1609.344 / 3600)) < 1e-6, '25 mph');
  const p = R.path(PENGHU, TAIPEI, []);
  assert.equal(p.approximate, true);
  assert.equal(p.source, 'straight');
});

test('no road route when a closed zone swallows the destination', () => {
  const closedTaipei = { id: 'Z-T', kind: 'closed', lat: TAIPEI[0], lon: TAIPEI[1], radiusMi: 3 };
  const r = R.route(KAOHSIUNG, TAIPEI, { closed: [closedTaipei] });
  assert.equal(r.source, 'straight');
  assert.equal(r.reason, 'no-route');
  assert.equal(r.reachable, false);
  assert.equal(r.crossesClosed, true);
});

test('route between two points on the same road edge runs along it', () => {
  const G = R.graph();
  let e = 0;
  for (; e < G.edgeCount; e++) if (G.edgeLen[e] > 20000 && G.geom[e].length > 20) break;
  const g = G.geom[e];
  const a = g[3], b = g[g.length - 4];
  const r = R.route(a, b);
  assert.equal(r.source, 'osm-roads');
  assert.ok(r.snapMeters[0] < 1 && r.snapMeters[1] < 1);
  assert.ok(r.meters <= G.edgeLen[e] + 1, 'no detour beyond the edge itself');
});

test('matrix: diagonal zero, symmetric-ish, consistent with route()', () => {
  const pts = grid;
  const t0 = Date.now();
  const M = R.matrix(pts);
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, 'all pairs in ' + ms + ' ms');
  const n = pts.length;
  assert.equal(M.minutes.length, n);
  const asym = [];
  for (let i = 0; i < n; i++) {
    assert.equal(M.minutes[i][i], 0);
    assert.equal(M.miles[i][i], 0);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (M.sources[i][j] === 'osm-roads') {
        assert.ok(M.minutes[i][j] > 0 && M.minutes[i][j] < Infinity);
        if (j > i && M.sources[j][i] === 'osm-roads') asym.push(Math.abs(M.minutes[i][j] - M.minutes[j][i]) / Math.max(M.minutes[i][j], M.minutes[j][i]));
      }
    }
  }
  asym.sort((a, b) => a - b);
  const median = asym[Math.floor(asym.length / 2)];
  const p90 = asym[Math.floor(asym.length * 0.9)];
  assert.ok(median < 0.06, 'median asymmetry ' + median);
  assert.ok(p90 < 0.25, 'p90 asymmetry ' + p90);

  // spot-check pairs against route()
  const ids = ['G-GRANITE', 'G-JADE', 'G-ANVIL', 'G-LOTUS', 'G-TAITUNG', 'G-HENGCHUN'];
  for (const x of ids) for (const y of ids) {
    if (x === y) continue;
    const i = pts.indexOf(gp(x)), j = pts.indexOf(gp(y));
    const r = R.route(pts[i], pts[j]);
    if (r.reachable) {
      assert.ok(Math.abs(M.minutes[i][j] - r.minutes) < 1e-6, `${x}->${y} ${M.minutes[i][j]} vs ${r.minutes}`);
      assert.ok(Math.abs(M.miles[i][j] - r.miles) < 1e-6);
    }
    assert.equal(M.sources[i][j], r.source);
    assert.deepEqual(M.paths(i, j), r.coords);
  }
  // FOB Granite -> Base Lotus crosses the island on real roads (not a straight line)
  const gi = pts.indexOf(gp('G-GRANITE')), li = pts.indexOf(gp('G-LOTUS'));
  assert.ok(M.paths(gi, li).length > 100);
  assert.ok(M.miles[gi][li] > R.haversineM(gp('G-GRANITE'), gp('G-LOTUS')) / 1609.344 * 1.2);
});

test('matrix with closures: rerouted pairs and unreachable pairs are Infinity', () => {
  const anvil = gp('G-ANVIL');
  const pts = [gp('G-GRANITE'), gp('G-JADE'), anvil, gp('G-LOTUS'), { lat: PENGHU[0], lon: PENGHU[1] }];
  const closedAnvil = { id: 'Z-A', kind: 'closed', lat: anvil.lat, lon: anvil.lon, radiusMi: 2 };
  // a closed circle out in the strait, on the straight line FOB Granite -> Penghu (touches no road)
  const g0 = pts[0], f = 0.3;
  const strait = { id: 'Z-S', kind: 'closed', lat: PENGHU[0] + f * (g0.lat - PENGHU[0]), lon: PENGHU[1] + f * (g0.lon - PENGHU[1]), radiusMi: 3 };
  const M0 = R.matrix(pts);
  const M = R.matrix(pts, { closed: [closedAnvil, HSINCHU_CLOSED, strait] });
  for (let k = 0; k < pts.length; k++) {
    if (k === 2) continue;
    assert.equal(M.minutes[k][2], Infinity, 'into the closed hub');
    assert.equal(M.reachable[2][k], false);
  }
  assert.ok(M.minutes[0][1] > M0.minutes[0][1] + 30, 'Granite -> Jade detours around Hsinchu');
  assert.equal(M.sources[1][4], 'straight', 'offshore point keeps the straight estimate');
  assert.ok(M.minutes[1][4] < Infinity);
  assert.equal(M.minutes[0][4], Infinity, 'a straight line across a closed zone is unreachable');
  const r = R.route(pts[0], pts[1], { closed: [strait, HSINCHU_CLOSED, closedAnvil] });
  assert.ok(Math.abs(r.minutes - M.minutes[0][1]) < 1e-6);
});

test('tour returns one leg per consecutive pair', () => {
  const legs = R.tour([gp('G-JADE'), gp('G-TAICHUNG'), gp('G-PULI'), gp('G-JADE')]);
  assert.equal(legs.length, 3);
  legs.forEach((l) => assert.equal(l.source, 'osm-roads'));
  const last = legs[2].coords[legs[2].coords.length - 1];
  assert.ok(R.haversineM(last, gp('G-JADE')) < 1);
});

test('without the road graph everything falls back to straight lines', () => {
  const S2 = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/geo.js', 'src/core/road_router.js', 'src/core/roads.js']);
  const R2 = S2.core.roads;
  assert.equal(R2.available(), false);
  const r = R2.route(TAIPEI, KAOHSIUNG);
  assert.equal(r.source, 'straight');
  assert.equal(r.reason, 'no-graph');
  const M = R2.matrix([TAIPEI, KAOHSIUNG]);
  assert.equal(M.source, 'straight');
  assert.ok(M.minutes[0][1] > 0 && M.minutes[0][1] < Infinity);
});

test('a connector that crosses a closed zone blocks the route, even along one edge (review fix)', () => {
  const G = R.graph();
  let checked = 0;
  for (let e = 0; e < G.edgeCount && checked < 3; e++) {
    const g = G.geom[e];
    if (G.edgeLen[e] < 15000 || g.length < 10) continue;
    const k = Math.floor(g.length / 2), A = g[k - 1], B = g[k];
    const cos = Math.cos(A[0] * Math.PI / 180);
    const dy = B[0] - A[0], dx = (B[1] - A[1]) * cos, L = Math.hypot(dx, dy);
    if (L < 1e-4) continue;
    const off = 600 / 110540, mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const a = [mid[0] + dx / L * off, mid[1] - dy / L * off / cos];     // 600 m off the middle of the edge
    const b = g[Math.min(g.length - 2, k + 3)];                          // a vertex of the same edge
    const s = R.snap(a);
    if (Math.abs(s.meters - 600) > 30) continue;
    const free = R.route(a, b);
    if (free.source !== 'osm-roads' || free.roadMeters > R.haversineM(s, b) * 1.5 + 50) continue;   // the along-edge run
    // a small closed circle on the connector only (it touches no road)
    const zone = { kind: 'closed', lat: (a[0] + s.lat) / 2, lon: (a[1] + s.lon) / 2, radiusMi: 150 / 1609.344 };
    const r = R.route(a, b, { closed: [zone] });
    assert.equal(r.reachable, false, 'edge ' + e + ': the only way out of the point crosses the closed zone');
    assert.equal(r.reason, 'no-route');
    const M = R.matrix([a, b], { closed: [zone] });
    assert.equal(M.minutes[0][1], Infinity);
    checked++;
  }
  assert.ok(checked >= 1, 'found a test edge');
});
