/**
 * The Mint brand: marks, favicons, fonts, tokens and the chrome that wears them.
 *
 *     NODE_PATH=/opt/moni-dashboard/node_modules node dashboard/tools/test-brand.cjs
 *
 * Static checks, then the real server.js on a scratch port (scratch data dir,
 * no supervisor) to check the files are served with the right content types
 * and that pages reference them:
 *
 *  - the SVG marks and favicons are current with lib/marks.js (tools/make-brand.cjs);
 *  - the three OFL fonts are self-hosted with their licences, latin woff2 only;
 *  - style.css declares them and holds the approved palette in both themes;
 *  - every page (MINT AI's too) carries the one Mint OS "Mesh" icon set and the
 *    web app manifest (tools/make-app-icon.cjs); every top bar
 *    (MINT AI's too) carries the same lockup: the OS leaf and MINT, no [OS]/[AI] tag;
 *  - the sign-in page carries the full lockup and the faint leaf;
 *  - the nursery's seedlings are built from the leaf; no style="" anywhere.
 *
 * .cjs because it uses require.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mint-brand-"));
fs.mkdirSync(path.join(DATA, "log"));
process.env.MONI_DATA_DIR = DATA;
process.env.MONI_LOG_DIR = path.join(DATA, "log");
const PORT = 3800 + Math.floor(Math.random() * 90);

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

/* ------------------------------------------------------------- files --- */

const make = require("./make-brand.cjs");
for (const [name, body] of Object.entries(make.files())) {
  const f = path.join(PUB, name);
  check(`${name} is current with lib/marks.js`, fs.existsSync(f) && fs.readFileSync(f, "utf8") === body);
}
// The Mint OS icon ("Mesh"), the same on every page: tools/make-app-icon.cjs.
const appIcon = require("./make-app-icon.cjs");
for (const [name, body] of Object.entries(appIcon.files())) {
  const f = path.join(PUB, name);
  check(`${name} is current with tools/make-app-icon.cjs`, fs.existsSync(f) && fs.readFileSync(f, "utf8") === body);
}
check("the light favicon.svg stays small (every page fetches it)", fs.statSync(path.join(PUB, "favicon.svg")).size < 48 * 1024, fs.statSync(path.join(PUB, "favicon.svg")).size);
check("the icon SVGs embed no raster, font or outside reference", Object.values(appIcon.files()).every((b) => !/<image|<text|@import|url\((?!#)|href="(?!#)/.test(b.replace(/xmlns="[^"]*"/, ""))));
for (const r of appIcon.RASTERS) {
  const b = fs.existsSync(path.join(PUB, r.file)) ? fs.readFileSync(path.join(PUB, r.file)) : null;
  const sz = b && appIcon.pngSize(b);
  check(`${r.file} is a ${r.size}x${r.size} PNG`, !!sz && sz.w === r.size && sz.h === r.size, JSON.stringify(sz));
}
{
  const entries = appIcon.readIco(fs.readFileSync(path.join(PUB, "favicon.ico")));
  check("favicon.ico holds 16/32/48 PNGs", !!entries && entries.map((e) => `${e.size}:${e.png && e.png.w}x${e.png && e.png.h}`).join(",") === "16:16x16,32:32x32,48:48x48", JSON.stringify(entries));
}
for (const gone of ["favicon-ai.svg", "favicon-ai.ico", "brand/favicon-os-16.svg", "brand/favicon-os-32.svg", "brand/favicon-ai-16.svg", "brand/favicon-ai-32.svg"]) {
  check(`the old leaf favicon ${gone} is gone`, !fs.existsSync(path.join(PUB, gone)));
}
const osMark = fs.readFileSync(path.join(PUB, "brand/mint-os-mark.svg"), "utf8");
check("the OS mark is the two leaf tones, #6DEBA8 / #248273", osMark.includes('fill="#6DEBA8"') && osMark.includes('fill="#248273"'));
const aiMark = fs.readFileSync(path.join(PUB, "brand/mint-ai-mark.svg"), "utf8");
check("the AI mark runs mint to violet and carries the spark", aiMark.includes("#00E6A5") && aiMark.includes("#8A2BE2") && aiMark.includes('class="ai-spark"'));

const FONTS = [
  ...[400, 500, 600, 700].map((w) => `space-grotesk-latin-${w}-normal.woff2`),
  ...[400, 500, 600, 700].map((w) => `inter-latin-${w}-normal.woff2`),
  ...[400, 500, 600].map((w) => `jetbrains-mono-latin-${w}-normal.woff2`),
];
const fontDir = fs.readdirSync(path.join(PUB, "fonts"));
check("the eleven latin woff2 faces are self-hosted", FONTS.every((f) => fontDir.includes(f)), FONTS.filter((f) => !fontDir.includes(f)).join(" "));
check("nothing but latin woff2 and the licences in public/fonts", fontDir.every((f) => /^[a-z-]+-latin-\d{3}-normal\.woff2$/.test(f) || /^OFL-.*\.txt$/.test(f)), fontDir.join(" "));
for (const lic of ["OFL-SpaceGrotesk.txt", "OFL-Inter.txt", "OFL-JetBrainsMono.txt"]) {
  const t = fs.existsSync(path.join(PUB, "fonts", lic)) ? fs.readFileSync(path.join(PUB, "fonts", lic), "utf8") : "";
  check(`${lic} is the SIL Open Font License`, /SIL Open Font License, Version 1\.1/.test(t));
}
check("each face is a real woff2 (wOF2 magic)", FONTS.every((f) => fs.readFileSync(path.join(PUB, "fonts", f)).slice(0, 4).toString() === "wOF2"));

const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8");
check("style.css declares all eleven faces, from public/fonts", FONTS.every((f) => css.includes(`url("fonts/${f}?v=`)));
check("the three families are the brand, body and mono stacks", /--brand-font: "Space Grotesk"/.test(css) && /--ui: "Inter"/.test(css) && /--mono: "JetBrains Mono"/.test(css));
check("no font is fetched from anywhere but the panel", !/url\(["']?https?:/.test(css) && !/@import/.test(css));
const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1];
check("the brand constants are Obsidian, Mint, Deep Teal, AI Violet and off-white", /--obsidian: #0D1117/.test(light) && /--mint: #00E6A5/.test(light) && /--deep-teal: #0A3A35/.test(light) && /--ai-violet: #8A2BE2/.test(light) && /--offwhite: #F8FAFC/.test(light));
check("light: the ground is #F8FAFC and mint text is the darker #00785A", /--bg: #F8FAFC/.test(light) && /--accent: #00785A/.test(light));
check("dark: the ground is Obsidian and mint is #00E6A5", /--bg: #0D1117/.test(dark) && /--accent: #00E6A5/.test(dark));
check("the leaf tones are the ones sampled from the reference (dark)", /--leaf-a: #6DEBA8/.test(dark) && /--leaf-b: #248273/.test(dark));
check("the light glow is softened (alpha .18, dark .30)", /--glow: rgba\(0, 230, 165, \.18\)/.test(light) && /--glow: rgba\(0, 230, 165, \.30\)/.test(dark));
{
  // Mint #00E6A5 is never a text colour on the light ground.
  const textRules = [...light.matchAll(/--(accent|brand-deep|good-ink|wordmark|ink|body|muted): (#[0-9A-Fa-f]{6})/g)];
  check("no light-theme text token is the bright mint", textRules.every((m) => m[2].toUpperCase() !== "#00E6A5"), textRules.map((m) => m[1] + m[2]).join(" "));
}
{
  // WCAG contrast of the light text tokens on white and on the ground.
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tok = (block, n) => (new RegExp("--" + n + ": (#[0-9A-Fa-f]{6})").exec(block) || [])[1];
  for (const n of ["ink", "body", "muted", "dim", "accent"]) {
    check(`light --${n} reads at >= 4.5:1 on #F8FAFC`, ratio(tok(light, n), "#F8FAFC") >= 4.5, ratio(tok(light, n), "#F8FAFC").toFixed(2));
    check(`dark --${n} reads at >= 4.5:1 on #0D1117`, ratio(tok(dark, n), "#0D1117") >= 4.5, ratio(tok(dark, n), "#0D1117").toFixed(2));
  }
  check("dark text on a mint fill (buttons, pills) reads at >= 4.5:1", ratio("#0D1117", "#00E6A5") >= 4.5);
}

/* ---------------------------------------------------------- rendering --- */

const ui = require(path.join(ROOT, "lib", "ui.js"));
const brand = require(path.join(ROOT, "lib", "brand.js"));
const views = require(path.join(ROOT, "lib", "views.js"));
const osPage = ui.shell("Services", "<p>x</p>", { user: { name: "desk" }, active: "services", csrf: "c" });
const TOP_LOCKUP = /<a class="brand" href="[^"]*" aria-label="Mint OS">\s*<span class="lockup os brand-text" aria-label="MINT"><span class="lk-mk" aria-hidden="true"><svg class="mark mark-os"[\s\S]*?<\/svg><\/span><span class="lk-wm"><span class="lk-row"><span class="lk-mint">MINT<\/span><\/span><\/span><\/span>\s*<\/a>/;
check("an OS page's top bar is the OS leaf + MINT, no [OS] tag", TOP_LOCKUP.test(osPage) && !/pill-brand/.test(osPage));
const ICON_LINKS = (pg) =>
  /<link rel="icon" href="\/static\/brand\/favicon-16\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="16x16">/.test(pg) &&
  /<link rel="icon" href="\/static\/brand\/favicon-32\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="32x32">/.test(pg) &&
  /<link rel="icon" href="\/static\/favicon\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="any">/.test(pg) &&
  /<link rel="alternate icon" href="\/static\/favicon\.ico\?v=[^"]+"/.test(pg) &&
  /<link rel="apple-touch-icon" href="\/static\/brand\/app-icon-180\.png\?v=[^"]+" sizes="180x180">/.test(pg) &&
  /<link rel="manifest" href="\/manifest\.webmanifest\?v=[0-9a-f]{10}">/.test(pg) &&
  !/favicon-(os|ai)/.test(pg);
check("an OS page carries the Mint OS icon (16 lines, 32 dots, any, .ico, apple-touch, manifest)", ICON_LINKS(osPage));
check("an OS page's title ends Mint OS", /<title>Services — Mint OS<\/title>/.test(osPage));
// MINT AI's own page is the Command Center (brand "ai"); the classic chat is gone.
const aiPage = ui.shell("MINT AI", "<p>x</p>", { user: { name: "desk" }, active: "moni-ai", bare: true, brand: "ai", csrf: "c" });
check("MINT AI's pages carry the same top-bar lockup (OS leaf + MINT, no [AI] tag)", TOP_LOCKUP.test(aiPage) && !/pill-brand/.test(aiPage) && !/lockup ai/.test(aiPage));
check("MINT AI's pages carry the same Mint OS icon (no AI favicon any more)", ICON_LINKS(aiPage) && ui.iconLinks() === ui.iconLinks());
{
  const m = ui.manifest();
  check("the manifest names Mint OS, starts at / and carries 192, 512 and a maskable 512", m.name === "Mint OS" && m.start_url === "/" && m.display === "standalone" &&
    m.icons.some((i) => i.sizes === "192x192" && /app-icon-192\.png\?v=/.test(i.src)) && m.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") &&
    m.icons.some((i) => i.purpose === "maskable" && /app-icon-maskable-512\.png\?v=/.test(i.src)) && /^#[0-9A-F]{6}$/i.test(m.theme_color) && /^#[0-9A-F]{6}$/i.test(m.background_color));
}
check("the sidebar's Command Center item carries the spark (the top-bar tabs are gone)", /<a href="\/mint-ai" class="side-item[^"]*"[^>]*><svg class="ico spark"/.test(osPage) && !/class="top-tab/.test(osPage));
check("the fonts are preloaded from the panel", /<link rel="preload" href="\/static\/fonts\/inter-latin-400-normal\.woff2\?v=5\.3\.0" as="font" type="font\/woff2" crossorigin>/.test(osPage));
const login = views.login({ csrf: "c" });
check("the sign-in card carries the full MINT [OS] lockup", /<div class="card auth-card"><div class="auth-lockup"><span class="lockup os full"/.test(login) && /Operating System/.test(login));
check("the sign-in page has the large faint leaf behind the card", /<div class="auth-leaf" aria-hidden="true"><svg class="mark"/.test(login));
{
  const a = brand.osMark(), b = brand.osMark();
  const ida = /mask id="([^"]+)"/.exec(a)[1], idb = /mask id="([^"]+)"/.exec(b)[1];
  check("two marks on one page never share gradient/mask ids", ida !== idb);
}
check("a seedling is drawn from the leaf path", brand.seedling(3).includes(require(path.join(ROOT, "lib", "marks.js")).LEAF));
for (const [n, html] of [["OS page", osPage], ["AI page", aiPage], ["sign-in", login], ["seedling", brand.seedling(2, "x", { droop: true, roots: [0] })]]) {
  check(`${n}: no style attributes and no inline script (CSP)`, !/\sstyle=/.test(html) && !/<script>(?!<\/script>)/.test(html) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(html));
}

/* -------------------------------------------------------------- HTTP --- */

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: p, headers: { "X-Forwarded-Proto": "https" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.setTimeout(8000, () => r.destroy(new Error("timeout " + p)));
    r.end();
  });
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, { MONI_PORT: String(PORT), MONI_BIND: "127.0.0.1", MONI_AI_SOCKET: path.join(DATA, "no.sock"), NODE_ENV: "production" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);
    const TYPES = [
      ["/static/fonts/inter-latin-400-normal.woff2", "font/woff2"],
      ["/static/fonts/space-grotesk-latin-700-normal.woff2", "font/woff2"],
      ["/static/fonts/jetbrains-mono-latin-500-normal.woff2", "font/woff2"],
      ["/static/fonts/OFL-Inter.txt", "text/plain"],
      ["/static/brand/mint-os-mark.svg", "image/svg+xml"],
      ["/static/brand/mint-ai-mark.svg", "image/svg+xml"],
      ["/static/brand/favicon-16.svg", "image/svg+xml"],
      ["/static/brand/favicon-32.svg", "image/svg+xml"],
      ["/static/favicon.svg", "image/svg+xml"],
      ["/static/favicon.ico", "image/x-icon"],
      ["/static/brand/app-icon-180.png", "image/png"],
      ["/static/brand/app-icon-192.png", "image/png"],
      ["/static/brand/app-icon-512.png", "image/png"],
      ["/static/brand/app-icon-maskable-512.png", "image/png"],
      ["/favicon.ico", "image/x-icon"],
      ["/manifest.webmanifest", "application/manifest+json"],
    ];
    for (const [p, type] of TYPES) {
      const r = await req(p);
      check(`${p} -> 200 ${type}`, r.status === 200 && String(r.headers["content-type"] || "").startsWith(type), r.status + " " + r.headers["content-type"]);
    }
    {
      const ico = await req("/favicon.ico");
      check("/favicon.ico is the Mesh icon, cached a day", ico.body.equals(fs.readFileSync(path.join(PUB, "favicon.ico"))) && /max-age=86400/.test(ico.headers["cache-control"] || ""), ico.headers["cache-control"]);
      const plain = await req("/manifest.webmanifest");
      const stamped = await req("/manifest.webmanifest?v=" + ui.MANIFEST_VERSION());
      let m = null; try { m = JSON.parse(stamped.body.toString()); } catch (_) {}
      check("the manifest is public JSON, long-cached when stamped and briefly when not", stamped.status === 200 && !!m && m.name === "Mint OS" && /max-age=2592000/.test(stamped.headers["cache-control"] || "") && /max-age=300/.test(plain.headers["cache-control"] || ""), stamped.status + " " + stamped.headers["cache-control"] + " / " + plain.headers["cache-control"]);
      for (const i of (m && m.icons) || []) {
        const r = await req(i.src);
        check(`the manifest icon ${i.src.split("?")[0]} loads (${i.type})`, r.status === 200 && String(r.headers["content-type"] || "").startsWith(i.type), r.status + " " + r.headers["content-type"]);
      }
      // A scratch panel has no users yet, so /login sends to /setup, which without its
      // token is the panel's own 404 page -- an error page, rendered by page() like the rest.
      let first = await req("/login");
      if (first.status >= 300 && first.status < 400) first = await req(new URL(first.headers.location, "http://x").pathname);
      check("a served error page (setup without its token) carries the Mint OS icon links", first.status === 404 && ICON_LINKS(first.body.toString()), first.status);
    }
    const r = await req("/static/fonts/inter-latin-400-normal.woff2?v=5.3.0");
    check("a stamped font is cached long", /max-age=2592000/.test(r.headers["cache-control"] || ""), r.headers["cache-control"]);
    const lg = await req("/login");
    const csp = String(lg.headers["content-security-policy"] || "");
    check("the CSP still allows no font or style host but the panel", /default-src 'self'/.test(csp) && /style-src 'self'/.test(csp) && !/fonts\.googleapis|unsafe-inline/.test(csp), csp);
    check("the served sign-in page references only panel assets", !/(href|src)="https?:/.test(lg.body.toString()));
  } catch (e) {
    check("server run", false, e.message);
  } finally {
    child.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
