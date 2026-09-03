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
     HELP_URL   — override the sidebar "User Guide" link target
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
  const PARTIAL_ZOOM_THRESHOLD = 14;
  const LS_SUFFIX   = CFG.LS_SUFFIX || SHEET_GID;
  const LS_DATA     = `leafmap_data_v3_${LS_SUFFIX}`;
  const LS_CHECKSUM = `leafmap_checksum_v3_${LS_SUFFIX}`;
  const LS_TIME     = `leafmap_time_${LS_SUFFIX}`;
  const LS_AUTH     = `leafmap_auth_v1_${LS_SUFFIX}`;
  const LS_COOKIE   = `leafmap_cookie_consent_${LS_SUFFIX}`;
  const LS_MYPENDING = `leafmap_mypending_v1_${LS_SUFFIX}`;
  const INITIAL_VIEW = CFG.INITIAL_VIEW || [52.8, -2.12];
  const INITIAL_ZOOM = CFG.INITIAL_ZOOM || 12;
  // Shared across every deployment (same pattern as core.js/styles.css
  // themselves) rather than a relative link, since each deployment lives at
  // its own path and doesn't carry its own copy of help.html.
  const HELP_URL = CFG.HELP_URL || "https://daemeous.github.io/leaflet-map/help.html";

  // When true: Google sign-in still runs as normal (so the app knows who's
  // signed in), but the client-side "is this person on the Authorised list"
  // gate is skipped — everyone who signs in is treated as authorised for UI
  // purposes. Defaults to false so existing deployments don't need updating.
  // NOTE: this only relaxes the frontend gate. The Apps Script backend still
  // independently checks its own Authorised sheet on every update/partial/
  // revert/history call — for a public demo, that sheet (or the script's
  // isAuthorised() function) needs to accept demo visitors too, or their
  // edits will be silently rejected server-side despite the UI allowing them.
  const DISABLE_AUTH_CHECK = CFG.DISABLE_AUTH_CHECK === true;

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

  // ── PWA: manifest, iOS meta tags, service worker ────────────────────────────
  // Injected here rather than living as markup in each deployment's
  // index.html, so a core.js update is the only thing every deployment
  // needs to pick up for this. sw.js still has to be copied alongside
  // index.html per deployment — a service worker's script must be
  // same-origin, there's no way to register one from a shared/cross-origin
  // URL — but nothing about <head> markup or registration needs touching
  // per site. Icons are inlined as data URIs for the same reason: no
  // separate icons/ folder to copy into every deployment either.
  const PWA_ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAADUklEQVR42u3dwW3jQBBEUWZg+OSwnJnT9VFKQSB7yOmuR+AnINabkQGv9/j6/nlJqR0+BAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABMK8zj88NgIihgwGAsUMBgNHDAIDRwwCA4YMAgOGDAIDhgwBA4+H//v1fDgQAWgy/YuxPoQDA8Lce/F0gADD+NqNfhQEAw285fBAAKB9/x+FXQgAgdPwThl8FAYCg8U8cfgUEAAwfhIEQDuPPHD8EAwEY/n0QADB+CAAwfggAaDN+A18DAQDjhwCAfQEY83oEABg/BAAYPwQAGD8EABg/BAA8AMBI90AAgNPfLQCA8UMAgK8+vgoBYPwQAAAAAAAYPwQAlAAwvj4IAHD6uwUAcPq7BQBw+rsFAHD6uwUAcPq7BQBw+rsFAHD6uwUAMH63AAAAAJAIwPghAAAAAAAAAIAwAMYPAQAAAAAAAAAAAAAAABh/BoJ4AE5/twAAAAAAAAAAAAAAAAAYvx+EAQAAgOkAfP0B4GkEAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAeC3QeW3QQEQAL4Gyb8IA0AAACAAABAAfhCWvwznFjB+fxsUAAAAAAAAAAAAAAAIjN//EQYAAAAAAAAAEBg/AAAAAMDrk8e4+o8fALeA0x8At4DTHwC3gNMfALeA0x8At4DTHwC3gNMfALeA0x8At4DTPx4ABMYPAAAAJAOAwPgB+PAxyr3GDwAExg+Ar0K++gDgFnD6AwCB8QMAgfEDAIHxAwCB8QNwBwAI1o4fAAiMH4AeCECoG3738Y8BAIHxxwOAwPjjAZxBkA7hzDNpL+MAQGD88QBAMHwALiCYCuHsM3kf4wFcQTAFwpVn+jYiAFxF0BXC1SdhFzEAkiAYPgBLEeyIoepJ20IkgGoIT4CoflI3EA1gFYRqFCuf9HcPwE0Qdnu8bwAiIXi/AERC8D4BiITg/QEQh8F7AiAOg/cBQAwKnzMAETB8bgBIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAAgAH4IAkACQAJAAkACQAJAAkACQAJBm9QZjxVBqEAz9WgAAAABJRU5ErkJggg==";
  const PWA_ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAM2UlEQVR42u3dwVEjQRBFQXlAcMIsPMNdjmDDXNRd9bIj0gE2dv6blth9fXx+/QEALS8/BAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAAAeAHAQACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABADw0JPj5wUCABg85O8+/nxAAABLR14cgAAADL0wAAEAGHtRAAIADL4jCEAAgMF3BAEIADD4jiAAAQBG3xEDIADA6DtiAAQAGH1HDIAAAKPviAEQAGD4HSEAAgCMviMGQACA4XeEAAgADL/jCAEQABh9xxEDCAAw/I4jBBAAYPgdRwggAMDwO44QQACA4XccIYAAAMN/+Hz//L6NIwQQAGD8l427SBABCAAw/IZeGAgBBAAYfmMvCoQAAgAMv8EXBEIAAQDG3+ALAhGAAIDk8BtrMSAEEAAQGX+jLAZEAAIAIsNvfMWAEEAAQGT8jawYEAEIAIgMvzEVA0IAAQCh8TecQkAEIADA8CMEhAACALaNv1EUAyIAAQCh8TeATAgBzxEEAIbf8CMEQABg/A0/tRDwfEEAYPwNP9EQ8JxBAGD8DT/REPC8QQBg+A0/QgAEAMbfSCECQAAQGn/DRDkEPI8QAOTG3xAhBEQAAgDjDyIABABbx9/gIAREAAIA4w8iQAQgADD8IASEAAIA4w8iAAQAs8bfgCAERAACAOMPIkAEIAAw/iACRAACgBXjbyAQAiIAAYDxBxEgAhAAGH8QASIAAcCK8TcAcDYEPP8EgB+EADD+EIwAzz8B4Adh/I0/iAAEAMbf+IMIQABg/I0/iAAEAMbf+IMIQABg/A0/LAoBz0kBgPE3/iACEAAYf+MPIgABgAAw/rA6Ajw3BQDG3/iDCEAAYPyNP4gABADG3/iDCEAAYPwBEYAAIBAAHsLQiADPVQGA8Tf+IAIQALj6B3wUgADA+AMiAAGAq3/ARwEIAIw/IAIQABh/QAQgALg6ADxUQQQIAAGA8QdEgAgQALj6B3wUgADA2z/gFgABgPEHRAACAOMPiAAEAAIAEAAIAIw/IAIQABh/QAQgAASA8QcGRIDntQDA2z/gFgABgLd/wC0AAgDjD4gABAACABAACACMPyACEADG3/gDIgABIAAEACAAEADG3/gDIgABIACMP3BZBHiuCwC8/QNuARAAePsH3AIgAPD2D7gFQAAIAOMPuAVAABh/4w+IAASAABAAgABAABh/4w+IAASAABAAgABAAGQDwEMMuDECPPcFAN7+AbcACAABYPwBtwAIAOMvAAC3AAgAAWD8AbcACADjLwAAtwAIAAFg/AG3AAgAAQAgABAAxh9ABCAABACAABAA+PIfgC8DCgC8/QO4BRAACAAAASAAMP6ACBABAgABAAgAASAAOBAAHkbAlgiwEwLA+AsAwC0AAkAACABAACAABIDxB3wMgADw9g/gFgABIAAABAACwPU/gI8BEADe/gHcAiAABACAABAAuP4H8DGAAEAAAAgAAYDrfwAfAwgAvP0DuAUQAAgAQAAIAAGAAAAEgAAQAMbf+AMiQAQIAAEgAAABIAAEgAAQAIAAEAACQAAIAEAACAABYPyNPyACEAACAEAAIAAEAIAAQAAIAAABgABYEwAeKkA5AuyKAPD2D+AWAAEgAAAEAAJAAAAIAASAAAAQAAgAXwAE8EVABIAAABAAAgDX/wA+BhAACAAAASAAEAAAAkAAIAAABIAAwBcAAXwRUAAIAAEAIAAEgAAQAIAAEAACwPgLAEAAiAABIAAEACAABIAAEAACABAAAkAACAAPEEAACAABIAAABIC9EQACAEAAIAD8CiCAXwVEAAgAAAGAABAAAAIAASAAAASAAEAAAAgAAYAAABAAAgABACAABAACAEAACAD8I0AA/jEgASAABACAABAAAkAAAAJAAAgAASAAAAEgAASAABAAgAAQAAJAAAgAQAAIAAEgADw4AAEgAASAAAAQAAJAAAgAAAGAABAAAAIAASAAAAQAAsD/BQDg/wJAAAgAAAEgAPwQBACAABAACAAAASAAEAAAAkAAIAAABIAAQAAACAABIAAEAIAAEAACQAQAxl8ACAABIAAAASAABIAAEACAABAAAkAACABAAAgAASAABAAgAASAABAAAAJAAAgAvwoI4FcAEQACAEAAIAAEAIAAQAD4HgCAz/8RAAIAQAAgAAQAgAAQAAgAAAEgAPBFQABfABQACAAAASAA8DEAgOt/AYAAABAAAkAACABAAAgAASAABAAgAASAABABAgAQAMZfAAgAEQAYfwEgAASAAAAEgAAQAAJAAAACAAEgAAAEAAJABAAYfwSAAAAQAAgAAQAgABAAAgBAACAARACA8RcACAAAASAAEAAAAkAAcE8AiACgMP4CQACIAAEAePtHAAgAAQAIAASAjwEAXP8jAAQAgABAAPgYAMD1PwLALQCAt38EgAAAEAACAB8DALj+FwC4BQDw9i8AEAAAAkAA4GMAQAAYfwGAWwDA+AsAAYAAAASAABAAiADA+Bt/ASAABAAgAASAABAAIgCoj78AEAAiQAAA3v4RAAJAAAACAAEgAkQAYPwRAAJAAAACAAEgAEQA4Mt/CAC3AADe/hEAbgEAvP0jANwCAHj7FwC4BQDw9i8AcAsA4O1fAOAWADD+AkAAIAAAASAABAAiADD+xl8AIAAAASAABAAiADD+xl8AcDIARABwcvwFgADALQDg7R8BgFsAwNs/AgC3AIC3fwSAABABgLd/BIAIEAGA8UcACAABAAgABIAIEAGA8UcAiAARABh/BIAAEACAAEAAiAARAMbf+AsA4gEgAsD4CwABgFsAQAAYfwGAWwDA+AsAAYAIAIy/8RcAiADA+Bt/AYAAAAQAAgARABh/BAAiADD+CADuDwARAMZfAAgA3AIAAsD4CwBEAGD8EQD4KABw9Y8AQAQAxh8BgAgAjD8CgMkBIAKgO/4CQAAgAjx0wfgjAPBRAODqHwGACACMPwIAHwUArv4RAIgAwPgjABABgPFHACACAOOPAEAEAMYfAcCAABABMHv8BYAAQASIADD+CABEgAgA448AQAQIAVgz/MZfACACRAAYfwQAIkAEgPFHACACRAAYfwQAIkAEgPFHACAARAAMGX8BgADgaAQIAQy/8UcAIALA+Bt/BAAiAIy/8UcAkIgAIYDhN/4IAEQAGH/jjwBABIDxN/4IABIRIAQw/MYfAYAIAONv/BEACAEw/IYfAYAIAOPvOYUAYHcECAEMv/FHACACwPh7LiEAqEWAEKA8/MYfAUA+AoQAteE3/ggARIAIwPiDAEAICAEMPwgAwhEgBNg0/MYfAYAIEALEht/4IwAQAUKA2PAbfwQAQkAIYPhBACAChABbh9/4IwAQAWKA0OgbfwQAQkAIYPhBACAChACbh9/4IwAQAmKA0OgbfgQAIkAMEBp9448AgMEhIAaMvuFHAEA4AsSA0Tf+CAAQAmLA6Bt+BACUI0AQtAff+CMAQAgIgtjgG34EAAgBURAZe8OPAAAhkA+D6vH3FAEAImBtJDjGHwEAQsAx/P4+IgBACDiGHwQACAHH8IMAACHgGH4QACAEHMMPAgDEgGP0QQCAEHAMPwgAEAKO4QcBAGLAMfogAEAIOIYfBACIAcfogwAAMWD0AQEAYsDogwDwQwAxYPRBAACCwOCDAAAEgcEHAQAIAoMPAgAQBcYeBAAgDAw9CACgFgf+fEAAAIPDwc8LBAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAADwwD8vWCH6cpAS1QAAAABJRU5ErkJggg==";
  const PWA_APPLE_ICON = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAADAklEQVR42u3d0U3EMBBF0e0A8UVZdEa7fILogMROMvPmWLoN2EcjZ1ebfb29f/xIKb1sgoCWgJaAloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAloCWgBLQEtAS0BXbP/LPsEdCuwq8s+A90aMOBAxyOGG+hYxHADHQ0ZbKAjIYMN9O3IPr++wQa6PuQ/qLsDG+jbIF8B+C7gQMP8GOKrcAM9FHIlxFfgBnoI5g6Qd8EGOhhzR8g7YAMNMthA18OcCHkVNtAwQw30c5gnQV6BDTTMUAMNM9RAH8IM8DpsoGGGGmiYoQYa5htRAw0z1EDDDHU4aJihBlpAw6wE1C+YlYS6LWjonkcNtOlsSgMNsyndGDTMUAMtoCuChhlqoAV0RdAwQw20gK4IGmaogRbQHUFD1Av1eNCmsykNtIDuCBoe145WoE1nUxpoAd0RNDSuHUALaNcNJV07gBbQrhuqeu0AWkADLaCBBhpoAQ20gPaRnTI+ugNaQAMtoIEGeiJoSDwYmtAyoYEW0EALaKCB9k2hPBACLaCBFtBAC2iggQZaQPvVt/zqG2gB7doBtDcnAQ20t4/KdQNoAe3aIW/wN6VhBhpooP1PoVw3/JOsxkxnoAU01DBXxQy0gIYa5qqYgRbQUMNcFTPQAhpqmKtibgsa6hqYgTalTWegoTadA0BDDXMcaKhhBlpAQ60EzG1AQw1zHGioYR4JGur9mIGGGmagoYZ5KOgjqME+B7kj5tagoYY5DjTUMMeBPop6Guyjq7uFCNBQwxwH+gzqVNhnVoqBKNDTYU+GHA36LOqusM+uxHOPBb2CugvslZV65tGgd8Cuhnt1pZ/1CNA7UD+Je9eacM5jQO+GfSXw3WvS+Y4DfRXs/8C/e00817Ggn4INMtBggwz0JNjODej2uJ0P0O1xOwegWwO3z0C3Am+fgJaAFtAS0BLQEtAS0AJaAloCWgJaAlpAS0BLQEtAS0ALaAloCWgJaAloAS0BLQEtAS2gJaClev0CJHNfV+3/t+EAAAAASUVORK5CYII=";

  function injectPwaHead() {
    // Manifest member URLs resolve relative to the manifest's OWN location —
    // fine for a static manifest.json sitting next to index.html, but this
    // one is served from a blob: URL (see below), which has no meaningful
    // directory to resolve "./" against. Made absolute here instead, using
    // the page's actual location, so it's correct regardless of that.
    const baseUrl = new URL("./", document.location.href).href;
    const manifest = {
      name: CFG.TITLE || "Leafleting Map",
      short_name: (CFG.TITLE || "Leafleting Map").slice(0, 24),
      description: CFG.SUBTITLE || "Track leafleting progress by road and ward.",
      start_url: baseUrl,
      scope: baseUrl,
      display: "standalone",
      background_color: "#0f1117",
      theme_color: "#0f1117",
      icons: [
        { src: `data:image/png;base64,${PWA_ICON_192}`, sizes: "192x192", type: "image/png" },
        { src: `data:image/png;base64,${PWA_ICON_512}`, sizes: "512x512", type: "image/png" }
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
    const manifestLink = document.createElement("link");
    manifestLink.rel = "manifest";
    manifestLink.href = URL.createObjectURL(blob);
    document.head.appendChild(manifestLink);

    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color"; themeColor.content = "#0f1117";
    document.head.appendChild(themeColor);

    const appleIcon = document.createElement("link");
    appleIcon.rel = "apple-touch-icon";
    appleIcon.href = `data:image/png;base64,${PWA_APPLE_ICON}`;
    document.head.appendChild(appleIcon);

    // iOS has no install-prompt API — these are what make "Add to Home
    // Screen" behave like an installed app (standalone chrome, correct
    // title/icon) instead of just bookmarking the page.
    [["apple-mobile-web-app-capable","yes"],
     ["apple-mobile-web-app-status-bar-style","black-translucent"],
     ["apple-mobile-web-app-title", CFG.TITLE || "Leafleting"]].forEach(([name,content])=>{
      const m=document.createElement("meta"); m.name=name; m.content=content; document.head.appendChild(m);
    });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(()=>{}); });
    }
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
      <div id="sync-bar" title="Click to check for updates · Shift-click / long-press to force full reload" onclick="handleSyncBarClick(event)">
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
        <button class="ward-all-btn" id="gps-locate-btn" onclick="locateAndFilterWard()" style="border-style:solid;border-color:var(--accent);color:var(--accent);margin-bottom:8px;">⊕ Find my ward</button>
        <button class="ward-all-btn" id="live-track-btn" onclick="toggleLiveTracking()" style="border-style:solid;border-color:var(--accent);color:var(--accent);margin-bottom:8px;">◉ Live tracking: Off</button>
        <input class="ward-search" type="text" placeholder="Search wards…" oninput="filterWardList(this.value)">
        <button class="ward-all-btn" onclick="selectAllWards()">Select / deselect all</button>
        <div class="ward-list" id="ward-list"></div>
      </div>
      <div class="filter-section" style="margin-top:auto;display:none;" id="admin-panel-section">
        <button class="ward-all-btn" id="pending-panel-link" onclick="openPendingPanel()" style="border-style:solid;border-color:var(--yellow);color:var(--yellow);margin-bottom:8px;">⏳ Pending changes<span class="toggle-count" id="pending-count" style="margin-left:6px;"></span></button>
        <button class="ward-all-btn" id="admin-panel-link" onclick="openAdminPanel()" style="border-color:var(--red);color:var(--red);">⚠ Editor history / revert</button>
      </div>
      <a href="${HELP_URL}" target="_blank" rel="noopener" style="display:block;text-align:center;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.06em;color:var(--muted);text-decoration:none;padding:9px;border:1px solid var(--border);border-radius:6px;">📖 User Guide</a>
    </div>
  </aside>
  <div id="map-wrap">
    <button id="sidebar-toggle" onclick="toggleSidebar(event)">☰</button>
    <div id="map"></div>
    <div id="draw-hint"></div>
    <div id="loading"><div class="spinner"></div><p id="loading-msg">Loading road data…</p></div>
    <div id="error-banner"></div>
    <div id="admin-modal-overlay" style="display:none;"></div>
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
  injectPwaHead();

   // ── Prevent sidebar/toggle taps reaching the map (fixes mobile stuck-closed bug) ──
   L.DomEvent.disableClickPropagation(document.getElementById("sidebar"));
   L.DomEvent.disableClickPropagation(document.getElementById("sidebar-toggle"));

  // ── Map ───────────────────────────────────────────────────────────────────────
  const map = L.map("map",{zoomControl:false}).setView(INITIAL_VIEW, INITIAL_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    attribution:'© <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom:19
  }).addTo(map);

  // ── State ─────────────────────────────────────────────────────────────────────
  let allRoads     = [];
  let layerGroups  = {};
  let partialLayerGroup = L.layerGroup().addTo(map);
  let activeStatus = new Set(STATUSES.map(s=>s.key));
  let activeWards  = new Set();
  let wardCounts   = {};
  let lastChecksum          = null;
  let lastLoadTime          = null;
  let residencesServedTotal = null;
  let pollTimer        = null;
  let isChecking       = false;
  let selectedRoadName   = null;
  let fadeCurrent        = 0.85;
  let fadeAnimFrame      = null;
  let fadeTimer          = null;
  let authToken      = null;
  let authTokenType  = "idToken";
  let authEmail      = null;
  let authExpiry     = 0;
  let authAuthorised = false;
  let authBanned     = false;
  let renderedLayers = new Map();
  let partialLayers  = new Map();
  // rowIdx -> {field, value, ts} — THIS browser's own not-yet-reviewed
  // proposals, so a suggested change previews live for the person who made
  // it (colour on the map, badge in the popup) without touching the shared
  // Data sheet or being visible to anyone else until an editor approves it.
  let myPendingByRow = new Map();

  // ── Drawing state ─────────────────────────────────────────────────────────────
  // drawStart / drawEnd are now { segIdx: number, t: number, latlng: [lat,lon] }
  // instead of global proportions. This avoids all issues with segment
  // concatenation order and detached stub segments.
  let drawState      = null;
  let drawRoad       = null;
  let drawStart      = null;   // { segIdx, t, latlng }
  let drawEnd        = null;   // { segIdx, t, latlng }
  let drawBothSides  = false;
  let drawPreviewLayers = [];
  let drawHandleStart = null;
  let drawHandleEnd   = null;
  let drawActiveHandle = null;
  let drawFlipped    = false;
  let drawRoadHighlightLayers = [];

  // ── Cookie consent ────────────────────────────────────────────────────────────
  function cookieConsent() { return localStorage.getItem(LS_COOKIE); }
  function showCookieBanner() { if(!cookieConsent()) document.getElementById("cookie-banner").classList.remove("hidden"); }
  function cookieAccept() { localStorage.setItem(LS_COOKIE,"accepted"); document.getElementById("cookie-banner").classList.add("hidden"); persistAuthSession(); }
  function cookieDecline() { localStorage.setItem(LS_COOKIE,"declined"); document.getElementById("cookie-banner").classList.add("hidden"); localStorage.removeItem(LS_AUTH); }
  function showCookiePolicy() { alert("Cookie / local storage policy\n\nWe store a small token remembering your Google sign-in for up to 55 minutes, and a local cache of road data for instant loads. No personal data is shared with third parties."); }

  // ── Auth persistence ──────────────────────────────────────────────────────────
  // Persists for anyone verified-and-not-banned, not just authorised editors
  // — a signed-in proposer shouldn't have to sign in again on every reload
  // just to see their own pending-review badges.
  function persistAuthSession() {
    if(cookieConsent()!=="accepted"||!authToken||!authEmail||authBanned) return;
    try { localStorage.setItem(LS_AUTH,JSON.stringify({token:authToken,tokenType:authTokenType,email:authEmail,expiry:authExpiry,authorised:authAuthorised,banned:authBanned})); } catch(e){}
  }
  function restoreAuthSession() {
    if(cookieConsent()!=="accepted") return;
    try {
      const raw=localStorage.getItem(LS_AUTH); if(!raw) return;
      const s=JSON.parse(raw);
      if(!s.token||Date.now()>=s.expiry-30_000){localStorage.removeItem(LS_AUTH);return;}
      authToken=s.token; authTokenType=s.tokenType||"idToken"; authEmail=s.email; authExpiry=s.expiry;
      authAuthorised = DISABLE_AUTH_CHECK ? true : s.authorised;
      authBanned = DISABLE_AUTH_CHECK ? false : (s.banned===true);
      if(authAuthorised && !DISABLE_AUTH_CHECK) {
        setTimeout(()=>{ const el=document.getElementById("admin-panel-section"); if(el) el.style.display=""; refreshPendingCount(); }, 0);
      }
    } catch(e){localStorage.removeItem(LS_AUTH);}
  }

  // ── My pending proposals (local-only optimistic preview) ────────────────────
  const MY_PENDING_MAX_AGE_MS = 30*24*60*60*1000; // 30 days
  function loadMyPending() {
    try {
      const raw=localStorage.getItem(LS_MYPENDING); if(!raw) return;
      const obj=JSON.parse(raw);
      myPendingByRow=new Map(Object.entries(obj).map(([k,v])=>[parseInt(k,10),v]));
      // A denied proposal never gets communicated back to the submitter (no
      // push mechanism here) — an approved one self-clears via ingestRows
      // once the real Status catches up, but a denial would otherwise leave
      // this browser showing a stale "pending" preview forever. Age it out.
      let pruned=false;
      const cutoff=Date.now()-MY_PENDING_MAX_AGE_MS;
      myPendingByRow.forEach((v,k)=>{ if((v.ts||0)<cutoff){myPendingByRow.delete(k);pruned=true;} });
      if(pruned) saveMyPending();
    } catch(e){}
  }
  function saveMyPending() {
    try {
      const obj={}; myPendingByRow.forEach((v,k)=>{obj[k]=v;});
      localStorage.setItem(LS_MYPENDING,JSON.stringify(obj));
    } catch(e){}
  }
  // Every entry records WHOSE proposal it is, so it can be kept in local
  // storage (surviving sign-out — the submitter should see it again if they
  // sign back in) while only ever being RENDERED for that same person.
  function setMyPending(rowIdx,field,value) { myPendingByRow.set(rowIdx,{field,value,email:(authEmail||"").toLowerCase(),ts:Date.now()}); saveMyPending(); }
  function clearMyPending(rowIdx) { if(myPendingByRow.delete(rowIdx)) saveMyPending(); }
  function invalidateRowLayers(rowIdx) {
    [...renderedLayers.keys()].filter(k=>k.startsWith(rowIdx+"_")).forEach(k=>{
      const entry=renderedLayers.get(k);
      if(entry){entry.layers.forEach(l=>{if(layerGroups[entry.ward])layerGroups[entry.ward].removeLayer(l);});renderedLayers.delete(k);}
    });
  }
  // A pending entry only counts as "mine" — and therefore only gets
  // rendered — while signed in as the exact email that submitted it.
  // Signed out, or signed in as someone else, it's inert: the map shows the
  // real sheet value instead. Nothing is deleted by this, so it reappears
  // correctly if the original submitter signs back in before it's resolved.
  function myPendingFor(rowIdx) {
    const p=myPendingByRow.get(rowIdx);
    if(!p || !authEmail || p.email!==authEmail.toLowerCase()) return null;
    return p;
  }
  // What this browser should actually render for a road's status: its own
  // unreviewed proposal if it has one AND it's currently signed in as the
  // person who made it, otherwise the real sheet value.
  function effectiveStatus(road) {
    const p=myPendingFor(road._rowIdx);
    return (p&&p.field==="status") ? p.value : road.Status;
  }
  // Called whenever who's signed in changes (sign-in, sign-out) — every
  // pending row's visibility depends on that, not just its own data, so it
  // needs to re-render even though nothing in myPendingByRow itself changed.
  function refreshPendingVisibility() {
    if(!myPendingByRow.size) return;
    myPendingByRow.forEach((v,rowIdx)=>invalidateRowLayers(rowIdx));
    renderLines(); updateStats(); updateCountBadges();
  }
  // A denial never touches Data, so the normal "checksum changed -> re-diff
  // -> drop stale overrides" path in ingestRows never fires for it — that
  // only catches approvals. This is the other half: ask the backend (no
  // sign-in required, so it works even if this browser has since signed out
  // or switched accounts) whether each locally-pending row+field is still
  // actually pending, and drop the ones that have since been resolved. This
  // is about the SERVER-side fate of the proposal, so unlike rendering it
  // deliberately checks every stored entry regardless of who's signed in now.
  async function reconcileMyPending() {
    if(!myPendingByRow.size) return;
    const rows=[...myPendingByRow.entries()].map(([rowIdx,p])=>({rowIndex:rowIdx,field:p.field}));
    try{
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"pendingStatus",rows})})).json();
      if(!data.ok) return;
      let changed=false;
      rows.forEach(r=>{
        const status=data.statuses[r.rowIndex+":"+r.field];
        if(status!=="Pending" && myPendingByRow.delete(r.rowIndex)) {
          changed=true;
          invalidateRowLayers(r.rowIndex);
        }
      });
      if(changed){saveMyPending();renderLines();updateStats();updateCountBadges();}
    }catch(e){ /* offline or network error — leave local state, retry next poll */ }
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

  function turfPt(latlng) { return turf.point([latlng[1],latlng[0]]); }

  function cumulativeLengths(pts) {
    const lens=[0];
    for(let i=1;i<pts.length;i++) {
      const d=turf.distance(turfPt(pts[i-1]),turfPt(pts[i]),{units:"meters"});
      lens.push(lens[i-1]+d);
    }
    return lens;
  }

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

  // ── Per-segment snap ──────────────────────────────────────────────────────────
  // Returns { segIdx, t, latlng } where segIdx is the raw WKT segment index
  // and t is 0-1 along that individual segment.
  function snapToNearestSegment(clickLatLng, segs) {
    let bestSegIdx = 0, bestT = 0, bestDist = Infinity, bestPt = segs[0][0];
    const click = turf.point([clickLatLng.lng, clickLatLng.lat]);

    segs.forEach((pts, segIdx) => {
      const cumLens = cumulativeLengths(pts);
      const segTotal = cumLens[cumLens.length - 1];

      for (let i = 1; i < pts.length; i++) {
        const a = [pts[i-1][1], pts[i-1][0]];
        const b = [pts[i][1],   pts[i][0]];
        const line = turf.lineString([a, b]);
        const snapped = turf.nearestPointOnLine(line, click, {units:"meters"});
        const d = snapped.properties.dist;
        if (d < bestDist) {
          bestDist = d;
          const c = snapped.geometry.coordinates;
          const distAlongSeg = turf.distance(turf.point(a), turf.point(c), {units:"meters"});
          const subSegLen = cumLens[i] - cumLens[i-1];
          const clamped = Math.min(subSegLen, Math.max(0, distAlongSeg));
          const tAlongSeg = segTotal > 0 ? (cumLens[i-1] + clamped) / segTotal : 0;
          bestSegIdx = segIdx;
          bestT = Math.min(1, Math.max(0, tAlongSeg));
          bestPt = [c[1], c[0]];
        }
      }
    });

    return { segIdx: bestSegIdx, t: bestT, latlng: bestPt };
  }

  // ── Segment path traversal ────────────────────────────────────────────────────
  // Given a start {segIdx, t} and end {segIdx, t} on potentially different
  // segments, find the shortest path through segment endpoints connecting them.
  // Returns an array of { segIdx, t0, t1 } entries ready for encoding.
  //
  // Strategy:
  //   1. If same segment: trivial.
  //   2. Otherwise: from the start segment, pick the endpoint (start or end)
  //      that is geographically closest to the end segment's chosen endpoint.
  //      Then greedily chain through remaining segments by nearest-endpoint
  //      matching until we reach the target segment.
  //
  // "Closest endpoint" is determined in degree-space (cheap, sufficient).

   function segEndpoints(seg) {
    // Returns { start: [lat,lon], end: [lat,lon] }
    return { start: seg[0], end: seg[seg.length - 1] };
  }

  function ptDist2(a, b) {
    const dLat = a[0]-b[0], dLon = a[1]-b[1];
    return dLat*dLat + dLon*dLon;
  }

  function buildSegmentPath(segs, startSnap, endSnap) {
    const sIdx = startSnap.segIdx;
    const eIdx = endSnap.segIdx;

    if (sIdx === eIdx) {
        const t0 = Math.min(startSnap.t, endSnap.t);
        const t1 = Math.max(startSnap.t, endSnap.t);
        if (t1 - t0 < 0.0001) return [];
        return [{ segIdx: sIdx, t0, t1 }];
    }

    // Build a graph of which segments connect to which via shared endpoints
    // (within a tolerance), then do a shortest-path (BFS by hop count) from
    // sIdx to eIdx. This avoids greedy degree-space mistakes entirely.
    const SNAP = 0.0003; // ~30m in degrees

    function epClose(a, b) {
        return Math.abs(a[0]-b[0]) < SNAP && Math.abs(a[1]-b[1]) < SNAP;
    }

    // For each segment, record its start and end points
    const eps = segs.map(seg => ({ start: seg[0], end: seg[seg.length-1] }));

    // Build adjacency: adj[i] = array of { segIdx, reverseI, reverseJ }
    // reverseI = whether seg i must be traversed end→start to reach the join
    // reverseJ = whether seg j must be traversed start→end from the join
    const adj = segs.map(() => []);
    for (let i = 0; i < segs.length; i++) {
        for (let j = 0; j < segs.length; j++) {
            if (i === j) continue;
            // end of i connects to start of j
            if (epClose(eps[i].end, eps[j].start))
                adj[i].push({ to: j, exitI: 'end', entryJ: 'start' });
            // end of i connects to end of j (j traversed backwards)
            if (epClose(eps[i].end, eps[j].end))
                adj[i].push({ to: j, exitI: 'end', entryJ: 'end' });
            // start of i connects to start of j (i traversed backwards)
            if (epClose(eps[i].start, eps[j].start))
                adj[i].push({ to: j, exitI: 'start', entryJ: 'start' });
            // start of i connects to end of j (both relevant)
            if (epClose(eps[i].start, eps[j].end))
                adj[i].push({ to: j, exitI: 'start', entryJ: 'end' });
        }
    }

    // BFS from sIdx to eIdx, tracking which end of sIdx we exit from
    // State: { segIdx, entryEnd ('start'|'end'|null for first) }
    // We try both exit directions from sIdx
    const INF = 999999;
    let bestPath = null;

    for (const startExit of ['end', 'start']) {
        // Check start segment makes sense for this exit direction
        const startT0 = startExit === 'end' ? startSnap.t : 0;
        const startT1 = startExit === 'end' ? 1.0 : startSnap.t;
        if (Math.abs(startT1 - startT0) < 0.0001) continue;

        // BFS
        const visited = new Map(); // segIdx+entryEnd → prev
        const queue = [{ segIdx: sIdx, entryEnd: null, exitEnd: startExit, path: [] }];
        let found = null;

        while (queue.length && !found) {
            const cur = queue.shift();
            const stateKey = `${cur.segIdx}:${cur.exitEnd}`;
            if (visited.has(stateKey)) continue;
            visited.set(stateKey, true);

            const newPath = [...cur.path, { segIdx: cur.segIdx, exitEnd: cur.exitEnd, entryEnd: cur.entryEnd }];

            if (cur.segIdx === eIdx && cur.path.length > 0) {
                found = newPath;
                break;
            }

            for (const edge of adj[cur.segIdx]) {
                if (edge.exitI !== cur.exitEnd) continue;
                queue.push({
                    segIdx: edge.to,
                    entryEnd: edge.entryJ,
                    exitEnd: edge.entryJ === 'start' ? 'end' : 'start',
                    path: newPath
                });
            }
        }

        if (found && (!bestPath || found.length < bestPath.length)) {
            bestPath = found;
        }
    }

    if (!bestPath) {
        // No topological connection found — fall back to just the two endpoints
        // independently (disconnected road segments, user drew across a gap)
        const result = [];
        const t0s = Math.min(startSnap.t, 1);
        const t1s = Math.max(startSnap.t, 0);
        result.push({ segIdx: sIdx, t0: startSnap.t, t1: 1.0 });
        result.push({ segIdx: eIdx, t0: 0.0, t1: endSnap.t });
        return result.filter(e => Math.abs(e.t1-e.t0) > 0.0001);
    }

    // Convert BFS path to {segIdx, t0, t1} entries
    const result = [];
    bestPath.forEach((step, i) => {
        const isFirst = i === 0;
        const isLast  = i === bestPath.length - 1;

        let t0, t1;
        if (isFirst) {
            // Start segment: from startSnap.t to whichever end we exit from
            t0 = step.exitEnd === 'end' ? startSnap.t : 0;
            t1 = step.exitEnd === 'end' ? 1.0 : startSnap.t;
        } else if (isLast && step.segIdx === eIdx) {
            // End segment: from whichever end we entered to endSnap.t
            t0 = step.entryEnd === 'start' ? 0 : endSnap.t;
            t1 = step.entryEnd === 'start' ? endSnap.t : 1.0;
        } else {
            // Middle segment: full traversal
            t0 = 0; t1 = 1;
        }

        if (Math.abs(t1-t0) > 0.0001) {
            result.push({ segIdx: step.segIdx, t0: Math.min(t0,t1), t1: Math.max(t0,t1) });
        }
    });

    return result;
  }

  // ── getRoadGeomData ───────────────────────────────────────────────────────────
  // Returns per-segment data. segs = raw WKT order (stable indices for encoding).
  // sortedSegs = topologically chained (used only for highlight glow).
  function getRoadGeomData(road) {
    const rawSegs = parseWKT(road.road_geometry);
    if (!rawSegs.length) return null;
    const sortedSegs = sortSegmentsTopologically(rawSegs);
    // Per-segment cumulative lengths (each segment independent)
    const segCumLens = rawSegs.map(seg => cumulativeLengths(seg));
    return { segs: rawSegs, sortedSegs, segCumLens };
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
    const pgStr=(road.partial_geometry||"").trim();
    if(!pgStr||pgStr==="-") return 0.3;
    const segs = parseWKT(road.road_geometry);
    if(!segs.length) return 0.3;
    const segCumLens = segs.map(seg => cumulativeLengths(seg));
    const totalRoadLen = segCumLens.reduce((sum, cl) => sum + cl[cl.length-1], 0);
    if(totalRoadLen === 0) return 0.3;

    let covered = 0;
    pgStr.split("|").forEach(part => {
      const m = part.match(/^seg(\d+):([\d.]+)-([\d.]+):(B|S|F)$/);
      if(!m) return;
      const segIdx = parseInt(m[1]);
      const t0 = parseFloat(m[2]), t1 = parseFloat(m[3]);
      const side = m[4];
      const cl = segCumLens[segIdx];
      if(!cl) return;
      const segLen = cl[cl.length-1];
      const coveredLen = Math.abs(t1-t0) * segLen;
      covered += coveredLen * (side==="B" ? 1.0 : 0.5);
    });
    return Math.min(1, covered / totalRoadLen);
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

  // ── Partial overlay rendering ─────────────────────────────────────────────────
  const PARTIAL_COLOUR = "#1e7e4a";
  const PARTIAL_WEIGHT_BOTH   = 8;
  const PARTIAL_WEIGHT_SINGLE = 6;
  const PARTIAL_OFFSET_M      = 5;

  function renderAllPartials() {
    partialLayerGroup.clearLayers();
    partialLayers.clear();
    const zoom=map.getZoom();
    allRoads.forEach(road=>{
      if(statusKey(road.Status)!=="inprogress") return;
      const pgStr=(road.partial_geometry||"").trim();
      if(!pgStr||pgStr==="-") return;
      if(zoom<PARTIAL_ZOOM_THRESHOLD && road.Street.toLowerCase()!==(selectedRoadName||"").toLowerCase()) return;
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

    const segs = parseWKT(road.road_geometry);
    if(!segs.length) return;
    const segCumLens = segs.map(seg => cumulativeLengths(seg));
    const parts = parsePartialGeom(pgStr);

    parts.forEach(({segIdx, t0, t1, side}) => {
      const segPts = segs[segIdx];
      const segCL  = segCumLens[segIdx];
      if(!segPts || !segCL) return;

      const p0 = interpolateAlongPts(segPts, segCL, t0);
      const p1 = interpolateAlongPts(segPts, segCL, t1);
      let subset = [p0];
      const segTotal = segCL[segCL.length-1];
      segPts.forEach((p,i) => {
        const prop = segTotal > 0 ? segCL[i] / segTotal : 0;
        if(prop > t0 && prop < t1) subset.push(p);
      });
      subset.push(p1);
      if(subset.length < 2) return;

      let l;
      if(side==="B") {
        l = L.polyline(subset, {color:PARTIAL_COLOUR, weight:PARTIAL_WEIGHT_BOTH, opacity:0.9, interactive:false});
      } else {
        const offsetPts = offsetPolyline(subset, side==="F" ? -PARTIAL_OFFSET_M : PARTIAL_OFFSET_M);
        l = L.polyline(offsetPts, {color:PARTIAL_COLOUR, weight:PARTIAL_WEIGHT_SINGLE, opacity:0.9, interactive:false});
      }
      l.addTo(partialLayerGroup); layers.push(l);
    });

    partialLayers.set(road._rowIdx, layers);
  }

  map.on("zoomend", ()=>renderAllPartials());

  // ── Misc helpers ──────────────────────────────────────────────────────────────
  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function getResidences(row) {
    const raw=row["Residences"]??row["residences"]??row["RESIDENCES"]??"";
    return parseFloat(raw)||0;
  }
  function fmtResidences(row) { const n=getResidences(row); return n?String(Math.round(n)):null; }

  // ── Popup HTML ────────────────────────────────────────────────────────────────
  function popupHtml(row) {
    const st=getStatus(effectiveStatus(row));
    const isPending=!!myPendingFor(row._rowIdx);
    const resStr=fmtResidences(row);
    const resBadge=resStr?`<span class="popup-residences">🏠 ${escHtml(resStr)} residences</span>`:"";
    return `
      <div class="popup-street">${escHtml(row.Street)}</div>
      <div class="popup-ward">${escHtml(row.Ward)}</div>
      <div class="popup-meta">
        <button class="popup-status-btn" data-row-idx="${row._rowIdx}" title="Click to change status">
          <span class="popup-status ${st.popupCls}">${escHtml(st.label)}${isPending?" ⏳":""}</span>
        </button>
        ${resBadge}
      </div>
      <div class="popup-edit-area" id="edit-${row._rowIdx}" style="display:none"></div>
    `;
  }

  map.on("popupopen", function(e) {
    const btn = e.popup.getElement().querySelector(".popup-status-btn[data-row-idx]");
    if (!btn) return;
    const rowIdx = parseInt(btn.dataset.rowIdx, 10);
    btn.addEventListener("click", function() { popupEditClicked(this, rowIdx); });
  });

  // ── Main render ───────────────────────────────────────────────────────────────
  function segmentKey(rowIdx,segIdx) { return `${rowIdx}_${segIdx}`; }

  function desiredLayerSpec(road) {
    const eff=effectiveStatus(road);
    const sk=statusKey(eff);
    const ward=(road.Ward||"").trim();
    if(!activeStatus.has(sk)||!activeWards.has(ward)) return null;
    const hasSel=!!selectedRoadName;
    const isSel=hasSel&&(road.Street||"").trim().toLowerCase()===selectedRoadName.toLowerCase();
    const opac=hasSel&&!isSel?fadeCurrent:0.85;
    return {colour:colourFor(eff),weight:weightFor(eff),opac,isSel,sk,ward};
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
    if(isMobile()) closeSidebar();
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
  function clearCache() {
    try{localStorage.removeItem(LS_DATA);localStorage.removeItem(LS_CHECKSUM);localStorage.removeItem(LS_TIME);}catch(e){}
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────────
  function ingestRows(rows,checksum,timestamp,isFirstLoad) {
    const prevWards=new Set(activeWards);
    const newByIdx=new Map();
    rows.filter(r=>r.Street&&r.Street.trim()).forEach((r,i)=>{
      r._rowIdx=i+2;
      newByIdx.set(r._rowIdx,r);
    });

    // Sanity check: a sheet that previously had roads but now parses to zero
    // valid rows almost always means a broken/renamed header (e.g. the
    // "Street" column header got cleared or retyped) rather than a genuine
    // "no roads" state. The checksum can't catch this on its own since it's
    // built only from status counts, so flag it loudly instead of quietly
    // accepting an empty dataset.
    if(newByIdx.size===0 && rows.length>0) {
      showError("Sheet returned 0 valid roads out of "+rows.length+" rows — check that the 'Street' column header is intact.");
    }

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
        if(updated.Status!==existing.Status){existing.Status=updated.Status;rowChanged=true;clearMyPending(existing._rowIdx);}
        if((updated.partial_geometry||"-")!==(existing.partial_geometry||"-")){existing.partial_geometry=updated.partial_geometry;rowChanged=true;}
        if(rowChanged) {
          invalidateRowLayers(existing._rowIdx);
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
      // Runs every cycle regardless of whether Data changed — a denial
      // never moves the checksum, so this is the only thing that catches it.
      // Not awaited: it's a secondary concern that shouldn't delay the
      // sync-state UI, and it re-renders on its own once it resolves.
      reconcileMyPending();
    } catch(err) {
      // Distinguish "no signal" from a genuine server/CORS error — common
      // out on a leafleting round, and not worth an alarming red dot or an
      // error banner every 15 minutes while walking through a dead spot.
      if(!navigator.onLine) setSyncState("stale","Offline · showing cached data");
      else {
        setSyncState("error","Check failed · "+formatTime(lastLoadTime));
        if(isManual) showError("Refresh failed: "+err.message);
      }
    } finally{isChecking=false;schedulePoll();}
  }
  function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(()=>checkForUpdates(false),POLL_INTERVAL_MS);}
  function manualRefresh(){clearTimeout(pollTimer);checkForUpdates(true);}
  // Reconnecting mid-round shouldn't require a manual tap to pick up any
  // status changes made by other editors while signal was down.
  window.addEventListener("online",()=>{ if(!isChecking) checkForUpdates(false); });

  // ── Force full reload ─────────────────────────────────────────────────────────
  // Bypasses the checksum entirely and forces a from-scratch rebuild of
  // allRoads/layers, regardless of whether Status/Residence counts (the only
  // things the checksum tracks) have changed. Needed because a change to
  // geometry, headers, or any other column can silently break rendering
  // without ever moving the checksum — see ingestRows' isFirstLoad branch,
  // which is the only path that does a full rebuild rather than a diff.
  async function forceFullReload() {
    if(isChecking) return;
    isChecking=true;
    clearTimeout(pollTimer);
    setSyncState("checking","Force reloading…");
    document.getElementById("loading-msg").textContent="Reloading road data…";
    document.getElementById("loading").classList.remove("hidden");
    try {
      clearCache();
      lastChecksum=null; // guarantees ingestRows takes the isFirstLoad=true path below
      const cs=await fetchChecksum().catch(()=>null);
      const text=await fetchCSVText(SHEET_CSV_URL);
      const rows=await parseCSVRows(text);
      if(!rows.length) throw new Error("No data rows found.");
      ingestRows(rows,cs,new Date(),true);
      saveToCache(rows,cs);
    } catch(err) {
      setSyncState("error","Force reload failed");
      showError("Force reload failed: "+err.message);
    } finally {
      document.getElementById("loading").classList.add("hidden");
      isChecking=false;
      schedulePoll();
    }
  }

  function handleSyncBarClick(e) {
    if(e && e.shiftKey) forceFullReload();
    else manualRefresh();
  }

  // Mobile: long-press on the sync bar triggers the same force reload, since
  // shift-click has no touch equivalent. 600ms threshold avoids firing on a
  // normal tap; a short haptic buzz (where supported) confirms it fired.
  (function setupLongPress() {
    const syncBar=document.getElementById("sync-bar");
    if(!syncBar) return;
    let pressTimer=null;
    let firedByLongPress=false;

    syncBar.addEventListener("touchstart",()=>{
      firedByLongPress=false;
      pressTimer=setTimeout(()=>{
        firedByLongPress=true;
        if(navigator.vibrate) navigator.vibrate(30);
        forceFullReload();
      },600);
    },{passive:true});

    ["touchend","touchmove","touchcancel"].forEach(evt=>{
      syncBar.addEventListener(evt,()=>{ clearTimeout(pressTimer); });
    });

    // Prevent the touchend from also firing a synthetic click (which would
    // otherwise trigger manualRefresh() right after forceFullReload()).
    syncBar.addEventListener("touchend",(e)=>{
      if(firedByLongPress) e.preventDefault();
    });
  })();

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

  function applyFadeOpacity(opac) {
    fadeCurrent = opac;
    renderedLayers.forEach(entry => {
      if(!entry.spec || entry.spec.isSel) return;
      if(!selectedRoadName) return;
      entry.layers.forEach(l => {
        if(!l.setStyle) return;
        if(l.options.color === "transparent" || l.options.color === "#fff") return;
        if(l.setRadius) {
          l.setStyle({ opacity: opac, fillOpacity: opac * (0.8 / 0.15) > 0.8 ? 0.8 : opac * (0.8 / 0.15) });
        } else {
          l.setStyle({ opacity: opac });
        }
      });
    });
  }

  function activateRoad(road) {
    if(fadeAnimFrame) { cancelAnimationFrame(fadeAnimFrame); fadeAnimFrame=null; }
    if(fadeTimer)     { clearTimeout(fadeTimer); fadeTimer=null; }

    selectedRoadName=road.name;
    fadeCurrent=0.05;

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
    if(pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1),{maxZoom:17});
    if(isMobile()) closeSidebar();

    fadeCurrent = 0.05;
    renderLines();

    const FADE_DURATION = 4000;
    const fadeStart = performance.now();

    function fadeUpStep(now) {
      const t = Math.min(1, (now - fadeStart) / FADE_DURATION);
      const opac = 0.05 + (0.85 - 0.05) * t;
      applyFadeOpacity(opac);
      if(t < 1) {
        fadeAnimFrame = requestAnimationFrame(fadeUpStep);
      } else {
        fadeAnimFrame = null;
        fadeCurrent = 0.85;
        selectedRoadName = null;
        renderLines();
      }
    }
    fadeAnimFrame = requestAnimationFrame(fadeUpStep);
  }

  function clearSelection(){
    if(fadeAnimFrame) { cancelAnimationFrame(fadeAnimFrame); fadeAnimFrame=null; }
    if(fadeTimer)     { clearTimeout(fadeTimer); fadeTimer=null; }
    if(!selectedRoadName) return;
    selectedRoadName=null;
    fadeCurrent=0.85;
    renderLines();
  }
  function closeDropdown(){document.getElementById("road-dropdown").classList.remove("open");dropdownFocusIdx=-1;}
  function clearRoadSearch(){document.getElementById("road-search-input").value="";document.getElementById("road-search-clear").style.display="none";clearSelection();closeDropdown();}

  // ── Sidebar helpers (mobile) ─────────────────────────────────────────────────
  function isMobile() { return window.innerWidth <= 640; }
  function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); }
  function openSidebar()  { document.getElementById("sidebar").classList.add("open"); }
  let lastSidebarToggleTime = 0;
  function toggleSidebar(e){
    if(e){ e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation) e.stopImmediatePropagation(); }
    // Guard against the mobile "ghost click" some browsers fire ~250-350ms after
    // a touchend at the same screen coordinates. Without this, a single tap on
    // the hamburger button could open the sidebar and then immediately receive
    // a second synthetic click on the same still-in-place button, closing it
    // again before the person ever sees it open.
    const now = Date.now();
    if(now - lastSidebarToggleTime < 400) return;
    lastSidebarToggleTime = now;
    document.getElementById("sidebar").classList.toggle("open");
  }

  map.on("click",e=>{
    if(drawState) { handleDrawClick(e); return; }
    clearSelection();
    // Skip auto-closing if this click landed within the ghost-click guard
    // window of a sidebar toggle — avoids the same double-fire re-closing
    // a sidebar that was just opened.
    if(isMobile() && Date.now()-lastSidebarToggleTime>400) closeSidebar();
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
    // Anyone signed in and not banned can open the picker — showStatusPicker
    // itself decides whether that's a direct save (authorised editors) or a
    // suggestion that goes to the review queue (everyone else).
    if(tokenIsValid()&&authBanned) showEditMsg(editDiv,"This Google account isn't permitted to submit changes.","error");
    else if(tokenIsValid()) showStatusPicker(editDiv,rowRef);
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
      authEmail=data.email||emailHint; authExpiry=Date.now()+55*60*1000;
      authAuthorised = DISABLE_AUTH_CHECK ? true : (data.authorised===true);
      authBanned = DISABLE_AUTH_CHECK ? false : (data.banned===true);
      refreshPendingVisibility(); // any road showing someone else's pending preview reverts; MY own reappears
      if(authBanned){
        if(editDiv) showEditMsg(editDiv,"This Google account isn't permitted to submit changes.","error");
        return;
      }
      if(cookieConsent()==="accepted") persistAuthSession();
      else if(!cookieConsent()) showCookieBanner();
      // Admin panels (editor history / pending review) stay hidden in demo
      // mode even though everyone counts as "authorised" — a public demo is
      // not the place to expose controls that affect other people's edits.
      if(authAuthorised && !DISABLE_AUTH_CHECK) { document.getElementById("admin-panel-section").style.display=""; refreshPendingCount(); }
      if(pendingEdit){showStatusPicker(pendingEdit.editDiv,pendingEdit.rowRef);pendingEdit=null;}
    }catch(e){if(editDiv)showEditMsg(editDiv,"Network error: "+e.message,"error");}
  }

  function showStatusPicker(editDiv,rowRef) {
    const row=allRoads.find(r=>r._rowIdx===rowRef.rowIdx);
    const current=statusKey(row?.Status||"");
    const hasPartial=row&&(row.partial_geometry||"-")!=="-";
    const isInProgress=current==="inprogress";
    const hasGeom=row&&parseWKT(row.road_geometry).length>0;
    const myPending=myPendingFor(rowRef.rowIdx);
    const pendingNote=(!authAuthorised&&myPending&&myPending.field==="status")
      ? `<div class="popup-auth-msg" style="color:var(--yellow);">⏳ Your suggested change to "${escHtml(getStatus(myPending.value).label)}" is awaiting review.</div>`
      : "";
    editDiv.innerHTML=`
      <div class="popup-user-line">
        <span>✓ ${escHtml(authEmail)}</span>
        <button class="popup-signout-link" onclick="signOut()">↩ sign out</button>
      </div>
      ${authAuthorised?"":`<div class="popup-auth-msg">Not an authorised editor — changes you pick here go to a reviewer instead of saving directly.</div>`}
      ${pendingNote}
      <div class="popup-status-select">
        ${STATUSES.map(s=>`
          <button class="popup-status-option ${s.cls}${s.key===current?" current":""}"
            data-row="${rowRef.rowIdx}" data-sheet-value="${s.sheetValue}">
            ${s.label}${s.key===current?" ✓":""}
          </button>`).join("")}
      </div>
      ${authAuthorised&&isInProgress&&hasGeom?`
      <button class="popup-partial-btn${hasPartial?" has-data":""}" onclick="openPartialEditor(${rowRef.rowIdx})">
        ✏ ${hasPartial?"Edit":"Add"} partial completion
      </button>`:""}
    `;
    editDiv.querySelectorAll(".popup-status-option:not(.current)").forEach(btn=>{
      btn.addEventListener("click",function(){
        const rIdx=parseInt(this.dataset.row,10), sv=this.dataset.sheetValue;
        if(authAuthorised) submitStatusChange(rIdx,sv,this);
        else submitProposedStatus(rIdx,sv,this);
      });
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
        invalidateRowLayers(rowIdx);
        renderLines(); updateStats(); updateCountBadges();
        recomputeAndSaveChecksum();
      }
      showEditMsg(editDiv,`Saved as "${getStatus(sheetValue).label}"`,"success");
      setTimeout(()=>{if(editDiv)editDiv.style.display="none";},1800);
    }catch(e){showEditMsg(editDiv,"Network error: "+e.message,"error");}
  }

  // For unauthorised-but-verified users: writes to the Pending sheet only —
  // Data is untouched until an editor approves it. Rendered as a live local
  // preview via myPendingByRow/effectiveStatus so the road shows the
  // suggested colour to the person who suggested it, without affecting
  // anyone else's view or the shared checksum-synced data.
  async function submitProposedStatus(rowIdx,sheetValue,btn) {
    const editDiv=btn.closest(".popup-edit-area");
    editDiv.innerHTML=`<div class="popup-saving">Submitting…</div>`;
    try{
      const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
      const data=await(await fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"propose",field:"status",rowIndex:rowIdx,newStatus:sheetValue,...tp})})).json();
      if(!data.ok){showEditMsg(editDiv,data.error||"Submit failed.","error");return;}
      setMyPending(rowIdx,"status",sheetValue);
      invalidateRowLayers(rowIdx);
      renderLines(); updateStats(); updateCountBadges();
      showEditMsg(editDiv,`Suggested "${getStatus(sheetValue).label}" — awaiting review`,"success");
      setTimeout(()=>{if(editDiv)editDiv.style.display="none";},1800);
    }catch(e){showEditMsg(editDiv,"Network error: "+e.message,"error");}
  }

  function signOut() {
    authToken=null;authTokenType="idToken";authEmail=null;authExpiry=0;authAuthorised=false;authBanned=false;
    localStorage.removeItem(LS_AUTH);
    if(typeof google!=="undefined"&&google.accounts) google.accounts.id.disableAutoSelect();
    document.querySelectorAll(".popup-edit-area").forEach(el=>el.style.display="none");
    document.getElementById("admin-panel-section").style.display="none";
    refreshPendingVisibility(); // any road showing MY pending preview reverts to its real status
  }

  // ── Admin panel ───────────────────────────────────────────────────────────────
  function openAdminPanel() {
    if(!tokenIsValid()||!authAuthorised) {
      showError("Sign in first to access the editor history panel.");
      return;
    }
    renderAdminModal("loading");
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"history",...tp})})
      .then(r=>r.json())
      .then(data=>{
        if(!data.ok) { renderAdminModal("error", data.error||"Failed to load history"); return; }
        renderAdminModal("list", null, data.editors);
      })
      .catch(e=>renderAdminModal("error", "Network error: "+e.message));
  }

  function renderAdminModal(state, errorMsg, editors) {
    const overlay = document.getElementById("admin-modal-overlay");
    overlay.style.cssText = "display:flex;position:absolute;inset:0;z-index:3000;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);";

    let inner = "";
    if(state==="loading") {
      inner = `<div class="spinner" style="margin:0 auto 12px;"></div><p style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted);text-align:center;">Loading editor history…</p>`;
    } else if(state==="error") {
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--red);margin-bottom:12px;">⚠ ${escHtml(errorMsg)}</div>
        <button class="popup-partial-action-btn" id="admin-close-btn">Close</button>`;
    } else if(state==="list") {
      const rows = editors.length
        ? editors.map((e,i)=>`
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:5px;background:rgba(255,255,255,0.03);border:1px solid var(--border);margin-bottom:4px;">
              <div>
                <div style="font-size:12px;color:var(--text);">${escHtml(e.editor)}</div>
                <div style="font-size:10px;color:var(--muted);font-family:'DM Mono',monospace;">${e.standingChanges} standing change${e.standingChanges!==1?"s":""}</div>
              </div>
              <button class="popup-partial-action-btn danger" data-revert-idx="${i}">Revert all</button>
            </div>`).join("")
        : `<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px 0;">No editor history on record yet.</div>`;
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:10px;letter-spacing:0.08em;text-transform:uppercase;">Editor history</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5;">Standing changes are edits still showing as the current value. Reverting erases that editor's entire standing history.</div>
        <div id="admin-editor-list" style="margin-bottom:12px;">${rows}</div>
        <button class="popup-partial-action-btn" id="admin-close-btn">Close</button>`;
    } else if(state==="confirm") {
      const targetEmail = errorMsg;
      const count = editors;
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--red);margin-bottom:10px;letter-spacing:0.08em;text-transform:uppercase;">⚠ Confirm revert</div>
        <div style="font-size:12px;color:var(--text);margin-bottom:4px;">You are about to revert <strong>${escHtml(targetEmail)}</strong>'s ${count} standing change${count!==1?"s":""} across all roads.</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5;">Type their email address below to confirm. This action will itself be logged and can be reverted.</div>
        <input id="admin-confirm-input" type="text" placeholder="${escHtml(targetEmail)}"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:'DM Mono',monospace;font-size:12px;padding:7px 10px;outline:none;margin-bottom:10px;">
        <div style="display:flex;gap:8px;">
          <button class="popup-partial-action-btn danger" id="admin-confirm-btn" disabled>Revert all</button>
          <button class="popup-partial-action-btn" id="admin-back-btn">← Back</button>
        </div>
        <div id="admin-confirm-status" style="font-size:10px;color:var(--muted);font-family:'DM Mono',monospace;margin-top:8px;"></div>`;
    } else if(state==="done") {
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--green);margin-bottom:12px;">✓ Revert complete</div>
        <div style="font-size:12px;color:var(--text);margin-bottom:12px;">${escHtml(errorMsg)}</div>
        <div style="display:flex;gap:8px;">
          <button class="popup-partial-action-btn" id="admin-back-btn">← Back to history</button>
          <button class="popup-partial-action-btn" id="admin-close-btn">Close</button>
        </div>`;
    }

    overlay.innerHTML = `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;width:min(420px,90vw);max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.6);">
        ${inner}
      </div>`;

    // Wired up here (rather than inline onclick="...") so editor emails —
    // which come from Google Sign-In and could in principle contain a quote
    // character — can never break out of an HTML attribute into executable
    // JS. escHtml() only escapes &<>", not ', which made the old inline
    // onclick="fn('${email}')" pattern unsafe.
    const closeBtn = overlay.querySelector("#admin-close-btn");
    if(closeBtn) closeBtn.addEventListener("click", closeAdminModal);
    const backBtn = overlay.querySelector("#admin-back-btn");
    if(backBtn) backBtn.addEventListener("click", openAdminPanel);

    if(state==="list") {
      overlay.querySelectorAll("[data-revert-idx]").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          const e = editors[parseInt(btn.dataset.revertIdx, 10)];
          adminConfirmRevert(e.editor, e.standingChanges);
        });
      });
    } else if(state==="confirm") {
      const targetEmail = errorMsg;
      const input = overlay.querySelector("#admin-confirm-input");
      const confirmBtn = overlay.querySelector("#admin-confirm-btn");
      input.addEventListener("input", ()=>{
        confirmBtn.disabled = input.value.trim().toLowerCase() !== targetEmail;
      });
      confirmBtn.addEventListener("click", ()=>adminExecuteRevert(targetEmail));
    }
  }

  // ── Nearest-ward lookup (point-to-nearest-geometry, not ward centroid) ───────
  // We don't have ward boundary polygons at runtime — only per-road geometry.
  // Averaging distance to every point in a ward (the old approach) biases
  // toward whichever ward's roads happen to be clustered nearest you overall,
  // which is why it could place you in an adjacent ward. Instead, this finds
  // the single closest point on the single closest road anywhere in the
  // dataset and uses THAT road's ward — a much better proxy for "which ward
  // am I standing in", since a road right next to you on the correct side of
  // a boundary will always beat roads in a neighbouring ward that are merely
  // clustered further away on average.
  function findNearestWardToPoint(lat, lon) {
    if(!allRoads.length) return null;
    const clickPt = turf.point([lon, lat]);

    // Phase 1 — cheap coarse pass: rank roads by squared-degree distance from
    // the user to a single representative point (marker coords, or first
    // vertex of the road geometry), and keep only the closest handful.
    const candidates = [];
    allRoads.forEach(r => {
      const segs = parseWKT(r.road_geometry);
      let approxLat = parseFloat(r["@lat"]);
      let approxLon = parseFloat(r["@lon"]);
      if((isNaN(approxLat) || isNaN(approxLon)) && segs.length) {
        approxLat = segs[0][0][0];
        approxLon = segs[0][0][1];
      }
      if(isNaN(approxLat) || isNaN(approxLon)) return;
      const dLat = approxLat - lat, dLon = approxLon - lon;
      candidates.push({ road: r, segs, approxDistSq: dLat*dLat + dLon*dLon });
    });
    if(!candidates.length) return null;
    candidates.sort((a,b) => a.approxDistSq - b.approxDistSq);
    const shortlist = candidates.slice(0, 60);

    // Phase 2 — precise pass: for the shortlisted roads, measure the true
    // nearest-point-on-line distance (in metres) along their full geometry.
    let bestWard = null, bestDist = Infinity;
    shortlist.forEach(c => {
      let dMin = Infinity;
      if(c.segs.length) {
        c.segs.forEach(pts => {
          for(let i = 1; i < pts.length; i++) {
            const a = [pts[i-1][1], pts[i-1][0]];
            const b = [pts[i][1],   pts[i][0]];
            try {
              const line = turf.lineString([a, b]);
              const snapped = turf.nearestPointOnLine(line, clickPt, {units:"meters"});
              if(snapped.properties.dist < dMin) dMin = snapped.properties.dist;
            } catch(e) { /* degenerate segment, skip */ }
          }
        });
      } else {
        const rlat = parseFloat(c.road["@lat"]), rlon = parseFloat(c.road["@lon"]);
        if(!isNaN(rlat) && !isNaN(rlon)) dMin = turf.distance(clickPt, turf.point([rlon, rlat]), {units:"meters"});
      }
      if(dMin < bestDist) { bestDist = dMin; bestWard = (c.road.Ward || "Unknown").trim(); }
    });

    return bestWard ? { ward: bestWard, distMeters: bestDist } : null;
  }

  // ── GPS Ward Locator ──────────────────────────────────────────────────────────
  let gpsMarker = null;
  let liveTrackWatchId  = null;
  let liveTrackMarker   = null;
  let liveTrackAccuracy = null;
  let liveTrackCentered = false;

  function locateAndFilterWard() {
    const btn = document.getElementById("gps-locate-btn");
    if(!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    btn.textContent = "⊕ Locating…";
    btn.style.opacity = "0.6";
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        // Find the ward whose nearest mapped road is actually closest to
        // where you are standing, rather than the ward whose roads are on
        // average nearest overall.
        const nearest = findNearestWardToPoint(lat, lon);
        const bestWard = nearest ? nearest.ward : null;

        if(bestWard) {
          Object.keys(wardCounts).forEach(w => {
            if(w === bestWard) activeWards.add(w);
            else activeWards.delete(w);
          });
          buildWardList(document.querySelector(".ward-search").value);
          renderLines();
          updateStats();
        }

        if(gpsMarker) map.removeLayer(gpsMarker);
        gpsMarker = L.circleMarker([lat, lon], {
          radius: 8, color: "#fff", fillColor: "#4f8ef7",
          fillOpacity: 1, weight: 2, interactive: true
        }).addTo(map)
          .bindPopup(bestWard
            ? `<div class="popup-street">You are here</div><div class="popup-ward">${escHtml(bestWard)}</div>`
            : `<div class="popup-street">You are here</div>`)
          .openPopup();

        map.setView([lat, lon], Math.max(map.getZoom(), 14));
        if(isMobile()) closeSidebar();

        btn.textContent = bestWard ? `⊕ ${bestWard}` : "⊕ Find my ward";
        btn.style.opacity = "1";
        btn.disabled = false;
      },
      err => {
        btn.textContent = "⊕ Find my ward";
        btn.style.opacity = "1";
        btn.disabled = false;
        const msgs = {
          1: "Location access denied — please allow location in your browser settings.",
          2: "Location unavailable — check your signal and try again.",
          3: "Location request timed out — try again."
        };
        showError(msgs[err.code] || "Location error: " + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  // ── Live location tracking ───────────────────────────────────────────────────
  function toggleLiveTracking() {
    if(liveTrackWatchId !== null) { stopLiveTracking(); return; }
    if(!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    const btn = document.getElementById("live-track-btn");
    btn.textContent = "◉ Live tracking: Starting…";
    liveTrackCentered = false;

    liveTrackWatchId = navigator.geolocation.watchPosition(
      pos => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const acc = pos.coords.accuracy;

        if(!liveTrackMarker) {
          liveTrackMarker = L.circleMarker([lat, lon], {
            radius: 8, color: "#fff", fillColor: "#4f8ef7",
            fillOpacity: 1, weight: 2, interactive: false
          }).addTo(map);
        } else {
          liveTrackMarker.setLatLng([lat, lon]);
        }

        if(acc && !isNaN(acc)) {
          if(!liveTrackAccuracy) {
            liveTrackAccuracy = L.circle([lat, lon], {
              radius: acc, color: "#4f8ef7", weight: 1, opacity: 0.4,
              fillColor: "#4f8ef7", fillOpacity: 0.1, interactive: false
            }).addTo(map);
          } else {
            liveTrackAccuracy.setLatLng([lat, lon]);
            liveTrackAccuracy.setRadius(acc);
          }
        }

        // Only auto-centre on the first fix so we don't yank the map around
        // under someone who has panned off to look at something else.
        if(!liveTrackCentered) {
          map.setView([lat, lon], Math.max(map.getZoom(), 15));
          liveTrackCentered = true;
        }

        btn.textContent = "◉ Live tracking: On";
        btn.style.background = "rgba(79,142,247,0.15)";
      },
      err => {
        const msgs = {
          1: "Location access denied — please allow location in your browser settings.",
          2: "Location unavailable — check your signal and try again.",
          3: "Location request timed out — try again."
        };
        showError(msgs[err.code] || "Location error: " + err.message);
        stopLiveTracking();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function stopLiveTracking() {
    if(liveTrackWatchId !== null) {
      navigator.geolocation.clearWatch(liveTrackWatchId);
      liveTrackWatchId = null;
    }
    if(liveTrackMarker)   { map.removeLayer(liveTrackMarker);   liveTrackMarker = null; }
    if(liveTrackAccuracy) { map.removeLayer(liveTrackAccuracy); liveTrackAccuracy = null; }
    const btn = document.getElementById("live-track-btn");
    if(btn) { btn.textContent = "◉ Live tracking: Off"; btn.style.background = ""; }
  }

  function closeAdminModal() {
    const overlay = document.getElementById("admin-modal-overlay");
    overlay.style.display = "none";
    overlay.innerHTML = "";
  }

  function adminConfirmRevert(targetEmail, count) {
    renderAdminModal("confirm", targetEmail, count);
  }

  function adminExecuteRevert(targetEmail) {
    const statusEl = document.getElementById("admin-confirm-status");
    const btn = document.getElementById("admin-confirm-btn");
    if(statusEl) statusEl.textContent = "Reverting…";
    if(btn) btn.disabled = true;
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"revert",targetEditor:targetEmail,...tp})})
      .then(r=>r.json())
      .then(data=>{
        if(!data.ok) {
          if(statusEl) statusEl.textContent = "Error: "+(data.error||"Unknown error");
          if(btn) btn.disabled=false;
          return;
        }
        lastChecksum=null;
        const summary=`Reverted ${data.revertedCount} change${data.revertedCount!==1?"s":""} across roads.`
          +(data.skippedCount?` ${data.skippedCount} already overwritten by others — left untouched.`:"");
        renderAdminModal("done", summary);
        checkForUpdates(false);
      })
      .catch(e=>{
        if(statusEl) statusEl.textContent="Network error: "+e.message;
        if(btn) btn.disabled=false;
      });
  }

  // ── Pending changes panel (review queue for unauthorised proposals) ────────────
  function updatePendingCountBadge(n) {
    const el=document.getElementById("pending-count");
    if(el) el.textContent=n>0?String(n):"";
  }
  // Fetches just the count so the sidebar badge can show "there's stuff to
  // review" without requiring the editor to open the panel first.
  function refreshPendingCount() {
    if(!tokenIsValid()||!authAuthorised||DISABLE_AUTH_CHECK) return;
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"pendingList",...tp})})
      .then(r=>r.json())
      .then(data=>{ if(data.ok) updatePendingCountBadge(data.items.length); })
      .catch(()=>{});
  }

  function openPendingPanel() {
    if(!tokenIsValid()||!authAuthorised) {
      showError("Sign in first to access pending changes.");
      return;
    }
    renderPendingModal("loading");
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"pendingList",...tp})})
      .then(r=>r.json())
      .then(data=>{
        if(!data.ok){renderPendingModal("error",data.error||"Failed to load pending changes");return;}
        updatePendingCountBadge(data.items.length);
        renderPendingModal("list",null,data.items);
      })
      .catch(e=>renderPendingModal("error","Network error: "+e.message));
  }

  function renderPendingModal(state, errorMsg, items) {
    const overlay = document.getElementById("admin-modal-overlay");
    overlay.style.cssText = "display:flex;position:absolute;inset:0;z-index:3000;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);";

    let inner = "";
    if(state==="loading") {
      inner = `<div class="spinner" style="margin:0 auto 12px;"></div><p style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted);text-align:center;">Loading pending changes…</p>`;
    } else if(state==="error") {
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--red);margin-bottom:12px;">⚠ ${escHtml(errorMsg)}</div>
        <button class="popup-partial-action-btn" id="pending-close-btn">Close</button>`;
    } else if(state==="list") {
      const rows = items.length
        ? items.map((it,i)=>{
            const fieldLabel = it.field==="status" ? "Status" : "Partial completion";
            const oldLabel = it.field==="status" ? escHtml(getStatus(it.oldValue).label) : escHtml(String(it.oldValue||"-"));
            const newLabel = it.field==="status" ? escHtml(getStatus(it.proposedValue).label) : escHtml(String(it.proposedValue||"-"));
            return `
              <div style="padding:8px 10px;border-radius:5px;background:rgba(255,255,255,0.03);border:1px solid var(--border);margin-bottom:6px;">
                <div style="font-size:12px;color:var(--text);font-weight:500;">${escHtml(it.street)}</div>
                <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">${escHtml(it.ward)} · ${fieldLabel}</div>
                <div style="font-size:11px;color:var(--text);margin-bottom:4px;">${oldLabel} → <strong>${newLabel}</strong></div>
                <div style="font-size:10px;color:var(--muted);font-family:'DM Mono',monospace;margin-bottom:6px;">by ${escHtml(it.submitter)}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="popup-partial-action-btn active" style="border-color:var(--darkgreen);color:#4ecb82;" data-approve-idx="${i}">✓ Approve</button>
                  <button class="popup-partial-action-btn" data-deny-idx="${i}">✕ Deny</button>
                  <button class="popup-partial-action-btn danger" data-ban-idx="${i}">⛔ Ban submitter</button>
                </div>
              </div>`;
          }).join("")
        : `<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px 0;">No pending changes to review.</div>`;
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:10px;letter-spacing:0.08em;text-transform:uppercase;">Pending changes</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5;">Suggestions from signed-in but unauthorised visitors. Approve applies the change and logs it under the submitter's name; deny discards it — Data is untouched either way until you approve.</div>
        <div id="pending-item-list" style="margin-bottom:12px;max-height:50vh;overflow-y:auto;">${rows}</div>
        <button class="popup-partial-action-btn" id="pending-close-btn">Close</button>`;
    } else if(state==="done") {
      inner = `
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--green);margin-bottom:12px;">✓ ${escHtml(errorMsg)}</div>
        <div style="display:flex;gap:8px;">
          <button class="popup-partial-action-btn" id="pending-back-btn">← Back to list</button>
          <button class="popup-partial-action-btn" id="pending-close-btn">Close</button>
        </div>`;
    }

    overlay.innerHTML = `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;width:min(460px,90vw);max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.6);">
        ${inner}
      </div>`;

    const closeBtn = overlay.querySelector("#pending-close-btn");
    if(closeBtn) closeBtn.addEventListener("click", closeAdminModal);
    const backBtn = overlay.querySelector("#pending-back-btn");
    if(backBtn) backBtn.addEventListener("click", openPendingPanel);

    if(state==="list") {
      overlay.querySelectorAll("[data-approve-idx]").forEach(btn=>{
        btn.addEventListener("click",()=>reviewPendingItem(items[parseInt(btn.dataset.approveIdx,10)],"approve"));
      });
      overlay.querySelectorAll("[data-deny-idx]").forEach(btn=>{
        btn.addEventListener("click",()=>reviewPendingItem(items[parseInt(btn.dataset.denyIdx,10)],"deny"));
      });
      overlay.querySelectorAll("[data-ban-idx]").forEach(btn=>{
        btn.addEventListener("click",()=>banPendingSubmitter(items[parseInt(btn.dataset.banIdx,10)]));
      });
    }
  }

  function reviewPendingItem(item, decision) {
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"pendingReview",pendingRow:item.pendingRow,decision,...tp})})
      .then(r=>r.json())
      .then(data=>{
        if(!data.ok){showError(data.error||"Review failed.");return;}
        if(decision==="approve") {
          // The backend only ever returns ok:true for an approve once it has
          // re-read the cell, in the same execution, and confirmed the write
          // actually landed — so it's safe to trust data.appliedValue here
          // without a second guess; an unconfirmed write comes back as
          // ok:false instead (handled above) and is left retryable rather
          // than silently marked reviewed.
          if(data.field==="status") {
            const row=allRoads.find(r=>r._rowIdx===data.rowIndex);
            if(row) { row.Status=data.appliedValue; invalidateRowLayers(data.rowIndex); renderLines(); updateStats(); updateCountBadges(); }
          }
          // NOT lastChecksum=null + checkForUpdates: that forces an
          // immediate reload from the published CSV, which is on its own
          // separate publish-to-web lag and — because a null lastChecksum
          // makes loadFullSheet treat it as a first load — a still-stale
          // fetch would completely rebuild allRoads from scratch, silently
          // overwriting the confirmed patch just applied above. Instead,
          // recompute what the checksum SHOULD become from allRoads as it
          // now stands (same thing a direct edit already does) and save
          // that as lastChecksum — so the next scheduled poll only reloads
          // once the CSV has genuinely caught up, never before.
          recomputeAndSaveChecksum();
          // Covers the reviewer-was-also-the-submitter case (same browser
          // proposed and then approved its own suggestion): clears their
          // local pending badge/override now that it's genuinely resolved,
          // rather than leaving it displayed via the pending override.
          reconcileMyPending();
        } else {
          // Deny never changes Data, so nothing above would catch it —
          // reconcile directly so a same-browser submitter/reviewer (e.g.
          // while testing) sees their preview clear immediately rather than
          // waiting for the next scheduled poll.
          reconcileMyPending();
        }
        openPendingPanel();
      })
      .catch(e=>showError("Network error: "+e.message));
  }

  function banPendingSubmitter(item) {
    if(!confirm(`Ban ${item.submitter} from submitting further changes? Their other pending submissions will be denied too.`)) return;
    const tp=authTokenType==="idToken"?{idToken:authToken}:{accessToken:authToken};
    fetch(APPS_SCRIPT_URL,{method:"POST",body:JSON.stringify({action:"ban",targetEmail:item.submitter,...tp})})
      .then(r=>r.json())
      .then(data=>{
        if(!data.ok){showError(data.error||"Ban failed.");return;}
        openPendingPanel();
      })
      .catch(e=>showError("Network error: "+e.message));
  }

  // ── Partial editor ────────────────────────────────────────────────────────────
  function openPartialEditor(rowIdx) {
    const row=allRoads.find(r=>r._rowIdx===rowIdx);
    if(!row) return;
    const geomData=getRoadGeomData(row);
    if(!geomData) return;
    map.closePopup();
    enterDrawMode(row, geomData);
  }

  function setDrawHint(msg) {
    const el=document.getElementById("draw-hint");
    if(msg){el.textContent=msg;el.classList.add("visible");}
    else{el.classList.remove("visible");}
  }

  function setLayersInteractive(interactive) {
    renderedLayers.forEach(entry=>{
      entry.layers.forEach(l=>{
        if(l.options&&l.options.weight===20) {
          l.options.interactive=interactive;
          if(l._path) l._path.style.pointerEvents=interactive?"visiblePainted":"none";
        }
      });
    });
  }

  function enterDrawMode(road, geomData) {
    drawState="place-start";
    drawRoad=road;
    drawStart=null;
    drawEnd=null;
    drawBothSides=false;
    drawFlipped=false;
    drawActiveHandle=null;

    setLayersInteractive(false);

    drawRoadHighlightLayers.forEach(l=>partialLayerGroup.removeLayer(l));
    drawRoadHighlightLayers=[];
    // Use sortedSegs for the visual highlight glow only — purely cosmetic
    geomData.sortedSegs.forEach(seg=>{
      const hl=L.polyline(seg,{color:"#fff",weight:10,opacity:0.2,interactive:false});
      hl.addTo(partialLayerGroup); drawRoadHighlightLayers.push(hl);
    });

    document.getElementById("map").classList.add("draw-mode");
    setDrawHint("Tap road to place start point");

    const existing=parsePartialGeom(road.partial_geometry||"");
    if(existing.length) {
      setDrawHint(`${existing.length} existing section(s) — tap road to add another, or Save with no selection to keep as-is, or Clear All to remove`);
    }
  }

  function exitDrawMode() {
    drawState=null; drawRoad=null; drawStart=null; drawEnd=null;
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

    const snapped = snapToNearestSegment(e.latlng, geomData.segs);

    if(drawState==="place-start") {
      drawStart=snapped;
      drawEnd=null;
      drawState="place-end";
      placeHandles(geomData);
      setDrawHint("Tap road to place end point");

    } else if(drawState==="place-end") {
      drawEnd=snapped;
      // Require a meaningful selection
      if(drawStart.segIdx===drawEnd.segIdx && Math.abs(drawEnd.t - drawStart.t) < 0.001) return;
      drawState="adjust";
      drawActiveHandle=null;
      placeHandles(geomData);
      updateDrawPreview(geomData);
      showDrawControls(geomData);
      setDrawHint("Drag a handle to fine-tune, or tap one then tap the road · Save when done");

    } else if(drawState==="adjust") {
      if(drawActiveHandle) {
        if(drawActiveHandle==="start") {
          drawStart=snapped;
        } else {
          drawEnd=snapped;
        }
        drawActiveHandle=null;
        placeHandles(geomData);
        updateDrawPreview(geomData);
        setDrawHint("Drag a handle to fine-tune, or tap one then tap the road · Save when done");
      }
    }
  }

  // Handles are draggable L.markers (divIcons) rather than circleMarkers —
  // circleMarker/Path layers don't support Leaflet's draggable option at
  // all, only L.Marker does. Dragging re-snaps to the road on every move so
  // the handle can never end up off the line. The old tap-handle-then-tap-
  // road flow still works too, for anyone who finds that easier on mobile.
  function makeDrawHandle(geomData, snap, fillColour, which) {
    const segPts = geomData.segs[snap.segIdx];
    const segCL  = geomData.segCumLens[snap.segIdx];
    const pt = interpolateAlongPts(segPts, segCL, snap.t);
    const marker = L.marker(pt, {
      icon: L.divIcon({
        className: "draw-handle-icon",
        html: `<div class="draw-handle-dot" style="background:${fillColour};"></div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
      }),
      draggable: true, autoPan: true, zIndexOffset: 1000
    });
    marker.on("click", e=>{
      L.DomEvent.stopPropagation(e);
      drawActiveHandle=which;
      setDrawHint(`Tap road to move ${which} point, or drag the handle`);
    });
    marker.on("drag", e=>{
      const snapped = snapToNearestSegment(e.target.getLatLng(), geomData.segs);
      marker.setLatLng(snapped.latlng);
      if(which==="start") drawStart=snapped; else drawEnd=snapped;
      updateDrawPreview(geomData);
    });
    marker.on("dragend", ()=>{
      drawActiveHandle=null;
      setDrawHint("Drag a handle to fine-tune, or tap one then tap the road · Save when done");
    });
    return marker;
  }

  function placeHandles(geomData) {
    if(drawHandleStart){partialLayerGroup.removeLayer(drawHandleStart);drawHandleStart=null;}
    if(drawHandleEnd  ){partialLayerGroup.removeLayer(drawHandleEnd);  drawHandleEnd=null;}

    if(drawStart) {
      drawHandleStart = makeDrawHandle(geomData, drawStart, PARTIAL_COLOUR, "start");
      drawHandleStart.addTo(partialLayerGroup);
    }
    if(drawEnd) {
      drawHandleEnd = makeDrawHandle(geomData, drawEnd, "#0a4a28", "end");
      drawHandleEnd.addTo(partialLayerGroup);
    }
  }

  function sortSegmentsTopologically(segs) {
    if (segs.length <= 1) return segs;
    function dist(a, b) { return Math.hypot(a[0]-b[0], a[1]-b[1]); }
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

  // Build the preview polyline(s) for the current draw selection.
  // Uses buildSegmentPath to traverse segments correctly.
  function updateDrawPreview(geomData) {
    drawPreviewLayers.forEach(l => partialLayerGroup.removeLayer(l));
    drawPreviewLayers = [];
    if (!drawStart || !drawEnd) return;

    const pathEntries = buildSegmentPath(geomData.segs, drawStart, drawEnd);
    if (!pathEntries.length) return;

    pathEntries.forEach(({segIdx, t0, t1}) => {
      const segPts = geomData.segs[segIdx];
      const segCL  = geomData.segCumLens[segIdx];
      if(!segPts || !segCL) return;

      const segTotal = segCL[segCL.length-1];
      const p0 = interpolateAlongPts(segPts, segCL, t0);
      const p1 = interpolateAlongPts(segPts, segCL, t1);
      let subset = [p0];
      segPts.forEach((p, i) => {
        const prop = segTotal > 0 ? segCL[i] / segTotal : 0;
        if(prop > t0 && prop < t1) subset.push(p);
      });
      subset.push(p1);
      if(subset.length < 2) return;

      let layer;
      if(drawBothSides) {
        layer = L.polyline(subset, {color:PARTIAL_COLOUR, weight:PARTIAL_WEIGHT_BOTH, opacity:0.85, interactive:false, dashArray:"8 4"});
      } else {
        const offsetPts = offsetPolyline(subset, drawFlipped ? -PARTIAL_OFFSET_M : PARTIAL_OFFSET_M);
        layer = L.polyline(offsetPts, {color:PARTIAL_COLOUR, weight:PARTIAL_WEIGHT_SINGLE, opacity:0.85, interactive:false, dashArray:"8 4"});
      }
      layer.addTo(partialLayerGroup);
      drawPreviewLayers.push(layer);
    });
  }

  function showDrawControls(geomData) {
    map.eachLayer(l=>{if(l._isDrawControls)map.removeLayer(l);});
    if(!drawStart||!drawEnd) return;

    // Place the popup at the geographic midpoint of the path
    const pathEntries = buildSegmentPath(geomData.segs, drawStart, drawEnd);
    let midPt = drawStart.latlng;
    if(pathEntries.length) {
      const mid = pathEntries[Math.floor(pathEntries.length/2)];
      const segPts = geomData.segs[mid.segIdx];
      const segCL  = geomData.segCumLens[mid.segIdx];
      midPt = interpolateAlongPts(segPts, segCL, (mid.t0+mid.t1)/2);
    }

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
      </div>
      <div class="popup-partial-status" id="draw-save-status"></div>
      ${hasExisting?`
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <button class="popup-partial-action-btn danger" id="draw-btn-clear" style="width:100%;">🗑 Clear all sections for this road</button>
      </div>`:""}
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
    content.querySelector("#draw-btn-cancel").addEventListener("click",()=>{exitDrawMode();map.closePopup();});
    // Clearing wipes every saved section for this road, not just the one
    // being drawn — moved off the Save/Cancel row and requires a second tap
    // within 4s (the button relabels itself while armed) so a mis-tap aimed
    // at Cancel can no longer destroy existing partial-completion data.
    const clearBtn=content.querySelector("#draw-btn-clear");
    if(clearBtn) {
      const clearLabel=clearBtn.textContent;
      let armed=false, armTimer=null;
      const disarm=()=>{armed=false;clearBtn.textContent=clearLabel;clearBtn.classList.remove("armed");};
      clearBtn.addEventListener("click",()=>{
        if(!armed) {
          armed=true;
          clearBtn.textContent="Tap again to confirm clearing";
          clearBtn.classList.add("armed");
          clearTimeout(armTimer);
          armTimer=setTimeout(disarm,4000);
          return;
        }
        clearTimeout(armTimer);
        disarm();
        clearPartialGeom(geomData,content.querySelector("#draw-save-status"));
      });
    }
  }

  async function savePartialGeom(geomData, statusEl) {
    if(!drawStart || !drawEnd) return;

    const pathEntries = buildSegmentPath(geomData.segs, drawStart, drawEnd);
    if(!pathEntries.length) {
      if((drawRoad.partial_geometry||"-")!=="-") {
        exitDrawMode(); map.closePopup(); renderAllPartials(); updateStats();
      } else {
        if(statusEl) statusEl.textContent="No section drawn — tap road to place points first.";
      }
      return;
    }

    const side = drawBothSides ? "B" : (drawFlipped ? "F" : "S");
    const newParts = pathEntries.map(e => ({segIdx: e.segIdx, t0: e.t0, t1: e.t1, side}));
    const existingParts = parsePartialGeom(drawRoad.partial_geometry||"");
    const allParts = [...existingParts, ...newParts];
    const encoded = encodePartialGeom(allParts);

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
      setTimeout(()=>{exitDrawMode();map.closePopup();renderAllPartials();updateStats();},1200);
    }catch(e){if(statusEl)statusEl.textContent="Network error: "+e.message;}
  }

  async function clearPartialGeom(geomData, statusEl) {
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
      setTimeout(()=>{exitDrawMode();map.closePopup();renderAllPartials();updateStats();},1200);
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
  window.forceFullReload = forceFullReload;
  window.handleSyncBarClick = handleSyncBarClick;
  window.popupEditClicked = popupEditClicked;
  window.triggerSignIn = triggerSignIn;
  window.signOut = signOut;
  window.openPartialEditor = openPartialEditor;
  window.cookieAccept = cookieAccept;
  window.cookieDecline = cookieDecline;
  window.showCookiePolicy = showCookiePolicy;
  window.openAdminPanel = openAdminPanel;
  window.closeAdminModal = closeAdminModal;
  window.adminConfirmRevert = adminConfirmRevert;
  window.adminExecuteRevert = adminExecuteRevert;
  window.openPendingPanel = openPendingPanel;
  window.locateAndFilterWard = locateAndFilterWard;
  window.toggleSidebar = toggleSidebar;
  window.toggleLiveTracking = toggleLiveTracking;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  (async function boot() {
    restoreAuthSession();
    loadMyPending();
    if(isMobile()) openSidebar();
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
