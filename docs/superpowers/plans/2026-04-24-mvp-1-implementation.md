# SkillSmith MVP-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SkillSmith `0.1.0` (internal milestone): a Bun workspace with `@skillsmith/core` (library) and `skillsmith` (CLI) that exposes `skillsmith agents`, `--version`, and `help` — including per-agent co-located modules for `claude-code`, `codex`, `kilo-code`, and `opencode`, plus the full dev toolchain (Biome, tsc, lefthook, actionlint, GitHub Actions CI).

**Architecture:** Bun workspace. `@skillsmith/core` is pure TypeScript — no `commander`, `chalk`, `consola`, `process.exit`, or `console.*` — exposing a zod-validated, Result-returning public API with injected `ScanEnv` + `Logger`. `skillsmith` CLI is a thin shell: parse args → call core → render output → translate `SkillSmithError.code` to exit code. Each supported agent lives in its own folder under `packages/core/src/agents/<tool>/` implementing a shared `Agent` interface.

**Tech Stack:** Bun ≥ 1.3.13, TypeScript strict, Biome (lint + format), `tsc -b` (typecheck), Bun test (test runner), lefthook (git hooks), actionlint (workflow lint), GitHub Actions CI. Runtime deps: `zod` (core); `commander`, `chalk`, `consola` (cli).

**Spec:** `docs/superpowers/specs/2026-04-24-mvp-1-design.md`

---

## Conventions for this plan

- All paths are repo-relative. Repo root is the current working directory throughout.
- "Run" commands assume repo root unless otherwise stated.
- Every task ends with a commit using Conventional Commits. Commit bodies are optional.
- TDD applies to code that produces behavior. Scaffolding tasks (config files) verify via "tool runs successfully" instead of unit tests.
- `bun test` auto-discovers `*.test.ts` anywhere in the workspace. Tests live alongside packages under `packages/*/tests/`.

---

## Phase A — Workspace scaffold

### Task 1: Workspace root bootstrap

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.gitattributes`

- [ ] **Step 1: Create the workspace `package.json`**

```json
{
  "name": "skillsmith-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": {
    "bun": ">=1.3.13"
  },
  "scripts": {
    "dev": "bun run packages/cli/src/index.ts",
    "test": "bun test",
    "typecheck": "tsc -b",
    "lint": "biome check",
    "fmt": "biome check --write",
    "actions-lint": "actionlint",
    "check": "bun run lint && bun run typecheck && bun run actions-lint && bun run test",
    "build": "bun build --compile --bytecode --target=bun-darwin-arm64 packages/cli/src/index.ts --outfile dist/skillsmith",
    "postinstall": "lefthook install || true"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/bun": "^1.1.14",
    "@types/node": "^22.10.0",
    "lefthook": "^1.10.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `bunfig.toml`**

```toml
[install]
exact = true

[test]
coverage = false
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
.bun-cache/
coverage/
*.tsbuildinfo
```

- [ ] **Step 4: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Create `.gitattributes`**

```
* text=auto eol=lf
*.png binary
*.jpg binary
```

- [ ] **Step 6: Install dev deps**

Run: `bun install`
Expected: completes without error; `node_modules/` populated; lefthook `postinstall` prints "Synced" or fails gracefully (no hooks defined yet → `|| true` swallows it).

- [ ] **Step 7: Commit**

```bash
git add package.json bunfig.toml .gitignore .editorconfig .gitattributes bun.lockb
git commit -m "chore: scaffold Bun workspace root"
```

---

### Task 2: Root TypeScript base config

**Files:**
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowJs": false,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Create root `tsconfig.json` for `tsc -b`**

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/cli" }
  ]
}
```

- [ ] **Step 3: Commit (root tsconfig only — package tsconfigs land with their packages)**

```bash
git add tsconfig.base.json tsconfig.json
git commit -m "chore: add root tsconfig base + workspace references"
```

---

### Task 3: Biome configuration

**Files:**
- Create: `biome.json`

- [ ] **Step 1: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "files": {
    "ignore": ["dist/**", "node_modules/**", "*.tsbuildinfo"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "always"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "style": { "useImportType": "error", "useNodejsImportProtocol": "error" },
      "correctness": { "noUnusedVariables": "error", "noUnusedImports": "error" }
    }
  }
}
```

> Note: the core/CLI import-and-global boundary (no `commander`/`chalk`/`consola`/`process.exit`/`console.*` in `packages/core/src/**`) was originally enforced by `scripts/check-core-boundary.ts` (Task 30). Post-MVP (project P02 in `PROJECTS.md`), this was ported to ESLint (`no-restricted-imports` + `no-restricted-syntax` in `eslint.config.js`), the script was deleted, and the CI/`bun run check` steps now invoke `bun run lint:boundaries` instead.

- [ ] **Step 2: Verify biome can parse its own config**

Run: `bunx @biomejs/biome check --files-ignore-unknown=true`
Expected: exits 0; lints nothing because no source files yet.

- [ ] **Step 3: Commit**

```bash
git add biome.json
git commit -m "chore: add Biome lint + format config"
```

---

### Task 4: Lefthook configuration

**Files:**
- Create: `lefthook.yml`

- [ ] **Step 1: Create `lefthook.yml`**

```yaml
pre-commit:
  parallel: true
  commands:
    biome:
      glob: "*.{ts,tsx,js,jsx,json,jsonc}"
      run: bunx @biomejs/biome check --no-errors-on-unmatched --staged {staged_files}
    typecheck:
      glob: "*.{ts,tsx}"
      run: bunx tsc -b
    actionlint:
      glob: ".github/workflows/*.{yml,yaml}"
      run: actionlint {staged_files}

pre-push:
  commands:
    test:
      run: bun test

commit-msg:
  commands:
    conventional:
      run: |
        grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+' {1} \
          || (echo "Commit message must follow Conventional Commits (type(scope)?: subject)" && exit 1)
```

- [ ] **Step 2: Install hooks**

Run: `bunx lefthook install`
Expected: prints "SYNCING" lines and installs `.git/hooks/pre-commit`, `pre-push`, `commit-msg`.

- [ ] **Step 3: Commit**

```bash
git add lefthook.yml
git commit -m "chore: add lefthook git hooks (biome, tsc, actionlint, tests, conventional commits)"
```

---

### Task 5: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Biome (CI mode)
        run: bunx @biomejs/biome ci

      - name: Typecheck
        run: bunx tsc -b

      - name: Test
        run: bun test

      - name: Install actionlint
        uses: raven-actions/actionlint@v2

      - name: Core boundary check (no CLI deps in core)
        run: bun run scripts/check-core-boundary.ts

      - name: Build binary (smoke)
        run: |
          if [ "${{ runner.os }}" = "macOS" ]; then
            TARGET=bun-darwin-arm64
          else
            TARGET=bun-linux-x64
          fi
          bun build --compile --bytecode --target=$TARGET packages/cli/src/index.ts --outfile dist/skillsmith

      - name: Binary smoke run
        run: ./dist/skillsmith agents --format json
```

- [ ] **Step 2: Lint the workflow locally**

Run: `actionlint .github/workflows/ci.yml`
Expected: no output, exit 0. If `actionlint` is not installed, install it (`brew install actionlint` on macOS) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add build + test + lint workflow for macOS and Ubuntu"
```

---

## Phase B — Core package scaffold

### Task 6: `@skillsmith/core` package bootstrap

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts` (placeholder)
- Create: `packages/core/src/version.ts`
- Create: `packages/core/tests/.keep`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@skillsmith/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["src", "README.md"],
  "dependencies": {
    "zod": "^3.23.8"
  },
  "peerDependencies": {},
  "scripts": {
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `packages/core/src/version.ts`**

```ts
// VERSION is the @skillsmith/core package version, pulled from package.json at build time.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
```

- [ ] **Step 4: Create placeholder `packages/core/src/index.ts`**

```ts
export { VERSION } from './version.js';
```

- [ ] **Step 5: Create `packages/core/tests/.keep`** (empty, reserves folder in git).

- [ ] **Step 6: Install workspace and typecheck**

Run: `bun install`
Run: `bunx tsc -b`
Expected: both succeed with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): scaffold @skillsmith/core package"
```

---

### Task 7: `Result<T, E>` helpers

**Files:**
- Create: `packages/core/src/result.ts`
- Create: `packages/core/tests/result.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/result.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { err, isErr, isOk, map, mapErr, ok } from '../src/result.ts';

describe('Result', () => {
  test('ok() wraps a value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });
  test('err() wraps an error', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });
  test('isOk / isErr narrow', () => {
    const r = ok(2);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });
  test('map transforms ok, leaves err', () => {
    expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
    expect(map(err('x'), (n: number) => n + 1)).toEqual(err('x'));
  });
  test('mapErr transforms err, leaves ok', () => {
    expect(mapErr(err('x'), (e) => `${e}!`)).toEqual(err('x!'));
    expect(mapErr(ok(2), (e: string) => `${e}!`)).toEqual(ok(2));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/tests/result.test.ts`
Expected: FAIL — module `../src/result.ts` not found.

- [ ] **Step 3: Implement `packages/core/src/result.ts`**

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));
```

- [ ] **Step 4: Verify the test passes**

Run: `bun test packages/core/tests/result.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/result.ts packages/core/tests/result.test.ts
git commit -m "feat(core): add Result<T,E> helpers"
```

---

### Task 8: `SkillSmithError` tagged union

**Files:**
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/tests/errors.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/errors.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { genericError, unknownToolError } from '../src/errors.ts';

describe('SkillSmithError', () => {
  test('genericError carries message and optional cause', () => {
    const e = genericError('boom', new Error('root'));
    expect(e.code).toBe('generic');
    expect(e.message).toBe('boom');
    expect((e.cause as Error).message).toBe('root');
  });
  test('unknownToolError carries tool name', () => {
    const e = unknownToolError('foobar');
    expect(e.code).toBe('unknown-tool');
    expect(e.tool).toBe('foobar');
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `bun test packages/core/tests/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/errors.ts`**

```ts
export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string };

export const genericError = (message: string, cause?: unknown): SkillSmithError => ({
  code: 'generic',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const unknownToolError = (tool: string): SkillSmithError => ({
  code: 'unknown-tool',
  tool,
});
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/errors.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/tests/errors.test.ts
git commit -m "feat(core): add SkillSmithError tagged union"
```

---

### Task 9: Logger interface + no-op

**Files:**
- Create: `packages/core/src/env/logger.ts`

- [ ] **Step 1: Implement `packages/core/src/env/logger.ts`** (interface + no-op; tested indirectly by callers)

```ts
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  info() {},
  warn() {},
  debug() {},
};
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/env/logger.ts
git commit -m "feat(core): add Logger interface and noopLogger"
```

---

### Task 10: `ScanEnv` types + `defaultScanEnv`

**Files:**
- Create: `packages/core/src/env/types.ts`
- Create: `packages/core/src/env/default.ts`
- Create: `packages/core/tests/env/default.test.ts`

- [ ] **Step 1: Create `packages/core/src/env/types.ts`**

```ts
export type Platform = 'darwin' | 'linux' | 'win32';

export interface XdgDirs {
  config: string;
  data: string;
  cache: string;
}

export interface ScanEnv {
  homeDir: string;
  path: readonly string[];
  platform: Platform;
  xdg: XdgDirs;
  fileExists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
}
```

- [ ] **Step 2: Write the failing test `packages/core/tests/env/default.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { defaultScanEnv } from '../../src/env/default.ts';

describe('defaultScanEnv', () => {
  test('populates homeDir, path, platform, xdg from process env', async () => {
    const env = await defaultScanEnv();
    expect(env.homeDir.length).toBeGreaterThan(0);
    expect(Array.isArray(env.path)).toBe(true);
    expect(['darwin', 'linux', 'win32']).toContain(env.platform);
    expect(env.xdg.config.length).toBeGreaterThan(0);
    expect(env.xdg.data.length).toBeGreaterThan(0);
    expect(env.xdg.cache.length).toBeGreaterThan(0);
  });

  test('fileExists returns true for this test file and false for a made-up path', async () => {
    const env = await defaultScanEnv();
    const self = new URL(import.meta.url).pathname;
    expect(await env.fileExists(self)).toBe(true);
    expect(await env.fileExists('/definitely/not/a/real/path/xyz')).toBe(false);
  });
});
```

- [ ] **Step 3: Verify it fails**

Run: `bun test packages/core/tests/env/default.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `packages/core/src/env/default.ts`**

```ts
import { existsSync } from 'node:fs';
import { realpath as fsRealpath, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import type { Platform, ScanEnv, XdgDirs } from './types.ts';

const resolvePlatform = (): Platform => {
  const p = osPlatform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
};

const resolveXdg = (home: string): XdgDirs => ({
  config: process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
  data: process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
  cache: process.env.XDG_CACHE_HOME ?? join(home, '.cache'),
});

export const defaultScanEnv = async (): Promise<ScanEnv> => {
  const home = homedir();
  const path = (process.env.PATH ?? '').split(':').filter(Boolean);
  return {
    homeDir: home,
    path,
    platform: resolvePlatform(),
    xdg: resolveXdg(home),
    fileExists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return existsSync(p);
      }
    },
    realpath: async (p) => fsRealpath(p),
    runVersion: async (_binaryPath, _args, _signal) => 'unknown',
    // ^ runVersion is overridden in Task 11; placeholder keeps the shape honest.
  };
};
```

- [ ] **Step 5: Verify test passes**

Run: `bun test packages/core/tests/env/default.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/env packages/core/tests/env
git commit -m "feat(core): add ScanEnv types and defaultScanEnv (reads-only)"
```

---

### Task 11: `runVersion` with 2s timeout

**Files:**
- Modify: `packages/core/src/env/default.ts`
- Create: `packages/core/src/detect/exec.ts`
- Create: `packages/core/tests/detect/exec.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/detect/exec.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { runVersionCommand } from '../../src/detect/exec.ts';

describe('runVersionCommand', () => {
  test("returns 'unknown' for a non-existent binary", async () => {
    const v = await runVersionCommand('/nope/definitely/not/here', ['--version']);
    expect(v).toBe('unknown');
  });

  test('returns stdout (trimmed first line) for a real tool', async () => {
    // `bun --version` is guaranteed available in CI.
    const v = await runVersionCommand(Bun.which('bun') ?? 'bun', ['--version']);
    expect(v).not.toBe('unknown');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("returns 'unknown' when the process exceeds the timeout", async () => {
    // `sleep 5` exits after 5s; timeout is 2s → should abort.
    const sleep = Bun.which('sleep');
    if (!sleep) return;
    const v = await runVersionCommand(sleep, ['5']);
    expect(v).toBe('unknown');
  }, 5000);
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/detect/exec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/detect/exec.ts`**

```ts
const DEFAULT_TIMEOUT_MS = 2000;

export const runVersionCommand = async (
  binaryPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | 'unknown'> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const proc = Bun.spawn([binaryPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });
    const exit = await proc.exited;
    if (exit !== 0) return 'unknown';
    const stdout = await new Response(proc.stdout).text();
    const first = stdout.trim().split('\n')[0]?.trim();
    return first && first.length > 0 ? first : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
};
```

- [ ] **Step 4: Wire `runVersionCommand` into `defaultScanEnv`**

In `packages/core/src/env/default.ts`, replace the `runVersion` placeholder:

```ts
import { runVersionCommand } from '../detect/exec.ts';

// inside defaultScanEnv return value, replace runVersion:
    runVersion: async (binaryPath, args, signal) =>
      runVersionCommand(binaryPath, args, signal),
```

- [ ] **Step 5: Verify all tests pass**

Run: `bun test packages/core`
Expected: all pass (result + errors + env/default + detect/exec).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/detect/exec.ts packages/core/src/env/default.ts packages/core/tests/detect/exec.test.ts
git commit -m "feat(core): add runVersionCommand with 2s abort timeout"
```

---

### Task 12: Scanner utilities

**Files:**
- Create: `packages/core/src/detect/scanners.ts`
- Create: `packages/core/tests/detect/scanners.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/detect/scanners.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { classifyInstallMethod, findOnPath, wellKnownBinDirs } from '../../src/detect/scanners.ts';

const fakeEnv = (opts: {
  home?: string;
  path?: string[];
  platform?: 'darwin' | 'linux' | 'win32';
  existing?: Set<string>;
}): ScanEnv => ({
  homeDir: opts.home ?? '/home/user',
  path: opts.path ?? [],
  platform: opts.platform ?? 'linux',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => (opts.existing ?? new Set<string>()).has(p),
  realpath: async (p) => p,
  runVersion: async () => 'unknown',
});

describe('classifyInstallMethod', () => {
  test("classifies /opt/homebrew/bin as 'brew'", () => {
    expect(classifyInstallMethod('/opt/homebrew/bin/claude')).toBe('brew');
  });
  test("classifies /usr/local/bin as 'brew' on mac paths", () => {
    expect(classifyInstallMethod('/usr/local/bin/codex')).toBe('brew');
  });
  test("classifies npm-global paths", () => {
    expect(classifyInstallMethod('/home/user/.npm/bin/claude')).toBe('npm-global');
    expect(classifyInstallMethod('/home/user/.bun/install/global/node_modules/.bin/codex')).toBe(
      'npm-global',
    );
  });
  test("classifies .app bundle paths", () => {
    expect(classifyInstallMethod('/Applications/Foo.app/Contents/MacOS/bin/claude')).toBe(
      'app-bundle',
    );
  });
  test("falls back to 'unknown' otherwise", () => {
    expect(classifyInstallMethod('/some/random/place/bin/claude')).toBe('unknown');
  });
});

describe('wellKnownBinDirs', () => {
  test('includes brew dirs + $PATH entries + npm-global + bun global on darwin', () => {
    const env = fakeEnv({
      platform: 'darwin',
      path: ['/usr/bin', '/opt/homebrew/bin'],
      home: '/Users/u',
    });
    const dirs = wellKnownBinDirs(env);
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain('/Users/u/.npm/bin');
    expect(dirs).toContain('/Users/u/.bun/install/global/node_modules/.bin');
    expect(dirs).toContain('/Users/u/.local/bin');
  });
});

describe('findOnPath', () => {
  test('returns empty when binary is not in any well-known dir', async () => {
    const env = fakeEnv({ platform: 'linux', path: ['/usr/bin'], home: '/home/u' });
    const hits = await findOnPath(env, 'claude');
    expect(hits).toEqual([]);
  });

  test('returns candidate paths where the binary exists, de-duped by realpath', async () => {
    const env = fakeEnv({
      platform: 'linux',
      path: ['/usr/bin'],
      home: '/home/u',
      existing: new Set([
        '/usr/bin/claude',
        '/home/u/.local/bin/claude',
      ]),
    });
    const hits = await findOnPath(env, 'claude');
    expect(hits.sort()).toEqual(['/home/u/.local/bin/claude', '/usr/bin/claude']);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/detect/scanners.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/detect/scanners.ts`**

```ts
import { join } from 'node:path';
import type { InstallMethod } from '../agents/types.ts';
import type { ScanEnv } from '../env/types.ts';

export const wellKnownBinDirs = (env: ScanEnv): readonly string[] => {
  const home = env.homeDir;
  const common = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...env.path,
    join(home, '.local', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.bun', 'install', 'global', 'node_modules', '.bin'),
  ];
  // de-dupe while preserving order
  return Array.from(new Set(common));
};

export const classifyInstallMethod = (absPath: string): InstallMethod => {
  if (absPath.startsWith('/opt/homebrew/') || absPath.startsWith('/usr/local/')) return 'brew';
  if (absPath.includes('/.npm/') || absPath.includes('node_modules/.bin/')) return 'npm-global';
  if (absPath.includes('/.bun/install/global/')) return 'npm-global';
  if (absPath.includes('.app/Contents/')) return 'app-bundle';
  return 'unknown';
};

export const findOnPath = async (env: ScanEnv, binary: string): Promise<string[]> => {
  const dirs = wellKnownBinDirs(env);
  const candidates = await Promise.all(
    dirs.map(async (d) => {
      const p = join(d, binary);
      return (await env.fileExists(p)) ? p : null;
    }),
  );
  const hits = candidates.filter((p): p is string => p !== null);
  // de-dupe by realpath
  const resolved = await Promise.all(
    hits.map(async (p) => {
      try {
        return await env.realpath(p);
      } catch {
        return p;
      }
    }),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const real = resolved[i] ?? hits[i]!;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(hits[i]!);
  }
  return out;
};
```

> Note: `classifyInstallMethod` imports `InstallMethod` from `agents/types.ts`, which is created in Task 13 below. If running tests before Task 13, temporarily inline the type or run Task 13 first. The plan executes tasks in order, so this is fine.

- [ ] **Step 4: Do Task 13 next (type dependency) before running these tests.**

Skip to Task 13, return to verify this test after.

---

## Phase C — Per-agent modules

### Task 13: `Agent` types and shared registry shape

**Files:**
- Create: `packages/core/src/agents/types.ts`

- [ ] **Step 1: Implement `packages/core/src/agents/types.ts`**

```ts
import type { Result } from '../result.ts';
import type { SkillSmithError } from '../errors.ts';
import type { ScanEnv } from '../env/types.ts';

export type SupportedTool = 'claude-code' | 'codex' | 'kilo-code' | 'opencode';

export const SUPPORTED_TOOLS: readonly SupportedTool[] = [
  'claude-code',
  'codex',
  'kilo-code',
  'opencode',
];

export type InstallMethod = 'brew' | 'npm-global' | 'native-installer' | 'app-bundle' | 'unknown';

export interface InstallRecord {
  path: string;
  version: string;
  installMethod: InstallMethod;
}

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>>;
}
```

- [ ] **Step 2: Verify the scanners test from Task 12 now passes**

Run: `bun test packages/core/tests/detect/scanners.test.ts`
Expected: all pass.

- [ ] **Step 3: Commit both Task 12 scanners and Task 13 types together**

```bash
git add packages/core/src/detect/scanners.ts packages/core/tests/detect/scanners.test.ts packages/core/src/agents/types.ts
git commit -m "feat(core): add Agent types and scanner utilities"
```

---

### Task 14: `claude-code` agent

**Files:**
- Create: `packages/core/src/agents/claude-code/install-hint.ts`
- Create: `packages/core/src/agents/claude-code/detect.ts`
- Create: `packages/core/src/agents/claude-code/install-paths.ts` (MVP-2c stub)
- Create: `packages/core/src/agents/claude-code/frontmatter.ts` (MVP-2c stub)
- Create: `packages/core/src/agents/claude-code/index.ts`
- Create: `packages/core/src/agents/claude-code/README.md`
- Create: `packages/core/tests/agents/claude-code.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/agents/claude-code.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { claudeCodeAgent } from '../../src/agents/claude-code/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.2.3',
});

describe('claudeCodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(claudeCodeAgent.tool).toBe('claude-code');
    expect(claudeCodeAgent.installHint).toContain('claude');
  });

  test('returns empty list when not detected', async () => {
    const r = await claudeCodeAgent.detect(env([]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('returns InstallRecord[] when claude binary is present', async () => {
    const r = await claudeCodeAgent.detect(env(['/opt/homebrew/bin/claude']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]).toEqual({
        path: '/opt/homebrew/bin/claude',
        version: '1.2.3',
        installMethod: 'brew',
      });
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/agents/claude-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/agents/claude-code/install-hint.ts`**

```ts
export const installHint = 'npm install -g @anthropic-ai/claude-code';
```

- [ ] **Step 4: Implement `packages/core/src/agents/claude-code/detect.ts`**

```ts
import type { InstallRecord } from '../types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { Result } from '../../result.ts';
import type { SkillSmithError } from '../../errors.ts';
import { ok, err } from '../../result.ts';
import { genericError } from '../../errors.ts';
import { classifyInstallMethod, findOnPath } from '../../detect/scanners.ts';

const BINARY = 'claude';

export const detect = async (env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>> => {
  try {
    const paths = await findOnPath(env, BINARY);
    const records = await Promise.all(
      paths.map(async (p): Promise<InstallRecord> => {
        const version = await env.runVersion(p, ['--version']);
        return {
          path: p,
          version,
          installMethod: classifyInstallMethod(p),
        };
      }),
    );
    return ok(records);
  } catch (e) {
    return err(genericError('claude-code detection failed', e));
  }
};
```

- [ ] **Step 5: Implement `packages/core/src/agents/claude-code/install-paths.ts`** (stub)

```ts
// MVP-2c will populate scope-to-path resolution for Claude Code.
// Personal: ~/.claude/skills/<name>/SKILL.md
// Project: <repo>/.claude/skills/<name>/SKILL.md
// System/Enterprise: via managed-settings.json (see research/skillsmith-skill-install-paths.md)
export {};
```

- [ ] **Step 6: Implement `packages/core/src/agents/claude-code/frontmatter.ts`** (stub)

```ts
// MVP-2c will populate Claude Code's SKILL.md frontmatter schema.
export {};
```

- [ ] **Step 7: Implement `packages/core/src/agents/claude-code/index.ts`**

```ts
import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const claudeCodeAgent: Agent = {
  tool: 'claude-code',
  installHint,
  detect,
};
```

- [ ] **Step 8: Create `packages/core/src/agents/claude-code/README.md`**

```markdown
# claude-code agent

Detection, install-paths, frontmatter, and install-hint for Anthropic's Claude Code CLI.

- Binary name: `claude`
- User skill root: `~/.claude/skills/`
- Project skill root: `<repo>/.claude/skills/`
- Relocation env var: `CLAUDE_CONFIG_DIR`

See `research/skillsmith-skill-install-paths.md` for full details.
```

- [ ] **Step 9: Verify tests pass**

Run: `bun test packages/core/tests/agents/claude-code.test.ts`
Expected: 3 pass.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/agents/claude-code packages/core/tests/agents/claude-code.test.ts
git commit -m "feat(core): add claude-code agent (detect + installHint + stubs)"
```

---

### Task 15: `codex` agent

**Files:**
- Create: `packages/core/src/agents/codex/install-hint.ts`
- Create: `packages/core/src/agents/codex/detect.ts`
- Create: `packages/core/src/agents/codex/install-paths.ts` (stub)
- Create: `packages/core/src/agents/codex/frontmatter.ts` (stub)
- Create: `packages/core/src/agents/codex/index.ts`
- Create: `packages/core/src/agents/codex/README.md`
- Create: `packages/core/tests/agents/codex.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/agents/codex.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { codexAgent } from '../../src/agents/codex/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '0.5.1',
});

describe('codexAgent', () => {
  test('tool identity + installHint', () => {
    expect(codexAgent.tool).toBe('codex');
    expect(codexAgent.installHint).toContain('codex');
  });

  test('returns InstallRecord[] when codex binary is present', async () => {
    const r = await codexAgent.detect(env(['/opt/homebrew/bin/codex']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({
        path: '/opt/homebrew/bin/codex',
        version: '0.5.1',
        installMethod: 'brew',
      });
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/agents/codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/core/src/agents/codex/install-hint.ts`**

```ts
export const installHint = 'npm install -g @openai/codex';
```

- [ ] **Step 4: Create `packages/core/src/agents/codex/detect.ts`**

```ts
import type { InstallRecord } from '../types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { Result } from '../../result.ts';
import type { SkillSmithError } from '../../errors.ts';
import { ok, err } from '../../result.ts';
import { genericError } from '../../errors.ts';
import { classifyInstallMethod, findOnPath } from '../../detect/scanners.ts';

const BINARY = 'codex';

export const detect = async (env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>> => {
  try {
    const paths = await findOnPath(env, BINARY);
    const records = await Promise.all(
      paths.map(async (p): Promise<InstallRecord> => ({
        path: p,
        version: await env.runVersion(p, ['--version']),
        installMethod: classifyInstallMethod(p),
      })),
    );
    return ok(records);
  } catch (e) {
    return err(genericError('codex detection failed', e));
  }
};
```

- [ ] **Step 5: Create `packages/core/src/agents/codex/install-paths.ts`** (stub)

```ts
// MVP-2c will populate scope-to-path resolution for Codex.
// USER (current): ~/.agents/skills/<name>/SKILL.md
// USER (deprecated): $CODEX_HOME/skills → default ~/.codex/skills
// REPO: <cwd ancestors>/.agents/skills/<name>/SKILL.md
// ADMIN: /etc/codex/skills/<name>/SKILL.md
export {};
```

- [ ] **Step 6: Create `packages/core/src/agents/codex/frontmatter.ts`** (stub)

```ts
// MVP-2c will populate Codex's SKILL.md frontmatter schema.
export {};
```

- [ ] **Step 7: Create `packages/core/src/agents/codex/index.ts`**

```ts
import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const codexAgent: Agent = {
  tool: 'codex',
  installHint,
  detect,
};
```

- [ ] **Step 8: Create `packages/core/src/agents/codex/README.md`**

```markdown
# codex agent

Detection, install-paths, frontmatter, and install-hint for OpenAI's Codex CLI.

- Binary name: `codex`
- User skill root (current): `~/.agents/skills/`
- User skill root (deprecated, still read): `$CODEX_HOME/skills/`
- Relocation env var: `CODEX_HOME` (deprecated root only)

See `research/skillsmith-skill-install-paths.md` for full details.
```

- [ ] **Step 9: Verify tests pass**

Run: `bun test packages/core/tests/agents/codex.test.ts`
Expected: 2 pass.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/agents/codex packages/core/tests/agents/codex.test.ts
git commit -m "feat(core): add codex agent (detect + installHint + stubs)"
```

---

### Task 16: `kilo-code` agent

**Files:**
- Same per-folder shape as Task 15, under `packages/core/src/agents/kilo-code/`

- [ ] **Step 1: Write the failing test `packages/core/tests/agents/kilo-code.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { kiloCodeAgent } from '../../src/agents/kilo-code/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.0.0',
});

describe('kiloCodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(kiloCodeAgent.tool).toBe('kilo-code');
    expect(kiloCodeAgent.installHint).toContain('kilo');
  });

  test('detects the `kilo` binary', async () => {
    const r = await kiloCodeAgent.detect(env(['/opt/homebrew/bin/kilo']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/kilo');
      expect(r.value[0]?.version).toBe('1.0.0');
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/agents/kilo-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/core/src/agents/kilo-code/install-hint.ts`**

```ts
export const installHint = 'npm install -g @kilocode/cli';
```

- [ ] **Step 4: Create `packages/core/src/agents/kilo-code/detect.ts`**

```ts
import type { InstallRecord } from '../types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { Result } from '../../result.ts';
import type { SkillSmithError } from '../../errors.ts';
import { ok, err } from '../../result.ts';
import { genericError } from '../../errors.ts';
import { classifyInstallMethod, findOnPath } from '../../detect/scanners.ts';

const BINARY = 'kilo';

export const detect = async (env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>> => {
  try {
    const paths = await findOnPath(env, BINARY);
    const records = await Promise.all(
      paths.map(async (p): Promise<InstallRecord> => ({
        path: p,
        version: await env.runVersion(p, ['--version']),
        installMethod: classifyInstallMethod(p),
      })),
    );
    return ok(records);
  } catch (e) {
    return err(genericError('kilo-code detection failed', e));
  }
};
```

- [ ] **Step 5: Create `packages/core/src/agents/kilo-code/install-paths.ts`** (stub)

```ts
// MVP-2c: Kilo new platform uses ~/.kilo/skills and <project>/.kilo/skills.
// Legacy VS Code extension uses ~/.kilocode/skills; not detectable via a binary.
export {};
```

- [ ] **Step 6: Create `packages/core/src/agents/kilo-code/frontmatter.ts`** (stub)

```ts
// MVP-2c will populate Kilo Code's SKILL.md frontmatter schema.
export {};
```

- [ ] **Step 7: Create `packages/core/src/agents/kilo-code/index.ts`**

```ts
import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const kiloCodeAgent: Agent = {
  tool: 'kilo-code',
  installHint,
  detect,
};
```

- [ ] **Step 8: Create `packages/core/src/agents/kilo-code/README.md`**

```markdown
# kilo-code agent

Detection, install-paths, frontmatter, and install-hint for Kilo Code (new `@kilocode/cli` platform).

- Binary name: `kilo`
- User skill root: `~/.kilo/skills/`
- Project skill root: `<project>/.kilo/skills/`
- Legacy VS Code extension uses `~/.kilocode/skills/`; not detectable via binary in MVP-1.
- No documented relocation env var; symlinks are the documented workaround.

See `research/skillsmith-skill-install-paths.md` for full details.
```

- [ ] **Step 9: Verify tests pass**

Run: `bun test packages/core/tests/agents/kilo-code.test.ts`
Expected: 2 pass.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/agents/kilo-code packages/core/tests/agents/kilo-code.test.ts
git commit -m "feat(core): add kilo-code agent (detect + installHint + stubs)"
```

---

### Task 17: `opencode` agent

**Files:**
- Same per-folder shape, under `packages/core/src/agents/opencode/`

- [ ] **Step 1: Write the failing test `packages/core/tests/agents/opencode.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { opencodeAgent } from '../../src/agents/opencode/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.0.190',
});

describe('opencodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(opencodeAgent.tool).toBe('opencode');
    expect(opencodeAgent.installHint).toContain('opencode');
  });

  test('detects the `opencode` binary', async () => {
    const r = await opencodeAgent.detect(env(['/opt/homebrew/bin/opencode']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/opencode');
      expect(r.value[0]?.version).toBe('1.0.190');
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/agents/opencode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/core/src/agents/opencode/install-hint.ts`**

```ts
export const installHint = 'npm install -g opencode-ai';
```

- [ ] **Step 4: Create `packages/core/src/agents/opencode/detect.ts`**

```ts
import type { InstallRecord } from '../types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { Result } from '../../result.ts';
import type { SkillSmithError } from '../../errors.ts';
import { ok, err } from '../../result.ts';
import { genericError } from '../../errors.ts';
import { classifyInstallMethod, findOnPath } from '../../detect/scanners.ts';

const BINARY = 'opencode';

export const detect = async (env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>> => {
  try {
    const paths = await findOnPath(env, BINARY);
    const records = await Promise.all(
      paths.map(async (p): Promise<InstallRecord> => ({
        path: p,
        version: await env.runVersion(p, ['--version']),
        installMethod: classifyInstallMethod(p),
      })),
    );
    return ok(records);
  } catch (e) {
    return err(genericError('opencode detection failed', e));
  }
};
```

- [ ] **Step 5: Create `packages/core/src/agents/opencode/install-paths.ts`** (stub)

```ts
// MVP-2c: opencode reads .opencode/skills, .claude/skills, .agents/skills at
// both project and global scope.
export {};
```

- [ ] **Step 6: Create `packages/core/src/agents/opencode/frontmatter.ts`** (stub)

```ts
// MVP-2c will populate opencode's SKILL.md frontmatter schema.
export {};
```

- [ ] **Step 7: Create `packages/core/src/agents/opencode/index.ts`**

```ts
import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const opencodeAgent: Agent = {
  tool: 'opencode',
  installHint,
  detect,
};
```

- [ ] **Step 8: Create `packages/core/src/agents/opencode/README.md`**

```markdown
# opencode agent

Detection, install-paths, frontmatter, and install-hint for opencode.

- Binary name: `opencode`
- User skill roots (native + compat): `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`
- Project skill roots: `<repo>/.opencode/skills/`, `<repo>/.claude/skills/`, `<repo>/.agents/skills/`
- Relocation env var: `OPENCODE_CONFIG_DIR`

See `research/skillsmith-skill-install-paths.md` for full details.
```

- [ ] **Step 9: Verify tests pass**

Run: `bun test packages/core/tests/agents/opencode.test.ts`
Expected: 2 pass.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/agents/opencode packages/core/tests/agents/opencode.test.ts
git commit -m "feat(core): add opencode agent (detect + installHint + stubs)"
```

---

### Task 18: Agent registry

**Files:**
- Create: `packages/core/src/agents/registry.ts`
- Create: `packages/core/tests/agents/registry.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/agents/registry.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { getAgent, listSupportedTools, registry } from '../../src/agents/registry.ts';

describe('agents registry', () => {
  test('listSupportedTools returns all four tools in order', () => {
    expect(listSupportedTools()).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
  });

  test('registry has an Agent for every supported tool', () => {
    for (const t of listSupportedTools()) {
      expect(registry[t].tool).toBe(t);
    }
  });

  test('getAgent returns ok for a known tool and err for an unknown one', () => {
    const good = getAgent('codex');
    expect(good.ok).toBe(true);
    const bad = getAgent('nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('unknown-tool');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/agents/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/agents/registry.ts`**

```ts
import { claudeCodeAgent } from './claude-code/index.ts';
import { codexAgent } from './codex/index.ts';
import { kiloCodeAgent } from './kilo-code/index.ts';
import { opencodeAgent } from './opencode/index.ts';
import type { Agent, SupportedTool } from './types.ts';
import { SUPPORTED_TOOLS } from './types.ts';
import { err, ok, type Result } from '../result.ts';
import { type SkillSmithError, unknownToolError } from '../errors.ts';

export const registry: Readonly<Record<SupportedTool, Agent>> = Object.freeze({
  'claude-code': claudeCodeAgent,
  codex: codexAgent,
  'kilo-code': kiloCodeAgent,
  opencode: opencodeAgent,
});

export const listSupportedTools = (): readonly SupportedTool[] => SUPPORTED_TOOLS;

export const getAgent = (tool: string): Result<Agent, SkillSmithError> => {
  if ((SUPPORTED_TOOLS as readonly string[]).includes(tool)) {
    return ok(registry[tool as SupportedTool]);
  }
  return err(unknownToolError(tool));
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/agents/registry.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/registry.ts packages/core/tests/agents/registry.test.ts
git commit -m "feat(core): add agent registry with getAgent, listSupportedTools"
```

---

## Phase D — Detection orchestrators + public API

### Task 19: `detectAll` and `detectTool`

**Files:**
- Create: `packages/core/src/detect/detect.ts`
- Create: `packages/core/tests/detect/detect.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/tests/detect/detect.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { detectAll, detectTool } from '../../src/detect/detect.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '9.9.9',
});

describe('detectAll', () => {
  test('returns a map with an entry for each supported tool', async () => {
    const r = await detectAll(env([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.size).toBe(4);
      for (const t of ['claude-code', 'codex', 'kilo-code', 'opencode'] as const) {
        expect(r.value.has(t)).toBe(true);
        expect(r.value.get(t)).toEqual([]);
      }
    }
  });

  test('honors the tools filter', async () => {
    const r = await detectAll(env([]), { tools: ['codex', 'opencode'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.value.keys()].sort()).toEqual(['codex', 'opencode']);
    }
  });

  test('aggregates detected records per tool', async () => {
    const r = await detectAll(env(['/opt/homebrew/bin/claude', '/usr/local/bin/codex']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.get('claude-code')).toHaveLength(1);
      expect(r.value.get('codex')).toHaveLength(1);
      expect(r.value.get('kilo-code')).toEqual([]);
    }
  });

  test('returns err for an unknown tool in the filter', async () => {
    const r = await detectAll(env([]), { tools: ['not-a-tool' as never] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-tool');
  });
});

describe('detectTool', () => {
  test('returns the agent record list for a known tool', async () => {
    const r = await detectTool(env(['/opt/homebrew/bin/opencode']), 'opencode');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/opencode');
    }
  });
  test('returns err for unknown tool', async () => {
    const r = await detectTool(env([]), 'nope' as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-tool');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/detect/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/detect/detect.ts`**

```ts
import type { InstallRecord, SupportedTool } from '../agents/types.ts';
import { getAgent, listSupportedTools, registry } from '../agents/registry.ts';
import type { ScanEnv } from '../env/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import { err, ok, type Result } from '../result.ts';
import { type SkillSmithError, unknownToolError } from '../errors.ts';

export interface DetectOptions {
  tools?: readonly SupportedTool[];
  logger?: Logger;
  signal?: AbortSignal;
}

export const detectTool = async (
  env: ScanEnv,
  tool: string,
): Promise<Result<InstallRecord[], SkillSmithError>> => {
  const a = getAgent(tool);
  if (!a.ok) return a;
  return a.value.detect(env);
};

export const detectAll = async (
  env: ScanEnv,
  opts: DetectOptions = {},
): Promise<Result<Map<SupportedTool, InstallRecord[]>, SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? listSupportedTools();

  for (const t of tools) {
    if (!(t in registry)) return err(unknownToolError(t));
  }

  const entries = await Promise.all(
    tools.map(async (t) => {
      logger.debug(`detecting ${t}`);
      const r = await registry[t].detect(env);
      if (!r.ok) {
        logger.warn(`detection error for ${t}`, { code: r.error.code });
        return [t, []] as const;
      }
      return [t, r.value] as const;
    }),
  );

  return ok(new Map(entries));
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/detect/detect.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/detect/detect.ts packages/core/tests/detect/detect.test.ts
git commit -m "feat(core): add detectAll and detectTool orchestrators"
```

---

### Task 20: Public API surface

**Files:**
- Create: `packages/core/src/public-types.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/public-api.test.ts`

- [ ] **Step 1: Create `packages/core/src/public-types.ts`**

```ts
export type { InstallMethod, InstallRecord, SupportedTool, Agent } from './agents/types.ts';
export type { Logger } from './env/logger.ts';
export type { ScanEnv, Platform, XdgDirs } from './env/types.ts';
export type { Result } from './result.ts';
export type { SkillSmithError } from './errors.ts';
export type { DetectOptions } from './detect/detect.ts';
```

- [ ] **Step 2: Replace `packages/core/src/index.ts`**

```ts
export { VERSION } from './version.ts';
export { defaultScanEnv } from './env/default.ts';
export { noopLogger } from './env/logger.ts';
export { registry, listSupportedTools, getAgent } from './agents/registry.ts';
export { detectAll, detectTool } from './detect/detect.ts';
export { ok, err, isOk, isErr, map, mapErr } from './result.ts';
export { genericError, unknownToolError } from './errors.ts';
export type {
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
} from './public-types.ts';
```

- [ ] **Step 3: Write the failing test `packages/core/tests/public-api.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import * as core from '@skillsmith/core';

describe('@skillsmith/core public API', () => {
  test('exports the documented runtime symbols', () => {
    const expected = new Set([
      'VERSION',
      'defaultScanEnv',
      'noopLogger',
      'registry',
      'listSupportedTools',
      'getAgent',
      'detectAll',
      'detectTool',
      'ok',
      'err',
      'isOk',
      'isErr',
      'map',
      'mapErr',
      'genericError',
      'unknownToolError',
    ]);
    const actual = new Set(Object.keys(core));
    for (const k of expected) expect(actual.has(k)).toBe(true);
  });

  test('VERSION matches 0.1.0', () => {
    expect(core.VERSION).toBe('0.1.0');
  });

  test('detectAll is callable with defaultScanEnv and returns a Result', async () => {
    const env = await core.defaultScanEnv();
    const r = await core.detectAll(env);
    expect(typeof r.ok).toBe('boolean');
  });
});
```

- [ ] **Step 4: Verify it passes**

Run: `bun test packages/core/tests/public-api.test.ts`
Expected: 3 pass. If the `@skillsmith/core` import fails to resolve, run `bun install` at the repo root to refresh the workspace link, then retry.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/public-types.ts packages/core/tests/public-api.test.ts
git commit -m "feat(core): export public API surface (@skillsmith/core)"
```

---

## Phase E — CLI package

### Task 21: `skillsmith` CLI package bootstrap

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts` (placeholder, replaced in Task 29)

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "skillsmith",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "skillsmith": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "@skillsmith/core": "workspace:*",
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "consola": "^3.2.3"
  }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create placeholder `packages/cli/src/index.ts`**

```ts
#!/usr/bin/env bun
// Placeholder — replaced in Task 29 with full commander wiring.
import { VERSION } from '@skillsmith/core';
console.log(`skillsmith ${VERSION}`);
```

- [ ] **Step 4: Install and typecheck**

Run: `bun install && bunx tsc -b`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): scaffold skillsmith CLI package"
```

---

### Task 22: Color resolution utility

**Files:**
- Create: `packages/cli/src/util/color.ts`
- Create: `packages/cli/tests/util/color.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/util/color.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { resolveColorMode } from '../../src/util/color.ts';

describe('resolveColorMode', () => {
  test('--no-color disables', () => {
    expect(resolveColorMode({ color: 'auto', noColor: true, isTTY: true, env: {} })).toBe('off');
  });
  test('--color=never disables', () => {
    expect(resolveColorMode({ color: 'never', noColor: false, isTTY: true, env: {} })).toBe('off');
  });
  test('NO_COLOR disables regardless', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { NO_COLOR: '1' } }),
    ).toBe('off');
  });
  test('CLICOLOR=0 disables', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { CLICOLOR: '0' } }),
    ).toBe('off');
  });
  test("TERM=dumb disables", () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { TERM: 'dumb' } }),
    ).toBe('off');
  });
  test('--color=always forces on even without TTY', () => {
    expect(resolveColorMode({ color: 'always', noColor: false, isTTY: false, env: {} })).toBe('on');
  });
  test('FORCE_COLOR forces on', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: { FORCE_COLOR: '1' } }),
    ).toBe('on');
  });
  test('CLICOLOR_FORCE forces on', () => {
    expect(
      resolveColorMode({
        color: 'auto',
        noColor: false,
        isTTY: false,
        env: { CLICOLOR_FORCE: '1' },
      }),
    ).toBe('on');
  });
  test('auto with TTY → on', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: {} })).toBe('on');
  });
  test('auto without TTY → off', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: {} })).toBe('off');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/util/color.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/util/color.ts`**

```ts
export type ColorFlag = 'auto' | 'always' | 'never';
export type ColorMode = 'on' | 'off';

export interface ColorInputs {
  color: ColorFlag;
  noColor: boolean;
  isTTY: boolean;
  env: Record<string, string | undefined>;
}

export const resolveColorMode = (inputs: ColorInputs): ColorMode => {
  const { color, noColor, isTTY, env } = inputs;
  if (noColor) return 'off';
  if (color === 'never') return 'off';
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return 'off';
  if (env.CLICOLOR === '0') return 'off';
  if (env.TERM === 'dumb') return 'off';
  if (color === 'always') return 'on';
  if (env.FORCE_COLOR && env.FORCE_COLOR.length > 0) return 'on';
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE.length > 0) return 'on';
  return isTTY ? 'on' : 'off';
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/util/color.test.ts`
Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/util/color.ts packages/cli/tests/util/color.test.ts
git commit -m "feat(cli): add color-mode resolver honoring NO_COLOR, FORCE_COLOR, TERM=dumb"
```

---

### Task 23: Exit-code mapping

**Files:**
- Create: `packages/cli/src/util/exit-codes.ts`
- Create: `packages/cli/tests/util/exit-codes.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/util/exit-codes.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import type { SkillSmithError } from '@skillsmith/core';
import { exitCodeForError } from '../../src/util/exit-codes.ts';

describe('exitCodeForError', () => {
  test("'generic' → 1", () => {
    const e: SkillSmithError = { code: 'generic', message: 'boom' };
    expect(exitCodeForError(e)).toBe(1);
  });
  test("'unknown-tool' → 2", () => {
    const e: SkillSmithError = { code: 'unknown-tool', tool: 'x' };
    expect(exitCodeForError(e)).toBe(2);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/util/exit-codes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/util/exit-codes.ts`**

```ts
import type { SkillSmithError } from '@skillsmith/core';

export const exitCodeForError = (e: SkillSmithError): number => {
  switch (e.code) {
    case 'generic':
      return 1;
    case 'unknown-tool':
      return 2;
  }
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/util/exit-codes.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/util/exit-codes.ts packages/cli/tests/util/exit-codes.test.ts
git commit -m "feat(cli): map SkillSmithError.code to process exit codes"
```

---

### Task 24: Signal handler utility

**Files:**
- Create: `packages/cli/src/util/signals.ts`

- [ ] **Step 1: Implement `packages/cli/src/util/signals.ts`**

```ts
export const installSigintHandler = (controller: AbortController): (() => void) => {
  const handler = () => {
    controller.abort();
    // Give in-flight cleanup a tick before exiting.
    setTimeout(() => process.exit(130), 10);
  };
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
};
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/util/signals.ts
git commit -m "feat(cli): add SIGINT handler that aborts in-flight work and exits 130"
```

---

### Task 25: Help topic stubs

**Files:**
- Create: `packages/cli/src/help/topics.ts`
- Create: `packages/cli/tests/help/topics.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/help/topics.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { HELP_TOPIC_NAMES, renderTopic } from '../../src/help/topics.ts';

describe('help topics', () => {
  test('allowlist contains the 6 topics', () => {
    expect(HELP_TOPIC_NAMES).toEqual([
      'exit-codes',
      'environment',
      'scopes',
      'manifest',
      'sources',
      'formatting',
    ]);
  });

  test('renderTopic returns non-empty content for each known topic', () => {
    for (const t of HELP_TOPIC_NAMES) {
      const r = renderTopic(t);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.length).toBeGreaterThan(0);
    }
  });

  test('renderTopic returns err for unknown topic', () => {
    const r = renderTopic('nope');
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/help/topics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/help/topics.ts`**

```ts
import { err, ok, type Result } from '@skillsmith/core';

export const HELP_TOPIC_NAMES = [
  'exit-codes',
  'environment',
  'scopes',
  'manifest',
  'sources',
  'formatting',
] as const;

export type HelpTopic = (typeof HELP_TOPIC_NAMES)[number];

const TOPICS: Record<HelpTopic, string> = {
  'exit-codes':
    'Exit codes\n  0 success\n  1 generic failure\n  2 usage error\n  130 SIGINT\n\nFull reference: research/skillsmith-cli-design.md §6.1',
  environment:
    'Environment variables\n  NO_COLOR, FORCE_COLOR, CLICOLOR, CLICOLOR_FORCE, TERM — honored by --color auto mode.\n\nSKILLSMITH_* variables land in MVP-2a with the config layer.',
  scopes:
    'Scopes: --system, --user, --project. Full details in research/skillsmith-cli-design.md §1.2–§1.3.\n\nScope semantics are not exercised in MVP-1.',
  manifest:
    'skillsmith.toml reference lands in MVP-2a (config) and MVP-4 (apply).\n\nSee research/skillsmith-cli-design.md for the planned schema.',
  sources:
    'Source formats: owner/repo/skill, repo/skill, Git URL. Wired in MVP-2c (install).\n\nSee research/skillsmith-cli-design.md §1.4.',
  formatting:
    'Output formats: markdown (default for agents), json (for agents and later list/doctor). stdout=data, stderr=messages.\n\nSee research/skillsmith-cli-design.md §1.9 and §6.2.',
};

export const renderTopic = (name: string): Result<string, { code: 'unknown-topic'; name: string }> => {
  if ((HELP_TOPIC_NAMES as readonly string[]).includes(name)) {
    return ok(TOPICS[name as HelpTopic]);
  }
  return err({ code: 'unknown-topic', name });
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/help/topics.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/help packages/cli/tests/help
git commit -m "feat(cli): add help topic stubs (exit-codes, environment, scopes, manifest, sources, formatting)"
```

---

### Task 26: `agents` markdown renderer

**Files:**
- Create: `packages/cli/src/output/agents-markdown.ts`
- Create: `packages/cli/tests/output/agents-markdown.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/output/agents-markdown.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { renderAgentsMarkdown } from '../../src/output/agents-markdown.ts';

const empty: Map<SupportedTool, InstallRecord[]> = new Map([
  ['claude-code', []],
  ['codex', []],
  ['kilo-code', []],
  ['opencode', []],
]);

describe('renderAgentsMarkdown', () => {
  test('renders "Not detected" for all tools when nothing is found', () => {
    const md = renderAgentsMarkdown(empty, { detectedOnly: false });
    expect(md).toContain('# Tools detected');
    expect(md).toContain('## Not detected');
    expect(md).toContain('- claude-code');
    expect(md).toContain('- codex');
  });

  test('omits Not-detected section when detectedOnly', () => {
    const md = renderAgentsMarkdown(empty, { detectedOnly: true });
    expect(md).not.toContain('## Not detected');
  });

  test('renders table rows for detected installs', () => {
    const results = new Map<SupportedTool, InstallRecord[]>([
      [
        'claude-code',
        [
          { path: '/opt/homebrew/bin/claude', version: '1.2.3', installMethod: 'brew' },
          { path: '/Users/u/.npm/bin/claude', version: '1.1.0', installMethod: 'npm-global' },
        ],
      ],
      ['codex', []],
      ['kilo-code', []],
      ['opencode', []],
    ]);
    const md = renderAgentsMarkdown(results, { detectedOnly: false });
    expect(md).toContain('## claude-code');
    expect(md).toContain('| Path | Version | Install method |');
    expect(md).toContain('| /opt/homebrew/bin/claude | 1.2.3 | brew |');
    expect(md).toContain('| /Users/u/.npm/bin/claude | 1.1.0 | npm-global |');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/output/agents-markdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/output/agents-markdown.ts`**

```ts
import type { InstallRecord, SupportedTool } from '@skillsmith/core';

export interface RenderOptions {
  detectedOnly: boolean;
}

export const renderAgentsMarkdown = (
  results: Map<SupportedTool, InstallRecord[]>,
  opts: RenderOptions,
): string => {
  const lines: string[] = ['# Tools detected', ''];
  const detected: [SupportedTool, InstallRecord[]][] = [];
  const notDetected: SupportedTool[] = [];

  for (const [tool, records] of results) {
    if (records.length > 0) detected.push([tool, records]);
    else notDetected.push(tool);
  }

  for (const [tool, records] of detected) {
    lines.push(`## ${tool}`, '', '| Path | Version | Install method |', '|---|---|---|');
    for (const r of records) {
      lines.push(`| ${r.path} | ${r.version} | ${r.installMethod} |`);
    }
    lines.push('');
  }

  if (!opts.detectedOnly && notDetected.length > 0) {
    lines.push('## Not detected', '');
    for (const t of notDetected) lines.push(`- ${t}`);
    lines.push('');
  }

  return lines.join('\n');
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/output/agents-markdown.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/output/agents-markdown.ts packages/cli/tests/output/agents-markdown.test.ts
git commit -m "feat(cli): add markdown renderer for agents inventory"
```

---

### Task 27: `agents` JSON renderer

**Files:**
- Create: `packages/cli/src/output/agents-json.ts`
- Create: `packages/cli/tests/output/agents-json.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/output/agents-json.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { AgentsJsonSchema, renderAgentsJson } from '../../src/output/agents-json.ts';

const sample = new Map<SupportedTool, InstallRecord[]>([
  [
    'claude-code',
    [{ path: '/opt/homebrew/bin/claude', version: '1.2.3', installMethod: 'brew' }],
  ],
  ['codex', []],
  ['kilo-code', []],
  ['opencode', []],
]);

describe('renderAgentsJson', () => {
  test('produces schema-valid JSON', () => {
    const json = renderAgentsJson(sample);
    const parsed = JSON.parse(json);
    const r = AgentsJsonSchema.safeParse(parsed);
    expect(r.success).toBe(true);
  });

  test('includes all four tools as top-level keys', () => {
    const parsed = JSON.parse(renderAgentsJson(sample));
    expect(Object.keys(parsed.tools).sort()).toEqual([
      'claude-code',
      'codex',
      'kilo-code',
      'opencode',
    ]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/output/agents-json.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/output/agents-json.ts`**

```ts
import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { z } from 'zod';

const InstallRecordSchema = z.object({
  path: z.string(),
  version: z.string(),
  installMethod: z.enum(['brew', 'npm-global', 'native-installer', 'app-bundle', 'unknown']),
});

export const AgentsJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  tools: z.record(z.array(InstallRecordSchema)),
});

export const renderAgentsJson = (results: Map<SupportedTool, InstallRecord[]>): string => {
  const tools: Record<string, InstallRecord[]> = {};
  for (const [k, v] of results) tools[k] = v;
  return JSON.stringify(
    { schemaVersion: 1, experimental: true, tools },
    null,
    2,
  );
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/output/agents-json.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/output/agents-json.ts packages/cli/tests/output/agents-json.test.ts
git commit -m "feat(cli): add JSON renderer for agents inventory with zod schema"
```

---

### Task 28: `agents` command handler

**Files:**
- Create: `packages/cli/src/commands/agents.ts`
- Create: `packages/cli/tests/commands/agents.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/commands/agents.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '@skillsmith/core';
import { runAgents } from '../../src/commands/agents.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.0.0',
});

describe('runAgents', () => {
  test('markdown default: contains "Tools detected" header', async () => {
    const r = await runAgents({
      env: env([]),
      tools: undefined,
      format: 'markdown',
      detectedOnly: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('# Tools detected');
  });

  test('json format: parseable and has tools key', async () => {
    const r = await runAgents({
      env: env(['/opt/homebrew/bin/claude']),
      tools: undefined,
      format: 'json',
      detectedOnly: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = JSON.parse(r.output);
      expect(p.tools['claude-code']).toHaveLength(1);
    }
  });

  test('unknown tool in --tool filter returns err', async () => {
    const r = await runAgents({
      env: env([]),
      tools: ['nope'],
      format: 'markdown',
      detectedOnly: false,
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/commands/agents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/commands/agents.ts`**

```ts
import { detectAll, type ScanEnv, type SkillSmithError, type SupportedTool } from '@skillsmith/core';
import { renderAgentsJson } from '../output/agents-json.ts';
import { renderAgentsMarkdown } from '../output/agents-markdown.ts';

export interface RunAgentsInput {
  env: ScanEnv;
  tools: readonly string[] | undefined;
  format: 'markdown' | 'json';
  detectedOnly: boolean;
  signal?: AbortSignal;
}

export type RunAgentsResult =
  | { ok: true; output: string }
  | { ok: false; error: SkillSmithError };

export const runAgents = async (input: RunAgentsInput): Promise<RunAgentsResult> => {
  const r = await detectAll(input.env, {
    ...(input.tools ? { tools: input.tools as readonly SupportedTool[] } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const output =
    input.format === 'json'
      ? renderAgentsJson(r.value)
      : renderAgentsMarkdown(r.value, { detectedOnly: input.detectedOnly });
  return { ok: true, output };
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/commands/agents.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/agents.ts packages/cli/tests/commands/agents.test.ts
git commit -m "feat(cli): add agents command handler wiring core → renderer"
```

---

### Task 29: Commander entry point with help routing

**Files:**
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/tests/help.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/tests/help.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';

const BIN = 'packages/cli/src/index.ts';

const run = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

describe('skillsmith help routing', () => {
  test('`skillsmith` (no args) prints top-level help, exit 0', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('skillsmith');
    expect(r.stdout.toLowerCase()).toContain('usage');
  });

  test('`skillsmith --version` prints a version, exit 0', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0\.1\.0/);
  });

  test('`skillsmith help exit-codes` prints topic page, exit 0', async () => {
    const r = await run(['help', 'exit-codes']);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('exit');
  });

  test('`skillsmith help bogus-topic` exits 2', async () => {
    const r = await run(['help', 'bogus-topic']);
    expect(r.code).toBe(2);
  });

  test('`skillsmith agents --format json` returns valid JSON, exit 0', async () => {
    const r = await run(['agents', '--format', 'json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.tools).toBe('object');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/help.test.ts`
Expected: most tests FAIL — the placeholder index doesn't implement `help`, `--version`, or `agents` yet.

- [ ] **Step 3: Replace `packages/cli/src/index.ts`**

```ts
#!/usr/bin/env bun
import { Command } from 'commander';
import { VERSION, defaultScanEnv } from '@skillsmith/core';
import { runAgents } from './commands/agents.ts';
import { HELP_TOPIC_NAMES, renderTopic } from './help/topics.ts';
import { exitCodeForError } from './util/exit-codes.ts';
import { installSigintHandler } from './util/signals.ts';

const main = async (): Promise<number> => {
  const controller = new AbortController();
  const uninstall = installSigintHandler(controller);

  try {
    const program = new Command()
      .name('skillsmith')
      .description('SkillSmith installs and manages agent skills for AI coding tools.')
      .version(VERSION, '-V, --version')
      .helpOption('-h, --help', 'Show help')
      .option('-v, --verbose', 'Verbose output; repeatable', (_: string, prev: number) => prev + 1, 0)
      .option('-q, --quiet', 'Suppress non-error output', false)
      .option('--no-color', 'Disable ANSI colors')
      .option('--color <mode>', 'auto | always | never', 'auto')
      .option('-C, --cd <dir>', 'Change directory before running', '.')
      .option('--debug', 'Print debug traces', false);

    program
      .command('agents')
      .description('List every supported tool SkillSmith detects on this system')
      .option('-t, --tool <name>', 'Narrow scan to specific tool (repeatable)', (value: string, prev: string[]) => [...prev, value], [] as string[])
      .option('--detected-only', 'Omit the "Not detected" section', false)
      .option('--format <fmt>', 'Output format: markdown | json', 'markdown')
      .action(async (opts: { tool: string[]; detectedOnly: boolean; format: string }) => {
        if (opts.format !== 'markdown' && opts.format !== 'json') {
          process.stderr.write(`error: --format must be markdown or json (got ${opts.format})\n`);
          process.exit(2);
        }
        const env = await defaultScanEnv();
        const r = await runAgents({
          env,
          tools: opts.tool.length > 0 ? opts.tool : undefined,
          format: opts.format,
          detectedOnly: opts.detectedOnly,
          signal: controller.signal,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(exitCodeForError(r.error));
        }
        process.stdout.write(`${r.output}\n`);
      });

    program
      .command('version')
      .description('Print SkillSmith version')
      .action(() => {
        process.stdout.write(`${VERSION}\n`);
      });

    program
      .command('help [topic]')
      .description('Help about a command or cross-cutting topic')
      .action((topic?: string) => {
        if (!topic) {
          program.outputHelp();
          return;
        }
        if ((HELP_TOPIC_NAMES as readonly string[]).includes(topic)) {
          const r = renderTopic(topic);
          if (r.ok) {
            process.stdout.write(`${r.value}\n`);
            return;
          }
        }
        // Try command
        const cmd = program.commands.find((c) => c.name() === topic);
        if (cmd) {
          cmd.outputHelp();
          return;
        }
        process.stderr.write(
          `error: '${topic}' is not a known command or topic.\n` +
            `Known topics: ${HELP_TOPIC_NAMES.join(', ')}\n`,
        );
        process.exit(2);
      });

    await program.parseAsync(process.argv);
    return 0;
  } finally {
    uninstall();
  }
};

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/cli/tests/help.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/tests/help.test.ts
git commit -m "feat(cli): wire commander entry with agents, version, help routing"
```

---

## Phase F — Integration + enforcement + release

### Task 30: Core-boundary enforcement script

> **Superseded (post-MVP, project P02).** The script below was ported to ESLint (`no-restricted-imports` + `no-restricted-syntax` in `eslint.config.js`, scoped to `packages/core/src/**/*.ts`) and then deleted. CI and `bun run check` now invoke `bun run lint:boundaries` instead of `bun run scripts/check-core-boundary.ts`. The rest of this task is retained as historical record of the original MVP implementation.

**Files:**
- Create: `scripts/check-core-boundary.ts`

- [ ] **Step 1: Implement `scripts/check-core-boundary.ts`**

```ts
#!/usr/bin/env bun
// Fail if @skillsmith/core imports CLI-only deps or uses process.exit / console.*
import { Glob } from 'bun';

const FORBIDDEN_IMPORTS = ['commander', 'chalk', 'consola', '@clack/prompts'];
const FORBIDDEN_CALLS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'process.exit', pattern: /\bprocess\.exit\s*\(/ },
  { name: 'console.log', pattern: /\bconsole\.(log|info|warn|error|debug)\s*\(/ },
];

const glob = new Glob('packages/core/src/**/*.ts');
const violations: string[] = [];

for await (const file of glob.scan('.')) {
  const src = await Bun.file(file).text();
  for (const dep of FORBIDDEN_IMPORTS) {
    const rx = new RegExp(`from\\s+['"]${dep}['"]`);
    if (rx.test(src)) violations.push(`${file}: imports '${dep}' (CLI-only dep)`);
  }
  for (const { name, pattern } of FORBIDDEN_CALLS) {
    if (pattern.test(src)) violations.push(`${file}: uses ${name}`);
  }
}

if (violations.length > 0) {
  console.error('core-boundary violations:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('core boundary OK');
```

- [ ] **Step 2: Run it**

Run: `bun run scripts/check-core-boundary.ts`
Expected: prints `core boundary OK`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-core-boundary.ts
git commit -m "ci: add core-boundary checker preventing CLI deps in @skillsmith/core"
```

---

### Task 31: Final verification pass

- [ ] **Step 1: Run the full workspace check**

Run: `bun run check`
Expected: biome, tsc, actionlint, and all tests pass.

- [ ] **Step 2: Build the CLI binary**

Run: `bun run build`
Expected: produces `dist/skillsmith` on darwin-arm64 (or adjust `--target` for your host).

- [ ] **Step 3: Smoke-run the binary**

Run: `./dist/skillsmith agents --format json | bunx jq '.schemaVersion'`
Expected: prints `1`.

- [ ] **Step 4: Verify the CLI/library separation**

Run: `bun run scripts/check-core-boundary.ts`
Expected: `core boundary OK`.

- [ ] **Step 5: Verify conventional commits hook**

Run:
```bash
git commit --allow-empty -m "bad message"
```
Expected: commit is rejected by lefthook `commit-msg`.
If rejected, the hook works as intended — do not actually commit.

- [ ] **Step 6: Tag the internal milestone**

```bash
git tag -a v0.1.0 -m "MVP-1: agents, version, help — internal milestone"
```

- [ ] **Step 7: Sanity-check git status**

Run: `git status && git log --oneline -10`
Expected: clean tree; recent commits tell the MVP-1 story.

---

## Post-plan notes

- Public release of `skillsmith` (binary) and `@skillsmith/core` (npm) is **deferred** until MVP-2b per the spec. `v0.1.0` is an internal tag.
- `install-paths.ts` / `frontmatter.ts` stubs under each agent directory mark the next consumers of these co-located folders in MVP-2c. Deleting a stub should be blocked in code review — they are intentional signposts.
- The zod runtime validation at the public API boundary is not yet wired; MVP-1 exposes types only and keeps zod-as-a-dep in place for the first public-API-validating use in MVP-2b (`list`/`doctor` options bags). This is an intentional scope cap — re-validate if MVP-2b slips.
