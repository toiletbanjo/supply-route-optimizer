// Throughput of the solver core on a 20-stop, 8-vehicle, 30-job plan (target: > 20k evaluations/s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;

function rate(fn, ms = 300) {
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { for (let i = 0; i < 200; i++) fn(); n += 200; }
  return n / ((performance.now() - t0) / 1000);
}

test('evaluate throughput on a 20-stop, 8-vehicle, 30-job plan', (t) => {
  const inst = S.makeTestInstance(1, { nJobs: 30, nVehicles: 8, nRally: 8, capacity: { tanker: 7500, cargo: 30 }, deadlineMax: 900, directShare: 0.3 });
  let t0 = performance.now();
  const start = S.construct(inst);
  const constructMs = performance.now() - t0;
  t0 = performance.now();
  const sol = S.localSearch(inst, start, { rng: SRO.util.rng(1) });
  const lsMs = performance.now() - t0;
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true);
  assert.equal(inst.vehicles.length, 8);
  assert.equal(inst.jobs.length, 30);
  assert.ok(ev.stats.stops >= 15, 'stops ' + ev.stats.stops);

  const fast = rate(() => S.evaluate(inst, sol, { costOnly: true }));
  const full = rate(() => S.evaluate(inst, sol));
  const rng = SRO.util.rng(9);
  let cands = 0;
  const nb = rate(() => { cands += S.neighbors(inst, sol, rng, 1).length; }, 300);
  const msg = `perf: ${ev.stats.stops} stops, ${ev.stats.trucksUsed} trucks, ${inst.jobs.length} jobs: ` +
    `evaluate costOnly ${Math.round(fast).toLocaleString('en-US')}/s, full ${Math.round(full).toLocaleString('en-US')}/s, ` +
    `neighbors (generate + build + score) ${Math.round(nb).toLocaleString('en-US')}/s; construct ${constructMs.toFixed(1)} ms, localSearch ${lsMs.toFixed(0)} ms`;
  t.diagnostic(msg);
  assert.ok(fast > 20000, 'costOnly evaluations per second ' + fast);
  assert.ok(full > 5000, 'full evaluations per second ' + full);
  assert.ok(cands > 0);
});
