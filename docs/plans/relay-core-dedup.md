# Plan: relay dedup — drift reconciliation + parity gate

> **Status:** IMPLEMENTED (PR #50). Adopted 2026-08-04.
> Supersedes the v1 build-time code-gen plan (condensed in the appendix — kept so the
> analysis isn't lost). v1 was fact-checked against the tree, then both plans were
> debated via a read-only Codex adjudication; v2 won on all five contested points.
> Related: issue #42 (split the 2,191-line smoke suite).

## Goal

Ten `skills/<name>-delegate/scripts/relay.mjs` (~7,249 lines total) share ~80–90%
near-verbatim boilerplate, and the shared helpers have drifted. Shipped relays cannot
shrink (see packaging constraint below), so the real problem is drift, not duplication:
fix the divergences once, then make drift impossible to land. No generator, no shared
source dir — the relays themselves stay the source; a fast CI parity test proves they agree.

## Verified drift facts (byte-checked 2026-08-04, branch `feat/consent-scope`)

v1's evidence came from diffing claude vs codex only and assumed the other 8 matched
claude. They match codex. Corrected picture:

| Symbol | Reality |
|---|---|
| `killChild(child, signal)` | null-guard `if (!child \|\| !child.pid) return;` exists **only in claude**; 9/10 lack it. Bodies otherwise semantically identical (formatting/comments differ). |
| `gitTouchedFiles(cwd)` | `stdio: ["ignore","pipe","ignore"]` **only in claude**; 9/10 omit it. Found in PR #50 review: **only vibe** bounded the probe (`timeout` + `killSignal: "SIGKILL"`); the canonical body now bounds it for all 10. |
| `parseDuration(duration)` | BigInt variant with in-function `MAX_TIMER_MS` ceiling in **8/10**; agy and pi use the Number variant with call-site-only guards. |
| `MAX_TIMER_MS` | defined in 9/10; pi inlines `2_147_483_647` instead. |
| `writeJsonAtomic` | named helper **only in claude** (`${path}.tmp-${pid}`); 9/10 inline temp+rename (`${path}.${pid}.tmp`). |
| `makeEventScanner(onObject)` | present in 7/10 (claude, cursor, grok, kimi, opencode, pi, qoder); the 7 copies **not yet mutually diffed**. |

## The plan — two commits

### Commit 1 — reconcile (all behavior changes, smoke-gated once)

Paste claude's version byte-identical (comments included) into the others:

- `killChild` with the null-guard → 9 relays (strict bugfix: others throw on a null child).
- `gitTouchedFiles` with the stdio option → 9 relays (silences git stderr noise).
- BigInt `parseDuration` → agy + pi; add `MAX_TIMER_MS` const to pi (adds the overflow
  guard both lack in-function).
- `makeEventScanner`: mutually diff the 7 copies **first**; if identical modulo
  formatting, normalize to one implementation; otherwise leave it out of parity and note why.

Gate: full `node test/relay-smoke.mjs` on the complete change (one slow run, not five).

### Commit 2 — parity gate + packaging check (fast, mechanical)

New `test/relay-parity.mjs` (~60 lines, Node built-ins, runs in milliseconds):

- For each symbol — `MAX_TIMER_MS`, `parseDuration`, `killChild`, `gitTouchedFiles`,
  plus `makeEventScanner` iff normalized in commit 1 — extract its source from every
  relay and assert all copies byte-equal.
- **Extractor (hardened per adjudication):** anchor at the top-level declaration
  (`function name(` / `const name =` at column 0) and slice to the *next* top-level
  function declaration or EOF; require exactly one match per symbol per relay, else fail.
  Never "slice to the next `\n}`" — nested braces/strings/the closure-returning scanner
  would mis-slice. Deliberately format-sensitive: byte parity is the contract.
- **Isolated-install check (new — neither plan had it):** for each delegate skill, copy
  its directory alone to a temp dir and run `relay.mjs --help` there. `node --check`
  doesn't resolve imports and full-repo smoke masks accidental cross-directory imports,
  so the repo's central constraint (single-skill install loads standalone) is otherwise
  never continuously proven.
- Wire into `.github/workflows/relays.yml` **before** the smoke job.
- CONTRIBUTING.md: editing a shared helper = edit one relay, let parity name the stale
  copies, paste. Acceptable because these helpers have near-zero edit traffic.

## Deliberately not doing (and when to revisit)

- **No generator / `shared/` fragments / markers** — permanent build machinery for
  helpers that essentially never change. Revisit only if parity failures become frequent
  enough that the N-file paste genuinely hurts; nothing here is thrown away in that case
  (reconciliation + gate are prerequisites of the generator anyway).
- **`writeJsonAtomic` stays inlined** — one call site per relay, no bug, no active
  drift; consolidating just enlarges the behavior batch. Revisit on a second write site
  or a semantics change.
- **No helper unit tests / no eval-extracted-source harness** — smoke already exercises
  timeout/kill/parsing paths; add a targeted black-box regression only when a real
  defect shows a gap.
- **No `runRelay(config)` skeleton, no signal-loop extraction** — closes over ~10
  locals, shipped files can't shrink anyway; duplication that can't drift is just disk.

## Verification (acceptance criteria)

- `node test/relay-parity.mjs` exits 0; deleting the guard from any one relay makes it exit 1.
- `node test/relay-smoke.mjs` green after commit 1 (incl. agy `--print-timeout`, pi
  timeout validation, codex timeout/abort paths).
- Isolated-install `--help` check green for all 10 delegate skills.
- `node --check` on every relay.mjs; relays.yml green on ubuntu + windows (the
  reconciled `killChild`/`gitTouchedFiles` touch the win32 path).
- `npx skills add . --list` still shows 11 skills.

## Packaging constraint (verified — why relays stay self-contained)

A skill installs one directory at a time (`npx skills add <repo> --skill codex-delegate`
copies only `skills/codex-delegate/`). No node_modules, no bundling, no dependency
frontmatter. A plain cross-directory `import` hard-crashes a single-skill install. The
one existing cross-dir dependency (`*-delegate` → `delegate-setup/scripts/lane.mjs`) is
an `existsSync`-gated `spawnSync` on the optional `--lane` path; the watchdog/`killChild`
run every invocation and can't degrade that way. Commit 2's isolated-install check turns
this constraint from prose into CI.

---

## Appendix — superseded v1: build-time code-gen (mechanism A)

Proposed: canonical fragments in `shared/core/*.mjs` + a generator (`gen-relay.mjs
--write|--check`) inlining them into marker blocks in each relay; 5 staged smoke-gated
commits; unit tests on the fragments. Alternatives it rejected still stand rejected:
B (per-skill `_core.mjs` copy), C (bundler — violates no-deps), D (runtime shared skill —
breaks single-skill install), E (data-only, ~10% win).

Why v2 superseded it:

1. **Evidence sampling error.** Byte-diffed claude vs codex only; assumed the other 8
   matched claude when they match codex. Its "low-risk, no behavior change" batch was
   false (9 relays receive behavior changes, not just codex) and its counts were off
   (claimed 9/10 BigInt; reality 8/10 — pi is also Number-variant).
2. **Cost/benefit.** Generator + fragment dir + marker convention + dep map + "never
   edit the relay" rule, purchased for edit-once ergonomics on helpers with no edit
   traffic. The CI gate — the part that actually prevents drift — exists in v2 at ~60 lines.
3. **Latent defect (found in adjudication).** Fragments were specced as standalone
   testable modules, but the generator only strips `export` — fragment imports would
   collide with relay imports when inlined.
