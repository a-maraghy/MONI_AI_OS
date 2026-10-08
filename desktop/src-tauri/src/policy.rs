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

/// A mode picked from the tray while the window was hidden (Peek sent away with Esc, Floating hidden
/// with its tool): it must show at once, on top and focused -- what "Show MINT AI" does -- and the
/// Desktop layer then goes down to the bottom when another window takes the focus. Shown plainly at
/// the bottom of the stack, it stayed out of sight (laptop test, 2026-10-08).
pub fn reveal_after_mode_change(was_visible: bool, mode: Mode) -> bool {
    !was_visible && mode != Mode::Peek
}

/// What Windows says about power, as the notifications (platform::watch_power) and the
/// fallback poll (GetSystemPowerStatus) report it. None: not heard from that source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PowerReport {
    /// GUID_ACDC_POWER_SOURCE: 0 AC, 1 battery (DC), 2 short-term (a UPS).
    pub acdc: Option<u32>,
    /// GUID_ENERGY_SAVER_STATUS (Windows 11 22H2+): 0 off, 1 standard, 2 high savings.
    pub energy_saver: Option<u32>,
    /// GUID_POWER_SAVING_STATUS (the older battery saver): 0 off, 1 on.
    pub power_saving: Option<u32>,
    /// SYSTEM_POWER_STATUS.ACLineStatus: 0 offline, 1 online, 255 unknown.
    pub ac_line: Option<u8>,
    /// SYSTEM_POWER_STATUS.SystemStatusFlag: 1 battery saver on.
    pub status_flag: Option<u8>,
}

/// (on battery, Windows' energy saver / battery saver on). The notifications win over the poll;
/// Windows 11's Energy saver status wins over the older battery-saver status, which is what
/// SystemStatusFlag mirrors (and which may not follow Energy saver).
pub fn power_state(r: &PowerReport) -> (bool, bool) {
    let on_battery = match (r.acdc, r.ac_line) {
        (Some(v), _) => v != 0,
        (None, Some(l)) => l == 0,
        (None, None) => false,
    };
    let saver = match (r.energy_saver, r.power_saving, r.status_flag) {
        (Some(v), _, _) => v != 0,
        (None, Some(v), _) => v != 0,
        (None, None, Some(f)) => f == 1,
        _ => false,
    };
    (on_battery, saver)
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

    /// The four power cases the laptop test walks: on battery or plugged in, Energy saver on or off,
    /// with the app's Battery saver on (it holds still on any of them but plugged-in-without-saver)
    /// and off (power never holds it still).
    #[test]
    fn still_core_power_cases() {
        let s = seen(Mode::Desktop);
        let case = |acdc: u32, es: u32| power_state(&PowerReport { acdc: Some(acdc), energy_saver: Some(es), ..Default::default() });
        let cases = [((1, 1), true), ((1, 0), true), ((0, 1), true), ((0, 0), false)];
        for ((acdc, es), want) in cases {
            let (bat, saver) = case(acdc, es);
            assert_eq!(bat, acdc == 1);
            assert_eq!(saver, es == 1);
            assert_eq!(hold_still(true, bat, saver, &s, false), want, "battery saver on, acdc {} energy saver {}", acdc, es);
            assert!(!hold_still(false, bat, saver, &s, false), "battery saver off, acdc {} energy saver {}", acdc, es);
        }
        // Energy saver's "high savings" is on too; a UPS counts as battery.
        assert_eq!(case(0, 2), (false, true));
        assert_eq!(case(2, 0), (true, false));
    }

    #[test]
    fn power_sources_in_order() {
        // Nothing heard: plugged in, no saver.
        assert_eq!(power_state(&PowerReport::default()), (false, false));
        // Only the poll (notifications not registered yet): ACLineStatus and SystemStatusFlag.
        assert_eq!(power_state(&PowerReport { ac_line: Some(0), status_flag: Some(1), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { ac_line: Some(255), status_flag: Some(0), ..Default::default() }), (false, false));
        // The notification wins over the poll (the poll can lag, or not follow Energy saver at all).
        assert_eq!(power_state(&PowerReport { acdc: Some(1), ac_line: Some(1), energy_saver: Some(1), status_flag: Some(0), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { acdc: Some(0), ac_line: Some(0), energy_saver: Some(0), status_flag: Some(1), ..Default::default() }), (false, false));
        // Before Windows 11 22H2 (no Energy saver status): the older battery-saver status.
        assert_eq!(power_state(&PowerReport { acdc: Some(1), power_saving: Some(1), status_flag: Some(0), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { acdc: Some(1), power_saving: Some(0), status_flag: Some(1), ..Default::default() }), (true, false));
    }

    #[test]
    fn mode_switch_from_hidden_shows_it() {
        // Peek hidden (Esc), then "On the desktop": shown and raised until something else takes the focus.
        assert!(reveal_after_mode_change(false, Mode::Desktop));
        assert!(reveal_after_mode_change(false, Mode::Floating));
        // Peek itself opens on top anyway; a visible window is left as it is.
        assert!(!reveal_after_mode_change(false, Mode::Peek));
        assert!(!reveal_after_mode_change(true, Mode::Desktop));
        assert!(!reveal_after_mode_change(true, Mode::Floating));
    }
}
