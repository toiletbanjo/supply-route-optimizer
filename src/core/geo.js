// Geometry helpers on geographic points. Pure functions, no DOM.
// Points are { lat, lon } in degrees ({ lat, lng } and [lat, lon] arrays are also accepted).
// Polylines are arrays of points; an array entry [a, b] is read as [lat, lon] (Leaflet order).
// Polygons (pointInPolygon) use GeoJSON order [lon, lat] for array positions.
// Circles are { lat, lon, radiusMi }. Distances are statute miles, bearings degrees clockwise from north.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const geo = SRO.core.geo = SRO.core.geo || {};

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const R_MI = 6371.0088 / 1.609344;   // IUGG mean Earth radius in miles (3958.76)

  geo.EARTH_RADIUS_MI = R_MI;
  geo.MI_PER_DEG_LAT = R_MI * D2R;     // about 69.09 mi

  // Normalize a point to { lat, lon }.
  function ll(p) {
    if (Array.isArray(p)) return { lat: +p[0], lon: +p[1] };
    if (p && p.lon === undefined && p.lng !== undefined) return { lat: +p.lat, lon: +p.lng };
    return p;
  }
  geo.toLatLon = ll;

  function wrapLonDelta(d) {
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  // Great-circle distance in miles.
  geo.haversineMi = function (a, b) {
    a = ll(a); b = ll(b);
    const dLat = (b.lat - a.lat) * D2R;
    const dLon = wrapLonDelta(b.lon - a.lon) * D2R;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * s2 * s2;
    return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  // Initial great-circle bearing from a to b, degrees in [0, 360).
  geo.bearing = function (a, b) {
    a = ll(a); b = ll(b);
    const p1 = a.lat * D2R, p2 = b.lat * D2R;
    const dl = wrapLonDelta(b.lon - a.lon) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    if (x === 0 && y === 0) return 0;
    return (Math.atan2(y, x) * R2D + 360) % 360;
  };

  // Point reached from `a` after `distMi` miles on initial bearing `bearingDeg`.
  geo.destination = function (a, bearingDeg, distMi) {
    a = ll(a);
    const d = distMi / R_MI, th = bearingDeg * D2R;
    const p1 = a.lat * D2R, l1 = a.lon * D2R;
    const sp2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th);
    const p2 = Math.asin(Math.max(-1, Math.min(1, sp2)));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sp2);
    let lon = l2 * R2D;
    lon = ((lon + 540) % 360) - 180;
    return { lat: p2 * R2D, lon: lon };
  };

  geo.pointInCircle = function (p, circle) {
    return geo.haversineMi(p, circle) <= circle.radiusMi;
  };

  // Local equirectangular projection (miles) centred on `origin`. Accurate to well under 1%
  // within a few hundred miles at Taiwan's latitude, which is all the circle tests need.
  function project(p, origin) {
    p = ll(p);
    const k = Math.cos(origin.lat * D2R);
    return {
      x: wrapLonDelta(p.lon - origin.lon) * D2R * R_MI * k,
      y: (p.lat - origin.lat) * D2R * R_MI
    };
  }
  geo.projectLocal = function (p, origin) { return project(p, ll(origin)); };

  // Miles of the straight segment p1-p2 that lie inside the circle (center, radiusMi).
  geo.segmentCircleMiles = function (p1, p2, center, radiusMi) {
    center = ll(center);
    if (!(radiusMi > 0)) return 0;
    const A = project(p1, center), B = project(p2, center);
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) return 0;
    // |A + t d|^2 = r^2  ->  L2 t^2 + 2 b t + c = 0
    const b = A.x * dx + A.y * dy;
    const c = A.x * A.x + A.y * A.y - radiusMi * radiusMi;
    const disc = b * b - L2 * c;
    if (disc <= 0) return 0;
    const sq = Math.sqrt(disc);
    const t1 = Math.max(0, (-b - sq) / L2);
    const t2 = Math.min(1, (-b + sq) / L2);
    if (t2 <= t1) return 0;
    return (t2 - t1) * Math.sqrt(L2);
  };

  // Shortest distance (miles) from point q to the segment p1-p2.
  geo.segmentDistanceMi = function (p1, p2, q) {
    q = ll(q);
    const A = project(p1, q), B = project(p2, q);
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : -(A.x * dx + A.y * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = A.x + t * dx, y = A.y + t * dy;
    return Math.sqrt(x * x + y * y);
  };

  // True when the segment passes strictly inside the circle (a tangent touch does not count).
  geo.segmentIntersectsCircle = function (p1, p2, circle) {
    return geo.segmentDistanceMi(p1, p2, circle) < circle.radiusMi;
  };

  geo.polylineMilesInCircle = function (coords, circle) {
    if (!coords || coords.length < 2) return 0;
    const c = ll(circle);
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += geo.segmentCircleMiles(coords[i - 1], coords[i], c, circle.radiusMi);
    return total;
  };

  geo.polylineIntersectsCircle = function (coords, circle) {
    if (!coords || !coords.length) return false;
    if (coords.length === 1) return geo.haversineMi(coords[0], circle) < circle.radiusMi;
    for (let i = 1; i < coords.length; i++) {
      if (geo.segmentIntersectsCircle(coords[i - 1], coords[i], circle)) return true;
    }
    return false;
  };

  geo.polylineLength = function (coords) {
    if (!coords || coords.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += geo.haversineMi(coords[i - 1], coords[i]);
    return total;
  };

  // Position at `fraction` (0..1) of the polyline's length, with the heading of that segment.
  // Returns null for an empty polyline. Used for truck animation.
  geo.interpolateAlong = function (coords, fraction) {
    if (!coords || !coords.length) return null;
    const pts = coords.map(ll);
    if (pts.length === 1) return { lat: pts[0].lat, lon: pts[0].lon, bearing: 0 };
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const d = geo.haversineMi(pts[i - 1], pts[i]); seg.push(d); total += d; }
    const f = fraction > 1 ? 1 : fraction > 0 ? fraction : 0;
    if (total === 0) return { lat: pts[0].lat, lon: pts[0].lon, bearing: 0 };
    const target = f * total;
    let acc = 0, lastBearing = 0;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === 0) continue;
      lastBearing = geo.bearing(pts[i], pts[i + 1]);
      if (acc + seg[i] >= target) {
        const t = (target - acc) / seg[i];
        return {
          lat: pts[i].lat + t * (pts[i + 1].lat - pts[i].lat),
          lon: pts[i].lon + t * wrapLonDelta(pts[i + 1].lon - pts[i].lon),
          bearing: lastBearing
        };
      }
      acc += seg[i];
    }
    const last = pts[pts.length - 1];
    return { lat: last.lat, lon: last.lon, bearing: lastBearing };
  };

  // Nearest grid point to `point`, optionally restricted by filterFn(gridPoint, index).
  // Returns a copy of the grid entry plus { gridId, index, distMi }, or null when none qualifies.
  geo.nearestGrid = function (point, grid, filterFn) {
    let best = null, bestD = Infinity, bestI = -1;
    for (let i = 0; i < (grid || []).length; i++) {
      const g = grid[i];
      if (filterFn && !filterFn(g, i)) continue;
      const d = geo.haversineMi(point, g);
      if (d < bestD) { bestD = d; best = g; bestI = i; }
    }
    if (!best) return null;
    return Object.assign({}, best, { gridId: best.id, index: bestI, distMi: bestD });
  };

  // ---- polygons --------------------------------------------------------------------------
  function isPos(x) { return (Array.isArray(x) && typeof x[0] === 'number') || (!!x && !Array.isArray(x) && typeof x.lat === 'number'); }
  function posXY(p) { return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: (p.lon !== undefined ? p.lon : p.lng), y: p.lat }; }

  function inRing(pt, ring) {
    let inside = false;
    const x = pt.lon, y = pt.lat;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = posXY(ring[i]), b = posXY(ring[j]);
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function inRings(pt, rings) {      // first ring outer, the rest holes
    if (!rings.length || !inRing(pt, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) if (inRing(pt, rings[h])) return false;
    return true;
  }

  // Point-in-polygon by ray casting. `polygon` may be:
  //   a ring [[lon, lat], ...] or [{lat, lon}, ...];
  //   GeoJSON Polygon coordinates [outer, hole...]; MultiPolygon coordinates;
  //   a GeoJSON Polygon / MultiPolygon / Feature / FeatureCollection / GeometryCollection object.
  geo.pointInPolygon = function (point, polygon) {
    const pt = ll(point);
    if (!polygon) return false;
    if (!Array.isArray(polygon)) {
      switch (polygon.type) {
        case 'FeatureCollection': return (polygon.features || []).some(function (f) { return geo.pointInPolygon(pt, f); });
        case 'Feature': return geo.pointInPolygon(pt, polygon.geometry);
        case 'GeometryCollection': return (polygon.geometries || []).some(function (g) { return geo.pointInPolygon(pt, g); });
        case 'Polygon': return inRings(pt, polygon.coordinates || []);
        case 'MultiPolygon': return (polygon.coordinates || []).some(function (p) { return inRings(pt, p); });
        default: return false;
      }
    }
    if (!polygon.length) return false;
    if (isPos(polygon[0])) return inRing(pt, polygon);
    if (isPos(polygon[0][0])) return inRings(pt, polygon);
    return polygon.some(function (p) { return inRings(pt, p); });
  };

  // ---- bounding boxes (quick rejects) ----------------------------------------------------
  geo.bboxOf = function (coords) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < (coords || []).length; i++) {
      const p = ll(coords[i]);
      if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
    }
    return { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon };
  };

  // Conservative test: could the circle touch the box? (false means it certainly does not)
  geo.bboxNearCircle = function (bbox, circle) {
    const dLat = circle.radiusMi / geo.MI_PER_DEG_LAT * 1.01 + 1e-9;
    const cosLat = Math.max(0.01, Math.cos(Math.min(89, Math.abs(circle.lat) + dLat) * D2R));
    const dLon = dLat / cosLat;
    return !(circle.lat + dLat < bbox.minLat || circle.lat - dLat > bbox.maxLat ||
             circle.lon + dLon < bbox.minLon || circle.lon - dLon > bbox.maxLon);
  };

  // ---- encoded polylines (Google / OSRM polyline5 format) ---------------------------------
  geo.decodePolyline = function (str, precision) {
    const factor = Math.pow(10, precision === undefined ? 5 : precision);
    const out = [];
    let index = 0, lat = 0, lon = 0;
    while (index < str.length) {
      let result = 0, shift = 0, byte;
      do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      result = 0; shift = 0;
      do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push([lat / factor, lon / factor]);
    }
    return out;
  };

  geo.encodePolyline = function (coords, precision) {
    const factor = Math.pow(10, precision === undefined ? 5 : precision);
    let out = '', pLat = 0, pLon = 0;
    function enc(v) {
      v = v < 0 ? ~(v << 1) : (v << 1);
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    }
    for (let i = 0; i < (coords || []).length; i++) {
      const p = ll(coords[i]);
      const la = Math.round(p.lat * factor), lo = Math.round(p.lon * factor);
      out += enc(la - pLat) + enc(lo - pLon);
      pLat = la; pLon = lo;
    }
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
