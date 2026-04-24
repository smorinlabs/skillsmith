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
| `--duplicates` | — | bool | false | — | Show only cross-scope duplicates |
| `--json` | — | bool | false | — | JSON output |
| `--long` | `-l` | bool | false | — | Show symlink path, store path, source, and commit SHA |

## Help output

_TBD: help mockup not yet authored._
