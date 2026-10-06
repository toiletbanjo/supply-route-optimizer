// The only place that turns numbers into display text: 24h times, DTGs, MGRS, class labels,
// miles, gallons, durations. Pure functions, no DOM.
//
// Time convention (DESIGN.md section 2): simMin = minutes since Day 1 00:00 local Taiwan time,
// Day 1 = 6 Oct 2026 (notional). DTGs use local zone letter H (UTC+8) so planner and platoon
// times never differ.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const fmt = SRO.core.format = SRO.core.format || {};

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  fmt.DAY1 = { year: 2026, month: 10, day: 6 };     // calendar date of Day 1 (month is 1-based)
  fmt.ZONE_LETTER = 'H';                              // UTC+8
  fmt.NA = 'n/a';

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  // Numeric value of an input, NaN when missing. The global isFinite(null) is true, which used to
  // show a missing time as '0000' / '060000H OCT 26', a missing distance as '0.0 mi' and a missing
  // location as the MGRS of 0N 0E; those now format as 'n/a' (or '' for MGRS).
  function val(x) { return typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN); }
  function wholeMin(simMin) { return Math.floor(simMin + 1e-9); }   // tolerate float clock values
  function mod(a, n) { return ((a % n) + n) % n; }

  // Day number (1-based) of a sim minute.
  fmt.dayOf = function (simMin) { return Math.floor(wholeMin(simMin) / 1440) + 1; };

  // '2000' (24h local, no colon).
  fmt.time24 = function (simMin) {
    simMin = val(simMin);
    if (!isFinite(simMin)) return fmt.NA;
    const m = mod(wholeMin(simMin), 1440);
    return pad2(Math.floor(m / 60)) + pad2(m % 60);
  };

  // '2000' when simMin is on the same day as nowMin, else '0130 Day 2'.
  // With nowMin omitted the day is always shown.
  fmt.dayTime = function (simMin, nowMin) {
    simMin = val(simMin);
    if (!isFinite(simMin)) return fmt.NA;
    const t = fmt.time24(simMin);
    nowMin = val(nowMin);
    if (isFinite(nowMin) && fmt.dayOf(simMin) === fmt.dayOf(nowMin)) return t;
    return t + ' Day ' + fmt.dayOf(simMin);
  };

  // Calendar date of a sim minute -> { year, month (1-12), day, hh, mm }.
  fmt.calendar = function (simMin) {
    const m = wholeMin(simMin);
    const base = Date.UTC(fmt.DAY1.year, fmt.DAY1.month - 1, fmt.DAY1.day);
    const d = new Date(base + Math.floor(m / 1440) * 86400000);
    const mi = mod(m, 1440);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hh: Math.floor(mi / 60), mm: mi % 60 };
  };

  // Date-time group in local zone H: '061430H OCT 26'.
  fmt.dtg = function (simMin) {
    simMin = val(simMin);
    if (!isFinite(simMin)) return fmt.NA;
    const c = fmt.calendar(simMin);
    return pad2(c.day) + pad2(c.hh) + pad2(c.mm) + fmt.ZONE_LETTER + ' ' + MONTHS[c.month - 1] + ' ' + pad2(c.year % 100);
  };

  // Window label: 'Day 1, 0600-1200'. Accepts a window object { start, end } or (start, end).
  fmt.windowLabel = function (start, end) {
    if (start && typeof start === 'object') { end = start.end; start = start.start; }
    start = val(start); end = val(end);
    if (!isFinite(start)) return fmt.NA;
    if (!isFinite(end)) end = start + 360;
    return 'Day ' + fmt.dayOf(start) + ', ' + fmt.time24(start) + '-' + (end % 1440 === 0 && end > start ? '2400' : fmt.time24(end));
  };

  // ---- supply classes -------------------------------------------------------------------
  fmt.CLASS_NAMES = {
    I: 'Food & Water', II: 'Clothing & Equipment', III: 'Fuel', IV: 'Construction Materials',
    V: 'Ammunition', VI: 'Personal Items', VII: 'Major End Items', VIII: 'Medical',
    IX: 'Repair Parts', X: 'Nonmilitary Programs'
  };
  fmt.CLASS_ORDER = ['III', 'I', 'V', 'VIII', 'IX'];   // Phase 1 classes in tie-break order

  function classKey(classId) { return String(classId || '').replace(/^class\s+/i, '').trim().toUpperCase(); }

  // 'Class III (Fuel)'
  fmt.classLabel = function (classId) {
    const k = classKey(classId);
    return fmt.CLASS_NAMES[k] ? 'Class ' + k + ' (' + fmt.CLASS_NAMES[k] + ')' : 'Class ' + k;
  };
  fmt.className = function (classId) { return fmt.CLASS_NAMES[classKey(classId)] || ''; };

  // ---- numbers --------------------------------------------------------------------------
  // Thousands separators, fixed decimals, locale independent: number(12345.67, 1) -> '12,345.7'.
  fmt.number = function (x, decimals) {
    x = val(x);
    if (!isFinite(x)) return fmt.NA;
    const d = decimals || 0;
    const neg = x < 0;
    const s = Math.abs(x).toFixed(d);
    const dot = s.indexOf('.');
    let intPart = dot < 0 ? s : s.slice(0, dot);
    const frac = dot < 0 ? '' : s.slice(dot);
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = intPart + frac;
    return (neg && Number(s) !== 0 ? '-' : '') + out;
  };

  fmt.miles = function (x) { return isFinite(val(x)) ? fmt.number(x, 1) + ' mi' : fmt.NA; };     // '12.3 mi'
  fmt.gallons = function (x) { return isFinite(val(x)) ? fmt.number(x, 0) + ' gal' : fmt.NA; };  // '2,500 gal'
  // '500 gal', '2.5 pallets', '0.25 pallet': whole numbers plain, fractions to at most 2 decimals
  // (one decimal used to show a 0.25-pallet split as '0.3').
  fmt.qty = function (q, unit) {
    const v = val(q);
    let s = fmt.number(v, Number.isInteger(v) ? 0 : 2);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s + (unit ? ' ' + unit : '');
  };

  // '1 h 25 min', '45 min', '2 h'; rounded to whole minutes.
  fmt.duration = function (minutes) {
    minutes = val(minutes);
    if (!isFinite(minutes)) return fmt.NA;
    const total = Math.round(Math.abs(minutes));
    const h = Math.floor(total / 60), m = total % 60;
    const sign = minutes < 0 && total > 0 ? '-' : '';
    if (h === 0) return sign + m + ' min';
    return sign + h + ' h' + (m ? ' ' + m + ' min' : '');
  };

  fmt.latLon = function (lat, lon, decimals) {
    const d = decimals === undefined ? 4 : decimals;
    lat = val(lat); lon = val(lon);
    if (!isFinite(lat) || !isFinite(lon)) return fmt.NA;
    return lat.toFixed(d) + ', ' + lon.toFixed(d);
  };

  // ---- UTM / MGRS (WGS84) -----------------------------------------------------------------
  // Transverse Mercator by the Krueger n-series to 6th order (Karney 2011), accurate to
  // nanometres inside a UTM zone. No external library.
  const WGS84_A = 6378137;
  const WGS84_F = 1 / 298.257223563;
  const K0 = 0.9996;
  const TM = (function () {
    const n = WGS84_F / (2 - WGS84_F);
    const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
    return {
      e: Math.sqrt(WGS84_F * (2 - WGS84_F)),
      A: WGS84_A / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256),
      alpha: [
        n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
        13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
        61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
        49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
        34729 * n5 / 80640 - 3418889 * n6 / 1995840,
        212378941 * n6 / 319334400
      ]
    };
  })();

  function utmZone(lat, lon) {
    let zone = Math.floor((lon + 180) / 6) + 1;
    if (lon >= 180) zone = 60;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;          // Norway
    if (lat >= 72 && lat < 84) {                                            // Svalbard
      if (lon >= 0 && lon < 9) zone = 31;
      else if (lon >= 9 && lon < 21) zone = 33;
      else if (lon >= 21 && lon < 33) zone = 35;
      else if (lon >= 33 && lon < 42) zone = 37;
    }
    return zone;
  }

  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
  function latBand(lat) {
    if (lat < -80 || lat > 84) return null;
    return BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
  }

  // lat/lon (degrees) -> { zone, band, hemisphere, easting, northing } in metres (not truncated).
  // Returns null outside the UTM range (80S..84N).
  fmt.utm = function (lat, lon, forceZone) {
    lat = val(lat); lon = val(lon);
    if (!isFinite(lat) || !isFinite(lon) || lat < -80 || lat > 84) return null;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const zone = forceZone || utmZone(lat, lon);
    const lon0 = (zone - 1) * 6 - 180 + 3;
    const phi = lat * Math.PI / 180;
    let lam = (lon - lon0) * Math.PI / 180;
    if (lam > Math.PI) lam -= 2 * Math.PI; else if (lam < -Math.PI) lam += 2 * Math.PI;
    const e = TM.e;
    const tau = Math.tan(phi);
    const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)));
    const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const cosLam = Math.cos(lam);
    const xiP = Math.atan2(tauP, cosLam);
    const etaP = Math.asinh(Math.sin(lam) / Math.sqrt(tauP * tauP + cosLam * cosLam));
    let xi = xiP, eta = etaP;
    for (let j = 1; j <= 6; j++) {
      const a = TM.alpha[j - 1];
      xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    let northing = K0 * TM.A * xi;
    const easting = K0 * TM.A * eta + 500000;
    if (lat < 0) northing += 10000000;
    return { zone: zone, band: latBand(lat), hemisphere: lat < 0 ? 'S' : 'N', easting: easting, northing: northing };
  };

  const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

  // 100 km square identifier (AA lettering scheme, WGS84).
  function square100k(zone, easting, northing) {
    const set = ((zone - 1) % 6) + 1;                 // 1..6
    const col = Math.floor(easting / 100000);          // 1..8 inside a zone
    const colLetters = COL_SETS[(set - 1) % 3];
    const colLetter = colLetters[mod(col - 1, 8)];
    const row = mod(Math.floor(northing / 100000) + (set % 2 === 0 ? 5 : 0), 20);
    return colLetter + ROW_LETTERS[row];
  }

  // MGRS string, e.g. '51R UH 12345 67890'. precision = digits per coordinate (0..5; 5 = 1 m).
  // Digits are truncated (not rounded), per MGRS convention. Returns '' outside 80S..84N.
  fmt.mgrs = function (lat, lon, precision) {
    if (lat && typeof lat === 'object') { precision = lon; lon = lat.lon !== undefined ? lat.lon : lat.lng; lat = lat.lat; }
    const p = precision === undefined || precision === null ? 5 : Math.max(0, Math.min(5, Math.floor(precision)));
    const u = fmt.utm(lat, lon);
    if (!u) return '';
    const e = Math.floor(u.easting), n = Math.floor(u.northing);
    const head = u.zone + u.band + ' ' + square100k(u.zone, e, n);
    if (p === 0) return head;
    const div = Math.pow(10, 5 - p);
    const digits = function (v) { let s = String(Math.floor(mod(v, 100000) / div)); while (s.length < p) s = '0' + s; return s; };
    return head + ' ' + digits(e) + ' ' + digits(n);
  };
})(typeof self !== 'undefined' ? self : globalThis);
