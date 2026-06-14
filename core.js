/* ============================================================================
   core.js — Shared Leafleting Map application code
   Hosted at: https://daemeous.github.io/leaflet-map/core.js
   Used by all per-constituency deployments. Each deployment's index.html
   defines a `window.MAP_CONFIG` object before loading this file, then loads
   this file (plus its CSS, fonts, and library scripts).

   index.html is responsible for providing window.MAP_CONFIG with the shape:
   {
     SHEET_ID, SHEET_GID, CHECKSUM_GID,
     GOOGLE_CLIENT_ID, APPS_SCRIPT_URL,
     LS_SUFFIX,                 // unique per deployment, e.g. constituency slug
     INITIAL_VIEW: [lat, lon],  // map.setView center
     INITIAL_ZOOM: number,
     TITLE, SUBTITLE            // sidebar header text
   }

   Optional overrides:
     STATUSES   — override the status definitions array
     POLL_INTERVAL_MS
   ============================================================================ */

(function () {
  const CFG = window.MAP_CONFIG || {};
  if (!CFG.SHEET_ID) {
    console.error("MAP_CONFIG missing — define window.MAP_CONFIG before loading core.js");
    return;
  }

  // ── CONFIG (resolved from MAP_CONFIG with defaults) ─────────────────────────
  const SHEET_ID  = CFG.SHEET_ID;
  const SHEET_GID = CFG.SHEET_GID;
  const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?gid=${SHEET_GID}&single=true&output=csv`;
  const CHECKSUM_GID  = CFG.CHECKSUM_GID;
  const CHECKSUM_URL  = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?gid=${CHECKSUM_GID}&single=true&output=csv`;
  const POLL_INTERVAL_MS = CFG.POLL_INTERVAL_MS || 15 * 60 * 1000;
  const GOOGLE_CLIENT_ID = CFG.GOOGLE_CLIENT_ID;
  const APPS_SCRIPT_URL  = CFG.APPS_SCRIPT_URL;
  const PARTIAL_ZOOM_THRESHOLD = 14; // partial overlays hidden below this zoom level
  const LS_SUFFIX   = CFG.LS_SUFFIX || SHEET_GID;   // unique per deployment
  const LS_DATA     = `leafmap_data_v3_${LS_SUFFIX}`;
  const LS_CHECKSUM = `leafmap_checksum_v3_${LS_SUFFIX}`;
  const LS_TIME     = `leafmap_time_${LS_SUFFIX}`;
  const LS_AUTH     = `leafmap_auth_v1_${LS_SUFFIX}`;
  const LS_COOKIE   = `leafmap_cookie_consent_${LS_SUFFIX}`;
  const INITIAL_VIEW = CFG.INITIAL_VIEW || [52.8, -2.12];
  const INITIAL_ZOOM = CFG.INITIAL_ZOOM || 12;

  // ── Status definitions ────────────────────────────────────────────────────────
  const STATUSES = CFG.STATUSES || [
    { key:"complete",   sheetValue:"Complete",    label:"Complete",    cls:"opt-complete",   popupCls:"ps-complete",   colour:"#3ecf6e", weight:5 },
    { key:"inprogress", sheetValue:"In_Progress", label:"In Progress", cls:"opt-inprogress", popupCls:"ps-inprogress", colour:"#f5c842", weight:5 },
    { key:"planned",    sheetValue:"Planned",     label:"Planned",     cls:"opt-planned",    popupCls:"ps-planned",    colour:"#4f8ef7", weight:4 },
    { key:"notstarted", sheetValue:"Not_Started", label:"Not Started", cls:"opt-notstarted", popupCls:"ps-notstarted", colour:"#f75f5f", weight:4 },
  ];
  function getStatus(v) {
    const norm = (v||"").trim().toLowerCase().replace(/[\s_]+/g,"");
    return STATUSES.find(s=>s.sheetValue.toLowerCase().replace(/_/g,"")===norm)||STATUSES[3];
  }
  function statusKey(v)  { return getStatus(v).key; }
  function colourFor(v)  { return getStatus(v).colour; }
  function weightFor(v)  { return getStatus(v).weight; }

  // ── DOM injection ────────────────────────────────────────────────────────────
  function buildStatusToggles() {
    return STATUSES.map((s,i)=>`<button class="status-toggle active s-${s.key}" data-status="${s.key}" onclick="toggleStatus(this)"><span class="status-dot dot-${["green","yellow","blue","red"][i % 4]}"></span>${escHtml(s.label)}<span class="toggle-count" id="cnt-${s.key}">0</span></button>`).join("");
  }
  function buildStatsTop() {
    const colours = ["green","yellow","blue","red","purple"];
    return STATUSES.map((s,i)=>`<div class="stat"><div class="stat-num ${colours[i % colours.length]}" id="stat-${s.key}">0</div><div class="stat-label">${escHtml(s.label)}</div></div>`).join("");
  }

  function injectAppShell() {
    document.title = CFG.TITLE || "Leafleting Map";

    const app = document.createElement("div");
    app.id = "app";
    app.innerHTML = `
  <aside id="sidebar">
    <div class="sidebar-head">
      <h1>${escHtml(CFG.TITLE || "Leafleting Map")}</h1>
      <p>${escHtml(CFG.SUBTITLE || "Filter roads by ward or completion status.")}</p>
      <div id="sync-bar" title="Click to check for updates now" onclick="manualRefresh()">
        <div id="sync-left"><div id="sync-dot"></div><span id="sync-text">Loading…</span></div>
        <span id="sync-icon">↻</span>
      </div>
    </div>
    <div id="stats">
      <div id="stats-top">${buildStatsTop()}</div>
      <div id="stats-bottom" style="display:none">
        <span class="res-label">🏠 Est. Residences served</span>
        <span><span class="res-value" id="stat-residences">…</span><span class="res-sub" id="stat-residences-pct"></span></span>
      </div>
    </div>
    <div class="sidebar-scroll">
      <div class="filter-section">
        <div class="filter-label">Status</div>
        <div class="status-toggles">${buildStatusToggles()}</div>
      </div>
      <div class="filter-section">
        <div class="filter-label">Road Search</div>
        <div class="road-search-wrap">
          <input class="road-search-input" id="road-search-input" type="text" placeholder="Search roads…" autocomplete="off"
            oninput="onRoadSearchInput(this.value)" onkeydown="onRoadSearchKey(event)" onfocus="onRoadSearchInput(this.value)">
          <button class="road-search-clear" id="road-search-clear" onclick="clearRoadSearch()" title="Clear">✕</button>
          <div class="road-dropdown" id="road-dropdown"></div>
        </div>
      </div>
      <div class="filter-section">
        <div class="filter-label">Ward</div>
        <input class="ward-search" type="text" placeholder="Search wards…" oninput="filterWardList(this.value)">
        <button class="ward-all-btn" onclick="selectAllWards()">Select / deselect all</button>
        <div class="ward-list" id="ward-list"></div>
      </div>
    </div>
  </aside>
  <div id="map-wrap">
    <button id="sidebar-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')">☰</button>
    <div id="map"></div>
    <div id="draw-hint"></div>
    <div id="loading"><div class="spinner"></div><p id="loading-msg">Loading road data…</p></div>
    <div id="error-banner"></div>
  </div>`;
    document.body.insertBefore(app, document.body.firstChild);

    const cookieBanner = document.createElement("div");
    cookieBanner.id = "cookie-banner";
    cookieBanner.className = "hidden";
    cookieBanner.innerHTML = `
  <p>This site can store a cookie to remember your Google sign-in between visits. <a onclick="showCookiePolicy()">What we store &amp; why →</a></p>
  <button class="cookie-btn cookie-btn-decline" onclick="cookieDecline()">Decline</button>
  <button class="cookie-btn cookie-btn-accept"  onclick="cookieAccept()">Accept &amp; remember me</button>`;
    document.body.appendChild(cookieBanner);
  }

  injectAppShell();

  // ── Map ───────────────────────────────────────────────────────────────────────
  const map = L.map("map",{zoomControl:true}).setView(INITIAL_VIEW, INITIAL_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    attribution:'© <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom:19
  }).addTo(map);

  // ── State ─────────────────────────────────────────────────────────────────────
  let allRoads     = [];
  let layerGroups  = {};
  let partialLayerGroup = L.layerGroup().addTo(map); // separate group, always on top
  let activeStatus = new Set(STATUSES.map(s=>s.key));
  let activeWards  = new Set();
  let wardCounts   = {};
  let lastChecksum          = null;
  let lastLoadTime          = null;
  let residencesServedTotal = null;
  let pollTimer        = null;
  let isChecking       = false;
  let selectedRoadName = null;
  let authToken      = null;
  let authTokenType  = "idToken";
  let authEmail      = null;
  let authExpiry     = 0;
  let authAuthorised = false;
  let renderedLayers = new Map();  // segKey → {layers, spec, ward}
  let partialLayers  = new Map();  // rowIdx → [L.layer, ...]

  // ── Selection fade-out timer ──────────────────────────────────────────────────
  let selectionFadeTimer = null;
  const SELECTION_FADE_DELAY_MS = 4000; // time before opacity fades back to normal

  // ── Drawing state ─────────────────────────────────────────────────────────────
  // drawState machine: null | 'place-start' | 'place-end' | 'adjust'
  let drawState      = null;
  let drawRoad       = null;   // the road row being edited
  let drawSegPts     = [];     // flat array of all [lat,lon] points for this road (all segments)
  let drawSegBreaks  = [];     // indices where new segments begin (for per-seg attribution)
  let drawStartProp  = null;   // proportion along total length (0-1)
  let drawEndProp    = null;
  let drawBothSides  = false;  // toggle: false=single side, true=both
  let drawPreviewLayers = [];  // temp map layers for live preview
  let drawHandleStart = null;  // L.circleMarker
  let drawHandleEnd   = null;
  let drawActiveHandle = null; // 'start'|'end' — which handle is currently being moved
  let drawFlipped    = false;  // whether the offset side has been flipped
  let drawRoadHighlightLayers = []; // highlight of the selected road during drawing

  // ── Cookie consent ────────────────────────────────────────────────────────────
  function cookieConsent() { return localStorage.getItem(LS_COOKIE); }
  function showCookieBanner() { if(!cookieConsent()) document.getElementById("cookie-banner").classList.remove("hidden"); }
  function cookieAccept() { localStorage.setItem(LS_COOKIE,"accepted"); document.getElementById("cookie-banner").classList.add("hidden"); persistAuthSession(); }
  function cookieDecline() { localStorage.setItem(LS_COOKIE,"declined"); document.getElementById("cookie-banner").classList.add("hidden"); localStorage.removeItem(LS_AUTH); }
  function showCookiePolicy() { alert("Cookie / local storage policy\n\nWe store a small token remembering your Google sign-in for up to 55 minutes, and a local cache of road data for instant loads. No personal data is shared with third parties."); }

  // ── Auth persistence ──────────────────────────────────────────────────────────
  function persistAuthSession() {
    if(cookieConsent()!=="accepted"||!authToken||!authEmail||!authAuthorised) return;
    try { localStorage.setItem(LS_AUTH,JSON.stringify({token:authToken,tokenType:authTokenType,email:authEmail,expiry:authExpiry,authorised:authAuthorised})); } catch(e){}
  }
  function restoreAuthSession() {
    if(cookieConsent()!=="accepted") return;
    try {
      const raw=localStorage.getItem(LS_AUTH); if(!raw) return;
      const s=JSON.parse(raw);
      if(!s.token||Date.now()>=s.expiry-30_000){localStorage.removeItem(LS_AUTH);return;}
      authToken=s.token; authTokenType=s.tokenType||"idToken"; authEmail=s.email; authExpiry=s.expiry; authAuthorised=s.authorised;
    } catch(e){localStorage.removeItem(LS_AUTH);}
  }

  // ── Sync UI ───────────────────────────────────────────────────────────────────
  function setSyncState(state,text) {
    const dot=document.getElementById("sync-dot"),txt=document.getElementById("sync-text"),icon=document.getElementById("sync-icon");
    dot.className=""; icon.classList.remove("spinning"); dot.classList.add(state); txt.textContent=text;
    if(state==="checking") icon.classList.add("spinning");
  }
  function formatTime(d) { return d?d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"never"; }

  // ── WKT / geometry helpers ────────────────────────────────────────────────────
  function parseWKT(wkt) {
    if(!wkt||wkt==="-"||wkt==="NOT_FOUND"||!wkt.includes("LINESTRING")) return [];
    return wkt.split("|").map(seg=>{
      seg=seg.trim();
      if(!seg.startsWith("LINESTRING(")) return null;
      return seg.slice(11,-1).split(",").map(pair=>{
        const [lon,lat]=pair.trim().split(" ").map(Number);
        return isNaN(lat)?null:[lat,lon];
      }).filter(Boolean);
    }).filter(a=>a&&a.length>=2);
  }

  // Convert [lat,lon] array to turf GeoJSON point
  function turfPt(latlng) { return turf.point([latlng[1],latlng[0]]); }

  // Compute cumulative length array for a list of [lat,lon] pts (in metres)
  function cumulativeLengths(pts) {
    const lens=[0];
    for(let i=1;i<pts.length;i++) {
      const d=turf.distance(turfPt(pts[i-1]),turfPt(pts[i]),{units:"meters"});
      lens.push(lens[i-1]+d);
    }
    return lens;
  }

  // Interpolate a point at proportion t (0-1) along pts
  function interpolateAlongPts(pts,cumLens,t) {
    const total=cumLens[cumLens.length-1];
    if(total===0) return pts[0];
    const target=t*total;
    for(let i=1;i<cumLens.length;i++) {
      if(cumLens[i]>=target||i===cumLens.length-1) {
        const segStart=cumLens[i-1], segEnd=cumLens[i];
        const frac=segEnd===segStart?0:(target-segStart)/(segEnd-segStart);
        const a=pts[i-1], b=pts[i];
        return [a[0]+(b[0]-a[0])*frac, a[1]+(b[1]-a[1])*frac];
      }
    }
    return pts[pts.length-1];
  }

  // Snap a latlng click to the nearest point on the road's combined geometry
  // Returns { prop: 0-1, latlng: [lat,lon] }
  function snapToRoad(clickLatLng, pts, cumLens) {
    const total=cumLens[cumLens.length-1];
    if(total===0) return {prop:0,latlng:pts[0]};
    let bestDist=Infinity, bestProp=0, bestPt=pts[0];
    const click = turf.point([clickLatLng.lng, clickLatLng.lat]);
    for(let i=1;i<pts.length;i++) {
      const a=[pts[i-1][1],pts[i-1][0]]; // [lon,lat] for turf
      const b=[pts[i][1],pts[i][0]];
      const line=turf.lineString([a,b]);
      const snapped=turf.nearestPointOnLine(line,click,{units:"meters"});
      const distToLine=snapped.properties.dist; // metres from click to line
      if(distToLine<bestDist) {
        bestDist=distToLine;
        const c=snapped.geometry.coordinates; // [lon,lat]
        const distAlongSeg=turf.distance(
          turf.point(a), turf.point(c), {units:"meters"}
        );
        const segLen=cumLens[i]-cumLens[i-1];
        const clampedDist=Math.min(segLen, Math.max(0, distAlongSeg));
        bestProp=(cumLens[i-1]+clampedDist)/total;
        bestPt=[c[1],c[0]];
      }
    }
    return {prop:Math.min(1,Math.max(0,bestProp)),latlng:bestPt};
  }

  // Extract pts/cumLens for a road's combined geometry (all segments concatenated)
  function getRoadGeomData(road) {
    const rawSegs=parseWKT(road.road_geometry);
    if(!rawSegs.length) return null;
    const segs = sortSegmentsTopologically(rawSegs);
    const pts=segs.flat();
    const cumLens=cumulativeLengths(pts);
    const total=cumLens[cumLens.length-1];
    const breaks=[];
    let idx=0;
    segs.forEach(seg=>{
      const startProp=total>0?cumLens[idx]/total:0;
      idx+=seg.length;
      const endIdx=Math.min(idx-1, cumLens.length-1);
      const endProp=total>0?cumLens[endIdx]/total:1;
      breaks.push({startProp,endProp,segIdx:breaks.length});
    });
    return {pts,cumLens,total,breaks,segs};
  }

  // Produce an offset polyline (metres offset, left of travel direction)
  function offsetPolyline(pts, offsetMetres) {
    if(pts.length<2) return pts;
    try {
      const coords=pts.map(p=>[p[1],p[0]]);
      const line=turf.lineString(coords);
      const off=turf.lineOffset(line,offsetMetres,{units:"meters"});
      return off.geometry.coordinates.map(c=>[c[1],c[0]]);
    } catch(e) { return pts; }
  }

  // Compute partial estimate percentage for a road (0-1)
  function computePartialEstimate(road) {
    const sk=statusKey(road.Status);
    if(sk==="complete") return 1.0;
    if(sk==="notstarted"||sk==="planned") return 0.0;
    // In Progress
    const pgStr=(road.partial_geometry||"").trim();
    if(!pgStr||pgStr==="-") return 0.3; // default 30%
    const geomData=getRoadGeomData(road);
    if(!geomData) return 0.3;
    const total=geomData.total;
    if(total===0) return 0.3;
    let covered=0;
    pgStr.split("|").forEach(part=>{
      const m=part.match(/^seg(\d+):([\d.]+)-([\d.]+):(B|S|F)$/);
      if(!m) return;
      const segIdx=parseInt(m[1]);
      const t0=parseFloat(m[2]),t1=parseFloat(m[3]);
      const side=m[4];
      const brk=geomData.breaks[segIdx];
      if(!brk) return;
      const segTotalLen=(brk.endProp-brk.startProp)*total;
      const coveredLen=Math.abs(t1-t0)*segTotalLen;
      covered+=coveredLen*(side==="B"?1.0:0.5);
    });
    return Math.min(1, covered/total);
  }

  // ── Partial geometry string parser ────────────────────────────────────────────
  function parsePartialGeom(str) {
    if(!str||str==="-") return [];
    return str.split("|").map(part=>{
      const m=part.match(/^seg(\d+):([\d.]+)-([\d.]+):(B|S|F)$/);
      if(!m) return null;
      return {segIdx:parseInt(m[1]),t0:parseFloat(m[2]),t1:parseFloat(m[3]),side:m[4]};
    }).filter(Boolean);
  }

  function encodePartialGeom(parts) {
    if(!parts||!parts.length) return "-";
    return parts.map(p=>`seg${p.segIdx}:${p.t0.toFixed(4)}-${p.t1.toFixed(4)}:${p.side}`).join("|");
  }

  function globalPropToSegProps(globalT0, globalT1, geomData) {
    const results=[];
    geomData.breaks.forEach(brk=>{
      const {startProp,endProp,segIdx}=brk;
      const segLen=endProp-startProp;
      if(segLen<=0) return;
      const overlapStart=Math.max(globalT0,startProp);
      const overlapEnd  =Math.min(globalT1,endProp);
      if(overlapEnd<=overlapStart) return;
      const t0=(overlapStart-startProp)/segLen;
      const t1=(overlapEnd  -startProp)/segLen;
      results.push({segIdx,t0:Math.max(0,t0),t1:Math.min(1,t1)});
    });
    return results;
  }

  // ── Partial overlay rendering ─────────────────────────────────────────────────
  const PARTIAL_COLOUR = "#1e7e4a";
  const PARTIAL_WEIGHT_BOTH   = 8;
  const PARTIAL_WEIGHT_SINGLE = 6;
  const PARTIAL_OFFSET_M      = 5; // metres offset for single-side

  function renderAllPartials() {
    partialLayerGroup.clearLayers();
    partialLayers.clear();
    const zoom=map.getZoom();
    allRoads.forEach(road=>{
      if(statusKey(road.Status)!=="inprogress") return;
      const pgStr=(road.partial_geometry||"").trim();
      if(!pgStr||pgStr==="-") return;
      if(zoom<PARTIAL_ZOOM_THRESHOLD && road.Street.toLowerCase()!==( selectedRoadName||"").toLowerCase()) return;
      renderPartialForRoad(road);
    });
  }

  function renderPartialForRoad(road) {
    const existing=partialLayers.get(road._rowIdx);
    if(existing) existing.forEach(l=>partialLayerGroup.removeLayer(l));
    const layers=[];

    const pgStr=(road.partial_geometry||"").trim();
    if(!pgStr||pgStr==="-"||statusKey(road.Status)!=="inprogress") {
      partialLayers.set(road._rowIdx,layers);
      return;
    }

    const geomData=getRoadGeomData(road);
    if(!geomData) return;
    const {pts,cumLens,total,breaks,segs}=geomData;
    const parts=parsePartialGeom(pgStr);

    parts.forEach(({segIdx,t0,t1,side})=>{
      const brk=breaks[segIdx];
      if(!brk) return;
      const segPts=segs[segIdx];
      const segCumLens=cumulativeLengths(segPts);
      const segTotal=segCumLens[segCumLens.length-1];

      let ptsSubset=[];
      const p0=interpolateAlongPts(segPts,segCumLens,t0);
      const p1=interpolateAlongPts(segPts,segCumLens,t1);
      ptsSubset.push(p0);
      segPts.forEach((p,i)=>{
        const prop=segTotal>0?segCumLens[i]/segTotal:0;
        if(prop>t0&&prop<t1) ptsSubset.push(p);
      });
      ptsSubset.push(p1);
      if(ptsSubset.length<2) return;

      if(side==="B") {
        const l=L.polyline(ptsSubset,{color:PARTIAL_COLOUR,weight:PARTIAL_WEIGHT_BOTH,opacity:0.9,interactive:false});
        l.addTo(partialLayerGroup); layers.push(l);
      } else {
        const offsetPts=offsetPolyline(ptsSubset, side==="F" ? -PARTIAL_OFFSET_M : PARTIAL_OFFSET_M);
        const l=L.polyline(offsetPts,{color:PARTIAL_COLOUR,weight:PARTIAL_WEIGHT_SINGLE,opacity:0.9,interactive:false});
        l.addTo(partialLayerGroup); layers.push(l);
      }
    });

    partialLayers.set(road._rowIdx,layers);
  }

  // Re-render partials on zoom change
  map.on("zoomend",()=>renderAllPartials());

  // ── Misc helpers ──────────────────────────────────────────────────────────────
  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function getResidences(row) {
    const raw=row["Residences"]??row["residences"]??row["RESIDENCES"]??"";
    return parseFloat(raw)||0;
  }
  function fmtResidences(row) { const n=getResidences(row); return n?String(Math.round(n)):null; }

  // ── Popup HTML ────────────────────────────────────────────────────────────────
  function popupHtml(row) {
    const st=getStatus(row.Status);
    const resStr=fmtResidences(row);
    const resBadge=resStr?`<span class="popup-residences">🏠 ${escHtml(resStr)} residences</span>`:"";
    return `
      <div class="popup-street">${escHtml(row.Street)}</div>
      <div class="popup-ward">${escHtml(row.Ward)}</div>
      <div class="popup-meta">
        <button class="popup-status-btn" data-row-idx="${row._rowIdx}" title="Click to change status">
          <span class="popup-status ${st.popupCls}">${escHtml(st.label)}</span>
        </button>
        ${resBadge}
      </div>
      <div class="popup-edit-area" id="edit-${row._rowIdx}" style="display:none"></div>
    `;
  }

  // Attach edit button listener after popup opens — avoids inline onclick
  // with embedded JSON which breaks on street names containing apostrophes.
  map.on("popupopen", function(e) {
    const btn = e.popup.getElement().querySelector(".popup-status-btn[data-row-idx]");
    if (!btn) return;
    const rowIdx = parseInt(btn.dataset.rowIdx, 10);
    btn.addEventListener("click", function() { popupEditClicked(this, rowIdx); });
  });

  // ── Main render ───────────────────────────────────────────────────────────────
  function segmentKey(rowIdx,segIdx) { return `${rowIdx}_${segIdx}`; }

  function desiredLayerSpec(road) {
    const sk=statusKey(road.Status);
    const ward=(road.Ward||"").trim();
    if(!activeStatus.has(sk)||!activeWards.has(ward)) return null;
    const hasSel=!!selectedRoadName;
    const isSel=hasSel&&(road.Street||"").trim().toLowerCase()===selectedRoadName.toLowerCase();
    const opac=hasSel&&!isSel?0.15:0.85;
    return {colour:colourFor(road.Status),weight:weightFor(road.Status),opac,isSel,sk,ward};
  }

  function specChanged(a,b) {
    if(!a||!b) return a!==b;
    return a.colour!==b.colour||a.weight!==b.weight||a.opac!==b.opac||a.isSel!==b.isSel;
  }

  function renderLines() {
    const desired=new Map();
    allRoads.forEach(road=>{
      const spec=desiredLayerSpec(road);
      const ward=(road.Ward||"").trim();
      const segs=parseWKT(road.road_geometry);
      if(segs.length>0) {
        segs.forEach((pts,segIdx)=>{
          desired.set(segmentKey(road._rowIdx,segIdx),{road,spec,pts,isMarker:false,ward});
        });
      } else {
        const lat=parseFloat(road["@lat"]),lon=parseFloat(road["@lon"]);
        if(!isNaN(lat)&&!isNaN(lon))
          desired.set(segmentKey(road._rowIdx,0),{road,spec,latlng:[lat,lon],isMarker:true,ward});
      }
    });

    renderedLayers.forEach((entry,k)=>{
      const d=desired.get(k);
      if(!d||!d.spec||specChanged(entry.spec,d.spec)) {
        entry.layers.forEach(l=>{if(layerGroups[entry.ward])layerGroups[entry.ward].removeLayer(l);});
        renderedLayers.delete(k);
      }
    });

    desired.forEach((d,k)=>{
      if(!d.spec||renderedLayers.has(k)) return;
      const {road,spec,ward}=d;
      if(!layerGroups[ward]) return;
      const layers=[];
      if(!d.isMarker) {
        const {pts}=d;
        if(spec.isSel) {
          const glow=L.polyline(pts,{color:"#fff",weight:spec.weight+6,opacity:0.25,interactive:false});
          glow.addTo(layerGroups[ward]); layers.push(glow);
          const line=L.polyline(pts,{color:spec.colour,weight:spec.weight+2,opacity:1});
          line.bindPopup(popupHtml(road)); line.addTo(layerGroups[ward]); layers.push(line);
        } else {
          const hit=L.polyline(pts,{color:"transparent",weight:20,opacity:0,interactive:true});
          hit.bindPopup(popupHtml(road)); hit.addTo(layerGroups[ward]); layers.push(hit);
          const line=L.polyline(pts,{color:spec.colour,weight:spec.weight,opacity:spec.opac,interactive:false});
          line.addTo(layerGroups[ward]); layers.push(line);
        }
      } else {
        const marker=L.circleMarker(d.latlng,{radius:spec.isSel?7:5,color:spec.colour,fillColor:spec.colour,fillOpacity:spec.opac===0.15?0.2:0.8,weight:1.5,opacity:spec.opac});
        marker.bindPopup(popupHtml(road)); marker.addTo(layerGroups[ward]); layers.push(marker);
      }
      renderedLayers.set(k,{layers,spec:{...spec},ward});
    });

    renderAllPartials();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  function computeEstimatedResidencesServed() {
    let served=0;
    allRoads.forEach(r=>{
      const res=getResidences(r);
      if(!res) return;
      served+=res*computePartialEstimate(r);
    });
    return served;
  }

  function updateResidencesStat() {
    const resEl=document.getElementById("stat-residences");
    const resPctEl=document.getElementById("stat-residences-pct");
    const statsBottom=document.getElementById("stats-bottom");
    if(!resEl) return;
    let total=0;
    allRoads.forEach(r=>{total+=getResidences(r);});
    if(total<=0) { if(statsBottom) statsBottom.style.display="none"; return; }
    if(statsBottom) statsBottom.style.display="";
    const served=residencesServedTotal??computeEstimatedResidencesServed();
    resEl.textContent=Math.round(served).toLocaleString();
    if(resPctEl) {
      const pct=(served/total*100).toFixed(1);
      resPctEl.textContent=` / ${Math.round(total).toLocaleString()} (${pct}%)`;
    }
  }

  function updateStats() {
    const vis=allRoads.filter(r=>activeStatus.has(statusKey(r.Status))&&activeWards.has((r.Ward||"").trim()));
    STATUSES.forEach(s=>{
      const el=document.getElementById("stat-"+s.key);
      if(el) el.textContent=vis.filter(r=>statusKey(r.Status)===s.key).length;
    });
    updateResidencesStat();
  }

  function updateCountBadges() {
    STATUSES.forEach(s=>{
      const el=document.getElementById("cnt-"+s.key);
      if(el) el.textContent=allRoads.filter(r=>statusKey(r.Status)===s.key).length;
    });
  }

  // ── Toggles ───────────────────────────────────────────────────────────────────
  function toggleStatus(btn) {
    const s=btn.dataset.status;
    if(activeStatus.has(s)){activeStatus.delete(s);btn.classList.replace("active","inactive");}
    else{activeStatus.add(s);btn.classList.replace("inactive","active");}
    renderLines(); updateStats();
  }

  // ── Wards ─────────────────────────────────────────────────────────────────────
  function soloWard(ward,e) {
    e.stopPropagation();
    const all=Object.keys(wardCounts);
    if(activeWards.size===1&&activeWards.has(ward)) all.forEach(w=>activeWards.add(w));
    else { activeWards.clear(); activeWards.add(ward); }
    buildWardList(document.querySelector(".ward-search").value);
    renderLines(); updateStats();
  }
  function buildWardList(filter="") {
    const container=document.getElementById("ward-list");
    container.innerHTML="";
    Object.keys(wardCounts).sort().filter(w=>w.toLowerCase().includes(filter.toLowerCase())).forEach(ward=>{
      const chip=document.createElement("div");
      chip.className="ward-chip"+(activeWards.has(ward)?" selected":"");
      const solo=document.createElement("button"); solo.className="ward-solo-btn"; solo.textContent="◉"; solo.title="Show only this ward";
      solo.addEventListener("click",ev=>soloWard(ward,ev));
      const nm=document.createElement("span"); nm.className="ward-chip-name"; nm.textContent=ward;
      const ct=document.createElement("span"); ct.className="ward-chip-count"; ct.textContent=wardCounts[ward];
      chip.appendChild(solo); chip.appendChild(nm); chip.appendChild(ct);
      chip.addEventListener("click",()=>{
        if(activeWards.has(ward)) activeWards.delete(ward); else activeWards.add(ward);
        chip.classList.toggle("selected"); renderLines(); updateStats();
      });
      container.appendChild(chip);
    });
  }
  function filterWardList(val){buildWardList(val);}
  function selectAllWards() {
    const wards=Object.keys(wardCounts);
    const allSel=wards.every(w=>activeWards.has(w));
    if(allSel) wards.forEach(w=>activeWards.delete(w)); else wards.forEach(w=>activeWards.add(w));
    buildWardList(document.querySelector(".ward-search").value);
    renderLines(); updateStats();
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  function showError(msg) {
    const b=document.getElementById("error-banner");
    b.textContent=msg; b.style.display="block";
    setTimeout(()=>{b.style.display="none";},8000);
  }

  // ── CSV ───────────────────────────────────────────────────────────────────────
  async function fetchCSVText(url) {
    const sep=url.includes("?")?"&":"?";
    const res=await fetch(url+sep+"cachebust="+Date.now(),{credentials:"omit",cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    return res.text();
  }
  function parseCSVRows(text) {
    return new Promise(resolve=>{Papa.parse(text,{header:true,skipEmptyLines:true,complete:r=>resolve(r.data)});});
  }

  // ── Cache ─────────────────────────────────────────────────────────────────────
  function saveToCache(rows,checksum) {
    try{localStorage.setItem(LS_DATA,JSON.stringify(rows));localStorage.setItem(LS_CHECKSUM,checksum||"");localStorage.setItem(LS_TIME,new Date().toISOString());}catch(e){}
  }
  function loadFromCache() {
    try{
      const raw=localStorage.getItem(LS_DATA); if(!raw) return null;
      return{rows:JSON.parse(raw),checksum:localStorage.getItem(LS_CHECKSUM)||"",time:new Date(localStorage.getItem(LS_TIME)||0)};
    }catch(e){return null;}
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────────
  function ingestRows(rows,checksum,timestamp,isFirstLoad) {
    const prevWards=new Set(activeWards);
    const newByIdx=new Map();
    rows.filter(r=>r.Street&&r.Street.trim()).forEach((r,i)=>{
      r._rowIdx=i+2;
      newByIdx.set(r._rowIdx,r);
    });

    if(isFirstLoad) {
      renderedLayers.forEach(entry=>{entry.layers.forEach(l=>{Object.values(layerGroups).forEach(g=>g.removeLayer(l));});});
      renderedLayers.clear(); partialLayerGroup.clearLayers(); partialLayers.clear();
      Object.values(layerGroups).forEach(g=>{g.clearLayers();map.removeLayer(g);});
      layerGroups={}; wardCounts={}; activeWards=new Set();
      allRoads=[...newByIdx.values()];
      allRoads.forEach(r=>{const w=(r.Ward||"Unknown").trim();wardCounts[w]=(wardCounts[w]||0)+1;});
      Object.keys(wardCounts).forEach(w=>{
        layerGroups[w]=L.layerGroup().addTo(map);
        if(!prevWards.size||prevWards.has(w)) activeWards.add(w);
      });
    } else {
      let changed=false;
      allRoads.forEach(existing=>{
        const updated=newByIdx.get(existing._rowIdx);
        if(!updated) return;
        let rowChanged=false;
        if(updated.Status!==existing.Status){existing.Status=updated.Status;rowChanged=true;}
        if((updated.partial_geometry||"-")!==(existing.partial_geometry||"-")){existing.partial_geometry=updated.partial_geometry;rowChanged=true;}
        if(rowChanged) {
          [...renderedLayers.keys()].filter(k=>k.startsWith(existing._rowIdx+"_")).forEach(k=>{
            const entry=renderedLayers.get(k);
            if(entry){entry.layers.forEach(l=>{if(layerGroups[entry.ward])layerGroups[entry.ward].removeLayer(l);});renderedLayers.delete(k);}
          });
          changed=true;
        }
      });
      if(!changed){lastChecksum=checksum;lastLoadTime=timestamp;setSyncState("fresh","Up to date · "+formatTime(lastLoadTime));return;}
    }

    buildWardList(); updateCountBadges(); renderLines(); updateStats(); buildRoadSearchIndex();
    if(isFirstLoad) {
      const pts=allRoads.filter(r=>parseFloat(r["@lat"])&&parseFloat(r["@lon"])).map(r=>[parseFloat(r["@lat"]),parseFloat(r["@lon"])]);
      if(pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.05));
    }
    lastChecksum=checksum; lastLoadTime=timestamp;
    setSyncState("fresh","Updated "+formatTime(lastLoadTime));
  }

  // ── Checksum / poll ───────────────────────────────────────────────────────────
  async function fetchChecksum() {
    const text=await fetchCSVText(CHECKSUM_URL);
    const raw=text.trim().replace(/^"|"$/g,"").trim();
    const parts=raw.split("|");
    if(parts.length===5) {
      const res=parseFloat(parts[4]);
      if(!isNaN(res)){residencesServedTotal=res;updateResidencesStat();}
    }
    return raw;
  }

  async function loadFullSheet(checksum) {
    const isFirst=!lastChecksum;
    if(isFirst){document.getElementById("loading-msg").textContent="Loading road data…";document.getElementById("loading").classList.remove("hidden");}
    else{document.getElementById("loading-msg").textContent="Reloading road data…";document.getElementById("loading").classList.remove("hidden");}
    try {
      const text=await fetchCSVText(SHEET_CSV_URL);
      const rows=await parseCSVRows(text);
      if(!rows.length) throw new Error("No data rows found.");
      ingestRows(rows,checksum,new Date(),isFirst);
      saveToCache(rows,checksum);
    } finally { document.getElementById("loading").classList.add("hidden"); }
  }

  async function checkForUpdates(isManual=false) {
    if(isChecking) return;
    isChecking=true;
    setSyncState("checking",isManual?"Checking…":"Checking for updates…");
    try {
      const cs=await fetchChecksum();
      if(!cs||cs!==lastChecksum) await loadFullSheet(cs||null);
      else{lastLoadTime=lastLoadTime||new Date();setSyncState("fresh","Up to date · "+formatTime(lastLoadTime));}
    } catch(err) {
      setSyncState("error","Check failed · "+formatTime(lastLoadTime));
      if(isManual) showError("Refresh failed: "+err.message);
    } finally{isChecking=false;schedulePoll();}
  }
  function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(()=>checkForUpdates(false),POLL_INTERVAL_MS);}
  function manualRefresh(){clearTimeout(pollTimer);checkForUpdates(true);}

  // ── Recompute checksum locally after edits ────────────────────────────────────
  function recomputeAndSaveChecksum() {
    const counts={Not_Started:0,Planned:0,In_Progress:0,Complete:0};
    let servedRes=0;
    allRoads.forEach(r=>{
      const s=(r.Status||"").trim(); if(counts[s]!==undefined) counts[s]++;
      servedRes+=getResidences(r)*computePartialEstimate(r);
    });
    const cs=`${counts.Not_Started}|${counts.Planned}|${counts.In_Progress}|${counts.Complete}|${Math.round(servedRes)}`;
    residencesServedTotal=servedRes; updateResidencesStat();
    lastChecksum=cs; saveToCache(allRoads,cs);
  }

  // ── Road Search ───────────────────────────────────────────────────────────────
  let roadSearchIndex=[];
  let dropdownFocusIdx=-1;
  function buildRoadSearchIndex() {
    const m={};
    allRoads.forEach(row=>{
      const name=(row.Street||"").trim(); if(!name) return;
      const key=name.toLowerCase();
      if(!m[key]) m[key]={name,wards:new Set(),allLatLngs:[],rows:[]};
      m[key].wards.add((row.Ward||"Unknown").trim());
      m[key].rows.push(row);
      const lat=parseFloat(row["@lat"]),lon=parseFloat(row["@lon"]);
      if(!isNaN(lat)&&!isNaN(lon)) m[key].allLatLngs.push([lat,lon]);
      parseWKT(row.road_geometry).forEach(seg=>seg.forEach(pt=>m[key].allLatLngs.push(pt)));
    });
    roadSearchIndex=Object.values(m).sort((a,b)=>a.name.localeCompare(b.name));
  }
  function roadInActiveWards(road){return road.rows.some(r=>activeWards.has((r.Ward||"Unknown").trim()));}
  function onRoadSearchInput(val) {
    const clearBtn=document.getElementById("road-search-clear"),dropdown=document.getElementById("road-dropdown");
    clearBtn.style.display=val?"block":"none"; dropdownFocusIdx=-1;
    if(!val.trim()){dropdown.classList.remove("open");return;}
    const q=val.trim().toLowerCase();
    const all=roadSearchIndex.filter(r=>r.name.toLowerCase().includes(q));
    const matches=[...all.filter(r=>roadInActiveWards(r)),...all.filter(r=>!roadInActiveWards(r))].slice(0,40);
    if(!matches.length){dropdown.innerHTML=`<div class="road-no-results">No roads found</div>`;dropdown._matches=[];}
    else {
      dropdown.innerHTML=matches.map((r,i)=>{
        const inActive=roadInActiveWards(r);
        const wardHtml=[...r.wards].sort().map(w=>`<span class="${activeWards.has(w)?"road-option-ward-in":"road-option-ward-out"}">${escHtml(w)}</span>`).join('<span style="color:var(--border)"> · </span>');
        return `<div class="road-option${inActive?"":" out-of-ward"}" onmousedown="selectRoad(${i},event)"><div class="road-option-name">${escHtml(r.name)}</div><div class="road-option-meta">${wardHtml}</div></div>`;
      }).join(""); dropdown._matches=matches;
    }
    dropdown.classList.add("open");
  }
  function onRoadSearchKey(e) {
    const dropdown=document.getElementById("road-dropdown"),opts=dropdown.querySelectorAll(".road-option");
    if(!dropdown.classList.contains("open")||!opts.length) return;
    if(e.key==="ArrowDown"){e.preventDefault();dropdownFocusIdx=Math.min(dropdownFocusIdx+1,opts.length-1);updateDropdownFocus(opts);}
    else if(e.key==="ArrowUp"){e.preventDefault();dropdownFocusIdx=Math.max(dropdownFocusIdx-1,0);updateDropdownFocus(opts);}
    else if(e.key==="Enter"){e.preventDefault();if(dropdownFocusIdx>=0&&dropdown._matches?.[dropdownFocusIdx]){selectedRoadName=null;activateRoad(dropdown._matches[dropdownFocusIdx]);closeDropdown();}}
    else if(e.key==="Escape"){clearSelection();closeDropdown();}
  }
  function updateDropdownFocus(opts){opts.forEach((el,i)=>el.classList.toggle("focused",i===dropdownFocusIdx));if(opts[dropdownFocusIdx])opts[dropdownFocusIdx].scrollIntoView({block:"nearest"});}
  function selectRoad(idx,e){e.preventDefault();const dd=document.getElementById("road-dropdown");if(!dd._matches)return;document.getElementById("road-search-input").value=dd._matches[idx].name;selectedRoadName=null;activateRoad(dd._matches[idx]);closeDropdown();}

  // ── Road activation with animated fly-to and timed fade-out ──────────────────
  function activateRoad(road) {
    // Cancel any pending fade-out timer
    if(selectionFadeTimer) { clearTimeout(selectionFadeTimer); selectionFadeTimer=null; }

    selectedRoadName=road.name;

    const fitPts=[],fallPts=[];
    road.rows.forEach(row=>{
      const ward=(row.Ward||"Unknown").trim(); if(!activeWards.has(ward)) return;
      const pts=[];
      parseWKT(row.road_geometry).forEach(seg=>seg.forEach(pt=>pts.push(pt)));
      const lat=parseFloat(row["@lat"]),lon=parseFloat(row["@lon"]);
      if(!isNaN(lat)&&!isNaN(lon)) pts.push([lat,lon]);
      if(activeStatus.has(statusKey(row.Status))) pts.forEach(p=>fitPts.push(p));
      pts.forEach(p=>fallPts.push(p));
    });

    const pts=fitPts.length?fitPts:(fallPts.length?fallPts:road.allLatLngs);
    if(pts.length) {
      const bounds=L.latLngBounds(pts).pad(0.1);
      // Animated fly — duration scales with distance so it never feels sluggish or too fast
      map.flyToBounds(bounds, { maxZoom:17, duration:0.8, easeLinearity:0.5 });
    }

    renderLines();

    // Schedule fade back to normal opacity after a few seconds
    selectionFadeTimer=setTimeout(()=>{
      selectedRoadName=null;
      selectionFadeTimer=null;
      renderLines();
    }, SELECTION_FADE_DELAY_MS);
  }

  function clearSelection(){
    if(selectionFadeTimer){clearTimeout(selectionFadeTimer);selectionFadeTimer=null;}
    if(!selectedRoadName)return;
    selectedRoadName=null;
    renderLines();
  }
  function closeDropdown(){document.getElementById("road-dropdown").classList.remove("open");dropdownFocusIdx=-1;}
  function clearRoadSearch(){document.getElementById("road-search-input").value="";document.getElementById("road-search-clear").style.display="none";clearSelection();closeDropdown();}
  map.on("click",e=>{
    if(drawState) { handleDrawClick(e); return; }
    // A map click also cancels the fade timer and clears selection immediately
    clearSelection();
  });
  document.addEventListener("click",e=>{if(!e.target.closest(".road-search-wrap"))closeDropdown();});

  // ── Auth ──────────────────────────────────────────────────────────────────────
  let pendingEdit=null;
  function tokenIsValid(){return authToken&&Date.now()<authExpiry-30_000;}
  function popupEditClicked(btn,rowIdx) {
    const rowRef={rowIdx};
    const editDiv=document.getElementById("edit-"+rowIdx);
    if(!editDiv) return;
    if(editDiv.style.display!=="none"){editDiv.style.display="none";return;}
    editDiv.style.display="block";
    if(tokenIsValid()&&authAuthorised) showStatusPicker(editDiv,rowRef);
    else if(tokenIsValid()) showEditMsg(editDiv,"Your account is not on the authorised list.","error");
    else{pendingEdit={editDiv,rowRef};showSignInPrompt(editDiv);}
  }
  function showSignInPrompt(editDiv) {
    editDiv.innerHTML=`
      <div class="popup-auth-msg">Sign in with Google to edit.</div>
      <button class="popup-signin-btn" onclick="triggerSignIn()">
        <svg width="16" height="16" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/></svg>
        Sign in with Google
      </button>`;
  }
  function triggerSignIn() {
    if(typeof google==="undefined"||!google.accounts){showEditMsg(pendingEdit?.editDiv,"Google Sign-In not loaded.","error");return;}
    google.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID,callback:onGoogleSignIn,auto_select:true,cancel_on_tap_outside:false});
    google.accounts.id.prompt(n=>{if(n.isNotDisplayed()||n.isSkippedMoment())useOAuthPopupFallback();});
  }
  function useOAuthPopupFallback() {
    google.accounts.oauth2.initTokenClient({
      client_id:GOOGLE_CLIENT_ID,scope:"openid email profile",
      callback:async tr=>{
        if(tr.error){if(pendingEdit)showEditMsg(pendingEdit.editDiv,"Sign-in failed: "+tr.error,"error");return;}
        try{
          const info=await(await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:"Bearer "+tr.access_token}})).json();
          await processSignIn(null,info.email,tr.access_token);
        }catch(e){if(pendingEdit)showEditMsg(pendingEdit.editDiv,"Sign-in error: "+e.message,"error");}
      }
    }).requestAccessToken({prompt:"select_account"});
  }
  async function onGoogleSignIn(response){await processSignIn(response.credential,null,null);}
  async function processSignIn(idToken,emailHint,accessToken) {
    const editDiv=pendingEdit?.editDiv;
    if(editDiv) showEditMsg(editDiv,"Checking authorisation…","");
    try{
      const payload=idToken?{action:"verify",idToken}:{action:"verify",accessToken,email:emailHint};
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify(payload)})).json();
      if(!data.ok){if(editDiv)showEditMsg(editDiv,data.error||"Verification failed.","error");return;}
      authToken=idToken||accessToken; authTokenType=idToken?"idToken":"accessToken";
      authEmail=data.email||emailHint; authExpiry=Date.now()+55*60*1000; authAuthorised=data.authorised===true;
      if(authAuthorised){
        if(cookieConsent()==="accepted") persistAuthSession();
        else if(!cookieConsent()) showCookieBanner();
      }
      if(!authAuthorised){if(editDiv)showEditMsg(editDiv,`${authEmail} is not authorised.`,"error");return;}
      if(pendingEdit){showStatusPicker(pendingEdit.editDiv,pendingEdit.rowRef);pendingEdit=null;}
    }catch(e){if(editDiv)showEditMsg(editDiv,"Network error: "+e.message,"error");}
  }

  function showStatusPicker(editDiv,rowRef) {
    const row=allRoads.find(r=>r._rowIdx===rowRef.rowIdx);
    const current=statusKey(row?.Status||"");
    const hasPartial=row&&(row.partial_geometry||"-")!=="-";
    const isInProgress=current==="inprogress";
    const hasGeom=row&&parseWKT(row.road_geometry).length>0;
    editDiv.innerHTML=`
      <div class="popup-user-line">
        <span>✓ ${escHtml(authEmail)}</span>
        <button class="popup-signout-link" onclick="signOut()">↩ sign out</button>
      </div>
      <div class="popup-status-select">
        ${STATUSES.map(s=>`
          <button class="popup-status-option ${s.cls}${s.key===current?" current":""}"
            data-row="${rowRef.rowIdx}" data-sheet-value="${s.sheetValue}">
            ${s.label}${s.key===current?" ✓":""}
          </button>`).join("")}
      </div>
      ${isInProgress&&hasGeom?`
      <button class="popup-partial-btn${hasPartial?" has-data":""}" onclick="openPartialEditor(${rowRef.rowIdx})">
        ✏ ${hasPartial?"Edit":"Add"} partial completion
      </button>`:""}
    `;
    editDiv.querySelectorAll(".popup-status-option:not(.current)").forEach(btn=>{
      btn.addEventListener("click",function(){submitStatusChange(parseInt(this.dataset.row,10),this.dataset.sheetValue,this);});
    });
  }

  function showEditMsg(editDiv,msg,type){if(!editDiv)return;editDiv.innerHTML=`<div class="popup-auth-msg ${type}">${escHtml(msg)}</div>`;}

  async function submitStatusChange(rowIdx,sheetValue,btn) {
    const editDiv=btn.closest(".popup-edit-area");
    editDiv.innerHTML=`<div class="popup-saving">Saving…</div>`;
    try{
      const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"update",rowIndex:rowIdx,newStatus:sheetValue,...tp})})).json();
      if(!data.ok){showEditMsg(editDiv,data.error||"Save failed.","error");return;}
      const row=allRoads.find(r=>r._rowIdx===rowIdx);
      if(row){
        row.Status=sheetValue;
        [...renderedLayers.keys()].filter(k=>k.startsWith(rowIdx+"_")).forEach(k=>{
          const entry=renderedLayers.get(k);
          if(entry){entry.layers.forEach(l=>{if(layerGroups[entry.ward])layerGroups[entry.ward].removeLayer(l);});renderedLayers.delete(k);}
        });
        renderLines(); updateStats(); updateCountBadges();
        recomputeAndSaveChecksum();
      }
      showEditMsg(editDiv,`Saved as "${getStatus(sheetValue).label}"`,"success");
      setTimeout(()=>{if(editDiv)editDiv.style.display="none";},1800);
    }catch(e){showEditMsg(editDiv,"Network error: "+e.message,"error");}
  }

  function signOut() {
    authToken=null;authTokenType="idToken";authEmail=null;authExpiry=0;authAuthorised=false;
    localStorage.removeItem(LS_AUTH);
    if(typeof google!=="undefined"&&google.accounts) google.accounts.id.disableAutoSelect();
    document.querySelectorAll(".popup-edit-area").forEach(el=>el.style.display="none");
  }

  // ── Partial geometry editor ───────────────────────────────────────────────────
  function openPartialEditor(rowIdx) {
    const row=allRoads.find(r=>r._rowIdx===rowIdx);
    if(!row) return;
    const geomData=getRoadGeomData(row);
    if(!geomData) return;
    map.closePopup();
    enterDrawMode(row,geomData);
  }

  function setDrawHint(msg) {
    const el=document.getElementById("draw-hint");
    if(msg){el.textContent=msg;el.classList.add("visible");}
    else{el.classList.remove("visible");}
  }

  function setLayersInteractive(interactive) {
    renderedLayers.forEach(entry=>{
      entry.layers.forEach(l=>{
        if(l.options&&l.options.weight===20) { // hit layers only (transparent, weight 20)
          if(interactive) l.addInteractiveTarget(l._path||l._renderer&&l._renderer._container);
          l.options.interactive=interactive;
          if(l._path) l._path.style.pointerEvents=interactive?"visiblePainted":"none";
        }
      });
    });
  }

  function enterDrawMode(road,geomData) {
    drawState="place-start";
    drawRoad=road;
    drawSegPts=geomData.pts;
    drawSegBreaks=geomData.breaks;
    drawStartProp=null;
    drawEndProp=null;
    drawBothSides=false;
    drawFlipped=false;
    drawActiveHandle=null;

    setLayersInteractive(false);

    drawRoadHighlightLayers.forEach(l=>partialLayerGroup.removeLayer(l));
    drawRoadHighlightLayers=[];
    geomData.segs.forEach(seg=>{
      const hl=L.polyline(seg,{color:"#fff",weight:10,opacity:0.2,interactive:false});
      hl.addTo(partialLayerGroup); drawRoadHighlightLayers.push(hl);
    });

    document.getElementById("map").classList.add("draw-mode");
    setDrawHint("Tap road to place start point");

    // Show immediate controls: cancel always, clear only if existing data
    showDrawEntryControls(geomData);
  }

  // ── Draw-mode entry controls (shown before any points are placed) ─────────────
  function showDrawEntryControls(geomData) {
    map.eachLayer(l=>{if(l._isDrawControls)map.removeLayer(l);});

    const hasExisting=(drawRoad.partial_geometry||"-")!=="-";
    const existingParts=parsePartialGeom(drawRoad.partial_geometry||"");
    const existingCount=existingParts.length;

    // Position the controls panel near the centre of the road
    const midProp=0.5;
    const midPt=interpolateAlongPts(geomData.pts,geomData.cumLens,midProp);

    const content=document.createElement("div");
    content.innerHTML=`
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:8px;">Partial completion</div>
      ${hasExisting?`<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">${existingCount} existing section${existingCount!==1?"s":""} — tap road to add another</div>`:`<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">Tap the road to place start &amp; end points</div>`}
      <div class="popup-partial-actions">
        <button class="popup-partial-action-btn" id="draw-entry-cancel">✕ Cancel</button>
        ${hasExisting?`<button class="popup-partial-action-btn danger" id="draw-entry-clear">🗑 Clear all</button>`:""}
      </div>
      <div class="popup-partial-status" id="draw-entry-status"></div>
    `;

    const popup=L.popup({closeButton:false,closeOnClick:false,autoClose:false,className:""})
      .setLatLng(midPt).setContent(content).openOn(map);
    popup._isDrawControls=true;

    content.querySelector("#draw-entry-cancel").addEventListener("click",()=>{
      exitDrawMode(geomData);
      map.closePopup();
    });

    const clearBtn=content.querySelector("#draw-entry-clear");
    if(clearBtn) {
      clearBtn.addEventListener("click",()=>{
        clearPartialGeom(geomData, content.querySelector("#draw-entry-status"));
      });
    }
  }

  function exitDrawMode(geomData) {
    drawState=null; drawRoad=null;
    drawPreviewLayers.forEach(l=>partialLayerGroup.removeLayer(l)); drawPreviewLayers=[];
    drawRoadHighlightLayers.forEach(l=>partialLayerGroup.removeLayer(l)); drawRoadHighlightLayers=[];
    if(drawHandleStart){partialLayerGroup.removeLayer(drawHandleStart);drawHandleStart=null;}
    if(drawHandleEnd  ){partialLayerGroup.removeLayer(drawHandleEnd);  drawHandleEnd=null;}
    drawActiveHandle=null;
    setLayersInteractive(true);
    document.getElementById("map").classList.remove("draw-mode");
    setDrawHint(null);
    renderAllPartials();
  }

  function handleDrawClick(e) {
    if(!drawRoad) return;
    const geomData=getRoadGeomData(drawRoad);
    if(!geomData) return;

    const snapped=snapToRoad(e.latlng,geomData.pts,geomData.cumLens);

    if(drawState==="place-start") {
      drawStartProp=snapped.prop;
      drawEndProp=null;
      drawState="place-end";
      // Close the entry controls popup when the user starts placing points
      map.eachLayer(l=>{if(l._isDrawControls)map.removeLayer(l);});
      placeHandles(geomData);
      setDrawHint("Tap road to place end point");

    } else if(drawState==="place-end") {
      drawEndProp=snapped.prop;
      if(Math.abs(drawEndProp-drawStartProp)<0.001) return;
      if(drawStartProp>drawEndProp){[drawStartProp,drawEndProp]=[drawEndProp,drawStartProp];}
      drawState="adjust";
      drawActiveHandle=null;
      placeHandles(geomData);
      updateDrawPreview(geomData);
      showDrawControls(geomData);
      setDrawHint("Tap a handle to select it, then tap road to move · Save when done");

    } else if(drawState==="adjust") {
      if(drawActiveHandle) {
        if(drawActiveHandle==="start") {
          drawStartProp=snapped.prop;
          if(drawStartProp>=drawEndProp) drawStartProp=Math.max(0,drawEndProp-0.001);
        } else {
          drawEndProp=snapped.prop;
          if(drawEndProp<=drawStartProp) drawEndProp=Math.min(1,drawStartProp+0.001);
        }
        drawActiveHandle=null;
        placeHandles(geomData);
        updateDrawPreview(geomData);
        setDrawHint("Tap a handle to select it, then tap road to move · Save when done");
      }
    }
  }

  function placeHandles(geomData) {
    if(drawHandleStart){partialLayerGroup.removeLayer(drawHandleStart);drawHandleStart=null;}
    if(drawHandleEnd  ){partialLayerGroup.removeLayer(drawHandleEnd);  drawHandleEnd=null;}
    if(drawStartProp!==null) {
      const pt=interpolateAlongPts(geomData.pts,geomData.cumLens,drawStartProp);
      drawHandleStart=L.circleMarker(pt,{radius:8,color:"#fff",fillColor:PARTIAL_COLOUR,fillOpacity:1,weight:2,interactive:true,draggable:false,zIndexOffset:1000});
      drawHandleStart.addTo(partialLayerGroup);
      drawHandleStart.on("click",e=>{L.DomEvent.stopPropagation(e);drawActiveHandle="start";setDrawHint("Tap road to move start point");});
    }
    if(drawEndProp!==null) {
      const pt=interpolateAlongPts(geomData.pts,geomData.cumLens,drawEndProp);
      drawHandleEnd=L.circleMarker(pt,{radius:8,color:"#fff",fillColor:"#0a4a28",fillOpacity:1,weight:2,interactive:true,draggable:false,zIndexOffset:1000});
      drawHandleEnd.addTo(partialLayerGroup);
      drawHandleEnd.on("click",e=>{L.DomEvent.stopPropagation(e);drawActiveHandle="end";setDrawHint("Tap road to move end point");});
    }
  }

  function sortSegmentsTopologically(segs) {
    if (segs.length <= 1) return segs;
    const SNAP_THRESH = 0.0003; // degrees — ~30m tolerance for endpoint matching

    function dist(a, b) {
      return Math.hypot(a[0]-b[0], a[1]-b[1]);
    }
    function maybeFlip(seg, prevEnd) {
      if (dist(prevEnd, seg[0]) <= dist(prevEnd, seg[seg.length-1])) return seg;
      return [...seg].reverse();
    }

    const remaining = segs.map(s => [...s]);
    const sorted = [remaining.splice(0, 1)[0]];

    while (remaining.length) {
      const prevEnd = sorted[sorted.length-1][sorted[sorted.length-1].length-1];
      let bestIdx = 0, bestDist = Infinity;
      remaining.forEach((seg, i) => {
        const d = Math.min(dist(prevEnd, seg[0]), dist(prevEnd, seg[seg.length-1]));
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      const next = remaining.splice(bestIdx, 1)[0];
      sorted.push(maybeFlip(next, prevEnd));
    }
    return sorted;
  }

  function updateDrawPreview(geomData) {
    drawPreviewLayers.forEach(l => partialLayerGroup.removeLayer(l));
    drawPreviewLayers = [];
    if (drawStartProp === null || drawEndProp === null) return;
    const t0 = Math.min(drawStartProp, drawEndProp);
    const t1 = Math.max(drawStartProp, drawEndProp);

    geomData.breaks.forEach(brk => {
      const { startProp, endProp, segIdx } = brk;
      const segLen = endProp - startProp;
      if (segLen <= 0) return;
      const overlapStart = Math.max(t0, startProp);
      const overlapEnd   = Math.min(t1, endProp);
      if (overlapEnd <= overlapStart) return;

      const segPts = geomData.segs[segIdx];
      const segCL  = cumulativeLengths(segPts);
      const segTotal = segCL[segCL.length - 1];

      const st = (overlapStart - startProp) / segLen;
      const et = (overlapEnd   - startProp) / segLen;

      const p0 = interpolateAlongPts(segPts, segCL, st);
      const p1 = interpolateAlongPts(segPts, segCL, et);
      let subset = [p0];
      segPts.forEach((p, i) => {
        const prop = segTotal > 0 ? segCL[i] / segTotal : 0;
        if (prop > st && prop < et) subset.push(p);
      });
      subset.push(p1);
      if (subset.length < 2) return;

      let layer;
      if (drawBothSides) {
        layer = L.polyline(subset, { color: PARTIAL_COLOUR, weight: PARTIAL_WEIGHT_BOTH, opacity: 0.85, interactive: false, dashArray: "8 4" });
      } else {
        const offsetPts = offsetPolyline(subset, drawFlipped ? -PARTIAL_OFFSET_M : PARTIAL_OFFSET_M);
        layer = L.polyline(offsetPts, { color: PARTIAL_COLOUR, weight: PARTIAL_WEIGHT_SINGLE, opacity: 0.85, interactive: false, dashArray: "8 4" });
      }
      layer.addTo(partialLayerGroup);
      drawPreviewLayers.push(layer);
    });
  }

  function showDrawControls(geomData) {
    map.eachLayer(l=>{if(l._isDrawControls)map.removeLayer(l);});
    if(drawStartProp===null||drawEndProp===null) return;
    const midProp=(drawStartProp+drawEndProp)/2;
    const midPt=interpolateAlongPts(geomData.pts,geomData.cumLens,midProp);
    const hasExisting=(drawRoad.partial_geometry||"-")!=="-";

    const content=document.createElement("div");
    content.innerHTML=`
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:8px;">Partial completion</div>
      <div class="popup-partial-actions" id="draw-controls-inner">
        <button class="popup-partial-action-btn${drawBothSides?" active":""}" id="draw-btn-both">Both sides</button>
        <button class="popup-partial-action-btn${!drawBothSides?" active":""}" id="draw-btn-single">One side</button>
        <button class="popup-partial-action-btn" id="draw-btn-flip" style="${drawBothSides?"display:none":""}">⇄ Flip side</button>
      </div>
      <div class="popup-partial-actions" style="margin-top:6px;">
        <button class="popup-partial-action-btn active" id="draw-btn-save" style="border-color:var(--darkgreen);color:#4ecb82;">✓ Save</button>
        <button class="popup-partial-action-btn" id="draw-btn-cancel">✕ Cancel</button>
        ${hasExisting?`<button class="popup-partial-action-btn danger" id="draw-btn-clear">🗑 Clear</button>`:""}
      </div>
      <div class="popup-partial-status" id="draw-save-status"></div>
    `;

    const popup=L.popup({closeButton:false,closeOnClick:false,autoClose:false,className:""})
      .setLatLng(midPt).setContent(content).openOn(map);
    popup._isDrawControls=true;

    content.querySelector("#draw-btn-both").addEventListener("click",()=>{
      drawBothSides=true;
      content.querySelector("#draw-btn-both").classList.add("active");
      content.querySelector("#draw-btn-single").classList.remove("active");
      content.querySelector("#draw-btn-flip").style.display="none";
      updateDrawPreview(geomData);
    });
    content.querySelector("#draw-btn-single").addEventListener("click",()=>{
      drawBothSides=false;
      content.querySelector("#draw-btn-single").classList.add("active");
      content.querySelector("#draw-btn-both").classList.remove("active");
      content.querySelector("#draw-btn-flip").style.display="";
      updateDrawPreview(geomData);
    });
    content.querySelector("#draw-btn-flip").addEventListener("click",()=>{
      drawFlipped=!drawFlipped;
      updateDrawPreview(geomData);
    });
    content.querySelector("#draw-btn-save").addEventListener("click",()=>savePartialGeom(geomData,content.querySelector("#draw-save-status")));
    content.querySelector("#draw-btn-cancel").addEventListener("click",()=>{exitDrawMode(geomData);map.closePopup();});
    const clearBtn=content.querySelector("#draw-btn-clear");
    if(clearBtn) clearBtn.addEventListener("click",()=>clearPartialGeom(geomData,content.querySelector("#draw-save-status")));
  }

  async function savePartialGeom(geomData,statusEl) {
    if(drawStartProp===null||drawEndProp===null) return;
    const t0=Math.min(drawStartProp,drawEndProp);
    const t1=Math.max(drawStartProp,drawEndProp);
    const side=drawBothSides?"B":(drawFlipped?"F":"S");

    const segProps=globalPropToSegProps(t0,t1,geomData);
    if(!segProps.length){
      if((drawRoad.partial_geometry||"-")!=="-"){
        exitDrawMode(geomData); map.closePopup(); renderAllPartials(); updateStats();
      } else {
        if(statusEl) statusEl.textContent="No section drawn — tap road to place points first.";
      }
      return;
    }

    const newParts=segProps.map(sp=>({segIdx:sp.segIdx,t0:sp.t0,t1:sp.t1,side}));
    const existingParts=parsePartialGeom(drawRoad.partial_geometry||"");
    const allParts=[...existingParts,...newParts];
    const encoded=encodePartialGeom(allParts);

    if(statusEl) statusEl.textContent="Saving…";
    try{
      const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({
        action:"partial",rowIndex:drawRoad._rowIdx,partialGeometry:encoded,...tp
      })})).json();
      if(!data.ok){if(statusEl)statusEl.textContent="Save failed: "+(data.error||"");return;}
      drawRoad.partial_geometry=encoded;
      if(statusEl) statusEl.textContent="Saved ✓";
      recomputeAndSaveChecksum();
      setTimeout(()=>{exitDrawMode(geomData);map.closePopup();renderAllPartials();updateStats();},1200);
    }catch(e){if(statusEl)statusEl.textContent="Network error: "+e.message;}
  }

  async function clearPartialGeom(geomData,statusEl) {
    if(statusEl) statusEl.textContent="Clearing…";
    try{
      const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({
        action:"partial",rowIndex:drawRoad._rowIdx,partialGeometry:"-",...tp
      })})).json();
      if(!data.ok){if(statusEl)statusEl.textContent="Clear failed: "+(data.error||"");return;}
      drawRoad.partial_geometry="-";
      if(statusEl) statusEl.textContent="Cleared ✓";
      recomputeAndSaveChecksum();
      setTimeout(()=>{exitDrawMode(geomData);map.closePopup();renderAllPartials();updateStats();},1200);
    }catch(e){if(statusEl)statusEl.textContent="Network error: "+e.message;}
  }

  // ── Expose functions referenced by inline onclick/oninput handlers ─────────────
  window.toggleStatus = toggleStatus;
  window.filterWardList = filterWardList;
  window.selectAllWards = selectAllWards;
  window.onRoadSearchInput = onRoadSearchInput;
  window.onRoadSearchKey = onRoadSearchKey;
  window.selectRoad = selectRoad;
  window.clearRoadSearch = clearRoadSearch;
  window.manualRefresh = manualRefresh;
  window.popupEditClicked = popupEditClicked;
  window.triggerSignIn = triggerSignIn;
  window.signOut = signOut;
  window.openPartialEditor = openPartialEditor;
  window.cookieAccept = cookieAccept;
  window.cookieDecline = cookieDecline;
  window.showCookiePolicy = showCookiePolicy;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  (async function boot() {
    restoreAuthSession();
    const cached=loadFromCache();
    if(cached&&cached.rows&&cached.rows.length){
      document.getElementById("loading-msg").textContent="Loading from cache…";
      lastChecksum=cached.checksum; lastLoadTime=cached.time;
      ingestRows(cached.rows,cached.checksum,cached.time,true);
      document.getElementById("loading").classList.add("hidden");
      setSyncState("stale","Cached · checking…");
      checkForUpdates(false);
    } else { checkForUpdates(false); }
  })();

})();
