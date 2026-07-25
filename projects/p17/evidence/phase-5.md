# Phase 5 evidence

## Entry gate — 2026-07-21

- **Contract:** Phase 4 passes desired-state manifest/lock creation, portable export and init,
  multi-source/tool mutation, pure plan/check, exact fresh/saved apply, lock update policy,
  crash recovery, and supported-platform reproducibility.
- **Phase boundary:** all seven Phase 4 groups are signed off; the fresh whole-phase review,
  standing approval, and exit are recorded in `projects/p17/evidence/phase-4.md` at head
  `08edc72ca1a20139af5f6936afaca2f4ae9f394f`.
- **Dependency evidence:** P17-G4B-03 is signed off with all ten gates and supplies the direct
  dependency for P17-G5-01 through P17-G5-04. P17-G5-05 remains correctly dependent on the
  signed completion of G5-01, G5-02, and G5-03.
- **Scope boundary:** Phase 5 may build direct sync, update discovery/apply, pending abort and
  committed undo, ledger-authoritative retention/forget/GC, and the shared bulk scheduling and
  approval closure. Entry alone advances no Phase-5 group lifecycle gate, entity, validation,
  public contract, or mutation authority.
- **Result:** Phase 5 entry passed; Phase 5 may become active without another human prompt.
- **Recorded by:** root Codex goal, 2026-07-21 America/Los_Angeles.

## Whole-phase adversarial review NO-GO — 2026-07-25

- **Reviewed head:** `47a8d208bc87eabe45db498913894c29e67de22e`.
- **Reviewer:** fresh read-only external Codex session
  `/external-codex/019f9b51-c71d-7c02-91f5-c0e5a4e858f1`.
- **Scope:** all five Phase-5 groups, 50 lifecycle gates, 70 Phase-5-primary entities, owned
  boundaries, required-now validation targets, architecture, historical findings, the G5-05
  terminal receipt, and the untouched Phase-6 boundary.
- **P17-RV-P5-F01 (medium, release-blocking):** G5-04's plan, catalog, and sign-off claim
  `packages/cli/tests/output/gc.test.ts`, but the path is absent at the product, compatibility,
  G5-04 sign-off, and reviewed Phase-5 trees and has no Git history. Only 92 of the promised 93
  G5-04 paths are blobs. Existing structural validators did not detect the absent owned path.
- **P17-RV-P5-F02 (low, release-blocking):** the public `selectBoundedHistory` path contains a
  Bun-matcher-specific getter and Proxy mutation trap behind `includeSelectionTrace`. This is
  test-only behavior in product code and conflicts with the environment-neutral immutable product
  boundary.
- **Product classification:** focused sync, update/reconcile, undo, GC, recovery, digest,
  scheduler, ledger-history, smoke, recovery-smoke, and all five Phase-5 acceptance suites passed.
  An undo stress test that crossed Bun's default five-second ceiling under parallel load passed in
  1.59 seconds when isolated with the required 60-second timeout. No adjacent runtime defect was
  found.
- **Unchanged closure:** G5-05's 85-path boundary is exact and complete; its terminal arithmetic is
  3,194 passed + 28 intentional live-environment skips + 0 failed = 3,222 tests, with 104,703
  assertions across 350 files. F11 through F30 remain closed and complete.
- **Verdict:** **NO-GO at 0.99 confidence**. Phase-5 review, standing approval, and exit remain
  pending. Standing authorization does not waive either finding.
- **Required correction:** materialize the promised focused GC renderer test or formally amend to
  equivalent proven coverage; require every non-planned group-owned path to be a current regular
  file or an exact Git-recorded deletion; remove the Bun-specific product behavior and use direct
  non-mutating assertions; then obtain fresh G5-04 and whole-Phase-5 review on immutable corrections.
- **Boundary:** Phase 6 and all five G6 groups remain planned with zero owned files and zero passed
  gates. No Phase-6 work is authorized by this correction.

**Whole-phase review result:** FAIL pending correction of P17-RV-P5-F01 and P17-RV-P5-F02.

## G5-04 correction review NO-GO — 2026-07-25

- **Reviewed head:** `5a4e5cd9f6db8a5131b25e323a19703c89a06e79`.
- **Reviewer:** fresh read-only external Codex session
  `/external-codex/019f9b7f-3bde-7580-97ba-b8d2b0f2a86a`.
- **Closed substance:** the promised GC output owner exists with meaningful strict human/JSON and
  runtime-binding coverage; the ledger-history matcher getter/Proxy is gone; adjacent GC privacy,
  materialized context/selection owners, and the doctor golden are correct and green.
- **P17-RV-P5-F03 (medium, release-blocking):** the new owned-path invariant accepts normalized
  in-repository traversal and symlinked parents, and can treat a dangling symlink as absent before
  accepting exact deletion history. The actual catalog remains clean: 878 current regular unique
  paths plus two exact deletions; all 445 Phase-5 ownership entries are current regular blobs.
- **Required correction:** validate canonical portable path grammar, inspect every component without
  following symlinks, reserve deletion provenance for genuine absence, and cover traversal,
  symlink/ghost, and stale-history cases before another immutable review.
- **Verdict:** **NO-GO at 0.99 confidence**. G5-04 remains 7/10; Phase-5 boundary gates remain
  pending; Phase 6 remains planned with zero progress.

## G5-04 F03 correction re-review NO-GO — 2026-07-25

- **Reviewed head:** `1ee9e6dc235ee15777335f386831897b55a5f196`.
- **Reviewer:** fresh read-only external Codex session
  `/external-codex/019f9b8f-812f-7a70-937b-0e62629593b3`.
- **Closed portion:** canonical portable path grammar, component-by-component static symlink
  rejection, dangling-symlink rejection, and the current 878-regular-plus-two-deletion ownership
  arithmetic are correct. All focused validation selectors passed.
- **P17-RV-P5-F03 remains open (medium, release-blocking):** path-limited Git history collapses a
  rename-away into `D`, so the absent historical `commitlint.config.js` is a concrete false
  acceptance. The Git subprocess also inherits repository-selecting environment variables and
  ignores its exit status, while `ENOTDIR` is classified as absence. Those conditions can make
  provenance come from the wrong repository or from an invalid filesystem state.
- **Required correction:** bind Git to the intended repository with the canonical production
  repository-environment denylist, require successful commands and a canonical commit identifier,
  inspect the complete unfiltered commit's NUL-delimited name-status records, accept only an exact
  `D` row, classify `ENOTDIR` as non-file, and cover rename, stale history, ambient-repository, and
  Git-error cases hermetically.
- **Verdict:** **NO-GO at 0.99 confidence**. G5-04 remains 7/10; Phase-5 review, approval, and exit
  remain pending; Phase 6 remains planned with zero owned files and zero passed gates.
