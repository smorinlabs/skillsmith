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

  // Version
  VERSION,
} from '@skillsmith/core';

import type {
  Agent,
  DetectOptions,
  InstallMethod,
  InstallRecord,
  Logger,
  Platform,
  Result,
  ScanEnv,
  SkillSmithError,
  SupportedTool,
  XdgDirs,
} from '@skillsmith/core';
```

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
