// Supply catalog (notional): classes, items, options, units, pallet conversions and daily use rates.
// Fixed catalog (spec-answers.md, Section 2). The only free text is the Class IX "other part"
// description (carried in line.option) and request remarks.
//
// NOTIONAL PLANNING FACTORS. These numbers are made up for a class prototype; they are not doctrine
// and not real consumption data. A "platoon" here is about 35 soldiers with 4 vehicles.
//   dailyUse       typical use per platoon per day, in the item's unit. Drives hours-of-supply
//                  (on hand / dailyUse x 24) and the "more than 5x daily use" warning. The planner
//                  can override any rate in Advanced (settings.dailyUse, keys 'itemId' or
//                  'itemId:optionId'). null = no typical rate (hours of supply not computed).
//   palletsPerUnit pallet positions one unit takes on a cargo truck (10 pallets per truck).
//                  null for bulk fuel, which rides on tankers and is measured in gallons.
//   defaultQty     amount the request form starts at; always <= 5 x dailyUse so the default
//                  never trips the warning.
//   maxQty         largest amount one request line may ask for (never more than one truck load).
// Options may override dailyUse, palletsPerUnit, defaultQty and maxQty (e.g. .50 cal vs 5.56 mm).
//
// Load groups (DESIGN.md section 4): 'fuel' = bulk Class III diesel/JP-8 and gasoline (gallons,
// tankers only). Everything else is 'cargo' (pallets, cargo trucks only), including packaged
// oil & lubricants and BULK WATER: bulk water moves as filled 500 gal fabric blivets or 5 gal
// water cans strapped to pallets on the cargo truck, not in the fuel tanker (a tanker that has
// carried fuel is not used for potable water). 1 blivet (500 gal) ~ 1 pallet position;
// 36 cans (180 gal) per pallet.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.data = SRO.data || {};
  SRO.core = SRO.core || {};

  const UNITS = {
    gal: { id: 'gal', one: 'gal', many: 'gal' },
    case: { id: 'case', one: 'case', many: 'cases' },
    round: { id: 'round', one: 'round', many: 'rounds' },
    box: { id: 'box', one: 'box', many: 'boxes' },
    kit: { id: 'kit', one: 'kit', many: 'kits' },
    each: { id: 'each', one: 'each', many: 'each' },
    pallet: { id: 'pallet', one: 'pallet', many: 'pallets' }
  };

  // Tie-break order III > I > V > VIII > IX (rank 0 = served first within an urgency tier).
  const CLASSES = [
    { id: 'III', name: 'Fuel', label: 'Class III (Fuel)', rank: 0 },
    { id: 'I', name: 'Food & Water', label: 'Class I (Food & Water)', rank: 1 },
    { id: 'V', name: 'Ammunition', label: 'Class V (Ammunition)', rank: 2 },
    { id: 'VIII', name: 'Medical', label: 'Class VIII (Medical)', rank: 3 },
    { id: 'IX', name: 'Repair Parts', label: 'Class IX (Repair Parts)', rank: 4 }
  ];

  const ITEMS = [
    // ---- Class III (Fuel) -----------------------------------------------------------------
    {
      id: 'diesel', classId: 'III', name: 'Diesel / JP-8', unit: 'gal', loadGroup: 'fuel',
      optionLabel: 'Type',
      options: [{ id: 'JP-8', label: 'JP-8' }, { id: 'DF-2', label: 'Diesel (DF-2)' }],
      palletsPerUnit: null,
      dailyUse: 300,              // 4 vehicles x ~60 gal + generators
      defaultQty: 500, maxQty: 2500, step: 50,   // max = one tanker
      note: 'Bulk fuel, tanker only.'
    },
    {
      id: 'gasoline', classId: 'III', name: 'Gasoline', unit: 'gal', loadGroup: 'fuel',
      optionLabel: 'Type',
      options: [{ id: 'MOGAS', label: 'MOGAS (unleaded)' }],
      palletsPerUnit: null,
      dailyUse: 30,               // small generators, small engines
      defaultQty: 100, maxQty: 1000, step: 10,
      note: 'Bulk fuel, tanker only.'
    },
    {
      id: 'oil', classId: 'III', name: 'Oil & lubricants', unit: 'case', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [
        { id: '15W-40', label: 'Engine oil 15W-40' },
        { id: '80W-90', label: 'Gear oil 80W-90' },
        { id: 'hydraulic', label: 'Hydraulic fluid' },
        { id: 'grease', label: 'Grease' },
        { id: 'clp', label: 'Weapons lube (CLP)' },
        { id: 'coolant', label: 'Coolant / antifreeze' }
      ],
      palletsPerUnit: 1 / 60,     // case = 12 quarts; 60 cases per pallet
      dailyUse: 2,
      defaultQty: 6, maxQty: 120, step: 1,
      note: 'Packaged, rides on the cargo truck. 1 case = 12 quarts (3 gal).'
    },
    // ---- Class I (Food & Water) -----------------------------------------------------------
    {
      id: 'mre', classId: 'I', name: 'MREs', unit: 'case', loadGroup: 'cargo',
      optionLabel: 'Menu',
      options: [{ id: 'mixed', label: 'Mixed menus' }, { id: 'vegetarian', label: 'Vegetarian menus' }],
      palletsPerUnit: 1 / 48,     // 48 cases per pallet
      dailyUse: 9,                // 35 soldiers x 3 meals = 105 meals; 12 meals per case
      defaultQty: 27, maxQty: 480, step: 1,
      note: '1 case = 12 meals.'
    },
    {
      id: 'water-bottled', classId: 'I', name: 'Bottled water', unit: 'case', loadGroup: 'cargo',
      optionLabel: 'Bottle size',
      options: [
        { id: '0.5L', label: '0.5 L bottles (24 per case)', palletsPerUnit: 1 / 72, dailyUse: 18, defaultQty: 54 },
        { id: '1.5L', label: '1.5 L bottles (12 per case)', palletsPerUnit: 1 / 60, dailyUse: 12, defaultQty: 36, maxQty: 600 }
      ],
      palletsPerUnit: 1 / 72,
      dailyUse: 18,               // ~6 L drinking water per soldier per day in heat
      defaultQty: 54, maxQty: 720, step: 1,
      note: 'Drinking water.'
    },
    {
      id: 'water-bulk', classId: 'I', name: 'Bulk water', unit: 'gal', loadGroup: 'cargo',
      optionLabel: 'Container',
      options: [
        { id: 'blivet', label: '500 gal blivets', palletsPerUnit: 1 / 500 },
        { id: 'cans', label: '5 gal water cans', palletsPerUnit: 1 / 180, maxQty: 1800 }
      ],
      palletsPerUnit: 1 / 500,
      dailyUse: 100,              // cooking, hygiene, vehicle cooling (~3 gal per soldier)
      defaultQty: 500, maxQty: 5000, step: 50,
      note: 'Cargo, not tanker: blivets or cans on pallets (see header).'
    },
    // ---- Class V (Ammunition) -------------------------------------------------------------
    {
      id: 'small-arms', classId: 'V', name: 'Small arms ammunition', unit: 'round', loadGroup: 'cargo',
      optionLabel: 'Caliber',
      options: [
        { id: '5.56mm', label: '5.56 mm', palletsPerUnit: 1 / 40000, dailyUse: 2000, defaultQty: 1680, maxQty: 100000 },
        { id: '7.62mm', label: '7.62 mm linked', palletsPerUnit: 1 / 18000, dailyUse: 800, defaultQty: 800, maxQty: 40000 },
        { id: '.50cal', label: '.50 cal linked', palletsPerUnit: 1 / 4000, dailyUse: 400, defaultQty: 400, maxQty: 20000 },
        { id: '9mm', label: '9 mm', palletsPerUnit: 1 / 60000, dailyUse: 150, defaultQty: 300, maxQty: 20000 }
      ],
      palletsPerUnit: 1 / 40000,
      dailyUse: 2000,
      defaultQty: 1680, maxQty: 100000, step: 10,
      note: 'Sustainment rate, not a contact rate.'
    },
    {
      id: 'grenades', classId: 'V', name: 'Grenades', unit: 'box', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [
        { id: 'frag', label: 'Fragmentation' },
        { id: 'smoke', label: 'Smoke' },
        { id: 'illum', label: 'Illumination (hand flare)' }
      ],
      palletsPerUnit: 1 / 24,     // 24 boxes per pallet
      dailyUse: 0.5,
      defaultQty: 2, maxQty: 48, step: 1,
      note: '1 box = 30 grenades (notional).'
    },
    {
      id: 'mortar', classId: 'V', name: 'Mortar rounds', unit: 'round', loadGroup: 'cargo',
      optionLabel: 'Caliber and type',
      options: [
        { id: '60-he', label: '60 mm HE', palletsPerUnit: 1 / 192, dailyUse: 24, defaultQty: 48 },
        { id: '60-illum', label: '60 mm illumination', palletsPerUnit: 1 / 192, dailyUse: 8, defaultQty: 24 },
        { id: '81-he', label: '81 mm HE', palletsPerUnit: 1 / 96, dailyUse: 18, defaultQty: 36 },
        { id: '81-smoke', label: '81 mm smoke', palletsPerUnit: 1 / 96, dailyUse: 6, defaultQty: 18 },
        { id: '120-he', label: '120 mm HE', palletsPerUnit: 1 / 40, dailyUse: 10, defaultQty: 20, maxQty: 400 }
      ],
      palletsPerUnit: 1 / 96,
      dailyUse: 18,
      defaultQty: 36, maxQty: 960, step: 1,
      note: ''
    },
    {
      id: 'at4', classId: 'V', name: 'AT4', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [{ id: 'at4-84', label: 'AT4 (84 mm)' }],
      palletsPerUnit: 1 / 40,
      dailyUse: 2,
      defaultQty: 4, maxQty: 80, step: 1,
      note: ''
    },
    // ---- Class VIII (Medical) -------------------------------------------------------------
    {
      id: 'cls-refill', classId: 'VIII', name: 'CLS bag refill', unit: 'kit', loadGroup: 'cargo',
      optionLabel: 'Kit', options: [{ id: 'standard', label: 'Standard refill' }],
      palletsPerUnit: 1 / 40,
      dailyUse: 1,
      defaultQty: 4, maxQty: 40, step: 1,
      note: ''
    },
    {
      id: 'ifak-refill', classId: 'VIII', name: 'IFAK refill', unit: 'kit', loadGroup: 'cargo',
      optionLabel: 'Kit', options: [{ id: 'standard', label: 'Standard refill' }],
      palletsPerUnit: 1 / 150,
      dailyUse: 4,
      defaultQty: 12, maxQty: 200, step: 1,
      note: ''
    },
    {
      id: 'litters', classId: 'VIII', name: 'Litters', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [{ id: 'folding', label: 'Folding litter' }, { id: 'roll-up', label: 'Roll-up flexible litter' }],
      palletsPerUnit: 1 / 30,
      dailyUse: 0.5,
      defaultQty: 2, maxQty: 30, step: 1,
      note: ''
    },
    {
      id: 'med-kit', classId: 'VIII', name: 'General med kit', unit: 'kit', loadGroup: 'cargo',
      optionLabel: 'Kit',
      options: [{ id: 'sick-call', label: 'Sick-call kit' }, { id: 'aid-bag', label: 'Aid bag resupply' }],
      palletsPerUnit: 1 / 24,
      dailyUse: 0.5,
      defaultQty: 1, maxQty: 24, step: 1,
      note: ''
    },
    // ---- Class IX (Repair Parts) ----------------------------------------------------------
    {
      id: 'tires', classId: 'IX', name: 'Tires', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Fits',
      options: [
        { id: 'light', label: 'Light tactical vehicle', palletsPerUnit: 1 / 8 },
        { id: 'mrap', label: 'MRAP', palletsPerUnit: 1 / 4 },
        { id: 'truck', label: 'Medium truck', palletsPerUnit: 1 / 6 },
        { id: 'trailer', label: 'Trailer', palletsPerUnit: 1 / 10 }
      ],
      palletsPerUnit: 1 / 8,
      dailyUse: 1,
      defaultQty: 4, maxQty: 40, step: 1,
      note: ''
    },
    {
      id: 'batteries', classId: 'IX', name: 'Batteries', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [
        { id: 'vehicle', label: 'Vehicle battery (6T)', palletsPerUnit: 1 / 36, dailyUse: 0.5, defaultQty: 2, maxQty: 72 },
        { id: 'radio', label: 'Radio battery (rechargeable)', palletsPerUnit: 1 / 240, dailyUse: 8, defaultQty: 24 },
        { id: 'aa', label: 'AA / AAA packs', palletsPerUnit: 1 / 600, dailyUse: 6, defaultQty: 24 }
      ],
      palletsPerUnit: 1 / 240,
      dailyUse: 8,
      defaultQty: 24, maxQty: 400, step: 1,
      note: ''
    },
    {
      id: 'filters', classId: 'IX', name: 'Filters', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Type',
      options: [
        { id: 'oil', label: 'Engine oil filter' },
        { id: 'fuel', label: 'Fuel filter' },
        { id: 'air', label: 'Air filter', palletsPerUnit: 1 / 30 },
        { id: 'hydraulic', label: 'Hydraulic filter' }
      ],
      palletsPerUnit: 1 / 120,
      dailyUse: 1,
      defaultQty: 4, maxQty: 200, step: 1,
      note: ''
    },
    {
      id: 'other-part', classId: 'IX', name: 'Other part', unit: 'each', loadGroup: 'cargo',
      optionLabel: 'Part description', options: [], freeText: true,
      palletsPerUnit: 0.1,        // assume a tenth of a pallet each until the planner knows better
      dailyUse: null,             // no typical rate: hours of supply is asked, not computed
      defaultQty: 1, maxQty: 20, step: 1,
      note: 'Describe the part (line.option holds the description).'
    }
  ];
  ITEMS.forEach(function (it) { if (!it.freeText) it.freeText = false; });

  SRO.data.catalog = {
    version: 1,
    units: UNITS,
    classes: CLASSES,
    items: ITEMS,
    cargoPalletStep: 0.1      // cargo loads round UP to this many pallets
  };

  // ---- helpers ------------------------------------------------------------------------------
  const H = SRO.data.catalogHelpers = {};
  function cat() { return SRO.data.catalog; }

  H.CLASS_ORDER = CLASSES.map(function (c) { return c.id; });   // ['III', 'I', 'V', 'VIII', 'IX']
  H.classById = function (classId) { return cat().classes.find(function (c) { return c.id === classId; }) || null; };
  H.classLabel = function (classId) { const c = H.classById(classId); return c ? c.label : 'Class ' + classId; };
  H.classRank = function (classId) { const c = H.classById(classId); return c ? c.rank : cat().classes.length; };
  H.itemById = function (itemId) { return cat().items.find(function (it) { return it.id === itemId; }) || null; };
  H.itemsForClass = function (classId) { return cat().items.filter(function (it) { return it.classId === classId; }); };
  H.optionById = function (itemId, optionId) {
    const it = H.itemById(itemId);
    if (!it) return null;
    return it.options.find(function (o) { return o.id === optionId; }) || null;
  };
  H.unitLabel = function (unit, qty) {
    const u = cat().units[unit];
    if (!u) return unit;
    return qty === 1 ? u.one : u.many;
  };

  // Item spec with option overrides applied: { item, option, unit, loadGroup, palletsPerUnit,
  // dailyUse, defaultQty, maxQty, step }. null for an unknown item.
  H.spec = function (itemId, optionId) {
    const it = H.itemById(itemId);
    if (!it) return null;
    const op = it.freeText ? null : (it.options.find(function (o) { return o.id === optionId; }) || null);
    function pick(k) { return op && op[k] !== undefined ? op[k] : it[k]; }
    return {
      item: it, option: op, unit: it.unit, loadGroup: it.loadGroup,
      palletsPerUnit: pick('palletsPerUnit'), dailyUse: pick('dailyUse'),
      defaultQty: pick('defaultQty'), maxQty: pick('maxQty'), step: it.step
    };
  };

  // Default daily-use table for settings.dailyUse: { itemId: rate, 'itemId:optionId': rate }.
  // Option keys appear only where the option overrides the item rate.
  H.defaultDailyUse = function () {
    const t = {};
    cat().items.forEach(function (it) {
      if (it.dailyUse !== null && it.dailyUse !== undefined) t[it.id] = it.dailyUse;
      it.options.forEach(function (o) { if (o.dailyUse !== undefined) t[it.id + ':' + o.id] = o.dailyUse; });
    });
    return t;
  };

  // Daily use for one request line. `table` (settings.dailyUse) wins over the catalog:
  // 'itemId:optionId' first, then 'itemId'. Returns null when there is no rate.
  // Non-finite table entries (NaN, Infinity, strings) are ignored, as in urgency.dailyUseFor.
  function finite(x) { return typeof x === 'number' && isFinite(x); }
  H.dailyUseFor = function (line, table) {
    if (!line) return null;
    const keyOpt = line.itemId + ':' + line.option;
    if (table && finite(table[keyOpt])) return table[keyOpt];
    const s = H.spec(line.itemId, line.option);
    if (table && finite(table[line.itemId]) && !(s && s.option && s.option.dailyUse !== undefined)) return table[line.itemId];
    return s && finite(s.dailyUse) ? s.dailyUse : null;
  };

  function roundUpTo(x, step) { return Math.ceil(x / step - 1e-9) * step; }
  function tidy(x) { return Math.round(x * 1e6) / 1e6; }

  // One request line -> truck load. Fuel: { group: 'fuel', qty: gallons, unit: 'gal' }.
  // Cargo: { group: 'cargo', qty: pallets rounded up to cargoPalletStep (min one step), unit: 'pallet',
  // exact: unrounded pallets }. null for an unknown item or a non-positive or non-finite quantity.
  H.lineToLoad = function (line) {
    const s = line ? H.spec(line.itemId, line.option) : null;
    const q = line ? +line.qty : 0;
    if (!s || !(q > 0) || !isFinite(q)) return null;
    if (s.loadGroup === 'fuel') return { group: 'fuel', qty: q, unit: 'gal', exact: q };
    const exact = q * s.palletsPerUnit;
    const step = cat().cargoPalletStep;
    return { group: 'cargo', qty: tidy(Math.max(step, roundUpTo(exact, step))), unit: 'pallet', exact: tidy(exact) };
  };

  // All lines of a request -> at most two jobs' worth of load (DESIGN.md section 4).
  // { fuel: null | { qty, unit: 'gal', lineIdxs }, cargo: null | { qty, unit: 'pallet', exact, lineIdxs } }.
  // Cargo pallets are summed exactly and rounded up once.
  H.requestLoads = function (lines) {
    const out = { fuel: null, cargo: null };
    (lines || []).forEach(function (line, idx) {
      const l = H.lineToLoad(line);
      if (!l) return;
      if (l.group === 'fuel') {
        out.fuel = out.fuel || { qty: 0, unit: 'gal', lineIdxs: [] };
        out.fuel.qty += l.qty; out.fuel.lineIdxs.push(idx);
      } else {
        out.cargo = out.cargo || { qty: 0, unit: 'pallet', exact: 0, lineIdxs: [] };
        out.cargo.exact = tidy(out.cargo.exact + l.exact); out.cargo.lineIdxs.push(idx);
      }
    });
    if (out.cargo) {
      const step = cat().cargoPalletStep;
      out.cargo.qty = tidy(Math.max(step, roundUpTo(out.cargo.exact, step)));
    }
    return out;
  };

  SRO.core.lineToLoad = H.lineToLoad;
})(typeof self !== 'undefined' ? self : globalThis);
