# sync

Reconcile installed skills between scopes or between projects.

## Argument order

```
skillsmith sync [FLAGS] [<skill>...]
```

`--from` and `--to` are flag-only because their semantics ("sync FROM project A TO project B", or "sync FROM user scope TO project scope") are positional-ambiguous.

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--from` | — | string | — | — | Source scope or project path |
| `--to` | — | string | — | — | Destination scope or project path |
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Limit sync to tool(s) |
| `--scope` | `-s` | enum | (auto) | `SKILLSMITH_SCOPE` | Limit sync to scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--force` | `-f` | bool | false | — | Treat already-installed entries as install targets; override cross-scope duplicates |
| `--yes` | `-y` | bool | false | — | Skip confirmation |
| `--dry-run` | — | bool | false | — | Preview |
| `--delete` | — | bool | false | — | Remove skills in `--to` absent from `--from` (rsync-style; opt-in) |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

## Help output

_TBD: help mockup not yet authored._
