# Dispatch and poll

Freebuff is an interactive terminal product. This reference intentionally documents a human-driven dispatch,
not a headless automation mechanism.

## Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo --confirm-human
```

The relay verifies that stdin/stdout are TTYs, saves `handoff.md`, prints the handoff location, and launches:

```text
freebuff --cwd <repo>
```

For continuation, the relay maps the project's neutral terms to Freebuff's own CLI terms:

```text
--resume-last       -> freebuff --continue
--session <id>      -> freebuff --continue <id>
```

No other Freebuff CLI flag is invented by this skill.

## Completion

The relay waits for the Freebuff process to exit. It then records the Git-visible working-tree state in
`result.json`. This is the source of truth for whether the work left a diff.

The relay does not scrape the TUI, inspect private conversation files, or claim a machine-readable final
message that the CLI does not expose.

## Timeouts

`--timeout 2h` is a relay-side watchdog. On timeout the child process is terminated and the result status is
`timeout`.
