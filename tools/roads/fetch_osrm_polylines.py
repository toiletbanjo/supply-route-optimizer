#!/usr/bin/env python3
"""
fetch_osrm_polylines.py - one-time, run on your own machine (needs internet).

Fetches real road polylines between grid points from the public OSRM demo server
and writes them to a JSON file the prototype can embed.

  python3 fetch_osrm_polylines.py grid_points.csv osrm_polylines.json
  python3 fetch_osrm_polylines.py grid_points.json osrm_polylines.json --mode knn --k 8

Input: CSV with header name,lat,lon  (or JSON list of {"name","lat","lon"}).
Pairs: --mode all   = every unordered pair (50 points -> 1,225 requests, about 21 minutes)
       --mode knn   = each point to its K nearest neighbours (50 points, k=8 -> ~250 requests)
Only one direction per pair is fetched; the app reverses the polyline for the other direction.

OSRM demo server policy (https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server,
https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy): at most 1 request per second,
no heavy use, a valid User-Agent identifying the application, display ODbL/OSM attribution and
"routes: OSRM". This script defaults to 1.1 s between requests and identifies itself.

Standard library only (no pip installs). Safe to stop and re-run: finished pairs are kept in
the output file and skipped next time (--fresh to start over).
"""
import argparse, csv, json, math, os, signal, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

DEFAULT_HOST = "https://router.project-osrm.org"
UA = "supply-route-optimizer-prototype/0.1 (one-time grid polyline fetch; contact: set --contact)"


def load_points(path):
    if path.lower().endswith(".json"):
        pts = json.load(open(path, encoding="utf-8"))
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            pts = list(csv.DictReader(f))
    out, seen = [], set()
    for p in pts:
        name = str(p["name"]).strip()
        if name in seen:
            sys.exit(f"duplicate point name: {name}")
        seen.add(name)
        lat, lon = float(p["lat"]), float(p["lon"])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            sys.exit(f"bad coordinate for {name}: {lat},{lon}")
        out.append({"name": name, "lat": lat, "lon": lon})
    return out


def haversine_m(a, b):
    r = math.pi / 180
    h = math.sin((b["lat"] - a["lat"]) * r / 2) ** 2 + math.cos(a["lat"] * r) * math.cos(b["lat"] * r) * math.sin((b["lon"] - a["lon"]) * r / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def decode_polyline(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                r |= (b & 0x1F) << sh; sh += 5
                if b < 0x20:
                    break
            vals.append(~(r >> 1) if r & 1 else r >> 1)
        lat += vals[0]; lon += vals[1]
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def encode_polyline(pts):
    out, plat, plon = [], 0, 0
    for la, lo in pts:
        a, b = round(la * 1e5), round(lo * 1e5)
        for d in (a - plat, b - plon):
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63)); d >>= 5
            out.append(chr(d + 63))
        plat, plon = a, b
    return "".join(out)


def simplify(pts, tol_m):
    """Douglas-Peucker in local metres; keeps first/last point."""
    if tol_m <= 0 or len(pts) < 3:
        return pts
    kx = 111320 * math.cos(math.radians(pts[0][0])); ky = 110540
    P = [(lo * kx, la * ky) for la, lo in pts]
    keep = [False] * len(P); keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = P[i], P[j]
        dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((P[k][0] - x1) * dx + (P[k][1] - y1) * dy) / L2))
            d = math.hypot(P[k][0] - x1 - t * dx, P[k][1] - y1 - t * dy)
            if d > best:
                best, bi = d, k
        if best > tol_m:
            keep[bi] = True; stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def make_pairs(points, mode, k):
    if mode == "all":
        return [(i, j) for i in range(len(points)) for j in range(i + 1, len(points))]
    pairs = set()
    for i, p in enumerate(points):
        near = sorted((haversine_m(p, q), j) for j, q in enumerate(points) if j != i)[:k]
        for _, j in near:
            pairs.add((min(i, j), max(i, j)))
    return sorted(pairs)


def fetch_route(host, a, b, user_agent, timeout, retries, log):
    coords = f"{a['lon']:.6f},{a['lat']:.6f};{b['lon']:.6f},{b['lat']:.6f}"
    url = f"{host.rstrip('/')}/route/v1/driving/{coords}?" + urllib.parse.urlencode(
        {"overview": "full", "geometries": "polyline", "alternatives": "false", "steps": "false"})
    req = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/json"})
    delay = 2.0
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != "Ok" or not data.get("routes"):
                # NoRoute / NoSegment etc. are answers, not transient errors: do not retry
                return None, f"OSRM code {data.get('code')}: {data.get('message', '')}"
            r = data["routes"][0]
            wps = data.get("waypoints") or [{}, {}]
            return {
                "polyline": r["geometry"],               # Google encoded polyline, precision 5, [lat,lon]
                "distance_m": round(r["distance"], 1),
                "duration_s": round(r["duration"], 1),   # OSRM car estimate; the app uses Google times
                "snap_m": [round(w.get("distance", 0.0), 1) for w in wps],
            }, None
        except urllib.error.HTTPError as e:
            status = e.code
            if status in (400, 404):
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    return None, f"HTTP {status} OSRM code {body.get('code')}: {body.get('message', '')}"
                except Exception:
                    return None, f"HTTP {status}"
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
            log(f"    HTTP {status}, retry {attempt}/{retries} in {wait:.0f}s")
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            wait = delay
            log(f"    {type(e).__name__}: {e}, retry {attempt}/{retries} in {wait:.0f}s")
        time.sleep(wait)
        delay = min(delay * 2, 120)
    return None, "gave up after retries"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("points", help="CSV (name,lat,lon) or JSON list")
    ap.add_argument("out", help="output JSON file (also used to resume)")
    ap.add_argument("--mode", choices=["all", "knn"], default="all")
    ap.add_argument("--k", type=int, default=8, help="neighbours per point for --mode knn")
    ap.add_argument("--host", default=DEFAULT_HOST, help="OSRM base URL (e.g. your own docker OSRM)")
    ap.add_argument("--interval", type=float, default=1.1, help="seconds between request starts (>= 1.0 for the demo server)")
    ap.add_argument("--retries", type=int, default=6)
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--contact", default="", help="email or URL to put in the User-Agent (recommended)")
    ap.add_argument("--fresh", action="store_true", help="ignore any existing output file")
    ap.add_argument("--simplify-m", type=float, default=15.0,
                    help="Douglas-Peucker tolerance in metres applied before saving (0 = keep OSRM full geometry; "
                         "full geometry for 50 points/all pairs is roughly 13 MB, 15 m roughly 3 MB)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and first URLs, do not fetch")
    args = ap.parse_args()
    if args.host == DEFAULT_HOST and args.interval < 1.0:
        sys.exit("The OSRM demo server allows at most 1 request per second; use --interval >= 1.0")

    points = load_points(args.points)
    pairs = make_pairs(points, args.mode, args.k)
    ua = UA.replace("set --contact", args.contact) if args.contact else UA

    out = {"points": points, "pairs": {}, "failed": {}}
    if os.path.exists(args.out) and not args.fresh:
        old = json.load(open(args.out, encoding="utf-8"))
        same = [(p["name"], p["lat"], p["lon"]) for p in old.get("points", [])] == [(p["name"], p["lat"], p["lon"]) for p in points]
        if same:
            out["pairs"] = old.get("pairs", {})
            print(f"resuming: {len(out['pairs'])} pairs already in {args.out}")
        else:
            print("existing output has different points; starting fresh")
    todo = [(i, j) for i, j in pairs if f"{points[i]['name']}|{points[j]['name']}" not in out["pairs"]]
    eta = len(todo) * args.interval / 60
    print(f"{len(points)} points, {len(pairs)} pairs ({args.mode}), {len(todo)} to fetch, ~{eta:.0f} min at {args.interval}s/request")
    if args.dry_run:
        for i, j in todo[:3]:
            a, b = points[i], points[j]
            print(f"  {args.host}/route/v1/driving/{a['lon']:.6f},{a['lat']:.6f};{b['lon']:.6f},{b['lat']:.6f}?overview=full&geometries=polyline")
        return

    def save():
        out["source"] = (f"OSRM ({args.host}); road data (c) OpenStreetMap contributors, ODbL. "
                         "Display attribution: 'Routes: OSRM. Map data (c) OpenStreetMap contributors (ODbL)'.")
        out["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        out["format"] = "pairs keyed 'A|B' (A listed before B in points); reverse polyline for B->A"
        tmp = args.out + ".tmp"
        json.dump(out, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        os.replace(tmp, args.out)

    def on_term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, on_term)
    try:
        run_loop(todo, points, out, args, ua, save)
    except KeyboardInterrupt:
        save()
        sys.exit(f"interrupted: {len(out['pairs'])} pairs saved to {args.out}; re-run the same command to resume")
    save()
    size = os.path.getsize(args.out)
    print(f"done: {len(out['pairs'])} pairs ok, {len(out['failed'])} failed, {size/1e6:.2f} MB -> {args.out}")
    if out["failed"]:
        print("re-run the same command to retry failed pairs")


def run_loop(todo, points, out, args, ua, save):
    last = time.monotonic()  # also wait one interval before the first request (protects quick re-runs)
    for n, (i, j) in enumerate(todo, 1):
        a, b = points[i], points[j]
        wait = args.interval - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
        last = time.monotonic()
        key = f"{a['name']}|{b['name']}"
        res, err = fetch_route(args.host, a, b, ua, args.timeout, args.retries, print)
        last = time.monotonic()  # retries count against the throttle too
        if res:
            if args.simplify_m > 0:
                full = decode_polyline(res["polyline"])
                res["polyline"] = encode_polyline(simplify(full, args.simplify_m))
                res["points_full"] = len(full)
            out["pairs"][key] = res
            out["failed"].pop(key, None)
            ratio = res["distance_m"] / max(haversine_m(a, b), 1)
            flag = "  <-- check: big detour or bad snap" if ratio > 3 or max(res["snap_m"]) > 2000 else ""
            print(f"[{n}/{len(todo)}] {key}: {res['distance_m']/1000:.1f} km road, x{ratio:.2f} straight, snap {res['snap_m']} m{flag}")
        else:
            out["failed"][key] = err
            print(f"[{n}/{len(todo)}] {key}: FAILED {err}")
        if n % 10 == 0:
            save()


if __name__ == "__main__":
    main()
