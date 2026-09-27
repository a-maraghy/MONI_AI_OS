/**
 * Tests for the MONI AI Command Center page: the server-rendered frame
 * (lib/views-moniai.js), the shell changes it relies on (lib/ui.js), the tab's
 * permission, and the pure helpers inside public/moni-ai.js.
 *
 *     node dashboard/tools/test-moniai-page.cjs
 *
 * What matters most here is what the Content-Security-Policy would silently
 * break and what an attacker-controlled string could do: the page must carry no
 * inline script, no inline handler and no inline style (style-src 'self' and
 * script-src-attr 'none' refuse them without an error anyone would notice),
 * and every server-side value must arrive escaped.
 *
 * The client helpers are cut out of moni-ai.js and run here rather than copied,
 * so this tests the code that ships -- the same approach as test-markdown.cjs.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const ui = require(path.join(ROOT, "lib", "ui.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}

/* ------------------------------------------------------------ the frame --- */

const EVIL = `<img src=x onerror=alert(1)>"'&`;
const admin = rbac.actor({ permissions: ["*"] });
const html = views.page({
  csrf: `tok"en<`,
  user: { name: EVIL, roleLabel: "Administrator", perm: admin, dash: "console" },
  voice: { configured: true, voice: `v-${EVIL}`, model: "gpt-realtime-mini", manage: true },
});

check("renders a whole page", html.startsWith("<!doctype html>") && html.includes("</html>"));
check("html carries the page class", /<html lang="en" class="cc-page">/.test(html));
check("no inline <script> bodies", !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
// Quoted attribute values are emptied first: the escaped viewer name sits in
// data-viewer as text, which is harmless and not an attribute of its own.
check("no inline event handlers on any tag", !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html.replace(/"[^"]*"/g, '""')));
check("no inline style attributes", !/\sstyle\s*=/i.test(html));
check("no <style> blocks", !/<style[\s>]/i.test(html));
check("no external URLs in src or href", !/(src|href)="(https?:)?\/\//i.test(html));
check("viewer name is escaped", !html.includes(EVIL) && html.includes("&lt;img src=x onerror=alert(1)&gt;"));
check("csrf token is escaped in the data attribute", html.includes('data-csrf="tok&quot;en&lt;"'));
check("voice name is escaped", !html.includes(`v-${EVIL}`) && html.includes("v-&lt;img"));
check("loads the theme script before the stylesheet", html.indexOf("theme-init.js") > -1 && html.indexOf("theme-init.js") < html.indexOf("style.css"));
check("theme script is blocking (not deferred)", /<script src="\/static\/theme-init\.js\?v=[^"]+"><\/script>/.test(html));
check("loads its own stylesheet and deferred script", /moni-ai\.css\?v=/.test(html) && /<script src="\/static\/moni-ai\.js\?v=[^"]+" defer>/.test(html));
check("offers System, Dark and Light", ["system", "dark", "light"].every((t) => html.includes(`data-theme-opt="${t}"`)));
check("System is the default choice", /data-theme-opt="system" aria-checked="true"/.test(html));
check("every icon reference has a symbol", (() => {
  const used = new Set([...html.matchAll(/href="#cc-i-([a-z]+)"/g)].map((m) => m[1]));
  const js = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
  for (const m of js.matchAll(/ic\("([a-z]+)"/g)) used.add(m[1]);
  const missing = [...used].filter((n) => !views.SPRITE[n]);
  return missing.length === 0 || (console.log("   missing:", missing.join(", ")), false);
})());
check("the MONI AI tab is active and points at the Command Center", /<a href="\/moni-ai" class="top-tab on">/.test(html));
check("no sidebar on this page", !html.includes('class="sidebar"'));
check("every id is unique", (() => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  return ids.length === new Set(ids).size;
})());
check("a page without an OpenAI key says so and points to Settings", (() => {
  const p = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: false, manage: true } });
  return p.includes(">no key<") && p.includes("Add an OpenAI key in Settings") && /id="cc-mic-big"[^>]*disabled/.test(p);
})());

/* ----------------------------------------------------------- the shell --- */

const plain = ui.shell("X", "<p>body</p>", { user: { name: "u", perm: admin }, csrf: "c" });
check("other pages keep no page class", /<html lang="en">/.test(plain));
check("every page loads the theme script before its stylesheet", plain.indexOf("theme-init.js") > -1 && plain.indexOf("theme-init.js") < plain.indexOf("style.css"));
check("every signed-in page carries the theme switch", plain.includes("data-theme-switch") && ["system", "dark", "light"].every((t) => plain.includes(`data-theme-opt="${t}"`)));
check("the signed-out page has no switch (no top bar at all)", !ui.shell("Sign in", "<form></form>", {}).includes("data-theme-switch"));
check("assets outside public/ are refused", !ui.page("x", "", { assets: ["../server.js", "a b.js", "evil.css?x"] }).includes("server.js"));
check("a page class with markup is refused", !ui.page("x", "", { pageClass: 'a" onload="x' }).includes("onload"));

/* ----------------------------------------------------------- the tab --- */

check("moniai.use alone reveals the MONI AI tab", rbac.actor({ permissions: ["moniai.use"] }).canDash("console"));
check("console.use alone still reveals it (it redirects to /console)", rbac.actor({ permissions: ["console.use"] }).canDash("console"));
check("a viewer without either does not see it", !rbac.actor({ permissions: ["os.view"] }).canDash("console"));
check("the tab's href is /moni-ai", ui.NAV[0].key === "console" && ui.NAV[0].href === "/moni-ai");

/* ------------------------------------------------- server wiring (source) --- */

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
{
  const m = /const PAYLOAD_ROUTES = (\/.*\/);/.exec(server);
  const re = m && vm.runInNewContext(m[1]);
  check("the transcribe route gets the large body parser", !!re && re.test("/moni-ai/api/transcribe"));
  check("the console's payload routes are still covered", !!re && re.test("/console/12/upload") && re.test("/console/3/transcribe"));
  check("nothing else gets the large parser", !!re && !re.test("/moni-ai/api/send") && !re.test("/moni-ai/api/transcribe/x"));
}
check("/moni-ai is behind requireAuth", /app\.get\("\/moni-ai", requireAuth,/.test(server));
check("/moni-ai checks moniai.use", /app\.get\("\/moni-ai"[\s\S]{0,400}can\("moniai\.use"\)/.test(server));
check("speak needs the permission and CSRF", /app\.post\("\/moni-ai\/api\/speak", \.\.\.moniAiWrite,/.test(server));
check("transcribe checks permission before parsing and CSRF after", /app\.post\("\/moni-ai\/api\/transcribe", requireApiPerm\("moniai\.use"\), moniAiAudioBody, requireApiCsrf,/.test(server));
check("/console still has its route", /app\.get\("\/console", requireAuth, requirePerm\("console\.use"\)/.test(server));

/* ------------------------------------------------ client helpers (source) --- */

const client = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");

/** Pull `function name(...) {...}` out of the client by brace matching. */
function cut(name) {
  const start = client.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = client.indexOf("{", start); i < client.length; i++) {
    if (client[i] === "{") depth++;
    else if (client[i] === "}" && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}
const sandbox = {};
vm.runInNewContext(["esc", "modelLabel", "dur", "clip", "firstLine", "speakable", "sentences"].map(cut).join("\n"), sandbox);

check("esc escapes the five", sandbox.esc(`<a href="x" onclick='y'>&</a>`) === "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
check("esc of null is empty", sandbox.esc(null) === "" && sandbox.esc(undefined) === "");
check("model label: opus 5.5", sandbox.modelLabel("claude-opus-5-5") === "Opus 5.5");
check("model label: dated haiku keeps no date", sandbox.modelLabel("claude-haiku-4-5-20251001") === "Haiku 4.5");
check("model label: sonnet 5", sandbox.modelLabel("claude-sonnet-5") === "Sonnet 5");
check("durations read like a person would say them", sandbox.dur(4000) === "4s" && sandbox.dur(108000) === "1m 48s" && sandbox.dur(3900000) === "1h 05m");
check("no duration is a dash", sandbox.dur(null) === "—");
check("clip adds an ellipsis only when it cuts", sandbox.clip("abcdef", 4) === "abc…" && sandbox.clip("abc", 4) === "abc");
check("first line skips blank lines", sandbox.firstLine("\n\n  \nhello\nworld") === "hello");
check("speech drops code blocks and links", (() => {
  const s = sandbox.speakable("Run `ls` then:\n```\nrm -rf /\n```\nsee https://example.com/x and [the docs](https://d)");
  return !s.includes("rm -rf") && s.includes("(code)") && s.includes("a link") && s.includes("the docs") && !s.includes("`");
})());
check("sentences come out whole and the rest waits", (() => {
  const r = sandbox.sentences("One. Two! Three", 0);
  return r.list.join("|") === "One.|Two!" && r.consumed === "One. Two!".length;
})());
check("sentences resume from where they stopped", sandbox.sentences("One. Two. Three.", 5).list.join("|") === "Two.|Three.");

/* The strings the client builds as markup must not carry inline style either:
   CSP refuses a style="" set through innerHTML just as it refuses one in the
   served page. */
check("client markup builds no style attributes", !/style=\\?"/.test(client.replace(/\.style\./g, "")));
check("client builds no inline handlers", !/\son(click|error|load|mouse\w+|key\w+)=/i.test(client));
check("client talks only to this origin", !/(fetch|EventSource)\(\s*["']https?:/.test(client));
check("the Remote Control link is only opened for claude.ai", /\^https:\\\/\\\/claude\\\.ai\\\//.test(client));
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const initJs = fs.readFileSync(path.join(ROOT, "public", "theme-init.js"), "utf8");
check("the theme key is the same in theme-init.js and app.js", initJs.includes('"moni-theme"') && appJs.includes('"moni-theme"'));
check("the Command Center repaints on a theme change", appJs.includes('"moni-theme"') && /addEventListener\("moni-theme"/.test(client));
check("storage access is guarded (theme-init.js, app.js)", [initJs, appJs].every((src) => {
  const idx = [...src.matchAll(/localStorage\./g)].map((m) => m.index);
  return idx.length > 0 && idx.every((i) => src.lastIndexOf("try {", i) > src.lastIndexOf("}", i - 1) - 200 && src.lastIndexOf("try {", i) > -1);
}));
check("theme-init only accepts dark or light", /t === "dark" \|\| t === "light"/.test(initJs));

/* ---------------------------------------------------- the site palette --- */

const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
/** The rules, without comments and without the palette blocks at the top. */
const body = (() => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = noComments.indexOf(":root {");
  const media = noComments.indexOf("@media (prefers-color-scheme: dark)");
  let depth = 0, end = -1;
  for (let i = noComments.indexOf("{", media); i < noComments.length; i++) {
    if (noComments[i] === "{") depth++;
    else if (noComments[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return noComments.slice(0, start) + noComments.slice(end);
})();
const literals = (body.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => c.toLowerCase() !== "#fff");
check("style.css rules use tokens, not literal colours (QR codes stay white)", literals.length === 0, literals.join(" "));
check("a dark palette exists, chosen and from the system", css.includes(':root[data-theme="dark"]') && /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/.test(css));
check("the dark palette sets every token the light one declares for colour", (() => {
  const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const colourTokens = [...light.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8}|rgba?\()/gi)].map((m) => m[1]);
  const missing = colourTokens.filter((t) => !dark.includes(t + ":"));
  return missing.length === 0 || (console.log("   not in dark:", missing.join(" ")), false);
})());
const ccCss = fs.readFileSync(path.join(ROOT, "public", "moni-ai.css"), "utf8");
check("the Command Center palette ties on specificity and so wins on order", /^:root\.cc-page \{/m.test(ccCss) && ccCss.includes(':root.cc-page[data-theme="light"]'));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
