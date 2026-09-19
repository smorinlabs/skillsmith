# Phase 2 evidence

## Entry gate — 2026-07-13

- **Contract:** Phase 1 passes while legacy project configuration remains readable and no current
  command writes a second canonical project representation.
- **Phase boundary:** Phase 1 whole-phase review, standing approval, and exit are passed in
  `projects/p17/evidence/phase-1.md`.
- **Compatibility evidence:** P17-G1-02C and `EWP-P1-TS05` preserve exact legacy project-config
  reads, source bytes, and actionable Phase-2 migration notices without adding a writer, manifest,
  lock, or automatic migration.
- **Dependency evidence:** P17-G1-04, G1-05, G1-06, and G1-07 are signed off, satisfying every
  direct G2-01 dependency while all five Phase-2 groups and 33 entities remain pristine/planned.
- **Result:** Phase 2 entry passed; Phase 2 may become active. No G2-01 lifecycle gate is implied.
- **Recorded by:** root Codex goal, 2026-07-13 America/Los_Angeles.

## Whole-phase adversarial review — 2026-07-14

- **Reviewer:** fresh independent Codex sub-agent `/root/phase2_whole_review` at initial clean pin
  `b635668a3fd0ccc7f676b6cf820ecbed66c13c6f` and corrected clean pin
  `3b2be3bcedfc9bb23a1445662c0ba689866b477d`.
- The initial review returned **NOT PASS** with stable blocker `P17-RV-PHASE-2-F01`, promoting the
  explicitly non-waived G2-03 follow-up `P17-FU-G2-01-F01`: artifact-pair and discovery capability
  catches inspected or coerced unknown thrown values instead of returning fixed state errors.
- The append-only G2-01 amendment replaced all affected catches with binding-free fixed errors and
  added test-first hostile thrown-value matrices at pair `pathKind`/`realpath` and discovery
  `pathKind`/`readText`. Each seam covers a canary Error, canary primitive, hostile message accessor,
  hostile coercion hooks, and hostile proxy traps without cause retention, invocation, or leakage.
- Independent amendment review `/root/g2_01_phase_exit_review` returned PASS. Focused pair/discovery
  replay passed 19/19 with 278 assertions; `EWP-P2-TS02` passed 6/6 with 368 assertions; impacted
  check, port, observation, and P2-TS04 smoke lanes passed.
- The terminal major-milestone `bun run check` passed 1,759 tests, 28 intentional environment-gated
  skips, 0 failures, and 68,946 assertions across 1,787 tests in 196 files (428.58 seconds). It
  includes the complete `EWP-P2-TS04` inventory: 19 passed with 49,356 assertions. All static,
  boundary, type, catalog/package, actionlint, and diff gates passed in the same run.
- Final whole-phase review returned **PASS at 0.999 confidence**. All 5 required groups have all
  10 lifecycle gates passed; all 32 Phase-2-owned entities and all 32 unique required-now
  validations are signed off. Of 84 unique downstream validations, `EWP-P2-TS04` is already signed
  by its Phase-2 owner and the other 83 remain honestly planned under future owners.
- Count correction: the entry-gate paragraph's historical “33 entities” was a prose miscount. The
  immutable catalog enumerated 32 Phase-2-owned entities at entry and still enumerates exactly 32;
  this append-only correction supersedes only that count, not the entry decision.
- The reviewer confirmed the correction closes the historical G2-03 follow-up, the catalog/evidence
  metadata is coherent, and no other stable Phase-2 blocker remains.
- **Result:** whole-Phase-2 adversarial review passed with no unresolved blocker.

## Standing approval and Phase 2 exit — 2026-07-14

- **Approval identity:** `user-standing-authorization-2026-07-12`.
- **Approval evidence:** `projects/p17/evidence/standing-authorization.md` records the user's explicit
  instruction to continue P17 without another human review pause.
- The Phase 2 exit contract is met: canonical manifest discovery and identity, portable lock and
  semantic hashes, lossless human-file editing, durable pair mutation and recovery, pure init
  planning, and versioned manifest/lock/plan/ledger/journal codecs are signed and independently
  accepted with no required skip.
- **Result:** Phase 2 approval and exit passed; Phase 3 may enter without another human prompt.
