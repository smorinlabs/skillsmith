# list

> P17 disposition: shipped command evidence, not future target authority; target: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#83-list

> P19 clarification: P17 uses same-tool placement conflicts, including multiple roots within
> a scope; cross-tool name reuse is not a conflict. Tool/scope selection bounds collision
> identity; display filters preserve the selected context's collision/shadowing metadata.
> See the [current generated reference](../../docs/commands.md#list).

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
| `--duplicates` | — | bool | false | — | Show only same-tool placement conflicts |
| `--json` | — | bool | false | — | JSON output |
| `--long` | `-l` | bool | false | — | Show symlink path, store path, source, and commit SHA |

## Help output

Duplicate identity is `(tool, skill-name)`: reusing a name in different tools is not a conflict.
Tool/scope selection bounds collision identity; name, enablement, and duplicates filters apply
after grouping and preserve the selected context's collision/shadowing metadata. A single-scope
selection therefore has no cross-scope duplicates, though multiple roots within that scope can
still conflict. A populated inventory with no selected conflicts reports
"No duplicate skills matched the selected inventory.", not "No skills installed."

_TBD: help mockup not yet authored._
