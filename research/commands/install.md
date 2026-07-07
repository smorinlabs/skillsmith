# install

`skillsmith install` acquires one or more agent skills from a git host: it fetches the repo as a
blobless partial clone, resolves the requested skill (by name, explicit `//path`, or whole-repo
scan), runs the verify gate (static for both tools by default; `--deep` opts codex into
static+deep), pins the skill into the content-addressed store at the resolved commit SHA, places
it for the chosen tools and scope (store symlink by default, `--direct` copy), and records
acquisition provenance in the placements ledger. Alias: `i`.

The repo is never installed — only the selected skill subtree persists (store + placement). By
default, install executes nothing from the fetched repo: no hooks, no scripts, pure file
placement. `--deep` is the one opt-in exception — documented informed consent to run the codex
binary against the fetched, unplaced skill before placement (see Flags below).

Full design — source grammar and parse table, fetch mechanics, ledger schema additions, the
install transaction and its crash story, JSON contract — lives in
`docs/superpowers/specs/2026-07-07-p09-install-design.md`. This page is the command surface.

## Argument order

```
skillsmith install <source>[@<ref>] [<source>...] [FLAGS]
```

At least one `<source>` is required. Flags before or after positionals are both accepted.
Multiple sources process sequentially, fail-fast unless `--continue-on-error`; one ledger lock is
held for the whole invocation.

## Source forms

```
owner/repo                        GitHub sugar; whole repo — exactly one skill installs it,
                                  several → interactive picker (TTY) / list + exit 2 (non-TTY)
owner/repo/<name>                 GitHub sugar; skill resolved BY NAME (repo-wide SKILL.md scan)
owner/repo//path/to/skill         sugar + explicit in-repo path
<host>/owner/repo[/<name>]        host-explicit: gitlab.com/…, git.corp:8443/… — no config
<host>/group/sub/repo//path       GitLab subgroups: multi-segment repo paths require `//`
                                  (trailing bare `//` = whole-repo scan of a subgroup repo)
<git-url>[//path/to/skill]        any https/ssh/scp URL; `//` = explicit path in repo
```

Every form may end with `@<ref>` (tag, branch, or full 40-hex SHA) **after the path portion** —
never inside scp `user@host`. Removed from the April draft: the `repo/skill` default-org form
(ambiguous) and local filesystem paths (`dev --source` / `promote` own local sources). One-part
names are reserved for a future registry and rejected.

## Flags

| Long | Short | Type | Default | Description |
|---|---|---|---|---|
| `--tool` | `-t` | enum, repeatable | all detected tools | Target tool: `claude-code`, `codex`. Explicitly named but not detected → exit 4 with its install hint. |
| `--scope` | `-s` | enum | `project` in a git repo, else `user` | `user` or `project` (`system` deferred). |
| `--user` | — | bool | — | Shorthand for `--scope=user` |
| `--project` | — | bool | — | Shorthand for `--scope=project` |
| `--ref` | — | string | `HEAD` | Canonical ref flag; single-source invocations only; conflicts with that source's `@<ref>` → exit 2. |
| `--pin` | — | bool | false | Freeze the resolved SHA in the ledger against future update-class verbs. The SHA is always recorded either way. |
| `--direct` | — | bool | false | Place a plain copy (materialized from the store entry) instead of a store symlink. |
| `--force` | `-f` | bool | false | Re-execute a no-op, replace an existing placement, override cross-scope shadowing. |
| `--strict` | — | bool | false | Verify-gate `warn`/`inconclusive` verdicts block. |
| `--no-verify` | — | bool | false | Skip the verify gate (recorded as `verify: "skipped"` in the ledger). |
| `--deep` | — | bool | false | Run the deeper promote-parity verify gate on the fetched skill before placement — codex static+deep; claude-code is unaffected. Requires verification; conflicts with `--no-verify` (both set → exit 2). |
| `--continue-on-error` | — | bool | false | Keep processing later sources after a source-level failure. |
| `--dry-run` | — | bool | false | Fetch + resolve read-only and print the full plan; no lock, no store/ledger writes. |
| `--json` | — | bool | false | Versioned JSON report (`kind: "skillsmith.install"`) on stdout; disables the picker. |
| `--yes` | `-y` | bool | false | Accepted no-op — the only interaction is the ambiguity picker, which is a choice, not a confirmation. |
| `--no-prompt` | — | bool | (auto) | Force non-TTY behavior: ambiguity lists candidates and exits 2 instead of prompting. |

## Help output

```
Install agent skills from a git host.

USAGE
  skillsmith install <source>[@<ref>] [<source>...] [flags]

ALIASES
  i

ARGUMENTS
  <source>   One of (repeatable):
               owner/repo                GitHub sugar; whole-repo scan
               owner/repo/<name>         GitHub sugar; skill by name
               owner/repo//path/to/skill explicit path (subgroups: <host>/g/s/repo//path)
               <host>/owner/repo[/<name>] host-explicit (gitlab.com, git.corp, ...)
               <git-url>[//path]         any https/ssh/scp URL
             Append @<ref> (tag, branch, full SHA) after the path portion.

FLAGS
  -t, --tool <name>          claude-code | codex. Repeatable. Default: all detected.
  -s, --scope <scope>        user | project. Default: project in a git repo, else user.
      --user, --project      Shorthand for --scope=user / --scope=project
      --ref <git-ref>        Tag, branch, or full SHA (default: HEAD). Single source only.
      --pin                  Freeze the resolved commit SHA in the ledger
      --direct               Copy files instead of symlinking from the store
  -f, --force                Reinstall / replace / override cross-scope shadowing
      --strict               Verify warnings block installation
      --no-verify            Skip the verify gate (recorded in the ledger)
      --deep                 Run codex static+deep before placement (conflicts with --no-verify)
      --continue-on-error    Keep going after per-source failures
      --dry-run              Print the resolved plan without changing anything
      --json                 Emit the versioned JSON report on stdout

INHERITED FLAGS
  -C, --cd, --color, --no-color, -v, --verbose, -q, --quiet,
  --no-prompt, --debug, -h, --help, -V, --version
  (See 'skillsmith help' for details)

EXAMPLES
  # Rebuild part of the fleet on a new machine (user scope, both detected tools)
  $ skillsmith install smorinlabs/smorinlabs-harness/factor-scan --user

  # Team repo: project-scoped, ref-pinned — resolves identically for every teammate
  $ skillsmith install acme/agent-tools/review@v1.2.0 --project --pin

  # Explicit path into a GitLab subgroup repo, claude-code only
  $ skillsmith install gitlab.com/acme/platform/tools//skills/review -t claude-code

  # Deliberate upgrade or downgrade (store entries are write-once; reverting is
  # another --force --ref away)
  $ skillsmith install smorinlabs/smorinlabs-harness/factor-scan --force --ref v2.0.0

EXIT CODES
  0    installed (or already at the resolved rev — idempotent no-op)
  1    verify gate failed, snapshot/swap error (state recoverable)
  2    usage error or refusal (grammar rejection, ambiguity in non-TTY,
       cross-scope shadowing without --force, ...)
  3    placements ledger unreadable
  4    target tool not detected (explicit --tool), or no tool detected at all
  5    source unresolvable (network, repo/ref not found, skill name not in repo)
  6    permission error (skills dir, store, or ledger not writable)
  130  cancelled (SIGINT; state recoverable)
```

## Error and prompt mockups

**Success (human output):**
```
Installing factor-scan  (smorinlabs/smorinlabs-harness @ 8c1d2e3f4a5b, scope: user)

claude-code  ~/.claude/skills/factor-scan
  verify   static: pass
  store    smorinlabs/smorinlabs-harness@8c1d2e3f4a5b  (new entry)
  place    store symlink                                          installed
codex        ~/.agents/skills/factor-scan
  verify   static: pass
           note: codex static checks the manifest only — run
           'skillsmith verify factor-scan --deep' for a full load check
  store    smorinlabs/smorinlabs-harness@8c1d2e3f4a5b  (reused)
  place    store symlink                                          installed

2 installed.  Exit code: 0
```

**Already installed (idempotent no-op):**
```
factor-scan is already installed at smorinlabs/smorinlabs-harness@8c1d2e3f4a5b
  claude-code  ~/.claude/skills/factor-scan   (store symlink)
Use --force to reinstall, or --ref <ref> to install a different revision.

0 installed, 1 up to date.  Exit code: 0
```

**Ambiguous name (non-TTY, R2):**
```
error: 'review' matches 2 skills in acme/agent-tools @ 8c1d2e3f4a5b:

  acme/agent-tools//plugins/web/skills/review
  acme/agent-tools//plugins/api/skills/review

Re-run with one of the exact paths above.
Exit code: 2
```

**Bare owner/repo with several skills (TTY picker, R3):**
```
$ skillsmith install acme/agent-tools
  acme/agent-tools @ 8c1d2e3f4a5b contains 3 skills:
  ◆ Which skill do you want to install?
  │ ● review      //plugins/web/skills/review
  │ ○ lint        //plugins/web/skills/lint
  │ ○ factor-scan //plugins/fh/skills/factor-scan
  └
```

**Cross-scope shadowing (no --force):**
```
error: 'review' is already placed at user scope for claude-code:

  user     ~/.claude/skills/review          (smorinlabs/agent-tools@1a2b3c4d5e6f)
  project  ./.claude/skills/review          <- installing here

Project-scope skills shadow user-scope skills of the same name for this repo.
Pass --force to install anyway.
Exit code: 2
```

**Codex legacy-root conflict:**
```
error: 'review' already exists in the legacy codex root ~/.codex/skills.
Installing to ~/.agents/skills would leave codex with two copies.

  Remove the legacy copy first:  skillsmith uninstall review --tool codex

Exit code: 2
```

**Source unresolvable (offline / bad ref):**
```
error: cannot fetch acme/agent-tools: ref 'v9.9.9' not found on https://github.com/acme/agent-tools.git

Nothing was written.
Exit code: 5
```

**Local path rejected (R6):**
```
error: install acquires remote sources only — '~/c/agent-tools/skills/review' is a local path.

  For a local checkout, use:
    skillsmith dev review --source ~/c/agent-tools/skills/review
    skillsmith promote review

Exit code: 2
```

## Open questions

None held on this page. The one question this page used to carry — should install grow an
opt-in `--deep` verify gate — was adjudicated at the design gate 2026-07-07: the design gate
chose the alternative over the spec's original static-only recommendation, and `--deep` shipped
(see the flag table and help output above; spec §10, §18 O3). The default is unchanged: static
for both tools, with codex static remaining manifest-only under the default (F9's floor is
"install executes nothing from the fetched repo by default"); `--deep` is documented informed
consent to run the codex binary against the fetched, unplaced skill. codex skill substance is
still unverified by default until `--deep`, a post-install `skillsmith verify --deep`, or a later
`promote`.

Auth/token plumbing (`SKILLSMITH_TOKEN`, `SKILLSMITH_TOKEN_<HOST>` from the design doc §6.3) is
deferred — v1 relies on git's own credential machinery with `GIT_TERMINAL_PROMPT=0`. Revisit with
registry work.
