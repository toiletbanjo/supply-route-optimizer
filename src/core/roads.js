// Road paths and road travel times on the embedded OpenStreetMap road graph (DESIGN.md sections 5-6).
// Pure, DOM-free: runs on the main thread and in Node tests.
//
// Data: SRO.data.roads_graph (roads_graph.json, Overture/OpenStreetMap, ODbL) routed by
// SRO.lib.RoadRouter (src/core/road_router.js). Optional SRO.data.roads (roads.json written by
// tools/roads/fetch_osrm_polylines.py) is a drawing-only layer for legs no closed zone touches.
//
// Points may be { lat, lon }, { lat, lng }, [lat, lon] or a grid point ({ id, lat, lon }).
// Zones use the app schema { id, kind: 'closed' | 'risk', lat, lon, radiusMi }; only closed zones
// block roads (risk zones never change the path; network.js costs them).
//
// Snapping: a point is projected onto the nearest road EDGE (not the nearest junction node, which can
// be kilometres away because degree-2 chains are merged). From the projected point the truck may run
// to either end of that edge; on one-way carriageways the short reverse run stands in for the
// parallel carriageway. A straight connector (haversine x 1.3 at 25 mph, the DESIGN section 5
// off-grid rule) joins the real point to the road when it is more than 25 m away.
//
//   roads.route(from, to, { closed: [zone...] })
//     -> { coords: [[lat, lon]...], meters, seconds, miles, minutes, snapMeters: [a, b],
//          source: 'osm-roads' | 'straight', offRoad, reachable, reason }
//        meters / seconds are base drive values (no convoy factor). 'straight' when the graph is
//        missing (reason 'no-graph'), a point is more than 5 km from any road ('far-from-road':
//        offRoad, reachable unless the line crosses a closed zone) or the closures leave no road
//        route ('no-route': reachable false; the straight estimate is kept for drawing only).
//        Cached by endpoints (1e-5 deg) + closed-zone set; results are shared, treat as read-only.
//   roads.path(from, to, zones) -> the route() result, or 'precomputed' (OSRM file) / 'straight'
//        with approximate: true when no road route exists (draw dashed, label "approximate").
//   roads.matrix(points, { closed }) -> { minutes[][], miles[][], meters[][], seconds[][],
//        sources[][], reachable[][], paths(i, j) -> coords, result(i, j) -> route()-shaped result }
//        One Dijkstra tree per snapped road end (fast all pairs). Unreachable pairs are Infinity.
//   roads.tour(points, { closed }) -> [route() result per consecutive pair]
//   roads.networkLines() -> { motorway: [coords...], trunk: [...], primary: [...] } for the base map.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const roads = SRO.core.roads = SRO.core.roads || {};

  roads.SNAP_MAX_M = 5000;                     // farther than this from every road -> straight line
  roads.CONNECT_MIN_M = 25;                    // shorter connectors are neither drawn nor costed
  roads.OFF_ROAD = { factor: 1.3, mph: 25 };   // DESIGN section 5 off-grid rule
  roads.METERS_PER_MILE = 1609.344;
  roads.CACHE_MAX = 1500;                      // route results
  roads.TREE_CACHE_MAX = 64;                   // Dijkstra trees (~100 KB each)
  roads.ATTRIBUTION = 'Road data (c) OpenStreetMap contributors (ODbL), via Overture Maps Foundation';

  const OFF_ROAD_MPS = roads.OFF_ROAD.mph * roads.METERS_PER_MILE / 3600;
  const KX0 = 111320, KY = 110540;             // metres per degree (same local projection as road_router)

  // ---- graph ------------------------------------------------------------------------------
  // base = { G, data, edgeDir, edgeMps, edgeGeomLen: Float64Array, cum: [Float64Array per edge], index }
  let base = null, baseFor = null, baseError = null;
  function getBase() {
    const data = SRO.data && SRO.data.roads_graph;
    if (baseFor === data && (base || baseError)) return base;
    baseFor = data; base = null; baseError = null;
    const RR = SRO.lib && SRO.lib.RoadRouter;
    if (!data || !RR || typeof RR.load !== 'function') { baseError = !data ? 'no road graph data' : 'no road router'; return null; }
    try {
      const G = RR.load(data);
      const M = G.edgeCount, speeds = RR.DEFAULT_SPEEDS || {};
      const edgeDir = new Uint8Array(M), edgeMps = new Float64Array(M), edgeGeomLen = new Float64Array(M), cum = new Array(M);
      for (let e = 0; e < M; e++) {
        const code = data.c[e], cname = data.classes[(code & 31) >> 2];
        edgeDir[e] = code & 3;
        const kmh = (code & 32) ? Math.min(speeds.link || 40, speeds[cname] || 40) : (speeds[cname] || 40);
        edgeMps[e] = kmh / 3.6;
        const g = G.geom[e], c = new Float64Array(g.length);
        for (let k = 1; k < g.length; k++) c[k] = c[k - 1] + hav(g[k - 1], g[k]);
        cum[e] = c; edgeGeomLen[e] = c[g.length - 1];
      }
      base = { G: G, data: data, edgeDir: edgeDir, edgeMps: edgeMps, edgeGeomLen: edgeGeomLen, cum: cum, index: null, filtered: new Map() };
    } catch (e) { baseError = String(e && e.message || e); base = null; }
    return base;
  }
  roads.graph = function () { const b = getBase(); return b ? b.G : null; };
  roads.available = function () { return !!getBase(); };
  roads.graphError = function () { getBase(); return baseError; };
  roads.reset = function () { base = null; baseFor = null; baseError = null; roads.clearCache(); };

  // ---- helpers ------------------------------------------------------------------------------
  function ll(p) {
    if (!p) return null;
    if (Array.isArray(p)) return [+p[0], +p[1]];
    const lon = p.lon !== undefined ? p.lon : p.lng;
    return [+p.lat, +lon];
  }
  function valid(p) { return !!p && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180; }
  function hav(a, b) {
    const R = 6371008.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    const h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  roads.haversineM = function (a, b) { return hav(ll(a), ll(b)); };
  function r5(x) { return Math.round(x * 1e5) / 1e5; }
  function ptKey(p) { return r5(p[0]) + ',' + r5(p[1]); }

  // App zones -> RoadRouter blocked circles (metres). Non-closed zones are ignored.
  roads.blockedCircles = function (zones) {
    const out = [];
    (zones || []).forEach(function (z) {
      if (!z || (z.kind && z.kind !== 'closed')) return;
      const lat = +z.lat, lon = +(z.lon !== undefined ? z.lon : z.lng);
      const radiusM = z.radiusM !== undefined ? +z.radiusM : +z.radiusMi * roads.METERS_PER_MILE;
      if (!isFinite(lat) || !isFinite(lon) || !(radiusM > 0)) return;
      out.push({ lat: lat, lon: lon, radiusM: radiusM });
    });
    return out;
  };
  function circlesKey(circles) {
    return circles.map(function (c) { return r5(c.lat) + ',' + r5(c.lon) + ',' + Math.round(c.radiusM); }).sort().join(';');
  }
  roads.closedKey = function (zones) { return circlesKey(roads.blockedCircles(zones)); };

  // Distance (m) from circle centre c to segment a-b; same local projection as road_router.
  function segDistToCenter(c, a, b) {
    const kx = KX0 * Math.cos(c.lat * Math.PI / 180);
    const ax = (a[1] - c.lon) * kx, ay = (a[0] - c.lat) * KY, bx = (b[1] - c.lon) * kx, by = (b[0] - c.lat) * KY;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? -(ax * dx + ay * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = ax + t * dx, y = ay + t * dy;
    return Math.sqrt(x * x + y * y);
  }
  function lineHitsCircles(coords, circles) {
    if (!circles.length || !coords || coords.length < 2) return false;
    for (let z = 0; z < circles.length; z++) {
      for (let k = 1; k < coords.length; k++) if (segDistToCenter(circles[z], coords[k - 1], coords[k]) <= circles[z].radiusM) return true;
    }
    return false;
  }

  function finish(r) {
    r.miles = r.meters / roads.METERS_PER_MILE;
    r.minutes = r.seconds / 60;
    return r;
  }
  function straight(a, b, reason, snapMeters, circles) {
    const meters = hav(a, b) * roads.OFF_ROAD.factor;
    const crosses = lineHitsCircles([a, b], circles || []);
    return finish({
      coords: [a.slice(), b.slice()], meters: meters, seconds: meters / OFF_ROAD_MPS,
      snapMeters: snapMeters || [null, null], source: 'straight', offRoad: true,
      reachable: reason !== 'no-route' && !crosses, reason: reason, crossesClosed: crosses
    });
  }
  function samePoint(a, b) {
    return finish({ coords: [a.slice(), b.slice()], meters: 0, seconds: 0, snapMeters: [0, 0], source: 'osm-roads', offRoad: false, reachable: true, reason: null });
  }

  // ---- edge snapping -------------------------------------------------------------------------
  const CELL = 0.02;   // degrees, about 2 km
  function cellKey(x, y) { return x * 100000 + y; }
  function edgeIndex(b) {
    if (b.index) return b.index;
    const cells = new Map(), G = b.G;
    for (let e = 0; e < G.edgeCount; e++) {
      const g = G.geom[e];
      for (let k = 1; k < g.length; k++) {
        const x0 = Math.floor(Math.min(g[k - 1][1], g[k][1]) / CELL), x1 = Math.floor(Math.max(g[k - 1][1], g[k][1]) / CELL);
        const y0 = Math.floor(Math.min(g[k - 1][0], g[k][0]) / CELL), y1 = Math.floor(Math.max(g[k - 1][0], g[k][0]) / CELL);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const key = cellKey(x, y); let bucket = cells.get(key);
          if (!bucket) cells.set(key, bucket = []);
          bucket.push(e, k);
        }
      }
    }
    b.index = cells;
    return cells;
  }

  // Nearest point on any edge: { e, k, t, P: [lat, lon], dist (m), along (m of geometry from edge start) }
  function snapToEdge(b, p) {
    const cells = edgeIndex(b), G = b.G;
    const cx = Math.floor(p[1] / CELL), cy = Math.floor(p[0] / CELL);
    const kx = KX0 * Math.cos(p[0] * Math.PI / 180);
    const cellMin = Math.min(CELL * kx, CELL * KY);
    let best = null, bd = Infinity;
    for (let ring = 0; ring < 70; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const bucket = cells.get(cellKey(cx + dx, cy + dy)); if (!bucket) continue;
        for (let q = 0; q < bucket.length; q += 2) {
          const e = bucket[q], k = bucket[q + 1], g = G.geom[e], A = g[k - 1], B = g[k];
          const ax = (A[1] - p[1]) * kx, ay = (A[0] - p[0]) * KY, bx = (B[1] - p[1]) * kx, by = (B[0] - p[0]) * KY;
          const ddx = bx - ax, ddy = by - ay, L = ddx * ddx + ddy * ddy;
          let t = L ? -(ax * ddx + ay * ddy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const x = ax + t * ddx, y = ay + t * ddy, d = Math.sqrt(x * x + y * y);
          if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && (e < best.e || (e === best.e && k < best.k)))) { bd = d; best = { e: e, k: k, t: t }; }
        }
      }
      if (best && bd <= ring * cellMin) break;      // every unseen segment is at least ring cells away
    }
    if (!best) return null;
    const g = G.geom[best.e], A = g[best.k - 1], B = g[best.k];
    const P = [A[0] + best.t * (B[0] - A[0]), A[1] + best.t * (B[1] - A[1])];
    const c = b.cum[best.e];
    best.P = P; best.dist = bd; best.along = c[best.k - 1] + best.t * (c[best.k] - c[best.k - 1]);
    return best;
  }

  // The two ways onto (or off) the road from a snapped point: run back to the edge's first node
  // or forward to its last node. coords run from P to the node.
  function edgeEnds(b, s) {
    const G = b.G, g = G.geom[s.e], len = b.data.l[s.e], glen = b.edgeGeomLen[s.e] || 1, mps = b.edgeMps[s.e];
    const fBack = s.along / glen;
    const back = [s.P]; for (let k = s.k - 1; k >= 0; k--) back.push(g[k]);
    const fwd = [s.P]; for (let k = s.k; k < g.length; k++) fwd.push(g[k]);
    const mB = fBack * len, mF = (1 - fBack) * len;
    return [
      { node: g[0], coords: back, meters: mB, seconds: mB / mps },
      { node: g[g.length - 1], coords: fwd, meters: mF, seconds: mF / mps }
    ];
  }
  // Direct run along one edge between two snapped points on it.
  function sameEdgeRun(b, sa, sb) {
    const g = b.G.geom[sa.e], len = b.data.l[sa.e], glen = b.edgeGeomLen[sa.e] || 1, mps = b.edgeMps[sa.e];
    const coords = [sa.P];
    if (sa.along <= sb.along) { for (let k = sa.k; k < sb.k; k++) coords.push(g[k]); }
    else { for (let k = sa.k - 1; k >= sb.k; k--) coords.push(g[k]); }
    coords.push(sb.P);
    const m = Math.abs(sa.along - sb.along) / glen * len;
    return { coords: coords, meters: m, seconds: m / mps };
  }

  // ---- closures: a road graph with the blocked edges removed (cached per closed set) -----------
  function graphFor(b, circles, ck) {
    if (!circles.length) return b.G;
    const hit = b.filtered.get(ck);
    if (hit) { b.filtered.delete(ck); b.filtered.set(ck, hit); return hit; }
    const G = b.G, data = b.data, M = G.edgeCount, keep = new Uint8Array(M).fill(1);
    const boxes = circles.map(function (c) {
      const dLat = c.radiusM / KY * 1.02, dLon = c.radiusM / (KX0 * Math.cos(c.lat * Math.PI / 180)) * 1.02;
      return [c.lat - dLat, c.lat + dLat, c.lon - dLon, c.lon + dLon];
    });
    let removed = 0;
    for (let e = 0; e < M; e++) {
      const g = G.geom[e];
      for (let z = 0; z < circles.length && keep[e]; z++) {
        const bx = boxes[z];
        for (let k = 1; k < g.length; k++) {
          const A = g[k - 1], B = g[k];
          if ((A[0] < bx[0] && B[0] < bx[0]) || (A[0] > bx[1] && B[0] > bx[1]) || (A[1] < bx[2] && B[1] < bx[2]) || (A[1] > bx[3] && B[1] > bx[3])) continue;
          if (segDistToCenter(circles[z], A, B) <= circles[z].radiusM) { keep[e] = 0; removed++; break; }
        }
      }
    }
    let out = G;
    if (removed) {
      const parts = data.p.split(' ');
      const d2 = { format: data.format, classes: data.classes, nodes: data.nodes, a: [], db: [], c: [], l: [], p: '' };
      const p2 = [];
      for (let e = 0; e < M; e++) if (keep[e]) { d2.a.push(data.a[e]); d2.db.push(data.db[e]); d2.c.push(data.c[e]); d2.l.push(data.l[e]); p2.push(parts[e] || ''); }
      d2.p = p2.join(' ');
      out = SRO.lib.RoadRouter.load(d2);
    }
    b.filtered.set(ck, out);
    if (b.filtered.size > 4) b.filtered.delete(b.filtered.keys().next().value);
    return out;
  }

  // ---- Dijkstra trees (cached) ------------------------------------------------------------------
  const trees = new Map();
  function treeFrom(Gx, node, ck) {
    const k = ck + '#' + ptKey(node);
    let t = trees.get(k);
    if (t && t.G === Gx) { trees.delete(k); trees.set(k, t); return t.tree; }
    t = { G: Gx, tree: Gx.tree(node) };
    trees.set(k, t);
    if (trees.size > roads.TREE_CACHE_MAX) trees.delete(trees.keys().next().value);
    return t.tree;
  }

  // ---- assembling a road route --------------------------------------------------------------------
  function pushAll(out, pts, skipFirst) {
    for (let i = skipFirst ? 1 : 0; i < pts.length; i++) {
      const p = pts[i], q = out[out.length - 1];
      if (q && q[0] === p[0] && q[1] === p[1]) continue;
      out.push(p);
    }
  }
  // plan: { kind: 'same', run } | { kind: 'road', start, end, road }
  // Numbers only (the matrix needs no coordinates); build() adds the drawn line from the same numbers.
  function planNumbers(sa, sb, plan) {
    const connA = sa.dist > roads.CONNECT_MIN_M ? sa.dist * roads.OFF_ROAD.factor : 0;
    const connB = sb.dist > roads.CONNECT_MIN_M ? sb.dist * roads.OFF_ROAD.factor : 0;
    let roadMeters, roadSeconds;
    if (plan.kind === 'same') { roadMeters = plan.run.meters; roadSeconds = plan.run.seconds; }
    else {
      roadMeters = plan.start.meters + plan.road.meters + plan.end.meters;
      roadSeconds = plan.start.seconds + plan.road.seconds + plan.end.seconds;
    }
    const conn = connA + connB;
    return { connA: connA, connB: connB, roadMeters: roadMeters, connectorMeters: conn, meters: roadMeters + conn, seconds: roadSeconds + conn / OFF_ROAD_MPS };
  }
  function build(a, b, sa, sb, plan) {
    const n = planNumbers(sa, sb, plan);
    const coords = [];
    if (n.connA) coords.push(a.slice());
    if (plan.kind === 'same') pushAll(coords, plan.run.coords);
    else {
      pushAll(coords, plan.start.coords);
      pushAll(coords, plan.road.coords, true);
      pushAll(coords, plan.end.coords.slice().reverse(), true);    // node -> P
    }
    if (n.connB) pushAll(coords, [b.slice()]);
    if (coords.length === 1) coords.push(coords[0].slice());
    return finish({
      coords: coords, meters: n.meters, seconds: n.seconds,
      roadMeters: n.roadMeters, connectorMeters: n.connectorMeters, snapMeters: [sa.dist, sb.dist],
      source: 'osm-roads', offRoad: false, reachable: true, reason: null
    });
  }

  // Best plan between two snapped points. Returns { plan, seconds } or null (no road route).
  function bestPlan(b, Gx, ck, circles, sa, sb, endsA, endsB) {
    let best = null;
    if (sa.e === sb.e && !sa.connBlocked && !sb.connBlocked) {   // a connector through a closed zone blocks every plan
      const run = sameEdgeRun(b, sa, sb);
      if (!lineHitsCircles(run.coords, circles)) best = { plan: { kind: 'same', run: run }, seconds: run.seconds };
    }
    for (let i = 0; i < 2; i++) {
      const s = endsA[i];
      if (s.blocked) continue;
      if (best && s.seconds >= best.seconds) continue;
      const tree = treeFrom(Gx, s.node, ck);
      for (let j = 0; j < 2; j++) {
        const t = endsB[j];
        if (t.blocked) continue;
        const r = tree.pathTo(t.node);
        if (!r) continue;
        const sec = s.seconds + r.seconds + t.seconds;
        if (!best || sec < best.seconds - 1e-9) best = { plan: { kind: 'road', start: s, end: t, road: r }, seconds: sec };
      }
    }
    return best;
  }

  function prepare(b, p, circles) {
    const s = snapToEdge(b, p);
    if (!s) return null;
    const ends = edgeEnds(b, s);
    const connBlocked = s.dist > roads.CONNECT_MIN_M && lineHitsCircles([p, s.P], circles);
    s.connBlocked = connBlocked;
    ends.forEach(function (x) { x.blocked = connBlocked || lineHitsCircles(x.coords, circles); });
    return { snap: s, ends: ends };
  }

  // ---- cache --------------------------------------------------------------------------------
  const cache = new Map();
  const stats = { hits: 0, misses: 0 };
  function cacheKey(a, b, ck) { return ptKey(a) + '>' + ptKey(b) + '|' + ck; }
  function cacheGet(k) {
    const v = cache.get(k);
    if (v === undefined) return undefined;
    cache.delete(k); cache.set(k, v);
    return v;
  }
  function cacheSet(k, v) {
    cache.set(k, v);
    if (cache.size > roads.CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  roads.cacheStats = function () { return { hits: stats.hits, misses: stats.misses, size: cache.size, trees: trees.size }; };
  roads.clearCache = function () { cache.clear(); trees.clear(); stats.hits = 0; stats.misses = 0; if (base) base.filtered.clear(); };

  // ---- route ----------------------------------------------------------------------------------
  function computeRoute(a, b, circles, ck) {
    const B = getBase();
    if (!B) return straight(a, b, 'no-graph', null, circles);
    if (hav(a, b) < 1) return samePoint(a, b);
    const pa = prepare(B, a, circles), pb = prepare(B, b, circles);
    const snap = [pa ? pa.snap.dist : Infinity, pb ? pb.snap.dist : Infinity];
    if (!pa || !pb || snap[0] > roads.SNAP_MAX_M || snap[1] > roads.SNAP_MAX_M) return straight(a, b, 'far-from-road', snap, circles);
    const Gx = graphFor(B, circles, ck);
    const best = bestPlan(B, Gx, ck, circles, pa.snap, pb.snap, pa.ends, pb.ends);
    if (!best) return straight(a, b, 'no-route', snap, circles);
    return build(a, b, pa.snap, pb.snap, best.plan);
  }

  roads.route = function (from, to, opts) {
    const a = ll(from), b = ll(to);
    if (!valid(a) || !valid(b)) throw new Error('roads.route: invalid point');
    const circles = roads.blockedCircles(opts && opts.closed);
    const ck = circlesKey(circles);
    const k = cacheKey(a, b, ck);
    const hit = cacheGet(k);
    if (hit) { stats.hits++; return hit; }
    stats.misses++;
    const r = computeRoute(a, b, circles, ck);
    cacheSet(k, r);
    return r;
  };

  // Where a point meets the road network: { lat, lon, meters } or null.
  roads.snap = function (point) {
    const B = getBase(), p = ll(point);
    if (!B || !valid(p)) return null;
    const s = snapToEdge(B, p);
    return s ? { lat: s.P[0], lon: s.P[1], meters: s.dist, onGraph: s.dist <= roads.SNAP_MAX_M } : null;
  };

  // ---- precomputed OSRM polylines (optional, drawing only) ------------------------------------
  let preIndex = null, preData = null;
  function precomputedIndex() {
    const d = SRO.data && SRO.data.roads;
    if (d === preData) return preIndex;
    preData = d; preIndex = null;
    if (!d || !d.pairs || !Array.isArray(d.points)) return null;
    preIndex = { points: d.points.map(function (p) { return { name: String(p.name), at: [+p.lat, +p.lon] }; }), pairs: d.pairs };
    return preIndex;
  }
  function preName(idx, p, raw) {
    const ids = [raw && raw.gridId, raw && raw.id, raw && raw.name].filter(function (x) { return x !== undefined && x !== null; }).map(String);
    for (let i = 0; i < idx.points.length; i++) if (ids.indexOf(idx.points[i].name) >= 0) return idx.points[i].name;
    let best = null, bd = 100;               // within 100 m counts as the same point
    for (let i = 0; i < idx.points.length; i++) { const d = hav(p, idx.points[i].at); if (d < bd) { bd = d; best = idx.points[i].name; } }
    return best;
  }
  function decode(str) {
    if (SRO.core.geo && SRO.core.geo.decodePolyline) return SRO.core.geo.decodePolyline(str);
    return SRO.lib.RoadRouter.decodePolyline(str, [0, 0]);
  }
  function precomputed(a, b, rawA, rawB, circles) {
    const idx = precomputedIndex();
    if (!idx) return null;
    const na = preName(idx, a, rawA), nb = preName(idx, b, rawB);
    if (!na || !nb || na === nb) return null;
    let rev = false, rec = idx.pairs[na + '|' + nb];
    if (!rec) { rec = idx.pairs[nb + '|' + na]; rev = true; }
    if (!rec || !rec.polyline) return null;
    let coords = decode(rec.polyline);
    if (coords.length < 2) return null;
    if (rev) coords = coords.slice().reverse();
    if (lineHitsCircles(coords, circles)) return null;
    const meters = +rec.distance_m > 0 ? +rec.distance_m : 0;
    return finish({
      coords: coords, meters: meters, seconds: +rec.duration_s > 0 ? +rec.duration_s : meters / OFF_ROAD_MPS,
      snapMeters: rec.snap_m ? (rev ? rec.snap_m.slice().reverse() : rec.snap_m.slice()) : [null, null],
      source: 'precomputed', offRoad: false, reachable: true, reason: null
    });
  }

  // Drawing path for one leg (DESIGN section 6 layer order: osm-roads, precomputed, straight).
  roads.path = function (fromPoint, toPoint, zones) {
    const r = roads.route(fromPoint, toPoint, { closed: zones });
    if (r.source === 'osm-roads') return r;
    const circles = roads.blockedCircles(zones);
    const k = 'path|' + cacheKey(ll(fromPoint), ll(toPoint), circlesKey(circles));
    const hit = cacheGet(k);
    if (hit) { stats.hits++; return hit; }
    const pre = precomputed(ll(fromPoint), ll(toPoint), fromPoint, toPoint, circles);
    const out = pre || Object.assign({}, r, { approximate: true });
    cacheSet(k, out);
    return out;
  };

  roads.tour = function (points, opts) {
    const legs = [];
    for (let i = 1; i < (points || []).length; i++) legs.push(roads.route(points[i - 1], points[i], opts));
    return legs;
  };

  // ---- all pairs ------------------------------------------------------------------------------
  function square(n, fill) { const m = new Array(n); for (let i = 0; i < n; i++) m[i] = new Array(n).fill(fill); return m; }

  roads.matrix = function (points, opts) {
    const t0 = Date.now();
    const pts = (points || []).map(ll);
    pts.forEach(function (p, i) { if (!valid(p)) throw new Error('roads.matrix: invalid point ' + i); });
    const n = pts.length;
    const circles = roads.blockedCircles(opts && opts.closed);
    const ck = circlesKey(circles);
    const meters = square(n, Infinity), seconds = square(n, Infinity), sources = square(n, null), reachable = square(n, false);
    const B = getBase();
    const prep = pts.map(function (p) { return B ? prepare(B, p, circles) : null; });
    const snapM = prep.map(function (x) { return x ? x.snap.dist : Infinity; });
    const onGraph = snapM.map(function (d) { return d <= roads.SNAP_MAX_M; });
    const Gx = B ? graphFor(B, circles, ck) : null;
    const results = new Map(), plans = new Map();

    function put(i, j, r) {
      results.set(i * n + j, r);
      sources[i][j] = r.source; reachable[i][j] = r.reachable;
      if (r.reachable) { meters[i][j] = r.meters; seconds[i][j] = r.seconds; }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = pts[i], b = pts[j];
        if (i === j || hav(a, b) < 1) { put(i, j, samePoint(a, b)); continue; }
        if (!B) { put(i, j, straight(a, b, 'no-graph', null, circles)); continue; }
        if (!onGraph[i] || !onGraph[j]) { put(i, j, straight(a, b, 'far-from-road', [snapM[i], snapM[j]], circles)); continue; }
        const best = bestPlan(B, Gx, ck, circles, prep[i].snap, prep[j].snap, prep[i].ends, prep[j].ends);
        if (!best) { put(i, j, straight(a, b, 'no-route', [snapM[i], snapM[j]], circles)); continue; }
        // numbers now, coords on demand (result(i, j) re-runs the same plan search through route())
        const r = planNumbers(prep[i].snap, prep[j].snap, best.plan);
        meters[i][j] = r.meters; seconds[i][j] = r.seconds; sources[i][j] = 'osm-roads'; reachable[i][j] = true;
        plans.set(i * n + j, true);
      }
    }
    function result(i, j) {
      const key = i * n + j;
      let r = results.get(key);
      if (r) return r;
      if (!plans.has(key)) return null;
      r = roads.route(pts[i], pts[j], { closed: circles });   // same plan search, cached by route()
      results.set(key, r);
      return r;
    }
    const toMiles = function (row) { return row.map(function (m) { return m / roads.METERS_PER_MILE; }); };
    const toMinutes = function (row) { return row.map(function (s) { return s / 60; }); };
    return {
      n: n, points: points, closedKey: ck, elapsedMs: Date.now() - t0,
      source: B ? 'osm-roads' : 'straight',
      meters: meters, seconds: seconds, miles: meters.map(toMiles), minutes: seconds.map(toMinutes),
      sources: sources, reachable: reachable, snapMeters: snapM,
      result: result,
      paths: function (i, j) { const r = result(i, j); return r ? r.coords : null; }
    };
  };

  // ---- drawing data for the base map ----------------------------------------------------------
  let drawCache = null, drawFor = null;
  roads.networkLines = function () {
    const B = getBase();
    if (!B) return null;
    if (drawFor === B) return drawCache;
    const G = B.G, out = {};
    (G.classes || []).forEach(function (c) { out[c] = []; });
    for (let e = 0; e < G.edgeCount; e++) {
      const c = G.classes[G.edgeClass[e]];
      (out[c] || (out[c] = [])).push(G.geom[e]);
    }
    drawCache = out; drawFor = B;
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
