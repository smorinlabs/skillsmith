# P13 — `dev --source`: create + adopt dev placements (issue #9)

**Status:** Plan for PRD · **Date:** 2026-07-10 · **Planner:** Fable
**Issue:** #9 (record-only adoption) + its create-mode comment
**Consumer:** smorin-harness `skill-create` (drops its `ln -s` step once this ships)

## Goal

`skillsmith dev <name-or-path> --source <path>` becomes the one command that
puts a local checkout's skill into dev mode — creating the symlink(s) when
nothing exists, adopting (record-only) when a matching hand-made symlink
exists, and keeping today's flip behavior otherwise. Closes the gap where the
initial placement required a bare `ln -s` outside skillsmith.

## Semantics (the state machine, per (skill, tool) pair)

| Current placement state | With `--source <path>` | Action | Disk effect |
|---|---|---|---|
| absent | source valid | **create** | staged symlink → placement; ledger dev record |
| dev symlink, target == resolved source, not in ledger | | **adopt** | none — ledger dev record only (the #9 ask) |
| dev symlink, recorded already, target == source | | noop (idempotent) | none |
| dev symlink, target != source | | **refuse** (exit 2) — never silently repoint | none |
| pinned | | today's flip behavior unchanged (`--source` fills a missing record as today; mismatch → refuse) | swap |

Sources are resolved to **absolute** paths before recording (sidesteps the #10
relative-target defect for all new records). Source validation = existing
promote adoption checks (dir exists, `SKILL.md` present).

## PRD open questions (resolve in the PRD, not here)

1. **Codex root for created placements** — legacy `~/.codex/skills` (where the
   whole fleet lives) vs `~/.agents/skills` (current convention). Lean:
   consistency-first — root where the tool's existing skills live, else the
   preferred root; never both (dual-root refusal stands).
2. **Verify gate on create/adopt** — lean: static verify by default (cheap,
   catches the frontmatter class), `--no-verify` escape, `--strict` upgrades
   warnings. Promote's gate semantics reused.
3. **Journal/crash-safety for create** — reuse the WAL/staged-rename machinery
   (new journal op) vs a simpler idempotent create (re-run converges)?
   Rollback of a create = remove symlink + record, or defer to `uninstall`?
4. **FlipReport vocabulary** — new `action` values (`created`, `adopted`) in
   the `skillsmith.flip` JSON contract; schemaVersion bump or additive?
5. **`--all` interaction** — create/adopt are inherently targeted; `--all`
   must not grow these semantics (and #11's `--all` rollback bug argues for
   keeping `--all` untouched here).

## Task breakdown (SDD agent matrix — haiku mechanical · sonnet standard · opus tricky · codex independent · fable plan/gates/final review)

| # | Task | Agent | Done when |
|---|---|---|---|
| T1 | **PRD** — semantics table above + the 5 decisions, JSON contract delta, test matrix; committed to `docs/superpowers/specs/` | fable | PRD approved by Steve |
| T2 | **Failing tests first** — unit tests for every state × tool (create, adopt, noop, refuse-mismatch, pinned passthrough, absolute-resolution, dual-root refusal), ledger-record shape (dev-only record, no pin), `--json` contract | sonnet | Red suite committed on branch `feat/p13-dev-source` |
| T3 | **Core implementation** — `place/plan.ts` pair resolution for absent placements; `place/run.ts` create/adopt paths; ledger write; journal choice per PRD | opus | T2 suite green; `bun run check` green (boundaries respected — core stays CLI-free) |
| T4 | **CLI + contract** — `commands/dev.ts` help text, exit codes, FlipReport rendering; docs page `research/commands/dev.md` updated | sonnet | Help/docs match behavior; contract tests green |
| T5 | **Crash + e2e** — fault-injection on the create path (per P12 precedent); extend the live e2e drift canary with create/adopt cases in a sandboxed `SKILLSMITH_HOME` | sonnet (opus if injection reveals design gaps) | Canary green incl. new cases |
| T6 | **Adversarial review** — full-branch diff review by codex (state machine holes, ledger invariants, boundary rules) + fable whole-branch review | codex + fable | Findings fixed or explicitly waived |
| T7 | **PR + release** — conventional `feat:` PR, CI green, merge; release-please cuts **v0.7.0** | sonnet | Tag exists; `bun run check` green on main |
| T8 | **Downstream: skill-create** — wire step becomes one `skillsmith dev --source` per tool (drop `ln -s` + round-trip); docs page + `_conventions` touch-ups; smorin-harness patch release | sonnet + fable review | skill-create's wire step is a single skillsmith call; live re-wire of one real skill proves it |
| T9 | **Close the loop** — comment + close issue #9; PROJECTS.md P13 flip; memory update | haiku | Issue closed with the shipped semantics |

## Testing strategy

Unit (state machine × tools) → contract (`--json`) → crash injection →
sandboxed live e2e (canary) → **real-world proof**: T8 re-wires one actual
fleet skill through the new path on this machine.

## Risks

- Ledger records without `pinned` are a new shape — audit every reader
  (`plan.ts` selection, rollback planner, doctor/list surfaces) for
  pin-assumptions (T2 encodes this as tests).
- Codex dual-root policy is the one genuinely new policy decision (PRD Q1).
- Scope discipline: no `--all` growth, no install-grammar changes.
