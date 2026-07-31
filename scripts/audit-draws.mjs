/* QuickPick AU — draw-data reconciliation audit for The Oracle.
 *
 *   node scripts/audit-draws.mjs                  (offline — reads data/draws/*.json)
 *   node scripts/audit-draws.mjs --strict         (post-updater: data must be current)
 *   node scripts/audit-draws.mjs --as-of=2026-08-20   (deterministic freshness clock)
 *
 * Per game, HARD FAILS (exit 1) when:
 *   - any era draw violates the current matrix (counts, ranges, duplicates);
 *   - the pool-coverage scan finds a ball absent for an era prefix so long it
 *     implies a narrower hidden pool (P < 1e-6) — the check that caught the
 *     Mon & Wed Lotto 6/44 window (ball 45 absent for 665 draws, P ≈ 1e-53);
 *   - era draw counts disagree with cadence math by more than a few draws;
 *   - the file is STALE: more scheduled draws are missing between its latest
 *     draw and today than one refresh cycle can explain. Cadence math alone
 *     cannot see this — its window ends at the last draw in the file, so a
 *     three-week-stale file still reconciles to delta +0.
 * Prints, per game: era boundary + kind, min/max ball, mains/supps-count
 * histograms, per-year max-ball timeline (legacy-window proof), date-gap
 * anomalies, draw-number step histogram, and the reconciliation table
 * (detected era start | cadence | expected count from calendar math | actual
 * | delta | explanation).
 */

import { readFileSync } from "node:fs";
import {
  ORACLE_GAMES, classifyBoundary, detectEra, matchesMatrix, poolCoverageViolations
} from "../js/predictor.js";

const DAY = 86400000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const dow = (iso) => new Date(utc(iso)).getUTCDay();

/* C(n,k) — largest use here is C(47,7) ≈ 6.3e7, exact in doubles. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/* Cadence model: weekday sets per era segment. `from: null` = era start;
 * `to: null` = latest draw. Weekday Windfall gains Friday at #4392. */
const CADENCE = {
  tattslotto: {
    label: "1/wk (Sat)",
    segments: [{ days: [6] }],
    explain: "Saturday-only game — weekly is correct, not a data gap"
  },
  ozlotto: {
    label: "1/wk (Tue)",
    segments: [{ days: [2] }],
    explain: "weekly Tuesday draws since the 7/47 era began"
  },
  powerball: {
    label: "1/wk (Thu)",
    segments: [{ days: [4] }],
    explain: "weekly Thursday draws since the 7/35 era began"
  },
  setforlife: {
    label: "7/wk (daily)",
    segments: [{ days: [0, 1, 2, 3, 4, 5, 6] }],
    explain: "daily draws from the 7/44 product start"
  },
  weekdaywindfall: {
    label: "2/wk (Mon+Wed) → 3/wk (+Fri from #4392, 2024-05-20)",
    segments: [
      { days: [1, 3], to: "2024-05-15" },
      { days: [1, 3, 5], from: "2024-05-20" }
    ],
    explain: "Mon & Wed Lotto cadence, +Friday when Weekday Windfall launched"
  }
};

/** Count calendar dates in [fromISO..toISO] whose weekday is in `days`. */
function countDrawDays(fromISO, toISO, days) {
  let n = 0;
  for (let t = utc(fromISO); t <= utc(toISO); t += DAY) {
    if (days.includes(new Date(t).getUTCDay())) n++;
  }
  return n;
}

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(utc(isoDate) + n * DAY);

/* ------------------------------------------------------------ freshness */

/* H3. The cadence reconciliation below anchors its window to the LAST DRAW IN
 * THE FILE, so expected and actual move together and the delta is +0 no matter
 * how far behind the data has fallen. That made a stalled pipeline structurally
 * invisible: a file three weeks stale still printed "AUDIT CLEAN".
 *
 * This check anchors to the WALL CLOCK instead, in Australia/Sydney — the
 * timezone every stored draw date is expressed in, which removes the UTC-vs-AEST
 * ambiguity around the 18:00 UTC cron (= 04:00 AEST Monday).
 *
 * The budget is not zero, because the weekly Action is the only thing that
 * refreshes the data: between runs a game legitimately falls behind by up to one
 * cron period (Set for Life draws daily, so that is 7 draws). --strict drops the
 * budget to STRICT_LAG_DRAWS and is what CI uses immediately after the updater,
 * where the data must actually be current. Two draws rather than one absorbs the
 * window where a draw has happened but the API has not published it yet; a truly
 * stalled pipeline blows past that within a single cycle. */
const REFRESH_PERIOD_DAYS = 7;    // cron in .github/workflows/update-draws.yml
const FRESHNESS_GRACE_DAYS = 1;
const STRICT_LAG_DRAWS = 2;

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const asOfArg = (argv.find((a) => a.startsWith("--as-of=")) || "").split("=")[1] || null;
if (asOfArg && (!/^\d{4}-\d{2}-\d{2}$/.test(asOfArg) || Number.isNaN(utc(asOfArg)))) {
  console.error(`--as-of must be YYYY-MM-DD, got "${asOfArg}"`);
  process.exit(2);
}
const AS_OF = asOfArg || new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });

/**
 * Scheduled draws that should exist after `lastDate` and on or before `AS_OF`,
 * and the budget allowed before that counts as a stalled pipeline.
 */
function freshness(lastDate, currentDays) {
  const lag = utc(lastDate) < utc(AS_OF)
    ? countDrawDays(addDays(lastDate, 1), AS_OF, currentDays)
    : 0;
  const window = REFRESH_PERIOD_DAYS + FRESHNESS_GRACE_DAYS;
  const budget = strict
    ? STRICT_LAG_DRAWS
    : Math.max(STRICT_LAG_DRAWS, countDrawDays(addDays(AS_OF, -(window - 1)), AS_OF, currentDays));
  return { lag, budget, ok: lag <= budget };
}

const fmt = (n) => n.toLocaleString("en-AU");
let hardFails = 0;
const tableRows = [];

console.log(`freshness anchor: ${AS_OF} (Australia/Sydney)${strict ? " — STRICT (post-updater)" : ""}`);

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  const file = new URL(`../data/draws/${game.file}.json`, import.meta.url);
  const all = JSON.parse(readFileSync(file, "utf8"));
  const era = detectEra(all, game.matrix, { eraFloor: game.eraFloor });
  const boundary = classifyBoundary(key, era);
  const m = game.matrix;

  console.log(`\n=== ${game.name} — file: ${fmt(all.length)} draws (${all[0].date} → ${all[all.length - 1].date}) ===`);
  const boundaryText = {
    matrix: "matrix format change (real boundary)",
    floor: `pool-alignment floor: ${game.eraFloor?.reason}`,
    edge: "START OF AVAILABLE API HISTORY — matrix era predates the data"
  }[boundary];
  console.log(`era: #${era.startDraw} ${era.startDate} → ${fmt(era.total)} draws | boundary: ${boundaryText}`);
  if (era.discardedOlder) console.log(`     ${fmt(era.discardedOlder)} pre-era draws excluded (older matrix)`);
  if (era.flooredOut) console.log(`     ${fmt(era.flooredOut)} pre-floor draws excluded (${game.eraFloor.reason})`);

  /* 1 — structural matrix audit over every era draw (hard) */
  const violations = era.draws.filter((d) => !matchesMatrix(d, m));
  if (violations.length) {
    hardFails++;
    console.error(`FAIL matrix: ${violations.length} era draws violate the current matrix, e.g. ${JSON.stringify(violations[0])}`);
  } else {
    console.log(`ok   matrix: all ${fmt(era.total)} era draws conform to ${m.drawn}/${m.pool}+${m.supps}supps${m.pb ? `+PB/${m.pb}` : ""}`);
  }

  /* 2 — ball range + histograms across the era (mains + supps) */
  let minBall = Infinity, maxBall = -Infinity;
  const mainsHist = new Map(), suppsHist = new Map();
  let minPB = Infinity, maxPB = -Infinity;
  for (const d of era.draws) {
    for (const v of d.numbers.concat(d.supps || [])) {
      if (v < minBall) minBall = v;
      if (v > maxBall) maxBall = v;
    }
    mainsHist.set(d.numbers.length, (mainsHist.get(d.numbers.length) || 0) + 1);
    const s = (d.supps || []).length;
    suppsHist.set(s, (suppsHist.get(s) || 0) + 1);
    if (d.pb != null) { minPB = Math.min(minPB, d.pb); maxPB = Math.max(maxPB, d.pb); }
  }
  const histText = (h) => [...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}×${fmt(v)}`).join(", ");
  console.log(`ok   balls: min=${minBall} max=${maxBall} | mains-count {${histText(mainsHist)}} | supps-count {${histText(suppsHist)}}` +
    (m.pb ? ` | PB ${minPB}–${maxPB}` : ""));
  if (maxBall !== m.pool || minBall !== 1) {
    hardFails++;
    console.error(`FAIL range: era ball range [${minBall}, ${maxBall}] does not span [1, ${m.pool}] (era of ${fmt(era.total)} draws makes full coverage a statistical certainty)`);
  }

  /* 3 — hidden-pool contamination scan (hard) */
  const contamination = poolCoverageViolations(era.draws, m);
  if (contamination.length) {
    hardFails++;
    for (const c of contamination) {
      console.error(`FAIL coverage: ball ${c.ball} absent for the first ${fmt(c.absentPrefix)} era draws (P ≈ ${c.probability.toExponential(1)}) — hidden narrower pool`);
    }
  } else {
    console.log("ok   coverage: no ball has an era-prefix absence implying a narrower pool (threshold P < 1e-6)");
  }

  /* 4 — per-year max-ball timeline over the WHOLE FILE (legacy-window proof) */
  const years = new Map();
  for (const d of all) {
    const y = d.date.slice(0, 4);
    const top = Math.max(...d.numbers, ...(d.supps || []));
    const e = years.get(y) || { max: 0, n: 0 };
    e.max = Math.max(e.max, top); e.n++;
    years.set(y, e);
  }
  const timeline = [...years.entries()].sort()
    .map(([y, e]) => `${y}:${e.max}`).join(" ");
  console.log(`     max-ball by year (whole file): ${timeline}`);

  /* 5 — cadence reconciliation (calendar math vs actual) */
  const cad = CADENCE[key];
  let expected = 0;
  for (const seg of cad.segments) {
    const from = seg.from && utc(seg.from) > utc(era.startDate) ? seg.from : era.startDate;
    const to = seg.to && utc(seg.to) < utc(era.draws[era.draws.length - 1].date) ? seg.to : era.draws[era.draws.length - 1].date;
    if (utc(from) > utc(to)) continue;
    expected += countDrawDays(from, to, seg.days);
  }
  const delta = era.total - expected;
  console.log(`${Math.abs(delta) <= 3 ? "ok  " : "FAIL"} cadence: expected ${fmt(expected)} draws from calendar math, actual ${fmt(era.total)}, delta ${delta >= 0 ? "+" : ""}${delta}`);
  if (Math.abs(delta) > 3) hardFails++;

  /* 5b — FRESHNESS vs the wall clock (hard). Cadence above cannot see lag,
   *      because its window ends at the last draw in the file. This one ends
   *      at today, so a stalled pipeline is loud. */
  const currentDays = cad.segments[cad.segments.length - 1].days;
  const lastDate = era.draws[era.draws.length - 1].date;
  const fresh = freshness(lastDate, currentDays);
  if (fresh.ok) {
    console.log(
      `ok   freshness: latest draw ${lastDate}, ${fresh.lag} scheduled draw(s) pending as of ${AS_OF} ` +
      `(budget ${fresh.budget}${strict ? ", strict" : ", one weekly refresh cycle"})`
    );
  } else {
    hardFails++;
    console.error(
      `FAIL freshness: ${fmt(fresh.lag)} scheduled draw(s) missing since ${lastDate} as of ${AS_OF} ` +
      `— budget is ${fresh.budget}. The weekly update Action has not landed data; ` +
      `check its run history before trusting this file.`
    );
  }

  /* 6 — date-gap + weekday anomalies within the era */
  const allowedDays = new Set(cad.segments.flatMap((s) => s.days));
  const offDay = era.draws.filter((d) => !allowedDays.has(dow(d.date)));
  if (offDay.length) {
    console.log(`     weekday anomalies: ${offDay.length} draws off-schedule, e.g. #${offDay[0].draw} ${offDay[0].date} (${DOW[dow(offDay[0].date)]})`);
  } else {
    console.log("     weekday check: every era draw falls on a scheduled weekday");
  }

  /* 7 — consecutive-pair rate over the REAL era draws (mains only) vs the
   *     uniform closed form 1 − C(n−k+1,k)/C(n,k). Real draws are uniform,
   *     so observed should track the closed form within binomial noise —
   *     a real-world confirmation of the adjacency math. REPORT-ONLY. */
  {
    const k = m.drawn, n = m.pool;
    const closedForm = 1 - choose(n - k + 1, k) / choose(n, k);
    let withAdjacent = 0;
    for (const d of era.draws) {
      const mains = [...d.numbers].sort((a, b) => a - b);
      for (let i = 1; i < mains.length; i++) {
        if (mains[i] - mains[i - 1] === 1) { withAdjacent++; break; }
      }
    }
    const observed = withAdjacent / era.total;
    const se = Math.sqrt((closedForm * (1 - closedForm)) / era.total);
    console.log(
      `     consecutive-pair rate (${k}/${n} mains, real era draws): observed ${(observed * 100).toFixed(1)}% ` +
      `vs uniform closed form ${(closedForm * 100).toFixed(1)}% ` +
      `(Δ ${((observed - closedForm) >= 0 ? "+" : "")}${((observed - closedForm) * 100).toFixed(1)}pp, ` +
      `±1σ ${(se * 100).toFixed(1)}pp @ n=${fmt(era.total)}) — report-only`
    );
  }

  /* 8 — draw-number step histogram (informational; gaps ≠ missing draws when
   *     the number series is shared with other products, e.g. TattsLotto). */
  const steps = new Map();
  for (let i = 1; i < era.draws.length; i++) {
    const s = era.draws[i].draw - era.draws[i - 1].draw;
    steps.set(s, (steps.get(s) || 0) + 1);
  }
  console.log(`     draw# steps: {${histText(steps)}}` +
    (key === "tattslotto" ? " — constant step 2: the Tatts Saturday series shares its numbering with midweek products (systematic, not data loss)" : ""));

  tableRows.push({
    game: game.name,
    start: `#${era.startDraw} ${era.startDate}`,
    cadence: cad.label,
    expected, actual: era.total, delta,
    latest: lastDate,
    lag: `${fresh.lag}/${fresh.budget}`,
    explanation: (boundary === "edge" ? "available-history start; " : boundary === "floor" ? "6/45-alignment floor; " : "") + cad.explain
  });
}

/* ------------------------------------------------- reconciliation table */
console.log("\n=== RECONCILIATION TABLE ===");
const cols = ["game", "detected era start", "cadence", "expected", "actual", "delta", "latest draw", "lag/budget", "explanation"];
console.log(cols.join(" | "));
for (const r of tableRows) {
  console.log([
    r.game, r.start, r.cadence, fmt(r.expected), fmt(r.actual),
    (r.delta >= 0 ? "+" : "") + r.delta, r.latest, r.lag, r.explanation
  ].join(" | "));
}

console.log(hardFails ? `\nAUDIT FAILED — ${hardFails} hard failure(s)` : "\nAUDIT CLEAN — all games reconcile");
process.exit(hardFails ? 1 : 0);
