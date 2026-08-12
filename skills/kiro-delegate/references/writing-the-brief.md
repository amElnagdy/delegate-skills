# Writing the brief

Kiro receives one self-contained brief, not the orchestrator's conversation history. Include the
goal, repository facts, target files, explicit non-goals, real gates, and the report contract.

```xml
<task>
State the bounded change, current behavior, desired behavior, target files, and what stays untouched.
</task>
<repo_constraints>
Copy the applicable AGENTS.md rules, dependency policy, generated-file policy, and commit boundary.
</repo_constraints>
<verification_loop>
Run the exact project gates and report their outcomes. Confirm only intended files changed.
</verification_loop>
<action_safety>
Do not git add, commit, push, or create a PR. Do not invoke another implementer. Leave the worktree
uncommitted for the orchestrator.
</action_safety>
<structured_output_contract>
Report: what changed and why; files touched; gate outcomes; deviations or open questions.
</structured_output_contract>
```

Keep secrets out of the brief. The relay stores a redacted artifact and passes the brief to Kiro;
put large context in workspace files instead of the brief. A resumed session gets only a delta brief.
