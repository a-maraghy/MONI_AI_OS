"use strict";
/**
 * What the Claude sessions on this box cost.
 *
 * MONI AI's own cost comes from its ledger. The CLI's `total_cost_usd` on each
 * result is the running total of the PROCESS, not the cost of that turn: summing
 * it overstates badly (fact: 9.12 at 08:52 on 28 Sep after 6.08 the evening
 * before). A turn's cost is the difference from the previous turn of the same
 * process. A new process starts again from zero; it is recognised by the
 * process start stamp stored with each turn, and for rows written before that
 * column existed, by the running total going down.
 *
 * Every other session is estimated from its transcript: the token usage the
 * API reported on each assistant message, priced at API list prices. Those
 * figures are "estimated API-equivalent" -- a subscription does not bill them.
 * Streamed messages repeat one usage record per content block, so usage is
 * counted once per message id.
 */

const fs = require("fs");
const path = require("path");

/* ----------------------------------------------------- MONI AI's own turns --- */

/**
 * Per-turn cost from running totals.
 * rows: turns ordered by id, each { id, cost_usd, proc_start? }.
 * Returns Map(id -> delta USD) for rows with a cost.
 */
function turnDeltas(rows) {
  const out = new Map();
  let prevTotal = null;
  let prevProc;
  for (const r of rows) {
    if (r.cost_usd == null || !isFinite(r.cost_usd)) continue;
    const total = Number(r.cost_usd);
    const proc = r.proc_start || null;
    let delta;
    if (prevTotal === null) delta = total;
    else if (proc && prevProc && proc !== prevProc) delta = total; // a new process
    else if (total < prevTotal - 1e-9) delta = total; // the total went down: restarted
    else delta = total - prevTotal;
    out.set(r.id, Math.max(0, delta));
    prevTotal = total;
    prevProc = proc || prevProc;
  }
  return out;
}

/* --------------------------------------------------------------- prices --- */

// USD per million tokens: [input, output, cache read]. Cache writes are 1.25x
// input for the 5-minute cache and 2x for the 1-hour cache. API list prices.
const PRICES = [
  [/^claude-fable-5/, [10, 50, 0.25]],
  [/^claude-mythos/, [10, 50, 1.0]],
  [/^claude-opus-5-5/, [4, 20, 0.2]],
  [/^claude-opus-5/, [5, 25, 0.5]],
  [/^claude-opus-4-[5-9]/, [5, 25, 0.5]],
  [/^claude-opus-4/, [15, 75, 1.5]],
  [/^claude-sonnet-5/, [2, 10, 0.2]],
  [/^claude-sonnet/, [3, 15, 0.3]],
  [/^claude-haiku-4/, [1, 5, 0.1]],
  [/^claude-haiku/, [0.8, 4, 0.08]],
];
const DEFAULT_PRICE = [5, 25, 0.5];

function priceOf(model) {
  for (const [re, p] of PRICES) if (re.test(String(model || ""))) return p;
  return DEFAULT_PRICE;
}

/** USD for one message's usage record. */
function usageCost(model, u) {
  const [pin, pout, pread] = priceOf(model);
  const cc = u.cache_creation || {};
  const w1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? Number(cc.ephemeral_5m_input_tokens) || 0 : Math.max(0, (Number(u.cache_creation_input_tokens) || 0) - w1h);
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const read = Number(u.cache_read_input_tokens) || 0;
  return (input * pin + output * pout + read * pread + w5m * pin * 1.25 + w1h * pin * 2) / 1e6;
}

/* ------------------------------------------------------ transcript scanner --- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse transcript lines into per-(day, model) usage.
 * lines: complete JSONL lines. seen: Set of message ids already counted.
 * dayOf(ms) -> "YYYY-MM-DD". minMs: ignore older records.
 */
function parseUsage(lines, seen, dayOf, minMs) {
  const agg = new Map();
  let last = null;
  for (const line of lines) {
    if (!line || line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (rec.type !== "assistant" || !rec.message || !rec.message.usage) continue;
    const id = rec.message.id || rec.requestId || rec.uuid;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    last = id;
    const ms = Date.parse(rec.timestamp);
    if (!isFinite(ms) || ms < minMs) continue;
    const model = String(rec.message.model || "unknown").replace(/-\d{8}$/, "");
    if (model === "<synthetic>") continue;
    const u = rec.message.usage;
    const key = dayOf(ms) + "|" + model;
    const a = agg.get(key) || { day: dayOf(ms), model, input: 0, output: 0, cache_write: 0, cache_read: 0, usd: 0 };
    a.input += Number(u.input_tokens) || 0;
    a.output += Number(u.output_tokens) || 0;
    a.cache_write += Number(u.cache_creation_input_tokens) || 0;
    a.cache_read += Number(u.cache_read_input_tokens) || 0;
    a.usd += usageCost(model, u);
    agg.set(key, a);
  }
  return { agg: [...agg.values()], last };
}

/**
 * Incremental scanner over ~/.claude/projects. Keeps a byte offset per file in
 * the ledger (cost_files) and adds usage into cost_daily, so a restart carries
 * on where it stopped instead of counting everything twice. Yields to the
 * event loop between chunks: the first scan reads a couple of hundred MB.
 */
class Scanner {
  constructor({ ledger, projectsDir, dayOf, days = 15, chunk = 4 * 1024 * 1024, exclude = () => false }) {
    this.ledger = ledger;
    this.dir = projectsDir;
    this.dayOf = dayOf;
    this.days = days;
    this.chunk = chunk;
    this.exclude = exclude;
    this.busy = false;
    this.lastScan = null;
    this.seen = new Map(); // file -> Set of recent message ids (bounded)
  }

  files() {
    const out = [];
    const minMs = Date.now() - this.days * 86400000;
    let slugs = [];
    try {
      slugs = fs.readdirSync(this.dir);
    } catch (_) {
      return out;
    }
    for (const slug of slugs) {
      const pdir = path.join(this.dir, slug);
      let names;
      try {
        if (!fs.lstatSync(pdir).isDirectory()) continue;
        names = fs.readdirSync(pdir);
      } catch (_) {
        continue;
      }
      for (const n of names) {
        const full = path.join(pdir, n);
        if (n.endsWith(".jsonl") && UUID_RE.test(n.slice(0, -6))) {
          out.push({ file: full, session: n.slice(0, -6), minMs });
        } else if (UUID_RE.test(n)) {
          const sub = path.join(full, "subagents");
          try {
            for (const a of fs.readdirSync(sub)) if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(a)) out.push({ file: path.join(sub, a), session: n, minMs });
          } catch (_) {
            /* no sub-agents */
          }
        }
      }
    }
    return out.filter((f) => {
      try {
        return fs.statSync(f.file).mtimeMs >= f.minMs;
      } catch (_) {
        return false;
      }
    });
  }

  async scan() {
    if (this.busy) return false;
    this.busy = true;
    try {
      for (const f of this.files()) {
        if (this.exclude(f.session)) continue;
        await this.scanFile(f);
        await new Promise((r) => setImmediate(r));
      }
      this.lastScan = new Date().toISOString();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async scanFile({ file, session, minMs }) {
    const db = this.ledger.db;
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      return;
    }
    const row = db.prepare("SELECT * FROM cost_files WHERE path = ?").get(file);
    let off = row && row.ino === st.ino && row.off <= st.size ? row.off : 0;
    if (off >= st.size) return;
    let seen = this.seen.get(file);
    if (!seen) {
      seen = new Set(row && row.last_msg ? [row.last_msg] : []);
      this.seen.set(file, seen);
    }
    const fd = fs.openSync(file, "r");
    try {
      while (off < st.size) {
        const len = Math.min(this.chunk, st.size - off);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        let end = buf.lastIndexOf(10);
        if (end < 0) {
          if (len < this.chunk) break; // a line still being written
          end = len - 1; // one enormous line: skip it
        }
        const lines = buf.slice(0, end).toString("utf8").split("\n");
        const { agg, last } = parseUsage(lines, seen, this.dayOf, minMs);
        off += end + 1;
        db.exec("BEGIN");
        try {
          const up = db.prepare(
            `INSERT INTO cost_daily (session_id, day, model, input, output, cache_write, cache_read, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, day, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
               cache_write = cache_write + excluded.cache_write, cache_read = cache_read + excluded.cache_read, usd = usd + excluded.usd`
          );
          for (const a of agg) up.run(session, a.day, a.model, a.input, a.output, a.cache_write, a.cache_read, a.usd);
          db.prepare(
            `INSERT INTO cost_files (path, ino, off, last_msg, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET ino = excluded.ino, off = excluded.off, last_msg = COALESCE(excluded.last_msg, last_msg), updated_at = excluded.updated_at`
          ).run(file, st.ino, off, last, new Date().toISOString());
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        if (seen.size > 5000) {
          const keep = [...seen].slice(-1000);
          seen.clear();
          keep.forEach((k) => seen.add(k));
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { turnDeltas, priceOf, usageCost, parseUsage, Scanner, PRICES };
