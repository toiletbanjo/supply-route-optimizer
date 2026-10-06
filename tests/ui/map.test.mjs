// Node tests for the DOM-free parts of src/ui/map.js and src/ui/symbols.js (the Playwright checks are in
// tests/ui/map.spec.mjs). Both files must load without Leaflet, milsymbol or a document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const SRO = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/data/grid.json', 'src/data/roads_graph.json',
  'src/data/scenario.js', 'src/core/geo.js', 'src/core/road_router.js', 'src/core/roads.js', 'src/ui/symbols.js', 'src/ui/map.js']);
const M = SRO.ui.map, S = SRO.ui.symbols, R = SRO.core.roads;
const gp = (id) => SRO.data.grid.find((g) => g.id === id);

function timedRoute() {
  const hub = gp('G-JADE'), a = gp('G-TAICHUNG'), b = gp('G-PULI');
  const legs = R.tour([hub, a, b, hub]).map((r) => ({ coords: r.coords, minutes: r.minutes }));
  let t = 400;
  legs.forEach((l, i) => { l.depart = t; l.arrive = t + Math.round(l.minutes * 1.5); t = l.arrive + (i < legs.length - 1 ? 15 : 0); });
  return { truckId: 'Bravo-2', depart: legs[0].depart, returnAt: t, legs };
}

test('map.js and symbols.js load without a DOM', () => {
  assert.equal(typeof M.create, 'function');
  assert.equal(typeof M.truckPosition, 'function');
  assert.equal(typeof S.platoon, 'function');
  assert.throws(() => S.platoon({}), /Leaflet|milsymbol/);
});

test('truckPosition walks the timed legs', () => {
  const r = timedRoute();
  const L0 = r.legs[0], L1 = r.legs[1], last = r.legs[r.legs.length - 1];
  const before = M.truckPosition(r, L0.depart - 10);
  assert.equal(before.status, 'at-hub');
  assert.equal(before.legIndex, -1);
  assert.ok(R.haversineM(before, gp('G-JADE')) < 1);

  const mid = M.truckPosition(r, (L0.depart + L0.arrive) / 2);
  assert.equal(mid.status, 'en-route');
  assert.equal(mid.legIndex, 0);
  assert.ok(mid.heading >= 0 && mid.heading < 360);
  const snap = R.snap(mid);
  assert.ok(snap.meters < 30, 'on the road, ' + snap.meters + ' m');

  const atStop = M.truckPosition(r, L0.arrive + 5);
  assert.equal(atStop.status, 'at-stop');
  assert.equal(atStop.legIndex, 0);
  assert.ok(R.haversineM(atStop, gp('G-TAICHUNG')) < 1);

  const second = M.truckPosition(r, L1.depart + 1);
  assert.equal(second.status, 'en-route');
  assert.equal(second.legIndex, 1);

  const done = M.truckPosition(r, last.arrive + 30);
  assert.equal(done.status, 'returned');
  assert.equal(done.legIndex, r.legs.length - 1);

  // monotone progress along a leg: later time, farther from the start
  const p1 = M.truckPosition(r, L0.depart + 2), p2 = M.truckPosition(r, L0.arrive - 2);
  assert.ok(R.haversineM(p2, gp('G-TAICHUNG')) < R.haversineM(p1, gp('G-TAICHUNG')));
});

test('truckPosition: route ending away from its start stays at-stop; bad input gives null', () => {
  const a = gp('G-ANVIL'), b = gp('G-KAOHSIUNG');
  const leg = R.route(a, b);
  const r = { legs: [{ coords: leg.coords, depart: 100, arrive: 130 }] };
  assert.equal(M.truckPosition(r, 200).status, 'at-stop');
  assert.equal(M.truckPosition({ legs: [] }, 100), null);
  assert.equal(M.truckPosition(null, 100), null);
  assert.equal(M.truckPosition(r, NaN), null, 'no clock -> no position (review fix)');
  assert.equal(M.truckPosition(r, undefined), null);
  const viaFromTo = { legs: [{ from: a, to: b, depart: 0, arrive: 10 }] };
  assert.equal(M.truckPosition(viaFromTo, 5).status, 'en-route');
});

test('platoon SIDC follows mobility and branch', () => {
  assert.equal(S.platoonSidc({ mobility: 'dismounted' }), S.SIDC.dismounted);
  assert.equal(S.platoonSidc({ mobility: 'mounted', designator: '1/B/3-21IN' }), S.SIDC.motorized);
  assert.equal(S.platoonSidc({ mobility: 'mounted', vehicle: 'tracked', designator: '1/B/3-21IN' }), S.SIDC.mechanized);
  // the branch picks the 2525D entity (armor, reconnaissance / cavalry, engineer, field artillery),
  // whether the platoon is mounted, dismounted or fixed today
  assert.equal(S.platoonSidc({ mobility: 'mounted', designator: '1/A/5-86AR' }), S.SIDC.armor);
  assert.equal(S.SIDC.armor, '10031000141205000000');
  assert.equal(S.platoonSidc({ mobility: 'mounted', unitName: '2nd PLT, B TRP, 4-98 CAV' }), S.SIDC.cavalry);
  assert.equal(S.platoonSidc({ mobility: 'dismounted', unitName: '2nd PLT, B TRP, 4-98 CAV' }), '10031000141213000000');
  assert.equal(S.platoonSidc({ mobility: 'mounted', designator: '3/C/2-12EN' }), '10031000141407000000');
  assert.equal(S.platoonSidc({ mobility: 'fixed', designator: '1/A/3-20FA' }), '10031000141303000000');
  assert.equal(S.branchOf({ designator: '1/B/3-21IN' }), 'IN');
  assert.equal(S.branchOf({ unitName: 'Support platoon' }), null);
  assert.equal(S.platoonSidc({ mobility: 'fixed' }), S.SIDC.dismounted);
  assert.equal(S.platoonSidc({ mobility: 'fixed', baseMobility: 'mounted', designator: '1/B/3-21IN' }), S.SIDC.motorized);
  assert.equal(S.shortCallsign('Charlie-2'), 'C-2');
});

test('urgency ring colors are distinct in every theme', () => {
  for (const theme of ['dark', 'light', 'night']) {
    const c = S.URGENCY.map((u) => S.urgencyColor(u, theme));
    assert.equal(new Set(c).size, 4, theme);
  }
  assert.ok(!Object.values(S.URGENCY_COLORS.night).some((c) => /^#f{3,6}$/i.test(c)), 'no white at night');
});

test('truck label text picks the readable color for every truck color (review fix)', () => {
  const palettes = [SRO.data.scenario.truckColors.map((c) => c.hex),
    ['#4C9AFF', '#F5A623', '#36B37E', '#E55BB0', '#00B8D9', '#FF7452', '#C9B400', '#9F7AEA']];   // store.TRUCK_COLORS
  for (const hex of palettes.flat()) {
    const fg = S.textOn(hex);
    const other = fg === '#ffffff' ? '#0b1014' : '#ffffff';
    assert.ok(S.contrast(hex, fg) >= S.contrast(hex, other), hex);
    assert.ok(S.contrast(hex, fg) >= 4.3, hex + ' label contrast ' + S.contrast(hex, fg).toFixed(2));
  }
  assert.equal(S.clip('FORWARD OPERATING BASE EXTREMELY LONG', 22).length, 22);
  assert.ok(S.clip('FORWARD OPERATING BASE EXTREMELY LONG', 22).endsWith('…'));
  assert.equal(S.clip('1/B/3-21IN', 16), '1/B/3-21IN');
});
