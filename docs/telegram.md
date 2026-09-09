# Telegram setup

The same walkthrough is built into the panel at `/guide` — read it there when you
are mid-task. This is the reference copy.

---

## 1 · Create a bot

Every agent needs its own bot. Telegram allows exactly one poller per token, so
sharing one between two agents makes both drop messages at random.

1. Message [@BotFather](https://t.me/botfather).
2. `/newbot`
3. Display name — anything, e.g. *Odoo Dev*.
4. Username — must be unique and end in `bot`, e.g. `moni_odoo_dev_bot`.
5. BotFather replies with a token like `8123456789:AAHk9x…`. That line **is** the
   bot.

> The token is a password. Anyone holding it controls the bot and reads
> everything sent to it. Paste it into the create-agent form and nowhere else.
> The panel stores it `0600` and never displays it again. If one leaks,
> `/revoke` in BotFather invalidates it immediately.

Worth setting while you are there:

| Command | Why |
|---|---|
| `/setdescription` | Shown on the bot's empty chat screen |
| `/setuserpic` | Makes agents distinguishable when you run several |
| `/setprivacy` → Disable | Only if the bot will live in a group and should see all messages, not just replies and mentions |

## 2 · Find your user ID

Agents answer a whitelist of numeric IDs and silently ignore everyone else. An
agent with an empty whitelist talks to nobody — that is the safe default.

Message [@userinfobot](https://t.me/userinfobot); it replies with your ID.

## 3 · Create the agent

`Agents → Create agent` in the panel. The field that matters most is **Role**: it
is written into `CLAUDE.md` and loaded on every request. Be specific about what
the agent owns, what it may do unattended, and what it must ask about first.

The panel verifies the token with `getMe` before writing anything — a token
Telegram rejects is the most common reason a new agent is silently dead, and
catching it here costs one API call instead of a trip through the journal.

---

## Groups and topics

Default is a private chat: you and one agent. Group topic mode instead puts the
agent in a forum group where each project gets its own thread — useful when
several people share an agent, or one agent covers several projects.

1. Create a **group** (not a channel).
2. Group Settings → **Topics** → on. This converts it to a forum; without it
   there are no threads to route into.
3. Add the bot to the group.
4. Promote it to **administrator** with **Manage Topics** — it creates and
   renames threads itself.
5. Get the chat ID: forward any group message to
   [@userinfobot](https://t.me/userinfobot). Supergroup IDs start with `-100`.
6. In the agent's Settings, enable topic routing and paste the ID.

The panel pre-flights all of this before saving — that the chat exists, that it
is a forum, that the bot is an admin with topic rights — and reports every
problem at once rather than one per attempt.

> Group privacy mode is on by default, so the bot only sees messages that mention
> it or reply to it. That is usually what you want in a busy group. To change it:
> BotFather → `/mybots` → the bot → Bot Settings → Group Privacy → Turn off, then
> remove and re-add the bot for it to take effect.

---

## Channels

Channels are broadcast, not conversation, and that difference decides how they
can be used here:

- A bot added to a channel as admin **can post** to it.
- Subscribers cannot reply in a way the bot receives, so there is no conversation
  to have. An agent in a channel can talk but never listen.

So use:

| Want | Use |
|---|---|
| A personal agent | Private chat |
| A shared agent, several projects | Group with topics |
| Deploy notices, nightly summaries, CI results | Channel, as an output only |

To make an agent broadcast: add its bot to the channel as an admin with post
rights, and put the channel ID in the agent's role brief. It will post there when
asked while continuing to take instructions from you in private.

---

## Commands in chat

| Command | Effect |
|---|---|
| `/start` | Wake it up, confirm it can hear you |
| `/new` | Fresh session. Clears the conversation, **not** the memory vault |
| `/status` | Session, model, usage |
| `/verbose 0\|1\|2` | How much of its own work it narrates |
| `/repo` | Git status of the working directory |

Voice notes, photos and documents work too.

---

## When it does not answer

| Symptom | Cause |
|---|---|
| Never answers | Your user ID is not in the allowed list, or the unit is not running |
| Unit is `failed` | Bad token, or no Claude credential. The logs say which |
| Answers then goes quiet | Two pollers on one bot token |
| Ignores you in a group | Privacy mode — mention the bot or reply to it |
