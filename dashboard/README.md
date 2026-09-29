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
a result / what was said, a status claim with no snapshot or about something
the snapshot does not hold, a finding ("I found ...", "I checked the logs",
«لقيت إن ...», «راجعت الـ logs») before any result has arrived, and "I'm
checking" / "give me a moment" / «ثانية أشوفلك» / "I'll tell you what I find"
when no request is being worked on (an `ask_moni` call in this response, or
one still in progress). A cut reply is replaced by "Give me a moment, I'm
looking into it." and the request really is worked on. A transient OpenAI
server error is retried once.

**One identity: the voice IS MINT AI** (the administrator, 2026-09-29: "you
are MINT AI; don't say you delegate to MINT AI; talk to me as MINT AI; you can
take time to think, and while you think build a report with me or just talk").
Relay desk, live conversation, summaries and every fixed line speak as MINT AI
in the first person. `ask_moni` stays (internally it is still the supervisor's
`send`); the live mode's tool is now named `look_into` (it was `ask_mint_ai`:
speaking as MINT AI, the audio model read that name aloud -- «هسأل MINT» --
and was cut as third-person), same handler. The instructions describe the tool
as the voice's own deeper work, which takes a while. The relay model, speaking as
MINT AI, often says "Give me a moment, I'm checking" and forgets the call
(gpt-realtime-mini, real API 2026-09-29): the guard stops the words, the server
starts the work in the administrator's own words, and then -- now true -- the
model's own words are said (`backedByServer`); a `read_status` call in the same
response backs "let me check" too. Pending: "Give me a moment, I'm
checking…" / «ثانية أشوفلك…» / «خليني أبص على الـ logs»; the result, when it
arrives, is summarised as "I found…" / «لقيت إن…» (the summariser is told the
reply is its own finished work). While waiting the voice may keep talking --
acknowledge, say in general terms what it is looking at, ask a clarifying
question, small talk, help draft or structure a report -- but never invents
progress, findings, results or finished actions. The guard adds a
`third-person` rule: "I've passed that to MINT AI", «تم تمرير الطلب لـ MINT AI»,
"MINT AI says / restarted …" are cut in the desk and in summaries ("I'm MINT
AI", «أنا صوت MINT AI», "MINT AI OS" and service names like `moni-agent@admin`
are not). "I restarted Odoo" / «عملت restart لأودو» is spoken only when a result
says it was done. Fixed lines, first person, gendered in Arabic by the persona
(feminine for Cairene feminine, masculine for Cairene masculine, neutral for
MSA or while unknown): "Give me a moment, I'm checking that." / «ثانية أشوفلك
الموضوع.»; "I'll tell you what I find." / «وهقولك على اللي ألاقيه.»; "I need
your approval or your answer." / «محتاجة / محتاج موافقتك أو ردك.» (neutral
«الموضوع محتاج موافقتك أو ردك.»); "The details are on screen." / «التفاصيل
قدامك على الشاشة.»; "Sorry, I didn't catch that." / «معلش، مسمعتش كويس.» when
there is nothing grounded to work on. It is always MINT AI's voice and never
claims to be human.

**Summaries.** MINT AI's answer to a desk request stays on screen exactly as
written; aloud, the page asks `POST /mint-ai/api/desk/summary {turn}` for a
short summary (an out-of-band response: no conversation, no tools, the reply
quoted). A reply of one or two plain sentences is read word for word instead
(`fallback: "verbatim"`). The summary is held to the reply: a figure changed
or rounded wrongly (2.7 may become 3, never 2), a negation flipped, a
recommendation MINT AI did not make, "I'll ask you first" turned into "done", a
name or a path it did not give, "I did" what the reply did not say was done,
MINT AI spoken of in the third person -- each is cut, and the rest becomes "The
rest is on screen." A pending approval or question the summary left out is said
anyway ("I need your approval or your answer."). MINT AI is told its reply will
be summarised.

**Language and persona** (`lib/voice-persona.js`, the administrator's decision
of 2026-09-29: "replies in my language and saves the persona based on how I
speak"). Each reply is in the language of the administrator's last utterance:
English gets English; Arabic, or Arabic mixed with English, gets Arabic with
technical terms kept in Latin script. In Arabic the register follows theirs
(Egyptian colloquial or MSA), and the voice's grammatical gender for itself
follows how they address it («تقدميني», «إنتِ مصرية» → feminine; «إنتَ»,
«إنت مصري» → masculine), gender-neutral phrasing until that is known. It is
always MINT AI's voice and never claims to be human. The register and the
gender are saved per user (`users.voice_persona`, JSON), change only when an
utterance clearly shows a change (at least two markers of one register and none
of the other; an unambiguous form of address), and each change is audited.
Settings > OpenAI voice > *Voice persona* shows it read-only with a **Reset**;
there is no free-text persona. The instruction for the language, register and
gender is sent with every response (`instructionsFor`); summaries and the
Arabic fixed lines follow it. The guard reads feminine and masculine Egyptian
forms (participles such as «أنا عاملة ده», «مشغّلاه», «أنا عامله»). Tests:
`test-voice-persona.cjs` (the real server from a scratch copy that cannot reach
the helper -- `tools/scratch-server.cjs` -- saving, carrying over, the audit,
Reset), and the persona and gender sections of `test-voice-arabic.cjs` and
`test-voice-desk.cjs`.

**A chosen persona** (the administrator, 2026-09-29: «البرسونا بتاعتك بنت
عربية مصرية من القاهرة»). Settings > OpenAI voice > *Voice persona* is a fixed
list, posted to `POST /credentials/openai-voice/persona` (voice.manage + CSRF,
audited with the old and new choice): **Learn from how I speak** (the default,
as above), **Cairene Egyptian -- feminine**, **Cairene Egyptian -- masculine**,
**Modern Standard Arabic -- neutral** (`voicePersona.PRESETS`). A choice is
stored as `{mode:"explicit", preset, dialect, gender, updated_at}`; an explicit
choice always wins and learning never changes it (`merge` returns it untouched).
Cairene feminine means Arabic replies in Cairo colloquial Egyptian with feminine
first-person forms -- the relay turn instructions, the live conversation's
instructions, the summary language, the safe lines and the approval line
(`linesFor("ar","f")`); English replies stay plain English, and it is still
MINT AI's voice, never claiming to be human. **Reset** (or picking *Learn from
how I speak*) clears the choice and returns to learning. Nothing sets a user's
value except that form.

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

### Live conversation (trial) -- off by default, administrators only

`lib/voice-live.js` (server), `public/voice-live.js` + `public/voice-live-worklet.js`
+ `public/voice-live.css` (page). M-3 Phase 1, option C of the full-duplex
proposal: you talk and the voice answers at once, and you can interrupt it --
while the voice model still never thinks or acts for MINT AI.

**The mode.** The front-desk setting is now three-way, in the same `settings`
row (`voice_desk`), so existing values keep their meaning: `"0"` off (direct),
`"1"` relay desk, `"live"` live conversation. Settings > OpenAI voice >
*Voice front desk* > *Live conversation (trial)* (`POST
/credentials/openai-voice/desk` with `mode=off|desk|live`; the older
`enabled=1|0` still works; audited). In live mode administrators (`moniai.use`
+ `voice.manage`) get a third choice in the Command Center's voice menu, *Live
conversation (trial)*; everyone else, and push to talk, keep the relay desk.

**How it works.** The page opens the mic with echo cancellation, noise
suppression and auto gain, and an AudioWorklet streams 24 kHz PCM16 in 20 ms
frames to `GET /mint-ai/api/live?csrf=…` (a WebSocket). The server relays it to
`gpt-realtime-2.1-mini` (server VAD at 700 ms of silence and threshold 0.7,
far-field noise reduction; `create_response` and `interrupt_response` off --
this server decides both, see *Self-hearing*)
with exactly two tools, `read_status` and `look_into`, dispatched only through
`deskOps()` (`snapshot` / `send`); any other tool name is refused. The key never
leaves the server.

- **Guard before sound.** Each audio chunk is tagged with the sentence the
  model's own transcript is in when the chunk arrives (the transcript leads the
  audio by 40-360 ms, so that is the chunk's sentence or a later one) and held
  until that sentence has passed the desk's guard (`Releaser` / `judge()`: the
  sentences before it, the Arabic rules, fail-closed). The last sentence is
  judged as soon as `response.output_audio_transcript.done` arrives (unless it
  mentions a hand-off, which waits for the function calls). On a cut the held
  audio is dropped, the response cancelled, the item truncated at what was
  sent, the request passed to MINT AI if it had not been, and the safe line
  read by the verbatim reader in the cut sentence's language (feminine /
  masculine / neutral from the saved persona).
- **MINT AI's answers never come from the speech model.** The server polls the
  supervisor's snapshot for the reply to a hand-off; the reply goes through the
  desk's guarded summary (`SUMMARY_INSTRUCTIONS` -> `judge()`) or, if short and
  plain, word for word, and each line is read by the verbatim reader into the
  same stream. The realtime conversation is then told (a system item) what MINT
  AI said and what was heard.
- **Hand-offs carry this server's transcript.** At the end of each utterance the
  server transcribes the audio it relayed (a full-turn gpt-4o-mini-transcribe)
  and sends that -- through the transcript guard -- never the model's `text`;
  the session's own transcription is the fallback. Measured on the mixed clip:
  the session transcript heard «ريكستور» / «ريكارك» for "restart", the full-turn
  one "restart" (twice out of two). At most one hand-off per utterance. Spoken,
  it is first person ("Give me a moment, I'm checking."), true only while the
  call is really in flight; «تم تمرير الطلب لـ MINT AI» and the like are cut
  (`third-person`, see *One identity*).
- **Barge-in.** When the administrator really talks over the voice (below),
  the server tells the page to flush (the playback worklet drops its buffer and
  answers with the millisecond it had played), cancels the response and
  truncates the item there (or at the page's last reported position after
  400 ms). Summaries being read stop too.
- **Self-hearing** (2026-09-29: on laptop speakers the voice heard itself and
  kept cutting itself off -- 13 phantom turns and 16 dropped empty turns in 6
  calls, each phantom a paid response). Four layers:
  1. *Echo-cancelled playback.* Chromium's echo canceller does not reliably
     cover Web Audio output. The player worklet now feeds a
     `MediaStreamDestination` -> a local `RTCPeerConnection` pair (loopback,
     never leaves the page; Opus 96 kbit/s) -> an unmuted `<audio>` element, so
     the canceller knows the audio and removes it from the mic. Falls back to
     `ctx.destination` if WebRTC is missing or does not connect in 3 s
     (`VoiceLive.route()`: `loopback` | `direct`, logged per call). The loopback's
     jitter-buffer delay (getStats) is taken off the played milliseconds, and
     on a flush the element is silenced for that delay so nothing buffered is heard.
  2. *Speakers mode* (half-duplex, **the default** until the loopback is proven
     on the administrator's laptop): while anything is audible and for 300 ms
     after, the server does not relay the mic at all. Interrupt with a tap on
     the bar's text, Space or the mute button (both interrupt while it speaks),
     or Esc (stops the voice first; a second Esc ends the call). *Headphones
     mode* (full duplex) is a toggle in the live bar (remembered per browser,
     `localStorage` `mint-live-duplex`) and the default in Settings > OpenAI
     voice > *Live conversation* (`POST /credentials/openai-voice/live-audio`,
     `duplex=speakers|full`, `noise=far_field|near_field|off`, audited; setting
     `voice_live_audio`). The bar shows which mode is on.
  3. *Guarded barge-in* (headphones mode). The VAD's `speech_started` while the
     voice is audible is only a candidate. It becomes a barge-in when the page's
     detector (`public/voice-live-detect.js`, the same code the tests drive)
     says `voice`: at least 400 ms of mic level within 800 ms above
     max(6 x noise floor + 0.01, 2 x output level x the measured leak), never in
     the first 600 ms of a playback segment (that is when the leak -- mic /
     output -- is measured; the noise floor is learned while nothing plays, and
     never from speech). Speech that stops first is not a barge-in. A turn over
     the voice that the detector missed but that passes the guard still
     interrupts (a late barge-in).
  4. *Echo guard before the answer.* `create_response` is off. A turn that
     started over (or within 1.5 s after) the voice and was not a confirmed
     barge-in is held for its transcript: empty, refused by the transcript guard,
     or one or two words -> `echo-leak`: no response is created (nothing paid),
     and its item is deleted while still the last one (the cached prefix
     survives). A real-length turn (>= 450 ms) nowhere near the voice is
     answered at once, as before. Two echo-leaks within 10 s in headphones mode
     make the page offer speakers mode (a small non-blocking prompt).
  Logged: each call's mode, playback route and noise reduction; barge-in
  candidates and confirmations with the ms into playback; phantom turns; mode
  switches; the end-of-call line counts barge-ins of candidates and phantoms.
  A `response.done` that arrives twice for one response is billed once (it had
  been: `voice_usage` rows 439/440, 462/463, 499/500, 535/536, +$0.0252 of
  the day's $0.2608 live total, 9.7%).
- **Also:** the echo guard (a transcript matching what the voice said in the
  last 30 s is dropped and the item deleted; over the voice, 70% of its words
  being the voice's is enough); the spoken stop command (`public/voice-stop.js`, English and Arabic,
  polite forms) ends the call; one call per user, at most 4 at once, 20 minutes
  a call, frames of at most half a second, no more than twice real time; the
  saved persona is in the instructions and refreshed when it changes.
- **Usage.** Every response's `usage` is priced (gpt-realtime-2.1-mini's list
  prices, read 2026-09-29) into `voice_usage` with category `live`, part
  `realtime`; transcriptions and the readings are their own rows. Shown as
  *Live* in the Cost today card.

**What cannot be guaranteed.** The guard reads the model's transcript of its
audio, not the audio itself; audio that differs from its own transcript would
be heard. MINT AI's answers never take that path.

**Self-hearing, measured (2026-09-29, real API, stubbed supervisor, same clips,
6aeca3c vs this change).** First audio after the end of speech: English 1.42 ->
1.16 s, Egyptian 1.79 -> 1.93 s, mixed (a guard cut and hand-off) 2.92 -> 3.34 s --
no added latency, the fast path answers clean turns at once (waiting for every
transcript had cost +0.7-0.85 s: 2.15 / 2.64 s). Barge-in with a choppy "Wait,
stop, never mind" over the voice (headphones mode): VAD candidate after
209-235 ms as before, flush 640 ms after the talking-over began (was 184-197 ms
with no guard). Speakers mode interrupts on a tap at once. Measurement cost $0.17.

**Measured (2026-09-29, real API, stubbed supervisor, TTS clips).** End of
speech to the first audio the page plays, including the 700 ms VAD, a
`read_status` round trip and the hold: English 1.0 s, Egyptian 1.75 s, mixed
1.46 s. Hold per chunk: median 186 ms, p90 463 ms. Barge-in: the upstream VAD
reported speech 183-191 ms after the talking-over began (286-636 ms while a
reader line played); the flush reaches the page at once after that. Cost:
$0.004-0.011 per turn (Arabic answers run longer), about $0.03 a conversation
minute: ~$0.55 for 20 minutes a day, ~$1.7 for 60.

**nginx.** No change is needed: `/etc/nginx/moni-proxy-params` (both the `:8443`
and the `os.mint-stack.com` vhosts) already sends `proxy_http_version 1.1`,
`Upgrade $http_upgrade` and `Connection "upgrade"`. Its `proxy_read_timeout 60s`
would cut a quiet call; the server pings every 15 s, which keeps it open. If a
longer idle is ever wanted, the location to add (before `location /`) is:

```nginx
location = /mint-ai/api/live {
    proxy_pass http://127.0.0.1:3000;
    include /etc/nginx/moni-proxy-params;
    proxy_read_timeout 1300s;   # a 20-minute call and a margin
    proxy_send_timeout 1300s;
    proxy_buffering off;
}
```

**Integration contract** (for any page, e.g. the Mint rebuild). Load
`voice-live.css`, `voice-live-detect.js` and `voice-live.js` (in that order,
before the page's own script); render `data-voice-live="1"` when the server's
`voicePublic(req).live` is true, `data-live-worklet="${asset("voice-live-worklet.js")}"`
and `data-live-duplex="${voicePublic(req).liveDuplex}"` (the Settings default); then:

```js
if (window.VoiceLive && VoiceLive.supported() && root.getAttribute("data-voice-live") === "1") {
  VoiceLive.start({
    csrf: root.getAttribute("data-csrf"),
    worklet: root.getAttribute("data-live-worklet"),
    duplex: "speakers",   // or "full" (headphones); this browser's choice, else data-live-duplex
    onState: (s) => {},   // connecting | listening | talking | thinking | speaking | interrupted | waiting | muted | ended | error
    onCaption: (c) => {}, // {who: "you" | "desk" | "mint", text, final}
    onLevel: (l) => {},   // {mic, out}, 0..1-ish
    onEvent: (m) => {},   // every server message: ready {model, voice, duplex, noise}, asked, replied, stop, ended,
                          // error (code "busy": another tab), duplex {mode}, suggest {mode: "speakers"} (offer it)
  }).catch((e) => {});    // refused, no mic, or the call could not connect
}
VoiceLive.stop();          // hang up
VoiceLive.mute(true);      // hard mute; VoiceLive.muted(), .active(), .state()
VoiceLive.interrupt();     // stop the voice now (tap / Space / Esc); false if it was not speaking
VoiceLive.duplex("full");  // switch mode mid-call; .speaking(), .route() ("loopback" | "direct")
```

Map `listening`/`talking`/`interrupted` to the core's *listening*, `thinking`
to *thinking*, `speaking` to *speaking* (the caption: `onCaption` text of
`who !== "you"`, word by word), `waiting` to *delegating* (to MINT AI); flash
the voice bar on `interrupted`; feed `onLevel` to the core's amplitude. While
live is the mode, Space starts a call, then mutes and unmutes it, and Esc ends it;
while the voice speaks, Space (speakers mode) and Esc interrupt it instead, and
the hint row says so. `#cc-live-duplex` (in `#cc-live-acts`, before mute) shows
and switches the mode; its label goes at ≤1100 px.
During a call the voice bar is one row inside the pill (2026-09-29, after the
administrator's report of chips overflowing it and two X buttons): the status
text (it takes the room, with an ellipsis), the wave, one `#cc-live-tag` "Live ·
trial" (model and voice in its tooltip, from the `ready` message), then
`#cc-live-acts` -- mute and End -- at the right. The push-to-talk mic, the
route, the other tags and the bar's own X are hidden (End ends the call);
narrower screens drop the wave (≤1000 px), End's label (≤720 px) and the tag
(≤420 px). The page's grid column is `minmax(0, 1fr)`, so no bar can widen the
page on a phone. The Command Center's own
wiring is the block marked `LIVE CONVERSATION (trial)` in `public/moni-ai.js`.

**The Egyptian evaluation** (`lib/voice-live-eval.js`). Administrators open
**`/mint-ai/voice-eval`** (also linked from Settings > OpenAI voice), record the
20 phrases in their own voice (Egyptian, MSA, English and mixed: status
questions, an action request, stop commands, small talk; kept in
`DATA_DIR/voice-eval/<user id>/`), tick the models (gpt-realtime-mini,
gpt-realtime-2.1-mini, gpt-realtime-2.1) and voices (marin, cedar) and press
*Run*: each phrase goes through a real live session with a stubbed supervisor
(nothing reaches MINT AI) and the page shows one row per model and voice --
first audio, hold, transcription CER (session and full turn), guard cuts,
hand-offs and stops right, dialect right, cost -- with the per-phrase detail
underneath (saved as `results.json` / `results.md`). The same from a shell:
`sudo NODE_PATH=/opt/moni-dashboard/node_modules node
dashboard/tools/voice-live-eval.cjs --dir <that folder>` (or `--self-test` for 2-3
TTS clips).

Tests: `node dashboard/tools/test-voice-live.cjs` (a mock realtime server with
the real event shapes: the session's configuration, the sentence hold,
cross-sentence and Arabic cuts and fail-closed, the tool whitelist, hand-off
grounding (the paraphrase sends exactly the transcript), MINT AI's answers via
summary and reader only, barge-in (flush, cancel, truncate at the played ms),
self-hearing (the detector; speakers mode's gate and tap interrupt; candidates,
confirmation, echo-leak turns, the suggestion, the late barge-in, when the answer
is asked for, a duplicate response.done billed once; and a real-time loopback
simulation in which the voice's own audio fed back as the mic makes the mock VAD
fire but never interrupts, while real speech over it interrupts in ~0.4 s),
the stop command, the echo guard, usage rows, the persona, the maximum length;
then the WebSocket route on the real server from a scratch copy that cannot
reach the helper: auth, CSRF, origin, the mode, one call per user, frame size,
the evaluation page's API).

### Screen control by voice (UI control, Phase 1: the desk's `ui_action`)

The administrator: *"Ideally, I want Mint AI to be able to do everything on the
front end here as well."* The voice (live call and relay desk) has a third tool,
`ui_action`, from one shared allowlist, `public/ui-actions.js` (pure, required by
the server and loaded by the page, so both refuse the same things):
`call.end`, `call.mute` (mute only -- **unmute is by hand**), `call.interrupt`,
`voice.mode` (ptt / handsfree / live), `sheet.open` (the dock's sheets and
Everything), `sheet.close`, `view` (map / missions), `core.set` (A/B/C),
`reply.show`, `reply.read`, `decision.show` (shows the card; **Approve stays a
human click**), `settings.open` (a fixed list -- voice, account, voice-eval --
offered as a link in the toast, never navigated to by itself). Nothing else has
a name: no approve/deny, keys, users, rules, gate, settings values, restart or
deploy.

- **Live call:** `call.*` act on the call on the server (`call.end` ends it after
  the goodbye has played); the rest go to the tab that holds the call over its own
  WebSocket (`{type:"ui", nonce, action, args, toast}`); the page checks the
  allowlist again, acts through the same functions the buttons use, and answers
  `ui-ack` -- no answer in 3 s, or a refusal, and the tool returns *refused*.
- **Relay desk:** page actions only, back to the tab that spoke, in that turn's
  NDJSON stream (`{type:"ui", ...}`); `call.*` is refused (no call).
- Only in a turn the administrator really started (a transcript this server
  heard); at most 6 actions a turn and 20 a minute, `call.end` and
  `settings.open` once a turn; audited (`mint-ui` in the sign-in log); every one
  shown as a toast ("Mint opened Missions"), with **Undo** for sheets, view, core
  and voice mode.
- **The guard:** "I opened Missions" / «فتحتلك الـ missions» / "I muted the
  microphone" is spoken only when a `ui_action` in this turn returned ok
  (`ui-claim` otherwise); a bare "... and restarted Odoo" after a first-person
  clause is still an action claim.
- **Undo by voice:** while the last screen action's toast still offers Undo
  (15 s), saying "undo", "undo that", "go back", "never mind", "cancel that",
  «رجّعها», «رجع», «ألغي ده», «لأ خلاص», «ارجعي» (the whole utterance, as with
  the stop command: `VoiceStop.undo()` in `public/voice-stop.js`) runs that same
  Undo -- in a live call (the page tells the call `ui-undoable`; the server
  drops the turn and sends `ui-undo`), through the relay desk (`undoable` in the
  desk/turn body; the desk answers `heard.undo` and neither answers nor passes
  it on) and on the direct path. With nothing to undo the words go on as an
  ordinary turn; "undo the last git commit" is always a request.
- **MINT AI itself (Phase 2):** its MCP tool `ui_action` reaches the tab that
  asked, and only that tab. The page sends a per-tab id (`sessionStorage`
  `mint-tab`) with every send, desk turn, live call and on its event stream;
  this server mints a one-time token for each send (`lib/ui-relay.js`, in
  memory, 1 h at most) and passes it to the supervisor; the supervisor's live
  `ui` event names only a tag of it. The tab's stream acts on it once; call.*
  go to that user's live call (`LiveCall.deepUi`), the rest to the page, which
  answers through `POST /mint-ai/api/ui/ack` (CSRF'd, only a nonce delivered to
  that user). A tag this server never minted -- a `send` forged straight onto
  the supervisor's socket -- is dropped and audited ("never minted").
- **Closing a panel:** `sheet.close` may name the panel ("close the missions",
  «اقفلي المهام», «اقفل الميشنز»); the page refuses when another is open. The
  tool's description gives the Arabic panel names (المهام / الميشنز, الجلسات /
  السيشنز, القرارات, التكلفة ...) and says a panel close is never ending the call.

Tests: `tools/test-ui-actions.cjs` (the allowlist, the tool schema, rate limits,
the claim words), the `ui_action` sections of `test-voice-live.cjs` and
`test-voice-desk.cjs`.

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
