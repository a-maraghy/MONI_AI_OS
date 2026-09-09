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
    callHelper("agent-logs", [slug, String(lines)], { timeout: 40000 }),
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
};
