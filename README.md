# QuickPick AU

Mobile-first PWA random number generator for Australian lottery games, with an animated ball-machine draw. Vanilla HTML/CSS/JS — no frameworks, no build step. Fully offline after first load.

**Selection is always `crypto.getRandomValues` with rejection sampling (no modulo bias), sampling without replacement. The ball machine is presentation only.**

## Games

| Game | Matrix |
|---|---|
| TattsLotto | 6 from 1–45 |
| Oz Lotto | 7 from 1–47 |
| Powerball | 7 from 1–35 + 1 PB from 1–20 (separate barrel) |
| Set for Life | 7 from 1–44 |
| Weekday Windfall | 6 from 1–45 |
| Custom | 1–20 picks from a 1–N range (N ≤ 99), optional extra ball |

Matrices verified against thelott.com how-to-play pages, July 2026.

## The Oracle

Second tab: era-aware "predictor" over the real draw history. **For entertainment only — every combination has identical odds** (the fixed footer says exactly that). One unified flow — ASK THE ORACLE → ball-machine reveal:

> **weight(ball) = 1 + 0.35 × normFreq + 0.15 × normGap**

normFreq = min-max-normalised era frequency (mains only), normGap = min-max-normalised current absence streak; drawn with the crypto rejection sampler, unique, sorted ascending. Every weight sits in [1, 1.5], so no ball is ever excluded and the max/min tilt ratio never exceeds 1.5 (chi-square-verified against the weights over 100k samples in tests; a second 100k-per-game test pins the consecutive-pair fraction to the uniform closed form 1 − C(n−k+1,k)/C(n,k) within ±1pp — an adjacency-bias tripwire). The audit also reports the consecutive-pair rate of the real era draws vs the same closed form per game (report-only confirmation).

The chi-square test samples **k = 1**, where the raw normalised weight share `w[n]/Σw` is exactly the right expectation. The pick counts that actually ship (k = 6–20) are guarded separately: `pickWeighted` samples *without replacement*, so its per-ball inclusion probabilities are successive-sampling (Wallenius-type) marginals, compressed toward uniform relative to `k·w[n]/Σw` — by up to **1.9% per ball at the defaults and 7.4% at the k=20 System cap** (worst case Powerball, 20 of 35). Those are pinned as 10M-draw Monte Carlo references in `test/fixtures/marginals.json`, generated from frozen era stats so the weekly data commit cannot drift them. Regenerate with `npm run marginals`.

Legacy HOT/COLD/OVERDUE/ORACLE pickers remain exported from `js/predictor.js` for tests and a possible future advanced toggle — no UI entry.

Quantity controls (per game, persisted): a **Numbers** stepper (mains per line) and a **Lines** stepper (1–10 independent draws; overlap between lines allowed, like real QuickPicks). Numbers ranges from the standard entry size up to The Lott's largest System entry — verified against thelott.com 2026-07-18: TattsLotto/Weekday Windfall 6→20 (System 7–20), Oz Lotto 7→20 (System 8–20), Powerball 7→20 mains (System 8–20; PowerHit note stays at any count, PB barrel hidden); **Set for Life is pinned at 7 — The Lott offers no SfL System entries** (QuickPick/marked only). Defaults are Tony's plays: 7 / 8 / 7 / 7×2 lines / 7. Tap a ball for its stats ("drawn N× · last seen G draws ago" — both signals feeding the pick). Stats count main numbers only.

**Era filter:** stats only ever use the current-matrix era, auto-detected per game by walking back from the latest draw until the record shape stops matching (Powerball 6→7 mains 2018-04-19, Oz Lotto +1 supp 2022-05-17, Set for Life 7/44 product start 2020-03-23). Weekday Windfall includes legacy Mon & Wed Lotto draws (`legacy: true` in the data, `includeLegacy` option) **floored at draw #2303 (2004-05-12)**: before the May 2004 national alignment Mon & Wed Lotto ran a 6/44 pool, which passes every 6/45 shape check but never draws ball 45 (665 such draws in the data, P ≈ 10⁻⁵³ under 6/45) — the audit's pool-coverage scan guards this class of contamination permanently. The UI distinguishes a real format boundary from mere API history depth: TattsLotto's 6/45 matrix predates the published data (1997), so its status line reads "since 1997-02-01 **(available history)**" rather than implying a boundary.

**Data:** `data/draws/<game>.json` — complete published history from The Lott's public results API (~11k draws; cross-validated against an independent archive). A weekly GitHub Action (`.github/workflows/update-draws.yml`) fetches, audits, re-validates and commits. It deliberately never runs `npm install`: every script and test it invokes uses only Node builtins and repo code, so no third-party package executes anywhere in the data pipeline. Actions are pinned to immutable commit SHAs, jobs carry `timeout-minutes`, and a failure opens (or comments on) a `pipeline-failure` issue — a dead pipeline has to be loud.

**Ingest validation:** a fetched draw must match one of the matrices its game has actually run (`KNOWN_MATRICES` — Powerball has three: 5/45+PB45, 6/40+PB20, 7/35+PB20). That one structural check rejects empty arrays, out-of-pool balls, duplicates and wrong counts. Rejections are fatal. The candidate file is then written to a temp path, re-parsed, and validated *as bytes* — era detection, exact `ERA_ANCHORS` pins, matrix conformance and the pool-coverage scan — and only renamed into place if all of it passes; otherwise the candidate is discarded and the live file is untouched.

**Audit:** `npm run audit` reconciles every game offline — per-draw matrix conformance (hard fail), min/max ball + mains/supps-count histograms, hidden-pool coverage scan, per-year max-ball timeline, calendar-cadence math vs actual counts (all games currently delta +0, including Weekday Windfall's +Friday cadence change at #4392 / 2024-05-20), and **freshness against the wall clock**. Cadence math anchors its window to the last draw *in the file*, so it reconciles to +0 no matter how stale the data is; freshness anchors to today in Australia/Sydney and hard-fails when more scheduled draws are missing than one refresh cycle can explain. `--strict` (used in CI right after the updater) drops that budget to 2; `--as-of=YYYY-MM-DD` makes the clock deterministic. `--full` rebuilds of the updater also log every API page and hard-fail on window-tiling errors or suspected holes.

**countSupps (documented knob, off by default):** `computeStats(draws, pool, { countSupps: true })` also counts supplementaries — they come from the same barrel, so enabling adds their 2–3 observations per draw to the HOT/COLD/OVERDUE sample size. The shipped doctrine counts main numbers only; the knob is not wired to the UI.

## Parked: "anti-crowd" weighting

**Status: assessed, not built. Do not add it to `unifiedWeights`.**

The idea: a fourth weight term penalising numbers people over-pick — birthdays (1–31), diagonals and other playslip patterns — so that if a line does win Division 1 it is less likely to be split. The mechanics are trivial; the reasons it is parked are not.

- **It would have to reallocate, not extend.** `weight = 1 + 0.30·normFreq + 0.10·normGap + 0.10·(1 − normCrowd)` keeps `w ∈ [1, 1.5]` structurally, so the ratio guard still passes untouched. A subtractive `− λ·crowd` term breaks the floor and needs post-hoc clamping.
- **The 1.5× cap makes it ineffective.** Published work on conscious selection (Simon 1998; Farrell & Walker; Cook & Clotfelter) puts the over-picking of birthday-heavy combinations at roughly **2–4×**. A counter-tilt bounded at 1.5× cannot offset that; it recovers a sliver of expected value while claiming to solve the problem. Raising the cap to make it work would break the invariant the whole Oracle is built on.
- **It would trip the adjacency tripwire, correctly.** `normFreq` and `normGap` are noise-like across ball values. An anti-crowd term is *spatially structured*: it pushes mass out of the contiguous block [1, 31] into the 14-wide band [32, 45]. Concentrating picks in a narrow band raises P(≥1 consecutive pair) well past the ±1pp tolerance, and the uniform closed form `1 − C(n−k+1,k)/C(n,k)` stops being the right baseline. The tripwire firing here is the tripwire doing its job.
- **Calibration data does exist**, if it is ever revisited: Division 1 **winner counts per draw** are published with every result and available from the same API. Regressing winner counts against features of the winning combination (count of balls ≤ 31, spread, arithmetic runs) over ~11k stored draws yields a real crowding signal. Per-combination entry counts are not public and never will be. Note `toRecord` currently discards all prize/division fields, so this needs a schema extension — additive and safe, since `matchesMatrix` ignores unknown keys.
- **It changes what the product claims.** "Secure random draw, gently tilted, every combination has identical odds" becomes an expected-value claim, which is a different thing to defend — and it would refuse to show people their own birthdays, the single most common reason anyone picks numbers manually. Prize structures also differ enough across the five games that one λ would not fit them all.

**If it is ever wanted:** ship it as a separate opt-in mode with its own weight budget, its own adjacency baseline (weight-conditional Monte Carlo, not the uniform closed form) and its own honest copy — not folded into the unified draw.

## Local dev

```powershell
npm run serve          # python http.server on :8080
npm test               # everything (core + DOM)
npm run test:core      # RNG, predictor/era, sampler marginals, ingest, freshness,
                       #   history, service worker, workflow + release hygiene.
                       #   Zero dependencies -- this is what the weekly Action runs.
npm run test:dom       # reveal + accessibility, in jsdom (needs npm ci)
npm run audit          # offline reconciliation (matrix/coverage/cadence/freshness)
npm run update-draws   # incremental refresh (--full rebuilds + page log)
npm run marginals      # regenerate the 10M-draw sampler reference (~3.3 min)
npm run icons          # regenerate icons/ from SVG (sharp, canvas fallback)
```

**Dependencies:** the shipped app has **zero** runtime dependencies — `package-lock.json` carries no production entries, and CI fails if that ever changes. `jsdom` and `sharp` are devDependencies only, and neither is installed by the data pipeline.

## Deploy to GitHub Pages (PowerShell)

```powershell
# One-time: winget install GitHub.cli ; then gh auth login --web
cd quickpick-au
git init -b main
git add -A
git commit -m "QuickPick AU v1.0.0 — PWA lottery quick pick"
gh repo create quickpick-au --public --source=. --push

# Enable Pages on main branch root (409 = already enabled, fine)
gh api -X POST repos/{owner}/quickpick-au/pages -f "source[branch]=main" -f "source[path]=/"

# Wait for first build, get URL
do { Start-Sleep 10; $p = gh api repos/{owner}/quickpick-au/pages | ConvertFrom-Json; $p.status } while ($p.status -ne 'built')
$u = $p.html_url; $u

# Verify manifest + SW load over HTTPS
foreach ($f in @('','manifest.webmanifest','sw.js','app.js','icons/icon-192.png')) {
  '{0,-28} {1}' -f ($f -eq '' ? '(index)' : $f), (Invoke-WebRequest ($u + $f) -UseBasicParsing).StatusCode
}
```

**Every subsequent deploy:** bump `VERSION` in `sw.js` **and** `version` in `package.json` to the same number, commit, `git push`. The versioned shell cache is what forces clients to pick up new assets; `test/version.test.mjs` fails the build if the two drift apart.

**Service worker caching.** Two caches, deliberately split:

| cache | keyed by | contents | behaviour |
|---|---|---|---|
| `quickpick-au-shell-<VERSION>` | app version | HTML/CSS/JS/icons (~93 KB raw) | atomic precache at install, cache-first |
| `quickpick-au-draws-<DRAW_SCHEMA>` | data format | `data/draws/*.json` (892 KB) | runtime, cache-first + background refresh |

`addAll()` is atomic, so with draw data in the precache one flaky fetch of one 315 KB file used to reject the whole install and leave the user with no offline capability at all — not even the 23 KB shell. And because the draw cache is keyed by `DRAW_SCHEMA` rather than `VERSION`, a deploy no longer evicts it: previously every version bump re-downloaded all five files for a one-line CSS change. A game whose file was never fetched returns a clean 504 and shows "connect once to fetch it"; everything else keeps working offline.

## Add to iPhone home screen

1. Open the Pages URL in Safari.
2. Share → **Add to Home Screen**.
3. Launch from the icon — standalone, dark navy status bar. Airplane mode to confirm offline.

## Notes

- `prefers-reduced-motion` skips the animation and shows instant results.
- History: last 100 draws in `localStorage`.
- Haptic tick (`navigator.vibrate(30)`) on each ball release where supported (Android; iOS Safari ignores it).
- Plain coloured chips only — no official lottery logos or trademarked artwork.

Random picks don't change the odds. Gamble responsibly — [gamblinghelponline.org.au](https://www.gamblinghelponline.org.au)
