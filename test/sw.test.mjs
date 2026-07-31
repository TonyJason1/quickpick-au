/* QuickPick AU — service worker caching (M11).
 *
 * Runs sw.js for real against a mock Cache/fetch environment. Deliberately no
 * jsdom: a service worker has no DOM, and this test belongs in the
 * zero-dependency core suite that the weekly data pipeline itself runs.
 *
 * The review's measurements this guards:
 *   - 892 KB of draw JSON was in the atomic install-time precache, so ONE
 *     flaky data fetch rejected addAll and left the user with no offline
 *     capability at all -- not even the 23 KB shell.
 *   - the draw cache was version-scoped, so every deploy re-downloaded all
 *     five files, and the weekly one-draw data commit re-downloaded 315 KB.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const ORIGIN = "https://tonyjason1.github.io";
const BASE = `${ORIGIN}/quickpick-au/`;
const pathOf = (u) => new URL(typeof u === "string" ? u : u.url, BASE).pathname;

/* ------------------------------------------------------------- harness */

class MockCache {
  constructor() { this.entries = new Map(); }
  async put(req, res) { this.entries.set(pathOf(req), res); }
  async match(req) { return this.entries.get(pathOf(req)); }
  async delete(req) { return this.entries.delete(pathOf(req)); }
  /** Atomic, exactly like the real Cache API: any failure stores nothing. */
  async addAll(list) {
    const fetched = [];
    for (const u of list) {
      const res = await globalThis.fetch({ url: new URL(u, BASE).toString(), method: "GET" });
      if (!res.ok) throw new TypeError(`addAll: request failed for ${u}`);
      fetched.push([u, res]);
    }
    for (const [u, res] of fetched) await this.put(u, res);
  }
}

class MockCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
}

function makeNetwork({ offline = false, failing = new Set() } = {}) {
  const log = [];
  const fn = async (req) => {
    const p = pathOf(req);
    log.push(p);
    if (offline) throw new TypeError("Failed to fetch");
    if (failing.has(p)) throw new TypeError(`Failed to fetch ${p}`);
    if (/\/data\/draws\//.test(p)) {
      return new Response(JSON.stringify([{ draw: 1, date: "2026-01-01", numbers: [1, 2, 3, 4, 5, 6], supps: [7, 8], pb: null }]),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(`content:${p}`, { status: 200 });
  };
  fn.log = log;
  return fn;
}

let swInstance = 0;
/** Boot a fresh sw.js against a fresh mock environment. */
async function bootSW({ network = makeNetwork(), storage = new MockCacheStorage() } = {}) {
  const listeners = new Map();
  globalThis.self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => { globalThis.self._skipWaiting = true; },
    clients: { claim: async () => { globalThis.self._claimed = true; } }
  };
  globalThis.caches = storage;
  globalThis.fetch = network;
  await import(`../sw.js?instance=${++swInstance}`);
  return { listeners, storage, network };
}

const fireLifecycle = async (listeners, type) => {
  const waits = [];
  listeners.get(type)({ waitUntil: (p) => waits.push(p) });
  return Promise.all(waits);
};

async function fireFetch(listeners, url, { mode = "same-origin", method = "GET" } = {}) {
  const request = { url: new URL(url, BASE).toString(), method, mode };
  let responded;
  const waits = [];
  listeners.get("fetch")({ request, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
  if (responded === undefined) return { passthrough: true };
  const res = await responded;
  await Promise.allSettled(waits);
  return { res, passthrough: false };
}

/** The SHELL array as sw.js declares it. */
function shellList() {
  const src = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const block = src.match(/const SHELL = \[([\s\S]*?)\];/);
  ok(block, "could not locate SHELL in sw.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/* --------------------------------------------- 1. what gets precached */

await check("install precaches the shell and NO draw data", async () => {
  const { listeners, storage } = await bootSW();
  await fireLifecycle(listeners, "install");

  const shellCache = [...storage.caches.entries()].find(([k]) => k.includes("shell"))[1];
  const cached = [...shellCache.entries.keys()];
  ok(cached.length > 0, "shell cache is empty");
  const draws = cached.filter((p) => /\/data\/draws\//.test(p));
  eq(draws.length, 0, `draw JSON must not be precached, found: ${draws.join(", ")}`);

  for (const must of ["/quickpick-au/", "/quickpick-au/app.js", "/quickpick-au/index.html"]) {
    ok(cached.includes(must), `shell missing ${must}`);
  }
});

await check("SHELL covers every module the app actually imports", async () => {
  const shell = new Set(shellList());
  const root = new URL("../", import.meta.url);
  const seen = new Set();

  const walk = (relPath) => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    ok(shell.has(`./${relPath}`), `sw.js SHELL is missing ./${relPath} — the app would break offline`);
    const src = readFileSync(new URL(relPath, root), "utf8");
    for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s+["'](\.[^"']+)["']/g)) {
      const resolved = fileURLToPath(new URL(m[1], new URL(relPath, root)))
        .replace(fileURLToPath(root), "")
        .replace(/\\/g, "/");
      walk(resolved);
    }
  };
  walk("app.js");

  // static assets referenced by index.html
  const html = readFileSync(new URL("index.html", root), "utf8");
  for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref)) continue;
    ok(shell.has(`./${ref}`), `sw.js SHELL is missing ./${ref} (referenced by index.html)`);
  }
  ok(seen.has("js/reveal.js") && seen.has("js/history.js"), "expected the new modules in the import graph");
});

/* ------------------------------------------------ 2. install atomicity */

await check("a failing DRAW file cannot break the install (it is not in the shell)", async () => {
  const network = makeNetwork({ failing: new Set(["/quickpick-au/data/draws/weekdaywindfall.json"]) });
  const { listeners, storage } = await bootSW({ network });
  await fireLifecycle(listeners, "install"); // must not reject
  const shellCache = [...storage.caches.entries()].find(([k]) => k.includes("shell"))[1];
  ok(shellCache.entries.size > 0, "shell should still be cached");
});

await check("a failing SHELL asset still fails the install loudly", async () => {
  const network = makeNetwork({ failing: new Set(["/quickpick-au/app.js"]) });
  const { listeners } = await bootSW({ network });
  let threw = false;
  try { await fireLifecycle(listeners, "install"); } catch { threw = true; }
  ok(threw, "a missing core asset must not silently produce a half-working offline app");
});

/* --------------------------------- 3. THE E2E: offline with no draw data */

await check("E2E: app works offline even with one data file never fetched", async () => {
  const storage = new MockCacheStorage();

  // Visit once, online. Only tattslotto's history is ever requested.
  {
    const online = makeNetwork();
    const { listeners } = await bootSW({ network: online, storage });
    await fireLifecycle(listeners, "install");
    await fireLifecycle(listeners, "activate");
    const r = await fireFetch(listeners, "./data/draws/tattslotto.json");
    eq(r.res.status, 200, "tattslotto fetched online");
  }

  // Now go offline.
  const offline = makeNetwork({ offline: true });
  const { listeners } = await bootSW({ network: offline, storage });

  // The shell still boots.
  const nav = await fireFetch(listeners, "./", { mode: "navigate" });
  eq(nav.res.status, 200, "navigation must be served from cache");
  const app = await fireFetch(listeners, "./app.js");
  eq(app.res.status, 200, "app.js must be served from cache");
  const css = await fireFetch(listeners, "./styles.css");
  eq(css.res.status, 200, "styles.css must be served from cache");

  // The game whose data WAS fetched still works offline.
  const cached = await fireFetch(listeners, "./data/draws/tattslotto.json");
  eq(cached.res.status, 200, "cached draw data must be served offline");
  const parsed = JSON.parse(await cached.res.clone().text());
  ok(Array.isArray(parsed), "cached draw data must still be valid JSON");

  // The game whose data was NEVER fetched degrades, and does not throw.
  const missing = await fireFetch(listeners, "./data/draws/ozlotto.json");
  eq(missing.res.status, 504, "uncached draw data must yield a clean 504");
  ok(!missing.res.ok, "504 must be a non-ok response so getOracleContext shows its message");

  // Crucially, that failure did not poison anything else.
  const stillFine = await fireFetch(listeners, "./js/predictor.js");
  eq(stillFine.res.status, 200, "the rest of the app must be unaffected");
});

await check("navigation falls back to the shell when the network is gone", async () => {
  const storage = new MockCacheStorage();
  {
    const { listeners } = await bootSW({ storage });
    await fireLifecycle(listeners, "install");
  }
  const { listeners } = await bootSW({ network: makeNetwork({ offline: true }), storage });
  const deep = await fireFetch(listeners, "./some/deep/route", { mode: "navigate" });
  eq(deep.res.status, 200, "unknown route must fall back to the cached shell");
});

/* ------------------------------------- 4. runtime caching + refreshing */

await check("draw data is cached on first use and served from cache after", async () => {
  const network = makeNetwork();
  const { listeners, storage } = await bootSW({ network });
  await fireLifecycle(listeners, "install");

  const drawCache = () => [...storage.caches.entries()].find(([k]) => k.includes("draws"));
  ok(!drawCache(), "no draw cache should exist before any draw request");

  await fireFetch(listeners, "./data/draws/powerball.json");
  ok(drawCache(), "draw cache created on first use");
  eq(drawCache()[1].entries.size, 1, "exactly one file cached");

  const before = network.log.length;
  const second = await fireFetch(listeners, "./data/draws/powerball.json");
  eq(second.res.status, 200, "served");
  ok(network.log.length > before, "a background refresh should still be issued (stale-while-revalidate)");
});

await check("a background refresh failure never breaks the cached response", async () => {
  const storage = new MockCacheStorage();
  {
    const { listeners } = await bootSW({ storage });
    await fireLifecycle(listeners, "install");
    await fireFetch(listeners, "./data/draws/setforlife.json");
  }
  const { listeners } = await bootSW({ network: makeNetwork({ offline: true }), storage });
  const r = await fireFetch(listeners, "./data/draws/setforlife.json");
  eq(r.res.status, 200, "cached copy must still be served when the refresh fails");
});

/* --------------------------------- 5. deploys must not evict draw data */

await check("a VERSION bump keeps the draw cache and drops only the old shell", async () => {
  const storage = new MockCacheStorage();
  const { listeners } = await bootSW({ storage });
  await fireLifecycle(listeners, "install");
  await fireFetch(listeners, "./data/draws/ozlotto.json");

  const drawKey = [...storage.caches.keys()].find((k) => k.includes("draws"));
  ok(drawKey, "draw cache exists");
  ok(!/v1\.3\.\d/.test(drawKey), `draw cache must not be version-scoped, got "${drawKey}"`);

  // Simulate the previous deploy's shell cache still lying around.
  storage.caches.set("quickpick-au-shell-v1.3.0", new MockCache());
  storage.caches.set("quickpick-au-v1.2.0", new MockCache());

  await fireLifecycle(listeners, "activate");
  const keys = [...storage.caches.keys()];
  ok(!keys.includes("quickpick-au-shell-v1.3.0"), "stale shell cache must be deleted");
  ok(!keys.includes("quickpick-au-v1.2.0"), "pre-split cache must be deleted");
  ok(keys.includes(drawKey), "draw cache must SURVIVE the version bump — 892 KB must not be re-downloaded");
  eq((await storage.open(drawKey)).entries.size, 1, "cached draw file still present");
});

/* --------------------------------------------------- 6. passthroughs */

await check("cross-origin and non-GET requests are not intercepted", async () => {
  const { listeners } = await bootSW();
  await fireLifecycle(listeners, "install");
  const cross = await fireFetch(listeners, "https://www.gamblinghelponline.org.au/");
  ok(cross.passthrough, "cross-origin must pass through untouched");
  const post = await fireFetch(listeners, "./app.js", { method: "POST" });
  ok(post.passthrough, "non-GET must pass through untouched");
});

/* ------------------------------------------------------------- report */

console.log(`\nService worker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
