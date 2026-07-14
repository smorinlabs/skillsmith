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

  // Portable artifact identity
  HASH_DOMAINS,
  correlatePortableLock,
  hashCanonicalInput,
  hashManifestSemantics,
  hashSourceContentV1,
  projectSourceContent,
  readPortableLockSource,
  serializePortableLock,

  // Version
  VERSION,
} from '@skillsmith/core';

import type {
  Agent,
  DetectOptions,
  InstallMethod,
  InstallRecord,
  Logger,
  PortableLockRelationship,
  PortableLockV1,
  Platform,
  Result,
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

Human artifact writes preserve that pure identity boundary. A bounded lossless TOML editor verifies
its semantic delta through the strict manifest reader; an injected, focused artifact coordinator
then commits manifest/lock pairs with last-moment identity guards, no-replace staging, compatible
target locks, and private durable forward/rollback recovery. The coordinator does not receive Git,
HTTP, process, placement, store, ledger, or general runtime authority. Config saving uses the same
one-file mechanics while retaining its existing public operation.

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

Versioned wire contracts use dedicated entry points so DTO authority does not mix with domain and
1.x compatibility exports:

```ts
import { createWireContractRegistry } from '@skillsmith/core/contracts';
import { agentsV1Codec, toAgentsV1Dto } from '@skillsmith/core/contracts/v1';
import { flipV2Codec, toFlipV2Dto } from '@skillsmith/core/contracts/v2';
```

The current codec IDs are `agents`, `health`, `commands`, `config-get`, `config-list`, `config-set`,
`config-unset`, `flip`,
`install`, `list`, `uninstall`, `verify`, `error`, and `capability-snapshot`. Codecs recursively
reject unknown object fields, validate before encoding, preserve their declared JSON framing, and
return sanitized `Result` errors rather than throwing for untrusted input. Explicit `to*Dto`
mappers keep domain-only fields out of public wire shapes. See
[ADR 0008](../../docs/adr/0008-wire-contract-registry.md).

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
