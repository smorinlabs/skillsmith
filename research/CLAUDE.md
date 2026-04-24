# research/ guidance for Claude

## Ignore `research/archive/`

Files under `research/archive/` are superseded research artifacts kept for history. Do not read, cite, or base decisions on anything in that directory unless the user explicitly asks about archived material.

## Per-command detail lives in `research/commands/`

When answering questions about a specific SkillSmith command (`install`, `uninstall`, `sync`, `list`, `apply`, `doctor`, `check`, `agents`), look in `research/commands/<verb>.md` for:

- argument order
- flag table
- help output mockup
- command-specific error and prompt mockups
- open questions

`research/skillsmith-cli-design.md` holds only cross-cutting material — design decisions, global flags, naming conventions, exit codes, env vars, architecture. It is not authoritative for any single command's flags or help output.

`research/skillsmith-phases.md` holds release phasing (MVP / Phase 2 / Phase 3).

`research/skillsmith-v1-stack-summary.md` is authoritative for V1 runtime and build choices — Bun version, the 9-package runtime dep list, patterns to reuse from Claude Code, and deps deliberately NOT included (no `fs-extra`, `axios`, `execa`, `ora`, Zustand, Ink, etc.). Consult it before adding any runtime dependency.
