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
 *   anything else is echoed back
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

async function turn(msg) {
  const uuid = msg.uuid || crypto.randomUUID();
  const text = typeof msg.message.content === "string" ? msg.message.content : "";
  out({ type: "command_lifecycle", command_uuid: uuid, state: "queued", session_id: sessionId });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "started", session_id: sessionId });
  out({ type: "user", message: { role: "user", content: text }, uuid, isReplay: true, session_id: sessionId });

  let reply = "echo: " + text;
  if (text.includes("DESTROY")) {
    const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
    const input = { command: "rm /tmp/moni-fake-victim", description: "delete the victim" };
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input }] }, session_id: sessionId });
    const rid = crypto.randomUUID();
    const answer = new Promise((resolve) => waiting.set(rid, resolve));
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Bash", input, decision_reason: "MONI AI gate · Deletes files or records: rm /tmp/moni-fake-victim", decision_reason_type: "hook", tool_use_id: toolUseId } });
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
  out({ type: "result", subtype: "success", is_error: false, result: reply, duration_ms: 5, total_cost_usd: 0, session_id: sessionId });
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
      out({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model"), permissionMode: flag("--permission-mode"), claude_code_version: "2.1.283", tools: ["Bash"] });
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
