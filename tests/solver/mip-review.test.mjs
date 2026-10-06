// Adversarial review tests for the exact method (src/solver/mip.js), on top of mip.test.mjs:
//   - zero service time + co-located nodes: the time rows alone allowed a free closed loop of stops beside
//     the real route (model 140 vs evaluate 995, "Optimal" with gap 0); order rows on zero-time arcs fix it;
//   - every HiGHS incumbent on flat periods decodes to a violation-free plan whose evaluate total is at
//     most its model objective, and at a proven optimum (gap 0) the two are equal - with pinned / banned
//     rally points, rally limits 0-2, locks (incl. to a missing or wrong-type truck), closed roads,
//     en-route preloaded trucks, trucks with no capacity, zero-quantity jobs, no periods, no cap on
//     lateness, zero weights;
//   - decode never overfills a truck when HiGHS packs a sliver chunk within its feasibility tolerance;
//   - the warm start is accepted and is HiGHS's first incumbent (same model objective = evaluate total);
//   - the HiGHS model is disposed on every path (finish, shouldStop, an error in our callback, a HiGHS
//     failure), a callback error stops the solve at once, and a HiGHS failure keeps the start plan;
//   - our own deadline interrupt reports 'Time limit reached', not 'Interrupted by user';
//   - Infinity legs (closed roads, infinite risk), locked jobs on en-route trucks, nothing to decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadScripts, ROOT } from '../load.mjs';
import { SOLVER_FILES, bruteForce, plain } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const highsFactory = require('highs');
const HIGHS = await highsFactory();

const FILES = SOLVER_FILES.concat(['src/solver/tabu.js'].filter((f) => fs.existsSync(path.join(ROOT, f))), ['src/solver/mip.js']);
function solverWith(loader) {
  const SRO = loadScripts(FILES);
  SRO.solver.mip.setLoader(loader || (() => HIGHS));
  return SRO;
}
const SRO = solverWith();
const S = SRO.solver;
await S.mip.ready();

const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
const params = (p) => Object.assign(S.clampParams('mip', p), p);   // keeps sub-minimum limits for quick tests

// Two nodes at the same place: same rows/columns of every matrix, 0 between them.
function colocate(inst, a, b) {
  const n = inst.nodes.length;
  for (const m of ['minutes', 'miles', 'riskUnits']) {
    for (let i = 0; i < n; i++) { inst[m][b][i] = inst[m][a][i]; inst[m][i][b] = inst[m][i][a]; }
    inst[m][a][b] = inst[m][b][a] = 0; inst[m][b][b] = 0;
  }
}

// Hub, a stop C near it and two co-located stops A, B far away; one cargo truck; service 0.
function loopInstance() {
  const D = [[0, 10, 150, 150], [10, 0, 145, 145], [150, 145, 0, 0], [150, 145, 0, 0]];
  const job = (i, node) => ({ id: 'J' + i, requestId: 'R' + i, lineIdxs: [0], group: 'cargo', qty: 2, unit: 'pallet', tier: 1, classRank: 0,
    deadline: 2360, hardDeadline: false, candidates: [{ node, platoonMiles: 0, platoonCost: 0, hint: false }], lockedTruck: null });
  return {
    startMin: 360,
    nodes: [{ key: 'hub:A', kind: 'hub', label: 'Hub' }, { key: 'direct:C', kind: 'direct', label: 'C' },
      { key: 'direct:A', kind: 'direct', label: 'A' }, { key: 'direct:B', kind: 'direct', label: 'B' }],
    minutes: D.map((r) => r.map((d) => d * 1.5)), miles: D.map((r) => r.slice()), riskUnits: D.map((r) => r.map(() => 0)), gridPaths: {},
    periods: [{ startMin: 0, endMin: 5 * 1440, speed: 1, risk: 1 }],
    vehicles: [{ id: 'V0', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 360 }],
    jobs: [job(0, 1), job(1, 2), job(2, 3)],
    weights: Object.assign({}, S.DEFAULT_WEIGHTS),
    params: { mpg: 2, serviceMin: 0, loadMin: 20, maxRallyPoints: 4, pinnedRally: [], bannedRally: [] },
    penalties: JSON.parse(JSON.stringify(S.DEFAULT_PENALTIES)), fixed: null
  };
}

// Small adversarial instance (flat periods, so the model is exact).
function nastyInstance(seed) {
  const r = SRO.util.rng(seed * 977 + 11);
  const inst = S.makeTestInstance(seed, {
    nJobs: 3 + r.int(6), nVehicles: 1 + r.int(3), nRally: r.int(6), nHubs: 1 + r.int(3),
    maxRallyPoints: r.int(3), pinned: r.int(3), banned: r.int(2), locked: r.int(4), closedZones: r.int(4),
    lateAvailableShare: 0.4, flatPeriods: true, riskZones: 1 + r.int(4), serviceMin: r() < 0.5 ? 0 : 15,
    penalties: r() < 0.3 ? Object.assign({}, S.DEFAULT_PENALTIES, { lateCapShare: [0, 0.2, Infinity][r.int(3)] }) : null,
    weights: r() < 0.3 ? { fuel: r.int(3), distance: r.int(3), risk: r.int(5), simplicity: r.int(3) } : null
  });
  const nn = inst.nodes.length, notes = [];
  if (inst.params.serviceMin === 0) for (let k = 0; k < 3; k++) { const a = r.int(nn), b = r.int(nn); if (a !== b) { colocate(inst, a, b); notes.push('colocated'); } }
  if (r() < 0.4) { const v = r.int(inst.vehicles.length); inst.vehicles[v].startNode = r.int(nn); inst.vehicles[v].preloaded = true; notes.push('en-route'); }
  if (r() < 0.2) { inst.periods = []; notes.push('no periods'); }
  if (r() < 0.2) { inst.vehicles[0].capacity = 0; notes.push('capacity 0'); }
  if (r() < 0.2) { inst.jobs[0].qty = 0; notes.push('qty 0'); }
  if (r() < 0.2) { inst.jobs[inst.jobs.length - 1].lockedTruck = 'no-such-truck'; notes.push('lock to missing truck'); }
  if (r() < 0.2) {
    const j = inst.jobs.findIndex((x) => x.lockedTruck == null);
    const wrong = inst.vehicles.find((v) => !S.typeCompatible(v, inst.jobs[j]));
    if (j >= 0 && wrong) { inst.jobs[j].lockedTruck = wrong.id; notes.push('lock to wrong type'); }
  }
  S.prepare.invalidate(inst);
  return { inst, notes };
}

// Records every decode the method makes with the model objective and evaluate result of its values.
function recordDecodes(ctx) {
  const M = ctx.solver.mip, orig = M.decode, recs = [];
  M.decode = function (model, x) {
    const sol = orig(model, x);
    if (model.stats.binaries > 0) {
      const ev = ctx.solver.evaluate(model.instance, sol);
      recs.push({ obj: M.objective(model, x), total: ev.total, feasible: ev.feasible, violations: ev.violations.map((v) => v.code),
        rows: M.checkValues(model, x, 1e-5).length });
    }
    return sol;
  };
  return { recs, restore() { M.decode = orig; } };
}

test('zero service time + co-located stops: no free closed loop beside the route (model objective = evaluate = brute force)', () => {
  const inst = loopInstance();
  const bf = bruteForce(SRO, inst);
  const model = S.mip.buildModel(inst, {});
  assert.ok(model.stats.orderRows >= 2, 'order rows on the zero-time arcs A-B, B-A: ' + model.stats.orderRows);
  for (const warmStart of [false, true]) {
    const res = S.methods.mip.run(inst, params({ timeLimitSec: 20, mipGap: 0, warmStart, seed: 3 }), {});
    assert.equal(res.extra.status, 'Optimal');
    assert.ok(rel(res.extra.modelObjective, bf.total) < 1e-6, `warm ${warmStart}: model optimum ${res.extra.modelObjective} vs brute force ${bf.total} (a loop A-B-A would cost 140)`);
    assert.ok(rel(res.extra.dualBound, bf.total) < 1e-6, 'the bound is the real optimum');
    assert.ok(rel(res.total, bf.total) < 1e-9 && res.feasible);
    assert.ok(res.extra.mipGap <= 1e-6, 'gap of the returned plan ' + res.extra.mipGap);
  }
  // the start plan (all three stops in one route) satisfies the order rows
  const m2 = S.mip.buildModel(inst, { start: bf.solution });
  assert.equal(m2.startExact, true);
  assert.deepEqual(plain(S.mip.checkValues(m2, m2.startValues)), []);
});

test('incumbents on adversarial flat instances: violation-free, evaluate <= model objective, equal at a proven optimum', async () => {
  const ctx = solverWith();
  await ctx.solver.mip.ready();
  const rec = recordDecodes(ctx);
  const C = ctx.solver;
  let optimal = 0, incumbents = 0, features = new Set();
  try {
    for (let seed = 1; seed <= 30; seed++) {
      const { inst, notes } = nastyInstance(seed);
      notes.forEach((n) => features.add(n));
      rec.recs.length = 0;
      // cold runs (no 2 s warm-up pass); every third one warm-started from a local-search plan
      const hooks = {};
      if (seed % 3 === 0) { const rng = SRO.util.rng(seed); hooks.start = C.localSearch(inst, C.construct(inst, { rng }), { rng, timeLimitMs: 100 }); }
      const res = C.methods.mip.run(inst, params({ timeLimitSec: 4, mipGap: 0, warmStart: !!hooks.start, seed }), hooks);
      const ev = C.evaluate(inst, res.solution);
      const tag = `seed ${seed} [${notes.join(', ')}]`;
      assert.ok(ev.feasible, tag + ' result violations ' + JSON.stringify(plain(ev.violations)));
      assert.equal(res.extra.error, undefined, tag);
      for (const r of rec.recs) {
        incumbents++;
        assert.ok(r.feasible, tag + ' incumbent violations ' + r.violations.join(','));
        assert.equal(r.rows, 0, tag + ' incumbent violates model rows');
        assert.ok(r.total <= r.obj + 1e-6 * Math.max(1, Math.abs(r.obj)), `${tag}: evaluate ${r.total} > model objective ${r.obj}`);
      }
      if (res.extra.status === 'Optimal' && res.extra.highsGap != null && res.extra.highsGap <= 1e-9) {
        optimal++;
        // the decoded optimum is representable at its evaluate cost, so it can be neither below the bound
        // nor above the model optimum
        assert.ok(rel(res.extra.modelObjective, res.extra.mipBestTotal) < 1e-6,
          `${tag}: model optimum ${res.extra.modelObjective} vs evaluate of its plan ${res.extra.mipBestTotal}`);
        assert.ok(res.total <= res.extra.modelObjective + 1e-6 * Math.max(1, res.extra.modelObjective));
      }
    }
  } finally { rec.restore(); }
  assert.ok(optimal >= 20, 'proven optima ' + optimal + ' of 30');
  assert.ok(incumbents >= 60, 'incumbents checked ' + incumbents);
  for (const f of ['colocated', 'en-route', 'no periods', 'capacity 0', 'qty 0', 'lock to missing truck']) assert.ok(features.has(f), 'covers ' + f);
});

test('decode never overfills a truck: a sliver chunk HiGHS packs within its tolerance is trimmed from the largest chunk', () => {
  // four cargo jobs of 4 pallets at their own nodes; job 3 may also be dropped at job 0's node
  const inst = S.makeTestInstance(4, { nJobs: 4, nVehicles: 2, nRally: 0, tankers: 0, fuelShare: 0, twoJobShare: 0, fixedShare: 1, flatPeriods: true });
  inst.jobs.forEach((j) => { j.qty = 4; j.deadline = 5000; });
  const node = (j) => inst.jobs[j].candidates[0].node;
  inst.jobs[3].candidates.push({ node: node(0), platoonMiles: 0, platoonCost: 0, hint: false });
  S.prepare.invalidate(inst);
  // truck 0 full to the pallet (4 + 4 + 2); job 3 split into 4 - eps on truck 1 and an eps rest (deferred)
  const eps = 6e-8;
  const start = { routes: [
    { vehicle: 0, visits: [{ node: node(0), jobs: [{ job: 0, qty: 4 }] }, { node: node(1), jobs: [{ job: 1, qty: 4 }] }, { node: node(2), jobs: [{ job: 2, qty: 2 }] }] },
    { vehicle: 1, visits: [{ node: node(3), jobs: [{ job: 3, qty: 4 - eps }] }] }
  ] };
  assert.ok(S.evaluate(inst, start).feasible);
  const model = S.mip.buildModel(inst, { start });
  assert.equal(model.startExact, true, model.startNotes.join('; '));
  const c = model.chunks.findIndex((ch) => ch.job === 3 && ch.sv < 0);
  assert.ok(c >= 0 && Math.abs(model.chunks[c].size - eps) < 1e-12, 'the eps rest is its own chunk');
  // HiGHS may put the eps chunk on truck 0 at its first stop: the capacity row is then off by eps, within
  // HiGHS's feasibility tolerance but not evaluate's (1e-9 x capacity)
  const opt = model.zc[c].find((o) => o[0] === 0 && o[1] === node(0));
  assert.ok(opt, 'truck 0 may carry the eps chunk at its first stop');
  const x = Float64Array.from(model.startValues);
  x[opt[2]] = 1; x[model.uCol[c]] = 0;
  // job 3 is then delivered at two stops: the extra-chunk columns follow (evaluate charges that chunk)
  x[model.gCol.get((3 * inst.vehicles.length + 0) * inst.nodes.length + node(0))] = 1;
  const bad = S.mip.checkValues(model, x, 1e-6);
  assert.deepEqual(plain(bad), [], 'within a 1e-6 tolerance these values are feasible');
  const sol = S.mip.decode(model, x);
  const ev = S.evaluate(inst, sol);
  assert.ok(ev.feasible, JSON.stringify(plain(ev.violations)));
  const load0 = sol.routes[0].visits.reduce((s, v) => s + v.jobs.reduce((a, j) => a + j.qty, 0), 0);
  assert.ok(load0 <= 10 * (1 + 1e-12), 'load ' + load0);
  // the trim comes off the largest chunk: the sliver stays and every stop keeps a positive delivery
  assert.ok(sol.routes[0].visits[0].jobs.some((j) => j.job === 3 && Math.abs(j.qty - eps) < 1e-12), 'the sliver itself is kept');
  for (const v of sol.routes[0].visits) assert.ok(v.jobs.length > 0 && v.jobs.every((j) => j.qty > 0));
  assert.ok(Math.abs(ev.total - S.mip.objective(model, x)) < 1e-3, 'the trim changes the cost by a hair only');
});

test('warm start: accepted, the first incumbent is the start (model objective = its evaluate total), never worse', () => {
  const inst = S.makeTestInstance(11, { nJobs: 16, nVehicles: 5, nRally: 5, nHubs: 2, maxRallyPoints: 2, pinned: 1, locked: 2, flatPeriods: true });
  const rng = SRO.util.rng(11);
  const start = S.localSearch(inst, S.construct(inst, { rng }), { rng, timeLimitMs: 300 });
  const evs = S.evaluate(inst, start);
  assert.ok(evs.feasible);
  const model = S.mip.buildModel(inst, { start });
  const mapped = S.evaluate(inst, S.mip.decode(model, model.startValues));
  const res = S.methods.mip.run(inst, params({ timeLimitSec: 5, mipGap: 0.0, seed: 2 }), { start });
  const x = res.extra;
  assert.equal(x.startExact, true);
  assert.equal(x.startAccepted, true);
  assert.equal(x.startUsed, true, 'first incumbent ' + x.firstIncumbentObjective);
  assert.ok(rel(x.firstIncumbentObjective, mapped.total) < 1e-6, `first incumbent ${x.firstIncumbentObjective} vs mapped start ${mapped.total}`);
  assert.ok(mapped.total <= evs.total + 1e-9 * evs.total);
  assert.ok(res.total <= evs.total + 1e-9 * evs.total && res.feasible);
  assert.ok(x.firstIncumbentSec < 3, 'start becomes an incumbent quickly: ' + x.firstIncumbentSec);
});

// Wraps the real highs module: counts models created/disposed and can make HiGHS fail.
function spyHighs(opts = {}) {
  const st = { created: 0, disposed: 0 };
  const mod = {
    constants: HIGHS.constants,
    createModel(o) {
      if (opts.failCreate) throw new Error('LP parse failed (test)');
      const m = HIGHS.createModel(o);
      st.created++;
      return new Proxy(m, {
        get(t, k) {
          if (k === 'dispose') return () => { st.disposed++; return t.dispose(); };
          if (k === 'run' && opts.failRun) return () => { throw new Error('RuntimeError: Aborted() (test)'); };
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
    }
  };
  return { st, mod };
}

test('the HiGHS model is always disposed: finish, shouldStop, an error in our callback (stops at once), a HiGHS failure', async () => {
  const inst = S.makeTestInstance(1, { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, twoJobShare: 0.5, maxRallyPoints: 4 });
  const start = S.construct(inst);
  const startTotal = S.evaluate(inst, start).total;
  // finish (small instance) and shouldStop (Phase-1 size)
  {
    const spy = spyHighs();
    const ctx = solverWith(() => spy.mod); await ctx.solver.mip.ready();
    const tiny = ctx.solver.makeTestInstance(2, { nJobs: 4, nVehicles: 2, nRally: 2, flatPeriods: true });
    const r1 = ctx.solver.methods.mip.run(tiny, params({ timeLimitSec: 10, mipGap: 0, warmStart: false }), {});
    assert.equal(r1.extra.status, 'Optimal');
    const t0 = performance.now();
    const r2 = ctx.solver.methods.mip.run(inst, params({ timeLimitSec: 60, mipGap: 0 }), { start, shouldStop: () => performance.now() - t0 > 1500 });
    assert.equal(r2.stopReason, 'stopped');
    assert.deepEqual(spy.st, { created: 2, disposed: 2 });
  }
  // an exception in our own callback path (here: onProgress throws on the first progress from inside
  // HiGHS) stops the solve at the next HiGHS callback, is rethrown, and the model is still disposed
  {
    const spy = spyHighs();
    const ctx = solverWith(() => spy.mod); await ctx.solver.mip.ready();
    const t0 = performance.now();
    let calls = 0;
    assert.throws(() => ctx.solver.methods.mip.run(inst, params({ timeLimitSec: 60, mipGap: 0 }), {
      start,
      onProgress(p) { if (p.message && /Searching|New best plan/.test(p.message)) { calls++; throw new Error('progress sink failed'); } }
    }), /progress sink failed/);
    const wall = (performance.now() - t0) / 1000;
    assert.ok(calls >= 1);
    assert.ok(wall < 20, 'stopped at once, not at the 60 s limit: ' + wall.toFixed(1) + ' s');
    assert.deepEqual(spy.st, { created: 1, disposed: 1 });
  }
  // HiGHS fails inside run() (wasm abort) or cannot parse the model: the start plan comes back with a
  // 'Solve error' status and a warning instead of losing the warm-start work
  for (const fail of [{ failRun: true }, { failCreate: true }]) {
    const spy = spyHighs(fail);
    const ctx = solverWith(() => spy.mod); await ctx.solver.mip.ready();
    const res = ctx.solver.methods.mip.run(inst, params({ timeLimitSec: 30, mipGap: 0 }), { start });
    assert.equal(res.extra.status, 'Solve error', JSON.stringify(fail));
    assert.match(res.extra.error, /test/);
    assert.ok(res.warnings.length === 1 && /HiGHS/.test(res.warnings[0]));
    assert.ok(res.total <= startTotal + 1e-9 * startTotal && res.feasible);
    assert.equal(spy.st.created, spy.st.disposed);
  }
});

test('our deadline interrupt reports a time limit, not "Interrupted by user"', () => {
  const inst = S.makeTestInstance(2, { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, twoJobShare: 0.5, maxRallyPoints: 4 });
  const start = S.construct(inst);
  // the clock jumps past the deadline once HiGHS is running, before HiGHS's own time limit can trigger
  let skew = 0;
  const res = S.methods.mip.run(inst, params({ timeLimitSec: 120, mipGap: 0 }), {
    start, now: () => performance.now() + skew,
    onProgress(p) { if (/Searching|New best/.test(p.message || '')) skew = 1e7; }
  });
  assert.equal(res.extra.status, 'Time limit reached');
  assert.equal(res.extra.statusCode, 13);
  assert.equal(res.stopReason, 'time');
  assert.ok(res.feasible);
});

test('Infinity legs: closed roads and infinite risk are never driven; a cut-off job is deferred; the LP stays parseable', () => {
  let checked = 0, infRisk = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 8, nVehicles: 3, nRally: 4, closedZones: 6, flatPeriods: true });
    const n = inst.nodes.length;
    // an open road (finite minutes and miles) with infinite risk units, and a job whose only candidate is cut off
    const a = inst.vehicles[0].hubNode, b = inst.jobs[0].candidates[0].node;
    if (a !== b && inst.minutes[a][b] < Infinity) { inst.riskUnits[a][b] = Infinity; inst.riskUnits[b][a] = Infinity; infRisk++; }
    const cut = inst.jobs[inst.jobs.length - 1];
    const dn = cut.candidates[0].node;
    cut.candidates = [cut.candidates[0]];
    for (let i = 0; i < n; i++) if (i !== dn) { inst.minutes[i][dn] = inst.minutes[dn][i] = Infinity; inst.miles[i][dn] = inst.miles[dn][i] = Infinity; }
    S.prepare.invalidate(inst);
    const res = S.methods.mip.run(inst, params({ timeLimitSec: 4, mipGap: 0, warmStart: false, seed }), {});
    assert.equal(res.extra.error, undefined, 'seed ' + seed + ': ' + res.extra.error);
    const ev = S.evaluate(inst, res.solution);
    assert.ok(ev.feasible && Number.isFinite(ev.total), 'seed ' + seed + ' ' + JSON.stringify(plain(ev.violations)));
    assert.ok(ev.deferred.some((d) => d.job === inst.jobs.length - 1), 'the cut-off job is deferred');
    for (const r of ev.routes) for (const l of r.legs) assert.ok(Number.isFinite(l.riskUnits) && Number.isFinite(l.miles));
    checked++;
  }
  assert.equal(checked, 6);
  assert.ok(infRisk >= 3, 'open legs with infinite risk: ' + infRisk);
});

test('en-route preloaded trucks with locked loads (contingency): exact on flat periods, locks respected', () => {
  let optimal = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const inst = S.makeTestInstance(seed + 40, { nJobs: 7, nVehicles: 3, nRally: 3, tankers: 1, flatPeriods: true });
    // truck 1 (cargo) is on the road: it starts at a stop, carries two locked cargo loads, leaves at once
    const cargo = inst.jobs.map((j, i) => i).filter((i) => inst.jobs[i].group === 'cargo');
    const v = 1;
    inst.vehicles[v].startNode = inst.jobs[cargo[0]].candidates[0].node;
    inst.vehicles[v].preloaded = true;
    inst.vehicles[v].availableAt = inst.startMin + 45;
    let load = 0;
    for (const j of cargo.slice(0, 2)) if (load + inst.jobs[j].qty <= inst.vehicles[v].capacity) { inst.jobs[j].lockedTruck = inst.vehicles[v].id; load += inst.jobs[j].qty; }
    S.prepare.invalidate(inst);
    assert.equal(S.vehicleStartTime(inst, v), inst.startMin + 45, 'preloaded: no load time');
    const res = S.methods.mip.run(inst, params({ timeLimitSec: 6, mipGap: 0, warmStart: false, seed }), {});
    const ev = S.evaluate(inst, res.solution);
    assert.ok(ev.feasible, JSON.stringify(plain(ev.violations)));
    res.solution.routes.forEach((r) => r.visits.forEach((vi) => vi.jobs.forEach((c) => {
      const lk = inst.jobs[c.job].lockedTruck;
      if (lk != null) assert.equal(inst.vehicles[r.vehicle].id, lk);
    })));
    if (res.extra.status === 'Optimal' && res.extra.highsGap <= 1e-9) {
      optimal++;
      assert.ok(rel(res.extra.modelObjective, res.extra.mipBestTotal) < 1e-6, `seed ${seed}: model ${res.extra.modelObjective} vs evaluate ${res.extra.mipBestTotal}`);
    }
  }
  assert.ok(optimal >= 4, 'proven optima ' + optimal);
});

test('nothing to decide (no trucks, or no compatible truck): Optimal at once, every job deferred, no HiGHS call', async () => {
  const spy = spyHighs();
  const ctx = solverWith(() => spy.mod); await ctx.solver.mip.ready();
  const C = ctx.solver;
  const a = C.makeTestInstance(3, { nJobs: 5, nVehicles: 2, flatPeriods: true });
  a.vehicles = [];
  const b = C.makeTestInstance(3, { nJobs: 5, nVehicles: 2, tankers: 2, fuelShare: 0, twoJobShare: 0, flatPeriods: true });
  for (const inst of [a, b]) {
    C.prepare.invalidate(inst);
    const res = C.methods.mip.run(inst, params({ timeLimitSec: 5, mipGap: 0, warmStart: false }), {});
    const ev = C.evaluate(inst, res.solution);
    assert.equal(res.extra.status, 'Optimal');
    assert.equal(res.stopReason, 'optimal');
    assert.equal(res.extra.mipGap, 0);
    assert.ok(ev.feasible);
    assert.ok(rel(res.total, res.extra.modelObjective) < 1e-9);
  }
  assert.equal(spy.st.created, 0);
});
