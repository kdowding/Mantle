# Helping the user with cron — scheduled & background work

A usage guide for an agent setting up and managing scheduled work for its user. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this whenever the user wants something to happen **later** or **on a repeat**: a reminder at a time, a recurring check, a watch on a feed or a file, a periodic digest, a one-shot timer — anything that isn't "right now in this turn." **Cron is the one mechanism for all recurring or time-based work.** There is no separate background-task system; if a task should run on its own, it's a cron job.

Everything here describes how cron *works* and how to *help the user operate it* — it does not change who you are. Most cron operations are free and reversible (create / edit / delete a schedule). What needs care is the *scope* a job runs under — how much it can touch when it fires unattended — and that's where you slow down and choose deliberately; see [Choosing the run scope](#choosing-the-run-scope-presets) and [Confirmation](#what-needs-the-users-confirmation).

---

## What cron is, and the one rule that matters

A **cron job** is a saved instruction: *at this schedule, fire a background turn of this agent with this prompt, under this scope, and deliver the outcome this way.* When it fires it runs as a real (but autonomous) agent turn — no human at the keyboard — in its own background session, then records a verdict.

The rule that matters: **a scheduled run is unattended, so it runs under a deliberately bounded scope, not your full chat capabilities.** Two things bound it — the **preset** (which context loads and which tools the run can use) and the **delivery mode** (where the outcome lands). Both default to the *safe, quiet* end. When you create a job, your job is to pick the *lightest* scope that still does the task and the delivery that matches how much the user needs to see. A job that only reads-and-reports should not be carrying tools that can write, run, or send.

You manage **your own** jobs through the single **`cron_jobs`** tool. Inside a firing run, two pseudo-tools appear automatically — **`cron_report`** (end every run with a verdict) and **`cron_snooze`** (re-check later). The user also sees and manages all of this in the UI **systems deck** (the cron page), so anything you set up is visible and editable there too.

---

## The `cron_jobs` tool — managing your own jobs

`cron_jobs` is one tool with an `action`. It always operates on **your own** jobs (the acting agent is taken from the turn context) — you cannot see or touch another agent's jobs. The actions:

| Action | What it does |
|---|---|
| `list` | All your jobs — name, short id, schedule, status (idle / running / disabled), last run, error count. |
| `create` | Make a new job. Requires `name`, `message` (the prompt the run receives), and `schedule_kind`. |
| `update` | Patch an existing job (partial — only the fields you pass change). Set `name` to rename. |
| `delete` | Remove a job. |
| `run` | Trigger a job **now**, out of schedule (runs in the background). |
| `history` | Recent run outcomes for a job (status, duration, summary, what was delivered). |
| `analyze` | Query Englyph for patterns/trends across a job's run history. |

**Referring to a job:** you almost never have the internal UUID. `job_id` accepts the **full id**, the **8-character id prefix** that `list` shows, **or the exact job name** (case-insensitive). Run `list` first when you're unsure what the user means.

**Per-agent cap:** there's a ceiling on how many jobs one agent can hold (default **20**). At the cap, `create` refuses — prune stale jobs with `delete` first.

Jobs you create are stamped `createdBy: "agent"` and are **privilege-contained**: the run can use *at most* the tool surface the creating turn had (see [presets](#choosing-the-run-scope-presets)). Jobs the user creates via REST/UI are not constrained that way.

---

## Schedules — the three kinds

Set `schedule_kind` to one of:

| `schedule_kind` | Field | Means | Notes |
|---|---|---|---|
| `at` | `schedule_at` | **One-shot** — fire once. | ISO 8601 timestamp (`2026-06-20T09:00:00Z`) **or** a relative duration (`"20m"`, `"1h"`, `"2d"`). A past time fires right away. |
| `every` | `schedule_every_ms` | **Interval** — fire repeatedly. | Milliseconds. **Minimum 60000 (1 minute)** — anything shorter is rejected. |
| `cron` | `schedule_cron` (+ `schedule_tz`) | **Cron expression** — calendar-style recurrence. | Standard cron syntax (`"*/30 * * * *"` = every 30 min, `"0 9 * * 1"` = 9am Mondays). `schedule_tz` is an IANA zone (`"America/New_York"`); **timezone-aware** so "9am" means 9am *there*, DST included. |

Picking the kind:

- **"Remind me at 3pm" / "in 20 minutes" / "tomorrow morning"** → `at` (one-shot). Use a relative duration for "in N" and an ISO timestamp for a wall-clock time.
- **"Every couple of hours" / "every 15 minutes"** → `every`.
- **"Every weekday at 8am" / "the 1st of each month"** → `cron` with a timezone (clock-anchored recurrence is what cron expressions are for; `every` drifts relative to wall-clock).

A one-shot `at` job **disables itself after a successful run** (it stays listed, just off) unless you set `delete_after_run` to remove it outright — handy for throwaway reminders so they don't pile up. (A run can also re-arm a one-shot by snoozing — see [cron_snooze](#the-in-run-pseudo-tools).)

---

## Session targets — where the run's conversation lives

`session_target` controls the transcript a run writes into (default **isolated**):

- **`isolated`** — a fresh background session each run. The clean default for independent, stateless checks; nothing accumulates.
- **`persistent`** — reuse one background session across runs, so the job builds a running history with itself. Use when a job benefits from seeing its own past runs in-context (a build-up over time).
- **`session:<id>`** — a specific named session. Advanced; the id is path-validated so it can't escape your own sessions.

Note this is the run's **workspace** (where its tool calls live) — *separate* from the job's **report thread**, where the outcome is filed for the user (below). Continuity between runs is carried by the previous-run report and thread steering regardless of session target (see [continuity](#continuity-the-previous-runs-report-feeds-the-next)).

---

## The job thread + delivery modes — where the outcome lands

**Every job owns a thread** — a persistent per-job session (visible in the cron deck) where each run files its report. The thread is the durable record: the user pulls it up to read what the job has produced over time, and they can **reply into it like any chat** — replies since the last run ride into the next one as steering, so a job course-corrects ("less X, more Y") without anyone editing its prompt. Your `cron_report` `message` is what lands there, verbatim.

`delivery` decides whether a run **also pings the user right now**, beyond the thread record (default **agent**):

| Mode | Beyond the thread, the user gets |
|---|---|
| `silent` | Nothing — the report files quietly to the thread; they read it when they choose. |
| `notify` | A lightweight toast in the UI (job name + status + summary). A glanceable "it ran." |
| `message` | **Every** run's report is mirrored into the user's most recent real chat with you, verbatim. |
| `agent` *(default)* | The run **decides per-fire** via its `cron_report` `notify` flag: noteworthy → mirrored into chat; routine → thread only. |

**Which to pick:**

- **A reminder the user must actually SEE** → **`message`** (it lands in chat). Don't use `notify` for a real reminder — a toast is easy to miss.
- **A recurring check that's usually boring but occasionally matters** → **`agent`** (the default): the run pings only when it has something; the thread keeps the full record either way. The right default for most watches.
- **Pure background bookkeeping** → **`silent`** (thread only).
- **A glanceable status with no chat interruption** → **`notify`**.

Two nuances: a `message`/`agent` chat mirror lands in the user's **most recent real chat session** — if they've *never* chatted with this agent it **degrades to a toast**. And **failures are never invisible**: an error run files a failure notice into the thread and toasts (unless the job is explicitly `silent`), and an auto-disabled job announces it gave up in its thread.

---

## Choosing the run scope (presets)

This is the most important choice you make, because a scheduled run fires **unattended** — there's no one to confirm a risky action with. The `preset` sets two things at once: how much **identity/memory context** loads (economy — don't pay for what a job won't use) and, crucially, **which tools the run may use** (the real safety bound). **Pick the lightest preset that does the job.**

| Preset | Context it loads | Tools the run can use |
|---|---|---|
| **`mechanical`** *(default)* | Lean — identity only, no SOUL, no memory pack. | **Read + report only**: memory recall, `web_fetch`, filesystem **reads** (`read_file`/`list_directory`/`glob_files`/`grep_files`), session reads. **No** bash, write/edit, attachments, subagents, or research. |
| **`aware`** | + the user profile + working memory + light recall. | Same read-only + report surface as `mechanical`. |
| **`companion`** | The full identity (incl. SOUL), skills, memory pack — sounds fully like you. | The **full tool surface** — including capabilities that write, run, and reach out. |

The default is `mechanical` on purpose: the "crawl something and report" archetype. The worst an injected or confused mechanical run can do is report wrong content — it **can't write, execute, or exfiltrate**. Step up only when the task genuinely needs it:

- **"Check this page / feed / file and tell me what changed"** → `mechanical`. (Reads and reports — nothing more.)
- **"A daily check-in that reasons about me / my notes"** → `aware`. (Reads the user + memory, still can't act on the machine.)
- **"A job that must actually DO something — write a file, run a command, send via an MCP, sound fully like me"** → `companion`. This is an explicit opt-in. Flag the exposure to the user (see [Confirmation](#what-needs-the-users-confirmation)).

**Egress allow-list (`egress_domains`):** for any job that fetches the web, you can pin the run's `web_fetch` / `attach_url_file` to a **specific list of domains** (subdomains included). When set, the run can reach *only* those hosts — so an injected page can't make it phone home. **Strongly recommended for crawl-and-report jobs:** list exactly the sites it's supposed to read. (Without it, the standard SSRF block still applies, but the run can reach any external host.) The `cron_jobs` tool will also warn at creation time if a job's resolved surface includes "blind-egress" capabilities (bash, research, full MCP) that the egress list can't cover — heed that warning and lean to a tighter preset or a domain list.

The autonomous-run conduct floor is built into every scheduled run regardless of preset: tool results are treated as untrusted data, irreversible/outward-facing actions the job wasn't set up for are *stopped and reported* rather than improvised, and the run stays on-task. You don't configure that — it's the fixed floor. (Note: a per-agent `disabledTools` list is a hard gate that strips a tool from *every* surface including cron, so a tool the user has disabled for an agent won't appear in any of its jobs.)

---

## The in-run pseudo-tools

When a job fires, two tools appear in that run automatically (they aren't part of `cron_jobs`, and they aren't available in normal chat — they're injected into the scheduled turn). If you are ever *running as a cron job*, you'll have these:

- **`cron_report` — always finish a run with this, exactly once, as the last action.** Its two text fields have different jobs. **`message` is the deliverable**: the full report/reply the user reads, filed verbatim into the job's thread — write it complete and self-contained (markdown fine); it's required for status `ok`/`problem` and omitted for `nothing`. **`summary` is the verdict**: one line for the run log and the *next run's* context — make it the real result, not "done." `status` is **`ok`** (task done) · **`nothing`** (nothing new/noteworthy) · **`problem`** (needs attention). The `notify` flag — under the default `agent` delivery — decides whether this run interrupts the user *now* (the report is in the thread regardless): set `notify=true` only for something that genuinely wants attention (a problem, an awaited result, something time-sensitive). When in doubt, stay quiet — a companion that pings about nothing trains the user to ignore it.

- **`cron_snooze` — re-check later instead of forcing work.** When there's nothing actionable yet (the watched thing hasn't changed, the condition isn't met), call `cron_snooze` with a `delay` (`"90s"`, `"30m"`, `"2h"`, `"1d"`; clamped to between 1 minute and 7 days) to push the *next* fire out, rather than padding or inventing work. For a one-shot `at` job, snoozing **re-arms it** to fire again at the snoozed time instead of completing — useful for "keep checking until X, then report."

The conduct floor explicitly tells a run to **stop and report a blocker** (via `cron_report` status `"problem"`) rather than push past a confirmation it can't get. A run that halts at something it can't safely do is doing its job correctly.

---

## Continuity — the previous run's report feeds the next

A job's last `cron_report` verdict is prepended into the **next** run's prompt as a `[Previous run: <status> — <summary>]` line. So a recurring job has a thread of memory with itself: each run can see what the last one found and decide whether anything actually changed. This is why a good `summary` matters — it's not just a log line, it's the next run's starting context. (It works regardless of session target.)

**Thread steering rides in too:** if the user replied in the job's thread since the last run, those replies are prepended to the next run's prompt as steering. Treat them as course-corrections to *how* you do the job ("skip the funding news", "go deeper on X") — they adjust this run, and if they amount to a permanent change, say so in your report so the user can update the job itself.

There's also an optional **Englyph layer** (advanced, usually set up via REST/UI rather than the tool's common path): a job can gate its execution on an Englyph query (only proceed if relevant memories exist), enrich the run with recalled context, and store its outcome back into memory as a causal chain. At a concept level: cron can both *read from* and *write to* the agent's long-term memory around a run. The pre-run condition check **fails open** (an Englyph hiccup never blocks a job).

---

## Seeing current state

Before changing anything, look at what's already there:

- **`cron_jobs` action `list`** — your jobs at a glance: name, short id, schedule, whether each is idle / running / disabled, last-run time, and any consecutive-error count. Start here.
- **`cron_jobs` action `history`** — a specific job's recent runs: status, duration, the summary, and what was delivered. This is how you answer "did the 8am check run, and what did it find?"
- **The job's thread** — the full reports themselves, in order, plus anything the user said back. The user opens it from the job's card in the cron deck; you can read it like any session.
- **`cron_jobs` action `analyze`** — trend/pattern questions across a job's history (Englyph-backed).
- **The UI systems deck (cron page)** — the user's own view of every job, its schedule, status, and run log, where they can create/edit/enable/disable jobs directly. Point them there for a visual overview; what you set up via the tool shows up there and vice versa.

A job's status reflects reality: **disabled** can mean a completed one-shot, a manual toggle-off, or an **auto-disable** after repeated failures (below) — check the last error to tell which.

---

## Gotchas and failure modes

- **Interval minimum is 1 minute.** `every` jobs under 60000ms are rejected. There's no sub-minute scheduling.
- **`every` drifts; `cron` is clock-anchored.** For "every weekday at 8am" use a `cron` expression with a timezone, not an interval — an interval measures from runs, not from the wall clock.
- **A run can be preempted.** If the user starts chatting (or the agent is otherwise busy) when a job is due, that fire is **skipped** — and a skip deliberately does **not** advance the schedule, so the job re-arms its next natural slot rather than hot-retrying. A skipped fire just didn't happen this time; it isn't an error.
- **Errors back off, then auto-disable — loudly.** Repeated failures retry on an escalating backoff (30s → 1m → 5m → 15m → 1h); each error files a failure notice into the job's thread (and toasts, unless the job is `silent`). After **5 consecutive errors** the job **auto-disables** itself and *announces it* in the thread — a dead job is heard about, not discovered weeks later. (Repeated *un-computable-schedule* errors disable too.) A one-shot `at` job only retries *transient* errors (rate-limit/network/5xx and the like) a few times; a permanent error disables it immediately. Re-enabling is an `update` with `enabled: true` once the cause is fixed.
- **Cron can be off entirely.** Cron is enabled by default, but if the user has disabled it in config, the `cron_jobs` tool isn't registered and jobs don't fire. If you can't find the tool, that's why.
- **`message`/`agent` delivery needs an existing chat.** A message-delivering run lands in the user's most recent real chat session; with no prior chat, it falls back to a toast. A brand-new agent's first scheduled report may arrive as a notify rather than a message.
- **The run prompt is the whole brief.** A scheduled run doesn't carry your live conversation — it gets the job's `message`, the chosen context (per preset), and the previous-run line. Write the `message` as a self-contained instruction (what to do, what counts as noteworthy, when to stay quiet), because that's all the run has to go on.

---

## What needs the user's confirmation

- **Creating a `companion`-preset job, or any job with write/run/send/research capability.** This is a job that can *act* on the machine, unattended. Confirm the user wants that scope, and prefer the lightest preset that does the task. For web-touching jobs, propose an `egress_domains` allow-list.
- **`message` delivery (or `agent` that will message).** This will interrupt the user's chat when the job fires. Fine when they asked for a reminder; confirm intent so you're not setting up something that pings them unprompted.
- **Deleting a job** the user may still want — `delete` is permanent. (Disabling via `update enabled:false` is the reversible alternative.)
- **High-frequency jobs.** A short-interval `every` job (or a busy `cron` expression) runs repeatedly and each fire is a real agent turn — that's real cost/activity over time. Confirm the cadence is what they want.

Routine, no-confirm-needed: creating a plain `mechanical` read-and-report or a one-shot reminder, listing jobs, reading history, manually triggering a `run`, and snoozing/reporting inside a run. These are bounded, reversible, and low-cost.

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- Memory framing (how a job's stored outcomes and recalled context fit your long-term memory): `docs/agent-manual/management/memory.md`.
