# ADR 0010: Validate one release candidate before controlled publication

Status: Accepted

## Context

Skillsmith ships the same Bun-compiled CLI through GitHub archives, five npm packages, and a
Homebrew cask. Those services cannot publish atomically. Rebuilding for each channel would also
make a successful test receipt say nothing about the bytes users later install.

Release automation needs privileged Apple signing, GitHub release, npm OIDC, and tap credentials.
Putting all authority in one job would expose unrelated credentials before candidate validation and
make partial-publication recovery ambiguous.

## Decision

Release Please alone chooses versions, updates the changelog, creates the exact tag, and creates a
draft release. P17's first public tag is exactly `v1.0.0` through the one-shot
`Release-As: 1.0.0` instruction.

GoReleaser compiles each supported target once. The protected candidate job signs and notarizes the
macOS binaries before archives, checksums, npm payloads, and the cask fan out. It then retains one
private candidate bundle for 90 days. Every common and native validation lane receives that exact
candidate and emits a receipt bound to its tag, commit, artifact identity, and bundle digest.

Publication begins only after one credential-free aggregate and three separate authority
preflights succeed. GitHub publishes first, npm publishes four payloads before the launcher, and a
short-lived App opens a reviewed cask PR in `smorinlabs/homebrew-tap`. Each protected environment
contains only its own authority.

If publication stops after an irreversible action, recovery must reuse the retained candidate.
Existing exact state is accepted, missing state is resumed in order, and any version or digest
mismatch fails closed. The process never claims cross-service atomicity and never rebuilds a
partially published release.

The ordinary repository gate is `just check`. It rediscoveries every tracked Bun test file and runs
each exactly once, serially, in a fresh Bun process. Release-only checks use a closed
`just release-check <lane>` interface: one common lane, four native lanes, and one aggregate.

## Consequences

- A validation receipt describes the bytes users receive through every channel.
- Apple, GitHub, npm, and tap credentials are isolated and are unavailable to ordinary tests.
- A failed preflight mutates nothing; a later outage can create an explicitly incomplete release.
- Recovery depends on the 90-day retained candidate and stops for an incident amendment if it has
  expired after publication began.
- Public release requires four hosted runner labels, five npm trusted-publisher bindings, immutable
  GitHub releases, tap cask CI, a successful full-surface public audit, and explicit visibility
  authorization.
- GoReleaser remains the packaging authority; the project does not copy a dependency graph or
  maintain a private archive builder.
