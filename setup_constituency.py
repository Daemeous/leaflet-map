"""
setup_constituency.py
=====================
Interactive script to discover wards for any UK parliamentary constituency
and append a ready-made entry to constituency_config.py.

HOW IT WORKS
------------
1.  You type a constituency name (or part of one).
2.  The script queries Overpass for all electoral ward boundary relations
    within a broad bounding box centred on England.
3.  It finds the constituency boundary, then fetches its child ward relations.
4.  Unambiguous wards are confirmed automatically.
    Ambiguous candidates (multiple OSM relations with the same name, or wards
    whose geometry sits far from the main cluster) are listed in order of
    distance from the confirmed cluster — you type Y/N for each.
5.  The bounding box is computed automatically from the matched ward geometries
    (plus a 0.05° margin).
6.  You are shown the proposed config entry and asked to confirm before it is
    appended to constituency_config.py.

BOUNDARY ROADS
--------------
Roads that run *along* a ward boundary are a known problem — OSM clips them
to both sides, creating duplicate fragments that look like separate roads.
run_pipeline.py now includes a boundary-road detection pass:
  - If a road has its majority (≥ DOMINANT_WARD_THRESHOLD) in one ward but
    a significant second fragment (≥ BOUNDARY_ROAD_MIN_RATIO), AND the second
    fragment's geometry lies within BOUNDARY_ROAD_TOLERANCE degrees of the
    ward boundary line, the whole road is assigned to the dominant ward.
  - Genuinely cross-ward roads (e.g. a long A-road crossing three wards) are
    still split normally.

REQUIREMENTS
------------
    pip install requests geopandas shapely

USAGE
-----
    python setup_constituency.py

The script is safe to run multiple times — it never overwrites existing
entries in constituency_config.py, only appends new ones.
"""

import json
import math
import re
import sys
import time
from pathlib import Path

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
CONFIG_FILE  = "constituency_config.py"

# Broad bounding box covering all of England + Wales
ENGLAND_BBOX = "49.8, -6.5, 55.9, 2.1"

# Margin added to the auto-computed bounding box (degrees)
BBOX_MARGIN = 0.05

# Overpass request headers
HEADERS = {"User-Agent": "LeaflettingMapper/2.0 (setup_constituency.py)"}


# ══════════════════════════════════════════════════════════════════════════════
#  Overpass helpers
# ══════════════════════════════════════════════════════════════════════════════

def _overpass(query: str, label: str) -> dict:
    """POST a query to Overpass, return parsed JSON. Exits on failure."""
    print(f"  Querying Overpass: {label} …")
    for attempt in range(1, 4):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers=HEADERS,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            if attempt == 3:
                sys.exit(f"\nERROR talking to Overpass: {exc}")
            print(f"  Attempt {attempt} failed ({exc}), retrying …")
            time.sleep(5)


def _fetch_constituency_candidates(name_fragment: str) -> list[dict]:
    """
    Return OSM relations that look like UK parliamentary constituencies
    matching the given name fragment.
    Each result: {id, name, bbox: (s,w,n,e)}
    """
    query = f"""
[out:json][timeout:90];
(
  rel[boundary=administrative]
     [admin_level=10]
     [name~"{name_fragment}",i]
     ({ENGLAND_BBOX});
  rel[boundary=parliamentary_constituency]
     [name~"{name_fragment}",i];
);
out bb tags;
"""
    data = _overpass(query, f"constituencies matching '{name_fragment}'")

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("short_name", "")
        bb   = el.get("bounds")
        if not name or not bb:
            continue
        results.append({
            "id":   el["id"],
            "name": name,
            "bbox": (bb["minlat"], bb["minlon"], bb["maxlat"], bb["maxlon"]),
        })

    return results


def _fetch_child_wards(constituency_relation_id: int) -> list[dict]:
    """
    Return ward relations that are members of the given constituency relation.
    Each result: {id, name, bbox: (s,w,n,e), centroid: (lat, lon)}
    """
    query = f"""
[out:json][timeout:120];
rel({constituency_relation_id});
rel(r)[boundary=administrative][admin_level~"^(10|11)$"];
out bb tags;
"""
    data = _overpass(query, f"child wards of relation {constituency_relation_id}")

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name", "").strip()
        bb   = el.get("bounds")
        if not name or not bb:
            continue
        s, w, n, e = bb["minlat"], bb["minlon"], bb["maxlat"], bb["maxlon"]
        results.append({
            "id":      el["id"],
            "name":    name,
            "bbox":    (s, w, n, e),
            "centroid": ((s + n) / 2, (w + e) / 2),
        })

    return results


def _fetch_wards_by_bbox(bbox_tuple: tuple) -> list[dict]:
    """
    Fallback: fetch all ward-level boundary relations inside a bbox.
    Used when constituency membership query returns nothing.
    """
    s, w, n, e = bbox_tuple
    query = f"""
[out:json][timeout=120];
(
  rel[boundary=administrative][admin_level=10]({s},{w},{n},{e});
  rel[boundary=administrative][admin_level=11]({s},{w},{n},{e});
);
out bb tags;
"""
    data = _overpass(query, "ward relations in bbox")

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name", "").strip()
        bb   = el.get("bounds")
        if not name or not bb:
            continue
        s2, w2, n2, e2 = bb["minlat"], bb["minlon"], bb["maxlat"], bb["maxlon"]
        results.append({
            "id":      el["id"],
            "name":    name,
            "bbox":    (s2, w2, n2, e2),
            "centroid": ((s2 + n2) / 2, (w2 + e2) / 2),
        })

    return results


# ══════════════════════════════════════════════════════════════════════════════
#  Geometry helpers
# ══════════════════════════════════════════════════════════════════════════════

def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Approximate distance in km between two lat/lon points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _cluster_centroid(wards: list[dict]) -> tuple[float, float]:
    """Mean centroid of a list of ward dicts."""
    lats = [w["centroid"][0] for w in wards]
    lons = [w["centroid"][1] for w in wards]
    return sum(lats) / len(lats), sum(lons) / len(lons)


def _merged_bbox(wards: list[dict]) -> tuple[float, float, float, float]:
    """Bounding box enclosing all wards, with BBOX_MARGIN padding."""
    s = min(w["bbox"][0] for w in wards) - BBOX_MARGIN
    w = min(w["bbox"][1] for w in wards) - BBOX_MARGIN
    n = max(w["bbox"][2] for w in wards) + BBOX_MARGIN
    e = max(w["bbox"][3] for w in wards) + BBOX_MARGIN
    return round(s, 3), round(w, 3), round(n, 3), round(e, 3)


# ══════════════════════════════════════════════════════════════════════════════
#  Interactive helpers
# ══════════════════════════════════════════════════════════════════════════════

def _ask(prompt: str, default: str = "") -> str:
    try:
        val = input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit("Cancelled.")
    return val if val else default


def _yn(prompt: str, default: bool = True) -> bool:
    suffix = " [Y/n] " if default else " [y/N] "
    ans    = _ask(prompt + suffix).lower()
    if not ans:
        return default
    return ans.startswith("y")


# ══════════════════════════════════════════════════════════════════════════════
#  Config writer
# ══════════════════════════════════════════════════════════════════════════════

def _make_key(display_name: str) -> str:
    """Turn 'Stone, Great Wyrley and Penkridge' into 'stone_great_wyrley_and_penkridge'."""
    key = display_name.lower()
    key = re.sub(r"[^a-z0-9]+", "_", key)
    key = key.strip("_")
    return key


def _ward_entry_str(name: str, district: str, indent: int = 12) -> str:
    pad = " " * indent
    return f'{pad}("{name}", "{district}"),'


def _append_to_config(
    key: str,
    display_name: str,
    output_prefix: str,
    bbox: tuple,
    wards: list[tuple[str, str]],   # (ward_name, district)
):
    """Append a new constituency entry to constituency_config.py."""
    s, w, n, e = bbox
    bbox_str   = f"{s}, {w}, {n}, {e}"

    ward_lines = "\n".join(_ward_entry_str(wn, wd) for wn, wd in wards)

    block = f'''
    # ── {display_name} ─────────────────────────────────────────────
    "{key}": {{
        "display_name":   "{display_name}",
        "output_prefix":  "{output_prefix}",
        "bbox": "{bbox_str}",
        "wards": [
{ward_lines}
        ],
    }},
'''

    cfg_path = Path(CONFIG_FILE)
    if not cfg_path.exists():
        sys.exit(f"ERROR: {CONFIG_FILE} not found. Run from the same directory.")

    text = cfg_path.read_text(encoding="utf-8")

    if f'"{key}"' in text:
        print(f"\nKey '{key}' already exists in {CONFIG_FILE} — not overwriting.")
        return

    # Insert before the closing brace of CONSTITUENCIES dict
    # Find the last occurrence of "},\n\n}" pattern
    insert_marker = "\n}\n"
    idx = text.rfind(insert_marker)
    if idx == -1:
        # Fallback: append at end
        text += "\n" + block
    else:
        text = text[:idx] + block + text[idx:]

    cfg_path.write_text(text, encoding="utf-8")
    print(f"\nAppended '{key}' to {CONFIG_FILE}")


# ══════════════════════════════════════════════════════════════════════════════
#  District guessing
# ══════════════════════════════════════════════════════════════════════════════

def _guess_district(ward_name: str, ward_id: int) -> str:
    """
    Query the ward's parent admin boundaries to find the district name.
    Falls back to "Unknown — please set manually".
    """
    query = f"""
[out:json][timeout=30];
rel({ward_id});
rel(r)[admin_level~"^[78]$"][boundary=administrative];
out tags;
"""
    try:
        data = _overpass(query, f"parent district of ward {ward_id}")
        for el in data.get("elements", []):
            name = el.get("tags", {}).get("name", "")
            if name:
                # Strip " District", " Borough", " City Council" suffixes for brevity
                name = re.sub(r"\s+(District|Borough|City Council|Council|County)$", "", name, flags=re.I)
                return name
    except Exception:
        pass
    return "Unknown — please set manually"


# ══════════════════════════════════════════════════════════════════════════════
#  Main flow
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print()
    print("=" * 60)
    print("  Constituency Setup")
    print("=" * 60)
    print()
    print("This script discovers wards for a UK parliamentary constituency")
    print("and adds them to constituency_config.py automatically.")
    print()

    # ── Step A: get constituency name ─────────────────────────────────────────
    raw_name = _ask("Enter constituency name (or part of it): ")
    if not raw_name:
        sys.exit("No name entered.")

    print()

    # ── Step B: find constituency relation ───────────────────────────────────
    candidates = _fetch_constituency_candidates(raw_name)

    if not candidates:
        print(f"No OSM constituency relations found matching '{raw_name}'.")
        print("This can happen if OSM tags the boundary differently.")
        use_manual = _yn("Try fetching all wards within a manually entered bbox instead?", default=True)
        if not use_manual:
            sys.exit("Exiting.")
        bbox_str = _ask("Enter bbox as: south,west,north,east  (e.g. 52.69,-2.48,53.01,-1.93): ")
        try:
            parts = [float(x.strip()) for x in bbox_str.split(",")]
            assert len(parts) == 4
        except Exception:
            sys.exit("Invalid bbox format.")
        constituency_name = _ask("Constituency display name: ")
        wards_raw = _fetch_wards_by_bbox(tuple(parts))
        selected_wards = _manual_ward_selection(wards_raw)

    elif len(candidates) == 1:
        c = candidates[0]
        print(f"Found: {c['name']}  (OSM relation {c['id']})")
        if not _yn("Is this the right constituency?"):
            sys.exit("Exiting. Try a more specific name.")
        constituency_name = c["name"]
        wards_raw = _fetch_child_wards(c["id"])
        if not wards_raw:
            print("No child wards found via relation membership — falling back to bbox search.")
            wards_raw = _fetch_wards_by_bbox(c["bbox"])
        selected_wards = _resolve_wards(wards_raw, constituency_name)

    else:
        print(f"Found {len(candidates)} matching constituencies:\n")
        for i, c in enumerate(candidates, 1):
            print(f"  {i}.  {c['name']}  (OSM id {c['id']})")
        print()
        choice = _ask(f"Enter number (1–{len(candidates)}): ")
        try:
            c = candidates[int(choice) - 1]
        except Exception:
            sys.exit("Invalid choice.")
        constituency_name = c["name"]
        wards_raw = _fetch_child_wards(c["id"])
        if not wards_raw:
            print("No child wards found via relation — falling back to bbox.")
            wards_raw = _fetch_wards_by_bbox(c["bbox"])
        selected_wards = _resolve_wards(wards_raw, constituency_name)

    if not selected_wards:
        sys.exit("No wards selected. Exiting.")

    # ── Step C: guess districts ───────────────────────────────────────────────
    print()
    print(f"Identifying local authority districts for {len(selected_wards)} wards …")
    print("(This makes several small Overpass queries — may take ~30 seconds)")
    print()

    ward_entries = []
    for ward in selected_wards:
        district = _guess_district(ward["name"], ward["id"])
        print(f"  {ward['name']:50s}  →  {district}")
        ward_entries.append((ward["name"], district))

    # ── Step D: compute bbox ──────────────────────────────────────────────────
    bbox = _merged_bbox(selected_wards)
    s, w, n, e = bbox
    print()
    print(f"Auto-computed bounding box: {s}, {w}, {n}, {e}")

    # ── Step E: ask for output prefix ─────────────────────────────────────────
    print()
    suggested_prefix = re.sub(r"[^A-Za-z0-9]", "", constituency_name.split(",")[0].title())
    output_prefix    = _ask(f"Output file prefix (default: {suggested_prefix}): ", suggested_prefix)
    key              = _make_key(constituency_name)

    # ── Step F: show proposed entry & confirm ─────────────────────────────────
    print()
    print("─" * 60)
    print("Proposed config entry:")
    print("─" * 60)
    print(f'  key:           "{key}"')
    print(f'  display_name:  "{constituency_name}"')
    print(f'  output_prefix: "{output_prefix}"')
    print(f'  bbox:           {s}, {w}, {n}, {e}')
    print(f'  wards ({len(ward_entries)}):')
    for wn, wd in ward_entries:
        print(f'    {wn:50s}  [{wd}]')
    print("─" * 60)
    print()

    if not _yn("Append this entry to constituency_config.py?"):
        sys.exit("Aborted — nothing written.")

    _append_to_config(key, constituency_name, output_prefix, bbox, ward_entries)

    print()
    print("Done!  Next steps:")
    print(f"  1.  Edit constituency_config.py and set:")
    print(f'          ACTIVE_CONSTITUENCY = "{key}"')
    print(f"  2.  If any districts show 'Unknown', fix them in the config.")
    print(f"  3.  Run:  python run_pipeline.py")
    print()


# ══════════════════════════════════════════════════════════════════════════════
#  Ward resolution
# ══════════════════════════════════════════════════════════════════════════════

def _resolve_wards(wards_raw: list[dict], constituency_name: str) -> list[dict]:
    """
    Given a raw list of ward relations, confirm/filter down to the final set.

    Strategy:
    1.  If there's only one relation per name → auto-confirm all.
    2.  Duplicate names → sort candidates by distance from the confirmed-ward
        cluster centroid and ask the user to pick.
    3.  User is shown a summary and asked for final confirmation.
    """
    if not wards_raw:
        print("No wards found.")
        return []

    # Group by normalised name
    by_name: dict[str, list[dict]] = {}
    for w in wards_raw:
        by_name.setdefault(w["name"].strip(), []).append(w)

    confirmed   = []
    ambiguous   = []

    for name, group in by_name.items():
        if len(group) == 1:
            confirmed.append(group[0])
        else:
            ambiguous.append((name, group))

    print()
    if confirmed:
        print(f"Auto-confirmed {len(confirmed)} unambiguous wards.")
    if ambiguous:
        print(f"{len(ambiguous)} ward name(s) have multiple OSM matches — you'll be asked to choose.")

    # ── Resolve ambiguous wards ───────────────────────────────────────────────
    for name, group in ambiguous:
        # Compute cluster centroid from confirmed wards (if any)
        if confirmed:
            clat, clon = _cluster_centroid(confirmed)
        else:
            # No confirmed wards yet — use mean of all candidates
            clat = sum(g["centroid"][0] for g in group) / len(group)
            clon = sum(g["centroid"][1] for g in group) / len(group)

        # Sort candidates by distance from cluster
        group_sorted = sorted(
            group,
            key=lambda g: _haversine_km(clat, clon, g["centroid"][0], g["centroid"][1])
        )

        print()
        print(f'Ambiguous ward: "{name}" — {len(group_sorted)} candidates')
        for i, g in enumerate(group_sorted, 1):
            dist = _haversine_km(clat, clon, g["centroid"][0], g["centroid"][1])
            s, w, n, e = g["bbox"]
            print(f"  {i}.  OSM id {g['id']}  |  bbox ({s:.3f},{w:.3f},{n:.3f},{e:.3f})  "
                  f"|  {dist:.1f} km from cluster  {'← nearest' if i == 1 else ''}")

        choice = _ask(f"  Which is correct for {constituency_name}? Enter number (or 0 to skip): ", "1")
        try:
            idx = int(choice)
            if idx == 0:
                print(f"  Skipping '{name}'.")
                continue
            confirmed.append(group_sorted[idx - 1])
        except (ValueError, IndexError):
            print("  Invalid choice — skipping.")

    # ── Final confirmation ────────────────────────────────────────────────────
    print()
    print(f"Selected {len(confirmed)} wards:")
    for w in sorted(confirmed, key=lambda x: x["name"]):
        print(f"  {w['name']}")

    print()
    if not _yn(f"Proceed with these {len(confirmed)} wards?"):
        print("Let's re-do the selection.")
        return _manual_ward_selection(wards_raw)

    return confirmed


def _manual_ward_selection(wards_raw: list[dict]) -> list[dict]:
    """
    Show all wards and let the user type which numbers to include.
    """
    if not wards_raw:
        print("No wards available.")
        return []

    sorted_wards = sorted(wards_raw, key=lambda w: w["name"])
    print()
    print(f"Available wards ({len(sorted_wards)}):")
    for i, w in enumerate(sorted_wards, 1):
        print(f"  {i:3d}.  {w['name']}")

    print()
    raw = _ask("Enter ward numbers to include (e.g. 1,3,5-8,12): ")
    selected = []
    for token in raw.split(","):
        token = token.strip()
        if "-" in token:
            try:
                a, b = token.split("-")
                selected.extend(sorted_wards[i - 1] for i in range(int(a), int(b) + 1))
            except Exception:
                pass
        else:
            try:
                selected.append(sorted_wards[int(token) - 1])
            except Exception:
                pass

    return selected


if __name__ == "__main__":
    main()
