# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added
- MVP-2b.1.1: plugin-bundled skill discovery — `skillsmith list --tool claude-code` now finds skills shipped by installed plugins in addition to standalone skills. Fixes a bug where a machine with 40+ active skills reported only 1.
- New top-level `skillsmith commands` subcommand lists slash commands discovered across `user` and `project` scopes.
- New `managed` scope (Claude Code policy-managed skills) with `CLAUDE_CODE_MANAGED_SETTINGS_PATH` override and `CLAUDE_CODE_DISABLE_POLICY_SKILLS` honored.
- Public API: `CommandEntry`, `Origin` (`standalone | plugin | policy`), `EnabledState` (`on | off | unset`), `PluginProvenanceScope` (`user | project | managed | local`).
- `list`/`commands` flags: `--enabled`, `--disabled`, `--unconfigured` filter by the new 3-state enablement; `list --managed` shorthand.
- ESLint zones for `plugins/**` and `commands/**` (type-only imports from sibling domains allowed via `except: ['./types.ts']`).
- JSON schema for `list` bumped to `schemaVersion: 2` with `origin` + `enabled` fields.
- Apache-2.0 license (`LICENSE`, `NOTICE`).
- Root `README.md`, `CONTRIBUTING.md`, and this `CHANGELOG.md`.
- Slim per-package READMEs (`packages/core/README.md`, `packages/cli/README.md`).
- `license: "Apache-2.0"` field on each `package.json`.
- ESLint with `import/no-restricted-paths` enforcing architectural zones (core ↔ cli, plus in-package CLI layering) via `eslint.config.js`. Wired into `bun run check` and into lefthook's pre-commit hook.
- ESLint `no-restricted-imports` + `no-restricted-syntax` rules scoped to `packages/core/src/**` (forbidding `commander`, `chalk`, `consola`, `@clack/prompts`, `node:console`, `process.exit`, and `console.{log,info,warn,error,debug}`) — replaces the earlier `scripts/check-core-boundary.ts`.
- New ESLint zones after core layering refactor: `env ↛ agents`, `env ↛ detect`, `detect ↛ agents`.
- `scripts/build-native.ts` to detect the host target; per-target `build:*` scripts so the default `build` is no longer hardcoded to `bun-darwin-arm64`.
- `bun-global` install-method classification for binaries under `~/.bun/install/global/**`.
- Tests: bun-global classification; markdown cell escaping.

### Changed
- Core layering: `exec.ts` moved to `env/`; `InstallMethod`/`InstallRecord` split into `detect/types.ts`; orchestrator moved to `scan/`.
- `detectTool`/`detectAll` now forward an `AbortSignal` to each agent.
- `--color` flag goes through `resolveColorMode`, which sets `NO_COLOR`/`FORCE_COLOR`.
- Lefthook Biome and typecheck globs now use `**/` prefix.

### Fixed
- `exec.ts`: early-return on pre-aborted signal; read stdout concurrently with `proc.exited`.
- `renderAgentsMarkdown` escapes `|`, `\`, and newlines in cells.
- `defaultScanEnv` splits `PATH` using the platform `path.delimiter`.
- `help [topic]` emits an internal error and exits 1 if a known topic has no content.
- `SIGINT` handler sets `process.exitCode = 130` and exposes `wasInterrupted()`; `main()` returns 130 on interrupt.
- `fileExists` no longer falls back to `existsSync`; catches the failure and returns `false`.

### Removed
- `scripts/check-core-boundary.ts` (superseded by ESLint rules above).

## [0.1.0] — 2026-04-24

Initial tagged release.

### Added
- Bun workspace scaffold, Biome lint/format config, TypeScript strict base.
- Lefthook pre-commit (biome, typecheck, actionlint), pre-push (tests), and commit-msg (conventional commits) hooks.
- CI workflow for macOS and Ubuntu.
- `@skillsmith/core`: `Result<T, SkillSmithError>` helpers, `SkillSmithError` tagged union, `Logger` interface + `noopLogger`, `ScanEnv` + `defaultScanEnv`, `runVersionCommand` with a 2-second abort timeout, agent types, and scanner utilities.
- Four supported agents: Claude Code, Codex, Kilo Code, opencode — each with detection, install hint, and stubs.
- Agent registry (`getAgent`, `listSupportedTools`), detection orchestrators (`detectAll`, `detectTool`), and public API surface.
- `skillsmith` CLI: commander entry, `agents` command, `version`, `help [topic]`, SIGINT handler, color-mode resolver honoring `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`, markdown + JSON (zod-validated) renderers, error-code → exit-code mapping.

[Unreleased]: https://github.com/stevemorin/skillsmith/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stevemorin/skillsmith/releases/tag/v0.1.0
