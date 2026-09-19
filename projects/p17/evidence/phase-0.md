# Phase 0 evidence

## Entry gate — 2026-07-12

- **Contract:** The consolidated source set and current Commander snapshot are available.
- **Source evidence:** `research/skillsmith-cli-design.md`, `research/skillsmith-phases.md`,
  `research/skillsmith-v1-stack-summary.md`, the 11 files under `research/commands/`,
  `docs/superpowers/specs/2026-07-07-promote-dev-design.md`, and
  `docs/superpowers/specs/2026-07-07-p09-install-design.md` are present in commit
  `091fc7d862d1e73f047630a4de9869a3d1a5c332`.
- **Commander evidence:** `packages/cli/src/program.ts` is present, and Section 13.1 of
  `docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md` contains the
  current-program drift snapshot and migration ledger derived from the live Commander surface.
- **Preparation evidence:** `bun scripts/check-p17-package.ts --final` passed after a fresh
  `git fetch origin main`, proving preparation PR #31 is merged and its preparation revision is on
  the clean synchronized default branch.
- **Structural evidence:** `bun scripts/check-p17-package.ts --check` and
  `bun scripts/p17-catalog.ts --check` both passed with 425 entities, 45 groups, 244 validation
  obligations, and a deterministic checklist.
- **Result:** Phase 0 entry passed; Phase 0 may become active. No group lifecycle gate is implied.
- **Recorded by:** root Codex goal, 2026-07-12 America/Los_Angeles.

## Whole-phase adversarial review — 2026-07-12

- **Reviewer:** fresh independent Codex sub-agent `/root/phase0_review`.
- Initial review rejected `P17-RV-PHASE-0-F01` through `F04`: stale integrated execution status,
  stale consolidated-plan current state, overbroad phase-close prose, and duplicate/prefixed status
  authority bypasses.
- Correction revision `6ef07ec6e774d07363785c350f1fb4d4e18a8588` makes the execution rollup and unique plan/status
  markers catalog-derived across G0-01..G0-05 and scopes phase closure to the phase's owned entities.
- Fresh reviewer replay accepted all four corrections. Phase 0 selectors plus OPT-TS01 passed
  139/139 with 332 assertions; corrected TS05 passed 15/15 with 46 assertions; catalog adversarial
  tests passed 50/50; documentation, architecture, plan, catalog, package, and diff gates passed;
  full `bun run check` exited 0.
- All five groups and 28 Phase-0-owned entities are signed; all exact implementation revisions exist
  and contain their executable targets. P0-08 remains planned under G2-05.
- **Result:** whole-phase adversarial review passed with no required skip or remaining blocker.

## Standing approval and Phase 0 exit — 2026-07-12

- **Approval identity:** `user-standing-authorization-2026-07-12`.
- **Approval evidence:** `projects/p17/evidence/standing-authorization.md` records the user's explicit
  instruction to continue P17 without another human review pause.
- The Phase 0 exit contract is met: all decisions/findings are recorded; CLI migration,
  artifact/architecture/quality/documentation consistency are closed; the structural/catalog gates
  pass; and every validation has a tier plus planned executable owner.
- **Result:** Phase 0 approval and exit passed; Phase 1 may enter without another human prompt.
