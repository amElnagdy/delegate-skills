# Review and land

The implementer did the typing; you own the judgment. This is where delegation earns its keep or
quietly ships a mistake — and WordPress is unusually good at hiding mistakes behind a green test
suite, because most of what goes wrong is a missing check rather than a wrong answer.

The discipline: **verify against reality, never against the self-report.**

## Start with the routing decision

This skill picks the implementer for you, so the first thing to review is that pick.

`result.json`'s `routing` block records the lane, the confidence, the signals that matched, and the
runners-up. Read it before the diff:

- **`confidence: "high"`** — two or more signals agreed. Proceed to the normal review.
- **`confidence: "low"` or `"none"`** — the router guessed. Read the diff against *what the user
  asked for*, not against what the lane assumed. A brief that fell through to `implementation` and
  came back with an audit-shaped answer is a routing miss, not an implementation failure.
- **`confidence: "contested"`** — the brief read as two kinds of work at once. That usually means the
  brief should have been two briefs. Check that the run did the half you cared about.
- **`matchedSignals` naming something you did not mean** — e.g. an offhand "for performance reasons"
  routing a bugfix into the performance lane. Re-dispatch with `--implementer` or `--lane`.

Report a below-`high` routing decision to the user as one of the things you surfaced. They opted into
delegation; they did not opt into a keyword scan choosing the agent silently.

## Check the tests before trusting the gates

If the diff touches existing tests, review those edits *first* — before the gate re-run means
anything. A weakened assertion, an added skip, or a deleted test makes the gate measure less than it
did before the run.

- **Unbriefed edits to existing tests are a contract change, not part of the fix.** Flag them.
- **Skipped or commented-out tests added in this diff:** treat the underlying test as failing.
- **Loosened assertions:** same treatment.

## Re-run the gates yourself

Re-run the project's actual commands — `vendor/bin/phpunit`, `vendor/bin/phpcs --standard=WordPress`,
`npm run build`, whatever the brief named — and read the output. **Passing is necessary, not
sufficient.** PHPCS with the WordPress standard catches a good deal of the escaping and prefixing
rules mechanically; it catches none of the authorization ones.

## The WordPress sweep

Walk these against every diff before you commit. Each can sit in a diff whose tests are all green,
and most of them are invisible to PHPCS.

**Authorization and input**

- **A nonce without a capability, or a capability without a nonce.** Both, on every state-changing
  request. `check_ajax_referer()` proves the request came from your page; it proves nothing about who
  the user is.
- **`current_user_can()` with the wrong capability** — `manage_options` where an editor should
  qualify, or an author-level capability guarding a site-wide setting.
- **Unescaped output.** Every echo of a variable, at the point of output: `esc_html`, `esc_attr`,
  `esc_url`, `wp_kses_post`. Escaping at assignment and echoing later is the classic near-miss.
- **`$wpdb` interpolation.** `prepare()` for every value, including in `ORDER BY` and `LIMIT` clauses
  built from input. A `prepare()` call whose placeholders don't match its arguments silently produces
  the wrong query.
- **Missing `wp_unslash()`** before sanitizing a superglobal, which quietly corrupts quoted input.
- **REST routes with `permission_callback` set to `__return_true`** on anything that is not genuinely
  public.

**Platform**

- **A core, plugin, or theme file edited in place** rather than extended through a hook. Check
  `touchedFiles` for paths outside the brief's scope.
- **A hand-rolled equivalent of an existing API** — cURL instead of `wp_remote_get()`, direct
  filesystem writes instead of `WP_Filesystem`, a custom cron loop instead of `wp_schedule_event()`.
- **Unprefixed globals** — a function, class, constant, option, or hook name without the project's
  prefix is a collision waiting for the next plugin.
- **Scripts or styles printed rather than enqueued**, or enqueued on every page instead of the one
  that needs them.
- **Strings without a translation function, or with the wrong text domain.** A hardcoded domain
  string that doesn't match the plugin's own silently drops the translation.

**Data and compatibility**

- **A public hook, filter, shortcode, REST route, or option shape changed without a deprecation
  shim.** This is how a WordPress change breaks code you don't own.
- **`update_option()` on a large value without `false` for autoload**, or a new autoloaded option
  that gets read once a month.
- **Direct post-meta access to WooCommerce orders** — under HPOS the post tables are not the source
  of truth. CRUD objects (`wc_get_order`, `$order->save()`) or nothing.
- **A schema change without a version-gated upgrade routine**, or one that isn't safe to run twice.
- **An unguarded dependency on another plugin** — a call into ACF, Elementor, or Woo with no
  `function_exists` / `class_exists` guard and no graceful degradation.
- **A query added inside a loop**, or a `meta_query` on a hot path that will not survive real data
  volume.

**The generated-code sweep** (these are not WordPress-specific, and they still apply)

- **Hardcoded success or fixture data** on a path the brief says does real work.
- **Catch-all error handling that returns a default** instead of propagating.
- **Unverified imports and API calls** — confirm every function exists in the *installed* version of
  the plugin being extended, not just in its current documentation.
- **Dead weight** — unused imports, helpers nothing calls, comments restating the line below.
- **Speculative surface** — options, filters, or abstractions with no caller in this diff.
- **New tests that assert internals**, or near-duplicate test bodies differing by one value.

Anything the sweep catches goes back as a delta brief (below) or gets fixed in the tree before commit
— and either way is reported to the user.

If the `guard-skills` package is installed, run the relevant guard on the diff for the full treatment.
The sweep above is the built-in floor.

## Verify a read-only run was read-only

The `security-audit` and `research` lanes run read-only, and read-only means different things by
implementer. Grok's is **best-effort**: it cannot be prevented from writing headlessly, so the
sibling snapshots the tree and sets `readOnlyViolation: true` when a read-only run wrote anyway.
Check `implementerResult.readOnlyViolation` and confirm `touchedFiles` is `[]` — do not assume. If
you need the guarantee enforced, route the audit to `codex`, whose sandbox does enforce it.

An audit that wrote files is not an audit that helpfully fixed things; it is a run that ignored its
mode, and its findings deserve the same scepticism.

## The commit boundary

When the gates pass and the diff holds, **you commit** — never the implementer. Committing should be
the act of the party that verified the work.

From dispatch until that commit, the uncommitted working tree is the authoritative copy of the
implementer's work. Never run `git checkout`, `reset`, `clean`, or a branch switch in the workspace
between those two points — however messy an interrupted run looks, inspect it first: `git status`,
`git diff`, `git diff --cached` for anything staged, and open any untracked files (`??`) directly,
since no diff shows their contents. The tree is evidence, not clutter. After that inspection the
verdict can legitimately be to discard; the ban is on reflexive cleanup before anyone has looked.

## Reworking: send the delta, not the whole task

If the review turns up problems, don't restate the entire brief. Continue the same session with just
the correction:

```bash
echo "The nonce check is right, but esc_attr on line 84 should be esc_url — it's a redirect target." \
  | node "<skill-dir>/scripts/relay.mjs" --implementer codex --session <implementerSession> --cd /path/to/plugin
```

Take `<implementerSession>` from the prior `result.json`. Pass the same `--implementer` you routed to
the first time, or the resume flag will be sent to the wrong CLI. The relay skips the preamble on a
resumed run — the session already carries it — so a short delta is genuinely short.

Then review again: rework gets the same gate re-run, test check, diff read, and WordPress sweep as the
original. Repeat until it's right, then commit.

## Surface, don't absorb

The human opted into delegation, so committing verified, gate-passing work is the agreed contract.
Keep them in the loop on anything that changes the shape of the work:

- **Report the routing decision** when confidence was below `high`, and which implementer ran.
- **Report design decisions** the implementer made, and any defensible-but-unrequested turns.
- **Report every public-surface change** — new or changed hooks, filters, shortcodes, REST routes,
  and option shapes. In WordPress this is the blast radius, and it is the thing a site owner most
  needs to know before deploy.
- **Note non-blocking nitpicks** you chose not to block on, so they can overrule you.
- **Stop and ask** if correct completion requires going beyond the brief.

For a multi-task run, capture these in the progress file rather than letting them scroll past — see
[multi-task-queues.md](multi-task-queues.md).
