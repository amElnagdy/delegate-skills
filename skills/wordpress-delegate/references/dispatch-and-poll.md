# Dispatch and poll

`scripts/relay.mjs` is the routing layer. It classifies the brief, composes it with the WordPress
preamble, and dispatches through the chosen sibling's own `relay.mjs`, which owns every CLI-specific
mechanic. Your job collapses to: run one command, then read one file.

This relay launches **no implementer CLI of its own**. It shells out to `node` (for the sibling) and
`git`, and nothing else. Every guarantee about sandboxes, sessions, and streaming is the sibling's,
unchanged — this layer adds the routing decision and passes the rest through.

It does terminate one process: the sibling relay it spawned. A watchdog backstop and signal
forwarding are impossible without that, so it is an owned exception, and a bounded one — reaching
past the sibling to the implementer CLI is the sibling's own handler's job. (Windows is the usual
exception: with no process groups to signal, the `taskkill /t` that fells the sibling fells the tree
under it, and the sibling's handler never runs.) That is also the only case where this relay
overrides the sibling's verdict — it did the killing, so the sibling could not know why it died.

## Before the first run: check the siblings

```bash
node "<skill-dir>/scripts/relay.mjs" --list-routes    # the lane table and its targets
```

Every lane target must be installed beside this skill for that lane to work. The shipped targets are
`codex-delegate`, `grok-delegate`, `kimi-delegate`, and `opencode-delegate`; installing the whole
package gets you all ten. Each sibling's own `SKILL.md` carries its CLI's install and login commands.

(`<skill-dir>` is wherever this skill is installed — the folder containing its `SKILL.md`. On Claude
Code it's the printed "Base directory for this skill"; on other orchestrators substitute that install
path.)

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/plugin
```

### Routing options

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print the routing decision as JSON and exit 0 without dispatching. Writes no result file. Use it before any run you are unsure about. |
| `--list-routes` | Print the lane table and the implementer table, then exit 0. |
| `--implementer <name>` | Force the implementer, bypassing the lane table. `agy`, `claude`, `codex`, `cursor`, `grok`, `kimi`, `opencode`, `pi`, `qoder`, `vibe`. Recorded as `confidence: "forced"`. |
| `--lane <name>` | Force the lane; the table still resolves the implementer. Use when you know the kind of work but not who should do it. |
| `--strict-routing` | Refuse to dispatch when confidence is `low`, `none`, or `contested`. Exits **3** with the exact question to put to the user, before any artifact exists. |
| `--print-preamble` | Print the WordPress engineering preamble and exit 0. |
| `--no-preamble` | Send the brief verbatim. Implied on `--session` / `--resume-last`. |
| `--implementer-relay <path>` | Absolute path to a sibling `relay.mjs`. Use when only this skill is installed and the sibling directories are absent. |

### Forwarded options

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read from stdin (`node relay.mjs … < brief.txt`). |
| `--cd <dir>` | Working root (default: current directory). |
| `--model <name>` | Implementer model. **Required** when routing to `opencode`; the relay says so by name rather than letting the sibling exit 2. |
| `--read-only` | Review/diagnosis with no edits, translated to the chosen CLI's own flag — `--read-only`, `--plan-only` (Vibe), or `--permission-mode plan` (Qoder). Rejected with exit 2 for `kimi` and `agy`, which have no read-only mode. |
| `--session <id>` | Continue a specific session, translated to the chosen CLI's own resume flag (`--session`, Qoder's `--resume`, Antigravity's `--conversation`). Send only the delta brief. |
| `--resume-last` | Continue the most recent session of the chosen implementer. |
| `--timeout <dur>` | Watchdog (e.g. `30m`, `2h`), forwarded to the sibling, which owns the kill. This relay arms a backstop 60s later for the one case the sibling cannot cover — the sibling itself wedging. Off by default. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). The sibling's own artifacts land in `<out-dir>/implementer/`. |
| `-- <args…>` | Everything after `--` is forwarded to the sibling verbatim, for implementer-specific flags this relay does not model — `--sandbox`, `--effort`, `--permission-mode`, `--skip-git-repo-check`. |

The passthrough is the escape hatch: this relay deliberately models only the flags that mean the same
thing across implementers. Anything specific to one CLI goes after `--` and is that CLI's business.

## The routing table

Two tables at the top of `scripts/relay.mjs` decide everything:

- **`LANES`** — what *kind* of work this is. Each row has a name, an implementer, a list of regex
  signals, a `readOnly` flag, and a one-line `why` that is recorded in `result.json`. Each distinct
  signal that matches scores 1; the highest-scoring lane wins; **lane order breaks ties**, so a brief
  that trips both `security-audit` and `performance` routes as a security audit.
- **`DOMAINS`** — what the work is *about*. Domains do not route. They select the notes appended to
  the preamble and are recorded in the result so a reviewer can see what the router thought it was
  looking at.

Confidence follows from the score: `high` (two or more signals), `low` (exactly one), `contested`
(a tie above zero), `none` (nothing matched — the `implementation` fallback), `forced`
(`--implementer` or `--lane` was given).

One rule overrides the score. **A read-only lane needs two signals to win.** A lane that withholds
writes on a single keyword returns findings and an empty diff to someone who asked for a fix, which
reads as the implementer doing nothing — so "fix the cart hook, it's missing a nonce check" demotes
to `implementation` at `low` confidence with `security-audit` recorded in `alternates`, rather than
silently becoming an audit. A tie is left alone: `contested` already names both lanes and asks.

### Extending it

Adding a lane is one row. Nothing else in the file knows the lane names:

```js
{
  name: "multisite",
  implementer: "codex",
  readOnly: false,
  why: "Network-wide state and per-site state are different problems, and mixing them corrupts both.",
  signals: [/\bmultisite\b/, /\bnetwork admin\b/, /\bswitch_to_blog\b/, /\bsite meta\b/],
},
```

Place it by precedence, not alphabetically — earlier rows win ties. Re-targeting a lane is a one-word
change to its `implementer`. Teaching the preamble a new area is one row in `DOMAINS`, with its own
`notes`. After either, run `node test/relay-smoke.mjs` and add a row to `ROUTING_CASES` in
`test/relay-smoke.mjs` so the new lane is pinned.

Signals are matched **case-insensitively** against the brief as written, so write each row in the
casing its ecosystem uses — `Gutenberg`, `registerBlockType`, `$wpdb` — and don't hand-lower it.
`matchedSignals` echoes back what the brief actually said, which is what makes a wrong routing
decision diagnosable.

Two rules keep the table honest:

- **Signals match the brief's wording, not the working tree.** The router reads text. If a lane needs
  to know something only the repo can tell it, that lane does not belong here — put it in the brief.
- **A lane that routes read-only must target an implementer that has a read-only mode.** `kimi` and
  `agy` do not; the relay refuses at dispatch rather than letting the sibling reject an unknown flag.

## The result

`<out-dir>/result.json` is the contract. It speaks `delegate-relay.result.v1` like every sibling, with
the contract fields lifted from the sibling's own result and a routing block on top.

- `schema` — `delegate-relay.result.v1`
- `status` — whatever the sibling reported (`completed` | `failed` | `<cli>_unavailable` | …), or one
  of this relay's own: `timeout` (its backstop fired), `aborted` (it was killed and forwarded the
  kill), `implementer_unavailable` (the sibling relay was not found)
- `exitCode` — the sibling's, which mirrors the implementer's; `127` when the sibling relay is missing
- `signal` — the signal that killed the run, otherwise `null`
- `routing` — `lane`, `implementer`, `confidence`, `reason`, `matchedSignals`, `domains`,
  `alternates` (the runners-up and their scores), `forced`
- `implementer` / `implementerRelay` / `implementerResultPath` — who ran it, which relay dispatched
  it, and where that relay's own result sits
- `implementerResult` — the sibling's entire result object, verbatim. Everything CLI-specific lives
  here: `threadId`, `sessionId`, `codexVersion`, `usage`, `cost`, `readOnlyViolation`, and so on
- `implementerSession` — the session id lifted from whichever field that CLI uses, for a later
  `--session`
- `finalMessage` — the implementer's own final report
- `touchedFiles` — `git status --porcelain` lines: your review starting point. `null` when git can't
  report; `[]` when git ran and the tree is clean
- `preamble` — whether the preamble was prepended (false on a resumed run)
- `readOnly`, `model`, `session`, `resumeLast`, `workdir`, `briefPath`, `startedAt`, `finishedAt`
- `stderrTail` — present when the sibling reported one
- `error` — present on any run that did not complete

`briefPath` points at `<out-dir>/dispatched-brief.txt` — the composed brief, preamble and all, exactly
as the implementer received it. Read it when a run goes sideways and you want to know what was
actually asked.

## Waiting for completion

The relay blocks until the sibling finishes, which is until the implementer finishes.

- **Claude Code:** run the `Bash` call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll. A run is done
  when `result.json` exists with a `status`. **But** a pre-run usage error exits 2, and a
  `--strict-routing` refusal exits 3, both *before* writing any file — so check the exit code too.

## When a run misbehaves

- **exit 3, `--strict-routing refused to dispatch`:** the router was not confident. stderr carries
  the question to put to the user. Answer it with `--lane` or `--implementer`, or ask them.
- **`status: implementer_unavailable` (exit 127):** the routed sibling's `relay.mjs` was not found.
  Install it, point `--implementer-relay` at it, or route elsewhere with `--implementer`. The error
  names the path it looked at.
- **exit 2, `requires an explicit model`:** the brief routed to `opencode`, which needs `--model`.
  Pass one, or route elsewhere.
- **exit 2, `has no read-only mode`:** a read-only lane or an explicit `--read-only` landed on `kimi`
  or `agy`. Route to `codex` (sandbox-enforced) or `grok` (best-effort, flagged after the fact).
- **`status: failed` with no `implementerResult`:** the sibling exited without writing a result,
  which is almost always a usage error in the forwarded arguments. The sibling's own stderr was
  inherited, so it is above the summary in the run output.
- **The routing was wrong:** `result.json`'s `routing.matchedSignals` shows exactly which phrases
  fired. Either the brief said something it did not mean, or the lane's signals need a row. Re-dispatch
  with `--implementer`, and if the miss is systematic, fix the table.
- **Everything else** — `timeout`, `aborted`, a `SIGKILL` from the OOM killer, an empty
  `finalMessage`, recovering work from the event log — behaves exactly as it does for the sibling that
  ran it. Read that skill's own `dispatch-and-poll.md`; `implementerResult` and
  `implementerResultPath` point you at its artifacts.

## The commit boundary

Neither this relay nor any sibling commits — by design, not omission. The implementer edits the
working tree; the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
