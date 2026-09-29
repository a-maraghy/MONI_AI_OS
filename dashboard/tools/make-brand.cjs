/**
 * Write the Mint brand files from lib/marks.js, the one source of the leaf.
 *
 *     node dashboard/tools/make-brand.cjs
 *
 * public/brand/mint-os-mark.svg      the flat dual-tone OS leaf
 * public/brand/mint-ai-mark.svg      the gradient AI leaf with its spark
 * public/brand/favicon-{os,ai}-{16,32}.svg   hand-fitted to the pixel grid
 * public/favicon.svg                 the OS favicon (every page but /mint-ai)
 * public/favicon-ai.svg              the AI favicon (/mint-ai)
 * public/favicon.ico, favicon-ai.ico 16/32/48 PNGs rasterised here
 *
 * The .ico files are rasterised by hand -- a scanline coverage test over the
 * same paths, 8x8 supersampled -- because the panel ships no image library and
 * a leaf does not need one. tools/test-brand.cjs checks the files are current.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { deflateSync } = require("zlib");
const M = require("../lib/marks");

const PUB = path.join(__dirname, "..", "public");
const OUT = path.join(PUB, "brand");

const xml = (s, label) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  s
    .replace(/var\(--leaf-a, (#[0-9A-Fa-f]+)\)/g, "$1")
    .replace(/var\(--leaf-b, (#[0-9A-Fa-f]+)\)/g, "$1")
    .replace(/^<svg /, label ? `<svg role="img" aria-label="${label}" ` : "<svg ") +
  "\n";

function files() {
  const out = {};
  out["brand/mint-os-mark.svg"] = xml(M.osMark({ id: "mos" }));
  out["brand/mint-ai-mark.svg"] = xml(M.aiMark({ id: "mai" }));
  for (const px of [16, 32]) {
    out[`brand/favicon-os-${px}.svg`] = xml(M.favOS(px), "Mint OS");
    out[`brand/favicon-ai-${px}.svg`] = xml(M.favAI(px), "MINT AI");
  }
  // The scalable favicons are the 32px drawings: finer cuts, and a browser
  // asking for 16px gets the 16 file through the sized <link>.
  out["favicon.svg"] = xml(M.favOS(32), "Mint OS");
  out["favicon-ai.svg"] = xml(M.favAI(32), "MINT AI");
  return out;
}

/* ------------------------------------------------------ a tiny rasteriser - */

/** Absolute M/L/H/V/C/Z paths only -- all the favicons use. Returns polylines. */
function flatten(d) {
  const tok = d.match(/[MLHVCZ]|-?(?:\d+\.?\d*|\.\d+)/g);
  const polys = [];
  let cur = null, x = 0, y = 0, i = 0, cmd = "";
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[MLHVCZ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { x = num(); y = num(); cur = [[x, y]]; polys.push(cur); cmd = "L"; }
    else if (cmd === "L") { x = num(); y = num(); cur.push([x, y]); }
    else if (cmd === "H") { x = num(); cur.push([x, y]); }
    else if (cmd === "V") { y = num(); cur.push([x, y]); }
    else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let k = 1; k <= 24; k++) {
        const t = k / 24, a = 1 - t;
        cur.push([a * a * a * x + 3 * a * a * t * x1 + 3 * a * t * t * x2 + t * t * t * x3, a * a * a * y + 3 * a * a * t * y1 + 3 * a * t * t * y2 + t * t * t * y3]);
      }
      x = x3; y = y3;
    } else if (cmd === "Z") { cur.closed = true; }
  }
  return polys;
}

function inside(poly, px, py) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function nearLine(polys, px, py, half) {
  for (const p of polys)
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= half) return true;
    }
  return false;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Pull the shapes out of a favicon SVG string: leaf, cuts (with widths), fills. */
function rasterise(svg, size) {
  const kind = /fg\d+/.test(svg) ? "ai" : "os";
  const paths = [...svg.matchAll(/<path d="([^"]+)"([^>]*)\/>/g)].map((m) => ({ d: m[1], attrs: m[2] }));
  const px = Buffer.alloc(size * size * 4);
  const S = 8, scale = 16 / size;
  let leaf, cuts, vein = null, sparkP = null;
  if (kind === "os") {
    leaf = flatten(paths.find((p) => /^M8 \.6C/.test(p.d)).d)[0];
    cuts = paths.filter((p) => !/^M8 \.6C/.test(p.d)).map((p) => ({ polys: flatten(p.d), half: parseFloat(/stroke-width="([\d.]+)"/.exec(p.attrs)[1]) / 2 }));
  } else {
    leaf = flatten(paths.find((p) => /fill="url/.test(p.attrs)).d)[0];
    cuts = paths.filter((p) => /stroke-width/.test(p.attrs) && !/stroke="#F2FFF9"/.test(p.attrs)).map((p) => ({ polys: flatten(p.d), half: parseFloat(/stroke-width="([\d.]+)"/.exec(p.attrs)[1]) / 2 }));
    const v = paths.find((p) => /stroke="#F2FFF9"/.test(p.attrs));
    vein = { polys: flatten(v.d), half: parseFloat(/stroke-width="([\d.]+)"/.exec(v.attrs)[1]) / 2 };
    sparkP = flatten(paths.find((p) => /fill="#FFFFFF"/.test(p.attrs)).d)[0];
  }
  const A = hex("#6DEBA8"), B = hex("#1F8A73"), G0 = hex("#00E6A5"), G1 = hex("#34C6C0"), G2 = hex("#8A2BE2"), W = [255, 255, 255];
  const grad = (x, y) => {
    // along (2,15) -> (14,6)
    const t = Math.max(0, Math.min(1, ((x - 2) * 12 + (y - 15) * -9) / (12 * 12 + 9 * 9)));
    const [a, b, k] = t < 0.5 ? [G0, G1, t / 0.5] : [G1, G2, (t - 0.5) / 0.5];
    return a.map((c, i) => c + (b[i] - c) * k);
  };
  for (let yy = 0; yy < size; yy++)
    for (let xx = 0; xx < size; xx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const x = (xx + (sx + 0.5) / S) * scale, y = (yy + (sy + 0.5) / S) * scale;
          let c = null;
          if (inside(leaf, x, y) && !cuts.some((q) => nearLine(q.polys, x, y, q.half))) c = kind === "os" ? (x < 8 ? A : B) : grad(x, y);
          if (vein && y >= 5 && nearLine(vein.polys, x, y, vein.half) && inside(leaf, x, y)) c = hex("#F2FFF9");
          if (sparkP && inside(sparkP, x, y)) c = W;
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
      const i = (yy * size + xx) * 4;
      if (n) { px[i] = Math.round(r / n); px[i + 1] = Math.round(g / n); px[i + 2] = Math.round(b / n); px[i + 3] = Math.round((255 * n) / (S * S)); }
    }
  return px;
}

/* --------------------------------------------------------------- PNG/ICO - */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16); e[0] = size; e[1] = size; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12); offset += data.length; return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
function icoFor(kind) {
  // 16px uses the 16 drawing (bolder cuts); 32 and 48 the 32 drawing.
  return ico([16, 32, 48].map((size) => ({ size, data: png(size, rasterise(kind === "ai" ? M.favAI(size >= 32 ? 32 : 16) : M.favOS(size >= 32 ? 32 : 16), size)) })));
}

module.exports = { files, icoFor };

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = files();
  for (const [name, body] of Object.entries(f)) fs.writeFileSync(path.join(PUB, name), body);
  fs.writeFileSync(path.join(PUB, "favicon.ico"), icoFor("os"));
  fs.writeFileSync(path.join(PUB, "favicon-ai.ico"), icoFor("ai"));
  console.log("wrote", Object.keys(f).length, "SVGs and 2 .ico files");
}
