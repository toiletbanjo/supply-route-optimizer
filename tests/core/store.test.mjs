import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadScripts, wrapSource, ROOT } from '../load.mjs';

const FILES = ['src/core/ns.js', 'src/core/util.js', 'src/core/geo.js', 'src/core/clock.js', 'src/core/store.js'];
const SRO = loadScripts(FILES);
const S = SRO.core.store;
const plain = (x) => JSON.parse(JSON.stringify(x, SRO.util.jsonReplacer), SRO.util.jsonReviver);

// ---- stub scenario (scenario.js is written by another module) -----------------------------
function stubDefaultState() {
  return {
    version: 1,
    ui: { role: 'psg', theme: 'dark', plannerTab: 'queue' },
    clock: { simMin: 360, running: false, speed: 60 },
    profile: null,
    scenario: {
      hubs: [
        { id: 'HUB-GRANITE', name: 'FOB Granite', nation: 'US', gridId: 'G1', lat: 25.0, lon: 121.5, callsign: 'Alpha' },
        { id: 'HUB-JADE', name: 'Base Jade', nation: 'TW', gridId: 'G2', lat: 24.15, lon: 120.67, callsign: 'Bravo' }
      ],
      fleet: [
        { id: 'Alpha-1', hubId: 'HUB-GRANITE', type: 'tanker', capacity: 2500, color: '#4C9AFF', freq: '45.250', status: 'available', availableAt: 0 },
        { id: 'Alpha-2', hubId: 'HUB-GRANITE', type: 'cargo', capacity: 10, color: '#F5A623', freq: '45.250', status: 'available', availableAt: 0 }
      ],
      zones: [],
      rally: { pinned: [], banned: [] },
      settings: {
        method: 'tabu', timeLimitSec: 300,
        weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
        maxRallyPoints: 8, maxStops: 20, convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
        periods: [{ name: 'Day', start: '0700', end: '1800', speed: 1, risk: 1 }],
        riskRatings: { Low: 1, Medium: 3, High: 6 },
        mobility: { mounted: { radiusMi: 50, costPerMi: 0.5 }, dismounted: { radiusMi: 5, costPerMi: 4 } },
        dailyUse: {},
        methodParams: { tabu: { iterations: 4000, tenure: 12 }, sa: { coolingRate: 0.995 }, aco: { ants: 20 }, mip: { mipGap: 0.01 } },
        sampleSeed: 20261005
      }
    },
    requests: [], windows: [], plans: [], snapshots: [], roadCache: {}
  };
}
SRO.data.scenario = { defaultState: stubDefaultState };
SRO.data.grid = [
  { id: 'G1', lat: 25.0, lon: 121.5 }, { id: 'G2', lat: 24.15, lon: 120.67 }, { id: 'G3', lat: 23.0, lon: 120.2 }
];

const mk = (opts = {}) => S.createStore({ adapter: S.MemoryAdapter(), ...opts });
const req = (over = {}) => ({
  unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN', lat: 24.1, lon: 120.7, gridId: 'G2',
  mobility: 'mounted',
  lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null }],
  urgencyRequested: 'Priority', nlt: 1200, remarks: '', ...over
});
function samplePlan(over = {}) {
  return {
    id: 'P-0001', windowId: 'W-D1-0600', name: 'Tabu run', method: 'tabu', createdAt: 400, runtimeSec: 3.2, mipGap: null, cancelled: false,
    parentPlanId: null, rallyPoints: ['G2'],
    routes: [{
      truckId: 'Alpha-1', type: 'tanker', color: '#4C9AFF', loadStart: 400, depart: 420, returnAt: 700,
      stops: [
        { seq: 1, nodeKey: 'rally:G2', kind: 'rally', gridId: 'G2', lat: 24.15, lon: 120.67, label: 'G2', arrive: 500, depart: 515, period: 'Day',
          deliveries: [{ requestId: 'R-0001', lineIdx: 0, qty: 300, unit: 'gal', classId: 'III' }, { requestId: 'R-0002', lineIdx: 0, qty: 100, unit: 'gal', classId: 'III' }], pickups: [] },
        { seq: 2, nodeKey: 'rally:G3', kind: 'rally', gridId: 'G3', lat: 23.0, lon: 120.2, label: 'G3', arrive: 560, depart: 575, period: 'Day',
          deliveries: [{ requestId: 'R-0001', lineIdx: 0, qty: 200, unit: 'gal', classId: 'III' }], pickups: [] }
      ],
      legs: [{ fromKey: 'hub', toKey: 'rally:G2', gridPath: ['G1', 'G2'], depart: 420, arrive: 500, miles: 80, riskUnits: 0, period: 'Day' }],
      miles: 160, gallons: 80, riskUnits: 0, cost: { fuel: 240, distance: 240, risk: 0, simplicity: 70, platoon: 0, lateness: 0 }
    }, {
      truckId: 'Alpha-2', type: 'cargo', color: '#F5A623', loadStart: 400, depart: 420, returnAt: 420, stops: [], legs: [], miles: 0, gallons: 0, riskUnits: 0, cost: {}
    }],
    deferred: [{ requestId: 'R-0002', lineIdx: 0, qty: 50, unit: 'gal', reason: 'capacity', note: '' }, { requestId: 'R-0003', lineIdx: 0, qty: 10, unit: 'gal', reason: 'time', note: '' }],
    late: [], cost: { total: 550, fuel: 240, distance: 240, risk: 0, simplicity: 70, platoon: 0, lateness: 0, deferral: 0, worstCase: Infinity },
    stats: { requests: 3, stops: 2, trucksUsed: 1, miles: 160, gallons: 80, riskUnits: 0, late: 0, delayed: 2, runtimeSec: 3.2 },
    approved: false,
    ...over
  };
}
function storeWithThreeRequests() {
  const st = mk();
  st.dispatch({ type: 'request/submit', request: req() });
  st.dispatch({ type: 'request/submit', payload: req({ unitName: '2nd PLT, B CO, 3-21 IN' }) });
  st.dispatch({ type: 'request/submit', payload: { request: req({ unitName: '3rd PLT, B CO, 3-21 IN', mobility: 'dismounted' }) } });
  return st;
}

// ---- tests ---------------------------------------------------------------------------------
test('every action in DESIGN.md section 3 is implemented', () => {
  const design = fs.readFileSync(path.join(ROOT, 'docs/DESIGN.md'), 'utf8');
  const line = design.split('\n').find((l) => l.startsWith('`role/set`'));
  const listed = [...line.matchAll(/`([a-z]+\/[A-Za-z]+)`/g)].map((m) => m[1]);
  assert.ok(listed.length >= 30, 'found the action list');
  for (const a of listed) assert.ok(S.ACTIONS.includes(a), 'missing action ' + a);
});

test('default state comes from SRO.data.scenario.defaultState() with skeleton fill-ins', () => {
  const st = mk();
  const s = st.getState();
  assert.equal(s.version, 1);
  assert.equal(s.clock.simMin, 360);
  assert.equal(s.clock.running, false);
  assert.equal(s.scenario.fleet.length, 2);
  assert.equal(s.ui.planRequested, false);          // filled from the skeleton
  assert.equal(s.ui.psgTab, 'request');
  // without a scenario module the skeleton alone works
  const saved = SRO.data.scenario;
  delete SRO.data.scenario;
  try {
    const s2 = S.defaultState();
    assert.equal(s2.scenario.settings.weights.risk, 5);
    assert.deepEqual(plain(s2.requests), []);
  } finally { SRO.data.scenario = saved; }
});

test('seeded window ids (e.g. W-001) are renamed to the clock format with their references', () => {
  const saved = SRO.data.scenario;
  SRO.data.scenario = {
    defaultState: () => ({ ...stubDefaultState(), windows: [{ id: 'W-001', start: 360, end: 720, status: 'open', planIds: [], approvedPlanId: null }] })
  };
  try {
    const st = mk();
    assert.deepEqual(st.getState().windows.map((w) => w.id), ['W-D1-0600']);
    st.dispatch({ type: 'request/submit', request: req() });
    assert.equal(st.getState().windows.length, 1, 'no duplicate window for the same span');
    assert.equal(st.getState().requests[0].windowId, 'W-D1-0600');
    // loaded data with old ids: requests and plans follow the rename
    const old = { ...stubDefaultState(), windows: [{ id: 'W-002', start: 720, end: 1080, status: 'planned', planIds: ['P-1'], approvedPlanId: null }],
      requests: [{ id: 'R-0001', windowId: 'W-002', status: 'planned' }], plans: [{ id: 'P-1', windowId: 'W-002', routes: [], deferred: [] }] };
    const st2 = mk({ adapter: S.MemoryAdapter(old) });
    const s2 = st2.getState();
    assert.equal(s2.windows[0].id, 'W-D1-1200');
    assert.equal(s2.requests[0].windowId, 'W-D1-1200');
    assert.equal(s2.plans[0].windowId, 'W-D1-1200');
  } finally { SRO.data.scenario = saved; }
});

test('ui actions: role, theme, tab (both action shapes); bad values are refused', () => {
  const st = mk();
  assert.equal(st.dispatch({ type: 'role/set', role: 'planner' }).ok, true);
  assert.equal(st.getState().ui.role, 'planner');
  st.dispatch({ type: 'role/set', payload: 'psg' });
  assert.equal(st.getState().ui.role, 'psg');
  st.dispatch({ type: 'theme/set', payload: { theme: 'night' } });
  assert.equal(st.getState().ui.theme, 'night');
  st.dispatch({ type: 'tab/set', tab: 'scenario' });
  assert.equal(st.getState().ui.plannerTab, 'scenario');
  st.dispatch({ type: 'tab/set', role: 'psg', tab: 'myrequests' });
  assert.equal(st.getState().ui.psgTab, 'myrequests');
  const before = st.getState();
  const r = st.dispatch({ type: 'role/set', role: 'admin' });
  assert.equal(r.ok, false);
  assert.match(r.error, /psg|planner/);
  assert.equal(st.getState(), before, 'state unchanged on error');
  assert.equal(st.dispatch({ type: 'theme/set', theme: 'pink' }).ok, false);
  assert.equal(st.dispatch({ type: 'tab/set', tab: 'nowhere' }).ok, false);
  assert.equal(st.dispatch({ type: 'no/such' }).ok, false);
  assert.equal(st.dispatch({}).ok, false);
});

test('clock actions', () => {
  const st = mk();
  st.dispatch({ type: 'clock/start' });
  assert.equal(st.getState().clock.running, true);
  st.dispatch({ type: 'clock/speed', speed: 600 });
  assert.equal(st.getState().clock.speed, 600);
  assert.equal(st.dispatch({ type: 'clock/speed', speed: 0 }).ok, false);
  st.dispatch({ type: 'clock/tick', simMin: 400.5 });
  assert.equal(st.getState().clock.simMin, 400.5);
  st.dispatch({ type: 'clock/tick', elapsedMs: 6000 });       // 6 s at 600x = 60 min
  assert.equal(st.getState().clock.simMin, 460.5);
  st.dispatch({ type: 'clock/pause' });
  assert.equal(st.getState().clock.running, false);
  assert.equal(st.dispatch({ type: 'clock/tick' }).ok, false);
});

test('profile/save merges; null clears', () => {
  const st = mk();
  st.dispatch({ type: 'profile/save', profile: { unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN', lat: 24.1, lon: 120.7, gridId: 'G2', mobility: 'dismounted' } });
  assert.equal(st.getState().profile.mobility, 'dismounted');
  st.dispatch({ type: 'profile/save', payload: { lat: 24.2, lon: 120.8 } });
  assert.equal(st.getState().profile.lat, 24.2);
  assert.equal(st.getState().profile.designator, '1/B/3-21IN');
  st.dispatch({ type: 'profile/save', profile: null });
  assert.equal(st.getState().profile, null);
});

test('request/submit assigns ids, status, window and defaults', () => {
  const st = storeWithThreeRequests();
  const s = st.getState();
  assert.deepEqual(s.requests.map((r) => r.id), ['R-0001', 'R-0002', 'R-0003']);
  const r = s.requests[0];
  assert.equal(r.status, 'submitted');
  assert.equal(r.source, 'user');
  assert.equal(r.createdAt, 360);
  assert.equal(r.windowId, 'W-D1-0600');
  assert.equal(r.urgency, 'Priority');           // copied from urgencyRequested
  assert.equal(r.deadline, 1200);                // = nlt
  assert.equal(r.maxTravelMi, 50);               // mounted radius
  assert.deepEqual(plain(r.locks), { truckId: null, forceDirect: false });
  assert.equal(r.updated, false);
  assert.equal(s.requests[2].maxTravelMi, 5);    // dismounted radius
  assert.deepEqual(plain(s.windows), [{ id: 'W-D1-0600', start: 360, end: 720, status: 'open', planIds: [], approvedPlanId: null }]);
  // time comes from the clock (floored), or the payload
  st.dispatch({ type: 'clock/tick', simMin: 731.7 });
  const res = st.dispatch({ type: 'request/submit', request: req({ mobility: 'fixed', gridId: null }) });
  assert.equal(res.ok, true);
  assert.equal(res.id, 'R-0004');
  const r4 = st.getState().requests[3];
  assert.equal(r4.createdAt, 731);
  assert.equal(r4.windowId, 'W-D1-1200');
  assert.equal(r4.directOnly, true);             // fixed in place = direct delivery
  assert.equal(r4.maxTravelMi, 0);
  assert.equal(r4.gridId, 'G2');                 // snapped to the nearest grid point
  assert.equal(st.getState().windows.length, 2);
  // caller-supplied status/id are ignored; the caller's object is not aliased
  const input = req({ id: 'X', status: 'delivered' });
  st.dispatch({ type: 'request/submit', request: input });
  const r5 = st.getState().requests[4];
  assert.equal(r5.id, 'R-0005');
  assert.equal(r5.status, 'submitted');
  input.lines[0].qty = 1;
  assert.equal(r5.lines[0].qty, 500);
  assert.equal(st.dispatch({ type: 'request/submit' }).ok, false);
});

test('request/edit and request/cancel only before the plan is approved', () => {
  const st = storeWithThreeRequests();
  let r = st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { remarks: 'gate code 7', nlt: 1100 } });
  assert.equal(r.ok, true);
  let r1 = st.getState().requests[0];
  assert.equal(r1.remarks, 'gate code 7');
  assert.equal(r1.nlt, 1100);
  assert.equal(r1.deadline, 1100);
  assert.equal(r1.id, 'R-0001');
  // protected fields stay put
  st.dispatch({ type: 'request/edit', payload: { id: 'R-0001', changes: { status: 'delivered', id: 'R-9' } } });
  assert.equal(st.getState().requests[0].status, 'submitted');
  // a draft plan does not lock edits, but editing sends the request back to 'submitted'
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  assert.equal(st.getState().requests[0].status, 'planned');
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { remarks: 'x' } });
  assert.equal(st.getState().requests[0].status, 'submitted');
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'plan/approve', planId: 'P-0001' });
  r1 = st.getState().requests[0];
  assert.equal(r1.status, 'approved');
  r = st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { remarks: 'too late' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /approved/);
  assert.equal(st.dispatch({ type: 'request/cancel', id: 'R-0001' }).ok, false);
  // R-0003 was deferred (delayed): still not in an approved delivery, so it can be cancelled
  r = st.dispatch({ type: 'request/cancel', id: 'R-0003', now: 777 });
  assert.equal(r.ok, true);
  const r3 = st.getState().requests[2];
  assert.equal(r3.status, 'cancelled');
  assert.equal(r3.cancelledAt, 777);
  assert.equal(st.dispatch({ type: 'request/cancel', id: 'R-0003' }).ok, false);
  assert.equal(st.dispatch({ type: 'request/edit', id: 'R-0404', changes: {} }).ok, false);
});

test('samples/load adds sample requests and replaces earlier unplanned samples', () => {
  const st = mk();
  st.dispatch({ type: 'request/submit', request: req() });
  const res = st.dispatch({ type: 'samples/load', requests: [req({ unitName: 'S1' }), req({ unitName: 'S2', createdAt: 300 })] });
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.ids), ['R-0002', 'R-0003']);
  let s = st.getState();
  assert.equal(s.requests.length, 3);
  assert.equal(s.requests[1].source, 'sample');
  assert.equal(s.requests[2].createdAt, 300);
  // A back-dated sample joins the window open when it is loaded (0600), not the closed 0000
  // window its createdAt falls in, so the demo batch (user request + samples) shares one window.
  assert.equal(s.requests[2].windowId, 'W-D1-0600');
  st.dispatch({ type: 'samples/load', payload: [req({ unitName: 'S3' })] });
  s = st.getState();
  assert.deepEqual(s.requests.map((r) => r.unitName), ['1st PLT, B CO, 3-21 IN', 'S3']);
  assert.equal(s.requests[1].id, 'R-0004', 'ids are never reused');
  st.dispatch({ type: 'samples/load', requests: [req({ unitName: 'S4' })], replace: false });
  assert.equal(st.getState().requests.length, 3);
  // generator hook
  assert.equal(st.dispatch({ type: 'samples/load' }).ok, false);
  const calls = [];
  SRO.core.samples = { generate: (seed, ctx) => { calls.push([seed, ctx]); return Array.from({ length: ctx.count }, (_, i) => req({ unitName: 'Gen ' + i })); } };
  try {
    st.dispatch({ type: 'profile/save', profile: { unitName: '1st PLT, B CO, 3-21 IN' } });
    const r2 = st.dispatch({ type: 'samples/load' });
    assert.equal(r2.ok, true);
    assert.equal(r2.ids.length, 19);
    const [seed, ctx] = calls[0];
    assert.equal(seed, 20261005, 'settings.sampleSeed');
    assert.equal(ctx.nowMin, 360);
    assert.equal(ctx.windowId, 'W-D1-0600');
    assert.deepEqual(Array.from(ctx.excludeUnitNames), ['1st PLT, B CO, 3-21 IN']);
    assert.ok(ctx.existingIds.includes('R-0001'));
    assert.equal(ctx.mobility.dismounted.radiusMi, 5);
    st.dispatch({ type: 'samples/load', seed: 7, count: 3 });
    assert.equal(calls[1][0], 7);
    assert.equal(calls[1][1].count, 3);
  } finally { delete SRO.core.samples; }
});

test('window/planNow marks intent; plan/store stores drafts and clears it', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'window/planNow' });
  let s = st.getState();
  assert.equal(s.ui.planRequested, true);
  assert.equal(s.ui.planRequestReason, 'manual');
  assert.equal(s.ui.planRequestedAt, 360);
  const res = st.dispatch({ type: 'plan/store', plan: samplePlan({ approved: true }) });
  assert.equal(res.id, 'P-0001');
  s = st.getState();
  assert.equal(s.ui.planRequested, false);
  assert.equal(s.ui.lastPlanId, 'P-0001');
  assert.equal(s.plans.length, 1);
  assert.equal(s.plans[0].approved, false, 'storing never approves');
  assert.deepEqual(s.requests.map((r) => r.status), ['planned', 'planned', 'submitted']);
  assert.deepEqual(plain(s.windows[0]), { id: 'W-D1-0600', start: 360, end: 720, status: 'planned', planIds: ['P-0001'], approvedPlanId: null });
  // compare mode: a second plan in the same window; same id replaces
  st.dispatch({ type: 'plan/store', plan: samplePlan({ id: 'P-0002', method: 'sa' }) });
  st.dispatch({ type: 'plan/store', plan: samplePlan({ id: 'P-0002', method: 'aco' }) });
  s = st.getState();
  assert.equal(s.plans.length, 2);
  assert.equal(s.plans[1].method, 'aco');
  assert.deepEqual(Array.from(s.windows[0].planIds), ['P-0001', 'P-0002']);
  // a plan without id or window gets them
  const r2 = st.dispatch({ type: 'plan/store', plan: { routes: [], deferred: [] } });
  assert.equal(r2.id, 'P-0003');
  assert.equal(st.getState().plans[2].windowId, 'W-D1-0600');
  // Infinity survives the store's own cloning
  assert.equal(st.getState().plans[0].cost.worstCase, Infinity);
});

test('plan/approve sets statuses, sends trucks out and closes the window', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  const res = st.dispatch({ type: 'plan/approve', planId: 'P-0001', now: 410 });
  assert.equal(res.ok, true);
  const s = st.getState();
  assert.equal(s.plans[0].approved, true);
  assert.equal(s.plans[0].approvedAt, 410);
  const [r1, r2, r3] = s.requests;
  assert.equal(r1.status, 'approved');
  assert.equal(r1.eta, 500);                      // first arrival
  assert.equal(r2.status, 'partial');             // delivered 100, 50 deferred
  assert.equal(r3.status, 'delayed');             // only deferred
  const a1 = s.scenario.fleet.find((t) => t.id === 'Alpha-1');
  const a2 = s.scenario.fleet.find((t) => t.id === 'Alpha-2');
  assert.equal(a1.status, 'en_route');
  assert.equal(a1.availableAt, 700);
  assert.equal(a2.status, 'available', 'a truck with no stops is not used');
  assert.equal(s.windows[0].status, 'approved');
  assert.equal(s.windows[0].approvedPlanId, 'P-0001');
  // idempotent
  assert.equal(st.dispatch({ type: 'plan/approve', planId: 'P-0001' }).ok, true);
  assert.equal(st.dispatch({ type: 'plan/approve', planId: 'P-0404' }).ok, false);
});

test('clock ticks drive en route / delivered, truck return and window boundaries', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'plan/approve', planId: 'P-0001' });
  st.dispatch({ type: 'clock/tick', simMin: 419 });
  assert.equal(st.getState().requests[0].status, 'approved');
  st.dispatch({ type: 'clock/tick', simMin: 420 });
  assert.equal(st.getState().requests[0].status, 'en_route');
  st.dispatch({ type: 'clock/tick', simMin: 520 });
  assert.equal(st.getState().requests[0].status, 'en_route', 'second stop still ahead');
  assert.equal(st.getState().requests[1].status, 'partial', 'partial stays partial');
  st.dispatch({ type: 'clock/tick', simMin: 560 });
  assert.equal(st.getState().requests[0].status, 'delivered');
  assert.equal(st.getState().requests[0].deliveredAt, 560);
  assert.equal(st.getState().scenario.fleet[0].status, 'en_route');
  assert.equal(st.getState().ui.planRequested, false);
  // crossing 1200 with a deferred request waiting asks for a plan
  const res = st.dispatch({ type: 'clock/tick', simMin: 701 });
  assert.deepEqual(Array.from(res.crossed), []);
  assert.equal(st.getState().ui.planRequested, false);
  assert.equal(st.getState().scenario.fleet[0].status, 'available', 'truck back at 700');
  const res2 = st.dispatch({ type: 'clock/tick', simMin: 725 });
  assert.deepEqual(Array.from(res2.crossed), [720]);
  const ui = st.getState().ui;
  assert.equal(ui.planRequested, true);
  assert.equal(ui.planRequestReason, 'boundary');
  assert.equal(ui.planRequestedAt, 720);
  // nothing pending -> a boundary does not ask for a plan
  const quiet = mk();
  quiet.dispatch({ type: 'clock/tick', simMin: 800 });
  assert.equal(quiet.getState().ui.planRequested, false);
});

test('contingency re-plan: approving a child plan supersedes the parent and flags moved requests', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'plan/approve', planId: 'P-0001' });
  const child = samplePlan({ id: 'P-0002', parentPlanId: 'P-0001', name: 'Re-plan' });
  child.routes[0].stops[0].arrive = 530;          // R-0001 and R-0002 get later ETAs
  child.deferred = [{ requestId: 'R-0003', lineIdx: 0, qty: 10, unit: 'gal', reason: 'closed-road' }];
  child.routes[0].stops[0].deliveries.push({ requestId: 'R-0002', lineIdx: 0, qty: 50, unit: 'gal', classId: 'III' });
  st.dispatch({ type: 'plan/store', plan: child });
  const res = st.dispatch({ type: 'plan/approve', planId: 'P-0002' });
  assert.equal(res.supersededPlanId, 'P-0001');
  const s = st.getState();
  assert.equal(s.plans[0].approved, false);
  assert.equal(s.plans[0].superseded, true);
  assert.equal(s.plans[0].supersededBy, 'P-0002');
  assert.equal(s.plans[1].approved, true);
  assert.equal(s.requests[0].updated, true);
  assert.equal(s.requests[0].eta, 530);
  assert.equal(s.requests[1].status, 'approved', 'remainder now delivered');
  assert.equal(s.requests[2].updated, false);
  assert.equal(s.windows[0].approvedPlanId, 'P-0002');
});

test('plan/rename and snapshot/save', () => {
  const st = storeWithThreeRequests();
  assert.equal(st.dispatch({ type: 'snapshot/save', name: 'none yet' }).ok, false);
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'plan/rename', planId: 'P-0001', name: '  Morning run ' });
  assert.equal(st.getState().plans[0].name, 'Morning run');
  assert.equal(st.dispatch({ type: 'plan/rename', planId: 'P-0001', name: ' ' }).ok, false);
  assert.equal(st.dispatch({ type: 'plan/rename', planId: 'P-9', name: 'x' }).ok, false);
  const r = st.dispatch({ type: 'snapshot/save', name: 'Before closure' });
  assert.equal(r.id, 'S-0001');
  assert.deepEqual(plain(st.getState().snapshots[0]), { id: 'S-0001', name: 'Before closure', createdAt: 360, planId: 'P-0001' });
  st.dispatch({ type: 'snapshot/save', planId: 'P-0001' });
  assert.equal(st.getState().snapshots[1].name, 'Snapshot 2');
});

test('trucks: add, mark out / available, remove', () => {
  const st = storeWithThreeRequests();
  let r = st.dispatch({ type: 'truck/add', truck: { hubId: 'HUB-GRANITE', type: 'cargo' } });
  assert.equal(r.id, 'Alpha-3');
  let t = st.getState().scenario.fleet[2];
  assert.equal(t.capacity, 10);
  assert.equal(t.status, 'available');
  assert.equal(t.freq, '45.250');
  assert.ok(!['#4C9AFF', '#F5A623'].includes(t.color), 'unused colour');
  assert.equal(typeof t.color, 'string');
  r = st.dispatch({ type: 'truck/add', payload: { hubId: 'HUB-JADE', type: 'tanker' } });
  assert.equal(r.id, 'Bravo-1');
  assert.equal(st.getState().scenario.fleet[3].capacity, 2500);
  assert.equal(st.dispatch({ type: 'truck/add', truck: { hubId: 'NOPE' } }).ok, false);
  // scenario.js palette entries are { hex, name }
  SRO.data.scenario.truckColors = [{ hex: '#4C9AFF', name: 'Blue' }, { hex: '#123456', name: 'Test' }];
  try {
    st.dispatch({ type: 'truck/add', truck: { hubId: 'HUB-JADE', type: 'cargo' } });
    assert.equal(st.getState().scenario.fleet[4].color, '#123456');
  } finally { delete SRO.data.scenario.truckColors; }
  st.dispatch({ type: 'truck/remove', truckId: 'Bravo-2' });
  st.dispatch({ type: 'truck/markOut', truckId: 'Alpha-1', reason: 'blown tire', until: 900 });
  t = st.getState().scenario.fleet[0];
  assert.equal(t.status, 'out');
  assert.equal(t.outReason, 'blown tire');
  st.dispatch({ type: 'clock/tick', simMin: 950 });
  assert.equal(st.getState().scenario.fleet[0].status, 'available', 'back after outUntil');
  st.dispatch({ type: 'truck/markOut', truckId: 'Alpha-1' });
  st.dispatch({ type: 'truck/markAvailable', truckId: 'Alpha-1' });
  t = st.getState().scenario.fleet[0];
  assert.equal(t.status, 'available');
  assert.equal(t.availableAt, 950);
  st.dispatch({ type: 'request/lock', requestId: 'R-0001', truckId: 'Alpha-3' });
  st.dispatch({ type: 'truck/remove', truckId: 'Alpha-3' });
  assert.equal(st.getState().scenario.fleet.some((x) => x.id === 'Alpha-3'), false);
  assert.equal(st.getState().requests[0].locks.truckId, null, 'lock cleared with the truck');
  assert.equal(st.dispatch({ type: 'truck/remove', truckId: 'Alpha-3' }).ok, false);
  assert.equal(st.dispatch({ type: 'truck/markOut', truckId: 'Nope' }).ok, false);
});

test('zones: add, update, remove with validation', () => {
  const st = mk();
  let r = st.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: 24, lon: 121, radiusMi: 3, rating: 'High' } });
  assert.equal(r.id, 'Z-0001');
  let z = st.getState().scenario.zones[0];
  assert.equal(z.rating, null, 'closed zones have no rating');
  assert.equal(z.label, 'Closed road');
  r = st.dispatch({ type: 'zone/add', payload: { kind: 'risk', rating: 'Medium', lat: '23.5', lon: '120.9', radiusMi: '10' } });
  z = st.getState().scenario.zones[1];
  assert.equal(z.lat, 23.5);
  assert.equal(z.radiusMi, 10);
  assert.equal(z.label, 'Medium risk');
  assert.equal(st.dispatch({ type: 'zone/add', zone: { kind: 'risk', lat: 1, lon: 1, radiusMi: 1 } }).ok, false, 'risk needs rating');
  assert.equal(st.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: 1, lon: 1, radiusMi: 0 } }).ok, false);
  assert.equal(st.dispatch({ type: 'zone/add', zone: { kind: 'wall', lat: 1, lon: 1, radiusMi: 1 } }).ok, false);
  st.dispatch({ type: 'zone/update', id: 'Z-0002', changes: { rating: 'High', radiusMi: 12 } });
  z = st.getState().scenario.zones[1];
  assert.equal(z.rating, 'High');
  assert.equal(z.radiusMi, 12);
  assert.equal(st.dispatch({ type: 'zone/update', id: 'Z-0002', changes: { radiusMi: -1 } }).ok, false);
  st.dispatch({ type: 'zone/remove', id: 'Z-0001' });
  assert.deepEqual(st.getState().scenario.zones.map((x) => x.id), ['Z-0002']);
  assert.equal(st.dispatch({ type: 'zone/remove', id: 'Z-0001' }).ok, false);
});

test('rally pin / ban / clear', () => {
  const st = mk();
  st.dispatch({ type: 'rally/pin', gridId: 'G2' });
  st.dispatch({ type: 'rally/pin', gridId: 'G2' });
  st.dispatch({ type: 'rally/ban', payload: 'G3' });
  assert.deepEqual(plain(st.getState().scenario.rally), { pinned: ['G2'], banned: ['G3'] });
  st.dispatch({ type: 'rally/ban', gridId: 'G2' });              // ban removes the pin
  assert.deepEqual(plain(st.getState().scenario.rally), { pinned: [], banned: ['G3', 'G2'] });
  st.dispatch({ type: 'rally/ban', gridId: 'G3', value: false });
  assert.deepEqual(plain(st.getState().scenario.rally), { pinned: [], banned: ['G2'] });
  st.dispatch({ type: 'rally/pin', gridId: 'G1' });
  st.dispatch({ type: 'rally/clear', gridId: 'G2' });
  assert.deepEqual(plain(st.getState().scenario.rally), { pinned: ['G1'], banned: [] });
  st.dispatch({ type: 'rally/clear' });
  assert.deepEqual(plain(st.getState().scenario.rally), { pinned: [], banned: [] });
  assert.equal(st.dispatch({ type: 'rally/pin' }).ok, false);
});

test('settings/update deep-merges; resetMethodParams uses SRO.solver.defaultParams when present', () => {
  const st = mk();
  st.dispatch({ type: 'settings/update', changes: { weights: { fuel: 7 }, maxRallyPoints: 6, methodParams: { tabu: { tenure: 30 } } } });
  let set = st.getState().scenario.settings;
  assert.deepEqual(plain(set.weights), { fuel: 7, distance: 3, risk: 5, simplicity: 2 });
  assert.equal(set.maxRallyPoints, 6);
  assert.deepEqual(plain(set.methodParams.tabu), { iterations: 4000, tenure: 30 });
  st.dispatch({ type: 'settings/update', payload: { periods: [{ name: 'All', start: '0000', end: '2400', speed: 1, risk: 1 }] } });
  assert.equal(st.getState().scenario.settings.periods.length, 1, 'arrays replace');
  st.dispatch({ type: 'settings/update', path: 'weights.risk', value: 9 });
  assert.equal(st.getState().scenario.settings.weights.risk, 9);
  assert.equal(st.dispatch({ type: 'settings/update' }).ok, false);
  // fallback: defaults from the scenario's default state
  st.dispatch({ type: 'settings/resetMethodParams', method: 'tabu' });
  assert.deepEqual(plain(st.getState().scenario.settings.methodParams.tabu), { iterations: 4000, tenure: 12 });
  // params.js present
  st.dispatch({ type: 'settings/update', changes: { methodParams: { sa: { coolingRate: 0.9 }, aco: { ants: 5 } } } });
  SRO.solver.defaultParams = (m, settings) => ({ seed: 20261005, timeCapSec: settings.timeLimitSec, method: m });
  try {
    st.dispatch({ type: 'settings/resetMethodParams', method: 'sa' });
    set = st.getState().scenario.settings;
    assert.deepEqual(plain(set.methodParams.sa), { seed: 20261005, timeCapSec: 300, method: 'sa' });
    assert.equal(set.methodParams.aco.ants, 5, 'other methods untouched');
    st.dispatch({ type: 'settings/resetMethodParams' });
    assert.equal(st.getState().scenario.settings.methodParams.aco.method, 'aco', 'no method resets all');
  } finally { delete SRO.solver.defaultParams; }
});

test('request/lock', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'request/lock', requestId: 'R-0002', truckId: 'Alpha-2' });
  assert.deepEqual(plain(st.getState().requests[1].locks), { truckId: 'Alpha-2', forceDirect: false });
  st.dispatch({ type: 'request/lock', requestId: 'R-0002', forceDirect: true });
  assert.deepEqual(plain(st.getState().requests[1].locks), { truckId: 'Alpha-2', forceDirect: true });
  st.dispatch({ type: 'request/lock', requestId: 'R-0002', truckId: null });
  assert.deepEqual(plain(st.getState().requests[1].locks), { truckId: null, forceDirect: true });
  assert.equal(st.dispatch({ type: 'request/lock', requestId: 'R-0002', truckId: 'Ghost-1' }).ok, false);
  assert.equal(st.dispatch({ type: 'request/lock', requestId: 'R-9', truckId: null }).ok, false);
});

test('export / import round trip with version check; data/reset', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'theme/set', theme: 'light' });
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'clock/start' });
  const text = st.exportJson();
  assert.ok(text.includes('__INF__'), 'Infinity encoded');
  const other = mk();
  const r = other.importJson(text);
  assert.equal(r.ok, true);
  const s = other.getState();
  assert.equal(s.requests.length, 3);
  assert.equal(s.plans[0].cost.worstCase, Infinity);
  assert.equal(s.ui.theme, 'light');
  assert.equal(s.clock.running, false, 'an imported clock is paused');
  // envelope form
  assert.equal(other.dispatch({ type: 'data/import', state: { state: JSON.parse(text) } }).ok, true);
  // version and format errors are plain sentences; state unchanged
  const before = other.getState();
  const bad = JSON.parse(text); bad.version = 2;
  let e = other.dispatch({ type: 'data/import', json: JSON.stringify(bad) });
  assert.equal(e.ok, false);
  assert.match(e.error, /version 2/);
  e = other.dispatch({ type: 'data/import', json: '{ nope' });
  assert.match(e.error, /not valid JSON/);
  e = other.dispatch({ type: 'data/import', json: '{"hello":1}' });
  assert.match(e.error, /not a Supply Route Optimizer save/);
  assert.equal(other.getState(), before);
  assert.throws(() => S.importJson('{"version":2,"scenario":{},"requests":[]}'), /version/);
  // reset keeps the theme (and the profile only when asked)
  other.dispatch({ type: 'profile/save', profile: { unitName: 'X' } });
  other.dispatch({ type: 'data/reset' });
  assert.equal(other.getState().requests.length, 0);
  assert.equal(other.getState().ui.theme, 'light');
  assert.equal(other.getState().profile, null);
  other.dispatch({ type: 'profile/save', profile: { unitName: 'Y' } });
  other.dispatch({ type: 'data/reset', keepProfile: true });
  assert.equal(other.getState().profile.unitName, 'Y');
});

test('roadCache/put (extra action for roads.js)', () => {
  const st = mk();
  st.dispatch({ type: 'roadCache/put', key: 'G1|G2', value: '_p~iF~ps|U' });
  assert.equal(st.getState().roadCache['G1|G2'], '_p~iF~ps|U');
  st.dispatch({ type: 'roadCache/put', key: 'G1|G2', value: null });
  assert.equal('G1|G2' in st.getState().roadCache, false);
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

test('reducer is pure: every action works on a deep-frozen state and leaves it unchanged', () => {
  const st = storeWithThreeRequests();
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'plan/store', plan: samplePlan({ id: 'P-0002' }) });
  st.dispatch({ type: 'zone/add', zone: { kind: 'risk', rating: 'Low', lat: 24, lon: 121, radiusMi: 2 } });
  st.dispatch({ type: 'profile/save', profile: { unitName: 'P' } });
  const frozen = deepFreeze(st.getState());
  const snapshot = JSON.stringify(frozen, SRO.util.jsonReplacer);
  const exported = st.exportJson();
  const actions = [
    { type: 'role/set', role: 'planner' }, { type: 'theme/set', theme: 'night' }, { type: 'tab/set', tab: 'plan' },
    { type: 'clock/start' }, { type: 'clock/pause' }, { type: 'clock/speed', speed: 600 }, { type: 'clock/tick', simMin: 2000 },
    { type: 'profile/save', profile: { lat: 1 } }, { type: 'request/submit', request: req() },
    { type: 'request/edit', id: 'R-0001', changes: { nlt: 999 } }, { type: 'request/cancel', id: 'R-0002' },
    { type: 'samples/load', requests: [req()] }, { type: 'window/planNow' }, { type: 'window/planHandled' },
    { type: 'plan/store', plan: samplePlan({ id: 'P-0003' }) }, { type: 'plan/approve', planId: 'P-0001' },
    { type: 'plan/rename', planId: 'P-0001', name: 'N' },
    { type: 'truck/add', truck: { hubId: 'HUB-JADE', type: 'cargo' } }, { type: 'truck/remove', truckId: 'Alpha-2' },
    { type: 'truck/markOut', truckId: 'Alpha-1', until: 5000 }, { type: 'truck/markAvailable', truckId: 'Alpha-1' },
    { type: 'zone/add', zone: { kind: 'closed', lat: 24, lon: 121, radiusMi: 2 } }, { type: 'zone/update', id: 'Z-0001', changes: { radiusMi: 3 } },
    { type: 'zone/remove', id: 'Z-0001' }, { type: 'rally/pin', gridId: 'G1' }, { type: 'rally/ban', gridId: 'G2' }, { type: 'rally/clear' },
    { type: 'settings/update', changes: { weights: { fuel: 1 } } }, { type: 'settings/resetMethodParams', method: 'tabu' },
    { type: 'request/lock', requestId: 'R-0001', truckId: 'Alpha-1', forceDirect: true }, { type: 'snapshot/save', name: 's' },
    { type: 'data/import', json: exported }, { type: 'data/reset' }, { type: 'roadCache/put', key: 'a|b', value: 'x' }
  ];
  for (const a of actions) {
    const out = S.reduce(frozen, a);
    assert.equal(out.result.ok, true, a.type + ': ' + out.result.error);
    assert.notEqual(out.state, frozen, a.type + ' returns a new state');
  }
  assert.equal(JSON.stringify(frozen, SRO.util.jsonReplacer), snapshot);
  // the bare reducer form
  assert.equal(S.reducer(frozen, { type: 'role/set', role: 'planner' }).ui.role, 'planner');
});

test('subscribe / unsubscribe; a throwing listener does not break others', () => {
  const st = mk();
  const seen = [];
  const errors = [];
  const origError = console.error;
  console.error = (e) => errors.push(e);
  try {
    const off1 = st.subscribe(() => { throw new Error('bad view'); });
    const off2 = st.subscribe((state, action, result) => seen.push([action.type, result.ok, state.ui.role]));
    st.dispatch({ type: 'role/set', role: 'planner' });
    st.dispatch({ type: 'role/set', role: 'nobody' });       // listeners run after every action
    off2();
    st.dispatch({ type: 'role/set', role: 'psg' });
    off1();
    assert.deepEqual(seen, [['role/set', true, 'planner'], ['role/set', false, 'planner']]);
    assert.equal(errors.length, 3);
  } finally { console.error = origError; }
});

// ---- persistence ------------------------------------------------------------------------------
function memoryStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

test('LocalStorageAdapter: saves under sro.v1 and restores (Infinity-safe)', () => {
  const storage = memoryStorage();
  const st = S.createStore({ adapter: S.LocalStorageAdapter({ storage }) });
  st.dispatch({ type: 'request/submit', request: req() });
  st.dispatch({ type: 'plan/store', plan: samplePlan() });
  st.dispatch({ type: 'clock/start' });
  assert.ok(storage.m.has('sro.v1'));
  const st2 = S.createStore({ adapter: S.LocalStorageAdapter({ storage }) });
  const s = st2.getState();
  assert.equal(s.requests[0].id, 'R-0001');
  assert.equal(s.plans[0].cost.worstCase, Infinity);
  assert.equal(s.clock.running, false, 'a reload never resumes a running clock');
  // custom key; clear()
  const ad = S.LocalStorageAdapter({ storage, key: 'other' });
  ad.save({ version: 1, a: 1 });
  assert.ok(storage.m.has('other'));
  ad.clear();
  assert.equal(storage.m.has('other'), false);
});

test('LocalStorageAdapter: throwing storage falls back to memory and the app keeps working', () => {
  const thrower = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); }
  };
  const ad = S.LocalStorageAdapter({ storage: thrower });
  const st = S.createStore({ adapter: ad });
  const r = st.dispatch({ type: 'request/submit', request: req() });
  assert.equal(r.ok, true);
  assert.equal(st.getState().requests.length, 1);
  assert.equal(ad.usingMemory, true);
  assert.ok(ad.lastError);
  // the in-memory copy is what load() returns now
  assert.equal(ad.load().requests.length, 1);
  assert.doesNotThrow(() => ad.clear());
  // no storage at all
  const none = S.LocalStorageAdapter({ storage: null });
  assert.equal(none.load(), null);
  assert.equal(none.save({ version: 1 }), false);
  assert.equal(none.load().version, 1);
});

test('LocalStorageAdapter: corrupt or other-version data is ignored', () => {
  const storage = memoryStorage();
  storage.setItem('sro.v1', '{ not json');
  let st = S.createStore({ adapter: S.LocalStorageAdapter({ storage }) });
  assert.equal(st.getState().requests.length, 0);
  storage.setItem('sro.v1', JSON.stringify({ version: 99, requests: [{ id: 'R-0001' }] }));
  st = S.createStore({ adapter: S.LocalStorageAdapter({ storage }) });
  assert.equal(st.getState().requests.length, 0);
  // and a saved state missing newer keys is filled from defaults
  storage.setItem('sro.v1', JSON.stringify({ version: 1, ui: { role: 'planner' }, scenario: { hubs: [] }, requests: [] }));
  st = S.createStore({ adapter: S.LocalStorageAdapter({ storage }) });
  assert.equal(st.getState().ui.role, 'planner');
  assert.equal(st.getState().ui.theme, 'dark');
  assert.deepEqual(plain(st.getState().scenario.hubs), []);
  assert.equal(st.getState().scenario.settings.mpg, 2);
});

test('LocalStorageAdapter: a global localStorage whose getter throws (blocked site data)', () => {
  const ctx = { console, setTimeout, clearTimeout, performance, Date, Math, JSON };
  ctx.globalThis = ctx;
  Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('SecurityError: access denied'); } });
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(wrapSource(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), ctx, { filename: f });
  const S2 = ctx.SRO.core.store;
  ctx.SRO.data.scenario = { defaultState: stubDefaultState };
  const st = S2.createStore({});                  // default adapter: LocalStorageAdapter on the global
  assert.equal(st.adapter.kind, 'localStorage');
  assert.equal(st.dispatch({ type: 'request/submit', request: req() }).ok, true);
  assert.equal(st.adapter.usingMemory, true);
  assert.equal(st.getState().requests.length, 1);
});

test('clock ticks are saved at most every saveThrottleMs; other actions at once', () => {
  let wall = 0;
  let saves = 0;
  const inner = S.MemoryAdapter();
  const adapter = { ...inner, save: (s) => { saves++; return inner.save(s); } };
  const st = S.createStore({ adapter, now: () => wall, saveThrottleMs: 2000 });
  st.dispatch({ type: 'clock/start' });
  assert.equal(saves, 1);
  for (let i = 1; i <= 8; i++) { wall += 250; st.dispatch({ type: 'clock/tick', simMin: 360 + i }); }
  assert.equal(saves, 2, 'one save in 2 s of ticks');
  wall += 100;
  st.dispatch({ type: 'clock/tick', simMin: 370 });
  assert.equal(saves, 2);
  st.flush();
  assert.equal(saves, 3, 'flush writes the pending tick');
  st.flush();
  assert.equal(saves, 3, 'nothing pending');
  st.dispatch({ type: 'request/submit', request: req() });
  assert.equal(saves, 4);
  // a store without persistence
  const bare = S.createStore({ adapter: null });
  assert.equal(bare.dispatch({ type: 'clock/start' }).ok, true);
});
