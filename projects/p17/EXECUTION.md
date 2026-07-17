# P17 execution map

> P17 disposition: current execution state; authority: projects/p17/catalog.json

**Status:** Phase 0 is `approved`. `P17-G0-01` through `P17-G0-05` are `signed-off`; all group
lifecycle gates are passed. Whole-phase review, catalog recording of standing approval, and exit are
passed. Phase 1 is `approved`; its entry, whole-phase review, standing approval, and exit are passed.
Phase 2 is `approved`; its entry, whole-phase review, standing approval, and exit are passed.
Phase 3 is `approved`; its entry, whole-phase review, standing approval, and exit are passed.
Phase 4 is `active`; its entry gate is passed.
`catalog.json` is the machine-readable status authority.

This file groups the consolidated plan into reviewable changes. It does not replace product
contracts in the consolidated plan or status in `catalog.json`. `CHECKLIST.md` is generated from
the catalog and must never be edited by hand.

## Control model

```text
consolidated product plan
          |
          v
catalog.json --validated/rendered--> CHECKLIST.md
     |                                  |
     +--> change-group evidence --------+
                     |
                     v
             phase/final sign-off
```

The catalog tracks 425 entities: 34 P0-P3 recommendations, 65 phase tasks, 61 phase tests, 157
command tests, 10 option gates, 16 holistic workflows, 23 commands, 43 accepted findings, and 16
decisions. The 34 recommendations are included explicitly even though the earlier 391-entity
summary omitted them; this prevents the original P0-P3 source inventory from disappearing behind
later phase tasks.

Every validation relationship is retained in `impactedValidations`. A group’s
`requiredNowValidations` are owned by that group or a signed dependency and must pass at its
impacted-green gate. `downstreamCoverage` records immutable future-group obligations without
forcing later-phase implementation early; those validations must pass in their owning groups and
all must be signed before final review. Actual validation targets are structured records containing
a repository-contained executable file, exact validation-ID selector, runnable command, and an
ID-bound execution receipt; a prose path or existence-only placeholder cannot advance status.

## Required change-group lifecycle

The canonical lifecycle, reopening rule, TDD semantics, and sign-off contract live in
[`P17-GOAL.md`](../P17-GOAL.md#per-group-tdd-and-verification-loop). The catalog mirrors those ten
ordered gates with evidence-bearing state records; this execution map owns only group boundaries and
dependencies. A lifecycle change amends the goal first, then the catalog schema/checker and generated
view in the same reviewed change.

## Agent protocol

- A group starts with a written implementation plan or explicit amendment to an existing plan.
- Implementation and adversarial review use different Codex agents or contexts.
- Each sub-agent brief names allowed files, mapped IDs, prerequisite evidence, required tests, and
  a thin result format. Agents do not infer permission to edit outside their group.
- Parallel work is allowed only for dependency-independent groups with disjoint file ownership or a
  predeclared integration owner.
- Review agents read the contract and tests independently, search for counterexamples, and do not
  inherit the implementer's conclusion as fact.
- Conversation is not execution state. Catalog status, committed evidence, tests, commits, and PR
  checks are the resumable record.

## Evidence protocol

Each group owns an append-only `projects/p17/evidence/<group-id>.md` record containing:

- mapped IDs and dependency versions;
- test-first or characterization/boundary evidence;
- targeted and impacted commands plus results;
- implementation and refactor commits;
- adversarial-review prompt/context, findings, dispositions, and rerun evidence;
- catalog/checklist validation output;
- group sign-off identity and timestamp.

Transient full logs remain CI artifacts or temporary files; the evidence record retains stable
commands, summaries, hashes, and links needed to reproduce the result.

## Change groups

The baseline contains 45 groups: 44 required Phase 0-6 groups and one explicitly deferred Phase 7
group.

| Group | Phase | Depends on | Coherent outcome |
|---|---:|---|---|
| P17-G0-01 | 0 | — | Governance, authority, accepted-decision/finding traceability, and truthful counts |
| P17-G0-02 | 0 | G0-01 | Live-to-target CLI migration ledger and complete parser/option ownership |
| P17-G0-03 | 0 | G0-01 | Artifact terminology, dependency order, and architecture/quality reconciliation |
| P17-G0-04 | 0 | G0-02, G0-03 | Section-level documentation-drift ledger and authoritative-document closure |
| P17-G0-05 | 0 | G0-01, G0-02, G0-03 | Catalog, structural validator, generated checklist, and executable ownership |
| P17-G1-01 | 1 | — | Shared project context, config resolution, target/scope selection, and bounded defaults |
| P17-G1-02A | 1 | — | Shared error/output boundary, exit precedence, and non-mutating mode policy |
| P17-G1-02B | 1 | G1-02A | `check`/doctor gate semantics and report-only behavior |
| P17-G1-02C | 1 | G1-01, G1-02A | Current help/docs migration and legacy project-config warning boundary |
| P17-G1-03 | 1 | G1-01, G1-02A, G1-02B, G1-02C | Declarative command specifications, shared CLI runtime, and application-service boundary |
| P17-G1-04 | 1 | G1-03 | Capability-scoped ports, typed configuration, and compatibility facade |
| P17-G1-05 | 1 | G1-03 | Executable tool-adapter/capability registry and current verify behavior |
| P17-G1-06 | 1 | G1-03 | Canonical codecs, DTO mappings, and public wire-contract registry |
| P17-G1-07 | 1 | G1-03 | Operation-scoped observation, correlation, redaction, and verbosity behavior |
| P17-G2-01 | 2 | G0-01, G0-02, G0-04, G0-05, G1-04, G1-05, G1-06, G1-07 | Manifest discovery, ownership, unified schema, identity, and artifact-pair selection |
| P17-G2-02 | 2 | G2-01 | Portable lock schema, semantic hashes, canonicalization, and manifest relationship |
| P17-G2-03 | 2 | G2-01, G2-02 | Lossless human-file editing, atomicity, portability, and secret-redaction boundary |
| P17-G2-04 | 2 | G2-01, G2-03 | Pure init request/skeleton/migration operation model without early execution |
| P17-G2-05 | 2 | G2-02, G2-03, G2-04 | Versioned manifest/lock/plan/ledger/journal codecs and migration repositories |
| P17-G3A-01 | 3A | G2-05 | Canonical correlated read model and status state-product surface |
| P17-G3A-02 | 3A | G3A-01 | Deterministic agents/list/commands inventory, duplicates, and capability presentation |
| P17-G3B-01 | 3B | G3A-02 | Immutable operations/results and migration of current mutator planning/dry-run paths |
| P17-G3B-02 | 3B | G3B-01 | Lock hierarchy, deterministic scheduler, coordinator, and partial-pair semantics |
| P17-G3B-03 | 3B | G3B-02 | Ledger writer, journals, recovery/resume/abort, history, and deterministic repair |
| P17-G3B-04 | 3B | G3B-02 | Immutable snapshots, pure planners, repositories, expected revisions, and extraction |
| P17-G3B-05 | 3B | G3B-01 | Tool-specific lifecycle behavior behind registered adapter bundles |
| P17-G3B-06 | 3B | G3B-02, G1-07 | Operation context and lifecycle events through execution and recovery |
| P17-G4A-01 | 4A | G3B-03, G3B-04, G3B-05, G3B-06 | Install/uninstall default-save, no-save, ownership, and artifact reporting |
| P17-G4A-02 | 4A | G3B-03, G3B-04, G3B-05 | Export classification, safe merge, portable intent, and writer integration |
| P17-G4A-03 | 4A | G2-04, G3B-03, G3B-04 | Planned init registration with preview/execution identity and manifest-only effects |
| P17-G4A-04 | 4A | G4A-01, G4A-02, G4A-03 | Multi-source/tool partial-success, crash, and commit-boundary semantics |
| P17-G4B-01 | 4B | G4A-04 | Desired/current planner, prune selection, renderers, check exits, and idempotence |
| P17-G4B-02 | 4B | G4B-01 | Saved-plan schema, exact apply, approval, scoped staleness, and validation modes |
| P17-G4B-03 | 4B | G4B-02 | Lock update policy, cross-machine reproduction, crash recovery, and secret safety |
| P17-G5-01 | 5 | G4B-03 | Direct sync endpoints, selection, save/delete semantics, and operation equivalence |
| P17-G5-02 | 5 | G4B-03 | Update discovery, check/preview/apply, refs, pins, and retention |
| P17-G5-03 | 5 | G4B-03 | Scope-aware pending abort and committed undo with compatibility routing |
| P17-G5-04 | 5 | G4B-03 | Ledger-authoritative reachability, retention, explicit forget, and safe GC |
| P17-G5-05 | 5 | G5-01, G5-02, G5-03 | Shared bulk approval, fail-fast/continue scheduling, cancellation, exits, and final artifact-option closure |
| P17-G6-01 | 6 | G5-04, G5-05 | Native assets, checksums, Homebrew/npm distribution, and clean installs |
| P17-G6-02A | 6 | G5-04, G5-05 | Shared command metadata, five-group help, progressive options, workflows, and generated docs |
| P17-G6-02B | 6 | G6-02A | Bash/zsh/fish completion generation and nested completion contracts |
| P17-G6-03 | 6 | G5-04, G5-05 | Rendering matrix, legacy cleanup, versions/capabilities, install/upgrade docs |
| P17-G6-04 | 6 | G6-01, G6-02A, G6-02B, G6-03 | Canonical PR/release recipes, exact-SHA publication gate, and final 1.0 evidence |
| P17-G7-01 | 7 | G6-04 | Explicitly deferred P3 specifications/projects; not required for P17 or 1.0 |

## Phase gates

- A phase cannot start until every dependency from the prior phase is signed off.
- A phase cannot close while any entity owned by that phase's required groups is planned, red,
  failed, skipped, unmapped, or missing evidence. Required downstream entities remain planned under
  their later owning phases and do not falsely block the current phase.
- Each phase receives an independent whole-phase adversarial review after its groups pass.
- The user explicitly approves each Phase 0-6 boundary. Phase 7 is not a P17 completion gate.
- Final P17 completion additionally requires all 23 commands and all non-deferred recommendations,
  findings, decisions, tests, option gates, and workflows to roll up as signed off; exact
  `just check` and `just release-check` evidence; and an explicit user approval before P14.
