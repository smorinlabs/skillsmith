# Phase 4 evidence

## Entry gate — 2026-07-16

- **Contract:** Phase 3 passes with correlated read/status and deterministic inventory surfaces,
  immutable operations/results, lock scheduling and coordination, journaled recovery, immutable
  snapshots and pure planners, adapter-owned lifecycle behavior, and operation observation through
  execution/recovery.
- **Phase boundary:** Phase 3 whole-phase, traceability, and architecture reviews pass; standing
  approval and exit are recorded in `projects/p17/evidence/phase-3.md` at commit
  `45d754bbd135da0ad2667c350c058df33e5bcbe0`.
- **Dependency evidence:** P17-G3B-03, P17-G3B-04, P17-G3B-05, and P17-G3B-06 are signed off,
  satisfying every direct dependency for P17-G4A-01. The governing terminal Phase-3 repository
  receipt passed 2,353 tests with 28 intentional environment-gated skips, 0 failures, and 95,506
  assertions; subsequent corrections were documentation/governance-only and independently
  accepted.
- **Architecture entry constraint:** `packages/core/src/acquire/run.ts` is 3,944/3,955 lines.
  G4A-01 must vertically extract a coherent preparation/selection or report-projection slice before
  adding acquisition runner behavior. Keep planning in `acquire/plan.ts` and
  coordinator/repository behavior in `acquire/execute.ts`; do not add a generic repository,
  unit-of-work, or lifecycle framework.
- **Scope boundary:** Phase 4 may build desired-state mutation, planner/apply, and their bounded
  multi-source/tool semantics. Entry alone advances no Phase-4 group lifecycle gate, entity,
  validation, public contract, or mutation authority.
- **Result:** Phase 4 entry passed; Phase 4 may become active without another human prompt.
- **Recorded by:** root Codex goal, 2026-07-16 America/Los_Angeles.
