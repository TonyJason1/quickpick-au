/* QuickPick AU — The Oracle predictor validation.
 *
 *  1) Era auto-detection against synthetic fixtures containing format changes
 *     (Oz 7/45+2→7/47+3, Powerball 6/40→7/35, SfL 8/37→7/44, Weekday legacy flag).
 *  2) Era detection + boundary pins against the REAL shipped data files
 *     (historical boundaries are immutable, so exact pins are stable).
 *  3) Frequency / overdue-gap arithmetic against a hand-computed fixture.
 *  4) Output contracts for every game × mode: line count, picks per line
 *     (7/8/7/7+7/7), in-range, unique, sorted; SfL rank modes disjoint.
 *  5) ORACLE weighting: exact weight formula + statistical tilt of the
 *     rejection sampler.
 * Exits 1 on any failure.
 */

import { readFileSync } from "node:fs";
import {
  ORACLE_GAMES, MODES, matchesMatrix, detectEra, sanityCheckEraStart,
  computeStats, oracleWeights, pickOracle, pickLine, generateLines,
  tooltipText, getOracleContext, clearOracleCache
} from "../js/predictor.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
function eq(a, b, what = "") {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${what} expected ${jb}, got ${ja}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const realData = (file) =>
  JSON.parse(readFileSync(new URL(`../data/draws/${file}.json`, import.meta.url), "utf8"));

/* ---------------------------------------------- 1. era detection: fixtures */

check("era: oz fixture — supps 2→3 boundary at draw #31", () => {
  const era = detectEra(fixture("ozlotto-format-change"), ORACLE_GAMES.ozlotto.matrix);
  eq(era.startDraw, 31, "startDraw");
  eq(era.startDate, "2022-05-17", "startDate");
  eq(era.total, 40, "total");
  eq(era.discardedOlder, 30, "discardedOlder");
});

check("era: powerball fixture — mains 6→7 boundary at draw #26", () => {
  const era = detectEra(fixture("powerball-format-change"), ORACLE_GAMES.powerball.matrix);
  eq(era.startDraw, 26, "startDraw");
  eq(era.startDate, "2018-04-19", "startDate");
  eq(era.total, 35, "total");
});

check("era: setforlife fixture — 8/37→7/44 boundary at draw #21", () => {
  const era = detectEra(fixture("setforlife-format-change"), ORACLE_GAMES.setforlife.matrix);
  eq(era.startDraw, 21, "startDraw");
  eq(era.startDate, "2020-08-03", "startDate");
  eq(era.total, 30, "total");
});

check("era: weekday fixture — includeLegacy toggles the era span", () => {
  const draws = fixture("weekdaywindfall-legacy");
  const m = ORACLE_GAMES.weekdaywindfall.matrix;
  const withLegacy = detectEra(draws, m, { includeLegacy: true });
  eq(withLegacy.total, 25, "with legacy total");
  eq(withLegacy.startDraw, 1, "with legacy startDraw");
  const without = detectEra(draws, m, { includeLegacy: false });
  eq(without.total, 10, "without legacy total");
  eq(without.startDraw, 16, "without legacy startDraw");
  eq(without.startDate, "2024-05-20", "without legacy startDate");
});

check("era: unsorted input is sorted before detection", () => {
  const shuffledDraws = [...fixture("powerball-format-change")].reverse();
  const era = detectEra(shuffledDraws, ORACLE_GAMES.powerball.matrix);
  eq(era.startDraw, 26, "startDraw");
});

check("era: throws when the LATEST draw no longer matches the matrix", () => {
  const oldOnly = fixture("ozlotto-format-change").filter((d) => d.draw <= 30);
  let threw = false;
  try { detectEra(oldOnly, ORACLE_GAMES.ozlotto.matrix); } catch { threw = true; }
  ok(threw, "expected a loud failure on a stale configured matrix");
});

check("matchesMatrix: rejects malformed records", () => {
  const m = ORACLE_GAMES.tattslotto.matrix;
  const good = { numbers: [1, 2, 3, 4, 5, 6], supps: [7, 8], pb: null };
  ok(matchesMatrix(good, m), "control record should match");
  ok(!matchesMatrix({ ...good, numbers: [1, 2, 3, 4, 5, 46] }, m), "ball over pool");
  ok(!matchesMatrix({ ...good, numbers: [1, 2, 3, 4, 5, 5] }, m), "duplicate ball");
  ok(!matchesMatrix({ ...good, supps: [6, 7] }, m), "supp repeats a main");
  ok(!matchesMatrix({ ...good, supps: [7] }, m), "wrong supp count");
  ok(!matchesMatrix({ ...good, pb: 3 }, m), "pb present where none expected");
  const pbm = ORACLE_GAMES.powerball.matrix;
  const pbGood = { numbers: [1, 2, 3, 4, 5, 6, 7], supps: [], pb: 20 };
  ok(matchesMatrix(pbGood, pbm), "pb control should match");
  ok(!matchesMatrix({ ...pbGood, pb: 21 }, pbm), "pb over range");
  ok(!matchesMatrix({ ...pbGood, pb: null }, pbm), "pb missing");
});

check("sanity anchors: near boundary ok, distant boundary flagged", () => {
  ok(sanityCheckEraStart("powerball", "2018-04-19").ok, "exact date");
  ok(sanityCheckEraStart("setforlife", "2020-03-23").ok, "131 days inside tolerance");
  ok(!sanityCheckEraStart("ozlotto", "2023-06-01").ok, "a year off must flag");
  eq(sanityCheckEraStart("tattslotto", "1997-02-01"), null, "no anchor for tattslotto");
});

/* -------------------------------------------- 2. era detection: real data */

const REAL_PINS = [
  // [game, exact startDraw, exact startDate, minimum era draws]
  ["powerball", 1144, "2018-04-19", 400],
  ["ozlotto", 1474, "2022-05-17", 200],
  ["setforlife", 1691, "2020-03-23", 2300]
];

for (const [key, startDraw, startDate, minTotal] of REAL_PINS) {
  check(`real data: ${key} era pin #${startDraw} ${startDate}`, () => {
    const era = detectEra(realData(ORACLE_GAMES[key].file), ORACLE_GAMES[key].matrix);
    eq(era.startDraw, startDraw, "startDraw");
    eq(era.startDate, startDate, "startDate");
    ok(era.total >= minTotal, `era total ${era.total} < ${minTotal}`);
    const sanity = sanityCheckEraStart(key, era.startDate);
    ok(!sanity || sanity.ok, "sanity anchor check must pass on real data");
  });
}

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  check(`real data: ${key} file is sound + era detects`, () => {
    const draws = realData(game.file);
    ok(Array.isArray(draws) && draws.length > 100, "non-trivial history");
    for (let i = 1; i < draws.length; i++) {
      ok(draws[i].draw > draws[i - 1].draw, `draw numbers not strictly ascending at index ${i}`);
    }
    for (const d of draws) {
      ok(/^\d{4}-\d{2}-\d{2}$/.test(d.date), `bad date on #${d.draw}`);
    }
    const era = detectEra(draws, game.matrix);
    ok(era.total > 100, "era non-trivial");
    for (const d of era.draws) {
      ok(matchesMatrix(d, game.matrix), `era draw #${d.draw} violates matrix`);
    }
  });
}

check("real data: weekday legacy draws all pre-rebrand, era spans both", () => {
  const draws = realData("weekdaywindfall");
  const legacy = draws.filter((d) => d.legacy);
  const current = draws.filter((d) => !d.legacy);
  ok(legacy.length > 2500, `legacy count ${legacy.length}`);
  ok(current.length > 300, `current count ${current.length}`);
  ok(legacy.every((d) => d.date < "2024-05-20"), "legacy draws after rebrand date");
  ok(current.every((d) => d.date >= "2024-05-20"), "current draws before rebrand date");
  const m = ORACLE_GAMES.weekdaywindfall.matrix;
  eq(detectEra(draws, m, { includeLegacy: true }).total, draws.length, "full-span era");
  eq(detectEra(draws, m, { includeLegacy: false }).total, current.length, "current-only era");
});

/* --------------------------------- 3. frequency / overdue: hand-computed */

/* pool 10; freq: 1→5 2→4 3..8→1 9,10→0; gaps: 1,2,8→0 7→1 5,6→2 4→3 3→4 9,10→5 */
const TINY = [
  { draw: 1, date: "2026-01-01", numbers: [1, 2, 3], supps: [], pb: null },
  { draw: 2, date: "2026-01-02", numbers: [1, 2, 4], supps: [], pb: null },
  { draw: 3, date: "2026-01-03", numbers: [1, 5, 6], supps: [], pb: null },
  { draw: 4, date: "2026-01-04", numbers: [1, 2, 7], supps: [], pb: null },
  { draw: 5, date: "2026-01-05", numbers: [1, 2, 8], supps: [], pb: null }
];

check("stats: exact frequency and gap arrays", () => {
  const s = computeStats(TINY, 10);
  eq(s.freq.slice(1), [5, 4, 1, 1, 1, 1, 1, 1, 0, 0], "freq");
  eq(s.gap.slice(1), [0, 0, 4, 3, 2, 2, 1, 0, 5, 5], "gap");
  eq(s.total, 5, "total");
  eq(s.minFreq, 0, "minFreq");
  eq(s.maxFreq, 5, "maxFreq");
});

check("stats: supplementaries and pb are excluded from frequency", () => {
  const s = computeStats([
    { draw: 1, date: "2026-01-01", numbers: [1, 2], supps: [3, 4], pb: 5 }
  ], 10);
  eq(s.freq.slice(1), [1, 1, 0, 0, 0, 0, 0, 0, 0, 0], "mains only");
});

check("modes: deterministic picks where the metric has no ties", () => {
  const s = computeStats(TINY, 10);
  eq(pickLine(s, "hot", 2), [1, 2], "hot top-2");
  eq(pickLine(s, "cold", 2), [9, 10], "cold bottom-2 (never drawn)");
  eq(pickLine(s, "overdue", 3), [3, 9, 10], "overdue: never-drawn 9,10 then gap-4 ball 3");
});

check("modes: ties are broken randomly (crypto shuffle before stable sort)", () => {
  const s = computeStats(TINY, 10);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const line = pickLine(s, "hot", 4); // [1,2] + 2 of the six freq-1 balls
    ok(line.includes(1) && line.includes(2), "hot must include the clear top-2");
    const rest = line.filter((n) => n !== 1 && n !== 2);
    eq(rest.length, 2, "two tie-break balls");
    ok(rest.every((n) => n >= 3 && n <= 8), "tie-breaks drawn from the freq-1 tie set");
    seen.add(rest.join(","));
  }
  ok(seen.size > 1, "40 runs never varied the tie-break — RNG tie-breaking broken");
});

check("tooltip: doctrine wording", () => {
  const s = computeStats(TINY, 10);
  const era = { startYear: 2026 };
  eq(tooltipText(s, era, 1), "drawn 5× in 5 draws since 2026", "tooltip");
});

/* --------------------------------------- 4. output contracts: game × mode */

const EXPECTED_SHAPE = {
  tattslotto: { lines: 1, picks: 7 },
  ozlotto: { lines: 1, picks: 8 },
  powerball: { lines: 1, picks: 7 },
  setforlife: { lines: 2, picks: 7 },
  weekdaywindfall: { lines: 1, picks: 7 }
};

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  check(`config: ${key} play format matches the doctrine`, () => {
    eq(game.lines ?? 1, EXPECTED_SHAPE[key].lines, "lines");
    eq(game.picks, EXPECTED_SHAPE[key].picks, "picks");
  });
}

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  const era = detectEra(realData(game.file), game.matrix);
  const stats = computeStats(era.draws, game.matrix.pool);
  for (const mode of MODES) {
    check(`output: ${key} × ${mode.toUpperCase()}`, () => {
      const lines = generateLines(stats, game, mode);
      eq(lines.length, EXPECTED_SHAPE[key].lines, "line count");
      for (const line of lines) {
        eq(line.length, EXPECTED_SHAPE[key].picks, "picks per line");
        ok(line.every((n) => Number.isInteger(n) && n >= 1 && n <= game.matrix.pool),
          `out of range: ${line}`);
        eq(new Set(line).size, line.length, "unique within line");
        for (let i = 1; i < line.length; i++) ok(line[i] > line[i - 1], "sorted ascending");
      }
      if (key === "setforlife" && mode !== "oracle") {
        const union = new Set([...lines[0], ...lines[1]]);
        eq(union.size, 14, "rank-mode lines must be disjoint (ranks 1–7 and 8–14)");
      }
    });
  }
}

/* --------------------------------------------------- 5. oracle weighting */

check("oracle: exact weight formula (1 + 0.5 × min-max normalised freq)", () => {
  const s = computeStats(TINY, 10);
  const w = oracleWeights(s);
  eq(w[1], 1.5, "max-freq ball");
  eq(w[9], 1.0, "never-drawn ball");
  eq(w[2], 1 + 0.5 * (4 / 5), "mid ball 2");
  const flat = computeStats([{ draw: 1, date: "2026-01-01", numbers: [1, 2], supps: [], pb: null }], 2);
  eq(oracleWeights(flat).slice(1), [1, 1], "zero span → all weights 1");
});

check("oracle: rejection sampler tilts ~1.5× toward the hottest ball", () => {
  // pool 5, ball 1 at weight 1.5, balls 2–5 at 1.0 → P(1)=1.5/5.5, others 1/5.5
  const rigged = {
    pool: 5, total: 100, minFreq: 0, maxFreq: 100,
    freq: [0, 100, 0, 0, 0, 0], gap: [0, 0, 0, 0, 0, 0]
  };
  const N = 30000;
  const counts = new Array(6).fill(0);
  for (let i = 0; i < N; i++) counts[pickOracle(rigged, 1)[0]]++;
  const others = (counts[2] + counts[3] + counts[4] + counts[5]) / 4;
  const ratio = counts[1] / others;
  ok(ratio > 1.3 && ratio < 1.7,
    `tilt ratio ${ratio.toFixed(3)} outside [1.3, 1.7] (expected ≈1.5)`);
});

check("oracle: full-pool draw returns every ball exactly once", () => {
  const s = computeStats(TINY, 10);
  eq(pickOracle(s, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "k = pool");
});

/* ------------------------------------------------------- 6. data loader */

const fakeFetcher = (payload, okStatus = true) => async () => ({
  ok: okStatus, status: okStatus ? 200 : 404, json: async () => payload
});

await checkAsync("loader: computes context via injected fetcher, memoises", async () => {
  clearOracleCache();
  const ctx = await getOracleContext("ozlotto", {
    fetcher: fakeFetcher(fixture("ozlotto-format-change")), log: null
  });
  eq(ctx.era.startDraw, 31, "era startDraw");
  eq(ctx.stats.pool, 47, "stats pool");
  const again = await getOracleContext("ozlotto", { fetcher: fakeFetcher(null), log: null });
  ok(again === ctx, "second call must return the memoised context");
});

await checkAsync("loader: fetch failure throws and is not cached", async () => {
  clearOracleCache();
  let threw = false;
  try {
    await getOracleContext("powerball", { fetcher: fakeFetcher(null, false), log: null });
  } catch { threw = true; }
  ok(threw, "HTTP failure must throw");
  const ctx = await getOracleContext("powerball", {
    fetcher: fakeFetcher(fixture("powerball-format-change")), log: null
  });
  eq(ctx.era.startDraw, 26, "retry after failure must succeed");
  clearOracleCache();
});

/* ------------------------------------------------------------- report */

console.log(`\nThe Oracle predictor validation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
