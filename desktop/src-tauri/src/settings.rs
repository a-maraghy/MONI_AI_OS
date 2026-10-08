//! The app's own settings: mode, presets, hotkeys, behaviour. A JSON file in the
//! app's config folder (%APPDATA%\com.mint-stack.mint-desktop\settings.json).
//! No secrets live here -- the sign-in is the webview's own cookie (its profile,
//! which Windows keeps per user).

use crate::layout::{Corner, Mode, Size};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DEFAULT_TALK: &str = "Ctrl+Space";
pub const FALLBACK_TALK: &str = "Ctrl+Alt+Space";
pub const DEFAULT_SHOW: &str = "Ctrl+Alt+M";
pub const DEFAULT_FOCUS: &str = "Ctrl+Alt+F";
/// Start / end a live (hands-free) call. Ctrl+Alt+L: no common Windows or Office binding (Win+L locks,
/// Ctrl+L is the address bar, Ctrl+Alt+L is free in Windows, Office, browsers, VS Code's default keymap).
pub const DEFAULT_LIVE: &str = "Ctrl+Alt+L";
pub const FALLBACK_LIVE: &str = "Ctrl+Alt+Shift+L";
pub const DEFAULT_ORIGIN: &str = "https://os.mint-stack.com";
/// Laptop control: end MINT AI's control of this computer at once (handled in the app, no server).
/// Esc is accepted only with both Ctrl and Alt (Ctrl+Esc is the Start menu, Alt+Esc switches windows).
pub const DEFAULT_STOP: &str = "Ctrl+Alt+Esc";
pub const FALLBACK_STOP: &str = "Ctrl+Alt+Shift+Esc";

/// Desktop-layer position presets (where the core sits across the screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Across {
    Left,
    Centre,
    Right,
}

impl Across {
    pub fn as_str(&self) -> &'static str {
        match self {
            Across::Left => "left",
            Across::Centre => "centre",
            Across::Right => "right",
        }
    }
}

/// What is remembered per monitor (keyed by the monitor's name and size).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PerMonitor {
    pub corner: Corner,
    pub across: Across,
    pub size: Size,
    pub opacity: u8,
}

impl Default for PerMonitor {
    fn default() -> Self {
        PerMonitor { corner: Corner::Br, across: Across::Right, size: Size::M, opacity: 100 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hotkeys {
    pub talk: String,
    pub show: String,
    pub focus: String,
    /// Start / end a live call (hands-free), pressed once.
    pub live: String,
    /// Laptop control: stop it now.
    pub stop: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Hotkeys { talk: DEFAULT_TALK.into(), show: DEFAULT_SHOW.into(), focus: DEFAULT_FOCUS.into(), live: DEFAULT_LIVE.into(), stop: DEFAULT_STOP.into() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub mode: Mode,
    pub focus: bool,
    pub hotkeys: Hotkeys,
    pub do_not_disturb: bool,
    /// Lower frame rate / still core on battery and during full-screen apps.
    pub battery_saver: bool,
    /// Real blur (acrylic) behind the cards, pills and panels (blur.rs, acrylic.rs); off: the tinted look.
    pub real_blur: bool,
    pub autostart: bool,
    /// The monitor MINT AI lives on (its name); empty = the primary.
    pub monitor: String,
    pub per_monitor: BTreeMap<String, PerMonitor>,
    /// Desktop layer behind the desktop icons (WorkerW). Undocumented Windows behaviour; no clicks reach it there.
    pub experimental_behind_icons: bool,
    pub check_updates: bool,
    /// The site, for a test server only; the app refuses anything that is not https.
    pub origin: String,
    /// Laptop control: claude.exe (or claude.cmd) to run; empty = look on PATH and the usual places.
    pub claude_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: Mode::Floating,
            focus: false,
            hotkeys: Hotkeys::default(),
            do_not_disturb: false,
            battery_saver: true,
            real_blur: true,
            autostart: true,
            monitor: String::new(),
            per_monitor: BTreeMap::new(),
            experimental_behind_icons: false,
            check_updates: true,
            origin: DEFAULT_ORIGIN.into(),
            claude_path: String::new(),
        }
    }
}

impl Settings {
    /// Read from JSON; anything missing or malformed falls back to its default, never fails.
    pub fn from_json(s: &str) -> Settings {
        let mut st: Settings = serde_json::from_str(s).unwrap_or_default();
        st.fix();
        st
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }
    /// Bring loaded values into range.
    pub fn fix(&mut self) {
        for pm in self.per_monitor.values_mut() {
            pm.opacity = pm.opacity.clamp(35, 100);
        }
        for (k, d) in [(&mut self.hotkeys.talk, DEFAULT_TALK), (&mut self.hotkeys.show, DEFAULT_SHOW), (&mut self.hotkeys.focus, DEFAULT_FOCUS), (&mut self.hotkeys.live, DEFAULT_LIVE), (&mut self.hotkeys.stop, DEFAULT_STOP)] {
            match normalize_hotkey(k) {
                Some(n) => *k = n,
                None => *k = d.into(),
            }
        }
        self.claude_path = self.claude_path.trim().trim_matches('"').chars().filter(|c| !c.is_control()).take(400).collect();
        if !origin_ok(&self.origin) {
            self.origin = DEFAULT_ORIGIN.into();
        }
        if self.per_monitor.len() > 16 {
            let keep: Vec<String> = self.per_monitor.keys().take(16).cloned().collect();
            self.per_monitor.retain(|k, _| keep.contains(k));
        }
    }
    pub fn monitor_prefs(&self, key: &str) -> PerMonitor {
        self.per_monitor.get(key).cloned().unwrap_or_default()
    }
    pub fn monitor_prefs_mut(&mut self, key: &str) -> &mut PerMonitor {
        self.per_monitor.entry(key.to_string()).or_default()
    }
}

/// The site may only be https on a host name (no paths, no credentials).
pub fn origin_ok(o: &str) -> bool {
    match url::Url::parse(o) {
        Ok(u) => u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty() && u.password().is_none() && (u.path() == "/" || u.path().is_empty()) && u.query().is_none(),
        Err(_) => false,
    }
}

const MODS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Win"];

/// A hotkey as the settings store it: modifiers in a fixed order, then one key ("Ctrl+Alt+M").
/// At least one modifier (a bare key would be taken from every other app); Win+ combinations
/// belong to Windows and are refused. None when it is not a valid hotkey.
pub fn normalize_hotkey(s: &str) -> Option<String> {
    let parts: Vec<String> = s.split('+').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 || parts.len() > 4 {
        return None;
    }
    let mut mods = [false; 4];
    let mut key: Option<String> = None;
    for p in &parts {
        let up = p.to_ascii_uppercase();
        let m = match up.as_str() {
            "CTRL" | "CONTROL" => Some(0),
            "ALT" | "OPTION" => Some(1),
            "SHIFT" => Some(2),
            "WIN" | "SUPER" | "META" | "CMD" => Some(3),
            _ => None,
        };
        match m {
            Some(i) => {
                if mods[i] {
                    return None;
                }
                mods[i] = true;
            }
            None => {
                if key.is_some() {
                    return None;
                }
                key = Some(normal_key(&up)?);
            }
        }
    }
    if mods[3] || !(mods[0] || mods[1]) {
        return None; // Win+ is Windows'; Shift alone types capitals
    }
    let key = key?;
    if key == "Esc" && !(mods[0] && mods[1]) {
        return None; // Ctrl+Esc is the Start menu, Alt+Esc switches windows
    }
    let mut out: Vec<String> = MODS.iter().enumerate().filter(|(i, _)| mods[*i]).map(|(_, m)| m.to_string()).collect();
    out.push(key);
    Some(out.join("+"))
}

fn normal_key(up: &str) -> Option<String> {
    let k = match up {
        "SPACE" => "Space".to_string(),
        "ENTER" | "RETURN" => "Enter".to_string(),
        "TAB" => "Tab".to_string(),
        "BACKQUOTE" | "`" => "Backquote".to_string(),
        "ESC" | "ESCAPE" => "Esc".to_string(),
        s if s.len() == 1 && s.chars().all(|c| c.is_ascii_alphanumeric()) => s.to_string(),
        s if s.starts_with('F') && s[1..].parse::<u8>().map(|n| (1..=24).contains(&n)).unwrap_or(false) => s.to_string(),
        _ => return None,
    };
    Some(k)
}

/// The hotkeys must all be different keys.
pub fn hotkeys_distinct(h: &Hotkeys) -> bool {
    let all = [&h.talk, &h.show, &h.focus, &h.live, &h.stop];
    (0..all.len()).all(|i| (i + 1..all.len()).all(|j| all[i] != all[j]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_design() {
        let s = Settings::default();
        assert_eq!(s.mode, Mode::Floating);
        assert_eq!(s.hotkeys.talk, "Ctrl+Space");
        assert_eq!(s.hotkeys.show, "Ctrl+Alt+M");
        assert_eq!(s.hotkeys.focus, "Ctrl+Alt+F");
        assert_eq!(s.hotkeys.live, "Ctrl+Alt+L");
        assert!(!s.experimental_behind_icons);
        assert!(s.real_blur, "real blur behind the cards is on by default");
        assert_eq!(s.monitor_prefs("any").corner, Corner::Br);
        assert_eq!(s.monitor_prefs("any").opacity, 100);
    }

    #[test]
    fn malformed_json_falls_back() {
        assert_eq!(Settings::from_json("not json"), Settings::default());
        let s = Settings::from_json(r#"{"mode":"desktop","hotkeys":{"talk":"Space"},"per_monitor":{"A":{"opacity":5}},"origin":"http://evil"}"#);
        assert_eq!(s.mode, Mode::Desktop);
        assert_eq!(s.hotkeys.talk, "Ctrl+Space", "a bare key is not a hotkey");
        assert_eq!(s.monitor_prefs("A").opacity, 35);
        assert_eq!(s.origin, DEFAULT_ORIGIN);
    }

    #[test]
    fn round_trip() {
        let mut s = Settings::default();
        s.mode = Mode::Peek;
        s.monitor_prefs_mut("DISPLAY2 2560x1440").size = Size::L;
        assert_eq!(Settings::from_json(&s.to_json()), s);
    }

    #[test]
    fn hotkeys_normalize() {
        assert_eq!(normalize_hotkey("ctrl + space").as_deref(), Some("Ctrl+Space"));
        assert_eq!(normalize_hotkey("Alt+Ctrl+m").as_deref(), Some("Ctrl+Alt+M"));
        assert_eq!(normalize_hotkey("Ctrl+Alt+Space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(normalize_hotkey("Ctrl+Shift+F12").as_deref(), Some("Ctrl+Shift+F12"));
        assert_eq!(normalize_hotkey("Space"), None);
        assert_eq!(normalize_hotkey("Shift+A"), None);
        assert_eq!(normalize_hotkey("Win+D"), None);
        assert_eq!(normalize_hotkey("Ctrl+A+B"), None);
        assert_eq!(normalize_hotkey("Ctrl+Ctrl+A"), None);
        assert_eq!(normalize_hotkey("Ctrl+F25"), None);
        assert_eq!(normalize_hotkey("Ctrl+Esc"), None);
    }

    #[test]
    fn distinct_hotkeys() {
        assert!(hotkeys_distinct(&Hotkeys::default()));
        assert!(!hotkeys_distinct(&Hotkeys { talk: "Ctrl+Alt+M".into(), ..Hotkeys::default() }));
    }

    #[test]
    fn origins() {
        assert!(origin_ok("https://os.mint-stack.com"));
        assert!(origin_ok("https://os.mint-stack.com/"));
        assert!(!origin_ok("http://os.mint-stack.com"));
        assert!(!origin_ok("https://user:pw@os.mint-stack.com"));
        assert!(!origin_ok("https://os.mint-stack.com/mint-ai"));
        assert!(!origin_ok("file:///c:/x"));
    }

    #[test]
    fn real_blur_setting() {
        // A settings file from 0.1.4 (no "real_blur") gets it on; an explicit off stays off.
        assert!(Settings::from_json(r#"{"mode":"floating"}"#).real_blur);
        assert!(!Settings::from_json(r#"{"real_blur":false}"#).real_blur);
    }

    #[test]
    fn live_hotkey() {
        // A settings file from 0.1.3 (no "live") gets the default; a bad one is put back to it.
        let s = Settings::from_json(r#"{"hotkeys":{"talk":"Ctrl+Space","show":"Ctrl+Alt+M","focus":"Ctrl+Alt+F"}}"#);
        assert_eq!(s.hotkeys.live, DEFAULT_LIVE);
        let s = Settings::from_json(r#"{"hotkeys":{"live":"L"}}"#);
        assert_eq!(s.hotkeys.live, DEFAULT_LIVE);
        let s = Settings::from_json(r#"{"hotkeys":{"live":"alt+ctrl+k"}}"#);
        assert_eq!(s.hotkeys.live, "Ctrl+Alt+K");
        assert_eq!(normalize_hotkey(FALLBACK_LIVE).as_deref(), Some(FALLBACK_LIVE));
        let mut h = Hotkeys::default();
        assert!(hotkeys_distinct(&h));
        h.live = h.show.clone();
        assert!(!hotkeys_distinct(&h), "the live key may not be another hotkey");
        h.live = h.talk.clone();
        assert!(!hotkeys_distinct(&h));
        let d = Hotkeys::default();
        assert!([&d.talk, &d.show, &d.focus].iter().all(|k| **k != DEFAULT_LIVE && **k != FALLBACK_LIVE));
    }

    #[test]
    fn stop_hotkey() {
        let d = Settings::default();
        assert_eq!(d.hotkeys.stop, "Ctrl+Alt+Esc");
        assert_eq!(d.claude_path, "");
        assert_eq!(normalize_hotkey("alt+ctrl+escape").as_deref(), Some("Ctrl+Alt+Esc"));
        assert_eq!(normalize_hotkey(FALLBACK_STOP).as_deref(), Some(FALLBACK_STOP));
        assert_eq!(normalize_hotkey("Ctrl+Esc"), None, "the Start menu");
        assert_eq!(normalize_hotkey("Alt+Esc"), None);
        // A 0.1.4 settings file has no stop key: the default; a bad one goes back to it.
        let s = Settings::from_json(r#"{"hotkeys":{"talk":"Ctrl+Space"},"claude_path":"  \"C:\\x\\claude.exe\" "}"#);
        assert_eq!(s.hotkeys.stop, DEFAULT_STOP);
        assert_eq!(s.claude_path, "C:\\x\\claude.exe");
        assert_eq!(Settings::from_json(r#"{"hotkeys":{"stop":"Esc"}}"#).hotkeys.stop, DEFAULT_STOP);
        let mut h = Hotkeys::default();
        h.stop = h.show.clone();
        assert!(!hotkeys_distinct(&h), "the stop key may not be another hotkey");
    }
}
