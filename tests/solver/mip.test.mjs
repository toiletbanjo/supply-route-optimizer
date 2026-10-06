// Exact method (src/solver/mip.js): loader, model linearization exactness (model objective = evaluate
// total on flat periods), brute-force optimum on tiny instances, a Phase-1-size run with a time limit,
// cancel via shouldStop, and model size numbers. Needs the npm package highs (devDependency).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadScripts, ROOT } from '../load.mjs';
import { SOLVER_FILES, tinyInstance, bruteForce, plain } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const highsFactory = require('highs');

// tabu.js is optional (mip.js falls back to construct + localSearch for its warm start)
const FILES = SOLVER_FILES.concat(['src/solver/tabu.js'].filter((f) => fs.existsSync(path.join(ROOT, f))), ['src/solver/mip.js']);
const SRO = loadScripts(FILES);
const S = SRO.solver;
S.mip.setLoader(() => highsFactory());
await S.mip.ready();

const P1 = { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, twoJobShare: 0.5, maxRallyPoints: 4 };
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
const mipParams = (p) => S.clampParams('mip', p);

function mixedInstance(seed, extra = {}) {
  const r = SRO.util.rng(seed * 31 + 7);
  return S.makeTestInstance(seed, Object.assign({
    nJobs: 3 + r.int(14), nVehicles: 2 + r.int(4), nRally: r.int(6), nHubs: 1 + r.int(3),
    maxRallyPoints: r.int(4), pinned: r.int(2), banned: r.int(2), locked: r.int(3), closedZones: r.int(2),
    lateAvailableShare: 0.3, flatPeriods: true
  }, extra));
}

test('loader: available() only after ready(); a bad loader rejects; run() without HiGHS throws mip-unavailable', async () => {
  assert.equal(S.mip.available(), true);
  assert.equal(S.mip.isReady(), true);
  assert.equal(await S.mip.ready(), await S.mip.ready());
  const other = loadScripts(FILES);
  assert.equal(other.solver.mip.available(), false);
  await assert.rejects(other.solver.mip.ready(), /loader/);
  other.solver.mip.setLoader(() => Promise.resolve({}));
  await assert.rejects(other.solver.mip.ready(), /highs module/);
  assert.equal(other.solver.mip.available(), false);
  const inst = tinyInstance(other, 1);
  assert.throws(() => other.solver.methods.mip.run(inst, other.solver.clampParams('mip', {}), {}), (e) => e.code === 'mip-unavailable');
  assert.equal(S.methods.mip.key, 'mip');
  assert.equal(typeof S.methods.mip.run, 'function');
});

test('linearization: on flat periods the model objective of a mapped plan equals its evaluate total; start values satisfy every row; decode round-trips', () => {
  let checked = 0, splits = 0, charged = 0, pins = 0, rallyLimited = 0, same = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const inst = mixedInstance(seed);
    const rng = SRO.util.rng(seed);
    const start = S.localSearch(inst, S.construct(inst, { rng }), { rng, timeLimitMs: 300 });
    const ev = S.evaluate(inst, start);
    assert.ok(ev.feasible, 'seed ' + seed + ' start feasible');
    const model = S.mip.buildModel(inst, { start });
    assert.equal(model.exact, true);
    assert.equal(model.startExact, true, 'seed ' + seed + ' start representable: ' + model.startNotes.join('; '));
    const bad = S.mip.checkValues(model, model.startValues);
    assert.deepEqual(plain(bad), [], 'seed ' + seed + ' start satisfies the model');
    // the mapped plan is the start with each delivery at the first visit of its node (revisits become
    // waypoints): never costlier, usually identical
    const obj = S.mip.objective(model, model.startValues);
    const dec = S.mip.decode(model, model.startValues);
    const ed = S.evaluate(inst, dec);
    assert.ok(ed.feasible, 'seed ' + seed + ' decoded plan feasible');
    assert.ok(rel(obj, ed.total) < 1e-9, `seed ${seed}: model ${obj} vs evaluate of the mapped plan ${ed.total}`);
    assert.ok(ed.total <= ev.total + 1e-9 * Math.max(1, ev.total), `seed ${seed}: mapped ${ed.total} vs start ${ev.total}`);
    if (rel(ed.total, ev.total) < 1e-12) same++;
    if (model.stats.chunks > inst.jobs.length) splits++;
    if (ed.stats.extraChunks > 0) charged++;            // the g / h columns carry evaluate's EXTRA_CHUNK charge
    if (model.pCol.size) pins++;
    if (model.rCol.size) rallyLimited++;
    checked++;
  }
  assert.equal(checked, 40);
  assert.ok(same >= 30, 'mapped plan identical to the start in ' + same + ' of 40');
  assert.ok(splits > 0 && charged > 0 && pins > 0 && rallyLimited > 0,
    `features covered: splits ${splits}, split plans ${charged}, pinned ${pins}, rally limit ${rallyLimited}`);
});

test('linearization with time-of-day periods: start still feasible and decodes to the same plan; objective close to evaluate', () => {
  let worst = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const inst = mixedInstance(seed, { flatPeriods: false });
    const start = S.construct(inst);
    const ev = S.evaluate(inst, start);
    const model = S.mip.buildModel(inst, { start });
    assert.equal(model.exact, model.factors.flat);
    assert.deepEqual(plain(S.mip.checkValues(model, model.startValues)), [], 'seed ' + seed);
    const dec = S.mip.decode(model, model.startValues);
    const ed = S.evaluate(inst, dec);
    assert.ok(ed.feasible && ed.total <= ev.total + 1e-9 * Math.max(1, ev.total), 'seed ' + seed + ' decode');
    worst = Math.max(worst, rel(S.mip.objective(model, model.startValues), ev.total));
    assert.ok(model.factors.speed > 0.6 && model.factors.speed <= 1 && model.factors.risk > 0.7 && model.factors.risk < 1.3);
  }
  assert.ok(worst < 0.25, 'model vs evaluate on periods, worst relative difference ' + worst);
});

test('tiny instances: the cold MIP proves optimality and matches the brute-force optimum (flat periods)', () => {
  const rows = [];
  let detours = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const inst = tinyInstance(SRO, seed, { flatPeriods: true });
    const bf = bruteForce(SRO, inst);
    // cold, without waypoint detours: chunks are whole jobs (noSplit instances) and one stop per node, the
    // same plan space as the brute force
    S.mip.modelOptions.waypoints = false;
    let res;
    try { res = S.methods.mip.run(inst, mipParams({ timeLimitSec: 30, mipGap: 0, warmStart: false, seed }), {}); } finally { delete S.mip.modelOptions.waypoints; }
    assert.equal(res.extra.status, 'Optimal', 'seed ' + seed);
    assert.equal(res.stopReason, 'optimal');
    assert.equal(res.extra.startAccepted, null, 'no MIP start when warmStart is false');
    const mipTotal = res.extra.mipBestTotal;
    assert.ok(typeof mipTotal === 'number', 'seed ' + seed + ' has a MIP incumbent');
    assert.ok(rel(mipTotal, bf.total) <= 0.005, `seed ${seed}: MIP ${mipTotal} vs brute force ${bf.total}`);
    assert.ok(rel(res.extra.modelObjective, mipTotal) < 1e-6, `seed ${seed}: model objective ${res.extra.modelObjective} = evaluate ${mipTotal}`);
    assert.ok(res.extra.mipGap <= 1e-6);
    const ev = S.evaluate(inst, res.solution);
    assert.ok(ev.feasible);
    assert.ok(ev.total <= bf.total * (1 + 0.005), 'returned plan no worse than the optimum');
    // full model (waypoint detours on), warm-started from the brute-force plan: optimal, never worse
    const warm = S.methods.mip.run(inst, mipParams({ timeLimitSec: 30, mipGap: 0, seed }), { start: bf.solution });
    assert.equal(warm.extra.status, 'Optimal');
    assert.equal(warm.extra.startAccepted, true);
    assert.ok(warm.total <= bf.total + 1e-6 * Math.max(1, bf.total), `seed ${seed}: warm ${warm.total} vs ${bf.total}`);
    assert.ok(rel(warm.extra.planModelObjective, warm.total) < 1e-6, 'model objective = evaluate total');
    if (warm.total < bf.total - 1e-6) detours++;
    rows.push(`${seed}: ${inst.jobs.length} jobs, bf ${bf.total.toFixed(1)}, MIP ${mipTotal.toFixed(1)} (${res.elapsedSec.toFixed(2)} s, ${res.extra.cols} cols), with detours ${warm.total.toFixed(1)}`);
  }
  console.log('# tiny instances: ' + rows.join('; ') + '; detour plans beat the brute force on ' + detours);
});

test('Phase-1-size instance, 20 s limit: violation-free, no worse than its warm start, reports a gap, honors the limit', () => {
  const inst = phase1(1);
  const limit = 20;
  const fr = [];
  let bestSeen = 0, lastBestCost = Infinity;
  const t0 = performance.now();
  const res = S.methods.mip.run(inst, mipParams({ timeLimitSec: limit, mipGap: 0, seed: 7 }), {
    onProgress(p) {
      fr.push(p.fraction);
      assert.ok(p.fraction >= 0 && p.fraction <= 1);
      if (p.best) { bestSeen++; assert.ok(p.bestCost <= lastBestCost + 1e-6); lastBestCost = p.bestCost; }
    }
  });
  const wall = (performance.now() - t0) / 1000;
  const ev = S.evaluate(inst, res.solution);
  assert.ok(ev.feasible, 'violation-free: ' + JSON.stringify(plain(ev.violations)));
  assert.ok(Math.abs(ev.total - res.total) < 1e-6 * Math.max(1, ev.total));
  assert.ok(res.total <= res.extra.startTotal + 1e-9, 'no worse than the warm start');
  assert.equal(typeof res.extra.mipGap, 'number');
  assert.ok(res.extra.mipGap >= 0 && res.extra.mipGap < 1, 'gap ' + res.extra.mipGap);
  assert.ok(res.extra.dualBound <= res.extra.planModelObjective + 1e-6);
  assert.ok(['time', 'optimal', 'gap'].includes(res.stopReason), res.stopReason);   // gap: within 1e-6 is optimal
  assert.equal(res.proof.stopReason, res.stopReason);
  assert.equal(res.proof.gapTarget, 0);
  assert.ok(wall <= limit * 1.15, 'wall ' + wall);
  if (res.stopReason === 'time') assert.ok(wall >= limit * 0.85, 'wall ' + wall);
  assert.ok(bestSeen >= 1, 'progress carried the best plan');
  assert.ok(fr.length >= 10, 'progress calls ' + fr.length);
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i] >= fr[i - 1] - 1e-9, 'fraction never goes back');
  assert.ok(Array.isArray(res.history) && res.history.length >= 1);
  console.log(`# phase-1 seed 1, ${limit} s: start ${res.extra.startTotal.toFixed(1)} (${res.extra.startFrom}, ${res.extra.warmStartSec.toFixed(1)} s) -> ${res.total.toFixed(1)}; ` +
    `${res.extra.status}, proven gap ${(100 * res.extra.mipGap).toFixed(2)}%, bound ${res.extra.dualBound.toFixed(1)}, wall ${wall.toFixed(2)} s, ` +
    `${res.extra.rows} rows, ${res.extra.cols} cols, ${res.extra.binaries} binaries, start accepted ${res.extra.startAccepted}, nodes ${res.iterations}`);
});

// HiGHS reports 'Optimal' (code 7) as soon as its gap is within mip_rel_gap, so a stop at the gap target
// was labelled Optimal. Since 2026-10-06: stopReason 'gap', status 'Within target gap', and result.proof
// says what was proven.
test('a stop at the gap target is not called optimal; result.proof says what was proven', () => {
  const small = (seed) => S.makeTestInstance(seed, { nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2, maxRallyPoints: 3, flatPeriods: true });
  const gap = S.methods.mip.run(small(3), mipParams({ timeLimitSec: 20, mipGap: 0.2, warmStart: false, seed: 1 }), {});
  assert.equal(gap.stopReason, 'gap');
  assert.equal(gap.extra.status, 'Within target gap');
  assert.ok(gap.extra.mipGap > 1e-6 && gap.extra.mipGap <= 0.2 + 1e-9, 'gap ' + gap.extra.mipGap);
  assert.deepEqual(plain(gap.proof), { stopReason: 'gap', gap: gap.extra.mipGap, dualBound: gap.extra.dualBound, gapTarget: 0.2, exactModel: true });
  const opt = S.methods.mip.run(small(2), mipParams({ timeLimitSec: 20, mipGap: 0.2, warmStart: false, seed: 1 }), {});
  assert.equal(opt.stopReason, 'optimal');
  assert.equal(opt.extra.status, 'Optimal');
  assert.ok(opt.proof.gap <= 1e-6);
  assert.equal(opt.proof.stopReason, 'optimal');
  // time-of-day periods: the model is not exact, and the proof says so
  const timed = S.makeTestInstance(3, { nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2, maxRallyPoints: 3 });
  assert.equal(S.methods.mip.run(timed, mipParams({ timeLimitSec: 20, mipGap: 0.2, warmStart: false, seed: 1 }), {}).proof.exactModel, false);
});

test('shouldStop interrupts the solve promptly and keeps the best plan', () => {
  const inst = phase1(2);
  const start = S.construct(inst);
  const t0 = performance.now();
  const res = S.methods.mip.run(inst, mipParams({ timeLimitSec: 60, mipGap: 0 }), {
    start, shouldStop: () => performance.now() - t0 > 3000
  });
  const wall = (performance.now() - t0) / 1000;
  assert.equal(res.stopReason, 'stopped');
  assert.equal(res.proof.stopReason, 'cancel');
  assert.ok(wall < 3 + 3, 'stopped after ' + wall + ' s');
  assert.ok(res.feasible);
  assert.ok(res.total <= S.evaluate(inst, start).total + 1e-9);
});

test('timeCapSec caps timeLimitSec; locked jobs and en-route trucks are respected', () => {
  const inst = S.makeTestInstance(5, { nJobs: 10, nVehicles: 3, nRally: 3, locked: 3, flatPeriods: true });
  inst.vehicles[0].startNode = inst.jobs[0].candidates[0].node;
  inst.vehicles[0].preloaded = true;
  S.prepare.invalidate(inst);
  const t0 = performance.now();
  const res = S.methods.mip.run(inst, Object.assign(mipParams({ timeLimitSec: 600, mipGap: 0 }), { timeCapSec: 6 }), {});
  assert.ok((performance.now() - t0) / 1000 < 6 * 1.15);
  const ev = S.evaluate(inst, res.solution);
  assert.ok(ev.feasible, JSON.stringify(plain(ev.violations)));
  inst.jobs.forEach((j, ji) => {
    if (j.lockedTruck == null) return;
    for (const r of res.solution.routes) for (const v of r.visits) for (const c of v.jobs) {
      if (c.job === ji) assert.equal(inst.vehicles[r.vehicle].id, j.lockedTruck);
    }
  });
});

test('model size for the largest Phase 1 instance (20 stops, 30 jobs, 8 trucks)', () => {
  const big = { nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 3, twoJobShare: 0.5, maxCandidates: 4, directShare: 0.7,
    dismountedShare: 0.1, maxRallyPoints: 4, pinned: 1, capacity: { tanker: 7500, cargo: 30 } };
  const lines = [];
  let worst = null;
  for (let seed = 1; seed <= 3; seed++) {
    const inst = S.makeTestInstance(seed, big);
    const t0 = performance.now();
    const cold = S.mip.buildModel(inst, {});
    const lp = S.mip.toLP(cold);
    const ms = performance.now() - t0;
    const st = cold.stats;
    const reqs = new Set(inst.jobs.map((j) => j.requestId)).size;
    lines.push(`seed ${seed} (${reqs} requests, ${inst.jobs.length} jobs, ${inst.nodes.length} nodes): ${st.rows} rows, ${st.cols} cols, ` +
      `${st.binaries} binaries, ${st.nnz} nonzeros, ${st.chunks} chunks, ${st.arcs} arcs, LP ${(lp.length / 1024).toFixed(0)} KB, built in ${ms.toFixed(0)} ms`);
    if (!worst || st.cols > worst.cols) worst = st;
    assert.ok(st.cols < 20000 && st.rows < 20000, 'model stays small');
    assert.ok(lp.length < 3e6);
    assert.ok(ms < 3000);
  }
  console.log('# largest Phase 1 models: ' + lines.join('; '));
  assert.ok(worst.binaries > 0);
});
