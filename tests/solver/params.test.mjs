// params.js matches DESIGN.md section 7 "Method parameters" and clamps safely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;

// key -> [default, min, max, type] straight from the DESIGN.md table
const TABLE = {
  tabu: { seed: [20261005, 1, 999999999, 'int'], timeCapSec: [300, 5, 1800, 'int'], iterations: [4000, 100, 100000, 'int'], tenure: [12, 1, 200, 'int'],
    neighborhood: [200, 10, 5000, 'int'], restartAfter: [600, 0, 50000, 'int'], aspiration: [true, null, null, 'bool'] },
  sa: { seed: [20261005, 1, 999999999, 'int'], timeCapSec: [300, 5, 1800, 'int'], startTemp: [0, 0, 1e7, 'float'], autoAcceptRate: [0.5, 0.05, 0.95, 'float'],
    coolingRate: [0.995, 0.80, 0.99999, 'float'], itersPerTemp: [100, 1, 10000, 'int'], stopTempRatio: [0.001, 1e-6, 0.5, 'float'], reheats: [2, 0, 20, 'int'] },
  aco: { seed: [20261005, 1, 999999999, 'int'], timeCapSec: [300, 5, 1800, 'int'], ants: [20, 1, 500, 'int'], iterations: [150, 1, 10000, 'int'],
    alpha: [1.0, 0, 10, 'float'], beta: [3.0, 0, 10, 'float'], evaporation: [0.10, 0.01, 0.99, 'float'], q: [1.0, 0.01, 1000, 'float'], localSearch: [true, null, null, 'bool'] },
  mip: { seed: [20261005, 1, 999999999, 'int'], timeCapSec: [300, 5, 1800, 'int'], timeLimitSec: [300, 5, 1800, 'int'], mipGap: [0.01, 0, 0.5, 'float'], warmStart: [true, null, null, 'bool'] }
};

test('PARAMS table matches the design table (keys, defaults, ranges, types) with labels and help', () => {
  assert.deepEqual(plain(Object.keys(S.PARAMS).sort()), ['aco', 'mip', 'sa', 'tabu']);
  for (const [method, keys] of Object.entries(TABLE)) {
    const table = S.PARAMS[method];
    assert.deepEqual(plain(table.map((e) => e.key)), Object.keys(keys), method);
    for (const e of table) {
      const [def, min, max, type] = keys[e.key];
      assert.equal(e.type, type, method + '.' + e.key);
      assert.equal(e.default, def, method + '.' + e.key);
      if (min !== null) { assert.equal(e.min, min, method + '.' + e.key); assert.equal(e.max, max, method + '.' + e.key); }
      assert.ok(typeof e.label === 'string' && e.label.length > 3);
      assert.ok(typeof e.help === 'string' && e.help.length > 20, 'help for ' + method + '.' + e.key);
    }
  }
});

test('defaultParams: every knob, timeCapSec and mip.timeLimitSec follow settings.timeLimitSec', () => {
  assert.deepEqual(plain(S.defaultParams('tabu')), { seed: 20261005, timeCapSec: 300, iterations: 4000, tenure: 12, neighborhood: 200, restartAfter: 600, aspiration: true });
  const p = S.defaultParams('mip', { timeLimitSec: 120 });
  assert.equal(p.timeCapSec, 120); assert.equal(p.timeLimitSec, 120);
  assert.equal(S.defaultParams('sa', { timeLimitSec: 99999 }).timeCapSec, 1800, 'clamped to range');
  assert.deepEqual(plain(S.defaultParams('nope')), {});
});

test('clampParams: clamps, rounds ints, coerces bools, fills defaults, drops unknown keys', () => {
  const p = S.clampParams('sa', { coolingRate: 2, itersPerTemp: '55.4', reheats: -3, stopTempRatio: 'abc', extra: 1 });
  assert.equal(p.coolingRate, 0.99999);
  assert.equal(p.itersPerTemp, 55);
  assert.equal(p.reheats, 0);
  assert.equal(p.stopTempRatio, 0.001);
  assert.equal('extra' in p, false);
  assert.equal(p.seed, 20261005);
  const t = S.clampParams('tabu', { aspiration: 'false', tenure: 1e9 });
  assert.equal(t.aspiration, false); assert.equal(t.tenure, 200);
  assert.equal(S.clampParams('aco', { localSearch: 'maybe' }).localSearch, true);
  assert.equal(S.clampParams('mip', null, { timeLimitSec: 60 }).timeLimitSec, 60);
  // clamping is idempotent
  const once = S.clampParams('aco', { ants: 0, beta: 99 });
  assert.deepEqual(plain(S.clampParams('aco', once)), plain(once));
});
