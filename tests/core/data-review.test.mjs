// Adversarial review tests for the data layer (grid, links, catalog, scenario) and the urgency and
// sample modules: road-graph consistency of the grid, coastline checks, randomized properties,
// boundary values and malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const BASE = [
  'src/core/ns.js', 'src/core/util.js',
  'src/data/grid.json', 'src/data/grid_links.json',
  'src/data/catalog.js', 'src/data/scenario.js',
  'src/core/urgency.js', 'src/core/samples.js'
];
// Pure context: no coastline, no road graph (what the solver worker and most tests see).
const SRO = loadScripts(BASE);
// App-like context: the Natural Earth coastline and the OSM road graph are loaded too.
const APP = loadScripts([...BASE, 'src/data/taiwan_coast.json', 'src/data/roads_graph.json',
  'src/core/geo.js', 'src/core/road_router.js', 'src/core/roads.js']);

const U = SRO.core.urgency;
const H = SRO.data.catalogHelpers;
const catalog = SRO.data.catalog;
const scenario = SRO.data.scenario;
const grid = SRO.data.grid;
const links = SRO.data.grid_links;
const byId = new Map(grid.map((g) => [g.id, g]));
const plain = (x) => JSON.parse(JSON.stringify(x));
const codes = (list) => plain(list.map((x) => x.code).sort());
const NOW = 360;

const R = APP.core.roads;
const G = APP.lib.RoadRouter.load(APP.data.roads_graph);
const GDATA = APP.data.roads_graph;
const edgeClass = (e) => G.classes[(GDATA.c[e] & 31) >> 2];
const edgeIsLink = (e) => (GDATA.c[e] & 32) !== 0;

function havKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
function segDistM(p, a, b) {   // p, a, b = [lat, lon]
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? -(ax * dx + ay * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// Nearest road-graph edge to a point: { d (m), e }.
function nearestEdge(p) {
  let best = { d: Infinity, e: -1 };
  for (let e = 0; e < G.edgeCount; e++) {
    const g = G.geom[e];
    for (let q = 1; q < g.length; q++) {
      const d = segDistM(p, g[q - 1], g[q]);
      if (d < best.d) best = { d, e };
    }
  }
  return best;
}
const mainCoast = APP.data.taiwan_coast.features.find((f) => f.properties.name === 'Taiwan main island').geometry.coordinates[0];
function inCoast(lat, lon) {
  let c = false;
  for (let i = 0, j = mainCoast.length - 1; i < mainCoast.length; j = i++) {
    const [xi, yi] = mainCoast[i], [xj, yj] = mainCoast[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function coastDistKm(lat, lon) {
  let b = Infinity;
  for (let i = 1; i < mainCoast.length; i++) b = Math.min(b, segDistM([lat, lon], [mainCoast[i - 1][1], mainCoast[i - 1][0]], [mainCoast[i][1], mainCoast[i][0]]));
  return b / 1000;
}

function req(over) {
  return Object.assign({
    id: 'R-0001', source: 'user', unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN',
    lat: 24.15, lon: 120.68, gridId: 'G-TAICHUNG', mobility: 'mounted', maxTravelMi: 50,
    desiredPickup: null, directOnly: false, directReason: null, directReasonText: '',
    lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null }],
    urgencyRequested: 'Routine', urgency: 'Routine', hoursLeftComputed: null, hoursLeftReported: null,
    nlt: NOW + 600, deadline: NOW + 600, remarks: '', createdAt: NOW, windowId: 'W-001', status: 'submitted',
    locks: { truckId: null, forceDirect: false }, updated: false
  }, over || {});
}
const diesel = (onHand, qty) => ({ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: qty || 500, unit: 'gal', onHand });

// =============================================================================================
// Grid against the road graph (DESIGN.md section 5: points sit on primary-or-bigger roads)
// =============================================================================================
test('grid: every point is within 500 m of a motorway/trunk/primary road (the router snaps there)', () => {
  for (const g of grid) {
    const s = R.snap({ lat: g.lat, lon: g.lon });
    assert.ok(s && s.onGraph, g.id + ' is off the road graph');
    assert.ok(s.meters <= 500, g.id + ' is ' + Math.round(s.meters) + ' m from the nearest main road');
  }
});

test('grid: hubs and rally candidates are not on a motorway carriageway or ramp', () => {
  // A point on a one-way motorway carriageway forces detours to the next interchange (the old
  // FOB Anvil spot on Fwy 10 made Anvil -> Kaohsiung 49 km for a 9 km gap).
  for (const g of grid.filter((p) => p.kind === 'hub' || p.rallyCandidate)) {
    const n = nearestEdge([g.lat, g.lon]);
    assert.notEqual(edgeClass(n.e), 'motorway', g.id + ' snaps to a motorway');
    assert.equal(edgeIsLink(n.e), false, g.id + ' snaps to a ramp');
  }
});

test('grid: hubs sit on a road-graph junction so trucks can leave and return in any direction', () => {
  const deg = new Map();
  for (let e = 0; e < GDATA.a.length; e++) {
    const a = GDATA.a[e], b = GDATA.a[e] + GDATA.db[e];
    deg.set(a, (deg.get(a) || 0) + 1);
    deg.set(b, (deg.get(b) || 0) + 1);
  }
  for (const h of grid.filter((p) => p.kind === 'hub')) {
    const n = G.nearest([h.lat, h.lon]);
    assert.ok(n.dist < 30, h.id + ' is ' + Math.round(n.dist) + ' m from a graph node');
    assert.ok(deg.get(n.node) >= 3, h.id + ' node degree ' + deg.get(n.node));
  }
});

test('grid: hub legs to linked neighbours have no carriageway detours (road <= 3x straight, both ways)', () => {
  for (const l of links) {
    const A = byId.get(l.a), B = byId.get(l.b);
    if (A.kind !== 'hub' && B.kind !== 'hub') continue;
    const km = havKm(A, B);
    for (const [x, y] of [[A, B], [B, A]]) {
      const r = R.route(x, y);
      assert.equal(r.source, 'osm-roads', x.id + ' -> ' + y.id);
      const roadKm = r.miles * 1.609344;
      assert.ok(roadKm <= 3 * km, x.id + ' -> ' + y.id + ': ' + roadKm.toFixed(1) + ' km on roads for ' + km.toFixed(1) + ' km');
    }
  }
});

test('grid: no point is snapped where every trip out (or every trip in) carries a carriageway detour', () => {
  // A point snapped to the wrong pass of a one-way loop pays a U-turn on every trip in one direction.
  // The old Fenglin spot sat on the west pass of Hwy 9's merged carriageway loop (which runs down to
  // the Mataian gap and back): every trip out ran 14-17 km further than the trip in.
  const hubs = grid.filter((p) => p.kind === 'hub');
  for (const g of grid) {
    const d = hubs.filter((h) => h !== g).map((h) => (R.route(g, h).miles - R.route(h, g).miles) * 1.609344);
    const consistent = Math.min(...d) > 0 ? Math.min(...d) : Math.max(...d) < 0 ? -Math.max(...d) : 0;
    assert.ok(consistent <= 3, g.id + ': out - in = ' + d.map((x) => x.toFixed(1)).join(', ') + ' km');
  }
});

test('links: every link is routable on real roads (no straight-line fallback at either end)', () => {
  for (const l of links) {
    const r = R.route(byId.get(l.a), byId.get(l.b));
    assert.equal(r.source, 'osm-roads', l.a + '-' + l.b + ' ' + r.reason);
    assert.ok(r.reachable, l.a + '-' + l.b);
  }
});

test('grid: names unique, ids match the G-<NAME> pattern, no point named after a removed pass', () => {
  assert.equal(new Set(grid.map((g) => g.name)).size, grid.length);
  assert.ok(!byId.has('G-YAKOU') && !byId.has('G-LIDAO'), 'Hwy 20 summit section is not a truck road in the graph');
  for (const l of links) assert.ok(typeof l.via === 'string' && l.via.length > 2, l.a + '-' + l.b + ' via');
  // every rally candidate and hub is reachable from every hub over the fallback link graph
  const adj = new Map(grid.map((g) => [g.id, []]));
  for (const l of links) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  const seen = new Set(['G-ANVIL']);
  const stack = ['G-ANVIL'];
  while (stack.length) for (const n of adj.get(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  assert.equal(seen.size, grid.length);
});

// =============================================================================================
// insideTaiwan: rough outline and coastline refinement
// =============================================================================================
test('insideTaiwan (outline only): every point of the road graph is inside the outline', () => {
  let n = 0;
  for (let e = 0; e < G.edgeCount; e++) {
    for (const p of G.geom[e]) {
      n++;
      assert.ok(scenario.insideOutline(p[0], p[1]), 'road point ' + p[0].toFixed(4) + ',' + p[1].toFixed(4) + ' is outside the outline');
    }
  }
  assert.ok(n > 10000);
  // without a coastline loaded, insideTaiwan is the outline
  for (const [la, lo] of [[22.93, 120.08], [25.04, 121.51], [23.57, 119.58], [24.0, 121.7]]) {
    assert.equal(scenario.insideTaiwan(la, lo), scenario.insideOutline(la, lo));
  }
});

test('insideTaiwan (with coastline): real roads and the grid pass, points well out at sea do not', () => {
  const inside = APP.data.scenario.insideTaiwan;
  for (let e = 0; e < G.edgeCount; e += 3) for (const p of G.geom[e]) assert.ok(inside(p[0], p[1]), 'road point ' + p);
  for (const g of grid) assert.ok(inside(g.lat, g.lon), g.id);
  // 8.5 km off the Tainan coast was accepted by the outline alone
  assert.equal(scenario.insideTaiwan(22.93, 120.08), true);
  assert.equal(inside(22.93, 120.08), false);
  // sweep: inside the outline, outside the coast polygon and more than the buffer out -> rejected
  let checked = 0;
  for (let la = 21.9; la <= 25.3; la += 0.04) {
    for (let lo = 120.0; lo <= 122.0; lo += 0.04) {
      if (!scenario.insideOutline(la, lo) || inCoast(la, lo)) continue;
      const d = coastDistKm(la, lo);
      if (d > APP.data.scenario.coastBufferKm + 0.05) { checked++; assert.equal(inside(la, lo), false, la.toFixed(2) + ',' + lo.toFixed(2)); }
      if (d < APP.data.scenario.coastBufferKm - 0.05) assert.equal(inside(la, lo), true, la.toFixed(2) + ',' + lo.toFixed(2));
    }
  }
  assert.ok(checked > 20, 'sweep found offshore points: ' + checked);
  // outer islands stay out (Penghu is in the coastline file but is not the main island)
  for (const [la, lo] of [[23.57, 119.58], [22.66, 121.49], [22.05, 121.55], [22.34, 120.37], [24.84, 121.95], [24.45, 118.38]]) {
    assert.equal(inside(la, lo), false, la + ',' + lo);
  }
  for (const bad of [[NaN, 121], [24, Infinity], [null, 121], ['24', '121']]) assert.equal(inside(bad[0], bad[1]), false);
  // validate uses it by default
  assert.deepEqual(codes(APP.core.urgency.validate(req({ lat: 22.93, lon: 120.08 }), { nowMin: NOW }).errors), ['outside-taiwan']);
});

// =============================================================================================
// Catalog
// =============================================================================================
test('catalog: daily-use lookups agree with urgency.js for random tables with junk values', () => {
  const rng = SRO.util.rng(4242);
  const junk = [NaN, Infinity, -Infinity, '300', null, undefined, 0, -5, 1e-9, 12.5, 1e6];
  const keys = [];
  for (const it of catalog.items) {
    keys.push(it.id);
    for (const o of it.options) keys.push(it.id + ':' + o.id);
  }
  for (let k = 0; k < 300; k++) {
    const table = {};
    for (const key of keys) if (rng() < 0.3) table[key] = rng.pick(junk);
    const it = rng.pick(catalog.items);
    const option = it.freeText ? 'some part' : (rng() < 0.85 ? rng.pick(it.options).id : 'bogus');
    const line = { itemId: it.id, option };
    const a = H.dailyUseFor(line, table), b = U.dailyUseFor(line, catalog, table);
    assert.ok(Object.is(a, b), JSON.stringify(line) + ' ' + a + ' vs ' + b);
    assert.ok(a === null || (typeof a === 'number' && isFinite(a)), 'rate must be finite or null: ' + a);
  }
});

test('catalog: lineToLoad property: cargo rounds up to one 0.1 pallet step, fuel is exact, junk is null', () => {
  const rng = SRO.util.rng(77);
  for (let k = 0; k < 2000; k++) {
    const it = rng.pick(catalog.items);
    const option = it.freeText ? 'part' : rng.pick(it.options).id;
    const s = H.spec(it.id, option);
    const qty = Math.max(it.step, Math.round(rng() * s.maxQty / it.step) * it.step);
    const l = H.lineToLoad({ itemId: it.id, option, qty });
    if (it.loadGroup === 'fuel') {
      assert.deepEqual(plain(l), { group: 'fuel', qty, unit: 'gal', exact: qty });
      continue;
    }
    assert.equal(l.group, 'cargo');
    assert.equal(l.unit, 'pallet');
    const exact = qty * s.palletsPerUnit;
    assert.ok(Math.abs(l.exact - exact) < 1e-6);
    assert.ok(l.qty >= 0.1 - 1e-9 && l.qty >= exact - 1e-6 && l.qty < Math.max(0.1, exact) + 0.1 + 1e-6, it.id + ' ' + qty + ' -> ' + l.qty);
    assert.ok(Math.abs(l.qty * 10 - Math.round(l.qty * 10)) < 1e-6, 'on the 0.1 grid: ' + l.qty);
    assert.ok(l.qty <= 10 + 1e-9, 'a line at or below maxQty fits one cargo truck');
  }
  for (const qty of [0, -1, NaN, Infinity, -Infinity, null, undefined, 'abc']) {
    assert.equal(H.lineToLoad({ itemId: 'mre', option: 'mixed', qty }), null, String(qty));
    assert.equal(H.lineToLoad({ itemId: 'diesel', option: 'JP-8', qty }), null, String(qty));
  }
  assert.equal(H.lineToLoad(null), null);
  assert.equal(H.lineToLoad({ itemId: 'mre', option: 'mixed', qty: '48' }).qty, 1);   // numeric strings are read as numbers
});

test('catalog: requestLoads sums exactly and rounds once; never more than the per-line rounding', () => {
  const rng = SRO.util.rng(99);
  for (let k = 0; k < 500; k++) {
    const lines = [];
    const n = 1 + rng.int(5);
    for (let i = 0; i < n; i++) {
      const it = rng.pick(catalog.items);
      const option = it.freeText ? 'part' : rng.pick(it.options).id;
      lines.push({ itemId: it.id, option, qty: rng() < 0.1 ? 0 : (1 + rng.int(20)) * it.step });
    }
    const out = H.requestLoads(lines);
    const per = lines.map((l) => H.lineToLoad(l));
    const fuel = per.filter((l) => l && l.group === 'fuel');
    const cargo = per.filter((l) => l && l.group === 'cargo');
    if (!fuel.length) assert.equal(out.fuel, null);
    else assert.equal(out.fuel.qty, fuel.reduce((s, l) => s + l.qty, 0));
    if (!cargo.length) { assert.equal(out.cargo, null); continue; }
    const exact = cargo.reduce((s, l) => s + l.exact, 0);
    assert.ok(Math.abs(out.cargo.exact - exact) < 1e-5);
    assert.ok(out.cargo.qty >= exact - 1e-6 && out.cargo.qty < Math.max(0.1, exact) + 0.1 + 1e-6);
    assert.ok(out.cargo.qty <= cargo.reduce((s, l) => s + l.qty, 0) + 1e-9);
    const idx = per.map((l, i) => (l && l.group === 'cargo' ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(plain(out.cargo.lineIdxs), idx);
  }
});

test('catalog: default and max quantities sit on the item step; labels and units resolve', () => {
  for (const it of catalog.items) {
    const specs = it.freeText ? [H.spec(it.id, null)] : it.options.map((o) => H.spec(it.id, o.id));
    for (const s of specs) {
      for (const k of ['defaultQty', 'maxQty']) {
        assert.ok(Math.abs(s[k] / it.step - Math.round(s[k] / it.step)) < 1e-9, it.id + (s.option ? ':' + s.option.id : '') + ' ' + k);
      }
    }
    assert.ok(H.unitLabel(it.unit, 2).length > 0);
    assert.equal(H.classLabel(it.classId), catalog.classes.find((c) => c.id === it.classId).label);
  }
  assert.equal(H.unitLabel('case', 1), 'case');
  assert.equal(H.unitLabel('case', 3), 'cases');
  assert.equal(H.unitLabel('furlong', 3), 'furlong');
  assert.equal(H.classLabel('II'), 'Class II');
  assert.equal(H.classRank('II'), 5);
  assert.equal(H.spec('nope', 'x'), null);
  assert.equal(H.optionById('diesel', 'JP-8').label, 'JP-8');
  assert.equal(H.optionById('diesel', 'JP-5'), null);
});

// =============================================================================================
// Urgency
// =============================================================================================
function randomUrgent(rng) {
  const rateItems = catalog.items.filter((it) => !it.freeText);
  const n = 1 + rng.int(3);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const it = rng.pick(rateItems);
    const option = rng.pick(it.options).id;
    const rate = U.dailyUseFor({ itemId: it.id, option }, catalog);
    // on hand around the 24 h line, including exact multiples of the daily rate
    const onHand = rng() < 0.2 ? rate : Math.round(rate * rng() * 2.5 * 100) / 100;
    lines.push({ classId: it.classId, itemId: it.id, option, qty: it.step, unit: it.unit, onHand });
  }
  const tier = rng.pick(['Routine', 'Priority', 'Urgent', 'Urgent']);
  const reported = rng() < 0.5 ? null : rng.pick([0, 5, 23.99, 24, 24.01, 30, Math.round(rng() * 4800) / 100]);
  const nlt = NOW + rng.int(1440);
  return req({ urgencyRequested: tier, lines, hoursLeftReported: reported, nlt, deadline: nlt });
}

test('escalate property: never downgrades, Immediate exactly when the earliest run-out is under 24 h, deadline = min(NLT, run-out)', () => {
  const rng = SRO.util.rng(31337);
  for (let k = 0; k < 3000; k++) {
    const r = randomUrgent(rng);
    const now = NOW + rng.int(120);
    const e = U.escalate(r, now);
    const comp = U.hoursLeft(r.lines, catalog);
    assert.equal(e.hoursLeftComputed, comp);
    assert.ok(U.tierIndex(e.urgency) >= U.tierIndex(r.urgencyRequested), 'never downgraded');
    assert.equal(e.hardDeadline, U.isHardDeadline(e.urgency));
    if (r.urgencyRequested !== 'Urgent') {
      assert.equal(e.urgency, r.urgencyRequested);
      assert.equal(e.deadline, r.nlt);
      continue;
    }
    const rep = r.hoursLeftReported;
    const under = [comp, rep].filter((h) => h !== null && h < 24);
    if (!under.length) {
      assert.equal(e.urgency, 'Urgent', JSON.stringify([comp, rep]));
      assert.equal(e.deadline, r.nlt);
      assert.equal(e.runOutAt, null);
      continue;
    }
    assert.equal(e.urgency, 'Immediate', JSON.stringify([comp, rep]));
    const h = Math.min(...under);
    assert.equal(e.runOutAt, Math.floor(now + h * 60));
    assert.equal(e.deadline, Math.min(r.nlt, e.runOutAt));
    assert.ok(e.deadline <= r.nlt);
    assert.equal(e.code, comp !== null && comp < 24 ? 'computed-under-24' : 'reported-under-24');
    // apply() agrees and leaves the input alone
    const before = JSON.stringify(r);
    const a = U.apply(r, now);
    assert.equal(JSON.stringify(r), before);
    assert.equal(a.urgency, e.urgency);
    assert.equal(a.deadline, e.deadline);
  }
});

test('escalate: a reported run-out sooner than the computed one wins (both under 24 h)', () => {
  // 150 gal = 12 h computed; the unit says 5 h
  const e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(150)], hoursLeftReported: 5, nlt: 5000 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.runOutAt, NOW + 300);
  assert.equal(e.deadline, NOW + 300);
  assert.match(e.reason, /sooner/);
  // a later report does not stretch the computed run-out
  const f = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(150)], hoursLeftReported: 20, nlt: 5000 }), NOW);
  assert.equal(f.deadline, NOW + 720);
});

test('needsRunOutQuestion agrees with escalate (random Urgent requests with on hand)', () => {
  const rng = SRO.util.rng(5150);
  for (let k = 0; k < 2000; k++) {
    const r = randomUrgent(rng);
    r.urgencyRequested = 'Urgent';
    r.hoursLeftReported = null;
    const ask = U.needsRunOutQuestion(r, catalog);
    const e = U.escalate(r, NOW);
    assert.equal(ask, e.urgency === 'Urgent', JSON.stringify(r.lines));
    assert.equal(U.needsRunOutQuestion('Urgent', e.hoursLeftComputed), ask);
  }
});

test('validate: an urgency must be picked from Routine / Priority / Urgent', () => {
  for (const u of [undefined, null, '', 'urgent', 'Immediate', 'ASAP']) {
    const v = U.validate(req({ urgencyRequested: u }), { nowMin: NOW });
    assert.deepEqual(codes(v.errors), ['urgency-missing'], String(u));
  }
  for (const u of U.REQUESTABLE) {
    const lines = [diesel(400)];
    assert.equal(U.validate(req({ urgencyRequested: u, lines }), { nowMin: NOW }).ok, true, u);
  }
});

test('validate: options come from the fixed catalog; a single-option item may leave it out', () => {
  let v = U.validate(req({ lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-5', qty: 100, unit: 'gal', onHand: null }] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['unknown-option']);
  assert.equal(v.errors[0].lineIdx, 0);
  assert.match(v.errors[0].message, /Diesel/);
  v = U.validate(req({ lines: [{ classId: 'V', itemId: 'small-arms', qty: 100, unit: 'round', onHand: null }] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['unknown-option']);
  for (const option of [null, undefined, '', 'MOGAS']) {
    v = U.validate(req({ lines: [{ classId: 'III', itemId: 'gasoline', option, qty: 100, unit: 'gal', onHand: null }] }), { nowMin: NOW });
    assert.equal(v.ok, true, String(option));
  }
  // every catalog option is accepted
  for (const it of catalog.items.filter((x) => !x.freeText)) {
    for (const o of it.options) {
      v = U.validate(req({ lines: [{ classId: it.classId, itemId: it.id, option: o.id, qty: it.step, unit: it.unit, onHand: null }] }), { nowMin: NOW });
      assert.equal(v.ok, true, it.id + ':' + o.id + ' ' + JSON.stringify(v.errors));
    }
  }
});

test('validate: a class or unit that contradicts the item blocks (it would mis-rank the job)', () => {
  let v = U.validate(req({ lines: [{ classId: 'IX', itemId: 'diesel', option: 'JP-8', qty: 100, unit: 'gal', onHand: null }] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['line-mismatch']);
  v = U.validate(req({ lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 100, unit: 'case', onHand: null }] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['line-mismatch']);
  v = U.validate(req({ lines: [{ itemId: 'diesel', option: 'JP-8', qty: 100, onHand: null }] }), { nowMin: NOW });
  assert.equal(v.ok, true, 'classId / unit left out is tolerated');
});

test('validate and escalate survive malformed input without throwing', () => {
  const weird = [
    req({ lines: null }), req({ lines: 'diesel' }), req({ lines: [null] }), req({ lines: [{}] }),
    req({ lines: [undefined, diesel(5)] }), {}, null, undefined
  ];
  for (const r of weird) {
    const v = U.validate(r, { nowMin: NOW });
    assert.equal(v.ok, false);
    assert.ok(v.errors.every((x) => typeof x.message === 'string' && x.message.length > 5));
    const e = U.escalate(r, NOW);
    assert.ok(U.TIERS.includes(e.urgency));
    U.needsRunOutQuestion(r);
    U.requestClassRank(r);
  }
  assert.deepEqual(codes(U.validate(req({ lines: [null] }), { nowMin: NOW }).errors), ['unknown-item', 'zero-qty']);
  const sorted = [req({ id: 'B', lines: [null] }), req({ id: 'A', lines: 'x' })].sort(U.compareRequests);
  assert.deepEqual(sorted.map((r) => r.id), ['A', 'B']);
});

test('validate: a hub that cannot reach the platoon at all (Infinity) warns too', () => {
  const r = req({ nlt: NOW + 120 });
  let v = U.validate(r, { nowMin: NOW, hubReachMin: Infinity });
  assert.equal(v.ok, true);
  assert.deepEqual(codes(v.warnings), ['nlt-unreachable']);
  assert.match(v.warnings[0].message, /No hub/);
  v = U.validate(r, { nowMin: NOW, hubReachMin: () => Infinity });
  assert.deepEqual(codes(v.warnings), ['nlt-unreachable']);
  v = U.validate(r, { nowMin: NOW, hubReachMin: NaN });
  assert.deepEqual(plain(v.warnings), []);
});

test('validate: over-daily-use boundary follows the planner table, including option keys', () => {
  const line = (qty) => ({ classId: 'V', itemId: 'small-arms', option: '.50cal', qty, unit: 'round', onHand: null });
  assert.deepEqual(plain(U.validate(req({ lines: [line(2000)] }), { nowMin: NOW }).warnings), []);          // 5 x 400
  assert.deepEqual(codes(U.validate(req({ lines: [line(2010)] }), { nowMin: NOW }).warnings), ['over-daily-use']);
  const t = { 'small-arms:.50cal': 1000, 'small-arms': 1 };
  assert.deepEqual(plain(U.validate(req({ lines: [line(5000)] }), { nowMin: NOW, dailyUse: t }).warnings), []);
  assert.deepEqual(codes(U.validate(req({ lines: [line(5010)] }), { nowMin: NOW, dailyUse: t }).warnings), ['over-daily-use']);
});

test('compareRequests is a consistent total order (random requests)', () => {
  const rng = SRO.util.rng(8);
  const pool = [];
  for (let k = 0; k < 120; k++) {
    const r = randomUrgent(rng);
    r.id = 'R-' + String(rng.int(60)).padStart(4, '0');
    r.urgency = rng.pick(U.TIERS);
    r.deadline = rng() < 0.1 ? null : NOW + 30 * rng.int(10);
    r.createdAt = rng() < 0.1 ? undefined : 300 + 5 * rng.int(5);
    pool.push(r);
  }
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      // antisymmetric: sign(a,b) = -sign(b,a) (summed, so 0 and -0 compare equal)
      assert.equal(sgn(U.compareRequests(pool[i], pool[j])) + sgn(U.compareRequests(pool[j], pool[i])), 0);
    }
  }
  const sorted = pool.slice().sort(U.compareRequests);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(U.compareRequests(sorted[i - 1], sorted[i]) <= 0);
    assert.ok(U.tierIndex(sorted[i - 1].urgency) >= U.tierIndex(sorted[i].urgency), 'urgency always beats class');
  }
});

// =============================================================================================
// Samples
// =============================================================================================
const SEEDS = [20261005, 1, 2, 3, 42, 777, 9001, 123456789];
for (let s = 0; s < 40; s++) SEEDS.push(1000003 * (s + 1));

test('samples: exactly one Immediate and 2-3 Urgent even with planner-edited daily-use rates', () => {
  const base = H.defaultDailyUse();
  const tables = [
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * 0.1])),   // everything low
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * 10])),    // everything high
    Object.fromEntries(Object.entries(base).map(([k]) => [k, 0])),            // rates zeroed
    Object.assign({}, base, { diesel: 40, mre: 2, 'small-arms:5.56mm': 15, gasoline: 3, 'water-bottled:0.5L': 2 })
  ];
  for (const dailyUse of tables) {
    for (const seed of SEEDS.slice(0, 24)) {
      const a = plain(SRO.core.samples.generate(seed, { nowMin: NOW, dailyUse }));
      const imm = a.filter((r) => r.urgency === 'Immediate');
      assert.equal(imm.length, 1, 'seed ' + seed + ' ' + JSON.stringify(dailyUse).slice(0, 40));
      assert.equal(imm[0].urgencyRequested, 'Urgent');
      const urg = a.filter((r) => r.urgency === 'Urgent').length;
      assert.ok(urg >= 2 && urg <= 3, 'seed ' + seed + ' urgent ' + urg);
      for (const r of a) {
        const e = U.escalate(r, r.createdAt, { dailyUse });
        assert.equal(e.urgency, r.urgency, r.id);
        assert.equal(e.deadline, r.deadline, r.id);
        assert.equal(U.validate(r, { nowMin: NOW, dailyUse }).ok, true, r.id + ' ' + JSON.stringify(U.validate(r, { nowMin: NOW, dailyUse }).errors));
      }
    }
  }
});

test('samples: same output with or without the coastline loaded; all pass the app-side checks', () => {
  for (const seed of SEEDS) {
    const a = JSON.stringify(SRO.core.samples.generate(seed, { nowMin: NOW }));
    const b = JSON.stringify(APP.core.samples.generate(seed, { nowMin: NOW }));
    assert.equal(a, b, 'seed ' + seed);
    for (const r of JSON.parse(b)) {
      const v = APP.core.urgency.validate(r, { nowMin: NOW });
      assert.deepEqual(plain(v.errors), [], r.id);
      assert.ok(inCoast(r.lat, r.lon), 'seed ' + seed + ' ' + r.id + ' at sea: ' + r.lat + ',' + r.lon);
      const s = R.snap({ lat: r.lat, lon: r.lon });
      assert.ok(s.onGraph, 'seed ' + seed + ' ' + r.id + ' is ' + Math.round(s.meters) + ' m from any main road');
    }
  }
});

test('samples: an edited grid with a region lacking rally candidates still generates', () => {
  const g2 = plain(grid).map((p) => (p.region === 'east' && p.kind !== 'hub' ? Object.assign(p, { rallyCandidate: false }) : p));
  const a = plain(SRO.core.samples.generate(7, { nowMin: NOW, grid: g2 }));
  assert.equal(a.length, 19);
  assert.equal(a.filter((r) => r.urgency === 'Immediate').length, 1);
  const g3 = plain(grid).filter((p) => p.kind === 'hub');   // no rally candidates at all
  const b = plain(SRO.core.samples.generate(7, { nowMin: NOW, grid: g3, count: 5 }));
  assert.equal(b.length, 5);
  assert.ok(b.every((r) => g3.some((h) => h.id === r.gridId)));
});

test('samples: excluding every unit name still gives each request a name', () => {
  const a = plain(SRO.core.samples.generate(3, { nowMin: NOW, excludeUnitNames: scenario.unitNames.slice() }));
  assert.ok(a.every((r) => typeof r.unitName === 'string' && r.unitName.length > 5 && r.designator.length > 3));
});

// =============================================================================================
// Scenario
// =============================================================================================
test('scenario: hub fallback copies equal grid.json and fleets for custom hub lists stay consistent', () => {
  for (const h of scenario.hubDefs) {
    const g = byId.get(h.gridId);
    assert.equal(g.kind, 'hub');
    assert.deepEqual([h.lat, h.lon], [g.lat, g.lon], h.id);
  }
  const hubs = plain(scenario.defaultHubs()).slice(0, 2);
  const fleet = plain(scenario.defaultFleet(hubs));
  assert.deepEqual(fleet.map((t) => t.id), ['Alpha-1', 'Alpha-2', 'Bravo-1', 'Bravo-2']);
  assert.ok(fleet.every((t) => hubs.some((h) => h.id === t.hubId)));
  const s = plain(scenario.defaultState());
  assert.ok(s.scenario.fleet.every((t) => s.scenario.hubs.some((h) => h.id === t.hubId)));
  assert.ok(s.scenario.hubs.every((h) => byId.has(h.gridId)));
});
