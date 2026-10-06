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
      const hubTxt = Array.from(new Set(Array.from(document.querySelectorAll('#map .sro-icon-hub svg text')).map((t) => t.textContent).filter((t) => /FORWARD/.test(t))));   // milsymbol draws field text twice (outline + fill)
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
          mech: S.platoonSidc({ mobility: 'mounted', designator: '1/A/5-86AR' }), mot: S.platoonSidc({ mobility: 'mounted', designator: '1/B/3-21IN' }), dis: S.platoonSidc({ mobility: 'dismounted' }), fix: S.platoonSidc({ mobility: 'fixed' }) };
      });
      check('every SIDC valid and renders', Object.values(sym.out).every((x) => x.valid && x.svg), sym.out);
      check('SVG cache hit on repeat render', sym.cached);
      check('icons on map: 8 platoons, 4 hubs, 8 rally, 4 trucks, Immediate ring', sym.icons === 8 && sym.hubs === 4 && sym.rally === 8 && sym.trucks === 4 && sym.imm >= 1, sym);
      check('platoon iconAnchor = milsymbol getAnchor()', sym.anchorOk);
      check('platoon SIDC by mobility', sym.mech === '10031000141211020000' && sym.mot === '10031000141211040000' && sym.dis === '10031000141211000000' && sym.fix === '10031000141211000000', sym);

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
