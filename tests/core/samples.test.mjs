// Sample request generator: determinism, schema and the distribution the spec asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadScripts, ROOT } from '../load.mjs';

const SRO = loadScripts([
  'src/core/ns.js', 'src/core/util.js',
  'src/data/grid.json', 'src/data/grid_links.json',
  'src/data/catalog.js', 'src/data/scenario.js',
  'src/core/urgency.js', 'src/core/samples.js'
]);
const S = SRO.core.samples;
const U = SRO.core.urgency;
const grid = SRO.data.grid;
const scenario = SRO.data.scenario;
const plain = (x) => JSON.parse(JSON.stringify(x));
const gen = (seed, ctx) => plain(S.generate(seed, ctx));
const byId = new Map(grid.map((g) => [g.id, g]));

function havKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

// Optional cross-check against Natural Earth 1:10m land, main island only (dev dependency).
function loadLand() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const topo = require('topojson-client');
    const land = JSON.parse(fs.readFileSync(require.resolve('world-atlas/land-10m.json'), 'utf8'));
    let ring = null;
    for (const f of topo.feature(land, land.objects.land).features) {
      const ps = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of ps) {
        if (p[0].some(([x, y]) => x > 119.9 && x < 122.1 && y > 21.8 && y < 25.4) && (!ring || p[0].length > ring.length)) ring = p[0];
      }
    }
    return (lat, lon) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
  } catch (e) {
    return null;
  }
}
const onLand = loadLand();

const REQUEST_KEYS = ['id', 'source', 'unitName', 'designator', 'lat', 'lon', 'gridId', 'mobility', 'maxTravelMi',
  'desiredPickup', 'directOnly', 'directReason', 'directReasonText', 'lines', 'urgencyRequested', 'urgency',
  'hoursLeftComputed', 'hoursLeftReported', 'nlt', 'deadline', 'remarks', 'createdAt', 'windowId', 'status',
  'locks', 'updated'];
const LINE_KEYS = ['classId', 'itemId', 'option', 'qty', 'unit', 'onHand'];
const SEEDS = [20261005, 1, 2, 3, 42, 777, 9001, 123456789];
for (let s = 100; s < 160; s++) SEEDS.push(s * 7919);

const count = (arr, f) => arr.filter(f).length;

test('default seed, count, ids and determinism', () => {
  const a = gen(20261005, { nowMin: 360 });
  assert.equal(S.DEFAULT_SEED, 20261005);
  assert.equal(a.length, 19);
  assert.deepEqual(a.map((r) => r.id), Array.from({ length: 19 }, (_, i) => 'R-' + String(i + 1).padStart(4, '0')));
  assert.equal(JSON.stringify(gen(20261005, { nowMin: 360 })), JSON.stringify(a), 'same seed, same output');
  assert.equal(JSON.stringify(gen(undefined, { nowMin: 360 })), JSON.stringify(a), 'default seed');
  assert.equal(JSON.stringify(gen(null)), JSON.stringify(a), 'default seed and nowMin 360');
  assert.notEqual(JSON.stringify(gen(20261006, { nowMin: 360 })), JSON.stringify(a), 'different seed, different output');
  // ids continue after existing ones; window id is passed through
  const b = gen(20261005, { nowMin: 360, existingIds: ['R-0001', 'R-0007'], windowId: 'W-003' });
  assert.equal(b[0].id, 'R-0008');
  assert.equal(b[18].id, 'R-0026');
  assert.ok(b.every((r) => r.windowId === 'W-003'));
  assert.ok(a.every((r) => r.windowId === null));
});

test('every request matches the DESIGN.md section 3 schema', () => {
  for (const seed of SEEDS.slice(0, 10)) {
    for (const r of gen(seed, { nowMin: 360, windowId: 'W-001' })) {
      assert.deepEqual(Object.keys(r), REQUEST_KEYS, r.id);
      assert.equal(r.source, 'sample');
      assert.equal(r.status, 'submitted');
      assert.deepEqual(r.locks, { truckId: null, forceDirect: false });
      assert.equal(r.updated, false);
      assert.equal(typeof r.remarks, 'string');
      assert.ok(!/medevac/i.test(JSON.stringify(r)));
      assert.ok(U.TIERS.includes(r.urgency));
      assert.ok(U.REQUESTABLE.includes(r.urgencyRequested));
      assert.ok(['mounted', 'dismounted', 'fixed'].includes(r.mobility));
      assert.ok(r.lines.length >= 1 && r.lines.length <= 3);
      const items = new Set();
      for (const l of r.lines) {
        assert.deepEqual(Object.keys(l), LINE_KEYS);
        const it = SRO.data.catalogHelpers.itemById(l.itemId);
        assert.ok(it, l.itemId);
        assert.equal(l.classId, it.classId);
        assert.equal(l.unit, it.unit);
        if (it.freeText) assert.ok(l.option.length > 3);
        else assert.ok(it.options.some((o) => o.id === l.option), l.itemId + ' option ' + l.option);
        assert.ok(l.qty > 0 && l.qty <= SRO.data.catalogHelpers.spec(l.itemId, l.option).maxQty);
        assert.ok(!items.has(l.itemId), 'duplicate item in one request');
        items.add(l.itemId);
      }
      assert.equal(r.designator, scenario.designatorFor(r.unitName));
    }
  }
});

test('urgency mix: exactly 1 Immediate, 2-3 Urgent, the rest Routine/Priority (many seeds)', () => {
  for (const seed of SEEDS) {
    const a = gen(seed, { nowMin: 360 });
    const imm = a.filter((r) => r.urgency === 'Immediate');
    assert.equal(imm.length, 1, 'seed ' + seed);
    assert.equal(imm[0].urgencyRequested, 'Urgent', 'Immediate comes from escalation');
    const urg = count(a, (r) => r.urgency === 'Urgent');
    assert.ok(urg >= 2 && urg <= 3, 'seed ' + seed + ' urgent ' + urg);
    assert.equal(count(a, (r) => r.urgency === 'Routine' || r.urgency === 'Priority'), 19 - 1 - urg);
    assert.ok(count(a, (r) => r.urgency === 'Routine') >= 5 && count(a, (r) => r.urgency === 'Priority') >= 4, 'seed ' + seed);
    // escalation is reproducible from the stored fields
    for (const r of a) {
      const e = U.escalate(r, r.createdAt);
      assert.equal(e.urgency, r.urgency, r.id);
      assert.equal(e.deadline, r.deadline, r.id);
      assert.equal(e.hoursLeftComputed, r.hoursLeftComputed, r.id);
      if (r.urgencyRequested === 'Urgent') {
        assert.ok(r.lines.every((l) => typeof l.onHand === 'number'), 'Urgent needs on hand on every line');
        assert.ok(r.hoursLeftComputed !== null);
      }
      if (r.urgency === 'Urgent') assert.ok(r.hoursLeftComputed >= 24 && r.hoursLeftReported >= 24, r.id);
      if (r.urgency === 'Immediate') {
        assert.ok(r.hoursLeftComputed < 24 || r.hoursLeftReported < 24, r.id);
        assert.ok(['III', 'I', 'V'].includes(r.lines[0].classId));
      }
    }
  }
});

test('times: NLT within the next one or two windows, deadlines ahead of now, created before now', () => {
  for (const nowMin of [360, 1080, 2000]) {
    for (const seed of SEEDS.slice(0, 20)) {
      for (const r of gen(seed, { nowMin })) {
        assert.ok(r.nlt > nowMin && r.nlt <= nowMin + 720, 'nlt ' + r.nlt);
        assert.equal((r.nlt - nowMin) % 30, 0);
        assert.ok(r.createdAt <= nowMin && r.createdAt >= nowMin - 180, 'createdAt ' + r.createdAt);
        if (r.urgency === 'Immediate') {
          assert.ok(r.deadline <= r.nlt && r.deadline >= nowMin + 240, 'Immediate deadline ' + r.deadline);
        } else {
          assert.equal(r.deadline, r.nlt);
        }
      }
    }
  }
});

test('classes: fuel, food and ammo are the most common', () => {
  for (const seed of SEEDS) {
    const a = gen(seed, { nowMin: 360 });
    const prim = (c) => count(a, (r) => r.lines[0].classId === c);
    const big = Math.min(prim('III'), prim('I'), prim('V'));
    assert.ok(big > Math.max(prim('VIII'), prim('IX')), 'seed ' + seed);
    assert.ok(prim('VIII') >= 1 && prim('IX') >= 1, 'medical and parts still appear');
    const lines = a.flatMap((r) => r.lines);
    assert.ok(count(lines, (l) => ['III', 'I', 'V'].includes(l.classId)) / lines.length >= 0.7, 'seed ' + seed);
    assert.ok(count(lines, (l) => l.classId === 'III') >= 4);
  }
});

test('mobility: mixed mounted/dismounted, 1-2 fixed in place delivered direct', () => {
  for (const seed of SEEDS) {
    const a = gen(seed, { nowMin: 360 });
    const fixed = a.filter((r) => r.mobility === 'fixed');
    assert.ok(fixed.length >= 1 && fixed.length <= 2, 'seed ' + seed);
    for (const r of fixed) {
      assert.equal(r.directOnly, true);
      assert.ok(['in-contact', 'no-vehicles'].includes(r.directReason));
      assert.equal(r.maxTravelMi, 0);
      assert.equal(r.desiredPickup, null);
    }
    assert.ok(count(a, (r) => r.mobility === 'mounted') >= 5);
    assert.ok(count(a, (r) => r.mobility === 'dismounted') >= 5);
    for (const r of a.filter((x) => x.mobility !== 'fixed')) {
      assert.equal(r.directOnly, false);
      assert.equal(r.directReason, null);
      assert.equal(r.maxTravelMi, r.mobility === 'mounted' ? 50 : 5);
    }
  }
});

test('locations: spread over all four regions, a few km off a grid point, on land', () => {
  for (const seed of SEEDS) {
    const a = gen(seed, { nowMin: 360 });
    const regions = {};
    for (const r of a) {
      const g = byId.get(r.gridId);
      assert.ok(g, r.gridId);
      // gridId is the nearest grid point
      const nearest = grid.reduce((b, p) => (havKm(r, p) < havKm(r, b) ? p : b));
      assert.equal(r.gridId, nearest.id, r.id);
      const d = havKm(r, g);
      assert.ok(d >= 1 && d <= 8, r.id + ' is ' + d.toFixed(2) + ' km from ' + g.id);
      assert.ok(scenario.insideTaiwan(r.lat, r.lon), r.id);
      for (const v of [r.lat, r.lon]) assert.ok(Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6);
      if (onLand) assert.ok(onLand(r.lat, r.lon), 'seed ' + seed + ' ' + r.id + ' not on land: ' + r.lat + ',' + r.lon);
      regions[g.region] = (regions[g.region] || 0) + 1;
      assert.equal(U.validate(r, { nowMin: 360 }).ok, true, r.id + ' fails validation');
      assert.deepEqual(plain(U.validate(r, { nowMin: 360 }).warnings).filter((w) => w.code === 'over-daily-use'), []);
    }
    for (const reg of ['north', 'central', 'south', 'east']) assert.ok((regions[reg] || 0) >= 3, 'seed ' + seed + ' ' + reg + ' ' + regions[reg]);
    // the Immediate request sits within reach of a hub
    const imm = a.find((r) => r.urgency === 'Immediate');
    assert.ok(grid.filter((g) => g.kind === 'hub').some((h) => havKm(imm, h) <= 65));
  }
});

test('desired pickup hints: a few, each a rally candidate within the platoon radius', () => {
  for (const seed of SEEDS) {
    const a = gen(seed, { nowMin: 360 });
    const hinted = a.filter((r) => r.desiredPickup);
    assert.ok(hinted.length >= 2 && hinted.length <= 5, 'seed ' + seed + ' hints ' + hinted.length);
    for (const r of hinted) {
      const g = byId.get(r.desiredPickup.gridId);
      assert.ok(g && g.rallyCandidate && g.kind !== 'hub');
      assert.deepEqual(r.desiredPickup, { lat: g.lat, lon: g.lon, gridId: g.id });
      assert.ok(havKm(r, g) / 1.609344 <= r.maxTravelMi, r.id);
    }
  }
});

test('unit names: distinct, from the pool, honoring excludeUnitNames', () => {
  const a = gen(20261005, { nowMin: 360 });
  assert.equal(new Set(a.map((r) => r.unitName)).size, 19);
  assert.ok(a.every((r) => scenario.unitNames.includes(r.unitName)));
  const mine = a[0].unitName;
  const b = gen(20261005, { nowMin: 360, excludeUnitNames: [mine] });
  assert.ok(!b.some((r) => r.unitName === mine));
});

test('loads fit the default fleet with room to spare', () => {
  const H = SRO.data.catalogHelpers;
  for (const seed of SEEDS) {
    let fuel = 0, cargo = 0;
    for (const r of gen(seed, { nowMin: 360 })) {
      const l = H.requestLoads(r.lines);
      if (l.fuel) fuel += l.fuel.qty;
      if (l.cargo) cargo += l.cargo.qty;
    }
    assert.ok(fuel > 0 && fuel <= 4 * 2500, 'seed ' + seed + ' fuel ' + fuel);
    assert.ok(cargo > 0 && cargo <= 4 * 10, 'seed ' + seed + ' cargo ' + cargo);
  }
});

test('other counts work (store passes count) and keep exactly one Immediate', () => {
  assert.deepEqual(gen(5, { count: 0 }), []);
  for (let n = 1; n <= 40; n++) {
    const a = gen(20261005 + n, { nowMin: 360, count: n });
    assert.equal(a.length, n);
    assert.equal(count(a, (r) => r.urgency === 'Immediate'), 1, 'count ' + n);
    assert.equal(new Set(a.map((r) => r.id)).size, n);
    for (const r of a) assert.equal(U.validate(r, { nowMin: 360 }).ok, true, 'count ' + n + ' ' + r.id);
  }
});
