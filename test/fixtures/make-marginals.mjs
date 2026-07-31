/* Regenerate test/fixtures/marginals.json — successive-sampling reference
 * marginals for the unified Oracle sampler at the pick counts that actually
 * ship.
 *
 *   npm run marginals        (~4 minutes)
 *
 * WHY THIS EXISTS
 *
 * pickWeighted proposes a ball uniformly, rejects it if already picked, and
 * otherwise accepts with probability w/wMax. That is SUCCESSIVE SAMPLING
 * (Wallenius-type), not weight-proportional sampling. Its per-ball inclusion
 * probabilities are compressed toward uniform relative to the naive
 * k · w[n] / Σw, and the compression grows with k.
 *
 * The existing chi-square test samples k = 1, where no without-replacement
 * effect exists and the raw weight share IS exactly correct. That test is
 * right and stays as it is — but it says nothing about the k = 6..20 the app
 * actually draws. Measured on real TattsLotto stats:
 *
 *   k = 7   naive expectation is wrong by at most 1.60% per ball;
 *           chi-square 57.1 vs crit(0.999) 78.83 — UNDETECTABLE at n = 100k
 *   k = 20  chi-square 746.4 vs 78.83 — wrong by a factor of 9.5
 *
 * So a naive extension of the k=1 test to realistic k would pass at the
 * default and red-flag CORRECT code at the System cap. Hence a Monte Carlo
 * reference instead of a closed form.
 *
 * FROZEN STATS
 *
 * The fixture stores the era stats it was generated from, not just the
 * marginals. The test replays the sampler against those frozen stats, so the
 * weekly data commit cannot drift the reference and flake the suite. This is a
 * test of the SAMPLER, which is data-independent; the adjacency tests already
 * exercise live era stats.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  ORACLE_GAMES, computeStats, detectEra, pickOracleUnified, unifiedWeights
} from "../../js/predictor.js";

const SAMPLES = 10_000_000;

const realData = (file) =>
  JSON.parse(readFileSync(new URL(`../../data/draws/${file}.json`, import.meta.url), "utf8"));

/** Monte Carlo inclusion probability per ball at a given k. */
function marginals(stats, k, samples) {
  const counts = new Array(stats.pool + 1).fill(0);
  for (let i = 0; i < samples; i++) {
    const line = pickOracleUnified(stats, k);
    for (const n of line) counts[n]++;
  }
  return counts.slice(1).map((c) => c / samples);
}

const cases = [];
const started = Date.now();

for (const [key, game] of Object.entries(ORACLE_GAMES)) {
  const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
  const stats = computeStats(era.draws, game.matrix.pool);
  const w = unifiedWeights(stats);
  const wSum = w.slice(1).reduce((a, b) => a + b, 0);

  // default and System cap; Set for Life pins both at 7, so dedupe.
  for (const k of [...new Set([game.picks, game.maxPicks])]) {
    const t0 = Date.now();
    const pi = marginals(stats, k, SAMPLES);
    const naive = w.slice(1).map((x) => (k * x) / wSum);
    const worst = pi.reduce(
      (acc, p, i) => Math.max(acc, Math.abs(p - naive[i]) / naive[i]), 0
    );
    cases.push({
      game: key,
      label: `${game.name} k=${k}${k === game.picks ? " (default)" : " (System cap)"}`,
      k,
      stats: {
        pool: stats.pool, total: stats.total,
        freq: stats.freq, gap: stats.gap,
        minFreq: stats.minFreq, maxFreq: stats.maxFreq,
        minGap: stats.minGap, maxGap: stats.maxGap
      },
      eraStart: era.startDate,
      eraDraws: era.total,
      marginals: pi.map((p) => Number(p.toFixed(7))),
      naiveWorstRelativeError: Number(worst.toFixed(6))
    });
    console.log(
      `${key.padEnd(16)} k=${String(k).padStart(2)}  ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
      `naive share off by up to ${(worst * 100).toFixed(2)}%`
    );
  }
}

const out = {
  note: "Successive-sampling reference marginals. Regenerate with `npm run marginals`. " +
        "Stats are frozen on purpose so weekly data updates cannot flake the test.",
  samples: SAMPLES,
  generatedFromEra: Object.fromEntries(cases.map((c) => [c.game, `${c.eraStart} (${c.eraDraws} draws)`])),
  cases
};
const target = new URL("./marginals.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`, "utf8");

console.log(
  `\nwrote ${cases.length} cases x ${SAMPLES.toLocaleString()} draws ` +
  `in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min -> test/fixtures/marginals.json`
);
