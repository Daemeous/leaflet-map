"""
run_pipeline.py
===============
End-to-end pipeline for building a leafletting spreadsheet from scratch.

Steps
-----
  1  Load & validate constituency config
  2  Fetch ward boundaries from Boundary-Line GeoPackage → <prefix>_wards.geojson
  3  Fetch all named roads from Overpass API            → roads_raw.json
  4  Clip roads to wards, compute assignments           → <prefix>_Leafletting.xlsx

Nothing is held in memory longer than necessary:
  - Ward GeoDataFrame (~17 rows) stays loaded throughout — negligible RAM.
  - OSM roads JSON is loaded once; road geometries are processed one road
    at a time and discarded immediately after writing their output row.
  - Output rows accumulate as plain dicts (strings/numbers only; no Shapely
    objects are retained after each road is processed).

Requirements
------------
    pip install geopandas pandas shapely openpyxl requests

Inputs
------
    constituency_config.py      — edit this to target a constituency
    Boundary-Line.gpkg          — OS Boundary-Line product (any recent edition)
                                  download from: https://osdatahub.os.uk/downloads/open/BoundaryLine

Usage
-----
    python run_pipeline.py

Re-running
----------
    roads_raw.json is NOT re-fetched if it already exists (Overpass is slow).
    Delete it manually if you need a fresh road fetch.
    All other outputs are always regenerated.
"""

import json
import sys
import time
from pathlib import Path

import requests
import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from constituency_config import get_config

# ══════════════════════════════════════════════════════════════════════════════
#  Constants
# ══════════════════════════════════════════════════════════════════════════════

GPKG_FILE        = "Boundary-Line.gpkg"
WARD_LAYER       = "district_borough_unitary_ward"
ROADS_JSON       = "roads_raw.json"
OVERPASS_URL     = "https://overpass-api.de/api/interpreter"

# A road is "dominant" in a ward if that ward contains ≥80 % of its length.
DOMINANT_WARD_THRESHOLD = 0.80

# Road fragments shorter than this fraction of total road length are noise
# (boundary artefacts) and are silently dropped.
MIN_FRAGMENT_RATIO = 0.02

# ── Boundary-road detection ───────────────────────────────────────────────────
# A road running *along* a ward boundary gets clipped to both sides, creating
# two fragments that look like separate roads.  We detect this and assign the
# whole road to the dominant ward.
#
# A secondary fragment is treated as a boundary artefact (not a genuine
# cross-ward segment) when ALL of the following are true:
#   1.  The dominant ward holds >= DOMINANT_WARD_THRESHOLD of the road.
#   2.  The secondary fragment is <= BOUNDARY_ROAD_SECONDARY_MAX of total length.
#   3.  The secondary fragment lies within BOUNDARY_ROAD_TOLERANCE degrees of
#       the shared ward boundary line.
#
# Long roads that genuinely cross into a third+ ward are NOT affected because
# their secondary fragment will sit well inside that ward, not on its boundary.

BOUNDARY_ROAD_SECONDARY_MAX = 0.15   # secondary fragment <= 15% of total
BOUNDARY_ROAD_TOLERANCE     = 0.0003 # approx 30 m in degrees at UK latitudes

# ══════════════════════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _norm_name(name: str) -> str:
    """Lower-case, strip whitespace — used for fuzzy ward matching."""
    return name.strip().lower()


def _geometry_to_text(geom) -> str:
    """
    Shapely geometry → pipe-delimited WKT string.

    Strips the space between the type keyword and '(' that Shapely inserts
    (e.g. 'LINESTRING (...)' → 'LINESTRING(...)') so the HTML parseWKT()
    function can parse it without modification.
    """
    if geom is None or geom.is_empty:
        return ""

    def _norm(s: str) -> str:
        return (
            s.replace("LINESTRING (", "LINESTRING(")
             .replace("MULTILINESTRING (", "MULTILINESTRING(")
        )

    if geom.geom_type == "LineString":
        return _norm(geom.wkt)
    if geom.geom_type == "MultiLineString":
        return "|".join(_norm(g.wkt) for g in geom.geoms)
    # Fallback — should not normally be reached for road geometries
    return _norm(geom.wkt)


def _representative_latlon(geom):
    """Return (lat, lon) for the centroid of a geometry."""
    c = geom.centroid
    return round(c.y, 6), round(c.x, 6)


def _is_boundary_artefact(fragment_geom, dominant_ward_polygon, other_ward_polygon) -> bool:
    """
    Return True if a road fragment looks like a boundary artefact rather than
    a genuine cross-ward segment.

    The test: does the fragment lie almost entirely within BOUNDARY_ROAD_TOLERANCE
    degrees of the shared boundary line between the two ward polygons?

    We approximate the shared boundary as the intersection of the two polygon
    exteriors (a LineString / MultiLineString). If the fragment's distance from
    that line is less than BOUNDARY_ROAD_TOLERANCE, it is running *along* the
    boundary and should be absorbed into the dominant ward.
    """
    try:
        shared_boundary = dominant_ward_polygon.boundary.intersection(
            other_ward_polygon.boundary
        )
        if shared_boundary.is_empty:
            return False
        return fragment_geom.distance(shared_boundary) < BOUNDARY_ROAD_TOLERANCE
    except Exception:
        return False



# ══════════════════════════════════════════════════════════════════════════════
#  Step 1 — Validate config
# ══════════════════════════════════════════════════════════════════════════════

def step1_load_config():
    print()
    print("=" * 60)
    print("STEP 1 — Load configuration")
    print("=" * 60)

    cfg = get_config()

    print(f"Constituency : {cfg['display_name']}")
    print(f"Output prefix: {cfg['output_prefix']}")
    print(f"Bounding box : {cfg['bbox']}")
    print(f"Wards        : {len(cfg['wards'])}")

    for name, district in cfg["wards"]:
        print(f"  {name:45s} [{district}]")

    return cfg


# ══════════════════════════════════════════════════════════════════════════════
#  Step 2 — Fetch ward boundaries
# ══════════════════════════════════════════════════════════════════════════════

def step2_fetch_boundaries(cfg):
    print()
    print("=" * 60)
    print("STEP 2 — Fetch ward boundaries from Boundary-Line")
    print("=" * 60)

    gpkg = Path(GPKG_FILE)
    if not gpkg.exists():
        sys.exit(
            f"ERROR: {GPKG_FILE} not found.\n"
            "Download Boundary-Line from:\n"
            "  https://osdatahub.os.uk/downloads/open/BoundaryLine\n"
            "and place it in this directory."
        )

    print(f"Loading {GPKG_FILE} …")
    gdf = gpd.read_file(gpkg, layer=WARD_LAYER)
    print(f"  Total wards in GeoPackage: {len(gdf):,}")

    # Staffordshire covers both Stafford Borough and South Staffordshire
    gdf = gdf[gdf["File_Name"] == "STAFFORDSHIRE_COUNTY"].copy()
    print(f"  Staffordshire wards: {len(gdf)}")

    # ── Match ward names (with/without " Ward" suffix) ────────────────────────
    # Build a lookup: normalised_name → original gpkg row
    gpkg_lookup = {_norm_name(n): n for n in gdf["Name"]}

    matched_gpkg_names = []   # exact names as they appear in gpkg
    district_map       = {}   # gpkg_name → district label
    missing            = []

    for user_name, district in cfg["wards"]:
        norm = _norm_name(user_name)

        # Try bare name first, then with " Ward" appended
        candidates = [norm, norm + " ward"]
        found = None

        for candidate in candidates:
            if candidate in gpkg_lookup:
                found = gpkg_lookup[candidate]
                break

        if found is None:
            missing.append(user_name)
        else:
            matched_gpkg_names.append(found)
            district_map[found] = district

    if missing:
        print()
        print("ERROR: Could not match the following ward names:")
        for m in missing:
            print(f"  '{m}'")
        print()
        print("Available Staffordshire ward names in GeoPackage:")
        for n in sorted(gdf["Name"]):
            print(f"  {n}")
        sys.exit("Fix ward names in constituency_config.py and retry.")

    matched = gdf[gdf["Name"].isin(matched_gpkg_names)].copy()

    # Report resolved names so the user can spot mismatches
    print()
    print("Matched wards:")
    for gpkg_name in matched_gpkg_names:
        print(f"  {gpkg_name}")

    # ── Convert to WGS-84 ─────────────────────────────────────────────────────
    matched = matched.to_crs(4326)

    # ── Write per-ward GeoJSON ────────────────────────────────────────────────
    wards_out = cfg.get("wards_geojson", f"{cfg['output_prefix']}_wards.geojson")
    matched.to_file(wards_out, driver="GeoJSON")
    print(f"\nWrote {wards_out}")

    # ── Write dissolved constituency polygon ──────────────────────────────────
    const_out = cfg.get("constituency_geojson", f"{cfg['output_prefix']}_constituency.geojson")
    matched.dissolve().reset_index(drop=True).to_file(const_out, driver="GeoJSON")
    print(f"Wrote {const_out}")

    return matched, district_map


# ══════════════════════════════════════════════════════════════════════════════
#  Step 3 — Fetch roads from Overpass
# ══════════════════════════════════════════════════════════════════════════════

def step3_fetch_roads(cfg):
    print()
    print("=" * 60)
    print("STEP 3 — Fetch roads from Overpass API")
    print("=" * 60)

    out = Path(ROADS_JSON)
    if out.exists():
        print(f"{ROADS_JSON} already exists — skipping fetch.")
        print("(Delete it to force a fresh download.)")
        return

    bbox = cfg["bbox"]
    query = f"""
[out:json][timeout:120];
way[highway][name]({bbox});
out geom;
"""
    headers = {"User-Agent": f"LeaflettingMapper/2.0 ({cfg['display_name']})"}

    print(f"Querying Overpass for bbox: {bbox}")
    print("This may take 30–90 seconds …")

    t0 = time.time()
    try:
        resp = requests.post(
            OVERPASS_URL,
            data={"data": query},
            headers=headers,
            timeout=180,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        sys.exit(f"ERROR fetching roads: {exc}")

    elapsed = time.time() - t0
    elements = data.get("elements", [])
    print(f"Received {len(elements):,} road segments in {elapsed:.0f}s")

    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f)

    print(f"Saved {ROADS_JSON}")


# ══════════════════════════════════════════════════════════════════════════════
#  Step 4 — Clip roads to wards, build spreadsheet
# ══════════════════════════════════════════════════════════════════════════════

def step4_build_spreadsheet(cfg, wards_gdf, district_map):
    print()
    print("=" * 60)
    print("STEP 4 — Clip roads to wards & build spreadsheet")
    print("=" * 60)

    # ── Pre-compute ward polygons (stays in RAM, tiny) ────────────────────────
    # List of (gpkg_name, display_name, district, polygon)
    ward_records = []
    for _, row in wards_gdf.iterrows():
        gpkg_name = row["Name"]
        display   = gpkg_name[:-5] if gpkg_name.endswith(" Ward") else gpkg_name
        district  = district_map.get(gpkg_name, "Unknown")
        ward_records.append((gpkg_name, display, district, row.geometry))

    print(f"Ward polygons loaded: {len(ward_records)}")

    # ── Stream roads from JSON ────────────────────────────────────────────────
    print(f"Loading {ROADS_JSON} …")
    with open(ROADS_JSON, "r", encoding="utf-8") as f:
        osm = json.load(f)

    elements = osm.get("elements", [])
    print(f"  {len(elements):,} OSM ways")

    # Group ways by road name → list of coordinate tuples
    # We store tuples (not Shapely objects) to keep RAM low during grouping
    raw_roads: dict[str, list[list[tuple[float, float]]]] = {}

    for el in elements:
        if el.get("type") != "way":
            continue
        name = el.get("tags", {}).get("name")
        if not name:
            continue
        pts = el.get("geometry", [])
        coords = [(p["lon"], p["lat"]) for p in pts]
        if len(coords) >= 2:
            raw_roads.setdefault(name, []).append(coords)

    # Free the OSM JSON from memory — we have everything we need
    del osm, elements
    import gc
    gc.collect()

    print(f"  Grouped into {len(raw_roads):,} road names")

    # ── Split same-named roads that are geographically disconnected ──────────
    # OSM can have multiple entirely separate roads sharing a name (e.g. two
    # different "Salt Road"s in different parts of the county).  If we merge
    # them, one road's segments can bleed into the wrong constituency.
    # We split by connected component: segments that are more than
    # SAME_NAME_SPLIT_THRESHOLD degrees apart are treated as distinct roads,
    # labelled "Road Name", "Road Name (2)", "Road Name (3)" etc.
    #
    # 0.05 degrees ≈ 3–4 km at UK latitudes — comfortably larger than any
    # gap within a continuous road, but smaller than the distance between
    # genuinely separate roads sharing a name.

    SAME_NAME_SPLIT_THRESHOLD = 0.05   # degrees

    def _split_disconnected(coord_lists):
        """
        Given a list of coordinate lists (segments of one named road),
        return a list of groups where each group's segments are all
        within SAME_NAME_SPLIT_THRESHOLD of each other.
        Uses single-linkage clustering on segment midpoints.
        """
        if len(coord_lists) <= 1:
            return [coord_lists]

        # Midpoint of each segment
        def midpoint(coords):
            lons = [c[0] for c in coords]
            lats = [c[1] for c in coords]
            return sum(lons)/len(lons), sum(lats)/len(lats)

        mids = [midpoint(c) for c in coord_lists]
        n = len(mids)

        # Union-Find
        parent = list(range(n))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        def union(x, y):
            parent[find(x)] = find(y)

        for i in range(n):
            for j in range(i + 1, n):
                dx = mids[i][0] - mids[j][0]
                dy = mids[i][1] - mids[j][1]
                if (dx*dx + dy*dy) ** 0.5 < SAME_NAME_SPLIT_THRESHOLD:
                    union(i, j)

        groups: dict[int, list] = {}
        for i, coords in enumerate(coord_lists):
            groups.setdefault(find(i), []).append(coords)

        return list(groups.values())

    split_roads: dict[str, list[list[tuple[float, float]]]] = {}
    n_splits = 0

    for name, coord_lists in raw_roads.items():
        groups = _split_disconnected(coord_lists)
        if len(groups) == 1:
            split_roads[name] = coord_lists
        else:
            n_splits += 1
            for idx, group in enumerate(groups, 1):
                key = name if idx == 1 else f"{name} ({idx})"
                split_roads[key] = group

    if n_splits:
        print(f"  Split {n_splits} road name(s) into geographic clusters "
              f"({len(split_roads):,} total after split)")

    raw_roads = split_roads
    del split_roads

    # ── Process roads one at a time ───────────────────────────────────────────
    output_rows  = []
    review_rows  = []

    n_dominant   = 0
    n_multiward  = 0
    n_no_ward    = 0

    total = len(raw_roads)

    for i, (road_name, coord_lists) in enumerate(raw_roads.items(), 1):

        if i % 200 == 0:
            print(f"  {i:,}/{total:,} roads processed …")

        # Build merged road geometry, then immediately drop the raw coords
        segments     = [LineString(c) for c in coord_lists]
        merged_road  = unary_union(segments)
        del segments, coord_lists   # free Shapely objects

        total_length = merged_road.length
        if total_length == 0:
            del merged_road
            n_no_ward += 1
            continue

        # Intersect with every ward polygon
        ward_hits = []
        for gpkg_name, display_name, district, polygon in ward_records:
            clipped = merged_road.intersection(polygon)
            if clipped.is_empty:
                continue
            ratio = clipped.length / total_length
            if ratio < MIN_FRAGMENT_RATIO:
                continue   # noise — skip entirely
            ward_hits.append({
                "gpkg_name":    gpkg_name,
                "display_name": display_name,
                "district":     district,
                "geometry":     clipped,
                "ratio":        ratio,
            })

        if not ward_hits:
            del merged_road
            n_no_ward += 1
            continue

        ward_hits.sort(key=lambda x: x["ratio"], reverse=True)

        # ── Boundary-road detection ───────────────────────────────────────────
        # If a road appears to be split across two wards but the secondary
        # fragment runs *along* the boundary (rather than genuinely crossing
        # into the other ward), absorb it into the dominant ward.
        if (len(ward_hits) == 2
                and ward_hits[0]["ratio"] >= DOMINANT_WARD_THRESHOLD
                and ward_hits[1]["ratio"] <= BOUNDARY_ROAD_SECONDARY_MAX):

            dominant_poly = next(
                poly for gn, dn, di, poly in ward_records
                if gn == ward_hits[0]["gpkg_name"]
            )
            secondary_poly = next(
                poly for gn, dn, di, poly in ward_records
                if gn == ward_hits[1]["gpkg_name"]
            )

            if _is_boundary_artefact(ward_hits[1]["geometry"], dominant_poly, secondary_poly):
                # Drop the boundary fragment — treat as dominant-ward only
                ward_hits = [ward_hits[0]]
                ward_hits[0]["ratio"] = 1.0   # whole road to dominant ward

        # ── Dominant-ward assignment ──
        if ward_hits[0]["ratio"] >= DOMINANT_WARD_THRESHOLD:
            n_dominant += 1
            w            = ward_hits[0]
            assigned     = [w["display_name"]]
            lat, lon     = _representative_latlon(merged_road)

            output_rows.append({
                "Street":                   road_name,
                "@lat":                     lat,
                "@lon":                     lon,
                "Ward":                     w["display_name"],
                "Local Authority District": w["district"],
                "Status":                   "Not_Started",
                "Residences":               "-",
                "road_geometry":            _geometry_to_text(merged_road),
                "partial_geometry":         "-",
            })

        # ── Multi-ward assignment ──
        else:
            n_multiward += 1
            assigned = []

            for w in ward_hits:
                assigned.append(w["display_name"])
                lat, lon = _representative_latlon(w["geometry"])

                output_rows.append({
                    "Street":                   road_name,
                    "@lat":                     lat,
                    "@lon":                     lon,
                    "Ward":                     w["display_name"],
                    "Local Authority District": w["district"],
                    "Status":                   "Not_Started",
                    "Residences":               "-",
                    "road_geometry":            _geometry_to_text(w["geometry"]),
                    "partial_geometry":         "-",
                })

        # Free Shapely objects for this road immediately
        for w in ward_hits:
            del w["geometry"]
        del merged_road, ward_hits

    # ── Write spreadsheet ─────────────────────────────────────────────────────
    output_file = f"{cfg['output_prefix']}_Leafletting.xlsx"

    col_order = [
        "Street", "@lat", "@lon", "Ward", "Local Authority District",
        "Status", "Residences", "road_geometry", "partial_geometry",
    ]

    df = pd.DataFrame(output_rows)

    # Ensure column order (add missing ones at end)
    ordered = [c for c in col_order if c in df.columns]
    ordered += [c for c in df.columns if c not in ordered]
    df = df[ordered]

    print(f"\nWriting {len(df):,} rows to {output_file} …")

    with pd.ExcelWriter(output_file, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Data", index=False)

    # ── Report ────────────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("COMPLETE")
    print("=" * 60)
    print(f"Road names processed:    {total:,}")
    print(f"  Dominant-ward roads:   {n_dominant:,}")
    print(f"  Multi-ward roads:      {n_multiward:,}")
    print(f"  Outside all wards:     {n_no_ward:,}")
    print(f"Output rows (Data):      {len(df):,}")
    print()
    print(f"Saved: {output_file}")
    print()
    print("NOTE: 'Residences' column is set to '-' throughout.")
    print("Populate it from the Electoral Roll when available.")


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    cfg              = step1_load_config()
    wards_gdf, dmap  = step2_fetch_boundaries(cfg)
    step3_fetch_roads(cfg)
    step4_build_spreadsheet(cfg, wards_gdf, dmap)
