/* QuickPick AU — draw-history updater for The Oracle.
 *
 * Fetches the complete published draw history for the five games from The
 * Lott's public results API into data/draws/<game>.json, then verifies each
 * file with the same era detection the app uses. No dependencies; Node >= 18.
 *
 *   node scripts/update-draws.mjs             # incremental (weekly Action)
 *   node scripts/update-draws.mjs --full      # rebuild every file from scratch
 *   node scripts/update-draws.mjs --game powerball
 *
 * API notes (probed 2026-07): POST JSON to
 *   https://data.api.thelott.com/sales/vmax/web/data/lotto/latestresults
 *     { CompanyId, MaxDrawCountPerProduct }
 *   https://data.api.thelott.com/sales/vmax/web/data/lotto/results/search/drawrange
 *     { CompanyId, Product, MinDrawNo, MaxDrawNo }   — max 50 draws per page
 * Earliest published draws: TattsLotto #1621 (1997), OzLotto #609 (2005),
 * Powerball #1 (1996), SetForLife744 #1691 (2020), MonWedLotto #1638 (1997).
 * Weekday Windfall continues Mon & Wed Lotto's numbering — the legacy product
 * ends at #4391 (2024-05-15), MondayWednesdayFridayLotto starts #4392.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ERA_ANCHORS, KNOWN_MATRICES, ORACLE_GAMES, classifyBoundary, detectEra,
  matchesMatrix, poolCoverageViolations, sanityCheckEraStart
} from "../js/predictor.js";

const API_BASE = "https://data.api.thelott.com/sales/vmax/web/data/lotto";
const COMPANY = "Tattersalls";
const PAGE = 50;                 // API hard limit per drawrange request
const REQUEST_DELAY_MS = 120;    // politeness between requests
const MAX_PAGES_PER_PRODUCT = 400; // runaway guard (~20k draws)
const INCREMENTAL_OVERLAP = 3;   // refetch a few stored draws to pick up corrections

/** gameKey → products to merge into its file (order = ascending age). */
const SOURCES = {
  tattslotto: [{ product: "TattsLotto" }],
  ozlotto: [{ product: "OzLotto" }],
  powerball: [{ product: "Powerball" }],
  setforlife: [{ product: "SetForLife744" }],
  weekdaywindfall: [
    // Mon & Wed Lotto — same 6/45 matrix, rebranded Weekday Windfall May 2024.
    // Closed product: once its draws are stored they never change.
    { product: "MonWedLotto", legacy: true, closed: true, lastKnownDraw: 4391 },
    { product: "MondayWednesdayFridayLotto" }
  ]
};

const DATA_DIR = fileURLToPath(new URL("../data/draws/", import.meta.url));

/* ------------------------------------------------------------------- api */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiPost(path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "quickpick-au draw updater (github.com/TonyJason1/quickpick-au)"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.Success === false) {
        throw new Error(json.ErrorInfo?.DisplayMessage || "API reported failure");
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${path}: ${lastErr.message}`);
}

/** Latest draw number per ProductId (single request). */
async function fetchLatestByProduct() {
  const json = await apiPost("latestresults", {
    CompanyId: COMPANY, MaxDrawCountPerProduct: 1
  });
  const latest = new Map();
  for (const d of json.DrawResults || []) latest.set(d.ProductId, d.DrawNumber);
  return latest;
}

async function fetchDrawRange(product, min, max) {
  const json = await apiPost("results/search/drawrange", {
    CompanyId: COMPANY, Product: product, MinDrawNo: min, MaxDrawNo: max
  });
  return json.Draws || [];
}

/* ------------------------------------------------------------ transforms */

const numAsc = (a, b) => a - b;

const isIntArray = (a) => Array.isArray(a) && a.every((v) => Number.isInteger(v));

/**
 * API draw → repo record, or a rejection with a reason.
 *
 * Two gates. The envelope gate rejects anything we cannot even shape into a
 * record (draw number, date, numbers array). The STRUCTURAL gate then demands
 * the finished record match a matrix the game has actually run
 * (KNOWN_MATRICES) — one check that covers empty arrays, out-of-pool balls,
 * duplicate balls and wrong counts, all of which the previous
 * `Number.isInteger(v) && v > 0` test waved through.
 *
 * Rejections are FATAL to the run (see updateGame). With every historical
 * matrix enumerated, a legitimate draw can never be rejected — so a rejection
 * means either a hostile/garbled payload or a real format change, and both
 * must stop the pipeline rather than silently shrink the file.
 */
function toRecord(apiDraw, source, gameKey) {
  const reject = (reason) =>
    ({ rec: null, reason: `${reason} — ${JSON.stringify(apiDraw).slice(0, 160)}` });

  if (!apiDraw || typeof apiDraw !== "object") return reject("not an object");
  const { DrawNumber, DrawDate, PrimaryNumbers, SecondaryNumbers } = apiDraw;
  const date = typeof DrawDate === "string" ? DrawDate.slice(0, 10) : null;
  if (!Number.isInteger(DrawNumber) || DrawNumber <= 0) return reject("bad DrawNumber");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reject("bad DrawDate");
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return reject("DrawDate not a real date");
  if (!isIntArray(PrimaryNumbers)) return reject("PrimaryNumbers not an integer array");

  const secondary = isIntArray(SecondaryNumbers) ? SecondaryNumbers : [];
  const rec = { draw: DrawNumber, date, numbers: [...PrimaryNumbers].sort(numAsc) };
  if (gameKey === "powerball") {
    // SecondaryNumbers carries the single Powerball in every Powerball era.
    if (secondary.length !== 1) return reject(`expected exactly 1 secondary, got ${secondary.length}`);
    rec.supps = [];
    rec.pb = secondary[0];
  } else {
    rec.supps = [...secondary].sort(numAsc);
    rec.pb = null;
  }
  if (source.legacy) rec.legacy = true;

  if (!KNOWN_MATRICES[gameKey].some((m) => matchesMatrix(rec, m))) {
    return reject(
      `matches no known ${gameKey} matrix ` +
      `(${rec.numbers.length} mains + ${rec.supps.length} supps${rec.pb != null ? " + PB" : ""}, ` +
      `max ball ${Math.max(0, ...rec.numbers, ...rec.supps)})`
    );
  }
  return { rec, reason: null };
}

/** One draw per line — stable, reviewable git diffs on weekly updates. */
function serialize(draws) {
  return "[\n" + draws.map((d) => JSON.stringify(d)).join(",\n") + "\n]\n";
}

async function readExisting(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // absent or unreadable — treated as full backfill for this game
  }
}

/* ---------------------------------------------------------------- update */

/**
 * Walk a product's history downward from its latest draw in 50-draw pages.
 * Stops at the store boundary (incremental) or after two consecutive empty
 * pages (start of published history — one empty page is not trusted, in case
 * the API has a hole or hiccups on a single window).
 *
 * Pagination audit (--full logs every page): windows must tile the walked
 * range exactly (adjacent, non-overlapping — asserted), Σ page draws must
 * equal unique draws + cross-page dupes (counted by the caller's merge), and
 * an EMPTY window strictly between non-empty ones is a suspected API hole —
 * flagged loudly because the resulting gap would silently truncate history.
 */
async function fetchProduct(source, latestByProduct, storedMax, stats, { logPages }) {
  const latest = latestByProduct.get(source.product) ?? source.lastKnownDraw;
  if (!latest) throw new Error(`${source.product}: latest draw number unknown`);
  const stopAt = storedMax != null ? storedMax - INCREMENTAL_OVERLAP : null;
  const out = [];
  const pages = [];
  let emptyStreak = 0;
  let hi = latest;
  for (let page = 0; page < MAX_PAGES_PER_PRODUCT; page++) {
    if (hi < 1 || (stopAt != null && hi < stopAt)) break;
    const lo = Math.max(1, hi - PAGE + 1);
    if (pages.length && pages[pages.length - 1].lo !== hi + 1) {
      throw new Error(`${source.product}: page windows do not tile (${pages[pages.length - 1].lo} vs ${hi + 1})`);
    }
    const draws = await fetchDrawRange(source.product, lo, hi);
    stats.requests++;
    const nums = draws.map((d) => d.DrawNumber);
    pages.push({ lo, hi, count: draws.length, first: nums.length ? Math.max(...nums) : null, last: nums.length ? Math.min(...nums) : null });
    if (logPages) {
      console.log(`    page ${String(pages.length).padStart(3)}: window #${lo}–#${hi} → ${String(draws.length).padStart(2)} draws` +
        (draws.length ? ` (first #${Math.max(...nums)}, last #${Math.min(...nums)})` : " (empty)"));
    }
    if (draws.length === 0) {
      if (++emptyStreak >= 2 || lo === 1) break;
    } else {
      emptyStreak = 0;
      out.push(...draws);
    }
    hi = lo - 1;
    await sleep(REQUEST_DELAY_MS);
  }
  // suspected holes: empty windows with data both above and below them
  const lastNonEmpty = pages.map((p) => p.count > 0).lastIndexOf(true);
  pages.forEach((p, i) => {
    if (p.count === 0 && i < lastNonEmpty) {
      console.warn(`  ! ${source.product}: EMPTY window #${p.lo}–#${p.hi} between non-empty pages — possible API hole, history may be truncated`);
      stats.suspectedHoles++;
    }
  });
  const sum = pages.reduce((a, p) => a + p.count, 0);
  const unique = new Set(out.map((d) => d.DrawNumber)).size;
  if (logPages) {
    console.log(`    ${source.product}: ${pages.length} pages, ${sum} rows, ${unique} unique draws, ${sum - unique} cross-page dupes`);
  }
  if (sum !== out.length) throw new Error(`${source.product}: page accounting mismatch (${sum} vs ${out.length})`);
  return out;
}

function logFormatTransitions(gameKey, draws) {
  let prev = null;
  for (const d of draws) {
    const sig = `${d.numbers.length} mains + ${d.supps.length} supps` +
      (d.pb != null ? " + PB" : "");
    if (prev !== null && sig !== prev) {
      console.log(`    format change at draw #${d.draw} (${d.date}): ${prev} → ${sig}`);
    }
    prev = sig;
  }
}

/**
 * Every structural guarantee the repo data must hold, run against the PARSED
 * BYTES of the candidate file (not the in-memory array), so serialization
 * bugs are caught too. Throws on the first violation; returns the era on
 * success. This is the ingest gate — nothing reaches data/draws/ without it.
 */
function validateDataFile(gameKey, game, draws, stats) {
  const fail = (msg) => { throw new Error(`${gameKey}: ${msg}`); };

  if (!Array.isArray(draws) || !draws.length) fail("serialized file is not a non-empty array");
  for (let i = 1; i < draws.length; i++) {
    if (!(draws[i].draw > draws[i - 1].draw)) {
      fail(`draw numbers not strictly ascending at index ${i} (#${draws[i - 1].draw} → #${draws[i].draw})`);
    }
  }

  const era = detectEra(draws, game.matrix, { eraFloor: game.eraFloor });
  const boundary = classifyBoundary(gameKey, era);

  // Exact history pin — the check that turns a poisoned payload into an
  // ingest failure instead of a silently truncated era three steps later.
  const anchor = ERA_ANCHORS[gameKey];
  if (anchor) {
    if (era.startDraw !== anchor.startDraw || era.startDate !== anchor.startDate) {
      fail(
        `era start moved to #${era.startDraw} ${era.startDate}, anchored at ` +
        `#${anchor.startDraw} ${anchor.startDate} — corrupt payload, a real format ` +
        `change, or the published-history depth shifted. Verify, then update ERA_ANCHORS.`
      );
    }
    if (boundary !== anchor.kind) {
      fail(`era boundary classified "${boundary}", anchored as "${anchor.kind}"`);
    }
  }

  const offMatrix = era.draws.filter((d) => !matchesMatrix(d, game.matrix));
  if (offMatrix.length) {
    fail(`${offMatrix.length} era draws violate the current matrix, e.g. ${JSON.stringify(offMatrix[0])}`);
  }

  const contamination = poolCoverageViolations(era.draws, game.matrix);
  if (contamination.length) {
    const c = contamination[0];
    fail(
      `hidden narrower pool: ball ${c.ball} absent for the first ${c.absentPrefix} era draws ` +
      `(P ≈ ${c.probability.toExponential(1)})`
    );
  }

  const sanity = sanityCheckEraStart(gameKey, era.startDate);
  if (sanity && !sanity.ok) {
    fail(`detected era start ${era.startDate} is ${sanity.deltaDays} days from expected ${sanity.expected}`);
  }
  if (stats.suspectedHoles > 0) {
    fail(`${stats.suspectedHoles} suspected API hole(s) — rerun with --full and inspect the page log`);
  }
  return { era, boundary, sanity };
}

async function updateGame(gameKey, { full }) {
  const game = ORACLE_GAMES[gameKey];
  const file = `${DATA_DIR}${game.file}.json`;
  const existing = full ? [] : await readExisting(file);
  const byDraw = new Map(existing.map((d) => [d.draw, d]));
  const stats = { requests: 0, suspectedHoles: 0 };

  const latestByProduct = await fetchLatestByProduct();
  stats.requests++;

  let added = 0, corrected = 0;
  const rejected = [];
  for (const source of SOURCES[gameKey]) {
    const storedOfProduct = existing.filter((d) => !!d.legacy === !!source.legacy);
    if (source.closed && storedOfProduct.length && !full) {
      console.log(`  ${source.product}: closed product already stored (${storedOfProduct.length} draws) — skipped`);
      continue;
    }
    const storedMax = storedOfProduct.length
      ? Math.max(...storedOfProduct.map((d) => d.draw))
      : null;
    const apiDraws = await fetchProduct(source, latestByProduct, full ? null : storedMax, stats, { logPages: full });
    for (const apiDraw of apiDraws) {
      const { rec, reason } = toRecord(apiDraw, source, gameKey);
      if (!rec) {
        rejected.push(reason);
        console.error(`  ! ${gameKey}: REJECTED ${reason}`);
        continue;
      }
      const old = byDraw.get(rec.draw);
      if (!old) added++;
      else if (JSON.stringify(old) !== JSON.stringify(rec)) {
        corrected++;
        console.warn(`  ! ${gameKey} draw #${rec.draw}: stored record differs from API — replaced`);
      }
      byDraw.set(rec.draw, rec);
    }
  }

  // A rejection can only mean a garbled payload or a real format change, since
  // KNOWN_MATRICES enumerates every shape the game has ever run. Either way the
  // run must stop before anything is persisted.
  if (rejected.length) {
    throw new Error(
      `${rejected.length} API draw(s) rejected by structural validation — refusing to write. ` +
      `First: ${rejected[0]}`
    );
  }

  const draws = [...byDraw.values()].sort((a, b) => a.draw - b.draw);
  if (!draws.length) throw new Error(`${gameKey}: no draws fetched and none stored`);

  /* --- write candidate → validate the parsed bytes → publish (or discard) --- */
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serialize(draws), "utf8");
  let era, boundary, sanity;
  try {
    const roundTripped = JSON.parse(await readFile(tmp, "utf8"));
    ({ era, boundary, sanity } = validateDataFile(gameKey, game, roundTripped, stats));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new Error(`${err.message} — candidate discarded, ${file} left untouched`);
  }
  await rename(tmp, file);

  // Doctrine: log era start + draw count, via the exact detection the app runs.
  console.log(
    `  ${gameKey}: ${draws.length} draws (${draws[0].date} → ${draws[draws.length - 1].date}), ` +
    `+${added} new${corrected ? `, ${corrected} corrected` : ""}, ${stats.requests} requests`
  );
  logFormatTransitions(gameKey, draws);
  console.log(
    `    era: starts ${era.startDate} (draw #${era.startDraw}) — ${era.total} draws` +
    (era.discardedOlder ? `, ${era.discardedOlder} pre-era draws excluded` : "") +
    (era.flooredOut ? `, ${era.flooredOut} pre-floor draws excluded (${game.eraFloor.reason})` : "") +
    (boundary === "edge" ? " [START OF AVAILABLE HISTORY, not a format boundary]" : "") +
    (sanity ? ` [expected ~${sanity.expected}: ${sanity.ok ? "OK" : `OFF BY ${sanity.deltaDays}d`}]` : "") +
    ` [anchor #${ERA_ANCHORS[gameKey].startDraw} ${ERA_ANCHORS[gameKey].startDate} OK]`
  );
  return { gameKey, total: draws.length, added };
}

/* ------------------------------------------------------------------ main */

/* Pure ingest surface, exported so test/ingest.test.mjs can exercise the
 * validation gates directly without any network. */
export { toRecord, validateDataFile, serialize, SOURCES };

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const gameArg = args.includes("--game") ? args[args.indexOf("--game") + 1] : null;
  const gameKeys = gameArg ? [gameArg] : Object.keys(SOURCES);
  if (gameArg && !SOURCES[gameArg]) {
    console.error(`unknown game "${gameArg}" — expected one of: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(2);
  }

  console.log(`update-draws: ${full ? "FULL rebuild" : "incremental"} — ${gameKeys.join(", ")}\n`);
  let failed = 0;
  for (const key of gameKeys) {
    try {
      await updateGame(key, { full });
    } catch (err) {
      failed++;
      console.error(`  ✗ ${key}: ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} game(s) FAILED` : "\nall games updated");
  process.exit(failed ? 1 : 0);
}

// Run only as a CLI; importing this module (tests) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
