# Architecture

This page explains the shape of the Skillsmith codebase so new contributors can orient quickly. It covers decisions that aren't obvious from reading the source — what each layer is for, which directions dependencies are allowed to flow, and how the pieces fit together at runtime.

For deeper rationale on individual decisions, see the [ADRs](adr/).

## Workspace layout

Skillsmith is a Bun workspace with two packages:

```
packages/
  core/          @skillsmith/core — embeddable, non-interactive library
    src/
      acquire/       install/uninstall orchestration
      application/   public CommandOutcome and application-service boundary
      agents/        per-tool adapters (claude-code, codex, kilo-code, opencode) + registry
      commands/      installed slash-command domain types
      config/        config discovery, parsing, precedence, and persistence
      context/       project-context resolution
      detect/        path scanners, install-method classification, detect-types
      doctor/        diagnostic checks and execution
      env/           ScanEnv, platform/XDG resolution, logger, subprocess exec
      place/         dev/promote placement transactions
      scan/          orchestrator: detectAll / detectTool
      selection/     shared tool/scope/target validation
      skills/        installed-skill parsing and domain types
      verify/        static/deep verification orchestration
      errors.ts      SkillSmithError tagged union
      result.ts      Result<T, E> helpers (ok/err/isOk/isErr/map/mapErr)
      public-types.ts  single module re-exported by index.ts
      index.ts       public API surface
  cli/           skillsmith — the CLI
    src/
      commands/      current inventory, diagnostics, config, verify, and lifecycle handlers
      completion/    shell completion renderers
      contracts/     reviewed command/option surface snapshots
      output/        pure renderers (markdown, JSON with zod schema)
      help/          topic-based help text
      util/          color-mode resolver, exit-code mapping, SIGINT handler
      program.ts     Commander registration and global policy
      index.ts       process entry, signal handling, and final exit mapping
```

## Core / CLI split

> P17 disposition: current behavior; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#9-shared-application-and-planning-architecture. This replaces the imprecise “no I/O side effects” shorthand.

The defining rule of the codebase: `@skillsmith/core` is an **embeddable library with zero CLI dependencies**. Core domain logic receives filesystem, process, clock, and observation capabilities through injected ports; it does not directly print, exit, prompt, or own CLI policy.

| Concern | `@skillsmith/core` | `skillsmith` CLI |
|---|---|---|
| Domain logic (registry, detection, result types) | ✅ | ❌ |
| `commander`, `chalk`, `consola`, `@clack/prompts` | ❌ (forbidden) | ✅ |
| `process.exit`, `console.*` | ❌ (forbidden) | ✅ |
| Output formatting (markdown, JSON) | ❌ | ✅ |
| Exit-code policy | ❌ | ✅ |
| Subprocess execution via `env.exec` | ✅ (abstracted) | via core |

This boundary is enforced at **lint time** via `eslint.config.js`:
- `no-restricted-imports` bans CLI-only libs and `node:console` in `packages/core/src/**`.
- `no-restricted-syntax` bans `process.exit` and `console.{log,info,warn,error,debug}` in `packages/core/src/**`.
- `import/no-restricted-paths` restricts cross-package and in-package import directions.

See [ADR 0001](adr/0001-core-cli-split.md) for the rationale and [ADR 0003](adr/0003-eslint-import-boundaries.md) for the full zone list.

## Application-service foundation

[ADR 0004](adr/0004-command-runtime-application-boundary.md) adds the public semantic boundary used
to migrate command-local orchestration without weakening the Core/CLI split:

```text
CommandSpec -> shared CLI runtime -> core application service -> CommandOutcome<Report>
```

`CommandOutcome` carries a report, structured diagnostics, semantic exit class, mutation summary,
and deprecations. Core does not assign numeric process exits. `InteractionPort` keeps semantic choice
and confirmation injectable while TTY, JSON, approval, and noninteractive policy remain CLI-owned.

`CurrentApplicationContext` is deliberately transitional: G1-03 may compose current services with
the existing `ScanEnv` facade, resolved project context/config, interaction, and signal. G1-04 owns
the replacement with capability-scoped ports. The first service, `runVersionApplication`, is a
zero-discovery canary and does not read environment, cwd, project, or config state. Existing command
handlers migrate in later G1-03 slices; the presence of this foundation does not imply that migration
is already complete.

## Result-based error handling

Every fallible function in core returns `Result<T, SkillSmithError>`:

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

Core never throws (for expected failure modes) and never chooses an exit code. Errors are tagged — `SkillSmithError` is a discriminated union on `code` — and the CLI maps each code to an exit code in `packages/cli/src/util/exit-codes.ts`.

This means:
- Library embedders get programmatic, exhaustive error handling via `switch (err.code)`.
- The CLI owns presentation and exit policy without library code needing to know about it.
- Cancellation flows through `AbortSignal`, passed into `detectAll` / `detectTool` and forwarded to each agent's `detect` and to `runVersion`. On SIGINT the CLI aborts in-flight work and exits 130 (see `packages/cli/src/util/signals.ts`).

Details and alternatives considered: [ADR 0002](adr/0002-result-type.md).

## `ScanEnv` — explicit capabilities and real adapters

Domain operations receive filesystem and process capabilities through `ScanEnv`, which keeps those
operations deterministic under tests. The production `defaultScanEnv()` adapter intentionally reads
the host environment, home directory, platform, and XDG locations and supplies real filesystem,
locking, and subprocess implementations. Config composition likewise reads environment variables at
its production boundary.

The interface includes both read and write capabilities; this excerpt shows its shape rather than an
exhaustive declaration (the source of truth is `packages/core/src/env/types.ts`):

```ts
interface ScanEnv {
  platform: Platform;                 // 'darwin' | 'linux' | 'win32'
  homeDir: string;
  xdg: XdgDirs;                       // config / data / cache
  path: readonly string[];            // PATH split with platform delimiter
  fileExists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  listDir(p: string): Promise<readonly string[]>;
  readText(p: string): Promise<string>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  // Additional byte, path-kind, write, rename, lock, and timestamp capabilities.
}
```

The CLI builds a real one via `defaultScanEnv()`; tests inject fakes. This is what makes the detection pipeline unit-testable without mocking `node:fs` or `node:child_process`.

A separate `Logger` interface lives in `env/logger.ts` and is passed through `DetectOptions` (not `ScanEnv`), so callers that don't want logging can omit it entirely.

## Agent registry and detection pipeline

An `Agent` is the core abstraction for "an AI coding tool that Skillsmith knows how to manage":

```
┌────────────────────────┐
│  registry (agents/)    │   getAgent(name) / listSupportedTools()
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  detectAll / detectTool│   scan/ — orchestrator; forwards AbortSignal
│     (scan/)            │
└──────────┬─────────────┘
           │ per-agent
           ▼
┌────────────────────────┐
│  agent.detect(env)     │   each agent (claude-code, codex, …) returns
│                        │     Result<InstallRecord[], SkillSmithError>
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│  scanners (detect/)    │   findOnPath, classifyInstallMethod (brew,
│                        │     npm-global, bun-global, native-installer, …)
└────────────────────────┘
```

Currently supported tools: **Claude Code, Codex, Kilo Code, opencode** (four agents, one file each under `packages/core/src/agents/`).

## In-package layering

Within each package, `import/no-restricted-paths` zones enforce one-way dependencies:

**CLI (`packages/cli/src/`):**
- `commands/` may import everything.
- `output/`, `help/`, `util/` are leaves — they must **not** import from `commands/` or from the CLI's `index.ts`.

**Core (`packages/core/src/`):**
- `env/` is the lowest layer — must not import `agents/` or `detect/`.
- `detect/` must not import `agents/`.
- `agents/`, `scan/` depend on the layers below.

If you find yourself fighting these rules, that's usually a signal to move code, not to relax a zone. If the direction genuinely needs to change, update `eslint.config.js` in the same PR and record the decision as an ADR.

## Runtime flow (the `agents` command)

1. `cli/src/index.ts` installs the SIGINT handler, builds the program, and asks Commander to parse
   `skillsmith agents [opts]`.
2. `cli/src/program.ts` validates CLI selection, builds a `ScanEnv` with `defaultScanEnv()`, and
   passes it to `runAgents`.
3. `cli/src/commands/agents.ts` validates the programmatic input and calls
   `detectAll(env, { tools, signal })`.
4. `core/src/scan/` — orchestrator iterates `listSupportedTools()` (or the filter), delegates to each `Agent.detect(env)`.
5. Each agent — runs platform-specific scanners (well-known bin dirs, `runVersion`), returns `Result<InstallRecord[], SkillSmithError>`.
6. Back in the CLI — `output/agents-markdown.ts` or `output/agents-json.ts` renders the inventory; `util/exit-codes.ts` maps any error codes to exit codes.

## Where things live

| If you need to change... | Look in... |
|---|---|
| How a tool is detected | `packages/core/src/agents/<tool>/` |
| New install-method classification | `packages/core/src/detect/scanners.ts` + `detect/types.ts` |
| Platform-specific env resolution | `packages/core/src/env/default.ts` |
| A new core error code | `packages/core/src/errors.ts` + CLI `util/exit-codes.ts` |
| CLI output format | `packages/cli/src/output/` |
| CLI help text | `packages/cli/src/help/topics.ts` |
| A public command use case or outcome type | `packages/core/src/application/` |
| Enforced architectural rules | `eslint.config.js` (and a new ADR) |

## Further reading

- [ADR 0001 — core / CLI split](adr/0001-core-cli-split.md)
- [ADR 0002 — Result-over-exceptions](adr/0002-result-type.md)
- [ADR 0003 — ESLint import boundaries](adr/0003-eslint-import-boundaries.md)
- [ADR 0004 — Command runtime and application services](adr/0004-command-runtime-application-boundary.md)
- [Release process](releases.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
