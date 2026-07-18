/* QuickPick AU service worker — cache-first, fully offline after first load.
 * BUMP `VERSION` on every deploy so clients pick up new assets.
 * Exception: data/draws/*.json is stale-while-revalidate — the weekly data
 * commit must reach clients WITHOUT a version bump (cached copy answers
 * instantly/offline, a background refetch updates the cache for next time). */
const VERSION = "v1.3.0";
const CACHE = `quickpick-au-${VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./rng.js",
  "./js/predictor.js",
  "./data/draws/tattslotto.json",
  "./data/draws/ozlotto.json",
  "./data/draws/powerball.json",
  "./data/draws/setforlife.json",
  "./data/draws/weekdaywindfall.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon-180.png"
];

const DRAW_DATA_RE = /\/data\/draws\/[^/]+\.json$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // draw data: stale-while-revalidate
  if (sameOrigin && DRAW_DATA_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req, { ignoreSearch: true });
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) c.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (hit) {
          event.waitUntil(refresh); // keep the SW alive for the background update
          return hit;
        }
        return refresh.then((res) => res || Response.error());
      })
    );
    return;
  }

  // everything else: cache-first
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // runtime-cache same-origin successes
        if (res.ok && sameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() =>
        req.mode === "navigate" ? caches.match("./index.html") : Response.error()
      );
    })
  );
});
