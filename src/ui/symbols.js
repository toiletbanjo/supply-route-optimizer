// MIL-STD-2525 symbols for the map and for lists (DESIGN.md section 6 'Symbols'), drawn by milsymbol
// (global `ms`) and wrapped as Leaflet divIcons (global `L`). Neither library is touched at load time,
// so this file also loads in Node.
//
//   symbols.platoon(requestOrProfile, { urgency, selected, theme, size }) -> L.divIcon
//       2525 platoon symbol (uniqueDesignation = designator) on an urgency ring: gray Routine,
//       yellow Priority, orange Urgent, red pulsing Immediate (no pulse with prefers-reduced-motion).
//       Badge 'FIX' for fixed-in-place platoons, 'DIR' for other direct-delivery requests.
//   symbols.hub(hub, { theme, size })                          -> L.divIcon (supply installation)
//   symbols.truck(vehicle, { heading, theme, size, label })    -> L.divIcon: cargo / POL vehicle in a ring
//       of the truck's color, a heading pointer and a callsign label in the truck's color.
//   symbols.rally(point, { used, pinned, banned, theme })      -> L.divIcon (Logistics Release Point)
//   symbols.svg(sidc, { size, uniqueDesignation, theme, ... }) -> inline SVG string for lists / cards
//   symbols.refreshInline(rootEl?, theme?) -> count: draws the inline symbols again (theme change)
//   symbols.render(sidc, opts) -> { svg, width, height, anchor: { x, y } } (cached by key)
//   symbols.platoonSidc(requestOrProfile) (branch AR / CAV / EN / FA from the designator, else
//       infantry by mobility), symbols.branchOf(p), symbols.urgencyColor(urgency, theme), symbols.setTheme(theme)
// Every icon uses milsymbol's getAnchor() for iconAnchor. Rendered SVG strings are cached by key.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.ui = SRO.ui || {};
  const S = SRO.ui.symbols = SRO.ui.symbols || {};

  S.SIDC = {
    dismounted: '10031000141211000000',    // infantry platoon
    mechanized: '10031000141211020000',    // infantry, armored / mechanized / tracked, platoon
    motorized: '10031000141211040000',     // infantry, motorized, platoon
    armor: '10031000141205000000',         // armor / armored / mechanized / self-propelled / tracked, platoon
    cavalry: '10031000141213000000',       // reconnaissance / cavalry / scout, platoon
    engineer: '10031000141407000000',      // engineer, platoon
    artillery: '10031000141303000000',     // field artillery, platoon
    hub: 'SFGPUSS---H----',                // supply unit with installation indicator (2525C; same drawing as 2525E)
    cargo: '10031500001401000000',         // utility vehicle
    tanker: '10031500001409000000',        // petroleum, oil and lubricants vehicle
    rally: '10032500003209000000'          // logistics release point
  };

  S.URGENCY = ['Routine', 'Priority', 'Urgent', 'Immediate'];
  // Ring colors per theme. Night keeps the four hues apart but dims them (no white, no bright).
  S.URGENCY_COLORS = {
    dark: { Routine: '#8b96a0', Priority: '#e3c234', Urgent: '#f08a24', Immediate: '#ff4d4f' },
    light: { Routine: '#6b7580', Priority: '#c9a400', Urgent: '#e06a00', Immediate: '#d92d2f' },
    night: { Routine: '#5e4646', Priority: '#9c8a1c', Urgent: '#a85a14', Immediate: '#d8262a' }
  };

  const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  // milsymbol styles per theme. Dark and light keep the standard 2525 frame colors; night draws the
  // whole symbol in one dim red (light discipline: no white or blue).
  const STYLE = {
    dark: { colorMode: 'Light', infoColor: '#e8ecef', infoOutlineColor: '#0b1014', infoOutlineWidth: 5, outlineColor: '#0b1014', outlineWidth: 0 },
    light: { colorMode: 'Light', infoColor: '#14191e', infoOutlineColor: '#ffffff', infoOutlineWidth: 5, outlineColor: '#ffffff', outlineWidth: 0 },
    night: { colorMode: 'Light', monoColor: '#c23a32', fill: false, infoColor: '#b8342d', infoOutlineColor: '#000000', infoOutlineWidth: 5, outlineColor: '#000000', outlineWidth: 3 }
  };

  // Control measures (rally / LRP) are black line work in 2525; on the dark theme they are drawn light.
  const CONTROL_STYLE = { dark: { monoColor: '#dbe2e8' } };

  S.theme = null;
  S.setTheme = function (theme) { S.theme = STYLE[theme] ? theme : null; };
  function themeOf(opts) {
    const t = (opts && opts.theme) || S.theme;
    if (STYLE[t]) return t;
    try {
      const d = root.document && root.document.documentElement && root.document.documentElement.getAttribute('data-theme');
      if (STYLE[d]) return d;
    } catch (e) { /* no document */ }
    return 'dark';
  }
  S.urgencyColor = function (urgency, theme) {
    const t = S.URGENCY_COLORS[STYLE[theme] ? theme : themeOf()];
    return t[urgency] || t.Routine;
  };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  S.escape = esc;
  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(128,128,128,' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  S.hexToRgba = hexToRgba;
  // WCAG contrast ratio of two #rrggbb colors, and the darker or lighter label text that reads best on bg.
  function relLum(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 0.2;
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
      .reduce(function (acc, v, i) { return acc + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  S.contrast = function (a, b) { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  S.textOn = function (bg, dark, light) {
    dark = dark || '#0b1014'; light = light || '#ffffff';
    return S.contrast(bg, dark) >= S.contrast(bg, light) ? dark : light;
  };
  // Map labels are one line; very long names are clipped with an ellipsis (full name stays in tooltips).
  function clip(str, max) { str = String(str === undefined || str === null ? '' : str); return str.length > max ? str.slice(0, max - 1).replace(/\s+$/, '') + '\u2026' : str; }
  S.clip = clip;
  S.LABEL_MAX = { designator: 16, hub: 22, rally: 6 };

  // ---- milsymbol rendering (cached) -----------------------------------------------------------
  const cache = new Map();
  const CACHE_MAX = 600;
  S.cacheSize = function () { return cache.size; };
  S.clearCache = function () { cache.clear(); };

  S.render = function (sidc, opts) {
    const o = opts || {};
    const theme = themeOf(o);
    const size = o.size || 24;
    const control = o.control ? 1 : 0;
    const key = [sidc, size, theme, control, o.uniqueDesignation || '', o.higherFormation || '', o.additionalInformation || '', o.infoFields === false ? 0 : 1].join('|');
    let r = cache.get(key);
    if (r) return r;
    if (typeof root.ms === 'undefined' || !root.ms.Symbol) throw new Error('milsymbol (ms) is not loaded');
    const style = Object.assign({ size: size, fontfamily: FONT, simpleStatusModifier: true }, STYLE[theme], control ? CONTROL_STYLE[theme] : null);
    if (o.infoFields === false) style.infoFields = false;
    const fields = {};
    ['uniqueDesignation', 'higherFormation', 'additionalInformation'].forEach(function (k) { if (o[k]) fields[k] = String(o[k]); });
    const sym = new root.ms.Symbol(sidc, Object.assign({}, style, fields));
    const sz = sym.getSize(), an = sym.getAnchor();
    r = { svg: sym.asSVG(), width: Math.ceil(sz.width), height: Math.ceil(sz.height), anchor: { x: an.x, y: an.y }, valid: sym.isValid(), sidc: sidc };
    cache.set(key, r);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return r;
  };

  S.isValid = function (sidc) { return S.render(sidc, { size: 20, infoFields: false }).valid; };

  // Small inline symbol for lists / cards. The span keeps its SIDC and options (data-sidc, data-sym)
  // so S.refreshInline() can draw it again in a new theme: a symbol drawn in the dark or light style
  // and only filtered red at night reads as a red-filled (hostile) frame.
  const INLINE_KEYS = ['size', 'uniqueDesignation', 'higherFormation', 'additionalInformation', 'infoFields', 'control'];
  function inlineHtml(sidc, o) {
    const r = S.render(sidc, o);
    const keep = {};
    INLINE_KEYS.forEach(function (k) { if (o[k] !== undefined) keep[k] = o[k]; });
    const cls = 'sro-sym-inline' + (o.className ? ' ' + o.className : '');
    return { width: r.width, height: r.height, svg: r.svg, html: '<span class="' + cls + '" style="width:' + r.width + 'px;height:' + r.height + 'px" role="img" aria-label="' + esc(o.label || 'symbol') +
      '" data-sidc="' + esc(sidc) + '" data-sym="' + esc(JSON.stringify(keep)) + '">' + r.svg + '</span>' };
  }
  S.svg = function (sidc, opts) {
    const o = Object.assign({ size: 18, control: sidc === S.SIDC.rally }, opts || {});
    S.ensureStyles();
    return inlineHtml(sidc, o).html;
  };
  // Draw every inline symbol under root again in the current (or given) theme; the shell calls it
  // when the theme changes.
  S.refreshInline = function (rootEl, theme) {
    const scope = rootEl || (root.document && root.document.body);
    if (!scope || !scope.querySelectorAll) return 0;
    let n = 0;
    Array.prototype.forEach.call(scope.querySelectorAll('.sro-sym-inline[data-sidc]'), function (el) {
      let o = {};
      try { o = JSON.parse(el.getAttribute('data-sym') || '{}') || {}; } catch (e) { o = {}; }
      if (theme) o.theme = theme;
      try {
        const x = inlineHtml(el.getAttribute('data-sidc'), o);
        el.innerHTML = x.svg;
        el.style.width = x.width + 'px';
        el.style.height = x.height + 'px';
        n++;
      } catch (e) { /* milsymbol missing: keep the old drawing */ }
    });
    return n;
  };

  // ---- platoons ---------------------------------------------------------------------------------
  // The branch at the end of the designator or unit name ('2/B/5-86AR', '1st PLT, B TRP, 4-98 CAV')
  // picks the 2525D entity: AR armor, CAV reconnaissance / cavalry, EN engineer, FA field artillery.
  // Infantry (IN, or no branch) shows how it moves: dismounted, mechanized (tracked) or motorized.
  // Fixed-in-place uses the unit's own mounted / dismounted SIDC ("fixed" shows as a label).
  const BRANCH_SIDC = { AR: 'armor', CAV: 'cavalry', EN: 'engineer', FA: 'artillery' };
  S.branchOf = function (p) {
    const m = /(?:\d|\s)(IN|AR|CAV|EN|FA)$/i.exec(String((p && (p.designator || p.unitName)) || '').trim());
    return m ? m[1].toUpperCase() : null;
  };
  S.platoonSidc = function (p) {
    p = p || {};
    const branch = S.branchOf(p);
    if (BRANCH_SIDC[branch]) return S.SIDC[BRANCH_SIDC[branch]];
    let mob = p.mobility || 'mounted';
    if (mob === 'fixed') mob = p.baseMobility || p.profileMobility || 'dismounted';
    if (mob === 'dismounted') return S.SIDC.dismounted;
    if (p.vehicle === 'tracked') return S.SIDC.mechanized;
    return S.SIDC.motorized;
  };
  function designatorOf(p) {
    if (p.designator) return p.designator;
    const sc = SRO.data && SRO.data.scenario;
    if (p.unitName && sc && sc.designatorFor) return sc.designatorFor(p.unitName);
    return p.unitName || '';
  }

  function L() {
    if (typeof root.L === 'undefined' || !root.L.divIcon) throw new Error('Leaflet (L) is not loaded');
    S.ensureStyles();
    return root.L;
  }

  // Ring radius around a unit frame of milsymbol size s (frame 1.5 s x s plus echelon dots).
  function ringRadius(size) { return Math.round(size * 0.98 + 2); }

  S.platoon = function (p, opts) {
    p = p || {};
    const o = opts || {};
    const theme = themeOf(o);
    const size = o.size || 24;
    const urgency = o.urgency || p.urgency || p.urgencyRequested || 'Routine';
    const sel = !!o.selected;
    const badgeText = p.mobility === 'fixed' ? 'FIX' : p.directOnly ? 'DIR' : '';
    const r = S.render(o.sidc || S.platoonSidc(p), { size: size, theme: theme, uniqueDesignation: o.showDesignation === false ? '' : clip(designatorOf(p), S.LABEL_MAX.designator) });
    const color = S.urgencyColor(urgency, theme);
    const rad = ringRadius(size);
    const ring = '<span class="sro-ring sro-urg-' + esc(urgency) + '" style="left:' + (r.anchor.x - rad).toFixed(1) + 'px;top:' + (r.anchor.y - rad).toFixed(1) +
      'px;width:' + 2 * rad + 'px;height:' + 2 * rad + 'px;--sro-ring:' + color + ';--sro-ring-fill:' + hexToRgba(color, theme === 'night' ? 0.16 : 0.22) + '"></span>';
    const badge = badgeText ? '<span class="sro-badge sro-badge-fixed" style="left:' + (r.anchor.x + rad - 12).toFixed(1) + 'px;top:' + (r.anchor.y + rad - 10).toFixed(1) + 'px">' + badgeText + '</span>' : '';
    const html = '<div class="sro-sym sro-plt' + (sel ? ' sro-selected' : '') + '" data-urgency="' + esc(urgency) + '" style="width:' + r.width + 'px;height:' + r.height + 'px">' +
      ring + r.svg + badge + '</div>';
    return L().divIcon({
      className: 'sro-icon sro-icon-platoon',
      html: html,
      iconSize: [r.width, r.height],
      iconAnchor: [r.anchor.x, r.anchor.y],
      tooltipAnchor: [rad + 4, 0],
      popupAnchor: [0, -rad]
    });
  };

  // ---- hubs -------------------------------------------------------------------------------------
  S.hub = function (hub, opts) {
    hub = hub || {};
    const o = opts || {};
    const theme = themeOf(o);
    const r = S.render(o.sidc || S.SIDC.hub, { size: o.size || 26, theme: theme, uniqueDesignation: clip(o.label !== undefined ? o.label : String(hub.name || hub.id || '').toUpperCase(), S.LABEL_MAX.hub) });
    const html = '<div class="sro-sym sro-hub" style="width:' + r.width + 'px;height:' + r.height + 'px">' + r.svg + '</div>';
    return L().divIcon({ className: 'sro-icon sro-icon-hub', html: html, iconSize: [r.width, r.height], iconAnchor: [r.anchor.x, r.anchor.y], tooltipAnchor: [16, 0] });
  };

  // ---- trucks -----------------------------------------------------------------------------------
  S.truckSidc = function (v) { return v && (v.type === 'tanker' || v.type === 'fuel') ? S.SIDC.tanker : S.SIDC.cargo; };
  // Short callsign for the label: 'Alpha-2' -> 'A-2'.
  S.shortCallsign = function (id) {
    const m = /^([A-Za-z])[A-Za-z]*-(\d+)$/.exec(String(id || ''));
    return m ? m[1].toUpperCase() + '-' + m[2] : String(id || '');
  };
  S.truck = function (v, opts) {
    v = v || {};
    const o = opts || {};
    const theme = themeOf(o);
    const size = o.size || 20;
    const r = S.render(S.truckSidc(v), { size: size, theme: theme, infoFields: false });
    const color = v.color || '#2F6FE0';
    const rad = Math.round(size * 0.95 + 2);
    const label = o.label !== undefined ? o.label : (v.label || S.shortCallsign(v.id));
    const heading = isFinite(o.heading) ? o.heading : (isFinite(v.heading) ? v.heading : null);
    const cx = r.anchor.x, cy = r.anchor.y;
    // label chip text: dark or light, whichever reads better on this truck color (night: always black)
    const fg = theme === 'night' ? '#000000' : S.textOn(color);
    const html = '<div class="sro-sym sro-truck" data-truck="' + esc(v.id) + '" style="width:' + r.width + 'px;height:' + r.height + 'px;--sro-truck:' + color + ';--sro-truck-fg:' + fg + '">' +
      '<span class="sro-truck-ring" style="left:' + (cx - rad) + 'px;top:' + (cy - rad) + 'px;width:' + 2 * rad + 'px;height:' + 2 * rad + 'px"></span>' +
      '<span class="sro-heading' + (heading === null ? ' sro-heading-none' : '') + '" style="left:' + (cx - rad - 7) + 'px;top:' + (cy - rad - 7) + 'px;width:' + (2 * rad + 14) + 'px;height:' + (2 * rad + 14) +
      'px;transform:rotate(' + (heading || 0).toFixed(1) + 'deg)"><i></i></span>' +
      r.svg +
      (label ? '<span class="sro-truck-label" style="left:' + cx + 'px;top:' + (cy + rad + 3) + 'px">' + esc(label) + '</span>' : '') +
      '</div>';
    return L().divIcon({ className: 'sro-icon sro-icon-truck', html: html, iconSize: [r.width, r.height], iconAnchor: [cx, cy], tooltipAnchor: [rad + 4, 0] });
  };

  // ---- rally / drop points ---------------------------------------------------------------------
  S.rally = function (pt, opts) {
    pt = pt || {};
    const o = Object.assign({}, pt, opts || {});
    const theme = themeOf(o);
    const label = o.label !== undefined ? o.label : (pt.label || '');
    const r = S.render(S.SIDC.rally, { size: o.size || 22, theme: theme, uniqueDesignation: clip(label, S.LABEL_MAX.rally), control: true });
    const state = o.banned ? 'banned' : o.used ? 'used' : 'candidate';
    const cx = r.anchor.x;
    // badge sits left of the LRP box (the rally letter is drawn top right of it)
    const bx = 'right:' + (r.width - cx + Math.round(r.height * 0.32)).toFixed(0) + 'px;top:0';
    const badge = o.banned ? '<span class="sro-badge sro-badge-ban" style="' + bx + '">NO</span>'
      : o.pinned ? '<span class="sro-badge sro-badge-pin" style="' + bx + '">PIN</span>' : '';
    const html = '<div class="sro-sym sro-rally sro-rally-' + state + (o.pinned ? ' sro-rally-pinned' : '') + '" style="width:' + r.width + 'px;height:' + r.height + 'px">' + r.svg + badge + '</div>';
    return L().divIcon({ className: 'sro-icon sro-icon-rally', html: html, iconSize: [r.width, r.height], iconAnchor: [r.anchor.x, r.anchor.y], tooltipAnchor: [10, -r.anchor.y / 2] });
  };

  // ---- CSS (injected once; uses theme tokens with fallbacks) ------------------------------------
  S.CSS = [
    'html[data-theme="dark"],[data-sro-theme="dark"]{--sro-sel:#e8ecef;--sro-sel-gap:#0b1014;--sro-badge-bg:#e8ecef;--sro-badge-fg:#0b1014;--sro-pin:#6fbf8a}',
    'html[data-theme="light"],[data-sro-theme="light"]{--sro-sel:#1b2329;--sro-sel-gap:#ffffff;--sro-badge-bg:#1b2329;--sro-badge-fg:#ffffff;--sro-pin:#2f7d4f}',
    'html[data-theme="night"],[data-sro-theme="night"]{--sro-sel:#c23a32;--sro-sel-gap:#000000;--sro-badge-bg:#7a1f1a;--sro-badge-fg:#000000;--sro-pin:#7a1f1a}',
    '.sro-icon{background:none;border:0}',
    '.sro-sym{position:relative;line-height:0}',
    '.sro-sym svg{position:relative;display:block;overflow:visible}',
    '.sro-sym-inline{display:inline-block;vertical-align:middle;line-height:0}',
    '.sro-sym-inline svg{display:block}',
    '.sro-ring{position:absolute;box-sizing:border-box;border-radius:50%;border:3px solid var(--sro-ring);background:var(--sro-ring-fill);pointer-events:none}',
    '.sro-urg-Immediate{border-width:3.5px}',
    '.sro-urg-Immediate::after{content:"";position:absolute;inset:-3.5px;border-radius:50%;border:3px solid var(--sro-ring);animation:sro-pulse 1.4s ease-out infinite}',
    '@keyframes sro-pulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.75);opacity:0}}',
    '@media (prefers-reduced-motion: reduce){.sro-urg-Immediate::after{animation:none;transform:scale(1.22);opacity:.7}}',
    '.sro-selected .sro-ring{box-shadow:0 0 0 2px var(--sro-sel-gap,#0b1014),0 0 0 4px var(--sro-sel,#e8ecef)}',
    '.sro-badge{position:absolute;font:700 9px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.04em;padding:2px 3px;border-radius:3px;white-space:nowrap;pointer-events:none}',
    '.sro-badge-fixed{background:var(--sro-badge-bg,#e8ecef);color:var(--sro-badge-fg,#0b1014)}',
    '.sro-badge-pin{background:var(--sro-pin,#6fbf8a);color:#0b1014}',
    '.sro-badge-ban{background:#d92d2f;color:#fff}',
    '.sro-rally-candidate svg{opacity:.55}',
    '.sro-rally-banned svg{opacity:.45}',
    '.sro-rally-banned svg{filter:grayscale(1)}',
    '.sro-truck-ring{position:absolute;box-sizing:border-box;border-radius:50%;border:3px solid var(--sro-truck);background:var(--sro-truck-fill,rgba(11,16,20,.55));pointer-events:none}',
    '.sro-heading{position:absolute;pointer-events:none;transform-origin:50% 50%}',
    '.sro-heading i{position:absolute;left:50%;top:0;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid var(--sro-truck)}',
    '.sro-heading-none{display:none}',
    '.sro-truck-label{position:absolute;transform:translateX(-50%);font:700 11px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-variant-numeric:tabular-nums;padding:3px 5px;border-radius:4px;background:var(--sro-truck);color:var(--sro-truck-fg,#0b1014);white-space:nowrap;max-width:120px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none}',
    '[data-sro-theme="light"] .sro-truck-ring{--sro-truck-fill:rgba(255,255,255,.7)}',
    '[data-sro-theme="light"] .sro-truck-label{box-shadow:0 0 0 1px rgba(255,255,255,.8)}',
    '[data-sro-theme="night"] .sro-truck-ring{--sro-truck-fill:rgba(0,0,0,.7)}',
    '[data-sro-theme="night"] .sro-truck-label{color:#000;box-shadow:none}',
    '[data-sro-theme="night"] .sro-truck,html[data-theme="night"] .sro-truck{filter:brightness(.68)}',
    '[data-sro-theme="night"] .sro-badge-ban,html[data-theme="night"] .sro-badge-ban{background:#8c1d1a;color:#000}',
    '[data-sro-theme="night"] .sro-badge-pin,html[data-theme="night"] .sro-badge-pin{color:#000}'
  ].join('\n');

  S.ensureStyles = function (doc) {
    doc = doc || root.document;
    if (!doc || doc.getElementById('sro-symbols-css')) return;
    const st = doc.createElement('style');
    st.id = 'sro-symbols-css';
    st.textContent = S.CSS;
    (doc.head || doc.documentElement).appendChild(st);
  };
})(typeof self !== 'undefined' ? self : globalThis);
