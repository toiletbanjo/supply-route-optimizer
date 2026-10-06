#!/usr/bin/env node
// Playwright checks for the app shell (tools/build.py, src/index.html, src/styles.css,
// src/ui/shell.js, src/ui/boot.js). Plain node script:
//
//   node tests/ui/shell.spec.mjs [--shell-only] [--no-build --file PATH] [--shots DIR]
//
// Builds the single file (python3 tools/build.py --out <tmp>), opens it from file:// in Chromium at
// 390x844, 820x1180 and 1440x900 in the dark, light and night themes, and checks: zero console
// errors (blocked OpenStreetMap tile requests are expected and ignored), no non-tile network
// requests, role switch and theme toggle (and that both persist across a reload), the demo clock
// (start, pause, speed, jump to next window), modal / bottom sheet (focus trap, Escape, actions),
// toasts, the planner tab layout, the view registry, touch target sizes on phones, no horizontal
// overflow, no white in night mode, reduced motion and print media. Edge cases (edgeCases below):
// 320x568 with touch, 2560x1440, 31 rapid theme clicks, theme applied before boot, blocked
// localStorage, long labels, the h() helper, failing views, resizing across 1100px, nested modals
// and print colors. Screenshots go to /tmp/claude-0/ui-shots/shell/. Exits 1 on any failure.
//
// --shell-only builds without the other UI view modules (src/ui/psg/*, src/ui/planner/*, map,
// symbols) and the planner engine, so the shell is checked in isolation with its placeholders.
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

const SHELL_ONLY = flag('--shell-only');
const SHOTS = opt('--shots', '/tmp/claude-0/ui-shots/shell');
const VIEWPORTS = [
  { width: 390, height: 844, touch: true },
  { width: 820, height: 1180, touch: true },
  { width: 1440, height: 900, touch: false }
];
const THEMES = ['dark', 'light', 'night'];
const THEME_COLOR = { dark: '#0f1418', light: '#f4f5f2', night: '#000000' };
const TILE_RE = /tile\.openstreetmap\.org/i;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-shell-spec-'));
  const out = path.join(dir, 'supply-route-app.html');
  const cmd = ['tools/build.py', '--quiet', '--out', out];
  if (SHELL_ONLY) {
    for (const g of ['src/ui/psg/*', 'src/ui/planner/*', 'src/ui/map.js', 'src/ui/symbols.js', 'src/core/planner-engine.js']) cmd.push('--exclude', g);
  }
  let output;
  try {
    output = execFileSync('python3', cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    process.stderr.write(String(e.stdout || '') + String(e.stderr || ''));
    throw new Error('build failed');
  }
  console.log('build: ' + output.trim().split('\n').pop());
  return out;
}

// ---- check bookkeeping ----------------------------------------------------------------------------
const failures = [];
const notes = [];
let passed = 0;
let scope = '';
function check(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(scope + ': ' + msg);
  console.log('  FAIL ' + msg);
  return false;
}
function note(msg) { notes.push(scope + ': ' + msg); console.log('  note ' + msg); }

// ---- page helpers ---------------------------------------------------------------------------------
async function waitApp(page) {
  await page.waitForFunction(() => window.SRO && window.SRO.app && window.SRO.app.store && document.querySelector('#topbar .tb-role'), null, { timeout: 15000 });
  await settle(page);
}
// two animation frames (the shell renders once per frame), then let finite CSS animations
// (modal / sheet / toast entrances) finish so boxes and screenshots show the resting state
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const finite = document.getAnimations().filter((a) => { const t = a.effect && a.effect.getComputedTiming(); return t && isFinite(t.endTime); });
    await Promise.all(finite.map((a) => a.finished.catch(() => null)));
  });
}
const st = (page) => page.evaluate(() => {
  const s = window.SRO.app.store.getState();
  return { role: s.ui.role, theme: s.ui.theme, plannerTab: s.ui.plannerTab, simMin: s.clock.simMin, running: s.clock.running, speed: s.clock.speed };
});
async function visible(page, sel) { const l = page.locator(sel).first(); return (await l.count()) > 0 && l.isVisible(); }
async function box(page, sel) { return page.locator(sel).first().boundingBox(); }

async function setTheme(page, theme) {
  for (let i = 0; i < 3; i++) {
    const cur = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (cur === theme) return true;
    await page.click('#topbar .tb-theme');
    await settle(page);
  }
  return (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme;
}
async function setRole(page, role) {
  await page.click('#topbar .tb-role button[data-role="' + role + '"]');
  await settle(page);
}

async function noOverflow(page) {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth
  }));
}

// colors that are near-white (light neutral) on elements under the given roots
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
    const seen = new Set();
    for (const sel of sels) {
      for (const rootEl of document.querySelectorAll(sel)) {
        for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!el.getClientRects().length) continue;
          if (el.closest('.leaflet-tile-pane')) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const props = ['color', 'background-color'];
          if (parseFloat(cs.borderTopWidth) > 0) props.push('border-top-color');
          if (parseFloat(cs.borderLeftWidth) > 0) props.push('border-left-color');
          if (el instanceof SVGElement) props.push('fill', 'stroke');
          const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          for (const p of props) {
            if (p === 'color' && !hasText && !(el instanceof SVGElement)) continue;
            const v = cs.getPropertyValue(p);
            if (bright(v)) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').join('.')) + ' ' + p + '=' + v);
          }
        }
      }
    }
    return out.slice(0, 20);
  }, selectors);
}

// ---- component gallery ----------------------------------------------------------------------------
// Registers a temporary PSG tab that shows every shared component class from styles.css, screenshots
// it in each theme and checks that the 4 urgency colors and the 8 truck colors stay apart.
async function gallery(page, tag, vp) {
  await page.evaluate(() => {
    const ui = window.SRO.ui;
    const h = ui.h;
    const trucks = (window.SRO.data.scenario && window.SRO.data.scenario.truckColors) || [];
    const fleet = (window.SRO.app.store.getState().scenario.fleet || []);
    ui.registerView('psg/zzgallery', {
      label: 'Gallery',
      mount(el) {
        el.append(
          h('div.section-head', h('span.caps', 'Buttons'), h('span.badge', 'v1')),
          h('div.hstack.wrap',
            h('button.btn.btn-primary', ui.icon('send'), 'Submit request'),
            h('button.btn.btn-secondary', 'Secondary'),
            h('button.btn.btn-danger', ui.icon('trash'), 'Cancel'),
            h('button.btn.btn-ghost', 'Ghost'),
            h('button.btn.btn-icon', { 'aria-label': 'Settings' }, ui.icon('gear')),
            h('button.btn.btn-sm', 'Small'),
            h('button.btn.btn-primary', { disabled: true }, 'Disabled')),
          h('div.seg.seg-block', h('button', { 'aria-pressed': 'true' }, 'Mounted'), h('button', 'Dismounted'), h('button', 'Fixed')),
          h('div.chip-group', h('button.chip', { 'aria-pressed': 'true' }, 'JP-8'), h('button.chip', 'Diesel'), h('button.chip', 'Gasoline')),
          h('div.card',
            h('div.card-header', h('div', h('h3.card-title', 'New request'), h('div.card-sub', '1st PLT, B CO, 3-21 IN')), h('span.badge-urgency.badge.urg-priority', 'Priority')),
            h('div.vstack',
              h('div.field', h('label.field-label', 'Quantity ', h('span.field-opt', '(gal)')),
                h('div.stepper', h('button', { type: 'button', 'aria-label': 'Less' }, '-'), h('input', { type: 'number', value: '500' }), h('button', { type: 'button', 'aria-label': 'More' }, '+')),
                h('div.field-help', 'Typical daily use 120 gal.')),
              h('div.field.is-invalid', h('label.field-label', 'No later than'), h('input.input', { value: '0545', 'aria-invalid': 'true' }),
                h('div.field-error', ui.icon('alert'), 'That time has passed. Pick a time after 0600.')),
              h('div.field.is-warning', h('label.field-label', 'Pickup point'), h('select.select', h('option', 'RP Lotus North (4.2 mi)'), h('option', 'RP Jade East')),
                h('div.field-warn', ui.icon('alert'), 'More than 5 times typical daily use.')),
              h('textarea.textarea', { placeholder: 'Remarks (optional)' }),
              h('div.hstack.wrap', h('label.check', h('input', { type: 'checkbox', checked: true }), 'Deliver direct'), h('label.check', h('input', { type: 'radio', name: 'g1', checked: true }), 'Radio'), h('input.switch', { type: 'checkbox', checked: true, 'aria-label': 'Switch' })),
              h('input.range', { type: 'range', min: 0, max: 10, value: 3, 'aria-label': 'Fuel weight' })),
            h('div.card-footer', h('button.btn.btn-ghost', 'Back'), h('button.btn.btn-primary', 'Submit'))),
          h('div.hstack.wrap',
            ['Routine', 'Priority', 'Urgent', 'Immediate'].map((u) => h('span.badge.badge-urgency.urg-' + u.toLowerCase(), u))),
          h('div.hstack.wrap',
            ['submitted', 'planned', 'approved', 'en_route', 'delivered', 'partial', 'delayed', 'cancelled'].map((s) => h('span.badge.st-' + s, s.replace('_', ' ')))),
          h('div.hstack.wrap', fleet.slice(0, 8).map((t) => h('span.truck-chip', { style: { '--truck': t.color } }, t.id))),
          h('ul.list',
            h('li', h('button.list-row.urg-bar.urg-immediate', h('span.urg-dot.urg-immediate'), h('div.list-row-main', h('div.list-row-title', 'R-0007  Class V (Ammunition)'), h('div.list-row-sub', 'Pick up at RP Granite West')), h('div.list-row-meta', 'ETA 0845'), ui.icon('chevron'))),
            h('li', h('div.list-row.is-selected', h('span.truck-swatch', { style: { '--truck': trucks[1] ? trucks[1].hex : '#0F9488' } }), h('div.list-row-main', h('div.list-row-title', 'Alpha-2, 3 stops'), h('div.list-row-sub', 'Returns 1430'))))),
          h('div.summary',
            h('div.stat', h('div.stat-label', 'Requests'), h('div.stat-value', '20')),
            h('div.stat', h('div.stat-label', 'Miles'), h('div.stat-value', '412', h('span.stat-unit', 'mi'))),
            h('button.stat.is-alert', h('div.stat-label', 'Delayed'), h('div.stat-value', '2'))),
          h('div', h('div.progress', h('div.progress-bar', { style: 'width:62%' })), h('div.progress-meta', h('span', 'Tabu search'), h('span', '18 s of ~30 s'))),
          h('div.notice.notice-info', ui.icon('info'), h('div', 'Travel times from OpenStreetMap road data.')),
          h('div.notice.notice-error', ui.icon('alert'), h('div', 'Location is outside Taiwan.')),
          h('div.tabs', h('button.tab', { 'aria-selected': 'true' }, 'Day'), h('button.tab', 'Advanced')),
          h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Stop'), h('th', 'Truck'), h('th.num', 'Arrive'))),
            h('tbody', [1, 2, 3].map((i) => h('tr', h('td', 'RP ' + i), h('td', h('span.truck-chip', { style: { '--truck': fleet[i] ? fleet[i].color : '#888' } }, fleet[i] ? fleet[i].id : 'T')), h('td.num', String(7 + i).padStart(2, '0') + '15')))))),
          h('dl.kv', h('dt', 'Grid'), h('dd.mono', '51R UH 55263 69368'), h('dt', 'Freq'), h('dd.num', '45.250')),
          h('div.card.card-flush', h('div.empty', h('div.empty-icon', ui.icon('list')), h('p.empty-title', 'No requests yet'), h('p.empty-text', 'Submit one as a platoon sergeant, or load sample requests.'), h('div.empty-actions', h('button.btn.btn-secondary', 'Load sample requests')))));
      },
      update() {}
    });
    ui.showView('psg/zzgallery');
  });
  await settle(page);
  const tall = { width: vp.width, height: 2300 };
  await page.setViewportSize(tall);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, tag + '-' + theme + '-gallery.png') });
    const res = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const hex = (v) => v.trim();
      const parse = (c) => {
        const srgb = /color\(srgb ([^)]+)\)/.exec(c);
        if (srgb) return srgb[1].split(/[ /]+/).filter(Boolean).slice(0, 3).map((x) => Number(x) * 255);
        return c.match(/[\d.]+/g).map(Number).slice(0, 3);
      };
      const toRgb = (c) => {
        const el = document.createElement('span');
        el.style.color = c;
        document.body.appendChild(el);
        const v = parse(getComputedStyle(el).color);
        el.remove();
        return v;
      };
      const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
      const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
      const lab = (rgb) => {
        const [r, g, b] = rgb.map(lin);
        let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
        const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
        x = f(x); y = f(y); z = f(z);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
      };
      const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
      const surface = toRgb(hex(css.getPropertyValue('--surface')));
      const urg = ['routine', 'priority', 'urgent', 'immediate'].map((k) => ({ k, rgb: toRgb(hex(css.getPropertyValue('--urg-' + k))) }));
      const swatches = [...document.querySelectorAll('[data-tab="zzgallery"] .truck-chip')].slice(0, 8).map((el) => ({ k: el.textContent, rgb: parse(getComputedStyle(el, '::before').backgroundColor) }));
      const pairs = (list) => { let min = Infinity, which = ''; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const d = dE(list[i].rgb, list[j].rgb); if (d < min) { min = d; which = list[i].k + '/' + list[j].k; } } return { min: Math.round(min * 10) / 10, which }; };
      const minContrast = (list) => { let min = Infinity, which = ''; list.forEach((x) => { const c = contrast(x.rgb, surface); if (c < min) { min = c; which = x.k; } }); return { min: Math.round(min * 100) / 100, which }; };
      return { urgPairs: pairs(urg), truckPairs: pairs(swatches), urgContrast: minContrast(urg), truckContrast: minContrast(swatches), nTrucks: swatches.length };
    });
    const minC = theme === 'night' ? 2 : 3;
    check(res.urgPairs.min >= 15, theme + ': urgency colors distinct (min deltaE ' + res.urgPairs.min + ' ' + res.urgPairs.which + ')');
    check(res.nTrucks === 8 && res.truckPairs.min >= 12, theme + ': 8 truck colors distinct (min deltaE ' + res.truckPairs.min + ' ' + res.truckPairs.which + ')');
    check(res.urgContrast.min >= minC, theme + ': urgency colors contrast >= ' + minC + ':1 on surface (min ' + res.urgContrast.min + ' ' + res.urgContrast.which + ')');
    check(res.truckContrast.min >= minC, theme + ': truck colors contrast >= ' + minC + ':1 on surface (min ' + res.truckContrast.min + ' ' + res.truckContrast.which + ')');
    if (theme === 'night') {
      const bad = await whiteOffenders(page, ['[data-tab="zzgallery"]']);
      check(bad.length === 0, 'night: no near-white color in the component gallery' + (bad.length ? ' (' + bad.slice(0, 5).join('; ') + ')' : ''));
    }
  }
  await setTheme(page, 'dark');
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.evaluate(() => window.SRO.ui.psgTabs.remove('zzgallery'));
  await settle(page);
}

// ---- per-viewport flow ----------------------------------------------------------------------------
async function runViewport(browser, fileUrl, vp) {
  const tag = vp.width + 'x' + vp.height;
  scope = tag;
  console.log('\n== ' + tag + (SHELL_ONLY ? ' (shell only)' : ''));
  const phone = vp.width < 600;
  const wide = vp.width >= 1100;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: phone ? 2 : 1,
    hasTouch: !!vp.touch
  });
  const consoleErrors = [];
  const ignored = [];
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/.test(u)) return route.continue();
    blocked.push(u);
    return route.abort('internetdisconnected');
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    if (TILE_RE.test(loc) || TILE_RE.test(text)) { ignored.push(text); return; }
    consoleErrors.push(text + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)));

  await page.goto(fileUrl);
  await waitApp(page);
  const info = await page.evaluate(() => ({
    psgTabs: window.SRO.ui.psgTabs.list().filter((t) => t.registered).map((t) => t.name),
    plannerTabs: window.SRO.ui.plannerTabs.list().filter((t) => t.registered).map((t) => t.name),
    build: window.SRO.build
  }));
  console.log('  registered psg tabs: [' + info.psgTabs.join(', ') + '], planner tabs: [' + info.plannerTabs.join(', ') + ']');

  // defaults
  let s = await st(page);
  check(s.role === 'psg' && s.theme === 'dark', 'fresh start is platoon sergeant + dark (got ' + s.role + ' + ' + s.theme + ')');
  check(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', 'html[data-theme] is dark');
  check(await page.title() === 'Supply Route Optimizer', 'title is "Supply Route Optimizer"');
  check(await visible(page, '#psg-root') && !(await visible(page, '#planner-root')), 'PSG root visible, planner root hidden');
  if (!info.psgTabs.length) {
    check(await visible(page, '#psg-root .placeholder') && (await page.textContent('#psg-root')).includes('Platoon sergeant views load here'), 'PSG placeholder card shown');
  }
  // PSG column width
  const psgBox = await box(page, '#psg-root');
  if (vp.width > 500) {
    check(psgBox.width <= 482 && Math.abs(psgBox.x + psgBox.width / 2 - vp.width / 2) < 2, 'PSG view is a centered phone-width column (width ' + psgBox.width + ')');
  } else {
    check(Math.abs(psgBox.width - vp.width) < 1, 'PSG view fills the phone width');
  }
  // top bar
  const tb = await box(page, '#topbar');
  check(tb && tb.height >= 50 && tb.height <= 60, 'top bar height ' + (tb && tb.height));
  if (phone) {
    const small = await page.evaluate(() => [...document.querySelectorAll('#topbar button')]
      .filter((b) => b.getClientRects().length)
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter((x) => x.r.height < 44 || x.r.width < 44)
      .map((x) => (x.b.className || x.b.textContent) + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height)));
    check(small.length === 0, 'top bar touch targets >= 44px on phone' + (small.length ? ' (' + small.join(', ') + ')' : ''));
    check(!(await visible(page, '#topbar .tb-speed')), 'speed control moves into the clock sheet on phones');
  } else {
    check(await visible(page, '#topbar .tb-speed'), 'speed control visible in the top bar');
  }
  check(await visible(page, '#topbar .tb-hhmm') && (await page.textContent('#topbar .tb-hhmm')) === '0600', 'clock shows 0600');
  check((await page.textContent('#topbar .tb-day')) === 'Day 1', 'clock shows Day 1');

  // planner role
  await setRole(page, 'planner');
  s = await st(page);
  check(s.role === 'planner', 'role switch sets ui.role = planner');
  check(await visible(page, '#planner-root') && !(await visible(page, '#psg-root')), 'planner root visible, PSG root hidden');
  check(await page.getAttribute('#topbar .tb-role button[data-role="planner"]', 'aria-pressed') === 'true', 'Planner button pressed');

  const labels = ['Map', 'Queue', 'Plan', 'Scenario', 'Outputs'];
  if (!wide) {
    check(await visible(page, '#planner-root .planner-tabbar'), 'planner bottom tab bar visible under 1100px');
    const tabTexts = await page.$$eval('#planner-root .planner-tabbar .tabbar-item', (els) => els.map((e) => e.querySelector('.tab-label').textContent));
    check(labels.every((l) => tabTexts.includes(l)), 'bottom tabs include Map / Queue / Plan / Scenario / Outputs (got ' + tabTexts.join(', ') + ')');
    const bar = await box(page, '#planner-root .planner-tabbar');
    check(bar && Math.abs(bar.y + bar.height - vp.height) < 2, 'tab bar sits at the bottom of the screen');
    for (const name of ['queue', 'map', 'plan']) {
      await page.click('#planner-root .planner-tabbar .tabbar-item[data-tab="' + name + '"]');
      await settle(page);
      const shown = await page.$$eval('#planner-root .pl-view', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.dataset.tab));
      check(shown.length === 1 && shown[0] === name, 'tab ' + name + ' shows only its view (visible: ' + shown.join(',') + ')');
      check(await page.getAttribute('#planner-root .planner-tabbar .tabbar-item[data-tab="' + name + '"]', 'aria-selected') === 'true', 'tab ' + name + ' marked selected');
    }
    if (phone) {
      const tabSmall = await page.$$eval('#planner-root .planner-tabbar .tabbar-item', (els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
      check(tabSmall === 0, 'bottom tabs are >= 44px tall');
    }
  } else {
    check(!(await visible(page, '#planner-root .planner-tabbar')), 'no bottom tab bar from 1100px');
    const shown = await page.$$eval('#planner-root .pl-view', (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ tab: e.dataset.tab, region: e.dataset.region, x: e.getBoundingClientRect().x })));
    const regions = shown.map((x) => x.region);
    check(regions.includes('left') && regions.includes('center') && regions.includes('right') && shown.length === 3, 'left, center and right panels shown together (' + shown.map((x) => x.tab).join(',') + ')');
    const byRegion = Object.fromEntries(shown.map((x) => [x.region, x.x]));
    check(byRegion.left < byRegion.center && byRegion.center < byRegion.right, 'panels ordered left, center, right');
    check(await visible(page, '#planner-root .pl-head[data-region="right"] .seg'), 'right panel has a segmented tab header');
    await page.click('#planner-root .pl-head[data-region="right"] [data-tab="scenario"]');
    await settle(page);
    s = await st(page);
    const rightTab = await page.$$eval('#planner-root .pl-view[data-region="right"]', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.dataset.tab));
    check(s.plannerTab === 'scenario' && rightTab.join() === 'scenario', 'segmented header switches the right panel (store ' + s.plannerTab + ', shown ' + rightTab + ')');
    check(await visible(page, '#planner-root .pl-view[data-tab="map"]'), 'map stays visible while the right panel changes');
    await page.click('#planner-root .pl-head[data-region="right"] [data-tab="plan"]');
    await settle(page);
  }
  if (!info.plannerTabs.length) {
    check((await page.textContent('#planner-root')).includes('Planner views load here'), 'planner placeholder cards shown');
  }

  // persistence of role across reload
  await page.reload();
  await waitApp(page);
  s = await st(page);
  check(s.role === 'planner' && await visible(page, '#planner-root'), 'role persists across reload');

  // themes x roles: screenshots and checks
  for (const theme of THEMES) {
    check(await setTheme(page, theme), 'theme toggle reaches ' + theme);
    s = await st(page);
    check(s.theme === theme, 'store ui.theme = ' + theme);
    const meta = await page.getAttribute('meta[name="theme-color"]', 'content');
    check(meta === THEME_COLOR[theme], 'theme-color meta follows the theme (' + theme + ': ' + meta + ')');
    for (const role of ['psg', 'planner']) {
      await setRole(page, role);
      const ov = await noOverflow(page);
      check(ov.doc <= ov.vw && ov.body <= ov.vw, 'no horizontal scroll (' + theme + ', ' + role + ': ' + ov.doc + ' > ' + ov.vw + ')');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check(bg !== 'rgba(0, 0, 0, 0)', 'body has an explicit background');
      if (theme === 'night') {
        const shellBad = await whiteOffenders(page, ['#topbar', '.tabbar', '.pl-head', '.placeholder', '.toast-root']);
        check(shellBad.length === 0, 'night: no near-white color in shell elements' + (shellBad.length ? ' (' + shellBad.slice(0, 5).join('; ') + ')' : ''));
        const viewBad = await whiteOffenders(page, ['#' + role + '-root']);
        if (viewBad.length) note('night: near-white colors inside ' + role + ' views: ' + viewBad.slice(0, 5).join('; '));
      }
      await page.screenshot({ path: path.join(SHOTS, tag + '-' + theme + '-' + role + '.png') });
    }
  }
  // theme persists across reload (night is current)
  await page.reload();
  await waitApp(page);
  check(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'night' && (await st(page)).theme === 'night', 'night theme persists across reload');
  check(await page.getAttribute('meta[name="theme-color"]', 'content') === THEME_COLOR.night, 'theme-color meta is the night color after reload');
  check(await setTheme(page, 'dark'), 'theme toggle cycles back to dark');
  await setRole(page, 'psg');

  // ---- demo clock --------------------------------------------------------------------------------
  s = await st(page);
  check(s.running === false, 'clock starts paused');
  const t0 = s.simMin;
  const hhmm0 = await page.textContent('#topbar .tb-hhmm');
  if (phone) {
    await page.click('#topbar .tb-time');
    await settle(page);
    const sheet = await box(page, '.modal');
    check(!!sheet && Math.abs(sheet.y + sheet.height - vp.height) < 2 && Math.abs(sheet.width - vp.width) < 2, 'clock sheet is a bottom sheet on phones');
    await page.screenshot({ path: path.join(SHOTS, tag + '-dark-clock.png') });
    await page.click('.modal .clock-speed button[data-speed="600"]');
    await settle(page);
    check((await st(page)).speed === 600, 'speed 600x from the clock sheet');
    await page.click('.modal .clock-run');
    await settle(page);
    check((await st(page)).running === true, 'start from the clock sheet');
    await page.keyboard.press('Escape');
    await settle(page);
    check(!(await visible(page, '.modal')), 'Escape closes the clock sheet');
  } else {
    await page.click('#topbar .tb-speed button[data-speed="600"]');
    await settle(page);
    check((await st(page)).speed === 600 && await page.getAttribute('#topbar .tb-speed button[data-speed="600"]', 'aria-pressed') === 'true', 'speed 600x from the top bar');
    await page.click('#topbar .tb-play');
    await settle(page);
    check((await st(page)).running === true, 'play starts the clock');
  }
  check(await page.evaluate(() => document.querySelector('#topbar .tb-time').classList.contains('is-running')), 'clock shows the running state');
  await page.waitForTimeout(1600);
  s = await st(page);
  check(s.simMin - t0 >= 10, 'clock advances at 600x (' + (s.simMin - t0).toFixed(1) + ' sim min in 1.6 s)');
  await settle(page);
  check((await page.textContent('#topbar .tb-hhmm')) !== hhmm0, 'top bar time updates while running');
  await page.click('#topbar .tb-play');
  await settle(page);
  const p1 = (await st(page)).simMin;
  check((await st(page)).running === false, 'pause stops the clock');
  await page.waitForTimeout(700);
  check((await st(page)).simMin === p1, 'paused clock does not move');
  if (phone) {
    await page.click('#topbar .tb-time');
    await settle(page);
    await page.click('.modal .clock-speed button[data-speed="60"]');
    await settle(page);
  } else {
    await page.click('#topbar .tb-speed button[data-speed="60"]');
    await settle(page);
  }
  check((await st(page)).speed === 60, 'speed 60x');
  if (!phone) { await page.click('#topbar .tb-time'); await settle(page); }
  check(await visible(page, '.modal .clock-jump'), 'clock sheet has "Jump to next window"');
  await page.click('.modal .clock-jump');
  await settle(page);
  s = await st(page);
  check(s.simMin === 720, 'jump to next window moves the clock to 1200 (simMin ' + s.simMin + ')');
  check(await visible(page, '.toast') && (await page.textContent('.toast-root')).includes('Planning window'), 'window boundary toast shown');
  await page.click('.modal .modal-close');
  await settle(page);
  check(!(await visible(page, '.modal')), 'close button closes the sheet');
  await page.reload();
  await waitApp(page);
  s = await st(page);
  check(s.speed === 60 && s.running === false && s.simMin === 720, 'clock speed and time persist; clock reloads paused');

  // ---- modal ------------------------------------------------------------------------------------
  await page.evaluate(() => {
    const ui = window.SRO.ui;
    document.querySelector('#topbar .tb-theme').focus();
    window.__modal = ui.modal.open({
      title: 'Test modal',
      body: (el) => el.append(ui.h('div.field', ui.h('label.field-label', { for: 'tm-a' }, 'First'), ui.h('input.input#tm-a')), ui.h('div.field', ui.h('label.field-label', { for: 'tm-b' }, 'Second'), ui.h('input.input#tm-b'))),
      actions: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Save', kind: 'primary', value: 'saved' }]
    });
    window.__modal.result.then((v) => { window.__modalResult = v; });
  });
  await settle(page);
  check(await visible(page, '.modal[role="dialog"][aria-modal="true"]'), 'modal opens as an aria-modal dialog');
  check(await page.evaluate(() => document.getElementById('app').hasAttribute('inert') && document.getElementById('topbar').hasAttribute('inert')), 'page behind the modal is inert');
  let inside = true;
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    inside = inside && await page.evaluate(() => document.querySelector('.modal').contains(document.activeElement));
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    inside = inside && await page.evaluate(() => document.querySelector('.modal').contains(document.activeElement));
  }
  check(inside, 'focus stays inside the modal (Tab / Shift+Tab)');
  if (phone) {
    const mb = await box(page, '.modal');
    check(Math.abs(mb.y + mb.height - vp.height) < 2 && Math.abs(mb.width - vp.width) < 2, 'modal is a bottom sheet on phones');
  } else {
    const mb = await box(page, '.modal');
    check(mb.width <= 522 && Math.abs(mb.x + mb.width / 2 - vp.width / 2) < 2, 'modal is a centered dialog');
  }
  await page.screenshot({ path: path.join(SHOTS, tag + '-dark-modal.png') });
  await page.keyboard.press('Escape');
  await settle(page);
  check(!(await visible(page, '.modal')), 'Escape closes the modal');
  check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tb-theme')), 'focus returns to the opener');
  check(await page.evaluate(() => !document.getElementById('app').hasAttribute('inert')), 'inert removed after close');
  await page.evaluate(() => { window.__p = window.SRO.ui.modal.open({ title: 'Again', body: 'Text', actions: [{ label: 'Save', kind: 'primary', value: 'saved' }] }); window.__p.result.then((v) => { window.__modalResult2 = v; }); });
  await settle(page);
  await page.click('.modal .btn-primary');
  await settle(page);
  check(!(await visible(page, '.modal')) && await page.evaluate(() => window.__modalResult2) === 'saved', 'action button closes the modal with its value');
  await page.evaluate(() => { window.SRO.ui.modal.open({ title: 'Backdrop', body: 'Click outside' }); });
  await settle(page);
  await page.mouse.click(5, phone ? 70 : vp.height - 5);
  await settle(page);
  check(!(await visible(page, '.modal')), 'backdrop click closes the modal');
  const confirmed = page.evaluate(() => window.SRO.ui.confirm({ title: 'Cancel request?', text: 'This cannot be undone.', okLabel: 'Cancel request', danger: true }));
  await settle(page);
  await page.click('.modal .btn-danger');
  check(await confirmed === true, 'confirm() resolves true on OK');

  // ---- toast --------------------------------------------------------------------------------------
  await page.evaluate(() => window.SRO.ui.toast('Request R-0001 submitted', 'success'));
  await settle(page);
  check(await visible(page, '.toast.toast-success') && (await page.textContent('.toast.toast-success')).includes('R-0001'), 'success toast shown');
  await page.click('.toast.toast-success .toast-close');
  check(!(await visible(page, '.toast.toast-success')), 'toast dismiss button works');

  // ---- view registry --------------------------------------------------------------------------------
  const reg = await page.evaluate(async () => {
    const ui = window.SRO.ui;
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const log = [];
    ui.plannerTabs.add({
      name: 'zztest', label: 'Spec', icon: 'gear', region: 'right', order: 99, badge: () => 3,
      mount(el, ctx) { log.push('mount:' + ctx.role + ':' + ctx.region); el.append(ui.h('div.card#zz-card', 'Spec tab')); },
      update(state, ctx) { log.push('update:' + (typeof ctx.changed === 'function') + ':' + ctx.layout); },
      onHide() { log.push('hide'); }
    });
    ui.showView('planner/zztest');
    await raf();
    const shownAfter = !!document.getElementById('zz-card') && document.getElementById('zz-card').getClientRects().length > 0;
    const badge = [...document.querySelectorAll('#planner-root [data-tab="zztest"] .tab-badge')].some((b) => !b.hidden && b.textContent === '3');
    ui.showView('psg');
    await raf();
    ui.registerView('psg/zzreq', { label: 'Spec PSG', mount(el) { el.append(ui.h('p#zz-psg', 'PSG spec view')); }, update() {} });
    await raf();
    const psgShown = !!document.getElementById('zz-psg') && document.getElementById('zz-psg').getClientRects().length > 0;
    ui.plannerTabs.remove('zztest');
    ui.psgTabs.remove('zzreq');
    await raf();
    return { log, shownAfter, badge, psgShown, role: window.SRO.app.store.getState().ui.role };
  });
  check(reg.shownAfter && reg.log[0] && reg.log[0].startsWith('mount:planner:right'), 'plannerTabs.add + showView mounts the tab lazily (' + reg.log.join(' ') + ')');
  check(reg.log.some((x) => x.startsWith('update:true:')), 'update(state, ctx) runs with ctx.changed and ctx.layout');
  check(reg.log.includes('hide'), 'onHide runs when the view is hidden');
  check(reg.badge, 'tab badge rendered');
  check(reg.psgShown && reg.role === 'psg', 'registerView("psg/<tab>") shows a PSG view');

  // ---- checks done once ----------------------------------------------------------------------------
  if (wide) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const dur = await page.evaluate(() => {
      const el = window.SRO.ui.h('span.badge.badge-urgency.urg-immediate', 'Immediate');
      document.getElementById('psg-root').appendChild(el);
      const d = getComputedStyle(el, '::before').animationDuration;
      el.remove();
      return d;
    });
    check(parseFloat(dur) < 0.001, 'prefers-reduced-motion stops the Immediate pulse (duration ' + dur + ')');
    await page.emulateMedia({ reducedMotion: 'no-preference', media: 'print' });
    const pr = await page.evaluate(() => {
      document.getElementById('print-root').appendChild(window.SRO.ui.h('h1.print-title', 'Movement table'));
      const r = { app: getComputedStyle(document.getElementById('app')).display, print: getComputedStyle(document.getElementById('print-root')).display };
      document.getElementById('print-root').innerHTML = '';
      return r;
    });
    check(pr.app === 'none' && pr.print === 'block', 'print media shows only #print-root (' + JSON.stringify(pr) + ')');
    await page.emulateMedia({ media: 'screen' });
    // build.py packaging: highs.js + gzip/base64 wasm start in a Blob worker and solve a tiny LP
    const hi = await page.evaluate(() => new Promise((resolve) => {
      const js = document.getElementById('highs-js');
      const gz = document.getElementById('highs-wasm-gz');
      const ws = document.getElementById('worker-src');
      if (!js || !gz || !ws) { resolve({ error: 'missing payload' }); return; }
      const main = function () {
        self.onmessage = async function (e) {
          try {
            const bin = atob(e.data.trim());
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const wasm = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
            const highs = await Module({ instantiateWasm(imports, receive) { WebAssembly.instantiate(wasm, imports).then((r) => receive(r.instance)); return {}; } });
            const r = highs.solve('Maximize\n obj: x + 2 y\nSubject To\n c1: x + y <= 4\nBounds\n 0 <= x <= 3\n 0 <= y <= 3\nGeneral\n x y\nEnd');
            postMessage({ status: r.Status, obj: r.ObjectiveValue, sro: typeof self.SRO === 'object' });
          } catch (err) { postMessage({ error: String(err && err.message || err) }); }
        };
      };
      const code = js.textContent + '\n;' + ws.textContent + '\n;(' + main.toString() + ')();';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      const timer = setTimeout(() => { w.terminate(); resolve({ error: 'timeout' }); }, 20000);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: 'worker error: ' + (e.message || e) }); };
      w.postMessage(gz.textContent);
    }));
    check(!hi.error && hi.status === 'Optimal' && Math.abs(hi.obj - 7) < 1e-6 && hi.sro, 'inlined HiGHS + worker-src run in a Blob worker from file:// (' + JSON.stringify(hi) + ')');
  }

  // ---- component gallery + color checks (phone and wide) ----------------------------------------------
  if (phone || wide) await gallery(page, tag, vp);

  // ---- console and network ---------------------------------------------------------------------------
  const nonTile = blocked.filter((u) => !TILE_RE.test(u));
  check(consoleErrors.length === 0, 'zero console errors' + (consoleErrors.length ? ':\n    ' + consoleErrors.slice(0, 8).join('\n    ') : ''));
  check(nonTile.length === 0, 'no non-tile network requests' + (nonTile.length ? ': ' + nonTile.slice(0, 5).join(', ') : ''));
  if (ignored.length || blocked.length) console.log('  (ignored ' + ignored.length + ' blocked-tile console messages, ' + blocked.length + ' blocked requests)');
  await context.close();
}

// ---- edge cases -------------------------------------------------------------------------------------
// Harder checks added in review: 320px and 2560px screens, touch input, rapid theme switching,
// blocked storage, long labels, the h() helper, failing views, resizing across 1100px, print colors.
async function openPage(browser, fileUrl, ctxOpts, opts = {}) {
  const context = await browser.newContext(ctxOpts);
  const consoleErrors = [];
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/.test(u)) return route.continue();
    blocked.push(u);
    return route.abort('internetdisconnected');
  });
  if (opts.init) await context.addInitScript(opts.init);
  const page = await context.newPage();
  const expected = opts.expectedErrors || [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const loc = (msg.location() && msg.location().url) || '';
    if (TILE_RE.test(loc) || TILE_RE.test(text)) return;
    if (expected.some((re) => re.test(text))) return;
    consoleErrors.push(text.split('\n')[0]);
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + (err && err.message)));
  await page.goto(fileUrl);
  await waitApp(page);
  return { context, page, consoleErrors, blocked };
}

async function topbarFits(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    for (const b of document.querySelectorAll('#topbar button')) {
      if (!b.getClientRects().length) continue;
      const r = b.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5 || r.width < 44 || r.height < 44) out.push((b.className || b.textContent) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return { vw, scroll: document.documentElement.scrollWidth, bad: out };
  });
}

async function edgeCases(browser, fileUrl) {
  // ---- 320 x 568 phone with touch: top bar fits, long labels wrap, PSG tab bar -------------------
  scope = '320x568';
  console.log('\n== 320x568 (touch, edge cases)');
  {
    const { context, page, consoleErrors } = await openPage(browser, fileUrl, { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    for (const role of ['psg', 'planner']) {
      await page.tap('#topbar .tb-role button[data-role="' + role + '"]');
      await settle(page);
      const f = await topbarFits(page);
      check(f.scroll <= f.vw && f.vw === 320, role + ': no horizontal scroll at 320px (scrollWidth ' + f.scroll + ', viewport ' + f.vw + ')');
      check(f.bad.length === 0, role + ': every top bar button is inside the screen and >= 44px' + (f.bad.length ? ' (' + f.bad.join(', ') + ')' : ''));
      await page.screenshot({ path: path.join(SHOTS, '320x568-dark-' + role + '.png') });
    }
    // planner bottom tabs by touch
    await page.tap('#planner-root .planner-tabbar .tabbar-item[data-tab="map"]');
    await settle(page);
    check((await st(page)).plannerTab === 'map', 'tapping the Map tab selects it');
    const tabsFit = await page.$$eval('#planner-root .planner-tabbar .tabbar-item', (els) => els.every((e) => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.right <= innerWidth + 0.5; }));
    check(tabsFit, 'planner bottom tabs fit 320px and are >= 44px tall');
    // PSG with three tabs and long unbreakable content
    await page.evaluate(() => {
      const ui = window.SRO.ui;
      ['request', 'myrequests', 'profile'].forEach((n) => ui.registerView('psg/' + n, {
        mount(el) { el.append(ui.h('div.card', ui.h('div.list-row-title', 'Supercalifragilistic-unit-designation-1st-PLT-B-CO-3-21-IN-' + n + '-without-any-spaces-at-all'))); },
        update() {}
      }));
      ui.showView('psg/myrequests');
      ui.toast('Request R-0001 cancelled. The planner queue no longer shows it and the slot is free again.', 'success', { timeout: 0, action: { label: 'Undo', onClick() {} } });
    });
    await settle(page);
    const psg = await page.evaluate(() => {
      const bar = document.querySelector('#psg-root .psg-tabbar');
      const items = bar ? [...bar.querySelectorAll('.tabbar-item')] : [];
      const t = document.querySelector('.toast').getBoundingClientRect();
      return {
        scroll: document.documentElement.scrollWidth, vw: innerWidth,
        bar: !!bar && bar.getBoundingClientRect().bottom <= innerHeight + 0.5, items: items.length,
        itemsOk: items.every((e) => e.getBoundingClientRect().height >= 44),
        selected: items.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.tab).join(),
        toast: t.left >= 0 && t.right <= innerWidth + 0.5
      };
    });
    check(psg.scroll <= psg.vw, 'long unbroken text and a long toast cause no horizontal scroll (' + psg.scroll + ')');
    check(psg.bar && psg.items === 3 && psg.itemsOk, 'PSG tab bar shows 3 tabs at the bottom, each >= 44px tall');
    check(psg.selected === 'myrequests', 'PSG tab bar marks My requests selected (' + psg.selected + ')');
    check(psg.toast, 'toast with an action stays inside a 320px screen');
    await page.screenshot({ path: path.join(SHOTS, '320x568-dark-psg-tabs.png') });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    // long modal action label wraps instead of clipping; sheet sits at the bottom
    await page.evaluate(() => window.SRO.ui.modal.open({ title: 'Approve this plan for Day 1, 1200-1800?', body: 'Truck Alpha-1 departs 1220 with 3 stops.', actions: [{ label: 'Cancel' }, { label: 'Approve plan and notify all platoons', kind: 'primary' }] }));
    await settle(page);
    const m = await page.evaluate(() => {
      const r = document.querySelector('.modal').getBoundingClientRect();
      const b = document.querySelector('.modal .btn-primary');
      return { bottom: r.bottom, vh: innerHeight, width: r.width, clipped: b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth + 0.5 };
    });
    check(Math.abs(m.bottom - m.vh) < 2 && Math.abs(m.width - 320) < 2, 'modal is a full-width bottom sheet at 320px');
    check(!m.clipped, 'a long action label wraps inside its button (not clipped)');
    await page.screenshot({ path: path.join(SHOTS, '320x568-dark-modal.png') });
    await page.keyboard.press('Escape');
    // clock sheet by touch: Pause registers while the clock runs at 600x (the sheet re-renders 4x/s)
    await page.tap('#topbar .tb-time');
    await settle(page);
    await page.tap('.modal .clock-speed button[data-speed="600"]');
    await page.tap('.modal .clock-run');
    await page.waitForTimeout(600);
    let toggles = 0;
    for (let i = 0; i < 4; i++) {
      const before = (await st(page)).running;
      await page.tap('.modal .clock-run');
      if ((await st(page)).running !== before) toggles++;
      await page.waitForTimeout(300);
    }
    check(toggles === 4, 'start / pause taps register while the clock runs (' + toggles + '/4)');
    const jumpOneLine = await page.evaluate(() => { const b = document.querySelector('.modal .clock-jump'); return b.getBoundingClientRect().height <= 46; });
    check(jumpOneLine, '"Jump to next window" fits on one line at 320px');
    await page.screenshot({ path: path.join(SHOTS, '320x568-dark-clock.png') });
    await page.tap('.modal-backdrop', { position: { x: 160, y: 30 } });
    await settle(page);
    check(!(await visible(page, '.modal')), 'tapping above the sheet closes it');
    await page.evaluate(() => window.SRO.app.store.dispatch({ type: 'clock/pause' }));
    check(consoleErrors.length === 0, 'zero console errors' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''));
    await context.close();
  }

  // ---- 2560 x 1440: panels and PSG column ----------------------------------------------------------
  scope = '2560x1440';
  console.log('\n== 2560x1440');
  {
    const { context, page, consoleErrors } = await openPage(browser, fileUrl, { viewport: { width: 2560, height: 1440 } });
    const psg = await box(page, '#psg-root');
    check(psg.width === 480 && Math.abs(psg.x + 240 - 1280) < 1 && Math.abs(psg.height - (1440 - psg.y)) < 1, 'PSG column is 480px, centered and full height (' + JSON.stringify(psg) + ')');
    await setRole(page, 'planner');
    const panels = await page.$$eval('#planner-root .pl-view', (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ region: e.dataset.region, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    const by = Object.fromEntries(panels.map((p) => [p.region, p]));
    check(panels.length === 3 && by.left && by.right && by.center && by.center.w > 1500 && by.left.w <= 380 && by.right.w <= 440, 'side panels keep their width and the map takes the rest (' + panels.map((p) => p.region + ' ' + Math.round(p.w)).join(', ') + ')');
    check(by.center && by.center.h > 1300, 'map panel fills the height (' + (by.center && Math.round(by.center.h)) + ')');
    await page.screenshot({ path: path.join(SHOTS, '2560x1440-dark-planner.png') });
    // a second center tab gets its own header row and can be reached
    await page.evaluate(() => window.SRO.ui.plannerTabs.add({ name: 'timeline', label: 'Timeline', icon: 'clock', region: 'center', order: 15, mount(el) { el.append(window.SRO.ui.h('div.card#zz-timeline', 'Timeline')); }, update() {} }));
    await settle(page);
    const ch = await visible(page, '#planner-root .pl-head[data-region="center"] [data-tab="timeline"]');
    check(ch, 'a second center tab shows a center tab header on wide screens');
    if (ch) {
      await page.click('#planner-root .pl-head[data-region="center"] [data-tab="timeline"]');
      await settle(page);
      check(await visible(page, '#zz-timeline') && await visible(page, '#planner-root .pl-view[data-region="left"]'), 'the second center tab opens with the side panels still shown');
    }
    await page.evaluate(() => window.SRO.ui.plannerTabs.remove('timeline'));
    await settle(page);
    check(!(await visible(page, '#planner-root .pl-head[data-region="center"]')) && await visible(page, '#planner-root .pl-view[data-tab="map"]'), 'removing it restores the header-less map');
    check(consoleErrors.length === 0, 'zero console errors' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''));
    await context.close();
  }

  // ---- 1440: rapid theme switching, pre-paint theme, helper, failing views, resize, print --------
  scope = '1440x900 edge';
  console.log('\n== 1440x900 (edge cases)');
  {
    const init = () => {
      document.addEventListener('DOMContentLoaded', () => {
        window.__prePaint = { theme: document.documentElement.getAttribute('data-theme'), role: document.documentElement.getAttribute('data-role'), meta: document.querySelector('meta[name="theme-color"]').getAttribute('content'), booted: !!(window.SRO && window.SRO.app) };
      });
    };
    const { context, page, consoleErrors } = await openPage(browser, fileUrl, { viewport: { width: 1440, height: 900 } }, {
      init, expectedErrors: [/view "planner\/outputs" mount failed: Error: spec-mount-boom/, /view "planner\/scenario" update failed: Error: spec-update-boom/]
    });
    for (let i = 0; i < 31; i++) await page.click('#topbar .tb-theme');
    await settle(page);
    let t = await page.evaluate(() => ({ store: window.SRO.app.store.getState().ui.theme, html: document.documentElement.dataset.theme, meta: document.querySelector('meta[name="theme-color"]').content, label: document.querySelector('#topbar .tb-theme').getAttribute('data-theme-current') }));
    check(t.store === 'light' && t.html === 'light' && t.meta === THEME_COLOR.light && t.label === 'light', '31 rapid theme clicks end on light everywhere (' + JSON.stringify(t) + ')');
    await page.evaluate(() => { for (let i = 0; i < 100; i++) window.SRO.ui.shell.cycleTheme(); window.SRO.ui.shell.setRole('planner'); });
    await settle(page);
    t = await page.evaluate(() => [window.SRO.app.store.getState().ui.theme, document.documentElement.dataset.theme].join());
    check(t === 'night,night', '100 more cycles in one task end on night (' + t + ')');
    await page.reload();
    await waitApp(page);
    const pre = await page.evaluate(() => window.__prePaint);
    check(pre && pre.theme === 'night' && pre.role === 'planner' && pre.meta === THEME_COLOR.night && !pre.booted, 'saved theme, role and theme-color are applied before the app boots (' + JSON.stringify(pre) + ')');
    await page.evaluate(() => { window.SRO.app.store.dispatch({ type: 'theme/set', theme: 'dark' }); });

    const hres = await page.evaluate(() => {
      const h = window.SRO.ui.h;
      const sel = h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'));
      const box = h('input', { checked: true, type: 'checkbox' });
      const svg = h('svg', { viewBox: '0 0 10 10' }, h('text', { x: 1, y: 5 }, 'x'));
      const t = window.SRO.ui.toast('w', 'warning');
      const cls = t.el.className;
      t.close();
      return { sel: sel.value, box: box.checked, svgText: svg.firstChild.namespaceURI, warn: cls };
    });
    check(hres.sel === 'b', 'h("select", { value }) selects the option added as a child (got ' + hres.sel + ')');
    check(hres.box === true, 'h("input", { checked, type }) is checked whatever the key order');
    check(hres.svgText === 'http://www.w3.org/2000/svg', 'h("svg", h("text")) creates SVG text');
    check(/toast-warn/.test(hres.warn), 'toast kind "warning" is treated as warn (' + hres.warn + ')');

    // failing views are contained; the others still mount and update
    const fv = await page.evaluate(async () => {
      const ui = window.SRO.ui;
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let n = 0;
      ui.registerView('planner/outputs', { mount() { throw new Error('spec-mount-boom'); }, update() {} });
      ui.registerView('planner/scenario', { mount() {}, update() { n++; throw new Error('spec-update-boom'); } });
      ui.registerView('planner/queue', { mount(el) { el.append(ui.h('p#zz-q', 'queue ok')); }, update() {} });
      ui.showView('planner/outputs');
      await raf();
      const err = !!document.querySelector('.pl-view[data-tab="outputs"] .view-error');
      ui.showView('planner/scenario');
      await raf();
      window.SRO.app.store.dispatch({ type: 'clock/speed', speed: 60 });
      await raf();
      window.SRO.app.store.dispatch({ type: 'clock/speed', speed: 1 });
      await raf();
      const q = !!document.getElementById('zz-q') && document.getElementById('zz-q').getClientRects().length > 0;
      ['outputs', 'scenario', 'queue'].forEach((x) => ui.plannerTabs.remove(x));
      await raf();
      return { err, q, n, placeholders: document.querySelectorAll('#planner-root .pl-view .placeholder').length };
    });
    check(fv.err, 'a view whose mount throws shows an error notice in its panel');
    check(fv.q, 'other views still mount next to a failing one');
    check(fv.n >= 2, 'a view whose update throws keeps getting updates (' + fv.n + ')');
    check(fv.placeholders === 5, 'removing default tabs brings their placeholders back (' + fv.placeholders + ')');

    // resize across 1100px: hidden views get onHide, ctx.layout follows
    await page.evaluate(() => {
      window.__rlog = [];
      ['map', 'queue', 'plan'].forEach((n) => window.SRO.ui.registerView('planner/' + n, {
        mount(el, ctx) { window.__rlog.push('mount ' + n + ' ' + ctx.layout); },
        update(s, ctx) { window.__rlog.push('update ' + n + ' ' + ctx.layout); },
        onHide() { window.__rlog.push('hide ' + n); },
        onShow() { window.__rlog.push('show ' + n); }
      }));
      // Scenario was the last right-panel tab above; picking Plan then Queue in the same task must
      // leave Plan in the right panel and Queue active
      window.SRO.ui.showView('planner/plan');
      window.SRO.ui.showView('planner/queue');
    });
    await settle(page);
    await page.setViewportSize({ width: 900, height: 900 });
    await settle(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    const rlog = await page.evaluate(() => window.__rlog);
    check(['mount map wide', 'mount queue wide', 'mount plan wide'].every((x) => rlog.includes(x)), 'all three panels mount on a wide screen');
    check(rlog.includes('hide map') && rlog.includes('hide plan') && rlog.includes('update queue tablet'), 'under 1100px only the active tab stays shown and updates with layout tablet');
    check(rlog.includes('show map') && rlog.lastIndexOf('update queue wide') > rlog.indexOf('update queue tablet'), 'back over 1100px the panels show again with layout wide');
    await page.evaluate(() => ['map', 'queue', 'plan'].forEach((x) => window.SRO.ui.plannerTabs.remove(x)));

    // nested modals: Escape closes the top one only
    const nested = await page.evaluate(() => {
      const ui = window.SRO.ui;
      const a = ui.modal.open({ title: 'one', body: 'x' });
      const b = ui.modal.open({ title: 'two', body: 'y' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const r = { a: a.closed, b: b.closed, inertA: a.backdrop.hasAttribute('inert') };
      a.close();
      return r;
    });
    check(!nested.a && nested.b && !nested.inertA, 'Escape closes only the top modal and the one below becomes active again');

    // print: the print-* rules keep their own colors over the generic print reset
    await page.emulateMedia({ media: 'print' });
    const pc = await page.evaluate(() => {
      const pr = document.getElementById('print-root');
      pr.append(window.SRO.ui.h('p.print-sub', 'sub'), window.SRO.ui.h('table', window.SRO.ui.h('tr', window.SRO.ui.h('th', 'Stop'))));
      const r = { sub: getComputedStyle(pr.querySelector('.print-sub')).color, th: getComputedStyle(pr.querySelector('th')).backgroundColor };
      pr.innerHTML = '';
      return r;
    });
    await page.emulateMedia({ media: 'screen' });
    check(pc.sub === 'rgb(68, 68, 68)' && pc.th === 'rgb(238, 238, 238)', 'print: grey sub-line and table header survive the print reset (' + JSON.stringify(pc) + ')');
    check(consoleErrors.length === 0, 'zero unexpected console errors' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''));
    await context.close();
  }

  // ---- storage blocked ---------------------------------------------------------------------------
  scope = '390x844 storage blocked';
  console.log('\n== 390x844 (localStorage blocked)');
  {
    const init = () => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    };
    const { context, page, consoleErrors } = await openPage(browser, fileUrl, { viewport: { width: 390, height: 844 }, hasTouch: true }, { init });
    check((await page.textContent('.toast-root')).includes('blocks local storage'), 'blocked storage: the app starts and says changes are not kept');
    await page.tap('#topbar .tb-role button[data-role="planner"]');
    await page.tap('#topbar .tb-theme');
    await settle(page);
    const s = await st(page);
    check(s.role === 'planner' && s.theme === 'light' && await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'blocked storage: role and theme still switch (in memory)');
    check(consoleErrors.length === 0, 'blocked storage: zero console errors' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''));
    await context.close();
  }
}

// ---- main -------------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = build();
  const fileUrl = pathToFileURL(file).href;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      try { await runViewport(browser, fileUrl, vp); } catch (e) { scope = vp.width + 'x' + vp.height; check(false, 'exception: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
    }
    try { await edgeCases(browser, fileUrl); } catch (e) { check(false, 'exception: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
  } finally {
    await browser.close();
  }
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed' + (notes.length ? ', ' + notes.length + ' note(s)' : '') + '. Screenshots: ' + SHOTS);
  if (failures.length) {
    console.log('FAILURES:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
