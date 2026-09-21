# P20 — Git adapter permission classification for bounded reads

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Discussion:** [Copilot review 5264285470](https://github.com/smorinlabs/skillsmith/pull/107#pullrequestreview-5264285470)
- **Discussion:** [Permission disposition, PR #107 comment 5762537696](https://github.com/smorinlabs/skillsmith/pull/107#issuecomment-5762537696)
- **Prior art:** [Selector implementation plan](../docs/superpowers/plans/2026-09-20-skillsmith-install-selector-implementation.md)

**Status:** Scoped, not started. Deferred from PR #107 by owner decision Q1.A on 2026-09-21:
narrow the selector's documented permission guarantee now, improve the Git adapter separately.

## Outcome and scope

Design and validate a scoped read-permission capability for the Git adapter so bounded
metadata reads (`readBlobBounded`) and the shared helpers (`required`/`requiredBytes`, legacy
`listTree`) classify denied repository traversal, Git configuration access, and object-storage
reads as permission failures (exit 6) instead of source errors (exit 5). Either classification
must still stop an incomplete scan before installation. No generic stderr-substring heuristic:
corroborate permission denial the way the existing Git-init precedent does, extended to cover
reads. A repository-root-only probe does not establish complete coverage.

Out of scope: changing selector precedence, budgets, or installed-name semantics; unrelated
adapter features.

## Tests & Tasks

- [ ] [P20-T01] Design the scoped permission capability: probe points for traversal, config,
      and object-storage reads; error contract; cancellation interplay.
- [ ] [P20-T02] Implement the capability in the Git adapter and shared read helpers, preserving
      structured `EACCES` mapping and ordinary non-permission `unavailable` behavior.
- [ ] [P20-TS01] Positive controls: denied access before `ls-tree` and between probe and
      `cat-file` classify as permission failures (exit 6) in isolated real-Git fixtures.
- [ ] [P20-TS02] Inverse controls: readable and restored-permission fixtures succeed; ordinary
      non-permission failures stay `unavailable`; existing cancellation exit 130 preserved.
- [ ] [P20-T03] Widen the documented guarantee back to the full promise only with passing
      controls; update README, selector plan, and this project record together.

## Automated Verification

- New adapter/CLI regression tests fail before and pass after the fix.
- `bun run check` passes; full canonical gate green on the delivery head.
