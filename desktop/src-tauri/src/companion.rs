//! Companion mode (design: mockups/desk-companion/DESIGN.md, approved 2026-10-20): the bot steps out of
//! its box and lives on the desktop, like EMO on a real desk. It perches on the taskbar or on the top edge
//! of the window in front, walks or hops over when you switch windows or monitors, steps aside when the
//! cursor comes near (unless you rest it on the bot), and ducks out of full-screen apps and meetings.
//!
//! Pure: monitors, taskbars, the window in front and the cursor in; where the bot perches, the path it
//! takes, whether it steps aside or ducks out. The app (lib.rs, companion_loop) reads Windows (platform.rs:
//! window rectangles, the taskbar's position and auto-hide state, monitor DPI, the camera / microphone
//! "in use" flags -- never what is in a window) and moves one small window with the bot in it.
//!
//! Coordinates are physical pixels (the monitors'), as Windows places windows; the sizes below are logical
//! px and scale with each monitor's DPI. The page (dashboard/public/mint-desktop-companion.js) draws the
//! bot in the window with the same numbers (dashboard/tools/test-desktop-companion.cjs checks both files).

use crate::layout::Rect;
use serde::{Deserialize, Serialize};

/// The companion window: the bot in the middle, room either side for the session bots that gather by it.
pub const WIN_W: f64 = 264.0;
pub const WIN_H: f64 = 140.0;
/// Standing: the feet are this far above the window's bottom edge (room for the contact shadow).
pub const FOOT: f64 = 6.0;
/// The bot's hit circle (its head and backplate): this radius, its centre this far above the feet
/// (standing) or below the window's top (hanging under a top taskbar).
pub const BODY_R: f64 = 38.0;
pub const BODY_CY: f64 = 40.0;
pub const HANG_CY: f64 = 46.0;
/// Leaning on a side taskbar: the bot sits this far from its window's middle, toward the taskbar (the
/// window itself must stay on the monitor, so the bot moves inside it).
pub const LEAN_DX: f64 = 70.0;
/// The ring round the body where an approaching cursor makes it step aside, and one step.
pub const NEAR: f64 = 44.0;
pub const STEP: f64 = 128.0;
/// Walking speed (logical px a second); a hop's height above the higher end.
pub const WALK: f64 = 300.0;
pub const HOP_UP: f64 = 36.0;
/// Above an auto-hidden taskbar's edge: its reveal strip at the screen's edge stays free for the mouse.
pub const AUTOHIDE_GAP: f64 = 4.0;
/// A window it may sit on: at least this wide (logical px).
pub const MIN_WIN_W: f64 = 260.0;
/// A new target must hold still this long before the bot sets off (a window being dragged, a quick Alt+Tab).
pub const SETTLE_MS: u64 = 600;
/// Once arrived it stays at least this long, unless its perch went away (the window closed, minimized, moved).
pub const DWELL_MS: u64 = 2500;
/// Stepping into / out of a monitor's edge (the page plays it; the window waits).
pub const EDGE_MS: u32 = 360;
/// Where along the taskbar it sits by default (0 = left end, 1 = right end).
pub const DEFAULT_SIDE: f64 = 0.8;

/// Where it may perch (Settings ▸ Companion).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerchPref {
    Taskbar,
    Windows,
    Both,
}

impl PerchPref {
    pub fn as_str(&self) -> &'static str {
        match self {
            PerchPref::Taskbar => "taskbar",
            PerchPref::Windows => "windows",
            PerchPref::Both => "both",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

/// A monitor: its whole rectangle, its work area (without the taskbar) and its scale (DPI / 96).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
    pub id: isize,
    pub rect: Rect,
    pub work: Rect,
    pub scale: f64,
}

/// A taskbar as it is now: which monitor and edge, where it is (an auto-hidden one slides almost off the
/// screen: then only a strip of it is on its monitor), and whether it auto-hides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Taskbar {
    pub monitor: isize,
    pub edge: Edge,
    pub rect: Rect,
    pub autohide: bool,
}

/// The window in front, as far as perching goes: its visible bounds (DWM's extended frame bounds), its
/// monitor, and what kind of window it is. Nothing about what is in it.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Front {
    pub hwnd: isize,
    pub rect: Rect,
    pub monitor: isize,
    /// Someone else's app window (not MINT AI, not the shell, not a tool window).
    pub app: bool,
    /// Maximized (its top is the screen's top: no room above it).
    pub maximized: bool,
    /// Full screen on its monitor (policy::FrontWin::covers).
    pub fullscreen: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stance {
    /// On its feet on a shelf below it: a bottom taskbar's top, a window's top edge, the floor of the work area.
    Stand,
    /// Hanging under a top taskbar.
    Hang,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase", tag = "on", content = "edge")]
pub enum Surface {
    Taskbar(Edge),
    Window,
    /// The bottom of the work area (a monitor with no taskbar of its own, or one with a side taskbar).
    Floor,
}

/// Where the bot sits: the anchor (standing: the feet's centre on the shelf; hanging: the head's top centre
/// under the shelf), how, on what, on which monitor, and the stretch of the shelf it may move along.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Perch {
    pub ax: i32,
    pub ay: i32,
    pub stance: Stance,
    /// Leaning on a side taskbar: -1 its left side against a left taskbar, 1 a right one, 0 not leaning.
    pub lean: i8,
    pub surface: Surface,
    pub monitor: isize,
    pub scale: f64,
    /// The x range the anchor may take on this shelf.
    pub span: (i32, i32),
    /// The window it sits on (0: none), and that window's left edge when it perched (it follows a moved window).
    pub on_window: isize,
    pub ref_x: i32,
}

fn sc(s: f64) -> f64 {
    if s.is_finite() && s > 0.25 && s < 8.0 {
        s
    } else {
        1.0
    }
}
fn lp(v: f64, s: f64) -> i32 {
    (v * sc(s)).round() as i32
}
fn right(r: &Rect) -> i32 {
    r.x + r.w as i32
}
fn bottom(r: &Rect) -> i32 {
    r.y + r.h as i32
}
fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    if hi < lo {
        (lo + hi) / 2
    } else {
        v.max(lo).min(hi)
    }
}

/// The window's size on a monitor of this scale (physical px).
pub fn window_size(scale: f64) -> (u32, u32) {
    (lp(WIN_W, scale) as u32, lp(WIN_H, scale) as u32)
}

/// The window's top-left for a perch.
pub fn window_pos(p: &Perch) -> (i32, i32) {
    let (w, h) = window_size(p.scale);
    let x = p.ax - w as i32 / 2;
    let y = match p.stance {
        Stance::Stand => p.ay - (h as i32 - lp(FOOT, p.scale)),
        Stance::Hang => p.ay,
    };
    (x, y)
}

pub fn window_rect(p: &Perch) -> Rect {
    let (x, y) = window_pos(p);
    let (w, h) = window_size(p.scale);
    Rect { x, y, w, h }
}

/// The bot's hit circle (centre, radius) for a window at (x, y): standing, above the feet; hanging, below the
/// top; leaning on a side taskbar, LEAN_DX toward it.
pub fn body(win_x: i32, win_y: i32, stance: Stance, lean: i8, scale: f64) -> (i32, i32, i32) {
    let (w, h) = window_size(scale);
    let cx = win_x + w as i32 / 2 + lean.signum() as i32 * lp(LEAN_DX, scale);
    let cy = match stance {
        Stance::Stand => win_y + h as i32 - lp(FOOT, scale) - lp(BODY_CY, scale),
        Stance::Hang => win_y + lp(HANG_CY, scale),
    };
    (cx, cy, lp(BODY_R, scale))
}

/// The edge a taskbar sits on, from its rectangle and its monitor's (the secondary taskbars do not say).
pub fn edge_of(tb: Rect, mon: Rect) -> Edge {
    let horizontal = tb.w >= tb.h;
    let (cx, cy) = tb.centre();
    let (mx, my) = mon.centre();
    if horizontal {
        if cy < my {
            Edge::Top
        } else {
            Edge::Bottom
        }
    } else if cx < mx {
        Edge::Left
    } else {
        Edge::Right
    }
}

/// How much of the taskbar is on its monitor now, across its edge (an auto-hidden one: a strip of 2 px or so).
pub fn visible_thickness(tb: &Taskbar, mon: &Rect) -> i32 {
    let (a0, a1, b0, b1) = match tb.edge {
        Edge::Bottom | Edge::Top => (tb.rect.y, bottom(&tb.rect), mon.y, bottom(mon)),
        Edge::Left | Edge::Right => (tb.rect.x, right(&tb.rect), mon.x, right(mon)),
    };
    (a1.min(b1) - a0.max(b0)).max(0)
}

/// The x range the anchor may take on a monitor: the whole window stays on it (a window across two monitors
/// would take the other one's DPI halfway through a walk).
fn monitor_span(mon: &Monitor) -> (i32, i32) {
    let (w, _) = window_size(mon.scale);
    let half = (w as i32 + 1) / 2;
    (mon.rect.x + half, right(&mon.rect) - half)
}

fn lerp_span(span: (i32, i32), side: f64) -> i32 {
    let f = if side.is_finite() { side.clamp(0.0, 1.0) } else { DEFAULT_SIDE };
    clampi((span.0 as f64 + (span.1 - span.0) as f64 * f).round() as i32, span.0, span.1)
}

/// On the taskbar of this monitor (or its floor when it has none): a bottom taskbar's top edge, under a top one,
/// on the floor against a side one. An auto-hidden taskbar: on the screen's edge, clear of its reveal strip --
/// and when the taskbar slides in, on top of it (the taskbar's current rectangle says which).
pub fn taskbar_perch(mon: &Monitor, tb: Option<&Taskbar>, side: f64) -> Perch {
    let s = sc(mon.scale);
    let span = monitor_span(mon);
    let mut p = Perch { ax: lerp_span(span, side), ay: bottom(&mon.work), stance: Stance::Stand, lean: 0, surface: Surface::Floor, monitor: mon.id, scale: s, span, on_window: 0, ref_x: 0 };
    let Some(tb) = tb.filter(|t| t.monitor == mon.id) else { return p };
    let thick = visible_thickness(tb, &mon.rect);
    let off = if tb.autohide { thick.max(lp(AUTOHIDE_GAP, s)) } else { thick };
    match tb.edge {
        Edge::Bottom => {
            p.ay = bottom(&mon.rect) - off;
            p.surface = Surface::Taskbar(Edge::Bottom);
        }
        Edge::Top => {
            p.ay = mon.rect.y + off;
            p.stance = Stance::Hang;
            p.surface = Surface::Taskbar(Edge::Top);
        }
        Edge::Left | Edge::Right => {
            // On the floor in the corner, its side against the taskbar (the bot sits LEAN_DX off its window's
            // middle, toward the taskbar). It stays in that corner: there is no shelf to step along.
            let left = tb.edge == Edge::Left;
            let reach = lp(BODY_R + LEAN_DX, s) + 2;
            let ax = if left { mon.rect.x + off + reach } else { right(&mon.rect) - off - reach };
            p.ax = clampi(ax, span.0, span.1);
            p.span = (p.ax, p.ax);
            p.ay = bottom(&mon.rect);
            p.lean = if left { -1 } else { 1 };
            p.surface = Surface::Taskbar(tb.edge);
        }
    }
    p
}

/// On the top edge of the window in front, if it can hold the bot: an app window on this monitor, not
/// maximized or full screen, wide enough, with room above it for the bot inside the work area. It sits on
/// the left part of the edge (away from the caption buttons) and may move along it.
pub fn window_perch(mon: &Monitor, f: &Front) -> Option<Perch> {
    let s = sc(mon.scale);
    if !f.app || f.maximized || f.fullscreen || f.monitor != mon.id || f.hwnd == 0 {
        return None;
    }
    if (f.rect.w as f64) < MIN_WIN_W * s {
        return None;
    }
    let (_, wh) = window_size(s);
    let rise = wh as i32 - lp(FOOT, s);
    if f.rect.y - mon.work.y < rise || f.rect.y >= bottom(&mon.work) - lp(BODY_R, s) {
        return None;
    }
    let ms = monitor_span(mon);
    let inset = lp(BODY_R + 8.0, s);
    let lo = (f.rect.x.max(mon.rect.x) + inset).max(ms.0);
    let hi = (right(&f.rect).min(right(&mon.rect)) - inset).min(ms.1);
    if hi < lo {
        return None;
    }
    let ax = clampi(f.rect.x + (f.rect.w as f64 * 0.25).round() as i32, lo, hi);
    Some(Perch { ax, ay: f.rect.y, stance: Stance::Stand, lean: 0, surface: Surface::Window, monitor: mon.id, scale: s, span: (lo, hi), on_window: f.hwnd, ref_x: f.rect.x })
}

/// Which perch, by the setting. Windows (or Both) and a window that can hold it: its top edge; else the
/// taskbar. `taskbar_only`: while it dozes it goes back to the taskbar to sleep.
pub fn choose(pref: PerchPref, mon: &Monitor, tb: Option<&Taskbar>, front: Option<&Front>, side: f64, taskbar_only: bool) -> Perch {
    if pref != PerchPref::Taskbar && !taskbar_only {
        if let Some(p) = front.and_then(|f| window_perch(mon, f)) {
            return p;
        }
    }
    taskbar_perch(mon, tb, side)
}

/// The monitor it lives on: the one it is told to stay on (if still there); else the active one -- the window
/// in front's, or the cursor's when the desktop itself is in front; else where it is; else the first. A
/// full-screen window is not followed: the bot stays where it is (and ducks out only if that is its monitor).
pub fn pick_monitor<'a>(mons: &'a [Monitor], front: Option<&Front>, cursor: Option<(i32, i32)>, stay: Option<isize>, current: isize) -> Option<&'a Monitor> {
    let by_id = |id: isize| mons.iter().find(|m| m.id == id && id != 0);
    if let Some(m) = stay.and_then(by_id) {
        return Some(m);
    }
    if front.map(|f| f.fullscreen).unwrap_or(false) {
        return by_id(current).or_else(|| mons.first());
    }
    if let Some(m) = front.filter(|f| f.app).and_then(|f| by_id(f.monitor)) {
        return Some(m);
    }
    if front.map(|f| !f.app).unwrap_or(true) {
        if let Some((x, y)) = cursor {
            if let Some(m) = mons.iter().find(|m| m.rect.contains(x, y)) {
                return Some(m);
            }
        }
    }
    by_id(current).or_else(|| mons.first())
}

/// Same place to stand on: the same kind of shelf, window and monitor, at the same height.
pub fn same_shelf(a: &Perch, b: &Perch) -> bool {
    a.surface == b.surface && a.on_window == b.on_window && a.monitor == b.monitor && a.stance == b.stance && (a.ay - b.ay).abs() <= lp(6.0, a.scale)
}

/// The new target, keeping its place along the shelf: on the same shelf it stays where it stood (it may have
/// stepped aside); on a window that moved it moves with it.
pub fn keep_place(cur: &Perch, target: Perch) -> Perch {
    let same_window = cur.surface == Surface::Window && target.surface == Surface::Window && cur.on_window == target.on_window && cur.monitor == target.monitor;
    if same_shelf(cur, &target) || same_window {
        let x = cur.ax - cur.ref_x + target.ref_x;
        return Perch { ax: clampi(x, target.span.0, target.span.1), ..target };
    }
    target
}

/// Whether to set off: a new target must hold still SETTLE_MS (a window being dragged, a quick Alt+Tab
/// through windows), and the bot stays DWELL_MS where it arrived -- unless its perch is gone.
#[derive(Clone, Debug, Default)]
pub struct Follow {
    pending: Option<(Perch, u64)>,
    pub arrived_at: u64,
}

fn near_same(a: &Perch, b: &Perch) -> bool {
    let tol = lp(6.0, a.scale);
    same_shelf(a, b) && (a.ax - b.ax).abs() <= tol
}

impl Follow {
    pub fn arrived(&mut self, now: u64) {
        self.arrived_at = now;
        self.pending = None;
    }
    /// `cur`: where it is; `target`: where it would go now (keep_place applied); `gone`: its current perch no
    /// longer exists (its window closed, minimized or moved away; the taskbar moved). Some(perch) to go now.
    pub fn update(&mut self, now: u64, cur: &Perch, target: Perch, gone: bool) -> Option<Perch> {
        if near_same(cur, &target) {
            self.pending = None;
            return None;
        }
        let since = match self.pending {
            Some((p, t)) if near_same(&p, &target) => t,
            _ => {
                self.pending = Some((target, now));
                now
            }
        };
        let settled = now.saturating_sub(since) >= SETTLE_MS;
        let dwelt = gone || now.saturating_sub(self.arrived_at) >= DWELL_MS;
        if settled && dwelt {
            self.pending = None;
            Some(target)
        } else {
            None
        }
    }
}

/* ------------------------------------------------------------------ the path */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LegKind {
    /// Along a shelf: the window moves in a straight line, the page walks the bot's legs.
    Walk,
    /// To another shelf (up, down, or another stance): an arc.
    Hop,
    /// Off this monitor's edge: the page walks the bot out of the window; the window waits.
    Out,
    /// The window jumps to the next monitor (at its DPI, from the main thread): no time of its own.
    Cross,
    /// Onto the new monitor from its edge: the page walks the bot in; the window waits.
    In,
    /// Straight there, no animation (holding still: battery saver, energy saver, reduced motion).
    Jump,
}

/// One leg of a path: the window's top-left from -> to (physical px), how long, a hop's lift (physical px),
/// the stance, monitor and scale at its end, and the direction the bot faces (-1 left, 1 right).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Leg {
    pub kind: LegKind,
    pub from: (i32, i32),
    pub to: (i32, i32),
    pub ms: u32,
    pub lift: i32,
    pub stance: Stance,
    pub monitor: isize,
    pub scale: f64,
    pub dir: i8,
}

fn dir_of(dx: i32) -> i8 {
    if dx < 0 {
        -1
    } else {
        1
    }
}

fn walk_leg(from: (i32, i32), to: (i32, i32), stance: Stance, mon: isize, s: f64) -> Option<Leg> {
    let d = (to.0 - from.0).abs() as f64 / sc(s);
    if d < 3.0 {
        return None;
    }
    let ms = ((d / WALK) * 1000.0).round().max(180.0) as u32;
    Some(Leg { kind: LegKind::Walk, from, to, ms, lift: 0, stance, monitor: mon, scale: s, dir: dir_of(to.0 - from.0) })
}

fn hop_leg(from: (i32, i32), to: (i32, i32), stance: Stance, mon: isize, s: f64) -> Leg {
    let (dx, dy) = ((to.0 - from.0) as f64 / sc(s), (to.1 - from.1) as f64 / sc(s));
    let dist = (dx * dx + dy * dy).sqrt();
    let ms = (420.0 + dist * 0.35).clamp(420.0, 900.0).round() as u32;
    Leg { kind: LegKind::Hop, from, to, ms, lift: lp(HOP_UP, s), stance, monitor: mon, scale: s, dir: dir_of(to.0 - from.0) }
}

/// The path from where it is to a new perch. `mons`: the monitors (for a crossing); `animate`: false when
/// holding still -- then one Jump (and a Cross when the monitor changes).
pub fn plan(cur: &Perch, to: &Perch, mons: &[Monitor], animate: bool) -> Vec<Leg> {
    let a = window_pos(cur);
    let b = window_pos(to);
    let mut legs = Vec::new();
    if cur.monitor != to.monitor {
        let from_m = mons.iter().find(|m| m.id == cur.monitor);
        let to_m = mons.iter().find(|m| m.id == to.monitor);
        let dir: i8 = match (from_m, to_m) {
            (Some(f), Some(t)) => dir_of(t.rect.centre().0 - f.rect.centre().0),
            _ => dir_of(b.0 - a.0),
        };
        if !animate {
            legs.push(Leg { kind: LegKind::Cross, from: a, to: b, ms: 0, lift: 0, stance: to.stance, monitor: to.monitor, scale: to.scale, dir });
            return legs;
        }
        // Walk to this monitor's edge on its shelf, step out, cross, step in at the facing edge, walk on.
        let edge_x = if dir > 0 { cur.span.1 } else { cur.span.0 };
        let out_at = (edge_x - window_size(cur.scale).0 as i32 / 2, a.1);
        if let Some(w) = walk_leg(a, out_at, cur.stance, cur.monitor, cur.scale) {
            legs.push(w);
        }
        let start = if legs.is_empty() { a } else { out_at };
        legs.push(Leg { kind: LegKind::Out, from: start, to: start, ms: EDGE_MS, lift: 0, stance: cur.stance, monitor: cur.monitor, scale: cur.scale, dir });
        let entry_ax = if dir > 0 { to.span.0 } else { to.span.1 };
        let entry = window_pos(&Perch { ax: entry_ax, ..*to });
        legs.push(Leg { kind: LegKind::Cross, from: start, to: entry, ms: 0, lift: 0, stance: to.stance, monitor: to.monitor, scale: to.scale, dir });
        legs.push(Leg { kind: LegKind::In, from: entry, to: entry, ms: EDGE_MS, lift: 0, stance: to.stance, monitor: to.monitor, scale: to.scale, dir });
        if let Some(w) = walk_leg(entry, b, to.stance, to.monitor, to.scale) {
            legs.push(w);
        }
        return legs;
    }
    if !animate {
        if a != b {
            legs.push(Leg { kind: LegKind::Jump, from: a, to: b, ms: 0, lift: 0, stance: to.stance, monitor: to.monitor, scale: to.scale, dir: dir_of(b.0 - a.0) });
        }
        return legs;
    }
    if same_shelf(cur, to) {
        legs.extend(walk_leg(a, b, to.stance, to.monitor, to.scale));
        return legs;
    }
    // Another shelf: first along this one toward it (when that is more than a body's width), then a hop.
    let wx_anchor = clampi(to.ax, cur.span.0, cur.span.1);
    let mid = window_pos(&Perch { ax: wx_anchor, ..*cur });
    let mut from = a;
    if (mid.0 - a.0).abs() as f64 > 2.0 * BODY_R * sc(cur.scale) {
        if let Some(w) = walk_leg(a, mid, cur.stance, cur.monitor, cur.scale) {
            legs.push(w);
            from = mid;
        }
    }
    legs.push(hop_leg(from, b, to.stance, to.monitor, to.scale));
    legs
}

/// Where the window is at t ms into the path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub x: i32,
    pub y: i32,
    /// Which leg (legs.len() when done) and how far through it (0..1).
    pub leg: usize,
    pub k: f64,
    pub done: bool,
}

fn ease(k: f64) -> f64 {
    k * k * (3.0 - 2.0 * k)
}

pub fn total_ms(legs: &[Leg]) -> u64 {
    legs.iter().map(|l| l.ms as u64).sum()
}

pub fn sample(legs: &[Leg], t_ms: u64) -> Pose {
    let mut t0 = 0u64;
    for (i, l) in legs.iter().enumerate() {
        let d = l.ms as u64;
        if t_ms < t0 + d {
            let k = (t_ms - t0) as f64 / d.max(1) as f64;
            let (x, y) = at(l, k);
            return Pose { x, y, leg: i, k, done: false };
        }
        t0 += d;
    }
    let end = legs.last().map(|l| l.to).unwrap_or((0, 0));
    Pose { x: end.0, y: end.1, leg: legs.len(), k: 1.0, done: true }
}

/// A point on a leg, k in 0..1.
pub fn at(l: &Leg, k: f64) -> (i32, i32) {
    let k = k.clamp(0.0, 1.0);
    let (x0, y0, x1, y1) = (l.from.0 as f64, l.from.1 as f64, l.to.0 as f64, l.to.1 as f64);
    match l.kind {
        LegKind::Walk => {
            // A short ease at each end; mostly an even pace.
            let e = if k < 0.12 { ease(k / 0.12) * 0.06 } else if k > 0.88 { 0.94 + ease((k - 0.88) / 0.12) * 0.06 } else { 0.06 + (k - 0.12) / 0.76 * 0.88 };
            ((x0 + (x1 - x0) * e).round() as i32, y0.round() as i32)
        }
        LegKind::Hop => {
            // A quadratic arc: its apex `lift` above the higher end when both ends are level.
            let e = ease(k);
            let cy = y0.min(y1) - 2.0 * l.lift as f64;
            let y = (1.0 - k) * (1.0 - k) * y0 + 2.0 * (1.0 - k) * k * cy + k * k * y1;
            ((x0 + (x1 - x0) * e).round() as i32, y.round() as i32)
        }
        LegKind::Out | LegKind::In => (l.from.0, l.from.1),
        LegKind::Cross | LegKind::Jump => (l.to.0, l.to.1),
    }
}

/* ------------------------------------------------------------- never in the way */

/// Stepping aside: the cursor coming near the bot makes it step aside -- unless it comes to rest on the bot
/// (you mean it: hover, then click to open the Command Center). One step, then a short pause.
#[derive(Clone, Debug, Default)]
pub struct Dodge {
    near_since: Option<u64>,
    on_since: Option<u64>,
    last: Option<(i32, i32, u64)>,
    cool_until: u64,
    /// The cursor rested on the bot: no stepping aside while it stays (up to ATTEND_MS), or until it leaves the ring.
    pub deliberate: bool,
    attend_since: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DodgeOut {
    Nothing,
    /// Resting on the bot: it looks at you and stays.
    Attention,
    /// Step aside to this anchor x.
    Aside(i32),
}

/// How long the cursor must rest on the bot to count as "on purpose", and how long it may linger near it
/// (or pass over it) before the bot steps aside; how slow is "resting" (logical px a second).
pub const DWELL_ON_MS: u64 = 250;
pub const GRACE_MS: u64 = 180;
pub const REST_SPEED: f64 = 90.0;
pub const COOL_MS: u64 = 900;
/// Resting on it but not clicking for this long: you were aiming at something under it after all -- it steps aside.
pub const ATTEND_MS: u64 = 1600;

/// Where one step aside goes: away from the cursor, along the shelf; at the shelf's end, past the cursor
/// to the other side instead.
pub fn aside_x(x: i32, cursor_x: i32, span: (i32, i32), step: i32) -> i32 {
    let away = if cursor_x <= x { 1 } else { -1 };
    let want = x + away * step;
    let got = clampi(want, span.0, span.1);
    if (got - x).abs() * 2 >= step {
        return got;
    }
    // Blocked: hop past the cursor to its other side.
    clampi(cursor_x - away * step, span.0, span.1)
}

impl Dodge {
    /// One look at the cursor (about 30 times a second). `bot`: the hit circle (cx, cy, r, physical);
    /// `ax`/`span`: where the anchor is and may go; `scale`: the monitor's.
    pub fn tick(&mut self, now: u64, bot: (i32, i32, i32), cursor: (i32, i32), ax: i32, span: (i32, i32), scale: f64) -> DodgeOut {
        let s = sc(scale);
        let (dx, dy) = ((cursor.0 - bot.0) as f64, (cursor.1 - bot.1) as f64);
        let d = (dx * dx + dy * dy).sqrt();
        let speed = match self.last {
            Some((x, y, t)) if now > t => {
                let (mx, my) = ((cursor.0 - x) as f64, (cursor.1 - y) as f64);
                (mx * mx + my * my).sqrt() / s / ((now - t) as f64 / 1000.0)
            }
            _ => 0.0,
        };
        self.last = Some((cursor.0, cursor.1, now));
        let on = d <= bot.2 as f64;
        let near = d <= bot.2 as f64 + NEAR * s;
        if !near {
            self.near_since = None;
            self.on_since = None;
            self.deliberate = false;
            return DodgeOut::Nothing;
        }
        if on && speed <= REST_SPEED {
            let since = *self.on_since.get_or_insert(now);
            if now - since >= DWELL_ON_MS && !self.deliberate {
                self.deliberate = true;
                self.attend_since = now;
            }
        } else if !on {
            self.on_since = None;
        }
        if self.deliberate {
            if now.saturating_sub(self.attend_since) < ATTEND_MS {
                return DodgeOut::Attention;
            }
            // No click: it was in the way after all.
            self.deliberate = false;
            self.on_since = None;
            self.near_since = None;
            self.cool_until = now + COOL_MS;
            return DodgeOut::Aside(aside_x(ax, cursor.0, span, lp(STEP, s)));
        }
        if on && self.on_since.is_some() {
            // Slowing down on it: give it the moment to count as on purpose.
            return DodgeOut::Nothing;
        }
        let since = *self.near_since.get_or_insert(now);
        if now < self.cool_until || now - since < GRACE_MS {
            return DodgeOut::Nothing;
        }
        self.near_since = None;
        self.cool_until = now + COOL_MS;
        DodgeOut::Aside(aside_x(ax, cursor.0, span, lp(STEP, s)))
    }
}

/* ------------------------------------------------------------------ ducking out */

/// One app's use of the camera or microphone, as Windows' privacy settings record it (CapabilityAccessManager
/// ConsentStore: LastUsedTimeStart / LastUsedTimeStop; a stop of 0 after a start means in use now).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapUse {
    pub app: String,
    pub start: u64,
    pub stop: u64,
}

/// Is any app other than MINT AI using it now? (`ours`: lower-case parts of MINT AI's own names.)
pub fn in_use(list: &[CapUse], ours: &[&str]) -> bool {
    list.iter().any(|u| {
        let a = u.app.to_ascii_lowercase();
        u.start > 0 && u.stop == 0 && !ours.iter().any(|o| a.contains(o))
    })
}

/// MINT AI's own entries in those lists: the app and its WebView2 (its voice uses the microphone).
pub const OURS: [&str; 2] = ["mint-desktop", "msedgewebview2"];

/// A meeting (or a recording): a camera in use by another app; or another app's microphone while MINT AI
/// has no call of its own (its own call would look the same).
pub fn meeting(cam: &[CapUse], mic: &[CapUse], our_call: bool) -> bool {
    in_use(cam, &OURS) || (!our_call && in_use(mic, &OURS))
}

/// Ducks out (hides until it is over): something full screen on its monitor (policy::fullscreen_hold), a
/// meeting, the screen locked.
pub fn duck(fullscreen: Option<&str>, meeting: bool, locked: bool) -> Option<String> {
    if locked {
        return Some("the screen is locked".into());
    }
    if let Some(w) = fullscreen {
        return Some(w.to_string());
    }
    if meeting {
        return Some("a camera or microphone is in use (a meeting)".into());
    }
    None
}

/* ------------------------------------------------------------------ pace */

/// Frames a second while it walks: none when holding still (it jumps), 30 on battery, else 60.
pub fn walk_fps(still: bool, on_battery: bool) -> u32 {
    if still {
        0
    } else if on_battery {
        30
    } else {
        60
    }
}

/// How often the loop looks at the cursor and the windows when it is not walking (ms): 33 near the cursor
/// (stepping aside needs it), 120 otherwise, 500 when holding still, 1000 ducked out or hidden.
pub fn idle_period_ms(still: bool, ducked: bool, cursor_close: bool) -> u64 {
    if ducked {
        1000
    } else if still {
        500
    } else if cursor_close {
        33
    } else {
        120
    }
}

/// The cursor within this many logical px of the bot: look at it at the fast rate, and let the eyes follow it.
pub const LOOK_RANGE: f64 = 900.0;

/// The cursor relative to the window, in the page's CSS px, when it is within LOOK_RANGE of the bot (for its
/// eyes to follow it); None beyond.
pub fn look_at(cursor: (i32, i32), win: (i32, i32), bot: (i32, i32, i32), scale: f64) -> Option<(f64, f64)> {
    let s = sc(scale);
    let (dx, dy) = ((cursor.0 - bot.0) as f64, (cursor.1 - bot.1) as f64);
    if (dx * dx + dy * dy).sqrt() > LOOK_RANGE * s {
        return None;
    }
    Some((((cursor.0 - win.0) as f64 / s * 10.0).round() / 10.0, ((cursor.1 - win.1) as f64 / s * 10.0).round() / 10.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The user's desk: the laptop (1920 x 1200 at 150 %, primary, taskbar at the bottom, 48 logical px = 72
    // physical) and the Samsung LF27T35 to its right (1920 x 1080 at 100 %, its own taskbar).
    const LAPTOP: Monitor = Monitor { id: 1, rect: Rect { x: 0, y: 0, w: 1920, h: 1200 }, work: Rect { x: 0, y: 0, w: 1920, h: 1128 }, scale: 1.5 };
    const SAMSUNG: Monitor = Monitor { id: 2, rect: Rect { x: 1920, y: 0, w: 1920, h: 1080 }, work: Rect { x: 1920, y: 0, w: 1920, h: 1032 }, scale: 1.0 };
    const TB1: Taskbar = Taskbar { monitor: 1, edge: Edge::Bottom, rect: Rect { x: 0, y: 1128, w: 1920, h: 72 }, autohide: false };
    const TB2: Taskbar = Taskbar { monitor: 2, edge: Edge::Bottom, rect: Rect { x: 1920, y: 1032, w: 1920, h: 48 }, autohide: false };

    fn app(hwnd: isize, monitor: isize, x: i32, y: i32, w: u32, h: u32) -> Front {
        Front { hwnd, rect: Rect { x, y, w, h }, monitor, app: true, maximized: false, fullscreen: false }
    }

    #[test]
    fn the_window_is_small_and_scales_per_monitor() {
        assert_eq!(window_size(1.0), (264, 140));
        assert_eq!(window_size(1.5), (396, 210));
        assert_eq!(window_size(f64::NAN), (264, 140), "a bad scale counts as 100 %");
        // Not a full-screen overlay: a fraction of either monitor.
        let (w, h) = window_size(1.5);
        assert!((w * h) as f64 / (1920.0 * 1200.0) < 0.04);
    }

    #[test]
    fn perches_on_a_bottom_taskbar_at_150_percent() {
        let p = taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE);
        assert_eq!(p.surface, Surface::Taskbar(Edge::Bottom));
        assert_eq!((p.stance, p.ay), (Stance::Stand, 1128), "feet on the taskbar's top edge");
        let r = window_rect(&p);
        // The window ends FOOT (9 physical px at 150 %) below the feet: just over the taskbar's top.
        assert_eq!(r.y + r.h as i32, 1128 + 9);
        assert!(r.x >= 0 && r.x + r.w as i32 <= 1920, "the whole window on the laptop's screen");
        let (cx, cy, rr) = body(r.x, r.y, p.stance, p.lean, p.scale);
        assert_eq!(cx, p.ax);
        assert!(cy + rr <= 1128 && cy - rr > 1128 - 200, "the body above the taskbar, never on it");
        // Right part of the bar by default, and anywhere along it with `side`.
        assert!(p.ax > 1920 / 2);
        assert_eq!(taskbar_perch(&LAPTOP, Some(&TB1), 0.0).ax, (396 + 1) / 2);
        assert_eq!(taskbar_perch(&LAPTOP, Some(&TB1), 1.0).ax, 1920 - 198);
    }

    #[test]
    fn auto_hide_taskbar_hidden_and_shown() {
        // Hidden: only 2 px of it on screen; the work area is the whole monitor.
        let mon = Monitor { work: LAPTOP.rect, ..LAPTOP };
        let hidden = Taskbar { rect: Rect { x: 0, y: 1198, w: 1920, h: 72 }, autohide: true, ..TB1 };
        let p = taskbar_perch(&mon, Some(&hidden), DEFAULT_SIDE);
        assert_eq!(p.ay, 1200 - 6, "on the screen's edge, its 2 px reveal strip and a gap clear (4 logical = 6 px)");
        // Shown (the mouse went down there): it rides on top of it.
        let shown = Taskbar { rect: Rect { x: 0, y: 1128, w: 1920, h: 72 }, ..hidden };
        assert_eq!(taskbar_perch(&mon, Some(&shown), DEFAULT_SIDE).ay, 1128);
        // Half way in: on its current top.
        let sliding = Taskbar { rect: Rect { x: 0, y: 1160, w: 1920, h: 72 }, ..hidden };
        assert_eq!(taskbar_perch(&mon, Some(&sliding), DEFAULT_SIDE).ay, 1160);
    }

    #[test]
    fn top_and_side_taskbars() {
        let mon = Monitor { work: Rect { x: 0, y: 72, w: 1920, h: 1128 }, ..LAPTOP };
        let top = Taskbar { edge: Edge::Top, rect: Rect { x: 0, y: 0, w: 1920, h: 72 }, ..TB1 };
        let p = taskbar_perch(&mon, Some(&top), DEFAULT_SIDE);
        assert_eq!((p.stance, p.ay, p.surface), (Stance::Hang, 72, Surface::Taskbar(Edge::Top)));
        assert_eq!(window_rect(&p).y, 72, "hanging: the window's top on the taskbar's bottom edge");
        let (_, cy, _) = body(window_rect(&p).x, window_rect(&p).y, Stance::Hang, 0, 1.5);
        assert_eq!(cy, 72 + 69, "the head's centre 46 logical px under the taskbar");
        // A left taskbar: on the floor, leaning on it, the body clear of it.
        let mon = Monitor { work: Rect { x: 72, y: 0, w: 1848, h: 1200 }, ..LAPTOP };
        let left = Taskbar { edge: Edge::Left, rect: Rect { x: 0, y: 0, w: 72, h: 1200 }, ..TB1 };
        let p = taskbar_perch(&mon, Some(&left), DEFAULT_SIDE);
        assert_eq!((p.lean, p.ay, p.stance), (-1, 1200, Stance::Stand));
        let r = window_rect(&p);
        let (bx, _, br) = body(r.x, r.y, p.stance, p.lean, p.scale);
        assert!(bx - br >= 72 && bx - br <= 72 + 6, "its body against the taskbar: {}", bx - br);
        assert!(r.x >= 0, "its window on the monitor");
        assert_eq!(p.span, (p.ax, p.ax), "it stays in its corner");
        let right = Taskbar { edge: Edge::Right, rect: Rect { x: 1848, y: 0, w: 72, h: 1200 }, ..TB1 };
        let p = taskbar_perch(&Monitor { work: Rect { x: 0, y: 0, w: 1848, h: 1200 }, ..LAPTOP }, Some(&right), 0.1);
        assert_eq!(p.lean, 1);
        let r = window_rect(&p);
        let (bx, _, br) = body(r.x, r.y, p.stance, p.lean, p.scale);
        assert!(bx + br <= 1848 && bx + br >= 1848 - 6);
        assert!(r.x + r.w as i32 <= 1920);
        // The edges of secondary taskbars, from their rectangles.
        assert_eq!(edge_of(TB2.rect, SAMSUNG.rect), Edge::Bottom);
        assert_eq!(edge_of(Rect { x: 1920, y: 0, w: 1920, h: 48 }, SAMSUNG.rect), Edge::Top);
        assert_eq!(edge_of(Rect { x: 1920, y: 0, w: 48, h: 1080 }, SAMSUNG.rect), Edge::Left);
        assert_eq!(edge_of(Rect { x: 3792, y: 0, w: 48, h: 1080 }, SAMSUNG.rect), Edge::Right);
    }

    #[test]
    fn a_monitor_without_a_taskbar_has_a_floor() {
        let p = taskbar_perch(&SAMSUNG, None, DEFAULT_SIDE);
        assert_eq!((p.surface, p.ay), (Surface::Floor, 1032));
        // Another monitor's taskbar is not this one's.
        assert_eq!(taskbar_perch(&SAMSUNG, Some(&TB1), DEFAULT_SIDE).surface, Surface::Floor);
    }

    #[test]
    fn perches_on_the_window_in_front() {
        let f = app(77, 2, 2200, 300, 1000, 600);
        let p = window_perch(&SAMSUNG, &f).expect("a window it can sit on");
        assert_eq!((p.ay, p.surface, p.on_window, p.ref_x), (300, Surface::Window, 77, 2200));
        assert_eq!(p.ax, 2200 + 250, "a quarter in from its left edge, away from the caption buttons");
        assert!(p.span.0 >= 2200 + 46 && p.span.1 <= 3200 - 46, "the body (38) and a margin (8) inside its edges");
        // Not on: maximized, full screen, too narrow, too near the top, not an app, another monitor.
        assert!(window_perch(&SAMSUNG, &Front { maximized: true, ..f }).is_none());
        assert!(window_perch(&SAMSUNG, &Front { fullscreen: true, ..f }).is_none());
        assert!(window_perch(&SAMSUNG, &Front { rect: Rect { w: 240, ..f.rect }, ..f }).is_none());
        assert!(window_perch(&SAMSUNG, &Front { rect: Rect { y: 120, ..f.rect }, ..f }).is_none());
        assert!(window_perch(&SAMSUNG, &Front { app: false, ..f }).is_none());
        assert!(window_perch(&LAPTOP, &f).is_none());
        // At 150 % it needs more room above (the window is bigger): 134 logical = 201 physical.
        let g = app(5, 1, 100, 200, 900, 700);
        assert!(window_perch(&LAPTOP, &g).is_none());
        assert!(window_perch(&LAPTOP, &Front { rect: Rect { y: 201, ..g.rect }, ..g }).is_some());
        // A window hanging off the screen's left: only the part on screen counts, the window stays on it.
        let h = app(6, 2, 1700, 400, 800, 500);
        let p = window_perch(&SAMSUNG, &h).unwrap();
        assert!(window_rect(&p).x >= 1920);
    }

    #[test]
    fn the_setting_picks_the_perch() {
        let f = app(9, 1, 300, 400, 1200, 600);
        assert_eq!(choose(PerchPref::Both, &LAPTOP, Some(&TB1), Some(&f), DEFAULT_SIDE, false).surface, Surface::Window);
        assert_eq!(choose(PerchPref::Windows, &LAPTOP, Some(&TB1), Some(&f), DEFAULT_SIDE, false).surface, Surface::Window);
        assert_eq!(choose(PerchPref::Taskbar, &LAPTOP, Some(&TB1), Some(&f), DEFAULT_SIDE, false).surface, Surface::Taskbar(Edge::Bottom));
        // Windows only, but the window cannot hold it (maximized): the taskbar.
        assert_eq!(choose(PerchPref::Windows, &LAPTOP, Some(&TB1), Some(&Front { maximized: true, ..f }), DEFAULT_SIDE, false).surface, Surface::Taskbar(Edge::Bottom));
        // Dozing: back on the taskbar to sleep.
        assert_eq!(choose(PerchPref::Both, &LAPTOP, Some(&TB1), Some(&f), DEFAULT_SIDE, true).surface, Surface::Taskbar(Edge::Bottom));
    }

    #[test]
    fn it_follows_the_active_monitor() {
        let mons = [LAPTOP, SAMSUNG];
        let on2 = app(3, 2, 2000, 200, 800, 600);
        assert_eq!(pick_monitor(&mons, Some(&on2), Some((10, 10)), None, 1).unwrap().id, 2, "the window in front's monitor");
        // The desktop in front: where the cursor is.
        let desk = Front { app: false, ..Front::default() };
        assert_eq!(pick_monitor(&mons, Some(&desk), Some((2500, 500)), None, 1).unwrap().id, 2);
        assert_eq!(pick_monitor(&mons, None, Some((50, 50)), None, 2).unwrap().id, 1);
        // "Stay on this monitor".
        assert_eq!(pick_monitor(&mons, Some(&on2), Some((2500, 500)), Some(1), 1).unwrap().id, 1);
        // The monitor it stayed on was unplugged: it follows again.
        assert_eq!(pick_monitor(&mons, Some(&on2), None, Some(9), 1).unwrap().id, 2);
        assert_eq!(pick_monitor(&mons, None, None, None, 7).unwrap().id, 1, "nothing known: the first");
        assert!(pick_monitor(&[], None, None, None, 1).is_none());
    }

    #[test]
    fn it_keeps_its_place_and_rides_a_moved_window() {
        let cur = Perch { ax: 1300, ..taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE) };
        let t = keep_place(&cur, taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE));
        assert_eq!(t.ax, 1300, "stepped aside on the taskbar: it stays there");
        let f = app(4, 2, 2200, 300, 1000, 600);
        let on = Perch { ax: 2600, ..window_perch(&SAMSUNG, &f).unwrap() };
        let moved = window_perch(&SAMSUNG, &Front { rect: Rect { x: 2000, y: 360, ..f.rect }, ..f }).unwrap();
        let t = keep_place(&on, moved);
        assert_eq!((t.ax, t.ay), (2400, 360), "the window moved 200 left and 60 down: so does the bot");
    }

    #[test]
    fn it_waits_for_a_target_to_settle_and_dwells() {
        let a = taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE);
        let b = window_perch(&LAPTOP, &app(4, 1, 200, 500, 1000, 500)).unwrap();
        let mut f = Follow::default();
        f.arrived(0);
        assert_eq!(f.update(3000, &a, b, false), None, "a new target: wait");
        assert_eq!(f.update(3300, &a, b, false), None);
        assert_eq!(f.update(3600, &a, b, false), Some(b), "held still 600 ms: go");
        // Quick Alt+Tab: the target changes before it settles -- nothing.
        let c = window_perch(&LAPTOP, &app(5, 1, 900, 600, 800, 400)).unwrap();
        f.arrived(10_000);
        assert_eq!(f.update(13_000, &a, b, false), None);
        assert_eq!(f.update(13_300, &a, c, false), None);
        assert_eq!(f.update(13_700, &a, b, false), None);
        assert_eq!(f.update(14_300, &a, b, false), Some(b));
        // Just arrived: it stays DWELL_MS, unless its perch is gone.
        f.arrived(20_000);
        assert_eq!(f.update(20_100, &b, a, false), None);
        assert_eq!(f.update(20_800, &b, a, false), None, "settled but still dwelling");
        assert_eq!(f.update(20_900, &b, a, true), Some(a), "its window closed: off it goes");
        // Already there: nothing to do.
        assert_eq!(f.update(30_000, &a, a, false), None);
    }

    #[test]
    fn a_walk_along_the_taskbar() {
        let a = taskbar_perch(&LAPTOP, Some(&TB1), 0.2);
        let b = taskbar_perch(&LAPTOP, Some(&TB1), 0.8);
        let legs = plan(&a, &b, &[LAPTOP], true);
        assert_eq!(legs.len(), 1);
        let l = legs[0];
        assert_eq!((l.kind, l.dir), (LegKind::Walk, 1));
        assert_eq!(l.from.1, l.to.1, "level");
        // ~916 physical px at 150 % = 611 logical px at 300 a second.
        assert!((1900..=2200).contains(&l.ms), "{}", l.ms);
        let mid = sample(&legs, l.ms as u64 / 2);
        assert!(!mid.done && mid.x > l.from.0 && mid.x < l.to.0 && mid.y == l.from.1);
        let end = sample(&legs, 99_999);
        assert!(end.done && (end.x, end.y) == l.to);
        assert_eq!(window_pos(&b), l.to);
    }

    #[test]
    fn a_hop_up_onto_a_window() {
        let a = taskbar_perch(&LAPTOP, Some(&TB1), 0.8);
        let b = window_perch(&LAPTOP, &app(4, 1, 200, 500, 1000, 500)).unwrap();
        let legs = plan(&a, &b, &[LAPTOP], true);
        assert_eq!(legs.iter().map(|l| l.kind).collect::<Vec<_>>(), vec![LegKind::Walk, LegKind::Hop], "along the taskbar toward it, then up");
        let hop = legs[1];
        assert_eq!(hop.to, window_pos(&b));
        assert!(hop.ms >= 420 && hop.ms <= 900);
        // The arc rises above both ends.
        let top = (0..=20).map(|i| at(&hop, i as f64 / 20.0).1).min().unwrap();
        assert!(top < hop.to.1.min(hop.from.1), "{} vs {}", top, hop.to.1);
        // Level ends: the apex is `lift` above them.
        let level = Leg { from: (0, 500), to: (300, 500), ..hop };
        let apex = at(&level, 0.5).1;
        assert_eq!(apex, 500 - hop.lift);
        // Close by: just the hop, no walk first.
        let near = Perch { ax: b.ax + 30, ..a };
        assert_eq!(plan(&near, &b, &[LAPTOP], true).iter().map(|l| l.kind).collect::<Vec<_>>(), vec![LegKind::Hop]);
    }

    #[test]
    fn crossing_to_the_second_monitor() {
        let a = taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE);
        let b = taskbar_perch(&SAMSUNG, Some(&TB2), DEFAULT_SIDE);
        let mons = [LAPTOP, SAMSUNG];
        let legs = plan(&a, &b, &mons, true);
        let kinds: Vec<_> = legs.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, vec![LegKind::Walk, LegKind::Out, LegKind::Cross, LegKind::In, LegKind::Walk]);
        assert!(legs.iter().all(|l| l.dir == 1), "toward the Samsung, on the right");
        // It walks to the laptop's right edge: the window still wholly on the laptop (no DPI change mid-walk).
        let w0 = legs[0];
        assert_eq!(w0.to.0 + window_size(1.5).0 as i32, 1920);
        assert!(w0.scale == 1.5 && w0.monitor == 1);
        // The crossing carries the Samsung's monitor and 100 % scale; it enters at its left edge, on its taskbar.
        let c = legs[2];
        assert_eq!((c.monitor, c.scale, c.ms), (2, 1.0, 0));
        assert_eq!(c.to.0, 1920, "the window's left on the Samsung's left edge");
        assert_eq!(c.to.1 + window_size(1.0).1 as i32 - 6, 1032, "feet on the Samsung's taskbar");
        assert_eq!(legs[4].to, window_pos(&b));
        // And back: toward the left.
        assert!(plan(&b, &a, &mons, true).iter().all(|l| l.dir == -1));
    }

    #[test]
    fn holding_still_it_jumps() {
        let a = taskbar_perch(&LAPTOP, Some(&TB1), 0.2);
        let b = taskbar_perch(&LAPTOP, Some(&TB1), 0.8);
        let legs = plan(&a, &b, &[LAPTOP], false);
        assert_eq!(legs.len(), 1);
        assert_eq!((legs[0].kind, legs[0].ms), (LegKind::Jump, 0));
        assert_eq!(sample(&legs, 0), Pose { x: legs[0].to.0, y: legs[0].to.1, leg: 1, k: 1.0, done: true });
        let c = taskbar_perch(&SAMSUNG, Some(&TB2), 0.5);
        let legs = plan(&a, &c, &[LAPTOP, SAMSUNG], false);
        assert_eq!(legs.iter().map(|l| l.kind).collect::<Vec<_>>(), vec![LegKind::Cross]);
        assert!(plan(&a, &a, &[LAPTOP], false).is_empty());
        assert_eq!(walk_fps(true, false), 0);
        assert_eq!(walk_fps(false, true), 30);
        assert_eq!(walk_fps(false, false), 60);
        assert_eq!(idle_period_ms(false, true, true), 1000);
        assert_eq!(idle_period_ms(true, false, true), 500);
        assert_eq!(idle_period_ms(false, false, true), 33);
        assert_eq!(idle_period_ms(false, false, false), 120);
    }

    #[test]
    fn steps_aside_when_the_cursor_comes_near() {
        let s = 1.5;
        let bot = (1500, 1050, 63);
        let span = (198, 1722);
        let mut d = Dodge::default();
        // Far away: nothing.
        assert_eq!(d.tick(0, bot, (500, 500), 1500, span, s), DodgeOut::Nothing);
        // Coming in from the left, through the ring, quickly.
        assert_eq!(d.tick(33, bot, (1400, 1050), 1500, span, s), DodgeOut::Nothing, "the grace");
        assert_eq!(d.tick(100, bot, (1410, 1050), 1500, span, s), DodgeOut::Nothing);
        match d.tick(250, bot, (1420, 1050), 1500, span, s) {
            DodgeOut::Aside(x) => assert_eq!(x, 1500 + 192, "one step (128 logical) away from the cursor, to the right"),
            o => panic!("{:?}", o),
        }
        // A pause before it steps again.
        assert_eq!(d.tick(400, bot, (1425, 1050), 1500, span, s), DodgeOut::Nothing);
    }

    #[test]
    fn resting_on_it_counts_as_on_purpose() {
        let s = 1.0;
        let bot = (1000, 900, 42);
        let span = (132, 1788);
        let mut d = Dodge::default();
        assert_eq!(d.tick(0, bot, (900, 900), 1000, span, s), DodgeOut::Nothing);
        // Onto the bot and slowing down to rest there.
        assert_eq!(d.tick(60, bot, (990, 900), 1000, span, s), DodgeOut::Nothing);
        assert_eq!(d.tick(100, bot, (991, 900), 1000, span, s), DodgeOut::Nothing);
        assert_eq!(d.tick(200, bot, (992, 901), 1000, span, s), DodgeOut::Nothing);
        assert_eq!(d.tick(380, bot, (992, 901), 1000, span, s), DodgeOut::Attention, "rested 250 ms on it");
        // Moving about near it now: it stays (you came to it on purpose).
        assert_eq!(d.tick(700, bot, (1060, 890), 1000, span, s), DodgeOut::Attention);
        // Leave the ring and come back fast: it steps aside again.
        assert_eq!(d.tick(900, bot, (1500, 300), 1000, span, s), DodgeOut::Nothing);
        assert!(!d.deliberate);
        assert_eq!(d.tick(1000, bot, (1050, 900), 1000, span, s), DodgeOut::Nothing);
        assert!(matches!(d.tick(1250, bot, (1060, 900), 1000, span, s), DodgeOut::Aside(_)));
    }

    #[test]
    fn passing_by_quickly_leaves_it_be_and_a_rest_without_a_click_moves_it() {
        let bot = (1000, 900, 42);
        let mut d = Dodge::default();
        // Straight across it at ~900 px a second: through the ring in under the grace, nothing happens.
        for i in 0..12u64 {
            assert_eq!(d.tick(i * 33, bot, (880 + 30 * i as i32, 900), 1000, (132, 1788), 1.0), DodgeOut::Nothing);
        }
        // Resting on it: attention -- then no click for ATTEND_MS: it was in the way, it steps aside.
        let mut d = Dodge::default();
        let t0 = 10_000;
        assert_eq!(d.tick(t0, bot, (1005, 900), 1000, (132, 1788), 1.0), DodgeOut::Nothing);
        assert_eq!(d.tick(t0 + 300, bot, (1005, 900), 1000, (132, 1788), 1.0), DodgeOut::Attention);
        assert_eq!(d.tick(t0 + 1800, bot, (1005, 900), 1000, (132, 1788), 1.0), DodgeOut::Attention);
        assert!(matches!(d.tick(t0 + 1950, bot, (1005, 900), 1000, (132, 1788), 1.0), DodgeOut::Aside(x) if x < 1000));
    }

    #[test]
    fn stepping_aside_at_the_end_of_the_shelf() {
        // Room to the right: away from a cursor on the left.
        assert_eq!(aside_x(500, 450, (100, 1800), 128), 628);
        // At the right end: past the cursor to its left.
        assert_eq!(aside_x(1790, 1760, (100, 1800), 128), 1760 - 128);
        assert_eq!(aside_x(110, 140, (100, 1800), 128), 140 + 128);
    }

    #[test]
    fn ducks_out_of_full_screen_meetings_and_the_lock_screen() {
        assert_eq!(duck(None, false, false), None);
        assert!(duck(Some("a full-screen window covers it"), false, false).unwrap().contains("full-screen"));
        assert!(duck(None, true, false).unwrap().contains("meeting"));
        assert!(duck(None, false, true).unwrap().contains("locked"));
        let teams = CapUse { app: "MSTeams_8wekyb3d8bbwe".into(), start: 133_000_000_000_000_000, stop: 0 };
        let done = CapUse { stop: 133_000_000_000_100_000, ..teams.clone() };
        let us = CapUse { app: "C:#Program Files#MINT AI#mint-desktop.exe".into(), ..teams.clone() };
        let wv = CapUse { app: "C:#Program Files (x86)#Microsoft#EdgeWebView#Application#130.0#msedgewebview2.exe".into(), ..teams.clone() };
        assert!(meeting(&[teams.clone()], &[], false), "a camera in use");
        assert!(meeting(&[teams.clone()], &[], true), "a camera in use, even in our own call");
        assert!(!meeting(&[done.clone()], &[done.clone()], false), "used, then stopped");
        assert!(meeting(&[], &[teams.clone()], false), "a microphone in use by another app");
        assert!(!meeting(&[], &[teams.clone()], true), "our own call: the microphone says nothing");
        assert!(!meeting(&[us.clone()], &[us, wv], false), "MINT AI's own use");
        assert!(!meeting(&[CapUse { start: 0, ..teams }], &[], false), "never started");
    }

    #[test]
    fn ducks_for_full_screen_on_its_own_monitor_only() {
        use crate::policy::{fullscreen_hold, FrontWin, Quns};
        let video = FrontWin { hwnd: 5, class: "Chrome_WidgetWin_1".into(), monitor: 2, rect: (1920, 0, 3840, 1080), monitor_rect: (1920, 0, 3840, 1080), ..Default::default() };
        // The bot on the Samsung: a full-screen video there ducks it out.
        assert!(duck(fullscreen_hold(Quns::Busy, Some(&video), 2).as_deref(), false, false).is_some());
        // The bot on the laptop: it stays out -- and does not follow the video to the Samsung.
        assert!(duck(fullscreen_hold(Quns::Busy, Some(&video), 1).as_deref(), false, false).is_none());
        let f = Front { hwnd: 5, rect: SAMSUNG.rect, monitor: 2, app: true, maximized: false, fullscreen: true };
        assert_eq!(pick_monitor(&[LAPTOP, SAMSUNG], Some(&f), Some((2500, 500)), None, 1).unwrap().id, 1);
        // A game in exclusive full screen on its monitor, and presentation mode.
        let game = FrontWin { class: "UnityWndClass".into(), monitor: 1, rect: (0, 0, 1280, 720), monitor_rect: (0, 0, 1920, 1200), ..Default::default() };
        assert!(duck(fullscreen_hold(Quns::D3dFullScreen, Some(&game), 1).as_deref(), false, false).is_some());
        assert!(duck(fullscreen_hold(Quns::Presentation, None, 1).as_deref(), false, false).is_some());
        // Windows' "busy" alone (the 0.1.8 lesson) never does.
        assert!(duck(fullscreen_hold(Quns::Busy, None, 1).as_deref(), false, false).is_none());
    }

    #[test]
    fn the_eyes_follow_a_cursor_in_range() {
        let win = (1000, 800);
        let bot = (1132, 888, 42);
        assert_eq!(look_at((1132, 700), win, bot, 1.0), Some((132.0, -100.0)));
        assert_eq!(look_at((1000 + 300, 800), win, bot, 1.5), Some((200.0, 0.0)), "CSS px at 150 %");
        assert_eq!(look_at((5000, 888), win, bot, 1.0), None);
    }

    #[test]
    fn names() {
        assert_eq!(PerchPref::Both.as_str(), "both");
        assert_eq!(serde_json::to_string(&PerchPref::Taskbar).unwrap(), "\"taskbar\"");
        assert_eq!(serde_json::from_str::<PerchPref>("\"windows\"").unwrap(), PerchPref::Windows);
        assert_eq!(serde_json::to_string(&Surface::Taskbar(Edge::Left)).unwrap(), r#"{"on":"taskbar","edge":"left"}"#);
        assert_eq!(serde_json::to_string(&Surface::Window).unwrap(), r#"{"on":"window"}"#);
    }
}
