# @skillsmith/core

Pure TypeScript library that powers the [Skillsmith](../../README.md) CLI. Handles agent registry, tool detection, and result/error types. Has zero CLI dependencies and no side effects — safe to embed in other tools.

## Install

This package is part of the `skillsmith` workspace and is consumed via `"@skillsmith/core": "workspace:*"`. It is not (yet) published to npm.

## Public API

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

`@skillsmith/core` is a **pure library**. The following are lint-time errors:

- Importing `commander`, `chalk`, `consola`, `@clack/prompts`, or `node:console`.
- Calling `process.exit(...)` or `console.{log,info,warn,error,debug}(...)`.

Core functions return `Result<T, SkillSmithError>` — the CLI (or any other embedder) is responsible for deciding how to present errors and which exit code to use.

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full boundary rules.

## License

[Apache-2.0](../../LICENSE).
