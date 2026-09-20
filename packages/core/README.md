# @skillsmith/core

> P17 disposition: current behavior; authority: docs/architecture.md#core-cli-split

Embeddable TypeScript library that powers the [Skillsmith](../../README.md) CLI. It handles agent registry, tool detection, skill lifecycle operations, and result/error types. It has zero CLI dependencies; domain logic receives I/O capabilities through injected ports so embedders control process and presentation policy.

## Install

This package is part of the `skillsmith` workspace and is consumed via `"@skillsmith/core": "workspace:*"`. It is not (yet) published to npm.

## Public API

Representative imports from the current public entry point include:

```ts
import {
  // Agent registry
  getAgent,
  listSupportedTools,
  registry,

  // Detection
  detectAll,
  detectTool,

  // Environment
  defaultScanEnv,
  noopLogger,

  // Errors
  genericError,
  unknownToolError,

  // Result helpers
  err, isErr, isOk, map, mapErr, ok,

  // Remote catalog search (read-only)
  createSkillsShProvider,
  defaultSearchPorts,
  runSearchApplication,

  // Portable artifact identity
  HASH_DOMAINS,
  correlatePortableLock,
  hashCanonicalInput,
  hashManifestSemantics,
  hashSourceContentV1,
  INIT_MANIFEST_OPERATION_KINDS,
  planInitManifest,
  prepareInitOperationPlan,
  runInitApplication,
  projectSourceContent,
  readPortableLockSource,
  readStatus,
  runStatusApplication,
  selectReadableArtifactContext,
  serializePortableLock,

  // Version
  VERSION,
} from '@skillsmith/core';

import type {
  Agent,
  DetectOptions,
  InstallMethod,
  InstallRecord,
  InitManifestOperationInput,
  InitManifestRequest,
  InitManifestRefusal,
  InitReport,
  InitRequest,
  Logger,
  PortableLockRelationship,
  PortableLockV1,
  Platform,
  ReadableArtifactContext,
  Result,
  SearchRequest,
  SearchReport,
  SearchApplicationContext,
  StatusReadPorts,
  StatusReadRequest,
  StatusReport,
  ScanEnv,
  SkillSmithError,
  SourceContentProjectionV1,
  SourceContentReadPort,
  SupportedTool,
  XdgDirs,
} from '@skillsmith/core';
```

Portable artifact identity is pure and versioned. Hash inputs use the closed v1 domains and exact
domain-separated SHA-256 framing. Manifest semantic hashes consume the normalized manifest
projection, portable locks accept only their one canonical TOML byte form, and source-content
hashes consume a schema-ordered portable tree projection over injected read capabilities. Lock and
source errors are fixed, secret-safe `Result` values. The source projector never follows symlinks
and excludes exactly `.git`; it performs no write or acquisition.

The older placement-store `contentHashOf` digest remains an internal compatibility algorithm for
existing ledger/store records. It is intentionally independent from the public versioned
`source-content` hash until a version-aware migration owns that transition.

Correlated status reads remain non-mutating at every layer. `selectReadableArtifactContext` chooses
one explicit, project, or user portable-artifact context—or a live-only system/managed context—
without reading artifact contents. `readStatus` consumes injected read capabilities and returns the
immutable desired/locked/ledger/live product. `runStatusApplication` validates command selection,
resolves the shared project context, and returns the redacted `status@1` report with `NO_MUTATION`.

Human artifact writes preserve that pure identity boundary. A bounded lossless TOML editor verifies
its semantic delta through the strict manifest reader; an injected, focused artifact coordinator
then commits manifest/lock pairs with last-moment identity guards, no-replace staging, compatible
target locks, and private durable forward/rollback recovery. The coordinator does not receive Git,
HTTP, process, placement, store, ledger, or general runtime authority. Config saving uses the same
one-file mechanics while retaining its existing public operation.

`planInitManifest` is the pure input beneath init orchestration. It validates an
already-resolved skeleton request plus an absent/present manifest snapshot and returns one frozen,
path-free `create-manifest | replace-manifest | migrate-project-config | noop` input or a fixed
refusal. Canonical declaration-empty bytes and their byte/semantic hashes are constructed together;
before images contain hashes and shape only, never raw source bytes. Legacy project conversion is
one internal range-preserving authority shared by init, manifest editing, and project-config edits.
The `runInitApplication` service resolves the selected project/XDG/explicit destination and bounded
writable-tool defaults, projects the pure result through `prepareInitOperationPlan`, and executes
the single manifest operation through the shared scheduler and artifact coordinator. Init never
writes the sibling lock, live roots, store, or ledger. Force authorizes only exact replacement of
the selected manifest; future state remains a refusal. The pure API itself still performs no
discovery, locking, or persistence.

Remote acquisition exposes only canonical, credential-free source DTOs. Literal arguments,
userinfo, query strings, fragments, and local/foreign path spellings are rejected before transport
or persistence. `containsSensitiveMaterial`, `redactSensitiveString`, and
`redactSensitiveValue` form one shared policy; the observation compatibility export is the same
function object. Presentation boundaries redact recursively, while persistence boundaries refuse
sensitive values rather than writing `[REDACTED]` into domain artifacts.

Operation-scoped observation uses immutable contexts, a closed typed event registry, failure-isolated
observers, and bounded recursive redaction. Core emits no diagnostics directly; CLI or embedding
adapters own presentation, and events are never state or error authority. The exported `Logger`
surface remains a deprecated compatibility facade for existing 1.x callers.

Remote search uses the anonymous skills.sh catalog through `createSkillsShProvider`. Its injected
`SearchPorts` contain only bounded HTTP reads, a monotonic/epoch clock, and scheduling.
`defaultSearchPorts()` composes those real adapters without filesystem, process, or installation
authority. `runSearchApplication` validates arguments and returns `NO_MUTATION`; the CLI supplies
the optional `SearchInteractionPort`. Each query shares one deadline across at most two attempts.
The HTTP adapter counts decoded bytes before retaining chunks and cancels unused response bodies.
Provider records become owned `SearchReport` values with preserved order, fixed-origin catalog
URLs, and explicit `not-checked` verification. This experimental endpoint has no verified public
stability contract. Search records do not specify an installation command or selector.

Versioned wire contracts use dedicated entry points so DTO authority does not mix with domain and
1.x compatibility exports:

```ts
import { createWireContractRegistry } from '@skillsmith/core/contracts';
import {
  agentsV1Codec,
  gcV1Codec,
  initV1Codec,
  statusV1Codec,
  searchV1Codec,
  type SearchV1Dto,
  toSearchV1Dto,
  type InitV1Dto,
  type StatusV1Dto,
  toAgentsV1Dto,
  toInitV1Dto,
  toStatusV1Dto,
} from '@skillsmith/core/contracts/v1';
import {
  agentsV2Codec,
  commandsV2Codec,
  flipV2Codec,
  toAgentsV2Dto,
  toCommandsV2Dto,
  toFlipV2Dto,
} from '@skillsmith/core/contracts/v2';
import { listV3Codec, toListV3Dto } from '@skillsmith/core/contracts/v3';
```

The current codec IDs are `agents`, `health`, `commands`, `config-get`, `config-list`, `config-set`,
`config-unset`, `flip`, `init`, `install`, `list`, `search`, `status`, `gc`, `uninstall`, `verify`, `error`, and
`capability-snapshot`. Codecs recursively reject unknown object fields, validate before encoding,
preserve their declared JSON framing, and return sanitized `Result` errors rather than throwing for
untrusted input. Explicit `to*Dto` mappers keep domain-only fields out of public wire shapes. See
[ADR 0008](../../docs/adr/0008-wire-contract-registry.md).

Current inventory output uses `agents@2`, `commands@2`, and `list@3`. Their mappers own canonical
registry/scope/name/path ordering, recursively redact public string fields, and preserve complete
machine output independently of human verbosity. Historical `agents@1`, `commands@1`, and
`list@2` codecs remain available from their original versioned entry points.

The GC domain inventories only the configured store and derives exact path-plus-hash protection
from ledger and recovery authority. `runGcApplication` exposes read-only planning, strict age and
missing-project forget policy, exact approval, canonical ledger migration, owner-only `gc@1`
reports, and private recovery/tombstone repositories. Unsafe layout, links, ownership, recovery,
or concurrent state refuses the complete invocation rather than widening deletion authority.

## Persisted artifact contracts

Persisted files use a separate, byte-oriented `ArtifactCodec` contract. The existing `WireCodec`
registry above remains the authority for signed command output; the frozen
`artifactContractRegistry` is the single persisted-artifact registry and orders exactly
`manifest@1`, `lock@1`, `plan@1`, `ledger@1`, `ledger@2`, and `journal@1`.

```ts
import {
  artifactContractRegistry,
  planProjectConfigMigration,
  readJournalArtifact,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
  readSavedPlanArtifact,
} from '@skillsmith/core';
import type { ArtifactCodec, ArtifactCodecError } from '@skillsmith/core/contracts';
import {
  journalV1Codec,
  ledgerV1Codec,
  lockV1Codec,
  manifestV1Codec,
  savedPlanV1Codec,
} from '@skillsmith/core/contracts/v1';
import {
  ledgerV2Codec,
  migrateLedgerV1DtoToV2Dto,
} from '@skillsmith/core/contracts/v2';
```

The versioned subpaths also export their DTO types and `to*Dto`/`from*Dto` mappers. Their runtime
codecs are the same objects held by `artifactContractRegistry`; they do not construct another
registry. The artifact repository exposes five injected, read-only functions for manifests,
locks, saved plans, ledgers, and journals. Reads never write, lock, retry, or execute a migration.
Legacy project configurations read as manifest v1 and ledger v1 files read as ledger v2; both
return descriptive migration metadata, including source and target revisions.
`planProjectConfigMigration` is likewise a pure planner; there is no migration executor in the
root package API.

Parsing and serialization remain codec-owned. The repository resolves codecs through
`artifactContractRegistry`, while versioned exports and the legacy placement facade delegate to
those same codec objects instead of maintaining alternate parsers or serializers. Compatibility
formats retain their declared presentation rules, including the historical no-final-newline
`ledger@1` encoding. The legacy placement writer refuses ledger v2 and future versions before any
write, preventing an implicit downgrade.

Artifact boundaries defensively own and validate untrusted bytes and values, reject unknown or
inconsistent shapes, and return deeply immutable results. Recursive sensitive content is refused
rather than persisted or replaced with redaction text; fixed errors do not echo source values,
raw bytes, operating-system messages, or thrown causes.

## Design rules

`@skillsmith/core` is an **embeddable, non-interactive library**. Its real default adapters perform
filesystem and process I/O, while domain operations accept injected capabilities. The following are
lint-time errors:

- Importing `commander`, `chalk`, `consola`, `@clack/prompts`, or `node:console`.
- Calling `process.exit(...)` or `console.{log,info,warn,error,debug}(...)`.

Core functions return `Result<T, SkillSmithError>` — the CLI (or any other embedder) is responsible for deciding how to present errors and which exit code to use.

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full boundary rules.

## License

[Apache-2.0](../../LICENSE).
