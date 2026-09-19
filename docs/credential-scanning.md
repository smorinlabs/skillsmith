# Credential scanning

Skillsmith scans repository content with Gitleaks 8.30.1 and TruffleHog 3.97.5.
These checks detect credential-shaped content; they do not contact credential
providers to establish whether a value is active. Test controls are synthetic.

Run commands from the repository root:

```sh
just install-gitleaks
just install-trufflehog
just secrets
```

The installers require exact versions and verify official release archive
SHA-256 checksums on macOS and Linux, on both ARM64 and x64. If a different
version is already on PATH, use an isolated tool directory and put it first on
PATH. Scans never install or update tools implicitly.

## Scan scopes

| Entry point | Content checked |
| --- | --- |
| Lefthook pre-commit | Gitleaks scans staged changes using the index's configuration, including Git's temporary index for partial commits. |
| Lefthook pre-push | Gitleaks scans every ref update supplied by Git. New refs and unavailable remote objects scan the complete pushed ancestry. Deletions publish no content. |
| `just secrets` | Both scanners inspect current contents of tracked files. Tracked ignored files are included. Untracked dependencies and private ignored files are not included. |
| `just check` / `bun run check` | Run `just secrets` once before the ordinary verification pipeline. |
| `just secrets-history` | Both scanners inspect all fetched reachable refs, including deleted content. A shallow checkout is refused. |
| `just secrets-history BASE HEAD` | Both scanners inspect commits introduced between two locally available commit references. |

`BASE` and `HEAD` above are Git revision names or commit IDs. History scanning
includes merge changes through Gitleaks. TruffleHog's native Git traversal omits
merge-only additions, so it supplements Gitleaks in history scans; both scanners
cover those files in the current-file scan. The weekly and main-push credential
history workflow scans fetched history; pull requests scan their introduced commits. Ordinary CI
and the release common-validation job install both scanners before `just check`.

The workflow must pass once before its `history` job is added to GitHub's required
checks. Repository configuration alone does not change branch-protection rules.

The current-file scan exports tracked files into disposable storage. It scans
symlink text without following links into unrelated files. Submodules and
unmerged index entries fail with an actionable error instead of being silently
omitted. Missing working files count as unstaged deletions; history scanning
provides coverage for their previous committed contents.

## Exceptions

`.gitleaks.toml` extends the pinned upstream detectors. Repository exceptions
must match an exact path AND an exact extracted dummy value, and target only
the responsible rule. There are no repository-wide directory or substring
exceptions. Inline suppression comments and `.gitleaksignore` do not override
the wrapper's checks.

Upstream Gitleaks defaults skip files named `gitleaks.toml`. The wrapper also
scans configuration contents through stdin, which bypasses that filename
exclusion, for staged, current, and historical configurations. Other upstream
detector filters still apply; scanning is not proof that every conceivable
credential or file format is covered.

`.secret-scan-exceptions.json` records the scanner, detector, exact repository
path, SHA-256 of the exact synthetic value, and its reason. It contains no raw
credential values. A different value in the same file, or the same value in a
different file, remains a finding. These exceptions preserve the existing
rejection and redaction fixtures rather than changing their test inputs. They
cover TruffleHog's synthetic URI matches and one Gitleaks placeholder in a
historical `.gitleaks.toml`. Pre-commit reads this policy from the index.

Do not add a directory exclusion, a whole-commit ignore, or a blanket baseline
to make a scan pass. Review each new match and add a minimal exception only
after establishing that its content is synthetic or ordinary prose.

## Failure and reporting contract

The wrapper exits 0 for a completed scan with no unexplained findings, 1 for
findings, and 2 for incomplete scans or configuration/tool errors. Missing or
wrong-version scanners, invalid revisions, timeouts, malformed reports, and
scanner errors are failures. Each subprocess has a five-minute ceiling and a
64 MiB output limit; Gitleaks also has a two-minute scan limit.

TruffleHog runs with verification and update checks disabled and retains
unverified findings. Raw scanner stdout, stderr, and credential fields are
never forwarded to logs. Only detector, file, line, and commit metadata are
printed. Gitleaks redacts reports before parsing, except for the configuration
stdin scan, whose exact placeholder comparison requires its raw value in memory.
TruffleHog reports are also filtered in memory. Disposable scan directories
are removed on normal completion and handled failures. Hooks can still be bypassed locally; the
CI checks provide independent enforcement.

## Regression checks

With both pinned scanners installed, run:

```sh
bun test scripts/secret-scan.test.ts scripts/secret-scan-config.test.ts
```

The tests create disposable Git repositories and assemble non-issued controls
at runtime. They check previously excluded paths, exact exceptions, mixed
content, partial staging, commit deletion, ref selection, scanner failures,
redacted output, symlink boundaries, and installed Lefthook commit and push hooks.

Mutation checks deliberately restore a directory exclusion or change AND to
OR and demonstrate that the positive controls detect the weaker coverage.
Run these checks when scanner versions, configuration, installers, wrappers,
or hook registration changes. Provider validity checks are never part of this
suite.

## Handling findings

Inspect each reported location privately. Do not paste credential values into
issues, pull requests, logs, or exception reasons. Establish whether the value
is synthetic before adding an exact exception.

If a credential is real, identify its provider and owner, revoke or rotate it,
and review its access logs. Replace the committed value with a runtime secret
reference, then repeat current-file and history scans. Coordinate any history
rewrite separately. Removing a file or rewriting Git history does not revoke
the credential.
