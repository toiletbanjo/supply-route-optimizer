import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const SRO = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/geo.js', 'src/core/network.js']);
const N = SRO.core.network;
const geo = SRO.core.geo;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

// ---- helpers --------------------------------------------------------------------------------
function linkMinutes(A, B, road) { const r = N.ROAD[road]; return geo.haversineMi(A, B) * r.factor / r.mph * 60; }
function linkMiles(A, B, road) { return geo.haversineMi(A, B) * N.ROAD[road].factor; }

// Plain O(n^2) Dijkstra over an adjacency matrix (Infinity = no edge).
function dijkstra(W, s) {
  const n = W.length, dist = new Array(n).fill(Infinity), done = new Array(n).fill(false);
  dist[s] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    for (let v = 0; v < n; v++) if (W[u][v] < Infinity && dist[u] + W[u][v] < dist[v]) dist[v] = dist[u] + W[u][v];
  }
  return dist;
}

// Seeded random grid of n points over Taiwan with a connected spanning tree plus extra links.
function randomNetwork(seed, n, extra) {
  const rng = SRO.util.rng(seed);
  const roads = ['freeway', 'highway', 'mountain', 'local'];
  const grid = [];
  for (let i = 0; i < n; i++) grid.push({ id: 'P' + i, lat: 22.0 + rng() * 3.2, lon: 120.0 + rng() * 1.9 });
  const links = [];
  const seen = new Set();
  const add = (a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (a === b || seen.has(k)) return;
    seen.add(k);
    links.push({ a: 'P' + a, b: 'P' + b, road: roads[rng.int(4)] });
  };
  for (let i = 1; i < n; i++) {             // connect each point to a near earlier point
    let best = 0, bd = Infinity;
    for (let j = 0; j < i; j++) { const d = geo.haversineMi(grid[i], grid[j]); if (d < bd) { bd = d; best = j; } }
    add(i, best);
  }
  for (let k = 0; k < extra; k++) {
    const a = rng.int(n);
    // pick among the 6 nearest to keep links road-like
    const order = grid.map((p, j) => [geo.haversineMi(grid[a], p), j]).sort((x, y) => x[0] - y[0]);
    add(a, order[1 + rng.int(6)][1]);
  }
  return { grid, links };
}

function linkMatrix(grid, links, blocked) {
  const idx = Object.fromEntries(grid.map((g, i) => [g.id, i]));
  const n = grid.length;
  const W = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  for (const l of links) {
    const a = idx[l.a], b = idx[l.b];
    if (blocked && blocked(grid[a], grid[b])) continue;
    const m = linkMinutes(grid[a], grid[b], l.road);
    if (m < W[a][b]) W[a][b] = W[b][a] = m;
  }
  return W;
}

// Small hand-checkable network: A - B - C straight (freeway), detour A - D - C (highway).
const A = { id: 'A', lat: 23.0, lon: 120.0 };
const B = { id: 'B', lat: 23.0, lon: 120.2 };
const C = { id: 'C', lat: 23.0, lon: 120.4 };
const D = { id: 'D', lat: 23.2, lon: 120.2 };
const GRID = [A, B, C, D];
const LINKS = [
  { a: 'A', b: 'B', road: 'freeway' }, { a: 'B', b: 'C', road: 'freeway' },
  { a: 'A', b: 'D', road: 'highway' }, { a: 'D', b: 'C', road: 'highway' }
];

// ---- tests ----------------------------------------------------------------------------------
test('fallback estimate: road factors and speeds from DESIGN.md', () => {
  const net = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false });
  assert.equal(net.source, 'estimate');
  assert.deepEqual(Array.from(net.ids), ['A', 'B', 'C', 'D']);
  assert.equal(net.index.C, 2);
  const ab = linkMinutes(A, B, 'freeway');
  near(net.minutes[0][1], ab, 1e-9, 'A-B');
  near(net.minutes[0][1], geo.haversineMi(A, B) * 1.15 / 55 * 60, 1e-9, 'freeway 1.15 at 55 mph');
  near(net.minutes[0][2], 2 * ab, 1e-9, 'A-C via B');
  near(net.miles[0][2], linkMiles(A, B, 'freeway') + linkMiles(B, C, 'freeway'), 1e-9, 'miles A-C');
  near(net.minutes[0][3], geo.haversineMi(A, D) * 1.3 / 40 * 60, 1e-9, 'highway 1.3 at 40 mph');
  near(net.minutes[1][3], Math.min(ab + net.minutes[0][3], net.minutes[1][2] + net.minutes[2][3]), 1e-9, 'B-D');
  assert.deepEqual(Array.from(net.gridPath(0, 2)), ['A', 'B', 'C']);
  assert.deepEqual(Array.from(net.gridPath('C', 'A')), ['C', 'B', 'A']);
  assert.deepEqual(Array.from(net.gridPath('B', 'B')), ['B']);
  for (let i = 0; i < 4; i++) {
    assert.equal(net.minutes[i][i], 0);
    for (let j = 0; j < 4; j++) {
      near(net.minutes[i][j], net.minutes[j][i], 1e-9, 'symmetric');
      assert.equal(net.riskUnits[i][j], 0);
    }
  }
  // the mountain and local road types
  const m = N.linkCost({ a: 'A', b: 'B', road: 'mountain' }, A, B);
  near(m.minutes, geo.haversineMi(A, B) * 1.8 / 22 * 60, 1e-9);
  const l = N.linkCost({ a: 'A', b: 'B', road: 'dirt' }, A, B);   // unknown -> local
  near(l.minutes, geo.haversineMi(A, B) * 1.4 / 30 * 60, 1e-9);
});

test('closed zone: arcs through it are removed and pairs reroute', () => {
  const zones = [{ id: 'Z1', kind: 'closed', lat: B.lat, lon: B.lon, radiusMi: 3 }];
  const net = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones, cache: false });
  const ad = linkMinutes(A, D, 'highway'), dc = linkMinutes(D, C, 'highway');
  near(net.minutes[0][2], ad + dc, 1e-9, 'A-C via D');
  near(net.miles[0][2], linkMiles(A, D, 'highway') + linkMiles(D, C, 'highway'), 1e-9, 'miles via D');
  assert.deepEqual(Array.from(net.gridPath('A', 'C')), ['A', 'D', 'C']);
  // B sits inside the closed circle: unreachable both ways
  for (const x of [0, 2, 3]) {
    assert.equal(net.minutes[x][1], Infinity);
    assert.equal(net.minutes[1][x], Infinity);
    assert.equal(net.miles[x][1], Infinity);
    assert.equal(net.riskUnits[x][1], Infinity);
  }
  assert.deepEqual(Array.from(net.gridPath('A', 'B')), []);
  assert.equal(net.reachable('A', 'B'), false);
  assert.equal(net.reachable('A', 'C'), true);
  assert.equal(net.minutes[1][1], 0);
  assert.ok(net.blockedArcs > 0);
  assert.deepEqual(Array.from(net.closedZoneIds), ['Z1']);
  // a closed zone away from every road changes nothing
  const far = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [{ id: 'Z9', kind: 'closed', lat: 24.5, lon: 121.5, radiusMi: 5 }], cache: false });
  const base = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false });
  assert.deepEqual(far.minutes, base.minutes);
  assert.equal(far.blockedArcs, 0);
});

test('closed zone: a direct link survives when the faster detour runs through the closure', () => {
  // A-D direct is a slow mountain road; A-B-D on freeways is faster. Closing B must fall back to A-D.
  const g = [A, B, D];
  const links = [{ a: 'A', b: 'B', road: 'freeway' }, { a: 'B', b: 'D', road: 'freeway' }, { a: 'A', b: 'D', road: 'mountain' }];
  const open = N.build({ grid: g, links, googleMatrix: null, zones: [], cache: false });
  assert.deepEqual(Array.from(open.gridPath('A', 'D')), ['A', 'B', 'D']);
  const closed = N.build({ grid: g, links, googleMatrix: null, zones: [{ id: 'Z', kind: 'closed', lat: B.lat, lon: B.lon, radiusMi: 2 }], cache: false });
  near(closed.minutes[0][2], linkMinutes(A, D, 'mountain'), 1e-9, 'direct mountain link');
  assert.deepEqual(Array.from(closed.gridPath('A', 'D')), ['A', 'D']);
});

test('risk units = miles inside the circle x rating, summed over zones', () => {
  const mid = { lat: 23.0, lon: 120.1 };          // middle of the A-B freeway link
  const zones = [
    { id: 'R1', kind: 'risk', rating: 'High', lat: mid.lat, lon: mid.lon, radiusMi: 2 },
    { id: 'R2', kind: 'risk', rating: 'Low', lat: D.lat, lon: D.lon, radiusMi: 1 },
    { id: 'R3', kind: 'risk', rating: 'Bogus', lat: C.lat, lon: C.lon, radiusMi: 1 }   // unknown rating: ignored
  ];
  const ratings = { Low: 1, Medium: 3, High: 6 };
  const net = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones, riskRatings: ratings, cache: false });
  near(net.riskUnits[0][1], 2 * 2 * 6, 0.05, 'A-B: 4 mi inside a High zone');
  near(net.riskUnits[1][0], 24, 0.05, 'B-A');
  near(net.riskUnits[0][2], 24, 0.05, 'A-C passes the same zone');
  near(net.riskUnits[1][2], 0, 1e-12, 'B-C clear');
  // A-D ends at D, the centre of a 1-mile Low zone: 1 mi inside x 1
  near(net.riskUnits[0][3], 1, 0.01, 'A-D');
  // risk does not change times
  const base = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false });
  assert.deepEqual(net.minutes, base.minutes);
  // rating values come from riskRatings
  const net2 = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones, riskRatings: { Low: 1, Medium: 3, High: 10 }, cache: false });
  near(net2.riskUnits[0][1], 40, 0.1);
});

test('google matrix: mapped by gridIds, meters to miles, null falls back to the estimate', () => {
  // matrix rows in a different order than the grid, and one missing pair
  const order = ['C', 'A', 'D', 'B'];
  const mins = { 'A|B': 20, 'A|C': 41, 'A|D': 37, 'B|C': 19, 'B|D': 30, 'C|D': 36 };
  const meters = { 'A|B': 24000, 'A|C': 47000, 'A|D': 40000, 'B|C': 23000, 'B|D': 36000, 'C|D': 39000 };
  const val = (tbl, a, b) => (a === b ? 0 : tbl[a < b ? a + '|' + b : b + '|' + a]);
  const gm = {
    source: 'google', fetchedAt: '2026-10-05T12:00:00Z', gridIds: order,
    minutes: order.map((a) => order.map((b) => val(mins, a, b))),
    meters: order.map((a) => order.map((b) => val(meters, a, b)))
  };
  gm.minutes[2][0] = null;                        // D -> C missing
  const net = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones: [], cache: false });
  // DESIGN.md section 5 (revised): an external matrix reports source 'matrix'; its producer is matrixSource
  assert.equal(net.source, 'matrix');
  assert.equal(net.matrixSource, 'google');
  assert.equal(net.fetchedAt, '2026-10-05T12:00:00Z');
  assert.equal(net.minutes[0][1], 20);
  assert.equal(net.minutes[1][2], 19);
  near(net.miles[0][1], 24000 / 1609.344, 1e-9, 'meters -> miles');
  assert.equal(net.estimatedPairs, 1);
  // D->C falls back to the estimate (36.6 min) unless a google composition is faster
  const est = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false });
  near(net.minutes[3][2], Math.min(est.minutes[3][2], mins['A|D'] + mins['A|C'], mins['B|D'] + mins['B|C']), 1e-9, 'D->C');
  // A->C: google 41 > A->B->C 39, so the all-pairs pass composes through B
  assert.equal(net.minutes[0][2], 39);
  assert.deepEqual(Array.from(net.gridPath('A', 'C')), ['A', 'B', 'C']);
  // gridPath is still the link-graph path
  assert.deepEqual(Array.from(net.gridPath('A', 'D')), ['A', 'D']);
  // a malformed matrix is ignored
  const bad = N.build({ grid: GRID, links: LINKS, googleMatrix: { gridIds: ['A'] }, zones: [], cache: false });
  assert.equal(bad.source, 'estimate');
  assert.ok(bad.warnings.length > 0);
});

test('google matrix + closed zone: road paths decide which arcs are blocked', () => {
  const order = ['A', 'B', 'C', 'D'];
  const M = [[0, 20, 38, 37], [20, 0, 19, 30], [38, 19, 0, 36], [37, 30, 36, 0]];
  const gm = { source: 'google', fetchedAt: 'x', gridIds: order, minutes: M, meters: M.map((r) => r.map((m) => m * 1200)) };
  const zones = [{ id: 'Z1', kind: 'closed', lat: B.lat, lon: B.lon, radiusMi: 3 }];
  // Without road paths, A->C is drawn along its link path A-B-C and is blocked.
  const n1 = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones, cache: false });
  assert.equal(n1.minutes[0][2], 37 + 36);
  assert.deepEqual(Array.from(n1.gridPath('A', 'C')), ['A', 'D', 'C']);
  // With a road path for A|C that loops north of B, the Google arc survives.
  const roadPaths = { 'A|C': [[23.0, 120.0], [23.12, 120.2], [23.0, 120.4]] };
  const n2 = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones, roadPaths, cache: false });
  assert.equal(n2.minutes[0][2], 38);
  assert.equal(n2.minutes[2][0], 38, 'reverse key used reversed');
  // encoded polylines and { coords } values work; 'straight' placeholders are ignored
  const enc = geo.encodePolyline(roadPaths['A|C']);
  const n3 = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones, roadPaths: { 'A|C': { coords: enc } }, cache: false });
  assert.equal(n3.minutes[0][2], 38);
  const n4 = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones, roadPaths: { 'A|C': { coords: roadPaths['A|C'], source: 'straight' } }, cache: false });
  assert.equal(n4.minutes[0][2], 73);
  // function form
  const n5 = N.build({ grid: GRID, links: LINKS, googleMatrix: gm, zones, roadPaths: (a, b) => (a === 'A' && b === 'C' ? roadPaths['A|C'] : null), cache: false });
  assert.equal(n5.minutes[0][2], 38);
});

test('Floyd-Warshall equals Dijkstra on random matrices and paths add up', () => {
  const rng = SRO.util.rng(42);
  for (let trial = 0; trial < 5; trial++) {
    const n = 30;
    const W = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : rng() < 0.15 ? 1 + rng() * 99 : Infinity)));
    const fw = N.floydWarshall(W);
    for (let s = 0; s < n; s++) {
      const d = dijkstra(W, s);
      for (let t = 0; t < n; t++) {
        if (d[t] === Infinity) { assert.equal(fw.dist[s][t], Infinity); assert.deepEqual(Array.from(N.pathFromNext(fw.next, s, t)), []); continue; }
        near(fw.dist[s][t], d[t], 1e-6, `dist ${s}->${t}`);
        const p = N.pathFromNext(fw.next, s, t);
        assert.equal(p[0], s); assert.equal(p[p.length - 1], t);
        let sum = 0;
        for (let k = 1; k < p.length; k++) { assert.ok(W[p[k - 1]][p[k]] < Infinity, 'path uses arcs'); sum += W[p[k - 1]][p[k]]; }
        near(sum, fw.dist[s][t], 1e-6, 'path length');
      }
    }
  }
  // null and NaN entries are "no arc"
  const fw = N.floydWarshall([[0, null], [NaN, 0]]);
  assert.equal(fw.dist[0][1], Infinity);
});

test('random 45-point network: build matches Dijkstra; grid paths follow links', () => {
  const { grid, links } = randomNetwork(7, 45, 40);
  const net = N.build({ grid, links, googleMatrix: null, zones: [], cache: false });
  const W = linkMatrix(grid, links);
  const linked = new Set(links.flatMap((l) => [l.a + '|' + l.b, l.b + '|' + l.a]));
  const road = Object.fromEntries(links.flatMap((l) => [[l.a + '|' + l.b, l.road], [l.b + '|' + l.a, l.road]]));
  const idx = net.index;
  for (let s = 0; s < grid.length; s++) {
    const d = dijkstra(W, s);
    for (let t = 0; t < grid.length; t++) {
      near(net.minutes[s][t], d[t], 1e-6, `minutes ${s}->${t}`);
      if (s === t) continue;
      const p = net.gridPath(s, t);
      let mins = 0, miles = 0;
      for (let k = 1; k < p.length; k++) {
        const key = p[k - 1] + '|' + p[k];
        assert.ok(linked.has(key), 'consecutive grid points are linked: ' + key);
        mins += linkMinutes(grid[idx[p[k - 1]]], grid[idx[p[k]]], road[key]);
        miles += linkMiles(grid[idx[p[k - 1]]], grid[idx[p[k]]], road[key]);
      }
      near(mins, net.minutes[s][t], 1e-6, 'path minutes');
      near(miles, net.miles[s][t], 1e-6, 'path miles');
    }
  }
});

test('random network with closures: rerouted times equal Dijkstra on the link graph minus blocked links', () => {
  const { grid, links } = randomNetwork(11, 45, 45);
  const open = N.build({ grid, links, googleMatrix: null, zones: [], cache: false });
  const rng = SRO.util.rng(5);
  let rerouted = 0;
  for (let trial = 0; trial < 4; trial++) {
    const zones = [];
    for (let k = 0; k < 3; k++) {
      const p = grid[rng.int(grid.length)];
      const q = geo.destination(p, rng() * 360, 2 + rng() * 6);
      zones.push({ id: 'Z' + k, kind: 'closed', lat: q.lat, lon: q.lon, radiusMi: 2 + rng() * 6 });
    }
    const net = N.build({ grid, links, googleMatrix: null, zones, cache: false });
    const blocked = (a, b) => zones.some((z) => geo.segmentIntersectsCircle(a, b, z));
    const W = linkMatrix(grid, links, blocked);
    let unreachable = 0;
    for (let s = 0; s < grid.length; s++) {
      const d = dijkstra(W, s);
      for (let t = 0; t < grid.length; t++) {
        if (d[t] === Infinity) { unreachable++; assert.equal(net.minutes[s][t], Infinity, `${s}->${t} should be unreachable`); continue; }
        near(net.minutes[s][t], d[t], 1e-6, `rerouted ${s}->${t}`);
        if (net.minutes[s][t] > open.minutes[s][t] + 1e-6) rerouted++;
        // the composed grid path avoids every closed circle
        const p = net.gridPath(s, t).map((id) => grid[net.index[id]]);
        for (let k = 1; k < p.length; k++) assert.equal(blocked(p[k - 1], p[k]), false, 'path avoids closures');
      }
    }
    assert.ok(net.blockedArcs > 0, 'closures blocked something');
    void unreachable;
  }
  assert.ok(rerouted > 50, 'closures forced longer routes on many pairs: ' + rerouted);
});

test('off-grid leg: nearest grid point, haversine x 1.3 at 25 mph', () => {
  const p = geo.destination(A, 0, 1);              // 1 mi north of A
  const leg = N.offGridLeg(p, GRID);
  assert.equal(leg.gridId, 'A');
  assert.equal(leg.index, 0);
  near(leg.distMi, 1, 1e-9);
  near(leg.miles, 1.3, 1e-9);
  near(leg.minutes, 1.3 / 25 * 60, 1e-9);
  assert.equal(leg.blocked, false);
  assert.equal(leg.riskUnits, 0);
  // a closed zone over the short leg pushes the point to the next nearest grid point
  const z = [{ id: 'Z', kind: 'closed', lat: (A.lat + p.lat) / 2, lon: A.lon, radiusMi: 0.2 }];
  const leg2 = N.offGridLeg(p, GRID, { zones: z });
  assert.notEqual(leg2.gridId, 'A');
  assert.equal(leg2.blocked, false);
  // a point inside a closed zone cannot leave it
  const leg3 = N.offGridLeg(p, GRID, { zones: [{ id: 'Z', kind: 'closed', lat: p.lat, lon: p.lon, radiusMi: 0.5 }] });
  assert.equal(leg3.blocked, true);
  assert.equal(leg3.minutes, Infinity);
  assert.equal(leg3.gridId, 'A');
  // risk on the leg
  const leg4 = N.offGridLeg(p, GRID, { zones: [{ id: 'R', kind: 'risk', rating: 'Medium', lat: p.lat, lon: p.lon, radiusMi: 0.5 }], riskRatings: { Medium: 3 } });
  near(leg4.riskUnits, 0.5 * 3, 0.01);
  // filter and forced grid point
  assert.equal(N.offGridLeg(p, GRID, { filter: (g) => g.id !== 'A' }).gridId, 'B');
  assert.equal(N.offGridLeg(p, GRID, { gridId: 'C' }).gridId, 'C');
  assert.equal(N.offGridLeg(p, [], {}), null);
});

test('net.between: grid ids, indexes and off-grid points', () => {
  const net = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false });
  const p = geo.destination(A, 0, 1);
  const r = net.between(p, 'C');
  near(r.minutes, 1.3 / 25 * 60 + net.minutes[0][2], 1e-9);
  near(r.miles, 1.3 + net.miles[0][2], 1e-9);
  assert.equal(r.fromGridId, 'A');
  assert.deepEqual(Array.from(r.gridPath), ['A', 'B', 'C']);
  assert.equal(net.between(0, 2).minutes, net.minutes[0][2]);
  assert.equal(net.between('A', 'C').minutes, net.minutes[0][2]);
  // with B closed the point near A still reaches C via D
  const closed = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [{ id: 'Z', kind: 'closed', lat: B.lat, lon: B.lon, radiusMi: 3 }], cache: false });
  const r2 = closed.between(p, 'C');
  near(r2.minutes, 1.3 / 25 * 60 + closed.minutes[0][2], 1e-9);
  // a point next to B (inside the closure) cannot be served
  const r3 = closed.between(geo.destination(B, 0, 0.5), 'C');
  assert.equal(r3.minutes, Infinity);
});

test('caching by input identity and zone content', () => {
  N.clearCache();
  const zones = [{ id: 'Z1', kind: 'closed', lat: B.lat, lon: B.lon, radiusMi: 3 }];
  const n1 = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones });
  const n2 = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: JSON.parse(JSON.stringify(zones)) });
  assert.equal(n1, n2, 'same zones content -> cached object');
  const n3 = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [{ ...zones[0], radiusMi: 4 }] });
  assert.notEqual(n3, n1);
  const n4 = N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [] });
  assert.notEqual(n4, n1);
  assert.equal(N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [] }), n4);
  assert.notEqual(N.build({ grid: GRID, links: LINKS, googleMatrix: null, zones: [], cache: false }), n4);
  assert.notEqual(N.zonesKey(zones), N.zonesKey([]));
});

test('defaults come from SRO.data; unknown link ids produce warnings', () => {
  SRO.data.grid = GRID;
  SRO.data.grid_links = LINKS.concat([{ a: 'A', b: 'NOPE', road: 'local' }]);
  const net = N.build({ zones: [], cache: false });
  assert.equal(net.source, 'estimate');
  assert.equal(net.n, 4);
  assert.ok(net.warnings.some((w) => w.includes('NOPE')));
  SRO.data.google_matrix = { source: 'google', fetchedAt: 't', gridIds: ['A', 'B', 'C', 'D'], minutes: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], [3, 2, 1, 0]], meters: null };
  assert.equal(N.build({ cache: false }).source, 'matrix');
  assert.equal(N.build({ googleMatrix: null, cache: false }).source, 'estimate');
  delete SRO.data.grid; delete SRO.data.grid_links; delete SRO.data.google_matrix;
});

test('performance: 50 points, closures and risk zones build quickly', () => {
  const { grid, links } = randomNetwork(3, 50, 50);
  const zones = [
    { id: 'C1', kind: 'closed', lat: 23.5, lon: 120.6, radiusMi: 8 },
    { id: 'C2', kind: 'closed', lat: 24.4, lon: 121.0, radiusMi: 5 },
    { id: 'R1', kind: 'risk', rating: 'High', lat: 22.8, lon: 120.4, radiusMi: 10 },
    { id: 'R2', kind: 'risk', rating: 'Low', lat: 24.9, lon: 121.3, radiusMi: 12 }
  ];
  N.clearCache();
  const t0 = performance.now();
  const net = N.build({ grid, links, googleMatrix: null, zones });
  const cold = performance.now() - t0;
  const t1 = performance.now();
  N.build({ grid, links, googleMatrix: null, zones: zones.slice(0, 3) });
  const warmBase = performance.now() - t1;
  assert.ok(cold < 1000, 'cold build ' + cold.toFixed(1) + ' ms');
  assert.ok(warmBase < 500, 'zone change ' + warmBase.toFixed(1) + ' ms');
  assert.equal(net.minutes.length, 50);
  // JSON-friendly matrices (plain arrays, Infinity survives the util replacer)
  assert.ok(Array.isArray(net.minutes[0]));
  const back = JSON.parse(JSON.stringify(net.minutes, SRO.util.jsonReplacer), SRO.util.jsonReviver);
  assert.deepEqual(back, JSON.parse(JSON.stringify(net.minutes, SRO.util.jsonReplacer), SRO.util.jsonReviver));
});
