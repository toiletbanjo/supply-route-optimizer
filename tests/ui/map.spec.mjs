// Playwright checks for the shared map, military symbols and road paths (src/ui/map.js, src/ui/symbols.js,
// src/core/roads.js). Plain node script:  node tests/ui/map.spec.mjs [--keep]
//
// Builds a standalone harness page the same way tools/build.py inlines the app (leaflet CSS/JS,
// milsymbol, the SRO data/core files and the two UI files, '</script' escaped), opens it from
// file:// in Chromium and checks:
//   - offline base map: coastline + road lines drawn with tiles blocked, fallback note shown
//   - every SIDC in SRO.ui.symbols.SIDC is valid and renders; platoon / hub / truck / rally icons
//   - a route FOB Granite -> Base Lotus follows roads (every vertex on the road graph)
//   - the truck marker moves (and turns) when simMin changes
//   - zone drawing with mouse (tap-tap and drag) and with touch emulation
//   - night theme recolors vector layers, symbols and tiles; simulated working tiles hide the fallback
//   - zero console errors except blocked tile requests (only messages naming the tile host are excused)
//   - review checks (reviewChecks): real mouse/touch hit testing on every clickable layer, tile state
//     machine (no watchdog fallback on re-enable, one-tap retry), drawing-session robustness, rapid theme
//     switching, shell theme following, 320x568 and 2560x1440 layouts, blocked storage, reload, reduced
//     motion, long names, truck-label contrast, compact-map framing above the attribution
//   - integration checks (integrationChecks): destroy() at any moment (same task, microtask, mid zoom /
//     pan / fly, inside the map's own events) without errors and no-op calls after it; a map created at
//     zero size keeps the view its caller set; legs given as encoded polylines (plan.routes) draw and
//     animate exactly as coords; overlapping routes drawn side by side and each visible (screenshot
//     pixels) at island and city zoom, after animated zooms and pans; highlighted route on top; chevrons;
//     a click on one of two adjacent lines picks that line's truck
// Screenshots go to /tmp/claude-0/ui-shots/map/ at 320x568, 390x844, 1440x900 and 2560x1440.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SRO_SHOTS || '/tmp/claude-0/ui-shots/map';
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const g = execSync('npm root -g').toString().trim();
  return require(path.join(g, 'playwright'));
}
const { chromium } = loadPlaywright();

// ---- harness -----------------------------------------------------------------------------------
const LIBS = ['node_modules/leaflet/dist/leaflet.js', 'node_modules/milsymbol/dist/milsymbol.js'];
const FILES = [
  'src/core/ns.js', 'src/core/util.js',
  'src/data/grid.json', 'src/data/grid_links.json', 'src/data/catalog.js', 'src/data/scenario.js',
  'src/data/taiwan_coast.json', 'src/data/roads_graph.json',
  'src/core/format.js', 'src/core/geo.js', 'src/core/road_router.js', 'src/core/roads.js',
  'src/core/clock.js', 'src/core/urgency.js',
  'src/ui/symbols.js', 'src/ui/map.js'
];
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function wrap(rel, text) {
  if (!rel.endsWith('.json')) return text;
  const name = path.basename(rel).split('.')[0];
  return '(function(root){var SRO=root.SRO=root.SRO||{};SRO.data=SRO.data||{};SRO.data[' + JSON.stringify(name) + ']=' + text + ';})(typeof self!=="undefined"?self:globalThis);';
}
function safe(js) { return js.replace(/<\/(script)/gi, '<\\/$1').replace(/^[ \t]*\/\/[#@] sourceMappingURL=.*$/gm, ''); }
function leafletCss() {
  const rel = 'node_modules/leaflet/dist/leaflet.css';
  return read(rel).replace(/url\((["']?)([^)"']+)\1\)/g, (m, q, ref) => {
    if (ref.startsWith('data:')) return m;
    const f = path.join(ROOT, 'node_modules/leaflet/dist', ref);
    return fs.existsSync(f) ? 'url("data:image/png;base64,' + fs.readFileSync(f).toString('base64') + '")' : m;
  });
}

const HARNESS_JS = String.raw`
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const theme = qs.get('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const grid = SRO.data.grid, byId = (id) => grid.find((g) => g.id === id);
  const sc = SRO.data.scenario, roads = SRO.core.roads, geo = SRO.core.geo;
  const hubs = sc.defaultHubs();
  const colors = sc.truckColors.map((c) => c.hex);

  const zones = [
    { id: 'Z-1', kind: 'closed', lat: 24.80, lon: 120.97, radiusMi: 6, label: 'Bridge out' },
    { id: 'Z-2', kind: 'risk', rating: 'High', lat: 24.10, lon: 120.95, radiusMi: 9 },
    { id: 'Z-3', kind: 'risk', rating: 'Low', lat: 22.95, lon: 120.30, radiusMi: 5 }
  ];
  const rally = [
    { id: 'G-TAOYUAN', label: 'A', used: true, walkRingMi: 5 },
    { id: 'G-ZHUBEI', label: 'B', used: true },
    { id: 'G-TAICHUNG', label: 'C', used: true, pinned: true },
    { id: 'G-PULI', label: 'D', used: true },
    { id: 'G-HUALIEN', label: 'E', used: true, walkRingMi: 5 },
    { id: 'G-XINCHENG', label: 'F', used: true },
    { id: 'G-CHIAYI', label: 'G', used: false },
    { id: 'G-YILAN', label: 'H', used: false, banned: true }
  ].map((r) => Object.assign({}, byId(r.id), r, { name: byId(r.id).name }));

  const U = ['Routine', 'Priority', 'Urgent', 'Immediate'];
  const units = ['1st PLT, B CO, 3-21 IN', '2nd PLT, A CO, 4-93 IN', '3rd PLT, C CO, 2-96 IN', '1st PLT, A CO, 5-86 AR',
    '2nd PLT, B TRP, 4-98 CAV', '3rd PLT, A CO, 3-94 IN', '1st PLT, C CO, 3-59 IN', '2nd PLT, D CO, 3-94 IN'];
  const spots = [[25.02, 121.21], [24.79, 121.05], [24.16, 120.74], [23.99, 121.02], [23.95, 121.60], [24.12, 121.58], [23.50, 120.50], [22.75, 120.40]];
  const mob = ['mounted', 'dismounted', 'dismounted', 'mounted', 'mounted', 'fixed', 'dismounted', 'mounted'];
  const platoons = units.map((u, i) => ({
    id: 'R-' + String(i + 1).padStart(4, '0'), unitName: u, designator: sc.designatorFor(u),
    lat: spots[i][0], lon: spots[i][1], mobility: mob[i], urgency: U[i % 4]
  }));

  // timed routes: hub -> stops -> hub, base minutes x 1.5 convoy, 20 min load, 15 min per stop
  function timed(truckId, color, hubId, stopIds, startMin) {
    const hub = byId(hubId), pts = [hub].concat(stopIds.map(byId)).concat([hub]);
    const legs = [];
    let t = startMin + 20;
    for (let i = 1; i < pts.length; i++) {
      const p = roads.path(pts[i - 1], pts[i], zones);
      const dur = Math.max(1, Math.round(p.minutes * 1.5));
      legs.push({ coords: p.coords, source: p.source, approximate: p.approximate, depart: t, arrive: t + dur, miles: p.miles });
      t += dur + (i < pts.length - 1 ? 15 : 0);
    }
    return { truckId, color, legs, depart: legs[0].depart, returnAt: t,
      stops: stopIds.map((id, i) => ({ seq: i + 1, lat: byId(id).lat, lon: byId(id).lon, label: byId(id).name })) };
  }
  const routes = [
    timed('Alpha-2', colors[1], 'G-GRANITE', ['G-TAOYUAN', 'G-ZHUBEI'], 360),
    timed('Bravo-1', colors[2], 'G-JADE', ['G-TAICHUNG', 'G-PULI'], 360),
    timed('Delta-2', colors[7], 'G-LOTUS', ['G-HUALIEN', 'G-XINCHENG'], 360),
    timed('Alpha-1', colors[0], 'G-GRANITE', ['G-LOTUS'], 380)
  ];
  const fleetType = { 'Alpha-1': 'tanker', 'Alpha-2': 'cargo', 'Bravo-1': 'tanker', 'Delta-2': 'cargo' };

  const el = document.getElementById('map');
  if (qs.get('mini') === '1') document.body.classList.add('mini');
  const t0 = performance.now();
  const map = SRO.ui.map.create(el, { theme, compact: qs.get('compact') === '1' || qs.get('mini') === '1' });
  const createMs = performance.now() - t0;
  map.setZones(zones);
  map.setHubs(hubs);
  map.setRally(rally);
  map.setPlatoons(platoons, { selectedId: 'R-0004' });
  map.setRoutes(routes, { highlightTruckId: qs.get('hi') || null });
  const events = [];
  ['click:zone', 'click:route', 'click:platoon', 'click:map', 'click:hub', 'click:rally', 'tiles'].forEach((k) => map.on(k, (e) => events.push([k, e && (e.id || e.truckId || (e.zone && e.zone.id) || e.tiles || null)])));

  function trucksAt(simMin) {
    return routes.map((r) => {
      const p = SRO.ui.map.truckPosition(r, simMin);
      return { id: r.truckId, color: r.color, type: fleetType[r.truckId], lat: p.lat, lon: p.lon, heading: p.status === 'en-route' ? p.heading : null, status: p.status, legIndex: p.legIndex };
    });
  }
  let sim = Number(qs.get('sim') || 470);
  map.setTrucks(trucksAt(sim));

  if (qs.get('mini') === '1') {
    const r = routes.find((x) => x.truckId === 'Delta-2');
    map.setRoutes([r], { highlightTruckId: 'Delta-2' });
    map.setPlatoons([platoons[4]], {});
    map.fitTo(r.legs.flatMap((l) => l.coords), { padding: [20, 20] });
  }
  window.H = {
    map, routes, zones, platoons, rally, hubs, events, trucksAt, createMs, totalMs: performance.now() - t0,
    setSim(m) { sim = m; const t = trucksAt(m); map.setTrucks(t); return t; },
    gallery(on) { document.body.classList.toggle('show-gallery', on !== false); },
    ready: true
  };

  // symbol gallery (lists / cards use symbols.svg)
  const S = SRO.ui.symbols, gal = document.getElementById('gallery');
  const row = (title, html) => '<div class="g-row"><div class="g-h">' + title + '</div><div class="g-items">' + html + '</div></div>';
  const cell = (html, cap) => '<div class="g-cell"><div class="g-sym">' + html + '</div><div class="g-cap">' + cap + '</div></div>';
  const iconHtml = (icon) => '<div style="position:relative;width:' + icon.options.iconSize[0] + 'px;height:' + icon.options.iconSize[1] + 'px">' + icon.options.html + '</div>';
  gal.setAttribute('data-sro-theme', theme);
  gal.innerHTML =
    row('SIDC (list size)', Object.keys(S.SIDC).map((k) => cell(S.svg(S.SIDC[k], { size: 22, theme, label: k }), k)).join('')) +
    row('Platoons by urgency', U.map((u, i) => cell(iconHtml(S.platoon(platoons[i], { urgency: u, theme })), u)).join('') + cell(iconHtml(S.platoon(platoons[3], { urgency: 'Priority', selected: true, theme })), 'selected') + cell(iconHtml(S.platoon(platoons[5], { urgency: 'Urgent', theme })), 'fixed')) +
    row('Trucks', colors.map((c, i) => cell(iconHtml(S.truck({ id: sc.callsigns[i >> 1] + '-' + ((i & 1) + 1), color: c, type: i & 1 ? 'cargo' : 'tanker' }, { heading: i * 45, theme })), sc.truckColors[i].name)).join('')) +
    row('Hub and rally', cell(iconHtml(S.hub(hubs[0], { theme })), 'hub') + cell(iconHtml(S.rally({ label: 'F' }, { used: true, theme })), 'used') + cell(iconHtml(S.rally({ label: 'G' }, { theme })), 'candidate') + cell(iconHtml(S.rally({ label: 'C' }, { used: true, pinned: true, theme })), 'pinned') + cell(iconHtml(S.rally({ label: 'H' }, { banned: true, theme })), 'banned'));
})();
`;

const HARNESS_CSS = `
  html,body{margin:0;height:100%;background:#0f1418;color:#e3e8ec;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  html[data-theme="light"] body{background:#f6f7f8;color:#1b2329}
  html[data-theme="night"] body{background:#000;color:#b8342d}
  #map{position:absolute;inset:0}
  .mini #map{inset:auto;left:16px;right:16px;top:96px;height:260px;border:1px solid #2b3640;border-radius:8px;overflow:hidden}
  .mini-card{display:none}.mini .mini-card{display:block;position:absolute;left:16px;right:16px;top:16px;font-size:15px}
  .mini-card small{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
  .mini-card b{font-variant-numeric:tabular-nums}
  #gallery{display:none;position:absolute;inset:0;overflow:auto;padding:16px;box-sizing:border-box;z-index:2000;background:#0f1418}
  #gallery[data-sro-theme="light"]{background:#f5f3ee} #gallery[data-sro-theme="night"]{background:#000}
  .show-gallery #gallery{display:block}
  .g-row{margin:0 0 18px}.g-h{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin:0 0 8px}
  .g-items{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
  .g-cell{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:60px}
  .g-sym{padding:14px 6px 18px}.g-cap{font-size:11px;opacity:.75}
`;

function buildHarness() {
  const parts = [];
  parts.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>Map harness</title><style>' + leafletCss() + '</style><style>' + HARNESS_CSS + '</style></head><body>');
  parts.push('<div class="mini-card"><small>Your delivery</small>Truck <b>Delta-2</b>, 1 stop away, ETA <b>0815</b></div><div id="map"></div><div id="gallery"></div>');
  for (const rel of LIBS) parts.push('<script data-src="' + rel + '">\n' + safe(read(rel)) + '\n</script>');
  for (const rel of FILES) parts.push('<script data-src="' + rel + '">\n' + safe(wrap(rel, read(rel))) + '\n</script>');
  parts.push('<script>' + safe(HARNESS_JS) + '</script></body></html>');
  const file = path.join(OUT, 'harness.html');
  fs.writeFileSync(file, parts.join('\n'));
  return file;
}

// ---- fake OSM-like PNG tile (for the "tiles work" case) ------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) { const p = pixel(x, y), o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = 255; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const FAKE_TILE = png(256, 256, (x, y) => {
  if (x + y < 90) return [170, 211, 223];                       // water
  if (Math.abs(x - 128) < 4 || Math.abs(y - 170) < 3) return [255, 255, 255];   // roads
  if (Math.abs(x - y) < 5) return [232, 146, 162];              // motorway
  if ((x > 180 && y < 80)) return [205, 235, 176];              // park
  return [242, 239, 233];                                       // land
});

// ---- checks -------------------------------------------------------------------------------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const TILE_HOST = 'tile.openstreetmap.org';
function watchConsole(page, bag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() && m.location().url || '';
    const text = m.text();
    // only errors that name the tile host are excused (a blocked non-tile resource still fails the run)
    if (loc.includes(TILE_HOST) || text.includes(TILE_HOST)) { bag.tiles++; return; }
    bag.errors.push(text + (loc ? ' @' + loc : ''));
  });
  page.on('pageerror', (e) => bag.errors.push('pageerror: ' + e.message));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith('file:') && !u.startsWith('data:') && !u.includes(TILE_HOST)) bag.external.push(u); });
}

async function openPage(browser, url, { viewport, touch = false, tileMode = 'block', blockStorage = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch, reducedMotion });
  if (blockStorage) {
    // site data blocked: every storage accessor throws, as in a locked-down or private browser
    await ctx.addInitScript(() => {
      for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) {
        Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('storage blocked', 'SecurityError'); } });
      }
    });
  }
  const page = await ctx.newPage();
  const bag = { errors: [], tiles: 0, external: [], blockedTiles: tileMode === 'block' };
  watchConsole(page, bag);
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(TILE_HOST)) {
      if (tileMode === 'serve') return route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_TILE, headers: { 'access-control-allow-origin': '*' } });
      return route.abort('internetdisconnected');
    }
    if (u.startsWith('file:') || u.startsWith('data:')) return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.goto(url);
  await page.waitForFunction(() => window.H && window.H.ready, null, { timeout: 15000 });
  return { ctx, page, bag };
}

async function mapCenterPx(page) {
  return page.evaluate(() => { const r = document.getElementById('map').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}

// ---- review checks: real hit testing (no dispatchEvent shortcuts), tile state machine, drawing
// robustness, rapid theme switching, edge viewport sizes, reload, blocked storage, reduced motion,
// long names, label contrast, compact-map framing ------------------------------------------------------
const PAGE_HELPERS = String.raw`
  window.__rect = (el) => { if (typeof el === 'string') el = document.querySelector(el); if (!el || getComputedStyle(el).display === 'none') return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  window.__overlap = (a, b) => !!(a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5);
  window.__counts = () => { const o = {}; document.querySelectorAll('#map .leaflet-pane').forEach((p) => { const k = Array.from(p.classList).find((c) => /^sro-pane-/.test(c)); if (!k) return; o[k] = p.querySelectorAll(':scope > svg path').length + '/' + p.querySelectorAll(':scope > .leaflet-marker-icon').length; }); o.layers = Object.values(H.map.leaflet._layers).filter((l) => !(l instanceof L.Tooltip)).length; o.canvas = document.querySelectorAll('#map canvas').length; return JSON.stringify(o); };
  window.__lum = (c) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c); return [+m[1], +m[2], +m[3]].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
  window.__contrast = (a, b) => { const x = __lum(a), y = __lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
`;
async function helpers(page) { await page.evaluate(PAGE_HELPERS); }

async function reviewChecks(browser, base, allBags) {
  // R1. desktop, real mouse input on every clickable layer ------------------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1440, height: 900 } });
    allBags.push(['review-desktop', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await helpers(page);
    await page.evaluate(() => {
      window.__got = [];
      ['click:zone', 'click:hub', 'click:platoon', 'click:route', 'click:map', 'click:truck', 'click:rally'].forEach((k) => H.map.on(k, (e) => __got.push([k, e.id || e.truckId || (e.zone && e.zone.id) || (e.hub && e.hub.id) || (e.point && e.point.id) || null, e.truck ? [e.truck.lat, e.truck.lon] : null])));
    });
    // finds a screen point where the topmost element belongs to the wanted layer
    const target = (kind) => page.evaluate((kind) => {
      const mapR = document.getElementById('map').getBoundingClientRect(), m = H.map.leaflet;
      const at = (ll) => { const p = m.latLngToContainerPoint(ll); return { x: mapR.left + p.x, y: mapR.top + p.y }; };
      const cands = [];
      if (kind === 'zone') { const z = H.zones.find((q) => q.id === 'Z-3'); cands.push(at([z.lat, z.lon + 0.03]), at([z.lat - 0.03, z.lon])); }
      if (kind === 'hub') document.querySelectorAll('.sro-icon-hub').forEach((e) => { const b = e.getBoundingClientRect(); for (const fx of [0.75, 0.85, 0.65]) cands.push({ x: b.left + b.width * fx, y: b.top + b.height * 0.55 }); });
      if (kind === 'platoon') document.querySelectorAll('.sro-icon-platoon .sro-ring').forEach((e) => { const b = e.getBoundingClientRect(); cands.push({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); });
      if (kind === 'route') H.routes.find((r) => r.truckId === 'Bravo-1').legs.forEach((l) => { for (let i = 3; i < l.coords.length - 3; i += 7) cands.push(at(l.coords[i])); });
      if (kind === 'map') cands.push({ x: mapR.left + 120, y: mapR.top + mapR.height / 2 }, { x: mapR.left + 160, y: mapR.top + 300 });
      const want = { zone: (e) => e.matches('path.sro-zone-risk'), hub: (e) => !!e.closest('.sro-icon-hub'), platoon: (e) => !!e.closest('.sro-icon-platoon'), route: (e) => e.matches('path.sro-route-hit'), map: (e) => e === document.getElementById('map') || (e.closest('.leaflet-pane') && !e.closest('.leaflet-marker-pane') && !e.classList.contains('leaflet-interactive') && !e.closest('.leaflet-marker-icon')) };
      for (const c of cands) { const e = document.elementFromPoint(c.x, c.y); if (e && want[kind](e)) return c; }
      return null;
    }, kind);
    const real = {};
    for (const kind of ['zone', 'hub', 'platoon', 'route', 'map']) {
      const p = await target(kind);
      await page.evaluate(() => { __got.length = 0; });
      if (p) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(320); }
      real[kind] = { at: p && [Math.round(p.x), Math.round(p.y)], got: await page.evaluate(() => __got.map((g) => g[0] + ':' + g[1])) };
    }
    check('real mouse click hits zone (under the route and label panes)', real.zone.at && real.zone.got.join() === 'click:zone:Z-3', real.zone);
    check('real mouse click hits a hub marker', real.hub.at && real.hub.got.length === 1 && /^click:hub:/.test(real.hub.got[0]), real.hub);
    check('real mouse click hits a platoon marker', real.platoon.at && real.platoon.got.length === 1 && /^click:platoon:R-/.test(real.platoon.got[0]), real.platoon);
    check('real mouse click hits a route (wide hit line), not the map', real.route.at && real.route.got.join() === 'click:route:Bravo-1', real.route);
    check('real mouse click on empty map gives exactly one click:map', real.map.at && real.map.got.join() === 'click:map:null', real.map);
    // a drawing session leaves its SVG renderer behind in the top 'draw' pane: markers must stay clickable
    await page.evaluate(() => { const h = H.map.enableZoneDrawing({ kind: 'closed' }); h.cancel(); });
    const p2 = await target('platoon');
    await page.evaluate(() => { __got.length = 0; });
    if (p2) { await page.mouse.click(p2.x, p2.y); await page.waitForTimeout(320); }
    const afterDraw = await page.evaluate(() => __got.map((g) => g[0]));
    check('markers still clickable after a drawing session', !!p2 && afterDraw.join() === 'click:platoon', { p2, afterDraw });

    // truck click reports the truck as it is now (marker updated in place by the clock)
    const tk = await page.evaluate(() => {
      H.setSim(480); const now = H.setSim(560).find((t) => t.id === 'Alpha-1');
      const e = document.querySelector('.sro-truck[data-truck="Alpha-1"] .sro-truck-ring').getBoundingClientRect();
      return { x: e.left + e.width / 2, y: e.top + e.height / 2, now: [now.lat, now.lon] };
    });
    await page.evaluate(() => { __got.length = 0; });
    await page.mouse.click(tk.x, tk.y);
    await page.waitForTimeout(320);
    const tg = await page.evaluate(() => __got.find((g) => g[0] === 'click:truck'));
    check('click:truck payload is the current truck state (not the first one)', tg && Math.abs(tg[2][0] - tk.now[0]) < 1e-9 && Math.abs(tg[2][1] - tk.now[1]) < 1e-9, { got: tg && tg[2], now: tk.now });

    // stale drawing handle: cancelling an old session must not break the active one
    const stale = await page.evaluate(() => {
      const h1 = H.map.enableZoneDrawing({ kind: 'closed' });
      const h2 = H.map.enableZoneDrawing({ kind: 'risk', rating: 'Low' });
      h1.cancel();
      const mid = { drawing: H.map.isDrawing(), dragOff: !H.map.leaflet.dragging.enabled(), bars: document.querySelectorAll('.sro-drawbar').length };
      h2.cancel();
      return { mid, after: { drawing: H.map.isDrawing(), dragOn: H.map.leaflet.dragging.enabled(), bars: document.querySelectorAll('.sro-drawbar').length } };
    });
    check('stale drawing handle cancel leaves the active session intact', stale.mid.drawing && stale.mid.dragOff && stale.mid.bars === 1 && !stale.after.drawing && stale.after.dragOn && stale.after.bars === 0, stale);
    // destroy between the finishing tap and the deferred onDone: no callback, no error
    const dz = await page.evaluate(async () => {
      const div = document.createElement('div'); div.style.cssText = 'position:absolute;left:20px;top:20px;width:400px;height:300px'; document.body.appendChild(div);
      const m2 = SRO.ui.map.create(div, { theme: 'dark', tiles: false });
      let done = 0, cancelled = 0;
      m2.enableZoneDrawing({ kind: 'closed', onDone: () => { done++; }, onCancel: () => { cancelled++; } });
      const b = div.getBoundingClientRect(), x = b.left + 200, y = b.top + 150;
      const fire = (type, cx) => div.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true }));
      fire('pointerdown', x); fire('pointerup', x); fire('pointerdown', x + 60); fire('pointerup', x + 60);
      m2.destroy();
      await new Promise((r) => setTimeout(r, 60));
      div.remove();
      return { done, cancelled };
    });
    check('destroy() during a pending zone finish: no onDone, no error', dz.done === 0, dz);

    // setRally(points, { walkRingMi }) default ring, and a later call without opts resets it
    const walk = await page.evaluate(() => {
      const pts = H.rally.map((r) => Object.assign({}, r, { walkRingMi: undefined }));
      H.map.setRally(pts, { walkRingMi: true });
      const withOpt = document.querySelectorAll('.sro-pane-walk path').length;
      H.map.setTheme('light'); const afterTheme = document.querySelectorAll('.sro-pane-walk path').length; H.map.setTheme('dark');
      H.map.setRally(pts);
      const without = document.querySelectorAll('.sro-pane-walk path').length;
      H.map.setRally(H.rally);
      return { withOpt, afterTheme, without, n: pts.length, restored: document.querySelectorAll('.sro-pane-walk path').length };
    });
    check('setRally(points, { walkRingMi }) rings every point and survives a theme switch', walk.withOpt === walk.n && walk.afterTheme === walk.n && walk.without === 0 && walk.restored === 2, walk);

    // rapid theme switching: same layers afterwards, nothing leaked, still fast
    const rt = await page.evaluate(() => {
      H.map.setRally(H.rally); H.map.setRoutes(H.routes, {}); H.map.setTrucks(H.trucksAt(470));
      const before = __counts(); const th = ['night', 'light', 'dark', 'light', 'night', 'dark'];
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) { H.map.setTheme(th[i % th.length]); if (i % 5 === 0) H.map.setTrucks(H.trucksAt(470 + i)); }
      H.map.setTrucks(H.trucksAt(470)); H.map.setTheme('dark');
      const ms = performance.now() - t0;
      return { before, after: __counts(), ms: Math.round(ms), theme: document.getElementById('map').getAttribute('data-sro-theme'), css: document.querySelectorAll('#sro-map-css,#sro-symbols-css').length, defs: document.querySelectorAll('#map .sro-defs').length };
    });
    check('rapid theme switching (61x): same layers, no leaks, < 80 ms per switch', rt.before === rt.after && rt.theme === 'dark' && rt.css === 2 && rt.defs === 1 && rt.ms / 61 < 80, rt);
    // the shell switches themes on html[data-theme]; the map follows without a setTheme() call
    const follow = await page.evaluate(async () => {
      const tick = () => new Promise((r) => setTimeout(r, 0));
      document.documentElement.setAttribute('data-theme', 'night'); await tick();
      const a = { theme: H.map.getTheme(), coast: document.querySelector('.sro-pane-coast path').getAttribute('fill') };
      document.documentElement.setAttribute('data-theme', 'dark'); await tick();
      return { a, b: H.map.getTheme(), attr: document.getElementById('map').getAttribute('data-sro-theme') };
    });
    check('map follows the shell theme (html[data-theme]) by itself', follow.a.theme === 'night' && follow.a.coast === '#0d0404' && follow.b === 'dark' && follow.attr === 'dark', follow);

    // truck label chips are readable on every truck color (dark and light)
    const chip = await page.evaluate(() => {
      const out = [];
      for (const th of ['dark', 'light']) {
        H.map.setTheme(th);
        const cols = SRO.data.scenario.truckColors.map((c) => c.hex);
        H.map.setTrucks(cols.map((c, i) => ({ id: 'T-' + i, color: c, lat: 23 + i * 0.2, lon: 121, heading: 0, type: 'cargo' })));
        document.querySelectorAll('#map .sro-truck-label').forEach((e) => { const cs = getComputedStyle(e); out.push([th, e.textContent, +__contrast(cs.color, cs.backgroundColor).toFixed(2)]); });
      }
      H.map.setTheme('dark'); H.map.setTrucks(H.trucksAt(470));
      return out;
    });
    check('truck label chips: text contrast >= 4.3 on every truck color, dark and light', chip.length === 16 && chip.every((c) => c[2] >= 4.3), chip.filter((c) => c[2] < 4.5));
    await ctx.close();
  }

  // R2. tile state machine ------------------------------------------------------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1000, height: 700 }, tileMode: 'serve' });
    allBags.push(['review-tiles-served', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'on', null, { timeout: 10000 });
    await page.evaluate(() => { SRO.ui.map.TILE_TIMEOUT_MS = 700; H.map.setTilesEnabled(true); H.map.setTilesEnabled(true); });
    await page.waitForTimeout(1200);
    const s1 = await page.evaluate(() => H.map.status());
    check('setTilesEnabled(true) while tiles are on keeps them on (no watchdog fallback)', s1.tiles === 'on', s1);
    await page.click('.sro-basemap [data-k="tiles"]');
    const s2 = await page.evaluate(() => H.map.status());
    await page.click('.sro-basemap [data-k="tiles"]');
    await page.waitForFunction(() => H.map.status().tiles === 'on', null, { timeout: 5000 }).catch(() => null);
    const s3 = await page.evaluate(() => H.map.status());
    check('Tiles button toggles off (user) and back on', s2.tiles === 'off' && s2.reason === 'user' && s3.tiles === 'on', { s2, s3 });
    await ctx.close();
  }
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1000, height: 700 } });
    allBags.push(['review-tiles-retry', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    const before = await page.evaluate(() => { const b = document.querySelector('.sro-basemap [data-k="tiles"]'); window.__tileEv = []; H.map.on('tiles', (s) => __tileEv.push(s.tiles + ':' + s.reason)); return { title: b.title, pressed: b.getAttribute('aria-pressed') }; });
    let tileReqs = 0;
    page.on('request', (r) => { if (r.url().includes(TILE_HOST)) tileReqs++; });
    await page.click('.sro-basemap [data-k="tiles"]');
    await page.waitForFunction(() => __tileEv.length > 0, null, { timeout: 12000 }).catch(() => null);
    const after = await page.evaluate(() => ({ ev: __tileEv.slice(), s: H.map.status() }));
    check('after a fallback, one tap on "tap to retry" retries the tiles (not a user switch-off)', /retry/.test(before.title) && before.pressed === 'false' && tileReqs > 0 && after.ev[0] === 'off:errors', { before, tileReqs, after });
    await ctx.close();
  }

  // R3. edge viewport sizes, themes, drawing bar on a narrow phone ---------------------------------------
  for (const [w, h, touch, th] of [[320, 568, true, 'dark'], [320, 568, true, 'night'], [2560, 1440, false, 'light'], [2560, 1440, false, 'dark']]) {
    const name = `edge-${w}x${h}-${th}`;
    const { ctx, page, bag } = await openPage(browser, base + '?theme=' + th, { viewport: { width: w, height: h }, touch });
    allBags.push([name, bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await helpers(page);
    await page.waitForTimeout(250);
    const lay = await page.evaluate(() => {
      const r = { note: __rect('.sro-note'), attr: __rect('.leaflet-control-attribution'), scale: __rect('.leaflet-control-scale'), zoom: __rect('.leaflet-control-zoom'), base: __rect('.sro-basemap') };
      const pairs = [['note', 'attr'], ['note', 'scale'], ['scale', 'attr'], ['zoom', 'base'], ['note', 'zoom']].filter(([a, b]) => __overlap(r[a], r[b])).map((p) => p.join('/'));
      const b = H.map.leaflet.getBounds();
      return { pairs, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, island: b.contains([25.2, 121.5]) && b.contains([22.0, 120.8]), zoom: H.map.leaflet.getZoom(), plt: document.querySelectorAll('.sro-icon-platoon').length };
    });
    check(name + ': no control overlaps, no page scroll, whole island in view', lay.pairs.length === 0 && lay.sw <= w && lay.sh <= h && lay.island && lay.plt === 8, lay);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    if (w === 320) {
      await page.evaluate(() => H.map.enableZoneDrawing({ kind: 'risk', rating: 'Medium' }));
      const d = await page.evaluate(() => {
        const r = { bar: __rect('.sro-drawbar'), zoom: __rect('.leaflet-control-zoom'), base: __rect('.sro-basemap'), attr: __rect('.leaflet-control-attribution'), note: __rect('.sro-note') };
        return { hits: ['zoom', 'base', 'attr'].filter((k) => __overlap(r.bar, r[k])), barH: r.bar && Math.round(r.bar.h), barW: r.bar && Math.round(r.bar.w), noteHidden: !r.note };
      });
      check(name + ': drawing bar is full width, clear of zoom/base-map buttons and attribution', d.hits.length === 0 && d.barH <= 64 && d.barW >= 280 && d.noteHidden, d);
      await page.screenshot({ path: path.join(OUT, name + '-drawing.png') });
    }
    await ctx.close();
  }

  // R4. blocked storage + reduced motion + reload --------------------------------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 390, height: 844 }, touch: true, blockStorage: true, reducedMotion: 'reduce' });
    allBags.push(['review-storage-blocked', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await helpers(page);
    const s1 = await page.evaluate(() => { let blocked = false; try { void window.localStorage; } catch (e) { blocked = true; } return { blocked, counts: __counts(), pulse: getComputedStyle(document.querySelector('.sro-urg-Immediate'), '::after').animationName }; });
    await page.reload();
    await page.waitForFunction(() => window.H && H.map.status().tiles === 'off', null, { timeout: 12000 });
    await helpers(page);
    const s2 = await page.evaluate(() => ({ counts: __counts(), css: document.querySelectorAll('#sro-map-css,#sro-symbols-css').length }));
    check('storage blocked: map renders; reload gives the same layers', s1.blocked && s1.counts === s2.counts && s2.css === 2, { s1, s2 });
    check('prefers-reduced-motion: Immediate ring does not pulse', s1.pulse === 'none', s1.pulse);
    // real touch tap on a platoon
    const tp = await page.evaluate(() => { const e = document.querySelector('.sro-plt.sro-selected .sro-ring').getBoundingClientRect(); window.__tap = []; H.map.on('click:platoon', (x) => __tap.push(x.id)); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; });
    await page.touchscreen.tap(tp.x, tp.y);
    await page.waitForTimeout(400);
    const tapped = await page.evaluate(() => __tap.slice());
    check('touch tap on a platoon fires click:platoon once', tapped.join() === 'R-0004', tapped);
    await ctx.close();
  }

  // R5. long names on a phone ----------------------------------------------------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=light', { viewport: { width: 390, height: 844 }, touch: true });
    allBags.push(['review-long-names', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await helpers(page);
    const ln = await page.evaluate(() => {
      const long = 'HHC (FWD), 2nd Battalion Logistics Support Element, 3rd Sustainment Brigade Task Force Lightning';
      H.map.setPlatoons(H.platoons.concat([Object.assign({}, H.platoons[0], { id: 'R-LONG', unitName: long, designator: 'HHC/2-3SBTFLIGHTNINGXXXX', lat: 24.5, lon: 121.0, urgency: 'Immediate' })]), { selectedId: 'R-LONG' });
      H.map.setHubs(H.hubs.concat([{ id: 'HUB-LONG', name: 'Forward Operating Base Extremely Long Name For Testing', lat: 23.4, lon: 120.6 }]));
      H.map.setZones(H.zones.concat([{ id: 'Z-L', kind: 'closed', lat: 23.0, lon: 121.0, radiusMi: 8, label: 'Bridge out after landslide near the river crossing at kilometre 42 on Highway 20' }]));
      H.map.setTrucks(H.trucksAt(470).concat([{ id: 'Foxtrot-12', color: '#C9359A', lat: 23.8, lon: 120.9, label: 'Foxtrot-12 heavy recovery section', type: 'cargo', heading: 45 }]));
      H.map.fitTo([[24.6, 120.4], [22.9, 121.3]]);
      return true;
    });
    await page.waitForTimeout(400);
    const lr = await page.evaluate(() => {
      const mapW = document.getElementById('map').clientWidth;
      const zl = Array.from(document.querySelectorAll('#map .sro-zone-label')).map((e) => Math.round(e.getBoundingClientRect().width));
      // hub names draw in their own pane above the platoon symbols (.sro-icon-hublabel); milsymbol draws field text twice (outline + fill)
      const hubTxt = Array.from(new Set(Array.from(document.querySelectorAll('#map .sro-icon-hublabel svg text')).map((t) => t.textContent).filter((t) => /FORWARD/.test(t))));
      const pltTxt = Array.from(new Set(Array.from(document.querySelectorAll('#map .sro-icon-platoon svg text')).map((t) => t.textContent).filter((t) => /^HHC/.test(t))));
      const tl = Array.from(document.querySelectorAll('#map .sro-truck-label')).map((e) => Math.round(e.getBoundingClientRect().width));
      return { mapW, zl, hubTxt, pltTxt, tlMax: Math.max.apply(null, tl), sw: document.documentElement.scrollWidth };
    });
    check('long names: zone labels, hub and designator text and truck chips are clipped', lr.zl.every((w) => w <= Math.min(240, lr.mapW * 0.6) + 1) && lr.hubTxt.length === 1 && lr.hubTxt[0].length <= 22 && /\u2026$/.test(lr.hubTxt[0]) && lr.pltTxt.length === 1 && lr.pltTxt[0].length <= 16 && lr.tlMax <= 122 && lr.sw <= 390, lr);
    await page.screenshot({ path: path.join(OUT, 'phone-light-long-names.png') });
    await ctx.close();
  }

  // R6. compact mini map: the route is framed above the attribution strip -------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark&mini=1&sim=520', { viewport: { width: 320, height: 640 }, touch: true });
    allBags.push(['review-mini-320', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await page.waitForTimeout(300);
    await helpers(page);
    const fr = await page.evaluate(() => {
      const m = H.map.leaflet, r = H.routes.find((x) => x.truckId === 'Delta-2');
      const mapR = document.getElementById('map').getBoundingClientRect(), attr = __rect('.leaflet-control-attribution');
      const pts = r.legs.flatMap((l) => l.coords).map((c) => m.latLngToContainerPoint(c));
      const maxY = Math.max.apply(null, pts.map((p) => p.y)), minY = Math.min.apply(null, pts.map((p) => p.y));
      return { maxY: Math.round(mapR.top + maxY), attrTop: Math.round(attr.t), minY: Math.round(mapR.top + minY), mapTop: Math.round(mapR.top), bg: getComputedStyle(document.querySelector('.leaflet-control-attribution')).backgroundColor };
    });
    check('mini map: route framed above the attribution, attribution opaque', fr.maxY < fr.attrTop - 8 && fr.minY > fr.mapTop + 8 && !/rgba\(.*,\s*0?\.\d+\)$/.test(fr.bg), fr);
    await page.screenshot({ path: path.join(OUT, 'phone-320-mini-dark.png') });

    // R7. PSG card map (psg-lint 1): own stop badge above the drop point symbols, other stops as dots,
    // no hub or designator text, the platoon drawn beside a pickup it would cover (leader line), the
    // truck beside its hub, and the fitted points clear of the zoom buttons and the attribution
    const card = await page.evaluate(() => {
      const r = H.routes.find((x) => x.truckId === 'Alpha-2'), m = H.map, lm = m.leaflet;
      const hub = H.hubs.find((x) => x.gridId === 'G-GRANITE') || H.hubs[0];
      const own = r.stops[1];
      m.setZones([]);
      m.setHubs([hub], { labels: false });
      m.setRally([{ id: 'own', lat: own.lat, lon: own.lon, used: true }]);
      m.setRoutes([Object.assign({}, r, { stops: r.stops.map((s, i) => Object.assign({}, s, { mine: i === 1 })) })], { highlightTruckId: 'Alpha-2', stopLabels: 'mine' });
      const plt = Object.assign({}, H.platoons[1], { lat: own.lat + 0.002, lon: own.lon + 0.002 });
      m.setPlatoons([plt], { labels: false, clearOf: [{ lat: own.lat, lon: own.lon, rally: true }] });
      m.setTrucks([{ id: 'Alpha-2', color: r.color, type: 'cargo', lat: hub.lat, lon: hub.lon }], { clearOf: [hub] });
      m.fitTo([own, plt, hub], { maxZoom: 12, padding: [14, 14], clearControls: true, iconPad: 30 });
      const mapR = document.getElementById('map').getBoundingClientRect();
      const at = (p) => { const q = lm.latLngToContainerPoint([p.lat, p.lon]); return { x: mapR.left + q.x, y: mapR.top + q.y }; };
      const mine = document.querySelectorAll('#map .sro-stop-mine'), dots = document.querySelectorAll('#map .sro-stop-dot');
      const ring = document.querySelector('#map .sro-icon-platoon .sro-ring').getBoundingClientRect();
      const tr = document.querySelector('#map .sro-truck-ring').getBoundingClientRect();
      const ps = document.querySelector('#map .sro-icon-platoon svg:not(.sro-leader)').getBoundingClientRect(), rs = document.querySelector('#map .sro-icon-rally svg').getBoundingClientRect();
      const pltOverRally = ps.left < rs.right - 2 && rs.left < ps.right - 2 && ps.top < rs.bottom - 2 && rs.top < ps.bottom - 2;
      const zc = document.querySelector('#map .leaflet-control-zoom').getBoundingClientRect(), attr = document.querySelector('#map .leaflet-control-attribution').getBoundingClientRect();
      const pts = [own, plt, hub].map(at), o = at(own), hb = at(hub);
      const pc = { x: ring.left + ring.width / 2, y: ring.top + ring.height / 2 }, tc = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
      const pane = (n) => +getComputedStyle(document.querySelector('#map .sro-pane-' + n)).zIndex;
      return {
        mine: mine.length, mineText: mine[0] && mine[0].textContent, minePane: !!(mine[0] && mine[0].closest('.sro-pane-mystop')), dots: dots.length, dotText: Array.from(dots).map((d) => d.textContent).join(''),
        paneOrder: pane('mystop') > pane('rally') && pane('mystop') > pane('hubs') && pane('hublabels') > pane('platoons'),
        hubLabels: document.querySelectorAll('#map .sro-icon-hublabel').length, hubText: document.querySelectorAll('#map .sro-icon-hub svg text').length,
        pltText: document.querySelectorAll('#map .sro-icon-platoon svg text').length, leader: document.querySelectorAll('#map .sro-icon-platoon .sro-leader').length,
        pltGap: Math.round(Math.hypot(pc.x - o.x, pc.y - o.y)), pltOverRally, truckGap: Math.round(Math.hypot(tc.x - hb.x, tc.y - hb.y)),
        clearOfZoom: pts.every((p) => p.x > zc.right + 20), aboveAttr: pts.every((p) => p.y < attr.top - 20), inside: pts.every((p) => p.x < mapR.right - 20 && p.y > mapR.top + 20)
      };
    });
    check('card map: own stop badge (2) in its pane above the drop point and hub symbols; other stops as dots without numbers', card.mine === 1 && card.mineText === '2' && card.minePane && card.dots === 1 && card.dotText === '' && card.paneOrder, card);
    check('card map: no hub name or designator text (labels: false)', card.hubLabels === 0 && card.hubText === 0 && card.pltText === 0, card);
    check('card map: platoon beside the pickup it would cover (leader line), truck beside its hub', card.leader === 1 && card.pltGap >= 30 && !card.pltOverRally && card.truckGap >= 30, card);
    check('card map: fitted points clear of the zoom buttons and above the attribution', card.clearOfZoom && card.aboveAttr && card.inside, card);
    // hub names come back (in the hub-label pane) once labels are allowed again
    const named = await page.evaluate(() => { H.map.setHubs(H.hubs, {}); H.map.leaflet.setZoom(10, { animate: false }); return document.querySelectorAll('#map .sro-pane-hublabels .sro-icon-hublabel').length; });
    check('hub names draw in the hub-label pane when shown', named >= 1, named);
    await page.screenshot({ path: path.join(OUT, 'phone-320-card-map-dark.png') });
    await ctx.close();
  }
}

// ---- integration checks: map lifecycle races, caller-set views on a hidden map, legs given as encoded
// polylines (plan.routes), overlapping routes in lanes ------------------------------------------------
const INTEG_HELPERS = String.raw`
  // vertices of an SVG path as client-px polylines (one per M)
  window.__pathPts = (el) => {
    const d = el.getAttribute('d') || '', ctm = el.getScreenCTM(), svg = el.ownerSVGElement, out = [];
    const re = /([ML])\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g;
    let m, cur = null;
    while ((m = re.exec(d))) {
      const p = svg.createSVGPoint(); p.x = +m[2]; p.y = +m[3];
      const q = p.matrixTransform(ctm);
      if (m[1] === 'M' || !cur) { cur = []; out.push(cur); }
      cur.push({ x: q.x, y: q.y });
    }
    return out;
  };
  // nearest point on polylines to p: { d, x, y }
  window.__nearest = (p, lines) => {
    let best = { d: Infinity, x: NaN, y: NaN };
    lines.forEach((ln) => {
      for (let i = 1; i < ln.length; i++) {
        const a = ln[i - 1], b = ln[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const x = a.x + t * dx, y = a.y + t * dy, d = Math.hypot(x - p.x, y - p.y);
        if (d < best.d) best = { d, x, y };
      }
    });
    return best;
  };
  // drawn route lines of one color (client px)
  window.__drawn = (color) => Array.from(document.querySelectorAll('#map .sro-pane-routes path.sro-route'))
    .filter((e) => (e.getAttribute('stroke') || '').toLowerCase() === color.toLowerCase()).flatMap(__pathPts);
  // the road geometry of a route (its legs' points, coords or encoded path) in client px
  window.__raw = (r) => {
    const m = H.map.leaflet, mr = document.getElementById('map').getBoundingClientRect();
    return (r.legs || [r]).map((l) => SRO.ui.map.legCoords(l)).filter(Boolean)
      .map((cs) => cs.map((c) => { const p = m.latLngToContainerPoint(c); return { x: mr.left + p.x, y: mr.top + p.y }; }));
  };
  // points every 5 px along each route's road where another route's road runs within 2 px for 10 px
  // either side (shared road, not a crossing, not the ends of the shared stretch), away from controls and
  // the map edge: where routes overlap. others = the routes sharing it.
  window.__overlaps = (routes) => {
    const mr = document.getElementById('map').getBoundingClientRect();
    const raw = routes.map(__raw);
    const avoid = Array.from(document.querySelectorAll('#map .sro-stop, #map .leaflet-control, #map .sro-note, #map .sro-basemap'))
      .map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.height);
    const ok = (p) => p.x > mr.left + 18 && p.x < mr.right - 18 && p.y > mr.top + 18 && p.y < mr.bottom - 18 &&
      !avoid.some((b) => p.x > b.left - 16 && p.x < b.right + 16 && p.y > b.top - 16 && p.y < b.bottom + 16);
    return routes.map((r, i) => {
      const pts = [];
      raw[i].forEach((ln) => {
        const samples = [];
        let next = 0, acc = 0;
        for (let k = 1; k < ln.length; k++) {
          const a = ln[k - 1], b = ln[k], len = Math.hypot(b.x - a.x, b.y - a.y);
          for (; next <= acc + len; next += 5) {
            const t = len ? (next - acc) / len : 0, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            samples.push(ok(p) ? { x: p.x, y: p.y, near: routes.map((o, j) => j).filter((j) => j !== i && __nearest(p, raw[j]).d < 2) } : null);
          }
          acc += len;
        }
        for (let k = 2; k < samples.length - 2; k++) {
          const w = samples.slice(k - 2, k + 3);
          if (w.some((q) => !q)) continue;
          const others = samples[k].near.filter((j) => w.every((q) => q.near.indexOf(j) >= 0));
          if (others.length) pts.push({ x: samples[k].x, y: samples[k].y, others });
        }
      });
      return pts;
    });
  };
  // decodes a PNG (base64) to ImageData
  window.__png = async (b64) => {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const bm = await createImageBitmap(blob), c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d');
    g.drawImage(bm, 0, 0);
    return g.getImageData(0, 0, bm.width, bm.height);
  };
  // share of points p with a pixel of the route's colour (as drawn: 0.95 over the casing) within r px
  window.__seen = (img, pts, hex, r) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), k = [10, 15, 19];
    const want = c.map((v, i) => v * 0.95 + k[i] * 0.05);
    let hit = 0;
    pts.forEach((p) => {
      let found = false;
      for (let y = Math.round(p.y) - r; y <= Math.round(p.y) + r && !found; y++) {
        for (let x = Math.round(p.x) - r; x <= Math.round(p.x) + r && !found; x++) {
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
          const o = (y * img.width + x) * 4, d = img.data;
          if (Math.hypot(d[o] - want[0], d[o + 1] - want[1], d[o + 2] - want[2]) < 40) found = true;
        }
      }
      if (found) hit++;
    });
    return pts.length ? hit / pts.length : 0;
  };
`;

async function integrationChecks(browser, base, allBags) {
  // I1. lifecycle: destroy() at any time (same task, microtask, frame, mid-animation, inside the map's
  // own events) leaves no error behind, and every call after it is a no-op ---------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1000, height: 700 } });
    allBags.push(['integration-lifecycle', bag]);
    const race = await page.evaluate(async () => {
      const errors = [];
      const onErr = (e) => errors.push(String(e.message || e.reason || e));
      window.addEventListener('error', onErr); window.addEventListener('unhandledrejection', onErr);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const B = [[24.9, 121.1], [25.1, 121.6]];
      const scen = {
        'setView then destroy, same task': async (m) => { m.setView([24.5, 121], 10, { animate: false }); m.destroy(); },
        'leaflet setView then destroy, same task': async (m) => { m.leaflet.setView([24.5, 121], 10, { animate: false }); m.destroy(); },
        'fitTo then destroy in a microtask': async (m) => { m.fitTo(B); await Promise.resolve(); m.destroy(); },
        'routes + setView then destroy': async (m) => { m.setRoutes(H.routes); m.leaflet.setView([24.5, 121], 11, { animate: false }); m.destroy(); },
        'animated zoom, destroy same task': async (m) => { m.setRoutes(H.routes); m.leaflet.zoomIn(); m.destroy(); },
        'animated zoom, destroy next frame': async (m) => { m.leaflet.zoomIn(); await frame(); m.destroy(); },
        'animated zoom, destroy at 60 ms': async (m) => { m.setRoutes(H.routes); m.leaflet.zoomIn(); await sleep(60); m.destroy(); },
        'animated fitTo, destroy at 30 ms': async (m) => { m.fitTo(B, { animate: true }); await sleep(30); m.destroy(); },
        'animated pan, destroy at 50 ms': async (m) => { m.leaflet.panBy([200, 100]); await sleep(50); m.destroy(); },
        'flyTo, destroy at 100 ms': async (m) => { m.leaflet.flyTo([24.5, 121.2], 11, { duration: 0.5 }); await sleep(100); m.destroy(); },
        'theme + tiles + fitTaiwan, destroy same task': async (m) => { m.fitTaiwan(); m.setTheme('night'); m.setTilesEnabled(true); m.destroy(); },
        'create then destroy': async (m) => { m.destroy(); },
        'destroy inside moveend': async (m) => { m.setRoutes(H.routes); m.leaflet.once('moveend', () => m.destroy()); m.leaflet.setView([24.5, 121], 10, { animate: false }); },
        'destroy inside zoomend (animated)': async (m) => { m.setRoutes(H.routes); m.leaflet.once('zoomend', () => m.destroy()); m.leaflet.zoomIn(); await sleep(400); },
        'destroy inside zoomstart': async (m) => { m.setRoutes(H.routes); m.leaflet.once('zoomstart', () => m.destroy()); m.leaflet.zoomIn(); await sleep(400); },
        'destroy inside move (pan animation)': async (m) => { m.setRoutes(H.routes); m.leaflet.once('move', () => m.destroy()); m.leaflet.panBy([300, 0]); await sleep(400); },
        'destroy inside click:route': async (m) => {
          m.setRoutes(H.routes); m.on('click:route', () => m.destroy());
          const hit = m.el.querySelector('path.sro-route-hit'), b = hit.getBoundingClientRect();
          hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
        },
        'destroy inside a tiles event': async (m) => { m.on('tiles', () => m.destroy()); m.setTilesEnabled(false); },
        'destroy while hidden, then shown': async (m, div) => { div.style.display = 'none'; await frame(); m.destroy(); div.style.display = 'block'; },
        'destroy while drawing a zone': async (m) => { m.enableZoneDrawing({ kind: 'closed' }); m.destroy(); }
      };
      const res = {};
      for (const k of Object.keys(scen)) {
        const div = document.createElement('div');
        div.style.cssText = 'position:absolute;left:10px;top:10px;width:480px;height:320px';
        document.body.appendChild(div);
        let m = null, threw = null;
        try { m = SRO.ui.map.create(div, { theme: 'dark' }); await scen[k](m, div); } catch (e) { threw = e.message; }
        await sleep(20);
        res[k] = { destroyed: !!(m && m.isDestroyed()), left: div.querySelectorAll('*').length, threw };
        div.remove();
      }
      await sleep(1000);          // pending frames, the 250 ms zoom-end timer, fly frames
      // every call after destroy is a no-op
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:10px;top:10px;width:480px;height:320px';
      document.body.appendChild(div);
      const m = SRO.ui.map.create(div, { theme: 'dark' });
      m.destroy();
      let after = 'ok';
      try {
        m.destroy();
        m.setRoutes(H.routes); m.setTrucks(H.trucksAt(470)); m.setZones(H.zones); m.setHubs(H.hubs); m.setRally(H.rally); m.setPlatoons(H.platoons);
        m.setView([24, 121], 9); m.fitTo([[24, 121], [25, 122]]); m.fitTaiwan(); m.setTheme('night'); m.setRoadsVisible(false);
        m.setTilesEnabled(true); m.invalidateSize();
        const off = m.on('click:route', () => {}); off();
        const s = m.enableZoneDrawing({ kind: 'closed' }); s.cancel();
        if (typeof off !== 'function' || !s || m.isDrawing()) after = 'bad return values';
      } catch (e) { after = 'threw ' + e.message; }
      await sleep(300);
      const left = div.querySelectorAll('*').length;
      div.remove();
      window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onErr);
      return { res, errors, after, left };
    });
    const bad = Object.entries(race.res).filter(([, v]) => !v.destroyed || v.left || v.threw);
    check('destroy() at any time: same task, microtask, next frame, mid zoom/pan/fly, inside map events, hidden', bad.length === 0 && race.errors.length === 0, { scenarios: Object.keys(race.res).length, bad, errors: race.errors.slice(0, 5) });
    check('calls after destroy() are no-ops (no throw, no DOM, no drawing session)', race.after === 'ok' && race.left === 0, { after: race.after, left: race.left });

    // I2. a map created at zero size keeps the view its caller set; with no caller view it fits Taiwan
    const views = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const TPE = [[24.98, 121.42], [25.12, 121.62]];
      const cases = {
        'fitTo while hidden': (m) => m.fitTo(TPE),
        'setView while hidden': (m) => m.setView([22.62, 120.30], 12),
        'leaflet setView while hidden': (m) => m.leaflet.setView([23.97, 121.60], 11),
        'fitTo right after show (same task)': (m, div) => { div.style.display = 'block'; m.fitTo(TPE); },
        'fitTaiwan while hidden': (m) => m.fitTaiwan(),
        'no caller view': () => {},
        'fitTo on a visible map': (m, div) => { div.style.display = 'block'; m.fitTo(TPE); }
      };
      const out = {};
      for (const k of Object.keys(cases)) {
        const div = document.createElement('div');
        div.style.cssText = 'display:none;position:absolute;left:0;top:0;width:420px;height:360px';
        document.body.appendChild(div);
        const visibleFirst = k === 'fitTo on a visible map';
        if (visibleFirst) div.style.display = 'block';
        const m = SRO.ui.map.create(div, { theme: 'dark' });
        cases[k](m, div);
        div.style.display = 'block';
        await sleep(350);
        const lm = m.leaflet, b = lm.getBounds(), c = lm.getCenter(), sz = lm.getSize();
        out[k] = { z: lm.getZoom(), c: [+c.lat.toFixed(3), +c.lng.toFixed(3)], size: [sz.x, sz.y],
          tpe: b.contains(TPE), taiwan: b.contains([25.04, 121.52]) && b.contains([22.0, 120.74]) };
        m.destroy(); div.remove();
      }
      return out;
    });
    const near = (c, t) => Math.abs(c[0] - t[0]) < 0.02 && Math.abs(c[1] - t[1]) < 0.02;
    check('hidden map: fitTo before it is shown is kept (no Taiwan fit over it)', views['fitTo while hidden'].tpe && !views['fitTo while hidden'].taiwan && views['fitTo while hidden'].z >= 9, views['fitTo while hidden']);
    check('hidden map: setView before it is shown is kept', near(views['setView while hidden'].c, [22.62, 120.30]) && views['setView while hidden'].z === 12, views['setView while hidden']);
    check('hidden map: Leaflet setView before it is shown is kept', near(views['leaflet setView while hidden'].c, [23.97, 121.60]) && views['leaflet setView while hidden'].z === 11, views['leaflet setView while hidden']);
    check('hidden map: fitTo in the same task as show is kept', views['fitTo right after show (same task)'].tpe && !views['fitTo right after show (same task)'].taiwan, views['fitTo right after show (same task)']);
    check('hidden map: fitTaiwan / no caller view -> Taiwan once shown', views['fitTaiwan while hidden'].taiwan && views['no caller view'].taiwan && views['no caller view'].size[0] === 420, { fitTaiwan: views['fitTaiwan while hidden'], none: views['no caller view'] });
    check('visible map: fitTo right after create is kept', views['fitTo on a visible map'].tpe && !views['fitTo on a visible map'].taiwan, views['fitTo on a visible map']);
    await ctx.close();
  }

  // I2b. legs given as encoded polylines (plan.routes: leg.path, precision 5) draw and animate exactly as
  // the same legs given as coords --------------------------------------------------------------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1200, height: 800 } });
    allBags.push(['integration-paths', bag]);
    const enc = await page.evaluate(() => {
      const geo = SRO.core.geo, MAP = SRO.ui.map;
      const encR = H.routes.map((r) => Object.assign({}, r, { legs: r.legs.map((l) => ({ path: geo.encodePolyline(l.coords, 5), source: l.source, approximate: l.approximate, depart: l.depart, arrive: l.arrive })) }));
      const decR = encR.map((r) => Object.assign({}, r, { legs: r.legs.map((l) => Object.assign({}, l, { path: undefined, coords: geo.decodePolyline(l.path, 5) })) }));
      const ds = () => Array.from(document.querySelectorAll('#map .sro-pane-routes path')).map((e) => e.getAttribute('class') + '|' + e.getAttribute('stroke') + '|' + e.getAttribute('d'));
      H.map.setRoutes(decR, { highlightTruckId: 'Alpha-1' }); const dCoords = ds();
      H.map.setRoutes(encR, { highlightTruckId: 'Alpha-1' }); const dPath = ds();
      const lines = Array.from(document.querySelectorAll('#map .sro-pane-routes path.sro-route')).length;
      // truck positions over the whole day
      let posSame = 0, posN = 0, moving = 0;
      encR.forEach((r, i) => {
        for (let t = r.depart - 10; t <= r.returnAt + 10; t += (r.returnAt - r.depart) / 40) {
          const a = MAP.truckPosition(r, t), b = MAP.truckPosition(decR[i], t);
          posN++;
          if (a.lat === b.lat && a.lon === b.lon && a.status === b.status && a.legIndex === b.legIndex && a.heading === b.heading) posSame++;
          if (a.status === 'en-route') moving++;
        }
      });
      // the decode cache: one decode per string
      const s = encR[0].legs[0].path, n0 = MAP.pathCacheSize();
      const same = MAP.decodePath(s) === MAP.decodePath(s) && MAP.pathCacheSize() === n0;
      const legSame = MAP.legCoords(encR[0].legs[0]) === MAP.decodePath(s);
      const junk = [MAP.decodePath(''), MAP.decodePath(null), MAP.decodePath(42)].every((x) => x === null);
      // whole-route path only (no legs), and mixed legs (coords + path)
      const whole = { truckId: 'W-1', color: '#C9359A', path: geo.encodePolyline([].concat.apply([], H.routes[0].legs.map((l) => l.coords)), 5), depart: H.routes[0].depart, returnAt: H.routes[0].returnAt };
      const mixed = Object.assign({}, H.routes[1], { truckId: 'M-1', color: '#B0765E', legs: [H.routes[1].legs[0]].concat(encR[1].legs.slice(1)) });
      H.map.setRoutes([whole, mixed], {});
      const wLines = Array.from(document.querySelectorAll('#map .sro-pane-routes path.sro-route')).filter((e) => e.getAttribute('stroke').toLowerCase() === '#c9359a' && (e.getAttribute('d') || '').length > 20).length;
      const mLines = Array.from(document.querySelectorAll('#map .sro-pane-routes path.sro-route')).filter((e) => e.getAttribute('stroke').toLowerCase() === '#b0765e' && (e.getAttribute('d') || '').length > 20).length;
      const mid = MAP.truckPosition(whole, (whole.depart + whole.returnAt) / 2), wc = MAP.decodePath(whole.path);
      const onPath = wc.some((c, k) => {
        if (!k) return false;
        const a = wc[k - 1], dx = c[1] - a[1], dy = c[0] - a[0], l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((mid.lon - a[1]) * dx + (mid.lat - a[0]) * dy) / l2)) : 0;
        return Math.hypot(a[1] + t * dx - mid.lon, a[0] + t * dy - mid.lat) < 1e-6;
      });
      H.map.setRoutes(H.routes, {});
      return { same: dCoords.length > 0 && dCoords.join('\n') === dPath.join('\n'), n: dCoords.length, lines, posSame, posN, moving, cacheOk: same && legSame, junk, wLines, mLines, mixedLegs: mixed.legs.length, mid: mid.status, onPath };
    });
    check('setRoutes: legs as encoded path strings draw exactly as the same legs as coords', enc.same && enc.lines >= 4, { paths: enc.n, lines: enc.lines });
    check('truckPosition: encoded path legs give the same position, heading and status as coords', enc.posSame === enc.posN && enc.moving > 10, { same: enc.posSame, of: enc.posN, enRoute: enc.moving });
    check('decoded paths cached by string (no re-decode), bad input -> null', enc.cacheOk && enc.junk, enc);
    check('route with only a whole-route path, and mixed coords/path legs, are drawn and animated', enc.wLines === 1 && enc.mLines === enc.mixedLegs && enc.mid === 'en-route' && enc.onPath, enc);
    await ctx.close();
  }

  // I3. overlapping routes (three trucks out of FOB Granite on the same roads, one from Jade): every
  // truck's line is visible where roads are shared, at island and at city zoom, after pans and animated
  // zooms; the highlighted route draws on top; a click on a line picks that line's truck --------------
  {
    const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1440, height: 900 } });
    allBags.push(['integration-overlap', bag]);
    await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
    await page.evaluate(INTEG_HELPERS);
    await page.evaluate(() => {
      const grid = SRO.data.grid, byId = (id) => grid.find((g) => g.id === id), roads = SRO.core.roads, geo = SRO.core.geo;
      const colors = SRO.data.scenario.truckColors.map((c) => c.hex);
      function timed(truckId, color, hubId, stopIds, enc) {
        const pts = [byId(hubId)].concat(stopIds.map(byId)).concat([byId(hubId)]), legs = [];
        let t = 400;
        for (let i = 1; i < pts.length; i++) {
          const p = roads.path(pts[i - 1], pts[i], []), d = Math.max(1, Math.round(p.minutes * 1.5));
          legs.push(enc ? { path: geo.encodePolyline(p.coords, 5), source: p.source, depart: t, arrive: t + d } : { coords: p.coords, source: p.source, depart: t, arrive: t + d });
          t += d + 15;
        }
        // no stop markers: at island zoom they would cover most of the shared roads
        return { truckId, color, legs, depart: 400, returnAt: t };
      }
      window.OV = [
        timed('Alpha-1', colors[0], 'G-GRANITE', ['G-TAOYUAN', 'G-ZHUBEI']),
        timed('Alpha-2', colors[1], 'G-GRANITE', ['G-TAOYUAN'], true),
        timed('Alpha-3', colors[3], 'G-GRANITE', ['G-ZHUBEI', 'G-TAICHUNG']),
        timed('Bravo-1', colors[2], 'G-JADE', ['G-TAICHUNG', 'G-PULI'], true)
      ];
      H.map.setPlatoons([]); H.map.setRally([]); H.map.setTrucks([]); H.map.setZones([]); H.map.setHubs([]);
      H.map.setRoutes(OV, {});
    });
    // lanes at the view: routes drawn apart where their roads overlap, the first route on its road
    const lanes = () => page.evaluate(() => {
      const ov = __overlaps(OV), drawn = OV.map((r) => __drawn(r.color));
      let pairs = 0, apart = 0, close = 0, n = 0, firstOff = 0;
      ov.forEach((pts, i) => pts.forEach((p) => {
        n++;
        const qi = __nearest(p, drawn[i]);
        if (qi.d <= 4 * (OV.length - 1) + 2.5) close++;
        if (i === 0) firstOff = Math.max(firstOff, qi.d);
        p.others.forEach((j) => { if (j < i) return; const qj = __nearest(p, drawn[j]); pairs++; if (Math.hypot(qi.x - qj.x, qi.y - qj.y) >= 3) apart++; });
      }));
      return { z: H.map.leaflet.getZoom(), points: ov.map((p) => p.length), n, close, pairs, apart, firstOff: +firstOff.toFixed(2) };
    });
    // each route's colour visible near its overlap points (screenshot pixels)
    const seen = async (label) => {
      await page.waitForTimeout(150);
      const b64 = (await page.screenshot({ path: path.join(OUT, 'overlap-' + label + '.png') })).toString('base64');
      return page.evaluate(async (b64) => {
        const img = await __png(b64), ov = __overlaps(OV);
        return OV.map((r, i) => ({ id: r.truckId, points: ov[i].length, seen: +__seen(img, ov[i], r.color, 4 * (OV.length - 1) + 2).toFixed(2) }));
      }, b64);
    };
    const views = [
      ['island', () => H.map.fitTaiwan({ animate: false }), 0.7],
      ['city', () => H.map.setView([24.955, 121.345], 12, { animate: false }), 0.85]
    ];
    // (apart: the nearest drawn points of two routes at a shared point; at island zoom a few fall where
    // other legs of the same trucks knot around the hub, hence the lower share there)
    for (const [label, fn, share] of views) {
      await page.evaluate(fn);
      await page.waitForTimeout(100);
      const ln = await lanes();
      check('overlapping routes (' + label + ' zoom): drawn apart where roads are shared, first route on its road', ln.n >= 12 && ln.pairs >= 8 && ln.apart >= ln.pairs * share && ln.close >= ln.n * 0.9 && ln.firstOff <= 2.5, ln);
      const sv = await seen(label);
      check('overlapping routes (' + label + ' zoom): every truck colour visible where roads are shared', sv.filter((s) => s.points >= 3).length >= 3 && sv.every((s) => s.points < 3 || s.seen >= 0.8), sv);
    }
    // animated zoom (control button) and a long pan: lanes recomputed for the new view
    await page.click('.leaflet-control-zoom-in');
    await page.waitForTimeout(500);
    const lz = await lanes();
    await page.evaluate(() => H.map.leaflet.panBy([-500, 300], { animate: false }));
    await page.waitForTimeout(100);
    const lp = await lanes();
    check('lanes recomputed after an animated zoom and after a pan', lz.z === 13 && lz.n >= 12 && lz.apart >= lz.pairs * 0.85 && lz.close >= lz.n * 0.9 && lz.firstOff <= 2.5 &&
      lp.n >= 6 && lp.apart >= lp.pairs * 0.85 && lp.close >= lp.n * 0.9 && lp.firstOff <= 2.5, { zoom: lz, pan: lp });
    // chevrons: on every route in view, above every line of their tier
    await page.evaluate(() => H.map.setView([24.955, 121.345], 12, { animate: false }));
    const chev = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('#map .sro-pane-routes path'));
      const idx = (cls) => all.map((e, i) => (e.classList.contains(cls) ? i : -1)).filter((i) => i >= 0);
      const arrows = idx('sro-route-arrows'), lines = idx('sro-route');
      const mr = document.getElementById('map').getBoundingClientRect();
      const inView = (p) => p.x >= mr.left && p.x <= mr.right && p.y >= mr.top && p.y <= mr.bottom;
      // per route (arrows are in route order with no highlight): drawn length in view and chevrons in view
      return OV.map((r, i) => {
        let len = 0;
        __drawn(r.color).forEach((ln) => { for (let k = 1; k < ln.length; k++) if (inView(ln[k - 1]) && inView(ln[k])) len += Math.hypot(ln[k].x - ln[k - 1].x, ln[k].y - ln[k - 1].y); });
        const el = all[arrows[i]], tips = el ? __pathPts(el).filter((c) => c.length === 3 && inView(c[1])).length : 0;
        return { id: r.truckId, len: Math.round(len), chevrons: tips, above: !!el && arrows[i] > Math.max.apply(null, lines) };
      });
    });
    check('direction chevrons along every route in view (about one per 90 px), drawn above the lines', chev.filter((c) => c.len > 400).length >= 3 && chev.every((c) => c.above && (c.len < 400 || c.chevrons >= c.len / 90 * 0.6)), chev);
    // highlight: casing, line and chevrons of the highlighted truck on top; lanes keep the given order
    const hi = await page.evaluate(() => {
      const before = OV.slice(1).map((r) => __drawn(r.color).map((ln) => ln.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(' ')).join('|'));
      H.map.setRoutes(OV, { highlightTruckId: 'Alpha-1' });
      const after = OV.slice(1).map((r) => __drawn(r.color).map((ln) => ln.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(' ')).join('|'));
      const all = Array.from(document.querySelectorAll('#map .sro-pane-routes path'));
      const pos = (pred) => all.map((e, i) => (pred(e) ? i : -1)).filter((i) => i >= 0);
      const hiColor = OV[0].color.toLowerCase();
      const hiLine = pos((e) => e.classList.contains('sro-route') && e.getAttribute('stroke').toLowerCase() === hiColor);
      const otherLines = pos((e) => e.classList.contains('sro-route') && e.getAttribute('stroke').toLowerCase() !== hiColor);
      const casings = pos((e) => e.classList.contains('sro-route-casing')), arrows = pos((e) => e.classList.contains('sro-route-arrows'));
      const w = (i) => +all[i].getAttribute('stroke-width');
      const hiCasing = casings.filter((i) => w(i) === 9), hiArrows = arrows.filter((i) => w(i) === 2.2);
      const hits = pos((e) => e.classList.contains('sro-route-hit'));
      return {
        lineTop: hiLine.length > 0 && Math.min.apply(null, hiLine) > Math.max.apply(null, otherLines),
        casingTop: hiCasing.length === 1 && hiCasing[0] === Math.max.apply(null, casings) && hiCasing[0] > Math.max.apply(null, otherLines),
        arrowsTop: hiArrows.length === 1 && hiArrows[0] === Math.max.apply(null, arrows),
        hitsLast: Math.min.apply(null, hits) > Math.max.apply(null, all.map((e, i) => (e.classList.contains('sro-route-hit') ? -1 : i))),
        lanesKept: before.join('#') === after.join('#')
      };
    });
    const hiSeen = await seen('city-highlight');
    check('highlighted route on top (casing, line, chevrons), lanes unchanged by the highlight', hi.lineTop && hi.casingTop && hi.arrowsTop && hi.hitsLast && hi.lanesKept && hiSeen[0].seen >= 0.9, { hi, seen: hiSeen[0] });
    // real clicks on two lines side by side pick the truck of the line clicked
    await page.evaluate(() => { H.map.setRoutes(OV, {}); window.__clicks = []; H.map.on('click:route', (e) => __clicks.push(e.truckId)); });
    const targets = await page.evaluate(() => {
      const ov = __overlaps(OV), drawn = OV.map((r) => __drawn(r.color)), out = [], used = [];
      const free = (q) => !document.elementsFromPoint(q.x, q.y).some((e) => e.closest('.sro-stop, .leaflet-control, .leaflet-marker-icon'));
      ov.forEach((pts, i) => pts.forEach((p) => {
        if (used.length >= 3 || used.some((u) => Math.hypot(u.x - p.x, u.y - p.y) < 150)) return;
        for (const j of p.others) {
          const qi = __nearest(p, drawn[i]), qj = __nearest(p, drawn[j]);
          if (Math.hypot(qi.x - qj.x, qi.y - qj.y) < 3.5 || !free(qi) || !free(qj)) continue;
          out.push({ id: OV[i].truckId, x: qi.x, y: qi.y }, { id: OV[j].truckId, x: qj.x, y: qj.y });
          used.push(p);
          return;
        }
      }));
      return out;
    });
    const picked = [];
    for (const t of targets) {
      await page.evaluate(() => { __clicks.length = 0; });
      await page.mouse.click(t.x, t.y);
      await page.waitForTimeout(320);
      picked.push({ want: t.id, got: await page.evaluate(() => __clicks.slice()) });
    }
    check('click on one of two lines side by side picks that line\'s truck', picked.length >= 4 && picked.every((p) => p.got.length === 1 && p.got[0] === p.want), picked);
    await ctx.close();
  }
}

async function main() {
  const harness = buildHarness();
  const base = pathToFileURL(harness).href;
  const browser = await chromium.launch();
  const allBags = [];
  try {
    // 1. desktop, dark, tiles blocked -------------------------------------------------------------
    {
      const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1440, height: 900 } });
      allBags.push(['desktop-dark', bag]);
      await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
      const st = await page.evaluate(() => H.map.status());
      check('tiles blocked -> fallback (off, roads shown)', st.tiles === 'off' && st.roads === true, st);
      const perf = await page.evaluate(() => ({ createMs: Math.round(H.createMs), harnessMs: Math.round(H.totalMs) }));
      check('map create (graph load + road lines) under 1.5 s', perf.createMs < 1500, perf);
      const base1 = await page.evaluate(() => {
        const coast = document.querySelectorAll('.sro-pane-coast path').length;
        const cv = document.querySelector('.sro-pane-roads canvas');
        let painted = 0;
        if (cv) {
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) painted++;
        }
        const note = document.querySelector('.sro-note');
        const attr = document.querySelector('.leaflet-control-attribution').textContent;
        return { coast, painted, note: note && note.style.display !== 'none' ? note.textContent : null, attr };
      });
      check('coastline drawn', base1.coast >= 1, base1.coast);
      check('road network lines painted on canvas', base1.painted > 2000, base1.painted);
      check('fallback note shown', /Offline map/.test(base1.note || ''), base1.note);
      check('attribution: OSM/ODbL via Overture + Natural Earth', /OpenStreetMap contributors \(ODbL\), via Overture Maps Foundation/.test(base1.attr) && /Natural Earth/.test(base1.attr), base1.attr);

      // symbols
      const sym = await page.evaluate(() => {
        const S = SRO.ui.symbols, out = {};
        Object.keys(S.SIDC).forEach((k) => { const r = S.render(S.SIDC[k], { size: 24 }); out[k] = { valid: r.valid, svg: /^<svg/.test(r.svg), w: r.width }; });
        const before = S.cacheSize(); S.render(S.SIDC.cargo, { size: 24 }); const after = S.cacheSize();
        const icons = document.querySelectorAll('.sro-icon-platoon').length, hubs = document.querySelectorAll('.sro-icon-hub').length,
          rally = document.querySelectorAll('.sro-icon-rally').length, trucks = document.querySelectorAll('.sro-icon-truck').length,
          imm = document.querySelectorAll('.sro-icon-platoon .sro-urg-Immediate').length;
        const ic = S.platoon(H.platoons[0], { urgency: 'Urgent' }), sy = new ms.Symbol(S.platoonSidc(H.platoons[0]), { size: 24, uniqueDesignation: H.platoons[0].designator, fontfamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif', simpleStatusModifier: true, colorMode: 'Light', infoColor: '#e8ecef', infoOutlineColor: '#0b1014', infoOutlineWidth: 5, outlineColor: '#0b1014', outlineWidth: 0 });
        const a = sy.getAnchor();
        return { out, cached: before === after, icons, hubs, rally, trucks, imm, anchorOk: Math.abs(ic.options.iconAnchor[0] - a.x) < 1e-9 && Math.abs(ic.options.iconAnchor[1] - a.y) < 1e-9,
          mech: S.platoonSidc({ mobility: 'mounted', vehicle: 'tracked', designator: '1/B/3-21IN' }), mot: S.platoonSidc({ mobility: 'mounted', designator: '1/B/3-21IN' }), dis: S.platoonSidc({ mobility: 'dismounted' }), fix: S.platoonSidc({ mobility: 'fixed' }),
          arm: S.platoonSidc({ mobility: 'mounted', designator: '1/A/5-86AR' }), cav: S.platoonSidc({ mobility: 'dismounted', unitName: '2nd PLT, B TRP, 4-98 CAV' }),
          eng: S.platoonSidc({ mobility: 'mounted', designator: '3/C/2-12EN' }), fa: S.platoonSidc({ mobility: 'mounted', designator: '1/A/3-20FA' }) };
      });
      check('every SIDC valid and renders', Object.values(sym.out).every((x) => x.valid && x.svg), sym.out);
      check('SVG cache hit on repeat render', sym.cached);
      check('icons on map: 8 platoons, 4 hubs, 8 rally, 4 trucks, Immediate ring', sym.icons === 8 && sym.hubs === 4 && sym.rally === 8 && sym.trucks === 4 && sym.imm >= 1, sym);
      check('platoon iconAnchor = milsymbol getAnchor()', sym.anchorOk);
      check('platoon SIDC by mobility', sym.mech === '10031000141211020000' && sym.mot === '10031000141211040000' && sym.dis === '10031000141211000000' && sym.fix === '10031000141211000000', sym);
      // the branch at the end of the designator picks the 2525D entity (armor, reconnaissance, engineer, field artillery)
      check('platoon SIDC by branch', sym.arm === '10031000141205000000' && sym.cav === '10031000141213000000' && sym.eng === '10031000141407000000' && sym.fa === '10031000141303000000', sym);

      // route FOB Granite -> Base Lotus follows roads
      const rt = await page.evaluate(() => {
        const roads = SRO.core.roads, g = SRO.data.grid;
        const a = g.find((x) => x.id === 'G-GRANITE'), b = g.find((x) => x.id === 'G-LOTUS');
        const p = roads.path(a, b, []);
        let off = 0, maxOff = 0;
        for (let i = 1; i < p.coords.length - 1; i++) { const s = roads.snap(p.coords[i]); maxOff = Math.max(maxOff, s.meters); if (s.meters > 30) off++; }
        const straightMi = SRO.core.geo.haversineMi(a, b);
        const r = H.routes.find((x) => x.truckId === 'Alpha-1');
        const svgPaths = Array.from(document.querySelectorAll('.sro-pane-routes path.sro-route')).filter((e) => e.getAttribute('stroke').toLowerCase() === r.color.toLowerCase()).length;
        const chevrons = Array.from(document.querySelectorAll('.sro-pane-routes path')).map((e) => (e.getAttribute('d') || '').split('M').length - 1).reduce((m, n) => Math.max(m, n), 0);
        return { source: p.source, n: p.coords.length, off, maxOff, miles: p.miles, straightMi, svgPaths, chevrons, minutes: p.minutes };
      });
      check('Granite -> Lotus route on roads (vertices within 30 m of the graph)', rt.source === 'osm-roads' && rt.n > 100 && rt.off === 0, rt);
      check('Granite -> Lotus longer than straight line (real roads)', rt.miles > rt.straightMi * 1.2, { miles: rt.miles.toFixed(1), straight: rt.straightMi.toFixed(1) });
      check('route drawn in truck color with direction chevrons', rt.svgPaths >= 1 && rt.chevrons >= 5, rt);
      await page.screenshot({ path: path.join(OUT, 'desktop-dark-offline.png') });

      // highlight + fit to a route, screenshot
      await page.evaluate(() => { const r = H.routes.find((x) => x.truckId === 'Alpha-1'); H.map.setRoutes(H.routes, { highlightTruckId: 'Alpha-1' }); H.map.fitTo(r.legs.flatMap((l) => l.coords)); });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, 'desktop-dark-route-granite-lotus.png') });

      // truck moves with simMin
      const mv = await page.evaluate(() => {
        const r = H.routes.find((x) => x.truckId === 'Alpha-1');
        const leg = r.legs[0];
        const t1 = leg.depart + (leg.arrive - leg.depart) * 0.25, t2 = leg.depart + (leg.arrive - leg.depart) * 0.6;
        const el = () => document.querySelector('.sro-icon-truck .sro-truck[data-truck="Alpha-1"]').closest('.leaflet-marker-icon');
        const a = H.setSim(t1).find((x) => x.id === 'Alpha-1'); const tf1 = el().style.transform; const hd1 = el().querySelector('.sro-heading').style.transform;
        const b = H.setSim(t2).find((x) => x.id === 'Alpha-1'); const tf2 = el().style.transform; const hd2 = el().querySelector('.sro-heading').style.transform;
        const before = SRO.ui.map.truckPosition(r, r.depart - 5), after = SRO.ui.map.truckPosition(r, r.returnAt + 5), atStop = SRO.ui.map.truckPosition(r, r.legs[0].arrive + 1);
        const sameEl = el() === el();
        return { a, b, tf1, tf2, hd1, hd2, before: before.status, after: after.status, atStop: atStop.status, sameEl, count: document.querySelectorAll('.sro-icon-truck').length };
      });
      check('truckPosition statuses (at-hub, en-route, at-stop, returned)', mv.before === 'at-hub' && mv.a.status === 'en-route' && mv.atStop === 'at-stop' && mv.after === 'returned', mv);
      check('truck marker moves when simMin changes', mv.tf1 !== mv.tf2 && (mv.a.lat !== mv.b.lat || mv.a.lon !== mv.b.lon), { tf1: mv.tf1, tf2: mv.tf2 });
      check('truck heading pointer follows the road', /rotate/.test(mv.hd1) && /rotate/.test(mv.hd2), { hd1: mv.hd1, hd2: mv.hd2 });
      check('trucks updated in place (no duplicates)', mv.count === 4, mv.count);

      // zone drawing with mouse: tap centre, tap edge
      await page.evaluate(() => { H.map.fitTaiwan({ animate: false }); H.map.setRoutes(H.routes, {}); window.__zone = null; H.map.enableZoneDrawing({ kind: 'closed', onDone: (z) => { window.__zone = z; } }); });
      const c = await mapCenterPx(page);
      const expectMi = await page.evaluate(({ x, y }) => {
        const m = H.map.leaflet, r = document.getElementById('map').getBoundingClientRect();
        const a = m.containerPointToLatLng([x - r.left, y - r.top]), b = m.containerPointToLatLng([x - r.left + 60, y - r.top]);
        return m.distance(a, b) / 1609.344;
      }, c);
      const hint1 = await page.textContent('.sro-drawbar span');
      await page.mouse.click(c.x, c.y);
      const hint2 = await page.textContent('.sro-drawbar span');
      await page.mouse.move(c.x + 30, c.y);
      await page.mouse.move(c.x + 60, c.y);
      await page.waitForTimeout(50);
      const previewText = await page.textContent('.sro-drawbar span');
      await page.mouse.click(c.x + 60, c.y);
      await page.waitForFunction(() => window.__zone, null, { timeout: 3000 });
      const z1 = await page.evaluate(() => window.__zone);
      const mapClicks = await page.evaluate(() => H.events.filter((e) => e[0] === 'click:map').length);
      check('mouse zone drawing (tap centre, tap edge)', z1 && z1.kind === 'closed' && Math.abs(z1.radiusMi - expectMi) < Math.max(0.6, expectMi * 0.08), { z1, expectMi: +expectMi.toFixed(2), hint1, hint2, previewText });
      check('drawing taps do not leak as map clicks', mapClicks === 0, mapClicks);
      // drag variant (risk zone)
      await page.evaluate(() => { window.__zone = null; H.map.enableZoneDrawing({ kind: 'risk', rating: 'High', onDone: (z) => { window.__zone = z; } }); });
      await page.mouse.move(c.x - 200, c.y + 80);
      await page.mouse.down();
      await page.mouse.move(c.x - 170, c.y + 80, { steps: 3 });
      await page.mouse.move(c.x - 120, c.y + 80, { steps: 3 });
      await page.waitForTimeout(30);
      await page.screenshot({ path: path.join(OUT, 'desktop-dark-drawing.png') });
      await page.mouse.up();
      await page.waitForFunction(() => window.__zone, null, { timeout: 3000 });
      const z2 = await page.evaluate(() => window.__zone);
      const expect2 = expectMi * 80 / 60;
      check('mouse zone drawing (drag radius), risk High', z2 && z2.kind === 'risk' && z2.rating === 'High' && Math.abs(z2.radiusMi - expect2) < Math.max(0.6, expect2 * 0.08), { z2, expect2: +expect2.toFixed(2) });
      const added = await page.evaluate(({ z1, z2 }) => {
        H.map.setZones(H.zones.concat([Object.assign({ id: 'Z-N1' }, z1), Object.assign({ id: 'Z-N2' }, z2)]));
        const closed = Array.from(document.querySelectorAll('.sro-pane-zones path.sro-zone-closed'));
        return { closed: closed.length, hatched: closed.every((p) => /url\(#sro-hatch-/.test(p.getAttribute('fill'))), labels: document.querySelectorAll('.sro-zone-label').length, dragOn: H.map.leaflet.dragging.enabled(), drawing: H.map.isDrawing() };
      }, { z1, z2 });
      check('drawn zones render (closed hatched) and map handlers restored', added.closed === 2 && added.hatched && added.labels === 5 && added.dragOn && !added.drawing, added);
      // cancel with Escape
      const esc = await page.evaluate(() => { let cancelled = false; H.map.enableZoneDrawing({ kind: 'closed', onCancel: () => { cancelled = true; } }); window.__cancelled = () => cancelled; return H.map.isDrawing(); });
      await page.keyboard.press('Escape');
      const escOk = await page.evaluate(() => window.__cancelled() && !H.map.isDrawing() && !document.querySelector('.sro-drawbar'));
      check('Escape cancels zone drawing', esc && escOk);
      // map controls keep working while drawing (zoom button is not taken as the centre tap)
      const z0 = await page.evaluate(() => { window.__dh = H.map.enableZoneDrawing({ kind: 'closed' }); return H.map.leaflet.getZoom(); });
      await page.click('.leaflet-control-zoom-in');
      await page.waitForTimeout(450);
      const zc = await page.evaluate(() => ({ z: H.map.leaflet.getZoom(), stage: window.__dh.stage() }));
      await page.evaluate(() => window.__dh.cancel());
      check('zoom control works during drawing', zc.z > z0 && zc.stage === 'center', { z0, zc });
      await page.evaluate(() => H.map.fitTaiwan({ animate: false }));

      // click events: platoon marker and route
      const clicked = await page.evaluate(() => {
        H.events.length = 0;
        const m = document.querySelector('.sro-icon-platoon');
        m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return H.events.slice();
      });
      check('click:platoon fires', clicked.some((e) => e[0] === 'click:platoon'), clicked);
      const clickedRoute = await page.evaluate(() => {
        H.events.length = 0;
        const hit = document.querySelector('.sro-pane-routes path.sro-route-hit');
        const b = hit.getBoundingClientRect();
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
        return H.events.slice();
      });
      check('click:route fires (wide invisible hit line)', clickedRoute.some((e) => e[0] === 'click:route') && !clickedRoute.some((e) => e[0] === 'click:map'), clickedRoute);

      // night theme
      const night = await page.evaluate(() => {
        H.map.setTheme('night');
        const el = document.getElementById('map');
        const coast = document.querySelector('.sro-pane-coast path');
        const casing = Array.from(document.querySelectorAll('.sro-pane-routes path')).find((p) => !p.classList.contains('sro-route') && !p.classList.contains('sro-route-hit'));
        const symSvg = document.querySelector('.sro-icon-platoon svg').outerHTML;
        const hubSvg = document.querySelector('.sro-icon-hub svg').outerHTML;
        const ring = getComputedStyle(document.querySelector('.sro-icon-platoon .sro-ring')).borderTopColor;
        const zoneStroke = document.querySelector('.sro-pane-zones path.sro-zone-closed').getAttribute('stroke');
        const bg = getComputedStyle(el).backgroundColor;
        const whiteInSymbols = /#fff\b|#ffffff|rgb\(255, ?255, ?255\)|white/i.test(symSvg + hubSvg);
        return { attr: el.getAttribute('data-sro-theme'), coastFill: coast.getAttribute('fill'), casing: casing && casing.getAttribute('stroke'), red: /#c23a32/i.test(symSvg), whiteInSymbols, ring, zoneStroke, bg };
      });
      check('night theme recolors map (coast, casing, zones, background)', night.attr === 'night' && night.coastFill === '#0d0404' && night.casing === '#000000' && night.zoneStroke === '#c0302a' && night.bg === 'rgb(0, 0, 0)', night);
      check('night symbols drawn in dim red, no white', night.red && !night.whiteInSymbols, night);
      // inline symbols (unit strip, unit card, card map key) are drawn again in the night style: an
      // unfilled dim red frame, not the friendly blue fill filtered to red (red fill reads as hostile)
      const inl = await page.evaluate(() => {
        const S = SRO.ui.symbols;
        const host = document.createElement('div');
        host.innerHTML = S.svg(S.SIDC.mechanized, { size: 24, theme: 'dark' }) + S.svg(S.SIDC.armor, { size: 24, theme: 'dark' });
        document.body.appendChild(host);
        const fills = () => [...host.querySelectorAll('svg [fill]')].map((e) => e.getAttribute('fill').toLowerCase()).filter((f) => f !== 'none' && f !== 'transparent' && f !== '#000000' && f !== 'black');
        const before = fills();
        const n = S.refreshInline(host, 'night');
        const after = fills();
        const red = /#c23a32/i.test(host.innerHTML);
        host.remove();
        return { n, before: [...new Set(before)], after: [...new Set(after)], red };
      });
      check('inline symbols redrawn for night: dim red outline, no fill', inl.n === 2 && inl.before.length > 0 && inl.red && inl.after.every((f) => /#c23a32|#b8342d/.test(f)), inl);
      await page.screenshot({ path: path.join(OUT, 'desktop-night-offline.png') });
      await page.evaluate(() => { H.map.setTheme('light'); });
      await page.screenshot({ path: path.join(OUT, 'desktop-light-offline.png') });
      // gallery screenshots
      for (const th of ['dark', 'light', 'night']) {
        const p2 = await ctx.newPage();
        const bag2 = { errors: [], tiles: 0, external: [], blockedTiles: true };
        watchConsole(p2, bag2); allBags.push(['gallery-' + th, bag2]);
        await p2.route('**/*', (r) => r.request().url().includes(TILE_HOST) ? r.abort('internetdisconnected') : r.continue());
        await p2.goto(base + '?theme=' + th);
        await p2.waitForFunction(() => window.H && window.H.ready);
        await p2.evaluate(() => H.gallery(true));
        await p2.screenshot({ path: path.join(OUT, 'gallery-' + th + '.png') });
        await p2.close();
      }
      await ctx.close();
    }

    // 2. phone, touch emulation, dark -----------------------------------------------------------------
    {
      const { ctx, page, bag } = await openPage(browser, base + '?theme=dark&hi=Delta-2', { viewport: { width: 390, height: 844 }, touch: true });
      allBags.push(['phone-dark', bag]);
      await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, 'phone-dark-offline.png') });
      const sizes = await page.evaluate(() => {
        const a = document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect();
        const b = document.querySelector('.sro-basemap button').getBoundingClientRect();
        return { zoom: [a.width, a.height], base: [b.width, b.height], scrollW: document.documentElement.scrollWidth };
      });
      check('touch targets >= 44 px on phone, no horizontal scroll', sizes.zoom[0] >= 44 && sizes.zoom[1] >= 44 && sizes.base[1] >= 44 && sizes.scrollW <= 390, sizes);
      await page.evaluate(() => { window.__zone = null; H.map.enableZoneDrawing({ kind: 'closed', onDone: (z) => { window.__zone = z; } }); });
      const c = await mapCenterPx(page);
      const expectMi = await page.evaluate(({ x, y }) => {
        const m = H.map.leaflet, r = document.getElementById('map').getBoundingClientRect();
        return m.distance(m.containerPointToLatLng([x - r.left, y - r.top]), m.containerPointToLatLng([x - r.left + 70, y - r.top])) / 1609.344;
      }, c);
      await page.touchscreen.tap(c.x, c.y);
      await page.waitForTimeout(80);
      const stage = await page.evaluate(() => H.map.isDrawing() && document.querySelector('.sro-drawbar span').textContent);
      await page.touchscreen.tap(c.x + 70, c.y);
      await page.waitForFunction(() => window.__zone, null, { timeout: 3000 }).catch(() => null);
      const z = await page.evaluate(() => window.__zone);
      check('touch zone drawing (tap centre, tap edge)', z && Math.abs(z.radiusMi - expectMi) < Math.max(0.6, expectMi * 0.08), { z, expectMi: +expectMi.toFixed(2), stage });
      // touch drag variant via CDP touch events
      await page.evaluate(() => { window.__zone = null; H.map.enableZoneDrawing({ kind: 'risk', rating: 'Medium', onDone: (z) => { window.__zone = z; } }); });
      const cdp = await ctx.newCDPSession(page);
      const tp = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(c.x, c.y + 100) });
      for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(c.x + k * 15, c.y + 100) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => window.__zone, null, { timeout: 3000 }).catch(() => null);
      const zd = await page.evaluate(() => window.__zone);
      const expectD = expectMi * 90 / 70;
      check('touch zone drawing (drag radius)', zd && zd.kind === 'risk' && Math.abs(zd.radiusMi - expectD) < Math.max(0.6, expectD * 0.1), { zd, expectD: +expectD.toFixed(2) });
      await page.evaluate(({ z, zd }) => H.map.setZones(H.zones.concat([Object.assign({ id: 'T1' }, z), Object.assign({ id: 'T2' }, zd)])), { z, zd });
      await page.screenshot({ path: path.join(OUT, 'phone-dark-zones.png') });
      await page.evaluate(() => { H.map.setTheme('night'); });
      await page.screenshot({ path: path.join(OUT, 'phone-night-offline.png') });
      await ctx.close();
    }

    // 2b. PSG mini map (compact) in a phone card, night theme too
    {
      const { ctx, page, bag } = await openPage(browser, base + '?theme=dark&mini=1&sim=520', { viewport: { width: 390, height: 844 }, touch: true });
      allBags.push(['phone-mini', bag]);
      await page.waitForFunction(() => H.map.status().tiles === 'off', null, { timeout: 12000 });
      await page.waitForTimeout(300);
      const mini = await page.evaluate(() => ({ basemapCtl: !!document.querySelector('.sro-basemap'), scale: !!document.querySelector('.leaflet-control-scale'), trucks: document.querySelectorAll('.sro-icon-truck').length, w: document.getElementById('map').clientWidth }));
      check('compact map: no basemap/scale controls, trucks shown', !mini.basemapCtl && !mini.scale && mini.trucks === 4, mini);
      await page.screenshot({ path: path.join(OUT, 'phone-mini-dark.png') });
      await page.evaluate(() => H.map.setTheme('night'));
      await page.screenshot({ path: path.join(OUT, 'phone-mini-night.png') });
      const d = await page.evaluate(() => {
        const div = document.createElement('div'); div.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:200px'; document.body.appendChild(div);
        const m2 = SRO.ui.map.create(div, { theme: 'light' }); m2.setHubs(H.hubs); m2.setZones(H.zones);
        const had = div.querySelectorAll('.leaflet-pane').length;
        m2.destroy(); m2.destroy();
        const left = div.querySelectorAll('*').length; div.remove();
        return { had, left, defs: document.querySelectorAll('.sro-defs').length };
      });
      check('destroy() removes the map and its DOM', d.had > 5 && d.left === 0 && d.defs === 1, d);
      // created while hidden (e.g. a planner tab), then shown: resizes and fits Taiwan by itself
      await page.evaluate(() => {
        const div = document.createElement('div'); div.id = 'hidden-map'; div.style.cssText = 'display:none;position:absolute;left:0;top:0;width:320px;height:480px'; document.body.appendChild(div);
        window.__m3 = SRO.ui.map.create(div, { theme: 'dark' });
        div.style.display = 'block';
      });
      await page.waitForTimeout(300);
      const hv = await page.evaluate(() => { const m = window.__m3.leaflet, sz = m.getSize(), b = m.getBounds(); const r = { w: sz.x, h: sz.y, z: m.getZoom(), taipei: b.contains([25.04, 121.52]), hengchun: b.contains([22.0, 120.74]) }; window.__m3.destroy(); document.getElementById('hidden-map').remove(); return r; });
      check('map created hidden fits Taiwan once shown', hv.w === 320 && hv.h === 480 && hv.taipei && hv.hengchun, hv);
      await ctx.close();
    }

    // 3. tiles served (simulated OSM), dark + night filters -------------------------------------------
    {
      const { ctx, page, bag } = await openPage(browser, base + '?theme=dark', { viewport: { width: 1440, height: 900 }, tileMode: 'serve' });
      allBags.push(['tiles-served', bag]);
      await page.waitForFunction(() => H.map.status().tiles === 'on', null, { timeout: 10000 });
      await page.waitForTimeout(1200);
      const st = await page.evaluate(() => ({ s: H.map.status(), note: document.querySelector('.sro-note').style.display, filter: getComputedStyle(document.querySelector('.sro-tiles')).filter, roads: !!document.querySelector('.sro-pane-roads canvas') && H.map.status().roads }));
      check('working tiles: layer on, fallback note hidden, roads toggled off', st.s.tiles === 'on' && st.note === 'none' && st.s.roads === false, st);
      check('dark theme dims/inverts tiles via CSS filter', /invert/.test(st.filter), st.filter);
      await page.screenshot({ path: path.join(OUT, 'desktop-dark-tiles.png') });
      await page.click('.sro-basemap button[data-k="roads"]');
      const roadsOn = await page.evaluate(() => H.map.status().roads);
      check('roads toggle works when tiles are on', roadsOn === true);
      await page.evaluate(() => H.map.setTheme('night'));
      const nf = await page.evaluate(() => getComputedStyle(document.querySelector('.sro-tiles')).filter);
      check('night theme red-tints tiles', /sepia/.test(nf) && /hue-rotate/.test(nf), nf);
      await page.screenshot({ path: path.join(OUT, 'desktop-night-tiles.png') });
      await ctx.close();
    }

    // 4. blocked with a 403 image body: tileload fires, the fetch probe must catch it --------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await ctx.newPage();
      const bag = { errors: [], tiles: 0, external: [], blockedTiles: true };
      watchConsole(page, bag); allBags.push(['tiles-403-png', bag]);
      await page.route('**/*', (r) => r.request().url().includes(TILE_HOST)
        ? r.fulfill({ status: 403, contentType: 'image/png', body: FAKE_TILE, headers: { 'access-control-allow-origin': '*' } }) : r.continue());
      await page.goto(base + '?theme=light');
      await page.waitForFunction(() => window.H && H.map.status().tiles === 'off', null, { timeout: 10000 }).catch(() => null);
      const st = await page.evaluate(() => H.map.status());
      check('403 with image body -> fallback via fetch probe', st.tiles === 'off' && st.reason === 'blocked', st);
      await ctx.close();
    }

    // 5. review: harder checks (real hit testing, tile state, edge sizes, themes, storage, long names) ---
    await reviewChecks(browser, base, allBags);

    // 6. integration: lifecycle races, caller views on hidden maps, encoded leg paths, overlapping routes
    await integrationChecks(browser, base, allBags);
  } finally {
    await browser.close();
  }

  for (const [name, bag] of allBags) {
    check('no console errors (' + name + ')', bag.errors.length === 0, bag.errors.length ? bag.errors.slice(0, 5) : 'ok, ' + bag.tiles + ' blocked-tile messages filtered');
    check('no external requests except tiles (' + name + ')', bag.external.length === 0, bag.external.slice(0, 3));
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed; screenshots in ' + OUT);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
