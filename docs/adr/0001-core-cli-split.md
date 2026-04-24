# ADR 0001 — Split the codebase into a pure core library and a CLI

**Status:** Accepted (2026-04-24)

## Context

Skillsmith needs to detect, install, and manage "skills" for AI coding tools (Claude Code, Codex, Kilo Code, opencode). From day one the intent has been that the domain logic — which tools exist, how to detect them, what errors they can produce, how install methods are classified — should be embeddable in other tools (IDE extensions, scripts, CI integrations), not owned by a single CLI.

If we wrote everything in a single package, the domain logic would quickly get entangled with:

- **Presentation libraries** (`chalk`, `consola`) — everything would print through them directly, making non-terminal consumers awkward.
- **CLI framework** (`commander`) — argument parsing would leak into domain types.
- **Prompt libraries** (`@clack/prompts`) — core functions would ask users questions, making them unusable in non-interactive contexts.
- **Global side effects** (`process.exit`, `console.*`) — the only way to signal failure would be via an exit code, forcing all embedders to fork a subprocess.

We've lived that pain in previous projects. The domain code becomes impossible to test without heavy mocking, and impossible to reuse without rewriting.

## Decision

Split the codebase into two workspace packages with a strict boundary:

- **`@skillsmith/core`** — pure TypeScript library. Domain types, agent registry, detection pipeline, error types, result helpers. Zero CLI dependencies. No side effects. Returns values; never prints, exits, or prompts.
- **`skillsmith`** — the CLI. Commander entry, output rendering (markdown + JSON), help topics, color-mode resolution, SIGINT handler, exit-code mapping. Depends on `@skillsmith/core` via `workspace:*`.

The boundary is enforced at **lint time** by `eslint.config.js`:

- `no-restricted-imports` bans `commander`, `chalk`, `consola`, `@clack/prompts`, and `node:console` in `packages/core/src/**`.
- `no-restricted-syntax` bans `process.exit(...)` and `console.{log,info,warn,error,debug}(...)` in `packages/core/src/**`.
- `import/no-restricted-paths` bans `packages/cli/src/**` from deep-importing `packages/core/src/**` (must use the public entry).

Core emits structured data (`Result<T, SkillSmithError>`, typed records) and accepts an injected `ScanEnv` for environment access. The CLI owns all presentation and exit-code policy.

## Consequences

### Positive

- **Testability.** Core has no globals to mock — tests inject a fake `ScanEnv` (see `packages/core/tests/**`). Currently 74 passing tests, most against core.
- **Reusability.** An IDE extension can import `@skillsmith/core` directly without dragging in commander/chalk.
- **Cognitive load.** When reading a core file, we know it can't print or exit, which meaningfully simplifies reasoning.
- **Error handling is explicit.** Every fallible path returns a tagged `Result`. See [ADR 0002](0002-result-type.md).
- **The rules catch accidents.** Multiple times during development, `no-restricted-imports`/`no-restricted-syntax` have flagged real mistakes (an `import 'consola'` that crept into a core refactor; a stray `console.log` used for debugging).

### Negative

- **Two packages to maintain.** Two `package.json` files, two `tsconfig.json` files, two `README.md` files. Mitigated by keeping them in a single workspace with synchronized versions (see [releases](../releases.md)).
- **Some ceremony per error.** Every core function that can fail has to return `Result<T, E>` instead of throwing. Mitigated by `result.ts` helpers (`ok`, `err`, `map`, `mapErr`, `isOk`, `isErr`) and discriminated-union error types.
- **Contributors need to understand the boundary.** A first-time PR that tries to `console.log("debug")` in core gets an ESLint error that won't make sense without context. Mitigated by [CONTRIBUTING.md](../../CONTRIBUTING.md) and this ADR.

### Alternatives considered

- **Single package, "discipline by convention."** Rejected — it decays. Something like a `console.log` gets added "temporarily" and stays forever.
- **Split, but enforce only by code review.** Rejected — slow and unreliable. Linting is nearly-free and catches violations at keystroke time via the lefthook pre-commit hook.
- **Runtime guard (e.g. forbidden-module Node loader).** Rejected — moves the failure later than it needs to be and doesn't catch `console.*`. The earliest, cheapest gate wins.

## References

- `eslint.config.js` — enforcement rules.
- [ADR 0002 — Result-over-exceptions](0002-result-type.md).
- [ADR 0003 — ESLint import boundaries](0003-eslint-import-boundaries.md).
- [architecture.md](../architecture.md) — diagram of how core and CLI fit at runtime.
