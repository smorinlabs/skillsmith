## project-harness — project workflow skills

This repo uses the `project-harness` plugin. Project state lives
in `PROJECTS.md` (the trunk) and `projects/P<NN>-*.md` (per-project
files). When the user mentions a project, plan, milestone, or
backlog, route through one of:

- `using-project-harness` — bootstrap and orientation
- `project-next` — what's in progress / next / recently touched
- `project-add` — capture an idea (≤4 questions, atomic ID reserve)
- `project-refine` — flesh out / scope / decompose / refine
  references
- `project-audit` — verify state matches conventions; fix per
  finding

**Schema (self-describing for external tools).** Trunk rows use
the standard markdown-link format
`- [<glyph>] **P<NN>** — [<title>](projects/P<NN>-<slug>.md)`.
Every non-`[?]` per-project file has a `**References**` block at
the top whose first bullet is
`- **Trunk:** [PROJECTS.md](../PROJECTS.md)` — the back-pointer
to the trunk — followed by canonical labels (`Spec`, `Design`,
`Plan`, `Depends on`, `Successor of`, `Tracking`, `Discussion`,
`Prior art`). Bidirectional links mean a tool that lands on
either file can navigate to the other without prior knowledge of
the conventions. See
`skills/project-audit/references/references-block.md` for the
full format and the discovery helper.

## Skillsmith scope and safety context

Skillsmith is an open-source CLI for installing, updating, and managing agent-skill packages whose
primary artifact is `SKILL.md`. Work in this repository is authorized local product development.
Reliability tests use hermetic fixtures, synthetic sensitive-data markers, local filesystem failure
simulation, and deterministic interruption of local test subprocesses. They do not target external
systems, real accounts, real credentials, or third-party networks.

In plans, delegated tasks, reviews, and progress reports, lead with that product/reliability context
and prefer precise neutral descriptions. Preserve literal operating-system signals, API names,
error identifiers, source grammar, and test vectors whenever reproducibility requires them. Do not
obscure intent, evade safeguards, weaken tests, or extend work into unauthorized access, destructive
testing, data extraction, malware, or real-secret handling.
