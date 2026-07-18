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
  ORACLE_GAMES, MODES, matchesMatrix, detectEra, classifyBoundary,
  poolCoverageViolations, sanityCheckEraStart, computeStats, oracleWeights,
  unifiedWeights, pickOracle, pickOracleUnified, pickLine, generateLines,
  generateOracleLines, tooltipText, getOracleContext, clearOracleCache
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
  ok(sanityCheckEraStart("setforlife", "2020-03-23").ok, "data-pinned product start");
  ok(!sanityCheckEraStart("ozlotto", "2023-06-01").ok, "a year off must flag");
  eq(sanityCheckEraStart("tattslotto", "1997-02-01"), null, "no anchor for tattslotto");
});

check("eraFloor: clamps the era below a same-counts pool alignment", () => {
  // 6/44-style contamination is invisible to matrix matching — the floor cuts it.
  const mk = (i, hi) => ({ draw: i, date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`, numbers: [1, 2, 3, hi], supps: [], pb: null });
  const list = [];
  for (let i = 1; i <= 10; i++) list.push(mk(i, 44));           // narrow-pool era
  for (let i = 11; i <= 25; i++) list.push(mk(i, i === 11 ? 45 : 44)); // aligned era
  const m = { pool: 45, drawn: 4, supps: 0, pb: null };
  const noFloor = detectEra(list, m);
  eq(noFloor.total, 25, "without a floor the whole span matches");
  eq(noFloor.boundaryKind, "edge", "no matrix change visible");
  const floored = detectEra(list, m, { eraFloor: { draw: 11, date: "x", reason: "test alignment" } });
  eq(floored.startDraw, 11, "floored startDraw");
  eq(floored.total, 15, "floored total");
  eq(floored.flooredOut, 10, "flooredOut count");
  eq(floored.boundaryKind, "floor", "boundaryKind floor");
});

check("poolCoverageViolations: catches a hidden 6/44-style window", () => {
  const m = { pool: 45, drawn: 6, supps: 0, pb: null };
  const narrow = [];
  for (let i = 0; i < 120; i++) {
    const base = (i * 6) % 44;
    narrow.push({ draw: i + 1, date: "2026-01-01", numbers: Array.from({ length: 6 }, (_, k) => ((base + k) % 44) + 1), supps: [], pb: null });
  }
  const hits = poolCoverageViolations(narrow, m);
  eq(hits.map((h) => h.ball), [45], "exactly ball 45 flagged");
  ok(hits[0].absentPrefix === 120 && hits[0].probability < 1e-6, "prefix + probability");
  // same data with ball 45 present early — clean
  const aligned = narrow.map((d, i) => (i === 3 ? { ...d, numbers: [45, ...d.numbers.slice(1)] } : d));
  eq(poolCoverageViolations(aligned, m), [], "no violation once 45 appears early");
});

check("countSupps knob: default off, on adds supp observations", () => {
  const draws = [
    { draw: 1, date: "2026-01-01", numbers: [1, 2], supps: [3, 4], pb: null },
    { draw: 2, date: "2026-01-02", numbers: [1, 5], supps: [3, 6], pb: null }
  ];
  const off = computeStats(draws, 8);
  eq(off.freq.slice(1), [2, 1, 0, 0, 1, 0, 0, 0], "default: mains only (unchanged behaviour)");
  const on = computeStats(draws, 8, { countSupps: true });
  eq(on.freq.slice(1), [2, 1, 2, 1, 1, 1, 0, 0], "countSupps=true adds supps");
  eq(on.gap.slice(1), [0, 1, 0, 1, 0, 0, 2, 2], "gap tracks supp appearances too");
});

/* -------------------------------------------- 2. era detection: real data */

const REAL_PINS = [
  // [game, exact startDraw, exact startDate, minimum era draws, boundary kind]
  // Anchors per doctrine: PB #1144 (2018-04-19), Oz #1474 (2022-05-17),
  // SfL first 7/44 draw #1691 (2020-03-23), WW 6/45-alignment floor #2303.
  ["powerball", 1144, "2018-04-19", 400, "matrix"],
  ["ozlotto", 1474, "2022-05-17", 200, "matrix"],
  ["setforlife", 1691, "2020-03-23", 2300, "matrix"], // edge refined by anchor
  ["weekdaywindfall", 2303, "2004-05-12", 2400, "floor"],
  ["tattslotto", 1621, "1997-02-01", 1500, "edge"]    // available history, NOT a format boundary
];

for (const [key, startDraw, startDate, minTotal, kind] of REAL_PINS) {
  check(`real data: ${key} era pin #${startDraw} ${startDate} (${kind})`, () => {
    const game = ORACLE_GAMES[key];
    const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
    eq(era.startDraw, startDraw, "startDraw");
    eq(era.startDate, startDate, "startDate");
    ok(era.total >= minTotal, `era total ${era.total} < ${minTotal}`);
    eq(classifyBoundary(key, era), kind, "boundary classification");
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
    const era = detectEra(draws, game.matrix, { eraFloor: game.eraFloor });
    ok(era.total > 100, "era non-trivial");
    for (const d of era.draws) {
      ok(matchesMatrix(d, game.matrix), `era draw #${d.draw} violates matrix`);
    }
    eq(poolCoverageViolations(era.draws, game.matrix), [],
      "no hidden narrower pool inside the era");
  });
}

check("real data: weekday legacy split, 6/44 floor, first MWF draw pin", () => {
  const draws = realData("weekdaywindfall");
  const legacy = draws.filter((d) => d.legacy);
  const current = draws.filter((d) => !d.legacy);
  ok(legacy.length > 2500, `legacy count ${legacy.length}`);
  ok(current.length > 300, `current count ${current.length}`);
  ok(legacy.every((d) => d.date < "2024-05-20"), "legacy draws after rebrand date");
  ok(current.every((d) => d.date >= "2024-05-20"), "current draws before rebrand date");
  eq(current[0].draw, 4392, "first Weekday Windfall draw is #4392");
  eq(current[0].date, "2024-05-20", "first Weekday Windfall draw date");
  const game = ORACLE_GAMES.weekdaywindfall;
  const era = detectEra(draws, game.matrix, { eraFloor: game.eraFloor });
  eq(era.flooredOut, 665, "665 pre-alignment 6/44 draws excluded by the floor");
  // the pre-floor window is REAL 6/44 contamination: ball 45 never appears there
  const preFloor = draws.filter((d) => d.draw < game.eraFloor.draw);
  ok(preFloor.every((d) => !d.numbers.concat(d.supps).includes(45)),
    "no ball 45 below the floor (the 6/44 window)");
  ok(era.draws[0].numbers.concat(era.draws[0].supps).includes(45),
    "floor sits on the first ball-45-evidenced draw");
  const withoutFloor = detectEra(draws, game.matrix);
  ok(poolCoverageViolations(withoutFloor.draws, game.matrix).some((v) => v.ball === 45),
    "coverage scan would flag ball 45 if the floor were removed");
  eq(detectEra(draws, game.matrix, { includeLegacy: false, eraFloor: game.eraFloor }).total,
    current.length, "current-only era unaffected by the floor");
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

check("tooltip: both unified signals, doctrine wording", () => {
  const s = computeStats(TINY, 10);
  eq(tooltipText(s, 1), "drawn 5× · last seen 0 draws ago", "hot ball");
  eq(tooltipText(s, 3), "drawn 1× · last seen 4 draws ago", "stale ball");
  eq(tooltipText(s, 9), "drawn 0× · not yet seen this era", "never-seen ball");
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
  const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
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

/* --------------------------------------------- 5. unified oracle (shipped) */

check("unified: exact weight formula (1 + 0.35·normFreq + 0.15·normGap)", () => {
  const s = computeStats(TINY, 10);
  // freq [5,4,1,1,1,1,1,1,0,0] span 5; gap [0,0,4,3,2,2,1,0,5,5] span 5
  const w = unifiedWeights(s);
  eq(w[1], 1.35, "hottest + just seen: 1 + 0.35·1 + 0.15·0");
  eq(w[2], 1 + 0.35 * (4 / 5), "ball 2");
  eq(w[3], 1 + 0.35 * (1 / 5) + 0.15 * (4 / 5), "ball 3 mixes both signals");
  eq(w[8], 1 + 0.35 * (1 / 5), "ball 8: min gap contributes 0");
  eq(w[9], 1.15, "never drawn + most overdue: 1 + 0 + 0.15·1");
  const flat = computeStats([{ draw: 1, date: "2026-01-01", numbers: [1, 2], supps: [], pb: null }], 2);
  eq(unifiedWeights(flat).slice(1), [1, 1], "zero spans → all weights 1");
});

check("unified: effective max/min weight ratio ≤ ~1.5 (TINY + every real game)", () => {
  const ratioOf = (s) => {
    const w = unifiedWeights(s).slice(1);
    return Math.max(...w) / Math.min(...w);
  };
  ok(ratioOf(computeStats(TINY, 10)) <= 1.5 + 1e-9, "TINY ratio");
  for (const [key, game] of Object.entries(ORACLE_GAMES)) {
    const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
    const r = ratioOf(computeStats(era.draws, game.matrix.pool));
    ok(r <= 1.5 + 1e-9 && r >= 1, `${key} ratio ${r.toFixed(4)} outside [1, 1.5]`);
  }
});

/* Upper-tail chi-square critical value, Wilson–Hilferty (as in rng.test).
 * α = 0.001 so the weekly Action doesn't flake; with 100k samples a real
 * weighting bug lands orders of magnitude past any critical value. */
function chiCrit999(df) {
  const z = 3.0902323061678132; // Phi^-1(0.999)
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

function chiSquareUnified(stats, samples) {
  const w = unifiedWeights(stats);
  let wSum = 0;
  for (let n = 1; n <= stats.pool; n++) wSum += w[n];
  const counts = new Array(stats.pool + 1).fill(0);
  for (let i = 0; i < samples; i++) counts[pickOracleUnified(stats, 1)[0]]++;
  let chi2 = 0;
  for (let n = 1; n <= stats.pool; n++) {
    const expected = (samples * w[n]) / wSum;
    const d = counts[n] - expected;
    chi2 += (d * d) / expected;
  }
  return { chi2, counts, df: stats.pool - 1 };
}

check("unified: chi-square over 100k samples matches the weights (pool 10)", () => {
  const { chi2, counts, df } = chiSquareUnified(computeStats(TINY, 10), 100_000);
  const crit = chiCrit999(df);
  ok(chi2 < crit, `chi² ${chi2.toFixed(2)} ≥ crit999 ${crit.toFixed(2)} (df ${df})`);
  ok(counts.slice(1).every((c) => c > 0), "no ball excluded across 100k samples");
});

check("unified: chi-square over 100k samples on real TattsLotto stats (pool 45)", () => {
  const game = ORACLE_GAMES.tattslotto;
  const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
  const { chi2, counts, df } = chiSquareUnified(computeStats(era.draws, 45), 100_000);
  const crit = chiCrit999(df);
  ok(chi2 < crit, `chi² ${chi2.toFixed(2)} ≥ crit999 ${crit.toFixed(2)} (df ${df})`);
  ok(counts.slice(1).every((c) => c > 0), "no ball excluded across 100k samples");
});

check("unified: full-pool draw returns every ball — nothing is excludable", () => {
  const s = computeStats(TINY, 10);
  eq(pickOracleUnified(s, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "k = pool");
});

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  check(`unified output: ${key} contract`, () => {
    const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
    const stats = computeStats(era.draws, game.matrix.pool);
    const lines = generateOracleLines(stats, game);
    eq(lines.length, EXPECTED_SHAPE[key].lines, "line count");
    for (const line of lines) {
      eq(line.length, EXPECTED_SHAPE[key].picks, "picks per line");
      ok(line.every((n) => Number.isInteger(n) && n >= 1 && n <= game.matrix.pool), `out of range: ${line}`);
      eq(new Set(line).size, line.length, "unique within line");
      for (let i = 1; i < line.length; i++) ok(line[i] > line[i - 1], "sorted ascending");
    }
  });
}

check("unified: set for life lines are independent (overlap occurs, like real QuickPicks)", () => {
  const game = ORACLE_GAMES.setforlife;
  const era = detectEra(realData(game.file), game.matrix);
  const stats = computeStats(era.draws, game.matrix.pool);
  let overlapped = 0;
  for (let i = 0; i < 30; i++) {
    const [a, b] = generateOracleLines(stats, game);
    const setA = new Set(a);
    if (b.some((n) => setA.has(n))) overlapped++;
  }
  // P(two independent 7-of-44 lines disjoint) ≈ 0.30 → P(0 overlaps in 30) ≈ 2e-16
  ok(overlapped > 0, "30 independent pairs never overlapped — draws look forced-disjoint");
});

/* ----------------------------------- 6. legacy oracle weighting (exported) */

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

/* ------------------------------------------------------- 7. data loader */

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
