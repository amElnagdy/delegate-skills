# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `agy --print`, runs the brief in Antigravity,
captures the final response, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file.

## Before the first run: check the binary

```bash
command -v agy
agy help
agy models
```

`agy models` proves the CLI can authenticate and list available model labels. The relay records the
version it can infer from `agy changelog` into `result.json`.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed - the folder containing its `SKILL.md`.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin before passing it to `agy --print`. |
| `--cd <dir>` | Working root for Antigravity (default: current directory). |
| `--model <name>` | Antigravity model label. Optional; a fresh run can use Antigravity's configured default. |
| `--project <id>` | Use an existing Antigravity project. |
| `--new-project` | Force a fresh Antigravity project. This is the default for fresh dispatches. |
| `--resume-last` | Continue the most recent Antigravity conversation; send only the delta brief. |
| `--conversation <id>` | Continue a specific Antigravity conversation; send only the delta brief. |
| `--sandbox` | Enable Antigravity's terminal sandbox for the run. |
| `--dangerously-skip-permissions` | Pass Antigravity's permission-bypass flag. Never use this unless the human explicitly accepts it. |
| `--print-timeout <duration>` | Timeout for print mode (default: `30m`). |
| `--add-dir <dir>` | Add an extra workspace directory. Repeatable; relative paths resolve against `--cd`. Fresh runs always add the `--cd` repo (absolute path) as a workspace dir. Edits inside extra workspaces are not reported in `touchedFiles`. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Antigravity's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` - the result-format version (currently `delegate-relay.result.v1`)
- `tool` - `agy`
- `status` - `completed` | `failed` | `agy_unavailable`
- `exitCode` - mirrors Antigravity's exit code; `128` plus the signal number if the child was killed; `127` if `agy` is not on PATH
- `signal` - the signal that killed the child, otherwise `null`
- `agyVersion` - inferred from `agy changelog` when available
- `projectId` / `conversationId` - parsed from the Antigravity log when present
- `finalMessage` - Antigravity's stdout response
- `touchedFiles` - `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git cannot report; `[]` means git ran and the tree is clean
- `briefPath` / `finalPath` / `logPath` / `stderrPath` - the exact brief, final message, Antigravity
  log, and stderr capture
- `workdir`, `model`, `project` (the `--project` you passed, vs `projectId` parsed from the log),
  `sandbox`, `dangerouslySkipPermissions`, `resumed` (true for a `--resume-last` or `--conversation`
  run), `startedAt`, `finishedAt`
- `stderrTail` - last ~20 stderr lines; present only on a failed run
- `error` - present only if Antigravity failed to launch

The helper also prints a summary to stdout and exits with Antigravity's exit code, so a wrapping script
can branch on success/failure directly.

## Waiting for completion

The helper blocks until Antigravity finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the Bash call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll. A run is done
  when `result.json` exists with a `status`. A pre-run usage error exits with code 2 before writing any
  file, so check the exit code too. A missing `agy` binary exits 127 and writes `result.json` with
  `status: agy_unavailable`.

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written.

## When a run misbehaves

- **`status: agy_unavailable` (exit 127):** `agy` is not on PATH. Install the Antigravity CLI and run
  its first-launch setup, then re-dispatch.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child - commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail`, `stderrPath`, and `logPath` for the cause.
  Common causes: auth lapse, an unknown model label, timeout, or a permission the run needed.
- **A run stalls on permissions:** either configure Antigravity permissions for the actions the task
  needs, or ask the human whether to re-run with `--dangerously-skip-permissions`. Pair risky runs with
  `--sandbox` when terminal restrictions are appropriate.
- **Empty `finalMessage`:** Antigravity finished without emitting a closing text summary. The edits may
  still be correct - check `touchedFiles` and the diff. To get a report next time, add a
  `<structured_output_contract>` block (see [writing-the-brief.md](writing-the-brief.md)).

## What the helper is doing

Under the hood the helper runs roughly:

```bash
agy --new-project --add-dir <repo> --print-timeout 30m --print=<brief>
agy --continue --print-timeout 30m --print=<delta brief>
agy --conversation <id> --print-timeout 30m --print=<delta brief>
```

`agy --print` requires the prompt as a flag argument, so keep briefs focused. The relay still accepts
stdin or `--brief <file>` for your convenience; it reads the text first, then passes it to `agy` as
`--print=<brief>` (the `=` form so a brief that begins with a bare flag like `--help` still runs).
Two consequences of the brief riding the command line: it is visible in the host process list (`ps`),
so on a shared machine keep secrets out of it; and a brief over ~120 KB is rejected up front (the OS
caps a single argument), so have `agy` read large context from the workspace instead of inlining it.

## The commit boundary

The helper never commits - by design, not omission. The robust contract is: Antigravity edits the
working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).
