"use strict";
/**
 * The gate for a session MINT AI runs on one of the user's own computers
 * (Path A laptop control, 2026-10-08). Pure: the supervisor's machine-ask op
 * calls decide() for every permission question the laptop's Claude Code CLI
 * asks (relayed by the desktop app -> the dashboard -> here).
 *
 *   allow  answered at once (recorded in the action log, no card)
 *   ask    an approval card in Mint OS, attributed to the laptop session
 *   deny   refused, with the reason
 *
 * The laptop session's hands (screen, mouse, keyboard, UI Automation, the
 * browser, document creation) are the desktop app's own MCP tools; they are
 * pre-allowed in the CLI and gate themselves on the laptop (an active lease,
 * risky targets such as Send / Buy / Delete -> an approval with origin
 * "hands"). Those approvals come here too, as tool mcp__mint-hands__*: always
 * a card.
 *
 * What needs a card: deleting, installing, sending or posting over the
 * network, changing the system (services, registry, scheduled tasks, power),
 * writing outside the user's own files, reading the user's hidden or app data
 * folders. What is refused outright: wiping disks, switching off security,
 * obfuscated or downloaded-and-run code, credential dumping, elevation (UAC
 * prompts are for the user).
 *
 * "The user's own files": under their profile folder (ctx.home, from the
 * app's hello), not AppData, not a hidden (dot) folder, not NTUSER*.
 */

const HANDS_PREFIX = "mcp__mint-hands__";

/* -------------------------------------------------------------- paths --- */

/** "C:/Users/A/x" / "~\x" / "%USERPROFILE%\x" / "$env:USERPROFILE\x" -> "c:\users\a\x" (lower case, backslashes, no trailing \). */
function normPath(p, home) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  const h = String(home || "");
  if (h) {
    s = s.replace(/^~(?=[\\/]|$)/, h).replace(/^%userprofile%/i, h).replace(/^\$env:userprofile/i, h).replace(/^\$home(?=[\\/]|$)/i, h);
  }
  s = s.replace(/\//g, "\\").replace(/\\+/g, "\\");
  // Git Bash style /c/Users/A -> c:\users\a
  const gb = /^\\([a-z])(\\|$)/i.exec(s);
  if (gb) s = gb[1] + ":\\" + s.slice(3);
  const parts = [];
  for (const part of s.split("\\")) {
    if (part === "." || (part === "" && parts.length)) continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("\\").toLowerCase().replace(/\\$/, "");
}

/** Is `p` (absolute, or relative to the session's Documents folder) one of the user's own files? */
function inUserFiles(p, home) {
  if (!home) return false;
  const h = normPath(home, home);
  let n = normPath(p, home);
  if (!/^[a-z]:\\|^\\\\/.test(n)) n = normPath(home + "\\Documents\\" + p, home); // relative: the CLI's cwd
  if (n !== h && !n.startsWith(h + "\\")) return false;
  const rest = n.slice(h.length + 1).split("\\").filter(Boolean);
  if (!rest.length) return true;
  if (rest[0] === "appdata" || /^ntuser/.test(rest[0])) return false;
  return !rest.some((x) => x.startsWith("."));
}

/** Absolute Windows paths (and UNC paths) named in a command line. */
function pathsIn(cmd) {
  const out = [];
  const re = /(?:"([a-z]:[\\/][^"]*)"|'([a-z]:[\\/][^']*)'|(\\\\[^\s"'|;]+)|\b([a-z]:[\\/][^\s"'|;,)]*))/gi;
  let m;
  while ((m = re.exec(String(cmd || "")))) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}

/* ----------------------------------------------------------- commands --- */

const DENY = [
  [/\b(format(-volume)?\s|diskpart\b|bcdedit\b|vssadmin\s+delete|wbadmin\s+delete|cipher(\.exe)?\s+\/w|clear-disk\b|initialize-disk\b|remove-partition\b|mkfs\b|dd\s+if=)/i, "wipes a disk or the boot setup"],
  [/(set-mppreference\b[^|;]*-disable|add-mppreference\b[^|;]*-exclusion|disable-windowsoptionalfeature\b|set-netfirewallprofile\b[^|;]*-enabled\s+(false|0)|netsh\s+(adv)?firewall\b[^|;]*\b(off|disable))/i, "switches off security"],
  [/(-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{24,}|frombase64string\b[^|;]*\|\s*(iex|invoke-expression)\b)/i, "runs obfuscated code"],
  [/((iex|invoke-expression)\b[^;]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient|curl|wget)\b|\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^;]*\|\s*(iex|invoke-expression|bash|sh|powershell|pwsh)\b)/i, "downloads and runs code"],
  [/\b(mimikatz|vaultcmd|get-storedcredential|cmdkey\s+\/list|procdump[^|;]*lsass|reg(\.exe)?\s+save\s+hklm\\(sam|security|system))\b/i, "reads stored passwords"],
  [/(-verb\s+runas\b|\brunas(\.exe)?\s|\bsudo\s|\bgsudo\b)/i, "asks for administrator rights (a UAC prompt is for the user)"],
];

const ASK = [
  [/(^|[\s;|&(])(remove-item|ri|rm|rmdir|rd|del|erase|clear-recyclebin|remove-appxpackage)(\s|$)/i, "delete", "Delete files"],
  [/(\b(winget|choco|scoop)\s+(install|upgrade|uninstall|remove)\b|\bmsiexec\b|\binstall-(module|package|script)\b|\badd-appxpackage\b|\bnpm\s+(i|install|add)\b[^|;]*\s(-g|--global)\b|\bpip3?\s+install\b|\.msi\b|\bsetup\.exe\b|\buninstall(-package)?\b)/i, "install", "Install or remove software"],
  [/(\bsend-mailmessage\b|\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|;]*-(method\s+(post|put|patch|delete)|body|infile|form)\b|\bcurl(\.exe)?\b[^|;]*\s(-x\s*(post|put|patch|delete)|-d\b|--data|-f\b|--form|-t\b|--upload-file)|\b(ftp|scp|sftp|rsync)\s|\bnet\s+use\b|\bgit\s+push\b|\bgh\s+(pr|issue|release)\s+create\b)/i, "network", "Send data over the network"],
  [/(\b(stop-computer|restart-computer|shutdown|logoff|stop-process|taskkill|kill)\b|\b(set|new|remove)-itemproperty\b|\breg(\.exe)?\s+(add|delete|import|copy)\b|\b(set|stop|start|new|remove|restart)-service\b|\bsc(\.exe)?\s+(config|delete|create|stop|start)\b|\bschtasks\b|\b(register|unregister|set)-scheduledtask\b|\bset-executionpolicy\b|\bnetsh\b|\bset-netipaddress\b|\bnew-netfirewallrule\b|\bbitsadmin\b|\bwmic\b)/i, "system", "Change the system"],
];

// Verbs that write: a path outside the user's files after one of these needs a card.
const WRITE_VERB = /\b(new-item|ni|set-content|sc|add-content|ac|out-file|copy-item|copy|cp|cpi|move-item|move|mv|mi|rename-item|ren|rni|mkdir|md|expand-archive|compress-archive|tee-object|tee|export-csv|touch)\b|>>?/i;

/** One shell command line (PowerShell or Git Bash). */
function decideCommand(cmd, ctx) {
  const c = String(cmd || "");
  for (const [re, why] of DENY) if (re.test(c)) return { decision: "deny", category: "refused", label: "Refused on this computer", reason: `This command ${why}; MINT AI never does that on your computer.` };
  for (const [re, category, label] of ASK) if (re.test(c)) return { decision: "ask", category, label, reason: `${label}: needs your approval.` };
  if (WRITE_VERB.test(c)) {
    const outside = pathsIn(c).filter((p) => !inUserFiles(p, ctx.home));
    if (outside.length) return { decision: "ask", category: "outside", label: "Change files outside your own", reason: `It writes to ${outside.slice(0, 2).join(", ")}, outside your own files.` };
  }
  return { decision: "allow", category: "command", label: "Command on your computer", reason: null };
}

/* ------------------------------------------- approved deletes (2026-10-08) --- */
/*
 * The laptop session sometimes asks request_approval ("Delete the file X") and
 * then runs the delete -- which the gate would put on a second card. An
 * approved request_approval that names files to delete leaves a narrow
 * allowance on the supervisor (lib/machines.js keeps it: this lease's session
 * only, 5 minutes, each file once). The gate honours it only for a command
 * that does nothing but delete exactly those files (and, at most, check them
 * with Test-Path): one literal path per delete, no wildcards, no variables
 * other than the profile folder, no pipes, no redirection, no sub-commands,
 * no -Recurse. Anything else is a card as before; deny rules are checked
 * first and still win.
 */

const ALLOWANCE_MS = 5 * 60 * 1000;
const MAX_ALLOWED_PATHS = 10;
const DELETE_CMDS = new Set(["remove-item", "ri", "rm", "del", "erase"]);
const PROFILE_FOLDERS = new Set(["documents", "desktop", "downloads", "pictures", "music", "videos", "onedrive"]);
const WILDCARD = /[*?[\]]/;

/** Expand the profile-folder spellings and normalise against `base` when relative; null unless absolute. */
function absPath(p, home, base) {
  const raw = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!raw || !home || WILDCARD.test(raw)) return null;
  let n = normPath(raw, home);
  if (/[$%]/.test(n)) return null; // a variable other than the profile folder: its value is unknown here
  if (!/^[a-z]:\\|^\\\\/.test(n)) n = normPath(base + "\\" + raw, home);
  return /^[a-z]:\\./.test(n) ? n : null;
}

/**
 * A file an approval names, resolved as a person reads it: absolute, or under the profile
 * ("Documents\MINT AI\x.xlsx", "~\Desktop\a.txt"), else under Documents (the session's folder).
 * null unless it is one of the user's own files.
 */
function approvalPath(p, home) {
  const raw = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/[.\s]+$/, "");
  const first = raw.split(/[\\/]/)[0].toLowerCase();
  const n = absPath(raw, home, PROFILE_FOLDERS.has(first) ? home : home + "\\Documents");
  return n && inUserFiles(n, home) ? n : null;
}

/**
 * The deletes an approved request_approval allows, or null: its `delete_paths` (the app's
 * request_approval from 0.1.7) or, from an older app, a one-file summary "Delete the file <path>".
 */
function approvalScope(input, home) {
  const i = input && typeof input === "object" ? input : {};
  let list = null;
  if (Array.isArray(i.delete_paths) && i.delete_paths.length) {
    if (i.delete_paths.length > MAX_ALLOWED_PATHS || i.delete_paths.some((x) => typeof x !== "string")) return null;
    list = i.delete_paths;
  } else {
    const m = /^\s*delete\s+(?:the\s+)?(?:file\s+)?("[^"]+"|'[^']+'|[^"'\n]+?)\s*(?:\((?:only|just)\s+(?:that|this)\s+file\))?\s*\.?\s*$/i.exec(String(i.summary || i.action || ""));
    if (!m || /\s(and|or)\s|,|;/i.test(m[1])) return null; // one file, said plainly
    list = [m[1]];
  }
  const paths = list.map((p) => approvalPath(p, home));
  if (!paths.length || paths.some((p) => !p)) return null;
  return { kind: "delete", paths: [...new Set(paths)] };
}

/** A command line split into words (quoted words keep their content); null on unbalanced quotes. */
function words(stmt) {
  const out = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/y;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(stmt);
    if (!m || !m[0].trim()) break;
    out.push({ text: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3], quoted: m[3] === undefined });
    at = re.lastIndex;
  }
  return stmt.slice(at).trim() ? null : out;
}

/**
 * If the command does nothing but delete files (and check them with Test-Path), the files it
 * deletes (normalised); otherwise null. Paths are literal, one per statement, relative ones
 * resolved against Documents (the CLI's working folder).
 */
function deleteTargets(cmd, home) {
  const c = String(cmd || "");
  if (!home || /[|&`<>{}()@]|\$\(/.test(c)) return null;
  const stmts = c.split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!stmts.length || stmts.length > 2 * MAX_ALLOWED_PATHS) return null;
  const base = home + "\\Documents";
  const targets = [];
  for (const st of stmts) {
    const w = words(st);
    if (!w || !w.length || w[0].quoted) return null;
    const verb = w[0].text.toLowerCase();
    const isDelete = DELETE_CMDS.has(verb);
    if (!isDelete && verb !== "test-path") return null;
    const paths = [];
    for (let k = 1; k < w.length; k++) {
      const t = w[k];
      const f = t.quoted ? "" : t.text.toLowerCase();
      if (f === "-literalpath" || f === "-path") continue; // the next word is the path
      if (isDelete && (f === "-force" || f === "-f" || f === "-confirm:$false")) continue;
      if (f === "-erroraction" || f === "-ea") {
        const v = w[++k];
        if (!v || !/^(stop|silentlycontinue|continue|ignore)$/i.test(v.text)) return null;
        continue;
      }
      if (!isDelete && f === "-pathtype") {
        const v = w[++k];
        if (!v || !/^(leaf|any)$/i.test(v.text)) return null;
        continue;
      }
      if (f.startsWith("-")) return null; // -Recurse, -Include, -Filter ...: not a plain one-file delete
      const n = absPath(t.text, home, base);
      if (!n || !inUserFiles(n, home)) return null;
      paths.push(n);
    }
    if (paths.length !== 1) return null;
    if (isDelete) targets.push(paths[0]);
  }
  return targets.length ? targets : null;
}

/**
 * Does an allowance { paths, used: Set, expires_at: ms } cover this command? The files it would
 * use (each allowed, not used yet, named once), or null.
 */
function allowanceCovers(allowance, cmd, home, nowMs) {
  if (!allowance || !(nowMs <= allowance.expires_at)) return null;
  const t = deleteTargets(cmd, home);
  if (!t) return null;
  const uniq = [...new Set(t)];
  if (uniq.length !== t.length) return null;
  for (const p of uniq) if (!allowance.paths.includes(p) || allowance.used.has(p)) return null;
  return uniq;
}

/* ---------------------------------------------------------------- tools --- */

const ALWAYS_ALLOW = new Set(["TodoWrite", "Task", "Agent", "WebSearch", "ToolSearch", "ExitPlanMode", "EnterPlanMode", "TaskOutput", "KillShell", "BashOutput", "Skill", "SlashCommand", "AskUserQuestion"]);
const NEVER = new Set(["SendMessage", "CronCreate", "CronDelete", "RemoteTrigger", "ScheduleWakeup", "PushNotification"]);

/**
 * decide(tool, input, ctx) -> { decision: allow|ask|deny, category, label, reason }
 * ctx: { home: "C:\\Users\\name" } (the laptop's profile folder, from the app's hello), origin: "cli" | "hands".
 */
function decide(tool, input, ctx = {}) {
  const t = String(tool || "");
  const i = input && typeof input === "object" ? input : {};
  if (t.startsWith(HANDS_PREFIX) || ctx.origin === "hands") {
    // The hands found a risky target (Send, Buy, Delete ...) or the session asked request_approval: always a card.
    return { decision: "ask", category: "screen", label: "Act on your screen", reason: i.why ? String(i.why).slice(0, 500) : "MINT AI wants to do something on your screen that needs your approval." };
  }
  if (NEVER.has(t)) return { decision: "deny", category: "refused", label: "Not on this computer", reason: `${t} is not available to the laptop session; it reports to MINT AI with its final message.` };
  if (t.startsWith("mcp__")) return { decision: "deny", category: "refused", label: "Unknown tool", reason: "Only the desktop app's own tools are allowed on this computer." };
  if (t === "PowerShell" || t === "Bash" || t === "Monitor") return decideCommand(i.command || i.script || "", ctx);
  if (t === "Write" || t === "Edit" || t === "MultiEdit" || t === "NotebookEdit") {
    const p = i.file_path || i.notebook_path || i.path || "";
    if (p && inUserFiles(p, ctx.home)) return { decision: "allow", category: "file", label: "Write your files", reason: null };
    return { decision: "ask", category: "outside", label: "Change files outside your own", reason: `It writes ${p || "a file"}, outside your own files.` };
  }
  if (t === "Read" || t === "Glob" || t === "Grep" || t === "LS") {
    const p = i.file_path || i.path || "";
    if (!p || inUserFiles(p, ctx.home)) return { decision: "allow", category: "file", label: "Read your files", reason: null };
    return { decision: "ask", category: "outside", label: "Read outside your own files", reason: `It reads ${p}, outside your own files (app data, hidden folders or the system).` };
  }
  if (t === "WebFetch") return { decision: "ask", category: "network", label: "Fetch a web address", reason: `It fetches ${String(i.url || "a web page").slice(0, 300)}.` };
  if (ALWAYS_ALLOW.has(t)) return { decision: "allow", category: "tool", label: t, reason: null };
  return { decision: "ask", category: "unknown", label: "Needs permission", reason: `${t.slice(0, 80)} is not on the laptop session's list.` };
}

/** The card's one-line summary for a laptop question (never a secret: the supervisor redacts again). */
function summaryOf(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  if (String(tool).startsWith(HANDS_PREFIX)) return String(i.summary || tool.slice(HANDS_PREFIX.length)).slice(0, 500);
  if (typeof i.command === "string") return i.command.slice(0, 2000);
  if (i.file_path || i.path) return `${tool} ${i.file_path || i.path}`;
  if (i.url) return `${tool} ${i.url}`;
  return `${tool} ${JSON.stringify(i).slice(0, 500)}`;
}

module.exports = { HANDS_PREFIX, ALLOWANCE_MS, normPath, inUserFiles, pathsIn, decideCommand, decide, summaryOf, approvalPath, approvalScope, deleteTargets, allowanceCovers };
