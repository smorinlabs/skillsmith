# P17 — Skillsmith Ergonomics and Declarative Workflow

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Design:** [Architecture](../docs/architecture.md)
- **Plan:** [Skillsmith ergonomics workflow plan](../docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md)
- **Goal:** [Persistent Codex goal](P17-GOAL.md)
- **Execution:** [Dependency-aware execution map](p17/EXECUTION.md)
- **Preparation:** [Preparation checklist](p17/PREP.md)
- **Catalog:** [Machine-readable execution catalog](p17/catalog.json)
- **Checklist:** [Generated execution checklist](p17/CHECKLIST.md)
- **Evidence:** [Evidence protocol and records](p17/evidence/README.md)

Make Skillsmith’s discover, develop, manage, declarative, and maintenance workflows predictable
and complete.

### Scope

- Implement the accepted Phase 0-6 Skillsmith ergonomics plan.
- Track every named recommendation, task, validation, command, finding, and decision.
- Generate a checkbox-level execution view from one machine-readable catalog.
- Partition implementation into dependency-aware change groups.
- Require test-first evidence, targeted and impacted validation, refactoring, independent
  adversarial review, traceability closure, and sign-off for every change group.
- Close documentation drift and executable structural validation in Phase 0.
- Prevent phase advancement while required entries are missing, failing, or skipped.
- Apply the user's 2026-07-12 standing approval at each phase boundary and final P17 completion;
  record it mechanically without additional human-review pauses.

### Out of scope

- Phase 7/P3 capabilities, which require their own future specifications and projects.
- P14 production release before P17 Phase 6 passes.
- Replacing the consolidated plan with summaries in the project file.
- Manually maintaining duplicate checklist inventories.

### Open questions

None.

### Tests & Tasks

- [x] [P17-TS01] Preparation package validated and PR-openable.
- [x] [P17-T01] Phase 0 executable consistency/control-plane gate approved.
- [x] [P17-T02] Phase 1 CLI truthfulness approved.
- [x] [P17-T03] Phase 2 portable artifact foundation approved.
- [x] [P17-T04] Phase 3 inspection and operation foundation approved.
- [x] [P17-T05] Phase 4 desired-state mutation, planner, and apply approved.
- [ ] [P17-T06] Phase 5 sync, update, undo, and GC approved.
- [ ] [P17-T07] Phase 6 distribution and UX approved.
- [ ] [P17-TS02] Final P17 validation, recorded standing user approval, and P14 handoff complete.
