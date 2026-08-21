# Dispatch and poll

The relay wraps one `dsh --profile headless` run: it validates arguments, writes the brief to a
file, launches `dsh` with a one-line pointer task, captures the run, harvests the session record,
and publishes `result.json` atomically. You run one command and read one file.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--brief <file>` | The brief; piped stdin is the alternative. Empty briefs exit 2. |
| `--cd <dir>` | Child cwd and the sandbox's `workspaceRoot` (default: current directory). |
| `--lane <name>` | Fleet lane from delegate-setup config; dials apply, explicit flags win. |
| `--model <name>` | Request a model via a generated `agent-default-model` overlay. A stored `$DSH_HOME/settings.yaml` selection outranks it (measured) — compare `modelOverlay` with `actualModel`. |
| `--provider <name>` | Provider for that overlay (default: `deepseek-official`). Requires `--model`. |
| `--permission-mode <m>` | `DSH_PERMISSION_MODE` for the child: `read-only` \| `workspace-write` \| `danger-full-access`. |
| `--read-only` | Sugar for `--permission-mode read-only`; also arms the Git tripwire. |
| `--patch <file>` | Extra composition overlay, repeatable, passed straight to `dsh --patch`. |
| `--timeout <dur>` | Relay-side watchdog (`30m`, `2h`; default off — `dsh` has no timeout flag of its own). |
| `--out-dir <dir>` | Run artifacts directory (default: fresh dir under the system temp dir). |

Permission-mode precedence, in order: `--permission-mode` / `--read-only` → a lane's
`permissionMode` dial → a `DSH_PERMISSION_MODE` already exported in your environment (honored and
reported as `permissionModeSource: "environment"`, never silently stripped) → unset, letting the
harness's composed default (`workspace-write`) apply.

## The pointer-file mechanic

`dsh --profile headless` takes the task only as a positional argv value and reads no stdin
(measured), so the relay writes the brief verbatim to `<out-dir>/brief.md` and passes:

```
Read the task brief at <out-dir>/brief.md and execute it fully.
```

The `workspace-write` sandbox confines mutations to the workspace and the platform temp roots and
does not confine reads, which is what makes the pointer readable. On win32 the npm `dsh` is a
`.cmd` shim that needs `shell:true`, so the relay quotes spaceable values and rejects paths carrying
cmd metacharacters (`% ! & | ^ < > "`) with exit 2 — quoting alone is not a boundary in cmd.

## result.json

Alongside the shared `delegate-relay.result.v1` fields (`status`, `exitCode`, `signal`,
`finalMessage`, `touchedFiles`, `stderrTail`, paths), the dsh relay reports:

- `permissionMode` + `permissionModeSource` (`flag` / `lane` / `environment` / null) and `readOnly`.
- `modelOverlay` — the requested `{provider, model}`, or null. A request, not a guarantee.
- `readOnlyViolation` — the tripwire verdict on `--read-only` runs: `true` (the tree changed),
  `false` (measured clean), or `null` (coverage incomplete — not a clean bill of health).
- **Session-record harvest** (see below): `sessionId`, `sessionRecordPath`, `actualProvider`,
  `actualModel`, `reasoningEffort`, `usage` (`inputTokens` / `outputTokens` /
  `assistantMessages`), `turnEndReason`, `recordedPermissionMode`, `recordedSandboxMode`,
  `recordedApprovalPolicy`, and `sessionHarvest` — `"ok"`, or the reason every harvested field is
  null (`"unsupported-node (zlib zstd needs Node 22.15+)"`, `"no-dsh-home"`, `"not-found"`, an
  `"error: …"` string, or `"skipped (dsh was not dispatched)"`).

`finalMessage` is `dsh`'s own final stdout text — the headless app prints exactly the final
assistant message (measured). The raw stream is kept at `outputPath`, the trimmed report at
`finalPath`.

## The session-record harvest

The headless surface prints no session id, but `dsh`'s session-persistence-jsonl plugin appends
every run to `$DSH_HOME/sessions/<escaped-workspace>/session-<uuid>/session.jsonl.zstd`. After the
run the relay locates this run's record — matched by the record's own `cwd` header and creation
time, never by predicting the directory-name escape — and reports from it:

- **What actually served the run.** The record's request header carries the effective provider,
  model, and reasoning effort. This is how a `--model` request that a stored settings selection
  outranked becomes visible instead of silently ignored: `modelOverlay` says what you asked for,
  `actualModel` says what ran (measured: an overlay naming a nonexistent model completed on the
  stored selection, and the harvest reported the stored model).
- **What it cost.** Token usage summed across assistant messages — the early warning for briefs
  outgrowing a small-context local model.
- **The recorded posture.** The harness's own `permission/preset`, `sandbox/mode`, and
  `approval/policy` events — the run's autonomy as recorded, not as assumed.
- **An audit handle.** `sessionId` names the on-disk record for later inspection. It is not a
  resume handle: the headless surface has no resume.

The record is a series of independent zstd frames (one per append); zlib gained zstd in Node
22.15 / 23.8, so on an older Node the dispatch still works and `sessionHarvest` says
`unsupported-node`. The harvest reads a file `dsh` itself just wrote, locally; nothing is sent
anywhere, and it can never fail the run.

## Wiring a local OpenAI-compatible endpoint

`dsh` serves local models through its `llm-pi-ai` providers config — vLLM, llama.cpp, Ollama, or
any OpenAI-compatible server. Two routes:

**Persistent (recommended): `$DSH_HOME/settings.yaml`.** Define the provider and select it once;
every dispatch uses it. Note that this stored selection outranks the relay's `--model` overlay —
which is the desired behavior for a pinned local deployment.

**Per-run: a `--patch` overlay.** On a home with no stored selection, one overlay can wire the
endpoint end-to-end (measured against a local vLLM server: a fresh `$DSH_HOME` plus exactly this
shape of overlay completed a run on the local model, confirmed by the harvest's `actualProvider`):

```yaml
- id: llm-pi-ai
  config:
    providers:
      local-vllm:
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        apiKeyEnv: LOCAL_API_KEY        # name of the env var holding the key; the file holds no secret
        defaultContextWindow: 65536
        defaultMaxTokens: 32768
        models:
          - id: my-local-model          # must match the id the server reports under /v1/models
            contextWindow: 65536
            maxTokens: 32768
- id: agent-default-model
  config:
    provider: local-vllm
    model: my-local-model
```

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo --patch local-endpoint.yml
```

A `--patch` overlay replaces each targeted row's **whole** `config` (no deep-merge), so the file
carries the complete provider definition. Reasoning-effort mapping and other compat switches are
provider config too — set them where the provider is defined; the harvest's `reasoningEffort`
reports the effective value when one is set.

Two local-deployment realities to plan for:

- **Wake latency.** A local inference server that sleeps or offloads VRAM when idle adds its wake
  time to the first request. Budget `--timeout` for the task, not the first token, and treat a slow
  start as normal.
- **Throughput.** A local model is often slower per token than a hosted one. Implementation briefs
  that need an hour on a hosted CLI need more here; start with `--timeout` off (the default) or
  generous, and calibrate from `usage` and wall-clock on your own hardware.

## Waiting, and the SIGTERM trap

The relay blocks until `dsh` finishes. Back it with your orchestrator's background facility
(Claude Code: `run_in_background: true`), or background it in the shell and poll for
`result.json`. Completion means the process exited and `result.json` exists with a `status`.

`dsh` catches SIGTERM, drains gracefully, and **exits 0** (measured on a live mid-run kill). The
relay therefore classifies `timeout` (its watchdog fired) and `aborted` (the relay itself was
killed and forwarded the kill) from its own state, never from the child's exit code — and any
supervisor of yours that reads the child's exit code directly would misread a kill as success.
Status semantics:

| status | Meaning | Relay exit |
| --- | --- | --- |
| `completed` | `dsh` exited 0 on its own | 0 |
| `failed` | `dsh` exited non-zero (e.g. the measured `MISSING_CREDENTIAL` diagnostic), or died on an external signal | dsh's exit / 128+signal |
| `timeout` | The `--timeout` watchdog killed the run | mirrors the mapped exit |
| `aborted` | The relay was killed and took `dsh` with it (whole process group) | 128+signal |
| `dsh_unavailable` | No `dsh` on PATH | 127, result file written |

A pre-run usage error exits 2 and writes **no** result file — a poller must treat "non-zero exit,
no file" as a usage error, not a lost run.

## Recovery when a run misbehaves

- **`failed` with `MISSING_CREDENTIAL`** — the provider route has no key: export the credential the
  diagnostic names (or the `apiKeyEnv` your provider config names) and re-dispatch.
- **`failed` at boot with a config validation error** — an invalid `DSH_PERMISSION_MODE` or a
  malformed `--patch` overlay fails the plugin tree load with the offending row named; fix the
  overlay and re-dispatch.
- **`timeout` / `aborted`** — inspect the working tree before anything else: the run may have
  partial edits. Keep or revert them deliberately (see
  [review-and-land.md](review-and-land.md)), then re-dispatch a fresh, self-contained brief.
- **`completed` but the report says it could not act** — a `read-only` run whose brief ordered a
  write completes with the refusal in the final message and exit 0 (measured). Read
  `finalMessage` and `readOnlyViolation`, not just `status`.
