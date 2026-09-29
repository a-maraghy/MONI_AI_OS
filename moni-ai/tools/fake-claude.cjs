#!/usr/bin/env node
/**
 * A stand-in for the claude CLI, for tools/test-supervisor.cjs.
 *
 * Speaks just enough of the stream-json protocol to exercise the supervisor
 * without a model, a network or a bill: initialize, remote_control, interrupt,
 * user turns with command_lifecycle events and replays, a can_use_tool
 * permission request, and `agents --json` / `--version`.
 *
 * Magic words in a user message:
 *   DESTROY   asks permission for `rm /tmp/moni-fake-victim`, then reports
 *             whether it was allowed or denied (and with what message)
 *   DELEGATE  "sends" a message to fake-target: posts the PostToolUse event to
 *             the hook socket the way hooks/ledger.js would, then a reply and
 *             an idle notice as UserPromptSubmit events
 *   SLOW <ms> takes that long (up to 30 s) before answering "slow done"
 *   RUN <cmd> asks permission to run <cmd> with Bash (rules may answer it)
 *   MISSION2  creates a two-step mission over the control socket (as the MCP
 *             server would) and delegates both steps, tagged, to fake-target
 *   a turn starting "[Watcher: … decision #N]" proposes a fix for decision N;
 *   "[Decision #N approved" asks to run the fix, then reports it done;
 *   "[Standing order: …" answers with a short briefing
 *   anything else is echoed back
 *
 * Each result carries total_cost_usd as the process's running total (+0.01 a
 * turn), the way the real CLI reports it.
 */
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const args = process.argv.slice(2);
const home = process.env.HOME || "/tmp";

if (args[0] === "--version") {
  console.log((process.env.FAKE_VERSION || "2.1.283") + " (Claude Code)");
  process.exit(0);
}
if (args[0] === "agents") {
  const file = path.join(home, "fake-agents.json");
  let list = [{ pid: process.ppid, sessionId: "fake-target-session", name: "fake-target", cwd: "/tmp", kind: "interactive", status: "idle", startedAt: Date.now() }];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* default */
  }
  console.log(JSON.stringify(list));
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const sessionId = flag("--session-id") || flag("--resume") || crypto.randomUUID();
fs.appendFileSync(path.join(home, "fake-argv.log"), JSON.stringify(args) + "\n");
// A real CLI writes its transcript under projects/; the supervisor checks for
// it to decide between --session-id and --resume.
fs.mkdirSync(path.join(home, ".claude", "projects", "-fake"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "projects", "-fake", sessionId + ".jsonl"), "{}\n");

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map(); // request_id -> resolve
let busy = Promise.resolve();

function hookPost(msg) {
  return new Promise((resolve) => {
    const s = net.createConnection(process.env.MONI_AI_HOOK_SOCKET, () => s.end(JSON.stringify({ session_id: sessionId, ...msg }) + "\n"));
    s.on("close", resolve);
    s.on("error", resolve);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let runningCost = 0;

/** One call to the supervisor's control socket, as MINT AI's MCP server makes it. */
function ctl(op, params) {
  return new Promise((resolve) => {
    const s = net.createConnection(process.env.MONI_AI_SOCKET);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", (e) => resolve({ ok: false, error: e.message }));
    s.on("connect", () => s.write(JSON.stringify({ id: "fake", op, actor: "moni-ai", ...params }) + "\n"));
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

async function askTool(name, input) {
  const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] }, session_id: sessionId });
  const rid = crypto.randomUUID();
  const answer = new Promise((resolve) => waiting.set(rid, resolve));
  out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: name, input, decision_reason: "fake ask", decision_reason_type: "hook", tool_use_id: toolUseId } });
  const resp = await answer;
  const allowed = resp.behavior === "allow";
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: allowed ? "ok" : resp.message, is_error: !allowed }] }, session_id: sessionId });
  return { allowed, resp };
}

async function delegate(message) {
  const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
  const input = { to: "fake-target [abc123]", message, notify_when_idle: true };
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input }] }, session_id: sessionId });
  const msgId = crypto.randomUUID();
  await hookPost({ event: "PostToolUse", tool_name: "SendMessage", tool_input: input, tool_use_id: toolUseId, tool_response: { success: true, message: "queued", msg_id: msgId } });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ success: true, msg_id: msgId }) }] }, session_id: sessionId });
  return msgId;
}

async function turn(msg) {
  const uuid = msg.uuid || crypto.randomUUID();
  const text = typeof msg.message.content === "string" ? msg.message.content : "";
  out({ type: "command_lifecycle", command_uuid: uuid, state: "queued", session_id: sessionId });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "started", session_id: sessionId });
  out({ type: "user", message: { role: "user", content: text }, uuid, isReplay: true, session_id: sessionId });

  let reply = "echo: " + text;
  const watcher = /^\[Watcher: [^\n]*decision #(\d+)\]/.exec(text);
  const approvedFix = /^\[Decision #(\d+) approved/.exec(text);
  if (watcher) {
    const r = await ctl("decision-propose", { decision_id: Number(watcher[1]), summary: "The unit crashed on a transient network timeout; restarting it should clear it.", evidence: "fake: Main process exited, status=1/FAILURE", fix_command: "systemctl restart moni-e2e-fake.service" });
    reply = r.ok ? "Proposed a fix for decision #" + watcher[1] : "propose failed: " + r.error;
  } else if (approvedFix) {
    const cmd = (/```\n([\s\S]*?)\n```/.exec(text) || [])[1] || "true";
    const { allowed, resp } = await askTool("Bash", { command: cmd, description: "run the approved fix" });
    await ctl("decision-update", { decision_id: Number(approvedFix[1]), status: allowed ? "done" : "failed", result: allowed ? "fix ran" : "the gate denied it: " + resp.message });
    reply = allowed ? "Fix ran." : "denied: " + resp.message;
  } else if (text.startsWith("[Standing order:")) {
    reply = "**Services** all 12 up\n**Disk** 6%\n**Needs you** nothing";
  } else if (/^SLOW (\d+)/.test(text)) {
    await sleep(Math.min(Number(/^SLOW (\d+)/.exec(text)[1]), 30000));
    reply = "slow done";
  } else if (/^RUN /.test(text)) {
    const { allowed, resp } = await askTool("Bash", { command: text.slice(4).split("\n")[0], description: "test" });
    reply = allowed ? "allowed" : "denied: " + resp.message;
  } else if (text.includes("MISSION2")) {
    const r = await ctl("mission-create", { title: "Two-step test mission", goal: "Prove missions work end to end", steps: [{ title: "Run the tests", target: "fake-target" }, { title: "Report the count", target: "fake-target" }] });
    if (!r.ok) reply = "mission-create failed: " + r.error;
    else {
      const ref = r.data.mission.ref;
      for (const n of [1, 2]) {
        await delegate(`${ref} step ${n}: please do step ${n}.`);
        await sleep(200);
        await hookPost({ event: "UserPromptSubmit", prompt: `<cross-session-message from="uds:/run/user/0/cc-socks/${process.ppid}.sock" from-name="fake-target" from-mode="prompting">\nstep ${n} done\n</cross-session-message>` });
        await sleep(200);
        await hookPost({ event: "UserPromptSubmit", prompt: `[Cross-session idle notice] "fake-target", which you asked to be notified about, is idle now — it finished a turn at 14:05. Its harness reports: «Done.». This is an automated notice.` });
        await sleep(200);
      }
      reply = "mission " + ref + " delegated";
    }
  } else if (text.includes("DESTROY")) {
    const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
    const input = { command: "rm /tmp/moni-fake-victim", description: "delete the victim" };
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input }] }, session_id: sessionId });
    const rid = crypto.randomUUID();
    const answer = new Promise((resolve) => waiting.set(rid, resolve));
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Bash", input, decision_reason: "MINT AI gate · Deletes files or records: rm /tmp/moni-fake-victim", decision_reason_type: "hook", tool_use_id: toolUseId } });
    const resp = await answer;
    const allowed = resp.behavior === "allow";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: allowed ? "removed" : resp.message, is_error: !allowed }] }, session_id: sessionId });
    reply = allowed ? "allowed" : "denied: " + resp.message;
  } else if (text.includes("DELEGATE")) {
    const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
    const input = { to: "fake-target [abc123]", message: "Please run the tests and report.", notify_when_idle: true };
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input }] }, session_id: sessionId });
    const msgId = crypto.randomUUID();
    await hookPost({ event: "PostToolUse", tool_name: "SendMessage", tool_input: input, tool_use_id: toolUseId, tool_response: { success: true, message: "queued", msg_id: msgId } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ success: true, msg_id: msgId }) }] }, session_id: sessionId });
    reply = "sent " + msgId;
    setTimeout(async () => {
      await hookPost({ event: "UserPromptSubmit", prompt: `<cross-session-message from="uds:/run/user/0/cc-socks/${process.ppid}.sock" from-name="fake-target" from-mode="prompting">\n42 passed\n</cross-session-message>` });
      await sleep(300);
      await hookPost({ event: "UserPromptSubmit", prompt: `[Cross-session idle notice] "fake-target", which you asked to be notified about, is idle now — it finished a turn at 14:05. Its harness reports: «Done. 42 passed.». This is an automated notice.` });
    }, 400);
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] }, session_id: sessionId });
  runningCost = Math.round((runningCost + 0.01) * 100) / 100;
  out({ type: "result", subtype: "success", is_error: false, result: reply, duration_ms: 5, total_cost_usd: runningCost, session_id: sessionId });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "completed", session_id: sessionId });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (msg.type === "control_request") {
    const r = msg.request || {};
    if (r.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [] } } });
      out({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model"), permissionMode: flag("--permission-mode"), claude_code_version: "2.1.283", tools: ["Bash", "mcp__moni-ai__status_snapshot", "mcp__memory__memory_search"], mcp_servers: [{ name: "moni-ai", status: "connected" }, { name: "memory", status: "connected" }] });
    } else if (r.subtype === "remote_control") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: r.enabled ? { session_url: "https://claude.ai/code/session_FAKE", bridge_session_id: "session_FAKE" } : {} } });
    } else if (r.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    } else {
      out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unknown" } });
    }
    return;
  }
  if (msg.type === "control_response") {
    const resp = msg.response || {};
    const w = waiting.get(resp.request_id);
    if (w) {
      waiting.delete(resp.request_id);
      w(resp.response || {});
    }
    return;
  }
  if (msg.type === "user") busy = busy.then(() => turn(msg));
});
rl.on("close", () => busy.then(() => process.exit(0)));
