//! Companion mode in the app: the loop that reads Windows' window geometry (platform.rs), asks companion.rs
//! where the bot goes, moves its small window there, and tells the page what the bot is doing
//! (mint://companion: walk, hop, step out / in, arrive, duck, pop up, attention; mint://companion-look: the
//! cursor, for its eyes). The page draws the bot and reports its hit regions (the bot, the session bots).
//!
//! The rules of lib.rs hold here too: Windows is read straight from this thread; every window change that
//! needs the app goes to the main thread (on_main) without waiting; the Shared lock is never held across
//! an AppHandle / window call. Moving the window along a walk is a direct, asynchronous SetWindowPos
//! (platform::move_window): the window's thread does it, nobody waits.
//!
//! The acrylic blur stays off in this mode (lib.rs blur_glass): the bot has its own backplate, and a blur
//! window must never move while shown (0.1.10) -- this window moves all the time.

use super::*;
use crate::companion::{self as cp, Dodge, DodgeOut, Follow, Leg, LegKind, Perch, Stance, Surface};
use serde_json::json;

/// The bot's state in the app (App::comp).
#[derive(Default)]
pub struct CompState {
    /// Where it perches (the end of the walk under way, once it arrives).
    pub perch: Option<Perch>,
    /// The window's top-left now and the scale and stance it is drawn at (apply() places the window here).
    pub at: Option<(i32, i32, f64, Stance)>,
    pub legs: Vec<Leg>,
    pub dest: Option<Perch>,
    pub started_ms: u64,
    pub leg_shown: usize,
    pub follow: Follow,
    pub dodge: Dodge,
    /// Ducked out (hidden) and why; and a duck under way (the page plays it, the window hides after).
    pub ducked: Option<String>,
    pub duck_at: Option<u64>,
    pub duck_why: Option<String>,
    /// The page says the bot dozes: it goes back to the taskbar to sleep.
    pub dozing: bool,
    pub attention: bool,
    pub last_look: Option<(f64, f64)>,
}

impl CompState {
    pub fn reset(&mut self) {
        *self = CompState::default();
        set_anchor(None);
    }
}

/* Where the window is, for monitor_for() without the lock (its rule: no lock across app calls). */
static ANCHOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
fn set_anchor(p: Option<(i32, i32)>) {
    if let Ok(mut a) = ANCHOR.lock() {
        *a = p;
    }
}
/// The point the companion window is centred on (None: not placed yet).
pub fn anchor() -> Option<(i32, i32)> {
    ANCHOR.lock().ok().and_then(|a| *a)
}

/// The companion window's rectangle (apply()): where it is now, or -- before the loop placed it -- the floor
/// of this monitor's work area, on its right part (the loop hops it onto the taskbar or a window at once).
pub fn rect(a: &App, work: Rect, scale: f64) -> Rect {
    let (x, y, s) = match a.comp.at {
        Some((x, y, s, _)) => (x, y, s),
        None => {
            let mon = cp::Monitor { id: 0, rect: work, work, scale };
            let p = cp::taskbar_perch(&mon, None, a.settings.companion.side);
            let (x, y) = cp::window_pos(&p);
            (x, y, scale)
        }
    };
    let (w, h) = cp::window_size(s);
    Rect { x, y, w, h }
}

/// What the page is told about the companion with its state (PageState::companion).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub perch: &'static str,
    pub session_bots: bool,
    pub stance: Stance,
    pub lean: i8,
    /// The side of the bot with more room on the screen (the session bots gather there first).
    pub open_side: &'static str,
    pub surface: Option<Surface>,
    pub ducked: bool,
}

pub fn view(a: &App) -> Option<View> {
    if a.settings.mode != Mode::Companion {
        return None;
    }
    let p = a.comp.perch;
    Some(View {
        perch: a.settings.companion.perch.as_str(),
        session_bots: a.settings.companion.session_bots,
        stance: p.map(|p| p.stance).unwrap_or(Stance::Stand),
        lean: p.map(|p| p.lean).unwrap_or(0),
        open_side: p.map(open_side).unwrap_or("left"),
        surface: p.map(|p| p.surface),
        ducked: a.comp.ducked.is_some(),
    })
}

fn open_side(p: Perch) -> &'static str {
    if p.ax - p.span.0 > p.span.1 - p.ax {
        "left"
    } else {
        "right"
    }
}

/// The page's own word (command `companion`): "open" the Command Center (a click on the bot), "doze" /
/// "wake" (it goes back to the taskbar to sleep).
pub fn page_says(app: &AppHandle, shared: &Shared, kind: &str) {
    match kind {
        "open" => {
            {
                let mut a = shared.lock().unwrap();
                if a.settings.mode != Mode::Companion {
                    return;
                }
                a.peek_open = true;
                a.ignoring = None;
            }
            apply(app, shared, true);
        }
        "doze" | "wake" => {
            shared.lock().unwrap().comp.dozing = kind == "doze";
        }
        _ => {}
    }
}

fn emit(app: &AppHandle, name: &'static str, v: serde_json::Value) {
    let h = app.clone();
    on_main(app, move |_| {
        let _ = h.emit_to(MAIN, name, v);
    });
}

fn leg_event(l: &Leg, p: Option<&Perch>) -> serde_json::Value {
    json!({
        "kind": l.kind, "ms": l.ms, "dir": l.dir, "stance": l.stance,
        "lean": p.map(|p| p.lean).unwrap_or(0),
        "rise": (l.from.1 - l.to.1) as f64 / l.scale.max(0.25),
    })
}

/// Place the window (main thread): position and size, for a crossing to another monitor (its DPI) or a
/// placement without a walk. The size changes only on a crossing.
fn place(app: &AppHandle, x: i32, y: i32, scale: f64) {
    let (w, h) = cp::window_size(scale);
    on_main(app, move |app| {
        if let Some(win) = main_window(app) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            let _ = win.set_size(WSize::Physical(PhysicalSize::new(w, h)));
        }
    });
}

/// What Windows says about the windows, once every quarter second.
#[derive(Default)]
struct Env {
    mons: Vec<cp::Monitor>,
    tbs: Vec<cp::Taskbar>,
    front: Option<cp::Front>,
    fg: Option<policy::FrontWin>,
    quns: Option<policy::Quns>,
    at_ms: u64,
}

fn read_env(raw: isize, now: u64) -> Env {
    let fg = platform::front_window(raw);
    let quns = platform::quns();
    let mons = platform::monitors();
    let front = fg.as_ref().map(|f| {
        let (l, t, r, b) = f.rect;
        let rect = Rect { x: l, y: t, w: (r - l).max(0) as u32, h: (b - t).max(0) as u32 };
        cp::Front { hwnd: f.hwnd, rect, monitor: f.monitor, app: f.is_app(), maximized: f.captioned_max || is_maximized(f), fullscreen: f.covers(f.monitor) }
    });
    Env { mons, tbs: platform::taskbars(), front, fg, quns: Some(quns), at_ms: now }
}

/// A window whose bounds are its monitor's work area (maximized, with or without a caption).
fn is_maximized(f: &policy::FrontWin) -> bool {
    let (l, t, r, _) = f.rect;
    let m = f.monitor_rect;
    l <= m.0 + 8 && r >= m.2 - 8 && t <= m.1 + 8
}

/// About 60 times a second while walking, 8-30 times otherwise (slower holding still, ducked out, or in
/// another mode): see companion::idle_period_ms and walk_fps.
pub fn run(app: AppHandle, shared: Shared) {
    let t0 = Instant::now();
    let now_ms = move || t0.elapsed().as_millis() as u64;
    let mut raw: isize = 0;
    let mut env = Env::default();
    let mut meet = (false, 0u64);
    let mut was_on = false;
    let mut on_battery = (false, 0u64);
    loop {
        let now = now_ms();
        let snap = {
            let Ok(a) = shared.try_lock() else {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            };
            (a.settings.mode, a.peek_open, a.still, a.settings.companion.clone(), a.state.clone(), a.talking, a.seen.locked, a.ceremony)
        };
        let (mode, peek_open, still, prefs, state, talking, locked, ceremony) = snap;
        if mode != Mode::Companion {
            if was_on {
                shared.lock().unwrap().comp.reset();
                was_on = false;
            }
            std::thread::sleep(Duration::from_millis(400));
            continue;
        }
        was_on = true;
        if raw == 0 {
            raw = main_window(&app).map(|w| hwnd(&w)).unwrap_or(0);
            if raw == 0 && cfg!(windows) {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
        }
        // Peek open (a click on the bot), or Windows Hello asking: nothing moves.
        if peek_open || ceremony {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        if now.saturating_sub(env.at_ms) >= 250 {
            env = read_env(raw, now);
        }
        if now.saturating_sub(on_battery.1) >= 4000 {
            on_battery = (platform::power().0, now);
        }
        // A meeting: the camera or the microphone in use by another app (every 3 s; a registry read).
        if now.saturating_sub(meet.1) >= 3000 {
            let our_call = talking || state == "listening" || state == "speaking";
            meet = (cp::meeting(&platform::cap_use("webcam"), &platform::cap_use("microphone"), our_call), now);
        }
        let cur = shared.lock().unwrap().comp.perch;
        let bot_monitor = cur.map(|p| p.monitor).unwrap_or_else(|| platform::monitor_of(raw));
        let fs = env.quns.and_then(|q| policy::fullscreen_hold(q, env.fg.as_ref(), bot_monitor));
        let why = cp::duck(fs.as_deref(), meet.0, locked);
        if duck_step(&app, &shared, now, why) {
            std::thread::sleep(Duration::from_millis(cp::idle_period_ms(still, true, false)));
            continue;
        }
        // The first placement: straight there, no walk.
        let Some(cur) = cur else {
            if let Some(p) = target(&env, &prefs, None, platform::monitor_of(raw), false) {
                let (x, y) = cp::window_pos(&p);
                {
                    let mut a = shared.lock().unwrap();
                    a.comp.perch = Some(p);
                    a.comp.at = Some((x, y, p.scale, p.stance));
                    a.comp.follow.arrived(now);
                }
                set_anchor(Some(centre(x, y, p.scale)));
                mlog!("companion: placed on {:?} of monitor {:#x} at {:?} ({}x)", p.surface, p.monitor, (p.ax, p.ay), p.scale);
                let sh = shared.clone();
                on_main(&app, move |app| apply(app, &sh, false));
            }
            std::thread::sleep(Duration::from_millis(120));
            continue;
        };
        let fps = cp::walk_fps(still, on_battery.0);
        // Walking: the next frame.
        if walk_frame(&app, &shared, raw, now) {
            std::thread::sleep(Duration::from_millis(1000 / fps.max(8) as u64));
            continue;
        }
        // Not walking: where it should be now, and whether to set off.
        let dozing = shared.lock().unwrap().comp.dozing;
        if let Some(t) = target(&env, &prefs, Some(&cur), cur.monitor, dozing) {
            let t = cp::keep_place(&cur, t);
            let gone = perch_gone(&cur, &env);
            let go = shared.lock().unwrap().comp.follow.update(now, &cur, t, gone);
            if let Some(dest) = go {
                start_walk(&shared, &cur, dest, &env.mons, fps > 0, now, "a new perch");
                continue;
            }
        }
        // The cursor: step aside, or look up at it; the eyes follow it.
        let mut close = false;
        // (The window's place copied out first: a guard in an `if let` would be held through its body.)
        let at = shared.lock().unwrap().comp.at;
        if let (Some(c), Some((x, y, s, st))) = (platform::cursor(), at) {
            let bot = cp::body(x, y, st, cur.lean, s);
            let look = cp::look_at(c, (x, y), bot, s);
            close = look.is_some();
            let out = shared.lock().unwrap().comp.dodge.tick(now, bot, c, cur.ax, cur.span, s);
            match out {
                // (In a corner against a side taskbar there is nowhere to step to.)
                DodgeOut::Aside(nx) if nx != cur.ax => {
                    let dest = Perch { ax: nx, ..cur };
                    remember_side(&shared, &dest);
                    start_walk(&shared, &cur, dest, &env.mons, fps > 0, now, "stepping aside");
                    continue;
                }
                DodgeOut::Attention => {
                    let first = !std::mem::replace(&mut shared.lock().unwrap().comp.attention, true);
                    if first {
                        emit(&app, "mint://companion", json!({ "kind": "attention" }));
                    }
                }
                DodgeOut::Aside(_) => {}
                DodgeOut::Nothing => {
                    if std::mem::replace(&mut shared.lock().unwrap().comp.attention, false) {
                        emit(&app, "mint://companion", json!({ "kind": "attention-off" }));
                    }
                }
            }
            if !still {
                let send = {
                    let mut a = shared.lock().unwrap();
                    let changed = match (a.comp.last_look, look) {
                        (Some(p), Some(q)) => (p.0 - q.0).abs() + (p.1 - q.1).abs() > 6.0,
                        (None, None) => false,
                        _ => true,
                    };
                    if changed {
                        a.comp.last_look = look;
                    }
                    changed
                };
                if send {
                    emit(&app, "mint://companion-look", match look { Some((lx, ly)) => json!({ "x": lx, "y": ly }), None => json!({ "off": true }) });
                }
            }
        }
        std::thread::sleep(Duration::from_millis(cp::idle_period_ms(still, false, close)));
    }
}

fn centre(x: i32, y: i32, s: f64) -> (i32, i32) {
    let (w, h) = cp::window_size(s);
    (x + w as i32 / 2, y + h as i32 / 2)
}

/// Where it should perch now: on the monitor it lives on (stay, or follow the active one), by the setting.
fn target(env: &Env, prefs: &settings::Companion, cur: Option<&Perch>, current_monitor: isize, dozing: bool) -> Option<Perch> {
    let stay = if prefs.stay_on_monitor { Some(cur.map(|p| p.monitor).unwrap_or(current_monitor)) } else { None };
    let mon = cp::pick_monitor(&env.mons, env.front.as_ref(), platform::cursor(), stay, current_monitor)?;
    let tb = env.tbs.iter().find(|t| t.monitor == mon.id);
    Some(cp::choose(prefs.perch, mon, tb, env.front.as_ref(), prefs.side, dozing))
}

/// Its perch went away: the window it sat on is no longer in front, or moved; its monitor was unplugged.
fn perch_gone(cur: &Perch, env: &Env) -> bool {
    if !env.mons.is_empty() && !env.mons.iter().any(|m| m.id == cur.monitor) {
        return true;
    }
    if cur.surface == Surface::Window {
        return match env.front {
            Some(f) => f.hwnd != cur.on_window || f.rect.y != cur.ay || f.rect.x != cur.ref_x || f.maximized || f.fullscreen,
            None => true,
        };
    }
    false
}

/// Where along the taskbar it now sits, remembered (Settings::companion.side) after it stepped aside there.
fn remember_side(shared: &Shared, p: &Perch) {
    if !matches!(p.surface, Surface::Taskbar(_) | Surface::Floor) || p.span.1 <= p.span.0 {
        return;
    }
    let f = (p.ax - p.span.0) as f64 / (p.span.1 - p.span.0) as f64;
    shared.lock().unwrap().settings.companion.side = (f * 100.0).round() / 100.0;
    save(shared);
}

fn start_walk(shared: &Shared, cur: &Perch, dest: Perch, mons: &[cp::Monitor], animate: bool, now: u64, why: &str) {
    let legs = cp::plan(cur, &dest, mons, animate);
    mlog!("companion: {} -> {:?} on monitor {:#x} ({} legs, {} ms{})", why, dest.surface, dest.monitor, legs.len(), cp::total_ms(&legs), if animate { "" } else { ", holding still: a jump" });
    let mut a = shared.lock().unwrap();
    if legs.is_empty() {
        a.comp.perch = Some(dest);
        a.comp.follow.arrived(now);
        return;
    }
    a.comp.legs = legs;
    a.comp.dest = Some(dest);
    a.comp.started_ms = now;
    a.comp.leg_shown = usize::MAX;
    a.comp.attention = false;
}

/// One frame of a walk under way: move the window, tell the page at each new leg, cross to another monitor,
/// arrive. Returns whether a walk is (still) under way.
fn walk_frame(app: &AppHandle, shared: &Shared, raw: isize, now: u64) -> bool {
    let (legs, started, shown, dest) = {
        let a = shared.lock().unwrap();
        if a.comp.legs.is_empty() {
            return false;
        }
        (a.comp.legs.clone(), a.comp.started_ms, a.comp.leg_shown, a.comp.dest)
    };
    let pose = cp::sample(&legs, now.saturating_sub(started));
    // Each leg that started since the last frame: the page is told (a crossing places the window on the new monitor).
    let first_new = if shown == usize::MAX { 0 } else { shown + 1 };
    for i in first_new..=pose.leg.min(legs.len().saturating_sub(1)) {
        let l = legs[i];
        if i > pose.leg {
            break;
        }
        if l.kind == LegKind::Cross || l.kind == LegKind::Jump {
            {
                let mut a = shared.lock().unwrap();
                a.comp.at = Some((l.to.0, l.to.1, l.scale, l.stance));
            }
            set_anchor(Some(centre(l.to.0, l.to.1, l.scale)));
            if l.kind == LegKind::Cross {
                place(app, l.to.0, l.to.1, l.scale);
            } else {
                platform::move_window(raw, l.to.0, l.to.1);
            }
        }
        emit(app, "mint://companion", leg_event(&l, dest.as_ref()));
        shared.lock().unwrap().comp.leg_shown = i;
    }
    if pose.done {
        let mut a = shared.lock().unwrap();
        let end = legs.last().copied();
        if let Some(l) = end {
            a.comp.at = Some((l.to.0, l.to.1, l.scale, l.stance));
            set_anchor(Some(centre(l.to.0, l.to.1, l.scale)));
            if l.kind != LegKind::Cross {
                platform::move_window(raw, l.to.0, l.to.1);
            }
        }
        a.comp.perch = dest;
        a.comp.legs.clear();
        a.comp.dest = None;
        a.comp.follow.arrived(now);
        let v = view(&a).map(|v| serde_json::to_value(v).unwrap_or_default()).unwrap_or_default();
        drop(a);
        emit(app, "mint://companion", json!({ "kind": "arrive", "view": v }));
        return false;
    }
    // Between: the window follows the path (the Out / In legs keep it still while the page walks the bot).
    let l = legs[pose.leg];
    if matches!(l.kind, LegKind::Walk | LegKind::Hop) {
        platform::move_window(raw, pose.x, pose.y);
        let mut a = shared.lock().unwrap();
        a.comp.at = Some((pose.x, pose.y, l.scale, if pose.k < 0.5 && l.kind == LegKind::Hop { a.comp.at.map(|t| t.3).unwrap_or(l.stance) } else { l.stance }));
        set_anchor(Some(centre(pose.x, pose.y, l.scale)));
    }
    true
}

/// Ducking out and popping up again. Returns whether it is ducked out (or going): then nothing else moves.
fn duck_step(app: &AppHandle, shared: &Shared, now: u64, why: Option<String>) -> bool {
    let (ducked, duck_at) = {
        let a = shared.lock().unwrap();
        (a.comp.ducked.is_some(), a.comp.duck_at)
    };
    match (why, ducked, duck_at) {
        // Something came up: the page plays the duck, the window hides a moment later.
        (Some(w), false, None) => {
            mlog!("companion: ducks out: {}", w);
            {
                let mut a = shared.lock().unwrap();
                a.comp.duck_at = Some(now + 450);
                a.comp.duck_why = Some(w);
                a.comp.legs.clear();
            }
            emit(app, "mint://companion", json!({ "kind": "duck" }));
            true
        }
        (Some(_), false, Some(t)) => {
            if now >= t {
                {
                    let mut a = shared.lock().unwrap();
                    a.comp.ducked = a.comp.duck_why.take().or(Some("ducked".into()));
                    a.comp.duck_at = None;
                }
                let sh = shared.clone();
                on_main(app, move |app| apply(app, &sh, false));
            }
            true
        }
        (Some(_), true, _) => true,
        // Over (or it went away before the window hid): back up.
        (None, true, _) | (None, false, Some(_)) => {
            mlog!("companion: pops up again");
            {
                let mut a = shared.lock().unwrap();
                a.comp.ducked = None;
                a.comp.duck_at = None;
                a.comp.duck_why = None;
                // Where it was may be gone: it looks again from where it stands.
                a.comp.follow.arrived(0);
            }
            let sh = shared.clone();
            on_main(app, move |app| apply(app, &sh, false));
            emit(app, "mint://companion", json!({ "kind": "pop" }));
            false
        }
        (None, false, None) => false,
    }
}
