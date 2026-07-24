# P17 preparation checklist

**Status:** pr-openable
**Preparation PR:** #31

This file is the committed preparation closeout record for starting the P17 persistent Codex goal.
Its committed terminal state is `pr-openable`: sections A-H and I01-I03 are checked, their evidence
resolves, the preparation review is closed, and
`bun scripts/check-p17-package.ts --pr-openable` passes. After the PR opens, only the
`Preparation PR` field changes from `pending` to `#N`; `--merge-ready` then proves the exact PR head,
CI, and review closure. I04-I10 are a live PR/merge/handoff runbook. A PR cannot truthfully contain
proof of its own later merge, so `--final` verifies those facts from Git/GitHub after merge without
rewriting this record. The user creates the persistent goal manually in a new thread.

## P17-PREP-A — Project mechanics

- [x] **P17-PREP-A01:** Reserve P17 in `PROJECTS.md` and create the idea record. Evidence: commit
  `2e43a12`.
- [x] **P17-PREP-A02:** Confirm one canonical goal artifact: `projects/P17-GOAL.md`.
- [x] **P17-PREP-A03:** Approve P17 scope, out-of-scope boundary, references, and sign-off model.
- [x] **P17-PREP-A04:** Promote P17 from `[?]` to `[ ]`, finalize its filename, and add the
  canonical References block. Evidence: commit `a3453c2`.
- [x] **P17-PREP-A05:** Create the dedicated PR branch `agent/p17-execution-package`.
- [x] **P17-PREP-A06:** Link the goal, execution, preparation, catalog, checklist, and evidence
  artifacts from the P17 project record without duplicating their contents.
- [x] **P17-PREP-A07:** Confirm every P17 filesystem reference resolves from its containing file.
- [x] **P17-PREP-A08:** Run the project-harness reference-format checks against the promoted file.

## P17-PREP-B — Codex persistent-goal research

- [x] **P17-PREP-B01:** Attempt the official Codex manual helper and record its integrity failure.
- [x] **P17-PREP-B02:** Search official OpenAI documentation for exact `/goal` terminology.
- [x] **P17-PREP-B03:** Write the durable research framing and exact research prompt before the
  fallback research run.
- [x] **P17-PREP-B04:** Complete the official-source/local-capability research output.
- [x] **P17-PREP-B05:** Promote a terminal Codex persistent-goal reference leaf with explicit
  confidence, assumptions, currency, sources, and undocumented boundaries.
- [x] **P17-PREP-B06:** Record the selected bootstrap pattern, runner-up, and why-nots in a research
  decision artifact.
- [x] **P17-PREP-B07:** Update the research index so future sessions reuse the decision.
- [x] **P17-PREP-B08:** Ensure `projects/P17-GOAL.md` follows the verified interface and does not
  claim undocumented slash-command or persistence behavior.

## P17-PREP-C — Consolidated-plan truthfulness

- [x] **P17-PREP-C01:** Correct the plan status to distinguish approved design from executable
  Phase 0 completion.
- [x] **P17-PREP-C02:** Mark the section-level documentation-drift ledger as an open Phase 0 gate.
- [x] **P17-PREP-C03:** Mark the structural validator and verification catalog as open Phase 0
  implementation gates while preserving the completed manual integrity review.
- [x] **P17-PREP-C04:** Add P17 and its goal/execution artifacts to the plan authority hierarchy.
- [x] **P17-PREP-C05:** Preserve the six-stage review order: cross-command, artifact,
  command-surface complexity, architecture/quality, documentation drift, final structure/approval.
- [x] **P17-PREP-C06:** Reconcile every plan statement that currently says no planning or
  documentation gate remains open.
- [x] **P17-PREP-C07:** Preserve the original Phase-0 baseline counts and verify them from the updated plan: 34
  recommendations, 65 phase tasks, 61 phase tests, 157 command tests, 23 commands, 43 findings, 16
  decisions, 10 option gates, and 16 holistic workflows; 425 total tracked entities.
  The approved 2026-07-23 G5-04 amendment adds EWP-CF-044, making the current catalog 426 total and
  44 findings without changing this historical preparation receipt.
- [x] **P17-PREP-C08:** Confirm Phase 7 remains deferred and P14 remains blocked until P17 Phase 6.

## P17-PREP-D — Execution decomposition

- [x] **P17-PREP-D01:** Create `projects/p17/EXECUTION.md` as the dependency-aware execution map.
- [x] **P17-PREP-D02:** Define a stable change-group ID convention and one owner for every group.
- [x] **P17-PREP-D03:** Partition Phase 0 into preparation, drift, catalog, validator, and
  architecture groups, with review/approval/exit owned by the Phase 0 record rather than an empty
  TDD group.
- [x] **P17-PREP-D04:** Partition Phases 1-6 into coherent vertical change groups that can be
  implemented and validated together.
- [x] **P17-PREP-D05:** Keep Phase 7 entries visibly deferred and outside the 1.0 completion set.
- [x] **P17-PREP-D06:** Record group prerequisites as an acyclic dependency graph.
- [x] **P17-PREP-D07:** Map all 65 phase tasks to exactly one primary change group.
- [x] **P17-PREP-D08:** Map all 61 phase tests to exactly one primary change group.
- [x] **P17-PREP-D09:** Map all 157 command tests to exactly one primary change group.
- [x] **P17-PREP-D10:** Map all 10 option gates and 16 holistic workflows to primary groups.
- [x] **P17-PREP-D11:** Map all 23 commands to their implementation, parser, help/docs, completion,
  and workflow coverage groups.
- [x] **P17-PREP-D12:** Map all 43 findings and 16 decisions to implementation and validation
  coverage without treating design acceptance as implementation completion.
- [x] **P17-PREP-D13:** Define phase entry/exit criteria and prevent dependent-group execution
  before prerequisite sign-off.
- [x] **P17-PREP-D14:** Verify no change group is too small to validate coherently or too large for
  independent adversarial review.

## P17-PREP-E — Catalog, generated checklist, and evidence

- [x] **P17-PREP-E01:** Create the machine-readable verification/execution catalog and document its
  schema/version.
- [x] **P17-PREP-E02:** Give every tracked entity one canonical catalog record and reject duplicate
  IDs or primary ownership.
- [x] **P17-PREP-E03:** Define valid states separately for work, validation, design coverage, group
  review, phase review, and deferred items.
- [x] **P17-PREP-E04:** Define evidence fields for red/test-first proof, targeted green, impacted
  green, refactor validation, review, commit, CI, and sign-off.
- [x] **P17-PREP-E05:** Define required-PR, supported-platform, release-only, and deferred tiers.
- [x] **P17-PREP-E06:** Create the exhaustive generated human checklist with one checkbox for every
  tracked entity and every required group gate.
- [x] **P17-PREP-E07:** Generate rollups by phase, change group, command, finding, decision, option
  gate, and holistic workflow.
- [x] **P17-PREP-E08:** Implement or specify the deterministic plan/catalog/checklist round-trip
  validator used as Phase 0's first executable work.
- [x] **P17-PREP-E09:** Reject missing, extra, malformed, orphaned, prose-only, duplicate-owned, and
  skipped-required entries.
- [x] **P17-PREP-E10:** Define append-only per-group evidence records under
  `projects/p17/evidence/` and keep transient logs out of normative files.

## P17-PREP-F — Per-group execution and review protocol

- [x] **P17-PREP-F01:** Define the common group lifecycle: mapped, ready, test-first/red, minimal
  implementation, targeted green, impacted green, refactor, adversarial review, traceability
  closure, signed off.
- [x] **P17-PREP-F02:** Define characterization-plus-negative-boundary evidence for refactors where
  manufacturing a conventional red functional test would be misleading.
- [x] **P17-PREP-F03:** Require a fresh implementation plan or plan amendment before each group.
- [x] **P17-PREP-F04:** Define sub-agent briefs, file ownership, isolation, and result handoff for
  implementation and review work.
- [x] **P17-PREP-F05:** Require an independent Codex adversarial reviewer for every change group.
- [x] **P17-PREP-F06:** Give review findings stable IDs and require fix, disposition, or plan
  escalation before group closure.
- [x] **P17-PREP-F07:** Define adversarial review coverage: contract mismatch, negative paths,
  atomicity/data loss, interruption/concurrency, output/exit semantics, cross-command consistency,
  artifact compatibility, skipped tests, and tests that can pass the wrong implementation.
- [x] **P17-PREP-F08:** Require automated gates plus independent adversarial review for change-group
  sign-off.
- [x] **P17-PREP-F09:** Require explicit user approval at every phase boundary and final P17
  completion.
- [x] **P17-PREP-F10:** Define the correction loop: failed gate or review reopens the group, adds
  evidence, reruns impacted validation, and repeats review before sign-off.

## P17-PREP-G — Canonical goal and resumability

- [x] **P17-PREP-G01:** Create `projects/P17-GOAL.md` with a concise persistent objective and
  unambiguous completion condition.
- [x] **P17-PREP-G02:** Reference the P17 project, consolidated plan, execution map, catalog,
  generated checklist, evidence directory, research decision, and repository instructions.
- [x] **P17-PREP-G03:** State the artifact authority order and prohibit conversational summaries
  from overriding committed contracts.
- [x] **P17-PREP-G04:** Embed the group lifecycle, verification/correction loop, adversarial review,
  sub-agent use, phase approvals, and final sign-off requirements.
- [x] **P17-PREP-G05:** Define safe autonomy boundaries, human-controlled decisions, stop/block
  conditions, and no-unapproved release behavior.
- [x] **P17-PREP-G06:** Define context-compaction and new-turn resume behavior from committed
  catalog/checklist/evidence state.
- [x] **P17-PREP-G07:** Require frequent progress updates and truthful final state, including commit,
  push, PR, merge, and branch status.
- [x] **P17-PREP-G08:** Add the exact one-sentence new-thread bootstrap and keep it independent of
  undocumented file-argument syntax.
- [x] **P17-PREP-G09:** Test the bootstrap in a fresh-context dry run without starting the real goal.

## P17-PREP-H — Preparation validation and adversarial review

- [x] **P17-PREP-H01:** Validate every Markdown link and repository-relative path.
- [x] **P17-PREP-H02:** Run `git diff --check` and repository formatting/documentation gates.
- [x] **P17-PREP-H03:** Run the structural/count/ID validator against the plan and execution
  package.
- [x] **P17-PREP-H04:** Prove every preparation checklist ID is unique and every required item has
  evidence before it is checked.
- [x] **P17-PREP-H05:** Run an independent adversarial review of the full preparation package.
- [x] **P17-PREP-H06:** Record every preparation-review finding and close it through correction or
  explicit disposition.
- [x] **P17-PREP-H07:** Rerun all preparation validations after review corrections.
- [x] **P17-PREP-H08:** Confirm no unrelated worktree file is staged or included in the PR.
- [x] **P17-PREP-H09:** Mark this preparation record complete only after all prior required items
  pass.

## P17-PREP-I — PR readiness and live merge/handoff runbook

- [x] **P17-PREP-I01:** Reconcile the branch with current `origin/main` without losing unrelated
  local work.
- [x] **P17-PREP-I02:** Review the complete candidate-tree diff and stage only the P17 preparation
  package; the resulting commit must match that reviewed tree.
- [x] **P17-PREP-I03:** Run the repository's relevant local checks on the final candidate tree before
  creating the PR.

The remaining items are checked in the live closeout report, not committed back into this file:

- [ ] **P17-PREP-I04:** Push `agent/p17-execution-package` and open the preparation PR.
- [ ] **P17-PREP-I05:** Confirm required CI and review checks pass on the exact PR head.
- [ ] **P17-PREP-I06:** Resolve every actionable PR review thread and rerun affected checks.
- [ ] **P17-PREP-I07:** Merge the PR only after the preparation package and checklist are complete.
- [ ] **P17-PREP-I08:** Verify the merged commit is on remote `main` and the PR is closed as merged.
- [ ] **P17-PREP-I09:** Verify local/remote branch state and report unrelated preserved worktree
  changes explicitly.
- [ ] **P17-PREP-I10:** Hand the user the exact one-sentence bootstrap for the new thread; the user
  manually creates the persistent goal from `projects/P17-GOAL.md`.

## Preparation evidence summary

Populate this table during closeout; do not infer completion from prose.

| Area | Required result | Evidence |
|---|---|---|
| Goal research | Current interface separated from undocumented behavior | research/reference/codex-persistent-goal-2026-07-11.md |
| Project mechanics | P17 promoted and all references resolve | projects/P17-skillsmith-ergonomics-and-declarative-workflow.md; .project-harness/project-harness.config.json |
| Consolidated plan | Status and open Phase 0 gates are truthful | docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md |
| Execution decomposition | Every tracked entity has one coherent group mapping | projects/p17/EXECUTION.md |
| Catalog/checklist | Deterministic, exhaustive, no orphan or duplicate ownership | projects/p17/catalog.json; scripts/p17-catalog.test.ts |
| Group protocol | TDD, review, correction, and sign-off are enforceable | projects/P17-GOAL.md#per-group-tdd-and-verification-loop |
| Goal prompt | Fresh session can initialize and resume from committed state | research/topics/codex-persistent-goal/DECISION.md; projects/P17-GOAL.md#bootstrap-sentence |
| Adversarial review | All preparation findings closed | projects/p17/evidence/preparation-review.md |
| PR/merge | Live merge gates designated: `--merge-ready`, then `--final` | projects/p17/evidence/preparation-review.md#candidate-tree; live gate: --merge-ready then --final |
| Handoff | Manual post-final bootstrap handoff designated | projects/P17-GOAL.md#bootstrap-sentence; manual next step: deliver bootstrap after --final |
