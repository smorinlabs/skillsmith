# 11. Doctor / Health

`skillsmith doctor` is the interactive, human-facing health command. `skillsmith check` is a narrow programmatic subset designed for CI and pre-commit hooks. Both share the same underlying check registry; the difference is which checks run and how results are rendered.

## Commands

**`skillsmith doctor [--agent <name>]... [--format json]`** — MVP.
Runs the full check set: environment, drift, install-method, and version-conflict detection. No arguments means "check every agent Skill Smith can detect." `--agent` is a repeatable flag (`--agent claude-code --agent cursor`) to scope the run. Default output is human-readable with colored severity markers and a remediation hint per finding. Always exits 0 unless the command itself failed to run; use `check` for exit-code-driven flows.

**`skillsmith check [--agent <name>]... [--exit-code] [--format json]`** — MVP.
Runs only the error-severity checks from the registry — the ones that indicate real drift or breakage, not stylistic nits. Warnings are intentionally never run here; `check` is always error-and-above, no threshold flag. Suitable for pre-commit and CI. `--exit-code` makes the process exit non-zero on any error finding. `--agent` behaves the same as in `doctor`.

Rationale for the split: users running `doctor` want the full picture including "you should probably migrate off the legacy installer someday." CI running `check` wants a clean yes/no on whether the repo is in a valid state — warnings in that context are noise that tempts teams to grep them out or ignore the command entirely.

## Built-in checks

| Check | Severity | In `doctor` | In `check` | Notes |
|---|---|---|---|---|
| Agent detected on PATH | error | ✓ | ✓ | Per `--agent` selection, or all auto-detected. |
| Skills directory writable | error | ✓ | ✓ | Per agent. |
| No orphaned files in skills dir | error | ✓ | ✓ | Files present that aren't in the manifest. |
| Manifest matches lockfile | error | ✓ | ✓ | Primary drift signal. |
| Multiple installs of the same agent | warning | ✓ | ✗ | Covers both "two package managers" (brew + npm) and "one installer, two binaries on PATH." Not fatal — agents can coexist — but worth surfacing. |
| Legacy install method in use | warning | ✓ | ✗ | Per-agent logic: each supported agent contributes a detection module that knows its own install modalities (e.g. Claude Code npm-global vs native installer). Purely advisory. |
| Plugin-contributed checks | varies | ✓ | error-severity only | P2 — see below. |

## Plugin-contributed healthchecks (P2)

Defining the contract now to avoid boxing ourselves in at MVP, even though we won't ship the runner until P2.

A skill opts in by adding a `healthchecks` entry to its manifest pointing at an executable (script or binary) the skill ships. Skill Smith invokes it with a documented env (`SKILLSMITH_AGENT`, `SKILLSMITH_SKILL_DIR`, `SKILLSMITH_MODE=doctor|check`) and parses one finding per line of stdout as TSV:

```
<severity>\t<short-title>\t<message>[\t<remediation>]
```

Severities are `error` | `warning` | `info`. A non-zero exit from the check script is itself reported as an `error` finding ("healthcheck script failed"). The `SKILLSMITH_MODE` env var lets skills skip expensive checks when running under `check`; by convention skills should only emit `error` findings in `check` mode. Findings are namespaced by skill name in the output so users can tell where a warning came from.

We are deliberately not using a richer format (JSON-per-line, protocol buffers, an in-process Lua/Python API) for MVP-era contract-setting. TSV lines are trivially producible from any language a skill might be written in, and we can version the contract by env var if we need to extend it. This is a sketch — the exact wire format may tighten before P2 ships.

## Output and exit behavior

Default human-readable output groups findings by agent, then by severity within agent. Each finding shows title, message, and remediation hint if one is available.

`--format json` is supported on both commands in MVP and emits a structured document with per-agent and per-check results. CI consumers should prefer JSON over parsing human output; the schema will be marked experimental in the first release so we can refine it based on real usage before committing to stability guarantees.

No `--fix` command for MVP — instead, every built-in check that can emit a finding ships with a remediation string telling the user the exact command to run (e.g. "run `skillsmith sync` to regenerate the lockfile", "uninstall the legacy npm package with `npm uninstall -g …`"). This keeps `doctor` read-only and auditable. If real demand emerges, a separate `skillsmith fix` command can later consume the same remediation metadata and execute the safe ones; the data model already supports it without a redesign.

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 11.1 | **`skillsmith doctor`** — agents detected, skill dirs writable, no orphans, manifest matches lockfile, multi-install + legacy-installer warnings, `--agent` repeatable, `--format json` | MVP | Essential for a cross-tool tool. Brew `doctor`, mise `doctor`, nvim `:checkhealth` prior art. |
| 11.2 | **Plugin-contributed healthchecks** — skills declare their own checks via manifest `healthchecks` entry, TSV wire format | P2 | nvim `:checkhealth` pattern; lets skill authors add custom validation. Contract sketched at MVP to avoid future redesign. |
| 11.3 | **`skillsmith check`** — error-severity checks only, `--exit-code`, `--format json`, `--agent` repeatable | MVP | Pre-commit / PR drift detection. Programmatic-first; warnings belong in `doctor`. |
