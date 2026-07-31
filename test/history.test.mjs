/* QuickPick AU — history persistence guard (M1).
 *
 * The review found that a corrupt `qp_history_v1` blob threw out of
 * renderHistory(), which app.js calls as a top-level init statement — so
 * module evaluation aborted and the app never booted at all. The six payloads
 * in CORRUPT_FIXTURES are the verified repros from that report, with the exact
 * TypeError each one produced against the old inline loader.
 *
 * The contract proven here: for ANY stored value, loadHistory returns an array
 * whose shape renderHistory can walk without throwing.
 */

import { HIST_MAX, clearHistory, loadHistory, sanitizeHistory, saveHistory } from "../js/history.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${what} expected ${jb}, got ${ja}`);
}

class MemStorage {
  constructor(seed) { this.map = new Map(seed ? Object.entries(seed) : []); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
class HostileStorage {
  getItem() { throw new DOMException("blocked", "SecurityError"); }
  setItem() { throw new DOMException("quota", "QuotaExceededError"); }
  removeItem() { throw new DOMException("blocked", "SecurityError"); }
}

/* The exact repro payloads from the review, with their old failure modes. */
const CORRUPT_FIXTURES = [
  ['{"a":1}', "pushHistory: h.unshift is not a function / renderHistory: not iterable"],
  ["null", "pushHistory: cannot read 'unshift' of null / renderHistory: not iterable"],
  ["[1,2,3]", "renderHistory: cannot read 'map' of undefined"],
  ["[{}]", "renderHistory: cannot read 'map' of undefined"],
  ['"str"', "pushHistory: h.unshift is not a function / renderHistory: cannot read 'map'"],
  ["[]", "(control — this one was always fine)"]
];

/* Additional shapes that are JSON-valid but structurally wrong. */
const MORE_GARBAGE = [
  "not json at all {{{", "", "0", "false", "[[]]", '[{"lines":[]}]',
  '[{"name":"x","ts":1,"lines":null}]',
  '[{"name":"x","ts":1,"lines":[{"n":"nope"}]}]',
  '[{"name":"x","ts":"not-a-number","lines":[{"n":[1,2]}]}]',
  '[{"name":42,"ts":1,"lines":[{"n":[1,2]}]}]',
  '[{"ts":1,"lines":[{"n":[1,2]}]}]',
  '[{"name":"x","ts":1,"lines":[{"n":[1.5,2]}]}]',
  '[null,null]', '[[1,2],[3,4]]'
];

/** Exactly what renderHistory() does with each entry — must never throw. */
function walkLikeRenderHistory(hist) {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });
  let out = "";
  for (const h of hist) {
    out += `${h.name} · ${h.lines.length} line${h.lines.length > 1 ? "s" : ""}`;
    out += fmt.format(new Date(h.ts));
    out += h.lines
      .map((l) => l.n.join(" ") + (l.e != null ? ` | ${h.extraLabel || "Extra"} ${l.e}` : ""))
      .join("\n");
  }
  return out;
}

/* ------------------------------------------- 1. corrupt blobs never throw */

for (const [raw, oldFailure] of CORRUPT_FIXTURES) {
  check(`corrupt fixture ${JSON.stringify(raw)} — discarded, boot survives`, () => {
    const store = new MemStorage({ qp_history_v1: raw });
    const hist = loadHistory(store);
    ok(Array.isArray(hist), `must return an array (old failure: ${oldFailure})`);
    walkLikeRenderHistory(hist); // the call that used to abort module init
  });
}

check("additional malformed shapes are all discarded without throwing", () => {
  for (const raw of MORE_GARBAGE) {
    const hist = loadHistory(new MemStorage({ qp_history_v1: raw }));
    ok(Array.isArray(hist), `not an array for ${raw}`);
    walkLikeRenderHistory(hist);
  }
});

check("sanitizeHistory never throws for any primitive input", () => {
  for (const raw of [undefined, null, "", "[", "{", "undefined", "NaN", "1e999"]) {
    ok(Array.isArray(sanitizeHistory(raw)), `not an array for ${String(raw)}`);
  }
});

check("storage that throws on read is survivable", () => {
  const hist = loadHistory(new HostileStorage());
  eq(hist, [], "blocked storage yields empty history");
  walkLikeRenderHistory(hist);
});

/* ------------------------------------------------ 2. valid data survives */

const GOOD = {
  game: "tattslotto", name: "TattsLotto", ts: 1753400000000, extraLabel: null,
  lines: [{ n: [3, 11, 19, 24, 31, 42], e: null }]
};

check("valid entries round-trip unchanged", () => {
  const store = new MemStorage();
  saveHistory(store, GOOD);
  const [got] = loadHistory(store);
  eq(got, { ...GOOD, extraLabel: null }, "entry preserved");
  eq(walkLikeRenderHistory([got]).includes("3 11 19 24 31 42"), true, "renders its numbers");
});

check("Powerball entries keep their extra ball and label", () => {
  const store = new MemStorage();
  const pb = {
    game: "powerball", name: "Powerball", ts: 1753400000000, extraLabel: "PB",
    lines: [{ n: [2, 9, 14, 21, 25, 30, 33], e: 4 }]
  };
  saveHistory(store, pb);
  eq(loadHistory(store)[0], pb, "PB entry preserved");
  ok(walkLikeRenderHistory(loadHistory(store)).includes("| PB 4"), "extra ball rendered");
});

check("a partially corrupt list keeps its valid entries", () => {
  const raw = JSON.stringify([GOOD, { junk: true }, null, GOOD, [1, 2], "x"]);
  const hist = loadHistory(new MemStorage({ qp_history_v1: raw }));
  eq(hist.length, 2, "both valid entries survive, the four broken ones are dropped");
  walkLikeRenderHistory(hist);
});

check("multi-line entries survive (Set for Life, Oracle lines)", () => {
  const store = new MemStorage();
  const sfl = {
    game: "setforlife", name: "Set for Life — The Oracle", ts: 1753400000000, extraLabel: null,
    lines: [{ n: [1, 2, 3, 4, 5, 6, 7], e: null }, { n: [8, 9, 10, 11, 12, 13, 14], e: null }]
  };
  saveHistory(store, sfl);
  eq(loadHistory(store)[0].lines.length, 2, "both lines preserved");
});

/* ------------------------------------------------------ 3. cap + writes */

check("history is capped at HIST_MAX newest-first", () => {
  const store = new MemStorage();
  for (let i = 0; i < HIST_MAX + 25; i++) saveHistory(store, { ...GOOD, ts: 1753400000000 + i });
  const hist = loadHistory(store);
  eq(hist.length, HIST_MAX, "capped");
  eq(hist[0].ts, 1753400000000 + HIST_MAX + 24, "newest first");
});

check("a corrupt blob does not block writing new history", () => {
  const store = new MemStorage({ qp_history_v1: '{"a":1}' });
  saveHistory(store, GOOD);
  const hist = loadHistory(store);
  eq(hist.length, 1, "corrupt blob replaced by the new entry");
  walkLikeRenderHistory(hist);
});

check("quota-exceeded on write is non-fatal", () => {
  saveHistory(new HostileStorage(), GOOD); // must not throw
  clearHistory(new HostileStorage());      // must not throw
});

check("clearHistory empties the store", () => {
  const store = new MemStorage();
  saveHistory(store, GOOD);
  clearHistory(store);
  eq(loadHistory(store), [], "cleared");
});

/* ------------------------------------------------------------- report */

console.log(`\nHistory persistence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
