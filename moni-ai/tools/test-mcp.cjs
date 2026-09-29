/**
 * MINT AI's MCP server (bin/moni-ai-mcp): the status_snapshot tool.
 *
 *     node moni-ai/tools/test-mcp.cjs
 *
 * Runs the server's message handler against a stand-in control socket, so no
 * supervisor is needed: the tool is listed, takes no arguments, asks for the
 * read-only `snapshot` op as actor moni-ai with nothing else, and hands back
 * the snapshot without forbidden keys or the voice desk's own requests. Then
 * the real buildSnapshot is fed secrets and commands to prove none come out.
 */
"use strict";
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moni-ai-mcp-"));
const SOCK = path.join(tmp, "ctl.sock");
process.env.MONI_AI_SOCKET = SOCK;

const mcp = require(path.join(__dirname, "..", "bin", "moni-ai-mcp"));
const { buildSnapshot, FORBIDDEN_KEYS } = require(path.join(__dirname, "..", "lib", "snapshot.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}

/** Run one JSON-RPC message through the server, capturing what it writes. */
async function rpc(msg) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(String(s));
    return true;
  };
  try {
    await mcp.onMessage(msg);
  } finally {
    process.stdout.write = orig;
  }
  return lines.length ? JSON.parse(lines[0]) : null;
}

function hasKeyDeep(v, keys) {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, keys));
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => keys.includes(k) || hasKeyDeep(x, keys));
}

(async () => {
  // A stand-in supervisor: records each request and answers with `reply`.
  const seen = [];
  let reply = null;
  const server = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      seen.push(req);
      s.end(JSON.stringify({ id: req.id, ok: true, data: reply }) + "\n");
    });
  });
  await new Promise((r) => server.listen(SOCK, r));

  try {
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = list.result.tools.find((t) => t.name === "status_snapshot");
    check("status_snapshot is listed", !!tool);
    check("it takes no arguments (empty schema, no extras)", tool && Object.keys(tool.inputSchema.properties).length === 0 && tool.inputSchema.additionalProperties === false);
    check("its description says to use it first for status", tool && /FIRST for any status question/.test(tool.description));
    check("the old tools are still there", ["mission_create", "decision_propose", "decision_update"].every((n) => list.result.tools.some((t) => t.name === n)));

    // An argument is refused before anything reaches the supervisor.
    const refused = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status_snapshot", arguments: { turns: [1, 2] } } });
    check("an argument is refused", refused.result.isError && /takes no arguments/.test(refused.result.content[0].text), JSON.stringify(refused));
    check("and nothing was sent to the supervisor", seen.length === 0);

    // The call itself: exactly the read-only op, as moni-ai, with no params.
    reply = {
      taken_at: "2026-09-29T12:00:00Z",
      machine: { host: "vmi", disk: { used_percent: 6, free_gb: 300.1 } },
      services: { tracked: 2, running: 1, failed: ["x.service"], list: [] },
      approvals: { pending: 1, titles: ["Deletes files (Bash)"], command: "rm -rf /secret" },
      decisions: { open: 1, titles: [{ title: "Disk", status: "open", evidence: "LEAK", fix_command: "rm LEAK" }] },
      requests_to_moni_ai: [{ id: 9, reply: "the desk's own" }],
      token: "sk-should-never-show",
    };
    const ok = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status_snapshot", arguments: {} } });
    check("the call succeeds", ok && !ok.result.isError, JSON.stringify(ok));
    const req = seen[0] || {};
    const extra = Object.keys(req).filter((k) => !["id", "op", "actor"].includes(k));
    check("it asks for the snapshot op as moni-ai with no parameters", req.op === "snapshot" && req.actor === "moni-ai" && extra.length === 0, JSON.stringify(req));
    const data = JSON.parse(ok.result.content[0].text);
    check("the snapshot comes back", data.machine && data.machine.disk.free_gb === 300.1 && data.services.failed[0] === "x.service");
    check("forbidden keys are dropped at any depth", !hasKeyDeep(data, FORBIDDEN_KEYS), ok.result.content[0].text);
    check("the voice desk's own requests are dropped", !("requests_to_moni_ai" in data));
    check("no command or secret text survives", !/rm -rf|LEAK|sk-should/.test(ok.result.content[0].text));

    // Missing arguments object is fine too (some clients omit it).
    const bare = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status_snapshot" } });
    check("a call with no arguments object works", bare && !bare.result.isError);

    // ui_action (UI control Phase 2): the shared allowlist's schema, flat args mapped to {action, args}.
    {
      const ui = list.result.tools.find((t) => t.name === "ui_action");
      check("ui_action is listed, with the allowlist's action enum and no extras", ui && ui.inputSchema.properties.action.enum.includes("sheet.open") && !ui.inputSchema.properties.action.enum.some((a) => /approve|deny|settings\.set|key|user|rule|restart|deploy/.test(a)) && ["theme.set", "persona.set", "voice.set"].every((a) => ui.inputSchema.properties.action.enum.includes(a)) && ui.inputSchema.additionalProperties === false, ui && JSON.stringify(ui.inputSchema.properties.action.enum));
      check("  its description says it cannot approve and works only in the administrator's own request", ui && /cannot approve, deny or confirm/.test(ui.description) && /only while you answer a request the administrator sent/.test(ui.description));
      check("  and that the three preferences only ask (confirm; never confirm for them)", ui && /only ASK: their result is confirm/.test(ui.description) && /never confirm for them/.test(ui.description));
      seen.length = 0;
      reply = { status: "ok", done: "Mint opened Missions" };
      const r = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ui_action", arguments: { action: "sheet.open", key: "missions" } } });
      const q = seen[0] || {};
      check("  a call is the ui-action op as moni-ai, with {action, args} only", q.op === "ui-action" && q.actor === "moni-ai" && q.action === "sheet.open" && JSON.stringify(q.args) === '{"key":"missions"}' && Object.keys(q).sort().join() === "action,actor,args,id,op", JSON.stringify(q));
      check("  and returns the supervisor's answer as is", r && !r.result.isError && JSON.parse(r.result.content[0].text).status === "ok");
      seen.length = 0;
      const bad = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ui_action", arguments: { action: "sheet.open", key: "missions", url: "https://x" } } });
      check("  an unknown argument is refused before the socket", bad.result.isError && /does not take: url/.test(bad.result.content[0].text) && seen.length === 0);
    }

    // The supervisor down: a clean tool error, not a crash.
    server.close();
    fs.rmSync(SOCK, { force: true });
    const down = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status_snapshot", arguments: {} } });
    check("supervisor unreachable is a tool error", down.result.isError && /cannot reach/.test(down.result.content[0].text));

    // The real snapshot builder, fed secrets and commands.
    const snap = buildSnapshot({
      now: "2026-09-29T12:00:00Z",
      host: "vmi3567127",
      vitals: { cpu_pct: 12, cpus: 8, load: [0.5, 0.4, 0.3], mem: { pct: 40, total: 16 * 2 ** 30, available: 9 * 2 ** 30 }, disk: { pct: 6, total: 400 * 2 ** 30, free: 370 * 2 ** 30 } },
      services: [{ unit: "odoo.service", active: "active" }, { unit: "bad.service", active: "failed" }],
      sessions: [{ name: "Odoo 19 VPS setup", status: "idle" }, { name: "MINT AI", self: true }],
      process: { state: "ready", busy: true, queued: 2 },
      missions: [],
      decisions: [{ title: "Disk filling", status: "open", evidence: "df says 95%", fix_command: "rm -rf /var/log/big" }],
      approvals: [{ tool: "Bash", label: "Deletes files", summary: "rm -rf /root/x", input_json: '{"command":"rm -rf /root/x"}' }],
    });
    const view = mcp.snapshotView(snap);
    const txt = JSON.stringify(view);
    check("real snapshot: figures in human units", view.machine.disk.free_gb === 370 && view.machine.memory.used_percent === 40);
    check("real snapshot: failed service named, self session left out", view.services.failed[0] === "bad.service" && view.sessions.live === 1);
    check("real snapshot: no command, fix or evidence text", !/rm -rf|df says/.test(txt), txt);
    check("real snapshot: no forbidden key", !hasKeyDeep(view, FORBIDDEN_KEYS));
    check("real snapshot: the queue is visible", view.moni_ai.busy === true && view.moni_ai.requests_queued === 2);
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
