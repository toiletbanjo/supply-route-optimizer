// Scenario defaults (notional): hubs, fleet, callsigns, truck colors, radio frequencies, settings,
// time-of-day periods, risk ratings, mobility radii, sample unit names, a rough Taiwan outline and
// defaultState(). All names, frequencies and units are fictional.
//
// Choices made here (spec-answers.md delegated these small details to Claude):
//   - Hubs: FOB Granite (US, north, near Sanxia), Base Jade (TW, central, near Yuanlin),
//     FOB Anvil (US, south, east of Dashe near Fwy 10), Base Lotus (TW, east, near Shoufeng).
//     Fictional, placed beside ordinary towns / highway interchanges, each on a junction of the
//     primary road graph (roads_graph.json) so trucks leave and return without carriageway detours;
//     positions live in grid.json.
//   - Callsigns Alpha / Bravo / Charlie / Delta by hub; trucks <Callsign>-1 (tanker, 2,500 gal bulk
//     fuel) and <Callsign>-2 (cargo, 10 pallets). Each truck has its own notional VHF frequency.
//   - Truck colors: 8 mid-luminance colors (WCAG contrast >= 3:1 on both black and white, so they read
//     on dark, light and red-night themes). Red, orange, yellow and gray are left out on purpose:
//     those are the urgency ring colors.
//   - Unit names are real-format but invented. They may coincide with a real unit by chance; no real
//     unit, location or operational data is used.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.data = SRO.data || {};

  const START_SIM_MIN = 360;   // Day 1, 0600

  const CALLSIGNS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

  // lat/lon are a fallback copy of grid.json; defaultHubs() reads the live grid when it is loaded.
  const HUB_DEFS = [
    { id: 'HUB-GRANITE', name: 'FOB Granite', nation: 'US', gridId: 'G-GRANITE', lat: 24.93074, lon: 121.37590, callsign: 'Alpha' },
    { id: 'HUB-JADE', name: 'Base Jade', nation: 'TW', gridId: 'G-JADE', lat: 23.94009, lon: 120.59258, callsign: 'Bravo' },
    { id: 'HUB-ANVIL', name: 'FOB Anvil', nation: 'US', gridId: 'G-ANVIL', lat: 22.77391, lon: 120.43516, callsign: 'Charlie' },
    { id: 'HUB-LOTUS', name: 'Base Lotus', nation: 'TW', gridId: 'G-LOTUS', lat: 23.87013, lon: 121.50979, callsign: 'Delta' }
  ];

  const TRUCK_COLORS = [
    { hex: '#2F6FE0', name: 'Blue' },
    { hex: '#0F9488', name: 'Teal' },
    { hex: '#3F9A2E', name: 'Green' },
    { hex: '#8E5AD8', name: 'Purple' },
    { hex: '#C9359A', name: 'Magenta' },
    { hex: '#A86B2A', name: 'Brown' },
    { hex: '#1C9BC7', name: 'Sky' },
    { hex: '#7E8C1C', name: 'Olive' }
  ];

  // Notional VHF frequencies (MHz, 30.000-87.975 band, 25 kHz steps), one per default truck.
  const FREQUENCIES = {
    'Alpha-1': '45.250', 'Alpha-2': '45.775',
    'Bravo-1': '52.475', 'Bravo-2': '53.150',
    'Charlie-1': '38.650', 'Charlie-2': '39.325',
    'Delta-1': '61.125', 'Delta-2': '61.850'
  };

  const TRUCK_TYPES = {
    tanker: { id: 'tanker', label: 'Fuel tanker', capacity: 2500, unit: 'gal', loadGroup: 'fuel' },
    cargo: { id: 'cargo', label: 'Cargo truck', capacity: 10, unit: 'pallet', loadGroup: 'cargo' }
  };

  // Time-of-day table (DESIGN.md section 2). speed and risk are multipliers.
  const PERIODS = [
    { name: 'Day', start: '0700', end: '1800', speed: 1.0, risk: 1.0 },
    { name: 'Dusk', start: '1800', end: '1930', speed: 0.9, risk: 1.2 },
    { name: 'Night', start: '1930', end: '0530', speed: 0.7, risk: 0.8 },
    { name: 'Dawn', start: '0530', end: '0700', speed: 0.9, risk: 1.2 }
  ];

  const RISK_RATINGS = { Low: 1, Medium: 3, High: 6 };

  // Mounted / dismounted feed settings.mobility. Fixed in place = binding, deliver direct only.
  const MOBILITY = {
    mounted: { radiusMi: 50, costPerMi: 0.5 },
    dismounted: { radiusMi: 5, costPerMi: 4 }
  };
  const MOBILITY_MODES = [
    { id: 'mounted', label: 'Mounted', radiusMi: 50, directOnly: false, help: 'Vehicles available. Pickup within 50 mi is a preference.' },
    { id: 'dismounted', label: 'Dismounted', radiusMi: 5, directOnly: false, help: 'On foot. Pickup within 5 mi is a preference.' },
    { id: 'fixed', label: 'Fixed in place', radiusMi: 0, directOnly: true, help: 'Holding or in contact. Delivered direct to you.' }
  ];
  const DIRECT_REASONS = [
    { id: 'no-vehicles', label: 'No vehicles available' },
    { id: 'in-contact', label: 'In contact / holding position' },
    { id: 'other', label: 'Other' }
  ];

  // Real-format, invented platoon names (US format: platoon, company or troop, battalion-regiment).
  const UNIT_NAMES = [
    '1st PLT, A CO, 4-93 IN', '2nd PLT, B CO, 4-93 IN', '3rd PLT, C CO, 4-93 IN', '4th PLT, D CO, 4-93 IN',
    '1st PLT, C CO, 2-96 IN', '2nd PLT, A CO, 2-96 IN', '3rd PLT, B CO, 2-96 IN',
    '1st PLT, B CO, 5-62 IN', '2nd PLT, A CO, 5-62 IN', '3rd PLT, C CO, 5-62 IN', '1st PLT, D CO, 5-62 IN',
    '1st PLT, A CO, 6-58 IN', '2nd PLT, C CO, 6-58 IN', '3rd PLT, B CO, 6-58 IN',
    '1st PLT, B CO, 3-94 IN', '2nd PLT, D CO, 3-94 IN', '3rd PLT, A CO, 3-94 IN',
    '1st PLT, C CO, 3-59 IN', '2nd PLT, B CO, 3-59 IN', '3rd PLT, A CO, 3-59 IN',
    '1st PLT, A CO, 5-86 AR', '2nd PLT, B CO, 5-86 AR', '3rd PLT, C CO, 5-86 AR',
    '1st PLT, C CO, 2-79 AR', '2nd PLT, A CO, 2-79 AR',
    '1st PLT, A TRP, 4-98 CAV', '2nd PLT, B TRP, 4-98 CAV', '3rd PLT, C TRP, 4-98 CAV',
    '1st PLT, B TRP, 6-71 CAV', '2nd PLT, A TRP, 6-71 CAV'
  ];

  // Rough outline of Taiwan's main island, [lat, lon], clockwise from the north cape. It sits a little
  // outside the real coast (up to ~8 km at sea in places) so every land point and every point of the
  // road graph (roads_graph.json, >= 0.5 km margin) is inside; Penghu, Kinmen, Matsu, Green Island,
  // Lanyu, Xiaoliuqiu and Guishan Island are outside. insideTaiwan() uses it on its own when no
  // detailed coastline is loaded, and as a first filter when one is.
  const TAIWAN_OUTLINE = [
    [25.32, 121.53], [25.32, 121.61], [25.25, 121.68], [25.18, 121.78], [25.16, 121.90], [25.06, 122.02], [24.97, 122.03],
    [24.90, 121.87], [24.72, 121.86], [24.60, 121.90], [24.45, 121.87], [24.30, 121.79], [24.15, 121.70],
    [23.98, 121.66], [23.75, 121.59], [23.55, 121.55], [23.30, 121.48], [23.10, 121.42], [22.90, 121.30],
    [22.75, 121.20], [22.60, 121.05], [22.42, 120.95], [22.28, 120.92], [22.08, 120.91], [21.88, 120.87],
    [21.88, 120.68], [22.05, 120.67], [22.25, 120.61], [22.38, 120.55], [22.45, 120.40], [22.50, 120.30],
    [22.58, 120.24], [22.80, 120.13], [23.05, 120.03], [23.35, 120.06], [23.60, 120.10], [23.85, 120.18],
    [24.08, 120.35], [24.30, 120.48], [24.55, 120.64], [24.62, 120.68], [24.80, 120.87], [24.95, 120.94],
    [25.05, 121.02], [25.12, 121.20], [25.20, 121.38], [25.28, 121.45]
  ];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // When the Natural Earth coastline (taiwan_coast.json -> SRO.data.taiwan_coast) is loaded, a point
  // inside the rough outline must also be on the main island or within COAST_BUFFER_KM of its coast.
  // The buffer covers Natural Earth's coarse coast (real coastal roads lie up to ~2.8 km outside it,
  // e.g. Hwy 2 and Hwy 9 on the northeast and southeast coasts) while rejecting points well out at sea.
  const COAST_BUFFER_KM = 3.5;

  function insideOutline(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return false;
    const P = TAIWAN_OUTLINE;
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const yi = P[i][0], xi = P[i][1], yj = P[j][0], xj = P[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // GeoJSON ring ([lon, lat] pairs) helpers.
  function inRing(ring, lat, lon) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function ringDistKm(ring, lat, lon) {   // local equirectangular, fine at a few km
    const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.54;
    let best = Infinity;
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let t = L ? -(ax * dx + ay * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.sqrt((ax + t * dx) * (ax + t * dx) + (ay + t * dy) * (ay + t * dy));
      if (d < best) best = d;
    }
    return best;
  }
  // Outer ring of the main island in the loaded coastline (the polygon containing central Taiwan),
  // cached per data object. null when no coastline is loaded.
  let coastSrc, coastRing = null;
  function mainCoastRing() {
    const d = SRO.data && SRO.data.taiwan_coast;
    if (d === coastSrc) return coastRing;
    coastSrc = d;
    coastRing = null;
    const feats = (d && Array.isArray(d.features)) ? d.features : [];
    feats.forEach(function (f) {
      const g = f && f.geometry;
      const polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      polys.forEach(function (p) {
        const ring = p && p[0];
        if (!coastRing && Array.isArray(ring) && ring.length > 3 && inRing(ring, 23.7, 121.0)) coastRing = ring;
      });
    });
    return coastRing;
  }

  function insideTaiwan(lat, lon) {
    if (!insideOutline(lat, lon)) return false;
    const ring = mainCoastRing();
    if (!ring || inRing(ring, lat, lon)) return true;
    return ringDistKm(ring, lat, lon) <= COAST_BUFFER_KM;
  }

  // '1st PLT, B CO, 3-21 IN' -> '1/B/3-21IN'. Unknown formats come back trimmed, spaces removed.
  function designatorFor(unitName) {
    const s = String(unitName || '').trim();
    const m = /^(\d+)(?:st|nd|rd|th)\s+PLT,\s*([A-Z])\s+(?:CO|TRP|BTRY),\s*(\d+-\d+)\s+([A-Z]+)$/i.exec(s);
    if (!m) return s.replace(/\s+/g, '');
    return m[1] + '/' + m[2].toUpperCase() + '/' + m[3] + m[4].toUpperCase();
  }

  function truckColor(index) { return TRUCK_COLORS[((index % TRUCK_COLORS.length) + TRUCK_COLORS.length) % TRUCK_COLORS.length].hex; }

  function defaultHubs() {
    const grid = SRO.data.grid || [];
    return HUB_DEFS.map(function (h) {
      const g = grid.find(function (p) { return p.id === h.gridId; });
      const out = clone(h);
      if (g) { out.lat = g.lat; out.lon = g.lon; }
      return out;
    });
  }

  function defaultFleet(hubs) {
    hubs = hubs || defaultHubs();
    const fleet = [];
    hubs.forEach(function (h) {
      ['tanker', 'cargo'].forEach(function (type, k) {
        const id = h.callsign + '-' + (k + 1);
        fleet.push({
          id: id, hubId: h.id, type: type, capacity: TRUCK_TYPES[type].capacity,
          color: truckColor(fleet.length), freq: FREQUENCIES[id] || '45.000',
          status: 'available', availableAt: 0
        });
      });
    });
    return fleet;
  }

  function defaultDailyUse() {
    const H = SRO.data.catalogHelpers;
    return H && H.defaultDailyUse ? H.defaultDailyUse() : {};
  }

  // settings exactly per DESIGN.md section 3. methodParams entries stay null: the solver params
  // module (SRO.solver.defaultParams) fills defaults when a method runs.
  function defaultSettings() {
    return {
      method: 'tabu',
      timeLimitSec: 300,
      weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
      maxRallyPoints: 8,
      maxStops: 20,
      convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
      periods: clone(PERIODS),
      riskRatings: clone(RISK_RATINGS),
      mobility: clone(MOBILITY),
      dailyUse: defaultDailyUse(),
      methodParams: { tabu: null, sa: null, aco: null, mip: null },
      sampleSeed: 20261005
    };
  }

  // A fresh, complete app state (DESIGN.md section 3): no requests, clock at 0600 Day 1,
  // platoon sergeant view, dark theme, one open planning window 0600-1200.
  function defaultState() {
    const hubs = defaultHubs();
    return {
      version: 1,
      ui: { role: 'psg', theme: 'dark', plannerTab: 'queue' },
      clock: { simMin: START_SIM_MIN, running: false, speed: 1 },
      profile: null,
      scenario: {
        hubs: hubs,
        fleet: defaultFleet(hubs),
        zones: [],
        rally: { pinned: [], banned: [] },
        settings: defaultSettings()
      },
      requests: [],
      windows: [{ id: 'W-001', start: START_SIM_MIN, end: START_SIM_MIN + 360, status: 'open', planIds: [], approvedPlanId: null }],
      plans: [],
      snapshots: [],
      roadCache: {}
    };
  }

  SRO.data.scenario = {
    version: 1,
    scenarioDate: '2026-10-06',     // Day 1 (notional)
    startSimMin: START_SIM_MIN,
    callsigns: CALLSIGNS,
    hubDefs: HUB_DEFS,
    truckTypes: TRUCK_TYPES,
    truckColors: TRUCK_COLORS,
    frequencies: FREQUENCIES,
    periods: PERIODS,
    riskRatings: RISK_RATINGS,
    mobility: MOBILITY,
    mobilityModes: MOBILITY_MODES,
    directReasons: DIRECT_REASONS,
    unitNames: UNIT_NAMES,
    taiwanOutline: TAIWAN_OUTLINE,
    coastBufferKm: COAST_BUFFER_KM,
    insideOutline: insideOutline,
    insideTaiwan: insideTaiwan,
    designatorFor: designatorFor,
    truckColor: truckColor,
    defaultHubs: defaultHubs,
    defaultFleet: defaultFleet,
    defaultSettings: defaultSettings,
    defaultState: defaultState
  };
})(typeof self !== 'undefined' ? self : globalThis);
