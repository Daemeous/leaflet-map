/* ============================================================================
   sw.js — Offline support for the Leafleting Map app.

   Caches the app shell (index.html, core.js/styles.css from the shared
   leaflet-map repo) and the third-party libraries it loads (Leaflet/
   PapaParse/Turf/fonts) so the app can boot with no signal — common when
   out walking a round. Also caches OSM map tiles as they're viewed, so
   previously-visited areas stay visible offline.

   core.js/styles.css/index.html are NEVER cache-first, even though they're
   cached: they're the app's own actively-developed code, loaded from URLs
   with no version number anywhere in them (no ?v= query string on any real
   deployment), so a device that ever cache-first'd them would keep serving
   that exact version forever, no matter how many times the real file
   changes on the server. They always try the network first, bypassing the
   browser's own HTTP cache too — cache is a fallback for offline only, not
   a shortcut while online. The CDN libraries ARE safe to cache-first: their
   version is baked into the URL path (e.g. /1.9.4/leaflet.min.js), so a
   real change is always a different URL.

   Deliberately NEVER caches: the Google Sheets CSV endpoints, the Apps
   Script URL, or any Google auth endpoint. Road/status data and sign-in
   must always go to the network — core.js already has its own
   localStorage-based cache-and-poll logic for the data itself, keyed by
   checksum, and this service worker must not interfere with that by
   serving a stale response underneath it.

   Bump the CACHE_VERSION below on any change to this file's own caching
   STRATEGY (not needed for ordinary core.js/styles.css/index.html content
   changes — those are covered by the network-first behavior above) so old
   cache entries get cleared out on the next visit.
   ============================================================================ */

const CACHE_VERSION = "v2";
const SHELL_CACHE = `leafmap-shell-${CACHE_VERSION}`;
const LIB_CACHE   = `leafmap-libs-${CACHE_VERSION}`;
const TILE_CACHE  = `leafmap-tiles-${CACHE_VERSION}`;
const TILE_CACHE_MAX = 1000; // bounds on-disk growth from OSM tiles

// core.js/styles.css aren't listed here — they're cross-origin (can't be
// precached at install time the same way) and get cached on first fetch via
// the network-first handler below regardless. manifest.json isn't listed
// either — core.js generates it at runtime as a blob: URL (see
// injectPwaHead()), there's no static file to precache. (cache.addAll below
// fails ENTIRELY if any single URL in this list 404s — keep it to things
// that are guaranteed to actually exist.)
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
// Genuinely immutable: these CDN URLs bake the version into the path itself
// (e.g. /1.9.4/leaflet.min.js) — a real update is a different URL, so
// cache-first forever is correct and desirable here.
function isCdnLibRequest(url) {
  return /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/
    .test(new URL(url).hostname);
}
// The opposite: core.js/styles.css, loaded cross-origin from the shared
// leaflet-map repo, at a URL that never changes even though the CONTENT
// does — this is the app's own actively-developed code. Must never be
// treated as cache-first (see the fetch handler below), or a device that
// cached it once would keep serving that exact version forever.
function isAppLibRequest(url) {
  return new URL(url).hostname === "daemeous.github.io";
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

  if (isCdnLibRequest(url)) {
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

  // core.js/styles.css and the app shell (index.html/"./") itself: always
  // try the network FIRST, bypassing the browser's own HTTP cache too
  // (cache: "no-store") — not just the Cache API — since GitHub Pages'
  // ordinary cache headers are a second layer that could otherwise still
  // serve something stale even after fixing the Cache API side. Only fall
  // back to the last-cached copy when truly offline. This is what actually
  // fixes "old version keeps appearing": there is no query string on the
  // real deployments to bust a cache with, so freshness has to come from
  // never trusting the cache while online in the first place.
  if (isAppLibRequest(url) || request.mode === "navigate" || new URL(url).pathname.endsWith(".html")) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const resp = await fetch(request, { cache: "no-store" });
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Anything else same-origin: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then(resp => { if (resp.ok) cache.put(request, resp.clone()); return resp; })
      .catch(() => cached);
    return cached || network;
  })());
});
