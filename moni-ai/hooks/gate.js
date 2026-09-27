#!/usr/bin/env node
"use strict";
/**
 * PreToolUse hook: MONI AI's destructive-action gate.
 *
 * Reads the tool call on stdin and, when lib/classifier.js calls it
 * destructive, answers "ask". Claude Code then sends the supervisor a
 * can_use_tool request (MONI AI runs with --permission-prompt-tool stdio),
 * which becomes an Approve / Deny card; nobody answering means deny.
 *
 * Fails closed: if the classifier throws, the call is asked about.
 * Prints nothing for a harmless call, so the normal permission flow applies.
 */
const fs = require("fs");
const path = require("path");
const { gateDecision } = require(path.join(__dirname, "..", "lib", "classifier.js"));

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

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(raw || "{}");
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(process.env.MONI_AI_CONFIG || "/etc/moni-ai/config.json", "utf8"));
    } catch (_) {
      /* defaults */
    }
    const d = gateDecision(ev.tool_name, ev.tool_input, cfg);
    if (!d) return process.exit(0);
    const reason =
      d.decision === "deny"
        ? `MONI AI gate: ${d.label}. ${d.reason}.`
        : `MONI AI gate · ${d.label}: ${d.reason}. Waiting for the administrator's approval.`;
    out(d.decision, reason);
    process.exit(0);
  } catch (e) {
    out("ask", "MONI AI gate could not classify this call (" + String(e.message).slice(0, 120) + "); asking to be safe.");
    process.exit(0);
  }
});
