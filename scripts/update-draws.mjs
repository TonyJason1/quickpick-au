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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ORACLE_GAMES, detectEra, sanityCheckEraStart } from "../js/predictor.js";

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

/** API draw → repo record. Returns null (and logs) on malformed input. */
function toRecord(apiDraw, source, gameKey) {
  const { DrawNumber, DrawDate, PrimaryNumbers, SecondaryNumbers } = apiDraw;
  const date = typeof DrawDate === "string" ? DrawDate.slice(0, 10) : null;
  const ints = (a) => Array.isArray(a) && a.every((v) => Number.isInteger(v) && v > 0);
  if (!Number.isInteger(DrawNumber) || DrawNumber <= 0 ||
      !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !ints(PrimaryNumbers)) {
    console.error(`  ! ${gameKey}: skipping malformed API draw ${JSON.stringify(apiDraw).slice(0, 120)}`);
    return null;
  }
  const secondary = ints(SecondaryNumbers) ? SecondaryNumbers : [];
  const rec = { draw: DrawNumber, date, numbers: [...PrimaryNumbers].sort(numAsc) };
  if (gameKey === "powerball") {
    // SecondaryNumbers carries the single Powerball in every Powerball era.
    if (secondary.length !== 1) {
      console.warn(`  ! powerball draw #${DrawNumber}: expected 1 secondary, got ${secondary.length}`);
    }
    rec.supps = [];
    rec.pb = secondary.length ? secondary[0] : null;
  } else {
    rec.supps = [...secondary].sort(numAsc);
    rec.pb = null;
  }
  if (source.legacy) rec.legacy = true;
  return rec;
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
 */
async function fetchProduct(source, latestByProduct, storedMax, stats) {
  const latest = latestByProduct.get(source.product) ?? source.lastKnownDraw;
  if (!latest) throw new Error(`${source.product}: latest draw number unknown`);
  const stopAt = storedMax != null ? storedMax - INCREMENTAL_OVERLAP : null;
  const out = [];
  let emptyStreak = 0;
  let hi = latest;
  for (let page = 0; page < MAX_PAGES_PER_PRODUCT; page++) {
    if (hi < 1 || (stopAt != null && hi < stopAt)) break;
    const lo = Math.max(1, hi - PAGE + 1);
    const draws = await fetchDrawRange(source.product, lo, hi);
    stats.requests++;
    if (draws.length === 0) {
      if (++emptyStreak >= 2 || lo === 1) break;
    } else {
      emptyStreak = 0;
      out.push(...draws);
    }
    hi = lo - 1;
    await sleep(REQUEST_DELAY_MS);
  }
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

async function updateGame(gameKey, { full }) {
  const game = ORACLE_GAMES[gameKey];
  const file = `${DATA_DIR}${game.file}.json`;
  const existing = full ? [] : await readExisting(file);
  const byDraw = new Map(existing.map((d) => [d.draw, d]));
  const stats = { requests: 0 };

  const latestByProduct = await fetchLatestByProduct();
  stats.requests++;

  let added = 0, corrected = 0;
  for (const source of SOURCES[gameKey]) {
    const storedOfProduct = existing.filter((d) => !!d.legacy === !!source.legacy);
    if (source.closed && storedOfProduct.length && !full) {
      console.log(`  ${source.product}: closed product already stored (${storedOfProduct.length} draws) — skipped`);
      continue;
    }
    const storedMax = storedOfProduct.length
      ? Math.max(...storedOfProduct.map((d) => d.draw))
      : null;
    const apiDraws = await fetchProduct(source, latestByProduct, full ? null : storedMax, stats);
    for (const apiDraw of apiDraws) {
      const rec = toRecord(apiDraw, source, gameKey);
      if (!rec) continue;
      const old = byDraw.get(rec.draw);
      if (!old) added++;
      else if (JSON.stringify(old) !== JSON.stringify(rec)) {
        corrected++;
        console.warn(`  ! ${gameKey} draw #${rec.draw}: stored record differs from API — replaced`);
      }
      byDraw.set(rec.draw, rec);
    }
  }

  const draws = [...byDraw.values()].sort((a, b) => a.draw - b.draw);
  if (!draws.length) throw new Error(`${gameKey}: no draws fetched and none stored`);

  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serialize(draws), "utf8");
  await rename(tmp, file);

  // Doctrine: log era start + draw count, via the exact detection the app runs.
  const era = detectEra(draws, game.matrix);
  const sanity = sanityCheckEraStart(gameKey, era.startDate);
  console.log(
    `  ${gameKey}: ${draws.length} draws (${draws[0].date} → ${draws[draws.length - 1].date}), ` +
    `+${added} new${corrected ? `, ${corrected} corrected` : ""}, ${stats.requests} requests`
  );
  logFormatTransitions(gameKey, draws);
  console.log(
    `    era: starts ${era.startDate} (draw #${era.startDraw}) — ${era.total} draws` +
    (era.discardedOlder ? `, ${era.discardedOlder} pre-era draws excluded` : "") +
    (sanity ? ` [expected ~${sanity.expected}: ${sanity.ok ? "OK" : `OFF BY ${sanity.deltaDays}d`}]` : "")
  );
  if (sanity && !sanity.ok) {
    throw new Error(`${gameKey}: detected era start ${era.startDate} is ${sanity.deltaDays} days from expected ${sanity.expected}`);
  }
  return { gameKey, total: draws.length, added };
}

/* ------------------------------------------------------------------ main */

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
