/* QuickPick AU — "The Oracle" predictor core.
 *
 * Era-filtered draw statistics + four pick modes (HOT / COLD / OVERDUE /
 * ORACLE) for the five supported games. Pure ES module — runs in the browser
 * and under Node (tests, scripts/update-draws.mjs) with no DOM dependency.
 *
 * Selection entropy is ALWAYS rng.js (crypto.getRandomValues, rejection
 * sampling). Historical stats only shape rankings/weights — they cannot make
 * any combination more likely to win. Every combination has identical odds.
 *
 * Data format (data/draws/<game>.json), sorted ascending by draw number:
 *   [{ "draw": 1621, "date": "1997-02-01", "numbers": [6 sorted ints],
 *      "supps": [ints], "pb": int|null, "legacy": true? }, ...]
 * `legacy: true` marks Weekday Windfall draws inherited from the Mon & Wed
 * Lotto product (same 6/45 matrix, rebranded May 2024).
 *
 * ERA FILTER: stats are computed ONLY over the current-matrix era — the
 * longest contiguous run of draws matching the game's current matrix, ending
 * at the latest draw. Mixing in retired matrices (e.g. Powerball 6/40
 * pre-2018, Set for Life 8/37 pre-2020, Oz Lotto 7/45+2supps pre-2022) would
 * poison the frequencies, so pre-era draws are discarded. Stats count MAIN
 * numbers only — supplementaries and the Powerball are excluded.
 */

import { secureInt, shuffled } from "../rng.js";

/* ------------------------------------------------------------ game config */

/** Current matrices + Tony's play formats (picks per line, lines per play). */
export const ORACLE_GAMES = {
  tattslotto: {
    name: "TattsLotto", file: "tattslotto",
    matrix: { pool: 45, drawn: 6, supps: 2, pb: null },
    picks: 7, lines: 1
  },
  ozlotto: {
    name: "Oz Lotto", file: "ozlotto",
    matrix: { pool: 47, drawn: 7, supps: 3, pb: null },
    picks: 8, lines: 1
  },
  powerball: {
    name: "Powerball", file: "powerball",
    matrix: { pool: 35, drawn: 7, supps: 0, pb: 20 },
    // PowerHit play: pick 7 mains only — every one of the 20 Powerballs is covered.
    picks: 7, lines: 1, powerhit: true
  },
  setforlife: {
    name: "Set for Life", file: "setforlife",
    matrix: { pool: 44, drawn: 7, supps: 2, pb: null },
    picks: 7, lines: 2
  },
  weekdaywindfall: {
    name: "Weekday Windfall", file: "weekdaywindfall",
    matrix: { pool: 45, drawn: 6, supps: 2, pb: null },
    picks: 7, lines: 1, hasLegacy: true,
    /* Mon & Wed Lotto ran a 6/44 pool until the May 2004 national alignment.
     * 6/44 draws pass every 6/45 bounds check (44 ⊂ 45, same counts), so
     * matrix matching alone cannot see the boundary — but ball 45 never
     * appears in the 665 draws before #2303 (P ≈ 10^-53 under 6/45).
     * The era is therefore floored at the first ball-45-evidenced draw;
     * at most a draw or two of genuine 6/45 history is discarded. */
    eraFloor: { draw: 2303, date: "2004-05-12", reason: "Mon & Wed Lotto 6/44 → 6/45 pool alignment" }
  }
};

export const MODES = ["hot", "cold", "overdue", "oracle"];

/* Approximate known matrix-change dates — sanity anchors for the era
 * auto-detection, NOT cutoffs. Detection is always data-driven; a detected
 * boundary further than ERA_TOLERANCE_DAYS from its anchor logs a warning. */
export const EXPECTED_ERA_START = {
  powerball: "2018-04-19",  // 6/40 + PB → 7/35 + PB
  setforlife: "2020-03-23", // 8/37 → 7/44 (SetForLife744 product start — data-pinned)
  ozlotto: "2022-05-01"     // 7/45 + 2 supps → 7/47 + 3 supps
};
const ERA_TOLERANCE_DAYS = 200;

/* ---------------------------------------------------------- era detection */

function isIntIn(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/** True when a single draw record conforms to the given matrix. */
export function matchesMatrix(d, m) {
  if (!d || !Array.isArray(d.numbers) || d.numbers.length !== m.drawn) return false;
  const supps = Array.isArray(d.supps) ? d.supps : [];
  if (supps.length !== m.supps) return false;
  const all = d.numbers.concat(supps);
  if (new Set(all).size !== all.length) return false; // one barrel — no repeats
  for (const v of all) if (!isIntIn(v, 1, m.pool)) return false;
  if (m.pb != null) return isIntIn(d.pb, 1, m.pb);
  return d.pb == null;
}

/**
 * Auto-detect the current-matrix era: walk back from the latest draw while
 * records keep matching `matrix`; the era is that contiguous tail run.
 * Count changes (Powerball 6→7 mains, SfL 8→7, Oz supps 2→3) stop the walk
 * at the true boundary. Throws when the LATEST draw doesn't match — that
 * means the game changed format and ORACLE_GAMES needs updating, which must
 * fail loudly rather than silently compute stats on a stale matrix.
 */
export function detectEra(draws, matrix, { includeLegacy = true, eraFloor = null } = {}) {
  const scoped = (includeLegacy ? draws.slice() : draws.filter((d) => !d.legacy))
    .sort((a, b) => a.draw - b.draw);
  // eraFloor: hard lower bound for pool changes that widen within the same
  // counts (e.g. 6/44 → 6/45) — invisible to per-draw matrix matching.
  const list = eraFloor ? scoped.filter((d) => d.draw >= eraFloor.draw) : scoped;
  const flooredOut = scoped.length - list.length;
  if (!list.length) throw new Error("detectEra: no draws");
  if (!matchesMatrix(list[list.length - 1], matrix)) {
    throw new Error(
      "detectEra: latest draw does not match the configured matrix — " +
      "the game format may have changed; update ORACLE_GAMES"
    );
  }
  let start = list.length - 1;
  while (start > 0 && matchesMatrix(list[start - 1], matrix)) start--;
  const era = list.slice(start);
  /* boundaryKind:
   *   "matrix" — the walk stopped on a shape change: a REAL format boundary.
   *   "floor"  — the start is an eraFloor pool-alignment anchor.
   *   "edge"   — the era spans all available data: the API's published
   *              history starts here, NOT necessarily the matrix era. Callers
   *              must not present this as a format boundary (see
   *              classifyBoundary for anchor-based refinement). */
  const boundaryKind = start > 0 ? "matrix" : flooredOut > 0 ? "floor" : "edge";
  return {
    draws: era,
    startDraw: era[0].draw,
    startDate: era[0].date,
    startYear: Number(era[0].date.slice(0, 4)),
    total: era.length,
    discardedOlder: start,
    flooredOut,
    boundaryKind
  };
}

/**
 * Final boundary classification for display: an "edge" era whose start sits
 * on a known matrix-change anchor IS a matrix boundary (Set for Life — the
 * 7/44 product begins exactly at the relaunch). An unanchored "edge" is just
 * available-history depth (TattsLotto: 6/45 since 1985, API depth 1997).
 */
export function classifyBoundary(gameKey, era) {
  if (era.boundaryKind !== "edge") return era.boundaryKind;
  const sanity = sanityCheckEraStart(gameKey, era.startDate);
  return sanity && sanity.ok ? "matrix" : "edge";
}

/**
 * Pool-contamination scan: for each ball, the longest era PREFIX in which it
 * never appears (mains + supps). A hidden narrower pool (the 6/44 story)
 * shows up as an absurdly long absent prefix for the top ball(s). Returns
 * violations where P(absence | true pool) < maxProbability.
 */
export function poolCoverageViolations(eraDraws, matrix, maxProbability = 1e-6) {
  const perDraw = matrix.drawn + matrix.supps;
  const missChance = 1 - perDraw / matrix.pool;
  const firstSeen = new Array(matrix.pool + 1).fill(-1);
  eraDraws.forEach((d, i) => {
    for (const n of d.numbers.concat(d.supps || [])) {
      if (firstSeen[n] === -1) firstSeen[n] = i;
    }
  });
  const violations = [];
  for (let n = 1; n <= matrix.pool; n++) {
    const prefix = firstSeen[n] === -1 ? eraDraws.length : firstSeen[n];
    const probability = Math.pow(missChance, prefix);
    if (probability < maxProbability) violations.push({ ball: n, absentPrefix: prefix, probability });
  }
  return violations;
}

/** Compare a detected era start against its approximate known anchor. */
export function sanityCheckEraStart(gameKey, startDate) {
  const expected = EXPECTED_ERA_START[gameKey];
  if (!expected) return null;
  const deltaDays = Math.round(
    Math.abs(Date.parse(startDate) - Date.parse(expected)) / 86400000
  );
  return { expected, deltaDays, ok: deltaDays <= ERA_TOLERANCE_DAYS };
}

/* ------------------------------------------------------------------ stats */

/**
 * Per-ball frequency + current absence streak over the era.
 * MAIN numbers only by default. `gap[n]` = draws elapsed since ball n last
 * appeared (0 = appeared in the latest draw; never appeared = total, sorts
 * as most overdue). Arrays are 1-indexed by ball; index 0 is unused.
 *
 * countSupps (default false — no behaviour change): supplementaries come out
 * of the same barrel, so enabling adds their 2–3 observations per draw to
 * the HOT/COLD/OVERDUE sample size. Documented knob only — not wired to the
 * UI; the shipped doctrine counts mains only.
 */
export function computeStats(eraDraws, pool, { countSupps = false } = {}) {
  const freq = new Array(pool + 1).fill(0);
  const lastIdx = new Array(pool + 1).fill(-1);
  eraDraws.forEach((d, i) => {
    const balls = countSupps ? d.numbers.concat(d.supps || []) : d.numbers;
    for (const n of balls) {
      if (isIntIn(n, 1, pool)) { freq[n]++; lastIdx[n] = i; }
    }
  });
  const total = eraDraws.length;
  const gap = new Array(pool + 1).fill(0);
  let minFreq = Infinity, maxFreq = -Infinity;
  for (let n = 1; n <= pool; n++) {
    gap[n] = total - 1 - lastIdx[n];
    if (freq[n] < minFreq) minFreq = freq[n];
    if (freq[n] > maxFreq) maxFreq = freq[n];
  }
  return { pool, total, freq, gap, minFreq, maxFreq };
}

/* ------------------------------------------------------------ pick modes */

const asc = (a, b) => a - b;

/**
 * All balls ranked by `metric` (desc or asc). Balls are crypto-shuffled
 * first, then stably sorted — so equal-metric balls end up in secure-random
 * order (the tie-break the doctrine requires).
 */
function rankedBalls(stats, metric, desc) {
  const balls = shuffled(Array.from({ length: stats.pool }, (_, i) => i + 1));
  balls.sort((a, b) => (desc ? metric[b] - metric[a] : metric[a] - metric[b]));
  return balls;
}

/** ORACLE weights: 1 + 0.5 × min-max-normalised era frequency ∈ [1, 1.5]. */
export function oracleWeights(stats) {
  const span = stats.maxFreq - stats.minFreq;
  const w = new Array(stats.pool + 1).fill(0);
  for (let n = 1; n <= stats.pool; n++) {
    w[n] = 1 + 0.5 * (span === 0 ? 0 : (stats.freq[n] - stats.minFreq) / span);
  }
  return w;
}

/**
 * Weighted sample of k unique balls via acceptance–rejection on top of the
 * crypto RNG: propose uniformly with secureInt, accept with probability
 * weight/maxWeight (compared against a second secureInt draw — unbiased up
 * to 2^-20 threshold rounding). Acceptance rate ≥ 2/3, so convergence is
 * immediate in practice; the guard is unreachable-in-theory insurance.
 */
const ACCEPT_SCALE = 1 << 20;

export function pickOracle(stats, k) {
  if (k > stats.pool) throw new RangeError(`pickOracle: k ${k} > pool ${stats.pool}`);
  const w = oracleWeights(stats);
  let wMax = 0;
  for (let n = 1; n <= stats.pool; n++) if (w[n] > wMax) wMax = w[n];
  const picked = new Set();
  let guard = 0;
  while (picked.size < k) {
    if (++guard > 1_000_000) throw new Error("pickOracle: rejection sampling did not converge");
    const n = 1 + secureInt(stats.pool);
    if (picked.has(n)) continue;
    const threshold = Math.round((w[n] / wMax) * ACCEPT_SCALE);
    if (secureInt(ACCEPT_SCALE) < threshold) picked.add(n);
  }
  return [...picked].sort(asc);
}

/** Metric array + direction for the three ranking modes. */
function modeMetric(stats, mode) {
  switch (mode) {
    case "hot": return { metric: stats.freq, desc: true };
    case "cold": return { metric: stats.freq, desc: false };
    case "overdue": return { metric: stats.gap, desc: true };
    default: throw new Error(`unknown ranking mode "${mode}"`);
  }
}

/** One line of k balls for a mode. Sorted ascending. */
export function pickLine(stats, mode, k) {
  if (mode === "oracle") return pickOracle(stats, k);
  const { metric, desc } = modeMetric(stats, mode);
  return rankedBalls(stats, metric, desc).slice(0, k).sort(asc);
}

/**
 * All lines for a game/mode. Single-line games return [line].
 * Set for Life rank modes return two DISJOINT lines — ranks 1–7 and 8–14 of
 * one ranking; ORACLE returns two independent weighted draws (may overlap
 * between lines, never within one).
 */
export function generateLines(stats, game, mode) {
  if (!MODES.includes(mode)) throw new Error(`generateLines: unknown mode "${mode}"`);
  const k = game.picks;
  if (game.lines === 2) {
    if (mode === "oracle") return [pickOracle(stats, k), pickOracle(stats, k)];
    if (2 * k > stats.pool) throw new RangeError(`generateLines: 2×${k} > pool ${stats.pool}`);
    const { metric, desc } = modeMetric(stats, mode);
    const ranked = rankedBalls(stats, metric, desc);
    return [ranked.slice(0, k).sort(asc), ranked.slice(k, 2 * k).sort(asc)];
  }
  return [pickLine(stats, mode, k)];
}

/** Tooltip line for ball n — exact doctrine wording. */
export function tooltipText(stats, era, n) {
  return `drawn ${stats.freq[n]}× in ${stats.total} draws since ${era.startYear}`;
}

/* ------------------------------------------------------------ data loader */

const ctxCache = new Map();

/**
 * Load a game's draw file, detect its era, compute stats. Memoised per
 * (game, includeLegacy); failures are not cached so a flaky first fetch can
 * be retried. Logs era start + draw count (doctrine) and the sanity-anchor
 * warning when detection lands far from the known change date.
 */
export async function getOracleContext(gameKey, {
  includeLegacy = true,
  basePath = "data/draws/",
  fetcher,
  log = console
} = {}) {
  const game = ORACLE_GAMES[gameKey];
  if (!game) throw new Error(`getOracleContext: unknown game "${gameKey}"`);
  const cacheKey = `${gameKey}|${includeLegacy}`;
  if (ctxCache.has(cacheKey)) return ctxCache.get(cacheKey);

  const promise = (async () => {
    const f = fetcher || globalThis.fetch;
    const res = await f(`${basePath}${game.file}.json`);
    if (!res.ok) throw new Error(`${game.name}: draw data unavailable (HTTP ${res.status})`);
    const draws = await res.json();
    if (!Array.isArray(draws) || draws.length === 0) {
      throw new Error(`${game.name}: draw data empty or malformed`);
    }
    const era = detectEra(draws, game.matrix, { includeLegacy, eraFloor: game.eraFloor });
    const stats = computeStats(era.draws, game.matrix.pool);
    const boundary = classifyBoundary(gameKey, era);
    log?.info?.(
      `The Oracle · ${game.name}: era starts ${era.startDate} (draw #${era.startDraw}) — ` +
      `${era.total} draws` +
      (era.discardedOlder ? `, ${era.discardedOlder} pre-era draws excluded` : "") +
      (era.flooredOut ? `, ${era.flooredOut} draws below the ${game.eraFloor.reason} floor excluded` : "") +
      (boundary === "edge" ? " — start of AVAILABLE HISTORY, not a format boundary" : "")
    );
    const sanity = sanityCheckEraStart(gameKey, era.startDate);
    if (sanity && !sanity.ok) {
      log?.warn?.(
        `The Oracle · ${game.name}: detected era start ${era.startDate} is ` +
        `${sanity.deltaDays} days from the expected ~${sanity.expected} — ` +
        `check draw data / matrix config`
      );
    }
    return { game, era, stats, boundary };
  })();

  ctxCache.set(cacheKey, promise);
  promise.catch(() => ctxCache.delete(cacheKey));
  return promise;
}

/** Test hook — drop memoised contexts. */
export function clearOracleCache() {
  ctxCache.clear();
}
