"use strict";
/**
 * Telegram Topics for an agent's channel: one forum topic per project folder.
 *
 * The privileged helper (deploy/moni-helper, "topics" section) is the
 * authority: it checks a Topics configuration against everything the agent
 * runtime checks before it starts, writes the projects file, and puts the old
 * settings back if the bot still does not come up. This module only reads the
 * channel form and catches the mistakes worth a sentence before the round
 * trip -- the same wording the helper would use.
 */

const MAX_PROJECTS = 20;
const MODES = ["group", "private"];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SUPERGROUP_RE = /^-100\d{7,13}$/;

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x == null ? "" : x).trim());

/** A short name from a display name: "Client work (EU)" -> "client-work-eu". */
function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/[-_]+$/g, "");
}

/**
 * The Topics part of a channel form. Rows come as parallel fields tp_name /
 * tp_slug / tp_path (one value each, or arrays when there are several); a row
 * left entirely blank is dropped, and a blank short name is made from the name.
 */
function parseTopicsForm(body) {
  const b = body || {};
  const names = list(b.tp_name);
  const slugs = list(b.tp_slug);
  const paths = list(b.tp_path);
  const n = Math.max(names.length, slugs.length, paths.length);
  const projects = [];
  for (let i = 0; i < n; i++) {
    const name = names[i] || "";
    const path = paths[i] || "";
    let slug = (slugs[i] || "").toLowerCase();
    if (!name && !path && !slug) continue;
    if (!slug) slug = slugify(name);
    projects.push({ slug, name, path: path || ".", enabled: true });
  }
  const mode = MODES.includes(String(b.topics_mode || "")) ? String(b.topics_mode) : "group";
  return {
    topics_enabled: !!b.topics_enabled,
    topics_mode: mode,
    topics_chat_id: String(b.topics_chat_id || "").trim(),
    topics_projects: projects,
    // Only send the list when the form carried the table: a form without it
    // (the create page) leaves the helper to propose the default.
    has_projects_table: b.tp_table === "1",
  };
}

/** Sentences for what is wrong, or [] -- the helper checks folders and Telegram itself. */
function checkTopics(t) {
  const errors = [];
  if (t.topics_enabled && t.topics_mode === "group") {
    if (!t.topics_chat_id) errors.push("Group topic mode needs the group's chat id.");
    else if (!SUPERGROUP_RE.test(t.topics_chat_id))
      errors.push(
        "The group chat id " + t.topics_chat_id + " is not a group with Topics: Topics live only in " +
          "supergroups, whose id starts with -100. Turn on Topics in the group's settings (Telegram " +
          "then gives the group a new id starting with -100) and use that id."
      );
  }
  const projects = t.topics_projects || [];
  if (projects.length > MAX_PROJECTS) errors.push("At most " + MAX_PROJECTS + " projects.");
  const seen = { slug: new Set(), name: new Set(), path: new Set() };
  projects.forEach((p, i) => {
    const label = p.name ? "Project '" + p.name + "'" : "Project " + (i + 1);
    if (!p.name) errors.push(label + " needs a name; it becomes the topic's title.");
    if (!SLUG_RE.test(p.slug))
      errors.push(label + ": the short name may use only lowercase letters, digits, '-' and '_' (at most 40).");
    if (/^[/~]/.test(p.path)) errors.push(label + ": the folder must be inside the agent's folder, written relative to it (\".\" is the agent's own folder).");
    else if (/(^|\/)\.\.(\/|$)/.test(p.path)) errors.push(label + ": the folder may not climb out with '..'.");
    for (const k of ["slug", "name", "path"]) {
      if (p[k] && seen[k].has(p[k])) errors.push("Two projects share the " + (k === "slug" ? "short name" : k === "path" ? "folder" : "name") + " '" + p[k] + "'.");
      seen[k].add(p[k]);
    }
  });
  return errors;
}

/** The payload keys for priv.channelUpdate / channelCreate. */
function topicsPayload(t) {
  const out = {
    topics_enabled: t.topics_enabled,
    topics_mode: t.topics_mode,
    topics_chat_id: t.topics_chat_id,
  };
  if (t.has_projects_table) out.topics_projects = t.topics_projects;
  return out;
}

/** One line for the channel's summary table. */
function describe(c) {
  if (!c || !c.topics_enabled) return "off";
  const n = Array.isArray(c.topics_projects) && c.topics_projects.length ? c.topics_projects.length : 1;
  const where = (c.topics_mode || "group") === "private" ? "private chat" : "group " + (c.topics_chat_id || "?");
  return "on · " + where + " · " + n + (n === 1 ? " project" : " projects");
}

module.exports = { parseTopicsForm, checkTopics, topicsPayload, describe, slugify, MAX_PROJECTS, SUPERGROUP_RE };
