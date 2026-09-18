# Agent executable environments

The ordinary test owner `packages/cli/tests/commands/agent-environments.test.ts` runs three cases:
four-tool discovery, Claude installation prerequisites, and Codex installation prerequisites.
It defaults to deliberate absence and adds no skips. CI runs that owner and the eight P4A fixture
cases separately in both the `present` and `absent` environments, using Bun 1.3.14 on Ubuntu 24.04.

The baseline in `.github/ci-agent-tools.json` is:

| Tool | Executable | npm package | Exact version |
| --- | --- | --- | --- |
| Claude Code | `claude` | `@anthropic-ai/claude-code` | `2.1.202` |
| Codex | `codex` | `@openai/codex` | `0.142.5` |
| Kilo Code | `kilo` | `@kilocode/cli` | `7.4.5` |
| OpenCode | `opencode` | `opencode-ai` | `1.17.18` |

These versions are a reproducible baseline. Kilo Code and OpenCode remain read-only Skillsmith
adapters. The tests compare the manifest IDs and capability facts with the actual registry.

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

The installer bootstraps npm `12.0.1` in that root, then installs the exact four packages with
their required optional dependencies. Its npm lifecycle allow-list names only
`@anthropic-ai/claude-code`, `@kilocode/cli`, and `opencode-ai`; Codex has no postinstall script.
Node must satisfy npm's
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
The PATH contains only owned Git/Node bindings and, in present mode, the four verified tools.
The existing scanner-isolation preload excludes the eight fixed external executable candidates
and records a fresh trace for each invocation. No inherited provider credentials or agent
configuration overrides enter these child environments.

Presence checks direct version output against exact version tokens, then compare the actual
Skillsmith v2 discovery report with the owned binding paths and observed first version lines.
The Codex binding is removed temporarily to prove incomplete discovery fails the same
four-tool completeness assertion, restored in `finally`, and checked again.

Claude and Codex install from synthetic HTTPS identities rewritten to local fixture Git
repositories, with file-only Git transport. The exact invocation uses `--scope user --no-save
--no-verify --json`. Presence must produce the expected symlink, skill bytes, store, and ledger;
absence must produce exit 4 and the structured not-detected refusal. Both preserve project and
user manifest/lock nodes. The v2 wire schemas validate every report. These checks exercise local
discovery and placement without authentication, model prompts, provider APIs, or downloaded
skills; they do not establish authenticated agent verification or release qualification.

Each owned child has a 30-second deadline with concurrent output consumption and bounded
process-group TERM/KILL cleanup. Installer bootstrap and installation bounds are 120 and 900
seconds. These bounds do not alter the product detector's existing two-second version deadline
or any full-suite diagnostic run.

## Updating the baseline

Verify official package metadata, executable mappings, Node requirements, and platform optional
dependencies before changing the manifest. Update the table above, provision a fresh owned
prefix, and run both modes plus P4A under both parent environments. Retain package/version
receipts and failure evidence. A new registry tool must be added deliberately to installer
package validation and manifest coverage; a version discrepancy must be diagnosed before any
pin changes. The full repository gate and both hosted environment jobs remain final gates.
