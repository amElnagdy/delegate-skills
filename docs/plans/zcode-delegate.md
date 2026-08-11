# Plan: `zcode-delegate` — delegate to the Z.AI ZCode CLI

> **Status:** DESIGN — not yet implemented, not yet claimed.
> Every CLI fact below is from live runs against `zcode` 0.16.1 on Windows 11 x64
> (node v24.12.0, provider `zai/glm-5.1`), 2026-08-11 — not from documentation.
> Public ZCode docs describe only the desktop GUI and are **not** a usable source here.

## Goal

Add an eleventh implementer skill so an orchestrator can hand a bounded coding task to the
Z.AI ZCode CLI, then review the diff and land it. Same loop, same
`delegate-relay.result.v1` contract, same commit boundary as the ten siblings.

## Does it qualify?

Yes, on all four invariants:

- **A separate CLI edits a real working tree.** Verified: `--mode yolo` created a file that
  `git status` reported. The diff is the deliverable.
- **The relay never commits.** By construction.
- **Node built-ins only.** The relay launches `zcode` (or `node <bundle>`) and `git`.
- **Autonomy stated in the CLI's own terms.** `--mode build|edit|plan|yolo`, and everything ZCode
  cannot enforce is stated plainly below.

## Verified CLI facts

### Distribution — the one genuine deviation

`zcode` is **not on PATH, not on npm, and not publicly documented.** It ships inside the ZCode
desktop app as `…/ZCode/resources/glm/zcode.cjs` — a 13 MB Node bundle with a `#!/usr/bin/env node`
shebang and process title `zcode-cli`. `doctor` reports `sea: no (optional)`,
`default artifact: node-bundle`. CLI 0.16.1 versions independently of desktop app 3.7.5.
The npm names `zcode` and `zcode-cli` are unrelated 0.0.1 packages.

### Flags — `--help` lies

Arg parsing runs before the model-config check, so flag acceptance was audited at zero token cost.

**Advertised in `--help` but rejected by the binary:**
`--permission-mode`, `--allowed-tools`, `--max-turns`, `--settings`, `--allow-main-worktree-yolo`.

**Accepted:** `--prompt`, `-p` (an alias of `--prompt <value>`, *not* a positional/stdin mode),
`--cwd`, `--json`, `--no-color`, `--mode`, `--disallowed-tools` / `--disallowedTools`,
`--resume`, `-c` / `--continue`, `--attach`, `--verbose`, `--locale`, `--force-mcs`, `--no-browser`.

**Semantics:** `--mode` is enum-validated; `--target` is mutually exclusive with `--prompt`;
`--target-replace` requires `--target`; `-c` is **cwd-scoped** (`No resumable session found for <cwd>`),
which is a stronger resume story than a global "last".

There is **no `--model` flag.** Model selection lives in the CLI's config file, so `model` is not a
dial this implementer can support.

### Autonomy — the headline

| `--mode` | Observed |
| --- | --- |
| `yolo` | **Writes.** ZCode's own default for `--prompt`. |
| `build` | **Exit 0, wrote nothing** — *"Write and Bash tools are blocked … `No permission client configured`"* |
| `edit` | Same class as `build`. |
| `plan` | **Refused to write**; tree unchanged; *"in plan mode and can't make edits yet"*. |

`build`/`edit` reproduce issue #55 exactly: a run that does nothing, reported as success.

`--disallowed-tools "Write,Edit,Bash"` is **genuinely enforced** — the tools were absent from the
session and no file appeared. There is **no allowlist counterpart**, so claude-delegate's explicit
allowlisted tool surface is impossible here and must not be implied.

### Output contract

`--json` prints a **single pretty-printed JSON object at the end** — not a JSONL event stream. It
holds under heavy tool use (verified at `eventCount` 785+, 5 model requests, subagents spawned).

```json
{ "sessionId": "sess_…", "traceId": "…", "turnId": "turn_…",
  "response": "…",
  "usage": { "source", "modelRequestCount", "inputTokens", "outputTokens", "totalTokens",
             "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
             "webFetchRequests", "webSearchRequests" },
  "eventCount": 12,
  "projection": { "status", "turnCount", "totalTokenCount", "contextUsed", "contextWindow" } }
```

**stdout is not guaranteed pure JSON.** The bundled AI SDK calls `console.info(...)` for its
warning banner — which is stdout — while individual warnings go to `console.warn` (stderr). A naive
`JSON.parse(stdout)` therefore fails intermittently.

Without `--json`, stdout is the final message text alone.

### Brief delivery — no stdin

`… | zcode -p` fails (`Option '-p, --prompt <value>' argument missing`); `--prompt -` treats `-` as
the literal prompt. Nothing reads stdin. `--attach <file>` **works** (verified: an attached brief
round-tripped a codeword), which is how a long brief avoids the ~32 767-char Windows argv ceiling.

### Exit codes

`0` on success; `1` with a plain-text stderr error and no JSON for an unknown session; non-zero plus
a full help dump for an unknown flag.

### Auth — currently broken upstream

`zcode login` fails with `ZaiCliOAuthError: OAuth response is not valid JSON`. The CLI's config lives
at `~/.zcode/cli/config.json`, separate from the desktop app's `~/.zcode/v2/config.json`, and the
canonical shape (recovered from the app's own writer) is a `provider` map plus
`model: { "main": "<providerId>/<modelId>", "lite": … }` with registry ids `zai` / `bigmodel`.
Config load failures are **silent** — Zod diagnostics are collected and never printed, so a malformed
file is indistinguishable from a missing one. The API key may come from `ANTHROPIC_API_KEY`,
`ZAI_API_KEY`, or `ZCODE_API_KEY` instead of the file.

`SKILL.md` documents `zcode login` as the intended path, records that it is broken as of 0.16.1, and
gives the env-var route as the workaround — without instructing anyone to hand-edit a
reverse-engineered file.

## Design

### Skill shape

Standard implementer shape, no exceptions: `skills/zcode-delegate/SKILL.md`, one
`scripts/relay.mjs`, and exactly the four references (`writing-the-brief`, `dispatch-and-poll`,
`review-and-land`, `multi-task-queues`).

### Locating the CLI

Resolution order, first hit wins:

1. `zcode` on PATH (sibling behaviour; honours a user-made shim)
2. `--zcode-path <file>` flag, else `ZCODE_CLI` env var
3. Auto-discovered bundle: `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` (verified) and
   `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (inferred, unverified). Linux ships as
   an AppImage with **no fixed install path**, so there is nothing reliable to auto-discover there —
   Linux users fall back to step 1 or 2, and the docs say so rather than guessing a path.

Launch mechanics by what resolution returned — this is the line the maintainer will read closely:

- A PATH-resolved `.cmd`/`.bat` shim (the likely shape of a user-made `zcode` on Windows) **must**
  use the sibling `shell:true` handling, with spaceable args quoted and value flags token-validated.
  It cannot be spawned directly on win32; that is exactly why codex/opencode/grok/pi do this.
- A resolved `.cjs` bundle launches as `node <path>` with `shell:false` — no shim, so no shell.
- A native binary launches directly.

Not found → exit **127 with** a `result.json` (`status: "zcode_unavailable"`), matching every sibling.

Resolution returns `{ command, prefixArgs }` so a launcher prefix stays a first-class concept rather
than string-concatenation: normal CLIs get `{ command: binaryPath, prefixArgs: [] }`, zcode gets
`{ command: process.execPath, prefixArgs: [bundlePath] }`.

### Dispatch

```
<command> [...prefixArgs] --cwd <repo> --json --no-color --mode <yolo|plan> \
          [--disallowed-tools <list>] [--resume <sess_…> | -c] \
          --attach <run-dir>/brief.md --prompt "Follow the attached brief exactly."
```

The brief is written to the relay's temp run dir and attached — no stdin, no argv ceiling, no
quoting hazard. `--mode` is **always passed explicitly** so ZCode's `yolo` default for `--prompt` is
never inherited by accident.

`build` and `edit` are **rejected with exit 2 before dispatch**, because they cannot write headlessly
and would otherwise land a do-nothing run as `completed`.

### Result parsing

Buffer stdout under `MAX_BUFFERED_CHARS`; parse **tolerantly** by skipping leading non-JSON lines
before the first `{`. Map `response` → `finalMessage` and `sessionId` → the resume id; carry `usage`
and `projection.contextWindow` through. Unparseable stdout with a non-zero exit is `failed` with a
`stderrTail`, never a silent success.

Parity groups, precisely: the relay **does** join `MAX_TIMER_MS`, `parseDuration`, `killChild`,
`gitTouchedFiles`, the read-only tripwire family (`gitRepoRoot` … `readOnlyVerdict`), **and
`MAX_BUFFERED_CHARS`** (it bounds the stdout buffer like its siblings). It does **not** join
`makeEventScanner` — there is no event stream to scan. That combination already has precedent:
`vibe` carries `MAX_BUFFERED_CHARS` without `makeEventScanner`.

### Read-only

`--read-only` maps to `--mode plan`. Plan mode refused to write in testing, but whether that is
tool-enforced or model compliance is unproven, so the relay reports the tri-state
`readOnlyViolation` tripwire, exactly as claude and grok do. README gets the measured wording, not a
guarantee.

### Result contract (`delegate-relay.result.v1`)

`status` (`completed` / `failed` / `timeout` / `aborted` / `zcode_unavailable`), `exitCode`,
`signal`, `finalMessage`, `touchedFiles` (`null` when git cannot report, `[]` when clean),
`sessionId`, plus `mode`, `zcodeVersion`, `usage`, `contextWindow`, `readOnlyViolation`, `lane`,
`laneSource`, `workdir`, `briefPath`, `outputPath`, `finalPath`, `startedAt`, `finishedAt`.
Usage errors exit **2 before** any result file; a missing binary exits **127 with** one.

### Fleet integration

`delegate-setup` gains a `zcode` registry entry:

```js
{ key: "zcode", skill: "zcode-delegate", binary: "zcode",
  versionArgs: ["--version"],
  // Consulted only when `binary` is absent from PATH; launcher runs the bundle under node.
  locate: {
    launcher: "node",
    candidates: {
      win32:  ["%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs"],
      darwin: ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"],
      linux:  [],   // AppImage has no fixed install path — nothing honest to guess
    },
  },
  authProbe: null,            // no auth-status command; login is broken upstream
  modelProbe: null,           // no --model flag
  usageProbe: { homeSubdir: ".zcode/cli", path: ["exec"], entry: "dir", match: /^sess_/ },
  supports: ["permissionMode", "timeout", "readOnly"],
  winShell: false }
```

`permissionMode` is reused for ZCode's `--mode` rather than inventing a dial, and a new
`ZCODE_MODE` constant admits **only** `plan` and `yolo` — `build`/`edit` are excluded at
config-validate time for the same reason the relay rejects them. `model` is absent because the flag
does not exist.

`resolveBinary` gains the `locate` fallback so discovery finds zcode without a shim. The usage probe
directory must be confirmed 1:1 with sessions during implementation; if no directory maps cleanly,
`usageProbe: null` is the honest answer (precedent: opencode, qoder, vibe).

## Work items

- [ ] `skills/zcode-delegate/SKILL.md` + the four `references/*.md`
- [ ] `skills/zcode-delegate/scripts/relay.mjs`
- [ ] `test/harness/constants.mjs`: add `zcode` to `SKILLS` and `EXTRA_ARGS` (`[]`). `binaryName`
      needs no change — its default already returns `zcode`.
- [ ] `test/harness/install-shim.mjs`: add `zcode` to the Windows `.cmd` fake list. Its win32 branch
      hardcodes which skills get a `.cmd` shim versus a compiled `.exe`; adding `zcode` to `SKILLS`
      without this leaves no fake `zcode` on PATH and the Windows matrix fails on arrival. The `.cmd`
      list is also the right choice because it exercises the `shell:true` path above.
- [ ] `test/relay/zcode.mjs` + registration in `test/relay/index.mjs`
- [ ] `test/relay-parity.mjs`: add zcode to the shared-helper and tripwire relay lists
- [ ] `test/relay-isolated.mjs`: add to `RELAYS`
- [ ] `skills.sh.json`: register under the delegate grouping
- [ ] `delegate-setup`: registry entry, `locate` fallback in `discover.mjs`, `ZCODE_MODE` in
      `config.mjs`, dial table row in `references/schema.md`
- [ ] README: table row + Verification status line + distribution caveat
- [ ] `AGENTS.md`: vocabulary row in ZCode's own terms
- [ ] Bump every skill's `metadata.version` in lockstep

## Verification status to claim

Only what actually ran, pinned to the version:

> `zcode-delegate` — Windows, `zcode` 0.16.1: the composed dispatch line
> (`--json --mode yolo --attach <brief> --prompt …`) run end to end, creating the briefed file with
> stdout parsing cleanly and `sessionId` captured; plan-mode run leaving the tree untouched;
> `sessionId` resume by both paths (`--resume`, `-c`); `--disallowed-tools` enforcement leaving the
> tree clean; `--version` preflight. Timeout/abort matrix contract-tested. No macOS or Linux run
> recorded.

`--version` and `-v` both print `0.16.1` and exit 0 — confirmed by running them, not by trusting
`--help`, so `versionFallbackArgs` is not needed.

## Open risks

- **Distribution.** No PATH binary, no npm package, no public CLI docs. The maintainer may object on
  principle; the claim issue should surface this before implementation lands.
- **`--help` cannot be trusted.** Five advertised flags are rejected. Anything documented in the
  skill must be re-tested against the binary, per the AGENTS.md accuracy rule.
- **Broken `zcode login`.** Until upstream fixes it, the honest prerequisite is the env-var route.
- **Plan-mode enforcement unproven** — hence the tripwire.
- **Bundle paths for macOS/Linux are unverified** and need a run on each before being claimed; the
  Linux AppImage has no fixed path at all.
- **`--attach` combined with `--resume` / `-c` is untested.** Both work independently; the delta-brief
  rework cycle depends on the combination, so it must be verified before `review-and-land.md`
  documents it.
- **Timeout/abort process-tree behaviour is unverified for a `node <bundle>` launch** — the child is
  `node`, not a CLI shim, so the smoke matrix's whole-tree kill assertions must be run, not assumed.
- **The usage probe directory is unconfirmed.** `~/.zcode/cli/exec` and `artifacts` hold `sess_*`
  dirs but their counts differ (12 vs 8), so neither is yet proven 1:1 with sessions.
