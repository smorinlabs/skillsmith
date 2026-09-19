# apply

> P17 disposition: unimplemented superseded command draft; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#814-apply

Install skills declared in a manifest. Idempotent, drift-aware.

## Argument order

```
skillsmith apply [FLAGS] [<manifest>]
```

Positional manifest path optional; defaults to walking up for `skillsmith.toml` (cargo/npm precedent).

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--file` | — | path/repeatable | `./skillsmith.toml` | — | Manifest path(s); repeatable (kubectl `-f`) |
| `--tool` | `-t` | enum/repeatable | from manifest | `SKILLSMITH_TOOL` | Override tool targets |
| `--scope` | `-s` | enum | from manifest | `SKILLSMITH_SCOPE` | Override scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--force` | `-f` | bool | false | — | Treat already-installed manifest entries as install targets (reinstall regardless of unchanged status); override cross-scope duplicates |
| `--yes` | `-y` | bool | false | — | Skip prompts |
| `--dry-run` | — | bool | false | — | Preview reconciliation plan |
| `--check` | — | bool | false | — | Drift check: exit 7 if any skill would be created/updated/deleted. For CI pre-commit. |
| `--prune` | — | bool | false | — | Remove installed skills absent from manifest |
| `--no-hooks` | — | bool | false | — | Skip lifecycle hooks ([§1.13](../skillsmith-cli-design.md#113-lifecycle-hooks)) |
| `--no-adapt` | — | bool | false | — | Skip cross-tool adaptation ([§1.16](../skillsmith-cli-design.md#116-cross-tool-adaptation)) |
| `--set` | — | `k=v` repeatable | — | — | Override values at apply time ([§1.12](../skillsmith-cli-design.md#112-per-skill-configuration-values-layering)) |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |
| `--json` | — | bool | false | — | JSON output |

## Help output

_TBD: help mockup not yet authored._

## Error and prompt mockups

**`apply` output (kubectl-style):**
```
Reading ./skillsmith.toml

  ✓ grep       created    .claude/skills/grep           acme/skills@3f2a1b
  ✓ diff       unchanged  .claude/skills/diff           acme/skills@3f2a1b
  ✓ edit       updated    .claude/skills/edit           acme/skills@7e9c2d
  ⚠ format     skipped    already in user scope; pass --force to override
  ✓ test       created    .claude/skills/test           acme/skills@3f2a1b

5 skills: 2 created, 1 updated, 1 unchanged, 1 skipped, 0 failed.
```

**`apply --check` (drift detection for CI):**
```
$ skillsmith apply --check
Reading ./skillsmith.toml

  ⚠ grep     drift       installed @3f2a1b, manifest @7e9c2d
  ⚠ format   missing     declared in manifest, not installed
  ✓ diff     in-sync     .claude/skills/diff

3 skills: 2 drifted, 1 in-sync.
Exit code: 7

# Example CI hook
#   skillsmith apply --check || { echo "skill drift detected"; exit 1; }
```
