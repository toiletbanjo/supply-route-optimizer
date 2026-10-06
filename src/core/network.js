// Travel network between grid points (DESIGN.md section 5): base travel matrix, closed-zone
// rerouting, risk units, grid paths, off-grid legs. Runs on the main thread; pure (no DOM).
// Convoy factor is NOT applied here: minutes are base drive minutes and the solver-instance
// builder multiplies by settings.convoyFactor.
//
// ---- Time source order (net.source) ------------------------------------------------------
//   1. 'matrix'    an external time matrix (src/data/time_matrix.json), see below.
//   2. 'osm-roads' (default when SRO.core.roads and its road graph are loaded): minutes and miles
//                  of the road-graph route between the two points, via SRO.core.roads.matrix().
//                  Closed zones are passed to the router as blocked circles, so detours follow
//                  real roads; no road route = Infinity. Risk units = miles of the drawn road path
//                  inside each risk circle x its rating value. A pair whose point is more than 5 km
//                  from any road falls back to the estimate below for that pair only.
//   3. 'estimate'  shortest path over grid_links.json (haversine x road factor at road speeds),
//                  closed zones remove links (Floyd-Warshall reroute). Used when the road graph is
//                  missing, or when opts.source === 'estimate'.
//
//   network.build(opts)            grid x grid network (see the build section at the end).
//   network.pointMatrix(points, opts)
//        Travel between arbitrary points (hubs, rally points, platoon locations), used by the
//        planner engine. points: [{ lat, lon, gridId?, onGrid? }] (onGrid: the point IS that grid
//        point). opts: { zones, riskRatings, source: 'auto' | 'osm-roads' | 'estimate', grid, links,
//        timeMatrix, cache }.
//        -> { n, source: 'osm-roads' | 'estimate' | 'matrix', counts: { 'osm-roads', estimate,
//             unreachable }, minutes[][], miles[][], riskUnits[][] (base minutes; Infinity when
//             unreachable), sources[i][j] ('osm-roads' | 'estimate' | 'matrix' | null when
//             unreachable), reachable(i, j), path(i, j) -> { coords: [[lat, lon]...], source,
//             approximate, unreachable? }, gridPath(i, j) -> [gridId], elapsedMs, zonesKey,
//             warnings }. Cached (last 4) by points + zone content; treat results as read-only.
//   network.roadsAvailable()       true when the OSM road graph can route.
//
// ---- External time matrix (src/data/time_matrix.json -> SRO.data.time_matrix) -------------
// DESIGN.md section 5 (revised 2026-10-05): an optional external matrix (OSRM, or Google if its
// terms ever allow it). The legacy name google_matrix.json (SRO.data.google_matrix) and the
// legacy key "gridIds" are still read.
//   {
//     "source": "osrm" | "google" | ...,       // who produced it (reported as net.matrixSource)
//     "fetchedAt": "2026-10-05T12:00:00Z",     // ISO time of the pull
//     "ids": ["G-GRANITE", ...],               // row/column order of both matrices ("gridIds" also accepted)
//     "minutes": [[0, 52.5, ...], ...],         // BASE drive minutes (no convoy factor); row = origin
//     "meters":  [[0, 61234, ...], ...]         // road distance in metres
//   }
// A null, negative or missing entry in "minutes" means no route was returned; that pair falls
// back to the link-graph estimate (Infinity when the link graph cannot connect it either). Grid
// points missing from ids also use the estimate. `estimatedPairs` counts such pairs.
// net.source is 'matrix' when such a file is used (it wins over 'osm-roads', DESIGN section 5).
//
// ---- Road paths (optional) ---------------------------------------------------------------
// roadPaths is an object keyed 'gridIdA|gridIdB' (the reverse key is used reversed) or a
// function (idA, idB) -> value. A value is coords [[lat, lon], ...] / [{lat, lon}], an object
// { coords, source }, or an encoded polyline5 string. Values with source 'straight' are ignored.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const network = SRO.core.network = SRO.core.network || {};

  network.ROAD = {
    freeway: { factor: 1.15, mph: 55 },
    highway: { factor: 1.3, mph: 40 },
    mountain: { factor: 1.8, mph: 22 },
    local: { factor: 1.4, mph: 30 }
  };
  network.DEFAULT_ROAD = 'local';
  network.OFF_GRID = { factor: 1.3, mph: 25 };
  network.METERS_PER_MILE = 1609.344;
  network.DEFAULT_RISK_RATINGS = { Low: 1, Medium: 3, High: 6 };
  const EPS = 1e-9;            // prefer the direct arc on (floating-point) ties
  const BASE_CACHE_MAX = 4, ZONE_CACHE_MAX = 16;

  function geo() { return SRO.core.geo; }
  function matrix(n, fill) { const m = new Array(n); for (let i = 0; i < n; i++) m[i] = new Array(n).fill(fill); return m; }
  function finiteNonNeg(x) { return typeof x === 'number' && x >= 0 && x < Infinity; }

  // Fallback cost of one link: miles = haversine x road factor, minutes at the road speed.
  // Optional link.miles / link.minutes override the estimate.
  network.linkCost = function (link, A, B) {
    const road = network.ROAD[link.road] ? link.road : network.DEFAULT_ROAD;
    const spec = network.ROAD[road];
    const miles = finiteNonNeg(link.miles) ? link.miles : geo().haversineMi(A, B) * spec.factor;
    const minutes = finiteNonNeg(link.minutes) ? link.minutes : miles / spec.mph * 60;
    return { road: road, miles: miles, minutes: minutes };
  };

  // All-pairs shortest paths. W[i][j] = arc weight (Infinity / null / NaN = no arc).
  // -> { dist: number[][] (Infinity when unreachable), next: Int32Array[] (-1 when unreachable) }
  network.floydWarshall = function (W) {
    const n = W.length;
    const dist = new Array(n), next = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = new Float64Array(n), nx = new Int32Array(n);
      for (let j = 0; j < n; j++) {
        if (i === j) { d[j] = 0; nx[j] = j; continue; }
        const w = W[i][j];
        if (finiteNonNeg(w)) { d[j] = w; nx[j] = j; } else { d[j] = Infinity; nx[j] = -1; }
      }
      dist[i] = d; next[i] = nx;
    }
    for (let k = 0; k < n; k++) {
      const dk = dist[k];
      for (let i = 0; i < n; i++) {
        if (i === k) continue;
        const di = dist[i], dik = di[k];
        if (dik === Infinity) continue;
        const ni = next[i], nik = ni[k];
        for (let j = 0; j < n; j++) {
          const nd = dik + dk[j];
          if (nd < di[j] - EPS) { di[j] = nd; ni[j] = nik; }
        }
      }
    }
    return { dist: dist.map(function (r) { return Array.from(r); }), next: next };
  };

  // Node sequence i..j from a Floyd-Warshall next matrix ([] when unreachable).
  network.pathFromNext = function (next, i, j) {
    if (next[i][j] < 0) return [];
    const path = [i];
    let u = i, guard = next.length + 1;
    while (u !== j && guard-- > 0) {
      u = next[u][j];
      if (u < 0) return [];
      path.push(u);
    }
    return u === j ? path : [];
  };

  function matrixIds(gm) { return gm ? (Array.isArray(gm.ids) ? gm.ids : gm.gridIds) : null; }
  function validGoogle(gm) {
    const mids = matrixIds(gm);
    return !!gm && Array.isArray(mids) && Array.isArray(gm.minutes) && gm.minutes.length === mids.length;
  }

  function normCoords(v) {
    if (!v) return null;
    if (typeof v === 'string') v = geo().decodePolyline(v);
    else if (!Array.isArray(v)) {
      if (v.source === 'straight') return null;
      v = v.coords || v.path || null;
      if (typeof v === 'string') v = geo().decodePolyline(v);
    }
    if (!Array.isArray(v) || v.length < 2) return null;
    return v;
  }

  // ---- zone-independent part (cached per input identity) ----------------------------------
  function computeBase(grid, links, gm, roadPaths) {
    const G = geo();
    const n = grid.length;
    const ids = grid.map(function (g) { return String(g.id); });
    const index = {};
    const warnings = [];
    ids.forEach(function (id, i) { if (index[id] === undefined) index[id] = i; else warnings.push('duplicate grid id ' + id); });

    // Link graph (undirected; duplicate links keep the fastest).
    const LW = matrix(n, Infinity), LM = matrix(n, Infinity);
    (links || []).forEach(function (lk) {
      const a = index[lk.a], b = index[lk.b];
      if (a === undefined || b === undefined) { warnings.push('link ' + lk.a + '-' + lk.b + ' names an unknown grid point'); return; }
      if (a === b) return;
      const c = network.linkCost(lk, grid[a], grid[b]);
      if (c.minutes < LW[a][b]) { LW[a][b] = LW[b][a] = c.minutes; LM[a][b] = LM[b][a] = c.miles; }
    });
    const lfw = network.floydWarshall(LW);
    const estMin = lfw.dist, estMiles = matrix(n, Infinity);
    const linkPaths = new Array(n * n);
    for (let i = 0; i < n; i++) {
      estMiles[i][i] = 0;
      for (let j = 0; j < n; j++) {
        if (i === j || estMin[i][j] === Infinity) continue;
        const p = network.pathFromNext(lfw.next, i, j);
        linkPaths[i * n + j] = p;
        let mi = 0;
        for (let t = 1; t < p.length; t++) mi += LM[p[t - 1]][p[t]];
        estMiles[i][j] = mi;
      }
    }

    // Base arcs: Google where available, else the estimate.
    const baseMin = matrix(n, Infinity), baseMiles = matrix(n, Infinity);
    const gmOk = validGoogle(gm);
    if (gm && !gmOk) warnings.push('time matrix ignored: expected { ids, minutes, meters }');
    let estimatedPairs = 0;
    const gIdx = {};
    if (gmOk) matrixIds(gm).forEach(function (id, k) { gIdx[String(id)] = k; });
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { baseMin[i][j] = 0; baseMiles[i][j] = 0; continue; }
        let used = false;
        if (gmOk) {
          const gi = gIdx[ids[i]], gj = gIdx[ids[j]];
          const row = gi === undefined ? null : gm.minutes[gi];
          const m = row && gj !== undefined ? row[gj] : null;
          if (finiteNonNeg(m)) {
            const mrow = gm.meters && gm.meters[gi];
            const mt = mrow ? mrow[gj] : null;
            baseMin[i][j] = m;
            baseMiles[i][j] = finiteNonNeg(mt) ? mt / network.METERS_PER_MILE
              : estMiles[i][j] < Infinity ? estMiles[i][j] : G.haversineMi(grid[i], grid[j]) * network.ROAD.highway.factor;
            used = true;
          }
        }
        if (!used) {
          baseMin[i][j] = estMin[i][j];
          baseMiles[i][j] = estMiles[i][j];
          if (gmOk) estimatedPairs++;
        }
      }
    }

    // Grid-id path of a single arc (link-graph shortest path; straight [i, j] if none).
    function gridPath0(i, j) {
      if (i === j) return [ids[i]];
      const p = linkPaths[i * n + j];
      return p ? p.map(function (k) { return ids[k]; }) : [ids[i], ids[j]];
    }

    function roadCoords(i, j) {
      if (!roadPaths) return null;
      if (typeof roadPaths === 'function') return normCoords(roadPaths(ids[i], ids[j]));
      const fwd = normCoords(roadPaths[ids[i] + '|' + ids[j]]);
      if (fwd) return fwd;
      const rev = normCoords(roadPaths[ids[j] + '|' + ids[i]]);
      return rev ? rev.slice().reverse() : null;
    }

    // Drawn path of an arc for closure and risk checks, plus its bounding box (lazy).
    // fromRoad[k] = 1 when the arc's drawn path is a supplied road polyline, 2 when it is built
    // from grid points (link path, or a straight segment when the link graph cannot connect it).
    const polyCache = new Array(n * n), bboxCache = new Array(n * n), fromRoad = new Uint8Array(n * n);
    function arcPoly(i, j) {
      const k = i * n + j;
      if (polyCache[k]) return polyCache[k];
      let poly = roadCoords(i, j);
      fromRoad[k] = poly ? 1 : 2;
      if (!poly) {
        const p = linkPaths[k];
        poly = p ? p.map(function (q) { return grid[q]; }) : [grid[i], grid[j]];
      }
      polyCache[k] = poly;
      return poly;
    }
    function arcHasRoad(i, j) { if (!fromRoad[i * n + j]) arcPoly(i, j); return fromRoad[i * n + j] === 1; }
    function arcBBox(i, j) {
      const k = i * n + j;
      return bboxCache[k] || (bboxCache[k] = G.bboxOf(arcPoly(i, j)));
    }

    return {
      n: n, grid: grid, ids: ids, index: index, warnings: warnings,
      LW: LW, LM: LM, baseMin: baseMin, baseMiles: baseMiles,
      source: gmOk ? 'matrix' : 'estimate', matrixSource: gmOk ? (gm.source || null) : null,
      fetchedAt: gmOk ? (gm.fetchedAt || null) : null,
      estimatedPairs: estimatedPairs,
      gridPath0: gridPath0, arcPoly: arcPoly, arcBBox: arcBBox, arcHasRoad: arcHasRoad,
      zoneCache: new Map()
    };
  }

  function normZone(z) {
    if (!z || !(+z.radiusMi > 0) || !isFinite(+z.lat) || !isFinite(+z.lon)) return null;
    return { id: z.id, kind: z.kind, rating: z.rating || null, lat: +z.lat, lon: +z.lon, radiusMi: +z.radiusMi };
  }
  function splitZones(zones, riskRatings) {
    const closed = [], risky = [];
    (zones || []).forEach(function (z0) {
      const z = normZone(z0);
      if (!z) return;
      if (z.kind === 'closed') closed.push(z);
      else if (z.kind === 'risk') {
        const v = +((riskRatings || {})[z.rating]);
        if (v > 0) { z.value = v; risky.push(z); }
      }
    });
    return { closed: closed, risky: risky };
  }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  network.zonesKey = function (zones, riskRatings) {
    const s = splitZones(zones, riskRatings || network.DEFAULT_RISK_RATINGS);
    const c = s.closed.map(function (z) { return z.id + '@' + r6(z.lat) + ',' + r6(z.lon) + ',' + r6(z.radiusMi); }).sort();
    const r = s.risky.map(function (z) { return z.id + '@' + r6(z.lat) + ',' + r6(z.lon) + ',' + r6(z.radiusMi) + ',' + z.value; }).sort();
    return 'C[' + c.join(';') + ']R[' + r.join(';') + ']';
  };

  // ---- closures, rerouting, risk -------------------------------------------------------------
  function applyZones(base, closed, risky, zonesKey, riskRatings) {
    const G = geo();
    const n = base.n, grid = base.grid, ids = base.ids;
    const W = matrix(n, Infinity);
    const kind = matrix(n, 0);           // 1 = base arc, 2 = direct-link fallback around a blocked arc
    const arcRisk = matrix(n, 0);
    let blockedArcs = 0;

    function blockedBy(poly, bb) {
      for (let z = 0; z < closed.length; z++) {
        if (G.bboxNearCircle(bb, closed[z]) && G.polylineIntersectsCircle(poly, closed[z])) return true;
      }
      return false;
    }
    function riskOf(poly, bb) {
      let r = 0;
      for (let z = 0; z < risky.length; z++) {
        if (G.bboxNearCircle(bb, risky[z])) r += G.polylineMilesInCircle(poly, risky[z]) * risky[z].value;
      }
      return r;
    }

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { W[i][j] = 0; continue; }
        if (base.baseMin[i][j] < Infinity) {
          const needGeom = closed.length || risky.length;
          const poly = needGeom ? base.arcPoly(i, j) : null;
          const bb = needGeom ? base.arcBBox(i, j) : null;
          if (closed.length && blockedBy(poly, bb)) blockedArcs++;
          else {
            W[i][j] = base.baseMin[i][j]; kind[i][j] = 1;
            if (risky.length) arcRisk[i][j] = riskOf(poly, bb);
          }
        }
        // A blocked arc may still be driven on the direct link between its end points (e.g. a
        // slow mountain road whose faster freeway detour runs through the closure). Not when the
        // arc has its own road polyline: that polyline IS the drawn path of the pair, and the
        // contract (DESIGN.md section 5) removes the arc when it passes through a closed circle.
        if (kind[i][j] === 0 && base.LW[i][j] < Infinity && !base.arcHasRoad(i, j)) {
          const seg = [grid[i], grid[j]], bb = G.bboxOf(seg);
          if (!blockedBy(seg, bb)) {
            W[i][j] = base.LW[i][j]; kind[i][j] = 2;
            if (risky.length) arcRisk[i][j] = riskOf(seg, bb);
          }
        }
      }
    }

    const fw = network.floydWarshall(W);
    const minutes = fw.dist;
    const miles = matrix(n, Infinity), riskUnits = matrix(n, Infinity);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { miles[i][j] = 0; riskUnits[i][j] = 0; continue; }
        if (minutes[i][j] === Infinity) continue;
        const seq = network.pathFromNext(fw.next, i, j);
        let mi = 0, rk = 0;
        for (let t = 1; t < seq.length; t++) {
          const u = seq[t - 1], v = seq[t];
          mi += kind[u][v] === 1 ? base.baseMiles[u][v] : base.LM[u][v];
          rk += arcRisk[u][v];
        }
        miles[i][j] = mi; riskUnits[i][j] = rk;
      }
    }

    function resolve(x) { return typeof x === 'number' ? (Number.isInteger(x) && x >= 0 && x < n ? x : undefined) : base.index[x]; }
    const pathMemo = new Map();
    function arcRoute(a, b) {
      const i = resolve(a), j = resolve(b);
      if (i === undefined || j === undefined) return [];
      return network.pathFromNext(fw.next, i, j);
    }
    // Grid-id path for the (rerouted) pair: the arcs' link paths joined end to end.
    function gridPath(a, b) {
      const i = resolve(a), j = resolve(b);
      if (i === undefined || j === undefined) return [];
      if (i === j) return [ids[i]];
      if (minutes[i][j] === Infinity) return [];
      const key = i * n + j;
      let out = pathMemo.get(key);
      if (!out) {
        const seq = network.pathFromNext(fw.next, i, j);
        out = [ids[seq[0]]];
        for (let t = 1; t < seq.length; t++) {
          const u = seq[t - 1], v = seq[t];
          const part = kind[u][v] === 1 ? base.gridPath0(u, v) : [ids[u], ids[v]];
          for (let q = 1; q < part.length; q++) out.push(part[q]);
        }
        pathMemo.set(key, out);
      }
      return out.slice();
    }

    const zonesForLegs = closed.map(function (z) { return Object.assign({}, z, { kind: 'closed' }); })
      .concat(risky.map(function (z) { return Object.assign({}, z, { kind: 'risk' }); }));
    const ratingsForLegs = riskRatings;

    const net = {
      ids: ids, index: base.index, n: n,
      minutes: minutes, miles: miles, riskUnits: riskUnits,
      gridPath: gridPath, arcRoute: arcRoute,
      source: base.source, matrixSource: base.matrixSource, fetchedAt: base.fetchedAt, estimatedPairs: base.estimatedPairs,
      base: { minutes: base.baseMin, miles: base.baseMiles },
      blockedArcs: blockedArcs,
      closedZoneIds: closed.map(function (z) { return z.id; }),
      riskZoneIds: risky.map(function (z) { return z.id; }),
      zonesKey: zonesKey,
      warnings: base.warnings.slice(),
      reachable: function (a, b) { const i = resolve(a), j = resolve(b); return i !== undefined && j !== undefined && minutes[i][j] < Infinity; },
      // Off-grid leg from a point to its nearest usable grid point, with this network's zones.
      offGridLeg: function (point, opts) {
        return network.offGridLeg(point, grid, Object.assign({ zones: zonesForLegs, riskRatings: ratingsForLegs }, opts || {}));
      },
      // Travel between two endpoints: grid index, grid id, or an off-grid point { lat, lon, gridId? }.
      // -> { minutes, miles, riskUnits, gridPath, fromGridId, toGridId, legs: { from, to } } (base minutes)
      between: function (a, b) { return between(net, a, b); }
    };
    return net;
  }

  function between(net, a, b) {
    function ends(x) {
      if (typeof x === 'number' || typeof x === 'string') {
        const i = typeof x === 'number' ? x : net.index[x];
        return Number.isInteger(i) && i >= 0 && i < net.n ? [{ i: i, leg: null }] : [];
      }
      if (!x || !isFinite(+x.lat) || !isFinite(+(x.lon !== undefined ? x.lon : x.lng))) return [];
      const out = [];
      const tried = {};
      // preferred / nearest first, then a few more in case the nearest is cut off by closures
      let leg = net.offGridLeg(x, { preferGridId: x.gridId });
      for (let k = 0; leg && k < 5; k++) {
        if (leg.blocked) break;
        out.push({ i: leg.index, leg: leg });
        tried[leg.gridId] = true;
        leg = net.offGridLeg(x, { filter: function (g) { return !tried[g.id]; } });
      }
      return out;
    }
    const A = ends(a), B = ends(b);
    let best = null;
    for (let p = 0; p < A.length; p++) {
      for (let q = 0; q < B.length; q++) {
        const ea = A[p], eb = B[q];
        const mid = net.minutes[ea.i][eb.i];
        if (mid === Infinity) continue;
        const r = {
          minutes: mid + (ea.leg ? ea.leg.minutes : 0) + (eb.leg ? eb.leg.minutes : 0),
          miles: net.miles[ea.i][eb.i] + (ea.leg ? ea.leg.miles : 0) + (eb.leg ? eb.leg.miles : 0),
          riskUnits: net.riskUnits[ea.i][eb.i] + (ea.leg ? ea.leg.riskUnits : 0) + (eb.leg ? eb.leg.riskUnits : 0),
          gridPath: net.gridPath(ea.i, eb.i),
          fromGridId: net.ids[ea.i], toGridId: net.ids[eb.i],
          legs: { from: ea.leg, to: eb.leg }
        };
        if (p === 0 && q === 0) return r;       // nearest grid points connect: DESIGN rule
        if (!best || r.minutes < best.minutes) best = r;
      }
    }
    return best || { minutes: Infinity, miles: Infinity, riskUnits: Infinity, gridPath: [], fromGridId: null, toGridId: null, legs: { from: null, to: null } };
  }

  // ---- off-grid legs ------------------------------------------------------------------------
  // Leg from an off-grid point (platoon) to its nearest grid point: haversine x 1.3 at 25 mph
  // (base minutes; convoy factor is applied by the instance builder).
  // opts: { zones, riskRatings, filter(g, i), gridId (only this point), preferGridId (try first) }.
  // With closed zones, the nearest grid point whose straight leg avoids every closed circle is
  // used; if none does, the nearest is returned with blocked: true and Infinity costs.
  // -> { gridId, index, distMi, miles, minutes, riskUnits, blocked } or null when no grid point qualifies.
  network.offGridLeg = function (point, grid, opts) {
    const G = geo(), o = opts || {};
    const z = splitZones(o.zones, o.riskRatings || network.DEFAULT_RISK_RATINGS);
    const cands = [];
    for (let i = 0; i < (grid || []).length; i++) {
      const g = grid[i];
      if (o.gridId !== undefined && o.gridId !== null && g.id !== o.gridId) continue;
      if (o.filter && !o.filter(g, i)) continue;
      cands.push({ g: g, i: i, d: G.haversineMi(point, g), pref: o.preferGridId !== undefined && g.id === o.preferGridId ? 0 : 1 });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return a.pref - b.pref || a.d - b.d || a.i - b.i; });
    function make(c, blocked) {
      const miles = c.d * network.OFF_GRID.factor;
      let risk = 0;
      if (!blocked) z.risky.forEach(function (rz) { risk += G.segmentCircleMiles(point, c.g, rz, rz.radiusMi) * rz.value; });
      return {
        gridId: c.g.id, index: c.i, distMi: c.d,
        miles: blocked ? Infinity : miles,
        minutes: blocked ? Infinity : miles / network.OFF_GRID.mph * 60,
        riskUnits: blocked ? Infinity : risk,
        blocked: blocked
      };
    }
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      const hit = z.closed.some(function (cz) { return G.segmentIntersectsCircle(point, c.g, cz); });
      if (!hit) return make(c, false);
    }
    const nearest = cands.slice().sort(function (a, b) { return a.d - b.d || a.i - b.i; })[0];
    return make(nearest, true);
  };

  // ---- build ----------------------------------------------------------------------------------
  const baseCache = [];
  function getBase(grid, links, gm, rp, useCache) {
    if (useCache) {
      for (let k = 0; k < baseCache.length; k++) {
        const c = baseCache[k];
        if (c.grid === grid && c.links === links && c.gm === gm && c.rp === rp) return c.base;
      }
    }
    const base = computeBase(grid, links, gm, rp);
    if (useCache) {
      baseCache.unshift({ grid: grid, links: links, gm: gm, rp: rp, base: base });
      if (baseCache.length > BASE_CACHE_MAX) baseCache.pop();
    }
    return base;
  }

  // ---- OSM road matrix between arbitrary points (source 'osm-roads') ----------------------------
  network.SNAP_MAX_M = 5000;            // farther from every road: that pair uses the estimate
  network.roadsAvailable = function () {
    const R = SRO.core.roads;
    if (!R || typeof R.matrix !== 'function') return false;
    try { return typeof R.available === 'function' ? !!R.available() : true; } catch (e) { return false; }
  };

  function normPoint(p) {
    if (Array.isArray(p)) return { lat: +p[0], lon: +p[1], gridId: null, onGrid: false };
    const lon = p && p.lon !== undefined ? p.lon : p && p.lng;
    return { lat: +(p && p.lat), lon: +lon, gridId: p && p.gridId != null ? String(p.gridId) : null, onGrid: !!(p && p.onGrid) };
  }
  function r5(x) { return Math.round(x * 1e5) / 1e5; }
  function pointsKey(pts) {
    return pts.map(function (p) { return r5(p.lat) + ',' + r5(p.lon) + (p.onGrid ? '@' + p.gridId : ''); }).join(';');
  }
  const pmCache = [];
  const PM_CACHE_MAX = 4;
  function uniqIds(list) {
    const out = [];
    list.forEach(function (x) { if (x != null && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  // Estimate-network endpoint for a point: its grid id when the point is that grid point, else the
  // point itself (net.between adds the off-grid leg).
  function endpointFor(net, p) {
    if (p.onGrid && p.gridId != null && net.index[p.gridId] !== undefined) return p.gridId;
    return { lat: p.lat, lon: p.lon, gridId: p.gridId || undefined };
  }
  function estimateCoords(net, pa, pb, gridPath) {
    const byId = net.gridById || (net.gridById = (function () {
      const m = {};
      ((SRO.data && SRO.data.grid) || []).forEach(function (g) { m[g.id] = g; });
      return m;
    })());
    const out = [[pa.lat, pa.lon]];
    (gridPath || []).forEach(function (id) {
      const g = byId[id];
      if (!g) return;
      const q = out[out.length - 1];
      if (q[0] !== g.lat || q[1] !== g.lon) out.push([g.lat, g.lon]);
    });
    const q = out[out.length - 1];
    if (q[0] !== pb.lat || q[1] !== pb.lon) out.push([pb.lat, pb.lon]);
    if (out.length === 1) out.push(out[0].slice());
    return out;
  }

  function estimatePointMatrix(pts, o, riskRatings) {
    const net = network.build(Object.assign({}, o, { source: 'estimate', riskRatings: riskRatings }));
    const n = pts.length;
    const minutes = matrix(n, Infinity), miles = matrix(n, Infinity), riskUnits = matrix(n, Infinity), sources = matrix(n, null);
    const gp = new Array(n * n);
    const ends = pts.map(function (p) { return endpointFor(net, p); });
    let unreachable = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { minutes[i][j] = 0; miles[i][j] = 0; riskUnits[i][j] = 0; sources[i][j] = net.source; gp[i * n + j] = uniqIds([pts[i].gridId]); continue; }
        const r = net.between(ends[i], ends[j]);
        if (!(r.minutes < Infinity)) { unreachable++; gp[i * n + j] = []; continue; }
        minutes[i][j] = r.minutes; miles[i][j] = r.miles; riskUnits[i][j] = r.riskUnits;
        sources[i][j] = net.source;
        gp[i * n + j] = r.gridPath.slice();
      }
    }
    const counts = { 'osm-roads': 0, estimate: 0, matrix: 0, unreachable: unreachable };
    counts[net.source] = n * (n - 1) - unreachable;
    return {
      n: n, points: pts, source: net.source, counts: counts,
      minutes: minutes, miles: miles, riskUnits: riskUnits, sources: sources,
      reachable: function (i, j) { return minutes[i][j] < Infinity; },
      gridPath: function (i, j) { return (gp[i * n + j] || []).slice(); },
      path: function (i, j) {
        const ok = minutes[i][j] < Infinity;
        const coords = ok ? estimateCoords(net, pts[i], pts[j], gp[i * n + j]) : [[pts[i].lat, pts[i].lon], [pts[j].lat, pts[j].lon]];
        return { coords: coords, source: ok ? net.source : 'straight', approximate: true, unreachable: !ok };
      },
      warnings: net.warnings.slice()
    };
  }

  // geo.polylineMilesInCircle with a bounding-box reject per segment (road paths have hundreds of
  // vertices, nearly all far from the circle). coords are [lat, lon] pairs.
  function milesInCircle(G, coords, rz, box) {
    let total = 0;
    for (let k = 1; k < coords.length; k++) {
      const a = coords[k - 1], b = coords[k];
      if ((a[0] < box[0] && b[0] < box[0]) || (a[0] > box[1] && b[0] > box[1]) ||
          (a[1] < box[2] && b[1] < box[2]) || (a[1] > box[3] && b[1] > box[3])) continue;
      total += G.segmentCircleMiles(a, b, rz, rz.radiusMi);
    }
    return total;
  }
  network._milesInCircle = function (coords, circle) {
    const G = geo();
    const dLat = circle.radiusMi / G.MI_PER_DEG_LAT * 1.02, dLon = dLat / Math.max(0.01, Math.cos(circle.lat * Math.PI / 180));
    return milesInCircle(G, coords, circle, [circle.lat - dLat, circle.lat + dLat, circle.lon - dLon, circle.lon + dLon]);
  };

  // SRO.core.roads.matrix for these points and closed circles; the last two are kept so a change to
  // risk zones only (no closure change) reuses the Dijkstra work.
  const rmCache = [];
  function roadMatrix(R, pts, closed) {
    const key = pointsKey(pts) + '|' + R.closedKey(closed) + '|' + (R.graph && R.graph() ? 'g' : '-');
    for (let k = 0; k < rmCache.length; k++) if (rmCache[k].key === key) return rmCache[k].m;
    const m = R.matrix(pts.map(function (p) { return [p.lat, p.lon]; }), { closed: closed });
    rmCache.unshift({ key: key, m: m });
    if (rmCache.length > 2) rmCache.pop();
    return m;
  }

  function roadPointMatrix(pts, o, riskRatings) {
    const G = geo(), R = SRO.core.roads;
    const z = splitZones(o.zones, riskRatings);
    const n = pts.length;
    const m = roadMatrix(R, pts, z.closed);
    let est = null;
    function estNet() { return est || (est = network.build(Object.assign({}, o, { source: 'estimate', riskRatings: riskRatings }))); }
    const minutes = matrix(n, Infinity), miles = matrix(n, Infinity), riskUnits = matrix(n, Infinity), sources = matrix(n, null);
    const estGp = new Map();
    const counts = { 'osm-roads': 0, estimate: 0, matrix: 0, unreachable: 0 };
    const kind = new Uint8Array(n * n);      // 1 road route, 2 estimate, 0 unreachable
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { minutes[i][j] = 0; miles[i][j] = 0; riskUnits[i][j] = 0; sources[i][j] = 'osm-roads'; kind[i * n + j] = 1; continue; }
        if (m.sources[i][j] === 'osm-roads' && m.reachable[i][j]) {
          minutes[i][j] = m.minutes[i][j]; miles[i][j] = m.miles[i][j]; riskUnits[i][j] = 0;
          sources[i][j] = 'osm-roads'; kind[i * n + j] = 1; counts['osm-roads']++;
          continue;
        }
        const r = m.result(i, j);
        if (r && r.reason === 'no-route') { counts.unreachable++; continue; }   // closures cut every road route
        // a point far from the road graph (or no graph): this pair uses the link-graph estimate
        const e = estNet().between(endpointFor(estNet(), pts[i]), endpointFor(estNet(), pts[j]));
        if (!(e.minutes < Infinity)) { counts.unreachable++; continue; }
        minutes[i][j] = e.minutes; miles[i][j] = e.miles; riskUnits[i][j] = e.riskUnits;
        sources[i][j] = 'estimate'; kind[i * n + j] = 2; counts.estimate++;
        estGp.set(i * n + j, e.gridPath.slice());
      }
    }
    // risk units on road routes: miles of the drawn path inside each risk circle x rating. A route of
    // length L from A to B can only enter circle c when |A-c| + |c-B| - 2r <= L, so most pairs skip
    // the path geometry entirely.
    if (z.risky.length) {
      const dist = z.risky.map(function (rz) { return pts.map(function (p) { return G.haversineMi(p, rz); }); });
      const boxes = z.risky.map(function (rz) {       // lat/lon box around each circle (segment quick reject)
        const dLat = rz.radiusMi / G.MI_PER_DEG_LAT * 1.02, dLon = dLat / Math.max(0.01, Math.cos(rz.lat * Math.PI / 180));
        return [rz.lat - dLat, rz.lat + dLat, rz.lon - dLon, rz.lon + dLon];
      });
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j || kind[i * n + j] !== 1) continue;
          let coords = null, rk = 0;
          for (let k = 0; k < z.risky.length; k++) {
            const rz = z.risky[k];
            if (dist[k][i] + dist[k][j] - 2 * rz.radiusMi > miles[i][j] * 1.02 + 0.05) continue;
            if (!coords) coords = m.paths(i, j) || [[pts[i].lat, pts[i].lon], [pts[j].lat, pts[j].lon]];
            rk += milesInCircle(G, coords, rz, boxes[k]) * rz.value;
          }
          riskUnits[i][j] = rk;
        }
      }
    }
    return {
      n: n, points: pts, source: 'osm-roads', counts: counts,
      minutes: minutes, miles: miles, riskUnits: riskUnits, sources: sources,
      reachable: function (i, j) { return minutes[i][j] < Infinity; },
      gridPath: function (i, j) {
        if (kind[i * n + j] === 2) return (estGp.get(i * n + j) || []).slice();
        if (kind[i * n + j] === 1) return uniqIds([pts[i].gridId, pts[j].gridId]);
        return [];
      },
      path: function (i, j) {
        const k = kind[i * n + j];
        if (k === 1) {
          const coords = i === j ? [[pts[i].lat, pts[i].lon], [pts[i].lat, pts[i].lon]] : m.paths(i, j);
          if (coords && coords.length >= 2) return { coords: coords, source: 'osm-roads', approximate: false };
        }
        if (k === 2) return { coords: estimateCoords(estNet(), pts[i], pts[j], estGp.get(i * n + j)), source: 'estimate', approximate: true };
        return { coords: [[pts[i].lat, pts[i].lon], [pts[j].lat, pts[j].lon]], source: 'straight', approximate: true, unreachable: k === 0 };
      },
      roadMatrixMs: m.elapsedMs,
      warnings: est ? est.warnings.slice() : []
    };
  }

  network.pointMatrix = function (points, opts) {
    const t0 = Date.now();
    const o = Object.assign({}, opts || {});
    const pts = (points || []).map(normPoint);
    pts.forEach(function (p, i) { if (!isFinite(p.lat) || !isFinite(p.lon)) throw new Error('network.pointMatrix: point ' + i + ' has no valid location'); });
    const riskRatings = o.riskRatings || network.DEFAULT_RISK_RATINGS;
    const data = SRO.data || {};
    const hasTm = Object.prototype.hasOwnProperty.call(o, 'timeMatrix') || Object.prototype.hasOwnProperty.call(o, 'googleMatrix');
    const gm = hasTm ? (o.timeMatrix !== undefined ? o.timeMatrix : o.googleMatrix) : (data.time_matrix || data.google_matrix || null);
    // an external matrix (when present) or a forced estimate goes through the grid network
    const useRoads = o.source !== 'estimate' && !validGoogle(gm) && network.roadsAvailable();
    const zk = network.zonesKey(o.zones, riskRatings);
    const key = (useRoads ? 'R|' : 'E|') + pointsKey(pts) + '|' + zk;
    const useCache = o.cache !== false;
    if (useCache) {
      for (let k = 0; k < pmCache.length; k++) {
        if (pmCache[k].key === key && pmCache[k].grid === (o.grid || data.grid) && pmCache[k].gm === gm) {
          const hit = pmCache.splice(k, 1)[0];
          pmCache.unshift(hit);
          return hit.value;
        }
      }
    }
    const out = useRoads ? roadPointMatrix(pts, o, riskRatings) : estimatePointMatrix(pts, o, riskRatings);
    out.zonesKey = zk;
    out.elapsedMs = Date.now() - t0;
    if (useCache) {
      pmCache.unshift({ key: key, grid: o.grid || data.grid, gm: gm, value: out });
      if (pmCache.length > PM_CACHE_MAX) pmCache.pop();
    }
    return out;
  };

  // ---- grid network on the OSM road graph ----------------------------------------------------------
  const roadNetCache = new Map();          // zonesKey + grid identity -> net
  let roadNetGrid = null;
  function buildRoadsNet(grid, links, o, riskRatings, useCache) {
    if (roadNetGrid !== grid) { roadNetCache.clear(); roadNetGrid = grid; }
    const key = network.zonesKey(o.zones, riskRatings);
    if (useCache && roadNetCache.has(key)) return roadNetCache.get(key);
    const ids = grid.map(function (g) { return String(g.id); });
    const index = {};
    const warnings = [];
    ids.forEach(function (id, i) { if (index[id] === undefined) index[id] = i; else warnings.push('duplicate grid id ' + id); });
    const n = grid.length;
    const pm = network.pointMatrix(grid.map(function (g) { return { lat: g.lat, lon: g.lon, gridId: g.id, onGrid: true }; }),
      { zones: o.zones, riskRatings: riskRatings, grid: grid, links: links, timeMatrix: null, cache: useCache });
    function resolve(x) { return typeof x === 'number' ? (Number.isInteger(x) && x >= 0 && x < n ? x : undefined) : index[x]; }
    const z = splitZones(o.zones, riskRatings);
    const zonesForLegs = z.closed.map(function (c) { return Object.assign({}, c, { kind: 'closed' }); })
      .concat(z.risky.map(function (c) { return Object.assign({}, c, { kind: 'risk' }); }));
    const net = {
      ids: ids, index: index, n: n,
      minutes: pm.minutes, miles: pm.miles, riskUnits: pm.riskUnits,
      sources: pm.sources,
      gridPath: function (a, b) {
        const i = resolve(a), j = resolve(b);
        if (i === undefined || j === undefined) return [];
        if (i === j) return [ids[i]];
        return pm.reachable(i, j) ? pm.gridPath(i, j) : [];
      },
      arcRoute: function (a, b) {
        const i = resolve(a), j = resolve(b);
        if (i === undefined || j === undefined || !pm.reachable(i, j)) return [];
        return i === j ? [i] : [i, j];
      },
      path: function (a, b) { const i = resolve(a), j = resolve(b); return i === undefined || j === undefined ? null : pm.path(i, j); },
      source: 'osm-roads', matrixSource: null, fetchedAt: null,
      estimatedPairs: pm.counts.estimate,
      base: { minutes: pm.minutes, miles: pm.miles },
      blockedArcs: 0,
      closedZoneIds: z.closed.map(function (c) { return c.id; }),
      riskZoneIds: z.risky.map(function (c) { return c.id; }),
      zonesKey: key,
      warnings: warnings.concat(pm.warnings),
      reachable: function (a, b) { const i = resolve(a), j = resolve(b); return i !== undefined && j !== undefined && pm.minutes[i][j] < Infinity; },
      offGridLeg: function (point, lopts) {
        return network.offGridLeg(point, grid, Object.assign({ zones: zonesForLegs, riskRatings: riskRatings }, lopts || {}));
      },
      between: function (a, b) { return between(net, a, b); }
    };
    if (useCache) roadNetCache.set(key, net);
    if (roadNetCache.size > ZONE_CACHE_MAX) roadNetCache.delete(roadNetCache.keys().next().value);
    return net;
  }

  // build({ grid, links, timeMatrix, zones, riskRatings, roadPaths, cache, source })
  //   grid / links default to SRO.data.grid / SRO.data.grid_links; timeMatrix (legacy name
  //   googleMatrix) defaults to SRO.data.time_matrix, then SRO.data.google_matrix, when neither
  //   key is given (pass null to skip it). source: 'auto' (default: matrix, else osm-roads when the
  //   road graph is loaded, else estimate) or 'estimate' (never the road graph).
  // -> { ids, index, n, minutes[][], miles[][], riskUnits[][], gridPath(i, j) -> [gridId],
  //      source: 'matrix' | 'osm-roads' | 'estimate', matrixSource, ... } ; i, j may be indexes or
  //      grid ids. With 'osm-roads' each pair is one road route, so gridPath is [from, to].
  // Unreachable pairs are Infinity in all three matrices and gridPath returns [].
  // Results are cached by input identity and zone content; treat them as read-only.
  network.build = function (opts) {
    const o = opts || {};
    const data = SRO.data || {};
    const grid = o.grid || data.grid || [];
    const links = o.links || data.grid_links || [];
    const has = function (k) { return Object.prototype.hasOwnProperty.call(o, k); };
    const gm = has('timeMatrix') ? o.timeMatrix : has('googleMatrix') ? o.googleMatrix
      : (data.time_matrix || data.google_matrix || null);
    const rp = o.roadPaths || null;
    const riskRatings = o.riskRatings || network.DEFAULT_RISK_RATINGS;
    const useCache = o.cache !== false;
    if (o.source !== 'estimate' && !validGoogle(gm) && !rp && network.roadsAvailable()) {
      const rnet = buildRoadsNet(grid, links, o, riskRatings, useCache);
      if (gm && !validGoogle(gm) && rnet.warnings.indexOf('time matrix ignored: expected { ids, minutes, meters }') < 0) {
        rnet.warnings.push('time matrix ignored: expected { ids, minutes, meters }');
      }
      return rnet;
    }
    const base = getBase(grid, links, gm, rp, useCache);
    const key = network.zonesKey(o.zones, riskRatings);
    if (useCache && base.zoneCache.has(key)) return base.zoneCache.get(key);
    const z = splitZones(o.zones, riskRatings);
    const net = applyZones(base, z.closed, z.risky, key, riskRatings);
    if (useCache) {
      base.zoneCache.set(key, net);
      if (base.zoneCache.size > ZONE_CACHE_MAX) base.zoneCache.delete(base.zoneCache.keys().next().value);
    }
    return net;
  };

  network.clearCache = function () { baseCache.length = 0; pmCache.length = 0; rmCache.length = 0; roadNetCache.clear(); roadNetGrid = null; };
})(typeof self !== 'undefined' ? self : globalThis);
