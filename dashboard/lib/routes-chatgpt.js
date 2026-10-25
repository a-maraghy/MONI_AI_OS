"use strict";
/**
 * MINT AI ▸ Settings ▸ ChatGPT (/mint-ai/settings/chatgpt): the mint-chatgpt
 * broker that lets every agent hand a task to ChatGPT when the person asks
 * (chatgpt/README.md).
 *
 *   Sign-in        signed in / not signed in / expired, and "Sign in again":
 *                  the helper starts `codex login --device-auth` on the server
 *                  and the page shows its link and one-time code, then polls
 *                  until it is done or the code expires (15 minutes).
 *   Service        the broker running, tasks in progress and queued, the limits.
 *   Who may use it MINT AI (always on: its supervisor has no switch) and one
 *                  switch per Telegram agent (ALLOW_CHATGPT, rendered by the helper).
 *   Recent calls   the last 100: when, who, how long, outcome, files returned.
 *                  Never the task or the answer -- the broker does not keep them.
 *
 * Every read and write is a moni-helper subcommand (chatgpt-status,
 * chatgpt-calls, chatgpt-login-start, chatgpt-login-poll, agent-chatgpt). The
 * sign-in itself (/root/.codex) never reaches this process. Administrator only
 * (views-settings mayOpen); "Sign in again" asks for Windows Hello or the
 * authenticator code first (lib/stepup.js), like every other step that hands
 * out access.
 *
 *   install(sections)               adds the section renderer
 *   mount(app, deps, { guard, reply, audit })   the routes
 */

const V = require("./views-settings");
const { esc, icon } = require("./ui");

/** The sign-in waiting for the person, server-wide (the helper allows one at a time). */
let pending = null; // { id, url, code, expires_at, by }

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

function priv(deps) {
  return deps.priv || require("./priv");
}

/** "agent:mavix-bot" -> who that is, in words. */
function callerOf(raw, names) {
  const c = String(raw || "");
  let m;
  if (c === "mint-ai") return ["MINT AI", "the assistant"];
  if ((m = /^agent:(.+)$/.exec(c))) return [names[m[1]] || m[1], "Telegram agent"];
  if ((m = /^hired:(.+)$/.exec(c))) return [m[1], "hired session"];
  if ((m = /^console:(.+)$/.exec(c))) return ["Console", m[1] + " access"];
  if ((m = /^cli:(.+)$/.exec(c))) return ["Command line", m[1]];
  return [c || "unknown", ""];
}

function took(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const s = Math.round(Number(sec));
  return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
}

/** Cairo time on the server (the supervisor's zone); the page script turns it into the browser's own. */
function when(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return `<span>—</span>`;
  const text = d.toLocaleString("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `<time datetime="${esc(d.toISOString())}" data-local>${esc(text)}</time>`;
}

const LOGIN_WORDS = {
  signed_in: ["Signed in", "ok", '<circle cx="8" cy="8" r="5"/>'],
  expired: ["Sign-in expired", "warn", '<path d="M8 2.5 14 13H2Z"/>'],
  signed_out: ["Not signed in", "bad", '<path d="M8 2.5 14 13H2Z"/>'],
};
function chip(word, tone, shape) {
  return `<span class="state ${tone}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" stroke="currentColor">${shape}</svg>${esc(word)}</span>`;
}
const RUNNING = '<circle cx="8" cy="8" r="5"/>';
const STOPPED = '<circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>';

function loginBox(p, csrf) {
  if (!p) return "";
  const exp = new Date(p.expires_at * 1000);
  const until = Number.isFinite(exp.getTime())
    ? exp.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" })
    : "";
  return `<div class="gpt-login" id="gpt-login" data-login-pending>
    <h3>Finish the sign-in</h3>
    <ol class="gpt-steps">
      <li>Open <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a> and sign in to ChatGPT.</li>
      <li>Enter this one-time code: <span class="gpt-code-row"><code class="gpt-code" id="gpt-code">${esc(p.code)}</code><button type="button" class="btn small" id="gpt-copy" data-copy="${esc(p.code)}" hidden>Copy code</button></span></li>
      <li>Come back here. This page notices when you are done.</li>
    </ol>
    <p class="gpt-wait" id="gpt-login-state" role="status" aria-live="polite">Waiting for you to enter the code${until ? ` · the code works until <time datetime="${esc(exp.toISOString())}" data-local data-time-only>${esc(until)}</time>` : ""}.</p>
    <div class="acts"><form method="post" action="/mint-ai/settings/chatgpt/login/cancel" class="set-form"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn small">Cancel sign-in</button></form></div>
  </div>`;
}

async function render(req, res, deps) {
  const P = priv(deps);
  const csrf = res.locals.csrf;
  const [st, calls, agents] = await Promise.all([
    P.chatgptStatus().catch((e) => ({ _error: e.message })),
    P.chatgptCalls(100).then((r) => (r && r.calls) || []).catch(() => null),
    P.agentList().catch(() => null),
  ]);
  const names = {};
  (agents || []).forEach((a) => (names[a.slug] = a.name || a.slug));

  // The sign-in in progress: re-read so a reload shows the current state.
  let p = pending;
  if (p && Date.now() / 1000 >= p.expires_at) p = pending = null;

  /* ---- sign-in ---- */
  let signIn;
  if (st._error) {
    signIn = V.row("ChatGPT account", `The server could not say: ${esc(st._error)}`, chip("Unknown", "off", STOPPED), { id: "gpt-account" });
  } else {
    const [word, tone, shape] = LOGIN_WORDS[st.login] || LOGIN_WORDS.signed_out;
    const help =
      st.login === "signed_in"
        ? `Agents use this one sign-in${st.account ? ` (${esc(st.account)})` : ""}. It lives only on the server, in the account that runs ChatGPT; this page never sees it.`
        : st.login === "expired"
        ? "ChatGPT asked to sign in again. Until you do, every agent that asks gets “sign-in expired”."
        : "Nobody is signed in, so agents that ask get “not signed in”.";
    const button = `<form method="post" action="/mint-ai/settings/chatgpt/login" class="set-form" data-step-up data-confirm-dlg="Sign ChatGPT in again?" data-confirm-body="The server starts a new sign-in and this page shows a link and a one-time code to enter on OpenAI's page. The current sign-in keeps working until the new one is done." data-confirm-yes="Start sign-in" data-confirm-danger="0"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn${st.login === "signed_in" ? "" : " primary"}">${icon("user", 16)}${st.login === "signed_out" ? "Sign in" : "Sign in again"}</button></form>`;
    signIn =
      V.row("ChatGPT account", p ? "A new sign-in is waiting for you below. Until it is done, agents keep using the current one." : help, p ? chip("Waiting for sign-in", "warn", '<path d="M8 3a5 5 0 0 1 0 10Z"/><circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>') : `${chip(word, tone, shape)}${button}`, { id: "gpt-account" }) +
      (p ? `<div class="row full">${loginBox(p, csrf)}</div>` : "");
  }

  /* ---- service ---- */
  let service;
  if (st._error) {
    service = V.row("Broker", "No answer from the server's helper.", chip("Unknown", "off", STOPPED));
  } else {
    const up = st.service === "active";
    const now = st.answering
      ? `${st.running == null ? "—" : st.running} running · ${st.queued == null ? "—" : st.queued} waiting`
      : up
      ? "Running, but not answering"
      : "—";
    service =
      V.row("Broker", "mint-chatgpt.service: the one process that runs ChatGPT for every agent.", up ? chip("Running", "ok", RUNNING) : chip(st.service === "unknown" ? "Unknown" : "Stopped", "bad", '<path d="M8 2.5 14 13H2Z"/>'), { id: "gpt-service" }) +
      V.row("Right now", "Tasks ChatGPT is working on, and tasks waiting for a free slot.", `<span class="muted-num">${esc(now)}</span>`) +
      V.row(
        "Limits",
        "Set in /etc/mint-chatgpt/config.json, changed with a deploy.",
        `<span class="muted-num">${esc(st.max_running)} at a time · ${esc(st.max_queued)} waiting · ${esc(Math.round(st.timeout_s / 60))} min per task</span> <span class="tag-s ro">config</span>`
      );
  }

  /* ---- who may use it ---- */
  const agentRows = (agents || [])
    .map((a) => {
      const on = a.chatgpt !== false;
      const st2 = (a.state && a.state.active) || "inactive";
      return V.row(
        `${esc(a.name || a.slug)}`,
        `Telegram agent <span class="mono">${esc(a.slug)}</span> · ${st2 === "active" ? "running: a change applies when it next restarts" : "not running: a change applies when it starts"}`,
        V.form("/mint-ai/settings/chatgpt/agent", csrf, `<input type="hidden" name="slug" value="${esc(a.slug)}"><input type="hidden" name="on" value="0">${V.sw(`name="on" value="1" aria-label="ChatGPT for ${esc(a.name || a.slug)}"`, on, "On", "Off")}`),
        { id: "gpt-agent-" + a.slug }
      );
    })
    .join("");
  const who =
    V.row("MINT AI", "MINT AI, the sessions it hires and console chats. Always on: they use ChatGPT only when you ask them to.", `<span class="tag-s">Always on</span>`, { id: "gpt-mint-ai" }) +
    (agents === null ? V.row("Telegram agents", "The agent list could not be read.", "") : agentRows || V.row("Telegram agents", "No Telegram agents yet.", ""));

  /* ---- recent calls ---- */
  let callsHtml;
  if (calls === null) callsHtml = `<div class="lr"><span class="d">The call log could not be read.</span></div>`;
  else if (!calls.length) callsHtml = `<div class="lr"><span class="d">No calls yet. When an agent asks ChatGPT something, it shows here: who asked, when, how long it took and how it went. Never what was asked.</span></div>`;
  else
    callsHtml = `<table class="ds-table gpt-calls"><caption class="sr">Recent ChatGPT calls, newest first</caption>
      <thead><tr><th scope="col">When</th><th scope="col">Who asked</th><th scope="col" class="num">Took</th><th scope="col">Outcome</th><th scope="col" class="num">Files back</th></tr></thead>
      <tbody>${calls
        .map((c) => {
          const [nm, kind] = callerOf(c.caller, names);
          const out = c.ok ? chip("Answered", "ok", RUNNING) : `${chip("Failed", "bad", '<path d="M8 2.5 14 13H2Z"/>')}${c.error || c.kind ? `<span class="sub">${esc(c.error || c.kind)}</span>` : ""}`;
          return `<tr><td data-h="When">${when(c.ts)}</td><td data-h="Who asked"><span>${esc(nm)}</span>${kind ? `<span class="sub">${esc(kind)}</span>` : ""}</td><td data-h="Took" class="num">${esc(took(c.seconds))}</td><td data-h="Outcome">${out}</td><td data-h="Files back" class="num">${esc(c.out_files || 0)}</td></tr>`;
        })
        .join("")}</tbody></table>`;

  const body =
    V.head(
      "ChatGPT",
      "Every agent can hand a task to ChatGPT when you ask it to (“ask ChatGPT…”). They share one ChatGPT sign-in on this server. What they ask and what comes back is never stored here."
    ) +
    V.group("Sign-in", "user", signIn, { id: "gpt-signin" }) +
    V.group("Service", "services", service, { id: "gpt-svc" }) +
    V.group("Who may use it", "agents", who, { id: "gpt-who" }) +
    V.group("Recent calls", "activity", callsHtml, { id: "gpt-calls", aside: calls && calls.length ? `last ${calls.length}, newest first` : "" });
  return { body, assets: ["chatgpt-settings.js"], status: {} };
}

function install(sections) {
  sections.chatgpt = render;
}

function mount(app, deps, { guard, reply, audit }) {
  const { requireAuth, requireCsrf } = deps;
  const P = () => priv(deps);

  // Sign in again: a fresh proof first (Windows Hello or the code), like resuming past a cap.
  const loginStepUp = require("./stepup").requireStepUp({
    bind: () => "chatgpt-login",
    what: () => "Sign ChatGPT in again",
    audit: deps.stepAudit,
    html: (req, res, msg) => reply(req, res, "chatgpt", { err: msg + " (Windows Hello needs JavaScript on this page.)", anchor: "gpt-account" }),
  });
  app.post("/mint-ai/settings/chatgpt/login", requireAuth, guard("chatgpt"), requireCsrf, loginStepUp, async (req, res) => {
    try {
      const r = await P().chatgptLoginStart();
      if (!r || !/^[0-9a-f]{16}$/.test(r.id) || !/^https:\/\//.test(r.url || "") || !r.code) throw new Error("the sign-in did not hand out a code");
      pending = { id: r.id, url: String(r.url), code: String(r.code), expires_at: Number(r.expires_at) || Math.floor(Date.now() / 1000) + 900, by: req.me.username };
      audit(req, "started a ChatGPT sign-in" + (deps.steppedWith ? deps.steppedWith(req) : ""));
      reply(req, res, "chatgpt", { msg: "Sign-in started. Open the link below and enter the code.", anchor: "gpt-account", reload: true });
    } catch (e) {
      reply(req, res, "chatgpt", { err: "The sign-in did not start: " + e.message, anchor: "gpt-account" });
    }
  });

  // Cancel the sign-in that waits: the helper stops the CLI; the old sign-in is untouched.
  app.post("/mint-ai/settings/chatgpt/login/cancel", requireAuth, guard("chatgpt"), requireCsrf, async (req, res) => {
    const p = pending;
    pending = null;
    if (p) {
      try {
        await P().chatgptLoginCancel(p.id);
      } catch (_) {
        /* it may have finished on its own; nothing waits any more either way */
      }
      audit(req, "cancelled a ChatGPT sign-in");
    }
    reply(req, res, "chatgpt", { msg: "Sign-in cancelled. The current sign-in is unchanged.", anchor: "gpt-account", reload: true });
  });

  // The page polls this while a sign-in waits (public/chatgpt-settings.js).
  app.get("/mint-ai/settings/chatgpt/login/state", requireAuth, guard("chatgpt"), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const p = pending;
    if (!p) return res.json({ ok: true, state: "none" });
    try {
      const r = await P().chatgptLoginPoll(p.id);
      const state = ["pending", "done", "failed", "expired"].includes(r.state) ? r.state : "failed";
      if (state !== "pending") {
        pending = null;
        audit(req, "ChatGPT sign-in " + state);
      }
      res.json({ ok: true, state, message: String(r.message || "").slice(0, 200), expires_at: p.expires_at });
    } catch (e) {
      pending = null;
      res.json({ ok: true, state: "failed", message: String(e.message || "The sign-in could not be checked.").slice(0, 200) });
    }
  });

  // One Telegram agent's switch.
  app.post("/mint-ai/settings/chatgpt/agent", requireAuth, guard("chatgpt"), requireCsrf, async (req, res) => {
    const slug = String(req.body.slug || "");
    if (!SLUG_RE.test(slug)) return reply(req, res, "chatgpt", { err: "No such agent." });
    const vals = [].concat(req.body.on == null ? [] : req.body.on);
    const on = vals.includes("1") || vals.includes("on");
    try {
      const r = await P().agentChatgpt(slug, on);
      audit(req, `ChatGPT ${on ? "on" : "off"} for agent ${slug}`);
      const when = r && r.restart_needed ? "It is running, so this applies when it next restarts (Telegram agents ▸ Restart)." : "It applies when the agent starts.";
      reply(req, res, "chatgpt", { msg: `ChatGPT is ${on ? "on" : "off"} for ${slug}. ${when}`, anchor: "gpt-agent-" + slug });
    } catch (e) {
      reply(req, res, "chatgpt", { err: "Not changed: " + e.message, anchor: "gpt-agent-" + slug });
    }
  });
}

module.exports = { install, mount, render, callerOf, took, _reset: () => (pending = null) };
