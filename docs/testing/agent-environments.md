# Agent executable environments

The ordinary test owner `packages/cli/tests/commands/agent-environments.test.ts` runs three cases:
five-tool discovery, Claude installation prerequisites, and Codex installation prerequisites.
It defaults to deliberate absence and adds no skips. CI runs that owner and the eight P4A fixture
cases separately in both the `present` and `absent` environments, using Bun 1.3.14 on Ubuntu 24.04.

The baseline in `.github/ci-agent-tools.json` is:

| Tool | Executable | Distribution | Exact version |
| --- | --- | --- | --- |
| Claude Code | `claude` | `@anthropic-ai/claude-code` | `2.1.202` |
| Codex | `codex` | `@openai/codex` | `0.142.5` |
| Kilo Code | `kilo` | `@kilocode/cli` | `7.4.5` |
| OpenCode | `opencode` | `opencode-ai` | `1.17.18` |
| Muse | `muse` | native binary (pinned per-platform artifact) | `1.3.0-R3401.1` |

These versions are a reproducible baseline. Kilo Code, OpenCode, and Muse remain read-only
Skillsmith adapters. The tests compare the manifest IDs and capability facts with the actual
registry. Muse ships no npm package: the manifest pins one checksum-verified native binary per
supported platform, and the installer fetches only that pinned URL, accepting the bytes only
when their size and SHA-256 match the pin.

## CI environments

The ordinary CI job prepares these five tools in a new owned directory below `RUNNER_TEMP` before
its canonical repository gate. It appends only that directory's `prefix/bin` to `GITHUB_PATH`,
records each `command -v` binding and runs each `--version` probe with a 30-second bound, then
runs this same three-case owner with `SKILLSMITH_CI_AGENT_MODE=present`, its owned prefix, and a
fresh empty report-child directory scoped to that preflight step. The installer receipt and logs,
command receipts,
preflight output, and child reports are retained in a separate ordinary artifact. The artifact
does not include installed packages, npm caches, or configuration directories.

That ordinary prefix supplies dependencies such as the inherited-`PATH` WF02 and WF14 workflows;
it does not set `SKILLSMITH_CI_AGENT_MODE` or report selectors for the canonical gate. The separate
`agent-environments` matrix remains the deliberate two-lane check: its present lane installs and
verifies the five tools, while its absent lane keeps the fixture-owned empty PATH and fixed-path
discovery controls. The present owner verifies each symlink target, package receipt, hash, and
version; the ordinary shell gate compares the `command -v` binding itself with `prefix/bin`.

## Run locally

From the repository, deliberate absence requires Bun, Node, and Git:

```sh
SKILLSMITH_CI_AGENT_MODE=absent bun test ./packages/cli/tests/commands/agent-environments.test.ts --timeout=60000 --max-concurrency=1 --no-orphans --retry=0
```

For presence, first choose a **new, nonexistent** absolute root outside the checkout. Its parent
must exist and resolve without symlinks. Ensure sufficient disk space for packages, npm cache,
and extraction. The installer preserves failed preparations, so each attempt needs a new root.
For example, if `/tmp/skillsmith-agent-tools-1` does not exist:

```sh
bun scripts/install-ci-agent-tools.ts --root /tmp/skillsmith-agent-tools-1
SKILLSMITH_CI_AGENT_MODE=present SKILLSMITH_CI_AGENT_PREFIX=/tmp/skillsmith-agent-tools-1/prefix bun test ./packages/cli/tests/commands/agent-environments.test.ts --timeout=60000 --max-concurrency=1 --no-orphans --retry=0
```

The installer bootstraps npm `12.0.1` in that root, then installs the exact four npm packages
with their required optional dependencies. Its npm lifecycle allow-list names only
`@anthropic-ai/claude-code`, `@kilocode/cli`, and `opencode-ai`; Codex has no postinstall script.
Muse is not on npm: the installer downloads the pinned native binary for the host platform over
HTTPS, rejects size or SHA-256 mismatches against the manifest pin, and installs it executable
into the owned prefix. Its `--version` probe sets `MUSE_NO_AUTO_UPDATE=1` so the launcher's
self-update check never runs during installation. Node must satisfy npm's
`^22.22.2 || ^24.15.0 || >=26.0.0` requirement; CI selects Node 24. Repository dependencies still
use `bun install --frozen-lockfile --ignore-scripts`. No global host tools or repository locks
are updated. Each installation retains `receipt.json` and process stdout/stderr under `logs/`.

The present prefix must match a successful installer receipt, manifest hash, package versions,
and executable hashes. Missing tools or a failed receipt are preparation failures. They cannot
count as passing absence coverage. An invalid mode is also an error; an unset mode means absent.

To retain the test's child reports and synthetic workspaces, set
`SKILLSMITH_CI_AGENT_REPORT_DIR` to an existing, empty, canonical absolute directory. Otherwise,
test workspaces are removed after execution. CI uploads reports and installer logs/receipt,
excluding installed package, npm cache, and npm configuration trees.

## What the checks establish

Each product child receives fresh owned HOME, XDG, data, Git configuration, cwd, temp, and PATH.
The PATH contains only owned Git/Node bindings and, in present mode, the five verified tools.
The existing scanner-isolation preload excludes the ten fixed external executable candidates
and records a fresh trace for each invocation. No inherited provider credentials or agent
configuration overrides enter these child environments.

Presence checks direct version output against exact pinned version tokens, then compare the actual
Skillsmith v2 discovery report with the owned binding paths and cardinality. Discovery version
metadata is best effort: for any of the five tools it must be either the observed direct first line
or the literal `unknown` sentinel. The sentinel does not replace a successful direct probe or the
exact installer pin. The controls clone a valid present report to prove that `unknown` is accepted
and that a wrong non-sentinel version is rejected by the same checker. The Codex binding is removed
temporarily to prove incomplete discovery fails the same five-tool completeness assertion, restored
in `finally`, and checked again.

Claude and Codex install from synthetic HTTPS identities rewritten to local fixture Git
repositories, with file-only Git transport. The exact invocation uses `--scope user --no-save
--no-verify --json`. It records `requested.verify: "skipped"` and the pinned ledger verification
as `"skipped"`; the successful result's `verify` field is explicitly `null` because no verification
ran. Presence must produce the expected symlink, skill bytes, store, and ledger; absence must
produce exit 4 and the structured not-detected refusal. Both preserve project and user manifest/lock
nodes. The v2 wire schemas validate every report. These checks exercise local discovery and placement
without authentication, model prompts, provider APIs, or downloaded skills; they do not establish
authenticated agent verification or release qualification.

Each owned child has a 30-second deadline with concurrent output consumption and bounded
process-group TERM/KILL cleanup. Installer bootstrap and installation bounds are 120 and 900
seconds. These bounds do not alter the product detector's existing two-second version deadline
or any full-suite diagnostic run.

## Updating the baseline

Verify official package metadata, executable mappings, Node requirements, and platform optional
dependencies before changing the manifest. For a native tool, verify the vendor's published
artifact manifest, then pin the exact per-platform URL, SHA-256, and byte size; the manifest
schema is version 2 while any native tool is present. Update the table above, provision a fresh
owned prefix, and run both modes plus P4A under both parent environments. Retain package/version
receipts and failure evidence. A new registry tool must be added deliberately to installer
package validation and manifest coverage; a version discrepancy must be diagnosed before any
pin changes. The full repository gate and both hosted environment jobs remain final gates.
