# Multi-task queues

Run queued work sequentially: one bounded brief, one Kiro session, one reviewed diff, and one commit
per task. Keep the tree clean before each dispatch so `touchedFiles` remains interpretable.

```powershell
node "<skill-dir>/scripts/relay.mjs" --brief task-01.txt --cd "C:\path\to\repo"
```

Use a resumed Kiro session only for corrections to the same task. Start unrelated work in a fresh
session and carry forward decisions explicitly in its brief. For independent tasks, use separate
working trees and review them independently. Keep a progress file with queued, dispatched, reviewed,
and landed states, gate outcomes, and open questions. After the last task, rerun the full gates and
search for stale references before the orchestrator lands the result.
