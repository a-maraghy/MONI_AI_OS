# Proactive MINT AI — design note (functionality upgrade 2, 2026-10-20)

MINT AI used to only react. Now it tells the person three kinds of things without being asked:
a **morning brief**, **watchers** they set in plain words, and a **"while you were away"** catch-up.
Delivery is the Command Center and the desktop app only. Nothing goes out by Telegram, mail or a
push service.

## Where it lives

| Part | File |
|---|---|
| Pure logic: the watcher grammar and its checks, the brief's facts and words, the grounding check | `dashboard/lib/proactive.js` |
| Rows: 4 new tables in `moni.db`, created there and touching no other table | `dashboard/lib/proactive-store.js` |
| The clock, the routes, Settings ▸ Briefs & watchers | `dashboard/lib/routes-proactive.js` |
| The model's wording (one realtime text response) | `dashboard/lib/proactive-writer.js` |
| The page's half: card, toasts, the "Set a watcher?" offer, live-call read-aloud, desktop toast | `dashboard/public/mint-proactive.js` / `.css`, `mint-proactive-settings.css` |
| Tests | `dashboard/tools/test-proactive.cjs` |

`server.js` changes in one place only: a block that mounts the module after the Settings routes.
The other edits are small hooks: `moni-ai.js` (`__mintCC.feed/send/say/speaking/stopSpeaking`, a
watcher check in the composer's submit, a read-the-brief-first check in `liveStart`),
`mint-desktop.js` (the brief glance card, the `mint-proactive` redraw event, the toast's second
button for negative ids), `mint-desktop-glance.js` (alert kinds `watch` and `brief`),
`views-moniai.js` (the two assets) and `views-settings.js` (the ninth section).
`moni-ai` (the supervisor) and `desktop/src-tauri` are **not touched**.

## The clock

Every 20 s the dashboard reads the supervisor. It only uses read-only ops (`status`, `sessions`,
`token-caps` once a minute, and the newest `ledger` rows of inbound and delegations), all as actor
`proactive`. Then it:

1. diffs the sessions against the last look. The changes are started, finished (busy → not busy,
   with how long it worked), waiting, working and ended. They are stored in `proactive_events`
   for the brief, and pruned after 14 days.
2. checks every armed watcher of every enabled user who has `moniai.use`.
3. writes a person's brief when it is due: their time, their days, their time zone, at most once
   a day. A brief missed while the panel was down is written up to 6 h late, and never as a
   backlog.

If the supervisor cannot be reached, the tick decides nothing. The next look carries on.

## Watchers

The person writes plain words: "tell me when the Planning engine session finishes", "alert me if
spend passes $50 today", "watch for a session waiting on me more than 10 minutes", "remind me at
17:30 to …".

`parse()` turns these words into one of seven **structured** kinds: `session_done`, `session_ends`,
`session_waiting`, `spend_over`, `reply_contains`, `fails`, `at_time`. A spoken name is matched to
the live session it means ("planning" → "[GSH] Planning Automation"). If the name is ambiguous,
`parse()` asks which session.

`validate()` refuses any field it does not know, so a watcher has no place for an action, a command
or a URL. **A watcher only writes a line.** Every value is bounded.

- There are at most **50 per person**.
- Watchers are per person, and nobody can see or change another person's (404).
- A watcher fires **once** (it is then "fired · done", and *Watch again* re-arms it) or **every
  time**, with a quiet time of 10 min per session.
- Waiting is counted per episode: one alert per wait.
- Spend fires at most once a day.
- A time-of-day watcher is never told more than an hour late.

When a watcher fires, it writes an inbox row. The page then shows the alert in three places: a
Live feed line, a toast (in the browser) or a Windows toast (in the desktop app), and the glance
card's Live list.

You can create a watcher from Settings ▸ Briefs & watchers (an add box, the list, pause / resume /
delete, "N of 50"). You can also create one from the Command Center's composer: text that reads
like a watcher request is offered as **Set a watcher? [Set watcher] [Send to MINT AI instead]**,
and it is not sent until the person chooses.

## Brief and catch-up text

`gather()` collects the facts for a window from what the box already has:

- engine events: what finished and how long it worked;
- the ledger: inbound messages in the sessions' own words, delegations done, failed or held,
  MINT AI's failed turns;
- `status`: approvals pending and their age, sessions waiting and what for, open decisions, today's
  spend;
- `token-caps`: the tightest cap;
- stale sessions: working 3 h or more, waiting 30 min or more, idle with open tasks, or hired and
  idle for a day;
- for the catch-up only: the watchers that fired.

`compose()` writes at most 8 short lines from these facts, with what needs you first. This
**template** is always there.

If the voice is on and a key is configured, the template is reworded by the model MINT AI already
uses for its summaries (`gpt-realtime-mini`, a text-only realtime response, through this server).
The model's words are used only if `grounded()` passes:

- every number in them, digits or number words, is a number of the template;
- nothing that needs you and no failure is dropped;
- no markup;
- no more lines than the template.

Otherwise the template is used, and the row records why. The cost is recorded as voice usage,
part `desk`.

A live trial on 2026-10-20 gave a grounded result in 1.7 s for about 300 input and 150 output
tokens. In practice the model barely changes the template.

**While you were away.** The page reports activity (a key, a click, the tab coming back) at most
once a minute. Suppose the last report is at least `away_min` old (30 min by default). Then the gap
is summarised: once, only if something happened, and starting after any brief still on screen. The
catch-up shows the spend while away when the gap fell within the same day.

## Where it shows

- **Command Center (browser):** a dismissable card at the top left beside the rail, above the
  sphere. It is full width on a phone. It has *Read aloud* (when the voice is ready), *Settings*
  and *Dismiss*. Dismissing applies on every device, because it is stored on the server.
- **Desktop app:** the brief or catch-up is the first glance card. It shows 4 lines plus "+N
  more", and *Dismiss*. A Windows toast goes through the existing `needs_you` bridge with a
  **negative id**, so the page knows the toast is not an approval: its second button only
  dismisses, and never denies anything. The app still shows a toast only when MINT AI cannot be
  seen.
- **Read aloud:** with *Read it aloud* on, starting the next live call first reads the unread brief
  through the existing read-aloud path, then the call starts. Pressing the mic again skips the
  reading.

## Defaults (the user's to change)

| Setting | Default |
|---|---|
| Brief | on, **08:00**, every day, MINT AI's time zone (`Africa/Cairo`) unless the person sets one |
| Read aloud | **off** |
| Catch-up | on, away after **30 min** (10–240) |
| Watchers | 50 per person; quiet time 10 min; waiting default 10 min; fire once unless "every time / whenever" |
| Missed brief | written up to 6 h late |
| Stale | working ≥ 3 h, waiting ≥ 30 min, idle ≥ 30 min with open tasks, hired and idle ≥ 24 h |
| Model wording | only when the voice is on and a key is configured; otherwise the template |

## Needs native work (not done: `desktop/src-tauri` belongs to the laptop-control build)

- A plain notification command with only *Open*. Today the brief and watcher toasts reuse
  `needs_you`, whose second button reads **Deny** (the page treats it as Dismiss).
- Report the workstation lock and idle state (`GetLastInputInfo`, session lock) to the page. Today
  "away" is page activity only, so a desktop app sitting in the corner unused counts as away.
