# doctor / check

> P17 disposition: shipped command-family evidence; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

`skillsmith doctor` is the interactive, human-facing health command. `skillsmith check` is a narrow programmatic subset designed for CI and pre-commit hooks. Both share the same underlying check registry; the difference is which checks run and how results are rendered.

## Argument order

> P17 disposition: shipped command shape; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

For `doctor`:

```
skillsmith doctor [FLAGS]
```

No positional arguments.

For `check`:

```
skillsmith check [FLAGS]
```

No positional arguments.

## Commands

> P17 disposition: superseded check gating and option target; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

**`skillsmith doctor [--tool <name>]... [--json]`** — MVP.
Runs the full check set: environment, drift, install-method, and version-conflict detection. No arguments means "check every target tool SkillSmith can detect." `--tool` is a repeatable flag (`--tool claude-code --tool kilo-code`) to scope the run. Default output is human-readable with colored severity markers and a remediation hint per finding. Exits 0 when all checks pass (warnings allowed unless `--strict`); exits 1 if one or more checks failed.

**`skillsmith check [--tool <name>]... [--exit-code] [--json]`** — MVP.
Runs only the error-severity checks from the registry — the ones that indicate real drift or breakage, not stylistic nits. Warnings are intentionally never run here; `check` is always error-and-above, no threshold flag. Suitable for pre-commit and CI. `--exit-code` makes the process exit non-zero on any error finding. `--tool` behaves the same as in `doctor`.

Rationale for the split: users running `doctor` want the full picture including "you should probably migrate off the legacy installer someday." CI running `check` wants a clean yes/no on whether the repo is in a valid state — warnings in that context are noise that tempts teams to grep them out or ignore the command entirely.

## Built-in checks

> P17 disposition: superseded built-in check registry; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

| Check | Severity | In `doctor` | In `check` | Notes |
|---|---|---|---|---|
| Tool detected on PATH | error | ✓ | ✓ | Per `--tool` selection, or all auto-detected. |
| Skills directory writable | error | ✓ | ✓ | Per tool. |
| No orphaned files in skills dir | error | ✓ | ✓ | Files present that aren't in the manifest. |
| Manifest matches lockfile | error | ✓ | ✓ | Primary drift signal. |
| Multiple installs of the same tool | warning | ✓ | ✗ | Covers both "two package managers" (brew + npm) and "one installer, two binaries on PATH." Not fatal — tools can coexist — but worth surfacing. |
| Legacy install method in use | warning | ✓ | ✗ | Per-tool logic: each supported tool contributes a detection module that knows its own install modalities (e.g. Claude Code npm-global vs native installer). Purely advisory. |
| Plugin-contributed checks | varies | ✓ | error-severity only | P2 — see below. |

## Plugin-contributed healthchecks (P2)

> P17 disposition: superseded speculative plugin-healthcheck target; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

Defining the contract now to avoid boxing ourselves in at MVP, even though we won't ship the runner until P2.

A skill opts in by adding a `healthchecks` entry to its manifest pointing at an executable (script or binary) the skill ships. SkillSmith invokes it with a documented env (`SKILLSMITH_HOOK_TOOL`, `SKILLSMITH_HOOK_SKILL_PATH`, `SKILLSMITH_HOOK_MODE=doctor|check`) and parses one finding per line of stdout as TSV:

```
<severity>\t<short-title>\t<message>[\t<remediation>]
```

Severities are `error` | `warning` | `info`. A non-zero exit from the check script is itself reported as an `error` finding ("healthcheck script failed"). The `SKILLSMITH_HOOK_MODE` env var lets skills skip expensive checks when running under `check`; by convention skills should only emit `error` findings in `check` mode. Findings are namespaced by skill name in the output so users can tell where a warning came from.

We are deliberately not using a richer format (JSON-per-line, protocol buffers, an in-process Lua/Python API) for MVP-era contract-setting. TSV lines are trivially producible from any language a skill might be written in, and we can version the contract by env var if we need to extend it. This is a sketch — the exact wire format may tighten before P2 ships.

## Output and exit behavior

> P17 disposition: superseded no-fix and check-exit target; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

Default human-readable output groups findings by tool, then by severity within tool. Each finding shows title, message, and remediation hint if one is available.

`--json` is supported on both commands in MVP and emits a structured document with per-tool and per-check results. CI consumers should prefer JSON over parsing human output; the schema will be marked experimental in the first release so we can refine it based on real usage before committing to stability guarantees.

No `--fix` command for MVP — instead, every built-in check that can emit a finding ships with a remediation string telling the user the exact command to run (e.g. "run `skillsmith sync` to regenerate the lockfile", "uninstall the legacy npm package with `npm uninstall -g …`"). This keeps `doctor` read-only and auditable. If real demand emerges, a separate `skillsmith fix` command can later consume the same remediation metadata and execute the safe ones; the data model already supports it without a redesign.

## Feature table

> P17 disposition: superseded feature phasing; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#10-named-implementation-phases-and-slices

| # | Feature | Phase | Why |
|---|---|---|---|
| 11.1 | **`skillsmith doctor`** — every target tool detected, skill dirs writable, no orphans, manifest matches lockfile, multi-install + legacy-installer warnings, `--tool` repeatable, `--json` | MVP | Essential for a cross-tool tool. Brew `doctor`, mise `doctor`, nvim `:checkhealth` prior art. |
| 11.2 | **Plugin-contributed healthchecks** — skills declare their own checks via manifest `healthchecks` entry, TSV wire format | P2 | nvim `:checkhealth` pattern; lets skill authors add custom validation. Contract sketched at MVP to avoid future redesign. |
| 11.3 | **`skillsmith check`** — error-severity checks only, `--exit-code`, `--json`, `--tool` repeatable | MVP | Pre-commit / PR drift detection. Programmatic-first; warnings belong in `doctor`. |

## Flags

> P17 disposition: superseded option registry; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#820-normative-command-and-option-registry

### doctor

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Limit checks to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit checks to scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--offline` | — | bool | false | — | Skip network checks |
| `--strict` | — | bool | false | — | Treat warnings as failures (exit 1 on any `⚠`) |
| `--json` | — | bool | false | — | JSON output |

### check

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Limit checks to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit checks to scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--exit-code` | — | bool | false | — | Exit non-zero on any error finding |
| `--json` | — | bool | false | — | JSON output |

## Help output

> P17 disposition: shipped help evidence with superseded future surface; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

```
Diagnose SkillSmith and target-tool readiness.

USAGE
  skillsmith doctor [flags]

FLAGS
  -t, --tool <name>       Limit checks to tool(s). Repeatable. Default: all.
  -s, --scope <scope>     Limit checks to scope. Default: all.
      --offline           Skip network checks
      --strict            Treat warnings as failures (exit 1 on any ⚠)
      --json              Emit JSON on stdout

INHERITED FLAGS
  (See 'skillsmith help' for details)

EXAMPLES
  # Full diagnostic
  $ skillsmith doctor

  # CI-friendly, no network, strict
  $ skillsmith doctor --offline --strict

  # Machine-readable
  $ skillsmith doctor --json | jq '.checks[] | select(.status != "ok")'

EXIT CODES
  0  all checks pass (warnings allowed unless --strict)
  1  one or more checks failed
```

## Error and prompt mockups

> P17 disposition: historical output examples, superseded as target authority; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#810-doctor-check

**`skillsmith doctor` human output:**
```
SkillSmith 0.4.2
Config: /Users/alice/.config/skillsmith/config.toml

Environment
  ✓ XDG paths resolved (config, data, cache)
  ✓ skillsmith.toml found at /Users/alice/projects/app/skillsmith.toml

Target tools
  ✓ claude-code 1.2.0          ~/.claude/skills (writable)
  ⚠ codex       not installed  install: npm install -g @openai/codex
  ✓ kilo-code   0.7.1          ~/.kilo/skills (writable)
  ✓ opencode    0.3.0          ~/.local/share/opencode/skills (writable)

SkillSmith data directories
  ✓ data    /Users/alice/.local/share/skillsmith        ($XDG_DATA_HOME, writable, 128 GB free)
  ✓ cache   /Users/alice/.cache/skillsmith              ($XDG_CACHE_HOME, writable)
  ✓ config  /Users/alice/.config/skillsmith             ($XDG_CONFIG_HOME, writable)

Network
  ✓ github.com reachable

Skills
  ⚠ 1 cross-scope duplicate:
      grep: user (~/.claude/skills/grep) and project (./.claude/skills/grep)
      see 'skillsmith list --duplicates'

11 checks, 2 warnings, 0 failed.
```
