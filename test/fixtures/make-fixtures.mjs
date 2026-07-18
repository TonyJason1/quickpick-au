/* Regenerates the synthetic era-detection fixtures in this directory.
 * Deterministic (fixed-seed LCG — fixtures only, NOT the app RNG), so
 * re-running produces byte-identical files:  node test/fixtures/make-fixtures.mjs
 *
 * Each fixture contains a mid-history format change so tests can prove the
 * era auto-detection finds the exact boundary:
 *   ozlotto-format-change:    7/45 + 2 supps → 7/47 + 3 supps at draw #31
 *   powerball-format-change:  6/40 + PB     → 7/35 + PB      at draw #26
 *   setforlife-format-change: 8/37 + 0 supps → 7/44 + 2 supps at draw #21
 *   weekdaywindfall-legacy:   15 legacy-flagged + 10 current draws, same 6/45
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let seed = 42;
function rnd(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
}

/** k unique ints from 1..pool (partial Fisher–Yates on the LCG), sorted. */
function lcgDraw(pool, k) {
  const arr = Array.from({ length: pool }, (_, i) => i + 1);
  for (let i = 0; i < k; i++) {
    const j = i + rnd(pool - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k).sort((a, b) => a - b);
}

function isoAfter(baseISO, days) {
  const d = new Date(`${baseISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function record(draw, date, mains, supps, pb, legacy) {
  const r = { draw, date, numbers: mains, supps, pb };
  if (legacy) r.legacy = true;
  return r;
}

function serialize(draws) {
  return "[\n" + draws.map((d) => JSON.stringify(d)).join(",\n") + "\n]\n";
}

const DIR = fileURLToPath(new URL("./", import.meta.url));
function emit(name, draws) {
  writeFileSync(`${DIR}${name}.json`, serialize(draws), "utf8");
  console.log(`${name}.json — ${draws.length} draws`);
}

/* Oz Lotto: 30 old-era + 40 new-era. Draw #31 (first new) is forced to
 * contain 46 and 47 so the wider pool is visible in the data itself. */
{
  const draws = [];
  for (let i = 1; i <= 30; i++) {
    const balls = lcgDraw(45, 9);
    draws.push(record(i, isoAfter("2021-10-05", (i - 1) * 7), balls.slice(0, 7), balls.slice(7, 9), null));
  }
  for (let i = 31; i <= 70; i++) {
    let mains, supps;
    if (i === 31) {
      mains = [...lcgDraw(45, 5), 46, 47];
      supps = lcgDraw(45, 3);
      while (supps.some((s) => mains.includes(s))) supps = lcgDraw(45, 3);
    } else {
      const balls = lcgDraw(47, 10);
      mains = balls.slice(0, 7).sort((a, b) => a - b);
      supps = balls.slice(7, 10).sort((a, b) => a - b);
    }
    draws.push(record(i, isoAfter("2022-05-17", (i - 31) * 7), mains.sort((a, b) => a - b), supps, null));
  }
  emit("ozlotto-format-change", draws);
}

/* Powerball: 25 old-era (6/40 + PB) + 35 new-era (7/35 + PB). */
{
  const draws = [];
  for (let i = 1; i <= 25; i++) {
    draws.push(record(i, isoAfter("2017-10-26", (i - 1) * 7), lcgDraw(40, 6), [], 1 + rnd(20)));
  }
  for (let i = 26; i <= 60; i++) {
    draws.push(record(i, isoAfter("2018-04-19", (i - 26) * 7), lcgDraw(35, 7), [], 1 + rnd(20)));
  }
  emit("powerball-format-change", draws);
}

/* Set for Life: 20 old-era (8/37, no supps) + 30 new-era (7/44 + 2 supps). */
{
  const draws = [];
  for (let i = 1; i <= 20; i++) {
    draws.push(record(i, isoAfter("2020-07-14", i - 1), lcgDraw(37, 8), [], null));
  }
  for (let i = 21; i <= 50; i++) {
    const balls = lcgDraw(44, 9);
    draws.push(record(i, isoAfter("2020-08-03", i - 21), balls.slice(0, 7).sort((a, b) => a - b), balls.slice(7, 9).sort((a, b) => a - b), null));
  }
  emit("setforlife-format-change", draws);
}

/* Weekday Windfall: same 6/45 matrix across the Mon & Wed Lotto rebrand —
 * only the legacy flag separates the eras. */
{
  const draws = [];
  for (let i = 1; i <= 15; i++) {
    const balls = lcgDraw(45, 8);
    draws.push(record(i, isoAfter("2024-01-01", (i - 1) * 3), balls.slice(0, 6).sort((a, b) => a - b), balls.slice(6, 8).sort((a, b) => a - b), null, true));
  }
  for (let i = 16; i <= 25; i++) {
    const balls = lcgDraw(45, 8);
    draws.push(record(i, isoAfter("2024-05-20", (i - 16) * 2), balls.slice(0, 6).sort((a, b) => a - b), balls.slice(6, 8).sort((a, b) => a - b), null));
  }
  emit("weekdaywindfall-legacy", draws);
}
