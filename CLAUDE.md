# Repo-specific guidance

## Architectural boundaries — enforced by ESLint

These rules are in `eslint.config.js` and fail `bun run check`. Respect them before you run the linter, not after.

**`@skillsmith/core` (`packages/core/src/**`) is a pure library.** No CLI deps, no I/O side effects.
- Forbidden imports: `commander`, `chalk`, `consola`, `@clack/prompts`, `node:console`.
- Forbidden calls: `process.exit(...)`, `console.{log,info,warn,error,debug}(...)`.
- Return `Result<T, SkillSmithError>`; let the CLI decide exit codes and output.

**One-way import direction (same rules enforced in both packages):**

| Layer | Can import from |
|---|---|
| `packages/core/src/env/` | — (lowest layer, no sibling deps) |
| `packages/core/src/detect/` | `env/` |
| `packages/core/src/agents/`, `scan/` | `env/`, `detect/` |
| `packages/cli/src/util/`, `output/`, `help/` | (leaves — must NOT import `commands/` or `index.ts`) |
| `packages/cli/src/commands/` | anything in CLI + `@skillsmith/core` public entry only |
| `packages/cli/src/**` | `@skillsmith/core` (not a relative path into `packages/core/src/**` other than the package entry) |

**If you're fighting a rule, move the code — don't add `except`.** Changing a zone needs an ADR update. Full zone list: `docs/adr/0003-eslint-import-boundaries.md`. Architecture overview: `docs/architecture.md`.

---

## Releases

Releases are automated by release-please from Conventional Commit messages on `main`. Get the commit wrong and the release is wrong — there's no manual bump.

## Commit format

`<type>(<scope>)!?: <subject>`

Bumps (release-please, `node` type):

| Type | Post-1.0 | Pre-1.0 (now) |
|---|---|---|
| `feat!:` / `fix!:` / `BREAKING CHANGE:` footer | major | **minor** |
| `feat:` | minor | minor |
| `fix:` / `perf:` | patch | patch |
| `refactor` / `docs` / `style` / `test` / `build` / `ci` / `chore` / `revert` | none | none |

No Release PR appears when every commit is a "none" type — expected.

## Scopes

- `cli` — `packages/cli/**`
- `core` — `packages/core/**`
- omit — root configs, `scripts/**`, workflows, docs, tooling

Scopes are **cosmetic** in this repo's release-please setup (single package + `extra-files`); they affect the CHANGELOG line, not the version bump.

## PR titles must also be Conventional

`main` uses squash-merge, so the PR title becomes the commit release-please parses. The `commit-msg` lefthook hook only validates local commits, not PR titles.

## Breaking changes and the 0.x trap

Use `!` or a `BREAKING CHANGE:` footer when breaking the CLI flags/exit codes or a `@skillsmith/core` public export.

While on `0.x.y`, `feat!:` bumps **minor**, not major (SemVer pre-1.0 rule). Still use `!` — it flags the break in the CHANGELOG — but don't expect 1.0.0 from it.

## Forcing a specific version (incl. 1.0.0)

Add a `Release-As:` trailer to any commit on `main`:

```
chore: prepare 1.0.0

Release-As: 1.0.0
```

release-please forces that exact version on the next Release PR. Alternative: edit the open Release PR's title/version — manual edits are preserved.

## Don't hand-edit in normal flow

release-please rewrites these: root `package.json`, `packages/cli/package.json`, `packages/core/package.json`, `CHANGELOG.md`, `.release-please-manifest.json`.

Runtime `VERSION` is read from `packages/core/package.json` at import time (`packages/core/src/version.ts`), so the CLI's `--version` follows automatically.

Emergency manual path: `docs/releases.md:95`.
