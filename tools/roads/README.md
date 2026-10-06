# Road data tools

The app ships `src/data/roads_graph.json`: Taiwan motorway, trunk and primary roads from Overture Maps
release 2026-09-23.1 (transportation/segment), derived from OpenStreetMap. License: ODbL.
Attribution shown in the app: "Road data (c) OpenStreetMap contributors (ODbL), via Overture Maps Foundation".

Rebuild (only needed to refresh the data):

1. `python3 -m pip install pyarrow requests`
2. `python3 overture_scan.py` reads only parquet footers over HTTP range requests and finds the Taiwan row groups.
3. `python3 overture_fetch.py` downloads only those row groups and columns (~380 MB transfer) into `overture_tw_major.json`.
4. `node build_graph.mjs overture motorway,trunk,primary 15 ../../src/data/roads_graph.json`
   keeps the largest strongly connected component, merges degree-2 chains, simplifies to 15 m and encodes polylines.

Overture removes old releases from S3 after a few months; update the release path in `overture_scan_lib.py` if needed.

Other tools:

- `extract_taiwan_coast.js 0.002 4` builds `src/data/taiwan_coast.json` from Natural Earth (world-atlas countries-10m, id 158), main island plus Penghu.
- `fetch_osrm_polylines.py` (optional) fetches exact OSRM road polylines for grid pairs from the public OSRM demo server, at most 1 request per second, with resume. Not needed: the embedded graph already draws real roads.
