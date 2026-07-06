# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## [0.3.2](https://github.com/smorinlabs/skillsmith/compare/v0.3.1...v0.3.2) (2026-07-06)


### Bug Fixes

* dependency security updates + P10 un-park hygiene ([#1](https://github.com/smorinlabs/skillsmith/issues/1)) ([3df05ba](https://github.com/smorinlabs/skillsmith/commit/3df05bacac9a6e0ae13cfcb6026e8a3e4ca0dee4))

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

## [0.3.1] — 2026-04-24

### Features

* **cli:** add --managed/--enabled/--disabled/--unconfigured to list, add commands subcommand ([a64921e](https://github.com/smorinlabs/skillsmith/commit/a64921e4eb7fbe806c62b48416d12f98ba8bb66b))
* **core:** add 'managed' to Scope enum ([c7f6a52](https://github.com/smorinlabs/skillsmith/commit/c7f6a52c46fe0125e48869c05328059bc8112979))
* **core:** add CommandEntry type parallel to SkillEntry ([f3e27da](https://github.com/smorinlabs/skillsmith/commit/f3e27dac85b60fcda07d4c31d7f8090c9ff8419d))
* **core:** add Origin tagged union + EnabledState + extend SkillEntry ([8c52a0d](https://github.com/smorinlabs/skillsmith/commit/8c52a0de8c25c14d47a384c238e39318b3b7c2cf))
* **core:** add plugins/ domain — installed.ts, enablement.ts, discover.ts ([fa85441](https://github.com/smorinlabs/skillsmith/commit/fa854417f2afdc4ab61404d5d222a6de5544a812))
* **core:** extend Agent interface with command-roots, plugin-paths, managed-path ([8d89fec](https://github.com/smorinlabs/skillsmith/commit/8d89fec50182ee279b75bea35e5bb97bb07b7734))
* **core:** listSkills extended for plugins+managed; add walkCommandDir + listCommands ([b4c4e92](https://github.com/smorinlabs/skillsmith/commit/b4c4e923155001b22d5ecbb6156c62af789a87b9))

## [0.3.0] — 2026-04-27

### ⚠ BREAKING CHANGES

* **cli:** installSigintHandler and SigintHandle are renamed to installSignalHandler and SignalHandle. These are @skillsmith/cli internals (no external callers), but documenting for completeness.

### Features

* **cli:** add list, doctor, and check commands ([3a2664b](https://github.com/smorinlabs/skillsmith/commit/3a2664b09f7644f6865872144adc5275e96f4caf))
* **core:** add 8 built-in doctor checks (xdg, config, tool, scope, dup, multi, legacy, network) ([904c9d0](https://github.com/smorinlabs/skillsmith/commit/904c9d048f57b0491e34732865adfb96496f3477))
* **core:** add doctor types, runChecks, and empty registry scaffold ([77ab8c6](https://github.com/smorinlabs/skillsmith/commit/77ab8c6f699fa47a45bd080b3b38eedb9f603e5f))
* **core:** add getSkillRoots for all four agents + Agent interface update ([0f87e90](https://github.com/smorinlabs/skillsmith/commit/0f87e90724c27ff94e7756bf9ad473210d45d329))
* **core:** add listSkills orchestrator with glob + dedup + duplicates ([51d9d75](https://github.com/smorinlabs/skillsmith/commit/51d9d7593701bf9eeb3c865ea861c35912c04bba))
* **core:** add ScanEnv.listDir and readText for filesystem enumeration ([4179358](https://github.com/smorinlabs/skillsmith/commit/4179358d983e8f3563369dfc2ec9c0a8decb9b41))
* **core:** add skill-parse-error variant + exit-code mapping ([a30510d](https://github.com/smorinlabs/skillsmith/commit/a30510dcc7d800963110a3f07347aaeda578385b))
* **core:** add SkillEntry types and parseSkillFrontmatter ([3297949](https://github.com/smorinlabs/skillsmith/commit/3297949461f85cbea3f6ad5831cdee3357274a2a))
* **core:** add walkSkillDir with fake-filesystem test matrix ([fd795cd](https://github.com/smorinlabs/skillsmith/commit/fd795cd8271628548fbc268f5e1c1058c2fa420f))
* **core:** export MVP-2b.1 public API + add scope-resolver to cli ([2dda7b2](https://github.com/smorinlabs/skillsmith/commit/2dda7b270dba9d6dae46c177f8e38df1f002058d))

### Bug Fixes

* align release automation with workspace version and pre-1.0 policy ([4510d4a](https://github.com/smorinlabs/skillsmith/commit/4510d4a13038802a2e4e9e1ca78d37f0ac15cfdc))
* **cli:** correct shell completion generation for bash, zsh, and fish ([efcec9f](https://github.com/smorinlabs/skillsmith/commit/efcec9f4fdb36cc14b7ad207180ec58ce30c3cf0))
* **cli:** handle SIGTERM in addition to SIGINT ([a515a61](https://github.com/smorinlabs/skillsmith/commit/a515a61270db974ef26c12e7a0a8d25d4d58a265))
* **cli:** validate config set values for tool and scope ([42feead](https://github.com/smorinlabs/skillsmith/commit/42feead7346dfb42509886c885b5c142f8e4aa73))
* **core:** validate SKILLSMITH_TOOL and SKILLSMITH_SCOPE against enums ([b428ace](https://github.com/smorinlabs/skillsmith/commit/b428acebc2a4d0d17f6e6a8c83661361b0fbdc5b))

## [0.2.0] — 2026-04-24

### Features

* **cli:** add commander-tree walker producing CompletionNode AST ([03154ba](https://github.com/smorinlabs/skillsmith/commit/03154ba5a6ad90b5f5c69d07b7fa50118b80398c))
* **cli:** render fish completion from CompletionNode tree ([3e82b2f](https://github.com/smorinlabs/skillsmith/commit/3e82b2fb406201ee9655d34ddb666a1df906657a))
* **cli:** wire completion command + exit-2 remap for commander usage errors ([c59c027](https://github.com/smorinlabs/skillsmith/commit/c59c02755de75ad5318baa6ded5621f4f6f11a64))
* **cli:** wire config get/set/list/unset into commander ([8eeedbd](https://github.com/smorinlabs/skillsmith/commit/8eeedbdc4cf2000b2ac9ecad358c6a98b401991b))
* **core:** add config path resolution (XDG + walk-up + explicit) ([1eafbd4](https://github.com/smorinlabs/skillsmith/commit/1eafbd465dc1a2a542ada58171be1573ebf312f9))
* **core:** add Config types, zod schema, config-error variant (exit 3) ([2123741](https://github.com/smorinlabs/skillsmith/commit/2123741bac1e13d9dfccae2c66ffaed032260baf))
* **core:** export loadConfig, saveConfig, and config types publicly ([c3e2c9b](https://github.com/smorinlabs/skillsmith/commit/c3e2c9b620cc3662f69021ce7d08e09b419f3217))
* **core:** layered loadConfig with per-key source tracking ([6bc8804](https://github.com/smorinlabs/skillsmith/commit/6bc88041c8b15a33a19d78be6cb051fe6f2ae14c))
* **core:** read partial Config from SKILLSMITH_* env vars ([4d2f55d](https://github.com/smorinlabs/skillsmith/commit/4d2f55d635d9703c4bf92fe0bdbcf1015bfe8b1f))
* **core:** saveConfig with proper-lockfile + atomic write-temp+rename ([f327239](https://github.com/smorinlabs/skillsmith/commit/f327239426bdc1ba9b9f751b47b3410ce9ff3796))
* **lint:** add ESLint import-boundary rules via import/no-restricted-paths ([cdc17b4](https://github.com/smorinlabs/skillsmith/commit/cdc17b46120cc5e32ce25a23877bb6f4dc581536))

### Bug Fixes

* **core:** wire AbortSignal through Agent.detect and runVersion (BUG-01, BUG-03) ([c68430c](https://github.com/smorinlabs/skillsmith/commit/c68430cdc36cf26a907c3589acdc4ac49972f1cc))
* **lint:** also block 'node:console' import in core (BUG-02) ([2247e78](https://github.com/smorinlabs/skillsmith/commit/2247e78f5c4825ef64c46e4c8ca588b77474c25f))
* round-1 bug audit — CLI, core, and tooling fixes ([544321d](https://github.com/smorinlabs/skillsmith/commit/544321d76aafd543e1ce885a87a53c9c6cec0ce5))

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

[Unreleased]: https://github.com/smorinlabs/skillsmith/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/smorinlabs/skillsmith/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/smorinlabs/skillsmith/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smorinlabs/skillsmith/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smorinlabs/skillsmith/releases/tag/v0.1.0
