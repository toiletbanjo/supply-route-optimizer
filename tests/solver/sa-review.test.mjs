// Review of src/solver/sa.js (adversarial): the clock never steers the search; inputs and reported plans
// are never mutated; autoAcceptRate is the share of worse proposals (best of 3, as the walk makes them)
// accepted at T0; a start plan where every move helps gets a T0 from a downhill sampling walk; given
// start plans that are infeasible (over-full trucks, closed roads, rally limit, locks) end
// violation-free and start plans with many deferred jobs are refilled first; the best of 12 construct
// orders starts the walk; a huge manual temperature never lets a violation in; the clock jumping past
// the cap and Cancel during any polish end the run at once with a valid plan; non-normalized start
// plans; progress is monotone and ends on the result; every schedule knob at its extremes runs exactly
// budget() proposals; and hard Phase 1 windows (tight capacity, mostly Immediate jobs, closed roads =
// Infinity legs, locks + pinned/banned rally points, a rally limit of 2, preloaded en-route trucks with
// locked loads, all of these mixed) give valid plans that keep locks and en-route start nodes and beat
// construct + localSearch on average.
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
  'src/solver/sa.js'
];
const SRO = loadScripts(FILES);
const S = SRO.solver;
const SA = S.methods.sa;
const COST = { costOnly: true };

const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 3, maxRallyPoints: 8, capacity: { tanker: 7500, cargo: 30 },
  deadlineMin: 60, deadlineMax: 600, riskZones: 3, directShare: 0.3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const small = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({ nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2 }, extra));
const fast = (extra = {}) => Object.assign({ timeCapSec: 600, itersPerTemp: 10, coolingRate: 0.99 }, extra);
// JSON with Infinity kept (the matrices hold Infinity for closed roads)
const J = (x) => JSON.stringify(x, (k, v) => (v === Infinity ? 'Infinity' : v));

function valid(inst, res, label) {
  const ev = S.evaluate(inst, res.solution);
  assert.equal(ev.violations.length, 0, label + ': no violations ' + J(ev.violations.slice(0, 2)));
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total = evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  return ev;
}

// Hard Phase 1 families. 'enroute' is a contingency re-plan: three trucks are already out (startNode a
// rally point, preloaded, available now) and carry two locked jobs each. (Kept as source text so the
// quality test's worker threads build the same instances.)
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

test('the clock never steers the search: a fake clock, progress hooks and the real clock give the identical plan', () => {
  const inst = phase1(2);
  const p = { seed: 5, timeCapSec: 600, itersPerTemp: 10 };
  const a = SA.run(inst, p, {});
  let fake = 0, calls = 0;
  const b = SA.run(inst, p, { now: () => (fake += 0.37), onProgress: () => { calls++; }, shouldStop: () => false });
  assert.equal(a.stopReason, 'budget');
  assert.equal(b.stopReason, 'budget');
  assert.ok(calls > 3);
  assert.equal(J(a.solution), J(b.solution));
  assert.equal(a.total, b.total);
  assert.equal(a.evals, b.evals);
  assert.equal(a.extra.accepted, b.extra.accepted);
  assert.equal(a.extra.T0, b.extra.T0);
});

test('inputs are never mutated: instance, hooks.start, and every plan sent with progress', () => {
  const inst = family('enroute', 3);
  const start = S.construct(inst);
  const instJson = J(inst), startJson = J(start);
  const sent = [];
  let fake = 0;
  const res = SA.run(inst, fast({ seed: 2 }), {
    start,
    now: () => (fake += 1),
    onProgress: (m) => { if (m.best) sent.push({ plan: m.best, json: J(m.best), cost: m.bestCost }); }
  });
  valid(inst, res, 'enroute');
  assert.equal(J(inst), instJson, 'instance unchanged');
  assert.equal(J(start), startJson, 'hooks.start unchanged');
  assert.ok(sent.length >= 2);
  for (const s of sent) {
    assert.equal(J(s.plan), s.json, 'a plan sent with progress is never changed afterwards');
    assert.equal(S.evaluate(inst, s.plan, COST).total, s.cost, 'bestCost is the total of the plan sent');
  }
  assert.equal(J(sent[sent.length - 1].plan), J(res.solution), 'the last plan sent is the result');
});

// Share of worsening proposals (made exactly as the walk makes them: the best of K random moves, those
// that add violations dropped) accepted at temperature T from plan `sol`.
function proposalAcceptance(inst, sol, T, seed, n) {
  const M = S.moves, K = SA._cfg.proposeK;
  const e0 = S.evaluate(inst, sol, COST);
  const ctx = M.context(inst, sol), rng = SRO.util.rng(seed);
  let up = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    let best = null, bv = Infinity;
    for (let k = 0; k < K; k++) {
      const m = M.random(inst, sol, rng, { ctx });
      const nr = m ? M.build(inst, sol, m) : null;
      if (!nr) continue;
      const e = S.evaluate(inst, { routes: nr }, COST);
      if (e.nViolations < bv || (e.nViolations === bv && e.total < best)) { bv = e.nViolations; best = e.total; }
    }
    if (best === null || bv > e0.nViolations) continue;
    const d = best - e0.total;
    if (d > 1e-9 * Math.max(1, e0.total)) { up++; acc += Math.exp(-d / T); }
  }
  return acc / up;
}

test('autoAcceptRate is the share of worse proposals the walk accepts at the start temperature', () => {
  // Before the review T0 was calibrated on single moves while the walk proposes the best of 3, so at
  // the default 0.5 about 80% of the worse proposals were accepted (0.2 -> 43%, 0.8 -> 96%).
  for (const rate of [0.2, 0.5, 0.8]) {
    let sum = 0;
    const seeds = [1, 2, 3, 4, 5, 6];
    for (const seed of seeds) {
      const inst = phase1(seed);
      const rng = SRO.util.rng(seed);
      const start = S.construct(inst, { rng });
      const e = S.evaluate(inst, start, COST);
      const a = SA._autoTemp(inst, start, e.total, e.nViolations, rng, rate);
      sum += proposalAcceptance(inst, start, a.T0, 1000 + seed, 600);
    }
    const mean = sum / seeds.length;
    assert.ok(Math.abs(mean - rate) < 0.06, 'rate ' + rate + ': worse proposals accepted at T0 ' + mean.toFixed(3));
  }
});

test('an empty start plan: T0 is sampled along a downhill walk, not set by the gains of the first insertions', () => {
  for (const seed of [1, 2, 3]) {
    const inst = phase1(seed);
    const rate = S.defaultParams('sa').autoAcceptRate;
    const built = S.construct(inst, { rng: SRO.util.rng(seed) });
    const eb = S.evaluate(inst, built, COST);
    const ref = SA._autoTemp(inst, built, eb.total, 0, SRO.util.rng(seed), rate);
    const empty = S.emptySolution(inst);
    const a = SA._autoTemp(inst, empty, S.evaluate(inst, empty, COST).total, 0, SRO.util.rng(seed), rate);
    assert.ok(a.descended > 0 && a.uphill >= SA._cfg.minUphill, 'seed ' + seed + ': walked downhill and found worse proposals');
    const ratio = a.T0 / ref.T0;
    // (before the review: no worsening sample at all, T0 = the mean gain of an insertion, 17-25x higher)
    assert.ok(ratio > 1 / 4 && ratio < 4, 'seed ' + seed + ': T0 from an empty plan ' + a.T0.toFixed(0) + ' vs ' + ref.T0.toFixed(0));
    const fromEmpty = SA.run(inst, { seed: 5, timeCapSec: 600, itersPerTemp: 10 }, { start: { routes: [] } });
    valid(inst, fromEmpty, 'empty start ' + seed);
  }
});

test('an infeasible start plan always ends violation-free (over-full trucks, closed roads, rally limit, locks)', () => {
  // Before the review 4 of these 24 runs returned a plan with violations (over-capacity, unreachable):
  // the walk never adds a violation and the flat 1e7 penalty gives no slope towards removing one.
  let repaired = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const extra = [{}, { closedZones: 3 }, { maxRallyPoints: 1 }, { locked: 6 }][seed % 4];
    const inst = small(seed, Object.assign({ nJobs: 14 }, extra));
    const start = randomSolution(SRO, inst, SRO.util.rng(seed), { feasibleTypes: seed % 2 === 0 });
    const e0 = S.evaluate(inst, S.normalize(inst, start), COST);
    const res = SA.run(inst, fast({ seed }), { start });
    valid(inst, res, 'infeasible start ' + seed);
    assert.equal(res.extra.startTotal, e0.total, 'startTotal is the given plan');
    assert.equal(res.extra.startFix.violations, e0.nViolations);
    if (e0.nViolations) { repaired++; assert.ok(res.extra.startFix.removed > 0); }
  }
  assert.ok(repaired >= 12, 'most of the start plans had violations: ' + repaired);
});

test('a start plan with many deferred jobs (contingency: two trucks lost, or empty) is refilled before the walk', () => {
  // Before the review an empty start ended 10-45% above a construct start (random inserts build a plan
  // poorly); a refill of the start plan first closes that.
  for (const seed of [1, 4]) {
    const inst = phase1(seed);
    const p = { seed: 5, timeCapSec: 600, itersPerTemp: 10 };
    const ref = SA.run(inst, p, {});
    const built = S.construct(inst);
    const lost = { routes: built.routes.map((r, i) => (i < 2 ? { vehicle: r.vehicle, visits: [] } : r)) };
    for (const [label, start] of [['empty', { routes: [] }], ['two routes emptied', lost]]) {
      const res = SA.run(inst, p, { start });
      valid(inst, res, label + ' ' + seed);
      assert.ok(res.extra.startFix.refillGain > 0, label + ': the refill helped');
      assert.ok(res.total <= ref.total * 1.06, label + ' seed ' + seed + ': ' + res.total.toFixed(0) + ' vs construct start ' + ref.total.toFixed(0));
    }
  }
});

test('start trials: the best of 12 construct orders starts the walk (a rally limit of 2 needs it)', () => {
  // rally2 seeds 4 and 5: the default construct order fixes a rally set that the walk's local moves
  // never leave (before the review the full default run ended at 440,372 and 151,016; the best of 12
  // orders with the default seed starts at 288,991 and 25,528)
  for (const [seed, maxStart] of [[4, 300000], [5, 40000]]) {
    const inst = family('rally2', seed);
    const res = SA.run(inst, fast({ coolingRate: 0.95 }), {});
    valid(inst, res, 'rally2 ' + seed);
    const def = S.evaluate(inst, S.construct(inst, { rng: SRO.util.rng(S.defaultParams('sa').seed) }), COST).total;
    assert.equal(res.extra.startTotal, def, 'startTotal is the default construct');
    assert.equal(res.extra.startTrials.trials, SA._cfg.startTrials);
    assert.ok(res.extra.startTrials.chosen > 0 && res.extra.startTrials.gain > 0);
    assert.ok(def - res.extra.startTrials.gain < maxStart, 'seed ' + seed + ': start ' + (def - res.extra.startTrials.gain).toFixed(0) + ' (default construct ' + def.toFixed(0) + ')');
    assert.ok(res.total < maxStart, 'seed ' + seed + ': ' + res.total.toFixed(0));
  }
});

test('a huge manual start temperature never lets a violation in (closed roads give Infinity legs)', () => {
  for (const seed of [1, 2]) {
    const inst = small(seed, { closedZones: 3, nJobs: 16 });
    const res = SA.run(inst, fast({ seed, startTemp: 1e7 }), {});
    valid(inst, res, 'startTemp 1e7, seed ' + seed);
    assert.equal(res.extra.T0, 1e7);
    assert.ok(res.extra.rejectedViol > 0, 'proposals with violations were made and rejected');
    assert.ok(res.total <= res.extra.startTotal + 1e-9);
  }
});

test('the clock jumping past the cap ends the run at once (no polish) with a valid plan', () => {
  const inst = phase1(4);
  let calls = 0;
  const t0 = performance.now();
  const res = SA.run(inst, { seed: 3, timeCapSec: 30 }, { now: () => performance.now() + (++calls > 200 ? 1e7 : 0) });
  const wall = performance.now() - t0;
  valid(inst, res, 'clock jump');
  assert.equal(res.stopReason, 'time');
  assert.ok(res.extra.polishEvals <= 1, 'no time left for the polish');
  assert.ok(wall < 15000, 'returned ' + wall.toFixed(0) + ' ms after start');
  assert.ok(res.iterations < SA.budget(inst, { timeCapSec: 30 }));
});

test('Cancel during a polish (cycle end, reheat or final) stops it at once and keeps the best plan', () => {
  // (a fake clock that moves 50 ms per call makes every progress check report, so the first polish
  // chunk of the first cooling cycle reports and Cancel comes at the same point on every run)
  const inst = phase1(6);
  let polishing = null, stopAt = 0, fake = 0;
  const after = [];
  const res = SA.run(inst, { seed: 8, timeCapSec: 1e7, itersPerTemp: 5 }, {
    now: () => (fake += 50),
    onProgress: (m) => {
      if (stopAt) after.push(m.message);
      else if (!polishing && /^Polishing/.test(m.message)) polishing = m.message;
    },
    shouldStop: () => { if (polishing && !stopAt) stopAt = performance.now(); return !!polishing; }
  });
  const ms = performance.now() - stopAt;
  assert.equal(polishing, 'Polishing the plan at the end of a cooling cycle');
  valid(inst, res, 'cancel in polish');
  assert.equal(res.stopReason, 'stopped');
  assert.equal(res.extra.reheatsDone, 0, 'no reheat after Cancel');
  assert.equal(res.extra.polishEvals, 0, 'no final polish after Cancel');
  assert.deepEqual(after, ['Done'], 'nothing but the final report after Cancel');
  assert.ok(ms < 1000, 'returned ' + ms.toFixed(0) + ' ms after Cancel');
});

test('a start plan that is not normalized (vehicle twice, routes out of order, bad indexes) is handled', () => {
  for (const seed of [1, 2, 3]) {
    const inst = small(seed);
    const sol = randomSolution(SRO, inst, SRO.util.rng(seed), { feasibleTypes: true });
    const routes = sol.routes.slice().reverse();
    routes.push({ vehicle: routes[0].vehicle, visits: [{ node: inst.jobs[0].candidates[0].node, jobs: [{ job: 0, qty: 0.5 }] }] });
    routes.push({ vehicle: 99, visits: [] });
    routes.push({ vehicle: 0, visits: [{ node: 9999, jobs: [{ job: 1, qty: 1 }] }, { node: 0, jobs: [{ job: 999, qty: 1 }, { job: 1, qty: -2 }] }] });
    const start = { routes };
    const res = SA.run(inst, fast({ seed }), { start });
    valid(inst, res, 'not normalized ' + seed);
    assert.ok(res.total <= S.evaluate(inst, S.normalize(inst, start), COST).total + 1e-9);
  }
});

test('progress: fraction never decreases, bestCost never increases, iteration 0 first and fraction 1 last', () => {
  const inst = phase1(7);
  const seen = [];
  let fake = 0;
  const res = SA.run(inst, { seed: 4, timeCapSec: 600, itersPerTemp: 10 }, { now: () => (fake += 0.05), onProgress: (m) => seen.push(m) });
  valid(inst, res, 'progress');
  assert.equal(seen[0].iteration, 0);
  assert.ok(seen[0].best, 'the first call has the start plan');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].fraction >= seen[i - 1].fraction, 'fraction ' + seen[i - 1].fraction + ' -> ' + seen[i].fraction);
    assert.ok(seen[i].bestCost <= seen[i - 1].bestCost, 'bestCost never goes up');
    assert.ok(seen[i].iteration >= seen[i - 1].iteration);
    assert.ok(seen[i].elapsedSec >= seen[i - 1].elapsedSec);
  }
  const last = seen[seen.length - 1];
  assert.equal(last.fraction, 1);
  assert.equal(last.bestCost, res.total);
  assert.ok(seen.filter((m) => m.fraction < 1).every((m) => m.fraction <= 0.99));
});

test('every schedule knob at its extremes: iterations = budget(), reheats as asked, plan valid', () => {
  const inst = small(4, { nJobs: 8 });
  const cases = [
    { coolingRate: 0.8, itersPerTemp: 1, stopTempRatio: 0.5, reheats: 20 },
    { coolingRate: 0.8, itersPerTemp: 1, stopTempRatio: 1e-6, reheats: 0 },
    { coolingRate: 0.9, itersPerTemp: 7, stopTempRatio: 0.3, reheats: 3, startTemp: 1e-3 },
    { coolingRate: 0.95, itersPerTemp: 2, stopTempRatio: 0.01, reheats: 1, autoAcceptRate: 0.95 },
    { coolingRate: 0.95, itersPerTemp: 2, stopTempRatio: 0.01, reheats: 1, autoAcceptRate: 0.05 }
  ];
  for (const c of cases) {
    const p = Object.assign({ seed: 3, timeCapSec: 600 }, c);
    const res = SA.run(inst, p, {});
    valid(inst, res, J(c));
    assert.equal(res.stopReason, 'budget', J(c));
    assert.equal(res.iterations, SA.budget(inst, p), J(c));
    assert.equal(res.extra.reheatsDone, c.reheats, J(c));
    assert.ok(res.extra.tStop < res.extra.reheatTemp && res.extra.reheatTemp <= res.extra.T0, J(c));
  }
});

// ---- hard Phase 1 families: quality vs construct + localSearch (worker threads, budget-bound) -------
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
try { require('node:os').setPriority(19); } catch (e) { /* not allowed: normal priority */ }
import(workerData.loadUrl).then(({ loadScripts }) => {
  const SRO = loadScripts(workerData.files);
  const S = SRO.solver;
  const family = (0, eval)(workerData.familySrc)(SRO, workerData.P1);
  parentPort.on('message', (task) => {
    const inst = family(task.family, task.seed);
    let sol, extra = null;
    if (task.kind === 'ls') sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(task.seed), timeLimitMs: 60000 });
    else {
      const r = S.methods.sa.run(inst, task.params, {});
      sol = r.solution;
      extra = { total: r.total, feasible: r.feasible, stopReason: r.stopReason };
    }
    const ev = S.evaluate(inst, sol);
    const locks = [], starts = [];
    inst.jobs.forEach((j, ji) => { if (j.lockedTruck) locks.push([ji, j.lockedTruck]); });
    const onTruck = sol.routes.flatMap((r) => r.visits.flatMap((v) => v.jobs.map((c) => [c.job, inst.vehicles[r.vehicle].id])));
    const lockOk = onTruck.every(([j, id]) => !inst.jobs[j].lockedTruck || inst.jobs[j].lockedTruck === id);
    ev.routes.forEach((r) => { const v = inst.vehicles[r.vehicle]; if (v.startNode != null) starts.push(r.legs[0].from === v.startNode); });
    parentPort.postMessage({ id: task.id, total: ev.total, violations: ev.violations.length, extra, lockOk, startsOk: starts.every(Boolean) });
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
  const FAMS = ['tightcap', 'immediate', 'closed', 'locks', 'rally2', 'enroute', 'mix'];
  const seeds = [1, 2, 3, 4, 5];
  const params = { timeCapSec: 600, itersPerTemp: 10 };       // a tenth of the default budget
  const tasks = [];
  for (const family of FAMS) for (const seed of seeds) {
    tasks.push({ family, seed, kind: 'ls' });
    tasks.push({ family, seed, kind: 'sa', params });
  }
  const threads = Math.max(2, Math.min(6, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
  const out = await runPool(tasks, threads);
  const rows = [];
  for (const family of FAMS) for (const seed of seeds) {
    const ls = out[tasks.findIndex((x) => x.family === family && x.seed === seed && x.kind === 'ls')];
    const sa = out[tasks.findIndex((x) => x.family === family && x.seed === seed && x.kind === 'sa')];
    assert.equal(sa.violations, 0, family + ' ' + seed + ': no violations');
    assert.equal(sa.extra.total, sa.total, family + ' ' + seed + ': total = evaluate');
    assert.equal(sa.extra.stopReason, 'budget', family + ' ' + seed);
    assert.ok(sa.lockOk, family + ' ' + seed + ': locked jobs ride their truck');
    assert.ok(sa.startsOk, family + ' ' + seed + ': en-route trucks start where they are');
    rows.push({ family, seed, ls: ls.total, sa: sa.total, d: (sa.total - ls.total) / ls.total });
  }
  const lines = FAMS.map((f) => {
    const r = rows.filter((x) => x.family === f);
    return f + ' ' + (100 * r.reduce((a, x) => a + x.d, 0) / r.length).toFixed(1) + '% (worst ' + (100 * Math.max(...r.map((x) => x.d))).toFixed(1) + '%)';
  });
  const mean = rows.reduce((a, x) => a + x.d, 0) / rows.length;
  t.diagnostic('SA (a tenth of the default budget) vs construct + localSearch, mean per family: ' + lines.join(', ') + '; all ' + (100 * mean).toFixed(2) + '%');
  if (process.env.SA_QUALITY_LOG) rows.forEach((r) => console.log(`  ${r.family} ${r.seed}: LS ${r.ls.toFixed(0)}  SA ${r.sa.toFixed(0)}  ${(100 * r.d).toFixed(2)}%`));
  // Measured 2026-10-06 (budget-bound and seeded, so these repeat while evaluate/construct/localsearch
  // stay the same), mean (worst) vs construct + localSearch: tightcap -1.2% (-0.1%), immediate -21.8%
  // (-0.3%), closed -3.2% (+1.5%), locks -1.9% (+3.7%), rally2 -37.0% (+0.2%), enroute -4.5% (+1.2%),
  // mix -4.6% (+0.5%). Before the review (no start trials): rally2 -11.7%, immediate -9.8%, worst
  // instance +7.3% (locks) and +6.7% (mix); at the full default budget rally2 seeds 4 and 5 ended at
  // 440,372 and 151,016 where the best of 12 construct orders + localSearch gives 81,499 and 23,661.
  for (const f of FAMS) {
    const r = rows.filter((x) => x.family === f);
    assert.ok(r.reduce((a, x) => a + x.d, 0) / r.length <= 0.005, f + ': not worse than construct + localSearch on average');
  }
  assert.ok(mean <= -0.04, 'beats construct + localSearch by more than 4% overall: ' + (100 * mean).toFixed(2) + '%');
  assert.ok(rows.every((r) => r.d <= 0.06), 'never more than 6% worse than construct + localSearch');
  const rally = rows.filter((x) => x.family === 'rally2');
  assert.ok(rally.reduce((a, x) => a + x.d, 0) / rally.length <= -0.15, 'rally limit 2: the start trials find better rally sets');
});
