/**
 * The supervisor end to end, against a fake claude (tools/fake-claude.cjs).
 *
 *     sudo node moni-ai/tools/test-supervisor.cjs
 *
 * Runs a real supervisor.js in a scratch directory -- its own config, state,
 * socket and Claude home -- so nothing of the live service is touched and no
 * model is called. Checks the socket protocol over a real socket, a turn from
 * send to result, the approval flow (deny, approve, timeout, double answer),
 * the ledger's delegation states, the audit trail, restart-then-resume, the
 * single-instance lock, and the refusal to start while another process holds
 * the session id.
 *
 * Needs root: the supervisor refuses to run as anyone else.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moni-ai-test-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
const fake = path.join(__dirname, "fake-claude.cjs");
fs.chmodSync(fake, 0o755);
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
    cli: fake,
    cli_version: "2.1.283",
    cwd: tmp,
    home,
    runtime_dir: "",
    state_dir: path.join(tmp, "state"),
    log_dir: path.join(tmp, "log"),
    run_dir: path.join(tmp, "run"),
    socket_group: "root",
    approval_timeout_s: 3,
    sessions_poll_s: 1,
    backoff_min_s: 1,
    backoff_max_s: 2,
  })
);
const SOCK = path.join(tmp, "run", "moni-ai.sock");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSupervisor() {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], {
    env: { ...process.env, MONI_AI_CONFIG: cfgFile, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}

let n = 0;
function call(op, params = {}, actor = "tester") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify({ id: "t" + ++n, op, actor, ...params }) + "\n"));
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}
function raw(line) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(line + "\n"));
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}

/** Subscribe to events; returns { events, waitFor(pred, ms), close() }. */
function subscribe(since = 0) {
  const events = [];
  const waiters = [];
  const s = net.createConnection(SOCK);
  let buf = "";
  s.setEncoding("utf8");
  s.on("connect", () => s.write(JSON.stringify({ id: "sub", op: "events", actor: "tester", since }) + "\n"));
  s.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.event) {
        events.push(m.event);
        for (const w of waiters.slice()) if (w.pred(m.event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m.event);
        }
      }
    }
  });
  return {
    events,
    waitFor(pred, ms = 8000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) {
            waiters.splice(i, 1);
            resolve(null);
          }
        }, ms);
      });
    },
    close: () => s.destroy(),
  };
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* not yet */
    }
    await sleep(150);
  }
  return null;
}

(async () => {
  if (process.getuid() !== 0) {
    console.log("needs root (the supervisor refuses to run as anyone else)");
    process.exit(2);
  }
  const sup = startSupervisor();
  try {
    const ready = await until(async () => {
      const r = await call("status");
      return r.ok && r.data.process.state === "ready" && r.data.remote_control.enabled ? r : null;
    });
    check("supervisor comes up and the process is ready", !!ready, sup.logs);
    if (!ready) throw new Error("not ready");
    check("the pinned CLI version is checked", ready.data.process.cli_version === "2.1.283");
    check("socket is 0660", (fs.statSync(SOCK).mode & 0o777) === 0o660);
    const argv0 = JSON.parse(fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n")[0]);
    check("first start uses --session-id, not --resume", argv0.includes("--session-id") && !argv0.includes("--resume"));
    check("runs with --permission-prompt-tool stdio", argv0.join(" ").includes("--permission-prompt-tool stdio"));
    check("runs in auto mode with the configured model", argv0.join(" ").includes("--permission-mode auto") && argv0.join(" ").includes("--model claude-opus-5-5"));
    check("replays user messages (peer turns are visible)", argv0.includes("--replay-user-messages"));
    const rcu = await call("rc-url");
    check("remote control was switched on and its URL is served", rcu.ok && rcu.data.enabled && /session_FAKE/.test(rcu.data.url));

    // --- validation over the real socket
    const bad = await raw("not json");
    check("socket: refuses non-JSON", !bad.ok && /JSON/.test(bad.error));
    const noActor = await raw(JSON.stringify({ id: "x", op: "status" }));
    check("socket: refuses a request without an actor", !noActor.ok && /actor/.test(noActor.error));
    const extra = await raw(JSON.stringify({ id: "x", op: "send", actor: "a", text: "hi", shell: "rm -rf /" }));
    check("socket: refuses an unexpected field", !extra.ok && /unexpected/.test(extra.error));
    const unknown = await call("exec", {});
    check("socket: refuses an unknown op", !unknown.ok && /unknown op/.test(unknown.error));
    const ghost = await call("send", { text: "hi", target: "no-such-session" });
    check("socket: refuses a target that is not a live session", !ghost.ok && /no live session/.test(ghost.error));

    const sub = subscribe(0);

    // --- a plain turn
    const sent = await call("send", { text: "hello there" });
    check("send is accepted and queued", sent.ok && sent.data.turn.status === "queued" && sent.data.turn.actor === "tester");
    const echo = await sub.waitFor((e) => e.type === "assistant" && e.text === "echo: hello there");
    check("the reply streams back as an event", !!echo);
    const ended = await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === sent.data.turn.id);
    check("the turn ends done", ended && ended.turn.status === "done", JSON.stringify(ended));

    // --- approval: deny
    await call("send", { text: "DESTROY one" });
    const ap1 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending");
    check("a destructive call raises an approval card", ap1 && ap1.approval.tool === "Bash" && /rm \/tmp\/moni-fake-victim/.test(ap1.approval.summary), JSON.stringify(ap1));
    check("the card carries the gate's category", ap1 && ap1.approval.category === "delete");
    check("the card has an expiry", ap1 && Date.parse(ap1.approval.expires_at) > Date.now());
    const st1 = await call("status");
    check("status lists the pending approval", st1.data.approvals.some((a) => a.id === ap1.approval.id));
    check("status shows the step waiting", st1.data.current_turn && st1.data.current_turn.steps.some((s) => s.st === "wait"));
    const d1 = await call("deny", { approval_id: ap1.approval.id, note: "not today" }, "amaraghy");
    check("deny is accepted", d1.ok && d1.data.approval.status === "denied" && d1.data.approval.decided_by === "amaraghy");
    const denied = await sub.waitFor((e) => e.type === "assistant" && /^denied:/.test(e.text));
    check("the model is told who denied it and not to retry", denied && /Denied by amaraghy/.test(denied.text) && /not today/.test(denied.text) && /Do not retry/.test(denied.text), denied && denied.text);
    const again = await call("approve", { approval_id: ap1.approval.id });
    check("an answered approval cannot be answered again", !again.ok && /already denied/.test(again.error));

    // --- approval: approve
    await call("send", { text: "DESTROY two" });
    const ap2 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.id !== ap1.approval.id);
    const a2 = await call("approve", { approval_id: ap2.approval.id }, "amaraghy");
    check("approve is accepted", a2.ok && a2.data.approval.status === "approved");
    check("the model is allowed to proceed", !!(await sub.waitFor((e) => e.type === "assistant" && e.text === "allowed")));

    // --- approval: nobody answers
    await call("send", { text: "DESTROY three" });
    const ap3 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.id > ap2.approval.id);
    const exp = await sub.waitFor((e) => e.type === "approval" && e.approval.id === ap3.approval.id && e.approval.status === "expired", 8000);
    check("an unanswered approval expires", !!exp);
    const timedOut = await sub.waitFor((e) => e.type === "assistant" && /denied by default/.test(e.text));
    check("an expired approval is a denial", !!timedOut);

    // --- a delegation through the ledger hooks
    await call("send", { text: "DELEGATE please" });
    const dSent = await sub.waitFor((e) => e.type === "delegation" && e.delegation.status === "sent");
    check("delegation recorded as sent with its msg_id", dSent && dSent.delegation.msg_id && dSent.delegation.target_name === "fake-target" && dSent.delegation.notify_idle === 1, JSON.stringify(dSent));
    const dAck = await sub.waitFor((e) => e.type === "delegation" && e.delegation.id === dSent.delegation.id && e.delegation.status === "ack");
    check("the reply moves it to ack with the reply text", dAck && /42 passed/.test(dAck.delegation.reply_text));
    const dDone = await sub.waitFor((e) => e.type === "delegation" && e.delegation.id === dSent.delegation.id && e.delegation.status === "done");
    check("it ends done", !!dDone);
    const inb = await call("ledger", { table: "inbound" });
    check("the reply is in the inbound ledger, linked to the delegation", inb.ok && inb.data.rows.some((r) => r.kind === "message" && r.delegation_id === dSent.delegation.id));
    const sess = await call("sessions");
    check("sessions merge the ledger", sess.ok && sess.data.sessions.some((s) => s.name === "fake-target" && s.last_delegation && s.last_delegation.id === dSent.delegation.id));

    // --- sub-agents: a Task/Agent tool run shows up under its parent session,
    // and drops off once it is no longer running (end_turn, or gone stale).
    const subDir = path.join(home, ".claude", "projects", "-fake", "fake-target-session", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "agent-test1.jsonl"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }) + "\n"
    );
    fs.writeFileSync(path.join(subDir, "agent-test1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Run the fake test suite", requestShape: "background" }));
    const withAgent = await until(async () => {
      const s = await call("sessions");
      const t = s.data.sessions.find((x) => x.session_id === "fake-target-session");
      return t && t.subagents && t.subagents.length ? t : null;
    }, 5000);
    check(
      "a running sub-agent appears under its parent session",
      !!withAgent && withAgent.subagents[0].id === "test1" && withAgent.subagents[0].description === "Run the fake test suite" && withAgent.subagents[0].status === "running",
      withAgent && JSON.stringify(withAgent.subagents)
    );
    fs.writeFileSync(
      path.join(subDir, "agent-test1.jsonl"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n"
    );
    const gone = await until(async () => {
      const s = await call("sessions");
      const t = s.data.sessions.find((x) => x.session_id === "fake-target-session");
      return t && (!t.subagents || !t.subagents.length) ? true : null;
    }, 5000);
    check("it drops off the session once it finishes (end_turn)", !!gone);

    // --- audit
    const audit = await call("ledger", { table: "audit", limit: 100 });
    const ops = audit.data.rows.map((r) => r.op + ":" + r.actor);
    check("sends are audited with the panel user", ops.includes("send:tester"));
    check("denials and approvals are audited with who answered", ops.includes("deny:amaraghy") && ops.includes("approve:amaraghy"));
    check("refused actions are audited too", audit.data.rows.some((r) => r.op === "approve" && r.ok === 0));
    check("read-only calls are not audited", !ops.some((o) => o.startsWith("status:")));
    const auditFile = fs.readFileSync(path.join(tmp, "log", "audit.log"), "utf8");
    check("the audit log file is written", /op=deny/.test(auditFile) && /actor=amaraghy/.test(auditFile));
    const turnsL = await call("ledger", { table: "turns" });
    check("turns ledger records source and actor", turnsL.data.rows.some((t) => t.source === "dashboard" && t.actor === "tester" && t.status === "done"));

    // --- restart resumes, only after the old process exits
    const rs = await call("restart", {}, "amaraghy");
    check("restart is accepted", rs.ok, rs.error);
    await until(async () => (await call("status")).data.process.state === "ready");
    const argvs = fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("the restarted process resumes the same session id", argvs.length >= 2 && argvs[argvs.length - 1].includes("--resume") && argvs[argvs.length - 1].includes(argv0[argv0.indexOf("--session-id") + 1]));

    // --- single instance
    const second = startSupervisor();
    const code = await new Promise((r) => second.on("exit", r));
    check("a second supervisor refuses to start", code !== 0 && /another supervisor/.test(second.logs), second.logs);

    // --- never resume a session someone else holds
    const sid = JSON.parse(fs.readFileSync(path.join(tmp, "state", "state.json"), "utf8")).session_id;
    const holder = spawn("sleep", ["60"]);
    fs.writeFileSync(path.join(home, ".claude", "sessions", holder.pid + ".json"), JSON.stringify({ pid: holder.pid, sessionId: sid }));
    await call("restart", {}, "amaraghy");
    const blocked = await until(async () => {
      const s = await call("status");
      return s.data.process.state === "blocked" ? s : null;
    }, 8000);
    check("will not start while another process holds the session id", !!blocked && /held by pid/.test(blocked.data.process.error), blocked && blocked.data.process.error);
    holder.kill();
    fs.unlinkSync(path.join(home, ".claude", "sessions", holder.pid + ".json"));
    const recovered = await until(async () => (await call("status")).data.process.state === "ready", 15000);
    check("and starts once the holder is gone", !!recovered);

    sub.close();
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    sup.kill("SIGTERM");
    const code = await new Promise((r) => {
      sup.on("exit", r);
      setTimeout(() => r("timeout"), 25000);
    });
    check("SIGTERM stops it cleanly", code === 0, "exit " + code + "\n" + sup.logs.slice(-800));
    check("and removes its socket", !fs.existsSync(SOCK));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
