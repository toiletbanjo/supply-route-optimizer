// Tabu search (DESIGN.md section 7, "Methods" and "Method interface"): SRO.solver.methods.tabu.
//
//   SRO.solver.methods.tabu.run(instance, params, hooks) -> { solution, total, feasible, evals, iterations,
//       elapsedSec, stopReason, history, extra }
//
// Start. hooks.start (normalized) or construct(), then a localSearch to the nearest local optimum (not
// charged to the step budget). Given hooks.start, construct() is built and polished as well and the
// run continues from the better of the two polished plans, so the result is never worse than either
// (a contingency re-plan's adjusted old plan can keep violations no single move removes, or sit in a
// poorer basin than construct()). Then up to CFG.startTrials shaken + polished copies of it, as in a
// restart below (charged; begun only while they are expected to stay within CFG.startShare of
// params.iterations, so a small budget goes to the walk). Measured on Phase 1 windows at the default
// budget, this start burst lowered the mean gap to a 30 s iterated-local-search reference from about
// 2.0% to 1.4%: the walk then starts from a better basin.
//
// Walk. Each step samples params.neighborhood scored candidate moves with SRO.solver.neighbors
// (copy-on-write neighbor plans carrying tabu attributes adds/drops) and moves to the best ADMISSIBLE
// one, even when it is worse than the current plan. After a move its `drops` are tabu for params.tenure
// steps; a candidate is tabu when any of its `adds` is tabu. With params.aspiration a tabu candidate is
// admissible when it beats the best plan found so far. If every sampled candidate is tabu, the one whose
// tabu status ends soonest is taken (ties: lower total). Candidates that leave the cost unchanged are
// skipped while any other candidate exists: on these plans they are almost always symmetric
// rearrangements (two identical trucks trading routes, two chunks trading places at one stop), and
// taking them let the walk circle on a plateau without ever leaving it (measured: about 2/3 of the
// steps of an unfiltered walk were such zero-change moves).
//
// Restarts (params.restartAfter > 0). After that many steps in a row without a new best plan, the best
// plan is polished with localSearch (once per new best) and then shaken: CFG.restartTrials trials, each
// a ruin-and-refill of the best plan (empty 1-3 random routes, reinsert what is then deferred in a
// perturbed priority order, cheapest insertion, then the forced refill) followed by a localSearch; on
// every CFG.constructEvery-th restart the first trial is a fresh construct() with a perturbed job order
// instead. While the rally limit binds (the best plan uses maxRallyPoints rally points and defers a
// job that could only go to another one), every CFG.rallyBoundEvery-th trial shakes rally points
// instead of routes (see ruinRally): no move, route ruin or localSearch empties a whole rally point,
// so before this such windows kept deferring jobs (Immediate ones too) at 5-10x the reachable total,
// and the app's 19-sample demo window ended at 4,898-7,520 by seed (now 4,707 on every seed tried).
// A trial that beats the best plan becomes the best plan (later trials shake that one). The
// walk resumes from the best trial with an empty tabu list. The work of a restart is charged to the
// step budget as it is done (its evaluations / neighborhood, scaled by CFG.chargePerEval; no further
// trial once the budget is used up), so params.iterations bounds the total work and the run time grows
// linearly with it. Measured on Phase 1 windows, a 12-trial restart did better per unit of work than
// 1 or 6 trials (and about as well as 24).
//
// Polish. The best plan gets a final localSearch (compound refill and ruin-and-refill moves included).
// Every localSearch here runs in fixed evaluation-count chunks (CFG.lsChunk), so progress is still
// reported between chunks and the result does not depend on machine speed; a polish ends at a local
// optimum or after CFG.lsIdleChunks chunks in a row that find nothing.
//
// Limits. Stops at params.iterations ('budget'), params.timeCapSec ('time'; a small share of the cap, up
// to 2 s, is held back for the final polish, and the whole run, polish included, ends at the cap),
// hooks.shouldStop() ('stopped', no polish), or when no move applies at all ('converged'). Deterministic
// for a given params.seed whenever the run is not cut by time: SRO.util.rng only, and the clock only
// ends the run (it never steers the search).
//
// Progress. hooks.onProgress is called right after the start plan is built, when the best plan improves
// (a new best waits at most CFG.bestMinMs, so a fast descent does not post a plan every millisecond), at
// least every CFG.progressMs otherwise, and once at the end: { fraction, bestCost, currentCost,
// elapsedSec, iteration, message, best? } where `best` (the plan) is present only when it changed since
// the previous call. hooks.shouldStop and hooks.now are asked once per step (~2 ms at the default
// neighborhood; once per CFG.nbChunk candidates for a larger one) and once per localSearch chunk
// (median 26 ms, at most ~100 ms in Node on a Phase 1 window).
//
// params: SRO.solver.clampParams('tabu', params) output (missing or invalid knobs fall back to the
// defaults). A timeCapSec below the form's minimum is honored as given (MIP's short warm-start pass,
// tests). result.iterations = steps taken + start-trial and restart work charged (<= params.iterations).
// history: [{ t: seconds, best: total }], at most one point per CFG.historyMs (the last best in it).
// extra: { steps, walkEvals (candidates scored by the walk), restarts, trials (start trials included),
// startTrials, rallyTrials (trials that shook rally points), startTotal (hooks.start's total when
// given, else construct's), startFrom ('start' | 'construct': the plan the search continued from),
// tabuBest, polishGain, polishEvals, aspirations, allTabu, nullSkipped, gainBy: { start, walk, restart,
// polish } } (gainBy: how much each phase lowered the best total; the start trials count as 'restart').
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  S.methods = S.methods || {};
  const mmax = Math.max, mmin = Math.min, mabs = Math.abs, mceil = Math.ceil;
  const COST_ONLY = { costOnly: true };

  const CFG = {
    progressMs: 50,           // progress at least this often (contract: 250 ms; + one localSearch chunk, up to
                              // ~100 ms in Node, so a 2x slower browser worker still stays inside 250 ms)
    nbChunk: 250,             // a step samples its params.neighborhood moves in chunks of at most this many
    bestMinMs: 40,            // a new best plan is reported at most this long after it is found
    historyMs: 50,            // history keeps at most one point per this many ms (the last best in it)
    lsChunk: 6000,            // evaluations per localSearch chunk (median 26 ms, max ~100 ms on a Phase 1 window in Node)
    lsIdleChunks: 2,          // a polish ends after this many chunks in a row without a gain
    polishShare: 0.05,        // share of the time cap held back for the final polish ...
    polishReserveMaxMs: 2000, // ... but at most this many ms
    restartTrials: 12,        // ruin-and-refill + localSearch trials per restart
    chargePerEval: 1,         // steps charged per evaluation of restart work, x 1/neighborhood
    startTrials: 12,          // shaken + polished copies of the polished start plan before the walk (charged) ...
    startShare: 0.25,         // ... begun only while the charged work is below this share of params.iterations
    constructEvery: 3,        // every n-th restart begins with a perturbed construct() (0 = never)
    rallyEvery: 0,            // every n-th trial of a burst shakes rally points instead of routes (0 = never) ...
    rallyBoundEvery: 2        // ... every n-th while the rally limit binds (see rallyBound)
  };

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function tol(x) { return 1e-9 * mmax(1, mabs(x)); }
  // a strictly better than b (a violation-free plan always beats one with violations)
  function better(aTotal, aFeas, bTotal, bFeas) {
    if (aFeas !== bFeas) return aFeas;
    return aTotal < bTotal - tol(bTotal);
  }

  function readParams(params) {
    const p = S.clampParams('tabu', params);
    const raw = params && params.timeCapSec;
    if (typeof raw === 'number' && raw > 0 && raw < Infinity) p.timeCapSec = raw;
    return p;
  }

  // The default construct order with each job shifted by a random amount (up to a quarter of the job
  // count), so restarts try other orders while locked / Immediate jobs still tend to go first.
  function noisyOrder(instance, rng) {
    const base = S.constructOrder(instance, rng);
    const w = mmax(2, base.length / 4);
    const key = new Float64Array(instance.jobs.length);
    for (let i = 0; i < base.length; i++) key[base[i]] = i + rng() * w;
    return base.slice().sort(function (a, b) { return key[a] - key[b]; });
  }

  // sol shaken: empty 1-3 random routes, reinsert what is then deferred in a perturbed order (cheapest
  // insertion that pays), then the forced refill that keeps only chunks worth carrying.
  function ruinAndRefill(instance, sol, rng) {
    const nonEmpty = [];
    for (let r = 0; r < sol.routes.length; r++) if (sol.routes[r].visits.length) nonEmpty.push(r);
    rng.shuffle(nonEmpty);
    const k = mmin(nonEmpty.length, 1 + rng.int(3));
    const routes = sol.routes.slice();
    for (let a = 0; a < k; a++) routes[nonEmpty[a]] = { vehicle: sol.routes[nonEmpty[a]].vehicle, visits: [] };
    const ins = S.insertJobs(instance, { routes: routes }, noisyOrder(instance, rng), { rng: rng });
    const rf = S.refill(instance, ins.solution, { rng: rng });
    return { solution: rf.solution, evals: ins.evals + rf.evals };
  }

  // True when sol uses maxRallyPoints rally points and some (partly) deferred job could only be
  // delivered at a rally point it does not use: the rally limit binds.
  function rallyBound(instance, sol) {
    const P = S.prepare(instance);
    if (!(P.maxRally < Infinity)) return false;
    const ctx = S.moves.context(instance, sol);
    const used = new Uint8Array(P.nN);
    let nUsed = 0;
    for (let r = 0; r < sol.routes.length; r++) {
      const vs = sol.routes[r].visits;
      for (let v = 0; v < vs.length; v++) {
        const n = vs[v].node;
        if (P.isRally[n] && !used[n] && vs[v].jobs.length) { used[n] = 1; nUsed++; }
      }
    }
    if (nUsed < P.maxRally) return false;
    const dj = ctx.deferredJobs;
    for (let a = 0; a < dj.length; a++) {
      const cn = P.jCandNodes[dj[a]];
      for (let c = 0; c < cn.length; c++) if (P.isRally[cn[c]] && !used[cn[c]]) return true;
    }
    return false;
  }

  // sol shaken around its rally points: 1-2 random rally points it uses (pinned ones too) are closed,
  // every visit there is removed, and what is then deferred is reinserted (the jobs sol already deferred
  // first, then the rest; perturbed order, cheapest insertion, forced refill) on a copy of the instance
  // whose jobs cannot use the closed points, so the freed rally slots go to other points. Returns null
  // when sol uses no rally point. Why: when maxRallyPoints binds (pinned points, a low limit), a job
  // whose only candidates are unused rally points stays deferred until a whole rally point is emptied,
  // which no single move, route ruin or localSearch does. The plan is valid for the real instance (its
  // candidate lists are supersets of the copy's); the trial's localSearch then runs on the real one.
  function ruinRally(instance, sol, rng, closedCache) {
    const P = S.prepare(instance);
    const used = [], seen = new Uint8Array(P.nN);
    for (let r = 0; r < sol.routes.length; r++) {
      const vs = sol.routes[r].visits;
      for (let v = 0; v < vs.length; v++) {
        const n = vs[v].node;
        if (P.isRally[n] && !seen[n] && vs[v].jobs.length) { seen[n] = 1; used.push(n); }
      }
    }
    if (!used.length) return null;
    used.sort(function (a, b) { return a - b; });
    rng.shuffle(used);
    const closed = used.slice(0, mmin(used.length, 1 + rng.int(2))).sort(function (a, b) { return a - b; });
    const key = closed.join(',');
    let inst2 = closedCache.get(key);
    if (!inst2) {
      const shut = new Uint8Array(P.nN);
      for (let c = 0; c < closed.length; c++) shut[closed[c]] = 1;
      const jobs = instance.jobs.map(function (job) {
        const cs = job.candidates || [];
        for (let c = 0; c < cs.length; c++) {
          if (cs[c] && shut[cs[c].node]) return Object.assign({}, job, { candidates: cs.filter(function (x) { return !(x && shut[x.node]); }) });
        }
        return job;
      });
      inst2 = Object.assign({}, instance, { jobs: jobs });
      closedCache.set(key, inst2);
    }
    for (let c = 0; c < closed.length; c++) seen[closed[c]] = 2;
    const routes = sol.routes.map(function (rt) {
      let hit = false;
      for (let v = 0; v < rt.visits.length && !hit; v++) if (seen[rt.visits[v].node] === 2) hit = true;
      return hit ? { vehicle: rt.vehicle, visits: rt.visits.filter(function (vi) { return seen[vi.node] !== 2; }) } : rt;
    });
    // jobs sol defers go first, so they claim the freed rally slots before the moved ones do
    const waiting = new Uint8Array(P.nJ), dj = S.moves.context(instance, sol).deferredJobs;
    for (let a = 0; a < dj.length; a++) waiting[dj[a]] = 1;
    const order = noisyOrder(instance, rng);
    const first = order.filter(function (j) { return waiting[j]; }), rest = order.filter(function (j) { return !waiting[j]; });
    const ins = S.insertJobs(inst2, { routes: routes }, first.concat(rest), { rng: rng });
    const rf = S.refill(inst2, ins.solution, { rng: rng });
    return { solution: rf.solution, evals: ins.evals + rf.evals };
  }

  function run(instance, params, hooks) {
    hooks = hooks || {};
    const p = readParams(params);
    const now = typeof hooks.now === 'function' ? hooks.now : defaultNow;
    const shouldStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const rng = SRO.util.rng(p.seed);
    const t0 = now();
    const capMs = p.timeCapSec * 1000;
    const endAt = t0 + capMs;
    const searchEndAt = endAt - mmin(CFG.polishReserveMaxMs, capMs * CFG.polishShare);
    const maxIt = p.iterations, tenure = p.tenure, k = p.neighborhood, restartAfter = p.restartAfter;
    const aspiration = !!p.aspiration;

    let evals = 0, it = 0, steps = 0, restarts = 0, trials = 0, startTrials = 0, rallyTrials = 0, phase = 'start', stopReason = null, src = 'start';
    let cur = null, curTotal = Infinity, curFeas = false;
    let best = null, bestTotal = Infinity, bestFeas = false, bestChanged = false, bestPolished = false;
    let lastReport = -Infinity;
    const history = [];
    const gainBy = { start: 0, walk: 0, restart: 0, polish: 0 };
    const closedCache = new Map();                               // ruinRally's instance copies, per closed set

    function report(force) {
      if (!onProgress) return;
      const t = now();
      if (!force && t - lastReport < (bestChanged ? CFG.bestMinMs : CFG.progressMs)) return;
      lastReport = t;
      const elapsed = t - t0;
      let fraction = mmax(maxIt > 0 ? it / maxIt : 0, capMs > 0 ? elapsed / capMs : 0);
      fraction = phase === 'done' ? 1 : phase === 'polish' ? mmin(0.999, mmax(0.98, fraction)) : mmin(0.97, fraction);
      const msg = {
        fraction: fraction, bestCost: bestTotal, currentCost: phase === 'search' ? curTotal : bestTotal,
        elapsedSec: elapsed / 1000, iteration: it,
        message: phase === 'start' ? 'Tabu search: improving the start plan'
          : phase === 'search' ? 'Tabu search: step ' + it + ' of ' + maxIt + (src === 'restart' ? ' (restart ' + restarts + ')' : '')
          : phase === 'polish' ? 'Tabu search: polishing the best plan' : 'Tabu search: done'
      };
      if (bestChanged) { msg.best = best; bestChanged = false; }
      onProgress(msg);
    }
    // Takes sol as the best plan when it is better; returns true when it was.
    function offer(sol, total, feas) {
      if (best !== null && !better(total, feas, bestTotal, bestFeas)) return false;
      if (best !== null && bestFeas === feas) gainBy[src] += bestTotal - total;
      best = sol; bestTotal = total; bestFeas = feas; bestChanged = true; bestPolished = false;
      const t = (now() - t0) / 1000, last = history[history.length - 1];
      if (last && t - last.t < CFG.historyMs / 1000) last.best = total; else history.push({ t: t, best: total });
      report(false);
      return true;
    }
    function timeUp(limit) {
      if (shouldStop && shouldStop()) { stopReason = 'stopped'; return true; }
      if (now() >= limit) { stopReason = 'time'; return true; }
      return false;
    }
    // localSearch in CFG.lsChunk-evaluation chunks until a local optimum, CFG.lsIdleChunks chunks in a
    // row without a gain (done: true), `limit` or `evals` reaching evalCap (done: false); every
    // improvement is offered as the best plan.
    function polish(sol, total, feas, limit, evalCap) {
      let idle = 0, done = false;
      const cap = evalCap == null ? Infinity : evalCap;
      for (;;) {
        if (evals >= cap || timeUp(limit)) break;
        const st = {};
        const out = S.localSearch(instance, sol, { rng: rng, maxIters: mmin(CFG.lsChunk, cap - evals), timeLimitMs: mmax(1, limit - now()), stats: st });
        evals += (st.evals || 0) + 1;
        const e = S.evaluate(instance, out, COST_ONLY);
        const improved = better(e.total, e.feasible, total, feas);
        if (improved) { sol = out; total = e.total; feas = e.feasible; offer(sol, total, feas); idle = 0; } else idle++;
        report(false);
        if (st.localOptimum || idle >= CFG.lsIdleChunks) { done = true; break; }
      }
      return { solution: sol, total: total, feasible: feas, done: done };
    }

    // n shaken copies of the best plan (the first a perturbed construct() when withConstruct), each
    // polished (no further than evalCap); stops early at itCap (charge() updates the step count) or the
    // clock. With est > 0 a trial is begun only when it is expected to end within itCap (est: the
    // expected charge of a trial, then the charge of the last one). Returns the best trial (polished:
    // its polish ended at a local optimum or by the idle rule).
    function burst(n, withConstruct, charge, itCap, est, evalCap) {
      let next = null, nextTotal = Infinity, nextFeas = false, nextDone = false;
      const predict = est > 0;
      let boundOf = null, bound = false;
      for (let b = 0; b < n && !stopReason && it < itCap && (!predict || it + est <= itCap); b++) {
        const itB = it;
        let cand;
        if (b === 0 && withConstruct) {
          cand = S.construct(instance, { rng: rng, order: noisyOrder(instance, rng) });
        } else {
          if (boundOf !== best) { boundOf = best; bound = CFG.rallyBoundEvery > 0 && rallyBound(instance, best); }
          const every = bound ? CFG.rallyBoundEvery : CFG.rallyEvery;
          let rr = every > 0 && b % every === every - 1 ? ruinRally(instance, best, rng, closedCache) : null;
          if (rr) rallyTrials++; else rr = ruinAndRefill(instance, best, rng);
          cand = rr.solution; evals += rr.evals;
        }
        const ec = S.evaluate(instance, cand, COST_ONLY);
        evals++;
        offer(cand, ec.total, ec.feasible);
        const pr = polish(cand, ec.total, ec.feasible, searchEndAt, evalCap);
        trials++;
        charge();
        if (predict) est = mmax(1, it - itB);
        if (!next || better(pr.total, pr.feasible, nextTotal, nextFeas)) { next = pr.solution; nextTotal = pr.total; nextFeas = pr.feasible; nextDone = pr.done; }
      }
      return { solution: next, total: nextTotal, feasible: nextFeas, polished: nextDone };
    }

    // ---- start plan ----
    cur = hooks.start ? S.normalize(instance, hooks.start) : S.construct(instance);
    const e0 = S.evaluate(instance, cur, COST_ONLY);
    evals++;
    curTotal = e0.total; curFeas = e0.feasible;
    const startTotal = e0.total;
    let startFrom = hooks.start ? 'start' : 'construct';
    offer(cur, curTotal, curFeas);                               // the first progress call
    const evalsP = evals;
    let ps = polish(cur, curTotal, curFeas, searchEndAt);         // not charged (like construct)
    let polishCost = evals - evalsP;                              // evaluations of the kept start polish
    if (hooks.start && stopReason !== 'stopped') {
      // A given start plan (a contingency re-plan's adjusted old plan, after a road closed or a truck
      // broke down) can keep violations no single move removes (too many rally points, a closed leg on
      // several routes) or sit in a poor basin. construct() is always violation-free, so it is polished
      // too and the run continues from the better of the two polished plans: the result is never worse
      // than either. Both are polished before they are compared: a rough start plan with violations can
      // lead to a far better plan than construct() does (14,041 against 75,109 on a window with 2
      // pinned rally points and a limit of 3), and an old plan that polishes to a feasible plan can
      // still sit in a worse basin than construct() (64,975 against 50,775-64,328 on a contingency
      // window; tabu at the default budget then ended at 62,489 from it, 48,773 from construct()).
      const cs = S.construct(instance), ec = S.evaluate(instance, cs, COST_ONLY);
      evals++;
      offer(cs, ec.total, ec.feasible);
      const evalsC = evals;
      const pc = stopReason ? { solution: cs, total: ec.total, feasible: ec.feasible, done: false } : polish(cs, ec.total, ec.feasible, searchEndAt);
      if (better(pc.total, pc.feasible, ps.total, ps.feasible)) { ps = pc; startFrom = 'construct'; polishCost = evals - evalsC; }
    }
    cur = ps.solution; curTotal = ps.total; curFeas = ps.feasible;
    bestPolished = !stopReason && best === cur;
    if (CFG.startTrials > 0 && !stopReason) {
      // shaken + polished copies of the start plan, charged, all within CFG.startShare of the budget
      // (a trial's polish is cut there); the first is expected to cost about what the start polish did,
      // and none is begun that is expected to overrun, so a small budget goes to the walk
      src = 'restart';
      const evalsS = evals, perStep = CFG.chargePerEval / mmax(1, k);
      const capIt = Math.floor(CFG.startShare * maxIt);
      const sb = burst(CFG.startTrials, false, function () { it = mmin(capIt, mceil(perStep * (evals - evalsS))); },
        capIt, mmax(1, mceil(perStep * polishCost)), evalsS + capIt / perStep);
      startTrials = trials;
      if (sb.solution) {
        cur = sb.solution; curTotal = sb.total; curFeas = sb.feasible;
        if (best === cur && !stopReason) bestPolished = sb.polished;
      }
    }

    // ---- tabu walk with restarts ----
    phase = 'search'; src = 'walk';
    const tabuUntil = new Map();
    let sinceBest = 0, aspirations = 0, allTabu = 0, nullSkipped = 0, walkEvals = 0;
    while (!stopReason && it < maxIt) {
      if (timeUp(searchEndAt)) break;
      let pick = null, pickAsp = false, fallback = null, fallbackUntil = Infinity, nullPick = null, first = null, sampled = 0;
      const nullTol = tol(curTotal);
      // the k candidates are sampled in chunks of at most CFG.nbChunk (k <= nbChunk: one call, as
      // before), so a large neighborhood (up to 5000 moves, ~100 ms a step in Node) still reports progress,
      // honors shouldStop and meets the time cap within a step
      for (let left = k; left > 0;) {
        const want = mmin(left, CFG.nbChunk);
        left -= want;
        const nb = S.neighbors(instance, cur, rng, want);
        sampled += nb.length;
        if (!first && nb.length) first = nb[0];
        for (let c = 0; c < nb.length; c++) {
          const cand = nb[c];
          let until = -1;
          const adds = cand.adds;
          for (let a = 0; a < adds.length; a++) {
            const u = tabuUntil.get(adds[a]);
            if (u !== undefined && u >= it && u > until) until = u;
          }
          if (cand.feasible === curFeas && mabs(cand.total - curTotal) <= nullTol) {
            nullSkipped++;
            if (until < 0 && !nullPick) nullPick = cand;
            continue;
          }
          if (until >= 0) {
            if (aspiration && better(cand.total, cand.feasible, bestTotal, bestFeas)) {
              if (!pick || better(cand.total, cand.feasible, pick.total, pick.feasible)) { pick = cand; pickAsp = true; }
            } else if (until < fallbackUntil || (until === fallbackUntil && better(cand.total, cand.feasible, fallback.total, fallback.feasible))) {
              fallback = cand; fallbackUntil = until;
            }
            continue;
          }
          if (!pick || better(cand.total, cand.feasible, pick.total, pick.feasible)) { pick = cand; pickAsp = false; }
        }
        if (left > 0) { report(false); if (timeUp(searchEndAt)) break; }
      }
      evals += sampled; walkEvals += sampled;
      if (stopReason) break;                                       // cut inside the step: not taken
      if (!sampled) { stopReason = 'converged'; break; }          // no move applies at all
      if (pick) { if (pickAsp) aspirations++; }
      else if (fallback) { pick = fallback; allTabu++; }
      else pick = nullPick || first;                               // only zero-change moves were sampled
      cur = pick.solution; curTotal = pick.total; curFeas = pick.feasible;
      const drops = pick.drops;
      for (let d = 0; d < drops.length; d++) tabuUntil.set(drops[d], it + tenure);
      it++; steps++;
      if (offer(cur, curTotal, curFeas)) { sinceBest = 0; continue; }
      sinceBest++;
      report(false);
      if (restartAfter > 0 && sinceBest >= restartAfter && it < maxIt) {
        // intensify (polish the best plan once), then diversify (shaken copies of it, each polished)
        restarts++;
        src = 'restart';
        const evals0 = evals, it0 = it;
        const charge = function () { it = mmin(maxIt, it0 + mceil(CFG.chargePerEval * (evals - evals0) / mmax(1, k))); };
        if (!bestPolished) {
          polish(best, bestTotal, bestFeas, searchEndAt);
          bestPolished = !stopReason;
          charge();
        }
        const bt = burst(CFG.restartTrials, restarts % mmax(1, CFG.constructEvery) === 0 && CFG.constructEvery > 0, charge, maxIt, 0);
        const next = bt.solution, nextTotal = bt.total, nextFeas = bt.feasible;
        if (best === next && !stopReason) bestPolished = bt.polished;
        src = 'walk';
        if (stopReason || !next) break;
        cur = next; curTotal = nextTotal; curFeas = nextFeas;
        tabuUntil.clear();
        sinceBest = 0;
      }
    }
    if (!stopReason) stopReason = 'budget';
    const tabuBest = bestTotal;

    // ---- final polish ----
    phase = 'polish'; src = 'polish';
    const polishFrom = evals;
    if (stopReason !== 'stopped' && !bestPolished) {
      report(true);
      const reason = stopReason;
      stopReason = null;
      polish(best, bestTotal, bestFeas, endAt);
      stopReason = stopReason || reason;
    }
    const polishEvals = evals - polishFrom;

    phase = 'done';
    const fin = S.evaluate(instance, best, COST_ONLY);
    const elapsedSec = (now() - t0) / 1000;
    const lastH = history[history.length - 1];
    if (!lastH || lastH.best !== fin.total) history.push({ t: elapsedSec, best: fin.total });
    report(true);
    return {
      solution: best, total: fin.total, feasible: fin.feasible, evals: evals, iterations: it,
      elapsedSec: elapsedSec, stopReason: stopReason, history: history,
      extra: {
        steps: steps, walkEvals: walkEvals, restarts: restarts, trials: trials, startTrials: startTrials, rallyTrials: rallyTrials, startTotal: startTotal, startFrom: startFrom, tabuBest: tabuBest,
        polishGain: tabuBest - fin.total, polishEvals: polishEvals, aspirations: aspirations, allTabu: allTabu,
        nullSkipped: nullSkipped, gainBy: gainBy
      }
    };
  }

  // _cfg: the internal constants above (tests and tuning experiments only; not planner knobs)
  S.methods.tabu = { key: 'tabu', label: (S.METHOD_LABELS && S.METHOD_LABELS.tabu) || 'Tabu search', run: run, _cfg: CFG };
})(typeof self !== 'undefined' ? self : globalThis);
