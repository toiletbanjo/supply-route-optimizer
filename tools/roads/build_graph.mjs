// Build a compact, routable road graph for Taiwan from either
//   (a) Overture Maps transportation segments (overture_tw_major.json, from overture_fetch.py), or
//   (b) Natural Earth ne_10m_roads clipped to Taiwan (tw_roads.geojson, from clip.py).
// Output: a small JSON blob (Google-polyline-encoded geometry) that road_router.js loads.
//
// usage: node build_graph.mjs <overture|ne> <classes comma list|all> <simplify_m> <out.json>
//   e.g. node build_graph.mjs overture motorway,trunk,primary 15 tw_roads_mtp.json
import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodePolyline } from './polyline.mjs';

const [, , SRC = 'overture', CLS_ARG = 'motorway,trunk,primary', TOL_ARG = '15', OUT = 'tw_roads.json'] = process.argv;
const TOL = +TOL_ARG;
const BBOX = [119.9, 21.8, 122.1, 25.4];
const SNAP_M = 50; // dead-end snapping tolerance
const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const want = new Set(CLS_ARG === 'all' ? CLASSES : CLS_ARG.split(','));
const LAT0 = 23.7, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540; // local metres/degree

function hav(a, b) { // [lon,lat]
  const R = 6371008.8, r = Math.PI / 180;
  const dLa = (b[1] - a[1]) * r, dLo = (b[0] - a[0]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lineLen = (c) => { let s = 0; for (let i = 1; i < c.length; i++) s += hav(c[i - 1], c[i]); return s; };
const inBox = (p) => p[0] >= BBOX[0] && p[0] <= BBOX[2] && p[1] >= BBOX[1] && p[1] <= BBOX[3];

// ---------- 1. load segments -> {cls, dir, coords}
// dir: 0 two-way, 1 only in coord order, 2 only against coord order
let segs = [];
const stats = { in: 0, closed: 0, construction: 0, hgvDenied: 0, oneway: 0 };
const isBare = (w) => !w || Object.values(w).every((v) => v == null);
if (SRC === 'overture') {
  const R = JSON.parse(fs.readFileSync('overture_tw_major.json', 'utf8'));
  for (const r of R) {
    if (!want.has(r.class)) continue;
    stats.in++;
    const flags = new Set((r.flags || []).filter((f) => !f.between).flatMap((f) => f.values));
    if (flags.has('is_under_construction') || flags.has('is_abandoned')) { stats.construction++; continue; }
    let dir = 0, closed = false;
    for (const a of r.acc || []) {
      if (a.access_type !== 'denied' || a.between) continue;
      const w = a.when || {};
      const others = { ...w }; delete others.heading; delete others.mode;
      if (!isBare(others)) continue; // time/vehicle-size conditional: ignore
      const modes = w.mode || null;
      const hitsTrucks = !modes || modes.some((m) => ['motor_vehicle', 'car', 'hgv', 'vehicle'].includes(m));
      if (!hitsTrucks) continue;
      if (modes && modes.length === 1 && modes[0] === 'hgv' && !w.heading) { stats.hgvDenied++; closed = true; continue; }
      if (w.heading === 'backward') dir = 1;
      else if (w.heading === 'forward') dir = 2;
      else closed = true;
    }
    if (closed) { stats.closed++; continue; }
    if (dir) stats.oneway++;
    for (const g of r.geom) if (g.some(inBox)) segs.push({ cls: CLASSES.indexOf(r.class), link: r.subclass === 'link', dir, coords: g });
  }
} else {
  const d = JSON.parse(fs.readFileSync('tw_roads.geojson', 'utf8'));
  for (const f of d.features) {
    stats.in++;
    const cls = f.properties.type === 'Major Highway' ? 0 : 2; // NE has no real class info for TW
    segs.push({ cls, link: false, dir: 0, coords: f.geometry.coordinates });
  }
}

// ---------- 2. nodes = shared vertices + endpoints (OSM-derived data shares exact vertices at junctions)
const key = (p) => Math.round(p[0] * 1e7) + ',' + Math.round(p[1] * 1e7);
const cnt = new Map();
for (const s of segs) s.coords.forEach((p, i) => {
  const k = key(p); cnt.set(k, (cnt.get(k) || 0) + (i === 0 || i === s.coords.length - 1 ? 2 : 1));
});
const nodeId = new Map(); const nodeXY = [];
const nid = (p) => { const k = key(p); let id = nodeId.get(k); if (id === undefined) { id = nodeXY.length; nodeId.set(k, id); nodeXY.push([p[0], p[1]]); } return id; };
let edges = [];
for (const s of segs) {
  let start = 0;
  for (let i = 1; i < s.coords.length; i++) {
    if (i === s.coords.length - 1 || cnt.get(key(s.coords[i])) >= 2) {
      const c = s.coords.slice(start, i + 1);
      edges.push({ a: nid(c[0]), b: nid(c[c.length - 1]), cls: s.cls, link: s.link, dir: s.dir, coords: c });
      start = i;
    }
  }
}
const rawKm = edges.reduce((t, e) => t + lineLen(e.coords), 0) / 1000;

// ---------- 3. snap dead ends to the nearest other node within SNAP_M
const parent = nodeXY.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
const deg = new Int32Array(nodeXY.length);
for (const e of edges) { deg[e.a]++; deg[e.b]++; }
const CELL = 0.001; const grid = new Map();
const cellKey = (x, y) => Math.floor(x / CELL) + ':' + Math.floor(y / CELL);
nodeXY.forEach((p, i) => { const k = cellKey(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
const nbr = nodeXY.map(() => new Set());
for (const e of edges) { nbr[e.a].add(e.b); nbr[e.b].add(e.a); }
let snapped = 0;
for (let i = 0; i < nodeXY.length; i++) {
  if (deg[i] !== 1) continue;
  const [x, y] = nodeXY[i]; const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  let best = -1, bd = SNAP_M;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get((cx + dx) + ':' + (cy + dy)) || []) {
    if (j === i || nbr[i].has(j) || find(j) === find(i)) continue;
    const d = hav(nodeXY[i], nodeXY[j]); if (d < bd) { bd = d; best = j; }
  }
  if (best >= 0) { parent[find(i)] = find(best); snapped++; }
}
for (const e of edges) {
  const a = find(e.a), b = find(e.b);
  if (a !== e.a) { e.coords = [nodeXY[a], ...e.coords.slice(1)]; e.a = a; }
  if (b !== e.b) { e.coords = [...e.coords.slice(0, -1), nodeXY[b]]; e.b = b; }
}
edges = edges.filter((e) => !(e.a === e.b && e.coords.length < 3));

// ---------- 4. connected components: weak (report) and largest strongly connected (keep)
const N = nodeXY.length;
const adjU = Array.from({ length: N }, () => []); // undirected
const adjF = Array.from({ length: N }, () => []); // directed forward arcs
const adjR = Array.from({ length: N }, () => []); // reverse arcs
for (const e of edges) {
  adjU[e.a].push(e.b); adjU[e.b].push(e.a);
  if (e.dir !== 2) { adjF[e.a].push(e.b); adjR[e.b].push(e.a); }
  if (e.dir !== 1) { adjF[e.b].push(e.a); adjR[e.a].push(e.b); }
}
const used = new Int32Array(N).fill(-1);
function bfsComponents(adj) {
  const comp = new Int32Array(N).fill(-1); const sizes = [];
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0 || adj[s].length === 0) continue;
    const c = sizes.length; let n = 0; const st = [s]; comp[s] = c;
    while (st.length) { const v = st.pop(); n++; for (const w of adj[v]) if (comp[w] < 0) { comp[w] = c; st.push(w); } }
    sizes.push(n);
  }
  return { comp, sizes };
}
const weak = bfsComponents(adjU);
// Kosaraju (iterative)
const order = []; const seen = new Uint8Array(N);
for (let s = 0; s < N; s++) {
  if (seen[s] || adjF[s].length === 0) continue;
  const st = [[s, 0]]; seen[s] = 1;
  while (st.length) {
    const top = st[st.length - 1]; const v = top[0];
    if (top[1] < adjF[v].length) { const w = adjF[v][top[1]++]; if (!seen[w]) { seen[w] = 1; st.push([w, 0]); } }
    else { order.push(v); st.pop(); }
  }
}
const scc = new Int32Array(N).fill(-1); const sccSizes = [];
for (let i = order.length - 1; i >= 0; i--) {
  const s = order[i]; if (scc[s] >= 0) continue;
  const c = sccSizes.length; let n = 0; const st = [s]; scc[s] = c;
  while (st.length) { const v = st.pop(); n++; for (const w of adjR[v]) if (scc[w] < 0) { scc[w] = c; st.push(w); } }
  sccSizes.push(n);
}
const bigW = weak.sizes.indexOf(Math.max(...weak.sizes));
const bigS = sccSizes.indexOf(Math.max(...sccSizes));
const kmIn = (pred) => edges.filter(pred).reduce((t, e) => t + lineLen(e.coords), 0) / 1000;
const weakKm = kmIn((e) => weak.comp[e.a] === bigW);
edges = edges.filter((e) => scc[e.a] === bigS && scc[e.b] === bigS);
const sccKm = edges.reduce((t, e) => t + lineLen(e.coords), 0) / 1000;

// ---------- 5. collapse degree-2 chains (same class, consistent direction)
const inc = new Map(); // node -> Set(edge objects)
const addInc = (n, e) => { (inc.get(n) || inc.set(n, new Set()).get(n)).add(e); };
for (const e of edges) { addInc(e.a, e); addInc(e.b, e); }
const reverse = (e) => { [e.a, e.b] = [e.b, e.a]; e.coords = e.coords.slice().reverse(); e.dir = e.dir === 1 ? 2 : e.dir === 2 ? 1 : 0; };
let merged = 0;
for (const [v, set] of inc) {
  if (set.size !== 2) continue;
  let [e1, e2] = [...set];
  if (e1 === e2 || e1.cls !== e2.cls || e1.link !== e2.link || e1.a === e1.b || e2.a === e2.b) continue;
  if (e1.b !== v) reverse(e1); // e1: u -> v
  if (e2.a !== v) reverse(e2); // e2: v -> w
  if (e1.dir !== e2.dir) continue;
  if (e1.a === e2.b) continue; // would form a loop; keep node
  e1.coords = e1.coords.concat(e2.coords.slice(1)); e1.b = e2.b;
  inc.get(e2.b).delete(e2); inc.get(e2.b).add(e1); inc.delete(v); e2.dead = true; merged++;
}
edges = edges.filter((e) => !e.dead);

// ---------- 6. simplify (Douglas-Peucker in local metres) + quantise to 1e-5 deg
function dp(c, tol) {
  if (c.length < 3 || tol <= 0) return c;
  const P = c.map((p) => [p[0] * KX, p[1] * KY]); const keep = new Uint8Array(c.length); keep[0] = keep[c.length - 1] = 1;
  const st = [[0, c.length - 1]];
  while (st.length) {
    const [i, j] = st.pop(); let md = -1, mi = -1;
    const [x1, y1] = P[i], [x2, y2] = P[j]; const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    for (let k = i + 1; k < j; k++) {
      let t = L2 ? ((P[k][0] - x1) * dx + (P[k][1] - y1) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P[k][0] - x1 - t * dx, P[k][1] - y1 - t * dy); if (d > md) { md = d; mi = k; }
    }
    if (md > tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  return c.filter((_, i) => keep[i]);
}
const q = (v) => Math.round(v * 1e5) / 1e5;
// renumber nodes compactly, ordered roughly north->south to keep ids local
const live = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort((i, j) => nodeXY[j][1] - nodeXY[i][1] || nodeXY[i][0] - nodeXY[j][0]);
const newId = new Map(live.map((v, i) => [v, i]));
const outNodes = live.map((v) => [q(nodeXY[v][1]), q(nodeXY[v][0])]); // [lat, lon]
let pts = 0;
const E = edges.map((e) => {
  const len = Math.round(lineLen(e.coords));
  const s = dp(e.coords, TOL).map((p) => [q(p[1]), q(p[0])]);
  const interior = s.slice(1, -1); pts += s.length;
  const a = newId.get(e.a), b = newId.get(e.b);
  return { a, b, code: e.cls * 4 + e.dir + (e.link ? 32 : 0), len, interior };
});
E.sort((x, y) => x.a - y.a || x.b - y.b);
const out = {
  format: 'tw-roads-v1',
  source: SRC === 'overture' ? 'Overture Maps Foundation release 2026-09-23.1, theme=transportation/type=segment (ODbL; derived from OpenStreetMap, (c) OpenStreetMap contributors)' : 'Natural Earth 1:10m roads (public domain)',
  classes: CLASSES,
  code: 'code = class*4 + dir (+32 if ramp/link); dir 0=two-way, 1=a->b only, 2=b->a only',
  nodes: encodePolyline(outNodes),
  a: E.map((e) => e.a),
  db: E.map((e) => e.b - e.a), // b stored as delta from a (small numbers)
  c: E.map((e) => e.code),
  l: E.map((e) => e.len),
  p: E.map((e) => encodePolyline(e.interior, outNodes[e.a])).join(' '),
};
const json = JSON.stringify(out);
fs.writeFileSync(OUT, json);
const gz = zlib.gzipSync(json, { level: 9 }).length, br = zlib.brotliCompressSync(json).length;
const report = {
  src: SRC, classes: [...want], tolM: TOL, segmentsIn: stats.in, droppedClosed: stats.closed, droppedConstruction: stats.construction,
  hgvDenied: stats.hgvDenied, onewaySegs: stats.oneway,
  rawKm: Math.round(rawKm), snappedDeadEnds: snapped, weakComponents: weak.sizes.length,
  largestWeakKm: Math.round(weakKm), largestSccNodesBeforeCollapse: sccSizes[bigS], largestSccKm: Math.round(sccKm),
  keptPctOfKm: +(100 * sccKm / rawKm).toFixed(1), chainMerges: merged,
  outNodes: outNodes.length, outEdges: E.length, outPoints: pts,
  bytesJson: json.length, bytesGzip: gz, bytesBrotli: br, bytesGzipBase64: Math.ceil(gz / 3) * 4,
};
console.log(JSON.stringify(report));
