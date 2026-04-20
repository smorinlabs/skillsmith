# SkillSmith CLI design proposal

SkillSmith should ship as a **flat, verb-first CLI** (npm/cargo/brew school) with **git-style scope flags** (`--system`/`--user`/`--project`), **gh-style help output** (separated FLAGS and INHERITED FLAGS, with EXAMPLES), **gh-style `owner/repo` source shorthand** for installs, and **kubectl/terraform-style idempotent `apply`**. The four MVP verbs — `install`, `sync`, `list`, `apply` — map cleanly to these precedents without inventing new conventions, and the surface should stay flat at depth 1 until the tool grows a second primary resource type. The recommendations below are grounded in a survey of ~18 mainstream CLIs and the four canonical design guides (POSIX, GNU, clig.dev, 12-Factor CLI).

The proposal is organized as: (1) research survey, (2) opinionated decisions with 2–3 options each, (3) concrete command tree, (4) flag tables, (5) help/error mockups, (6) naming cheat sheet, (7) exit codes and env vars, (8) documentation strategy.

---

## 1. Research survey

### 1.1 Command structure and nesting

Two broad families emerged. **Package-manager CLIs** — npm, pnpm, yarn, cargo, pip, brew, deno — are almost uniformly **flat, verb-first**, because they manage one primary resource type (packages). Depth is 1 level; 2 levels only for auxiliary concerns like `npm cache clean`, `pip config set`, `brew services start`. **Platform CLIs** — gh, docker (modern), aws, gcloud, rustup, stripe — are **noun-verb hierarchical** at 2–4 levels because they manage heterogeneous resources and the same verbs (create, list, delete) collide across nouns. **kubectl** is the interesting outlier: verb-first (`kubectl get pods`) but the resource is a positional argument with built-in shortnames (`po`, `svc`, `deploy`).

Docker is the canonical cautionary tale: it started flat (`docker ps`, `docker images`, `docker rm`, `docker rmi`) and retrofitted a hierarchy in 2017 (`docker container ls`, `docker image ls`, `docker volume rm`) because the top-level namespace collided and `rm` was ambiguous. The legacy commands were kept as aliases forever, producing permanent UX debt. **The lesson: choose flat only if you are confident the surface stays small.** gh and rustup were noun-verb from inception and grew cleanly.

**Install-command forms** are remarkably consistent across package managers: single positional, source-type encoded in the spec string rather than a flag. `npm install <pkg>`, `pip install <pkg>`, `brew install <formula>`, `cargo install <crate>`, `gh extension install <owner>/<repo>`, `deno install jsr:@std/http`, `deno install npm:chalk`. The `owner/repo` shorthand (gh extensions, brew taps `user/tap/formula`) is the direct precedent for SkillSmith's `user/repo/skill-name`. A modern consensus has also emerged around **splitting `add` (mutate manifest) from `install` (sync from lockfile)** — yarn, pnpm, and cargo do this explicitly; npm's overloaded `install` is increasingly regarded as a legacy wart.

**`list` vs `ls`:** npm, pnpm, brew, docker, vercel all accept `ls` as an alias for `list`. pip and cargo do not. kubectl deliberately skips both in favor of `get`. The `ls` alias is an expected ergonomic.

### 1.2 Naming conventions

**Verbs for top-level operations, nouns for subgroups** is the dominant pattern. When nouns appear, they are **plural** in hierarchical CLIs (`gcloud compute instances list`, `stripe customers create`, `kubectl get pods`) and **singular** only inside Docker-style management groups where the group name *is* the type (`docker container ls`). Multi-word verbs are **kebab-case** universally (`aws ec2 describe-instances`, `gcloud container clusters get-credentials`); snake_case never appears.

**Alias conventions cluster into three classes.** (1) **Verb shortcuts**: cargo ships `b`/`c`/`t`/`r`/`d` for build/check/test/run/doc; npm ships `i`/`rm`/`ls`/`un`; these are first-letter, hot-path. (2) **Noun shortnames**: kubectl has `po`/`svc`/`deploy`/`cm`/`ns` declared per-resource in the API. (3) **Verb synonyms**: `list`/`ls`, `remove`/`rm`/`uninstall`. Git ships **zero** built-in aliases, pushing customization to `~/.gitconfig`.

### 1.3 Flag conventions

POSIX and GNU set the floor and every modern CLI respects it: short flags are `-x` (single alphanumeric), long flags are `--kebab-case` (multi-char), `--` terminates option parsing, `-` means stdin/stdout. GNU adds `--name=value` and `--name value` equivalence for long options (optional-valued flags **must** use `=`), permutation of options around positionals, and the `--help`/`--version` universal.

**Case:** every surveyed tool uses `--kebab-case` for long options. npm additionally accepts camelCase aliases; no one uses snake_case.

**Equals vs space:** nearly universal dual support. Exception: terraform uses single-dash long flags (`-var=foo=bar`) because it's built on Go's stdlib `flag` package.

**Boolean flags** are typically presence-only (`--force`, `--verbose`). When a default may be true and must be disabled, tools use paired `--flag`/`--no-flag` (aws style: every boolean is a pair) or `--flag=false` explicit (kubectl, docker). Tri-state string flags (`--color=auto|always|never`, `--dry-run=none|client|server`) are common for settings with more than two states.

**Repeatable flags:** repeat the flag; values accumulate into a list. `docker run -e A=1 -e B=2 -v /a:/a -v /b:/b`, `kubectl -f a.yaml -f b.yaml -l k=v -l k2=v2`, `gh pr create -l bug -l urgent`. Comma-separated as an additional shortcut is rare and inconsistent (aws).

**Negation:** `--no-<flag>` is the dominant, readable form (git `--no-verify`, `--no-edit`, `--no-pager`; docker/pip `--no-cache`; npm `--no-save`, `--no-optional`; cargo/pip `--no-deps`). Clap and Cobra auto-generate the negation.

**Short-flag combining (POSIX `-xvf`)** is supported by docker, git, kubectl, cargo, curl, rg. npm and aws largely lack single-char shorts to combine.

**Env var equivalents** follow `<TOOL>_<SETTING>` in SCREAMING_SNAKE_CASE: `GH_TOKEN`, `GH_REPO`, `GH_HOST`; `DOCKER_HOST`, `DOCKER_CONFIG`; `KUBECONFIG`; `CARGO_HOME`; `AWS_PROFILE`, `AWS_REGION`. Precedence is **universal**: CLI flag > env var > project config > user config > system config > default. Cross-tool standards everyone honors: `NO_COLOR`, `CLICOLOR`/`CLICOLOR_FORCE`, `FORCE_COLOR`, `TERM=dumb`, `PAGER`, `EDITOR`/`VISUAL`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `CI`.

### 1.4 Global vs local flag placement

**Disagreement is sharp here.** git requires "global" options **before** the subcommand (`git --git-dir=/repo status` works, reversed does not). Docker similarly places client-level flags before the subcommand group (`docker -H tcp://remote:2375 ps`). **kubectl, cargo, gh, and aws allow global flags anywhere** thanks to Cobra/clap argument permutation — `kubectl -n kube-system get pods` and `kubectl get pods -n kube-system` both work.

**Help presentation is where gh shines.** gh separates **"FLAGS"** (command-local) and **"INHERITED FLAGS"** (global and group-level) as distinct sections in every subcommand's `-h` output. kubectl dumps its ~22 global flags at the bottom of every help page, which the community has complained about for years (k8s issues #23402, #4142). aws repeats its global parameters verbatim in every operation's help. Cargo structures help into "Options", "Manifest Options", "Common Options", "Display Options".

### 1.5 Help system

Every modern CLI accepts **all five** of `tool`, `tool help`, `tool --help`, `tool -h`, `tool <cmd> --help`, plus `tool help <cmd>` as a less-common alternate path. git is the historical exception where `-h` prints abbreviated usage and `--help` opens the man page; most modern tools (gh, cargo, cobra-based CLIs) treat `-h` and `--help` as equivalent.

**gh's help structure** is the cleanest reference implementation:

```
USAGE
  gh <command> <subcommand> [flags]

CORE COMMANDS
  auth, browse, codespace, gist, issue, org, pr, project, release, repo

GITHUB ACTIONS COMMANDS
  cache, run, workflow

ADDITIONAL COMMANDS
  alias, api, completion, config, extension, ...

HELP TOPICS
  actions, environment, exit-codes, formatting, mintty, reference

INHERITED FLAGS
  --help   Show help for command

EXAMPLES
  $ gh issue create
  $ gh repo clone cli/cli

LEARN MORE
  Use `gh <command> <subcommand> --help` for more information about a command.
  Read the manual at https://cli.github.com/manual
```

The grouping (core / actions / additional / help topics / inherited / examples / learn more), the separation of inherited flags, and the explicit "learn more" footer are all directly copyable. gh also ships a rich `gh help <topic>` model for cross-cutting concerns — `gh help exit-codes`, `gh help environment`, `gh help formatting` — which is strictly better than stuffing everything into one mega-page.

Shell completions are ubiquitous: `gh completion bash|zsh|fish|powershell`, `kubectl completion`, `rustup completions`, `docker completion`. The dominant pattern is a built-in subcommand that prints a completion script to stdout, with distribution managers (brew, apt) handling installation paths.

### 1.6 gh deep dive

gh is the single most-cited modern CLI for design. It is built on **Cobra** (same framework as kubectl, docker, hugo, stripe) and demonstrates the framework's best-practice patterns at full maturity:

- **Strict noun-verb at 2 levels**, occasionally 3. `gh repo create`, `gh pr list`, `gh issue view 42`, `gh extension install owner/gh-foo`, `gh run watch`, `gh auth login`.
- **Inherited flags** surface `--help` universally; group-level inherited flags (e.g., `-R`/`--repo` for all pr/issue/release subcommands) keep per-command lists short.
- **Alias system**: `gh alias set co 'pr checkout'` stores in `~/.config/gh/config.yml`; aliases appear under an "ALIAS COMMANDS" section in `gh --help`.
- **Extensions**: `gh extension install owner/gh-foo` installs binaries from GitHub releases or clones script-based repos into `~/.local/share/gh/extensions/`. `--pin` pins to a tag/commit. Extensions become top-level commands (`gh foo`). Core commands cannot be overridden; collisions resolved via `gh extension exec <name>`.
- **Config**: `~/.config/gh/config.yml` (user preferences) + `~/.config/gh/hosts.yml` (auth tokens per host). `GH_CONFIG_DIR` overrides. Fully XDG-compliant on Linux/macOS.
- **Env vars**: `GH_TOKEN`/`GITHUB_TOKEN`, `GH_HOST`, `GH_REPO`, `GH_EDITOR`, `GH_PAGER`, `GH_DEBUG`, `GH_PROMPT_DISABLED`, `GH_FORCE_TTY`, `NO_COLOR`, `GLAMOUR_STYLE`. Precedence: flag > env > config > default.
- **Output**: `--json <fields>` + `--jq <expr>` + `--template <go-tmpl>`. Errors if the command doesn't support `--json`. `gh help formatting` documents the model.
- **Exit codes**: documented at `gh help exit-codes`: `0` success, `1` failure, `2` cancelled, `4` auth required, `8` checks pending (per-command extensions).
- **Auth flow**: `gh auth login` offers interactive web flow (device code) or token paste; supports multiple hosts; integrates with git's credential helper.

The notable design virtues are: (a) the "INHERITED FLAGS" convention in help, (b) the `owner/repo` shorthand for installs, (c) the `help <topic>` model for cross-cutting docs, (d) explicit documented exit codes, (e) separation of `--yes` (skip confirmation) from any "force" semantics (gh uses typing the resource name, not `--force`, for truly destructive ops like `gh repo delete`).

### 1.7 Exit codes, output, prompts, dry-run

**Exit codes** cluster around `0`/`1`/`2` with tool-specific extensions. bash convention: `2` = misuse. curl, rsync, npm have extensive specific codes. gh's documented `0`/`1`/`2`/`4` model is the cleanest modern precedent. Docker passes through container exit codes and reserves `125`/`126`/`127` for daemon/exec failures.

**Output formats** disagree on the flag name: kubectl `-o json|yaml|wide|jsonpath=...`, aws `--output json|yaml|text|table` (global), gh `--json <fields> --jq <expr>`, docker `--format '{{json .}}'` (Go templates), npm `--json`. A clean modern choice is `--json` as a boolean (clig.dev's recommendation) plus optional `--jq`/`--template` filters.

**Confirmation and non-interactive:** TTY detection is standard. `-y`/`--yes`/`--assume-yes` skips prompts. `--non-interactive`/`--no-input` promises no prompting ever. 12-Factor CLI and clig.dev both say: **prompt if TTY, never require a prompt, always allow a flag-driven path.**

**Dry-run:** `--dry-run` is the long form; `-n` is the short form where the tool has POSIX heritage (rsync, git). kubectl uses tri-state `--dry-run=none|client|server` (client = print only; server = validate via API).

**Idempotence — critical for SkillSmith.** When re-installing something already present: apt, pip, npm, cargo, and kubectl `apply` all **exit 0** with a notice ("Requirement already satisfied", "package X is already installed, use --force to overwrite", "unchanged"). Only **brew exits non-zero** on "already installed", and this is widely regarded as broken for scripting (brew issue #2491, still open). SkillSmith should follow the apt/pip/npm/kubectl consensus: exit 0, print to stderr, gate reinstall behind `--force`.

**Color:** respect `NO_COLOR` (no-color.org) unconditionally, auto-detect TTY, honor `TERM=dumb`, offer `--color=auto|always|never`. Universally adopted.

**`--force` vs `--yes`:** the best CLIs keep these separate. `--yes` skips confirmation prompts; `--force` overrides safety checks (overwrite conflicts, reinstall). gh, stripe, heroku all separate them. npm and brew sometimes conflate, creating confusion.

### 1.8 Config file conventions

**User-level config** increasingly follows **XDG Base Directory Spec**: `$XDG_CONFIG_HOME/<tool>/` (default `~/.config/<tool>/`) for config, `$XDG_DATA_HOME/<tool>/` (default `~/.local/share/<tool>/`) for data, `$XDG_CACHE_HOME/<tool>/` (default `~/.cache/<tool>/`) for cache. gh, stripe, packer, op, and modern git (`~/.config/git/config` alongside `~/.gitconfig`) comply. **Cargo famously does not** (`~/.cargo/`, rust-lang/cargo#1734, still unresolved). Docker uses `~/.docker/` (pre-XDG legacy).

**Project-level manifests** follow the walk-up-parent-directories discovery pattern: `package.json` (npm/pnpm/yarn), `Cargo.toml` (cargo), `pyproject.toml` (modern pip), `deno.json` (deno), `go.mod` (go). TOML has emerged as the dominant format for new CLIs (cargo, pyproject, Rust ecosystem, many Go tools) because it's less finicky than YAML and more readable than JSON.

**Precedence is universal:** flag > env var > project config > user config > system config > built-in default. git documents this explicitly via `git config --list --show-origin --show-scope`.

**Scope semantics — the single most directly relevant precedent for SkillSmith is git.** git defines `--system` → `/etc/gitconfig` (or `C:\ProgramData\Git\config`), `--global` → `~/.gitconfig` or `~/.config/git/config`, `--local` → `.git/config` of current repo. Precedence: local > global > system. npm has `-g`/`--global` (installs to `{prefix}/lib/node_modules` on Unix) vs project-local (`./node_modules/`). pip has `--user` (to `~/.local/lib/pythonX.Y/site-packages`) vs system vs venv. **No other CLI ships a clean three-scope `--system`/`--user`/`--project` triplet with those exact names** — SkillSmith should borrow git's terminology but rename `--global` → `--user` because in a 2026 context "global" is ambiguous (many users think it means system-wide).

### 1.9 Command discovery and suggestions

**Typo correction** is a nice-to-have that users notice. git is famous: `git: 'comit' is not a git command. Did you mean this? commit`, controlled by `help.autocorrect` (integer delay or keywords `never`/`immediate`/`prompt` since Git 2.34). cargo, gh, kubectl all implement "did you mean?" via Levenshtein distance (typically threshold 3). Clap and Cobra both provide this for free.

**Extension/plugin discovery** uses the `<tool>-<name>` on `$PATH` convention: git-foo → `git foo`, cargo-foo → `cargo foo`, kubectl-foo → `kubectl foo`, gh extensions. Kubectl layers Krew on top as a managed plugin manager; gh manages its own via `gh extension install`.

**Shell completion** is table stakes: `<tool> completion bash|zsh|fish|powershell` prints to stdout, user sources it or distribution managers install it.

### 1.10 Design-guideline consensus

The four canonical guides — POSIX, GNU, clig.dev, 12-Factor CLI — agree on a large core:

- short `-x`, long `--kebab-case`, `--` terminates options, `-` = stdin/stdout
- `--help`, `--version`, `-v`/`--verbose`, `-q`/`--quiet`, `-y`/`--yes`, `-f`/`--force`, `--dry-run` universally
- stdout = data; stderr = messages, errors, progress
- exit 0 success, non-zero on error
- precedence: flag > env > config > default
- respect `NO_COLOR` and TTY detection; auto-adapt to pipes
- prompt on TTY, never require a prompt, always allow scripted paths
- XDG Base Directory Spec for config/data/cache
- rich errors with code + message + remediation + URL

They disagree primarily on global flag placement (POSIX: before; GNU: permuted) and on whether multi-digit long options exist at all (not in strict POSIX).

---

## 2. Opinionated design decisions

For each major decision, 2–3 credible options with tradeoffs, then a pick.

### 2.1 Command structure: flat vs hierarchical

| Option | Example | Tradeoffs |
|---|---|---|
| **A. Flat, verb-first** (npm, cargo, brew, pip) | `skillsmith install …`, `skillsmith list`, `skillsmith apply` | Matches package-manager mental model; short commands; minimal nesting. Risk: if surface grows (auth, registry, tool, alias, extension), top level gets cluttered. |
| B. Noun-verb hierarchical (gh, docker-modern) | `skillsmith skill install`, `skillsmith skill list` | More extensible; clean when other resources arrive (`skillsmith tool list`, `skillsmith config set`). Cost: every command gains a word; muscle memory is heavier; feels wrong for a tool with one primary noun. |
| C. Hybrid (docker) | `skillsmith install` AND `skillsmith skill install` | All the cost of B plus the retrofit debt docker carries. Avoid. |

**Recommendation: A, flat verb-first.** SkillSmith has one primary noun ("skill"), which is the exact condition under which every package-manager CLI stays flat. Reserve hierarchy for auxiliary concerns only: `skillsmith config …`, `skillsmith tool …`, `skillsmith completion …`. If the surface later grows beyond ~12 top-level verbs, adopt docker's hybrid model with advance deprecation notices — but do not preemptively pay that cost.

### 2.2 Scope flag naming

| Option | Example | Tradeoffs |
|---|---|---|
| A. git-style `--system`/`--global`/`--local` | `--local` for project | Maximum git precedent; exact file-scope semantics. Cost: "local" is vague outside git; "global" ambiguous (user? system?). |
| **B. `--system`/`--user`/`--project`** (proposed in PRD) | `--user` for user scope | Every word means what it says; no git-religion required; maps cleanly to install paths. No direct CLI precedent but trivially intuitive. |
| C. npm-style boolean `-g`/`--global` + default | Default = project | Simplest but collapses user vs system; doesn't scale to three scopes. |

**Recommendation: B.** The PRD's existing naming is correct; it reads better than git's to new users while preserving the three-scope concept. Also expose `-s`/`-u`/`-p` only for the shortest path (see §2.7 on short flags). Map scopes to paths using the tool's own conventions where possible (e.g., Claude Code's `~/.claude/skills/` for `--user`, `.claude/skills/` in the repo for `--project`).

### 2.3 `--scope` as flag vs positional vs separate subcommand

| Option | Example | Tradeoffs |
|---|---|---|
| A. Boolean scope flags | `skillsmith install --user foo/bar/skill` | Git-style; flag ordering free; composes with other flags. |
| **B. `--scope=<enum>` single flag** | `skillsmith install --scope=user foo/bar/skill` | More extensible (future scopes); single source of truth; `--scope user` and `--scope=user` both work. |
| C. Subcommand per scope | `skillsmith install user foo/bar/skill` | More discoverable in help; awkward with other positionals; not idiomatic. |

**Recommendation: B** with `-s` short alias, `SKILLSMITH_SCOPE` env override, default `project` when a git repo is detected, else `user`. Accept `--user`/`--system`/`--project` as syntactic-sugar booleans per git precedent, since power users will want them. This gives both ergonomics (`skillsmith install --user foo/bar`) and explicitness (`--scope=user`).

### 2.4 Install source reference syntax

| Option | Example | Tradeoffs |
|---|---|---|
| **A. Shorthand-first** | `skillsmith install acme/skills-pack/grep` plus git URLs | Matches gh extensions, brew taps; minimal typing; aligns with GitHub ecosystem. |
| B. Explicit scheme | `skillsmith install gh:acme/skills-pack/grep` | Uambiguous source type; extensible to `jsr:`, `npm:`, `file:` (deno model). More typing; less familiar. |
| C. Flag-only | `skillsmith install --git https://… --name grep` | Maximum explicitness; verbose; fights user expectations. |

**Recommendation: A with B as a future extension.** Parser accepts four forms, in this precedence order:

1. Full Git URL (`https://…`, `git@…`, `ssh://…`) → treat as Git source.
2. Three-part `user/repo/skill-name` → GitHub by default (registry configurable).
3. Two-part `repo/skill` → assume default org (from config).
4. One-part `skill` → assume default registry (future).

Reserve `scheme:spec` syntax (`gh:acme/pack/skill`, `jsr:@acme/pack/skill`, `file:./path`) for Phase 2. This matches deno's pattern precisely and leaves room to grow.

### 2.5 Idempotence and already-installed handling

| Option | Behavior | Precedent |
|---|---|---|
| A. Exit 0 silently on no-op | "installed" even if nothing happened | Aggressive idempotence; hides information. |
| **B. Exit 0 with stderr notice; `--force` reinstalls** | "skill X already installed at Y; use --force to reinstall" | pip, npm, cargo, apt, kubectl apply. |
| C. Exit non-zero on already-installed | User must pre-check | brew's broken model; script-hostile. |

**Recommendation: B.** Exit 0, stderr notice, `--force` to reinstall or overwrite. For `apply` specifically, mirror `kubectl apply` output: print `created`, `updated`, `unchanged`, `skipped` per skill, aggregate counts at end, exit 0 even if all unchanged.

### 2.6 Cross-scope duplicate detection

The PRD requires flagging cross-scope duplicates and requiring `--force` to override. Two sub-decisions:

| Option | Behavior |
|---|---|
| A. `--force` overrides both same-scope and cross-scope | One flag does everything. Less safe. |
| **B. Separate `--force` (overwrite same-scope) and `--override-scope` (cross-scope)** | Explicit about which safety is disabled. |
| C. Require interactive confirmation + `--yes` to cross-scope | Safer but worse for scripting. |

**Recommendation: B simplified to just `--force`.** Keep the flag surface small: `--force` overrides both "already installed in this scope" and "already installed in another scope". Print cross-scope hits to stderr with their scope/path before `--force` is applied, so users see what they're overriding. Adopt option C's behavior in interactive TTY mode: if cross-scope hit and no `--force` and TTY, prompt; if not TTY and no `--force`, exit 2 with a clear error. This matches gh's TTY-aware confirmation model.

### 2.7 Short flag allocation

Short flags are scarce real estate. Only allocate them where typing frequency justifies it.

**Recommendation:**

- `-h` = `--help` (universal)
- `-V` = `--version` (GNU/cargo/git; capital V reserves `-v` for verbose)
- `-v` = `--verbose` (stackable: `-vv` for debug)
- `-q` = `--quiet`
- `-y` = `--yes`
- `-f` = `--force`
- `-s` = `--scope`
- `-t` = `--tool`
- `-p` = `--path`
- No short form for `--from`/`--to`/`--config`/`--no-color`/`--dry-run` — they are used infrequently, and `-f` is already taken for `--force`. `--dry-run` alone without `-n` is acceptable (kubectl/npm precedent).

### 2.8 Global flag placement

| Option | Example |
|---|---|
| A. Require before subcommand (git, docker) | `skillsmith --verbose install foo` only |
| **B. Allow anywhere (cargo, kubectl, gh)** | Both `skillsmith --verbose install foo` and `skillsmith install foo --verbose` |

**Recommendation: B.** Use Cobra (Go) or clap (Rust) — both give this for free. Document canonical form as post-subcommand in examples, but accept either. In help output, separate **FLAGS** (local) from **INHERITED FLAGS** (global), mirroring gh exactly.

### 2.9 Output format

| Option | Example |
|---|---|
| A. `--json` boolean + `--jq` filter | gh model |
| B. `--output json|yaml|table|text` | aws/kubectl model |
| **C. `--json` boolean for MVP; add `--output` later if needed** | Minimal surface, extensible |

**Recommendation: C.** For MVP, `--json` on `list` (most common machine-output case) and `apply`. Add `--output yaml` later only if customer demand materializes. Always follow clig.dev: stdout = data, stderr = messages.

### 2.10 Help routing

Accept all of `skillsmith`, `skillsmith help`, `skillsmith --help`, `skillsmith -h`, `skillsmith <cmd> --help`, `skillsmith <cmd> -h`, `skillsmith help <cmd>`. Treat `-h` and `--help` as equivalent (gh/cargo model, not git's abbreviated-vs-full split). Ship `skillsmith help <topic>` for cross-cutting docs: `skillsmith help exit-codes`, `skillsmith help environment`, `skillsmith help scopes`, `skillsmith help manifest`, `skillsmith help sources`.

---

## 3. Concrete command tree for MVP

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

### 3.1 Argument order

For `install`:

```
skillsmith install [FLAGS] <source> [<source>...]
```

Flags before or after positionals are both accepted (Cobra/clap permute). Multiple sources install all of them atomically (fail fast on first error unless `--continue-on-error`).

For `sync`:

```
skillsmith sync [FLAGS] [<skill>...]
```

`--from` and `--to` are flag-only because their semantics ("sync FROM project A TO project B", or "sync FROM user scope TO project scope") are positional-ambiguous; yarn/gh avoid this class of ambiguity with flags.

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

---

## 4. Flag tables

### 4.1 Global (inherited) flags

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

### 4.2 `install` flags

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
| `--continue-on-error` | — | bool | false | — | Keep going after per-skill failures |

### 4.3 `sync` flags

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

### 4.4 `list` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all | `SKILLSMITH_TOOL` | Filter by tool |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Filter by scope |
| `--duplicates` | — | bool | false | — | Show only cross-scope duplicates |
| `--json` | — | bool | false | — | JSON output |
| `--long` | `-l` | bool | false | — | Show paths, sources, commit SHAs (gh `--detailed`-style) |

### 4.5 `apply` flags

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--file` | — | path/repeatable | `./skillsmith.toml` | — | Manifest path(s); repeatable (kubectl `-f`) |
| `--tool` | `-t` | enum/repeatable | from manifest | `SKILLSMITH_TOOL` | Override tool targets |
| `--scope` | `-s` | enum | from manifest | `SKILLSMITH_SCOPE` | Override scope |
| `--force` | `-f` | bool | false | — | Reinstall all |
| `--yes` | `-y` | bool | false | — | Skip prompts |
| `--dry-run` | — | bool | false | — | Preview reconciliation plan |
| `--prune` | — | bool | false | — | Remove installed skills absent from manifest |

---

## 5. Help and error output mockups

### 5.1 `skillsmith --help` / `skillsmith help`

```
SkillSmith installs and manages agent skills for AI coding tools.

USAGE
  skillsmith <command> [flags]

CORE COMMANDS
  install:       Install a skill from a GitHub ref or Git URL
  sync:          Reconcile skills between scopes or projects
  list:          List installed skills across scopes and tools
  apply:         Install skills declared in skillsmith.toml

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

### 5.2 `skillsmith install --help` / `skillsmith help install`

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

### 5.3 Error and prompt mockups

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

---

## 6. Naming convention cheat sheet

**Commands.** Use verbs for actions (`install`, `sync`, `list`, `apply`). Use nouns only as subgroups when the command surface gains a second primary resource type. Single word when possible. Hyphenated multi-word kebab-case when necessary (`set-default`, never `setDefault` or `set_default`). No plurals for verb commands; plurals only on resource noun groups if we add them (`skills`, not `skill`, in group names — following gcloud/stripe plural convention).

**Aliases.** Ship these built-in aliases and no more: `ls` → `list`, `rm` → `uninstall` (when added in Phase 2), `i` → `install`. No abbreviations for `sync` or `apply` — they are already short and clear. Users can define their own via `skillsmith config alias.<name>`.

**Flags.** Long form is `--kebab-case`. Short form is a single letter, allocated sparingly (see §2.7). Boolean flags are presence-only; provide `--no-<flag>` counterparts only for flags that default to true. Enum flags (`--scope`, `--tool`, `--color`) use lowercase-kebab values. Accept both `--flag value` and `--flag=value`. Repeatable flags accumulate (repeat the flag; do not use comma-separation in MVP).

**Env vars.** `SKILLSMITH_<NAME>` in SCREAMING_SNAKE_CASE. Honor cross-tool standards verbatim: `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `TERM`, `PAGER`, `EDITOR`, `VISUAL`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CI`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`.

**Config keys.** `kebab-case` in TOML (`default-tool`, `default-scope`), dotted paths for nested (`registry.default`, `tool.claude-code.path`). Match env var name by uppercasing and replacing dots/dashes with underscores (`SKILLSMITH_DEFAULT_TOOL`, `SKILLSMITH_REGISTRY_DEFAULT`).

**Paths and files.** `skillsmith.toml` for project manifest (cargo precedent). `~/.config/skillsmith/config.toml` for user config (XDG). `~/.local/share/skillsmith/` for installed artifacts at user scope. `~/.cache/skillsmith/` for Git clones and download cache. Never use `~/.skillsmith/` — XDG compliance from day one (avoid cargo's mistake).

**Source refs.** Three-part `<owner>/<repo>/<skill>` is canonical shorthand. Two-part and one-part forms fall back to defaults from config. Git URLs accepted verbatim. Scheme-prefixed form (`gh:`, `file:`, `jsr:`) reserved for Phase 2.

---

## 7. Exit codes, output formats, environment variables

### 7.1 Exit codes

Document these in `skillsmith help exit-codes` (gh's model):

| Code | Meaning |
|---|---|
| 0 | Success (including idempotent no-op) |
| 1 | Generic failure (install error, network error, parse error) |
| 2 | Usage error, cancelled action, or refused destructive action without `--force`/`--yes` |
| 3 | Config error (malformed `skillsmith.toml` or user config) |
| 4 | Target tool not installed |
| 5 | Source unresolvable (repo not found, skill not in repo, ref not found) |
| 6 | Scope/permission error (cannot write to system scope without privileges) |
| 130 | Cancelled via SIGINT (Ctrl-C) — standard Unix signal-exit |

Partial failures in batch operations (`install` with multiple sources, `apply` with many entries) exit with the **highest** code from any failure, unless `--continue-on-error` was set, in which case exit with code 1 if any failed.

### 7.2 Output format

`--json` is the sole machine-output flag in MVP. When set, stdout is a single JSON value (object or array); human-oriented progress/status goes to stderr. Without `--json`, stdout receives a human-readable table or narrative; stderr receives warnings and errors. Always auto-detect TTY: disable colors, progress bars, and spinners when stdout is not a TTY. Respect `NO_COLOR` unconditionally (no-color.org standard). Honor `FORCE_COLOR` and `CLICOLOR_FORCE` to re-enable. Honor `TERM=dumb`. Add `--output yaml|table|text` in Phase 2 only if demand emerges.

### 7.3 Environment variables

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

### 7.4 Config file locations (XDG-compliant)

- User config: `$XDG_CONFIG_HOME/skillsmith/config.toml`, fallback `~/.config/skillsmith/config.toml`
- User data (installed skills at user scope): `$XDG_DATA_HOME/skillsmith/`, fallback `~/.local/share/skillsmith/`
- Cache (Git clones, downloads): `$XDG_CACHE_HOME/skillsmith/`, fallback `~/.cache/skillsmith/`
- System config: `/etc/skillsmith/config.toml`
- Project manifest: `./skillsmith.toml` (discovered by walking up from CWD, cargo/npm pattern)
- Windows: `%APPDATA%\SkillSmith\`, `%LOCALAPPDATA%\SkillSmith\` per Microsoft guidance

The tool-and-scope install path is not a SkillSmith config location but a **tool-specific** path SkillSmith writes into — e.g., `./.claude/skills/` for Claude Code at project scope, `~/.claude/skills/` at user scope, `/usr/local/share/claude/skills/` at system scope. These are derived at runtime from the target tool's own conventions and overridable by `--path`.

---

## 8. Help and documentation strategy

**Inline help is the primary surface.** Ship rich Cobra/clap help with per-command EXAMPLES sections and a top-level HELP TOPICS list. gh's `gh help <topic>` is the model: a small set of dedicated topic pages (`exit-codes`, `environment`, `scopes`, `manifest`, `sources`, `formatting`) that cover cross-cutting concerns without bloating per-command help. This is a measurable improvement over kubectl's approach of dumping 22 lines of global flags on every subcommand page.

**Man pages** can be auto-generated from the Cobra/clap command tree (both frameworks support this via a subcommand or build-time generator). Ship them with the binary and install them via Homebrew, apt, and other distribution packages. Low cost, high credibility with Unix users. Defer to Phase 2 if time-boxed for MVP; inline help covers 95% of use cases.

**Shell completion.** Ship `skillsmith completion <bash|zsh|fish|powershell>` that prints a completion script to stdout. Completions should include subcommands, flag names, and enum values (`--scope` values, `--tool` values). Dynamic completions for skill names and source refs are deferred to Phase 2 (they require network calls that slow shells).

**Website documentation** lives at `https://skillsmith.dev/docs` (placeholder). Structure:

1. Quickstart (install, first skill, first manifest)
2. Concepts (scopes, tools, sources, manifest)
3. Command reference (auto-generated from CLI help, one page per command)
4. Recipes (common workflows: monorepo, team defaults, CI)
5. Reference (exit codes, env vars, config schema, manifest schema)

Every `--help` page ends with `Read the manual at https://skillsmith.dev/docs` (gh's "LEARN MORE" pattern). Every error message that refers to a concept links to the relevant docs page (clig.dev: errors should include a URL for remediation).

**Typo correction** ("did you mean?") via clap's built-in suggestions or Cobra's `SuggestFor`. Levenshtein threshold 2. Ship enabled by default; controllable via `skillsmith config set help.autocorrect <never|prompt|immediate>` (git's exact model, since Git 2.34).

---

## Conclusion: three things that matter most

First, **stay flat.** SkillSmith manages one primary object. Every survey data point from npm, cargo, brew, pip, and deno says flat is correct here; docker's retrofit is the cautionary tale. The productivity cost of noun-verb hierarchy is paid on every invocation; the benefit only materializes when a second primary noun appears.

Second, **copy gh's help output and help-topic model verbatim.** It is the best-in-class reference point for Cobra/clap-based CLIs in 2026, and the separation of FLAGS from INHERITED FLAGS solves a problem kubectl has been fighting for years. `skillsmith help exit-codes` and `skillsmith help scopes` make the tool feel substantially more professional than flag lists alone.

Third, **be idempotent and be explicit about it.** Exit 0 when already installed (apt/pip/npm/kubectl consensus, not brew's broken exception). Print `created`/`updated`/`unchanged`/`skipped` per item in `apply`. Separate `--force` (override safety) from `--yes` (skip prompts) — gh and stripe get this right, npm and brew conflate it. This is what makes SkillSmith trustworthy inside CI pipelines, which is where a skills-management tool will actually earn its keep.

Everything else in this proposal is filling in defaults from the surveyed precedents. The three choices above are the ones that, if wrong, will visibly degrade the product; the rest is craft.