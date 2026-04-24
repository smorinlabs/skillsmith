# Architecture

This page explains the shape of the Skillsmith codebase so new contributors can orient quickly. It covers decisions that aren't obvious from reading the source — what each layer is for, which directions dependencies are allowed to flow, and how the pieces fit together at runtime.

For deeper rationale on individual decisions, see the [ADRs](adr/).

## Workspace layout

Skillsmith is a Bun workspace with two packages:

```
packages/
  core/          @skillsmith/core — pure library
    src/
      agents/        per-tool adapters (claude-code, codex, kilo-code, opencode) + registry
      detect/        path scanners, install-method classification, detect-types
      env/           ScanEnv, platform/XDG resolution, logger, subprocess exec
      scan/          orchestrator: detectAll / detectTool
      errors.ts      SkillSmithError tagged union
      result.ts      Result<T, E> helpers (ok/err/isOk/isErr/map/mapErr)
      public-types.ts  single module re-exported by index.ts
      index.ts       public API surface
  cli/           skillsmith — the CLI
    src/
      commands/      one file per command (currently: agents)
      output/        pure renderers (markdown, JSON with zod schema)
      help/          topic-based help text
      util/          color-mode resolver, exit-code mapping, SIGINT handler
      index.ts       commander entry; wires commands to core
```

## Core / CLI split

The defining rule of the codebase: `@skillsmith/core` is a **pure library with zero CLI dependencies and no I/O side effects**. It returns values; it does not print, exit, or prompt.

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

## `ScanEnv` — explicit environment, no globals

Core functions never read `process.env`, `os.homedir()`, or `process.platform` directly. They take a `ScanEnv` argument:

```ts
interface ScanEnv {
  platform: Platform;                 // 'darwin' | 'linux' | 'win32'
  homeDir: string;
  xdg: XdgDirs;                       // config / data / cache
  path: readonly string[];            // PATH split with platform delimiter
  fileExists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
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
│                        │     npm-global, bun-global, standalone, …)
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

1. `cli/src/index.ts` — commander parses `skillsmith agents [opts]`, installs the SIGINT handler, calls the command handler.
2. `cli/src/commands/agents.ts` — builds a `ScanEnv` via `defaultScanEnv()`, resolves the tool filter, calls `detectAll(env, { tools, signal })`.
3. `core/src/scan/` — orchestrator iterates `listSupportedTools()` (or the filter), delegates to each `Agent.detect(env)`.
4. Each agent — runs platform-specific scanners (well-known bin dirs, `runVersion`), returns `Result<InstallRecord[], SkillSmithError>`.
5. Back in the CLI — `output/agents-markdown.ts` or `output/agents-json.ts` renders the inventory; `util/exit-codes.ts` maps any error codes to exit codes.

## Where things live

| If you need to change... | Look in... |
|---|---|
| How a tool is detected | `packages/core/src/agents/<tool>/` |
| New install-method classification | `packages/core/src/detect/scanners.ts` + `detect/types.ts` |
| Platform-specific env resolution | `packages/core/src/env/default.ts` |
| A new core error code | `packages/core/src/errors.ts` + CLI `util/exit-codes.ts` |
| CLI output format | `packages/cli/src/output/` |
| CLI help text | `packages/cli/src/help/topics.ts` |
| Enforced architectural rules | `eslint.config.js` (and a new ADR) |

## Further reading

- [ADR 0001 — core / CLI split](adr/0001-core-cli-split.md)
- [ADR 0002 — Result-over-exceptions](adr/0002-result-type.md)
- [ADR 0003 — ESLint import boundaries](adr/0003-eslint-import-boundaries.md)
- [Release process](releases.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
