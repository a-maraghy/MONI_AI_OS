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
const render = (perms, extra) => ui.shell("Test", "<p>body</p>", Object.assign({ user: { name: "demo-admin", perm: permOf(perms) }, csrf: "demo-csrf-token", active: "home" }, extra || {}));

console.log("where the dock appears");
{
  const all = render("*");
  check("on an ordinary page for someone who may use MINT AI", /id="mint-dock-root"/.test(all));
  check("  with its three assets", ["mint-dock.css", "ui-actions.js", "mint-dock.js"].every((f) => all.includes("/" + f) || new RegExp(f.replace(".", "\\.") + "(\\?|\")").test(all)));
  check("  hidden until its script runs (no dock without JavaScript)", /<div class="md-root" id="mint-dock-root"[^>]* hidden>/.test(all));
  check("  carrying the CSRF token for its posts", /data-csrf="demo-csrf-token"/.test(all));
  check("  mic, orb, state, expand; every link goes to the Command Center", /id="md-mic"/.test(all) && /id="md-orb"[^>]*|href="\/mint-ai"[^>]*id="md-orb"/.test(all) && (all.match(/href="\/mint-ai"/g) || []).length >= 3);
  check("not for a role without moniai.use", !/mint-dock-root/.test(render(["os.view"])) && !/mint-dock\.js/.test(render(["os.view"])));
  check("not on MINT AI's own pages (the console dashboard)", !/mint-dock-root/.test(render("*", { dash: "console", active: "console" })));
  check("not when a page opts out (dock: false)", !/mint-dock-root/.test(render("*", { dock: false })));
  check("not signed out", !/mint-dock-root/.test(ui.shell("Sign in", "<div class=\"card\">x</div>", {})));
  check("the Command Center route renders its page with the console dashboard", /dash: "console"|active: "console"/.test(fs.readFileSync(path.join(ROOT, "lib", "views-moniai.js"), "utf8")));
}

console.log("\nthe role decides where page.open may go (before moving)");
{
  const pagesOf = (html) => (/data-pages="([^"]*)"/.exec(html.slice(html.indexOf("mint-dock-root"))) || [])[1].split(" ");
  const lim = pagesOf(render(["os.view", "moniai.use"]));
  check("a limited role: only the pages it can see (and guide, account, the Command Center)", lim.sort().join() === ["os-overview", "guide", "account", "command-center"].sort().join(), lim.join());
  const full = pagesOf(render("*"));
  check("an administrator: all 21", full.length === 21 && full.every((k) => UA.NAV_PAGES[k]));
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
  check("a voice turn is transcribed here and sent with its voice-turn id", /api\("transcribe", \{ data: data, mime: mime, vt: vt/.test(code) && /api\("send", \{ text: said, vt: vt, tab: TAB_ID \}/.test(code));
  check("a stop command is not sent; «undo» after a page.open goes back", /VoiceStop\.heard\(said\)/.test(code) && /VoiceStop\.undo\(said\) && cameBack/.test(code));
  check("page.open: the role is checked (data-pages) before moving, and a refusal is answered and shown", /PAGES_OK\.indexOf\(" " \+ v\.args\.page \+ " "\) < 0/.test(code) && /their role cannot open/.test(code) && /your role cannot see it/.test(code));
  check("page.open leaves a note for the next page (Undo) and moves by a known key only", /sessionStorage\.setItem\("mint-opened"/.test(code) && /location\.assign\(np\.url\)/.test(code) && !/location\.assign\(v\.args/.test(code));
  check("Undo returns only to a path of this site", /\^\\\/\[A-Za-z0-9\/_-\]\*\$/.test(code));
  check("a Tier-2 change is withdrawn here (cancel), never applied", /api\("ui\/confirm", \{ id: ev\.confirm, decision: "cancel" \}\)/.test(code) && !/decision: "confirm"/.test(code));
  check("anything else is refused: it needs the Command Center", /needs the Command Center open/.test(code));
  check("no live call here (part 2 keeps it across pages)", !/VoiceLive|voice\/live|getUserMedia\([^)]*\)\.then\(function \(s\) \{ live/.test(code));
  check("the core pauses when the tab is hidden, and draws one still frame under reduced motion", /document\.hidden/.test(code) && /prefers-reduced-motion: reduce/.test(code) && /if \(reduced\) \{ t = 2\.4; drawOrb\(\); \}/.test(code));
  check("Space talks only outside inputs", /function typing\(el\)/.test(code) && /e\.code !== "Space" \|\| e\.repeat/.test(code));
}

console.log("\npublic/mint-dock.css");
{
  const css = fs.readFileSync(path.join(ROOT, "public", "mint-dock.css"), "utf8");
  check("tokens for light, system-dark and forced dark", /:root \{/.test(css) && /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/.test(css) && /:root\[data-theme="dark"\]/.test(css));
  check("a phone layout, reduced motion, and hidden in print", /@media \(max-width: 600px\)/.test(css) && /prefers-reduced-motion: reduce/.test(css) && /@media print \{ \.md-root \{ display: none; \} \}/.test(css));
  check("every rule is its own (md- prefix): it cannot restyle the Command Center", css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter((sel) => sel && !/^@|^:root|^from|^to|^\d+%|^50%/.test(sel)).every((sel) => sel.split(",").every((x) => /\.md-/.test(x))));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
