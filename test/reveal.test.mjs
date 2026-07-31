/* QuickPick AU — reveal correctness (H1) and attribute escaping (M5).
 *
 * The H1 bug was invisible at rest: finalizeLineOne rebuilt the line correctly
 * once the animation finished, so any assertion taken after the reveal passed.
 * It was only wrong DURING the reveal. Every check here therefore runs after
 * EVERY individual ball release, across the whole line, not once at the end.
 *
 * A negative control reproduces the original positional builder+filler and
 * asserts the invariant genuinely fails against it — otherwise this file would
 * prove nothing.
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { shuffled } from "../rng.js";
import {
  ORACLE_GAMES, computeStats, detectEra, pickOracleUnified, tooltipText
} from "../js/predictor.js";
import {
  ballLabel, esc, isFullyRevealed, pillHTML, pillsHTML, revealBall, revealRemaining
} from "../js/reveal.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const dom = new JSDOM('<!doctype html><div id="list"></div>');
const { document } = dom.window;
const list = document.getElementById("list");

const realData = (file) =>
  JSON.parse(readFileSync(new URL(`../data/draws/${file}.json`, import.meta.url), "utf8"));

function statsFor(key) {
  const game = ORACLE_GAMES[key];
  const era = detectEra(realData(game.file), game.matrix, { eraFloor: game.eraFloor });
  return computeStats(era.draws, game.matrix.pool);
}

/** Render one line of placeholders and return its row element. */
function renderRow(line, opts = {}) {
  list.innerHTML = `<div class="line" data-idx="0"><span class="pills">${
    pillsHTML(line, { placeholder: true, ...opts })
  }</span></div>`;
  return list.querySelector(".line");
}

/**
 * THE INVARIANT. For every pill in the row, at this instant:
 *   revealed   -> digit === data-n, and tip/title/aria-label describe data-n
 *   placeholder-> no digit, no tooltip, no accessible name, aria-hidden
 */
function assertAgreement(row, stats, when) {
  const pills = [...row.querySelectorAll(".pill")];
  ok(pills.length > 0, `${when}: no pills`);
  for (const pill of pills) {
    const n = Number(pill.getAttribute("data-n"));
    ok(Number.isInteger(n), `${when}: pill has no integer data-n`);

    if (pill.classList.contains("placeholder")) {
      eq(pill.textContent, "", `${when}: unrevealed pill shows a digit`);
      ok(!pill.hasAttribute("data-tip"), `${when}: unrevealed pill carries a tooltip`);
      ok(!pill.hasAttribute("title"), `${when}: unrevealed pill carries a title`);
      ok(!pill.hasAttribute("aria-label"), `${when}: unrevealed pill has an accessible name`);
      eq(pill.getAttribute("aria-hidden"), "true", `${when}: unrevealed pill is not aria-hidden`);
      continue;
    }

    eq(pill.textContent, String(n), `${when}: DIGIT/SLOT MISMATCH — pill shows "${pill.textContent}" in slot data-n="${n}"`);
    ok(!pill.hasAttribute("aria-hidden"), `${when}: revealed pill still aria-hidden`);

    if (pill.classList.contains("extra") || !stats) continue;
    const expected = tooltipText(stats, n);
    eq(pill.getAttribute("data-tip"), expected, `${when}: ball ${n} data-tip belongs to another ball`);
    eq(pill.getAttribute("title"), expected, `${when}: ball ${n} title belongs to another ball`);
    eq(pill.getAttribute("aria-label"), ballLabel(n, expected), `${when}: ball ${n} aria-label belongs to another ball`);
  }
}

/* ------------------------------------------- 1. mid-animation agreement */

for (const key of Object.keys(ORACLE_GAMES)) {
  check(`${key}: digit / tooltip / aria agree after EVERY ball release`, () => {
    const game = ORACLE_GAMES[key];
    const stats = statsFor(key);
    const tipFor = (n) => tooltipText(stats, n);

    for (let trial = 0; trial < 8; trial++) {
      const nums = pickOracleUnified(stats, game.picks);
      const row = renderRow({ nums, extra: null }, { tipFor });
      assertAgreement(row, stats, `${key} trial ${trial}: before any release`);

      const order = shuffled(nums); // exactly what animateLine does
      order.forEach((n, i) => {
        ok(revealBall(row, n, { tip: tipFor(n) }), `ball ${n} had no slot`);
        assertAgreement(row, stats, `${key} trial ${trial}: after ${i + 1}/${order.length} releases`);
      });
      ok(isFullyRevealed(row), "row should be fully revealed");
    }
  });
}

check("k=20 System cap — the 8-second window the bug was widest in", () => {
  const stats = statsFor("tattslotto");
  const tipFor = (n) => tooltipText(stats, n);
  const nums = pickOracleUnified(stats, 20);
  const row = renderRow({ nums, extra: null }, { tipFor });
  shuffled(nums).forEach((n, i) => {
    revealBall(row, n, { tip: tipFor(n) });
    assertAgreement(row, stats, `cap: after ${i + 1}/20 releases`);
  });
});

check("Powerball: a main and the extra ball may share a value", () => {
  // Main 7 and PB 7 coexist; the selector must not cross-fill.
  const row = renderRow({ nums: [2, 7, 14, 21, 25, 30, 33], extra: 7 }, { extraLabel: "PB" });
  ok(revealBall(row, 7, { extra: true }), "extra 7 must reveal");
  const mains = [...row.querySelectorAll(".pill:not(.extra)")];
  eq(mains.filter((p) => !p.classList.contains("placeholder")).length, 0,
    "revealing the extra 7 must not fill main 7");
  ok(revealBall(row, 7), "main 7 must still be revealable");
  assertAgreement(row, null, "powerball shared value");
});

/* --------------------------------- 2. negative control: the original bug */

check("NEGATIVE CONTROL: the original positional reveal fails this invariant", () => {
  const stats = statsFor("tattslotto");
  const nums = pickOracleUnified(stats, 7);

  // The pre-fix builder: tooltips emitted on placeholders, in sorted order.
  const oldPills = nums
    .map((n) => {
      const tip = tooltipText(stats, n);
      return `<span class="pill placeholder" data-n="${n}" data-tip="${tip}" title="${tip}" aria-label="Ball ${n} — ${tip}"></span>`;
    })
    .join("");
  list.innerHTML = `<div class="line" data-idx="0"><span class="pills">${oldPills}</span></div>`;
  const row = list.querySelector(".line");

  // The pre-fix filler: first empty slot in DOM order, attributes untouched.
  const oldFill = (n) => {
    const slot = row.querySelector(".pill.placeholder:not(.extra)");
    if (slot) { slot.classList.remove("placeholder"); slot.textContent = String(n); }
  };

  // Force a release order that is definitely not sorted.
  const order = [...nums].reverse();
  let mismatchSeen = false;
  order.forEach((n) => {
    oldFill(n);
    for (const pill of row.querySelectorAll(".pill:not(.placeholder)")) {
      if (pill.textContent !== pill.getAttribute("data-n")) mismatchSeen = true;
    }
  });
  ok(mismatchSeen,
    "the old positional reveal should mis-pair digit and tooltip — if this passes, the invariant above has no teeth");
});

/* -------------------------------------------- 3. skip path idempotence */

check("skip reveals everything exactly once and stays consistent", () => {
  const stats = statsFor("ozlotto");
  const tipFor = (n) => tooltipText(stats, n);
  const nums = pickOracleUnified(stats, 8);
  const row = renderRow({ nums, extra: null }, { tipFor });

  // Partial reveal, as if the user tapped to skip mid-animation.
  const order = shuffled(nums);
  revealBall(row, order[0], { tip: tipFor(order[0]) });
  revealBall(row, order[1], { tip: tipFor(order[1]) });
  assertAgreement(row, stats, "partial");

  eq(revealRemaining(row, { nums, extra: null }, { tipFor }), nums.length - 2, "fills only what is left");
  assertAgreement(row, stats, "after skip");
  ok(isFullyRevealed(row), "fully revealed");

  // finalizeLineOne runs revealRemaining again — must be a no-op.
  eq(revealRemaining(row, { nums, extra: null }, { tipFor }), 0, "second pass fills nothing");
  assertAgreement(row, stats, "after redundant finalize");
});

check("revealing a ball twice, or one not in the line, is a no-op", () => {
  const row = renderRow({ nums: [1, 2, 3, 4, 5, 6], extra: null });
  ok(revealBall(row, 3), "first reveal");
  ok(!revealBall(row, 3), "second reveal must return false");
  ok(!revealBall(row, 44), "ball not in this line");
  ok(!revealBall(row, 1.5), "non-integer");
  ok(!revealBall(null, 3), "missing row");
});

/* --------------------------------------------------- 4. M5: escaping */

check("attribute interpolation is escaped", () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const html = pillHTML(7, { tip: hostile });
  ok(!html.includes("<img"), `raw markup survived escaping: ${html}`);
  ok(html.includes("&quot;"), "quotes must be entity-encoded");

  list.innerHTML = `<div class="line"><span class="pills">${html}</span></div>`;
  eq(list.querySelectorAll("img").length, 0, "no element was injected");
  const pill = list.querySelector(".pill");
  eq(pill.getAttribute("data-tip"), hostile, "the tooltip text itself round-trips intact");
  eq(pill.getAttribute("aria-label"), ballLabel(7, hostile), "aria-label round-trips intact");
});

check("the extra-ball separator label is escaped too", () => {
  const html = pillsHTML({ nums: [1, 2], extra: 3 }, { extraLabel: '<script>x</script>' });
  ok(!/<script>/.test(html), "script tag must not survive");
  list.innerHTML = `<div class="line"><span class="pills">${html}</span></div>`;
  eq(list.querySelectorAll("script").length, 0, "no script element created");
});

check("esc covers the five significant characters", () => {
  eq(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;", "entity map");
  eq(esc(42), "42", "non-strings coerced");
});

check("the reveal path sets attributes without interpolation", () => {
  const hostile = '"><b>x</b>';
  const row = renderRow({ nums: [1, 2, 3, 4, 5, 6], extra: null });
  revealBall(row, 4, { tip: hostile });
  const pill = row.querySelector('.pill[data-n="4"]');
  eq(pill.getAttribute("data-tip"), hostile, "setAttribute stores the literal string");
  eq(row.querySelectorAll("b").length, 0, "no element injected via the reveal path");
});

/* -------------------------------------------------- 5. builder contract */

check("pillHTML rejects a non-integer ball", () => {
  for (const bad of ["7", 7.5, null, undefined, NaN]) {
    let threw = false;
    try { pillHTML(bad); } catch { threw = true; }
    ok(threw, `must reject ${String(bad)}`);
  }
});

check("placeholders are addressable but carry nothing announceable", () => {
  const stats = statsFor("setforlife");
  const nums = pickOracleUnified(stats, 7);
  const row = renderRow({ nums, extra: null }, { tipFor: (n) => tooltipText(stats, n) });
  const pills = [...row.querySelectorAll(".pill")];
  eq(pills.length, 7, "one pill per ball");
  eq(pills.map((p) => Number(p.getAttribute("data-n"))).join(","), nums.join(","), "slots in sorted order");
  assertAgreement(row, stats, "all placeholders");
});

/* ------------------------------------------------------------- report */

console.log(`\nReveal + escaping: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
