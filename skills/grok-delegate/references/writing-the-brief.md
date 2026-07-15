# Writing the Grok brief

Grok receives the brief and the repository, not the orchestrator's conversation. A useful brief is
self-contained, bounded, and testable.

```xml
<task>
  <goal>Describe the required outcome in one paragraph.</goal>
  <context>Explain the current behavior and relevant architecture.</context>
  <scope>
    <change>List the requested changes.</change>
    <do_not_change>List explicit exclusions and protected behavior.</do_not_change>
  </scope>
  <constraints>
    <item>Follow repository instructions and established patterns.</item>
    <item>Do not commit, amend, push, or modify git history.</item>
    <item>Do not broaden scope without reporting a blocker.</item>
  </constraints>
  <acceptance_criteria>
    <item>State observable completion conditions.</item>
  </acceptance_criteria>
  <verification>
    <command>Use commands discovered from this repository, not guessed defaults.</command>
  </verification>
  <structured_output_contract>
    Return: summary, changed files, decisions/assumptions, gates run with outcomes, and remaining risks.
  </structured_output_contract>
</task>
```

Keep one task per brief. Include exact paths only when known. For corrective work in a resumed session,
send a delta brief containing the review findings, required corrections, and gates to rerun; do not
repeat the entire original task.
