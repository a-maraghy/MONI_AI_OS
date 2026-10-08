//! "MINT AI is controlling" -- always visible while a lease is on: a glowing frame on every monitor
//! (transparent, click-through, on top, not focusable) and the pill at the top of the primary
//! monitor (time left, +15 min, Stop). Both are excluded from screen capture (content_protected =
//! SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE), so the hands' screenshots do not see them.
//! Call these on the main thread.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder};

pub const PILL: &str = "mint-pill";
const FRAME: &str = "mint-frame-";
/// The pill's size in logical pixels.
const PILL_W: f64 = 520.0;
const PILL_H: f64 = 46.0;

pub fn show(app: &AppHandle) {
    hide(app);
    let mons = app.available_monitors().unwrap_or_default();
    for (i, m) in mons.iter().enumerate() {
        let label = format!("{}{}", FRAME, i);
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("overlay.html".into()))
            .title("MINT AI is controlling this computer")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(false)
            .focusable(false)
            .content_protected(true)
            .visible(false)
            .build();
        match built {
            Ok(w) => {
                let _ = w.set_position(Position::Physical(PhysicalPosition::new(m.position().x, m.position().y)));
                let _ = w.set_size(Size::Physical(PhysicalSize::new(m.size().width, m.size().height)));
                let _ = w.set_ignore_cursor_events(true);
                let _ = w.show();
            }
            Err(e) => mlog!("control frame {} not shown: {}", i, e),
        }
    }
    let primary = app.primary_monitor().ok().flatten().or_else(|| mons.first().cloned());
    let built = WebviewWindowBuilder::new(app, PILL, WebviewUrl::App("pill.html".into()))
        .title("MINT AI is controlling this computer")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        // Not focusable: the hands type into the window in front, and the pill must never take it.
        .focusable(false)
        .content_protected(true)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            if let Some(m) = primary {
                let s = m.scale_factor();
                let (w_px, h_px) = ((PILL_W * s) as u32, (PILL_H * s) as u32);
                let wa = m.work_area();
                let x = wa.position.x + (wa.size.width as i32 - w_px as i32) / 2;
                let y = wa.position.y + (10.0 * s) as i32;
                let _ = w.set_size(Size::Physical(PhysicalSize::new(w_px, h_px)));
                let _ = w.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            }
            let _ = w.show();
        }
        Err(e) => mlog!("control pill not shown: {}", e),
    }
}

pub fn hide(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label == PILL || label.starts_with(FRAME) {
            let _ = w.destroy();
        }
    }
}
