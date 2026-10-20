//! The Office engine: the user's own Word, Excel or PowerPoint driven through COM by a fixed
//! PowerShell script (office.ps1), for office_edit (when Office is installed) and pdf_export.
//!
//! How it runs: `powershell.exe -NoProfile -NonInteractive -EncodedCommand <bootstrap>` with no
//! window, put in the control session's Job Object (the lease's end, or the stop key, kills it with
//! everything else) and given a time limit. The bootstrap reads two base64 lines from stdin -- the
//! script and the job -- so nothing the model wrote is ever part of a command line or of the code:
//! the job is data (ConvertFrom-Json). The answer comes back as one base64 JSON line.
//!
//! Pure parts (the job, the payload, the answer, the paragraphs' expected texts) are unit-tested in
//! core-tests; the process and the registry check are Windows only.

use base64::Engine;
use serde_json::{json, Value};

use super::ooxml::{self, Op};
use super::paths::Office;

/// office.ps1, as shipped in the app (never built from input).
pub const SCRIPT: &str = include_str!("office.ps1");
/// Office gets this long for one job, then the job is killed.
pub const TIMEOUT_SECS: u64 = 180;

/// The bootstrap the command line carries: reads the script and the job from stdin and runs it.
pub const BOOTSTRAP: &str = "$ErrorActionPreference='Stop';$a=[Console]::In.ReadLine();$b=[Console]::In.ReadLine();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a));$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))|ConvertFrom-Json;& ([ScriptBlock]::Create($s)) -Job $j";

/// -EncodedCommand's argument: base64 of the UTF-16LE text.
pub fn encoded_command(cmd: &str) -> String {
    let utf16: Vec<u8> = cmd.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

pub fn args() -> Vec<String> {
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"].iter().map(|s| s.to_string()).chain(std::iter::once(encoded_command(BOOTSTRAP))).collect()
}

/// The job for office.ps1. `action` "edit" (with ops) or "export" (to PDF).
pub fn job(action: &str, kind: Office, src: &str, out: &str, ops: Option<Value>) -> Value {
    json!({ "action": action, "kind": kind.ext(), "src": src, "out": out, "ops": ops.unwrap_or(json!([])) })
}

/// What goes to stdin: the script and the job, each one base64 line.
pub fn stdin_payload(job: &Value) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("{}\n{}\n", b.encode(SCRIPT.as_bytes()), b.encode(job.to_string().as_bytes()))
}

/// office.ps1's answer -> its notes, or the error it gave.
pub fn parse_answer(stdout: &str) -> Result<Vec<String>, String> {
    let line = stdout.trim();
    let bytes = base64::engine::general_purpose::STANDARD.decode(line.lines().last().unwrap_or("").trim()).map_err(|_| "Office did not answer (PowerShell could not run the Office script).".to_string())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "Office's answer could not be read.".to_string())?;
    let notes: Vec<String> = match v.get("notes") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    };
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(notes)
    } else {
        let e = v.get("error").and_then(Value::as_str).unwrap_or("Office reported an error.");
        Err(format!("Office: {}", e.chars().take(400).collect::<String>()))
    }
}

/// The edits for office.ps1, each Word paragraph edit carrying the text office_read showed for that
/// paragraph at that point (`expect`): Word counts paragraphs in tables a little differently, so the
/// script checks the paragraph by its text and finds the right one when the number is off. The
/// texts come from running the same edits on a copy with the file engine.
pub fn ops_for_office(kind: Office, original: &[u8], ops: &[Op]) -> Value {
    let mut out = ooxml::ops_json(ops);
    if kind != Office::Docx {
        return out;
    }
    let mut cur = original.to_vec();
    for (i, op) in ops.iter().enumerate() {
        let texts = ooxml::Package::open(&cur).map(|p| ooxml::docx_paragraph_texts(&p)).unwrap_or_default();
        let at = match op {
            Op::SetParagraph { index, .. } | Op::DeleteParagraph { index } => Some(*index),
            Op::InsertParagraph { after: Some(n), .. } if *n > 0 => Some(*n),
            _ => None,
        };
        if let Some(n) = at {
            if let Some(t) = texts.get(n - 1) {
                out[i]["expect"] = json!(t);
            }
        }
        match ooxml::edit(kind, &cur, std::slice::from_ref(op)) {
            Ok((next, _)) => cur = next,
            Err(_) => break, // the rest go by number only
        }
    }
    out
}

/* ------------------------------------------------------------------ Windows: is it installed, run it */

/// Is the Office app for this kind installed (its COM class registered)?
#[cfg(windows)]
pub fn installed(kind: Office) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
    let prog = match kind {
        Office::Docx => "Word.Application\\CLSID",
        Office::Xlsx => "Excel.Application\\CLSID",
        Office::Pptx => "PowerPoint.Application\\CLSID",
        Office::Pdf => return false,
    };
    let w: Vec<u16> = prog.encode_utf16().chain(std::iter::once(0)).collect();
    let mut h = HKEY::default();
    unsafe {
        let ok = RegOpenKeyExW(HKEY_CLASSES_ROOT, PCWSTR(w.as_ptr()), Some(0), KEY_READ, &mut h).is_ok();
        if ok {
            let _ = RegCloseKey(h);
        }
        ok
    }
}

#[cfg(not(windows))]
pub fn installed(_kind: Office) -> bool {
    false
}

/// Run one job. `contain` puts the PowerShell process in the session's Job Object (false = refused).
#[cfg(windows)]
pub fn run(job: &Value, contain: &dyn Fn(&std::process::Child) -> bool) -> Result<Vec<String>, String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps = format!("{sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let mut child = Command::new(&ps)
        .args(args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("PowerShell could not start: {e}"))?;
    if !contain(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The Office job could not be tied to this control session, so it was not run.".into());
    }
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(stdin_payload(job).as_bytes());
    }
    let mut so = child.stdout.take().ok_or("no stdout")?;
    let mut se = child.stderr.take().ok_or("no stderr")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() > Duration::from_secs(TIMEOUT_SECS) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Office did not finish within {TIMEOUT_SECS} seconds (it may be showing a message on screen); the job was stopped."));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    parse_answer(&out).map_err(|e| {
        let said = err.lines().find(|l| !l.trim().is_empty()).map(|l| l.chars().take(200).collect::<String>());
        match said {
            Some(s) if e.starts_with("Office did not answer") => format!("{e} ({s})"),
            _ => e,
        }
    })
}

#[cfg(not(windows))]
pub fn run(_job: &Value, _contain: &dyn Fn(&std::process::Child) -> bool) -> Result<Vec<String>, String> {
    Err("Office is only used on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hands::docs;

    #[test]
    fn the_script_is_fixed_and_safe() {
        // Macros never run; originals open read-only; the user's instance is not closed; no Invoke-Expression.
        for must in ["AutomationSecurity = 3", "EnableEvents = $false", "Documents.Open($src, $false, $true", "Workbooks.Open($src, 0, $true", "Presentations.Open($src, -1, 0, 0)", "-not $restore.running", "ExportAsFixedFormat($out, 17)", "SaveAs($out, 32)"] {
            assert!(SCRIPT.contains(must), "missing: {must}");
        }
        for never in ["Invoke-Expression", "iex ", "Start-Process", "RunAutoMacros", ".Run(", "Add-Type", "DownloadString", "Invoke-WebRequest"] {
            assert!(!SCRIPT.contains(never), "must not: {never}");
        }
        assert!(SCRIPT.len() < 24_000);
    }

    #[test]
    fn command_line_and_payload() {
        let a = args();
        assert_eq!(&a[..6], &["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        let decoded = base64::engine::general_purpose::STANDARD.decode(&a[6]).unwrap();
        let u16s: Vec<u16> = decoded.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&u16s).unwrap(), BOOTSTRAP);
        assert!(a[6].len() < 2000, "the command line stays short");
        let j = job("edit", Office::Docx, "C:\\a\\R.docx", "C:\\a\\R (edited).docx", Some(json!([{"op": "replace", "find": "'; Remove-Item C:\\ -Recurse; '", "with": "x"}])));
        let p = stdin_payload(&j);
        let lines: Vec<&str> = p.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))), "only base64: nothing the model wrote reaches PowerShell as code");
        let back: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(lines[1]).unwrap()).unwrap();
        assert_eq!(back, j);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(lines[0]).unwrap(), SCRIPT.as_bytes());
    }

    #[test]
    fn answers() {
        let enc = |v: Value| base64::engine::general_purpose::STANDARD.encode(v.to_string());
        assert_eq!(parse_answer(&enc(json!({"ok": true, "notes": ["a", "b"]}))).unwrap(), vec!["a", "b"]);
        assert_eq!(parse_answer(&enc(json!({"ok": true, "notes": "one"}))).unwrap(), vec!["one"]);
        assert_eq!(parse_answer(&enc(json!({"ok": false, "error": "There is no slide 9."}))).unwrap_err(), "Office: There is no slide 9.");
        assert!(parse_answer("garbage!").unwrap_err().contains("did not answer"));
        assert!(parse_answer("").is_err());
    }

    #[test]
    fn word_edits_carry_the_expected_text() {
        let blocks = docs::parse_blocks(Some(&json!(["One", "Two", "Three"]))).unwrap();
        let f = docs::build_docx("T", &blocks).unwrap();
        let ops = ooxml::parse_ops(Office::Docx, &json!([{"insert_paragraph": {"text": "Zero", "after": 0}}, {"set_paragraph": {"index": 3, "text": "2"}}, {"delete_paragraph": {"index": 4}}, {"replace": {"find": "One", "with": "1"}}])).unwrap();
        let o = ops_for_office(Office::Docx, &f, &ops);
        let texts = ooxml::docx_paragraph_texts(&ooxml::Package::open(&f).unwrap());
        // After "Zero" goes in at the start, paragraph 3 is the original paragraph 2 (index 1 before the edit).
        assert_eq!(o[1]["expect"], json!(texts[1]), "{o}");
        assert_eq!(o[0].get("expect"), None, "inserting at the start names no paragraph");
        assert!(o[2]["expect"].is_string());
        assert_eq!(o[3]["op"], "replace");
        let x = ops_for_office(Office::Xlsx, b"", &ooxml::parse_ops(Office::Xlsx, &json!([{"set_cells": {"cell": "A1", "values": [[1]]}}])).unwrap());
        assert_eq!(x[0]["cell"], "A1");
    }
}
