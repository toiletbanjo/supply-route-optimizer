// Travel network between grid points (DESIGN.md section 5): base travel matrix (Google or
// estimate), closed-zone rerouting with Floyd-Warshall, risk units, grid paths, off-grid legs.
// Runs on the main thread; pure (no DOM). Convoy factor is NOT applied here: minutes are base
// drive minutes and the solver-instance builder multiplies by settings.convoyFactor.
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
// net.source is 'matrix' when such a file is used, else 'estimate'. (The 'osm-roads' source of
// the revised DESIGN, routed on roads_graph.json, is not wired in yet.)
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

  // build({ grid, links, timeMatrix, zones, riskRatings, roadPaths, cache })
  //   grid / links default to SRO.data.grid / SRO.data.grid_links; timeMatrix (legacy name
  //   googleMatrix) defaults to SRO.data.time_matrix, then SRO.data.google_matrix, when neither
  //   key is given (pass null to force the estimate).
  // -> { ids, index, n, minutes[][], miles[][], riskUnits[][], gridPath(i, j) -> [gridId],
  //      source: 'matrix' | 'estimate', matrixSource, ... } ; i, j may be indexes or grid ids.
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

  network.clearCache = function () { baseCache.length = 0; };
})(typeof self !== 'undefined' ? self : globalThis);
