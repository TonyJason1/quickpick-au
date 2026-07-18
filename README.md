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

Second tab: era-aware "predictor" over the real draw history. **For entertainment only — every combination has identical odds** (the fixed footer says exactly that). Four modes:

| Mode | Pick rule |
|---|---|
| HOT | top-K era frequency (ties broken by crypto RNG) |
| COLD | bottom-K era frequency (ties random) |
| OVERDUE | longest current absence streak (ties random) |
| ORACLE | weighted crypto sample, weight = 1 + 0.5 × min-max-normalised era frequency, rejection sampling |

Play formats: TattsLotto 7, Oz Lotto 8, Powerball 7 mains (PowerHit — all 20 Powerballs covered, PB barrel hidden), Set for Life 2×7 (rank modes give two disjoint lines, ORACLE two independent draws), Weekday Windfall 7. Tap a ball for its stat ("drawn N× in M draws since year"). Stats count main numbers only.

**Era filter:** stats only ever use the current-matrix era, auto-detected per game by walking back from the latest draw until the record shape stops matching (Powerball 6→7 mains 2018-04-19, Oz Lotto +1 supp 2022-05-17, Set for Life 7/44 product start 2020-03-23). Weekday Windfall includes legacy Mon & Wed Lotto draws (same 6/45 matrix, `legacy: true` in the data, `includeLegacy` option). Detected boundaries are sanity-checked against known change dates and logged to the console.

**Data:** `data/draws/<game>.json` — complete published history from The Lott's public results API (~11k draws; cross-validated against an independent archive). A weekly GitHub Action (`.github/workflows/update-draws.yml`) runs `npm run update-draws`, re-validates, and commits. The service worker precaches the JSON (Oracle works offline) and uses stale-while-revalidate for it, so weekly data lands without a `sw.js` version bump.

## Local dev

```powershell
npm run serve          # python http.server on :8080
npm test               # RNG chi-square + Oracle predictor/era validation
npm run update-draws   # incremental draw-history refresh (--full rebuilds)
npm run icons          # regenerate icons/ from SVG (sharp, canvas fallback)
```

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

**Every subsequent deploy:** bump `VERSION` in `sw.js` (e.g. `v1.0.1`), commit, `git push`. The versioned cache name forces clients to pick up new assets.

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
