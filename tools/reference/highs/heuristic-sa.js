/*
 * heuristic-sa.js  -  simulated annealing over route lists for the VRP in vrp-model.js.
 * Plain script (global saSolve) + CommonJS. Needs VRP (vrp-model.js) loaded first.
 *
 *   saSolve(inst, { timeMs: 10000, seed: 1, start: routes|null, onProgress: (p) => {}, progressMs: 200 })
 *     -> { routes, cost, iters, firstAt, history: [[ms, cost]] }
 * Moves: relocate (incl. to/from the unserved pool), exchange with pool, swap, 2-opt within a route.
 */
(function (root) {
  "use strict";
  const V = root.VRP || (typeof require === "function" ? require("./vrp-model.js") : null);

  function saSolve(inst, opt = {}) {
    const rnd = V.mulberry32(opt.seed || 1);
    const timeMs = opt.timeMs ?? 10000, progressMs = opt.progressMs ?? 200;
    const onProgress = opt.onProgress || (() => {});
    const nV = inst.vehicles.length;
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t0 = now();
    let routes = (opt.start || V.greedy(inst)).map((r) => r.slice());
    const inRoute = new Set(routes.flat());
    let pool = inst.tasks.filter((t) => !inRoute.has(t.id)).map((t) => t.id); // unserved
    const rc = routes.map((r, k) => V.schedule(inst, k, r));
    const routeCost = (k, r) => { const s = V.schedule(inst, k, r); return s ? s.cost : Infinity; };
    const P = (id) => inst.tasks[id - 1].P;
    let cur = rc.reduce((s, x) => s + x.cost, 0) + pool.reduce((s, id) => s + P(id), 0);
    let best = cur, bestRoutes = routes.map((r) => r.slice());
    const costs = rc.map((x) => x.cost);
    const sameType = (k, id) => inst.vehicles[k].type === inst.tasks[id - 1].type;
    let T = opt.T0 ?? 200, iters = 0, lastP = t0;
    const history = [[0, best]];
    for (;;) {
      iters++;
      if ((iters & 1023) === 0) {
        const el = now() - t0;
        if (el > timeMs) break;
        T = (opt.T0 ?? 200) * Math.pow(0.001 / (opt.T0 ?? 200) * 10, el / timeMs); // geometric 200 -> ~0.002
        if (now() - lastP >= progressMs) { lastP = now(); onProgress({ ms: Math.round(el), cost: cur, best, iters, T }); }
      }
      const mv = rnd();
      let k1 = Math.floor(rnd() * nV), k2, n1, n2, delta, apply;
      if (mv < 0.45) {
        // relocate: pick a task from a route or the pool, insert into a random compatible route position or the pool
        const fromPool = pool.length && rnd() < 0.25;
        let id, src = -1, pos = -1;
        if (fromPool) { pos = Math.floor(rnd() * pool.length); id = pool[pos]; }
        else { if (!routes[k1].length) continue; src = k1; pos = Math.floor(rnd() * routes[k1].length); id = routes[k1][pos]; }
        const toPool = src >= 0 && rnd() < 0.1;
        if (toPool) {
          n1 = routes[src].slice(); n1.splice(pos, 1);
          const c1 = routeCost(src, n1);
          delta = c1 - costs[src] + P(id);
          apply = () => { routes[src] = n1; costs[src] = c1; pool.push(id); };
        } else {
          k2 = Math.floor(rnd() * nV);
          if (!sameType(k2, id)) continue;
          if (src === k2) {
            n1 = routes[src].slice(); n1.splice(pos, 1); n1.splice(Math.floor(rnd() * (n1.length + 1)), 0, id);
            const c1 = routeCost(src, n1); delta = c1 - costs[src];
            apply = () => { routes[src] = n1; costs[src] = c1; };
          } else {
            n2 = routes[k2].slice(); n2.splice(Math.floor(rnd() * (n2.length + 1)), 0, id);
            const c2 = routeCost(k2, n2);
            if (src >= 0) {
              n1 = routes[src].slice(); n1.splice(pos, 1);
              const c1 = routeCost(src, n1); delta = c1 - costs[src] + c2 - costs[k2];
              apply = () => { routes[src] = n1; costs[src] = c1; routes[k2] = n2; costs[k2] = c2; };
            } else {
              delta = c2 - costs[k2] - P(id);
              const pp = pos;
              apply = () => { routes[k2] = n2; costs[k2] = c2; pool.splice(pp, 1); };
            }
          }
        }
      } else if (mv < 0.55) {
        // exchange a routed task with an unserved one of the same type (capacity-neutral-ish move)
        if (!pool.length || !routes[k1].length) continue;
        const pp = Math.floor(rnd() * pool.length), id = pool[pp];
        if (!sameType(k1, id)) continue;
        const p1 = Math.floor(rnd() * routes[k1].length), out = routes[k1][p1];
        n1 = routes[k1].slice(); n1.splice(p1, 1); n1.splice(Math.floor(rnd() * (n1.length + 1)), 0, id);
        const c1 = routeCost(k1, n1); delta = c1 - costs[k1] - P(id) + P(out);
        apply = () => { routes[k1] = n1; costs[k1] = c1; pool[pp] = out; };
      } else if (mv < 0.8) {
        // swap two tasks between (or within) routes of the same vehicle type
        k2 = Math.floor(rnd() * nV);
        if (!routes[k1].length || !routes[k2].length || inst.vehicles[k1].type !== inst.vehicles[k2].type) continue;
        const p1 = Math.floor(rnd() * routes[k1].length), p2 = Math.floor(rnd() * routes[k2].length);
        if (k1 === k2) {
          if (p1 === p2) continue;
          n1 = routes[k1].slice(); [n1[p1], n1[p2]] = [n1[p2], n1[p1]];
          const c1 = routeCost(k1, n1); delta = c1 - costs[k1];
          apply = () => { routes[k1] = n1; costs[k1] = c1; };
        } else {
          n1 = routes[k1].slice(); n2 = routes[k2].slice(); const a = n1[p1]; n1[p1] = n2[p2]; n2[p2] = a;
          const c1 = routeCost(k1, n1), c2 = routeCost(k2, n2); delta = c1 - costs[k1] + c2 - costs[k2];
          apply = () => { routes[k1] = n1; costs[k1] = c1; routes[k2] = n2; costs[k2] = c2; };
        }
      } else {
        // 2-opt segment reversal within one route
        const L = routes[k1].length; if (L < 3) continue;
        let i = Math.floor(rnd() * L), j = Math.floor(rnd() * L); if (i === j) continue; if (i > j) [i, j] = [j, i];
        n1 = routes[k1].slice(0, i).concat(routes[k1].slice(i, j + 1).reverse(), routes[k1].slice(j + 1));
        const c1 = routeCost(k1, n1); delta = c1 - costs[k1];
        apply = () => { routes[k1] = n1; costs[k1] = c1; };
      }
      if (!isFinite(delta)) continue;
      if (delta <= 0 || rnd() < Math.exp(-delta / T)) {
        apply(); cur += delta;
        if (cur < best - 1e-9) { best = cur; bestRoutes = routes.map((r) => r.slice()); history.push([Math.round(now() - t0), best]); }
      }
    }
    const ev = V.evaluate(inst, bestRoutes.map((r) => r.slice()));
    return { routes: bestRoutes, cost: ev.cost, trackedBest: best, iters, history, unserved: ev.unserved };
  }
  root.saSolve = saSolve;
  if (typeof module === "object" && module.exports) module.exports = { saSolve };
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
