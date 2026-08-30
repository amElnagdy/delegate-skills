# Clarification protocol

Clarification is an escape hatch for unresolved judgment, not a replacement for a good brief. It
lets an implementer stop cleanly, return one machine-readable question, and continue in the same
session after the orchestrator decides or obtains a human decision.

The protocol is implementer-neutral. Support is currently implemented by `cursor-delegate` with
`--clarifications`; other relays can adopt the same envelopes when their session and final-report
mechanics can preserve the contract.

## State machine

```text
RUNNING
  |-- implementer succeeds --------------------------> COMPLETED
  |-- implementer or protocol fails -----------------> FAILED
  |-- relay watchdog fires --------------------------> TIMEOUT
  |-- relay is killed -------------------------------> ABORTED
  `-- valid clarification request -------------------> NEEDS_INPUT
                                                         |
                                      orchestrator or human decides
                                                         |
                                      answer + exact-session resume
                                                         |
                                                         `--> RUNNING
```

`needs_input` is a clean pause: the implementer process has exited, `result.json` exists, and the
relay exits 0. It is not completion and does not authorize review or landing. Partial working-tree
changes remain evidence; inspect and preserve them before resuming.

## When to ask

The implementer first checks the brief, repository, project documentation, existing architecture
decisions, and established conventions.

It **must ask** only when continuing would require unresolved judgment about:

- a genuinely ambiguous business rule;
- conflicting architecture decisions or a change to an approved architectural assumption;
- a potentially destructive migration that was not authorized;
- authorization or security behavior;
- a material expansion of scope; or
- a choice that would establish a significant architectural precedent.

It **must not ask** when those sources already resolve the question, or for naming, style, routine
implementation choices, and safe inferences that do not change architecture or business behavior.

Ask one blocking question per run. If more than one blocker exists, ask the earliest decision that
can change or eliminate the others. A later resumed run may request another clarification.

## Request envelope

When blocked, the implementer's entire final report is exactly one line:

```text
DELEGATE_CLARIFICATION: {"schema":"delegate-clarification.request.v1","id":"q-001","category":"architecture","question":"The requirement permits multiple projects but the schema stores one projectId. Preserve that relationship or migrate it?","context":{"files":["prisma/schema.prisma","src/users/users.service.ts"]},"options":[{"id":"A","label":"Preserve the existing relationship"},{"id":"B","label":"Migrate to many-to-many"}],"recommended":"B","reason":"The requested behavior otherwise cannot be represented.","impact":"Requires a schema migration and query changes."}
```

Fields:

- `schema` — exactly `delegate-clarification.request.v1`.
- `id` — a stable 1–64 character identifier using letters, digits, `.`, `_`, `:`, or `-`.
- `category` — `business_rule`, `architecture`, `migration`, `security`, `scope`, or `other`.
- `question` — the specific decision needed, at most 4,096 characters.
- `context.files` — optional; at most 32 repository-relative paths of at most 1,024 characters each,
  with no empty, `.` or `..` segments.
- `options` — optional; when present, 2–16 uniquely identified choices whose labels are at most 512
  characters.
- `recommended` — optional; must identify one supplied option.
- `reason` and `impact` — optional, but useful when the recommendation or consequences are not
  obvious.

The JSON payload is capped at 32,768 characters; `reason` and `impact` are capped at 4,096 characters
each. Unknown object fields are discarded for forward compatibility. A recognized but malformed,
prose-wrapped, or repeated envelope is a protocol failure: the relay writes `status: "failed"`, exits
1, preserves the final report and any trusted session id, and explains the validation error. It
never silently converts malformed input into completion or partially publishes a request.

A valid request also requires one safe session id captured from Cursor's init or result events, and
all such trusted events must agree. Session-like fields in assistant output or clarification JSON
are untrusted data and cannot select a resume target.

Cursor may aggregate earlier progress text into its closing result field. `cursor-delegate` accepts
that runtime shape only when the final assistant event is itself the exact envelope, the aggregate
ends with it, and the aggregate contains exactly one clarification marker. This does not permit
prose inside the final envelope event or multiple envelopes.

## Answer envelope and resume

The orchestrator may decide directly or wait for a human. Nothing in the protocol requires the
decision to be immediate. Once decided, resume the exact session with a delta brief whose first line
is:

```text
DELEGATE_CLARIFICATION_ANSWER: {"schema":"delegate-clarification.answer.v1","questionId":"q-001","decision":"B","reason":"Approved after architecture review."}
```

Follow it with any implementation constraints introduced by the decision. `questionId` must identify
the request being answered. `decision` is the chosen option id or an unambiguous free-form decision;
`reason` is optional. The answer envelope is implementer context, not a relay command: the relay
preserves it in the resumed run's `brief.txt` and sends it to the existing session. This first
version deliberately does not parse the answer because session selection is the control boundary:
the orchestrator separately passes the validated id from the earlier result. If a future relay
accepts answers as a dedicated option or loads earlier results automatically, request/answer
validation belongs at that new relay boundary.

Prefer an exact session id over "resume latest" behavior. If the session id is missing or invalid,
do not start a fresh run and pretend it is a continuation; recover the id from the earlier
`result.json` or stop. Implementer CLIs remain responsible for rejecting nonexistent sessions.
Each later clarification round repeats this lifecycle with the session id returned by that round.
An unrelated task is a new dispatch with neither `--session` nor `--resume-last`.

## Artifacts and lifecycle rules

Each run keeps the existing per-run artifact layout. Preserve separate output directories across
rounds:

```text
task-artifacts/
  run-01/result.json   # needs_input + request
  run-02/brief.txt     # answer + resumed delta
  run-02/result.json   # completed, needs_input again, or a failure state
```

This records a decision history without adding a cross-run state store. A future history utility can
aggregate these artifacts, but relays should not silently overwrite or manage task-level policy.

Timeout and cancellation keep their existing precedence. If either happens before a successful
terminal report, the relay returns `timeout` or `aborted`, even if partial assistant text resembles a
request. Inspect the working tree and event log before retrying.

Completion still enters the normal independent verification, diff review, orchestrator verdict, and
land cycle. Clarification does not let the implementer approve its own work or expand scope.
