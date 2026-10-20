# MINT AI · sound identity (2026-10-20)

Small, quiet sounds that tell you what happened without looking. The code is
`dashboard/public/mint-sound.js`. The tests are `dashboard/tools/test-sound-identity.cjs`.

Open `index.html` to listen, or play `mp3/tour.mp3` to hear every sound in a row. The files are
rendered at 100 % volume so they can be heard. The app plays them at your volume, which is 30 % by
default (compare `mp3/approval-at-30.mp3`). The WAVs are not committed. To regenerate them all:
`node dashboard/tools/make-sound-identity.cjs mockups/sound-identity`.

## The sounds

| Sound | When | Shape |
|---|---|---|
| **wake** | the bot (core E) wakes from dozing | two rising notes ("bwee-WEEP") with a little wobble |
| **think** | MINT AI starts thinking, or a session starts working | one soft blip that glides up |
| **done** | a session finishes (working → idle) | "bi-dup": a short note, then a higher one that rises |
| **needs** | a session starts waiting on you | "bip-bip-bweep?": two blips and a rising question |
| **error** | MINT AI becomes unreachable, a turn ends in an error, or a delegation fails | a falling "bwow-wow" |
| **approval** (key sound) | an approval is waiting | a soft two-note bell (E6, then B6), about 1.5 s |
| **job** (key sound) | a delegation comes back done, or a MINT AI turn of 20 s or more finishes | three rising marimba notes (C6, E6, G6) |

A chirp keeps the same shape for every role. The role changes the voice (pitch and timbre),
keyed on `cc-logic.js` `BOT_ROLE_RULES`. The two key sounds are the same for every role.

| Role | Voice |
|---|---|
| core (MINT AI itself) | pure sine at the base pitch |
| hired | 2 semitones up, triangle wave (brighter) |
| planning | 2 semitones down, sine plus an octave partial (rounder) |
| erp (Odoo) | 4 semitones down, filtered square wave (woody) |
| builder (Mint OS) | 4 semitones up, light FM (metallic) |
| other | 1 semitone down, soft triangle wave |

Every sound is procedural WebAudio: a few oscillators with pitch glides and envelopes, plus a
touch of FM or a low-pass filter. There are no sample files. `make-sound-identity.cjs` renders the
same recipes offline into these files.

## Where they are triggered

- **`cc-map.js`** triggers them for every core:
  - When a session starts waiting, it plays **needs**. When a session goes from working to idle,
    it plays **done**. When a session goes from idle to working, it plays **think**. Each uses that
    session's voice.
  - When MINT AI goes from idle to thinking, it plays **think**.
  - When a long turn finishes, it plays **job**, together with the grin.
  - When MINT AI goes offline, it plays **error**.
  - When the bot wakes from a doze, it plays **wake** (through a new `onWake` option in
    `mint-core-bot.js`).
- **`moni-ai.js`** triggers these:
  - A new pending approval plays **approval**.
  - A delegation that turns done plays **job**. A delegation that fails plays **error**, in the
    session's voice.
  - A turn that ends in an error plays **error**.
- **Other builds** can call `MintSound.play(name, { role })`. For example, a watcher firing or a
  brief arriving could play `job` or `needs`. Every rule below applies to those calls too.

## Rules

- **Quiet by default.** The default volume is 30 %, about 20 dB below full, on a squared curve.
- **Your settings.** There is one volume, one off switch, and quiet hours (default 23:00–07:00).
  They are stored per person in `users.mint_sound`. You change them in Settings ▸ Appearance ▸
  Sounds, which also has Listen buttons. They are saved through `POST /mint-ai/api/prefs/sound`,
  which is audited.
- **Browser and desktop app.** A plain browser stays silent until you switch it on in that
  browser, in the "This browser" row. That switch is kept in localStorage and never sent to the
  server. The desktop app (`?shell=desktop`) follows your per-person switch.
- **Sounds never stack:**
  - Events that arrive within 350 ms of each other merge into one sound. The most important wins:
    approval, then error, needs, job, done, wake, think.
  - At least 1.2 s passes between two sounds.
  - Each sound and role has its own cooldown: think 10 s, wake 30 s, done 4 s, needs 6 s,
    error 8 s, and 5 s for each key sound.
  - At most 8 sounds play in a minute.
  - A sound held for more than 4 s is dropped.
  - Two tabs of one browser never play the same moment.
- **Never during a live voice call, or while the voice speaks.** This is checked again just before
  a waiting sound plays.
- **Autoplay.** Nothing plays until a pointer, key or touch gesture unlocks the audio. In the
  desktop app, an audio context that the host lets start "running" counts as unlocked.

## Windows Do Not Disturb / Focus: native work still needed

The page cannot see either setting today. App 0.1.10 keeps its tray switch "Do not disturb (no
toasts)" in Rust (`settings.do_not_disturb`) and does not send it in `mint://state`. It does not
read Windows Focus at all.

The page side is ready. `mint-desktop.js` already passes `dnd` and `focusAssist` from
`mint://state` and `get_state` to `MintSound.setHost({ dnd })`. The remaining work is in
`desktop/src-tauri`, which was not edited here:

1. Add `dnd: bool` (= `settings.do_not_disturb`) to `PageState` in lib.rs. Re-emit `mint://state`
   when the tray switch changes (the `"dnd"` menu arm).
2. Add `focus_assist: bool`, serialised as `focusAssist`, set while Windows Focus or Do not disturb
   is on.
   - `SHQueryUserNotificationState` already covers presentation mode, full screen and quiet time
     (`QUNS_QUIET_TIME`), but not Focus Assist.
   - Focus Assist needs the undocumented WNF state `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`
     (read through `NtQueryWnfStateData`), or the Windows 11
     `Windows.UI.Shell.FocusSessionManager` (which covers Focus sessions only).
   - Poll it in the existing env loop and emit `mint://state` when it changes.
3. Optional: also report `QUNS_BUSY`, `QUNS_PRESENTATION_MODE` and `QUNS_RUNNING_D3D_FULL_SCREEN`
   as `focusAssist`, so a presentation or a game is never interrupted.

## Defaults chosen (yours to change)

- The volume starts at 30 %.
- Quiet hours run 23:00–07:00 and are switched on. They silence everything, approvals included.
- The chirps play with every core (A–E). On core E they match the bot's visible reaction.
- A session that starts working plays "think". This is the softest sound, and it has a 10 s
  cooldown per role.
- "job" means a delegation came back done, or a MINT AI turn of 20 s or more finished. A session
  finishing on its own plays "done" in its own voice.
- The approval chime plays even when the decision card is on screen. Approving or denying makes
  no sound; the bot only nods.

The Settings screenshots are `settings-sounds-dark.png` and `settings-sounds-light.png`, with
phone-width versions in `settings-sounds-dark-phone.png` and `settings-sounds-light-phone.png`.
