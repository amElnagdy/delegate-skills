# Dispatch and poll

Run the relay once, then poll its result artifact:

```powershell
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd "C:\path\to\repo"
```

Useful options include `--lane <name>`, `--agent <name>`, `--model <name>`, `--trust-tools <tools>`,
`--trust-all-tools`, `--require-mcp-startup`, `--resume`, `--resume-id <UUID>`, `--timeout <h/m/s>`,
and `--out-dir <dir>`. Explicit options override lane dials; a lane for another implementer fails.

Artifacts are `brief.txt`, `final.txt` when Kiro emitted a report, `stderr.txt`, and atomic
`result.json`. The result uses `delegate-relay.result.v1`: `touchedFiles` is final Git porcelain for
the `--cd` tree, `[]` means clean, and `null` means Git could not report the tree — which forces
`status: failed` with `git_status_unavailable` rather than a completed run. It includes `sessionId`
when Kiro emits a UUID. A usage error exits 2 without a result; a missing binary exits 127 with one.

The relay performs bounded version/help preflight before dispatch, sanitizes the child environment,
redacts known secret values, verifies Git before and after the run, and kills the process tree after
timeout or abort grace. The shared Windows matrix validates timeout cleanup; Kiro also has a
Windows-only console harness that sends a real `CTRL+C` event. Non-console `child.kill("SIGINT")`
remains unsupported as a substitute for an interactive console event.
