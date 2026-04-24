# Skillsmith

Skills you write for one AI coding tool don't work in the others. Skillsmith unifies skill install and sync across Claude Code, Codex, Kilo Code, and opencode.

**Today:** `agents` — detect Claude Code, Codex, Kilo Code, and opencode, and report their version, install path, and install method.
**Roadmap:** `install`, `list`, `apply`, `sync`, `doctor`, `uninstall` — designed, not yet implemented.

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

`installMethod` is one of `brew`, `npm-global`, `bun-global`, `standalone`, `unknown`.

## Install

No prebuilt binaries yet — run from source. Requires [Bun](https://bun.sh) ≥ 1.3.13.

```sh
git clone https://github.com/stevemorin/skillsmith.git
cd skillsmith
bun install
bun run dev agents         # fastest way to try it — no build step
```

To produce a standalone binary:

```sh
bun run build              # darwin-arm64 by default; see package.json for other targets
./dist/skillsmith --help
```

## Quickstart

Use either `bun run dev` (runs from source) or `./dist/skillsmith` (after `bun run build`). Examples below use `skillsmith` as a stand-in for whichever you pick.

```sh
skillsmith agents                       # human-readable markdown
skillsmith agents --format json         # machine-readable (see envelope note above)
skillsmith agents --detected-only       # skip the "Not detected" section
skillsmith agents --tool claude-code    # scan one tool only (repeatable)
```

## Supported tools

| Tool ID        | Probed binary | Detection today                                   |
|----------------|---------------|---------------------------------------------------|
| `claude-code`  | `claude`      | PATH lookup → `--version` → classify install path |
| `codex`        | `codex`       | PATH lookup → `--version` → classify install path |
| `kilo-code`    | `kilo`        | PATH lookup → `--version` → classify install path |
| `opencode`     | `opencode`    | PATH lookup → `--version` → classify install path |

The install-method classifier recognizes `brew`, `npm-global`, `bun-global`, `standalone`, and falls back to `unknown`. Each tool owns a separate directory under [`packages/core/src/agents/`](packages/core/src/agents/) so any one can diverge from the shared detection pipeline without touching the others.

Missing a tool? Open an issue with a `skillsmith agents --format json` dump and the OS / install method you used.

### What it runs on your system

`agents` is read-only. For each supported tool, Skillsmith resolves the binary on your `PATH` and invokes it once with `--version` to capture the output. Nothing else from those tools is executed, and `agents` writes no files. Skillsmith's own config, when you use `config set`, lives at `$XDG_CONFIG_HOME/skillsmith/config.toml` (user) or `./skillsmith.toml` (project).

## Packages

This repo is a Bun workspace with two packages:

| Package | What it is | On npm? |
|---|---|---|
| `@skillsmith/core` | Pure detection library: agent registry, `Result<T, SkillSmithError>` types, zero CLI deps, zero side effects. | Yes |
| `skillsmith` | The CLI: `commander` entry, output rendering, help topics. Depends on `@skillsmith/core`. | Build from source (for now) |

### Using `@skillsmith/core` as a library

If you're building your own tool and want the detection pipeline without the CLI:

```sh
bun add @skillsmith/core    # or: npm i @skillsmith/core
```

```ts
import { registry, defaultScanEnv } from '@skillsmith/core';
import type { InstallRecord } from '@skillsmith/core';

const env = defaultScanEnv();
const result = await registry['claude-code'].detect(env);
if (result.ok) {
  const installs: InstallRecord[] = result.value;
  console.log(installs);
}
```

Further reading: [`packages/core/README.md`](packages/core/README.md) (detection API, `Result` type, `ScanEnv` injection) and [`packages/cli/README.md`](packages/cli/README.md) (flag reference, output formats).

## Architecture snapshot

- **Core/CLI split** is enforced at lint time so `@skillsmith/core` stays embeddable — no `commander`/`chalk`/`consola`/`@clack/prompts` imports, no `process.exit`, no `console.*`. The CLI owns exit codes, output, and user I/O.
- **Results over exceptions:** core functions return `Result<T, SkillSmithError>`; the CLI decides exit codes.
- **`ScanEnv` injection:** core accepts an environment object (home dir, XDG paths, logger) rather than touching globals directly, which makes the library testable and the CLI boundary explicit.

The full explainer lives in [`docs/architecture.md`](docs/architecture.md). The non-obvious design decisions are captured as [ADRs](docs/adr/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, commit format, and boundary rules. Release process is documented in [`docs/releases.md`](docs/releases.md).

## Project tracker

Active and completed projects live in [PROJECTS.md](PROJECTS.md).

## License

[Apache License 2.0](LICENSE). Copyright notice: [NOTICE](NOTICE).
