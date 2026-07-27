# Release process

Releases are driven by [release-please](https://github.com/googleapis/release-please). You don't hand-edit `CHANGELOG.md`, you don't manually bump versions, and you don't manually create tags — release-please does all three from the Conventional Commits history.

## Overview

```
┌────────────────┐   push to main   ┌────────────────────┐
│  feat/fix PRs  │ ───────────────▶│  .github/workflows/ │
│  (squashed to  │                  │  release-please.yml │
│  Conventional  │                  │                     │
│  Commits)      │                  │  opens/updates      │
└────────────────┘                  │  "Release PR"       │
                                    └──────────┬──────────┘
                                               │  merge
                                               ▼
                                    ┌────────────────────┐
                                    │  tag v<version>    │
                                    │  GitHub Release    │
                                    └────────────────────┘
```

Every push to `main` runs the `release-please` workflow, which:

1. Walks the commit history since the last release tag.
2. Computes the next SemVer bump from the commit types (`feat!` → major, `feat` → minor, `fix`/`perf` → patch, etc.).
3. Opens or updates a single rolling PR titled `chore(main): release vX.Y.Z` that:
   - Bumps the version in root `package.json` **and** (via `extra-files` in `release-please-config.json`) in `packages/cli/package.json` + `packages/core/package.json` — all three stay in lockstep.
   - Appends a new section to `CHANGELOG.md` generated from the commits.

Merging the Release PR creates the git tag and a GitHub Release whose body matches the CHANGELOG entry.

## Cutting a release

**You don't.** Merge feature and fix PRs to `main` as normal, then when you're ready to ship:

1. Find the open Release PR (title: `chore(main): release vX.Y.Z`).
2. Sanity-check the generated CHANGELOG entry and version bump.
3. Merge it.
4. Done — the tag and GitHub Release appear automatically.

If the PR doesn't look right, push more commits to `main` and release-please will rewrite it. If the PR is missing entirely, it means there's nothing release-worthy since the last release (e.g. only `docs:` or `chore:` commits with no user-visible changes).

## Conventional Commits — how your commits map to bumps

| Commit prefix | Example | Bump |
|---|---|---|
| `feat!:` or `fix!:` (or `BREAKING CHANGE:` in body) | `feat!: rename --tool flag to --only` | major |
| `feat:` | `feat(cli): add install command` | minor |
| `fix:` | `fix(core): handle empty PATH` | patch |
| `perf:` | `perf: cache agent detection` | patch |
| `refactor:`, `docs:`, `style:`, `test:`, `build:`, `ci:`, `chore:` | `chore: bump biome to 2.0` | *no release* (skipped) |

The `commit-msg` lefthook hook validates every commit against this format — see `CONTRIBUTING.md`.

## Manual `CHANGELOG.md` edits

The `[Unreleased]` section at the top of `CHANGELOG.md` was seeded by hand during P04 so the repo didn't land with an empty changelog. On the first Release PR, release-please will replace it with a generated section. After that, the file is entirely automated — **don't edit it by hand**; edit the commit messages instead.

If you must override what release-please generates (e.g. to collapse a noisy series of `fix:` commits into one bullet), the hook is [release-please's "extra PR note"](https://github.com/googleapis/release-please#manifest-driven-releases) — rebase the release PR with manual edits, and release-please will preserve them on the next regeneration.

## Supported binary targets

`bun build --compile` produces a single-file native binary. Per-target scripts:

| Target | Bun target flag | Script |
|---|---|---|
| macOS Apple Silicon | `bun-darwin-arm64` | `bun run build:darwin-arm64` |
| macOS Intel | `bun-darwin-x64` | `bun run build:darwin-x64` |
| Linux x86_64 | `bun-linux-x64` | `bun run build:linux-x64` |
| Linux arm64 | `bun-linux-arm64` | `bun run build:linux-arm64` |

`bun run build` detects the host target via `scripts/build-native.ts` and invokes the matching script. Output lands in `dist/skillsmith`.

Today, binaries are **not** attached to GitHub Releases automatically. P17-G6-01 builds and tests a
local candidate, while P17-G6-04 retains upload and public-availability authority.

## Local distribution candidate

`bun run build:release` creates all four native candidates without changing release-please-managed
versions. Each native binary is compiled once and reused byte-for-byte by its direct archive,
Homebrew branch, and npm/Bun payload. The release output root contains four
`skillsmith-v<version>-<target>.tar.gz` archives, five scoped-package tarballs, `skillsmith.rb`,
`release-manifest.json`, and `SHA256SUMS`.

The candidate package identity is `@smorinlabs/skillsmith`; the formula identity is
`smorinlabs/tap/skillsmith`. Neither is yet published. G6-01 clean-installs candidates from local
loopback fixtures and never edits an external tap or shell startup file. Verify a candidate with
`sha256sum -c SHA256SUMS`, extract only the archive matching the host, and run `skillsmith version`
from an isolated prefix. Public install, upgrade, and uninstall commands remain gated by G6-04.

## What CI does on pushes & PRs

Defined in `.github/workflows/ci.yml`. On every `push` to `main` and every `pull_request`, the matrix (`macos-15`, `ubuntu-latest`) runs:

1. `bunx @biomejs/biome ci`
2. `bun run lint:boundaries` (ESLint zones)
3. `bunx tsc --noEmit`
4. `bun test`
5. `actionlint` on workflow files
6. Build the native binary for the host target
7. Binary smoke-run: `./dist/skillsmith agents --format json`

This is separate from `release-please.yml` — CI gates PRs, release-please cuts releases.

## Versioning policy

We follow [Semantic Versioning](https://semver.org/). Pre-1.0 we reserve the right to break the public API on minor bumps; patch bumps are always backwards-compatible. Root and both workspace packages always share a version.

## Pre-1.0 manual override (emergency only)

If release-please is broken or you need to cut a patch without waiting for the workflow:

1. Edit `CHANGELOG.md` and all three `package.json` files by hand.
2. Commit as `chore(release): vX.Y.Z`.
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main vX.Y.Z`.
4. Update `.release-please-manifest.json` to match (`".": "X.Y.Z"`) so release-please picks up where you left off.

Reserve this for real emergencies — every manual release is one more thing that can drift out of sync.

## Open follow-ups

Deliberately deferred until post-1.0:

- Publishing `@skillsmith/core` to npm on release.
- Building all four binary targets on release-created and attaching to the GitHub Release.
- Signed releases and/or a Homebrew tap.
