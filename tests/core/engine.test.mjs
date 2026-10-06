// Planner engine (src/core/planner-engine.js, DESIGN.md section 8b): instance building and plan
// decoding with the real grid, road graph, catalog and sample requests; contingency instances; the
// runtime (run / compare / cancel / auto-plan / re-plan) on the main-thread transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadScripts, ROOT } from '../load.mjs';

// main group up to the engine (no UI) + the solver files of the worker group + the engine
function engineFiles() {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  const strip = (f) => f.replace(/\?$/, '');
  const exists = (f) => fs.existsSync(path.join(ROOT, f));
  const main = man.main.map(strip).filter(exists);
  const core = main.slice(0, main.indexOf('src/core/planner-engine.js')).filter((f) => !f.startsWith('src/ui/'));
  const extra = man.worker.map(strip).filter(exists).filter((f) => !core.includes(f));
  return core.concat(extra, ['src/core/planner-engine.js']);
}
const FILES = engineFiles();
const SRO = loadScripts(FILES);
const E = SRO.core.engine;
const Sv = SRO.solver;
const plain = (x) => JSON.parse(JSON.stringify(x, SRO.util.jsonReplacer), SRO.util.jsonReviver);
// arrays made inside the vm context have another Array prototype: copy before deepEqual
const problems = (inst) => Array.from(Sv.validateInstance(inst));

const USER_REQUEST = {
  unitName: '2nd PLT, B CO, 1-12 IN', designator: '2/B/1-12IN', lat: 24.15, lon: 120.68, mobility: 'mounted',
  urgencyRequested: 'Priority', nlt: 360 + 20 * 60,
  lines: [{ classId: 'III', itemId: 'diesel', qty: 400, unit: 'gal' }, { classId: 'I', itemId: 'mre', qty: 20, unit: 'case' }]
};
function demoStore(ctx = SRO) {
  const st = ctx.core.store.createStore({ adapter: null });
  assert.equal(st.dispatch({ type: 'samples/load' }).ids.length, 19);
  const r = st.dispatch({ type: 'request/submit', request: USER_REQUEST });
  assert.ok(r.ok, r.error);
  return st;
}
const keyIdx = (inst) => Object.fromEntries(inst.nodes.map((n, i) => [n.key, i]));
function quickSolve(build, iterations = 300) {
  return Sv.solve(build.instance, { method: 'tabu', params: { iterations, timeCapSec: 5, seed: 7 }, settings: { timeLimitSec: 5 } });
}

const base = demoStore();
const baseState = base.getState();
const B = E.buildInstance(baseState, {});

test('19 samples + 1 user request -> a valid instance on the OSM road matrix', () => {
  const inst = B.instance;
  assert.deepEqual(problems(inst), []);
  assert.equal(B.maps.network.source, 'osm-roads');
  assert.ok(B.maps.network.counts['osm-roads'] > 0);
  const reqIds = new Set(inst.jobs.map((j) => j.requestId));
  assert.equal(reqIds.size, 20, 'every request has a job');
  assert.ok(reqIds.has('R-0020'));
  // hubs, rally candidates, direct nodes; keys unique
  const kinds = inst.nodes.map((n) => n.kind);
  assert.equal(kinds.filter((k) => k === 'hub').length, 4);
  assert.ok(kinds.includes('rally') && kinds.includes('direct'));
  assert.equal(new Set(inst.nodes.map((n) => n.key)).size, inst.nodes.length);
  // fleet: 8 trucks with the scenario palette
  const pal = SRO.data.scenario.truckColors.map((c) => c.hex);
  assert.equal(inst.vehicles.length, 8);
  for (const v of inst.vehicles) assert.ok(pal.includes(v.color), v.color);
  // jobs: per load group, tier / class rank / deadlines
  for (const j of inst.jobs) {
    assert.ok(j.candidates.length >= 1, j.id + ' has a candidate');
    assert.ok(j.qty > 0);
    assert.equal(j.unit, j.group === 'fuel' ? 'gal' : 'pallet');
    assert.ok(j.tier >= 0 && j.tier <= 3 && j.classRank >= 0 && j.classRank <= 4);
    const r = baseState.requests.find((x) => x.id === j.requestId);
    const L = SRO.data.catalogHelpers.requestLoads(r.lines)[j.group];
    assert.ok(Math.abs(L.qty - j.qty) < 1e-6, j.id + ' qty = requestLoads');
    assert.equal(j.hardDeadline, SRO.core.urgency.isHardDeadline(r.urgency));
  }
  const user = inst.jobs.filter((j) => j.requestId === 'R-0020');
  assert.deepEqual(Array.from(user, (j) => [j.group, j.qty]), [['fuel', 400], ['cargo', 0.5]]);
  // periods for 72 h, minutes finite on the diagonal, arcs reachable between hubs
  assert.ok(inst.periods.length >= 3);
  const k = keyIdx(inst);
  assert.ok(inst.minutes[k['hub:HUB-GRANITE']][k['hub:HUB-ANVIL']] < Infinity);
  for (let i = 0; i < inst.nodes.length; i++) assert.equal(inst.minutes[i][i], 0);
  // the instance survives the JSON trip to the worker
  assert.deepEqual(problems(plain(inst)), []);
});

test('candidates: radius in road miles, dismounted <= 5 mi, fixed / directOnly / forceDirect direct only', () => {
  const inst = B.instance;
  const reqs = Object.fromEntries(baseState.requests.map((r) => [r.id, r]));
  let dismounted = 0, fixed = 0;
  for (let j = 0; j < inst.jobs.length; j++) {
    const job = inst.jobs[j], jm = B.maps.jobs[j], r = reqs[job.requestId];
    const nodes = job.candidates.map((c) => inst.nodes[c.node]);
    if (r.mobility === 'fixed' || r.directOnly) {
      fixed++;
      assert.equal(nodes.length, 1, job.id);
      assert.equal(nodes[0].kind, 'direct');
      assert.equal(nodes[0].key, 'direct:' + r.id);
      continue;
    }
    if (jm.directFallback) { assert.equal(nodes[0].kind, 'direct'); continue; }
    const radius = r.maxTravelMi ?? baseState.scenario.settings.mobility[r.mobility].radiusMi;
    const perMi = baseState.scenario.settings.mobility[r.mobility].costPerMi;
    assert.ok(nodes.every((n) => n.kind === 'rally'), job.id);
    assert.ok(job.candidates.length <= E.MAX_RALLY_CANDIDATES + 2);
    for (const c of job.candidates) {
      assert.ok(c.platoonMiles <= radius + 1e-6, job.id + ' within ' + radius + ' mi');
      assert.ok(Math.abs(c.platoonCost - c.platoonMiles * 2 * perMi) < 1e-6, 'platoonCost = miles x 2 x costPerMi');
    }
    if (r.mobility === 'dismounted') {
      dismounted++;
      assert.equal(radius, 5);
      // road miles, not straight line: check one pair against the road router
      const n = inst.nodes[job.candidates[0].node];
      const m = SRO.core.roads.matrix([{ lat: r.lat, lon: r.lon }, { lat: n.lat, lon: n.lon }]);
      assert.ok(Math.abs(m.miles[0][1] - job.candidates[0].platoonMiles) < 0.05, job.id + ' road miles');
      assert.ok(job.candidates[0].platoonMiles + 1e-9 >= SRO.core.geo.haversineMi(r, n));
    }
  }
  assert.ok(fixed >= 1, 'samples include a fixed-in-place platoon');
  assert.ok(dismounted >= 1, 'samples include a dismounted platoon with a rally point in reach');
  // a fallback platoon (no rally point within its radius) is warned about and delivered direct
  for (const jm of B.maps.jobs.filter((x) => x.directFallback)) {
    assert.ok(B.warnings.some((w) => w.startsWith(jm.requestId)), jm.requestId + ' warned');
  }
  // forceDirect: only the direct node
  const st = demoStore();
  assert.ok(st.dispatch({ type: 'request/lock', requestId: 'R-0020', forceDirect: true }).ok);
  const b2 = E.buildInstance(st.getState(), {});
  for (const j of b2.instance.jobs.filter((x) => x.requestId === 'R-0020')) {
    assert.deepEqual(Array.from(j.candidates, (c) => b2.instance.nodes[c.node].key), ['direct:R-0020']);
  }
  // locked to a truck: lockedTruck set when the truck can carry it, ignored (with a warning) otherwise
  st.dispatch({ type: 'request/lock', requestId: 'R-0020', truckId: 'Bravo-1', forceDirect: false });
  const b3 = E.buildInstance(st.getState(), {});
  const fuel = b3.instance.jobs.find((x) => x.id === 'R-0020/fuel'), cargo = b3.instance.jobs.find((x) => x.id === 'R-0020/cargo');
  assert.equal(fuel.lockedTruck, 'Bravo-1');
  assert.equal(cargo.lockedTruck, null, 'a tanker cannot carry the cargo job');
  assert.deepEqual(problems(b3.instance), []);
});

test('a fractional travel radius prints rounded in the build warnings (no float noise)', () => {
  const s = demoStore().getState();
  const r0 = s.requests.find((r) => r.mobility === 'mounted' && !r.directOnly);
  const state = Object.assign({}, s, { requests: s.requests.map((r) => (r === r0 ? Object.assign({}, r, { maxTravelMi: 0.1 + 0.2 }) : r)) });
  const w = E.buildInstance(state, {}).warnings.filter((x) => x.startsWith(r0.id));
  assert.ok(w.length && w.every((x) => / within 0\.3 mi by road/.test(x)), JSON.stringify(w));
});

test('convoy factor scales travel minutes, not miles', () => {
  const st = demoStore();
  st.dispatch({ type: 'settings/update', path: 'convoyFactor', value: 1 });
  const b1 = E.buildInstance(st.getState(), {});
  const f = baseState.scenario.settings.convoyFactor;
  assert.equal(f, 1.5);
  assert.equal(B.maps.convoyFactor, 1.5);
  const k1 = keyIdx(b1.instance), k0 = keyIdx(B.instance);
  let checked = 0;
  for (const a of Object.keys(k0)) for (const b of Object.keys(k0)) {
    const t0 = B.instance.minutes[k0[a]][k0[b]], t1 = b1.instance.minutes[k1[a]][k1[b]];
    if (!(t1 > 0 && t1 < Infinity)) continue;
    assert.ok(Math.abs(t0 - t1 * f) < 1e-6 * t0, a + ' -> ' + b);
    assert.equal(B.instance.miles[k0[a]][k0[b]], b1.instance.miles[k1[a]][k1[b]]);
    checked++;
  }
  assert.ok(checked > 100);
});

test('risk zones add risk units on arcs through them; closed zones make arcs longer or unreachable', () => {
  const k = keyIdx(B.instance);
  const i = k['hub:HUB-GRANITE'], j = k['hub:HUB-JADE'];
  const p = B.maps.path(i, j);
  assert.ok(p && p.coords.length > 10, 'road path between hubs');
  assert.equal(p.source, 'osm-roads');
  const mid = p.coords[Math.floor(p.coords.length / 2)];
  assert.equal(B.instance.riskUnits[i][j], 0);

  const st = demoStore();
  assert.ok(st.dispatch({ type: 'zone/add', zone: { kind: 'risk', rating: 'High', lat: mid[0], lon: mid[1], radiusMi: 3 } }).ok);
  const br = E.buildInstance(st.getState(), {});
  const kr = keyIdx(br.instance);
  const ru = br.instance.riskUnits[kr['hub:HUB-GRANITE']][kr['hub:HUB-JADE']];
  assert.ok(ru > 0, 'risk units through the zone');
  // = miles of the arc's road path inside the circle x rating (High = 6)
  const inside = SRO.core.geo.polylineMilesInCircle(p.coords, { lat: mid[0], lon: mid[1], radiusMi: 3 });
  assert.ok(Math.abs(ru - 6 * inside) < 0.05 * ru + 0.01, ru + ' vs 6 x ' + inside);
  // an arc nowhere near it stays at 0
  assert.equal(br.instance.riskUnits[kr['hub:HUB-ANVIL']][kr['hub:HUB-LOTUS']], 0);
  // travel itself does not change with a risk zone
  assert.equal(br.instance.minutes[kr['hub:HUB-GRANITE']][kr['hub:HUB-JADE']], B.instance.minutes[i][j]);

  const sc = demoStore();
  assert.ok(sc.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: mid[0], lon: mid[1], radiusMi: 1 } }).ok);
  const bc = E.buildInstance(sc.getState(), {});
  const kc = keyIdx(bc.instance);
  const before = B.instance.minutes[i][j], after = bc.instance.minutes[kc['hub:HUB-GRANITE']][kc['hub:HUB-JADE']];
  assert.ok(after > before + 0.5 || after === Infinity, 'detour or unreachable: ' + before + ' -> ' + after);
  assert.deepEqual(problems(bc.instance), []);
  // the detour avoids the closed circle
  const pc = bc.maps.path(kc['hub:HUB-GRANITE'], kc['hub:HUB-JADE']);
  if (after < Infinity) {
    const z = { lat: mid[0], lon: mid[1], radiusMi: 1 };
    assert.ok(!SRO.core.geo.polylineIntersectsCircle(pc.coords, z), 'detour stays out of the closed zone');
  }
});

test('decodePlan: Plan schema, road paths per leg, per-line deliveries, byRequest index', () => {
  const res = quickSolve(B);
  const plan = E.decodePlan(B, res, { method: 'tabu', runtimeSec: res.elapsedSec });
  for (const k of ['windowId', 'name', 'method', 'createdAt', 'runtimeSec', 'mipGap', 'cancelled', 'parentPlanId', 'rallyPoints', 'routes', 'deferred', 'late', 'cost', 'stats', 'approved', 'byRequest']) {
    assert.ok(k in plan, 'plan.' + k);
  }
  assert.equal(plan.approved, false);
  assert.equal(plan.cancelled, false);
  assert.equal(plan.windowId, 'W-D1-0600');
  assert.equal(plan.method, 'tabu');
  assert.ok(Math.abs(plan.cost.total - res.total) < 0.01);
  assert.ok(plan.routes.length >= 1);
  const G = SRO.core.geo;
  for (const rt of plan.routes) {
    for (const k of ['truckId', 'type', 'color', 'loadStart', 'depart', 'returnAt', 'stops', 'legs', 'miles', 'gallons', 'riskUnits', 'cost']) assert.ok(k in rt, 'route.' + k);
    assert.equal(rt.legs.length, rt.stops.length + 1, rt.truckId + ': out, between stops, home');
    rt.stops.forEach((s, n) => {
      assert.equal(s.seq, n + 1);
      for (const k of ['nodeKey', 'kind', 'gridId', 'lat', 'lon', 'label', 'arrive', 'depart', 'period', 'deliveries', 'pickups', 'etaText']) assert.ok(k in s, 'stop.' + k);
      assert.match(s.etaText, /^(\d{4}|D\+\d+ \d{4}|.*\d{4}.*)$/);
      assert.ok(s.deliveries.length >= 1);
      for (const d of s.deliveries) for (const k of ['requestId', 'lineIdx', 'qty', 'unit', 'classId']) assert.ok(k in d, 'delivery.' + k);
      assert.equal(rt.legs[n].toKey, s.nodeKey);
    });
    assert.equal(rt.legs[0].fromKey, 'hub:' + B.maps.vehicles[B.maps.vehicleIndex[rt.truckId]].hubId);
    for (const l of rt.legs) {
      for (const k of ['fromKey', 'toKey', 'gridPath', 'depart', 'arrive', 'miles', 'riskUnits', 'period', 'path']) assert.ok(k in l, 'leg.' + k);
      assert.equal(typeof l.path, 'string');
      assert.ok(l.path.length > 4, 'encoded road path');
      const c = E.legCoords(l);
      assert.ok(c.length >= 2);
      const from = B.instance.nodes[B.maps.nodeIndex[l.fromKey]], to = B.instance.nodes[B.maps.nodeIndex[l.toKey]];
      assert.ok(G.haversineMi({ lat: c[0][0], lon: c[0][1] }, from) < 1.5, 'path starts at its node');
      assert.ok(G.haversineMi({ lat: c[c.length - 1][0], lon: c[c.length - 1][1] }, to) < 1.5, 'path ends at its node');
      assert.ok(Math.abs(G.polylineLength(c) - l.miles) < Math.max(1, 0.05 * l.miles), 'path length ~ leg miles');
    }
  }
  // every request line: delivered + deferred = requested (quantities in the line's unit)
  for (const r of baseState.requests) {
    const e = plan.byRequest[r.id];
    assert.ok(e, r.id + ' in byRequest');
    r.lines.forEach((line, idx) => {
      const got = (e.qtyByLine[idx] || 0) + (e.deferredQty[idx] || 0);
      assert.ok(Math.abs(got - line.qty) < 1e-6, r.id + ' line ' + idx + ': ' + got + ' of ' + line.qty);
    });
    if (e.truckId) {
      const rt = plan.routes.find((x) => x.truckId === e.truckId);
      const s = rt.stops[e.stopSeq - 1];
      assert.equal(s.nodeKey, e.nodeKey);
      assert.equal(e.eta, s.arrive);
      assert.equal(e.stopsBefore, e.stopSeq - 1);
      assert.ok(['rally', 'direct'].includes(e.nodeKind));
    } else assert.equal(e.status, 'deferred');
  }
  for (const d of plan.deferred) for (const k of ['requestId', 'lineIdx', 'qty', 'unit', 'reason', 'note']) assert.ok(k in d, 'deferred.' + k);
  // map helper
  const mr = E.mapRoutes(plan);
  assert.equal(mr.length, plan.routes.length);
  assert.ok(Array.isArray(mr[0].legs[0].coords) && mr[0].legs[0].coords.length >= 2);
  // the stored plan survives JSON (localStorage) and stays small
  const json = JSON.stringify(plan, SRO.util.jsonReplacer);
  assert.ok(json.length < 150000, 'plan JSON ' + json.length + ' bytes');
  assert.equal(JSON.stringify(plain(plan), SRO.util.jsonReplacer), json, 'JSON round trip');
});

test('shouldPlan, pendingRequests, activePlan', () => {
  const st = demoStore();
  assert.equal(E.shouldPlan(st.getState()), false, 'no plan request yet');
  st.dispatch({ type: 'window/planNow' });
  assert.equal(E.shouldPlan(st.getState()), true);
  assert.equal(E.pendingRequests(st.getState()).length, 20);
  st.dispatch({ type: 'window/planHandled' });
  assert.equal(E.shouldPlan(st.getState()), false);
  // boundary crossing with pending requests
  st.dispatch({ type: 'clock/tick', simMin: 721 });
  assert.equal(st.getState().ui.planRequestReason, 'boundary');
  assert.equal(E.shouldPlan(st.getState()), true);
  assert.equal(E.activePlan(st.getState()), null);
  const empty = SRO.core.store.createStore({ adapter: null });
  empty.dispatch({ type: 'window/planNow' });
  assert.equal(E.shouldPlan(empty.getState()), false, 'nothing pending');
});

// approved plan, clock moved past some first stops, one truck out
function contingencyFixture() {
  const st = demoStore();
  const b = E.buildInstance(st.getState(), {});
  const plan = E.decodePlan(b, quickSolve(b), { method: 'tabu' });
  const id = st.dispatch({ type: 'plan/store', plan }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id }).ok);
  const p = st.getState().plans.find((x) => x.id === id);
  const firsts = p.routes.filter((r) => r.stops.length).map((r) => r.stops[0].arrive).sort((a, c) => a - c);
  const now = Math.ceil(firsts[Math.min(2, firsts.length - 1)] + 1);
  st.dispatch({ type: 'clock/tick', simMin: now });
  // a truck that has stops still ahead
  const out = p.routes.find((r) => r.stops.some((s) => s.arrive > now));
  st.dispatch({ type: 'truck/markOut', truckId: out.truckId, reason: 'Blown tire' });
  return { st, parent: p, now, outId: out.truckId };
}

test('contingency instance: delivered kept, en-route trucks preloaded and locked, out truck loads back to the pool', () => {
  const { st, parent, now, outId } = contingencyFixture();
  const b = E.buildInstance(st.getState(), { contingency: true });
  const inst = b.instance;
  assert.deepEqual(problems(inst), []);
  assert.equal(inst.startMin, now);
  assert.equal(inst.fixed.parentPlanId, parent.id);
  assert.equal(b.maps.parentPlanId, parent.id);
  assert.ok(!inst.vehicles.some((v) => v.id === outId), 'truck marked out is not in the plan');
  const k = (rid, g) => rid + '|' + g;
  const baseQ = {}, doneQ = {}, onboard = {};
  for (const rt of parent.routes) {
    const departed = rt.depart <= now;
    const nextIdx = rt.stops.findIndex((s) => !(s.arrive <= now));
    rt.stops.forEach((s, i) => s.deliveries.forEach((d) => {
      baseQ[k(d.requestId, d.group)] = (baseQ[k(d.requestId, d.group)] || 0) + d.loadQty;
      if (departed && s.arrive <= now) doneQ[k(d.requestId, d.group)] = (doneQ[k(d.requestId, d.group)] || 0) + d.loadQty;
      else if (rt.truckId !== outId && departed && nextIdx >= 0 && i >= nextIdx) {
        const key = rt.truckId + '|' + k(d.requestId, d.group);
        onboard[key] = (onboard[key] || 0) + d.loadQty;
      }
    }));
  }
  for (const d of parent.deferred) baseQ[k(d.requestId, d.group)] = (baseQ[k(d.requestId, d.group)] || 0) + d.loadQty;
  // delivered loads are recorded and not planned again
  assert.ok(Object.keys(doneQ).length >= 1, 'some stops are done');
  for (const x of inst.fixed.delivered) assert.ok(Math.abs(doneQ[k(x.requestId, x.group)] - x.qty) < 1e-6);
  assert.equal(inst.fixed.delivered.length, Object.keys(doneQ).length);
  // en-route trucks: start at their next stop, preloaded, carry exactly their onboard jobs (locked)
  let enroute = 0;
  for (const rt of parent.routes) {
    if (rt.truckId === outId || !(rt.depart <= now)) continue;
    const nextIdx = rt.stops.findIndex((s) => !(s.arrive <= now));
    const v = inst.vehicles.find((x) => x.id === rt.truckId);
    assert.ok(v, rt.truckId);
    if (nextIdx < 0) { assert.ok(!v.preloaded, rt.truckId + ' is heading home'); continue; }
    enroute++;
    assert.equal(v.preloaded, true);
    assert.equal(inst.nodes[v.startNode].key, rt.stops[nextIdx].nodeKey);
    assert.equal(v.availableAt, rt.stops[nextIdx].arrive);
    const mine = inst.jobs.filter((j) => j.lockedTruck === v.id && j.id.endsWith('@' + v.id));
    assert.ok(mine.length >= 1);
    let carried = 0;
    for (const j of mine) {
      carried += j.qty;
      assert.ok(Math.abs(onboard[v.id + '|' + k(j.requestId, j.group)] - j.qty) < 1e-6, j.id);
    }
    assert.ok(Math.abs(v.capacity - carried) < 1e-6, v.id + ' capacity = what it carries');
    assert.ok(inst.fixed.enRoute.some((x) => x.truckId === v.id && x.startNode === v.startNode));
  }
  assert.ok(enroute >= 1, 'at least one truck is en route');
  // quantities conserved: delivered + still planned = the parent plan's total per request and group
  const left = {};
  for (const j of inst.jobs) left[k(j.requestId, j.group)] = (left[k(j.requestId, j.group)] || 0) + j.qty;
  for (const key of Object.keys(baseQ)) {
    const total = (doneQ[key] || 0) + (left[key] || 0);
    assert.ok(Math.abs(total - baseQ[key]) < 1e-5, key + ': ' + total + ' vs ' + baseQ[key]);
  }
  // the out truck's undelivered loads are pool jobs (no lock)
  const outRoute = parent.routes.find((r) => r.truckId === outId);
  for (const s of outRoute.stops.filter((x) => x.arrive > now)) {
    for (const d of s.deliveries) {
      const pool = inst.jobs.find((j) => j.requestId === d.requestId && j.group === d.group && !j.id.includes('@'));
      assert.ok(pool && pool.lockedTruck === null, d.requestId + ' back in the pool');
    }
  }
  // warm start: the adjusted old plan is feasible on the new instance
  b.parentPlan = parent;
  const start = E.contingencyStart(b);
  assert.ok(start, 'adjusted old plan');
  assert.equal(Sv.evaluate(inst, start, { costOnly: true }).feasible, true);
});

test('fixPreloaded: en-route trucks carry only what is on board', () => {
  const { st, parent } = contingencyFixture();
  const b = E.buildInstance(st.getState(), { contingency: true });
  const inst = b.instance;
  const vi = inst.vehicles.findIndex((v) => v.preloaded);
  const v = inst.vehicles[vi];
  const own = inst.jobs.map((j, i) => i).filter((i) => b.maps.jobs[i].origin === 'onboard' && b.maps.jobs[i].lockedTruck === v.id);
  const pool = inst.jobs.map((j, i) => i).find((i) => b.maps.jobs[i].origin === 'pool' && Sv.typeCompatible(v, inst.jobs[i]) && !inst.jobs[i].lockedTruck);
  assert.ok(own.length && pool !== undefined);
  // a bad solution: the pool job rides on the preloaded truck, its onboard load is left out
  const node = inst.jobs[pool].candidates[0].node;
  const bad = { routes: [{ vehicle: vi, visits: [{ node, jobs: [{ job: pool, qty: Math.min(inst.jobs[pool].qty, v.capacity) }] }] }] };
  const fixed = E.fixPreloaded(b, bad);
  assert.notEqual(fixed, bad);
  const r = fixed.routes.find((x) => x.vehicle === vi);
  const carried = r.visits.flatMap((x) => x.jobs.map((c) => c.job));
  assert.ok(!carried.includes(pool) || false, 'pool job taken off the en-route truck');
  for (const j of own) assert.ok(carried.includes(j), 'onboard job ' + inst.jobs[j].id + ' back on its truck');
  const ev = Sv.evaluate(inst, fixed);
  assert.equal(ev.violations.length, 0);
  // decodePlan applies it and says so
  const plan = E.decodePlan(Object.assign(b, { parentPlan: parent }), { solution: bad }, { method: 'tabu' });
  assert.ok(plan.warnings.some((w) => /already on the road/.test(w)));
  // a good solution comes back unchanged
  const start = E.contingencyStart(b);
  assert.equal(E.fixPreloaded(b, start), start);
});

// ---- fix review (2026-10-06): en-route trucks, rally limit, warm start, infeasible approve ----------
test('fixPreloaded: an onboard load goes back on its truck only within maxRallyPoints, else it waits with a note', () => {
  // Before the fix the repair re-inserted onboard loads at any rally point, so a plan at the limit came
  // out with one more (too-many-rally, 1e7 per violation): on a loaded machine the banned-rally test
  // below failed that way (tabu cut short -> pool jobs on the en-route truck -> repair over the limit).
  const { st, parent } = contingencyFixture();
  const b = E.buildInstance(st.getState(), { contingency: true });
  b.parentPlan = parent;
  const inst = b.instance;
  const start = E.contingencyStart(b);
  const P = Sv.prepare(inst);
  let capped = 0;
  inst.vehicles.forEach((v, vi) => {
    if (!v.preloaded) return;
    // the truck's onboard loads left out; the rest of the plan uses exactly the rally points allowed
    const bad = { routes: start.routes.filter((r) => r.vehicle !== vi && r.visits.length) };
    const used = new Set(bad.routes.flatMap((r) => r.visits.map((x) => x.node)).filter((n) => P.isRally[n]));
    const keep = inst.params.maxRallyPoints;
    inst.params.maxRallyPoints = used.size;
    try {
      const notes = [];
      const fixed = E.fixPreloaded(b, bad, notes);
      const ev = Sv.evaluate(inst, fixed);
      assert.deepEqual(Array.from(ev.violations, (x) => x.code), [], v.id + ': within the limit');
      const got = {};
      for (const r of fixed.routes) for (const vs of r.visits) for (const c of vs.jobs) got[c.job] = (got[c.job] || 0) + c.qty;
      inst.jobs.forEach((j, i) => {
        if (b.maps.jobs[i].origin !== 'onboard' || j.lockedTruck !== v.id) return;
        if (Math.abs((got[i] || 0) - j.qty) < 1e-6) return;
        capped++;
        assert.ok(notes.some((n) => n.startsWith(j.requestId + ': the load on board ' + v.id + ' has no pickup point left within the limit of ' + (used.size + b.maps.doneRally) + ' rally points')), j.id + ' named in a note');
      });
    } finally { inst.params.maxRallyPoints = keep; }
  });
  assert.ok(capped >= 1, 'the limit kept at least one onboard load on its truck');
});

test('decodePlan: a re-plan keeps the warm start when the solver plan is worse, and says so', () => {
  const { st, parent } = contingencyFixture();
  const b = E.buildInstance(st.getState(), { contingency: true });
  b.parentPlan = parent;
  const start = E.contingencyStart(b);
  const startTotal = Sv.evaluate(b.instance, start, { costOnly: true }).total;
  const empty = { routes: [] };                                 // everything deferred: far worse
  const kept = E.decodePlan(b, { solution: empty }, { method: 'tabu', start });
  assert.ok(Math.abs(kept.cost.total - startTotal) < 0.01, kept.cost.total + ' vs start ' + startTotal);
  assert.ok(kept.warnings.some((w) => /nothing better than the current plan/.test(w)));
  assert.equal(kept.stats.violations, 0);
  assert.deepEqual(Array.from(kept.violations), []);
  // without a start the solver plan is decoded as it is
  const raw = E.decodePlan(b, { solution: empty }, { method: 'tabu' });
  assert.ok(raw.cost.total > startTotal);
  assert.ok(!raw.warnings.some((w) => /nothing better/.test(w)));
  // a better solver plan wins over the start
  const better = Sv.localSearch(b.instance, start, { seed: 3, timeLimitMs: 2000 });
  const betterTotal = Sv.evaluate(b.instance, better, { costOnly: true }).total;
  const got = E.decodePlan(b, { solution: better }, { method: 'tabu', start });
  assert.ok(Math.abs(got.cost.total - Math.min(betterTotal, startTotal)) < 0.01);
});

test('planChanges: moved, eta, delayed, restored, added, dropped', () => {
  const e = (truckId, nodeKey, eta, status = 'planned') => ({ truckId, gridId: nodeKey, label: nodeKey, eta, status, stops: truckId ? [{ truckId, nodeKey, eta }] : [] });
  const before = { byRequest: { A: e('T1', 'n1', 100), B: e('T1', 'n2', 200), C: e('T2', 'n3', 300), D: e(null, null, null, 'deferred'), F: e('T3', 'n4', 50), G: e('T3', 'n5', 60) } };
  const after = { byRequest: { A: e('T2', 'n1', 100), B: e('T1', 'n2', 260), C: e(null, null, null, 'deferred'), D: e('T1', 'n1', 120), E: e('T1', 'n1', 130), G: e('T3', 'n5', 60.2) } };
  const kinds = Object.fromEntries(E.planChanges(before, after).map((c) => [c.requestId, c.kind]));
  assert.deepEqual(kinds, { A: 'moved', B: 'eta', C: 'delayed', D: 'restored', E: 'added', F: 'dropped' });
});

// ---- review checks (2026-10-06): numbers shown to users, multiple batches, cut-off trucks, locks ----
test('decodePlan numbers match evaluate(): stop times, ETA text, stops before yours, loads, deferral reasons', () => {
  const res = quickSolve(B);
  const plan = E.decodePlan(B, res, { method: 'tabu' });
  const inst = B.instance;
  const ev = Sv.evaluate(inst, res.solution);
  const F = SRO.core.format;
  assert.ok(Math.abs(plan.cost.total - ev.total) < 0.01);
  assert.equal(plan.stats.stops, ev.stats.stops);
  assert.equal(plan.stats.trucksUsed, ev.stats.trucksUsed);
  // settings.maxStops is a soft guide: above it the plan says so
  assert.equal(B.maps.maxStops, 20);
  assert.ok(!plan.warnings.some((w) => /stop guide/.test(w)));
  const tight = E.decodePlan(Object.assign({}, B, { maps: Object.assign({}, B.maps, { maxStops: 5 }) }), res, { method: 'tabu' });
  assert.ok(tight.warnings.includes('This plan has ' + ev.stats.stops + ' stops, more than the 5-stop guide for one window.'));
  // routes: the decoded schedule is evaluate()'s schedule
  for (const r of ev.routes) {
    const v = inst.vehicles[r.vehicle];
    const pr = plan.routes.find((x) => x.truckId === v.id);
    assert.ok(pr, v.id);
    assert.equal(pr.depart, r.depart);
    assert.equal(pr.returnAt, r.returnAt);
    assert.ok(Math.abs(pr.miles - r.miles) < 0.01);
    assert.equal(pr.stops.length, r.stops.length);
    r.stops.forEach((s, k) => {
      const ps = pr.stops[k];
      assert.equal(ps.nodeKey, inst.nodes[s.node].key);
      assert.equal(ps.arrive, s.arrive, v.id + ' stop ' + (k + 1) + ' arrive');
      assert.equal(ps.depart, s.depart);
      assert.equal(ps.etaText, F.dayTime(s.arrive, inst.startMin));
    });
  }
  // delivered loads per job = evaluate's delivered; deferred lines carry explainDeferred's reason
  const load = new Map();
  for (const rt of plan.routes) for (const s of rt.stops) for (const d of s.deliveries) load.set(d.jobId, (load.get(d.jobId) || 0) + d.loadQty);
  inst.jobs.forEach((jb, j) => assert.ok(Math.abs((load.get(jb.id) || 0) - ev.delivered[j]) < 1e-4, jb.id + ' delivered load'));
  for (const x of Sv.explainDeferred(inst, ev)) {
    const lines = plan.deferred.filter((d) => d.jobId === inst.jobs[x.job].id);
    assert.ok(lines.length >= 1, inst.jobs[x.job].id + ' deferred lines');
    for (const d of lines) assert.equal(d.reason, x.reason);
    const e = plan.byRequest[inst.jobs[x.job].requestId];
    assert.ok(e.deferReason && e.deferNote !== undefined);
  }
  // byRequest: the first arrival of the request, its truck and the stops before it on that truck
  for (const [rid, e] of Object.entries(plan.byRequest)) {
    const arr = [];
    ev.routes.forEach((r) => r.stops.forEach((s, k) => {
      if (s.jobs.some((c) => inst.jobs[c.job].requestId === rid && c.qty > 0)) arr.push({ t: s.arrive, k, v: inst.vehicles[r.vehicle].id });
    }));
    arr.sort((a, b) => a.t - b.t);
    if (!arr.length) { assert.equal(e.truckId, null, rid); assert.equal(e.status, 'deferred'); continue; }
    assert.equal(e.eta, arr[0].t, rid + ' eta');
    assert.equal(e.etaText, F.dayTime(arr[0].t, inst.startMin));
    assert.equal(e.truckId, arr[0].v, rid + ' truck');
    assert.equal(e.stopsBefore, arr[0].k, rid + ' stops before yours');
    const late = ev.late.filter((x) => inst.jobs[x.job].requestId === rid).map((x) => x.minutesLate);
    assert.equal(e.minutesLate, late.length ? Math.round(Math.max(...late)) : 0);
  }
});

test('a second batch in the same window keeps the first batch approved; an alternative of the same batch replaces it', () => {
  const st = demoStore();
  const b1 = E.buildInstance(st.getState(), {});
  assert.deepEqual(Array.from(b1.maps.builtOn), []);
  const alt = E.decodePlan(b1, quickSolve(b1, 100), { method: 'tabu' });       // drafted before approval
  const id1 = st.dispatch({ type: 'plan/store', plan: E.decodePlan(b1, quickSolve(b1), { method: 'tabu' }) }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id1 }).ok);
  // a new request after approval: the next plan covers only it and is built on the approved plan
  st.dispatch({ type: 'clock/tick', simMin: 380 });
  const r = st.dispatch({ type: 'request/submit', request: Object.assign({}, USER_REQUEST, { unitName: '3rd PLT, C CO, 1-12 IN', designator: '3/C/1-12IN', nlt: 900 }) });
  assert.ok(r.ok, r.error);
  const b2 = E.buildInstance(st.getState(), {});
  const inB2 = new Set(b2.instance.jobs.map((j) => j.requestId));
  assert.ok(inB2.has(r.id));
  for (const q of inB2) {
    const status = st.getState().requests.find((x) => x.id === q).status;
    assert.ok(q === r.id || status === 'delayed' || status === 'partial', q + ' (' + status + ') is open work, not an approved delivery');
  }
  const p2 = E.decodePlan(b2, quickSolve(b2), { method: 'tabu' });
  assert.deepEqual(Array.from(p2.builtOn), [id1]);
  assert.equal(p2.windowId, st.getState().plans.find((p) => p.id === id1).windowId, 'same window');
  const id2 = st.dispatch({ type: 'plan/store', plan: p2 }).id;
  const a2 = st.dispatch({ type: 'plan/approve', planId: id2 });
  assert.ok(a2.ok);
  assert.equal(a2.supersededPlanId, null, 'the first batch stays approved');
  const s = st.getState();
  assert.ok(s.plans.find((p) => p.id === id1).approved && !s.plans.find((p) => p.id === id1).superseded);
  // every request of both batches finishes on the clock
  st.dispatch({ type: 'clock/tick', simMin: 4000 });
  for (const q of st.getState().requests) assert.ok(['delivered', 'partial', 'delayed'].includes(q.status), q.id + ' ' + q.status);
  // an alternative drafted for the first batch (before approval) still replaces the first batch
  const idAlt = st.dispatch({ type: 'plan/store', plan: alt }).id;
  const aAlt = st.dispatch({ type: 'plan/approve', planId: idAlt });
  assert.equal(aAlt.supersededPlanId, id1);
  assert.equal(st.getState().plans.find((p) => p.id === id2).superseded, false, 'the second batch is not touched');
});

test('contingency: an en-route truck cut off by a closure keeps its done stops; every line adds up in the re-plan', () => {
  const st = demoStore();
  const b = E.buildInstance(st.getState(), {});
  const id = st.dispatch({ type: 'plan/store', plan: E.decodePlan(b, quickSolve(b), { method: 'tabu' }) }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id }).ok);
  const ap = st.getState().plans.find((p) => p.id === id);
  const rt = ap.routes.filter((r) => r.stops.length >= 2).sort((a, c) => a.stops[0].arrive - c.stops[0].arrive)[0];
  assert.ok(rt, 'a truck with two stops');
  const now = Math.ceil(rt.stops[0].arrive + 1);
  assert.ok(now < rt.stops[1].arrive);
  st.dispatch({ type: 'clock/tick', simMin: now });
  // the closure is around the stop the truck is at (it has not left yet). This test closed the next
  // stop before 2026-10-06; that truck now turns back where it is instead (next test), since it is
  // outside the closure and has a road home.
  const here = rt.stops[0];
  assert.ok(st.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: here.lat, lon: here.lon, radiusMi: 3, label: 'Cut' } }).ok);
  const bc = E.buildInstance(st.getState(), { contingency: true });
  assert.deepEqual(problems(bc.instance), []);
  assert.ok(bc.warnings.some((w) => w.includes('Truck ' + rt.truckId + ' is cut off')), 'cut off: ' + bc.warnings.join(' | '));
  assert.ok(!bc.instance.vehicles.some((v) => v.id === rt.truckId));
  bc.parentPlan = ap;
  const p2 = E.decodePlan(bc, quickSolve(bc), { method: 'tabu' });
  const r2 = p2.routes.find((r) => r.truckId === rt.truckId);
  assert.ok(r2, 'the cut-off truck stays on the plan');
  assert.equal(r2.cutOff, true);
  assert.equal(r2.returnAt, null, 'return time unknown');
  assert.deepEqual(Array.from(r2.stops, (s) => [s.nodeKey, s.done]), [[rt.stops[0].nodeKey, true]]);
  const doneBefore = ap.routes.flatMap((r) => r.stops.filter((s) => s.arrive <= now).map((s) => r.truckId + '@' + s.nodeKey));
  const doneAfter = p2.routes.flatMap((r) => r.stops.filter((s) => s.done).map((s) => r.truckId + '@' + s.nodeKey));
  for (const d of doneBefore) assert.ok(doneAfter.includes(d), d + ' kept as done');
  // done stops count in qtyByLine: delivered (done or planned) + deferred = requested, per line
  for (const q of st.getState().requests) {
    const e = p2.byRequest[q.id];
    assert.ok(e, q.id + ' in byRequest');
    q.lines.forEach((l, i) => {
      const got = (e.qtyByLine[i] || 0) + (e.deferredQty[i] || 0);
      assert.ok(Math.abs(got - l.qty) < 1e-6, q.id + ' line ' + i + ': ' + got + ' of ' + l.qty);
    });
  }
  // approving keeps the cut-off truck's old return time (not available at once)
  const before = st.getState().scenario.fleet.find((t) => t.id === rt.truckId).availableAt;
  const id2 = st.dispatch({ type: 'plan/store', plan: p2 }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id2 }).ok);
  assert.equal(st.getState().scenario.fleet.find((t) => t.id === rt.truckId).availableAt, before);
});

test('contingency: a closure on the road ahead of an en-route truck turns it back where it is', () => {
  // psg-lint roadlate: before the fix the truck kept its next stop and old ETA, driving through the
  // closure, and the platoons it serves were not told (updated stayed false).
  const st = demoStore();
  const b = E.buildInstance(st.getState(), {});
  const id = st.dispatch({ type: 'plan/store', plan: E.decodePlan(b, quickSolve(b), { method: 'tabu' }) }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id }).ok);
  const ap = st.getState().plans.find((p) => p.id === id);
  // the truck with the longest first leg, 40 % of the way along it; the road closed at 75 %
  const rt = ap.routes.filter((r) => r.stops.length && r.legs.length).sort((a, c) => (c.legs[0].arrive - c.legs[0].depart) - (a.legs[0].arrive - a.legs[0].depart))[0];
  const leg = rt.legs[0], co = E.legCoords(leg);
  const now = Math.ceil(leg.depart + 0.4 * (leg.arrive - leg.depart));
  const zp = SRO.core.geo.interpolateAlong(co, 0.75);
  const zone = { kind: 'closed', lat: zp.lat, lon: zp.lon, radiusMi: 1, label: 'Bridge out' };
  st.dispatch({ type: 'clock/tick', simMin: now });
  assert.ok(st.dispatch({ type: 'zone/add', zone }).ok);
  const bc = E.buildInstance(st.getState(), { contingency: true });
  assert.deepEqual(problems(bc.instance), []);
  bc.parentPlan = ap;
  const v = bc.instance.vehicles.find((x) => x.id === rt.truckId);
  assert.ok(v && v.preloaded);
  const startNode = bc.instance.nodes[v.startNode];
  assert.equal(startNode.key, 'pos:' + rt.truckId, 'starts where it is, not at its next stop');
  assert.equal(v.availableAt, now);
  assert.ok(SRO.core.geo.haversineMi(startNode, zone) > zone.radiusMi, 'outside the closure');
  assert.ok(SRO.core.geo.haversineMi(startNode, SRO.core.geo.interpolateAlong(co, 0.4)) < 0.5, 'where the map shows the truck');
  assert.ok(bc.warnings.includes('Truck ' + rt.truckId + ' is driving into a closed road (Bridge out) on its way to ' + rt.stops[0].label +
    '; it turns back where it is and is re-routed from there.'));
  assert.ok(E.contingencyStart(bc), 'warm start from the turn-back point');
  const p2 = E.decodePlan(bc, quickSolve(bc), { method: 'tabu', start: E.contingencyStart(bc) });
  assert.equal(p2.stats.violations, 0);
  const r2 = p2.routes.find((r) => r.truckId === rt.truckId);
  // the leg driven so far ends at the turn-back point now; every leg from there avoids the closure
  assert.deepEqual([r2.legs[0].fromKey, r2.legs[0].toKey, r2.legs[0].turnedBack, r2.legs[0].arrive], [leg.fromKey, 'pos:' + rt.truckId, true, now]);
  assert.ok(r2.legs[0].miles > 0 && r2.legs[0].miles < leg.miles);
  for (const l of r2.legs) if (!l.turnedBack) assert.ok(!SRO.core.geo.polylineIntersectsCircle(E.legCoords(l), zone), l.fromKey + ' -> ' + l.toKey + ' avoids the closure');
  assert.equal(r2.legs[1].fromKey, 'pos:' + rt.truckId);
  assert.equal(r2.legs[1].depart, now);
  // approving tells the platoons of that truck whose pickup or ETA changed
  const old = new Set(rt.stops.flatMap((s) => s.deliveries.map((d) => d.requestId)));
  assert.ok(st.dispatch({ type: 'plan/approve', planId: st.dispatch({ type: 'plan/store', plan: p2 }).id }).ok);
  const upd = st.getState().requests.filter((r) => old.has(r.id) && r.updated);
  assert.ok(upd.length >= 1, 'a platoon of ' + rt.truckId + ' is told');
  // a later re-plan keeps the turn-back leg and the legs to the stops made since
  const p2s = st.getState().plans.find((p) => p.approved);
  const r2s = p2s.routes.find((r) => r.truckId === rt.truckId);
  const next = r2s.stops.find((s) => !s.done);
  const later = Math.ceil(next.arrive + 1);
  st.dispatch({ type: 'clock/tick', simMin: later });
  const b3 = E.buildInstance(st.getState(), { contingency: true });
  const pre = b3.maps.prefix[rt.truckId];
  assert.ok(pre.legs[0].turnedBack);
  const doneKeys = pre.stops.map((s) => s.nodeKey);
  assert.deepEqual(doneKeys, r2s.stops.filter((s) => s.arrive <= later).map((s) => s.nodeKey));
  for (const s of pre.stops) assert.ok(pre.legs.some((l) => l.toKey === s.nodeKey && Math.abs(l.arrive - s.arrive) < 0.01), 'a leg to ' + s.nodeKey);   // leg times are rounded to 0.01 min
});

test('contingency: the rally point an en-route truck is driving to gets banned', () => {
  const st = demoStore();
  const b = E.buildInstance(st.getState(), {});
  const id = st.dispatch({ type: 'plan/store', plan: E.decodePlan(b, quickSolve(b), { method: 'tabu' }) }).id;
  assert.ok(st.dispatch({ type: 'plan/approve', planId: id }).ok);
  const ap = st.getState().plans.find((p) => p.id === id);
  const rt = ap.routes.find((r) => r.stops.length >= 2 && r.stops[1].kind === 'rally' && r.stops[0].arrive + 1 < r.stops[1].arrive);
  if (!rt) return;                              // no such truck in this plan
  st.dispatch({ type: 'clock/tick', simMin: Math.ceil(rt.stops[0].arrive + 1) });
  assert.ok(st.dispatch({ type: 'rally/ban', gridId: rt.stops[1].gridId }).ok);
  const bc = E.buildInstance(st.getState(), { contingency: true });
  assert.deepEqual(problems(bc.instance), []);
  const v = bc.instance.vehicles.find((x) => x.id === rt.truckId);
  assert.ok(v && v.preloaded);
  assert.equal(bc.instance.nodes[v.startNode].key, rt.stops[1].nodeKey, 'still driving to that point');
  for (const j of bc.instance.jobs) assert.ok(!j.candidates.some((c) => c.node === v.startNode), j.id + ' cannot be delivered at the banned point');
  bc.parentPlan = ap;
  const plan = E.decodePlan(bc, quickSolve(bc), { method: 'tabu' });
  assert.equal(plan.stats.violations, 0);
  assert.ok(!plan.routes.some((r) => r.stops.some((s) => !s.done && s.nodeKey === rt.stops[1].nodeKey)), 'no new stop at the banned point');
});

test('contingency: rally points of stops already made count toward the limit; windowStats cover the whole window', () => {
  // Before the fix the truck-lost re-plan used 9 rally points in the window (3 done + 6 new), limit 8,
  // and its stats (14 requests, 603 mi) read as if they were the window's.
  const { st, parent, now } = contingencyFixture();
  const b = E.buildInstance(st.getState(), { contingency: true });
  const cap = st.getState().scenario.settings.maxRallyPoints;
  const doneRally = new Set(parent.routes.flatMap((r) => r.stops.filter((s) => r.depart <= now && s.arrive <= now && s.nodeKey.startsWith('rally:')).map((s) => s.nodeKey)));
  assert.ok(doneRally.size >= 1, 'stops already made at rally points');
  assert.equal(b.maps.doneRally, doneRally.size);
  assert.equal(b.instance.params.maxRallyPoints, cap - doneRally.size);
  for (const n of b.instance.nodes) assert.equal(!!n.rallyDone, n.kind === 'rally' && doneRally.has(n.key), n.key);
  // a node already open does not count again; a new one does
  const P = Sv.prepare(b.instance);
  for (let n = 0; n < b.instance.nodes.length; n++) assert.equal(P.isRally[n], b.instance.nodes[n].kind === 'rally' && !b.instance.nodes[n].rallyDone ? 1 : 0);
  b.parentPlan = parent;
  const plan = E.decodePlan(b, quickSolve(b), { method: 'tabu', start: E.contingencyStart(b) });
  assert.equal(plan.stats.violations, 0);
  const all = new Set(plan.routes.flatMap((r) => r.stops.filter((s) => s.nodeKey.startsWith('rally:')).map((s) => s.gridId)));
  assert.ok(all.size <= cap, all.size + ' rally points in the window, limit ' + cap);
  assert.deepEqual(new Set(plan.rallyPoints), all);
  assert.equal(plan.stats.rallyPoints, all.size);
  // whole window (done + planned) next to the from-now-on stats
  const ws = plan.windowStats;
  const stops = plan.routes.reduce((a, r) => a + r.stops.length, 0), done = plan.routes.reduce((a, r) => a + r.stops.filter((s) => s.done).length, 0);
  assert.deepEqual([ws.stops, ws.stopsDone, ws.stops - ws.stopsDone], [stops, done, plan.stats.stops]);
  assert.ok(ws.stopsDone >= 1);
  assert.equal(ws.trucksUsed, plan.routes.filter((r) => r.stops.length).length);
  assert.ok(ws.trucksUsed >= plan.stats.trucksUsed);
  assert.equal(ws.requests, Object.keys(plan.byRequest).length);
  assert.ok(ws.requests > plan.stats.requests, 'requests done before the re-plan count too');
  const legMiles = plan.routes.reduce((a, r) => a + r.legs.reduce((x, l) => x + l.miles, 0), 0);
  assert.ok(Math.abs(ws.miles - legMiles) < 0.01 && ws.miles > plan.stats.miles);
  assert.ok(Math.abs(ws.gallons - ws.miles / 2) < 0.01);
  assert.equal(ws.delayed, plan.stats.delayed);
  assert.equal(ws.rallyPoints, all.size);
  // a first plan: the window figures are its own
  const p0 = E.decodePlan(B, quickSolve(B), { method: 'tabu' });
  assert.deepEqual([p0.windowStats.stops, p0.windowStats.stopsDone, p0.windowStats.trucksUsed, p0.windowStats.requests, p0.windowStats.delayed],
    [p0.stats.stops, 0, p0.stats.trucksUsed, p0.stats.requests, p0.stats.delayed]);
  assert.ok(Math.abs(p0.windowStats.miles - p0.stats.miles) < 0.01 * p0.routes.length + 1e-9);
});

test('contingency: re-planned loads carry the approved ETA (prevEta) and settings.etaSlipPerMin; 0 turns it off', () => {
  const { st, parent, now } = contingencyFixture();
  assert.equal(st.getState().scenario.settings.etaSlipPerMin, 1, 'default');
  const b = E.buildInstance(st.getState(), { contingency: true });
  let carried = 0;
  b.instance.jobs.forEach((job, j) => {
    const jm = b.maps.jobs[j];
    // the earliest stop still ahead in the approved plan for that load (on its truck when on board)
    const ahead = parent.routes.filter((r) => jm.origin !== 'onboard' || r.truckId === jm.lockedTruck)
      .flatMap((r) => r.stops.filter((s) => !(r.depart <= now && s.arrive <= now) && s.deliveries.some((d) => d.requestId === job.requestId && d.group === job.group && d.loadQty > 0)))
      .map((s) => s.arrive);
    if (ahead.length) { carried++; assert.deepEqual([job.prevEta, job.slipPerMin], [Math.min(...ahead), 1], job.id); }
    else assert.equal(job.prevEta, undefined, job.id);
  });
  assert.ok(carried >= 3, carried + ' loads carry an approved ETA');
  assert.deepEqual(problems(b.instance), []);
  b.parentPlan = parent;
  const plan = E.decodePlan(b, quickSolve(b), { method: 'tabu', start: E.contingencyStart(b) });
  assert.ok(plan.cost.stability >= 0);
  assert.ok(st.dispatch({ type: 'settings/update', path: 'etaSlipPerMin', value: 0 }).ok);
  const b0 = E.buildInstance(st.getState(), { contingency: true });
  assert.ok(b0.instance.jobs.every((j) => j.prevEta === undefined && j.slipPerMin === undefined));
});

test('a pinned rally point no platoon can reach is not passed as pinned, with a warning', () => {
  // Before the fix such a pin stayed unused with no cost and no word to the planner.
  const st = demoStore();
  const inInst = new Set(B.instance.nodes.filter((n) => n.kind === 'rally').map((n) => n.gridId));
  const far = SRO.data.grid.find((g) => g.rallyCandidate && g.kind !== 'hub' && !inInst.has(g.id));
  const near = B.instance.nodes.find((n, i) => n.kind === 'rally' && B.instance.jobs.some((j) => j.candidates.some((c) => c.node === i)));
  assert.ok(far && near);
  assert.ok(st.dispatch({ type: 'rally/pin', gridId: far.id }).ok);
  assert.ok(st.dispatch({ type: 'rally/pin', gridId: near.gridId }).ok);
  const b = E.buildInstance(st.getState(), {});
  assert.deepEqual(problems(b.instance), []);
  assert.deepEqual(b.instance.params.pinnedRally.map((n) => b.instance.nodes[n].gridId), [near.gridId]);
  const msg = 'Pinned rally point ' + (far.name || far.id) + ' is out of reach of every platoon in this plan (beyond their travel radius by road), so it is not used.';
  assert.ok(b.warnings.includes(msg), b.warnings.join(' | '));
  assert.ok(!b.warnings.some((w) => w.includes('Pinned rally point ' + (near.label || near.gridId))));
  const plan = E.decodePlan(b, quickSolve(b), { method: 'tabu' });
  assert.ok(plan.warnings.includes(msg));
});

test('a lock to a truck already on the road applies to its onboard load only', () => {
  const { st, parent } = contingencyFixture();
  const s0 = st.getState();
  const b0 = E.buildInstance(s0, { contingency: true });
  const v = b0.instance.vehicles.find((x) => x.preloaded);
  assert.ok(v);
  // a new request of that truck's load group, locked to the en-route truck
  const want = v.type === 'tanker' ? 'fuel' : 'cargo';
  const line = want === 'fuel' ? { classId: 'III', itemId: 'diesel', qty: 300, unit: 'gal' } : { classId: 'I', itemId: 'mre', qty: 20, unit: 'case' };
  const sub = st.dispatch({ type: 'request/submit', request: Object.assign({}, USER_REQUEST, { unitName: '1st PLT, D CO, 1-12 IN', designator: '1/D/1-12IN', nlt: s0.clock.simMin + 600, lines: [line] }) });
  assert.ok(sub.ok, sub.error);
  const rid = sub.id;
  assert.ok(st.dispatch({ type: 'request/lock', requestId: rid, truckId: v.id }).ok);
  const b = E.buildInstance(st.getState(), { contingency: true });
  assert.deepEqual(problems(b.instance), []);
  const j = b.instance.jobs.find((x) => x.id === rid + '/' + want);
  assert.equal(j.lockedTruck, null, 'the pool part is not tied to the en-route truck');
  assert.ok(b.warnings.some((w) => w.startsWith(rid + ' is locked to truck ' + v.id + ', which is already on the road')));
  for (const x of b.instance.jobs.filter((q) => q.id.endsWith('@' + v.id))) assert.equal(x.lockedTruck, v.id, 'onboard loads stay locked');
  void parent;
});

// ---- runtime on the main-thread transport (no Worker in Node) -----------------------------------
function freshEngine() {
  const ctx = loadScripts(FILES);
  const st = demoStore(ctx);
  ctx.core.engine.init(st, { forceMain: true, warm: false });
  return { ctx, st, eng: ctx.core.engine };
}
const FAST = { tabu: { iterations: 300, timeCapSec: 5 }, sa: { coolingRate: 0.9, itersPerTemp: 20, reheats: 0, timeCapSec: 5 }, aco: { ants: 4, iterations: 5, timeCapSec: 5 } };

test('run: progress to subscribers, plan stored unapproved with road legs, status done', async () => {
  const { ctx, st, eng } = freshEngine();
  const seen = [];
  const un = eng.subscribe((s) => seen.push(s));
  const est = await eng.estimate('tabu', FAST.tabu);
  assert.ok(est.seconds > 0 && est.low <= est.seconds && est.seconds <= est.high, JSON.stringify(est));
  const plan = await eng.run({ method: 'tabu', params: FAST.tabu });
  un();
  assert.ok(plan.id && /^P-\d{4}$/.test(plan.id));
  const stored = st.getState().plans.find((p) => p.id === plan.id);
  assert.ok(stored && stored.approved === false);
  assert.ok(stored.routes.some((r) => r.legs.length && r.legs.every((l) => typeof l.path === 'string' && l.path.length > 4)));
  assert.equal(stored.method, 'tabu');
  const phases = seen.map((s) => s.phase);
  assert.ok(phases.includes('preparing') && phases.includes('running') && phases[phases.length - 1] === 'done', phases.join(','));
  const running = seen.filter((s) => s.phase === 'running' && typeof s.fraction === 'number');
  assert.ok(running.length >= 2, 'progress updates');
  assert.ok(running.some((s) => typeof s.bestCost === 'number'));
  const done = eng.status();
  assert.equal(done.planId, plan.id);
  assert.equal(done.fraction, 1);
  assert.ok(done.history.length >= 1);
  assert.equal(done.mode, 'main');
  assert.equal(eng.busy(), false);
  // requests the plan delivers are now 'planned'
  assert.ok(st.getState().requests.filter((r) => r.status === 'planned').length >= 15);
  void ctx;
});

test('compare: one stored plan per method with a shared compareId; MIP without HiGHS reports an error row', async () => {
  const { ctx, st, eng } = freshEngine();
  const heur = Object.keys(ctx.solver.methods).filter((m) => m !== 'mip');
  assert.ok(heur.includes('tabu'));
  const methods = heur.concat(ctx.solver.methods.mip ? ['mip'] : []);
  const plans = await eng.compare(methods, { params: FAST });
  assert.equal(plans.length, heur.length, 'one plan per heuristic');
  assert.deepEqual(Array.from(plans, (p) => p.method), heur);
  assert.equal(new Set(plans.map((p) => p.compareId)).size, 1);
  assert.ok(plans[0].compareId);
  for (const p of plans) assert.ok(st.getState().plans.some((x) => x.id === p.id));
  const s = eng.status();
  assert.equal(s.phase, 'done');
  assert.deepEqual(Array.from(s.planIds), Array.from(plans, (p) => p.id));
  if (methods.includes('mip')) assert.match(s.message, /Exact|MIP|HiGHS|worker/i);
});

test('cancel before the solver starts: nothing stored, status cancelled, next run works', async () => {
  const { st, eng } = freshEngine();
  const p = eng.run({ method: 'tabu', params: FAST.tabu });
  const c = eng.cancel();
  const [a, b] = await Promise.all([p, c]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(eng.status().phase, 'cancelled');
  assert.equal(st.getState().plans.length, 0);
  const plan = await eng.run({ method: 'tabu', params: FAST.tabu });
  assert.ok(plan && plan.id);
});

test('auto plan: window/planNow (manual) and boundary requests run settings.method once', async () => {
  const { st, eng } = freshEngine();
  st.dispatch({ type: 'settings/update', path: 'methodParams.tabu', value: FAST.tabu });
  st.dispatch({ type: 'window/planNow' });
  const plan = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no plan stored')), 60000);
    const un = st.subscribe((s) => { if (s.plans.length) { clearTimeout(t); un(); resolve(s.plans[0]); } });
  });
  assert.equal(plan.method, st.getState().scenario.settings.method);
  assert.equal(st.getState().ui.planRequested, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(eng.status().phase, 'done');
  // a request with nothing pending is cleared without a plan
  for (const r of st.getState().requests) st.dispatch({ type: 'request/cancel', id: r.id });
  st.dispatch({ type: 'window/planNow' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(st.getState().ui.planRequested, false);
  assert.equal(st.getState().plans.length, 1);
});

test('replan after a truck is marked out and a road is closed: stored with parentPlanId, en-route trucks continue', async () => {
  const { ctx, st, eng } = freshEngine();
  const p1 = await eng.run({ method: 'tabu', params: FAST.tabu });
  st.dispatch({ type: 'plan/approve', planId: p1.id });
  const ap = st.getState().plans.find((p) => p.id === p1.id);
  const firsts = ap.routes.filter((r) => r.stops.length).map((r) => r.stops[0].arrive).sort((a, b) => a - b);
  const now = Math.ceil(firsts[1] + 1);
  st.dispatch({ type: 'clock/tick', simMin: now });
  const out = ap.routes.find((r) => r.stops.some((s) => s.arrive > now));
  st.dispatch({ type: 'truck/markOut', truckId: out.truckId });
  const other = ap.routes.find((r) => r.truckId !== out.truckId && r.legs.length > 1);
  const c = ctx.core.engine.legCoords(other.legs[other.legs.length - 1]);
  const mid = c[Math.floor(c.length / 2)];
  assert.ok(st.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: mid[0], lon: mid[1], radiusMi: 1 } }).ok);
  const p2 = await eng.replan({ reason: 'Truck out; road closed', params: FAST.tabu });
  assert.equal(p2.parentPlanId, p1.id);
  assert.equal(p2.replanReason, 'Truck out; road closed');
  assert.match(p2.name, /^Re-plan/);
  assert.ok(Array.isArray(p2.changes));
  assert.ok(!p2.routes.some((r) => r.truckId === out.truckId && r.stops.some((s) => !s.done)), 'the truck marked out gets no new stops');
  // stops already made stay on the plan, marked done
  const doneBefore = ap.routes.flatMap((r) => r.stops.filter((s) => s.arrive <= now).map((s) => r.truckId + s.nodeKey));
  const doneAfter = p2.routes.flatMap((r) => r.stops.filter((s) => s.done).map((s) => r.truckId + s.nodeKey));
  for (const d of doneBefore) assert.ok(doneAfter.includes(d), d + ' kept as done');
  // the closed road: no new leg passes through it
  const z = { lat: mid[0], lon: mid[1], radiusMi: 1 };
  for (const r of p2.routes) for (const l of r.legs) {
    if (l.depart < now) continue;                 // driven before the closure
    const cc = ctx.core.engine.legCoords(l);
    assert.ok(!ctx.core.geo.polylineIntersectsCircle(cc, z), r.truckId + ' ' + l.fromKey + ' -> ' + l.toKey + ' avoids the closure');
  }
  assert.ok(st.dispatch({ type: 'plan/approve', planId: p2.id }).ok);
  assert.equal(st.getState().plans.find((p) => p.id === p1.id).superseded, true);
});

test('replan (tabu, SA, ACO): never worse than its warm start or the live best; en-route trucks deliver only what is on board', async () => {
  // Before the fix the search loaded pool jobs on en-route trucks; the repair then undid that, so the
  // stored re-plan (29,796.8) was worse than the live best (17,034.7) and than its warm start (29,781.0).
  const { ctx, st, eng } = freshEngine();
  const p1 = await eng.run({ method: 'tabu', params: FAST.tabu });
  st.dispatch({ type: 'plan/approve', planId: p1.id });
  const ap = st.getState().plans.find((p) => p.id === p1.id);
  const firsts = ap.routes.filter((r) => r.stops.length).map((r) => r.stops[0].arrive).sort((a, b) => a - b);
  const now = Math.ceil(firsts[3] + 1);
  st.dispatch({ type: 'clock/tick', simMin: now });
  const out = ap.routes.find((r) => r.stops.some((s) => s.arrive > now) && r.stops.some((s) => s.arrive <= now));
  st.dispatch({ type: 'truck/markOut', truckId: out.truckId, reason: 'Blown tire' });
  const b = ctx.core.engine.buildInstance(st.getState(), { contingency: true });
  b.parentPlan = ap;
  const start = ctx.core.engine.contingencyStart(b);
  assert.ok(start, 'warm start');
  const startTotal = ctx.solver.evaluate(b.instance, start, { costOnly: true }).total;
  const onboard = new Set(b.maps.jobs.filter((j) => j.origin === 'onboard').map((j) => j.lockedTruck + '|' + j.requestId + '|' + j.group));
  for (const method of ['tabu', 'sa', 'aco']) {
    const p2 = await eng.replan({ method, params: FAST[method], reason: 'Truck out' });
    assert.equal(p2.parentPlanId, p1.id);
    assert.equal(p2.stats.violations, 0, method);
    assert.ok(p2.cost.total <= startTotal + 0.01, method + ': ' + p2.cost.total + ' <= warm start ' + startTotal);
    const live = eng.status().bestCost;
    if (typeof live === 'number') assert.ok(p2.cost.total <= live + 0.01, method + ': stored ' + p2.cost.total + ' <= live best ' + live);
    assert.ok(!p2.warnings.some((w) => /already on the road/.test(w)), method + ': nothing to move off en-route trucks');
    let enroute = 0;
    for (const r of p2.routes.filter((x) => x.preloaded)) {
      enroute++;
      for (const s of r.stops.filter((x) => !x.done)) for (const d of s.deliveries) {
        assert.ok(onboard.has(r.truckId + '|' + d.requestId + '|' + d.group), method + ': ' + r.truckId + ' delivers ' + d.requestId + ' ' + d.group + ' from its own load');
      }
    }
    assert.ok(enroute >= 1, 'a truck is en route');
  }
});

test('status: elapsedSec moves on its own while the solver posts nothing, and stops when the job ends', async () => {
  // Before the fix elapsedSec changed only with solver progress: HiGHS posts nothing for 10 s or more
  // inside a sub-MIP, and the Elapsed counter froze meanwhile.
  const { ctx, eng } = freshEngine();
  const W = ctx.solver.worker, handle = W.handle;
  const SILENT_MS = 1400;
  let silentFrom = null, silentTo = null;
  W.handle = (msg, post) => new Promise((resolve) => {
    silentFrom = performance.now();
    setTimeout(() => { silentTo = performance.now(); resolve(handle(msg, post)); }, SILENT_MS);
  });
  const seen = [];
  eng.subscribe((s) => seen.push({ at: performance.now(), phase: s.phase, elapsedSec: s.elapsedSec }));
  await eng.run({ method: 'tabu', params: FAST.tabu });
  const quiet = seen.filter((s) => silentFrom !== null && s.at > silentFrom && s.at < silentTo);
  assert.ok(quiet.length >= 2, 'status updates while the solver is silent: ' + quiet.length);
  for (let i = 1; i < quiet.length; i++) assert.ok(quiet[i].elapsedSec > quiet[i - 1].elapsedSec, 'elapsedSec grows');
  assert.ok(quiet.every((s) => s.elapsedSec * 1000 <= performance.now()), 'from the job start');
  const n = seen.length;
  await new Promise((r) => setTimeout(r, 2 * ctx.core.engine.TICK_MS + 100));
  assert.equal(seen.length, n, 'no ticks after the job is done');
  assert.equal(eng.status().phase, 'done');
});

test('run params go on top of the Advanced-tab knobs: a partial params object changes only what it names', async () => {
  // Before the fix run({ params: { seed: 7 } }) dropped settings.methodParams.tabu, so the run used the
  // default 4,000 iterations and 200 moves per step instead of the 300 and 40 the planner set.
  const { st, eng } = freshEngine();
  assert.ok(st.dispatch({ type: 'settings/update', path: 'methodParams.tabu', value: { iterations: 300, neighborhood: 40, timeCapSec: 5 } }).ok);
  const plan = await eng.run({ method: 'tabu', params: { seed: 7 } });
  assert.equal(plan.params.seed, 7);
  assert.equal(plan.params.iterations, 300);
  assert.equal(plan.params.neighborhood, 40);
  assert.equal(plan.params.timeCapSec, 5);
  // a full params object still wins over the settings
  const p2 = await eng.run({ method: 'tabu', params: { iterations: 200, neighborhood: 20, timeCapSec: 5, seed: 3 } });
  assert.deepEqual([p2.params.iterations, p2.params.neighborhood, p2.params.seed], [200, 20, 3]);
});

test('estimate: a solver-knob change reuses the instance build; a burst of edits makes one build', async () => {
  // Before the fix the build cache keyed on the whole scenario, so every Advanced-tab keystroke rebuilt
  // the instance on the main thread (0.15-0.35 s) before the estimate.
  const { ctx, st, eng } = freshEngine();
  const E2 = ctx.core.engine, build = E2.buildInstance;
  let builds = 0;
  E2.buildInstance = function () { builds++; return build.apply(this, arguments); };
  await eng.estimate('tabu', FAST.tabu);
  assert.equal(builds, 1);
  for (const it of [500, 600, 700]) {
    st.dispatch({ type: 'settings/update', path: 'methodParams.tabu', value: { iterations: it, timeCapSec: 5 } });
    st.dispatch({ type: 'settings/update', path: 'timeLimitSec', value: 120 + it / 100 });
    const est = await eng.estimate('tabu');
    assert.ok(est.seconds > 0, JSON.stringify(est));
  }
  assert.equal(builds, 1, 'method knobs and the time limit do not rebuild the instance');
  // a setting the instance depends on rebuilds it, once for a burst of edits
  const t0 = performance.now();
  const ests = [];
  for (const k of [7, 6, 5]) {
    assert.ok(st.dispatch({ type: 'settings/update', path: 'maxRallyPoints', value: k }).ok);
    ests.push(eng.estimate('tabu', FAST.tabu));
    await new Promise((r) => setTimeout(r, 60));
  }
  const out = await Promise.all(ests);
  assert.equal(builds, 2, 'one build for three quick edits');
  assert.ok(out.every((e) => e.seconds > 0));
  assert.ok(performance.now() - t0 < E2.ESTIMATE_MAX_WAIT_MS + 5000);
  const plan = await eng.run({ method: 'tabu', params: FAST.tabu });
  assert.equal(builds, 2, 'the run reuses the build of the last estimate');
  assert.ok(plan.rallyPoints.length <= 5, 'built on the last value (' + plan.rallyPoints.length + ' rally points)');
});

test('decodePlan: mipProof carries what Exact (MIP) proved; null for the heuristics; cancel without a proof', () => {
  const res = quickSolve(B);
  assert.equal(E.decodePlan(B, res, { method: 'tabu' }).mipProof, null);
  const proof = { stopReason: 'gap', gap: 0.004, dualBound: 4700.5, gapTarget: 0.01, exactModel: true };
  const mip = Object.assign({}, res, { method: 'mip', stopReason: 'gap', proof: proof, extra: { mipGap: 0.004, status: 'Within target gap' } });
  const plan = E.decodePlan(B, mip, { method: 'mip' });
  assert.deepEqual(plain(plan.mipProof), proof);
  assert.equal(plan.stopReason, 'gap');
  assert.equal(plan.mipStatus, 'Within target gap');
  const cut = E.decodePlan(B, Object.assign({}, res, { method: 'mip' }), { method: 'mip', cancelled: true });
  assert.equal(cut.mipProof.stopReason, 'cancel');
  assert.equal(cut.stopReason, 'cancelled');
});
