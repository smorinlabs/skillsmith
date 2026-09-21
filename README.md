# Skillsmith

> P17 disposition: current behavior; authority: packages/cli/src/program.ts

Skills you write for one AI coding tool don't work in the others. Skillsmith unifies skill discovery
and management across Claude Code, Codex, Kilo Code, opencode, and Muse.

**Today:** `agents`, `config`, `list`, `ls`, `commands`, `cross-tool-names`, `doctor`, `check`, `verify`, `status`, `plan`, `apply`, `sync`, `update`, `undo`, `promote`, `dev`, `demote`, `install`, `i`, `uninstall`, `rm`, `remove`, `export`, `gc`, `init`, `version`, `completion`, and `help` are implemented.
**P17 target:** consistent behavior across the retained command surface, with generated public help and command documentation.


<!-- skillsmith-command-index:start -->
## Command orientation

Choose a command by the question you need answered. This table and the full [command reference](docs/commands.md) are generated from the live CLI registry.

| Group | Command | Primary question |
|---|---|---|
| DISCOVER | `agents` | Which coding tools are detected and what can Skillsmith do with them? |
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
## Example output

```sh
$ skillsmith agents
# Tools detected

## claude-code

| Path                              | Version               | Install method |
|-----------------------------------|-----------------------|----------------|
| /Users/you/.local/bin/claude      | 2.1.119 (Claude Code) | unknown        |

## kilo-code

| Path                   | Version | Install method |
|------------------------|---------|----------------|
| /opt/homebrew/bin/kilo | 7.2.20  | brew           |
```

Machine-readable form (`--format json`) wraps results in a small envelope. Shape is marked `experimental` and may still change before 1.0:

```jsonc
{
  "schemaVersion": 1,
  "experimental": true,
  "tools": {
    "claude-code": [
      { "path": "/usr/local/bin/claude", "version": "2.1.119 (Claude Code)", "installMethod": "unknown" }
    ]
    // codex, kilo-code, opencode, muse — same shape; each key maps to an array (a tool can have multiple installs on one system)
  }
}
```

`installMethod` is one of `brew`, `npm-global`, `bun-global`, `native-installer`, `app-bundle`, or `unknown`.

## Install

> P17 disposition: current source-build behavior; authority: package.json

The Source checkout is the currently available installation method. It requires
[Bun](https://bun.sh) ≥ 1.3.14.

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

Maintainers can build the ignored four-target candidate set with `bun run build:release`. The
candidate uses pinned GoReleaser to create four direct archives, `SHA256SUMS`, standard internal
artifact metadata, five npm tarballs, and a Homebrew cask candidate. Public availability remains
gated by P17-G6-04; these candidate names are not an installation claim and source checkout remains
the only published path.

## Upgrade

Update a clean Source checkout, restore the exact reviewed dependency graph, and rerun the CLI:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run dev version
```

If you use a standalone binary, run `bun run build` again after the upgrade. Homebrew,
npm/Bun global, and native release assets do not yet have upgrade commands because those
distributions are not yet published.

## Quickstart

> P17 disposition: current examples; authority: packages/cli/src/program.ts

Use either `bun run dev` (runs from source) or `./dist/skillsmith` (after `bun run build`). Examples below use `skillsmith` as a stand-in for whichever you pick.

```sh
skillsmith agents                       # human-readable markdown
skillsmith agents --format json         # machine-readable (see envelope note above)
skillsmith agents --detected-only       # skip the "Not detected" section
skillsmith agents --tool claude-code    # scan one tool only (repeatable)
skillsmith list                         # inspect installed skills
skillsmith config list                  # show effective configuration and source layers
skillsmith check --report-only          # report CI checks without failing on findings
skillsmith verify . --static            # statically verify a plugin or bare skill directory
skillsmith status --tool codex --user   # correlate desired, locked, ledger, and live state
skillsmith plan --check                 # preview convergence; exit 7 when drift exists
skillsmith apply --dry-run              # validate and render fresh convergence without writing
skillsmith apply --plan review.plan --check # validate exact reviewed work; exit 7 on changes
skillsmith update --check               # check moving declarations; exit 7 when updates exist
skillsmith update factor-scan --dry-run # render one exact update plan without writing
skillsmith update --all --yes           # approve and execute the exact bulk update plan
skillsmith undo my-skill --dry-run      # preview the newest reversible placement operation
skillsmith undo --all --yes             # approve the exact bounded undo batch
skillsmith init --dry-run               # preview creation of the selected manifest
skillsmith init --tool codex --project  # create project defaults without a lock or live import
skillsmith install owner/repo           # acquire a skill from a git host
skillsmith uninstall my-skill --tool claude-code --user --dry-run
skillsmith dev my-skill --tool claude-code --dry-run
skillsmith promote my-skill --tool claude-code --dry-run
skillsmith completion bash              # emit a Bash completion script
```

`check` fails on error findings by default; use `--report-only` when only the report should be
produced. The inherited `-C <dir>` flag changes the effective working directory, and
`--config <file>` selects an explicit configuration file.

Human output uses semantic color only when its destination is an eligible TTY. `--color always`
selects color on an eligible TTY but never through a pipe; `--no-color`, `--color never`,
`NO_COLOR`, `CLICOLOR=0`, and JSON output disable it. stdout carries command reports while stderr
carries diagnostics, warnings, and errors.

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
mutation without `--yes` is a usage error. Claude Code uses its static update gate, while Codex uses
its static-plus-deep gate. Human output and strict `update@1` JSON project the same selected SHA,
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
Claude Code and Codex defaults may be repeated with `--tool`. Existing canonical-equivalent state
is a noop, exact legacy project configuration is migrated losslessly, and other existing state
requires `--force`; future schemas are never downgraded. The sibling lock, live roots, store, and
placement ledger are not written. `--dry-run` and strict `--json` expose the same operation identity.


## Skill lifecycle workflows

The CLI groups commands by lifecycle area. The recommended names below are documentation
proposals; the current group names are the headings printed by `skillsmith --help`.
Commands in this section are available today unless explicitly marked **Proposed**.

| Current group | Recommended name | Existing commands |
| --- | --- | --- |
| DISCOVER | Discover and inspect | `agents`, `list`, `commands`, `cross-tool-names`, `status` |
| MANAGE | Install, update, and remove | `install`, `update`, `uninstall`, `undo` |
| DEVELOP | Develop and verify | `dev`, `verify`, `promote` |
| DECLARATIVE | Reproduce and synchronize | `init`, `export`, `plan`, `apply`, `sync` |
| MAINTAIN | Configure and troubleshoot | `doctor`, `check`, `gc`, `config`, `completion`, `version`, `help` |

Remote catalog search (`search`, alias `find`) is being developed in
[PR #100](https://github.com/smorinlabs/skillsmith/pull/100) and is not available on `main` yet.
Aliases such as `ls` and `demote` are alternate spellings of existing commands.
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

### Potential lifecycle additions

These are suggestions for future coverage, not implemented commands or release commitments.
External editors, Git, and evaluation tools cover parts of these workflows today.

| Suggested lifecycle area | Group it would belong to | Current route | Potential addition |
| --- | --- | --- | --- |
| Inspect a skill before installing it | DISCOVER | Inspect its repository; `list --long` covers installed metadata. | **Proposed:** `view` for skill contents, origin, revision, and compatibility. |
| Create and edit a skill | DEVELOP | Create `SKILL.md` with an editor or authoring tool, then connect it with `dev --source`. | **Proposed:** `create` for scaffolding; optional `edit` to open the source in an editor. |
| Evaluate behavior and regressions | DEVELOP | Run representative tasks in the target agent and compare outcomes. | **Proposed:** `eval`, or a documented integration with an existing evaluator. |
| Temporarily deactivate a skill | MANAGE | Use target-tool controls where available, or uninstall it. | **Proposed:** `enable` and `disable` where the target tool supports them. |
| Share a reproducible collection | DECLARATIVE | Share the manifest and lockfile; recipients use `plan` and `apply --locked`. | Document the complete team-onboarding workflow using existing commands. |
| Publish a skill release | New proposed PUBLISH group: Publish and share | Commit, review, tag, and push a Git repository; recipients use `install`. | **Proposed:** `publish` only after its destination and release behavior are defined. |
| Distribute files for offline installation | New proposed PUBLISH group: Publish and share | No built-in archive distribution workflow. | **Proposed:** `pack` plus archive installation support. |
| Onboard and maintain an environment | MAINTAIN | Use `config`, `completion`, `doctor`, `check`, and `gc`. | Expand scenario documentation around existing commands. |

`init` creates installation configuration. `verify --static` checks artifact structure;
`verify --deep` also checks native loading without a model call. Behavioral evaluation
checks whether the skill performs the intended task.

`promote` creates a fixed local snapshot. `export` writes portable installation declarations
and resolved revisions. Publishing makes the source revision accessible to recipients;
an offline archive would additionally need to contain the skill files.

### Ways to install and share skills

Choose the source, target tool, installation scope, revision policy, and file placement
independently. User scope applies across projects; project scope applies to one project.
These write and verification workflows currently support Claude Code and Codex.
The other detected tools have read-only support; see the [capability matrix](#capability-and-version-matrix).

| Scenario | Mode or command | What to expect |
| --- | --- | --- |
| Use a skill across personal projects | `install --user` | Install into user scope for the selected tool. |
| Give one project its own skills | `install --project` | Install into project scope and save declarations by default. |
| Target both supported tools | `--tool claude-code --tool codex` | Select both tools explicitly on commands with repeatable `--tool`. |
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

<!-- skillsmith-capability-matrix:start -->
## Capability and version matrix

Generated from the live tool registry for Skillsmith 0.8.0. A scope list means the operation is supported in those scopes; “yes” means the operation is supported without a scope; “—” means it is not supported.

| Tool | Capability contract | Verifier baseline |
|---|---|---|
| `claude-code` | capability v1 | 2.1.202 |
| `codex` | capability v1 | 0.142.5 |
| `kilo-code` | capability v1 | not applicable |
| `opencode` | capability v1 | not applicable |
| `muse` | capability v1 | not applicable |

| Operation | `claude-code` | `codex` | `kilo-code` | `opencode` | `muse` |
|---|---|---|---|---|---|
| `detect` | yes | yes | yes | yes | yes |
| `inventory-skills` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `inventory-commands` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `diagnostics` | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed | user, project, system, managed |
| `install` | user, project, custom | user, project, custom | — | — | — |
| `uninstall` | user, project, custom | user, project, custom | — | — | — |
| `dev` | user, project, custom | user, project, custom | — | — | — |
| `promote` | user, project, custom | user, project, custom | — | — | — |
| `undo` | user, project, custom | user, project, custom | — | — | — |
| `verify-static` | artifact | artifact | — | — | — |
| `verify-deep` | artifact | artifact | — | — | — |
| `plan` | user, project, custom | user, project, custom | — | — | — |
| `apply` | user, project, custom | user, project, custom | — | — | — |
| `sync` | user, project, custom | user, project, custom | — | — | — |
| `update` | user, project, custom | user, project, custom | — | — | — |
| `adapt` | — | — | — | — | — |
<!-- skillsmith-capability-matrix:end -->
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
and Muse. `verify` supports Claude Code and Codex. Write and mutation commands support Claude Code
and Codex; Kilo Code, opencode, and Muse are read-only/detection today.

Missing a tool? Open an issue with a `skillsmith agents --format json` dump and the OS / install method you used.

### What it runs on your system

`agents` is read-only. For each supported tool, Skillsmith resolves the binary on your `PATH` and invokes it once with `--version` to capture the output. Nothing else from those tools is executed, and `agents` writes no files. Skillsmith's own config, when you use `config set`, lives at `$XDG_CONFIG_HOME/skillsmith/config.toml` (user) or `./skillsmith.toml` (project).

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

## Project tracker

Active and completed projects live in [PROJECTS.md](PROJECTS.md).

## License

[Apache License 2.0](LICENSE). Copyright notice: [NOTICE](NOTICE).
