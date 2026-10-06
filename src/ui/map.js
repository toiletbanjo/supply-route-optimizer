// Shared Leaflet map component for both roles (DESIGN.md sections 6 and 8).
//
//   const m = SRO.ui.map.create(el, { theme, tiles: true, compact: false, controls: true, scale: true })
//   m.setZones(zones)                         closed = gray hatching + red outline; risk = amber..red fill + rating label
//   m.setHubs(hubs)                           2525 supply installation symbols
//   m.setRally(points, { walkRingMi })        [{ id|gridId, lat, lon, label, used, pinned, banned, walkRingMi }]
//   m.setPlatoons(requests, { selectedId })   2525 platoon symbols on urgency rings
//   m.setRoutes(routes, { highlightTruckId }) [{ truckId, color, legs: [{ coords, source, approximate }] | coords,
//                                               stops: [{ lat, lon, seq, label }] }]
//   m.setTrucks([{ id, color, lat, lon, heading, label, type }])   updated in place (animation)
//   m.fitTaiwan(), m.fitTo(bounds | [[lat, lon], ...] | [{ lat, lon }, ...])
//   m.on('click:zone' | 'click:route' | 'click:platoon' | 'click:hub' | 'click:rally' | 'click:truck' | 'click:map' | 'tiles', fn) -> off()
//   m.enableZoneDrawing({ kind: 'closed' | 'risk', rating, onDone({ kind, rating, lat, lon, radiusMi }), onCancel }) -> { cancel }
//   m.setTheme('dark' | 'light' | 'night') (also follows html[data-theme] unless opts.followDocumentTheme === false),
//   m.setRoadsVisible(bool), m.setTilesEnabled(bool)
//   m.status() -> { tiles: 'loading' | 'on' | 'off', reason, roads: bool }, m.invalidateSize(), m.destroy(), m.leaflet
//
//   SRO.ui.map.truckPosition(route, simMin) -> { lat, lon, heading, legIndex, status: 'at-hub' | 'en-route' | 'at-stop' | 'returned' }
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

  // ---- truck position along a timed route (pure, used for the demo clock) -----------------------
  function legCoords(leg) {
    if (!leg) return null;
    const c = leg.coords || leg.path;
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
    if (!legs.length && route && route.coords && route.coords.length && isFinite(route.depart)) {
      legs = [{ coords: route.coords, depart: route.depart, arrive: isFinite(route.returnAt) ? route.returnAt : route.depart }];
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
    '.sro-map[data-sro-theme="night"]{--sro-sea:#000000;--sro-ctl-bg:#0a0303;--sro-ctl-bg2:#140505;--sro-ctl-fg:#b8342d;--sro-ctl-muted:#7a2420;--sro-ctl-border:#3a100e;--sro-accent:#b8342d;--sro-sel:#c23a32;--sro-sel-gap:#000000;--sro-label-bg:rgba(0,0,0,.85)}',
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
    '@container (max-width:560px){.sro-map .leaflet-control-scale{display:none}.sro-map .leaflet-bottom.leaflet-left{bottom:30px}.sro-note-long{display:none}.sro-note-short{display:inline}}',
    '@media (pointer:coarse){.sro-map .leaflet-bar a,.sro-map .leaflet-bar a:hover{width:44px;height:44px;line-height:44px;font-size:20px}.sro-basemap button{height:44px;min-width:56px}}',
    // zones
    '.sro-zone-label{display:inline-block;transform:translate(-50%,0);white-space:nowrap;max-width:200px;max-width:min(240px,60cqw);overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;font:700 10px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:3px 5px;border-radius:4px;background:var(--sro-label-bg);border:1px solid var(--sro-zone-c);color:var(--sro-zone-c);pointer-events:none}',
    '.sro-zone-label-icon{background:none;border:0}',
    '.sro-zone-label-icon.sro-hidden{display:none}',
    // stops
    '.sro-stop-icon{background:none;border:0}',
    '.sro-stop{box-sizing:border-box;width:20px;height:20px;border-radius:50%;background:var(--sro-ctl-bg);border:2px solid var(--sro-stop);color:var(--sro-ctl-fg);font:700 11px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;text-align:center}',
    '.sro-stop-dim{opacity:.35}',
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

    const map = L.map(el, {
      zoomControl: false, attributionControl: false, minZoom: 6, maxZoom: 18,
      maxBounds: MAP.MAX_BOUNDS, maxBoundsViscosity: 0.8, zoomSnap: 0.25, zoomDelta: 1,
      wheelPxPerZoomLevel: 90, worldCopyJump: false, tapTolerance: 12
    });
    map.fitBounds(MAP.TAIWAN_BOUNDS, { padding: [8, 8], animate: false });

    // panes (z-index): coast 150 < tiles 200 < roads 250 < zones 380 < walk 390 < routes 410 <
    // labels 590 < rally 605 < hubs 610 < platoons 620 < trucks 640 < draw 650
    const PANES = { coast: 150, roads: 250, zones: 380, walk: 390, routes: 410, labels: 590, stops: 595, rally: 605, hubs: 610, platoons: 620, trucks: 640, draw: 650 };
    Object.keys(PANES).forEach(function (k) {
      const p = map.createPane('sro-' + k);
      p.style.zIndex = PANES[k];
      p.classList.add('sro-pane-' + k);
      if (k === 'coast' || k === 'roads' || k === 'walk' || k === 'labels') p.style.pointerEvents = 'none';
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

    const roadRenderer = L.canvas({ pane: 'sro-roads', padding: 0.4 });
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
        tiles.layer.on('tileload', function () {
          tiles.loads++;
          if (tiles.state === 'loading') { tiles.state = 'on'; tiles.reason = null; clearTimeout(tiles.timer); syncBase(); emit('tiles', status()); }
        });
        tiles.layer.on('tileerror', function () {
          tiles.errors++;
          if (tiles.state === 'loading' && tiles.errors >= MAP.TILE_ERROR_LIMIT && tiles.loads === 0) fallback('errors');
        });
      }
      return tiles.layer;
    }
    function startTiles() {
      if (!tiles.wanted) { tiles.state = 'off'; tiles.reason = 'disabled'; syncBase(); return; }
      if (root.navigator && root.navigator.onLine === false) { fallback('offline'); return; }
      tiles.state = 'loading'; tiles.reason = null; tiles.loads = 0; tiles.errors = 0;
      const layer = tilesLayer();
      if (!map.hasLayer(layer)) map.addLayer(layer);
      clearTimeout(tiles.timer);
      tiles.timer = setTimeout(function () { if (tiles.state === 'loading' && tiles.loads === 0) fallback('timeout'); }, MAP.TILE_TIMEOUT_MS);
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
          if (seq === tiles.probeSeq && !r.ok && tiles.state !== 'off') fallback('blocked');
        }).catch(function () { /* unreadable (CORS) or network: inconclusive, tile events decide */ });
      } catch (e) { /* inconclusive */ }
    }
    function fallback(reason) {
      clearTimeout(tiles.timer);
      tiles.probeSeq++;
      if (tiles.layer && map.hasLayer(tiles.layer)) map.removeLayer(tiles.layer);
      tiles.state = 'off'; tiles.reason = reason;
      syncBase();
      emit('tiles', status());
    }
    function onOffline() { if (tiles.wanted && tiles.state !== 'off') fallback('offline'); }
    function onOnline() {
      if (!tiles.wanted || tiles.state !== 'off') return;
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
    const data = { zones: [], hubs: [], rally: [], rallyOpts: {}, platoons: [], platoonOpts: {}, routes: [], routeOpts: {}, trucks: [] };
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

    // hubs
    function hubOpts() { const z = sizes(); return z.text ? { theme: theme, size: z.hub } : { theme: theme, size: z.hub, label: '' }; }
    function setHubs(hubs) {
      data.hubs = (hubs || []).slice();
      groups.hubs.clearLayers();
      data.hubs.forEach(function (h) {
        const p = toLatLng(h);
        if (!finitePt(p)) return;
        const m = L.marker(p, { pane: 'sro-hubs', icon: symbols.hub(h, hubOpts()), keyboard: true, title: h.name || h.id, riseOnHover: true });
        tip(m, '<b>' + esc(h.name || h.id) + '</b>' + (h.callsign ? ' · ' + esc(h.callsign) : ''));
        m.on('click', function () { if (!drawing) emit('click:hub', { hub: h }); });
        m.addTo(groups.hubs);
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
        let icon = symbols.platoon(r, { urgency: r.urgency || r.urgencyRequested, selected: r.id === sel, theme: theme, size: sz.plt, showDesignation: sz.text || r.id === sel });
        if (dup > 1) {        // same spot (one platoon, several requests): fan out a little
          const a = icon.options.iconAnchor, k = dup - 1, f = sz.plt / 24;
          icon = L.divIcon(Object.assign({}, icon.options, { iconAnchor: [a[0] - 14 * f * k, a[1] + 10 * f * k] }));
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
    const routeLayers = [];     // { route, parts: [[latlng...]], arrows: L.Polyline, color, dim }
    function routeParts(r) {
      const parts = [];
      if (r.legs && r.legs.length) {
        r.legs.forEach(function (l) {
          const c = (l.coords || l.path || []).map(toLatLng).filter(finitePt);
          if (c.length >= 2) parts.push({ coords: c, approx: l.approximate || l.source === 'straight' || l.offRoad === true && l.source !== 'osm-roads' });
        });
      } else if (r.coords && r.coords.length >= 2) {
        parts.push({ coords: r.coords.map(toLatLng).filter(finitePt), approx: r.approximate || r.source === 'straight' });
      }
      return parts;
    }
    function setRoutes(routes, ropts) {
      data.routes = (routes || []).slice();
      data.routeOpts = Object.assign({}, ropts || {});
      groups.routes.clearLayers();
      groups.stops.clearLayers();
      routeLayers.length = 0;
      const t = pal();
      const hi = data.routeOpts.highlightTruckId;
      const ordered = data.routes.slice().sort(function (a, b) { return (a.truckId === hi) - (b.truckId === hi); });
      ordered.forEach(function (r) {
        const parts = routeParts(r);
        if (!parts.length) return;
        const color = r.color || '#2F6FE0';
        const isHi = hi && r.truckId === hi;
        const dim = hi && !isHi;
        const w = isHi ? 6 : 4;
        const op = dim ? t.dim : t.routeOpacity;
        const all = parts.map(function (p) { return p.coords; });
        const g = L.featureGroup();
        L.polyline(all, { pane: 'sro-routes', color: t.casing, weight: w + 3, opacity: dim ? t.dim * 0.8 : 0.9, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(g);
        parts.forEach(function (p) {
          L.polyline(p.coords, {
            pane: 'sro-routes', color: color, weight: w, opacity: op, interactive: false, lineCap: p.approx ? 'butt' : 'round', lineJoin: 'round',
            dashArray: p.approx ? '8 7' : null, className: 'sro-route' + (p.approx ? ' sro-route-approx' : '')
          }).addTo(g);
        });
        const arrows = L.polyline([], { pane: 'sro-routes', color: t.arrow, weight: isHi ? 2.2 : 1.8, opacity: dim ? t.dim : 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(g);
        const hit = L.polyline(all, { pane: 'sro-routes', color: '#000', weight: 18, opacity: 0, interactive: true, bubblingMouseEvents: false, className: 'sro-route-hit' }).addTo(g);
        hit.on('click', function (e) { if (!drawing) emit('click:route', { truckId: r.truckId, route: r, lat: e.latlng.lat, lon: e.latlng.lng }); });
        if (r.truckId) tip(hit, '<b>' + esc(r.label || r.truckId) + '</b>' + (r.summary ? '<br>' + esc(r.summary) : ''), { sticky: true, direction: 'top' });
        g.addTo(groups.routes);
        routeLayers.push({ route: r, parts: all, arrows: arrows });
        (r.stops || []).forEach(function (s, i) {
          const p = toLatLng(s);
          if (!finitePt(p)) return;
          const n = s.seq !== undefined ? s.seq : i + 1;
          L.marker(p, {
            pane: 'sro-stops', interactive: false, keyboard: false, zIndexOffset: isHi ? 1000 : 0,
            icon: L.divIcon({ className: 'sro-stop-icon', html: '<div class="sro-stop' + (dim ? ' sro-stop-dim' : '') + '" style="--sro-stop:' + color + '">' + esc(n) + '</div>', iconSize: [20, 20], iconAnchor: [10, 10] })
          }).addTo(groups.stops);
        });
      });
      drawArrows();
    }

    // direction chevrons every ~90 px along each route, recomputed on zoom
    const ARROW_GAP = 90, ARROW_LEN = 5, ARROW_HALF = 3.6;
    function drawArrows() {
      const z = map.getZoom();
      routeLayers.forEach(function (rl) {
        const chevrons = [];
        rl.parts.forEach(function (coords) {
          const px = coords.map(function (c) { return map.project(c, z); });
          let next = ARROW_GAP * 0.6, acc = 0;
          for (let i = 1; i < px.length; i++) {
            const a = px[i - 1], b = px[i];
            const dx = b.x - a.x, dy = b.y - a.y, seg = Math.sqrt(dx * dx + dy * dy);
            if (!seg) continue;
            const ux = dx / seg, uy = dy / seg;
            while (acc + seg >= next) {
              const d = next - acc;
              const tipP = L.point(a.x + ux * d, a.y + uy * d);
              const back = L.point(tipP.x - ux * ARROW_LEN, tipP.y - uy * ARROW_LEN);
              const w1 = L.point(back.x - uy * ARROW_HALF, back.y + ux * ARROW_HALF);
              const w2 = L.point(back.x + uy * ARROW_HALF, back.y - ux * ARROW_HALF);
              chevrons.push([map.unproject(w1, z), map.unproject(tipP, z), map.unproject(w2, z)]);
              next += ARROW_GAP;
            }
            acc += seg;
          }
        });
        rl.arrows.setLatLngs(chevrons);
      });
    }
    function resize() {
      const k = sizes().key;
      if (k !== sizeKey) {
        sizeKey = k;
        setHubs(data.hubs); setRally(data.rally, data.rallyOpts); setPlatoons(data.platoons, data.platoonOpts); setTrucks(data.trucks);
      }
    }
    map.on('zoomend', function () { drawArrows(); zoneLabels(); resize(); });
    map.on('resize', resize);

    // trucks (updated in place so the demo clock can animate them)
    const truckMarkers = new Map();     // id -> { marker, sig, data, tip }
    function truckTip(tr) { return '<b>' + esc(tr.id) + '</b>' + (tr.status ? '<br>' + esc(tr.status) : ''); }
    function setTrucks(list) {
      data.trucks = (list || []).slice();
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
        const hd = elm && elm.querySelector('.sro-heading');
        if (hd) {
          if (isFinite(tr.heading)) { hd.classList.remove('sro-heading-none'); hd.style.transform = 'rotate(' + (+tr.heading).toFixed(1) + 'deg)'; }
          else hd.classList.add('sro-heading-none');
        }
      });
      truckMarkers.forEach(function (rec, id) { if (!keep[id]) { groups.trucks.removeLayer(rec.marker); truckMarkers.delete(id); } });
    }

    // ---- view ----------------------------------------------------------------------------------------
    function fitTaiwan(o) { map.fitBounds(MAP.TAIWAN_BOUNDS, Object.assign({ padding: [8, 8] }, o || {})); }
    function fitTo(b, o) {
      let bounds = null;
      if (b && typeof b.isValid === 'function') bounds = b;
      else if (Array.isArray(b) && b.length) {
        const pts = b.map(toLatLng).filter(finitePt);
        if (pts.length === 1) { map.setView(pts[0], Math.max(map.getZoom(), 11)); return; }
        if (pts.length) bounds = L.latLngBounds(pts);
      }
      if (!bounds || !bounds.isValid()) return;
      const fo = Object.assign({ maxZoom: 13 }, o || {});
      const pad = fo.padding || [28, 28];
      delete fo.padding;
      // keep the fitted points clear of the attribution strip (two lines on phones and cards)
      const attrEl = attribution.getContainer();
      const attrH = attrEl ? attrEl.offsetHeight : 0;
      fo.paddingTopLeft = fo.paddingTopLeft || pad;
      fo.paddingBottomRight = fo.paddingBottomRight || [pad[0], pad[1] + attrH];
      map.fitBounds(bounds, fo);
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

    let fittedVisible = map.getSize().x > 0 && map.getSize().y > 0, raf = 0, ro = null;
    if (typeof root.ResizeObserver === 'function') {
      ro = new root.ResizeObserver(function () {
        if (raf) return;
        raf = (root.requestAnimationFrame || setTimeout)(function () {
          raf = 0;
          if (destroyed) return;
          map.invalidateSize({ pan: false });
          const sz = map.getSize();
          if (!fittedVisible && sz.x > 0 && sz.y > 0) { fittedVisible = true; fitTaiwan({ animate: false }); }
        });
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

    let destroyed = false;
    const api = {
      leaflet: map,
      el: el,
      setZones: setZones, setHubs: setHubs, setRally: setRally, setPlatoons: setPlatoons, setRoutes: setRoutes, setTrucks: setTrucks,
      fitTaiwan: fitTaiwan, fitTo: fitTo, on: on, off: off,
      enableZoneDrawing: enableZoneDrawing,
      isDrawing: function () { return !!drawing; },
      setTheme: setTheme,
      getTheme: function () { return theme; },
      setRoadsVisible: function (v) { roadsPref = !!v; syncBase(); },
      setTilesEnabled: function (v) {
        tiles.wanted = !!v;
        // already loading or on: restarting would reset the load counter and let the 8 s watchdog
        // drop working tiles (no new tile loads arrive while the view is unchanged)
        if (tiles.wanted) { if (tiles.state === 'off') startTiles(); }
        else { clearTimeout(tiles.timer); tiles.probeSeq++; if (tiles.layer && map.hasLayer(tiles.layer)) map.removeLayer(tiles.layer); tiles.state = 'off'; tiles.reason = 'user'; syncBase(); emit('tiles', status()); }
      },
      status: status,
      invalidateSize: function () { map.invalidateSize(); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (drawing) drawing.cancel();
        if (ro) ro.disconnect();
        if (themeObs) themeObs.disconnect();
        clearTimeout(tiles.timer);
        root.removeEventListener && root.removeEventListener('offline', onOffline);
        root.removeEventListener && root.removeEventListener('online', onOnline);
        Object.keys(handlers).forEach(function (k) { handlers[k].length = 0; });
        map.remove();
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
