/* QuickPick AU — result-line rendering and the ball-machine reveal.
 *
 * Split out of app.js so the reveal can be tested against a real DOM.
 *
 * H1. Pills were laid out in SORTED order but filled by DOM POSITION
 * (`.pill.placeholder:not(.extra)` — always the first empty slot), while balls
 * are released in SHUFFLED order. So the first released ball's digit landed in
 * the first pill, which carried a different ball's data-tip / title /
 * aria-label. For the whole reveal — 2.4s at k=6, 8s at the k=20 System cap —
 * every revealed ball asserted another ball's statistics, and the tap-to-show
 * bubble and desktop title hover were both live throughout. finalizeLineOne
 * silently repaired it at the end, which is why it survived review.
 *
 * Slots are now addressed by VALUE: each pill is stamped with data-n at build
 * time and a released ball can only ever land in its own slot. Digit, tooltip
 * and accessible name are therefore correct at every instant, not just at rest.
 *
 * M5. The old pill builder interpolated the tooltip straight into three HTML
 * attributes with no escaping. It was not exploitable — tooltipText emits only
 * integers — but the data path runs from The Lott's API through the draw JSON
 * into innerHTML, and every other dynamic sink in app.js correctly used
 * textContent. Attribute values are escaped here at build time, and the reveal
 * path sets them via setAttribute, so it is escaping-free by construction.
 */

/** Escape a value for interpolation into a double-quoted HTML attribute. */
export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Accessible name for a revealed ball. */
export function ballLabel(n, tip) {
  return tip ? `Ball ${n} — ${tip}` : `Ball ${n}`;
}

/**
 * One pill. Placeholders carry their ball value (so the reveal can find them)
 * but no tooltip and no accessible name — announcing "Ball 23 — drawn 238×"
 * before the ball has been revealed would both spoil the reveal and describe
 * something the user cannot yet see. They are aria-hidden until revealed.
 */
export function pillHTML(n, { extra = false, placeholder = false, tip = null } = {}) {
  if (!Number.isInteger(n)) throw new TypeError(`pillHTML: ball must be an integer, got ${n}`);
  const cls = `pill${extra ? " extra" : ""}${placeholder ? " placeholder" : ""}`;
  const attrs = [`class="${cls}"`, `data-n="${n}"`];
  if (placeholder) {
    attrs.push('aria-hidden="true"');
  } else if (tip) {
    attrs.push(
      `data-tip="${esc(tip)}"`,
      `title="${esc(tip)}"`,
      `aria-label="${esc(ballLabel(n, tip))}"`
    );
  }
  return `<span ${attrs.join(" ")}>${placeholder ? "" : n}</span>`;
}

/**
 * Pills for one line. `tipFor` is called per ball for Oracle draws (era stats)
 * and omitted for plain quick picks.
 */
export function pillsHTML(line, { tipFor = null, extraLabel = null, placeholder = false } = {}) {
  const tip = (n) => (tipFor ? tipFor(n) : null);
  let html = line.nums.map((n) => pillHTML(n, { placeholder, tip: tip(n) })).join("");
  if (line.extra != null) {
    html += `<span class="extra-sep">${esc(extraLabel ?? "Extra")}</span>`;
    html += pillHTML(line.extra, { extra: true, placeholder });
  }
  return html;
}

/**
 * Reveal ball `n` in its OWN slot. Returns true when a slot was filled, false
 * when that ball has already been revealed (or is not in this line) — the
 * caller uses that to stay idempotent across the skip path.
 *
 * Mains and the extra ball are addressed separately: Powerball 7 and main 7
 * can coexist in one line, so the selector must discriminate on .extra.
 */
export function revealBall(row, n, { extra = false, tip = null } = {}) {
  if (!row || !Number.isInteger(n)) return false;
  const scope = extra ? ".extra" : ":not(.extra)";
  const slot = row.querySelector(`.pill.placeholder${scope}[data-n="${n}"]`);
  if (!slot) return false;

  slot.classList.remove("placeholder");
  slot.classList.add("pop");
  slot.textContent = String(n);
  slot.removeAttribute("aria-hidden");
  if (tip) {
    // setAttribute escapes by construction — no interpolation on this path.
    slot.setAttribute("data-tip", tip);
    slot.setAttribute("title", tip);
    slot.setAttribute("aria-label", ballLabel(n, tip));
  }
  return true;
}

/** Reveal every ball still hidden in `line` (the tap-to-skip path). */
export function revealRemaining(row, line, { tipFor = null } = {}) {
  let filled = 0;
  for (const n of line.nums) {
    if (revealBall(row, n, { tip: tipFor ? tipFor(n) : null })) filled++;
  }
  if (line.extra != null && revealBall(row, line.extra, { extra: true })) filled++;
  return filled;
}

/** True once no placeholder remains in the row. */
export function isFullyRevealed(row) {
  return !!row && row.querySelector(".pill.placeholder") === null;
}
