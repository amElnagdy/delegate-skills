# Contributing

Two people have independently built the same delegate skill twice now. Both times someone's work was
wasted. So: **claim an implementer before you build it**, and check the open pull requests first.

[Open claims](../../issues?q=is%3Aissue+label%3Aimplementer) · [Open pull requests](../../pulls)

## What counts as a delegate skill

Four invariants hold for every skill here, and they are the bar for a new one:

- **A separate CLI edits a real working tree, and the diff is the deliverable.** Not an API wrapper,
  not a hosted gateway — an implementer whose work is reviewable with `git diff`. If there is no
  working tree to review, it does not belong here.
- **The relay never commits.** Committing belongs to the reviewer.
- **Node built-ins only.** No dependencies, no network calls of its own, no credentials read or
  written, no telemetry. The relay launches its implementer CLI and `git`, plus the platform process
  launcher where a Windows shim or a process-tree kill needs one.
- **Autonomy is stated in the CLI's own terms**, and whatever it cannot enforce is said plainly. A
  CLI with no read-only mode is mergeable; a skill that implies it has one is not.

## Merge checklist for a new skill

- [ ] `skills/<name>-delegate/SKILL.md` — a `description` that triggers on delegation to that CLI and
      nothing else, plus `compatibility:` naming the binary and its auth step.
- [ ] Four `references/*.md`: `writing-the-brief`, `dispatch-and-poll`, `review-and-land`,
      `multi-task-queues`. Not three, not five — the shape is the contract.
- [ ] One `scripts/relay.mjs`, Node built-ins only, and it never commits.
- [ ] `result.json` speaks `delegate-relay.result.v1`: `status`, `exitCode`, `signal`, the final
      report, `touchedFiles` (`null` when git cannot report, `[]` when the tree is clean), and a
      session id where the CLI exposes one.
- [ ] Usage errors exit 2 before writing a result file; a missing binary exits 127 **with** one.
- [ ] Registered in `test/harness/constants.mjs` — the new relay enters the timeout and abort matrix like
      every sibling. The suite fails if a skill directory is missing from that matrix, is short a
      reference, or is absent from `skills.sh.json`, so this one checks itself.
- [ ] A row in the README table, and a vocabulary row in `AGENTS.md` using that CLI's own terms.
- [ ] An entry in `skills.sh.json`.
- [ ] A verification line in the README's **Verification status** list. Claim only what you ran —
      "contract-tested, live run pending" is a mergeable answer. "Verified" without a run is not.

## Utility skills (exception)

`delegate-setup` is a **utility** skill: it configures fleet **lanes** (discover → propose → approve →
write). It is not an implementer skill.

Utility checklist (instead of the four-references + `relay.mjs` bar above):

- [ ] `skills/<name>/SKILL.md` with a `description` that triggers on setup/configure — **not** on
      ordinary delegation.
- [ ] Scripts under `scripts/` stay Node built-ins only (same trust line as relays).
- [ ] No `relay.mjs`; the skill must not dispatch coding work to an implementer.
- [ ] Registered in `skills.sh.json` (Setup grouping is fine).
- [ ] Listed in the smoke suite's **utility** carve-out (not the `*-delegate` timeout/abort matrix).
- [ ] A short README mention and vocabulary in `AGENTS.md` (`lane`, `fleet`, setup skill).

Do not invent a second utility that duplicates lane setup. Extend `delegate-setup` instead.

## Releases

Install pinning uses **git tags**, not `metadata.version` alone:

1. Land the release on `master`.
2. Set every skill's `metadata.version` to the release semver (e.g. `0.2.0`).
3. Create an annotated tag: `git tag -a v0.2.0 -m "v0.2.0"` and `git push origin v0.2.0`.
4. Users install with `npx skills add amElnagdy/delegate-skills@v0.2.0`.

Bump the tag for user-visible skill or relay contract changes. Docs-only or smoke-only may be a
patch. Schema ids (`delegate-fleet.v1`, …) bump independently when the JSON shape breaks.

## Everything else

Fixes to a relay, a reference, or the README need no claim. Keep the diff to one concern, run
`node test/relay-smoke.mjs` and `npx skills add . --list`, and say in the pull request what you ran.
For a single relay or concern during development, `node test/relay-smoke.mjs --only codex` (comma-separated
module names — see `test/relay/index.mjs`) skips the rest of the matrix.
A changed relay also wants a direct run — `--help` plus a read-only or no-write run against a
throwaway repo. The full pre-publish list is in [AGENTS.md](AGENTS.md).

## Shared relay helpers

Shared relay helpers are byte-identical by CI contract. Edit one relay, run
`node test/relay-parity.mjs`, then paste its helper into the copies the test names.

## Review

One maintainer reviews these and reads the relay line by line. Expect questions about anything the
verification line claims.

Where two pull requests cover the same implementer, this checklist decides — the one that satisfies
more of it merges. Ties break on verification evidence, then on the earlier claim. The other pull
request's distinct improvements get pulled in and credited by number in the commit that lands them.

House rules, the controlled vocabulary, and the pre-publish checklist are in
[AGENTS.md](AGENTS.md) — read it before opening a pull request, and point your agent at it too.
