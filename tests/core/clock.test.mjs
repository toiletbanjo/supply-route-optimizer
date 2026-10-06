import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const SRO = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/clock.js']);
const c = SRO.core.clock;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('parseHHMM', () => {
  assert.equal(c.parseHHMM('1930'), 1170);
  assert.equal(c.parseHHMM('07:00'), 420);
  assert.equal(c.parseHHMM('0000'), 0);
  assert.equal(c.parseHHMM('2400'), 1440);
  assert.equal(c.parseHHMM(700), 420);            // number written as HHMM
  assert.equal(c.parseHHMM('730'), 450);
  assert.ok(Number.isNaN(c.parseHHMM('abc')));
  assert.ok(Number.isNaN(c.parseHHMM('2460')));
  assert.ok(Number.isNaN(c.parseHHMM('2401')));
});

test('windowOf: 6-hour windows at 0000/0600/1200/1800', () => {
  assert.deepEqual(plain(c.windowOf(360)), { id: 'W-D1-0600', start: 360, end: 720 });
  assert.deepEqual(plain(c.windowOf(359)), { id: 'W-D1-0000', start: 0, end: 360 });
  assert.deepEqual(plain(c.windowOf(719.9)), { id: 'W-D1-0600', start: 360, end: 720 });
  assert.deepEqual(plain(c.windowOf(800)), { id: 'W-D1-1200', start: 720, end: 1080 });
  assert.deepEqual(plain(c.windowOf(1440 + 1100)), { id: 'W-D2-1800', start: 2520, end: 2880 });
  assert.deepEqual(plain(c.windowOf(1440)), { id: 'W-D2-0000', start: 1440, end: 1800 });
  assert.deepEqual(plain(c.parseWindowId('W-D2-1800')), { id: 'W-D2-1800', start: 2520, end: 2880 });
  assert.equal(c.parseWindowId('W-001'), null);
});

test('nextBoundary and boundariesBetween', () => {
  assert.equal(c.nextBoundary(0), 360);
  assert.equal(c.nextBoundary(360), 720);         // strictly after
  assert.equal(c.nextBoundary(361), 720);
  assert.equal(c.nextBoundary(1439), 1440);
  assert.equal(c.nextBoundary(1080.5), 1440);
  assert.deepEqual(Array.from(c.boundariesBetween(350, 730)), [360, 720]);
  assert.deepEqual(Array.from(c.boundariesBetween(359, 360)), [360]);
  assert.deepEqual(Array.from(c.boundariesBetween(360, 360)), []);
  assert.deepEqual(Array.from(c.boundariesBetween(360, 361)), []);
  assert.deepEqual(Array.from(c.boundariesBetween(400, 300)), []);
});

test('periodAt with the default table (wraps midnight)', () => {
  const name = (hhmm, day = 1) => c.periodAt((day - 1) * 1440 + c.parseHHMM(hhmm), c.DEFAULT_PERIODS).name;
  assert.equal(name('0800'), 'Day');
  assert.equal(name('0700'), 'Day');
  assert.equal(name('1759'), 'Day');
  assert.equal(name('1800'), 'Dusk');
  assert.equal(name('1929'), 'Dusk');
  assert.equal(name('1930'), 'Night');
  assert.equal(name('0000'), 'Night');
  assert.equal(name('0000', 3), 'Night');
  assert.equal(name('0529', 2), 'Night');
  assert.equal(name('0530'), 'Dawn');
  assert.equal(name('0659'), 'Dawn');
  const p = c.periodAt(1200, c.DEFAULT_PERIODS);
  assert.equal(p.speed, 0.7);
  assert.equal(p.risk, 0.8);
  assert.equal(c.periodIndexAt(1200, c.DEFAULT_PERIODS), 2);
  // default argument
  assert.equal(c.periodAt(600).name, 'Day');
});

test('periodAt: gaps fall back to x1 / x1; start == end covers the day', () => {
  const gappy = [{ name: 'Day', start: '0800', end: '1700', speed: 1, risk: 1 }];
  const p = c.periodAt(c.parseHHMM('2000'), gappy);
  assert.equal(p.speed, 1);
  assert.equal(p.risk, 1);
  assert.equal(c.periodIndexAt(c.parseHHMM('2000'), gappy), -1);
  const allDay = [{ name: 'All', start: '0000', end: '2400', speed: 0.8, risk: 2 }];
  assert.equal(c.periodAt(1234, allDay).name, 'All');
  const same = [{ name: 'All', start: '0600', end: '0600', speed: 0.8, risk: 2 }];
  assert.equal(c.periodAt(100, same).name, 'All');
});

test('expandPeriods: 72 h from Day 1 0600', () => {
  const out = plain(c.expandPeriods(c.DEFAULT_PERIODS, 360, 72));
  assert.equal(out.length, 13);
  assert.deepEqual(out[0], { startMin: 360, endMin: 420, speed: 0.9, risk: 1.2, name: 'Dawn', index: 3 });
  assert.deepEqual(out[1], { startMin: 420, endMin: 1080, speed: 1, risk: 1, name: 'Day', index: 0 });
  assert.deepEqual(out[2], { startMin: 1080, endMin: 1170, speed: 0.9, risk: 1.2, name: 'Dusk', index: 1 });
  // Night runs 1930 Day 1 to 0530 Day 2 as one interval
  assert.deepEqual(out[3], { startMin: 1170, endMin: 1440 + 330, speed: 0.7, risk: 0.8, name: 'Night', index: 2 });
  assert.equal(out[12].endMin, 360 + 72 * 60);
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].startMin, out[i - 1].endMin, 'contiguous');
    assert.notEqual(out[i].index, out[i - 1].index, 'merged');
  }
  // every interval agrees with periodAt at its start and just before its end
  for (const iv of out) {
    assert.equal(c.periodAt(iv.startMin, c.DEFAULT_PERIODS).name, iv.name);
    assert.equal(c.periodAt(iv.endMin - 1, c.DEFAULT_PERIODS).name, iv.name);
  }
});

test('expandPeriods: odd starts, gaps and empty spans', () => {
  assert.deepEqual(plain(c.expandPeriods(c.DEFAULT_PERIODS, 500, 0)), []);
  const short = plain(c.expandPeriods(c.DEFAULT_PERIODS, 1000, 2));    // 1640-1840
  assert.deepEqual(short.map((p) => [p.startMin, p.endMin, p.name]), [[1000, 1080, 'Day'], [1080, 1120, 'Dusk']]);
  const gappy = [{ name: 'Day', start: '0800', end: '1700', speed: 1, risk: 1 }];
  const g = plain(c.expandPeriods(gappy, 0, 24));
  assert.deepEqual(g.map((p) => [p.startMin, p.endMin, p.index]), [[0, 480, -1], [480, 1020, 0], [1020, 1440, -1]]);
  assert.equal(g[0].speed, 1);
  // HH:MM strings and reordered tables work
  const t = [{ name: 'B', start: '12:00', end: '00:00', speed: 0.5, risk: 2 }, { name: 'A', start: '00:00', end: '12:00', speed: 1, risk: 1 }];
  assert.deepEqual(plain(c.expandPeriods(t, 0, 24)).map((p) => p.name), ['A', 'B']);
});

test('advance: pure ticker at 1x / 60x / 600x', () => {
  assert.equal(c.advance({ simMin: 360, running: true, speed: 60 }, 1000), 361);
  assert.equal(c.advance({ simMin: 360, running: true, speed: 600 }, 6000), 420);
  assert.equal(c.advance({ simMin: 360, running: true, speed: 1 }, 60000), 361);
  assert.equal(c.advance({ simMin: 360, running: true, speed: 1 }, 30000), 360.5);
  assert.equal(c.advance({ simMin: 360, running: false, speed: 600 }, 6000), 360);
  assert.equal(c.advance({ simMin: 360, running: true, speed: 60 }, -5), 360);
  const st = { simMin: 360, running: true, speed: 60 };
  c.advance(st, 1000);
  assert.equal(st.simMin, 360, 'input not mutated');
});

test('createTicker dispatches clock/tick with injected timers', () => {
  let t = 1000;
  let fn = null;
  const actions = [];
  let state = { clock: { simMin: 360, running: true, speed: 600 } };
  const ticker = c.createTicker({
    getState: () => state,
    dispatch: (a) => { actions.push(a); state = { clock: { ...state.clock, simMin: a.simMin } }; },
    now: () => t,
    setInterval: (f) => { fn = f; return 1; },
    clearInterval: () => { fn = null; },
    intervalMs: 250
  });
  ticker.start();
  assert.equal(ticker.isRunning(), true);
  t += 250; fn();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'clock/tick');
  assert.equal(actions[0].simMin, 362.5);           // 250 ms at 600x = 2.5 sim min
  state.clock.running = false;
  t += 1000; fn();
  assert.equal(actions.length, 1, 'paused clock does not tick');
  state.clock.running = true;
  t += 100; fn();
  assert.equal(actions[1].simMin, 362.5 + 1, 'no jump after a pause');
  ticker.stop();
  assert.equal(ticker.isRunning(), false);
  assert.equal(fn, null);
});
