# MINT AI for Windows (the desktop app)

The Command Center without its page: the MINT AI core, the session spheres, the chat, the voice and the
approval cards straight on the Windows desktop. Design (approved 2026-10-07):
`MONI_AI_OS/mockups/desktop-app/DESIGN.md` and its mockup.

It is a small Tauri 2 app (WebView2, about 10 MB) around **the site's own page**: one transparent,
frameless window shows `https://os.mint-stack.com/mint-ai?shell=desktop`, the Command Center's desktop
render mode (`dashboard/lib/views-moniai.js`, `dashboard/public/mint-desktop*.{js,css}`). Every fix to the
Command Center reaches the app without a new release. Sign-in is the site's: password, then Windows Hello.

## What the app adds (src-tauri/src)

| File | What |
|---|---|
| `lib.rs` | The window, the three modes, tray and menu, hotkeys, toasts, the click-through and environment loops, updates, the commands the page may call |
| `layout.rs` | Window geometry per mode, size (S/M/L), corner, monitor and DPI; corner snapping after a drag |
| `hit.rs` | Per-pixel click-through: is the cursor on a region the page reported (rounded rectangles / circles)? |
| `settings.rs` | The app's settings file (`%APPDATA%\com.mint-stack.mint-desktop\settings.json`), hotkey validation |
| `policy.rs` | When a toast is shown (only when MINT AI cannot be seen; never in Do not disturb), the tray dot, when the core holds still |
| `signin.rs` | "Sign in in your browser": PKCE verifier/challenge and the loopback listener for the one-time code |
| `platform.rs` | Windows only: what is in front, full-screen apps, power, lock screen, wallpaper brightness (ink), the WorkerW layer |
| `trayicon.rs` | The tray icon's status dot |
| `site.rs` | The user agent (`… MintDesktop/<version>`) and the "stay on the site" rule |
| `capabilities/remote.json` | The **only** commands the site may call: hit regions, status, needs-you toast, hide Peek, drag, the box's tools, open the full Command Center, start the browser sign-in, events. Nothing that runs a program, reads a file or changes settings |
| `capabilities/local.json` | The app's own pages (`dist/`): the connecting/offline card and the Settings window |

`dist/index.html` is the first thing the window shows: "Connecting…" / "Offline — retrying in N s"; it
goes to the site as soon as the site answers (nothing typed is queued while offline).
`dist/settings.html` is the Settings window (tray ▸ Settings…).

### Modes

- **Floating** (default): a 480 × 580 box (S/M/L) in a corner, above every window, with 280 px of
  transparent headroom for a decision card. Drag the core to move it; it snaps to the nearest corner of
  the monitor it was dropped on. Its hover tools: drag, focus, size, hide.
- **Peek**: hidden until called (Ctrl+Alt+M, the tray, a toast's Open, holding the talk key), then over
  everything on the monitor under the mouse, with the composer focused and a light dim; Esc or a click on
  empty space hides it.
- **Desktop layer**: the whole work area at the **bottom** of the window stack (above the icons, below every
  window; Tauri's always-on-bottom keeps `HWND_BOTTOM`). While the desktop itself has the focus (Win+D, a
  click on the wallpaper) it comes up on top so it can be used, and goes back down when another window is
  focused. Ctrl+Alt+M raises it on top for a moment. **Experimental (off):** behind the icons (WorkerW) —
  no clicks reach it there.
- **Focus mode** (Ctrl+Alt+F): only the core.

Click-through: the page reports its interactive parts ~10× a second when they change (`set_hit_regions`);
a loop checks the cursor 30× a second and switches the window between catching and passing the mouse.

### Hotkeys (Settings ▸ Hotkeys, remappable)

Hold **Ctrl+Space** to talk (hold-to-talk on the live call; released = sent), **Ctrl+Alt+M** show/hide,
**Ctrl+Alt+F** focus mode, **Esc** (only while MINT AI has the focus) hides Peek or ends a call.
If Ctrl+Space is taken by another app the talk key falls back to **Ctrl+Alt+Space** and a notification says so.

## Laptop control ("This computer", Path A — `src-tauri/src/machine/`)

The app can be MINT AI's **machine agent**. Settings ▸ This computer pairs it with Mint OS once: a one-time
code (8 Crockford characters, `ABCD-EFGH`, 10 min) → `POST {origin}/machines/api/claim`
`{code, name, platform:"windows", app_version}` → `{machine_id, name, token}`. The token lives **only** in
Windows Credential Manager (generic credential "MINT AI machine token (<host>)", local machine) — never in
settings.json, the log or the repo. The app then keeps one outbound WebSocket
`wss://<host>/machines/api/link` (`Authorization: Bearer <token>`; no inbound port): reconnects 2 s → 60 s,
lost after 60 s silence (the server pings every 10 s); a 401/403 on the upgrade or `{t:"revoked"}` deletes
the token.

| File | What |
|---|---|
| `machine/mod.rs` | The controller: link messages, start / stop, questions → cards, the hands' Host, the Settings and pill commands, the lib.rs hooks |
| `machine/lease.rs` | The lease (pure): start / extend (≤ now + 60 min) / end (idempotent) / tick |
| `machine/wire.rs` | The messages (pure), ISO times, pairing-code and slug checks |
| `machine/claude.rs` | Claude Code (pure): where claude.exe is, the arguments, the MCP config, the stream-json conversation |
| `machine/prompt.rs` | The rules appended to the CLI's system prompt (pure) |
| `machine/mcp_http.rs` | The hands as MCP over HTTP on 127.0.0.1 (a new 256-bit bearer per lease; parse / auth / dispatch pure) |
| `machine/runner.rs` | The CLI process: no console, in a Job Object (KILL_ON_JOB_CLOSE) |
| `machine/link.rs` | The WebSocket thread (tungstenite + rustls, the Windows trust store) |
| `machine/overlay.rs` | The glowing frame per monitor (`dist/overlay.*`, click-through) and the pill (`dist/pill.*`), both excluded from capture |
| `machine/cred.rs` | Credential Manager |

**A session.** The server sends `start {slug, name, purpose, model, first_prompt, lease:{id, minutes, expires_at}}`.
The app starts the lease (minutes preferred over expires_at: a laptop clock that is off cannot shorten it),
shows the frame and pill, serves the hands (`crate::hands`) on loopback and runs Claude Code headless as
`moni-ai/bin/mint-session` runs a hired session: `-p --input-format stream-json --output-format stream-json
--verbose -n <name> [--model] --permission-mode default --permission-prompt-tool stdio --session-id <uuid>
--strict-mcp-config --mcp-config <only mint-hands> --allowedTools <the hands' tools> --add-dir Desktop,
Downloads, Pictures --append-system-prompt <rules>`, cwd Documents, files in Documents\MINT AI; never
bypassPermissions or --dangerously-*. Git Bash missing → `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`. An npm
`claude.cmd` is run as `node …\cli.js`. The user signs in to Claude Code themselves; the app never touches
those credentials.
Every `can_use_tool` becomes `{t:"ask", origin:"cli"}` (denied at once without a lease or link; 10 min
timeout); the hands' own approvals are `origin:"hands"`; `result` → `{t:"report"}`; every non-hands tool →
`{t:"action"}`. app → server also: `hello {app_version, platform, host, user, home, claude}`, `lease`,
`cancel`, `session`. Messages queued while the link is down (except questions) go after the next `hello`.

**It stops** — the CLI's whole process tree killed at once, the MCP server closed, open questions denied,
frame and pill gone, `lease ended` sent — on: the local stop key (default **Ctrl+Alt+Esc**, fallback
Ctrl+Alt+Shift+Esc, Settings ▸ This computer, handled in the app with no server round trip), the pill's Stop,
the expiry, the lock screen, sign-out / shutdown / app exit (and if the app dies, the Job Object takes the
CLI with it), the link down for 30 s, the server's `stop` / `revoked`, unlinking, the CLI exiting. A second
`start` while one runs is answered `session failed "already under control"`. **The site cannot start any of
this**: nothing machine_* is in `capabilities/remote.json`; the Settings commands are in `local.json`, the
pill's three in `overlay.json` (window `mint-pill` only).

Not in this build: the screen / mouse / keyboard / UIA / browser hands (`hands::tool_defs()` offers only
create_document, wait, request_approval), so the action log has no screenshots yet.

## Server side (dashboard)

- `/mint-ai?shell=desktop` — the render mode. `lib/views-moniai.js` (`shell: "desktop"`),
  `public/mint-desktop-layout.js` (the layouts, shared with the tests), `public/mint-desktop.js` (layout,
  bubbles, hit regions, bridge), `public/mint-desktop.css`. Hooks in `moni-ai.js` (`DESK`: core placement,
  recent turns, deny from a toast, hold-to-talk) and `cc-map.js` (`layoutOverride`).
- Hold-to-talk: `lib/voice-live.js` turn mode `"ptt"` (no server VAD; the key's press clears the input and
  stops the voice, its release commits the turn; the committed item goes through the same guard and
  hand-off path; a slip under 200 ms is not a turn; a warm call with no press for 3 min ends). The page
  (`public/voice-live.js` `press/release`, `moni-ai.js` `pttPress/pttRelease`) keeps the call warm for 60 s
  after the last release. Only the desktop page asks for it; the web Command Center is unchanged.
- `lib/desktop.js` — app sessions last **14 days** from sign-in (Settings ▸ General ▸ Desktop app, 1–90),
  the browser hand-off (`/desktop/link`, `/desktop/redeem`; one-time code, 2 min, bound to the app's
  PKCE challenge), the update feed (`/desktop/latest.json`, `/desktop/files/<name>`, public; `/desktop/` the
  download page, signed in). The app's user agent only changes the look and the session length.
- Sign-in pages in the app (`lib/views.js` `desktop`): a floating card, the grey still core, "Sign in in
  your browser".

## Building (Linux → Windows)

All user space, nothing installed system-wide:

```
# once: Rust + the Windows target, cargo-xwin, tauri-cli
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target x86_64-pc-windows-msvc
cargo install --locked cargo-xwin tauri-cli@^2
# once: clang/lld/llvm, NSIS, osslsigncode from Ubuntu packages, extracted (not installed)
mkdir -p ~/.local/wintools/debs && cd ~/.local/wintools/debs
apt-get download nsis nsis-common clang-18 lld-18 llvm-18 llvm-18-linker-tools libclang-common-18-dev osslsigncode
for d in *.deb; do dpkg -x "$d" ../root; done
# then link clang-cl/lld-link/llvm-lib/llvm-rc into ~/.local/wintools/bin and wrap makensis with
# NSISDIR=~/.local/wintools/root/usr/share/nsis (see the box's ~/.local/wintools/bin)

desktop/tools/build-windows.sh --feed /tmp/mint-feed      # signed installer + update feed
node desktop/tools/test-feed.cjs                          # the feed tool
(cd desktop/core-tests && cargo test)                     # the app's pure modules (80 tests)
```

The installer: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/MINT AI_<version>_x64-setup.exe`
(per-user install, no admin; WebView2 is part of Windows 10/11, the bootstrapper fetches it if missing).

### Keys (never in the repo)

`~/.local/mint-desktop-keys/` (0700) on the build box:

- `updater.key` + `updater.password` — the updater's minisign key. Its public half is in
  `tauri.conf.json` (`plugins.updater.pubkey`); the app refuses an update not signed with it. **Losing it
  means installed apps can no longer be updated** (they would need a manual reinstall with a new key).
- `codesign.pfx` + `codesign.password` (+ `codesign.key`, `codesign.crt`) — the self-signed code-signing
  certificate "Mint OS Desktop (self-signed)", 5 years; `mint-desktop-codesign.cer` is its public part.

### Trusting the self-signed certificate (once per computer)

On each of your machines, PowerShell **as administrator**, in the folder with the `.cer`
(also on https://os.mint-stack.com/desktop/):

```
Import-Certificate -FilePath .\mint-desktop-codesign.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
Import-Certificate -FilePath .\mint-desktop-codesign.cer -CertStoreLocation Cert:\LocalMachine\Root
```

Check: right-click the installer ▸ Properties ▸ Digital Signatures ▸ "Mint OS Desktop (self-signed)" ▸
Details: "This digital signature is OK". SmartScreen may still warn the first time on a machine (it is
reputation based): More info ▸ Run anyway.

To remove the trust later: `certlm.msc` ▸ Trusted Root Certification Authorities and Trusted Publishers ▸
delete "Mint OS Desktop (self-signed)".

### Swapping in a real certificate later

`tools/sign.sh` signs with whatever PKCS#12 `MINT_SIGN_PFX` points at. For an OV certificate in a .pfx:
put it in the keys folder as `codesign.pfx` (+ `codesign.password`) and rebuild. For a hardware token or
**Azure Trusted Signing**, replace the `osslsigncode` call in `tools/sign.sh` with the vendor's signer
(Azure: `jsign --storetype TRUSTEDSIGNING …` works from Linux), keeping the same one-argument interface.
Nothing in the app or the update key changes; installed apps update normally (the updater checks the
minisign signature, not the Authenticode one).

## Deploying (server)

1. Merge the branch; run the dashboard's suites.
2. `deploy/deploy-dashboard.sh` — only the dashboard restarts (live calls drop and reconnect).
3. The feed: copy the `--feed` folder to `/var/lib/moni-dashboard/desktop/` (owned by the dashboard's
   user): `latest.json` and `files/`.
4. No database migration: one new setting row (`desktop_session_days`) appears when changed.

## Limits and what is not verified yet

- Built and unit-tested on Linux only (`core-tests`: 80 tests of the pure modules; the dashboard's
  `test-desktop-shell.cjs` renders the page in headless Chromium). Everything Windows-specific —
  transparency and WebGL in WebView2, click-through, always-on-bottom and Win+D, WorkerW, global
  hotkeys and key-up, toasts, Windows Hello inside WebView2, DPI, the installer — is on
  `WINDOWS-TEST-CHECKLIST.md`.
- Settings `origin` exists for a test server, but the page's bridge (capabilities/remote.json) is granted
  to https://os.mint-stack.com only; another origin loads without the bridge (no click-through info,
  no hotkeys into the page).
- Acrylic (real blur) is not built (the design chose tinted pills). Arabic/RTL and screen-reader
  behaviour of the desktop mode are not designed yet (as in the design).
- The talk key's release is Windows' `GetAsyncKeyState` poll (global-hotkey, every 50 ms) on the main
  key; releasing only Ctrl while still holding Space keeps talking until Space is released.
