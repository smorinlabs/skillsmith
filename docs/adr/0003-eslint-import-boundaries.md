# ADR 0003 — Enforce architectural boundaries with ESLint

**Status:** Accepted (2026-04-24)

## Context

[ADR 0001](0001-core-cli-split.md) sets up a core / CLI split. For the split to stay useful, something has to prevent it from decaying — a stray `import 'chalk'` in a core file would quietly compromise the whole design.

We had an initial enforcement mechanism in `scripts/check-core-boundary.ts` — a bespoke Bun script that regex-scanned core files for forbidden imports and `process.exit` / `console.*` calls. It worked, but:

- Regex can false-positive on strings/comments.
- It was a separate tool to run (CI only; not in the editor, not on pre-commit).
- It only checked the core-isolation axis. Other boundaries (who can import whom across directories) had no enforcement.

We also wanted to enforce **in-package layering**: within the CLI, `output/`, `help/`, and `util/` are leaves that shouldn't import from `commands/`, and within core, `env/` shouldn't import `agents/` or `detect/`. Nothing was enforcing these.

Biome (the project's formatter/linter) doesn't have an equivalent to `eslint-plugin-import`'s `no-restricted-paths` or to `no-restricted-imports` / `no-restricted-syntax`.

## Decision

Add ESLint, scoped narrowly to three rules, and use it alongside Biome — not as a replacement.

**Config:** a flat `eslint.config.js` at the repo root with two blocks:

1. **Import zones** (`import/no-restricted-paths`) — applies to `packages/*/src/**/*.ts`:
   - `packages/core/src` ↛ `packages/cli` (core cannot import anything from CLI).
   - `packages/cli/src` ↛ `packages/core/src` except `./index.ts` (CLI must use the public entry).
   - `packages/cli/src/{output,help,util}` ↛ `packages/cli/src/commands` or `src/index.ts`.
   - Leaf-to-leaf bans inside the CLI (e.g. `util` ↛ `output`) to keep the graph one-directional.
   - `packages/core/src/env` ↛ `agents`, `detect`.
   - `packages/core/src/detect` ↛ `agents`.
   - `packages/core/src/{skills,plugins,commands}` ↛ `verify` (verify is a high-level orchestrator, like doctor).

2. **Core isolation** (`no-restricted-imports` + `no-restricted-syntax`) — applies to `packages/core/src/**/*.ts` only:
   - Forbidden imports: `commander`, `chalk`, `consola`, `@clack/prompts`, `node:console`.
   - Forbidden syntax: `process.exit(...)`, `console.{log,info,warn,error,debug}(...)`.

**Wiring:**
- `bun run lint:boundaries` runs ESLint just for these rules.
- `bun run check` includes `lint:boundaries` between Biome and tsc.
- `lefthook.yml` runs ESLint against staged files pre-commit.
- CI runs `bun run lint:boundaries` as a dedicated step.
- `scripts/check-core-boundary.ts` was deleted once ESLint matched or exceeded its coverage.

**Tooling chosen:**
- `eslint@9` (flat config).
- `eslint-plugin-import@2.32` (`no-restricted-paths`).
- `@typescript-eslint/parser@8` (parse-only; no type-checking rules).
- `eslint-import-resolver-typescript@4` (so `@skillsmith/core` resolves to a real path for `no-restricted-paths`).

Notably **not added**: `@typescript-eslint/eslint-plugin`. We're using ESLint strictly as a boundary enforcer; Biome remains the general linter.

## Consequences

### Positive

- **Single source of truth.** The previous split between `check-core-boundary.ts` (substance) and "nothing" (import direction) is replaced by one config.
- **Editor feedback.** Any ESLint-enabled editor highlights violations as you type — much faster than waiting for CI.
- **AST-based precision.** `no-restricted-syntax` on `process.exit` and `console.*` won't false-positive on a string like `"process.exit"` inside a log message, which the regex script could.
- **Catches more cases.** Side-effect imports (`import 'chalk'`), re-exports (`export * from 'chalk'`), and dynamic imports (`import('chalk')`) are all caught by `no-restricted-imports` — the regex script missed all three.
- **In-package layering.** Every direction we care about is now expressed declaratively in one file.

### Negative

- **Another dev dependency surface.** Four new packages (eslint, two plugins, one resolver). They're lint-time only; they don't ship in the binary.
- **Two linters to run.** Biome + ESLint. Mitigated by narrow ESLint scope and by `bun run check` wrapping both.
- **Multiple-tsconfig warning** from the resolver. Suppressed by pointing the resolver at the single root `tsconfig.json`, which already includes both packages.
- **ESLint 10 compatibility.** `eslint-plugin-import` 2.32 doesn't support ESLint 10 yet, so we're pinned to 9. We'll revisit when the plugin catches up.

### Alternatives considered

- **Port everything into Biome.** Rejected — Biome has no equivalent to `no-restricted-paths` today. We'd be blocked on upstream.
- **Keep `scripts/check-core-boundary.ts` and add `eslint-plugin-boundaries`.** Rejected — two tools, two configs, overlapping coverage. One ESLint config wins on simplicity.
- **TypeScript project references instead of `no-restricted-paths`.** Partially considered — TS refs enforce cross-*package* boundaries but not in-package layering. We rely on ESLint for the directional rules; TS project references remain a possible future addition.
- **Runtime assertions (Node loader that blocks the forbidden modules).** Rejected — slower, trickier to debug, doesn't catch `console.*`.

## Maintenance

When adding a new architectural rule:

1. Add the zone to `eslint.config.js` in the same PR as the code change it enables.
2. Record the decision in a new ADR if the rule reflects a non-obvious design choice.
3. Verify with a deliberate probe file (import the forbidden thing; run `bun run lint:boundaries`; expect a non-zero exit and the right rule name).

When a zone starts flagging legitimate imports, don't add an `except`; move the code or update the rule — and update this ADR.

## References

- `eslint.config.js` — current rules.
- `PROJECTS.md` — P01 (initial zones), P02 (port of `check-core-boundary.ts`), P03 (core-layering refactor that added the env/detect/agents zones).
- [ADR 0001 — core / CLI split](0001-core-cli-split.md).
