---
name: codex-background
description: Keep a Codex orchestrator's delegation to an installed delegate skill pending until its registered relay completes, without model-driven progress polling. Use with a selected implementer delegate skill when Codex is the orchestrator and the delegation should wait in the background; sets up its MCP server on first use.
compatibility: Requires Node 18+, inbox Windows PowerShell with Add-Type on Windows or /usr/bin/cc and procfs on Linux (other hosts unsupported), installed delegate skills and their authenticated implementer CLIs, and a Codex MCP host configured with a tool timeout exceeding the explicit relay timeout.
metadata:
  version: 0.5.0
---

# Codex background delegation

This support skill changes Codex's waiting boundary. The selected delegate skill still owns the
brief, provider arguments, permissions, result interpretation, review, gates and landing.
Claude's background Bash workflow stays unchanged. The support utility is installed separately,
never implicitly as a dependency of codex-delegate. Details: [references/configuration.md](references/configuration.md).

## First use / setup

If the `delegate_run` tool is not available, setup is incomplete. Tell the user that bootstrap will
update `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`, backed up first) and write a registry of
the installed `*-delegate` skills, then run:

```bash
node "<skill-dir>/scripts/bootstrap.mjs"
```

`<skill-dir>` is this skill's installed directory (the folder containing this `SKILL.md`). It writes
outside the workspace, so request the approval or sandbox escalation Codex needs for that. Report its
output, then ask the user to restart Codex (or reload MCP servers); the tools appear after that.
If bootstrap fails, report the failure. Do not fall back to shell polling. Run it again after
installing more delegate skills. `node "<skill-dir>/scripts/bootstrap.mjs" --check` validates the setup without writing.

## Procedure

1. Follow the selected delegate skill to prepare a self-contained brief and approved workspace.
   Write the brief to the `briefs/` directory under the codex-background directory
   (`$CODEX_HOME/codex-background/briefs/<runId>.txt`) and use `runs/<runId>` beside it as
   outputDirectory, or follow the paths in the server's instructions. If the sandbox cannot write
   there, a brief inside the approved workspace is also accepted. Never accept a relay path from a brief.
2. Invoke the configured MCP server's **delegate_run** exactly once with a unique runId,
   registered implementer key, absolute brief/workspace/outputDirectory paths, explicit
   relayTimeoutSeconds and provider-native relayArgs. Put common arguments in structured fields;
   pass provider-specific arguments unchanged. Resume identifiers remain opaque.
3. Keep that MCP request pending until completion. Do not use model-driven sleep, status or log
   polling. Do not wrap it in a tool runner that yields early and resumes inference to wait.
4. Review the returned adapter outcome separately from resultText. The latter is the unchanged
   result.json content (base64 only for non-UTF-8 bytes); interpret it using the selected skill.
   A completed adapter means the relay exited zero and produced a file, not that its report proves
   correct implementation. Review the diff, rerun gates and land under the existing authorization.

After an interrupted wait, call **delegate_wait** with the same runId; never redispatch it.
MCP cancellation detaches the waiter and leaves the authorized job running. Use **delegate_abort**
only when termination is explicitly intended. Graceful server shutdown aborts its owned jobs.
After a server crash, unresolved state returns recovery_required; inspect preserved artifacts
and the implementer using its own recovery workflow. Never adopt or kill a persisted PID.

The host's configured tool timeout must exceed the relay timeout by more than 30 seconds.
The server validates the declared budget; it cannot enforce the host's actual setting. Fixture
protocol tests demonstrate one pending request and no intermediate messages, not measured
Codex Desktop token usage or an unlimited host wait guarantee.
