# P19 — Product bug closeout and publication deferral

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Plan:** [Approved execution plan](../docs/superpowers/plans/2026-09-15-p19-product-bug-closeout.md)
- **Tracking:** [Task and issue registry](p19/tasks.json)
- **Tracking:** [P19 issue #51](https://github.com/smorinlabs/skillsmith/issues/51)
- **Tracking:** [Deferred publication umbrella #53](https://github.com/smorinlabs/skillsmith/issues/53)
- **Tracking:** [Execution evidence](p19/EVIDENCE.md)
- **Depends on:** [P17 checkpoint](https://github.com/smorinlabs/skillsmith/tree/5a7418593ecf6a8be4b10d8a5f657bb9e4f0e402)
- **Prior art:** [P17 project](P17-skillsmith-ergonomics-and-declarative-workflow.md)
- **Prior art:** [Codex deep-verifier diagnosis](../docs/codex-deep-verifier-diagnosis.md)
- **Prior art:** [P18 external-schema idea](P18-verify-external-consumer-schema-validation-.md)

**Status:** In progress. Authorized by the user on 2026-09-15: record the reviewed plan as a
project, create its tasks, then implement. P19 does not authorize publication or declare P17 done.

## Outcome and scope

Fix confirmed non-publication product bugs on every affected maintained development line.
Move all publishing and pre-publishing work into open, dependency-linked GitHub issues, preserving
original IDs, phases, decisions, evidence, and immutable source references. Keep release
preparation/publishing held and ordinary CI enabled. P17's original release completion remains
pending; its historical catalog gates are not changed to passing by this deferral.

## Tests & Tasks

- [x] [P19-T01] Preserve and verify P17 checkpoint, current remote main, draft PR #44, existing issues, and branch/worktree state.
- [x] [P19-T02] Record this project, full plan, task registry, acceptance criteria, and provenance.
- [x] [P19-T03] Establish and verify a reversible release hold, including release-please and release PR #34, without disabling ordinary CI.
- [x] [P19-T04] Create P19 tracking and PUB-00 umbrella plus PUB-01 through PUB-08 deferred issues; record real numbers and dependency/back-reference links.
- [ ] [P19-T05] Fix verification aggregation: required incomplete modes/tools cannot be hidden by a pass; preserve genuine failures and optional-tool behavior.
- [ ] [P19-T06] Reproduce and fix large piped JSON truncation (#46), including a slow consumer and compiled binary.
- [ ] [P19-T07] Fix Codex deep loading and bounded sanitized diagnostics without a model turn; validate local protocol capabilities and negative controls.
- [ ] [P19-T08] Fix duplicate inventory/filter/empty-state reporting (#41); reconcile the cross-tool semantic question explicitly; transfer overlapping #46 scope.
- [ ] [P19-T09] Ignore Codex-managed legacy system entries without hiding genuine legacy user skills (#40).
- [ ] [P19-T10] Verify each product fix against current main and P17; apply/adapt to every affected line and record commits and affected contract IDs.
- [x] [P19-T11] Perform bounded Bun isolate diagnosis after the product bug work; preserve the accepted serial runner. Not reproduced in 17 focused files; #57 remains open for a reproducer, with no ownership/fix claim.
- [x] [P19-T12] Reconcile P18, split P13-T06 wiring from downstream publishing, check P09-RV evidence, and preserve completed reconstruction/framework work. Original receipt/owner follow-ups remain #60/#63, not falsely completed work.
- [x] [P19-T13] Update P17 project/goal navigation with the approved pause and issue backlinks; preserve unfinished gates and original completion requirements.
- [ ] [P19-T14] Review changes, correct findings, run target-branch merge gates, integrate only accepted bug/administrative work, and close issues only with verified evidence.
- [ ] [P19-T15] Patch newly confirmed vulnerable parser/tooling dependencies (#65) on both maintained lines, with bounded malformed-TOML rejection, inspected lockfile changes, fresh audit and ordinary gates.
- [ ] [P19-TS01] Every active/deferred/carryover item has a unique owner, acceptance criteria, dependencies, source references, and truthful status.
- [ ] [P19-TS02] Each fixed bug has a failing-before/passing-after regression and affected-line coverage.
- [ ] [P19-TS03] Required ordinary static/tests/build checks pass at exact reviewed commits; deferred release checks are separately identified.
- [ ] [P19-TS04] Remote PR/issue/workflow state is freshly verified; no publication or visibility change occurred; P17 remains pending.

## Deferred task inventory

Creation and traceability are P19 work; execution remains deferred.

- [ ] [P19-PUB-00] Publication umbrella and resume contract.
- [ ] [P19-PUB-01] Release integration, remaining local/CI parity and workflow fixes, release docs and release-code review.
- [ ] [P19-PUB-02] Final-source public-exposure audit, remediation, explicit visibility approval and flip.
- [ ] [P19-PUB-03] Protected environments, least-privilege Apps, Apple authority, runner readiness, immutable releases and npm scope authority.
- [ ] [P19-PUB-04] Approve/implement first-publication npm bootstrap design and recovery; no publication in this task.
- [ ] [P19-PUB-05] Homebrew cask/tap infrastructure and two-architecture macOS CI.
- [ ] [P19-PUB-06] Exact-source candidate/signing/validation, all-authority preflights, all-channel publication and public first-install proof.
- [ ] [P19-PUB-07] Formal G6-04, Phase-6 and P17 release closeout; truthful P14 reconciliation/handoff.
- [ ] [P19-PUB-08] P13-T06 downstream publishing and release-only preparation, dependent on separately assessed wiring/real-skill proof.

These boxes track delivery of the deferred work and stay unchecked while merely transferred.
The registry records whether the tracking issue itself has been created.

## Completion

P19 completes only with fixed, reviewed, validated bugs on affected maintained lines; actionable
linked publication issues; and explicit disposition of every remaining investigation. Do not use
“all bugs fixed” for an unresolved confirmed defect. The intended final report is:
“Product-bug closeout complete; publication and pre-publication work deferred; original P17
release completion remains pending.” Evidence, not this intended wording, determines actual status.
