# Supply route app: interview answers (supply-route-app-builder)

Started 2026-10-05. One entry per settled question; defaults accepted are marked (default).

## Section 1: Users and mission
- Phase: build Phase 1 only (internal to Taiwan, fictional US FOBs + Taiwanese bases, up to n=20 stops). Neighboring nations parked for Phase 2. (default)

### Phase 2 parking list
- Regional hubs: SK, Hawaii, Japan, Guam, Philippines, Australia; sea/air legs.
- Roles: Requester = platoon sergeant (platoon is the lowest echelon the model goes to). Planner = logistician who runs the batch and approves routes. Demo shows both views, one person can switch.
- Requester inputs (PSG): supplies needed, own location, desired pickup location, no-later-than (NLT) time, urgency level. If urgency is high, app asks quantity on hand to gauge how urgent it really is.
- Planner: reviews optimized plan, adjusts if needed, approves; approved plan = movement schedule. (default)

### Queued follow-ups
- Section 2: how on-hand quantity converts to urgency (e.g. hours of supply left vs. consumption rate), and which urgency levels trigger the on-hand question.
- Section 2: desired pickup location vs. 50-mile drop radius: is the PSG's pick binding or a preference?
- Usage: PSG on phone/tablet, planner on laptop at CP; connectivity assumed for demo. Mobile-friendly request view, map-heavy planner view. (default)
- Demo success: (1) client as PSG fills out a request in under 2 minutes with no explanation of any button, and sees it arrive on the planner side. (2) His request + 19 synthetic requests (n=20) are optimized; planner sees per-truck assignments ("Truck A to X, Y, Z; Truck B to E, F, G"); PSG side sees "Pick up at spot F, ETA 2000".
  - Implies: synthetic request generator (19), named trucks, plain-language per-truck stop lists, PSG-facing pickup notice with ETA in 24h time.
- Scope fence: no medevac (points to medevac channels), no real unit/base/operational data, not an Army system of record, no sign-in/accounts/security, no live tracking in v1 (ETAs are planned times). (default, Aidan commented only on tracking)
- Later-phase feature: live (simulated) vehicle tracking as an added realism layer.

## Section 2: The request
- Unit + location: entered once, remembered when the app opens (like cookies). Decision (Claude, resolving conflict with "no sign-in"): one-time unit profile saved on the device, no real authentication. Location defaults to saved value with an "update my location" control since platoons move.
- Supplies: DoorDash-style picker. Choose class, then item, then options ("toppings"): type, quantity, units. Dropdowns / multiselects.
- On hand: optional on any request; mandatory when urgency is Urgent.
- Required: pickup point (or direct-delivery switch), supplies, NLT time, urgency. Optional: remarks. (default)
- Catalog (notional), class > item > options:
  - III: diesel/JP-8, gasoline, oil & lubricants; type + gallons or cases
  - I: MREs, bottled water, bulk water; cases or gallons
  - V: small arms by caliber, grenades, mortar rounds, AT4; type + rounds or boxes
  - VIII: CLS bag refill, IFAK refill, litters, general med kit; kits
  - IX: tires, batteries, filters, "other part" with description; part type + count
  - Fixed catalog; only free text is IX "other part" description and remarks.
- Urgency: Routine (NLT, low weight), Priority (NLT, higher weight), Urgent (NLT hard, on hand required).
  - Urgent flow (Aidan): app computes hours of supply left from on hand. If >24h, app asks "how much longer until you run out?" (mission may burn faster than average). If that answer is <24h, request is bumped to a 4th tier: Immediate (must deliver immediately).
  - Edges: computed hours <24 goes straight to Immediate; self-reported >=24 stays Urgent (no downgrade). (default)
  - Immediate (Aidan correction): NOT always first stop. It is a hard deadline = min(NLT, run-out time) with the highest weight; the optimizer picks the sequence.
    - Aidan: "it might make sense to make a few stops along the way" (en-route stops before an Immediate stop are fine if the deadline holds).
- Urgency vs class: urgency always wins; class order III > I > V > VIII > IX only breaks ties within a tier.
- Pickup binding (Aidan): depends on how fixed in place / mobile the unit is. Mounted vs dismounted matters; can't make light infantry walk 20 mi mid-mission for ammo. Dismounted default radius = 5 mi.
- Mobility (profile, overridable per request): Mounted = pickup preference, 50 mi default radius; Dismounted = preference, 5 mi default; Fixed in place (holding / in contact) = binding, deliver direct. Optimizer counts the platoon's own pickup trip in cost. (Aidan: "those three are good")
- Split / partial fill: yes. Split across trucks or partial now + remainder next window when short; PSG sees "40 of 60 cases MRE at F, ETA 2000; 20 more next window"; planner sees shortfalls highlighted; Immediate never partial unless nothing else meets it. (default + Aidan "it can be split")
- After submit: cancel allowed (edits until approval per default). Once planned, PSG sees: the delivery schedule (which stops come before theirs), delivery unit callsign and radio frequency (notional), and progress along the route. Live location "if we can".
  - Decision (Claude): v1 shows progress from a simulated demo clock moving trucks along planned routes; true live tracking stays on the later-features list.
- Validation: block location outside Taiwan, NLT in the past, zero quantity, Urgent without on hand. Warn on quantity >5x typical daily use and NLT sooner than nearest hub can reach. Plain-language fix-it messages. (default)
- Medevac: NOTHING in the app about medevac, not even a note. (Aidan: "a PSG knows how to call a medevac and when to call one")

## Section 3: The world
- Hubs (Phase 1): FOB Granite (US, north/Taipei area), Base Jade (TW, central/Taichung), FOB Anvil (US, south/Kaohsiung), Base Lotus (TW, east/Hualien). Fictional names, plausible non-real-base coordinates.
  - Stock: INFINITE in Phase 1 (Aidan). Shortfalls come only from truck capacity / time.
- Phase 2 parking: hub stock becomes finite and hubs need resupply from theater (Pacific-wide).
- Travel times: fixed grid of ~50 named points (hubs, drop points, towns) across Taiwan; a one-time script pulls Google drive times between all pairs and the matrix is embedded in the app (no key in app). Request locations snap to nearest grid point; short leg estimated. Aidan creates the Google Cloud key and runs the script once. Until then the build uses straight-line x road-factor fallback, labeled as such. (default)
  - Unverified: claim that ~2,500 elements fits Google's free monthly usage; check current Routes API pricing before running.
- Scale: up to 20 STOPS per window. Requests can exceed 20; requests are grouped by stop (shared drop points). Demo generator should therefore produce enough synthetic requests that they consolidate to <=20 stops.
- Rally points: = drop points. Planner activates up to 8 per window by tapping the map (snap to grid), can move them between windows ("floating"). Optimizer assigns each request to an active rally point within the platoon's mobility radius. (default)
- Fleet: notional 2 per hub default (1 fuel tanker 2,500 gal bulk III; 1 cargo truck 10 pallets for everything else incl. packaged oil). Speed = Google time x 1.5 convoy factor; ~2 mpg; trucks start/end at home hub; no rotary wing in Phase 1. (default, "those assumptions are fine")
  - Number of trucks is a PLANNER PARAMETER (per hub/type) so trucks can be taken out for a blown tire or maintenance (Aidan).
- Road network: planner draws circles; Closed = no route through it, optimizer routes around via other grid points. Aidan answered "closed" to the zone-type question; high-risk zone type deferred to the risk question.
- Risk: planner draws risk circles rated Low/Medium/High; each mile inside adds that rating to the route's risk cost; time of day modifies it (next question). (default)
- Time of day: editable table, planner can change. Day 0700-1800 speed x1.0 risk x1.0; Dusk 1800-1930 x0.9 / x1.2; Night 1930-0530 x0.7 / x0.8; Dawn 0530-0700 x0.9 / x1.2. Applied per leg by the period it is driven in; timeline shades the four periods. (default)

## Section 4: The optimizer
- Optimizer (Aidan): product, not academic: answer must come back in minutes. Assume instances complicated enough that an exact solver can be too slow. Planner picks the method from a dropdown that includes heuristics AND MIP, each with a compute-time estimate shown before running.
  - Supersedes my "heuristic + offline exact benchmark" suggestion. Open build questions: MIP must run in-browser (WebAssembly build, e.g. HiGHS) to keep single-file; verify availability and speed at build time. Time estimate method TBD (size-based, calibrated by a quick timing run).
- Method dropdown (Aidan): add ant colony; no point in a <1s solution that is not near-optimal. Resulting list: Balanced = tabu search (~5-30s est.), Thorough = simulated annealing (~1-3 min est.), Ant colony (est. TBD), Exact MIP (planner time limit, default 5 min; returns best-so-far + gap at cutoff). Nearest-neighbor + 2-opt dropped as a selectable option; kept internally only as the starting plan for the others. Time estimates from a quick timing run on the actual window; ranges are guesses until built.
- Compare mode: planner checks methods, app runs them one after another on the same requests, shows table (total cost, late requests, run time); planner picks one plan to approve. (default, Aidan "Yes that is good")
- Planning window: fixed 6-hour cycle for v1. Future capability (design for it): requests go into a queue and a mission dispatches when a worth-it threshold is reached (not a near-empty truck because 6h passed, not waiting 48h to fill 8 trucks). Keep the trigger rule pluggable in the build.
  - Open follow-up for the demo: with a 6h clock, does the planner still get a "Plan now" button so the demo can run on demand? (asked next)
- "Plan now" button for demo: yes; 6h cycle shown on screen as normal rhythm.
- Objective: four planner sliders 0-10, defaults fuel 3, distance 3, risk 5, simplicity 2. Fuel = gallons (miles / 2 mpg); distance = total miles; risk = miles in risk zones x zone rating x time-of-day factor; simplicity = fewer stops per truck + fewer trucks used. Missed deadlines cost far more than any term; Immediate worst. (default)
- Overflow: delay order Routine > Priority > Urgent; Immediate last resort. Within a tier lowest class priority first, then cheapest to defer. Deferred = carried to next window, red on planner view, PSG told "not in this window, next starts HHMM". (default)
- Drop point choice (Aidan): not picked manually; part of the solver. Interpreting as: solver also chooses WHERE floating rally points go (candidate grid points), superseding earlier "planner taps up to 8 on the map". Confirming interpretation next (planner pin/ban override? PSG desired pickup = hint?).
- Rally points (final, supersedes earlier): solver picks which grid points become rally points and request->rally point assignment each window; planner sets max count (default 8) and may optionally pin or ban a point. PSG desired pickup = hint. Platoon's own trip counted in cost, bounded by mobility radius; shared points collapse requests into <=20 stops.
- Contingency: planner marks truck out or draws closed zone, presses Re-plan; solver keeps delivered stops, replans remainder, reassigns affected stops; before/after comparison shows moved stops; affected PSGs see updated ETA/pickup marked "updated". (default)
- Planner settings: visible = method dropdown, time limit, 4 cost sliders, trucks per hub, max rally points. Advanced = convoy speed multiplier (1.5), fuel burn (2 mpg), time-of-day table, risk ratings, daily use rates, per-method knobs (ants, cooling rate, etc.). Plain-language labels with defaults shown. (default)
- Explainability: click a route -> cost split (fuel/distance/risk/simplicity) + near-miss deadlines; click a delayed request -> what blocked it (capacity, closed road, etc.).

## Section 5: User interface
- Screens: all six (PSG: Request, My requests; Planner: Queue, Plan, Route detail, Scenario). Addition (Aidan): per-truck color coding also on the PSG phone; PSG sees their truck moving along its route on the map (simulated demo clock in v1; real live location later).
- Structure: one app with a Platoon sergeant / Planner switch at the top; PSG view shown as phone-width panel on laptop. (default)
- Map symbols (Aidan): military symbols (MIL-STD-2525 style) for platoons; fictional units but real-format designators (e.g. "1st PLT, B CO, 3-21 IN"). Plan: milsymbol (open-source JS, loaded from CDN) - unverified, check at build. Urgency can't be pin color anymore (affiliation color is fixed), so urgency shown as ring/badge (asked next). Note: invented designators may coincide with real units by chance; no real locations or data used.
  - Clarified by Aidan: real (standard MIL-STD-2525) symbols, not stand-ins. Unit designators fictional but real-format.
- Map layers: hubs fixed icons; rally points distinct icon + walking-radius ring for dismounted; platoons = 2525 symbols; routes = per-truck color lines with direction arrows; risk zones red shading, closed zones gray hatching.
- Urgency display: colored ring around symbol: gray Routine, yellow Priority, orange Urgent, red pulsing Immediate; same colors in queue and phone views. (default, "This is good")
- Truck movement view (Aidan): must be overlaid on the real map of Taiwan, truck moving along the actual road path, NOT a simplified line across dots. Applies to PSG phone and planner map.
  - Consequence: need road GEOMETRY (polylines) per grid-point pair, not just travel times. Google computeRouteMatrix returns times only; polylines need per-route calls (more calls). Google terms may limit storing/caching route data (unverified, check before build). Alternative: OpenStreetMap/OSRM (open license, geometry + times). Base map: Leaflet + OSM tiles unless Google JS API chosen. Decision pending (asked next).
- Google Maps role (Aidan): ONLY arc travel times between grid nodes (base value, x1.5 convoy factor applied by us). All solving/ordering is ours. Nothing else from Google (no paths, no tiles by default).
  - Open: road paths for drawing must come from elsewhere: proposed OpenStreetMap routing (OSRM) polylines + OSM tiles. Caveat: drawn path may differ slightly from the Google route its time came from. Also check Google's terms on storing travel times (unverified).
- Road paths + base map: OpenStreetMap (OSRM polylines, OSM tiles). Planner screen shows a small note that drawn paths may differ slightly from the Google-timed route. TODO before build: check Google's terms on storing travel times.
- Truck movement (PSG phone): small map overlay of Taiwan with truck dot sliding along real road path, numbered stops ahead, status line "Truck Alpha-2, 3 stops away, ETA 2000"; planner controls demo clock (start/pause/speed).
- Planner summary strip (L to R): requests in window, stops, trucks used, total miles, fuel gallons, risk score, delayed requests (red, clickable), solver run time. (default)
- PSG post-submit card: request summary, status "Submitted, next plan at HHMM", Cancel; after approval shows pickup spot, ETA, truck callsign + frequency; delayed shows "not in this window, next plan at HHMM". (default)
- Planner overrides: lock request to a truck, force direct delivery for one request, remove a truck; then Re-plan. No manual stop dragging in v1. (default)
- Empty state: Taiwan map + 4 hubs + message "No requests yet. Submit one as a platoon sergeant, or load sample requests." "Load sample requests" fills 19 synthetic requests alongside the real one. (default)
- Themes: dark default, light option, red-tinted night mode (esp. PSG phone); toggle at top; urgency + truck colors readable in all three. (default)
- Responsive: must work on ALL devices (Aidan). Both views fully responsive: PSG phone-first; planner stacks to tabs (map / queue / plan) on small screens.
- Solver run display: progress bar + method name + estimate; live best-cost line for iterative methods; on finish map redraws and summary strip pulses once; Cancel keeps best plan so far. (default)
- Formats: 24h time (2000), DTG for planner (061430Z OCT); MGRS shown with locations; classes "Class III (Fuel)"; miles; catalog units. (default)

## Section 6: Outputs and handoff
- Planner outputs: printable movement table, one block per truck (stop, arrival, cargo by class, rally point, platoons served); save as PDF or CSV; optional one-page pickup notice per platoon. (default)
- Save/reload: approved plans saved as named snapshots; "Compare to previous plan" highlights changes; stored in browser on that device; export button for file backup. (default)
  - Flag raised: browser storage means a phone and a laptop do NOT share data. Cross-device live demo needs a shared backend (asked next).
- Sync: one device with role switch for now; build data layer behind an interface so a shared online service can be plugged in later (future: real phone -> planner laptop).
- History: tab listing each window, its requests, approved plan, final statuses; stored on device + export. Section 6 requester output already covered by status card. (default)

## Section 7: Build format
- Build format discussion: Aidan asked about a downloadable phone app. Options: (a) single HTML file (now), (b) installable web app / PWA (same code, add-to-home-screen, offline cache; needs HTTPS hosting e.g. GitHub Pages; no repo attached yet), (c) native iOS/Android (store/TestFlight, separate build, much more work; not recommended for prototype). Recommended: single file first, structured to convert to PWA when hosted. Awaiting confirmation.
- Build format: single self-contained HTML file, /mnt/project-files/prototype/supply-route-app.html. Convert to installable web app (PWA) after the interview; set up GitHub then (Aidan: "after all your initial questions let's set up github").
- Verify at build: WASM solver loads from file:// (embed inline if not); map tiles need internet (offline needs pre-cached tiles).

## 8.1 Open questions (asked one at a time)
- Demo clock: starts 0600 fixed date; windows 0600/1200/1800/0000; start/pause; real, 60x, 600x. (default, accepted)
- Phase 2 (Aidan): a friend is building a Phase 2-focused app now; the two will be merged later. Hold ALL Phase 2 questions until his app is available. Design implication for Phase 1: keep data model, solver interface and hub/arc definitions modular so a merge is feasible. (Phase 2 parking list above stays untouched.)
- Sample requests: 19 seeded-random (fixed seed, changeable), mostly Routine/Priority, 2-3 Urgent, 1 Immediate; fuel/food/ammo most common; mixed mounted/dismounted, 1-2 fixed in place; spread across four regions, collapsing to <=20 stops. (default)
- Grid points: Claude drafts ~50 (4 hubs, ~12 west-coast corridor towns/junctions, ~8 east/mountain passes, rest candidate rally points on main roads) into a file for Aidan to review/edit before the Google script. Fictional hub names, generic public place names, no real base/unit locations. (default)
- Small details delegated to Claude (callsigns Alpha-1/2 per hub etc., colors, notional daily use rates, sample unit names, notional frequencies like 45.250, pallet conversions); every choice recorded in draft notes. (accepted)
- Truck trips: one trip per truck per window; truck must be back at hub before reuse; truck still out at next plan shows "en route, back at HHMM" and is unavailable; trips may cross into next window with free-up time shown. (default)
- Claude decisions (small details, to record in draft notes): stop service time 15 min per stop, 20 min load time at hub.
- Open-question queue: EMPTY. Next: GitHub setup, then build.
