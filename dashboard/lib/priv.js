"use strict";
/**
 * Thin wrapper around the privileged helper.
 *
 * The dashboard process is unprivileged. Anything requiring root goes through
 * `sudo /usr/local/sbin/moni-helper <subcommand> [args...]`, which is the ONLY
 * command this user is permitted to run via sudo.
 *
 * Arguments are passed as an argv array to spawn -- never concatenated into a
 * shell string -- so user-supplied values cannot escape into a shell. Secrets
 * (bot tokens) and bulk text go over stdin instead of argv, because argv is
 * readable by any local user in /proc while the call runs.
 */

const { spawn } = require("child_process");

const HELPER = "/usr/local/sbin/moni-helper";
const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Patterns for secrets that must never reach a browser.
 *
 * The runtime is configured not to log bot tokens, but a log view is exactly
 * the wrong place to rely on a single upstream fix: any library that logs a
 * request URL at INFO puts a Telegram token straight into the journal, and from
 * there into a screenshot or a scrollback buffer. Redacting on the way out
 * costs nothing and does not depend on every dependency behaving.
 */
const SECRET_PATTERNS = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,60}\b/g, "«bot-token»"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "«anthropic-key»"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "«api-key»"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "«github-token»"],
];

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function callHelper(subcommand, args = [], opts = {}) {
  const { stdin = null, timeout = 20000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", HELPER, subcommand, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflow = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("the privileged helper timed out"));
      }
    }, timeout);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.on("data", (d) => {
      if (stdout.length > MAX_OUTPUT) {
        overflow = true;
        return;
      }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });

    child.on("error", (e) => finish(e));

    child.on("close", () => {
      if (overflow) return finish(new Error("helper produced too much output"));
      // The helper reports failure as JSON on stdout with a non-zero exit, so
      // parse stdout first and only fall back to the raw error.
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim().split("\n").pop());
      } catch (_) {
        /* not JSON -- fall through */
      }
      if (parsed && parsed.ok === false) return finish(new Error(parsed.error));
      if (parsed && parsed.ok === true) return finish(null, parsed.data);
      finish(new Error(stderr.trim() || "helper returned unparseable output"));
    });

    if (stdin != null) child.stdin.end(String(stdin));
    else child.stdin.end();
  });
}

module.exports = {
  callHelper,

  /* ---------------------------------------------------------------- keys -- */
  listAllKeys: () => callHelper("list-all-keys"),
  listKeys: (user) => callHelper("list-keys", [user]),
  addKey: (user, type, data, comment) =>
    callHelper("add-key", [user, type, data, comment]),
  removeKey: (user, fingerprint) => callHelper("remove-key", [user, fingerprint]),
  status: () => callHelper("status"),
  auditTail: (n = 100) => callHelper("audit-tail", [String(n)]),

  /* -------------------------------------------------------------- agents -- */
  agentList: () => callHelper("agent-list", [], { timeout: 30000 }),
  agentGet: (slug) => callHelper("agent-get", [slug]),

  // Config carries the bot token, so it goes over stdin as JSON.
  agentCreate: (config) =>
    callHelper("agent-create", [], { stdin: JSON.stringify(config), timeout: 90000 }),
  agentUpdate: (config) =>
    callHelper("agent-update", [], { stdin: JSON.stringify(config), timeout: 90000 }),

  agentAction: (slug, action) =>
    callHelper("agent-action", [slug, action], { timeout: 60000 }),
  agentLogs: (slug, lines = 200) =>
    callHelper("agent-logs", [slug, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),
  agentDelete: (slug) => callHelper("agent-delete", [slug], { timeout: 60000 }),

  /* --------------------------------------------------------------- vault -- */
  agentReadFile: (slug, relpath) => callHelper("agent-read-file", [slug, relpath]),
  agentWriteFile: (slug, relpath, content) =>
    callHelper("agent-write-file", [slug, relpath], { stdin: content }),
  agentVaultList: (slug, subdir) =>
    callHelper("agent-vault-list", subdir ? [slug, subdir] : [slug]),

  /* -------------------------------------------------------------- memory -- */
  agentMemoryIndex: (slug, force = false) =>
    callHelper("agent-memory-index", force ? [slug, "--force"] : [slug], {
      timeout: 300000,
    }),
  agentMemorySearch: (slug, query) =>
    callHelper("agent-memory-search", [slug], { stdin: query, timeout: 120000 }),
  agentMemoryStats: (slug) => callHelper("agent-memory-stats", [slug]),

  /* ------------------------------------------------------------ channels -- */
  channelList: () => callHelper("channel-list", [], { timeout: 30000 }),
  channelGet: (slug) => callHelper("channel-get", [slug]),
  channelCreate: (config) =>
    callHelper("channel-create", [], {
      stdin: JSON.stringify(config),
      timeout: 90000,
    }),
  channelUpdate: (config) =>
    callHelper("channel-update", [], {
      stdin: JSON.stringify(config),
      timeout: 90000,
    }),
  channelDelete: (slug) => callHelper("channel-delete", [slug], { timeout: 60000 }),

  /* ------------------------------------------------------------ whatsapp -- */
  waStatus: (slug) => callHelper("channel-whatsapp-status", [slug]),
  waLink: (slug) => callHelper("channel-whatsapp-link", [slug], { timeout: 90000 }),
  waUnlink: (slug) => callHelper("channel-whatsapp-unlink", [slug], { timeout: 60000 }),
  waLogs: (slug, lines = 200) =>
    callHelper("channel-whatsapp-logs", [slug, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),

  /* ------------------------------------------------------------ services -- */
  serviceList: () => callHelper("service-list", [], { timeout: 30000 }),
  serviceAction: (unit, action) =>
    callHelper("service-action", [unit, action], { timeout: 60000 }),
  serviceLogs: (unit, lines = 200) =>
    callHelper("service-logs", [unit, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),

  /* --------------------------------------------------------- credentials -- */
  credentialList: () => callHelper("credential-list"),
  credentialGet: (name) => callHelper("credential-get", [name]),
  credentialSet: (name, key, value) =>
    callHelper("credential-set", [name, key], { stdin: value }),
  credentialClear: (name, key) => callHelper("credential-clear", [name, key]),

  /* -------------------------------------------------------------- console -- */

  /**
   * Open a long-lived console conversation and hand back the live process.
   *
   * Unlike every other call here this does not resolve with a parsed result.
   * The process stays up between turns -- that is where the conversation's
   * context lives, since `claude -p` persists no transcript to disk -- so the
   * caller writes each message into its stdin and reads events off its stdout
   * for as long as the chat is in use.
   *
   * The configuration goes over stdin rather than argv, and so does every
   * message after it: what the administrator types never appears in the
   * process table.
   */
  consoleOpen: (config) => {
    const child = spawn("sudo", ["-n", HELPER, "console-open"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(JSON.stringify(config) + "\n");
    return child;
  },

  consoleDirs: () => callHelper("console-dirs", [], { timeout: 15000 }),

  consoleUpload: (request) =>
    callHelper("console-upload", [], {
      stdin: JSON.stringify(request),
      timeout: 60000,
    }),

  // Whisper on a long recording is not quick, and the alternative to waiting is
  // an error the person cannot act on.
  consoleTranscribe: (path) =>
    callHelper("console-transcribe", [], {
      stdin: JSON.stringify({ path }),
      timeout: 300000,
    }),

  /* -------------------------------------------------------------- probes -- */
  systemProbe: () => callHelper("system-probe", [], { timeout: 30000 }),

  redact,
};
