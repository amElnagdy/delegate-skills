# Resilient Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a tested local-first delegation controller with provider-aware failover and conservative Codex effort settings.

**Architecture:** Add one utility skill, `resilient-delegate`, whose Node relay invokes existing implementer relays from an ordered profile. It classifies only capacity and infrastructure failures as failover-safe, preserves the working diff for continuation, and writes an aggregate result without committing.

**Tech Stack:** Node.js built-ins, Git, existing delegate relay scripts, JSON configuration, PowerShell for local installation verification.

**Spec:** `docs/superpowers/specs/2026-09-10-resilient-delegation-design.md`

## Global Constraints

- Node.js 18+ and Git only for the new controller.
- No relay or controller may commit.
- Codex Astra effort is capped at `medium`; configured Codex profiles use only `low` or `medium`.
- Automatic failover is limited to observable capacity and infrastructure failures.
- A clean Git working tree is required by default.

---

### Task 1: Register the utility and its behavioral test harness

**Files:**
- Modify: `test/relay/package-shape.mjs`
- Modify: `test/relay/index.mjs`
- Create: `test/relay/resilient-delegate.mjs`
- Modify: `skills.sh.json`

**Interfaces:**
- Consumes: the existing smoke harness and fake CLI conventions.
- Produces: a smoke runner named `resilient-delegate` and package registration for the utility.

- [ ] Write tests for successful first-candidate completion, 429 failover, unavailable-CLI failover, non-capacity failure stop, aggregate result shape, dirty-tree rejection, and the Astra effort cap.
- [ ] Run the focused smoke module and confirm it fails because the utility is missing.
- [ ] Register the utility in package-shape and the package manifest.
- [ ] Run the focused package-shape test.

### Task 2: Implement the resilient controller

**Files:**
- Create: `skills/resilient-delegate/scripts/resilient.mjs`
- Create: `skills/resilient-delegate/SKILL.md`
- Create: `skills/resilient-delegate/references/configuration.md`

**Interfaces:**
- Consumes: `--brief`, `--cd`, `--profile`, optional `--config`, `--timeout`, `--out-dir`, and `--allow-dirty`.
- Produces: `<out-dir>/result.json` with `status`, `selectedImplementer`, `stopReason`, `attempts`, and `touchedFiles`.

- [ ] Implement argument validation and clean-tree preflight.
- [ ] Implement profile loading with a built-in local-first default and strict validation.
- [ ] Reject any Codex Astra candidate whose effort is not `low` or `medium`.
- [ ] Invoke existing relays without a shell and give each attempt its own artifact directory.
- [ ] Classify capacity/infrastructure failures and stop on all other failures.
- [ ] Append a bounded continuation note for later candidates.
- [ ] Write the aggregate result atomically and never commit.
- [ ] Run the focused tests until green, then refactor while keeping them green.

### Task 3: Validate the skill behavior

**Files:**
- Modify only files from Task 2 if observed behavior exposes a gap.

**Interfaces:**
- Consumes: realistic routine, complex, and critical dispatch scenarios.
- Produces: verified skill decisions that preserve the effort cap and failover boundary.

- [ ] Validate skill frontmatter and structure.
- [ ] Run behavioral pressure scenarios with and without the skill instructions.
- [ ] Confirm the configured profiles never place Astra above medium.
- [ ] Run the complete relay smoke suite and inspect the working-tree diff.

### Task 4: Install and configure the local workflow

**Files:**
- Create or update the user's installed skill directories through the Skills CLI.
- Create the global resilient profile config with no secrets.

**Interfaces:**
- Consumes: installed `codex`, `agy`, `copilot`, `hermes`, `ollama`, and `qwen3-coder:30b`.
- Produces: discoverable delegation skills and a validated local-first profile.

- [ ] Install Aider in an isolated user tool environment.
- [ ] Install the tested delegation package globally.
- [ ] Write the exact approved resilient profile configuration.
- [ ] Verify skill discovery from Codex and Hermes.
- [ ] Run read-only/local dry-run smoke checks that do not modify a user project.
- [ ] Report any OAuth or subscription step that still requires interactive user action.

