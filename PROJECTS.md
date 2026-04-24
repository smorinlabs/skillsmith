# Skillsmith Projects

**Status Legend:**
- `[x]` Completed
- `[-]` In Progress
- `[ ]` Not Started
- `[~]` Won't fix / Invalid / False positive

---

## [x] Project P01: ESLint import boundaries (v0.2.0)
**Goal**: Enforce architectural import boundaries via ESLint's `import/no-restricted-paths` rule, alongside existing Biome lint/format. Option B zones: cross-package boundary (core ↔ cli), in-package CLI layering, and in-package core layering.

**Out of Scope**
- Replacing Biome with ESLint for anything else.
- Adding `@typescript-eslint/eslint-plugin` rules.
- Test-file boundary enforcement (tests are ignored).

### Tests & Tasks
- [x] [P01-T01] Add devDeps: `eslint`, `@typescript-eslint/parser`, `eslint-plugin-import`, `eslint-import-resolver-typescript`.
- [x] [P01-T02] Create root `eslint.config.js` (flat config) with only `import/no-restricted-paths` enabled and the Option B zones defined.
- [x] [P01-T03] Add root scripts: `lint:boundaries`, wire into `check`.
- [x] [P01-T04] Add ESLint step to `lefthook.yml` pre-commit for staged `*.ts` files.
- [x] [P01-TS01] Verify current HEAD passes `bun run lint:boundaries` with zero violations.
- [x] [P01-TS02] Write a deliberate violation and confirm ESLint flags it with `import/no-restricted-paths`, then revert.
- [x] [P01-TS03] `bun run check` is green end-to-end.

### Option B zones (reference)
- `packages/core/src/**` must NOT import from `packages/cli/**`.
- `packages/cli/src/**` must NOT import from `packages/core/src/**` (use `@skillsmith/core` public entry).
- `packages/cli/src/output/**` must NOT import `commands/**` or `index.ts`.
- `packages/cli/src/help/**` must NOT import `commands/**`, `output/**`, or `index.ts`.
- `packages/cli/src/util/**` must NOT import `commands/**`, `output/**`, `help/**`, or `index.ts`.
- `packages/core/src/env/**` must NOT import `agents/**` or `detect/**`.
- `packages/core/src/detect/**` must NOT import `agents/**`.

### Deliverable
```bash
$ bun run lint:boundaries
# exits 0 with no output on clean tree

$ bun run check
# lint + typecheck + actionlint + test all pass
```

### Automated Verification
- `bun run lint:boundaries` exits 0 on current HEAD.
- A deliberate violation exits non-zero and names the offending rule.
- `bun run check` passes.

### Manual Verification
- New `eslint.config.js` present at root.
- `lefthook.yml` includes an `eslint-boundaries` pre-commit command.
- Biome config unchanged.

---

## [x] Project P03: Bug audit round 1 (v0.2.2)
**Goal**: Fix all bugs identified in the round-1 code-wide audit across `packages/core`, `packages/cli`, and project tooling.

**Out of Scope**
- Widening agent detection to new tools.
- Full CLI color palette; wiring `--color` only sets NO_COLOR/FORCE_COLOR env vars.

### Tests & Tasks
- [x] [P03-T01] exec.ts: early-return on pre-aborted signal; read stdout concurrently with `proc.exited`.
- [x] [P03-T02] Root `build` script no longer hardcodes `bun-darwin-arm64`; per-target scripts plus native detection via `scripts/build-native.ts`.
- [x] [P03-T03] `detectTool` accepts a signal; `detectAll` forwards `opts.signal` to each agent.
- [x] [P03-T04] `renderAgentsMarkdown` escapes `|`, `\`, and newlines in cells.
- [x] [P03-T05] `--color` flag reads via `resolveColorMode` and sets `NO_COLOR`/`FORCE_COLOR`.
- [x] [P03-T06] lefthook Biome and typecheck globs use `**/` prefix.
- [x] [P03-T07] Core boundary refactor: moved `exec.ts` to `env/`, split `InstallMethod`/`InstallRecord` into `detect/types.ts`, moved orchestrator to `scan/`. ESLint zones added for env↛agents, env↛detect, detect↛agents.
- [x] [P03-T08] `defaultScanEnv` uses platform `path.delimiter` for PATH split.
- [x] [P03-T09] `classifyInstallMethod` returns new `'bun-global'` for `~/.bun/install/global/**`.
- [x] [P03-T10] `fileExists` drops `existsSync` fallback; `catch { return false; }`.
- [x] [P03-T11] SIGINT handler sets `process.exitCode = 130` and exposes `wasInterrupted()`; `main()` returns 130 on interrupt.
- [x] [P03-T12] `help [topic]` emits an internal-error and exits 1 if a known topic has no content.
- [x] [P03-TS01] New test for bun-global classification.
- [x] [P03-TS02] New test for markdown cell escaping.

### Automated Verification
- `bun run check` passes (biome + eslint + tsc + actionlint + bun test).
- `bun run build` produces a native binary; `./dist/skillsmith agents --format json` parses.

---

## [x] Project P02: Port `check-core-boundary.ts` to ESLint (v0.2.1)
**Goal**: Replace the custom `scripts/check-core-boundary.ts` runtime check with equivalent ESLint rules, consolidating the core-isolation boundary into a single tool.

**Out of Scope**
- Widening forbidden imports or calls beyond the script's original list.
- Enforcing these rules against `packages/core/tests/**`.

### Tests & Tasks
- [x] [P02-T01] Add a second config block in `eslint.config.js` scoped to `packages/core/src/**/*.ts` with `no-restricted-imports` (commander, chalk, consola, @clack/prompts) and `no-restricted-syntax` (`process.exit`, `console.{log,info,warn,error,debug}`).
- [x] [P02-T02] Replace the "Core boundary check" step in `.github/workflows/ci.yml` with an ESLint boundaries step.
- [x] [P02-T03] Delete `scripts/check-core-boundary.ts`.
- [x] [P02-TS01] `bun run lint:boundaries` is clean on HEAD.
- [x] [P02-TS02] Deliberate probe file importing `commander`/`chalk` and calling `console.log`/`process.exit` is flagged by both rules; revert.
- [x] [P02-TS03] `bun run check` is green end-to-end.

### Automated Verification
- `bun run lint:boundaries` exits 0 on HEAD.
- `scripts/check-core-boundary.ts` no longer exists.
- CI workflow no longer references the script.
