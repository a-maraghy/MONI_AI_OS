#!/usr/bin/env node
"use strict";
/**
 * M-5 part 1: MINT AI's dock on every Mint OS page (lib/ui.js dockMarkup,
 * public/mint-dock.js, public/mint-dock.css). Static checks; the browser run
 * is Playwright on a scratch stack.
 *
 *     node dashboard/tools/test-mint-dock.cjs
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ui = require(path.join(ROOT, "lib", "ui.js"));
const UA = require(path.join(ROOT, "public", "ui-actions.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}
const permOf = (list) => ({ can: (p) => list === "*" || list.includes(p), canDash: () => true });
// voice: the dock's mic -- voice on, a key and voice.use (server.js ctx(): req.voiceMic)
const render = (perms, extra, voiceOk) => ui.shell("Test", "<p>body</p>", Object.assign({ user: { name: "demo-admin", perm: permOf(perms), voice: voiceOk !== false }, csrf: "demo-csrf-token", active: "home" }, extra || {}));

console.log("where the dock appears");
{
  const all = render("*");
  check("on an ordinary page for someone who may use MINT AI", /id="mint-dock-root"/.test(all));
  check("  with its three assets", ["mint-dock.css", "ui-actions.js", "mint-dock.js"].every((f) => all.includes("/" + f) || new RegExp(f.replace(".", "\\.") + "(\\?|\")").test(all)));
  check("  hidden until its script runs (no dock without JavaScript)", /<div class="md-root" id="mint-dock-root"[^>]* hidden>/.test(all));
  check("  carrying the CSRF token for its posts", /data-csrf="demo-csrf-token"/.test(all));
  check("  mic, orb, state, expand; every link goes to the Command Center", /id="md-mic"/.test(all) && /id="md-orb"[^>]*|href="\/mint-ai"[^>]*id="md-orb"/.test(all) && (all.match(/href="\/mint-ai"/g) || []).length >= 3);
  const quiet = render("*", null, false);
  check("  no mic at all when voice is off for this viewer (off, no key, or no voice.use): orb, state, expand only", /id="mint-dock-root"/.test(quiet) && !/id="md-mic"/.test(quiet) && !/hold to talk|mic starts a live call/.test(quiet));
  check("  the mic starts a live conversation (no hold to talk)", /id="md-mic" aria-label="Start a live conversation"/.test(all) && !/Hold to talk|hold to talk/.test(all));
  check("not for a role without moniai.use", !/mint-dock-root/.test(render(["os.view"])) && !/mint-dock\.js/.test(render(["os.view"])));
  check("not on the Command Center (the bare page: it is MINT AI already)", !/mint-dock-root/.test(render("*", { bare: true, active: "moni-ai" })) && !/dock-band/.test(render("*", { bare: true, active: "moni-ai" })));
  check("  opts.dash is ignored (no dashboard switches the dock off any more)", /mint-dock-root/.test(render("*", { dash: "console", active: "console" })));
  check("not when a page opts out (dock: false)", !/mint-dock-root/.test(render("*", { dock: false })));
  check("not signed out", !/mint-dock-root/.test(ui.shell("Sign in", "<div class=\"card\">x</div>", {})));
  check("the Command Center route renders its page bare, as the moni-ai item", /active: "moni-ai",\s*bare: true/.test(fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8")));
  check("the dock sits in its band under the content column (with-dock on <html>, .dock-band before the dock)", /<html lang="en" class="framed with-dock">/.test(all) && all.indexOf('class="dock-band"') > 0 && all.indexOf('class="dock-band"') < all.indexOf("mint-dock-root"));
  check("  no band and no with-dock without the dock", !/with-dock|dock-band/.test(render(["os.view"])) && !/with-dock|dock-band/.test(render("*", { dock: false })));
}

console.log("\nthe role decides where page.open may go (before moving)");
{
  const pagesOf = (html) => (/data-pages="([^"]*)"/.exec(html.slice(html.indexOf("mint-dock-root"))) || [])[1].split(" ");
  const lim = pagesOf(render(["os.view", "moniai.use"]));
  check("a limited role: only the pages it can see (and guide, account, your devices, the Command Center and its Settings)", lim.sort().join() === ["os", "devices", "guide", "account", "cc", "settings"].sort().join(), lim.join());
  const full = pagesOf(render("*"));
  check("an administrator: every entry of the page map in use (the built-in pages before a scan)", full.join() === Object.keys(UA.pages()).join() && full.length === Object.keys(UA.BUILTIN_PAGES).length, full.join());
  const all = render("*");
  const mapJson = (/data-page-map="([^"]*)"/.exec(all) || [])[1] || "[]";
  const map = JSON.parse(mapJson.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  check("the dock also carries the map (data-page-map JSON: key, url, label, perm) for UiActions.setPages", map.length === full.length && map.every((e) => e.key && /^\//.test(e.url) && e.label && "perm" in e));
}

console.log("\nno inline code (the CSP forbids it)");
{
  const html = render("*");
  const dock = html.slice(html.indexOf('<div class="md-root"'));
  check("no style= and no on*= in the dock's markup", !/\sstyle=|\son[a-z]+=/.test(dock.slice(0, dock.indexOf("</div>\n</div>") + 20)));
  check("no inline <script> in the dock", !/<script>/.test(dock));
}

console.log("\npublic/mint-dock.js");
{
  const js = fs.readFileSync(path.join(ROOT, "public", "mint-dock.js"), "utf8");
  const code = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("no eval, no new Function, no document.write", !/\beval\(|new Function|document\.write/.test(code));
  check("innerHTML only for the escaped «You: …» line", (code.match(/innerHTML/g) || []).length === 1 && /innerHTML = st\.you \? "You: <b>" \+ esc\(st\.you\)/.test(code));
  check("its posts carry the CSRF header", /"X-CSRF-Token": CSRF/.test(code));
  check("the tab's id is the Command Center's (sessionStorage mint-tab), so MINT AI's screen actions reach this tab", /sessionStorage\.getItem\("mint-tab"\)/.test(code) && /events\?tab=/.test(code) && /tab: TAB_ID/.test(code));
  check("the mic starts a live call in the Command Center, this page kept in its frame (no push to talk here)", /location\.assign\("\/mint-ai\?at=" \+ encodeURIComponent\(here\) \+ "&call=1"\)/.test(code) && !/api\("transcribe"|MediaRecorder|getUserMedia/.test(code));
  check("page.open: the role is checked (data-pages) before moving, and a refusal is answered and shown", /PAGES_OK\.indexOf\(" " \+ v\.args\.page \+ " "\) < 0/.test(code) && /their role cannot open/.test(code) && /your role cannot see it/.test(code));
  check("page.open leaves a note for the next page (Undo) and moves by a known key only", /sessionStorage\.setItem\("mint-opened"/.test(code) && /location\.assign\(np\.url\)/.test(code) && !/location\.assign\(v\.args/.test(code));
  check("Undo returns only to a path of this site", /\^\\\/\[A-Za-z0-9\/_-\]\*\$/.test(code));
  check("a Tier-2 change is withdrawn here (cancel), never applied", /api\("ui\/confirm", \{ id: ev\.confirm, decision: "cancel" \}\)/.test(code) && !/decision: "confirm"/.test(code));
  check("anything else is refused: it needs the Command Center", /needs the Command Center open/.test(code));
  check("no live call of its own (the Command Center holds it; in the shell the mic is the Command Center's)", !/voice\/live|getUserMedia/.test(code) && /window\.__mintLive/.test(code));
  check("the core pauses when the tab is hidden, and draws one still frame under reduced motion", /document\.hidden/.test(code) && /prefers-reduced-motion: reduce/.test(code) && /if \(reduced\) \{ t = 2\.4; drawOrb\(\); \}/.test(code));
  check("no Space to talk (it went with push to talk)", !/"Space"/.test(code));
}

console.log("\npublic/mint-dock.css");
{
  const css = fs.readFileSync(path.join(ROOT, "public", "mint-dock.css"), "utf8");
  check("tokens for light, system-dark and forced dark", /:root \{/.test(css) && /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/.test(css) && /:root\[data-theme="dark"\]/.test(css));
  check("a phone layout, reduced motion, and hidden in print", /@media \(max-width: 600px\)/.test(css) && /prefers-reduced-motion: reduce/.test(css) && /@media print \{ \.md-root \{ display: none; \} \}/.test(css));
  check("every rule is its own (md- prefix): it cannot restyle the Command Center", css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter((sel) => sel && !/^@|^:root|^from|^to|^\d+%|^50%/.test(sel)).every((sel) => sel.split(",").every((x) => /\.md-/.test(x))));
}

console.log("\nthe Command Center as a shell (M-5 part 2)");
{
  const views = require(path.join(ROOT, "lib", "views-moniai.js"));
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("CSP: frame-ancestors 'self' (a same-origin frame only), never 'none' or a host", /frameAncestors: \["'self'"\]/.test(server) && !/frameAncestors: \["'none'"\]/.test(server));
  check("  X-Frame-Options stays helmet's SAMEORIGIN (frameguard not switched off)", !/frameguard:\s*false/.test(server) && !/xFrameOptions:\s*false/.test(server));
  const shellDock = ui.dockMarkup("demo-csrf-token", permOf("*"), { shell: true });
  check("the shell's dock: data-shell, a frame named mint-frame (hidden), the flight canvas, an end-call button; hidden until a page is up", /data-shell="1"/.test(shellDock) && /<iframe class="md-frame" id="md-frame" name="mint-frame" title="Mint OS page" hidden><\/iframe>/.test(shellDock) && /id="md-hero"/.test(shellDock) && /id="md-end"/.test(shellDock) && /class="md-dock off"/.test(shellDock));
  check("  the frame has no sandbox and no src until a page opens", !/sandbox|md-frame"[^>]*src=/.test(shellDock));
  const pageDock = ui.dockMarkup("demo-csrf-token", permOf("*"));
  check("  an ordinary page's dock has none of that", !/md-frame|md-hero|md-end|data-shell/.test(pageDock));
  const vsrc = fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8");
  check("the Command Center page renders the shell's dock and loads mint-dock.css/js and mint-shell.js after moni-ai.js", /dockMarkup\(o\.csrf, perm, \{ shell: true, noVoice: !vOk \}\)/.test(vsrc) && /"moni-ai\.js", "mint-dock\.js", "mint-shell\.js"\]/.test(vsrc) && /"mint-dock\.css"/.test(vsrc));
  const sh = fs.readFileSync(path.join(ROOT, "public", "mint-shell.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("mint-shell.js: only paths of this site open in the frame (not /mint-ai, /login, /logout, the API, //host)", /x\.origin !== ORIGIN/.test(sh) && /\/\^\\\/\(\?!\\\/\)\//.test(sh) && /logout\|login\|mint-ai\\\/api/.test(sh) && /isCC\(x\.pathname\)/.test(sh));
  check("  messages only from this origin and from the frame's own window; posts only to this origin", /e\.origin !== ORIGIN \|\| e\.source !== frame\.contentWindow/.test(sh) && /postMessage\(\{ mint: "theme", theme: [^}]*\}, ORIGIN\)/.test(sh) && !/postMessage\([^)]*"\*"\)/.test(sh));
  check("  history: an entry per switch (/mint-ai?at=... and /mint-ai), popstate follows, the address follows moves inside the frame", /history\.pushState\(\{ mint: "frame"/.test(sh) && /history\.pushState\(\{ mint: "cc" \}, "", "\/mint-ai"\)/.test(sh) && /addEventListener\("popstate"/.test(sh) && /history\.replaceState\(\{ mint: "frame", url: p \}/.test(sh));
  check("  a deep link (?at=) opens straight onto the page, back lands on the Command Center", /get\("at"\)/.test(sh) && /open\(deep, \{ instant: true \}\)/.test(sh));
  check("  the Command Center under a page is inert and its core stopped; restored on the way back", /setAttribute\("inert", ""\)/.test(sh) && /removeAttribute\("inert"\)/.test(sh) && /coreStop\(\)/.test(sh) && /coreStart\(\)/.test(sh));
  check("  every flight style is cleared on landing (the Command Center looks as before)", /setOp\(cc, ""\); setOp\(frame, ""\); setOp\(dockEl, ""\);/.test(sh) && /html\.classList\.remove\("md-flying"\)/.test(sh));
  check("  reduced motion: no flight", /if \(reduced \|\| o\.instant\)/.test(sh));
  check("  no live call is stopped by opening a page", !/VoiceLive\.stop|liveStop/.test(sh));
  const cc = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  check("moni-ai.js: page.open opens in the shell (Undo = back) and falls back to the old whole-tab move only without it", /window\.MintShell && window\.MintShell\.open\(np\.url\)\) \{ undo = function \(\) \{ window\.MintShell\.back\(\); \}/.test(cc) && /if \(!pageOpenSoon\(a\.page, np\)\) return \{ ok: false/.test(cc));
  const pos = cc.slice(cc.indexOf("function pageOpenSoon"), cc.indexOf("function uiToast"));
  check("  pageOpenSoon never ends a call, and never moves the tab while a call is on or the shell is here (a link instead)", pos.length > 200 && !/VoiceLive\.stop|liveStop/.test(pos) && /if \(liveActive\(\) \|\| window\.MintShell\) \{ uiToast\(np\.label/.test(pos));
  check("  anything but the call, page.open and a Tier-2 ask brings the Command Center back first", /shellUp\(\) && v\.tier !== 2 && \["call\.end", "call\.mute", "call\.interrupt", "page\.open"\]\.indexOf\(v\.action\) < 0\) window\.MintShell\.expand\(\)/.test(cc));
  check("  its notes go to the dock while a page is up, and it feeds the dock its state", /if \(shellUp\(\)\) return window\.MintShell\.toast/.test(cc) && /window\.MintShell\.feed\(\{ state: st/.test(cc));
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const br = app.slice(app.indexOf("The bridge to the Command Center's shell"));
  check("app.js bridge: only when framed by the shell (same origin, parent is top)", /window\.top !== window && window\.parent === window\.top && window\.top\.location\.origin === location\.origin && window\.top\.MintShell/.test(br) && /if \(!parent\) return;/.test(br));
  check("  breaks out when signed out, on logout, and for the Command Center itself", /\.auth-wrap/.test(br) && /parent\.location\.replace/.test(br) && /form\[action="\/logout"\]/.test(br) && /\.target = "_top"/.test(br) && /send\(\{ mint: "expand" \}\)/.test(br));
  check("  sends where it is and theme changes (no Space to talk any more); takes the theme only from its parent", /send\(\{ mint: "nav" \}\)/.test(br) && !/mint: "space"/.test(br) && /e\.origin !== ORIGIN \|\| e\.source !== parent/.test(br) && /parent\.postMessage\(m, ORIGIN\)/.test(br));
  const dj = fs.readFileSync(path.join(ROOT, "public", "mint-dock.js"), "utf8");
  check("mint-dock.js: none of its own inside the frame; in the shell no stream or recorder of its own", /if \(framed\) \{ root\.remove\(\); return; \}/.test(dj) && /if \(!SHELL\) \{\s*var drv = pageDriver\(\);/.test(dj));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
