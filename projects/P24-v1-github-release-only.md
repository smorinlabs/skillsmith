# P24 — Ship v1.0.0 as a GitHub Release only (unsigned macOS)

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Discussion:** [Issue #53: owner decision for a GitHub-only v1.0.0](https://github.com/smorinlabs/skillsmith/issues/53#issuecomment-7148336499)
- **Depends on:** [P19](P19-product-bug-closeout-and-publication-deferral.md) (publication deferral; P19 itself does not authorize publication)
- **Prior art:** `docs/adr/0010-release-validation-and-publication.md`, `.github/workflows/release.yml`

**Status:** PR-1 (#143) and PR-2 (#145) merged; docs in this PR; PR-3 (#144, `force-tag-creation`) is a draft that merges last, immediately before the release PR #139. The rehearsal and owner setup remain.

## Goal

Publish skillsmith `1.0.0` as a GitHub Release (the `direct` channel) through `release.yml`,
with the darwin binaries ad-hoc signed rather than notarized. `release.yml` has never run, and
its first tagged run must pass, because the workflow is frozen at the tagged commit.

- Make the pipeline executable: resolve the draft release by ID, read `bun.lock` correctly,
  use one command roster, bring the `common` lane to CI parity, and replace the admin-only
  immutable-releases probe.
- Remove the deferred npm and Homebrew jobs and attestations; add an explicit unsigned-macOS mode.
- Let release-please create the `v1.0.0` tag, and land that change last.

**Out of Scope**
- npm publication, the Homebrew tap and cask, and Apple Developer ID signing and notarization.
  They start at the first signed release (decision D7).
- Completing P17. P17 stays pending; this is a partial delivery of PUB-06 (#59).
- Owner-only steps: environments, immutable releases, attestation variables, deleting the stray
  draft releases, and merging the release PR.

## Tests & Tasks

Task numbers follow the plan's `GR-nn` IDs (`GR-07` is `P24-T07`).

- [x] [P24-T00] Owner decision recorded on #53 (D1–D7 approved)
- [x] [P24-T01] Resolve the draft release by ID with a bounded retry; draft-read privilege only
      where needed (D5) (#143)
- [x] [P24-T02] Read `bun.lock` with a tested parser that accepts trailing commas; refresh the
      workspace versions to `1.0.0`; post-condition in `sync-derived-files` (#143)
- [x] [P24-T03] One public command roster derived from the registry, checked before publication (#143)
- [x] [P24-T04] `common` release lane installs the same prerequisites as the CI test shards (#143)
- [x] [P24-T05] Replace the admin-only immutable-releases probe with a post-publication assertion (#143)
- [~] [P24-T06] Triage the red `scripts/secret-scan.test.ts` shard on `main` (#143 adds a status diagnostic; the failure did not recur on #143's Ubuntu run)
- [x] [P24-T07] Remove `npm-preflight`, `homebrew-preflight`, `npm-publish`, `homebrew-publish` (#145)
- [x] [P24-T08] Explicit `--macos-signing none` mode with a Bun >= 1.4.1 floor (#145)
- [x] [P24-T09] GitHub-only gate variants (#145)
- [x] [P24-T10] Structural boundary test for `release.yml` (#145)
- [ ] [P24-T11] `force-tag-creation` in `release-please-config.json` (last PR to merge) (#144, draft)
- [ ] [P24-T12] Remove the duplicate `## [1.0.0]` block from `CHANGELOG.md` (#144, draft)
- [x] [P24-T13] ADR amending ADR-0010 for v1.0.0 (this PR)
- [x] [P24-T14] Rewrite `docs/releases.md` for this flow (this PR)
- [x] [P24-T15] Dated pointer from P19 to P24 (this PR)
- [ ] [P24-T16] Rehearse the run in a scratch public repository (owner approval required)
- [ ] [P24-T17] Owner setup: environments, immutable releases, stray drafts
- [ ] [P24-T18] Merge the release PR, set the five variables, approve, monitor
- [ ] [P24-T19] After publication: README availability row, PUB issue evidence, generalize the guard
- [x] [P24-TS01] `scripts/release-workflow-boundary.test.ts` passes and its mutation controls fail
- [x] [P24-TS02] `scripts/release-identity.test.ts` passes against the committed `bun.lock`
- [x] [P24-TS03] The roster test agrees with the registry, `help`, and `PUBLIC_COMMAND_ORDER`

### Automated Verification
- `just check-gates` and the six CI test shards pass.
- `just p17-check` still passes.
