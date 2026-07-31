/* QuickPick AU service worker.
 *
 * Two caches, on purpose.
 *
 * SHELL — versioned, precached atomically at install. Everything needed to
 * boot and run a quick pick: ~93 KB raw / ~23 KB over the wire, plus icons.
 * BUMP `VERSION` on every deploy so clients pick up new assets.
 *
 * DRAWS — unversioned, populated at RUNTIME, cache-first with a background
 * refresh. 892 KB of draw history across five games.
 *
 * The split matters for two reasons the review measured.
 *
 * 1. addAll() is atomic. With the draw JSON in the precache list, one flaky
 *    fetch of one 315 KB file rejected the whole install, and the user got no
 *    offline capability at all -- not even the 23 KB shell. Now the shell
 *    install cannot be taken down by draw data, and a game whose file was
 *    never fetched simply reports "draw history unavailable" while every other
 *    part of the app keeps working offline.
 *
 * 2. The draw cache is deliberately NOT version-scoped, so a deploy no longer
 *    discards it. Previously every VERSION bump re-downloaded all five files
 *    even for a one-line CSS change, and the weekly data commit re-downloaded
 *    a whole 315 KB file to add one draw. DRAW_SCHEMA is what invalidates it,
 *    and only changes if the record format changes.
 */
const VERSION = "v1.3.1";
const DRAW_SCHEMA = "v1"; // bump ONLY when data/draws record shape changes

const SHELL_CACHE = `quickpick-au-shell-${VERSION}`;
const DRAW_CACHE = `quickpick-au-draws-${DRAW_SCHEMA}`;

/* Must cover every asset the app needs to boot offline. test/sw.test.mjs walks
 * the real import graph from index.html and fails if anything is missing. */
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./rng.js",
  "./js/predictor.js",
  "./js/history.js",
  "./js/reveal.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon-180.png"
];

const DRAW_DATA_RE = /\/data\/draws\/[^/]+\.json$/;
const KEEP = new Set([SHELL_CACHE, DRAW_CACHE]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Cross-origin requests pass straight through, uncached and unintercepted.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    DRAW_DATA_RE.test(url.pathname) ? drawData(event, req) : shellAsset(event, req)
  );
});

/**
 * Draw history: serve the cached copy instantly (offline included) and refresh
 * in the background, so the weekly data commit lands without a VERSION bump.
 * A file that has never been fetched and cannot be fetched now yields 504,
 * which getOracleContext surfaces as the existing "connect once" message —
 * the rest of the app is unaffected.
 */
async function drawData(event, req) {
  const cache = await caches.open(DRAW_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });

  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) return cache.put(req, res.clone()).then(() => res);
      return res;
    })
    .catch(() => null);

  if (hit) {
    event.waitUntil(refresh); // keep the SW alive for the background update
    return hit;
  }
  const fresh = await refresh;
  return fresh || new Response(
    JSON.stringify({ error: "draw history not cached — connect once to fetch it" }),
    { status: 504, headers: { "Content-Type": "application/json" } }
  );
}

/** Everything else: cache-first, with a navigation fallback to the shell. */
async function shellAsset(event, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) event.waitUntil(cache.put(req, res.clone()));
    return res;
  } catch {
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return Response.error();
  }
}
