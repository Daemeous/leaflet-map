/* ============================================================================
   sw.js — Offline support for the Leafleting Map app.

   Caches the app shell (index.html/core.js/styles.css) and the third-party
   libraries it loads (Leaflet/PapaParse/Turf/fonts) so the app can boot with
   no signal — common when out walking a round. Also caches OSM map tiles as
   they're viewed, so previously-visited areas stay visible offline.

   Deliberately NEVER caches: the Google Sheets CSV endpoints, the Apps
   Script URL, or any Google auth endpoint. Road/status data and sign-in
   must always go to the network — core.js already has its own
   localStorage-based cache-and-poll logic for the data itself, keyed by
   checksum, and this service worker must not interfere with that by
   serving a stale response underneath it.

   Bump the CACHE_VERSION below whenever this file, index.html, core.js, or
   styles.css changes, so old caches get cleared out on the next visit.
   ============================================================================ */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `leafmap-shell-${CACHE_VERSION}`;
const LIB_CACHE   = `leafmap-libs-${CACHE_VERSION}`;
const TILE_CACHE  = `leafmap-tiles-${CACHE_VERSION}`;
const TILE_CACHE_MAX = 1000; // bounds on-disk growth from OSM tiles

// core.js/styles.css are deliberately NOT listed here — index.html loads
// them with a cache-busting "?v=N" query string that changes on every
// deploy, so a hardcoded entry here would go stale immediately and never
// match the real request anyway (cache lookups are exact-URL). They still
// end up cached: the very first request for whatever version is current
// falls through to the generic stale-while-revalidate handler below, same
// as any other same-origin GET.
// manifest.json isn't listed either — core.js generates it at runtime as a
// blob: URL (see injectPwaHead()), there's no static file to precache.
// (cache.addAll below fails ENTIRELY if any single URL in this list 404s —
// keep it to things that are guaranteed to actually exist.)
const SHELL_ASSETS = [
  "./",
  "./index.html",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  const keep = new Set([SHELL_CACHE, LIB_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(new URL(url).hostname);
}
function isLibRequest(url) {
  // daemeous.github.io is here too: core.js/styles.css are loaded cross-origin
  // from the shared leaflet-map repo by every deployment except (if it
  // exists) one hosted directly inside that repo — same opaque-response
  // handling as the CDN libraries applies, and without it those two files,
  // the actual application code, would never get cached for offline use.
  return /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|daemeous\.github\.io)$/
    .test(new URL(url).hostname);
}
function isAppDataRequest(url) {
  // Sheets CSV, Apps Script, and Google auth — always network, never cache.
  return /(^|\.)google\.com$|(^|\.)googleapis\.com$/.test(new URL(url).hostname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  // Cache.keys() returns entries in insertion order, so the front is oldest.
  while (keys.length > maxEntries) {
    await cache.delete(keys.shift());
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept status/partial POSTs

  const url = request.url;
  if (isAppDataRequest(url)) return; // let the browser handle it directly

  if (isTileRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") {
          cache.put(request, resp.clone());
          trimCache(TILE_CACHE, TILE_CACHE_MAX);
        }
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isLibRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // App shell: stale-while-revalidate — serve the cached copy instantly,
  // refresh the cache in the background so the next load picks up changes.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then(resp => { if (resp.ok) cache.put(request, resp.clone()); return resp; })
      .catch(() => cached);
    return cached || network;
  })());
});
