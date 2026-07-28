# Release process

Skillsmith prepares releases with Release Please and promotes one signed candidate through GitHub,
npm/Bun, and Homebrew. The first public release is exactly `v1.0.0`.

## Responsibilities

- Release Please is the only version, changelog, tag, and draft-release authority. The first release
  uses the one-shot `Release-As: 1.0.0` commit footer.
- GoReleaser 2.17.1 and Bun 1.3.14 build four targets: Linux x64/arm64 and macOS x64/arm64.
- The release workflow signs and notarizes macOS binaries before it creates archives, npm payloads,
  checksums, or the Homebrew cask.
- `just check` is the ordinary PR gate. It runs every tracked Bun test file exactly once, serially,
  in a fresh Bun process.
- `just release-check <lane>` validates a transferred candidate in one common lane, four native
  lanes, and a credential-free aggregate.

## Preparation

Every push to `main` runs `.github/workflows/release-please.yml`. A protected
`release-please` environment mints a short-lived GitHub App token; there is no token fallback. The
workflow opens or updates a release PR and creates only a draft GitHub release after merge.

A second App-authenticated job checks out the exact same-repository release branch, runs
`bun install --ignore-scripts`, and regenerates command references. It refuses changes outside
`bun.lock`, `README.md`, and `docs/commands.md`.

To prepare `v1.0.0`:

1. Put `Release-As: 1.0.0` in the initiating conventional commit body.
2. Review the Release Please PR, including all three package versions, lockfile, generated docs,
   and changelog.
3. Merge the release PR. Release Please creates tag `v1.0.0` and an exact draft release.

Do not hand-edit a release version, create the tag manually, or publish the draft manually.

## Candidate validation and publication

The tag starts `.github/workflows/release.yml`:

1. An unprivileged guard binds the tag, commit, protected-main ancestry, manifest, package and lock
   versions, generated docs, and GitHub release state.
2. The `release-candidate` environment builds, signs, notarizes, scans, and retains one private
   candidate bundle for 90 days.
3. Credential-free common and four-runner native jobs validate the exact bundle. An `always()`
   aggregate accepts exactly five successful same-candidate receipts and zero required skips.
4. Separate protected jobs preflight GitHub release authority, five npm trusted-publisher bindings,
   and Homebrew tap App authority. A credential-free aggregate must accept all three.
5. GitHub assets and attestations publish first; four npm payload packages publish before the
   launcher; then the Homebrew App opens a reviewed cask PR in `smorinlabs/homebrew-tap`.
6. After the tap PR is merged, a four-runner public workflow proves clean direct, npm, Bun, and
   macOS Homebrew install/orientation/upgrade/uninstall behavior.

These services cannot publish atomically. If an outage occurs after a public mutation, rerun the
manual recovery path with the original run ID, artifact ID, Actions artifact digest, and bundle
SHA-256. Exact-existing state is accepted and missing state resumes in order. A mismatch or an
expired candidate fails closed; recovery never rebuilds or resigns.

## Required external setup

Publication remains disabled until all of these facts are independently verified:

- GitHub billing permits all four hosted runner labels: `ubuntu-24.04`, `ubuntu-24.04-arm`,
  `macos-15`, and `macos-15-intel`.
- Environments exist for `release-please`, `release-candidate`, `github-release`, `npm`, and
  `homebrew`, with the exact job bindings and reviewers.
- Apple signing/notarization values exist only in `release-candidate`.
- npm trusted publishing is configured for all five `@smorinlabs/skillsmith*` packages, exact
  workflow `release.yml`, and environment `npm`.
- GitHub immutable releases are enabled and the GitHub release environment can attest and publish.
- `smorinlabs/homebrew-tap` has full-SHA-pinned cask CI and the Homebrew App can open, but not
  directly merge, the cask PR.
- The repository's full history, releases/assets, Actions data, conversations, attachments, refs,
  licenses, and publication surfaces pass the public-visibility audit, followed by explicit owner
  authorization to make the repository public.

## Install channels after `v1.0.0` is public

```sh
# Direct archive: choose the exact OS/architecture asset and verify SHA256SUMS.
gh release download v1.0.0 --repo smorinlabs/skillsmith

# npm or Bun use the same launcher and platform payload bytes.
npm install --global @smorinlabs/skillsmith@1.0.0
bun add --global @smorinlabs/skillsmith@1.0.0

# Homebrew becomes available only after the reviewed tap PR merges.
brew install --cask smorinlabs/tap/skillsmith
```

Before public promotion, source checkout remains the only availability claim in the README. A
locally generated candidate is validation input, not a public release.

## Routine releases after 1.0

Continue merging conventional commits. Release Please calculates ordinary Semantic Versioning,
updates one rolling release PR, and repeats the same candidate and publication graph. Do not use a
sticky `release-as` setting and do not publish `@skillsmith/core`; that package remains an explicit
post-1.0 follow-up.
