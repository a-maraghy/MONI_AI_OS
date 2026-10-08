//! The "hands" of a laptop-control session: the tools Claude Code (running on this laptop under a
//! control lease) gets through the app's loopback MCP server `mint-hands`.
//!
//! Claude Code's own computer use is macOS-only, so these are ours: look (screenshot, windows, the
//! UI Automation tree, a DOM-aware browser over the Chrome DevTools Protocol), act (mouse, keyboard,
//! focus, open, start an app, UIA invoke / set value, browser click / type) and make documents
//! (docx / xlsx / pptx / pdf).
//!
//! Every call: (1) no lease -> refused, nothing runs; (2) acts that cannot be taken back (a click on
//! "Send" / "Delete" / "Pay"..., Enter in a mail or chat app) wait for the user's approval in Mint OS;
//! (3) some things are never done (password fields, card numbers, installers, UAC / Windows Hello
//! prompts, MINT AI's own approval surfaces); (4) every act is logged with a small screenshot.
//! The rules are in risk.rs (pure, unit-tested).
//!
//! Threading: `call` blocks and runs on whatever worker thread the MCP server uses. On Windows each
//! call makes its thread per-monitor-DPI aware and joins the COM multithreaded apartment (UI
//! Automation), so any worker thread works; calls are serialised internally (one hand at a time).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub mod docs;
pub mod mapping;
pub mod risk;

// The Windows platform layer (screen, input, windows, UI Automation, the CDP browser, Edge PDF printing,
// ShellExecute) is NOT in this build: see desktop/README.md "Laptop control" (status). Until it lands only
// the platform-independent tools are offered: create_document (docx / xlsx / pptx), wait, request_approval.
/// Tools that work in this build (the rest of tool_defs() is the platform layer's, not offered yet).
pub const AVAILABLE: &[&str] = &["create_document", "wait", "request_approval"];

/// One MCP tool result: content blocks `{"type":"text","text":..}` / `{"type":"image","data":<b64>,"mimeType":"image/jpeg"}`.
pub struct ToolResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

pub trait Host: Send + Sync {
    /// Is a control lease active right now? Every tool call checks this first and refuses otherwise.
    fn lease_active(&self) -> bool;
    /// Raise an approval card in Mint OS and BLOCK until the user answers (or timeout / lease end): true = approved.
    fn approve(&self, tool: &str, summary: &str, why: &str) -> bool;
    /// One action-log entry. decision: "auto" | "approved" | "denied" | "refused" | "error". shot: JPEG bytes, or None.
    fn log_action(&self, tool: &str, summary: &str, decision: &str, shot: Option<Vec<u8>>);
    /// Default folder for created documents (e.g. %USERPROFILE%\Documents\MINT AI).
    fn work_dir(&self) -> std::path::PathBuf;
}

/// Tool names reach the CLI as `mcp__mint-hands__<name>`.
pub const SERVER_NAME: &str = "mint-hands";

pub const NO_LEASE: &str = "No active control lease — the user has not handed over control (or it ended).";
pub const ONLY_WINDOWS: &str = "This tool is not in this build of the MINT AI app yet: use PowerShell (Start-Process to open a file or app) or create_document instead.";

impl ToolResult {
    pub fn text(t: impl Into<String>) -> ToolResult {
        ToolResult { content: vec![json!({"type": "text", "text": t.into()})], is_error: false }
    }
    pub fn error(t: impl Into<String>) -> ToolResult {
        ToolResult { content: vec![json!({"type": "text", "text": t.into()})], is_error: true }
    }
    pub fn with_image(mut self, jpeg: &[u8]) -> ToolResult {
        self.content.push(image_block(jpeg));
        self
    }
}

pub fn image_block(jpeg: &[u8]) -> Value {
    use base64::Engine;
    json!({"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(jpeg), "mimeType": "image/jpeg"})
}

/// The per-call context the tools use to ask, log and finish.
pub(crate) struct Ctx<'a> {
    pub host: &'a dyn Host,
    pub tool: &'a str,
}

impl Ctx<'_> {
    /// Refuse outright (no approval possible): logged "refused".
    pub fn refuse(&self, summary: &str, msg: &str) -> ToolResult {
        self.host.log_action(self.tool, summary, "refused", None);
        ToolResult::error(msg.to_string())
    }

    /// A failure while doing it: logged "error".
    pub fn fail(&self, summary: &str, msg: &str) -> ToolResult {
        self.host.log_action(self.tool, &format!("{summary} — failed: {msg}"), "error", None);
        ToolResult::error(msg.to_string())
    }

    /// `why` = Some(reason) -> ask the user first. Ok(decision) to go ahead ("auto" / "approved"),
    /// Err(result) when the user said no (already logged "denied").
    #[allow(dead_code)] // for the platform layer (risky targets), not in this build
    pub fn gate(&self, summary: &str, why: Option<String>) -> Result<&'static str, ToolResult> {
        let Some(why) = why else { return Ok("auto") };
        if !self.host.lease_active() {
            return Err(self.refuse(summary, NO_LEASE));
        }
        if self.host.approve(self.tool, summary, &why) {
            // The lease may have ended while the card was up.
            if !self.host.lease_active() {
                return Err(self.refuse(summary, NO_LEASE));
            }
            Ok("approved")
        } else {
            self.host.log_action(self.tool, summary, "denied", None);
            Err(ToolResult::error(format!("The user did not approve this ({why}). Do not retry it; ask the user or do something else.")))
        }
    }

    /// Done: log with a screenshot, return `text` (plus the screenshot when `image`).
    pub fn done(&self, summary: &str, decision: &str, text: &str, image: bool) -> ToolResult {
        let (log_shot, img) = after_shots(image);
        self.host.log_action(self.tool, summary, decision, log_shot);
        let r = ToolResult::text(text.to_string());
        match img {
            Some(j) => r.with_image(&j),
            None => r,
        }
    }

    /// A read-only call: log "auto" (with the shot the model got, if any).
    #[allow(dead_code)] // for the platform layer (read-only tools), not in this build
    pub fn seen(&self, summary: &str, shot: Option<Vec<u8>>) {
        self.host.log_action(self.tool, summary, "auto", shot);
    }
}

fn after_shots(_image: bool) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    (None, None)
}

/// One hand at a time: two tool calls never interleave their input events.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Run one tool. Never panics on bad input: errors come back as `is_error` results.
pub fn call(name: &str, args: &Value, host: &dyn Host) -> ToolResult {
    let ctx = Ctx { host, tool: name };
    if !host.lease_active() {
        return ctx.refuse(&format!("{name} (no lease)"), NO_LEASE);
    }
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let empty = json!({});
    let args = if args.is_object() { args } else { &empty };
    match name {
        "wait" => {
            let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(1000).min(10_000);
            std::thread::sleep(std::time::Duration::from_millis(ms));
            ToolResult::text(format!("Waited {ms} ms."))
        }
        "request_approval" => request_approval(&ctx, args),
        "create_document" => create_document(&ctx, args),
        _ => platform_call(&ctx, name, args),
    }
}

fn platform_call(_ctx: &Ctx, name: &str, _args: &Value) -> ToolResult {
    if all_tool_defs().iter().any(|d| d["name"] == name) {
        ToolResult::error(ONLY_WINDOWS)
    } else {
        ToolResult::error(format!("Unknown tool \"{name}\"."))
    }
}

/// JPEG of the primary screen, at most 1280 px wide and about 200 KB (for the log after non-hands tools).
pub fn shot_for_log() -> Option<Vec<u8>> {
    None
}

/// The lease ended: close the browser connection (the browser stays open for the user) and drop
/// cached state (UI Automation refs, screenshot mappings).
pub fn shutdown() {}

// ---------------------------------------------------------------------------------------------

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str)
}

fn request_approval(ctx: &Ctx, args: &Value) -> ToolResult {
    let action = s(args, "action").unwrap_or("").trim();
    let why = s(args, "why").unwrap_or("").trim();
    if action.is_empty() {
        return ToolResult::error("Say what you want to do in \"action\".");
    }
    let summary: String = action.chars().take(300).collect();
    if ctx.host.approve(ctx.tool, &summary, why) {
        ctx.host.log_action(ctx.tool, &summary, "approved", None);
        ToolResult::text("approved")
    } else {
        ctx.host.log_action(ctx.tool, &summary, "denied", None);
        ToolResult::text("denied — the user did not approve; do not do it.")
    }
}

fn create_document(ctx: &Ctx, args: &Value) -> ToolResult {
    let kind = match docs::Kind::parse(s(args, "kind").unwrap_or("")) {
        Ok(k) => k,
        Err(e) => return ToolResult::error(e),
    };
    let bytes = match docs::build(kind, args) {
        Ok(b) => b,
        Err(e) => return ToolResult::error(e),
    };
    let work = ctx.host.work_dir();
    let exists = |p: &Path| p.exists();
    let path: PathBuf = match s(args, "path").map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let mut p = PathBuf::from(p);
            if p.is_relative() {
                p = work.join(p);
            }
            if p.extension().map(|e| e.to_string_lossy().to_lowercase()) != Some(kind.ext().into()) {
                let mut os = p.into_os_string();
                os.push(format!(".{}", kind.ext()));
                p = PathBuf::from(os);
            }
            docs::unique_from(&p, &exists)
        }
        None => docs::unique_path(&work, &docs::default_stem(kind, args), kind.ext(), &exists),
    };
    let summary = format!("create {} {}", kind.ext(), path.display());
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return ctx.fail(&summary, &format!("Cannot create {}: {e}", dir.display()));
        }
    }
    let written = if kind == docs::Kind::Pdf { print_pdf(&bytes, &path) } else { std::fs::write(&path, &bytes).map_err(|e| e.to_string()) };
    if let Err(e) = written {
        return ctx.fail(&summary, &e);
    }
    let open = args.get("open").and_then(Value::as_bool).unwrap_or(true);
    let mut text = format!("Created {}", path.display());
    if open {
        match open_file(&path) {
            Ok(()) => text += " and opened it.",
            Err(e) => text += &format!(" (could not open it: {e})."),
        }
    }
    ctx.done(&summary, "auto", &text, false)
}

fn print_pdf(_html: &[u8], _out: &Path) -> Result<(), String> {
    Err("PDF is not in this build of the MINT AI app: make a docx instead.".into())
}

fn open_file(_p: &Path) -> Result<(), String> {
    Err(ONLY_WINDOWS.into())
}

// ---------------------------------------------------------------------------------------------
// Tool definitions

fn def(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": false}
    })
}

const XY: &str = "In the pixel space of the last screenshot of that monitor.";

/// The MCP tool list (name, description, inputSchema).
pub fn tool_defs() -> Vec<Value> {
    all_tool_defs().into_iter().filter(|d| d["name"].as_str().map_or(false, |n| AVAILABLE.contains(&n))).collect()
}

/// Every tool's definition, the platform layer's included (kept so its schemas are reviewed with the rest).
pub fn all_tool_defs() -> Vec<Value> {
    let xy = |d: &str| json!({"type": "number", "description": format!("{d} {XY}")});
    let monitor = json!({"type": "integer", "minimum": 0, "description": "Monitor index (default: the one of the last screenshot, else the primary)."});
    let cell = json!({"description": "A string, a number, a boolean, or a formula string starting with \"=\"."});
    let blocks = json!({
        "type": "array",
        "description": "docx/pdf content, in order. Each block is ONE of: {\"h1\": text}, {\"h2\": text}, {\"h3\": text}, {\"p\": text}, {\"bullet\": text or [texts]}, {\"numbered\": text or [texts]}, {\"table\": [[cell, ...], ...]} (first row = header). A bare string is a paragraph. Arabic paragraphs are set right-to-left automatically.",
        "items": {}
    });
    vec![
        def("screenshot", "Capture a monitor (default primary) as a JPEG downscaled to fit 1280x800. All x/y in other tools are in this image's pixel space. Returns the image and its size/scale.", json!({"monitor": monitor}), &[]),
        def("list_windows", "List visible top-level windows: id, title, exe, rect (screenshot pixels of its monitor), monitor, minimized, foreground.", json!({}), &[]),
        def("ui_tree", "Windows UI Automation tree of the foreground window (or the window id given): a flat list of elements with refs (e1, e2...), control type, name, automation id, value, enabled, rect (screenshot pixels). Refs work in ui_click / ui_set_text until the next ui_tree.", json!({
            "window": {"type": "integer", "description": "Window id from list_windows (default: foreground)."},
            "depth": {"type": "integer", "minimum": 1, "maximum": 12, "description": "Tree depth (default 6)."},
            "max": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Most elements to return (default 300)."}
        }), &[]),
        def("wait", "Wait up to 10 seconds (for a window or a page to load).", json!({"ms": {"type": "integer", "minimum": 0, "maximum": 10000}}), &["ms"]),
        def("click", "Click at a point. Clicks on buttons such as Send, Delete, Pay, Install, Confirm need the user's approval (asked automatically).", json!({
            "x": xy("X."), "y": xy("Y."), "button": {"type": "string", "enum": ["left", "right", "middle"]}, "double": {"type": "boolean"}, "monitor": monitor
        }), &["x", "y"]),
        def("move", "Move the mouse pointer (hover).", json!({"x": xy("X."), "y": xy("Y."), "monitor": monitor}), &["x", "y"]),
        def("drag", "Press the left button at one point, move to another, release.", json!({
            "from_x": xy("Start X."), "from_y": xy("Start Y."), "to_x": xy("End X."), "to_y": xy("End Y."), "monitor": monitor
        }), &["from_x", "from_y", "to_x", "to_y"]),
        def("scroll", "Scroll the mouse wheel over a point: dy notches, positive = down; dx positive = right.", json!({
            "x": xy("X."), "y": xy("Y."), "dy": {"type": "integer", "minimum": -50, "maximum": 50}, "dx": {"type": "integer", "minimum": -50, "maximum": 50}, "monitor": monitor
        }), &["x", "y"]),
        def("type", "Type text into the focused control (Unicode, Arabic works; \\n = Enter). Never into password fields; never card numbers.", json!({"text": {"type": "string"}}), &["text"]),
        def("key", "Press keys: one combo or several separated by spaces, e.g. \"ctrl+s\", \"alt+f4\", \"enter\", \"win+r\", \"ctrl+a delete\". Modifiers ctrl, shift, alt, win.", json!({"keys": {"type": "string"}}), &["keys"]),
        def("focus_window", "Bring a window to the front, by id (from list_windows) or by part of its title.", json!({"id": {"type": "integer"}, "title": {"type": "string"}}), &[]),
        def("open", "Open a file, a folder or an http(s) address with its default app (ShellExecute). Installers are for the user.", json!({"target": {"type": "string"}}), &["target"]),
        def("start_app", "Start an app by name: winword / word, excel, powerpnt / powerpoint, outlook, notepad, msedge / edge, explorer, calc, or an exe name / path.", json!({"name": {"type": "string"}, "args": {"type": "string"}}), &["name"]),
        def("ui_click", "Invoke a UI Automation element from the last ui_tree (Invoke pattern, else a click on its centre).", json!({"ref": {"type": "string"}}), &["ref"]),
        def("ui_set_text", "Set the text of a UI Automation edit element from the last ui_tree (Value pattern). Not for password fields.", json!({"ref": {"type": "string"}, "text": {"type": "string"}}), &["ref", "text"]),
        def("browser_open", "Open MINT AI's own Microsoft Edge window (a separate MINT AI browser profile, DOM-aware; the user may sign in to sites there themselves), optionally at a URL in a new tab.", json!({"url": {"type": "string"}}), &[]),
        def("browser_navigate", "Load a URL in the current tab of MINT AI's browser and wait for it.", json!({"url": {"type": "string"}}), &["url"]),
        def("browser_back", "Go back in the current tab.", json!({}), &[]),
        def("browser_tabs", "List the tabs of MINT AI's browser (index, title, url, current).", json!({}), &[]),
        def("browser_switch", "Switch to a tab by index (from browser_tabs).", json!({"index": {"type": "integer", "minimum": 0}}), &["index"]),
        def("browser_snapshot", "Read the current page: title, url, the visible interactive elements with refs (role, label, type, value) and a text excerpt. Use the refs in browser_click / browser_type.", json!({}), &[]),
        def("browser_click", "Click a page element by ref (from browser_snapshot). Buttons like Send / Buy / Delete need the user's approval.", json!({"ref": {"type": "string"}}), &["ref"]),
        def("browser_type", "Replace the text of an input / textarea / editable element by ref, optionally pressing Enter after (submit). Never password fields or card numbers.", json!({"ref": {"type": "string"}, "text": {"type": "string"}, "submit": {"type": "boolean"}}), &["ref", "text"]),
        def("browser_screenshot", "A JPEG of the current page's viewport.", json!({}), &[]),
        def("create_document", "Create a Word (docx), Excel (xlsx) or PowerPoint (pptx) file. Saved under the MINT AI documents folder unless a path is given; never overwrites (adds \" (2)\"). In this build it is not opened for you and PDF is not available: open the file afterwards with PowerShell (Start-Process).", json!({
            "kind": {"type": "string", "enum": ["docx", "xlsx", "pptx"]},
            "path": {"type": "string", "description": "File path (relative = under the MINT AI documents folder). Default: from the title."},
            "title": {"type": "string", "description": "Document title (docx/pdf: shown at the top; also the file name)."},
            "blocks": blocks,
            "sheets": {"type": "array", "description": "xlsx: [{\"name\": text, \"rows\": [[cell, ...], ...], \"header\": true}] (header = bold, frozen first row).", "items": {"type": "object", "properties": {"name": {"type": "string"}, "rows": {"type": "array", "items": {"type": "array", "items": cell}}, "header": {"type": "boolean"}}}},
            "slides": {"type": "array", "description": "pptx (16:9): [{\"title\": text, \"bullets\": [text, ...], \"notes\": speaker notes}].", "items": {"type": "object", "properties": {"title": {"type": "string"}, "bullets": {"type": "array", "items": {"type": "string"}}, "notes": {"type": "string"}}}},
            "open": {"type": "boolean", "description": "Open it after saving (default true)."}
        }), &["kind"]),
        def("request_approval", "Ask the user (an approval card in Mint OS) before a consequential step. Returns approved or denied.", json!({"action": {"type": "string", "description": "What you are about to do, in one line."}, "why": {"type": "string"}}), &["action", "why"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defs_are_well_formed() {
        let d = tool_defs();
        let mut names: Vec<&str> = d.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.len() >= 25);
        names.sort();
        names.dedup();
        assert_eq!(names.len(), d.len());
        for t in &d {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 10);
        }
    }
}
