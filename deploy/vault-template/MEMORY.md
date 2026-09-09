# MEMORY

**This file is the long-term memory of {{AGENT_NAME}}. It is injected into the
system prompt on every request. Nothing in a chat session survives a reset —
only this file and the notes it points at do.**

---

## CURRENT STATE

_What this agent is for, what is finished, what is still open. Keep it honest and
current: move items from open to done in the same turn you finish them._

Created {{CREATED}}. Nothing recorded yet.

---

## Memory index

_One line per durable fact, each pointing at a note under `memory/`._

---

## How to keep this memory

1. **Search first.** `memory_search` before answering anything that depends on
   earlier work. This index is a table of contents, not the content.
2. **Write when it matters.** Finished work, decisions, hard-won lessons,
   environment changes.
3. **One fact per note** under `memory/`, with a pointer line in the index above.
4. **Correct, do not stack.** Fix a wrong note; never add a contradiction.
5. **Log the narrative** in `WORKLOG.md` — one short dated entry per piece of
   work.
