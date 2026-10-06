/**
 * Write the Mint brand files from lib/marks.js, the one source of the leaf.
 *
 *     node dashboard/tools/make-brand.cjs
 *
 * public/brand/mint-os-mark.svg      the flat dual-tone OS leaf
 * public/brand/mint-ai-mark.svg      the gradient AI leaf with its spark
 *
 * The favicons and app icons are no longer the leaf: since 2026-10-06 every
 * page wears the Mint OS "Mesh" icon, written by tools/make-app-icon.cjs.
 * tools/test-brand.cjs checks the files are current.
 */
"use strict";
const fs = require("fs");
const path = require("path");
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
  return out;
}

module.exports = { files };

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = files();
  for (const [name, body] of Object.entries(f)) fs.writeFileSync(path.join(PUB, name), body);
  console.log("wrote", Object.keys(f).length, "SVGs");
}
