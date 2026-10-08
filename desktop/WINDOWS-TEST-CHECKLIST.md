# MINT AI for Windows — test checklist (on a real laptop)

Nothing below could be run on the Linux build box. Tick each; note the Windows version (`winver`), the
GPU, and the scale (Settings ▸ Display) of each monitor. Prerequisite: the server changes are deployed
(the app shows https://os.mint-stack.com/mint-ai?shell=desktop) and the feed is in /desktop/.

## 1. Install and trust
- [ ] Download the installer and `mint-desktop-codesign.cer` from https://os.mint-stack.com/desktop/.
- [ ] Import the certificate (PowerShell as admin, both stores — see README "Trusting").
- [ ] Installer ▸ Properties ▸ Digital Signatures: "Mint OS Desktop (self-signed)", signature OK.
- [ ] Run the installer: no admin prompt (per-user); SmartScreen: note whether it warns.
- [ ] MINT AI starts: Floating, bottom right of the primary monitor; tray icon (round Mesh) present; no taskbar button.
- [ ] Start menu ▸ "MINT AI" exists; starting it again does not open a second copy (it shows the running one).
- [ ] Sign out of Windows and back in: it starts with Windows (Settings ▸ Start with Windows on).
- [ ] Uninstall (Settings ▸ Apps): app gone, tray gone, autostart entry gone.

## 2. Sign-in
- [ ] First start shows the sign-in card floating (grey still core above it), not a white page.
- [ ] Password, then **Windows Hello inside the app**: does the Windows Security prompt appear? (the spike question) → it lands on the Command Center desktop mode.
- [ ] If Hello does not appear: "Windows Hello does not show? Sign in in your browser" → browser opens /desktop/link → sign in there → Link → the browser tab says "you can close this tab" → the app is signed in.
- [ ] mint-ai.os ▸ Devices lists "MINT AI desktop app on Windows".
- [ ] Settings ▸ General ▸ Desktop app shows 14 days. (Optional: set 1 day, check the app asks again next day; set back to 14.)
- [ ] Tray ▸ Sign out → sign-in card; tray item reads "Sign in with Windows Hello".

## 3. Floating
- [ ] Core, session spheres with names, state pill, composer are drawn with **no window frame or background**; the wallpaper shows between them.
- [ ] Click-through: click the desktop/icons/windows through every empty part of the box (including inside the box, between spheres); clicks land on what is underneath.
- [ ] The core, a sphere's name, the composer, the bubbles and the card catch clicks; typing in the composer works; Enter sends.
- [ ] Drag the core: the box moves; let go: it snaps to the nearest corner (try all four, and onto a second monitor).
- [ ] Hover tools (top right of the box): Focus, Size S/M/L cycles, Hide (Ctrl+Alt+M brings it back).
- [ ] Opacity (Settings): 35 % – 100 % applies at once, remembered per monitor.
- [ ] An approval card appears **above** the box (never over the core); Approve once / Always allow / Deny work.
- [ ] Stays on top of a maximised window; a full-screen video: the core holds still (GPU in Task Manager drops).

## 4. Peek
- [ ] Tray ▸ "Hidden until called (peek)": the layer disappears.
- [ ] Ctrl+Alt+M: it fades in centred on the monitor **under the mouse**, light dim behind it, composer focused.
- [ ] Esc hides it; a click on empty space hides it; Ctrl+Alt+M again hides it.

## 5. Desktop layer
- [ ] Tray ▸ "On the desktop": the core sits on the wallpaper at the right; **every other window covers it**; it never takes the focus.
- [ ] Win+D (show desktop): it is still there and **usable** (type in the composer); click any app: it goes back under the windows.
- [ ] Desktop icons stay clickable wherever MINT AI draws nothing.
- [ ] Settings ▸ Desktop layer position Left / Centre / Right.
- [ ] Ctrl+Alt+M raises it on top; Esc lowers it.
- [ ] Experimental: Settings ▸ "behind the icons" on → it goes behind the icons (nothing clickable); off → back. Note the Windows build if it fails.

## 6. Hotkeys and voice
- [ ] **Hold Ctrl+Space**: state pill "Listening", core listens; speak; **release**: the turn is sent, core thinks then speaks the answer.
- [ ] Words appear as a bubble while/after you speak.
- [ ] Press Ctrl+Space while MINT AI speaks: it stops at once and listens.
- [ ] A quick tap (< 0.2 s) does nothing.
- [ ] Talk again within a minute: starts instantly (warm call); after ~60 s idle the call hangs up by itself (server log: "ptt-idle").
- [ ] With Peek hidden, holding Ctrl+Space opens Peek and talks.
- [ ] In VS Code (Ctrl+Space = suggestions) — note the conflict; Settings ▸ Talk → Ctrl+Alt+Space works; reset.
- [ ] If another app already holds Ctrl+Space: a notification says MINT AI uses Ctrl+Alt+Space.
- [ ] Tap the mic (no hold): a normal hands-free live call starts; mute / end as on the web. Hold the mic: hold-to-talk.
- [ ] First use asks no microphone prompt (granted to os.mint-stack.com only); Windows' privacy indicator shows the mic only while talking.
- [ ] Ctrl+Alt+F: focus mode (only the core); again: back.
- [ ] Remap all three in Settings; the old keys stop working, the new ones work; duplicates are refused.

## 7. Toasts and tray
- [ ] Desktop layer covered by a window, a session asks for approval: a Windows toast "… needs you" with **Open** and **Deny** (no Approve).
- [ ] Open: MINT AI comes up with the card. Deny: the approval is denied (the card and the Command Center say "Denied").
- [ ] Floating visible: no toast for the same event. Peek hidden: toast. Focus mode: toast.
- [ ] Tray ▸ Do not disturb: no toasts; the tray dot still turns amber.
- [ ] Tray dot: green listening/speaking, violet thinking/delegating, amber needs you, grey offline/signed out; tooltip says the state and sessions.
- [ ] Tray menu items all work: Show, Talk, the three modes, Focus, Monitor (with 2 monitors), Do not disturb, Open the full Command Center (opens the browser), Settings…, Sign out, Quit.

## 8. Several monitors and DPI
- [ ] Two monitors at different scales (100 % and 150 %): Floating is the same physical size relative to text on each; dragging it to the other monitor snaps to that monitor's corner.
- [ ] Tray ▸ Monitor picks the other monitor; unplug it: MINT AI moves back to the primary.
- [ ] Change the scale of a monitor while running: it re-places itself.
- [ ] Click-through is exact on both monitors (the edges of the composer, the core's circle).

## 9. Ink, battery, offline
- [ ] Dark wallpaper: light text on dark pills. Light wallpaper: dark text on light pills. Change the wallpaper: within ~30 s the ink follows.
- [ ] On battery with Battery saver on (or Windows energy saver): the core holds still; plugged in: it moves.
- [ ] Lock the screen: the core stops (GPU idle); unlock: it resumes.
- [ ] Turn Wi-Fi off: "MINT AI is not reachable" under a dimmed core; on again: it reconnects by itself.
- [ ] Start the app with Wi-Fi off: the "Offline — retrying in N s" card; Retry now works.
- [ ] Measure: Task Manager ▸ GPU for MINT AI's WebView2 idle (Floating, Desktop layer), note % on each laptop.

## 10. Updates
- [ ] Publish a 0.1.1 feed (`build-windows.sh --feed`, bump the version): within 6 h or Settings ▸ Check for updates now, a notification; tray ▸ "Update to 0.1.1 and restart" installs and restarts.
- [ ] A feed whose signature does not match is refused (rename a .sig) — the app says it could not update.

## 11. Security spot checks
- [ ] A link to another site inside the Command Center opens in the browser, never in the app.
- [ ] `%APPDATA%\com.mint-stack.mint-desktop\settings.json` holds no password, token or key.
- [ ] The installer and `MINT AI.exe` are both signed (Properties ▸ Digital Signatures).

## 12. Laptop control ("This computer", Path A)
Prerequisite: the server side (Mint OS ▸ Machines, `/machines/api/claim`, `/machines/api/link`) is deployed;
Claude Code is installed on the laptop and signed in once (`claude` in a terminal).

Pairing
- [ ] Settings ▸ This computer reads "Not linked."; the name field is pre-filled with the computer name.
- [ ] Mint OS shows a code; type it as `abcd-efgh` (lower case, with the dash) ▸ Link → "Linked as <name> to os.mint-stack.com · online" within ~2 s.
- [ ] A wrong code / an expired code / several quick wrong tries: the messages for 404 / 410 / 429.
- [ ] Credential Manager (Control Panel ▸ Credential Manager ▸ Windows Credentials ▸ Generic): "MINT AI machine token (os.mint-stack.com)" exists. `settings.json`, the app log and the Settings page hold no token.
- [ ] Quit and restart the app: it comes back linked and online without asking.
- [ ] Revoke the computer in Mint OS: within seconds the app reads "Not linked" and the credential is gone.
- [ ] Unlink (press twice) in Settings: credential gone, Mint OS shows it offline.
- [ ] Wi-Fi off: "offline, reconnecting"; on: online again within 2–60 s (backoff). A corporate TLS proxy, if any: the link uses the Windows trust store.

Claude Code
- [ ] Settings ▸ Claude Code shows the path (`%USERPROFILE%\.local\bin\claude.exe` for the native install, or npm's) and the version; note whether Git Bash was found.
- [ ] Rename claude.exe away ▸ Look again → "Not found — install Claude Code…"; put it back ▸ Look again.
- [ ] npm install only (`npm i -g @anthropic-ai/claude-code`): found as `…\npm\claude.cmd`; a session starts (the app runs `node …\cli.js` directly; if cli.js is not there it runs the .cmd — check that the long --mcp-config / --append-system-prompt arguments get through).
- [ ] No Git Bash installed: a session still starts (CLAUDE_CODE_USE_POWERSHELL_TOOL=1).
- [ ] The CLI answers the `initialize` control request (a session that never says "running" means this CLI version does not).

A session
- [ ] Ask MINT AI to take over the laptop: a glowing green frame round **every** monitor, the pill at the top centre of the primary one ("MINT AI is controlling · mm:ss left · +15 min · Stop · Ctrl+Alt+Esc"); the time counts down.
- [ ] The frame never takes a click (click and type through it everywhere, edges included); the pill's buttons take clicks **without** taking the focus from the window in front (type in Notepad, click +15 min, keep typing: the text still goes to Notepad).
- [ ] Win+Shift+S / Snipping Tool / a Teams screen share: the frame and the pill are **not** in the capture.
- [ ] Task Manager ▸ Details: `claude.exe` (or node.exe) runs under MINT AI.exe, no console window appears.
- [ ] The first message arrives; a tool that needs approval (e.g. a PowerShell command) shows a card in Mint OS; Approve → it runs; Deny → Claude says it was denied and does not retry. Leave a card 10 min: it is denied by itself.
- [ ] "Make a Word document with …": the .docx lands in `Documents\MINT AI`. The action log in Mint OS lists the steps (no screenshots yet: the screen hands are not in this build).
- [ ] The final text of each turn reaches MINT AI; a follow-up from MINT AI ("tell") reaches the same session.
- [ ] +15 min: the time jumps by 15 min (never past 60 min from now); Mint OS shows the new expiry.

Every way it must stop (each time: frame and pill vanish at once, claude.exe and all its children are gone within a second, Mint OS shows the lease ended with this reason)
- [ ] Ctrl+Alt+Esc (stop-hotkey), also while another app is in front and while a tool is running.
- [ ] The pill's Stop (pill-stop).
- [ ] Let it run out (timeout).
- [ ] Win+L (locked).
- [ ] Wi-Fi off for more than 30 s (link-lost; Mint OS learns of it after the reconnect). Off for less than 30 s: the session goes on, but open approval questions are denied.
- [ ] Stop from Mint OS (server); revoke from Mint OS (unlinked).
- [ ] Tray ▸ Quit (app-exit); end MINT AI.exe in Task Manager: claude.exe dies with it (the Job Object).
- [ ] Sign out of Windows / restart during a session (signout): nothing of the session survives.
- [ ] Unlink in Settings during a session (unlinked).
- [ ] A second takeover while one runs: Mint OS says "already under control".

Stop key
- [ ] Another app holding Ctrl+Alt+Esc: a toast says Ctrl+Alt+Shift+Esc is used, and it works.
- [ ] Remap the stop key in Settings ▸ Save (Default puts it back); Esc only with Ctrl+Alt; it may not equal another MINT AI hotkey. (The current stop key cannot be recorded in its own box: the app holds it.)
