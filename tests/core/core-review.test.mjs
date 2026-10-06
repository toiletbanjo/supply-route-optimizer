// Adversarial review tests for src/core/{format,geo,network,clock,store}.js: edge cases,
// boundary values and seeded randomized property tests. Every regression found in review has a
// test here that fails on the pre-review code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts, ROOT } from '../load.mjs';

const require = createRequire(ROOT + '/package.json');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const plainJson = (SRO, x) => JSON.parse(JSON.stringify(x, SRO.util.jsonReplacer), SRO.util.jsonReviver);

// One context with the real data files, as the app loads them (manifest order).
const FULL = [
  'src/core/ns.js', 'src/core/util.js',
  'src/data/grid.json', 'src/data/grid_links.json', 'src/data/catalog.js', 'src/data/scenario.js',
  'src/core/format.js', 'src/core/geo.js', 'src/core/network.js', 'src/core/clock.js',
  'src/core/urgency.js', 'src/core/samples.js', 'src/core/store.js'
];
const SRO = loadScripts(FULL);
const F = SRO.core.format, G = SRO.core.geo, N = SRO.core.network, C = SRO.core.clock, S = SRO.core.store;

// =============================================================================================
// format.js
// =============================================================================================

test('format: missing values never look like real data (null was 0000 / 0.0 mi / MGRS of 0N 0E)', () => {
  for (const bad of [null, undefined, NaN, '', '  ', 'abc', Infinity, -Infinity]) {
    assert.equal(F.time24(bad), 'n/a', `time24(${bad})`);
    assert.equal(F.dtg(bad), 'n/a', `dtg(${bad})`);
    assert.equal(F.dayTime(bad, 400), 'n/a', `dayTime(${bad})`);
    assert.equal(F.miles(bad), 'n/a', `miles(${bad})`);
    assert.equal(F.gallons(bad), 'n/a', `gallons(${bad})`);
    assert.equal(F.duration(bad), 'n/a', `duration(${bad})`);
    assert.equal(F.number(bad, 1), 'n/a', `number(${bad})`);
    assert.equal(F.mgrs(bad, bad), '', `mgrs(${bad})`);
    assert.equal(F.mgrs(bad, 121), '', `mgrs(${bad}, 121)`);
    assert.equal(F.latLon(bad, 121), 'n/a', `latLon(${bad})`);
    assert.equal(F.windowLabel(bad, 720), 'n/a', `windowLabel(${bad})`);
  }
  // a missing "now" just shows the day
  assert.equal(F.dayTime(1530, null), '0130 Day 2');
  assert.equal(F.dayTime(1530, undefined), '0130 Day 2');
  // numeric strings still work (form inputs)
  assert.equal(F.time24('1200'), '2000');
  assert.equal(F.miles('12.34'), '12.3 mi');
});

test('format: time24 / dayTime / dtg agree with an independent calendar on random times', () => {
  const rng = SRO.util.rng(101);
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p2 = (n) => String(n).padStart(2, '0');
  for (let k = 0; k < 3000; k++) {
    const m = Math.floor(rng() * 400 * 1440) - 10 * 1440 + (rng() < 0.3 ? rng() : 0);   // incl. fractions, before Day 1
    const whole = Math.floor(m + 1e-9);
    const d = new Date(Date.UTC(2026, 9, 6) + whole * 60000);   // Day 1 00:00 local as a UTC stand-in
    const hhmm = p2(d.getUTCHours()) + p2(d.getUTCMinutes());
    assert.equal(F.time24(m), hhmm, `time24(${m})`);
    assert.equal(F.dtg(m), p2(d.getUTCDate()) + hhmm + 'H ' + MON[d.getUTCMonth()] + ' ' + p2(d.getUTCFullYear() % 100), `dtg(${m})`);
    const day = Math.floor(whole / 1440) + 1;
    assert.equal(F.dayOf(m), day);
    assert.equal(F.dayTime(m, m), hhmm);
    assert.equal(F.dayTime(m, m + 1440), hhmm + ' Day ' + day);
  }
  // the day flips exactly at midnight
  assert.equal(F.dayTime(1439, 0), '2359');
  assert.equal(F.dayTime(1440, 0), '0000 Day 2');
  assert.equal(F.dayTime(1440, 1440.5), '0000');
});

test('format: numbers, quantities and durations at the edges', () => {
  assert.equal(F.number(999.96, 1), '1,000.0');
  assert.equal(F.number(1e6), '1,000,000');
  assert.equal(F.number(-0.04, 1), '0.0', 'no negative zero');
  assert.equal(F.number(-1000.5, 0), '-1,001');
  assert.equal(F.miles(-12.34), '-12.3 mi');
  assert.equal(F.gallons(2499.5), '2,500 gal');
  assert.equal(F.qty(0.25, 'pallet'), '0.25 pallet', 'pallet splits keep two decimals');
  assert.equal(F.qty(2.5, 'pallets'), '2.5 pallets');
  assert.equal(F.qty(3.75, 'pallets'), '3.75 pallets');
  assert.equal(F.qty(1200, 'rounds'), '1,200 rounds');
  assert.equal(F.qty(7), '7');
  assert.equal(F.duration(0.4), '0 min');
  assert.equal(F.duration(-0.4), '0 min', 'no "-0 min"');
  assert.equal(F.duration(60), '1 h');
  assert.equal(F.duration(-90), '-1 h 30 min');
  assert.equal(F.duration(24 * 60 + 1), '24 h 1 min');
});

test('format: classLabel and windowLabel edge cases', () => {
  assert.equal(F.classLabel(' viii '), 'Class VIII (Medical)');
  assert.equal(F.classLabel('class iii'), 'Class III (Fuel)');
  assert.equal(F.className('IX'), 'Repair Parts');
  assert.equal(F.className('nope'), '');
  assert.equal(F.windowLabel({ start: 0, end: 360 }), 'Day 1, 0000-0600');
  assert.equal(F.windowLabel({ start: 2 * 1440 + 1080, end: 3 * 1440 }), 'Day 3, 1800-2400');
  assert.equal(F.windowLabel(360), 'Day 1, 0600-1200', 'missing end defaults to the 6 h window');
});

test('format: MGRS equals npm mgrs at every precision on 2,000 random Taiwan points', () => {
  const mgrs = require('mgrs');
  const rng = SRO.util.rng(7070);
  const norm = (s) => s.replace(/\s+/g, '');
  for (let k = 0; k < 2000; k++) {
    const lat = 21.85 + rng() * 3.5, lon = 119.3 + rng() * 2.9;   // incl. Penghu (zone 50) and the 120E line
    const p = 1 + (k % 5);
    assert.equal(norm(F.mgrs(lat, lon, p)), mgrs.forward([lon, lat], p), `${lat},${lon} p=${p}`);
  }
  // points exactly on the zone / band lines
  for (const [lat, lon] of [[24, 120], [24, 121.5], [16, 120], [32, 120], [22.5, 120], [24, 119.99999999]]) {
    assert.equal(norm(F.mgrs(lat, lon)), mgrs.forward([lon, lat], 5), `${lat},${lon}`);
  }
});

test('format: MGRS for Phase 2 regions (incl. southern hemisphere) matches npm mgrs', () => {
  const mgrs = require('mgrs');
  const rng = SRO.util.rng(808);
  const norm = (s) => s.replace(/\s+/g, '');
  const boxes = [[-44, -10, 112, 154], [13.2, 13.7, 144.6, 145.0], [33, 38.6, 124.5, 130.5], [18.9, 22.3, -160.3, -154.8]];
  let total = 0, exact = 0;
  for (const [a, b, c, d] of boxes) {
    for (let k = 0; k < 500; k++) {
      const lat = a + rng() * (b - a), lon = c + rng() * (d - c);
      const ours = norm(F.mgrs(lat, lon)), ref = mgrs.forward([lon, lat], 5);
      total++;
      if (ours === ref) { exact++; continue; }
      // npm mgrs uses a shorter TM series; at most a 1 m disagreement at a truncation edge
      assert.equal(ours.slice(0, -10), ref.slice(0, -10), `square differs at ${lat},${lon}`);
      assert.ok(Math.abs(+ours.slice(-10, -5) - +ref.slice(-10, -5)) <= 1 && Math.abs(+ours.slice(-5) - +ref.slice(-5)) <= 1, `${ours} vs ${ref}`);
    }
  }
  assert.ok(exact / total > 0.995, `exact ${exact}/${total}`);
});

// =============================================================================================
// geo.js
// =============================================================================================

function randPoint(rng) { return { lat: 21.9 + rng() * 3.4, lon: 120.0 + rng() * 2.0 }; }

test('geo: haversine is a metric; destination / bearing invert each other', () => {
  const rng = SRO.util.rng(5);
  for (let k = 0; k < 500; k++) {
    const a = randPoint(rng), b = randPoint(rng), c = randPoint(rng);
    const ab = G.haversineMi(a, b);
    near(ab, G.haversineMi(b, a), 1e-9, 'symmetric');
    assert.ok(G.haversineMi(a, c) <= ab + G.haversineMi(b, c) + 1e-9, 'triangle inequality');
    const th = rng() * 360, d = rng() * 150;
    const p = G.destination(a, th, d);
    near(G.haversineMi(a, p), d, 1e-6, 'destination distance');
    if (d > 0.01) near(((G.bearing(a, p) - th + 540) % 360) - 180, 0, 1e-6, 'destination bearing');
  }
  // input shapes
  const t = { lat: 25.04795, lon: 121.51702 };
  assert.equal(G.haversineMi([t.lat, t.lon], { lat: 22.6273, lng: 120.3014 }), G.haversineMi(t, { lat: 22.6273, lon: 120.3014 }));
  assert.equal(G.haversineMi(t, t), 0);
});

test('geo: segmentCircleMiles properties on random segments and circles', () => {
  const rng = SRO.util.rng(77);
  let hits = 0;
  for (let k = 0; k < 3000; k++) {
    const c = randPoint(rng), r = 0.5 + rng() * 25;
    const p1 = G.destination(c, rng() * 360, rng() * 60), p2 = G.destination(c, rng() * 360, rng() * 60);
    const m = G.segmentCircleMiles(p1, p2, c, r);
    const projLen = (() => { const A = G.projectLocal(p1, c), B = G.projectLocal(p2, c); return Math.hypot(B.x - A.x, B.y - A.y); })();
    assert.ok(m >= 0 && m <= projLen + 1e-9, 'inside part within the segment');
    assert.ok(m <= 2 * r + 1e-9, 'never more than the diameter');
    near(m, G.segmentCircleMiles(p2, p1, c, r), 1e-9, 'direction does not matter');
    // splitting the segment at its lat/lon midpoint adds up (the local projection is linear)
    const mid = { lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2 };
    near(G.segmentCircleMiles(p1, mid, c, r) + G.segmentCircleMiles(mid, p2, c, r), m, 1e-9, 'additive');
    // consistent with the intersection test (tangent touches are rare in random data)
    assert.equal(m > 1e-9, G.segmentIntersectsCircle(p1, p2, { lat: c.lat, lon: c.lon, radiusMi: r }), 'intersects <=> miles > 0');
    if (m > 0) hits++;
  }
  assert.ok(hits > 500, 'enough intersecting cases: ' + hits);
});

test('geo: miles inside a circle agree with dense haversine sampling (< 1%)', () => {
  const rng = SRO.util.rng(91);
  for (let k = 0; k < 60; k++) {
    const c = randPoint(rng), r = 2 + rng() * 28;
    const p1 = G.destination(c, rng() * 360, r * (0.2 + rng() * 1.5)), p2 = G.destination(c, rng() * 360, r * (0.2 + rng() * 1.5));
    const steps = 4000;
    let inside = 0;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const a = { lat: p1.lat + (p2.lat - p1.lat) * t0, lon: p1.lon + (p2.lon - p1.lon) * t0 };
      const b = { lat: p1.lat + (p2.lat - p1.lat) * t1, lon: p1.lon + (p2.lon - p1.lon) * t1 };
      const midp = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      if (G.haversineMi(midp, c) < r) inside += G.haversineMi(a, b);
    }
    const got = G.segmentCircleMiles(p1, p2, c, r);
    near(got, inside, Math.max(0.05, inside * 0.01), `segment ${k}`);
  }
});

test('geo: interpolateAlong walks the polyline monotonically', () => {
  const rng = SRO.util.rng(3);
  for (let k = 0; k < 100; k++) {
    const pts = [randPoint(rng)];
    for (let i = 0; i < 2 + rng.int(8); i++) pts.push(rng() < 0.15 ? { ...pts[pts.length - 1] } : G.destination(pts[pts.length - 1], rng() * 360, rng() * 20));
    const total = G.polylineLength(pts);
    const s0 = G.interpolateAlong(pts, 0), s1 = G.interpolateAlong(pts, 1);
    near(s0.lat, pts[0].lat, 1e-12); near(s0.lon, pts[0].lon, 1e-12);
    near(s1.lat, pts[pts.length - 1].lat, 1e-12); near(s1.lon, pts[pts.length - 1].lon, 1e-12);
    // distance from the start along the line grows with the fraction (approximately f x total)
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const p = G.interpolateAlong(pts, f);
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.bearing >= 0 && p.bearing < 360);
      // walked distance = sum of full segments before p + partial
      let acc = 0, best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const segLen = G.haversineMi(pts[i - 1], pts[i]);
        const dd = G.segmentDistanceMi(pts[i - 1], pts[i], p);
        if (dd < 1e-3 && acc + G.haversineMi(pts[i - 1], p) >= prev - 1e-6) { best = Math.min(best, acc + G.haversineMi(pts[i - 1], p)); }
        acc += segLen;
      }
      assert.ok(best < Infinity, 'point lies on the polyline');
      near(best, f * total, Math.max(1e-6, total * 0.003), 'arc length ~ f x total');
      prev = best;
    }
  }
  assert.equal(G.interpolateAlong([], 0.5), null);
  const one = G.interpolateAlong([[24, 121]], 0.5);
  assert.deepEqual([one.lat, one.lon], [24, 121]);
  const nanf = G.interpolateAlong([[24, 121], [24.1, 121]], NaN);
  assert.deepEqual([nanf.lat, nanf.lon], [24, 121], 'NaN fraction clamps to the start');
});

test('geo: pointInPolygon agrees with the scenario Taiwan outline test on random points', () => {
  const outline = SRO.data.scenario.taiwanOutline;               // [lat, lon] ring
  const ring = outline.map(([lat, lon]) => [lon, lat]);           // GeoJSON order
  const objRing = outline.map(([lat, lon]) => ({ lat, lon }));
  const rng = SRO.util.rng(2026);
  let inside = 0;
  for (let k = 0; k < 4000; k++) {
    const p = { lat: 21.7 + rng() * 3.8, lon: 119.8 + rng() * 2.4 };
    const ref = SRO.data.scenario.insideTaiwan(p.lat, p.lon);
    assert.equal(G.pointInPolygon(p, ring), ref);
    assert.equal(G.pointInPolygon(p, objRing), ref);
    assert.equal(G.pointInPolygon(p, { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }), ref);
    if (ref) inside++;
  }
  assert.ok(inside > 500);
  // a hole punches out its area
  const square = [[120, 23], [122, 23], [122, 25], [120, 25], [120, 23]];
  const hole = [[120.5, 23.5], [121.5, 23.5], [121.5, 24.5], [120.5, 24.5], [120.5, 23.5]];
  assert.equal(G.pointInPolygon({ lat: 24, lon: 121 }, [square, hole]), false);
  assert.equal(G.pointInPolygon({ lat: 23.2, lon: 121 }, [square, hole]), true);
  assert.equal(G.pointInPolygon({ lat: 24, lon: 121 }, null), false);
  assert.equal(G.pointInPolygon({ lat: 24, lon: 121 }, []), false);
});

test('geo: polyline encode / decode round trip at precision 5 and 6', () => {
  const rng = SRO.util.rng(66);
  for (const prec of [5, 6]) {
    for (let k = 0; k < 200; k++) {
      const pts = [];
      for (let i = 0; i < 1 + rng.int(30); i++) pts.push([-80 + rng() * 160, -179 + rng() * 358]);
      const back = G.decodePolyline(G.encodePolyline(pts, prec), prec);
      assert.equal(back.length, pts.length);
      const f = Math.pow(10, prec);
      back.forEach((p, i) => { near(p[0], Math.round(pts[i][0] * f) / f, 1e-9); near(p[1], Math.round(pts[i][1] * f) / f, 1e-9); });
    }
  }
  assert.equal(G.decodePolyline('').length, 0);
});

test('geo: nearestGrid on the real grid matches brute force; filter and ties are deterministic', () => {
  const grid = SRO.data.grid;
  const rng = SRO.util.rng(12);
  for (let k = 0; k < 300; k++) {
    const p = randPoint(rng);
    const g = G.nearestGrid(p, grid);
    const best = Math.min(...grid.map((q) => G.haversineMi(p, q)));
    near(g.distMi, best, 1e-12);
    assert.equal(grid[g.index].id, g.gridId);
    const f = G.nearestGrid(p, grid, (q) => q.rallyCandidate);
    assert.ok(grid[f.index].rallyCandidate);
  }
  const twin = [{ id: 'A', lat: 24, lon: 121 }, { id: 'B', lat: 24, lon: 121 }];
  assert.equal(G.nearestGrid({ lat: 24.1, lon: 121 }, twin).gridId, 'A', 'first of equal candidates');
  assert.equal(G.nearestGrid({ lat: 24.1, lon: 121 }, twin, () => false), null);
  assert.equal(G.nearestGrid({ lat: 24.1, lon: 121 }, []), null);
});

// =============================================================================================
// network.js
// =============================================================================================

// Seeded random grid with a connected link graph (as in network.test.mjs).
function randomNetwork(seed, n, extra) {
  const rng = SRO.util.rng(seed);
  const roads = ['freeway', 'highway', 'mountain', 'local'];
  const grid = [];
  for (let i = 0; i < n; i++) grid.push({ id: 'P' + i, lat: 22.0 + rng() * 3.2, lon: 120.0 + rng() * 1.9 });
  const links = [], seen = new Set();
  const add = (a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (a === b || seen.has(k)) return;
    seen.add(k);
    links.push({ a: 'P' + a, b: 'P' + b, road: roads[rng.int(4)] });
  };
  for (let i = 1; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < i; j++) { const d = G.haversineMi(grid[i], grid[j]); if (d < bd) { bd = d; best = j; } }
    add(i, best);
  }
  for (let k = 0; k < extra; k++) {
    const a = rng.int(n);
    const order = grid.map((p, j) => [G.haversineMi(grid[a], p), j]).sort((x, y) => x[0] - y[0]);
    add(a, order[1 + rng.int(6)][1]);
  }
  return { grid, links, rng };
}

test('network: a road polyline through a closed zone blocks its arc (no straight-line fallback)', () => {
  // Pre-review, the direct link A-B was re-admitted because its STRAIGHT segment misses the
  // circle, although the pair's drawn road (which the truck follows) runs through it.
  const grid = [{ id: 'A', lat: 24.0, lon: 120.6 }, { id: 'B', lat: 24.0, lon: 120.8 }, { id: 'C', lat: 24.3, lon: 120.7 }];
  const links = [{ a: 'A', b: 'B', road: 'highway' }, { a: 'A', b: 'C', road: 'highway' }, { a: 'C', b: 'B', road: 'highway' }];
  const roadPaths = { 'A|B': [[24.0, 120.6], [23.9, 120.7], [24.0, 120.8]] };     // bows south
  const zones = [{ id: 'Z1', kind: 'closed', lat: 23.9, lon: 120.7, radiusMi: 3 }];
  const open = N.build({ grid, links, googleMatrix: null, roadPaths, zones: [], cache: false });
  const closed = N.build({ grid, links, googleMatrix: null, roadPaths, zones, cache: false });
  assert.deepEqual(Array.from(open.gridPath('A', 'B')), ['A', 'B']);
  assert.deepEqual(Array.from(closed.gridPath('A', 'B')), ['A', 'C', 'B'], 'rerouted around the closure');
  near(closed.minutes[0][1], open.minutes[0][2] + open.minutes[2][1], 1e-9);
  near(closed.minutes[1][0], closed.minutes[0][1], 1e-9, 'reverse key used reversed');
  // without a road polyline the straight link is the drawn path and it misses the circle
  const straight = N.build({ grid, links, googleMatrix: null, zones, cache: false });
  assert.deepEqual(Array.from(straight.gridPath('A', 'B')), ['A', 'B']);
});

test('network: bad endpoints give an unreachable answer instead of throwing', () => {
  const grid = [{ id: 'A', lat: 23, lon: 120 }, { id: 'B', lat: 23, lon: 120.2 }];
  const net = N.build({ grid, links: [{ a: 'A', b: 'B', road: 'freeway' }], googleMatrix: null, zones: [], cache: false });
  for (const [a, b] of [[7, 0], [-1, 0], [0.5, 1], [0, 2], ['A', 'Z'], [null, 'A'], [{}, 'A'], [{ lat: NaN, lon: 1 }, 'A']]) {
    const r = net.between(a, b);
    assert.equal(r.minutes, Infinity, `between(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.deepEqual(Array.from(r.gridPath), []);
  }
  assert.equal(net.reachable(0.5, 1), false);
  assert.equal(net.reachable(5, 1), false);
  assert.deepEqual(Array.from(net.gridPath(1.5, 0)), []);
  assert.deepEqual(Array.from(net.arcRoute(0, 9)), []);
  assert.equal(net.between(0, 'B').minutes, net.minutes[0][1]);
});

test('network: Floyd-Warshall with zero-weight arcs and near ties still yields valid shortest paths', () => {
  const rng = SRO.util.rng(11);
  for (let t = 0; t < 2000; t++) {
    const n = 2 + rng.int(9);
    const W = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0
      : rng() < 0.5 ? rng.int(3) : (rng() < 0.5 ? Infinity : rng.int(4)))));
    if (t % 3 === 0) for (const row of W) for (let j = 0; j < n; j++) if (row[j] > 0 && row[j] < Infinity) row[j] += rng() * 1e-10;
    const fw = N.floydWarshall(W);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = N.pathFromNext(fw.next, i, j);
        if (fw.dist[i][j] === Infinity) { assert.equal(p.length, 0); continue; }
        assert.equal(p[0], i); assert.equal(p[p.length - 1], j);
        assert.equal(new Set(p).size, p.length, 'no loops');
        let s = 0;
        for (let k = 1; k < p.length; k++) s += W[p[k - 1]][p[k]];
        near(s, fw.dist[i][j], 1e-6, 'path length = distance');
      }
    }
  }
});

test('network: random networks with closures and risk zones are internally consistent', () => {
  for (let trial = 0; trial < 6; trial++) {
    const { grid, links, rng } = randomNetwork(500 + trial, 30, 30);
    const zones = [];
    for (let z = 0; z < 3; z++) zones.push({ id: 'C' + z, kind: 'closed', lat: 22.2 + rng() * 2.8, lon: 120.2 + rng() * 1.5, radiusMi: 3 + rng() * 10 });
    for (let z = 0; z < 3; z++) zones.push({ id: 'R' + z, kind: 'risk', rating: ['Low', 'Medium', 'High'][z], lat: 22.2 + rng() * 2.8, lon: 120.2 + rng() * 1.5, radiusMi: 5 + rng() * 15 });
    const ratings = { Low: 1, Medium: 3, High: 6 };
    const net = N.build({ grid, links, googleMatrix: null, zones, riskRatings: ratings, cache: false });
    const idx = Object.fromEntries(grid.map((g, i) => [g.id, i]));
    const link = new Map();
    for (const l of links) {
      const c = N.linkCost(l, grid[idx[l.a]], grid[idx[l.b]]);
      for (const k of [l.a + '|' + l.b, l.b + '|' + l.a]) if (!link.has(k) || c.minutes < link.get(k).minutes) link.set(k, c);
    }
    const closed = zones.filter((z) => z.kind === 'closed'), risky = zones.filter((z) => z.kind === 'risk');
    let finite = 0, inf = 0;
    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid.length; j++) {
        if (i === j) continue;
        const path = net.gridPath(i, j);
        if (net.minutes[i][j] === Infinity) {
          inf++;
          assert.deepEqual(Array.from(path), []);
          assert.equal(net.miles[i][j], Infinity); assert.equal(net.riskUnits[i][j], Infinity);
          continue;
        }
        finite++;
        assert.equal(path[0], grid[i].id); assert.equal(path[path.length - 1], grid[j].id);
        let mins = 0, miles = 0, risk = 0;
        for (let k = 1; k < path.length; k++) {
          const c = link.get(path[k - 1] + '|' + path[k]);
          assert.ok(c, `gridPath step ${path[k - 1]}-${path[k]} is a link`);
          const A = grid[idx[path[k - 1]]], B = grid[idx[path[k]]];
          for (const z of closed) assert.ok(!G.segmentIntersectsCircle(A, B, z), `step ${path[k - 1]}-${path[k]} avoids ${z.id}`);
          mins += c.minutes; miles += c.miles;
          for (const z of risky) risk += G.segmentCircleMiles(A, B, z, z.radiusMi) * ratings[z.rating];
        }
        near(net.minutes[i][j], mins, 1e-6, `minutes ${i}-${j}`);
        near(net.miles[i][j], miles, 1e-6, `miles ${i}-${j}`);
        near(net.riskUnits[i][j], risk, 1e-6, `risk ${i}-${j}`);
        near(net.minutes[i][j], net.minutes[j][i], 1e-6, 'symmetric');
      }
    }
    assert.ok(finite > 0);
    void inf;
  }
});

test('network: a closure around a grid point cuts it off completely', () => {
  const { grid, links } = randomNetwork(77, 20, 15);
  const victim = 5;
  const zones = [{ id: 'Z', kind: 'closed', lat: grid[victim].lat, lon: grid[victim].lon, radiusMi: 0.5 }];
  const net = N.build({ grid, links, googleMatrix: null, zones, cache: false });
  for (let j = 0; j < grid.length; j++) {
    if (j === victim) continue;
    assert.equal(net.minutes[victim][j], Infinity);
    assert.equal(net.minutes[j][victim], Infinity);
    assert.equal(net.reachable(j, victim), false);
    assert.ok(!net.gridPath(0 === victim ? 1 : 0, j).includes(grid[victim].id) || j === victim);
  }
  assert.equal(net.minutes[victim][victim], 0);
  // an off-grid point inside a closed circle is blocked
  const leg = net.offGridLeg({ lat: grid[victim].lat + 0.001, lon: grid[victim].lon });
  assert.equal(leg.blocked, true);
  assert.equal(leg.minutes, Infinity);
});

test('network: time_matrix.json format (ids) and the timeMatrix option (revised DESIGN section 5)', () => {
  const grid = [{ id: 'A', lat: 23, lon: 120 }, { id: 'B', lat: 23, lon: 120.2 }, { id: 'C', lat: 23, lon: 120.4 }];
  const links = [{ a: 'A', b: 'B', road: 'freeway' }, { a: 'B', b: 'C', road: 'freeway' }];
  const tm = { source: 'osrm', fetchedAt: '2026-10-05T00:00:00Z', ids: ['C', 'B', 'A'], minutes: [[0, 9, 20], [9, 0, 11], [20, 11, 0]], meters: [[0, 15000, 30000], [15000, 0, 15000], [30000, 15000, 0]] };
  const net = N.build({ grid, links, timeMatrix: tm, zones: [], cache: false });
  assert.equal(net.source, 'matrix');
  assert.equal(net.matrixSource, 'osrm');
  assert.equal(net.minutes[0][1], 11);      // A -> B (row A = index 2 in the file)
  assert.equal(net.minutes[1][2], 9);
  near(net.miles[0][2], 30000 / 1609.344, 1e-9);
  // SRO.data.time_matrix is the default; an explicit null forces the estimate
  const ctx = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/geo.js', 'src/core/network.js']);
  ctx.data.grid = grid; ctx.data.grid_links = links; ctx.data.time_matrix = tm;
  assert.equal(ctx.core.network.build({ cache: false }).source, 'matrix');
  assert.equal(ctx.core.network.build({ timeMatrix: null, cache: false }).source, 'estimate');
  assert.equal(ctx.core.network.build({ googleMatrix: null, cache: false }).source, 'estimate');
});

test('network: cache keys on rating values, so a ratings change is not served stale', () => {
  const { grid, links } = randomNetwork(9, 15, 10);
  const zones = [{ id: 'R', kind: 'risk', rating: 'High', lat: grid[3].lat, lon: grid[3].lon, radiusMi: 20 }];
  N.clearCache();
  const a = N.build({ grid, links, googleMatrix: null, zones, riskRatings: { Low: 1, Medium: 3, High: 6 } });
  const b = N.build({ grid, links, googleMatrix: null, zones, riskRatings: { Low: 1, Medium: 3, High: 12 } });
  assert.notEqual(a, b);
  let some = false;
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid.length; j++) {
    if (a.riskUnits[i][j] > 0 && a.riskUnits[i][j] < Infinity) { some = true; near(b.riskUnits[i][j], 2 * a.riskUnits[i][j], 1e-9); }
  }
  assert.ok(some);
});

test('network: the real grid builds, is fully connected, and every grid path follows links', () => {
  const net = N.build({ googleMatrix: null, zones: [], cache: false });
  const grid = SRO.data.grid, links = SRO.data.grid_links;
  assert.equal(net.n, grid.length);
  assert.equal(net.warnings.length, 0, String(net.warnings));
  const linked = new Set(links.flatMap((l) => [l.a + '|' + l.b, l.b + '|' + l.a]));
  for (let i = 0; i < net.n; i++) {
    for (let j = 0; j < net.n; j++) {
      assert.ok(net.minutes[i][j] < Infinity, `${grid[i].id} -> ${grid[j].id} reachable`);
      const p = net.gridPath(i, j);
      for (let k = 1; k < p.length; k++) assert.ok(linked.has(p[k - 1] + '|' + p[k]));
      // road distance is never shorter than the straight line
      assert.ok(net.miles[i][j] + 1e-9 >= G.haversineMi(grid[i], grid[j]));
    }
  }
});

// =============================================================================================
// clock.js
// =============================================================================================

test('clock: a tick landing a float hair below a boundary still reports it, exactly once', () => {
  // windowOf already treats 359.99999999999994 as 0600; pre-review, neither this tick nor the
  // next one reported the 0600 boundary, so the automatic plan for that window never fired.
  assert.equal(C.windowOf(359.99999999999994).start, 360);
  assert.deepEqual(Array.from(C.boundariesBetween(359.9, 359.99999999999994)), [360]);
  assert.deepEqual(Array.from(C.boundariesBetween(359.99999999999994, 360.01)), []);
  assert.deepEqual(Array.from(C.boundariesBetween(359.99999999999994, 720.5)), [720]);
});

test('clock: random tick sequences report every boundary once, in step with windowOf', () => {
  const rng = SRO.util.rng(4242);
  for (let run = 0; run < 300; run++) {
    let sim = rng() * 3000;
    const start = sim;
    const seen = [];
    for (let k = 0; k < 200; k++) {
      let next = sim + rng() * (rng() < 0.5 ? 3 : 400);
      if (rng() < 0.2) next = Math.round(next / 360) * 360 + (rng() < 0.5 ? -1 : 1) * rng() * 1e-10;   // float noise at boundaries
      const crossed = C.boundariesBetween(sim, next);
      assert.equal(crossed.length > 0, C.windowOf(next).start !== C.windowOf(sim).start, `${sim} -> ${next}`);
      if (crossed.length) assert.equal(crossed[crossed.length - 1], C.windowOf(next).start);
      seen.push(...crossed);
      sim = next;
    }
    const expected = [];
    for (let b = C.windowOf(start).start + 360; b <= C.windowOf(sim).start; b += 360) expected.push(b);
    assert.deepEqual(seen, expected);
  }
});

test('clock: expandPeriods matches periodAt minute by minute for random period tables', () => {
  const rng = SRO.util.rng(1234);
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0');
  const tables = [C.DEFAULT_PERIODS, []];
  for (let t = 0; t < 40; t++) {
    const rows = [];
    for (let r = 0; r < 1 + rng.int(5); r++) {
      rows.push({ name: 'P' + r, start: hhmm(rng.int(48) * 30), end: hhmm(rng.int(48) * 30), speed: 0.5 + rng(), risk: rng() * 2 });
    }
    tables.push(rows);
  }
  for (const periods of tables) {
    const from = rng() < 0.5 ? rng.int(5000) : rng() * 5000, hours = 1 + rng() * 80;
    const out = C.expandPeriods(periods, from, hours);
    assert.ok(out.length >= 1);
    near(out[0].startMin, from, 1e-9);
    near(out[out.length - 1].endMin, from + hours * 60, 1e-9);
    for (let k = 0; k < out.length; k++) {
      const iv = out[k];
      assert.ok(iv.endMin > iv.startMin);
      if (k) { assert.equal(iv.startMin, out[k - 1].endMin, 'contiguous'); assert.notEqual(iv.index, out[k - 1].index, 'merged'); }
      for (let m = Math.ceil(iv.startMin); m < iv.endMin; m += 7) {
        const i = C.periodIndexAt(m, periods);
        assert.equal(i, iv.index, `minute ${m}`);
        const p = C.periodAt(m, periods);
        assert.equal(iv.speed, +p.speed || 1);
      }
    }
  }
});

test('clock: parseHHMM rejects malformed colon times', () => {
  assert.ok(Number.isNaN(C.parseHHMM('12:3')), "'12:3' is not 01:23");
  assert.ok(Number.isNaN(C.parseHHMM('1:234')));
  assert.ok(Number.isNaN(C.parseHHMM('12::30')));
  assert.equal(C.parseHHMM('7:05'), 425);
  assert.equal(C.parseHHMM('19:30'), 1170);
  assert.equal(C.parseHHMM(' 0700 '), 420);
  assert.equal(C.parseHHMM('2400'), 1440);
  assert.ok(Number.isNaN(C.parseHHMM('2401')));
  assert.ok(Number.isNaN(C.parseHHMM('1260')));
  assert.ok(Number.isNaN(C.parseHHMM(null)));
  assert.ok(Number.isNaN(C.parseHHMM(-5)));
});

test('clock: ticker does not jump after a pause and stops cleanly', () => {
  let wall = 0, cb = null;
  const st = { clock: { simMin: 360, running: true, speed: 60 } };
  const sent = [];
  const tk = C.createTicker({
    getState: () => st, dispatch: (a) => { sent.push(a); st.clock.simMin = a.simMin; },
    now: () => wall, setInterval: (f) => { cb = f; return 1; }, clearInterval: () => { cb = null; }
  });
  tk.start();
  wall += 1000; cb();
  near(st.clock.simMin, 361, 1e-9);
  st.clock.running = false;
  wall += 60000; cb();                   // paused for a real minute
  assert.equal(sent.length, 1);
  st.clock.running = true;
  wall += 1000; cb();
  near(st.clock.simMin, 362, 1e-9, 'only the running second counts');
  tk.stop();
  assert.equal(tk.isRunning(), false);
  assert.equal(cb, null);
  assert.equal(C.advance({ simMin: 5, running: true, speed: 600 }, -100), 5);
  assert.equal(C.advance({ simMin: 5, running: true, speed: '60' }, 60000), 65);
});

// =============================================================================================
// store.js
// =============================================================================================

function freshStore(extra = {}) { return S.createStore({ adapter: null, ...extra }); }
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const baseReq = (over = {}) => ({
  unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN', lat: 24.1, lon: 120.7, mobility: 'mounted',
  lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null }],
  urgencyRequested: 'Priority', nlt: 1200, remarks: '', ...over
});

test('store: the flat action shape does not leak the "now" stamp into stored objects', () => {
  const st = freshStore();
  st.dispatch({ type: 'request/submit', ...baseReq(), now: 400 });
  const r = st.getState().requests[0];
  assert.equal(r.createdAt, 400);
  assert.ok(!('now' in r), 'request has no now field');
  st.dispatch({ type: 'request/submit', payload: { ...baseReq(), now: 410 } });
  assert.ok(!('now' in st.getState().requests[1]));
  assert.equal(st.getState().requests[1].createdAt, 410);
  const hub = st.getState().scenario.hubs[0].id;
  st.dispatch({ type: 'truck/add', hubId: hub, now: 420 });
  const t = st.getState().scenario.fleet.at(-1);
  assert.ok(!('now' in t));
  assert.equal(t.availableAt, 420);
  st.dispatch({ type: 'zone/add', kind: 'closed', lat: 24, lon: 121, radiusMi: 3, now: 430 });
  assert.ok(!('now' in st.getState().scenario.zones[0]));
});

test('store: sample requests and the user request share the open window', () => {
  const st = freshStore();
  st.dispatch({ type: 'request/submit', request: baseReq() });          // at 0600
  const res = st.dispatch({ type: 'samples/load' });                    // real samples.js, back-dated stamps
  assert.equal(res.ok, true);
  assert.equal(res.ids.length, 19);
  const s = st.getState();
  assert.ok(s.requests.some((r) => r.createdAt < 360), 'samples are back-dated');
  assert.deepEqual([...new Set(s.requests.map((r) => r.windowId))], ['W-D1-0600']);
  assert.deepEqual(Array.from(s.windows, (w) => w.id), ['W-D1-0600'], 'no phantom earlier window');
  // ids unique, all submitted, all with grid points
  assert.equal(new Set(s.requests.map((r) => r.id)).size, 20);
  assert.ok(s.requests.every((r) => r.status === 'submitted' && r.gridId));
});

test('store: submit applies urgency escalation when the caller did not', () => {
  const st = freshStore();
  // 150 gal of diesel on hand at 300 gal/day = 12 h: Urgent becomes Immediate, deadline = run-out
  st.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Urgent', nlt: 2000, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] }) });
  let r = st.getState().requests[0];
  assert.equal(r.urgency, 'Immediate');
  assert.equal(r.hoursLeftComputed, 12);
  assert.equal(r.deadline, 400 + 12 * 60);
  // plenty on hand: stays Urgent with the NLT as a hard deadline
  st.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Urgent', nlt: 2000, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 900 }] }) });
  r = st.getState().requests[1];
  assert.equal(r.urgency, 'Urgent');
  assert.equal(r.deadline, 2000);
  // an urgency the form already decided is kept as given
  st.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Urgent', urgency: 'Urgent', deadline: 1500, nlt: 2000, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] }) });
  r = st.getState().requests[2];
  assert.equal(r.urgency, 'Urgent');
  assert.equal(r.deadline, 1500);
  // Routine / Priority are never escalated
  st.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Routine', nlt: 2000, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 1 }] }) });
  r = st.getState().requests[3];
  assert.equal(r.urgency, 'Routine');
  assert.equal(r.deadline, 2000);
});

test('store: editing an escalated request to another tier drops the run-out deadline', () => {
  const lines = [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }];
  // with urgency.js loaded: re-escalated
  const st = freshStore();
  st.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Urgent', nlt: 2000, lines }) });
  assert.equal(st.getState().requests[0].deadline, 1120);
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { urgencyRequested: 'Priority' }, now: 450 });
  let r = st.getState().requests[0];
  assert.equal(r.urgency, 'Priority');
  assert.equal(r.deadline, 2000, 'Priority deadline is the NLT');
  // moving the NLT of an Immediate request keeps the earlier run-out time
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { urgencyRequested: 'Urgent' }, now: 460 });
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 3000 }, now: 470 });
  r = st.getState().requests[0];
  assert.equal(r.urgency, 'Immediate');
  assert.equal(r.deadline, 1120, 'run-out from the original report');
  // re-sending the same tier does not downgrade Immediate
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { urgencyRequested: 'Urgent', remarks: 'x' }, now: 480 });
  assert.equal(st.getState().requests[0].urgency, 'Immediate');

  // without urgency.js (minimal load): the fallback still resets the deadline on a tier change
  const ctx = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/clock.js', 'src/core/store.js']);
  const st2 = ctx.core.store.createStore({ adapter: null });
  st2.dispatch({ type: 'request/submit', now: 400, request: baseReq({ urgencyRequested: 'Urgent', urgency: 'Immediate', deadline: 1120, nlt: 2000, lines }) });
  st2.dispatch({ type: 'request/edit', id: 'R-0001', changes: { urgencyRequested: 'Routine' } });
  r = st2.getState().requests[0];
  assert.equal(r.urgency, 'Routine');
  assert.equal(r.deadline, 2000);
  st2.dispatch({ type: 'request/edit', id: 'R-0001', changes: { urgencyRequested: 'Routine', remarks: 'same tier' } });
  assert.equal(st2.getState().requests[0].deadline, 2000);
});

function routePlan(id, { arrive = 450, depart = 400, returnAt = 600, createdAt = 380, windowId = 'W-D1-0600', reqId = 'R-0001', truckId = 'Alpha-2' } = {}) {
  return {
    id, windowId, createdAt, name: id, method: 'tabu',
    routes: [{ truckId, type: 'cargo', color: '#000', loadStart: 380, depart, returnAt,
      stops: [{ seq: 1, nodeKey: 'r1', kind: 'rally', gridId: 'G-TAIPEI', lat: 25, lon: 121.5, arrive, depart: arrive + 15, deliveries: [{ requestId: reqId, lineIdx: 0, qty: 1, unit: 'case', classId: 'I' }], pickups: [] }],
      legs: [] }],
    deferred: []
  };
}

test('store: plan/store with a missing createdAt uses "now", not minute 0', () => {
  const st = freshStore();
  st.dispatch({ type: 'clock/tick', simMin: 800 });
  st.dispatch({ type: 'plan/store', plan: { id: 'P-X', createdAt: null, routes: [] } });
  const p = st.getState().plans[0];
  assert.equal(p.createdAt, 800);
  assert.equal(p.windowId, 'W-D1-1200');
  assert.ok(!st.getState().windows.some((w) => w.id === 'W-D1-0000'));
});

test('store: an approved delivery with no arrival time is not marked delivered by the clock', () => {
  const st = freshStore();
  st.dispatch({ type: 'request/submit', request: baseReq() });
  st.dispatch({ type: 'plan/store', plan: routePlan('P-1', { arrive: null, depart: 500, returnAt: null }) });
  st.dispatch({ type: 'plan/approve', planId: 'P-1' });
  let s = st.getState();
  assert.equal(s.requests[0].status, 'approved');
  assert.equal(s.requests[0].eta, null);
  const truck = s.scenario.fleet.find((t) => t.id === 'Alpha-2');
  assert.equal(truck.status, 'en_route');
  assert.equal(truck.availableAt, 0, 'unknown return keeps the old availableAt');
  st.dispatch({ type: 'clock/tick', simMin: 361 });
  assert.equal(st.getState().requests[0].status, 'approved', 'not delivered before departure');
  st.dispatch({ type: 'clock/tick', simMin: 520 });
  assert.equal(st.getState().requests[0].status, 'en_route');
  st.dispatch({ type: 'clock/tick', simMin: 5000 });
  assert.equal(st.getState().requests[0].status, 'en_route', 'never delivered without an arrival time');
});

test('store: trucks with a null out-until or return time do not come back at minute 0', () => {
  const init = S.defaultState();
  init.scenario.fleet[0] = { ...init.scenario.fleet[0], status: 'out', outUntil: null };
  init.scenario.fleet[1] = { ...init.scenario.fleet[1], status: 'en_route', availableAt: null };
  const st = freshStore({ initialState: init });
  st.dispatch({ type: 'clock/tick', simMin: 400 });
  const f = st.getState().scenario.fleet;
  assert.equal(f[0].status, 'out');
  assert.equal(f[1].status, 'en_route');
});

test('store: re-approving a superseded plan leaves exactly one approved, un-superseded plan', () => {
  const st = freshStore();
  st.dispatch({ type: 'request/submit', request: baseReq() });
  st.dispatch({ type: 'plan/store', plan: routePlan('P-A', { arrive: 450 }) });
  st.dispatch({ type: 'plan/store', plan: routePlan('P-B', { arrive: 470 }) });
  st.dispatch({ type: 'plan/approve', planId: 'P-A' });
  st.dispatch({ type: 'plan/approve', planId: 'P-B' });
  let plans = st.getState().plans;
  assert.deepEqual(Array.from(plans, (p) => [p.id, p.approved, !!p.superseded]), [['P-A', false, true], ['P-B', true, false]]);
  const res = st.dispatch({ type: 'plan/approve', planId: 'P-A' });
  assert.equal(res.supersededPlanId, 'P-B');
  plans = st.getState().plans;
  const a = plans.find((p) => p.id === 'P-A'), b = plans.find((p) => p.id === 'P-B');
  assert.equal(a.approved, true);
  assert.equal(a.superseded, false, 'approved plan is not also superseded');
  assert.equal(a.supersededBy, null);
  assert.equal(b.approved, false);
  assert.equal(b.supersededBy, 'P-A');
  const w = st.getState().windows.find((x) => x.id === 'W-D1-0600');
  assert.equal(w.approvedPlanId, 'P-A');
  assert.equal(st.getState().requests[0].eta, 450);
  assert.equal(st.getState().requests[0].updated, true);
});

test('store: LocalStorageAdapter load() returns the newest state after a failed write', () => {
  const backing = new Map();
  let full = false;
  const storage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } backing.set(k, v); },
    removeItem: (k) => backing.delete(k)
  };
  const ad = S.LocalStorageAdapter({ storage });
  const st = S.createStore({ adapter: ad, saveThrottleMs: 0 });
  st.dispatch({ type: 'theme/set', theme: 'light' });
  assert.equal(ad.load().ui.theme, 'light');
  full = true;
  st.dispatch({ type: 'theme/set', theme: 'night' });
  assert.equal(ad.usingMemory, true);
  assert.equal(ad.load().ui.theme, 'night', 'memory copy wins over the stale stored one');
  full = false;
  st.dispatch({ type: 'role/set', role: 'planner' });
  assert.equal(ad.usingMemory, false);
  assert.equal(S.deserialize(backing.get('sro.v1')).ui.theme, 'night');
});

test('store: a missing localStorage global (no browser) falls back to memory', () => {
  const ad = S.LocalStorageAdapter();   // the test context has no localStorage global
  assert.equal(ad.load(), null);
  assert.equal(ad.save({ version: 1, a: Infinity }), false);
  assert.equal(ad.usingMemory, true);
  assert.equal(ad.load().a, Infinity);
});

test('store: new code paths stay pure on a deep-frozen state', () => {
  const st = freshStore();
  st.dispatch({ type: 'request/submit', request: baseReq({ urgencyRequested: 'Urgent', lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] }) });
  st.dispatch({ type: 'request/submit', request: baseReq({ urgencyRequested: 'Urgent', lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] }) });
  st.dispatch({ type: 'plan/store', plan: routePlan('P-A') });
  st.dispatch({ type: 'plan/store', plan: routePlan('P-B', { arrive: 470 }) });
  st.dispatch({ type: 'plan/approve', planId: 'P-A' });
  const frozen = deepFreeze(plainJson(SRO, st.getState()));
  const before = JSON.stringify(frozen);
  const actions = [
    { type: 'request/submit', ...baseReq({ urgencyRequested: 'Urgent', lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 10 }] }), now: 500 },
    { type: 'request/edit', id: 'R-0002', changes: { nlt: 900, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 30 }] } },
    { type: 'plan/approve', planId: 'P-B' },
    { type: 'plan/store', plan: { id: 'P-C', createdAt: null } },
    { type: 'samples/load' },
    { type: 'clock/tick', simMin: 359.99999999999994 + 720 },
    { type: 'truck/add', hubId: frozen.scenario.hubs[0].id, now: 3 }
  ];
  for (const a of actions) {
    const out = S.reduce(frozen, a);
    assert.equal(out.result.ok, true, a.type + ' ' + (out.result.error || ''));
    assert.notEqual(out.state, frozen);
  }
  assert.equal(JSON.stringify(frozen), before);
});

test('store: random action fuzz keeps the state valid, serializable and round-trippable', () => {
  const rng = SRO.util.rng(31337);
  const st = freshStore();
  const hubs = st.getState().scenario.hubs.map((h) => h.id);
  const gridIds = SRO.data.grid.map((g) => g.id);
  const pick = (a) => a[rng.int(a.length)];
  const reqIds = () => st.getState().requests.map((r) => r.id);
  const planIds = () => st.getState().plans.map((p) => p.id);
  const truckIds = () => st.getState().scenario.fleet.map((t) => t.id);
  const zoneIds = () => st.getState().scenario.zones.map((z) => z.id);
  const gens = [
    () => ({ type: 'request/submit', request: baseReq({ urgencyRequested: pick(['Routine', 'Priority', 'Urgent']), nlt: st.getState().clock.simMin + rng.int(2000), lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 100 + rng.int(900), unit: 'gal', onHand: rng() < 0.5 ? rng.int(600) : null }] }) }),
    () => ({ type: 'request/edit', id: pick(reqIds().concat(['R-9999'])), changes: { nlt: rng.int(5000), remarks: 'e' } }),
    () => ({ type: 'request/cancel', id: pick(reqIds().concat(['nope'])) }),
    () => ({ type: 'samples/load', seed: rng.int(1000), count: 1 + rng.int(5), replace: rng() < 0.5 }),
    () => ({ type: 'clock/tick', simMin: st.getState().clock.simMin + rng() * 500 }),
    () => ({ type: 'clock/speed', speed: pick([1, 60, 600, 0, -1, 'x']) }),
    () => ({ type: 'window/planNow' }),
    () => {
      const ids = reqIds();
      if (!ids.length) return { type: 'window/planNow' };
      const rid = pick(ids), sm = st.getState().clock.simMin;
      const p = routePlan(null, { reqId: rid, depart: sm + rng.int(200), arrive: sm + 100 + rng.int(400), returnAt: sm + 600, windowId: C.windowOf(sm).id, createdAt: Math.floor(sm), truckId: pick(truckIds()) });
      delete p.id;
      if (rng() < 0.3) p.deferred = [{ requestId: pick(ids), lineIdx: 0, qty: 1, unit: 'case', reason: 'capacity', note: '' }];
      return { type: 'plan/store', plan: p };
    },
    () => ({ type: 'plan/approve', planId: pick(planIds().concat(['P-none'])) }),
    () => ({ type: 'plan/rename', planId: pick(planIds().concat(['x'])), name: pick(['A', '', ' B ']) }),
    () => ({ type: 'truck/add', truck: { hubId: pick(hubs.concat(['HUB-NOPE'])), type: pick(['tanker', 'cargo', 'boat']) } }),
    () => ({ type: 'truck/markOut', truckId: pick(truckIds()), until: rng() < 0.5 ? st.getState().clock.simMin + rng.int(300) : undefined }),
    () => ({ type: 'truck/markAvailable', truckId: pick(truckIds()) }),
    () => ({ type: 'truck/remove', truckId: pick(truckIds().concat(['T-x'])) }),
    () => ({ type: 'zone/add', zone: { kind: pick(['closed', 'risk', 'weird']), rating: pick(['Low', 'High', null]), lat: 23 + rng(), lon: 120.5 + rng(), radiusMi: rng() * 10 - 1 } }),
    () => ({ type: 'zone/update', id: pick(zoneIds().concat(['Z-x'])), changes: { radiusMi: rng() * 8 } }),
    () => ({ type: 'zone/remove', id: pick(zoneIds().concat(['Z-x'])) }),
    () => ({ type: pick(['rally/pin', 'rally/ban', 'rally/clear']), gridId: pick(gridIds) }),
    () => ({ type: 'settings/update', changes: { weights: { fuel: rng.int(11) }, maxRallyPoints: 1 + rng.int(10) } }),
    () => ({ type: 'settings/resetMethodParams', method: pick(['tabu', 'sa', undefined]) }),
    () => ({ type: 'request/lock', requestId: pick(reqIds().concat(['R-x'])), truckId: pick(truckIds().concat([null])) }),
    () => ({ type: 'snapshot/save', name: 'S' }),
    () => ({ type: pick(['role/set', 'theme/set', 'tab/set']), value: pick(['psg', 'planner', 'dark', 'night', 'plan', 'bogus']) }),
    () => ({ type: 'bogus/action' })
  ];
  for (let step = 0; step < 1500; step++) {
    const before = st.getState();
    const action = pick(gens)();
    const res = st.dispatch(action);
    const s = st.getState();
    if (!res.ok) assert.equal(s, before, `failed ${action.type} must not change state`);
    // invariants
    assert.equal(s.version, 1);
    assert.equal(new Set(s.requests.map((r) => r.id)).size, s.requests.length, 'unique request ids');
    assert.equal(new Set(s.plans.map((p) => p.id)).size, s.plans.length, 'unique plan ids');
    assert.equal(new Set(s.windows.map((w) => w.id)).size, s.windows.length, 'unique window ids');
    assert.equal(new Set(s.scenario.fleet.map((t) => t.id)).size, s.scenario.fleet.length, 'unique truck ids');
    assert.ok(s.requests.every((r) => !('now' in r) && /^R-\d{4,}$/.test(r.id)));
    assert.ok(s.requests.every((r) => /^W-D\d+-\d{4}$/.test(r.windowId)), 'canonical window ids');
    const approvedPerWindow = {};
    for (const p of s.plans) if (p.approved) { approvedPerWindow[p.windowId] = (approvedPerWindow[p.windowId] || 0) + 1; assert.ok(!p.superseded, 'approved plans are not superseded'); }
    assert.ok(Object.values(approvedPerWindow).every((c) => c === 1), 'one approved plan per window');
    for (const z of s.scenario.zones) assert.ok(z.radiusMi > 0 && ['closed', 'risk'].includes(z.kind));
    const pin = new Set(s.scenario.rally.pinned);
    assert.ok(s.scenario.rally.banned.every((g) => !pin.has(g)), 'pin and ban exclude each other');
  }
  // export -> import gives the same state (clock is paused on import)
  const exported = st.exportJson();
  const st2 = freshStore();
  assert.equal(st2.importJson(exported).ok, true);
  const a = plainJson(SRO, st.getState()), b = plainJson(SRO, st2.getState());
  a.clock.running = false;
  assert.deepEqual(b, a);
});
