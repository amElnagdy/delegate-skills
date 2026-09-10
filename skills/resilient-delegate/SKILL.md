---
name: resilient-delegate
description: Delegate a coding brief through a local-first, provider-diverse fallback profile when an implementer is unavailable or capacity constrained. Use for bounded implementation work that must preserve the working diff for orchestrator review and landing.
license: MIT
compatibility: Requires Node 18+, Git, and one or more installed sibling delegate skills.
metadata:
  version: 0.5.0
---

# Resilient Delegate

Use this utility to dispatch one brief through an ordered profile. It starts from
the local Aider/Ollama path for routine work and advances only after an observable
capacity or infrastructure failure. It never commits, pushes, installs software,
or changes credentials.

Run it from a clean Git working tree unless you explicitly intend to preserve
existing changes:

```sh
node skills/resilient-delegate/scripts/resilient.mjs --brief brief.md --cd . --profile routine
```

Read `references/configuration.md` before supplying a profile file. Review the
working-tree diff and rerun project gates before landing any result.
