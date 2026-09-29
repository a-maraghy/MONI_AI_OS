"use strict";
/**
 * The Mint marks as server-rendered markup: the OS and AI lockups, the leaf
 * used as a faint watermark on the sign-in pages, and the seedlings of the
 * Agents nursery.
 *
 * Every shape comes from lib/marks.js, the one source of the leaf geometry
 * (the same module writes the SVG files and favicons, see tools/make-brand.cjs).
 * Inline SVG is allowed by the CSP -- it is markup, not a style or a script --
 * as long as it carries no style="" attribute, which none of these do.
 *
 * Each call numbers its gradient/mask ids, because two copies of the same
 * mark on one page would otherwise share ids and the second would paint with
 * the first one's defs (or with nothing, once the first is hidden).
 */

const M = require("./marks");

let seq = 0;
const nextId = (p) => p + (++seq).toString(36);

function osMark(o = {}) {
  return M.osMark({ id: nextId("mos"), title: false, cls: o.cls || "mark mark-os" });
}

function aiMark(o = {}) {
  return M.aiMark({ id: nextId("mai"), title: false, cls: o.cls || "mark mark-ai", glow: o.glow, glowSd: o.glowSd });
}

/**
 * MINT [OS] or MINT [AI]: the mark, the bold wordmark and the pill.
 * `sub` adds the "Operating System" / "Artificial Intelligence" line under it
 * (the sign-in pages); the top bar leaves it off.
 */
function lockup(kind, o = {}) {
  const ai = kind === "ai";
  const pill = ai
    ? `<span class="pill-brand pill-ai">[<b>AI</b>]</span>`
    : `<span class="pill-brand pill-os">[<b>OS</b>]</span>`;
  const sub = o.sub ? `<span class="lk-sub">${ai ? "Artificial Intelligence" : "Operating System"}</span>` : "";
  return `<span class="lockup ${ai ? "ai" : "os"}${o.sub ? " full" : ""}${o.cls ? " " + o.cls : ""}" aria-label="MINT ${ai ? "AI" : "OS"}"><span class="lk-mk" aria-hidden="true">${
    ai ? aiMark() : osMark()
  }</span><span class="lk-wm"><span class="lk-row"><span class="lk-mint">MINT</span>${pill}</span>${sub}</span></span>`;
}

/** The big faint leaf behind the sign-in card. Decoration only. */
function watermark(kind) {
  return `<div class="auth-leaf" aria-hidden="true">${kind === "ai" ? aiMark({ cls: "mark", glowSd: 8 }) : osMark({ cls: "mark" })}</div>`;
}

/**
 * A seedling grown from the OS leaf: stage 1 a sprout, 2 a pair, 3 a sapling.
 * Colours come from classes (see .seedling in style.css), so the same markup
 * follows the theme.
 */
function seedling(stage, cls) {
  const id = nextId("sd");
  const L = M.LEAF;
  const leaf = (x, y, s, r) =>
    `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s}) translate(-50 -116)"><path class="sd-a" d="${L}"/><path class="sd-b" d="${L}" clip-path="url(#${id})"/><path class="sd-vein" d="M50 36V116"/></g>`;
  const top = stage === 1 ? 52 : stage === 2 ? 44 : 30;
  let g = `<path class="sd-stem" d="M40 78V${top + 4}"/>`;
  if (stage === 1) g += leaf(40, top + 6, 0.2, -42) + leaf(40, top + 4, 0.22, 40);
  else if (stage === 2) g += leaf(40, top + 8, 0.25, -50) + leaf(40, top + 4, 0.28, 46);
  else g += leaf(40, 58, 0.22, -58) + leaf(40, 50, 0.24, 54) + leaf(40, top + 6, 0.27, -6);
  return `<svg viewBox="0 0 80 82" class="seedling${cls ? " " + cls : ""}" aria-hidden="true"><defs><clipPath id="${id}"><rect x="50" y="0" width="60" height="130"/></clipPath></defs><ellipse class="sd-soil" cx="40" cy="78.5" rx="17" ry="2.6"/>${g}</svg>`;
}

/** A four-point spark, the AI's glyph, for tabs and buttons. */
function spark(size) {
  const id = nextId("sp");
  const s = size || 16;
  return `<svg class="ico spark" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00E6A5"/><stop offset="1" stop-color="#8A2BE2"/></linearGradient></defs><path d="${M.spark(12, 12, 10.5, 10.5, 10.5)}" fill="url(#${id})"/></svg>`;
}

module.exports = { lockup, osMark, aiMark, watermark, seedling, spark };
