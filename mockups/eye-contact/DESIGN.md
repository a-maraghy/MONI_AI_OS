# Eye contact: a bot that knows you're there

Design upgrade approved 2026-10-20. Built on top of Companion mode (ba8a2d0). **Not deployed, not released.**
The version is still 0.1.11.

The laptop camera is used for one thing: to sense whether you are at the desk and whether you are looking at the
screen. All of it happens on the machine. The bot then behaves like something sitting on your desk.

Previews (`dashboard/tools/shots-eye-contact.cjs`). They come from synthetic input: a scripted person goes through
the real state machine and drives the real Command Center. No camera and no face are involved.

| | |
|---|---|
| `1-meet-your-gaze.gif` | You sit down and it meets your eyes. You move right and left, lean in, then sit back, and the eyes follow you. Stills: `gaze-*.png` |
| `2-doze-when-you-leave.gif` | You turn away and leave. After 8 s it reads "away" and the bot dozes. You come back: it wakes and looks up. Still: `dozing.png` |
| `3-glance-cards.gif` | Desktop app. The glance cards come forward while you look at this screen and step back while you look at the other monitor. Stills: `glance-forward.png`, `glance-stepped-back.png` |
| `4-settings-opt-in.png` | Settings ▸ Appearance ▸ Eye contact in the browser: the plain explanation, and every switch off |
| `5-app-settings.png` | The desktop app's Settings window, section Eye contact (the only place where the app can switch the camera on) |

## What it does

- **It looks at you.** The camera module reports where you are relative to the bot, as a coarse direction in
  quarters of −1..1. Core E's new `contact({x, y})` puts the eyes there, ranked above the pointer and below a
  delegation or a session glance. The eyes follow when you lean or move.
- **It looks up when you sit down.** When the state goes from away to present or looking, `presence()` wakes the
  bot if it is dozing and adds a 0.9 s glance upward.
- **It dozes when you walk away.** With the camera on, presence replaces the 10-minute timer:
  - away: it dozes;
  - looking: it never dozes;
  - here but not looking: only the night rule applies (23:00–06:00, after a quiet minute).
  
  The rule is the pure `dozeWanted({presence})`. With the camera off, behaviour is unchanged.
- **The companion bot** in Companion mode does the same (`MintDesktopCompanion` `presence` / `contact`). Its
  existing doze-to-taskbar walk follows.
- **Look and speak** has its own switch. You face the bot and start talking, and it listens without the talk key.
  It reuses the hold-to-talk path: `__mintLive.lookTalk()` opens a latched PTT turn, the same as a tap of the key,
  which is sent after a pause. The gate is conservative. All of these must hold:
  - a frontal look at the bot (within 7° of where the head should point);
  - held for 0.6 s;
  - nobody else as close in view;
  - speech onset: the level above the room's floor for 160 ms, where the floor rises slowly to a steady noise;
  - the person's own mouth moving (the jawOpen blendshape varied in the last 1.2 s);
  - no call held and the voice not speaking;
  - 3 s since the last start.
- **A reply pauses when you look away.** After about 1.5 s turned away from the screen, a live call's reply
  stops in place. The worklet's player outputs silence and keeps its queue, through `VoiceLive.pause`. A reply
  being read aloud stops too: its AudioContext is suspended (`__mintCC.pauseSpeaking`). Both resume when you look
  back. A press of the talk key still interrupts.
- **Attention drives the glance cards** in the desktop app. They come forward (full opacity and colour) only while
  the state is "looking", meaning at this screen. Otherwise they step back to opacity .34, never moved or resized (the real blur behind them stays put),
  and further while you are away. Hovering a card or focusing in it brings it forward.
- **Notifications wait while you are away.** Page toasts, the app's Windows toasts (`needs_you`) and MintSound
  chirps are held. When you are back you get one summary card ("While you were away · N", up to five lines) and
  one sound: the most important held one, ranked needs > approval > error > job > done. If MINT AI can't be seen,
  you also get one Windows toast. The proactive "while you were away" catch-up is asked for at that moment
  (`MintProactive.active()`).

## The states

The module exposes only `state` (null when off, otherwise `present`, `looking` or `away`), plus `gaze` and
whether the camera is in use. Hysteresis, from `MintPresenceLogic.T`:

| | |
|---|---|
| present | a face seen for 0.4 s; one or two missed frames do not break the run |
| looking | facing the screen for 0.25 s; it drops back to present only after 1.2 s of not facing (a glance at the keyboard does not count) |
| away | no face for 8 s; a lean out of frame is not leaving. At start, the state stays unknown until the camera has watched an empty desk for 8 s |
| at the bot | internal, for look and speak only: on after 0.5 s, off after 0.3 s |
| turned away | internal, for a reply's pause only: 1.5 s |

Geometry is in `aim()`, `classify()` and `gazeFor()`. They assume a 14" screen (34 × 21 cm) with the camera
centred on its top edge, a 60° horizontal field of view at 4:3, and a face about 15 cm wide (which gives the
distance). Head pose comes from the model's facial transformation matrix. A face is "at the screen" when its head
points within the screen's edges plus a tolerance (yaw ±12°, up 15°, down 10°). It is "at the bot" when within
9° / 10° of the direction to the bot's place on the screen (`MintPresenceBind.botAt()`, from the window's screen
position). The person is the largest face, and it stays the same person while about as big. Faces at least half
that size are counted as "others".

Frame rate (`rate()`):

| | |
|---|---|
| 5 fps | normal |
| 2 fps | on battery, while nobody is there, or in energy saver if the camera is kept then |
| 0 (release) | camera off; screen locked; another app's meeting; energy saver (by default); the page hidden for 10 s. A quick switch away does not flash the light, and the camera is never opened while hidden |

Frames are 320 × 240. In headless Chromium a frame takes 16 ms in the worker.

## Privacy

**Hard rules, and where each is enforced.**

- **Off by default.**
  - Browser: the switches are `normPrefs` defaults (all false) under localStorage `mint-presence`, per browser.
  - App: `presence::Presence::default()` is `camera: false` and `look_and_speak: false`.
  - With it off, the page never calls `getUserMedia({video})` and never downloads the model (tested).
- **Explicit opt-in with a plain explanation.**
  - The browser's switch is in Settings ▸ Appearance ▸ Eye contact. The explanation says what the camera is used
    for and what is never stored or sent. The browser's own permission prompt follows.
  - In the app, only the Settings window (a local page) or the tray can switch it ON. The tray's first click opens
    Settings at the explanation instead of switching on (`presence::tray_click`, `consented`).
  - The site can only switch it OFF (`presence_off`, `presence::page_set`). No command lets a remote page turn the
    camera on (checked in the test against `capabilities/remote.json`).
- **Local only.**
  - The face model (MediaPipe Face Landmarker, float16 v1) and tasks-vision 0.10.21 are pinned and vendored under
    `public/vendor/mediapipe/`, with the Apache-2.0 licence and sha256 checksums (checked by the test). Nothing
    comes from a CDN.
  - The worker has its own CSP, set by server.js for that file only: `script-src 'self' 'wasm-unsafe-eval'`
    (WebAssembly yes, JS eval no), `connect-src 'self'`, everything else `'none'`.
  - The pages keep `script-src 'self'` with no wasm and no eval.
- **No frame, image or landmark leaves the module.**
  - The `<video>` is never attached to the page.
  - Each frame is an ImageBitmap transferred to the worker, so the page keeps no copy. The worker closes it right
    after the model runs.
  - `summarize()` reduces each face to six numbers: box centre and width, yaw, pitch, jawOpen. The landmarks are
    dropped in the worker.
  - Those numbers stay in the module's closure.
  - `MintPresence.on` and `snapshot` give only `{state, gaze, camera, why}`.
  - The module and the worker contain no fetch, XHR, WebSocket, beacon or EventSource (checked statically).
  - In headless Chromium with a fake camera, every request is watched for six seconds of frames. Only the page's
    usual GET polling appears, there are no uploads, and no request body carries an image (tested).
- **No storage of frames.** Nothing writes frames or face data anywhere: not localStorage, not IndexedDB, not the
  server. Only the switches are stored.
- **Low frame rate, small resolution:** see above.
- **The camera is released** when switched off, when hidden (after 10 s), when the screen locks, during another
  app's meeting, and in energy saver by default. The track is stopped, the worker terminated and the landmarker
  closed (tested in the browser and through the app's state).
- **The camera light** comes on: getUserMedia opens the real device.
- **One tray switch, "Camera presence",** turns it off instantly.
  - The page drops the stream on the state event.
  - The app sets the WebView2 profile's camera permission for the site to Deny.
  - If the page still says it holds the camera 3 s after the setting went off, the app reloads it
    (`presence::must_reload`).
- **Visible while in use.**
  - A "Camera on · eye contact" pill shows whenever the stream is open. In the browser it has an Off button; in the
    app the tray's switch does that job, because the pill sits outside the hit regions.
  - The tray tooltip gains "· camera on" and the tray item reads "Camera presence (camera on now)" (the page reports
    `presence_status`).
- **The plain browser** stays off unless switched on there too: localStorage is per browser and never sent.
- **WebView2 permission is handled natively.**
  - `on_permission_request` calls `presence::permission(ask, ours, camera_on)`, which allows the camera only for the
    site's own origin and only while the setting is on. Everything else is denied as before; the microphone policy
    is unchanged.
  - wry does not stop WebView2 from saving a granted permission in the profile. So:
    - a second native handler (`camera_once`) marks every camera request `SavesInProfile(false)`;
    - `camera_profile` sets the profile's stored camera state for the site to Deny while off and Default while on,
      at start and on every change.
  - A grant can never outlive the setting, and nothing is ever auto-granted otherwise.
- **Look and speak and the microphone.**
  - While you face the bot with look and speak on, the microphone is open locally: a level meter (an AnalyserNode,
    never connected to the speakers) and, since 2026-10-21, the last 2.5 s of audio in memory, overwritten as it
    goes. It is never stored, and nothing is sent unless a turn starts.
  - When a turn starts, the audio from just before the speech began goes with it (the pre-roll), and this
    microphone feeds the turn until the voice path's own microphone flows, then closes.
  - It closes 2 s after you stop facing the bot.
  - The turn is the same path as the talk key.

## Files

- **Dashboard (page)**
  - `mint-presence-logic.js` (pure)
  - `mint-presence-worker.js` (the only code that sees a frame)
  - `mint-presence.js` (the camera module)
  - `mint-presence-bind.js` (what the page does with the state)
  - `mint-presence.css`
  - `mint-presence-settings.js`
  - `vendor/mediapipe/`
- **Additive hooks**
  - `mint-core-bot.js`: `presence()`, `contact()`, `dozeWanted({presence})`
  - `mint-desktop-companion.js`: passthroughs
  - `voice-live.js` / `voice-live-worklet.js`: `pause`, a "hold" message
  - `moni-ai.js`:
    - a hold gate in `toast()`;
    - `Voice.pause` and `__mintCC.pauseSpeaking`;
    - `__mintLive.lookTalk` / `busy`.
  - `mint-sound.js`: `heldBy`
  - `mint-proactive.js`: two hold gates
  - `mint-desktop.js`: one line, the `needs_you` hold gate
  - `views-moniai.js`: assets
  - `routes-settings.js`: the Eye contact group
  - `server.js`: the worker's CSP
- **Desktop app**
  - `src/presence.rs` (pure, 9 tests in core-tests)
  - `lib.rs`:
    - the permission policy;
    - `camera_profile` and `camera_once`;
    - the tray item;
    - `presence_status` and `presence_off`;
    - the env loop (power, lock, meeting, the reload guard);
    - Settings consent.
  - `settings.rs` (`presence`)
  - `dist/settings.*` (the Eye contact section)
  - `capabilities/remote.json`, `build.rs`
  - `Cargo.toml`: webview2-com 0.39 and windows-core 0.62, the same crates wry already uses

## Defaults chosen

- **Camera presence:** off.
- **Look and speak:** off. It is its own switch and needs the camera.
- **Releasing the camera in energy saver:** on.
- **Thresholds:**
  - present after 0.4 s;
  - looking after 0.25 s, back to present after 1.2 s;
  - away after 8 s;
  - a reply pauses after 1.5 s;
  - look and speak arms after 0.6 s with a 160 ms onset and a 3 s cool-down.
- **Frame rate:** 5 fps, or 2 on battery or with nobody there.
- **Resolution:** 320 × 240.
- **The hidden grace:** 10 s.
- **Geometry:** a 14" laptop with the camera on the top edge.

## Open questions

- **Direction sign on a real webcam.** It was derived from MediaPipe's coordinate conventions and only tested on
  synthetic streams. The laptop checklist asks to confirm that "move right → eyes go right". If it is mirrored,
  the fix is one sign.
- **Thresholds on real people,** tuned on synthetic data:
  - the at-the-bot tolerance (9° / 10°);
  - the speak tolerance (7°);
  - the mouth-movement rule;
  - away after 8 s.
- ~~Look and speak may clip the first syllable.~~ Fixed 2026-10-21 with a pre-roll (below).
- **External monitors and webcams.** The geometry assumes the camera sits on top of the screen showing MINT AI. A
  webcam on another monitor would make "looking at the bot" wrong. A calibration step ("look at the bot") could fix
  it.
- **Desktop layer while covered.** Does WebView2 report a covered (not minimised) window as hidden? If it does, the
  camera is released after 10 s of being covered. This is privacy-friendly, but the glance cards are then simply
  shown as without the camera.
- **The page pill's Off button** isn't clickable in the app, because the hit regions belong to mint-desktop.js,
  which was left untouched. The tray is the off switch there. Adding the pill to the regions is a two-line change
  in mint-desktop.js once the living-canvas work has merged.
- **Should the summary also list held sounds' sources?** Today it plays one sound and lists the notes.

## Which camera (2026-10-21)

Reported on 0.1.12: the phone's camera (Phone Link) was used, because the module asked for "a camera" and Windows'
default won. Now (page only, no new app version):

- **Automatic** (the default): the built-in camera first, then another real one, then an IR camera, and a phone /
  virtual one (Phone Link, Connected Camera, OBS, NVIDIA Broadcast, DroidCam, Iriun, Camo, EpocCam, Snap,
  Continuity, "Virtual") only if there is nothing else. Opened by `deviceId: {exact}` (`MintPresenceLogic.pickCamera`).
- **Settings ▸ Appearance ▸ Eye contact ▸ Camera** lists Automatic plus each camera by name, in the browser and in the
  app's page alike. The choice is kept in `localStorage["mint-presence-camera"]` = `{ id, label }` (the name is the
  fallback when Windows changes the id) and is never sent. An open Command Center switches at once (storage event);
  a camera plugged in or out is looked at again (devicechange).
- Names only show once the camera has been allowed: "Allow the camera once" asks and lets go at once (by itself only
  while eye contact is on).
- A chosen camera that is gone or fails: Automatic, and both the state's `why` and Settings say so.
- The pill reads "Camera on · Integrated Webcam".
- The app's own Settings window (desktop/dist, shipped inside the app) is unchanged: a hint pointing to the page's
  selector needs the next app build.

Screens: `camera-selector/`.

## Look and speak never started (2026-10-21)

Cause, from reading the gate end to end: "facing the bot" was judged from the **head's** angles alone, within 7°
sideways (to speak) and 10° up/down, and every single frame outside that restarted the 0.6 s hold. A person 55 cm
from a laptop looks at a bot 12° right / 18° down mostly with the eyes: the head turns ~4° and tips ~8°, so the
head is ~8° sideways and ~10° up off the bot, and MediaPipe's head pose jitters ±3° frame to frame. The hold
practically never completed. Also, with voice off, look and speak did nothing and said nothing.

Now:
- the eyes' up/down (eyeLookUp / eyeLookDown blendshapes: no left/right ambiguity) is added to the head's pitch;
- "at the bot" / "frontal to speak" use the median of the last three frames (at the screen stays per frame);
- tolerances 12° / 10° sideways (bot / speak), +13° / −12° up/down;
- one or two frames off (≤ 450 ms) no longer restart the 0.6 s hold;
- voice off: the pill reads "… · look and speak: voice is off", Settings says so with a link, and no
  microphone is opened for it;
- Settings ▸ Appearance ▸ Eye contact ▸ **Show what it sees**: a live checklist (face, facing with degrees off,
  mouth, level vs needed, voice ready, not busy, cool-down), numbers only, camera on that page only while open.

The negative cases still hold (reading the screen's middle and talking, a side glance, someone else talking, a TV,
someone as close beside you): dashboard/tools/test-presence.cjs.

## Look and speak: slow and inaccurate (2026-10-21)

The user: "the face is identified but it does not handle identifying the speech well, slow, inaccurate". Read end
to end, then measured with real recorded speech (dashboard/tools/test-look-speak.cjs: the real page, camera module
and voice path to a mock realtime server, a "room" every microphone hears, TTS narration clips in English and
Egyptian Arabic with their text, transcribed with gpt-4o-mini-transcribe, the server's model).

Causes:
- **The start of the speech was lost**, 0.5 s to 3 s of it. The turn began only at the 160 ms onset; then the
  camera module's microphone closed and the voice path opened its own, built its audio graph and started relaying.
  Everything said in between never reached the turn.
- **The onset itself was unreliable.** A 10 ms level read every 50 ms, and one quiet reading between two sounds
  restarted the 160 ms. A real sentence often started listening only words later, sometimes never.
- **The end waited 1.2 s of quiet** (a tapped key's latch) plus the 140 ms tail.
- **The call opened only once speech started** (1.2–2.4 s to "ready" on the live server).
- **The microphone opened late:** only once "at the bot" held for 0.5 s.

Now:
- **Pre-roll.** The camera module's microphone keeps the last 2.5 s in memory (the voice's own capture worklet,
  24 kHz PCM16). A turn gets the audio from 0.4 s before the spell of talking began (at least 1.2 s back). The
  module keeps feeding the turn until the voice's own microphone flows (VoiceLive.press({ preroll }), .feed).
- **Onset:** a 43 ms level. Dips up to 120 ms between sounds no longer restart it. At least 65 % of the readings
  must be sound, so typing's clicks still do not count.
- **The microphone opens on the first frame turned to the bot** (facingNow), not 0.5 s later.
- **The end:** 700 ms of quiet for a look-and-speak turn (LOOK_QUIET_MS). A tapped key keeps 1.2 s.
- **Warm start.** The look that arms look and speak opens the call ahead (lookWarm: hold-to-talk, warm, never
  over a reply being read, never the morning brief). Unused, it hangs up after 20 s, quietly. At most once per look
  and once per 8 s.
- **Once listening, only the audio ends the turn.** The face never does (unchanged, now tested).

Measured: 13 clips (6 EN, 6 AR, 1 synthetic), session ready 1.0 s, a microphone opening in 150 ms. Two
scenarios: speaking 0.9 s after looking (as you look), and 1.8 s after (armed first). Before → after:

| | as you look: before | as you look: after | armed first: before | armed first: after |
|---|---|---|---|---|
| turns opened | 12/13 | 13/13 | 12/13 | 13/13 |
| start of speech clipped (avg / max) | 1,302 / 3,020 ms | 0 / 0 ms | 493 / 1,060 ms | 0 / 0 ms |
| start of speech → listening (avg) | 1,144 ms | 653 ms | 337 ms | 270 ms |
| end of speech → turn sent (avg) | 1,399 ms | 875 ms | 1,387 ms | 899 ms |
| English WER (the clip itself: 0.00–0.03) | 0.346 | 0.030 | 0.136 | 0.022 |
| Arabic CER (the clip itself: 0.05–0.10) | 0.319 | 0.063 | 0.159 | 0.075 |
