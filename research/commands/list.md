# list

List installed skills across scopes and tools. Alias: `ls`.

## Argument order

```
skillsmith list [FLAGS] [<skill>...]
```

Optional positional filter(s) matching skill name patterns (glob supported): `skillsmith list 'grep*'`.

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Filter by tool |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Filter by scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--duplicates` | — | bool | false | — | Show only same-tool cross-scope duplicates in the selected inventory |
| `--json` | — | bool | false | — | JSON output |
| `--long` | `-l` | bool | false | — | Show symlink path, store path, source, and commit SHA |

## Help output

Duplicate identity is `(tool, skill-name)`: reusing a name in different tools is not a conflict.
Scope, name and enablement filters apply before duplicate grouping. A single-scope selection therefore
has no cross-scope duplicates. A populated inventory with no selected conflicts reports
"No duplicate skills matched the selected inventory.", not "No skills installed."

_TBD: help mockup not yet authored._
