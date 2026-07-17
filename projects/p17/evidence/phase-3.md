# Phase 3 evidence

## Entry gate — 2026-07-14

- **Contract:** Phase 2 passes with one portable artifact foundation: canonical manifest and lock
  authorities, lossless human-file mutation, durable recovery, pure init planning, and conservative
  versioned persisted-artifact codecs/repositories.
- **Phase boundary:** Phase 2 whole-phase adversarial review, standing approval, and exit are passed
  in `projects/p17/evidence/phase-2.md` at commit `2ffbbcc`.
- **Dependency evidence:** P17-G2-05 is signed off and the Phase-2 terminal repository gate passed
  1,759 tests with 28 intentional environment-gated skips, 0 failures, and 68,946 assertions. This
  satisfies the direct dependency for P17-G3A-01.
- **Scope boundary:** Phase 3 may build the correlated read/status foundation and then the operation
  foundation. No Phase-3 group lifecycle gate, mutation authority, or later command is implied by
  entry alone.
- **Result:** Phase 3 entry passed; Phase 3 may become active without another human prompt.
- **Recorded by:** root Codex goal, 2026-07-14 America/Los_Angeles.

## Whole-phase adversarial review — 2026-07-16

- **Reviewers:** fresh independent whole-phase reviewer `/root/phase3_whole_review`, independent
  traceability reviewer `/root/phase3_traceability_audit`, and independent architecture/simplicity
  reviewer `/root/phase3_architecture_audit`. Review began from signed-group pin
  `dcb8b39dd53713f78aa53824cec9aef91c53008f` and passed on corrected clean pin
  `6144e08c7803d27d178a4ba70d469be3798e4aae`.
- **Initial findings:** review returned NOT PASS on four governance/documentation findings only:
  - `P17-RV-P3-F01` — G3A-02 omitted already implemented
    `packages/core/src/inventory/cancellation.ts` from group/task ownership;
  - `P17-RV-P3-F02` — G3B-05 omitted already committed
    `packages/core/tests/verify/gate.test.ts` from group/task ownership;
  - `P17-RV-P3-F03` — G3B-04 evidence did not record the final accepted plan digest or the exact
    disposition of post-Ready plan amendments; and
  - `P17-RV-P3-F04` — architecture documentation retained a 16-codec/v1-v2 inventory and obsolete
    command-local agents flow instead of the current 21-codec, v1-v4 application-runtime design.
- **Corrections:** `0d7481755ed9f24078e0c5c5dd9ab72aae1a7341` assigns the two omitted
  paths to their exact groups/tasks, records amended plan hashes, and reconciles architecture plus
  ADR 0008 without changing product or test bytes. `6144e08c7803d27d178a4ba70d469be3798e4aae`
  then corrects one overbroad sequencing sentence: `b253153` preceded affected swap-test edits,
  while `bd3bede` co-committed bounded plan clarification with implementation as the explicitly
  reviewed exception. F01–F04 are closed; no new finding remains.
- **Mechanical closure:** all **8/8 Phase-3 groups** have **80/80 lifecycle gates** passed; all
  **82/82 Phase-3-primary entities** are uniquely owned and signed off. All **51 unique
  required-now validations** resolve to executable targets and accepted receipts. All **77 unique
  downstream validations** remain honestly planned under later owners.
- **Fresh Phase-3 selector aggregate:**

  ```text
  bun test tests/ergonomics/phase/EWP-P3A-TS01.test.ts tests/ergonomics/phase/EWP-P3A-TS02.test.ts tests/ergonomics/phase/EWP-P3A-TS03.test.ts tests/ergonomics/phase/EWP-P3A-TS04.test.ts tests/ergonomics/phase/EWP-P3B-TS01.test.ts tests/ergonomics/phase/EWP-P3B-TS02.test.ts tests/ergonomics/phase/EWP-P3B-TS03.test.ts tests/ergonomics/phase/EWP-P3B-TS04.test.ts tests/ergonomics/phase/EWP-P3B-TS05.test.ts tests/ergonomics/phase/EWP-P3B-TS06.test.ts tests/ergonomics/phase/EWP-P3B-TS07.test.ts
  ```

  passed **120/120 tests with 21,982 assertions** across 11 files in 40.04 seconds.
- **Fresh command-contract aggregate:**

  ```text
  bun test packages/cli/tests/contracts/agents.test.ts packages/cli/tests/contracts/commands.test.ts packages/cli/tests/contracts/list.test.ts packages/cli/tests/contracts/status.test.ts packages/cli/tests/contracts/dev.test.ts packages/cli/tests/contracts/promote.test.ts packages/cli/tests/contracts/doctor.test.ts
  ```

  passed **130/130 tests with 1,900 assertions** across seven files in 28.21 seconds.
- **Focused omitted-path behavior:**

  ```text
  bun test packages/core/tests/verify/gate.test.ts packages/core/tests/inventory/read.test.ts packages/core/tests/scan/list-skills.test.ts packages/core/tests/scan/list-commands.test.ts
  ```

  passed **32/32 tests with 148 assertions** across four files.
- **Terminal milestone receipt:** the final G3B-06 `bun run check` on
  `7e5d69337c9e8cfe91349c630ca199e4632a10c8` remains the governing whole-repository
  Phase-3 terminal run: **2,353 passed, 28 intentional environment-gated skips, 0 failures, and
  95,506 assertions** across 2,381 tests in 247 files. Biome, boundaries, TypeScript, actionlint,
  package/catalog validation, and exact TS07 replay also passed. The later corrections are
  documentation/governance-only, so reviewers explicitly required structural replay rather than
  another five-minute full suite.
- **Structural replay:** catalog, package, `check:p17`, plan structure, documentation drift,
  architecture reconciliation, TypeScript, boundaries, diff validation, and deterministic
  checklist checks exit 0. The fresh structural test aggregate passes **99/99 with 280 assertions**.
- **Architecture verdict:** PASS at 99% confidence with no Phase-3 runtime refactor or framework
  needed. Binding G4A-01 entry constraint: `packages/core/src/acquire/run.ts` is **3,944/3,955
  lines**, so the next acquisition feature must first vertically extract a coherent
  preparation/selection or report-projection slice. Keep `run.ts` a compatibility shell, planning
  in `acquire/plan.ts`, and coordinator/repository behavior in `acquire/execute.ts`.
- **Final verdict:** `/root/phase3_whole_review` PASS at 99% confidence,
  `/root/phase3_traceability_audit` PASS at 99.5%, and `/root/phase3_architecture_audit` PASS at
  99%. Phase 4 remains pristine: seven planned groups and 107 planned primary entities.

## Standing approval and Phase 3 exit — 2026-07-16

- **Approval identity:** `user-standing-authorization-2026-07-12`.
- **Approval evidence:** `projects/p17/evidence/standing-authorization.md` records the user's
  explicit instruction to continue P17 without another human-review pause.
- The Phase 3 exit contract is met: correlated read/status and deterministic inventory surfaces,
  immutable operations/results, lock scheduling and coordination, journaled recovery, immutable
  snapshots and pure planners, adapter-owned lifecycle behavior, and operation observation through
  execution/recovery are signed and independently accepted with no required skip.
- **Result:** Phase 3 approval and exit passed; Phase 4 may enter without another human prompt.
