# Skillsmith

> P17 disposition: current behavior; authority: packages/cli/src/program.ts

Skills you write for one AI coding tool don't work in the others. Skillsmith unifies skill discovery
and management across Claude Code, Codex, Kilo Code, and opencode.

**Today:** `agents`, `config`, `list`, `ls`, `commands`, `doctor`, `check`, `verify`, `status`, `plan`, `apply`, `sync`, `update`, `undo`, `promote`, `dev`, `demote`, `install`, `i`, `uninstall`, `rm`, `remove`, `export`, `gc`, `init`, `version`, `completion`, and `help` are implemented.
**P17 target:** consistent behavior across the retained command surface. The [consolidated P17 plan](docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md) is authoritative for the remaining work.

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
    // codex, kilo-code, opencode — same shape; each key maps to an array (a tool can have multiple installs on one system)
  }
}
```

`installMethod` is one of `brew`, `npm-global`, `bun-global`, `native-installer`, `app-bundle`, or `unknown`.

## Install

> P17 disposition: current source-build behavior; authority: package.json

No prebuilt binaries yet — run from source. Requires [Bun](https://bun.sh) ≥ 1.3.14.

```sh
git clone https://github.com/smorinlabs/skillsmith.git
cd skillsmith
bun install
bun run dev agents         # fastest way to try it — no build step
```

To produce a standalone binary:

```sh
bun run build              # compiles for the current host; package.json also has explicit targets
./dist/skillsmith --help
```

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

## Supported tools

| Tool ID        | Probed binary | Detection today                                   |
|----------------|---------------|---------------------------------------------------|
| `claude-code`  | `claude`      | PATH lookup → `--version` → classify install path |
| `codex`        | `codex`       | PATH lookup → `--version` → classify install path |
| `kilo-code`    | `kilo`        | PATH lookup → `--version` → classify install path |
| `opencode`     | `opencode`    | PATH lookup → `--version` → classify install path |

The install-method classifier recognizes `brew`, `npm-global`, `bun-global`, `native-installer`,
and `app-bundle`, and falls back to `unknown`. Each tool owns a separate directory under
[`packages/core/src/agents/`](packages/core/src/agents/) so any one can diverge from the shared
detection pipeline without touching the others.

Detection, inventory, `doctor`, and `check` support Claude Code, Codex, Kilo Code, and opencode.
`verify` supports Claude Code and Codex. Write and mutation commands support Claude Code and Codex;
Kilo Code is read-only/detection today, and opencode is read-only/detection today.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, commit format, and boundary rules. Release process is documented in [`docs/releases.md`](docs/releases.md).

## Project tracker

Active and completed projects live in [PROJECTS.md](PROJECTS.md).

## License

[Apache License 2.0](LICENSE). Copyright notice: [NOTICE](NOTICE).
