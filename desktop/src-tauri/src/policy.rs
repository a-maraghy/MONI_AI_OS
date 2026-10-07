//! Small decisions, pure so they can be tested: when a Windows toast is shown,
//! the tray dot's colour, when the core holds still.

use crate::layout::Mode;

/// What the app knows about whether you can see MINT AI right now.
#[derive(Clone, Copy, Debug, Default)]
pub struct Seen {
    pub mode: Option<Mode>,
    /// Peek is showing.
    pub peek_open: bool,
    pub focus: bool,
    /// Floating hidden with its tool (Ctrl+Alt+M brings it back), or the window hidden for any reason.
    pub hidden: bool,
    /// Desktop layer: another window is in front (the foreground window is not the desktop or MINT AI).
    pub covered: bool,
    /// A full-screen app or game, or presentation mode.
    pub fullscreen: bool,
    /// The workstation is locked.
    pub locked: bool,
}

/// A toast only when MINT AI cannot be seen (DESIGN.md "Toasts"), and never in do-not-disturb.
pub fn should_toast(s: &Seen, dnd: bool) -> bool {
    if dnd {
        return false;
    }
    if s.hidden || s.focus || s.fullscreen || s.locked {
        return true;
    }
    match s.mode {
        Some(Mode::Floating) => false,
        Some(Mode::Peek) => !s.peek_open,
        Some(Mode::Desktop) => s.covered,
        None => true,
    }
}

/// The tray dot: amber when something needs you, green while it listens or speaks,
/// violet while it thinks or delegates, grey when offline or signed out, none when idle.
pub fn tray_dot(state: &str, needs: u32) -> Option<[u8; 3]> {
    match state {
        "offline" | "signedout" => Some([0x8A, 0x8F, 0x99]),
        _ if needs > 0 || state == "needs" => Some([0xFA, 0xBD, 0x4D]),
        "listening" | "speaking" => Some([0x00, 0xE6, 0xA5]),
        "thinking" | "delegating" => Some([0xA7, 0x6B, 0xFF]),
        _ => None,
    }
}

/// The tray tooltip / menu header line.
pub fn status_line(state: &str, needs: u32, sessions: u32) -> String {
    match state {
        "signedout" => "Signed out".into(),
        "offline" => "Offline · retrying".into(),
        _ => {
            let s = if sessions == 1 { "1 session".to_string() } else { format!("{} sessions", sessions) };
            if needs > 0 {
                format!("{} waiting on you · {}", needs, s)
            } else {
                let st = match state {
                    "listening" => "Listening",
                    "speaking" => "Speaking",
                    "thinking" => "Thinking",
                    "delegating" => "Handing over",
                    _ => "Ready",
                };
                format!("{} · {}", st, s)
            }
        }
    }
}

/// The core holds still (one frame per change, no GPU work between): battery saver on battery or with
/// Windows' energy saver; always while a full-screen app or game runs, the screen is locked, Windows'
/// "Animation effects" are off, or the window is hidden or (Desktop layer) covered by another window.
pub fn hold_still(battery_saver: bool, on_battery: bool, energy_saver: bool, s: &Seen, reduce_motion: bool) -> bool {
    (battery_saver && (on_battery || energy_saver)) || s.fullscreen || s.locked || reduce_motion || s.hidden || s.covered || (s.mode == Some(Mode::Peek) && !s.peek_open)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(mode: Mode) -> Seen {
        Seen { mode: Some(mode), ..Seen::default() }
    }

    #[test]
    fn toasts_only_when_it_cannot_be_seen() {
        assert!(!should_toast(&seen(Mode::Floating), false));
        assert!(should_toast(&Seen { hidden: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&seen(Mode::Peek), false));
        assert!(!should_toast(&Seen { peek_open: true, ..seen(Mode::Peek) }, false));
        assert!(!should_toast(&seen(Mode::Desktop), false));
        assert!(should_toast(&Seen { covered: true, ..seen(Mode::Desktop) }, false));
        assert!(should_toast(&Seen { focus: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&Seen { fullscreen: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&Seen { locked: true, ..seen(Mode::Floating) }, false));
    }

    #[test]
    fn do_not_disturb_silences_toasts() {
        assert!(!should_toast(&Seen { covered: true, ..seen(Mode::Desktop) }, true));
        assert!(!should_toast(&seen(Mode::Peek), true));
    }

    #[test]
    fn tray_dot_colours() {
        assert_eq!(tray_dot("idle", 0), None);
        assert_eq!(tray_dot("idle", 1), Some([0xFA, 0xBD, 0x4D]));
        assert_eq!(tray_dot("speaking", 0), Some([0x00, 0xE6, 0xA5]));
        assert_eq!(tray_dot("delegating", 0), Some([0xA7, 0x6B, 0xFF]));
        assert_eq!(tray_dot("offline", 3), Some([0x8A, 0x8F, 0x99]));
        assert_eq!(tray_dot("signedout", 0), Some([0x8A, 0x8F, 0x99]));
    }

    #[test]
    fn status_lines() {
        assert_eq!(status_line("idle", 0, 7), "Ready · 7 sessions");
        assert_eq!(status_line("thinking", 1, 7), "1 waiting on you · 7 sessions");
        assert_eq!(status_line("idle", 0, 1), "Ready · 1 session");
        assert_eq!(status_line("signedout", 0, 0), "Signed out");
    }

    #[test]
    fn still_core() {
        let s = seen(Mode::Floating);
        assert!(!hold_still(true, false, false, &s, false));
        assert!(hold_still(true, true, false, &s, false));
        assert!(!hold_still(false, true, false, &s, false));
        assert!(hold_still(false, false, false, &Seen { fullscreen: true, ..s }, false));
        assert!(hold_still(false, false, false, &Seen { covered: true, ..seen(Mode::Desktop) }, false));
        assert!(hold_still(false, false, false, &Seen { locked: true, ..s }, false));
        assert!(hold_still(false, false, false, &s, true));
        assert!(hold_still(false, false, false, &seen(Mode::Peek), false));
    }
}
