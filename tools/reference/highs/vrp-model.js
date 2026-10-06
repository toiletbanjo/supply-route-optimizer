/*
 * vrp-model.js  -  test-instance generator + MIP builder for a heterogeneous,
 * multi-depot CVRP with soft time windows (NLT) and optional "unserved" penalty.
 *
 * Plain script: works as a classic <script>, inside a Blob Web Worker (no
 * imports), and in Node via require(). Exposes global VRP / module.exports.
 *
 * Formulation (3-index arcs, time-based subtour elimination):
 *   x[k,i,j] in {0,1}  vehicle k drives i->j  (i,j in {depot_k} U N_k, N_k = tasks compatible with k)
 *   y[k,i]   in {0,1}  task i served by vehicle k
 *   z[k]     in {0,1}  vehicle k used
 *   u[i]     in [0,1]  task i unserved (implied integer by assignment row)
 *   t[i]     >= 0      service start time at task i (minutes from window start)
 *   l[i]     >= 0      lateness of task i beyond its NLT
 *   min  sum c_k*tau_ij*x + F*z + sum w_i*l_i + sum P_i*u_i
 *   s.t. sum_k y[k,i] + u[i] = 1                                   (assign)
 *        sum_j x[k,i,j] = y[k,i];  sum_j x[k,j,i] = y[k,i]        (flow)
 *        sum_j x[k,0,j] = z[k];    sum_j x[k,j,0] = z[k]          (depot)
 *        sum_i q_i y[k,i] <= Q_k z[k]                             (capacity)
 *        t_j >= t_i + s_i + tau_ij - M_ij (1 - sum_k x[k,i,j])    (time / subtour elim.)
 *        t_j >= sum_k (LOAD + tau(d_k,j)) x[k,0,j]               (leave depot after loading)
 *        t_i + sum_k (s_i + tau(i,d_k)) x[k,i,0] <= H             (back at hub by horizon)
 *        l_i >= t_i - b_i - Mlate_i * u_i                          (soft NLT, only if served)
 */
(function (root) {
  "use strict";

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fictional hubs at plausible (non-base) coordinates.
  const DEPOTS = [
    { name: "FOB Granite", lat: 25.03, lon: 121.47 },
    { name: "Base Jade", lat: 24.18, lon: 120.70 },
    { name: "FOB Anvil", lat: 22.68, lon: 120.40 },
    { name: "Base Lotus", lat: 23.93, lon: 121.55 },
  ];
  // Generic public town centres used only as random stop seeds.
  const TOWNS = [
    [25.13, 121.74], [24.99, 121.30], [24.80, 120.97], [24.56, 120.82], [24.08, 120.54],
    [23.91, 120.68], [23.71, 120.54], [23.48, 120.45], [22.99, 120.21], [22.67, 120.49],
    [22.00, 120.74], [22.76, 121.14], [24.75, 121.75], [24.60, 121.85], [23.97, 120.97],
    [23.33, 121.31], [23.10, 121.22], [24.69, 120.88], [24.35, 120.62], [24.06, 120.43],
    [23.71, 120.43], [23.31, 120.32], [22.89, 120.48], [22.37, 120.59], [24.83, 121.77],
    [24.93, 121.37], [24.95, 121.22], [24.25, 120.72], [23.97, 120.68], [23.76, 120.68],
    [22.90, 120.54], [22.55, 120.54], [22.61, 121.00], [23.74, 121.45], [23.50, 121.37],
    [24.26, 120.83], [25.17, 121.44], [24.47, 120.70], [23.60, 120.30], [22.80, 120.30],
  ];

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const isEast = (p) => p.lon >= 121.1 && p.lat < 24.5; // Hualien-Taitung coast

  /**
   * opts: { seed, nStops=20, pFuel=0.6, pCargo=0.75, horizon=720, load=20, service=15,
   *         tankerCap=2500, truckCap=10, singleNeed=false }
   */
  function makeInstance(opts = {}) {
    const o = Object.assign({ seed: 1, nStops: 20, pFuel: 0.6, pCargo: 0.75, horizon: 720, load: 20,
      service: 15, tankerCap: 2500, truckCap: 10, singleNeed: false, fixedCost: 60 }, opts);
    const rnd = mulberry32(o.seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    // stops
    const pool = TOWNS.slice();
    const stops = [];
    for (let s = 0; s < o.nStops; s++) {
      const idx = Math.floor(rnd() * pool.length);
      const [lat, lon] = pool.splice(idx, 1)[0];
      stops.push({ name: "STOP" + (s + 1), lat: lat + (rnd() - 0.5) * 0.04, lon: lon + (rnd() - 0.5) * 0.04 });
    }
    const nodes = DEPOTS.concat(stops); // node index: 0..3 depots, 4.. stops
    const N = nodes.length;
    // travel minutes: road factor 1.35, 75 km/h average, +45 min across the Central Range, clamp 10..240,
    // then Floyd-Warshall so the matrix obeys the triangle inequality like real shortest paths.
    const T = [];
    for (let i = 0; i < N; i++) {
      T.push(new Array(N).fill(0));
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const km = haversineKm(nodes[i], nodes[j]) * 1.35;
        let m = 8 + km / 75 * 60;
        if (isEast(nodes[i]) !== isEast(nodes[j])) m += 45;
        T[i][j] = Math.round(Math.min(240, Math.max(10, m)));
      }
    }
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
      if (T[i][k] + T[k][j] < T[i][j]) T[i][j] = T[i][k] + T[k][j];

    const URG = [
      { name: "Routine", w: 1, pen: 2000, p: 0.55 },
      { name: "Priority", w: 3, pen: 3000, p: 0.30 },
      { name: "Urgent", w: 10, pen: 6000, p: 0.10 },
      { name: "Immediate", w: 50, pen: 12000, p: 0.05 },
    ];
    const pickUrg = () => { let r = rnd(), c = 0; for (const u of URG) { c += u.p; if (r < c) return u; } return URG[0]; };
    const tasks = [];
    stops.forEach((st, s) => {
      let fuel = rnd() < o.pFuel, cargo = rnd() < o.pCargo;
      if (o.singleNeed) { fuel = rnd() < 0.5; cargo = !fuel; }
      if (!fuel && !cargo) cargo = true;
      const urg = pickUrg();
      const nlt = 120 + Math.round(rnd() * 480 / 15) * 15; // 0200..1000 after window start
      const earliest = rnd() < 0.2 ? 60 + Math.round(rnd() * 120 / 15) * 15 : 0;
      if (fuel) tasks.push({ stop: s, node: 4 + s, type: "fuel", q: 150 + Math.round(rnd() * 22) * 50,
        a: earliest, b: nlt, s: o.service, w: urg.w, P: urg.pen, urg: urg.name });
      if (cargo) tasks.push({ stop: s, node: 4 + s, type: "cargo", q: 1 + Math.floor(rnd() * 4),
        a: earliest, b: nlt, s: o.service, w: urg.w, P: urg.pen, urg: urg.name });
    });
    tasks.forEach((t, i) => { t.id = i + 1; });
    const vehicles = [];
    DEPOTS.forEach((d, di) => {
      vehicles.push({ name: d.name.split(" ")[1] + "-T", depot: di, type: "fuel", cap: o.tankerCap, costPerMin: 1.0 });
      vehicles.push({ name: d.name.split(" ")[1] + "-C", depot: di, type: "cargo", cap: o.truckCap, costPerMin: 0.8 });
    });
    return { opts: o, nodes, stops, depots: DEPOTS, T, tasks, vehicles };
  }

  function fmt(v) {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1e6) / 1e6);
  }
  // linear expression -> LP text, wrapped every 8 terms
  function expr(terms) {
    let out = "", n = 0;
    for (const [c, name] of terms) {
      if (c === 0) continue;
      const sign = c < 0 ? "-" : "+";
      const a = Math.abs(c);
      out += (n === 0 ? (c < 0 ? "- " : "") : " " + sign + " ") + (a === 1 ? "" : fmt(a) + " ") + name;
      n++;
      if (n % 8 === 0) out += "\n  ";
    }
    return n ? out : "0 dummy_zero";
  }

  /** Build the MIP. Returns { lp, cols: [names], index: Map, stats, inst, M } */
  function buildModel(inst) {
    const { T, tasks, vehicles, opts } = inst;
    const H = opts.horizon, LOAD = opts.load;
    const cols = [], index = new Map(), integer = new Set();
    const addCol = (name, isInt) => { if (!index.has(name)) { index.set(name, cols.length); cols.push(name); if (isInt) integer.add(name); } return name; };
    const N_k = vehicles.map((v) => tasks.filter((t) => t.type === v.type).map((t) => t.id));
    const task = (id) => tasks[id - 1];
    const nodeOf = (k, i) => (i === 0 ? vehicles[k].depot : task(i).node);
    const tau = (k, i, j) => T[nodeOf(k, i)][nodeOf(k, j)];
    const xn = (k, i, j) => `x_${k}_${i}_${j}`;
    // time bounds
    const minT = {}, maxT = {};
    for (const t of tasks) {
      const ks = vehicles.map((v, k) => k).filter((k) => vehicles[k].type === t.type);
      minT[t.id] = Math.max(t.a, Math.min(...ks.map((k) => LOAD + T[vehicles[k].depot][t.node])));
      maxT[t.id] = H - t.s - Math.min(...ks.map((k) => T[t.node][vehicles[k].depot]));
    }
    const obj = [];
    const rows = [];
    const row = (name, terms, sense, rhs) => rows.push({ name, terms, sense, rhs });
    // columns + objective
    vehicles.forEach((v, k) => {
      const nodesK = [0].concat(N_k[k]);
      for (const i of nodesK) for (const j of nodesK) if (i !== j) {
        obj.push([v.costPerMin * tau(k, i, j), addCol(xn(k, i, j), true)]);
      }
      for (const i of N_k[k]) addCol(`y_${k}_${i}`, true);
      obj.push([opts.fixedCost, addCol(`z_${k}`, true)]);
    });
    for (const t of tasks) {
      addCol(`t_${t.id}`, false);
      obj.push([t.w, addCol(`l_${t.id}`, false)]);
      obj.push([t.P, addCol(`u_${t.id}`, false)]);
    }
    // constraints
    for (const t of tasks) {
      const terms = [];
      vehicles.forEach((v, k) => { if (v.type === t.type) terms.push([1, `y_${k}_${t.id}`]); });
      terms.push([1, `u_${t.id}`]);
      row(`asg_${t.id}`, terms, "=", 1);
    }
    vehicles.forEach((v, k) => {
      const nodesK = [0].concat(N_k[k]);
      for (const i of N_k[k]) {
        row(`out_${k}_${i}`, nodesK.filter((j) => j !== i).map((j) => [1, xn(k, i, j)]).concat([[-1, `y_${k}_${i}`]]), "=", 0);
        row(`in_${k}_${i}`, nodesK.filter((j) => j !== i).map((j) => [1, xn(k, j, i)]).concat([[-1, `y_${k}_${i}`]]), "=", 0);
      }
      row(`dep_${k}`, N_k[k].map((j) => [1, xn(k, 0, j)]).concat([[-1, `z_${k}`]]), "=", 0);
      row(`ret_${k}`, N_k[k].map((j) => [1, xn(k, j, 0)]).concat([[-1, `z_${k}`]]), "=", 0);
      row(`cap_${k}`, N_k[k].map((i) => [task(i).q, `y_${k}_${i}`]).concat([[-v.cap, `z_${k}`]]), "<=", 0);
    });
    // time-based subtour elimination, aggregated over vehicles of the same type
    const Mij = {};
    for (const ti of tasks) for (const tj of tasks) {
      if (ti.id === tj.id || ti.type !== tj.type) continue;
      const ks = vehicles.map((v, k) => k).filter((k) => vehicles[k].type === ti.type);
      const tt = T[ti.node][tj.node];
      const M = Math.max(0, maxT[ti.id] + ti.s + tt - minT[tj.id]);
      Mij[ti.id + "_" + tj.id] = M;
      // t_j - t_i - M*sum_k x >= s + tt - M
      row(`tm_${ti.id}_${tj.id}`, [[1, `t_${tj.id}`], [-1, `t_${ti.id}`]].concat(ks.map((k) => [-M, xn(k, ti.id, tj.id)])), ">=", ti.s + tt - M);
    }
    for (const t of tasks) {
      const ks = vehicles.map((v, k) => k).filter((k) => vehicles[k].type === t.type);
      row(`st_${t.id}`, [[1, `t_${t.id}`]].concat(ks.map((k) => [-(LOAD + T[vehicles[k].depot][t.node]), xn(k, 0, t.id)])), ">=", 0);
      row(`hz_${t.id}`, [[1, `t_${t.id}`]].concat(ks.map((k) => [t.s + T[t.node][vehicles[k].depot], xn(k, t.id, 0)])), "<=", H);
      const Ml = Math.max(0, maxT[t.id] - t.b);
      row(`lt_${t.id}`, [[1, `l_${t.id}`], [-1, `t_${t.id}`], [Ml, `u_${t.id}`]], ">=", -t.b);
    }
    // LP text
    let lp = "\\ multi-depot heterogeneous CVRP with soft time windows\nMinimize\n obj: " + expr(obj) + "\nSubject To\n";
    for (const r of rows) lp += ` ${r.name}: ${expr(r.terms)} ${r.sense} ${fmt(r.rhs)}\n`;
    lp += "Bounds\n";
    for (const t of tasks) {
      lp += ` ${fmt(minT[t.id])} <= t_${t.id} <= ${fmt(Math.max(minT[t.id], maxT[t.id]))}\n`;
      lp += ` 0 <= u_${t.id} <= 1\n`;
    }
    lp += "Binary\n";
    let line = "";
    for (const c of cols) if (integer.has(c)) { line += " " + c; if (line.length > 200) { lp += line + "\n"; line = ""; } }
    if (line) lp += line + "\n";
    lp += "End\n";
    const nnz = rows.reduce((s, r) => s + r.terms.filter(([c]) => c !== 0).length, 0);
    return {
      lp, cols, index, inst, minT, maxT, N_k,
      stats: { rows: rows.length, cols: cols.length, binaries: integer.size, continuous: cols.length - integer.size, nnz,
        tasks: tasks.length, fuelTasks: tasks.filter((t) => t.type === "fuel").length,
        cargoTasks: tasks.filter((t) => t.type === "cargo").length, stops: inst.stops.length, vehicles: vehicles.length },
    };
  }

  /** Schedule a route (array of task ids) for vehicle k; returns null if infeasible. */
  function schedule(inst, k, route) {
    const { T, tasks, vehicles, opts } = inst;
    const v = vehicles[k];
    let time = opts.load, at = v.depot, travel = 0, late = 0, lateCost = 0, load = 0;
    const times = [];
    for (const id of route) {
      const t = tasks[id - 1];
      load += t.q;
      travel += T[at][t.node];
      time = Math.max(t.a, time + T[at][t.node]);
      times.push(time);
      const L = Math.max(0, time - t.b);
      late += L; lateCost += t.w * L;
      time += t.s; at = t.node;
    }
    travel += T[at][v.depot];
    const back = time + T[at][v.depot];
    if (load > v.cap || (route.length && back > opts.horizon + 1e-9)) return null;
    const cost = route.length ? v.costPerMin * travel + opts.fixedCost + lateCost : 0;
    return { cost, travel, lateCost, late, times, back, load };
  }

  /** Total plan cost of routes[k] (arrays of task ids). Unvisited tasks pay P. */
  function evaluate(inst, routes) {
    let cost = 0; const seen = new Set();
    for (let k = 0; k < routes.length; k++) {
      const sc = schedule(inst, k, routes[k]);
      if (!sc) return { feasible: false, cost: Infinity };
      cost += sc.cost; routes[k].forEach((i) => seen.add(i));
    }
    let unserved = 0;
    for (const t of inst.tasks) if (!seen.has(t.id)) { cost += t.P; unserved++; }
    return { feasible: true, cost, unserved };
  }

  /** Greedy cheapest insertion (urgency first, then NLT). Used as a MIP start. */
  function greedy(inst) {
    const { tasks, vehicles } = inst;
    const routes = vehicles.map(() => []);
    const order = tasks.slice().sort((a, b) => b.w - a.w || a.b - b.b);
    for (const t of order) {
      let best = null;
      vehicles.forEach((v, k) => {
        if (v.type !== t.type) return;
        const base = schedule(inst, k, routes[k]).cost;
        for (let p = 0; p <= routes[k].length; p++) {
          const r = routes[k].slice(); r.splice(p, 0, t.id);
          const sc = schedule(inst, k, r);
          if (sc && (!best || sc.cost - base < best.delta)) best = { k, r, delta: sc.cost - base };
        }
      });
      if (best && best.delta < t.P) routes[best.k] = best.r;
    }
    return routes;
  }

  /** Convert routes into a {colName: value} MIP start (all omitted columns are 0). */
  function routesToStart(model, routes) {
    const { inst, index, minT } = model;
    const v = {};
    const set = (name, val) => { if (!index.has(name)) throw new Error("no col " + name); v[name] = val; };
    const served = new Set();
    routes.forEach((r, k) => {
      if (!r.length) return;
      const sc = schedule(inst, k, r);
      set(`z_${k}`, 1);
      let prev = 0;
      r.forEach((id, p) => {
        set(`x_${k}_${prev}_${id}`, 1); set(`y_${k}_${id}`, 1);
        set(`t_${id}`, sc.times[p]);
        set(`l_${id}`, Math.max(0, sc.times[p] - inst.tasks[id - 1].b));
        served.add(id); prev = id;
      });
      set(`x_${k}_${prev}_0`, 1);
    });
    for (const t of inst.tasks) if (!served.has(t.id)) { set(`u_${t.id}`, 1); set(`t_${t.id}`, minT[t.id]); }
    return v;
  }

  /** Decode a solver column vector into routes. colNames = the SOLVER's column order (see solve-core). */
  function decode(model, colValue, colNames) {
    const { inst } = model;
    const byName = new Map();
    colNames.forEach((n, i) => byName.set(n, colValue[i]));
    const val = (n) => byName.get(n) || 0;
    return inst.vehicles.map((v, k) => {
      const route = []; let cur = 0;
      for (let guard = 0; guard < 100; guard++) {
        const next = model.N_k[k].find((j) => j !== cur && val(`x_${k}_${cur}_${j}`) > 0.5);
        if (next === undefined) break;
        route.push(next); cur = next;
      }
      return route;
    });
  }

  const api = { mulberry32, makeInstance, buildModel, schedule, evaluate, greedy, routesToStart, decode };
  root.VRP = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
