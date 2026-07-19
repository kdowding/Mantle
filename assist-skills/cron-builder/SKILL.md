---
name: cron-builder
description: Design and fix Mantle cron jobs — scheduled background agent runs. Use when helping the user write a job's schedule/prompt/delivery, decide one-shot vs recurring, or work out why a job isn't firing or isn't reaching them.
---

# Building Mantle cron jobs

A cron job is a **scheduled agent turn**: at its time, Mantle runs the agent with the job's prompt as the message, in a background session. You're helping shape that job. The open artifact is the **job spec**; propose a revised spec as a diff.

## The spec

```yaml
name: morning-digest
schedule: cron 0 7 * * * tz America/New_York
delivery: message
session: isolated
prompt: |
  Check overnight email and the calendar for today. Summarize anything
  that needs a decision or a reply. If nothing's noteworthy, say so briefly.
  Finish with cron_report.
```

Keep **all** keys present. The three that decide behavior are `schedule`, `delivery`, and `prompt`.

## Schedule — pick the kind to the intent

- **`every <n>m|h|d`** — fixed interval (`every 30m`, `every 2h`). Minimum 1 minute. Best for polling/heartbeat-style checks.
- **`cron <expr> [tz <zone>]`** — calendar time (`cron 0 7 * * *` = 7:00 daily). TZ-aware; **always set `tz`** for wall-clock jobs or they run in the server's zone. Best for "every morning / weekday / 1st of the month."
- **`at <when>`** — one-shot. ISO timestamp or relative (`at 20m`, `at 2h`, `at 2026-07-01T09:00`). Best for reminders and "do this once later." Pair with `delete_after_run` so it cleans itself up.

"Every morning at 7" is `cron`, not `every 24h` — `every` drifts off wall-clock and ignores DST.

## Delivery — where the run's outcome lands

This is the key the user most often gets wrong. It decides what reaches them:
- **`message`** — every run result is delivered into their chat. Use for anything they must SEE: reminders, digests, alerts.
- **`notify`** — a small toast, no chat message. Use for low-salience "it ran" pings.
- **`silent`** — nothing surfaces. Use for background upkeep (memory maintenance, ingestion).
- **`agent`** (default) — the run itself decides, via its `cron_report` verdict's `notify` flag. Use when only *some* runs are worth interrupting for ("tell me only if something changed").

A reminder set to `agent` or `silent` will quietly never reach the user — if they're scheduling a nudge, it's almost always `message`.

## Prompt — write it for an agent waking up cold

The run has no conversation history (unless `session: persistent`). The prompt is its whole brief:
- Say exactly **what to check** and **where** (the tools/sources).
- Say **what counts as noteworthy** vs. skippable — this is what makes `delivery: agent` work.
- End with **"Finish with `cron_report`."** Inside a run the agent has `cron_report` (a verdict: `status`, `summary`, `notify`) and `cron_snooze` (re-check later) automatically. The report becomes the run-log line, drives the `agent`-delivery decision, and is fed to the *next* run as context — so a good prompt asks for a real verdict, not just an action.

## Session, and the rest

- **`session: isolated`** (default) — fresh each run; no memory of prior runs except the last `cron_report`. **`persistent`** — reuses one session, accumulating history (use for a job that should remember what it already told you).
- Optional knobs exist for `priority`, `provider`/`model`, `max_iterations`, `tags`, `delete_after_run`, and Englyph hooks (`englyph_store_outcome`; `englyph_recall_context` for pre-run memory; `englyph_conditional_query` + threshold to skip a run unless memory matches). Reach for these only when the job needs them.

## Why a job misbehaves

- **Not firing:** `every` minimum is 1 min; a `cron` expr in the wrong field; a past one-shot `at`. Repeated errors trigger backoff `[30s,60s,5m,15m,1h]` and eventual auto-disable — check the run history.
- **Firing but silent:** delivery is `agent`/`silent`/`notify`, or the run's `cron_report` set `notify:false`.
- **Doing nothing useful:** the prompt is too vague for a cold start. Tighten *what to check* and *what's noteworthy*.

When you propose a fix, call `propose_edit` once with the complete revised spec.
