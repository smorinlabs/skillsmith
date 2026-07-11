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

## Per-agent directories are a design boundary, not duplication

Each supported tool under `packages/core/src/agents/<tool>/` (claude-code, codex, kilo-code, opencode, and any future tool) owns its own `detect.ts`, `index.ts`, `install-hint.ts`, `install-paths.ts`, `frontmatter.ts`, and `README.md`. **Keep these files separate even when bodies look near-identical.**

Share common code via helpers (e.g. `agents/detect-factory.ts` → `createBinaryDetect(tool, binary)`) that each per-agent file calls in one line. Do not merge the agents into a single `builtin.ts` table, and do not delete `export {}` stubs — they reserve the slot and hold roadmap comments.

So when any agent needs to diverge (e.g. Codex wants a different version-parsing strategy, Claude Code wants to check an additional install path), you can inline the implementation back into that one file without touching the others.

---

## Releases

Releases are automated by release-please from Conventional Commit messages on `main`. Get the commit wrong and the release is wrong — there's no manual bump.

## Commit format

`<type>(<scope>)!?: <subject>`

`<subject>` must start lowercase — commitlint's subject-case rule rejects
`feat: Add …`. Watch for this being swallowed when committing with `-q` or a
pipe: always confirm with `git log -1` that the commit actually landed.

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
- `main` — reserved for release-please (`chore(main): release X.Y.Z`)
- omit — root configs, `scripts/**`, workflows, docs, tooling

Scopes are **cosmetic** in this repo's release-please setup (single package + `extra-files`); they affect the CHANGELOG line, not the version bump.

## PR titles must also be Conventional

`main` uses squash-merge, so the PR title becomes the commit release-please parses. The `commit-msg` lefthook hook validates local commits; the `lint-pr-title` CI job validates PR titles.

## Pushing: bypass the pre-push hook (issue #17)

The lefthook pre-push hook runs `bun test`, which leaks test-fixture commits onto
real branches via a `GIT_DIR` environment leak (issue #17, corrupted a real branch
once). Until fixed:

1. Run the full check manually first: `bun run check`
2. Push with the hook disabled: `git push --no-verify`

Never push with the hook enabled from a checkout with real work on it.

## Bun stdout pipe truncation

Piping large CLI output truncates silently at ~64 KB (`bun … list --json | jq`
loses the tail with no error). Redirect to a file instead —
`bun … list --json > out.json` — then read the file.

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

## Dependency overrides (P10)

Root `package.json` `overrides` force `fast-uri`, `js-yaml` (3.15.0 — must stay 3.x for
gray-matter), and `brace-expansion` (5.x) to patched versions because bun overrides are
flat/global. Known dormant hazard: minimatch@3 consumers inside eslint's tree will throw
`TypeError: expand is not a function` if any eslint `files`/glob pattern uses braces
(e.g. `*.{ts,tsx}`) — no such pattern exists today. If you hit that error, drop the
`brace-expansion` override (1.x was never vulnerable) or bump the nested pin instead.
