/* QuickPick AU — app logic. Selection is ALWAYS the CSPRNG (rng.js);
 * the ball machine is presentation only. */
import { drawLine, shuffled } from "./rng.js";

/* ---------------------------------------------------------------- games */
const GAMES = {
  tattslotto:      { name: "TattsLotto",       pool: 45, picks: 6, color: "#e4002b" },
  ozlotto:         { name: "Oz Lotto",         pool: 47, picks: 7, color: "#00a651" },
  powerball:       { name: "Powerball",        pool: 35, picks: 7, color: "#1e4b9e",
                     extra: { label: "PB", pool: 20, picks: 1 } },
  setforlife:      { name: "Set for Life",     pool: 44, picks: 7, color: "#2bb5b0" },
  weekdaywindfall: { name: "Weekday Windfall", pool: 45, picks: 6, color: "#5c2d91" },
  custom:          { name: "Custom",           color: "#f5a623" } // user-defined, see Controls
};

/* ---------------------------------------------------------------- state */
const PREFS_KEY = "qp_prefs_v1";
const HIST_KEY = "qp_history_v1";
const HIST_MAX = 100;

const state = {
  game: "tattslotto",
  qty: 1,
  custom: { pool: 45, picks: 6, extraOn: false, extraPool: 20 },
  animating: false
};

try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
  if (saved && GAMES[saved.game]) {
    state.game = saved.game;
    state.qty = clamp(saved.qty | 0, 1, 50);
    if (saved.custom) {
      state.custom.pool = clamp(saved.custom.pool | 0, 2, 99);
      state.custom.picks = clamp(saved.custom.picks | 0, 1, Math.min(20, state.custom.pool - 1));
      state.custom.extraOn = !!saved.custom.extraOn;
      state.custom.extraPool = clamp(saved.custom.extraPool | 0, 2, 99);
    }
  }
} catch { /* fresh start */ }

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      game: state.game, qty: state.qty, custom: state.custom
    }));
  } catch { /* storage full/blocked — non-fatal */ }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Effective matrix for the current game. */
function currentSpec() {
  if (state.game === "custom") {
    const c = state.custom;
    return {
      name: "Custom",
      color: GAMES.custom.color,
      pool: c.pool,
      picks: Math.min(c.picks, c.pool - 1),
      extra: c.extraOn ? { label: "Extra", pool: c.extraPool, picks: 1 } : null
    };
  }
  const g = GAMES[state.game];
  return { name: g.name, color: g.color, pool: g.pool, picks: g.picks, extra: g.extra || null };
}

/* ------------------------------------------------------------- elements */
const $ = (id) => document.getElementById(id);
const els = {
  chips: $("chips"), chamber: $("chamber"), pbWrap: $("pbWrap"), pbChamber: $("pbChamber"),
  skipHint: $("skipHint"), qtySlider: $("qtySlider"), qtyVal: $("qtyVal"),
  customCtls: $("customCtls"), cPoolVal: $("cPoolVal"), cPicksVal: $("cPicksVal"),
  cExtraOn: $("cExtraOn"), cExtraRow: $("cExtraRow"), cExtraPoolVal: $("cExtraPoolVal"),
  matrixLine: $("matrixLine"), resultsCard: $("resultsCard"), resultsList: $("resultsList"),
  copyAllBtn: $("copyAllBtn"), historyBox: $("historyBox"), historyList: $("historyList"),
  historyCount: $("historyCount"), clearHistoryBtn: $("clearHistoryBtn"), drawBtn: $("drawBtn")
};

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------- ball machine */
class Chamber {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.balls = [];
    this.count = 0;
    this.color = "#e4002b";
    this.mixUntil = 0;
    this.dpr = 1;
    this.w = 0; this.h = 0; this.r = 14;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const cw = this.canvas.clientWidth || 320;
    const ch = this.canvas.clientHeight || 240;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cw * this.dpr);
    this.canvas.height = Math.round(ch * this.dpr);
    this.w = cw; this.h = ch;
    this.computeRadius();
    if (this.balls.length) this.containAll();
    this.renderOnce();
  }

  computeRadius() {
    const n = Math.max(1, this.count);
    const fill = 0.40; // fraction of chamber area occupied by balls
    this.r = clamp(Math.sqrt((this.w * this.h * fill) / (n * Math.PI)), 9, 22);
  }

  setPool(count, color) {
    this.count = count;
    this.color = color;
    this.computeRadius();
    this.reset();
  }

  reset() {
    this.balls = [];
    const r = this.r;
    const perRow = Math.max(1, Math.floor((this.w - 2 * r) / (2 * r + 2)));
    for (let i = 0; i < this.count; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      this.balls.push({
        n: i + 1,
        x: clamp(r + 2 + col * (2 * r + 2) + (row % 2) * r, r, this.w - r),
        y: this.h - r - 1 - row * (2 * r + 1),
        vx: (Math.random() - 0.5) * 40,
        vy: 0,
        extracted: false,
        resolve: null
      });
    }
    this.renderOnce();
  }

  containAll() {
    for (const b of this.balls) {
      b.x = clamp(b.x, this.r, this.w - this.r);
      b.y = clamp(b.y, this.r, this.h - this.r);
    }
  }

  mixing() { return performance.now() < this.mixUntil; }

  step(dt) {
    const r = this.r, w = this.w, h = this.h;
    const G = 1500 * (h / 380);
    const mixing = this.mixing();
    const gate = { x: w / 2, y: h - r * 0.4 };

    for (const b of this.balls) {
      if (b.extracted) {
        // steer to gate, ignore gravity + collisions
        const dx = gate.x - b.x, dy = gate.y - b.y;
        b.vx += dx * 26 * dt; b.vy += dy * 26 * dt;
        b.vx *= 0.90; b.vy *= 0.90;
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (dx * dx + dy * dy < r * r * 0.8) this.capture(b);
        continue;
      }
      b.vy += G * dt;
      if (mixing) {
        b.vx += (Math.random() - 0.5) * 2600 * dt;
        b.vy += (Math.random() - 0.5) * 1600 * dt;
        if (b.y > h * 0.55) b.vy -= (1900 + Math.random() * 2100) * dt; // bottom blower
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // walls
      if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * 0.82; }
      else if (b.x > w - r) { b.x = w - r; b.vx = -Math.abs(b.vx) * 0.82; }
      if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * 0.82; }
      else if (b.y > h - r) { b.y = h - r; b.vy = -Math.abs(b.vy) * 0.82; b.vx *= 0.985; }
    }

    // elastic ball–ball collisions (equal mass)
    const bs = this.balls, len = bs.length, d2min = (2 * r) * (2 * r);
    for (let i = 0; i < len; i++) {
      const a = bs[i];
      if (a.extracted) continue;
      for (let j = i + 1; j < len; j++) {
        const c = bs[j];
        if (c.extracted) continue;
        let dx = c.x - a.x, dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= d2min || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const overlap = 2 * r - d;
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
        c.x += nx * overlap * 0.5; c.y += ny * overlap * 0.5;
        const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -(1 + 0.92) * vn * 0.5; // restitution 0.92, equal mass
          a.vx -= imp * nx; a.vy -= imp * ny;
          c.vx += imp * nx; c.vy += imp * ny;
        }
      }
    }
  }

  capture(b) {
    const res = b.resolve;
    b.resolve = null;
    this.balls = this.balls.filter((x) => x !== b);
    if (res) res();
  }

  /** Promise resolves when ball `n` reaches the gate (or after a safety timeout). */
  extract(n) {
    return new Promise((resolve) => {
      const b = this.balls.find((x) => x.n === n);
      if (!b) { resolve(); return; }
      b.extracted = true;
      b.resolve = resolve;
      setTimeout(() => { if (b.resolve) this.capture(b); }, 1300); // never stall
    });
  }

  flushExtractions() {
    for (const b of [...this.balls]) if (b.extracted) this.capture(b);
  }

  render() {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    // gate slot
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.roundRect(this.w / 2 - this.r * 1.6, this.h - 5, this.r * 3.2, 5, 3);
    ctx.fill();
    for (const b of this.balls) this.drawBall(ctx, b);
  }

  drawBall(ctx, b) {
    const r = this.r;
    const grad = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, r * 0.15, b.x, b.y, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.72, "#dfe6f8");
    grad.addColorStop(1, "#b9c5e8");
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    // game-colour tint + ring
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.strokeStyle = this.color;
    ctx.stroke();
    ctx.fillStyle = "#0e1c4e";
    ctx.font = `800 ${Math.round(r * 0.95)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.n), b.x, b.y + r * 0.05);
  }

  renderOnce() { if (this.ctx) this.render(); }
}

const chamber = new Chamber(els.chamber);
const pbChamber = new Chamber(els.pbChamber);

/* --------------------------------------------------- animation driver */
let rafId = 0, lastT = 0;
function tick(t) {
  const dt = Math.min(0.032, (t - lastT) / 1000 || 0.016);
  lastT = t;
  for (const ch of [chamber, pbChamber]) {
    if (ch.canvas.offsetParent === null && ch !== chamber) continue; // PB hidden
    // two substeps for stability
    ch.step(dt / 2); ch.step(dt / 2);
    ch.render();
  }
  rafId = requestAnimationFrame(tick);
}
function startLoop() {
  if (!rafId && !reduceMotion.matches && document.visibilityState === "visible") {
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}
function stopLoop() { cancelAnimationFrame(rafId); rafId = 0; }
document.addEventListener("visibilitychange", () =>
  document.visibilityState === "visible" ? startLoop() : stopLoop()
);
reduceMotion.addEventListener?.("change", () => {
  reduceMotion.matches ? (stopLoop(), chamber.renderOnce(), pbChamber.renderOnce()) : startLoop();
});

/* -------------------------------------------------------------- chips */
function buildChips() {
  els.chips.innerHTML = "";
  for (const [key, g] of Object.entries(GAMES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.style.setProperty("--chip-c", g.color);
    b.setAttribute("aria-pressed", String(key === state.game));
    b.innerHTML = `<span class="dot" aria-hidden="true"></span>${g.name}`;
    b.addEventListener("click", () => { if (!state.animating) selectGame(key); });
    els.chips.appendChild(b);
  }
}

function selectGame(key) {
  state.game = key;
  savePrefs();
  for (const c of els.chips.children) {
    c.setAttribute("aria-pressed", String(c.textContent.trim() === GAMES[key].name));
  }
  applyGameToUI();
}

function applyGameToUI() {
  const spec = currentSpec();
  document.documentElement.style.setProperty("--accent", spec.color);
  els.customCtls.hidden = state.game !== "custom";
  els.pbWrap.hidden = !(spec.extra && spec.extra.pool > 1);
  chamber.setPool(spec.pool, spec.color);
  if (!els.pbWrap.hidden) pbChamber.setPool(spec.extra.pool, spec.color);
  els.matrixLine.textContent =
    `${spec.picks} numbers from 1–${spec.pool}` +
    (spec.extra ? ` + 1 ${spec.extra.label} from 1–${spec.extra.pool}` : "");
  syncCustomUI();
}

/* ----------------------------------------------------------- controls */
function syncQty() {
  els.qtyVal.textContent = String(state.qty);
  els.qtySlider.value = String(state.qty);
}
els.qtySlider.addEventListener("input", () => {
  state.qty = clamp(parseInt(els.qtySlider.value, 10) || 1, 1, 50);
  syncQty(); savePrefs();
});

function syncCustomUI() {
  const c = state.custom;
  c.picks = clamp(c.picks, 1, Math.min(20, c.pool - 1)); // always enforced < N
  els.cPoolVal.textContent = String(c.pool);
  els.cPicksVal.textContent = String(c.picks);
  els.cExtraOn.checked = c.extraOn;
  els.cExtraRow.hidden = !c.extraOn;
  els.cExtraPoolVal.textContent = String(c.extraPool);
}

function stepCustom(which, dir) {
  const c = state.custom;
  if (which === "qty") state.qty = clamp(state.qty + dir, 1, 50);
  else if (which === "cpool") {
    c.pool = clamp(c.pool + dir, 2, 99);
    c.picks = clamp(c.picks, 1, Math.min(20, c.pool - 1));
  } else if (which === "cpicks") c.picks = clamp(c.picks + dir, 1, Math.min(20, c.pool - 1));
  else if (which === "cextrapool") c.extraPool = clamp(c.extraPool + dir, 2, 99);
  syncQty();
  savePrefs();
  if (state.game === "custom") applyGameToUI(); else syncCustomUI();
}

// steppers (with press-and-hold repeat)
for (const stepper of document.querySelectorAll(".stepper")) {
  const which = stepper.dataset.step;
  for (const btn of stepper.querySelectorAll(".step-btn")) {
    const dir = parseInt(btn.dataset.dir, 10);
    let holdT = 0, repT = 0;
    const fire = () => stepCustom(which, dir);
    btn.addEventListener("click", fire);
    btn.addEventListener("pointerdown", () => {
      holdT = setTimeout(() => { repT = setInterval(fire, 90); }, 450);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
      btn.addEventListener(ev, () => { clearTimeout(holdT); clearInterval(repT); });
    }
  }
}

els.cExtraOn.addEventListener("change", () => {
  state.custom.extraOn = els.cExtraOn.checked;
  savePrefs();
  applyGameToUI();
});

/* -------------------------------------------------------------- draw */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let skipRequested = false;

for (const cv of [els.chamber, els.pbChamber]) {
  cv.addEventListener("pointerdown", () => { if (state.animating) skipRequested = true; });
}

els.drawBtn.addEventListener("click", onDraw);

async function onDraw() {
  if (state.animating) return;
  const spec = currentSpec();

  // 1) Selection — CSPRNG first, always.
  const lines = [];
  for (let i = 0; i < state.qty; i++) {
    lines.push({
      nums: drawLine(spec.pool, spec.picks),
      extra: spec.extra ? drawLine(spec.extra.pool, spec.extra.picks)[0] : null
    });
  }

  pushHistory(spec, lines);
  renderHistory();

  const instant = reduceMotion.matches;
  renderResults(spec, lines, !instant);
  if (instant) { chamber.renderOnce(); pbChamber.renderOnce(); return; }

  // 2) Presentation — animate line 1 only.
  state.animating = true;
  skipRequested = false;
  els.drawBtn.disabled = true;
  els.skipHint.hidden = false;
  startLoop();

  try {
    await animateLine(chamber, lines[0].nums, (n) => fillNextSlot("main", n));
    if (spec.extra && lines[0].extra != null && !skipRequested) {
      await animateLine(pbChamber, [lines[0].extra], (n) => fillNextSlot("extra", n));
    }
    if (skipRequested) fillAllRemaining(lines[0]);
  } finally {
    chamber.flushExtractions();
    pbChamber.flushExtractions();
    finalizeLineOne(spec, lines[0]);
    state.animating = false;
    els.drawBtn.disabled = false;
    els.skipHint.hidden = true;
    // refresh chambers for the next draw
    chamber.setPool(spec.pool, spec.color);
    if (spec.extra) pbChamber.setPool(spec.extra.pool, spec.color);
  }
}

async function animateLine(ch, nums, onRelease) {
  ch.mixUntil = performance.now() + 1500; // vigorous mixing
  let waited = 0;
  while (waited < 1500 && !skipRequested) { await sleep(50); waited += 50; }
  if (skipRequested) return;

  for (const n of shuffled(nums)) {           // release order is cosmetic
    if (skipRequested) return;
    const t0 = performance.now();
    await ch.extract(n);                       // physics travel to gate
    onRelease(n);
    navigator.vibrate?.(30);
    const remaining = 400 - (performance.now() - t0); // ~400ms cadence
    if (remaining > 0) await sleep(remaining);
  }
}

/* ------------------------------------------------------------ results */
let lastDraw = null; // { spec, lines }

function pillHTML(n, extra = false, placeholder = false) {
  return `<span class="pill${extra ? " extra" : ""}${placeholder ? " placeholder" : ""}">${placeholder ? "" : n}</span>`;
}

function lineText(spec, line) {
  let s = line.nums.join(" ");
  if (line.extra != null) s += ` | ${spec.extra.label} ${line.extra}`;
  return s;
}

function renderResults(spec, lines, animateFirst) {
  lastDraw = { spec, lines };
  els.resultsCard.hidden = false;
  els.resultsList.innerHTML = "";
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "line";
    row.dataset.idx = String(i);
    const ph = animateFirst && i === 0;
    let pills = line.nums.map((n) => pillHTML(n, false, ph)).join("");
    if (line.extra != null) {
      pills += `<span class="extra-sep">${spec.extra.label}</span>` + pillHTML(line.extra, true, ph);
    }
    row.innerHTML =
      `<span class="line-no">${i + 1}</span>` +
      `<span class="pills">${pills}</span>` +
      `<button type="button" class="copy-btn" aria-label="Copy line ${i + 1}">⧉</button>`;
    row.querySelector(".copy-btn").addEventListener("click", (e) =>
      copyText(lineText(spec, line), e.currentTarget)
    );
    els.resultsList.appendChild(row);
  });
  if (!animateFirst) return;
  els.resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function fillNextSlot(kind, n) {
  const row = els.resultsList.querySelector('.line[data-idx="0"]');
  if (!row) return;
  const sel = kind === "extra" ? ".pill.extra.placeholder" : ".pill.placeholder:not(.extra)";
  const slot = row.querySelector(sel);
  if (!slot) return;
  slot.classList.remove("placeholder");
  slot.classList.add("pop");
  slot.textContent = String(n);
}

function fillAllRemaining(line) {
  for (const n of line.nums) fillNextSlot("main", n);
  if (line.extra != null) fillNextSlot("extra", line.extra);
}

function finalizeLineOne(spec, line) {
  // Rebuild line 1 sorted (balls were released in random order).
  const row = els.resultsList.querySelector('.line[data-idx="0"]');
  if (!row) return;
  let pills = line.nums.map((n) => pillHTML(n)).join("");
  if (line.extra != null) {
    pills += `<span class="extra-sep">${spec.extra.label}</span>` + pillHTML(line.extra, true);
  }
  row.querySelector(".pills").innerHTML = pills;
}

els.copyAllBtn.addEventListener("click", (e) => {
  if (!lastDraw) return;
  const txt = lastDraw.lines.map((l) => lineText(lastDraw.spec, l)).join("\n");
  copyText(txt, e.currentTarget);
});

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (btn && ok) {
    const orig = btn.textContent;
    btn.classList.add("copied");
    btn.textContent = "✓";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = orig; }, 1100);
  }
}

/* ------------------------------------------------------------ history */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); }
  catch { return []; }
}

function pushHistory(spec, lines) {
  const hist = loadHistory();
  hist.unshift({
    game: state.game,
    name: spec.name,
    ts: Date.now(),
    extraLabel: spec.extra ? spec.extra.label : null,
    lines: lines.map((l) => ({ n: l.nums, e: l.extra }))
  });
  try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, HIST_MAX))); }
  catch { /* non-fatal */ }
}

function renderHistory() {
  const hist = loadHistory();
  els.historyCount.textContent = String(hist.length);
  els.historyList.innerHTML = "";
  const fmt = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });
  for (const h of hist) {
    const div = document.createElement("div");
    div.className = "h-item";
    const nums = h.lines
      .map((l) => l.n.join(" ") + (l.e != null ? ` | ${h.extraLabel || "Extra"} ${l.e}` : ""))
      .join("\n");
    div.innerHTML =
      `<div class="h-meta"><span class="g"></span><span></span></div>` +
      `<div class="h-nums"></div>`;
    div.querySelector(".g").textContent = `${h.name} · ${h.lines.length} line${h.lines.length > 1 ? "s" : ""}`;
    div.querySelector(".h-meta span:last-child").textContent = fmt.format(new Date(h.ts));
    div.querySelector(".h-nums").textContent = nums;
    els.historyList.appendChild(div);
  }
}

els.clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("Clear all draw history?")) return;
  try { localStorage.removeItem(HIST_KEY); } catch { /* ignore */ }
  renderHistory();
});

/* ---------------------------------------------------------------- PWA */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

/* ---------------------------------------------------------------- init */
buildChips();
syncQty();
applyGameToUI();
renderHistory();
startLoop();
if (reduceMotion.matches) { chamber.renderOnce(); pbChamber.renderOnce(); }
