// Simulated demo clock: planning windows, time-of-day periods and a pure ticker.
// simMin = minutes since Day 1 00:00 local (DESIGN.md section 2). Pure functions, no DOM;
// createTicker is the only part that touches timers, and they are injectable.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const clock = SRO.core.clock = SRO.core.clock || {};

  clock.DAY_MIN = 1440;
  clock.WINDOW_MIN = 360;               // boundaries at 0000, 0600, 1200, 1800
  clock.START_MIN = 360;                // demo starts Day 1 0600
  clock.SPEEDS = [1, 60, 600];          // sim minutes per real minute
  clock.DEFAULT_PERIOD = { name: 'Unset', start: '0000', end: '0000', speed: 1, risk: 1 };
  clock.DEFAULT_PERIODS = [
    { name: 'Day', start: '0700', end: '1800', speed: 1.0, risk: 1.0 },
    { name: 'Dusk', start: '1800', end: '1930', speed: 0.9, risk: 1.2 },
    { name: 'Night', start: '1930', end: '0530', speed: 0.7, risk: 0.8 },
    { name: 'Dawn', start: '0530', end: '0700', speed: 0.9, risk: 1.2 }
  ];

  function pad(n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function whole(m) { return Math.floor(m + 1e-9); }

  clock.dayOf = function (simMin) { return Math.floor(whole(simMin) / 1440) + 1; };
  clock.minuteOfDay = function (simMin) { return mod(whole(simMin), 1440); };
  clock.hhmm = function (simMin) { const m = clock.minuteOfDay(simMin); return pad(Math.floor(m / 60), 2) + pad(m % 60, 2); };

  // 'HHMM', 'HH:MM' or a number written as HHMM (700 -> 0700) -> minutes after midnight (0..1440).
  clock.parseHHMM = function (v) {
    if (typeof v === 'number') v = pad(Math.round(v), 4);
    const raw = String(v == null ? '' : v).trim();
    // 'H:MM' / 'HH:MM' only: '12:3' used to lose the colon and parse as 0123
    if (raw.indexOf(':') >= 0 && !/^\d{1,2}:\d{2}$/.test(raw)) return NaN;
    const s = raw.replace(':', '');
    if (!/^\d{3,4}$/.test(s)) return NaN;
    const n = s.length === 3 ? '0' + s : s;
    const h = parseInt(n.slice(0, 2), 10), m = parseInt(n.slice(2), 10);
    if (h > 24 || m > 59 || (h === 24 && m > 0)) return NaN;
    return h * 60 + m;
  };

  // ---- planning windows -----------------------------------------------------------------
  // windowOf(800) (Day 1 1320) -> { id: 'W-D1-1200', start: 720, end: 1080 }
  clock.windowOf = function (simMin) {
    const start = Math.floor(whole(simMin) / clock.WINDOW_MIN) * clock.WINDOW_MIN;
    return { id: clock.windowId(start), start: start, end: start + clock.WINDOW_MIN };
  };
  clock.windowId = function (start) { return 'W-D' + clock.dayOf(start) + '-' + clock.hhmm(start); };

  // 'W-D2-1800' -> { id, start, end } (null when the id has another shape).
  clock.parseWindowId = function (id) {
    const m = /^W-D(-?\d+)-(\d{4})$/.exec(String(id || ''));
    if (!m) return null;
    const start = (parseInt(m[1], 10) - 1) * 1440 + clock.parseHHMM(m[2]);
    if (!isFinite(start)) return null;
    return { id: id, start: start, end: start + clock.WINDOW_MIN };
  };

  // First window boundary strictly after simMin.
  clock.nextBoundary = function (simMin) {
    return (Math.floor(whole(simMin) / clock.WINDOW_MIN) + 1) * clock.WINDOW_MIN;
  };

  // Boundaries b with fromMin < b <= toMin, ascending (what a tick from fromMin to toMin crossed).
  // Both ends use the same 1e-9 tolerance as windowOf / nextBoundary, so a float clock value a
  // hair below a boundary (e.g. 359.99999999999994, which windowOf already puts in the 0600
  // window) reports the boundary on the tick that reaches it instead of never reporting it.
  clock.boundariesBetween = function (fromMin, toMin) {
    const out = [];
    if (!(toMin > fromMin)) return out;
    const last = whole(toMin);
    for (let b = clock.nextBoundary(fromMin); b <= last; b += clock.WINDOW_MIN) out.push(b);
    return out;
  };

  // ---- time-of-day periods ----------------------------------------------------------------
  function periodRange(p) {
    const s = clock.parseHHMM(p.start), e = clock.parseHHMM(p.end);
    return { s: s, e: e };
  }
  function contains(range, m) {
    if (!isFinite(range.s) || !isFinite(range.e)) return false;
    const s = range.s % 1440, e = range.e === 1440 ? 1440 : range.e % 1440;
    if (s === e % 1440) return true;          // start == end: whole day
    if (s < e) return m >= s && m < e;
    return m >= s || m < e;                   // wraps midnight
  }

  // Index of the period containing simMin (first match in table order), or -1.
  clock.periodIndexAt = function (simMin, periods) {
    const m = clock.minuteOfDay(simMin);
    const list = periods || clock.DEFAULT_PERIODS;
    for (let i = 0; i < list.length; i++) if (contains(periodRange(list[i]), m)) return i;
    return -1;
  };

  // Period object containing simMin. Gaps in the table fall back to DEFAULT_PERIOD (x1 / x1).
  clock.periodAt = function (simMin, periods) {
    const list = periods || clock.DEFAULT_PERIODS;
    const i = clock.periodIndexAt(simMin, list);
    return i < 0 ? clock.DEFAULT_PERIOD : list[i];
  };

  // Expand the day-repeating table into absolute intervals covering [fromMin, fromMin + hours*60).
  // -> [{ startMin, endMin, speed, risk, name, index }] contiguous and ascending; index is the
  // row in `periods` (-1 for a gap filled with DEFAULT_PERIOD). Adjacent pieces of the same row
  // (e.g. Night across midnight) are merged.
  clock.expandPeriods = function (periods, fromMin, hours) {
    const list = periods || clock.DEFAULT_PERIODS;
    const from = isFinite(fromMin) ? fromMin : 0;
    const to = from + (hours === undefined ? 72 : hours) * 60;
    if (!(to > from)) return [];
    // breakpoints inside one day
    const bps = [0];
    list.forEach(function (p) {
      const r = periodRange(p);
      if (isFinite(r.s)) bps.push(r.s % 1440);
      if (isFinite(r.e)) bps.push(r.e % 1440);
    });
    const uniq = Array.from(new Set(bps)).sort(function (a, b) { return a - b; });
    const dayPieces = uniq.map(function (s, k) {
      const e = k + 1 < uniq.length ? uniq[k + 1] : 1440;
      return { s: s, e: e, idx: clock.periodIndexAt(s, list) };
    }).filter(function (p) { return p.e > p.s; });

    const out = [];
    const firstDay = Math.floor(from / 1440);
    const lastDay = Math.floor((to - 1e-9) / 1440);
    for (let d = firstDay; d <= lastDay; d++) {
      for (let k = 0; k < dayPieces.length; k++) {
        const pc = dayPieces[k];
        const s = Math.max(from, d * 1440 + pc.s), e = Math.min(to, d * 1440 + pc.e);
        if (e <= s) continue;
        const last = out[out.length - 1];
        if (last && last.index === pc.idx && last.endMin === s) { last.endMin = e; continue; }
        const p = pc.idx < 0 ? clock.DEFAULT_PERIOD : list[pc.idx];
        out.push({ startMin: s, endMin: e, speed: +p.speed || 1, risk: isFinite(+p.risk) ? +p.risk : 1, name: p.name, index: pc.idx });
      }
    }
    return out;
  };

  // ---- ticker ----------------------------------------------------------------------------
  // Pure: new simMin after realMsElapsed of wall time at clockState.speed (sim minutes per real
  // minute). A paused clock (running === false) does not move. The result may be fractional;
  // records stamped from it should use Math.floor.
  clock.advance = function (clockState, realMsElapsed) {
    const st = clockState || {};
    const sim = +st.simMin || 0;
    if (st.running === false || !(realMsElapsed > 0)) return sim;
    const speed = +st.speed > 0 ? +st.speed : 1;
    return sim + realMsElapsed / 60000 * speed;
  };

  // Drives a store: every intervalMs, if state.clock.running, dispatches
  // { type: 'clock/tick', simMin }. Timers and the wall clock are injectable for tests.
  clock.createTicker = function (opts) {
    const o = opts || {};
    const getState = o.getState || (o.store && o.store.getState);
    const dispatch = o.dispatch || (o.store && o.store.dispatch);
    const now = o.now || function () { return Date.now(); };
    const setIv = o.setInterval || function (f, ms) { return setInterval(f, ms); };
    const clearIv = o.clearInterval || function (h) { clearInterval(h); };
    const intervalMs = o.intervalMs || 250;
    let handle = null, last = null;
    const ticker = {
      tick: function () {
        const t = now();
        const elapsed = last === null ? 0 : t - last;
        last = t;
        const st = getState();
        if (!st || !st.clock || !st.clock.running || !(elapsed > 0)) return false;
        dispatch({ type: 'clock/tick', simMin: clock.advance(st.clock, elapsed) });
        return true;
      },
      start: function () { if (handle === null) { last = now(); handle = setIv(ticker.tick, intervalMs); } return ticker; },
      stop: function () { if (handle !== null) { clearIv(handle); handle = null; } last = null; return ticker; },
      isRunning: function () { return handle !== null; }
    };
    return ticker;
  };
})(typeof self !== 'undefined' ? self : globalThis);
