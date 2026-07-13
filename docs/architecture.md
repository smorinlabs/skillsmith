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
      ports/         focused capabilities, safe adapter errors, real adapter composition
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
      commands/      compatibility re-exports for the former command-module paths
      completion/    shell completion renderers
      contracts/     reviewed command/option surface snapshots
      output/        pure human renderers and typed wire-codec adapters
      help/          topic-based help text
      util/          color-mode resolver, exit-code mapping, SIGINT handler
      program.ts     Commander registration and global policy
      index.ts       process entry, signal handling, and final exit mapping
```

The historical “no I/O side effects” shorthand is corrected by the boundary below.

## Core / CLI split

> P17 disposition: current behavior; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#9-shared-application-and-planning-architecture.

The defining rule of the codebase: `@skillsmith/core` is an **embeddable library with zero CLI dependencies**. Core domain logic receives filesystem, process, clock, and observation capabilities through injected ports; it does not directly print, exit, prompt, or own CLI policy.

| Concern | `@skillsmith/core` | `skillsmith` CLI |
|---|---|---|
| Domain logic (registry, detection, result types) | ✅ | ❌ |
| `commander`, `chalk`, `consola`, `@clack/prompts` | ❌ (forbidden) | ✅ |
| `process.exit`, `console.*` | ❌ (forbidden) | ✅ |
| Output formatting (human presentation) | ❌ | ✅ |
| Versioned public JSON wire codecs | ✅ | selects codecs |
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

`CurrentApplicationContext` is retained as a compatibility alias for the capability-scoped
`ApplicationContext`: current services compose with `RuntimePorts`, resolved typed configuration,
project context, interaction, and signal. The first service, `runVersionApplication`, is a
zero-discovery canary and does not read environment, cwd, project, or config state. The current
parser graph is reconstructed from `CommandSpec`; one action factory resolves every current command
through the public application registry and shared renderer/exit adapter. Legacy command-local
runtime handlers have been removed.

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

## Capability-scoped ports and the `ScanEnv` compatibility facade

ADR 0005 replaces aggregate authority with focused ports. Domain operations receive only the
structural intersection they use: platform paths and reads for inventory, a high-level writable-path
probe for diagnostics, version probing for detection, named Git/HTTP operations where required, and
explicit write/lock/clock/ID capabilities for mutation. `RuntimePorts` exists only at real-adapter
and application composition boundaries.

`defaultRuntimePorts()` owns the production Node/Bun effects. Raw environment input is decoded once
into `ResolvedRuntimeConfiguration`; domain and application requests do not carry `process.env` or
an unfiltered record. Real adapter failures are scalar-only `PortError` values that public
coordinators translate to the existing result error contract.

The focused read shape illustrates the authority boundary (the source of truth is
`packages/core/src/ports/types.ts`):

```ts
type InventoryReadPorts = PlatformPaths & FileReadPort;

interface FileReadPort {
  fileExists(p: string): Promise<boolean>;
  pathKind(p: string): Promise<PathKind>;
  realpath(p: string): Promise<string>;
  listDir(p: string): Promise<readonly string[]>;
  readText(p: string): Promise<string>;
  // Byte, link, executable, and timestamp reads complete the interface.
}
```

The deprecated public `ScanEnv` and `defaultScanEnv()` remain a 1.x compatibility facade projected
from the same real adapter path. They gain no Git, HTTP, clock, or ID members and are not precedent
for new domain signatures.

Typed operation observation is the production diagnostic path. `OperationContext` supplies stable
identity and injected timing, while a best-effort registry-bound emitter produces closed frozen
events without influencing results or state. The CLI owns redaction-aware verbosity and stderr IO.
The `Logger` interface in `env/logger.ts` remains only as a deprecated 1.x compatibility facade for
existing scan callers; new domain/application code uses the atomic observation bundle instead.

## Tool-adapter registry and detection pipeline

The validated `ToolRegistry` is the executable authority for tool identity, order, operation and
scope capabilities, verifier availability, and mutation eligibility. Each `ToolAdapter` combines
an immutable descriptor with a required inventory bundle and optional verification, placement, and
adaptation bundles. The public `Agent`, `registry`, `SUPPORTED_TOOLS`, `VERIFY_TOOLS`, and
`FLIP_TOOLS` surfaces remain derived 1.x compatibility projections.

```
┌────────────────────────┐
│ toolRegistry (agents/) │   capability() / get() / toolsFor()
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

Currently supported tools: **Claude Code, Codex, Kilo Code, opencode**. All four support inventory
and diagnostics; Claude Code and Codex additionally own verification and placement bundles. See
[ADR 0007](adr/0007-tool-adapter-registry.md) for the exact operation/scope matrix and validation
rules.

## Versioned wire contracts

Accepted CLI JSON is owned by strict codecs under `@skillsmith/core/contracts`, while the CLI owns
the mapping from its JSON-capable command paths to those codecs. The generic registry validates and
freezes supplied codecs and mappings without importing CLI command policy. Domain reports cross the
boundary through explicit named mappers; renderer code does not spread domain objects, strip fields,
or define a second public schema.

The current registry contains `agents@1`, `health@1`, `commands@1`, `config-get@1`,
`config-list@1`, `flip@2`, `install@1`, `list@2`, `uninstall@1`, `verify@1`, `error@1`, and
`capability-snapshot@1`. Each descriptor fixes recursive unknown-field rejection, embedded kind and
version policy, JSON indentation, terminal framing, and conservative compatibility. Current codecs
declare no migrations. The `verify` codec derives tool choices from the validated tool registry;
the capability snapshot projects only descriptor facts and is not yet a final command output.

Consumers import shared types and the builder from `@skillsmith/core/contracts`, V1 DTOs/codecs from
`@skillsmith/core/contracts/v1`, and V2 DTOs/codecs from `@skillsmith/core/contracts/v2`. See
[ADR 0008](adr/0008-wire-contract-registry.md) for compatibility and ownership rules.

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
- [ADR 0005 — Capability-scoped ports](adr/0005-capability-scoped-ports.md)
- [ADR 0007 — Validated tool-adapter registry](adr/0007-tool-adapter-registry.md)
- [Release process](releases.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
