# Contributing to Skillsmith

Thanks for your interest. Skillsmith is pre-1.0 and the public API is still shifting, but contributions are welcome.

## Dev loop

```sh
git clone https://github.com/smorinlabs/skillsmith.git
cd skillsmith
bun install                 # installs deps and runs `lefthook install`
bun run check               # biome + ESLint boundaries + tsc + actionlint + bun test
```

`bun install` wires lefthook via the `postinstall` script; once it has run, every `git commit` triggers:
- Biome check on staged files
- ESLint import boundaries on staged `packages/*/src/**/*.ts`
- `tsc --noEmit`
- `actionlint` on workflow files

`git push` runs `bun test` via the pre-push hook. Commit messages are validated against [Conventional Commits](https://www.conventionalcommits.org/).

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Run the CLI from source (`packages/cli/src/index.ts`). |
| `bun run test` | `bun test` across both packages. |
| `bun run lint` | Biome check (no writes). |
| `bun run fmt` | Biome check with `--write`. |
| `bun run lint:boundaries` | ESLint boundary rules only (no general linting). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run actions-lint` | actionlint on workflow files. |
| `bun run check` | Full pre-submit: the five above in order. |
| `bun run build` | Compile a single-file native binary to `dist/skillsmith`. |

## Architectural rules (enforced)

Two lint-time rules are load-bearing. Breaking either fails CI.

**1. Core ↔ CLI boundary.** `@skillsmith/core` is a pure library and must stay that way. In `packages/core/src/**`:
- No importing `commander`, `chalk`, `consola`, `@clack/prompts`, or `node:console`.
- No calling `process.exit(...)` or `console.{log,info,warn,error,debug}(...)`.
- Return `Result<T, SkillSmithError>`; let the CLI decide exit codes and formatting.

**2. Import zones.** `eslint.config.js` restricts cross-package and in-package import paths via `import/no-restricted-paths`. Examples:
- `packages/cli/src/**` must import `@skillsmith/core` via its public entry, not deep paths.
- `packages/cli/src/{output,help,util}/**` cannot import `commands/**`.
- `packages/core/src/env/**` cannot import `agents/**` or `detect/**`.

See `eslint.config.js` for the full zone list.

## Commit format

Conventional Commits, enforced by a lefthook `commit-msg` hook:

```
<type>(<optional scope>)!?: <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Scope discipline

- Only change what was explicitly requested; don't refactor adjacent code in the same PR.
- Don't add docstrings, comments, or type annotations to code you didn't change.
- Don't add error handling for scenarios that can't happen.
- Don't create helpers or abstractions for single-use operations.
- Don't add features, configuration options, or backwards-compat shims unless asked.

## Project tracker

Work is planned and tracked in [PROJECTS.md](PROJECTS.md). Please update the relevant P## entry when you complete a task.

## License

Contributions are licensed under [Apache-2.0](LICENSE). By submitting a pull request you agree to license your contribution under the same terms.
