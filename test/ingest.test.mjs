/* QuickPick AU — ingest validation (H2).
 *
 * Proves the two gates that stand between The Lott's API and data/draws/:
 *   1) toRecord()        — structural gate on every fetched draw. The payloads
 *                          below are the exact ones the external review found
 *                          the old `Number.isInteger(v) && v > 0` test waving
 *                          through: empty arrays, out-of-pool balls, duplicates.
 *   2) validateDataFile() — whole-file gate run on the PARSED BYTES of the
 *                          candidate temp file, before the rename publishes it.
 *                          The headline case is a corrupted MID-HISTORY draw,
 *                          which used to silently truncate the era and commit.
 *
 * No network: toRecord is pure, and validateDataFile is fed the real shipped
 * files plus deliberate mutations of them.
 */

import { readFileSync } from "node:fs";
import { ORACLE_GAMES, ERA_ANCHORS, KNOWN_MATRICES } from "../js/predictor.js";
import { toRecord, validateDataFile, serialize } from "../scripts/update-draws.mjs";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${what} expected ${jb}, got ${ja}`);
}

const realData = (file) =>
  JSON.parse(readFileSync(new URL(`../data/draws/${file}.json`, import.meta.url), "utf8"));

const NO_HOLES = { requests: 0, suspectedHoles: 0 };
const src = { legacy: false };
const api = (over) => ({
  DrawNumber: 5000, DrawDate: "2026-07-25T00:00:00",
  PrimaryNumbers: [3, 11, 19, 24, 31, 42], SecondaryNumbers: [7, 8], ...over
});

/* ------------------------------------------- 1. toRecord — envelope gate */

check("toRecord: rejects a non-object payload", () => {
  ok(toRecord(null, src, "tattslotto").rec === null, "null");
  ok(toRecord("nope", src, "tattslotto").rec === null, "string");
});

check("toRecord: rejects bad draw numbers and dates", () => {
  const bad = [
    [{ DrawNumber: 0 }, "zero draw number"],
    [{ DrawNumber: -1 }, "negative draw number"],
    [{ DrawNumber: 1.5 }, "non-integer draw number"],
    [{ DrawNumber: "5000" }, "string draw number"],
    [{ DrawDate: "not-a-date" }, "unparseable date"],
    [{ DrawDate: "2026-13-45T00:00:00" }, "impossible calendar date"],
    [{ DrawDate: 20260725 }, "numeric date"]
  ];
  for (const [over, what] of bad) {
    ok(toRecord(api(over), src, "tattslotto").rec === null, `must reject: ${what}`);
  }
});

/* --------------------------------------- 2. toRecord — structural gate */

check("toRecord: rejects the exact payloads the old ints() accepted", () => {
  // Every one of these passed `Array.isArray(a) && a.every(Number.isInteger(v) && v > 0)`.
  const hostile = [
    [[], "empty PrimaryNumbers (vacuous .every === true)"],
    [[1, 999999], "ball far outside the pool"],
    [[1, 2, 3, 4, 5, 46], "ball one past the pool"],
    [[5, 5, 5, 5, 5, 5], "six copies of one ball"],
    [[3, 11, 19, 24, 31, 31], "one duplicated ball"],
    [Array.from({ length: 45 }, (_, i) => i + 1), "the whole pool as one draw"],
    [[3, 11, 19, 24, 31], "one short of the matrix"],
    [[3, 11, 19, 24, 31, 42, 43], "one over the matrix"]
  ];
  for (const [PrimaryNumbers, what] of hostile) {
    const { rec, reason } = toRecord(api({ PrimaryNumbers }), src, "tattslotto");
    ok(rec === null, `must reject: ${what}`);
    ok(typeof reason === "string" && reason.length > 0, `must explain: ${what}`);
  }
});

check("toRecord: rejects a supplementary that repeats a main", () => {
  const { rec } = toRecord(api({ SecondaryNumbers: [3, 8] }), src, "tattslotto"); // 3 is a main
  ok(rec === null, "supp duplicating a main must be rejected (one barrel)");
});

check("toRecord: rejects out-of-pool supplementaries", () => {
  ok(toRecord(api({ SecondaryNumbers: [7, 46] }), src, "tattslotto").rec === null, "supp over pool");
});

check("toRecord: powerball demands exactly one secondary", () => {
  const pb = { DrawNumber: 1576, DrawDate: "2026-07-30T00:00:00", PrimaryNumbers: [2, 9, 14, 21, 25, 30, 33] };
  ok(toRecord({ ...pb, SecondaryNumbers: [] }, src, "powerball").rec === null, "zero secondaries");
  ok(toRecord({ ...pb, SecondaryNumbers: [4, 9] }, src, "powerball").rec === null, "two secondaries");
  ok(toRecord({ ...pb, SecondaryNumbers: [21] }, src, "powerball").rec === null, "PB over pool 20");
  const good = toRecord({ ...pb, SecondaryNumbers: [4] }, src, "powerball").rec;
  eq(good, { draw: 1576, date: "2026-07-30", numbers: [2, 9, 14, 21, 25, 30, 33], supps: [], pb: 4 }, "valid PB draw");
});

/* --------------------------- 3. toRecord — every real historical matrix */

check("toRecord: accepts every matrix each game has actually run", () => {
  const cases = [
    ["tattslotto", { PrimaryNumbers: [3, 11, 19, 24, 31, 42], SecondaryNumbers: [7, 8] }],
    ["weekdaywindfall", { PrimaryNumbers: [3, 11, 19, 24, 31, 42], SecondaryNumbers: [7, 8] }],
    // a genuine pre-2004 6/44 draw: valid under 6/45, excluded later by eraFloor
    ["weekdaywindfall", { PrimaryNumbers: [3, 11, 19, 24, 31, 44], SecondaryNumbers: [7, 8] }],
    ["setforlife", { PrimaryNumbers: [3, 11, 19, 24, 31, 42, 44], SecondaryNumbers: [7, 8] }],
    ["ozlotto", { PrimaryNumbers: [3, 11, 19, 24, 31, 42, 47], SecondaryNumbers: [7, 8, 9] }],   // 7/47+3 (current)
    ["ozlotto", { PrimaryNumbers: [3, 11, 19, 24, 31, 42, 45], SecondaryNumbers: [7, 8] }],      // 7/45+2 (retired)
    ["powerball", { PrimaryNumbers: [2, 9, 14, 21, 25, 30, 33], SecondaryNumbers: [4] }],        // 7/35+PB20 (current)
    ["powerball", { PrimaryNumbers: [2, 9, 14, 21, 25, 40], SecondaryNumbers: [4] }],            // 6/40+PB20 (retired)
    ["powerball", { PrimaryNumbers: [2, 9, 14, 21, 45], SecondaryNumbers: [40] }]                // 5/45+PB45 (retired)
  ];
  for (const [gameKey, over] of cases) {
    const { rec, reason } = toRecord(api(over), src, gameKey);
    ok(rec !== null, `${gameKey} ${JSON.stringify(over.PrimaryNumbers)} must be accepted — got: ${reason}`);
  }
});

check("toRecord: sorts mains and supps, and flags legacy records", () => {
  const { rec } = toRecord(api({ PrimaryNumbers: [42, 3, 31, 11, 24, 19], SecondaryNumbers: [8, 7] }),
    { legacy: true }, "weekdaywindfall");
  eq(rec.numbers, [3, 11, 19, 24, 31, 42], "mains sorted ascending");
  eq(rec.supps, [7, 8], "supps sorted ascending");
  eq(rec.legacy, true, "legacy flag carried through");
});

check("KNOWN_MATRICES: index 0 is the current matrix for every game", () => {
  for (const [key, game] of Object.entries(ORACLE_GAMES)) {
    eq(KNOWN_MATRICES[key][0], game.matrix, `${key} current matrix must lead the list`);
  }
});

/* ------------------------------- 4. validateDataFile — real files pass */

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  check(`validateDataFile: shipped ${key}.json passes every ingest gate`, () => {
    const { era, boundary } = validateDataFile(key, game, realData(game.file), NO_HOLES);
    eq(era.startDraw, ERA_ANCHORS[key].startDraw, "era startDraw matches its anchor");
    eq(era.startDate, ERA_ANCHORS[key].startDate, "era startDate matches its anchor");
    eq(boundary, ERA_ANCHORS[key].kind, "boundary kind matches its anchor");
  });
}

check("serialize: round-trips byte-for-byte (validateDataFile reads the bytes)", () => {
  const draws = realData("ozlotto");
  eq(JSON.parse(serialize(draws)), draws, "parse(serialize(x)) === x");
});

/* ----------------------- 5. validateDataFile — the H2 poisoning scenario */

check("validateDataFile: a corrupted MID-HISTORY draw fails at ingest", () => {
  // The review's scenario. TattsLotto has no EXPECTED_ERA_START anchor, so the
  // old code exited 0 here; the era silently truncated and the file committed.
  const draws = realData("tattslotto");
  const victim = Math.floor(draws.length / 2);
  const poisoned = draws.map((d, i) => (i === victim ? { ...d, numbers: [1, 2, 3, 4, 5, 46] } : d));
  let msg = null;
  try { validateDataFile("tattslotto", ORACLE_GAMES.tattslotto, poisoned, NO_HOLES); }
  catch (err) { msg = err.message; }
  ok(msg !== null, "a corrupted mid-history draw must be rejected");
  ok(/era start moved/.test(msg), `must name the era-anchor drift, got: ${msg}`);
  ok(msg.includes(`#${ERA_ANCHORS.tattslotto.startDraw}`), "must quote the anchor it expected");
});

check("validateDataFile: the same poisoning in Weekday Windfall fails too", () => {
  // WW likewise has no EXPECTED_ERA_START anchor — the second silent-pass game.
  const draws = realData("weekdaywindfall");
  const victim = draws.findIndex((d) => d.draw > ERA_ANCHORS.weekdaywindfall.startDraw + 500);
  const poisoned = draws.map((d, i) => (i === victim ? { ...d, numbers: [1, 2, 3, 4, 5] } : d));
  let threw = false;
  try { validateDataFile("weekdaywindfall", ORACLE_GAMES.weekdaywindfall, poisoned, NO_HOLES); }
  catch { threw = true; }
  ok(threw, "corrupted WW mid-history draw must be rejected");
});

check("validateDataFile: era-anchor drift is caught even when the data is well-formed", () => {
  // Dropping the leading era draws leaves a perfectly valid file with a moved
  // era start — exactly what a truncated API response would produce.
  const draws = realData("powerball");
  const eraStart = draws.findIndex((d) => d.draw === ERA_ANCHORS.powerball.startDraw);
  const trimmed = draws.filter((_, i) => i !== eraStart);
  let msg = null;
  try { validateDataFile("powerball", ORACLE_GAMES.powerball, trimmed, NO_HOLES); }
  catch (err) { msg = err.message; }
  ok(msg !== null && /era start moved/.test(msg), `expected anchor drift, got: ${msg}`);
});

check("validateDataFile: rejects non-ascending draw numbers", () => {
  const draws = realData("ozlotto");
  const swapped = draws.slice();
  [swapped[10], swapped[11]] = [swapped[11], swapped[10]];
  let msg = null;
  try { validateDataFile("ozlotto", ORACLE_GAMES.ozlotto, swapped, NO_HOLES); }
  catch (err) { msg = err.message; }
  ok(msg !== null && /not strictly ascending/.test(msg), `expected ordering failure, got: ${msg}`);
});

check("validateDataFile: rejects an empty or non-array file", () => {
  for (const bad of [[], null, {}, "[]"]) {
    let threw = false;
    try { validateDataFile("ozlotto", ORACLE_GAMES.ozlotto, bad, NO_HOLES); } catch { threw = true; }
    ok(threw, `must reject ${JSON.stringify(bad)}`);
  }
});

check("validateDataFile: pool contamination is caught even with the anchor intact", () => {
  // Strip ball 45 from a long era prefix without moving the era start (which is
  // pinned by eraFloor, not by ball 45). This is the 6/44 story, re-planted.
  const draws = realData("weekdaywindfall");
  const floor = ERA_ANCHORS.weekdaywindfall.startDraw;
  let stripped = 0;
  const contaminated = draws.map((d) => {
    if (d.draw < floor || stripped >= 400) return d;
    stripped++;
    const used = new Set(d.numbers.concat(d.supps));
    const swapFor = () => { for (let v = 1; v <= 44; v++) if (!used.has(v)) { used.add(v); return v; } };
    return {
      ...d,
      numbers: d.numbers.map((n) => (n === 45 ? swapFor() : n)).sort((a, b) => a - b),
      supps: d.supps.map((n) => (n === 45 ? swapFor() : n)).sort((a, b) => a - b)
    };
  });
  let msg = null;
  try { validateDataFile("weekdaywindfall", ORACLE_GAMES.weekdaywindfall, contaminated, NO_HOLES); }
  catch (err) { msg = err.message; }
  ok(msg !== null && /hidden narrower pool/.test(msg), `expected coverage failure, got: ${msg}`);
  ok(/ball 45/.test(msg), "must name ball 45");
});

check("validateDataFile: suspected API holes block the write", () => {
  let msg = null;
  try {
    validateDataFile("ozlotto", ORACLE_GAMES.ozlotto, realData("ozlotto"), { requests: 9, suspectedHoles: 2 });
  } catch (err) { msg = err.message; }
  ok(msg !== null && /suspected API hole/.test(msg), `expected hole failure, got: ${msg}`);
});

/* ------------------------------------------------------------- report */

console.log(`\nIngest validation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
