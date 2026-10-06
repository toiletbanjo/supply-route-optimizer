// Store behaviour that crosses module boundaries (store.js with the planner engine, the PSG views
// and boot.js):
//   1. 'Updated' after a re-plan (spec-answers Contingency): the engine's change list decides; a moved
//      or retimed stop (> 1 min) on any stop of a split delivery, a new deferral or a restored delivery
//      marks the request; request/seen clears it.
//   2. request.reportedAt: escalation counts the run-out from the last on-hand report, so an NLT-only
//      edit never moves an Immediate deadline; old saves migrate (reportedAt = createdAt).
//   3. truck/markAvailable never makes an en-route truck available "now".
//   4. Plan storage: older drafts are dropped on plan/store; saves are debounced with an immediate
//      flush (what boot.js calls on pagehide), so a reload right after an action keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadScripts, wrapSource, ROOT } from '../load.mjs';

// main group up to the engine, without the UI or the solver (planChanges needs neither)
const CORE = ['src/core/ns.js', 'src/core/util.js', 'src/data/grid.json', 'src/data/catalog.js', 'src/data/scenario.js',
  'src/core/format.js', 'src/core/geo.js', 'src/core/clock.js', 'src/core/urgency.js', 'src/core/samples.js', 'src/core/store.js'];
const WITH_ENGINE = CORE.concat(['src/core/planner-engine.js']);
const plain = (SRO, x) => JSON.parse(JSON.stringify(x, SRO.util.jsonReplacer), SRO.util.jsonReviver);

function ctxFor(files) {
  const SRO = loadScripts(files);
  return { SRO, S: SRO.core.store, E: SRO.core.engine || null };
}
const grid = (SRO, n) => SRO.data.grid.filter((g) => g.rallyCandidate)[n];

// A platoon request at minute 360 (0600 Day 1).
const REQ = {
  unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN', lat: 24.99, lon: 121.3, mobility: 'mounted',
  lines: [{ classId: 'I', itemId: 'mre', option: 'mixed', qty: 60, unit: 'case', onHand: null }],
  urgencyRequested: 'Routine', nlt: 1080
};

// Hand-made plan in the section 3 shape. stops: [{ truck, g (grid point), arrive, rid, qty, done? }].
// withIndex adds an engine-style byRequest (every stop of the request in .stops) for the requests.
function makePlan(SRO, id, stops, { deferred = [], parentPlanId = null, createdAt = 380, windowId = 'W-D1-0600', withIndex = false, changes } = {}) {
  const st = SRO.core.store.defaultState();
  const routes = {};
  for (const s of stops) {
    const t = st.scenario.fleet.find((x) => x.id === s.truck);
    const rt = routes[s.truck] || (routes[s.truck] = { truckId: s.truck, type: t.type, color: t.color, freq: t.freq, loadStart: 370, depart: 390, returnAt: 0, stops: [], legs: [] });
    rt.stops.push({ seq: rt.stops.length + 1, nodeKey: 'rally:' + s.g.id, kind: 'rally', gridId: s.g.id, lat: s.g.lat, lon: s.g.lon, label: s.g.name,
      arrive: s.arrive, depart: s.arrive + 15, done: !!s.done,
      deliveries: [{ requestId: s.rid, lineIdx: 0, qty: s.qty, unit: 'case', classId: 'I' }], pickups: [{ requestId: s.rid, platoonMiles: 2 }] });
    rt.returnAt = Math.max(rt.returnAt, s.arrive + 60);
  }
  const plan = { id, windowId, name: id, method: 'manual', createdAt, parentPlanId, routes: Object.values(routes), deferred, late: [] };
  if (changes) plan.changes = changes;
  if (withIndex) {
    const br = {};
    for (const rt of plan.routes) {
      rt.stops.forEach((s, k) => {
        for (const d of s.deliveries) {
          const e = br[d.requestId] || (br[d.requestId] = { requestId: d.requestId, qtyByLine: {}, deferredQty: {}, stops: [] });
          e.qtyByLine[d.lineIdx] = (e.qtyByLine[d.lineIdx] || 0) + d.qty;
          e.stops.push({ truckId: rt.truckId, stopSeq: s.seq, nodeKind: 'rally', nodeKey: s.nodeKey, gridId: s.gridId, lat: s.lat, lon: s.lon, label: s.label, eta: s.arrive, done: s.done, stopsBefore: k });
        }
      });
    }
    for (const d of deferred) {
      const e = br[d.requestId] || (br[d.requestId] = { requestId: d.requestId, qtyByLine: {}, deferredQty: {}, stops: [] });
      e.deferredQty[d.lineIdx] = (e.deferredQty[d.lineIdx] || 0) + d.qty;
    }
    for (const e of Object.values(br)) {
      e.stops.sort((a, b) => (a.done - b.done) || (a.eta - b.eta));
      const p = e.stops[0];
      Object.assign(e, p ? { truckId: p.truckId, gridId: p.gridId, nodeKey: p.nodeKey, label: p.label, eta: p.eta, nodeKind: 'rally' } : {});
      const def = Object.values(e.deferredQty).some((q) => q > 0);
      e.status = !p ? 'deferred' : def ? 'partial' : 'planned';
    }
    plan.byRequest = br;
  }
  return plan;
}
const defer = (rid, qty) => ({ requestId: rid, lineIdx: 0, qty, unit: 'case', group: 'cargo', reason: 'capacity', detail: 'trucks-full', note: '' });

// Three requests; plan P-1 approved: R-0001 split over Alpha-2 (A, 20) and Bravo-2 (B, 20) with 20
// deferred; R-0002 on Alpha-2 at A; R-0003 on Bravo-2 at C.
function approvedBase(ctx, opts = {}) {
  const { SRO, S } = ctx;
  const st = S.createStore({ adapter: null });
  for (let i = 0; i < 3; i++) assert.ok(st.dispatch({ type: 'request/submit', request: REQ, now: 360 }).ok);
  const [A, B, C] = [grid(SRO, 0), grid(SRO, 1), grid(SRO, 2)];
  const stops = [
    { truck: 'Alpha-2', g: A, arrive: 450, rid: 'R-0001', qty: 20 }, { truck: 'Bravo-2', g: B, arrive: 560, rid: 'R-0001', qty: 20 },
    { truck: 'Alpha-2', g: A, arrive: 450, rid: 'R-0002', qty: 60 }, { truck: 'Bravo-2', g: C, arrive: 600, rid: 'R-0003', qty: 60 }
  ];
  const p1 = makePlan(SRO, 'P-1', stops, { deferred: [defer('R-0001', 20)], withIndex: !!opts.withIndex });
  assert.ok(st.dispatch({ type: 'plan/store', plan: p1, now: 380 }).ok);
  assert.ok(st.dispatch({ type: 'plan/approve', planId: 'P-1', now: 380 }).ok);
  const req = (id) => st.getState().requests.find((r) => r.id === id);
  assert.equal(req('R-0001').status, 'partial');
  assert.ok(['R-0001', 'R-0002', 'R-0003'].every((id) => req(id).updated === false), 'a first plan updates nobody');
  return { st, stops, A, B, C, req, approve(plan) {
    assert.ok(st.dispatch({ type: 'plan/store', plan, now: 400 }).ok);
    const r = st.dispatch({ type: 'plan/approve', planId: plan.id, now: 400 });
    assert.ok(r.ok, r.error);
    return r;
  } };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- 1. 'Updated' ----------------------------------------------------------------------------------
for (const variant of [
  { name: 'store alone (no engine loaded)', files: CORE, withIndex: false },
  { name: 'engine planChanges on byRequest plans', files: WITH_ENGINE, withIndex: true },
  { name: 'engine planChanges on plans without byRequest', files: WITH_ENGINE, withIndex: false }
]) {
  test('updated (' + variant.name + '): only the second stop of a split delivery moves -> that platoon is updated', () => {
    const ctx = ctxFor(variant.files);
    let calls = 0;
    if (ctx.E) { const orig = ctx.E.planChanges; ctx.E.planChanges = function () { calls++; return orig.apply(this, arguments); }; }
    const b = approvedBase(ctx, variant);
    const D = grid(ctx.SRO, 3);
    const stops = clone(b.stops);
    stops[1].g = D; stops[1].arrive = 575;          // Bravo-2's stop for R-0001 moves from B to D
    b.approve(makePlan(ctx.SRO, 'P-2', stops, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1', withIndex: variant.withIndex }));
    if (ctx.E) assert.ok(calls >= 1, 'the engine change list was used');
    const r1 = b.req('R-0001');
    assert.equal(r1.updated, true, 'second stop of the split moved');
    const c = r1.updatedChange;
    assert.equal(c.kind, 'moved');
    assert.equal(c.planId, 'P-2');
    assert.equal(c.pickupMoved, false, 'first pickup unchanged');
    assert.equal(c.etaChanged, false);
    assert.equal(c.others.length, 1);
    assert.equal(c.others[0].gridId, D.id);
    assert.equal(c.others[0].truckId, 'Bravo-2');
    assert.equal(c.others[0].eta, 575);
    assert.equal(c.others[0].order, 2);
    assert.equal(b.req('R-0002').updated, false, 'same stop, same time');
    assert.equal(b.req('R-0003').updated, false);
    assert.equal(ctx.SRO.core.store.defaultState().plans.length, 0);
  });

  test('updated (' + variant.name + '): two trucks arrive together and only one moves -> the note names only that one', () => {
    const ctx = ctxFor(variant.files);
    const b = approvedBase(ctx, variant);
    // P-2: Bravo-2 brings R-0001's second half to A at the same minute as Alpha-2, listed first
    const tie = [{ truck: 'Bravo-2', g: b.A, arrive: 450, rid: 'R-0001', qty: 20 }].concat(clone(b.stops).filter((s, i) => i !== 1));
    b.approve(makePlan(ctx.SRO, 'P-2', tie, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1', withIndex: variant.withIndex }));
    assert.equal(b.req('R-0001').updated, true);
    assert.ok(b.st.dispatch({ type: 'request/seen', id: 'R-0001' }).ok);
    // P-3: Bravo-2's stop moves to D at 575; Alpha-2's stop at A (same minute as Bravo-2's was) does not change
    const D = grid(ctx.SRO, 3);
    const moved = clone(tie);
    moved[0].g = D; moved[0].arrive = 575;
    b.approve(makePlan(ctx.SRO, 'P-3', moved, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-2', withIndex: variant.withIndex }));
    const r1 = b.req('R-0001'), c = r1.updatedChange;
    assert.equal(r1.updated, true);
    assert.equal(c.truckId, 'Alpha-2');
    assert.equal(c.truckChanged, false, 'Alpha-2 was already coming then: not "Truck now Alpha-2"');
    assert.equal(c.pickupMoved, false);
    assert.equal(c.etaChanged, false);
    assert.equal(JSON.stringify(Array.from(c.others, (o) => [o.truckId, o.gridId, o.eta, o.order])), JSON.stringify([['Bravo-2', D.id, 575, 2]]));
    assert.equal(b.req('R-0002').updated, false);
  });

  test('updated (' + variant.name + '): ETA tolerance is 1 minute; a moved first pickup reads as "pickup moved"', () => {
    const ctx = ctxFor(variant.files);
    const b = approvedBase(ctx, variant);
    let stops = clone(b.stops);
    stops[2].arrive = 450.9; stops[0].arrive = 450.9;   // R-0002 / R-0001 at A: under a minute later
    stops[3].arrive = 601.6;                             // R-0003: 1.6 min later
    b.approve(makePlan(ctx.SRO, 'P-2', stops, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1', withIndex: variant.withIndex }));
    assert.equal(b.req('R-0002').updated, false, '0.9 min is within the tolerance');
    assert.equal(b.req('R-0001').updated, false);
    assert.equal(b.req('R-0003').updated, true, '1.6 min is a change');
    assert.equal(b.req('R-0003').updatedChange.kind, 'eta');
    assert.equal(b.req('R-0003').updatedChange.etaChanged, true);
    assert.equal(b.req('R-0003').updatedChange.eta, 601.6);
    // next re-plan moves R-0002's pickup from A to B and 40 min later
    stops = clone(stops);
    stops[2].g = b.B; stops[2].truck = 'Bravo-2'; stops[2].arrive = 490.9;
    b.approve(makePlan(ctx.SRO, 'P-3', stops, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-2', withIndex: variant.withIndex }));
    const c = b.req('R-0002').updatedChange;
    assert.equal(b.req('R-0002').updated, true);
    assert.equal(c.kind, 'moved');
    assert.equal(c.pickupMoved, true);
    assert.equal(c.gridId, b.B.id);
    assert.equal(c.label, b.B.name);
    assert.equal(c.etaChanged, true);
    assert.equal(c.eta, 490.9);
    assert.equal(c.prevEta, 450.9);
    assert.equal(c.truckChanged, true);
    assert.equal(c.truckId, 'Bravo-2');
    assert.equal(b.req('R-0003').updated, true, 'still updated: not seen yet');
    assert.equal(b.req('R-0003').updatedChange.planId, 'P-2', 'its note stays the one from P-2 (P-3 changed nothing for it)');
  });

  test('updated (' + variant.name + '): new deferral and restored delivery', () => {
    const ctx = ctxFor(variant.files);
    const b = approvedBase(ctx, variant);
    // R-0003 fully deferred; R-0001's remainder brought back (all 60 delivered); R-0002 more deferred
    const stops = clone(b.stops).filter((s) => s.rid !== 'R-0003');
    stops[0].qty = 40;
    stops[2].qty = 30;
    b.approve(makePlan(ctx.SRO, 'P-2', stops, { deferred: [defer('R-0003', 60), defer('R-0002', 30)], parentPlanId: 'P-1', withIndex: variant.withIndex }));
    const r1 = b.req('R-0001'), r2 = b.req('R-0002'), r3 = b.req('R-0003');
    assert.equal(r3.status, 'delayed');
    assert.equal(r3.updated, true, 'newly deferred');
    assert.equal(r3.updatedChange.kind, 'delayed');
    assert.equal(r3.updatedChange.status, 'deferred');
    assert.equal(r2.status, 'partial');
    assert.equal(r2.updated, true, 'part of it newly deferred');
    assert.equal(r2.updatedChange.kind, 'delayed');
    assert.equal(r1.status, 'approved');
    assert.equal(r1.updated, true, 'remainder restored');
    assert.equal(r1.updatedChange.kind, 'restored');
    // and back: R-0003 delivered again
    const back = clone(stops).concat([{ truck: 'Bravo-2', g: b.C, arrive: 610, rid: 'R-0003', qty: 60 }]);
    ctx.S.reduce(b.st.getState(), { type: 'request/seen', id: 'R-0003' });
    b.st.dispatch({ type: 'request/seen', id: 'R-0003' });
    b.approve(makePlan(ctx.SRO, 'P-3', back, { deferred: [defer('R-0002', 30)], parentPlanId: 'P-2', withIndex: variant.withIndex }));
    assert.equal(b.req('R-0003').status, 'approved');
    assert.equal(b.req('R-0003').updated, true);
    assert.equal(b.req('R-0003').updatedChange.kind, 'restored');
    assert.equal(b.req('R-0003').updatedChange.eta, 610);
    assert.equal(b.req('R-0003').updatedChange.prevEta, null, 'nothing was coming before');
    assert.equal(b.req('R-0003').updatedChange.others.length, 0, 'the restored stop is the pickup itself, not listed again');
  });
}

test('updated: plan.changes from the engine is used for a re-plan of the plan it replaces', () => {
  const ctx = ctxFor(WITH_ENGINE);
  let calls = 0;
  const orig = ctx.E.planChanges;
  ctx.E.planChanges = function () { calls++; return orig.apply(this, arguments); };
  const b = approvedBase(ctx, { withIndex: true });
  const stops = clone(b.stops);
  stops[3].arrive = 640;
  // the change list the engine attached says R-0003 moved in time; nothing else changed
  b.approve(makePlan(ctx.SRO, 'P-2', stops, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1', withIndex: true,
    changes: [{ requestId: 'R-0003', kind: 'eta' }] }));
  assert.equal(calls, 0, 'plan.changes made against the parent is used as is');
  assert.equal(b.req('R-0003').updated, true);
  assert.equal(b.req('R-0003').updatedChange.eta, 640);
  assert.equal(b.req('R-0001').updated, false);
  // a plan whose parent is not the plan it replaces: its change list is stale, so it is recomputed
  const stops2 = clone(stops);
  stops2[2].arrive = 470;
  b.approve(makePlan(ctx.SRO, 'P-3', stops2, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1', withIndex: true,
    changes: [{ requestId: 'R-0001', kind: 'moved' }] }));
  assert.ok(calls >= 1, 'recomputed with the engine');
  assert.equal(b.req('R-0002').updated, true, 'found by the recomputed list');
  assert.equal(b.req('R-0001').updated, false, 'the stale entry is ignored');
});

test('request/seen clears updated and the change note; pure; unknown id fails; no-op when not updated', () => {
  const ctx = ctxFor(CORE);
  const b = approvedBase(ctx);
  const stops = clone(b.stops);
  stops[3].arrive = 650;
  b.approve(makePlan(ctx.SRO, 'P-2', stops, { deferred: [defer('R-0001', 20)], parentPlanId: 'P-1' }));
  assert.equal(b.req('R-0003').updated, true);
  const before = b.st.getState();
  const json = JSON.stringify(before);
  const out = ctx.S.reduce(before, { type: 'request/seen', id: 'R-0003', now: 500 });
  assert.equal(JSON.stringify(before), json, 'reducer did not mutate');
  const r = out.state.requests.find((x) => x.id === 'R-0003');
  assert.equal(r.updated, false);
  assert.ok(!('updatedChange' in r));
  assert.equal(r.seenAt, 500);
  assert.equal(r.eta, 650, 'the new ETA itself stays');
  assert.equal(b.st.dispatch({ type: 'request/seen', id: 'R-9999' }).ok, false);
  const same = ctx.S.reduce(before, { type: 'request/seen', id: 'R-0002' });
  assert.equal(same.result.ok, true);
  assert.equal(same.state, before, 'not updated: state unchanged');
  assert.ok(ctx.S.ACTIONS.includes('request/seen'));
});

test('updated end to end: real engine re-plan after a truck is marked out (main-thread solver)', async () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  const strip = (f) => f.replace(/\?$/, '');
  const exists = (f) => fs.existsSync(path.join(ROOT, f));
  const main = man.main.map(strip).filter(exists);
  const core = main.slice(0, main.indexOf('src/core/planner-engine.js')).filter((f) => !f.startsWith('src/ui/'));
  const extra = man.worker.map(strip).filter(exists).filter((f) => !core.includes(f));
  const SRO = loadScripts(core.concat(extra, ['src/core/planner-engine.js']));
  const st = SRO.core.store.createStore({ adapter: null });
  assert.equal(st.dispatch({ type: 'samples/load' }).ids.length, 19);
  const eng = SRO.core.engine;
  eng.init(st, { forceMain: true, warm: false });
  const FAST = { iterations: 300, timeCapSec: 5 };
  const p1 = await eng.run({ method: 'tabu', params: FAST });
  assert.ok(st.dispatch({ type: 'plan/approve', planId: p1.id }).ok);
  const ap = st.getState().plans.find((p) => p.id === p1.id);
  const firsts = ap.routes.filter((r) => r.stops.length).map((r) => r.stops[0].arrive).sort((a, b) => a - b);
  const now = Math.ceil(firsts[1] + 1);
  st.dispatch({ type: 'clock/tick', simMin: now });
  const out = ap.routes.find((r) => r.stops.some((s) => s.arrive > now) && r.stops.length >= 2) || ap.routes.find((r) => r.stops.some((s) => s.arrive > now));
  // 3. an en-route truck: Mark available leaves it en route until its return
  const t0 = st.getState().scenario.fleet.find((t) => t.id === out.truckId);
  assert.equal(t0.status, 'en_route');
  const res = st.dispatch({ type: 'truck/markAvailable', truckId: out.truckId });
  assert.equal(res.ok, true);
  const t1 = st.getState().scenario.fleet.find((t) => t.id === out.truckId);
  assert.equal(t1.status, 'en_route');
  assert.equal(t1.availableAt, t0.availableAt, 'return time kept');
  st.dispatch({ type: 'truck/markOut', truckId: out.truckId, reason: 'Blown tire' });
  const p2 = await eng.replan({ reason: 'Truck out', params: FAST });
  assert.equal(p2.parentPlanId, p1.id);
  assert.ok(Array.isArray(p2.changes));
  const before = new Set(st.getState().requests.filter((r) => r.updated).map((r) => r.id));
  assert.equal(before.size, 0);
  assert.ok(st.dispatch({ type: 'plan/approve', planId: p2.id }).ok);
  const s = st.getState();
  const flagged = s.requests.filter((r) => r.updated).map((r) => r.id).sort();
  // every flagged request is in the engine's change list, and every listed change that is more than an
  // ETA wobble of a minute or less is flagged
  const listed = new Set(p2.changes.filter((c) => ['moved', 'eta', 'delayed', 'restored'].includes(c.kind)).map((c) => c.requestId));
  for (const id of flagged) assert.ok(listed.has(id) || s.requests.find((r) => r.id === id).updatedChange.kind !== 'eta', id + ' flagged without a change');
  const p1b = s.plans.find((p) => p.id === p1.id), p2b = s.plans.find((p) => p.id === p2.id);
  for (const c of p2.changes) {
    if (!['moved', 'delayed', 'restored'].includes(c.kind)) continue;
    const r = s.requests.find((x) => x.id === c.requestId);
    if (r.status === 'delivered' || r.status === 'cancelled') continue;
    assert.equal(r.updated, true, c.requestId + ' (' + c.kind + ') flagged');
  }
  // the requests the out truck still had to serve were moved or deferred, so someone is flagged
  const stranded = new Set();
  out.stops.filter((x) => x.arrive > now).forEach((x) => x.deliveries.forEach((d) => stranded.add(d.requestId)));
  for (const id of stranded) {
    const r = s.requests.find((x) => x.id === id);
    assert.equal(r.updated, true, id + ' lost its truck and is flagged');
    assert.ok(r.updatedChange && r.updatedChange.planId === p2.id);
  }
  // unchanged requests are not flagged
  for (const r of s.requests) {
    if (r.updated) continue;
    const a = p1b.byRequest[r.id], b = p2b.byRequest[r.id];
    if (!a || !b) continue;
    const sig = (e) => e.stops.map((x) => x.truckId + '@' + x.nodeKey).sort().join('|');
    assert.equal(sig(a), sig(b), r.id + ' unflagged but its stops changed');
  }
  // the truck back in service: its trip was cut by the re-plan, so it is available now
  const res2 = st.dispatch({ type: 'truck/markAvailable', truckId: out.truckId });
  assert.equal(res2.status, 'available');
});

// ---- 2. reportedAt -------------------------------------------------------------------------------------
test('reportedAt: set on submit; NLT-only edits keep it (and the Immediate deadline); new on hand re-reports', () => {
  const { S } = ctxFor(CORE);
  const st = S.createStore({ adapter: null });
  const urgent = { ...REQ, urgencyRequested: 'Urgent', nlt: 2000,
    lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] };   // 12 h left
  st.dispatch({ type: 'request/submit', request: urgent, now: 400 });
  const get = () => st.getState().requests[0];
  assert.equal(get().reportedAt, 400);
  assert.equal(get().urgency, 'Immediate');
  assert.equal(get().deadline, 400 + 12 * 60);
  // the same lines sent again with a new NLT (what a full form save sends) is not a new report
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 1900, lines: clone(urgent.lines) }, now: 450 });
  assert.equal(get().reportedAt, 400);
  assert.equal(get().deadline, 1120, 'run-out still from 0640');
  // new on hand at 0800: reported now, run-out moves
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { lines: [{ ...urgent.lines[0], onHand: 125 }] }, now: 480 });
  assert.equal(get().reportedAt, 480);
  assert.equal(get().deadline, 480 + 10 * 60);
  // an NLT-only edit after that re-report keeps the 0800 report (was: counted from createdAt again)
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 2100 }, now: 600 });
  assert.equal(get().reportedAt, 480);
  assert.equal(get().deadline, 1080, 'deadline did not move');
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 1060 }, now: 610 });
  assert.equal(get().deadline, 1060, 'an NLT earlier than the run-out wins');
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 2100 }, now: 620 });
  assert.equal(get().deadline, 1080, 'and the run-out comes back, from the 0800 report');
  // hours left re-reported
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { hoursLeftReported: 5 }, now: 630 });
  assert.equal(get().reportedAt, 630);
  assert.equal(get().deadline, 630 + 5 * 60);
  // reportedAt cannot be set from outside
  st.dispatch({ type: 'request/edit', id: 'R-0001', changes: { reportedAt: 1, remarks: 'x' }, now: 640 });
  assert.equal(get().reportedAt, 630);
  assert.equal(get().deadline, 930);
  // samples carry one too
  st.dispatch({ type: 'samples/load', now: 700 });
  assert.ok(st.getState().requests.every((r) => typeof r.reportedAt === 'number'));
});

test('reportedAt: old saves and imports migrate to reportedAt = createdAt', () => {
  const { SRO, S } = ctxFor(CORE);
  const st = S.createStore({ adapter: null });
  st.dispatch({ type: 'request/submit', request: { ...REQ, urgencyRequested: 'Urgent', nlt: 2000, lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: 150 }] }, now: 400 });
  const old = plain(SRO, st.getState());
  delete old.requests[0].reportedAt;
  old.requests[0].createdAt = 390;
  // load from storage
  const st2 = S.createStore({ adapter: S.MemoryAdapter(old) });
  assert.equal(st2.getState().requests[0].reportedAt, 390);
  // import
  const st3 = S.createStore({ adapter: null });
  assert.ok(st3.dispatch({ type: 'data/import', json: JSON.stringify(old) }).ok);
  assert.equal(st3.getState().requests[0].reportedAt, 390);
  // an NLT-only edit on the migrated request keeps its run-out from 0630
  st2.dispatch({ type: 'request/edit', id: 'R-0001', changes: { nlt: 1900 }, now: 700 });
  assert.equal(st2.getState().requests[0].deadline, 390 + 12 * 60);
});

// ---- 3. truck/markAvailable ------------------------------------------------------------------------------
test('truck/markAvailable: en route stays en route; out on a running trip goes back to en route; idle is available now', () => {
  const ctx = ctxFor(CORE);
  const b = approvedBase(ctx);
  const st = b.st;
  const truck = (id) => st.getState().scenario.fleet.find((t) => t.id === id);
  st.dispatch({ type: 'clock/tick', simMin: 420 });
  assert.equal(truck('Alpha-2').status, 'en_route');
  assert.equal(truck('Alpha-2').availableAt, 510);
  // en route: nothing changes
  const r = st.dispatch({ type: 'truck/markAvailable', truckId: 'Alpha-2' });
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(truck('Alpha-2').status, 'en_route');
  assert.equal(truck('Alpha-2').availableAt, 510, 'not "now" (420)');
  // out in the middle of its trip, then back in service: en route until the trip's return
  st.dispatch({ type: 'truck/markOut', truckId: 'Alpha-2', reason: 'Blown tire' });
  st.dispatch({ type: 'clock/tick', simMin: 440 });
  st.dispatch({ type: 'truck/markAvailable', truckId: 'Alpha-2' });
  assert.equal(truck('Alpha-2').status, 'en_route');
  assert.equal(truck('Alpha-2').availableAt, 510);
  assert.ok(!('outReason' in truck('Alpha-2')));
  st.dispatch({ type: 'clock/tick', simMin: 515 });
  assert.equal(truck('Alpha-2').status, 'available', 'back at its hub after the trip');
  // a re-plan that takes the out truck off its route: available from now when marked available
  st.dispatch({ type: 'truck/markOut', truckId: 'Bravo-2' });
  const p = clone(st.getState().plans.find((x) => x.id === 'P-1'));
  p.id = 'P-2'; p.parentPlanId = 'P-1'; delete p.approved; delete p.approvedAt;
  const bravo = p.routes.find((x) => x.truckId === 'Bravo-2');
  bravo.out = true; bravo.stops = bravo.stops.filter((x) => x.arrive <= 515);
  p.deferred = p.deferred.concat([defer('R-0003', 60)]);
  b.approve(p);
  assert.equal(truck('Bravo-2').status, 'out');
  st.dispatch({ type: 'truck/markAvailable', truckId: 'Bravo-2', now: 530 });
  assert.equal(truck('Bravo-2').status, 'available');
  assert.equal(truck('Bravo-2').availableAt, 530);
  // a truck still returning keeps its free-at time; an idle truck is available from now
  const ns = ctx.S.reduce(st.getState(), { type: 'truck/markOut', truckId: 'Alpha-1', until: 600 }).state;
  const back = ctx.S.reduce(ns, { type: 'clock/tick', simMin: 700 }).state;
  const ret = ctx.S.reduce(back, { type: 'truck/markAvailable', truckId: 'Delta-1', now: 700 });
  assert.equal(ret.state.scenario.fleet.find((t) => t.id === 'Delta-1').availableAt, 700);
  const returning = ctx.S.reduce(back, { type: 'settings/update', path: 'mpg', value: 2 }).state;
  returning.scenario = { ...returning.scenario, fleet: returning.scenario.fleet.map((t) => (t.id === 'Delta-1' ? { ...t, availableAt: 900 } : t)) };
  const kept = ctx.S.reduce(returning, { type: 'truck/markAvailable', truckId: 'Delta-1', now: 700 });
  assert.equal(kept.state.scenario.fleet.find((t) => t.id === 'Delta-1').availableAt, 900);
});

// ---- 4. plan storage --------------------------------------------------------------------------------------
test('plan/store keeps approved, snapshot and current-window plans plus the 10 newest other drafts', () => {
  const { SRO, S } = ctxFor(CORE);
  const st = S.createStore({ adapter: null });
  st.dispatch({ type: 'request/submit', request: REQ, now: 360 });
  const A = grid(SRO, 0);
  const mk = (id, createdAt, windowId) => makePlan(SRO, id, [{ truck: 'Alpha-2', g: A, arrive: createdAt + 60, rid: 'R-0001', qty: 60 }], { createdAt, windowId });
  // Day 1 0600 window: an approved plan and a draft saved in a snapshot
  st.dispatch({ type: 'plan/store', plan: mk('P-APP', 370, 'W-D1-0600') });
  st.dispatch({ type: 'plan/approve', planId: 'P-APP' });
  st.dispatch({ type: 'plan/store', plan: mk('P-SNAP', 371, 'W-D1-0600') });
  st.dispatch({ type: 'snapshot/save', planId: 'P-SNAP', name: 'keep me' });
  // 20 older drafts across two earlier windows
  for (let i = 0; i < 20; i++) st.dispatch({ type: 'plan/store', plan: mk('P-OLD' + String(i).padStart(2, '0'), 380 + i, 'W-D1-0600') });
  // the clock moves to the 1200 window; 12 drafts there
  st.dispatch({ type: 'clock/tick', simMin: 730 });
  let res;
  for (let i = 0; i < 12; i++) res = st.dispatch({ type: 'plan/store', plan: mk('P-NOW' + String(i).padStart(2, '0'), 730 + i, 'W-D1-1200') });
  const ids = st.getState().plans.map((p) => p.id);
  assert.ok(ids.includes('P-APP'), 'approved plan kept');
  assert.ok(ids.includes('P-SNAP'), 'snapshot plan kept');
  for (let i = 0; i < 12; i++) assert.ok(ids.includes('P-NOW' + String(i).padStart(2, '0')), 'current window drafts kept');
  const old = ids.filter((x) => x.startsWith('P-OLD'));
  assert.deepEqual(old, Array.from({ length: 10 }, (_, i) => 'P-OLD' + String(10 + i)), 'the 10 newest other drafts');
  assert.equal(ids.length, 2 + 12 + 10);
  assert.ok(Array.isArray(res.droppedPlanIds));
  // windows list only plans that exist
  const all = new Set(ids);
  for (const w of st.getState().windows) for (const id of w.planIds) assert.ok(all.has(id), w.id + ' lists dropped ' + id);
  // the stored state shrank accordingly
  assert.ok(S.serialize(st.getState()).length < 40 * 2000);
});

test('plan/store: a request whose only draft was dropped goes back to submitted', () => {
  const { SRO, S } = ctxFor(CORE);
  const st = S.createStore({ adapter: null });
  st.dispatch({ type: 'request/submit', request: REQ, now: 360 });
  st.dispatch({ type: 'request/submit', request: REQ, now: 360 });
  const A = grid(SRO, 0);
  st.dispatch({ type: 'plan/store', plan: makePlan(SRO, 'P-R2', [{ truck: 'Alpha-2', g: A, arrive: 450, rid: 'R-0002', qty: 60 }], { createdAt: 361, windowId: 'W-D1-0600' }) });
  assert.equal(st.getState().requests[1].status, 'planned');
  st.dispatch({ type: 'clock/tick', simMin: 1100 });
  for (let i = 0; i < 11; i++) {
    st.dispatch({ type: 'plan/store', plan: makePlan(SRO, 'P-X' + i, [{ truck: 'Alpha-2', g: A, arrive: 450 + i, rid: 'R-0001', qty: 60 }], { createdAt: 400 + i, windowId: 'W-D1-0600' }) });
  }
  // eleven drafts not in the current (1800) window: only ten stay, the oldest (P-R2) is dropped
  assert.ok(!st.getState().plans.some((p) => p.id === 'P-R2'));
  assert.equal(st.getState().requests[1].status, 'submitted');
  assert.equal(st.getState().requests[0].status, 'planned');
});

// fake timers and wall clock for the debounced save
function fakeTimers() {
  let t = 0, seq = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { q.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        q.delete(next[0]); t = next[1].at; next[1].fn();
      }
      t = end;
    },
    pending: () => q.size
  };
}
function memoryStorage() {
  const m = new Map();
  let writes = 0;
  return { m, writes: () => writes, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes++; m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('debounced save: a burst of actions is written once, 300 ms after the last; flush writes at once', () => {
  const { S } = ctxFor(CORE);
  const ft = fakeTimers();
  const storage = memoryStorage();
  const st = S.createStore({ adapter: S.LocalStorageAdapter({ storage }), saveDebounceMs: 300, now: ft.now, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  for (let i = 0; i < 10; i++) { st.dispatch({ type: 'theme/set', theme: i % 2 ? 'light' : 'night' }); ft.advance(50); }
  assert.equal(storage.writes(), 0, 'nothing written during the burst');
  assert.equal(st.hasPendingSave(), true);
  ft.advance(300);
  assert.equal(storage.writes(), 1, 'one write for the burst');
  assert.equal(S.deserialize(storage.getItem('sro.v1')).ui.theme, 'light');
  // flush (boot.js on pagehide / hidden) writes a pending change at once: a reload right after keeps it
  st.dispatch({ type: 'role/set', role: 'planner' });
  assert.equal(storage.writes(), 1);
  st.flush();
  assert.equal(storage.writes(), 2);
  assert.equal(ft.pending(), 0, 'timer cancelled by the flush');
  const reloaded = S.createStore({ adapter: S.LocalStorageAdapter({ storage }), saveDebounceMs: 300 });
  assert.equal(reloaded.getState().ui.role, 'planner');
  st.flush();
  assert.equal(storage.writes(), 2, 'nothing pending: no write');
  // a never-ending stream of actions is still written every saveMaxWaitMs (2 s)
  for (let i = 0; i < 40; i++) { st.dispatch({ type: 'clock/speed', speed: 1 + (i % 3) }); ft.advance(100); }
  assert.ok(storage.writes() >= 3 && storage.writes() <= 5, 'max wait: ' + storage.writes());
  // clock-only ticks keep their 2 s throttle and do not cut a pending debounce short
  ft.advance(5000);
  const w0 = storage.writes();
  st.dispatch({ type: 'role/set', role: 'psg' });
  st.dispatch({ type: 'clock/tick', simMin: 400 });
  assert.equal(storage.writes(), w0, 'tick waits for the pending save');
  ft.advance(300);
  assert.equal(storage.writes(), w0 + 1);
  assert.equal(S.deserialize(storage.getItem('sro.v1')).clock.simMin, 400, 'the tick went out with it');
});

test('debounced save: on by default in a page (300 ms), off without a document; rapid plan actions serialize once', () => {
  // a context with a document: the page default
  const ctx = { console, setTimeout, clearTimeout, performance, Date, Math, JSON, document: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of CORE) vm.runInContext(wrapSource(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), ctx, { filename: f });
  const S2 = ctx.SRO.core.store;
  assert.equal(S2.SAVE_DEBOUNCE_MS, 300);
  let saves = 0;
  const inner = S2.MemoryAdapter();
  const ft = fakeTimers();
  const pageStore = S2.createStore({ adapter: { ...inner, save: (s) => { saves++; return inner.save(s); } }, now: ft.now, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  pageStore.dispatch({ type: 'request/submit', request: REQ, now: 360 });
  for (let i = 0; i < 5; i++) {
    pageStore.dispatch({ type: 'plan/store', plan: makePlan(ctx.SRO, 'P-' + i, [{ truck: 'Alpha-2', g: grid(ctx.SRO, 0), arrive: 450 + i, rid: 'R-0001', qty: 60 }]) });
  }
  assert.equal(saves, 0);
  ft.advance(300);
  assert.equal(saves, 1, 'six actions, one serialization');
  // no document (Node, workers): saved at once, as before
  const { S } = ctxFor(CORE);
  let n = 0;
  const m = S.MemoryAdapter();
  const nodeStore = S.createStore({ adapter: { ...m, save: (s) => { n++; return m.save(s); } } });
  nodeStore.dispatch({ type: 'theme/set', theme: 'light' });
  assert.equal(n, 1);
  assert.equal(nodeStore.hasPendingSave(), false);
});
