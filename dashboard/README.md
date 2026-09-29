# Dashboard

The web panel. Node, server-rendered HTML, no client framework, no external
assets — the CSP blocks them, and a panel that can grant SSH access is the last
place to be pulling scripts off a CDN.

Architecture, security model and deployment: see the [repository README](../README.md)
and [docs/agents.md](../docs/agents.md).

## Layout

    server.js              routes, auth, sessions, CSRF
    lib/db.js              SQLite: admin account, pairing codes, devices, login log
    lib/priv.js            wrapper that shells out to the privileged helper
    lib/ui.js              shared page chrome and formatting
    lib/views.js           system pages (overview, keys, devices, audit)
    lib/views-agents.js    agent management pages
    lib/views-guide.js     the operator's manual, served from the panel
    lib/views-claude.js    Claude Code: memory, sessions, running processes
    lib/moniai.js          client for the MINT AI supervisor's unix socket
    lib/views-moniai.js    the MINT AI Command Center's frame
    lib/telegram.js        Bot API client, used only to validate configuration
    public/style.css       styles, and the light and dark palettes
    public/app.js          confirmations + live stat refresh + Running refresh + theme switch
    public/theme-init.js   applies the saved theme before first paint
    public/moni-ai.css     the Command Center's styles and HUD palette
    public/moni-ai.js      the Command Center: API, event stream, seed core, voice
    tools/test-*.cjs       standalone tests (node tools/test-claude.cjs)

    deploy/moni-helper             privileged helper -> /usr/local/sbin/
    deploy/moni-agent@.service     systemd template, one instance per agent
    deploy/moni-dashboard.service  systemd unit for this panel
    deploy/nginx-moni.conf         nginx site
    deploy/moni-proxy-params       shared proxy headers
    deploy/moni-sudoers            the single-command sudo rule
    deploy/fail2ban-*.conf         filter and jail

## Deploying a change

    sudo bash /opt/moni-ai-os/deploy/deploy-dashboard.sh

It syntax-checks every file before restarting. Doing it by hand instead, always
`node --check` first — a syntax error otherwise leaves the service in a restart
loop with the panel down.

## Where you land

`/` is not a page: it 302s to the signed-in role's default landing,
`rbac.landing()` -- `/mint-ai` for `moniai.use`, else `/os` (the OS overview,
the Machine core) for `os.view`, else `/agents/dashboard` for `agents.view`,
else `/account`. Sign-in and the brand link use the same function. The top
bar's tabs are MINT AI (`/mint-ai`), OS Dashboard (`/os`) and Agents Dashboard
(`/agents/dashboard`). Test: `tools/test-landing.cjs`.

## Claude Code pages

OS Dashboard > Claude Code: **Memory** (`/claude/memory`), **Sessions**
(`/claude/sessions`), **Running** (`/claude/running`). Permissions
`claude.memory.read|write`, `claude.sessions.view|manage`,
`claude.running.view|stop` -- in no stock role, so administrator-only until a
role is given them: transcripts hold client data and the panel faces the
internet.

All data comes from the helper's `cc-*` subcommands. Memory reads and writes go
through memlib, run by the claude-memory venv inside the helper, so the database
credentials in `/root/.claude-memory/db.env` never reach this process. Output is
redacted by the helper (its own rules plus memlib's) and again by
`priv.redactDeep`. Nothing is deleted: editing a fact supersedes it, forgetting
is memlib's soft delete, archiving a session moves it to
`<home>/.claude/archive/dashboard-archived/`. Rename and archive are refused
while a session runs; Stop sends SIGINT only to a pid registered in a
`sessions/<pid>.json` whose process is the claude binary, and SIGTERM only 10 s
after that. Every write is in the audit log with the panel user.

Known follow-up: the memory search service on 127.0.0.1:8765 takes no token, so
any local process can query it. Adding one is deliberately left for later.

## MINT AI API

MINT AI (formerly MONI AI, and before that MONI Bot) is one root Claude Code session that delegates
commands to every other session on the machine. It is run by its own
supervisor, `moni-ai.service`; the design, the approval gate and the traps are
in [`moni-ai/README.md`](../moni-ai/README.md). The panel's part is a JSON and
SSE API, and the Command Center page that consumes it (below). The old console
(`/console`) keeps working; only its label changed.

Permission `moniai.use`, in no stock role: it reaches a root session that can
message every session on the box. API routes answer in JSON, refusals too
(401 not signed in, 403 no permission or bad CSRF, 400 invalid, 409 refused
by the supervisor, 503 supervisor down, 504 no answer).

    GET  /mint-ai/api/overview             status + sessions + recent delegations + memory counts + csrf
    GET  /mint-ai/api/status               process, current turn and its steps, pending approvals, vitals, counts
    GET  /mint-ai/api/sessions             claude agents --json merged with the ledger
    GET  /mint-ai/api/memory               fact / chunk / session counts (cached 60 s)
    GET  /mint-ai/api/rc                   Remote Control state and session URL
    GET  /mint-ai/api/ledger/:table        delegations | inbound | approvals | turns | audit
                                           ?limit=&before_id=&status=
    GET  /mint-ai/api/events               Server-Sent Events; Last-Event-ID or ?since= resumes
    POST /mint-ai/api/send                 {text, target?}
    POST /mint-ai/api/interrupt
    POST /mint-ai/api/approvals/:id/approve   {note?}
    POST /mint-ai/api/approvals/:id/deny      {note?}
    POST /mint-ai/api/rc                   {enabled}
    POST /mint-ai/api/restart

Writes carry the CSRF token as `_csrf` in the JSON body or an `X-CSRF-Token`
header (`/overview` returns it). SSE event names are the supervisor's event
types (`turn`, `text`, `assistant`, `tool`, `steps`, `approval`,
`delegation`, `inbound`, `sessions`, `vitals`, `rc`, `proc`, …); `text` deltas
carry no id and are not replayed after a reconnect.

The panel reaches the supervisor over `/run/moni-ai/moni-ai.sock`
(`root:moniai 0660`). `moniadmin` is in the `moniai` group -- the deploy script
adds it, and it takes effect at the restart that follows. No sudo is involved;
the supervisor re-validates every request and audits every write with the
panel user (`/var/log/moni-ai/audit.log` and its ledger). The panel also logs
sends, approvals and restarts in its own login log.

`deploy-dashboard.sh` now tars the tree it replaces to
`/root/backups/moni-dashboard_<timestamp>.tgz` before syncing.

    POST /mint-ai/api/transcribe           {data: base64, mime?, vt?} -> {text}  (OpenAI transcription)
    POST /mint-ai/api/speak                {text, vt?, cat?} -> NDJSON PCM stream (Accept: application/x-ndjson),
                                           else audio/wav or 204            (OpenAI realtime voice)
    GET  /mint-ai/api/voice/usage          today's / this month's voice spend, by kind, and the last turn

Tests: `node dashboard/tools/test-moniai.cjs` (client and permission).

### The Command Center (`/mint-ai`)

The top bar's MINT AI tab opens it. Someone with `console.use` but not
`moniai.use` is sent on to `/console`. One screen, no page scroll at
1920×1080, 1600×900 and 1440×900 -- only its panels scroll:

- **Left rail** -- MINT AI Core (process, sessions, agents, memory, voice,
  guardrails), Talk to MINT, vitals rings (the supervisor's own vitals, which
  arrive on the stream every 5 s) and memory counts.
- **Centre** -- the seed core: one canvas, `requestAnimationFrame`, DPR-aware,
  paused while the tab is hidden, a still frame under reduced motion. Its
  satellites are the live sessions from `/sessions`, in their real state
  colours. States come from real events: *thinking* while a turn runs,
  *delegating* when a `delegation` event with status `sent` arrives (a bead of
  light runs down the root to that session), *listening* while the microphone
  records, *speaking* while a reply is read aloud. Below it the sessions strip
  (Delegate… prefills the composer for that session; Open says where it runs,
  and for MINT AI itself opens the Remote Control link) and the composer
  (target chip, `@` to pick, interrupt while a turn runs).
- **Drawer** -- Conversation (the turns ledger, then live: streamed text,
  delegation cards, approval cards), Timeline (delegations and approvals),
  Live feed (replies, idle notices, service and session events), and Current
  AI Activity from the turn's `steps`.
- **Approval cards** come from `approval` events: command, target, effect,
  reason, a countdown to the automatic deny, and Approve & run / Deny. While
  any is pending the status chip and the core's pill say *Awaiting approval*.
- **Voice** is OpenAI, used as a voice only (see *OpenAI voice* below): tap
  to talk (end of utterance from the level, barge-in over a reply), or hold
  Space. A spoken turn gets a spoken "On it." and its reply read aloud; the
  *replies aloud* chip reads every reply. The core pulses with the reply's
  real output level. Without a key the controls are off and say
  "Add an OpenAI key in Settings".

Everything is built in `public/moni-ai.js` from the API; the frame is
`lib/views-moniai.js`, the styles `public/moni-ai.css`. No inline script or
style (the CSP forbids both) and no external requests.

### OpenAI voice

Voice only: OpenAI hears the person and reads the replies aloud; Claude does
all the thinking. Everything goes through this server -- the browser never
talks to OpenAI and never sees the key (the CSP still forbids it to).

- **Hearing**: the recording (webm/opus) is posted to `/mint-ai/api/transcribe`
  or `/console/:id/transcribe`, and sent on to `POST /v1/audio/transcriptions`
  (`gpt-4o-mini-transcribe` by default), with a vocabulary prompt (Mint, MINT AI, Odoo,
  sessions, agents) so the panel's own words are spelled right.
- **Speaking**: each sentence of a reply is posted to `/mint-ai/api/speak` or
  `/console/:id/speak`. The Command Center asks for it **streamed**
  (`Accept: application/x-ndjson`): `start {engine}`, then `audio {pcm}` (PCM16
  mono 24 kHz, base64, whole samples) as OpenAI produces it, then `end` -- and
  plays it with Web Audio from the first chunk (a 60 ms lead, each chunk
  scheduled right after the last, one gain node per reading into the analyser
  that drives the seed core). The console still gets a whole WAV. `lib/voice.js` keeps
  WebSockets to `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini`
  (default; `gpt-realtime` and `gpt-live-1` on `/v1/live/sessions` are
  selectable) warm and reuses them, opening two as soon as a recording is
  transcribed. Each sentence is an **out-of-band** `response.create`
  (`conversation: "none"`, empty input, the text quoted in that response's
  instructions): put in as a user message, the real model *answers* it ("Hello,
  can you hear me?" -> "Yes, I can hear you loud and clear. How can I assist
  you today?"), which is why the first build spoke almost nothing. The page
  fetches the next sentences while one plays. Short lines ("On it.") are cached
  in memory per model and voice.
- **Verbatim guard, while streaming**: the model's own transcript of what it
  said is compared with the text word by word. Its transcript runs *ahead* of
  its audio (measured 2026-09-29: most of a sentence's words arrive before the
  first audio chunk, and the audio arrives several times faster than it
  plays), so the check runs on every transcript delta while the audio flows:
  once it holds more invented words than a faithful reading may, the reading
  is cut (`cut`), usually before that audio was even sent; at the end the full
  check (dropped words too) can still cut it, a fraction of a second into
  playback. On `cut` the page stops that sentence at once (a 12 ms fade, every
  scheduled chunk stopped) and drops what it held; the server cancels the
  realtime response (`response.cancel` with its id, whose usage is still
  counted) and **re-reads the whole sentence with `gpt-4o-mini-tts`**, streamed
  too (`stream_format: "sse"`, which also reports its usage), which cannot
  answer it. Only if that fails is the sentence skipped (`skipped`; 204 in the
  WAV form), its text still on screen, and the page says so. Measured
  2026-09-27: realtime-mini read about 88% of sentences verbatim out of band.
  Barge-in stops the stream playing and aborts the ones fetched ahead;
  sentences play strictly in order. Each call logs one key-free, text-free
  line to the journal: `voice speak 200 engine=... ms=... first_audio_ms=...
  warm=1 cuts=... audio_s=... words=... streamed=1 usd=...` or `voice transcribe
  200 model=... ms=... usd=...`.
- **The key**: Settings > Credentials > OpenAI voice (`/credentials/openai-voice`,
  permission `voice.manage`, in no stock role -- administrators only). Write-only
  field, shown as its last four characters, Replace, Remove and a Test button
  that speaks one line and transcribes it back. Model, voice and listening model
  selectors. Stored by the helper in `/var/lib/moni-voice/openai-voice.env`
  (root:root 0600, directory 0700) -- not the repo, not the database, not argv;
  set/clear/options are audited with the last four characters only. The panel
  reads it through `moni-helper voice-key-read` and keeps it in memory.
  This is a separate credential from the Odoo walkthrough's
  `/etc/odoo/openai_key`.

Piper (`/opt/moni-tts`) is gone. whisper.cpp stays: the Telegram agents'
voice-notes add-on runs its `whisper-cli` with `ggml-base.bin`
(`VOICE_PROVIDER=local`). `moni-whisper.service` (the resident server on
127.0.0.1:8081) stays installed too, though since this change nothing calls
it -- the panel was its only client.

Tests: `node dashboard/tools/test-voice.cjs` (mock OpenAI for both protocols
and transcription, the verbatim guard, the helper's key storage, the no-key
views). Needs `ws` on `NODE_PATH`.

### Voice front desk (GPT) -- trial, off by default

`lib/voice-desk.js`. Switched on by an administrator at Settings > Credentials >
OpenAI voice > *Voice front desk (GPT)* (`POST /credentials/openai-voice/desk`,
`voice.manage`, audited in the sign-in log; stored in the panel's `settings`
table, not with the key). While it is off nothing about the voice changes.
While on, the Command Center's mic posts each utterance to
`POST /mint-ai/api/desk/turn` (`moniai.use` + CSRF). The voice bar shows
**Front desk · GPT** or **Direct · MINT AI**.

gpt-realtime-mini holds the conversation, server-side, **in text**, with exactly
two tools: `read_status()` (the supervisor's read-only `snapshot` op: services,
disk, memory, sessions, active missions and steps, open decisions and pending
approvals as counts and titles, never a command; no live Odoo) and
`ask_moni(text)` (a normal `send`, `via: "voice-desk"`, as the panel user; the
administrator's own words go along when the desk paraphrases). It may make
brief small talk, never with a status claim in it. Enforcement: only those two
tools in the session; any other function call is refused; `deskOps()` opens for
`snapshot` and `send` only; and an output guard over the desk's own words.

**Sentence by sentence.** The desk answers in text; each sentence is released
as soon as the guard has passed it and is spoken by the ordinary verbatim
reader (`lib/voice.js`), so what is heard is exactly what was checked. The
route streams NDJSON: `heard`, then per sentence `line {i, text}` and its audio
as it is read -- `start` / `audio` / `cut` / `end` with the line's `i`,
strictly in line order (`createSpeaker` holds a later line's audio until the
one before it has ended) -- `asked`, and `done` with the turn's cost and the
usage figures. The guard judges each sentence with the ones before it (a
bare "Done." after an action sentence is a claim about that sentence; "it"
borrows its subject), and holds a sentence it cannot judge alone -- one that
mentions an action, a fragment, a hand-off whose `ask_moni` call is not known
yet -- until the next sentence or the end. So whatever a later sentence does,
it can only cut itself (property-tested over ~1,900 streamed texts).

It cuts: a claim that something was done/deleted/restarted/pushed/approved (or
is being: "Restarting Odoo."), a promise of one, a figure not in the snapshot /
MINT AI's reply / what was said, a status claim with no snapshot or about
something the snapshot does not hold, "MINT AI said ..." before a reply, and "I've
passed that on" (or "I'll read you its answer") with no `ask_moni` call behind
it. A cut reply is replaced by "Let me pass that to MINT AI." and the request
really is passed on. A transient OpenAI server error is retried once.

**Summaries.** MINT AI's answer to a desk request stays on screen exactly as
written; aloud, the page asks `POST /mint-ai/api/desk/summary {turn}` for a
short summary (an out-of-band response: no conversation, no tools, the reply
quoted). A reply of one or two plain sentences is read word for word instead
(`fallback: "verbatim"`). The summary is held to the reply: a figure changed
or rounded wrongly (2.7 may become 3, never 2), a negation flipped, a
recommendation MINT AI did not make, "I'll ask you first" turned into "done", a
name or a path it did not give, the desk saying "I did" -- each is cut, and the
rest becomes "The rest of MINT AI's answer is on screen." A pending approval or
question the summary left out is said anyway ("It needs your approval or your
answer."). MINT AI is told its reply will be summarised.

**Cost, on screen -- no cap.** The daily budget was removed (the
administrator's decision of 2026-09-29): nothing refuses or diverts the desk for
what it has spent. Instead every OpenAI call the voice makes is priced from the
usage OpenAI reports -- each desk response, each reading (a cancelled one
included), the text-to-speech fallback (`speech.audio.done`), each
transcription -- with the one price list in `lib/voice-usage.js` (OpenAI's
pricing page, read 2026-09-29), and written to the panel's `voice_usage` table
with its voice turn and kind: **small talk**, **snapshot** answers,
**hand-offs** (the request and, later, its summary), **direct** (the direct
path, front desk off), and transcription on its own line. The Command Center
shows it under *Cost today* (`GET /mint-ai/api/voice/usage`): today's and this
month's voice spend (Africa/Cairo) by kind, transcription, the total, and the
last turn's cost. Measured on the real API: small talk ~$0.0015 per utterance,
a snapshot answer ~$0.0022, a hand-off ~$0.0008 plus ~$0.0054 for the summary
(transcription, ~$0.0001-0.00025 per utterance, on top of each). Speech is 85-95% of
it; the desk's own text tokens are $0.0001-0.0005.
A kept conversation is replaced after 12 turns or 12k input tokens.

Tests: `node dashboard/tools/test-voice-desk.cjs` (mock realtime server with the
real event shapes, including out-of-band responses and `usage`; tools, the
supervisor door, the snapshot payload, the guard, sentence release and its
property, small talk, summaries, cost and the usage figures (Cairo day and
month boundaries), streamed speech in line order, session length).
`node dashboard/tools/test-voice-stream.cjs` runs the page's Voice module (cut
out of `public/moni-ai.js`) against a fake Web Audio clock: playback from the
first chunk, order, a clean cut and the fallback after it, barge-in during a
stream, the desk's streamed lines.
`node dashboard/tools/test-voice-guard.cjs` covers the guard between the
microphone and MINT AI (`lib/voice-guard.js`, `lib/voice-intake.js`): silence
is never transcribed (under 1,200 bytes, or measured by the page as under
300 ms or with under 150 ms above its speech threshold); a transcript that
echoes the transcription prompt, the desk's instructions or tool descriptions,
has more words than its audio could hold, or is a stock silence phrase on a
short or quiet clip is dropped ("didn't catch that"); a voice send
(`/mint-ai/api/send` with `vt`) must match what the server transcribed for that
voice turn, once; the desk's `ask_moni` and its supervisor door refuse
prompt-like text. Why: on 2026-09-29 a silent push-to-talk press came back from
gpt-4o-mini-transcribe as its own prompt and reached MONI AI as a turn (ledger
turn 92); prompted transcription models echo the prompt on silence.
`node dashboard/tools/test-voice-arabic.cjs` covers the same guards in Arabic
(`lib/voice-arabic.js`): Arabic-Indic and Eastern digits and Arabic number
words compared with the snapshot's figures, the Arabic and mixed claim,
promise, approval, negation (incl. ما…ش) and hedge rules with clitics and
spelling normalised, the fail-closed rules (a script other than Latin or
Arabic, an unknown past-tense result verb), the summary rules across the two
languages, the Arabic fixed lines, and the Arabic silence phrases and
subtitle credits on the transcript side. `ask_moni` sends the server's own
transcript of the turn, never the desk model's paraphrase (the paraphrase
cases are in test-voice-desk.cjs).
`sudo node dashboard/tools/eval-voice-desk.cjs --replies <copy.json> [--speak]
[--session]` runs ~25 prompts and summaries of MINT AI's real replies (from a
read-only copy of the ledger) against the real model with a stubbed supervisor
(nothing reaches MINT AI; the key is read through the helper and never
printed).

### Themes

System (the default), Dark and Light, from a switch in the top bar of every
page. `public/theme-init.js` applies the saved choice (localStorage
`moni-theme`, guarded) before first paint; `app.js` wires the switch; System
follows `prefers-color-scheme` live. The whole panel's palette is custom
properties in `style.css` -- the rules use tokens only (QR codes excepted,
which must stay white). The Command Center has its own HUD palette in
`moni-ai.css`, dark and light, which wins over the site's on this page.

Tests: `node dashboard/tools/test-moniai-page.cjs` (the page's frame, CSP
safety, escaping, the tab, the palette, the client's pure helpers).
