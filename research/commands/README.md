# SkillSmith command reference

> P17 disposition: current page inventory; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#321-canonical-help-and-documentation-groups

Per-command detail. Cross-cutting design (scopes, exit codes, env vars,
store layout, architecture) lives in [`../skillsmith-cli-design.md`](../skillsmith-cli-design.md);
release phasing lives in [`../skillsmith-phases.md`](../skillsmith-phases.md).

## Active command pages

> P17 disposition: current shipped/draft status; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#820-normative-command-and-option-registry

- [agents](./agents.md) — shipped inventory of detected agents
- [list](./list.md) — shipped installed-skill inventory (alias: `ls`)
- [doctor](./doctor.md) — shipped readiness diagnostics; also covers shipped `check`
- [install](./install.md) — shipped source acquisition and placement
- [uninstall](./uninstall.md) — shipped placement removal (aliases: `rm`, `remove`)
- [dev](./dev.md) — shipped live-source placement workflow
- [verify](./verify.md) — shipped plugin or bare-skill verification
- [promote](./promote.md) — shipped snapshot-to-production workflow
- [apply](./apply.md) — unimplemented historical declarative draft
- [sync](./sync.md) — unimplemented historical reconciliation draft

The consolidated P17 registry owns every future migration target.

Each file contains: argument order, flag table, help output, error/prompt
mockups, open questions, and feature-phase rows.
