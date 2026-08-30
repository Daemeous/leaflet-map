# Leafletting Map

An interactive canvassing and leafletting tracker for UK parliamentary constituencies and council areas. Volunteers can view road-level status, plan routes, and mark progress in real time via a Google Sheets backend.

This repo is the **primary deployment** (Stafford) and also hosts the shared frontend (`core.js` / `styles.css`) that every other constituency's site loads directly — see "Shared assets" below before editing either file.

---

## Live deployments

| Constituency / area | Site |
|---|---|
| Stafford *(this repo)* | https://daemeous.github.io/leaflet-map/ |
| Demo | https://daemeous.github.io/leaflet-map-demo/ |
| South Hams | https://daemeous.github.io/south-hams/ |
| Burton & Uttoxeter | https://daemeous.github.io/burton-uttoxeter/ |
| Stone, Great Wyrley & Penkridge | https://daemeous.github.io/stone/ |
| Barnsley, Penistone & Stocksbridge | https://daemeous.github.io/barnsley/ |
| St Helens | https://daemeous.github.io/sthelens/ |

Related project — **[Pothole Watch](https://github.com/Daemeous/stafford-potholes)** (citizen pothole reporting, same visual style, separate Sheet/Apps Script backend):

| Area | Site |
|---|---|
| Stafford | https://daemeous.github.io/stafford-potholes/ |

The tooling that builds each deployment's road data and creates/deploys its Google Sheet + Apps Script backend lives in **[leaflet-pipeline](https://github.com/Daemeous/leaflet-pipeline)**, not in these site repos — see that repo to add a new constituency or refresh an existing one.

---

## How it works

Road data is sourced from OpenStreetMap, clipped to ward boundaries verified against the OS Boundary-Line dataset, and given an estimated residence count per road (via OS Open UPRN point-in-buffer matching — see leaflet-pipeline for how). Each road is assigned to a ward, given a status (`Not_Started`, `Planned`, `In_Progress`, `Complete`), and stored in a Google Sheet. The app reads that sheet as a published CSV and renders roads as coloured polylines on a Leaflet map.

Authorised users can sign in with Google and update road statuses directly from the map, which writes back to the sheet via a Google Apps Script web app.

---

## Repository contents

| File | Purpose |
|------|---------|
| `index.html` | This deployment's config block (Sheet ID, Apps Script URL, title/subtitle, map centre) |
| `core.js` | **Shared app logic** — loaded directly by every other deployment's `index.html` from `https://daemeous.github.io/leaflet-map/core.js`. A change here goes live for all of them on push. |
| `styles.css` | **Shared styles** — same sharing as `core.js`, loaded from `https://daemeous.github.io/leaflet-map/styles.css`. |
| `sw.js` | Service worker (PWA offline shell + map tile cache). Must stay same-origin, so every deployment keeps its own copy — see the comment in `core.js`'s `injectPwaHead()`. |

---

## Shared assets — read before editing `core.js` or `styles.css`

Five of the seven live deployments (everything except this repo and the demo) have **no local copy** of `core.js`/`styles.css` at all — their `index.html` loads them straight from this repo's Pages URL:

```html
<link rel="stylesheet" href="https://daemeous.github.io/leaflet-map/styles.css?shared_v=1">
<script src="https://daemeous.github.io/leaflet-map/core.js?shared_v=1"></script>
```

That means:
- A fix or feature pushed here reaches every thin deployment (and `leaflet-map-demo`, which also uses this pattern — its own local `core.js`/`styles.css` copies had gone stale/404ing and were removed) — but **only once each consumer's `?shared_v=N` is bumped to match**. It also means a bug pushed here breaks every deployment at once — treat pushes to `core.js`/`styles.css` as a production release, not a per-constituency change.
- **The `?shared_v=N` query string is load-bearing, not a nicety.** GitHub Pages' CDN caches these files for up to 10 minutes, and mobile browsers (Android Chrome in particular) have been observed holding onto a stale cross-origin copy well beyond that — the service worker's network-first/no-store fetch handling (see `sw.js`'s header comment) doesn't reliably defeat every caching layer in the chain for a cross-origin request. A changed query string forces every layer (CDN edge cache, browser HTTP cache, the SW's Cache Storage) to treat it as a different resource, which is the only fix confirmed to work reliably. **Whenever `core.js` or `styles.css` changes here, bump `?shared_v=N` in every consuming repo's `index.html`** (`south-hams`, `burton-uttoxeter`, `stone`, `barnsley`, `sthelens`, `leaflet-map-demo`) — this repo's own `?v=N` on its local `<link>`/`<script>` tags is a separate, same-origin version counter and doesn't need to match.

---

## Deploying a new map for a new area

Don't hand-build a new deployment — see **[leaflet-pipeline](https://github.com/Daemeous/leaflet-pipeline)**, which covers ward verification, the road/residence pipeline, and creating + deploying the Google Sheet and Apps Script backend. Once that's done, a new deployment here is just:

1. Copy this repo's `index.html` and `sw.js` into a new repo (or, if it's happy sharing this repo's `core.js`/`styles.css` unmodified, skip copying those two and load them from `https://daemeous.github.io/leaflet-map/...` instead — see "Shared assets" above).
2. Fill in the config block: `SHEET_ID`, `SHEET_GID`, `CHECKSUM_GID`, `GOOGLE_CLIENT_ID`, `APPS_SCRIPT_URL`, `LS_SUFFIX`, `TITLE`/`SUBTITLE`, `INITIAL_VIEW`/`INITIAL_ZOOM`.
3. Push and enable GitHub Pages.

---

## Boundary-road handling

Roads that run *along* a ward boundary are detected automatically (in the pipeline, not here) and assigned wholly to the dominant ward rather than being split into fragments. Roads that genuinely cross into a third ward (e.g. a long A-road) are unaffected. See leaflet-pipeline's `run_pipeline.py` for the implementation.

---

## Credits & libraries

- **Leaflet.js** — [leafletjs.com](https://leafletjs.com) © Vladimir Agafonkin and contributors
- **OpenStreetMap** — map tiles and road data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- **OS Boundary-Line** and **OS Open UPRN** — © Crown copyright and database right, Ordnance Survey (Open Government Licence)
- **Papa Parse** — CSV parsing — [papaparse.com](https://www.papaparse.com)
- **Turf.js** — geospatial analysis — [turfjs.org](https://turfjs.org)
- **Google Identity Services** — authentication
