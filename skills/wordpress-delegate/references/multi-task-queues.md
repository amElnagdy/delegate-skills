# Multi-task queues

The single-task loop scales to a queue, and WordPress work arrives in queues more often than not — a
security remediation list, a plugin-by-plugin compatibility pass, a block migration, a checkout
refactor split across templates. The discipline that makes a queue trustworthy is sequencing and
bookkeeping, not parallelism.

## Run sequentially, one commit per task

Run tasks **one at a time, in dependency order**, landing each (review + gates + commit) before
dispatching the next.

- **Later tasks assume earlier ones landed.** Task 3's brief can say "the `acme_booking_saved` hook
  added in the previous step exists" only if the previous step actually committed.
- **One commit per task** keeps the history reviewable and any single step revertible — which matters
  more on WordPress than most stacks, because the thing you may need to revert is often live.
- **Each review is honest.** A clean tree before each dispatch means the next task's `touchedFiles`
  shows only *its* changes.

Parallelism is occasionally worth it for genuinely independent tasks in separate plugins, but it
sacrifices the clean-tree-per-task property. Default to sequential.

## Let each task route on its own

Do not pick one implementer for the whole queue. Each task gets its own dispatch and its own routing
decision, and a well-split WordPress queue usually spans several lanes:

1. Audit the plugin for nonce and escaping gaps → `security-audit` → `grok`, read-only, findings only.
2. Fix finding 1 → `implementation` → `codex`. Review. Commit.
3. Fix finding 2 → `implementation` → `codex`. Review. Commit.
4. Update the readme and changelog for the release → `documentation` → `kimi`. Review. Commit.

That is the shape the router is built for. The audit that generates the queue is itself the first
dispatch, and it costs nothing to run read-only.

Two things to watch across a queue:

- **Check the routing of each task, not just the first.** A queue derived from one audit can still
  contain a task whose wording routes somewhere surprising. `--dry-run` is cheap; run it over the
  whole queue before starting if you want the routing plan up front.
- **Resume flags are per-implementer.** `implementerSession` from task 2's result resumes *that*
  implementer's session. Pass the matching `--implementer` with it, or the flag goes to the wrong CLI.

## Carry decided constraints forward

Implementation surfaces facts the original plan didn't have: a helper got named, a hook got a
priority, an option key was chosen, a capability was picked. When a later task depends on one,
**fold it into that task's brief** as an explicit line. The implementer has no memory of the earlier
run — and on a queue that spans implementers, it may not even be the same CLI.

The preamble does not carry these forward either. It carries standards, not decisions.

WordPress-specific constraints that almost always need carrying:

- The prefix and text domain actually used, if the codebase was inconsistent and task 1 settled it.
- The exact name, signature, and priority of any hook or filter an earlier task added.
- The option keys and their autoload setting.
- The capability chosen for a permission check, so the whole queue uses one.
- Any deprecation shim left in place, so a later task doesn't remove it as dead code.

## Keep a progress file

For anything longer than two or three tasks — especially a run the human steps away from — maintain a
single progress file alongside the work:

- **Status table** — each task: queued / at-implementer / reviewed+committed (with the commit hash),
  plus **which lane and implementer it routed to**.
- **Per-task review notes** — what landed, what you verified, the gate outcome. One short paragraph.
- **Public surface changed** — a running list of hooks, filters, shortcodes, REST routes, and option
  shapes added, changed, or deprecated across the whole queue. This is the deploy note, and nobody
  can reconstruct it afterwards from ten separate commits.
- **"Needs your eyes"** — design decisions the implementer made, low-confidence routing decisions,
  non-blocking nitpicks. This is the section the human reads first.
- **End-of-run checklist** — what happens after the last task: push, PR, and the manual checks that
  only make sense on a real site (an actual checkout, an actual form submission, the editor loading
  the block).

Update it as each task lands, not in a batch at the end.

## Close with a coherence check

Per-task review proves each step in isolation; it doesn't prove the steps cohere. After the last task:

- Run the full test suite and PHPCS once more on the final tree — not just the last task's slice.
- **Activate the plugin or theme from a clean state** and load the front end and the admin. A queue of
  individually-green commits can still produce a fatal on activation, and no unit test will say so.
- Do a repo-wide check for whatever the queue was about — after a removal, grep for surviving
  references; after a rename, confirm no stragglers in templates or JS.
- For schema work, replay every new migration from a clean database and check for drift, then confirm
  the upgrade routine is safe to run twice.
- Reconcile the public-surface list against the actual diff (`git diff <base>..HEAD`), and put it in
  the PR description. That list is what a site owner needs before deploying.
- Then push and open or update the PR.

## When to stop and ask

Proceed without asking on anything that follows from the agreed plan. Stop and surface when:

- A task can't be completed correctly within its brief's scope — a scope change is the human's call.
- A review finds something that calls the *plan* into question, not just the implementation.
- The gates reveal a problem that affects tasks already "done."
- **A task's routing came back `contested` and the two lanes imply genuinely different work.** That is
  usually a sign the queue was split wrong, and it is cheaper to ask than to land the wrong half.

Then report where you are, what's committed, and what the open question is — and wait.
