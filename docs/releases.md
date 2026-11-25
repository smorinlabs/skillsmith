# Release process

Skillsmith prepares releases with Release Please and promotes one validated candidate. `v1.0.0` is a
GitHub Release only, with ad-hoc signed (not notarized) macOS binaries
([ADR 0011](adr/0011-github-only-v1-release.md), amending [ADR 0010](adr/0010-release-validation-and-publication.md)).
npm, Homebrew, and Apple signing start at the first signed release.

## Responsibilities

- Release Please is the only version, changelog, tag, and draft-release authority. With
  `force-tag-creation`, merging a release PR creates the `v<version>` tag at the merge commit and then
  an exact draft release.
- GoReleaser builds the four targets with Bun (Linux x64/arm64, macOS x64/arm64), the archives, and
  `SHA256SUMS`. `release.yml` uses Bun 1.4.2 and GoReleaser v2.18.2, the versions per-PR CI tests.
  Unsigned macOS builds require Bun 1.4.1 or newer.
- Local `just check` runs the ordinary checks and every tracked Bun test file exactly once, serially,
  in a fresh Bun process. [Product CI](ci.md) distributes the tests across six shards and validates
  their combined evidence before `CI result` can succeed.
- `just release-check <lane>` validates a transferred candidate in one common lane, four native lanes,
  and a credential-free aggregate.

## Scope of v1.0.0

The owner resumed publication for this scope only
([#53 decision](https://github.com/smorinlabs/skillsmith/issues/53#issuecomment-7148336499)). P17 and the
PUB issues stay open. Release qualification (`.github/workflows/release-qualification.yml`, dispatch
only) remains the Homebrew qualification path for the signed release.

## Preparation

Every push to `main` runs `.github/workflows/release-please.yml`. A protected `release-please`
environment mints a short-lived GitHub App token; there is no token fallback. The workflow opens or
updates a release PR.

A second App-authenticated job checks out the exact same-repository release branch, runs
`bun install --ignore-scripts`, syncs the two `bun.lock` workspace versions
(`scripts/release-identity.ts --sync-lock`), and regenerates command references. It refuses changes
outside `bun.lock`, `README.md`, and `docs/commands.md`, and fails if the release identity disagrees.

Before merging the release PR:

1. Confirm its diff is `CHANGELOG.md` and derived files only, with exactly one section for the
   version, and that CI is green on its head.
2. Complete the owner setup below.
3. Merge it with a merge commit. Release Please creates the tag and the draft. From then until
   publication, merge nothing else to `main`.

Do not hand-edit a release version, create the tag manually, or publish the draft manually.

## Candidate validation and publication

The tag starts `.github/workflows/release.yml`:

1. `guard` (read-only) binds the tag, commit, protected-main ancestry, versions, lockfile, and
   generated docs.
2. `release-lookup` finds the one release with the exact tag by listing releases, retrying six times
   ten seconds apart, and passes its ID on. It reads drafts with `contents: write` and runs no
   repository code and no mutation.
3. The `release-candidate` environment builds the unsigned-macOS candidate, scans it, and retains the
   bundle for 90 days. No secrets are present.
4. Credential-free `common` and four native lanes validate the exact bundle, including the command
   roster before publication. An `always()` aggregate accepts exactly five receipts with zero
   required skips.
5. `github-preflight` (environment `github-release`) checks the draft and any existing assets.
   `publication-ready` binds the five owner variables to the tag commit.
6. `github-publish` (environment `github-release`) uploads missing assets, attests them, publishes
   the draft as latest, and asserts that the published release is immutable.
7. `public-validation` downloads the public assets on all four runners and proves checksum,
   attestation, orientation, the command roster, the agent fleet matrix, and a clean direct
   uninstall. `public-aggregate` accepts the four receipts.

If an outage interrupts publication, rerun with the original candidate:

```sh
gh workflow run release.yml --ref v1.0.0 -f exact_tag=v1.0.0 -f candidate_run_id=<run> -f candidate_artifact_id=<id> -f candidate_bundle_sha256=<sha256> -f candidate_artifact_digest=sha256:<digest>
```

Exact existing state is accepted and missing state resumes. A mismatch or an expired candidate fails
closed; recovery never rebuilds. If the run fails before publication, delete the tag and the draft
and recut the same version.

## Owner setup

Before merging the release PR:

- Enable immutable releases for the repository.
- Create the `release-candidate` and `github-release` environments with a required reviewer.
- Delete stray draft releases for the version, so exactly one draft exists after tagging.
- Confirm Actions billing permits `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, and `macos-15-intel`.
- Complete the public-exposure audit.

After the merge, read the merge commit SHA (also the tag commit) and set these repository variables
to it before approving `release-candidate`:

| Variable | Attests |
|---|---|
| `ENVIRONMENTS_READY_SHA` | the environments exist with reviewers and immutable releases are on |
| `RUNNER_MATRIX_READY_SHA` | the four runner labels are available |
| `BILLING_READY_SHA` | billing does not block the run |
| `PUBLIC_AUDIT_APPROVED_SHA` | the public-exposure audit is approved for this source |
| `PUBLIC_VISIBILITY_AUTHORIZED_SHA` | the owner authorizes this release to be public |

Then approve `release-candidate`, and `github-release` twice: the preflight, then the publish.

## Install after `v1.0.0` is public

Download the archive for your OS and architecture, and verify it against `SHA256SUMS`:

```sh
gh release download v1.0.0 --repo smorinlabs/skillsmith
shasum -a 256 --check --ignore-missing SHA256SUMS
```

macOS binaries are ad-hoc signed, not notarized. A browser-downloaded archive is quarantined, and
Gatekeeper blocks it until the quarantine attribute is cleared. `gh release download` does not set
that attribute.

## After 1.0

`release.yml` still hardcodes `v1.0.0`. Generalize it before merging any later release PR. npm and
Homebrew return with Apple signing by restoring the jobs that ADR 0011 links.
