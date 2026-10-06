/* road_router.js - plain-JS road router for an inlined 'tw-roads-v1' graph (see build_graph.mjs).
 * No dependencies; works in a browser from file:// and in Node.
 *
 *   const G = RoadRouter.load(TW_ROADS);                 // TW_ROADS = the JSON object
 *   const r = G.route([25.04,121.56],[22.63,120.30]);    // {coords:[[lat,lon],...], meters, seconds, snap:[m,m]}
 *   const r2 = G.route(a, b, {blocked:[{lat:24.1,lon:120.7,radiusM:5000}]});   // avoid closed zones
 *   const tree = G.tree([lat,lon]); tree.pathTo([lat,lon]) // one Dijkstra, many targets (all grid pairs)
 */
(function (root) {
  'use strict';
  // Truck-ish cruise speeds (km/h) used to pick a plausible fastest path, and as the
  // OpenStreetMap-based base travel times when no external time matrix is loaded (see network.js).
  var DEFAULT_SPEEDS = { motorway: 90, trunk: 70, primary: 55, secondary: 45, tertiary: 35, link: 40 };

  function decodePolyline(str, start) {
    var pts = [], i = 0, lat = Math.round(start[0] * 1e5), lon = Math.round(start[1] * 1e5);
    function dec() { var r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return (r & 1) ? ~(r >> 1) : (r >> 1); }
    while (i < str.length) { lat += dec(); lon += dec(); pts.push([lat / 1e5, lon / 1e5]); }
    return pts;
  }
  function hav(a, b) { // [lat,lon] -> metres
    var R = 6371008.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Min-heap of (key, value) with lazy deletion.
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length; k.push(key); v.push(val);
    while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, topV = v[0], lastK = k.pop(), lastV = v.pop(), n = k.length;
    if (n > 0) {
      var i = 0;
      for (;;) { var l = 2 * i + 1, r = l + 1, m = i, mk = lastK;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; } if (r < n && k[r] < mk) { m = r; }
        if (m === i) break; k[i] = k[m]; v[i] = v[m]; i = m; }
      k[i] = lastK; v[i] = lastV;
    }
    return topV;
  };

  function load(data, options) {
    options = options || {};
    var speeds = Object.assign({}, DEFAULT_SPEEDS, options.speeds || {});
    var nodes = decodePolyline(data.nodes, [0, 0]);
    var N = nodes.length, M = data.a.length, parts = data.p.split(' ');
    var ea = new Int32Array(M), eb = new Int32Array(M), ecls = new Uint8Array(M), edir = new Uint8Array(M), elen = new Float64Array(M), ebase = new Float64Array(M);
    var geom = new Array(M), deg = new Int32Array(N + 1);
    for (var e = 0; e < M; e++) {
      ea[e] = data.a[e]; eb[e] = data.a[e] + data.db[e];
      var code = data.c[e]; ecls[e] = (code & 31) >> 2; edir[e] = code & 3; elen[e] = data.l[e];
      var cname = data.classes[ecls[e]], kmh = (code & 32) ? Math.min(speeds.link, speeds[cname]) : speeds[cname];
      ebase[e] = elen[e] / (kmh / 3.6); // seconds
      var g = decodePolyline(parts[e] || '', nodes[ea[e]]); g.unshift(nodes[ea[e]]); g.push(nodes[eb[e]]); geom[e] = g;
      if (edir[e] !== 2) deg[ea[e]]++;
      if (edir[e] !== 1) deg[eb[e]]++;
    }
    // CSR adjacency of directed arcs: arcTo, arcEdge, arcFwd
    var off = new Int32Array(N + 1); for (var i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
    var fill = off.slice(0, N), A = off[N], arcTo = new Int32Array(A), arcEdge = new Int32Array(A), arcFwd = new Uint8Array(A);
    for (e = 0; e < M; e++) {
      if (edir[e] !== 2) { var s = fill[ea[e]]++; arcTo[s] = eb[e]; arcEdge[s] = e; arcFwd[s] = 1; }
      if (edir[e] !== 1) { s = fill[eb[e]]++; arcTo[s] = ea[e]; arcEdge[s] = e; arcFwd[s] = 0; }
    }
    // spatial grid of nodes for snapping
    var CELL = 0.02, grid = new Map();
    function ck(x, y) { return x * 100000 + y; }
    for (i = 0; i < N; i++) { var k = ck(Math.floor(nodes[i][1] / CELL), Math.floor(nodes[i][0] / CELL)); var b = grid.get(k); if (!b) grid.set(k, b = []); b.push(i); }
    function nearest(p) {
      var cx = Math.floor(p[1] / CELL), cy = Math.floor(p[0] / CELL), best = -1, bd = Infinity;
      for (var ring = 0; ring < 60; ring++) {
        for (var dx = -ring; dx <= ring; dx++) for (var dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          var bucket = grid.get(ck(cx + dx, cy + dy)); if (!bucket) continue;
          for (var j = 0; j < bucket.length; j++) { var d = hav(p, nodes[bucket[j]]); if (d < bd) { bd = d; best = bucket[j]; } }
        }
        if (best >= 0 && bd < ring * CELL * 100000 * 0.9) break; // ring radius now exceeds best distance
      }
      return { node: best, dist: bd };
    }
    // closed-zone handling: edge passes within radius of a circle centre -> unusable
    function segDist(p, a, b) { // metres, local equirectangular
      var kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
      var ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
      var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? -(ax * dx + ay * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(ax + t * dx, ay + t * dy);
    }
    // Closure weights are cached by the blocked-circle set: all-pairs routing calls
    // tree() once per origin with the same closures, and rebuilding costs ~70 ms each.
    var wcache = [];
    function weights(opts) {
      var blocked = (opts && opts.blocked) || [];
      if (!blocked.length) return ebase;
      var key = blocked.map(function (b) { return b.lat.toFixed(5) + ',' + b.lon.toFixed(5) + ',' + Math.round(b.radiusM); }).sort().join(';');
      for (var ci = 0; ci < wcache.length; ci++) if (wcache[ci].key === key) return wcache[ci].w;
      var w = buildWeights(blocked);
      wcache.unshift({ key: key, w: w });
      if (wcache.length > 4) wcache.pop();
      return w;
    }
    function buildWeights(blocked) {
      var w = Float64Array.from(ebase);
      for (var e = 0; e < M; e++) {
        var g = geom[e];
        for (var z = 0; z < blocked.length && w[e] !== Infinity; z++) {
          var c = [blocked[z].lat, blocked[z].lon], r = blocked[z].radiusM;
          for (var q = 1; q < g.length; q++) if (segDist(c, g[q - 1], g[q]) <= r) { w[e] = Infinity; break; }
        }
      }
      return w;
    }
    function dijkstra(src, target, w) {
      var dist = new Float64Array(N).fill(Infinity), prevArc = new Int32Array(N).fill(-1), done = new Uint8Array(N), h = new Heap();
      dist[src] = 0; h.push(0, src);
      while (h.k.length) {
        var u = h.pop(); if (done[u]) continue; done[u] = 1; if (u === target) break;
        for (var s = off[u]; s < off[u + 1]; s++) {
          var we = w[arcEdge[s]]; if (we === Infinity) continue;
          var v = arcTo[s], nd = dist[u] + we; if (nd < dist[v]) { dist[v] = nd; prevArc[v] = s; h.push(nd, v); }
        }
      }
      return { dist: dist, prevArc: prevArc };
    }
    function walk(res, src, dst) {
      if (res.dist[dst] === Infinity) return null;
      var arcs = []; for (var v = dst; v !== src;) { var s = res.prevArc[v]; if (s < 0) return null; arcs.push(s); v = arcFwd[s] ? ea[arcEdge[s]] : eb[arcEdge[s]]; }
      arcs.reverse();
      var coords = [nodes[src]], meters = 0, edgesUsed = [];
      for (var i = 0; i < arcs.length; i++) {
        var e = arcEdge[arcs[i]], g = geom[e]; meters += elen[e]; edgesUsed.push(e);
        if (arcFwd[arcs[i]]) for (var j = 1; j < g.length; j++) coords.push(g[j]);
        else for (j = g.length - 2; j >= 0; j--) coords.push(g[j]);
      }
      return { coords: coords, meters: meters, seconds: res.dist[dst], edges: edgesUsed };
    }
    function route(from, to, opts) {
      var a = nearest(from), b = nearest(to), w = weights(opts);
      var res = dijkstra(a.node, b.node, w), r = walk(res, a.node, b.node);
      if (!r) return null; // e.g. a closed zone cuts the island in two
      r.snap = [a.dist, b.dist]; return r;
    }
    function tree(from, opts) { // single-source: one Dijkstra, then pathTo(any point)
      var a = nearest(from), res = dijkstra(a.node, -1, weights(opts));
      return { pathTo: function (to) { var b = nearest(to), r = walk(res, a.node, b.node); if (r) r.snap = [a.dist, b.dist]; return r; } };
    }
    return { nodes: nodes, geom: geom, edgeClass: ecls, edgeLen: elen, classes: data.classes, nearest: nearest, route: route, tree: tree, nodeCount: N, edgeCount: M };
  }
  var api = { load: load, decodePolyline: decodePolyline, haversine: hav, DEFAULT_SPEEDS: DEFAULT_SPEEDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RoadRouter = api;
  if (root) { root.SRO = root.SRO || {}; root.SRO.lib = root.SRO.lib || {}; root.SRO.lib.RoadRouter = api; }
})(typeof self !== 'undefined' ? self : this);
