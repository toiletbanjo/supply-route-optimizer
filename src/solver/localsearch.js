// Shared move library, neighbor sampling and first-improvement local search (DESIGN.md section 7).
// Used by tabu (neighbors + attributes), SA (neighbors), ACO (localSearch on the best ant) and polishing.
//
// Solutions are treated as IMMUTABLE. Moves are copy-on-write: building a move copies only the routes
// array, the touched route(s), and the touched visit(s); everything else is shared with the input.
// So keep a solution by reference safely; use SRO.solver.cloneSolution before mutating one yourself.
// Moves assume a normalized solution (routes[i].vehicle === i, as construct() returns; see
// SRO.solver.normalize); they never create empty visits or zero-quantity chunks.
//
// Move = plain object { type, ...index fields } (indexes refer to the solution it was generated from):
//   relocate   { r1, v1, c1, q, r2, v2, p2, n2 }  move q of chunk (r1,v1,c1) to existing visit (r2,v2), or
//                                                 when v2 = -1 to a new visit at node n2, position p2 of route r2
//   split      same fields as relocate, q < chunk qty (part of a chunk to another visit / truck)
//   insert     { j, q, r2, v2, p2, n2 }           deliver q more of job j (partly deferred) at a target as above
//   defer      { r1, v1, c1, q }                  drop q of a chunk (it becomes deferred)
//   replace    { r1, v1, c1, j, q, v2, p2, n2 }   drop chunk (r1,v1,c1) and use the room in route r1 for
//                                                 deferred job j (existing visit v2 or new visit n2 at p2)
//   swap       { r1, v1, c1, r2, v2, c2 }         exchange two whole chunks between visits
//   twoOpt     { r, i, k }                        reverse visits i..k of route r
//   orOpt      { r1, i, len, r2, p }              move visits i..i+len-1 to position p of route r2 (for r1 = r2,
//                                                 p indexes the route after the segment is taken out)
//   changeNode { r, v, n }                        move every chunk of a visit to node n (a common candidate)
//   merge      { r1, v1, r2, v2 }                 fold visit (r2,v2) into visit (r1,v1) at the same node
//   cross      { r1, i, r2, k }                   exchange route tails: r1 = r1[0..i) + r2[k..), r2 = r2[0..k) + r1[i..)
//   exchange   { r1, v1, r2, v2 }                 swap the positions of two whole visits
//   moveRally  { u, w }                           move every visit at rally node u to rally node w, a
//                                                 candidate of every job there (localSearch sweeps only,
//                                                 swept last and only while the plan uses maxRallyPoints
//                                                 rally points; never sampled, so the walks' move mix is
//                                                 unchanged)
//
// Tabu attributes (set by moves.describe / neighbors): move.adds and move.drops are lists of strings
//   'j<job>v<vehicle>n<node>'  job delivered by vehicle at node      'j<job>d'  job (partly) deferred
//   'v<vehicle>e<a>-<b>'       vehicle drives node a -> node b (route-order moves)
// move.sig = adds[0] (the primary attribute), move.key = unique text of the move.
// Suggested rule: after applying a move, make its `drops` tabu for `tenure` iterations; a candidate
// is tabu when any of its `adds` is tabu (aspiration may override).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  // Local aliases: global lookups are slow inside Node vm contexts (tests) and cost nothing here.
  const mmax = Math.max, mmin = Math.min, mabs = Math.abs, mround = Math.round;
  const isArray = Array.isArray, F64 = Float64Array, I32 = Int32Array;
  const M = S.moves = S.moves || {};
  const COST_ONLY = { costOnly: true };
  const EMPTY = [];
  const FRACTIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const PIN_TRIES = 1;            // pin repairs tried per localSearch end phase while a pin gets nothing
  const MIN_SHARE = 0.1;          // smallest new chunk a random move makes by filling a truck's last room (share of the job; see sliverOf)

  M.TYPES = ['relocate', 'split', 'insert', 'defer', 'replace', 'swap', 'twoOpt', 'orOpt', 'changeNode', 'merge', 'cross', 'exchange'];
  M.WEIGHTS = { relocate: 22, split: 6, insert: 12, defer: 3, replace: 6, swap: 12, twoOpt: 8, orOpt: 10, changeNode: 10, merge: 5, cross: 6, exchange: 6 };
  M.SWEEP_TYPES = ['relocate', 'insert', 'replace', 'swap', 'twoOpt', 'orOpt', 'changeNode', 'merge', 'cross', 'exchange', 'defer'];
  // swept after SWEEP_TYPES, outside their shuffle, so the random stream (and so every search on a plan
  // below the rally limit, where moveRally enumerates nothing) is the same as without it
  M.SWEEP_LAST = ['moveRally'];

  // ---- copy-on-write helpers ---------------------------------------------------------------------
  function cr(route) { return { vehicle: route.vehicle, visits: route.visits.slice() }; }
  function addQty(jobs, j, q) {
    const out = jobs.slice();
    for (let i = 0; i < out.length; i++) if (out[i].job === j) { out[i] = { job: j, qty: out[i].qty + q }; return out; }
    out.push({ job: j, qty: q });
    return out;
  }
  function removeQty(P, jobs, c, q) {
    const ch = jobs[c], out = jobs.slice();
    if (ch.qty - q <= P.jEps[ch.job]) out.splice(c, 1); else out[c] = { job: ch.job, qty: ch.qty - q };
    return out;
  }
  function okR(routes, r) { return r >= 0 && r < routes.length && (r | 0) === r && !!routes[r] && isArray(routes[r].visits); }
  function visitAt(routes, r, s) { return okR(routes, r) && s >= 0 && (s | 0) === s ? routes[r].visits[s] || null : null; }
  function okNode(P, n) { return n >= 0 && n < P.nN && (n | 0) === n; }
  function jobsLoad(jobs) { let s = 0; for (let i = 0; i < jobs.length; i++) s += jobs[i].qty; return s; }

  // ---- builders: (P, routes, move) -> new routes array, or null when the move does not apply --------
  const BUILD = {};
  BUILD.relocate = function (P, routes, m) {
    const src = visitAt(routes, m.r1, m.v1);
    if (!src) return null;
    const ch = src.jobs[m.c1];
    if (!ch || !(m.q > 0) || m.q > ch.qty + P.jEps[ch.job] || !okR(routes, m.r2)) return null;
    const q = mmin(m.q, ch.qty);
    const same = m.r1 === m.r2;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const R2 = same ? R1 : cr(routes[m.r2]); out[m.r2] = R2;
    let v1 = m.v1;
    if (m.v2 >= 0) {
      if (same && m.v2 === m.v1) return null;
      const tv = R2.visits[m.v2];
      if (!tv) return null;
      R2.visits[m.v2] = { node: tv.node, jobs: addQty(tv.jobs, ch.job, q) };
    } else {
      if (!(m.p2 >= 0 && m.p2 <= R2.visits.length) || !okNode(P, m.n2)) return null;
      R2.visits.splice(m.p2, 0, { node: m.n2, jobs: [{ job: ch.job, qty: q }] });
      if (same && m.p2 <= v1) v1++;
    }
    const nj = removeQty(P, src.jobs, m.c1, q);
    if (nj.length) R1.visits[v1] = { node: src.node, jobs: nj }; else R1.visits.splice(v1, 1);
    return out;
  };
  BUILD.split = BUILD.relocate;
  BUILD.insert = function (P, routes, m) {
    if (!(m.j >= 0 && m.j < P.nJ) || !(m.q > 0) || !okR(routes, m.r2)) return null;
    const out = routes.slice();
    const R2 = cr(routes[m.r2]); out[m.r2] = R2;
    if (m.v2 >= 0) {
      const tv = R2.visits[m.v2];
      if (!tv) return null;
      R2.visits[m.v2] = { node: tv.node, jobs: addQty(tv.jobs, m.j, m.q) };
    } else {
      if (!(m.p2 >= 0 && m.p2 <= R2.visits.length) || !okNode(P, m.n2)) return null;
      R2.visits.splice(m.p2, 0, { node: m.n2, jobs: [{ job: m.j, qty: m.q }] });
    }
    return out;
  };
  BUILD.defer = function (P, routes, m) {
    const src = visitAt(routes, m.r1, m.v1);
    if (!src) return null;
    const ch = src.jobs[m.c1];
    if (!ch || !(m.q > 0)) return null;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const nj = removeQty(P, src.jobs, m.c1, mmin(m.q, ch.qty));
    if (nj.length) R1.visits[m.v1] = { node: src.node, jobs: nj }; else R1.visits.splice(m.v1, 1);
    return out;
  };
  BUILD.replace = function (P, routes, m) {
    const src = visitAt(routes, m.r1, m.v1);
    if (!src) return null;
    const ch = src.jobs[m.c1];
    if (!ch || ch.job === m.j || !(m.j >= 0 && m.j < P.nJ) || !(m.q > 0)) return null;
    const out = routes.slice();
    const R = cr(routes[m.r1]); out[m.r1] = R;
    let v1 = m.v1;
    if (m.v2 === v1) {
      const jobs = src.jobs.slice(); jobs.splice(m.c1, 1);
      R.visits[v1] = { node: src.node, jobs: addQty(jobs, m.j, m.q) };
      return out;
    }
    if (m.v2 >= 0) {
      const tv = R.visits[m.v2];
      if (!tv) return null;
      R.visits[m.v2] = { node: tv.node, jobs: addQty(tv.jobs, m.j, m.q) };
    } else {
      if (!(m.p2 >= 0 && m.p2 <= R.visits.length) || !okNode(P, m.n2)) return null;
      R.visits.splice(m.p2, 0, { node: m.n2, jobs: [{ job: m.j, qty: m.q }] });
      if (m.p2 <= v1) v1++;
    }
    const nj = src.jobs.slice(); nj.splice(m.c1, 1);
    if (nj.length) R.visits[v1] = { node: src.node, jobs: nj }; else R.visits.splice(v1, 1);
    return out;
  };
  BUILD.swap = function (P, routes, m) {
    const a = visitAt(routes, m.r1, m.v1), b = visitAt(routes, m.r2, m.v2);
    if (!a || !b || (m.r1 === m.r2 && m.v1 === m.v2)) return null;
    const ca = a.jobs[m.c1], cb = b.jobs[m.c2];
    if (!ca || !cb || ca.job === cb.job) return null;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const R2 = m.r1 === m.r2 ? R1 : cr(routes[m.r2]); out[m.r2] = R2;
    const ja = a.jobs.slice(); ja.splice(m.c1, 1);
    const jb = b.jobs.slice(); jb.splice(m.c2, 1);
    R1.visits[m.v1] = { node: a.node, jobs: addQty(ja, cb.job, cb.qty) };
    R2.visits[m.v2] = { node: b.node, jobs: addQty(jb, ca.job, ca.qty) };
    return out;
  };
  BUILD.twoOpt = function (P, routes, m) {
    if (!okR(routes, m.r)) return null;
    const L = routes[m.r].visits.length;
    if (!(m.i >= 0 && m.i < m.k && m.k < L)) return null;
    const out = routes.slice();
    const R = cr(routes[m.r]); out[m.r] = R;
    for (let a = m.i, b = m.k; a < b; a++, b--) { const t = R.visits[a]; R.visits[a] = R.visits[b]; R.visits[b] = t; }
    return out;
  };
  BUILD.orOpt = function (P, routes, m) {
    if (!okR(routes, m.r1) || !okR(routes, m.r2)) return null;
    const L1 = routes[m.r1].visits.length;
    if (!(m.len >= 1 && m.i >= 0 && m.i + m.len <= L1)) return null;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const seg = R1.visits.splice(m.i, m.len);
    const R2 = m.r1 === m.r2 ? R1 : cr(routes[m.r2]); out[m.r2] = R2;
    if (!(m.p >= 0 && m.p <= R2.visits.length)) return null;
    if (m.r1 === m.r2 && m.p === m.i) return null;
    for (let x = 0; x < seg.length; x++) R2.visits.splice(m.p + x, 0, seg[x]);
    return out;
  };
  BUILD.changeNode = function (P, routes, m) {
    const vi = visitAt(routes, m.r, m.v);
    if (!vi || !okNode(P, m.n) || vi.node === m.n) return null;
    const out = routes.slice();
    const R = cr(routes[m.r]); out[m.r] = R;
    R.visits[m.v] = { node: m.n, jobs: vi.jobs };
    return out;
  };
  BUILD.merge = function (P, routes, m) {
    const tgt = visitAt(routes, m.r1, m.v1), src = visitAt(routes, m.r2, m.v2);
    if (!tgt || !src || (m.r1 === m.r2 && m.v1 === m.v2) || tgt.node !== src.node) return null;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const R2 = m.r1 === m.r2 ? R1 : cr(routes[m.r2]); out[m.r2] = R2;
    let jobs = tgt.jobs;
    for (let i = 0; i < src.jobs.length; i++) jobs = addQty(jobs, src.jobs[i].job, src.jobs[i].qty);
    R1.visits[m.v1] = { node: tgt.node, jobs: jobs };
    R2.visits.splice(m.v2, 1);
    return out;
  };
  BUILD.cross = function (P, routes, m) {
    if (!okR(routes, m.r1) || !okR(routes, m.r2) || m.r1 === m.r2) return null;
    const A = routes[m.r1].visits, B = routes[m.r2].visits;
    if (!(m.i >= 0 && m.i <= A.length && m.k >= 0 && m.k <= B.length)) return null;
    if (m.i === A.length && m.k === B.length) return null;
    const out = routes.slice();
    out[m.r1] = { vehicle: routes[m.r1].vehicle, visits: A.slice(0, m.i).concat(B.slice(m.k)) };
    out[m.r2] = { vehicle: routes[m.r2].vehicle, visits: B.slice(0, m.k).concat(A.slice(m.i)) };
    return out;
  };
  BUILD.exchange = function (P, routes, m) {
    const a = visitAt(routes, m.r1, m.v1), b = visitAt(routes, m.r2, m.v2);
    if (!a || !b || (m.r1 === m.r2 && m.v1 === m.v2)) return null;
    const out = routes.slice();
    const R1 = cr(routes[m.r1]); out[m.r1] = R1;
    const R2 = m.r1 === m.r2 ? R1 : cr(routes[m.r2]); out[m.r2] = R2;
    R1.visits[m.v1] = b; R2.visits[m.v2] = a;
    return out;
  };

  // Every visit at rally node u goes to w. With w unused the rally count stays the same, so this trades
  // a whole rally point (changeNode cannot while another truck still stops at u and the limit binds);
  // with w in use it frees a rally slot.
  BUILD.moveRally = function (P, routes, m) {
    if (!okNode(P, m.u) || !okNode(P, m.w) || m.u === m.w) return null;
    let out = null;
    for (let r = 0; r < routes.length; r++) {
      const vs = routes[r].visits;
      let R = null;
      for (let s = 0; s < vs.length; s++) {
        if (vs[s].node !== m.u) continue;
        if (!out) out = routes.slice();
        if (!R) { R = cr(routes[r]); out[r] = R; }
        R.visits[s] = { node: m.w, jobs: vs[s].jobs };
      }
    }
    return out;
  };

  function build(P, routes, m) {
    const f = m && BUILD[m.type];
    return f ? f(P, routes, m) : null;
  }
  // New routes array for `move` applied to sol (sol untouched), or null.
  M.build = function (instance, sol, move) { return build(S.prepare(instance), (sol && sol.routes) || EMPTY, move); };
  // New solution object for `move` applied to sol (sol untouched), or null.
  M.result = function (instance, sol, move) { const r = M.build(instance, sol, move); return r ? { routes: r } : null; };
  // Applies `move` to sol in place (sol.routes is replaced; no route/visit object is mutated) and
  // returns an undo token, or null when the move does not apply.
  M.apply = function (instance, sol, move) {
    const r = M.build(instance, sol, move);
    if (!r) return null;
    const token = { routes: sol.routes };
    sol.routes = r;
    return token;
  };
  M.undo = function (sol, token) { if (token) sol.routes = token.routes; return sol; };

  // ---- context: cheap summary of a solution used by the generators ------------------------------
  M.context = function (instance, sol) {
    const P = S.prepare(instance);
    const routes = (sol && sol.routes) || EMPTY;
    const nR = routes.length;
    const veh = new I32(nR), load = new F64(nR);
    const delivered = new F64(P.nJ), rallyUse = new I32(P.nN);
    const routeOfVeh = new I32(P.nV).fill(-1);
    let nCh = 0, nVis = 0, rallyDistinct = 0;
    for (let r = 0; r < nR; r++) {
      const vs = routes[r].visits;
      nVis += vs.length;
      for (let s = 0; s < vs.length; s++) nCh += vs[s].jobs.length;
    }
    const chR = new I32(nCh), chV = new I32(nCh), chC = new I32(nCh);
    const viR = new I32(nVis), viV = new I32(nVis);
    const routesFuel = [], routesCargo = [], openFuel = [], openCargo = [], multi = [], nonEmpty = [];
    let k = 0, kv = 0;
    for (let r = 0; r < nR; r++) {
      const v = routes[r].vehicle;
      const ok = v >= 0 && v < P.nV;
      veh[r] = ok ? v : -1;
      if (ok) {
        if (routeOfVeh[v] < 0) routeOfVeh[v] = r;
        (P.vFuel[v] ? routesFuel : routesCargo).push(r);
        if (!P.vPre[v]) (P.vFuel[v] ? openFuel : openCargo).push(r);   // routes an unlocked job may use
      }
      const vs = routes[r].visits;
      if (vs.length >= 2) multi.push(r);
      if (vs.length >= 1) nonEmpty.push(r);
      for (let s = 0; s < vs.length; s++) {
        viR[kv] = r; viV[kv] = s; kv++;
        const node = vs[s].node;
        if (P.isRally[node] && rallyUse[node]++ === 0) rallyDistinct++;
        const jobs = vs[s].jobs;
        for (let c = 0; c < jobs.length; c++) {
          chR[k] = r; chV[k] = s; chC[k] = c; k++;
          load[r] += jobs[c].qty;
          if (jobs[c].job >= 0 && jobs[c].job < P.nJ) delivered[jobs[c].job] += jobs[c].qty;
        }
      }
    }
    const deferredJobs = [];
    for (let j = 0; j < P.nJ; j++) if (P.jQty[j] - delivered[j] > P.jEps[j] && P.jCandNodes[j].length) deferredJobs.push(j);
    return {
      instance: instance, P: P, sol: sol, routes: routes, nR: nR, veh: veh, load: load, delivered: delivered,
      rallyUse: rallyUse, rallyDistinct: rallyDistinct, routeOfVeh: routeOfVeh,
      nCh: nCh, chR: chR, chV: chV, chC: chC, nVis: nVis, viR: viR, viV: viV,
      routesFuel: routesFuel, routesCargo: routesCargo, openFuel: openFuel, openCargo: openCargo, multi: multi, nonEmpty: nonEmpty, deferredJobs: deferredJobs,
      lockLists: Object.create(null)
    };
  };

  function compatRoutes(ctx, j) {
    const P = ctx.P, lk = P.jLockV[j];
    if (lk === -2) return EMPTY;
    if (lk >= 0) {
      const key = lk * 2 + P.jFuel[j];
      let l = ctx.lockLists[key];
      if (!l) {
        l = [];
        const r = ctx.routeOfVeh[lk];
        if (r >= 0 && P.vFuel[lk] === P.jFuel[j]) l.push(r);
        ctx.lockLists[key] = l;
      }
      return l;
    }
    return P.jFuel[j] ? ctx.openFuel : ctx.openCargo;
  }
  // job j may ride on route r's vehicle (type + lock; a preloaded en-route truck carries only the jobs
  // locked to it, so an unlocked job never goes on one)
  function vehOK(ctx, j, r) {
    const P = ctx.P, v = ctx.veh[r];
    if (v < 0 || P.vFuel[v] !== P.jFuel[j]) return false;
    const lk = P.jLockV[j];
    return lk === -1 ? !P.vPre[v] : lk === v;
  }
  function freeCap(ctx, r) { const v = ctx.veh[r]; return v < 0 ? 0 : ctx.P.vCap[v] - ctx.load[r]; }
  function capEps(ctx, r) { const v = ctx.veh[r]; return 1e-9 * mmax(1, v < 0 ? 1 : ctx.P.vCap[v]); }
  // May a visit at node n be added? (a new rally node only while under the limit; `freed` is a rally
  // node whose last visit the same move removes)
  function rallyOK(ctx, n, freed) {
    const P = ctx.P;
    if (!P.isRally[n] || ctx.rallyUse[n] > 0) return true;
    const d = ctx.rallyDistinct - (freed >= 0 && P.isRally[freed] && ctx.rallyUse[freed] === 1 ? 1 : 0);
    return d < P.maxRally;
  }
  function allJobsOK(ctx, jobs, r) {
    for (let i = 0; i < jobs.length; i++) if (!vehOK(ctx, jobs[i].job, r)) return false;
    return true;
  }
  function splitQty(rng, qty) {
    const f = FRACTIONS[rng.int(FRACTIONS.length)];
    if (qty >= 2) return mmax(1, mmin(qty - 1, mround(qty * f)));
    return qty * f;
  }

  // Small shares. A random move that fills a truck's last bit of room splits a job into a sliver (10 +
  // 390 gal at one node 13 h apart, 670 + 30 gal, 0.9 + 0.7 + 0.1 pallets, measured under tight
  // capacities), which the walks of tabu and SA then carry along. So pickTarget skips a target whose new
  // chunk would be under MIN_SHARE of the job (a fill below what was asked, or a split piece), unless the
  // piece joins a chunk of the job already at that visit, or no other truck that may carry the job has
  // room for MIN_SHARE of it (then only a small fill carries more). Moving or inserting all of `want` is
  // always allowed, and the sweeps (eachTarget) still take a sliver that lowers the total, EXTRA_CHUNK
  // included: rejecting those too left 50 gal of a 1,900 gal job deferred on a roomy instance, where
  // moving 50 gal of another job made room for it.
  function sliverOf(ctx, j, want, q, part) {
    const P = ctx.P, eps = P.jEps[j], minQ = MIN_SHARE * P.jQty[j];
    return q > eps && q < minQ - eps && (part || q < want - eps);
  }
  function roomElsewhere(ctx, j, rs, srcR) {
    const P = ctx.P, need = MIN_SHARE * P.jQty[j] - P.jEps[j];
    for (let a = 0; a < rs.length; a++) if (rs[a] !== srcR && freeCap(ctx, rs[a]) >= need) return true;
    return false;
  }
  function carries(vi, j) { for (let c = 0; c < vi.jobs.length; c++) if (vi.jobs[c].job === j) return true; return false; }

  // Random target for `want` of job j: { r2, v2, p2, n2, q } or null. srcR/srcV exclude the source visit;
  // freed is the source's rally node when the move empties it; part: `want` is part of a chunk (split).
  function pickTarget(ctx, rng, j, want, srcR, srcV, freed, part) {
    const P = ctx.P, rs = compatRoutes(ctx, j), cands = P.jCandNodes[j];
    if (!rs.length || !cands.length) return null;
    let room = -1;                                 // roomElsewhere, once needed
    for (let attempt = 0; attempt < 6; attempt++) {
      const r2 = rs[rng.int(rs.length)];
      let q = want;
      if (r2 !== srcR) {
        const free = freeCap(ctx, r2);
        if (free <= P.jEps[j]) continue;
        q = mmin(want, free);
      }
      let mergeOnly = false;
      if (sliverOf(ctx, j, want, q, part)) {
        if (room < 0) room = roomElsewhere(ctx, j, rs, srcR) ? 1 : 0;
        mergeOnly = room === 1;
      }
      const vs = ctx.routes[r2].visits, L = vs.length;
      if (L > 0 && (mergeOnly || rng() < 0.5)) {
        const s0 = rng.int(L);
        for (let x = 0; x < L; x++) {
          const s = (s0 + x) % L;
          if (r2 === srcR && s === srcV) continue;
          if (P.cand[j * P.nN + vs[s].node] >= 0 && (!mergeOnly || carries(vs[s], j))) return { r2: r2, v2: s, p2: -1, n2: vs[s].node, q: q };
        }
      }
      if (mergeOnly) continue;
      const c0 = rng.int(cands.length);
      for (let x = 0; x < cands.length; x++) {
        const n2 = cands[(c0 + x) % cands.length];
        if (rallyOK(ctx, n2, freed)) return { r2: r2, v2: -1, p2: rng.int(L + 1), n2: n2, q: q };
      }
    }
    return null;
  }
  // Enumerates every target for `want` of job j; f(r2, v2, p2, n2, q) returns true to stop. No
  // small-share rule here: a sweep takes a sliver only when it lowers the total (EXTRA_CHUNK included),
  // and it then often makes room for a whole job (50 gal of one job moved so another is not deferred).
  function eachTarget(ctx, j, want, srcR, srcV, freed, f) {
    const P = ctx.P, rs = compatRoutes(ctx, j), cands = P.jCandNodes[j], nN = P.nN;
    for (let a = 0; a < rs.length; a++) {
      const r2 = rs[a];
      let q = want;
      if (r2 !== srcR) {
        const free = freeCap(ctx, r2);
        if (free <= P.jEps[j]) continue;
        q = mmin(want, free);
      }
      const vs = ctx.routes[r2].visits, L = vs.length;
      for (let s = 0; s < L; s++) {
        if (r2 === srcR && s === srcV) continue;
        if (P.cand[j * nN + vs[s].node] >= 0 && f(r2, s, -1, vs[s].node, q)) return true;
      }
      for (let c = 0; c < cands.length; c++) {
        const n2 = cands[c];
        if (!rallyOK(ctx, n2, freed)) continue;
        for (let p = 0; p <= L; p++) if (f(r2, -1, p, n2, q)) return true;
      }
    }
    return false;
  }
  function freedBy(ctx, r, s, wholeVisit) {
    const vi = ctx.routes[r].visits[s];
    return wholeVisit ? vi.node : -1;
  }

  // ---- random generators: (ctx, rng) -> move | null --------------------------------------------
  const GEN = {};
  function randomChunk(ctx, rng) {
    const k = rng.int(ctx.nCh);
    return { r: ctx.chR[k], v: ctx.chV[k], c: ctx.chC[k] };
  }
  GEN.relocate = function (ctx, rng) {
    if (!ctx.nCh) return null;
    const a = randomChunk(ctx, rng);
    const vi = ctx.routes[a.r].visits[a.v], ch = vi.jobs[a.c];
    const t = pickTarget(ctx, rng, ch.job, ch.qty, a.r, a.v, freedBy(ctx, a.r, a.v, vi.jobs.length === 1));
    if (!t) return null;
    return { type: 'relocate', r1: a.r, v1: a.v, c1: a.c, q: t.q, r2: t.r2, v2: t.v2, p2: t.p2, n2: t.n2 };
  };
  GEN.split = function (ctx, rng) {
    if (!ctx.nCh) return null;
    const a = randomChunk(ctx, rng);
    const ch = ctx.routes[a.r].visits[a.v].jobs[a.c];
    if (!(ch.qty > 2 * ctx.P.jEps[ch.job])) return null;
    const t = pickTarget(ctx, rng, ch.job, splitQty(rng, ch.qty), a.r, a.v, -1, true);
    if (!t || !(t.q > 0) || t.q >= ch.qty) return null;
    // nor a sliver left behind (a split is never needed to carry more)
    if (ch.qty - t.q < MIN_SHARE * ctx.P.jQty[ch.job] - ctx.P.jEps[ch.job]) return null;
    return { type: 'split', r1: a.r, v1: a.v, c1: a.c, q: t.q, r2: t.r2, v2: t.v2, p2: t.p2, n2: t.n2 };
  };
  GEN.insert = function (ctx, rng) {
    const dj = ctx.deferredJobs;
    if (!dj.length) return null;
    const j = dj[rng.int(dj.length)];
    const rem = ctx.P.jQty[j] - ctx.delivered[j];
    const t = pickTarget(ctx, rng, j, rem, -1, -1, -1);
    if (!t) return null;
    return { type: 'insert', j: j, q: t.q, r2: t.r2, v2: t.v2, p2: t.p2, n2: t.n2 };
  };
  GEN.defer = function (ctx, rng) {
    if (!ctx.nCh) return null;
    const a = randomChunk(ctx, rng);
    const ch = ctx.routes[a.r].visits[a.v].jobs[a.c];
    const q = rng() < 0.75 || !(ch.qty > 2 * ctx.P.jEps[ch.job]) ? ch.qty : splitQty(rng, ch.qty);
    return { type: 'defer', r1: a.r, v1: a.v, c1: a.c, q: q };
  };
  GEN.replace = function (ctx, rng) {
    const dj = ctx.deferredJobs;
    if (!dj.length || !ctx.nCh) return null;
    const P = ctx.P;
    const a = randomChunk(ctx, rng);
    const vi = ctx.routes[a.r].visits[a.v], ch = vi.jobs[a.c];
    const j0 = rng.int(dj.length);
    for (let x = 0; x < dj.length; x++) {
      const j = dj[(j0 + x) % dj.length];
      if (j === ch.job || !vehOK(ctx, j, a.r)) continue;
      const room = freeCap(ctx, a.r) + ch.qty;
      const q = mmin(P.jQty[j] - ctx.delivered[j], room);
      if (!(q > P.jEps[j])) continue;
      const vs = ctx.routes[a.r].visits, L = vs.length;
      if (rng() < 0.5) {
        const s0 = rng.int(L);
        for (let y = 0; y < L; y++) {
          const s = (s0 + y) % L;
          if (P.cand[j * P.nN + vs[s].node] >= 0) return { type: 'replace', r1: a.r, v1: a.v, c1: a.c, j: j, q: q, v2: s, p2: -1, n2: vs[s].node };
        }
      }
      const cands = P.jCandNodes[j];
      const freed = vi.jobs.length === 1 ? vi.node : -1;
      const c0 = rng.int(cands.length);
      for (let y = 0; y < cands.length; y++) {
        const n2 = cands[(c0 + y) % cands.length];
        if (rallyOK(ctx, n2, freed)) return { type: 'replace', r1: a.r, v1: a.v, c1: a.c, j: j, q: q, v2: -1, p2: rng.int(L + 1), n2: n2 };
      }
    }
    return null;
  };
  function swapOK(ctx, r1, v1, c1, r2, v2, c2) {
    if (r1 === r2 && v1 === v2) return false;
    const P = ctx.P, a = ctx.routes[r1].visits[v1], b = ctx.routes[r2].visits[v2];
    const ca = a.jobs[c1], cb = b.jobs[c2];
    if (ca.job === cb.job) return false;
    if (P.cand[ca.job * P.nN + b.node] < 0 || P.cand[cb.job * P.nN + a.node] < 0) return false;
    if (r1 === r2) return true;
    if (!vehOK(ctx, ca.job, r2) || !vehOK(ctx, cb.job, r1)) return false;
    if (ctx.load[r1] - ca.qty + cb.qty > P.vCap[ctx.veh[r1]] + capEps(ctx, r1)) return false;
    if (ctx.load[r2] - cb.qty + ca.qty > P.vCap[ctx.veh[r2]] + capEps(ctx, r2)) return false;
    return true;
  }
  GEN.swap = function (ctx, rng) {
    if (ctx.nCh < 2) return null;
    const k1 = rng.int(ctx.nCh), r1 = ctx.chR[k1], v1 = ctx.chV[k1], c1 = ctx.chC[k1];
    const k0 = rng.int(ctx.nCh), lim = mmin(ctx.nCh, 64);
    for (let x = 0; x < lim; x++) {
      const k2 = (k0 + x) % ctx.nCh;
      if (k2 === k1) continue;
      const r2 = ctx.chR[k2], v2 = ctx.chV[k2], c2 = ctx.chC[k2];
      if (swapOK(ctx, r1, v1, c1, r2, v2, c2)) return { type: 'swap', r1: r1, v1: v1, c1: c1, r2: r2, v2: v2, c2: c2 };
    }
    return null;
  };
  GEN.twoOpt = function (ctx, rng) {
    if (!ctx.multi.length) return null;
    const r = ctx.multi[rng.int(ctx.multi.length)], L = ctx.routes[r].visits.length;
    const i = rng.int(L - 1), k = i + 1 + rng.int(L - 1 - i);
    return { type: 'twoOpt', r: r, i: i, k: k };
  };
  function segOK(ctx, r1, i, len, r2) {   // segment of r1 may move to r2 (type, lock, capacity)
    const vs = ctx.routes[r1].visits;
    let segLoad = 0;
    for (let s = i; s < i + len; s++) {
      if (!allJobsOK(ctx, vs[s].jobs, r2)) return false;
      segLoad += jobsLoad(vs[s].jobs);
    }
    return segLoad <= freeCap(ctx, r2) + capEps(ctx, r2);
  }
  GEN.orOpt = function (ctx, rng) {
    if (!ctx.nVis) return null;
    const kv = rng.int(ctx.nVis), r1 = ctx.viR[kv], i = ctx.viV[kv];
    const L1 = ctx.routes[r1].visits.length;
    const len = 1 + rng.int(mmin(3, L1 - i));
    const v = ctx.veh[r1];
    const same = v < 0 ? [] : (ctx.P.vFuel[v] ? ctx.routesFuel : ctx.routesCargo);
    if (rng() < 0.6 || same.length < 2) {
      if (L1 - len < 1) return null;
      let p = rng.int(L1 - len);
      if (p >= i) p++;
      return { type: 'orOpt', r1: r1, i: i, len: len, r2: r1, p: p };
    }
    const r2 = same[rng.int(same.length)];
    if (r2 === r1 || !segOK(ctx, r1, i, len, r2)) return null;
    return { type: 'orOpt', r1: r1, i: i, len: len, r2: r2, p: rng.int(ctx.routes[r2].visits.length + 1) };
  };
  function commonCands(ctx, vi) {
    const P = ctx.P, jobs = vi.jobs, out = [];
    if (!jobs.length) return out;
    const first = P.jCandNodes[jobs[0].job] || EMPTY;
    for (let a = 0; a < first.length; a++) {
      const n = first[a];
      if (n === vi.node) continue;
      let ok = true;
      for (let b = 1; b < jobs.length && ok; b++) if (P.cand[jobs[b].job * P.nN + n] < 0) ok = false;
      if (ok) out.push(n);
    }
    return out;
  }
  GEN.changeNode = function (ctx, rng) {
    if (!ctx.nVis) return null;
    const kv = rng.int(ctx.nVis), r = ctx.viR[kv], v = ctx.viV[kv];
    const vi = ctx.routes[r].visits[v];
    const cs = commonCands(ctx, vi);
    if (!cs.length) return null;
    const c0 = rng.int(cs.length);
    for (let x = 0; x < cs.length; x++) {
      const n = cs[(c0 + x) % cs.length];
      if (rallyOK(ctx, n, vi.node)) return { type: 'changeNode', r: r, v: v, n: n };
    }
    return null;
  };
  function mergeOK(ctx, r1, v1, r2, v2) {   // fold (r2,v2) into (r1,v1)
    if (r1 === r2 && v1 === v2) return false;
    const a = ctx.routes[r1].visits[v1], b = ctx.routes[r2].visits[v2];
    if (a.node !== b.node) return false;
    if (r1 === r2) return true;
    return allJobsOK(ctx, b.jobs, r1) && jobsLoad(b.jobs) <= freeCap(ctx, r1) + capEps(ctx, r1);
  }
  GEN.merge = function (ctx, rng) {
    if (ctx.nVis < 2) return null;
    const ka = rng.int(ctx.nVis), r1 = ctx.viR[ka], v1 = ctx.viV[ka];
    const node = ctx.routes[r1].visits[v1].node;
    const k0 = rng.int(ctx.nVis);
    for (let x = 0; x < ctx.nVis; x++) {
      const kb = (k0 + x) % ctx.nVis;
      if (kb === ka) continue;
      const r2 = ctx.viR[kb], v2 = ctx.viV[kb];
      if (ctx.routes[r2].visits[v2].node !== node) continue;
      const flip = rng() < 0.5;
      if (flip && mergeOK(ctx, r2, v2, r1, v1)) return { type: 'merge', r1: r2, v1: v2, r2: r1, v2: v1 };
      if (mergeOK(ctx, r1, v1, r2, v2)) return { type: 'merge', r1: r1, v1: v1, r2: r2, v2: v2 };
      if (!flip && mergeOK(ctx, r2, v2, r1, v1)) return { type: 'merge', r1: r2, v1: v2, r2: r1, v2: v1 };
    }
    return null;
  };
  function tailLoad(vs, from) { let s = 0; for (let i = from; i < vs.length; i++) s += jobsLoad(vs[i].jobs); return s; }
  function tailOK(ctx, r, from, rTo) { const vs = ctx.routes[r].visits; for (let i = from; i < vs.length; i++) if (!allJobsOK(ctx, vs[i].jobs, rTo)) return false; return true; }
  function crossOK(ctx, r1, i, r2, k) {
    const A = ctx.routes[r1].visits, B = ctx.routes[r2].visits;
    if (i === A.length && k === B.length) return false;
    if (!tailOK(ctx, r1, i, r2) || !tailOK(ctx, r2, k, r1)) return false;
    const t1 = tailLoad(A, i), t2 = tailLoad(B, k);
    const v1 = ctx.veh[r1], v2 = ctx.veh[r2];
    if (ctx.load[r1] - t1 + t2 > ctx.P.vCap[v1] + capEps(ctx, r1)) return false;
    if (ctx.load[r2] - t2 + t1 > ctx.P.vCap[v2] + capEps(ctx, r2)) return false;
    return true;
  }
  GEN.cross = function (ctx, rng) {
    if (!ctx.nonEmpty.length) return null;
    const r1 = ctx.nonEmpty[rng.int(ctx.nonEmpty.length)];
    const v = ctx.veh[r1];
    if (v < 0) return null;
    const same = ctx.P.vFuel[v] ? ctx.routesFuel : ctx.routesCargo;
    if (same.length < 2) return null;
    let r2 = same[rng.int(same.length)];
    if (r2 === r1) r2 = same[(same.indexOf(r1) + 1 + rng.int(same.length - 1)) % same.length];
    if (r2 === r1) return null;
    const i = rng.int(ctx.routes[r1].visits.length + 1), k = rng.int(ctx.routes[r2].visits.length + 1);
    return crossOK(ctx, r1, i, r2, k) ? { type: 'cross', r1: r1, i: i, r2: r2, k: k } : null;
  };
  function exchangeOK(ctx, r1, v1, r2, v2) {
    if (r1 === r2) return v1 !== v2;
    const a = ctx.routes[r1].visits[v1], b = ctx.routes[r2].visits[v2];
    if (!allJobsOK(ctx, a.jobs, r2) || !allJobsOK(ctx, b.jobs, r1)) return false;
    const la = jobsLoad(a.jobs), lb = jobsLoad(b.jobs);
    return ctx.load[r1] - la + lb <= ctx.P.vCap[ctx.veh[r1]] + capEps(ctx, r1) &&
      ctx.load[r2] - lb + la <= ctx.P.vCap[ctx.veh[r2]] + capEps(ctx, r2);
  }
  GEN.exchange = function (ctx, rng) {
    if (ctx.nVis < 2) return null;
    const ka = rng.int(ctx.nVis);
    let kb = rng.int(ctx.nVis - 1);
    if (kb >= ka) kb++;
    const r1 = ctx.viR[ka], v1 = ctx.viV[ka], r2 = ctx.viR[kb], v2 = ctx.viV[kb];
    return exchangeOK(ctx, r1, v1, r2, v2) ? { type: 'exchange', r1: r1, v1: v1, r2: r2, v2: v2 } : null;
  };

  // Random move from the weighted mix (opts.types restricts it, opts.weights overrides weights,
  // opts.ctx reuses a context built by moves.context from this same solution; after moves.apply the old
  // context is stale, so build a new one). Returns null when nothing applies after a few tries.
  M.random = function (instance, sol, rng, opts) {
    const ctx = (opts && opts.ctx) || M.context(instance, sol);
    return randomMove(ctx, rng, opts);
  };
  function randomMove(ctx, rng, opts) {
    const types = (opts && opts.types) || M.TYPES;
    const W = (opts && opts.weights) || M.WEIGHTS;
    let sum = 0;
    const w = new Array(types.length);
    for (let i = 0; i < types.length; i++) {
      let x = W[types[i]] || 0;
      if ((types[i] === 'insert' || types[i] === 'replace') && !ctx.deferredJobs.length) x = 0;
      w[i] = x; sum += x;
    }
    if (!(sum > 0)) return null;
    for (let attempt = 0; attempt < 12; attempt++) {
      let u = rng() * sum, i = 0;
      while (i < types.length - 1 && u >= w[i]) { u -= w[i]; i++; }
      const g = GEN[types[i]];
      const m = g ? g(ctx, rng) : null;
      if (m) return m;
    }
    return null;
  }

  // ---- enumerators: (ctx, cb) -> true when cb asked to stop ---------------------------------------
  const ENUM = {};
  ENUM.relocate = function (ctx, cb) {
    for (let k = 0; k < ctx.nCh; k++) {
      const r1 = ctx.chR[k], v1 = ctx.chV[k], c1 = ctx.chC[k];
      const vi = ctx.routes[r1].visits[v1], ch = vi.jobs[c1];
      const freed = vi.jobs.length === 1 ? vi.node : -1;
      const stop = eachTarget(ctx, ch.job, ch.qty, r1, v1, freed, function (r2, v2, p2, n2, q) {
        if (v2 < 0 && r2 === r1 && n2 === vi.node && vi.jobs.length === 1 && (p2 === v1 || p2 === v1 + 1)) return false;   // no-op
        return cb({ type: 'relocate', r1: r1, v1: v1, c1: c1, q: q, r2: r2, v2: v2, p2: p2, n2: n2 });
      });
      if (stop) return true;
    }
    return false;
  };
  ENUM.insert = function (ctx, cb) {
    const dj = ctx.deferredJobs;
    for (let a = 0; a < dj.length; a++) {
      const j = dj[a], rem = ctx.P.jQty[j] - ctx.delivered[j];
      if (eachTarget(ctx, j, rem, -1, -1, -1, function (r2, v2, p2, n2, q) {
        return cb({ type: 'insert', j: j, q: q, r2: r2, v2: v2, p2: p2, n2: n2 });
      })) return true;
    }
    return false;
  };
  ENUM.defer = function (ctx, cb) {
    for (let k = 0; k < ctx.nCh; k++) {
      const r1 = ctx.chR[k], v1 = ctx.chV[k], c1 = ctx.chC[k];
      if (cb({ type: 'defer', r1: r1, v1: v1, c1: c1, q: ctx.routes[r1].visits[v1].jobs[c1].qty })) return true;
    }
    return false;
  };
  ENUM.replace = function (ctx, cb) {
    const P = ctx.P, dj = ctx.deferredJobs;
    if (!dj.length) return false;
    for (let k = 0; k < ctx.nCh; k++) {
      const r1 = ctx.chR[k], v1 = ctx.chV[k], c1 = ctx.chC[k];
      const vi = ctx.routes[r1].visits[v1], ch = vi.jobs[c1];
      const room = freeCap(ctx, r1) + ch.qty;
      const freed = vi.jobs.length === 1 ? vi.node : -1;
      const vs = ctx.routes[r1].visits, L = vs.length;
      for (let a = 0; a < dj.length; a++) {
        const j = dj[a];
        if (j === ch.job || !vehOK(ctx, j, r1)) continue;
        const q = mmin(P.jQty[j] - ctx.delivered[j], room);
        if (!(q > P.jEps[j])) continue;
        for (let s = 0; s < L; s++) {
          if (P.cand[j * P.nN + vs[s].node] >= 0 && cb({ type: 'replace', r1: r1, v1: v1, c1: c1, j: j, q: q, v2: s, p2: -1, n2: vs[s].node })) return true;
        }
        const cands = P.jCandNodes[j];
        for (let c = 0; c < cands.length; c++) {
          if (!rallyOK(ctx, cands[c], freed)) continue;
          for (let p = 0; p <= L; p++) if (cb({ type: 'replace', r1: r1, v1: v1, c1: c1, j: j, q: q, v2: -1, p2: p, n2: cands[c] })) return true;
        }
      }
    }
    return false;
  };
  ENUM.swap = function (ctx, cb) {
    for (let k1 = 0; k1 < ctx.nCh; k1++) {
      for (let k2 = k1 + 1; k2 < ctx.nCh; k2++) {
        const r1 = ctx.chR[k1], v1 = ctx.chV[k1], c1 = ctx.chC[k1], r2 = ctx.chR[k2], v2 = ctx.chV[k2], c2 = ctx.chC[k2];
        if (swapOK(ctx, r1, v1, c1, r2, v2, c2) && cb({ type: 'swap', r1: r1, v1: v1, c1: c1, r2: r2, v2: v2, c2: c2 })) return true;
      }
    }
    return false;
  };
  ENUM.twoOpt = function (ctx, cb) {
    for (let a = 0; a < ctx.multi.length; a++) {
      const r = ctx.multi[a], L = ctx.routes[r].visits.length;
      for (let i = 0; i < L - 1; i++) for (let k = i + 1; k < L; k++) if (cb({ type: 'twoOpt', r: r, i: i, k: k })) return true;
    }
    return false;
  };
  ENUM.orOpt = function (ctx, cb) {
    for (let r1 = 0; r1 < ctx.nR; r1++) {
      const L1 = ctx.routes[r1].visits.length, v = ctx.veh[r1];
      if (!L1 || v < 0) continue;
      const same = ctx.P.vFuel[v] ? ctx.routesFuel : ctx.routesCargo;
      for (let i = 0; i < L1; i++) {
        for (let len = 1; len <= 3 && i + len <= L1; len++) {
          for (let p = 0; p <= L1 - len; p++) if (p !== i && cb({ type: 'orOpt', r1: r1, i: i, len: len, r2: r1, p: p })) return true;
          for (let a = 0; a < same.length; a++) {
            const r2 = same[a];
            if (r2 === r1 || !segOK(ctx, r1, i, len, r2)) continue;
            const L2 = ctx.routes[r2].visits.length;
            for (let p = 0; p <= L2; p++) if (cb({ type: 'orOpt', r1: r1, i: i, len: len, r2: r2, p: p })) return true;
          }
        }
      }
    }
    return false;
  };
  ENUM.changeNode = function (ctx, cb) {
    for (let kv = 0; kv < ctx.nVis; kv++) {
      const r = ctx.viR[kv], v = ctx.viV[kv], vi = ctx.routes[r].visits[v];
      const cs = commonCands(ctx, vi);
      for (let a = 0; a < cs.length; a++) if (rallyOK(ctx, cs[a], vi.node) && cb({ type: 'changeNode', r: r, v: v, n: cs[a] })) return true;
    }
    return false;
  };
  ENUM.merge = function (ctx, cb) {
    for (let ka = 0; ka < ctx.nVis; ka++) {
      for (let kb = 0; kb < ctx.nVis; kb++) {
        if (ka === kb) continue;
        const r1 = ctx.viR[ka], v1 = ctx.viV[ka], r2 = ctx.viR[kb], v2 = ctx.viV[kb];
        if (mergeOK(ctx, r1, v1, r2, v2) && cb({ type: 'merge', r1: r1, v1: v1, r2: r2, v2: v2 })) return true;
      }
    }
    return false;
  };
  ENUM.cross = function (ctx, cb) {
    const groups = [ctx.routesFuel, ctx.routesCargo];
    for (let g = 0; g < 2; g++) {
      const rs = groups[g];
      for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
        const r1 = rs[a], r2 = rs[b];
        const L1 = ctx.routes[r1].visits.length, L2 = ctx.routes[r2].visits.length;
        if (!L1 && !L2) continue;
        for (let i = 0; i <= L1; i++) for (let k = 0; k <= L2; k++) {
          if (crossOK(ctx, r1, i, r2, k) && cb({ type: 'cross', r1: r1, i: i, r2: r2, k: k })) return true;
        }
      }
    }
    return false;
  };
  ENUM.exchange = function (ctx, cb) {
    for (let ka = 0; ka < ctx.nVis; ka++) for (let kb = ka + 1; kb < ctx.nVis; kb++) {
      const r1 = ctx.viR[ka], v1 = ctx.viV[ka], r2 = ctx.viR[kb], v2 = ctx.viV[kb];
      if (exchangeOK(ctx, r1, v1, r2, v2) && cb({ type: 'exchange', r1: r1, v1: v1, r2: r2, v2: v2 })) return true;
    }
    return false;
  };

  ENUM.moveRally = function (ctx, cb) {
    const P = ctx.P, nN = P.nN;
    // only while the plan uses maxRallyPoints rally points: below the limit changeNode opens a new
    // point visit by visit (and sweeping this as well made every polish longer for nothing)
    if (!ctx.rallyDistinct || !(ctx.rallyDistinct >= P.maxRally)) return false;
    const done = new Uint8Array(nN);
    for (let kv = 0; kv < ctx.nVis; kv++) {
      const u = ctx.routes[ctx.viR[kv]].visits[ctx.viV[kv]].node;
      if (!P.isRally[u] || done[u]) continue;
      done[u] = 1;
      // rally nodes every job delivered at u may use
      let common = null;
      for (let k2 = kv; k2 < ctx.nVis; k2++) {
        const vi = ctx.routes[ctx.viR[k2]].visits[ctx.viV[k2]];
        if (vi.node !== u) continue;
        for (let c = 0; c < vi.jobs.length; c++) {
          const j = vi.jobs[c].job;
          if (!common) { common = []; const cn = P.jCandNodes[j]; for (let a = 0; a < cn.length; a++) if (P.isRally[cn[a]] && cn[a] !== u) common.push(cn[a]); }
          else common = common.filter(function (n) { return P.cand[j * nN + n] >= 0; });
        }
      }
      if (!common) continue;
      for (let a = 0; a < common.length; a++) if (cb({ type: 'moveRally', u: u, w: common[a] })) return true;
    }
    return false;
  };

  // Calls cb(move) for every move of the given types (default SWEEP_TYPES and SWEEP_LAST) on sol; cb
  // returns true to stop.
  M.forEach = function (instance, sol, cb, opts) {
    const ctx = (opts && opts.ctx) || M.context(instance, sol);
    const types = (opts && opts.types) || M.SWEEP_TYPES.concat(M.SWEEP_LAST);
    for (let i = 0; i < types.length; i++) {
      const f = ENUM[types[i]];
      if (f && f(ctx, cb)) return true;
    }
    return false;
  };

  // ---- tabu attributes -------------------------------------------------------------------------
  function A(j, v, n) { return 'j' + j + 'v' + v + 'n' + n; }
  function Dj(j) { return 'j' + j + 'd'; }
  function E(v, a, b) { return 'v' + v + 'e' + a + '-' + b; }
  function nodeAt(ctx, r, s) {
    const vs = ctx.routes[r].visits, v = ctx.veh[r];
    if (s < 0) return v >= 0 ? ctx.P.vStart[v] : -1;
    if (s >= vs.length) return v >= 0 ? ctx.P.vHub[v] : -1;
    return vs[s].node;
  }
  function moveKey(m) {
    switch (m.type) {
      case 'relocate': case 'split': return m.type + ':' + m.r1 + '.' + m.v1 + '.' + m.c1 + '>' + m.r2 + '.' + m.v2 + '.' + m.p2 + '.' + m.n2 + ':' + m.q;
      case 'insert': return 'insert:' + m.j + '>' + m.r2 + '.' + m.v2 + '.' + m.p2 + '.' + m.n2 + ':' + m.q;
      case 'defer': return 'defer:' + m.r1 + '.' + m.v1 + '.' + m.c1 + ':' + m.q;
      case 'replace': return 'replace:' + m.r1 + '.' + m.v1 + '.' + m.c1 + '<' + m.j + '>' + m.v2 + '.' + m.p2 + '.' + m.n2 + ':' + m.q;
      case 'swap': return 'swap:' + m.r1 + '.' + m.v1 + '.' + m.c1 + '~' + m.r2 + '.' + m.v2 + '.' + m.c2;
      case 'twoOpt': return 'twoOpt:' + m.r + '.' + m.i + '.' + m.k;
      case 'orOpt': return 'orOpt:' + m.r1 + '.' + m.i + '.' + m.len + '>' + m.r2 + '.' + m.p;
      case 'changeNode': return 'changeNode:' + m.r + '.' + m.v + '>' + m.n;
      case 'merge': return 'merge:' + m.r2 + '.' + m.v2 + '>' + m.r1 + '.' + m.v1;
      case 'cross': return 'cross:' + m.r1 + '.' + m.i + '~' + m.r2 + '.' + m.k;
      case 'exchange': return 'exchange:' + m.r1 + '.' + m.v1 + '~' + m.r2 + '.' + m.v2;
      case 'moveRally': return 'moveRally:' + m.u + '>' + m.w;
      default: return String(m.type);
    }
  }
  function describe(ctx, m) {
    const routes = ctx.routes, veh = ctx.veh;
    let adds = [], drops = [];
    switch (m.type) {
      case 'relocate': case 'split': {
        const src = routes[m.r1].visits[m.v1], j = src.jobs[m.c1].job;
        const n2 = m.v2 >= 0 ? routes[m.r2].visits[m.v2].node : m.n2;
        drops = [A(j, veh[m.r1], src.node)]; adds = [A(j, veh[m.r2], n2)];
        break;
      }
      case 'insert': {
        const n2 = m.v2 >= 0 ? routes[m.r2].visits[m.v2].node : m.n2;
        drops = [Dj(m.j)]; adds = [A(m.j, veh[m.r2], n2)];
        break;
      }
      case 'defer': {
        const src = routes[m.r1].visits[m.v1], j = src.jobs[m.c1].job;
        drops = [A(j, veh[m.r1], src.node)]; adds = [Dj(j)];
        break;
      }
      case 'replace': {
        const src = routes[m.r1].visits[m.v1], j0 = src.jobs[m.c1].job;
        const n2 = m.v2 >= 0 ? routes[m.r1].visits[m.v2].node : m.n2;
        drops = [A(j0, veh[m.r1], src.node), Dj(m.j)]; adds = [A(m.j, veh[m.r1], n2), Dj(j0)];
        break;
      }
      case 'swap': {
        const a = routes[m.r1].visits[m.v1], b = routes[m.r2].visits[m.v2];
        const ja = a.jobs[m.c1].job, jb = b.jobs[m.c2].job;
        drops = [A(ja, veh[m.r1], a.node), A(jb, veh[m.r2], b.node)];
        adds = [A(ja, veh[m.r2], b.node), A(jb, veh[m.r1], a.node)];
        break;
      }
      case 'twoOpt': {
        const vx = veh[m.r];
        const a = nodeAt(ctx, m.r, m.i - 1), b = nodeAt(ctx, m.r, m.i), c = nodeAt(ctx, m.r, m.k), d = nodeAt(ctx, m.r, m.k + 1);
        drops = [E(vx, a, b), E(vx, c, d)]; adds = [E(vx, a, c), E(vx, b, d)];
        break;
      }
      case 'orOpt': {
        const vs = routes[m.r1].visits;
        if (m.r1 === m.r2) {
          const vx = veh[m.r1], L = vs.length, i = m.i, len = m.len, p = m.p;
          const a = nodeAt(ctx, m.r1, i - 1), b = vs[i].node, c = vs[i + len - 1].node, d = nodeAt(ctx, m.r1, i + len);
          const restAt = function (x) {      // node at index x of the route without the segment
            if (x < 0) return nodeAt(ctx, m.r1, -1);
            if (x >= L - len) return nodeAt(ctx, m.r1, L);
            return vs[x < i ? x : x + len].node;
          };
          const x = restAt(p - 1), y = restAt(p);
          drops = [E(vx, a, b), E(vx, c, d), E(vx, x, y)]; adds = [E(vx, a, d), E(vx, x, b), E(vx, c, y)];
        } else {
          for (let s = m.i; s < m.i + m.len; s++) {
            const vi = vs[s];
            for (let c = 0; c < vi.jobs.length; c++) { drops.push(A(vi.jobs[c].job, veh[m.r1], vi.node)); adds.push(A(vi.jobs[c].job, veh[m.r2], vi.node)); }
          }
        }
        break;
      }
      case 'changeNode': {
        const vi = routes[m.r].visits[m.v];
        for (let c = 0; c < vi.jobs.length; c++) { drops.push(A(vi.jobs[c].job, veh[m.r], vi.node)); adds.push(A(vi.jobs[c].job, veh[m.r], m.n)); }
        break;
      }
      case 'moveRally': {
        for (let r = 0; r < routes.length; r++) {
          const vs = routes[r].visits;
          for (let v = 0; v < vs.length; v++) {
            if (vs[v].node !== m.u) continue;
            for (let c = 0; c < vs[v].jobs.length; c++) { drops.push(A(vs[v].jobs[c].job, veh[r], m.u)); adds.push(A(vs[v].jobs[c].job, veh[r], m.w)); }
          }
        }
        break;
      }
      case 'merge': {
        const src = routes[m.r2].visits[m.v2];
        if (m.r1 !== m.r2) {
          for (let c = 0; c < src.jobs.length; c++) { drops.push(A(src.jobs[c].job, veh[m.r2], src.node)); adds.push(A(src.jobs[c].job, veh[m.r1], src.node)); }
        } else {
          const vx = veh[m.r2], a = nodeAt(ctx, m.r2, m.v2 - 1), b = nodeAt(ctx, m.r2, m.v2 + 1);
          drops = [E(vx, a, src.node), E(vx, src.node, b)]; adds = [E(vx, a, b)];
        }
        break;
      }
      case 'cross': {
        const v1 = veh[m.r1], v2 = veh[m.r2];
        const a = nodeAt(ctx, m.r1, m.i - 1), b = nodeAt(ctx, m.r1, m.i), c = nodeAt(ctx, m.r2, m.k - 1), d = nodeAt(ctx, m.r2, m.k);
        drops = [E(v1, a, b), E(v2, c, d)]; adds = [E(v1, a, d), E(v2, c, b)];
        break;
      }
      case 'exchange': {
        const a = routes[m.r1].visits[m.v1], b = routes[m.r2].visits[m.v2];
        if (m.r1 !== m.r2) {
          for (let c = 0; c < a.jobs.length; c++) { drops.push(A(a.jobs[c].job, veh[m.r1], a.node)); adds.push(A(a.jobs[c].job, veh[m.r2], a.node)); }
          for (let c = 0; c < b.jobs.length; c++) { drops.push(A(b.jobs[c].job, veh[m.r2], b.node)); adds.push(A(b.jobs[c].job, veh[m.r1], b.node)); }
        } else {
          const vx = veh[m.r1], pa = nodeAt(ctx, m.r1, m.v1 - 1), pb = nodeAt(ctx, m.r2, m.v2 - 1);
          drops = [E(vx, pa, a.node), E(vx, pb, b.node)]; adds = [E(vx, pa, b.node), E(vx, pb, a.node)];
        }
        break;
      }
      default: break;
    }
    if (!adds.length) adds = [m.type];
    m.adds = adds; m.drops = drops; m.sig = adds[0]; m.key = moveKey(m);
    return m;
  }
  // Sets move.sig, move.adds, move.drops, move.key (computed against sol, before the move) and returns move.
  M.describe = function (instance, sol, move, ctx) { return describe(ctx || M.context(instance, sol), move); };

  // ---- neighbors (tabu / SA) ------------------------------------------------------------------
  // k random candidate moves on `solution`, each scored with evaluate():
  //   [{ move, total, feasible, solution, sig, adds, drops }]   (solution = the neighbor, copy-on-write)
  // opts: { types, weights } as for moves.random. May return fewer than k when few moves apply.
  // Moves assume a normalized solution: an input that is not normalized (e.g. { routes: [] }) is
  // normalized first, and the move indexes then refer to SRO.solver.normalize(instance, solution).
  S.neighbors = function (instance, solution, rng, k, opts) {
    const P = S.prepare(instance);
    if (!S.isNormalized(instance, solution)) solution = S.normalize(instance, solution);
    const ctx = M.context(instance, solution);
    const out = [];
    const n = k > 0 ? k : 1;
    let tries = 0;
    while (out.length < n && tries++ < n * 4 + 10) {
      const m = randomMove(ctx, rng, opts);
      if (!m) continue;
      const nr = build(P, ctx.routes, m);
      if (!nr) continue;
      describe(ctx, m);
      const sol = { routes: nr };
      const e = S.evaluate(instance, sol, COST_ONLY);
      out.push({ move: m, total: e.total, feasible: e.feasible, solution: sol, sig: m.sig, adds: m.adds, drops: m.drops });
    }
    return out;
  };

  // ---- rally-point compound moves (tabu and SA restarts, the end phase of every localSearch) ------
  // No single move, route ruin or refill empties a whole rally point. So while the plan uses
  // maxRallyPoints rally points, a job whose only pickup points are unused rally points stays deferred
  // and a pinned rally point the plan does not use (pinUnused each) stays unused. These moves trade
  // whole rally points.

  // Copy of instance whose jobs cannot use the `closed` nodes (sorted list) and whose job onlyJob (when
  // given) can only use onlyNode; cached per instance (while its top-level fields are the same objects)
  // and key. A plan built on the copy is valid for the real instance: its candidate lists are subsets.
  const closedCopies = typeof WeakMap === 'function' ? new WeakMap() : null;
  function closedCopy(instance, P, closed, onlyJob, onlyNode) {
    let entry = closedCopies ? closedCopies.get(instance) : null;
    if (entry) for (const f in instance) if (instance[f] !== entry.src[f]) { entry = null; break; }
    if (!entry) { entry = { src: Object.assign({}, instance), map: new Map() }; if (closedCopies) closedCopies.set(instance, entry); }
    const key = closed.join(',') + (onlyJob != null ? '|' + onlyJob + '>' + onlyNode : '');
    let inst2 = entry.map.get(key);
    if (inst2) return inst2;
    const shut = new Uint8Array(P.nN);
    for (let c = 0; c < closed.length; c++) shut[closed[c]] = 1;
    const jobs = instance.jobs.map(function (job, j) {
      const cs = job.candidates || [];
      if (j === onlyJob) return Object.assign({}, job, { candidates: cs.filter(function (x) { return x && x.node === onlyNode; }) });
      for (let c = 0; c < cs.length; c++) {
        if (cs[c] && shut[cs[c].node]) return Object.assign({}, job, { candidates: cs.filter(function (x) { return !(x && shut[x.node]); }) });
      }
      return job;
    });
    inst2 = Object.assign({}, instance, { jobs: jobs });
    entry.map.set(key, inst2);
    return inst2;
  }
  function withoutNodes(routes, shut, moved) {   // routes minus every visit at a shut node (moved[job] = 1 for their jobs)
    return routes.map(function (rt) {
      let hit = false;
      for (let v = 0; v < rt.visits.length; v++) {
        if (!shut[rt.visits[v].node]) continue;
        hit = true;
        if (moved) { const js = rt.visits[v].jobs; for (let c = 0; c < js.length; c++) moved[js[c].job] = 1; }
      }
      return hit ? { vehicle: rt.vehicle, visits: rt.visits.filter(function (vi) { return !shut[vi.node]; }) } : rt;
    });
  }

  // The default construct order with each job shifted by a random amount (up to a quarter of the job
  // count), so a shake tries another order while locked / Immediate jobs still tend to go first.
  function noisyOrder(instance, rng) {
    const base = S.constructOrder(instance, rng);
    const w = mmax(2, base.length / 4);
    const key = new F64(instance.jobs.length);
    for (let i = 0; i < base.length; i++) key[base[i]] = i + rng() * w;
    return base.slice().sort(function (a, b) { return key[a] - key[b]; });
  }
  S.noisyOrder = noisyOrder;

  // Rally points of sol: { used: [node] (ascending), share: job shares delivered at each node, atCap
  // (maxRallyPoints in use), pins: pinned rally points some job could use that get nothing, bound: at
  // the cap with an unused pin, or with a (partly) deferred job that could use a rally point sol does
  // not use }.
  S.rallyState = function (instance, sol) {
    const P = S.prepare(instance);
    const routes = (sol && sol.routes) || EMPTY;
    const seen = new Uint8Array(P.nN), got = new Uint8Array(P.nN), share = new F64(P.nN), used = [];
    for (let r = 0; r < routes.length; r++) {
      const vs = routes[r].visits;
      for (let v = 0; v < vs.length; v++) {
        const n = vs[v].node, js = vs[v].jobs;
        if (!js.length || !okNode(P, n)) continue;
        for (let c = 0; c < js.length; c++) {
          if (js[c].qty > 0) got[n] = 1;
          if (js[c].job >= 0 && js[c].job < P.nJ) share[n] += js[c].qty * P.jInvQty[js[c].job];
        }
        if (P.isRally[n] && !seen[n]) { seen[n] = 1; used.push(n); }
      }
    }
    used.sort(function (a, b) { return a - b; });
    const pins = [];
    for (let a = 0; a < P.pinNodes.length; a++) if (!got[P.pinNodes[a]]) pins.push(P.pinNodes[a]);
    const atCap = P.maxRally < Infinity && used.length >= P.maxRally;
    let bound = atCap && pins.length > 0;
    if (atCap && !bound) {
      const dj = M.context(instance, sol).deferredJobs;
      for (let a = 0; a < dj.length && !bound; a++) {
        const cn = P.jCandNodes[dj[a]];
        for (let c = 0; c < cn.length; c++) if (P.isRally[cn[c]] && !seen[cn[c]]) { bound = true; break; }
      }
    }
    return { used: used, share: share, atCap: atCap, pins: pins, bound: bound };
  };

  // sol shaken around its rally points: 1-2 random rally points it uses (pinned ones too; with `must`,
  // a rally point sol uses, that one and every other time one more) are closed, every visit there is
  // removed, and what is then deferred is reinserted (the jobs sol already deferred first, then the
  // rest; perturbed order, cheapest insertion, forced refill) on a copy of the instance whose jobs
  // cannot use the closed points, so the freed rally slots go to other points. The caller polishes the
  // result on the real instance. -> { solution, evals } or null when sol uses no rally point.
  S.ruinRally = function (instance, sol, rng, must) {
    const P = S.prepare(instance);
    let used = S.rallyState(instance, sol).used;
    if (!used.length) return null;
    let closed;
    if (must != null && used.indexOf(must) >= 0) {
      // `must` and, every other time, one more at random
      used = used.filter(function (n) { return n !== must; });
      closed = [must];
      if (used.length && rng() < 0.5) closed.push(used[rng.int(used.length)]);
      closed.sort(function (a, b) { return a - b; });
    } else {
      rng.shuffle(used);
      closed = used.slice(0, mmin(used.length, 1 + rng.int(2))).sort(function (a, b) { return a - b; });
    }
    const shut = new Uint8Array(P.nN);
    for (let c = 0; c < closed.length; c++) shut[closed[c]] = 1;
    const inst2 = closedCopy(instance, P, closed);
    const routes = withoutNodes(sol.routes, shut, null);
    // jobs sol defers go first, so they claim the freed rally slots before the moved ones do
    const waiting = new Uint8Array(P.nJ), dj = M.context(instance, sol).deferredJobs;
    for (let a = 0; a < dj.length; a++) waiting[dj[a]] = 1;
    const order = noisyOrder(instance, rng);
    const first = order.filter(function (j) { return waiting[j]; }), rest = order.filter(function (j) { return !waiting[j]; });
    const ins = S.insertJobs(inst2, { routes: routes }, first.concat(rest), { rng: rng });
    const rf = S.refill(inst2, ins.solution, { rng: rng });
    return { solution: rf.solution, evals: ins.evals + rf.evals };
  };

  // Rally swap: sol with a rally point it does not use opened, by trading one it uses when it is at
  // maxRallyPoints. The point to open: an unused pinned rally point (pin repair), else, while the limit
  // binds, a rally point some job sol defers could use (opts.pinsOnly: pins only). One job that can use
  // it is taken off the plan: one moved off the closed point when one can use it, else one of the three
  // (deferred ones, unless it is a pin) with the cheapest platoon trip to it. When sol is at the
  // limit, a rally point it uses that is not pinned is closed, every visit there removed. That job (on
  // the opened point only), the moved jobs and the jobs sol defers are then reinserted in that order
  // (cheapest insertion) on a copy of the instance whose jobs cannot use the closed point, and the
  // forced refill follows. Each rally point that could be closed is tried and the cheapest result kept:
  // the point that is cheapest to give up (its jobs fit at the points still open) is often not the
  // least-loaded one. The caller polishes the result on the real instance. opts: { rng, maxEvals,
  // pinsOnly, target (the point to open, when it is one of those) }. -> { solution, evals, opened,
  // closed (node or -1), pin (bool) } or null (nothing to open, or every rally point in use is pinned).
  S.rallySwap = function (instance, sol, opts) {
    opts = opts || {};
    const P = S.prepare(instance), nN = P.nN;
    if (opts.pinsOnly && !P.pinNodes.length) return null;
    const rng = opts.rng || SRO.util.rng(1);
    if (!S.isNormalized(instance, sol)) sol = S.normalize(instance, sol);
    const st = S.rallyState(instance, sol);
    const waiting = new Uint8Array(P.nJ), dj = M.context(instance, sol).deferredJobs;
    for (let a = 0; a < dj.length; a++) waiting[dj[a]] = 1;
    let targets = st.pins;
    const pin = targets.length > 0;
    if (!pin) {
      if (opts.pinsOnly || !st.bound) return null;
      const inUse = new Uint8Array(nN), seen = new Uint8Array(nN);
      for (let a = 0; a < st.used.length; a++) inUse[st.used[a]] = 1;
      targets = [];
      for (let a = 0; a < dj.length; a++) {
        const cn = P.jCandNodes[dj[a]];
        for (let c = 0; c < cn.length; c++) if (P.isRally[cn[c]] && !inUse[cn[c]] && !seen[cn[c]]) { seen[cn[c]] = 1; targets.push(cn[c]); }
      }
      targets.sort(function (a, b) { return a - b; });
      if (!targets.length) return null;
    }
    const w = targets.indexOf(opts.target) >= 0 ? opts.target : targets[rng.int(targets.length)];
    const able = [];
    for (let j = 0; j < P.nJ; j++) if (P.cand[j * nN + w] >= 0 && P.jLockV[j] !== -2) able.push(j);
    able.sort(function (a, b) { return P.candCost[a * nN + w] - P.candCost[b * nN + w] || a - b; });
    const free = pin ? able : able.filter(function (j) { return waiting[j]; });
    if (!free.length) return null;
    const near = free[rng.int(mmin(3, free.length))];
    const closeable = st.atCap ? st.used.filter(function (n) { return !P.pinned[n]; }) : [-1];
    if (!closeable.length) return null;
    const order = noisyOrder(instance, rng);
    const maxEvals = opts.maxEvals != null ? opts.maxEvals : Infinity;
    let evals = 0, best = null, bestE = null, bestClosed = -1;
    for (let k = 0; k < closeable.length && evals < maxEvals; k++) {
      const closed = closeable[k];
      const moved = new Uint8Array(P.nJ), shut = new Uint8Array(nN);
      if (closed >= 0) shut[closed] = 1;
      let routes = closed >= 0 ? withoutNodes(sol.routes, shut, moved) : sol.routes;
      let seed = near;
      for (let a = 0; a < able.length; a++) if (moved[able[a]]) { seed = able[a]; break; }
      routes = routes.map(function (rt) {             // the seed job off the plan
        let hit = false;
        for (let v = 0; v < rt.visits.length && !hit; v++) for (let c = 0; c < rt.visits[v].jobs.length; c++) if (rt.visits[v].jobs[c].job === seed) { hit = true; break; }
        if (!hit) return rt;
        const visits = [];
        for (let v = 0; v < rt.visits.length; v++) {
          const vi = rt.visits[v], js = vi.jobs.filter(function (x) { return x.job !== seed; });
          if (js.length === vi.jobs.length) visits.push(vi); else if (js.length) visits.push({ node: vi.node, jobs: js });
        }
        return { vehicle: rt.vehicle, visits: visits };
      });
      const inst2 = closedCopy(instance, P, closed >= 0 ? [closed] : [], seed, w);
      const list = [seed].concat(order.filter(function (j) { return j !== seed && moved[j]; }), order.filter(function (j) { return j !== seed && !moved[j] && waiting[j]; }));
      const ins = S.insertJobs(inst2, { routes: routes }, list, { rng: rng, maxEvals: maxEvals - evals });
      const rf = S.refill(inst2, ins.solution, { rng: rng, maxEvals: mmax(1, maxEvals - evals - ins.evals) });
      const e = S.evaluate(instance, rf.solution, COST_ONLY);
      evals += ins.evals + rf.evals + 1;
      if (!best || (e.feasible && !bestE.feasible) || (e.feasible === bestE.feasible && e.total < bestE.total)) { best = rf.solution; bestE = e; bestClosed = closed; }
    }
    return { solution: best, evals: evals, opened: w, closed: bestClosed, pin: pin };
  };
  // Pin repair: rallySwap for unused pinned rally points only (every localSearch end phase uses it).
  S.pinRepair = function (instance, sol, opts) { return S.rallySwap(instance, sol, Object.assign({}, opts, { pinsOnly: true })); };

  // ---- local search ---------------------------------------------------------------------------
  function clockNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // First-improvement descent. Alternates a random phase (sample moves, take any improvement, stop
  // after `patience` misses in a row) with a full systematic sweep over SWEEP_TYPES then SWEEP_LAST
  // (take the first improving move, then back to the random phase). When a sweep finds nothing it
  // tries compound moves unless opts.refill is false: while a pinned rally point gets nothing, up to
  // PIN_TRIES pin repairs (SRO.solver.pinRepair) each followed by a short nested descent; then forced
  // insertion of every deferred job (SRO.solver.insertJobs with force) and the same descent, then the
  // same after emptying one route ("ruin and refill", up to ruinRoutes routes). Ends at a local optimum
  // of all of these, or when maxIters evaluations / timeLimitMs are used. Never returns a worse plan
  // than its input, and never makes a violation-free plan infeasible.
  //   opts: { rng, seed, maxIters (default 100000), timeLimitMs (default 10000), patience, types,
  //           refill (default true), ruinRoutes (routes emptied and refilled per end phase, default 3),
  //           stats, now (the clock timeLimitMs runs on, in ms; the methods pass hooks.now; default
  //           performance.now) }
  // Returns a normalized solution (for a malformed input that normalizing made worse and the search
  // could not beat, a shallow copy of the input); empty visits are dropped when that lowers the total.
  // opts.stats (an object) receives { evals, improvements, sweeps,
  // refills, total, feasible, localOptimum, ms }.
  S.localSearch = function (instance, solution, opts) {
    opts = opts || {};
    const P = S.prepare(instance);
    const rng = opts.rng || SRO.util.rng(opts.seed || 1);
    const maxIters = opts.maxIters != null ? opts.maxIters : 100000;
    const now = typeof opts.now === 'function' ? opts.now : clockNow;
    const t0 = now(), deadline = t0 + (opts.timeLimitMs != null ? opts.timeLimitMs : 10000);
    const sweepTypes = opts.types || M.SWEEP_TYPES;

    // The search always runs on the normalized plan (the moves need that shape). Normalizing never
    // hurts a violation-free plan; for a malformed input it can (merging two routes of one truck), so
    // the input itself is returned at the end if the search did not beat it.
    const inEval = S.evaluate(instance, solution, COST_ONLY);
    let sol = S.normalize(instance, solution);
    const ev = S.evaluate(instance, sol, COST_ONLY);
    let cur = ev.total, feas = ev.feasible;
    let evals = 0, improvements = 0, sweeps = 0, refills = 0, localOpt = false, timeUp = false;
    const useRefill = opts.refill !== false;
    const ruinRoutes = opts.ruinRoutes != null ? opts.ruinRoutes : 3;
    const better = function (e) {
      return e.total < cur - 1e-9 * mmax(1, mabs(cur)) && (e.feasible || !feas);
    };
    const patience = opts.patience || 0;

    // Empty visits (moves never create them, other builders might) cost a stop and a detour and no
    // move removes them: drop each one that lowers the total.
    for (let r = 0; r < sol.routes.length; r++) {
      for (let s = sol.routes[r].visits.length - 1; s >= 0; s--) {
        if (sol.routes[r].visits[s].jobs.length) continue;
        const out = sol.routes.slice();
        const R = { vehicle: sol.routes[r].vehicle, visits: sol.routes[r].visits.slice() };
        R.visits.splice(s, 1); out[r] = R;
        const cand = { routes: out };
        const e = S.evaluate(instance, cand, COST_ONLY);
        evals++;
        if (better(e)) { sol = cand; cur = e.total; feas = e.feasible; improvements++; }
      }
    }

    outer:
    while (evals < maxIters) {
      // random phase
      let ctx = M.context(instance, sol);
      const pat = patience || mmax(150, 4 * (ctx.nCh + ctx.nVis));
      let misses = 0;
      while (misses < pat && evals < maxIters) {
        const m = randomMove(ctx, rng);
        if (!m) break;
        const nr = build(P, ctx.routes, m);
        evals++;
        if ((evals & 255) === 0 && now() > deadline) { timeUp = true; break outer; }
        if (!nr) { misses++; continue; }
        const cand = { routes: nr };
        const e = S.evaluate(instance, cand, COST_ONLY);
        if (better(e)) {
          sol = cand; cur = e.total; feas = e.feasible; improvements++;
          ctx = M.context(instance, sol);
          misses = 0;
        } else misses++;
      }
      // systematic sweep
      sweeps++;
      ctx = M.context(instance, sol);
      let found = null, foundEval = null;
      const types = rng.shuffle(sweepTypes.slice()).concat(opts.types ? EMPTY : M.SWEEP_LAST);
      const stopAt = function (m) {
        const nr = build(P, ctx.routes, m);
        evals++;
        if ((evals & 255) === 0 && now() > deadline) { timeUp = true; return true; }
        if (!nr) return evals >= maxIters;
        const cand = { routes: nr };
        const e = S.evaluate(instance, cand, COST_ONLY);
        if (better(e)) { found = cand; foundEval = e; return true; }
        return evals >= maxIters;
      };
      for (let i = 0; i < types.length && !found && !timeUp && evals < maxIters; i++) {
        const f = ENUM[types[i]];
        if (f) f(ctx, stopAt);
      }
      if (timeUp) break;
      if (!found && useRefill && S.refill) {
        // a short nested descent (which can defer again whatever does not pay) of a compound move's
        // plan before judging it
        const judge = function (start) {
          const st = {};
          const pol = S.localSearch(instance, start, {
            rng: rng, refill: false, stats: st, now: now, timeLimitMs: mmax(0, deadline - now()),
            maxIters: mmin(maxIters - evals, 20 * (ctx.nCh + ctx.nVis + 10))
          });
          evals += st.evals || 0;
          const e = S.evaluate(instance, pol, COST_ONLY);
          if (better(e)) { found = pol; foundEval = e; refills++; }
        };
        // compound moves: pin repair while a pinned rally point gets nothing (it may need a whole rally
        // point traded for it, see pinRepair), refill (forced insertion of every deferred job + short
        // descent), then "empty one route and refill" for up to ruinRoutes routes in random order
        for (let a = 0; a < PIN_TRIES && P.pinNodes.length && !found && evals < maxIters; a++) {
          if (now() > deadline) { timeUp = true; break; }
          const pr = S.pinRepair(instance, sol, { rng: rng, maxEvals: maxIters - evals });
          if (!pr) break;
          evals += pr.evals;
          judge(pr.solution);
        }
        const tries = found || timeUp ? [] : [-1].concat(rng.shuffle(ctx.nonEmpty.slice()).slice(0, ruinRoutes));
        for (let a = 0; a < tries.length && !found && evals < maxIters; a++) {
          if (now() > deadline) { timeUp = true; break; }
          let start = sol;
          if (tries[a] >= 0) {
            const out = sol.routes.slice();
            out[tries[a]] = { vehicle: sol.routes[tries[a]].vehicle, visits: [] };
            start = { routes: out };
          }
          // forced insertion of everything deferred (uphill allowed), then the short descent
          const c2 = M.context(instance, start);
          if (!c2.deferredJobs.length) continue;
          const rf = S.insertJobs(instance, start, c2.deferredJobs, { rng: rng, force: true, maxEvals: maxIters - evals });
          evals += rf.evals;
          if (rf.solution.routes === start.routes) continue;
          judge(rf.solution);
        }
        if (timeUp) break;
      }
      if (!found) { localOpt = evals < maxIters; break; }
      sol = found; cur = foundEval.total; feas = foundEval.feasible; improvements++;
    }
    if (cur > inEval.total + 1e-9 * mmax(1, mabs(inEval.total)) || (inEval.feasible && !feas)) {
      // malformed input that normalizing made worse and the search did not recover: keep the input
      sol = { routes: ((solution && solution.routes) || []).slice() };
      cur = inEval.total; feas = inEval.feasible;
    }
    if (opts.stats && typeof opts.stats === 'object') {
      opts.stats.evals = evals; opts.stats.improvements = improvements; opts.stats.sweeps = sweeps; opts.stats.refills = refills;
      opts.stats.total = cur; opts.stats.feasible = feas; opts.stats.localOptimum = localOpt; opts.stats.ms = now() - t0;
    }
    return sol;
  };
})(typeof self !== 'undefined' ? self : globalThis);
