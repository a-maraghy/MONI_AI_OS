"use strict";
/**
 * A fake MINT AI supervisor for the living canvas's tests and screenshots (tools/test-living-canvas.cjs).
 * It is story-fake-supervisor.cjs's world (the real moni-ai/lib/story.js over story-fixture.cjs) plus:
 *   - the usage ops the canvas's sources read: token-caps and cost (fixed figures, made up);
 *   - send: answers with a turn and remembers the ui token the dashboard minted for it (in memory);
 *   - push(event): writes an event to every open events stream, as the supervisor's emitLive does --
 *     so a test can play MINT AI's ui_widget ("ui" with action widget.show and a tag of the token).
 *
 *     const sup = await startCanvasFake(sockPath, world, { failed: true });
 *     const ut = sup.lastUt();  sup.push({ type: "ui", ... });  sup.close();
 */
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..", "..");
const { createStory } = require(path.join(ROOT, "moni-ai", "lib", "story.js"));
const names = require(path.join(ROOT, "moni-ai", "lib", "names.js"));

const tagOf = (ut) => crypto.createHash("sha256").update(String(ut)).digest("hex").slice(0, 16);

function costReport(now) {
  const days = [];
  const mine = [3.1, 4.2, 2.8, 5.6, 6.1, 3.9, 2.2, 4.8, 7.3, 5.2, 3.4, 6.6, 8.1, 4.4];
  const others = [9.8, 12.1, 7.7, 14.2, 11.9, 6.3, 4.1, 10.5, 15.8, 13.1, 9.9, 12.7, 16.4, 11.2];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400e3).toISOString().slice(0, 10);
    days.push({ day: d, moni_ai_usd: mine[13 - i], others_usd_est: others[13 - i] });
  }
  const t = days[days.length - 1];
  return {
    today: { moni_ai_usd: t.moni_ai_usd, others_usd_est: t.others_usd_est, total_usd: Math.round((t.moni_ai_usd + t.others_usd_est) * 100) / 100 },
    days,
    sessions: [
      { session_id: "bbbbbbbb-0000-4000-8000-000000000001", name: "Planning engine", today_usd: 6.2, week: [3, 4, 5, 2, 6, 7, 6.2], estimated: true },
      { session_id: "bbbbbbbb-0000-4000-8000-000000000003", name: "Invoice audit", today_usd: 3.1, week: [0, 0, 1, 2, 2, 3, 3.1], estimated: true },
      { session_id: "aaaaaaaa-0000-4000-8000-000000000000", name: "MINT AI (CEO)", today_usd: t.moni_ai_usd, week: [4, 5, 3, 6, 4, 6, t.moni_ai_usd], estimated: false },
      { session_id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Customs docs", today_usd: 1.9, week: [0, 1, 1, 2, 1, 2, 1.9], estimated: true },
    ],
    missions: [],
    budget: { daily_usd: 60, warn_pct: 80 },
    updated_at: new Date(now).toISOString(),
    note: "test figures",
  };
}
function capsView() {
  return {
    day: new Date().toISOString().slice(0, 10),
    warn_pct: 80,
    default: null,
    sessions: [
      { key: "<self>", name: "MINT AI", kind: "self", cap: 40e6, today: { total: 18.4e6 }, state: "ok" },
      { key: "planning", name: "Planning engine", kind: "session", cap: 30e6, today: { total: 26.1e6 }, state: "near" },
      { key: "audit", name: "Invoice audit", kind: "hire", cap: null, today: { total: 4.2e6 }, state: "none" },
    ],
    held: 0,
  };
}

function startCanvasFake(sock, W, o) {
  o = o || {};
  const story = createStory({
    projectsDir: W.projectsDir,
    db: W.ledger.db,
    tz: "Africa/Cairo",
    sessions: () => W.sessions,
    selfIds: () => W.selfIds,
    selfBusy: () => false,
    describeTool: (n) => n,
    sessionCost: (sid) => ({ today_usd: sid === W.ids.self ? 3.1 : 1.84, today_in: 0, today_out: 0, week_tokens: [], estimated: sid !== W.ids.self }),
    isSelfName: names.isSelfName,
    now: o.now,
  });
  const seen = [];
  const streams = new Set();
  const uts = [];
  let turnId = 500;
  let seq = 1000;
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", async (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch (_) {
          continue;
        }
        seen.push(m);
        if (m.op === "events") {
          streams.add(c);
          c.on("close", () => streams.delete(c));
          continue;
        }
        let data = {};
        let err = null;
        try {
          if (m.op === "status") data = { name: "MINT AI", seq: 1, process: { state: "ready", pid: 100 }, session_id: W.ids.self, approvals: W.approvals || [], counts: {}, cost_today: { total_usd: 14.3 } };
          else if (m.op === "sessions") data = { sessions: W.sessions };
          else if (m.op === "ledger") {
            const t = m.table;
            if (t === "delegations") data = { rows: W.ledger.db.prepare("SELECT * FROM delegations ORDER BY id DESC LIMIT 30").all() };
            else if (t === "approvals") data = { rows: W.ledger.db.prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT 30").all() };
            else data = { rows: [] };
          } else if (m.op === "missions") data = { missions: [] };
          else if (m.op === "decisions") data = { decisions: [] };
          else if (m.op === "orders") data = { orders: [], tz: "Africa/Cairo", telegram: { available: false } };
          else if (m.op === "watchers") data = { watchers: [] };
          else if (m.op === "token-caps") data = capsView();
          else if (m.op === "cost") data = costReport(Date.now());
          else if (m.op === "session-story") data = await story.sessionStory(m.session_id);
          else if (m.op === "story-day") data = await story.day(m.day || null);
          else if (m.op === "send") {
            if (m.ut) uts.push(m.ut);
            data = { turn: { id: ++turnId, status: "queued" }, queued: 0 };
          } else if (m.op === "ui-ack") {
            data = { acked: true };
          }
        } catch (e) {
          err = e.message;
        }
        if (!c.destroyed) c.write(JSON.stringify(err ? { id: m.id, ok: false, error: err } : { id: m.id, ok: true, data }) + "\n");
      }
    });
    c.on("error", () => {});
  });
  function push(ev) {
    const e = Object.assign({ ts: new Date().toISOString() }, ev);
    if (!("seq" in e)) e.seq = ev.type === "ui" ? 0 : ++seq;
    const line = JSON.stringify({ event: e }) + "\n";
    for (const c of streams) if (!c.destroyed) c.write(line);
  }
  return new Promise((resolve) =>
    server.listen(sock, () =>
      resolve({
        close: () => server.close(),
        seen,
        story,
        push,
        lastUt: () => uts[uts.length - 1] || null,
        lastTurn: () => turnId,
        tagOf,
        streams: () => streams.size,
      })
    )
  );
}

module.exports = { startCanvasFake, tagOf, costReport, capsView };
