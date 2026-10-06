// Data layer checks: grid.json, grid_links.json, catalog.js, scenario.js.
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
  'src/core/urgency.js'
]);
const grid = SRO.data.grid;
const links = SRO.data.grid_links;
const catalog = SRO.data.catalog;
const H = SRO.data.catalogHelpers;
const scenario = SRO.data.scenario;
const plain = (x) => JSON.parse(JSON.stringify(x));   // cross-realm objects -> this realm

function havKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

// Optional cross-check against Natural Earth 1:10m land (dev dependency world-atlas + topojson-client).
function loadLand() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const topo = require('topojson-client');
    const land = JSON.parse(fs.readFileSync(require.resolve('world-atlas/land-10m.json'), 'utf8'));
    const fc = topo.feature(land, land.objects.land);
    const polys = [];
    for (const f of fc.features) {
      const ps = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of ps) if (p[0].some(([x, y]) => x > 119.9 && x < 122.1 && y > 21.8 && y < 25.4)) polys.push(p);
    }
    polys.sort((a, b) => b[0].length - a[0].length);
    polys.length = 1;   // main island only (drops Green Island, Xiaoliuqiu, Guishan)
    const inRing = (r, x, y) => {
      let c = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    return (lat, lon) => polys.some((p) => inRing(p[0], lon, lat) && !p.slice(1).some((h) => inRing(h, lon, lat)));
  } catch (e) {
    return null;
  }
}
const onLand = loadLand();

const KINDS = ['hub', 'town', 'junction', 'rally'];
const REGIONS = ['north', 'central', 'south', 'east'];
const ROADS = ['freeway', 'highway', 'mountain', 'local'];

// ---- grid.json -------------------------------------------------------------------------------
test('grid: 45-60 points with the documented schema and unique ids', () => {
  assert.ok(grid.length >= 45 && grid.length <= 60, 'count ' + grid.length);
  const ids = new Set();
  for (const g of grid) {
    assert.deepEqual(plain(Object.keys(g).sort()), ['id', 'kind', 'lat', 'lon', 'name', 'rallyCandidate', 'region'].sort(), g.id);
    assert.match(g.id, /^G-[A-Z0-9-]+$/);
    assert.ok(!ids.has(g.id), 'duplicate ' + g.id);
    ids.add(g.id);
    assert.equal(typeof g.name, 'string');
    assert.ok(g.name.length > 2);
    assert.ok(KINDS.includes(g.kind), g.id + ' kind');
    assert.ok(REGIONS.includes(g.region), g.id + ' region');
    assert.equal(typeof g.rallyCandidate, 'boolean');
    for (const v of [g.lat, g.lon]) assert.ok(Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6, g.id + ' has more than 5 decimals');
  }
});

test('grid: four hubs, one per region, not rally candidates', () => {
  const hubs = grid.filter((g) => g.kind === 'hub');
  assert.deepEqual(plain(hubs.map((h) => h.id).sort()), ['G-ANVIL', 'G-GRANITE', 'G-JADE', 'G-LOTUS']);
  assert.deepEqual(plain(hubs.map((h) => h.region).sort()), [...REGIONS].sort());
  for (const h of hubs) assert.equal(h.rallyCandidate, false);
});

test('grid: every point inside the rough Taiwan outline and the main-island box', () => {
  for (const g of grid) {
    assert.ok(g.lat > 21.89 && g.lat < 25.31 && g.lon > 120.0 && g.lon < 122.01, g.id + ' outside bbox');
    assert.ok(scenario.insideTaiwan(g.lat, g.lon), g.id + ' outside outline');
  }
});

test('grid: every point on land (Natural Earth 10m cross-check)', { skip: !onLand && 'world-atlas/topojson-client not installed' }, () => {
  for (const g of grid) assert.ok(onLand(g.lat, g.lon), g.id + ' is not on land');
});

test('grid: points are spread out (>= 5 km apart) and cover every region with rally candidates', () => {
  for (let i = 0; i < grid.length; i++) for (let j = i + 1; j < grid.length; j++) {
    assert.ok(havKm(grid[i], grid[j]) >= 5, grid[i].id + ' and ' + grid[j].id + ' are too close');
  }
  for (const r of REGIONS) {
    const n = grid.filter((g) => g.region === r && g.rallyCandidate).length;
    assert.ok(n >= 6, r + ' has only ' + n + ' rally candidates');
  }
  const kinds = {};
  for (const g of grid) kinds[g.kind] = (kinds[g.kind] || 0) + 1;
  assert.ok(kinds.town >= 10 && kinds.junction >= 8 && kinds.rally >= 12, JSON.stringify(kinds));
});

// ---- grid_links.json ----------------------------------------------------------------------------
test('links: reference real ids, valid road types, no self-loops or duplicates', () => {
  const ids = new Set(grid.map((g) => g.id));
  const seen = new Set();
  for (const l of links) {
    assert.ok(ids.has(l.a), 'unknown ' + l.a);
    assert.ok(ids.has(l.b), 'unknown ' + l.b);
    assert.notEqual(l.a, l.b);
    assert.ok(ROADS.includes(l.road), l.a + '-' + l.b + ' road ' + l.road);
    const k = [l.a, l.b].sort().join('|');
    assert.ok(!seen.has(k), 'duplicate link ' + k);
    seen.add(k);
  }
});

test('links: graph is connected, every point has a link, hubs have two or more', () => {
  const adj = new Map(grid.map((g) => [g.id, []]));
  for (const l of links) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  for (const [id, n] of adj) assert.ok(n.length >= 1, id + ' has no link');
  for (const g of grid.filter((p) => p.kind === 'hub')) assert.ok(adj.get(g.id).length >= 2, g.id + ' degree');
  const seen = new Set([grid[0].id]);
  const stack = [grid[0].id];
  while (stack.length) for (const n of adj.get(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  assert.equal(seen.size, grid.length, 'unreachable: ' + grid.filter((g) => !seen.has(g.id)).map((g) => g.id).join(', '));
});

test('links: no link longer than 80 km straight-line unless it is a mountain road', () => {
  const byId = new Map(grid.map((g) => [g.id, g]));
  for (const l of links) {
    const d = havKm(byId.get(l.a), byId.get(l.b));
    assert.ok(d < 80 || l.road === 'mountain', l.a + '-' + l.b + ' is ' + d.toFixed(1) + ' km');
  }
});

test('links: the Central Mountain Range is crossed only on real cross-island routes', () => {
  // East side = region 'east' plus the Yilan side of the Snow Mountains (north, east of 121.48 E, south of 24.95 N).
  const byId = new Map(grid.map((g) => [g.id, g]));
  const east = (g) => g.region === 'east' || (g.region === 'north' && g.lon > 121.48 && g.lat < 24.95);
  const allowed = new Set([
    'G-DAXI|G-QILAN',        // Hwy 7 Northern Cross-Island
    'G-LISHAN|G-QILAN',      // Hwy 7A
    'G-XIZHI|G-YILAN',       // Fwy 5 (Hsuehshan tunnel)
    'G-DAYULING|G-TIANXIANG', // Hwy 8 east of Dayuling (Hwy 14/14A from Puli)
    'G-CAOPU|G-DAREN'        // Hwy 9 South Link
    // Hwy 20 Southern Cross-Island is left out: its Meishan-Xiangyang section is not a primary,
    // truck-usable road in the road graph (roads_graph.json), so G-YAKOU / G-LIDAO were removed.
  ]);
  const crossings = links.filter((l) => east(byId.get(l.a)) !== east(byId.get(l.b))).map((l) => [l.a, l.b].sort().join('|'));
  for (const c of crossings) assert.ok(allowed.has(c), 'unexpected crossing ' + c);
  assert.ok(crossings.length >= 5, 'expected the cross-island routes to be present');
  // Mountain roads exist on every crossing corridor except the freeway tunnel and South Link.
  assert.ok(links.some((l) => l.road === 'mountain' && [l.a, l.b].includes('G-WULING')));
});

// ---- catalog.js ---------------------------------------------------------------------------------
test('catalog: classes in tie-break order with the label format', () => {
  assert.deepEqual(plain(catalog.classes.map((c) => c.id)), ['III', 'I', 'V', 'VIII', 'IX']);
  assert.deepEqual(plain(catalog.classes.map((c) => c.label)),
    ['Class III (Fuel)', 'Class I (Food & Water)', 'Class V (Ammunition)', 'Class VIII (Medical)', 'Class IX (Repair Parts)']);
  catalog.classes.forEach((c, i) => assert.equal(c.rank, i));
  assert.equal(H.classLabel('V'), 'Class V (Ammunition)');
  assert.equal(H.classRank('IX'), 4);
});

test('catalog: every item from the spec request form is present', () => {
  const expect = {
    III: ['diesel', 'gasoline', 'oil'],
    I: ['mre', 'water-bottled', 'water-bulk'],
    V: ['small-arms', 'grenades', 'mortar', 'at4'],
    VIII: ['cls-refill', 'ifak-refill', 'litters', 'med-kit'],
    IX: ['tires', 'batteries', 'filters', 'other-part']
  };
  for (const [cls, ids] of Object.entries(expect)) {
    assert.deepEqual(plain(H.itemsForClass(cls).map((it) => it.id)), ids, 'class ' + cls);
  }
  const optIds = (id) => H.itemById(id).options.map((o) => o.id);
  assert.ok(optIds('diesel').includes('JP-8'), 'diesel/JP-8');
  assert.ok(optIds('small-arms').length >= 3, 'small arms by caliber');
  assert.ok(optIds('mortar').length >= 3);
  assert.equal(H.itemById('other-part').freeText, true);
  assert.equal(H.itemById('other-part').options.length, 0);
  assert.equal(catalog.items.length, 18);
});

test('catalog: item fields, units, load groups and pallet conversions', () => {
  for (const it of catalog.items) {
    for (const k of ['id', 'classId', 'name', 'unit', 'loadGroup', 'palletsPerUnit', 'dailyUse', 'defaultQty', 'maxQty', 'step', 'options', 'optionLabel', 'freeText']) {
      assert.ok(k in it, it.id + ' missing ' + k);
    }
    assert.ok(catalog.units[it.unit], it.id + ' unit ' + it.unit);
    const fuel = it.id === 'diesel' || it.id === 'gasoline';
    assert.equal(it.loadGroup, fuel ? 'fuel' : 'cargo', it.id);
    if (fuel) assert.equal(it.unit, 'gal');
    const specs = it.freeText || !it.options.length ? [H.spec(it.id, null)] : it.options.map((o) => H.spec(it.id, o.id));
    for (const s of specs) {
      const label = it.id + (s.option ? ':' + s.option.id : '');
      if (fuel) assert.equal(s.palletsPerUnit, null, label);
      else assert.ok(s.palletsPerUnit > 0 && s.palletsPerUnit <= 1, label + ' palletsPerUnit');
      assert.ok(s.defaultQty > 0 && s.defaultQty <= s.maxQty, label + ' default/max');
      assert.ok(it.step > 0 && Math.abs(s.defaultQty / it.step - Math.round(s.defaultQty / it.step)) < 1e-9, label + ' default on step');
      if (s.dailyUse !== null) {
        assert.ok(s.dailyUse > 0, label + ' dailyUse');
        assert.ok(s.defaultQty <= 5 * s.dailyUse, label + ' default trips the 5x warning');
      }
      if (!fuel) assert.ok(s.maxQty * s.palletsPerUnit <= 10 + 1e-9, label + ' max is more than one cargo truck');
    }
  }
  assert.equal(H.itemById('water-bulk').loadGroup, 'cargo');
  assert.equal(H.itemById('oil').loadGroup, 'cargo');
  assert.equal(H.itemById('other-part').dailyUse, null);
  assert.equal(H.itemById('diesel').maxQty, 2500);
});

test('catalog: lineToLoad and requestLoads', () => {
  assert.deepEqual(plain(H.lineToLoad({ itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal' })), { group: 'fuel', qty: 500, unit: 'gal', exact: 500 });
  assert.deepEqual(plain(H.lineToLoad({ itemId: 'mre', option: 'mixed', qty: 48, unit: 'case' })), { group: 'cargo', qty: 1, unit: 'pallet', exact: 1 });
  assert.equal(H.lineToLoad({ itemId: 'mre', option: 'mixed', qty: 50 }).qty, 1.1);          // 1.0417 rounds up
  assert.equal(H.lineToLoad({ itemId: 'ifak-refill', option: 'standard', qty: 1 }).qty, 0.1);  // minimum one step
  assert.equal(H.lineToLoad({ itemId: 'water-bulk', option: 'blivet', qty: 1000 }).qty, 2);
  assert.equal(H.lineToLoad({ itemId: 'water-bulk', option: 'cans', qty: 360 }).qty, 2);
  assert.equal(H.lineToLoad({ itemId: 'tires', option: 'mrap', qty: 4 }).qty, 1);
  assert.equal(H.lineToLoad({ itemId: 'small-arms', option: '.50cal', qty: 2000 }).qty, 0.5);
  assert.equal(H.lineToLoad({ itemId: 'diesel', option: 'JP-8', qty: 0 }), null);
  assert.equal(H.lineToLoad({ itemId: 'nope', qty: 3 }), null);
  assert.equal(SRO.core.lineToLoad, H.lineToLoad);

  const loads = plain(H.requestLoads([
    { itemId: 'diesel', option: 'JP-8', qty: 400 },
    { itemId: 'mre', option: 'mixed', qty: 24 },          // 0.5 pallet
    { itemId: 'gasoline', option: 'MOGAS', qty: 50 },
    { itemId: 'ifak-refill', option: 'standard', qty: 15 } // 0.1 pallet
  ]));
  assert.deepEqual(loads.fuel, { qty: 450, unit: 'gal', lineIdxs: [0, 2] });
  assert.deepEqual(loads.cargo, { qty: 0.6, unit: 'pallet', exact: 0.6, lineIdxs: [1, 3] });
  assert.deepEqual(plain(H.requestLoads([{ itemId: 'diesel', option: 'DF-2', qty: 100 }])).cargo, null);
});

test('catalog: daily-use table and lookups agree with urgency.js', () => {
  const t = H.defaultDailyUse();
  assert.equal(t.diesel, 300);
  assert.equal(t['small-arms:.50cal'], 400);
  assert.ok(!('other-part' in t));
  const override = { diesel: 600, 'small-arms:5.56mm': 5000, 'small-arms': 1 };
  for (const it of catalog.items) {
    const opts = it.freeText ? ['anything'] : it.options.map((o) => o.id);
    for (const op of opts) {
      const line = { itemId: it.id, option: op };
      for (const table of [undefined, t, override]) {
        assert.equal(H.dailyUseFor(line, table), SRO.core.urgency.dailyUseFor(line, catalog, table), it.id + ':' + op);
      }
    }
  }
  assert.equal(H.dailyUseFor({ itemId: 'diesel', option: 'JP-8' }, override), 600);
  assert.equal(H.dailyUseFor({ itemId: 'small-arms', option: '5.56mm' }, override), 5000);
  assert.equal(H.dailyUseFor({ itemId: 'small-arms', option: '9mm' }, override), 150);   // option rate beats item key
});

// ---- scenario.js --------------------------------------------------------------------------------
test('scenario: hubs reference grid points and carry callsigns', () => {
  const hubs = plain(scenario.defaultHubs());
  assert.deepEqual(hubs.map((h) => [h.id, h.name, h.nation, h.callsign]), [
    ['HUB-GRANITE', 'FOB Granite', 'US', 'Alpha'],
    ['HUB-JADE', 'Base Jade', 'TW', 'Bravo'],
    ['HUB-ANVIL', 'FOB Anvil', 'US', 'Charlie'],
    ['HUB-LOTUS', 'Base Lotus', 'TW', 'Delta']
  ]);
  for (const h of hubs) {
    const g = grid.find((p) => p.id === h.gridId);
    assert.ok(g && g.kind === 'hub', h.id);
    assert.equal(h.lat, g.lat);
    assert.equal(h.lon, g.lon);
    const def = scenario.hubDefs.find((d) => d.id === h.id);
    assert.equal(def.lat, g.lat, 'fallback copy drifted from grid.json');
    assert.equal(def.lon, g.lon, 'fallback copy drifted from grid.json');
    assert.deepEqual(Object.keys(h).sort(), ['callsign', 'gridId', 'id', 'lat', 'lon', 'name', 'nation']);
  }
});

test('scenario: default fleet is 2 trucks per hub with colors and frequencies', () => {
  const fleet = plain(scenario.defaultFleet());
  assert.deepEqual(fleet.map((t) => t.id), ['Alpha-1', 'Alpha-2', 'Bravo-1', 'Bravo-2', 'Charlie-1', 'Charlie-2', 'Delta-1', 'Delta-2']);
  for (const t of fleet) {
    assert.deepEqual(Object.keys(t).sort(), ['availableAt', 'capacity', 'color', 'freq', 'hubId', 'id', 'status', 'type'].sort());
    if (t.id.endsWith('-1')) { assert.equal(t.type, 'tanker'); assert.equal(t.capacity, 2500); } else { assert.equal(t.type, 'cargo'); assert.equal(t.capacity, 10); }
    assert.match(t.freq, /^\d{2}\.\d{3}$/);
    assert.ok(+t.freq >= 30 && +t.freq <= 87.975);
    assert.equal(t.status, 'available');
    assert.ok(scenario.defaultHubs().some((h) => h.id === t.hubId && t.id.startsWith(h.callsign + '-')));
  }
  assert.equal(new Set(fleet.map((t) => t.color)).size, 8);
  assert.equal(new Set(fleet.map((t) => t.freq)).size, 8);
});

test('scenario: 8 truck colors readable on dark and light backgrounds and distinct', () => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const L = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const lab = (h) => {
    const [r, g, b] = rgb(h).map(lin);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const cols = scenario.truckColors.map((c) => c.hex);
  assert.equal(cols.length, 8);
  for (const c of cols) {
    assert.match(c, /^#[0-9A-F]{6}$/i);
    assert.ok(contrast(c, '#000000') >= 3, c + ' on black');
    assert.ok(contrast(c, '#121212') >= 3, c + ' on dark gray');
    assert.ok(contrast(c, '#FFFFFF') >= 3, c + ' on white');
  }
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    const a = lab(cols[i]), b = lab(cols[j]);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 20, cols[i] + ' vs ' + cols[j]);
  }
  assert.equal(scenario.truckColor(8), cols[0]);
});

test('scenario: settings match DESIGN.md section 3', () => {
  const s = plain(scenario.defaultSettings());
  const dailyUse = s.dailyUse;
  delete s.dailyUse;
  assert.deepEqual(s, {
    method: 'tabu', timeLimitSec: 300,
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    maxRallyPoints: 8, maxStops: 20,
    etaSlipPerMin: 1,          // re-plan ETA stability (solver fix 2026-10-06; DESIGN.md section 3 to list it)
    convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
    periods: [
      { name: 'Day', start: '0700', end: '1800', speed: 1.0, risk: 1.0 },
      { name: 'Dusk', start: '1800', end: '1930', speed: 0.9, risk: 1.2 },
      { name: 'Night', start: '1930', end: '0530', speed: 0.7, risk: 0.8 },
      { name: 'Dawn', start: '0530', end: '0700', speed: 0.9, risk: 1.2 }
    ],
    riskRatings: { Low: 1, Medium: 3, High: 6 },
    mobility: { mounted: { radiusMi: 50, costPerMi: 0.5 }, dismounted: { radiusMi: 5, costPerMi: 4 } },
    methodParams: { tabu: null, sa: null, aco: null, mip: null },
    sampleSeed: 20261005
  });
  assert.deepEqual(dailyUse, plain(H.defaultDailyUse()));
  const fixed = scenario.mobilityModes.find((m) => m.id === 'fixed');
  assert.equal(fixed.directOnly, true);
});

test('scenario: defaultState is complete, empty and fresh each call', () => {
  const a = scenario.defaultState();
  const s = plain(a);
  assert.deepEqual(Object.keys(s), ['version', 'ui', 'clock', 'profile', 'scenario', 'requests', 'windows', 'plans', 'snapshots', 'roadCache']);
  assert.equal(s.version, 1);
  assert.deepEqual(s.ui, { role: 'psg', theme: 'dark', plannerTab: 'queue' });
  assert.deepEqual(s.clock, { simMin: 360, running: false, speed: 1 });
  assert.equal(s.profile, null);
  assert.deepEqual(Object.keys(s.scenario), ['hubs', 'fleet', 'zones', 'rally', 'settings']);
  assert.equal(s.scenario.hubs.length, 4);
  assert.equal(s.scenario.fleet.length, 8);
  assert.deepEqual(s.scenario.zones, []);
  assert.deepEqual(s.scenario.rally, { pinned: [], banned: [] });
  assert.deepEqual(s.requests, []);
  assert.deepEqual(s.windows, [{ id: 'W-001', start: 360, end: 720, status: 'open', planIds: [], approvedPlanId: null }]);
  assert.deepEqual(s.plans, []);
  assert.deepEqual(s.snapshots, []);
  assert.deepEqual(s.roadCache, {});
  a.scenario.fleet.pop();
  a.scenario.settings.weights.fuel = 9;
  a.scenario.hubs[0].lat = 0;
  const b = plain(scenario.defaultState());
  assert.equal(b.scenario.fleet.length, 8);
  assert.equal(b.scenario.settings.weights.fuel, 3);
  assert.notEqual(b.scenario.hubs[0].lat, 0);
  assert.equal(scenario.periods.length, 4);
});

test('scenario: sample unit names are real-format, fictional, varied', () => {
  const names = scenario.unitNames;
  assert.ok(names.length >= 25 && names.length <= 40, 'pool size ' + names.length);
  assert.equal(new Set(names).size, names.length);
  const re = /^(\d)(st|nd|rd|th) PLT, ([A-D]) (CO|TRP), (\d-\d{2}) (IN|AR|CAV)$/;
  const bns = new Set();
  for (const n of names) { const m = re.exec(n); assert.ok(m, n); bns.add(m[5] + ' ' + m[6]); }
  assert.ok(bns.size >= 6, 'battalions ' + bns.size);
  assert.equal(scenario.designatorFor('1st PLT, B CO, 3-21 IN'), '1/B/3-21IN');
  assert.equal(scenario.designatorFor('2nd PLT, A TRP, 4-98 CAV'), '2/A/4-98CAV');
});

test('scenario: insideTaiwan outline accepts the main island and rejects the outer islands and sea', () => {
  const yes = [[25.04, 121.51], [24.15, 120.68], [22.63, 120.30], [23.98, 121.59], [22.0, 120.74], [23.5, 121.0]];
  const no = [[23.57, 119.58], [24.45, 118.38], [26.16, 119.95], [22.66, 121.49], [22.05, 121.55], [22.34, 120.37], [24.84, 121.95], [23.5, 119.9], [23.0, 121.8], [0, 0]];
  for (const [la, lo] of yes) assert.ok(scenario.insideTaiwan(la, lo), la + ',' + lo);
  for (const [la, lo] of no) assert.ok(!scenario.insideTaiwan(la, lo), la + ',' + lo);
  assert.equal(scenario.insideTaiwan(NaN, 121), false);
  if (onLand) {
    // the outline is a little generous, never tighter than the coast
    for (let la = 21.9; la <= 25.3; la += 0.05) for (let lo = 120.0; lo <= 122.0; lo += 0.05) {
      if (onLand(la, lo) && la > 21.95) assert.ok(scenario.insideTaiwan(la, lo), 'land point outside outline ' + la.toFixed(2) + ',' + lo.toFixed(2));
    }
  }
});
