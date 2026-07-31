/* QuickPick AU — release-hygiene guards.
 *
 * sw.js serves the shell cache-first, so a deploy that forgets to bump VERSION
 * ships nothing: clients keep the old app forever. That bump is the one manual
 * step in the release, and it was previously unguarded.
 *
 * Also pins the M11 cache split — if DRAW_SCHEMA ever picks up the app version
 * again, every deploy would silently start re-downloading 892 KB of draw data.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const sw = readFileSync(new URL("sw.js", root), "utf8");

const swVersion = sw.match(/const VERSION = "([^"]+)"/)?.[1];
const drawSchema = sw.match(/const DRAW_SCHEMA = "([^"]+)"/)?.[1];

check("sw.js VERSION tracks package.json version", () => {
  ok(swVersion, "could not find VERSION in sw.js");
  eq(swVersion, `v${pkg.version}`,
    "the shell is served cache-first, so a stale VERSION means clients never receive this deploy");
});

check("versions are semver", () => {
  ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version "${pkg.version}"`);
  ok(/^v\d+\.\d+\.\d+$/.test(swVersion), `sw.js VERSION "${swVersion}"`);
});

check("the draw cache is NOT keyed by the app version", () => {
  ok(drawSchema, "could not find DRAW_SCHEMA in sw.js");
  ok(!drawSchema.includes(pkg.version),
    `DRAW_SCHEMA "${drawSchema}" embeds the app version — every deploy would evict 892 KB of draw data`);
  ok(/const DRAW_CACHE = `[^`]*\$\{DRAW_SCHEMA\}`/.test(sw),
    "the draw cache name must derive from DRAW_SCHEMA, not VERSION");
  ok(/const SHELL_CACHE = `[^`]*\$\{VERSION\}`/.test(sw),
    "the shell cache name must derive from VERSION");
});

check("every test file the npm scripts reference exists", () => {
  const scripts = Object.values(pkg.scripts).join(" ");
  const referenced = [...scripts.matchAll(/node (test\/[\w./-]+\.mjs)/g)].map((m) => m[1]);
  ok(referenced.length >= 8, `expected the full suite to be wired up, found ${referenced.length}`);
  for (const rel of referenced) {
    ok(existsSync(fileURLToPath(new URL(rel, root))), `npm script points at a missing file: ${rel}`);
  }
});

check("npm test runs both suites, and the core suite needs no dependencies", () => {
  ok(/test:core/.test(pkg.scripts.test) && /test:dom/.test(pkg.scripts.test),
    "npm test must cover both suites");
  ok(!/reveal|a11y/.test(pkg.scripts["test:core"]),
    "the jsdom tests must not be in the core suite — the weekly data pipeline runs it without installing anything");
});

check("the shipped app still has zero production dependencies", () => {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const prod = Object.entries(lock.packages)
    .filter(([name, meta]) => name !== "" && !meta.dev)
    .map(([name]) => name);
  eq(prod.length, 0, `production dependencies found: ${prod.join(", ")}`);
  ok(!pkg.dependencies, "package.json must declare no runtime dependencies");
});

console.log(`\nRelease hygiene: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
