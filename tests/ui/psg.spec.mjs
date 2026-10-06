#!/usr/bin/env node
// Playwright checks for the platoon sergeant views (src/ui/psg/profile.js, request.js, myrequests.js
// and the PSG section of src/styles.css). Plain node script:
//
//   node tests/ui/psg.spec.mjs [--no-build --file PATH] [--shots DIR] [--phone-only]
//
// Builds the single file (python3 tools/build.py --out <tmp>), opens it from file:// in Chromium at
// 390x844 and 320x568 (touch) and 1440x900 (mouse) and walks a platoon sergeant through the app:
//   - first run: unit setup form on first open, empty-save errors, map tap outside Taiwan rejected,
//     map tap inside accepted, "Use my location" (geolocation inside Taiwan), save -> profile/save;
//     geolocation outside Taiwan and permission denied fail gracefully (separate pages, phone only)
//   - the standard Routine fuel request (taps and typed fields counted for the report), the
//     confirmation with the request id and "Planned at the 1200 window ..."
//   - Urgent: on hand required, the run-out question when on hand lasts 24 h or more, "This will be
//     sent as IMMEDIATE: you run out in about 9 hours", submitted as Immediate with the earlier
//     deadline; on hand under 24 h goes Immediate without the question
//   - validation: no items, direct delivery without a reason, NLT in the past (errors, nothing
//     submitted); over 5x daily use and NLT sooner than the nearest hub can reach (warnings in a
//     confirm sheet: Go back / Send anyway); remove an item and Undo
//   - Unit tab: summary, mobility switch, "Update my location" sheet, Edit unit
//   - pickup: optional desired pickup spot tapped on the mini map, Fixed in place (direct), run-out
//     answer of 24 h or more ("This stays URGENT")
//   - My requests: empty state, cards, Edit (request/edit) and Cancel (request/cancel), a draft plan
//     (Planned, still editable)
//   - a hand-made plan injected through the store (plan/store + plan/approve, DESIGN 8b byRequest,
//     encoded leg paths): pickup name + MGRS, ETA, truck callsign, frequency and color chip,
//     "N stops before yours", the card map built while the platoon sergeant column was hidden (plan
//     approved in the planner role) and fitted once shown, the truck marker moving along its road
//     route as clock/tick advances
//     (position checked against SRO.ui.map.truckPosition), a deferred request ("Not in this window -
//     next plan at 1200" + reason), a re-plan that sets "Updated", and delivery
//   - each PSG tab keeps its own scroll place (one shared scroll container); after the unit setup the
//     form opens at its top; "View my requests" and a saved edit open on that request's card
//   - editing an IMMEDIATE request: NLT-only edit keeps the run-out deadline, a new on-hand count is
//     reported again; a delivery split over two trucks with a remainder (Partial, "Also coming")
//   - a real plan from the planner engine (request + 19 samples, Plan now, approved on the planner's
//     Plan tab): card ETA / truck / frequency / MGRS from plan.byRequest, the truck marker on the
//     engine's road path as the clock runs
//   - every key screen in the dark, light and night themes (screenshots), no horizontal scroll,
//     touch targets >= 44 px on the phone, no near-white colors in night mode, zero console errors
//     (blocked OpenStreetMap tile requests are expected and ignored), no non-tile network requests.
// Screenshots go to /tmp/claude-0/ui-shots/psg/. Exits 1 on any failure.
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

const SHOTS = opt('--shots', '/tmp/claude-0/ui-shots/psg');
const VIEWPORTS = [
  { width: 390, height: 844, touch: true },
  { width: 320, height: 568, touch: true },   // small phone (iPhone SE 1st gen class)
  { width: 1440, height: 900, touch: false }
].filter((v) => !flag('--phone-only') || v.touch);
const THEMES = ['dark', 'light', 'night'];
const TILE_RE = /tile\.openstreetmap\.org/i;
// fictional platoon position near Taoyuan; West Point, NY for the outside-Taiwan case
const INSIDE = { latitude: 24.99361, longitude: 121.30104 };
const OUTSIDE = { latitude: 41.39148, longitude: -73.95603 };

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

function build() {
  if (flag('--no-build')) {
    const f = path.resolve(opt('--file', path.join(ROOT, 'prototype/supply-route-app.html')));
    if (!fs.existsSync(f)) throw new Error('no built file at ' + f);
    return f;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-psg-spec-'));
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

// ---- bookkeeping ------------------------------------------------------------------------------------
const failures = [];
const report = {};
let passed = 0;
let scope = '';
function check(cond, msg, detail) {
  if (cond) { passed++; return true; }
  failures.push(scope + ': ' + msg + (detail !== undefined ? '  [' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ']' : ''));
  console.log('  FAIL ' + msg + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  return false;
}
function note(msg) { console.log('  note ' + msg); }

// ---- page helpers -----------------------------------------------------------------------------------
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const finite = document.getAnimations().filter((a) => { const t = a.effect && a.effect.getComputedTiming(); return t && isFinite(t.endTime); });
    await Promise.all(finite.map((a) => a.finished.catch(() => null)));
  });
}
async function waitApp(page) {
  await page.waitForFunction(() => window.SRO && window.SRO.app && window.SRO.app.store && document.querySelector('#psg-root .tabbar-item'), null, { timeout: 15000 });
  await settle(page);
}
async function openApp(browser, fileUrl, vp, opts = {}) {
  const ctxOpts = { viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.touch ? 2 : 1, hasTouch: !!vp.touch, isMobile: !!vp.touch };
  if (opts.geo) { ctxOpts.geolocation = opts.geo; ctxOpts.permissions = ['geolocation']; }
  const context = await browser.newContext(ctxOpts);
  const errors = [];
  const blocked = [];
  let tiles = 0;
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/.test(u)) return route.continue();
    if (!TILE_RE.test(u)) blocked.push(u);
    return route.abort('internetdisconnected');
  });
  if (opts.init) await context.addInitScript(opts.init);
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const loc = (msg.location() && msg.location().url) || '';
    if (TILE_RE.test(loc) || TILE_RE.test(text)) { tiles++; return; }
    errors.push(text.split('\n')[0] + (loc ? ' @ ' + loc.slice(-60) : ''));
  });
  page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)));
  await page.goto(fileUrl);
  await waitApp(page);
  return { context, page, errors, blocked, tiles: () => tiles };
}

const V = (tab) => '.psg-view[data-tab="' + tab + '"]';
async function visible(page, sel) { const l = page.locator(sel).first(); return (await l.count()) > 0 && l.isVisible(); }
async function text(page, sel) { const l = page.locator(sel).first(); return (await l.count()) ? (await l.innerText()).replace(/\s+/g, ' ').trim() : ''; }
async function count(page, sel) { return page.locator(sel).count(); }
const S = (page) => page.evaluate(() => {
  const s = window.SRO.app.store.getState();
  return { profile: s.profile, requests: s.requests.filter((r) => r.source === 'user'), simMin: s.clock.simMin, tab: s.ui.psgTab, theme: s.ui.theme };
});
const reqById = async (page, id) => (await S(page)).requests.find((r) => r.id === id);

// user actions; taps and typed fields are counted for the report
function actor(page, vp) {
  const a = {
    taps: 0, fields: 0,
    reset() { a.taps = 0; a.fields = 0; },
    async tap(sel) {
      const l = page.locator(sel).first();
      await l.waitFor({ state: 'visible', timeout: 5000 });
      await l.scrollIntoViewIfNeeded();
      a.taps++;
      if (vp.touch) await l.tap(); else await l.click();
      await settle(page);
    },
    async type(sel, value) {
      const l = page.locator(sel).first();
      await l.waitFor({ state: 'visible', timeout: 5000 });
      await l.scrollIntoViewIfNeeded();
      a.fields++;
      if (vp.touch) await l.tap(); else await l.click();
      await l.fill(String(value));
      await settle(page);
    },
    async tapAt(x, y) {
      a.taps++;
      if (vp.touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
      await settle(page);
    }
  };
  return a;
}

// through the store (theme/set, what the topbar button dispatches): the topbar is inert while a
// sheet is open
async function setTheme(page, theme) {
  await page.evaluate((t) => window.SRO.app.store.dispatch({ type: 'theme/set', theme: t }), theme);
  await settle(page);
  return (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme;
}

// screenshot one state in each theme (and run the layout checks in each), back to dark after
async function shots(page, tag, name, opts = {}) {
  for (const theme of opts.themes || THEMES) {
    check(await setTheme(page, theme), name + ': theme ' + theme + ' applied');
    await settle(page);
    if (opts.before) await opts.before();
    await page.waitForTimeout(150);   // map tiles fallback / marker redraw after a theme change
    // dismiss toasts so they do not cover the state being captured
    if (!opts.keepToasts) await page.evaluate(() => document.querySelectorAll('.toast-root .toast-close').forEach((b) => b.click()));
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, tag + '-' + name + '-' + theme + '.png'), fullPage: false });
    await layoutChecks(page, tag, name + ' (' + theme + ')', theme, opts);
  }
  await setTheme(page, 'dark');
  await settle(page);
}

async function layoutChecks(page, tag, label, theme, opts = {}) {
  const phone = parseInt(tag, 10) < 600;   // 390x844 and 320x568: touch targets checked
  const res = await page.evaluate(({ phone }) => {
    const vw = window.innerWidth;
    const out = { doc: document.documentElement.scrollWidth, vw, bodies: [], small: [], offscreen: [] };
    for (const b of document.querySelectorAll('#psg-root .psg-body')) if (b.scrollWidth > b.clientWidth + 1) out.bodies.push(b.scrollWidth + '>' + b.clientWidth);
    const roots = [...document.querySelectorAll('#psg-root .psg-view[data-active], .modal')];
    for (const root of roots) {
      for (const el of root.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role=radio]')) {
        if (el.closest('.leaflet-container')) continue;   // map controls belong to the map component
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const name = (el.className && typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : el.tagName.toLowerCase()) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24) + '"';
        if (phone && (r.height < 43.5 || r.width < 43.5)) out.small.push(name + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        if (r.right > vw + 0.5 || r.left < -0.5) out.offscreen.push(name + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      }
    }
    return out;
  }, { phone });
  check(res.doc <= res.vw && !res.bodies.length, label + ': no horizontal scroll', res.doc + ' vs ' + res.vw + ' ' + res.bodies.join(','));
  check(!res.offscreen.length, label + ': nothing cut off at the sides', res.offscreen.slice(0, 5));
  if (phone && !opts.skipTargets) check(!res.small.length, label + ': touch targets >= 44 px', res.small.slice(0, 6));
  if (theme === 'night') {
    const white = await whiteOffenders(page, ['#psg-root', '.modal', '.toast-root']);
    check(!white.length, label + ': no near-white colors in night mode', white.slice(0, 6));
  }
}

// near-white (light neutral) colors on visible elements under the given roots (map tiles excluded)
async function whiteOffenders(page, selectors) {
  return page.evaluate((sels) => {
    const parse = (c) => {
      let m = /rgba?\(([^)]+)\)/.exec(c || '');
      if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
      m = /color\(srgb ([^)]+)\)/.exec(c || '');
      if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
      return null;
    };
    const bright = (c) => { const x = parse(c); return x && x.a > 0.15 && Math.min(x.r, x.g, x.b) > 150; };
    const out = [];
    for (const sel of sels) {
      for (const rootEl of document.querySelectorAll(sel)) {
        for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
          if (!el.getClientRects().length) continue;
          if (el.closest('.leaflet-tile-pane')) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const props = ['color', 'background-color'];
          if (parseFloat(cs.borderTopWidth) > 0) props.push('border-top-color');
          if (el instanceof SVGElement) props.push('fill', 'stroke');
          const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          for (const p of props) {
            if (p === 'color' && !hasText && !(el instanceof SVGElement)) continue;
            const v = cs.getPropertyValue(p);
            if (bright(v)) out.push(el.tagName.toLowerCase() + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').join('.') + ' ' + p + '=' + v);
          }
        }
      }
    }
    return out;
  }, selectors);
}

// a point in the map's visible area (page coordinates) for a lat/lon, or the first sea point
async function mapPoint(page, sel, want) {
  await page.locator(sel).first().scrollIntoViewIfNeeded();
  await settle(page);
  return page.evaluate(({ sel, want }) => {
    const el = document.querySelector(sel);
    const m = el && el.__sroMap;
    if (!m) return null;
    const L = m.leaflet;
    const size = L.getSize();
    const r = el.getBoundingClientRect();
    if (want === 'sea') {
      for (let x = 14; x < size.x / 2; x += 8) {
        const y = size.y * 0.62;
        const ll = L.containerPointToLatLng([x, y]);
        if (!window.SRO.data.scenario.insideTaiwan(ll.lat, ll.lng)) return { x: r.left + x, y: r.top + y, lat: ll.lat, lon: ll.lng };
      }
      return null;
    }
    const p = L.latLngToContainerPoint([want.lat, want.lon]);
    if (p.x < 4 || p.y < 4 || p.x > size.x - 4 || p.y > size.y - 4) return null;
    const ll = L.containerPointToLatLng(p);
    return { x: r.left + p.x, y: r.top + p.y, lat: ll.lat, lon: ll.lng };
  }, { sel, want });
}

// the PSG scroll container (one for all PSG tabs) and where an element sits in the viewport
const bodyScroll = (page) => page.evaluate(() => { const b = document.querySelector('#psg-root .psg-body'); return b ? b.scrollTop : null; });
async function inView(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('#psg-root .tabbar');
    const bottom = bar ? bar.getBoundingClientRect().top : innerHeight;
    const top = document.querySelector('#psg-root .psg-body').getBoundingClientRect().top;
    return r.top >= top - 1 && r.top < bottom - 20;
  }, sel);
}

async function showTab(page, act, name) {
  await act.tap('#psg-root .tabbar-item[data-tab="' + name + '"]');
  check((await S(page)).tab === name, 'tab ' + name + ' selected');
}

// ---- the platoon sergeant walk-through ----------------------------------------------------------------
async function runFlow(browser, fileUrl, vp) {
  const tag = vp.width + 'x' + vp.height;
  scope = tag;
  console.log('\n== ' + tag + (vp.touch ? ' (touch)' : ''));
  const t0 = Date.now();
  const { context, page, errors, blocked, tiles } = await openApp(browser, fileUrl, vp, { geo: INSIDE });
  const act = actor(page, vp);
  const nums = report[tag] = {};

  // ---- 1. first run: unit setup ----------------------------------------------------------------------
  let s = await S(page);
  check(s.profile === null && s.tab === 'request', 'fresh start: no profile, New request tab');
  check(await visible(page, V('request') + ' .psg-profile-form[data-mode="setup"]'), 'first open shows "Set up your unit"');
  check((await text(page, V('request') + ' .psg-title')) === 'Set up your unit', 'setup title');
  await page.waitForTimeout(300);
  await shots(page, tag, '01-setup');

  // empty save -> both errors, nothing saved
  await act.tap(V('request') + ' .psg-save-profile');
  check(await visible(page, V('request') + ' .psg-bn-err'), 'empty save: battalion error shown');
  check((await text(page, V('request') + ' .psg-bn-err')).includes('Enter your battalion'), 'battalion error wording');
  check((await text(page, V('request') + ' .psg-loc-err')).includes('Set your location'), 'empty save: location error shown');
  check((await S(page)).profile === null, 'nothing saved while invalid');

  // map tap outside Taiwan -> rejected
  const mapSel = V('request') + ' .psg-profile-form .psg-map';
  const sea = await mapPoint(page, mapSel, 'sea');
  check(!!sea, 'found a sea point on the setup map');
  if (sea) {
    await act.tapAt(sea.x, sea.y);
    check((await text(page, V('request') + ' .psg-loc-msg')).includes('outside Taiwan'), 'map tap outside Taiwan is rejected with a message', await text(page, V('request') + ' .psg-loc-msg'));
    check(!(await visible(page, V('request') + ' .psg-loc-readout .psg-mgrs')), 'no location set by the sea tap');
  }
  // map tap inside Taiwan -> MGRS readout
  const land = await mapPoint(page, mapSel, { lat: 23.45, lon: 120.98 });
  check(!!land, 'found a land point on the setup map');
  if (land) {
    await act.tapAt(land.x, land.y);
    const mg = await text(page, V('request') + ' .psg-loc-readout .psg-mgrs');
    const want = await page.evaluate((p) => window.SRO.core.format.mgrs(p.lat, p.lon, 5), land);
    check(/^\d{2}[A-Z] [A-Z]{2} \d{5} \d{5}$/.test(mg), 'map tap shows the location as MGRS', mg);
    check(mg.slice(0, 9) === want.slice(0, 9), 'MGRS matches the tapped point', mg + ' vs ' + want);
    check(!(await text(page, V('request') + ' .psg-loc-msg')), 'error cleared after a good tap');
  }

  // the counted first run: 2nd PLT, B CO, battalion 4-93, Use my location, Save
  act.reset();
  await act.tap(V('request') + ' .psg-seg[data-name="plt"] button[data-value="2"]');
  await act.tap(V('request') + ' .psg-seg[data-name="co"] button[data-value="B"]');
  await act.type(V('request') + ' .psg-bn', '4-93');
  const unitName = '2nd PLT, B CO, 4-93 IN';
  const desig = await page.evaluate((n) => window.SRO.data.scenario.designatorFor(n), unitName);
  const prev = await text(page, V('request') + ' .psg-unit-preview');
  check(prev.includes(unitName), 'unit name preview in real format', prev);
  check(prev.includes(desig), 'designator from designatorFor (' + desig + ')', prev);
  check(await page.locator(V('request') + ' .psg-unit-preview .psg-sym svg').count() === 1, 'platoon symbol in the preview');
  check(!(await visible(page, V('request') + ' .psg-bn-err')), 'battalion error cleared');
  await act.tap(V('request') + ' .psg-geo-btn');
  await page.waitForFunction((sel) => { const e = document.querySelector(sel); return e && !e.disabled; }, V('request') + ' .psg-geo-btn');
  await settle(page);
  const geoMg = await text(page, V('request') + ' .psg-loc-readout .psg-mgrs');
  const geoWant = await page.evaluate((g) => window.SRO.core.format.mgrs(Math.round(g.latitude * 1e5) / 1e5, Math.round(g.longitude * 1e5) / 1e5, 5), INSIDE);
  check(geoMg === geoWant, '"Use my location" sets the device position as MGRS', geoMg + ' vs ' + geoWant);
  check((await text(page, V('request') + ' .psg-loc-readout')).includes('near') || (await text(page, V('request') + ' .psg-loc-readout')).includes('at '), 'nearest place shown next to the grid');
  const mobTxt = await text(page, V('request') + ' .psg-choices[data-name="mobility"]');
  check(mobTxt.includes('Mounted') && mobTxt.includes('Dismounted') && mobTxt.includes('Fixed in place'), 'three mobility choices');
  check(await page.locator(V('request') + ' .psg-choices[data-name="mobility"] .psg-choice-sub').count() === 3, 'each mobility choice has a one-line explanation');
  check((await page.getAttribute(V('request') + ' .psg-choice[data-value="mounted"]', 'aria-checked')) === 'true', 'Mounted is the default');
  await shots(page, tag, '02-setup-filled', { before: async () => { await page.locator(V('request') + ' .psg-loc-sec').scrollIntoViewIfNeeded(); } });
  await act.tap(V('request') + ' .psg-save-profile');
  nums.firstRun = { taps: act.taps, fields: act.fields, note: '2nd PLT, B CO (2 taps; 0 with the 1st PLT / A CO defaults), battalion typed, Use my location, Save' };
  s = await S(page);
  check(s.profile && s.profile.unitName === unitName && s.profile.designator === desig, 'profile/save stored unit name and designator', s.profile);
  check(s.profile && Math.abs(s.profile.lat - INSIDE.latitude) < 1e-4 && Math.abs(s.profile.lon - INSIDE.longitude) < 1e-4, 'profile location is the device position');
  check(s.profile && s.profile.mobility === 'mounted' && !!s.profile.gridId, 'profile mobility and nearest grid id saved');
  check(await visible(page, V('request') + ' .psg-unit-strip'), 'after setup the request form shows with the unit strip');
  check(await inView(page, V('request') + ' .psg-head') && await inView(page, V('request') + ' .psg-tile[data-class="III"]'),
    'after setup the request form opens at its top ("What do you need?" on screen, not scrolled to the Save position)', await bodyScroll(page));
  check((await text(page, V('request') + ' .psg-unit-strip')).includes(geoWant), 'unit strip shows the MGRS location');

  // ---- 2. My requests empty state ---------------------------------------------------------------------
  await showTab(page, act, 'myrequests');
  check(await visible(page, V('myrequests') + ' .psg-empty'), 'My requests empty state');
  check((await text(page, V('myrequests') + ' .psg-empty-new')).includes('New request'), 'empty state points to New request');
  await shots(page, tag, '03-mine-empty', { themes: ['dark'] });
  await act.tap(V('myrequests') + ' .psg-empty-new');
  check((await S(page)).tab === 'request', 'empty state button opens New request');

  // ---- 3. the standard Routine fuel request (counted) ------------------------------------------------------
  await page.locator(V('request') + ' .psg-head').scrollIntoViewIfNeeded();
  await shots(page, tag, '04-form-empty');
  act.reset();
  const tStart = Date.now();
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  check(await visible(page, V('request') + ' .psg-item[data-item="diesel"]'), 'Class III tile lists Diesel / JP-8');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  check(await visible(page, '.modal .psg-item-sheet'), 'item sheet opens');
  check((await page.getAttribute('.modal .psg-opts .chip[data-option="JP-8"]', 'aria-checked')) === 'true', 'first option preselected');
  check((await page.inputValue('.modal .psg-qty-row input')) === '500', 'default quantity 500 gal');
  const equiv = await text(page, '.modal .psg-equiv');
  check(equiv.includes('1.7 days of supply') && equiv.includes('20% of a tanker'), 'quantity shows days of supply and the tanker share', equiv);
  await shots(page, tag, '05-item-sheet');
  await act.tap('.modal [data-action="add-item"]');
  check(!(await visible(page, '.modal')), 'sheet closes after Add to request');
  check(await count(page, V('request') + ' .psg-cart .psg-line') === 1, 'cart has one line');
  check((await text(page, V('request') + ' .psg-cart .psg-line')).includes('500 gal'), 'cart line shows 500 gal');
  const foot = await text(page, V('request') + ' .psg-footer-sum');
  check(foot.includes('1 item') && foot.includes('Routine') && foot.includes('NLT 1800'), 'footer summary: 1 item, Routine, NLT 1800 (default)', foot);
  await shots(page, tag, '06-form-cart', { before: async () => { await page.locator(V('request') + ' [data-sec="supplies"]').scrollIntoViewIfNeeded(); } });
  await act.tap(V('request') + ' .psg-submit');
  nums.routineFuel = { taps: act.taps, fields: act.fields, steps: 'Class III tile, Diesel / JP-8, Add to request, Submit request', automatedMs: Date.now() - tStart };
  check(act.taps === 4 && act.fields === 0, 'standard Routine fuel request takes 4 taps and no typing', nums.routineFuel);
  check(await visible(page, V('request') + ' .psg-done'), 'confirmation shown');
  const r1 = await text(page, V('request') + ' .psg-done-rid');
  check(/^R-\d+$/.test(r1), 'confirmation shows the request id', r1);
  const nextTxt = await text(page, V('request') + ' .psg-next-text');
  check(nextTxt.startsWith('Planned at the 1200 window; you will see your pickup point and ETA'), 'confirmation: "Planned at the 1200 window ..."', nextTxt);
  let R = await reqById(page, r1);
  check(R && R.status === 'submitted' && R.urgency === 'Routine' && R.urgencyRequested === 'Routine', 'request/submit stored a Routine request', R && [R.status, R.urgency]);
  check(R && R.lines.length === 1 && R.lines[0].itemId === 'diesel' && R.lines[0].option === 'JP-8' && R.lines[0].qty === 500 && R.lines[0].classId === 'III', 'line: 500 gal JP-8, Class III');
  check(R && R.nlt === 1080 && R.directOnly === false && R.mobility === 'mounted' && R.unitName === unitName, 'NLT 1800, drop point, mounted, unit name');
  await shots(page, tag, '07-done');

  // ---- 4. Urgent -> run-out question -> Immediate ---------------------------------------------------------
  await act.tap(V('request') + ' .psg-new');
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  await act.tap('.modal [data-action="add-item"]');
  await act.tap(V('request') + ' .psg-choice[data-urgency="Urgent"]');
  check(await visible(page, V('request') + ' .psg-onhand-row[data-line="0"]'), 'Urgent asks for on hand per line');
  const before2 = (await S(page)).requests.length;
  await act.tap(V('request') + ' .psg-submit');
  check(await visible(page, V('request') + ' .psg-errors'), 'Urgent without on hand: errors shown');
  check((await text(page, V('request') + ' .psg-errors')).includes('on hand'), 'error names on hand', await text(page, V('request') + ' .psg-errors'));
  check((await S(page)).requests.length === before2, 'nothing submitted');
  await act.type(V('request') + ' .psg-onhand-row[data-line="0"] input', '900');
  await page.waitForTimeout(450);
  await settle(page);
  check((await text(page, V('request') + ' .psg-onhand-row[data-line="0"] .psg-onhand-hrs')).includes('72 hours'), 'on hand 900 gal lasts about 72 hours', await text(page, V('request') + ' .psg-onhand-row[data-line="0"] .psg-onhand-hrs'));
  check(await visible(page, '#psg-runout'), 'computed hours over 24: run-out question appears');
  check((await text(page, V('request') + ' .psg-runout .field-label')) === 'How many hours until you run out?', 'run-out question wording');
  await act.tap(V('request') + ' .psg-submit');
  check((await text(page, V('request') + ' .psg-errors')).includes('Answer how many hours until you run out.'), 'unanswered run-out question blocks submit');
  check((await S(page)).requests.length === before2, 'still nothing submitted');
  await act.type('#psg-runout', '30');
  check((await text(page, V('request') + ' .psg-stays-urgent')).includes('This stays URGENT: you have about 30 hours of supply.'), 'answer 30 h: stays URGENT, said plainly', await text(page, V('request') + ' .psg-stays-urgent'));
  check((await text(page, V('request') + ' .psg-footer-sum')).includes('Urgent'), 'footer badge shows Urgent');
  await act.type('#psg-runout', '9');
  const imm = await text(page, V('request') + ' .psg-immediate');
  check(imm.includes('This will be sent as IMMEDIATE: you run out in about 9 hours'), 'result shown plainly: "This will be sent as IMMEDIATE: you run out in about 9 hours"', imm);
  check(imm.includes('Deadline moves up to 1500'), 'deadline moves up to the run-out time', imm);
  check((await text(page, V('request') + ' .psg-footer-sum')).includes('Immediate'), 'footer badge shows Immediate');
  check(!(await visible(page, V('request') + ' .psg-errors')), 'errors cleared once answered');
  await shots(page, tag, '08-urgent-immediate', { before: async () => { await page.locator(V('request') + ' .psg-urg-result').evaluate((el) => el.scrollIntoView({ block: 'center' })); } });
  // optional desired pickup spot, tapped on the mini map
  check(await visible(page, V('request') + ' .psg-choice[data-value="drop"][aria-checked="true"]'), 'drop point is the default pickup');
  await act.tap(V('request') + ' .psg-hint-open');
  check(await visible(page, V('request') + ' .psg-map-hint-pick'), 'pickup hint mini map opens');
  await page.waitForTimeout(250);
  const want = await page.evaluate(() => {
    const st = window.SRO.app.store.getState();
    const geo = window.SRO.core.geo;
    const c = window.SRO.data.grid.filter((g) => g.rallyCandidate).map((g) => ({ g, d: geo.haversineMi(st.profile, g) })).sort((a, b) => a.d - b.d).find((x) => x.d > 3);
    return c ? { id: c.g.id, lat: c.g.lat, lon: c.g.lon, name: window.SRO.ui.psg.placeName(c.g), d: c.d } : null;
  });
  await shots(page, tag, '08b-pickup-hint', { themes: ['dark'], before: async () => { await page.locator(V('request') + ' .psg-map-hint-pick').evaluate((el) => el.scrollIntoView({ block: 'center' })); } });
  const hp = want && await mapPoint(page, V('request') + ' .psg-map-hint-pick', want);
  check(!!hp, 'drop point ' + (want && want.name) + ' visible on the hint map');
  if (hp) {
    await act.tapAt(hp.x, hp.y);
    check((await text(page, V('request') + ' .psg-hint-name')) === want.name, 'tapped drop point becomes the suggested pickup', await text(page, V('request') + ' .psg-hint-name'));
    check((await text(page, V('request') + ' .psg-hint-row')).includes(await page.evaluate((p) => window.SRO.core.format.mgrs(p.lat, p.lon, 5), want)), 'suggested pickup shown with its MGRS');
    check(!(await visible(page, V('request') + ' .psg-map-hint-pick')), 'hint map closes after the choice');
  }
  await act.tap(V('request') + ' .psg-submit');
  const r2 = await text(page, V('request') + ' .psg-done-rid');
  check(await visible(page, V('request') + ' .psg-done .badge-urgency.urg-immediate'), 'confirmation shows the Immediate badge');
  check((await text(page, V('request') + ' .psg-done')).includes('Sent as IMMEDIATE'), 'confirmation says sent as IMMEDIATE');
  R = await reqById(page, r2);
  check(R && R.urgency === 'Immediate' && R.urgencyRequested === 'Urgent' && R.hoursLeftReported === 9 && R.deadline === 900, 'stored as Immediate, 9 h reported, deadline 1500', R && [R.urgency, R.urgencyRequested, R.hoursLeftReported, R.deadline]);
  check(R && R.lines[0].onHand === 900, 'on hand stored on the line');
  if (want) check(R && R.desiredPickup && R.desiredPickup.gridId === want.id, 'desired pickup stored as a hint', R && R.desiredPickup);

  // under 24 h on hand: Immediate without the question
  await act.tap(V('request') + ' .psg-new');
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  await act.tap('.modal [data-action="add-item"]');
  await act.tap(V('request') + ' .psg-choice[data-urgency="Urgent"]');
  await act.type(V('request') + ' .psg-onhand-row[data-line="0"] input', '100');
  await page.waitForTimeout(450);
  await settle(page);
  check(!(await visible(page, '#psg-runout')), 'on hand under 24 h: no run-out question');
  check((await text(page, V('request') + ' .psg-immediate')).includes('you run out in about 8 hours'), 'on hand 100 gal: IMMEDIATE, about 8 hours', await text(page, V('request') + ' .psg-immediate'));
  await act.tap(V('request') + ' .psg-choice[data-urgency="Routine"]');
  check(!(await visible(page, V('request') + ' .psg-onhand-row')), 'Routine hides the on-hand rows');

  // ---- 5. validation ---------------------------------------------------------------------------------------
  // remove the only item -> "Add at least one item"; Undo brings it back
  await act.tap(V('request') + ' .psg-line-remove');
  check(await count(page, V('request') + ' .psg-cart .psg-line') === 0, 'item removed');
  check(await visible(page, '.toast .toast-action'), 'remove shows a toast with Undo');
  const before5 = (await S(page)).requests.length;
  await act.tap(V('request') + ' .psg-submit');
  check((await text(page, V('request') + ' .psg-errors')).includes('Add at least one item.'), 'no items: error in the footer');
  check((await text(page, V('request') + ' [data-sec="supplies"]')).includes('Add at least one item: tap a class above.'), 'no items: inline error under the tiles');
  check((await S(page)).requests.length === before5, 'no items: nothing submitted');
  await shots(page, tag, '09-errors', { themes: ['dark', 'night'], keepToasts: true });
  await act.tap('.toast .toast-action');
  check(await count(page, V('request') + ' .psg-cart .psg-line') === 1, 'Undo restores the item');
  // direct without a reason
  await act.tap(V('request') + ' .psg-choices[data-name="pickup"] .psg-choice[data-value="direct"]');
  check(await visible(page, V('request') + ' .psg-reasons'), 'direct delivery asks why');
  await act.tap(V('request') + ' .psg-submit');
  check((await text(page, V('request') + ' .psg-errors')).includes('Pick why you need direct delivery.'), 'direct without a reason: error');
  check(await page.locator(V('request') + ' .psg-direct-reason.is-invalid').count() === 1, 'reason field marked invalid');
  await act.tap(V('request') + ' .psg-reasons .chip[data-reason="in-contact"]');
  check(!(await text(page, V('request') + ' .psg-footer')).includes('Pick why'), 'reason picked: error gone');
  await act.tap(V('request') + ' .psg-choices[data-name="pickup"] .psg-choice[data-value="drop"]');
  // fixed in place for this request -> direct, no pickup choice
  await act.tap(V('request') + ' .psg-seg[data-name="mobility"] button[data-value="fixed"]');
  check(await visible(page, V('request') + ' .psg-fixed-note') && !(await visible(page, V('request') + ' .psg-choices[data-name="pickup"]')), 'Fixed in place: delivered direct, no pickup choice');
  check((await text(page, V('request') + ' [data-sec="delivery"] .field-label')).includes('(this request only)'), 'mobility override marked as this request only');
  await act.tap(V('request') + ' .psg-seg[data-name="mobility"] button[data-value="mounted"]');
  check(await visible(page, V('request') + ' .psg-choices[data-name="pickup"]'), 'Mounted again: pickup choice back');
  // NLT in the past (Other time, 0500 today)
  await act.tap(V('request') + ' .psg-nlt-other');
  check(await visible(page, V('request') + ' .psg-nlt-hour'), 'Other time shows 24 h selects');
  await page.selectOption(V('request') + ' .psg-nlt-hour', '5');
  await settle(page);
  check(await page.locator(V('request') + ' [data-sec="when"].is-invalid').count() === 1, 'NLT in the past: section marked at once');
  check((await text(page, V('request') + ' [data-sec="when"]')).includes('The NLT time has already passed.'), 'NLT in the past: error text');
  check((await text(page, V('request') + ' .psg-nlt-rel')) === 'already passed', 'NLT line says already passed');
  // NLT 0630: sooner than the nearest hub can reach (warning)
  await page.selectOption(V('request') + ' .psg-nlt-hour', '6');
  await page.selectOption(V('request') + ' .psg-nlt-min', '30');
  await settle(page);
  check(await page.locator(V('request') + ' [data-sec="when"].is-invalid').count() === 0, 'NLT 0630 is not an error');
  check((await text(page, V('request') + ' [data-sec="when"]')).includes('The nearest hub needs about'), 'NLT sooner than hub reach: warning', await text(page, V('request') + ' [data-sec="when"] .field-warn'));
  // over 5x daily use (1600 gal of diesel, typical 300)
  await act.tap(V('request') + ' .psg-cart .psg-line-main');
  check(await visible(page, '.modal .psg-item-sheet'), 'tapping a cart line reopens its sheet');
  await act.type('.modal .psg-qty-row input', '1600');
  check((await text(page, '.modal .psg-item-sheet')).includes('More than 5 times what a platoon typically uses in a day'), 'over 5x: live warning in the sheet');
  await act.tap('.modal [data-action="add-item"]');
  check(await page.locator(V('request') + ' .psg-line.is-warning').count() === 1, 'cart line marked with a warning');
  const before6 = (await S(page)).requests.length;
  await act.tap(V('request') + ' .psg-submit');
  check(await visible(page, '.modal .psg-warn-list'), 'warnings: "Check before sending" sheet');
  const wl = await text(page, '.modal .psg-warn-list');
  check(wl.includes('more than 5 times') && wl.includes('nearest hub needs about'), 'sheet lists both warnings', wl);
  check(wl.includes('JP-8: 1,600 gal is more than 5 times') && wl.includes('(300 gal)'), 'over-5x warning names the line as the cart does and gives units', wl);
  await shots(page, tag, '10-warnings', { themes: ['dark', 'light'] });
  await act.tap('.modal [data-action="warn-back"]');
  check(!(await visible(page, '.modal')) && (await S(page)).requests.length === before6, 'Go back: nothing submitted');
  await act.tap(V('request') + ' .psg-nlt-chips .chip[data-nlt="1080"]');
  check(!(await visible(page, V('request') + ' .psg-nlt-selects')), 'quick NLT chip hides the selects');
  // each PSG tab keeps its own scroll position (they share one scroll container)
  const yForm = await bodyScroll(page);
  await showTab(page, act, 'myrequests');
  check(await inView(page, V('myrequests') + ' .psg-head'), 'My requests opens at its own top, not at the form\'s scroll position', [yForm, await bodyScroll(page)]);
  await showTab(page, act, 'request');
  const yBack = await bodyScroll(page);
  check(yForm > 50 && Math.abs(yBack - yForm) <= 2, 'back on New request: the form is where it was left', [yForm, yBack]);
  await act.tap(V('request') + ' .psg-submit');
  check(!(await text(page, '.modal .psg-warn-list')).includes('nearest hub'), 'only the over-5x warning left');
  await act.tap('.modal [data-action="warn-send"]');
  await page.waitForTimeout(50);
  await settle(page);
  const r3 = await text(page, V('request') + ' .psg-done-rid');
  R = await reqById(page, r3);
  check(R && R.lines[0].qty === 1600 && R.status === 'submitted', 'Send anyway submits the request', R && R.lines);
  await act.tap(V('request') + ' .psg-view-mine');
  check((await S(page)).tab === 'myrequests' && await inView(page, V('myrequests') + ' .psg-req[data-id="' + r3 + '"]'), '"View my requests" opens on the request just sent', await bodyScroll(page));

  // ---- 6. Unit tab: summary, mobility, Update my location --------------------------------------------------
  await showTab(page, act, 'profile');
  check((await text(page, V('profile') + ' .psg-unit-card')).includes(unitName) && (await text(page, V('profile') + ' .psg-unit-card')).includes(desig), 'Unit summary: name and designator');
  check((await text(page, V('profile') + ' .psg-unit-card .psg-mgrs')) === geoWant, 'Unit summary: MGRS');
  await shots(page, tag, '11-unit');
  await act.tap(V('profile') + ' .psg-choice[data-value="dismounted"]');
  check((await S(page)).profile.mobility === 'dismounted', 'mobility change saved (profile/save)');
  await act.tap(V('profile') + ' .psg-choice[data-value="mounted"]');
  check((await S(page)).profile.mobility === 'mounted', 'mobility back to mounted');
  await act.tap(V('profile') + ' .psg-update-loc');
  check(await visible(page, '.modal .psg-map-sheet'), '"Update my location" sheet with a map');
  await page.waitForTimeout(250);
  const p2 = await mapPoint(page, '.modal .psg-map-sheet', { lat: 25.02, lon: 121.40 });
  check(!!p2, 'found a point on the location sheet map');
  if (p2) {
    await act.tapAt(p2.x, p2.y);
    await shots(page, tag, '12-location-sheet', { themes: ['dark', 'night'], skipTargets: false });
    await act.tap('.modal [data-action="save-location"]');
    s = await S(page);
    check(Math.abs(s.profile.lat - p2.lat) < 0.01 && Math.abs(s.profile.lon - p2.lon) < 0.01, 'new location saved', [s.profile.lat, s.profile.lon, p2]);
    check((await text(page, V('profile') + ' .psg-unit-card .psg-mgrs')) !== geoWant, 'summary shows the new grid');
  }

  // edit the unit later (first open only; editable after)
  await act.tap(V('profile') + ' .psg-edit-unit');
  check(await visible(page, V('profile') + ' .psg-profile-form[data-mode="edit"]'), 'Edit unit opens the form filled in');
  check((await page.inputValue(V('profile') + ' .psg-bn')) === '4-93' && (await page.getAttribute(V('profile') + ' .psg-seg[data-name="plt"] button[data-value="2"]', 'aria-pressed')) === 'true', 'edit form loaded from the profile');
  await act.tap(V('profile') + ' .psg-seg[data-name="plt"] button[data-value="3"]');
  await act.tap(V('profile') + ' .psg-save-profile');
  s = await S(page);
  check(s.profile.unitName === '3rd PLT, B CO, 4-93 IN' && s.profile.designator === await page.evaluate(() => window.SRO.data.scenario.designatorFor('3rd PLT, B CO, 4-93 IN')), 'edited unit saved', s.profile.unitName);
  check((await text(page, V('profile') + ' .psg-unit-card')).includes('3rd PLT, B CO, 4-93 IN'), 'summary shows the edited unit');

  // ---- 7. My requests: cards, edit, cancel ------------------------------------------------------------------
  // a Class I water request for the deferred case, sent through the store as the form would
  const r4 = await page.evaluate(() => {
    const st = window.SRO.app.store.getState();
    const p = st.profile;
    const res = window.SRO.app.store.dispatch({ type: 'request/submit', now: st.clock.simMin, request: {
      unitName: p.unitName, designator: p.designator, lat: p.lat, lon: p.lon, gridId: p.gridId, mobility: 'mounted', maxTravelMi: 50,
      directOnly: false, lines: [{ classId: 'I', itemId: 'water-bottled', option: '1.5L', qty: 24, unit: 'case', onHand: null }],
      urgencyRequested: 'Priority', nlt: 1080, remarks: 'Gate on the east side.' } });
    return res.id;
  });
  await showTab(page, act, 'myrequests');
  check(await count(page, V('myrequests') + ' .psg-req') === 4, 'four request cards');
  const c1 = V('myrequests') + ' .psg-req[data-id="' + r1 + '"]';
  check((await text(page, c1 + ' .psg-req-head')).includes('Submitted') && (await text(page, c1 + ' .psg-req-head')).includes('Routine'), 'card: status and urgency badges');
  check((await text(page, c1 + ' .psg-req-lines')).includes('500 gal') && (await text(page, c1 + ' .psg-req-lines')).includes('JP-8'), 'card: lines');
  check((await text(page, c1 + ' .psg-status-note')).includes('Waiting for the next plan at 1200'), 'card: waiting for the 1200 plan');
  check(await visible(page, c1 + ' .psg-edit') && await visible(page, c1 + ' .psg-cancel'), 'card: Edit and Cancel before approval');
  check((await text(page, V('myrequests') + ' .psg-req[data-id="' + r2 + '"] .psg-req-head')).includes('Immediate'), 'Immediate card badge');
  const badge = await text(page, '#psg-root .tabbar-item[data-tab="myrequests"] .tab-badge');
  check(badge === '4', 'tab badge counts open requests', badge);
  await shots(page, tag, '13-mine-submitted');
  // edit R1: NLT 2100
  await act.tap(c1 + ' .psg-edit');
  check((await S(page)).tab === 'request' && (await text(page, V('request') + ' .psg-title')).includes('Edit ' + r1), 'Edit opens the form with the request');
  check(await count(page, V('request') + ' .psg-cart .psg-line') === 1 && (await page.getAttribute(V('request') + ' .psg-nlt-chips .chip[data-nlt="1080"]', 'aria-checked')) === 'true', 'form loaded with the line and NLT');
  check((await text(page, V('request') + ' .psg-submit')).includes('Save changes'), 'submit button says Save changes');
  await act.tap(V('request') + ' .psg-nlt-chips .chip[data-nlt="1260"]');
  await act.tap(V('request') + ' .psg-submit');
  check((await S(page)).tab === 'myrequests', 'after saving, back to My requests');
  R = await reqById(page, r1);
  check(R && R.nlt === 1260 && R.status === 'submitted', 'request/edit changed the NLT to 2100', R && R.nlt);
  check((await text(page, c1 + ' .psg-req-meta')).includes('NLT 2100'), 'card shows the new NLT');
  // cancel R3
  const c3 = V('myrequests') + ' .psg-req[data-id="' + r3 + '"]';
  await act.tap(c3 + ' .psg-cancel');
  check(await visible(page, '.modal .btn-danger'), 'cancel asks to confirm');
  await act.tap('.modal .btn-danger');
  R = await reqById(page, r3);
  check(R && R.status === 'cancelled', 'request/cancel cancelled it');
  check((await text(page, c3 + ' .psg-req-head')).includes('Cancelled') && !(await visible(page, c3 + ' .psg-edit')), 'cancelled card: badge, no Edit');
  check((await text(page, V('myrequests') + ' .psg-req-list')).toLowerCase().includes('done'), 'cancelled card moved under Done');

  // ---- 8. injected approved plan: pickup, ETA, truck, live movement --------------------------------------------
  // a draft (unapproved) plan first: the card says so and the request can still be edited
  await page.evaluate(({ r1 }) => {
    const g = window.SRO.data.grid.find((x) => x.rallyCandidate);
    window.SRO.app.store.dispatch({ type: 'plan/store', plan: { id: 'P-DRAFT', name: 'Draft', createdAt: 361, routes: [{ truckId: 'Alpha-1', depart: 400, returnAt: 500,
      stops: [{ seq: 1, kind: 'rally', gridId: g.id, lat: g.lat, lon: g.lon, label: 'A', arrive: 450, depart: 460, deliveries: [{ requestId: r1, lineIdx: 0, qty: 500, unit: 'gal', classId: 'III' }] }], legs: [] }], deferred: [] } });
  }, { r1 });
  await settle(page);
  check((await reqById(page, r1)).status === 'planned', 'draft plan stored: R1 planned');
  check((await text(page, c1 + ' .psg-req-head')).includes('Planned') && (await text(page, c1 + ' .psg-status-note')).includes('In a draft plan the planner is reviewing.'), 'planned card says it is in a draft plan');
  check(await visible(page, c1 + ' .psg-edit'), 'planned request can still be edited');
  // approved while the app shows the planner role (the PSG column hidden), as on a shared demo device
  await page.click('#topbar .tb-role button[data-role="planner"]');
  await settle(page);
  const plan = await page.evaluate(({ r1, r2, r4 }) => {
    const SRO = window.SRO;
    const st = SRO.app.store.getState();
    const geo = SRO.core.geo, roads = SRO.core.roads;
    const truck = st.scenario.fleet.find((t) => t.id === 'Alpha-1');
    const hub = st.scenario.hubs.find((h) => h.id === truck.hubId);
    const req1 = st.requests.find((r) => r.id === r1);
    const cands = SRO.data.grid.filter((g) => g.rallyCandidate).map((g) => ({ g, d: geo.haversineMi(req1, g) })).sort((a, b) => a.d - b.d);
    const stopB = cands[0].g;   // R1 picks up here (nearest drop point)
    const stopA = cands.find((c) => c.g.id !== stopB.id && geo.haversineMi(c.g, stopB) > 2).g;   // R2 first
    const pts = [hub, stopA, stopB, hub];
    const legs = [];
    const stops = [];
    let t = 390;   // departs 0630
    const SERVICE = 20;
    for (let i = 0; i + 1 < pts.length; i++) {
      const rt = roads.route({ lat: pts[i].lat, lon: pts[i].lon }, { lat: pts[i + 1].lat, lon: pts[i + 1].lon }, {});
      const mins = Math.max(8, Math.round(rt.minutes * 1.5));
      legs.push({ fromKey: i === 0 ? hub.id : pts[i].id, toKey: pts[i + 1].id, depart: t, arrive: t + mins, miles: Math.round(rt.miles * 10) / 10, riskUnits: 0, path: geo.encodePolyline(rt.coords) });
      t += mins;
      if (i < 2) {
        const g = pts[i + 1];
        const reqId = i === 0 ? r2 : r1;
        const rq = st.requests.find((r) => r.id === reqId);
        stops.push({ seq: i + 1, nodeKey: g.id, kind: 'rally', gridId: g.id, lat: g.lat, lon: g.lon, label: i === 0 ? 'A' : 'B', arrive: t, depart: t + SERVICE,
          deliveries: [{ requestId: reqId, lineIdx: 0, qty: rq.lines[0].qty, unit: rq.lines[0].unit, classId: rq.lines[0].classId }], pickups: [{ requestId: reqId, platoonMiles: 3 }] });
        t += SERVICE;
      }
    }
    const route = { truckId: truck.id, type: truck.type, color: truck.color, loadStart: 370, depart: 390, returnAt: t, stops, legs, miles: legs.reduce((a, l) => a + l.miles, 0), gallons: 40, riskUnits: 0 };
    const byRequest = {};
    stops.forEach((s, i) => {
      const id = s.deliveries[0].requestId;
      byRequest[id] = { truckId: truck.id, stopSeq: s.seq, nodeKind: 'rally', gridId: s.gridId, lat: s.lat, lon: s.lon, label: s.label, eta: s.arrive, qtyByLine: [s.deliveries[0].qty], deferredQty: 0, stopsBefore: i };
    });
    const p = { id: 'P-TEST1', name: 'Test plan', method: 'manual', createdAt: 362, parentPlanId: null, rallyPoints: [stopA.id, stopB.id], routes: [route],
      deferred: [{ requestId: r4, lineIdx: 0, qty: 24, unit: 'case', group: 'cargo', reason: 'capacity', detail: 'trucks-full', note: 'Every cargo truck that could carry it is full (10 of 10 pallets loaded).' }], late: [], byRequest };
    const a = SRO.app.store.dispatch({ type: 'plan/store', plan: p, now: 362 });
    const b = SRO.app.store.dispatch({ type: 'plan/approve', planId: 'P-TEST1', now: 362 });
    return { ok: a.ok && b.ok, err: a.error || b.error, truck: { id: truck.id, freq: truck.freq, color: truck.color }, stopB: { id: stopB.id, name: stopB.name, lat: stopB.lat, lon: stopB.lon }, stops: stops.map((s) => ({ arrive: s.arrive, depart: s.depart })), legs: legs.map((l) => ({ depart: l.depart, arrive: l.arrive })), returnAt: t, plan: p };
  }, { r1, r2, r4 });
  check(plan.ok, 'injected plan stored and approved', plan.err);
  await settle(page);
  await page.click('#topbar .tb-role button[data-role="psg"]');
  await settle(page);
  await page.waitForTimeout(300);
  const fit = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const m = host && host.__sroMap;
    if (!m) return null;
    const L = m.leaflet;
    let tr = null;
    L.eachLayer((l) => { if (l.options && l.options.pane === 'sro-trucks' && l.getLatLng) tr = l.getLatLng(); });
    return { zoom: L.getZoom(), size: L.getSize(), truckInView: !!tr && L.getBounds().contains(tr) };
  }, V('myrequests') + ' .psg-req[data-id="' + r1 + '"] .psg-map-track');
  check(fit && fit.size.x > 0 && fit.zoom >= 9 && fit.truckInView, 'map built while hidden is fitted to the route once shown', fit);
  R = await reqById(page, r1);
  check(R && R.status === 'approved' && R.eta === plan.stops[1].arrive, 'plan/approve: R1 approved with its ETA', R && [R.status, R.eta]);
  const fmt = await page.evaluate(({ p, eta }) => ({ mgrs: window.SRO.core.format.mgrs(p.lat, p.lon, 5), eta: window.SRO.core.format.time24(eta), name: window.SRO.ui.psg.placeName(p) }), { p: plan.stopB, eta: plan.stops[1].arrive });
  const card = await text(page, c1);
  check((await text(page, c1 + ' .psg-req-head')).includes('Approved'), 'card: Approved badge');
  check((await text(page, c1 + ' .psg-pickup-name')).includes(fmt.name), 'card: pickup point name (' + fmt.name + ')', await text(page, c1 + ' .psg-pickup-name'));
  check((await text(page, c1 + ' .psg-pickup-grid')) === fmt.mgrs, 'card: pickup MGRS', await text(page, c1 + ' .psg-pickup-grid'));
  check((await text(page, c1 + ' .psg-eta-time')) === fmt.eta, 'card: ETA ' + fmt.eta, await text(page, c1 + ' .psg-eta-time'));
  check((await text(page, c1 + ' .psg-truck-chip')) === plan.truck.id, 'card: truck callsign ' + plan.truck.id);
  check((await text(page, c1 + ' .psg-freq')).includes(plan.truck.freq), 'card: frequency ' + plan.truck.freq);
  const chipColor = await page.evaluate((sel) => document.querySelector(sel).style.getPropertyValue('--truck'), c1 + ' .psg-truck-chip');
  check(chipColor.toLowerCase() === plan.truck.color.toLowerCase(), 'card: truck color chip', chipColor);
  check((await text(page, c1 + ' .psg-stops-before')).includes('1 stop before yours'), 'card: "1 stop before yours"');
  check((await text(page, c1 + ' .psg-live')).includes('loads at FOB Granite and departs 0630'), 'live line before departure', await text(page, c1 + ' .psg-live'));
  check(card.includes('Drive') && card.includes('from you'), 'card: drive distance to the pickup');
  check(!(await visible(page, c1 + ' .psg-edit')) && await visible(page, c1 + ' .psg-locked'), 'approved card: no Edit / Cancel');
  const c4 = V('myrequests') + ' .psg-req[data-id="' + r4 + '"]';
  check((await text(page, c4 + ' .psg-delayed')).includes('Not in this window - next plan at 1200.'), 'deferred card: "Not in this window - next plan at 1200"', await text(page, c4 + ' .psg-delayed'));
  check((await text(page, c4 + ' .psg-why')).includes('All trucks were full this window.'), 'deferred card: the reason in plain words');
  check(!(await text(page, c4 + ' .psg-why')).includes('loaded'), 'deferred card: the solver\'s planner note is not shown', await text(page, c4 + ' .psg-why'));
  const why = await page.evaluate(() => {
    const f = window.SRO.ui.psg.deferWhy;
    return f ? { cost: f({ reason: 'capacity', detail: 'cost' }), rally: f({ reason: 'capacity', detail: 'rally-limit' }), full: f({ reason: 'capacity', detail: 'trucks-full' }),
      tanker: f({ reason: 'no-truck', detail: 'no-vehicle-type', group: 'fuel' }), time: f({ reason: 'time' }), none: f(null) } : null;
  });
  check(why && !/full/.test(why.cost) && !/full/.test(why.rally) && /full/.test(why.full) && /fuel tanker/.test(why.tanker) && /in time/.test(why.time) && !!why.none,
    'deferred reasons follow reason + detail (capacity / cost is not "trucks full")', why);
  check(await page.locator('#psg-root .tabbar-item[data-tab="myrequests"] .tab-badge.is-alert').count() === 1, 'tab badge turns to alert with a delayed request');
  check(await count(page, c1 + ' .psg-map-track.leaflet-container') === 1, 'card: compact tracking map');
  // map content: route, pickup point, platoon, walk/drive line, truck
  const truckAt = (sel) => page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const m = host && host.__sroMap;
    if (!m) return null;
    let mk = null;
    m.leaflet.eachLayer((l) => { if (l.options && l.options.pane === 'sro-trucks' && l.getLatLng) mk = l; });
    if (!mk) return null;
    const ll = mk.getLatLng();
    const el = mk.getElement();
    const r = el ? el.getBoundingClientRect() : null;
    return { lat: ll.lat, lon: ll.lng, x: r ? r.left + r.width / 2 : null, y: r ? r.top + r.height / 2 : null };
  }, sel);
  const mapCounts = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const panes = (n) => host.querySelectorAll('.leaflet-' + n + '-pane > *, .leaflet-' + n + '-pane path').length;
    return { routes: host.querySelectorAll('.leaflet-sro-routes-pane path').length, markers: host.querySelectorAll('.leaflet-marker-icon').length, panes: [...host.querySelectorAll('.leaflet-pane')].map((p) => p.className.replace('leaflet-pane ', '')).join(' ') };
  }, c1 + ' .psg-map-track');
  check(mapCounts.routes >= 2, 'map draws the route and the drive line', mapCounts);
  check(mapCounts.markers >= 4, 'map shows hub, pickup, platoon and truck markers', mapCounts);
  const posAt = (sim) => page.evaluate(({ legs, sim, plan }) => {
    const G = window.SRO.core.geo;
    const L = plan.routes[0].legs.map((l) => ({ coords: G.decodePolyline(l.path), depart: l.depart, arrive: l.arrive }));
    return window.SRO.ui.map.truckPosition({ legs: L }, sim);
  }, { legs: plan.legs, sim, plan: plan.plan });
  const tick = async (sim) => { await page.evaluate((v) => window.SRO.app.store.dispatch({ type: 'clock/tick', simMin: v }), sim); await settle(page); };
  let tp0 = await truckAt(c1 + ' .psg-map-track');
  let exp = await posAt(370);
  check(tp0 && Math.abs(tp0.lat - exp.lat) < 1e-4 && Math.abs(tp0.lon - exp.lon) < 1e-4, 'truck marker waits at the hub before departure', [tp0, exp]);
  await shots(page, tag, '14-mine-approved', { before: async () => { await page.locator(c1).scrollIntoViewIfNeeded(); } });
  // depart + 10 min: en route, moving on leg 1
  const tA = plan.legs[0].depart + Math.round((plan.legs[0].arrive - plan.legs[0].depart) / 2);
  await tick(tA);
  R = await reqById(page, r1);
  check(R.status === 'en_route', 'clock past departure: R1 en route');
  check((await text(page, c1 + ' .psg-req-head')).includes('En route'), 'card shows En route');
  const tp1 = await truckAt(c1 + ' .psg-map-track');
  exp = await posAt(tA);
  check(tp1 && Math.abs(tp1.lat - exp.lat) < 1e-4 && Math.abs(tp1.lon - exp.lon) < 1e-4, 'truck marker on its road route at ' + tA + ' (truckPosition)', [tp1, exp]);
  check(tp1 && tp0 && (Math.abs(tp1.lat - tp0.lat) + Math.abs(tp1.lon - tp0.lon)) > 1e-3, 'truck marker moved as the clock advanced');
  check((await text(page, c1 + ' .psg-live')).includes('1 stop before yours'), 'live line: 1 stop before yours', await text(page, c1 + ' .psg-live'));
  const bar1 = await page.evaluate((sel) => parseFloat(document.querySelector(sel).style.width), c1 + ' .psg-progress .progress-bar');
  // at stop A
  await tick(plan.stops[0].arrive + 5);
  check((await text(page, c1 + ' .psg-live')).includes('is at stop 1; yours is next.'), 'live line: at stop 1, yours is next', await text(page, c1 + ' .psg-live'));
  check((await reqById(page, r2)).status === 'delivered', 'R2 delivered at stop 1');
  // halfway on leg 2 (to R1's pickup)
  const tB = plan.legs[1].depart + Math.round((plan.legs[1].arrive - plan.legs[1].depart) / 2);
  await tick(tB);
  const tp2 = await truckAt(c1 + ' .psg-map-track');
  exp = await posAt(tB);
  check(tp2 && Math.abs(tp2.lat - exp.lat) < 1e-4 && Math.abs(tp2.lon - exp.lon) < 1e-4, 'truck marker follows leg 2 at ' + tB, [tp2, exp]);
  check(tp2 && tp1 && (Math.abs(tp2.lat - tp1.lat) + Math.abs(tp2.lon - tp1.lon)) > 1e-3, 'truck marker moved again');
  check((await text(page, c1 + ' .psg-live')).includes('is on the way to you'), 'live line: on the way to you', await text(page, c1 + ' .psg-live'));
  const bar2 = await page.evaluate((sel) => parseFloat(document.querySelector(sel).style.width), c1 + ' .psg-progress .progress-bar');
  check(bar2 > bar1, 'progress bar advanced', [bar1, bar2]);
  nums.truckMoves = { atHub: tp0 && [+tp0.lat.toFixed(5), +tp0.lon.toFixed(5)], leg1: tp1 && [+tp1.lat.toFixed(5), +tp1.lon.toFixed(5)], leg2: tp2 && [+tp2.lat.toFixed(5), +tp2.lon.toFixed(5)] };
  await shots(page, tag, '15-mine-en-route', { before: async () => { await page.locator(c1).scrollIntoViewIfNeeded(); } });
  // contingency re-plan: R1's ETA moves 25 min later -> "Updated"
  const etaNew = await page.evaluate(({ p, r1 }) => {
    const q = JSON.parse(JSON.stringify(p));
    q.id = 'P-TEST2'; q.parentPlanId = 'P-TEST1'; q.name = 'Test re-plan'; q.createdAt = window.SRO.app.store.getState().clock.simMin;
    const rt = q.routes[0];
    rt.stops[1].arrive += 25; rt.stops[1].depart += 25; rt.legs[1].arrive += 25; rt.legs[2].depart += 25; rt.legs[2].arrive += 25; rt.returnAt += 25;
    q.byRequest[r1].eta += 25;
    const S = window.SRO.app.store;
    const a = S.dispatch({ type: 'plan/store', plan: q });
    const b = S.dispatch({ type: 'plan/approve', planId: 'P-TEST2' });
    return a.ok && b.ok ? rt.stops[1].arrive : null;
  }, { p: plan.plan, r1 });
  await settle(page);
  R = await reqById(page, r1);
  check(R && R.updated === true && R.eta === etaNew, 're-plan approved: R1 updated with the new ETA', R && [R.updated, R.eta, etaNew]);
  check(await visible(page, c1 + ' .psg-updated'), 'card: "Updated" badge');
  const etaTxt = await page.evaluate((v) => window.SRO.core.format.time24(v), etaNew);
  check((await text(page, c1 + ' .psg-eta-time')) === etaTxt, 'card shows the new ETA ' + etaTxt);
  check(await count(page, c1 + ' .psg-map-track.leaflet-container') === 1, 'map still shown after the re-plan');
  await shots(page, tag, '16-mine-updated', { before: async () => { await page.locator(c1).scrollIntoViewIfNeeded(); } });
  await shots(page, tag, '17-mine-delayed', { themes: ['dark'], before: async () => { await page.locator(c4).scrollIntoViewIfNeeded(); } });
  // delivered
  await tick(etaNew + 1);
  R = await reqById(page, r1);
  check(R.status === 'delivered', 'clock past the ETA: delivered');
  check((await text(page, c1 + ' .psg-delivered')).includes('Delivered at ' + etaTxt), 'card: Delivered at ' + etaTxt, await text(page, c1 + ' .psg-delivered'));

  // ---- wrap up --------------------------------------------------------------------------------------------
  nums.runSec = Math.round((Date.now() - t0) / 1000);
  check(!errors.length, 'no console errors (' + tiles() + ' blocked-tile messages ignored)', errors.slice(0, 6));
  check(!blocked.length, 'no network requests other than map tiles', blocked.slice(0, 4));
  await context.close();
}

// geolocation: outside Taiwan and permission denied (phone)
async function geoCases(browser, fileUrl) {
  scope = 'geolocation';
  console.log('\n== geolocation edge cases (390x844)');
  const vp = { width: 390, height: 844, touch: true };
  {
    const { context, page, errors } = await openApp(browser, fileUrl, vp, { geo: OUTSIDE });
    const act = actor(page, vp);
    await act.tap(V('request') + ' .psg-geo-btn');
    await page.waitForFunction((sel) => { const e = document.querySelector(sel); return e && e.textContent.trim().length > 0; }, V('request') + ' .psg-loc-msg');
    const msg = await text(page, V('request') + ' .psg-loc-msg');
    check(msg.includes('outside Taiwan') && msg.includes('tap the map'), 'device outside Taiwan: explained, not used', msg);
    check(!(await visible(page, V('request') + ' .psg-loc-readout .psg-mgrs')), 'no location set from outside Taiwan');
    await page.screenshot({ path: path.join(SHOTS, '390x844-geo-outside-dark.png') });
    check(!errors.length, 'no console errors (outside)', errors);
    await context.close();
  }
  {
    const init = () => {
      const deny = (ok, fail) => setTimeout(() => fail({ code: 1, message: 'User denied Geolocation' }), 20);
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: deny, watchPosition: () => 0, clearWatch: () => {} } });
    };
    const { context, page, errors } = await openApp(browser, fileUrl, vp, { init });
    const act = actor(page, vp);
    await act.tap(V('request') + ' .psg-geo-btn');
    await page.waitForFunction((sel) => { const e = document.querySelector(sel); return e && e.textContent.trim().length > 0; }, V('request') + ' .psg-loc-msg');
    const msg = await text(page, V('request') + ' .psg-loc-msg');
    check(msg.includes('Location permission is off'), 'permission denied: plain message', msg);
    check(!(await page.locator(V('request') + ' .psg-geo-btn').isDisabled()), 'button usable again after a failure');
    check(!errors.length, 'no console errors (denied)', errors);
    await context.close();
  }
  {
    const init = () => { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined }); };
    const { context, page, errors } = await openApp(browser, fileUrl, vp, { init });
    const act = actor(page, vp);
    await act.tap(V('request') + ' .psg-geo-btn');
    const msg = await text(page, V('request') + ' .psg-loc-msg');
    check(msg.includes('cannot share its location'), 'no geolocation API: plain message', msg);
    check(!errors.length, 'no console errors (no API)', errors);
    await context.close();
  }
}

// a unit profile saved through the store (what the setup form dispatches)
async function quickProfile(page) {
  return page.evaluate((g) => {
    const SRO = window.SRO;
    const name = '1st PLT, A CO, 2-5 IN';
    const pl = SRO.ui.psg.place(g.latitude, g.longitude);
    SRO.app.store.dispatch({ type: 'profile/save', profile: { unitName: name, designator: SRO.data.scenario.designatorFor(name), lat: g.latitude, lon: g.longitude, gridId: pl && pl.gridId, mobility: 'mounted' } });
    return SRO.app.store.getState().profile;
  }, INSIDE);
}

// Editing an IMMEDIATE request: only the NLT changed -> the run-out deadline stays where it was; a new
// on-hand count -> reported again now. Then a delivery split over two trucks with a remainder carried
// to the next window (partial).
async function editAndSplitCases(browser, fileUrl) {
  scope = 'edit + split (390x844)';
  console.log('\n== edit an IMMEDIATE request, split delivery (390x844)');
  const vp = { width: 390, height: 844, touch: true };
  const { context, page, errors, blocked } = await openApp(browser, fileUrl, vp);
  const act = actor(page, vp);
  await quickProfile(page);
  await settle(page);
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  await act.tap('.modal [data-action="add-item"]');
  await act.tap(V('request') + ' .psg-choice[data-urgency="Urgent"]');
  await act.type(V('request') + ' .psg-onhand-row[data-line="0"] input', '900');
  await page.waitForTimeout(450);
  await settle(page);
  await act.type('#psg-runout', '9');
  // pickup-hint map: a tap on the platoon's own symbol (it covers the drop points next to it) picks the
  // nearest drop point instead of doing nothing
  await act.tap(V('request') + ' .psg-hint-open');
  await page.waitForTimeout(250);
  const nearest = await page.evaluate((g) => {
    const SRO = window.SRO, st = SRO.app.store.getState();
    const c = SRO.data.grid.filter((x) => x.rallyCandidate && !(st.scenario.rally.banned || []).includes(x.id));
    const n = SRO.core.geo.nearestGrid({ lat: g.latitude, lon: g.longitude }, c);
    return { id: n.id, name: SRO.ui.psg.placeName(n) };
  }, INSIDE);
  const me = await mapPoint(page, V('request') + ' .psg-map-hint-pick', { lat: INSIDE.latitude, lon: INSIDE.longitude });
  check(!!me, 'platoon visible on the hint map');
  if (me) {
    await act.tapAt(me.x, me.y);
    check((await text(page, V('request') + ' .psg-hint-name')) === nearest.name, 'tap on the platoon symbol picks the nearest drop point (' + nearest.name + ')', await text(page, V('request') + ' .psg-hint-name'));
  }
  // reopen the map and send with it open: the form gives way to the confirmation right away
  await act.tap(V('request') + ' .psg-hint-row button:has-text("Change")');
  check(await visible(page, V('request') + ' .psg-map-hint-pick'), 'Change reopens the hint map');
  await act.tap(V('request') + ' .psg-submit');
  await page.waitForTimeout(300);
  const rid = await text(page, V('request') + ' .psg-done-rid');
  let R = await reqById(page, rid);
  check(R && R.urgency === 'Immediate' && R.deadline === 900, 'Immediate request sent at 0600 runs out at 1500', R && [R.urgency, R.deadline]);
  check(R && R.desiredPickup && R.desiredPickup.gridId === nearest.id, 'suggested pickup stored', R && R.desiredPickup);
  check(!errors.length, 'sending with the hint map open: no console errors', errors.slice(0, 3));
  // an hour later the platoon sergeant moves the NLT only
  await page.evaluate(() => window.SRO.app.store.dispatch({ type: 'clock/tick', simMin: 420 }));
  await settle(page);
  await showTab(page, act, 'myrequests');
  await act.tap(V('myrequests') + ' .psg-req[data-id="' + rid + '"] .psg-edit');
  check(await inView(page, V('request') + ' .psg-head'), 'Edit opens the form at its top');
  const prev1 = await text(page, V('request') + ' .psg-immediate');
  check(prev1.includes('you run out in about 8 hours (1500)') && prev1.includes('Deadline moves up to 1500'), 'edit preview keeps the 1500 run-out (reported at 0600)', prev1);
  await act.tap(V('request') + ' .psg-nlt-chips .chip[data-nlt="1260"]');
  await act.tap(V('request') + ' .psg-submit');
  R = await reqById(page, rid);
  check(R && R.nlt === 1260 && R.urgency === 'Immediate' && R.deadline === 900, 'NLT-only edit: deadline stays 1500 (not pushed to 1600)', R && [R.nlt, R.urgency, R.deadline]);
  check((await S(page)).tab === 'myrequests' && await inView(page, V('myrequests') + ' .psg-req[data-id="' + rid + '"]'), 'after saving, My requests shows the edited card');
  // a new on-hand count is a new report: the 9 hours now count from 0700
  await act.tap(V('myrequests') + ' .psg-req[data-id="' + rid + '"] .psg-edit');
  await act.type(V('request') + ' .psg-onhand-row[data-line="0"] input', '1800');
  await page.waitForTimeout(450);
  await settle(page);
  const prev2 = await text(page, V('request') + ' .psg-immediate');
  check(prev2.includes('(1600)'), 'changed on hand: the run-out counts from now (1600)', prev2);
  await act.tap(V('request') + ' .psg-submit');
  R = await reqById(page, rid);
  check(R && R.deadline === 960 && R.lines[0].onHand === 1800, 'stored deadline matches the preview (1600)', R && [R.deadline, R.lines[0].onHand]);

  // split: 60 cases of MREs, 20 on Alpha-2, 20 on Bravo-2, 20 carried to the next window
  const split = await page.evaluate(() => {
    const SRO = window.SRO, S = SRO.app.store, G = SRO.core.geo;
    const st = S.getState();
    const p = st.profile;
    const res = S.dispatch({ type: 'request/submit', now: st.clock.simMin, request: { unitName: p.unitName, designator: p.designator, lat: p.lat, lon: p.lon, gridId: p.gridId, mobility: 'mounted', maxTravelMi: 50,
      directOnly: false, lines: [{ classId: 'I', itemId: 'mre', option: 'mixed', qty: 60, unit: 'case', onHand: null }], urgencyRequested: 'Routine', nlt: 1080 } });
    const id = res.id;
    const near = SRO.data.grid.filter((g) => g.rallyCandidate).map((g) => ({ g, d: G.haversineMi(p, g) })).sort((a, b) => a.d - b.d);
    const ga = near[0].g, gb = near[1].g;
    const mk = (truckId, g, t0, eta) => {
      const t = st.scenario.fleet.find((x) => x.id === truckId);
      const hub = st.scenario.hubs.find((x) => x.id === t.hubId);
      return { truckId, type: t.type, color: t.color, freq: t.freq, depart: t0, returnAt: eta + 60,
        stops: [{ seq: 1, nodeKey: 'rally:' + g.id, kind: 'rally', gridId: g.id, lat: g.lat, lon: g.lon, label: g.name, arrive: eta, depart: eta + 15,
          deliveries: [{ requestId: id, lineIdx: 0, qty: 20, unit: 'case', classId: 'I' }], pickups: [{ requestId: id, platoonMiles: 2 }] }],
        legs: [{ depart: t0, arrive: eta, path: G.encodePolyline([[hub.lat, hub.lon], [g.lat, g.lon]]) }, { depart: eta + 15, arrive: eta + 60, path: G.encodePolyline([[g.lat, g.lon], [hub.lat, hub.lon]]) }] };
    };
    const ra = mk('Alpha-2', ga, 440, 500), rb = mk('Bravo-2', gb, 450, 610);
    const stop = (rt) => ({ truckId: rt.truckId, stopSeq: 1, nodeKind: 'rally', gridId: rt.stops[0].gridId, lat: rt.stops[0].lat, lon: rt.stops[0].lon, label: rt.stops[0].label, eta: rt.stops[0].arrive, done: false, stopsBefore: 0 });
    const plan = { id: 'P-SPLIT', name: 'Split test', createdAt: 420, routes: [ra, rb],
      deferred: [{ requestId: id, lineIdx: 0, qty: 20, unit: 'case', group: 'cargo', reason: 'capacity', detail: 'trucks-full', note: '' }],
      byRequest: { [id]: Object.assign(stop(ra), { qtyByLine: { 0: 40 }, deferredQty: { 0: 20 }, stops: [stop(ra), stop(rb)] }) } };
    const a = S.dispatch({ type: 'plan/store', plan, now: 420 });
    const b = S.dispatch({ type: 'plan/approve', planId: 'P-SPLIT', now: 420 });
    return { ok: a.ok && b.ok, id, a: SRO.ui.psg.placeName(ga), b: SRO.ui.psg.placeName(gb), etaA: SRO.core.format.time24(500), etaB: SRO.core.format.time24(610) };
  });
  check(split.ok, 'split plan stored and approved');
  await settle(page);
  await page.waitForTimeout(200);
  const cs = V('myrequests') + ' .psg-req[data-id="' + split.id + '"]';
  R = await reqById(page, split.id);
  check(R && R.status === 'partial', 'split with a remainder: status Partial', R && R.status);
  const part = await text(page, cs + ' .psg-partial');
  check(part.includes('40 of 60 cases MREs, Mixed menus') && part.includes('ETA ' + split.etaA) && part.includes('20 cases more next window'), 'partial line: "40 of 60 cases ... ETA ...; 20 cases more next window"', part);
  const also = await text(page, cs + ' .psg-also');
  check(also.includes('Bravo-2') && also.includes('20 cases at') && also.includes(split.b) && also.includes('ETA ' + split.etaB), 'second truck of the split shown ("Also coming": Bravo-2, 20 cases, its pickup and ETA)', also);
  check((await text(page, cs + ' .psg-truck-chip')).startsWith('Alpha-2') && (await text(page, cs + ' .psg-eta-time')) === split.etaA, 'tracking follows the first truck (Alpha-2, ETA ' + split.etaA + ')');
  await page.locator(cs).scrollIntoViewIfNeeded();
  await shots(page, '390x844', '18-mine-split', { themes: ['dark', 'night'] });
  // My requests left at its top (the tall split card first); a new request goes below the fold, and
  // "View my requests" must open on it rather than where the tab was left
  await page.evaluate(() => { document.querySelector('#psg-root .psg-body').scrollTop = 0; });
  await settle(page);
  await showTab(page, act, 'request');
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  await act.tap('.modal [data-action="add-item"]');
  await act.tap(V('request') + ' .psg-submit');
  const rNew = await text(page, V('request') + ' .psg-done-rid');
  await act.tap(V('request') + ' .psg-view-mine');
  const below = await page.evaluate((id) => { const c = document.querySelector('.psg-view[data-tab="myrequests"] .psg-req[data-id="' + id + '"]'); const b = document.querySelector('#psg-root .psg-body'); return c ? Math.round(c.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop) : -1; }, rNew);
  check(below > 600 && await inView(page, V('myrequests') + ' .psg-req[data-id="' + rNew + '"]'), '"View my requests" scrolls to the new card even when it is below the fold', [below, await bodyScroll(page)]);
  // the plan is approved while the platoon sergeant has the request open for editing
  await act.tap(V('myrequests') + ' .psg-req[data-id="' + rNew + '"] .psg-edit');
  check((await text(page, V('request') + ' .psg-title')).includes('Edit ' + rNew), 'edit form open for ' + rNew);
  const ok2 = await page.evaluate((id) => {
    const SRO = window.SRO, S = SRO.app.store, st = S.getState(), G = SRO.core.geo;
    const g = SRO.data.grid.find((x) => x.rallyCandidate);
    const hub = st.scenario.hubs[0];
    const plan = { id: 'P-LATE', name: 'Approved during edit', createdAt: st.clock.simMin, routes: [{ truckId: 'Alpha-1', type: 'tanker', depart: 480, returnAt: 600,
      stops: [{ seq: 1, kind: 'rally', gridId: g.id, lat: g.lat, lon: g.lon, label: g.name, arrive: 540, depart: 555, deliveries: [{ requestId: id, lineIdx: 0, qty: 500, unit: 'gal', classId: 'III' }] }],
      legs: [{ depart: 480, arrive: 540, path: G.encodePolyline([[hub.lat, hub.lon], [g.lat, g.lon]]) }, { depart: 555, arrive: 600, path: G.encodePolyline([[g.lat, g.lon], [hub.lat, hub.lon]]) }] }], deferred: [] };
    return S.dispatch({ type: 'plan/store', plan }).ok && S.dispatch({ type: 'plan/approve', planId: 'P-LATE' }).ok;
  }, rNew);
  await settle(page);
  check(ok2, 'plan approved while the edit is open');
  check((await text(page, V('request') + ' .psg-head .notice')).includes('can no longer be changed'), 'edit form says the request can no longer be changed', await text(page, V('request') + ' .psg-head'));
  check(await page.locator(V('request') + ' .psg-submit').isDisabled(), 'Save changes is disabled once approved');
  await act.tap(V('request') + ' .psg-discard');
  check((await S(page)).tab === 'myrequests' && !(await visible(page, V('myrequests') + ' .psg-req[data-id="' + rNew + '"] .psg-edit')), 'back on My requests: approved card has no Edit / Cancel');
  check(!errors.length, 'no console errors (edit + split)', errors.slice(0, 6));
  check(!blocked.length, 'no network requests other than map tiles (edit + split)', blocked.slice(0, 4));
  await context.close();
}

// A real plan from the planner engine: platoon sergeant request + 19 samples, Plan now (tabu, short
// cap), approved on the planner's Plan tab, then the card and the truck on the demo clock.
async function engineCase(browser, fileUrl) {
  scope = 'engine plan (390x844)';
  console.log('\n== engine plan, approved in the planner role (390x844)');
  const vp = { width: 390, height: 844, touch: true };
  const { context, page, errors, blocked } = await openApp(browser, fileUrl, vp);
  const act = actor(page, vp);
  const hasEngine = await page.evaluate(() => !!(window.SRO.core.engine && window.SRO.core.engine.run));
  if (!hasEngine) { note('no planner engine in this build; skipped'); await context.close(); return; }
  await quickProfile(page);
  await settle(page);
  await act.tap(V('request') + ' .psg-tile[data-class="III"]');
  await act.tap(V('request') + ' .psg-item[data-item="diesel"]');
  await act.tap('.modal [data-action="add-item"]');
  await act.tap(V('request') + ' .psg-submit');
  const rid = await text(page, V('request') + ' .psg-done-rid');
  await page.click('#topbar .tb-role button[data-role="planner"]');
  await settle(page);
  const run = await page.evaluate(async () => {
    const SRO = window.SRO;
    SRO.app.store.dispatch({ type: 'samples/load' });
    try { const p = await SRO.core.engine.run({ method: 'tabu', timeCapSec: 8 }); return { id: p.id }; } catch (e) { return { err: String((e && e.message) || e) }; }
  });
  check(!!run.id, 'engine produced a plan', run.err);
  if (!run.id) { await context.close(); return; }
  await page.evaluate(() => window.SRO.ui.showView('planner/plan'));
  await settle(page);
  const ap = page.locator('[data-testid="approve"]').first();
  if (await ap.count()) {
    await ap.scrollIntoViewIfNeeded();
    await ap.click();
    await settle(page);
    if (await page.locator('.modal [data-action="approve"]').count()) await page.locator('.modal [data-action="approve"]').click();
  } else {
    note('no Approve button on the planner Plan tab; approved through the store');
    await page.evaluate((id) => window.SRO.app.store.dispatch({ type: 'plan/approve', planId: id }), run.id);
  }
  await settle(page);
  const info = await page.evaluate(({ rid, pid }) => {
    const SRO = window.SRO, s = SRO.app.store.getState();
    const r = s.requests.find((x) => x.id === rid), p = s.plans.find((x) => x.id === pid);
    const e = p && p.byRequest && p.byRequest[rid];
    if (!r || !e) return { status: r && r.status, approved: p && p.approved };
    const rt = e.truckId ? p.routes.find((x) => x.truckId === e.truckId) : null;
    const t = e.truckId ? s.scenario.fleet.find((x) => x.id === e.truckId) : null;
    return { status: r.status, approved: p.approved, truckId: e.truckId, freq: t && t.freq, kind: e.nodeKind, eta: e.eta, depart: rt && rt.depart,
      etaText: SRO.core.format.time24(e.eta), mgrs: e.lat != null ? SRO.core.format.mgrs(e.lat, e.lon, 5) : null, label: e.label,
      legsHavePaths: !!rt && rt.legs.every((l) => typeof l.path === 'string' && l.path.length > 4) };
  }, { rid, pid: run.id });
  check(info.approved, 'engine plan approved from the planner Plan tab', info);
  await page.click('#topbar .tb-role button[data-role="psg"]');
  await settle(page);
  await showTab(page, act, 'myrequests');
  await page.waitForTimeout(300);
  const c = V('myrequests') + ' .psg-req[data-id="' + rid + '"]';
  if (info.truckId) {
    check(info.status === 'approved', 'request approved in the engine plan', info.status);
    check(info.legsHavePaths, 'engine legs carry encoded road paths (DESIGN 8b)');
    check((await text(page, c + ' .psg-eta-time')) === info.etaText, 'card ETA = byRequest eta (' + info.etaText + ')', await text(page, c + ' .psg-eta-time'));
    check((await text(page, c + ' .psg-truck-chip')) === info.truckId && (await text(page, c + ' .psg-freq')).includes(info.freq), 'card truck callsign and frequency from the engine plan', [info.truckId, info.freq]);
    if (info.kind === 'direct') check((await text(page, c + ' .psg-pickup-name')) === 'Direct to your location', 'direct delivery named plainly');
    else {
      check((await text(page, c + ' .psg-pickup-grid')) === info.mgrs, 'card pickup MGRS = byRequest point', [await text(page, c + ' .psg-pickup-grid'), info.mgrs]);
      check((await text(page, c + ' .psg-pickup-name')).length > 2, 'card pickup name', await text(page, c + ' .psg-pickup-name'));
    }
    await page.locator(c).scrollIntoViewIfNeeded();
    await shots(page, '390x844', '19-engine-approved', { themes: ['dark', 'light', 'night'] });
    const t = info.depart + (info.eta - info.depart) * 0.5;
    await page.evaluate((v) => window.SRO.app.store.dispatch({ type: 'clock/tick', simMin: v }), t);
    await settle(page);
    const cmp = await page.evaluate(({ c, rid, pid, t }) => {
      const SRO = window.SRO, s = SRO.app.store.getState();
      const host = document.querySelector(c + ' .psg-map-track');
      const m = host && host.__sroMap;
      if (!m) return { err: 'no map' };
      let mk = null;
      m.leaflet.eachLayer((l) => { if (l.options && l.options.pane === 'sro-trucks' && l.getLatLng) mk = l; });
      const p = s.plans.find((x) => x.id === pid), e = p.byRequest[rid], rt = p.routes.find((x) => x.truckId === e.truckId);
      const exp = SRO.ui.map.truckPosition({ legs: rt.legs.map((l) => ({ coords: SRO.core.geo.decodePolyline(l.path), depart: l.depart, arrive: l.arrive })) }, t);
      const ll = mk && mk.getLatLng();
      const k = rt.stops.findIndex((st) => (st.deliveries || []).some((d) => d.requestId === rid));
      const before = rt.stops.slice(0, Math.max(0, k));
      const done = before.filter((st) => st.depart <= t).length;
      const atStop = before.some((st) => t >= st.arrive && t < st.depart);
      return { ll: ll && [ll.lat, ll.lng], exp: exp && [exp.lat, exp.lon], status: s.requests.find((x) => x.id === rid).status, drag: m.leaflet.dragging && m.leaflet.dragging.enabled(),
        k, done, atStop };
    }, { c, rid, pid: run.id, t });
    check(cmp.ll && cmp.exp && Math.abs(cmp.ll[0] - cmp.exp[0]) < 1e-4 && Math.abs(cmp.ll[1] - cmp.exp[1]) < 1e-4, 'truck marker on the engine road path halfway to the ETA (truckPosition)', cmp);
    check(cmp.status === 'en_route' && (await text(page, c + ' .psg-req-head')).includes('En route'), 'card: En route on the demo clock');
    check(cmp.drag === false, 'touch screen: one-finger swipes over the card map scroll the list (map dragging off)', cmp.drag);
    // the live line must not contradict the planned "N stops before yours" headline once stops are done
    const live = await text(page, c + ' .psg-live');
    if (cmp.done > 0 && cmp.done < cmp.k && !cmp.atStop) {
      const want = 'has left stop ' + cmp.done + '; ' + (cmp.k - cmp.done) + ' more stop' + (cmp.k - cmp.done === 1 ? '' : 's') + ' before yours';
      check(live.includes(want), 'live line after a stop is done: "' + want + '"', live);
    } else if (cmp.done === 0 && !cmp.atStop && cmp.k > 0) {
      check(live.includes(cmp.k + ' stop' + (cmp.k === 1 ? '' : 's') + ' before yours') && !live.includes('more stop'), 'live line before any stop: planned count', live);
    } else note('engine plan: live line at the midpoint is "' + live + '" (stops before: ' + cmp.k + ', done: ' + cmp.done + ')');
    await page.locator(c).scrollIntoViewIfNeeded();
    await shots(page, '390x844', '20-engine-en-route', { themes: ['dark'] });
  } else {
    check(info.status === 'delayed', 'request not routed by the engine is shown as delayed', info);
    check((await text(page, c + ' .psg-delayed')).includes('Not in this window - next plan at'), 'deferred card wording (engine plan)');
  }
  check(!errors.length, 'no console errors (engine plan)', errors.slice(0, 6));
  check(!blocked.length, 'no network requests other than map tiles (engine plan)', blocked.slice(0, 4));
  await context.close();
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = build();
  const fileUrl = pathToFileURL(file).href;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      try { await runFlow(browser, fileUrl, vp); } catch (e) { check(false, 'flow crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
    }
    try { await geoCases(browser, fileUrl); } catch (e) { check(false, 'geolocation cases crashed: ' + (e && e.message)); }
    try { await editAndSplitCases(browser, fileUrl); } catch (e) { check(false, 'edit / split cases crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
    try { await engineCase(browser, fileUrl); } catch (e) { check(false, 'engine case crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
  } finally {
    await browser.close();
  }
  console.log('\nnumbers: ' + JSON.stringify(report, null, 1));
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed; screenshots in ' + SHOTS);
  if (failures.length) {
    console.log('\nFAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
