// Google encoded-polyline algorithm, precision 1e5. Points are [lat, lon].
// `start` lets an edge's interior points be encoded as deltas from its first node.
export function encodePolyline(points, start = [0, 0]) {
  let out = '', pLat = Math.round(start[0] * 1e5), pLon = Math.round(start[1] * 1e5);
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [la, lo] of points) {
    const a = Math.round(la * 1e5), b = Math.round(lo * 1e5);
    enc(a - pLat); enc(b - pLon); pLat = a; pLon = b;
  }
  return out;
}
export function decodePolyline(str, start = [0, 0]) {
  const pts = []; let i = 0, lat = Math.round(start[0] * 1e5), lon = Math.round(start[1] * 1e5);
  const dec = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { lat += dec(); lon += dec(); pts.push([lat / 1e5, lon / 1e5]); }
  return pts;
}
