# Skillsmith

A CLI that installs and manages agent skills for AI coding tools.

> **Status:** pre-1.0 (v0.1.0). The `agents` command is the only shipped surface today — it detects which supported AI coding tools are installed on the current system. Other commands (`install`, `list`, `apply`, `sync`, `doctor`, `uninstall`) are designed but not yet implemented.

## Install

Skillsmith is a Bun workspace; build a native binary from source:

```sh
git clone https://github.com/stevemorin/skillsmith.git
cd skillsmith
bun install
bun run build              # darwin-arm64 by default; see scripts in package.json for other targets
./dist/skillsmith --help
```

Requires [Bun](https://bun.sh) ≥ 1.3.13.

## Quickstart

```sh
./dist/skillsmith agents                       # human-readable markdown
./dist/skillsmith agents --format json         # machine-readable
./dist/skillsmith agents --detected-only       # skip the "Not detected" section
./dist/skillsmith agents --tool claude-code    # scan one tool only (repeatable)
```

Output lists each supported AI coding tool (Claude Code, Codex, Kilo Code, opencode) with its install method (`brew`, `npm-global`, `bun-global`, `standalone`, …) and resolved binary path.

## Packages

This repo is a Bun workspace with two packages:

| Package | What it is |
|---|---|
| `@skillsmith/core` | Pure library: agent registry, detection pipeline, `Result<T, SkillSmithError>` types. Zero CLI deps, zero side effects. |
| `skillsmith` | The CLI: `commander` entry, output rendering, help topics. Depends on `@skillsmith/core`. |

See [`packages/core/README.md`](packages/core/README.md) and [`packages/cli/README.md`](packages/cli/README.md).

## Architecture snapshot

- **Core/CLI split** is enforced at lint time — `@skillsmith/core` cannot import `commander`/`chalk`/`consola`/`@clack/prompts`, call `process.exit`, or use `console.*`. Enforcement lives in `eslint.config.js` (rules `no-restricted-imports`, `no-restricted-syntax`, and `import/no-restricted-paths`).
- **Results over exceptions:** core functions return `Result<T, SkillSmithError>`; the CLI decides exit codes.
- **`ScanEnv` injection:** core accepts an environment object (home dir, XDG paths, logger) rather than touching globals directly, which makes the library testable and the CLI boundary explicit.

The full explainer lives in [`docs/architecture.md`](docs/architecture.md). The non-obvious design decisions are captured as [ADRs](docs/adr/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, commit format, and boundary rules. Release process is documented in [`docs/releases.md`](docs/releases.md).

## Project tracker

Active and completed projects live in [PROJECTS.md](PROJECTS.md).

## License

[Apache License 2.0](LICENSE). Copyright notice: [NOTICE](NOTICE).
