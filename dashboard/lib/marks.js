"use strict";
/* Mint brand marks, one source of truth for the SVG files and the mockup.
   Leaf geometry, in a 100-wide box (apex y=4, base y=116), traced off the
   reference "Concept 1: The Bio-Digital Leaf":
   - outline: pointed apex, convex shoulders, widest at ~y68, round base;
   - central vein: a vertical divide at x=50; the colour split runs apex→base,
     the cut starts at y=31;
   - a small chevron (upper side veins) meeting the midline at y=58;
   - two long side veins that cut the leaf into lobes, meeting at y=93. */

const LEAF = "M50 4C58.5 11 96 33 96 68C96 96 76 116 50 116C24 116 4 96 4 68C4 33 41.5 11 50 4Z";
const V_MID = "M50 32.5V121";
const V_CHEV = "M35.6 45.4L50 57.4L64.4 45.4";
const V_SIDE = "M-3 43.5L42.5 84.5Q50 91 50 99M103 43.5L57.5 84.5Q50 91 50 99";
const VW = 5.2; // vein cut width

/* Four-point spark with concave sides, centred on (cx,cy). */
function spark(cx, cy, up, down, side) {
  const k = 0.3; // how deep the concave sides pinch toward the centre
  const a = (x, y) => `${(cx + x).toFixed(2)} ${(cy + y).toFixed(2)}`;
  return (
    `M${a(0, -up)}` +
    `C${a(side * 0.07, -up * k)} ${a(side * k, -3.2)} ${a(side, 0)}` +
    `C${a(side * k, 3.2)} ${a(side * 0.07, down * k)} ${a(0, down)}` +
    `C${a(-side * 0.07, down * k)} ${a(-side * k, 3.2)} ${a(-side, 0)}` +
    `C${a(-side * k, -3.2)} ${a(-side * 0.07, -up * k)} ${a(0, -up)}Z`
  );
}
const SPARK = spark(50, -4.5, 24, 14, 24);

/* ---------- OS mark: flat dual-tone leaf, veins as cuts ---------- */
function osMark(o = {}) {
  const id = o.id || "mos";
  const a = o.a || "var(--leaf-a, #6DEBA8)";
  const b = o.b || "var(--leaf-b, #248273)";
  const title = o.title === false ? "" : `<title>MINT OS</title>`;
  return `<svg class="${o.cls || "mark mark-os"}" viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MINT OS">${title}
<defs><mask id="${id}-m" maskUnits="userSpaceOnUse" x="-5" y="0" width="110" height="122"><rect x="-5" y="0" width="110" height="122" fill="#fff"/>
<g fill="none" stroke="#000" stroke-width="${VW}"><path d="${V_MID}"/><path d="${V_CHEV}" stroke-linejoin="round"/><path d="${V_SIDE}" stroke-linejoin="round"/></g></mask>
<clipPath id="${id}-c"><path d="${LEAF}"/></clipPath></defs>
<g mask="url(#${id}-m)" clip-path="url(#${id}-c)"><rect x="0" y="0" width="50" height="120" fill="${a}"/><rect x="50" y="0" width="50" height="120" fill="${b}"/></g></svg>`;
}

/* ---------- AI mark: gradient leaf, glowing neural vein, spark ---------- */
function aiMark(o = {}) {
  const id = o.id || "mai";
  const glow = o.glow !== false;
  const title = o.title === false ? "" : `<title>MINT AI</title>`;
  return `<svg class="${o.cls || "mark mark-ai"}" viewBox="-6 -36 112 176" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MINT AI">${title}
<defs>
<linearGradient id="${id}-g" x1="12" y1="104" x2="90" y2="26" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00E6A5"/><stop offset=".42" stop-color="#3FD2B8"/><stop offset=".7" stop-color="#7A62E6"/><stop offset="1" stop-color="#8A2BE2"/></linearGradient>
<radialGradient id="${id}-h" cx="50" cy="14" r="46" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#E9FFF6" stop-opacity=".32"/><stop offset="1" stop-color="#E9FFF6" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-v" x1="0" y1="120" x2="0" y2="-4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#59E3B1"/><stop offset=".12" stop-color="#3FA98E"/><stop offset=".45" stop-color="#34718A"/><stop offset=".8" stop-color="#5E9FB0"/><stop offset="1" stop-color="#E9FFF6"/></linearGradient>
<radialGradient id="${id}-s" cx="50" cy="-4" r="24" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".35" stop-color="#C9FFEC"/><stop offset="1" stop-color="#5FE8BF"/></radialGradient>
<filter id="${id}-f" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${o.glowSd || 5}"/></filter>
<filter id="${id}-f2" filterUnits="userSpaceOnUse" x="-10" y="-40" width="120" height="180"><feGaussianBlur stdDeviation="1.5"/></filter>
<clipPath id="${id}-c"><path d="${LEAF}"/></clipPath>
<mask id="${id}-m" maskUnits="userSpaceOnUse" x="-5" y="-40" width="110" height="180"><rect x="-5" y="-40" width="110" height="180" fill="#fff"/>
<g fill="none" stroke="#000" stroke-width="${VW}"><path d="${V_MID}"/><path d="${V_CHEV}" stroke-linejoin="round"/><path d="${V_SIDE}" stroke-linejoin="round"/></g></mask>
</defs>
${glow ? `<g class="ai-halo" opacity="${o.halo || 0.75}" filter="url(#${id}-f)"><path d="${LEAF}" fill="url(#${id}-g)"/></g>` : ""}
<g mask="url(#${id}-m)"><path d="${LEAF}" fill="url(#${id}-g)"/><path d="${LEAF}" fill="url(#${id}-h)"/></g>
<g class="ai-vein" fill="none" stroke-linejoin="round"><g clip-path="url(#${id}-c)">${glow ? `<g filter="url(#${id}-f2)" stroke="#F2FFF9" stroke-width="${VW + 3.2}" opacity="1"><path d="${V_MID}"/><path d="${V_CHEV}" stroke-linecap="round"/><path d="${V_SIDE}"/></g>` : ""}<g stroke="#1B3552" stroke-width="${VW - 1}" opacity=".92"><path d="${V_CHEV}" stroke-linecap="round"/><path d="${V_SIDE}"/></g></g><path d="M50 -2V120" stroke="url(#${id}-v)" stroke-width="${VW - 1}"/><path d="M50 119V133" stroke="#59E3B1" stroke-width="${VW - 1}" stroke-linecap="round"/></g>
${o.noSpark ? "" : `<g class="ai-spark">${glow ? `<path d="${SPARK}" fill="#9FFBDD" opacity=".8" filter="url(#${id}-f2)"/>` : ""}<path d="${SPARK}" fill="url(#${id}-s)"/></g>`}
</svg>`;
}

/* ---------- Favicons: hand-fitted to the pixel grid ---------- */
function favOS(px) {
  // 16: leaf fills the square; one divide, two side cuts, 1px wide.
  const s = px / 16;
  const leaf = "M8 .6C9.6 1.9 15.2 5 15.2 10.2C15.2 13.4 12.2 15.6 8 15.6C3.8 15.6 .8 13.4 .8 10.2C.8 5 6.4 1.9 8 .6Z";
  const cuts16 = `<path d="M8 5.2V16.5" stroke-width="1.15"/><path d="M-.5 7.6L8 13.9L16.5 7.6" stroke-width="1.15" stroke-linejoin="round"/>`;
  const cuts32 = `<path d="M8 4.4V16.5" stroke-width=".78" stroke-linecap="round"/><path d="M5.6 7.1L8 8.9L10.4 7.1" stroke-width=".72" stroke-linecap="round" stroke-linejoin="round"/><path d="M-.5 7.4L8 14.1L16.5 7.4" stroke-width=".78" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 16 16"><defs><mask id="fo${px}" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="#fff"/><g fill="none" stroke="#000">${px >= 32 ? cuts32 : cuts16}</g></mask><clipPath id="fc${px}"><path d="${leaf}"/></clipPath></defs><g mask="url(#fo${px})" clip-path="url(#fc${px})"><rect width="8" height="16" fill="#6DEBA8"/><rect x="8" width="8" height="16" fill="#1F8A73"/></g></svg>`;
}
function favAI(px) {
  // High contrast: saturated gradient leaf, white spark on the apex, white vein.
  const leaf = "M8 4.4C9.3 5.4 14.6 7.6 14.6 11.3C14.6 14 12 15.8 8 15.8C4 15.8 1.4 14 1.4 11.3C1.4 7.6 6.7 5.4 8 4.4Z";
  const sp = px >= 32
    ? "M8 .2C8.15 1.9 8.4 2.9 11.2 3.2C8.4 3.5 8.15 4.4 8 6C7.85 4.4 7.6 3.5 4.8 3.2C7.6 2.9 7.85 1.9 8 .2Z"
    : "M8 0C8.2 1.9 8.5 2.8 11.4 3.2C8.5 3.6 8.2 4.4 8 6.2C7.8 4.4 7.5 3.6 4.6 3.2C7.5 2.8 7.8 1.9 8 0Z";
  const cuts = px >= 32
    ? `<path d="M-.5 9.3L8 14.8L16.5 9.3" stroke-width=".8" stroke-linejoin="round"/>`
    : `<path d="M-.5 9.6L8 15L16.5 9.6" stroke-width="1.1" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 16 16"><defs><linearGradient id="fg${px}" x1="2" y1="15" x2="14" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00E6A5"/><stop offset=".5" stop-color="#34C6C0"/><stop offset="1" stop-color="#8A2BE2"/></linearGradient><mask id="fa${px}" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="#fff"/><g fill="none" stroke="#000">${cuts}</g></mask></defs><path d="${leaf}" fill="url(#fg${px})" mask="url(#fa${px})"/><path d="M8 5V16" stroke="#F2FFF9" stroke-width="${px >= 32 ? 0.8 : 1.1}"/><path d="${sp}" fill="#FFFFFF"/></svg>`;
}

module.exports = { LEAF, V_MID, V_CHEV, V_SIDE, VW, SPARK, spark, osMark, aiMark, favOS, favAI };
