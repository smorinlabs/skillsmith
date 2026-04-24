# SkillSmith command reference

Per-command detail. Cross-cutting design (scopes, exit codes, env vars,
store layout, architecture) lives in [`../skillsmith-cli-design.md`](../skillsmith-cli-design.md);
release phasing lives in [`../skillsmith-phases.md`](../skillsmith-phases.md).

## Core verbs

- [install](./install.md) — install one or more skills from a source ref
- [uninstall](./uninstall.md) — remove installed skills (aliases: `rm`, `remove`)
- [sync](./sync.md) — reconcile skills between scopes or projects
- [list](./list.md) — list installed skills across scopes and tools (alias: `ls`)
- [apply](./apply.md) — install skills declared in a manifest
- [doctor](./doctor.md) — diagnose readiness; also covers `check` (CI subset)
- [agents](./agents.md) — inventory of detected agents on the system

Each file contains: argument order, flag table, help output, error/prompt
mockups, open questions, and feature-phase rows.
