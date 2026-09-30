"use strict";
/**
 * moni-ai: the supervisor that owns MINT AI's Claude Code process.
 *
 * MINT AI is one long-lived headless `claude -p` in stream-json mode, run as
 * root with HOME=/root so it shares root's session registry and can reach every
 * other Claude Code session on the box through peer messaging (ListAgents /
 * SendMessage). This process:
 *
 *   - spawns it, resumes its fixed session id only after the previous process
 *     has exited, and restarts it with backoff;
 *   - refuses to start while anything else holds that session id (a second
 *     process resuming a live session forks its transcript silently);
 *   - switches Remote Control on so the conversation is reachable from Claude
 *     Desktop and claude.ai;
 *   - answers the CLI's permission requests (can_use_tool) by raising Approve /
 *     Deny cards, and denies anything nobody answers in time;
 *   - keeps a ring buffer of events and a SQLite ledger of turns, delegations,
 *     replies, approvals and audit;
 *   - serves a narrow, validated JSON protocol on a unix socket that only root
 *     and the moniai group can open (see lib/protocol.js);
 *   - takes ledger events from its hooks on a second, root-only socket.
 *
 * Runs as root under systemd (moni-ai.service). Never run two.
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, execFile } = require("child_process");

const { Ledger, now } = require("./lib/ledger");
const protocol = require("./lib/protocol");
const classifier = require("./lib/classifier");
const rulesLib = require("./lib/rules");
const peers = require("./lib/peers");
const targets = require("./lib/targets");
const { redact, redactDeep, clip } = require("./lib/redact");
const { createFeatures } = require("./lib/features");
const { buildSnapshot } = require("./lib/snapshot");
const turnQueue = require("./lib/turnqueue");
const names = require("./lib/names");
const UiActions = require("./lib/ui-actions");

/* ----------------------------------------------------------------- config --- */

const CONFIG_FILE = process.env.MONI_AI_CONFIG || "/etc/moni-ai/config.json";

const DEFAULTS = {
  name: names.DISPLAY_NAME,
  cli: "/opt/moni-ai/cli/claude",
  cli_version: "2.1.283",
  model: "claude-opus-5-5",
  effort: "high",
  permission_mode: "auto",
  cwd: "/root/moni-ai",
  home: "/root",
  runtime_dir: "/run/user/0",
  state_dir: "/var/lib/moni-ai",
  log_dir: "/var/log/moni-ai",
  run_dir: "/run/moni-ai",
  socket_group: "moniai",
  remote_control: true,
  approval_timeout_s: 300,
  delegation_allow: [],
  sessions_poll_s: 5,
  ring_size: 2000,
  backoff_min_s: 2,
  backoff_max_s: 120,
  // Command Center v3, phase 1
  tz: "Africa/Cairo",
  helper: "/usr/local/sbin/moni-helper",
  odoo_log: "/var/log/odoo/odoo.log",
  watcher_poll_s: 30,
  watcher_cooldown_s: 1800,
  watcher_max_investigations_per_hour: 4,
  watcher_inject: false,
  orders_tick_s: 15,
  cost_scan_s: 60,
  mcp: true,
  // The turn queue (lib/turnqueue.js): user turns first, background after.
  queue_background_max_wait_s: 600, // a background turn waiting this long ranks with user turns
  queue_requeue_max_age_s: 21600, // after a supervisor restart, re-queue unsent turns younger than this
  queue_start_timeout_s: 120, // a handed-over turn that has not started by then, with nothing running, frees the queue
  cli_extra_args: [], // tests only, e.g. ["--setting-sources", "project"]
};

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ${CONFIG_FILE}: ${e.message}`);
  }
  const merged = { ...DEFAULTS, ...file };
  // The rename (MONI AI -> MINT AI, 2026-09-29): a config that still carries
  // an old name gets the new one, so the session is shown as MINT AI even
  // before /etc/moni-ai/config.json is edited. Any other name is kept.
  if (names.OLD_NAMES.includes(merged.name)) merged.name = names.DISPLAY_NAME;
  return merged;
}

const cfg = loadConfig();
const CONTROL_SOCKET = path.join(cfg.run_dir, "moni-ai.sock");
const HOOK_SOCKET = path.join(cfg.run_dir, "hook.sock");
const LOCK_FILE = path.join(cfg.run_dir, "supervisor.pid");
const STATE_FILE = path.join(cfg.state_dir, "state.json");
const AUDIT_LOG = path.join(cfg.log_dir, "audit.log");
const SESSIONS_DIR = path.join(cfg.home, ".claude", "sessions");
const PROJECTS_DIR = path.join(cfg.home, ".claude", "projects");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.error(new Date().toISOString(), "WARN", ...a);

/* ------------------------------------------------------------------ state --- */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState(patch) {
  const s = { ...readState(), ...patch };
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  return s;
}

/* ------------------------------------------------------------------- lock --- */

/**
 * One supervisor at a time. systemd already guarantees that for the unit; this
 * catches someone starting a second copy by hand, which would put two
 * processes on one session id -- the transcript fork this whole design avoids.
 */
function takeLock() {
  fs.mkdirSync(cfg.run_dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o644);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid && alive(pid) && /supervisor\.js/.test(cmdline(pid))) {
        throw new Error(`another supervisor is running (pid ${pid})`);
      }
      fs.unlinkSync(LOCK_FILE);
    }
  }
  throw new Error("could not take the lock");
}
function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    /* gone already */
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch (_) {
    return "";
  }
}

/* ----------------------------------------------------------------- ledger --- */

fs.mkdirSync(cfg.state_dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cfg.log_dir, { recursive: true, mode: 0o750 });
const ledger = new Ledger(path.join(cfg.state_dir, "ledger.db"));

function auditLine(actor, op, detail, ok, error) {
  ledger.audit(actor, op, detail, ok, error);
  const line = `${now()} actor=${actor} op=${op} ok=${ok ? 1 : 0}${error ? " error=" + JSON.stringify(String(error).slice(0, 200)) : ""} ${detail ? JSON.stringify(detail).slice(0, 600) : ""}\n`;
  fs.appendFile(AUDIT_LOG, line, { mode: 0o640 }, () => {});
}

/* ----------------------------------------------------------------- events --- */

let seq = 0;
const ring = [];
const viewers = new Set();

/**
 * Publish one event to the connected viewers only: never into the ring, so a
 * reconnecting viewer can never replay it (UI control: "ui" events).
 */
function emitLive(type, data) {
  const line = JSON.stringify({ event: redactDeep({ seq: 0, ts: now(), type, ...data }) }) + "\n";
  for (const v of viewers) {
    if (v.destroyed) {
      viewers.delete(v);
      continue;
    }
    v.write(line);
  }
}

/** Publish one event to the ring buffer and every connected viewer. */
function emit(type, data) {
  const ev = redactDeep({ seq: ++seq, ts: now(), type, ...data });
  ring.push(ev);
  if (ring.length > cfg.ring_size) ring.splice(0, ring.length - cfg.ring_size);
  const line = JSON.stringify({ event: ev }) + "\n";
  for (const v of viewers) {
    if (v.destroyed) {
      viewers.delete(v);
      continue;
    }
    // A viewer that stops reading must not make the supervisor buffer forever.
    if (v.writableLength > 4 * 1024 * 1024) {
      v.destroy();
      viewers.delete(v);
      continue;
    }
    v.write(line);
  }
  return ev;
}

/* ----------------------------------------------------------- the process --- */

const proc = {
  child: null,
  state: "stopped", // starting | ready | stopping | backoff | stopped | blocked | error
  pid: null,
  startedAt: null,
  readyAt: null,
  restarts: 0,
  lastExit: null,
  lastStderr: "",
  backoff: cfg.backoff_min_s,
  timer: null,
  wantRunning: true,
  error: null,
  cliVersion: null,
  initSessionId: null,
  generation: 0,
};

/* UI control (see uiAction below): in memory only, never in the ledger or the ring. */
const UI_REFUSED_ACTORS = new Set(["moni-ai", "watcher", "supervisor", "flag-file", "scheduler", "order"]);
const UI_ACK_MS = 5000;
const uiTokens = new Map(); // turn id -> { ut, actor, source }
const uiWaiting = new Map(); // nonce -> { actor, resolve }
const uiLimit = UiActions.limiter();
const uiTag = (ut) => crypto.createHash("sha256").update(String(ut)).digest("hex").slice(0, 16);

const turns = {
  pending: [], // turns waiting their go: { row, message }. Handed to the CLI one at a time by pump().
  inflight: null, // { id, uuid, at }: handed to the CLI, not started yet
  byUuid: new Map(), // uuid -> turn row id
  running: null, // { id, uuid, source, text, started_at, steps: [] }
  toolSteps: new Map(), // tool_use_id -> step
};

const approvals = new Map(); // approval id -> { requestId, input, generation, timer, toolUseId, tool }
const requestToApproval = new Map(); // CLI request_id -> approval id

const rc = { enabled: false, url: null, bridgeSessionId: null, state: null, error: null };

let sessionsCache = { at: null, list: [], error: null };
let subagentsCache = new Map(); // session_id -> running sub-agents (see refreshSubagents)

function sessionId() {
  let s = readState();
  if (!s.session_id) s = writeState({ session_id: crypto.randomUUID(), created_at: now() });
  return s.session_id;
}

/**
 * Every session id MINT AI has ever used: the current one, the ones retired by
 * a fresh start (session_history) and one the CLI made us adopt. Their
 * transcripts stay on disk; they are MINT AI's own, so the cost scanner must
 * not count them as some other session's spend.
 */
function selfSessionIds() {
  const s = readState();
  const ids = new Set();
  if (s.session_id) ids.add(s.session_id);
  if (s.previous_session_id) ids.add(s.previous_session_id);
  for (const h of Array.isArray(s.session_history) ? s.session_history : []) if (h && h.session_id) ids.add(h.session_id);
  return ids;
}

/** The one-shot flag file: `touch` it and the next start is a fresh session. */
const FRESH_FLAG = path.join(cfg.state_dir, "fresh-start");

/**
 * Retire the current session id and pick a new one, so the next start runs
 * `--session-id <new>`. The old transcript is left where it is; the old id is
 * kept in session_history so it can be traced and is never resumed.
 */
function rotateSession(actor, reason) {
  const s = readState();
  const old = s.session_id || null;
  let id = crypto.randomUUID();
  while (id === old) id = crypto.randomUUID();
  const at = now();
  const history = Array.isArray(s.session_history) ? s.session_history.slice(-49) : [];
  if (old) history.push({ session_id: old, created_at: s.created_at || null, retired_at: at, retired_by: actor, reason: reason || null, next_session_id: id });
  writeState({ session_id: id, created_at: at, created_by: actor, previous_session_id: old, session_history: history, rc: null, last_init: null });
  auditLine(actor, "session-rotate", { old_session_id: old, new_session_id: id, reason: reason || null }, true);
  log(`fresh session: ${old || "(none)"} -> ${id} (${actor}${reason ? ": " + reason : ""})`);
  emit("notice", { level: "warn", text: `Fresh session started by ${actor}` });
  return { old_session_id: old, new_session_id: id, at };
}

/** Honour the flag file, once. */
function takeFreshFlag() {
  let text;
  try {
    text = fs.readFileSync(FRESH_FLAG, "utf8");
  } catch (_) {
    return null;
  }
  try {
    fs.unlinkSync(FRESH_FLAG);
  } catch (e) {
    // A flag we cannot remove would rotate on every start: refuse it instead.
    warn(`cannot remove ${FRESH_FLAG}: ${e.message}; ignoring it`);
    return null;
  }
  return rotateSession("flag-file", clip(String(text).trim(), 300) || "fresh-start flag file");
}

function transcriptExists(id) {
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      if (fs.existsSync(path.join(PROJECTS_DIR, dir, id + ".jsonl"))) return true;
    }
  } catch (_) {
    /* no projects dir yet */
  }
  return false;
}

/**
 * Who else holds this session id right now? A live registry entry, or any
 * process whose command line names it. Resuming while either exists would fork
 * the transcript.
 */
function holdersOf(id) {
  const holders = [];
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        if (r.sessionId === id && r.pid && alive(r.pid) && r.pid !== (proc.child && proc.child.pid)) holders.push(r.pid);
      } catch (_) {
        /* half-written registry file */
      }
    }
  } catch (_) {
    /* no registry */
  }
  try {
    for (const p of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      const pid = Number(p);
      if (pid === process.pid || (proc.child && pid === proc.child.pid)) continue;
      const cl = cmdline(pid);
      if (cl.includes(id) && /claude/.test(cl) && !holders.includes(pid)) holders.push(pid);
    }
  } catch (_) {
    /* no /proc? */
  }
  return holders;
}

function childEnv() {
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: cfg.home,
    USER: "root",
    LOGNAME: "root",
    SHELL: "/bin/bash",
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    TZ: process.env.TZ || "Africa/Cairo",
    DISABLE_AUTOUPDATER: "1",
    MONI_AI_SUPERVISED: "1",
    MONI_AI_HOOK_SOCKET: HOOK_SOCKET,
    MONI_AI_CONFIG: CONFIG_FILE,
    MONI_AI_SOCKET: CONTROL_SOCKET,
  };
  if (cfg.runtime_dir && fs.existsSync(cfg.runtime_dir)) env.XDG_RUNTIME_DIR = cfg.runtime_dir;
  // Deliberately built from nothing: an inherited CLAUDE_CODE_MESSAGING_SOCKET
  // or session variable would make the child think it is someone else's
  // subprocess, and CLAUDE_CONFIG_DIR would move it out of root's registry
  // where no other session can see it.
  return env;
}

function checkCli() {
  return new Promise((resolve) => {
    execFile(cfg.cli, ["--version"], { timeout: 20000, env: childEnv() }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: `cannot run ${cfg.cli}: ${err.message}` });
      const v = String(stdout).trim().split(/\s+/)[0];
      if (cfg.cli_version && v !== cfg.cli_version)
        return resolve({ ok: false, version: v, error: `CLI is ${v}, pinned ${cfg.cli_version}. Re-verify peer messaging, Remote Control and can_use_tool on ${v}, then update cli_version in ${CONFIG_FILE}.` });
      resolve({ ok: true, version: v });
    });
  });
}

/**
 * MINT AI's own tools (missions, decisions, status_snapshot, ui_actions_list, ui_do) as a
 * stdio MCP server, bin/moni-ai-mcp, registered as "mint-ai" (its tools are
 * mcp__mint-ai__*; "moni-ai" until 2026-09-30 -- renamed so a resumed session
 * discovers the tools fresh instead of reusing a schema it recorded earlier).
 * It talks to this supervisor's control socket as actor "moni-ai" (unchanged).
 * Its tools are allowed outright: they record MINT AI's own plans and
 * proposals, read the snapshot, or ask for a checked screen action.
 */
const MCP_NAME = "mint-ai";
function mcpArgs() {
  if (!cfg.mcp) return [];
  const server = path.join(__dirname, "bin", "moni-ai-mcp");
  if (!fs.existsSync(server)) return [];
  const conf = { mcpServers: { [MCP_NAME]: { type: "stdio", command: process.execPath, args: [server], env: { MONI_AI_SOCKET: CONTROL_SOCKET } } } };
  return ["--mcp-config", JSON.stringify(conf), "--allowedTools", "mcp__" + MCP_NAME];
}

function setState(state, extra = {}) {
  proc.state = state;
  emit("proc", { state, pid: proc.pid, restarts: proc.restarts, ...extra });
}

async function start() {
  clearTimeout(proc.timer);
  proc.timer = null;
  if (!proc.wantRunning || proc.child) return;

  const cli = await checkCli();
  proc.cliVersion = cli.version || null;
  if (!cli.ok) {
    proc.error = cli.error;
    warn(cli.error);
    setState("error", { error: cli.error });
    return scheduleRestart(true);
  }

  takeFreshFlag();
  const id = sessionId();
  const holders = holdersOf(id);
  if (holders.length) {
    proc.error = `session ${id} is held by pid ${holders.join(", ")}; not starting a second copy`;
    warn(proc.error);
    setState("blocked", { error: proc.error, holders });
    return scheduleRestart(true);
  }

  const retired = (readState().session_history || []).some((h) => h && h.session_id === id);
  if (retired) {
    proc.error = `session ${id} was retired by a fresh start; refusing to resume it`;
    warn(proc.error);
    setState("error", { error: proc.error });
    return scheduleRestart(true);
  }
  const resume = transcriptExists(id);
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--include-partial-messages",
    "-n", cfg.name,
    "--model", cfg.model,
    "--effort", cfg.effort,
    "--permission-mode", cfg.permission_mode,
    "--permission-prompt-tool", "stdio",
    ...mcpArgs(),
    ...(Array.isArray(cfg.cli_extra_args) ? cfg.cli_extra_args.map(String) : []),
    ...(resume ? ["--resume", id] : ["--session-id", id]),
  ];

  proc.error = null;
  proc.generation++;
  const gen = proc.generation;
  log(`starting ${cfg.cli} (${proc.cliVersion}) ${resume ? "resuming" : "new session"} ${id}`);
  let child;
  try {
    child = spawn(cfg.cli, argv, { cwd: cfg.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    proc.error = e.message;
    setState("error", { error: e.message });
    return scheduleRestart(true);
  }
  proc.child = child;
  proc.pid = child.pid;
  proc.startedAt = now();
  proc.readyAt = null;
  proc.lastStderr = "";
  proc.initSessionId = null;
  setState("starting", { resume });

  child.stdin.on("error", () => {});
  child.stderr.on("data", (d) => {
    proc.lastStderr = (proc.lastStderr + d.toString()).slice(-4000);
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (gen !== proc.generation) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_) {
      return;
    }
    try {
      onEvent(ev);
    } catch (e) {
      warn("event handler failed:", e.stack || e.message);
    }
  });

  child.on("exit", (code, signal) => onExit(gen, code, signal));
  child.on("error", (e) => {
    proc.error = e.message;
    warn("child error:", e.message);
  });

  writeChild({ type: "control_request", request_id: "init-" + gen, request: { subtype: "initialize" } });
}

function onExit(gen, code, signal) {
  if (gen !== proc.generation) return;
  const ranFor = proc.startedAt ? Date.now() - Date.parse(proc.startedAt) : 0;
  proc.lastExit = { code, signal, at: now(), stderr: proc.lastStderr.slice(-1500) };
  log(`claude exited code=${code} signal=${signal} after ${Math.round(ranFor / 1000)}s`);
  if (code && proc.lastStderr) warn("stderr:", proc.lastStderr.slice(-1500));
  proc.child = null;
  proc.pid = null;
  rc.enabled = false;
  rc.state = null;
  emit("rc", { enabled: false });

  // Whatever was waiting on this process is over.
  for (const [aid, a] of approvals) {
    clearTimeout(a.timer);
    const row = ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "MINT AI's process ended before an answer" });
    approvals.delete(aid);
    emit("approval", { approval: publicApproval(row) });
  }
  requestToApproval.clear();
  if (turns.running) {
    const row = ledger.updateTurn(turns.running.id, { status: "lost", ended_at: now(), error: "process exited mid-turn" });
    emit("turn", { phase: "end", turn: publicTurn(row) });
    uiTokens.delete(turns.running.id);
    turns.running = null;
    features.hooks.onTurnEnd(row);
  }
  // Turns written to the old process but not yet started would be lost with
  // it; they were never answered, so re-queue them for the next process.
  clearInflight();
  for (const [uuid, tid] of turns.byUuid) {
    const row = ledger.get("turns", tid);
    if (row && row.status === "queued" && OUR_SOURCES.has(row.source)) {
      turns.pending.push({ row: ledger.updateTurn(row.id, { sent_at: null }), message: userMessage(row) });
    }
    turns.byUuid.delete(uuid);
  }

  if (ranFor > 5 * 60 * 1000) proc.backoff = cfg.backoff_min_s;
  if (!proc.wantRunning) return setState("stopped", { code, signal });
  proc.restarts++;
  setState("backoff", { code, signal, retry_in_s: proc.backoff });
  scheduleRestart(false);
}

function scheduleRestart(isError) {
  clearTimeout(proc.timer);
  if (!proc.wantRunning) return;
  const wait = proc.backoff;
  proc.backoff = Math.min(cfg.backoff_max_s, proc.backoff * 2);
  proc.timer = setTimeout(() => start().catch((e) => warn("start failed:", e.message)), wait * 1000);
  if (isError) emit("proc", { state: proc.state, retry_in_s: wait, error: proc.error });
}

/** Close stdin and let the CLI exit on its own, so it finishes its transcript. */
function stopChild(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = proc.child;
    if (!child) return resolve();
    setState("stopping");
    const done = () => resolve();
    child.once("exit", done);
    try {
      child.stdin.end();
    } catch (_) {
      /* already closed */
    }
    setTimeout(() => {
      if (proc.child === child) {
        try {
          child.kill("SIGTERM");
        } catch (_) {
          /* gone */
        }
      }
    }, timeoutMs).unref();
    setTimeout(() => {
      if (proc.child === child) {
        try {
          child.kill("SIGKILL");
        } catch (_) {
          /* gone */
        }
      }
    }, timeoutMs + 5000).unref();
  });
}

function writeChild(obj) {
  const child = proc.child;
  if (!child || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(obj) + "\n");
  return true;
}

function userMessage(row) {
  let content = row.text;
  if (row.source === "voice-desk") {
    content =
      `${content}\n\n` +
      `[Dashboard: the administrator said this aloud and the voice front desk passed it on. ` +
      `The desk will read them a short spoken summary of your reply, held to what you wrote; the full text stays on their screen. ` +
      `So say plainly what happened, what did not, and anything that needs their approval or answer.]`;
  }
  if (row.target) {
    content =
      `${content}\n\n` +
      `[Dashboard: the administrator addressed this to the session named "${row.target}". ` +
      `Delegate it there unless it is plainly something you should answer yourself.]`;
  }
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: row.uuid };
}

/** Turns this supervisor wrote itself: their replayed text is already recorded. */
const OUR_SOURCES = new Set(["dashboard", "voice-desk", "order", "watcher", "mission-request", "decision"]);

/**
 * Queue a turn for MINT AI. The supervisor holds the queue and hands the CLI
 * one turn at a time, user turns before background ones (lib/turnqueue.js).
 * Nothing here ever interrupts a running turn.
 */
function queueTurn({ source, actor, text, target, order_id, mission_id, decision_id, ut }) {
  const row = ledger.addTurn({ uuid: crypto.randomUUID(), source, actor, text, target: target || null, status: "queued", order_id, mission_id, decision_id });
  // The ui token lives here only (memory): never in the ledger, the events or the audit.
  if (ut && (source === "dashboard" || source === "voice-desk") && !UI_REFUSED_ACTORS.has(actor)) {
    uiTokens.set(row.id, { ut, actor, source });
    if (uiTokens.size > 200) uiTokens.delete(uiTokens.keys().next().value);
  }
  turns.pending.push({ row, message: userMessage(row) });
  emit("turn", { phase: "queued", turn: publicTurn(row) });
  pump();
  return publicTurn(row);
}

/**
 * Hand the CLI the next turn, if it is free: nothing running and nothing
 * handed over that has not started. The CLI would queue a second message
 * behind the first in arrival order, so holding the rest here is what lets a
 * user turn overtake a waiting background one.
 */
function pump() {
  if (proc.state !== "ready" || turns.running || turns.inflight || !turns.pending.length) return;
  const i = turnQueue.pickNext(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000);
  if (i < 0) return;
  const { row, message } = turns.pending[i];
  if (!writeChild(message)) return;
  turns.pending.splice(i, 1);
  turns.byUuid.set(row.uuid, row.id);
  ledger.updateTurn(row.id, { sent_at: now() });
  turns.inflight = { id: row.id, uuid: row.uuid, at: Date.now() };
  clearTimeout(turns.inflightTimer);
  turns.inflightTimer = setTimeout(inflightWatchdog, cfg.queue_start_timeout_s * 1000);
  if (turns.inflightTimer.unref) turns.inflightTimer.unref();
}

function clearInflight() {
  turns.inflight = null;
  clearTimeout(turns.inflightTimer);
  turns.inflightTimer = null;
}

/**
 * A turn handed over and never started. If another turn is running (a peer
 * message the CLI took first) it is simply waiting behind it; otherwise the
 * CLI has lost track of it, so stop holding the queue for it.
 */
function inflightWatchdog() {
  if (!turns.inflight) return;
  if (turns.running) {
    turns.inflightTimer = setTimeout(inflightWatchdog, cfg.queue_start_timeout_s * 1000);
    if (turns.inflightTimer.unref) turns.inflightTimer.unref();
    return;
  }
  warn(`turn #${turns.inflight.id} was handed to the CLI ${Math.round((Date.now() - turns.inflight.at) / 1000)}s ago and never started; freeing the queue`);
  clearInflight();
  pump();
}

/* --------------------------------------------------------- stream events --- */

function onEvent(ev) {
  switch (ev.type) {
    case "control_response":
      return onControlResponse(ev);
    case "control_request":
      return onControlRequest(ev);
    case "control_cancel_request":
      return onControlCancel(ev);
    case "system":
      return onSystem(ev);
    case "command_lifecycle":
      return onLifecycle(ev);
    case "user":
      return onUser(ev);
    case "assistant":
      return onAssistant(ev);
    case "stream_event":
      return onStreamEvent(ev);
    case "result":
      return onResult(ev);
    default:
      return;
  }
}

const pendingControl = new Map(); // request_id -> callback

function sendControl(request, timeoutMs = 30000) {
  const id = "sup-" + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!writeChild({ type: "control_request", request_id: id, request })) return reject(new Error("MINT AI is not running"));
    const t = setTimeout(() => {
      pendingControl.delete(id);
      reject(new Error("no answer from the CLI"));
    }, timeoutMs);
    pendingControl.set(id, (resp) => {
      clearTimeout(t);
      pendingControl.delete(id);
      if (resp.subtype === "success") resolve(resp.response || {});
      else reject(new Error(resp.error || "the CLI refused"));
    });
  });
}

function onControlResponse(ev) {
  const resp = ev.response || {};
  if (resp.request_id && String(resp.request_id).startsWith("init-")) {
    if (resp.subtype !== "success") {
      proc.error = "initialize failed: " + (resp.error || "unknown");
      warn(proc.error);
      return;
    }
    proc.readyAt = now();
    setState("ready");
    pump();
    if (cfg.remote_control) enableRemoteControl(true, "supervisor").catch((e) => warn("remote control:", e.message));
    return;
  }
  const cb = pendingControl.get(resp.request_id);
  if (cb) cb(resp);
}

async function enableRemoteControl(enabled, actor) {
  const r = await sendControl({ subtype: "remote_control", enabled: !!enabled }, 45000);
  rc.enabled = !!enabled;
  rc.error = null;
  if (enabled) {
    rc.url = r.session_url || r.sessionUrl || rc.url;
    rc.bridgeSessionId = r.bridge_session_id || r.bridgeSessionId || rc.bridgeSessionId;
    writeState({ rc: { url: rc.url, bridge_session_id: rc.bridgeSessionId, enabled_at: now() } });
  }
  log(`remote control ${enabled ? "on" : "off"} (${actor})`);
  emit("rc", { enabled: rc.enabled, url: rc.enabled ? rc.url : null, bridge_session_id: rc.bridgeSessionId });
  return { enabled: rc.enabled, url: rc.enabled ? rc.url : null, bridge_session_id: rc.bridgeSessionId };
}

function onSystem(ev) {
  if (ev.subtype === "init") {
    proc.initSessionId = ev.session_id;
    const want = readState().session_id;
    if (ev.session_id && want && ev.session_id !== want) {
      // The CLI chose its own id. Adopt it, so the next start resumes what
      // this process is actually writing.
      warn(`CLI started session ${ev.session_id}, not ${want}; adopting it`);
      writeState({ session_id: ev.session_id, previous_session_id: want });
    }
    const tools = Array.isArray(ev.tools) ? ev.tools.map(String) : [];
    writeState({
      last_init: {
        session_id: ev.session_id || null,
        at: now(),
        model: ev.model || null,
        cli_version: ev.claude_code_version || null,
        permission_mode: ev.permissionMode || null,
        tools: tools.length,
        mcp_tools: tools.filter((t) => t.startsWith("mcp__")),
        mcp_servers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.map((m) => ({ name: m && m.name, status: m && m.status })) : null,
      },
    });
    emit("init", {
      session_id: ev.session_id,
      model: ev.model,
      permission_mode: ev.permissionMode,
      cli_version: ev.claude_code_version,
      tools: Array.isArray(ev.tools) ? ev.tools.length : null,
    });
    return;
  }
  if (ev.subtype === "bridge_state") {
    rc.state = ev.state;
    emit("rc", { enabled: rc.enabled, state: ev.state });
    return;
  }
  if (ev.subtype === "status" && ev.status) {
    emit("status", { status: ev.status });
  }
}

function onLifecycle(ev) {
  const uuid = ev.command_uuid;
  if (!uuid) return;
  let row = turns.byUuid.has(uuid) ? ledger.get("turns", turns.byUuid.get(uuid)) : ledger.turnByUuid(uuid);
  if (ev.state === "queued") {
    if (row) {
      row = ledger.updateTurn(row.id, { status: "queued" });
      emit("turn", { phase: "queued", turn: publicTurn(row) });
    }
    return;
  }
  if (ev.state === "started") {
    if (!row) {
      // A turn the CLI started on its own -- a peer message, an idle notice,
      // or someone typing through Remote Control. The replayed user message
      // that follows fills in where it came from.
      row = ledger.addTurn({ uuid, source: "unknown", text: "", status: "running" });
      turns.byUuid.set(uuid, row.id);
    }
    row = ledger.updateTurn(row.id, { status: "running", started_at: now() });
    if (turns.inflight && turns.inflight.uuid === uuid) clearInflight();
    turns.running = { id: row.id, uuid, source: row.source, text: row.text, started_at: row.started_at, steps: [] };
    turns.toolSteps.clear();
    emit("turn", { phase: "start", turn: publicTurn(row) });
    emitSteps();
    return;
  }
  if (ev.state === "completed" || ev.state === "cancelled" || ev.state === "failed") {
    if (row && (row.status === "running" || row.status === "queued")) {
      row = ledger.updateTurn(row.id, {
        status: ev.state === "completed" ? "done" : ev.state === "cancelled" ? "interrupted" : "error",
        ended_at: now(),
      });
      emit("turn", { phase: "end", turn: publicTurn(row) });
      features.hooks.onTurnEnd(row);
    }
    if (turns.running && turns.running.uuid === uuid) {
      uiTokens.delete(turns.running.id); // a turn's ui token dies with it
      turns.running = null;
    }
    if (turns.inflight && turns.inflight.uuid === uuid) clearInflight();
    turns.byUuid.delete(uuid);
    pump();
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return "";
}

function onUser(ev) {
  const content = ev.message && ev.message.content;
  // Tool results come back as user events carrying tool_result blocks.
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
    for (const b of content) if (b && b.type === "tool_result") onToolResult(b, ev);
    return;
  }
  if (!ev.isReplay) return;
  const text = contentText(content);
  const uuid = ev.uuid;
  let source = "remote";
  let fromName = null;
  if (ev.origin && ev.origin.kind === "peer") {
    source = "peer";
    fromName = ev.origin.name || null;
  } else if (text.includes("[Cross-session idle notice]")) source = "idle";
  else if (text.includes("[Cross-session delivery notice]")) source = "delivery";
  else if (ev.isSynthetic || ev.isMeta) source = "system";

  let row = uuid && (turns.byUuid.has(uuid) ? ledger.get("turns", turns.byUuid.get(uuid)) : ledger.turnByUuid(uuid));
  if (row && OUR_SOURCES.has(row.source)) return; // our own message, already recorded
  const shown = source === "peer" && ev.origin && ev.origin.body ? ev.origin.body : text;
  if (row) {
    row = ledger.updateTurn(row.id, { source, text: clip(shown, 20000), actor: fromName });
  } else {
    row = ledger.addTurn({ uuid, source, actor: fromName, text: clip(shown, 20000), status: "queued" });
    if (uuid) turns.byUuid.set(uuid, row.id);
  }
  if (turns.running && turns.running.uuid === uuid) {
    turns.running.source = source;
    turns.running.text = row.text;
  }
  emit("turn", { phase: "source", turn: publicTurn(row), from_pid: ev.origin && ev.origin.verifiedPeerPid });
}

function describeTool(name, input) {
  const i = input || {};
  switch (name) {
    case "ListAgents":
      return "Listed the live sessions";
    case "SendMessage":
      return `Sent to ${peers.bareName(i.to)}: ${clip(i.message || "", 80)}${i.notify_when_idle ? " (notify when idle)" : ""}`;
    case "Bash":
      return "Ran: " + clip(i.command || "", 100);
    case "Monitor":
      return "Watching: " + clip(i.command || i.description || "", 100);
    case "Read":
      return "Read " + (i.file_path || "");
    case "Write":
      return "Wrote " + (i.file_path || "");
    case "Edit":
      return "Edited " + (i.file_path || "");
    case "Grep":
      return "Searched files for " + clip(i.pattern || "", 60);
    case "Glob":
      return "Listed files matching " + clip(i.pattern || "", 60);
    case "Task":
    case "Agent":
      return "Started a subagent: " + clip(i.description || i.prompt || "", 80);
    case "WebSearch":
      return "Searched the web: " + clip(i.query || "", 80);
    case "WebFetch":
      return "Fetched " + clip(i.url || "", 80);
    case "mcp__memory__memory_search":
      return `Searched memory: "${clip(i.query || "", 80)}"`;
    case "mcp__memory__memory_store":
      return "Saved a fact to memory";
    case "mcp__memory__memory_session":
      return "Read a past session";
    case "mcp__memory__memory_forget":
      return "Retracted a memory fact";
    default:
      return name;
  }
}

function emitSteps() {
  if (!turns.running) return;
  emit("steps", { turn_id: turns.running.id, steps: turns.running.steps });
}

function onAssistant(ev) {
  const blocks = (ev.message && ev.message.content) || [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) {
      emit("assistant", { turn_id: turns.running && turns.running.id, text: clip(b.text, 20000), parent_tool_use_id: ev.parent_tool_use_id || null });
    } else if (b.type === "tool_use") {
      const step = { t: now(), tool: b.name, txt: describeTool(b.name, b.input), st: "run", tool_use_id: b.id, sub: !!ev.parent_tool_use_id };
      if (turns.running) {
        turns.running.steps.push(step);
        if (turns.running.steps.length > 200) turns.running.steps.splice(0, turns.running.steps.length - 200);
      }
      turns.toolSteps.set(b.id, { step, name: b.name, input: b.input });
      emit("tool", { turn_id: turns.running && turns.running.id, tool_use_id: b.id, name: b.name, summary: step.txt, input: clipInput(b.input) });
      emitSteps();
    }
  }
}

function clipInput(input) {
  const s = JSON.stringify(input || {});
  if (s.length <= 4000) return input;
  return { _truncated: clip(s, 4000) };
}

function onToolResult(b, ev) {
  const t = turns.toolSteps.get(b.tool_use_id);
  const text = contentText(b.content);
  if (t) {
    t.step.st = b.is_error ? "error" : "done";
    t.step.done_at = now();
    if (b.is_error) t.step.error = clip(text, 300);
  }
  emit("tool_result", { tool_use_id: b.tool_use_id, ok: !b.is_error, name: t ? t.name : null, summary: clip(text, 600) });
  emitSteps();
}

function onStreamEvent(ev) {
  const e = ev.event || {};
  if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && !ev.parent_tool_use_id) {
    // Deltas skip the ring buffer: a reconnecting viewer gets the finished
    // assistant text instead of ten thousand fragments.
    const line = JSON.stringify({ event: { seq: 0, ts: now(), type: "text", turn_id: turns.running && turns.running.id, delta: redact(e.delta.text) } }) + "\n";
    for (const v of viewers) if (!v.destroyed && v.writableLength < 1024 * 1024) v.write(line);
  }
}

function onResult(ev) {
  const running = turns.running;
  if (running) {
    const row = ledger.updateTurn(running.id, {
      duration_ms: ev.duration_ms || null,
      cost_usd: ev.total_cost_usd || null,
      result_text: clip(ev.result || "", 20000),
      error: ev.is_error ? clip(ev.result || ev.subtype || "error", 2000) : null,
    });
    features.hooks.onResult(row, ev, proc.startedAt);
    emit("result", { turn: publicTurn(ledger.get("turns", row.id)), is_error: !!ev.is_error, subtype: ev.subtype });
  } else {
    emit("result", { is_error: !!ev.is_error, subtype: ev.subtype, cost_usd: ev.total_cost_usd, text: clip(ev.result || "", 4000) });
  }
}

/* --------------------------------------------------------------- approvals --- */

function onControlRequest(ev) {
  const req = ev.request || {};
  if (req.subtype !== "can_use_tool") {
    // Nothing else is registered, so nothing else should arrive; answering
    // stops the CLI waiting on a reply that would never come.
    writeChild({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: "not supported by the MINT AI supervisor" } });
    return;
  }
  const tool = req.tool_name || "unknown";
  const input = req.input || {};
  const auto = features.autoDecision(tool, input);
  if (auto) return autoAnswer(ev, req, tool, input, auto);
  const gate = classifier.gateDecision(tool, input, cfg) || {};
  const summary =
    tool === "SendMessage"
      ? `SendMessage to ${peers.bareName(input.to)}: ${input.message || ""}`
      : typeof input.command === "string"
      ? input.command
      : req.description || JSON.stringify(input);
  const expires = new Date(Date.now() + cfg.approval_timeout_s * 1000).toISOString();
  const row = ledger.addApproval({
    request_id: ev.request_id,
    tool_use_id: req.tool_use_id,
    turn_id: turns.running && turns.running.id,
    tool,
    input_json: clip(JSON.stringify(redactDeep(input)), 16000),
    summary: clip(redact(summary), 4000),
    category: gate.category || null,
    label: gate.label || (req.decision_reason_type === "hook" ? null : "Needs permission"),
    reason: req.decision_reason || gate.reason || req.description || null,
    expires_at: expires,
  });
  const timer = setTimeout(() => expireApproval(row.id), cfg.approval_timeout_s * 1000);
  approvals.set(row.id, { requestId: ev.request_id, input, generation: proc.generation, timer, tool, toolUseId: req.tool_use_id });
  requestToApproval.set(ev.request_id, row.id);
  const t = turns.toolSteps.get(req.tool_use_id);
  if (t) {
    t.step.st = "wait";
    t.step.approval_id = row.id;
    emitSteps();
  }
  log(`approval #${row.id} raised: ${tool} ${clip(summary, 120)}`);
  features.hooks.onApproval(row, input, turns.running ? ledger.get("turns", turns.running.id) : null);
  emit("approval", { approval: publicApproval(ledger.get("approvals", row.id)) });
}

/**
 * A rule answered this can_use_tool before anyone had to: an "Always allow
 * this" rule, or a deny. Recorded as an approval row like any other, decided
 * by "rule:<id>", so the audit trail shows it.
 */
function autoAnswer(ev, req, tool, input, auto) {
  const summary = tool === "SendMessage" ? `SendMessage to ${peers.bareName(input.to)}: ${input.message || ""}` : typeof input.command === "string" ? input.command : JSON.stringify(input);
  const t = now();
  const row = ledger.addApproval({
    request_id: ev.request_id,
    tool_use_id: req.tool_use_id,
    turn_id: turns.running && turns.running.id,
    tool,
    input_json: clip(JSON.stringify(redactDeep(input)), 16000),
    summary: clip(redact(summary), 4000),
    category: auto.allow ? "rule" : "rule-deny",
    label: auto.allow ? "Allowed by a rule" : "Denied by a rule",
    reason: auto.explain,
    expires_at: t,
  });
  const who = auto.rule ? "rule:" + auto.rule.id : "rule";
  const response = auto.allow
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: `MINT AI rules: ${auto.explain} Do not retry it or route it through another session; tell the user it is not allowed.` };
  writeChild({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response } });
  const upd = ledger.updateApproval(row.id, { status: auto.allow ? "approved" : "denied", decided_at: t, decided_by: who, rule_id: auto.rule ? auto.rule.id : null, note: auto.explain });
  log(`approval #${row.id} ${auto.allow ? "allowed" : "denied"} by ${who}: ${tool} ${clip(summary, 120)}`);
  if (!auto.allow) recordDeniedDelegation({ tool, input, toolUseId: req.tool_use_id }, upd, `denied by ${who}`);
  emit("approval", { approval: publicApproval(upd) });
}

function answer(approvalId, allow, message) {
  const a = approvals.get(approvalId);
  if (!a) return false;
  if (a.generation !== proc.generation) return false;
  clearTimeout(a.timer);
  approvals.delete(approvalId);
  requestToApproval.delete(a.requestId);
  const response = allow ? { behavior: "allow", updatedInput: a.input } : { behavior: "deny", message };
  writeChild({ type: "control_response", response: { subtype: "success", request_id: a.requestId, response } });
  const t = turns.toolSteps.get(a.toolUseId);
  if (t) {
    t.step.st = allow ? "run" : "error";
    emitSteps();
  }
  return a;
}

function recordDeniedDelegation(a, row, why) {
  if (a.tool !== "SendMessage") return;
  const to = String(a.input.to || "");
  const d = ledger.addDelegation({
    tool_use_id: a.toolUseId,
    turn_id: row.turn_id,
    target: to,
    target_name: peers.bareName(to),
    text: String(a.input.message || ""),
    summary: a.input.summary,
    notify_idle: !!a.input.notify_when_idle,
    status: "denied",
    note: why,
  });
  emitDelegation(d);
}

function decide(approvalId, allow, actor, note, alwaysRule) {
  const row = ledger.get("approvals", approvalId);
  if (!row) throw new Error("no such approval");
  if (row.status !== "pending") throw new Error(`that approval is already ${row.status}`);
  const a = approvals.get(approvalId);
  if (!a) throw new Error("that request is no longer waiting (the process restarted)");
  let rule = null;
  if (allow && alwaysRule) {
    // "Always allow this": the rule must at least cover this very call, and
    // is saved before the call runs so the next identical one needs no card.
    const probe = rulesLib.evaluate(a.tool, a.input, [{ id: 0, effect: "allow", tool: alwaysRule.tool, pattern: alwaysRule.pattern, scope_session: "moni-ai", scope_machine: "this" }], {});
    if (!(probe.decision === "allow" && probe.source === "rule")) throw new Error("that rule would not match this request; narrow it to this command");
    rule = features.publicRule(features.createRule({ effect: "allow", tool: alwaysRule.tool, pattern: alwaysRule.pattern, note: `Always allow, from approval #${approvalId}` }, actor, approvalId));
  }
  const msg = allow
    ? null
    : `Denied by ${actor} in the MINT AI dashboard${note ? ": " + note : ""}. Do not retry it, do not route it through another session, and tell the user it was denied.`;
  answer(approvalId, allow, msg);
  const updated = ledger.updateApproval(approvalId, {
    status: allow ? "approved" : "denied",
    decided_at: now(),
    decided_by: actor,
    note: note || null,
  });
  if (!allow) recordDeniedDelegation(a, updated, `denied by ${actor}`);
  log(`approval #${approvalId} ${allow ? "approved" : "denied"} by ${actor}${rule ? " and rule #" + rule.id + " saved" : ""}`);
  emit("approval", { approval: publicApproval(updated) });
  return rule ? { approval: publicApproval(updated), rule } : publicApproval(updated);
}

function expireApproval(approvalId) {
  const a = approvals.get(approvalId);
  if (!a) return;
  const mins = Math.round(cfg.approval_timeout_s / 60);
  answer(approvalId, false, `Nobody answered the approval request within ${mins} minute${mins === 1 ? "" : "s"}, so it was denied by default. Do not retry it; tell the user it is waiting for their approval.`);
  const row = ledger.updateApproval(approvalId, { status: "expired", decided_at: now(), decided_by: "timeout" });
  recordDeniedDelegation(a, row, "approval timed out");
  log(`approval #${approvalId} expired`);
  emit("approval", { approval: publicApproval(row) });
}

function onControlCancel(ev) {
  const aid = requestToApproval.get(ev.request_id);
  if (!aid) return;
  const a = approvals.get(aid);
  if (a) clearTimeout(a.timer);
  approvals.delete(aid);
  requestToApproval.delete(ev.request_id);
  // The CLI withdrew the question -- answered elsewhere (Remote Control) or
  // the turn was interrupted.
  const row = ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "withdrawn by the CLI (answered elsewhere or interrupted)" });
  emit("approval", { approval: publicApproval(row) });
}

/* ------------------------------------------------------------ delegations --- */

/** Publish a delegation change, after letting its mission step follow it. */
function emitDelegation(d) {
  if (!d) return;
  features.hooks.onDelegation(d);
  emit("delegation", { delegation: publicDelegation(ledger.get("delegations", d.id) || d) });
}

function currentTurnId() {
  return turns.running ? turns.running.id : null;
}

/** A live session by session id, then pid, then a UNIQUE normalised name (lib/targets.js); namesakes -> null. */
function findSession({ name, pid, sessionId }) {
  return targets.findTarget(sessionsCache.list || [], { sessionId, pid, name }).session;
}

// What ListAgents last showed MINT AI: its refs ("Name [ref]" -> name, local / remote) and sub-agent ids,
// so a SendMessage target is named, and its kind known, even when it is not a process on this machine.
let agentRefs = {};
let agentSubagents = [];
function onListAgents(msg) {
  const r = msg.tool_response;
  const text = typeof r === "string" ? r : Array.isArray(r) ? contentText(r) : r && typeof r === "object" ? String(r.text || r.content || JSON.stringify(r)) : "";
  const parsed = targets.parseListAgents(text);
  if (Object.keys(parsed.refs).length || parsed.subagents.length) {
    agentRefs = { ...agentRefs, ...parsed.refs };
    agentSubagents = Array.from(new Set(agentSubagents.concat(parsed.subagents))).slice(-200);
  }
  refreshSessions();
}

function onHookEvent(msg) {
  const ours = readState().session_id;
  if (!msg || (msg.session_id && ours && msg.session_id !== ours)) return; // someone else working in /root/moni-ai
  if (features.hooks.onHook(msg)) return;
  if (msg.event === "PostToolUse" && msg.tool_name === "SendMessage") return onSendMessageResult(msg);
  if (msg.event === "UserPromptSubmit") return onInboundPrompt(msg.prompt);
  if (msg.event === "PostToolUse" && msg.tool_name === "ListAgents") return onListAgents(msg);
}

function parseToolResponse(r) {
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const text = Array.isArray(r) ? contentText(r) : String(r || "");
  try {
    return JSON.parse(text);
  } catch (_) {
    return { success: !/error|fail|not found|refus/i.test(text), message: text };
  }
}

function onSendMessageResult(msg) {
  const input = msg.tool_input || {};
  const resp = parseToolResponse(msg.tool_response);
  const to = String(input.to || "");
  const name = peers.bareName(to);
  // The ref ListAgents gave ("Name [ref]") names the session even after a rename; a sub-agent id or a
  // Remote Control ref is never pinned to a local process.
  const ref = targets.refOf(to);
  const known = ref ? agentRefs[ref] : null;
  const lookName = known && known.name ? known.name : name;
  const pre = targets.kindFor({ to, refs: agentRefs, subagents: agentSubagents });
  const target = pre === "subagent" || pre === "remote" ? null : findSession({ name: lookName }) || (lookName !== name ? findSession({ name }) : null);
  const kind = targets.kindFor({ to, refs: agentRefs, subagents: agentSubagents, session: target });
  const ok = resp.success !== false && !!resp.msg_id;
  const d = ledger.addDelegation({
    msg_id: resp.msg_id || null,
    tool_use_id: msg.tool_use_id,
    turn_id: currentTurnId(),
    target: to,
    target_name: name,
    target_pid: target ? target.pid : null,
    target_session: target ? target.session_id : null,
    target_kind: kind,
    target_ref: ref,
    text: String(input.message || ""),
    summary: input.summary || null,
    notify_idle: !!input.notify_when_idle,
    status: ok ? "sent" : "failed",
    note: ok ? null : clip(resp.message || resp.error || "SendMessage failed", 500),
  });
  if (d) emitDelegation(d);
  // Unknown or ambiguous name: look at the sessions again first, then pin it only if it is now unique.
  if (d && !target && kind !== "subagent" && kind !== "remote") {
    refreshSessions(() => {
      const t = findSession({ name: lookName }) || (lookName !== name ? findSession({ name }) : null);
      if (!t) return;
      const cur = ledger.get("delegations", d.id);
      if (!cur || cur.target_session || cur.target_pid) return;
      const upd = ledger.updateDelegation(d.id, { target_pid: t.pid, target_session: t.session_id, target_kind: "local" });
      if (upd) emitDelegation(upd);
    });
  } else refreshSessions();
}

function onInboundPrompt(prompt) {
  for (const p of peers.parsePrompt(prompt)) {
    const open = ledger.openDelegationsFor({ pid: p.from_pid, name: p.from_name });
    const d = open[0] || null;
    const row = ledger.addInbound({ kind: p.kind, from_name: p.from_name, from_pid: p.from_pid, text: clip(p.text, 20000), delegation_id: d && d.id });
    emit("inbound", { inbound: row, state: p.state || null });
    if (!d) continue;
    let upd = null;
    if (p.kind === "message") {
      upd = ledger.updateDelegation(d.id, {
        status: "ack",
        replied_at: now(),
        reply_text: clip(((d.reply_text ? d.reply_text + "\n\n" : "") + p.text), 20000),
        working_at: d.working_at || now(),
      });
    } else if (p.kind === "idle") {
      upd =
        p.state === "expired"
          ? ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: "idle subscription expired without a signal" })
          : ledger.updateDelegation(d.id, { status: "done", done_at: now(), note: p.state === "exited" ? "session exited" : "idle notice", reply_text: d.reply_text || clip(p.text, 20000) });
    } else if (p.kind === "delivery") {
      upd =
        p.state === "refused"
          ? ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: clip(p.text, 500) })
          : p.state === "held"
          ? ledger.updateDelegation(d.id, { status: "held", note: "held by the target for its user's approval" })
          : null;
    }
    if (upd) emitDelegation(upd);
  }
}

/* --------------------------------------------------------------- sessions --- */

let sessionsBusy = false;
let lastSessionsSig = "";

function readRegistry() {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        if (r.pid) out.set(r.pid, r);
      } catch (_) {
        /* half-written */
      }
    }
  } catch (_) {
    /* none */
  }
  return out;
}

function where(reg, kind) {
  if (!reg) return kind || "session";
  if (reg.entrypoint === "claude-desktop") return reg.bridgeSessionId ? "Claude Desktop · Remote Control" : "Claude Desktop";
  if (reg.entrypoint === "sdk-cli") return reg.bridgeSessionId ? "Headless · Remote Control" : "Headless";
  if (reg.entrypoint === "cli") return reg.bridgeSessionId ? "Terminal · Remote Control" : "Terminal";
  return reg.entrypoint || kind || "session";
}

/**
 * Sub-agents run inside their parent session's own CLI process (spawned via
 * the Agent/Task tool) and never register in ~/.claude/sessions, so
 * `claude agents --json` never sees them. The only outside sign of one at
 * work is its own transcript file under the parent session's `subagents/`
 * directory, growing without a final answer yet -- the same evidence the
 * dashboard's `cc-running` privileged helper reads for /claude/running
 * (moni-helper `cc_subagents`/`cc_running`). This supervisor runs as root
 * with HOME=/root already, so it can read these files directly with no
 * helper hop.
 */
const SUBAGENT_FILE_RE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
const SUBAGENT_SLUG_RE = /^[A-Za-z0-9_.-]{1,255}$/;
const SUBAGENT_RUNNING_WINDOW_S = 120; // a subagent file written this recently may still be working

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** done | running | stopped, from the last assistant record's stop reason. */
function subagentStatus(filePath, mtimeMs) {
  const recent = (Date.now() - mtimeMs) / 1000 < SUBAGENT_RUNNING_WINDOW_S;
  let tail;
  try {
    tail = readTail(filePath, 128 * 1024);
  } catch (_) {
    return recent ? "running" : "stopped";
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (rec.type === "assistant") {
      const stop = rec.message && rec.message.stop_reason;
      return stop === "end_turn" ? "done" : recent ? "running" : "stopped";
    }
  }
  return recent ? "running" : "stopped";
}

/** Every sub-agent transcript under one session directory, newest last. */
function sessionSubagents(sdir) {
  const adir = path.join(sdir, "subagents");
  let names;
  try {
    if (!fs.lstatSync(adir).isDirectory()) return [];
    names = fs.readdirSync(adir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = SUBAGENT_FILE_RE.exec(name);
    if (!m) continue;
    const p = path.join(adir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    let meta = {};
    try {
      const mp = path.join(adir, `agent-${m[1]}.meta.json`);
      const mst = fs.lstatSync(mp);
      if (mst.isFile()) meta = JSON.parse(fs.readFileSync(mp, "utf8")) || {};
    } catch (_) {
      /* no meta yet, or unreadable -- name/description just come back null */
    }
    out.push({
      id: m[1],
      type: meta.agentType || null,
      description: meta.description || null,
      background: meta.requestShape === "background",
      bytes: st.size,
      modified: st.mtime.toISOString(),
      status: subagentStatus(p, st.mtimeMs),
    });
  }
  out.sort((a, b) => a.modified.localeCompare(b.modified));
  return out;
}

/**
 * A cheap snapshot poll (not a tail of every transcript continuously): walk
 * every session directory under ~/.claude/projects once, keep only sub-agents
 * still "running", keyed by their parent session's id. Cost is one readdir
 * per project + per session + per subagents dir, which on this box is a few
 * hundred entries -- fine on the same 5s cadence as refreshSessions.
 */
function refreshSubagents() {
  const bySession = new Map();
  let slugs;
  try {
    slugs = fs.readdirSync(PROJECTS_DIR);
  } catch (_) {
    subagentsCache = bySession;
    return;
  }
  for (const slug of slugs) {
    if (!SUBAGENT_SLUG_RE.test(slug)) continue;
    const pdir = path.join(PROJECTS_DIR, slug);
    let sessDirs;
    try {
      if (!fs.lstatSync(pdir).isDirectory()) continue;
      sessDirs = fs.readdirSync(pdir);
    } catch (_) {
      continue;
    }
    for (const sess of sessDirs) {
      if (!SUBAGENT_SLUG_RE.test(sess)) continue; // real session ids are UUIDs; the same charset guard is enough
      const agents = sessionSubagents(path.join(pdir, sess)).filter((a) => a.status === "running");
      if (agents.length) bySession.set(sess, agents);
    }
  }
  subagentsCache = bySession;
}

const sessionsWaiters = [];
/** Re-read the sessions; `then` (optional) runs once the cache has the new list (or the read failed). */
function refreshSessions(then) {
  if (typeof then === "function") sessionsWaiters.push(then);
  if (sessionsBusy) return;
  sessionsBusy = true;
  const done = () => {
    for (const fn of sessionsWaiters.splice(0)) {
      try {
        fn();
      } catch (e) {
        log("sessions waiter: " + e.message);
      }
    }
  };
  refreshSubagents();
  execFile(cfg.cli, ["agents", "--json"], { timeout: 20000, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    sessionsBusy = false;
    if (err) {
      sessionsCache = { ...sessionsCache, error: err.message };
      return done();
    }
    let list;
    try {
      list = JSON.parse(stdout);
    } catch (e) {
      sessionsCache = { ...sessionsCache, error: "could not parse claude agents --json" };
      return done();
    }
    const reg = readRegistry();
    const ours = readState().session_id;
    const merged = list.map((a) => {
      const r = reg.get(a.pid);
      return {
        pid: a.pid,
        session_id: a.sessionId,
        name: a.name || null,
        cwd: a.cwd || null,
        kind: a.kind || null,
        status: a.status || null,
        waiting_for: a.waitingFor || null,
        started_at: a.startedAt ? new Date(a.startedAt).toISOString() : null,
        status_since: r && r.statusUpdatedAt ? new Date(r.statusUpdatedAt).toISOString() : null,
        where: where(r, a.kind),
        cli_version: r ? r.version : null,
        remote_control: !!(r && r.bridgeSessionId),
        self: a.sessionId === ours || a.pid === proc.pid,
      };
    });
    // Our own session is found by id / pid. Failing that (a state file not yet
    // written after a fresh start), the session in our home directory carrying
    // one of our names -- MINT AI, or MONI AI before the rename -- is us.
    if (!merged.some((s) => s.self)) {
      const byName = merged.find((s) => names.isSelfName(s.name) && s.cwd === cfg.cwd);
      if (byName) byName.self = true;
    }
    sessionsCache = { at: now(), list: merged, error: null };
    features.hooks.onSessions(merged);
    advanceDelegations(merged);
    const sig = JSON.stringify(
      merged.map((s) => [
        s.pid,
        s.status,
        s.name,
        s.waiting_for,
        (subagentsCache.get(s.session_id) || []).map((a) => [a.id, a.status]),
        // the mission tint and cost change without the session changing
        JSON.stringify(features.sessionExtras(s)),
      ])
    );
    if (sig !== lastSessionsSig) {
      lastSessionsSig = sig;
      emit("sessions", { sessions: sessionsWithLedger() });
    }
    done();
  });
}

/**
 * Move open delegations along from what the sessions list shows: a target seen
 * busy is working; one that has gone idle since we sent is done; one that has
 * vanished failed.
 */
function advanceDelegations(list) {
  for (const d of ledger.openDelegations()) {
    // Session id, then pid, then a unique normalised name (lib/targets.js).
    const s = targets.openTarget(d, list);
    let upd = null;
    if (!s) {
      // Only a local session we had pinned can be "no longer running"; a remote, sub-agent or unknown
      // target is not in this machine's list at all -- it stays sent until its ack or idle notice.
      if (targets.mayFail(d)) upd = ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: "the target session is no longer running" });
    } else if (s.status === "busy" || s.status === "waiting") {
      // (Never pins target_pid from a name match: a namesake could be the wrong one.)
      if (d.status === "sent") upd = ledger.updateDelegation(d.id, { status: "working", working_at: now() });
    } else if (s.status === "idle") {
      const since = s.status_since ? Date.parse(s.status_since) : 0;
      const sent = Date.parse(d.created_at);
      if ((d.status === "working" || d.status === "ack") || (d.status === "sent" && since > sent + 500)) {
        upd = ledger.updateDelegation(d.id, { status: "done", done_at: now(), note: d.note || "target went idle" });
      }
    }
    if (upd) emitDelegation(upd);
  }
}

function sessionsWithLedger() {
  return (sessionsCache.list || []).map((s) => {
    // By session id first (a restart -- a new pid -- keeps them), then pid, then the name for rows that pinned neither.
    const MATCH = "(target_session = @sid OR (target_session IS NULL AND (target_pid = @pid OR (target_pid IS NULL AND target_name = @name))))";
    const args = { sid: s.session_id || "", pid: s.pid || -1, name: s.name || "" };
    const last = ledger.prep(`SELECT * FROM delegations WHERE ${MATCH} ORDER BY id DESC LIMIT 1`).get(args);
    const open = ledger.prep(`SELECT count(*) AS n FROM delegations WHERE status IN ('sent','working','ack','held') AND ${MATCH}`).get(args).n;
    const today = ledger.prep(`SELECT count(*) AS n FROM delegations WHERE created_at >= @since AND ${MATCH}`).get({ ...args, since: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }).n;
    return {
      ...s,
      open_delegations: open,
      delegations_today: today,
      last_delegation: last ? publicDelegation(last) : null,
      subagents: (s.session_id && subagentsCache.get(s.session_id)) || [],
      ...features.sessionExtras(s),
    };
  });
}

/* ----------------------------------------------------------------- vitals --- */

let cpuPrev = null;
function vitals() {
  const cpus = os.cpus();
  const tot = cpus.reduce(
    (a, c) => {
      const t = Object.values(c.times).reduce((x, y) => x + y, 0);
      return { idle: a.idle + c.times.idle, total: a.total + t };
    },
    { idle: 0, total: 0 }
  );
  let cpu = null;
  if (cpuPrev) {
    const dt = tot.total - cpuPrev.total;
    cpu = dt > 0 ? Math.round(100 * (1 - (tot.idle - cpuPrev.idle) / dt)) : null;
  }
  cpuPrev = tot;
  let memTotal = os.totalmem();
  let memAvail = os.freemem();
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+)/.exec(mi);
    if (m) memAvail = Number(m[1]) * 1024;
  } catch (_) {
    /* fall back to freemem */
  }
  let disk = null;
  try {
    const s = fs.statfsSync("/");
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, pct: Math.round(100 * (1 - s.bavail / s.blocks)) };
  } catch (_) {
    /* no statfs */
  }
  return {
    cpu_pct: cpu,
    cpus: cpus.length,
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    mem: { total: memTotal, available: memAvail, pct: Math.round(100 * (1 - memAvail / memTotal)) },
    disk,
    uptime_s: Math.round(os.uptime()),
    host: os.hostname(),
  };
}
let vitalsCache = vitals();

const features = createFeatures({
  ledger,
  cfg,
  emit,
  queueTurn: (t) => queueTurn(t),
  log,
  warn,
  vitals: () => vitalsCache,
  sessions: () => sessionsCache.list || [],
  sessionsWithLedger: () => sessionsWithLedger(),
  selfSessionId: () => readState().session_id || null,
  selfSessionIds: () => selfSessionIds(),
  currentTurnId: () => (turns.running ? turns.running.id : null),
  projectsDir: PROJECTS_DIR,
  describeTool: (n, i) => describeTool(n, i),
});

/* ------------------------------------------------------------ public views --- */

function publicTurn(row) {
  if (!row) return null;
  return { id: row.id, source: row.source, actor: row.actor, text: row.text, target: row.target, status: row.status, created_at: row.created_at, started_at: row.started_at, ended_at: row.ended_at, duration_ms: row.duration_ms, cost_usd: row.cost_usd, cost_delta_usd: row.cost_delta_usd == null ? null : row.cost_delta_usd, result_text: row.result_text, error: row.error, order_id: row.order_id || null, mission_id: row.mission_id || null, decision_id: row.decision_id || null };
}
function publicDelegation(d) {
  if (!d) return null;
  const { tool_use_id, ...rest } = d;
  return rest;
}
function publicApproval(a) {
  if (!a) return null;
  let input = null;
  try {
    input = JSON.parse(a.input_json);
  } catch (_) {
    input = a.input_json;
  }
  const { input_json, ...rest } = a;
  return { ...rest, input, ...features.approvalExtras({ ...a, input }) };
}

function status() {
  const st = readState();
  return {
    name: cfg.name,
    process: {
      state: proc.state,
      pid: proc.pid,
      started_at: proc.startedAt,
      ready_at: proc.readyAt,
      restarts: proc.restarts,
      last_exit: proc.lastExit,
      error: proc.error,
      cli: cfg.cli,
      cli_version: proc.cliVersion,
      cli_pinned: cfg.cli_version,
      model: cfg.model,
      effort: cfg.effort,
      permission_mode: cfg.permission_mode,
    },
    session_id: st.session_id || null,
    session_created_at: st.created_at || null,
    previous_session_id: st.previous_session_id || null,
    init: st.last_init || null,
    busy: !!turns.running,
    current_turn: turns.running ? { ...publicTurn(ledger.get("turns", turns.running.id)), steps: turns.running.steps } : null,
    queued: turnQueue.order(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000).map((p) => ({ ...publicTurn(p.row), priority: turnQueue.classOf(p.row) })),
    remote_control: { enabled: rc.enabled, state: rc.state, url: rc.enabled ? rc.url : null, error: rc.error },
    approvals: ledger.pendingApprovals().map(publicApproval),
    counts: { ...ledger.counts(), ...features.counts() },
    machine: features.machine(),
    cost_today: features.costToday(),
    vitals: vitalsCache,
    sessions_at: sessionsCache.at,
    approval_timeout_s: cfg.approval_timeout_s,
    delegation_allow: cfg.delegation_allow,
    seq,
  };
}

/**
 * The voice front desk's read-only snapshot (lib/snapshot.js). `turns` are the
 * desk's own earlier requests: only voice-desk turns by this same actor are
 * returned, so one panel user cannot read another's.
 */
function snapshotFor(actor, turnIds) {
  const m = features.machine();
  let requests;
  if (turnIds && turnIds.length) {
    requests = turnIds
      .map((id) => ledger.get("turns", id))
      .filter((r) => r && r.source === "voice-desk" && r.actor === actor);
  }
  return buildSnapshot({
    now: now(),
    host: m.host,
    vitals: vitalsCache,
    services: features.serviceList(),
    servicesAt: m.services.at,
    servicesError: m.services.error,
    sessions: sessionsCache.list || [],
    process: { state: proc.state, busy: !!turns.running, queued: turns.pending.length },
    missions: features.missions.list({ status: "active", limit: 10 }),
    decisions: features.ops.decisions({ status: "open", limit: 50 }).decisions,
    approvals: ledger.pendingApprovals(),
    requests,
  });
}

/* ------------------------------------------------------------------ socket --- */

async function handle(req, sock) {
  const p = req.params;
  switch (req.op) {
    case "ping":
      return { pong: true, at: now() };
    case "status":
      return status();
    case "sessions":
      if (!sessionsCache.at) await new Promise((r) => setTimeout(r, 400));
      return { at: sessionsCache.at, error: sessionsCache.error, sessions: sessionsWithLedger() };
    case "snapshot":
      return snapshotFor(req.actor, p.turns);
    case "rc-url":
      return { enabled: rc.enabled, state: rc.state, url: rc.enabled ? rc.url : null, bridge_session_id: rc.enabled ? rc.bridgeSessionId : null };
    case "ledger":
      return {
        table: p.table,
        rows: ledger
          .list(p.table, p)
          .map((r) => (p.table === "approvals" ? publicApproval(r) : p.table === "delegations" ? publicDelegation(r) : r))
          .map(redactDeep),
      };
    case "events": {
      const since = p.since || 0;
      sock.write(protocol.reply(req.id, { subscribed: true, seq }));
      for (const ev of ring) if (ev.seq > since) sock.write(JSON.stringify({ event: ev }) + "\n");
      viewers.add(sock);
      sock.on("close", () => viewers.delete(sock));
      return undefined; // reply already written
    }
    case "send": {
      // Addressed to the assistant itself by any of its names (MINT AI, or the
      // old MONI AI during the transition): that is no delegation, just a turn.
      const target = p.target && !names.isSelfName(p.target) ? p.target : "auto";
      if (target !== "auto") {
        const live = (sessionsCache.list || []).some((s) => s.name === target && !s.self);
        if (!live) throw new Error(`no live session is named "${target}"`);
      }
      const turn = queueTurn({ source: p.via === "voice-desk" ? "voice-desk" : "dashboard", actor: req.actor, text: p.text, target: target !== "auto" ? target : null, ut: p.ut });
      // How many turns go before this one: whatever is running or handed
      // over, plus the user turns queued ahead of it (background ones wait).
      const ahead = turnQueue.order(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000).findIndex((q) => q.row.id === turn.id);
      const current = turns.inflight && turns.inflight.id !== turn.id ? 1 : turns.running ? 1 : 0;
      return { turn, process: proc.state, queued_behind: (ahead > 0 ? ahead : 0) + current };
    }
    case "interrupt": {
      if (!proc.child) throw new Error("MINT AI is not running");
      await sendControl({ subtype: "interrupt" }, 15000);
      emit("notice", { level: "info", text: `Interrupted by ${req.actor}` });
      return { interrupted: true };
    }
    case "approve": {
      if (p.rule_pattern !== undefined || p.rule_tool !== undefined) {
        if (!p.rule_pattern || !p.rule_tool) throw new Error("an always-allow rule needs rule_pattern and rule_tool");
        return decide(p.approval_id, true, req.actor, p.note, { pattern: p.rule_pattern, tool: p.rule_tool });
      }
      return { approval: decide(p.approval_id, true, req.actor, p.note) };
    }
    case "deny":
      return { approval: decide(p.approval_id, false, req.actor, p.note) };
    case "rc":
      if (!proc.child || proc.state !== "ready") throw new Error("MINT AI is not running");
      return await enableRemoteControl(p.enabled, req.actor);
    case "restart": {
      emit("notice", { level: "warn", text: `Restart requested by ${req.actor}` });
      proc.backoff = cfg.backoff_min_s;
      await stopChild();
      // Resume only now that the old process is gone.
      proc.wantRunning = true;
      clearTimeout(proc.timer);
      await start();
      return { restarted: true, state: proc.state };
    }
    case "fresh":
      return await freshStart(req.actor, p);
    case "ui-action":
      return await uiAction(req.actor, p);
    case "ui-ack": {
      const w = uiWaiting.get(p.nonce);
      if (!w) throw new Error("no such screen action is waiting (or it was answered already)");
      if (w.actor !== req.actor) throw new Error("that screen action is not yours to answer");
      uiWaiting.delete(p.nonce);
      w.resolve({ ok: p.ok, why: p.why || "", pending: !!p.pending });
      return { acked: true };
    }
    default:
      if (Object.prototype.hasOwnProperty.call(features.ops, req.op)) return await features.ops[req.op](p, req);
      throw new Error("unknown op");
  }
}

/* ---------------------------------------------------------- UI control --- */

/*
 * MINT AI's ui_do (its MCP tool; ui_action until M-5) (UI control, Phase 2). The Command Center mints a
 * one-time ui token for each send the administrator makes and the supervisor
 * keeps it with that turn, in memory. MINT AI's MCP tool asks for a screen
 * action; the supervisor accepts it only
 *   - from actor "moni-ai" (its own MCP tool),
 *   - while a turn the administrator started (source dashboard / voice-desk)
 *     is running and carries a token -- no watcher, order, scheduler, peer or
 *     Remote Control turn has one,
 *   - for an action on the shared allowlist (lib/ui-actions.js, the same file
 *     as the dashboard's public/ui-actions.js), within its rate limits;
 * then emits it live to the viewers (never into the ring: no replay). The
 * dashboard forwards it only to the tab that holds that token, the page does
 * it and answers (ui-ack). No answer in 5 s: "no Command Center open".
 */
async function uiAction(actor, p) {
  if (actor !== "moni-ai") throw new Error("ui-action is MINT AI's own tool (actor moni-ai)");
  const running = turns.running;
  if (!running) throw new Error("no turn is running: a screen action answers the administrator's own request, during it");
  const tok = uiTokens.get(running.id);
  if (!tok || (running.source !== "dashboard" && running.source !== "voice-desk")) throw new Error("this turn was not started by the administrator from the Command Center, so it cannot change their screen");
  const v = UiActions.validate(p.action, p.args || {});
  if (!v.ok) throw new Error(v.why);
  const lim = uiLimit.take(running.id, v.action, Date.now());
  if (lim) throw new Error(lim);
  const nonce = crypto.randomBytes(12).toString("hex");
  const toast = UiActions.toast(v.action, v.args);
  const answer = new Promise((resolve) => {
    uiWaiting.set(nonce, { actor: tok.actor, resolve });
    setTimeout(() => {
      if (uiWaiting.delete(nonce)) resolve(null);
    }, UI_ACK_MS).unref();
  });
  // The token itself never leaves this process again: viewers get a tag of it
  // (sha256, 16 hex), enough for the dashboard that minted it to match it.
  emitLive("ui", { actor: tok.actor, ut_tag: uiTag(tok.ut), nonce, action: v.action, args: v.args, toast, turn_id: running.id, expires: new Date(Date.now() + UI_ACK_MS).toISOString() });
  const a = await answer;
  if (!a) return { status: "no-screen", note: "No Command Center answered: the administrator's screen is not open. Tell them plainly; do not say it was done." };
  if (!a.ok) return { status: "refused", why: a.why || "the screen refused it", note: "Tell the administrator plainly that it was not done, and why." };
  if (a.pending) return { status: "confirm", note: "Nothing has changed yet: their screen asks them to confirm. Say so, and ask them to say yes or click Confirm; never say it is done." };
  return { status: "ok", done: toast };
}

/**
 * Start MINT AI in a new conversation: stop the CLI, retire its session id,
 * start with `--session-id <new>`. Never resumes the old id. Only a person may
 * ask for it -- not MINT AI itself (actor "moni-ai", its own MCP tools) nor
 * the supervisor's internal actors -- and not while it is working, has turns
 * waiting or approvals open, unless `force` says so.
 */
const FRESH_REFUSED_ACTORS = new Set(["moni-ai", "watcher", "supervisor", "flag-file", "scheduler", "order"]);
let freshBusy = false;
async function freshStart(actor, p) {
  if (FRESH_REFUSED_ACTORS.has(actor)) throw new Error(`a fresh start is for the administrator; actor "${actor}" may not ask for one`);
  if (freshBusy) throw new Error("a fresh start is already under way");
  if (!p.force) {
    const why = [];
    if (turns.running) why.push("a turn is running");
    if (turns.inflight) why.push("a turn is being handed over");
    if (turns.pending.length) why.push(`${turns.pending.length} turn(s) queued`);
    const open = ledger.pendingApprovals().length;
    if (open) why.push(`${open} approval(s) pending`);
    if (why.length) throw new Error(`MINT AI is not idle (${why.join(", ")}); wait, or pass force`);
  }
  freshBusy = true;
  try {
    emit("notice", { level: "warn", text: `Fresh start requested by ${actor}` });
    proc.backoff = cfg.backoff_min_s;
    // Nothing may restart the old session while it is being retired.
    proc.wantRunning = false;
    clearTimeout(proc.timer);
    await stopChild();
    const r = rotateSession(actor, p.reason);
    proc.wantRunning = true;
    clearTimeout(proc.timer);
    await start();
    return { fresh: true, ...r, state: proc.state };
  } finally {
    proc.wantRunning = true;
    freshBusy = false;
  }
}

function serveControl() {
  try {
    fs.unlinkSync(CONTROL_SOCKET);
  } catch (_) {
    /* not there */
  }
  let gid = null;
  try {
    const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith(cfg.socket_group + ":"));
    gid = line ? Number(line.split(":")[2]) : null;
  } catch (_) {
    /* no group file? */
  }
  let conns = 0;
  const server = net.createServer((sock) => {
    if (conns >= 32) return sock.destroy();
    conns++;
    sock.on("close", () => conns--);
    sock.on("error", () => {});
    sock.setEncoding("utf8");
    let buf = "";
    let inflight = 0;
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > protocol.MAX_LINE * 2) {
        sock.end(protocol.replyError(null, "request too large"));
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (++inflight > 16) {
          sock.end(protocol.replyError(null, "too many requests in flight"));
          return;
        }
        const parsed = protocol.parseRequest(line);
        if (!parsed.ok) {
          inflight--;
          sock.write(protocol.replyError(parsed.id, parsed.error));
          continue;
        }
        const req = parsed.req;
        Promise.resolve()
          .then(() => handle(req, sock))
          .then(
            (data) => {
              if (req.mutating) auditLine(req.actor, req.op, auditDetail(req), true);
              if (data !== undefined && !sock.destroyed) sock.write(protocol.reply(req.id, data));
            },
            (e) => {
              if (req.mutating) auditLine(req.actor, req.op, auditDetail(req), false, e.message);
              if (!sock.destroyed) sock.write(protocol.replyError(req.id, e.message));
            }
          )
          .finally(() => inflight--);
      }
    });
  });
  server.listen(CONTROL_SOCKET, () => {
    fs.chmodSync(CONTROL_SOCKET, 0o660);
    if (gid !== null) fs.chownSync(CONTROL_SOCKET, 0, gid);
    else warn(`group ${cfg.socket_group} does not exist; the socket is root-only`);
    log(`control socket ${CONTROL_SOCKET}`);
  });
  return server;
}

function auditDetail(req) {
  const p = { ...req.params };
  if (p.ut) p.ut = "(set)"; // the ui token is never written down
  if (typeof p.text === "string") p.text = clip(p.text, 300);
  return p;
}

function serveHooks() {
  try {
    fs.unlinkSync(HOOK_SOCKET);
  } catch (_) {
    /* not there */
  }
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      if (buf.length > 2 * 1024 * 1024) sock.destroy();
    });
    sock.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          onHookEvent(JSON.parse(line));
        } catch (e) {
          warn("hook event rejected:", e.message);
        }
      }
      sock.end();
    });
  });
  server.listen(HOOK_SOCKET, () => {
    fs.chmodSync(HOOK_SOCKET, 0o600);
  });
  return server;
}

/** Hook events that arrived while the supervisor was down. */
function drainSpool() {
  const spool = path.join(cfg.state_dir, "hook-spool.jsonl");
  let text = "";
  try {
    text = fs.readFileSync(spool, "utf8");
    fs.unlinkSync(spool);
  } catch (_) {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      onHookEvent(JSON.parse(line));
    } catch (_) {
      /* skip */
    }
  }
}

/* -------------------------------------------------------------------- main --- */

/**
 * The queue survives a supervisor restart: a turn of ours that was still
 * queued and never handed to the CLI (no sent_at) cannot have been answered,
 * so it goes back in the queue, in its old place. One that was handed over,
 * or was running, may or may not be in the resumed transcript -- replaying it
 * could run it twice -- so it is marked lost, as before. So is anything older
 * than queue_requeue_max_age_s.
 */
function requeueAfterRestart() {
  const t = now();
  const cutoff = Date.now() - cfg.queue_requeue_max_age_s * 1000;
  const rows = ledger.db.prepare("SELECT * FROM turns WHERE status IN ('queued','running') ORDER BY id").all();
  let kept = 0;
  for (const row of rows) {
    const fresh = Date.parse(row.created_at) >= cutoff;
    if (row.status === "queued" && !row.sent_at && OUR_SOURCES.has(row.source) && row.uuid && fresh) {
      turns.pending.push({ row, message: userMessage(row) });
      kept++;
    } else {
      ledger.updateTurn(row.id, { status: "lost", ended_at: t, error: row.status === "queued" && !fresh ? "too old to replay after a supervisor restart" : "supervisor restarted" });
    }
  }
  if (kept) log(`re-queued ${kept} turn(s) the previous supervisor had not handed over`);
}

async function main() {
  if (process.getuid && process.getuid() !== 0 && !process.env.MONI_AI_ALLOW_NONROOT) {
    throw new Error("moni-ai must run as root: MINT AI shares root's Claude session registry");
  }
  takeLock();
  fs.mkdirSync(cfg.run_dir, { recursive: true });
  try {
    const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith(cfg.socket_group + ":"));
    if (line) {
      fs.chownSync(cfg.run_dir, 0, Number(line.split(":")[2]));
      fs.chmodSync(cfg.run_dir, 0o750);
    }
  } catch (e) {
    warn("could not set run dir ownership:", e.message);
  }

  // Anything the previous supervisor left pending can no longer be answered.
  for (const a of ledger.pendingApprovals()) ledger.updateApproval(a.id, { status: "cancelled", decided_at: now(), note: "supervisor restarted" });
  requeueAfterRestart();

  const control = serveControl();
  const hooks = serveHooks();
  drainSpool();

  refreshSessions();
  const pollSessions = setInterval(refreshSessions, cfg.sessions_poll_s * 1000);
  const pollVitals = setInterval(() => {
    vitalsCache = vitals();
    emit("vitals", { vitals: vitalsCache });
  }, 5000);

  features.start();
  await start();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping`);
    proc.wantRunning = false;
    clearTimeout(proc.timer);
    clearInterval(pollSessions);
    clearInterval(pollVitals);
    features.stop();
    control.close();
    hooks.close();
    for (const v of viewers) v.destroy();
    await stopChild(15000);
    for (const f of [CONTROL_SOCKET, HOOK_SOCKET]) {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* gone */
      }
    }
    ledger.close();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(new Date().toISOString(), "FATAL", e.message);
    releaseLock();
    process.exit(1);
  });
}

