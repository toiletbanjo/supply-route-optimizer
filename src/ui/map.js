// Shared Leaflet map component for both roles (DESIGN.md sections 6 and 8).
//
//   const m = SRO.ui.map.create(el, { theme, tiles: true, compact: false, controls: true, scale: true })
//   m.setZones(zones)                         closed = gray hatching + red outline; risk = amber..red fill + rating label (none on compact maps)
//   m.setHubs(hubs, { labels })               2525 supply installation symbols; the names (labels: false = none)
//                                             draw above the platoon symbols
//   m.setRally(points, { walkRingMi })        [{ id|gridId, lat, lon, label, used, pinned, banned, walkRingMi }]
//   m.setPlatoons(requests, { selectedId, labels, clearOf, clearPx })
//                                             2525 platoon symbols on urgency rings; labels: false = no designator;
//                                             clearOf: [{ lat, lon, rally }...] points a symbol must not cover (a pickup
//                                             point; rally: true = a drop point symbol standing above its point):
//                                             within clearPx it is drawn beside them with a leader line
//   m.setRoutes(routes, { highlightTruckId, stopLabels }) [{ truckId, color, label?, summary?,
//                                               legs: [{ coords: [[lat, lon]...] | path: 'encoded polyline', source, approximate }]
//                                               | coords | path, stops: [{ lat, lon, seq, label, mine }] }]
//                                             plan.routes can be passed as they are (leg.path, precision 5, is decoded
//                                             and cached). Routes sharing a road are drawn side by side in lanes.
//                                             A stop with mine: true gets a larger badge filled in the route color,
//                                             above the drop point symbols; stopLabels: 'mine' draws the other stops
//                                             as plain dots (compact maps)
//   m.setTrucks([{ id, color, lat, lon, heading, label, type }], { clearOf, clearPx })   updated in place
//                                             (animation); clearOf as for platoons, without the leader line (a truck
//                                             at its hub is drawn beside the hub symbol)
//   m.fitTaiwan({ padBottom }), m.fitTo(bounds | [[lat, lon], ...] | [{ lat, lon }, ...], { clearControls, iconPad,
//                                             padBottom, padTop, ... }), m.setView([lat, lon], zoom); clearControls keeps the
//                                             points clear of the zoom buttons and attribution with iconPad px (22) for
//                                             their symbols; padBottom keeps px free at the bottom edge (a hint over the
//                                             map), padTop at the top (drop point symbols stand above their points)
//                                             a map made with no size (hidden tab) fits Taiwan once it has one, unless
//                                             the caller set a view; a view set while it has no size is applied again then
//   m.on('click:zone' | 'click:route' | 'click:platoon' | 'click:hub' | 'click:rally' | 'click:truck' | 'click:map' | 'tiles', fn) -> off()
//   m.enableZoneDrawing({ kind: 'closed' | 'risk', rating, onDone({ kind, rating, lat, lon, radiusMi }), onCancel }) -> { cancel }
//   m.setTheme('dark' | 'light' | 'night') (also follows html[data-theme] unless opts.followDocumentTheme === false),
//   m.setRoadsVisible(bool), m.setTilesEnabled(bool)
//   m.status() -> { tiles: 'loading' | 'on' | 'off', reason, roads: bool }, m.invalidateSize(), m.leaflet
//   m.destroy()   safe at any time (same task as create, during a zoom animation); later calls are no-ops
//
//   SRO.ui.map.truckPosition(route, simMin) -> { lat, lon, heading, legIndex, status: 'at-hub' | 'en-route' | 'at-stop' | 'returned' }
//     (legs with coords or an encoded leg.path, as in a stored plan)
//   SRO.ui.map.legCoords(leg) -> [[lat, lon]...] | null   SRO.ui.map.decodePath(encoded) (cached)
//
// Base map: OpenStreetMap tiles when they load (needs the app served over http(s)); always underneath,
// the Natural Earth coastline on a sea-colored background; the road graph (SRO.core.roads) drawn as thin
// vector lines, always visible when tiles are off and toggleable when tiles are on. Tile fallback rules
// (docs/VERIFICATION.md): offline at start or 'offline' event; 4 tile errors before any load; no tile
// after 8 s; a fetch() of the centre tile that is not ok (catches a 403 with an image body). The layer
// is re-added on 'online'. No tile prefetching or caching (OSM tile policy).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.ui = SRO.ui || {};
  const MAP = SRO.ui.map = SRO.ui.map || {};

  const MI = 1609.344;
  MAP.TAIWAN_BOUNDS = [[21.88, 120.02], [25.32, 122.02]];
  MAP.MAX_BOUNDS = [[20.6, 118.2], [26.6, 123.4]];
  MAP.OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  MAP.FILE_TILES = !!root.__sroFileTiles;   // test harness only: allow tiles on a file:// page
  MAP.OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  MAP.ROADS_ATTRIBUTION = 'Road data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL), via <a href="https://overturemaps.org">Overture Maps Foundation</a>';
  MAP.COAST_ATTRIBUTION = 'Coastline: <a href="https://www.naturalearthdata.com">Natural Earth</a>';
  // compact maps (PSG tracking card): same credits, fewer words
  MAP.ROADS_ATTRIBUTION_SHORT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL) via <a href="https://overturemaps.org">Overture</a>';
  MAP.COAST_ATTRIBUTION_SHORT = '<a href="https://www.naturalearthdata.com">Natural Earth</a>';
  MAP.TILE_TIMEOUT_MS = 8000;
  MAP.TILE_ERROR_LIMIT = 4;
  MAP.MIN_ZONE_MI = 0.5;
  MAP.MAX_ZONE_MI = 60;
  MAP.DISMOUNTED_RING_MI = 5;
  MAP.DRAWBAR_NARROW_PX = 560;
  MAP.ROUTE_LANE_PX = 4;           // gap between routes that share a road (screen px)

  // Vector colors per theme (CSS handles controls, tiles and symbols).
  MAP.THEMES = {
    dark: {
      sea: '#0a0f13', land: '#161e25', coast: '#3a4955',
      road: { motorway: '#8a98a5', trunk: '#6b7a87', primary: '#46535f' },
      roadWeight: { motorway: 1.7, trunk: 1.3, primary: 0.8 },
      closed: '#ef5350', hatch: '#7d8a96', risk: { Low: '#d9a521', Medium: '#ea8a26', High: '#ef5350' },
      casing: '#0a0f13', arrow: '#0a0f13', walk: '#9fb1c0', accent: '#6fbf8a', routeOpacity: 0.95, dim: 0.28
    },
    light: {
      sea: '#c8d8e2', land: '#f5f3ee', coast: '#93a2ae',
      road: { motorway: '#8c8173', trunk: '#a59c8f', primary: '#c7c0b4' },
      roadWeight: { motorway: 1.7, trunk: 1.3, primary: 0.8 },
      closed: '#d32f2f', hatch: '#8a949d', risk: { Low: '#c99700', Medium: '#e07000', High: '#d32f2f' },
      casing: '#ffffff', arrow: '#ffffff', walk: '#4c5d6b', accent: '#2f7d4f', routeOpacity: 0.95, dim: 0.3
    },
    night: {
      sea: '#000000', land: '#0d0404', coast: '#3a1010',
      road: { motorway: '#5e1b18', trunk: '#4a1513', primary: '#33100e' },
      roadWeight: { motorway: 1.6, trunk: 1.2, primary: 0.8 },
      closed: '#c0302a', hatch: '#5e1b18', risk: { Low: '#8a6a12', Medium: '#995216', High: '#b02a24' },
      casing: '#000000', arrow: '#000000', walk: '#7a2420', accent: '#b8342d', routeOpacity: 0.78, dim: 0.25
    }
  };

  // ---- leg paths -------------------------------------------------------------------------------
  // Plans store each leg's road path as an encoded polyline (leg.path, precision 5, DESIGN.md 8b);
  // views may also pass decoded coordinates (leg.coords). Decoded strings are cached (the clock asks
  // for truck positions on every tick), oldest first out. Callers must not modify the arrays returned.
  MAP.PATH_PRECISION = 5;
  MAP.PATH_CACHE_MAX = 600;
  const pathCache = new Map();
  MAP.decodePath = function (str) {
    if (typeof str !== 'string' || !str) return null;
    let c = pathCache.get(str);
    if (c) return c;
    try { c = SRO.core.geo.decodePolyline(str, MAP.PATH_PRECISION); } catch (e) { c = null; }
    if (!c || !c.length) return null;
    if (pathCache.size >= MAP.PATH_CACHE_MAX) pathCache.delete(pathCache.keys().next().value);
    pathCache.set(str, c);
    return c;
  };
  MAP.pathCacheSize = function () { return pathCache.size; };
  // [[lat, lon], ...] of a leg (or route): coords array, else path (encoded string or array), else null
  function pathOf(x) {
    if (!x) return null;
    if (Array.isArray(x.coords) && x.coords.length) return x.coords;
    if (typeof x.path === 'string') return MAP.decodePath(x.path);
    if (Array.isArray(x.path) && x.path.length) return x.path;
    return null;
  }
  MAP.legCoords = pathOf;

  // ---- truck position along a timed route (pure, used for the demo clock) -----------------------
  function legCoords(leg) {
    if (!leg) return null;
    const c = pathOf(leg);
    if (c && c.length) return c;
    if (leg.from && leg.to) return [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
    return null;
  }
  function pt(p) { return Array.isArray(p) ? { lat: +p[0], lon: +p[1] } : { lat: +p.lat, lon: +(p.lon !== undefined ? p.lon : p.lng) }; }
  function endBearing(coords) {
    const G = SRO.core.geo;
    for (let i = coords.length - 1; i > 0; i--) {
      const a = pt(coords[i - 1]), b = pt(coords[i]);
      if (a.lat !== b.lat || a.lon !== b.lon) return G.bearing(a, b);
    }
    return 0;
  }
  function startBearing(coords) {
    const G = SRO.core.geo;
    for (let i = 1; i < coords.length; i++) {
      const a = pt(coords[i - 1]), b = pt(coords[i]);
      if (a.lat !== b.lat || a.lon !== b.lon) return G.bearing(a, b);
    }
    return 0;
  }

  MAP.truckPosition = function (route, simMin) {
    const G = SRO.core.geo;
    if (typeof simMin !== 'number' || !isFinite(simMin)) return null;   // e.g. clock not set yet: no position, not 'returned'
    let legs = ((route && route.legs) || []).filter(function (l) { return isFinite(l.depart) && isFinite(l.arrive) && legCoords(l); });
    const whole = !legs.length && route ? pathOf(route) : null;
    if (whole && whole.length && isFinite(route.depart)) {
      legs = [{ coords: whole, depart: route.depart, arrive: isFinite(route.returnAt) ? route.returnAt : route.depart }];
    }
    if (!legs.length) return null;
    const first = legCoords(legs[0]), lastLeg = legs[legs.length - 1], lastC = legCoords(lastLeg);
    if (simMin < legs[0].depart) {
      const p = pt(first[0]);
      return { lat: p.lat, lon: p.lon, heading: startBearing(first), legIndex: -1, status: 'at-hub' };
    }
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i], c = legCoords(L);
      if (simMin < L.depart) {
        const pc = legCoords(legs[i - 1]), p = pt(pc[pc.length - 1]);
        return { lat: p.lat, lon: p.lon, heading: endBearing(pc), legIndex: i - 1, status: 'at-stop' };
      }
      if (simMin < L.arrive) {
        const f = L.arrive > L.depart ? (simMin - L.depart) / (L.arrive - L.depart) : 1;
        const q = G.interpolateAlong(c, f);
        return { lat: q.lat, lon: q.lon, heading: q.bearing, legIndex: i, status: 'en-route' };
      }
    }
    const end = pt(lastC[lastC.length - 1]), home = pt(first[0]);
    const back = G.haversineMi(end, home) < 0.15;
    return { lat: end.lat, lon: end.lon, heading: endBearing(lastC), legIndex: legs.length - 1, status: back ? 'returned' : 'at-stop' };
  };

  // ---- CSS -------------------------------------------------------------------------------------
  MAP.CSS = [
    '.sro-map{container-type:inline-size;position:relative;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent}',
    '.sro-map.leaflet-container{background:var(--sro-sea);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.sro-map[data-sro-theme="dark"]{--sro-sea:#0a0f13;--sro-ctl-bg:#161d23;--sro-ctl-bg2:#1e272f;--sro-ctl-fg:#e3e8ec;--sro-ctl-muted:#8e9aa5;--sro-ctl-border:#2b3640;--sro-accent:#6fbf8a;--sro-sel:#e8ecef;--sro-sel-gap:#0a0f13;--sro-badge-bg:#e8ecef;--sro-badge-fg:#0b1014;--sro-label-bg:rgba(10,15,19,.82)}',
    '.sro-map[data-sro-theme="light"]{--sro-sea:#c8d8e2;--sro-ctl-bg:#ffffff;--sro-ctl-bg2:#f2f4f6;--sro-ctl-fg:#1b2329;--sro-ctl-muted:#5c6973;--sro-ctl-border:#cfd6dc;--sro-accent:#2f7d4f;--sro-sel:#1b2329;--sro-sel-gap:#ffffff;--sro-badge-bg:#1b2329;--sro-badge-fg:#ffffff;--sro-label-bg:rgba(255,255,255,.88)}',
    '.sro-map[data-sro-theme="night"]{--sro-sea:#000000;--sro-ctl-bg:#0a0303;--sro-ctl-bg2:#140505;--sro-ctl-fg:#b8342d;--sro-ctl-muted:#a8443c;--sro-ctl-border:#3a100e;--sro-accent:#b8342d;--sro-sel:#c23a32;--sro-sel-gap:#000000;--sro-label-bg:rgba(0,0,0,.85)}',
    // tiles: dimmed / tinted per theme (light discipline at night)
    '.sro-map[data-sro-theme="dark"] .sro-tiles{filter:invert(1) hue-rotate(180deg) brightness(.9) contrast(.85) saturate(.45)}',
    '.sro-map[data-sro-theme="night"] .sro-tiles{filter:invert(1) grayscale(1) brightness(.42) sepia(1) hue-rotate(-50deg) saturate(5) contrast(1.1)}',
    '.sro-map[data-sro-theme="night"] .sro-pane-routes{opacity:.75}',
    // controls
    '.sro-map .leaflet-bar{border:1px solid var(--sro-ctl-border);border-radius:6px;box-shadow:none;overflow:hidden}',
    '.sro-map .leaflet-bar a,.sro-map .leaflet-bar a:hover{background:var(--sro-ctl-bg);color:var(--sro-ctl-fg);border-bottom:1px solid var(--sro-ctl-border);width:34px;height:34px;line-height:34px;font-size:18px}',
    '.sro-map .leaflet-bar a:hover{background:var(--sro-ctl-bg2)}',
    '.sro-map .leaflet-bar a:last-child{border-bottom:0}',
    '.sro-map .leaflet-bar a.leaflet-disabled{background:var(--sro-ctl-bg);color:var(--sro-ctl-muted);opacity:.6}',
    '.sro-map .leaflet-control-attribution{background:var(--sro-label-bg);color:var(--sro-ctl-muted);font-size:10px;line-height:1.35;padding:1px 6px;max-width:calc(100vw - 24px);border-top-left-radius:6px}',
    '.sro-map .leaflet-control-attribution a{color:var(--sro-ctl-fg);text-decoration:none}',
    '.sro-map.sro-compact .leaflet-control-attribution{background:var(--sro-ctl-bg);font-size:9.5px;line-height:1.3;padding:2px 6px}',
    '.sro-map .leaflet-control-scale-line{background:var(--sro-label-bg);color:var(--sro-ctl-fg);border-color:var(--sro-ctl-muted);font-size:10px;font-variant-numeric:tabular-nums}',
    '.sro-basemap{display:flex;gap:0;border:1px solid var(--sro-ctl-border);border-radius:6px;overflow:hidden;background:var(--sro-ctl-bg)}',
    '.sro-basemap button{appearance:none;border:0;border-right:1px solid var(--sro-ctl-border);background:var(--sro-ctl-bg);color:var(--sro-ctl-muted);font:600 11px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:0 10px;height:34px;min-width:52px;cursor:pointer}',
    '.sro-basemap button:last-child{border-right:0}',
    '.sro-basemap button[aria-pressed="true"]{color:var(--sro-ctl-fg);background:var(--sro-ctl-bg2);box-shadow:inset 0 -2px 0 var(--sro-accent)}',
    '.sro-basemap button:disabled{cursor:default;opacity:.55}',
    '.sro-basemap button:focus-visible,.sro-map .leaflet-bar a:focus-visible,.sro-drawbar button:focus-visible{outline:2px solid var(--sro-accent);outline-offset:-2px}',
    '.sro-note{background:var(--sro-label-bg);color:var(--sro-ctl-muted);border:1px solid var(--sro-ctl-border);border-radius:6px;padding:4px 8px;font-size:11px;line-height:1.3;max-width:240px}',
    '.sro-note b{color:var(--sro-ctl-fg);font-weight:600}',
    '.sro-note-short{display:none}',
    // narrow: the short note, and room beside it for a control in the bottom-right corner (the planner legend)
    '@container (max-width:560px){.sro-map .leaflet-control-scale{display:none}.sro-map .leaflet-bottom.leaflet-left{bottom:30px}.sro-note-long{display:none}.sro-note-short{display:inline}.sro-note{max-width:calc(100cqw - 150px)}}',
    '@media (pointer:coarse){.sro-map .leaflet-bar a,.sro-map .leaflet-bar a:hover{width:44px;height:44px;line-height:44px;font-size:20px}.sro-basemap button{height:44px;min-width:56px}}',
    // zones
    '.sro-zone-label{display:inline-block;transform:translate(-50%,0);white-space:nowrap;max-width:200px;max-width:min(240px,60cqw);overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;font:700 10px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:3px 5px;border-radius:4px;background:var(--sro-label-bg);border:1px solid var(--sro-zone-c);color:var(--sro-zone-c);pointer-events:none}',
    '.sro-zone-label-icon{background:none;border:0}',
    '.sro-zone-label-icon.sro-hidden{display:none}',
    // stops
    '.sro-stop-icon{background:none;border:0}',
    '.sro-stop{box-sizing:border-box;width:20px;height:20px;border-radius:50%;background:var(--sro-ctl-bg);border:2px solid var(--sro-stop);color:var(--sro-ctl-fg);font:700 11px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;text-align:center}',
    '.sro-stop-dim{opacity:.35}',
    '.sro-stop-dot{width:12px;height:12px}',
    // the platoon sergeant's own stop: larger, filled in the route color, with a gap ring
    '.sro-stop-mine{width:26px;height:26px;background:var(--sro-stop);color:var(--sro-stop-fg,#fff);border:2px solid var(--sro-sel-gap);box-shadow:0 0 0 2px var(--sro-stop),0 1px 4px rgba(0,0,0,.45);font-size:13px;line-height:22px}',
    '.sro-map[data-sro-theme="night"] .sro-stop-mine{background:#000;color:var(--sro-ctl-fg);border-color:var(--sro-sel);box-shadow:0 0 0 2px #000}',
    // hub names above the platoon symbols: milsymbol's outlined text only, the frame hidden
    '.sro-icon-hublabel path,.sro-icon-hublabel circle,.sro-icon-hublabel ellipse,.sro-icon-hublabel rect,.sro-icon-hublabel line,.sro-icon-hublabel polyline,.sro-icon-hublabel polygon{display:none}',
    // a symbol drawn beside its true position (clearOf): leader line and a dot on the spot
    '.sro-leader{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
    '.sro-leader line{stroke:var(--sro-sel);stroke-width:1.5;stroke-dasharray:3 2}',
    '.sro-leader circle{fill:var(--sro-sel);stroke:var(--sro-sel-gap);stroke-width:1.5}',
    '.sro-route-dim{opacity:.3}',
    // tooltips
    '.sro-map .leaflet-tooltip.sro-tip{background:var(--sro-ctl-bg);color:var(--sro-ctl-fg);border:1px solid var(--sro-ctl-border);border-radius:6px;box-shadow:none;font-size:12px;padding:4px 7px}',
    '.sro-map .leaflet-tooltip.sro-tip::before{display:none}',
    // drawing
    '.sro-map.sro-drawing,.sro-map.sro-drawing .leaflet-interactive{cursor:crosshair!important}',
    '.leaflet-container.sro-map.sro-drawing{touch-action:none}',
    '.sro-drawbar{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:1000;display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);background:var(--sro-ctl-bg);color:var(--sro-ctl-fg);border:1px solid var(--sro-ctl-border);border-radius:8px;padding:6px 6px 6px 12px;font-size:13px;box-sizing:border-box}',
    '.sro-drawbar span{flex:1 1 auto;min-width:0}',
    '.sro-drawbar b{font-variant-numeric:tabular-nums}',
    '.sro-drawbar button{appearance:none;border:1px solid var(--sro-ctl-border);background:var(--sro-ctl-bg2);color:var(--sro-ctl-fg);border-radius:6px;font:600 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:0 12px;height:34px;cursor:pointer;flex:0 0 auto}',
    '.sro-drawbar-bottom{top:auto;left:10px;right:10px;transform:none;max-width:none}',
    '.sro-map.sro-drawing .sro-note{display:none}',
    '@media (pointer:coarse){.sro-drawbar button{height:44px}}',
    '.sro-defs{position:absolute;width:0;height:0;overflow:hidden}',
    '.sro-pane-roads canvas{image-rendering:auto}'
  ].join('\n');

  MAP.ensureStyles = function (doc) {
    doc = doc || root.document;
    if (!doc || doc.getElementById('sro-map-css')) return;
    const st = doc.createElement('style');
    st.id = 'sro-map-css';
    st.textContent = MAP.CSS;
    (doc.head || doc.documentElement).appendChild(st);
    if (SRO.ui.symbols && SRO.ui.symbols.ensureStyles) SRO.ui.symbols.ensureStyles(doc);
  };

  let uidSeq = 0;
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toLatLng(p) {
    if (!p) return null;
    if (Array.isArray(p)) return [+p[0], +p[1]];
    const lon = p.lon !== undefined ? p.lon : p.lng;
    return [+p.lat, +lon];
  }
  function finitePt(p) { return p && isFinite(p[0]) && isFinite(p[1]); }

  // Leaflet 1.9.4 canvas renderer, made safe to remove at any time. Canvas._redraw run synchronously
  // (_updatePaths after a view reset, e.g. setView / fitBounds without animation) forgets the frame an
  // earlier _requestRedraw scheduled without cancelling it, so _destroyContainer cannot cancel it either;
  // when the map was removed before that frame, it ran with no 2D context and threw "Cannot read
  // properties of undefined (reading 'save')". This class cancels the outstanding frame on every redraw,
  // ignores a redraw or draw with no context, and forgets the cancelled frame on removal (so a renderer
  // added again can redraw).
  let SafeCanvas = null;
  function safeCanvas(L, o) {
    if (!SafeCanvas) {
      const base = L.Canvas.prototype;
      SafeCanvas = L.Canvas.extend({
        _redraw: function () {
          if (this._redrawRequest) { L.Util.cancelAnimFrame(this._redrawRequest); this._redrawRequest = null; }
          if (!this._ctx || !this._map) { this._redrawBounds = null; return; }
          base._redraw.call(this);
        },
        _draw: function () { if (this._ctx) base._draw.call(this); },
        _destroyContainer: function () { base._destroyContainer.call(this); this._redrawRequest = null; this._redrawBounds = null; }
      });
    }
    return new SafeCanvas(o);
  }

  // =============================================================================================
  MAP.create = function (el, options) {
    const L = root.L;
    if (!L) throw new Error('Leaflet (L) is not loaded');
    if (!el) throw new Error('SRO.ui.map.create: no element');
    const opts = Object.assign({ tiles: true, compact: false, controls: true, scale: true, zoomControl: true }, options || {});
    const doc = el.ownerDocument || root.document;
    MAP.ensureStyles(doc);
    const uid = ++uidSeq;
    const symbols = SRO.ui.symbols;
    const roadsCore = SRO.core.roads;

    let theme = MAP.THEMES[opts.theme] ? opts.theme : (MAP.THEMES[doc.documentElement.getAttribute('data-theme')] ? doc.documentElement.getAttribute('data-theme') : 'dark');
    el.classList.add('sro-map');
    el.classList.toggle('sro-compact', !!opts.compact);
    el.setAttribute('data-sro-theme', theme);

    let destroyed = false;         // every deferred callback (tiles, probe, observers, frames) checks this
    const map = L.map(el, {
      zoomControl: false, attributionControl: false, minZoom: 6, maxZoom: 18,
      maxBounds: MAP.MAX_BOUNDS, maxBoundsViscosity: 0.8, zoomSnap: 0.25, zoomDelta: 1,
      wheelPxPerZoomLevel: 90, worldCopyJump: false, tapTolerance: 12
    });

    // ---- view bookkeeping --------------------------------------------------------------------------
    // The component fits Taiwan the first time the element has a size (a map made inside a hidden tab
    // has none), unless the caller set a view first (fitTo, fitTaiwan, setView, or leaflet.setView /
    // fitBounds / flyTo). A view set while the element has no size is meaningless (Leaflet fits a 0 x 0
    // box), so the last such call is applied again as soon as the element has a size.
    let internalView = 0;          // > 0 while the component itself moves the view
    let callerView = false;        // the caller has set a view
    let pendingView = null;        // { fn } the caller's last view change while the element had no size
    function hasSize() { return el.clientWidth > 0 && el.clientHeight > 0; }
    function internally(fn) { internalView++; try { return fn(); } finally { internalView--; } }
    // Leaflet caches the container size until invalidateSize(); a fit computed with a stale 0 x 0 size
    // lands at maximum zoom
    function freshSize() { const s = map.getSize(); if (hasSize() && (s.x !== el.clientWidth || s.y !== el.clientHeight)) map.invalidateSize({ pan: false }); }
    // fn runs the view change; replay (optional) re-runs it once the element has a size
    function callerSetsView(fn, replay) {
      if (internalView) return fn();
      callerView = true;
      pendingView = hasSize() ? null : { fn: replay || fn };
      freshSize();
      return internally(fn);
    }
    ['setView', 'fitBounds', 'flyTo', 'flyToBounds'].forEach(function (k) {
      const orig = map[k];
      map[k] = function () {
        const args = arguments, self = this;
        if (internalView || destroyed) return orig.apply(self, args);
        return callerSetsView(function () { return orig.apply(self, args); }, function () {
          // replayed without animation: the element just got its size
          const a = Array.prototype.slice.call(args);
          const oi = k === 'setView' || k === 'flyTo' ? 2 : 1;
          a[oi] = Object.assign({}, a[oi] && typeof a[oi] === 'object' ? a[oi] : {}, { animate: false });
          return orig.apply(self, a);
        });
      };
    });
    internally(function () { map.fitBounds(MAP.TAIWAN_BOUNDS, { padding: [8, 8], animate: false }); });

    // panes (z-index): coast 150 < tiles 200 < roads 250 < zones 380 < walk 390 < routes 410 <
    // labels 590 < stops 595 < rally 605 < hubs 610 < own stop 612 < platoons 620 < hub names 630 <
    // trucks 640 < draw 650
    const PANES = { coast: 150, roads: 250, zones: 380, walk: 390, routes: 410, labels: 590, stops: 595, rally: 605, hubs: 610, mystop: 612, platoons: 620, hublabels: 630, trucks: 640, draw: 650 };
    Object.keys(PANES).forEach(function (k) {
      const p = map.createPane('sro-' + k);
      p.style.zIndex = PANES[k];
      p.classList.add('sro-pane-' + k);
      if (k === 'coast' || k === 'roads' || k === 'walk' || k === 'labels' || k === 'hublabels' || k === 'mystop') p.style.pointerEvents = 'none';
    });

    // hatch pattern for closed zones (instance-unique id)
    const hatchId = 'sro-hatch-' + uid;
    const defs = doc.createElement('div');
    defs.className = 'sro-defs';
    defs.innerHTML = '<svg width="0" height="0" aria-hidden="true" focusable="false"><defs><pattern id="' + hatchId +
      '" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)"><rect width="9" height="9" fill="transparent"/>' +
      '<line x1="0" y1="0" x2="0" y2="9" stroke-width="3"/></pattern></defs></svg>';
    el.appendChild(defs);
    const hatchLine = defs.querySelector('line');

    // ---- events --------------------------------------------------------------------------------
    const handlers = {};
    function on(evt, fn) {
      (handlers[evt] = handlers[evt] || []).push(fn);
      return function () { off(evt, fn); };
    }
    function off(evt, fn) { const h = handlers[evt]; if (h) { const i = h.indexOf(fn); if (i >= 0) h.splice(i, 1); } }
    function emit(evt, payload) {
      (handlers[evt] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { if (root.console) root.console.error(e); }
      });
    }

    // ---- controls --------------------------------------------------------------------------------
    const attribution = L.control.attribution({ prefix: opts.compact ? false : '<a href="https://leafletjs.com">Leaflet</a>', position: 'bottomright' }).addTo(map);
    attribution.addAttribution(opts.compact ? MAP.ROADS_ATTRIBUTION_SHORT : MAP.ROADS_ATTRIBUTION);
    if (opts.zoomControl) L.control.zoom({ position: 'topleft', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map);
    if (opts.scale && !opts.compact) L.control.scale({ position: 'bottomleft', metric: false, imperial: true, maxWidth: 110 }).addTo(map);

    // ---- base layers -------------------------------------------------------------------------------
    const pal = function () { return MAP.THEMES[theme]; };
    let coastLayer = null;
    if (SRO.data && SRO.data.taiwan_coast) {
      coastLayer = L.geoJSON(SRO.data.taiwan_coast, { pane: 'sro-coast', interactive: false, style: coastStyle }).addTo(map);
      attribution.addAttribution(opts.compact ? MAP.COAST_ATTRIBUTION_SHORT : MAP.COAST_ATTRIBUTION);
    }
    function coastStyle() { const t = pal(); return { color: t.coast, weight: 1.2, fillColor: t.land, fillOpacity: 1, opacity: 1 }; }

    const roadRenderer = safeCanvas(L, { pane: 'sro-roads', padding: 0.4 });
    let roadLayer = null;
    function buildRoads() {
      if (roadLayer) { map.removeLayer(roadLayer); roadLayer = null; }
      const lines = roadsCore && roadsCore.networkLines ? roadsCore.networkLines() : null;
      if (!lines) return;
      const t = pal();
      roadLayer = L.layerGroup();
      ['primary', 'trunk', 'motorway'].forEach(function (cls) {
        if (!lines[cls] || !lines[cls].length) return;
        L.polyline(lines[cls], {
          pane: 'sro-roads', renderer: roadRenderer, interactive: false, smoothFactor: 1.2,
          color: t.road[cls], weight: t.roadWeight[cls], opacity: 1, lineCap: 'round', lineJoin: 'round'
        }).addTo(roadLayer);
      });
    }

    // tiles + fallback detection
    const tiles = { layer: null, state: 'off', reason: 'init', loads: 0, errors: 0, timer: null, wanted: opts.tiles !== false, probeSeq: 0 };
    let roadsPref = false;          // user wants road lines on top of tiles
    function tilesLayer() {
      if (!tiles.layer) {
        tiles.layer = L.tileLayer(MAP.OSM_URL, { maxZoom: 19, attribution: MAP.OSM_ATTRIBUTION, className: 'sro-tiles', keepBuffer: 2 });
        // a removed tile layer still reports tiles that finish loading (or fail) later
        tiles.layer.on('tileload', function () {
          if (destroyed) return;
          tiles.loads++;
          if (tiles.state === 'loading') { tiles.state = 'on'; tiles.reason = null; clearTimeout(tiles.timer); syncBase(); emit('tiles', status()); }
        });
        tiles.layer.on('tileerror', function () {
          if (destroyed) return;
          tiles.errors++;
          if (tiles.state === 'loading' && tiles.errors >= MAP.TILE_ERROR_LIMIT && tiles.loads === 0) fallback('errors');
        });
      }
      return tiles.layer;
    }
    function startTiles() {
      if (destroyed) return;
      if (!tiles.wanted) { tiles.state = 'off'; tiles.reason = 'disabled'; syncBase(); return; }
      if (root.navigator && root.navigator.onLine === false) { fallback('offline'); return; }
      // A page opened from a file sends no Referer, and OSM answers every tile with a 403
      // "tile usage policy" image (DESIGN section 6), so skip tiles there.
      if (root.location && root.location.protocol === 'file:' && !MAP.FILE_TILES) { fallback('file'); return; }
      tiles.state = 'loading'; tiles.reason = null; tiles.loads = 0; tiles.errors = 0;
      const layer = tilesLayer();
      if (!map.hasLayer(layer)) map.addLayer(layer);
      clearTimeout(tiles.timer);
      tiles.timer = setTimeout(function () { if (!destroyed && tiles.state === 'loading' && tiles.loads === 0) fallback('timeout'); }, MAP.TILE_TIMEOUT_MS);
      probe();
      syncBase();
    }
    function probe() {
      if (typeof root.fetch !== 'function') return;
      const seq = ++tiles.probeSeq;
      const z = Math.max(0, Math.round(map.getZoom()));
      const p = map.project(map.getCenter(), z).divideBy(256).floor();
      const url = L.Util.template(MAP.OSM_URL, { z: z, x: p.x, y: p.y });
      try {
        root.fetch(url, { mode: 'cors', credentials: 'omit', cache: 'default' }).then(function (r) {
          if (!destroyed && seq === tiles.probeSeq && !r.ok && tiles.state !== 'off') fallback('blocked');
        }).catch(function () { /* unreadable (CORS) or network: inconclusive, tile events decide */ });
      } catch (e) { /* inconclusive */ }
    }
    function fallback(reason) {
      if (destroyed) return;
      clearTimeout(tiles.timer);
      tiles.probeSeq++;
      if (tiles.layer && map.hasLayer(tiles.layer)) map.removeLayer(tiles.layer);
      tiles.state = 'off'; tiles.reason = reason;
      syncBase();
      emit('tiles', status());
    }
    function onOffline() { if (!destroyed && tiles.wanted && tiles.state !== 'off') fallback('offline'); }
    function onOnline() {
      if (destroyed || !tiles.wanted || tiles.state !== 'off') return;
      startTiles();
      if (tiles.layer) tiles.layer.redraw();
    }
    root.addEventListener && root.addEventListener('offline', onOffline);
    root.addEventListener && root.addEventListener('online', onOnline);

    function roadsVisible() { return tiles.state !== 'on' || roadsPref; }

    // basemap control (tiles / roads toggles) + fallback note
    let baseCtl = null, noteCtl = null;
    if (opts.controls && !opts.compact) {
      const Base = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
          const div = L.DomUtil.create('div', 'sro-basemap leaflet-control');
          div.setAttribute('role', 'group');
          div.setAttribute('aria-label', 'Base map');
          div.innerHTML = '<button type="button" data-k="tiles" title="OpenStreetMap street tiles">Tiles</button><button type="button" data-k="roads" title="Main road network lines">Roads</button>';
          L.DomEvent.disableClickPropagation(div);
          L.DomEvent.disableScrollPropagation(div);
          div.addEventListener('click', function (e) {
            const b = e.target.closest('button');
            if (!b || b.disabled) return;
            // The button shows tiles as on/off (aria-pressed); a tap flips what is shown. After an
            // automatic fallback tiles are still wanted but off, so a tap retries them.
            if (b.getAttribute('data-k') === 'tiles') api.setTilesEnabled(tiles.state === 'off');
            else api.setRoadsVisible(!roadsPref);
          });
          return div;
        }
      });
      baseCtl = new Base().addTo(map);
    }
    {
      const Note = L.Control.extend({
        options: { position: 'bottomleft' },
        onAdd: function () {
          const div = L.DomUtil.create('div', 'sro-note leaflet-control');
          div.setAttribute('role', 'status');
          div.style.display = 'none';
          return div;
        }
      });
      noteCtl = new Note().addTo(map);
    }
    function noteText() {
      if (tiles.state !== 'off' || opts.compact) return '';
      if (tiles.reason === 'disabled' || tiles.reason === 'user') return opts.compact ? '' : '<b>Outline map.</b> Coastline and main roads.';
      const short = '<span class="sro-note-short">Coastline and main roads.</span>';
      if (tiles.reason === 'offline') return '<b>Offline map.</b> <span class="sro-note-long">Coastline and main roads; street tiles return when online.</span>' + short;
      return '<b>Offline map.</b> <span class="sro-note-long">Street tiles unavailable here; showing coastline and main roads.</span>' + short;
    }
    function syncBase() {
      if (destroyed) return;
      const show = roadsVisible();
      if (show && !roadLayer) buildRoads();
      if (roadLayer) {
        if (show && !map.hasLayer(roadLayer)) map.addLayer(roadLayer);
        if (!show && map.hasLayer(roadLayer)) map.removeLayer(roadLayer);
      }
      if (baseCtl) {
        const c = baseCtl.getContainer();
        const bt = c.querySelector('[data-k="tiles"]'), br = c.querySelector('[data-k="roads"]');
        bt.setAttribute('aria-pressed', String(tiles.state !== 'off'));
        bt.title = tiles.state === 'off' && tiles.reason !== 'user' && tiles.reason !== 'disabled' ? 'Street tiles unavailable (tap to retry)' : 'OpenStreetMap street tiles';
        br.setAttribute('aria-pressed', String(show));
        br.disabled = tiles.state !== 'on';
        br.title = tiles.state !== 'on' ? 'Road lines are always shown without street tiles' : 'Main road network lines';
      }
      if (noteCtl) {
        const c = noteCtl.getContainer(), txt = noteText();
        c.innerHTML = txt;
        c.style.display = txt ? '' : 'none';
      }
    }
    function status() { return { tiles: tiles.state, reason: tiles.reason, roads: roadsVisible(), theme: theme, tileLoads: tiles.loads, tileErrors: tiles.errors }; }

    // ---- overlay layers -----------------------------------------------------------------------------
    const groups = {
      zones: L.layerGroup().addTo(map), hubs: L.layerGroup().addTo(map), rally: L.layerGroup().addTo(map),
      walk: L.layerGroup().addTo(map), platoons: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map),
      stops: L.layerGroup().addTo(map), trucks: L.layerGroup().addTo(map), draw: L.layerGroup().addTo(map)
    };
    const data = { zones: [], hubs: [], hubOpts: {}, rally: [], rallyOpts: {}, platoons: [], platoonOpts: {}, routes: [], routeOpts: {}, trucks: [], truckOpts: {} };
    let drawing = null;            // active zone-drawing session

    // Icon sizes by zoom: small at island zoom (phones), full size from zoom 9.5.
    function sizes() {
      const z = map.getZoom(), px = map.getSize(), narrow = Math.min(px.x, px.y) < 520;
      if (z < 7.75 || (narrow && z < 9)) return { key: 's', plt: 16, hub: 18, rally: 16, truck: 16, text: false };
      if (z < 9.5) return { key: 'm', plt: 20, hub: 22, rally: 19, truck: 18, text: true };
      return { key: 'l', plt: 24, hub: 26, rally: 22, truck: 20, text: true };
    }
    let sizeKey = sizes().key;

    function tip(layer, html, opt) {
      layer.bindTooltip(html, Object.assign({ className: 'sro-tip', direction: 'right', opacity: 1 }, opt || {}));
    }

    // clearOf: screen offset [dx, dy] that moves a symbol at p to minPx from every one of pts (or as
    // far as it can get), or null when none is that close. down: px the symbol reaches below its point
    // (a truck's callsign chip). Tries the straight push away and 16 spots around the symbol at a few
    // distances; the best keeps clear of all points, inside the map, close to its true position and,
    // on a tie, towards the middle of the map.
    function clearOffset(p, pts, minPx, down) {
      down = down > 0 ? down : 0;
      if (!pts || !pts.length || !(minPx > 0) || !map._loaded) return null;
      let a, size;
      try { a = map.latLngToContainerPoint(p); size = map.getSize(); } catch (e) { return null; }
      // a drop point symbol stands on its point (a pointer at the bottom): keep clear of its whole height
      const up = Math.round(sizes().rally * 1.5);
      const qs = [];
      pts.forEach(function (q) { const ll = toLatLng(q); if (finitePt(ll)) { const c = map.latLngToContainerPoint(ll); qs.push({ x: c.x, y: c.y, up: q && q.rally ? up : 0 }); } });
      // from the symbol at (x, y) (and down to y + down) to the nearest spot of a point's symbol: [dx, dy]
      const away = function (x, y, b) { return [x - b.x, y > b.y ? y - b.y : y + down < b.y - b.up ? y + down - (b.y - b.up) : 0]; };
      const covers = function (x, y) {
        let s = 0;
        qs.forEach(function (b) { const v = away(x, y, b), d = Math.sqrt(v[0] * v[0] + v[1] * v[1]); if (d < minPx) s += minPx - d; });
        return s;
      };
      if (!(covers(a.x, a.y) > 0.5)) return null;
      const diag = Math.sqrt(size.x * size.x + size.y * size.y) || 1;
      const score = function (dx, dy) {
        const x = a.x + dx, y = a.y + dy, m = 16;
        const out = Math.max(0, m - x) + Math.max(0, x - (size.x - m)) + Math.max(0, m - y) + Math.max(0, y + down - (size.y - m));
        const mid = Math.sqrt((x - size.x / 2) * (x - size.x / 2) + (y - size.y / 2) * (y - size.y / 2)) / diag;
        return covers(x, y) * 4 + out * 4 + Math.sqrt(dx * dx + dy * dy) * 0.5 + mid * 10;
      };
      // the straight push away from the points it covers
      let px = 0, py = 0;
      qs.forEach(function (b) {
        const v = away(a.x, a.y, b), d = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        if (d < minPx && d > 0.5) { px += v[0] / d * (minPx - d); py += v[1] / d * (minPx - d); }
      });
      let best = null;
      const consider = function (dx, dy) { const s = score(dx, dy); if (!best || s < best.s) best = { s: s, dx: dx, dy: dy }; };
      if (Math.abs(px) >= 1 || Math.abs(py) >= 1) consider(px, py);
      [0.6, 1, 1.4, 1.9].forEach(function (k) {
        for (let i = 0; i < 16; i++) { const t = i * Math.PI / 8; consider(Math.cos(t) * minPx * k, Math.sin(t) * minPx * k); }
      });
      return best && (Math.abs(best.dx) >= 1 || Math.abs(best.dy) >= 1) ? [Math.round(best.dx), Math.round(best.dy)] : null;
    }
    // the divIcon moved by off px, with a dashed leader line from its true position to the symbol
    function besideIcon(icon, off) {
      const o = icon.options, a = o.iconAnchor, x0 = a[0] - off[0], y0 = a[1] - off[1];
      const leader = '<svg class="sro-leader" width="1" height="1" aria-hidden="true" focusable="false"><line x1="' + x0 + '" y1="' + y0 + '" x2="' + a[0] + '" y2="' + a[1] +
        '"/><circle cx="' + x0 + '" cy="' + y0 + '" r="3"/></svg>';
      return L.divIcon(Object.assign({}, o, { html: leader + o.html, iconAnchor: [x0, y0] }));
    }

    // zones
    const zoneLabelMarkers = [];     // { marker, lat, radiusM }
    function zoneLabels() {
      const z = map.getZoom();
      zoneLabelMarkers.forEach(function (zl) {
        const mpp = 40075016.686 * Math.cos(zl.lat * Math.PI / 180) / Math.pow(2, z + 8);
        const el2 = zl.marker.getElement();
        if (el2) el2.classList.toggle('sro-hidden', zl.radiusM / mpp < 22);
      });
    }
    function setZones(zones) {
      data.zones = (zones || []).slice();
      groups.zones.clearLayers();
      zoneLabelMarkers.length = 0;
      const t = pal();
      hatchLine.setAttribute('stroke', t.hatch);
      data.zones.forEach(function (z) {
        const c = [+z.lat, +z.lon];
        if (!finitePt(c) || !(+z.radiusMi > 0)) return;
        const closed = z.kind === 'closed';
        const color = closed ? t.closed : (t.risk[z.rating] || t.risk.Medium);
        const circle = L.circle(c, closed ? {
          pane: 'sro-zones', radius: z.radiusMi * MI, color: color, weight: 2, opacity: 0.95,
          fillColor: 'url(#' + hatchId + ')', fillOpacity: 1, className: 'sro-zone sro-zone-closed', bubblingMouseEvents: false
        } : {
          pane: 'sro-zones', radius: z.radiusMi * MI, color: color, weight: 1.5, opacity: 0.9, dashArray: '6 4',
          fillColor: color, fillOpacity: theme === 'night' ? 0.16 : 0.2, className: 'sro-zone sro-zone-risk', bubblingMouseEvents: false
        });
        circle.on('click', function (e) { if (!drawing) emit('click:zone', { zone: z, lat: e.latlng.lat, lon: e.latlng.lng }); });
        circle.addTo(groups.zones);
        // no text label on compact maps: it lands on the truck or the credits there, and the key under
        // the card map already names closed areas
        if (opts.compact) return;
        const text = closed ? 'Closed' + (z.label ? ' · ' + z.label : '') : 'Risk · ' + (z.rating || 'Medium') + (z.label ? ' · ' + z.label : '');
        const top = SRO.core.geo.destination({ lat: c[0], lon: c[1] }, 0, z.radiusMi);
        const lm = L.marker([top.lat, top.lon], {
          pane: 'sro-labels', interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'sro-zone-label-icon', html: '<span class="sro-zone-label" style="--sro-zone-c:' + color + '">' + esc(text) + '</span>', iconSize: [0, 0], iconAnchor: [0, -4] })
        }).addTo(groups.zones);
        zoneLabelMarkers.push({ marker: lm, lat: c[0], radiusM: z.radiusMi * MI });
      });
      zoneLabels();
    }

    // hubs: the symbol in the hubs pane, its name (when the zoom shows text) in a pane above the platoon
    // symbols, which would otherwise cover it next to a hub
    function setHubs(hubs, hopts) {
      data.hubs = (hubs || []).slice();
      if (hopts !== undefined) data.hubOpts = Object.assign({}, hopts || {});
      groups.hubs.clearLayers();
      const z = sizes(), named = z.text && data.hubOpts.labels !== false;
      data.hubs.forEach(function (h) {
        const p = toLatLng(h);
        if (!finitePt(p)) return;
        const m = L.marker(p, { pane: 'sro-hubs', icon: symbols.hub(h, { theme: theme, size: z.hub, label: '' }), keyboard: true, title: h.name || h.id, riseOnHover: true });
        tip(m, '<b>' + esc(h.name || h.id) + '</b>' + (h.callsign ? ' · ' + esc(h.callsign) : ''));
        m.on('click', function () { if (!drawing) emit('click:hub', { hub: h }); });
        m.addTo(groups.hubs);
        if (named) {
          const ic = symbols.hub(h, { theme: theme, size: z.hub });
          L.marker(p, { pane: 'sro-hublabels', interactive: false, keyboard: false,
            icon: L.divIcon(Object.assign({}, ic.options, { className: 'sro-icon sro-icon-hublabel' })) }).addTo(groups.hubs);
        }
      });
    }

    // rally points (+ dismounted walking ring)
    // opts.walkRingMi (number | true = 5 mi) is the default walking ring for every point; a point's
    // own walkRingMi (number, true, or 0 / false for none) wins.
    function setRally(points, ropts) {
      data.rally = (points || []).slice();
      data.rallyOpts = Object.assign({}, ropts || {});
      groups.rally.clearLayers();
      groups.walk.clearLayers();
      const t = pal();
      const defRing = data.rallyOpts.walkRingMi;
      data.rally.forEach(function (r) {
        const p = toLatLng(r);
        if (!finitePt(p)) return;
        const want = r.walkRingMi !== undefined && r.walkRingMi !== null ? r.walkRingMi : defRing;
        const ringMi = want === true ? MAP.DISMOUNTED_RING_MI : +want;
        if (ringMi > 0) {
          L.circle(p, { pane: 'sro-walk', radius: ringMi * MI, color: t.walk, weight: 1.2, opacity: 0.85, dashArray: '2 5', fill: true, fillColor: t.walk, fillOpacity: 0.05, interactive: false }).addTo(groups.walk);
        }
        const m = L.marker(p, { pane: 'sro-rally', icon: symbols.rally(r, { theme: theme, size: sizes().rally }), title: r.name || r.label || r.id, riseOnHover: true, zIndexOffset: r.used ? 100 : 0 });
        tip(m, '<b>' + esc(r.label ? 'Rally ' + r.label : (r.name || r.id || 'Rally point')) + '</b>' + (r.name && r.label ? '<br>' + esc(r.name) : '') +
          (r.pinned ? '<br>Pinned' : '') + (r.banned ? '<br>Banned' : ''));
        m.on('click', function () { if (!drawing) emit('click:rally', { point: r }); });
        m.addTo(groups.rally);
      });
    }

    // platoons
    const URG = ['Routine', 'Priority', 'Urgent', 'Immediate'];
    function setPlatoons(requests, popts) {
      data.platoons = (requests || []).slice();
      data.platoonOpts = Object.assign({}, popts || {});
      groups.platoons.clearLayers();
      const sel = data.platoonOpts.selectedId;
      const seen = {}, sz = sizes();
      // least urgent first so the most urgent draw on top
      const list = data.platoons.filter(function (r) { return finitePt(toLatLng(r)); }).sort(function (a, b) {
        return URG.indexOf(a.urgency || a.urgencyRequested) - URG.indexOf(b.urgency || b.urgencyRequested);
      });
      list.forEach(function (r) {
        const p = toLatLng(r);
        const key = p[0].toFixed(4) + ',' + p[1].toFixed(4);
        const dup = seen[key] = (seen[key] || 0) + 1;
        const named = (sz.text && data.platoonOpts.labels !== false) || r.id === sel;
        let icon = symbols.platoon(r, { urgency: r.urgency || r.urgencyRequested, selected: r.id === sel, theme: theme, size: sz.plt, showDesignation: named });
        if (dup > 1) {        // same spot (one platoon, several requests): fan out a little
          const a = icon.options.iconAnchor, k = dup - 1, f = sz.plt / 24;
          icon = L.divIcon(Object.assign({}, icon.options, { iconAnchor: [a[0] - 14 * f * k, a[1] + 10 * f * k] }));
        } else {
          // beside a point it would cover (the platoon's own pickup point on the PSG card): ring radius + 14 px
          const off = clearOffset(p, data.platoonOpts.clearOf, data.platoonOpts.clearPx || Math.round(sz.plt * 0.98 + 2) + 14);
          if (off) icon = besideIcon(icon, off);
        }
        const urg = r.urgency || r.urgencyRequested || 'Routine';
        const m = L.marker(p, {
          pane: 'sro-platoons', icon: icon, title: r.unitName || r.designator || r.id, riseOnHover: true,
          zIndexOffset: (r.id === sel ? 10000 : 0) + URG.indexOf(urg) * 100
        });
        tip(m, '<b>' + esc(r.unitName || r.designator || r.id) + '</b><br>' + esc(urg) + (r.mobility ? ' · ' + esc(r.mobility === 'fixed' ? 'fixed in place' : r.mobility) : ''));
        m.on('click', function () { if (!drawing) emit('click:platoon', { request: r, id: r.id }); });
        m.addTo(groups.platoons);
      });
    }

    // routes
    // Trucks from one hub share roads, and at island zoom roads a few hundred metres apart (the two
    // carriageways of a motorway) draw on top of each other. So that every truck's route stays visible,
    // routes are laid out in screen space for the current view, again after every zoom or pan: where a
    // route passes within a few pixels of routes given before it, it moves to lane k (k = how many of
    // those are there), k x MAP.ROUTE_LANE_PX to the right of its direction of travel. Lane 0 is the road
    // itself: a route alone stays on its road, and a truck's outbound and return legs never land on another
    // truck's line. Lanes are worked out within half a screen around the view (further out a route stays on
    // its road until the view moves there). Drawing order: every casing, every line, every chevron row,
    // with the highlighted route's three on top; the invisible wide hit lines go last, and a click or
    // hover goes to the route whose drawn line is nearest the pointer.
    const routeLayers = [];     // { route, parts, isHi, dim, color, bit, thin, thinZ, drawn: [{ px, ll, raw, sig }], zoom, shared, casing, lines, arrows, hit }
    const LANE_CELL = 3, LANE_STEP = 2, LANE_MIN_RUN = 14, LANE_MAX_ROUTES = 30;
    let laid = null;            // { z, box } of the last layout: a pan that stays inside box needs none
    let laneGrid = null;        // Int32Array raster, reused: bit r set where route r passes
    // [[lat, lon], ...] numbers: the array itself (keeps the decoded-path cache useful), else a clean copy
    function cleanCoords(src) {
      if (!src || src.length < 2) return null;
      let ok = true;
      for (let i = 0; i < src.length && ok; i++) {
        const c = src[i];
        ok = Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' && isFinite(c[0]) && isFinite(c[1]);
      }
      const out = ok ? src : src.map(toLatLng).filter(finitePt);
      return out.length >= 2 ? out : null;
    }
    function routeParts(r) {
      const parts = [];
      if (r.legs && r.legs.length) {
        r.legs.forEach(function (l) {
          const c = cleanCoords(pathOf(l));
          if (c) parts.push({ coords: c, approx: !!(l.approximate || l.source === 'straight' || l.offRoad === true && l.source !== 'osm-roads') });
        });
      } else {
        const c = cleanCoords(pathOf(r));
        if (c) parts.push({ coords: c, approx: !!(r.approximate || r.source === 'straight') });
      }
      return parts;
    }
    // per coords array, kept while the array lives: its L.LatLngs and zoom-0 pixels (Web Mercator: zoom z =
    // zoom 0 x 2^z), so a zoom or pan does not convert or project the original points again
    const baseCache = new WeakMap();
    function baseOf(coords) {
      let b = baseCache.get(coords);
      if (b) return b;
      const px = new Float64Array(coords.length * 2), ll = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        ll[i] = L.latLng(coords[i][0], coords[i][1]);
        const p = map.project(ll[i], 0);
        px[2 * i] = p.x; px[2 * i + 1] = p.y;
      }
      b = { px: px, ll: ll };
      baseCache.set(coords, b);
      return b;
    }
    // the part at zoom z with points closer than 1 px to the last one kept dropped (the end point stays
    // exact; what Leaflet's own simplification would draw anyway): pixels px[i] and their LatLngs ll[i]
    function thinPart(coords, z) {
      const base = baseOf(coords), b = base.px, n = coords.length, s = Math.pow(2, z);
      const px = [{ x: b[0] * s, y: b[1] * s }], idx = [0];
      let qx = px[0].x, qy = px[0].y;
      for (let i = 1; i < n; i++) {
        const x = b[2 * i] * s, y = b[2 * i + 1] * s;
        if (Math.abs(x - qx) + Math.abs(y - qy) >= 1) { px.push({ x: x, y: y }); idx.push(i); qx = x; qy = y; }
        else if (i === n - 1) {
          if (px.length > 1) { px[px.length - 1] = { x: x, y: y }; idx[idx.length - 1] = i; } else { px.push({ x: x, y: y }); idx.push(i); }
        }
      }
      const ll = idx.length === n ? base.ll : idx.map(function (k) { return base.ll[k]; });
      return { px: px, ll: ll };
    }
    // the line moved o px to the right of its direction (screen y points down), mitred joins (at most 2x)
    function offsetPx(px, o) {
      const n = px.length;
      if (n < 2) return px.slice();
      const nx = new Array(n - 1), ny = new Array(n - 1);
      for (let i = 0; i < n - 1; i++) {
        const dx = px[i + 1].x - px[i].x, dy = px[i + 1].y - px[i].y, len = Math.sqrt(dx * dx + dy * dy) || 1;
        nx[i] = -dy / len; ny[i] = dx / len;
      }
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let ax, ay, k = 1;
        if (i === 0) { ax = nx[0]; ay = ny[0]; } else if (i === n - 1) { ax = nx[n - 2]; ay = ny[n - 2]; } else {
          const bx = nx[i - 1] + nx[i], by = ny[i - 1] + ny[i], bl = Math.sqrt(bx * bx + by * by);
          if (bl < 1e-6) { ax = nx[i]; ay = ny[i]; } else { ax = bx / bl; ay = by / bl; k = 1 / Math.max(0.5, ax * nx[i] + ay * ny[i]); }
        }
        out[i] = { x: px[i].x + ax * o * k, y: px[i].y + ay * o * k };
      }
      return out;
    }
    function pxLen(a, b) { const dx = b.x - a.x, dy = b.y - a.y; return Math.sqrt(dx * dx + dy * dy); }
    // the part of segment a-b inside box as [t0, t1] (Liang-Barsky), null when it misses
    function clipSeg(a, b, box) {
      const dx = b.x - a.x, dy = b.y - a.y;
      let t0 = 0, t1 = 1;
      const p = [-dx, dx, -dy, dy], q = [a.x - box.min.x, box.max.x - a.x, a.y - box.min.y, box.max.y - a.y];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
      return [t0, t1];
    }
    function popcount(m) { let c = 0; while (m) { m &= m - 1; c++; } return c; }
    // runs of one lane shorter than LANE_MIN_RUN px (a road crossing, a brief split) take their neighbours' lane
    function smoothLanes(tp, lanes) {
      const runs = [];
      for (let i = 0; i < lanes.length;) {
        let j = i, len = 0;
        while (j < lanes.length && lanes[j] === lanes[i]) { len += pxLen(tp[j], tp[j + 1]); j++; }
        runs.push({ a: i, b: j, lane: lanes[i], len: len });
        i = j;
      }
      if (runs.length < 2) return;
      runs.forEach(function (r, k) {
        if (r.len >= LANE_MIN_RUN) return;
        r.lane = Math.max(k > 0 ? runs[k - 1].lane : -1, k < runs.length - 1 ? runs[k + 1].lane : -1);
        for (let i = r.a; i < r.b; i++) lanes[i] = r.lane;
      });
    }
    // the drawn line: runs in lane 0 keep their points, other runs are offset in pixels and unprojected;
    // where the lane changes the line steps across
    function drawRuns(t, lanes, z) {
      const px = [], ll = [];
      for (let i = 0; i < lanes.length;) {
        let j = i;
        while (j < lanes.length && lanes[j] === lanes[i]) j++;
        const run = t.px.slice(i, j + 1);
        if (!lanes[i]) {
          for (let k = 0; k < run.length; k++) { px.push(run[k]); ll.push(t.ll[i + k]); }
        } else {
          const q = offsetPx(run, lanes[i] * MAP.ROUTE_LANE_PX);
          for (let k = 0; k < q.length; k++) { px.push(q[k]); ll.push(map.unproject(q[k], z)); }
        }
        i = j;
      }
      return { px: px, ll: ll };
    }
    // screen layout of every route for the current view: where a segment within one half screen of the view
    // passes within a few px of earlier routes it moves to lane k (k = how many of them)
    function layoutRoutes() {
      const z = map.getZoom(), size = map.getSize(), pb = map.getPixelBounds();
      const mx = Math.ceil(size.x / 2), my = Math.ceil(size.y / 2);
      const box = { min: { x: pb.min.x - mx, y: pb.min.y - my }, max: { x: pb.max.x + mx, y: pb.max.y + my } };
      const C = LANE_CELL, cx0 = Math.floor(box.min.x / C) - 2, cy0 = Math.floor(box.min.y / C) - 2;
      const W = Math.floor(box.max.x / C) + 3 - cx0, H = Math.floor(box.max.y / C) + 3 - cy0, need = W * H;
      if (!laneGrid || laneGrid.length < need) laneGrid = new Int32Array(need); else laneGrid.fill(0, 0, need);
      const grid = laneGrid;
      // calls fn(cell index) for each cell the in-box part of a-b passes (consecutive repeats once)
      function cellsOn(a, b, fn) {
        const t = clipSeg(a, b, box);
        if (!t) return;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) * (t[1] - t[0]);
        const n = Math.max(1, Math.ceil(len / LANE_STEP));
        let last = -1;
        for (let s = 0; s <= n; s++) {
          const f = t[0] + (t[1] - t[0]) * s / n;
          const k = (Math.floor((a.y + dy * f) / C) - cy0) * W + Math.floor((a.x + dx * f) / C) - cx0;
          if (k !== last) { last = k; fn(k); }
        }
      }
      routeLayers.forEach(function (rl, r) {
        rl.bit = r < LANE_MAX_ROUTES ? (1 << r) : 0;
        if (rl.thinZ !== z) { rl.thin = rl.parts.map(function (p) { return thinPart(p.coords, z); }); rl.thinZ = z; }
        const bit = rl.bit;
        if (!bit) return;
        rl.thin.forEach(function (t) {
          const tp = t.px;
          for (let i = 1; i < tp.length; i++) cellsOn(tp[i - 1], tp[i], function (k) { grid[k] |= bit; });
        });
      });
      routeLayers.forEach(function (rl) {
        const bit = rl.bit, lower = bit ? bit - 1 : 0, prev = rl.drawn || [];
        let m = 0;
        rl.shared = false;
        rl.drawn = rl.thin.map(function (t, pi) {
          const tp = t.px, lanes = new Array(Math.max(0, tp.length - 1)).fill(0);
          let any = false;
          if (bit) {
            for (let i = 1; i < tp.length; i++) {
              let lane = 0;
              cellsOn(tp[i - 1], tp[i], function (k) {
                m = grid[k - W - 1] | grid[k - W] | grid[k - W + 1] | grid[k - 1] | grid[k] | grid[k + 1] | grid[k + W - 1] | grid[k + W] | grid[k + W + 1];
                if (m & ~bit) rl.shared = true;
                const l = popcount(m & lower);
                if (l > lane) lane = l;
              });
              lanes[i - 1] = lane;
              if (lane) any = true;
            }
          }
          if (any) { smoothLanes(tp, lanes); any = lanes.some(function (l) { return l > 0; }); }
          if (!any) return { px: tp, ll: t.ll, raw: true, sig: z + ':' };
          let sig = z + ':';
          for (let i = 0; i < lanes.length; i++) if (lanes[i] && lanes[i] !== lanes[i - 1]) sig += i + '=' + lanes[i] + ',';
          else if (!lanes[i] && lanes[i - 1]) sig += i + ',';
          const old = prev[pi];
          if (old && old.sig === sig) return old;
          const d = drawRuns(t, lanes, z);
          return { px: d.px, ll: d.ll, raw: false, sig: sig };
        });
        rl.zoom = z;
      });
      laid = { z: z, box: box };
    }
    function drawnLatLngs(rl) { return rl.drawn.map(function (d) { return d.ll; }); }
    // the invisible hit line (ROUTE_HIT_PX wide) needs no 1 px detail: the drawn points thinned to 4 px
    function hitLatLngs(rl) {
      return rl.drawn.map(function (d) {
        const px = d.px, out = [d.ll[0]];
        let q = px[0];
        for (let i = 1; i < px.length; i++) {
          if (i === px.length - 1 || Math.abs(px[i].x - q.x) + Math.abs(px[i].y - q.y) >= 4) { out.push(d.ll[i]); q = px[i]; }
        }
        return out;
      });
    }
    // new points for a polyline. quiet: on 'zoomend', ahead of the routes renderer (its listener was added
    // after this map's own), which projects every path for the new zoom next; the 'moveend' that follows
    // clips and draws them. So a zoom projects each route once, not twice.
    function setLine(layer, ll, quiet) {
      if (quiet && typeof layer._setLatLngs === 'function') layer._setLatLngs(ll); else layer.setLatLngs(ll);
    }
    // push a new layout into the route's polylines: only the parts whose drawn points changed
    function applyLayout(rl, before, quiet) {
      let any = false;
      rl.lines.forEach(function (ln, i) {
        const d = rl.drawn[i];
        if (before[i] && before[i].ll === d.ll) return;
        setLine(ln, d.ll, quiet);
        any = true;
      });
      if (!any) return;
      setLine(rl.casing, drawnLatLngs(rl), quiet);
      setLine(rl.hit, hitLatLngs(rl), quiet);
    }
    function routeTip(r) { return '<b>' + esc(r.label || r.truckId) + '</b>' + (r.summary ? '<br>' + esc(r.summary) : ''); }
    function segDist(p, a, b) {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
      return Math.sqrt(ex * ex + ey * ey);
    }
    const ROUTE_HIT_PX = 18;
    // the route whose drawn line is nearest a layer point (null when none is within the hit width)
    function nearestRoute(layerPoint) {
      const z = map.getZoom(), p = layerPoint.add(map.getPixelOrigin());
      let best = null, bestD = ROUTE_HIT_PX / 2 + 2;
      routeLayers.forEach(function (rl) {
        if (rl.zoom !== z) return;
        rl.drawn.forEach(function (d) {
          for (let i = 1; i < d.px.length; i++) {
            const a = d.px[i - 1], b = d.px[i];
            if (p.x < Math.min(a.x, b.x) - bestD || p.x > Math.max(a.x, b.x) + bestD || p.y < Math.min(a.y, b.y) - bestD || p.y > Math.max(a.y, b.y) + bestD) continue;
            const dd = segDist(p, a, b);
            if (dd < bestD) { bestD = dd; best = rl; }
          }
        });
      });
      return best;
    }
    function setRoutes(routes, ropts) {
      data.routes = (routes || []).slice();
      data.routeOpts = Object.assign({}, ropts || {});
      groups.routes.clearLayers();
      groups.stops.clearLayers();
      routeLayers.length = 0;
      const t = pal();
      const hi = data.routeOpts.highlightTruckId;
      data.routes.forEach(function (r) {
        if (!r) return;
        const parts = routeParts(r);
        if (!parts.length) return;
        const isHi = !!(hi && r.truckId === hi);
        routeLayers.push({ route: r, parts: parts, isHi: isHi, dim: !!(hi && !isHi), color: r.color || '#2F6FE0' });
      });
      layoutRoutes();         // lanes follow the order given, not the highlight
      const rest = routeLayers.filter(function (rl) { return !rl.isHi; }), top = routeLayers.filter(function (rl) { return rl.isHi; });
      function casing(rl) {
        rl.casing = L.polyline(drawnLatLngs(rl), {
          pane: 'sro-routes', color: t.casing, weight: (rl.isHi ? 6 : 4) + 3, opacity: rl.dim ? t.dim * 0.8 : 0.9, interactive: false,
          lineCap: 'round', lineJoin: 'round', className: 'sro-route-casing'
        }).addTo(groups.routes);
      }
      function lines(rl) {
        rl.lines = rl.parts.map(function (p, i) {
          return L.polyline(rl.drawn[i].ll, {
            pane: 'sro-routes', color: rl.color, weight: rl.isHi ? 6 : 4, opacity: rl.dim ? t.dim : t.routeOpacity, interactive: false,
            lineCap: p.approx ? 'butt' : 'round', lineJoin: 'round', dashArray: p.approx ? '8 7' : null,
            className: 'sro-route' + (p.approx ? ' sro-route-approx' : '')
          }).addTo(groups.routes);
        });
      }
      function arrows(rl) {
        rl.arrows = L.polyline([], {
          pane: 'sro-routes', color: t.arrow, weight: rl.isHi ? 2.2 : 1.8, opacity: rl.dim ? t.dim : 0.95, interactive: false,
          lineCap: 'round', lineJoin: 'round', className: 'sro-route-arrows'
        }).addTo(groups.routes);
      }
      [rest, top].forEach(function (list) { list.forEach(casing); list.forEach(lines); list.forEach(arrows); });
      rest.concat(top).forEach(function (rl) {
        const r = rl.route;
        const hit = rl.hit = L.polyline(hitLatLngs(rl), { pane: 'sro-routes', color: '#000', weight: ROUTE_HIT_PX, opacity: 0, interactive: true, bubblingMouseEvents: false, className: 'sro-route-hit' }).addTo(groups.routes);
        hit.on('click', function (e) {
          if (drawing) return;
          const b = nearestRoute(e.layerPoint) || rl;
          emit('click:route', { truckId: b.route.truckId, route: b.route, lat: e.latlng.lat, lon: e.latlng.lng });
        });
        if (r.truckId) {
          tip(hit, routeTip(r), { sticky: true, direction: 'top' });
          let shown = rl;
          hit.on('mousemove', function (e) {
            const b = nearestRoute(e.layerPoint) || rl;
            if (b !== shown && b.route.truckId) { shown = b; hit.setTooltipContent(routeTip(b.route)); }
          });
        }
        const dots = data.routeOpts.stopLabels === 'mine';
        (r.stops || []).forEach(function (s, i) {
          const p = toLatLng(s);
          if (!finitePt(p)) return;
          const n = s.seq !== undefined ? s.seq : i + 1;
          let html = '<div class="sro-stop' + (rl.dim ? ' sro-stop-dim' : '') + '" style="--sro-stop:' + rl.color + '">' + esc(n) + '</div>', px = 20, pane = 'sro-stops';
          if (s.mine) {
            html = '<div class="sro-stop sro-stop-mine" style="--sro-stop:' + rl.color + ';--sro-stop-fg:' + (symbols.textOn ? symbols.textOn(rl.color) : '#fff') + '">' + esc(n) + '</div>';
            px = 26; pane = 'sro-mystop';
          } else if (dots) {
            html = '<div class="sro-stop sro-stop-dot' + (rl.dim ? ' sro-stop-dim' : '') + '" style="--sro-stop:' + rl.color + '"></div>';
            px = 12;
          }
          L.marker(p, {
            pane: pane, interactive: false, keyboard: false, zIndexOffset: rl.isHi ? 1000 : 0,
            icon: L.divIcon({ className: 'sro-stop-icon', html: html, iconSize: [px, px], iconAnchor: [px / 2, px / 2] })
          }).addTo(groups.stops);
        });
      });
      drawArrows();
    }
    // after every zoom ('zoomend', quiet) and after a pan that leaves the laid-out area ('moveend'):
    // lanes are screen pixels
    function relayoutRoutes(quiet) {
      if (destroyed || !routeLayers.length) return;
      const pb = map.getPixelBounds();
      if (laid && laid.z === map.getZoom() && pb.min.x >= laid.box.min.x && pb.min.y >= laid.box.min.y &&
          pb.max.x <= laid.box.max.x && pb.max.y <= laid.box.max.y) return;
      const before = routeLayers.map(function (rl) { return rl.drawn || []; });
      layoutRoutes();
      routeLayers.forEach(function (rl, i) { applyLayout(rl, before[i], quiet); });
      drawArrows(quiet);
    }

    // direction chevrons every ~90 px along each drawn line (smaller where routes run side by side), only
    // within the laid-out area: a pan beyond it lays out again
    const ARROW_GAP = 90, ARROW_LEN = 5, ARROW_HALF = 3.6, ARROW_LEN_SHARED = 4.2, ARROW_HALF_SHARED = 2.8;
    function drawArrows(quiet) {
      const box = laid && laid.box;
      routeLayers.forEach(function (rl, idx) {
        const small = rl.shared && !rl.isHi;
        const len = small ? ARROW_LEN_SHARED : ARROW_LEN, half = small ? ARROW_HALF_SHARED : ARROW_HALF, z = rl.zoom;
        const chevrons = [];
        rl.drawn.forEach(function (d) {
          const px = d.px;
          // staggered so chevrons on lines side by side do not line up
          let next = ARROW_GAP * 0.6 + (rl.shared ? (idx % 4) * 22 : 0), acc = 0;
          for (let i = 1; i < px.length; i++) {
            const a = px[i - 1], b = px[i];
            const dx = b.x - a.x, dy = b.y - a.y, seg = Math.sqrt(dx * dx + dy * dy);
            if (!seg) continue;
            const ux = dx / seg, uy = dy / seg;
            while (acc + seg >= next) {
              const dd = next - acc;
              next += ARROW_GAP;
              const tx = a.x + ux * dd, ty = a.y + uy * dd;
              if (box && (tx < box.min.x || tx > box.max.x || ty < box.min.y || ty > box.max.y)) continue;
              const bx = tx - ux * len, by = ty - uy * len;
              chevrons.push([map.unproject(L.point(bx - uy * half, by + ux * half), z), map.unproject(L.point(tx, ty), z),
                map.unproject(L.point(bx + uy * half, by - ux * half), z)]);
            }
            acc += seg;
          }
        });
        setLine(rl.arrows, chevrons, quiet);
      });
    }
    function resize() {
      const k = sizes().key;
      if (k !== sizeKey) {
        sizeKey = k;
        setHubs(data.hubs); setRally(data.rally, data.rallyOpts); setPlatoons(data.platoons, data.platoonOpts); setTrucks(data.trucks);
      }
    }
    map.on('zoomend', function () {
      relayoutRoutes(true); zoneLabels(); resize();
      // clearOf offsets are screen pixels
      if (data.platoonOpts.clearOf) setPlatoons(data.platoons, data.platoonOpts);
      if (data.truckOpts.clearOf) setTrucks(data.trucks);
    });
    map.on('moveend', function () { relayoutRoutes(false); });
    map.on('resize', resize);

    // trucks (updated in place so the demo clock can animate them)
    const truckMarkers = new Map();     // id -> { marker, sig, data, tip }
    function truckTip(tr) { return '<b>' + esc(tr.id) + '</b>' + (tr.status ? '<br>' + esc(tr.status) : ''); }
    function setTrucks(list, topts) {
      data.trucks = (list || []).slice();
      if (topts !== undefined) data.truckOpts = Object.assign({}, topts || {});
      // default gap: the truck ring's radius plus half a hub symbol's width (what a truck waits on)
      const szT = sizes(), ringR = Math.round(szT.truck * 0.95 + 2), clearPx = data.truckOpts.clearPx || ringR + Math.round(szT.hub * 0.9) + 4;
      const keep = {};
      data.trucks.forEach(function (tr) {
        const p = toLatLng(tr);
        if (!tr || tr.id === undefined || !finitePt(p)) return;
        keep[tr.id] = true;
        const sig = [tr.color, tr.type, tr.label, theme, sizeKey].join('|');
        let rec = truckMarkers.get(tr.id);
        if (!rec) {
          const m = L.marker(p, { pane: 'sro-trucks', icon: symbols.truck(tr, { heading: tr.heading, theme: theme, size: sizes().truck }), keyboard: false, title: tr.label || tr.id, zIndexOffset: 500 });
          tip(m, truckTip(tr));
          const id = tr.id;
          // report the truck as it is now, not as it was when the marker was created
          m.on('click', function () { if (!drawing) { const cur = truckMarkers.get(id); emit('click:truck', { truck: cur ? cur.data : tr, id: id }); } });
          m.addTo(groups.trucks);
          rec = { marker: m, sig: sig, data: tr, tip: truckTip(tr) };
          truckMarkers.set(tr.id, rec);
        } else {
          rec.data = tr;
          rec.marker.setLatLng(p);
          if (rec.sig !== sig) { rec.marker.setIcon(symbols.truck(tr, { heading: tr.heading, theme: theme, size: sizes().truck })); rec.sig = sig; }
          const tipHtml = truckTip(tr);
          if (tipHtml !== rec.tip && rec.marker.getTooltip()) { rec.marker.setTooltipContent(tipHtml); rec.tip = tipHtml; }
        }
        const elm = rec.marker.getElement();
        const sym = elm && elm.querySelector('.sro-truck');
        if (sym) {
          const off = clearOffset(p, data.truckOpts.clearOf, clearPx, ringR + 11);   // to the middle of the callsign chip
          const tf = off ? 'translate(' + off[0] + 'px,' + off[1] + 'px)' : '';
          if (sym.style.transform !== tf) sym.style.transform = tf;
        }
        const hd = elm && elm.querySelector('.sro-heading');
        if (hd) {
          if (isFinite(tr.heading)) { hd.classList.remove('sro-heading-none'); hd.style.transform = 'rotate(' + (+tr.heading).toFixed(1) + 'deg)'; }
          else hd.classList.add('sro-heading-none');
        }
      });
      truckMarkers.forEach(function (rec, id) { if (!keep[id]) { groups.trucks.removeLayer(rec.marker); truckMarkers.delete(id); } });
    }

    // ---- view ----------------------------------------------------------------------------------------
    // o.padBottom: px kept free at the bottom edge (a hint drawn over the map there)
    function fitTaiwanNow(o) {
      const fo = Object.assign({ padding: [8, 8] }, o || {});
      if (fo.padBottom > 0) { fo.paddingTopLeft = fo.padding; fo.paddingBottomRight = [fo.padding[0], fo.padding[1] + fo.padBottom]; }
      delete fo.padBottom;
      map.fitBounds(MAP.TAIWAN_BOUNDS, fo);
    }
    function noAnim(o) { return Object.assign({}, o || {}, { animate: false }); }
    function fitTaiwan(o) {
      callerSetsView(function () { fitTaiwanNow(o); }, function () { fitTaiwanNow(noAnim(o)); });
    }
    // b: L.LatLngBounds | [[lat, lon], ...] | [{ lat, lon }, ...]
    function fitTarget(b) {
      if (b && typeof b.isValid === 'function') return b.isValid() ? { bounds: b } : null;
      if (!Array.isArray(b) || !b.length) return null;
      const pts = b.map(toLatLng).filter(finitePt);
      if (pts.length === 1) return { point: pts[0] };
      if (!pts.length) return null;
      const bounds = L.latLngBounds(pts);
      return bounds.isValid() ? { bounds: bounds } : null;
    }
    function fitToNow(target, o) {
      if (target.point) { map.setView(target.point, Math.max(map.getZoom(), 11), o && o.animate === false ? { animate: false } : undefined); return; }
      const fo = Object.assign({ maxZoom: 13 }, o || {});
      const pad = fo.padding || [28, 28];
      const clear = fo.clearControls, ip = isFinite(fo.iconPad) ? +fo.iconPad : 22, extra = fo.padBottom > 0 ? +fo.padBottom : 0, top = fo.padTop > 0 ? +fo.padTop : 0;
      delete fo.padding; delete fo.clearControls; delete fo.iconPad; delete fo.padBottom; delete fo.padTop;
      // keep the fitted points clear of the attribution strip (two lines on phones and cards)
      const attrEl = attribution.getContainer();
      const attrH = attrEl ? attrEl.offsetHeight : 0;
      let tl = pad, br = [pad[0], pad[1] + attrH];
      if (clear) {
        // and of the zoom buttons (top left), with room for the symbols drawn on the points: on a
        // compact map the buttons cover a good share of it
        const zc = el.querySelector('.leaflet-control-zoom');
        const zr = zc && zc.getClientRects().length ? zc.getBoundingClientRect() : null;
        const left = zr ? Math.ceil(zr.right - el.getBoundingClientRect().left) : 0;
        tl = [Math.max(pad[0], left + ip), Math.max(pad[1], ip)];
        br = [Math.max(pad[0], ip), Math.max(pad[1], ip) + attrH];
      }
      if (extra) br = [br[0], br[1] + extra];
      if (top) tl = [tl[0], tl[1] + top];
      fo.paddingTopLeft = fo.paddingTopLeft || tl;
      fo.paddingBottomRight = fo.paddingBottomRight || br;
      map.fitBounds(target.bounds, fo);
    }
    function fitTo(b, o) {
      const target = fitTarget(b);
      if (!target) return;
      callerSetsView(function () { fitToNow(target, o); }, function () { fitToNow(target, noAnim(o)); });
    }
    function setView(center, zoom, o) {
      const c = toLatLng(center);
      if (!finitePt(c)) return;
      const z = function () { return isFinite(zoom) ? +zoom : map.getZoom(); };
      callerSetsView(function () { map.setView(c, z(), o); }, function () { map.setView(c, z(), noAnim(o)); });
    }

    map.on('click', function (e) {
      if (drawing || (e.originalEvent && e.originalEvent.__sroDraw)) return;
      emit('click:map', { lat: e.latlng.lat, lon: e.latlng.lng, originalEvent: e.originalEvent });
    });

    // ---- zone drawing: tap centre, then drag or tap the radius (mouse, pen and touch) ---------------------
    function enableZoneDrawing(dopts) {
      if (drawing) drawing.cancel();
      const o = Object.assign({ kind: 'closed', rating: 'Medium' }, dopts || {});
      const t = pal();
      const color = o.kind === 'closed' ? t.closed : (t.risk[o.rating] || t.risk.Medium);
      const handlersOn = {};
      ['dragging', 'touchZoom', 'doubleClickZoom', 'boxZoom', 'keyboard'].forEach(function (h) {
        if (map[h] && map[h].enabled()) { handlersOn[h] = true; map[h].disable(); }
      });
      el.classList.add('sro-drawing');
      const bar = doc.createElement('div');
      bar.className = 'sro-drawbar';
      bar.innerHTML = '<span></span><button type="button">Cancel</button>';
      el.appendChild(bar);
      // Narrow maps (phones, cards): a full-width bar above the attribution, so it neither squeezes
      // into one word per line nor covers the zoom and base-map buttons (pinch zoom is off while drawing).
      if (el.clientWidth < MAP.DRAWBAR_NARROW_PX) {
        const attrEl = el.querySelector('.leaflet-control-attribution');
        bar.classList.add('sro-drawbar-bottom');
        bar.style.bottom = ((attrEl ? attrEl.offsetHeight : 0) + 10) + 'px';
      }
      const msg = bar.querySelector('span');
      const kindText = o.kind === 'closed' ? 'closed zone' : (o.rating ? o.rating.toLowerCase() + ' risk zone' : 'risk zone');
      function say(html) { msg.innerHTML = html; }
      say('Tap the center of the ' + esc(kindText) + '.');
      let stage = 'center', center = null, startPx = null, pointerId = null, circle = null, dot = null, lastRadius = 0;

      function ll(e) { const q = map.mouseEventToLatLng(e); return q; }
      function radiusTo(q) {
        const d = map.distance(center, q) / MI;
        return Math.max(MAP.MIN_ZONE_MI, Math.min(MAP.MAX_ZONE_MI, Math.round(d * 10) / 10));
      }
      function preview(rMi) {
        lastRadius = rMi;
        if (!circle) {
          circle = L.circle(center, { pane: 'sro-draw', radius: rMi * MI, color: color, weight: 2, dashArray: '6 5', fillColor: o.kind === 'closed' ? 'url(#' + hatchId + ')' : color, fillOpacity: o.kind === 'closed' ? 1 : 0.18, interactive: false }).addTo(groups.draw);
        } else circle.setRadius(rMi * MI);
        say('Radius <b>' + rMi.toFixed(1) + ' mi</b>. ' + (stage === 'dragging' ? 'Release to finish.' : 'Tap the edge to finish.'));
      }
      function stop(e) { e.stopPropagation(); if (e.cancelable && e.type !== 'pointermove') e.preventDefault(); }
      function passThrough(e) { return bar.contains(e.target) || !!(e.target.closest && e.target.closest('.leaflet-control-container')); }
      function down(e) {
        if (passThrough(e)) return;
        stop(e);
        if (e.button !== undefined && e.button > 0) return;
        if (stage === 'center') {
          center = ll(e); startPx = [e.clientX, e.clientY]; pointerId = e.pointerId; stage = 'pressing';
          dot = L.circleMarker(center, { pane: 'sro-draw', radius: 4, color: color, weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(groups.draw);
          try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        } else if (stage === 'radius') {
          pointerId = e.pointerId; stage = 'closing';
        }
      }
      function move(e) {
        if (stage === 'center') return;
        e.stopPropagation();
        if (stage === 'pressing' && e.pointerId === pointerId) {
          if (Math.hypot(e.clientX - startPx[0], e.clientY - startPx[1]) > 8) stage = 'dragging';
        }
        if (stage === 'dragging' || stage === 'radius' || stage === 'closing') preview(radiusTo(ll(e)));
      }
      function up(e) {
        if (passThrough(e) && stage !== 'pressing' && stage !== 'dragging' && stage !== 'closing') return;
        stop(e);
        try { el.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        if (stage === 'pressing') {
          stage = 'radius';
          say('Now tap the edge of the ' + esc(kindText) + ', or drag from the center.');
        } else if (stage === 'dragging' || stage === 'closing') {
          const rMi = radiusTo(ll(e));
          done(rMi);
        }
      }
      function cancelPointer() {           // the browser took the gesture (e.g. a system swipe)
        if (stage === 'pressing' || stage === 'dragging' || stage === 'closing') {
          stage = 'radius';
          say('Now tap the edge of the ' + esc(kindText) + ', or drag from the center.');
        }
      }
      function swallow(e) { if (passThrough(e)) return; e.stopPropagation(); e.__sroDraw = true; }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }
      el.addEventListener('pointerdown', down, true);
      el.addEventListener('pointermove', move, true);
      el.addEventListener('pointerup', up, true);
      el.addEventListener('pointercancel', cancelPointer, true);
      ['click', 'dblclick', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu'].forEach(function (t2) { el.addEventListener(t2, swallow, true); });
      doc.addEventListener('keydown', key);
      bar.querySelector('button').addEventListener('click', function (e) { e.stopPropagation(); cancel(); });

      let active = true;
      function teardown() {
        if (!active) return;            // each session tears down once (stale handles, pending finish)
        active = false;
        el.removeEventListener('pointerdown', down, true);
        el.removeEventListener('pointermove', move, true);
        el.removeEventListener('pointerup', up, true);
        el.removeEventListener('pointercancel', cancelPointer, true);
        ['click', 'dblclick', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu'].forEach(function (t2) { el.removeEventListener(t2, swallow, true); });
        doc.removeEventListener('keydown', key);
        groups.draw.clearLayers();
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        el.classList.remove('sro-drawing');
        if (!destroyed) Object.keys(handlersOn).forEach(function (h) { map[h].enable(); });
        if (drawing === session) drawing = null;
      }
      function done(rMi) {
        const result = { kind: o.kind, rating: o.kind === 'risk' ? (o.rating || 'Medium') : null, lat: +center.lat.toFixed(5), lon: +center.lng.toFixed(5), radiusMi: rMi };
        // leave the click that ends the gesture to be swallowed before handlers are removed
        setTimeout(function () {
          if (!active) return;          // cancelled or destroyed before the finish landed
          teardown();
          if (o.onDone) o.onDone(result);
          emit('zone:drawn', result);
        }, 0);
        stage = 'done';
      }
      function cancel() {
        if (!active) return;
        teardown();
        if (o.onCancel) o.onCancel();
      }
      const session = { cancel: cancel, stage: function () { return stage; }, radius: function () { return lastRadius; } };
      drawing = session;
      return session;
    }

    // ---- theme ------------------------------------------------------------------------------------------
    function setTheme(next) {
      if (!MAP.THEMES[next] || next === theme) return;
      theme = next;
      el.setAttribute('data-sro-theme', theme);
      if (coastLayer) coastLayer.setStyle(coastStyle);
      if (roadLayer) {
        const wasOn = map.hasLayer(roadLayer);
        map.removeLayer(roadLayer); roadLayer = null;
        if (wasOn) { buildRoads(); map.addLayer(roadLayer); }
      }
      setZones(data.zones);
      setHubs(data.hubs);
      setRally(data.rally, data.rallyOpts);
      setPlatoons(data.platoons, data.platoonOpts);
      setRoutes(data.routes, data.routeOpts);
      truckMarkers.forEach(function (rec) { groups.trucks.removeLayer(rec.marker); });
      truckMarkers.clear();
      setTrucks(data.trucks);
    }

    // Size changes (a hidden tab shown, a panel resized): one invalidateSize per frame. The first time
    // the element has a size the component fits Taiwan, unless the caller set a view; a view the caller
    // set while the element had no size is applied again now.
    let fittedVisible = hasSize(), raf = 0, ro = null;
    const frame = root.requestAnimationFrame ? function (f) { return root.requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); };
    const cancelFrame = root.cancelAnimationFrame ? function (id) { root.cancelAnimationFrame(id); } : clearTimeout;
    function sized() {
      raf = 0;
      if (destroyed) return;
      internally(function () {
        map.invalidateSize({ pan: false });
        if (!hasSize()) return;
        if (pendingView) { const v = pendingView; pendingView = null; fittedVisible = true; v.fn(); }
        else if (!fittedVisible) { fittedVisible = true; if (!callerView) fitTaiwanNow({ animate: false }); }
      });
    }
    if (typeof root.ResizeObserver === 'function') {
      ro = new root.ResizeObserver(function () {
        if (raf || destroyed) return;
        raf = frame(sized);
      });
      ro.observe(el);
    }

    // Follow the app theme (html[data-theme], set by the shell) so a view that forgets to call
    // setTheme() never leaves a white-ish map on a night screen. opts.followDocumentTheme: false opts out.
    let themeObs = null;
    if (opts.followDocumentTheme !== false && typeof root.MutationObserver === 'function') {
      themeObs = new root.MutationObserver(function () {
        const t = doc.documentElement.getAttribute('data-theme');
        if (!destroyed && MAP.THEMES[t] && t !== theme) setTheme(t);
      });
      themeObs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // After destroy() every call is a no-op (a view may still hold the handle for a frame).
    function live(fn, dead) {
      return function () { return destroyed ? (typeof dead === 'function' ? dead() : dead) : fn.apply(null, arguments); };
    }
    const noop = function () {};
    const deadSession = function () { return { cancel: noop, stage: function () { return 'done'; }, radius: function () { return 0; } }; };
    const api = {
      leaflet: map,
      el: el,
      setZones: live(setZones), setHubs: live(setHubs), setRally: live(setRally), setPlatoons: live(setPlatoons),
      setRoutes: live(setRoutes), setTrucks: live(setTrucks),
      fitTaiwan: live(fitTaiwan), fitTo: live(fitTo), setView: live(setView),
      on: live(on, function () { return noop; }), off: off,
      enableZoneDrawing: live(enableZoneDrawing, deadSession),
      isDrawing: function () { return !!drawing; },
      isDestroyed: function () { return destroyed; },
      setTheme: live(setTheme),
      getTheme: function () { return theme; },
      setRoadsVisible: live(function (v) { roadsPref = !!v; syncBase(); }),
      setTilesEnabled: live(function (v) {
        tiles.wanted = !!v;
        // already loading or on: restarting would reset the load counter and let the 8 s watchdog
        // drop working tiles (no new tile loads arrive while the view is unchanged)
        if (tiles.wanted) { if (tiles.state === 'off') startTiles(); }
        else { clearTimeout(tiles.timer); tiles.probeSeq++; if (tiles.layer && map.hasLayer(tiles.layer)) map.removeLayer(tiles.layer); tiles.state = 'off'; tiles.reason = 'user'; syncBase(); emit('tiles', status()); }
      }),
      status: status,
      invalidateSize: live(function () { map.invalidateSize(); }),
      // Safe at any time, including in the same task as create() and during a zoom or pan animation.
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (drawing) drawing.cancel();
        if (ro) ro.disconnect();
        if (raf) { cancelFrame(raf); raf = 0; }
        if (themeObs) themeObs.disconnect();
        clearTimeout(tiles.timer);
        tiles.probeSeq++;
        pendingView = null;
        root.removeEventListener && root.removeEventListener('offline', onOffline);
        root.removeEventListener && root.removeEventListener('online', onOnline);
        Object.keys(handlers).forEach(function (k) { handlers[k].length = 0; });
        map.remove();                  // stops pan / fly animations; road renderer: SafeCanvas (no frame left behind)
        // An animated zoom leaves its first frame and a 250 ms end timer behind (Leaflet 1.9.4); with the
        // panes gone the timer threw "reading '_leaflet_pos'". The timer only acts while this flag is set,
        // and with every map listener dropped the frame's events reach nothing.
        map._animatingZoom = false;
        map.off();
        if (tiles.layer) tiles.layer.off();
        if (defs.parentNode) defs.parentNode.removeChild(defs);
        el.classList.remove('sro-map', 'sro-compact');
        el.removeAttribute('data-sro-theme');
      }
    };
    startTiles();
    syncBase();
    return api;
  };
})(typeof self !== 'undefined' ? self : globalThis);
