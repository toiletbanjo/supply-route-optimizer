#!/usr/bin/env node
// Playwright checks for the planner Scenario and Outputs tabs (src/ui/planner/scenario.js,
// src/ui/planner/outputs.js, the PLANNER SCENARIO / OUTPUTS section of src/styles.css). Plain node
// script:
//
//   node tests/ui/planner-scenario.spec.mjs [--quick] [--only phone|desktop|tablet|dark|phone:night]
//                                           [--no-build --file PATH] [--shots DIR] [--no-contingency]
//
// Builds the single file (python3 tools/build.py --out <tmp>) and opens it from file://. A seed
// state is made once with the real planner engine (19 sample requests, a short Tabu search run,
// approved) and loaded into every page before boot. Then, once per viewport (1440x900 and 390x844)
// in the dark theme, it checks:
//   - trucks per hub (Fleet steppers, typed count, the Settings shortcut) change the fleet
//   - mark a truck out (reason, expected back) and available again; the Re-plan banner appears,
//     folds and unfolds; Re-plan now runs engine.replan (dark theme only: it runs the solver)
//   - draw a closed zone and a risk zone on the planner map with the mouse and with touch
//     emulation (tap centre + tap edge, and drag), then edit radius and rating and remove
//   - pin, ban and clear drop points (rows and the map's rally dialog); max drop points
//   - every solver knob type (int, float, bool; number box and slider) for every method: the
//     changed dot and "default: X", clamping, estimate refresh, Reset to defaults; each panel has
//     one row per SRO.solver.PARAMS entry
//   - settings, knobs and the time-of-day table persist across a reload (own short session)
//   - time-of-day table validation (gap, overlap, bad time) and save
//   - movement table and CSV download content, pickup notices, print layouts (print media)
//   - snapshots (save, list, compare, open), history
//   - export -> reset -> import round trip
//   - movement tables and notices against the plan data (DTG, MGRS, miles, gallons, byRequest stops
//     and stops before, one entry per platoon, item and class on every load and deferred line);
//     count steppers keep their number box; the daily-use table is not a nested scroll box
//   - no horizontal page scroll, no white in night mode, zero console errors (blocked
//     OpenStreetMap tiles are expected and ignored) and no non-tile network requests
// The light and night themes (and 820x1180 in all three) get a screenshot pass only: theme boot,
// no white in night mode, count steppers, no horizontal scroll on every subtab (--quick: dark only). Then a contingency runs once with the real
// engine (0800: a truck with stops made and stops left breaks down, a road closes ahead; Re-plan now,
// Review, approve) and its outputs are checked in every size and theme: the banner is gone, Done
// stops, the Out of service end row, the CSV done column, Delivered / Updated notices, History
// requests and the before / after compare (--no-contingency skips it). Screenshots go to
// /tmp/claude-0/ui-shots/planner-scenario/. Exits 1 on any failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const QUICK = flag('--quick');
const SHOTS = opt('--shots', '/tmp/claude-0/ui-shots/planner-scenario');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true }
];
const TABLET = { name: 'tablet', width: 820, height: 1180, mobile: true };
const THEMES = QUICK ? ['dark'] : ['dark', 'light', 'night'];
const TILE_RE = /tile\.openstreetmap\.org/i;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-scenario-files-'));

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

// ---- build ----------------------------------------------------------------------------------------
function build() {
  if (flag('--no-build')) {
    const f = path.resolve(opt('--file', path.join(ROOT, 'prototype/supply-route-app.html')));
    if (!fs.existsSync(f)) throw new Error('no built file at ' + f);
    return f;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-scenario-spec-'));
  const out = path.join(dir, 'supply-route-app.html');
  let output;
  try {
    output = execFileSync('python3', ['tools/build.py', '--quiet', '--out', out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    process.stderr.write(String(e.stdout || '') + String(e.stderr || ''));
    throw new Error('build failed');
  }
  console.log('build: ' + output.trim().split('\n').pop());
  return out;
}

// ---- check bookkeeping ----------------------------------------------------------------------------
const failures = [];
let passed = 0;
let scope = '';
function check(cond, msg, detail) {
  if (cond) { passed++; return true; }
  const d = detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600);
  failures.push(scope + ': ' + msg + d);
  console.log('  FAIL ' + msg + d);
  return false;
}
async function step(name, fn) {
  try { await fn(); } catch (e) { check(false, name + ' threw', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}

// ---- page helpers ---------------------------------------------------------------------------------
async function settle(page, ms) {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const finite = document.getAnimations().filter((a) => { const t = a.effect && a.effect.getComputedTiming(); return t && isFinite(t.endTime); });
    await Promise.all(finite.map((a) => a.finished.catch(() => null)));
  });
  if (ms) await page.waitForTimeout(ms);
}
async function waitApp(page) {
  await page.waitForFunction(() => window.SRO && SRO.app && SRO.app.store && SRO.ui && SRO.ui.scenario && SRO.ui.outputs && document.querySelector('#topbar'), null, { timeout: 20000 });
  await settle(page);
}
const state = (page, fn, arg) => page.evaluate(fn, arg);
async function showScenario(page, sub) {
  await page.evaluate((sub) => { SRO.ui.plannerTabs.show('scenario'); SRO.ui.scenario.show(sub); }, sub);
  await settle(page);
}
async function showOutputs(page, sub) {
  await page.evaluate((sub) => { SRO.ui.plannerTabs.show('outputs'); SRO.ui.outputs.show(sub); }, sub);
  await settle(page);
}
// change a value the way a person does: fill, then commit (change event)
async function commit(page, sel, value) {
  const l = page.locator(sel).first();
  await l.scrollIntoViewIfNeeded();
  await l.fill(String(value));
  await l.dispatchEvent('change');
  await settle(page);
}
// sliders: set the position and fire input + change
async function slide(page, sel, pos) {
  await page.evaluate(({ sel, pos }) => {
    const el = document.querySelector(sel);
    el.value = String(pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel, pos });
  await settle(page);
}
// screenshots show the screen, not the stack of confirmation toasts the steps before left behind
async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('#toast-root > .toast, .toast-root > .toast').forEach((t) => t.remove()));
}
const toastTexts = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#toast-root > .toast')).map((t) => ({
  text: t.querySelector('.toast-msg').textContent, action: !!t.querySelector('.toast-action') })));
async function closeModals(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.modal-backdrop').count())) return;
    await page.keyboard.press('Escape');
    await settle(page, 60);
  }
}
async function overflowOk(page, width, where) {
  const r = await page.evaluate(() => {
    const wide = [];
    for (const root of document.querySelectorAll('.sc, .op')) {
      if (!root.offsetParent) continue;
      if (root.scrollWidth > root.clientWidth + 1) wide.push(root.className + ' ' + root.scrollWidth + '>' + root.clientWidth);
    }
    return { doc: document.documentElement.scrollWidth, wide };
  });
  check(r.doc <= width + 1 && !r.wide.length, 'no horizontal scroll (' + where + ')', r);
}
// every visible count stepper shows its number box: wide enough for two digits, inside the panel
// and not covered by its - / + buttons
async function steppersOk(page, where) {
  await clearToasts(page);
  const r = await page.evaluate(() => {
    const bad = [];
    let n = 0;
    document.querySelectorAll('.sc .sc-stepper > input').forEach((i) => {
      if (!i.offsetParent) return;
      n++;
      i.scrollIntoView({ block: 'center' });
      const b = i.getBoundingClientRect(), panel = i.closest('.sc').getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (b.width < 28 || b.left < panel.left - 1 || b.right > panel.right + 1 || top !== i) bad.push((i.getAttribute('data-fk') || i.id) + ' w=' + Math.round(b.width) + ' hit=' + (top && top.tagName));
    });
    return { n, bad };
  });
  check(r.n > 0 && !r.bad.length, 'count steppers show their number box (' + where + ')', r);
}
// night mode: nothing white or near-white in the scenario / outputs views or open modals
async function nightOk(page, where) {
  const bad = await page.evaluate(() => {
    const out = [];
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const els = document.querySelectorAll('.sc *, .op *, .modal *, .sc, .op');
    for (const el of els) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      for (const prop of ['backgroundColor', 'color', 'borderTopColor']) {
        const c = parse(cs[prop]);
        if (!c || c.a < 0.2) continue;
        if (prop === 'borderTopColor' && cs.borderTopStyle === 'none') continue;
        if (Math.min(c.r, c.g, c.b) > 170) { out.push((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + ' ' + prop + ' ' + cs[prop]); break; }
      }
      if (out.length > 5) break;
    }
    return out;
  });
  check(!bad.length, 'night theme has no white (' + where + ')', bad);
}

// Runs in the page (Outputs > Notices shown): each card against the engine's byRequest for the
// shown plan. Every stop of a request is listed in time order with its grid, ETA (or Delivered for a
// stop a re-plan kept as made), truck and stops before; deferred loads say what is not coming.
function noticeAudit() {
  const st = SRO.app.store.getState(), F = SRO.core.format, H = SRO.data.catalogHelpers;
  const planId = document.querySelector('.op-plan-select').value;
  const plan = st.plans.find((p) => p.id === planId);
  const issues = [];
  let updated = 0, done = 0;
  const cards = document.querySelectorAll('section.op-notice');
  cards.forEach((card) => {
    const rid = card.getAttribute('data-request');
    const b = plan.byRequest[rid];
    if (card.getAttribute('data-updated') === 'true') { updated++; if (!card.querySelector('.op-updated')) issues.push(rid + ' updated without a badge'); }
    if (!b) { issues.push(rid + ' not in byRequest'); return; }
    const kvs = Array.from(card.querySelectorAll('.op-notice-kv'));
    const stops = (b.stops || []).slice().sort((x, y) => x.eta - y.eta);
    if (kvs.length !== stops.length) issues.push(rid + ' lists ' + kvs.length + ' stops, engine ' + stops.length);
    let last = -Infinity;
    kvs.forEach((kv, i) => {
      const m = {};
      kv.querySelectorAll('dt').forEach((dt) => { m[dt.textContent] = dt.nextElementSibling.textContent; });
      const time = m.ETA || m.Delivered || '';
      const bs = stops.find((s) => m.Truck.indexOf(s.truckId) >= 0 && time.indexOf(F.dtg(s.eta)) >= 0);
      if (!bs) { issues.push(rid + ' stop ' + i + ' (' + m.Truck + ' ' + time + ') not in byRequest'); return; }
      if (bs.eta < last) issues.push(rid + ' stops not in time order');
      last = bs.eta;
      if (m.MGRS !== F.mgrs(bs.lat, bs.lon)) issues.push(rid + ' stop ' + i + ' MGRS');
      if (bs.done) {
        done++;
        if (!('Delivered' in m) || 'ETA' in m || 'Stops before' in m || kv.getAttribute('data-done') !== 'true') issues.push(rid + ' stop ' + i + ' made: should read Delivered without stops before');
      } else if (!('ETA' in m) || m['Stops before'] !== String(bs.stopsBefore)) issues.push(rid + ' stop ' + i + ' stops before ' + m['Stops before'] + ' vs ' + bs.stopsBefore);
    });
    const def = (plan.deferred || []).filter((d) => d.requestId === rid && !(d.qty <= 0));
    const dn = card.querySelector('.op-notice-def');
    if (def.length && !dn) issues.push(rid + ' deferred load not shown');
    if (dn) {
      const t = (dn.querySelector(':scope > div') || dn).textContent.trim();
      if (!/^(Part of this request is not|Not) in this window: .+ · Class [IVX]+ \(.+\)\.( Next plan at \d{4}\.)?$/.test(t)) issues.push(rid + ' deferred text: ' + t);
      const req = st.requests.find((r) => r.id === rid);
      def.forEach((d) => {
        const li = Array.isArray(d.lineIdx) ? d.lineIdx[0] : d.lineIdx;
        const line = req && typeof li === 'number' ? req.lines[li] : null;
        const it = H.itemById(d.itemId || (line && line.itemId));
        if (it && t.indexOf(it.name) < 0) issues.push(rid + ' deferred text lacks ' + it.name);
      });
    }
  });
  return { issues: issues.slice(0, 8), cards: cards.length, byRequest: Object.keys(plan.byRequest).length, updated, done };
}

// Outputs > History: opens the window's Requests list and checks one row per request with its
// status badge (and the Updated mark where a re-plan changed it).
async function historyRequests(page, windowId) {
  const closed = await page.evaluate((w) => { const d = document.querySelector('details.op-hreqs[data-window="' + w + '"]'); return !!d && !d.open; }, windowId);
  await page.locator('details.op-hreqs[data-window="' + windowId + '"] > summary').click();
  await settle(page);
  return page.evaluate((w) => {
    const st = SRO.app.store.getState();
    const d = document.querySelector('details.op-hreqs[data-window="' + w + '"]');
    const reqs = st.requests.filter((r) => r.windowId === w);
    const bad = [];
    let updated = 0;
    d.querySelectorAll('li.op-hreq').forEach((li) => {
      const r = reqs.find((x) => x.id === li.getAttribute('data-request'));
      if (!r) { bad.push(li.getAttribute('data-request') + ' not in window'); return; }
      if (!li.querySelector('.badge.st-' + r.status)) bad.push(r.id + ' status ' + r.status);
      if (li.querySelector('.op-updated')) updated++;
      if (li.textContent.indexOf(r.unitName) < 0) bad.push(r.id + ' platoon');
    });
    return { closed: null, open: d.open, summary: d.querySelector('summary').textContent, want: reqs.length, items: d.querySelectorAll('li.op-hreq').length, updated, bad: bad.slice(0, 5) };
  }, windowId).then((r) => Object.assign(r, { closed: closed && r.open }));
}

// ---- page factory ---------------------------------------------------------------------------------
async function openPage(browser, url, vp, seed) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: true, isMobile: !!vp.mobile, acceptDownloads: true });
  const blocked = [];
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/i.test(u)) return route.continue();
    if (!TILE_RE.test(u)) blocked.push(u);
    return route.abort();
  });
  // seed localStorage once per context (the marker key survives reloads, so a reload keeps changes)
  await ctx.addInitScript((seed) => {
    try {
      if (window.top !== window || localStorage.getItem('sro-spec-seeded')) return;
      if (seed) localStorage.setItem('sro.v1', seed); else localStorage.removeItem('sro.v1');
      localStorage.setItem('sro-spec-seeded', '1');
    } catch (e) { /* storage blocked: the app falls back to memory */ }
  }, seed || null);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    if (TILE_RE.test(loc.url || '') || TILE_RE.test(m.text())) return;
    errors.push(m.text() + (loc.url ? ' @ ' + loc.url.slice(0, 80) : ''));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  await page.goto(url);
  await waitApp(page);
  return { ctx, page, errors, blocked };
}

// ---- seed: samples + a real engine plan, approved ----------------------------------------------
async function makeSeed(browser, url) {
  scope = 'seed';
  const { ctx, page, errors } = await openPage(browser, url, VIEWPORTS[0], null);
  const r = await page.evaluate(async () => {
    const S = SRO.app.store, E = SRO.core.engine;
    S.dispatch({ type: 'role/set', role: 'planner' });
    const ld = S.dispatch({ type: 'samples/load' });
    const plan = await E.run({ method: 'tabu', timeCapSec: 5 });
    const ap = S.dispatch({ type: 'plan/approve', planId: plan.id });
    const st = S.getState();
    return { loaded: ld.ok, requests: st.requests.length, planId: plan.id, approved: ap.ok, used: plan.routes.filter((x) => x.stops.length).length, json: S.exportJson() };
  });
  check(r.loaded && r.requests === 19 && r.approved && r.used > 0, 'seed: 19 sample requests and an approved engine plan', { requests: r.requests, planId: r.planId, used: r.used });
  check(!errors.length, 'seed: no console errors', errors);
  await ctx.close();
  return r.json;
}

// ---- CSV parsing ----------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- map drawing helpers --------------------------------------------------------------------------
async function mapGeom(page, dx) {
  return page.evaluate((dx) => {
    const box = document.querySelector('[data-testid="planner-map"]') || document.querySelector('.pm .sro-map');
    const m = typeof SRO.ui.plannerMap === 'function' ? SRO.ui.plannerMap() : SRO.ui.plannerMap;
    const r = box.getBoundingClientRect();
    // a point left of centre, clear of the legend (bottom right) and the draw bar (top)
    const cx = Math.round(r.left + r.width * 0.42), cy = Math.round(r.top + r.height * 0.45);
    const L = m && m.leaflet;
    let mi = null;
    if (L) mi = L.distance(L.containerPointToLatLng([cx - r.left, cy - r.top]), L.containerPointToLatLng([cx - r.left + dx, cy - r.top])) / 1609.344;
    return { cx, cy, mi, w: r.width, h: r.height };
  }, dx);
}
async function waitDrawbar(page) {
  await page.waitForSelector('.sro-drawbar', { state: 'visible', timeout: 5000 });
  await settle(page, 80);
}
async function zoneCount(page) { return page.evaluate(() => SRO.app.store.getState().scenario.zones.length); }
async function waitZones(page, n) {
  await page.waitForFunction((n) => SRO.app.store.getState().scenario.zones.length === n, n, { timeout: 5000 }).catch(() => null);
  await settle(page, 60);
}
async function touchDrag(ctx, page, x0, y0, dx) {
  const cdp = await ctx.newCDPSession(page);
  const tp = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x0, y0) });
  for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(x0 + Math.round(dx * k / 6), y0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function mouseDrag(page, x0, y0, dx) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + dx / 2, y0, { steps: 3 });
  await page.mouse.move(x0 + dx, y0, { steps: 3 });
  await page.mouse.up();
}

// ---- one viewport x theme -------------------------------------------------------------------------
async function runCombo(browser, url, vp, theme, seed) {
  scope = vp.name + ' ' + vp.width + 'x' + vp.height + ' ' + theme;
  console.log('\n== ' + scope);
  const s0 = JSON.parse(seed);
  s0.ui.theme = theme;
  const { ctx, page, errors, blocked } = await openPage(browser, url, vp, JSON.stringify(s0));
  const tag = vp.width + '-' + theme;
  const shot = async (name, full) => { await clearToasts(page); await settle(page); await page.screenshot({ path: path.join(SHOTS, tag + '-' + name + '.png'), fullPage: !!full }); };
  const night = theme === 'night';
  const runSolver = theme === 'dark';
  const isPhone = vp.width < 600;

  await step('boot', async () => {
    const b = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), role: SRO.app.store.getState().ui.role, scen: SRO.ui.plannerTabs.has('scenario'), outp: SRO.ui.plannerTabs.has('outputs') }));
    check(b.theme === theme && b.role === 'planner' && b.scen && b.outp, 'boots in the planner role with the theme and both tabs registered', b);
  });

  // ---- fleet --------------------------------------------------------------------------------------
  await step('fleet', async () => {
    await showScenario(page, 'fleet');
    const count = (hub, type) => page.evaluate(({ hub, type }) => SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === hub && t.type === type).length, { hub, type });
    const rows = (hub) => page.locator('.sc-hub[data-hub="' + hub + '"] li.sc-truck').count();
    const t0 = await count('HUB-GRANITE', 'tanker'), c0 = await count('HUB-GRANITE', 'cargo'), r0 = await rows('HUB-GRANITE');
    await page.click('[data-fk="fl-HUB-GRANITE-tanker-plus"]');
    await settle(page);
    const t1 = await count('HUB-GRANITE', 'tanker'), r1 = await rows('HUB-GRANITE');
    const added = await page.evaluate(() => { const f = SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === 'HUB-GRANITE' && t.type === 'tanker'); return f[f.length - 1]; });
    const newRow = await page.locator('li.sc-truck[data-truck="' + added.id + '"]').count();
    check(t1 === t0 + 1 && r1 === r0 + 1 && newRow === 1 && added.status === 'available', 'Fleet + adds a tanker and its row', { t0, t1, r0, r1, added: added.id });
    await commit(page, '[data-fk="fl-HUB-GRANITE-cargo"]', 3);
    const c1 = await count('HUB-GRANITE', 'cargo');
    check(c1 === 3, 'typing a count sets cargo trucks to 3', { c0, c1 });
    await page.click('[data-fk="fl-HUB-GRANITE-cargo-minus"]'); await settle(page);
    await page.click('[data-fk="fl-HUB-GRANITE-cargo-minus"]'); await settle(page);
    await page.click('[data-fk="fl-HUB-GRANITE-tanker-minus"]'); await settle(page);
    const back = await page.evaluate(() => SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === 'HUB-GRANITE').map((t) => t.id).sort());
    check(back.join() === 'Alpha-1,Alpha-2' && (await rows('HUB-GRANITE')) === r0, 'Fleet - removes the added trucks, keeps the ones on the plan', back);
    const lbl = await page.locator('.sc-hub[data-hub="HUB-GRANITE"] .sc-counter-label').allTextContents();
    check(lbl.join('|') === 'Tankers|Cargo', 'hub counters are labelled', lbl);
    const chip = await page.locator('li.sc-truck[data-truck="Alpha-1"] .truck-chip').count();
    const txt = await page.locator('li.sc-truck[data-truck="Alpha-1"]').innerText();
    check(chip === 1 && /Fuel tanker/.test(txt) && /2,500 gal/.test(txt) && /Freq/.test(txt), 'truck row shows callsign chip, type, capacity and frequency', txt);
    await steppersOk(page, 'fleet');
    await overflowOk(page, vp.width, 'fleet');
    if (night) await nightOk(page, 'fleet');
    await shot('fleet');
  });

  // ---- mark out / available, re-plan banner ------------------------------------------------------
  let outTruck = null;
  await step('mark out', async () => {
    await showScenario(page, 'fleet');
    outTruck = await page.evaluate(() => { const p = SRO.ui.scenario.activePlan(SRO.app.store.getState()); const r = p && p.routes.find((x) => x.stops.length); return r ? r.truckId : null; });
    check(!!outTruck, 'an approved plan with a used truck is active', outTruck);
    const row = 'li.sc-truck[data-truck="' + outTruck + '"]';
    await page.locator(row + ' [data-act="out"]').scrollIntoViewIfNeeded();
    await page.click(row + ' [data-act="out"]');
    await page.waitForSelector('[data-reason="maint"]', { state: 'visible' });
    await settle(page);
    const warn = await page.locator('.modal .notice-warn').count();
    check(warn === 1, 'mark-out dialog warns that the truck is on the approved plan');
    await page.click('[data-reason="maint"]');
    await page.selectOption('#sc-out-back', '4');
    if (theme === 'light') await shot('markout-dialog');
    await page.click('[data-action="mark-out"]');
    await settle(page, 50);
    const t = await page.evaluate((id) => { const s = SRO.app.store.getState(); const t = s.scenario.fleet.find((x) => x.id === id); return { status: t.status, reason: t.outReason, until: t.outUntil, now: s.clock.simMin }; }, outTruck);
    check(t.status === 'out' && t.reason === 'Maintenance' && t.until === t.now + 240, 'Mark out stores status, reason and expected return', t);
    const rowState = await page.locator(row).getAttribute('data-status');
    const rowText = await page.locator(row).innerText();
    check(rowState === 'out' && /Out/.test(rowText) && /Maintenance/.test(rowText) && /back about \d{6}H [A-Z]{3} \d{2}/.test(rowText), 'row shows Out, the reason and a DTG', rowText);
    // banner
    await page.evaluate(() => document.querySelector('.sc').scrollIntoView());
    const bn = await page.evaluate((id) => {
      const b = document.querySelector('.sc-replan');
      if (!b) return null;
      const btn = b.querySelector('.sc-replan-btn');
      return { text: b.innerText, btn: !!btn && !btn.disabled, badge: (document.querySelector('[data-tab="scenario"] .badge, [data-view="scenario"] .badge') || {}).textContent || null, hasTruck: b.innerText.indexOf(id) >= 0 };
    }, outTruck);
    check(bn && bn.btn && bn.hasTruck && /Kept:/.test(bn.text) && /Moves:/.test(bn.text), 'Re-plan banner names the truck, explains what is kept and what moves, Re-plan now enabled', bn);
    await shot('banner');
    await page.click('.sc-replan-fold');
    await settle(page);
    const folded = await page.evaluate(() => { const b = document.querySelector('.sc-replan'); return { folded: b.classList.contains('is-folded'), explain: !!b.querySelector('.sc-replan-explain'), btn: !!b.querySelector('.sc-replan-btn') }; });
    check(folded.folded && !folded.explain && folded.btn, 'banner folds to title and Re-plan now', folded);
    await page.click('.sc-replan-fold');
    await settle(page);
    check(!(await page.locator('.sc-replan.is-folded').count()), 'banner unfolds again');
    // back in service
    await page.locator(row + ' [data-act="available"]').scrollIntoViewIfNeeded();
    await page.click(row + ' [data-act="available"]');
    await settle(page);
    const t2 = await page.evaluate((id) => SRO.app.store.getState().scenario.fleet.find((x) => x.id === id).status, outTruck);
    check(t2 !== 'out' && (await page.locator(row).getAttribute('data-status')) !== 'out', 'Mark available puts the truck back in service', t2);
  });

  // ---- Re-plan now (runs the solver; dark theme only) ---------------------------------------------
  let replanId = null;
  if (runSolver) {
    await step('re-plan', async () => {
      await page.evaluate((id) => {
        const S = SRO.app.store;
        S.dispatch({ type: 'settings/update', changes: { methodParams: { tabu: { timeCapSec: 5 } } } });
        S.dispatch({ type: 'truck/markOut', truckId: id, reason: 'Flat tire' });
      }, outTruck);
      await showScenario(page, 'fleet');
      const parent = await page.evaluate(() => SRO.ui.scenario.activePlan(SRO.app.store.getState()).id);
      await page.click('.sc-replan-btn');
      await settle(page);
      const running = await page.locator('.sc-replan .progress').count();
      check(running === 1, 'Re-plan now shows progress while the solver runs');
      await page.waitForFunction((pid) => SRO.app.store.getState().plans.some((p) => p.parentPlanId === pid), parent, { timeout: 90000 });
      await settle(page, 100);
      const rt = (await toastTexts(page)).find((t) => /Re-plan ready/.test(t.text));
      check(rt && rt.text === 'Re-plan ready. Review the changes, then approve.' && !rt.action, 'the re-plan toast says what to do next and has no button (the Plan tab is already open)', rt);
      const r = await page.evaluate(({ pid, id }) => {
        const s = SRO.app.store.getState();
        const p = s.plans.filter((x) => x.parentPlanId === pid).pop();
        return { id: p.id, approved: p.approved, tab: s.ui.plannerTab, usesOut: p.routes.some((rt) => rt.truckId === id && rt.stops.some((st) => st.arrive > s.clock.simMin)) };
      }, { pid: parent, id: outTruck });
      replanId = r.id;
      check(!r.approved && !r.usesOut && r.tab === 'plan', 'Re-plan stores an unapproved child plan without the out truck and opens the Plan tab', r);
      const diff = await page.evaluate(({ a, b }) => {
        const s = SRO.app.store.getState(); const pa = s.plans.find((p) => p.id === a), pb = s.plans.find((p) => p.id === b);
        const d = SRO.ui.outputs.diffPlans(s, pa, pb);
        return { kinds: d.map((x) => x.kind), ids: d.map((x) => x.id).sort(), engine: Array.isArray(pb.changes) ? pb.changes.map((c) => c.requestId).sort() : null };
      }, { a: parent, b: replanId });
      check(diff.kinds.length > 0 && diff.kinds.every((k) => ['moved', 'time', 'added', 'added-from-deferred', 'deferred', 'partial', 'restored', 'removed'].indexOf(k) >= 0), 'compare finds the stops the re-plan moved', diff.kinds);
      check(!diff.engine || diff.ids.join() === diff.engine.join(), 'compare lists the same requests as the engine change list', diff);
      await showScenario(page, 'fleet');
      const btns = await page.evaluate(() => {
        const b = document.querySelector('.sc-replan');
        const rv = b && b.querySelector('.sc-review-btn'), rp = b && b.querySelector('.sc-replan-btn');
        return { reasons: b && b.getAttribute('data-reasons'), review: rv ? rv.textContent.trim() : null, reviewPrimary: !!rv && rv.classList.contains('btn-primary'), again: rp ? rp.textContent.trim() : null, againPrimary: !!rp && rp.classList.contains('btn-primary') };
      });
      check(btns.review === 'Review re-plan' && btns.reviewPrimary && btns.again === 'Re-plan again' && !btns.againPrimary, 'banner offers Review re-plan as the main action for the stored draft, Re-plan again second', btns);
      // the drop point counter says which plan it counts, and adds the re-plan under review when that
      // uses a different number
      await showScenario(page, 'rally');
      const rc = await page.evaluate(({ a, b }) => {
        const s = SRO.app.store.getState(), n = (p) => (p.windowStats && typeof p.windowStats.rallyPoints === 'number' ? p.windowStats.rallyPoints : (p.rallyPoints || []).length);
        return { text: (document.querySelector('[data-testid="rally-counts"]') || {}).textContent || '', approved: n(s.plans.find((p) => p.id === a)), draft: n(s.plans.find((p) => p.id === b)), max: s.scenario.settings.maxRallyPoints };
      }, { a: parent, b: replanId });
      check(rc.text.indexOf(rc.approved + ' of ' + rc.max + ' used this window (approved plan)') >= 0, 'the drop point counter names the approved plan it counts', rc);
      check(rc.draft === rc.approved ? !/in draft/.test(rc.text) : rc.text.indexOf('; ' + rc.draft + ' in draft ' + replanId) >= 0, 'the drop point counter adds the re-plan under review when its count differs', rc);
      await page.evaluate((id) => SRO.app.store.dispatch({ type: 'truck/markAvailable', truckId: id }), outTruck);
    });
  }

  // ---- zones ----------------------------------------------------------------------------------------
  await step('zones', async () => {
    await showScenario(page, 'zones');
    const n0 = await zoneCount(page);
    // closed zone: tap centre, tap edge (desktop: mouse; phone: touch)
    await page.click('.sc-add-closed');
    await waitDrawbar(page);
    const g1 = await mapGeom(page, 60);
    if (isPhone) {
      const tab = await page.evaluate(() => SRO.app.store.getState().ui.plannerTab);
      check(tab === 'map', 'phone: drawing switches to the Map tab', tab);
      await page.touchscreen.tap(g1.cx, g1.cy);
      await page.waitForTimeout(80);
      await page.touchscreen.tap(g1.cx + 60, g1.cy);
    } else {
      await page.mouse.click(g1.cx, g1.cy);
      await page.mouse.move(g1.cx + 30, g1.cy);
      await page.mouse.click(g1.cx + 60, g1.cy);
    }
    await waitZones(page, n0 + 1);
    const z1 = await page.evaluate(() => { const z = SRO.app.store.getState().scenario.zones; return z[z.length - 1]; });
    check(z1 && z1.kind === 'closed' && g1.mi && Math.abs(z1.radiusMi - g1.mi) < Math.max(0.6, g1.mi * 0.1) && /^Closed road near /.test(z1.label),
      'closed zone drawn with ' + (isPhone ? 'touch taps' : 'mouse clicks') + ' (radius matches the drag)', { z1, expect: g1.mi });
    // risk zone, High: drag (desktop: touch drag; phone: mouse drag)
    await showScenario(page, 'zones');
    await page.click('.sc-rating-seg [data-rating="High"]');
    await settle(page);
    await page.click('.sc-add-risk');
    await waitDrawbar(page);
    const g2 = await mapGeom(page, 90);
    if (isPhone) await mouseDrag(page, g2.cx, g2.cy, 90);
    else await touchDrag(ctx, page, g2.cx, g2.cy, 90);
    await waitZones(page, n0 + 2);
    const z2 = await page.evaluate(() => { const z = SRO.app.store.getState().scenario.zones; return z[z.length - 1]; });
    check(z2 && z2.kind === 'risk' && z2.rating === 'High' && g2.mi && Math.abs(z2.radiusMi - g2.mi) < Math.max(0.6, g2.mi * 0.12) && /^High risk near /.test(z2.label),
      'High risk zone drawn with a ' + (isPhone ? 'mouse' : 'touch') + ' drag', { z2, expect: g2.mi });
    const tab = await page.evaluate(() => SRO.app.store.getState().ui.plannerTab);
    check(tab === 'scenario' && (await page.locator('li.sc-zone[data-zone="' + z1.id + '"]').count()) === 1 && (await page.locator('li.sc-zone[data-zone="' + z2.id + '"]').count()) === 1,
      'back on Scenario with both zones listed', tab);
    if (isPhone) { await page.evaluate(() => SRO.ui.plannerTabs.show('map')); await settle(page, 100); }
    const onMap = await page.evaluate(() => document.querySelectorAll('.pm .sro-pane-zones path, .pm path.sro-zone-closed, .pm path.sro-zone-risk').length);
    if (isPhone) await shot('map-zones');
    check(onMap >= 2, 'zones drawn on the planner map', onMap);
    // edit radius and rating
    await showScenario(page, 'zones');
    await commit(page, 'li.sc-zone[data-zone="' + z2.id + '"] .sc-zone-radius', 4.5);
    await page.selectOption('li.sc-zone[data-zone="' + z2.id + '"] .sc-zone-rating', 'Low');
    await settle(page);
    const z2b = await page.evaluate((id) => SRO.app.store.getState().scenario.zones.find((z) => z.id === id), z2.id);
    check(z2b.radiusMi === 4.5 && z2b.rating === 'Low' && (await page.locator('li.sc-zone[data-zone="' + z2.id + '"]').getAttribute('data-rating')) === 'Low', 'radius and rating edits are saved', z2b);
    await commit(page, 'li.sc-zone[data-zone="' + z2.id + '"] .sc-zone-radius', 0);
    const z2c = await page.evaluate((id) => SRO.app.store.getState().scenario.zones.find((z) => z.id === id).radiusMi, z2.id);
    const shown = await page.locator('li.sc-zone[data-zone="' + z2.id + '"] .sc-zone-radius').inputValue();
    check(z2c === 4.5 && shown === '4.5', 'an out-of-range radius is refused and the field reverts', { z2c, shown });
    const mg = await page.locator('li.sc-zone[data-zone="' + z1.id + '"]').innerText();
    check(/Center \d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}/.test(mg), 'zone centre shown as MGRS', mg);
    await overflowOk(page, vp.width, 'zones');
    if (night) await nightOk(page, 'zones');
    await shot('zones');
    // remove
    await page.click('li.sc-zone[data-zone="' + z1.id + '"] [data-act="remove-zone"]');
    await settle(page);
    const left = await page.evaluate((id) => SRO.app.store.getState().scenario.zones.some((z) => z.id === id), z1.id);
    check(!left && !(await page.locator('li.sc-zone[data-zone="' + z1.id + '"]').count()), 'remove deletes the zone', left);
  });

  // ---- drop points --------------------------------------------------------------------------------
  await step('rally', async () => {
    await showScenario(page, 'rally');
    const ids = await page.locator('li.sc-rally').evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute('data-grid')));
    const rally = () => page.evaluate(() => SRO.app.store.getState().scenario.rally);
    const [g1, g2] = ids;
    await page.click('li.sc-rally[data-grid="' + g1 + '"] [data-act="pin"]'); await settle(page);
    let r = await rally();
    check(r.pinned.includes(g1) && (await page.locator('li.sc-rally[data-grid="' + g1 + '"]').getAttribute('data-state')) === 'pinned', 'Pin pins a drop point', r);
    await page.click('li.sc-rally[data-grid="' + g2 + '"] [data-act="ban"]'); await settle(page);
    r = await rally();
    check(r.banned.includes(g2) && (await page.locator('li.sc-rally[data-grid="' + g2 + '"]').getAttribute('data-state')) === 'banned', 'Ban bans a drop point', r);
    await page.click('li.sc-rally[data-grid="' + g1 + '"] [data-act="ban"]'); await settle(page);
    r = await rally();
    check(!r.pinned.includes(g1) && r.banned.includes(g1), 'banning a pinned point unpins it', r);
    await clearToasts(page);
    await page.click('li.sc-rally[data-grid="' + g1 + '"] [data-act="clear"]'); await settle(page);
    r = await rally();
    check(!r.pinned.includes(g1) && !r.banned.includes(g1), 'Clear returns it to a candidate', r);
    const ct = (await toastTexts(page)).map((t) => t.text);
    check(ct.length === 1 && / unbanned: the optimizer may use it or not\.$/.test(ct[0]), 'Clear says the point is unbanned and the optimizer may use it or not', ct);
    // the dialog the map opens on a rally point click
    await page.evaluate((g) => SRO.ui.scenario.rallyDialog(g), g2);
    await page.waitForSelector('[data-action="rally-pin"]', { state: 'visible' });
    await settle(page);
    if (theme === 'dark') await shot('rally-dialog');
    await page.click('[data-action="rally-pin"]'); await settle(page);
    r = await rally();
    check(r.pinned.includes(g2) && !r.banned.includes(g2), 'map rally dialog pins a banned point', r);
    // filter chip
    const chip = page.locator('.sc-rally-filter .chip', { hasText: 'Pinned' }).first();
    await chip.click(); await settle(page);
    const shownIds = await page.locator('li.sc-rally').evaluateAll((els) => els.map((e) => e.getAttribute('data-grid')));
    check(shownIds.length === 1 && shownIds[0] === g2, 'Pinned filter lists only pinned points', shownIds);
    await page.locator('.sc-rally-filter .chip', { hasText: 'All' }).first().click(); await settle(page);
    // max rally points
    await page.click('[data-fk="rally-max-plus"]'); await settle(page);
    const mx = await page.evaluate(() => SRO.app.store.getState().scenario.settings.maxRallyPoints);
    const mark = await page.locator('.sc-rally-head .sc-changed').innerText().catch(() => '');
    check(mx === 9 && /default: 8/.test(mark), 'max drop points + saves 9 and shows the changed mark', { mx, mark });
    await overflowOk(page, vp.width, 'rally');
    if (night) await nightOk(page, 'rally');
    await shot('rally');
  });

  // ---- settings (visible part) --------------------------------------------------------------------
  await step('settings', async () => {
    await showScenario(page, 'settings');
    await slide(page, 'input.range[data-weight="fuel"]', 7);
    await commit(page, '[data-fk="timeLimit"]', 120);
    await page.selectOption('#sc-method', 'sa'); await settle(page);
    const s1 = await page.evaluate(() => { const s = SRO.app.store.getState().scenario.settings; return { fuel: s.weights.fuel, t: s.timeLimitSec, m: s.method }; });
    check(s1.fuel === 7 && s1.t === 120 && s1.m === 'sa', 'weight slider, time limit and method are saved', s1);
    await page.selectOption('#sc-method', 'tabu'); await settle(page);
    const mh = await page.evaluate(() => document.querySelector('#sc-method').parentNode.querySelector('.field-help').textContent);
    check(!/\d+\s*-\s*\d+\s*(s|min)\b/.test(mh) && /Plan tab/.test(mh), 'method help gives no fixed run times and points to the Plan tab estimate', mh);
    const wl = await page.locator('.sc-weight').allInnerTexts();
    check(wl.length === 4 && /Fuel/.test(wl.join(' ')) && /Simplicity/.test(wl.join(' ')), 'four cost weight sliders with explanations', wl.length);
    // trucks-per-hub shortcut
    const j0 = await page.evaluate(() => SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === 'HUB-JADE' && t.type === 'cargo').length);
    await page.click('[data-fk="set-HUB-JADE-cargo-plus"]'); await settle(page);
    const j1 = await page.evaluate(() => SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === 'HUB-JADE' && t.type === 'cargo').length);
    await page.click('[data-fk="set-HUB-JADE-cargo-minus"]'); await settle(page);
    const j2 = await page.evaluate(() => SRO.app.store.getState().scenario.fleet.filter((t) => t.hubId === 'HUB-JADE' && t.type === 'cargo').length);
    check(j1 === j0 + 1 && j2 === j0, 'Settings trucks-per-hub shortcut changes the fleet', { j0, j1, j2 });
    await steppersOk(page, 'settings');
    await overflowOk(page, vp.width, 'settings');
    await shot('settings');
    // advanced (collapsed by default)
    const closed = await page.evaluate(() => !document.querySelector('details.sc-adv').open);
    const summary = await page.locator('.sc-adv-summary').innerText();
    check(closed && /Advanced/.test(summary), 'Advanced settings are collapsed and labelled', summary);
    await page.click('.sc-adv-summary'); await settle(page);
    await commit(page, '[data-fk="convoy"]', 1.7);
    await commit(page, '[data-fk="mpg"]', 2.5);
    await commit(page, '[data-fk="mob-mounted-radiusMi"]', 40);
    await commit(page, '[data-fk="risk-High"]', 7);
    const du = await page.locator('.sc-du-input').first().getAttribute('data-fk');
    await commit(page, '.sc-du-input', 123);
    const s2 = await page.evaluate((k) => { const s = SRO.app.store.getState().scenario.settings; return { convoy: s.convoyFactor, mpg: s.mpg, mounted: s.mobility.mounted.radiusMi, high: s.riskRatings.High, du: s.dailyUse && s.dailyUse[k] }; }, du.slice(3));
    check(s2.convoy === 1.7 && s2.mpg === 2.5 && s2.mounted === 40 && s2.high === 7 && s2.du === 123, 'advanced travel, mobility, risk and daily-use values are saved', s2);
    const duw = await page.evaluate(() => { const w = document.querySelector('.sc-du-wrap'); return { rows: w.querySelectorAll('.sc-du-input').length, sh: w.scrollHeight, ch: w.clientHeight, max: getComputedStyle(w).maxHeight }; });
    check(duw.rows > 10 && duw.max === 'none' && duw.sh <= duw.ch + 1, 'daily-use table is not a scroll box inside the page scroll', duw);
    // re-plan ETA-change cost and the sample seed (spec: fixed seed, changeable)
    const etaHelp = await page.evaluate(() => (document.querySelector('#sc-f-etaSlip-help') || {}).textContent || '');
    check(/later than the time the approved plan gave/.test(etaHelp) && /0 lets a re-plan move them freely/.test(etaHelp), 'the ETA-change cost has plain-language help', etaHelp);
    await commit(page, '[data-fk="etaSlip"]', 3);
    await commit(page, '[data-fk="sampleSeed"]', 4242);
    const s3 = await page.evaluate(() => { const s = SRO.app.store.getState().scenario.settings; return { eta: s.etaSlipPerMin, seed: s.sampleSeed, mark: (document.querySelector('[data-field="etaSlip"] .sc-changed') || {}).textContent || '' }; });
    check(s3.eta === 3 && s3.seed === 4242 && /default: 1/.test(s3.mark), 'ETA-change cost and sample seed are saved, with the changed mark', s3);
    await commit(page, '[data-fk="etaSlip"]', -2);
    const s4 = await page.evaluate(() => ({ inv: document.querySelector('[data-fk="etaSlip"]').getAttribute('aria-invalid'), eta: SRO.app.store.getState().scenario.settings.etaSlipPerMin }));
    check(s4.inv === 'true' && s4.eta === 3, 'a negative ETA-change cost is flagged and not saved', s4);
    await commit(page, '[data-fk="etaSlip"]', 1);
    await commit(page, '[data-fk="sampleSeed"]', 20261005);
    await commit(page, '[data-fk="convoy"]', 9);
    const bad = await page.evaluate(() => { const i = document.querySelector('[data-fk="convoy"]'); return { inv: i.getAttribute('aria-invalid'), v: SRO.app.store.getState().scenario.settings.convoyFactor }; });
    check(bad.inv === 'true' && bad.v === 1.7, 'out-of-range convoy factor is flagged and not saved', bad);
    await commit(page, '[data-fk="convoy"]', 1.7);
  });

  // ---- solver tuning --------------------------------------------------------------------------------
  await step('tuning', async () => {
    await showScenario(page, 'settings');
    await page.evaluate(() => { const d = document.querySelector('details.sc-adv'); if (!d.open) d.querySelector('summary').click(); });
    await settle(page);
    const methods = await page.evaluate(() => SRO.solver.METHOD_KEYS.slice());
    for (const m of methods) {
      await page.click('.sc-tune-seg [data-method="' + m + '"]'); await settle(page);
      const k = await page.evaluate((m) => ({
        rows: Array.from(document.querySelectorAll('.sc-tune-panel[data-method="' + m + '"] .sc-knob')).map((e) => e.getAttribute('data-knob') + ':' + e.getAttribute('data-type')),
        spec: SRO.solver.PARAMS[m].map((e) => e.key + ':' + e.type)
      }), m);
      check(k.rows.join() === k.spec.join(), m + ': one knob row per PARAMS entry, in order', k);
    }
    const P = (m, key) => '.sc-tune-panel[data-method="' + m + '"] .sc-knob[data-knob="' + key + '"]';
    const stored = (m) => page.evaluate((m) => (SRO.app.store.getState().scenario.settings.methodParams || {})[m] || {}, m);
    // tabu: int via number box, clamp, log slider, bool switch
    await page.click('.sc-tune-seg [data-method="tabu"]'); await settle(page);
    await commit(page, P('tabu', 'tenure') + ' input.sc-knob-num', 20);
    let tp = await stored('tabu');
    const row = await page.evaluate((sel) => { const r = document.querySelector(sel); return { changed: r.getAttribute('data-changed'), dot: !!r.querySelector('.sc-dot'), mark: (r.querySelector('.sc-changed') || {}).textContent || '' }; }, P('tabu', 'tenure'));
    check(tp.tenure === 20 && row.changed === 'true' && row.dot && /default: 12/.test(row.mark), 'int knob (tenure): saved, changed dot and "default: 12"', { tp, row });
    await clearToasts(page);
    await commit(page, P('tabu', 'tenure') + ' input.sc-knob-num', 999);
    tp = await stored('tabu');
    const kt = (await toastTexts(page)).filter((t) => /kept within/.test(t.text));
    check(kt.length === 1, 'one "kept within" toast for one clamped value (fill and change fire twice)', kt);
    const shownT = await page.locator(P('tabu', 'tenure') + ' input.sc-knob-num').inputValue();
    check(tp.tenure === 200 && shownT === '200', 'int knob is clamped to its maximum (200)', { tp, shownT });
    await slide(page, P('tabu', 'iterations') + ' input.sc-knob-range', 800);
    tp = await stored('tabu');
    check(tp.iterations > 4000 && tp.iterations <= 100000 && Number.isInteger(tp.iterations), 'log slider (iterations) saves an integer in range', tp.iterations);
    await page.click(P('tabu', 'aspiration') + ' input.switch'); await settle(page);
    tp = await stored('tabu');
    check(tp.aspiration === false && (await page.locator(P('tabu', 'aspiration')).getAttribute('data-changed')) === 'true', 'bool knob (aspiration) switch saves false and shows changed', tp);
    const segDot = await page.locator('.sc-tune-seg [data-method="tabu"] .sc-dot').count();
    check(segDot === 1, 'method tab shows a dot when its settings differ from defaults');
    await page.waitForFunction(() => { const e = document.querySelector('.sc-estimate'); return e && ['ok', 'none'].includes(e.getAttribute('data-state')); }, null, { timeout: 15000 }).catch(() => null);
    const est = await page.evaluate(() => { const e = document.querySelector('.sc-estimate'); return { state: e.getAttribute('data-state'), text: e.textContent }; });
    check(['ok', 'none'].includes(est.state) && est.text.length > 10 && !/appears here/.test(est.text), 'run-time estimate refreshes after a change', est);
    if (theme !== 'light') { await page.locator('.sc-tune-seg').scrollIntoViewIfNeeded(); await shot('tuning'); }
    // annealing: float via number box and slider
    await page.click('.sc-tune-seg [data-method="sa"]'); await settle(page);
    await commit(page, P('sa', 'coolingRate') + ' input.sc-knob-num', 0.99);
    await slide(page, P('sa', 'autoAcceptRate') + ' input.sc-knob-range', 0.3);
    let sp = await stored('sa');
    check(sp.coolingRate === 0.99 && Math.abs(sp.autoAcceptRate - 0.3) < 1e-9, 'float knobs (coolingRate box, autoAcceptRate slider) are saved', sp);
    await commit(page, P('sa', 'coolingRate') + ' input.sc-knob-num', 0.1);
    sp = await stored('sa');
    check(sp.coolingRate === 0.8, 'float knob is clamped to its minimum (0.8)', sp.coolingRate);
    await commit(page, P('sa', 'coolingRate') + ' input.sc-knob-num', 0.99);
    // ant colony: float + bool; MIP: float + bool
    await page.click('.sc-tune-seg [data-method="aco"]'); await settle(page);
    await commit(page, P('aco', 'alpha') + ' input.sc-knob-num', 2.5);
    await page.click(P('aco', 'localSearch') + ' input.switch'); await settle(page);
    const ap = await stored('aco');
    check(ap.alpha === 2.5 && ap.localSearch === false, 'ant colony float and bool knobs are saved', ap);
    await page.click('.sc-tune-seg [data-method="mip"]'); await settle(page);
    await commit(page, P('mip', 'mipGap') + ' input.sc-knob-num', 0.05);
    await page.click(P('mip', 'warmStart') + ' input.switch'); await settle(page);
    const mp = await stored('mip');
    check(mp.mipGap === 0.05 && mp.warmStart === false, 'MIP float and bool knobs are saved', mp);
    // reset one method
    await page.click('.sc-tune-panel[data-method="mip"] .sc-tune-reset'); await settle(page);
    const mr = await page.evaluate(() => {
      const s = SRO.app.store.getState().scenario.settings;
      const cur = SRO.solver.clampParams('mip', (s.methodParams || {}).mip, s), d = SRO.solver.defaultParams('mip', s);
      return { same: JSON.stringify(cur) === JSON.stringify(d), changedRows: document.querySelectorAll('.sc-tune-panel[data-method="mip"] .sc-knob[data-changed="true"]').length, dot: document.querySelectorAll('.sc-tune-seg [data-method="mip"] .sc-dot').length };
    });
    check(mr.same && mr.changedRows === 0 && mr.dot === 0, 'Reset to defaults clears MIP settings and the dots', mr);
    if (night) await nightOk(page, 'tuning');
  });

  // ---- time-of-day table ----------------------------------------------------------------------------
  await step('periods', async () => {
    await showScenario(page, 'settings');
    await page.evaluate(() => { const d = document.querySelector('details.sc-adv'); if (!d.open) d.querySelector('summary').click(); });
    await settle(page);
    const cell = (i, k) => '.sc-pinput[data-period="' + i + '"][data-key="' + k + '"]';
    const status = () => page.evaluate(() => ({ text: document.querySelector('.sc-pstatus').innerText, save: document.querySelector('[data-fk="periods-save"]').disabled, invalid: document.querySelector('.sc-ptable').classList.contains('is-invalid') }));
    const names = await page.evaluate(() => SRO.app.store.getState().scenario.settings.periods.map((p) => p.name + ' ' + p.start + '-' + p.end));
    await page.locator(cell(0, 'end')).scrollIntoViewIfNeeded();
    await page.fill(cell(0, 'end'), '1700'); await settle(page);
    let st = await status();
    check(/No period covers 1700-1800/.test(st.text) && st.save && st.invalid, 'a gap is reported and Save is disabled', { st, names });
    await shot('periods-error');
    await page.fill(cell(0, 'end'), '1800');
    await page.fill(cell(1, 'start'), '1730'); await settle(page);
    st = await status();
    check(/overlap 1730-1800/.test(st.text) && st.save, 'an overlap is reported', st);
    await page.fill(cell(1, 'start'), '1800');
    await page.fill(cell(0, 'start'), '2500'); await settle(page);
    st = await status();
    check(st.save && st.invalid && !/Covers all 24 hours/.test(st.text), 'an impossible time is rejected', st);
    await page.fill(cell(0, 'start'), '0700'); await settle(page);
    st = await status();
    check(/Covers all 24 hours/.test(st.text) && st.save && !st.invalid, 'back to valid; Save stays off with nothing changed', st);
    await page.fill(cell(0, 'end'), '1730');
    await page.fill(cell(1, 'start'), '1730'); await settle(page);
    st = await status();
    check(!st.save, 'a valid change enables Save', st);
    await page.click('[data-fk="periods-save"]'); await settle(page);
    const saved = await page.evaluate(() => SRO.app.store.getState().scenario.settings.periods.slice(0, 2).map((p) => p.start + '-' + p.end));
    check(saved[0] === '0700-1730' && saved[1] === '1730-1930', 'Save table stores the edited periods', saved);
    const unit = await page.evaluate(() => {
      const v = SRO.ui.validatePeriods;
      const ok = v([{ name: 'A', start: '0000', end: '1200', speed: 1, risk: 1 }, { name: 'B', start: '1200', end: '2400', speed: 1, risk: 1 }]);
      const wrap = v([{ name: 'D', start: '0600', end: '1800', speed: 1, risk: 1 }, { name: 'N', start: '1800', end: '0600', speed: 1, risk: 1 }]);
      const gap = v([{ name: 'D', start: '0600', end: '1700', speed: 1, risk: 1 }, { name: 'N', start: '1800', end: '0600', speed: 1, risk: 1 }]);
      const speed = v([{ name: 'D', start: '0000', end: '2400', speed: 0, risk: 1 }]);
      return { ok: ok.ok, wrap: wrap.ok, gap: gap.ok, speed: speed.ok };
    });
    check(unit.ok && unit.wrap && !unit.gap && !unit.speed, 'validatePeriods: split day, wrap past midnight, gap and zero speed', unit);
    if (night) await nightOk(page, 'periods');
  });

  // ---- Tabu reset (persistence across reload is checked in persistenceCheck) -----------------------
  await step('tabu reset', async () => {
    await showScenario(page, 'settings');
    await page.evaluate(() => { const d = document.querySelector('details.sc-adv'); if (!d.open) d.querySelector('summary').click(); });
    await settle(page);
    await page.click('.sc-tune-seg [data-method="tabu"]'); await settle(page);
    await page.click('.sc-tune-panel[data-method="tabu"] .sc-tune-reset'); await settle(page);
    const tr = await page.evaluate(() => { const s = SRO.app.store.getState().scenario.settings; return { rows: document.querySelectorAll('.sc-tune-panel[data-method="tabu"] .sc-knob[data-changed="true"]').length, p: SRO.solver.clampParams('tabu', (s.methodParams || {}).tabu, s), d: SRO.solver.defaultParams('tabu', s) }; });
    check(tr.rows === 0 && JSON.stringify(tr.p) === JSON.stringify(tr.d), 'Tabu Reset to defaults clears every Tabu knob', tr);
  });

  // ---- outputs: movement + CSV --------------------------------------------------------------------
  let planInfo = null;
  await step('movement', async () => {
    await showOutputs(page, 'movement');
    planInfo = await page.evaluate(() => {
      const st = SRO.app.store.getState();
      const plan = st.plans.filter((p) => p.approved && !p.superseded).pop();
      const F = SRO.core.format;
      const used = plan.routes.filter((r) => r.stops.length);
      const first = used.slice().sort((a, b) => a.depart - b.depart || a.truckId.localeCompare(b.truckId))[0];
      const s1 = first.stops[0];
      let csvRows = 0;
      const real = (s) => (s.deliveries || []).filter((d) => !(d.qty <= 0));
      used.forEach((r) => { csvRows += 2; r.stops.forEach((s) => { csvRows += Math.max(1, real(s).length); }); });
      const d1 = (s1.deliveries || [])[0];
      const req = d1 ? st.requests.find((r) => r.id === d1.requestId) : null;
      return { id: plan.id, windowId: plan.windowId, used: used.length, first: first.truckId, stops: first.stops.length, mgrs: F.mgrs(s1.lat, s1.lon), arrive: F.dtg(s1.arrive), csvRows, d1: d1 ? { requestId: d1.requestId, qty: d1.qty, platoon: req && req.unitName } : null, csv: SRO.ui.outputs.movementCsv(st, plan) };
    });
    const sel = await page.locator('.op-plan-select').first().inputValue();
    check(sel === planInfo.id, 'Movement shows the approved plan by default', { sel, id: planInfo.id });
    const trucks = await page.locator('section.op-truck').count();
    check(trucks === planInfo.used, 'one movement table per truck with stops', { trucks, used: planInfo.used });
    const t1 = 'section.op-truck[data-truck="' + planInfo.first + '"]';
    const rows = await page.locator(t1 + ' table.op-move tbody tr').count();
    const c = await page.evaluate((t1) => { const tr = document.querySelectorAll(t1 + ' table.op-move tbody tr')[1]; return { mgrs: tr.querySelector('.op-c-mgrs').textContent.trim(), arr: tr.querySelector('.op-c-arr').textContent.trim().replace(/^Arr\s*/, ''), dl: tr.querySelector('.op-c-dl').textContent }; }, t1);
    check(rows === planInfo.stops + 2 && c.mgrs === planInfo.mgrs && c.arr === planInfo.arrive, 'stop rows (hub start, stops, return) with MGRS and arrive DTG', { rows, c, planInfo: { stops: planInfo.stops, mgrs: planInfo.mgrs, arrive: planInfo.arrive } });
    if (planInfo.d1) check(c.dl.indexOf(planInfo.d1.platoon) >= 0, 'deliveries cell names the platoon', { dl: c.dl, platoon: planInfo.d1.platoon });
    const head = await page.locator('.op-head').first().innerText();
    check(/mi/.test(head) && /gal/.test(head) && /\d{6}H [A-Z]{3} \d{2}/.test(head), 'plan summary uses miles, gallons and DTG', head);
    // every truck table against the plan: times, grids, one entry per platoon at a stop, every load
    const mv = await page.evaluate(() => {
      const st = SRO.app.store.getState(), F = SRO.core.format, H = SRO.data.catalogHelpers;
      const plan = st.plans.filter((p) => p.approved && !p.superseded).pop();
      const issues = [];
      let lines = 0;
      plan.routes.filter((r) => r.stops.length).forEach((r) => {
        const sec = document.querySelector('section.op-truck[data-truck="' + r.truckId + '"]');
        if (!sec) { issues.push('no table for ' + r.truckId); return; }
        const line = sec.querySelector('.op-truck-head').innerText;
        [F.dtg(r.depart), F.dtg(r.returnAt), F.miles(r.miles), F.gallons(r.gallons)].forEach((t) => { if (line.indexOf(t) < 0) issues.push(r.truckId + ' head lacks ' + t); });
        const rows = sec.querySelectorAll('tbody tr');
        if (rows[rows.length - 1].getAttribute('data-kind') !== 'return') issues.push(r.truckId + ' last row is not the return');
        r.stops.forEach((s, i) => {
          const tr = rows[i + 1];
          if (tr.querySelector('.op-c-mgrs').textContent !== F.mgrs(s.lat, s.lon) || tr.querySelector('.op-c-arr').textContent.indexOf(F.dtg(s.arrive)) < 0 || tr.querySelector('.op-c-dep').textContent.indexOf(F.dtg(s.depart)) < 0) issues.push(r.truckId + ' stop ' + (i + 1) + ' grid or times');
          const real = (s.deliveries || []).filter((d) => !(d.qty <= 0));
          const ids = real.map((d) => d.requestId).filter((x, k, a) => a.indexOf(x) === k);
          const lis = Array.from(tr.querySelectorAll('.op-c-dl ul.op-dl > li'));
          if (lis.map((li) => li.getAttribute('data-request')).join() !== ids.join()) issues.push(r.truckId + ' stop ' + (i + 1) + ' platoons ' + lis.map((li) => li.getAttribute('data-request')).join() + ' vs ' + ids.join());
          lis.forEach((li) => { if (li.querySelectorAll('.op-dl-unit').length !== 1) issues.push(r.truckId + ' platoon named more than once'); });
          const what = Array.from(tr.querySelectorAll('.op-dl-what')).map((e) => e.textContent);
          lines += what.length;
          if (what.length !== real.length) issues.push(r.truckId + ' stop ' + (i + 1) + ' shows ' + what.length + ' loads, plan has ' + real.length);
          real.forEach((d, k) => {
            const t = what[k] || '';
            const it = H.itemById(d.itemId);
            if (t.indexOf(F.classLabel(d.classId)) < 0 || (it && t.indexOf(it.name) < 0)) issues.push(r.truckId + ' load "' + t + '" lacks item or class');
            if (/\([^()]*\(/.test(t)) issues.push('nested brackets: ' + t);
          });
        });
      });
      return { issues, lines };
    });
    check(!mv.issues.length && mv.lines > 0, 'movement tables match the plan: DTG, MGRS, miles, gallons, one entry per platoon, every load with item and class', mv);
    const dv = await page.evaluate(() => {
      const st = SRO.app.store.getState(), H = SRO.data.catalogHelpers;
      const plan = st.plans.filter((p) => p.approved && !p.superseded).pop();
      const def = (plan.deferred || []).filter((d) => !(d.qty <= 0));
      const ids = def.map((d) => d.requestId).filter((x, k, a) => a.indexOf(x) === k);
      const rows = Array.from(document.querySelectorAll('.op-deferred li.list-row'));
      const bad = [];
      rows.forEach((li) => {
        const rid = li.querySelector('.list-row-meta').textContent, sub = li.querySelector('.list-row-sub').textContent;
        const req = st.requests.find((r) => r.id === rid);
        const d = def.find((x) => x.requestId === rid);
        if (!d) { bad.push(rid + ' not deferred'); return; }
        const li0 = Array.isArray(d.lineIdx) ? d.lineIdx[0] : d.lineIdx;
        const it = H.itemById(d.itemId || (req && typeof li0 === 'number' && req.lines[li0] ? req.lines[li0].itemId : null));
        if (!/· Class [IVX]+ \(/.test(sub) || (it && sub.indexOf(it.name) < 0)) bad.push(rid + ': ' + sub);
      });
      return { def: def.length, ids: ids.length, rows: rows.length, bad };
    });
    check(dv.rows >= dv.ids && dv.rows <= dv.def && !dv.bad.length, 'deferred list: one row per request and reason, each with amount, item and class', dv);
    // arrive / depart: two columns, or one wrapping line in a narrow panel; nothing clipped, also
    // on the row under the pointer
    await page.locator('section.op-truck tbody tr').nth(1).hover();
    const tm = await page.evaluate(() => {
      const bad = [];
      let mode = null;
      document.querySelectorAll('section.op-truck').forEach((sec) => {
        const box = sec.getBoundingClientRect();
        sec.querySelectorAll('tbody tr').forEach((tr) => {
          const arr = tr.querySelector('.op-c-arr'), time = tr.querySelector('.op-c-time');
          const m = getComputedStyle(arr).display !== 'none' ? 'columns' : (getComputedStyle(time).display !== 'none' || !time.textContent ? 'line' : 'none');
          if (mode && m !== mode) bad.push('mixed ' + m);
          mode = mode || m;
          if (m === 'none') bad.push('no times shown');
          tr.querySelectorAll('td, .op-t').forEach((el) => {
            if (!el.getClientRects().length) return;
            const b = el.getBoundingClientRect();
            if (b.right > box.right + 1 || b.left < box.left - 1 || (el.tagName === 'TD' && el.scrollWidth > el.clientWidth + 1)) bad.push(sec.getAttribute('data-truck') + ' ' + el.className + ' clipped');
          });
        });
      });
      return { mode, bad: bad.slice(0, 6) };
    });
    check(tm.mode && !tm.bad.length, 'arrive and depart times show in full', tm);
    if (isPhone) check(tm.mode === 'line', 'phone: arrive and depart wrap under the location', tm.mode);
    await overflowOk(page, vp.width, 'movement');
    if (night) await nightOk(page, 'movement');
    await shot('movement');
    // CSV download
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('[data-act="csv"]')]);
    const name = dl.suggestedFilename();
    const file = await dl.path();
    const text = fs.readFileSync(file, 'utf8');
    check(new RegExp('^movement-' + planInfo.id + '-').test(name) && /\.csv$/.test(name), 'CSV file name', name);
    check(text.charCodeAt(0) === 0xfeff && /\r\n/.test(text) && text === planInfo.csv, 'CSV has a BOM, CRLF lines and matches movementCsv', { len: text.length, expect: planInfo.csv.length });
    const rowsCsv = parseCsv(text.replace(/^﻿/, ''));
    const hdr = rowsCsv[0];
    const expectHdr = ['plan_id', 'window', 'truck', 'truck_type', 'frequency', 'stop', 'stop_kind', 'location', 'mgrs', 'arrive_dtg', 'depart_dtg', 'request_id', 'platoon', 'class', 'item', 'qty', 'qty_unit', 'done'];
    check(hdr.join() === expectHdr.join(), 'CSV header', hdr);
    const data = rowsCsv.slice(1).filter((r) => r.length > 1);
    check(data.length === planInfo.csvRows && data.every((r) => r.length === expectHdr.length && r[0] === planInfo.id), 'CSV: one row per delivery plus hub start / return rows, all 18 columns', { rows: data.length, expect: planInfo.csvRows });
    check(data.every((r) => r[17] === '') && data.filter((r) => r[5] === 'return' && r[6] === 'return').length === planInfo.used, 'CSV: no stop marked done before any re-plan; one return row per truck', data.filter((r) => r[17] !== '').slice(0, 2));
    check(data.every((r) => !/\([^()]*\(/.test(r[14])), 'CSV item names have no nested brackets', data.map((r) => r[14]).filter((x) => /\([^()]*\(/.test(x)).slice(0, 3));
    const firstStop = data.find((r) => r[2] === planInfo.first && r[5] === '1');
    check(firstStop && firstStop[8] === planInfo.mgrs && firstStop[9] === planInfo.arrive && /^\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}$/.test(firstStop[8]), 'CSV stop row has the MGRS and arrive DTG', firstStop);
    if (planInfo.d1) check(firstStop[11] === planInfo.d1.requestId && firstStop[12] === planInfo.d1.platoon && Number(firstStop[15]) === planInfo.d1.qty && /^Class [IVX]+ \(/.test(firstStop[13]), 'CSV delivery columns: request, platoon, class label, qty', firstStop);
    const hubRow = data.find((r) => r[2] === planInfo.first && r[6] === 'hub');
    check(hubRow && hubRow[11] === '' && hubRow[12] === '', 'CSV hub row has empty delivery columns', hubRow);
  });

  // ---- notices --------------------------------------------------------------------------------------
  await step('notices', async () => {
    await showOutputs(page, 'notices');
    const n = await page.evaluate(() => { const st = SRO.app.store.getState(); const plan = st.plans.filter((p) => p.approved && !p.superseded).pop(); return SRO.ui.outputs.noticesFor(st, plan).length; });
    const cards = await page.locator('section.op-notice').count();
    const k = await page.evaluate(() => { const c = document.querySelector('section.op-notice .op-notice-kv'); const m = {}; c.querySelectorAll('dt').forEach((dt) => { m[dt.textContent] = dt.nextElementSibling.textContent; }); return m; });
    check(cards === n && n > 0, 'one pickup notice per platoon', { cards, n });
    check(/^\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}$/.test(k.MGRS) && /^\d{6}[A-Z] [A-Z]{3} \d{2}/.test(k.ETA) && /\d{2}\.\d{3} \(notional\)/.test(k.Frequency) && /-\d/.test(k.Truck), 'notice: pickup point MGRS, ETA DTG, truck callsign, frequency', k);
    const nv = await page.evaluate(noticeAudit);
    check(!nv.issues.length && nv.cards === nv.byRequest, 'every notice stop matches the engine (byRequest stops: grid, ETA, truck, stops before) and deferred loads name the item', nv);
    check(nv.updated === 0, 'no notice is marked updated before any re-plan', nv.updated);
    if (night) await nightOk(page, 'notices');
    await shot('notices');
  });

  // ---- print layouts --------------------------------------------------------------------------------
  await step('print', async () => {
    await page.evaluate(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
    await showOutputs(page, 'movement');
    await page.click('[data-act="print-movement"]');
    await page.waitForFunction(() => window.__prints >= 1, null, { timeout: 5000 }).catch(() => null);
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const pm = await page.evaluate(() => ({ prints: window.__prints, blocks: document.querySelectorAll('#print-root .op-print-truck').length, title: (document.querySelector('#print-root .print-title') || {}).textContent, topbar: !!document.querySelector('#topbar') && getComputedStyle(document.querySelector('#topbar')).display !== 'none', root: getComputedStyle(document.querySelector('#print-root')).display !== 'none', bg: getComputedStyle(document.querySelector('#print-root')).color }));
    check(pm.prints >= 1 && pm.blocks === planInfo.used && pm.title === 'Movement table' && !pm.topbar && pm.root, 'movement print layout: one block per truck, only the print root shows', pm);
    if (!isPhone) await shot('print-movement', true);
    await page.emulateMedia({ media: 'screen' });
    await showOutputs(page, 'notices');
    await page.click('[data-act="print-notices"]');
    await page.waitForFunction(() => window.__prints >= 2, null, { timeout: 5000 }).catch(() => null);
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const pn = await page.evaluate(() => ({ blocks: document.querySelectorAll('#print-root .op-print-notice').length, breaks: document.querySelectorAll('#print-root .op-print-notice.print-break').length, kv: document.querySelectorAll('#print-root .op-print-notice .op-notice-kv').length }));
    const n = await page.locator('section.op-notice').count();
    check(pn.blocks === n && pn.breaks === n - 1 && pn.kv >= n, 'notices print one per page', { pn, n });
    if (!isPhone) await shot('print-notices', true);
    await page.emulateMedia({ media: 'screen' });
    await settle(page);
  });

  // ---- snapshots + history -----------------------------------------------------------------------
  await step('snapshots', async () => {
    await showOutputs(page, 'snapshots');
    const before = await page.evaluate(() => SRO.app.store.getState().snapshots.length);
    await page.fill('#op-snap-name', 'Spec A');
    await page.click('[data-act="snap-save"]'); await settle(page);
    await page.fill('#op-snap-name', 'Spec B');
    await page.click('[data-act="snap-save"]'); await settle(page);
    const snaps = await page.evaluate(() => SRO.app.store.getState().snapshots.map((s) => s.name));
    const listed = await page.locator('li.op-snap').evaluateAll((els) => els.map((e) => e.querySelector('.list-row-title').textContent));
    check(snaps.length === before + 2 && listed[0].indexOf('Spec B') === 0 && listed[1].indexOf('Spec A') === 0, 'snapshots save with a name and list newest first', { snaps, listed });
    await page.locator('li.op-snap [data-act="snap-compare"]').first().click();
    await page.waitForSelector('.modal .op-cmp', { state: 'visible' });
    await settle(page);
    const cmp = await page.evaluate(() => ({ tables: document.querySelectorAll('.modal .op-cmp').length, total: !!document.querySelector('.modal .op-cmp [data-row="total"]'), title: document.querySelector('.modal').innerText.slice(0, 80), wide: document.querySelector('.modal .op-cmp').scrollWidth <= document.querySelector('.modal .op-cmp').parentNode.clientWidth + 1 }));
    check(cmp.tables === 2 && cmp.total && /Spec B/.test(cmp.title) && /Spec A/.test(cmp.title), 'Compare to previous shows cost and plan deltas', cmp);
    check(cmp.wide, 'compare tables fit the dialog', cmp);
    const onTop = await page.evaluate(() => { const m = document.querySelector('.modal'); const r = m.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(el && el.closest('.modal')); });
    check(onTop, 'the dialog paints above the map');
    if (night) await nightOk(page, 'compare');
    await shot('compare');
    await closeModals(page);
    await page.locator('li.op-snap [data-act="snap-open"]').first().click();
    await settle(page);
    const op = await page.evaluate(() => ({ sub: document.querySelector('.op-tabs [aria-selected="true"]').getAttribute('data-subtab') }));
    check(op.sub === 'movement', 'Open shows the snapshot plan in Movement', op);
    await showOutputs(page, 'snapshots');
    await overflowOk(page, vp.width, 'snapshots');
    await shot('snapshots');
    // history
    await showOutputs(page, 'history');
    const hist = await page.evaluate((id) => ({ windows: document.querySelectorAll('section.op-window').length, row: !!document.querySelector('li.op-hplan[data-plan="' + id + '"]') }), planInfo.id);
    check(hist.windows >= 1 && hist.row, 'History lists the window and its approved plan', hist);
    const hr = await historyRequests(page, planInfo.windowId);
    check(hr.closed && hr.summary === 'Requests (' + hr.want + ')' && hr.items === hr.want && !hr.bad.length, 'History: the window\'s requests (collapsed) with their final status', hr);
    if (night) await nightOk(page, 'history');
    await shot('history');
  });

  // ---- export -> reset -> import ------------------------------------------------------------------
  await step('data round trip', async () => {
    await showOutputs(page, 'data');
    const sum = () => page.evaluate(() => { const s = SRO.app.store.getState(); return { requests: s.requests.length, plans: s.plans.length, snapshots: s.snapshots.length, zones: JSON.stringify(s.scenario.zones), fleet: s.scenario.fleet.map((t) => t.id + ':' + t.status).join(), settings: JSON.stringify(s.scenario.settings), rally: JSON.stringify(s.scenario.rally) }; });
    const before = await sum();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('[data-act="export"]')]);
    const name = dl.suggestedFilename();
    const file = path.join(TMP, 'export-' + tag + '.json');
    await dl.saveAs(file);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { parsed = null; }
    check(/^supply-route-data-.+\.json$/.test(name) && parsed && parsed.plans.length === before.plans && parsed.requests.length === before.requests, 'Export downloads all data as JSON', { name, plans: parsed && parsed.plans.length });
    await shot('data');
    // reset
    await page.click('[data-act="reset"]');
    await page.waitForSelector('[data-action="reset"]', { state: 'visible' });
    await settle(page);
    await page.click('[data-action="reset"]');
    await settle(page, 80);
    const after = await page.evaluate(() => { const s = SRO.app.store.getState(); return { plans: s.plans.length, snapshots: s.snapshots.length, zones: s.scenario.zones.length, role: s.ui.role, tab: s.ui.plannerTab, theme: s.ui.theme }; });
    check(after.plans === 0 && after.snapshots === 0 && after.zones === 0 && after.role === 'planner' && after.tab === 'outputs' && after.theme === theme, 'Reset demo clears data and stays on Outputs', after);
    // import with confirmation
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.click('[data-act="import"]')]);
    await chooser.setFiles(file);
    await page.waitForSelector('.modal-actions .btn-danger', { state: 'visible', timeout: 5000 });
    await settle(page);
    const ask = await page.locator('.modal').innerText();
    await page.click('.modal-actions .btn-danger');
    await settle(page, 80);
    const back = await sum();
    check(/Import/.test(ask) && JSON.stringify(back) === JSON.stringify(before), 'Import (after confirming) restores everything exported', { ask: ask.slice(0, 120), diff: Object.keys(back).filter((k) => back[k] !== before[k]) });
    if (night) await nightOk(page, 'data');
  });

  await step('final', async () => {
    check(!errors.length, 'zero console errors (tiles excepted)', errors);
    check(!blocked.length, 'no non-tile network requests', blocked.slice(0, 5));
  });
  await ctx.close();
}

// ---- persistence across a reload ------------------------------------------------------------------
// Its own page with a small seed (requests, no plans). Harness note: in headless Chromium a page's
// localStorage writes in the first document of a new context are sometimes lost on its first
// reload (the reload sees only what the init script wrote; reproduced with a plain page and no app
// code, about 1 in 15 at 390 px). One warm-up reload before the changes avoids it (0 in 90).
async function persistenceCheck(browser, url, vp, theme, seed) {
  scope = vp.name + ' ' + vp.width + 'x' + vp.height + ' ' + theme + ' persistence';
  const s0 = JSON.parse(seed);
  s0.ui.theme = theme;
  s0.plans = []; s0.snapshots = []; s0.windows = [];
  s0.requests.forEach((r) => { r.status = 'submitted'; delete r.planId; delete r.eta; });
  s0.scenario.fleet.forEach((t) => { t.status = 'available'; t.availableAt = null; });
  s0.ui.lastPlanId = null;
  const { ctx, page, errors, blocked } = await openPage(browser, url, vp, JSON.stringify(s0));
  await step('persist', async () => {
    await page.reload();
    await waitApp(page);
    await showScenario(page, 'settings');
    await slide(page, 'input.range[data-weight="fuel"]', 7);
    await commit(page, '[data-fk="timeLimit"]', 120);
    await page.click('[data-fk="set-rally-max-plus"]'); await settle(page);
    await page.click('.sc-adv-summary'); await settle(page);
    await commit(page, '[data-fk="convoy"]', 1.7);
    await page.click('.sc-tune-seg [data-method="tabu"]'); await settle(page);
    await commit(page, '.sc-tune-panel[data-method="tabu"] .sc-knob[data-knob="tenure"] input.sc-knob-num', 20);
    await page.click('.sc-tune-panel[data-method="tabu"] .sc-knob[data-knob="aspiration"] input.switch'); await settle(page);
    await page.click('.sc-tune-seg [data-method="sa"]'); await settle(page);
    await commit(page, '.sc-tune-panel[data-method="sa"] .sc-knob[data-knob="coolingRate"] input.sc-knob-num', 0.99);
    await page.fill('.sc-pinput[data-period="0"][data-key="end"]', '1730');
    await page.fill('.sc-pinput[data-period="1"][data-key="start"]', '1730');
    await settle(page);
    await page.click('[data-fk="periods-save"]'); await settle(page, 300);
    await page.reload();
    await waitApp(page);
    const s = await page.evaluate(() => { const st = SRO.app.store.getState(); const s = st.scenario.settings; const mp = s.methodParams || {}; return { role: st.ui.role, theme: document.documentElement.getAttribute('data-theme'), fuel: s.weights.fuel, t: s.timeLimitSec, convoy: s.convoyFactor, max: s.maxRallyPoints, tenure: (mp.tabu || {}).tenure, asp: (mp.tabu || {}).aspiration, cool: (mp.sa || {}).coolingRate, day: s.periods[0].end }; });
    check(s.role === 'planner' && s.theme === theme && s.fuel === 7 && s.t === 120 && s.convoy === 1.7 && s.max === 9 && s.tenure === 20 && s.asp === false && s.cool === 0.99 && s.day === '1730', 'settings, knobs and the time-of-day table persist across a reload', s);
    await showScenario(page, 'settings');
    await page.evaluate(() => { const d = document.querySelector('details.sc-adv'); if (!d.open) d.querySelector('summary').click(); });
    await settle(page);
    await page.click('.sc-tune-seg [data-method="tabu"]'); await settle(page);
    const dom = await page.evaluate(() => ({ convoy: document.querySelector('[data-fk="convoy"]').value, tenure: document.querySelector('.sc-tune-panel[data-method="tabu"] .sc-knob[data-knob="tenure"] input.sc-knob-num').value, asp: document.querySelector('.sc-tune-panel[data-method="tabu"] .sc-knob[data-knob="aspiration"] input.switch').checked, dot: !!document.querySelector('.sc-tune-seg [data-method="tabu"] .sc-dot'), fuel: document.querySelector('input.range[data-weight="fuel"]').value, day: document.querySelector('.sc-pinput[data-period="0"][data-key="end"]').value }));
    check(dom.convoy === '1.7' && dom.tenure === '20' && dom.asp === false && dom.dot && dom.fuel === '7' && dom.day === '1730', 'the reloaded page shows the saved values and the changed dot', dom);
  });
  check(!errors.length, 'zero console errors (tiles excepted)', errors);
  check(!blocked.length, 'no non-tile network requests', blocked.slice(0, 5));
  await ctx.close();
}

// ---- contingency: a truck breaks down mid-route and a road closes, re-plan, approve ----------------
// Runs the real engine once (1440x900 dark) from the seed: at 0800 some stops are made; a truck with
// stops made and stops left is marked out and a road closes on a leg not yet driven. Re-plan now,
// review, approve. Returns the exported data, which contingencyOutputs loads in every size and theme.
async function makeContingency(browser, url, seed) {
  scope = 'contingency 1440x900 dark';
  console.log('\n== ' + scope);
  const s0 = JSON.parse(seed);
  s0.ui.theme = 'dark';
  const { ctx, page, errors, blocked } = await openPage(browser, url, VIEWPORTS[0], JSON.stringify(s0));
  let out = null;
  await step('contingency re-plan', async () => {
    const c = await page.evaluate(() => {
      const S = SRO.app.store;
      S.dispatch({ type: 'settings/update', changes: { methodParams: { tabu: { timeCapSec: 5 } } } });
      const plan0 = S.getState().plans.find((p) => p.approved && !p.superseded);
      const used = plan0.routes.filter((r) => r.stops.length >= 2);
      let now = 480;
      let r = used.find((x) => x.stops[0].arrive <= now && x.stops[x.stops.length - 1].arrive > now);
      if (!r) { r = used.slice().sort((a, b) => a.stops[0].depart - b.stops[0].depart)[0]; now = Math.ceil(r.stops[0].depart) + 1; }
      S.dispatch({ type: 'clock/tick', simMin: now });
      S.dispatch({ type: 'truck/markOut', truckId: r.truckId, reason: 'Flat tire' });
      const z = plan0.routes.find((x) => x.legs.some((l) => l.depart > now + 20));
      const leg = z && z.legs.find((l) => l.depart > now + 20);
      const co = leg ? SRO.core.engine.legCoords(leg) : null;
      if (co) S.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: co[Math.floor(co.length / 2)][0], lon: co[Math.floor(co.length / 2)][1], radiusMi: 2, label: 'Spec closure' } });
      return { now, truck: r.truckId, made: r.stops.filter((s) => s.arrive <= now).length, left: r.stops.filter((s) => s.arrive > now).length, zone: !!co, parent: plan0.id };
    });
    check(c.made > 0 && c.left > 0 && c.zone, 'contingency set-up: a truck with stops made and stops left, a closure ahead', c);
    await showScenario(page, 'fleet');
    const bn = await page.evaluate(() => { const b = document.querySelector('.sc-replan'); return b ? b.innerText : ''; });
    check(bn.indexOf(c.truck) >= 0 && bn.indexOf(c.left + ' stop') >= 0 && /Spec closure/.test(bn), 'banner names the broken-down truck, its stops left and the closure', bn);
    await page.click('.sc-replan-btn');
    await page.waitForFunction((pid) => SRO.app.store.getState().plans.some((p) => p.parentPlanId === pid), c.parent, { timeout: 90000 });
    await settle(page, 150);
    const rp = await page.evaluate(({ pid, truck, now }) => {
      const s = SRO.app.store.getState();
      const p = s.plans.filter((x) => x.parentPlanId === pid).pop();
      const parent = s.plans.find((x) => x.id === pid);
      const d = SRO.ui.outputs.diffPlans(s, parent, p);
      const outRoute = p.routes.find((r) => r.truckId === truck);
      return {
        id: p.id, approved: p.approved, tab: s.ui.plannerTab,
        outStops: outRoute ? { out: !!outRoute.out, notDone: outRoute.stops.filter((x) => !x.done).length } : null,
        done: p.routes.reduce((n, r) => n + r.stops.filter((x) => x.done).length, 0),
        kinds: d.map((x) => x.kind), ids: d.map((x) => x.id).sort().join(), engine: (p.changes || []).map((x) => x.requestId).sort().join()
      };
    }, { pid: c.parent, truck: c.truck, now: c.now });
    check(!rp.approved && rp.tab === 'plan' && (!rp.outStops || (rp.outStops.out && rp.outStops.notDone === 0)) && rp.done > 0, 'Re-plan keeps the stops made, takes the broken-down truck off the road, and opens the Plan tab', rp);
    check(rp.ids && rp.ids === rp.engine, 'compare lists exactly the requests the engine says changed', rp);
    await showScenario(page, 'fleet');
    const btns = await page.evaluate(() => { const b = document.querySelector('.sc-replan'); const rv = b.querySelector('.sc-review-btn'), ag = b.querySelector('.sc-replan-btn'); return { review: rv && rv.classList.contains('btn-primary'), again: ag && ag.textContent.trim(), againPrimary: ag && ag.classList.contains('btn-primary') }; });
    check(btns.review && btns.again === 'Re-plan again' && !btns.againPrimary, 'banner: Review re-plan first, Re-plan again second', btns);
    await clearToasts(page);
    await page.screenshot({ path: path.join(SHOTS, 'contingency-banner-review.png') });
    await page.click('.sc-review-btn');
    await settle(page);
    const tab = await page.evaluate(() => SRO.app.store.getState().ui.plannerTab);
    check(tab === 'plan', 'Review re-plan opens the Plan tab', tab);
    const ap = await page.evaluate((id) => SRO.app.store.dispatch({ type: 'plan/approve', planId: id }).ok, rp.id);
    await showScenario(page, 'fleet');
    const gone = await page.locator('.sc-replan').count();
    check(ap && gone === 0, 'approving the re-plan clears the Re-plan banner (no reason left, no draft)', { ap, gone });
    out = { json: await page.evaluate(() => SRO.app.store.exportJson()), truck: c.truck, parent: c.parent, id: rp.id };
  });
  check(!errors.length, 'zero console errors (tiles excepted)', errors);
  check(!blocked.length, 'no non-tile network requests', blocked.slice(0, 5));
  await ctx.close();
  return out;
}

// Outputs after the approved re-plan, in one size and theme.
async function contingencyOutputs(browser, url, vp, theme, cont) {
  scope = vp.name + ' ' + vp.width + 'x' + vp.height + ' ' + theme + ' after re-plan';
  console.log('\n== ' + scope);
  const s0 = JSON.parse(cont.json);
  s0.ui.theme = theme;
  const { ctx, page, errors, blocked } = await openPage(browser, url, vp, JSON.stringify(s0));
  const tag = vp.width + '-' + theme + '-replan';
  const shot = async (name) => { await clearToasts(page); await settle(page); await page.screenshot({ path: path.join(SHOTS, tag + '-' + name + '.png') }); };
  const scrollTo = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (e) e.scrollIntoView({ block: 'start' }); }, sel);
  await step('banner', async () => {
    await showScenario(page, 'fleet');
    check(!(await page.locator('.sc-replan').count()), 'no Re-plan banner after the re-plan is approved');
  });
  await step('movement after re-plan', async () => {
    await showOutputs(page, 'movement');
    const m = await page.evaluate((truck) => {
      const st = SRO.app.store.getState(), F = SRO.core.format;
      const plan = st.plans.find((p) => p.approved && !p.superseded);
      const issues = [];
      let done = 0, stopped = 0;
      if (document.querySelector('.op-plan-select').value !== plan.id) issues.push('shows ' + document.querySelector('.op-plan-select').value);
      if (!/still to drive: /.test(document.querySelector('.op-head').innerText)) issues.push('summary does not say the totals are what was still to drive');
      const mpg = st.scenario.settings.mpg || 2;
      plan.routes.filter((r) => r.stops.length).forEach((r) => {
        const sec = document.querySelector('section.op-truck[data-truck="' + r.truckId + '"]');
        if (!sec) { issues.push('no table for ' + r.truckId); return; }
        const line = sec.querySelector('.op-truck-head').innerText;
        const rows = Array.from(sec.querySelectorAll('tbody tr'));
        const last = rows[rows.length - 1];
        const trip = r.continued || r.out || r.cutOff ? r.legs.reduce((a, l) => a + (l.miles || 0), 0) : r.miles;
        if (line.indexOf(F.miles(trip)) < 0 || line.indexOf(F.gallons(r.continued || r.out || r.cutOff ? trip / mpg : r.gallons)) < 0) issues.push(r.truckId + ' head miles/gallons are not the whole trip: ' + line);
        const nDone = r.stops.filter((s) => s.done).length;
        const doneRows = rows.filter((tr) => tr.getAttribute('data-done') === 'true');
        done += doneRows.length;
        if (doneRows.length !== nDone || doneRows.some((tr) => !tr.querySelector('.op-done-badge'))) issues.push(r.truckId + ' done rows ' + doneRows.length + ' vs ' + nDone);
        if (nDone && line.indexOf('(' + nDone + ' done)') < 0) issues.push(r.truckId + ' head lacks done count');
        if (r.out || r.cutOff) {
          stopped++;
          const badge = sec.querySelector('.op-stop-badge');
          if (!badge || badge.textContent !== (r.out ? 'Out of service' : 'Cut off')) issues.push(r.truckId + ' stop badge');
          if (last.getAttribute('data-kind') !== 'stopped' || !last.classList.contains('op-stoprow') || sec.querySelector('tr[data-kind="return"]')) issues.push(r.truckId + ' ends with a return row');
          if (r.out && last.querySelector('.op-c-loc').textContent !== 'Out of service (Flat tire), does not drive on') issues.push(r.truckId + ' stopped row text: ' + last.querySelector('.op-c-loc').textContent);
          if (['.op-c-mgrs', '.op-c-arr', '.op-c-dep', '.op-c-time'].some((c) => last.querySelector(c) && last.querySelector(c).textContent.trim() !== '')) issues.push(r.truckId + ' stopped row shows grid or times');
          if (/back /.test(line) || !/out of service|cut off by a closed road/.test(line)) issues.push(r.truckId + ' head: ' + line);
        } else {
          if (last.getAttribute('data-kind') !== 'return' || line.indexOf('back ' + F.dtg(r.returnAt)) < 0) issues.push(r.truckId + ' return');
        }
      });
      return { issues: issues.slice(0, 8), done, stopped, outTruck: !!document.querySelector('section.op-truck[data-truck="' + truck + '"] .op-stop-badge') };
    }, cont.truck);
    check(!m.issues.length && m.done > 0 && m.stopped >= 1 && m.outTruck, 'Movement of the re-plan: stops made marked Done, the broken-down truck ends Out of service (no return), whole-trip miles and gallons', m);
    await overflowOk(page, vp.width, 'movement after re-plan');
    if (theme === 'night') await nightOk(page, 'movement after re-plan');
    await scrollTo('section.op-truck[data-truck="' + cont.truck + '"]');
    await shot('movement');
    const csv = await page.evaluate(() => { const st = SRO.app.store.getState(); const plan = st.plans.find((p) => p.approved && !p.superseded); const real = (s) => (s.deliveries || []).filter((d) => !(d.qty <= 0)); return { text: SRO.ui.outputs.movementCsv(st, plan), doneRows: plan.routes.reduce((n, r) => n + r.stops.filter((s) => s.done).reduce((k, s) => k + Math.max(1, real(s).length), 0), 0), routes: plan.routes.filter((r) => r.stops.length).map((r) => ({ t: r.truckId, stopped: !!(r.out || r.cutOff) })) }; });
    const rows = parseCsv(csv.text.replace(/^﻿/, '')).slice(1).filter((r) => r.length > 1);
    const ends = csv.routes.map((r) => ({ t: r.t, stopped: r.stopped, ret: rows.filter((x) => x[2] === r.t && x[5] === 'return').length, stop: rows.filter((x) => x[2] === r.t && x[5] === 'stopped' && x[6] === 'stopped').length }));
    check(rows.filter((r) => r[17] === 'yes').length === csv.doneRows && csv.doneRows > 0 && ends.every((e) => e.stopped ? e.stop === 1 && e.ret === 0 : e.ret === 1 && e.stop === 0), 'CSV of the re-plan: done column on stops made, a stopped row (no return) for the broken-down truck', { doneRows: csv.doneRows, yes: rows.filter((r) => r[17] === 'yes').length, ends });
  });
  await step('notices after re-plan', async () => {
    await showOutputs(page, 'notices');
    const nv = await page.evaluate(noticeAudit);
    const up = await page.evaluate(() => {
      const st = SRO.app.store.getState();
      const plan = st.plans.find((p) => p.approved && !p.superseded);
      const set = new Set(st.requests.filter((r) => r.updated && r.planId === plan.id).map((r) => r.id).concat((plan.changes || []).map((c) => c.requestId)));
      const cards = Array.from(document.querySelectorAll('section.op-notice'));
      return { want: cards.map((c) => c.getAttribute('data-request')).filter((id) => set.has(id)).sort().join(), got: cards.filter((c) => c.getAttribute('data-updated') === 'true').map((c) => c.getAttribute('data-request')).sort().join() };
    });
    check(!nv.issues.length && nv.cards === nv.byRequest && nv.done > 0, 'notices of the re-plan match the engine; stops already made read Delivered', nv);
    check(up.want && up.want === up.got, 'notices of the platoons the re-plan changed are marked Updated', up);
    await page.evaluate(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
    await page.locator('section.op-notice[data-updated="true"] .card-header button').first().click();
    await page.waitForFunction(() => window.__prints >= 1, null, { timeout: 5000 }).catch(() => null);
    const pt = await page.evaluate(() => (document.querySelector('#print-root .print-title') || {}).textContent || '');
    check(/^Pickup notice: .+ \(updated\)$/.test(pt), 'an updated notice prints as updated', pt);
    await overflowOk(page, vp.width, 'notices after re-plan');
    if (theme === 'night') await nightOk(page, 'notices after re-plan');
    await scrollTo('section.op-notice[data-updated="true"]');
    await shot('notices');
  });
  await step('history after re-plan', async () => {
    await showOutputs(page, 'history');
    const rows = await page.evaluate(({ a, b }) => {
      const ra = document.querySelector('li.op-hplan[data-plan="' + a + '"]'), rb = document.querySelector('li.op-hplan[data-plan="' + b + '"]');
      return { parent: ra && ra.innerText, child: rb && rb.innerText, badge: !!(rb && rb.querySelector('.op-replan-badge')), compare: !!(rb && rb.querySelector('[data-act="hist-compare"]')) };
    }, { a: cont.parent, b: cont.id });
    check(rows.parent && /Replaced/.test(rows.parent) && rows.child && /Approved/.test(rows.child) && rows.badge && rows.compare, 'History: the re-plan approved (marked Re-plan) and the plan it replaced, with Compare', rows);
    const win = await page.evaluate(() => SRO.app.store.getState().plans.find((p) => p.approved && !p.superseded).windowId);
    const hr = await historyRequests(page, win);
    const wantUpd = await page.evaluate((w) => { const st = SRO.app.store.getState(); const plan = st.plans.find((p) => p.approved && !p.superseded); const set = new Set(st.requests.filter((r) => r.updated && r.planId === plan.id).map((r) => r.id).concat((plan.changes || []).map((c) => c.requestId))); return st.requests.filter((r) => r.windowId === w && set.has(r.id)).length; }, win);
    check(hr.items === hr.want && hr.summary === 'Requests (' + hr.want + ')' && !hr.bad.length && hr.updated === wantUpd && wantUpd > 0, 'History requests: final status per request and the Updated mark', Object.assign(hr, { wantUpd }));
    await overflowOk(page, vp.width, 'history after re-plan');
    if (theme === 'night') await nightOk(page, 'history after re-plan');
    await shot('history');
    await page.click('li.op-hplan[data-plan="' + cont.id + '"] [data-act="hist-compare"]');
    await page.waitForSelector('.modal .op-compare', { state: 'visible' });
    await settle(page);
    const cm = await page.evaluate(({ a, b }) => {
      const st = SRO.app.store.getState();
      const pa = st.plans.find((p) => p.id === a), pb = st.plans.find((p) => p.id === b);
      const intro = document.querySelector('.modal .op-compare > p').textContent;
      const label = (SRO.solver.METHOD_LABELS || {})[pb.method] || '';
      const li = Array.from(document.querySelectorAll('.modal .op-moved > li'));
      const ids = (pb.changes || []).map((c) => c.requestId).sort().join();
      return {
        note: !!document.querySelector('.modal .op-cmp-note'), intro, methodTimes: label ? intro.split(label).length - 1 : 0,
        listed: li.map((x) => x.getAttribute('data-request')).sort().join(), ids,
        texts: li.map((x) => x.querySelector('.list-row-sub').textContent).filter((t) => !/(→|No longer|Also at|Now planned|Now deferred|Part now|No longer deferred)/.test(t) || /\d{6}H/.test(t)),
        fits: Array.from(document.querySelectorAll('.modal .op-cmp-wrap')).every((w) => w.scrollWidth <= w.clientWidth + 1),
        pa: !!pa
      };
    }, { a: cont.parent, b: cont.id });
    check(cm.note && cm.listed === cm.ids && cm.ids && !cm.texts.length && cm.methodTimes <= 2 && cm.fits, 'Compare before / after: re-plan note, every changed request listed with truck, place and HHMM time', cm);
    if (theme === 'night') await nightOk(page, 'compare after re-plan');
    await page.evaluate(() => { const s = document.querySelector('.modal .op-moved'); if (s) s.scrollIntoView({ block: 'start' }); });
    await shot('compare');
    await closeModals(page);
  });
  check(!errors.length, 'zero console errors (tiles excepted)', errors);
  check(!blocked.length, 'no non-tile network requests', blocked.slice(0, 5));
  await ctx.close();
}

// ---- screenshot pass (the tablet in every theme; desktop and phone in light and night) --------------
// Every Scenario and Outputs screen: no sideways overflow, steppers fit, night colours, a screenshot.
async function themeShots(browser, url, vp, theme, seed) {
  scope = vp.name + ' ' + vp.width + 'x' + vp.height + ' ' + theme + ' screens';
  console.log('\n== ' + scope);
  const s0 = JSON.parse(seed);
  s0.ui.theme = theme;
  const { ctx, page, errors, blocked } = await openPage(browser, url, vp, JSON.stringify(s0));
  const TABLET = vp;
  const tag = TABLET.width + '-' + theme;
  const b = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check(b === theme, 'boots in the ' + theme + ' theme', b);
  const shot = async (name) => { await clearToasts(page); await settle(page); await page.screenshot({ path: path.join(SHOTS, tag + '-' + name + '.png') }); };
  await page.evaluate(() => {
    const S = SRO.app.store;
    const id = SRO.ui.scenario.activePlan(S.getState()).routes.find((r) => r.stops.length).truckId;
    S.dispatch({ type: 'truck/markOut', truckId: id, reason: 'Flat tire' });
    S.dispatch({ type: 'zone/add', zone: { kind: 'risk', rating: 'High', lat: 23.0, lon: 120.3, radiusMi: 6, label: 'High risk near Tainan' } });
  });
  for (const sub of ['fleet', 'zones', 'rally', 'settings']) {
    await showScenario(page, sub);
    await overflowOk(page, TABLET.width, sub);
    if (theme === 'night') await nightOk(page, sub);
    await shot(sub);
  }
  await steppersOk(page, 'settings');
  await page.evaluate(() => { const d = document.querySelector('details.sc-adv'); if (!d.open) d.querySelector('summary').click(); });
  await settle(page);
  await overflowOk(page, TABLET.width, 'advanced');
  for (const [name, sel] of [['travel', '.sc-adv'], ['periods', '.sc-ptable'], ['tuning', '.sc-tune-seg'], ['demo-data', '[data-field="sampleSeed"]']]) {
    await page.evaluate((sel) => { const e = document.querySelector(sel); if (e) e.scrollIntoView(); }, sel);
    if (theme === 'night') await nightOk(page, name);
    await shot(name);
  }
  for (const sub of ['movement', 'notices', 'snapshots', 'history', 'data']) {
    await showOutputs(page, sub);
    await overflowOk(page, TABLET.width, sub);
    if (theme === 'night') await nightOk(page, sub);
    await shot(sub);
  }
  check(!errors.length, 'zero console errors (tiles excepted)', errors);
  check(!blocked.length, 'no non-tile network requests', blocked.slice(0, 5));
  await ctx.close();
}

// ---- main -----------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = build();
  const url = pathToFileURL(file).href;
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch();
  const t0 = Date.now();
  try {
    const seed = await makeSeed(browser, url);
    const only = opt('--only', '');          // e.g. --only phone:night
    const want = (vp, theme) => !only || only === vp.name + ':' + theme || only === vp.name || only === theme;
    // the functional walk (every control, the solver) runs once per viewport in the dark theme; the
    // light and night themes get the screenshot, overflow and theme-colour pass of every screen
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        if (!want(vp, theme)) continue;
        if (theme === 'dark') {
          await runCombo(browser, url, vp, theme, seed);
          await persistenceCheck(browser, url, vp, theme, seed);
        } else await themeShots(browser, url, vp, theme, seed);
      }
    }
    for (const theme of THEMES) if (want(TABLET, theme)) await themeShots(browser, url, TABLET, theme, seed);
    const after = VIEWPORTS.concat([TABLET]).flatMap((vp) => THEMES.filter((t) => want(vp, t)).map((t) => [vp, t]));
    if (after.length && !flag('--no-contingency')) {
      const cont = await makeContingency(browser, url, seed);
      if (cont) for (const [vp, theme] of after) await contingencyOutputs(browser, url, vp, theme, cont);
    }
  } finally {
    await browser.close();
  }
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed (' + Math.round((Date.now() - t0) / 1000) + ' s). Screenshots: ' + SHOTS);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
