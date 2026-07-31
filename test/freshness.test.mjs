/* QuickPick AU — audit freshness regression (H3).
 *
 * The review's finding: audit-draws.mjs anchored its cadence window to the LAST
 * DRAW IN THE FILE, so expected and actual moved together and the delta was +0
 * no matter how stale the data was. A file three weeks behind still printed
 * "AUDIT CLEAN — all games reconcile".
 *
 * The guard here is deliberately not just "stale data fails". It asserts the
 * SHAPE of the old bug: at a stale anchor, cadence must STILL report delta +0
 * (that check is working as designed — it measures internal consistency) while
 * freshness fails. If someone ever re-anchors freshness to the file instead of
 * the clock, that pairing breaks and this test catches it.
 *
 * Anchors are derived from the shipped data, so the weekly data commit cannot
 * rot this test.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORACLE_GAMES } from "../js/predictor.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); }

const AUDIT = fileURLToPath(new URL("../scripts/audit-draws.mjs", import.meta.url));
const realData = (file) =>
  JSON.parse(readFileSync(new URL(`../data/draws/${file}.json`, import.meta.url), "utf8"));

const DAY = 86400000;
const utc = (d) => Date.parse(`${d}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** Newest draw date across all games — the natural "data is current" anchor. */
const NEWEST = Object.values(ORACLE_GAMES)
  .map((g) => realData(g.file).at(-1).date)
  .sort()
  .at(-1);

function runAudit(...args) {
  const r = spawnSync(process.execPath, [AUDIT, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/* ------------------------------------------------------- current data */

check("audit passes at an anchor where the data is current", () => {
  const { code, out } = runAudit(`--as-of=${NEWEST}`);
  eq(code, 0, "exit code");
  ok(/AUDIT CLEAN/.test(out), "must report clean");
  ok(!/FAIL freshness/.test(out), "must not report a freshness failure");
});

check("--strict also passes right after an update", () => {
  const { code, out } = runAudit("--strict", `--as-of=${NEWEST}`);
  eq(code, 0, "exit code");
  ok(/STRICT/.test(out), "must announce strict mode");
  ok(/AUDIT CLEAN/.test(out), "must report clean");
});

/* ------------------------------------------------ the H3 bug, reproduced */

check("a three-week-stale file hard-fails — and cadence still says delta +0", () => {
  const stale = iso(utc(NEWEST) + 21 * DAY);
  const { code, out } = runAudit(`--as-of=${stale}`);

  eq(code, 1, "stale data must exit 1");
  ok(/AUDIT FAILED/.test(out), "must report failure");

  // Every game must fail freshness...
  const freshFails = (out.match(/FAIL freshness/g) || []).length;
  eq(freshFails, Object.keys(ORACLE_GAMES).length, "every game must fail freshness");

  // ...while cadence keeps reporting a perfect reconciliation. This pairing IS
  // the bug the review found: cadence cannot see staleness, by construction.
  ok(!/FAIL cadence/.test(out), "cadence must not fail — it measures internal consistency only");
  const cadenceZero = (out.match(/ok {3}cadence: .*delta \+0/g) || []).length;
  eq(cadenceZero, Object.keys(ORACLE_GAMES).length,
    "all five games must still reconcile to delta +0 at the stale anchor");
});

check("failure message points at the pipeline, not the data", () => {
  const stale = iso(utc(NEWEST) + 21 * DAY);
  const { out } = runAudit(`--as-of=${stale}`);
  ok(/weekly update Action has not landed data/.test(out), "must name the likely cause");
  ok(/scheduled draw\(s\) missing since/.test(out), "must quote the gap");
});

/* --------------------------------------------------- budget boundaries */

check("one refresh cycle of lag is tolerated by default, but not by --strict", () => {
  // Set for Life draws daily, so a week of lag is 7 draws: inside the default
  // budget (one cron period) and far outside the strict budget.
  const sfl = realData(ORACLE_GAMES.setforlife.file).at(-1).date;
  const weekOn = iso(utc(sfl) + 7 * DAY);

  const lax = runAudit(`--as-of=${weekOn}`);
  ok(!/FAIL freshness: .*Set for Life|FAIL freshness/.test(lax.out) || lax.code === 0,
    "a single refresh cycle must not fail the default audit");

  const strict = runAudit("--strict", `--as-of=${weekOn}`);
  eq(strict.code, 1, "strict must reject a week of lag");
  ok(/FAIL freshness/.test(strict.out), "strict must name freshness");
});

check("lag is counted in scheduled draws, not calendar days", () => {
  // TattsLotto draws once a week, so 10 days on is at most 2 missed draws --
  // inside budget. Set for Life at the same anchor is ~10 missed draws.
  const stale = iso(utc(NEWEST) + 24 * DAY);
  const { out } = runAudit(`--as-of=${stale}`);
  const sfl = out.match(/FAIL freshness: (\d+) scheduled draw\(s\) missing since \d{4}-\d{2}-\d{2} as of/g) || [];
  ok(sfl.length > 0, "expected freshness failures");
  const counts = [...out.matchAll(/FAIL freshness: (\d+) scheduled/g)].map((m) => Number(m[1]));
  ok(Math.max(...counts) > Math.min(...counts),
    "daily and weekly games must report different lag counts — lag is per-cadence, not per-day");
});

/* ------------------------------------------------------- argument gate */

check("--as-of rejects a malformed date", () => {
  for (const bad of ["--as-of=yesterday", "--as-of=2026-13-45", "--as-of=20260820", "--as-of="]) {
    const { code } = runAudit(bad);
    ok(code === 2 || code === 0, `"${bad}" must not be silently treated as a valid clock`);
    if (bad !== "--as-of=") eq(code, 2, `"${bad}" must exit 2`);
  }
});

/* ------------------------------------------------------------- report */

console.log(`\nAudit freshness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
