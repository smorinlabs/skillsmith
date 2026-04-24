# install

Install one or more agent skills from a source reference.

## Argument order

```
skillsmith install [FLAGS] <source> [<source>...]
```

Flags before or after positionals are both accepted (Cobra/clap permute). Multiple sources install all of them atomically (fail fast on first error unless `--continue-on-error`).

## Flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | auto-detect (prompts in TTY, first detected in non-TTY) | `SKILLSMITH_TOOL` | Target tool: `claude-code`, `codex`, `kilo-code`, `opencode`. Repeatable. |
| `--scope` | `-s` | enum | (auto) | `SKILLSMITH_SCOPE` | `system`, `user`, `project` |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--path` | `-p` | path | (derived from scope+tool) | `SKILLSMITH_PATH` | Override install path |
| `--force` | `-f` | bool | false | — | Treat already-installed entries as install targets; override cross-scope duplicates |
| `--yes` | `-y` | bool | false | — | Skip confirmation prompts |
| `--dry-run` | — | bool | false | — | Print actions without executing |
| `--ref` | — | string | `HEAD` | — | Git ref (branch, tag, commit) for URL sources |
| `--pin` | — | string | — | — | Pin to a specific commit SHA after install (gh-extensions style) |
| `--direct` | — | bool | false | — | Copy files into the target dir instead of symlinking from the store ([§1.11](../skillsmith-cli-design.md#111-installation-model-content-addressed-store--symlinks)) |
| `--set` | — | `k=v` repeatable | — | — | Override values for the skill ([§1.12](../skillsmith-cli-design.md#112-per-skill-configuration-values-layering)) |
| `--no-hooks` | — | bool | false | — | Skip lifecycle hooks ([§1.13](../skillsmith-cli-design.md#113-lifecycle-hooks)) |
| `--no-adapt` | — | bool | false | — | Skip cross-tool adaptation ([§1.16](../skillsmith-cli-design.md#116-cross-tool-adaptation)); install skill as-authored |
| `--ignore-compat` | — | bool | false | — | Install even if tool version is out of range ([§1.14](../skillsmith-cli-design.md#114-version-compatibility)); ignored by `apply` |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

## Help output

```
Install one or more agent skills.

USAGE
  skillsmith install [flags] <source>...

ALIASES
  i

ARGUMENTS
  <source>   One of:
               owner/repo/skill-name   GitHub shorthand
               repo/skill-name         With default org
               <git-url>               Any Git URL
             Repeatable.

FLAGS
  -t, --tool <name>          Target tool: claude-code, codex, kilo-code, opencode.
                             Repeatable. Default: auto-detect; prompts in TTY,
                             uses first detected in non-TTY.
  -s, --scope <scope>        system | user | project. Default: project if in
                             a Git repo, else user.
      --user                 Shorthand for --scope=user
      --system               Shorthand for --scope=system
      --project              Shorthand for --scope=project
  -p, --path <dir>           Override install path for <tool>+<scope>
      --ref <git-ref>        Branch, tag, or commit (default: HEAD)
      --pin                  Pin to resolved commit SHA after install
  -f, --force                Reinstall if present; override cross-scope duplicates
  -y, --yes                  Skip interactive confirmation
      --dry-run              Print actions without executing
      --continue-on-error    Keep going after per-skill failures

INHERITED FLAGS
  -C, --cd, --config, --color, --no-color, -v, --verbose, -q, --quiet,
  --json, --no-prompt, -h, --help, -V, --version
  (See 'skillsmith help' for details)

EXAMPLES
  # Install from a GitHub ref into the current project, for Claude Code
  $ skillsmith install acme/skills/grep --tool claude-code --project

  # Install into user scope for all detected tools
  $ skillsmith install acme/skills/grep --user

  # Install from a Git URL, pinned
  $ skillsmith install https://github.com/acme/skills.git --pin

  # Install multiple skills
  $ skillsmith install acme/skills/grep acme/skills/diff --user

ENVIRONMENT
  SKILLSMITH_TOOL            Default for --tool
  SKILLSMITH_SCOPE           Default for --scope
  SKILLSMITH_PATH            Default for --path

SEE ALSO
  skillsmith apply, skillsmith sync, skillsmith help sources
```

## Error and prompt mockups

**Skill already installed (no --force):**
```
skill 'grep' is already installed in scope=user
  path: /Users/alice/.claude/skills/grep
  source: acme/skills@3f2a1b

use --force to reinstall, or 'skillsmith list --duplicates' to see all installs.

Exit 0: nothing to do.
```

**Cross-scope duplicate detected:**
```
warning: 'grep' is already installed in scope=user
  user    /Users/alice/.claude/skills/grep        (acme/skills@3f2a1b)
  project ./.claude/skills/grep                   <- installing here

Project-scope install will shadow the user-scope copy for this repo.
Pass --force to proceed, or use a different scope.

error: cross-scope duplicate; use --force to override.
Exit code: 2
```

**Interactive prompt (TTY only, no --yes):**
```
About to install 3 skills into scope=project for tool=claude-code:

  acme/skills/grep          -> .claude/skills/grep
  acme/skills/diff          -> .claude/skills/diff
  acme/skills/edit          -> .claude/skills/edit  (overwrites existing)

Proceed? [y/N]
```

**Interactive install (no flags, TTY, in a Git repo):**
```
$ cd ~/code/my-app
$ skillsmith install acme/agent-tools/code-review

  Detected Git repo.

  Installed tools:
    › claude-code
      codex

  Also available (not installed):
      kilo-code  → install: npm i -g @kilocode/cli
      opencode   → install: <install-cmd-TBD>

  Install scope?
    › project (./.claude/skills)
      user    (~/.claude/skills)
      system  (/etc/claude/skills)

  ⚠ Skill already installed at user scope.
    Installing at project scope would duplicate across layers.
    Re-run with --force to proceed.
```

**Cross-tool adaptation (install of a claude-code skill into codex):**
```
$ skillsmith install acme/agent-tools/claude-reviewer --tool codex

  Source skill targets: claude-code
  Applying deterministic adapter: claude-code → codex ✓
    frontmatter 'allowed-tools' → 'tools'
    file layout: prompts/*.md → instructions/*.md
  Installed at ~/.codex/skills/claude-reviewer
    store:   ~/.local/share/skillsmith/store/acme/agent-tools@3f2a1b/claude-reviewer
    adapted: ~/.local/share/skillsmith/adapted/acme/agent-tools@3f2a1b/claude-reviewer/codex
```
