#!/usr/bin/env node
"use strict";
/**
 * PreToolUse hook: MONI AI's destructive-action gate.
 *
 * Reads the tool call on stdin and decides it with lib/rules.js: the built-in
 * safety rules, the administrator's approval rules from the ledger (read-only)
 * and lib/classifier.js. Deny wins; built-in asks cannot be overridden; then
 * the most specific of the administrator's rules; then the classifier asks
 * about anything destructive.
 *
 *   ask   Claude Code sends the supervisor a can_use_tool request (MONI AI runs
 *         with --permission-prompt-tool stdio): an Approve / Deny card, and
 *         nobody answering means deny.
 *   allow an "Always allow this" rule matched: no card.
 *   deny  the model is told why.
 *
 * Fails closed: if the classifier throws, the call is asked about; if the
 * rules store exists but cannot be read, no allow rule applies and anything
 * the gate would have let through is asked about instead.
 * Prints nothing for a harmless call, so the normal permission flow applies.
 * A rule that matched is reported to the supervisor (its use count).
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const rules = require(path.join(__dirname, "..", "lib", "rules.js"));

function out(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

function readRules(cfg) {
  const file = path.join(cfg.state_dir || "/var/lib/moni-ai", "ledger.db");
  if (!fs.existsSync(file)) return { rows: [], error: null };
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    try {
      return { rows: db.prepare("SELECT * FROM rules").all(), error: null };
    } finally {
      db.close();
    }
  } catch (e) {
    if (/no such table/.test(e.message)) return { rows: [], error: null };
    return { rows: [], error: e };
  }
}

function report(sessionId, r) {
  return new Promise((resolve) => {
    const sock = process.env.MONI_AI_HOOK_SOCKET;
    if (!sock || !(r.rule || r.builtin)) return resolve();
    const msg = { event: "RuleHit", session_id: sessionId, rule_id: r.rule ? r.rule.id : null, builtin: r.builtin || null, at: new Date().toISOString() };
    const timer = setTimeout(resolve, 1000);
    const s = net.createConnection(sock, () => s.end(JSON.stringify(msg) + "\n"));
    s.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    s.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  try {
    const ev = JSON.parse(raw || "{}");
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(process.env.MONI_AI_CONFIG || "/etc/moni-ai/config.json", "utf8"));
    } catch (_) {
      /* defaults */
    }
    const stored = readRules(cfg);
    const r = rules.evaluate(ev.tool_name, ev.tool_input, stored.rows, cfg);
    let decision = r.decision;
    let reason;
    if (stored.error && decision !== "deny" && decision !== "ask") {
      decision = "ask";
      reason = `MONI AI gate: the approval rules could not be read (${String(stored.error.message).slice(0, 100)}); asking to be safe.`;
    } else if (decision === "deny") reason = `MONI AI gate: ${r.explain} Do not retry it or route it through another session.`;
    else if (decision === "ask")
      reason = r.source === "classifier" && r.classifier ? `MONI AI gate · ${r.classifier.label}: ${r.classifier.reason}. Waiting for the administrator's approval.` : `MONI AI gate: ${r.explain} Waiting for the administrator's approval.`;
    else if (decision === "allow") reason = `MONI AI gate: ${r.explain}`;
    await report(ev.session_id, r);
    if (decision === "none") return process.exit(0);
    out(decision, reason);
    process.exit(0);
  } catch (e) {
    out("ask", "MONI AI gate could not classify this call (" + String(e.message).slice(0, 120) + "); asking to be safe.");
    process.exit(0);
  }
});
