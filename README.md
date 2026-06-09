# Leafletting Map

An interactive canvassing and leafletting tracker for UK parliamentary constituencies. Volunteers can view road-level status, plan routes, and mark progress in real time via a Google Sheets backend.

Currently deployed for:
- **Stafford Constituency** — `daemeous.github.io/leaflet-map/coton.html` *(and other wards)*
- **Stone, Great Wyrley and Penkridge Constituency**

---

## How it works

Road data is sourced from OpenStreetMap and clipped to ward boundaries derived from the OS Boundary-Line dataset. Each road is assigned to a ward, given a status (`Not_Started`, `Planned`, `In_Progress`, `Complete`), and stored in a Google Sheet. The HTML map reads that sheet as a published CSV and renders roads as coloured polylines on a Leaflet map.

Authorised users can sign in with Google and update road statuses directly from the map, which writes back to the sheet via a Google Apps Script web app.

---

## Repository contents

| File | Purpose |
|------|---------|
| `constituency_config.py` | Single source of truth for all constituency settings — edit this to add or switch constituencies |
| `run_pipeline.py` | End-to-end pipeline: fetches ward boundaries, fetches OSM roads, clips roads to wards, builds the spreadsheet |
| `setup_constituency.py` | Interactive script to auto-discover wards for a new constituency from OSM and append a config entry |
| `index.html` | The Leaflet.js map application (one copy per constituency, config block at the top of the script section) |

---

## Adding a new constituency

### Option A — auto-discovery (recommended)

```bash
python setup_constituency.py
```

The script will:
1. Query Overpass for the constituency boundary and its child ward relations
2. Auto-confirm unambiguous wards; prompt you to resolve any duplicates (sorted by proximity to the confirmed cluster)
3. Query each ward's parent to guess the local authority district
4. Compute the bounding box automatically
5. Append a ready-made entry to `constituency_config.py`

Then set `ACTIVE_CONSTITUENCY` in `constituency_config.py` to your new key and run the pipeline.

### Option B — manual config

Add an entry to the `CONSTITUENCIES` dict in `constituency_config.py`:

```python
"my_constituency": {
    "display_name":  "My Constituency",
    "output_prefix": "MyConst",
    "bbox": "52.00, -2.00, 52.50, -1.50",   # south, west, north, east
    "wards": [
        ("Ward Name", "Local Authority District"),
    ],
},
```

Ward names are matched case-insensitively against Boundary-Line; the ` Ward` suffix is tried automatically if the bare name fails.

---

## Running the pipeline

```bash
python run_pipeline.py
```

Requires `Boundary-Line.gpkg` in the same directory (one-time download from [OS Data Hub](https://osdatahub.os.uk/downloads/open/BoundaryLine)).

**Steps run automatically:**
1. Load and validate constituency config
2. Extract ward polygons from `Boundary-Line.gpkg` → `<prefix>_wards.geojson`, `<prefix>_constituency.geojson`
3. Fetch all named roads from Overpass API → `roads_raw.json` *(skipped if already exists — delete to re-fetch)*
4. Clip roads to ward boundaries, detect and resolve boundary-road artefacts → `<prefix>_Leafletting.xlsx`

**Output spreadsheet columns:**

| Column | Description |
|--------|-------------|
| `Street` | Road name |
| `@lat` / `@lon` | Representative coordinate for the road |
| `Ward` | Assigned ward (display name, no "Ward" suffix) |
| `Local Authority District` | e.g. Stafford, South Staffordshire |
| `Status` | `Not_Started` / `Planned` / `In_Progress` / `Complete` |
| `Residences` | `-` — populate from Electoral Roll when available |
| `road_geometry` | Pipe-delimited WKT LineString(s) for map rendering |
| `partial_geometry` | Volunteer-drawn partial completion overlays |

---

## Deploying a new map (index.html)

Copy `index.html` and update the CONFIG block near the top of the `<script>` section:

```javascript
const SHEET_ID         = "...";   // from the published CSV URL
const SHEET_GID        = "...";   // Data sheet GID
const CHECKSUM_GID     = "...";   // Checksum sheet GID
const GOOGLE_CLIENT_ID = "...";   // from Google Cloud Console
const APPS_SCRIPT_URL  = "...";   // deployed web app /exec URL
```

**Google Apps Script setup:**
1. Open the spreadsheet → Extensions → Apps Script *(use Brave or a clean browser profile if Chrome fails)*
2. Paste the Apps Script code
3. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone
4. Copy the `/exec` URL into `APPS_SCRIPT_URL`

The `Authorised` sheet in the spreadsheet controls who can write status updates — add email addresses there.

---

## Boundary-road handling

Roads that run *along* a ward boundary are detected automatically and assigned wholly to the dominant ward rather than being split into fragments. A secondary fragment is treated as a boundary artefact when it is small (≤ 15% of the road's total length) and lies within approximately 30 m of the shared boundary line. Roads that genuinely cross into a third ward (e.g. a long A-road) are unaffected.

---

## Dependencies

```bash
pip install geopandas pandas shapely openpyxl requests
```

---

## Credits & libraries

- **Leaflet.js** — [leafletjs.com](https://leafletjs.com) © Vladimir Agafonkin and contributors
- **OpenStreetMap** — map tiles and road data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- **OS Boundary-Line** — ward boundary polygons © Crown copyright and database right, Ordnance Survey (Open Government Licence)
- **Papa Parse** — CSV parsing — [papaparse.com](https://www.papaparse.com)
- **Turf.js** — geospatial analysis — [turfjs.org](https://turfjs.org)
- **Google Identity Services** — authentication
- **Overpass API** — OSM road data queries — [overpass-api.de](https://overpass-api.de)
