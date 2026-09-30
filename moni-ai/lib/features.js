"use strict";
/**
 * Command Center v3, phase 1: missions, decisions and watchers, standing
 * orders, approval rules, cost, the machine card and the read-only session
 * mirror -- everything the supervisor does beyond running MINT AI's process.
 *
 * supervisor.js owns the process, the turns and the sockets; it hands this
 * module what it needs (deps) and calls back into it at a few points (a turn's
 * result and end, a delegation, an approval, a hook event). All state is in
 * the ledger, so a restart of the supervisor loses nothing here.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { now } = require("./ledger");
const rules = require("./rules");
const schedule = require("./schedule");
const cost = require("./cost");
const { Watchers, OPEN: OPEN_DECISION } = require("./watchers");
const { Missions } = require("./missions");
const names = require("./names");
const { redact, redactDeep, clip } = require("./redact");

const MORNING_BRIEFING = {
  seed_key: "morning-briefing",
  name: "Morning briefing",
  schedule: { kind: "daily", at: "07:30" },
  target: "moni-ai",
  prompt: [
    "Morning briefing for the administrator about THIS VPS only (vmi3567127). Read-only: change nothing.",
    "1. Services: `systemctl --failed --no-legend` and `systemctl is-active nginx ssh fail2ban ufw moni-dashboard odoo postgresql@16-main claude-memory moni-ai 'moni-agent@*'`.",
    "2. Disk and memory: `df -h /` and `free -m`.",
    "3. Failed sign-ins and bans since yesterday morning: count SSH failures in `journalctl -u ssh --since yesterday` and read `fail2ban-client status sshd`.",
    "4. Your own activity since the last briefing: `moni-ai-ctl ledger '{\"table\":\"turns\",\"limit\":50}'` and the delegations and approvals ledgers the same way.",
    "5. Missions: mission_list (or `moni-ai-ctl missions`).",
    "Stay on this VPS: do not reach any other server and do not use any live credential.",
    "Answer in at most six short lines, each starting with a bold label: **Services**, **Disk**, **Sign-ins**, **MINT AI**, **Missions**, **Needs you**. Lead with anything that needs the administrator.",
  ].join("\n"),
};

const TELEGRAM = {
  available: false,
  why: "Phase 1 delivers to the Command Center only: the Telegram agents keep their bot tokens to themselves and have no supported way to post on MINT AI's behalf yet.",
};

function createFeatures(deps) {
  const { ledger, cfg, emit, queueTurn, log, warn } = deps;
  const tz = cfg.tz || "Africa/Cairo";
  const dayOf = (ms) => schedule.dayOf(ms, tz);
  const missions = new Missions(ledger);
  const db = ledger.db;
  const timers = [];

  /* ============================================================ helpers === */

  function runHelper(sub, args = [], stdin = null, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!cfg.helper || !fs.existsSync(cfg.helper)) return reject(new Error("helper not installed"));
      const child = execFile(cfg.helper, [sub, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let j;
        try {
          j = JSON.parse(String(stdout).trim().split("\n").pop());
        } catch (_) {
          return reject(err || new Error("unreadable helper output"));
        }
        if (!j.ok) return reject(new Error(j.error || "helper refused"));
        resolve(j.data);
      });
      if (stdin !== null) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }

  const warned = new Set();
  function once(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(msg);
  }

  /* ============================================================ machine === */

  let services = { at: null, list: [], error: null };
  function machine() {
    const v = deps.vitals();
    const failed = services.list.filter((s) => s.active === "failed").map((s) => ({ unit: s.unit, since: s.since || null }));
    return {
      host: v.host,
      vitals: v,
      services: { total: services.list.length, up: services.list.filter((s) => s.active === "active").length, failed, at: services.at, error: services.error },
    };
  }

  /* ========================================================= decisions === */

  function publicDecision(d) {
    return d ? redactDeep({ ...d, rate_limited: !!d.rate_limited }) : null;
  }
  function emitDecision(d) {
    emit("decision", { decision: publicDecision(d) });
  }

  function investigate(d, extra) {
    const turn = queueTurn({
      source: "watcher",
      actor: "watcher",
      decision_id: d.id,
      text:
        `[Watcher: ${d.title} · decision #${d.id}]\n` +
        `${d.detail || d.title}\n` +
        (d.evidence ? `\nEvidence:\n\`\`\`\n${d.evidence}\n\`\`\`\n` : "") +
        (extra ? `\n${extra}\n` : "") +
        `\nInvestigate READ-ONLY (status, logs, config) on this VPS and find the likely cause. Do NOT fix anything now. ` +
        `Then call the moni-ai tool decision_propose with decision_id ${d.id}, a short summary of the cause, the evidence you relied on, ` +
        `and the exact fix command you propose (leave fix_command out if nothing needs doing). ` +
        `The administrator approves or dismisses it in the Decisions inbox; only then will you be asked to run the fix.`,
    });
    ledger.update("decisions", d.id, { turn_id: turn.id, status: "investigating", rate_limited: 0, updated_at: now() });
    return turn;
  }

  const watchers = new Watchers({
    ledger,
    cfg,
    onFire: (d, { investigate: go }) => {
      log(`watcher ${d.watcher} fired on ${d.subject}: decision #${d.id}${go ? "" : " (rate limited)"}`);
      if (go) investigate(d);
      emitDecision(ledger.get("decisions", d.id));
      emit("watcher", { watcher: watchers.get(d.watcher) });
    },
    onBump: (d) => emitDecision(d),
  });

  async function evidenceFor(key, subject) {
    if (key === "service_failed" || key === "agent_failing") {
      return new Promise((resolve) => {
        execFile("journalctl", ["-u", subject + ".service", "-n", "12", "--no-pager", "-o", "short-iso"], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, out) =>
          resolve(err ? null : clip(redact(String(out).trim()), 4000))
        );
      });
    }
    return null;
  }

  /** Fire with evidence gathered first (journal lines for a unit). */
  async function fireWithEvidence(results) {
    for (const r of results || []) {
      if (r && r.created && r.decision && !r.decision.evidence) {
        const ev = await evidenceFor(r.decision.watcher, r.decision.subject);
        if (ev) {
          ledger.update("decisions", r.decision.id, { evidence: ev });
          emitDecision(ledger.get("decisions", r.decision.id));
        }
      }
    }
  }

  let pulseCursor = null;
  let odoo = null;
  async function pollWatchers() {
    // services (also the machine card)
    try {
      const list = await runHelper("service-list");
      services = { at: now(), list: Array.isArray(list) ? list : [], error: null };
      await fireWithEvidence(watchers.observeServices(services.list));
    } catch (e) {
      services = { ...services, error: e.message };
      once("service-list", "watchers: service-list unavailable: " + e.message);
    }
    emit("machine", { machine: machine() });
    try {
      const out = await runHelper("pulse-feed", [], JSON.stringify({ cursor: pulseCursor }));
      pulseCursor = out.cursor || null;
      await fireWithEvidence(watchers.observeEvents(out.events || []));
    } catch (e) {
      once("pulse-feed", "watchers: pulse-feed unavailable: " + e.message);
    }
    watchers.observeDisk(deps.vitals().disk);
    try {
      watchers.observeOdooLines(readOdoo());
    } catch (e) {
      once("odoo-log", "watchers: the trial Odoo log is unreadable: " + e.message);
    }
  }

  /** New complete lines of the trial Odoo log; the first read starts at the end. */
  function readOdoo() {
    const file = cfg.odoo_log || "/var/log/odoo/odoo.log";
    const st = fs.statSync(file);
    if (!odoo || odoo.ino !== st.ino || odoo.off > st.size) {
      const first = !odoo;
      odoo = { ino: st.ino, off: first ? st.size : 0 };
      if (first) return [];
    }
    if (st.size <= odoo.off) return [];
    const len = Math.min(1024 * 1024, st.size - odoo.off);
    const start = st.size - len > odoo.off ? st.size - len : odoo.off;
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const end = buf.lastIndexOf(10);
    if (end < 0) return [];
    odoo.off = start + end + 1;
    return redact(buf.slice(0, end).toString("utf8")).split("\n");
  }

  function decisionOr404(id) {
    const d = ledger.get("decisions", id);
    if (!d) throw new Error("no such decision");
    return d;
  }

  /* =========================================================== orders === */

  function publicOrder(o) {
    if (!o) return null;
    let delivery = ["cc"];
    try {
      delivery = JSON.parse(o.delivery);
    } catch (_) {
      /* default */
    }
    return redactDeep({ ...o, paused: !!o.paused, delivery, label: schedule.label(o) });
  }
  function emitOrder(o) {
    emit("order", { order: publicOrder(o) });
  }

  function nextFor(o, fromMs) {
    if (o.paused) return null;
    const t = schedule.nextRun(o.cron, o.tz, fromMs);
    return t ? new Date(t).toISOString() : null;
  }

  function checkTarget(target) {
    if (target === "moni-ai" || names.isSelfName(target)) return "moni-ai"; // MINT AI, or its old name
    const live = (deps.sessions() || []).some((s) => s.name === target && !s.self);
    if (!live) throw new Error(`no live session is named "${target}" (use moni-ai, or MINT AI, to run it as MINT AI itself)`);
    return target;
  }

  function createOrder(p, actor, seedKey) {
    const sc = schedule.compile(p.schedule);
    const t = now();
    const delivery = (p.delivery || ["cc"]).filter((x) => x === "cc");
    if (!delivery.length) throw new Error("Telegram delivery is not available yet; deliver to the Command Center");
    const r = db
      .prepare(
        `INSERT INTO orders (name, kind, at, dow, every_h, cron, tz, target, prompt, delivery, paused, seed_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.name, sc.kind, sc.at, sc.dow, sc.every_h, sc.cron, tz, seedKey ? p.target : checkTarget(p.target), p.prompt, JSON.stringify(delivery), p.paused ? 1 : 0, seedKey || null, actor, t, t);
    const o = ledger.get("orders", Number(r.lastInsertRowid));
    return ledger.update("orders", o.id, { next_run_at: nextFor(o, Date.now()) });
  }

  function updateOrder(id, p, actor) {
    const o = ledger.get("orders", id);
    if (!o) throw new Error("no such standing order");
    const upd = { updated_at: now() };
    if (p.schedule) Object.assign(upd, (({ kind, at, dow, every_h, cron }) => ({ kind, at, dow, every_h, cron }))(schedule.compile(p.schedule)));
    if (p.name !== undefined) upd.name = p.name;
    if (p.prompt !== undefined) upd.prompt = p.prompt;
    if (p.target !== undefined) upd.target = checkTarget(p.target);
    if (p.delivery !== undefined) {
      const d = p.delivery.filter((x) => x === "cc");
      if (!d.length) throw new Error("Telegram delivery is not available yet; deliver to the Command Center");
      upd.delivery = JSON.stringify(d);
    }
    if (p.paused !== undefined) upd.paused = p.paused ? 1 : 0;
    let row = ledger.update("orders", id, upd);
    row = ledger.update("orders", id, { next_run_at: nextFor(row, Date.now()) });
    log(`standing order #${id} updated by ${actor}`);
    return row;
  }

  function runOrder(o, { manual, scheduledFor, actor }) {
    const busy = db.prepare("SELECT id FROM order_runs WHERE order_id = ? AND status = 'running'").get(o.id);
    if (busy) {
      if (manual) throw new Error("this order is already running");
      log(`standing order #${o.id} is still running from before; skipping this one`);
      return null;
    }
    const t = now();
    const r = db.prepare("INSERT INTO order_runs (order_id, scheduled_for, started_at, status, manual) VALUES (?, ?, ?, 'running', ?)").run(o.id, scheduledFor || null, t, manual ? 1 : 0);
    const runId = Number(r.lastInsertRowid);
    const turn = queueTurn({
      source: "order",
      actor: manual ? actor : "scheduler",
      order_id: o.id,
      target: o.target !== "moni-ai" ? o.target : null,
      text:
        `[Standing order: ${o.name}] (${schedule.label(o)}, ${tz}${manual ? ", run by hand" : ""})\n\n` +
        `${o.prompt}\n\n` +
        `[This is a standing order. Your reply is shown to the administrator as a card in the Command Center, so make it the finished result.]`,
    });
    const run = ledger.update("order_runs", runId, { turn_id: turn.id });
    const row = ledger.update("orders", o.id, { last_run_at: t, last_status: "running" });
    emit("order_run", { run, order: publicOrder(row) });
    emitOrder(row);
    return run;
  }

  function tickOrders() {
    const nowMs = Date.now();
    for (const o of db.prepare("SELECT * FROM orders WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(new Date(nowMs).toISOString())) {
      // Move the schedule on BEFORE running: a crash mid-run, or a supervisor
      // that was down across several runs, still runs this once, not in a burst.
      const row = ledger.update("orders", o.id, { next_run_at: nextFor(o, nowMs) });
      const late = nowMs - Date.parse(o.next_run_at);
      if (late > 120000) log(`standing order #${o.id} "${o.name}" missed ${o.next_run_at}; running it once now`);
      try {
        runOrder(row, { manual: false, scheduledFor: o.next_run_at });
      } catch (e) {
        warn(`standing order #${o.id} could not start: ${e.message}`);
      }
      emitOrder(ledger.get("orders", o.id));
    }
  }

  function finishRun(turn, status, result) {
    const run = db.prepare("SELECT * FROM order_runs WHERE turn_id = ? AND status = 'running'").get(turn.id);
    if (!run) return;
    const r = ledger.update("order_runs", run.id, { status, result: result ? clip(result, 20000) : null, ended_at: now() });
    const o = ledger.update("orders", run.order_id, { last_status: status, last_result: result ? clip(result, 4000) : null });
    emit("order_run", { run: r, order: publicOrder(o) });
    emitOrder(o);
  }

  /* ============================================================ rules === */

  function seedRules() {
    const t = now();
    for (const b of rules.BUILTINS) {
      const have = db.prepare("SELECT id FROM rules WHERE builtin_key = ?").get(b.key);
      if (have) db.prepare("UPDATE rules SET effect = ?, tool = ?, pattern = ?, note = ?, builtin = 1 WHERE id = ?").run(b.effect, b.tool, b.pattern, b.note, have.id);
      else
        db.prepare(
          "INSERT INTO rules (effect, tool, pattern, note, builtin, builtin_key, scope_session, scope_machine, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'moni-ai', 'this', 'built-in', ?, ?)"
        ).run(b.effect, b.tool, b.pattern, b.note, b.key, t, t);
    }
  }

  function publicRule(r) {
    if (!r) return null;
    const b = r.builtin_key ? rules.BUILTINS.find((x) => x.key === r.builtin_key) : null;
    return { ...r, builtin: !!r.builtin, locked: !!r.builtin, hard: !!(b && b.hard) };
  }
  function allRules() {
    return db.prepare("SELECT * FROM rules ORDER BY builtin DESC, id").all();
  }
  function ruleOr404(id) {
    const r = ledger.get("rules", id);
    if (!r) throw new Error("no such rule");
    return r;
  }

  function createRule(p, actor, sourceApproval) {
    const v = rules.validateRule(p);
    rules.checkAllowable(v);
    const t = now();
    const r = db
      .prepare(
        "INSERT INTO rules (effect, tool, pattern, note, builtin, scope_session, scope_machine, created_by, created_at, updated_at, source_approval_id) VALUES (?, ?, ?, ?, 0, 'moni-ai', 'this', ?, ?, ?, ?)"
      )
      .run(v.effect, v.tool, v.pattern, v.note || null, actor, t, t, sourceApproval || null);
    const row = ledger.get("rules", Number(r.lastInsertRowid));
    emit("rule", { rule: publicRule(row) });
    return row;
  }

  function hitRule(ruleId) {
    db.prepare("UPDATE rules SET uses = uses + 1, last_used_at = ? WHERE id = ?").run(now(), ruleId);
    emit("rule", { rule: publicRule(ledger.get("rules", ruleId)) });
  }

  /** Decide a can_use_tool by the rules alone, before raising a card. */
  function autoDecision(tool, input) {
    const r = rules.evaluate(tool, input, allRules(), cfg);
    if (r.decision === "allow" && r.source === "rule") return { allow: true, rule: r.rule, explain: r.explain };
    if (r.decision === "deny" && (r.source === "rule" || r.source === "builtin")) {
      const row = r.rule || db.prepare("SELECT * FROM rules WHERE builtin_key = ?").get(r.builtin);
      return { allow: false, rule: row || null, explain: r.explain };
    }
    return null;
  }

  function testRule(command, tool) {
    let input;
    let t = tool || "Bash";
    if (t === "SendMessage") {
      const i = command.indexOf(": ");
      input = i > 0 ? { to: command.slice(0, i), message: command.slice(i + 2) } : { to: "", message: command };
    } else input = { command };
    const r = rules.evaluate(t, input, allRules(), cfg);
    let rule = r.rule;
    if (!rule && r.builtin) rule = db.prepare("SELECT * FROM rules WHERE builtin_key = ?").get(r.builtin);
    if (!rule && r.source === "classifier" && r.decision === "ask") rule = db.prepare("SELECT * FROM rules WHERE builtin_key = 'classifier'").get();
    return { decision: r.decision, source: r.source, rule: publicRule(rule || null), classifier: r.classifier, explain: r.explain };
  }

  /* ============================================================= cost === */

  const scanner = new cost.Scanner({
    ledger,
    projectsDir: deps.projectsDir,
    dayOf,
    days: 15,
    // MINT AI's own transcripts are scanned too, for their token counts. Their
    // dollars are not added from here: MINT AI's cost comes from its ledger, so
    // every money query below leaves its session ids out (isSelf).
  });
  function selfIdSet() {
    return deps.selfSessionIds ? deps.selfSessionIds() : new Set([deps.selfSessionId()].filter(Boolean));
  }

  function backfillDeltas() {
    const rows = db.prepare("SELECT id, cost_usd, proc_start FROM turns WHERE cost_usd IS NOT NULL ORDER BY id").all();
    const d = cost.turnDeltas(rows);
    const up = db.prepare("UPDATE turns SET cost_delta_usd = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const [id, v] of d) up.run(v, id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Called on every result: the turn's own cost from the running total. */
  function recordTurnCost(turnId, totalUsd, procStart) {
    if (totalUsd == null) return;
    const prev = db.prepare("SELECT cost_usd, proc_start FROM turns WHERE cost_usd IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1").get(turnId);
    const rows = [];
    if (prev) rows.push({ id: -1, cost_usd: prev.cost_usd, proc_start: prev.proc_start });
    rows.push({ id: turnId, cost_usd: totalUsd, proc_start: procStart });
    const d = cost.turnDeltas(rows).get(turnId);
    ledger.update("turns", turnId, { proc_start: procStart, cost_delta_usd: d == null ? null : d });
  }

  function budget() {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'budget'").get();
    try {
      return { daily_usd: null, warn_pct: 80, ...(r ? JSON.parse(r.value) : {}) };
    } catch (_) {
      return { daily_usd: null, warn_pct: 80 };
    }
  }

  function days(n) {
    const out = [];
    const t = Date.now();
    for (let i = n - 1; i >= 0; i--) out.push(dayOf(t - i * 86400000));
    return [...new Set(out)];
  }

  function moniAiByDay(fromDay) {
    const map = new Map();
    const since = new Date(Date.now() - 16 * 86400000).toISOString();
    for (const r of db.prepare("SELECT created_at, ended_at, cost_delta_usd FROM turns WHERE cost_delta_usd IS NOT NULL AND created_at >= ?").all(since)) {
      const day = dayOf(Date.parse(r.ended_at || r.created_at));
      if (day < fromDay) continue;
      map.set(day, (map.get(day) || 0) + r.cost_delta_usd);
    }
    return map;
  }

  function sessionName(sid) {
    const live = (deps.sessions() || []).find((s) => s.session_id === sid);
    if (live && live.name) return live.name;
    const r = db.prepare("SELECT name, cwd FROM cost_names WHERE session_id = ?").get(sid);
    if (r && r.name) return r.name;
    return "session " + sid.slice(0, 8);
  }

  function costReport() {
    const ds = days(14);
    const today = ds[ds.length - 1];
    const mine = moniAiByDay(ds[0]);
    const self = selfIdSet();
    const others = new Map();
    for (const r of db.prepare("SELECT session_id, day, SUM(usd) AS usd FROM cost_daily WHERE day >= ? GROUP BY session_id, day").all(ds[0])) {
      if (!self.has(r.session_id)) others.set(r.day, (others.get(r.day) || 0) + r.usd);
    }
    const round = (x) => Math.round((x || 0) * 100) / 100;
    const daysOut = ds.map((day) => ({ day, moni_ai_usd: round(mine.get(day)), others_usd_est: round(others.get(day)) }));
    const week = ds.slice(-7);
    const bySess = new Map();
    for (const r of db.prepare("SELECT session_id, day, SUM(usd) AS usd, SUM(input + cache_write + cache_read) AS tin, SUM(output) AS tout FROM cost_daily WHERE day >= ? GROUP BY session_id, day").all(week[0])) {
      if (self.has(r.session_id)) continue;
      const s = bySess.get(r.session_id) || { session_id: r.session_id, week: week.map(() => 0), today_usd: 0, today_in: 0, today_out: 0, estimated: true };
      const i = week.indexOf(r.day);
      if (i !== -1) s.week[i] = round(r.usd);
      if (r.day === today) {
        s.today_usd = round(r.usd);
        s.today_in = r.tin;
        s.today_out = r.tout;
      }
      bySess.set(r.session_id, s);
    }
    const sessionsOut = [...bySess.values()].map((s) => ({ ...s, name: sessionName(s.session_id) }));
    sessionsOut.push({
      session_id: deps.selfSessionId(),
      name: (cfg.name && !names.OLD_NAMES.includes(cfg.name) ? cfg.name : names.DISPLAY_NAME) + " (CEO)",
      today_usd: round(mine.get(today)),
      today_in: null,
      today_out: null,
      week: week.map((d) => round(mine.get(d))),
      estimated: false,
    });
    sessionsOut.sort((a, b) => b.today_usd - a.today_usd || b.week.reduce((x, y) => x + y, 0) - a.week.reduce((x, y) => x + y, 0));
    const t = daysOut[daysOut.length - 1];
    return {
      today: { moni_ai_usd: t.moni_ai_usd, others_usd_est: t.others_usd_est, total_usd: round(t.moni_ai_usd + t.others_usd_est) },
      days: daysOut,
      sessions: sessionsOut.filter((s) => s.today_usd > 0 || s.week.some((x) => x > 0)).slice(0, 30),
      missions: missions.list({ limit: 20 }).map((m) => ({ id: m.id, ref: m.ref, title: m.title, status: m.status, cost_usd: m.metrics.cost_usd })),
      budget: budget(),
      updated_at: scanner.lastScan,
      note: "MINT AI: from its ledger (per-turn difference of the CLI's running total). Other sessions: estimated API-equivalent from transcript token usage at list prices.",
    };
  }

  /**
   * The Usage sheet: Claude plan usage as /usage shows it (from the CLI, see
   * lib/usage.js) and this box's own token counts from the transcripts.
   */
  function tokensReport() {
    const ds = days(14);
    const rows = db.prepare("SELECT session_id, day, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write FROM cost_daily WHERE day >= ? GROUP BY session_id, day").all(ds[0]);
    const selfName = cfg.name && !names.OLD_NAMES.includes(cfg.name) ? cfg.name : names.DISPLAY_NAME;
    return {
      ...cost.tokenReport(rows, { days: ds, selfIds: selfIdSet(), selfName, nameOf: sessionName }),
      tz,
      scanned_at: scanner.lastScan,
      note: "Counted on this box from the Claude transcripts (~/.claude/projects): the usage the API reported on each assistant message, sub-agents included in their session. Not plan figures.",
    };
  }
  async function usageReport(p) {
    const plan = deps.planUsage ? await deps.planUsage({ refresh: !(p && p.cached) }) : { plan: null, stale: true, error: "plan usage is not available" };
    return { plan, tokens: p && p.plan_only ? null : tokensReport() };
  }

  function costToday() {
    const today = dayOf(Date.now());
    const mine = moniAiByDay(today).get(today) || 0;
    const self = selfIdSet();
    let others = 0;
    for (const r of db.prepare("SELECT session_id, SUM(usd) AS usd FROM cost_daily WHERE day = ? GROUP BY session_id").all(today)) if (!self.has(r.session_id)) others += r.usd || 0;
    const b = budget();
    const round = (x) => Math.round(x * 100) / 100;
    return { moni_ai_usd: round(mine), others_usd_est: round(others), total_usd: round(mine + others), budget_usd: b.daily_usd, warn_pct: b.warn_pct };
  }

  function sessionCost(sid) {
    const week = days(7);
    const today = week[week.length - 1];
    // Token counts from the transcripts (MINT AI's own are scanned too): the deep view shows these.
    const self = sid === deps.selfSessionId() || selfIdSet().has(sid);
    const ids = self ? [...selfIdSet()] : [sid];
    const rows = db.prepare(`SELECT day, SUM(usd) AS usd, SUM(input + cache_write + cache_read) AS tin, SUM(output) AS tout FROM cost_daily WHERE session_id IN (${ids.map(() => "?").join(",")}) AND day >= ? GROUP BY day`).all(...ids, week[0]);
    const m = new Map(rows.map((r) => [r.day, r]));
    const t = m.get(today) || {};
    const tok = { today_in: t.tin || 0, today_out: t.tout || 0, week_tokens: week.map((d) => ((m.get(d) || {}).tin || 0) + ((m.get(d) || {}).tout || 0)) };
    if (self) {
      const mine = moniAiByDay(week[0]);
      return { today_usd: Math.round((mine.get(today) || 0) * 100) / 100, ...tok, week: week.map((d) => Math.round((mine.get(d) || 0) * 100) / 100), estimated: false };
    }
    return { today_usd: Math.round((t.usd || 0) * 100) / 100, ...tok, week: week.map((d) => Math.round(((m.get(d) || {}).usd || 0) * 100) / 100), estimated: true };
  }

  /* ==================================================== session mirror === */

  function transcriptPath(sid) {
    try {
      for (const dir of fs.readdirSync(deps.projectsDir)) {
        const p = path.join(deps.projectsDir, dir, sid + ".jsonl");
        if (fs.existsSync(p)) return p;
      }
    } catch (_) {
      /* none */
    }
    return null;
  }

  function mirror(sid) {
    const session = (deps.sessionsWithLedger() || []).find((s) => s.session_id === sid) || null;
    const file = transcriptPath(sid);
    if (!session && !file) throw new Error("no such session");
    const entries = [];
    const tools = [];
    const results = new Map();
    if (file) {
      const fd = fs.openSync(file, "r");
      let text;
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - 768 * 1024);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        fs.closeSync(fd);
      }
      const today = dayOf(Date.now());
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (rec.isSidechain) continue;
        const t = rec.timestamp || null;
        const content = rec.message && rec.message.content;
        if (rec.type === "user") {
          if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
            for (const b of content) if (b && b.type === "tool_result") results.set(b.tool_use_id, !b.is_error);
            continue;
          }
          const body = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
          if (!body.trim() || rec.isMeta) continue;
          const peer = /<cross-session-message\b/.test(body) || /\[Cross-session (idle|delivery) notice\]/.test(body);
          entries.push({ t, role: peer ? "peer" : "user", text: clip(body, 4000), tool: null });
        } else if (rec.type === "assistant" && Array.isArray(content)) {
          for (const b of content) {
            if (!b) continue;
            if (b.type === "text" && b.text && b.text.trim()) entries.push({ t, role: "assistant", text: clip(b.text, 4000), tool: null });
            else if (b.type === "tool_use") {
              const summary = deps.describeTool(b.name, b.input);
              entries.push({ t, role: "tool", text: clip(summary, 300), tool: b.name, id: b.id });
              if (t && dayOf(Date.parse(t)) === today) tools.push({ t, name: b.name, summary: clip(summary, 300), id: b.id });
            }
          }
        }
      }
    }
    const tail = entries.slice(-60).map(({ id, ...e }) => e);
    const toolsToday = tools.slice(-60).reverse().map(({ id, ...x }) => ({ ...x, ok: results.has(id) ? results.get(id) : null }));
    const delegations = db
      .prepare("SELECT * FROM delegations WHERE target_session = ? OR (target_session IS NULL AND target_name = ?) ORDER BY id DESC LIMIT 20")
      .all(sid, (session && session.name) || "")
      .map(({ tool_use_id, ...d }) => d);
    return redactDeep({ session, entries: tail, tools_today: toolsToday, delegations, cost: sessionCost(sid) });
  }

  /* ======================================================= public view === */

  function sessionExtras(s) {
    let m = null;
    try {
      m = s.self ? null : missions.forSession(s.name);
    } catch (_) {
      m = null;
    }
    let c = null;
    try {
      c = s.session_id ? sessionCost(s.session_id).today_usd : null;
    } catch (_) {
      c = null;
    }
    return { mission: m, cost_today_usd_est: c };
  }

  function rememberNames(list) {
    const up = db.prepare("INSERT INTO cost_names (session_id, name, cwd, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, cwd = excluded.cwd, updated_at = excluded.updated_at");
    for (const s of list || []) if (s.session_id && s.name) up.run(s.session_id, s.name, s.cwd || null, now());
  }

  function approvalExtras(a) {
    let suggestion = null;
    try {
      if (a.status === "pending" && a.input && typeof a.input === "object") {
        const sg = rules.suggestion(a.tool, a.input);
        suggestion = sg ? { tool: sg.tool, pattern: sg.pattern } : null;
      }
    } catch (_) {
      suggestion = null;
    }
    const m = a.mission_id ? { mission_ref: "M-" + a.mission_id } : { mission_ref: null };
    let stepN = null;
    if (a.step_id) {
      const s = db.prepare("SELECT n FROM steps WHERE id = ?").get(a.step_id);
      stepN = s ? s.n : null;
    }
    return { rule_suggestion: suggestion, ...m, step_n: stepN, decision_id: a.decision_id || null };
  }

  function counts() {
    const one = (sql, ...a) => (db.prepare(sql).get(...a) || {}).n || 0;
    return {
      decisions_open: one(`SELECT count(*) AS n FROM decisions WHERE status IN (${OPEN_DECISION.map(() => "?").join(",")})`, ...OPEN_DECISION),
      missions_active: one("SELECT count(*) AS n FROM missions WHERE status IN ('planned','active')"),
      watchers_on: one("SELECT count(*) AS n FROM watchers WHERE enabled = 1"),
      watchers_total: one("SELECT count(*) AS n FROM watchers"),
      rules_user: one("SELECT count(*) AS n FROM rules WHERE builtin = 0"),
      rules_builtin: one("SELECT count(*) AS n FROM rules WHERE builtin = 1"),
      orders_active: one("SELECT count(*) AS n FROM orders WHERE paused = 0"),
    };
  }

  /* ========================================================== the ops === */

  function emitMission(m) {
    if (m) emit("mission", { mission: redactDeep(m) });
    return m;
  }
  const turnId = () => deps.currentTurnId();

  const ops = {
    machine: () => machine(),
    missions: (p) => ({ missions: redactDeep(missions.list({ status: p.status === "active" ? "active" : undefined, limit: p.limit || 50 })) }),
    mission: (p) => {
      const m = missions.get(p.mission_id);
      if (!m) throw new Error("no such mission");
      return { mission: redactDeep(m) };
    },
    decisions: (p) => {
      const rows =
        p.status === "open"
          ? db.prepare(`SELECT * FROM decisions WHERE status IN (${OPEN_DECISION.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`).all(...OPEN_DECISION, p.limit || 100)
          : db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(p.limit || 100);
      return { decisions: rows.map(publicDecision) };
    },
    watchers: () => ({ watchers: watchers.list() }),
    orders: () => ({ orders: db.prepare("SELECT * FROM orders ORDER BY id").all().map(publicOrder), tz, telegram: TELEGRAM }),
    "order-runs": (p) => ({ runs: redactDeep(db.prepare("SELECT * FROM order_runs WHERE order_id = ? ORDER BY id DESC LIMIT ?").all(p.order_id, p.limit || 20)) }),
    rules: () => ({ rules: allRules().map(publicRule) }),
    "rule-test": (p) => testRule(p.command, p.tool),
    "rule-suggest": (p) => {
      const a = ledger.get("approvals", p.approval_id);
      if (!a) throw new Error("no such approval");
      let input = {};
      try {
        input = JSON.parse(a.input_json);
      } catch (_) {
        /* unreadable */
      }
      const s = rules.suggestion(a.tool, input);
      if (!s) throw new Error("rules do not apply to this tool");
      return { rule: s };
    },
    cost: () => costReport(),
    usage: (p) => usageReport(p),
    "session-mirror": (p) => mirror(p.session_id),

    "mission-create": (p, req) => {
      const m = missions.create({ title: p.title, goal: p.goal, steps: p.steps || [], actor: req.actor, turn_id: turnId() });
      log(`mission ${m.ref} created by ${req.actor}: ${m.title}`);
      return { mission: emitMission(m) };
    },
    "mission-step-add": (p) => ({ mission: emitMission(missions.addStep(p.mission_id, { title: p.title, detail: p.detail, target: p.target }, turnId())) }),
    "mission-step-update": (p) => {
      const { mission_id, step, ...fields } = p;
      return { mission: emitMission(missions.updateStep(mission_id, step, fields, turnId())) };
    },
    "mission-update": (p) => {
      const { mission_id, ...fields } = p;
      return { mission: emitMission(missions.update(mission_id, fields, turnId())) };
    },
    "mission-request": (p, req) => {
      const turn = queueTurn({
        source: "mission-request",
        actor: req.actor,
        text:
          `[Mission request from ${req.actor} in the Command Center]\nGoal: ${p.goal}\n\n` +
          `Plan this as a mission: call mission_create with a short title, the goal and the steps (each step with the session that should do it, ` +
          `or moni-ai for a step you do yourself). Then carry it out: put "M-<id> step <n>" in the first line of each delegation, and keep each ` +
          `step's status current with mission_step_update. Say in one line what you planned.`,
      });
      return { turn };
    },

    "decision-propose": (p, req) => {
      const d = decisionOr404(p.decision_id);
      if (!["investigating", "open", "proposed"].includes(d.status)) throw new Error(`decision #${d.id} is ${d.status}`);
      const row = ledger.update("decisions", d.id, {
        proposal: p.summary,
        evidence: p.evidence || d.evidence,
        fix_command: p.fix_command || null,
        status: "proposed",
        updated_at: now(),
      });
      log(`decision #${d.id}: proposal from ${req.actor}`);
      emitDecision(row);
      return { decision: publicDecision(row) };
    },
    "decision-update": (p, req) => {
      const d = decisionOr404(p.decision_id);
      if (!["approved", "running"].includes(d.status)) throw new Error(`decision #${d.id} is ${d.status}, not an approved fix`);
      const row = ledger.update("decisions", d.id, { status: p.status, result: p.result || null, updated_at: now() });
      emitDecision(row);
      return { decision: publicDecision(row) };
    },
    "decision-approve": (p, req) => {
      const d = decisionOr404(p.decision_id);
      if (d.status !== "proposed") throw new Error(`decision #${d.id} is ${d.status}; only a proposed fix can be approved`);
      const t = now();
      if (!d.fix_command) {
        const row = ledger.update("decisions", d.id, { status: "done", decided_by: req.actor, decided_at: t, result: "Acknowledged; nothing to run.", updated_at: t });
        emitDecision(row);
        return { decision: publicDecision(row) };
      }
      const turn = queueTurn({
        source: "decision",
        actor: req.actor,
        decision_id: d.id,
        text:
          `[Decision #${d.id} approved by ${req.actor}${p.note ? ": " + p.note : ""}]\n` +
          `Run the fix you proposed for "${d.title}", exactly:\n\`\`\`\n${d.fix_command}\n\`\`\`\n` +
          `It still goes through the approval gate like any command of yours: a destructive step raises its own card. ` +
          `Then check it worked and call decision_update with decision_id ${d.id}, status done or failed, and a one-line result.`,
      });
      const row = ledger.update("decisions", d.id, { status: "running", decided_by: req.actor, decided_at: t, fix_turn_id: turn.id, updated_at: t });
      emitDecision(row);
      return { decision: publicDecision(row), turn };
    },
    "decision-dismiss": (p, req) => {
      const d = decisionOr404(p.decision_id);
      if (!OPEN_DECISION.includes(d.status)) throw new Error(`decision #${d.id} is already ${d.status}`);
      const t = now();
      const row = ledger.update("decisions", d.id, { status: "dismissed", decided_by: req.actor, decided_at: t, result: p.note || null, updated_at: t });
      emitDecision(row);
      return { decision: publicDecision(row) };
    },
    "decision-ask": (p, req) => {
      const d = decisionOr404(p.decision_id);
      if (!OPEN_DECISION.includes(d.status)) throw new Error(`decision #${d.id} is already ${d.status}`);
      let turn;
      if (d.status === "open") turn = investigate(d, `The administrator (${req.actor}) asks: ${p.text}`);
      else
        turn = queueTurn({
          source: "decision",
          actor: req.actor,
          decision_id: d.id,
          text: `[Decision #${d.id} · question from ${req.actor}] ${p.text}\n\nAnswer here. If your proposal changes, call decision_propose again for decision ${d.id}. Do not run a fix before it is approved.`,
        });
      const row = ledger.update("decisions", d.id, { updated_at: now() });
      emitDecision(row);
      return { decision: publicDecision(row), turn };
    },
    "watcher-set": (p, req) => {
      const w = watchers.set(p.key, p.enabled, req.actor);
      emit("watcher", { watcher: w });
      return { watcher: w };
    },
    "watcher-inject": async (p, req) => {
      if (!cfg.watcher_inject) throw new Error("fault injection is switched off (watcher_inject in the config)");
      const r = watchers.fire(p.watcher, p.subject, { title: `[test] ${p.watcher} on ${p.subject}`, detail: p.detail || `Synthetic ${p.watcher} event injected by ${req.actor} for testing.`, evidence: p.evidence || null });
      return { decision: publicDecision(r.decision), created: r.created, skipped: r.skipped || null, investigate: !!r.investigate };
    },

    "order-create": (p, req) => {
      for (const k of ["name", "schedule", "target", "prompt"]) if (p[k] === undefined) throw new Error(`${k} is required`);
      const o = createOrder(p, req.actor);
      emitOrder(o);
      return { order: publicOrder(o) };
    },
    "order-update": (p, req) => {
      const { order_id, ...fields } = p;
      const o = updateOrder(order_id, fields, req.actor);
      emitOrder(o);
      return { order: publicOrder(o) };
    },
    "order-delete": (p) => {
      const o = ledger.get("orders", p.order_id);
      if (!o) throw new Error("no such standing order");
      db.prepare("DELETE FROM orders WHERE id = ?").run(o.id);
      emit("order", { deleted: o.id });
      return { deleted: o.id };
    },
    "order-run": (p, req) => {
      const o = ledger.get("orders", p.order_id);
      if (!o) throw new Error("no such standing order");
      const run = runOrder(o, { manual: true, actor: req.actor });
      return { order: publicOrder(ledger.get("orders", o.id)), run };
    },
    "order-pause": (p, req) => {
      const o = updateOrder(p.order_id, { paused: p.paused }, req.actor);
      emitOrder(o);
      return { order: publicOrder(o) };
    },

    "rule-create": (p, req) => ({ rule: publicRule(createRule(p, req.actor)) }),
    "rule-update": (p, req) => {
      const r = ruleOr404(p.rule_id);
      if (r.builtin) throw new Error("built-in rules cannot be changed");
      const { rule_id, ...fields } = p;
      const v = rules.validateRule({ ...r, ...fields }, { partial: false });
      rules.checkAllowable(v);
      const row = ledger.update("rules", r.id, { ...v, updated_at: now() });
      emit("rule", { rule: publicRule(row) });
      return { rule: publicRule(row) };
    },
    "rule-delete": (p) => {
      const r = ruleOr404(p.rule_id);
      if (r.builtin) throw new Error("built-in rules cannot be deleted");
      db.prepare("DELETE FROM rules WHERE id = ?").run(r.id);
      emit("rule", { deleted: r.id });
      return { deleted: r.id };
    },
    "cost-budget": (p, req) => {
      const b = { daily_usd: p.daily_usd === undefined ? null : p.daily_usd, warn_pct: p.warn_pct };
      db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('budget', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(
        JSON.stringify(b),
        req.actor,
        now()
      );
      return { budget: budget() };
    },
  };

  /* ================================================= supervisor hooks === */

  const hooks = {
    /** A delegation row was created or changed. */
    onDelegation(d) {
      try {
        emitMission(missions.onDelegation(d, deps.currentTurnId()));
      } catch (e) {
        warn("mission link failed: " + e.message);
      }
    },
    /** A card was raised for a can_use_tool. */
    onApproval(row, input, turn) {
      try {
        if (turn && turn.decision_id) ledger.update("approvals", row.id, { decision_id: turn.decision_id });
        emitMission(missions.onApproval(row, input));
      } catch (e) {
        warn("approval link failed: " + e.message);
      }
    },
    /** A turn produced its result. `procStart` identifies the CLI process. */
    onResult(turn, ev, procStart) {
      if (!turn) return;
      try {
        recordTurnCost(turn.id, ev.total_cost_usd == null ? null : Number(ev.total_cost_usd), procStart);
      } catch (e) {
        warn("cost: " + e.message);
      }
      if (turn.order_id) finishRun(turn, ev.is_error ? "error" : "ok", ev.result || ev.subtype || "");
    },
    /** A turn ended (done, interrupted, lost). */
    onTurnEnd(turn) {
      if (!turn) return;
      if (turn.order_id) finishRun(turn, "error", turn.status === "done" ? "The turn ended without a result." : `The turn ended: ${turn.status}.`);
      if (turn.decision_id) {
        const d = ledger.get("decisions", turn.decision_id);
        if (!d) return;
        if (d.status === "investigating" && d.turn_id === turn.id) {
          const row = ledger.update("decisions", d.id, {
            status: "proposed",
            proposal: d.proposal || (turn.result_text ? clip(turn.result_text, 4000) : "MINT AI finished investigating without a proposal."),
            updated_at: now(),
          });
          emitDecision(row);
        } else if (d.status === "running" && d.fix_turn_id === turn.id) {
          const ok = turn.status === "done" && !turn.error;
          const row = ledger.update("decisions", d.id, { status: ok ? "done" : "failed", result: d.result || clip(turn.result_text || turn.error || turn.status, 2000), updated_at: now() });
          emitDecision(row);
        }
      }
    },
    /** Events from the hooks' socket that belong here. */
    onHook(msg) {
      if (msg.event === "RuleHit") {
        let id = Number(msg.rule_id) || null;
        if (!id && msg.builtin) {
          const r = db.prepare("SELECT id FROM rules WHERE builtin_key = ?").get(String(msg.builtin));
          id = r ? r.id : null;
        }
        if (id && ledger.get("rules", id)) hitRule(id);
        return true;
      }
      return false;
    },
    onSessions(list) {
      try {
        rememberNames(list);
      } catch (_) {
        /* best effort */
      }
    },
  };

  /* =========================================================== lifecycle === */

  function start() {
    seedRules();
    if (!db.prepare("SELECT id FROM orders WHERE seed_key = ?").get(MORNING_BRIEFING.seed_key)) {
      createOrder(MORNING_BRIEFING, "seed", MORNING_BRIEFING.seed_key);
      log("seeded the standing order: Morning briefing, 07:30 " + tz);
    }
    // Runs the last supervisor left mid-flight can no longer finish.
    db.prepare("UPDATE order_runs SET status = 'error', ended_at = ?, result = 'the supervisor restarted mid-run' WHERE status = 'running'").run(now());
    for (const o of db.prepare("SELECT * FROM orders WHERE paused = 0 AND next_run_at IS NULL").all()) ledger.update("orders", o.id, { next_run_at: nextFor(o, Date.now()) });
    db.prepare("UPDATE orders SET last_status = 'error' WHERE last_status = 'running'").run();
    try {
      backfillDeltas();
    } catch (e) {
      warn("cost backfill: " + e.message);
    }
    tickOrders();
    timers.push(setInterval(() => {
      try {
        tickOrders();
      } catch (e) {
        warn("orders: " + e.message);
      }
    }, (cfg.orders_tick_s || 15) * 1000));
    const poll = () => pollWatchers().catch((e) => warn("watchers: " + e.message));
    timers.push(setTimeout(poll, 2000));
    timers.push(setInterval(poll, (cfg.watcher_poll_s || 30) * 1000));
    const scan = () => scanner.scan().catch((e) => warn("cost scan: " + e.message));
    timers.push(setTimeout(scan, 5000));
    timers.push(setInterval(scan, (cfg.cost_scan_s || 60) * 1000));
  }

  function stop() {
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
  }

  return {
    ops,
    hooks,
    start,
    stop,
    missions,
    watchers,
    machine,
    serviceList: () => services.list.map((x) => ({ unit: x.unit, active: x.active })),
    counts,
    costToday,
    sessionExtras,
    approvalExtras,
    autoDecision,
    publicRule,
    createRule,
    allRules,
    tickOrders,
    pollWatchers,
    scanner,
  };
}

module.exports = { createFeatures, MORNING_BRIEFING, TELEGRAM };
