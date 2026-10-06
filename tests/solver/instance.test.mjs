// Instance helpers: validation, periods, candidate lookups, normalization, synthetic generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;

test('makeTestInstance is deterministic per seed and passes validation', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const opts = { nJobs: 1 + (seed % 30), nVehicles: 1 + (seed % 8), nRally: seed % 9, nHubs: 1 + (seed % 3), closedZones: seed % 2, locked: seed % 3, pinned: seed % 2, banned: seed % 2, maxRallyPoints: 8 };
    const a = S.makeTestInstance(seed, opts), b = S.makeTestInstance(seed, opts);
    assert.equal(JSON.stringify(a, SRO.util.jsonReplacer), JSON.stringify(b, SRO.util.jsonReplacer));
    assert.deepEqual(plain(S.validateInstance(a)), [], 'seed ' + seed);
    assert.equal(a.jobs.length, opts.nJobs);
    assert.equal(a.vehicles.length, opts.nVehicles);
    // both truck types present when there are 2+ trucks
    if (opts.nVehicles >= 2) assert.deepEqual(plain([...new Set(a.vehicles.map((v) => v.type))].sort()), ['cargo', 'tanker']);
  }
  const c = S.makeTestInstance(1, { nJobs: 10 }), d = S.makeTestInstance(2, { nJobs: 10 });
  assert.notEqual(JSON.stringify(c, SRO.util.jsonReplacer), JSON.stringify(d, SRO.util.jsonReplacer));
});

test('makeTestInstance: minutes from distance at 40 mph, symmetric matrices, noSplit respects capacity', () => {
  const inst = S.makeTestInstance(5, { nJobs: 20, noSplit: true, roadFactor: 1 });
  const pts = inst._test.points;
  const n = inst.nodes.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    assert.ok(Math.abs(inst.miles[i][j] - d) < 1e-9);
    assert.ok(Math.abs(inst.minutes[i][j] - d / 40 * 60) < 1e-9);
    assert.equal(inst.minutes[i][j], inst.minutes[j][i]);
  }
  for (const j of inst.jobs) assert.ok(j.qty <= (j.group === 'fuel' ? 2500 : 10));
  assert.ok(inst.jobs.some((j) => j.tier === 3 && j.hardDeadline));
});

test('validateInstance reports plain-language problems', () => {
  const inst = S.makeTestInstance(3, { nJobs: 4, nVehicles: 2 });
  inst.vehicles[0].type = 'boat';
  inst.jobs[0].qty = 0;
  inst.jobs[1].candidates.push({ node: 999, platoonCost: 1 });
  inst.jobs[2].lockedTruck = 'NOPE';
  inst.minutes[0][1] = -5;
  inst.params.pinnedRally = [0];
  const probs = S.validateInstance(inst);
  assert.ok(probs.some((p) => /type must be "tanker" or "cargo"/.test(p)));
  assert.ok(probs.some((p) => /quantity must be greater than 0/.test(p)));
  assert.ok(probs.some((p) => /not a node index/.test(p)));
  assert.ok(probs.some((p) => /locked to truck NOPE/.test(p)));
  assert.ok(probs.some((p) => /minutes\[0\]\[1\]/.test(p)));
  assert.ok(probs.some((p) => /Pinned rally point 0/.test(p)));
  assert.deepEqual(plain(S.validateInstance(null)), ['The instance is missing.']);
});

test('expandPeriods: contiguous Day/Dusk/Night/Dawn table over 72 h with overnight wrap', () => {
  const ps = S.expandPeriods(S.DEFAULT_PERIOD_TABLE, 360, 72);
  assert.equal(ps[0].startMin, 0);
  for (let i = 1; i < ps.length; i++) assert.equal(ps[i].startMin, ps[i - 1].endMin, 'contiguous at ' + i);
  assert.ok(ps[ps.length - 1].endMin >= 360 + 72 * 60);
  const at = (t) => ps.find((p) => p.startMin <= t && t < p.endMin);
  assert.equal(at(0).name, 'Night');            // 0000 is in Night (1930-0530)
  assert.equal(at(330).name, 'Dawn');           // 0530
  assert.equal(at(419).name, 'Dawn');
  assert.equal(at(420).name, 'Day');            // 0700
  assert.equal(at(1079).name, 'Day');
  assert.equal(at(1080).name, 'Dusk');          // 1800
  assert.equal(at(1170).name, 'Night');         // 1930
  assert.equal(at(1440 + 300).name, 'Night');   // Day 2 0500
  assert.equal(at(1080).speed, 0.9); assert.equal(at(1080).risk, 1.2);
  assert.equal(at(1440 * 2 + 600).speed, 1.0);
});

test('periodIndex: binary search equals a linear scan; wraps by days outside the table', () => {
  const inst = S.makeTestInstance(1, { nJobs: 2 });
  const P = S.prepare(inst);
  const ps = inst.periods;
  const rng = SRO.util.rng(4);
  for (let k = 0; k < 2000; k++) {
    const t = ps[0].startMin + rng() * (ps[ps.length - 1].endMin - ps[0].startMin);
    const lin = ps.findIndex((p) => p.startMin <= t && t < p.endMin);
    assert.equal(S.periodIndex(P, t), lin);
  }
  for (const t of [ps[ps.length - 1].endMin + 10, ps[ps.length - 1].endMin + 5000, -100]) {
    const i = S.periodIndex(P, t);
    const tt = ((t % 1440) + 1440) % 1440;
    const lin = ps.findIndex((p) => p.startMin <= tt && tt < p.endMin);
    assert.equal(ps[i].name, ps[lin].name, 't=' + t);
  }
  assert.equal(S.periodIndex(S.prepare(Object.assign({}, inst, { periods: [] })), 50), -1);
});

test('candidate lookups, compatibility and jobsByGroup', () => {
  const inst = S.makeTestInstance(8, { nJobs: 12, nVehicles: 4, banned: 1 });
  const groups = S.jobsByGroup(inst);
  assert.equal(groups.fuel.length + groups.cargo.length, 12);
  for (const j of groups.fuel) assert.equal(inst.jobs[j].group, 'fuel');
  const banned = inst.params.bannedRally[0];
  inst.jobs[0].candidates.push({ node: banned, platoonMiles: 1, platoonCost: 1 });
  S.prepare.invalidate(inst);
  assert.equal(S.isCandidate(inst, 0, banned), false, 'banned nodes are never candidates');
  for (let j = 0; j < inst.jobs.length; j++) {
    const nodes = S.candidateNodes(inst, j);
    for (const n of nodes) assert.ok(S.candidateAt(inst, j, n));
    assert.ok(!nodes.includes(banned));
  }
  const v = inst.vehicles;
  const fuelJob = { group: 'fuel', lockedTruck: null }, cargoJob = { group: 'cargo', lockedTruck: v[0].id };
  assert.equal(S.vehicleCompatible({ type: 'tanker', id: 'X' }, fuelJob), true);
  assert.equal(S.vehicleCompatible({ type: 'cargo', id: 'X' }, fuelJob), false);
  assert.equal(S.vehicleCompatible({ type: 'cargo', id: 'Y' }, cargoJob), false, 'lock respected');
  const common = S.commonCandidates(inst, [0, 1]);
  for (const n of common) assert.ok(S.isCandidate(inst, 0, n) && S.isCandidate(inst, 1, n));
});

test('normalize: one route per vehicle, repeated vehicles merged, bad entries dropped', () => {
  const inst = S.makeTestInstance(2, { nJobs: 4, nVehicles: 3 });
  const n0 = inst.jobs[0].candidates[0].node;
  const sol = { routes: [
    { vehicle: 2, visits: [{ node: n0, jobs: [{ job: 0, qty: 1 }, { job: 0, qty: 2 }, { job: 99, qty: 1 }] }] },
    { vehicle: 2, visits: [{ node: 999, jobs: [] }] },
    { vehicle: 9, visits: [{ node: n0, jobs: [{ job: 1, qty: 1 }] }] }
  ] };
  const out = S.normalize(inst, sol);
  assert.equal(out.routes.length, 3);
  assert.ok(S.isNormalized(inst, out));
  assert.deepEqual(plain(out.routes[2].visits), [{ node: n0, jobs: [{ job: 0, qty: 3 }] }]);
  assert.deepEqual(plain(out.routes[0].visits), []);
  assert.equal(S.isNormalized(inst, sol), false);
  const c = S.cloneSolution(out);
  assert.notEqual(c.routes[2].visits[0], out.routes[2].visits[0]);
  assert.deepEqual(plain(c), plain(out));
});

test('vehicleStartTime: max(startMin, availableAt) + loadMin, or no load time when preloaded', () => {
  const inst = S.makeTestInstance(4, { nVehicles: 2, nJobs: 2 });
  inst.vehicles[0].availableAt = inst.startMin + 100;
  inst.vehicles[1].availableAt = 0;
  inst.vehicles[1].preloaded = true;
  S.prepare.invalidate(inst);
  assert.equal(S.vehicleStartTime(inst, 0), inst.startMin + 100 + 20);
  assert.equal(S.vehicleStartTime(inst, 1), inst.startMin);
});
