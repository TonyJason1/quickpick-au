/* QuickPick AU — sampler distribution at the pick counts that ship.
 *
 * The existing chi-square test (predictor.test.mjs) samples k = 1 against raw
 * normalised weight shares. That is EXACTLY correct there: with a single ball
 * drawn there is no without-replacement effect and the marginal is w[n]/Σw.
 * It is left untouched.
 *
 * But the app draws k = 6..20, and pickWeighted is a successive-sampling
 * scheme whose marginals are compressed toward uniform relative to
 * k · w[n] / Σw. So the k=1 result says nothing about the shipped path, and a
 * naive extension of it would red-flag correct code at the System cap.
 *
 * This file compares the sampler against Monte Carlo reference marginals
 * pinned in test/fixtures/marginals.json (10M draws per case), generated from
 * FROZEN era stats so the weekly data commit cannot drift the reference.
 *
 * Test statistic: per-ball binomial z. Draws are iid, so each ball's inclusion
 * count is exactly Binomial(N, pi_n) — the correlation between balls within a
 * draw does not affect a per-ball marginal test. Threshold is the two-sided
 * Bonferroni-corrected normal quantile at family alpha = 0.001 across the pool.
 */

import { readFileSync } from "node:fs";
import { ORACLE_GAMES, pickOracleUnified, unifiedWeights } from "../js/predictor.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/marginals.json", import.meta.url), "utf8")
);

const N = 100_000;
const FAMILY_ALPHA = 0.001;

/* Inverse standard-normal CDF (Acklam); |error| < 1.15e-9 on (0,1). */
function invNorm(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Bonferroni-corrected two-sided z threshold across `pool` simultaneous tests. */
const zCrit = (pool) => invNorm(1 - FAMILY_ALPHA / (2 * pool));

/** Empirical inclusion counts over N independent draws of k balls. */
function inclusionCounts(stats, k) {
  const counts = new Array(stats.pool + 1).fill(0);
  for (let i = 0; i < N; i++) {
    for (const n of pickOracleUnified(stats, k)) counts[n]++;
  }
  return counts;
}

/** Worst per-ball binomial z of `counts` against expected probabilities `p`. */
function worstZ(counts, p, pool) {
  let maxZ = 0, ball = 0;
  for (let n = 1; n <= pool; n++) {
    const pn = p[n - 1];
    const se = Math.sqrt((pn * (1 - pn)) / N);
    const z = Math.abs(counts[n] / N - pn) / se;
    if (z > maxZ) { maxZ = z; ball = n; }
  }
  return { maxZ, ball };
}

/* ------------------------------------------------- fixture is coherent */

check("fixture covers the default and the System cap for every game", () => {
  for (const [key, game] of Object.entries(ORACLE_GAMES)) {
    const ks = fixture.cases.filter((c) => c.game === key).map((c) => c.k).sort((x, y) => x - y);
    const want = [...new Set([game.picks, game.maxPicks])].sort((x, y) => x - y);
    ok(JSON.stringify(ks) === JSON.stringify(want),
      `${key}: fixture has k=[${ks}], expected [${want}]`);
  }
  ok(fixture.samples >= 1e7, `reference needs >= 10M draws per case, got ${fixture.samples}`);
});

check("reference marginals sum to k and stay inside the weight cap", () => {
  for (const c of fixture.cases) {
    const sum = c.marginals.reduce((a, b) => a + b, 0);
    ok(Math.abs(sum - c.k) < 0.002,
      `${c.label}: marginals sum to ${sum.toFixed(4)}, must equal k=${c.k}`);
    const w = unifiedWeights(c.stats).slice(1);
    const ratio = Math.max(...w) / Math.min(...w);
    ok(ratio <= 1.5 + 1e-9 && ratio >= 1,
      `${c.label}: frozen stats give weight ratio ${ratio.toFixed(4)}, outside [1, 1.5]`);
  }
});

/* --------------------------------- the guard: sampler vs reference */

for (const c of fixture.cases) {
  check(`${c.label} — 100k draws match the 10M successive-sampling reference`, () => {
    const counts = inclusionCounts(c.stats, c.k);
    const { maxZ, ball } = worstZ(counts, c.marginals, c.stats.pool);
    const crit = zCrit(c.stats.pool);
    ok(maxZ < crit,
      `worst deviation |z| = ${maxZ.toFixed(2)} at ball ${ball} exceeds the ` +
      `Bonferroni threshold ${crit.toFixed(2)} (family alpha ${FAMILY_ALPHA}, pool ${c.stats.pool})`);
    ok(counts.slice(1).every((x) => x > 0), "every ball must appear at least once");
  });
}

/* ------------- why raw weight shares are not the right expectation */

check("raw weight shares are demonstrably WRONG at the System cap", () => {
  // This is the control that justifies the fixture existing at all. If the
  // naive expectation were adequate, a Monte Carlo reference would be dead
  // weight -- so assert it genuinely fails where the review measured it does.
  const caps = fixture.cases.filter((c) => c.k === ORACLE_GAMES[c.game].maxPicks && c.k >= 20);
  ok(caps.length > 0, "expected at least one k=20 cap case");

  for (const c of caps) {
    const w = unifiedWeights(c.stats);
    const wSum = w.slice(1).reduce((a, b) => a + b, 0);
    const naive = w.slice(1).map((x) => (c.k * x) / wSum);

    const counts = inclusionCounts(c.stats, c.k);
    const againstNaive = worstZ(counts, naive, c.stats.pool);
    const againstRef = worstZ(counts, c.marginals, c.stats.pool);
    const crit = zCrit(c.stats.pool);

    ok(againstNaive.maxZ > crit,
      `${c.label}: naive k*w/sum(w) should be rejected but |z| was only ${againstNaive.maxZ.toFixed(2)} (crit ${crit.toFixed(2)})`);
    ok(againstRef.maxZ < againstNaive.maxZ,
      `${c.label}: the reference must fit better than the naive model`);
    console.log(
      `      ${c.label}: |z| vs reference ${againstRef.maxZ.toFixed(2)}, ` +
      `vs raw weight shares ${againstNaive.maxZ.toFixed(1)} (crit ${crit.toFixed(2)}) — ` +
      `naive worst per-ball error ${(c.naiveWorstRelativeError * 100).toFixed(2)}%`
    );
  }
});

check("the compression is real but small at the shipped default", () => {
  // Reported, not asserted as a pass/fail: the review measured chi-square 57.1
  // vs crit 78.83 at k=7, i.e. the naive model is wrong yet UNDETECTABLE at
  // n=100k. Pinning that borderline result would make the suite flaky; the
  // useful invariant is simply that the error is bounded and non-zero.
  for (const c of fixture.cases.filter((x) => x.k === ORACLE_GAMES[x.game].picks)) {
    ok(c.naiveWorstRelativeError > 0,
      `${c.label}: expected a non-zero without-replacement effect`);
    ok(c.naiveWorstRelativeError < 0.05,
      `${c.label}: naive error ${(c.naiveWorstRelativeError * 100).toFixed(2)}% is larger than expected under the 1.5x cap`);
    console.log(`      ${c.label}: naive share off by up to ${(c.naiveWorstRelativeError * 100).toFixed(2)}% per ball`);
  }
});

/* ------------------------------------------------------------- report */

console.log(`\nSuccessive-sampling marginals: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
