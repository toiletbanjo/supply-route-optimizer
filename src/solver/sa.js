// Simulated annealing (DESIGN.md section 7, "Methods" and "Method interface"): SRO.solver.methods.sa.
//
//   SRO.solver.methods.sa.run(instance, params, hooks) -> { solution, total, feasible, evals, iterations,
//       elapsedSec, stopReason, history, extra }
//   SRO.solver.methods.sa.budget(instance, params) -> proposals the full schedule makes (estimate.js uses it)
//   SRO.solver.methods.sa.schedule(params) -> { stepsFirst, stepsReheat, reheatRatio, itersPerTemp, reheats,
//       totalSteps, budget }
//
// Start. hooks.start, or the best of CFG.startTrials construct() plans (the default job order with the
// run's seeded RNG for tie-breaks, then perturbed orders as tabu.js uses for restarts): the walk's local
// moves cannot trade a whole set of rally points or truck assignments that construct() fixed early, and
// with maxRallyPoints 2 the default order left two of five Phase 1 windows 1.5-6x above what other
// orders give (12 construct() calls take ~10-40 ms). A given start plan is normalized, made
// violation-free when it is not (greedy removal of the work its violations point at; see repair()) and
// refilled (SRO.solver.refill: forced insertion of deferred jobs, never worse), because the walk alone
// cannot fix either: it never adds a violation and the flat 1e7 penalty gives it no slope towards
// removing one (4 of 24 random infeasible starts ended infeasible before this), and random inserts
// build a plan from many deferred jobs poorly (an empty start ended 10-45% above a construct start).
//
// Walk. Each proposal is the best of CFG.proposeK random moves from the shared move library
// (SRO.solver.moves.random on a context that is rebuilt only after an accepted move, then moves.build:
// copy-on-write, so the current and best plans are kept by reference), each scored with
// evaluate(..., { costOnly: true }). The proposal is accepted by the Metropolis rule on the totals:
// always when the total does not go up, else with probability exp(-delta / T). A proposal that adds
// violations is always rejected (violations cost 1e7 each, so this only matters for a huge manual start
// temperature); one that removes violations is an improvement and always accepted. Why best-of-3: on 10
// Phase 1 instances x 2 seeds at the default schedule, best-of-3 gave a 1.6% lower mean total than
// single moves, about the same as single moves with 3x the proposals per step (so it is as good per
// evaluation), and it makes the default schedule take ~10 s in Node instead of ~4 s: a better plan
// from the defaults, still well inside the product's 10-30 s.
//
// Temperature. T0 = params.startTemp, or when it is 0 (auto): CFG.samples proposals (made as the walk
// makes them, best of CFG.proposeK) are sampled from the start plan and T0 is the temperature at which
// the mean Metropolis acceptance probability over the worsening ones equals params.autoAcceptRate
// (bisection on log T), so the knob is the share of worse proposals accepted at the start, as its label
// says (calibrated on single moves, as first written, the default 0.5 accepted ~80% of the worse
// proposals). Samples that add violations are skipped, so the 1e7 violation penalty never inflates T0;
// a start plan with too few worsening proposals (nearly every move helps) is sampled along a downhill
// walk instead (see autoTemp). Geometric cooling: after every params.itersPerTemp proposals
// T *= params.coolingRate. A cooling cycle ends when T has fallen to
// params.stopTempRatio x T0; its final plan gets a short localSearch (CFG.cyclePolish). Then, up to
// params.reheats times, T is raised to CFG.reheatFrac x T0 (at least sqrt(stopTempRatio) x T0, so above
// the stop temperature) and the walk restarts from the best plan so far, polished first with a short
// localSearch. Defaults (cooling 0.995, 100 proposals per step, stop at 0.001, 2 reheats): 1,379 + 2 x
// 1,138 steps = 365,500 proposals.
//
// Polish. The best plan gets a final localSearch (compound refill / ruin-and-refill moves included),
// unless it already is the converged result of a cycle-end polish.
// Every localSearch here runs in fixed evaluation-count chunks (CFG.lsChunk), so progress is reported
// between chunks and the result does not depend on machine speed.
//
// Limits. Stops at the end of the schedule ('budget'), at params.timeCapSec ('time'; a small share of
// the cap, up to 2 s, is held back for the final polish and the whole run, polish included, ends at the
// cap), on hooks.shouldStop() ('stopped', no polish), or when no move applies to the plan ('converged').
// Deterministic for a given params.seed whenever the run is not cut by time: SRO.util.rng only; the
// clock only ends the run and never steers the search.
//
// Progress. hooks.onProgress is called right after the start plan and T0 are ready (iteration 0, which
// estimate.js reads as the end of the setup), soon after the best plan improves, and at least every
// CFG.progressMs otherwise: { fraction, bestCost, currentCost, elapsedSec, iteration, message,
// temperature, movesPerSec, best? }. `best` (the plan) is present only when it changed since the
// previous call. While the walk finds new bests every few moves, a new best waits at most CFG.bestMinMs
// before it is reported, so the worker does not copy a plan thousands of times a second. hooks.now is
// the clock for all of this; hooks.shouldStop is asked every CFG.checkEvery proposals and between polish
// chunks.
//
// params: SRO.solver.clampParams('sa', params) output (missing or invalid knobs fall back to the
// defaults). A timeCapSec below the form's minimum is honored as given (tests, short warm starts), as in
// tabu.js. iterations = proposals made (the unit of budget()); evals = plans evaluated (proposeK per
// proposal, plus T0 samples and localSearch). history: [{ t: seconds, best: total }], at most one point
// per CFG.historyMs. extra: { T0, autoTemp, tStop, reheatTemp, steps, reheatsDone, accepted, acceptRate,
// uphillAccepted, nullMoves, rejectedViol, movesPerSec, evalsPerSec, annealSec, startTotal, saBest,
// polishGain, polishEvals, reheatPolishGain, cyclePolishGain, cycleEnds: [{ walk, polished, best }],
// budget, samples: { taken, uphill, violations, descended }, startFix: null (construct start) or
// { violations (of the given plan), removed (chunks/visits taken off), refillGain }, startTrials: null
// (hooks.start) or { trials, chosen (0 = the default order), gain } }. startTotal is the total of the
// given plan or of the default construct() plan.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  S.methods = S.methods || {};
  const mmax = Math.max, mmin = Math.min, mabs = Math.abs, mexp = Math.exp, mlog = Math.log, msqrt = Math.sqrt, mceil = Math.ceil;
  const COST_ONLY = { costOnly: true };

  const CFG = {
    proposeK: 3,              // a proposal is the best of this many random moves (1 = plain SA)
    calibrateK: true,         // auto T0 from proposals as the walk makes them (false: from single moves)
    startTrials: 12,          // construct() orders tried for the start plan (the default one first; 1 = only it)
    progressMs: 100,          // progress at least this often (contract: 250 ms; + one polish chunk)
    bestMinMs: 40,            // a new best plan is reported at most this long after it is found
    historyMs: 50,            // history keeps at most one point per this many ms (the last best in it)
    checkEvery: 64,           // proposals between clock / shouldStop / progress checks (power of 2)
    samples: 200,             // auto T0: random moves sampled from the start plan ...
    minUphill: 20,            // ... up to 5x more while fewer than this many of them are worsening
    reheatFrac: 0.3,          // reheat to this share of T0 (at least sqrt(stopTempRatio))
    reheatPolish: true,       // polish the best plan with localSearch before each reheat ...
    reheatPolishEvals: 20000, // ... with at most this many evaluations
    cyclePolish: true,        // polish the walk's plan with localSearch at the end of each cooling cycle ...
    cyclePolishEvals: 20000,  // ... with at most this many evaluations
    lsChunk: 5000,            // evaluations per localSearch chunk (~50 ms on a Phase 1 window in Node)
    lsIdleChunks: 2,          // a polish ends after this many chunks in a row without a gain
    polishShare: 0.05,        // share of the time cap held back for the final polish ...
    polishReserveMaxMs: 2000, // ... but at most this many ms
    maxNullRun: 2000          // this many proposals in a row without an applicable move: converged
  };

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function tol(x) { return 1e-9 * mmax(1, mabs(x)); }
  // a strictly better than b (a violation-free plan is never beaten by one with violations)
  function better(aTotal, aFeas, bTotal, bFeas) {
    if (aFeas !== bFeas) return aFeas;
    return aTotal < bTotal - tol(bTotal);
  }

  function readParams(params) {
    const p = S.clampParams ? S.clampParams('sa', params) : Object.assign({}, params);
    const raw = params && params.timeCapSec;
    if (typeof raw === 'number' && raw > 0 && isFinite(raw)) p.timeCapSec = raw;
    return p;
  }

  // Temperature schedule in steps (one step = itersPerTemp proposals). The first cycle cools from T0 to
  // stopTempRatio x T0; each reheat cycle from reheatRatio x T0 to the same stop temperature.
  function schedule(p) {
    const cr = p.coolingRate, ratio = p.stopTempRatio;
    const reheatRatio = mmin(1, mmax(CFG.reheatFrac, msqrt(ratio)));
    const steps = function (from) {        // smallest k with from x cr^k <= ratio
      if (!(cr > 0 && cr < 1) || !(ratio > 0) || ratio >= from) return 1;
      return mmax(1, mceil(mlog(ratio / from) / mlog(cr) - 1e-9));
    };
    const stepsFirst = steps(1), stepsReheat = steps(reheatRatio);
    const per = mmax(1, p.itersPerTemp | 0);
    const reheats = mmax(0, p.reheats | 0);
    return {
      stepsFirst: stepsFirst, stepsReheat: stepsReheat, reheatRatio: reheatRatio, itersPerTemp: per, reheats: reheats,
      totalSteps: stepsFirst + reheats * stepsReheat,
      budget: (stepsFirst + reheats * stepsReheat) * per
    };
  }

  // The default construct order with each job shifted by a random amount (up to a quarter of the job
  // count), so a start trial tries another order while locked / Immediate jobs still tend to go first
  // (as tabu.js does for its restarts).
  function noisyOrder(instance, rng) {
    const base = S.constructOrder(instance, rng);
    const w = mmax(2, base.length / 4);
    const key = new Float64Array(instance.jobs.length);
    for (let i = 0; i < base.length; i++) key[base[i]] = i + rng() * w;
    return base.slice().sort(function (a, b) { return key[a] - key[b]; });
  }

  // One proposal: the best (fewest violations, then lowest total) of K random moves on `sol` (opts.ctx
  // is its moves.context). Sets out.sol / out.e (out.sol = null when no move applies) and out.evals.
  function propose(instance, sol, rng, opts, K, out) {
    const M = S.moves;
    let cand = null, ce = null, evals = 0;
    for (let k = 0; k < K; k++) {
      const m = M.random(instance, sol, rng, opts);
      const nr = m ? M.build(instance, sol, m) : null;
      if (!nr) continue;
      const c = { routes: nr };
      const ec = S.evaluate(instance, c, COST_ONLY);
      evals++;
      if (!cand || ec.nViolations < ce.nViolations || (ec.nViolations === ce.nViolations && ec.total < ce.total)) { cand = c; ce = ec; }
    }
    out.sol = cand; out.e = ce; out.evals = evals;
    return out;
  }

  // Auto start temperature: T with mean(exp(-d / T)) = rate over the worsening deltas d of proposals
  // from `sol` (bisection on log T; the mean increases with T). A sample is a proposal exactly as the
  // walk makes it (the best of K random moves), so `rate` is the share of worse proposals the walk
  // accepts at T0, as the knob's label says. Proposals that add violations are skipped (the walk
  // rejects them; the 1e7 penalty must not set T0). When the first CFG.samples proposals hold fewer
  // than CFG.minUphill worsening ones (a start plan where nearly every move helps, e.g. an empty plan),
  // the sampling walks downhill: each improving proposal becomes the sampled plan, so the worsening
  // deltas come from a plan like the ones the walk will be on instead of T0 being set by the large
  // gains of the first insertions.
  // Returns { T0, uphill, samples, violSamples, evals, ups, descended }.
  function autoTemp(instance, sol, total, nViol, rng, rate, K) {
    const M = S.moves;
    K = mmax(1, (K == null ? CFG.proposeK : K) | 0);
    let ctx = M.context(instance, sol);
    const opts = { ctx: ctx };
    const ups = [], pr = {};
    let absSum = 0, n = 0, evals = 0, viol = 0, descended = 0;
    const maxSamples = CFG.samples * 5;
    for (let i = 0; i < maxSamples; i++) {
      if (i >= CFG.samples && ups.length >= CFG.minUphill) break;
      propose(instance, sol, rng, opts, K, pr);
      evals += pr.evals;
      if (!pr.sol) { if (i >= CFG.samples) break; continue; }
      const e = pr.e;
      if (e.nViolations > nViol) { viol++; continue; }   // the 1e7 violation penalty must not set T0
      const d = e.total - total;
      n++; absSum += mabs(d);
      if (d > tol(total)) ups.push(d);
      else if (i >= CFG.samples && d < -tol(total)) {
        // too few worsening proposals so far (the loop ends at CFG.samples otherwise): walk downhill
        sol = pr.sol; total = e.total; nViol = e.nViolations; descended++;
        ctx = M.context(instance, sol); opts.ctx = ctx;
      }
    }
    let T0;
    if (!ups.length) {
      // nothing uphill from here (e.g. an empty start plan where every insert helps): the mean size of
      // a change, or 1
      T0 = n && absSum > 0 ? absSum / n : 1;
    } else {
      const meanAcc = function (T) {
        let s = 0;
        for (let i = 0; i < ups.length; i++) s += mexp(-ups[i] / T);
        return s / ups.length;
      };
      let lo = Infinity, hi = 0;
      for (let i = 0; i < ups.length; i++) { if (ups[i] < lo) lo = ups[i]; if (ups[i] > hi) hi = ups[i]; }
      let a = mlog(lo) - 12, b = mlog(hi) + 12;      // meanAcc(e^a) ~ 0, meanAcc(e^b) ~ 1
      for (let k = 0; k < 80; k++) {
        const mid = 0.5 * (a + b);
        if (meanAcc(mexp(mid)) < rate) a = mid; else b = mid;
      }
      T0 = mexp(0.5 * (a + b));
    }
    if (!(T0 > 0) || !isFinite(T0)) T0 = 1;
    return { T0: T0, uphill: ups.length, samples: n, violSamples: viol, evals: evals, ups: ups, descended: descended };
  }

  // A violation-free plan made from the normalized plan `sol` by taking work off it, greedily: each
  // step removes the one chunk or whole visit that leaves the fewest violations (ties: lowest total),
  // among those a violation points at (every chunk and visit of a route a violation names, every
  // chunk of an over-delivered job, every visit at a rally point when too many are used; any chunk or
  // visit for anything else). The empty plan is violation-free, so this ends; it is the fallback.
  // -> { solution, evals, removed }
  function repair(instance, sol) {
    const P = S.prepare(instance);
    let evals = 0, removed = 0;
    for (let guard = 0; guard < 100000; guard++) {
      const ev = S.evaluate(instance, sol);
      evals++;
      if (!ev.violations.length) return { solution: sol, evals: evals, removed: removed };
      const routes = sol.routes;
      const onRoute = new Set(), ofJob = new Set();
      let rally = false, all = false;
      ev.violations.forEach(function (v) {
        if (typeof v.route === 'number' && v.route >= 0 && v.route < routes.length) onRoute.add(v.route);
        else if (typeof v.job === 'number') ofJob.add(v.job);
        else if (v.code === 'too-many-rally') rally = true;
        else all = true;
      });
      let best = null, bestE = null;
      const tryOut = function (r, s, c) {
        const R = routes[r], vi = R.visits[s];
        const visits = R.visits.slice();
        if (c < 0 || vi.jobs.length === 1) visits.splice(s, 1);
        else { const jobs = vi.jobs.slice(); jobs.splice(c, 1); visits[s] = { node: vi.node, jobs: jobs }; }
        const out = routes.slice();
        out[r] = { vehicle: R.vehicle, visits: visits };
        const cand = { routes: out };
        const ce = S.evaluate(instance, cand, COST_ONLY);
        evals++;
        if (!best || ce.nViolations < bestE.nViolations || (ce.nViolations === bestE.nViolations && ce.total < bestE.total)) { best = cand; bestE = ce; }
      };
      for (let r = 0; r < routes.length; r++) {
        const vs = routes[r].visits;
        for (let s = 0; s < vs.length; s++) {
          const jobs = vs[s].jobs, single = jobs.length === 1;
          if (all || onRoute.has(r) || (rally && P.isRally[vs[s].node]) || (single && ofJob.has(jobs[0].job))) tryOut(r, s, -1);
          if (jobs.length < 2) continue;   // (taking off the only chunk is taking off the visit)
          for (let c = 0; c < jobs.length; c++) if (all || onRoute.has(r) || ofJob.has(jobs[c].job)) tryOut(r, s, c);
        }
      }
      if (!best) break;
      sol = best; removed++;
    }
    return { solution: S.emptySolution(instance), evals: evals, removed: removed };
  }

  function run(instance, params, hooks) {
    hooks = hooks || {};
    const M = S.moves;
    const p = readParams(params);
    const now = typeof hooks.now === 'function' ? hooks.now : defaultNow;
    const shouldStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const rng = SRO.util.rng(p.seed);
    const t0 = now();
    const capMs = p.timeCapSec * 1000;
    const endAt = t0 + capMs;
    const searchEndAt = endAt - mmin(CFG.polishReserveMaxMs, capMs * CFG.polishShare);
    const sch = schedule(p);
    const budget = sch.budget, per = sch.itersPerTemp, K = mmax(1, CFG.proposeK | 0);

    let evals = 0, it = 0, phase = 'start', stopReason = null;
    let cur = null, curTotal = Infinity, curFeas = false, curViol = 0;
    let best = null, bestTotal = Infinity, bestFeas = false, bestChanged = false, bestPolished = false;
    let lastReport = -Infinity, T = 0, cycle = 0;
    // anneal timing for moves/s: proposals over the time spent proposing (polishes inside the loop excluded)
    let saStart = t0, saEnd = null, innerMs = 0, annealEvals = 0;
    const history = [];

    function annealMs() { return (saEnd !== null ? saEnd : now()) - saStart - innerMs; }
    function movesPerSec() { const ms = annealMs(); return it > 0 && ms > 0 ? it / (ms / 1000) : 0; }
    function report(force) {
      if (!onProgress) return;
      const t = now();
      if (!force && t - lastReport < (bestChanged ? CFG.bestMinMs : CFG.progressMs)) return;
      lastReport = t;
      const elapsed = t - t0;
      let fraction = mmax(budget > 0 ? it / budget : 0, capMs > 0 ? elapsed / capMs : 0);
      if (phase === 'polish') fraction = mmax(fraction, 0.98);
      fraction = phase === 'done' ? 1 : mmin(0.99, fraction);
      const mps = phase === 'start' ? 0 : movesPerSec();
      const msg = {
        fraction: mmax(0, fraction), bestCost: bestTotal, currentCost: curTotal, elapsedSec: elapsed / 1000,
        iteration: it, temperature: T, movesPerSec: mps,
        message: phase === 'start' ? 'Start plan ready, annealing from temperature ' + fmtNum(T)
          : phase === 'anneal' ? 'Annealing' + (cycle > 0 ? ' (reheat ' + cycle + ' of ' + sch.reheats + ')' : '') +
            ': temperature ' + fmtNum(T) + ', move ' + fmtInt(it) + ' of ' + fmtInt(budget) +
            (mps > 0 ? ', ' + fmtInt(mps) + ' moves/s' : '')
          : phase === 'quench' ? 'Polishing the plan at the end of a cooling cycle'
          : phase === 'reheat' ? 'Polishing the best plan before reheating'
          : phase === 'polish' ? 'Polishing the best plan' : 'Done'
      };
      if (bestChanged) { msg.best = best; bestChanged = false; }
      onProgress(msg);
    }
    function addHistory(total) {
      const t = (now() - t0) / 1000;
      const last = history.length > 1 ? history[history.length - 1] : null;   // the start point stays
      if (last && t - last.t < CFG.historyMs / 1000) last.best = total;
      else history.push({ t: t, best: total });
    }
    // offer a plan as the new best; returns true when it is
    function offer(sol, total, feas) {
      if (best !== null && !better(total, feas, bestTotal, bestFeas)) return false;
      best = sol; bestTotal = total; bestFeas = feas; bestChanged = true; bestPolished = false;
      addHistory(total);
      return true;
    }
    function timeUp(limit) {
      if (shouldStop && shouldStop()) { stopReason = 'stopped'; return true; }
      if (now() >= limit) { stopReason = stopReason || 'time'; return true; }
      return false;
    }
    // localSearch in fixed evaluation-count chunks (deterministic, and progress between chunks) until
    // it reports a local optimum, CFG.lsIdleChunks chunks in a row bring nothing, the eval budget is
    // used, or `limit`; every improvement is offered as the best plan when it is one.
    function polish(sol, total, feas, maxEvals, limit) {
      let used = 0, idle = 0, converged = false;
      while (used < maxEvals) {
        if (timeUp(limit)) break;
        const st = {};
        const out = S.localSearch(instance, sol, {
          rng: rng, maxIters: mmin(CFG.lsChunk, maxEvals - used), timeLimitMs: mmax(1, limit - now()), stats: st
        });
        used += (st.evals || 0) + 1;
        const e = S.evaluate(instance, out, COST_ONLY);
        const improved = better(e.total, e.feasible, total, feas);
        if (improved) { sol = out; total = e.total; feas = e.feasible; offer(sol, total, feas); idle = 0; } else idle++;
        report(false);
        if (st.localOptimum || idle >= CFG.lsIdleChunks) { converged = true; break; }
      }
      evals += used;
      return { solution: sol, total: total, feasible: feas, converged: converged };
    }

    // ---- start plan and start temperature ----
    cur = hooks.start ? S.normalize(instance, hooks.start) : S.construct(instance, { rng: rng });
    let e = S.evaluate(instance, cur, COST_ONLY);
    evals++;
    const startTotal = e.total;
    let startFix = null, startTrials = null;
    if (!hooks.start && CFG.startTrials > 1) {
      // Start trials: construct() with perturbed job orders, keep the best. The walk's local moves
      // cannot trade a whole set of rally points or truck assignments that construct() fixed early
      // (with maxRallyPoints 2, two of five Phase 1 windows ended 3-6x above the best of 12 orders);
      // a construct() costs ~1-4 ms here.
      startTrials = { trials: CFG.startTrials, chosen: 0, gain: 0 };
      for (let k = 1; k < CFG.startTrials; k++) {
        const c = S.construct(instance, { rng: rng, order: noisyOrder(instance, rng) });
        const ec = S.evaluate(instance, c, COST_ONLY);
        evals++;
        if (better(ec.total, ec.feasible, e.total, e.feasible)) { cur = c; e = ec; startTrials.chosen = k; }
      }
      startTrials.gain = startTotal - e.total;
    }
    if (hooks.start) {
      // A given start plan is first made violation-free (the walk never adds violations and the flat
      // 1e7 penalty gives it no slope towards removing one, e.g. an over-full truck, so it could
      // otherwise end where it began) and refilled (random inserts build a plan from many deferred
      // jobs poorly: from an empty start the walk ended 10-45% above a construct start). Both are
      // never worse than their input by better().
      startFix = { violations: e.nViolations, removed: 0, refillGain: 0 };
      if (e.nViolations > 0) {
        const rp = repair(instance, cur);
        cur = rp.solution; evals += rp.evals; startFix.removed = rp.removed;
        e = S.evaluate(instance, cur, COST_ONLY); evals++;
      }
      const rf = S.refill(instance, cur, { rng: rng });
      evals += rf.evals;
      if (rf.solution !== cur) {
        const ef = S.evaluate(instance, rf.solution, COST_ONLY);
        evals++;
        if (better(ef.total, ef.feasible, e.total, e.feasible)) { startFix.refillGain = e.total - ef.total; cur = rf.solution; e = ef; }
      }
    }
    curTotal = e.total; curFeas = e.feasible; curViol = e.nViolations;
    offer(cur, curTotal, curFeas);
    const auto = !(p.startTemp > 0);
    let samples = null, T0;
    if (auto) {
      samples = autoTemp(instance, cur, curTotal, curViol, rng, p.autoAcceptRate, CFG.calibrateK ? K : 1);
      evals += samples.evals;
      T0 = samples.T0;
    } else T0 = p.startTemp;
    const tStop = T0 * p.stopTempRatio;
    const reheatTemp = T0 * sch.reheatRatio;
    T = T0;
    report(true);

    // ---- annealing ----
    phase = 'anneal';
    saStart = now();
    let ctx = M.context(instance, cur);
    const moveOpts = { ctx: ctx }, prop = {};
    let accepted = 0, uphill = 0, nullMoves = 0, rejectedViol = 0, nullRun = 0;
    let step = 0, inStep = 0, cycleSteps = sch.stepsFirst, reheatsDone = 0, reheatPolishGain = 0, cyclePolishGain = 0;
    const cycleEnds = [];
    for (;;) {
      if ((it & (CFG.checkEvery - 1)) === 0 && it > 0) {
        if (timeUp(searchEndAt)) break;
        report(false);
      }
      it++;
      // proposal: the best (fewest violations, then lowest total) of K random moves
      propose(instance, cur, rng, moveOpts, K, prop);
      annealEvals += prop.evals;
      const cand = prop.sol, ce = prop.e;
      if (cand) {
        nullRun = 0;
        let ok;
        if (ce.nViolations > curViol) { ok = false; rejectedViol++; }
        else {
          const d = ce.total - curTotal;
          if (d <= 0) ok = true;
          else { ok = rng() < mexp(-d / T); if (ok) uphill++; }
        }
        if (ok) {
          cur = cand; curTotal = ce.total; curFeas = ce.feasible; curViol = ce.nViolations;
          ctx = M.context(instance, cur); moveOpts.ctx = ctx;
          accepted++;
          offer(cur, curTotal, curFeas);
        }
      } else {
        nullMoves++;
        if (++nullRun >= CFG.maxNullRun) { stopReason = 'converged'; break; }
      }
      if (++inStep < per) continue;
      inStep = 0; step++;
      T *= p.coolingRate;
      if (step < cycleSteps) continue;
      // end of a cooling cycle: localSearch the walk's plan (sweeps and compound refill moves reach what
      // random moves miss); it may give a new best plan
      const tp = now();
      if (CFG.cyclePolish) {
        phase = 'quench';
        const before = bestTotal;
        const pc = polish(cur, curTotal, curFeas, CFG.cyclePolishEvals, searchEndAt);
        if (pc.converged && best === pc.solution) bestPolished = true;
        cycleEnds.push({ walk: curTotal, polished: pc.total, best: bestTotal });
        cyclePolishGain += before - bestTotal;
        phase = 'anneal';
      }
      if (!stopReason && reheatsDone >= sch.reheats) stopReason = 'budget';
      if (!stopReason && CFG.reheatPolish && !bestPolished) {
        // reheat from the best plan, polished first
        phase = 'reheat';
        const before = bestTotal;
        const pr = polish(best, bestTotal, bestFeas, CFG.reheatPolishEvals, searchEndAt);
        reheatPolishGain += before - bestTotal;
        bestPolished = pr.converged;
        phase = 'anneal';
      }
      if (!stopReason) {
        // (counted only when the walk really restarts: the clock or Cancel may end the polish above)
        reheatsDone++; cycle = reheatsDone;
        cur = best; curTotal = bestTotal; curFeas = bestFeas;
        curViol = S.evaluate(instance, cur, COST_ONLY).nViolations; evals++;
        ctx = M.context(instance, cur); moveOpts.ctx = ctx;
        T = reheatTemp; step = 0; cycleSteps = sch.stepsReheat;
      }
      innerMs += now() - tp;
      if (stopReason) break;
    }
    saEnd = now();
    evals += annealEvals;
    const saBest = bestTotal;
    const mps = movesPerSec(), annealSec = annealMs() / 1000;

    // ---- final polish ----
    phase = 'polish';
    const polishStart = evals;
    if (stopReason !== 'stopped' && !bestPolished) {
      report(true);
      const reason = stopReason;
      stopReason = null;
      polish(best, bestTotal, bestFeas, Infinity, endAt);
      if (stopReason !== 'stopped') stopReason = reason;
    }
    const polishEvals = evals - polishStart;

    phase = 'done';
    const fin = S.evaluate(instance, best, COST_ONLY);
    const elapsedSec = (now() - t0) / 1000;
    report(true);
    return {
      solution: best, total: fin.total, feasible: fin.feasible, evals: evals, iterations: it,
      elapsedSec: elapsedSec, stopReason: stopReason, history: history,
      extra: {
        T0: T0, autoTemp: auto, tStop: tStop, reheatTemp: reheatTemp, steps: sch.totalSteps, reheatsDone: reheatsDone,
        accepted: accepted, acceptRate: it > 0 ? accepted / it : 0, uphillAccepted: uphill, nullMoves: nullMoves,
        rejectedViol: rejectedViol, movesPerSec: mps, evalsPerSec: annealSec > 0 ? annealEvals / annealSec : 0,
        annealSec: annealSec, startTotal: startTotal, saBest: saBest, polishGain: saBest - fin.total,
        polishEvals: polishEvals, reheatPolishGain: reheatPolishGain, cyclePolishGain: cyclePolishGain,
        cycleEnds: cycleEnds, budget: budget, startFix: startFix, startTrials: startTrials,
        samples: samples ? { taken: samples.samples, uphill: samples.uphill, violations: samples.violSamples, descended: samples.descended } : null
      }
    };
  }

  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtNum(x) { return x >= 100 ? fmtInt(x) : x >= 1 ? String(Math.round(x * 10) / 10) : String(Math.round(x * 1000) / 1000); }

  S.methods.sa = {
    key: 'sa',
    label: (S.METHOD_LABELS && S.METHOD_LABELS.sa) || 'Simulated annealing',
    run: run,
    // proposals the full schedule makes (the unit of result.iterations), for estimate.js
    budget: function (instance, params) { return schedule(readParams(params)).budget; },
    schedule: function (params) { return schedule(readParams(params)); },
    _autoTemp: autoTemp,
    _cfg: CFG
  };
})(typeof self !== 'undefined' ? self : globalThis);
