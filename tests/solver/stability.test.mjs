// ETA stability for re-plans (contract of 2026-10-06): a job may carry prevEta (the minute the approved
// plan gave its platoon) and slipPerMin; each minute a chunk arrives after prevEta costs slipPerMin x
// its share, on top of the lateness and within the same lateness cap (evaluate cost.stability). ACO
// weighs it exactly as evaluate charges it and the MIP model is still exact on flat periods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts } from '../load.mjs';

const require = createRequire(import.meta.url);
const SRO = loadScripts([
  'src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js', 'src/solver/evaluate.js',
  'src/solver/construct.js', 'src/solver/localsearch.js', 'src/solver/tabu.js', 'src/solver/aco.js', 'src/solver/mip.js'
]);
const S = SRO.solver;
S.mip.setLoader(() => require('highs')());
await S.mip.ready();
const COST = { costOnly: true };
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

// prevEta on about two thirds of the jobs, from before the start to a few hours after it
function withEtas(inst, seed, slip = 2) {
  const rng = SRO.util.rng(seed * 97 + 5);
  inst.jobs.forEach((j) => { if (rng() < 0.67) { j.prevEta = inst.startMin - 60 + rng() * 300; j.slipPerMin = slip * (0.5 + rng()); } });
  S.prepare.invalidate(inst);
  return inst;
}

test('evaluate: minutes after prevEta cost slipPerMin x share, on top of lateness and within the lateness cap', () => {
  // one cargo truck, one job of 2 pallets at node 1, 30 min from the hub; t0 = 400 + 20 load = 420, arrive 450
  const inst = {
    startMin: 400, nodes: [{ key: 'hub', kind: 'hub' }, { key: 'd', kind: 'direct' }],
    minutes: [[0, 30], [30, 0]], miles: [[0, 10], [10, 0]], riskUnits: [[0, 0], [0, 0]], periods: [],
    vehicles: [{ id: 'V0', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 400 }],
    jobs: [{ id: 'J0', requestId: 'R1', group: 'cargo', qty: 2, unit: 'pallet', tier: 0, classRank: 0, deadline: 440,
      candidates: [{ node: 1, platoonMiles: 0, platoonCost: 0 }], lockedTruck: null, prevEta: 420, slipPerMin: 3 }],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 8, pinnedRally: [], bannedRally: [] }
  };
  assert.deepEqual(Array.from(S.validateInstance(inst)), []);
  const half = { routes: [{ vehicle: 0, visits: [{ node: 1, jobs: [{ job: 0, qty: 1 }] }] }] };
  let ev = S.evaluate(inst, half);
  // lateness 10 min x 2 (Routine) x 1/2 = 10; slip 30 min x 3 x 1/2 = 45
  assert.ok(Math.abs(ev.cost.lateness - 10) < 1e-9 && Math.abs(ev.cost.stability - 45) < 1e-9, JSON.stringify(ev.cost));
  assert.ok(Math.abs(ev.routes[0].cost.stability - 45) < 1e-9);
  assert.ok(Math.abs(ev.routes[0].cost.total - (ev.routes[0].cost.fuel + ev.routes[0].cost.distance + ev.routes[0].cost.risk + ev.routes[0].cost.simplicity + ev.routes[0].cost.platoon + 10 + 45)) < 1e-9);
  assert.equal(S.evaluate(inst, half, COST).total, ev.total);
  // the cap: lateness + slip never above lateCapShare x deferral (0.9 x 5000 = 4500 for the whole job)
  inst.jobs[0].slipPerMin = 1000;
  S.prepare.invalidate(inst);
  ev = S.evaluate(inst, half);
  assert.ok(Math.abs(ev.cost.lateness + ev.cost.stability - 4500 / 2) < 1e-9, JSON.stringify(ev.cost));
  assert.ok(Math.abs(ev.cost.lateness - 10) < 1e-9, 'lateness itself is unchanged');
  // no prevEta, slipPerMin 0 or an arrival before prevEta: no stability cost
  for (const patch of [{ prevEta: undefined }, { slipPerMin: 0 }, { prevEta: 460 }]) {
    Object.assign(inst.jobs[0], { prevEta: 420, slipPerMin: 3 }, patch);
    S.prepare.invalidate(inst);
    assert.equal(S.evaluate(inst, half).cost.stability, 0, JSON.stringify(patch));
  }
  // validation
  Object.assign(inst.jobs[0], { prevEta: 'soon', slipPerMin: -1 });
  const bad = Array.from(S.validateInstance(inst));
  assert.ok(bad.some((p) => /prevEta must be a minute number/.test(p)) && bad.some((p) => /slipPerMin must be 0 or more/.test(p)), bad.join(' | '));
});

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

test('ACO: each option an ant weighs costs exactly what evaluate() charges for it, ETA slip included', () => {
  let checked = 0, slipped = 0, maxErr = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const inst = withEtas(S.makeTestInstance(seed, { nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2, capacity: { tanker: 3000, cargo: 12 } }), seed, seed % 2 ? 2 : 400);
    inst.periods = [];
    S.prepare.invalidate(inst);
    const P = S.prepare(inst);
    const D = S.methods.aco._makeBuilder(inst, P, { beta: 3, c0: 50 }).debug;
    const ones = { arcPow: new Float64Array(P.nN * P.nN).fill(1), jnPow: new Float64Array(P.nJ * P.nN).fill(1) };
    const rng = SRO.util.rng(seed);
    D.reset();
    let cur = S.emptySolution(inst);
    for (let j = 0; j < P.nJ; j++) {
      const n = D.options(j, ones.jnPow, ones.arcPow);
      const before = S.evaluate(inst, cur, COST).total;
      for (let i = 0; i < n; i++) {
        const o = D.option(i);
        const next = applyOption(cur, o, j);
        const delta = S.evaluate(inst, next, COST).total - before + P.jDeferW[j] * o.qty * P.jInvQty[j];
        maxErr = Math.max(maxErr, Math.abs(delta - o.cost) / Math.max(1, Math.abs(delta)));
        if (S.evaluate(inst, next).cost.stability > 0) slipped++;
        checked++;
      }
      if (n) { const i = Math.floor(rng() * n); cur = applyOption(cur, D.option(i), j); D.place(j, i); }
    }
  }
  assert.ok(checked > 200 && slipped > 50, `options ${checked}, with a slip cost ${slipped}`);
  assert.ok(maxErr < 1e-9, 'relative error ' + maxErr);
});

test('MIP: on flat periods the model objective of a mapped plan equals its evaluate total with ETA slip; a solve keeps that', () => {
  let checked = 0, withSlip = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const inst = withEtas(S.makeTestInstance(seed, { nJobs: 3 + seed % 8, nVehicles: 2 + seed % 3, nRally: 3, nHubs: 1 + seed % 2, flatPeriods: true, maxRallyPoints: 2 + seed % 2 }), seed, seed % 3 ? 2 : 300);
    const rng = SRO.util.rng(seed);
    const start = S.localSearch(inst, S.construct(inst, { rng }), { rng, timeLimitMs: 300 });
    const model = S.mip.buildModel(inst, { start });
    assert.equal(model.exact, true);
    assert.deepEqual(Array.from(S.mip.checkValues(model, model.startValues)), [], 'seed ' + seed + ' start satisfies the model');
    const dec = S.mip.decode(model, model.startValues);
    const ed = S.evaluate(inst, dec);
    assert.ok(rel(S.mip.objective(model, model.startValues), ed.total) < 1e-9, `seed ${seed}: model ${S.mip.objective(model, model.startValues)} vs evaluate ${ed.total}`);
    if (ed.cost.stability > 0) withSlip++;
    if (seed <= 4) {
      const res = S.methods.mip.run(inst, S.clampParams('mip', { timeLimitSec: 10, mipGap: 0, seed }), {});
      assert.ok(rel(res.extra.planModelObjective, S.evaluate(inst, res.solution).total) < 1e-6, `seed ${seed}: solved plan model objective = evaluate total`);
    }
    checked++;
  }
  assert.ok(withSlip >= 4, 'plans with a slip cost: ' + withSlip);
  assert.equal(checked, 12);
});
