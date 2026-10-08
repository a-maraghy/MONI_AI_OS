//! The link's messages, server <-> app (pure; unit-tested in core-tests). JSON text frames, at most
//! 2 MB, with a `t` field. See desktop/README.md ("This computer") for the whole contract.

use serde::Deserialize;
use serde_json::{json, Value};

pub const MAX_FRAME: usize = 2 * 1024 * 1024;
/// An action's screenshot is dropped above this (base64 of it is a third bigger).
pub const MAX_SHOT: usize = 400 * 1024;
pub const MAX_SUMMARY: usize = 500;

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LeaseSpec {
    pub id: String,
    #[serde(default)]
    pub minutes: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// server -> app
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum In {
    Welcome {
        #[serde(default)]
        machine_id: String,
        #[serde(default)]
        name: String,
    },
    Renamed {
        name: String,
    },
    Revoked,
    Start {
        slug: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        purpose: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        first_prompt: String,
        lease: LeaseSpec,
    },
    Extend {
        lease_id: String,
        expires_at: String,
    },
    Tell {
        slug: String,
        text: String,
    },
    Stop {
        lease_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    Answer {
        rid: String,
        behavior: String,
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

/// A frame from the server: None when it is too big or not one of ours.
pub fn parse_in(text: &str) -> Option<In> {
    if text.len() > MAX_FRAME {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// A hired session's slug, as the server makes them (mint-session's rule).
pub fn slug_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Text cut to `max` characters (on a char boundary), control characters other than newline/tab removed.
pub fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(max).collect()
}

/* --------------------------------------------------------------- app -> server */

pub struct Claude<'a> {
    pub path: Option<&'a str>,
    pub version: Option<&'a str>,
    pub git_bash: bool,
}

/// `home` = %USERPROFILE% (the server's gate reads "the user's own files" from it), `user` = the Windows user name.
pub fn hello(app_version: &str, host: &str, user: &str, home: &str, c: &Claude) -> Value {
    json!({ "t": "hello", "app_version": app_version, "platform": "windows", "host": host, "user": user, "home": home, "claude": { "path": c.path, "version": c.version, "git_bash": c.git_bash } })
}

pub fn lease(lease_id: &str, state: &str, expires_at: Option<u64>, reason: Option<&str>) -> Value {
    let mut v = json!({ "t": "lease", "lease_id": lease_id, "state": state });
    if let Some(e) = expires_at {
        v["expires_at"] = json!(iso(e));
    }
    if let Some(r) = reason {
        v["reason"] = json!(r);
    }
    v
}

#[allow(clippy::too_many_arguments)]
pub fn ask(rid: &str, slug: &str, tool: &str, input: &Value, tool_use_id: Option<&str>, reason: Option<&str>, origin: &str) -> Value {
    let mut v = json!({ "t": "ask", "rid": rid, "slug": slug, "tool": clip(tool, 120), "input": if input.is_object() { input.clone() } else { json!({ "value": input }) }, "origin": origin });
    // The whole frame stays under the limit: a huge input (a file's content) is cut down.
    if v["input"].to_string().len() > 64 * 1024 {
        v["input"] = json!({ "truncated": clip(&v["input"].to_string(), 16 * 1024) });
    }
    if let Some(t) = tool_use_id {
        v["tool_use_id"] = json!(clip(t, 80));
    }
    if let Some(r) = reason {
        v["reason"] = json!(clip(r, 2000));
    }
    v
}

pub fn cancel(rid: &str) -> Value {
    json!({ "t": "cancel", "rid": rid })
}

/// `shot`: base64 of a JPEG (dropped when bigger than MAX_SHOT bytes before encoding).
pub fn action(lease_id: &str, slug: &str, at: u64, tool: &str, summary: &str, decision: &str, shot_b64: Option<&str>) -> Value {
    let mut v = json!({ "t": "action", "lease_id": lease_id, "slug": slug, "at": iso(at), "tool": clip(tool, 120), "summary": clip(summary, MAX_SUMMARY), "decision": decision });
    if let Some(s) = shot_b64 {
        v["shot"] = json!(s);
    }
    v
}

pub fn report(slug: &str, text: &str) -> Value {
    json!({ "t": "report", "slug": slug, "text": clip(text, 100_000) })
}

pub fn session(slug: &str, state: &str, detail: Option<&str>) -> Value {
    let mut v = json!({ "t": "session", "slug": slug, "state": state });
    if let Some(d) = detail {
        v["detail"] = json!(clip(d, 500));
    }
    v
}

/* ------------------------------------------------------------------ time (UTC) */

/// Milliseconds since 1970 -> "2026-10-08T12:34:56.789Z".
pub fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

/// "2026-10-08T12:34:56(.fff)(Z|+hh:mm|-hh:mm)" -> milliseconds since 1970. None for anything else.
pub fn parse_iso(s: &str) -> Option<u64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let st = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = s.get(st..i)?;
        if digits.is_empty() {
            return None;
        }
        let three: String = digits.chars().chain("000".chars()).take(3).collect();
        frac_ms = three.parse().ok()?;
    }
    let off_s: i64 = match s.get(i..)? {
        "Z" | "z" => 0,
        t if t.len() == 6 && (t.starts_with('+') || t.starts_with('-')) && &t[3..4] == ":" => {
            let v = t[1..3].parse::<i64>().ok()? * 3600 + t[4..6].parse::<i64>().ok()? * 60;
            if t.starts_with('+') {
                v
            } else {
                -v
            }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    let t = days * 86_400 + h * 3600 + mi * 60 + se - off_s;
    if t < 0 {
        return None;
    }
    Some(t as u64 * 1000 + frac_ms as u64)
}

// Howard Hinnant's civil-from-days / days-from-civil.
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The lease's expiry from a `start`: its expires_at, else now + minutes; None when neither is usable.
/// `minutes` is preferred: it is relative, so a laptop clock that is off does not shorten or end the
/// lease; expires_at is the fallback.
pub fn lease_expiry(spec: &LeaseSpec, now: u64) -> Option<u64> {
    if let Some(m) = spec.minutes.filter(|m| *m > 0) {
        return Some(now + m.min(60) * 60_000);
    }
    spec.expires_at.as_deref().and_then(parse_iso)
}

/* -------------------------------------------------------------- pairing codes */

/// The code as typed ("abcd-efgh", "ABCD EFGH", with O for 0 or I/L for 1) -> the 8 Crockford base32
/// characters the server issued, upper case, no dash. None when it cannot be one.
pub fn normalize_code(s: &str) -> Option<String> {
    let mut out = String::new();
    for c in s.chars() {
        let c = c.to_ascii_uppercase();
        let c = match c {
            '-' | ' ' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c if c.is_ascii_digit() => c,
            c if c.is_ascii_uppercase() && c != 'U' => c,
            _ => return None,
        };
        out.push(c);
    }
    if out.len() == 8 {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_messages() {
        assert_eq!(parse_in(r#"{"t":"welcome","machine_id":"m1","name":"Laptop"}"#), Some(In::Welcome { machine_id: "m1".into(), name: "Laptop".into() }));
        assert_eq!(parse_in(r#"{"t":"revoked"}"#), Some(In::Revoked));
        assert_eq!(parse_in(r#"{"t":"renamed","name":"X"}"#), Some(In::Renamed { name: "X".into() }));
        let s = parse_in(r#"{"t":"start","slug":"laptop-1","name":"Laptop","purpose":"p","model":null,"first_prompt":"do it","lease":{"id":"L1","minutes":30,"expires_at":"2026-10-08T12:00:00.000Z"}}"#).unwrap();
        match s {
            In::Start { slug, model, first_prompt, lease, .. } => {
                assert_eq!(slug, "laptop-1");
                assert_eq!(model, None);
                assert_eq!(first_prompt, "do it");
                assert_eq!(lease.id, "L1");
                assert_eq!(lease.minutes, Some(30));
            }
            _ => panic!(),
        }
        assert_eq!(parse_in(r#"{"t":"extend","lease_id":"L1","expires_at":"2026-10-08T12:15:00Z"}"#), Some(In::Extend { lease_id: "L1".into(), expires_at: "2026-10-08T12:15:00Z".into() }));
        assert_eq!(parse_in(r#"{"t":"tell","slug":"s","text":"more"}"#), Some(In::Tell { slug: "s".into(), text: "more".into() }));
        assert_eq!(parse_in(r#"{"t":"stop","lease_id":"L1","reason":"user"}"#), Some(In::Stop { lease_id: "L1".into(), reason: Some("user".into()) }));
        assert_eq!(parse_in(r#"{"t":"answer","rid":"r1","behavior":"allow"}"#), Some(In::Answer { rid: "r1".into(), behavior: "allow".into(), message: None }));
        assert_eq!(parse_in(r#"{"t":"something-new","x":1}"#), Some(In::Unknown));
        assert_eq!(parse_in("not json"), None);
        assert_eq!(parse_in(r#"{"t":"start","slug":"s"}"#), None, "a start without a lease is not one");
        let big = format!(r#"{{"t":"tell","slug":"s","text":"{}"}}"#, "x".repeat(MAX_FRAME));
        assert_eq!(parse_in(&big), None);
    }

    #[test]
    fn builds_app_messages() {
        let h = hello("0.1.5", "LAPTOP", "Ahmed", "C:\\Users\\Ahmed", &Claude { path: Some("C:\\c.exe"), version: Some("2.1.0"), git_bash: false });
        assert_eq!(h, json!({"t":"hello","app_version":"0.1.5","platform":"windows","host":"LAPTOP","user":"Ahmed","home":"C:\\Users\\Ahmed","claude":{"path":"C:\\c.exe","version":"2.1.0","git_bash":false}}));
        let h = hello("0.1.5", "L", "u", "h", &Claude { path: None, version: None, git_bash: true });
        assert_eq!(h["claude"]["path"], Value::Null);
        assert_eq!(lease("L1", "active", Some(0), None), json!({"t":"lease","lease_id":"L1","state":"active","expires_at":"1970-01-01T00:00:00.000Z"}));
        assert_eq!(lease("L1", "ended", None, Some("stop-hotkey")), json!({"t":"lease","lease_id":"L1","state":"ended","reason":"stop-hotkey"}));
        let a = ask("r1", "s", "Bash", &json!({"command":"dir"}), Some("tu1"), None, "cli");
        assert_eq!(a, json!({"t":"ask","rid":"r1","slug":"s","tool":"Bash","input":{"command":"dir"},"tool_use_id":"tu1","origin":"cli"}));
        let a = ask("r2", "s", "Write", &json!({"content":"x".repeat(200_000)}), None, Some("why"), "hands");
        assert!(a.to_string().len() < 40_000);
        assert_eq!(a["reason"], "why");
        assert_eq!(cancel("r1"), json!({"t":"cancel","rid":"r1"}));
        let x = action("L1", "s", 1_000, "Bash", &"y".repeat(900), "auto", Some("AAA"));
        assert_eq!(x["summary"].as_str().unwrap().len(), 500);
        assert_eq!(x["at"], "1970-01-01T00:00:01.000Z");
        assert_eq!(x["shot"], "AAA");
        assert!(action("L", "s", 0, "t", "s", "denied", None).get("shot").is_none());
        assert_eq!(report("s", "done"), json!({"t":"report","slug":"s","text":"done"}));
        assert_eq!(session("s", "failed", Some("already under control")), json!({"t":"session","slug":"s","state":"failed","detail":"already under control"}));
        assert_eq!(session("s", "running", None), json!({"t":"session","slug":"s","state":"running"}));
    }

    #[test]
    fn times() {
        let t = parse_iso("2026-10-08T12:34:56.789Z").unwrap();
        assert_eq!(iso(t), "2026-10-08T12:34:56.789Z");
        assert_eq!(parse_iso("2026-10-08T14:34:56.789+02:00"), Some(t));
        assert_eq!(parse_iso("2026-10-08T12:34:56Z"), Some(t - 789));
        assert_eq!(parse_iso("2026-10-08T12:34:56.7Z"), Some(t - 89));
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(iso(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        for bad in ["", "2026-10-08", "2026-13-08T00:00:00Z", "2026-10-08T00:00:00", "2026-10-08T00:00:00+0200", "x026-10-08T00:00:00Z"] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
        let now = 1_000_000;
        assert_eq!(lease_expiry(&LeaseSpec { id: "L".into(), minutes: Some(30), expires_at: None }, now), Some(now + 30 * 60_000));
        assert_eq!(lease_expiry(&LeaseSpec { id: "L".into(), minutes: Some(30), expires_at: Some("1970-01-01T00:20:00Z".into()) }, now), Some(now + 30 * 60_000), "minutes first (clock skew)");
        assert_eq!(lease_expiry(&LeaseSpec { id: "L".into(), minutes: None, expires_at: Some("1970-01-01T00:20:00Z".into()) }, now), Some(1_200_000));
        assert_eq!(lease_expiry(&LeaseSpec { id: "L".into(), minutes: Some(500), expires_at: None }, now), Some(now + 60 * 60_000));
        assert_eq!(lease_expiry(&LeaseSpec { id: "L".into(), minutes: None, expires_at: Some("junk".into()) }, now), None);
    }

    #[test]
    fn slugs_and_codes() {
        assert!(slug_ok("laptop-1"));
        assert!(!slug_ok("Laptop"));
        assert!(!slug_ok("-x"));
        assert!(!slug_ok(""));
        assert!(!slug_ok(&"a".repeat(41)));
        assert_eq!(normalize_code("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code(" AB0O IL1Z ").as_deref(), Some("AB00111Z"));
        assert_eq!(normalize_code("ABCD-EFG"), None);
        assert_eq!(normalize_code("ABCD-EFGU"), None, "U is not Crockford");
        assert_eq!(normalize_code("ABCD_EFGH"), None);
        assert_eq!(clip("a\u{0}b\nc", 10), "ab\nc");
        assert_eq!(clip("ééé", 2), "éé");
    }
}
