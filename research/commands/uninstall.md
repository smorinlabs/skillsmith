# uninstall

`skillsmith uninstall` removes installed skill placements and their ledger records. Aliases: `rm`,
`remove`. Store entries are immortal — uninstall never deletes from the content-addressed store, so
reinstalling a previously stored revision is instant (and, for a full-SHA source, offline).

Removal is journaled through the same swap machinery as `install`/`promote`/`dev`: an interrupted
uninstall is always recoverable. A placement in **dev mode** (symlink into a live checkout) is
refused with guidance unless `--force`; a placement SkillSmith did not create (no ledger record) is
likewise refused unless `--force`, and unreproducible copies are preserved as backups rather than
destroyed.

Full design — scope disambiguation, crash story, JSON contract — lives in
`docs/superpowers/specs/2026-07-07-p09-install-design.md` (§9, §12.2). This page is the command
surface.

## Argument order

```
skillsmith uninstall <skill> [<skill>...] [FLAGS]
```

At least one `<skill>` (installed skill name, or a placement path) is required. If a name exists in
more than one scope, the matches are listed and the command exits 2 unless `--scope`, `--tool`, or
`--all-scopes` disambiguates.

## Flags

| Long | Short | Type | Default | Description |
|---|---|---|---|---|
| `--tool` | `-t` | enum, repeatable | every tool where the skill is found | Limit removal to tool(s): `claude-code`, `codex`. No binary detection needed — uninstall operates on directories and the ledger. |
| `--scope` | `-s` | enum | user + current project searched | `user` or `project`; required when the name is ambiguous across scopes. |
| `--user` | — | bool | — | Shorthand for `--scope=user` |
| `--project` | — | bool | — | Shorthand for `--scope=project` |
| `--all-scopes` | — | bool | false | Remove from user scope and the current project's scope. |
| `--force` | `-f` | bool | false | Override the dev-mode refusal and the unmanaged-placement refusal. |
| `--dry-run` | — | bool | false | Print the removal plan without executing. |
| `--json` | — | bool | false | Versioned JSON report (`kind: "skillsmith.uninstall"`) on stdout. |
| `--yes` | `-y` | bool | false | Accepted no-op — uninstall never prompts; destructive cases are gated by `--force`. |

## Help output

```
Remove installed skills (placements + ledger records; the store is never deleted).

USAGE
  skillsmith uninstall <skill>... [flags]

ALIASES
  rm, remove

ARGUMENTS
  <skill>    Installed skill name (the directory name in a tool's skills root)
             or a placement path. Repeatable. Ambiguous across scopes →
             disambiguate with --scope, --tool, or --all-scopes.

FLAGS
  -t, --tool <name>          claude-code | codex. Repeatable. Default: every
                             tool where the skill is found.
  -s, --scope <scope>        user | project. Required when the name is ambiguous.
      --user, --project      Shorthand for --scope=user / --scope=project
      --all-scopes           Remove from user scope and the current project
  -f, --force                Remove dev-mode or unmanaged placements too
      --dry-run              Print removals without executing
      --json                 Emit the versioned JSON report on stdout

INHERITED FLAGS
  -C, --cd, --color, --no-color, -v, --verbose, -q, --quiet,
  --no-prompt, --debug, -h, --help, -V, --version
  (See 'skillsmith help' for details)

EXAMPLES
  # Remove a skill everywhere it is placed for both tools
  $ skillsmith uninstall factor-scan

  # Remove only the project-scope copy
  $ skillsmith uninstall review --project

  # Remove from every scope, codex only
  $ skillsmith rm review --all-scopes --tool codex

  # Preview
  $ skillsmith uninstall factor-scan --dry-run

EXIT CODES
  0    removed (or not installed anywhere — idempotent no-op)
  1    removal failed mid-flight (state recoverable)
  2    refusal: ambiguous across scopes, dev-mode placement without --force,
       unmanaged placement without --force, unresolved journal
  3    placements ledger unreadable
  6    permission error (skills dir or ledger not writable)
  130  cancelled (SIGINT; state recoverable)
```

## Error and prompt mockups

**Success (human output):**
```
Removing factor-scan  (scope: user)

claude-code  ~/.claude/skills/factor-scan
  remove   store symlink                                          removed
           store retained: smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan
codex        ~/.agents/skills/factor-scan
  remove   store symlink                                          removed

2 removed.  Exit code: 0
```

**Not installed (idempotent no-op):**
```
'factor-scan' is not installed in any searched scope (user, project ./).

Nothing to do.  Exit code: 0
```

**Ambiguous across scopes:**
```
error: 'review' is installed in multiple scopes:

  user      ~/.claude/skills/review              claude-code
  project   ./.claude/skills/review              claude-code

Pass --scope user|project to pick one, or --all-scopes to remove from both.
Exit code: 2
```

**Dev-mode placement refused (U3):**
```
error: 'factor-scan' (claude-code) is in dev mode — the placement is a live
symlink into ~/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan.

  Pin it first with 'skillsmith promote factor-scan', restore the pinned copy
  with 'skillsmith dev --rollback factor-scan', or pass --force to remove the
  symlink (the checkout itself is never touched).

Exit code: 2
```

**Unmanaged placement refused:**
```
error: 'notes-helper' (claude-code) exists at ~/.claude/skills/notes-helper but
was not installed by skillsmith (no ledger record, no store copy).

  Pass --force to remove it anyway. A copy that cannot be reproduced from the
  store is preserved as a backup, not destroyed.

Exit code: 2
```

**Legacy codex root (removal proceeds, with notice):**
```
codex        ~/.codex/skills/review
  note     placement is in the legacy ~/.codex/skills (current convention: ~/.agents/skills)
  remove   pinned copy (hash-matched to store)                    removed

1 removed.  Exit code: 0
```

## Open questions

1. **Should a future `store gc` verb exist?** Uninstall never deletes store entries (write-once,
   PRD §7) and v1 accepts store growth. If disk pressure ever matters, GC would need reference
   counting across ledgers and scopes — deliberately out of scope for v0.6.0 (spec §17).
