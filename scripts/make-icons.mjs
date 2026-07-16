/* Generates icons/ from an SVG lotto-ball design.
 * Tries `sharp` first, falls back to `@napi-rs/canvas`.
 *   node scripts/make-icons.mjs
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(OUT, { recursive: true });

const NAVY = "#0e1c4e";
const RED = "#e4002b";

// geometry per variant (512-unit canvas). Maskable keeps content in the safe zone.
const VARIANTS = {
  any:      { ball: 196, ring: 118, font: 168 },
  maskable: { ball: 150, ring: 92,  font: 128 }
};

const TARGETS = [
  { file: "icon-192.png",             size: 192, variant: "any" },
  { file: "icon-512.png",             size: 512, variant: "any" },
  { file: "icon-512-maskable.png",    size: 512, variant: "maskable" },
  { file: "apple-touch-icon-180.png", size: 180, variant: "any" }
];

function svg({ ball, ring, font }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="18%" r="95%">
      <stop offset="0%" stop-color="#1c317f"/>
      <stop offset="60%" stop-color="${NAVY}"/>
      <stop offset="100%" stop-color="#091337"/>
    </radialGradient>
    <radialGradient id="ballg" cx="36%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#e9edfb"/>
      <stop offset="100%" stop-color="#c3cdec"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="${ball}" fill="url(#ballg)"/>
  <circle cx="256" cy="256" r="${ball}" fill="none" stroke="rgba(9,19,55,.35)" stroke-width="4"/>
  <circle cx="256" cy="256" r="${ring}" fill="#ffffff" stroke="${RED}" stroke-width="${Math.round(ring * 0.09)}"/>
  <text x="256" y="256" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold"
        font-size="${font}" fill="${RED}" text-anchor="middle" dominant-baseline="central">7</text>
  <ellipse cx="196" cy="176" rx="${Math.round(ball * 0.34)}" ry="${Math.round(ball * 0.2)}"
           fill="#ffffff" opacity="0.35" transform="rotate(-24 196 176)"/>
</svg>`;
}

async function withSharp() {
  const sharp = (await import("sharp")).default;
  for (const t of TARGETS) {
    await sharp(Buffer.from(svg(VARIANTS[t.variant]), "utf8"), { density: 300 })
      .resize(t.size, t.size)
      .png()
      .toFile(join(OUT, t.file));
    console.log(`sharp  → icons/${t.file} (${t.size}x${t.size})`);
  }
}

async function withCanvas() {
  const { createCanvas } = await import("@napi-rs/canvas");
  for (const t of TARGETS) {
    const s = t.size, k = s / 512;
    const g = VARIANTS[t.variant];
    const cv = createCanvas(s, s);
    const ctx = cv.getContext("2d");
    const bg = ctx.createRadialGradient(s / 2, s * 0.18, 0, s / 2, s * 0.18, s * 0.95);
    bg.addColorStop(0, "#1c317f"); bg.addColorStop(0.6, NAVY); bg.addColorStop(1, "#091337");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, s, s);
    const cx = s / 2, cy = s / 2, ballR = g.ball * k, ringR = g.ring * k;
    const bl = ctx.createRadialGradient(cx - ballR * 0.3, cy - ballR * 0.4, ballR * 0.1, cx, cy, ballR);
    bl.addColorStop(0, "#ffffff"); bl.addColorStop(0.7, "#e9edfb"); bl.addColorStop(1, "#c3cdec");
    ctx.beginPath(); ctx.arc(cx, cy, ballR, 0, Math.PI * 2); ctx.fillStyle = bl; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; ctx.fill();
    ctx.lineWidth = ringR * 0.09; ctx.strokeStyle = RED; ctx.stroke();
    ctx.fillStyle = RED;
    ctx.font = `bold ${Math.round(g.font * k)}px "DejaVu Sans", Arial, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("7", cx, cy + g.font * k * 0.04);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(OUT, t.file), cv.toBuffer("image/png"))
    );
    console.log(`canvas → icons/${t.file} (${t.size}x${t.size})`);
  }
}

try {
  await withSharp();
} catch (e) {
  console.log(`sharp unavailable (${e.message.split("\n")[0]}) — falling back to @napi-rs/canvas`);
  await withCanvas();
}
console.log("Icons done.");
