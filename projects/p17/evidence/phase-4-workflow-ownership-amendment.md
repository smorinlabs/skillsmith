# Phase 4 dependency-complete workflow ownership amendment

## Authority and approval

- Canonical discovery: EWP-WF03 invokes `init`, `install`, `plan`, and `apply` and requires
  clean-clone cross-platform reproduction. EWP-WF04 invokes `export`, `plan`, and `apply` and
  requires Machine-A-to-Machine-B reproduction.
- Dependency conflict: `plan` and `apply` are owned by P17-G4B-01 and P17-G4B-02, while the two
  complete workflows were previously owned by P17-G4A-03 and P17-G4A-02. Executing either workflow
  in Phase 4A would pull dependent implementation forward or falsely sign partial evidence.
- User approval: the user explicitly approved the bounded ownership correction on 2026-07-18 in
  the root P17 execution thread.
- Approved boundary: move primary ownership of EWP-WF03 and EWP-WF04 to P17-G4B-03; preserve them
  as downstream coverage for P17-G4A-03 and P17-G4A-02; preserve earlier command, decision,
  finding, task, and recommendation relations; change no behavior, entity count, product scope, or
  execution-group dependency.

## Test-first receipt

- Red command:
  `bun test scripts/p17-catalog.test.ts --test-name-pattern 'schedules WF03 and WF04'`
- Expected and observed red: EWP-WF03 was still generated with primary group P17-G4A-03 instead
  of P17-G4B-03; 0 passed, 1 failed, 52 filtered.
- Green command: the same focused command after the generator amendment.
- Green result after the final traceability assertions: 1 passed, 0 failed, 52 filtered,
  29 expectations.

## Mechanical amendment

- The consolidated plan records the dependency-complete scheduling rule and approval.
- `scripts/p17-catalog.ts` maps both workflow validations to P17-G4B-03 and explicitly preserves
  the Phase-4A validation and contract relations that would otherwise be lost by fallback mapping.
- `scripts/p17-catalog.test.ts` locks primary ownership, downstream partitioning, final required-now
  ownership, affected contracts, and early-command secondary groups.
- The progressed catalog was mechanically reconciled only for generator-owned immutable fields;
  group/entity status, evidence, targets, gates, reviewers, implementers, owned files, test commands,
  phase state, and final state were preserved.
- The generated checklist now shows EWP-WF03 and EWP-WF04 under P17-G4B-03, with WF03 downstream
  from P17-G4A-03 and WF04 downstream from P17-G4A-02.

## Validation

- `bun test scripts/p17-catalog.test.ts --timeout 30000`: 53 passed, 0 failed, 161 expectations.
- `bun run check:p17`: PR-openable; 425 entities, 418 required, 7 deferred, 244 validation
  obligations, 45 groups, deterministic checklist. Recorded execution remains Phase 4 active,
  28/44 required groups signed off, 227/418 required entities signed off, and no active group.
- `bun test tests/ergonomics/phase/EWP-P0A-TS05.test.ts --test-name-pattern EWP-P0A-TS05`:
  15 passed, 0 failed, 51 expectations.
- Required skips: none.

## Independent adversarial review

- Reviewer `/root/phase4_workflow_amendment_review` returned **GO** at 0.995 confidence after
  reading the canonical workflow/dependency contracts, reviewing the complete diff, and rerunning
  the focused ownership test, full catalog suite, catalog/checklist check, aggregate P17 check,
  EWP-P0A-TS05, diff check, and an independent HEAD/current execution-state comparison.
- The reviewer confirmed G4B-03 is the earliest truthful owner, G4A-02/G4A-03 retain their
  downstream obligations, G4B-03 requires both workflows, all 18 prior workflow relations remain
  intact, mutable execution state is unchanged, and no product implementation or behavior changed.
- **P17-RV-P4-F01 (low, resolved):** stronger final trace assertions increased the focused/full
  expectation counts after the evidence draft. The receipt was corrected to 29 focused and 161
  full-suite expectations before the reviewer reran and accepted the final state.
- Unresolved findings: none.

## Gate boundary

This governance amendment advances no P17 group lifecycle gate and signs off no entity. G4A-02
remains planned until its separate Mapped and Ready lifecycle is completed after this amendment is
independently accepted and committed.
