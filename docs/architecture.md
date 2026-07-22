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
      sync/          bounded endpoint observation and shared-plan projection
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

`runInitApplication` is the bounded manifest bootstrap service. It validates writable-tool and
scope selection before context reads, resolves exactly one Git-root, XDG-user, or explicit manifest
destination, and owns one byte snapshot across effective configuration, pure classification,
planning, and execution. A create, replacement, or exact lossless legacy migration becomes one
`OperationPlan<'init'>` operation executed by the shared precondition coordinator and scheduler.
The one-member artifact coordinator retains its normal staging, fsync, rollback, and recovery
protocol; a narrow resource-digest authorization permits opaque old manifest bytes to be backed up
without relaxing candidate validation. Noop, refusal, and dry-run acquire no mutation authority.
Sibling locks, live placements, stores, and ledgers stay outside the service's write capability.

`runPlanApplication` is the read-only desired/current convergence service. It validates artifact,
scope, tool, check, and output grammar before context reads; selects one manifest/lock pair; resolves
portable source pins through injected acquisition capabilities; and projects one canonical
`OperationPlan<'plan'>`. Planning observes live placements and registered tool capabilities without
mutating the manifest, lock, ledger, live roots, store, or configuration. Human and JSON output are
views of the same strict `plan-report@1` DTO. An optional saved plan is encoded by the persisted
`plan@1` artifact codec with resource, selection, and capability preconditions, then written by a
focused owner-only create/atomic-replace writer. That isolated output write is not plan execution;
approval, staleness validation, and execution remain separate application authority.

`runApplyApplication` is the matching convergence boundary. Fresh mode consumes the same prepared
reconciliation product as `plan`; saved mode validates one exact `plan@1` authorization without
replanning. Dry-run and check remain nonmutating, while changing execution requires explicit
approval and revalidates exact preconditions under the existing coordinator locks. Human and JSON
output are views of one strict `apply-report@1` DTO rather than a second execution model.

`runSyncApplication` is the bounded live-endpoint convergence boundary. It freezes two distinct
endpoint identities, limits the destination to a writable user or project endpoint, observes
complete source and destination membership, and projects the selected pairs into the existing
placement operation algebra. Ordinary sync requests only live content evidence; `--save`
separately requires exact portable Git proof and composes the existing artifact-pair controller.
Approval is applied to the one immutable prepared plan, and execution revalidates source
membership/content plus normal destination preconditions without observing or planning again. The
source is read-only, destination removal requires the independent `--delete` authority, and
`--force` can replace only a conflicting destination already in the selection.

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

Mutation lifecycle correlation has exactly three levels: the CLI invocation is the root command
context, each actually started deterministic plan operation is its child, and each durable
transaction/recovery attempt uses the journal transaction ID with the plan operation as parent.
Application/acquisition edges emit completed plans, the scheduler owns operation spans, physical
swap and canonical writer boundaries own durable transaction stages and terminal events, and
recovery wrappers own resume/rollback/cleanup spans. These are private source-module seams: pure
planners, repositories, codecs, public reports, and wire shapes remain observation-free, and
events never replace journals or structured results as semantic authority.

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

The current registry contains `agents@1`, `agents@2`, `health@1`, `health@2`, `commands@1`,
`commands@2`, `config-get@1`, `config-list@1`, `config-set@1`, `config-unset@1`, `flip@2`,
`flip@3`, `flip@4`, `install@1`, `install@2`, `list@2`, `list@3`, `status@1`, `uninstall@1`,
`init@1`, `plan-report@1`, `apply-report@1`, `sync@1`, `uninstall@2`, `verify@1`, `error@1`, and
`capability-snapshot@1`. Each descriptor fixes recursive
unknown-field rejection, embedded kind and version policy, JSON indentation, terminal framing, and
conservative compatibility. Current codecs declare no migrations. Lifecycle v2 contracts are
registered for exact desired-state reports while the live install/uninstall command mappings remain
on v1 until their producers and renderers advance atomically. The `verify` codec derives tool
choices from the validated tool registry; the capability snapshot projects only descriptor facts
and is not yet a final command output.

Consumers import shared types and the builder from `@skillsmith/core/contracts`, and exact
DTOs/codecs from the versioned `@skillsmith/core/contracts/v1`, `/v2`, `/v3`, and `/v4` entry
points. See [ADR 0008](adr/0008-wire-contract-registry.md) for compatibility and ownership rules.

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

Saved-plan output uses a focused writer rather than the manifest/lock transaction. It creates an
owner-only stage beside the exact requested target, fsyncs the staged bytes, and publishes by
rename. Create-only mode refuses an existing target. Forced replacement first retains a bounded
same-directory backup and restores it if publication or post-publication durability fails; the
writer never scans for targets or receives authority over selected project state.

`readManifestArtifact`, `readLockArtifact`, `readSavedPlanArtifact`, `readLedgerArtifact`, and
`readJournalArtifact` form a read-only repository over injected `pathKind` and `readBytes`
capabilities. Reads return an absent state or a frozen envelope with source/current version,
canonicality, byte revision, semantic revision where defined, and normalized model. They acquire no
lock and never mutate the filesystem. Legacy project configuration produces a pure manifest-v1
migration description. Ledger v1 produces a pure v1-to-v2 description containing exact source and
target revisions, canonical v2 source, and preserved pair-journal identities. Neither description
is executable write authority.

Compatibility remains explicit. Ledger v1 encoding is available through its versioned artifact
codec, while v2 is the only current generated mutation form. The placement facade reads both
supported versions, represents mutation as an immutable `LedgerModel`, and makes v1 migration a
visible revision-checked prerequisite rather than a parser side effect. Missing state is the only
empty state; malformed, noncanonical, or future ledgers refuse without cleanup or reset. Canonical
codecs reject noncanonical generated forms, and every artifact boundary rejects recursive unknown
fields, hostile inputs, and sensitive content with fixed sanitized errors rather than persisting
redaction placeholders or echoing raw values.

Saved-plan and runtime-journal validation intentionally have different source matrices. Persisted
`plan@1` install/update operations remain portable-only. A runtime `journal@1` may retain a
machine-bound local source for sync install/update only when the after-image is an exact pinned
copy with no synthetic origin or link target and its source, staged-store, and placement hashes
agree. The journal, ledger, physical recovery format, and operation vocabulary are unchanged.

The focused ledger writer owns canonical replacement and migration durability. A private,
ledger-derived recovery pointer records the exact source, target, transaction identity, revisions,
and cursor before a v1 migration crosses a filesystem boundary. Exclusive stage/backup creation,
compare-and-replace pointer transitions, rename, and file/directory fsyncs provide deterministic
resume after interruption without scanning for or trusting arbitrary recovery paths. Current
callers share this writer; acquire, placement, and doctor do not implement weaker direct-write
paths.

Ledger-v2 mutations update pair state and derived project registrations atomically. Pending logical
transactions advance with their physical pair shadow and move exactly once into committed history.
History retention is deterministic and bounded: the newest state for every resource anchor,
pending anchors, retained resources, and the new commit are protected; remaining capacity is
selected breadth-first across anchors. Cleanup handles one verified victim at a time so a crash
cannot expose an evicted history entry whose retained resource still exists.

Doctor diagnostics remain read-capability-only. `doctor --fix` is a separate capability-scoped
planner/executor with a closed safe-repair allowlist and explicit preview/approval semantics; it
reuses the normal artifact coordinators and ledger writer instead of receiving arbitrary write
authority. Doctor emits strict `health@2`, including finding identities, repair results, and a
cross-validated mutation summary. The non-mutating `check` command remains on byte-compatible
`health@1`.

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
semantic identity follow one rule. The application layer resolves destination and defaults, then
projects the result into the shared in-memory operation algebra. Parsed canonical and legacy state
uses the normal manifest image; force-replaceable invalid state uses a runtime-only,
machine-bound `opaque-manifest` before-image carrying only shape and resource digest. That image is
excluded from saved-plan v1 and accepted only for init manifest replacement. Execution reobserves
the exact resource revision and delegates installation and recovery to the one-member artifact
coordinator without replanning or exposing old bytes.

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
2. `cli/src/program.ts` builds Commander from `CURRENT_COMMAND_SPECS`. Its shared action factory
   creates the normalized request, operation observation, and capability-scoped application
   context, including runtime ports, resolved configuration, interaction policy, and cancellation.
3. The shared CLI runtime selects the `agents` entry from `CURRENT_APPLICATION_SERVICES` and calls
   the public core `runAgentsApplication`. `cli/src/commands/agents.ts` is only a compatibility
   re-export; it does not own orchestration.
4. `runAgentsApplication` validates the requested format and tool selection before detection. It
   selects adapters in `toolRegistry` order and calls each selected adapter's
   `inventory.detect(context.ports, context.signal)` capability.
5. The application service returns an immutable `CommandOutcome<AgentsReport>` with ordered
   detections and a registry-derived capability snapshot; typed observation remains diagnostic and
   cannot change the result.
6. The shared runtime snapshots the outcome, renders Markdown through `output/agents-markdown.ts`
   or canonical `agents@2` JSON through `output/agents-json.ts`, maps the semantic exit class, and
   emits the final stdout/stderr bytes.

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
- [ADR 0006 — Immutable observed state and repositories](adr/0006-immutable-observed-state-and-repositories.md)
- [ADR 0007 — Validated tool-adapter registry](adr/0007-tool-adapter-registry.md)
- [ADR 0008 — Versioned wire codecs](adr/0008-wire-contract-registry.md)
- [ADR 0009 — Operation-scoped observation](adr/0009-operation-scoped-observation.md)
- [Release process](releases.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
