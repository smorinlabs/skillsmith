# Phase 1 evidence

## Entry gate — 2026-07-12

- **Contract:** Phase 0 passes with a closed migration ledger and seeded validation catalog.
- **Phase boundary:** Phase 0 whole-phase review, canonical standing approval, and exit are passed in
  `projects/p17/evidence/phase-0.md`.
- **Migration evidence:** P17-G0-02 is signed off with the live Commander migration ledger and exact
  CLI contract validations.
- **Catalog evidence:** P17-G0-05 is signed off with 425 entities, 244 validation obligations,
  deterministic checklist generation, and exact planned executable owners.
- **Result:** Phase 1 entry passed; Phase 1 may become active. No Phase-1 group gate is implied.
- **Recorded by:** root Codex goal, 2026-07-12 America/Los_Angeles.

## Whole-phase adversarial review — 2026-07-13

- **Reviewer:** fresh independent Codex sub-agent `/root/phase1_whole_review` at initial clean pin
  `badb151d55ef4f0dc1c3113d59a4520442639fd0` and corrected clean pin
  `606f942ecfafed36067ef7428f867fec32588a7a`.
- Initial review rejected seven stable findings:
  - `P17-RV-PHASE-1-F01` through `F04` found exact historical ownership omissions in G1-01,
    G1-02B, G1-02C, and G1-04: 6, 1, 2, and 76 paths respectively.
  - `P17-RV-PHASE-1-F05` found that unrelated command value options could suppress the global
    eager-version path.
  - `P17-RV-PHASE-1-F06` found that returned runtime outcomes retained renderer-mutable nested
    references.
  - `P17-RV-PHASE-1-F07` found that signed TS01 did not contain its named spawned global-option
    matrix across project-aware commands.
- Implementation/test correction `77c22c766db5635189819f295e53f68a1d033348` makes eager parsing
  root-plus-active-command scoped, recursively owns/freeze-snapshots runtime outcomes, and adds the
  six-case TS01 matrix. Trace correction `606f942ecfafed36067ef7428f867fec32588a7a`
  records every historical changed path exactly in catalog, plans, evidence, and updated receipts.
- Final independent replay returned **PASS at 0.999 confidence**. All four ownership difference
  sets are empty; the exact `agents --ref --version` and adjacent parser probes pass; hostile nested
  outcome mutation, maps, cycles, errors, and accessors are contained; and TS01 owns its canonical
  read-only spawned matrix.
- Focused correction replay passed 35/35. The complete Phase-1 required-now matrix passed 158/158
  with 3,761 assertions. Final `bun run check` passed 1,396 tests, 28 expected environment-gated
  skips, 0 failures, and 9,091 assertions. Catalog, package, PR-openable, type, lint, generated
  checklist, and diff gates passed.
- All 9 required groups and all 62 Phase-1-owned entities are signed off. All 27 unique required-now
  validations have executable, passing, non-skipped exact-revision receipts. The 137 still-future
  downstream obligations remain planned under future owners with null targets and empty evidence.
- **Result:** whole-Phase-1 adversarial review passed with no remaining blocker.

## Standing approval and Phase 1 exit — 2026-07-13

- **Approval identity:** `user-standing-authorization-2026-07-12`.
- **Approval evidence:** `projects/p17/evidence/standing-authorization.md` records the user's explicit
  instruction to continue P17 without another human review pause.
- The Phase 1 exit contract is met: project/config selection, shared errors/exits, check/doctor
  semantics, declarative command/runtime boundaries, capability-scoped ports, tool registry,
  canonical wire codecs, operation-scoped observation, current help truth, and all required
  cross-command workflows are signed and independently accepted with no required skip.
- **Result:** Phase 1 approval and exit passed; Phase 2 may enter without another human prompt.
