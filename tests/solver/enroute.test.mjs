// En-route trucks (contract of 2026-10-06): a preloaded truck is already on the road and can deliver
// only what it carries, i.e. the jobs locked to it. vehicleCompatible / compatibleVehicles say so,
// evaluate() counts a pool job on such a truck as a 'not-on-board' violation, and construct,
// localSearch, tabu, SA, ACO and the MIP never put one there, even when the truck is roomy and close.
// Before the fix a search could load pool jobs on an en-route truck and drop its onboard loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts } from '../load.mjs';

const require = createRequire(import.meta.url);
const SRO = loadScripts([
  'src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js', 'src/solver/evaluate.js',
  'src/solver/construct.js', 'src/solver/localsearch.js', 'src/solver/tabu.js', 'src/solver/sa.js', 'src/solver/aco.js',
  'src/solver/mip.js', 'src/solver/estimate.js', 'src/solver/api.js'
]);
const S = SRO.solver;
S.mip.setLoader(() => require('highs')());
await S.mip.ready();

// 12 jobs, 4 trucks (2 tankers, 2 cargo). One tanker and one cargo truck are en route: preloaded, three
// times the room they need, starting at a rally point now, each with one locked (onboard) job.
function enroute(seed) {
  const inst = S.makeTestInstance(seed, { nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2, tankers: 2, capacity: { tanker: 12000, cargo: 40 }, deadlineMax: 600 });
  const rally = inst.nodes.map((n, i) => (n.kind === 'rally' ? i : -1)).filter((i) => i >= 0);
  const picks = ['tanker', 'cargo'].map((t) => inst.vehicles.findIndex((v) => v.type === t));
  picks.forEach((v, k) => {
    const veh = inst.vehicles[v];
    Object.assign(veh, { preloaded: true, startNode: rally[(seed + k) % rally.length], availableAt: inst.startMin });
    const j = inst.jobs.findIndex((x) => S.typeCompatible(veh, x) && x.lockedTruck == null);
    inst.jobs[j].lockedTruck = veh.id;
  });
  return { inst, picks };
}
// [job id, truck id] of every unlocked job a preloaded truck carries
function poolOnEnroute(inst, sol) {
  const bad = [];
  for (const r of sol.routes) {
    const veh = inst.vehicles[r.vehicle];
    if (!veh.preloaded) continue;
    for (const vs of r.visits) for (const c of vs.jobs) if (c.qty > 0 && inst.jobs[c.job].lockedTruck !== veh.id) bad.push([inst.jobs[c.job].id, veh.id]);
  }
  return bad;
}

test('vehicleCompatible / compatibleVehicles: a pool job never fits an en-route truck, its onboard job does', () => {
  const { inst, picks } = enroute(1);
  for (const v of picks) {
    const veh = inst.vehicles[v];
    inst.jobs.forEach((job, j) => {
      const fits = S.vehicleCompatible(veh, job);
      assert.equal(fits, job.lockedTruck === veh.id, job.id + ' on ' + veh.id);
      assert.equal(S.compatibleVehicles(inst, j).includes(v), fits);
    });
  }
  // a truck that is not on the road still takes any pool job of its type
  const free = inst.vehicles.findIndex((v) => !v.preloaded);
  const pool = inst.jobs.find((x) => x.lockedTruck == null && S.typeCompatible(inst.vehicles[free], x));
  assert.equal(S.vehicleCompatible(inst.vehicles[free], pool), true);
});

test('evaluate: a pool job on an en-route truck is a not-on-board violation', () => {
  const { inst, picks } = enroute(2);
  const v = picks[0], veh = inst.vehicles[v];
  const pool = inst.jobs.findIndex((x) => x.lockedTruck == null && S.typeCompatible(veh, x));
  const own = inst.jobs.findIndex((x) => x.lockedTruck === veh.id);
  const visit = (j) => ({ node: inst.jobs[j].candidates[0].node, jobs: [{ job: j, qty: inst.jobs[j].qty }] });
  const ok = S.evaluate(inst, { routes: [{ vehicle: v, visits: [visit(own)] }] });
  assert.equal(ok.violations.length, 0);
  const ev = S.evaluate(inst, { routes: [{ vehicle: v, visits: [visit(own), visit(pool)] }] });
  assert.deepEqual(Array.from(ev.violations, (x) => x.code), ['not-on-board']);
  assert.equal(ev.violations[0].job, pool);
  assert.match(ev.violations[0].detail, /already on the road/);
  assert.equal(ev.feasible, false);
  assert.equal(S.evaluate(inst, { routes: [{ vehicle: v, visits: [visit(own), visit(pool)] }] }, { costOnly: true }).nViolations, 1);
});

test('construct, localSearch, tabu, SA, ACO and MIP keep pool jobs off en-route trucks', () => {
  for (let seed = 1; seed <= 3; seed++) {
    const { inst } = enroute(seed);
    const rng = SRO.util.rng(seed);
    const c = S.construct(inst, { rng });
    assert.deepEqual(poolOnEnroute(inst, c), [], 'construct seed ' + seed);
    const ls = S.localSearch(inst, c, { rng, timeLimitMs: 2000 });
    assert.deepEqual(poolOnEnroute(inst, ls), [], 'localSearch seed ' + seed);
    const runs = {
      tabu: S.solve(inst, { method: 'tabu', params: { iterations: 150, timeCapSec: 3, seed } }),
      sa: S.solve(inst, { method: 'sa', params: { coolingRate: 0.9, itersPerTemp: 20, reheats: 0, timeCapSec: 3, seed } }),
      aco: S.solve(inst, { method: 'aco', params: { ants: 4, iterations: 4, timeCapSec: 3, seed } }),
      mip: S.methods.mip.run(inst, S.clampParams('mip', { timeLimitSec: 8, mipGap: 0.02, seed }), {})
    };
    for (const [m, res] of Object.entries(runs)) {
      assert.deepEqual(poolOnEnroute(inst, res.solution), [], m + ' seed ' + seed);
      assert.equal(S.evaluate(inst, res.solution).violations.length, 0, m + ' seed ' + seed + ' violation-free');
    }
  }
});
