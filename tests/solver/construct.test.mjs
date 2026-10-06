// construct(): always violation-free, normalized, sensible on simple cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;

function variedInstance(seed) {
  const r = SRO.util.rng(seed * 31 + 7);
  return S.makeTestInstance(seed, {
    nJobs: 1 + r.int(35), nVehicles: 1 + r.int(9), nRally: r.int(10), nHubs: 1 + r.int(3),
    maxRallyPoints: r.int(9), closedZones: r.int(3), locked: r.int(3), pinned: r.int(3), banned: r.int(2),
    noCandidateShare: r() < 0.2 ? 0.1 : 0, lateAvailableShare: 0.3, fuelShare: r(),
    capacity: r() < 0.3 ? { tanker: 6000, cargo: 25 } : { tanker: 2500, cargo: 10 },
    deadlineMax: 200 + r.int(900)
  });
}

test('construct is violation-free and normalized on 200 random instances', (t) => {
  let delivered = 0, total = 0, deferredJobs = 0, ms = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const inst = variedInstance(seed);
    const t0 = performance.now();
    const sol = S.construct(inst, seed % 2 ? { rng: SRO.util.rng(seed) } : {});
    ms += performance.now() - t0;
    const ev = S.evaluate(inst, sol);
    assert.deepEqual(plain(ev.violations), [], 'seed ' + seed);
    assert.equal(ev.feasible, true);
    assert.ok(S.isNormalized(inst, sol), 'seed ' + seed);
    for (const r of sol.routes) for (const v of r.visits) {
      assert.ok(v.jobs.length > 0, 'no empty visits');
      for (const c of v.jobs) assert.ok(c.qty > 0, 'positive chunks');
    }
    inst.jobs.forEach((j, k) => { delivered += ev.delivered[k]; total += j.qty; });
    deferredJobs += ev.deferred.length;
  }
  t.diagnostic(`construct: 200 instances, share of quantity delivered ${(delivered / total * 100).toFixed(1)}%, ${deferredJobs} (partly) deferred jobs, avg ${(ms / 200).toFixed(1)} ms`);
});

test('construct is deterministic without rng and with the same rng seed', () => {
  const inst = variedInstance(17);
  assert.deepEqual(plain(S.construct(inst)), plain(S.construct(inst)));
  assert.deepEqual(plain(S.construct(inst, { rng: SRO.util.rng(5) })), plain(S.construct(inst, { rng: SRO.util.rng(5) })));
});

test('construct batches jobs that share a pickup point and splits a job larger than one truck', () => {
  // two hubs-worth of fuel for one platoon: 4000 gal with two 2500-gal tankers -> two chunks
  const inst = S.makeTestInstance(3, { nJobs: 1, nVehicles: 3, tankers: 2, nRally: 0, fuelShare: 1, deadlineMax: 2000, deadlineMin: 1500, lateAvailableShare: 0 });
  inst.jobs[0].qty = 4000; inst.jobs[0].tier = 3; inst.jobs[0].hardDeadline = true;
  S.prepare.invalidate(inst);
  const sol = S.construct(inst);
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true);
  assert.equal(ev.delivered[0], 4000);
  assert.equal(ev.routes.length, 2, 'both tankers used');
  // batching: three cargo jobs of one request family at a single shared rally point -> one stop
  const b = S.makeTestInstance(9, { nJobs: 3, nVehicles: 2, tankers: 0, nHubs: 1, nRally: 1, fuelShare: 0, twoJobShare: 0, deadlineMax: 2000, deadlineMin: 1500, lateAvailableShare: 0 });
  assert.equal(b.nodes[1].kind, 'rally');
  b.jobs.forEach((j) => { j.qty = 2; j.tier = 2; j.candidates = [{ node: 1, platoonMiles: 1, platoonCost: 0.5 }]; });
  S.prepare.invalidate(b);
  const ev2 = S.evaluate(b, S.construct(b));
  assert.equal(ev2.feasible, true);
  assert.equal(ev2.stats.stops, 1);
  assert.equal(ev2.deferred.length, 0);
});

test('construct respects maxRallyPoints, banned nodes and locks', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 20, nVehicles: 5, nRally: 8, directShare: 0.1, maxRallyPoints: seed % 3, banned: 2, locked: 3 });
    const sol = S.construct(inst);
    const ev = S.evaluate(inst, sol);
    assert.ok(ev.rallyNodes.length <= inst.params.maxRallyPoints);
    for (const n of ev.rallyNodes) assert.ok(!inst.params.bannedRally.includes(n));
    for (const r of sol.routes) for (const v of r.visits) for (const c of v.jobs) {
      const lk = inst.jobs[c.job].lockedTruck;
      if (lk != null) assert.equal(inst.vehicles[r.vehicle].id, lk);
    }
  }
});

test('construct opens pinned rally points first when the limit binds', () => {
  let pinnedUsed = 0, cases = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 15, nVehicles: 4, nRally: 8, directShare: 0, maxRallyPoints: 2, pinned: 1 });
    const pin = inst.params.pinnedRally[0];
    if (!inst.jobs.some((j) => j.candidates.some((c) => c.node === pin))) continue;
    cases++;
    const ev = S.evaluate(inst, S.construct(inst));
    if (ev.rallyNodes.includes(pin) || ev.rallyNodes.length < 2) pinnedUsed++;
  }
  assert.ok(cases > 5);
  assert.ok(pinnedUsed / cases >= 0.8, `pinned rally point kept a slot in ${pinnedUsed}/${cases}`);
});

test('refill never makes a plan worse and keeps it violation-free', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const inst = variedInstance(seed + 500);
    const base = S.construct(inst, { repair: false });
    const e0 = S.evaluate(inst, base, { costOnly: true });
    const r = S.refill(inst, base, { rng: SRO.util.rng(seed) });
    const e1 = S.evaluate(inst, r.solution, { costOnly: true });
    assert.ok(e1.total <= e0.total + 1e-9);
    assert.equal(e1.feasible, true);
    assert.equal(r.total, e1.total);
  }
});
