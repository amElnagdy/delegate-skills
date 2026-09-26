# Dispatch and poll

Run the relay once, then poll its result artifact:

```powershell
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd "C:\path\to\repo"
```

Useful options include `--lane <name>`, `--agent <name>`, `--model <name>`,
`--effort <low|medium|high|xhigh|max>`, `--mode <default|spec>` for the V3 agent, `--wsl` and
`--wsl-distro <name>` when a Windows relay uses a WSL-installed Kiro CLI,
`--trust-tools <tools>`, `--trust-all-tools`, `--require-mcp-startup`, `--resume`,
`--resume-id <UUID>`, `--timeout <h/m/s>`, and `--out-dir <dir>`. Model, effort, and mode are omitted
from the Kiro command unless explicitly supplied or set by a lane. Every dispatch includes `--v3`;
preflight requires V3, effort, and mode capabilities and does not silently fall back. Explicit options
override lane dials; a lane for another implementer fails. `--wsl` is Windows-only and uses an argument array—`wsl.exe --cd <workdir>
--exec <kiro-bin>`—rather than a shell command. Allowed `KIRO_*` environment values and standard
CA bundle paths (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`) are
forwarded through `WSLENV`; credentials are not placed in command arguments.

Artifacts are `brief.txt`, `final.txt` when Kiro emitted a report, `stderr.txt`, and atomic
`result.json`. Stdout is redacted and streamed to `final.txt`; to bound relay memory, `finalMessage`
contains at most the last 65,536 characters and `finalMessageTruncated` reports whether earlier text
exists in `final.txt`. The result uses `delegate-relay.result.v1`: `touchedFiles` is final Git
porcelain for the `--cd` tree, `[]` means clean, and `null` means Git could not report the tree —
which forces `status: failed` with `git_status_unavailable` rather than a completed run. It includes
`sessionId` when Kiro emits a UUID. A usage error exits 2 without a result; a missing binary exits
127 with one.

The relay performs bounded version/help preflight before dispatch, sanitizes the child environment,
redacts known secret values, verifies Git before and after the run, and kills the process tree after
timeout or abort grace. The shared Windows matrix validates timeout cleanup; Kiro also has a
Windows-only console harness that sends a real `CTRL+C` event. Non-console `child.kill("SIGINT")`
remains unsupported as a substitute for an interactive console event.
