// Seeded sample request generator (spec-answers.md: 19 synthetic requests, fixed seed, changeable).
// Pure and deterministic: same seed and ctx -> identical output. No DOM.
//
// Mix (per spec): mostly Routine/Priority, 2-3 Urgent, exactly 1 Immediate (an Urgent request that
// escalates through urgency.js); fuel, food and ammo most common; mixed mounted/dismounted with 1-2
// fixed in place; spread over north/central/south/east; platoons a few km off a rally-candidate
// grid point, moved inland so they stay on land; NLTs inside the next one or two 6 h windows;
// a few carry a desired-pickup hint.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const S = SRO.core.samples = SRO.core.samples || {};

  S.DEFAULT_SEED = 20261005;
  S.COUNT = 19;
  S.REGIONS = ['north', 'central', 'south', 'east'];

  const KM_PER_MI = 1.609344;
  const D2R = Math.PI / 180;

  // Rough ridge line of the Central Mountain Range, [lat, lon]. Offsets point toward it (inland).
  const SPINE = [[25.00, 121.45], [24.55, 121.30], [24.10, 121.15], [23.60, 121.00], [23.10, 120.85], [22.60, 120.75], [22.10, 120.78]];

  // NLT window per tier, minutes after now (rounded to 30 min). All within 12 h = the next two windows.
  const NLT_RANGE = { Routine: [480, 720], Priority: [360, 660], Urgent: [240, 540], Immediate: [360, 600] };
  // Days of supply asked for per tier.
  const DAYS_RANGE = { Routine: [2, 4], Priority: [1.5, 3], Urgent: [1.5, 3], Immediate: [1.5, 3] };

  const ITEM_WEIGHTS = {
    III: [['diesel', 7], ['gasoline', 1.5], ['oil', 1.5]],
    'III-dismounted': [['diesel', 3], ['gasoline', 4], ['oil', 3]],   // generators and small engines
    I: [['mre', 4.5], ['water-bottled', 3], ['water-bulk', 2.5]],
    V: [['small-arms', 5.5], ['grenades', 1.5], ['mortar', 2], ['at4', 1]],
    VIII: [['ifak-refill', 4], ['cls-refill', 3], ['med-kit', 2], ['litters', 1]],
    IX: [['tires', 3], ['batteries', 3], ['filters', 2.5], ['other-part', 1.5]]
  };
  const SECONDARY_CLASS_WEIGHTS = [['III', 2.5], ['I', 3.5], ['V', 2.5], ['VIII', 1], ['IX', 0.5]];

  const PART_DESCRIPTIONS = [
    'Alternator for 5 kW generator', 'Hydraulic hose assembly, 1 m', 'Starter motor, light tactical vehicle',
    'Radiator hoses and clamps', 'Fuel pump, medium truck', 'Brake pads, light tactical vehicle'
  ];
  const REMARKS = [
    'Call on arrival; we will send a guide.', 'Road to our position is narrow; small trucks only.',
    'Need this before dark.', 'Can meet at the pickup point any time after 1000.',
    'Bring empty cans back if possible.', 'Gate on the east side of the compound.',
    'Expect light traffic on the approach road.', 'Will have a forklift at the pickup point.'
  ];

  function hav(a, b) {   // km
    const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function nearestGrid(grid, p) {
    let best = null, bd = Infinity;
    grid.forEach(function (g) { const d = hav(p, g); if (d < bd) { bd = d; best = g; } });
    return best;
  }
  function bearingDeg(a, b) {
    const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  function destination(p, brg, km) {   // small distances: local flat-earth step
    const dLat = km * Math.cos(brg * D2R) / 111.2;
    const dLon = km * Math.sin(brg * D2R) / (111.2 * Math.cos(p.lat * D2R));
    return { lat: p.lat + dLat, lon: p.lon + dLon };
  }
  function nearestOnSpine(p) {
    const kx = Math.cos(p.lat * D2R);
    let best = null, bd = Infinity;
    for (let i = 1; i < SPINE.length; i++) {
      const ax = SPINE[i - 1][1] * kx, ay = SPINE[i - 1][0], bx = SPINE[i][1] * kx, by = SPINE[i][0];
      const px = p.lon * kx, py = p.lat;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = (qx - px) * (qx - px) + (qy - py) * (qy - py);
      if (d < bd) { bd = d; best = { lat: qy, lon: qx / kx }; }
    }
    return best;
  }
  function r5(x) { return Math.round(x * 1e5) / 1e5; }
  function tidy(x) { return Math.round(x * 1e6) / 1e6; }
  function weighted(rng, pairs) {
    let total = 0;
    pairs.forEach(function (p) { total += p[1]; });
    let x = rng() * total;
    for (let i = 0; i < pairs.length; i++) { x -= pairs[i][1]; if (x < 0) return pairs[i][0]; }
    return pairs[pairs.length - 1][0];
  }
  function between(rng, lo, hi) { return lo + rng() * (hi - lo); }
  function roundTo(x, step) { return tidy(Math.round(x / step) * step); }
  function ceilTo(x, step) { return tidy(Math.ceil(x / step - 1e-9) * step); }
  function floorTo(x, step) { return tidy(Math.floor(x / step + 1e-9) * step); }
  function repeat(value, n) { const a = []; for (let i = 0; i < n; i++) a.push(value); return a; }

  // generate(seed, ctx) -> array of request objects (DESIGN.md section 3).
  // ctx = { nowMin = 360, grid, catalog, scenario, dailyUse (settings.dailyUse), mobility
  //         (settings.mobility), existingIds: [] (request ids already used), windowId = null,
  //         excludeUnitNames: [] (e.g. the user's own profile), count = 19 }
  S.generate = function (seed, ctx) {
    ctx = ctx || {};
    seed = (seed === undefined || seed === null) ? S.DEFAULT_SEED : seed;
    const rng = SRO.util.rng(seed);
    const urgency = SRO.core.urgency;
    const grid = ctx.grid || SRO.data.grid;
    const catalog = ctx.catalog || SRO.data.catalog;
    const scenario = ctx.scenario || SRO.data.scenario;
    const helpers = SRO.data.catalogHelpers;
    const dailyUse = ctx.dailyUse || (helpers ? helpers.defaultDailyUse() : null);
    const mobilityCfg = ctx.mobility || scenario.mobility;
    const nowMin = typeof ctx.nowMin === 'number' ? ctx.nowMin : 360;
    const count = typeof ctx.count === 'number' && ctx.count >= 0 ? Math.floor(ctx.count) : S.COUNT;
    const insideTaiwan = scenario.insideTaiwan;

    const itemsById = {};
    catalog.items.forEach(function (it) { itemsById[it.id] = it; });
    const hubs = grid.filter(function (g) { return g.kind === 'hub'; });
    const rallyPts = grid.filter(function (g) { return g.kind !== 'hub' && g.rallyCandidate; });

    // ---- plan the mix --------------------------------------------------------------------
    // Regions: an even split, the remainder going to randomly chosen regions.
    const base = Math.floor(count / S.REGIONS.length);
    const extraRegions = rng.shuffle(S.REGIONS.slice()).slice(0, count - base * S.REGIONS.length);
    let regions = [];
    S.REGIONS.forEach(function (r) { regions = regions.concat(repeat(r, base + (extraRegions.indexOf(r) >= 0 ? 1 : 0))); });
    rng.shuffle(regions);

    // Tiers: 1 Immediate (requested Urgent), 2-3 Urgent, ~40% of the rest Priority, others Routine.
    const nImm = count >= 1 ? 1 : 0;
    const nUrgent = Math.min(2 + rng.int(2), Math.max(0, count - nImm));
    const nPriority = Math.max(0, Math.round((count - nImm - nUrgent) * 0.4));
    const tiers = rng.shuffle(repeat('Immediate', nImm).concat(repeat('Urgent', nUrgent), repeat('Priority', nPriority),
      repeat('Routine', count - nImm - nUrgent - nPriority)));
    const immediateMode = rng() < 0.5 ? 'computed' : 'reported';

    // Mobility: 1-2 fixed in place, ~40% of the rest dismounted, the others mounted.
    const nFixed = Math.min(1 + rng.int(2), count);
    const nDis = Math.max(0, Math.round((count - nFixed) * 0.4));
    const mobility = rng.shuffle(repeat('fixed', nFixed).concat(repeat('dismounted', nDis), repeat('mounted', count - nFixed - nDis)));

    // Primary class: fuel, food and ammo dominate; 10% each medical and repair parts.
    const nVIII = Math.max(1, Math.round(count * 0.1)), nIX = Math.max(1, Math.round(count * 0.1));
    const rest = count - nVIII - nIX;
    const nIII = Math.round(rest * 0.34) + rng.int(2), nV = Math.round(rest * 0.28) + rng.int(2);
    const classPlan = repeat('III', nIII).concat(repeat('V', nV), repeat('I', rest - nIII - nV), repeat('VIII', nVIII), repeat('IX', nIX));
    while (classPlan.length < count) classPlan.push('III');   // only for very small counts
    const primaryClass = rng.shuffle(classPlan);

    // Unit names, distinct.
    const exclude = ctx.excludeUnitNames || [];
    let names = rng.shuffle(scenario.unitNames.filter(function (n) { return exclude.indexOf(n) < 0; }));
    if (!names.length) names = scenario.unitNames.slice();   // everything excluded: reuse the pool

    // Anchors per region (rally-candidate grid points), drawn without replacement then recycled.
    // An edited grid may leave a region without rally candidates: that region then draws from all
    // rally candidates (or from every grid point if there are none at all).
    const anchorPools = {};
    const anyAnchors = rallyPts.length ? rallyPts : grid;
    S.REGIONS.forEach(function (r) {
      const own = rallyPts.filter(function (g) { return g.region === r; });
      anchorPools[r] = { list: rng.shuffle((own.length ? own : anyAnchors).slice()), next: 0 };
    });
    function takeAnchor(region, filter) {
      const pool = anchorPools[region];
      const n = pool.list.length;
      if (!n) throw new Error('samples.generate needs at least one grid point');
      for (let k = 0; k < n; k++) {
        const a = pool.list[(pool.next + k) % n];
        if (!filter || filter(a)) {
          // move the chosen one into the current slot so the rotation stays fair
          const i = (pool.next + k) % n, j = pool.next % n;
          const t = pool.list[i]; pool.list[i] = pool.list[j]; pool.list[j] = t;
          pool.next += 1;
          return a;
        }
      }
      return takeAnchor(region, null);
    }

    // Desired-pickup hints on 3-5 requests that can travel.
    const movable = [];
    mobility.forEach(function (m, i) { if (m !== 'fixed') movable.push(i); });
    const hintIdx = rng.shuffle(movable).slice(0, Math.min(movable.length, 3 + rng.int(3)));

    // ---- line builders ---------------------------------------------------------------------
    function rateOf(itemId, option) {
      return urgency.dailyUseFor({ itemId: itemId, option: option }, catalog, dailyUse);
    }
    function pickOption(item) {
      if (item.freeText) return rng.pick(PART_DESCRIPTIONS);
      return rng.pick(item.options).id;
    }
    function itemOk(item, tier, used, strict) {
      if (used.indexOf(item.id) >= 0) return false;
      const needsRate = tier === 'Urgent' || tier === 'Immediate';
      if (needsRate && (item.dailyUse === null || item.dailyUse === undefined)) return false;
      if (strict && !(item.dailyUse >= 3 * item.step)) return false;   // fine enough to land under 24 h
      return true;
    }
    function pickItem(classId, tier, used, strict, mob) {
      const key = classId === 'III' && mob === 'dismounted' ? 'III-dismounted' : classId;
      const pairs = ITEM_WEIGHTS[key].filter(function (p) { return itemOk(itemsById[p[0]], tier, used, strict); });
      if (!pairs.length) return null;
      return itemsById[weighted(rng, pairs)];
    }
    function makeLine(item, tier) {
      const option = pickOption(item);
      const s = helpers.spec(item.id, item.freeText ? null : option);
      const rate = rateOf(item.id, option);
      const step = item.step;
      let qty;
      if (rate === null) {
        qty = 1 + rng.int(2);
      } else {
        const days = between(rng, DAYS_RANGE[tier][0], DAYS_RANGE[tier][1]);
        const hi = Math.min(s.maxQty, floorTo(urgency.OVER_DAILY_FACTOR * rate, step));
        qty = Math.max(step, Math.min(hi, roundTo(rate * days, step)));
      }
      return { classId: item.classId, itemId: item.id, option: option, qty: qty, unit: item.unit, onHand: null };
    }

    // ---- build ---------------------------------------------------------------------------
    const usedIds = (ctx.existingIds || []).slice();
    const out = [];
    for (let i = 0; i < count; i++) {
      const tier = tiers[i];
      const requested = tier === 'Immediate' ? 'Urgent' : tier;
      const mob = mobility[i];
      const region = regions[i];

      // Location: a few km off an anchor, toward the mountain spine (inland).
      const anchor = takeAnchor(region, tier === 'Immediate'
        ? function (a) { return hubs.some(function (h) { return hav(a, h) <= 60; }); } : null);
      const toSpine = nearestOnSpine(anchor);
      const inland = bearingDeg(anchor, toSpine);
      let loc = null;
      for (let tries = 0; tries < 8 && !loc; tries++) {
        const p = destination(anchor, inland + between(rng, -40, 40), between(rng, 1.5, 4));
        if (!insideTaiwan || insideTaiwan(p.lat, p.lon)) loc = p;
      }
      if (!loc) loc = destination(anchor, inland, 1.5);
      loc = { lat: r5(loc.lat), lon: r5(loc.lon) };
      const snap = nearestGrid(grid, loc);

      // Lines: a primary line from the planned class, sometimes one or two more.
      const used = [];
      // The Immediate request is always fuel, food or ammo, on an item fine-grained enough to show
      // under 24 h of supply.
      const strict = tier === 'Immediate';
      const lowOnHand = strict && immediateMode === 'computed';
      let pClass = primaryClass[i];
      if (strict && ['III', 'I', 'V'].indexOf(pClass) < 0) pClass = rng.pick(['III', 'I', 'V']);
      const pItem = pickItem(pClass, tier, used, strict, mob) || pickItem('III', tier, used, strict, mob);
      const lines = [makeLine(pItem, tier)];
      used.push(pItem.id);
      const nExtra = rng() < 0.45 ? (rng() < 0.33 ? 2 : 1) : 0;
      for (let k = 0; k < nExtra; k++) {
        const it = pickItem(weighted(rng, SECONDARY_CLASS_WEIGHTS), tier, used, false, mob);
        if (it) { lines.push(makeLine(it, tier)); used.push(it.id); }
      }

      // On hand and run-out answers.
      let reported = null;
      if (tier === 'Urgent' || tier === 'Immediate') {
        lines.forEach(function (l, k) {
          const rate = rateOf(l.itemId, l.option);
          const step = itemsById[l.itemId].step;
          if (k === 0 && lowOnHand) {
            l.onHand = Math.max(step, floorTo(rate * between(rng, 0.35, 0.7), step));   // 8.4-16.8 h
          } else {
            l.onHand = ceilTo(rate * between(rng, k === 0 ? 1.0 : 1.5, k === 0 ? 1.6 : 2.5), step);   // >= 24 h
          }
        });
        if (tier === 'Immediate' && !lowOnHand) reported = 8 + rng.int(9);   // 8-16 h: mission burning faster
        if (tier === 'Urgent') reported = 24 + 4 * rng.int(4);              // 24-36 h: stays Urgent
      } else if (tier === 'Priority' && rng() < 0.35) {
        const l = lines[0], rate = rateOf(l.itemId, l.option);
        if (rate !== null) l.onHand = ceilTo(rate * between(rng, 1.0, 2.5), itemsById[l.itemId].step);
      }

      // Times.
      const nltR = NLT_RANGE[tier];
      const nlt = nowMin + roundTo(between(rng, nltR[0], nltR[1]), 30);
      const createdAt = Math.max(0, nowMin - 5 * rng.int(tier === 'Immediate' ? 13 : 37));

      // Pickup hint: a rally-candidate grid point within reach (and within 15 mi for mounted units).
      let desiredPickup = null;
      const radiusMi = mob === 'fixed' ? 0 : mobilityCfg[mob].radiusMi;
      if (hintIdx.indexOf(i) >= 0) {
        const reachKm = Math.min(radiusMi, 15) * KM_PER_MI;
        const cands = rallyPts.filter(function (g) { return hav(loc, g) <= reachKm; });
        if (cands.length) { const g = rng.pick(cands); desiredPickup = { lat: g.lat, lon: g.lon, gridId: g.id }; }
      }

      const fixed = mob === 'fixed';
      const unitName = names[i % names.length];
      const id = SRO.util.nextId('R', usedIds, 4);
      usedIds.push(id);
      const req = {
        id: id, source: 'sample',
        unitName: unitName, designator: scenario.designatorFor(unitName),
        lat: loc.lat, lon: loc.lon, gridId: snap.id, mobility: mob,
        maxTravelMi: radiusMi,
        desiredPickup: desiredPickup,
        directOnly: fixed, directReason: fixed ? (rng() < 0.5 ? 'in-contact' : 'no-vehicles') : null, directReasonText: '',
        lines: lines,
        urgencyRequested: requested,
        urgency: requested,
        hoursLeftComputed: null, hoursLeftReported: reported,
        nlt: nlt, deadline: nlt,
        remarks: rng() < 0.45 ? rng.pick(REMARKS) : '',
        createdAt: createdAt, windowId: ctx.windowId === undefined ? null : ctx.windowId,
        status: 'submitted',
        locks: { truckId: null, forceDirect: false },
        updated: false
      };
      let e = urgency.escalate(req, createdAt, { catalog: catalog, dailyUse: dailyUse });
      if (tier === 'Immediate' && e.urgency !== 'Immediate') {
        // A planner-edited daily-use table (ctx.dailyUse) can leave the low on hand at 24 h or more
        // (or with no rate): fall back to a reported run-out so the mix keeps exactly one Immediate.
        req.hoursLeftReported = 8 + rng.int(9);
        e = urgency.escalate(req, createdAt, { catalog: catalog, dailyUse: dailyUse });
      }
      req.urgency = e.urgency;
      req.deadline = e.deadline;
      req.hoursLeftComputed = e.hoursLeftComputed;
      req.hoursLeftReported = e.hoursLeftReported;
      out.push(req);
    }
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
