/* QuickPick AU — RNG statistical validation.
 * For every game matrix: 100,000 simulated lines, asserting
 *   (a) correct pick count
 *   (b) no duplicates within a line
 *   (c) all values in [1, pool]
 *   (d) chi-square per-number frequency < 95% critical value (df = pool − 1)
 * Exits 1 on any failure.
 */
import { drawLine, validateMatrix } from "../rng.js";

const N = 100_000;

const MATRICES = [
  { label: "TattsLotto",       pool: 45, picks: 6 },
  { label: "Oz Lotto",         pool: 47, picks: 7 },
  { label: "Powerball (main)", pool: 35, picks: 7 },
  { label: "Powerball (PB)",   pool: 20, picks: 1 },
  { label: "Set for Life",     pool: 44, picks: 7 },
  { label: "Weekday Windfall", pool: 45, picks: 6 },
  { label: "Custom 20/99",     pool: 99, picks: 20 }
];

/* Upper-tail 95% chi-square critical value, Wilson–Hilferty approximation
 * (accurate to <0.1 for df >= 15; exact-table spot checks: df=44 → 60.48). */
function chiCrit95(df) {
  const z = 1.6448536269514722; // Phi^-1(0.95)
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

function runMatrix({ label, pool, picks }) {
  const counts = new Uint32Array(pool + 1);
  let badCount = 0, badDup = 0, badRange = 0;

  for (let i = 0; i < N; i++) {
    const line = drawLine(pool, picks);
    if (line.length !== picks) badCount++;
    const seen = new Set(line);
    if (seen.size !== picks) badDup++;
    for (const v of line) {
      if (!Number.isInteger(v) || v < 1 || v > pool) { badRange++; break; }
      counts[v]++;
    }
  }

  const expected = (N * picks) / pool;
  let chi2 = 0;
  for (let v = 1; v <= pool; v++) {
    const d = counts[v] - expected;
    chi2 += (d * d) / expected;
  }
  const df = pool - 1;
  const crit = chiCrit95(df);
  const pass = badCount === 0 && badDup === 0 && badRange === 0 && chi2 < crit;
  return { label, pool, picks, badCount, badDup, badRange, chi2, df, crit, pass };
}

/* ---- validation guards ---- */
let guardsPass = true;
const mustThrow = [
  () => validateMatrix(10, 11),  // picks > pool
  () => validateMatrix(1, 1),    // pool too small
  () => validateMatrix(45, 0),   // zero picks
  () => drawLine(45, 46)
];
for (const fn of mustThrow) {
  try { fn(); guardsPass = false; } catch { /* expected */ }
}
try { validateMatrix(99, 20); drawLine(2, 1); } catch { guardsPass = false; }

/* ---- run + report ---- */
const rows = MATRICES.map(runMatrix);

const pad = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w);
console.log(`\nQuickPick AU — RNG chi-square validation (${N.toLocaleString()} lines per matrix)\n`);
console.log(
  pad("Matrix", 18) + pad("pool", 6, true) + pad("picks", 7, true) + pad("lines", 9, true) +
  pad("count✗", 8, true) + pad("dup✗", 6, true) + pad("range✗", 8, true) +
  pad("chi²", 10, true) + pad("crit95", 9, true) + "  result"
);
console.log("-".repeat(88));
for (const r of rows) {
  console.log(
    pad(r.label, 18) + pad(r.pool, 6, true) + pad(r.picks, 7, true) + pad(N.toLocaleString(), 9, true) +
    pad(r.badCount, 8, true) + pad(r.badDup, 6, true) + pad(r.badRange, 8, true) +
    pad(r.chi2.toFixed(2), 10, true) + pad(r.crit.toFixed(2), 9, true) +
    (r.pass ? "  PASS" : "  FAIL")
  );
}
console.log("-".repeat(88));
console.log(`Validation guards (picks < range enforced, invalid matrices throw): ${guardsPass ? "PASS" : "FAIL"}`);

const allPass = guardsPass && rows.every((r) => r.pass);
console.log(allPass
  ? "\nALL MATRICES PASS (α = 0.05, df = pool − 1, Wilson–Hilferty critical values)\n"
  : "\nFAILURE — see table above\n");
process.exit(allPass ? 0 : 1);
