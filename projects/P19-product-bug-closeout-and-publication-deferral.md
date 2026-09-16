# P19 — Product bug closeout and publication deferral

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Plan:** [Approved execution plan](../docs/superpowers/plans/2026-09-15-p19-product-bug-closeout.md)
- **Tracking:** [Task and issue registry](p19/tasks.json)
- **Tracking:** [P19 issue #51](https://github.com/smorinlabs/skillsmith/issues/51)
- **Tracking:** [Deferred publication umbrella #53](https://github.com/smorinlabs/skillsmith/issues/53)
- **Tracking:** [Execution evidence](p19/EVIDENCE.md)
- **Tracking:** [Review disposition](p19/REVIEW.md)
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
- [ ] [P19-T08] Integrate duplicate inventory/filter/empty-state fixes; deliver informational cross-tool name reporting in a separate follow-up PR under #41 (Q1.A). Preserve per-tool conflicts and the overlapping #46 ownership; keep #41 open until all acceptance is met.
- [ ] [P19-T09] Ignore Codex-managed legacy system entries without hiding genuine legacy user skills (#40).
- [ ] [P19-T10] Verify each product fix against current main and P17; apply/adapt to every affected line and record commits and affected contract IDs.
- [x] [P19-T11] Perform bounded Bun isolate diagnosis after the product bug work; preserve the accepted serial runner. Not reproduced in 17 focused files; #57 remains open for a reproducer, with no ownership/fix claim.
- [x] [P19-T12] Reconcile P18, split P13-T06 wiring from downstream publishing, check P09-RV evidence, and preserve completed reconstruction/framework work. Original receipt/owner follow-ups remain #60/#63, not falsely completed work.
- [x] [P19-T13] Update P17 project/goal navigation with the approved pause and issue backlinks; preserve unfinished gates and original completion requirements.
- [ ] [P19-T14] Review changes, correct findings, run target-branch merge gates, integrate only accepted bug/administrative work, and close issues only with verified evidence.
- [ ] [P19-T15] Patch newly confirmed vulnerable parser/tooling dependencies (#65) on both maintained lines, with bounded malformed-TOML rejection, inspected lockfile changes, fresh audit and ordinary gates.
- [ ] [P19-T16] Repair inherited host-tool discovery in P17 doctor and verification contract fixtures (#67), preserving exact assertions and the full ordinary gate.
- [x] [P19-TS01] Every active/deferred/carryover item has a unique owner, acceptance criteria, dependencies, source references, and truthful status.
- [x] [P19-TS02] Each fixed bug has a failing-before/passing-after regression and affected-line coverage; already-correct P17 behavior is preserved and regression-tested.
- [ ] [P19-TS03] Required ordinary static/tests/build checks pass at exact reviewed commits; deferred release checks are separately identified.
- [x] [P19-TS04] Remote PR/issue/workflow state is freshly verified; no publication or visibility change occurred; P17 remains pending.

## Implementation checkpoint — 2026-09-15

Initial product fixes, compatible security dependency updates and P17 fixture repairs are
implemented. Independent review found remaining defects in #61/#64/#67; this is not a completed
bug closeout. Main-based [PR #66](https://github.com/smorinlabs/skillsmith/pull/66) passes
1,047 tests and Linux/macOS CI at `7c8d865`. The saved
[P17 maintenance branch](https://github.com/smorinlabs/skillsmith/tree/d786739eb2db462540a761d56c5eaa3473402e8b)
passes the canonical 370-file gate at `d786739`: 3,394 test cases including 28 existing live
skips, 111,520 assertions, no failures. Both lines pass their ordinary security checks.
Exact receipts and earlier failures are preserved in [EVIDENCE.md](p19/EVIDENCE.md).

Unchecked product tasks include remaining defect corrections, the #41 reporting follow-up,
review, acceptance and integration. Before closing them:

1. Correct the independent Codex findings recorded in [REVIEW.md](p19/REVIEW.md), then obtain
   fresh sign-off. Codex and Claude Code reviewers have standing user approval; no additional
   reviewer permission is required.
2. Follow the [separate reporting PR decision, Q1.A](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855):
   preserve per-tool conflict semantics and retain informational cross-tool name reporting in
   a separate follow-up PR. Keep #41 open until delivered; PR #66 need not wait for that addition.
3. Follow the [approved product-only P17 path, Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463):
   separate release qualification from automatic PR CI, retain ordinary checks and native
   build/smoke, and open `agent/p19-p17-fixes` against `agent/p17-execution` after validation.
   PR #44 remains draft. Release qualification remains required before a future release.
4. Correct any new review findings, validate exact integration heads, integrate accepted fixes
   into both affected lines, then close only the issues whose acceptance is fully met.

Follow-ups #57 (unreproduced Bun failure), #60 (historical P09 review receipt), and #63
(P13 owner/wiring proof) remain open with explicit dispositions. No publishing task is resumed,
no bug issue is closed, and neither P19 nor the original P17 release objective is complete.

### Q2 implementation and review correction checkpoint

CI separation is committed on P17 at `ffd1cba` and independently approved. Only the
Homebrew candidate install/upgrade qualification and its dedicated setup moved to a guarded
manual release-only workflow; no qualification was executed or counted passed.
Runtime review corrections are committed on main at `5adb299` and P17 at `b33c224`.
Main's two affected owners passed 41 tests; P17's five affected owners passed 144 tests,
including the global-tool isolation controls. Type-checking and affected-source lint passed.
Review then exposed a startup race in the new descendant fixture. The final correction at main
`27c67e9` / P17 `01d09a9` is independently approved: main replay 41 pass, 0 fail, 721 assertions;
P17's equivalent fixture differs only in its existing execution/cancellation contract.
Exact-head full gates and remote integration remain required. These focused
results do not replace the older full-gate receipts above. Latest integration receipts belong
to [P19 #51](https://github.com/smorinlabs/skillsmith/issues/51).

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
