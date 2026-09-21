# Skillsmith

Skillsmith is a command-line tool for discovering, installing, updating, and verifying agent
skills across AI coding tools. A skill is a directory containing `SKILL.md`, which describes
when and how an agent should perform a task, plus any supporting scripts or reference files.

Use Skillsmith to inspect skills already on your machine, install shared skills from Git
repositories, develop skills from local checkouts, and reproduce a collection from recorded
installation declarations and revisions.

Skillsmith detects Claude Code, Codex, Kilo Code, opencode, and Muse. Management and
verification support depend on the target tool and installation scope; see
[Supported tools](#supported-tools) and the [capability matrix](#capability-and-version-matrix).

> P17 disposition: current behavior; authority: packages/cli/src/program.ts

The status notes in this README refer to P17, the Skillsmith ergonomics and declarative
workflow project listed in the [project tracker](PROJECTS.md). They identify the sources used
to check the documented behavior.

**Today:** `search`, `find`, `agents`, `config`, `list`, `ls`, `commands`, `cross-tool-names`, `doctor`, `check`, `verify`, `status`, `plan`, `apply`, `sync`, `update`, `undo`, `promote`, `dev`, `demote`, `install`, `i`, `uninstall`, `rm`, `remove`, `export`, `gc`, `init`, `version`, `completion`, and `help` are implemented.
**P17 target:** consistent behavior across the retained command surface, with generated public help and command documentation.
**Contents**

- [Install](#install) and [Quickstart](#quickstart)
- [Supported tools](#supported-tools) and [Capability and version matrix](#capability-and-version-matrix)
- [Defaults, concepts, and files](#defaults-concepts-and-files)
- [Skill lifecycle workflows](#skill-lifecycle-workflows)
- [Command orientation](#command-orientation) and [Command examples](#command-examples)
- [Example output](#example-output) and [Verification and troubleshooting](#verification-and-troubleshooting)
- [Upgrade](#upgrade) and [Potential lifecycle additions](#potential-lifecycle-additions)
- [Packages](#packages), [Architecture snapshot](#architecture-snapshot), and [Contributing](#contributing)
- [Project tracker](#project-tracker) and [License](#license)

## Install

> P17 disposition: current source-build behavior; authority: package.json

The source checkout is the currently available installation method. It requires
[Bun](https://bun.sh) ≥ 1.3.14 and Git on your `PATH`, the directories your shell searches
for executables. Install the coding tools you want to manage separately.

| Distribution | Availability |
|---|---|
| Source checkout | Available |
| Homebrew (`smorinlabs/tap/skillsmith`) | Candidate validated locally; not yet published |
| npm/Bun global (`@smorinlabs/skillsmith`) | Candidate validated locally; not yet published |
| native release assets | Candidate validated locally; not yet published |

```sh
git clone https://github.com/smorinlabs/skillsmith.git
cd skillsmith
bun install --frozen-lockfile
bun run dev agents         # fastest way to try it — no build step
```

To produce a standalone binary:

```sh
bun run build              # compiles for the current host; package.json also has explicit targets
./dist/skillsmith --help
```

The native build command supports macOS and Linux on ARM64 and x64. To use the binary from
another project's directory, add it to `PATH` for this terminal. Run this from the Skillsmith
checkout root after building:

```sh
export PATH="$PWD/dist:$PATH"
skillsmith version
```

This does not edit your shell startup files. You can also invoke the absolute path to
`dist/skillsmith` in this checkout. Subsequent examples use `skillsmith` for that executable;
`bun run dev` remains available when running from the Skillsmith checkout.

## Quickstart

> P17 disposition: current examples; authority: packages/cli/src/program.ts

### Inspect your current setup

From the Skillsmith checkout root, after completing [Install](#install), run:

```sh
bun run dev version
bun run dev agents --detected-only
bun run dev list
```

These commands report the Skillsmith version, detected coding tools, and installed skills.
They do not install skills. An empty inventory means Skillsmith found no skills within the
selected tools and scopes.

### Add one shared skill

Build the binary and make `skillsmith` available as described in [Install](#install).
Then change to the destination project's Git root. This example requires Codex on `PATH`.
Replace `owner/repo` with the skill's GitHub repository and `skills/review` with the directory
containing its `SKILL.md`:

```sh
skillsmith install owner/repo//skills/review --tool codex --project --dry-run
```

Review the reported source and destination. To install that selection, run the command without
`--dry-run`, then inspect the result:

```sh
skillsmith install owner/repo//skills/review --tool codex --project
skillsmith list review --tool codex --project --long
skillsmith status review --tool codex --project
```

Here `review` is the installed skill name; use the name reported by your installation if it
differs. `--project` selects this project, while `--user` selects installation across your
projects. The installation saves declarations and resolved revisions by default. See
[Defaults, concepts, and files](#defaults-concepts-and-files) for the files it manages.

## Supported tools

| Tool ID        | Probed binary | Detection today                                   |
|----------------|---------------|---------------------------------------------------|
| `claude-code`  | `claude`      | PATH lookup → `--version` → classify install path |
| `codex`        | `codex`       | PATH lookup → `--version` → classify install path |
| `kilo-code`    | `kilo`        | PATH lookup → `--version` → classify install path |
| `opencode`     | `opencode`    | PATH lookup → `--version` → classify install path |
| `muse`         | `muse`        | PATH lookup → `--version` → classify install path |

The install-method classifier recognizes `brew`, `npm-global`, `bun-global`, `native-installer`,
and `app-bundle`, and falls back to `unknown`. Each tool owns a separate directory under
[`packages/core/src/agents/`](packages/core/src/agents/) so any one can diverge from the shared
detection pipeline without touching the others.

Detection, inventory, `doctor`, and `check` support Claude Code, Codex, Kilo Code, opencode,
and Muse. `verify` supports Claude Code, Codex, and Muse. Write and mutation commands support
Claude Code and Codex, plus Muse in the user and custom scopes; Kilo Code and opencode are read-only/detection today.

Missing a tool? Open an issue with a `skillsmith agents --format json` dump and the OS / install method you used.

### What it runs on your system

`agents` is read-only. Skillsmith discovers executable paths for each supported tool on your
`PATH` and probes them with `--version`. It can report multiple installations of the same tool.
It executes no other commands from those tools and writes no files itself.

Skillsmith's own configuration, when you use `config set`, lives at
`$XDG_CONFIG_HOME/skillsmith/config.toml` for user scope or `./skillsmith.toml` for project scope.
See [Defaults, concepts, and files](#defaults-concepts-and-files) for fallback paths and overrides.

<!-- skillsmith-capability-matrix:start -->
## Capability and version matrix

Generated from the live tool registry for Skillsmith 0.8.0. A scope list means the operation is supported in those scopes; “yes” means the operation is supported without a scope; “—” means it is not supported.

| Tool | Capability contract | Verifier baseline |
|---|---|---|
| `claude-code` | capability v1 | 2.1.202 |
| `codex` | capability v1 | 0.142.5 |
| `kilo-code` | capability v1 | not applicable |
| `opencode` | capability v1 | not applicable |
| `muse` | capability v2 | 1.3.0 |

| Operation | `claude-code` | `codex` | `kilo-code` | `opencode` | `muse` |
|---|---|---|---|---|---|
| `detect` | yes | yes | yes | yes | yes |
| `inventory-skills` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `inventory-commands` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `diagnostics` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `install` | user, project, custom | user, project, custom | — | — | user, custom |
| `uninstall` | user, project, custom | user, project, custom | — | — | user, custom |
| `dev` | user, project, custom | user, project, custom | — | — | user, custom |
| `promote` | user, project, custom | user, project, custom | — | — | user, custom |
| `undo` | user, project, custom | user, project, custom | — | — | user, custom |
| `verify-static` | artifact | artifact | — | — | artifact |
| `verify-deep` | artifact | artifact | — | — | artifact |
| `plan` | user, project, custom | user, project, custom | — | — | user, custom |
| `apply` | user, project, custom | user, project, custom | — | — | user, custom |
| `sync` | user, project, custom | user, project, custom | — | — | user, custom |
| `update` | user, project, custom | user, project, custom | — | — | user, custom |
| `adapt` | — | — | — | — | — |
<!-- skillsmith-capability-matrix:end -->

## Defaults, concepts, and files

Skillsmith separates what you want installed from what is currently on disk:

| Term | Meaning |
| --- | --- |
| Desired state | The skills, sources, target tools, and scopes declared in a manifest. |
| Locked state | The exact resolved revisions recorded in the matching lockfile. |
| Placement | The installed directory or link that a coding tool reads. |
| Ledger | Skillsmith's local record of placements and retained operations. |
| Live state | The skills and files currently present in the target tools' directories. |
| Store | Local skill snapshots used by managed installations. |
| Drift | A difference between live state and the selected recorded state. |

### Default installation choices

Explicit flags make the destination clear. Without a configured or explicit selection:

- `install` uses project scope when it finds a project root, otherwise user scope.
- It targets detected tools that support installation in the selected scope. Use repeatable
  `--tool` flags to select tools explicitly.
- Installation saves the declaration and resolved revision to the selected manifest and
  lockfile. `--no-save` changes the live installation without changing those files.
- Managed installations link to snapshots in the local store. `--direct` places physical
  copies instead. `dev --source <path>` links a local development directory so edits are live.

User scope applies across your projects; project scope applies to the selected project.
A custom placement uses `--path <dir>` with one source and one effective tool. The
[capability matrix](#capability-and-version-matrix) lists which tools support each scope.
`config list` shows active defaults and where they came from. Explicit command flags take
precedence over configuration defaults.

### Which files to share

The paths below show the defaults without environment or path overrides. `<project>` means
the selected project root, normally the Git root.

| File or directory | Default location | Purpose and sharing |
| --- | --- | --- |
| Project manifest | `<project>/skillsmith.toml` | Declares skills and project defaults. Share it with teammates. |
| Project lockfile | `<project>/skillsmith.lock` | Records exact resolved revisions. Share it with its matching manifest. |
| User manifest and lockfile | `~/.config/skillsmith/skillsmith.toml` and `skillsmith.lock` in the same directory | Describe a personal collection. Export or share the pair when its sources are portable. |
| User configuration | `~/.config/skillsmith/config.toml` | Holds user defaults; separate from installation declarations. |
| Placement ledger | `~/.local/share/skillsmith/placements.json` | Records this machine's placements and history. Keep it local. |
| Store | `~/.local/share/skillsmith/store/` | Holds local skill snapshots. Recipients acquire their own contents from the declared sources. |
| Coordination and recovery state | `~/.skillsmith/coordination/artifacts-v1/` in the operating-system account's home directory | Coordinates file changes and interrupted operations. Keep it local. |

`XDG_CONFIG_HOME` changes the configuration base directory; it defaults to `~/.config`.
`XDG_DATA_HOME` changes the data base directory; it defaults to `~/.local/share`.
`SKILLSMITH_HOME` overrides Skillsmith's data directory, including its store and ledger.
Coordination and recovery state uses the account's home directory independently of `HOME`,
XDG variables, and `SKILLSMITH_HOME`.
Use `--file` to select an explicit manifest and `--lockfile` with `--file` to select its lockfile.
Use `--config` to select an explicit configuration file.

The default writable skill directories are:

| Tool | User placement directory | Project placement directory |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `<project>/.claude/skills/` |
| Codex | `~/.agents/skills/` | `<project>/.agents/skills/` |
| Muse | `~/.config/muse/skills/` | Project writes are not supported. |

Tool-specific configuration can change these paths. Muse's user directory follows
`XDG_CONFIG_HOME`. Codex's legacy `~/.codex/skills/` directory remains visible to inventory;
new standard user placements use `~/.agents/skills/`. Use `list --long` to inspect actual paths.

### Source syntax

Replace `owner/repo`, `review`, and `path/to/skill` with the repository and skill you want:

| Form | Meaning |
| --- | --- |
| `owner/repo` | A GitHub repository; a repository with multiple skills may require selection. |
| `owner/repo/review` | Select the skill named `review` within the repository. |
| `owner/repo//path/to/skill` | Select an exact directory containing `SKILL.md`. |
| `owner/repo//path/to/skill@v1.0.0` | Select that directory at a tag, branch, or full commit SHA. |
| `<host>/owner/repo` or a Git URL | Use another Git host, HTTPS, SSH, or SCP-style Git access. |

Local directories use `dev --source <path>`. Private sources require working Git access.
`--pin` freezes the resolved commit; an explicit `update --ref <git-ref>` selects a different
revision later. Run `skillsmith help source` for the full grammar.

## Skill lifecycle workflows

The CLI groups commands by lifecycle area. The recommended names below are documentation
proposals; the current group names are the headings printed by `skillsmith --help`.
Commands in this section are available today unless explicitly marked **Proposed**.

| Current group | Recommended name | Existing commands |
| --- | --- | --- |
| DISCOVER | Discover and inspect | `search`, `agents`, `list`, `commands`, `cross-tool-names`, `status` |
| MANAGE | Install, update, and remove | `install`, `update`, `uninstall`, `undo` |
| DEVELOP | Develop and verify | `dev`, `verify`, `promote` |
| DECLARATIVE | Reproduce and synchronize | `init`, `export`, `plan`, `apply`, `sync` |
| MAINTAIN | Configure and troubleshoot | `doctor`, `check`, `gc`, `config`, `completion`, `version`, `help` |

Aliases such as `find`, `ls`, and `demote` are alternate spellings of existing commands.
See the [command reference](docs/commands.md) for all aliases and options.

### Workflows by group

These scenarios combine commands into complete workflows. A manifest, `skillsmith.toml`,
declares which skills to install. Its lockfile, `skillsmith.lock`, records exact resolved
revisions. Drift means installed state differs from the selected recorded state.

| Group | Scenario | Workflow |
| --- | --- | --- |
| DISCOVER | Understand a new machine | Detect tools with `agents`, inspect skills with `list --long`, and inventory slash commands with `commands`. |
| DISCOVER | Find a skill or investigate a conflict | Inspect remote repositories and catalogs before installation. For installed skills, inspect names with `cross-tool-names`, same-tool conflicts with `list --duplicates`, and recorded versus live state with `status`. |
| MANAGE | Adopt a shared skill | Preview `install --dry-run` with the selected source, tools, and scope. Install it, then inspect its placement with `list --long`. |
| MANAGE | Update or remove an installation | Use `update --check`, preview a selected update with `update --dry-run`, then apply it. Use `uninstall` for removal or preview `undo --dry-run` for an eligible retained operation. |
| DEVELOP | Iterate on a local skill | Connect a checkout with `dev --source`, edit its files, run `verify`, and test representative tasks in the target agent. |
| DEVELOP | Keep a stable local snapshot | Commit the source changes, then use `promote` to snapshot a development installation. Use `dev` to return to its recorded development source. |
| DECLARATIVE | Reproduce a team setup | Create a manifest with `init` and populate it through saved installations, or capture portable installations with `export`. Share the manifest and lockfile, review `plan --locked`, then run `apply --locked`. |
| DECLARATIVE | Synchronize local environments | Select source and destination scopes or projects with `sync --from ... --to ...`. Preview with `--dry-run`; use `--save` when the destination manifest and lockfile should also change. |
| MAINTAIN | Configure a new environment | Inspect defaults with `config list`, change them with `config set`, and emit shell completion with `completion`. Use `version` and `help` when diagnosing setup differences. |
| MAINTAIN | Diagnose and clean up | Run `doctor`, preview supported repairs with `doctor --fix --dry-run`, and use `check` for blocking health checks in automation. Preview unused store cleanup with `gc --dry-run`. |

`undo` covers eligible retained `dev`, `promote`, `install`, and `uninstall` operations.
To select an earlier published revision, use `update --ref <git-ref>` with that revision.
Pinned declarations also need an explicit `--ref` when selecting a newer release.

### Ways to install and share skills

Choose the source, target tool, installation scope, revision policy, and file placement
independently. User scope applies across projects; project scope applies to one project.
Write workflows support Claude Code and Codex in user, project, and custom scopes.
Muse supports writes in user and custom scopes. Verification supports Claude Code, Codex,
and Muse. Kilo Code and opencode support detection, inventory, and diagnostics.
See the [capability matrix](#capability-and-version-matrix) for the complete operation list.

| Scenario | Mode or command | What to expect |
| --- | --- | --- |
| Use a skill across personal projects | `install --user` | Install into user scope for the selected tool. |
| Give one project its own skills | `install --project` | Install into project scope and save declarations by default. |
| Target Claude Code and Codex | `--tool claude-code --tool codex` | Select both tools explicitly on commands with repeatable `--tool`. |
| Edit a local checkout live | `dev --source <path>` | Connect the installation to the source directory so edits affect development use. |
| Track a branch | `install <source>@<branch>` followed by `update` | Record branch intent; updates explicitly select newer resolved revisions. |
| Keep an exact revision | `install <source>@<ref> --pin` | Freeze the resolved commit. Use an explicit `update --ref` to select another revision. |
| Use physical copies | `install --direct` | Copy files into the destination instead of linking from the local store. |
| Share public or private Git sources | `install <git-source>` | Use repository shorthand or an HTTPS/SSH Git URL. Recipients need access to the repository and revision. |
| Reproduce a team collection | Share `skillsmith.toml` and `skillsmith.lock`, then use `plan --locked` and `apply --locked` | Recreate exact declared revisions while their sources remain accessible. `export --strict` can reject nonportable entries before sharing. |
| Copy a selection between local environments | `sync --from <scope-or-path> --to <scope-or-path>` | Reconcile the selected skills into one destination; preview first with `--dry-run`. |
| Install without saving declarations | `install --no-save` | Change the installation without changing the manifest or lockfile. The installation persists. |
| Try a skill without installing it | **Proposed** | No dedicated temporary-use command exists today. |
| Share an offline archive | **Proposed** | Requires packaging and archive installation support; `export` does not include skill files. |

`install` examples require a repository shorthand or Git URL. `<path>` in `dev --source` is a
local skill directory; `<ref>` is a tag, branch, or full commit SHA. Run `skillsmith help source`
for exact source syntax.

### Walkthrough: create, edit, verify, and publish

This example creates a skill named `review` for Codex, then shares a tagged version through Git.
Run author commands from the root of an existing skill-source Git repository with a configured
`origin` remote. Codex must be installed. `skillsmith` means the executable on your `PATH`, or
the absolute path to the binary built in [Install](#install).

#### 1. Create the source

Create `skills/review/SKILL.md` with an editor or skill authoring tool:

```markdown
---
name: review
description: Review code changes for correctness and regressions. Use when a code review is requested.
---

# Review

Inspect the diff and relevant code. Report actionable findings with file paths,
explain their impact, and identify any behavior you could not verify.
```

Add supporting scripts or reference files inside `skills/review/` as needed.
Skill scaffolding is currently an external step; `skillsmith init` creates installation configuration.

#### 2. Connect the checkout and edit

From the skill-source repository root, create the development installation:

```sh
skillsmith dev review --source ./skills/review --tool codex --project
```

Edit `skills/review/SKILL.md` and its supporting files. The development installation links
to that source directory. Open a fresh Codex session in this repository when checking discovery.

#### 3. Verify compatibility

From the same repository root, check the artifact and then its native loading:

```sh
skillsmith verify ./skills/review --tool codex --static --strict
skillsmith verify ./skills/review --tool codex --deep --strict
```

Require successful verification before continuing. These commands check compatibility;
they do not evaluate the quality of a model's work.

#### 4. Test behavior and revise

In a fresh Codex session in the repository, request a review of a representative change.
Check whether the findings are correct and useful. Try an unrelated request to check unwanted
activation, and compare results against the prior skill version when making an update.
Revise the source and repeat verification and behavioral checks until the results are acceptable.

#### 5. Publish a Git revision

From the skill-source repository root, commit the source files:

```sh
git add skills/review
git commit -m "feat: add review skill"
```

Complete the repository's review process. With the approved release commit checked out on
the intended release branch, publish it under an unused tag:

```sh
git tag v1.0.0
git push origin HEAD
git push origin v1.0.0
```

`v1.0.0` is the example skill release tag. Use a different unused tag when needed.
Git performs publication today. `promote` is an optional local snapshot step, and
`skillsmith version` reports the Skillsmith CLI version.

#### 6. Install the published skill

From a recipient project's root, replace `owner/repo` with the GitHub repository published
in the previous step. Use the actual release tag if it differs from `v1.0.0`:

```sh
skillsmith install owner/repo//skills/review@v1.0.0 --tool codex --project --pin
skillsmith list review --tool codex --project --long
skillsmith status review --tool codex --project
```

The recipient now has the published revision pinned in project scope. For a private repository,
the recipient also needs working Git access to that source.

#### 7. Deliver the next revision

Repeat editing, verification, behavioral testing, and publication with a new tag.
After `v1.0.1` is published, the recipient can preview and apply the explicit change
from the recipient project's root:

```sh
skillsmith update review --ref v1.0.1 --pin --dry-run
skillsmith update review --ref v1.0.1 --pin
```

Review the preview before applying it. The explicit `--ref` is required because this
walkthrough pinned the original installation.

### Walkthrough: reproduce a team setup

This example records a project collection and recreates it in a teammate's checkout. Both
people need Skillsmith, Codex, and Git access to the declared sources. Start from the destination
project's Git root, with no existing Skillsmith manifest. If the project already has a manifest,
inspect it before adding another installation.

Create project defaults, then preview one installation. Replace `owner/repo`, `skills/review`,
and `v1.0.0` with the repository, skill directory, and existing release tag you want to share:

```sh
skillsmith init --tool codex --project
skillsmith install owner/repo//skills/review@v1.0.0 --tool codex --project --pin --dry-run
```

After reviewing the preview, install that revision. Repeat the install step for other skills
in the collection, then check the recorded setup:

```sh
skillsmith install owner/repo//skills/review@v1.0.0 --tool codex --project --pin
skillsmith plan --locked --project
```

Inspect `skillsmith.toml` and `skillsmith.lock` in the project root. The manifest declares the
collection; the lockfile records the exact resolved revisions. Commit the pair through the
project's normal review process:

```sh
git add skillsmith.toml skillsmith.lock
git commit -m "chore: record project skills"
```

After receiving that commit, a teammate runs the following from their checkout's Git root:

```sh
skillsmith plan --locked --project
```

Review the planned placements, then apply and inspect them:

```sh
skillsmith apply --locked --project
skillsmith list --tool codex --project --long
skillsmith status --tool codex --project
```

Interactive `apply` requests approval when changes are needed. The locked workflow requires
a complete, current manifest/lockfile pair and access to its source revisions. The final reports
show installed placements and any remaining drift. To capture an existing collection instead,
use `export`; `export --strict` rejects nonportable entries. Export records declarations and
revisions, so recipients still need access to the sources for skill files.

### Save and execute an exact plan

From a project with a manifest and lockfile, create a saved plan and inspect the displayed
operations. `review.plan` is the local file created by this command:

```sh
skillsmith plan --out review.plan
skillsmith apply --plan review.plan --dry-run
```

Once you approve those exact operations, execute the saved plan:

```sh
skillsmith apply --plan review.plan
```

Saved-plan execution uses the reviewed plan's prior authorization and does not prompt again.
It validates that the relevant state still matches instead of selecting new work. If the plan
is stale, create and review a new plan before executing it.

<!-- skillsmith-command-index:start -->
## Command orientation

Choose a command by the question you need answered. This table and the full [command reference](docs/commands.md) are generated from the live CLI registry.

| Group | Command | Primary question |
|---|---|---|
| DISCOVER | `search` | Which remote skills match a topic? |
|  | `agents` | Which coding tools are detected and what can Skillsmith do with them? |
|  | `list` | Which skills are installed? |
|  | `commands` | Which slash commands are installed? |
|  | `cross-tool-names` | Which skill names repeat across tools? |
|  | `status` | How do desired, locked, ledger, and live states relate? |
| MANAGE | `install` | How do I acquire and persist a remote skill? |
|  | `uninstall` | How do I remove a skill and its desired-state declaration? |
|  | `update` | How do I check or apply source revision changes? |
|  | `undo` | How do I abort or reverse a selected retained operation? |
| DEVELOP | `dev` | How do I use a local checkout as the live development source? |
|  | `verify` | Is this skill or plugin valid for the selected tools? |
|  | `promote` | How do I snapshot a development placement into managed state? |
| DECLARATIVE | `init` | How do I create or migrate the desired-state file? |
|  | `export` | How do I capture the current fleet as portable desired state? |
|  | `plan` | What would convergence change? |
|  | `apply` | How do I execute the reviewed convergence plan? |
|  | `sync` | How do I reconcile one live location into another? |
| MAINTAIN | `doctor` | What is unhealthy and what deterministic repair is available? |
|  | `check` | Are blocking machine/project health checks passing? |
|  | `gc` | Which unreachable local store objects can be reclaimed? |
|  | `config` | What defaults are active and how do I change them? |
|  | `completion` | How do I emit completion for a shell? |
|  | `version` | Which Skillsmith version is running? |
|  | `help` | How do I learn a command, topic, or workflow? |
<!-- skillsmith-command-index:end -->

**Today:** `search`, `find`, `agents`, `config`, `list`, `ls`, `commands`, `cross-tool-names`, `doctor`, `check`, `verify`, `status`, `plan`, `apply`, `sync`, `update`, `undo`, `promote`, `dev`, `demote`, `install`, `i`, `uninstall`, `rm`, `remove`, `export`, `gc`, `init`, `version`, `completion`, and `help` are implemented.

## Command examples

These are independent examples grouped by task. Use `skillsmith <command> --help` for each
command's prerequisites and options, or browse the [command reference](docs/commands.md).

### Inspect tools, skills, and configuration

```sh
skillsmith agents                       # human-readable markdown
skillsmith agents --format json         # machine-readable; see Example output
skillsmith agents --detected-only       # skip the "Not detected" section
skillsmith agents --tool claude-code    # scan one tool only (repeatable)
skillsmith list                         # inspect installed skills
skillsmith search react native          # search the remote skills.sh catalog
skillsmith find react --owner vercel-labs --json # alias, owner filter, machine output
skillsmith config list                  # show effective configuration and source layers
skillsmith check --report-only          # report CI checks without failing on findings
```

`check` fails on error findings by default; use `--report-only` when only the report should be
produced. The inherited `-C <dir>` flag changes the effective working directory, and
`--config <file>` selects an explicit configuration file.

### Verify a skill or plugin

Run this from a directory containing `SKILL.md`, or a plugin root containing its supported
manifest. The Skillsmith repository root is not itself a skill or plugin:

```sh
skillsmith verify . --static
```

See [Verification and troubleshooting](#verification-and-troubleshooting) for coverage and
how to interpret results.

### Preview recorded state and convergence

Run these from a project with a manifest and lockfile. `review.plan` is a saved plan created
with `skillsmith plan --out review.plan`; inspect the plan before using it:

```sh
skillsmith status --tool codex --user   # correlate desired, locked, ledger, and live state
skillsmith plan --check                 # preview convergence; exit 7 when drift exists
skillsmith apply --dry-run              # validate and render fresh convergence without writing
skillsmith apply --plan review.plan --check # validate exact reviewed work; exit 7 on changes
```

The `--user` example selects the user manifest instead of this project's manifest.

### Update and undo selected installations

Replace `factor-scan` and `my-skill` with installed skill names from `skillsmith list`:

```sh
skillsmith update --check               # check moving declarations; exit 7 when updates exist
skillsmith update factor-scan --dry-run # render one exact update plan without writing
skillsmith undo my-skill --dry-run      # preview the newest reversible placement operation
```

The following are separate bulk actions. Each `--yes` approves the selected batch without
another prompt. Review the corresponding preview before choosing either action:

```sh
skillsmith update --all --dry-run       # preview the selected update batch
skillsmith update --all --yes           # approve and execute the exact bulk update plan
```

```sh
skillsmith undo --all --dry-run         # preview eligible retained operations
skillsmith undo --all --yes             # approve the exact bounded undo batch
```

### Initialize configuration and manage placements

Choose the line for your task. `owner/repo` is a GitHub source repository; replace `my-skill`
with an installed skill name. `dev` without `--source` needs a recorded development source,
and `promote` needs an existing development installation:

```sh
skillsmith init --dry-run               # preview creation of the selected manifest
skillsmith init --tool codex --project  # create project defaults without a lock or live import
skillsmith install owner/repo           # acquire a skill from a git host
skillsmith uninstall my-skill --tool claude-code --user --dry-run
skillsmith dev my-skill --tool claude-code --dry-run
skillsmith promote my-skill --tool claude-code --dry-run
skillsmith completion bash              # emit a Bash completion script
```

The development and promotion previews use the selected scope. Add `--user` or `--project`
when the same skill is installed in both. Shell completion is printed for you to source or
install; emitting it does not edit your shell configuration.

### Output and state behavior

Human output uses semantic color only when its destination is an eligible TTY. `--color always`
selects color on an eligible TTY but never through a pipe; `--no-color`, `--color never`,
`NO_COLOR`, `CLICOLOR=0`, and JSON output disable it. stdout carries command reports while stderr
carries diagnostics, warnings, and errors.

### Select one repository skill

`install <repository> --skill <name>` selects one `SKILL.md` directory. Skillsmith first matches
its directory basename exactly, including case. If no directory matches, it reads eligible
`SKILL.md` files and compares the complete frontmatter `name:` value, ignoring case. Frontmatter
is the YAML or JSON metadata block at the beginning of `SKILL.md`.

`--skills-match-frontmatter` is a boolean option that requires `--skill`. It skips directory
matching and uses only frontmatter names. Multiple matches in the chosen mode refuse with exit 2,
even in a terminal. No matches exit 5. Use a displayed exact-path source to resolve an ambiguity.
Root candidates and paths that cannot be represented by the source grammar are shown as locations,
without an executable retry.

For example, suppose a repository contains these two skills:

| Directory | Frontmatter `name:` | Installed name |
| --- | --- | --- |
| `skills/review` | `code-review` | `review` |
| `skills/security-review` | `review` | `security-review` |

| Intent | Existing interface | New interface and result |
| --- | --- | --- |
| Select the `review` directory | `skillsmith install acme/skills/review` | `skillsmith install acme/skills --skill review` selects `skills/review`. |
| Select declared name `code-review` | Use `skillsmith install acme/skills//skills/review` after finding its path. | `skillsmith install acme/skills --skill code-review` falls back to frontmatter and installs as `review`. |
| Select declared name `review` despite the directory conflict | Use `skillsmith install acme/skills//skills/security-review`. | `skillsmith install acme/skills --skill review --skills-match-frontmatter` installs as `security-review`. |

The existing `owner/repo/<name>` form continues to match directory names only. The existing
`owner/repo//path/to/skill` form continues to select an exact source path. `--skill` accepts exactly
one whole repository and cannot be combined with either embedded selector. `--ref` selects the
Git revision, and `--path` selects the local destination; neither changes the matching mode.

```sh
skillsmith install acme/skills --skill review --ref feature/review --tool claude-code
skillsmith install acme/skills --skill "CODE-REVIEW" --skills-match-frontmatter --dry-run
```

Names contain 1–256 Unicode code points, without surrounding whitespace, a leading dash, control
characters, or invisible formatting characters. Internal spaces and punctuation are allowed.
Directory and hidden-path eligibility rules remain unchanged. At the repository root, the
repository basename supplies the directory name.

Frontmatter scanning reads data without executing document content. It permits at most 1,000
eligible candidates, 1 MiB per file, and 16 MiB across the scan. Exact limits are accepted. Invalid
UTF-8, malformed or unsupported frontmatter, non-regular metadata files, failed reads, and exceeded
limits fail the entire scan; an early match cannot hide an unreadable competitor. A directory
match does not require a metadata scan. These internal limits are separate from search's HTTP
limits. Permission errors exit 6; cancellation exits 130.

Installation saves the selected directory path, commit SHA, and content hash with the existing
manifest and lockfile formats. The installed name comes from the directory, even when frontmatter
selected it. `plan`, `apply`, and `update` reuse the saved path, including the exact repository root.
Changing frontmatter names later cannot redirect an update. A missing saved path fails resolution.
The `install@2` and `search@1` JSON formats remain unchanged; search does not generate install commands.

### Search the remote catalog

`search [query...]`, also spelled `find`, searches skill listings on skills.sh. Words are joined
with spaces and trimmed; an explicit query needs at least two Unicode code points. `--owner`
filters indexed entries for one GitHub owner. Results retain the provider's order. Installation
counts describe catalog activity, and `verification: "not-checked"` means Skillsmith has not
inspected the listed skill. Catalog IDs and provider names are not repository path selectors or
local installed records. Use the displayed catalog URL to inspect an entry.

```sh
skillsmith search react
skillsmith search react native --owner expo --limit 10 --json
skillsmith search react --timeout 4m --max-response-size 20MB
skillsmith search --interactive react
```

An explicit query prints results and exits unless `--interactive` is supplied. Bare `search`
opens a live picker when stdin, stdout, and stderr are terminals. Type to search, use the arrow
keys to browse all returned results, and press Enter to display the selected entry's details.
Escape or Ctrl-C cancels. Prompts use stderr; final reports use stdout. Bare search and
`--interactive` require prompting to be enabled and cannot be combined with `--json` or `--quiet`.
Redirected streams require an explicit, noninteractive query. Selection does not install a skill.

| Option | Default | Accepted override |
| --- | --- | --- |
| `--limit` | `20` results | Integer from `1` to `20` |
| `--timeout` | `2m` | Positive integer followed by `ms`, `s`, `m`, or `h` |
| `--max-response-size` | `10MB` | Positive integer followed by `B`, `KB`, `MB`, `KiB`, or `MiB` |

The two-minute deadline covers connection setup, response reading, and at most one retry for each
issued query. The default response limit is 10,000,000 bytes **after decompression**, per attempt.
`KB` and `MB` are decimal; `KiB` and `MiB` are binary. Units are case-sensitive. Converted timeout
and size values must each be between 1 and 2,147,483,647 milliseconds or bytes, respectively;
fractions, missing units, repeated options, and zero are rejected. These limits can be raised or
lowered, but cannot be disabled. A body limit is not a bound on total process memory.

This provider is experimental. Search sends the query and optional owner to the same anonymous
`https://skills.sh/api/search` endpoint used by Vercel's `skills` CLI. Its public stability and
rate-limit contract are not documented. Search uses no API key, local index, persisted cache, or
telemetry, and does not change local skill state. Completion never searches the network.
`--json` emits strict `search@1` data with `schemaVersion: 1` and `kind: "skillsmith.search"`.
It includes the requested limit and returned count, without inventing a total or pagination token.
A successful empty result exits 0; invalid input exits 2, provider failures exit 5, and cancellation
exits 130. Failures use the existing `error@1` JSON envelope. For timeout or body-limit failures,
adjust the corresponding flag; for rate limits or unavailable service, try again later.

`status` is read-only: it correlates the selected manifest/lock pair, placement ledger, journals,
and live skill roots without running verification or writing recovery state. Use repeatable
`--tool`, one scope flag, or skill/path targets to narrow the report; `--file` and optional
`--lockfile` select an explicit portable pair. Human output is the default, `--json` emits strict
`status@1`, and `--check` exits nonzero when the selected state contains drift.

`plan` is read-only: it reports the operations needed to converge desired and current state but
does not execute or apply them and does not mutate the selected manifest, lock, ledger, live roots,
store, or configuration. Human output is the default, `--json` emits the same report as strict
data, and `--out` writes only the requested owner-only saved-plan artifact.

`apply` is the matching convergence command. Fresh mode prepares the same exact operation set as
`plan`; changing execution requires approval, while `--dry-run` and `--check` never lock or write.
`--plan <path>` validates a reviewed saved-plan v1 artifact without replanning or widening its
selection, and saved execution uses that prior authorization without prompting. Human output and
strict `apply-report@1` JSON are projections of the same operations, checks, diagnostics,
validation state, and execution results.

`update` is declaration-first: it selects entries from one portable manifest/lock pair and checks
moving refs by default; a fixed declaration is evaluated only when an explicit `--ref` replaces its
intent. Branch, tag, and full-SHA refs are inspected exactly, without naming heuristics, and the
inspected commit is materialized once for planning and execution. `--pin` stores that full SHA as
the declaration intent. `--check` and `--dry-run` make no durable writes. A multi-declaration
mutation requires approval of the exact group and operation order, or `--yes`; noninteractive bulk
mutation without `--yes` is a usage error. Claude Code uses its static update gate, while Codex
and Muse use static-plus-deep gates. Human output and strict `update@1` JSON project the same selected SHA,
skill, group, operation, diagnostic, and summary facts; `--check` exits 7 when an update is available.

`undo` selects a target or `--all` within the user and current-project placement history. It aborts
the newest pending placement transaction or reverses the newest committed `dev`, `promote`,
`install`, or `uninstall` only when the recorded live image and retained source still match; it
never guesses an older history entry. `--dry-run` is read-only. Changing JSON or noninteractive
execution requires `--yes`, while interactive execution presents the exact group and operation
order before approval. Human output and strict `undo@1` JSON report the same selection, linkage,
retention, operation, result, and summary facts. Repeating a completed undo reports
`already-reversed` without toggling state. `dev --rollback` and `promote --rollback` remain
deprecated compatibility spellings routed through this same undo plan.

`init` creates one declaration-empty canonical manifest. It selects the Git root when available and
otherwise the XDG user configuration path; `--file`, `--user`, or `--project` select it explicitly.
Claude Code, Codex, and Muse defaults may be repeated with `--tool`; subsequent writes must use
a scope supported by the selected tool. Existing canonical-equivalent state
is a noop, exact legacy project configuration is migrated losslessly, and other existing state
requires `--force`; future schemas are never downgraded. The sibling lock, live roots, store, and
placement ledger are not written. `--dry-run` and strict `--json` expose the same operation identity.

## Example output

This illustrative `agents` report shows one installation of each selected tool:

```sh
$ skillsmith agents --tool claude-code --tool kilo-code
# Tools detected

## claude-code — one installation

| Path                              | Version               | Install method |
|-----------------------------------|-----------------------|----------------|
| /Users/you/.local/bin/claude      | 2.1.119 (Claude Code) | unknown        |

## kilo-code — one installation

| Path                   | Version | Install method |
|------------------------|---------|----------------|
| /opt/homebrew/bin/kilo | 7.2.20  | brew           |
```

Use `skillsmith agents --format json` for automation. The response uses `schemaVersion: 2`
and `kind: "skillsmith.agents"`. Its `detections` array contains each selected tool and its
installations; one tool can have multiple installations. The separate `capabilities` object
describes supported operations and scopes.

This abbreviated example shows one tool. The entries in `capabilities.tools` are omitted for
readability; the actual response includes them:

```jsonc
{
  "schemaVersion": 2,
  "kind": "skillsmith.agents",
  "detections": [
    {
      "tool": "claude-code",
      "installations": [
        { "path": "/usr/local/bin/claude", "version": "2.1.119 (Claude Code)", "installMethod": "unknown" }
      ]
    }
  ],
  "capabilities": {
    "schemaVersion": 1,
    "kind": "skillsmith.capabilities",
    "tools": [
      // Capability entries omitted from this excerpt.
    ]
  }
}
```

`installMethod` is one of `brew`, `npm-global`, `bun-global`, `native-installer`, `app-bundle`, or `unknown`.
Other commands have their own versioned JSON response shapes; use the
[command reference](docs/commands.md) for their output options.

## Verification and troubleshooting

`verify <path>` checks a bare skill directory containing `SKILL.md` or a plugin directory
containing a supported manifest. Use the skill-source directory from the authoring walkthrough,
or the path reported by `list --long` for an installed skill.

| Mode | What it establishes |
| --- | --- |
| `--static` | Runs the tool's static checks; this is the default. Coverage varies by tool. Codex static verification checks the plugin manifest only. |
| `--deep` | Also checks native loading in an isolated environment, without a model call. Use it for Codex skill validation. |
| `--strict` | Makes verification warnings fail the command. It can be combined with either mode. |

From the skill-source repository root in the walkthrough, inspect detailed Codex results with:

```sh
skillsmith verify ./skills/review --tool codex --deep --strict --json
```

Check the overall verdict and the per-tool mode results. `inconclusive` means the requested
verification did not complete, for example because of a timeout or execution error. Resolve
the reported cause and rerun before treating loading as verified. The versions in the
[capability matrix](#capability-and-version-matrix) are verifier baselines; inspect reported
version drift when your installed tool differs.

Verification establishes compatibility and loading. To evaluate behavior, run representative
tasks in the target agent, as described in the [authoring walkthrough](#walkthrough-create-edit-verify-and-publish).

| Symptom | First check | Next action |
| --- | --- | --- |
| A coding tool is not detected | `skillsmith agents --detected-only` | Make its executable available on `PATH`, then rerun detection. |
| A skill is installed but does not appear | `skillsmith list review --tool codex --project --long` | Replace `review` with the installed name. Check its placement and scope, then open a fresh target-tool session in the project. |
| A name appears more than once | `skillsmith list --duplicates` and `skillsmith cross-tool-names` | Distinguish competing placements within one tool from a shared name across tools. Inspect paths before changing an installation. |
| Verification is inconclusive | `skillsmith verify ./skills/review --tool codex --deep --json` | Use your actual skill directory and target tool. Inspect the reported mode, diagnostic, and detected version. |
| A command exits with code `7` | Read its report and `skillsmith help exit-codes`. | For commands that document this code, it means drift or available differences. Review those differences before applying them. |
| The selected configuration or scope is unexpected | `skillsmith config list` | Inspect each value's source layer, then select the intended tool and scope explicitly. |

For broader diagnostics, run `skillsmith doctor`. `skillsmith doctor --fix --dry-run` previews
supported repairs. `skillsmith check` supplies blocking health checks for automation;
`--report-only` keeps findings in the report without failing on them.

## Upgrade

From the root of a clean Skillsmith checkout, update the source, restore the exact reviewed
dependency graph, and rerun the CLI:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run dev version
```

If you use a standalone binary, run `bun run build` again after the upgrade. Homebrew,
npm/Bun global, and native release assets do not yet have upgrade commands because those
distributions are not yet published.

## Potential lifecycle additions

These are suggestions for future coverage, not implemented commands or release commitments.
External editors, Git, and evaluation tools cover parts of these workflows today.

| Suggested lifecycle area | Group it would belong to | Current route | Potential addition |
| --- | --- | --- | --- |
| Inspect a skill before installing it | DISCOVER | Inspect its repository; `list --long` covers installed metadata. | **Proposed:** `view` for skill contents, origin, revision, and compatibility. |
| Create and edit a skill | DEVELOP | Create `SKILL.md` with an editor or authoring tool, then connect it with `dev --source`. | **Proposed:** `create` for scaffolding; optional `edit` to open the source in an editor. |
| Evaluate behavior and regressions | DEVELOP | Run representative tasks in the target agent and compare outcomes. | **Proposed:** `eval`, or a documented integration with an existing evaluator. |
| Temporarily deactivate a skill | MANAGE | Use target-tool controls where available, or uninstall it. | **Proposed:** `enable` and `disable` where the target tool supports them. |
| Share a reproducible collection | DECLARATIVE | Share the manifest and lockfile; recipients use `plan` and `apply --locked`. | The [team setup walkthrough](#walkthrough-reproduce-a-team-setup) now documents the complete workflow using existing commands. |
| Publish a skill release | New proposed PUBLISH group: Publish and share | Commit, review, tag, and push a Git repository; recipients use `install`. | **Proposed:** `publish` only after its destination and release behavior are defined. |
| Distribute files for offline installation | New proposed PUBLISH group: Publish and share | No built-in archive distribution workflow. | **Proposed:** `pack` plus archive installation support. |
| Onboard and maintain an environment | MAINTAIN | Use `config`, `completion`, `doctor`, `check`, and `gc`. | [Quickstart](#quickstart) and [troubleshooting](#verification-and-troubleshooting) cover first use and common problems; further scenario guides can build on them. |

`init` creates installation configuration. `verify --static` checks artifact structure;
`verify --deep` also checks native loading without a model call. Behavioral evaluation
checks whether the skill performs the intended task.

`promote` creates a fixed local snapshot. `export` writes portable installation declarations
and resolved revisions. Publishing makes the source revision accessible to recipients;
an offline archive would additionally need to contain the skill files.

**P17 target:** consistent behavior across the retained command surface, with generated public help and command documentation.

## Packages

> P17 disposition: current package boundary; authority: docs/architecture.md#core-cli-split

This repo is a Bun workspace with two packages:

| Package | What it is | On npm? |
|---|---|---|
| `@skillsmith/core` | Embeddable library: agent registry, `Result<T, SkillSmithError>` types, and domain/application operations behind injected capability ports; zero CLI dependencies. | Workspace only; not published |
| `skillsmith` | The CLI: `commander` entry, output rendering, help topics. Depends on `@skillsmith/core`. | Build from source (for now) |

### Using `@skillsmith/core` as a library

The workspace package exposes the detection pipeline to other packages in this repository:

```ts
import { registry, defaultScanEnv } from '@skillsmith/core';
import type { InstallRecord } from '@skillsmith/core';

const env = await defaultScanEnv();
const result = await registry['claude-code'].detect(env);
if (result.ok) {
  const installs: InstallRecord[] = result.value;
  console.log(installs);
}
```

Further reading: [`packages/core/README.md`](packages/core/README.md) (detection API, `Result` type, `ScanEnv` injection) and [`packages/cli/README.md`](packages/cli/README.md) (flag reference, output formats).

## Architecture snapshot

> P17 disposition: current architecture; authority: docs/architecture.md#core-cli-split

- **Core/CLI split** is enforced at lint time so `@skillsmith/core` stays embeddable — no `commander`/`chalk`/`consola`/`@clack/prompts` imports, no `process.exit`, no `console.*`. The CLI owns exit codes, output, and user I/O.
- **Results over exceptions:** core functions return `Result<T, SkillSmithError>`; the CLI decides exit codes.
- **Capability injection:** core operations accept environment capabilities (filesystem, process execution, paths, clock, logger) instead of owning CLI/process policy, which makes the library testable and the boundary explicit.

The full explainer lives in [`docs/architecture.md`](docs/architecture.md). The non-obvious design decisions are captured as [ADRs](docs/adr/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, commit format, and boundary rules. Credential checks and exception policy are documented in [`docs/credential-scanning.md`](docs/credential-scanning.md). Release process is documented in [`docs/releases.md`](docs/releases.md).

### Release candidates

Maintainers can build the ignored four-target candidate set with `bun run build:release`. The
candidate uses pinned GoReleaser to create four direct archives, `SHA256SUMS`, standard internal
artifact metadata, five npm tarballs, and a Homebrew cask candidate. Public availability remains
gated by P17-G6-04, the publication gate. Source checkout remains the only published path;
the candidate names describe packaging under validation.

Candidate work follows the [release process](docs/releases.md), including its active release holds.

## Project tracker

Active and completed projects live in [PROJECTS.md](PROJECTS.md).

## License

[Apache License 2.0](LICENSE). Copyright notice: [NOTICE](NOTICE).
