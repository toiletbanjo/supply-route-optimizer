// Greedy insertion construction: the internal start plan every method begins from (DESIGN.md section 7),
// plus the insertion helpers local search reuses.
//
// SRO.solver.construct(instance, opts) -> normalized solution (one route per vehicle, routes[i].vehicle === i)
//   opts.rng     seeded RNG (SRO.util.rng) for tie-breaks among equal jobs/options; default deterministic
//   opts.order   explicit job order (array of job indexes) instead of the default sort
//   opts.repair  false skips the refill pass described below (default true)
//
// Jobs are taken locked-first, then tier (Immediate first), deadline (earliest first), class rank
// (III first). For each job the cheapest insertion is chosen over: joining an existing visit at one of
// its candidate nodes, or a new visit at any candidate node and any position of any compatible truck
// (type, lock, free capacity). A job larger than the free room goes in capacity-sized chunks, repeatedly,
// until it is all placed or nothing helps. Each option is scored with evaluate() (total cost, so lateness
// downstream, platoon trips and deferral all count) and kept only when it lowers the total and leaves
// the plan violation-free; otherwise the remainder stays deferred. Ties prefer joining an existing visit
// (batching), then pinned rally points, then the platoon's hint. A new rally node is only opened while
// the count stays within maxRallyPoints, with room held back for pinned rally points some job could use.
//
// Refill pass: a lone job can cost more to carry than to defer while two together are cheaper (one
// truck's fixed cost shared). So construct then tries refill(): insert every deferred job at its
// cheapest feasible place even when that alone costs more, drop any chunk that is not worth carrying,
// and keep the result only if the total went down.
//
// Every accepted step is violation-free and the empty plan is violation-free, so the result always is.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  // Local aliases: global lookups are slow inside Node vm contexts (tests) and cost nothing here.
  const INF = Infinity, mmax = Math.max, mmin = Math.min, mabs = Math.abs;
  const F64 = Float64Array, I32 = Int32Array, U8 = Uint8Array;
  const COST_ONLY = { costOnly: true };

  function tol(x) { return 1e-9 * mmax(1, mabs(x)); }

  function jobOrder(P, rng, only) {
    const idx = [];
    for (let j = 0; j < P.nJ; j++) if (!only || only[j]) idx.push(j);
    const tie = new F64(P.nJ);
    for (let j = 0; j < P.nJ; j++) tie[j] = rng ? rng() : j;
    idx.sort(function (a, b) {
      const la = P.jLockV[a] >= 0 ? 0 : 1, lb = P.jLockV[b] >= 0 ? 0 : 1;
      if (la !== lb) return la - lb;
      if (P.jTier[a] !== P.jTier[b]) return P.jTier[b] - P.jTier[a];
      const da = P.jDeadline[a], db = P.jDeadline[b];
      if (da !== db) return da < db ? -1 : 1;
      if (P.jClass[a] !== P.jClass[b]) return P.jClass[a] - P.jClass[b];
      return tie[a] - tie[b];
    });
    return idx;
  }
  // The default construction order (locked, tier desc, deadline asc, class asc, then index or rng).
  S.constructOrder = function (instance, rng) { return jobOrder(S.prepare(instance), rng || null, null); };

  function addToVisit(routes, r, s, j, q) {
    const out = routes.slice();
    const R = { vehicle: routes[r].vehicle, visits: routes[r].visits.slice() };
    const old = R.visits[s];
    const jobs = old.jobs.slice();
    let found = false;
    for (let i = 0; i < jobs.length; i++) if (jobs[i].job === j) { jobs[i] = { job: j, qty: jobs[i].qty + q }; found = true; break; }
    if (!found) jobs.push({ job: j, qty: q });
    R.visits[s] = { node: old.node, jobs: jobs };
    out[r] = R;
    return out;
  }
  function insertVisit(routes, r, p, n, j, q) {
    const out = routes.slice();
    const R = { vehicle: routes[r].vehicle, visits: routes[r].visits.slice() };
    R.visits.splice(p, 0, { node: n, jobs: [{ job: j, qty: q }] });
    out[r] = R;
    return out;
  }

  // Inserts the undelivered remainder of each job in `order` into sol (cheapest feasible insertion,
  // capacity-sized chunks). force: accept the best feasible insertion even when it raises the total.
  // Returns { solution, total, evals }. sol is not modified.
  function insertJobs(instance, P, sol, order, opts) {
    const nN = P.nN;
    const rng = opts.rng || null, force = !!opts.force;
    const maxEvals = opts.maxEvals != null ? opts.maxEvals : INF;
    let routes = sol.routes;
    let cur = S.evaluate(instance, sol, COST_ONLY).total;
    let evals = 1;
    // state from the starting solution
    const load = new F64(P.nV), delivered = new F64(P.nJ), rallyVisits = new I32(nN);
    let rallyUsed = 0;
    for (let r = 0; r < routes.length; r++) {
      const v = routes[r].vehicle, vs = routes[r].visits;
      for (let s = 0; s < vs.length; s++) {
        if (P.isRally[vs[s].node] && rallyVisits[vs[s].node]++ === 0) rallyUsed++;
        for (let c = 0; c < vs[s].jobs.length; c++) {
          const ch = vs[s].jobs[c];
          if (v >= 0 && v < P.nV) load[v] += ch.qty;
          if (ch.job >= 0 && ch.job < P.nJ) delivered[ch.job] += ch.qty;
        }
      }
    }
    // pinned rally nodes some job could use and that are not open yet: their slots are held back
    const pinnedReach = new U8(nN);
    let pinnedFree = 0;
    for (let n = 0; n < nN; n++) {
      if (!P.pinned[n] || !P.isRally[n] || P.banned[n] || rallyVisits[n] > 0) continue;
      for (let j = 0; j < P.nJ; j++) if (P.cand[j * nN + n] >= 0) { pinnedReach[n] = 1; pinnedFree++; break; }
    }

    for (let oi = 0; oi < order.length && evals < maxEvals; oi++) {
      const j = order[oi];
      if (!(j >= 0 && j < P.nJ)) continue;
      const cands = P.jCandNodes[j];
      let remaining = P.jQty[j] - delivered[j];
      if (!cands.length) continue;
      let guard = 0;
      while (remaining > P.jEps[j] && guard++ < 1000 && evals < maxEvals) {
        let best = null, bestTotal = INF, bestPref = INF;
        for (let r = 0; r < routes.length; r++) {
          const v = routes[r].vehicle;
          if (!(v >= 0 && v < P.nV) || P.vFuel[v] !== P.jFuel[j]) continue;
          if (P.jLockV[j] !== -1 && P.jLockV[j] !== v) continue;
          const free = P.vCap[v] - load[v];
          if (free <= P.jEps[j]) continue;
          const q = mmin(remaining, free);
          const visits = routes[r].visits;
          const consider = function (newRoutes, pref, join, node) {
            const e = S.evaluate(instance, { routes: newRoutes }, COST_ONLY);
            evals++;
            if (!e.feasible) return;
            const t = tol(bestTotal);
            let pr = pref;
            if (rng) pr += rng() * 0.5;                  // random tie-break inside a preference class
            if (e.total < bestTotal - t || (e.total <= bestTotal + t && pr < bestPref)) {
              best = { routes: newRoutes, q: q, v: v, join: join, node: node };
              bestTotal = e.total; bestPref = pr;
            }
          };
          // join an existing visit (batching)
          for (let s = 0; s < visits.length; s++) {
            const n = visits[s].node;
            if (P.cand[j * nN + n] < 0) continue;
            consider(addToVisit(routes, r, s, j, q), 0, true, n);
          }
          // open a new visit
          for (let c = 0; c < cands.length; c++) {
            const n = cands[c];
            if (P.isRally[n] && rallyVisits[n] === 0) {
              const reserve = pinnedFree - (pinnedReach[n] ? 1 : 0);
              if (rallyUsed + 1 + reserve > P.maxRally) continue;
            }
            const cd = instance.jobs[j].candidates[P.cand[j * nN + n]];
            const pref = 1 + (P.pinned[n] ? 0 : 1) + (cd && cd.hint ? 0 : 1);
            for (let p = 0; p <= visits.length; p++) consider(insertVisit(routes, r, p, n, j, q), pref, false, n);
          }
        }
        if (!best) break;
        if (!force && !(bestTotal < cur - tol(cur))) break;
        routes = best.routes;
        cur = bestTotal;
        load[best.v] += best.q;
        delivered[j] += best.q;
        remaining -= best.q;
        if (!best.join && P.isRally[best.node] && rallyVisits[best.node]++ === 0) {
          rallyUsed++;
          if (pinnedReach[best.node]) { pinnedReach[best.node] = 0; pinnedFree--; }
        }
      }
    }
    return { solution: { routes: routes }, total: cur, evals: evals };
  }

  // Repeatedly defers any whole chunk whose removal lowers the total (first improvement).
  // Returns { solution, total, evals }.
  function dropUnprofitable(instance, P, sol, maxEvals) {
    let routes = sol.routes;
    let e0 = S.evaluate(instance, sol, COST_ONLY);
    let cur = e0.total, feas = e0.feasible, evals = 1;
    const lim = maxEvals != null ? maxEvals : INF;
    let improved = true;
    while (improved && evals < lim) {
      improved = false;
      scan:
      for (let r = 0; r < routes.length; r++) {
        const vs = routes[r].visits;
        for (let s = 0; s < vs.length; s++) {
          for (let c = 0; c < vs[s].jobs.length; c++) {
            const out = routes.slice();
            const R = { vehicle: routes[r].vehicle, visits: vs.slice() };
            const jobs = vs[s].jobs.slice(); jobs.splice(c, 1);
            if (jobs.length) R.visits[s] = { node: vs[s].node, jobs: jobs }; else R.visits.splice(s, 1);
            out[r] = R;
            const e = S.evaluate(instance, { routes: out }, COST_ONLY);
            evals++;
            if (e.total < cur - tol(cur) && (e.feasible || !feas)) {
              routes = out; cur = e.total; feas = e.feasible; improved = true;
              break scan;
            }
            if (evals >= lim) break scan;
          }
        }
      }
    }
    return { solution: { routes: routes }, total: cur, evals: evals };
  }

  S.construct = function (instance, opts) {
    opts = opts || {};
    const P = S.prepare(instance);
    const rng = opts.rng || null;
    const order = Array.isArray(opts.order) ? opts.order.slice() : jobOrder(P, rng, null);
    let res = insertJobs(instance, P, S.emptySolution(instance), order, { rng: rng });
    if (opts.repair !== false) {
      const r2 = S.refill(instance, res.solution, { rng: rng });
      if (r2.total < res.total - tol(res.total)) res = r2;
    }
    return res.solution;
  };

  // Greedy insertion of the undelivered part of `jobs` (default: every job, construct order) into sol.
  // opts: { rng, force, maxEvals }. Returns { solution, total, evals }; sol is not modified. A sol that
  // is not normalized (e.g. { routes: [] }) is normalized first, so every truck can take work.
  S.insertJobs = function (instance, sol, jobs, opts) {
    const P = S.prepare(instance);
    if (!S.isNormalized(instance, sol)) sol = S.normalize(instance, sol);
    const order = jobs || jobOrder(P, (opts && opts.rng) || null, null);
    return insertJobs(instance, P, sol, order, opts || {});
  };

  // Refill: forced insertion of every (partly) deferred job, then drop chunks not worth carrying.
  // Returns { solution, total, evals } for the better of sol and the refilled plan (never worse; a
  // violation-free sol stays violation-free). opts: { rng, maxEvals }. A sol that is not normalized
  // is normalized first (when that does not make it worse).
  S.refill = function (instance, sol, opts) {
    opts = opts || {};
    const P = S.prepare(instance);
    let base = S.evaluate(instance, sol, COST_ONLY);
    if (!S.isNormalized(instance, sol)) {
      // work on the normalized shape (one route per truck); keep the input if normalizing hurt it
      const ns = S.normalize(instance, sol), en = S.evaluate(instance, ns, COST_ONLY);
      if (!(en.total <= base.total && (en.feasible || !base.feasible))) return { solution: sol, total: base.total, evals: 2 };
      sol = ns; base = en;
    }
    const delivered = new F64(P.nJ);
    const routes = sol.routes || [];
    for (let r = 0; r < routes.length; r++) for (let s = 0; s < routes[r].visits.length; s++) {
      const js = routes[r].visits[s].jobs;
      for (let c = 0; c < js.length; c++) if (js[c].job >= 0 && js[c].job < P.nJ) delivered[js[c].job] += js[c].qty;
    }
    const only = new U8(P.nJ);
    let any = false;
    for (let j = 0; j < P.nJ; j++) if (P.jQty[j] - delivered[j] > P.jEps[j] && P.jCandNodes[j].length) { only[j] = 1; any = true; }
    if (!any) return { solution: sol, total: base.total, evals: 1 };
    const maxEvals = opts.maxEvals != null ? opts.maxEvals : INF;
    const a = insertJobs(instance, P, sol, jobOrder(P, opts.rng || null, only), { rng: opts.rng || null, force: true, maxEvals: maxEvals });
    const b = dropUnprofitable(instance, P, a.solution, maxEvals - a.evals);
    const evals = 1 + a.evals + b.evals;
    const e = S.evaluate(instance, b.solution, COST_ONLY);
    if (e.total < base.total - tol(base.total) && (e.feasible || !base.feasible)) return { solution: b.solution, total: e.total, evals: evals };
    return { solution: sol, total: base.total, evals: evals };
  };
})(typeof self !== 'undefined' ? self : globalThis);
