# Architecture Decision Records

Records of non-obvious design decisions. Each ADR follows the [Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md) (Status / Context / Decision / Consequences).

| # | Title | Status |
|---|---|---|
| [0001](0001-core-cli-split.md) | Split the codebase into a pure core library and a CLI | Accepted |
| [0002](0002-result-type.md) | `Result<T, E>` instead of exceptions for expected failures | Accepted |
| [0003](0003-eslint-import-boundaries.md) | Enforce architectural boundaries with ESLint | Accepted |
| [0004](0004-command-runtime-application-boundary.md) | Declarative commands, one CLI runtime, and public application services | Accepted |

## When to write an ADR

- You're making a design decision that isn't obvious from reading the code.
- You're picking one of several reasonable alternatives and future-you will want the rationale.
- You're adopting or removing a tool, pattern, or convention that shapes how others should write code.

**Not every decision needs an ADR.** File choices, one-off refactors, and bug fixes don't.

## Numbering

Four-digit zero-padded, monotonically increasing (`0001`, `0002`, …). Never renumber — a superseded ADR stays in place with its `Status:` updated to `Superseded by ADR N`.
