# P17 persistent Codex goal

## Objective

Execute P17 completely: implement and validate every required Phase 0-6 contract in the approved
Skillsmith ergonomics plan through dependency-aware change groups, test-driven development,
mechanical traceability, independent Codex adversarial review, explicit phase approvals, and final
evidence-based sign-off. The user granted standing approval for all P17 phase boundaries and final
completion on 2026-07-12, so record that approval mechanically without pausing for another human
review prompt. Keep Phase 7 deferred and P14 blocked until P17 Phase 6 is complete.

## Terminal completion condition

Mark this goal complete only when all of the following are true:

- every required catalog entity and every required group gate is signed off with resolving evidence;
- every Phase 0-6 entry/exit gate, command test, option gate, holistic workflow, documentation gate,
  structural check, supported-platform check, and release check passes at its assigned tier;
- no required validation is missing, orphaned, duplicate-owned, prose-only, failing, or skipped;
- every group and phase adversarial-review finding is fixed or explicitly resolved;
- every phase boundary and final P17 completion records the user's standing approval from
  `projects/p17/evidence/standing-authorization.md`; no additional human-review pause is required;
- the final implementation PR state, remote default branch, commits, checks, merge, and preserved
  local worktree state are freshly verified rather than inferred;
- P14 has a truthful, validated handoff and no Phase 7/P3 work has been silently pulled into 1.0.

Budget exhaustion, usage limits, a green subset, a review report, or an implementation summary is
not completion.

## Bootstrap sentence

From the Skillsmith repository root in a fresh interactive Codex thread, the user runs this exact
one-sentence goal objective:

```text
/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, applying the recorded standing human approval without additional review pauses and marking complete only after all referenced gates and final sign-off pass.
```

The sentence points to this file; it is not a special file-ingestion syntax. Do not add a token
budget unless the user explicitly requests one.

## Preflight

Before editing implementation code or changing catalog status:

1. Confirm the working directory is the Skillsmith repository root.
2. Read all applicable repository instructions, this file, and every normative reference below.
3. Inspect the current branch, worktree, remote/default-branch relationship, open PRs, and current
   goal status. Preserve unrelated user changes.
4. Run the catalog/checklist structural check and inspect the current phase/group rollup.
5. Read the latest evidence for the current group and verify its prerequisite groups are signed off.
6. Select the lowest dependency-ready unfinished required group. Never infer readiness from chat.
7. If Phase 0 has not been signed off, begin with its lowest ready group even if later product work
   appears easier.

## Authority and references

Use this order when artifacts differ:

1. This file governs the persistent execution process, completion rule, review loop, and human
   approvals. It cannot silently change product behavior.
2. [P17 project record](P17-skillsmith-ergonomics-and-declarative-workflow.md) governs project scope,
   status, references, and the P14/Phase 7 boundary.
3. [Consolidated product plan](../docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md)
   governs accepted product contracts, decisions, findings, examples, commands, options, and
   validation requirements.
4. [Execution map](p17/EXECUTION.md) governs dependency-aware change-group boundaries and
   dependencies. This goal file alone governs the common lifecycle.
5. [Machine-readable catalog](p17/catalog.json) governs entity identity, primary ownership, tier,
   execution status, and evidence pointers.
6. [Generated checklist](p17/CHECKLIST.md) is the human view generated from the catalog. Never edit
   it directly.
7. [Evidence records](p17/evidence/README.md) prove lifecycle transitions and sign-offs.
8. [Preparation closeout](p17/PREP.md) proves that the execution package was reviewed and
   PR-openable. The live `--final` gate proves it landed before this goal begins.
9. [Repository instructions](../CLAUDE.md), plus any applicable `AGENTS.md` or nested instruction
   file discovered from the current checkout, govern repository workflow and validation mechanics.
10. [Architecture](../docs/architecture.md) and current code/tests describe existing precedent and
   shipped behavior but do not override accepted target contracts.
11. [Codex-goal decision](../research/topics/codex-persistent-goal/DECISION.md) and
    [terminal reference](../research/reference/codex-persistent-goal-2026-07-11.md) govern the
    documented goal bootstrap and persistence assumptions.
12. [Isolated execution environment](../docs/p17-sandbox.md) governs the optional Lima runner,
    manual subscription authentication, host-isolation checks, and unrestricted Codex launch.

Conversation summaries, agent reports, generated prose, and memory never override committed
normative artifacts. A contract-changing discovery requires an explicit plan amendment, catalog
update, structural validation, adversarial review, and user approval before implementation resumes.

## Inventory invariants

The baseline catalog contains 425 entities:

- 34 original P0-P3 recommendations;
- 65 phase tasks;
- 61 phase tests;
- 157 command tests;
- 10 option-consistency gates;
- 16 holistic workflows;
- 23 commands;
- 43 accepted findings;
- 16 accepted decisions.

These prose counts are navigation, not proof. Recompute them from the consolidated plan and require
exact set equality with the catalog. Phase 7 recommendations remain cataloged as deferred and do not
count toward P17 or 1.0 completion.

## Execution order

- Follow the acyclic dependencies in the execution map and catalog.
- At bootstrap, pass Phase 0 entry before marking `P17-G0-01:mapped`; the same phase-entry-first
  rule applies to every later group.
- A group becomes ready only after every prerequisite is signed off with valid evidence.
- Do not begin dependent implementation speculatively.
- Dependency-independent groups may run in parallel only with disjoint file ownership or one named
  integration owner and a declared merge order.
- Complete each Phase 0-6 boundary, record the standing approval evidence, and advance without an
  additional human-review pause.
- Keep the current group small enough for independent review but large enough that its contract and
  tests form one coherent state transition.

## Per-group TDD and verification loop

For every required group, repeat this exact lifecycle:

1. **Mapped:** confirm every affected task, test, command, option, workflow, finding, decision, and
   recommendation has one primary group, tier, target, and dependency set.
2. **Ready:** write or amend the detailed implementation plan; name fixtures, file ownership,
   expected behavior, negative cases, and exact test commands. Review the plan before coding.
3. **Test first:** add or activate the smallest acceptance/contract tests and record the expected
   failure. For behavior-preserving refactors, first preserve green characterization and add a
   failing negative architecture or boundary test instead of manufacturing a false functional red.
4. **Minimal implementation:** implement only enough to satisfy the mapped contract. Preserve
   unrelated work and avoid pulling future groups forward.
5. **Targeted green:** run every primary group validation. Record exact commands and outcomes.
6. **Impacted green:** run every catalog `requiredNowValidations` entry: the cross-command, artifact,
   workflow, compatibility, static-boundary, and generated-output tests whose owning group is the
   current group or a signed dependency. Required skips are failures. Preserve immutable
   `downstreamCoverage` obligations, but do not execute future-group tests early; their owning later
   group must pass them, and final review fails if any obligation or validation remains unsigned.
7. **Refactor:** improve structure while targeted and impacted suites stay green.
8. **Independent adversarial review:** use a fresh Codex reviewer that did not implement the group.
   The reviewer attempts to falsify product behavior, tests, safety claims, and traceability.
9. **Correction:** give every finding a stable ID. Fix, disposition, or escalate it; rerun targeted
   and impacted validation; repeat independent review until no blocking finding remains.
10. **Traceability closure:** run the plan/catalog/checklist validator and regenerate the checklist.
11. **Sign-off:** record automated gates, reviewer disposition, commits, evidence, and timestamp.
    Only then may dependent groups begin.

A failed test, structural gate, CI job, review finding, or evidence inconsistency reopens the group
at the earliest affected state. Never check a later gate merely because work continued past it.

## Sub-agent protocol

- The root Codex thread owns this goal, group selection, integration, evidence, and status updates.
- Use fresh sub-agents for bounded implementation, focused investigation, and independent review
  when their work can be isolated safely.
- Every brief names the group and mapped IDs, allowed files, prohibited scope, prerequisite
  evidence, expected tests, and the exact thin handoff required.
- Do not give concurrent agents overlapping write ownership. Use a named integration owner when
  independent results converge on shared files.
- Treat sub-agent conclusions as hypotheses until the root inspects the diff, reruns relevant
  validation, and records evidence.
- A sub-agent does not inherit goal authority, human approvals, or completion authority.

## Adversarial review contract

Every change group and completed phase receives an independent Codex review. At minimum, attempt to
find:

- divergence from accepted examples, decisions, findings, command/option grammar, and exit rules;
- negative-path, zero-target, ambiguity, partial-failure, cancellation, and noninteractive defects;
- data loss, non-atomic writes, unsafe recovery, lock-order, concurrency, or interruption defects;
- cross-command or artifact inconsistencies and unsupported capability leakage;
- malformed/legacy/future-version, portability, redaction, permission, and byte-identity defects;
- human/JSON/help/completion/output drift;
- required tests that are absent, skipped, overly mocked, coupled to implementation, or able to
  pass the wrong behavior;
- unowned IDs, duplicated ownership, invalid status transitions, stale generated files, and
  evidence that does not resolve.

Record review findings as `P17-RV-<group>-F<NN>` or `P17-RV-P<phase>-F<NN>`. A finding closes only
with a verified fix, an accepted contract amendment, or an explicit non-blocking disposition that
does not contradict the plan.

## Evidence and status

- Update `catalog.json` as the canonical status change and regenerate `CHECKLIST.md` mechanically.
- Write append-only group/phase evidence under `projects/p17/evidence/` using its required template.
- Record exact commands, meaningful results, fixture or artifact paths, commits, CI URLs, review
  IDs/dispositions, and sign-off identity/time.
- Keep full transient logs in CI or temporary artifacts; retain reproducible summaries and hashes
  in committed evidence.
- Never infer that work is committed, pushed, reviewed, merged, clean, synchronized, or released.
  Verify each claim from fresh Git/GitHub state.
- Send concise progress updates during long work and a complete checkpoint at every phase boundary.

## Human-controlled boundaries

The user granted standing approval on 2026-07-12 for every Phase 0-6 boundary, final P17 completion,
and the P14 handoff. The canonical evidence is
`projects/p17/evidence/standing-authorization.md`. Once the applicable automated gates and fresh
independent Codex review pass, record `approvedBy: user-standing-authorization-2026-07-12` and
advance without stopping for another human review.

This standing approval does not waive technical gates and does not authorize a product-contract
change, meaningful scope expansion, or destructive/external action outside the active group's
existing authority. Those materially different actions still require explicit direction.

## Resume and context-compaction protocol

At the start of every goal turn—and after interruption, uncertain continuation, or context
compaction:

1. Reread this file and any changed normative reference.
2. Inspect the catalog rollup, regenerate/check the checklist, and read the latest evidence for the
   current group.
3. Inspect fresh Git and PR state; preserve unrelated changes.
4. On the initial new-thread bootstrap only, before creating an implementation branch, run
   `git fetch origin main`, then `bun scripts/check-p17-package.ts --final` from clean synchronized
   `main` to prove the preparation package was completely landed. On ordinary resumes from an
   implementation branch, use `bun scripts/check-p17-package.ts --check` plus
   `bun scripts/p17-catalog.ts --check`; do not require `--final` again. The `--pr-openable` mode is
   reserved for offline preparation-PR creation readiness, while `--merge-ready` is the live
   pre-merge authorization gate.
5. Resume the lowest dependency-ready unfinished group at its earliest incomplete lifecycle gate.

Do not rely on remembered chat text or assume that Codex automatically reread linked files. A new
thread requires the user to set this goal again explicitly.

## Blocked, paused, and budget behavior

- Exhaust safe in-scope checks and alternatives before declaring a blocker.
- Follow the current runtime's exact blocked threshold and status contract; approval pauses and hard
  work are not blockers by themselves.
- A blocker report names the group/gate, attempts, evidence, precise blocking condition, and the
  minimum input or external change needed.
- Never choose a token budget on the user's behalf. A user-set budget or usage limit stops work but
  does not satisfy completion.
- Do not mark the goal complete merely because a phase, PR, or available budget ended.

## Final closeout

After Phase 6 group completion:

1. Recompute the complete plan/catalog/checklist inventory and dependency graph.
2. Run every required phase, command, option, workflow, platform, documentation, distribution, and
   exact-SHA release validation with no required skips.
3. Run a fresh whole-program Codex adversarial review and close every finding.
4. Re-run all affected validation after final corrections.
5. Present the complete evidence rollup and record the standing user approval without pausing.
6. After recording approval, verify final commits, PR checks, merge state, remote default branch, and preserved
   local worktree state.
7. Mark the goal complete only when the terminal completion condition is proven and no required work
   remains. Report final goal usage if the runtime supplies it.
8. Hand P14 a truthful release-ready baseline; do not execute P14 or deferred Phase 7 work unless
   separately authorized.
