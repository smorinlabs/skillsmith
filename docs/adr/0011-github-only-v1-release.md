# ADR 0011: Ship v1.0.0 as a GitHub Release only, with unsigned macOS binaries

Status: Accepted (amends [ADR 0010](0010-release-validation-and-publication.md) for v1.0.0 only)

## Context

ADR 0010 promotes one validated candidate through GitHub, five npm packages, and a Homebrew cask, with
Developer ID signed and notarized macOS binaries. `release.yml` had never run. Its npm and Homebrew
paths need trusted publishers, a tap App, and Apple credentials that are not set up, and P17 (the
all-channel release) remains pending.

The owner decided on 2026-11-24 ([#53](https://github.com/smorinlabs/skillsmith/issues/53#issuecomment-7148336499))
to ship `1.0.0` as a GitHub Release only, with decisions D1–D7.

## Decision

1. **Scope.** v1.0.0 publishes GitHub release assets (four archives and `SHA256SUMS`) with build
   attestations. npm, Homebrew, and Apple signing start at the first signed release (D7); 1.0.0's
   unsigned bytes are not republished there.
2. **Deleted jobs.** `npm-preflight`, `homebrew-preflight`, `npm-publish`, and `homebrew-publish`
   are deleted from `release.yml`, not disabled. Their last form, for restoration:
   - [`npm-preflight`](https://github.com/smorinlabs/skillsmith/blob/1161d1e87f77aa861ad0f6e73096767096aaf9da/.github/workflows/release.yml#L581-L661)
   - [`homebrew-preflight`](https://github.com/smorinlabs/skillsmith/blob/1161d1e87f77aa861ad0f6e73096767096aaf9da/.github/workflows/release.yml#L663-L735)
   - [`npm-publish`](https://github.com/smorinlabs/skillsmith/blob/1161d1e87f77aa861ad0f6e73096767096aaf9da/.github/workflows/release.yml#L889-L956)
   - [`homebrew-publish`](https://github.com/smorinlabs/skillsmith/blob/1161d1e87f77aa861ad0f6e73096767096aaf9da/.github/workflows/release.yml#L958-L1040)
   - [npm, Bun, and Homebrew public validation](https://github.com/smorinlabs/skillsmith/blob/1161d1e87f77aa861ad0f6e73096767096aaf9da/.github/workflows/release.yml#L1244-L1293)
3. **Unsigned macOS (D1).** The candidate builds with `build-release.ts --macos-signing none`. That
   mode refuses any `MACOS_*` value and requires Bun 1.4.1 or newer, because earlier Bun writes an
   invalid ad-hoc darwin-arm64 signature ([oven-sh/bun#32159](https://github.com/oven-sh/bun/issues/32159)).
   `release.yml` uses Bun 1.4.2 and GoReleaser v2.18.2, the versions CI already tests. The darwin
   lanes check `codesign --verify --strict` and `Signature=adhoc` instead of Gatekeeper and the cask.
   GoReleaser still builds every binary, archive, and checksum.
4. **Draft-read privilege (D5).** GitHub lists draft releases only to tokens with push access, so
   `release-lookup` and `github-preflight` hold `contents: write`. Neither checks out or runs
   repository code, and neither issues a mutating request;
   `scripts/release-workflow-boundary.test.ts` enforces that.
5. **Attestations.** Five owner variables remain: `ENVIRONMENTS_READY_SHA`, `RUNNER_MATRIX_READY_SHA`,
   `BILLING_READY_SHA`, `PUBLIC_AUDIT_APPROVED_SHA`, `PUBLIC_VISIBILITY_AUTHORIZED_SHA`. Immutability
   is asserted on the release object right after publication, because the repository setting is
   readable only with Administration access.
6. **Gates.** GitHub-only validators (`validateGithubOnlyExternalReadiness`,
   `validateGithubOnlyPublicationReadiness`, `validateGithubOnlyPublicReceipts`) reject any deferred
   npm or Homebrew authority. The all-channel validators stay for the signed release.
7. **Tagging.** `force-tag-creation` lets release-please create `v1.0.0` at the release-PR merge
   commit, so the tag push starts `release.yml`. It merges last, immediately before the release PR.
8. **Recovery (D4).** If the tag run fails before publication, delete the tag and draft and recut
   `1.0.0`. After publication, only fixes forward are possible.

## Consequences

- P17 stays pending. This is a partial delivery of PUB-06 ([#59](https://github.com/smorinlabs/skillsmith/issues/59)),
  which forbids subset-channel completion, so the PUB issues stay open.
- macOS browser downloads are quarantined and blocked by Gatekeeper until cleared. `gh release
  download` is not affected.
- The release is immutable, so 1.0.0's assets cannot change after publication.
- `release.yml` still hardcodes `v1.0.0`. It must be generalized before any later release PR merges.
- Restoring npm and Homebrew means restoring the deleted jobs, their environments and variables, and
  the all-channel gate calls, with Apple signing.
