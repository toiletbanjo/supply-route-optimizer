// Review of src/solver/aco.js (adversarial): a given start plan with violations and an immediate Cancel
// or a tiny cap still end violation-free (construct() is the fallback); inputs and every plan sent with
// progress are never mutated; the clock never steers the search; each option an ant weighs costs exactly
// what evaluate() charges for it; ants stay violation-free on fuzzed windows (en-route trucks at any
// node, no periods, rally limits 0-3, tiny trucks, closures, locks, pins, bans); a progress report comes
// right before every localSearch call and the round polish starts with a short call, so the longest gap
// is about one short localSearch call; Cancel during the final polish and a clock jump past the cap end
// the run at once; every knob at its extremes runs its full budget; non-normalized start plans; and hard
// Phase 1 windows (tight capacity, mostly Immediate jobs, closed roads = Infinity legs, locks + pinned /
// banned rally points, a rally limit of 2, preloaded en-route trucks with locked loads, all mixed) give
// valid plans that keep locks and en-route start nodes and beat construct + localSearch.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { loadScripts, ROOT } from '../load.mjs';
import { randomSolution } from './fixtures.mjs';

const FILES = [
  'src/core/ns.js',
  'src/core/util.js',
  'src/solver/instance.js',
  'src/solver/params.js',
  'src/solver/evaluate.js',
  'src/solver/construct.js',
  'src/solver/localsearch.js',
  'src/solver/aco.js'
];
const SRO = loadScripts(FILES);
const S = SRO.solver;
const ACO = S.methods.aco;
const CFG = ACO._cfg;
const COST = { costOnly: true };

const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 3, maxRallyPoints: 8, capacity: { tanker: 7500, cargo: 30 },
  deadlineMin: 60, deadlineMax: 600, riskZones: 3, directShare: 0.3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const small = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({ nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2 }, extra));
// JSON with Infinity kept (the matrices hold Infinity for closed roads)
const J = (x) => JSON.stringify(x, (k, v) => (v === Infinity ? 'Infinity' : v));
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

function valid(inst, res, label) {
  const ev = S.evaluate(inst, res.solution);
  assert.equal(ev.violations.length, 0, label + ': no violations ' + J(ev.violations.slice(0, 2)));
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total = evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  return ev;
}

// Hard Phase 1 families (the same as sa-review.test.mjs). 'enroute' is a contingency re-plan: three
// trucks are already out (startNode a rally point, preloaded, available now) and carry two locked jobs
// each. Kept as source text so the quality test's worker threads build the same instances.
const FAMILY_SRC = `(function (SRO, P1) {
  const S = SRO.solver;
  const phase1 = (seed, extra) => S.makeTestInstance(seed, Object.assign({}, P1, extra || {}));
  return function family(name, seed) {
    switch (name) {
      case 'tightcap': return phase1(seed, { capacity: { tanker: 2500, cargo: 10 } });
      case 'immediate': return phase1(seed, { tierWeights: [0.1, 0.1, 0.2, 0.6], deadlineMax: 300 });
      case 'closed': return phase1(seed, { closedZones: 3 });
      case 'locks': return phase1(seed, { locked: 8, pinned: 2, banned: 2 });
      case 'rally2': return phase1(seed, { maxRallyPoints: 2, directShare: 0.1 });
      case 'mix': return phase1(seed, { capacity: { tanker: 4000, cargo: 16 }, closedZones: 2, locked: 4, pinned: 1, banned: 1, tierWeights: [0.25, 0.25, 0.25, 0.25], deadlineMax: 360 });
      case 'enroute': {
        const inst = phase1(seed);
        const rng = SRO.util.rng(seed * 31 + 7);
        const rally = inst.nodes.map((n, i) => (n.kind === 'rally' ? i : -1)).filter((i) => i >= 0);
        const picks = new Set([0, inst.vehicles.findIndex((v) => v.type === 'cargo'), inst.vehicles.length - 1]);
        for (const v of picks) {
          const veh = inst.vehicles[v];
          veh.startNode = rally[rng.int(rally.length)]; veh.preloaded = true; veh.availableAt = inst.startMin;
          const ok = inst.jobs.map((j, i) => i).filter((i) => S.typeCompatible(veh, inst.jobs[i]) && !inst.jobs[i].lockedTruck);
          for (let k = 0; k < 2 && ok.length; k++) inst.jobs[ok.splice(rng.int(ok.length), 1)[0]].lockedTruck = veh.id;
        }
        return inst;
      }
      default: throw new Error(name);
    }
  };
})`;
const family = (0, eval)(FAMILY_SRC)(SRO, P1);

test('review: a start plan with violations and an immediate Cancel or a 1 ms cap still ends violation-free', () => {
  // Before the review the given plan was the only plan before the first ant, so Cancel before it returned
  // that plan with its 20-39 violations (seeds 1-4); construct() is now built too and is the fallback.
  for (let seed = 1; seed <= 4; seed++) {
    const inst = phase1(seed, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 3 });
    const bad = randomSolution(SRO, inst, SRO.util.rng(seed));
    const e0 = S.evaluate(inst, S.normalize(inst, bad), COST);
    assert.ok(e0.nViolations > 5, 'seed ' + seed + ': the start plan has violations');
    const stopped = ACO.run(inst, { seed: 1 }, { start: bad, shouldStop: () => true });
    valid(inst, stopped, 'immediate stop ' + seed);
    assert.equal(stopped.stopReason, 'stopped');
    assert.equal(stopped.extra.antsBuilt, 0);
    assert.equal(stopped.extra.startFrom, 'construct');
    assert.equal(stopped.extra.startTotal, e0.total, 'startTotal is the given plan');
    assert.equal(stopped.total, S.evaluate(inst, S.construct(inst, { rng: SRO.util.rng(1) }), COST).total, 'the construct() plan');
    let calls = 0;
    const capped = ACO.run(inst, { seed: 1, timeCapSec: 0.001 }, { start: bad, now: () => (calls++ < 1 ? 0 : 1e6) });
    valid(inst, capped, '1 ms cap ' + seed);
    assert.equal(capped.stopReason, 'time');
    assert.equal(capped.extra.antsBuilt, 0, 'the cap passed before the first ant');
  }
  // a violation-free given plan that beats construct() is kept
  const inst = phase1(3);
  const good = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(4) });
  const eg = S.evaluate(inst, good, COST);
  const r = ACO.run(inst, { seed: 1 }, { start: good, shouldStop: () => true });
  valid(inst, r, 'good start');
  assert.equal(r.extra.startFrom, 'start');
  assert.equal(r.total, eg.total);
});

test('review: inputs are never mutated: instance, params, hooks.start, and every plan sent with progress', () => {
  const inst = family('enroute', 3);
  const start = S.construct(inst);
  const params = { seed: 2, iterations: 15, ants: 8 };
  const instJson = J(inst), startJson = J(start), paramsJson = J(params);
  const sent = [];
  let fake = 0;
  const res = ACO.run(inst, params, {
    start,
    now: () => (fake += 1),
    onProgress: (m) => { if (m.best) sent.push({ plan: m.best, json: J(m.best), cost: m.bestCost }); }
  });
  valid(inst, res, 'enroute');
  assert.equal(J(inst), instJson, 'instance unchanged');
  assert.equal(J(start), startJson, 'hooks.start unchanged');
  assert.equal(J(params), paramsJson, 'params unchanged');
  assert.ok(sent.length >= 2, 'several plans sent: ' + sent.length);
  for (const s of sent) {
    assert.equal(J(s.plan), s.json, 'a plan sent with progress is never changed afterwards');
    assert.equal(S.evaluate(inst, s.plan, COST).total, s.cost, 'bestCost is the total of the plan sent');
  }
  assert.equal(J(sent[sent.length - 1].plan), J(res.solution), 'the last plan sent is the result');
});

test('review: the clock never steers the search: a fake clock, progress hooks and the real clock give the identical plan', () => {
  const inst = phase1(2);
  const p = { seed: 5, iterations: 20 };
  const a = ACO.run(inst, p, {});
  let fake = 0, calls = 0;
  const b = ACO.run(inst, p, { now: () => (fake += 0.37), onProgress: () => { calls++; }, shouldStop: () => false });
  assert.equal(a.stopReason, 'budget');
  assert.equal(b.stopReason, 'budget');
  assert.ok(calls > 3);
  assert.equal(J(a.solution), J(b.solution));
  assert.equal(a.total, b.total);
  assert.equal(a.evals, b.evals);
  assert.deepEqual(a.extra.roundMean, b.extra.roundMean);
  assert.equal(a.extra.reinits, b.extra.reinits);
});

// ---- the ants ----------------------------------------------------------------------------------------
// Steps one ant by hand through build.debug, applies every option it offers to a copy of its plan and
// compares the option's cost with what evaluate() charges (total after - total before + the deferral the
// chunk avoids). Without periods the shift of later stops is uniform, so the cost is exact; with periods
// later stops shift by slightly different amounts (FIFO speeds), so it is close.
function applyOption(sol, o, j) {
  const routes = sol.routes.map((r) => ({ vehicle: r.vehicle, visits: r.visits.map((x) => ({ node: x.node, jobs: x.jobs.map((c) => ({ job: c.job, qty: c.qty })) })) }));
  const R = routes[o.vehicle];
  if (o.pos < 0) {
    const vis = R.visits[-1 - o.pos];
    const c = vis.jobs.find((x) => x.job === j);
    if (c) c.qty += o.qty; else vis.jobs.push({ job: j, qty: o.qty });
  } else R.visits.splice(o.pos, 0, { node: o.node, jobs: [{ job: j, qty: o.qty }] });
  return { routes };
}

test('review: each option an ant weighs costs exactly what evaluate() charges for it, and is violation-free', () => {
  let checked = 0, maxAbs = 0, maxRel = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const noPeriods of [true, false]) {
      const inst = small(seed, { nJobs: 14, pinned: 1, closedZones: 1, capacity: { tanker: 3000, cargo: 12 }, locked: seed % 3 });
      if (noPeriods) inst.periods = [];
      const P = S.prepare(inst);
      const build = ACO._makeBuilder(inst, P, { beta: 3, c0: 50 });
      const D = build.debug;
      const ones = { arcPow: new Float64Array(P.nN * P.nN).fill(1), jnPow: new Float64Array(P.nJ * P.nN).fill(1) };
      const rng = SRO.util.rng(seed);
      D.reset();
      let cur = S.emptySolution(inst);
      for (let j = 0; j < P.nJ; j++) {
        const n = D.options(j, ones.jnPow, ones.arcPow);
        const before = S.evaluate(inst, cur, COST).total;
        for (let i = 0; i < n; i++) {
          const o = D.option(i);
          const after = S.evaluate(inst, applyOption(cur, o, j), COST);
          assert.ok(after.feasible, `seed ${seed} job ${j}: option ${J(o)} is violation-free`);
          const gain = P.jDeferW[j] * o.qty * P.jInvQty[j];
          assert.ok(o.cost < gain, 'an option never costs more than the deferral it avoids');
          const delta = after.total - before + gain;
          const err = Math.abs(delta - o.cost);
          if (noPeriods) maxAbs = Math.max(maxAbs, err / Math.max(1, Math.abs(delta)));
          else maxRel = Math.max(maxRel, err / Math.max(1, Math.abs(delta)));
          checked++;
        }
        if (n) { const i = Math.floor(rng() * n); cur = applyOption(cur, D.option(i), j); D.place(j, i); }
      }
    }
  }
  assert.ok(checked > 500, 'options checked: ' + checked);
  assert.ok(maxAbs < 1e-9, 'no periods: exact (relative error ' + maxAbs + ')');
  assert.ok(maxRel < 0.01, 'with periods: within 1% (' + maxRel + ')');
});

test('review: ants stay violation-free on fuzzed windows (en-route trucks anywhere, no periods, rally limits 0-3, tiny trucks)', () => {
  let plans = 0, enroute = 0, rally0 = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rng = SRO.util.rng(seed * 7 + 1);
    const inst = S.makeTestInstance(seed, {
      nJobs: 8 + rng.int(25), nVehicles: 1 + rng.int(8), nRally: 2 + rng.int(9), nHubs: 1 + rng.int(3),
      maxRallyPoints: rng.int(4), closedZones: rng.int(4), locked: rng.int(6), pinned: rng.int(2), banned: rng.int(2),
      capacity: { tanker: [500, 2500, 7500][rng.int(3)], cargo: [3, 10, 30][rng.int(3)] }, tierWeights: [0.25, 0.25, 0.25, 0.25],
      deadlineMax: 200 + rng.int(600), flatPeriods: rng() < 0.2
    });
    inst.params.pinnedRally = inst.params.pinnedRally.slice(0, inst.params.maxRallyPoints);
    const rally = inst.nodes.map((n, i) => (n.kind === 'rally' ? i : -1)).filter((i) => i >= 0);
    inst.vehicles.forEach((v) => {
      if (rng() < 0.4) { v.startNode = rng() < 0.7 ? rally[rng.int(rally.length)] : rng.int(inst.nodes.length); v.preloaded = true; v.availableAt = inst.startMin - 30; enroute++; }
    });
    if (rng() < 0.3) inst.periods = [];
    assert.equal(S.validateInstance(inst).length, 0, 'seed ' + seed + ' is a valid instance');
    const P = S.prepare(inst);
    for (const [alpha, beta] of [[0, 0], [1, 3], [10, 10], [10, 0]]) {
      const build = ACO._makeBuilder(inst, P, { beta, c0: 30 });
      const arcPow = new Float64Array(P.nN * P.nN), jnPow = new Float64Array(P.nJ * P.nN);
      for (let k = 0; k < arcPow.length; k++) arcPow[k] = Math.pow(Math.pow(10, -2.3 * rng()), alpha / 2);
      for (let k = 0; k < jnPow.length; k++) jnPow[k] = Math.pow(Math.pow(10, -2.3 * rng()), alpha);
      for (let k = 0; k < 3; k++) {
        const ev = S.evaluate(inst, build(rng, { arcPow, jnPow }));
        assert.equal(ev.violations.length, 0, `seed ${seed} alpha ${alpha} beta ${beta}: ${J(ev.violations.slice(0, 2))}`);
        plans++;
      }
    }
    const res = ACO.run(inst, { seed, iterations: 3, ants: 5 }, {});
    const ev = valid(inst, res, 'run ' + seed);
    if (inst.params.maxRallyPoints === 0) { assert.equal(ev.stats.rallyPoints, 0); rally0++; }
  }
  assert.ok(plans === 360 && enroute > 20 && rally0 > 3, `plans ${plans}, en-route trucks ${enroute}, rally limit 0 windows ${rally0}`);
});

// ---- progress, Cancel, clock ---------------------------------------------------------------------------
// Records, for each top-level localSearch call, its evaluation budget and the time since the last report.
function watchLocalSearch(lastReport, now) {
  const orig = S.localSearch;
  const calls = [];
  let depth = 0;
  S.localSearch = function (inst, sol, opts) {
    if (depth === 0) calls.push({ maxIters: opts.maxIters, sinceReport: now() - lastReport() });
    depth++;
    try { return orig.call(this, inst, sol, opts); } finally { depth--; }
  };
  return { calls, restore: () => { S.localSearch = orig; } };
}

test('review: a report comes right before every localSearch call; each round polish starts with a short call', () => {
  // Before the review progress was only checked between ants and after each round (every 100 ms), and
  // the round polish was one 4000-evaluation localSearch call: on phase1(2) a gap of 213 ms (CPU clock,
  // Node) against the contract's 250 ms, so a slower browser worker would miss it.
  const inst = phase1(2);
  let fake = 0, last = 0;
  const now = () => (fake += 3);
  const w = watchLocalSearch(() => last, () => fake);
  let res;
  try {
    res = ACO.run(inst, { seed: 9, iterations: 25 }, { now, onProgress: () => { last = fake; } });
  } finally { w.restore(); }
  valid(inst, res, 'fake clock');
  const round = w.calls.filter((c) => c.maxIters <= CFG.lsEvals), polish = w.calls.filter((c) => c.maxIters > CFG.lsEvals);
  assert.equal(round.filter((c) => c.maxIters === CFG.lsFirstChunk).length, res.iterations, 'one short first call per round');
  assert.ok(round.every((c) => c.maxIters === CFG.lsFirstChunk || c.maxIters <= CFG.lsEvals - CFG.lsFirstChunk), 'the rest of the round budget in a second call');
  assert.ok(polish.length >= 1, 'final polish ran');
  // (the clock moves 3 ms per call and is read twice more between the check and the call)
  for (const c of w.calls) assert.ok(c.sinceReport <= CFG.preLsMs + 6, 'a localSearch call starts ' + c.sinceReport + ' ms (fake clock) after a report');
});

test('review: progress gaps on hard windows stay far below 250 ms (CPU clock) without flooding', () => {
  let worst = 0, calls = 0, secs = 0, worstAt = '';
  for (const [f, seed] of [['locks', 1], ['enroute', 1], ['mix', 3]]) {
    let last = null;
    const inst = family(f, seed);
    const r = ACO.run(inst, { seed: 2, iterations: 40 }, {
      now: cpuNow,
      onProgress: () => { const x = cpuNow(); if (last !== null && x - last > worst) { worst = x - last; worstAt = f + ' ' + seed; } last = x; calls++; }
    });
    valid(inst, r, f + ' ' + seed);
    secs += r.elapsedSec;
  }
  const base = phase1(2);
  let last = null;
  const r = ACO.run(base, { seed: 9, iterations: 40 }, { now: cpuNow, onProgress: () => { const x = cpuNow(); if (last !== null && x - last > worst) { worst = x - last; worstAt = 'phase1 2'; } last = x; calls++; } });
  secs += r.elapsedSec;
  // measured about 50-110 ms in Node; the bound leaves room for a slower machine
  assert.ok(worst <= 200, 'longest gap ' + worst.toFixed(0) + ' ms at ' + worstAt);
  assert.ok(calls / secs <= 80, 'reports per second ' + (calls / secs).toFixed(1));
});

test('review: Cancel during the final polish stops it at once; a clock jump past the cap ends the run with no polish', () => {
  const inst = phase1(6);
  let polishing = false, stopAt = 0, fake = 0;
  const after = [];
  const res = ACO.run(inst, { seed: 8, iterations: 10 }, {
    now: () => (fake += 30),
    onProgress: (m) => { if (stopAt) after.push(m.message); else if (/^Polishing the best plan/.test(m.message)) polishing = true; },
    shouldStop: () => { if (polishing && !stopAt) stopAt = performance.now(); return polishing; }
  });
  const ms = performance.now() - stopAt;
  assert.ok(stopAt > 0, 'the final polish was reached');
  valid(inst, res, 'cancel in polish');
  assert.equal(res.stopReason, 'stopped');
  assert.equal(res.extra.polishEvals, 0, 'no polish evaluations after Cancel');
  assert.deepEqual(after, ['Done'], 'nothing but the final report after Cancel');
  assert.ok(ms < 1000, 'returned ' + ms.toFixed(0) + ' ms after Cancel');

  const inst2 = phase1(4);
  let calls = 0;
  const t0 = performance.now();
  const r2 = ACO.run(inst2, { seed: 3, timeCapSec: 30 }, { now: () => performance.now() + (++calls > 300 ? 1e7 : 0) });
  valid(inst2, r2, 'clock jump');
  assert.equal(r2.stopReason, 'time');
  assert.equal(r2.extra.polishEvals, 0, 'no time left for the polish');
  assert.ok(performance.now() - t0 < 10000);
  assert.ok(r2.iterations < ACO.budget(inst2, {}));
});

test('review: every knob at its extremes gives a valid plan and runs its full budget', () => {
  const inst = phase1(5, { nJobs: 20 });
  const cases = [
    { ants: 1, iterations: 1 }, { ants: 1, iterations: 30 }, { ants: 500, iterations: 2 },
    { alpha: 10, beta: 10, iterations: 10 }, { alpha: 0, beta: 0, iterations: 10 }, { alpha: 10, beta: 0, iterations: 10 },
    { evaporation: 0.99, q: 1000, iterations: 10 }, { evaporation: 0.01, q: 0.01, iterations: 10 },
    { alpha: 10, beta: 10, iterations: 10, localSearch: false }
  ];
  for (const c of cases) {
    const p = Object.assign({ seed: 3, timeCapSec: 600 }, c);
    const res = ACO.run(inst, p, {});
    valid(inst, res, J(c));
    const q = S.clampParams('aco', p);
    assert.equal(res.stopReason, 'budget', J(c));
    assert.equal(res.iterations, ACO.budget(inst, p), J(c));
    assert.equal(res.extra.antsBuilt, q.ants * q.iterations, J(c));
    assert.ok(res.extra.tauMax === 1 / q.evaporation, J(c));
    if (c.localSearch === false) assert.equal(res.extra.lsEvals, 0);
  }
});

test('review: a start plan that is not normalized (vehicle twice, routes out of order, bad indexes) is handled', () => {
  for (const seed of [1, 2, 3]) {
    const inst = small(seed);
    const sol = randomSolution(SRO, inst, SRO.util.rng(seed), { feasibleTypes: true });
    const routes = sol.routes.slice().reverse();
    routes.push({ vehicle: routes[0].vehicle, visits: [{ node: inst.jobs[0].candidates[0].node, jobs: [{ job: 0, qty: 0.5 }] }] });
    routes.push({ vehicle: 99, visits: [] });
    routes.push({ vehicle: 0, visits: [{ node: 9999, jobs: [{ job: 1, qty: 1 }] }, { node: 0, jobs: [{ job: 999, qty: 1 }, { job: 1, qty: -2 }] }] });
    const start = { routes };
    const res = ACO.run(inst, { seed, iterations: 8, ants: 10 }, { start });
    valid(inst, res, 'not normalized ' + seed);
    assert.ok(res.total <= S.evaluate(inst, S.normalize(inst, start), COST).total + 1e-9);
  }
});

// ---- hard Phase 1 families: quality vs construct + localSearch (worker threads, budget-bound) -------
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
try { require('node:os').setPriority(19); } catch (e) { /* not allowed here: run at normal priority */ }
import(workerData.loadUrl).then(({ loadScripts }) => {
  const SRO = loadScripts(workerData.files);
  const S = SRO.solver;
  const family = (0, eval)(workerData.familySrc)(SRO, workerData.P1);
  parentPort.on('message', (task) => {
    const inst = family(task.family, task.seed);
    let sol, extra = null;
    if (task.kind === 'ls') sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(task.seed), timeLimitMs: 60000 });
    else { const r = S.methods.aco.run(inst, task.params, {}); sol = r.solution; extra = { total: r.total, stopReason: r.stopReason }; }
    const ev = S.evaluate(inst, sol);
    let lockOk = true, startsOk = true;
    ev.routes.forEach((rt) => {
      const veh = inst.vehicles[rt.vehicle];
      if (veh.startNode != null && rt.legs[0].from !== veh.startNode) startsOk = false;
      rt.stops.forEach((st) => st.jobs.forEach((c) => { const lk = inst.jobs[c.job].lockedTruck; if (lk != null && lk !== veh.id) lockOk = false; }));
    });
    parentPort.postMessage({ id: task.id, total: ev.total, violations: ev.violations.length, lockOk, startsOk, extra });
  });
});
`;

function runPool(tasks, nThreads) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    let next = 0, done = 0;
    const workers = [];
    const finish = (err) => { workers.forEach((w) => w.terminate()); err ? reject(err) : resolve(results); };
    for (let i = 0; i < Math.min(nThreads, tasks.length); i++) {
      const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { loadUrl: pathToFileURL(path.join(ROOT, 'tests/load.mjs')).href, files: FILES, familySrc: FAMILY_SRC, P1 }
      });
      workers.push(w);
      const feed = () => { if (next < tasks.length) { const id = next++; w.postMessage(Object.assign({ id }, tasks[id])); } };
      w.on('message', (m) => { results[m.id] = m; done++; if (done === tasks.length) finish(); else feed(); });
      w.on('error', finish);
      feed();
    }
  });
}

test('quality on hard Phase 1 windows: valid, locks and en-route starts kept, better than construct + localSearch', { timeout: 30 * 60 * 1000 }, async (t) => {
  const FAMS = ['tightcap', 'immediate', 'closed', 'locks', 'rally2', 'mix', 'enroute'];
  const seeds = [1, 2, 3, 4];
  const params = { timeCapSec: 600, iterations: 30 };        // a fifth of the default rounds: budget-bound
  const tasks = [];
  for (const family of FAMS) for (const seed of seeds) {
    tasks.push({ family, seed, kind: 'ls' });
    tasks.push({ family, seed, kind: 'aco', params });
  }
  const threads = Math.max(2, Math.min(4, (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  const out = await runPool(tasks, threads);
  const rows = [];
  for (const family of FAMS) for (const seed of seeds) {
    const ls = out[tasks.findIndex((x) => x.family === family && x.seed === seed && x.kind === 'ls')];
    const aco = out[tasks.findIndex((x) => x.family === family && x.seed === seed && x.kind === 'aco')];
    const label = family + ' ' + seed;
    assert.equal(aco.violations, 0, label + ': no violations');
    assert.equal(aco.extra.total, aco.total, label + ': total = evaluate');
    assert.equal(aco.extra.stopReason, 'budget', label);
    assert.ok(aco.lockOk, label + ': locked jobs ride their truck');
    assert.ok(aco.startsOk, label + ': en-route trucks start where they are');
    rows.push({ family, seed, ls: ls.total, aco: aco.total, d: (aco.total - ls.total) / ls.total });
  }
  const lines = FAMS.map((f) => {
    const r = rows.filter((x) => x.family === f);
    return f + ' ' + (100 * r.reduce((s, x) => s + x.d, 0) / r.length).toFixed(2) + '%';
  });
  const mean = rows.reduce((s, x) => s + x.d, 0) / rows.length;
  t.diagnostic('ACO (30 rounds) vs construct + localSearch, mean per family: ' + lines.join(', ') + '; all ' + (100 * mean).toFixed(2) + '%');
  if (process.env.ACO_QUALITY_LOG) rows.forEach((r) => console.log(`  ${r.family} ${r.seed}: LS ${r.ls.toFixed(0)}  ACO ${r.aco.toFixed(0)}  ${(100 * r.d).toFixed(2)}%`));
  // Measured 2026-10-06 (deterministic): tightcap -1.71%, immediate -25.05%, closed -4.06%, locks -0.54%,
  // rally2 -44.75%, mix -10.22%, enroute -4.32%; all -12.95%; worst single window +0.25% (locks).
  // At the full default budget, against the best plan any of ACO / SA / tabu (default params) or
  // construct + localSearch found on 5 seeds per family, ACO's mean gap was 0.0-0.8% on every family but
  // mix (3.7%, one window 17% where every method's result spreads 15-25% over seeds).
  assert.ok(mean < -0.05, 'better than construct + localSearch on average: ' + (100 * mean).toFixed(2) + '%');
  for (const f of FAMS) {
    const r = rows.filter((x) => x.family === f);
    const m = r.reduce((s, x) => s + x.d, 0) / r.length;
    assert.ok(m < 0.005, f + ': not worse than construct + localSearch on average (' + (100 * m).toFixed(2) + '%)');
  }
  for (const f of ['immediate', 'rally2', 'mix']) {
    const r = rows.filter((x) => x.family === f);
    assert.ok(r.reduce((s, x) => s + x.d, 0) / r.length < -0.05, f + ': clearly better than construct + localSearch');
  }
});
