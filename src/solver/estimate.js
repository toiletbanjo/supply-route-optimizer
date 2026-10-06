// Run-time estimates per method (DESIGN.md section 7, "Methods" and "Method parameters"). Pure JS: runs in
// the solver worker, on the main thread (where the method files may not be loaded) and in Node.
//
//   SRO.solver.estimate(instance, method, params, settings, opts)
//     -> { method, seconds, low, high, basis, capped, capSec, source: 'probe' | 'model' | 'limit',
//          probe: { ms, iterations, budget, setupMs, perIterMs, evalRate, cached, rawSec } }
//     seconds = expected wall time; low..high = the likely range, never past the time cap (a run stops
//     there); rawSec = before the timeCapSec cap.
//     MIP: probe = { warmSec, limitSec }; seconds = high = the limit.
//   SRO.solver.estimateMany(instance, methods, paramsByMethod, settings, opts)
//     -> { seconds, low, high, basis, perMethod: [estimate] }   (compare mode: run one after another,
//        MIP seeded by the heuristics, so it has no warm-start phase of its own)
//
// Heuristics (tabu, sa, aco), method registered here: a timing probe on the actual instance. The method
// itself runs with the actual params for about opts.probeMs (default 200 ms) of iterations after its
// setup, at least 100 shouldStop calls, 10 iterations and two progress intervals of its current phase, and
// is then stopped through hooks.shouldStop (typically 0.2-1.2 s in all; the first probe of a method in a
// thread runs 300 ms longer while the JIT settles). The probe is the start
// of the real run: its setup (start plan; the first progress call) and the time its first k iterations
// took count as measured, and only the rest of the iteration budget is extrapolated, at the time per
// iteration of the probe's later half (shouldStop calls as the clock, scaled by the iterations the
// progress reports say were done there). The budget, in the same unit as result.iterations:
//   tabu: params.iterations          aco: params.iterations
//   sa:   temperature steps x itersPerTemp x (reheats + 1), steps = ln(stopTempRatio) / ln(coolingRate)
//   other methods: method.budget(instance, params) when the method defines it, else from the
//   progress fraction it reports (iteration / fraction).
// The extrapolated part gets a drift factor (the rest of a run is faster per iteration than its first
// part; see DRIFT), the whole a short tail for the final polish, then it is capped at params.timeCapSec.
// A budget below k is read off the probe's iteration curve. Probe results are cached per instance object and per the knobs that change the cost of one iteration (not
// seed, timeCapSec or the iteration budget), so dragging a budget slider re-estimates instantly; a run
// that ended on its own inside the probe answers for its own budget only (and, when it converged, for
// any larger one).
//
// Method not registered (main thread), its probe threw, or the probe ended before the first iteration
// (a long start phase): a rough model from evaluate() throughput on this instance (source 'model', wider
// low/high), so the Advanced form can still show a number.
//
// An instance that solve() would reject (SRO.solver.validateInstance) throws the same 'bad-instance'
// error here.
//
// MIP: its time limit, min(timeLimitSec, timeCapSec), which in mip.js already contains the heuristic
// warm-start phase (none when opts.hasStart or warmStart is off; probe.warmSec says how long it is),
// plus a little decode overhead. The basis text says it stops at the limit and reports a proven gap.
//
// opts: { probeMs (default 200 ms of iterations after the setup, and at least 100 shouldStop calls),
//         maxProbeMs (default 1200 ms after the setup), cache
//         (default true), warmup (default true: the first probe of a method in this thread runs 300 ms
//         (or probeMs) longer), hasStart (MIP), start (a start plan the run will get), rawCap (honor a
//         timeCapSec below the form minimum, as tabu does for MIP's warm start), now () -> ms }.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  const mmax = Math.max, mmin = Math.min, mlog = Math.log, mceil = Math.ceil, mround = Math.round;
  const COST_ONLY = { costOnly: true };

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // Iteration budget per method, in the unit of the method's result.iterations.
  const BUDGET = {
    tabu: function (p) { return p.iterations; },
    aco: function (p) { return p.iterations; },
    sa: function (p) {
      const steps = (p.coolingRate > 0 && p.coolingRate < 1 && p.stopTempRatio > 0 && p.stopTempRatio < 1)
        ? mceil(mlog(p.stopTempRatio) / mlog(p.coolingRate)) : 1000;
      return steps * mmax(1, p.itersPerTemp) * (mmax(0, p.reheats) + 1);
    }
  };
  // The iterations after a probe run faster on average than the probe's last ones: tabu's early walk
  // steps work on a rough plan (long-run average / probe time per step about 0.75-0.8 on Phase 1
  // instances). SA's probe sees only the start of its first cooling cycle (6,400-20,000 of 365,500
  // moves at default params): the hottest moves (more accepted, each dearer) and, in a browser worker,
  // code the JIT is still optimizing. Without a factor the default-params estimate ran 1.16-1.58x the
  // run in Chromium (where the planner sees it) and about 1.0-1.15x in Node; with 0.85 Chromium measured
  // 0.88-1.28x and Node 0.77-1.13x (9 Phase 1 windows, CPU clock). Applied to the extrapolated
  // iterations only. ACO's rounds cost the same after the first (measured 2026-10-06).
  const DRIFT = { tabu: 0.8, sa: 0.85 };
  // Knobs that only change the budget or the stopping rule (not the cost of one iteration): left out of
  // the probe cache key.
  const BUDGET_KNOBS = {
    tabu: ['seed', 'timeCapSec', 'iterations'],
    aco: ['seed', 'timeCapSec', 'iterations'],
    sa: ['seed', 'timeCapSec', 'coolingRate', 'stopTempRatio', 'reheats'],
    mip: ['seed', 'timeCapSec', 'timeLimitSec', 'mipGap']
  };
  // Fallback model (method not loaded): time per iteration as a multiple of one costOnly evaluate() of
  // the sample plan (move generation, copy-on-write build and bookkeeping included). Calibrated against
  // the real methods' long-run averages on Phase 1 instances; rough, hence the wider low..high. SA: 18
  // (re-measured 2026-10-06 after sa.js moved to best-of-3 proposals and per-cycle polishes: 16 on
  // 30-job windows, up to 30 on 10-job ones; 7 was 2-4x low).
  const MODEL = {
    tabu: function (p, n) { return p.neighborhood * 6; },
    sa: function (p, n) { return 18; },
    aco: function (p, n) { return p.ants * (n.nJ * 25 + 60) + (p.localSearch ? 4000 : 0); }
  };
  // A probe runs until the method has asked shouldStop at least this many times (tabu: once per step,
  // SA: once per 64 moves) or maxProbeMs: the first few dozen tabu steps on a rough start plan cost 2-5x
  // the run's average, and the time per iteration is read from the later half of these calls.
  const PROBE_MIN_UNITS = 100;
  // The first probe of a method in a thread runs this many ms longer: in a fresh Chromium worker a probe
  // after a 100 ms warm-up still timed SA's moves 1.5x slower than the run's average (the JIT keeps
  // tiering up for about half a second); Node settles sooner.
  const WARMUP_MS = 300;
  // ... and has reported at least this many iterations (ACO asks shouldStop once per ant, so 100 calls
  // were only 4-5 rounds, the first of them 2-3x slower than the rest).
  const PROBE_MIN_ITERS = 10;
  const MIP_WARM_CAP_SEC = 10;         // mip.js caps its own warm-start tabu pass at 10 s

  // ---- small text helpers (format.js is main-thread only) ---------------------------------------
  function int(n) { return String(mround(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function secs(s) {
    if (!(s >= 0) || !isFinite(s)) return 'unknown';
    if (s < 1) return 'under 1 s';
    if (s < 10) return (mround(s * 10) / 10) + ' s';
    if (s < 120) return mround(s) + ' s';
    const m = Math.floor(s / 60), r = mround(s - m * 60);
    return m + ' min' + (r ? ' ' + r + ' s' : '');
  }
  function ms(x) {
    if (x < 0.1) return (x < 0.01 ? mround(x * 10000) / 10 : mround(x * 1000)) + ' \u00b5s';
    return x < 10 ? (mround(x * 100) / 100) + ' ms' : mround(x) + ' ms';
  }
  function about(s) { return s < 1 ? 'under 1 s' : 'about ' + secs(s); }

  // ---- cache ------------------------------------------------------------------------------------
  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function cacheKey(method, p) {
    const skip = BUDGET_KNOBS[method] || ['seed', 'timeCapSec'];
    const keys = Object.keys(p).filter(function (k) { return skip.indexOf(k) < 0; }).sort();
    return method + '|' + keys.map(function (k) { return k + '=' + p[k]; }).join(',');
  }
  // The budget knobs' values (not seed or timeCapSec): a run that finished inside the probe stands for
  // this budget only.
  function budgetSig(method, p) {
    const knobs = (BUDGET_KNOBS[method] || []).filter(function (k) { return k !== 'seed' && k !== 'timeCapSec'; });
    return knobs.map(function (k) { return k + '=' + p[k]; }).join(',');
  }
  // A probe that ended on its own stands for its own budget, or (converged: nothing left to do) for any
  // larger one.
  function finishedApplies(cal, sig, budget) {
    return cal.finishedFor === sig ||
      (cal.finishedReason !== 'budget' && cal.finishedReason !== 'time' && budget > 0 && budget >= cal.iterations);
  }
  // Same rule and message as solve() (api.js): an instance that cannot be solved cannot be estimated.
  function checkInstance(instance) {
    const problems = typeof S.validateInstance === 'function' ? S.validateInstance(instance)
      : (!instance || typeof instance !== 'object' ? ['The instance is missing.'] : []);
    if (!problems.length) return;
    const msg = 'The plan cannot be solved: ' + problems[0] + (problems.length > 1 ? ' (and ' + (problems.length - 1) + ' more problem' + (problems.length > 2 ? 's' : '') + ')' : '');
    if (typeof S.solverError === 'function') throw S.solverError('bad-instance', msg, { problems: problems });
    const e = new Error(msg); e.code = 'bad-instance'; e.problems = problems; throw e;
  }
  function cacheGet(instance, key) {
    if (!cache || !instance || typeof instance !== 'object') return null;
    const m = cache.get(instance);
    return m ? m.get(key) || null : null;
  }
  function cachePut(instance, key, v) {
    if (!cache || !instance || typeof instance !== 'object') return;
    let m = cache.get(instance);
    if (!m) { m = new Map(); cache.set(instance, m); }
    m.set(key, v);
  }

  // ---- evaluate throughput ------------------------------------------------------------------------
  // A plan to time evaluate() on: construct() when loaded, else every job whole on its first
  // compatible truck at its first candidate node (may break capacity; only the timing matters).
  function samplePlan(instance) {
    if (typeof S.construct === 'function') return S.construct(instance);
    const sol = S.emptySolution(instance);
    const P = S.prepare(instance);
    for (let j = 0; j < P.nJ; j++) {
      const nodes = P.jCandNodes[j];
      if (!nodes || !nodes.length) continue;
      for (let v = 0; v < P.nV; v++) {
        if (P.vFuel[v] !== P.jFuel[j]) continue;
        const visits = sol.routes[v].visits;
        let vis = null;
        for (let s = 0; s < visits.length; s++) if (visits[s].node === nodes[0]) vis = visits[s];
        if (!vis) { vis = { node: nodes[0], jobs: [] }; visits.push(vis); }
        vis.jobs.push({ job: j, qty: P.jQty[j] });
        break;
      }
    }
    return sol;
  }

  // costOnly evaluations per second: a short warm-up (the first calls run before the JIT has compiled
  // evaluate), then the fastest of a few windows (a GC pause or another process only slows one window).
  function evalRate(instance, now, budgetMs) {
    const sol = samplePlan(instance);
    const win = mmax(5, budgetMs / 4);
    let best = 0;
    for (let w = 0; w < 4; w++) {
      let n = 0;
      const t0 = now();
      let t = t0;
      while (t - t0 < win) {
        for (let i = 0; i < 50; i++) S.evaluate(instance, sol, COST_ONLY);
        n += 50;
        t = now();
      }
      if (w > 0) best = mmax(best, n / mmax(1e-6, (t - t0) / 1000));   // window 0 is the warm-up
    }
    return best;
  }

  // ---- probe ------------------------------------------------------------------------------------
  // Iteration count at time t on a probe's curve [[t, iteration], ...] (non-decreasing), and the time
  // at which it reaches iteration `it` (linear between the progress reports).
  function iterAt(curve, t) {
    if (!curve.length || t <= curve[0][0]) return curve.length ? curve[0][1] : 0;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (t <= b[0]) return b[0] > a[0] ? a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]) : b[1];
    }
    return curve[curve.length - 1][1];
  }
  function timeAt(curve, it) {
    if (!curve.length) return 0;
    if (it <= curve[0][1]) return curve[0][0];
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (it <= b[1]) return b[1] > a[1] ? a[0] + (b[0] - a[0]) * (it - a[1]) / (b[1] - a[1]) : b[0];
    }
    return curve[curve.length - 1][0];
  }

  // The trailing steady phase of a probe: pts = [{ t, it, n }] (progress reports after the setup: time,
  // iteration, shouldStop calls so far). Walking back from the last interval, intervals whose
  // iterations-per-call ratio is within 2x of the last one's belong to the same phase (tabu: one call per
  // walk step, many iterations per call in its charged start trials and restarts; SA: 64 moves per call;
  // a polish: no iterations). Returns the index where that phase starts when it spans at least two
  // intervals, else -1.
  function steadyFrom(pts) {
    const L = pts.length;
    if (L < 3) return -1;
    const ipt = function (a, b) { const dn = b.n - a.n, di = b.it - a.it; return dn > 0 ? di / dn : (di > 0 ? Infinity : 0); };
    const last = ipt(pts[L - 2], pts[L - 1]);
    if (!(last > 0 && last < Infinity)) return -1;
    let i = L - 2;
    while (i > 0) {
      const r = ipt(pts[i - 1], pts[i]);
      if (r >= last / 2 && r <= 2 * last) i--; else break;
    }
    return L - 1 - i >= 2 ? i : -1;
  }

  // One timed run of the method, stopped through hooks.shouldStop once it has done `target` ms, at least
  // `minUnits` shouldStop calls and (by its progress reports) `minIters` iterations after its setup (the
  // first progress call at iteration 0 marks the end of the setup), and (needSteady) two progress
  // intervals of its current phase, or `maxMs` after the setup.
  // The probe is the start of the real run (same instance, params and seed), so the time it took for
  // its k iterations is kept as is (observedMs; the iteration curve from the progress reports, for a
  // budget below k) and only the iterations after k are extrapolated, at the rate of the probe's last
  // steady phase (see steadyFrom; the later half of the probe when there is none): a start phase that
  // costs more or less per iteration than the rest (tabu's charged start trials, a rough start plan,
  // the JIT settling) does not skew the rate.
  // That rate comes from the shouldStop calls in the phase (methods ask once per step or per fixed group
  // of moves, so the calls are a fine clock of work), scaled by the iterations the progress reports say
  // were done there, as the median of up to 5 windows: a GC pause or another process taking the CPU for
  // a moment only slows one window.
  function probeOnce(instance, method, p, opts, now, target, maxMs, minUnits, needFraction, minIters, needSteady) {
    const m = S.methods[method];
    const points = [], ticks = [], pts = [];
    let tStart = 0, lastIter = 0, setupAt = null, sawFraction = !needFraction;
    const hooks = {
      now: now,
      onProgress: function (q) {
        const t = now() - tStart;
        const it = q && typeof q.iteration === 'number' ? q.iteration : null;
        if (it != null) lastIter = it;
        if (setupAt === null) setupAt = it === 0 ? t : 0;
        if (it > 0 && q.fraction > 0 && q.fraction < 1) sawFraction = true;
        points.push({ t: t, iteration: it, fraction: q && typeof q.fraction === 'number' ? q.fraction : null });
        if (it != null && t >= setupAt) pts.push({ t: t, it: pts.length ? mmax(pts[pts.length - 1].it, it) : it, n: ticks.length });
      },
      shouldStop: function () {
        const t0 = now() - tStart;
        ticks.push(t0);
        const t = t0 - (setupAt || 0);
        if (t >= maxMs) return true;
        if (!(t >= target && ticks.length >= minUnits && lastIter >= minIters && sawFraction)) return false;
        return !needSteady || steadyFrom(pts) >= 0;
      }
    };
    if (opts.start) hooks.start = opts.start;
    const pr = {};
    for (const k in p) if (Object.prototype.hasOwnProperty.call(p, k)) pr[k] = p[k];
    tStart = now();
    const res = m.run(instance, pr, hooks);
    const T = now() - tStart;
    const k = res && typeof res.iterations === 'number' ? res.iterations : lastIter;
    const setup = setupAt || 0;
    // iteration curve after the setup: the progress reports, then the end of the probe
    const curve = [[setup, 0]];
    for (let i = 0; i < points.length; i++) {
      const q = points[i];
      if (q.iteration == null || q.t < setup) continue;
      curve.push([q.t, mmax(curve[curve.length - 1][1], q.iteration)]);
    }
    curve.push([mmax(T, curve[curve.length - 1][0]), mmax(k, curve[curve.length - 1][1])]);
    const allPerIter = k > 0 ? (T - setup) / k : null;
    let perIter = k > 0 ? allPerIter : T;
    // the window: the last steady phase up to the last progress report (the partial interval after it
    // may already belong to the next phase), else the later half of the shouldStop calls up to the end
    let wT0 = null, wT1 = null, units = 0;
    const sIdx = steadyFrom(pts);
    if (sIdx >= 0) {
      // ... from the later half of the probe on (JIT settled), keeping at least one interval
      const b = pts[pts.length - 1], tMid = setup + (b.t - setup) / 2;
      let ai = sIdx;
      while (ai < pts.length - 2 && pts[ai].t < tMid) ai++;
      const a = pts[ai];
      wT0 = a.t; wT1 = b.t; units = b.it - a.it;
    } else {
      const post = ticks.filter(function (t) { return t >= setup; });
      if (post.length >= 8) { wT0 = post[Math.floor(post.length * 0.5)]; wT1 = T; units = k - iterAt(curve, wT0); }
    }
    if (k >= 4 && wT0 != null && units >= 3 && wT1 > wT0) {
      const tk = ticks.filter(function (t) { return t >= wT0 && t <= wT1; });
      const avg = (wT1 - wT0) / units;
      perIter = avg;
      const nT = tk.length;
      if (nT >= 5) {
        const tpi = (nT - 1) / units;                       // shouldStop calls per iteration there
        const nW = mmin(5, Math.floor((nT - 1) / 2));
        const rates = [];
        for (let w = 0; w < nW; w++) {
          const ia = Math.floor((nT - 1) * w / nW), ib = Math.floor((nT - 1) * (w + 1) / nW);
          if (ib > ia) rates.push((tk[ib] - tk[ia]) / ((ib - ia) / tpi));
        }
        rates.sort(function (x, y) { return x - y; });
        const late = rates.length ? rates[(rates.length - 1) >> 1] : avg;
        if (late > 0.5 * avg && late < 1.5 * avg) perIter = late;
      }
    }
    let fractionBudget = null;
    for (let i = points.length - 1; i >= 0; i--) {
      const q = points[i];
      if (q.iteration > 0 && q.fraction > 0 && q.fraction < 1) { fractionBudget = q.iteration / q.fraction; break; }
    }
    // at most 64 curve points in the cache
    const step = Math.ceil(curve.length / 64);
    const kept = step > 1 ? curve.filter(function (c, i) { return i % step === 0 || i === curve.length - 1; }) : curve;
    return { ms: T, iterations: k, setupMs: setup, observedMs: T - setup, curve: kept, perIterMs: mmax(1e-6, perIter), allPerIterMs: allPerIter,
      fractionBudget: fractionBudget, stopReason: res && res.stopReason, steady: sIdx >= 0 };
  }

  // The first probe of a method in this thread runs WARMUP_MS longer: the JIT is still compiling the
  // method at first, and the rate is read from the probe's later half only (the time it took counts as
  // observed, so the cold start costs the estimate a little, not the rate).
  const warmed = {};
  function probe(instance, method, p, opts, now) {
    const first = !warmed[method] && opts.warmup !== false;
    const target = (opts.probeMs != null ? opts.probeMs : 200) + (first ? (opts.probeMs != null ? opts.probeMs : WARMUP_MS) : 0);
    const maxMs = mmax(target, opts.maxProbeMs != null ? opts.maxProbeMs : 1200);
    // no known budget: keep going until a progress report gives iteration / fraction
    const m = S.methods[method];
    const needFraction = !BUDGET[method] && !(m && typeof m.budget === 'function');
    warmed[method] = true;
    const r = probeOnce(instance, method, p, opts, now, target, maxMs, PROBE_MIN_UNITS, needFraction, PROBE_MIN_ITERS, true);
    r.lastMs = r.ms;
    r.warmupMs = first ? target - (opts.probeMs != null ? opts.probeMs : 200) : 0;
    return r;
  }


  // ---- MIP --------------------------------------------------------------------------------------
  // mip.js: the whole run, warm start included, ends at min(timeLimitSec, timeCapSec); its warm-start
  // tabu pass gets min(10, max(2, 10% of the limit), half the limit) seconds when it has no start plan.
  function estimateMip(instance, p, settings, opts) {
    let limit = p.timeLimitSec > 0 ? p.timeLimitSec : 300;
    if (p.timeCapSec > 0) limit = mmin(limit, p.timeCapSec);
    const warm = p.warmStart && !opts.hasStart ? mmin(MIP_WARM_CAP_SEC, mmax(2, 0.1 * limit), 0.5 * limit) : 0;
    // the decode and evaluate after the limit take a fraction of a second; "up to" the limit is what
    // the planner set and reads, so the range ends there
    const seconds = limit;
    const gapPct = mround(p.mipGap * 1000) / 10;
    const basis = 'Runs until its ' + secs(limit) + ' time limit' +
      (warm ? ' (the first ' + secs(warm) + ' of it go to a quick tabu search for a starting plan)' : opts.hasStart ? ', starting from the best heuristic plan' : '') +
      ', then reports the best plan found and its proven gap (how far it could be from the best possible plan). ' +
      'It stops sooner only if that gap falls to ' + gapPct + '%' + (p.mipGap === 0 ? ' (a proof of the best plan)' : '') + '.';
    return {
      method: 'mip', seconds: seconds, low: mmin(limit, warm + 1), high: seconds, basis: basis,
      capped: true, capSec: limit, source: 'limit', probe: { warmSec: warm, limitSec: limit }
    };
  }

  // ---- main -------------------------------------------------------------------------------------
  S.estimate = function (instance, method, params, settings, opts) {
    opts = opts || {};
    const now = typeof opts.now === 'function' ? opts.now : defaultNow;
    checkInstance(instance);
    const p = S.methodParams ? S.methodParams(method, params, settings)
      : (S.PARAMS && S.PARAMS[method] ? S.clampParams(method, params, settings) : Object.assign({}, params));
    // a below-minimum timeCapSec is honored when asked (MIP's short warm-start pass)
    if (opts.rawCap && params && typeof params.timeCapSec === 'number' && params.timeCapSec > 0) p.timeCapSec = params.timeCapSec;
    if (method === 'mip') return estimateMip(instance, p, settings, opts);
    if (!(S.methods && S.methods[method]) && !(S.PARAMS && S.PARAMS[method])) {
      const msg = 'There is no solver method called "' + method + '".';
      if (typeof S.solverError === 'function') throw S.solverError('unknown-method', msg);
      throw new Error(msg);
    }

    const cap = typeof p.timeCapSec === 'number' && p.timeCapSec > 0 ? p.timeCapSec : Infinity;
    const label = (S.METHOD_LABELS && S.METHOD_LABELS[method]) || method;
    const m = S.methods && S.methods[method];
    const useCache = opts.cache !== false;
    const key = cacheKey(method, p) + (opts.start ? '|start' : '');
    const P = S.prepare(instance);
    // iteration budget, in the unit of result.iterations (method.budget, else the table; a method
    // without either gets iteration / fraction from its probe below)
    let budget = null;
    if (m && typeof m.budget === 'function') { try { budget = m.budget(instance, p); } catch (e) { budget = null; } }
    if (!(budget > 0) && BUDGET[method]) budget = BUDGET[method](p);
    const sig = budgetSig(method, p);
    let cal = useCache ? cacheGet(instance, key) : null;
    // a cached probe that ran to the end of a different (smaller) budget, polish included, says
    // nothing about the time per iteration of a longer run: probe again
    if (cal && cal.finishedMs != null && !finishedApplies(cal, sig, budget)) cal = null;
    let cached = !!cal;
    let source, probeError = null, startFloorMs = 0;

    if (m && typeof m.run === 'function') {
      source = 'probe';
      if (!cal) {
        try {
          const pr = probe(instance, method, p, opts, now);
          const finished = !!pr.stopReason && pr.stopReason !== 'stopped';
          if (!finished && !(pr.iterations > 0)) {
            // stopped before its first iteration (a long start phase): nothing to extrapolate from;
            // remembered so the next knob change does not probe again
            cal = { noIterations: true, ms: pr.ms, startMs: pr.lastMs, iterations: 0 };
          } else {
            cal = { setupMs: pr.setupMs, perIterMs: pr.perIterMs, allPerIterMs: pr.allPerIterMs, observedMs: pr.observedMs, curve: pr.curve,
              ms: pr.ms, iterations: pr.iterations, fractionBudget: pr.fractionBudget,
              // the run ended on its own inside the probe (tiny window, nothing to do): that is the run time,
              // for this budget (the cache key leaves the budget knobs out) or, when it converged, any larger one
              finishedMs: finished ? pr.lastMs : null, finishedFor: finished ? sig : null,
              finishedReason: finished ? pr.stopReason : null };
          }
          if (useCache) cachePut(instance, key, cal);
        } catch (e) {
          cal = null;
          probeError = (e && e.message) || String(e);
        }
      }
      if (cal && cal.noIterations) {
        probeError = label + ' was still building its start plan when the ' + ms(cal.startMs) + ' timing probe ended';
        startFloorMs = cal.startMs;
        cal = null;
      }
    }
    if (!cal) {
      // model from evaluate() throughput (method not loaded, or the probe failed)
      source = 'model';
      const mkey = 'model|' + key;
      cal = useCache ? cacheGet(instance, mkey) : null;
      cached = !!cal;
      if (!cal) {
        const t0 = now();
        if (typeof S.construct === 'function') S.construct(instance);
        const setupMs = typeof S.construct === 'function' ? now() - t0 : 0;
        const rate = evalRate(instance, now, mmin(80, opts.probeMs != null ? opts.probeMs : 80));
        const f = MODEL[method];
        const perIterEvals = f ? f(p, P) : null;
        cal = { setupMs: setupMs, evalRate: rate, perIterMs: perIterEvals != null ? perIterEvals / rate * 1000 : null, ms: now() - t0 };
        if (useCache) cachePut(instance, mkey, cal);
      }
      if (startFloorMs > cal.setupMs) cal = Object.assign({}, cal, { setupMs: startFloorMs });
    }

    if (!(budget > 0) && cal.fractionBudget > 0) budget = cal.fractionBudget;

    let raw, basis, perIterUsed = cal.perIterMs;
    if (cal.finishedMs != null && finishedApplies(cal, sig, budget)) {
      raw = cal.finishedMs / 1000;
      basis = label + ' finished the whole run within the timing probe (' + ms(cal.finishedMs) + ').';
    } else if (cal.perIterMs == null || !(budget > 0)) {
      raw = Infinity;
      basis = 'No timing model for ' + label + ': it runs until it stops on its own or at the ' + secs(cap) + ' limit.';
    } else {
      // probe: the observed start of the run as is, the iterations after it at the later-half rate times
      // the drift (they all come later in the run than the probe's); a budget the probe already passed
      // is read off the probe's own iteration curve
      let perIter = cal.perIterMs, work;
      if (source === 'probe' && cal.curve && cal.iterations > 0) {
        const drift = DRIFT[method] != null ? DRIFT[method] : 1;
        work = budget <= cal.iterations ? timeAt(cal.curve, budget) - cal.setupMs
          : cal.observedMs + (budget - cal.iterations) * perIter * drift;
      } else {
        work = perIter * budget;
      }
      perIterUsed = perIter;
      const tail = 50 + 0.05 * work;                 // polishes outside the iterations (tabu: final; SA: per cycle + final)
      raw = (cal.setupMs + work + tail) / 1000;
      const unit = method === 'sa' ? 'moves' : method === 'tabu' ? 'steps' : 'iterations';
      if (source === 'probe') {
        basis = 'Timed the first ' + int(cal.iterations) + ' ' + unit + ' of ' + label + ' on this plan (' + ms(cal.observedMs != null ? cal.observedMs : 0) +
          ' after ' + ms(cal.setupMs) + ' for the start plan; ' + ms(perIter) + ' each at the end); all ' + int(budget) + ' ' + unit + ' take ' + about(raw) + '.';
      } else {
        basis = 'Rough estimate (' + label + (startFloorMs ? ' was still building its start plan when the timing probe ended'
          : probeError ? ' could not be timed here' : ' is not loaded here') + '): ' + int(budget) + ' ' + unit + ' at about ' +
          ms(cal.perIterMs) + ' each, from ' + int(cal.evalRate) + ' plan evaluations per second on this plan' +
          (startFloorMs ? ', after more than ' + secs(startFloorMs / 1000) + ' for the start plan' : '') + '.';
      }
    }
    const capped = raw > cap;
    const seconds = capped ? cap : raw;
    const spread = source === 'probe' ? 1.5 : 2.5;
    let low = seconds / spread, high = seconds * spread;
    if (isFinite(cap)) {                         // the run stops at the cap, so the range does too
      high = mmin(high, cap);
      if (capped) { low = mmin(cap, raw / spread); high = cap; }
    }
    if (capped && isFinite(raw)) basis += ' That is more than the ' + secs(cap) + ' limit, so it stops at ' + secs(cap) + ' with the best plan found by then.';
    else if (isFinite(cap) && isFinite(raw)) basis += ' It stops early at the ' + secs(cap) + ' limit if it gets there first.';
    return {
      method: method, seconds: seconds, low: low, high: high, basis: basis, capped: capped, capSec: cap, source: source,
      probe: { ms: cal.ms, iterations: cal.iterations, budget: budget, setupMs: cal.setupMs, perIterMs: perIterUsed, evalRate: cal.evalRate, cached: cached, rawSec: raw, error: probeError }
    };
  };
  S.estimate.clearCache = function (instance) {
    if (!cache) return;
    if (instance) cache.delete(instance);
  };

  S.estimateMany = function (instance, methods, paramsBy, settings, opts) {
    opts = opts || {};
    paramsBy = paramsBy || {};
    const list = (Array.isArray(methods) ? methods : [methods]).filter(function (k, i, a) { return k && a.indexOf(k) === i; });
    const heur = list.filter(function (k) { return k !== 'mip'; });
    const per = list.map(function (k) {
      const o = Object.assign({}, opts);
      if (k === 'mip' && heur.length) o.hasStart = true;
      return S.estimate(instance, k, paramsBy[k], settings, o);
    });
    const sum = function (f) { return per.reduce(function (a, e) { return a + e[f]; }, 0); };
    return {
      seconds: sum('seconds'), low: sum('low'), high: sum('high'),
      basis: per.map(function (e) { return ((S.METHOD_LABELS && S.METHOD_LABELS[e.method]) || e.method) + ': ' + about(e.seconds) + '.'; }).join(' '),
      perMethod: per
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
