# Task 3 report: resilient-delegate validation

## Scope and status

Validation completed without global installation, credential changes, or cloud
model use. One evidence-backed Task 2 documentation correction was made: the
main `SKILL.md` now states the terminal stop categories and the hard GPT-6
Astra `low`/`medium` cap explicitly.

## Structural and deterministic validation

- `npx skills add . --list` validated the local package and reported 19
  discoverable skills, including `resilient-delegate`.
- `node test/relay-smoke.mjs --only resilient-delegate` passed all 26 focused
  behavioral checks.
- `node test/relay-smoke.mjs --only package-shape` passed.
- The complete `node test/relay-smoke.mjs` suite completed within the practical
  60-second watchdog (about 30 seconds on both runs). No real failure was
  observed; the attempted tail-only capture emitted no text, so it is not used
  as stronger per-check evidence than the direct focused output.
- `node --check skills/resilient-delegate/scripts/resilient.mjs` and
  `git diff --check` passed.

## Built-in profile audit

The programmatic source audit found exactly three Codex candidates:

| Profile | Model | Effort |
| --- | --- | --- |
| routine | gpt-5.6-terra | medium |
| complex | gpt-5.6-sol | medium |
| critical | gpt-6-astra | medium |

The audit returned `allLowOrMedium: true` and
`astraNeverAboveMedium: true`.

## Local Qwen pressure scenarios

Hermes one-shot was non-evidentiary: it returned no stdout after about 30
seconds. Hermes and Ollama were both present, and `ollama list` confirmed the
local `qwen3-coder:30b` model. Five direct `ollama run qwen3-coder:30b` calls
were then run once each with a 45-second cap; all completed in 4–13 seconds.
No cloud fallback was used.

1. Aider 429 followed by Codex completion: Qwen chose failover while preserving
   the diff and not committing — matches the controller.
2. `aider_unavailable` plus `Permission denied`: after self-correction, Qwen
   chose stop/no failover — matches semantic-failure precedence.
3. Nonzero child with no result and no infrastructure evidence: Qwen chose
   stop as malformed result — matches the controller.
4. Dirty tree without `--allow-dirty`: Qwen chose abort/reject — matches the
   controller.
5. Astra at high effort: Qwen incorrectly advised proceeding. This exposed
   that the primary `SKILL.md` did not itself state the cap; the controller and
   configuration reference already rejected it. The skill now explicitly says
   to reject Astra above medium. Per the bounded-validation instruction, this
   scenario was not retried.

## Baseline comparison

The pre-skill Task 1 state had no controller and therefore could not enforce
failover boundaries, dirty-tree rejection, or the Astra cap. The current
focused behavioral suite proves those safety decisions for 429, permission,
malformed output, dirty trees, and Astra efforts. The local pressure pass also
found and corrected the only instruction-surface inconsistency: Astra’s cap is
now visible in the main skill, not only in its reference and implementation.

## Remaining risk

The corrected Astra sentence was not re-run through Qwen because the task
limited the local pressure run to five single attempts. The deterministic
controller test already covers both rejected high/xhigh and accepted low/medium
Astra configurations. Real authenticated provider dispatch remains outside
this validation-only scope.
