# SkillSmith CLI design spec

SkillSmith ships as a **flat, verb-first CLI** (npm/cargo/brew school) with **git-style scope flags** (`--system`/`--user`/`--project`), **gh-style help output** (separated FLAGS and INHERITED FLAGS, with EXAMPLES), **gh-style `owner/repo` source shorthand** for installs, and **kubectl/terraform-style idempotent `apply`**. The four MVP verbs — `install`, `sync`, `list`, `apply` — stay at depth 1 until the tool grows a second primary resource type.

This doc is organized as: (1) design decisions, (2) command tree, (3) flag tables, (4) help/error mockups, (5) naming cheat sheet, (6) exit codes and env vars, (7) documentation strategy.

---

## 1. Design decisions (final)

### 1.1 Command structure

SkillSmith uses a **flat, verb-first** command structure. SkillSmith has one primary noun ("skill"), which is the condition under which package-manager CLIs (npm, cargo, brew, pip, deno) stay flat. Hierarchy is reserved for auxiliary concerns only: `skillsmith config …`, `skillsmith tool …`, `skillsmith completion …`. If the top-level surface later grows beyond ~12 verbs, the project may adopt a hybrid model with advance deprecation notices — but that cost is not paid preemptively.

### 1.2 Scope flag naming

SkillSmith uses `--system` / `--user` / `--project` as scope names. Every word means what it says; the names map cleanly to install paths. Short aliases `-s` / `-u` / `-p` are reserved per §1.7. Scope-to-path mapping follows the target tool's own conventions: e.g., Claude Code's `~/.claude/skills/` for `--user`, `.claude/skills/` in the repo for `--project`.

### 1.3 `--scope` flag form

The primary form is `--scope=<enum>` with values `system` / `user` / `project`. Both `--scope user` and `--scope=user` are accepted. A `-s` short alias and a `SKILLSMITH_SCOPE` environment variable provide defaults. Default resolution: `project` when a git repo is detected, else `user`. The boolean sugar flags `--system`, `--user`, `--project` are accepted as equivalents to `--scope=<value>` for ergonomics (see §1.7 on short flags).

### 1.4 Install source reference syntax

Source references use **shorthand-first** syntax. The parser accepts four forms, in this precedence order:

1. Full Git URL (`https://…`, `git@…`, `ssh://…`) → treat as Git source.
2. Three-part `user/repo/skill-name` → GitHub by default (registry configurable).
3. Two-part `repo/skill` → assume default org (from config).
4. One-part `skill` → assume default registry (future).

Scheme-prefixed syntax (`gh:acme/pack/skill`, `jsr:@acme/pack/skill`, `file:./path`) is reserved for Phase 2.

Under the hood, Git sources are fetched via partial clones (`--filter=blob:none` / `--depth=1` when a ref is specified), lazy.nvim-style, so large skill repos don't download unneeded history. `--pin` resolves the ref to a full commit SHA and records it in the manifest/lockfile so subsequent reinstalls are reproducible.

### 1.5 Idempotence and already-installed handling

Re-installing something already present exits **0** with a stderr notice. `--force` reinstalls or overwrites. For `apply` specifically, output mirrors `kubectl apply`: print `created`, `updated`, `unchanged`, `skipped` per skill, with aggregate counts at the end, and exit 0 even if every entry is unchanged.

### 1.6 Cross-scope duplicate detection

A single `--force` flag overrides both "already installed in this scope" and "already installed in another scope". Cross-scope hits are printed to stderr with their scope and path before `--force` is applied, so users see what they are overriding. In interactive TTY mode, if a cross-scope hit is detected and neither `--force` nor `--yes` was passed, SkillSmith prompts. In non-TTY mode without `--force`, SkillSmith exits 2 with a clear error.

### 1.7 Short flag allocation

Short flags are scarce real estate and are allocated only where typing frequency justifies it:

- `-h` = `--help`
- `-V` = `--version` (capital V reserves `-v` for verbose)
- `-v` = `--verbose` (stackable: `-vv` for debug)
- `-q` = `--quiet`
- `-y` = `--yes`
- `-f` = `--force`
- `-s` = `--scope`
- `-t` = `--tool`
- `-p` = `--path`

`--dry-run`, `--from`, `--to`, `--config`, `--no-color` have no short form. Short flags may be combined POSIX-style (`-vf` is `-v -f`).

### 1.8 Global flag placement

Global flags are accepted anywhere on the command line (before or after the subcommand and positionals). This is standard Cobra/clap permutation behavior. The canonical form shown in examples is post-subcommand (`skillsmith install foo --verbose`), but either is valid. Help output separates **FLAGS** (local) from **INHERITED FLAGS** (global), mirroring gh.

### 1.9 Output format

For MVP, machine-readable output is emitted via the `--json` boolean flag on `list` and `apply`. stdout carries data; stderr carries messages, progress, and errors. An `--output yaml|table|text` option is deferred to Phase 2 and only added if demand materializes.

### 1.10 Help routing

All of the following invocation forms are accepted: `skillsmith`, `skillsmith help`, `skillsmith --help`, `skillsmith -h`, `skillsmith <cmd> --help`, `skillsmith <cmd> -h`, `skillsmith help <cmd>`. `-h` and `--help` are equivalent (no git-style split between abbreviated and full help). Cross-cutting docs are exposed via `skillsmith help <topic>` — the topic list is: `exit-codes`, `environment`, `scopes`, `manifest`, `sources`, `formatting`.

### 1.11 Installation model: content-addressed store + symlinks

SkillSmith installs into an **isolated, content-addressed store** (pipx/mise precedent), then symlinks entry points into the target tool's skill directory. This enables conflict-free coexistence of multiple versions and guaranteed-clean uninstall — directly addressing the "disabled doesn't mean uninstalled" class of complaints.

**Store layout** (XDG-compliant, honors the §5 rule):

```
$XDG_DATA_HOME/skillsmith/store/<owner>/<repo>@<sha>/<skill>/
  # fallback: ~/.local/share/skillsmith/store/<owner>/<repo>@<sha>/<skill>/
```

**Entry points** are symlinked into the tool-specific and scope-specific location per §1.2. For example, installing `acme/skills/grep` into `--scope=user` with `--tool=claude-code`:

```
~/.local/share/skillsmith/store/acme/skills@3f2a1b/grep/   <- real content
~/.claude/skills/grep                                      <- symlink into store
```

Project-scope install with the same source points the project-local symlink at the *same* store entry — no duplicate bytes on disk.

**Uninstall** resolves each target symlink to the store entry, removes the symlink, then garbage-collects the store entry if no other symlink references it. `skillsmith list` and `skillsmith doctor` are symlink-aware: `list --long` shows both the symlink path and the store path; orphaned symlinks (dangling into a pruned store entry) are surfaced as warnings.

**Direct-install escape hatch.** For users who need file-copy installation (e.g., tool environments that reject symlinks, air-gapped targets, or simple copy-out-and-ship workflows), `install --direct` bypasses the store and copies files into the target location. `--direct` installs lose coexistence and the clean-uninstall guarantee; `uninstall` of a `--direct` skill falls back to a manifest-tracked file list recorded at install time. The tool is symlink-aware in both directions: mixed stores (some store-backed, some `--direct`) are supported, and `list` marks each with its install mode.

### 1.12 Per-skill configuration (values layering)

Each skill may declare a `values.toml` with default configuration. SkillSmith layers values at resolution time using a Helm-style precedence (high to low):

1. `--set key=value` on the CLI (repeatable)
2. environment variables matching a declared `valuesFromEnv` map
3. project-level override: `./skillsmith.values.toml`
4. user-level override: `$XDG_CONFIG_HOME/skillsmith/values/<skill>.toml`
5. skill default: `values.toml` shipped with the skill

Values are rendered into the skill at install and re-rendered on `sync`/`apply` when any layer changes. This is distinct from SkillSmith's own config precedence in §6.3, which governs the CLI itself.

### 1.13 Lifecycle hooks

Skills may declare lifecycle hooks in their manifest, modeled on Helm's hook annotations:

- `pre-install`, `post-install`
- `pre-upgrade`, `post-upgrade`
- `pre-uninstall`, `post-uninstall`

Hooks are shell scripts or executables shipped inside the skill directory. They run with a minimal, documented environment (`SKILLSMITH_SKILL_NAME`, `SKILLSMITH_SKILL_PATH`, `SKILLSMITH_SCOPE`, `SKILLSMITH_TOOL`, resolved values). A non-zero exit from a `pre-*` hook aborts the operation; a non-zero exit from a `post-*` hook is logged as a warning unless `--strict` is set. `--no-hooks` disables hook execution entirely.

### 1.14 Version compatibility

Skill manifests may declare compatibility ranges for the target tool (VS Code's `engines` and JetBrains' `since-build`/`until-build` precedent):

```toml
[compat]
claude-code = ">=1.1,<2"
codex       = ">=0.5"
```

At install time, if the detected tool version does not satisfy the range, SkillSmith refuses with exit 4 and a remediation hint. `--ignore-compat` overrides for local experimentation; it is not honored in `apply` runs so CI cannot silently drift off the declared compatibility.

### 1.15 Meta-skills (extension packs)

A skill manifest may declare itself a **meta-skill** (VS Code `extensionPack` precedent) by listing other skills as dependencies:

```toml
[meta]
kind = "pack"
includes = [
  "acme/skills/grep",
  "acme/skills/diff",
  "acme/skills/edit",
]
```

Installing a meta-skill resolves and installs all referenced skills transitively. Meta-skills have no content of their own beyond the manifest; uninstalling a meta-skill does **not** cascade to its members (matching VS Code's behavior — members may be shared with other packs). `list --long` marks pack membership.

---

## 2. Command tree for MVP

```
skillsmith                           # prints help (no default action)
skillsmith help                      # top-level help
skillsmith help <command>            # per-command help
skillsmith help <topic>              # cross-cutting docs (topics below)
skillsmith --version | -V            # version
skillsmith --help | -h               # top-level help

# Core MVP verbs

skillsmith install <source> [<source>...]
  # Install one or more skills. <source> is:
  #   owner/repo/skill-name   (GitHub shorthand)
  #   repo/skill-name         (with default org)
  #   <git-url>               (any Git URL)

skillsmith sync [<skill>...]
  # Reconcile installed skills against manifest; with no args syncs the
  # nearest skillsmith.toml found by walking up. --from/--to select scopes
  # or other projects.

skillsmith list [<skill>...]
skillsmith ls   [<skill>...]         # alias
  # List installed skills across scopes and tools. Flags filter by
  # --tool, --scope; --json for machine output; duplicates flagged.

skillsmith apply [<manifest>]
  # Read a TOML manifest (default: ./skillsmith.toml) and install listed
  # skills. Idempotent. Prints created/updated/unchanged/skipped per entry.

skillsmith uninstall <skill> [<skill>...]
skillsmith remove    <skill> [<skill>...]    # alias
skillsmith rm        <skill> [<skill>...]    # alias
  # Remove one or more installed skills. Idempotent; not-installed
  # exits 0 with a stderr notice. --scope/--tool disambiguate when
  # a skill exists in multiple locations.

skillsmith doctor
  # Diagnose SkillSmith and target-tool readiness. Checks config,
  # detected tools, scope paths, manifest, network, and cross-scope
  # duplicates. Exits 0 on all-clear (or warnings unless --strict),
  # 1 if any check failed.

# Auxiliary commands (also MVP)

skillsmith config <get|set|list|unset> [args]
skillsmith completion <bash|zsh|fish|powershell>
skillsmith version                   # same as --version, for ergonomics

# Help topics (no subagent commands, just docs)

skillsmith help exit-codes
skillsmith help environment
skillsmith help scopes
skillsmith help manifest
skillsmith help sources
skillsmith help formatting
```

### 2.1 Argument order

For `install`:

```
skillsmith install [FLAGS] <source> [<source>...]
```

Flags before or after positionals are both accepted (Cobra/clap permute). Multiple sources install all of them atomically (fail fast on first error unless `--continue-on-error`).

For `sync`:

```
skillsmith sync [FLAGS] [<skill>...]
```

`--from` and `--to` are flag-only because their semantics ("sync FROM project A TO project B", or "sync FROM user scope TO project scope") are positional-ambiguous.

For `list`:

```
skillsmith list [FLAGS] [<skill>...]
```

Optional positional filter(s) matching skill name patterns (glob supported): `skillsmith list 'grep*'`.

For `apply`:

```
skillsmith apply [FLAGS] [<manifest>]
```

Positional manifest path optional; defaults to walking up for `skillsmith.toml` (cargo/npm precedent).

For `uninstall`:

```
skillsmith uninstall [FLAGS] <skill> [<skill>...]
```

At least one `<skill>` is required. If a name is ambiguous across scopes or tools, SkillSmith prints the matches and exits 2 unless `--scope`, `--tool`, or `--all-scopes` disambiguates.

For `doctor`:

```
skillsmith doctor [FLAGS]
```

No positional arguments.

---

## 3. Flag tables

### 3.1 Global (inherited) flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--help` | `-h` | bool | — | — | Show help for command |
| `--version` | `-V` | bool | — | — | Print version and exit |
| `--verbose` | `-v` | count | 0 | `SKILLSMITH_VERBOSE` | Verbose output; repeatable (`-vv` = debug) |
| `--quiet` | `-q` | bool | false | `SKILLSMITH_QUIET` | Suppress non-error output |
| `--json` | — | bool | false | — | Emit JSON on stdout (supported commands only) |
| `--no-color` | — | bool | false | `NO_COLOR`, `SKILLSMITH_NO_COLOR` | Disable ANSI colors |
| `--color` | — | enum | `auto` | `SKILLSMITH_COLOR` | `auto`, `always`, `never` |
| `--config` | — | path | (search) | `SKILLSMITH_CONFIG` | Path to user config file |
| `--no-prompt` | — | bool | (auto from TTY) | `SKILLSMITH_NO_PROMPT`, `CI` | Never prompt; fail if input needed |
| `-C` | — | path | `.` | — | Change to directory before running (git/cargo `-C`) |
| `--debug` | — | bool | false | `SKILLSMITH_DEBUG` | Print debug traces to stderr |

### 3.2 `install` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | (auto-detect) | `SKILLSMITH_TOOL` | Target tool: `claude-code`, `codex`, `kilo-code`. Repeatable. |
| `--scope` | `-s` | enum | (auto) | `SKILLSMITH_SCOPE` | `system`, `user`, `project` |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--path` | `-p` | path | (derived from scope+tool) | `SKILLSMITH_PATH` | Override install path |
| `--force` | `-f` | bool | false | — | Reinstall if present; override cross-scope duplicates |
| `--yes` | `-y` | bool | false | — | Skip confirmation prompts |
| `--dry-run` | — | bool | false | — | Print actions without executing |
| `--ref` | — | string | `HEAD` | — | Git ref (branch, tag, commit) for URL sources |
| `--pin` | — | string | — | — | Pin to a specific commit SHA after install (gh-extensions style) |
| `--direct` | — | bool | false | — | Copy files into the target dir instead of symlinking from the store (§1.11) |
| `--set` | — | `k=v` repeatable | — | — | Override values for the skill (§1.12) |
| `--no-hooks` | — | bool | false | — | Skip lifecycle hooks (§1.13) |
| `--ignore-compat` | — | bool | false | — | Install even if tool version is out of range (§1.14); ignored by `apply` |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

### 3.3 `sync` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--from` | — | string | — | — | Source scope or project path |
| `--to` | — | string | — | — | Destination scope or project path |
| `--tool` | `-t` | enum/repeatable | all detected | `SKILLSMITH_TOOL` | Limit sync to tool(s) |
| `--scope` | `-s` | enum | (auto) | `SKILLSMITH_SCOPE` | Limit sync to scope |
| `--force` | `-f` | bool | false | — | Override cross-scope duplicates |
| `--yes` | `-y` | bool | false | — | Skip confirmation |
| `--dry-run` | — | bool | false | — | Preview |
| `--delete` | — | bool | false | — | Remove skills in `--to` absent from `--from` (rsync-style; opt-in) |

### 3.4 `list` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all | `SKILLSMITH_TOOL` | Filter by tool |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Filter by scope |
| `--duplicates` | — | bool | false | — | Show only cross-scope duplicates |
| `--json` | — | bool | false | — | JSON output |
| `--long` | `-l` | bool | false | — | Show paths, sources, commit SHAs |

### 3.5 `apply` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--file` | — | path/repeatable | `./skillsmith.toml` | — | Manifest path(s); repeatable (kubectl `-f`) |
| `--tool` | `-t` | enum/repeatable | from manifest | `SKILLSMITH_TOOL` | Override tool targets |
| `--scope` | `-s` | enum | from manifest | `SKILLSMITH_SCOPE` | Override scope |
| `--force` | `-f` | bool | false | — | Reinstall all |
| `--yes` | `-y` | bool | false | — | Skip prompts |
| `--dry-run` | — | bool | false | — | Preview reconciliation plan |
| `--check` | — | bool | false | — | Drift check: exit non-zero if any skill would be created/updated/deleted. For CI pre-commit. |
| `--prune` | — | bool | false | — | Remove installed skills absent from manifest |
| `--no-hooks` | — | bool | false | — | Skip lifecycle hooks (§1.13) |
| `--set` | — | `k=v` repeatable | — | — | Override values at apply time (§1.12) |

### 3.6 `uninstall` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected | `SKILLSMITH_TOOL` | Limit removal to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit to scope; required if `<skill>` is ambiguous |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--all-scopes` | — | bool | false | — | Remove from every scope where present |
| `--yes` | `-y` | bool | false | — | Skip confirmation |
| `--dry-run` | — | bool | false | — | Print removals without executing |
| `--no-hooks` | — | bool | false | — | Skip `pre-uninstall` / `post-uninstall` hooks (§1.13) |
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

### 3.7 `doctor` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected | `SKILLSMITH_TOOL` | Limit checks to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit checks to scope |
| `--offline` | — | bool | false | — | Skip network checks |
| `--strict` | — | bool | false | — | Treat warnings as failures (exit 1 on any `⚠`) |
| `--json` | — | bool | false | — | JSON output |

---

## 4. Help and error output mockups

### 4.1 `skillsmith --help` / `skillsmith help`

```
SkillSmith installs and manages agent skills for AI coding tools.

USAGE
  skillsmith <command> [flags]

CORE COMMANDS
  install:       Install a skill from a GitHub ref or Git URL
  uninstall:     Remove an installed skill (aliases: rm, remove)
  sync:          Reconcile skills between scopes or projects
  list:          List installed skills across scopes and tools
  apply:         Install skills declared in skillsmith.toml
  doctor:        Diagnose SkillSmith and target-tool readiness

ADDITIONAL COMMANDS
  config:        Manage SkillSmith configuration
  completion:    Generate shell completion scripts
  version:       Print SkillSmith version
  help:          Help about any command or topic

HELP TOPICS
  environment:   Environment variables SkillSmith reads
  exit-codes:    Exit code reference
  formatting:    JSON output and filtering
  manifest:      skillsmith.toml reference
  scopes:        system / user / project scope semantics
  sources:       Supported source reference formats

INHERITED FLAGS
  -C, --path <dir>         Run as if launched from <dir>
      --config <file>      Path to config file (default: search XDG paths)
      --color <when>       auto | always | never (default: auto)
      --no-color           Disable color (alias for --color=never)
  -v, --verbose            Verbose output; repeatable (-vv = debug)
  -q, --quiet              Suppress non-error output
      --json               Emit JSON on stdout (supported commands)
      --no-prompt          Never prompt; fail if input required
  -h, --help               Show help
  -V, --version            Print version

EXAMPLES
  $ skillsmith install acme/skills/grep --user
  $ skillsmith apply
  $ skillsmith list --scope=project --json | jq '.[] | .name'
  $ skillsmith sync --from project --to user

LEARN MORE
  Use 'skillsmith <command> --help' for more information about a command.
  Read the manual at https://skillsmith.dev/docs
```

### 4.2 `skillsmith install --help` / `skillsmith help install`

```
Install one or more agent skills.

USAGE
  skillsmith install [flags] <source>...

ARGUMENTS
  <source>   One of:
               owner/repo/skill-name   GitHub shorthand
               repo/skill-name         With default org
               <git-url>               Any Git URL
             Repeatable.

FLAGS
  -t, --tool <name>          Target tool: claude-code, codex, kilo-code.
                             Repeatable. Default: auto-detect installed tools.
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
  -C, --path, --config, --color, --no-color, -v, --verbose, -q, --quiet,
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

### 4.3 Error and prompt mockups

**Tool not installed:**
```
error: target tool 'codex' is not installed on this system.

  SkillSmith will not install it for you. To install Codex CLI:

    npm install -g @openai/codex

  Re-run once installed, or pass --tool to target a different tool.
```

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

**Did you mean?:**
```
error: 'isntall' is not a skillsmith command.

Did you mean: install?

Run 'skillsmith help' for a list of commands.
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

**Non-TTY, no `--yes`, destructive action:**
```
error: refusing to overwrite 'edit' without confirmation.

This session is non-interactive (stdin is not a TTY).
Pass --yes to auto-confirm, or --force to override existing installs.
Exit code: 2
```

**`apply` output (kubectl-style):**
```
Reading ./skillsmith.toml

  ✓ grep       created    .claude/skills/grep           acme/skills@3f2a1b
  ✓ diff       unchanged  .claude/skills/diff           acme/skills@3f2a1b
  ✓ edit       updated    .claude/skills/edit           acme/skills@7e9c2d
  ⚠ format     skipped    already in user scope; pass --force to override
  ✓ test       created    .claude/skills/test           acme/skills@3f2a1b

5 skills: 3 created/updated, 1 unchanged, 1 skipped, 0 failed.
```

**`apply --check` (drift detection for CI):**
```
$ skillsmith apply --check
Reading ./skillsmith.toml

  ⚠ grep     drift       installed @3f2a1b, manifest @7e9c2d
  ⚠ format   missing     declared in manifest, not installed
  ✓ diff     in-sync     .claude/skills/diff

3 skills: 2 drifted, 1 in-sync.
Exit code: 2

# Example CI hook
#   skillsmith apply --check || { echo "skill drift detected"; exit 1; }
```

### 4.4 `skillsmith uninstall --help` / `skillsmith help uninstall`

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
  -t, --tool <name>          Target tool: claude-code, codex, kilo-code.
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

### 4.5 `skillsmith doctor --help` / `skillsmith help doctor`

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

### 4.6 Additional error / output mockups

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

Scopes
  ✓ user     /Users/alice/.local/share/skillsmith        (writable, 128 GB free)
  ✓ project  /Users/alice/projects/app/.claude/skills    (writable, 128 GB free)
  ⚠ system   /etc/skillsmith                             (not writable; sudo required for --system)

Network
  ✓ github.com reachable

Skills
  ⚠ 1 cross-scope duplicate:
      grep: user (~/.claude/skills/grep) and project (./.claude/skills/grep)
      see 'skillsmith list --duplicates'

7 checks, 3 warnings, 0 failed.
```

**`skillsmith uninstall` idempotent no-op:**
```
skill 'grep' is not installed in scope=project

Nothing to do.
Exit 0.
```

**`skillsmith uninstall` ambiguous name:**
```
error: 'grep' is installed in multiple locations:

  user      /Users/alice/.local/share/skillsmith/grep     claude-code
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

---

## 5. Naming convention cheat sheet

**Commands.** Use verbs for actions (`install`, `sync`, `list`, `apply`). Use nouns only as subgroups when the command surface gains a second primary resource type. Single word when possible. Hyphenated multi-word kebab-case when necessary (`set-default`, never `setDefault` or `set_default`). No plurals for verb commands; plurals only on resource noun groups if we add them (`skills`, not `skill`, in group names — following gcloud/stripe plural convention).

**Aliases.** Ship these built-in aliases and no more: `ls` → `list`, `rm` / `remove` → `uninstall`, `i` → `install`. No abbreviations for `sync`, `apply`, or `doctor` — they are already short and clear. Users can define their own via `skillsmith config alias.<name>`.

**Flags.** Long form is `--kebab-case`. Short form is a single letter, allocated sparingly (see §1.7). Boolean flags are presence-only; provide `--no-<flag>` counterparts only for flags that default to true. Enum flags (`--scope`, `--tool`, `--color`) use lowercase-kebab values. Accept both `--flag value` and `--flag=value`. Repeatable flags accumulate (repeat the flag; do not use comma-separation in MVP). Short flags may be combined POSIX-style (`-vf` is `-v -f`).

**Env vars.** `SKILLSMITH_<NAME>` in SCREAMING_SNAKE_CASE. Honor cross-tool standards verbatim: `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `TERM`, `PAGER`, `EDITOR`, `VISUAL`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CI`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`.

**Config keys.** `kebab-case` in TOML (`default-tool`, `default-scope`), dotted paths for nested (`registry.default`, `tool.claude-code.path`). Match env var name by uppercasing and replacing dots/dashes with underscores (`SKILLSMITH_DEFAULT_TOOL`, `SKILLSMITH_REGISTRY_DEFAULT`).

**Paths and files.** `skillsmith.toml` for project manifest (cargo precedent). `~/.config/skillsmith/config.toml` for user config (XDG). `~/.local/share/skillsmith/store/<owner>/<repo>@<sha>/<skill>/` for content-addressed skill content (§1.11); tool-specific locations (`~/.claude/skills/<skill>`, `./.claude/skills/<skill>`, etc.) hold symlinks into the store, except for `--direct` installs which are plain files tracked by install manifest. `~/.cache/skillsmith/` for Git clones and download cache. Never use `~/.skillsmith/` — XDG compliance from day one.

**Source refs.** Three-part `<owner>/<repo>/<skill>` is canonical shorthand. Two-part and one-part forms fall back to defaults from config. Git URLs accepted verbatim. Scheme-prefixed form (`gh:`, `file:`, `jsr:`) reserved for Phase 2.

---

## 6. Exit codes, output formats, environment variables

### 6.1 Exit codes

Document these in `skillsmith help exit-codes`:

| Code | Meaning |
|---|---|
| 0 | Success (including idempotent no-op) |
| 1 | Generic failure (install error, network error, parse error) |
| 2 | Usage error, cancelled action, or refused destructive action without `--force`/`--yes` |
| 3 | Config error (malformed `skillsmith.toml` or user config) |
| 4 | Target tool not installed, or installed tool version is outside the skill's declared compatibility range (§1.14) |
| 5 | Source unresolvable (repo not found, skill not in repo, ref not found) |
| 6 | Scope/permission error (cannot write to system scope without privileges) |
| 130 | Cancelled via SIGINT (Ctrl-C) — standard Unix signal-exit |

Partial failures in batch operations (`install` with multiple sources, `apply` with many entries) exit with the **highest** code from any failure, unless `--continue-on-error` was set, in which case exit with code 1 if any failed.

### 6.2 Output format

`--json` is the sole machine-output flag in MVP. When set, stdout is a single JSON value (object or array); human-oriented progress/status goes to stderr. Without `--json`, stdout receives a human-readable table or narrative; stderr receives warnings and errors. Always auto-detect TTY: disable colors, progress bars, and spinners when stdout is not a TTY. Respect `NO_COLOR` unconditionally (no-color.org standard). Honor `FORCE_COLOR` and `CLICOLOR_FORCE` to re-enable. Honor `TERM=dumb`. Add `--output yaml|table|text` in Phase 2 only if demand emerges.

### 6.3 Environment variables

Document in `skillsmith help environment`:

```
SKILLSMITH_CONFIG           Path to user config (default: XDG search path)
SKILLSMITH_HOME             Override XDG data dir for installed skills
SKILLSMITH_CACHE            Override XDG cache dir
SKILLSMITH_TOOL             Default --tool
SKILLSMITH_SCOPE            Default --scope
SKILLSMITH_PATH             Default --path
SKILLSMITH_REGISTRY         Default registry base (e.g. github.com/acme)
SKILLSMITH_TOKEN            Git/API token for private sources
SKILLSMITH_DEBUG            Non-empty = enable debug traces (same as --debug)
SKILLSMITH_VERBOSE          Integer level (1=verbose, 2=debug)
SKILLSMITH_QUIET            Non-empty = suppress non-error output
SKILLSMITH_NO_COLOR         Non-empty = disable color (fallback to NO_COLOR)
SKILLSMITH_NO_PROMPT        Non-empty = never prompt
SKILLSMITH_COLOR            auto | always | never

# Honored cross-tool standards
NO_COLOR                    Disables color (any non-empty value)
FORCE_COLOR / CLICOLOR_FORCE  Forces color even when not a TTY
CLICOLOR=0                  Alias for NO_COLOR
TERM=dumb                   Disables color/styling
CI                          Non-empty: infer non-interactive; disables prompts
PAGER                       Pager for multi-page help
EDITOR / VISUAL             For manifest editing (e.g., skillsmith config edit)
HTTPS_PROXY / HTTP_PROXY / NO_PROXY   Proxy for Git/API
XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME   Config/data/cache roots
```

Precedence (high to low): CLI flag > env var > project `skillsmith.toml` > user config > system config > built-in default.

### 6.4 Config file locations (XDG-compliant)

- User config: `$XDG_CONFIG_HOME/skillsmith/config.toml`, fallback `~/.config/skillsmith/config.toml`
- User values overrides: `$XDG_CONFIG_HOME/skillsmith/values/<skill>.toml` (§1.12)
- Skill store (content-addressed): `$XDG_DATA_HOME/skillsmith/store/<owner>/<repo>@<sha>/<skill>/`, fallback `~/.local/share/skillsmith/store/…` (§1.11)
- Install manifests for `--direct` installs: `$XDG_DATA_HOME/skillsmith/direct/<tool>/<scope>/<skill>.files` (file list recorded at install so uninstall can remove exactly what was written)
- Cache (Git clones, downloads, partial-clone shallows): `$XDG_CACHE_HOME/skillsmith/`, fallback `~/.cache/skillsmith/`
- System config: `/etc/skillsmith/config.toml`
- Project manifest: `./skillsmith.toml` (discovered by walking up from CWD, cargo/npm pattern)
- Project values override: `./skillsmith.values.toml`
- Windows: `%APPDATA%\SkillSmith\`, `%LOCALAPPDATA%\SkillSmith\` per Microsoft guidance

The tool-and-scope install path is not a SkillSmith config location but a **tool-specific** path SkillSmith writes into — e.g., `./.claude/skills/` for Claude Code at project scope, `~/.claude/skills/` at user scope, `/usr/local/share/claude/skills/` at system scope. These are derived at runtime from the target tool's own conventions and overridable by `--path`. By default SkillSmith writes a symlink at that path pointing into the store (§1.11); with `--direct` it writes a file-copy tree instead.

---

## 7. Help and documentation strategy

**Inline help is the primary surface.** Ship rich Cobra/clap help with per-command EXAMPLES sections and a top-level HELP TOPICS list. A small set of dedicated topic pages — `exit-codes`, `environment`, `scopes`, `manifest`, `sources`, `formatting` — covers cross-cutting concerns without bloating per-command help.

**Man pages** are auto-generated from the Cobra/clap command tree and shipped with the binary, installed via Homebrew, apt, and other distribution packages. Deferred to Phase 2 if time-boxed for MVP; inline help covers 95% of use cases.

**Shell completion.** Ship `skillsmith completion <bash|zsh|fish|powershell>` that prints a completion script to stdout. Completions include subcommands, flag names, and enum values (`--scope` values, `--tool` values). Dynamic completions for skill names and source refs are deferred to Phase 2 (they require network calls that slow shells).

**Website documentation** lives at `https://skillsmith.dev/docs` (placeholder). Structure:

1. Quickstart (install, first skill, first manifest)
2. Concepts (scopes, tools, sources, manifest)
3. Command reference (auto-generated from CLI help, one page per command)
4. Recipes (common workflows: monorepo, team defaults, CI)
5. Reference (exit codes, env vars, config schema, manifest schema)

Every `--help` page ends with `Read the manual at https://skillsmith.dev/docs`. Every error message that refers to a concept links to the relevant docs page.

**Typo correction** ("did you mean?") is provided via clap's built-in suggestions or Cobra's `SuggestFor`, with Levenshtein threshold 2. Enabled by default; controllable via `skillsmith config set help.autocorrect <never|prompt|immediate>` (git's model, since Git 2.34).
