// Extracts Taiwan (ISO 3166-1 numeric 158) main island + Penghu from world-atlas@2.0.2 countries-10m (Natural Earth 1:10m)
// and writes simplified GeoJSON. Usage: node extract-taiwan.js [toleranceDeg=0.003] [decimals=4]
const fs = require('fs');
const tj = require('topojson-client');
const topo = require('world-atlas/countries-10m.json');
const tol = +(process.argv[2] || 0.003), dec = +(process.argv[3] || 4);
const geoms = topo.objects.countries.geometries.filter((g) => g.id === '158');
const ft = tj.feature(topo, { type: 'GeometryCollection', geometries: geoms }).features[0];
const bbox = (r) => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [1e9, 1e9, -1e9, -1e9]);
const keep = [], dropped = [];
for (const poly of ft.geometry.coordinates) {
  const [x0, y0, x1, y1] = bbox(poly[0]);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const isMain = x1 - x0 > 1.5;                                        // main island spans ~2 deg lon
  const isPenghu = cx > 119.3 && cx < 119.8 && cy > 23.1 && cy < 23.8; // Penghu archipelago
  (isMain || isPenghu ? keep : dropped).push({ poly, name: isMain ? 'Taiwan main island' : isPenghu ? 'Penghu' : 'other', bbox: [x0, y0, x1, y1] });
}
// Douglas-Peucker on a ring (planar in degrees; fine for ~100-300 m tolerances at this latitude)
function dp(pts, eps) {
  if (pts.length < 4) return pts;
  const keepIdx = new Uint8Array(pts.length); keepIdx[0] = keepIdx[pts.length - 1] = 1;
  // closed ring: first == last, so seed the split with the vertex farthest from the first one
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > farD) { farD = d; far = i; } }
  keepIdx[far] = 1;
  const stack = [[0, far], [far, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b]; const dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L; if (d > maxD) { maxD = d; idx = i; } }
    if (maxD > eps) { keepIdx[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keepIdx[i]);
}
const r = (v) => +v.toFixed(dec);
let ptsIn = 0, ptsOut = 0;
const features = keep.map(({ poly, name }) => {
  const rings = poly.map((ring) => { ptsIn += ring.length; let s = tol > 0 ? dp(ring, tol) : ring; if (s.length < 4) s = ring; s = s.map(([x, y]) => [r(x), r(y)]); ptsOut += s.length; return s; });
  return { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: rings } };
});
const gj = { type: 'FeatureCollection', features };
const out = JSON.stringify(gj);
const file = `out/taiwan-coast.tol${tol}.d${dec}.geojson`;
fs.writeFileSync(file, out);
console.log(JSON.stringify({ file, bytes: Buffer.byteLength(out), ptsIn, ptsOut, kept: keep.map((k) => k.name), dropped: dropped.map((d) => d.bbox.map((v) => v.toFixed(2)).join(',')) }));
