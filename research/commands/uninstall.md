# uninstall

Remove one or more installed skills. Aliases: `rm`, `remove`.

## Argument order

```
skillsmith uninstall [FLAGS] <skill> [<skill>...]
```

At least one `<skill>` is required. If a name is ambiguous across scopes or tools, SkillSmith prints the matches and exits 2 unless `--scope`, `--tool`, or `--all-scopes` disambiguates.

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Limit removal to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit to scope; required if `<skill>` is ambiguous |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--all-scopes` | — | bool | false | — | Remove from every scope where present |
| `--yes` | `-y` | bool | false | — | Skip confirmation |
| `--dry-run` | — | bool | false | — | Print removals without executing |
| `--no-hooks` | — | bool | false | — | Skip `pre-uninstall` / `post-uninstall` hooks ([§1.13](../skillsmith-cli-design.md#113-lifecycle-hooks)) |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

## Help output

```
Remove one or more installed skills.

USAGE
  skillsmith uninstall [flags] <skill>...

ALIASES
  rm, remove

ARGUMENTS
  <skill>    Name of an installed skill. Repeatable.
             If a name exists in multiple scopes or tools, disambiguate
             with --scope, --tool, or --all-scopes.

FLAGS
  -t, --tool <name>          Target tool: claude-code, codex, kilo-code, opencode.
                             Repeatable. Default: all detected tools.
  -s, --scope <scope>        system | user | project. Required when name
                             is ambiguous.
      --user                 Shorthand for --scope=user
      --system               Shorthand for --scope=system
      --project              Shorthand for --scope=project
      --all-scopes           Remove from every scope where present
  -y, --yes                  Skip confirmation prompt
      --dry-run              Print removals without executing
      --continue-on-error    Keep going after per-skill failures

INHERITED FLAGS
  (See 'skillsmith help' for details)

EXAMPLES
  # Remove a skill from the current project
  $ skillsmith uninstall grep --project

  # Remove from every scope it's installed in
  $ skillsmith uninstall grep --all-scopes

  # Dry run
  $ skillsmith rm grep diff --user --dry-run

SEE ALSO
  skillsmith install, skillsmith list
```

## Error and prompt mockups

**`skillsmith uninstall` idempotent no-op:**
```
skill 'grep' is not installed in scope=project

Nothing to do.
Exit 0.
```

**`skillsmith uninstall` ambiguous name:**
```
error: 'grep' is installed in multiple locations:

  user      /Users/alice/.claude/skills/grep              claude-code
  project   ./.claude/skills/grep                         claude-code

Pass --scope to pick one, or --all-scopes to remove from every location.
Exit code: 2
```

**`skillsmith uninstall` summary:**
```
Removing 3 skills from scope=project for tool=claude-code:

  ✓ grep     removed    .claude/skills/grep
  ✓ diff     removed    .claude/skills/diff
  ⚠ edit     not-found  (not installed in scope=project)

3 skills: 2 removed, 0 skipped, 1 not-found, 0 failed.
```
