# Skillsmith Command Categories

This document extends the existing five-category command taxonomy with a sixth **Publish**
category. It also expands Discover for the hosted registry and marketplace, and adds an independent
security scan to the Develop workflow.

Legend: 🔵 existing taxonomy · 🟠 proposed addition

| Category | Intent | Commands |
|---|---|---|
| Discover | Inspect the local fleet and find, compare, and evaluate ecosystem offerings | 🔵 `agents` · 🔵 `list` · 🔵 `commands` · 🔵 `status` · 🟠 `search` · 🟠 `info` · 🟠 `rate` |
| Manage | Acquire, update, reverse, and remove managed skills | 🔵 `install` · 🔵 `uninstall` · 🔵 `update` · 🔵 `undo` |
| Develop | Work from local source, mechanically verify it, scan it for security risks, and promote it | 🔵 `dev` · 🔵 `verify` · 🟠 `scan` · 🔵 `promote` |
| Declarative | Capture desired state, preview changes, and converge environments reproducibly | 🔵 `init` · 🔵 `export` · 🔵 `plan` · 🔵 `apply` · 🔵 `sync` |
| Publish | Package verified source, establish provenance, and distribute immutable releases | 🟠 `package` · 🟠 `publish` · 🟠 `yank` · 🟠 `owners` |
| Maintain | Diagnose health, configure Skillsmith, reclaim storage, and support routine CLI operation | 🔵 `doctor` · 🔵 `check` · 🔵 `gc` · 🔵 `config` · 🔵 `completion` · 🔵 `version` · 🔵 `help` |

The categories describe user intent rather than command namespaces. Commands remain short,
top-level verbs. The two primary lifecycle paths are:

```text
Author:   Develop -> Verify -> Scan -> Package -> Publish
Consumer: Discover -> Evaluate -> Install -> Declare/Apply -> Update -> Maintain
```

Skillsmith supports both local operations and remote catalog operations through its hosted registry
and marketplace.

| Surface | Responsibilities |
|---|---|
| Local CLI and engine | Develop, mechanically verify, scan locally, install, manage, declare, and maintain |
| Hosted registry | Accounts, publisher ownership, immutable releases, provenance, storage, yanking, advisories, scans, and APIs |
| Marketplace | Search, categories, ratings, reviews, verified publishers, security results, ranking, and moderation |

## Discover

Discover covers both local inspection and remote marketplace discovery. It helps users understand
what is installed, find available skills, and evaluate whether a skill is appropriate and
trustworthy before installing it.

- 🔵 `agents` — Detect coding tools and report Skillsmith's capabilities for each.
- 🔵 `list` — List locally installed skills.
- 🔵 `commands` — List installed slash commands, not Skillsmith CLI commands.
- 🔵 `status` — Correlate desired, locked, ledger, and live state.
- 🟠 `search` — Find marketplace skills by keyword, capability, category, supported tool,
  publisher, rating, or security status.
- 🟠 `info` — Display metadata, releases, compatibility, provenance, publisher identity, security
  results, ratings, dependencies, and license information.
- 🟠 `rate` — Submit or update a user rating and optional review.

Examples:

```sh
skillsmith search "code review" --verified --security passed
skillsmith info owner/review-skill
skillsmith rate owner/review-skill 5
```

Marketplace signals must remain distinct:

- Ratings express user experience and usefulness.
- Reviews provide qualitative community feedback.
- Security results report mechanically supported evidence.
- Publisher verification establishes identity, not code safety.
- Download counts express adoption, not quality.
- Provenance connects a release to its publisher, source, and immutable artifact.

Security scans are performed by the Security workflow, but their results are visible through
`search` and `info` for discovery and awareness.

## Manage

Manage covers the consumer-side lifecycle for installed skills. It acquires registry releases,
places them locally, advances them to newer releases, and safely removes or reverses changes.

- 🔵 `install` — Acquire and persist a remote or registry-hosted skill.
- 🔵 `uninstall` — Remove a skill and its desired-state declaration.
- 🔵 `update` — Check for or apply source-revision updates.
- 🔵 `undo` — Reverse a retained operation.

Examples:

```sh
skillsmith install owner/review-skill
skillsmith update --check
skillsmith uninstall review-skill
```

Before installation or update, Manage can surface publisher identity, release provenance, security
status, compatibility, active advisories, yanked releases, and required permissions. Registry
references resolve to immutable release digests so the same declared release produces the same
bytes on every machine.

## Develop

Develop covers the local authoring and pre-publication loop. Mechanical verification and security
analysis remain separate operations because users may need either one independently.

- 🔵 `dev` — Use a local checkout as the live development source.
- 🔵 `verify` — Perform structural and mechanical verification, including manifests, references,
  tool compatibility, loading, and packaging requirements.
- 🟠 `scan` — Independently inspect local, installed, or registry-hosted skill content for security
  risks.
- 🔵 `promote` — Snapshot a development placement into immutable managed state.

The distinction between verification and scanning is intentional:

| Command | Primary question |
|---|---|
| `verify` | Is this artifact structurally and mechanically valid? |
| `scan` | Does this artifact exhibit known security risks or suspicious behavior? |

Examples:

```sh
# Mechanical verification only
skillsmith verify ./skills/review

# Security analysis only
skillsmith scan ./skills/review

# Mechanical verification followed by security analysis
skillsmith verify ./skills/review --security
```

The dedicated scan supports local and catalog subjects:

```sh
skillsmith scan ./skills/review  # Local source
skillsmith scan review           # Installed skill
skillsmith scan owner/review     # Registry release or hosted report
skillsmith scan --installed      # Entire installed fleet
```

`verify --security` is preferred over overloading `--all`, because `--all` commonly selects all
tools, skills, or targets. Verification can invoke scanning, but scanning remains independently
addressable.

## Declarative

Declarative captures portable desired state and converges machines toward it. Registry identity,
release provenance, and security policy become inputs to planning rather than separate imperative
workflows.

- 🔵 `init` — Create or migrate the desired-state file.
- 🔵 `export` — Capture the current fleet as portable desired state.
- 🔵 `plan` — Preview what convergence would change.
- 🔵 `apply` — Execute a reviewed convergence plan.
- 🔵 `sync` — Reconcile one live location into another.

No new top-level command is required. Desired-state and lock files can express policies such as:

- Allowed registries.
- Exact release versions and immutable digests.
- Required verified publisher.
- Required signature or provenance.
- Minimum acceptable security status.
- Maximum permitted risk level.
- Whether deprecated or yanked releases may be selected.

Declarative planning must show registry resolution, scan policy failures, publisher or provenance
changes, and advisory-driven updates before mutation.

## Publish

Publish is the sixth command category. It covers the author-side distribution lifecycle against the
hosted Skillsmith registry and marketplace.

- 🟠 `package` — Produce a deterministic distributable artifact locally.
- 🟠 `publish` — Authenticate the publisher and create an immutable registry release.
- 🟠 `yank` — Prevent new selection of a problematic release without breaking environments already
  locked to it.
- 🟠 `owners` — Manage publisher ownership and release authority.

A normal release path is:

```sh
skillsmith verify ./skills/review --security
skillsmith package ./skills/review
skillsmith publish ./skills/review
```

Publishing orchestrates the required release gates:

1. Mechanical verification.
2. Local security scan.
3. Deterministic packaging.
4. Artifact digest calculation.
5. Publisher authentication and authorization.
6. Signature and provenance generation.
7. Registry upload.
8. Authoritative registry-side rescan.
9. Immutable release creation.
10. Marketplace search-index publication.

The hosted registry owns account and publisher identity, release storage, ownership and access
control, immutable versions, provenance, signatures, yanking, advisories, and API access. The
marketplace owns searchable metadata, ratings, reviews, ranking, moderation, abuse reporting, and
the presentation of security and trust evidence.

Release channels, changelogs, compatibility declarations, attestations, software bills of
materials, and adoption analytics can be integrated into these commands without necessarily adding
more top-level verbs.

## Maintain

Maintain covers operational care for the local Skillsmith installation and its connection to the
hosted service.

- 🔵 `doctor` — Diagnose unhealthy state and offer deterministic repairs.
- 🔵 `check` — Run blocking machine and project health checks.
- 🔵 `gc` — Reclaim unreachable local-store objects.
- 🔵 `config` — Inspect and change active defaults.
- 🔵 `completion` — Emit shell completion for Bash, Zsh, or Fish.
- 🔵 `version` — Report the running Skillsmith version.
- 🔵 `help` — Explain commands, topics, and workflows.

Maintenance also covers registry authentication state, cached marketplace metadata, advisory
refreshes, scan-result freshness, and installed-fleet health. Authentication may be exposed through
a focused command family such as `auth login`, `auth logout`, and `auth status`; its final command
shape remains a separate design decision.

The maintenance and security responsibilities remain distinct:

- `doctor` diagnoses Skillsmith and fleet integrity.
- `check` provides an automation-friendly health gate.
- `scan` evaluates the security of skill content.
- `check --security` may require installed skills to have current passing scan results.

## Security

Security is a cross-cutting capability rather than a seventh command category. It serves local
authors, marketplace consumers, registry operators, and maintainers without conflating structural
verification, security evidence, reputation, and publisher identity.

Security participates in four categories:

- **Develop:** `scan` evaluates local artifacts independently from mechanical verification.
- **Publish:** every published release is scanned, signed, and associated with immutable evidence.
- **Discover:** `search` and `info` expose security status, advisories, provenance, and scan age.
- **Maintain:** installed-fleet checks detect stale scans, revoked releases, and newly disclosed
  advisories.

A security report should expose evidence rather than collapse unrelated signals into one opaque
score:

- Static-analysis findings.
- Suspicious scripts or executable content.
- Declared tools, permissions, and capabilities.
- Network and filesystem behavior.
- Secret or credential access patterns.
- Dependency vulnerabilities.
- Provenance and signature status.
- Publisher identity.
- Scan engine and ruleset version.
- Scan timestamp and artifact digest.
- Accepted exceptions.
- Active advisories, deprecations, yanks, or revocations.

Local scans provide fast author feedback. Registry-side scans provide the authoritative result for
an immutable published digest. The marketplace displays that result for discovery, filtering, and
awareness, while users retain the ability to run an independent local scan before installation or
at any later point.
