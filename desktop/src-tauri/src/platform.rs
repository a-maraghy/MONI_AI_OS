//! The Windows-only parts: what is in front, full-screen apps, power, the
//! wallpaper's brightness, the desktop's icon layer. Every function has a
//! harmless answer on other systems, so the rest of the app builds and its
//! tests run anywhere.

/// What has the keyboard focus right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Front {
    /// The desktop itself (its wallpaper / icons, or "show desktop" with Win+D).
    Desktop,
    /// MINT AI's own window.
    Ours,
    /// Any other window.
    Other,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ink {
    /// Light text, for a dark or busy wallpaper.
    Light,
    /// Dark text, for a light wallpaper.
    Dark,
}

impl Ink {
    pub fn as_str(&self) -> &'static str {
        match self {
            Ink::Light => "light",
            Ink::Dark => "dark",
        }
    }
}

/// Mean luminance (0..1) of RGB pixels -> the ink: dark ink only on a clearly light wallpaper.
pub fn ink_for_luminance(l: f64) -> Ink {
    if l > 0.62 {
        Ink::Dark
    } else {
        Ink::Light
    }
}

pub fn luminance(r: u8, g: u8, b: u8) -> f64 {
    fn lin(c: u8) -> f64 {
        let c = c as f64 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }
    // Perceived lightness (CIE L*), 0..1, of the relative luminance.
    let y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    if y <= 0.008856 {
        y * 9.033
    } else {
        (1.16 * y.cbrt()) - 0.16
    }
}

#[cfg(windows)]
mod imp {
    use super::{Front, Ink};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetForegroundWindow, SendMessageTimeoutW, SetParent, SystemParametersInfoW, GA_ROOTOWNER,
        SMTO_NORMAL, SPI_GETCLIENTAREAANIMATION, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    use windows::Win32::Graphics::Gdi::GetSysColor;
    use windows::Win32::Graphics::Gdi::SYS_COLOR_INDEX;

    pub fn hwnd_of(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    pub fn front(ours: isize) -> Front {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() {
            return Front::Unknown;
        }
        let root = unsafe { GetAncestor(fg, GA_ROOTOWNER) };
        let r = if root.0.is_null() { fg } else { root };
        if r.0 as isize == ours || fg.0 as isize == ours {
            return Front::Ours;
        }
        match class_of(r).as_str() {
            "WorkerW" | "Progman" | "Shell_TrayWnd" => Front::Desktop,
            _ => Front::Other,
        }
    }

    /// A full-screen app, a game in exclusive mode, or presentation mode ("quiet hours" excluded).
    pub fn fullscreen() -> bool {
        match unsafe { SHQueryUserNotificationState() } {
            Ok(QUERY_USER_NOTIFICATION_STATE(s)) => s == QUNS_BUSY.0 || s == QUNS_RUNNING_D3D_FULL_SCREEN.0 || s == QUNS_PRESENTATION_MODE.0,
            Err(_) => false,
        }
    }

    /// (on battery, Windows' battery saver / energy saver on)
    pub fn power() -> (bool, bool) {
        let mut p = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut p) }.is_err() {
            return (false, false);
        }
        (p.ACLineStatus == 0, p.SystemStatusFlag == 1)
    }

    /// The screen is locked (or another desktop, like a UAC prompt, has the input).
    pub fn locked() -> bool {
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100)) } {
            Ok(d) => {
                let _ = unsafe { CloseDesktop(d) };
                false
            }
            Err(_) => true,
        }
    }

    /// Windows "Animation effects" off: hold the core still.
    pub fn reduce_motion() -> bool {
        let mut on: i32 = 1;
        let ok = unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut on as *mut i32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) };
        ok.is_ok() && on == 0
    }

    pub fn wallpaper_path() -> Option<String> {
        let mut buf = [0u16; 520];
        let ok = unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buf.len() as u32, Some(buf.as_mut_ptr() as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) };
        if ok.is_err() {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
        let s = String::from_utf16_lossy(&buf[..n]);
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }

    /// The wallpaper's lightness under a part of the monitor (fractions 0..1 of its width and height),
    /// assuming it fills the screen; a solid-colour desktop uses that colour.
    pub fn wallpaper_ink(fx0: f64, fy0: f64, fx1: f64, fy1: f64) -> Option<Ink> {
        if let Some(p) = wallpaper_path() {
            if let Ok(img) = image::open(&p) {
                let img = img.thumbnail(320, 320).to_rgb8();
                let (w, h) = (img.width() as f64, img.height() as f64);
                let (x0, y0) = ((fx0.clamp(0.0, 1.0) * w) as u32, (fy0.clamp(0.0, 1.0) * h) as u32);
                let (x1, y1) = (((fx1.clamp(0.0, 1.0) * w) as u32).max(x0 + 1).min(img.width()), ((fy1.clamp(0.0, 1.0) * h) as u32).max(y0 + 1).min(img.height()));
                let (mut sum, mut n) = (0.0, 0.0);
                for y in y0..y1 {
                    for x in x0..x1 {
                        let p = img.get_pixel(x, y);
                        sum += super::luminance(p[0], p[1], p[2]);
                        n += 1.0;
                    }
                }
                if n > 0.0 {
                    return Some(super::ink_for_luminance(sum / n));
                }
            }
        }
        let c = unsafe { GetSysColor(SYS_COLOR_INDEX(1)) }; // COLOR_DESKTOP
        Some(super::ink_for_luminance(super::luminance((c & 0xFF) as u8, ((c >> 8) & 0xFF) as u8, ((c >> 16) & 0xFF) as u8)))
    }

    /// Experimental: put the window behind the desktop icons (the WorkerW trick live wallpapers use).
    /// Undocumented; Windows 11 24H2 changed the window tree, both trees are handled. No clicks reach
    /// the window there -- the icon list is on top. Returns whether it worked.
    pub fn behind_icons(ours: isize) -> bool {
        unsafe {
            let progman = match FindWindowW(windows::core::w!("Progman"), PCWSTR::null()) {
                Ok(h) => h,
                Err(_) => return false,
            };
            let mut _res = 0usize;
            // Ask Progman to create the WorkerW behind the icons.
            let _ = SendMessageTimeoutW(progman, 0x052C, WPARAM(0xD), LPARAM(0x1), SMTO_NORMAL, 1000, Some(&mut _res));
            let _ = SendMessageTimeoutW(progman, 0x052C, WPARAM(0), LPARAM(0), SMTO_NORMAL, 1000, Some(&mut _res));
            // 24H2: the WorkerW is a child of Progman.
            let mut worker = FindWindowExW(Some(progman), None, windows::core::w!("WorkerW"), PCWSTR::null()).unwrap_or_default();
            if worker.0.is_null() {
                // Before 24H2: the WorkerW after the one that holds SHELLDLL_DefView.
                static mut FOUND: isize = 0;
                unsafe extern "system" fn each(h: HWND, _: LPARAM) -> windows::core::BOOL {
                    if let Ok(def) = FindWindowExW(Some(h), None, windows::core::w!("SHELLDLL_DefView"), PCWSTR::null()) {
                        if !def.0.is_null() {
                            if let Ok(w) = FindWindowExW(None, Some(h), windows::core::w!("WorkerW"), PCWSTR::null()) {
                                FOUND = w.0 as isize;
                            }
                        }
                    }
                    windows::core::BOOL(1)
                }
                FOUND = 0;
                let _ = EnumWindows(Some(each), LPARAM(0));
                worker = HWND(FOUND as *mut core::ffi::c_void);
            }
            if worker.0.is_null() {
                return false;
            }
            SetParent(hwnd_of(ours), Some(worker)).is_ok()
        }
    }

    pub fn leave_icons(ours: isize) {
        unsafe {
            let _ = SetParent(hwnd_of(ours), None);
        }
    }

    /// The cursor in screen pixels -- straight from Windows, from any thread, without asking the
    /// app's main thread (the click-through loop runs 30 times a second and must never wait on it).
    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = windows::Win32::Foundation::POINT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) }.ok()?;
        Some((p.x, p.y))
    }

    /// The window's outer rectangle in screen pixels (same: from any thread, no main-thread call).
    pub fn window_rect(ours: isize) -> Option<(i32, i32, i32, i32)> {
        let mut r = windows::Win32::Foundation::RECT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd_of(ours), &mut r) }.ok()?;
        Some((r.left, r.top, r.right, r.bottom))
    }

    pub fn minimized(ours: isize) -> bool {
        unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd_of(ours)) }.as_bool()
    }

    /// Is this virtual key down now (the physical state, from any thread)?
    pub fn key_down(vk: u16) -> bool {
        (unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Front, Ink};
    pub fn front(_ours: isize) -> Front {
        Front::Unknown
    }
    pub fn fullscreen() -> bool {
        false
    }
    pub fn power() -> (bool, bool) {
        (false, false)
    }
    pub fn locked() -> bool {
        false
    }
    pub fn reduce_motion() -> bool {
        false
    }
    pub fn wallpaper_ink(_: f64, _: f64, _: f64, _: f64) -> Option<Ink> {
        None
    }
    pub fn behind_icons(_ours: isize) -> bool {
        false
    }
    pub fn leave_icons(_ours: isize) {}
    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn window_rect(_ours: isize) -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn minimized(_ours: isize) -> bool {
        false
    }
    pub fn key_down(_vk: u16) -> bool {
        false
    }
}

pub use imp::*;

/// The Windows virtual-key code of a shortcut's main key ("Ctrl+Space" -> 0x20), for the ones the
/// settings offer: Space, A-Z, 0-9, F1-F24, Enter, Tab, Backquote. None for anything else.
pub fn vk_of(shortcut: &str) -> Option<u16> {
    let k = shortcut.rsplit('+').next()?.trim();
    let u = k.to_ascii_uppercase();
    match u.as_str() {
        "SPACE" => return Some(0x20),
        "ENTER" | "RETURN" => return Some(0x0D),
        "TAB" => return Some(0x09),
        "BACKQUOTE" | "`" => return Some(0xC0),
        _ => {}
    }
    let k = u.strip_prefix("KEY").or_else(|| u.strip_prefix("DIGIT")).unwrap_or(&u);
    if k.len() == 1 {
        let c = k.as_bytes()[0];
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(c as u16);
        }
    }
    if let Some(n) = u.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn talk_key_codes() {
        assert_eq!(vk_of("Ctrl+Space"), Some(0x20));
        assert_eq!(vk_of("Ctrl+Alt+Space"), Some(0x20));
        assert_eq!(vk_of("Ctrl+Shift+K"), Some(b'K' as u16));
        assert_eq!(vk_of("Alt+KeyT"), Some(b'T' as u16));
        assert_eq!(vk_of("Ctrl+F9"), Some(0x78));
        assert_eq!(vk_of("Ctrl+7"), Some(b'7' as u16));
        assert_eq!(vk_of("Ctrl+PageUp"), None);
    }

    #[test]
    fn ink_follows_the_wallpaper() {
        assert_eq!(ink_for_luminance(luminance(255, 255, 255)), Ink::Dark);
        assert_eq!(ink_for_luminance(luminance(0, 0, 0)), Ink::Light);
        // The mockup's three wallpapers: a light lavender, a dark navy, a sunset photo.
        assert_eq!(ink_for_luminance(luminance(0xEC, 0xF0, 0xFA)), Ink::Dark);
        assert_eq!(ink_for_luminance(luminance(0x10, 0x1A, 0x3A)), Ink::Light);
        assert_eq!(ink_for_luminance(luminance(0x9A, 0x5A, 0x96)), Ink::Light);
        // A mid grey is "busy": light ink on the tinted pills.
        assert_eq!(ink_for_luminance(luminance(128, 128, 128)), Ink::Light);
        assert!((luminance(255, 255, 255) - 1.0).abs() < 1e-6);
    }
}
