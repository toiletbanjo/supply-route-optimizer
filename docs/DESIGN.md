# Supply Route Optimizer: Phase 1 design contract

This document is the contract every module is built against. The product decisions behind it are in `docs/spec-answers.md`; when the two disagree, `spec-answers.md` wins and this file gets fixed.

Phase 1 only: inside Taiwan, fictional hubs, up to 20 stops per window. Phase 2 (regional hubs, finite stock, sea/air legs) is held for a merge with a separate app, so keep the data model and solver interface free of Taiwan-specific assumptions where it costs nothing.

All data is notional. No real units, bases or operational data.

## 1. Repository layout

```
src/
  index.html              shell template; build.py replaces <!--INLINE:...--> markers
  styles.css              all CSS (themes via CSS custom properties)
  data/
    grid.json             ~50 grid points (hubs, towns/junctions, rally candidates); Aidan reviews/edits this file
    grid_links.json       main-road links between grid points (fallback times, arc paths, closures)
    catalog.js            supply catalog, units, pallet conversions, daily use rates
    scenario.js           hubs, default fleet, callsigns, colors, sample unit names, periods
    taiwan_coast.json     Taiwan coastline GeoJSON (Natural Earth, offline base layer)
    roads_graph.json      Taiwan road graph (Overture/OpenStreetMap, ODbL) for routing and drawing
    roads.json            (optional) precomputed leg paths from tools/roads/fetch_osrm_polylines.py
    time_matrix.json      (optional) external travel-time matrix (OSRM, or Google if ever allowed)
  core/                   runs on the main thread
    ns.js                 creates the SRO namespace (must load first)
    util.js               seeded RNG, ids, deep clone, clamp
    format.js             24h time, DTG, MGRS, class labels, miles
    geo.js                haversine, point/segment-in-circle, snapping, polyline length/interpolation
    road_router.js        Dijkstra router over roads_graph.json (SRO.lib.RoadRouter)
    network.js            travel matrix (Google or fallback), closures, all-pairs shortest paths, risk miles
    roads.js              road path provider (layered, see section 6)
    store.js              state, actions, persistence adapter interface
    clock.js              simulated demo clock and window boundaries
    samples.js            seeded sample request generator
    urgency.js            hours-of-supply and urgency escalation logic
    planner-engine.js     builds solver instances from state, runs solver worker, applies results
  solver/                 pure JS; must run in a Web Worker AND in Node (no DOM, no window)
    instance.js           instance schema helpers
    params.js             tunable method parameters: labels, help, ranges, defaults (drives the Advanced form)
    evaluate.js           schedule simulation + cost breakdown (single source of truth for cost)
    construct.js          greedy insertion construction (internal start plan only)
    localsearch.js        shared moves: relocate, swap, 2-opt, rally-point reassignment, split
    tabu.js               tabu search
    sa.js                 simulated annealing
    aco.js                ant colony optimization
    mip.js                MIP model generator (LP format) + HiGHS runner + solution decoding
    estimate.js           run-time estimates per method
    api.js                solve(instance, opts) dispatcher + progress protocol
    worker-main.js        worker message handler
  ui/
    shell.js              top bar (role switch, theme toggle, clock controls), routing, toasts
    symbols.js            milsymbol wrappers (platoon, hub, truck), urgency rings
    map.js                Leaflet map component shared by both views
    psg/profile.js        one-time unit profile
    psg/request.js        request form (DoorDash-style picker, urgency flow, validation)
    psg/myrequests.js     status cards, truck tracking mini map
    planner/queue.js      request queue table
    planner/plan.js       plan view: map, timeline, summary strip, method picker, run/compare/approve
    planner/route.js      route detail + explanations
    planner/scenario.js   trucks, zones, rally pin/ban, settings, advanced (incl. per-method solver tuning)
    planner/outputs.js    movement table (print/PDF/CSV), pickup notices, history, snapshots
tools/
  build.py                inlines everything into prototype/supply-route-app.html
  roads/                  road graph rebuild pipeline (Overture), coastline extract, optional OSRM polyline fetch
tests/
  solver/*.test.mjs       node --test
  ui/*.spec.mjs           Playwright checks
prototype/
  supply-route-app.html   built output (committed)
```

### Module pattern

No ES modules (the file opens from `file://` and the solver must also run inside a Blob worker). Every JS file is a plain script that attaches to a shared namespace:

```js
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.solver = SRO.solver || {};
  SRO.solver.evaluate = function (instance, solution) { /* ... */ };
})(typeof self !== 'undefined' ? self : globalThis);
```

`build.py` concatenates files in the order listed in `tools/manifest.json` (a `.json` data file is wrapped as `SRO.data.<name> = <json>;`, so `grid.json` becomes `SRO.data.grid`). `src/core/ns.js` and `src/core/util.js` (seeded RNG `SRO.util.rng(seed)`, clamp, ids, Infinity-safe JSON) load first in both groups. Node tests use `tests/load.mjs` (`loadGroup('worker')`, `loadScripts([...])`). The solver files plus `data/*` needed by the solver are also concatenated into a worker source string that the main thread turns into a Blob URL worker. Node tests load solver files with `vm.runInThisContext` in the same order.

## 2. Time

- Simulated time is an integer number of minutes since **Day 1 00:00 local Taiwan time** (`simMin`). The demo starts at `simMin = 360` (Day 1, 0600).
- Scenario date: Day 1 = 6 Oct 2026 (notional).
- Display for platoon sergeants: 24h local time, `2000`; add `Day 2` when not today.
- Display for planners: DTG in local zone letter H (UTC+8), `061430H OCT 26`. (Decision: zone H instead of Z so planner and platoon times never differ by 8 hours.)
- Planning windows: boundaries at 0000, 0600, 1200, 1800 local. A window covers requests submitted since the previous approved plan.
- Clock: start, pause, speeds 1x, 60x, 600x. Ticks drive truck animation and window boundaries.
- Time-of-day periods (editable table): Day 0700-1800 speed x1.0 risk x1.0; Dusk 1800-1930 x0.9 / x1.2; Night 1930-0530 x0.7 / x0.8; Dawn 0530-0700 x0.9 / x1.2. A leg uses the period at its departure minute. Travel minutes = base minutes / speed factor.

## 3. Data model (state)

The whole app state is one JSON-serializable object. Only `store.js` mutates it, through actions.

```js
state = {
  version: 1,
  ui: { role: 'psg' | 'planner', theme: 'dark' | 'light' | 'night', plannerTab: 'queue' | 'plan' | 'scenario' | 'outputs' },
  clock: { simMin: 360, running: false, speed: 1 | 60 | 600 },
  profile: null | {                       // the platoon sergeant on this device
    unitName: '1st PLT, B CO, 3-21 IN',   // real-format, fictional
    designator: '1/B/3-21IN',
    lat, lon, gridId,                     // snapped grid point for routing
    mobility: 'mounted' | 'dismounted' | 'fixed'
  },
  scenario: {
    hubs: [{ id: 'HUB-GRANITE', name: 'FOB Granite', nation: 'US' | 'TW', gridId, lat, lon, callsign: 'Alpha' }],
    fleet: [{ id: 'Alpha-1', hubId, type: 'tanker' | 'cargo', capacity: 2500 | 10, color: '#hex', freq: '45.250', status: 'available' | 'out' | 'en_route', availableAt: simMin }],
    zones: [{ id, kind: 'closed' | 'risk', rating: 'Low' | 'Medium' | 'High' | null, lat, lon, radiusMi, label }],
    rally: { pinned: [gridId], banned: [gridId] },
    settings: {
      method: 'tabu' | 'sa' | 'aco' | 'mip',
      timeLimitSec: 300,
      weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },   // 0-10 sliders
      maxRallyPoints: 8,
      maxStops: 20,                                               // soft: warn above
      convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
      periods: [{ name, start: 'HHMM', end: 'HHMM', speed, risk }],
      riskRatings: { Low: 1, Medium: 3, High: 6 },
      mobility: { mounted: { radiusMi: 50, costPerMi: 0.5 }, dismounted: { radiusMi: 5, costPerMi: 4 } },
      dailyUse: { /* per catalog item, see catalog.js */ },
      methodParams: { tabu: {...}, sa: {...}, aco: {...}, mip: {...} },   // see section 7, Method parameters
      sampleSeed: 20261005
    }
  },
  requests: [{
    id: 'R-0001', source: 'user' | 'sample',
    unitName, designator, lat, lon, gridId, mobility,
    maxTravelMi,                          // from mobility unless overridden
    desiredPickup: null | { lat, lon, gridId },
    directOnly: false, directReason: null | 'no-vehicles' | 'in-contact' | 'other', directReasonText,
    lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null | number }],
    urgencyRequested: 'Routine' | 'Priority' | 'Urgent',
    urgency: 'Routine' | 'Priority' | 'Urgent' | 'Immediate',    // after escalation
    hoursLeftComputed: null | number, hoursLeftReported: null | number,
    nlt: simMin, deadline: simMin,        // deadline = nlt, or min(nlt, runOutAt) for Immediate
    remarks: '',
    createdAt: simMin, windowId,
    status: 'submitted' | 'planned' | 'approved' | 'en_route' | 'delivered' | 'partial' | 'delayed' | 'cancelled',
    locks: { truckId: null, forceDirect: false },
    updated: false                         // true after a re-plan changed its ETA or pickup
  }],
  windows: [{ id: 'W-001', start: simMin, end: simMin, status: 'open' | 'planned' | 'approved', planIds: [], approvedPlanId: null }],
  plans: [Plan],
  snapshots: [{ id, name, createdAt, planId }],
  roadCache: { /* key 'gridA|gridB' -> encoded polyline, runtime OSRM cache */ }
}
```

`Plan` (produced by the solver, decorated by planner-engine):

```js
{
  id, windowId, name, method, createdAt, runtimeSec, mipGap: null | number, cancelled: false,
  parentPlanId: null | id,                 // set for contingency re-plans
  rallyPoints: [gridId],
  routes: [{
    truckId, type, color,
    loadStart, depart, returnAt,           // simMin
    stops: [{ seq, nodeKey, kind: 'rally' | 'direct', gridId, lat, lon, label,
              arrive, depart, period,
              deliveries: [{ requestId, lineIdx, qty, unit, classId }],
              pickups: [{ requestId, platoonMiles }] }],
    legs: [{ fromKey, toKey, gridPath: [gridId], depart, arrive, miles, riskUnits, period }],
    miles, gallons, riskUnits,
    cost: { fuel, distance, risk, simplicity, platoon, lateness }
  }],
  deferred: [{ requestId, lineIdx, qty, unit, reason: 'capacity' | 'time' | 'closed-road' | 'no-truck' | 'radius', note }],
  late: [{ requestId, minutesLate }],
  cost: { total, fuel, distance, risk, simplicity, platoon, lateness, deferral },
  stats: { requests, stops, trucksUsed, miles, gallons, riskUnits, late, delayed, runtimeSec },
  approved: false
}
```

### Persistence

`store.js` talks to a `PersistenceAdapter` with `load() -> state|null`, `save(state)`, `exportJson(state) -> string`, `importJson(string) -> state`. v1 ships `LocalStorageAdapter` (key `sro.v1`). A future shared online service implements the same interface. Every access to `localStorage` is wrapped in try/catch; the app works (in memory) when storage is unavailable.

### Actions (store.dispatch)

`role/set`, `theme/set`, `tab/set`, `clock/start`, `clock/pause`, `clock/speed`, `clock/tick`, `profile/save`, `request/submit`, `request/edit`, `request/cancel`, `samples/load`, `window/planNow`, `plan/store`, `plan/approve`, `plan/rename`, `truck/add`, `truck/remove`, `truck/markOut`, `truck/markAvailable`, `zone/add`, `zone/update`, `zone/remove`, `rally/pin`, `rally/ban`, `rally/clear`, `settings/update`, `settings/resetMethodParams`, `request/lock`, `snapshot/save`, `data/import`, `data/reset`.

`store.subscribe(fn)` notifies after every action. UI modules re-render from state; they never keep their own copy of domain data.

## 4. Catalog and conversions (catalog.js)

Classes in tie-break order: III (Fuel), I (Food & Water), V (Ammunition), VIII (Medical), IX (Repair Parts). Label format `Class III (Fuel)`.

Load groups:
- **Bulk fuel** (Class III diesel/JP-8 and gasoline, gallons) rides only on tankers (2,500 gal).
- **Everything else** (packaged oil & lubricants, Class I, V, VIII, IX) rides on cargo trucks, measured in pallets (10 per truck). `catalog.js` gives `palletsPerUnit` for every item/option, so a line converts to pallets.

A request with both bulk fuel and other items becomes two jobs (one per load group). A job larger than one truck is split into chunks no larger than truck capacity; chunks can go on different trucks or be deferred (partial fill).

Each item has a notional `dailyUse` per platoon (used for hours-of-supply and for the "more than 5x daily use" warning).

## 5. Grid, travel times and closures (network.js)

Verified 2026-10-05 (see `docs/VERIFICATION.md`). **Travel times come from OpenStreetMap road data (Aidan, 2026-10-06), not Google.** Google Maps Platform terms (3.2.3(a)/(b), Routes API 19.2/19.3) do not allow storing Routes API durations or using them with a non-Google map, so the app embeds no Google data and needs no key.

- `grid.json`: `[{ id, name, lat, lon, kind: 'hub' | 'town' | 'junction' | 'rally', region: 'north' | 'central' | 'south' | 'east', rallyCandidate: bool }]`, about 50 points. Points should sit on primary-or-bigger roads (the router snaps to the nearest graph node).
- `roads_graph.json` (`SRO.data.roads_graph`, 322 KB): Taiwan motorway + trunk + primary road graph built from Overture Maps release 2026-09-23.1 (OpenStreetMap-derived, ODbL), 7,673 nodes, 11,809 edges, one-way rules kept, 15 m simplification. Rebuild with `tools/roads/` (see the README there).
- `src/core/road_router.js` (`SRO.lib.RoadRouter`): `G = RoadRouter.load(data)`; `G.route([lat,lon], [lat,lon], { blocked: [{ lat, lon, radiusM }] }) -> { coords, meters, seconds, snap }` (~1 ms); `G.tree([lat,lon]).pathTo([lat,lon])` reuses one Dijkstra for many targets (all pairs of a 50-point grid in ~250 ms). Class speeds (km/h): motorway 90, trunk 70, primary 55, links 40.
- **Time source order** (`network.source`):
  1. `matrix`: an external matrix file `src/data/time_matrix.json` (`{ source: 'osrm' | 'google' | ..., ids, minutes[i][j], meters[i][j] }`, base times, before the convoy factor) if present and allowed. Only arcs untouched by closed zones use it.
  2. `osm-roads` (default): minutes and miles of the road-graph route between the two points.
  3. `estimate`: if the road graph is missing or a point snaps more than 5 km from it: shortest path over `grid_links.json` (haversine x road factor at road speeds; freeway 1.15/55 mph, highway 1.3/40, mountain 1.8/22, local 1.4/30).
  The UI labels which source produced the times.
- Convoy minutes = base x convoyFactor (1.5), applied by the instance builder, not network.js.
- **Closed zones**: road-graph routes are recomputed with every closed circle in `blocked`, so detours follow real roads. If no route exists the pair is `Infinity` (unreachable). In `estimate` mode, links crossing a closed circle are removed before the shortest path.
- **Risk units** for an arc = sum over risk zones of (miles of the arc's drawn path inside the circle x rating value). Time-of-day risk factor is applied per leg at evaluation time.
- **Off-grid points** (platoon locations for direct delivery): routed on the road graph like grid points; if a platoon snaps more than 5 km from a road, add a final straight leg at haversine x 1.3 at 25 mph and mark the leg `offRoad`.
- `grid_links.json`: `[{ a, b, road: 'freeway' | 'highway' | 'mountain' | 'local' }]`, the coarse fallback graph above.

## 6. Road paths for drawing (roads.js)

`SRO.core.roads.path(fromPoint, toPoint, zones) -> { coords: [[lat,lon]...], source }`, cached by key + closure set:
1. `osm-roads`: the same road-graph route network.js timed (so the drawn path and the time always match).
2. `precomputed`: `src/data/roads.json` from `tools/roads/fetch_osrm_polylines.py` if the user ran it (optional, only for legs no closed zone touches).
3. `straight`: dashed line labelled "approximate" when a point is far from the road graph or no route exists.

No live calls to OSRM from the browser. Attribution shown on the map: "Road data (c) OpenStreetMap contributors (ODbL), via Overture Maps Foundation".

### Base map

- Online and served over http(s): OpenStreetMap tiles (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution required). A page opened from `file://` sends no Referer and OSM blocks it, so tiles only work once the app is hosted (GitHub Pages / PWA).
- Always underneath: the Taiwan coastline (`taiwan_coast.json`, Natural Earth, 6.7 KB) on a sea-colored background, plus the road graph drawn as thin vector lines (motorway/trunk heavier). This is the offline and `file://` map and still shows real roads.
- Fallback rule: drop the tile layer and show a small note when offline, when 4 tile errors occur before any load, when no tile has loaded after 8 s, or when a fetch of the center tile is not ok (catches 403 image bodies). Re-add on the `online` event. No tile prefetching (OSM policy).

### Libraries (pinned, inlined by build.py)

| package | version | global | notes |
|---|---|---|---|
| leaflet | 1.9.4 | `L` | inline CSS; default marker images as data URIs with `L.Icon.Default.imagePath = ''` |
| milsymbol | 3.0.4 | `ms` | 862 KB; `new ms.Symbol(sidc, { size, uniqueDesignation, higherFormation })`, use `getAnchor()` for `iconAnchor` |
| mgrs | 2.2.0 | `mgrs` | `mgrs.forward([lon, lat], 5)` (longitude first); format.js may use its own implementation if it matches |
| highs | 1.15.3 | (worker) | see section 7, MIP |

build.py must rewrite `</script` inside inlined code to `<\/script`.

### Symbols (MIL-STD-2525D SIDCs, all pass `ms.Symbol(...).isValid()`)

| thing | SIDC |
|---|---|
| Dismounted infantry platoon | `10031000141211000000` |
| Mounted (mechanized) infantry platoon | `10031000141211020000` |
| Mounted (motorized) infantry platoon | `10031000141211040000` |
| Fixed-in-place platoon | dismounted or mounted SIDC per unit; "fixed" is shown in the label, not the symbol |
| Hub (supply installation) | `10031000001634000000` drawn with installation indicator, or 2525C `SFGPUSS---H----` |
| Cargo truck | `10031500001401000000` |
| Fuel tanker | `10031500001409000000` |
| Rally / drop point | `10032500003209000000` (Logistics Release Point) |

Truck icons are drawn with the truck's color as a ring or label background so the 2525 frame colors stay standard.

## 7. Solver contract (solver/*)

The solver is pure and deterministic given a seed. The main thread builds an **instance** from state, posts it to the worker, and receives progress and a **solution**.

### Instance (JSON)

```js
{
  startMin,                       // planning time (now)
  nodes: [{ key, kind: 'hub' | 'rally' | 'direct', gridId, lat, lon, label }],
  minutes: [[...]], miles: [[...]], riskUnits: [[...]],   // node x node, already rerouted around closures; Infinity if unreachable
  gridPaths: { 'i|j': [gridId...] },
  periods: [{ startMin, endMin, speed, risk }],           // day-repeating table expanded over 72h
  vehicles: [{ id, type, capacity, hubNode, availableAt, color }],
  jobs: [{ id, requestId, lineIdxs, group: 'fuel' | 'cargo', qty, unit,
           tier: 0..3 (Routine..Immediate), classRank: 0..4, deadline, hardDeadline: bool,
           candidates: [{ node, platoonMiles, platoonCost, hint: bool }],   // direct node and/or rally nodes within radius
           lockedTruck: null | id }],
  weights: { fuel, distance, risk, simplicity },
  params: { mpg, serviceMin, loadMin, maxRallyPoints, pinnedRally: [node], bannedRally: [node] },
  penalties: { latePerMin: [2, 6, 60, 600], defer: [5000, 15000, 60000, 250000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: 0.9, pinUnused: 2000 },
  fixed: null | { /* contingency: delivered stops and en-route truck states */ }
}
```

### Solution

```js
{ routes: [{ vehicle, visits: [{ node, jobs: [{ job, qty }] }] }] }
```

`vehicle`, `node` and `job` are integer indexes into `instance.vehicles`, `instance.nodes` and `instance.jobs`. A vehicle appears in at most one route (one trip per window). Anything not delivered is deferred; `evaluate` derives deferred quantities, so a solution never lists them.

### Evaluation semantics (exact rules for evaluate.js)

- **Start.** A vehicle starts at `startNode` (default `hubNode`) at `t0 = max(instance.startMin, availableAt) + (preloaded ? 0 : loadMin)`, visits its stops in order, then returns to `hubNode`. Contingency re-plans set `startNode`, `availableAt` and `preloaded: true` on en-route trucks, and lock the jobs they carry with `lockedTruck`.
- **Legs.** Travel is integrated across periods so the clock is FIFO (leaving later never arrives earlier): the leg needs `minutes[i][j]` base minutes; in each period the truck covers base minutes at `period.speed` per clock minute until the base minutes are used up. Leg risk = `riskUnits[i][j] * (time-weighted mean of period.risk over the leg's clock minutes)`. `leg.periodIdx` is the period at departure (for display). Miles and risk units are counted for every leg including the return leg. A leg with `minutes = Infinity` makes the solution infeasible.
- **Stops.** Arrival time is the delivery time for every job at that stop. Each stop adds `serviceMin` before departure. No waiting for early arrival.
- **Capacity and type.** Fuel jobs only on tankers, cargo jobs only on cargo trucks; the sum of quantities on a route is at most the vehicle capacity.
- **Splits.** A job may appear in several stops (same or different trucks). Sum of delivered quantity is at most `job.qty`; the remainder is deferred.
- **Nodes.** A job may only be delivered at a node in its `candidates`. Platoon cost is counted once per distinct (requestId, node) pair used: `weights.distance * candidate.platoonCost` (`platoonCost` already includes miles x mobility cost per mile).
- **Rally points.** Distinct rally nodes used (including pinned ones) at most `maxRallyPoints`; banned rally nodes never appear in candidates. A pinned rally node means "use this point": each pinned node that is a candidate of at least one job but receives no delivery adds `pinUnused` (2000).
- **Lateness** per delivered chunk = `min(max(0, arrive - job.deadline) * latePerMin[tier], lateCapShare * defer[tier] * classFactor[classRank]) * qty / job.qty`. The cap keeps a late delivery always cheaper than deferring it to the next window (which would arrive even later).
- **Deferral** per job = `deferredQty / job.qty * defer[tier] * classFactor[classRank]`.
- **Simplicity** = `5 * total stops + 25 * trucks used` (a route with no stops is not used and costs nothing).
- **Violations** (wrong vehicle type, over capacity, node not a candidate, too many rally points, unreachable leg, vehicle used twice, locked job on the wrong truck, quantity over job qty) are listed in `violations` and each adds `1e7` to `total`, so heuristics can pass through infeasible states but never prefer them. `feasible = violations.length === 0`.
- **Hard deadlines.** A late Immediate job is not a violation (sometimes it is unavoidable) but is listed in `hardLate` so the plan can flag it.

`evaluate` returns `{ total, feasible, cost: { fuel, distance, risk, simplicity, platoon, lateness, deferral }, routes: [{ vehicle, depart, returnAt, miles, gallons, riskUnits, stops: [{ node, arrive, depart, periodIdx, jobs }], legs: [{ from, to, depart, arrive, miles, riskUnits, periodIdx }], cost }], delivered: [qty per job], deferred: [{ job, qty }], late: [{ job, minutesLate }], hardLate: [job], rallyNodes: [node], violations: [{ code, detail }] }`. `SRO.solver.explainDeferred(instance, evalResult)` labels each deferred job with a reason (`no-truck`, `closed-road`, `radius`, `time`, `capacity`) for the planner's explanations.

`evaluate(instance, solution)` is the single source of truth for schedule and cost. Every method must score with it, so the compare table is apples to apples.

### Cost (evaluate.js)

```
fuel       = weights.fuel       * gallons                      (gallons = truck miles / mpg)
distance   = weights.distance   * 0.5 * truck miles
risk       = weights.risk       * riskUnits x period risk factor
simplicity = weights.simplicity * (5 * stops + 25 * trucks used)
platoon    = weights.distance   * sum(platoonMiles x mobility costPerMi)
lateness   = sum(min(minutes late x latePerMin[tier], cap)) (see Evaluation semantics)
deferral   = sum(deferred job share x defer[tier] x classFactor[classRank])
pinned     = pinUnused x unused pinned rally nodes that some job could use
total      = sum of the above
```

Penalties are sized (and were re-checked on 2026-10-06 after review found Routine jobs deferred while trucks sat idle under the first values) so that deferral costs more than any single job's routing cost: the longest round trip on the island (~400 miles) costs about fuel 600 + distance 600 + risk ~300 + simplicity 60, under the Routine deferral of 5000. A missed deadline or deferral always costs more than any routing savings, and deferral order follows Routine, Priority, Urgent, Immediate, then class rank, then cost. Immediate deadlines are hard: a solution that misses one is only accepted if no feasible alternative exists, and the plan flags it.

Constraints: capacity per truck per trip; one trip per truck per window; truck starts after `availableAt + loadMin` at its home hub and returns there; at most `maxRallyPoints` distinct rally nodes (pinned count toward it; banned never used); a job's node must be one of its candidates; `lockedTruck` respected.

### Methods

| key | name in UI | notes |
|---|---|---|
| `tabu` | Tabu search | default; relocate/swap/2-opt/rally-reassign moves, tabu tenure, aspiration |
| `sa` | Simulated annealing | same move set, geometric cooling |
| `aco` | Ant colony | pheromone on (node, node) and (job, candidate) choices, local search on best ant |
| `mip` | Exact (MIP) | HiGHS WebAssembly; warm-started from the best heuristic plan; returns best plan found + proven gap at the time limit |

All methods start from `construct.js` output. Each reports progress at least every 250 ms: `{ fraction, bestCost, elapsedSec, message }`. Cancel terminates the worker; the last reported best solution is kept.

`estimate(instance, method, params) -> { seconds, low, high, basis }` from a quick timing probe on the actual instance.

### MIP (mip.js) - verified facts

- At 20 stops / ~29 delivery tasks an arc-based MIP (788 rows, 2,107 columns, 2,020 binaries) never proved optimal: cold start gap 23.5% at 10 s, 19% at 60 s, 7.9% at 300 s. A simple annealing heuristic beat the 300 s MIP result in ~2 s. Warm-started with that plan, HiGHS proved it within 6.4% of optimal in 60 s.
- So "Exact (MIP)" first runs a quick tabu pass (a few seconds), passes that plan to HiGHS as a MIP start, and reports the best plan plus the **proven gap** ("within 6% of the best possible plan"). Its estimate states the time limit, not a finish time. Expect status "Time limit reached".
- Packaging: `highs@1.15.3`; `build/highs.js` inlined as `<script type="text/plain" id="highs-js">`, `highs.wasm` gzip -9 + base64 (1.63 MB) in `<script type="text/plain" id="highs-wasm-gz">`. Worker source = highs.js text + solver files + worker main, started from a Blob URL. In the worker: base64 -> bytes -> `DecompressionStream('gzip')` -> `Module({ instantiateWasm(imports, receive) { WebAssembly.instantiate(bytes, imports).then(r => receive(r.instance)); return {}; } })`. `wasmBinary` / `wasmModule` options are ignored by 1.15.3; do not pass `threads`.
- API: `highs.createModel({ format: 'lp', data })`, `model.options.set({ output_flag: false, time_limit, mip_rel_gap })`, MIP start via `model.setSolution({ indices, values })` (binaries only is fine; column order = first appearance in the LP text, read names with `getColName`), progress via `mipImprovingSolution` and `mipInterrupt` callbacks, results via `getModelStatus()` (7 optimal, 13 time limit), `info.get('mip_gap')`, `getSolution().colValue`; always `dispose()`.
- Cancel: `run()` blocks the worker and `SharedArrayBuffer` is unavailable on `file://`, so cancel = `worker.terminate()` and keep the last incumbent the worker posted (post every improving solution, decoded).
- Reference code from the verification run: `scratchpad/verify-solver/{vrp-model.js, solve-core.js, minimal-template.html, heuristic-sa.js}` (copied to `tools/reference/highs/`).


### Method interface (tabu.js, sa.js, aco.js, mip.js)

Each method registers `SRO.solver.methods[key] = { key, label, run(instance, params, hooks) }`.

- `params` is `SRO.solver.clampParams(key, params, settings)` output (all knobs present).
- `hooks = { onProgress(p), now() -> ms, shouldStop() -> bool, start?: solution }`. `onProgress` is called at least every 250 ms and whenever the best plan improves, with `{ fraction 0..1, bestCost, currentCost?, elapsedSec, iteration, message, best?: solution }`; `best` is included only when it changed since the last call (the worker forwards it so Cancel can keep it). `start` is an optional starting plan (MIP passes the heuristic plan; contingency re-plans pass the adjusted old plan).
- `run` is synchronous (it blocks the worker; cancel = `worker.terminate()`), deterministic for a given `params.seed`, starts from `hooks.start` or `construct()`, scores only with `evaluate`, stops at its iteration budget, `params.timeCapSec`, or `shouldStop()`, and returns `{ solution, total, feasible, evals, iterations, elapsedSec, stopReason: 'budget' | 'time' | 'stopped' | 'converged' | 'optimal', history: [{ t, best }], extra? }` (MIP puts `{ status, mipGap, dualBound, modelObjective }` in `extra`).
- `api.js`: `SRO.solver.solve(instance, { method, params, settings, hooks }) -> result` (normalizes params, runs, re-evaluates the final plan, attaches `evaluation`); `SRO.solver.compare(instance, methods[], opts)` runs them in sequence on the same instance.
- `worker-main.js` message protocol. Page to worker: `{ type: 'init', wasmGzB64 }`, `{ type: 'solve', id, instance, method, params, settings }`, `{ type: 'estimate', id, instance, method, params, settings }`. Worker to page: `{ type: 'ready', highs: bool }`, `{ type: 'progress', id, ...p }`, `{ type: 'done', id, result }`, `{ type: 'error', id, message }`. Instances cross the boundary as JSON with Infinity encoded by `SRO.util.jsonReplacer` / `jsonReviver`.
- MIP needs HiGHS: `SRO.solver.mip.setLoader(fn)` where `fn()` returns a promise for the highs module (Node tests: `require('highs')()`; worker: the `instantiateWasm` loader). `run` must be called after the loader resolved (`SRO.solver.mip.ready()`), so the worker awaits it before solving.

### Method parameters (planner-tunable, Advanced tab)

`src/solver/params.js` is the single source of truth: `SRO.solver.PARAMS[method] = [{ key, label, help, type: 'int'|'float'|'bool'|'select', min, max, step, default, options? }]` plus `SRO.solver.defaultParams(method)` and `SRO.solver.clampParams(method, params)`. The UI builds the tuning form from this table, so a new knob needs one entry here and nothing else in the UI.

| method | key | label in UI | default | range |
|---|---|---|---|---|
| all | `seed` | Random seed | 20261005 | 1-999999999 |
| all | `timeCapSec` | Stop after (seconds) | settings.timeLimitSec | 5-1800 |
| tabu | `iterations` | Iterations | 4000 | 100-100000 |
| tabu | `tenure` | Tabu tenure (moves a change stays forbidden) | 12 | 1-200 |
| tabu | `neighborhood` | Moves checked per iteration | 200 | 10-5000 |
| tabu | `restartAfter` | Restart after this many non-improving iterations | 600 | 0 (off)-50000 |
| tabu | `aspiration` | Allow a forbidden move if it beats the best plan | true | bool |
| sa | `startTemp` | Start temperature (0 = auto) | 0 | 0-1e7 |
| sa | `autoAcceptRate` | Auto start: accept this share of worse moves | 0.5 | 0.05-0.95 |
| sa | `coolingRate` | Cooling rate (per step) | 0.995 | 0.80-0.99999 |
| sa | `itersPerTemp` | Moves per temperature step | 100 | 1-10000 |
| sa | `stopTempRatio` | Stop when temperature falls to this share of start | 0.001 | 1e-6-0.5 |
| sa | `reheats` | Reheats | 2 | 0-20 |
| aco | `ants` | Ants per iteration | 20 | 1-500 |
| aco | `iterations` | Iterations | 150 | 1-10000 |
| aco | `alpha` | Pheromone weight (alpha) | 1.0 | 0-10 |
| aco | `beta` | Distance weight (beta) | 3.0 | 0-10 |
| aco | `evaporation` | Evaporation rate (rho) | 0.10 | 0.01-0.99 |
| aco | `q` | Deposit amount (Q) | 1.0 | 0.01-1000 |
| aco | `localSearch` | Polish best ant with local search | true | bool |
| mip | `timeLimitSec` | Time limit (seconds) | settings.timeLimitSec | 5-1800 |
| mip | `mipGap` | Stop when within this gap of optimal | 0.01 | 0-0.5 |
| mip | `warmStart` | Start from heuristic plan | true | bool |

Rules: heuristics stop at whichever comes first of their own iteration budget, `timeCapSec`, or Cancel. `instance.methodParams` is the clamped copy of `settings.methodParams[method]` and is stored on the Plan (`plan.method`, `plan.params`) so snapshots record exactly what produced them. Changing any knob re-runs `estimate()`. Each method's panel has a "Reset to defaults" button; changed knobs show a dot and their default value beside them. Compare mode runs each selected method with its current params.

## 8. UI contract

- `index.html` has: `#topbar`, `#app` with `#psg-root` and `#planner-root`, `#toast-root`, `#modal-root`, `#print-root`.
- Role switch at the top. On wide screens the platoon sergeant view is a centered phone-width panel; on phones it fills the screen. The planner view uses side panels on wide screens and tabs (Map / Queue / Plan / Scenario / Outputs) on narrow screens.
- Themes via `html[data-theme="dark"|"light"|"night"]` CSS custom properties. Night mode is red-on-black and dims the map tiles.
- Each view module exports `{ mount(el), update(state) }` and registers with `SRO.ui.registerView(name, view)`.
- Map (`SRO.ui.map.create(el, opts)`) is shared by both roles. Layers: base (OSM tiles online, Taiwan coastline offline), zones, hubs, rally points (+ dismounted walking ring), platoons (2525 symbol + urgency ring), routes (truck color + direction arrows), trucks (animated by clock).
- Urgency ring colors: Routine gray, Priority yellow, Urgent orange, Immediate red pulsing. Same colors in lists and cards.
- Truck colors: 8 distinct colors, readable on dark, light and night themes; fixed per truck everywhere.
- Formats: `format.js` is the only place that formats times, DTGs, MGRS, classes and miles.
- Nothing in the app mentions medevac.

## 8b. Planner engine (src/core/planner-engine.js) - contract for views

`SRO.core.engine` connects the store, the road network and the solver worker. Views never build instances or talk to the worker themselves.

- `engine.init(store)` (boot calls it). Creates the solver worker lazily from `#highs-js`, `#worker-src`, `#highs-wasm-gz` (falls back to running heuristics on the main thread if a Blob worker cannot start; MIP is then unavailable).
- `engine.status() -> { phase: 'idle' | 'preparing' | 'estimating' | 'running' | 'done' | 'error' | 'cancelled', method, methods (compare), fraction, bestCost, elapsedSec, message, history: [{ t, best }], error, highsReady }` and `engine.subscribe(fn) -> unsubscribe`. Solver progress is NOT dispatched to the store (that would write localStorage every 250 ms); only the finished Plan is.
- `engine.buildInstance(state, { windowId, now, contingency }) -> { instance, maps, warnings }`: nodes = hubs + rally candidates (not banned) + direct nodes (one per request location that may take direct delivery); travel minutes/miles from `SRO.core.network` (OSM road matrix via `SRO.core.roads.matrix`, closed zones applied), x `settings.convoyFactor`; risk units = miles of the arc's road path inside risk circles x rating; periods expanded from `settings.periods` for 72 h from now; jobs from `catalogHelpers.requestLoads(lines)` per load group (fuel / cargo), tier from final urgency, classRank from the request's top class, deadline, `hardDeadline`; candidates = direct node (always for fixed or `forceDirect` or `directOnly`) plus rally nodes within the mobility radius (road miles from the platoon), `platoonCost = platoon miles x 2 (out and back) x mobility costPerMi`, desired pickup as `hint`; vehicles from `scenario.fleet` with `status !== 'out'`, `availableAt`, colors; weights, params, penalties from settings and solver defaults.
- `engine.estimate(method, params?) -> Promise<{ seconds, low, high, basis }>` for the current window.
- `engine.run({ method, params?, windowId? }) -> Promise<Plan>`; `engine.compare(methods[]) -> Promise<Plan[]>` (one Plan per method, same instance, all stored; the compare table uses `plan.cost` and `plan.stats`); `engine.cancel()` (terminates the worker, stores the best plan so far with `cancelled: true`, restarts the worker).
- `engine.replan({ reason })` contingency: from the approved plan at the current simMin, delivered stops stay done, en-route trucks get `startNode` = next stop, `preloaded: true`, their remaining jobs locked to them; jobs on trucks marked out or cut off go back to the pool; runs the selected method; stores a Plan with `parentPlanId`; requests whose ETA or pickup changed get `updated: true` on approval.
- Auto planning: when the store sets `ui.planRequested` with reason `'boundary'` (window boundary at 0000/0600/1200/1800) and there are pending requests, the engine runs `settings.method` and stores the plan unapproved; the planner reviews and approves. The trigger rule is one function `engine.shouldPlan(state)` so a future "dispatch when worth it" queue rule can replace it.
- Plan decoding: solver solution + evaluation -> the Plan schema in section 3, plus per leg `path` = encoded polyline of the road route (`SRO.core.geo.encodePolyline`, precision 5) for drawing and animation, and per stop `etaText`; per request a `plan.byRequest[requestId] = { truckId, stopSeq, nodeKind, gridId, lat, lon, label, eta, qtyByLine, deferredQty, stopsBefore }` index the platoon sergeant views read.
- Truck colors come from `SRO.data.scenario.truckColors` only.

## 9. Build and tests

- `python3 tools/build.py` writes `prototype/supply-route-app.html`, fully self-contained except OSM tiles and live OSRM paths (both optional at runtime).
- `node --test tests/solver` runs solver tests: evaluate correctness on hand-checked instances, constraint checks on every method's output, brute-force optimum comparison on tiny instances, MIP on a tiny instance equals brute force.
- `tests/ui/*.spec.mjs` opens the built file from `file://` in Chromium at 390x844, 820x1180 and 1440x900 in all three themes and checks the states in section 8.3 of the skill (empty, one request, full window, infeasible window, after contingency re-plan), with zero console errors.
