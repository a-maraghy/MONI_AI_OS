//! Claude Code on this laptop, headless (pure parts; unit-tested in core-tests): where claude.exe
//! is, the arguments (as moni-ai/bin/mint-session runs a hired session, never bypassPermissions),
//! the MCP config that points it at the app's hands, and the stream-json conversation -- which
//! events become permission questions, reports and action-log entries.

use serde_json::{json, Value};
use std::collections::HashMap;

/// Where to look for the CLI, in order: the setting (only it, when set), each PATH folder
/// (claude.exe, then claude.cmd), %USERPROFILE%\.local\bin\claude.exe, %APPDATA%\npm\claude.cmd.
pub fn candidates(setting: &str, path_env: &str, userprofile: &str, appdata: &str) -> Vec<String> {
    let setting = setting.trim().trim_matches('"');
    if !setting.is_empty() {
        return vec![setting.to_string()];
    }
    let mut out = Vec::new();
    for dir in path_env.split(';').map(|d| d.trim().trim_matches('"')).filter(|d| !d.is_empty()) {
        out.push(join(dir, "claude.exe"));
        out.push(join(dir, "claude.cmd"));
    }
    if !userprofile.is_empty() {
        out.push(join(userprofile, ".local\\bin\\claude.exe"));
    }
    if !appdata.is_empty() {
        out.push(join(appdata, "npm\\claude.cmd"));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.to_ascii_lowercase()));
    out
}

pub fn join(dir: &str, rest: &str) -> String {
    format!("{}\\{}", dir.trim_end_matches(['\\', '/']), rest)
}

/// The first candidate that exists.
pub fn find(cands: &[String], exists: &dyn Fn(&str) -> bool) -> Option<String> {
    cands.iter().find(|p| exists(p)).cloned()
}

/// Git Bash (Claude Code on Windows wants it; without it the PowerShell tool is used instead).
pub fn git_bash_candidates(env_override: &str, program_files: &str, program_files_x86: &str, local_appdata: &str, path_env: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !env_override.trim().is_empty() {
        out.push(env_override.trim().trim_matches('"').to_string());
    }
    for base in [program_files, program_files_x86] {
        if !base.is_empty() {
            out.push(join(base, "Git\\bin\\bash.exe"));
        }
    }
    if !local_appdata.is_empty() {
        out.push(join(local_appdata, "Programs\\Git\\bin\\bash.exe"));
    }
    // git.exe on PATH lives in <Git>\cmd (or <Git>\bin): bash.exe is in <Git>\bin.
    for dir in path_env.split(';').map(|d| d.trim().trim_matches('"').trim_end_matches('\\')).filter(|d| !d.is_empty()) {
        let low = dir.to_ascii_lowercase();
        let parent = low.rsplit_once('\\').map(|(p, _)| p.rsplit('\\').next().unwrap_or("")).unwrap_or("");
        if (low.ends_with("\\cmd") || low.ends_with("\\bin")) && parent.contains("git") {
            out.push(join(&dir[..dir.len() - 4], "bin\\bash.exe"));
        }
    }
    out
}

/// An npm install (`…\npm\claude.cmd`) runs `node …\npm\node_modules\@anthropic-ai\claude-code\cli.js`;
/// the app runs that directly (a .cmd goes through cmd.exe, which cannot take every argument).
pub fn npm_cli_js(cmd_path: &str) -> Option<String> {
    let low = cmd_path.to_ascii_lowercase();
    if !low.ends_with(".cmd") {
        return None;
    }
    let dir = cmd_path.rsplit_once(['\\', '/']).map(|(d, _)| d)?;
    Some(join(dir, "node_modules\\@anthropic-ai\\claude-code\\cli.js"))
}

pub fn node_candidates(path_env: &str, program_files: &str) -> Vec<String> {
    let mut out: Vec<String> = path_env.split(';').map(|d| d.trim().trim_matches('"')).filter(|d| !d.is_empty()).map(|d| join(d, "node.exe")).collect();
    if !program_files.is_empty() {
        out.push(join(program_files, "nodejs\\node.exe"));
    }
    out
}

/// "2.1.3 (Claude Code)" -> "2.1.3".
pub fn parse_version(out: &str) -> Option<String> {
    let v = out.split_whitespace().next()?;
    if v.chars().next()?.is_ascii_digit() && v.len() <= 40 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+') {
        Some(v.to_string())
    } else {
        None
    }
}

pub struct CliOpts<'a> {
    pub name: &'a str,
    pub model: Option<&'a str>,
    pub session_id: &'a str,
    pub mcp_config: &'a str,
    pub allowed_tools: &'a [String],
    pub system_prompt: &'a str,
    pub add_dirs: &'a [String],
}

/// The CLI's arguments. Never --dangerously-*, never bypassPermissions: every tool outside the
/// hands' own asks (stdio), and the app turns the question into an approval card.
pub fn args(o: &CliOpts) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
    a.push("-n".into());
    a.push(display_name(o.name));
    if let Some(m) = o.model.filter(|m| model_ok(m)) {
        a.push("--model".into());
        a.push(m.to_string());
    }
    for x in ["--permission-mode", "default", "--permission-prompt-tool", "stdio", "--session-id"] {
        a.push(x.into());
    }
    a.push(o.session_id.to_string());
    a.push("--strict-mcp-config".into());
    a.push("--mcp-config".into());
    a.push(o.mcp_config.to_string());
    if !o.allowed_tools.is_empty() {
        a.push("--allowedTools".into());
        a.push(o.allowed_tools.join(","));
    }
    for d in o.add_dirs {
        a.push("--add-dir".into());
        a.push(d.clone());
    }
    a.push("--append-system-prompt".into());
    a.push(o.system_prompt.to_string());
    a
}

fn display_name(n: &str) -> String {
    let n: String = n.chars().filter(|c| !c.is_control()).take(60).collect();
    if n.trim().is_empty() {
        "MINT AI on this laptop".into()
    } else {
        n.trim().to_string()
    }
}

/// A model name as the server sends it ("claude-opus-5-5", "sonnet", "opus[1m]").
pub fn model_ok(m: &str) -> bool {
    !m.is_empty() && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c))
}

/// The MCP config: only the hands, on loopback, with this lease's secret.
pub fn mcp_config(port: u16, secret: &str, server_name: &str) -> String {
    json!({ "mcpServers": { server_name: { "type": "http", "url": format!("http://127.0.0.1:{}/mcp", port), "headers": { "Authorization": format!("Bearer {}", secret) } } } }).to_string()
}

/// `mcp__<server>__<tool>` for every tool the hands list.
pub fn allowed_tools(server_name: &str, defs: &[Value]) -> Vec<String> {
    defs.iter().filter_map(|d| d.get("name").and_then(|n| n.as_str())).map(|n| format!("mcp__{}__{}", server_name, n)).collect()
}

/// A random UUID v4 from 16 random bytes.
pub fn uuid_v4(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{:02x}", x)).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/* ------------------------------------------------------ messages to the CLI */

pub fn initialize() -> Value {
    json!({ "type": "control_request", "request_id": "init", "request": { "subtype": "initialize" } })
}

pub fn user_message(text: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": "" })
}

pub fn allow(request_id: &str, input: &Value) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": { "behavior": "allow", "updatedInput": input } } })
}

pub fn deny(request_id: &str, message: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": { "behavior": "deny", "message": message } } })
}

pub fn unsupported(request_id: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "not supported by MINT AI's laptop runner" } })
}

/* ----------------------------------------------------- the CLI's stream */

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// The init answer came: the session runs; send the first prompt.
    Initialized,
    /// A permission question: answer it with allow / deny.
    Ask { request_id: String, tool: String, input: Value, tool_use_id: Option<String>, reason: Option<String> },
    /// The CLI withdrew a question.
    Cancel { request_id: String },
    /// A control request we do not serve: answer unsupported().
    Unsupported { request_id: String },
    /// The end of a turn: its text goes to MINT AI.
    Report { text: String, is_error: bool },
    /// A tool outside the hands finished: log it (with a screenshot). decision: auto | approved | denied | error.
    Logged { tool: String, summary: String, decision: String },
}

#[derive(Default)]
pub struct Stream {
    initialised: bool,
    /// tool_use id -> (tool name, summary)
    uses: HashMap<String, (String, String)>,
    /// tool_use id -> "approved" | "denied" (from the questions' answers)
    decided: HashMap<String, &'static str>,
    hands_prefix: String,
}

impl Stream {
    pub fn new(server_name: &str) -> Stream {
        Stream { hands_prefix: format!("mcp__{}__", server_name), ..Stream::default() }
    }

    pub fn initialised(&self) -> bool {
        self.initialised
    }

    /// The answer given to a question about `tool_use_id` (for the action log's decision).
    pub fn note_answer(&mut self, tool_use_id: &str, allowed: bool) {
        if !tool_use_id.is_empty() {
            self.decided.insert(tool_use_id.to_string(), if allowed { "approved" } else { "denied" });
        }
    }

    pub fn on_line(&mut self, line: &str) -> Vec<Effect> {
        let Ok(ev) = serde_json::from_str::<Value>(line) else { return vec![] };
        let s = |v: &Value| v.as_str().map(|x| x.to_string());
        let mut out = Vec::new();
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "control_request" => {
                let rid = ev.get("request_id").map(|r| r.as_str().map(|x| x.to_string()).unwrap_or_else(|| r.to_string())).unwrap_or_default();
                let req = ev.get("request").cloned().unwrap_or(json!({}));
                if req.get("subtype").and_then(|x| x.as_str()) == Some("can_use_tool") {
                    out.push(Effect::Ask {
                        request_id: rid,
                        tool: req.get("tool_name").and_then(s).unwrap_or_else(|| "unknown".into()),
                        input: req.get("input").cloned().filter(|i| i.is_object()).unwrap_or(json!({})),
                        tool_use_id: req.get("tool_use_id").and_then(s),
                        reason: req.get("decision_reason").and_then(s),
                    });
                } else {
                    out.push(Effect::Unsupported { request_id: rid });
                }
            }
            "control_cancel_request" => {
                if let Some(r) = ev.get("request_id").and_then(s) {
                    out.push(Effect::Cancel { request_id: r });
                }
            }
            "control_response" => {
                let r = ev.get("response").cloned().unwrap_or(json!({}));
                if !self.initialised && r.get("request_id").and_then(|x| x.as_str()) == Some("init") {
                    self.initialised = true;
                    out.push(Effect::Initialized);
                }
            }
            "assistant" => {
                for b in ev.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        if let (Some(id), Some(name)) = (b.get("id").and_then(s), b.get("name").and_then(s)) {
                            let summary = summarize(&name, b.get("input").unwrap_or(&Value::Null));
                            self.uses.insert(id, (name, summary));
                        }
                    }
                }
            }
            "user" => {
                for b in ev.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let Some(id) = b.get("tool_use_id").and_then(s) else { continue };
                    let Some((tool, summary)) = self.uses.remove(&id) else { continue };
                    let decided = self.decided.remove(&id);
                    if tool.starts_with(&self.hands_prefix) {
                        continue; // the hands log their own actions
                    }
                    let is_err = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    let decision = match decided {
                        Some("denied") => "denied",
                        Some(d) if !is_err => d,
                        _ if is_err => "error",
                        _ => "auto",
                    };
                    out.push(Effect::Logged { tool, summary, decision: decision.to_string() });
                }
            }
            "result" => {
                let text = ev.get("result").and_then(s).unwrap_or_default();
                let is_error = ev.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                self.uses.clear();
                self.decided.clear();
                out.push(Effect::Report { text, is_error });
            }
            _ => {}
        }
        out
    }
}

/// A short line for the action log: the tool and the one field that says what it did.
pub fn summarize(tool: &str, input: &Value) -> String {
    let pick = ["command", "file_path", "path", "url", "pattern", "query", "description", "prompt"];
    let detail = pick.iter().find_map(|k| input.get(*k).and_then(|v| v.as_str()).map(|v| v.to_string())).unwrap_or_default();
    let detail: String = detail.chars().map(|c| if c.is_control() { ' ' } else { c }).take(400).collect();
    if detail.is_empty() {
        tool.to_string()
    } else {
        format!("{}: {}", tool, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_order() {
        let c = candidates("", "C:\\Windows;\"C:\\Tools\\\";;C:\\Users\\a\\.local\\bin", "C:\\Users\\a", "C:\\Users\\a\\AppData\\Roaming");
        assert_eq!(
            c,
            vec![
                "C:\\Windows\\claude.exe",
                "C:\\Windows\\claude.cmd",
                "C:\\Tools\\claude.exe",
                "C:\\Tools\\claude.cmd",
                "C:\\Users\\a\\.local\\bin\\claude.exe",
                "C:\\Users\\a\\.local\\bin\\claude.cmd",
                "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd",
            ]
        );
        assert_eq!(candidates(" \"D:\\x\\claude.exe\" ", "C:\\Windows", "u", "a"), vec!["D:\\x\\claude.exe"], "the setting alone");
        let exists = |p: &str| p.ends_with("npm\\claude.cmd");
        assert_eq!(find(&c, &exists).as_deref(), Some("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"));
        assert_eq!(find(&c, &|_| false), None);
        let g = git_bash_candidates("", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\Users\\a\\AppData\\Local", "C:\\Windows;D:\\PortableGit\\cmd");
        assert_eq!(g[0], "C:\\Program Files\\Git\\bin\\bash.exe");
        assert_eq!(g[2], "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
        assert_eq!(g[3], "D:\\PortableGit\\bin\\bash.exe");
        assert_eq!(git_bash_candidates("E:\\bash.exe", "", "", "", "")[0], "E:\\bash.exe");
        assert_eq!(npm_cli_js("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd").as_deref(), Some("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"));
        assert_eq!(npm_cli_js("C:\\x\\claude.exe"), None);
        assert_eq!(node_candidates("C:\\a;C:\\b", "C:\\Program Files"), vec!["C:\\a\\node.exe", "C:\\b\\node.exe", "C:\\Program Files\\nodejs\\node.exe"]);
        assert_eq!(parse_version("2.1.3 (Claude Code)\r\n").as_deref(), Some("2.1.3"));
        assert_eq!(parse_version("error: x"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn cli_args() {
        let tools = vec!["mcp__mint-hands__screenshot".to_string(), "mcp__mint-hands__click".to_string()];
        let dirs = vec!["C:\\Users\\a\\Desktop".to_string()];
        let cfg = mcp_config(5123, "abc", "mint-hands");
        let a = args(&CliOpts { name: "Laptop", model: Some("claude-opus-5-5"), session_id: "u-1", mcp_config: &cfg, allowed_tools: &tools, system_prompt: "rules", add_dirs: &dirs });
        let s = a.join(" ");
        assert!(s.starts_with("-p --input-format stream-json --output-format stream-json --verbose -n Laptop --model claude-opus-5-5 --permission-mode default --permission-prompt-tool stdio --session-id u-1 --strict-mcp-config --mcp-config "));
        assert!(s.contains("--allowedTools mcp__mint-hands__screenshot,mcp__mint-hands__click"));
        assert!(s.contains("--add-dir C:\\Users\\a\\Desktop"));
        assert_eq!(a.last().unwrap(), "rules");
        assert!(!s.to_ascii_lowercase().contains("dangerously") && !s.contains("bypassPermissions"));
        let a = args(&CliOpts { name: "", model: Some("x; rm -rf"), session_id: "u", mcp_config: "{}", allowed_tools: &[], system_prompt: "", add_dirs: &[] });
        assert!(!a.contains(&"--model".to_string()), "a strange model name is dropped");
        assert!(!a.contains(&"--allowedTools".to_string()));
        assert_eq!(a[7], "MINT AI on this laptop");
        let c: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(c, json!({"mcpServers":{"mint-hands":{"type":"http","url":"http://127.0.0.1:5123/mcp","headers":{"Authorization":"Bearer abc"}}}}));
        assert_eq!(allowed_tools("mint-hands", &[json!({"name":"a"}), json!({"x":1}), json!({"name":"b"})]), vec!["mcp__mint-hands__a", "mcp__mint-hands__b"]);
        let u = uuid_v4([0xff; 16]);
        assert_eq!(u, "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert_eq!(hex(&[0, 255]), "00ff");
    }

    #[test]
    fn cli_messages() {
        assert_eq!(initialize()["request"]["subtype"], "initialize");
        assert_eq!(user_message("hi")["message"], json!({"role":"user","content":"hi"}));
        assert_eq!(allow("r", &json!({"a":1}))["response"]["response"], json!({"behavior":"allow","updatedInput":{"a":1}}));
        assert_eq!(deny("r", "no")["response"], json!({"subtype":"success","request_id":"r","response":{"behavior":"deny","message":"no"}}));
        assert_eq!(unsupported("r")["response"]["subtype"], "error");
    }

    #[test]
    fn stream() {
        let mut st = Stream::new("mint-hands");
        assert_eq!(st.on_line("junk"), vec![]);
        assert_eq!(st.on_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{}}}"#), vec![Effect::Initialized]);
        assert!(st.initialised());
        assert_eq!(st.on_line(r#"{"type":"control_response","response":{"request_id":"init"}}"#), vec![], "once");
        let ask = st.on_line(r#"{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"del x"},"tool_use_id":"tu1","decision_reason":"not allowed"}}"#);
        assert_eq!(ask, vec![Effect::Ask { request_id: "q1".into(), tool: "Bash".into(), input: json!({"command":"del x"}), tool_use_id: Some("tu1".into()), reason: Some("not allowed".into()) }]);
        assert_eq!(st.on_line(r#"{"type":"control_request","request_id":"q2","request":{"subtype":"hook_callback"}}"#), vec![Effect::Unsupported { request_id: "q2".into() }]);
        assert_eq!(st.on_line(r#"{"type":"control_cancel_request","request_id":"q1"}"#), vec![Effect::Cancel { request_id: "q1".into() }]);
        // Tool uses: a Bash that was approved, a Read that ran by itself, a hands tool (not logged here), a denied Write.
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"del x"}},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"C:\\a.txt"}},{"type":"tool_use","id":"tu3","name":"mcp__mint-hands__click","input":{"x":1}},{"type":"tool_use","id":"tu4","name":"Write","input":{"file_path":"C:\\b.txt"}}]}}"#);
        st.note_answer("tu1", true);
        st.note_answer("tu4", false);
        let r = st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"},{"type":"tool_result","tool_use_id":"tu2","content":"x"},{"type":"tool_result","tool_use_id":"tu3","content":"x"},{"type":"tool_result","tool_use_id":"tu4","content":"denied","is_error":true}]}}"#);
        assert_eq!(
            r,
            vec![
                Effect::Logged { tool: "Bash".into(), summary: "Bash: del x".into(), decision: "approved".into() },
                Effect::Logged { tool: "Read".into(), summary: "Read: C:\\a.txt".into(), decision: "auto".into() },
                Effect::Logged { tool: "Write".into(), summary: "Write: C:\\b.txt".into(), decision: "denied".into() },
            ]
        );
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu5","name":"Glob","input":{"pattern":"*.md"}}]}}"#);
        assert_eq!(st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu5","is_error":true}]}}"#)[0], Effect::Logged { tool: "Glob".into(), summary: "Glob: *.md".into(), decision: "error".into() });
        assert_eq!(st.on_line(r#"{"type":"result","subtype":"success","result":"Done: made the PDF.","is_error":false}"#), vec![Effect::Report { text: "Done: made the PDF.".into(), is_error: false }]);
        assert_eq!(summarize("TodoWrite", &json!({"todos":[]})), "TodoWrite");
        assert_eq!(summarize("Bash", &json!({"command":"a\nb"})), "Bash: a b");
    }
}
