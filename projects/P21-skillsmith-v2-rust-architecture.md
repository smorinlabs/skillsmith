# P21 — Skillsmith v2 (Rust) architecture, tracked in skillsmith-rs

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Tracking:** [smorinlabs/skillsmith-rs](https://github.com/smorinlabs/skillsmith-rs) — owns the v2 design and code
- **Design:** [skillsmith-rs ADR 0001 — v2 architecture, PR #1](https://github.com/smorinlabs/skillsmith-rs/pull/1) — update to the `main` file path once merged
- **Prior art:** [ADR 0007 — tool adapter registry](../docs/adr/0007-tool-adapter-registry.md)
- **Prior art:** [ADR 0008 — wire contract registry](../docs/adr/0008-wire-contract-registry.md)
- **Discussion:** [Issue #99 — Muse project scope shares Codex's destination](https://github.com/smorinlabs/skillsmith/issues/99)

**Status:** Scoped. Recorded on 2026-09-24. This entry is a pointer: the v2 design, plan, and
tasks live in `skillsmith-rs`. No v1 code changes are authorized by this project.

## Outcome and scope

Skillsmith v2 is a Rust rewrite that runs alongside this TypeScript v1. Decisions that bind v1:

- v1 and v2 share one state directory, resolved in v1's order: `$SKILLSMITH_HOME` when set,
  otherwise `$XDG_DATA_HOME/skillsmith`. v2 reads and writes v1's persisted formats exactly:
  manifest@1, lock@1, plan@1, journal@1, and ledger@2; it also reads ledger@1 to migrate older
  ledgers, as v1 does. These are codec versions, not product versions. v1's persisted formats are
  therefore frozen for v2 compatibility until v1 is retired.
- v2 takes v1's ledger lock with the same identity (the `placements.json.lock` directory), so the
  lock mechanism in `packages/core/src/place/ledger.ts` is also part of the compatibility contract.
- v2 command output is new and not compatible with v1's CLI output, so v1's CLI wire schemas
  (ADR 0008) remain free to change.
- During the overlap v1 keeps the `skillsmith` command and v2 installs as `sks`.
- v1 behavior is captured as golden fixtures that v2 must pass (spec-first migration).

**Out of scope**
- Any change to v1 behavior, formats, or releases.

## Tests & Tasks

- [ ] [P21-T01] Link the merged skillsmith-rs ADR 0001 once it lands on `main`.
- [ ] [P21-T02] Flag any v1 PR that changes a persisted format or the ledger lock as a v2 compatibility break.
