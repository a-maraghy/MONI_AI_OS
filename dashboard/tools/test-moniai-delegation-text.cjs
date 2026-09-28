/**
 * Tests for showing a delegation's FULL sent text in the Command Center
 * (administrator request, 2026-09-28): the session card's message popover
 * and the Timeline's delegation rows must carry the whole `text` field from
 * the ledger, not a clipped summary or first line -- while still escaping it
 * (it is arbitrary content MONI AI sent, not trusted markup) and staying
 * inside its own scrolling box rather than growing the page.
 *
 *     node dashboard/tools/test-moniai-delegation-text.cjs
 *
 * Companion to test-moniai-page.cjs, which already covers the page frame and
 * the broad CSP/escaping rules that apply to every string the client builds;
 * this file is narrower, about this one feature.
 *
 * .cjs because it uses require, and some directories it may be run from
 * declare "type": "module".
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-moniai.js"));
const client = fs.readFileSync(path.join(ROOT, "public", "moni-ai.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "moni-ai.css"), "utf8");

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

/* ---------------------------------------------------------------- icon --- */

check("a message icon exists for the sprite", !!views.SPRITE.message);
check("the client references the message icon", /ic\("message"\)/.test(client));

/* ------------------------------------------------------- session card --- */

check(
  "the session card only offers the message popover when there is text to show",
  /s\.last_delegation && \(s\.last_delegation\.text \|\| s\.last_delegation\.summary\)/.test(client)
);
check("the message button carries data-msg keyed by the session", /data-msg="\s*'\s*\+\s*esc\(key\)/.test(client.replace(/\s+/g, " ")));
check("openMsgPopover is defined", client.includes("function openMsgPopover("));
{
  const fn = cut("openMsgPopover");
  check("the popover shows the full text (falls back to summary only), not a clip() or firstLine()", /esc\(d\.text \|\| d\.summary \|\| ""\)/.test(fn));
  check("openMsgPopover never truncates the body with clip() or firstLine()", !/\b(clip|firstLine)\(\s*d\.text/.test(fn));
  check("the popover body sits in its own .cc-pop-body block", fn.includes('cc-pop-body'));
  check("the popover shows when it was sent and the current status", /esc\(hm\(when\)\)/.test(fn) && /TL_LAB\[d\.status\]/.test(fn));
  check("the close button is wired, no inline handler", fn.includes("data-close") && !/on[a-z]+\s*=/.test(fn));
}
check(
  "clicking a message button opens the popover (wired in the sessions click handler)",
  /data-msg.*openMsgPopover|openMsgPopover\(sm, m\)/.test(client)
);
check(
  "clicking outside the popover does not close it while a message button triggered it",
  /!e\.target\.closest\("\[data-msg\]"\)/.test(client)
);

/* -------------------------------------------------------------- timeline --- */

{
  const fn = cut("renderTimeline");
  // The delegation branch (kind === "d") must render the row's own `.text`
  // (or `.summary` as a fallback for rows that predate the field), never a
  // clipped or first-line-only rendering as before.
  const delegationLine = fn.split("\n").find((l) => l.includes('class="t full"'));
  check("renderTimeline has a delegation row with the full-text class", !!delegationLine);
  check(
    "the delegation row shows esc(r.text || r.summary), not clip()/firstLine() of the message",
    !!delegationLine && /esc\(r\.text \|\| r\.summary \|\| ""\)/.test(delegationLine)
  );
  check(
    "the delegation row's own text is never wrapped in clip()/firstLine()",
    !!delegationLine && !/\b(clip|firstLine)\(r\.text/.test(delegationLine)
  );
  // The approval branch is untouched: still clipped, since approvals are a
  // different, already-short kind of entry this feature does not cover.
  const approvalLine = fn.split("\n").find((l) => l.includes("approvalCmd(r).text"));
  check("the approval row (a different ledger) still clips as before", !!approvalLine && /clip\(approvalCmd\(r\)\.text, 160\)/.test(approvalLine));
  check("the time and status badge are still rendered on the delegation row", !!delegationLine && delegationLine.includes("cc-tl-time") && /cc-badge b-.*TL_LAB/.test(delegationLine));
}

/* ------------------------------------------------------------------ css --- */

check(
  "the timeline's full-text block is unclamped and scrolls within itself",
  /\.cc-tl-cmd \.t\.full\s*\{[^}]*-webkit-line-clamp:\s*unset[^}]*overflow-y:\s*auto/s.test(css.replace(/\n/g, " "))
);
check(
  "the timeline's full-text block preserves the message's own line breaks",
  /\.cc-tl-cmd \.t\.full\s*\{[^}]*white-space:\s*pre-wrap/s.test(css.replace(/\n/g, " "))
);
check(
  "the session popover's message body scrolls within itself, not the page",
  /\.cc-pop-msg \.cc-pop-body\s*\{[^}]*overflow-y:\s*auto/s.test(css.replace(/\n/g, " "))
);
check(
  "the session popover's message body wraps long words instead of overflowing",
  /\.cc-pop-msg \.cc-pop-body\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css.replace(/\n/g, " "))
);
check(
  "the popover has a fixed max-height (never grows the page)",
  /\.cc-pop-msg \.cc-pop-body\s*\{[^}]*max-height:\s*\d/s.test(css.replace(/\n/g, " "))
);
// No new colour literal was introduced; the theme rule from test-moniai-page.cjs already
// checks the whole file, but a scoped check here documents the intent locally.
check("the new rules use theme tokens, not literal colours", !/\.cc-pop-msg[\s\S]{0,400}#[0-9a-fA-F]{3,8}/.test(css));

/* ---------------------------------------------------- escaping, in practice --- */

{
  const { esc } = (() => {
    const vm = require("vm");
    const sandbox = {};
    vm.runInNewContext(cut("esc"), sandbox);
    return sandbox;
  })();
  const evil = `<img src=x onerror=alert(1)>Please pick up the review.\nLine two.`;
  const rendered = esc(evil);
  check("esc() neutralises HTML that could be sitting in a delegation's text", !rendered.includes("<img"));
  check("esc() keeps the newline (CSS white-space:pre-wrap renders it, not <br>)", rendered.includes("\n"));
}

/* ---------------------------------------------------- no CSP regressions --- */

check("no inline style attribute was introduced by this feature", !/cc-pop-msg[\s\S]{0,200}style=\\?"/.test(client));
check("no inline event handler was introduced by this feature", !/data-msg[\s\S]{0,400}\son[a-z]+=/.test(client));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
