// Independent review tests for tabu search (src/solver/tabu.js): adversarial instances, bad start plans,
// rally-limit-bound windows, extreme knobs, mutation of shared objects, and the progress / time-cap /
// shouldStop contract at the largest neighborhood. Budget-bound wherever a result is compared (never
// time-bound), so the assertions do not depend on machine speed; the timing checks run on a CPU-time
// clock (hooks.now) so other processes on a busy machine cannot stretch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadScripts, ROOT } from '../load.mjs';
import { randomSolution, plain } from './fixtures.mjs';

const SRO = loadScripts([
  'src/core/ns.js',
  'src/core/util.js',
  'src/solver/instance.js',
  'src/solver/params.js',
  'src/solver/evaluate.js',
  'src/solver/construct.js',
  'src/solver/localsearch.js',
  'src/solver/tabu.js'
]);
const S = SRO.solver;
const TABU = S.methods.tabu;
const COST = { costOnly: true };

const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 2, maxRallyPoints: 8, capacity: { tanker: 6000, cargo: 25 },
  deadlineMin: 60, deadlineMax: 480, riskZones: 3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const tolOf = (x) => 1e-9 * Math.max(1, Math.abs(x));

function checkPlan(inst, res, label) {
  assert.ok(res && res.solution && Array.isArray(res.solution.routes), label + ': a plan');
  const ev = S.evaluate(inst, res.solution);
  assert.deepEqual(plain(ev.violations.map((v) => v.code)), [], label + ': no violations');
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total equals evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  for (const r of res.solution.routes) for (const v of r.visits) {
    assert.ok(v.jobs.length > 0, label + ': no empty visits');
    for (const c of v.jobs) assert.ok(c.qty > 0 && Number.isFinite(c.qty), label + ': positive chunks');
  }
  assert.equal(res.history[res.history.length - 1].best, res.total, label + ': history ends at the result');
  return ev;
}

// The adversarial instance edits of solver-review.test.mjs (construct / localSearch), here for tabu.
const VARIANTS = {
  noVehicles: (i) => { i.vehicles = []; },
  noJobs: (i) => { i.jobs = []; },
  zeroCapacity: (i) => { i.vehicles.forEach((v) => { v.capacity = 0; }); },
  rallyLimit0: (i) => { i.params.maxRallyPoints = 0; },
  morePinsThanLimit: (i) => { i.params.pinnedRally = i.nodes.map((n, k) => (n.kind === 'rally' ? k : -1)).filter((k) => k >= 0).slice(0, 3); i.params.maxRallyPoints = 1; },
  everythingClosed: (i) => { const n = i.nodes.length; for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) { i.minutes[a][b] = Infinity; i.miles[a][b] = Infinity; } },
  noWayBackToHub0: (i) => { for (let a = 1; a < i.nodes.length; a++) i.minutes[a][0] = Infinity; },
  enRoute: (i) => { i.vehicles.forEach((v, k) => { if (k % 2 === 0) Object.assign(v, { preloaded: true, startNode: i.nodes.length - 1, availableAt: i.startMin + 30 }); }); },
  enRouteCutOff: (i) => { const s = i.nodes.length - 1; i.vehicles.forEach((v) => Object.assign(v, { preloaded: true, startNode: s })); for (let b = 0; b < s; b++) i.minutes[s][b] = Infinity; },
  lockedToGhost: (i) => { i.jobs.forEach((j) => { j.lockedTruck = 'GHOST'; }); },
  allLocked: (i) => { i.jobs.forEach((j) => { const v = i.vehicles.find((x) => S.typeCompatible(x, j)); j.lockedTruck = v ? v.id : null; }); },
  floatQuantities: (i) => { i.vehicles.forEach((v) => { v.capacity = 0.3; }); i.jobs.forEach((j, k) => { j.qty = [0.1, 0.2, 0.3, 0.7][k % 4]; }); },
  hugeJobs: (i) => { i.jobs.forEach((j) => { j.qty *= 13; }); },
  deadlinesPassed: (i) => { i.jobs.forEach((j) => { j.deadline = i.startMin - 500; j.tier = 3; j.hardDeadline = true; }); },
  allImmediate: (i) => { i.jobs.forEach((j, k) => { j.tier = 3; j.hardDeadline = true; j.deadline = i.startMin + 30 + 20 * k; }); },
  freeDeferral: (i) => { i.penalties.defer = [0, 0, 0, 0]; },
  zeroWeights: (i) => { i.weights = { fuel: 0, distance: 0, risk: 0, simplicity: 0 }; },
  noPeriods: (i) => { i.periods = []; },
  duplicateCandidates: (i) => { i.jobs.forEach((j) => { j.candidates = j.candidates.concat(j.candidates.map((c) => Object.assign({}, c, { platoonCost: 999 }))); }); },
  hubAsCandidate: (i) => { i.jobs.forEach((j) => { j.candidates.push({ node: 0, platoonMiles: 30, platoonCost: 15 }); }); },
  oneRequest: (i) => { i.jobs.forEach((j) => { j.requestId = 'R-X'; }); },
  negativeQty: (i) => { if (i.jobs.length) i.jobs[0].qty = -5; }
};

test('review: adversarial instances: violation-free, total = evaluate, never worse than construct, deterministic', () => {
  let runs = 0;
  for (const [name, edit] of Object.entries(VARIANTS)) {
    for (let seed = 1; seed <= 3; seed++) {
      const inst = S.makeTestInstance(seed, {
        nJobs: 3 + 4 * seed, nVehicles: 1 + 2 * seed % 5, nRally: 2 + seed, closedZones: seed % 2, pinned: seed % 2,
        banned: seed % 2, locked: seed % 3, maxRallyPoints: 1 + seed % 3
      });
      edit(inst);
      S.prepare.invalidate(inst);
      const label = `${name} seed ${seed}`;
      const params = { seed, timeCapSec: 60, iterations: 150, neighborhood: 30, restartAfter: 30 };
      const res = TABU.run(inst, params, {});
      const ev = checkPlan(inst, res, label);
      const c = S.evaluate(inst, S.construct(inst), COST);
      assert.ok(ev.total <= c.total + tolOf(c.total), label + ': not worse than construct');
      assert.ok(res.iterations <= 150, label + ': iterations within the budget');
      assert.ok(['budget', 'converged'].includes(res.stopReason), label + ': ' + res.stopReason);
      if (seed === 1) {
        const again = TABU.run(inst, params, {});
        assert.deepEqual(plain(again.solution), plain(res.solution), label + ': same seed, same plan');
        assert.equal(again.evals, res.evals, label + ': same seed, same work');
      }
      runs++;
    }
  }
  assert.equal(runs, Object.keys(VARIANTS).length * 3);
});

// Start plans a contingency re-plan or a careless caller could pass: wrong truck types, 3x the job
// quantity, every job on one truck, two routes for one truck, out-of-range indexes, NaN quantities.
function badStarts(inst, rng) {
  const wrong = { routes: inst.vehicles.map((_, i) => ({ vehicle: i, visits: [] })) };
  inst.jobs.forEach((j, k) => { if (j.candidates.length && wrong.routes.length) wrong.routes[k % wrong.routes.length].visits.push({ node: j.candidates[0].node, jobs: [{ job: k, qty: j.qty * 3 }] }); });
  const visits = inst.jobs.map((j, k) => (j.candidates.length ? { node: j.candidates[j.candidates.length - 1].node, jobs: [{ job: k, qty: j.qty }] } : null)).filter(Boolean);
  const oneTruck = { routes: [{ vehicle: 0, visits }, { vehicle: 0, visits: visits.slice(0, 3) }] };
  const junk = {
    routes: [
      { vehicle: 99, visits: [{ node: 0, jobs: [{ job: 0, qty: 1 }] }] },
      { vehicle: 1, visits: [{ node: 9999, jobs: [{ job: 1, qty: 1 }] }, { node: 2, jobs: [{ job: 9999, qty: 1 }, { job: 2, qty: NaN }, { job: 3, qty: -4 }] }, { node: 3, jobs: [] }] },
      null
    ]
  };
  return { wrong, oneTruck, junk, random: randomSolution(SRO, inst, rng) };
}

test('review: bad start plans (hooks.start) are repaired; the result is never worse than construct or the start', () => {
  const rng = SRO.util.rng(11);
  let fromConstruct = 0, fromStart = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const inst = phase1(seed, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 3 });
    const cons = S.evaluate(inst, S.construct(inst), COST).total;
    for (const [name, start] of Object.entries(badStarts(inst, rng))) {
      const label = `seed ${seed} ${name}`;
      const before = JSON.stringify(start);
      const e0 = S.evaluate(inst, S.normalize(inst, start), COST);
      // a small budget with restarts off: no construct()-based restart can rescue the run
      const res = TABU.run(inst, { seed, timeCapSec: 60, iterations: 100, neighborhood: 10, restartAfter: 0 }, { start });
      checkPlan(inst, res, label);
      assert.equal(JSON.stringify(start), before, label + ': hooks.start not modified');
      assert.equal(res.extra.startTotal, e0.total, label + ': startTotal is the given plan');
      assert.ok(res.total <= cons + tolOf(cons), label + `: ${res.total} not worse than construct ${cons}`);
      if (e0.feasible) assert.ok(res.total <= e0.total + tolOf(e0.total), label + ': not worse than the start');
      if (res.extra.startFrom === 'construct') fromConstruct++; else { assert.equal(res.extra.startFrom, 'start'); fromStart++; }
    }
  }
  // both ways happen: a rough start plan can lead to a better plan than construct() does
  assert.ok(fromConstruct > 0 && fromStart > 0, `startFrom construct ${fromConstruct}, start ${fromStart}`);
});

test('review: a short time cap or an immediate stop still returns a violation-free plan from a bad start', () => {
  const inst = phase1(5, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 3 });
  const { wrong } = badStarts(inst, SRO.util.rng(1));
  // stop asked before the start polish could repair it: the plan is the better of start and construct
  const r1 = TABU.run(inst, { seed: 1, timeCapSec: 0.05, iterations: 4000 }, { start: wrong, now: cpuNow });
  checkPlan(inst, r1, 'cap 0.05 s');
  assert.equal(r1.stopReason, 'time');
  let calls = 0;
  const r2 = TABU.run(inst, { seed: 1, timeCapSec: 600 }, { start: wrong, shouldStop: () => ++calls > 1 });
  assert.equal(r2.stopReason, 'stopped');
  assert.equal(r2.total, S.evaluate(inst, r2.solution).total);
});

// Windows where maxRallyPoints binds: 2 pinned rally points, a limit of 3, closed roads, locks. A job
// whose only candidates are unused rally points stays deferred until a whole rally point is emptied,
// which no single move, route ruin or localSearch does. Before the rally-point shake, tabu ended at
// 74,727-75,270 on seed 3 for every params.seed tried, at the default budget and at 1000 iterations
// (three jobs deferred; plans of 10,000-15,000 exist), and on seed 4 one run in six kept an Immediate
// job deferred (158,871-159,202 against about 10,000). Default params (the product's setting).
test('review: rally-limit-bound windows: tabu swaps rally points instead of deferring jobs', () => {
  let rallyTrials = 0;
  for (const [seed, maxTotal] of [[3, 30000], [4, 20000]]) {
    const inst = phase1(seed, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 3 });
    const ls = [];
    for (let r = 1; r <= 5; r++) ls.push(S.evaluate(inst, S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(r) }), COST).total);
    const res = TABU.run(inst, { seed: 20261005, timeCapSec: 1800 }, {});
    const ev = checkPlan(inst, res, 'rally seed ' + seed);
    assert.equal(res.stopReason, 'budget');
    assert.ok(ev.stats.rallyPoints <= 3);
    assert.ok(res.total <= maxTotal, `seed ${seed}: ${res.total.toFixed(0)} (construct + localSearch x5: ${ls.map(Math.round).join(', ')})`);
    assert.ok(res.total <= 1.1 * Math.min(...ls), `seed ${seed}: within 10% of the best of 5 construct + localSearch runs`);
    assert.equal(ev.deferred.filter((d) => inst.jobs[d.job].tier === 3).length, 0, 'no Immediate job deferred');
    rallyTrials += res.extra.rallyTrials;
  }
  assert.ok(rallyTrials > 0, 'rally points were shaken');
  // the rally shake runs only while the limit binds: never when every rally point may be used
  const free = phase1(3, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 10 });
  const r = TABU.run(free, { seed: 20261005, timeCapSec: 1800, iterations: 600 }, {});
  checkPlan(free, r, 'no rally limit');
  assert.equal(r.extra.rallyTrials, 0);
});

test('review: neighborhood above one sampling chunk: every candidate is scored, plan valid, deterministic', () => {
  const inst = phase1(6);
  const k = 600;                                     // above CFG.nbChunk (250): sampled in 3 calls
  const p = { seed: 2, timeCapSec: 600, iterations: 120, neighborhood: k, restartAfter: 0 };
  const a = TABU.run(inst, p, {});
  checkPlan(inst, a, 'k ' + k);
  const walk = a.extra.steps;
  assert.ok(walk > 0);
  assert.ok(a.extra.walkEvals > 0.95 * walk * k && a.extra.walkEvals <= walk * k, `walkEvals ${a.extra.walkEvals} for ${walk} steps of ${k}`);
  const b = TABU.run(inst, p, {});
  assert.deepEqual(plain(b.solution), plain(a.solution));
  assert.equal(b.evals, a.evals);
});

test('review: largest neighborhood (5000): progress and shouldStop at least every 250 ms, time cap within 10%', (t) => {
  const inst = phase1(4);
  for (const params of [{ neighborhood: 5000 }, { neighborhood: 5000, restartAfter: 2, tenure: 200 }, { neighborhood: 10, restartAfter: 1 }]) {
    let last = null, maxGap = 0, lastStop = null, maxStop = 0, n = 0, lastBestCost = Infinity;
    const t0 = cpuNow();
    const res = TABU.run(inst, Object.assign({ seed: 3, timeCapSec: 2, iterations: 100000 }, params), {
      now: cpuNow,
      onProgress: (q) => {
        const tt = cpuNow();
        if (last !== null) maxGap = Math.max(maxGap, tt - last);
        last = tt; n++;
        assert.ok(q.fraction >= 0 && q.fraction <= 1);
        if (q.best) {
          const c = S.evaluate(inst, q.best, COST).total;
          assert.ok(c < lastBestCost, 'a new best is better');
          lastBestCost = c;
        }
        assert.equal(q.bestCost, lastBestCost, 'bestCost in sync with the last plan sent');
      },
      shouldStop: () => { const tt = cpuNow(); if (lastStop !== null) maxStop = Math.max(maxStop, tt - lastStop); lastStop = tt; return false; }
    });
    const elapsed = (cpuNow() - t0) / 1000;
    t.diagnostic(`${JSON.stringify(params)}: ${n} progress calls, max gap ${maxGap.toFixed(0)} ms, shouldStop max gap ${maxStop.toFixed(0)} ms, ` +
      `elapsed ${elapsed.toFixed(3)} s (CPU), ${res.extra.steps} steps, ${res.extra.restarts} restarts, stop ${res.stopReason}`);
    checkPlan(inst, res, JSON.stringify(params));
    assert.ok(maxGap <= 250, 'progress gap ' + maxGap.toFixed(0) + ' ms');
    assert.ok(maxStop <= 250, 'shouldStop gap ' + maxStop.toFixed(0) + ' ms');
    assert.ok(elapsed <= 2.2, 'elapsed ' + elapsed.toFixed(3) + ' s for a 2 s cap');
    assert.equal(lastBestCost, res.total, 'the last plan sent is the result');
    if (res.stopReason === 'time') assert.ok(elapsed >= 1.7, 'uses the time it has: ' + elapsed.toFixed(3));
  }
});

test('review: the instance, the params and every plan sent with progress stay unchanged', () => {
  const inst = phase1(2, { locked: 3, pinned: 1, banned: 1, closedZones: 1 });
  const instJson = JSON.stringify(inst, S.jsonReplacer || SRO.util.jsonReplacer);
  const params = { seed: 4, timeCapSec: 600, iterations: 600, restartAfter: 60 };
  const paramsJson = JSON.stringify(params);
  const sent = [];
  const res = TABU.run(inst, params, { onProgress: (q) => { if (q.best) sent.push({ plan: q.best, json: JSON.stringify(q.best) }); } });
  checkPlan(inst, res, 'mutation run');
  assert.ok(sent.length >= 3);
  assert.equal(JSON.stringify(inst, S.jsonReplacer || SRO.util.jsonReplacer), instJson, 'instance unchanged');
  assert.equal(JSON.stringify(params), paramsJson, 'params unchanged');
  for (const s of sent) assert.equal(JSON.stringify(s.plan), s.json, 'a plan sent earlier was not modified later');
  assert.equal(S.evaluate(inst, sent[sent.length - 1].plan).total, res.total, 'the last plan sent is the result');
});

test('review: contingency window (en-route preloaded trucks, locked loads, closed roads, pinned points)', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const inst = phase1(seed, { locked: 6, pinned: 2, banned: 1, closedZones: 2, maxRallyPoints: 5 });
    const far = inst.nodes.length - 1;
    inst.vehicles.forEach((v, k) => { if (k % 2 === 0) Object.assign(v, { preloaded: true, startNode: far - k, availableAt: inst.startMin + 25 }); });
    // every locked job rides on an en-route truck of the right type when one exists
    inst.jobs.forEach((j) => {
      if (!j.lockedTruck) return;
      const v = inst.vehicles.find((x) => x.preloaded && S.typeCompatible(x, j));
      if (v) j.lockedTruck = v.id;
    });
    S.prepare.invalidate(inst);
    // the old plan: construct() before the trucks left, i.e. on the instance without en-route state
    const old = phase1(seed, { locked: 6, pinned: 2, banned: 1, closedZones: 2, maxRallyPoints: 5 });
    const oldPlan = S.construct(old);
    const params = { seed, timeCapSec: 1800, iterations: 600 };
    const res = TABU.run(inst, params, { start: oldPlan });
    const ev = checkPlan(inst, res, 'contingency ' + seed);
    for (const r of res.solution.routes) for (const v of r.visits) for (const c of v.jobs) {
      const lock = inst.jobs[c.job].lockedTruck;
      if (lock) assert.equal(inst.vehicles[r.vehicle].id, lock, 'locked job on its truck');
    }
    const ls = S.evaluate(inst, S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed) }), COST).total;
    assert.ok(res.total <= ls * 1.02, `seed ${seed}: ${res.total.toFixed(0)} vs construct + localSearch ${ls.toFixed(0)}`);
    assert.ok(ev.stats.rallyPoints <= 5);
    const again = TABU.run(inst, params, { start: oldPlan });
    assert.deepEqual(plain(again.solution), plain(res.solution), 'deterministic with a start plan');
  }
});

test('review: MIP warm-start call shape (raw 2 s cap, shouldStop at the budget) returns in time with a valid plan', () => {
  const inst = phase1(8);
  const tp = S.clampParams('tabu', { seed: 20261005 });
  tp.timeCapSec = 2;
  const t0 = cpuNow();
  const res = TABU.run(inst, tp, { now: cpuNow, shouldStop: () => (cpuNow() - t0) / 1000 >= 2 });
  const el = (cpuNow() - t0) / 1000;
  checkPlan(inst, res, 'warm start');
  assert.ok(['time', 'stopped'].includes(res.stopReason), res.stopReason);
  assert.ok(el <= 2.2, 'elapsed ' + el.toFixed(3));
  assert.ok(res.total <= S.evaluate(inst, S.construct(inst), COST).total);
});

// The app's own demo window (the 19 sample requests on the real road matrix, built by the planner
// engine): 23 jobs, 8 trucks, 34 rally candidates, at most 8 rally points, and the limit binds. Before
// the rally-point shake, default params ended at 4,898 on two seeds and 7,520 (a job deferred) on two
// others; now every seed tried ends at 4,707 with nothing deferred.
test('review: demo window (19 sample requests, real roads): default params converge on every seed', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  const strip = (f) => f.replace(/\?$/, '');
  const exists = (f) => fs.existsSync(path.join(ROOT, f));
  const main = man.main.map(strip).filter(exists);
  if (!main.includes('src/core/planner-engine.js')) return;   // engine not in this build
  const core = main.slice(0, main.indexOf('src/core/planner-engine.js')).filter((f) => !f.startsWith('src/ui/'));
  const extra = man.worker.map(strip).filter(exists).filter((f) => !core.includes(f));
  const ctx = loadScripts(core.concat(extra, ['src/core/planner-engine.js']));
  const st = ctx.core.store.createStore({ adapter: null });
  st.dispatch({ type: 'samples/load' });
  const inst = ctx.core.engine.buildInstance(st.getState(), {}).instance;
  const Sv = ctx.solver;
  const ls = Sv.evaluate(inst, Sv.localSearch(inst, Sv.construct(inst), { rng: ctx.util.rng(1) }), COST).total;
  const totals = [];
  for (const seed of [20261005, 1, 2]) {
    const res = Sv.methods.tabu.run(inst, { seed, timeCapSec: 1800 }, {});
    const ev = Sv.evaluate(inst, res.solution);
    assert.equal(ev.violations.length, 0);
    assert.equal(res.total, ev.total);
    assert.equal(res.stopReason, 'budget');
    assert.ok(res.total <= ls, `seed ${seed}: ${res.total} vs construct + localSearch ${ls}`);
    totals.push(res.total);
  }
  assert.ok(Math.max(...totals) <= 1.05 * Math.min(...totals), 'totals per seed: ' + totals.map(Math.round).join(', '));
});
