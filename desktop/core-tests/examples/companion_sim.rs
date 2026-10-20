//! A scripted run of Companion mode's placement logic (src-tauri/src/companion.rs) on the user's desk -- the
//! laptop (1920 x 1200 at 150 %, primary, taskbar at the bottom) and the Samsung LF27T35 to its right
//! (1920 x 1080 at 100 %) -- the same steps companion_host.rs takes each tick: the active monitor, the perch
//! by the setting, settle and dwell, the path, stepping aside, ducking out, dozing back to the taskbar.
//!
//!     cargo run --example companion_sim > frames.json
//!
//! The preview (dashboard/tools/shots-desk-companion.cjs) plays the frames on a drawn desk with the real
//! companion page in the window: so the GIFs show this logic, not a re-creation of it.

use mint_desktop_core_tests::companion::*;
use mint_desktop_core_tests::layout::Rect;
use serde_json::json;

const LAPTOP: Monitor = Monitor { id: 1, rect: Rect { x: 0, y: 0, w: 1920, h: 1200 }, work: Rect { x: 0, y: 0, w: 1920, h: 1128 }, scale: 1.5 };
const SAMSUNG: Monitor = Monitor { id: 2, rect: Rect { x: 1920, y: 0, w: 1920, h: 1080 }, work: Rect { x: 1920, y: 0, w: 1920, h: 1032 }, scale: 1.0 };
const TB1: Taskbar = Taskbar { monitor: 1, edge: Edge::Bottom, rect: Rect { x: 0, y: 1128, w: 1920, h: 72 }, autohide: false };
const TB2: Taskbar = Taskbar { monitor: 2, edge: Edge::Bottom, rect: Rect { x: 1920, y: 1032, w: 1920, h: 48 }, autohide: false };

fn win(hwnd: isize, monitor: isize, x: i32, y: i32, w: u32, h: u32, title: &str) -> (Front, &str) {
    (Front { hwnd, rect: Rect { x, y, w, h }, monitor, app: true, maximized: false, fullscreen: false }, title)
}

fn main() {
    let mons = [LAPTOP, SAMSUNG];
    let tbs = [TB1, TB2];
    let a = win(11, 1, 220, 360, 1150, 620, "Report.docx - Word");
    let b = win(12, 2, 2160, 250, 1260, 680, "Planning engine - Odoo");
    let c = win(13, 1, 900, 520, 860, 470, "Inbox - Outlook");
    let video = (Front { hwnd: 14, rect: SAMSUNG.rect, monitor: 2, app: true, maximized: false, fullscreen: true }, "Video (full screen)");
    // (from ms, the window in front -- None: the desktop)
    let fronts: Vec<(u64, Option<(Front, &str)>)> = vec![(0, None), (1500, Some(a)), (6200, Some(c)), (10200, Some(b)), (26500, Some(video)), (29800, Some(b))];
    // The cursor, by phase, relative to the bot where it is when the phase starts: (from ms, to ms, from, to);
    // otherwise far away. 1: in from the left, then it lingers beside the bot (it steps aside); 2: onto the
    // bot and resting there (it looks up, "Click to open"; no click: it steps aside after ATTEND_MS); 3: away.
    let cursor_moves: Vec<(u64, u64, (i32, i32), (i32, i32))> = vec![
        (19000, 19500, (-520, 260), (-70, 20)),
        (19500, 20600, (-70, 20), (-66, 22)),
        (21400, 21900, (700, -200), (4, 2)),
        (21900, 24800, (4, 2), (4, 2)),
        (24800, 25300, (4, 2), (900, -300)),
    ];
    let doze_from = 32500u64;
    let end = 40000u64;
    let pref = PerchPref::Both;

    let mut follow = Follow::default();
    let mut dodge = Dodge::default();
    let mut cur = taskbar_perch(&LAPTOP, Some(&TB1), DEFAULT_SIDE);
    let mut legs: Vec<Leg> = Vec::new();
    let mut dest: Option<Perch> = None;
    let mut started = 0u64;
    let mut shown: i64 = -1;
    let (mut x, mut y) = window_pos(&cur);
    let mut scale = cur.scale;
    let mut stance = cur.stance;
    let mut ducked = false;
    let mut duck_at: Option<u64> = None;
    let mut attention = false;
    let mut frames = Vec::new();
    let mut events: Vec<serde_json::Value> = vec![json!({"kind": "arrive", "view": view(&cur)})];
    let mut anchors: Vec<(i32, i32)> = Vec::new();
    follow.arrived(0);
    let mut t = 0u64;
    while t <= end {
        let front = fronts.iter().rev().find(|(f, _)| *f <= t).and_then(|(_, w)| *w);
        let fr = front.map(|(f, _)| f);
        // The cursor.
        let mut cursor = (5000, 5000);
        for (i, (t0, t1, p0, p1)) in cursor_moves.iter().enumerate() {
            if t >= *t0 && t < *t1 {
                if anchors.len() <= i {
                    let (bx, by, _) = body(x, y, stance, cur.lean, scale);
                    anchors.push((bx, by));
                }
                let (bx, by) = anchors[i];
                let k = (t - t0) as f64 / (*t1 - *t0) as f64;
                let k = k * k * (3.0 - 2.0 * k);
                cursor = (bx + (p0.0 as f64 + (p1.0 - p0.0) as f64 * k) as i32, by + (p0.1 as f64 + (p1.1 - p0.1) as f64 * k) as i32);
            }
        }
        // Ducking out: something full screen on its monitor.
        let fs = fr.map(|f| f.fullscreen && f.monitor == cur.monitor).unwrap_or(false);
        let why = duck(if fs { Some("full screen") } else { None }, false, false);
        match (why.is_some(), ducked, duck_at) {
            (true, false, None) => {
                events.push(json!({"kind": "duck"}));
                duck_at = Some(t + 450);
                legs.clear();
            }
            (true, false, Some(d)) if t >= d => {
                ducked = true;
                duck_at = None;
            }
            (false, true, _) | (false, false, Some(_)) => {
                ducked = false;
                duck_at = None;
                events.push(json!({"kind": "pop"}));
                follow.arrived(0);
            }
            _ => {}
        }
        if why.is_none() {
            if !legs.is_empty() {
                let pose = sample(&legs, t - started);
                for i in (shown + 1).max(0) as usize..=pose.leg.min(legs.len() - 1) {
                    let l = legs[i];
                    events.push(json!({"kind": l.kind, "ms": l.ms, "dir": l.dir, "stance": l.stance}));
                    shown = i as i64;
                    if matches!(l.kind, LegKind::Cross | LegKind::Jump) {
                        x = l.to.0;
                        y = l.to.1;
                        scale = l.scale;
                        stance = l.stance;
                    }
                }
                if pose.done {
                    let l = *legs.last().unwrap();
                    x = l.to.0;
                    y = l.to.1;
                    scale = l.scale;
                    stance = l.stance;
                    cur = dest.unwrap();
                    legs.clear();
                    follow.arrived(t);
                    events.push(json!({"kind": "arrive", "view": view(&cur)}));
                } else {
                    let l = legs[pose.leg];
                    if matches!(l.kind, LegKind::Walk | LegKind::Hop) {
                        x = pose.x;
                        y = pose.y;
                        scale = l.scale;
                        if pose.k >= 0.5 {
                            stance = l.stance;
                        }
                    }
                }
            } else {
                let dozing = t >= doze_from;
                let mon = pick_monitor(&mons, fr.as_ref(), Some(cursor), None, cur.monitor).unwrap();
                let tb = tbs.iter().find(|tb| tb.monitor == mon.id);
                let target = keep_place(&cur, choose(pref, mon, tb, fr.as_ref(), DEFAULT_SIDE, dozing));
                let gone = cur.surface == Surface::Window && fr.map(|f| f.hwnd != cur.on_window).unwrap_or(true);
                if let Some(d) = follow.update(t, &cur, target, gone) {
                    legs = plan(&cur, &d, &mons, true);
                    dest = Some(d);
                    started = t;
                    shown = -1;
                } else {
                    let bot = body(x, y, stance, cur.lean, scale);
                    match dodge.tick(t, bot, cursor, cur.ax, cur.span, scale) {
                        DodgeOut::Aside(nx) => {
                            let d = Perch { ax: nx, ..cur };
                            legs = plan(&cur, &d, &mons, true);
                            dest = Some(d);
                            started = t;
                            shown = -1;
                            events.push(json!({"kind": "aside"}));
                        }
                        DodgeOut::Attention if !attention => {
                            attention = true;
                            events.push(json!({"kind": "attention"}));
                        }
                        DodgeOut::Nothing if attention => {
                            attention = false;
                            events.push(json!({"kind": "attention-off"}));
                        }
                        _ => {}
                    }
                }
            }
        }
        if t % 50 == 0 {
            let (w, h) = window_size(scale);
            let look = look_at(cursor, (x, y), body(x, y, stance, cur.lean, scale), scale);
            frames.push(json!({
                "t": t, "x": x, "y": y, "w": w, "h": h, "scale": scale, "monitor": cur.monitor, "hidden": ducked,
                "front": front.map(|(f, title)| json!({"x": f.rect.x, "y": f.rect.y, "w": f.rect.w, "h": f.rect.h, "title": title, "full": f.fullscreen})),
                "cursor": if cursor.0 < 4000 { json!([cursor.0, cursor.1]) } else { json!(null) },
                "look": look.map(|(a, b)| json!([a, b])),
                "dozing": t >= doze_from,
                "events": std::mem::take(&mut events),
            }));
        }
        t += 10;
    }
    let wins = [a, b, c];
    let out = json!({
        "monitors": mons.iter().map(|m| json!({"id": m.id, "x": m.rect.x, "y": m.rect.y, "w": m.rect.w, "h": m.rect.h, "scale": m.scale, "name": if m.id == 1 { "Laptop · 150 %" } else { "Samsung LF27T35 · 100 %" }})).collect::<Vec<_>>(),
        "taskbars": tbs.iter().map(|t| json!({"x": t.rect.x, "y": t.rect.y, "w": t.rect.w, "h": t.rect.h})).collect::<Vec<_>>(),
        "windows": wins.iter().map(|(f, title)| json!({"x": f.rect.x, "y": f.rect.y, "w": f.rect.w, "h": f.rect.h, "title": title})).collect::<Vec<_>>(),
        "frames": frames,
    });
    println!("{}", out);
}

fn view(p: &Perch) -> serde_json::Value {
    let open = if p.ax - p.span.0 > p.span.1 - p.ax { "left" } else { "right" };
    json!({"stance": p.stance, "lean": p.lean, "openSide": open, "surface": p.surface})
}
