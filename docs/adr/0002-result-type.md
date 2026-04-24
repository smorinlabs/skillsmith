# ADR 0002 — Result<T, E> instead of exceptions for expected failures

**Status:** Accepted (2026-04-24)

## Context

Core ([ADR 0001](0001-core-cli-split.md)) needs a way to report failure back to callers. Skillsmith has several categories of expected failure:

- A requested tool isn't in the supported registry.
- A tool binary isn't on PATH.
- A subprocess times out or is aborted mid-scan.
- The environment is misconfigured (missing XDG dirs, unreadable home).

These aren't bugs — they're normal outcomes that the caller must handle. Core must not choose exit codes (the CLI owns that; see ADR 0001), and throwing exceptions for expected failures would leak control flow out of core in a way that's hard for multiple kinds of callers (CLI, IDE, tests) to handle uniformly.

## Decision

Core returns `Result<T, SkillSmithError>` for every function that can fail in an expected way:

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

with helpers in `packages/core/src/result.ts`:

```ts
ok(value)        // → { ok: true, value }
err(error)       // → { ok: false, error }
isOk(r) / isErr(r)
map(r, f)        // Result<T, E> → Result<U, E>
mapErr(r, f)     // Result<T, E> → Result<T, F>
```

Errors are a **tagged union** discriminated on `code`:

```ts
type SkillSmithError =
  | { code: 'unknown-tool'; tool: string }
  | { code: 'detect-failed'; tool: string; cause: string }
  | { code: 'aborted' }
  | { code: 'internal'; message: string }
  | ...;
```

The CLI maps codes to exit codes in `packages/cli/src/util/exit-codes.ts` — a single lookup table, not scattered `catch` blocks.

Bugs (programmer errors, invariant violations) may still throw. We only wrap **expected** failures in Results.

## Consequences

### Positive

- **Exhaustive error handling.** A `switch (err.code)` with `never` fallthrough is checked by TypeScript — the compiler reminds you when a new error variant is added.
- **The CLI owns exit codes.** Core has no idea what exit code corresponds to `unknown-tool`; that decision lives in the one place it belongs.
- **Testability.** Result equality is cheap and trivial: `expect(result).toEqual(err({ code: 'unknown-tool', tool: 'foo' }))`.
- **AbortSignal flows cleanly.** Cancellation becomes `err({ code: 'aborted' })` — the same shape as any other failure, no special `try/catch (AbortError)` plumbing.
- **Library consumers get real data.** An IDE extension can surface `err.tool` in a tooltip without regex-parsing an exception message.

### Negative

- **Boilerplate.** Every fallible call site either unwraps the Result with `if (!r.ok) return r;` or uses `map`. This is real overhead compared to exceptions.
- **No stack trace by default** on the error side of a Result. When we need one (e.g. for `internal` errors), we attach it explicitly.
- **Three-ish conventions to remember:** throw for bugs; return `Result` for expected failures; return raw `T` when no failure is possible. The lines can get blurry.

### Alternatives considered

- **Exceptions everywhere.** Rejected — see "Context". Exceptions make non-CLI embedders awkward and hide the error type from TypeScript's exhaustiveness checking.
- **Node-style `(err, value)` callbacks.** Rejected — we're async-first; callbacks add nothing over Promises + Result.
- **A `neverthrow` or `fp-ts` Result library.** Rejected — both add an external dep for a ~30-line helper. Our `result.ts` is trivial to read in-tree and doesn't lock us into a functional-style API.
- **Tuple-style `[error, value]`** (Go-ish). Rejected — discriminated unions play better with TypeScript narrowing and are easier to map/chain.

## Consequences for new code

When adding a new core function:

- If it can fail in an expected way → return `Result<T, SkillSmithError>`. Add a new variant to `SkillSmithError` if needed, and add the corresponding exit-code mapping in `packages/cli/src/util/exit-codes.ts`.
- If it can only fail on programmer error → throw, and the CLI's catch-all will surface it as `internal`.
- If it cannot fail → return `T` directly. Don't wrap in `Result` "just in case."

## References

- `packages/core/src/result.ts` — implementation.
- `packages/core/src/errors.ts` — `SkillSmithError` union.
- `packages/cli/src/util/exit-codes.ts` — code → exit-code mapping.
- [ADR 0001 — core / CLI split](0001-core-cli-split.md).
