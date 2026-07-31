/* QuickPick AU — accessibility cluster (M7-M10).
 *
 * Boots the REAL app.js inside jsdom against the REAL index.html, so these are
 * the shipped handlers and the shipped markup, not a reimplementation.
 *
 * What the review found:
 *   M7  role="tab" declared with no aria-controls, no tabpanel, no arrow keys
 *   M8  stepper values were plain spans: pressing +/- announced nothing
 *   M9  per-ball stats were pointer-only; pills were non-focusable spans
 *   M10 #resultsList was aria-live, so a draw fired one announcement per
 *       revealed ball (up to 20) and then re-announced the whole line
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

/* ------------------------------------------------------------- boot */

const dom = new JSDOM(html, {
  url: "https://example.test/",
  pretendToBeVisual: true,
  virtualConsole: new (await import("jsdom")).VirtualConsole() // swallow "canvas not implemented"
});
const { window } = dom;
const { document } = window;

// app.js reads these as bare globals.
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.performance = window.performance;
globalThis.CustomEvent = window.CustomEvent;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.confirm = () => true;
globalThis.addEventListener = window.addEventListener.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });

// Reduced motion: draws resolve instantly, which is what lets us assert the
// end state without driving the animation clock. The reveal itself is covered
// in reveal.test.mjs.
globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.fetch = async (url) => {
  const file = String(url).split("/").pop();
  const body = readFileSync(new URL(`data/draws/${file}`, root), "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
};

await import("../app.js");
const $ = (id) => document.getElementById(id);
const settle = () => new Promise((r) => setTimeout(r, 0));

/* --------------------------------------------- M7: tab semantics */

await check("M7: each tab controls a real tabpanel that points back at it", () => {
  for (const id of ["tabPick", "tabOracle"]) {
    const tab = $(id);
    eq(tab.getAttribute("role"), "tab", `${id} role`);
    const panelId = tab.getAttribute("aria-controls");
    ok(panelId, `${id} has no aria-controls`);
    const panel = $(panelId);
    ok(panel, `${id} aria-controls="${panelId}" points at nothing`);
    eq(panel.getAttribute("role"), "tabpanel", `${panelId} role`);
    eq(panel.getAttribute("aria-labelledby"), id, `${panelId} must name its tab`);
  }
  eq($("tabPick").parentElement.getAttribute("role"), "tablist", "tablist wrapper");
});

await check("M7: roving tabindex — only the selected tab is in the tab order", () => {
  $("tabPick").click();
  eq($("tabPick").getAttribute("aria-selected"), "true", "pick selected");
  eq($("tabPick").tabIndex, 0, "selected tab reachable");
  eq($("tabOracle").tabIndex, -1, "unselected tab out of the tab order");

  $("tabOracle").click();
  eq($("tabOracle").getAttribute("aria-selected"), "true", "oracle selected");
  eq($("tabOracle").tabIndex, 0, "selected tab reachable");
  eq($("tabPick").tabIndex, -1, "unselected tab out of the tab order");
});

await check("M7: arrow keys move between tabs, Home/End jump to the ends", () => {
  const key = (el, k) => el.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
  );

  $("tabPick").click();
  key($("tabPick"), "ArrowRight");
  eq($("tabOracle").getAttribute("aria-selected"), "true", "ArrowRight selects the next tab");
  eq(document.activeElement.id, "tabOracle", "ArrowRight moves focus");

  key($("tabOracle"), "ArrowLeft");
  eq($("tabPick").getAttribute("aria-selected"), "true", "ArrowLeft selects the previous tab");

  key($("tabPick"), "End");
  eq($("tabOracle").getAttribute("aria-selected"), "true", "End selects the last tab");
  key($("tabOracle"), "Home");
  eq($("tabPick").getAttribute("aria-selected"), "true", "Home selects the first tab");

  // Arrow keys must be consumed, not left to scroll the page.
  $("tabPick").click();
  const ev = new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  $("tabPick").dispatchEvent(ev);
  ok(ev.defaultPrevented, "arrow key must be preventDefault()ed");
});

await check("M7: panel visibility follows the selected tab", () => {
  $("tabPick").click();
  eq($("pickControls").hidden, false, "pick panel visible");
  eq($("oracleCard").hidden, true, "oracle panel hidden");
  $("tabOracle").click();
  eq($("oracleCard").hidden, false, "oracle panel visible");
  eq($("pickControls").hidden, true, "pick panel hidden");
});

/* --------------------------------------- M8: stepper announcements */

await check("M8: every stepper value is a spinbutton with a real label", () => {
  for (const id of ["oPicksVal", "oLinesVal", "cPoolVal", "cPicksVal", "cExtraPoolVal"]) {
    const el = $(id);
    eq(el.getAttribute("role"), "spinbutton", `${id} role`);
    eq(el.tabIndex, 0, `${id} must be focusable`);
    const labelId = el.getAttribute("aria-labelledby");
    ok(labelId && $(labelId), `${id} aria-labelledby="${labelId}" points at nothing`);
    for (const attr of ["aria-valuenow", "aria-valuemin", "aria-valuemax"]) {
      ok(el.hasAttribute(attr), `${id} missing ${attr}`);
    }
  }
});

await check("M8: pressing +/- updates aria-valuenow, not just the text", () => {
  $("tabOracle").click();
  const val = $("oPicksVal");
  const plus = document.querySelector('#oracleCtls .step-btn[data-oq="picks"][data-dir="1"]');
  const minus = document.querySelector('#oracleCtls .step-btn[data-oq="picks"][data-dir="-1"]');

  const before = Number(val.getAttribute("aria-valuenow"));
  eq(val.textContent, String(before), "text and aria-valuenow start in sync");

  plus.click();
  const after = Number(val.getAttribute("aria-valuenow"));
  eq(after, before + 1, "aria-valuenow tracks the increment");
  eq(val.textContent, String(after), "text stays in sync");

  minus.click();
  eq(Number(val.getAttribute("aria-valuenow")), before, "aria-valuenow tracks the decrement");
});

await check("M8: the spinbutton itself responds to arrows and Home/End", () => {
  $("tabOracle").click();
  const val = $("oPicksVal");
  const key = (k) => val.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
  );
  const now = () => Number(val.getAttribute("aria-valuenow"));

  const min = Number(val.getAttribute("aria-valuemin"));
  const max = Number(val.getAttribute("aria-valuemax"));

  key("Home");
  eq(now(), min, "Home jumps to the minimum");
  key("ArrowUp");
  eq(now(), min + 1, "ArrowUp increments");
  key("ArrowDown");
  eq(now(), min, "ArrowDown decrements");
  key("ArrowDown");
  eq(now(), min, "must not go below the minimum");
  key("End");
  eq(now(), max, "End jumps to the maximum");
  key("ArrowUp");
  eq(now(), max, "must not go above the maximum");
  key("Home");
});

await check("M8: bounds match the game's verified entry limits", () => {
  $("tabOracle").click();
  const bounds = () => [
    Number($("oPicksVal").getAttribute("aria-valuemin")),
    Number($("oPicksVal").getAttribute("aria-valuemax"))
  ];
  const chip = (name) => [...$("chips").children].find((c) => c.textContent.trim() === name);

  chip("TattsLotto").click();
  eq(JSON.stringify(bounds()), JSON.stringify([6, 20]), "TattsLotto 6-20");
  chip("Set for Life").click();
  eq(JSON.stringify(bounds()), JSON.stringify([7, 7]), "Set for Life pinned at 7 (no System entries)");
  chip("Oz Lotto").click();
  eq(JSON.stringify(bounds()), JSON.stringify([7, 20]), "Oz Lotto 7-20");
  chip("TattsLotto").click();
});

/* ------------------------------- M9 + M10: reveal, pills, live region */

await check("M10: the results list is not a live region; a status element is", () => {
  ok(!$("resultsList").hasAttribute("aria-live"),
    "#resultsList must not be aria-live — it fired one announcement per revealed ball");
  const status = $("revealStatus");
  ok(status, "#revealStatus missing");
  eq(status.getAttribute("role"), "status", "status role");
  eq(status.getAttribute("aria-live"), "polite", "polite live region");
  ok(status.classList.contains("sr-only"), "status must be visually hidden");
});

await check("M10: a quick pick produces exactly one coalesced announcement", () => {
  $("tabPick").click();
  $("drawBtn").click();

  const text = $("revealStatus").textContent;
  ok(text.length > 0, "nothing was announced");
  ok(/TattsLotto/.test(text), `announcement should name the game: "${text}"`);
  ok(/Line 1:/.test(text), `announcement should summarise line 1: "${text}"`);

  const digits = [...document.querySelectorAll('#resultsList .line[data-idx="0"] .pill')]
    .map((p) => p.textContent);
  for (const d of digits) {
    ok(text.includes(d), `announcement omits ball ${d}: "${text}"`);
  }
});

await check("M10: multi-line draws mention the remaining lines once", () => {
  $("tabPick").click();
  $("qtySlider").value = "3";
  $("qtySlider").dispatchEvent(new window.Event("input", { bubbles: true }));
  $("drawBtn").click();
  const text = $("revealStatus").textContent;
  ok(/2 further lines listed below/.test(text), `expected a summary of the rest: "${text}"`);
  $("qtySlider").value = "1";
  $("qtySlider").dispatchEvent(new window.Event("input", { bubbles: true }));
});

await check("M9: Oracle stat pills are keyboard reachable and named", async () => {
  $("tabOracle").click();
  await settle();
  $("drawBtn").click();
  await settle();
  await settle();

  const pills = [...document.querySelectorAll('#resultsList .line[data-idx="0"] .pill[data-tip]')];
  ok(pills.length > 0, "expected Oracle pills carrying stats");
  for (const pill of pills) {
    eq(pill.tabIndex, 0, `ball ${pill.textContent} must be in the tab order`);
    eq(pill.getAttribute("role"), "button", `ball ${pill.textContent} must expose a button role`);
    const label = pill.getAttribute("aria-label");
    ok(label && label.includes(pill.textContent),
      `ball ${pill.textContent} accessible name "${label}" must name the ball it is on`);
    ok(/drawn \d+/.test(label), `accessible name should carry the stats: "${label}"`);
  }
});

await check("M9: focus and Enter/Escape drive the stat bubble, not just taps", async () => {
  $("tabOracle").click();
  await settle();
  $("drawBtn").click();
  await settle();
  await settle();

  const pill = document.querySelector('#resultsList .pill[data-tip]');
  ok(pill, "no Oracle pill found");
  const bubble = document.querySelector(".tip-bubble");
  ok(bubble, "tip bubble missing");
  eq(bubble.getAttribute("aria-hidden"), "true", "bubble duplicates the pill's label — must not double-announce");

  pill.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  ok(bubble.classList.contains("show"), "focusing a pill must reveal its stats");
  eq(bubble.textContent, pill.getAttribute("data-tip"), "bubble shows THIS ball's stats");

  pill.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok(!bubble.classList.contains("show"), "Escape must dismiss");

  const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  pill.dispatchEvent(enter);
  ok(bubble.classList.contains("show"), "Enter must re-open");
  ok(enter.defaultPrevented, "Enter must be consumed");

  pill.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  ok(!bubble.classList.contains("show"), "blur must dismiss");
});

await check("plain quick-pick pills carry no stats and stay out of the tab order", () => {
  $("tabPick").click();
  $("drawBtn").click();
  const pills = [...document.querySelectorAll('#resultsList .line[data-idx="0"] .pill')];
  ok(pills.length > 0, "expected pills");
  for (const pill of pills) {
    ok(!pill.hasAttribute("data-tip"), "quick picks have no era stats to show");
    ok(pill.tabIndex !== 0, "a pill with nothing to say must not be a tab stop");
  }
});

/* ------------------------------------------------------------- report */

console.log(`\nAccessibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
