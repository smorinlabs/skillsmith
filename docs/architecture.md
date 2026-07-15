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
      status/        correlated desired/lock/ledger/live read model
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

`runStatusApplication` is the current correlated-read service. It validates target/tool/scope
selection before I/O, resolves shared project/configuration context, selects one readable artifact
context, and invokes the shared portable-pair resolver exactly once. The domain reader receives only
the projected immutable paths, selection provenance, and focused read capabilities. The application
then maps the report field by field to `status@1`, recursively redacts it, and reparses it through the
strict codec before either human or JSON presentation.

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

`defaultRuntimePorts()` owns the general-purpose production Node/Bun effects. Two focused artifact
adapters own only account identity, private filesystem durability and locking, recovery records,
and cryptographic transaction IDs behind `ArtifactCoordinatorPorts`; they do not expose Git, HTTP,
raw environment, or arbitrary process authority. Raw environment input is decoded once into
`ResolvedRuntimeConfiguration`; domain and application requests do not carry `process.env` or an
unfiltered record. Real adapter failures are scalar-only `PortError` values that public coordinators
translate to the existing result error contract.

Status uses `StatusReadPorts`, the intersection of inventory reads and file-metadata reads. It has
no write, lock, process, Git, HTTP, clock, or ID authority. Live roots are observed only after
tool/scope/project selection, and retained-resource checks remain secondary read evidence rather
than recovery or mutation. This keeps `status` useful for partial manifest/lock/ledger/live products
without exposing the artifact coordinator or journal recovery machinery.

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
`config-list@1`, `config-set@1`, `config-unset@1`, `flip@2`, `install@1`, `list@2`, `uninstall@1`,
`verify@1`, `status@1`, `error@1`, and
`capability-snapshot@1`. Each descriptor fixes recursive unknown-field rejection, embedded kind and
version policy, JSON indentation, terminal framing, and conservative compatibility. Current codecs
declare no migrations. The `verify` codec derives tool choices from the validated tool registry;
the capability snapshot projects only descriptor facts and is not yet a final command output.

Consumers import shared types and the builder from `@skillsmith/core/contracts`, V1 DTOs/codecs from
`@skillsmith/core/contracts/v1`, and V2 DTOs/codecs from `@skillsmith/core/contracts/v2`. See
[ADR 0008](adr/0008-wire-contract-registry.md) for compatibility and ownership rules.

## Persisted artifact contracts

Durable manifests, locks, saved plans, ledgers, and journals use `ArtifactCodec`, a byte-oriented
contract separate from the CLI JSON `WireCodec` above. The single immutable
`artifactContractRegistry` contains six codecs in this order: `manifest@1`, `lock@1`, `plan@1`,
`ledger@1`, `ledger@2`, and `journal@1`. The two ledger versions coexist so existing v1 state can
be read without weakening the canonical v2 contract.

Concrete codecs, DTO types, and explicit mappers live only in the versioned
`@skillsmith/core/contracts/v1` and `@skillsmith/core/contracts/v2` entry points. The unversioned
contracts entry point exposes shared `ArtifactCodec` types alongside the existing wire-contract
types. The ordinary core root exposes `artifactContractRegistry` and the five domain readers—not
the concrete codecs and not a migration executor. Registry and repository code resolve codecs
through the one artifact registry; public barrels and the legacy placement facade do not parse or
serialize the formats again.

`readManifestArtifact`, `readLockArtifact`, `readSavedPlanArtifact`, `readLedgerArtifact`, and
`readJournalArtifact` form a read-only repository over injected `pathKind` and `readBytes`
capabilities. Reads return an absent state or a frozen envelope with source/current version,
canonicality, byte revision, semantic revision where defined, and normalized model. They acquire no
lock and never mutate the filesystem. Legacy project configuration produces a pure manifest-v1
migration description. Ledger v1 produces a pure v1-to-v2 description containing exact source and
target revisions, canonical v2 source, and preserved pair-journal identities. Neither description
is executable write authority.

Compatibility remains explicit. Ledger v1 encoding is available for existing callers, while v2 is
the current canonical generated form. The mutable legacy placement facade accepts and writes only
closed v1 state and refuses v2 before clock, ID, temporary-file, lock, or write activity; it cannot
silently downgrade the ledger. Canonical codecs reject noncanonical generated forms, and every
artifact boundary rejects recursive unknown fields, hostile inputs, and sensitive content with
fixed sanitized errors rather than persisting redaction placeholders or echoing raw values.

## Portable artifact identity

Pure artifact authority lives under `packages/core/src/artifacts/`. The human-authored manifest is
strictly normalized before semantic identity is computed. Hashing uses a frozen seven-domain v1
registry and exact `skillsmith:<domain>:v1`, NUL, canonical-input framing so identical bytes in
different domains never share an identity contract.

The portable lock is an immutable v1 model with one canonical generated TOML spelling. Its reader
uses fatal UTF-8, version-first schema discrimination, strict fields, explicit-host source
identities, and parse-normalize-reserialize byte equality. Correlation with a normalized manifest
is a pure frozen `missing-lock | incomplete | stale | current` state; no local placement or store
path enters the lock.

Source-content v1 projects injected filesystem reads into schema-ordered JSON: NFC relative POSIX
paths sorted by UTF-8 bytes, preserved empty directories, exact file bytes and executable facts,
and safe literal internal symlink targets. Symlinks are never followed. Exactly `.git` is excluded;
special nodes, unsafe paths/targets, normalization collisions, and observable metadata/list/byte/
target races refuse.

The identity modules do not write files or resolve Git refs. Human-artifact mutation is a separate
authority in the same directory: a bounded lexical TOML scanner preserves every untouched byte,
the manifest editor verifies the exact semantic delta through the strict reader, and the pair
coordinator installs only copied, verified manifest bytes and canonical lock bytes. Coordination
uses a focused `ArtifactCoordinatorPorts` capability instead of widening `RuntimePorts`.

Pure init input planning is also artifact-local. `planInitManifest` accepts only an already-resolved
skeleton and an absent/present owned byte snapshot. It constructs one canonical declaration-empty
manifest, classifies existing bytes with future-schema and force precedence, and returns a frozen,
path-free create/replace/migrate/noop input or fixed refusal. Before images expose only exact and
semantic hashes plus shape. The range-based legacy conversion is a single internal leaf reused by
init planning, manifest edits, and project-config edits, so comments, line endings, quote class, and
semantic identity follow one rule. Destination discovery, CLI policy, locking, persistence, and
execution remain later application/planner responsibilities.

Pair writes take an account-stable global lock and the complete sorted set of compatibility target
locks, reobserve file and parent identities at the last responsible moment, and use exclusive
transaction directories plus no-replace links. A private versioned recovery record is saved before
mutation and drives deterministic forward or rollback recovery after process death. Recovery data
contains paths, digests, modes, identities, cursors, and ownership markers—never human artifact
bytes, source arguments, errors, or credentials. The one-file config writer delegates to the same
mechanics without making its private recovery repository a public artifact codec.

Acquisition has one credential-free source boundary. Accepted transport spellings project through
the canonical source identity authority; raw input, userinfo, query, fragment, and foreign path
forms never enter `SourceSpec` or persisted origin data. One recursive safety module owns string,
URL, key, nested-object, Error, cycle, proxy, accessor, depth, and node-bound redaction. Observation,
CLI error, and acquisition presentation reuse that exact function object/policy, while persistence
boundaries reject sensitive material instead of storing redaction placeholders.

The older placement-store `contentHashOf` digest remains a separate compatibility algorithm for
existing ledger/store records; it is not silently reinterpreted as the versioned `source-content`
domain.

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
