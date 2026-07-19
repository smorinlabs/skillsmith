# Skillsmith Ergonomics and Workflow — Consolidated Plan

> **Status:** Approved design and implementation baseline as of 2026-07-11. All D-001 through
> D-016 decisions and EWP-CF-001 through EWP-CF-043 findings are recorded and manually closed at
> the design-review level. Phase 0's documentation-drift ledger, structural validator,
> machine-readable verification catalog, generated checklist, executable ownership, and five group
> sign-offs are complete. Whole-Phase-0 adversarial review, catalog recording of the standing
> approval, and exit passed on 2026-07-12. Phase 1's nine groups, whole-phase adversarial review,
> standing approval, and exit passed on 2026-07-13; Phase 2 is active.
> Implementation is authorized to proceed only through the named phase entry/exit gates and
> validation ownership in this plan.
> **Phase 0 execution:** groups=signed-off; review=passed; approval=passed; exit=passed.
> **Phase 1 execution:** groups=signed-off; review=passed; approval=passed; exit=passed.
>
> **Current coverage (2026-07-11):** 34 unique P0-P3 recommendations and matching before/after
> rows; 16 resolved product decisions and records; 16 holistic workflows; 65 named phase tasks;
> 61 named phase tests; 157 unique per-command test slices; 10 option-registry gates; and 43 accepted
> consistency findings including this status scrub. Structural validation and `git diff --check`
> must pass after every amendment.

## Goal

Make Skillsmith a coherent, reproducible, safe skill-management CLI covering discovery, imperative
installation, local development, verification, declarative planning and application, fleet export,
cross-location synchronization, updates, reversal, and store cleanup across supported coding tools.

The completed CLI must be:

- truthful: every advertised flag changes behavior;
- deterministic: identical intent and state produce identical operations;
- reviewable: every mutation has an exact before/after preview;
- reproducible: portable manifest and lock artifacts recreate the same managed fleet;
- reversible: retained state supports safe undo where promised;
- scriptable: JSON and exit codes are stable and complete;
- compact: related behavior is consolidated rather than expressed as many narrow commands;
- testable: each command, option, phase, and holistic workflow has a named validation slice.

## Non-goals

- Executing skills at runtime or mediating agent sessions.
- General skill authoring or scaffolding in the core Skillsmith command surface.
- A hosted registry before direct-source, trust, and reproducibility contracts are stable.
- LLM-based adaptation in the default install/apply path.
- GUI or IDE integration before the CLI workflow is complete.
- Applying or copying the machine-local placements ledger to another machine.

## Sources consolidated

This plan consolidates and supersedes the earlier conversational ergonomics review and its follow-up
design discussions about `apply`, portable manifests, export, lockfiles, and Terraform-style
`plan`. It reconciles those recommendations against the current command implementation and these
repo references:

- `research/skillsmith-cli-design.md`
- `research/skillsmith-phases.md`
- `research/skillsmith-v1-stack-summary.md`
- `research/commands/*.md`
- `docs/superpowers/specs/2026-07-07-promote-dev-design.md`
- `docs/superpowers/specs/2026-07-07-p09-install-design.md`
- `packages/cli/src/program.ts`
- `packages/cli/src/commands/**`
- `packages/core/src/{config,place,acquire,scan,doctor,verify}/**`

No existing research or spec file is replaced or archived by this plan. Phase 0 explicitly checks
where this plan intentionally supersedes older command-design statements.

Explicit supersessions established by the consistency review include the older claims that all four
detected tools are write-capable before 1.0 and that the earlier MVP-2b distribution milestone is
the public 1.0 boundary. The accepted capability matrix and D-016 now govern those claims; Phase 1
documentation work must update or annotate the older active research rather than leaving two
authoritative roadmaps.

### Authority hierarchy

1. Accepted decisions and consistency findings in this plan govern intended 1.0 behavior.
2. `projects/P17-skillsmith-ergonomics-and-declarative-workflow.md` governs project scope, status,
   phase approvals, and the boundary with P14 and deferred Phase 7 work.
3. `projects/P17-GOAL.md` governs the persistent Codex execution process but may not amend this
   plan's product contracts implicitly.
4. `projects/p17/EXECUTION.md`, the machine-readable catalog, and its generated checklist govern
   change-group ownership, dependency order, execution status, evidence, and sign-off. Generated
   views may not override their catalog source.
5. Current code and tests govern only what the shipped binary does today.
6. Active per-command specs describe shipped behavior until their named migration updates them.
7. Older active research is precedent/background, not authority where it conflicts with this plan.
8. `research/archive/` remains historical and is not implementation input.

### Required review and closure order

P17 preserves this methodical order. A later-stage contradiction reopens the earliest affected
stage and every dependent result:

1. Cross-command consistency.
2. Artifact consistency.
3. Command-surface complexity.
4. Overall architecture and quality.
5. Documentation-drift closure.
6. Final executable structural check, adversarial review, and approval.

Phase 0 creates a section-level documentation drift ledger covering active research, command specs,
README, help, and relevant implementation specs. Every conflict is classified update, retain as a
current-behavior migration note, mark superseded with a pointer, or archive. Still-valid crash and
implementation evidence is preserved. No lifecycle implementation phase begins while an active
document presents a known conflicting contract as authoritative.

---

## 1. Product workflow

```text
Discover -> Install -> Develop -> Verify -> Plan -> Apply -> Update -> Undo -> Remove
                  |                     |
                  +------ Export -------+------ Reproduce on another machine

Live location A ---------------------- Sync ----------------------> Live location B
```

### Design principles

1. Declarative files are the source of truth when reproducibility matters.
2. Imperative commands remain available for fast local experimentation.
3. Every fleet or desired-state lifecycle mutation is derived from a shared immutable
   `Operation[]` plan. Narrow config-layer set/unset edits remain validated atomic administrative
   writes and do not invoke fleet reconciliation.
4. A saved reviewed plan cannot silently turn into different operations at apply time.
5. Portable artifacts contain source-relative identity, never machine-local placement paths.
6. Machine state and transaction journals remain local and are not portable lock data.
7. Destructive selection is opt-in, explicitly counted, and previewable.
8. Human output is concise by default; JSON is complete regardless of display verbosity.
9. Existing aliases remain compatible unless a decision explicitly removes them.
10. New top-level commands are added only when the concept is independently discoverable and cannot
    be expressed clearly as an option on an existing command.

---

## 2. Canonical state and artifact model

| Artifact | Purpose | Portable | Commit | Writer |
|---|---|---:|---:|---|
| `skillsmith.toml` | Human-authored desired state and project defaults | yes | yes for projects | user, project `config set/unset`, `init`, default `install`/`uninstall`, `export`, `sync --save`, explicit `update --ref/--pin`, `undo`, deterministic `doctor --fix` migration |
| `skillsmith.lock` | Exact resolved SHAs, source paths, and content hashes | yes | yes for projects | default `install`/`uninstall`, `export`, `apply`, `sync --save`, `update`, `undo`, deterministic `doctor --fix` regeneration |
| `skillsmith.plan` | Ephemeral reviewed operation set with state preconditions | conditionally | no | `plan --out` |
| `placements.json` | Local placements, modes, store paths, dev paths, and recovery journals | no | never | shared mutation/recovery coordinator, including deterministic doctor and GC operations |

### 2.1 `skillsmith.toml` — desired state

Accepted unified project file from D-003:

```toml
version = 1

[defaults]
scope = "project"
tools = ["claude-code", "codex"]

[registry]
default = "github.com/acme"

[[skills]]
name = "factor-scan"
source = "smorinlabs/smorinlabs-harness//plugins/factor-harness/skills/factor-scan"
ref = "main"

[[skills]]
name = "skill-quality"
source = "smorin-harness//plugins/skill-fleet/skills/skill-quality"
ref = "v2.1.0"
tools = ["codex"]
scope = "user"
placement = "copy"
path = "~/.custom/skills"
```

Contains:

- schema version;
- project-level default tool, scope, and optional custom path;
- registry defaults;
- skill source, requested ref, target tools, scope, and policy;
- non-secret values when values support exists;
- compatibility/adaptation policy when those phases land;
- intended placement mode (`symlink` default or `copy`) and optional portable custom path.

Portable identity rules:

- `name` is required and unique within one selected manifest. Do not add a second opaque ID in 1.0.
- One declaration has one source/source-relative path, one requested ref, one scope, and a nonempty
  unique tool list. Changing those fields updates the same named identity and is plan-visible.
- Duplicate names are schema errors even when tool sets do not overlap. Intentional same-leaf
  user/project installations belong in their separate user and project manifests.
- Rename is remove-old plus install-new, never an implicit identity mutation.

The existing scalar `config ... tool` key is a compatibility projection over
`[defaults].tools`, not permission to collapse a plural manifest default. A singleton projects as
the current scalar value. Internally, effective configuration carries one ordered plural tool
selection: each layer replaces rather than merges the lower layer, so CLI tools outrank environment,
explicit-file, project, user, and system values; a higher scalar replaces a lower plural and a
higher plural replaces a lower scalar. With two or more effective tools, unscoped `config get tool`
refuses with state exit 3. A scoped get refuses only when that selected layer is plural. Scoped list
reports that layer's plural value; unscoped list reports the effective selection and source even
when a higher scalar shadows a lower plural. No command chooses the first or last value.

`config set tool <id> --project` visibly replaces the array with that singleton, and
`config unset tool --project` removes the whole default. User/system `config.toml` and environment
layers retain the scalar key. Config get/list v1 add an optional closed `notices` array for plural
and migration metadata; representable cases omit it and retain their exact existing bytes. Set and
unset use named v1 codecs for their current report shapes plus an optional visible migration
operation. Human and JSON modes keep one stdout document and render the same structured notices on
stderr. This compatibility rule forbids silent loss.

Canonical source identity is credential-free host, repository path, optional source-relative POSIX
path, and the separately stored requested ref. The literal acquisition argument and clone URL are
ephemeral transport inputs, not identity. HTTP(S) user information, password/token components, all
query components, fragments, and percent-encoded delimiter/credential forms are rejected before
diagnostic rendering with credential-helper/SSH-agent guidance. Credential-free HTTPS and SSH/scp
forms are accepted; plain HTTP and unauthenticated Git protocols refuse with HTTPS/SSH remediation.
An SSH username may remain only as non-secret transport metadata. `file://` is not a remote install
source and redirects users to `dev --source`. Registry identity is likewise a credential-free
`host[/namespace]` without scheme/query/fragment; exact legacy credential-free HTTPS registry URLs
may normalize to that form, while every other noncanonical legacy registry value blocks automatic
migration with a manual correction.

Reference and pin rules:

- Without `--pin`, a saved declaration preserves the user's requested branch, tag, or default-ref
  intent; the lock still records the exact resolved SHA.
- With `--pin`, the declaration's `ref` is rewritten to the resolved full SHA. Pinning therefore
  changes portable desired state rather than duplicating the lock's normal exact resolution.
- Exact SHA and fixed-tag declarations do not produce update candidates unless the user supplies a
  new `--ref` explicitly.
- `update <skill> --ref <moving-ref>` resumes tracking that ref;
  `update <skill> --ref <ref> --pin` resolves it once and stores the resulting SHA.
- `--no-save --pin` retains the local ledger marker because no portable declaration is written.

Must not contain:

- absolute home paths;
- store paths;
- local recovery journals;
- transaction IDs;
- resolved secrets;
- literal clone URLs or credential-bearing source arguments;
- query/fragment authentication data;
- absolute, drive-qualified, UNC, escaping, store, ledger, or dev-checkout paths.

Imperative-to-declarative option translation:

| Persisted from install | Manifest field/effect |
|---|---|
| source and selected skill | `source` and unique `name` |
| `--ref` | requested `ref` |
| `--pin` | resolved full SHA stored as `ref` |
| `--tool` | unique nonempty `tools` |
| `--scope` | `scope` |
| `--direct` | `placement = "copy"`; otherwise canonical symlink default |
| `--path` | normalized portable `./project-relative` or `~/home-relative` path |

`--force`, `--strict`, `--deep`, `--no-verify`, `--continue-on-error`, dry-run, approval, output,
and verbosity controls are execution-only and never become persistent project policy implicitly.
No-verify still records the actual skipped result in local ledger state; future apply uses its own
verification policy.

Relative CLI path arguments resolve from the effective cwd selected by `-C`; project-contained
custom paths then serialize relative to the resolved project root. User-manifest paths under home
serialize with `~/`. Normalize separators, forbid `..` escape, and never write another absolute
path. A default-saving custom path that cannot be represented portably refuses before any mutation
and recommends a portable path or `--no-save`. Custom paths remain limited to one source and one
tool. Apply resolves the token under the recorded project root or home; locks never contain
placement paths.

Migration requirements:

- Discriminate shape before strict parsing. Canonical files have `version` and only canonical
  sections. Legacy files omit `version` and contain only the recognized top-level `tool`, `scope`,
  `path`, and `registry` form. Mixed canonical/legacy, empty, malformed, and unknown-key files are
  state error 3; never guess precedence or interpret them as an empty manifest.
- Continue read-only support for the exact legacy shape throughout 1.x, with removal no earlier than
  2.0. Read-only commands extract effective defaults, report `migrationPending: true`, and leave
  bytes unchanged. A legacy file is configuration-only until migrated and therefore can never grant
  empty-manifest prune/apply authority.
- Canonical project writers include a visible `migrate-project-config` operation before their
  requested edit: `config set/unset --project`, `init`, default-saving install/uninstall, export,
  `sync --save`, and applicable apply execution. Plan normalizes in memory and records the operation
  but remains read-only. A saved operation stales if another process migrates first.
- Migration adds `version = 1`, maps `tool` to the one-element `defaults.tools` array, moves `scope`
  and portable `path` under `[defaults]`, and preserves `registry`. It uses the lossless editor and
  artifact coordinator, preserving comments, ordering where structurally possible, permissions,
  and newline form. If comment attachment or a concurrent edit cannot be preserved safely, refuse
  with the exact manual patch rather than falling back to whole-file serialization.
- A project-contained relative path becomes a normalized project-relative token. A legacy absolute
  or escaping path, or a scope not representable in portable desired state, blocks automatic
  migration and explains whether to move the value to user/system config or replace it with a
  portable value. No value is silently dropped.
- `doctor` reports the legacy shape; `doctor --fix` runs the same deterministic migration with
  dry-run and approval, so no standalone migrate command is added. Migration alone creates no lock;
  a lifecycle operation creates or updates the lock only when it resolves declarations.
- `--config` remains a configuration-layer selector and `--file` remains an artifact selector. If
  both select the same canonical path, parse once and expose its defaults and desired-state roles
  separately. If they select the same legacy path, the artifact role remains unavailable until the
  visible migration operation executes.

#### Shared project context and path bases

Every project-aware command consumes one immutable `ProjectContext` resolved after global `-C` and
before config, artifact, tool-root, or placement discovery. It keeps these concepts separate:

```text
effectiveCwd
projectRoot
discoveredProjectManifest
explicitArtifactPair
stableProjectIdentity
```

Resolution contract:

1. Resolve `-C` against the process cwd, require an existing directory, and retain the resulting
   absolute path as `effectiveCwd` for relative CLI inputs and useful diagnostics.
2. Inside a Git worktree, set `projectRoot` to the realpath of
   `git -C <effectiveCwd> rev-parse --show-toplevel`; this handles normal repositories and
   worktrees without assuming `.git` is a directory.
3. Outside Git, the directory of the nearest discovered canonical `skillsmith.toml` is the project
   root. If none exists, explicit project scope uses the realpath of `effectiveCwd`; without
   explicit project scope, the default remains user scope and project root is absent.
4. Inside Git, discover the nearest canonical project manifest from `effectiveCwd` up to and
   including `projectRoot`, but do not let a nested manifest relocate live tool roots. It may own
   configuration and desired state while live project placement remains rooted at the Git top-level.
5. An explicit `--file` selects an artifact pair only. It never silently rebases project placement,
   scanning, ledger identity, or custom-path containment.
6. Use the real project-root path as stable ledger identity. Human/JSON output also includes the
   recognizable effective or requested path when it differs.
7. Install, uninstall, list, commands, status, doctor, config, init, export, plan, apply, sync,
   update, project tool roots, and custom-path validation must use this same context rather than
   resolving cwd/project independently.

The nearest discovered manifest is an intentional desired-state context boundary. Cwd changes
within the same ancestor chain must select the same candidate; crossing into a subtree with its own
manifest intentionally selects that nested context without changing `projectRoot`. Automatic
declaration-owner lookup considers the selected project manifest, the project-root destination when
it is a distinct file, and the XDG user manifest—not an unbounded repository-tree scan. Every
existing candidate is shape-checked before ownership is inferred; malformed state refuses. One
unique owner wins, while any selected/root/user duplicate-name combination refuses with exit 2 and
names every candidate. For a genuinely new project declaration, the destination remains
`<projectRoot>/skillsmith.toml`; explicit `--file` still wins. The root destination is therefore
never misclassified as new when it already owns the name, while nested configuration remains a
separate context and never rebases live placement.

Before/after example:

```text
Repository root: /work/acme
Effective cwd:   /work/acme/packages/api

Before:
  install --project -> /work/acme/.claude/skills/review
  list --project    -> /work/acme/packages/api/.claude/skills
  config --project  -> /work/acme/packages/api/skillsmith.toml

After:
  projectRoot       -> /work/acme
  install/list/status/config all use that project identity
```

If `/work/acme/packages/api/skillsmith.toml` already exists, it may be the discovered artifact and
configuration source without moving live project skill roots below `/work/acme`. Likewise,
`--file ./team-state.toml` selects `team-state.toml`/`team-state.lock` but does not change
`projectRoot`. A deliberately different live destination uses the existing `--path` contract, not
artifact location.

Default manifest destination for saving lifecycle commands:

1. an explicit `--file` path;
2. after source/name resolution, the single existing user or discovered-project manifest that
   already owns that unique name;
3. if both manifests own it, refuse and require `--file`;
4. for a new project-scoped declaration, a project `skillsmith.toml` at the shared
   `ProjectContext.projectRoot`;
5. for a new user-scoped declaration, the user desired-state manifest at
   `$XDG_CONFIG_HOME/skillsmith/skillsmith.toml`.

The user desired-state manifest is distinct from `$XDG_CONFIG_HOME/skillsmith/config.toml`, which
continues to hold user configuration defaults. `uninstall` never creates an empty manifest merely
to record absence. If the owning declaration is ambiguous across manifests, it refuses and asks for
`--file` rather than modifying an arbitrary file.

Before/after examples:

```text
# New personal installation while cwd is inside a repository
skillsmith install acme/tools//review --user

Before: project skillsmith.toml does not declare review
After:  ~/.config/skillsmith/skillsmith.toml declares review at user scope
        project skillsmith.toml is byte-identical
```

```text
# Project intentionally owns a user-scoped declaration
skillsmith install acme/tools//review --user --file ./skillsmith.toml

Before: project manifest selected explicitly
After:  ./skillsmith.toml declares review with scope = "user"
        later installs/uninstalls find this unique owning declaration
```

```text
# Same name exists in user and project manifests
skillsmith uninstall review

Before: two possible owners
After:  no files or placements changed; exit 2 asks for --file
```

Every saving mutating command names the selected artifact pair in human and JSON output.
Install/uninstall `--no-save` instead report an explicit null pair, selection `none/no-save`,
portable state not inspected or changed, and drift `not-evaluated` with a conditional future-apply
effect; they perform no portable ownership discovery. For example, a saving command reports:

```text
Saved desired state:
  ~/.config/skillsmith/skillsmith.toml
  ~/.config/skillsmith/skillsmith.lock
```

One invocation selects exactly one manifest. `--file <path>` is singular and is the only explicit
manifest-input form; there is no positional manifest and no repeatable composition in 1.0. The
canonical `skillsmith.toml` pairs with sibling `skillsmith.lock`; another filename such as
`team.toml` pairs with sibling `team.lock`. The advanced singular `--lockfile <path>` override
requires explicit `--file` and is available uniformly on status, doctor, check, install, uninstall,
export, plan, fresh apply, sync with save, and update. It is invocation context, not manifest data,
so direct later invocations must repeat both flags. Every result reports the exact selected pair.
A saved plan records the exact pair and cannot be combined with a different file override; a
portable relative override remains portable while an absolute local override makes that plan
machine-bound. Init creates only a manifest and does not accept lockfile. Prune authority is limited
to the selected manifest's declared tools and scopes. Multi-manifest composition is deferred until
a concrete workflow cannot be handled by sync, export, or generating one manifest.

### 2.2 `skillsmith.lock` — portable resolution

Accepted separate committed file from D-004:

```toml
version = 1
hash_schema_version = 1
manifest_hash = "sha256:<digest>"

[[skills]]
name = "factor-scan"
source = "smorinlabs/smorinlabs-harness//plugins/factor-harness/skills/factor-scan"
requested_ref = "main"
resolved_sha = "0123456789abcdef0123456789abcdef01234567"
source_path = "plugins/factor-harness/skills/factor-scan"
content_hash = "sha256:<digest>"
```

Rules:

- `manifest_hash` is the versioned `manifest-semantic` domain hash from Section 2.5; comments,
  whitespace, TOML ordering, permissions, and newline style do not affect it.
- A locked entry identifies exact portable bytes, not local placement state.
- `source` is the credential-free canonical source identity and `source_path` is relative POSIX;
  literal clone URLs, userinfo, query/fragment credentials, and local/store paths are invalid.
- The paired lock has exactly one entry for every manifest name and no extra entries. Missing entries
  are unresolved; extra entries are stale.
- Lock/declaration correlation uses the unique manifest name; source/ref/scope/tool changes remain
  updates to that identity.
- `apply --locked` refuses missing, stale, or incomplete lock data.
- The parsed lock bytes must exactly equal canonical generated serialization. Noncanonical manual
  formatting/reordering is invalid state (exit 3) and uses documented regeneration/repair.
- Interactive default apply may propose a lock update; the plan must show it.
- CI and reproducible-machine workflows use `--locked`.
- No initial standalone `lock` command; existing workflow commands maintain the lock.

### 2.3 `skillsmith.plan` — reviewed execution

Accepted optional saved plan from D-002:

```json
{
  "schemaVersion": 1,
  "kind": "skillsmith.plan",
  "skillsmithVersion": "<version>",
  "executorSchemaVersion": 1,
  "hashSchemaVersion": 1,
  "portability": { "kind": "portable", "reasons": [] },
  "manifestSemanticHash": "sha256:<digest>",
  "lockCanonicalHash": "sha256:<digest>",
  "options": { "prune": false, "locked": true },
  "operations": [],
  "checks": [],
  "diagnostics": [],
  "resourcePreconditions": [],
  "selectionPreconditions": [],
  "capabilityPreconditions": []
}
```

Required saved-plan data:

- schema and Skillsmith versions;
- manifest-semantic and lock-canonical digests plus hash schema version;
- per-operation ledger/live/store resource fingerprints;
- complete selected-set fingerprints for bulk, all, prune, and delete behavior;
- only the tool/operation capability fingerprints the plan depends on;
- exact resolved source identities and hashes;
- selected tools, scopes, manifests, and behavior-changing options;
- ordered operations with before-state, after-state, reason, and preconditions;
- redacted values only;
- an explicit `portability` classification: `portable` with no reasons, or `machine-bound` with
  stable reason codes and human explanations.

Apply rules:

- `apply --plan` never silently recalculates different operations.
- Saved-plan apply treats the reviewed artifact as prior authorization and does not prompt or accept
  yes. Dry-run validates and renders the exact saved operations with exit 0 when valid; check does
  the same with exit 0 for no executable operations or 7 for a valid nonempty operation set. Stale
  or incompatible preconditions are state error 3, never drift 7. Both modes leave every state file
  and the plan byte-identical and never replan from a manifest.
- With plan, dry-run and check conflict each other. JSON and inherited output/context assertions are
  allowed; file, lockfile, tool, scope/sugar, locked, prune, yes, and continue-on-error are usage
  errors because they could reinterpret or redundantly authorize the reviewed operation set.
- Apply acquires mutation locks and revalidates every precondition.
- Manifest semantic hash ignores human-only formatting while changing for every normalized semantic
  field. Lock canonical hash identifies exact required canonical generated bytes. Targeted
  operations invalidate only when referenced resources change; unrelated resources do not.
- `--all`, `--prune`, and delete-style plans fingerprint the complete selected destination set so a
  new entry that would have changed the plan invalidates it.
- Record the producing Skillsmith version for audit, but gate execution on saved-plan schema,
  executor compatibility, and referenced capabilities rather than every patch-version difference.
- A stale-plan error names each changed dependency and tells the user to regenerate.
- Plan files default to user-only permissions and are not recommended for version control.
- Portable plans contain no local absolute paths and may execute wherever every portable
  precondition matches. Machine-bound plans may retain required local paths after secret redaction,
  name each binding reason (for example local dev source or absolute live placement), and require
  matching local project/resource preconditions. Cross-machine fleet transport uses manifest plus
  lock and a newly generated plan; saved plans are not presented as a replacement for export/apply.

### 2.4 `placements.json` — local operational state

Current default: `~/.local/share/skillsmith/placements.json`, subject to `SKILLSMITH_HOME`/XDG.

Contains:

- absolute live placement paths;
- absolute dev source paths;
- `dev`/`pinned` mode;
- store paths and retained pin data;
- source origin where known;
- verify status;
- journals and crash-recovery state;
- per-project placement state;
- credential-free canonical source identity; never the literal acquisition URL or authentication
  material.

It is never:

- accepted as an apply input;
- copied as a fleet backup;
- committed;
- treated as the portable lockfile.

The 1.0 canonical local schema is version 2. It retains the existing top-level user `skills`,
realpath-keyed `projects`, and pair records while adding only coordinator-owned state:

```json
{
  "schemaVersion": 2,
  "kind": "skillsmith.placements",
  "updatedAt": "<timestamp>",
  "skills": {},
  "projects": {},
  "projectRegistrations": {},
  "transactions": {},
  "history": []
}
```

- `projectRegistrations` owns exact realpath project roots and local GC protection metadata even
  when a project is temporarily unavailable.
- `transactions` owns coordinator journals that span live, manifest, lock, and ledger commit points.
- `history` owns bounded committed before-state and retention references used by undo and GC.
- Version-1 per-pair journals remain valid compatibility records until their same-operation resume
  or pending undo resolves them; migration does not reinterpret or discard them.

Ledger evolution contract:

1. A missing file alone means an empty ledger. An existing zero-byte, whitespace-only, truncated,
   malformed, or schema-invalid file is state error 3 and is never reset or overwritten as empty.
2. Every ledger consumer discriminates the version before strict decoding. Read-only commands decode
   supported version 1 into the canonical in-memory model, report `migrationPending: true`, and do
   not rewrite. Dry-run and plan likewise remain byte-identical and include a visible
   `migrate-ledger` operation when execution would require it.
3. The first actual mutation migrates version 1 to version 2 under the existing ledger lock before
   dependent operations. It validates semantic equivalence, stages and flushes canonical version 2,
   preserves the original through the commit window, atomically replaces it, and removes the
   temporary migration backup after the first successful version-2 commit.
4. `doctor` reports the pending migration; `doctor --fix` runs the same deterministic operation,
   with dry-run and approval behavior, so there is no separate `migrate` command.
5. An unresolved legacy journal allows only compatible same-operation resume or pending undo;
   unrelated mutation refuses with exact remediation. Migration preserves that journal before
   recovery continues.
6. A newer unknown schema refuses without writes and names the minimum Skillsmith upgrade needed.
   A failed migration leaves the original bytes and every live/portable artifact unchanged.
7. A saved plan generated against version 1 contains `migrate-ledger`; if another process migrates
   first, its ledger-schema precondition is stale and apply requires a regenerated plan.

### 2.5 Artifact write and locking policy

| Artifact | Policy |
|---|---|
| `skillsmith.toml` | Lossless targeted edits preserving comments, order, whitespace, permissions, and unrelated schema-valid content |
| user/system `config.toml` | Same lossless targeted-edit policy |
| `skillsmith.lock` | Deterministic canonical generated serialization; full rewrite allowed |
| `skillsmith.plan` | Deterministic canonical generated JSON |
| `placements.json` | Deterministic canonical generated JSON with the version-1-to-2 migration and recovery contract in Section 2.4 |

Hash format and domains:

```text
SHA256("skillsmith:" + domain + ":v1\0" + canonicalInput)
serialized as sha256:<64 lowercase hexadecimal characters>
```

Portable generated artifacts carry `hash_schema_version = 1` in TOML or `hashSchemaVersion: 1` in
JSON. A field's domain is not interchangeable with another domain even when canonical inputs happen
to match.

| Domain | Canonical input | Use |
|---|---|---|
| `manifest-semantic` | Parsed normalized manifest model | Manifest/lock correlation and saved-plan artifact precondition |
| `manifest-bytes` | Exact current manifest bytes | Local concurrent-write guard only; never portable identity |
| `lock-canonical` | Exact canonical lock serialization | Saved-plan exact resolution precondition |
| `source-content` | Canonical portable-relative skill/plugin tree | Store and reproducible source identity |
| `resource` | Canonical relevant ledger/live/store facts | Targeted saved-plan precondition |
| `selection-set` | Sorted resource identities plus fingerprints | All/prune/delete membership precondition |
| `capability` | Tool, operation, adapter version, support state | Relevant executor-capability precondition |

Manifest-semantic canonicalization includes schema version, normalized defaults/registry, and
declarations sorted by unique name with schema-ordered fields, deduplicated/sorted tools, normalized
source/ref/scope/placement, and normalized portable paths. It excludes comments, whitespace, TOML
ordering, permissions, newline form, local paths, and runtime state.

Source-content canonicalization records sorted relative POSIX path, entry type, executable bit where
relevant, file length+bytes, allowed internal symlink target, and preserved empty directories. It
rejects path escape/unsafe symlink traversal, ignores timestamps and platform separators, and uses
one explicit versioned exclusion list rather than OS-dependent filtering.

Portability and redaction boundary:

- Portable fields accept only credential-free canonical sources, project-relative `./...`, allowed
  home-relative `~/...`, and source-relative POSIX paths. Normalize separators and reject `..`
  escape, absolute/drive/UNC paths, store/ledger/dev paths, URL userinfo, query authentication, and
  fragments before any artifact write.
- The local ledger and machine-bound plans may retain operationally required absolute paths, but no
  artifact may retain authentication material or the literal credential-bearing acquisition input.
- One recursive redactor runs before human/JSON output, debug traces, errors and nested causes,
  journal persistence, ledger persistence, and saved-artifact serialization. It covers recognized
  credential URL components and known secret environment/config keys across objects and arrays.
- Redaction does not hide ordinary repository names, refs, hashes, or local paths needed for useful
  machine-local diagnosis. Authentication is used only in memory for acquisition and never changes
  source identity or a portable hash.
- Credential canaries are scanned across every output stream, generated artifact, temporary,
  journal, backup, and partial-failure/crash residue. Any occurrence is a release-blocking failure.

Requirements:

- Phase 2 starts with a bounded CST/range-preserving TOML editor spike. Do not extend the current
  plain-object parse/stringify writer for human-authored files.
- If an edit cannot be represented safely and losslessly, refuse without writing and provide the
  exact manual edit. Malformed or schema-invalid content is never normalized as a side effect.
- A semantic no-op leaves human-authored bytes and permissions unchanged.
- Acquire one stable artifact-group coordination lock that works even when the manifest and lock do
  not exist; never create a destination merely to obtain a lock.
- Stage sibling temporary files, flush file and directory metadata, preserve modes, and use the
  transaction journal to recover the unavoidable manifest/lock two-file commit window.
- After acquiring the artifact-group lock, compute an exact manifest-bytes guard. Immediately before
  replacement, recheck it; if an external writer ignored coordination, reparse/replan the targeted
  lossless edit when provably safe or refuse without overwriting.
- Dry-run, validation failure, conflict refusal, lock contention, rejected approval, and
  cancellation leave no destination, empty placeholder, lock, staging, or backup residue.
- Manifest-semantic hashes ignore formatting; every semantic field change changes the normalized
  input. Lock bytes must equal canonical serialization, and lock canonicalization is independent of
  manifest whitespace/comments.

---

## 3. Consolidated command surface

### 3.1 Existing commands retained and corrected

```text
agents
config get|set|list|unset
list | ls
commands
doctor
check
verify
install | i
uninstall | rm | remove
dev | demote
promote
completion
version
help
```

### 3.2 Proposed new top-level commands

```text
init
export
status
plan
apply
sync
update
undo
gc
```

### 3.2.1 Canonical help and documentation groups

The flat surface is intentionally presented by workflow rather than as an alphabetical wall:

```text
DISCOVER
  agents  list  commands  status

MANAGE
  install  uninstall  update  undo

DEVELOP
  dev  verify  promote

DECLARATIVE
  init  export  plan  apply  sync

MAINTAIN
  doctor  check  gc  config  completion  version  help
```

Root help, README command orientation, generated command reference indexes, and
`skillsmith help workflows` use these groups and this order. Aliases appear beside the canonical
command, not as additional entries. `commands` is always labeled “list installed slash commands” so
it is not confused with a CLI command index. Typo suggestions and completion still cover the entire
flat surface. Reconsider hierarchy only when Skillsmith gains a genuine second primary resource
type.

### 3.3 Proposed concepts deliberately consolidated away

| Earlier proposal | Consolidated surface | Rationale |
|---|---|---|
| `add` | default-saving `install`; `--no-save` for temporary use | Avoid a second installation grammar |
| manifest `remove` | default-saving `uninstall`; `--no-save` for live-only removal | Avoid conflict with current `remove` alias |
| `link` | `dev <name> --source <path>` | Existing concept is sufficient with better help |
| `show` | `status [skill...]` and `list --long` | One detailed-state command |
| `outdated` | `update --check` | One update lifecycle command |
| `diff` | `update --dry-run` and plan before/after | Diff is part of planning, not a separate lifecycle |
| `recover` | `undo` plus idempotent resume | Avoid overlapping reversal verbs |
| `lock` | automatic lock maintenance | Avoid a command without an independent day-to-day task |
| `store gc` | `gc` | Store is the only GC-managed resource |
| `enable`/`disable` | defer to a post-core follow-up; command shape undecided | Cross-tool writes are not ready |
| `search` | defer until registry exists | Avoid implying a registry today |
| skill scaffolding | out of core scope | Preserve install/placement product boundary |

### 3.4 Priority before/after index

| ID | Before | After |
|---|---|---|
| P0-01 | Global flags are advertised but inconsistently consumed | One functional inherited command context |
| P0-02 | Config can be stored but operational commands bypass it | Shared effective-config precedence drives every command |
| P0-03 | Invalid tools/scopes crash, serialize internals, or silently empty | Shared validation and capability errors, exit 2 |
| P0-04 | `check` can report errors and exit 0 | `check` gates by default; report-only is explicit |
| P0-05 | README/help reflect older milestones | Live, tested command/capability documentation |
| P0-06 | Core objects/runtime failures leak into human output | Unified human and JSON error boundaries |
| P0-07 | Project config and planned manifest collide on one strict filename | One resolved schema/file decision with migration |
| P0-08 | Component tests miss false CLI affordances | Spawned CLI promise tests cover actual behavior |
| P1-01 | Default list is enormous and filesystem-ordered | Compact deterministic default; detail behind long output |
| P1-02 | No view joins desired, locked, ledger, and live state | `status` presents one correlated state model |
| P1-03 | Duplicate detection can mix different tools | Duplicate/shadow identity is tool-qualified |
| P1-04 | Bulk mutations can proceed without meaningful approval | Exact plan plus TTY confirmation or automation yes |
| P1-05 | Users hand-create an underdefined project file | `init` creates canonical desired-state skeleton |
| P1-06 | No route from installed fleet to portable files | `export` produces manifest plus lock from portable provenance |
| P1-07 | Planning is hidden in per-command dry-run flags | Discoverable canonical `plan` command |
| P1-08 | No manifest reconciliation executor | `apply` plans, confirms, executes, or consumes exact saved plan |
| P1-09 | Install/uninstall do not maintain desired state | Save live state, manifest, and lock by default; `--no-save` is explicit |
| P1-10 | Planned sync overlaps unclearly with apply/export | Narrow live-A-to-live-B sync over shared planner |
| P1-11 | Rollback is split across mutation verbs | Unified `undo`, with compatibility aliases |
| P1-12 | Primary install path is clone/build from source | Native/package-manager distribution and upgrade path |
| P2-01 | Machine output flag and stderr conventions vary | Consistent JSON alias/schema and stdout/stderr contract |
| P2-02 | Update requires reinstall/force/ref knowledge | One update lifecycle with check and dry-run |
| P2-03 | Store entries are retained forever with no maintenance | Safe reachability-based GC |
| P2-04 | Completion omits aliases/nested commands/inherited flags | Recursive local-aware completion |
| P2-05 | Help lacks grouping and typo guidance | Workflow groups, current topics, did-you-mean |
| P2-06 | “Supported tool” obscures operation coverage | Explicit per-tool capability matrix |
| P2-07 | Doctor only reports even deterministic repairs | Narrow previewable safe-fix allowlist |
| P2-08 | Rendering/log dependencies and flags are disconnected | Wire or remove them; verify TTY/pipe behavior |
| P3-01 | Cross-tool transforms are absent | Deterministic plan-visible adaptation overlays |
| P3-02 | Enabled state is readable but not safely writable cross-tool | Post-core enable/disable follow-up after every other planned command |
| P3-03 | No registry/search contract | Add only after identity/trust/reproducibility design |
| P3-04 | Third-party instruction trust is outside the workflow | Explicit provenance/hook/adaptation security layer |
| P3-05 | Windows/additional adapters/man pages/GUI are incomplete | Gate ecosystem expansion behind stable core lifecycle |
| P3-06 | Completion emission has no cross-distribution installer | Post-1.0 installer design with explicit ownership and rollback |

---

## 4. P0 — correctness and truthful affordances

### P0-01 Functional global command context

**Before:** `-C`, `--quiet`, `--verbose`, `--debug`, and color controls are accepted without
consistent operational effect.

**After:** every action receives one resolved context containing effective cwd, typed
configuration, output mode, color, verbosity, interactivity, operation context, observer, and
signal.

**Acceptance:**

- `-C` changes manifest discovery and project-scope results.
- Global flags work before or after the subcommand.
- `--quiet` suppresses non-error human output.
- `-v` shows operational detail; `-vv`/`--debug` shows traces on stderr.
- Color never contaminates JSON or piped output.
- Subcommand help lists inherited flags.

### P0-02 Operational config consumption

**Before:** config can be set and read, but operational commands bypass effective config.

**After precedence:** CLI > environment > project defaults > user config > system config > built-in.

**Acceptance:** setting a default tool changes an operational command without `--tool`; explicit
flags override it; `--config` works; `config list` reports source layers.

### P0-03 Uniform tool/scope validation

**Before:** invalid tools produce inconsistent internal errors, crashes, or empty results.

**After:** shared option builders validate enums and capabilities; every invalid value exits 2 with
allowed values; unsupported operation/tool pairs produce a capability message.

### P0-04 CI-correct `check`

**Before:** error findings can exit 0 unless `--exit-code` is remembered.

**After:** `check` fails on any error by default; `--report-only` is the explicit non-gating mode.

### P0-05 Current docs and help

**Before:** README/help describe older milestones and omit implemented commands.

**After:** live command inventory, capability matrix, current examples/exit codes, generated or
contract-tested references, and no internal research path as the primary manual.

### P0-06 Human/JSON error boundary

**Before:** serialized core objects or runtime exceptions can reach human stderr.

**After:** one human formatter and one versioned JSON error envelope; traces only under debug;
stdout remains data-only.

### P0-07 Resolve project config/manifest collision

**Before:** current strict project config and future manifest claim `skillsmith.toml` with
incompatible schemas.

**After:** implement D-003, migrate legacy shape, and add schema/version diagnostics.

### P0-08 User-promise integration tests

Tests cover every item above at the spawned CLI boundary, not only core helpers.

---

## 5. P1 — complete the primary lifecycle

### P1-01 Compact deterministic `list`

Default columns: tool, scope, known mode, name, and non-default enabled state. Stable sort by tool,
scope, name. `--long` adds placement, origin, source, revision, store, verification, description.

### P1-02 Ledger-aware `status`

Correlates manifest, lock, ledger, filesystem, verification, shadowing, and journal state. Replaces
separate `show` and most proposed list-state flags.

### P1-03 Correct duplicates

Duplicate identity is `(tool, skill-name)`; diagnostics name all paths/scopes and the shadow winner.

### P1-04 Safe bulk mutation

Bulk promote/dev/uninstall/update/undo, apply prune, sync delete, and GC display exact selection;
TTY confirmation or automation `--yes`; `--dry-run` is non-mutating; no accepted no-op options.

### P1-05 `init`

Creates the canonical manifest skeleton; explicit file/scope selects project or user ownership,
while no-scope defaults to the Git root when present and otherwise the XDG user manifest. Detects
defaults, refuses overwrite without force, and does not import live state.

### P1-06 `export`

Captures portable managed provenance from live state into manifest plus lock; clean Git dev sources
may be converted to remote/source-relative identity; dirty/non-Git/unmanaged entries warn and skip,
or fail under strict.

### P1-07 `plan`

Canonical explicit manifest reconciliation preview, including before/after, lock updates,
adaptations, moves, removals, and unchanged summary. Supports check and optional saved output.

### P1-08 `apply`

Plain apply plans, displays, confirms, locks, revalidates, executes, and reports. Saved-plan apply
executes only the reviewed operation set after precondition checks. Prune remains opt-in.

### P1-09 Desired-state-first install and uninstall

`install` and `uninstall` update live state, manifest, and lock consistently by default without
introducing `add`/manifest-`remove` commands. `--no-save` explicitly requests a temporary live-only
operation and reports the resulting declared/live drift and future `apply` behavior.

### P1-10 Narrow `sync`

Live A -> live B reconciliation using the shared planner. `--save` additionally creates/updates the
destination portable files. `--delete` is opt-in.

### P1-11 `undo`

Unified reversal for safe retained placement transitions. Existing verb-specific rollback forms
remain compatibility aliases. Rerunning the same operation resumes it; `undo` aborts a selected
pending operation to its recorded before-state or reverses an eligible committed operation.

### P1-12 Distribution

Native release assets, checksums, Homebrew, npm/Bun strategy, upgrade docs, and verified capability
matrix replace clone/build-from-source as the primary onboarding.

---

## 6. P2 — lifecycle and quality-of-life

### P2-01 Consistent output selection

`--json` on data commands; `agents --json` compatibility alias; one JSON value; stderr diagnostics;
no progress when piped.

### P2-02 `update`

Consolidates update, outdated, and diff: `--check` discovers change, `--dry-run` shows before/after,
default respects pin policy, execution updates lock and placements, old store state supports undo.

### P2-03 `gc`

Reclaims only store entries unreachable from live placements, the local ledger, journals, backups,
adapted overlays, and undo/age retention. It never crawls for portable lockfiles. Missing recorded
projects remain protected until explicitly forgotten by exact path. Dry-run, age policy, byte
totals, confirmation.

### P2-04 Completion

Nested config verbs, aliases, inherited flags, enums, local skill/path/manifest completion; no
network completion by default. The 1.0 command is emit-only; distribution packages or documented
manual steps own installation.

### P2-05 Help discovery

Typo suggestions, Discover/Manage/Develop/Declarative/Maintain command groups, workflow examples,
capabilities, `help workflows`, and dedicated manifest/lock/plan/source topics.

### P2-06 Capability visibility

`agents --capabilities` or default capability columns distinguish operation coverage rather than one
misleading “supported” claim. The 1.0 baseline is:

| Capability | Claude Code | Codex | Kilo Code | OpenCode |
|---|---:|---:|---:|---:|
| Detect installation | yes | yes | yes | yes |
| Inventory skills/commands | yes | yes | yes | yes |
| Doctor/read-only diagnostics | yes | yes | yes | yes |
| Install/uninstall | yes | yes | no | no |
| Dev/promote/undo | yes | yes | no | no |
| Static verification | yes | yes | no | no |
| Deep verification | yes, isolated load-presence | yes, isolated load | no | no |
| Manifest plan/apply/sync/update | yes | yes | blocking capability diagnostic | blocking capability diagnostic |

Standalone `verify --deep` runs static plus deep modes for both Claude Code and Codex. Automatic
lifecycle gates remain policy-driven: install defaults to static and its current `--deep` enhancement
is Codex-specific; promote uses the minimal skill-covering gate (Claude static, Codex static+deep).
Availability of a verifier mode and the default gate policy are separate concepts.

| Scope | 1.0 behavior |
|---|---|
| `user` | Read/write for full-lifecycle tools |
| `project` | Read/write for full-lifecycle tools |
| `system` | Inventory/diagnostics only |
| `managed` | Inventory/diagnostics only |
| explicit custom path | Write only when the selected full-lifecycle adapter supports it |

Read commands accept all four known tool names. Mutation commands recognize Kilo Code and OpenCode
but return capability-unavailable exit 4 rather than invalid-input exit 2. Truly unknown tools remain
usage errors. Manifests and plans never silently ignore unsupported tool targets.

### P2-07 Safe `doctor --fix`

Only deterministic reversible repairs; always previewable; never delete/overwrite ambiguity.

### P2-08 Dependency/render cleanup

Wire or remove unused color/log dependencies; test binary size and TTY/pipe rendering.

---

## 7. P3 — deferred/conditional capabilities

### P3-01 Deterministic cross-tool adaptation

Tool overlays, plan-visible transformation diff, no-adapt escape hatch, no default LLM execution.

### P3-02 Enable/disable writes

Defer to a separately approved follow-up after every other retained and proposed P0-P2 command is
implemented and validated. That follow-up must first define cross-tool capability, placement versus
configuration semantics, scope/precedence, rollback, and unsupported-tool behavior; only then choose
between top-level verbs, config subcommands, or no generic write operation.

### P3-03 Registry/search

Only after registry identity, trust metadata, ambiguity, and reproducible pin contracts are defined.

### P3-04 Trust/security

Allowlisting, signature/provenance, hook trust, adaptation policy, plan/verify findings, no remote
hook execution by default.

### P3-05 Platforms/ecosystem

Full-lifecycle Kilo Code and OpenCode adapters, further tools, PowerShell, Windows
paths/junctions/CI, and man pages; GUI/IDE only after CLI stability.

### P3-06 Completion installer follow-up

After 1.0, run a separate design for optional completion installation/uninstallation across direct
binary, Homebrew, npm/Bun, Bash, Zsh, Fish, and shell frameworks. It must define file ownership,
startup-file policy, idempotence, conflict detection, distribution coexistence, dry-run, and exact
rollback before adding `completion install`, `completion uninstall`, or an install flag.

---

## 8. Command contracts and options

### 8.1 Global

| Option | Contract | Test slice |
|---|---|---|
| `--config <file>` | Explicit config layer below CLI flags, above project/user/system; extracts legacy config or canonical defaults but never selects desired-state artifacts | EWP-P1-TS02 |
| `--color <auto\|always\|never>` | Canonical TTY/color selection | EWP-P1-TS01 |
| `--no-color` | Alias for `--color never`, including subcommands | EWP-P1-TS01 |
| `--no-prompt` | Never interact; fail if choice/approval is required | EWP-P1-TS01 |
| `-C, --cd <dir>` | Set effective cwd and resolve one shared `ProjectContext` before any discovery | EWP-P1-TS01 |
| `-q, --quiet` | Suppress non-error human output | EWP-P1-TS01 |
| `-v, --verbose` | Repeatable detail level | EWP-P1-TS01 |
| `--debug` | Debug traces and stack context on stderr | EWP-P1-TS01 |
| `-h, --help`; `-V, --version` | Non-mutating global help/version actions | EWP-P1-TS01 |

`--json` and `--yes` use shared option builders but remain command-local so unsupported commands
cannot accept and ignore them. Their exact membership is defined in Section 8.20.

Zero-target and bulk-selection contract:

- Read-only status and whole-artifact plan/apply use their bounded selected context when no target
  is supplied. Sync likewise uses all source entries because its mandatory from/to endpoints bound
  the set; delete remains separately explicit. GC evaluates all locally registered store objects
  under retention and approval rules.
- Dev, promote, mutating or dry-run update, and undo require at least one positional target or
  explicit `--all`. Empty globs never become all. `--all` conflicts positional targets.
- `update --check` without targets checks every eligible declaration in the one selected manifest;
  `--all --check` is an equivalent explicit spelling. This non-mutating exception never transfers
  to update execution.
- Filters that reduce an otherwise valid explicit or bounded selection to zero return an exit-0
  explained no-op. Missing required target/all is usage exit 2 before planning or writes.
- Human/JSON plans record `selectionSource` as `explicit-targets`, `explicit-all`, or
  `bounded-default`. Completion never inserts all automatically, and help renders truthful
  `<target...> | --all` grammar where required.

#### 8.1.1 Global exit-code taxonomy and precedence

| Code | Meaning |
|---:|---|
| 0 | Successful, unchanged, or completed no-op |
| 1 | Execution, verification, health, or integrity failure |
| 2 | Usage error, unsafe refusal, unresolved choice, or missing approval |
| 3 | Invalid or unreadable config, manifest, lock, ledger, or saved-plan state |
| 4 | Requested tool or required capability unavailable |
| 5 | Source, network, reference, or resolution failure |
| 6 | Permission or filesystem-access failure |
| 7 | Successful check-mode evaluation found drift or available changes |
| 130 | Interrupted by the user |

Rules:

- `check` and failing `doctor` return 1; doctor strict warnings also return 1.
- `plan --check`, `status --check`, `update --check`, and compatibility `apply --check` return 7
  only when evaluation completed without an actual error and found changes.
- Successful `--dry-run` returns 0 even when it previews changes.
- A stale saved plan or missing/stale/incomplete state under `--locked` returns 3.
- Conflicting options and approval/choice refusals return 2.
- Cancellation always wins with 130. Otherwise any actual batch error 1-6 takes precedence over
  drift 7; drift is returned only when no actual error occurred. One centralized selector defines
  deterministic precedence within 1-6 and replaces unrestricted numeric maximum.

### 8.2 `agents`

`--tool` validated; `--detected-only` retained; `--json` aliases `--format json`;
`--capabilities` exposes operation coverage. Tests: EWP-CMD-AGENTS-TS01..03.

### 8.3 `list`

Options: `--tool`, `--scope`/scope sugar, `--mode`, `--source`, `--revision`, `--verified`,
`--unverified`, `--description`, `--long`, `--duplicates`, enabled-state filters, `--json`.
Default is compact; no `--compact`. Tests: EWP-CMD-LIST-TS01..07.

### 8.4 `status`

Options: targets, artifact selector, `--tool`, `--scope`, `--check`, `--json`. Exit under `--check` is nonzero on
declared/locked/live drift: 0 when converged, 7 on drift, and the actual 1-6 error otherwise. Tests:
EWP-CMD-STATUS-TS01..06.

With no target, status inspects all entries in its selected readable context and records bounded
default selection; it is never a mutation or implicit cross-context expansion.

### 8.5 `config`

Retain get/set/list/unset; add consistent scope sugar and explicit source reporting. Project writes
follow D-003 and include the visible lossless legacy migration in the same atomic edit. Tests:
EWP-CMD-CONFIG-TS01..05.

### 8.6 `install`

Retain source grammar, tool/scope, ref, pin, direct, force, strict, verify/deep,
continue-on-error, dry-run, JSON. Add default manifest+lock persistence, `--no-save`, `--file`, and
`--lockfile`, and `--path`. `--yes` is meaningful only if a real confirmation exists. Tests: existing suites plus
EWP-CMD-INSTALL-TS01..08.

Install accepts credential-free remote sources only. HTTP(S) userinfo/query/fragment credentials,
plain HTTP, unauthenticated Git protocol, and `file://` refuse before acquisition or output; private
access uses local Git credential/SSH configuration. Reports, origin records, manifests, locks, and
journals store canonical source identity rather than the literal source argument.

Force authorizes replacement/reinstallation only after source, target, scope, and artifact owner
are unambiguous. It does not resolve a picker or dual-manifest ownership and does not bypass
verification, portability, approval, capability, or journal safety.

### 8.7 `uninstall`

Retain targets, tool/scope/all-scopes, force, dry-run, JSON. Add default manifest+lock persistence,
`--no-save`, `--file`, `--lockfile`, and `--continue-on-error`. Make confirmation flags real under
bulk/destructive cases. Tests:
existing suites plus EWP-CMD-UNINSTALL-TS01..07.

Uninstall never creates an absent empty manifest. Converting an already-existing legacy project
config into a canonical defaults-only manifest is a migration, not empty-manifest creation, and is
visible before the selected removal proceeds.

Force authorizes removal of an exactly selected dev/unmanaged/edited placement under preservation
policy; it never deletes a source checkout or retained store object merely because force is set.

### 8.8 `dev` / `promote`

Retain current state machine, source/dest, verify, dirty policy, all, rollback compatibility,
dry-run, JSON, continue-on-error, and name/path targeting. Add user/project scope selector+sugar, unique unscoped-name
inference, ambiguous-name refusal, exact-path selection, absent-create default scope, and meaningful
bulk approval behavior. `--all` spans eligible user+current-project placements unless narrowed by
scope. With neither targets nor all, both commands exit 2 before planning; an unmatched explicit
target is not reinterpreted as all. No new `link` command per accepted D-009. Tests: existing suites plus
EWP-CMD-DEV-TS01..06 and EWP-CMD-PROMOTE-TS01..06.

### 8.9 `verify`

Retain static default, deep additive mode, strict, tools, JSON. Add global context/config behavior
only; do not fold plan/apply state checks into artifact verification. Tests:
EWP-CMD-VERIFY-TS01..04 plus existing live matrix.

### 8.10 `doctor` / `check`

Doctor: artifact selector, tool/scope, offline, strict, JSON; add `--all-tools`, `--fix`,
`--dry-run`, and approval. Check: same artifact/scoping selection, JSON, default fail; replace
`--exit-code` with compatibility/deprecation and `--report-only`; those opposite exit policies
conflict. Tests:
EWP-CMD-DOCTOR-TS01..06, EWP-CMD-CHECK-TS01..05.

Doctor reports noncanonical lock bytes and unknown hash schema/domain with an exact regeneration
action. `doctor --fix` may regenerate a canonical lock only through normal manifest resolution and
the shared artifact coordinator; it never edits immutable generated bytes in place or guesses an
unknown hash version.

Doctor also distinguishes a missing ledger from empty/truncated/malformed state, reports supported
version-1 migration, and refuses unknown newer schemas with upgrade guidance. Its ledger fix is the
same plan-visible migrate-ledger operation used by normal mutation, including dry-run, approval,
locking, original-byte preservation, validation, and crash recovery; it never resets the fleet.

For project files, doctor distinguishes canonical, exact legacy, mixed, empty, malformed, and
nonportable shapes. Its project fix uses the same migrate-project-config operation as normal
canonical writers, preserves human content through the lossless editor, creates no lock by itself,
and refuses rather than dropping an unrepresentable value.

### 8.11 `init`

Options: scope/default selectors, `--file`, tool, `--force`, `--dry-run`, `--json`. Explicit file
wins; explicit user scope selects the XDG user manifest, explicit project scope selects the
effective project root, and no-scope uses the Git root when present or the user manifest otherwise.
Does not import live state. Tests: EWP-CMD-INIT-TS01..05.

Init force atomically replaces only the explicitly selected manifest skeleton; it never changes a
sibling lockfile, live placement, or ledger. Dry-run renders the exact create, replace,
migrate-project-config, noop, or refusal result without writing; execution produces the same
operation. Absent creation and lossless exact-legacy migration need no additional approval, while
replacement still requires explicit force and does not add a second yes requirement.

An existing canonical, mixed, malformed, or unknown file still follows normal existing-file
refusal/force rules. An exact supported legacy project config is not overwritten: init performs the
lossless migrate-project-config operation without force, preserving its defaults and creating no
lockfile.

### 8.12 `export`

Options: `--file`, `--lockfile`, tool/scope, strict, force, dry-run, JSON. Export creates an absent
pair or safely merges an existing pair; force resolves only selected portable declaration
conflicts in favor of live state. No full-file overwrite, deletion, or initial
`--include-unmanaged`; portable provenance is required. Tests: EWP-CMD-EXPORT-TS01..09.

Export force applies only to selected portable declaration conflicts and cannot bypass portability
or take ownership of unselected human content.

Export emits only canonical credential-free source identity and portable path tokens. Local source,
store, ledger, dev, or authentication data warn-and-skip by default and fail under strict; force
cannot make them portable.

**Approved 2026-07-18 export-default amendment.** Bare `skillsmith export` selects exactly one
effective writable live scope: the current project scope when a project context exists, otherwise
user scope. Its automatic output pair follows that same scope: the discovered/current project
manifest with its sibling lock, or the XDG user manifest with its sibling lock. An explicit
`--file` selects only the output artifact and never rebases live scope or project identity.

All four readable scope spellings remain accepted. Explicit system or managed selection reads only
that scope but cannot be represented as portable manifest scope: those observations warn and skip
by default, make the invocation fail without writes under `--strict`, and are never silently
remapped to user or project. If no portable observation remains, export creates no empty pair.
Kilo Code and OpenCode remain valid readable export inputs; their lack of live mutation support is
not itself an export capability error. A known tool fails with exit 4 only when its required
inventory/read capability is unavailable. This amendment resolves source-scope and automatic-pair
defaults only; it adds no command, option, entity, dependency, workflow, or cross-machine consumer
behavior.

### 8.13 `plan`

Options: singular `--file`, optional paired-path override `--lockfile`, tool/scope filters, locked,
prune, check, `--out <path>`, force, JSON. Output is create-only with owner permissions; force is
valid only with out and atomically replaces an existing plan. `--out -` is unsupported. A
positional manifest and repeated `--file` are usage errors. No
execution/confirmation options. Tests: EWP-CMD-PLAN-TS01..12.

Saved output is classified automatically as portable or machine-bound; there is no portability
flag. Machine-bound reasons are explicit, while portable output is rejected if any local absolute
path survives canonicalization. Both classes are owner-only and pass the same secret canary gate.

Plan force is valid only with `--out` and replaces only that exact saved-plan destination.
Check is strictly non-writing and therefore conflicts with out and force.

No positional target is needed: the selected manifest and filters are the bounded default
reconciliation set. Prune remains the separate removal authority.

### 8.14 `apply`

Options: singular `--file`, optional paired-path override `--lockfile`, `--plan`, tool/scope,
locked, prune, yes, no-prompt, continue-on-error, JSON. `--plan` conflicts with manifest/lock
selection, tool/scope, locked, prune, yes, and continue-on-error. With plan, dry-run validates and
renders exact saved operations with exit 0; check returns 0 for an empty valid plan, 7 for a
nonempty valid plan, 3 for stale/incompatible state, or the actual error. They conflict each other
and never replan. Without plan, `--dry-run` and `--check` are compatibility aliases to fresh planner
behavior. Tests:
EWP-CMD-APPLY-TS01..14.

Fresh apply uses the selected manifest as its bounded default. Saved apply uses only the saved
operation set; neither form accepts positional targets, and prune remains explicit.

### 8.15 `sync`

Options: from, to, tool, force, delete, save, artifact selector when saving, dry-run, yes,
continue-on-error, JSON. Force replaces only selected
conflicting destination placements under backup/journal policy; source remains read-only, extra
destination entries still require delete, and saved artifacts still use safe merge. No independent planner.
Tests: EWP-CMD-SYNC-TS01..10.

With no skill targets, sync reconciles every source entry between the mandatory endpoints and marks
bounded-default selection. Target filters may narrow that set; destination-only removal still
requires delete and cannot be inferred from the empty target list.

### 8.16 `update`

Options: targets, all, artifact selector, check, dry-run, ref, pin, strict, tool, JSON, yes,
continue-on-error. `--pin` is meaningful with
an existing moving declaration or an explicit `--ref`; it stores the newly resolved full SHA as
manifest intent. No separate `--unpin`: an explicit moving `--ref` resumes tracking. No separate outdated/diff.
`--check` returns 0 when current, 7 when a change is available, or the actual 1-6 error. Tests:
EWP-CMD-UPDATE-TS01..10.

Check without targets examines every eligible declaration in the selected manifest. Dry-run or
execution without targets requires explicit all and otherwise exits 2; all conflicts positional
targets. Check conflicts dry-run and yes, while ref/pin/strict/continue remain meaningful proposed
candidate evaluation. A no-match explicit target does not become bulk selection.

### 8.17 `undo`

Options: targets, all, tool, user/project scope selector+sugar, dry-run, JSON, yes,
continue-on-error. Unscoped names
infer one unique user/current-project history and refuse ambiguity; `--all` spans both scopes unless
narrowed. Pending transactions take selection precedence and are labeled `abort pending`; otherwise
the command labels an eligible action `reverse committed`. Verb rollback remains a deprecated
compatibility alias.
Tests: EWP-CMD-UNDO-TS01..09.

Undo never guesses the most recent operation: no targets and no all is exit 2 before planning. Empty
or unmatched targets do not expand selection.

### 8.18 `gc`

Options: dry-run, older-than, repeatable forget-project, JSON, yes. Forget-project accepts only an
exact absent, non-current project with no pending journal; it removes local ledger registration,
then recalculates reachability. No filesystem project crawl and no force-delete of reachable entries.
Tests: EWP-CMD-GC-TS01..08.

No target is required because the ledger is the bounded default set. Plain GC evaluates every
registered store object but still applies reachability/retention and exact approval before deletion.

### 8.19 `commands`, `completion`, `version`, `help`

Commands receives shared validation/output fixes. Completion becomes recursive and alias-aware.
Help is current and typo-aware. Version stays simple. Tests: EWP-CMD-COMMANDS-TS01..04,
EWP-CMD-COMPLETION-TS01..06, EWP-CMD-HELP-TS01..07.

### 8.20 Normative command and option registry

Sections 8.1-8.19 explain intent; this registry is the exact 1.0 parser contract. An option omitted
from a command row is unsupported for that command. Dispositions: **K** current and kept, **N** new,
**C** current with changed semantics/default, **D** deprecated compatibility, **A** alias.

#### 8.20.1 Shared option families

| Family | Exact flags and shape | Default/source | Contract and conflicts |
|---|---|---|---|
| Help/version | `-h, --help`; `-V, --version` | false | Global; help/version exit 0 and perform no discovery or mutation |
| Effective cwd | `-C, --cd <dir>` | `.` | Resolve before config, manifest, Git-root, custom-path, or project discovery; all project-aware commands consume the same Section-2.1 `ProjectContext` |
| CLI config | `--config <file>` | `SKILLSMITH_CONFIG`, then layered discovery | Selects a legacy config layer or canonical defaults view, never desired-state artifact ownership; when its path also equals `--file`, parse once but keep both roles explicit |
| Color | `--color <auto\|always\|never>`; `--no-color` | `auto`, then `NO_COLOR`/TTY | `--no-color` is an alias for `--color never`; conflicting explicit modes exit 2; JSON is never colored |
| Verbosity | `-q, --quiet`; repeatable `-v, --verbose`; `--debug` | normal | Quiet suppresses non-error human output; `-v` detail; `-vv` and debug trace to stderr; quiet conflicts with verbose/debug |
| Interaction | `--no-prompt`; `-y, --yes` where listed | TTY-aware | No-prompt disables interaction and never approves; yes approves only an already determined operation set and never selects an ambiguous candidate |
| Machine output | `--json` | false | Shared option builder; one versioned JSON value on stdout, diagnostics on stderr; commands without a JSON contract reject it rather than ignore it |
| Tool selector | repeatable `-t, --tool <name>` | command capability plus effective config/auto rules | Known names are `claude-code`, `codex`, `kilo-code`, `opencode`; unknown exits 2; known unsupported mutation capability exits 4 |
| Scope selector | `-s, --scope <scope>` plus listed `--user`, `--project`, `--system`, `--managed` sugar | command-specific effective scope | Multiple scope forms conflict; recognized-but-read-only scope mutation exits 4; custom paths do not silently change scope |
| Target/bulk selection | positional targets; `--all` only where listed | command-specific bounded default or required explicit selection | Dev/promote/update mutation/undo require targets or all; all conflicts targets; status/plan/apply/sync/GC and update-check use only their documented bounded default; selection source is always reported |
| Artifact selector | singular `--file <path>`; advanced singular `--lockfile <path>` on every pair consumer | discovered manifest plus sibling-derived lock | Lock override requires file, is reported but not persisted, and must be repeated on later direct invocations; repeated/positional manifest or repeated lock is invalid; no-save conflicts either selector on install/uninstall; sync selectors require save; saved-plan apply conflicts both |
| Preview/check | `--dry-run`; `--check` where listed | false | Both are non-mutating; commands exposing both reject them together. Dry-run returns 0 on changes; check returns 7 only on successfully detected drift/change. Selection and operation-shaping flags remain meaningful; yes always conflicts either mode |
| Approval | `-y, --yes`; `--no-prompt` | false / TTY | Yes approves only executable selected operations and conflicts every dry-run/check mode; no-prompt remains a valid no-interaction assertion in all modes. Non-TTY mutation requiring approval exits 2 without yes |
| Conflict override | `-f, --force` where listed | false | Authorizes only the command row's named, already-selected conflict; never selects ambiguity or bypasses approval, verification, portability, lock/plan preconditions, capability, journal/retention safety, prune/delete scope, or failure exits |
| Strictness | `--strict`; `--no-verify`; `--deep` where listed | command-specific | Deep and no-verify conflict. Strict promotes warnings/inconclusive results to failures only where documented |
| Batch | `--continue-on-error` on every multi-target mutator listed below | false | Invocation-level usage/state/ambiguity/approval failures always abort; resolved groups run deterministically and their tool/scope pairs report independently; default stops later groups after a failed group, continue schedules them, cancellation always stops, and any failure remains nonzero |

Global parser options are help/version, cwd, config, color, verbosity, no-prompt, and debug. JSON and
yes use shared builders but are enabled only on the command rows below, preventing accepted no-ops.
Global options are accepted before or after the subcommand; command-local options use the canonical
post-subcommand examples.

Mode-specific conflicts are validated before project/tool discovery, network access, prompting, or
writes. Plan check rejects out and therefore force; check report-only rejects deprecated exit-code;
doctor fix dry-run is valid but rejects yes; apply/update dry-run and check are mutually exclusive.
Force, prune, delete, ref, pin, strict, continue-on-error, and selectors remain valid in a
non-mutating mode only where the command row gives them a real effect on the computed preview.

Project scope, artifact selection, and path resolution are related but distinct. `ProjectContext`
defines live project roots and stable identity; artifact selection defines the one manifest/lock
pair; relative input paths start at effective cwd and become portable only after containment against
project root or home. No command may recompute those bases independently.

#### 8.20.2 Read, configuration, and support commands

| Command | Usage and aliases | Exact local options with disposition | Defaults, conflicts, mutation, and exits | Tests |
|---|---|---|---|---|
| `agents` | `agents` | **K** `-t, --tool <name>` repeatable, `--detected-only`, `--format <markdown\|json>`; **N** `--json` alias for format JSON, `--capabilities` | All four tools by default; read-only; unknown tool 2; detection failures 1; success 0 | EWP-CMD-AGENTS-TS01..03 |
| `config get` | `config get <key>` | **K** `--scope <user\|project\|system>`, `--json`; **N** scope sugar | Effective value by default; explicit scope reads only that layer; read-only; invalid key/scope 2, invalid file 3 | EWP-CMD-CONFIG-TS01..05 |
| `config set` | `config set <key> <value>` | **K** `--scope <user\|project\|system>`; **N** scope sugar, `--json` | User layer default; project writes canonical Phase-2 schema and visibly migrates exact legacy shape in the same lossless atomic edit; one scope only; usage 2, state 3, permission 6 | EWP-CMD-CONFIG-TS01..05 |
| `config list` | `config list` | **K** `--scope <user\|project\|system>`, `--json`; **N** scope sugar | Effective merged values plus source labels by default; explicit layer when scoped; read-only | EWP-CMD-CONFIG-TS01..05 |
| `config unset` | `config unset <key>` | **K** `--scope <user\|project\|system>`; **N** scope sugar, `--json` | User layer default; missing key is exit-0 no-op; project exact-legacy migration follows the same set contract; atomic write | EWP-CMD-CONFIG-TS01..05 |
| `list` | `list [glob...]`; **A** `ls` | **K** tool, scope plus user/project/system/managed sugar, `--duplicates`, `-l, --long`, `--json`, `--enabled`, `--disabled`, `--unconfigured`; **N** `--mode <dev\|pinned\|unmanaged>`, `--source <glob>`, `--revision <glob>`, `--verified`, `--unverified`, `--description <glob>` | All readable tools/scopes by default; enabled-state filters are mutually exclusive; verified/unverified conflict; read-only; stable sort | EWP-CMD-LIST-TS01..07 |
| `commands` | `commands [glob...]` — list installed slash commands | **K** tool, scope plus user/project sugar, `-l, --long`, `--json`, enabled-state filters | User+project readable slash-command roots; enabled filters mutually exclusive; read-only; never presented as the CLI command index | EWP-CMD-COMMANDS-TS01..04 |
| `status` | `status [skill...]` | **N** artifact selector, tool, scope plus readable sugar, `--check`, `--json` | No targets means all entries in selected readable context with bounded-default provenance; targets narrow; read-only; check 0/7 or actual error | EWP-CMD-STATUS-TS01..06 |
| `doctor` | `doctor` | **K** tool, scope plus user/project/system sugar, `--offline`, `--strict`, `--json`; **N** artifact selector, `--all-tools`, `--fix`, `--dry-run`, `--yes` | Detected tools/default pair by default; all-tools conflicts explicit tool; lockfile requires file; dry-run requires fix and conflicts yes; fix includes deterministic ledger and exact-legacy-project migrations but never ambiguous normalization; findings 1, usage 2 | EWP-CMD-DOCTOR-TS01..06 |
| `check` | `check` | **K** tool, scope plus user/project/system sugar, `--json`; **C/D** `--exit-code` explicit-gate compatibility; **N** artifact selector, `--all-tools`, `--report-only` | Error-severity checks only; fails by default; report-only returns 0 after a valid report and conflicts exit-code; all-tools conflicts tool; lockfile requires file; read-only | EWP-CMD-CHECK-TS01..05 |
| `verify` | `verify <path>` | **K** tool, `--static`, `--deep`, `--strict`, `--json` | Claude+Codex default best effort; static is explicit default and conflicts with deep; deep means static+deep for both tools; read-only except isolated temp dirs; 0/1/2/4/130 | EWP-CMD-VERIFY-TS01..04 |
| `completion` | `completion <bash\|zsh\|fish>` | none | Emits only the script to stdout; no discovery/network/startup-file mutation; install instructions live in help; invalid shell 2; no install/uninstall form in 1.0 | EWP-CMD-COMPLETION-TS01..06 |
| `version` | `version`; **A** `-V, --version` | none | Exact package/release version plus newline; exit 0 | EWP-CMD-HELP-TS07 |
| `help` | `help [command\|topic]`; **A** root/command `-h, --help` | none | Root and `help workflows` use Discover/Manage/Develop/Declarative/Maintain groups; command help uses primary question, common workflows, grouped complete options; known command/topic 0; unknown 2 with suggestion; never autocorrects | EWP-CMD-HELP-TS01..06 |

#### 8.20.3 Existing mutation commands

| Command | Usage and aliases | Exact local options with disposition | Defaults, conflicts, mutation, and exits | Tests |
|---|---|---|---|---|
| `install` | `install <source...>`; **A** `i` | **K** tool, scope plus user/project sugar, `--ref <git-ref>`, `--pin`, `--direct`, `-f, --force`, `--strict`, `--no-verify`, `--deep`, batch, dry-run, JSON, yes; **N** artifact selector, `--no-save`, `-p, --path <dir>` | Accepts credential-free HTTPS/SSH/scp identity; credential-bearing, plain-HTTP, Git-protocol, and file URLs refuse. Saves canonical source/ref-or-pin/tools/scope/placement/path by default; never literal acquisition input. Destination precedence is explicit file, unique owner, then new by scope; two owners refuse even with force. Force is bounded; ref/path/gate conflicts remain; yes conflicts dry-run and never resolves picker | EWP-CMD-INSTALL-TS01..08 |
| `uninstall` | `uninstall <skill...>`; **A** `rm`, `remove` | **K** tool, scope plus user/project sugar, `--all-scopes`, force, dry-run, JSON, yes; **N** artifact selector, `--no-save`, batch | Saves by default to the explicit or unique owner; it never creates an empty manifest and ambiguous owners require file even with force. Force is bounded; yes conflicts dry-run. Each target is one group; default stops later targets after failure and batch continues them. All-scopes conflicts singular scope; approval remains separate | EWP-CMD-UNINSTALL-TS01..07 |
| `dev` | `dev <target...> \| --all`; **A** `demote` | **K** `--all`, tool, `--source <path>`, `--dest <dir>`, strict, no-verify, dry-run, JSON, yes; **N** scope plus user/project sugar, batch; **D** `--rollback`; inherited no-prompt | Targets or all required; empty/unmatched never expands. Target resolution follows CF-024. Each placement is one group; default fail-fast, batch continues. Source create/adopt and scope remain enforced. Yes conflicts dry-run; rollback routes to undo; bulk approval is real | EWP-CMD-DEV-TS01..06 |
| `promote` | `promote <target...> \| --all` | **K** `--all`, tool, strict, no-verify, `--allow-dirty`, dry-run, JSON, yes; **N** scope plus user/project sugar, batch; **D** `--rollback`; inherited no-prompt | Targets or all required; empty/unmatched never expands. Target resolution follows CF-024. Each placement is one group; default fail-fast, batch continues. Yes conflicts dry-run; allow-dirty affects only dirty Git source; rollback routes to undo; bulk approval is real | EWP-CMD-PROMOTE-TS01..06 |

#### 8.20.4 New desired-state and maintenance commands

| Command | Usage and aliases | Exact local options with disposition | Defaults, conflicts, mutation, and exits | Tests |
|---|---|---|---|---|
| `init` | `init` | **N** `--file <path>`, tool, `--scope <user\|project>` plus sugar, `-f, --force`, `--dry-run`, `--json` | Explicit file wins. User/project scope selects its defined destination. Creates manifest only; exact legacy project config migrates losslessly without force or lock creation; other existing shapes refuse without force. Dry-run and execution share one operation; force atomically replaces only the exact manifest, never sibling lock/live/ledger; no live import or additional yes | EWP-CMD-INIT-TS01..05 |
| `export` | `export` | **N** artifact selector, tool, scope plus readable sugar, `--strict`, `-f, --force`, `--dry-run`, `--json` | Creates or safely merges the portable pair. Matching intent preserves requested ref and refreshes lock; conflicts refuse unless force. Force changes selected portable conflicts only; it never deletes, overwrites the whole file, or exports credentials/local paths/nonportable entries | EWP-CMD-EXPORT-TS01..09 |
| `plan` | `plan` | **N** artifact selector, tool, scope plus writable sugar, `--locked`, `--prune`, `--check`, `--out <path>`, `-f, --force`, `--json` | Whole selected manifest is bounded default; prune separately authorizes removal. Check is read-only 0/7 and conflicts out/force; out is create-only, owner-only, atomic, redacted, portability-classified; force requires out and replaces exact path only | EWP-CMD-PLAN-TS01..12 |
| `apply` | `apply` | **N** artifact selector, `--plan <path>`, tool, scope plus writable sugar, `--locked`, `--prune`, yes, batch, JSON; **A compatibility** `--dry-run`, `--check` | Fresh form uses whole selected manifest and requires approval for changes; dry-run/check conflict each other and yes. Saved form uses exact operations as prior authorization: validation modes never replan; file/lock/tool/scope/locked/prune/yes/batch conflict plan. Saved check is 0 empty, 7 valid nonempty, 3 stale; machine-bound plans require local preconditions | EWP-CMD-APPLY-TS01..14 |
| `sync` | `sync [skill...]` | **N** mandatory `--from <scope\|path>`, mandatory `--to <scope\|path>`, tool, `-f, --force`, `--delete`, `--save`, artifact selector, dry-run, yes, batch, JSON | No targets means every source entry between bounded endpoints; targets narrow. From/to differ. Force/delete/batch remain meaningful in dry-run, while yes conflicts it. Force never implies yes/delete. Artifact selectors require save. Additive default; delete opt-in; source read-only | EWP-CMD-SYNC-TS01..10 |
| `update` | `update <skill...> \| --all`; safe exception `update --check` | **N** `--all`, artifact selector, tool, `--check`, dry-run, `--ref <git-ref>`, `--pin`, strict, yes, batch, JSON | Mutation/dry-run require targets or all; check without targets checks selected manifest and all-check is equivalent. Check conflicts dry-run/yes but may evaluate ref/pin/strict/batch; all conflicts targets; ref requires exactly one; pin needs moving/explicit ref; check 0/7 | EWP-CMD-UPDATE-TS01..10 |
| `undo` | `undo <skill...> \| --all` | **N** `--all`, tool, scope plus user/project sugar, dry-run, yes, batch, JSON | Targets or all required; never guesses latest. Scope follows CF-024. Each history target is one group; default fail-fast, batch continues; yes conflicts dry-run. Pending abort precedes committed reversal; bulk approval; no recover/abort subverb | EWP-CMD-UNDO-TS01..09 |
| `gc` | `gc` | **N** `--dry-run`, `--older-than <duration>`, repeatable `--forget-project <path>`, yes, JSON | Ledger is bounded default set. Forget requires exact absent non-current root without pending journal and recalculates protection. Retention still applies; yes conflicts dry-run; no force; exact execution approval required | EWP-CMD-GC-TS01..08 |

#### 8.20.5 Parser consistency gates

- **EWP-OPT-TS01:** Introspect the live Commander tree and fail on any option/argument/alias absent
  from the Section-13.1 migration ledger, any current ledger entry absent from live declarations,
  or any target registry entry lacking a disposition and implementation phase.
- **EWP-OPT-TS02:** Assert types, choices, repeatability, defaults, global permutation, and aliases.
- **EWP-OPT-TS03:** Exhaust every conflict/requirement pair, including Commander negated-boolean
  defaults and global/local option collisions.
- **EWP-OPT-TS04:** Assert mutation, prompt, JSON, and exit behavior for each option family.
- **EWP-OPT-TS05:** Generate command help option inventories from the same declarations and compare
  them with this registry and documentation examples.
- **EWP-OPT-TS06:** Exhaust zero-target, positional-plus-all, unmatched target/glob, filter-to-zero,
  bounded-default, update-check exception, selection-source metadata, help grammar, and completion
  behavior for every optional-target command.
- **EWP-OPT-TS07:** Generate help categories/order from option-family metadata; assert every option
  exactly once, common workflows before advanced controls, defaults/conflicts/effects/exits beside
  their owner, full completion visibility, no help-all/new convenience aliases, and happy-path flag
  budgets for all 23 commands.
- **EWP-OPT-TS08:** Assert sibling lock derivation plus the uniform advanced lockfile override on
  status, doctor, check, install, uninstall, export, plan, fresh apply, sync-save, and update;
  lockfile requires singular file, is never persisted, appears in exact-pair output, must be
  repeated for later direct invocations, and conflicts with init, no-save, unsaved sync, and saved
  plan apply as contracted.
- **EWP-OPT-TS09:** Exhaust fresh versus saved apply modes: saved plan allows exact dry-run or check
  validation plus JSON/inherited output context, rejects file/lock/tool/scope/locked/prune/yes/batch,
  treats the plan as prior authorization, never replans, and preserves 0/7/3/error precedence.
- **EWP-OPT-TS10:** Exhaust the shared non-mutating mode matrix: yes conflicts every dry-run/check;
  no-prompt remains a valid assertion; commands exposing dry-run/check reject both; plan check
  rejects out/force; check report-only rejects exit-code; meaningful force/prune/delete/ref/pin/
  strict/batch/selectors remain previewable; all conflicts fail before discovery, network, prompt,
  or write.

---

## 9. Shared application and planning architecture

### 9.1 Application-service boundary

Preserve the accepted core/CLI split while preventing 23 command-local runtimes:

```text
Commander CommandSpec
        -> shared CLI runtime adapter
        -> public core application service
        -> planner/coordinator/domain services
        -> structured CommandOutcome
        -> shared renderer and exit adapter
```

One declarative `CommandSpec` owns name, aliases, five-group membership, primary question,
arguments, option families, examples, capability requirement, and application-service entry point.
The same metadata generates Commander declarations, help, completion, documentation inventories,
option-conflict gates, and the Section-13.4 matrix; command modules do not recreate those facts.

The shared CLI runtime adapter exclusively owns inherited context, cwd/config/environment/TTY and
signals, Commander usage mapping, prompts/approval, human/JSON selection, stdout/stderr, numeric exit
mapping, redaction, deprecations, and cancellation. Command modules may not call `process.exit`,
write output directly, construct an independent default environment, select renderers, or duplicate
Commander error tables.

Public core application services accept semantic requests plus injected context and interaction
ports, call planners/coordinators, and return structured reports without importing Commander,
renderers, terminal libraries, or numeric CLI exit policy. Expected outcomes use:

```text
CommandOutcome<T> {
  report: T
  diagnostics: Diagnostic[]
  exitClass: success | usage | state | capability | source | permission | drift | cancelled
  mutation: MutationSummary
  deprecations: Deprecation[]
}
```

The CLI maps exit class to Section 8.1.1. Choice and confirmation remain CLI-owned through an
injected `InteractionPort`; noninteractive, JSON, yes, and no-prompt policy is resolved once before
the application service runs. Output renderers consume report DTOs and schemas only, never command
modules.

Dependency enforcement:

- CLI specs depend on shared CLI metadata/runtime and public core application exports only.
- Core application services are the top orchestration layer over planner/domain/adapters and cannot
  depend on CLI packages.
- Output/help/util remain leaves; no deep core imports cross the public package boundary.
- Add ADR 0004 and lint zones enforcing these directions.
- Update architecture wording from “no I/O side effects” to “no ambient or CLI-owned I/O; all core
  effects occur through injected, testable ports.”

Capability-scoped effect ports:

- The application composition root may aggregate `PlatformPaths`, `FileReadPort`, `FileWritePort`,
  `LockPort`, `ProcessPort`, high-level `GitPort`, `HttpPort`, `ClockPort`, and `IdPort` as
  `RuntimePorts`.
  Downstream services accept only their required named subsets; read-only services cannot receive
  write, lock, or arbitrary process capabilities.
- Resolve raw environment variables once in the runtime into typed configuration. Domain services
  never receive `process.env` or an unfiltered environment bag. Git-aware domain logic prefers
  high-level GitPort operations; process execution remains an infrastructure adapter detail.
- Clock, monotonic time, IDs, and randomness are injected. Port failures map to structured domain
  errors rather than leaking Node exceptions. Ports remain cohesive capabilities, not one interface
  per method.
- Retain `ScanEnv`/`defaultScanEnv()` as one compatibility aggregate through 1.x, implemented by the
  same real adapters. No new domain/application signature may accept ScanEnv after the migration
  gate; deprecation is removable no earlier than 2.0. Do not maintain duplicate real filesystem or
  process implementations.
- Add ADR 0005 and static import/signature gates for least-capability ownership.

Tool-adapter and capability ownership:

- One validated registry of ToolAdapters is the executable authority for accepted tool IDs/order,
  CLI/completion/schema choices, generated capability docs, planner checks, mutation eligibility,
  exit-4 explanations, and saved-plan capability fingerprints. `SUPPORTED_TOOLS` may remain a
  derived 1.x compatibility view; independently maintained `FLIP_TOOLS` is removed.
- A ToolAdapter contains a descriptor plus cohesive inventory and optional verification, placement,
  and adaptation bundles rather than one giant optional-method interface. Registry validation
  requires descriptor/bundle agreement: declared verification has an implementation, write support
  has placement capability, read-only tools expose no mutation, and IDs/versions are unique.
- Generic planners, executors, schemas, renderers, help, and completion do not branch on known tool
  IDs. Tool-specific roots, gate policy, legacy notices, placement behavior, and rendered facts come
  from adapters. Renderers consume structured results rather than infer behavior from a tool name.
- The 1.0 matrix retains Claude Code and Codex inventory/static/deep/full lifecycle; Kilo Code and
  OpenCode remain read-only with exit 4 for mutation until their deferred adapters land. Claude Code
  deep verification remains required.
- Capability preconditions fingerprint only tool ID, adapter capability version, operation, support
  state, verification mode, and relevant scope constraints. Used capability changes stale a plan;
  unrelated adapter changes do not.
- Add ADR 0007, fixture read-only/write adapters, and static gates against known-tool branching in
  generic orchestration.

Versioned wire-contract ownership:

- Every persisted artifact and public JSON result has exactly one canonical, versioned codec. The
  initial registry includes manifest, lock, plan, ledger v1/v2, journal, error envelope, capability
  snapshot, and one output codec for every JSON-producing command. Wire DTO types are inferred from
  those codecs rather than separately hand-declared with the same fields.
- Domain models remain separate, richer, deeply immutable types. Explicit `decodeWire` mappers
  validate and migrate supported DTO versions into domain models; explicit `encodeDomain` mappers
  construct redacted wire DTOs. Renderers serialize validated DTOs and may not remove internal
  fields ad hoc. Internal-only errors and capabilities are therefore unrepresentable on the wire.
- Artifact repositories exclusively own byte parsing, version discrimination, migration, and
  canonical serialization. Application services and planners never parse raw JSON/TOML or depend
  on the concrete codec library. Public core exports expose stable domain/application types and
  dedicated versioned contract entry points, not mutable internal persistence structs.
- Each codec declares `kind`, `schemaVersion`, unknown-field policy, canonical serialization,
  supported migrations, and additive/breaking compatibility policy. Unknown future versions
  refuse explicitly. Field removal/rename/type or semantic changes require a version bump;
  additive optional fields remain same-version only when all supported consumers can ignore them,
  and enum growth is treated as breaking when consumers may be exhaustive.
- Redaction precedes encoding and codec validation. Generated JSON Schema documentation may derive
  from the codec registry, but the public contract is the versioned wire format rather than Zod or
  another implementation library. Add ADR 0008 and contract inventory/version gates.

Operation-scoped observability:

- One immutable `OperationContext` carries operation ID, optional parent ID, command/workflow,
  deterministic group/pair identity, and injected wall/monotonic clocks through planning,
  verification, execution, transaction, and recovery. Journal and result identities correlate with
  that context; retries/resume retain the operation ID while distinguishing attempts.
- Domain/application code emits a deliberately small typed event union through an injected
  best-effort `ObserverPort`: command lifecycle, plan creation, operation lifecycle, tool detection/
  verification, transaction stage/commit/rollback, and recovery lifecycle. Events carry structured
  IDs, phases, outcomes, and error codes rather than preformatted user-facing strings. Errors must
  still exist in CommandOutcome/error contracts and never only as observation events.
- The shared CLI runtime owns the sole human diagnostic sink and maps normal/verbose/trace/debug
  policy to stderr; JSON stdout remains one valid document. All event fields pass through recursive
  redaction. Observer failure cannot change the domain result, transaction/rollback decision, or
  exit code.
- Recovery journals remain the durable audit/control authority. Observation events are not
  persisted by default and are never read to calculate state or recovery. Do not add OpenTelemetry,
  a trace file, log command, or new CLI option for 1.0; add ADR 0009 and keep the port adaptable.

### 9.2 Planning and transaction model

State ownership is split explicitly:

```text
domain-specific read repositories
        -> immutable ObservedStateSnapshot
        -> pure createPlan(request, snapshot)
        -> immutable Plan
        -> transaction coordinator
        -> staged domain-specific repository writes
```

`ObservedStateSnapshot` contains one stable snapshot ID and versioned manifest, lock, ledger, live,
store, project-context, and capability state. It is deeply immutable, internally consistent at its
read boundary, reusable by status/planning, independent of renderers/CLI flags, and sufficient for
deterministic planning. Every versioned component carries the semantic hash or local revision needed
for expected-revision validation.

`createPlan(request, snapshot)` is pure: it receives no filesystem/write/lock/process/Git/clock/
interaction port, never rereads or mutates state, and returns operations/checks/diagnostics/
preconditions only. Dry-run, plan, fresh apply, and execution consume that same operation set.

Use domain-specific ManifestRepository, LockRepository, LedgerRepository,
LivePlacementRepository, and StoreRepository rather than generic CRUD. Repositories own storage
mechanics, never planning policy, never call one another, and stage writes against expected
revisions. Only the transaction coordinator combines staged writes, chooses commit/journal order,
rolls back, and cleans up. Ledger updates use immutable reducers returning a new model; no shared
mutable ledger/persist closure survives migration. Partial pair commits create truthful successive
revisions without promising invocation-wide atomicity. Status receives read repositories only.

Execution acquires the lock hierarchy, rereads referenced revisions, validates plan preconditions,
stages operations, and commits through the coordinator. It cannot silently call the planner again.
A changed saved-plan precondition refuses; a fresh apply must display any newly generated plan before
approval.

Migration order: introduce immutable ledger reducers; extract one state reader; extract pure
planning from placement/acquisition runners; wrap current mutation code as repository adapters; move
commit/journal ordering into the coordinator; remove mutable contexts after parity; split oversized
run modules by planning, execution, recovery, and repository responsibility. Add ADR 0006 plus
module-size and dependency-cycle gates so the architecture cannot collapse into a new monolith.

```text
effective config
+ manifest intent
+ portable lock resolution
+ placements ledger
+ filesystem probe
+ tool capabilities
= immutable Plan { operations[], checks[], diagnostics[] }
```

Executable operation kinds:

```text
install, update, remove, link-dev, promote, move-scope, adapt, repair,
write-manifest, write-lock, migrate-project-config, migrate-ledger
```

Every operation carries:

- stable operation ID;
- skill/source identity;
- tool and scope;
- before state;
- after state;
- reason and selection source;
- preconditions;
- reversibility/retention data;
- whether it mutates live state, manifest, lock, or ledger.
- an optional bounded conflict override containing stable conflict class, normal refusal behavior,
  authorized forced behavior, exact target, and required backup policy.

`selectionSource` is exactly `explicit-targets`, `explicit-all`, or `bounded-default`. The command
contract determines whether bounded default exists before any planner call. Missing required
target/all and positional-plus-all fail as invocation-level usage errors; unmatched explicit
targets never widen. Valid selections narrowed to zero by filters produce a deterministic explained
no-op and retain their original selection source.

Operation construction separates credential-free canonical source identity from ephemeral
acquisition transport. Literal source arguments and authentication never enter operations,
preconditions, results, journals, or compatibility DTOs. Before persistence or rendering, the
shared recursive redactor processes every operation/check/diagnostic/result and nested error.

Every artifact/resource/selection/capability precondition carries its hash domain and hash schema
version. Resource inputs contain only facts the operation depends on; selection-set inputs are
sorted complete identities+resource hashes so membership changes invalidate destructive/bulk plans.
Unknown hash schema versions fail compatibility before execution.

Portable operation ownership derives from the unique manifest name plus tool and operation kind;
local placement probing remains qualified by tool, scope, and canonical path. A manifest rename
therefore renders explicit remove-old and install-new operations.

Checks are non-mutating prerequisites such as source resolution, capability, content integrity,
verification, or saved-plan precondition validation. Each check declares whether failure blocks its
dependent operations.

Diagnostics describe planner dispositions that are reviewable but never executable:

```text
noop, skip, refuse, conflict, warning
```

Each diagnostic carries the affected identity, reason, severity/refusal class, and related operation
or selection source where applicable.

Execution produces a separate result for every attempted operation:

```text
ExecutionResult { operationId, outcome, actualBefore, actualAfter, force?, error? }
outcome = succeeded | failed | cancelled | rolled-back
```

When force is applicable, `force` is present in human/JSON parity with
`{ applied, conflictType, target, normalBehavior, forcedBehavior, backup }`. A supplied force flag
with no applicable conflict reports `applied: false`; it never changes selection, approval,
verification, portability, preconditions, capability, retention, or exit classification.

Saved plans serialize operations, required checks, diagnostics, and preconditions for review, but
the executor runs only executable operations and required checks. Existing `InstallAction` and
`FlipAction` unions may remain temporarily as compatibility rendering DTOs; they are not the new
planner or executor model.

Saved-plan serialization derives portability from its final redacted operations and preconditions.
Portable plans reject any local absolute path. Machine-bound plans retain only required local paths,
record stable binding reasons, and revalidate those paths locally. Neither class may contain a
credential canary.

`migrate-ledger` is a local prerequisite operation, never a hidden parser side effect. It precedes
every dependent mutation, reports schema 1 -> 2 in human/JSON plans, preserves supported legacy
journals, and commits independently before later groups execute. Its resource precondition includes
the exact source schema and semantic ledger state. Read-only/dry-run paths may normalize version 1
in memory but cannot write it; a saved migration operation becomes stale after another process
migrates first.

`migrate-project-config` is the analogous portable, human-file prerequisite. It converts only the
exact supported legacy shape through the lossless editor, precedes any dependent manifest write,
and never treats legacy configuration as empty desired state. Plan/dry-run may normalize it in
memory; execution rechecks exact bytes under the artifact lock. Migration-only execution does not
create a lockfile, and an independently completed migration stales a saved operation.

Transaction hierarchy:

```text
Invocation
└── Source/declaration group
    ├── Manifest and lock intent
    ├── Tool A placement transaction
    └── Tool B placement transaction
```

Command-to-group mapping:

| Command | Operation group |
|---|---|
| install | one resolved source/declaration |
| uninstall | one requested declaration/target |
| dev/promote | one selected placement target |
| fresh apply | one manifest declaration |
| sync | one selected destination skill |
| update | one manifest declaration |
| undo | one selected history target |

- Validate all invocation syntax and option conflicts before any write.
- A source that fails before identity/reference resolution writes nothing.
- A resolved install group commits the full requested declaration and exact lock intent; requested
  tool targets never shrink to whichever tools succeeded locally. Each tool placement then commits
  independently. Failures remain visible as declared-but-missing drift.
- Uninstall retains the declaration and lock until every selected placement in that declaration
  group is removed; partial removal remains declared and recoverable until same-operation rerun
  finishes the group.
- Update may commit the new resolved lock intent after resolution; failed tool placements remain
  visible as live-revision drift against it.
- There is no whole-invocation or cross-tool atomicity promise. Validate invocation-level syntax,
  option conflicts, global state, approval, and selection ambiguity before writes; these failures
  always abort. Groups execute in deterministic identity order. Within a resolved group, all
  selected tool/scope pairs report independently and any pair failure fails the group. Default
  scheduling marks later groups `skipped-after-failure`; `--continue-on-error` schedules later
  independent groups but never makes a failed group or batch successful. Cancellation stops all
  remaining work. Successful earlier groups remain truthful, dry-run/JSON expose group boundaries
  and scheduling, and same-operation rerun converges incomplete groups. Saved-plan apply rejects the
  option because reviewed authorization fixes its execution semantics; fresh apply may use it.
- Do not expose `--atomic` unless a future design can genuinely provide cross-filesystem and
  cross-tool rollback.

Execution phases:

1. Generate operations without mutation.
2. Render/review operations, checks, and diagnostics or serialize the saved plan.
3. Acquire appropriate mutation lock(s).
4. Revalidate operation preconditions.
5. Execute deterministic ordering with allowed parallel reads and serialized colliding writes.
6. Journal every live transition and declaration-group commit boundary.
7. Persist ledger/lock/manifest at defined commit points.
8. Render actual execution results separately from proposed operations and diagnostics.

Planner consumers: `plan`, `apply`, `sync`, init/export/update preview, install/uninstall dry-runs,
CI drift, correlated status/diagnostics, and snapshot tests.

---

## 10. Named implementation phases and slices

### Phase 0 — Decisions, consistency, and architecture gate

**Entry:** The consolidated source set and current Commander snapshot are available. **Exit:** All
decisions/findings are recorded, command/artifact/architecture consistency is closed, the plan
structural gate passes, and every validation ID has a catalog tier plus planned executable owner.

- **EWP-P0A-T01:** Preserve the resolved D-001..D-016 answer, rationale, rejected option, affected
  sections, and amendment history.
- **EWP-P0A-T02:** Compare every proposed command/option against live Commander declarations.
- **EWP-P0A-T03:** Compare manifest/lock/plan terminology against config and placement schemas.
- **EWP-P0A-T04:** Run factor-architect review: good precedent, bad precedent, broken precedent, new
  patterns.
- **EWP-P0A-T05:** Run broad consistency/quality scan for contradictions, duplicate semantics,
  unreachable states, unclear defaults, and command-count excess.
- **EWP-P0A-T06:** Amend this plan and close every accepted finding.
- **EWP-P0A-T07:** Keep the normative command/option registry synchronized with implementation
  declarations and the per-command validation registry.
- **EWP-P0A-T08:** Produce and close the section-level documentation drift ledger across active
  research, command specs, README, help, and relevant implementation specs.
- **EWP-P0A-T09:** Implement the plan structural validator and run it after every Phase-0 amendment.
- **EWP-P0A-T10:** Maintain accepted-finding traceability: every finding must retain the accepted
  go-forward contract, concrete decision examples, affected contracts, named validation ownership,
  and recorded date in this file; rejected alternatives are optional historical context.
- **EWP-P0A-T11:** Maintain the current-to-1.0 CLI migration ledger from a live Commander snapshot;
  every global, command, alias, argument, option, default, behavior change, compatibility window,
  phase owner, and test owner must map exactly once to the Section-8.20 target.
- **EWP-P0A-T12:** Implement the machine-readable verification catalog mapping every phase,
  command, option, and holistic-workflow validation ID to exactly one primary owner, planned
  executable target, required-now versus downstream-coverage relationship, and
  required-PR/supported-platform/release/deferred tier. An activated target is a structured,
  repository-contained regular file plus exact validation-ID selector, runnable command, and
  ID-bound execution receipt. Generate integrity reports for the plan and require each phase to
  activate its planned entries before phase exit without pulling downstream work forward.
- **EWP-P0A-TS01:** Identifier/heading/decision-status validation.
- **EWP-P0A-TS02:** Command-option matrix has no duplicate short flags or contradictory defaults.
- **EWP-P0A-TS03:** Every proposed command has implementation, unit, CLI contract, and workflow test
  ownership.
- **EWP-P0A-TS04:** EWP-OPT-TS01..10 parser/registry consistency suite passes.
- **EWP-P0A-TS05:** Active-doc superseded-claim scan and authority-pointer gate passes.
- **EWP-P0A-TS06:** No unresolved decision, undefined/duplicate EWP ID, count mismatch, stale
  pending-decision marker, out-of-template placeholder, or nonexistent phase reference.
- **EWP-P0A-TS07:** Every accepted EWP-CF row maps to a finding record, normative go-forward
  contract, saved example or workflow fixture, affected contracts, and named phase/command
  validation; no accepted decision exists only in conversational history.
- **EWP-P0A-TS08:** Live Commander introspection, the Section-13.1 current side, the Section-8.20
  target side, generated help, and option/command test ownership form a closed mapping with no missing,
  duplicate, silently removed, or accepted-no-op surface.
- **EWP-P0A-TS09:** Verification-catalog self-tests reject missing, duplicate, malformed, orphaned,
  prose-only, skipped-required, and unreferenced deferred entries; future-phase planned targets must
  name a phase and path; active/completed targets must be regular executable files bound to an exact
  selector, runnable command, and execution receipt; required-now gates cannot depend on future
  groups; downstream coverage cannot disappear; and the plan/catalog/test round trip is complete
  and deterministic.

### Phase 1 — P0 CLI truthfulness

**Entry:** Phase 0 passes with a closed migration ledger and seeded validation catalog. **Exit:**
Every current command uses the shared truthful runtime/application boundary, scoped ports,
registry/codecs/observer foundations, current documentation, and all Phase-1 catalog entries pass.

- **EWP-P1-T01:** Shared CLI context, inherited-option builder, and immutable `ProjectContext`
  resolver used by every project-aware command.
- **EWP-P1-T02:** Operational effective-config resolver consuming the shared project context while
  keeping discovered config/manifest paths distinct from live project root.
- **EWP-P1-T03:** Shared tool/scope/capability validation and scope-aware placement/history target
  resolution for explicit scope, unique name, exact path, absent create, and bulk selection.
- **EWP-P1-T04:** Shared human/JSON error mapping.
- **EWP-P1-T05:** Correct check gate semantics.
- **EWP-P1-T06:** Current help/README/package docs and all code-adjacent command references updated
  according to the closed Phase-0 drift ledger.
- **EWP-P1-T07:** Preserve legacy project-config reads and emit the Phase 2 migration warning;
  do not introduce a second canonical project writer.
- **EWP-P1-T08:** Centralize the global exit taxonomy and batch precedence; remove unrestricted
  numeric-maximum selection before adding drift code 7.
- **EWP-P1-T09:** Add ADR 0004, declarative CommandSpec metadata, shared CLI runtime/renderer/exit
  adapter, public core application services, CommandOutcome, interaction ports, and lint-enforced
  dependency zones; migrate every current command before new Phase-2+ commands copy old
  command-local orchestration.
- **EWP-P1-T10:** Add ADR 0005 and capability-scoped PlatformPaths/FileRead/FileWrite/Lock/Process/
  Git/HTTP/Clock/Id ports, typed resolved configuration, one real RuntimePorts composition, and a
  ScanEnv/defaultScanEnv compatibility adapter through 1.x; migrate current domain signatures and
  forbid new aggregate/raw-environment dependencies.
- **EWP-P1-T11:** Add ADR 0007 and the validated ToolDescriptor plus inventory/verification/
  placement/adaptation bundle registry; derive tool choices, order, schemas, capability output, and
  1.x compatibility exports from it while rejecting descriptor/implementation drift.
- **EWP-P1-T12:** Add ADR 0008, the canonical wire-contract registry, explicit domain/DTO mappers,
  dedicated versioned public contract entry points, and codec-owned command output/error/capability
  schemas; migrate current JSON renderers without changing accepted bytes.
- **EWP-P1-T13:** Add ADR 0009, immutable OperationContext, the typed ObserverPort event registry,
  and the shared redacted stderr diagnostic sink; migrate current free-form domain logging and make
  inherited verbosity/debug behavior uniform without adding a new option.
- **EWP-P1-TS01:** Global option spawned-CLI matrix plus root/nested cwd, `-C`, Git worktree,
  symlink, and non-Git project-context invariance across project-aware commands.
- **EWP-P1-TS02:** Config precedence spawned-CLI matrix, including nested discovered manifest,
  explicit artifact, and project-root separation.
- **EWP-P1-TS03:** Invalid enum/capability matrix for every command plus cross-command
  user/project/unique/ambiguous/path target-selection equivalence.
- **EWP-P1-TS04:** Check/doctor exit and JSON matrix.
- **EWP-P1-TS05:** Live help/docs declaration gate.
- **EWP-P1-TS06:** Cross-command 0-7/130 exit matrix, including batch error-over-drift precedence.
- **EWP-P1-TS07:** Static boundary gates plus spawned human/JSON/error/cancel/noninteractive parity
  for every migrated command; one fixture command proves spec-driven parser/help/completion/docs and
  execution without direct process output/exit, environment construction, renderer selection, deep
  core import, or duplicate error/interaction policy.
- **EWP-P1-TS08:** Static signature/import gates, compile-time negative read-only capability
  fixtures, compatibility-adapter/focused-fake behavioral parity, one-real-implementation proof,
  typed-config secret isolation, high-level GitPort/HttpPort use, structured port errors, and deterministic
  clock/ID behavior across plan, transaction, migration, undo, and GC.
- **EWP-P1-TS09:** Exact four-tool operation matrix, unique ID/version and descriptor/bundle
  validation, derived CLI/completion/config/manifest/help/capability parity, read-only mutation
  rejection, Claude/Codex static-plus-deep proof, and fixture read-only/write adapter registration.
- **EWP-P1-TS10:** Current JSON byte-parity goldens, codec-derived DTO type checks, internal-field
  nonserialization proof, output/error/capability contract inventory, strict version/unknown-field
  fixtures, and static bans on renderer field stripping or raw parsing outside contract owners.
- **EWP-P1-TS11:** Event-taxonomy completeness, command/event correlation, fake-clock timing,
  canary redaction, observer failure isolation, errors-not-only-events, and quiet/verbose/trace/
  debug human/JSON spawned-output parity with one valid JSON stdout document.

### Phase 2 — Portable artifact foundation

**Entry:** Phase 1 passes; legacy project config remains readable; no command writes a second
canonical project representation.

- **EWP-P2-T01:** Define project and user manifest discovery/destination paths, paired lock paths,
  explicit-file precedence, unique existing-name ownership lookup, two-owner ambiguity refusal, and
  new-declaration routing by effective scope, all consuming the shared project context without
  rebasing live placement from artifact location.
- **EWP-P2-T02:** Implement the versioned unified manifest schema, unique-name identity/invariants,
  persisted placement/path invariants, structural legacy/canonical/mixed discriminator, and the sole
  lossless legacy-project-config migration path from D-003 and CF-029, including credential-free
  canonical source identity and portable path rejection.
- **EWP-P2-T03:** Implement the portable lock schema, semantic hash/canonicalization rules, and
  manifest relationship from D-004, including all versioned CF-027 hash domains and source-tree
  canonicalization.
- **EWP-P2-T04:** Complete a bounded lossless-TOML editor spike, then implement strict readers,
  targeted human-file edits, canonical generated writers, absent-file artifact-group lock, and
  exact-byte external-writer guard/replan-or-refuse behavior plus the shared recursive redactor at
  every render/persistence boundary.
- **EWP-P2-T05:** Define init request validation, canonical skeleton construction, and pure
  create/replace/migrate/noop/refusal artifact-operation inputs without registering or executing the
  command before the shared planner exists.
- **EWP-P2-T06:** Implement manifest, lock, plan, ledger v1/v2, and journal codecs plus explicit
  domain mappers and repository-owned supported-version migration/canonical serialization.
- **EWP-P2-TS01:** Manifest parser, unique-name/source/ref/scope/tool invariants, unknown-key,
  version, legacy-migration, and semantic-hash normalization/mutation fixtures.
- **EWP-P2-TS02:** Project/user/explicit-file discovery and paired-lock path matrix, including
  user-scope initialization inside a repository, unique project/user owner selection independent of
  cwd, two-owner ambiguity, new project/user declaration destinations, nested manifest discovery,
  sibling derivation, explicit lock override requiring explicit file, override non-persistence and
  later-invocation repetition, portable-relative versus machine-bound absolute overrides, and proof
  that explicit/custom artifact paths do not redefine project root.
- **EWP-P2-TS03:** Lock determinism, hash schema/domain golden vectors, exact canonical-byte
  enforcement, source-content cross-platform trees, and missing/stale/incomplete fixtures.
- **EWP-P2-TS04:** Comments around every editable field, unusual whitespace/order, unrelated
  schema-valid sections, permissions, semantic no-op byte identity, absent-target lock contention,
  external byte changes, safe replan/unsafe refusal, SIGINT, two-file crash windows, and zero-residue
  refusal fixtures.
- **EWP-P2-TS05:** Init skeleton and supported legacy-migration outputs immediately round-trip
  through canonical readers; repository fixtures prove exact intended bytes without CLI execution.
- **EWP-P2-TS06:** Exact legacy/canonical/mixed/empty/malformed/unknown shape matrix; read-only and
  dry-run byte identity; tool/scope/path/registry mapping; comments/order/permissions/newlines;
  portable and blocked nonportable values; config/artifact dual-role parsing; automatic/doctor
  equivalence; saved-plan staleness; concurrency, crash, and no-lock migration fixtures.
- **EWP-P2-TS07:** Canonical source/path golden matrix for credential-free HTTPS/SSH/scp, rejected
  HTTP(S) userinfo/query/fragment secrets, plain HTTP, Git protocol, and file URLs;
  project/home/source-relative tokens,
  traversal/absolute/drive/UNC/store/ledger/dev rejection, registry identity, and credential-canary
  scans across manifest, lock, ledger, journal, temporary, backup, human/JSON/debug/error output.
- **EWP-P2-TS08:** Per-version artifact golden fixtures; encode/decode round trips; prior-version
  migration; future-version, unknown-key, truncated, malformed, and fuzzed-input refusal; canonical
  byte determinism; generated contract-inventory/docs parity; and compatibility-changelog gates.

**Exit:** One versioned artifact API owns all manifest/lock reads and writes; the current project
shape has one tested migration; no status or mutation command needs to invent an artifact schema.

### Phase 3 — Inspection and operation foundation

#### Phase 3A — Correlated inspection

- **EWP-P3A-T01:** Deterministic compact list model/renderers.
- **EWP-P3A-T02:** Version-discriminating, non-mutating ledger reader plus
  ledger/manifest/lock/filesystem observed-state join service keyed by the shared stable project
  identity rather than invocation cwd; normalize supported version 1 in memory and expose migration
  pending without writing.
- **EWP-P3A-T03:** Status command.
- **EWP-P3A-T04:** Tool-qualified duplicate/shadow analysis.
- **EWP-P3A-T05:** Per-operation tool/scope capability reporting.
- **EWP-P3A-TS01:** List compact/long/JSON goldens.
- **EWP-P3A-TS02:** Status state-product matrix including missing, version 1, version 2,
  empty/truncated/malformed, newer-version, migration-pending, and read-only byte-identity cases.
- **EWP-P3A-TS03:** Duplicate cross-tool/cross-scope regressions.
- **EWP-P3A-TS04:** Realistic mixed-fleet inspection fixture.

#### Phase 3B — Shared planning and transaction primitives

- **EWP-P3B-T01:** Immutable executable-operation, diagnostic, and execution-result types with
  canonical ordering and versioned domain-tagged dependency metadata.
- **EWP-P3B-T02:** Shared mutation-lock hierarchy, operation preconditions, and transaction coordinator with deterministic group/pair scheduling for live placement, manifest, lock, and ledger commit points.
- **EWP-P3B-T03:** Adapt existing install/uninstall/promote/dev planning and dry-run paths to the
  shared types, preserving current behavior except accepted scope-aware target-selection changes.
- **EWP-P3B-T04:** Extend the Phase-3A reader with the canonical version-2 writer, visible
  migrate-ledger operation, project registrations, coordinator transactions, bounded history, and
  deterministic doctor fix; adapt existing per-pair journals and same-operation resume without
  losing version-1 crash compatibility.
- **EWP-P3B-T05:** Add ADR 0006; domain-specific manifest/lock/ledger/live/store repositories;
  versioned immutable observed-state snapshots and ledger reducers; pure planners; expected-revision
  staging; coordinator-only repository composition; compatibility wrappers; and staged extraction of
  planning/execution/recovery from current monolithic runners.
- **EWP-P3B-T06:** Move all tool-specific root, verification policy, placement, legacy-notice, and
  result facts behind registered adapter bundles; make generic planners/executors/renderers consume
  adapter outputs and versioned capability fingerprints with no known-tool branching.
- **EWP-P3B-T07:** Propagate OperationContext through planners, adapters, the coordinator, journal,
  rollback, and recovery; emit typed lifecycle events while preserving the journal as the sole
  durable recovery authority and distinguishing retry/resume attempts.
- **EWP-P3B-TS01:** Operation and diagnostic snapshot matrix for every existing action/outcome.
- **EWP-P3B-TS02:** Determinism/property tests and dry-run/execution operation equality.
- **EWP-P3B-TS03:** Lock ordering, concurrent-process exclusion, per-pair partial failure, and crash/resume tests at the existing ledger/live boundaries, including identical user/project names and fail-fast/continue/cancellation scheduling.
- **EWP-P3B-TS04:** Missing versus empty/truncated/malformed ledger; version-1 read-only and dry-run
  byte identity; visible automatic and doctor migration; canonical version-2 equivalence; newer
  version refusal; legacy pending-journal preservation; saved-plan migration staleness; and crash at
  every stage/flush/backup/replace/first-commit cleanup point. Also cover project-registration
  derivation, logical coordinator transaction phase changes, atomic pending-to-committed-history
  movement, deterministic bounded-history behavior, pending-before-history precedence, internal
  same-operation resume and pending-abort primitives, and pair isolation across interruption and
  recovery.
- **EWP-P3B-TS05:** Deep-freeze mutation traps, pure planner determinism/property tests,
  dry-run/execution operation identity, expected-revision/concurrent-writer refusal, repository
  import isolation, read-only status capability, failure injection at every
  stage/commit/rollback/cleanup point, compatibility parity, dependency-cycle detection, and
  module-size/ownership gates.
- **EWP-P3B-TS06:** Static known-tool-branch ban; generic orchestration through fixture adapters;
  exact Claude/Codex full-lifecycle and deep verification behavior; Kilo/OpenCode read-only exit 4;
  structured-renderer facts; and saved-plan relevant-capability staleness/unrelated-adapter validity.
- **EWP-P3B-TS07:** Per-operation causal lifecycle sequences for plan/apply/partial failure/
  rollback/recovery/verification; command-group-pair-journal correlation; retry/resume attempts;
  observer-sink fault isolation; and proof that no observation event controls recovery or state.

**Entry:** Phase 2 canonical readers are complete. **Exit:** inspection consumes only canonical
state products, and every current or future mutation can use one operation/transaction foundation
instead of adding command-specific orchestration.

### Phase 4 — Desired-state mutation, planner, and apply

#### Phase 4A — Desired-state lifecycle integration

- **EWP-P4A-T01:** Integrate install/uninstall default-save, ownership-first destination discovery,
  ambiguity refusal, and `--no-save` with the shared coordinator; report the selected manifest/lock
  pair for saving work and explicit no-pair/no-discovery/not-evaluated facts for `--no-save`.
- **EWP-P4A-T02:** Implement export classification, merge/update behavior, and writer integration.
- **EWP-P4A-T03:** Define multi-source/multi-tool partial-success commit semantics for manifest,
  lock, ledger, and live state.
- **EWP-P4A-T04:** Register and implement init through the shared application service/planner using
  Phase-2 skeleton/repository APIs; add dry-run with operation identity and retain manifest-only
  create/migrate/force semantics.
- **EWP-P4A-TS01:** Default-save and no-save operation snapshots covering explicit file, unique
  existing project/user owner, ambiguous dual ownership, new declarations routed by scope, and
  byte-identical nonselected artifacts.
- **EWP-P4A-TS02:** Manifest/lock/live/ledger crash and partial-failure matrix.
- **EWP-P4A-TS03:** Export portable/nonportable and existing-file classification matrix.
- **EWP-P4A-TS04:** Init dry-run/execution operation equality; absent/legacy/existing/force/noop/
  refusal matrix; no lock/live/ledger writes; concurrent-writer/crash behavior; and human/JSON/help/
  completion parity.

#### Phase 4B — Declarative plan and apply

- **EWP-P4B-T01:** Desired/current diff planner and prune selection.
- **EWP-P4B-T02:** Human and JSON plan renderers plus plan/check exit behavior.
- **EWP-P4B-T03:** Saved-plan schema, permissions, recursive redaction, automatic
  portable/machine-bound classification, hash schema version/domains, and scoped preconditions.
- **EWP-P4B-T04:** Apply executor, approval, saved-plan execution, and precondition revalidation.
- **EWP-P4B-T05:** Lockfile resolution/update policy and commit points.
- **EWP-P4B-TS01:** Planner operation matrix and deterministic byte snapshots.
- **EWP-P4B-TS02:** Plan/check/apply-dry-run equivalence and apply idempotence.
- **EWP-P4B-TS03:** Saved-plan exact execution; semantic-manifest/canonical-lock/resource/
  selection/capability independent stale-state and unknown-hash-version refusals.
- **EWP-P4B-TS04:** Prune never deletes undeclared or unselected scopes accidentally.
- **EWP-P4B-TS05:** Crash/recovery at every manifest/lock/ledger/live commit boundary.
- **EWP-P4B-TS06:** Machine-A export -> machine-B locked plan/apply reproduction.
- **EWP-P4B-TS07:** Portable plan zero-local-path proof; machine-bound reason/path/precondition
  matrix; cross-machine refusal/reproduction guidance; nested secret-canary scans through partial
  failure, debug, saved output, and crash residue.

**Dependency-complete workflow ownership amendment (2026-07-18, user-approved):** Phase 4A keeps
the command-level `init` and `export` acceptance work, but EWP-WF03 and EWP-WF04 have primary
validation ownership in the final Phase 4B lock/reproduction group. Both workflows invoke `plan`
and `apply`, and their terminal assertions require clean-clone, cross-platform, or cross-machine
reproduction, so they cannot truthfully pass before the Phase 4B planner and executor exist.
P17-G4A-03 retains EWP-WF03 and P17-G4A-02 retains EWP-WF04 as immutable downstream coverage;
P17-G4B-03 runs both as required-now dependency-complete workflows after P17-G4B-02. This corrects
validation scheduling only: it changes no command behavior, entity count, execution-group
dependency, or product scope, and it preserves the workflows' earlier command, decision, finding,
task, and recommendation traceability. The user explicitly approved this correction on 2026-07-18.

**Dependency-complete plan/apply ownership amendment (2026-07-18, user-approved):** G4B-01 owns
the pure plan command, desired/current planner, renderers, saved-output generation, check exits, and
prune safety. EWP-CMD-PLAN-TS11, EWP-P4B-TS02, EWP-WF06, and EWP-WF08 retain their exact text,
selectors, tiers, and target paths but have primary required-now validation ownership in G4B-02,
because each invokes or requires `apply`. G4B-01 retains all four as downstream coverage and as a
secondary group. D-002/EWP-P4B-T03 retain G4B-02 primary ownership with G4B-01 generation-side
secondary traceability; D-015/EWP-P4B-T05 retain G4B-03 primary ownership with G4B-01 visible
resolution/locked-preview secondary traceability. This changes validation scheduling and
traceability only: no assertion, behavior, entity count, execution-group dependency, or product
scope changes. The user explicitly approved this correction on 2026-07-18.

**Entry:** Phase 3B transaction primitives pass against every existing mutator. **Exit:** init,
imperative default-save, export, plan, and apply share one operation set and coordinator; all Phase
4 holistic workflows pass without command-specific transaction engines.

### Phase 5 — Sync, update, undo, and GC

**Entry:** Phase 4 exits with one coordinator and operation set for imperative and declarative
mutation. **Exit:** Sync, update, undo, and GC share those primitives, preserve artifact/retention
contracts, pass EWP-WF09..12 and EWP-WF14, and have no planned Phase-5 catalog entries remaining.

- **EWP-P5-T01:** Sync source/destination model over planner.
- **EWP-P5-T02:** Sync save/delete semantics.
- **EWP-P5-T03:** Update candidate and pin policy.
- **EWP-P5-T04:** Update plan/execution/retention.
- **EWP-P5-T05:** Unified scope-aware undo selection and compatibility aliases.
- **EWP-P5-T06:** Reachability graph and GC retention.
- **EWP-P5-TS01:** Sync scope/path cartesian matrix.
- **EWP-P5-TS02:** Update check/dry-run/apply matrix.
- **EWP-P5-TS03:** Undo operation-family and user/project ambiguity/inference matrix.
- **EWP-P5-TS04:** GC reachability/age/bytes matrix.
- **EWP-P5-TS05:** Bulk confirmation/noninteractive safety plus fail-fast/continue scheduling
  across sync, update, and undo.

### Phase 6 — Distribution and UX polish

**Entry:** Phases 1-5 and their required catalog entries pass; the complete 23-command surface is
stable enough to package. **Exit:** Help/completion/docs are generated and current, every declared
distribution passes clean-machine validation, `just check` and exact-SHA `just release-check` pass,
and no planned Phase-6 or required 1.0 validation entry remains.

- **EWP-P6-T01:** Native release assets/checksums.
- **EWP-P6-T02:** Homebrew and npm/Bun distribution.
- **EWP-P6-T03:** Recursive alias-aware completion.
- **EWP-P6-T04:** Discover/Manage/Develop/Declarative/Maintain root/docs grouping,
  primary-question/common-workflow/grouped-option command help, `help workflows`, topics, and
  suggestions generated from shared command metadata.
- **EWP-P6-T05:** Color/observer, legacy-logger, and dependency cleanup.
- **EWP-P6-T06:** Version/capability matrix and install/upgrade docs.
- **EWP-P6-T07:** Add ADR 0010, make `just check` the canonical PR gate and `just release-check` the
  exact-release-SHA distribution/live-compatibility gate, call those recipes from CI, and separate
  release preparation from publication so no artifact publishes before its gate succeeds.
- **EWP-P6-TS01:** Clean-machine install smoke per distribution.
- **EWP-P6-TS02:** Bash/zsh/fish nested completion suite.
- **EWP-P6-TS03:** TTY/pipe/color/quiet/JSON rendering suite.
- **EWP-P6-TS04:** Generated docs vs command tree gate.
- **EWP-P6-TS05:** Twenty-three-command primary-question uniqueness, five-group membership,
  minimal invocation, progressive help layout, option-category completeness/order, alias adjacency,
  and runnable common-workflow snapshots.
- **EWP-P6-TS06:** Local/CI recipe parity; exact-SHA publication refusal; four-target builds and
  runnable-native smoke; package/direct-binary/declared-distribution clean-machine installs;
  version/checksum/provenance consistency; generated clean diff; hermetic fake-tool PR coverage;
  and non-skipped real Claude/Codex release-candidate compatibility evidence.

### Phase 7 — Deferred P3 gates

Each P3 capability gets a separate future spec and may not enter implementation merely because it
appears in this roadmap.

P3-02 enable/disable is explicitly ordered after completion and validation of every retained and
proposed P0-P2 command in Phases 1-6. Its follow-up spec owns the eventual command naming decision.
P3-06 separately owns any completion installer; 1.0 distribution tasks may place generated
completion files through package-manager conventions but the CLI remains emit-only.

**Entry:** Public 1.0 exits Phase 6. **Exit:** Each deferred capability requires its own accepted
spec, project reference, implementation/test catalog entries, and release gate; no Phase-7 item is
part of 1.0 completion.

---

## 11. Holistic workflow test plans

### EWP-WF01 First installation and orientation

**Commands:**

```sh
brew install smorinlabs/tap/skillsmith
skillsmith agents --capabilities
skillsmith doctor
skillsmith help
skillsmith completion zsh
```

**Matrix:** Homebrew native binary, npm/Bun distribution, direct release binary; zero tools,
Claude-only, Codex-only, both full-lifecycle tools, Kilo-only, OpenCode-only, and mixed
read-only/full-lifecycle detection.

**Assertions:** version matches release; capabilities distinguish detection from write support;
doctor gives useful no-tool output; completion script parses; no files outside documented XDG/tool
roots; uninstall/upgrade instructions work in a disposable environment. Root help contains all 23
commands exactly once in Discover/Manage/Develop/Declarative/Maintain order, with aliases adjacent
and doctor/check under Maintain.
Agents output, CLI/completion choices, schemas, and help derive from one validated adapter registry;
the exact matrix proves Claude/Codex deep/full lifecycle and Kilo/OpenCode read-only mutation exit 4.

### EWP-WF02 Temporary live-only install

**Commands:**

```sh
skillsmith install owner/repo//skills/review --tool claude-code --user --no-save
skillsmith status review
skillsmith install owner/repo//skills/review --tool claude-code --user --no-save
skillsmith uninstall review --tool claude-code --user --no-save
```

**Setup:** hermetic Git remote, empty home/data/config, fake detected tool.

**Assertions:** first run verifies/snapshots/places/records; `--no-save` creates no manifest or lock;
status reports managed-local but undeclared and explains prune behavior; second install is exit-0
noop; uninstall removes the placement and ledger pair while retaining store per policy and reports
that portable files were not changed; final status is absent.

### EWP-WF03 Reproducible project bootstrap

**Commands:**

```sh
skillsmith doctor --fix --dry-run
skillsmith init --dry-run
skillsmith init
skillsmith install owner/repo//skills/review --project --pin
skillsmith plan --locked
skillsmith apply --locked
```

**Setup variants:** absent manifest; exact legacy top-level project config with attached comments;
canonical manifest; mixed/empty/malformed legacy candidate; portable and nonportable legacy paths;
credential-free private remote authenticated through local Git configuration.

**Assertions:** doctor dry-run and init dry-run show the same migrate-project-config mapping for exact legacy
state without writing during preview; init execution uses the byte-identical planned operation and
creates canonical schema when absent or losslessly
migrates exact legacy state without force or lock creation. Mixed/empty/malformed/nonportable state
refuses without normalization or dropped values. Default-saving install writes one declaration and
exact lock entry; comments/order/whitespace/permissions/unrelated schema-valid content are
losslessly preserved; comment/format/order-only edits preserve manifest semantic hash while every
semantic field mutation changes it; lock bytes are canonical; a no-op is byte-identical; external
byte changes are replanned safely or refused; plan after install reports no live drift; apply is
idempotent; a clean clone with only manifest+lock reproduces identical content hashes across
supported platforms.
Manifest/lock contain canonical credential-free source identity only; no local path or seeded
authentication canary appears in portable files or output.

### EWP-WF04 Existing-fleet export and restore

**Commands:**

```sh
skillsmith export --user --file team.toml --lockfile locks/team.lock --dry-run
skillsmith export --user --file team.toml --lockfile locks/team.lock
skillsmith plan --file team.toml --lockfile locks/team.lock --locked
skillsmith apply --file team.toml --lockfile locks/team.lock --locked
```

**Setup:** managed Git install, clean Git dev placement, dirty dev placement, non-Git dev placement,
unmanaged copy, pinned entry, two tools.

**Assertions:** portable entries export; clean dev source converts to remote/source-relative origin;
dirty/non-Git/unmanaged entries warn and skip; strict mode fails; no absolute paths occur in portable
files; existing matching intent/comments/order and unselected declarations are preserved; selected
conflicts block without writes and `--force` updates only those portable conflicts; unchanged rerun
is byte-identical; compatible same-name/source/ref/scope entries merge unique tool lists; incompatible
same-name entries conflict and require narrower selection or separate manifests; Machine B produces
equivalent managed content without copying `placements.json`. Credential-bearing origins are never
exported, local/file/store/dev paths cannot become portable even with force, and canary scans cover
both output streams and the generated pair. The non-sibling lock override requires explicit file,
is reported but not written into the manifest, and is repeated by later direct plan/apply calls;
omitting it intentionally selects the normal sibling `team.lock` instead.

### EWP-WF05 Local development lifecycle

**Commands:**

```sh
skillsmith dev review --source ./skills/review --project --tool claude-code
skillsmith dev review --source ./skills/review --project --tool codex
skillsmith verify ./skills/review --deep --strict
skillsmith status review
skillsmith promote review --project --dry-run
skillsmith promote review --project --strict
skillsmith promote --all --project --continue-on-error --dry-run
skillsmith undo review --project --dry-run
skillsmith undo review --project
skillsmith dev review --project
```

**Assertions:** create/adopt/noop states converge; verification gates match each tool; status joins
both placements; project scope remains explicit through promote/undo/dev; promote snapshot matches
verified bytes; dirty behavior follows policy; undo restores expected state only; final dev link
targets the recorded source; no staging/backup/journal residue. Dev/promote without targets or all
exit 2 before planning; targets plus all conflict; unmatched targets never widen; all dry-run reports
explicit-all provenance.
Root/help-workflows presents dev, verify, and promote as one Development loop, and each development
command's common example parses and matches this workflow.
Generic planning/rendering contains no tool-ID policy; adapters provide roots, gate modes, legacy
notices, and result facts while both Claude Code and Codex deep verification remain exercised.

### EWP-WF06 Interactive plan/apply

**Commands:**

```sh
skillsmith plan
skillsmith apply
skillsmith plan --prune
skillsmith apply --prune
```

**Setup:** manifest producing install, update, relink/move, noop, conflict, and optional removal.

**Assertions:** deterministic ordering and before/after; no deletion without prune; rejecting prompt
leaves filesystem, ledger, manifest, and lock byte-identical; accepting revalidates then executes;
second plan is empty; non-TTY without yes fails before mutation. Deep-frozen observed state is never
mutated; dry-run, approval display, and execution share identical operation IDs/order; execution
never replans behind approval, and expected-revision changes refuse or require a newly displayed
fresh plan.

### EWP-WF07 Saved-plan automation

**Commands:**

```sh
skillsmith plan --locked --out skillsmith.plan
skillsmith apply --plan skillsmith.plan --dry-run
skillsmith apply --plan skillsmith.plan --check
skillsmith apply --plan skillsmith.plan
```

**Assertions:** plan file has restricted permissions, versioned schema/hash domains, operations,
options, explicit portable/machine-bound classification, and no plaintext secret; portable plans
contain no local absolute path, while machine-bound plans name each local binding and refuse on a
different machine/project context. Comment/format-only manifest edits remain valid; semantic manifest,
noncanonical/canonical lock, live resource, content, selection-set, and capability mutations produce
the correct independent refusal naming domain/version and mismatch; apply never silently regenerates
the saved plan; unrelated state remains valid; newly added selected-set entries invalidate it;
existing output refuses without force; forced replacement is atomic; stdout JSON remains separate;
apply leaves the artifact intact.
Saved dry-run validates and renders the exact recorded operations with exit 0; saved check returns 7
for the same valid nonempty set; either returns 3 for stale/incompatible preconditions and neither
replans or writes. Dry-run/check conflict each other, and plan rejects file/lock/tool/scope/locked/
prune/yes/continue options while retaining JSON and inherited output/context controls.
Seeded URL/env/nested-error canaries are absent from the plan, human/JSON/debug streams, journals,
temporaries, backups, and partial-failure residue.
A relevant adapter capability-version change invalidates the saved plan with an exact explanation;
an unrelated adapter or operation capability change leaves it valid.

### EWP-WF08 CI gates

**Commands:**

```sh
skillsmith check --json
skillsmith plan --locked --check --json
skillsmith apply --plan skillsmith.plan --check --json
```

**Setup:** healthy and failing check fixtures, converged and drifting manifests, and a pre-generated
owner-only valid saved plan plus stale variants.

**Assertions:** healthy exits 0; health error exits 1; in-sync plan exits 0; drift exits 7; usage
errors exit 2; a valid nonempty saved plan checks as 7 while stale saved authorization is 3; all
stdout parses as one JSON value; stderr has diagnostics only; all files are byte-identical
before/after.

### EWP-WF09 Update lifecycle

**Commands:**

```sh
skillsmith update --check
skillsmith update review --ref main --pin --check
skillsmith update
skillsmith update review --dry-run
skillsmith update review
skillsmith update --all --continue-on-error --dry-run
skillsmith undo review
```

**Matrix:** branch advanced, tag unchanged, explicitly pinned, forced ref, offline, fetch failure,
verify warning/failure, partial multi-tool result, file bytes/mode/type/symlink/empty-directory hash
changes, cross-platform equivalent source tree.

**Assertions:** check is non-mutating; dry-run equals execution plan; pin policy is honored; lock and
live state commit consistently; old store entry is retained; undo restores prior resolution;
failures remain recoverable; exact SHA/fixed tag are skipped by bulk update; `--ref main` resumes
tracking; `--ref main --pin` stores the newly resolved exact SHA in the manifest.
Targetless check covers every eligible declaration in the selected manifest with bounded-default
provenance; targetless mutation exits 2 and recommends targets or all; targets plus all conflict;
filter-to-zero is an explained exit-0 no-op rather than an implicit bulk update. Check rejects
dry-run/yes but evaluates ref/pin/strict/batch without writing.

### EWP-WF10 Direct sync

**Commands:**

```sh
skillsmith sync --from user --to ./project --tool codex --dry-run
skillsmith sync --from user --to ./project --tool codex
skillsmith sync --from ./project-a --to ./project-b --save
skillsmith sync review --from user --to ./project --force --delete --dry-run
skillsmith sync review --from user --to ./project --force --yes
skillsmith sync --from user --to ./project --continue-on-error --dry-run
skillsmith sync --from user --to ./project --delete --dry-run
```

**Assertions:** source is read-only; destination operations use shared planner; conflicts follow
bounded force/independent confirmation policy; forced edited/unmanaged replacement preserves its
backup and reports stable conflict/effect fields; force does not delete extras or bypass safe saved
artifact merge; delete is separately opt-in; save writes destination portable files; rerun is noop;
tool/scope/path combinations are unambiguous; partial failures report per pair. With no skill names,
the mandatory endpoints bound all source entries and output reports bounded-default; an empty match
never implies destination deletion, which still requires delete.

### EWP-WF11 Crash recovery and undo

**Commands:**

```sh
skillsmith doctor
skillsmith doctor --fix --dry-run
skillsmith doctor --fix --yes
skillsmith status <target>
skillsmith undo
skillsmith <same-operation> <target>
skillsmith undo <pending-target> --project --dry-run
skillsmith undo <pending-target> --project
skillsmith undo <target> --project --dry-run
skillsmith undo <target> --project
skillsmith undo --all --continue-on-error --dry-run
```

**Assertions:** a version-1 ledger is read without mutation and status/doctor report migration
pending; dry-run shows the exact schema transition; doctor fix or the first actual mutator performs
the same visible canonical version-2 migration under lock. Missing ledger alone means empty;
zero-byte, whitespace, truncated, malformed, and newer-version ledgers refuse without reset. A
legacy pending pair journal is preserved and only its same-op resume or pending undo proceeds. Crash
at every migration/journal/rename/ledger/lock/manifest commit point is either resumable or
reversible; status labels resume and abort choices; same-op rerun converges; pending undo restores
the recorded before-state and takes precedence over committed history; committed undo remains
distinctly labeled; conflicting op refuses with exact remediation; edited live copy is preserved as
backup; undo refuses an unrestorable or stale before-state; same-name user/project history requires
scope and never crosses pairs; no cross-pair corruption or successful-operation migration residue.
Targetless undo exits 2 and never guesses the latest operation; all is the only bulk spelling and
reports explicit-all provenance.
The same crash/recovery matrix runs with deterministic Clock/Id ports and never grants a read-only
probe write/lock/process capability.
Repository failures are injected at every stage/commit/rollback/cleanup boundary; coordinator-only
composition restores or resumes state without repositories calling one another or mutating a shared
snapshot.

**Execution ownership:** Phase 3B proves the ledger, journal, history, migration, doctor, and
internal recovery foundation through EWP-P3B-TS04. The complete EWP-WF11 command workflow closes in
Phase 5 with public `undo`, after the Phase-3B repository-composition foundation is also available;
no foundation-only partial workflow may be marked passing.

### EWP-WF12 Removal and GC

**Commands:**

```sh
skillsmith uninstall review --no-save
skillsmith status review
skillsmith apply
skillsmith uninstall review
skillsmith gc --dry-run
skillsmith gc --older-than 30d --yes
skillsmith gc --forget-project /missing/old-project --dry-run
skillsmith gc --forget-project /missing/old-project --yes
```

**Saved before/after GC scenario:** A former project at `/missing/old-project` has been deleted or
moved, but the local ledger still registers its placements as consumers of store object
`sha256:abc`. Ordinary `skillsmith gc --dry-run` reports the missing project and protects that
object because a missing path might be a temporarily detached volume. The operator then runs
`skillsmith gc --forget-project /missing/old-project --dry-run`; the preview shows the exact local
registration that would be forgotten and whether `sha256:abc` would become eligible after all
other live, journal, undo, and retention references are recalculated. With `--yes`, Skillsmith
removes only that local registration and deletes only store objects that are then eligible. It never
opens, edits, or deletes the missing project's `skillsmith.toml` or `skillsmith.lock`. This is useful
after intentionally retiring a project because it releases local cache protection without claiming
authority over portable project state.

**Assertions:** explicit live-only uninstall leaves the declaration visible as drift; apply restores
it; default-saving uninstall removes live state, declaration, and lock entry together; store
retention follows undo policy; GC counts exact bytes; reachable/recent/journaled entries never
delete; dry-run and execution select the same eligible entries; normal GC warns but protects a
missing recorded project using version-2 project registrations rather than a filesystem crawl;
explicit forget changes only its local ledger registration, refuses
current/existing/journaled roots, and deletes only content made eligible after full recalculation.
Plain GC uses the ledger as its bounded-default set but still protects reachability/retention and
requires exact approval; filter-to-zero is an explained exit-0 no-op.

### EWP-WF13 Multi-tool partial failure

**Matrix:** Claude success/Codex failure and inverse across install, apply, sync, update, promote.

**Assertions:** syntax is fully validated before writes; pre-resolution source failure writes
nothing; a resolved install group preserves its full requested tool intent; each pair has an
independent journal/result; an uninstall declaration/lock survives until its selected pair removals
all succeed; update lock intent makes failed pairs visible as revision drift; batch exit uses
documented precedence; successful pairs remain truthful in ledger/status; rerun converges failed
pairs; help never promises whole-invocation or cross-tool atomicity; `--continue-on-error` controls
later operation-group scheduling on every supported multi-target mutator; default fail-fast marks
later groups skipped, continue runs them, invocation-level refusal and cancellation always stop, and
neither policy hides the original failure. Each successful pair advances immutable state revisions;
failed pairs preserve their expected revisions and rerun from a fresh snapshot without shared
in-place ledger mutation.

**Execution ownership schedule:** G4A-04 owns the current Phase-4A foundation in EWP-P4A-TS02.
Apply rows remain in G4B-02, sync rows remain in G5-01, and update rows remain in G5-02. The full
EWP-WF13 workflow executes and signs in G5-05 after those dependencies. This note changes execution
ownership only; the matrix and assertions above remain unchanged.

### EWP-WF14 Scope/shadowing and custom paths

**Commands:**

```sh
skillsmith -C ./project list
skillsmith status review --tool codex
skillsmith install owner/repo//review --scope project --path ./custom/skills
skillsmith plan --scope project
```

**Ownership-first destination matrix (independent fixtures):**

1. From inside a Git repository with no `review` declaration,
   `skillsmith install owner/repo//review --user` writes only the XDG user manifest/lock.
2. If only the project manifest already declares `review`, a later install/uninstall of `review`
   updates that project-owned pair even when the effective scope is user.
3. `--file ./skillsmith.toml --user` intentionally creates or updates a user-scoped declaration in
   the project-owned manifest; explicit artifact selection outranks automatic ownership lookup.
4. If both discovered project and user manifests declare `review`, install/uninstall without
   `--file` exits 2 before live or artifact mutation and names both candidates; `--force` does not
   change that refusal.
5. Every success names the saved manifest/lock pair; every refusal leaves both pairs and live state
   byte-identical.

**Shared project-context matrix (independent fixtures):**

1. From a repository root and two nested directories, install, list, commands, status, config,
   doctor, and uninstall resolve the same Git-top-level project identity and tool roots.
2. `-C <nested-dir>` is applied before discovery but still produces that same Git project root;
   relative CLI paths resolve from the selected nested cwd and serialize relative to project root.
3. A Git worktree whose `.git` is a file resolves through `git rev-parse`, not directory probing;
   symlinked and real entry paths share one ledger identity.
4. Outside Git, the nearest ancestor `skillsmith.toml` defines project root. With no manifest,
   explicit project scope uses effective cwd and an unscoped command retains the user default.
5. A nested discovered manifest or explicit `--file ./team-state.toml` may select configuration or
   artifacts but never relocates live project tool roots. A different live destination requires
   `--path`.
6. `--config ./skillsmith.toml` selects only effective defaults; `--file ./skillsmith.toml` selects
   desired-state ownership. If both name one canonical file it is parsed once with separate roles;
   if both name an exact legacy file, config reads remain available while plan records migration
   before any artifact role can execute.
7. Targetless status uses all entries only inside the selected readable context. Dev/promote/undo
   require targets or all; scoped all stays within that scope, unscoped all uses its documented
   user+current-project set, and targets plus all or empty matches never widen.

**Project-context before/after fixture:** From `/work/acme/packages/api`, current install may write
`/work/acme/.claude/skills/review` while list scans
`/work/acme/packages/api/.claude/skills` and project config writes beside the nested cwd. With the
shared resolver, all project-aware commands use `/work/acme` for live placement and stable identity;
a separately selected nested artifact remains an artifact choice only.

**Scope-aware lifecycle selection matrix:**

1. With `review` in both user and current-project scope, unscoped `dev review`, `promote review`, and
   `undo review` exit 2, list both candidates, and make zero changes.
2. `--user` or `--project` selects exactly one placement/history; an exact dev/promote placement
   path also selects one, while a contradictory scope+path refuses.
3. An absent `dev review --source <path>` defaults to project scope inside Git and user outside Git;
   explicit scope wins and `--dest` never changes it.
4. Unscoped `--all --dry-run` includes eligible user and current-project entries; a scope flag
   narrows the exact preview. Execution requires the normal bulk approval or `--yes`.
5. Human and JSON selections always name tool, scope, canonical path/history identity, and whether
   scope was explicit, inferred, path-derived, or bulk-selected.

**Assertions:** every readable scope is visible; write support is capability-checked; the
ownership-first destination matrix holds independently of cwd and leaves nonselected artifacts
byte-identical; the project-context matrix produces one stable root/ledger identity; the
scope-aware lifecycle matrix prevents cross-scope selection ambiguity; custom path is
resolved from selected cwd and persists as normalized project/home-relative intent; arbitrary
absolute or escaping paths refuse before default-saving mutation and succeed only under explicit
no-save where otherwise valid; direct placement persists as copy while gate/output controls do not;
duplicate identity includes tool; shadow winner is correct; CLI overrides manifest/config; managed
scope remains read-only unless explicitly designed otherwise.

### EWP-WF15 Noninteractive and output contracts

**Matrix:** TTY, pipe, `CI=1`, `--no-prompt`, `--yes`, `--force`, force+yes independence, fresh/
saved apply dry-run/check and conflicts, quiet,
`-v`, `-vv`, color modes, JSON, SIGINT, batch continue/fail-fast, invalid enum/flag, credential URL,
secret environment/config values, nested error causes, partial failures, zero-target, target+all,
unmatched target/glob, and filter-to-zero.

**Assertions:** no prompt in noninteractive mode; yes only approves known displayed selection; quiet
does not hide errors; debug does not corrupt JSON; color follows environment/flags; cancellation is
130 and recoverable; force never implies approval or bypasses another safety gate; usage is 2;
stdout/stderr contract holds.
Every dry-run/check rejects yes before discovery or I/O while retaining no-prompt as an assertion;
apply/update reject combined dry-run/check, plan check rejects out/force, and report-only check
rejects exit-code. Meaningful force/prune/delete/ref/pin/strict/batch preview combinations remain
accepted and alter the rendered operation set.
One recursive redactor prevents every seeded canary from reaching stdout, stderr, JSON, debug,
errors, journals, ledger, plans, temporaries, backups, or crash residue without hiding useful
non-secret refs, hashes, repositories, and local diagnostic paths.
Selection failures occur before prompting/planning, bounded defaults and explicit selections are
distinguishable in human/JSON, completion never injects all, and a valid filter-to-zero remains an
exit-0 explained no-op.
For every command, common workflows precede grouped complete options; advanced flags remain visible,
and every option appears once with stable family ordering in TTY and pipe output.
All commands traverse one runtime adapter: usage, interaction, rendering, redaction, cancellation,
and exit behavior remain identical after application-service migration, and no command module writes
or exits directly.
The matrix runs through both the 1.x ScanEnv compatibility facade and focused ports backed by the
same real adapters; raw environment secrets never enter domain requests or reports.

### EWP-WF16 Documentation-driven manual test

**Procedure:** extract shell blocks marked runnable from README and user help; execute them in
hermetic temp homes/remotes with documented prerequisites; validate expected exit/output; run cleanup;
scan active docs for stale milestones, superseded authority claims, unavailable commands, invalid
flags, private paths, and dead links.

**Assertions:** every advertised command/option exists; examples match actual output shape; no example
mutates the developer's real fleet; cleanup restores baseline; capability/version claims are current;
every conflicting active statement is updated, retained as a current-behavior migration note,
explicitly superseded with a pointer, or archived.
Legacy project-config documentation shows the exact before/after mapping, read-only 1.x support,
blocked mixed/nonportable cases, doctor fix, and no separate migrate command.
The generated 23-row command/question/minimal-invocation matrix matches root help, README, command
pages, completion, and Section 13.4; no question overlaps and every common example executes.
CommandSpec metadata is the single generated source for those surfaces; a fixture command proves a
new command can join parser/help/completion/docs and execution without a command-local runtime.
Architecture/ADR documentation names capability-scoped ports, the 1.x ScanEnv deprecation window,
and the no-duplicate-adapter rule consistently with public types and lint zones.

---

## 12. Decision register

This historical register records every resolved decision, user answer, rationale, rejected
alternative, affected section, date, and later consistency amendment. No decision remains
unresolved; a substantive change updates its status/record and cites the consistency finding.

| ID | Decision | Recommendation | Alternative | Status |
|---|---|---|---|---|
| D-001 | User-facing planning command | Separate `plan`; plain `apply` also plans | Only `apply --dry-run` | accepted |
| D-002 | Saved executable plans | Optional `plan --out` + `apply --plan` | Display-only plan | accepted |
| D-003 | Project config/manifest | Unified `skillsmith.toml` | Separate config and manifest | accepted |
| D-004 | Portable resolution | Separate committed `skillsmith.lock` | Manifest pins only | accepted |
| D-005 | Capture live fleet | Dedicated `export` | `init --from-installed` | accepted |
| D-006 | Mutate manifest imperatively | Save by default; `--no-save` for temporary operations | New add/remove/manifest verbs | modified |
| D-007 | Direct live synchronization | Keep narrow `sync` over shared planner | Remove; export/apply only | accepted |
| D-008 | Detailed inspection | Add `status`; keep list compact | Expand list only | accepted |
| D-009 | Local dev linking | Keep `dev --source`; no `link` | Add link alias/command | accepted |
| D-010 | Reversal and crash recovery | One `undo` for pending abort/committed reversal plus same-op resume | Separate undo/recover/abort verbs | modified |
| D-011 | Update/outdated/diff | One `update` with check/dry-run | Separate commands | accepted |
| D-012 | Store cleanup naming | Flat `gc` | `store gc` | accepted |
| D-013 | Enable/disable | Post-core follow-up; syntax undecided | Add top-level commands now | modified |
| D-014 | Plain apply interaction | Plan, show, confirm, execute | Execute immediately | accepted |
| D-015 | Lock enforcement | Default can resolve; `--locked` strict | Always require lock | accepted |
| D-016 | 1.0 boundary | P0-P2 and Phases 1-6 block 1.0 | Earlier P0/P1 or distribution-first release | accepted |

#### D-001 — User-facing planning command

- **Status:** accepted
- **Answer:** Use a separate canonical `skillsmith plan` command. Plain `skillsmith apply` also
  computes and displays a fresh plan before confirmation and execution. Retain
  `skillsmith apply --dry-run` as a compatibility alias for non-mutating planner behavior, but do
  not make it the primary documented planning interface. CI may use `skillsmith plan --check`.
- **Rationale:** Planning is an independently useful and discoverable user task. A separate command
  makes the mutation boundary explicit, keeps automation readable, and mirrors the user's mental
  model without forcing routine interactive apply through a saved-plan ceremony.
- **Rejected alternatives:** An `apply --dry-run`-only interface hides planning in options and makes
  the same command name represent both pure inspection and mutation. Requiring every apply to
  consume a separately saved plan would add friction to ordinary interactive use.
- **Affected sections:** 1, 2.3, 3.2, 3.3, P1-07, P1-08, 7 (`plan`, `apply`), EWP-P4A,
  EWP-P4B,
  EWP-WF06, EWP-WF07, EWP-WF08, EWP-CMD-PLAN-TS01..12, EWP-CMD-APPLY-TS01..14.
- **Recorded:** 2026-07-10

#### D-002 — Saved executable plans

- **Status:** accepted
- **Answer:** Support optional `skillsmith plan --out <file>` and
  `skillsmith apply --plan <file>`. A saved plan contains the exact ordered operations, relevant
  execution options, Skillsmith/schema versions, and hashes or equivalent preconditions for the
  manifest, lockfile, live state, resolved content, and required tool capabilities. Applying it
  executes only that reviewed operation set and refuses stale preconditions without silently
  replanning. Ordinary `skillsmith apply` remains the primary interactive path and requires no
  saved artifact.
- **Rationale:** Optional saved plans support review/approval boundaries and separated CI planning
  and execution stages while preserving the ergonomic one-command interactive workflow. Exact
  execution plus precondition validation prevents approval of one change set from authorizing a
  different one.
- **Rejected alternatives:** Display-only planning cannot carry an approved operation set into a
  later execution stage. Requiring a saved plan for all applies adds unnecessary ceremony. Treating
  a stale saved plan as permission to replan would violate the review boundary.
- **Affected sections:** 2.3, 3.2, P1-07, P1-08, 7 (`plan`, `apply`), EWP-P4B-T03..T05,
  EWP-WF06, EWP-WF07, EWP-WF08, EWP-CMD-PLAN-TS09..10,
  EWP-CMD-APPLY-TS06..07.
- **Recorded:** 2026-07-10

#### D-003 — Unified project configuration and manifest

- **Status:** accepted
- **Answer:** Use one canonical project-level `skillsmith.toml` for portable project defaults and
  desired skill declarations. Use explicit sections such as `[defaults]` and `[[skills]]`. Keep
  user/system configuration in the existing non-project configuration locations, exact portable
  resolutions in `skillsmith.lock`, and machine-local placement/transaction state in
  `placements.json`. Continue reading the legacy project-file shape during a documented migration
  window; canonical project writes use the new schema, and `doctor` reports the migration action.
- **Rationale:** One project file gives users a single discoverable source of desired state and
  avoids duplicated or contradictory tool/scope defaults across two files. Explicit schema
  sections preserve conceptual separation without adding another artifact.
- **Rejected alternatives:** Separate project config and manifest files add discovery and precedence
  complexity while still needing rules for overlapping defaults. Reusing the unified file without
  a versioned migration would make current strict-schema projects fail unexpectedly.
- **Affected sections:** 2, 2.1, 3.3, P0-02, P0-07, P1-05, P1-09, 7 (`config`, `init`,
  `install`, `uninstall`, `plan`, `apply`), EWP-P1-T02, EWP-P1-T07, EWP-P2-T01..T05,
  EWP-P4A-T01,
  EWP-WF03, EWP-WF04, EWP-CMD-CONFIG-TS01..05, EWP-CMD-INIT-TS01..05.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-029 (structural discriminator, lossless visible migration,
  exact-legacy read support through 1.x, and no separate migrate command)

#### D-004 — Separate portable lockfile

- **Status:** accepted
- **Answer:** Maintain a separate, portable, normally committed `skillsmith.lock` beside
  `skillsmith.toml`. The manifest records requested intent; the lock records exact resolved SHAs,
  source-relative paths, content hashes, and its manifest relationship. `apply --locked` refuses a
  missing, stale, or incomplete lock. Default interactive apply may propose resolution changes, but
  must expose them in the plan. Default-saving `install`/`uninstall`, `export`, `apply`,
  `sync --save`, and `update` maintain the lock automatically; do not add a standalone `lock`
  command initially. Keep paths, placement modes, store locations, journals, and transactions in
  local `placements.json` only.
- **Rationale:** Separating requested references from immutable resolutions makes project intent
  readable while enabling byte-reproducible application and reviewable dependency updates. It also
  prevents machine-local state from leaking into the portable contract.
- **Rejected alternatives:** Embedding generated pins in the manifest mixes user intent with
  resolution output and makes routine branch/tag changes noisy. Treating `placements.json` as a
  lockfile is non-portable. A standalone `lock` command duplicates the normal workflows that
  already create or update resolution state.
- **Affected sections:** 2, 2.2, 2.4, 3.3, P1-06..P1-10, P2-02, 7 (`install`,
  `uninstall`, `export`, `plan`, `apply`, `sync`, `update`), EWP-P2-T03..T04,
  EWP-P4A-T01..T02, EWP-P4B-T03..T05, EWP-WF03, EWP-WF04, EWP-WF07, EWP-WF08,
  EWP-CMD-PLAN-TS04, EWP-CMD-APPLY-TS04, EWP-CMD-EXPORT-TS06..09.
- **Recorded:** 2026-07-10

#### D-005 — Dedicated fleet export

- **Status:** accepted
- **Answer:** Add a dedicated `skillsmith export` command that inspects selected live placements
  and produces or updates portable `skillsmith.toml` and `skillsmith.lock` artifacts. Managed remote
  installs export exact provenance. Clean Git development sources may be converted to a remote,
  requested revision, and source-relative path. Dirty Git, non-Git local, unmanaged, or
  insufficient-provenance entries warn and skip by default and fail under `--strict`. Absolute
  machine paths and store paths never enter the output. Support tool/scope selection, explicit
  output files, dry-run, JSON, and safe existing-file merge. Preserve matching human intent and
  unrelated declarations; block selected conflicts unless `--force`, which makes only selected
  portable live entries authoritative without deletion or whole-file overwrite. Keep
  `skillsmith init` limited to creating a canonical empty project skeleton.
- **Rationale:** Exporting is a distinct reverse-engineering and portability workflow with
  ambiguity, provenance, conflict, and strictness concerns that do not belong in simple project
  initialization. The command name is immediately discoverable for backup and machine-migration
  use cases.
- **Rejected alternatives:** `init --from-installed` overloads initialization with live-state
  classification and makes its safety behavior harder to explain. Copying `placements.json` cannot
  reproduce a fleet and would leak machine-local paths and transaction state.
- **Affected sections:** 1, 2, 3.2, P1-05, P1-06, 7 (`init`, `export`), EWP-P2-T05,
  EWP-P4A-T02, EWP-WF03, EWP-WF04, EWP-WF16, EWP-CMD-INIT-TS01..05,
  EWP-CMD-EXPORT-TS01..09.
- **Recorded:** 2026-07-10

#### D-006 — Desired-state-first install and uninstall

- **Status:** modified
- **Answer:** `skillsmith install` and `skillsmith uninstall` update the applicable manifest and
  lockfile by default through the shared journaled coordinator. A source/declaration group owns
  artifact intent while each tool placement commits independently; partial results remain truthful
  and rerunnable rather than claiming whole-invocation atomicity. Add `--no-save` as the explicit
  temporary/live-only escape hatch. Resolve the destination deterministically: explicit `--file`,
  then a unique existing declaration owner, then a new project or XDG user desired-state manifest
  according to effective placement scope. Ambiguous owners refuse. Keep the user desired-state
  manifest distinct from user `config.toml`.
  `uninstall` does not create an empty manifest and refuses ambiguous owning declarations. Dry-run
  and normal output show all live, manifest, and lock effects; `--no-save` output explains the
  resulting drift and what a future apply or apply-prune will do.
- **Rationale:** Persisted desired state is expected to be the common path, so the shortest command
  should be reproducible by default. Temporary divergence remains possible but requires an explicit
  option that communicates intent. A deterministic destination prevents cwd-dependent or
  scope-dependent writes from being surprising.
- **Rejected alternatives:** Explicit `--save` makes the common reproducible workflow longer and
  makes accidental undeclared installations easy. New `add`/manifest-`remove` verbs duplicate the
  lifecycle grammar and collide with the existing `remove` alias. Silent live-only behavior when no
  manifest exists would contradict the default-save contract.
- **Affected sections:** 2, 2.1, 2.2, 3.3, P1-09, 8.6, 8.7, EWP-P2-T01,
  EWP-P2-TS02,
  EWP-P4A-T01, EWP-P4A-T03, EWP-WF02, EWP-WF03, EWP-WF14,
  EWP-CMD-INSTALL-TS06..08, EWP-CMD-UNINSTALL-TS04..07, 13.2, 13.3,
  EWP-CF-021, EWP-CF-022.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-021
- **Amended:** 2026-07-11 by EWP-CF-022 (defines the shared effective project root without changing
  ownership-first destination precedence)

#### D-007 — Narrow direct synchronization

- **Status:** accepted
- **Answer:** Retain a narrowly scoped `skillsmith sync --from <location> --to <location>` command
  for direct live-location reconciliation. It is additive by default; `--delete` explicitly enables
  destination-only removal. Support tool filtering, dry-run, conflict refusal/explicit force, and
  `--save` to update destination manifest and lock artifacts. Implement it strictly as a consumer of
  the shared planner and executor, with no independent synchronization engine or operation
  semantics.
- **Rationale:** Direct user-to-project and project-to-project transfer is a coherent, discoverable
  task that would otherwise require a multi-step export and destination apply workflow. Keeping the
  command narrow preserves that convenience without duplicating lifecycle architecture.
- **Rejected alternatives:** Requiring export plus apply for every transfer keeps fewer commands but
  adds ceremony to common local reconciliation. A separate sync engine would create drift in
  conflict, deletion, ordering, and recovery semantics.
- **Affected sections:** 1, 2, 3.2, P1-10, 8.15, EWP-P5-T01..T02, EWP-WF10,
  EWP-WF13, EWP-CMD-SYNC-TS01..10, 13.2, 13.3.
- **Recorded:** 2026-07-10

#### D-008 — Dedicated correlated status

- **Status:** accepted
- **Answer:** Add `skillsmith status [skill...]` for correlated desired, locked, ledger, live,
  verification, shadowing, and journal state. Support tool/scope filtering, JSON, and `--check` for
  automation-visible drift. Keep `skillsmith list` a compact deterministic installed inventory;
  `list --long` exposes expanded inventory fields but does not absorb reconciliation or recovery
  diagnostics.
- **Rationale:** Inventory and convergence are different user questions. Separating them keeps the
  frequent list path bounded and scannable while giving drift, undeclared installs, missing
  declarations, revision/content mismatches, shadowing, and interrupted operations a coherent home.
- **Rejected alternatives:** Expanding `list` into a full state join recreates its current
  large-output problem and entangles display filtering with automation exit semantics. A separate
  `show` command would overlap with target-filtered `status`.
- **Affected sections:** 1, 3.2, 3.3, P1-01, P1-02, 8.3, 8.4, EWP-P3A-T01..T04,
  EWP-WF02, EWP-WF05, EWP-WF11, EWP-WF12, EWP-WF14,
  EWP-CMD-LIST-TS01..07, EWP-CMD-STATUS-TS01..06.
- **Recorded:** 2026-07-10

#### D-009 — One local development lifecycle

- **Status:** accepted
- **Answer:** Keep `skillsmith dev <name> --source <path>` as the only command for creating or
  adopting an editable local placement; do not add `link`. Record the absolute development source
  in local state, make repeated runs idempotent, allow `promote` to snapshot verified bytes, and
  allow a later `dev <name>` to return to the recorded source. Preserve tool selection, dry-run,
  verification, bulk-safety, and undo behavior within the existing lifecycle.
- **Rationale:** `dev`, `promote`, and `undo` express the user intent and state transitions more
  clearly than a generic filesystem-oriented link verb. One vocabulary avoids two commands with
  overlapping adopt, replace, verify, and ledger semantics.
- **Rejected alternatives:** A separate `link` command or alias would need nearly the same options
  and state machine as `dev`, while leaving its relationship to pinned/store-backed placements and
  promotion ambiguous.
- **Affected sections:** 1, 3.3, P1-04, 8.8, EWP-P5-T05, EWP-WF05,
  EWP-CMD-DEV-TS01..06, EWP-CMD-PROMOTE-TS01..06.
- **Recorded:** 2026-07-10

#### D-010 — Undo pending or committed changes; resume interrupted operations

- **Status:** modified
- **Answer:** Add one `skillsmith undo` command. For a selected target with a pending journal, undo
  aborts the pending operation and restores its recorded before-state; pending state always takes
  precedence over an older committed action. Otherwise undo reverses the last eligible committed
  operation whose retained state still satisfies its preconditions. Rerunning the original command
  remains the resume/complete path. `status` and undo dry-run explicitly label `abort pending` versus
  `reverse committed`, including transaction ID, phase, before-state, and retention requirements.
  Support target/tool/all selection, JSON, and meaningful bulk confirmation. Preserve existing
  verb-specific rollback forms as deprecated aliases; do not add generic recover or abort commands.
  Undo requires an explicit target or all and never guesses the latest operation globally.
- **Rationale:** Users need both safe choices after interruption: finish the intended operation or
  restore its before-state. One context-sensitive but explicitly labeled undo command preserves a
  compact surface while same-command resume retains the original arguments needed for completion.
- **Rejected alternatives:** A separate generic `recover` command would need to rediscover the
  interrupted command and its inputs, competing with safer idempotent rerun behavior. Separate
  `abort` or per-command rollback options duplicate selection and recovery semantics.
- **Affected sections:** 1, 2.4, 3.2, 3.3, P1-11, 8.17, EWP-P5-T05,
  EWP-WF05, EWP-WF09, EWP-WF11, EWP-WF12, EWP-CMD-UNDO-TS01..09,
  EWP-CMD-INSTALL-TS08, EWP-CMD-UNINSTALL-TS07, EWP-CMD-UPDATE-TS07..08.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-031 (target-or-all required; no implicit latest selection)

#### D-011 — One update lifecycle

- **Status:** accepted
- **Answer:** Add one `skillsmith update [target...]` lifecycle. `--check` discovers available
  changes without writing and provides an automation exit; `--dry-run` renders the exact planner
  operations, lock changes, verification outcome, and affected tools; plain update plans, confirms
  when required, verifies, executes, and commits lock/ledger state. Support target/all/tool
  selection, explicit `--ref`, `--pin`, strictness, JSON, and confirmation. Exact SHAs and fixed
  tags produce no candidates unless explicitly changed. `--ref <moving-ref>` resumes tracking;
  combining an existing or explicit moving ref with `--pin` stores its newly resolved SHA as
  portable manifest intent. Moving references otherwise follow the documented candidate policy.
  Retain previous immutable content for undo. Do not add separate `outdated` or `diff` commands.
  “Plain update” means execution mode after explicit target/all selection; targetless mutation is a
  usage error, while targetless check safely inspects the selected manifest.
- **Rationale:** Candidate discovery, before/after calculation, verification, and execution are one
  coherent workflow with different mutation modes. Options keep those modes discoverable without
  creating commands whose meanings overlap with planner and status concepts.
- **Rejected alternatives:** Separate `outdated`, `diff`, and `update` commands duplicate selection,
  source resolution, and output contracts. `diff` is especially ambiguous between source content,
  live filesystem state, and planned operations.
- **Affected sections:** 1, 2.2, 3.2, 3.3, P2-02, 8.16, EWP-P5-T03..T04,
  EWP-WF09, EWP-WF11, EWP-WF13, EWP-CMD-UPDATE-TS01..10,
  EWP-CMD-UNDO-TS03.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-031 (targetless check only; mutation requires target or all)

#### D-012 — Flat garbage collection with repair elsewhere

- **Status:** accepted
- **Answer:** Add flat `skillsmith gc`; do not expose a `store` namespace. GC removes only
  unreachable immutable store entries and disposable generated overlays, subject to age, live
  placement, local-ledger, journal, backup, and undo-retention protections. It does not crawl for
  portable locks or infer that a missing project is obsolete. Add repeatable
  `--forget-project <exact-path>` to explicitly remove an absent, non-current, journal-free project's
  local ledger registration before recalculating reachability. Support dry-run, exact byte/item
  reporting, JSON, age threshold, and required noninteractive approval;
  provide no force path that deletes reachable content. Diagnose corruption with `doctor`; perform
  deterministic non-destructive repairs through `doctor --fix`; restore declared state through
  `apply`; resume interrupted operations by rerunning them. Never repair immutable bytes in place:
  quarantine/preserve corruption, reacquire trusted content into staging, verify it, and atomically
  replace the entry.
- **Rationale:** GC is a clear top-level maintenance task, while the store otherwise remains an
  implementation detail. Repair spans configuration, placement, declaration, transaction, and
  content concerns, so it belongs in diagnosis plus the owning lifecycle rather than a store-only
  namespace.
- **Rejected alternatives:** `store gc` adds a single-command namespace without useful list or
  inspect workflows. A generic `store repair` would obscure whether the correct recovery is relink,
  apply, reacquire, resume, or refuse, and could imply unsafe mutation of content-addressed bytes.
- **Affected sections:** 2.4, 3.2, 3.3, P2-03, P2-07, 8.10, 8.18,
  EWP-P5-T06, EWP-WF11, EWP-WF12, EWP-CMD-DOCTOR-TS05..06,
  EWP-CMD-GC-TS01..08.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-016

#### D-013 — Enable/disable as a post-core follow-up

- **Status:** modified
- **Answer:** Defer all enable/disable mutation work to a separately approved follow-up that begins
  only after every retained and proposed P0-P2 command in Phases 1-6 is implemented and validated.
  Until then, `list`, `status`, and capability reporting may read and explain enabled, disabled, and
  unconfigured states, but Skillsmith does not promise cross-tool writes. Do not preselect
  top-level `enable`/`disable` or `config enable|disable`; the follow-up first specifies tool
  capability, placement-versus-configuration semantics, user/project precedence, rollback, and
  unsupported-tool behavior, then decides whether a generic command is warranted and what it is
  called.
- **Rationale:** Deferral prevents an incomplete secondary lifecycle from distracting from or
  destabilizing the core install/develop/plan/apply/update/undo workflow. Deferring syntax as well
  avoids making a command promise before the cross-tool operation has one coherent meaning.
- **Rejected alternatives:** Adding top-level verbs now implies support that is not consistent
  across tools. Precommitting to config subcommands assumes enablement is always a configuration
  edit rather than a lifecycle or placement operation.
- **Affected sections:** 3.3, P2-06, P3-02, Phase 7, EWP-CMD-LIST-TS05,
  EWP-CMD-STATUS-TS01..06, EWP-CMD-AGENTS-TS03.
- **Recorded:** 2026-07-10

#### D-014 — Fresh apply approval and saved-plan authorization

- **Status:** accepted
- **Answer:** Plain `skillsmith apply` loads state, computes and displays a fresh deterministic
  plan, exits without prompting when unchanged, prompts with No as the default when an interactive
  run has changes, revalidates immediately before mutation, executes, and reports. A fresh
  noninteractive apply with changes refuses unless `--yes` is present; `--no-prompt` never implies
  approval. Rejection or cancellation leaves filesystem, manifest, lock, and ledger unchanged, and
  `--prune` remains required for undeclared-content removal. An explicit
  `skillsmith apply --plan <reviewed-plan>` executes without a second confirmation because selecting
  that exact artifact is authorization, but only after all saved-plan preconditions pass.
- **Rationale:** The fresh path makes mutation reviewable and safe by default without adding steps
  to a no-op. Treating an exact saved plan as authorization preserves practical separated
  plan/approval/execution automation while the stale-plan contract prevents its scope from
  changing.
- **Rejected alternatives:** Immediate fresh execution makes accidental invocation mutating and
  weakens the accepted plan/apply boundary. Requiring `--yes` for an explicitly selected saved plan
  repeats its approval signal without improving operation-set integrity. Treating `--no-prompt` as
  approval would make a noninteraction control destructive.
- **Affected sections:** 1, 2.3, P1-04, P1-08, 8.14, EWP-P4B-T01,
  EWP-P4B-T03..T04,
  EWP-WF06, EWP-WF07, EWP-WF15, EWP-CMD-APPLY-TS01..02,
  EWP-CMD-APPLY-TS05..07, EWP-CMD-APPLY-TS13.
- **Recorded:** 2026-07-10

#### D-015 — Visible default resolution; strict locked mode

- **Status:** accepted
- **Answer:** Default plan/apply may resolve missing, stale, or incomplete portable lock data, but
  every proposed lock entry/change is part of the displayed operation set and only an accepted
  apply writes it. Never silently change a requested manifest reference. `--locked` provides a
  frozen-input contract: refuse missing lockfiles, stale manifest relationships, absent or
  incomplete entries, source-identity mismatches, or any operation that would modify the lock.
  Saved plans preserve the lock policy under which they were created, and apply cannot weaken it.
- **Rationale:** Visible default resolution supports first use and routine manifest editing without
  a standalone lock command, while strict locked mode gives CI and clean-machine reproduction an
  auditable immutable-input guarantee.
- **Rejected alternatives:** Requiring a complete lock for every command creates a bootstrap gap and
  unnecessary interactive ceremony. Allowing locked mode to refresh data would make its name and CI
  guarantee misleading.
- **Affected sections:** 2.2, 2.3, P1-07, P1-08, 8.13, 8.14,
  EWP-P4B-T03..T05, EWP-WF03, EWP-WF06..WF08,
  EWP-CMD-PLAN-TS04, EWP-CMD-PLAN-TS09,
  EWP-CMD-APPLY-TS04, EWP-CMD-APPLY-TS06..07.
- **Recorded:** 2026-07-10

#### D-016 — Complete core workflow before 1.0

- **Status:** accepted
- **Answer:** Do not release Skillsmith 1.0 until every P0, P1, and P2 item in Phases 1-6 is
  implemented and validated, including the retained and new command surface, stable output/error
  contracts, manifest/lock/plan/apply lifecycle, synchronization, update, undo, GC, help,
  completion, capabilities, safe repairs, distribution, per-command test slices, holistic workflow
  tests, and final consistency gates. Phase 7/P3 capabilities are explicitly post-1.0 follow-ups.
- **Rationale:** The P0-P2 surface is the complete core product workflow. Freezing 1.0 only after it
  operates coherently avoids stabilizing partial lifecycle, machine-output, recovery, or maintenance
  contracts and then correcting them incompatibly in 1.x.
- **Rejected alternatives:** A P0+P1 boundary ships sooner but leaves operational commands and
  consistency work to change after the stability promise. Distribution-first 1.0 labels the CLI
  stable before its declarative lifecycle is complete. Making P3 block 1.0 would delay the core for
  intentionally deferred ecosystem work.
- **Affected sections:** Status header, P0-P3 priorities, Phases 1-7, EWP-WF01..WF16,
  Section 13, Section 14, Section 15.
- **Recorded:** 2026-07-10

### Decision record template

```markdown
#### D-NNN — <title>

- **Status:** accepted | modified | rejected
- **Answer:** <user decision>
- **Rationale:** <why>
- **Rejected alternatives:** <what and why>
- **Affected sections:** <section/task/test IDs>
- **Recorded:** YYYY-MM-DD
```

---

## 13. Consistency and quality gate after decisions

Do not mark this plan implementation-ready until all checks pass.

### 13.0 Review finding register

| ID | Bucket | Finding | Resolution | Status |
|---|---|---|---|---|
| EWP-CF-001 | Following bad precedent | Artifact, inspection, transaction, and apply phases had inverted dependencies | Reordered Phases 2-4 and made shared transaction primitives precede new mutations | accepted |
| EWP-CF-002 | Following bad precedent | Operation kinds mixed executable work with planner dispositions and outcomes | Split Plan operations, checks, diagnostics, and execution results | accepted |
| EWP-CF-003 | Breaking precedent | Repeatable/positional manifest composition had no ownership, lock, precedence, or prune rules | One singular manifest and deterministically paired lock per invocation for 1.0 | accepted |
| EWP-CF-004 | Breaking precedent | Drift exit 7 was introduced without a complete taxonomy or safe batch precedence | Defined global 0-7/130 meanings and error-before-drift selection | accepted |
| EWP-CF-005 | New pattern introduced | Default-save artifact atomicity conflicted with accepted per-tool partial success | Source/declaration artifact groups with independently journaled tool placements | accepted |
| EWP-CF-006 | Breaking precedent | Same-operation resume provided no way to abandon a pending transaction | `undo` aborts pending before-state or reverses committed state; rerun resumes | accepted |
| EWP-CF-007 | Breaking precedent | “Supported tool” did not define read versus write coverage or the 1.0 adapter boundary | Four-tool read matrix; Claude/Codex full lifecycle and deep verify; Kilo/OpenCode read-only until P3 | accepted with correction |
| EWP-CF-008 | Following bad precedent | Ledger-only `--pin` was redundant once every lock entry resolved exactly | Pin rewrites portable manifest intent to exact SHA; explicit moving `--ref` resumes tracking | accepted |
| EWP-CF-009 | New pattern introduced | One saved-plan state hash was globally brittle or locally incomplete | Scoped resource, selected-set, capability, and executor preconditions | accepted |
| EWP-CF-010 | Breaking precedent | Command summaries could not prove exact option coverage, defaults, conflicts, or live drift | Added normative shared/per-command registry and parser consistency gates | accepted |
| EWP-CF-011 | New pattern introduced | Export had no safe ownership policy for an existing manifest/lock pair | Non-destructive merge by default; force only selected portable conflicts | accepted |
| EWP-CF-012 | Following bad precedent | Current object TOML writer destroys comments and creates empty lock targets | Lossless human edits, canonical generated writes, absent-file group lock, journaled pair commit | accepted |
| EWP-CF-013 | Breaking precedent | Flat command count exceeded the older hierarchy threshold | Keep flat intentionally; organize help/docs by five workflow groups with Development explicit | accepted with addition |
| EWP-CF-014 | Following good precedent | Completion installation ownership was left as an unnamed 1.0 decision | Emit-only in 1.0; package/manual installation; named P3 installer follow-up | accepted with addition |
| EWP-CF-015 | New pattern introduced | Saved-plan output had no ownership or overwrite policy | Create-only owner-mode artifact; force only with out; atomic replacement; no stdout artifact | accepted |
| EWP-CF-016 | New pattern introduced | GC referred to undefined known-project/lock discovery | Ledger-authoritative reachability; no crawl; explicit missing-project forget and recalculation | accepted |
| EWP-CF-017 | Following bad precedent | Active research/help remained contradictory and ambiguously authoritative | Explicit authority hierarchy plus section-level documentation drift ledger before implementation | accepted |
| EWP-CF-018 | Breaking precedent | Plan status/counts/conditional markers and one phase ID remained pre-decision or stale | Scrubbed metadata and added mandatory structural validation | accepted |
| EWP-CF-019 | New pattern introduced | Manifest/lock entries had no stable uniqueness rule | Unique manifest name identity with one declaration/lock entry and explicit rename operations | accepted |
| EWP-CF-020 | New pattern introduced | Default-save did not distinguish persistent placement intent from one-time execution controls | Persist source/ref/tools/scope/copy/path; keep gate/force/output controls execution-only | accepted |
| EWP-CF-021 | New pattern introduced | Scope-only destination selection could dirty the wrong manifest or make behavior cwd-dependent | Explicit file, then unique declaration owner, then scope-based new destination; ambiguous owners refuse | accepted |
| EWP-CF-022 | Following bad precedent | Install, inspection, and config paths could resolve “project” from different bases | One shared ProjectContext; artifact selection never silently rebases live project roots | accepted |
| EWP-CF-023 | Breaking precedent | Target option dispositions did not preserve a complete transition from the live parser | Closed current-to-1.0 migration ledger with compatibility phases and introspection gate | accepted |
| EWP-CF-024 | Breaking precedent | Dev, promote, and undo promised user/project support without scope-aware selection | Shared explicit/inferred/path/bulk scope selection with ambiguity refusal | accepted |
| EWP-CF-025 | New pattern introduced | Force had multiple narrow meanings while sync force and universal non-bypass limits were undefined | Bounded selected-conflict override with per-command authority and stable result fields | accepted |
| EWP-CF-026 | Breaking precedent | Multi-target mutators had inconsistent and uncontrollable later-group failure scheduling | One deterministic group/pair model with fail-fast default and explicit continuation | accepted |
| EWP-CF-027 | New pattern introduced | Artifact hashes were named without versioned domains or canonical inputs | Domain-separated SHA256 with explicit canonical inputs and schema-version refusal | accepted |
| EWP-CF-028 | Breaking precedent | The strict version-1 ledger had no evolution path and interpreted existing empty files as empty state | Visible atomic version-1-to-2 migration, corruption refusal, and no new migrate command | accepted |
| EWP-CF-029 | Breaking precedent | Legacy project config and canonical manifest shared a path without an exact shape or migration boundary | Structural discrimination and lossless visible conversion with legacy reads through 1.x | accepted |
| EWP-CF-030 | Following bad precedent | Literal source inputs and ambiguous saved-plan portability could leak credentials or machine paths | Credential-free canonical identity, recursive redaction, and explicit portable/machine-bound plans | accepted |
| EWP-CF-031 | Breaking precedent | Optional targets plus all left targetless mutation and bounded read defaults ambiguous | Explicit target-or-all mutation with named bounded-default exceptions and selection provenance | accepted |
| EWP-CF-032 | New pattern introduced | Twenty-three flat commands lacked unique primary-question and progressive-help proof | Five intent groups, 23 exclusive questions, minimal invocations, and complete grouped options | accepted with modification |
| EWP-CF-033 | Following bad precedent | Command files duplicated parsing, environment, interaction, rendering, and exit orchestration | Declarative specs plus one CLI runtime and public core application-service boundary | accepted |
| EWP-CF-034 | Following bad precedent | ScanEnv granted every subsystem a growing read/write/process/lock capability set | Scoped effect ports with typed configuration and a 1.x compatibility facade | accepted |
| EWP-CF-035 | Following bad precedent | Mutable ledgers and monolithic runners mixed observation, planning, execution, and persistence | Immutable snapshots, pure planners, domain repositories, and coordinator-only writes | accepted |
| EWP-CF-036 | Breaking precedent | Supported/writable tool arrays and generic tool-name branches duplicated capability policy | One validated descriptor/bundle adapter registry as executable capability authority | accepted |
| EWP-CF-037 | Following bad precedent | Domain types, persistence schemas, and command JSON schemas manually repeated wire shapes and stripped internal fields ad hoc | One versioned codec authority per wire contract with inferred DTOs and explicit domain mappings | accepted |
| EWP-CF-038 | Following bad precedent | Free-form optional logger strings and direct command output lacked operation correlation and uniform verbosity behavior | Typed operation-scoped observation events with one redacted stderr sink and journal independence | accepted |
| EWP-CF-039 | Breaking precedent | Named validations, skipped live suites, CI recipes, and release publication had no closed executable ownership or exact-SHA gate | Machine-readable validation ownership plus canonical PR/release recipes and gated publication | accepted |
| EWP-CF-040 | Breaking precedent | Optional custom lock placement was exposed by only part of the manifest/lock lifecycle and could not be diagnosed or reused consistently | Sibling default plus uniform explicit file+lockfile override on every pair consumer | accepted with modification |
| EWP-CF-041 | Breaking precedent | Init executed before the shared operation model and could force-replace a manifest without preview | Phase-2 artifact foundation plus Phase-4A planned init execution and dry-run | accepted |
| EWP-CF-042 | Breaking precedent | Saved-plan apply accepted dry-run/check without defining whether they reject, replan, validate, or which exits win | Exact non-mutating saved-plan validation modes and closed option conflicts | accepted |
| EWP-CF-043 | Breaking precedent | Preview/check modes could silently accept meaningless approval or contradictory output/exit modes | One non-mutating mode rule with meaningful shaping options and early conflicts | accepted |

#### 13.0.1 Accepted-finding detail and traceability rule

The register is an index, not a substitute for the design. Every accepted finding must preserve its
go-forward behavior in this file: exact accepted resolution, concrete before/after or edge-case
fixture, affected normative contracts, named validation, and recorded date. A concise register row
may summarize that material only when the finding record and references below retain it. Rejected
alternatives and extended exploration are optional historical context, not completeness
requirements. No accepted behavior, example, or validation may remain only in conversational
history. EWP-P0A-T10 and EWP-P0A-TS07 enforce this rule.

**Backfill audit baseline (2026-07-11):** EWP-CF-001 through EWP-CF-043 each retain an accepted
go-forward resolution, saved example, affected normative contracts, named validation, and recorded
date. The current mechanical audit reported `audited=43 failures=0`. Historical evidence,
precedent analysis, and rejected alternatives may remain in older records but are not required for
later findings; a traceability-table summary alone is not sufficient.

| Finding | Normative design retained in | Saved example or edge-case fixture | Validation ownership |
|---|---|---|---|
| EWP-CF-001 | Section 10 Phase 2 -> 3A/3B -> 4 entry/exit order | Phase 3B existing-mutator prerequisite and Phase 4 cross-machine exit fixture | EWP-P3B-TS03, EWP-P4B-TS06 |
| EWP-CF-002 | Section 9 operation/check/diagnostic/result model | Planner no-op/blocked diagnostics versus executable operations | EWP-P3B-TS01..02, EWP-CMD-PLAN-TS01..02 |
| EWP-CF-003 | Sections 2.1, 8.13, 8.14, and 8.20 artifact selector | Singular manifest/paired-lock and saved-plan invocation cases | EWP-WF07, EWP-CMD-PLAN-TS03..12, EWP-CMD-APPLY-TS04..14 |
| EWP-CF-004 | Section 8.1.1 exit taxonomy | CI drift versus usage/state/capability/error precedence | EWP-WF08, EWP-P1-TS06 |
| EWP-CF-005 | Section 9 declaration-group/placement transaction boundaries | Opposing Claude/Codex partial-failure fixture | EWP-WF13, EWP-P4A-TS02 |
| EWP-CF-006 | Sections 8.17 and 9 recovery behavior | Pending abort, committed reversal, and same-operation resume | EWP-WF11, EWP-CMD-UNDO-TS01..09 |
| EWP-CF-007 | P2-06 capability matrix and Sections 8.9/8.20 | Claude/Codex deep verification and Kilo/OpenCode read-only fixtures | EWP-WF01, EWP-CMD-VERIFY-TS02 |
| EWP-CF-008 | Section 2.1 reference/pin rules | Moving ref, full-SHA pin, and resume-tracking update cases | EWP-WF09, EWP-CMD-INSTALL-TS05, EWP-CMD-UPDATE-TS01..10 |
| EWP-CF-009 | Section 2.3 saved-plan preconditions | Unrelated change remains valid; selected-set membership change goes stale | EWP-WF07, EWP-P4B-TS03 |
| EWP-CF-010 | Section 8.20 normative parser registry | Per-command option/default/conflict/help comparison | EWP-OPT-TS01..05, Section 15 |
| EWP-CF-011 | Sections 8.12 and 8.20 export contract | Existing-file selected conflict, force, preservation, and idempotent rerun | EWP-WF04, EWP-CMD-EXPORT-TS05..07 |
| EWP-CF-012 | Section 2.5 artifact write policy | Comment/order/mode preservation, no-op identity, contention, and crash windows | EWP-WF03..04, EWP-P2-TS04 |
| EWP-CF-013 | Section 3.2.1 help information architecture | Root help and workflow topic organized into five groups with dev-verify-promote together | EWP-WF16, EWP-CMD-HELP-TS01..06 |
| EWP-CF-014 | P2-04, P3-06, and completion registry row | Emit-only sourceable output and deferred install/uninstall ownership | EWP-WF01, EWP-CMD-COMPLETION-TS01..06 |
| EWP-CF-015 | Sections 2.3, 8.13, and 8.20 plan contract | Existing destination refusal, explicit force replacement, retained plan | EWP-WF07, EWP-CMD-PLAN-TS06..12 |
| EWP-CF-016 | P2-03 and Sections 8.18/8.20 | Full retired-project before/after scenario in EWP-WF12 | EWP-WF12, EWP-CMD-GC-TS01..08 |
| EWP-CF-017 | Authority hierarchy and Section 13.5 drift ledger | Documentation-driven workflow against every active command page | EWP-WF16, EWP-P0A-TS05 |
| EWP-CF-018 | Status header and Phase 0 structural gate | Stale count/marker/phase-reference failure fixtures | EWP-P0A-T09, EWP-P0A-TS06 |
| EWP-CF-019 | Section 2.1 portable identity rules | Compatible cross-tool merge versus incompatible same-name conflict | EWP-WF04, EWP-P2-TS01, EWP-CMD-EXPORT-TS05 |
| EWP-CF-020 | Section 2.1 imperative translation table | Copy/path persistence versus nonpersistent gate/output controls | EWP-WF14, EWP-CMD-INSTALL-TS03, EWP-CMD-INSTALL-TS05, EWP-CMD-INSTALL-TS07 |
| EWP-CF-021 | Section 2.1 destination precedence and before/after examples | Five-case ownership-first matrix in EWP-WF14 | EWP-P2-TS02, EWP-P4A-TS01, EWP-CMD-INSTALL-TS06, EWP-CMD-UNINSTALL-TS04, EWP-CMD-INIT-TS01..02 |
| EWP-CF-022 | Section 2.1 shared project context and Sections 8.1/8.20 | Nested cwd, `-C`, worktree, symlink, non-Git, nested-manifest, and explicit-artifact matrix in EWP-WF14 | EWP-P1-TS01..02, EWP-P2-TS02, EWP-CMD-LIST-TS03, EWP-CMD-STATUS-TS05, EWP-CMD-CONFIG-TS03, EWP-CMD-INSTALL-TS03 |
| EWP-CF-023 | Section 13.1 current-to-1.0 migration ledger and Section 8.20 target registry | Check exit inversion, functional approval, global no-prompt consolidation, portable pin, and rollback compatibility examples | EWP-P0A-T11, EWP-P0A-TS08, EWP-OPT-TS01..05, and every affected EWP-CMD range |
| EWP-CF-024 | Sections 8.8, 8.17, 8.20, and 13.2 shared target-selection contract | Same-name user/project, exact-path, absent-create, and scoped/unscoped bulk examples in EWP-WF05, EWP-WF11, and EWP-WF14 | EWP-P1-TS03, EWP-P3B-TS03, EWP-P5-TS03, EWP-CMD-DEV-TS02, EWP-CMD-DEV-TS04, EWP-CMD-PROMOTE-TS01, EWP-CMD-PROMOTE-TS04, EWP-CMD-UNDO-TS01, EWP-CMD-UNDO-TS02, EWP-CMD-UNDO-TS06 |
| EWP-CF-025 | Section 8.20 conflict-override family, per-command force contracts, Section 9 result schema, and Section 13.2 | Sync forced replacement, force/yes separation, ambiguity refusal, saved-plan safety, and force/delete separation in EWP-WF04, EWP-WF10, EWP-WF14, and EWP-WF15 | EWP-OPT-TS04 and affected install, uninstall, init, export, plan, and sync EWP-CMD ranges |
| EWP-CF-026 | Section 8.20 batch family, Section 9 group/pair scheduler, and Section 13.2 | Uninstall fail-fast/continue, multi-tool group failure, bulk promote/undo continuation, and saved-plan restriction in EWP-WF05, EWP-WF09, EWP-WF10, EWP-WF11, EWP-WF13, and EWP-WF15 | EWP-OPT-TS04, EWP-P3B-TS03, EWP-P5-TS05, and affected install/uninstall/dev/promote/apply/sync/update/undo EWP-CMD ranges |
| EWP-CF-027 | Sections 2.2, 2.3, 2.5, and 9 versioned hash/canonicalization contract | Comment-only manifest edit remains valid; ref change stales; external byte edit is replanned/refused; selection membership change stales; cross-platform source trees match | EWP-P2-TS01, EWP-P2-TS03..04, EWP-P4B-TS03, EWP-WF03, EWP-WF07, EWP-WF09, EWP-CMD-DOCTOR-TS03, EWP-CMD-PLAN-TS04, EWP-CMD-PLAN-TS09, EWP-CMD-APPLY-TS07, EWP-CMD-UPDATE-TS10 |
| EWP-CF-028 | Sections 2.4, 2.5, and 9 ledger evolution contract | Version-1 status is read-only; dry-run shows migration; first mutation migrates; zero-byte/newer ledgers refuse; legacy journal survives | EWP-P3B-TS04, EWP-WF11..12, EWP-CMD-STATUS-TS04, EWP-CMD-DOCTOR-TS03/05/06, EWP-CMD-PLAN-TS01/10, EWP-CMD-APPLY-TS07/10, EWP-CMD-UNDO-TS01/09, EWP-CMD-GC-TS02 |
| EWP-CF-029 | Sections 2.1, 2.5, 8, and 9 project-file migration contract | Legacy comments/defaults migrate; read-only is unchanged; mixed/nonportable refuses; no lock on migration-only; saved operation stales | EWP-P2-TS06, EWP-WF03, EWP-WF14, EWP-WF16, and affected config/doctor/init/install/uninstall/export/plan/apply/sync EWP-CMD ranges |
| EWP-CF-030 | Sections 2.1..2.5, 8, and 9 portability/redaction boundary | Credential URL and file URL refuse; portable artifacts have no local path; machine-bound plan names reasons; canaries never leak | EWP-P2-TS07, EWP-P4B-TS07, EWP-WF03, EWP-WF04, EWP-WF07, EWP-WF15, and affected install/export/plan/apply EWP-CMD ranges |
| EWP-CF-031 | Sections 8, 9, 13.2, and 13.4 zero-target/selection-source contract | Targetless update/undo refuse; update-check and bounded status/plan/apply/sync/GC remain safe; empty matches never widen | EWP-OPT-TS06, EWP-WF05, EWP-WF09..12, EWP-WF14..15, and affected status/dev/promote/plan/apply/sync/update/undo/GC EWP-CMD ranges |
| EWP-CF-032 | Sections 3.2.1, 8.19, 8.20, and 13.4 help/complexity contract | Five-group root help; development loop; install progressive help; 23 minimal invocations and exclusive questions | EWP-P6-TS05, EWP-OPT-TS07, EWP-WF01, EWP-WF05, EWP-WF15..16, EWP-CMD-HELP-TS01/02/05/06, EWP-CMD-COMPLETION-TS01/03/05 |
| EWP-CF-033 | Section 9.1 application-service boundary and Phase 1 | Install/dev command-local runtime becomes CommandSpec -> shared runtime -> application service -> outcome; fixture command needs no new orchestration | EWP-P1-TS07, EWP-WF15..16, ADR 0004, lint zones, and spawned current-command parity matrix |
| EWP-CF-034 | Section 9.1 scoped-effect ports and Phase 1 | Read-only scan cannot write/lock/exec; same commands run through compatibility aggregate and focused ports; deterministic transaction IDs/time | EWP-P1-TS08, EWP-WF11, EWP-WF15..16, ADR 0005, signature/import gates, and compile-time negative fixtures |
| EWP-CF-035 | Section 9.2 immutable state/repository boundary and Phase 3B | Deep-frozen snapshot -> byte-identical plan -> expected-revision staged commits; partial pairs advance truthful revisions | EWP-P3B-TS05, EWP-WF06, EWP-WF11, EWP-WF13, ADR 0006, failure injection, cycle, and module-size gates |
| EWP-CF-036 | Section 9.1 adapter/capability registry plus Phase 1/3B | Register fixture tools without generic edits; Claude/Codex deep/full lifecycle; Kilo/OpenCode read-only; relevant capability stales plan only | EWP-P1-TS09, EWP-P3B-TS06, EWP-WF01, EWP-WF05, EWP-WF07, ADR 0007, and static tool-branch gates |
| EWP-CF-037 | Section 9.1 wire-contract ownership plus Phase 1/2 | Ledger type/schema drift and install error stripping become codec-inferred DTOs and explicit mappers; old/future artifacts migrate/refuse visibly | EWP-P1-TS10, EWP-P2-TS08, ADR 0008, golden/round-trip/fuzz/contract-inventory gates |
| EWP-CF-038 | Section 9.1 operation-scoped observability plus Phase 1/3B | One apply ID correlates plan, verification, pair, transaction, journal, rollback, and recovery while debug stays on stderr | EWP-P1-TS11, EWP-P3B-TS07, ADR 0009, correlation/redaction/output/fault-isolation gates |
| EWP-CF-039 | Phase 0A verification catalog plus Phase 6 release promotion | A prose-only test or skipped live suite fails ownership; exact-SHA release waits for four-target/package/live-tool evidence | EWP-P0A-TS09, EWP-P6-TS06, ADR 0010, catalog/recipe/publication gates |
| EWP-CF-040 | Sections 2.1, 8, 13.1..13.3 artifact-selector contract | `team.toml` defaults to `team.lock`; explicit `locks/team.lock` requires file and repetition across export/plan/apply/doctor | EWP-OPT-TS08, EWP-P2-TS02, EWP-WF04, and affected command selector tests |
| EWP-CF-041 | Design principles, Phase 2, and Phase 4A init contract | Force dry-run renders one replace-manifest operation; execution matches and leaves lock/live/ledger unchanged | EWP-P2-TS05, EWP-P4A-TS04, EWP-WF03, EWP-CMD-INIT-TS01..05 |
| EWP-CF-042 | Sections 2.3, 8.14, 8.20, and saved-plan apply boundary | Saved dry-run returns 0, saved check returns 7 for valid work, stale returns 3, and no mode replans | EWP-OPT-TS09, EWP-WF07..08, EWP-WF15, EWP-CMD-APPLY-TS06/07/12 |
| EWP-CF-043 | Section 8.20 non-mutating mode families and Section 13.2 | Install dry-run rejects yes; sync force+delete dry-run stays meaningful; plan check cannot write out | EWP-OPT-TS10, EWP-WF08..10, EWP-WF15, and affected command mode tests |

#### EWP-CF-001 — Correct phase dependencies before extending command-specific orchestration

- **Evidence:** The earlier Phase 2 joined manifest/lock state before defining either schema; Phase
  3 added default-saving multi-artifact mutation before the shared operation/coordinator in Phase 4;
  its cross-machine locked reproduction test also required the not-yet-implemented apply command.
  Schema migration appeared in both Phases 1 and 3.
- **Current precedent assessed:** Install/uninstall and promote/dev currently have separate planning,
  batching, locking, and transaction paths. Extending those paths with manifest/lock commits before
  introducing the shared coordinator would follow precedent that this plan intentionally needs to
  replace.
- **Accepted resolution:** Phase 2 now owns canonical manifest/lock artifacts and the sole migration;
  Phase 3A owns inspection; Phase 3B adapts current mutators to shared operation and transaction
  primitives; Phase 4A adds desired-state writes; Phase 4B adds plan/apply and owns cross-machine
  reproduction. Each revised phase has explicit entry and exit conditions.
- **Saved before/after scenario:** Before, default-save could be added to the existing install engine
  in Phase 3, only for Phase 4 to replace its operations, locks, journals, and crash behavior; the
  Machine-A-to-B test would also call an apply command that did not exist. After, Phase 2 proves
  artifact round trips without live mutation; Phase 3B proves that `install --no-save --dry-run`
  and execution use the same shared operations while preserving current behavior; Phase 4A adds
  manifest/lock commits to that coordinator; and Phase 4B validates `export` on Machine A followed
  by locked `plan`/`apply` on Machine B. Each failure is attributable to artifacts, inspection,
  coordination, desired-state integration, or declarative execution rather than all five at once.
- **Rejected alternatives:** Adding artifact commits to the command-specific engines first would
  implement multi-artifact recovery twice. Building plan/apply before adapting current mutators
  would leave imperative and declarative paths with competing operation models. Combining schema,
  migration, inspection, mutation, and apply in one phase would make the entry/exit gates cosmetic.
- **Affected sections and validation:** Section 10 Phase 2 -> 3A/3B -> 4 sequencing;
  EWP-P2-TS01..05, EWP-P3B-TS01..03, EWP-P4A-TS01..03, EWP-P4B-TS01..06, EWP-WF03, and
  EWP-WF13.
- **Recorded:** 2026-07-10

#### EWP-CF-002 — Separate executable work from dispositions and outcomes

- **Evidence:** The earlier operation union included `skip` and `refuse` beside mutations and
  verification. Current `InstallAction` and `FlipAction` unions likewise combine performed actions,
  no-ops, refusals, failures, and rollback outcomes.
- **Current precedent assessed:** The existing action unions are convenient renderer/report DTOs but
  are not a sound saved-plan execution model; extending them would make non-executable dispositions
  look executable.
- **Accepted resolution:** `Plan` now has separate executable operations, non-mutating checks, and
  diagnostics. Execution returns results keyed by operation ID. Saved plans preserve all layers for
  review while the executor runs only operations and required checks. Current action unions may
  survive temporarily only at compatibility rendering boundaries.
- **Saved before/after scenario:** A plan may contain an executable `PlaceSkill(review, codex)`, a
  required verification check, an informational no-op because Claude is already current, and a
  diagnostic refusing a Kilo mutation. Before, representing all four as peer action variants lets
  an executor accidentally dispatch `skip` or `refuse`, and execution output cannot correlate a
  failed placement with the reviewed operation. After, `operations[]` contains only placement work,
  `checks[]` contains the verification precondition, `diagnostics[]` contains the no-op/refusal, and
  `results[operationId]` records the attempted placement outcome. Human and JSON render all layers;
  the executor consumes only operations and required checks.
- **Rejected alternatives:** Keeping one union with an `executable` boolean leaves invalid states
  representable. Treating renderer DTOs as the saved-plan schema couples execution to presentation.
  Dropping no-op/refusal diagnostics would make a technically executable plan impossible to audit.
- **Affected sections and validation:** Section 9 Plan/Check/Diagnostic/ExecutionResult model;
  EWP-P3B-T01, EWP-P3B-T03, EWP-P3B-TS01..02, EWP-P4B-TS01..03, and
  EWP-CMD-PLAN-TS01..02.
- **Recorded:** 2026-07-10

#### EWP-CF-003 — One manifest and one paired lock per invocation

- **Evidence:** The plan conditionally retained repeatable `--file` after all named decisions were
  closed, without defining default precedence, duplicate declarations, writeback ownership, lock
  association, saved-plan identity, or prune authority. Older research also offered both a
  positional manifest and repeatable file flags.
- **Precedent assessed:** Kubectl-style composition is useful for independent resource objects, but
  Skillsmith manifests combine defaults, desired state, generated resolution, and imperative
  writeback ownership, so that precedent does not transfer cleanly.
- **Accepted resolution:** 1.0 accepts exactly one discovered or singular `--file` manifest and no
  positional path. `skillsmith.toml` pairs with `skillsmith.lock`; custom `<name>.toml` pairs with
  `<name>.lock`; explicit lock override is available only where contracted. Prune and saved-plan
  authority are scoped to that exact pair. Multi-manifest composition is deferred.
- **Saved before/after scenario:** Before,
  `skillsmith plan --file team.toml --file personal.toml --prune` leaves unanswered which defaults
  win, whether duplicate names merge, which of two locks authorizes a revision, which file receives
  writeback, and whether prune can remove entries owned by the other file. After,
  `skillsmith plan --file team.toml --prune` selects only `team.toml` plus `team.lock`; its hashes and
  selection set are saved in the plan, and prune authority cannot escape that pair. Managing the
  personal pair is a separate explicit invocation, making review and recovery deterministic.
- **Rejected alternatives:** Repeatable files require a full composition/ownership language.
  A positional manifest plus `--file` creates two spellings and precedence questions. Implicitly
  merging every discovered user/project manifest violates singular writeback and prune authority.
- **Affected sections and validation:** Sections 2.1, 2.3, 8.13, 8.14, and 8.20 artifact selector;
  EWP-WF07, EWP-CMD-PLAN-TS03..12, and EWP-CMD-APPLY-TS04..14.
- **Recorded:** 2026-07-10

#### EWP-CF-004 — Complete exit taxonomy and semantic precedence

- **Evidence:** The plan named drift exit 7 only in one workflow, while status, update, saved-plan,
  locked-state, and batch behavior remained unspecified. Current batches select the highest numeric
  code, which would let drift 7 mask actual errors 1-6.
- **Precedent assessed:** Current codes 1-6 are useful stable categories, but numeric maximum is an
  implementation shortcut rather than a correct semantic precedence once a non-error check result
  uses code 7.
- **Accepted resolution:** One global table defines 0-7 and 130. Check-mode drift uses 7 only after
  successful evaluation; stale saved/locked state uses 3; dry-run changes remain 0; actual errors
  beat drift; cancellation beats all. A centralized selector and cross-command matrix own the
  contract.
- **Saved before/after scenario:** `skillsmith update --all --check` evaluates two declarations:
  one has an available update (drift 7) and the other fails to resolve because the network request
  fails (error 1). Before, numeric-maximum aggregation returns 7 and CI incorrectly reports a cleanly
  evaluated change instead of an error. After, semantic precedence returns 1 and preserves both
  item results in JSON. A stale locked plan returns 3, a successful dry-run that previews changes
  returns 0, and Ctrl-C returns 130 regardless of earlier item results.
- **Rejected alternatives:** Highest-number-wins is not semantic precedence. Giving drift code 1
  loses the useful distinction between detected change and failed evaluation. Letting every command
  choose its own codes makes automation depend on the verb rather than the outcome.
- **Affected sections and validation:** Section 8.1.1 global taxonomy and batch precedence;
  EWP-P1-T08, EWP-P1-TS06, EWP-WF08, EWP-WF15, and check-mode tests for status, plan, and
  update.
- **Recorded:** 2026-07-10

#### EWP-CF-005 — Define declaration-group and placement transaction boundaries

- **Evidence:** D-006 described manifest, lock, live state, and ledger as one journaled change while
  multi-tool workflows explicitly retained successful pairs. Declarations and lock entries are
  source-level, but journals and capability failures are per tool.
- **Precedent assessed:** Current acquisition batches retain earlier successful pairs under one
  invocation. Preserving that behavior is valuable, but deriving portable intent from only locally
  successful tools would make manifests environment-dependent.
- **Accepted resolution:** Syntax preflight precedes all writes. Pre-resolution failures write
  nothing. Resolved install/update groups persist complete portable intent, with per-tool live drift
  on failure. Uninstall retains declaration/lock intent until all selected placements are removed.
  Tool placements remain independent and rerunnable; later source groups follow
  `--continue-on-error`; no false whole-invocation or `--atomic` promise is added.
- **Saved before/after scenario:** A declaration requests `review` for Claude and Codex. Resolution
  succeeds, Claude placement commits, and Codex placement fails. Before, whole-invocation atomicity
  would require rolling Claude back, while saving only successful tools would mutate portable intent
  according to one machine's failure. After, the manifest and lock retain the complete requested
  Claude+Codex declaration, the ledger/live state records Claude success, status reports Codex drift,
  and rerunning converges only the failed pair. During uninstall, the declaration and lock remain
  until both selected placements are removed. A syntax or source-resolution failure still writes
  nothing at all.
- **Rejected alternatives:** Whole-invocation rollback discards truthful independent success and is
  not promised by current batch behavior. Persisting only successful tools makes portable intent
  environment-dependent. Committing declaration removal before all selected uninstalls succeed
  turns the remaining live placement into accidental unmanaged state.
- **Affected sections and validation:** Section 9 transaction hierarchy and Phase 4A commit rules;
  EWP-P4A-T03, EWP-P4A-TS02, EWP-WF13, EWP-CMD-INSTALL-TS08,
  EWP-CMD-UNINSTALL-TS04, and EWP-CMD-UNINSTALL-TS07.
- **Recorded:** 2026-07-10

#### EWP-CF-006 — Preserve both abort and resume after interruption

- **Evidence:** D-010 limited undo to committed work while promising reversibility for interrupted
  journals. Current journals retain before-state and rollback machinery, so a resume-only design
  would remove the user's ability to abandon an incomplete mutation.
- **Precedent assessed:** Verb-specific rollback is fragmented and should not remain canonical, but
  restoring a pending before-state is a valuable safety capability rather than bad precedent.
- **Accepted resolution:** `undo` explicitly labels and aborts selected pending work, which takes
  precedence over committed history; otherwise it reverses committed work. Same-command rerun still
  resumes. Status presents both choices. Deprecated verb rollback aliases route to undo; no new
  recover or abort verb is added.
- **Saved before/after scenario:** An install crashes after preserving the previous placement but
  before committing the replacement. Before, a resume-only design forces the user to finish a
  change they may no longer want, while committed-only undo cannot select the pending journal.
  After, `skillsmith status review` labels the pending operation and offers two exact paths:
  rerunning the same install resumes from its journal, while `skillsmith undo review` restores the
  recorded before-state and closes the pending operation. Once a change commits, the same undo
  syntax reverses committed history; pending abort always takes precedence and is clearly labeled.
- **Rejected alternatives:** Resume-only recovery removes safe abandonment. Automatic rollback on
  every crash can destroy useful completed pair work. Separate `recover`, `abort`, and `rollback`
  commands expose transaction internals and fragment one user intent across several verbs.
- **Affected sections and validation:** Sections 8.17 and 9 recovery hierarchy; EWP-WF11,
  EWP-P3B-T04, EWP-P3B-TS03, and EWP-CMD-UNDO-TS01..09.
- **Recorded:** 2026-07-10

#### EWP-CF-007 — Make support an operation capability, not one boolean

- **Evidence:** Detection/inventory currently recognize Claude Code, Codex, Kilo Code, and OpenCode,
  while mutation and verification types cover Claude Code and Codex. The plan and active older
  research disagreed about whether all four were write-capable 1.0 blockers.
- **Precedent assessed:** Keeping broad detection is useful; pretending it implies mutation support
  is not. Shared enum validation must distinguish known-but-unsupported capability from unknown
  input.
- **Accepted resolution:** 1.0 detects and inventories all four tools; Claude Code and Codex receive
  the full lifecycle; Kilo Code and OpenCode mutation requests produce exit-4 capability
  diagnostics and their full adapters move to P3. User/project are writable for full adapters;
  system/managed are read-only. The user's correction is incorporated: both Claude Code and Codex
  support standalone deep verification. Claude deep is an isolated plugin/skill load-presence check;
  lifecycle gate policy may still choose Claude static when it already covers the required skill
  validation. The focused Claude deep suite passed 11/11 during this review.
- **Saved before/after scenario:** On a machine with only Kilo Code installed,
  `skillsmith agents --capabilities` reports Kilo as detected/readable and mutation as unavailable;
  `skillsmith list --tool kilo-code` works, while `skillsmith install ... --tool kilo-code` refuses
  with exit 4 and a P3 capability explanation. On Claude and Codex, install/apply are available and
  `skillsmith verify <path> --deep` performs static plus each tool's isolated deep load check.
  Before, one `supported=true` label could make Kilo detection appear to promise installation or
  incorrectly claim Claude lacked already-implemented deep verification.
- **Rejected alternatives:** Hiding read-only tools wastes useful inventory support. Treating
  detection as write support advertises operations that cannot run. Making Kilo/OpenCode adapters
  block 1.0 delays the complete Claude/Codex lifecycle; claiming Claude deep is impossible would
  contradict the verified implementation and its 11/11 focused suite.
- **Affected sections and validation:** P2-06 capability matrix, Sections 8.9 and 8.20;
  EWP-WF01, EWP-CMD-AGENTS-TS03, EWP-CMD-VERIFY-TS02, and capability refusal matrices.
- **Recorded:** 2026-07-10

#### EWP-CF-008 — Give pinning one portable observable effect

- **Evidence:** Current `--pin` sets a local ledger policy even though every installation records a
  SHA. Under D-004 every lock entry is also exact, so the proposed option had no defined difference
  in portable artifacts.
- **Precedent assessed:** Retaining a policy bit only in machine-local state would make identical
  manifest/lock pairs update differently across machines. The useful intent behind current pinning
  is freezing the resolved revision, not preserving that storage shape.
- **Accepted resolution:** Unpinned saves preserve the requested moving ref while lock resolution is
  exact. `--pin` writes the full resolved SHA as manifest intent. Exact SHA/fixed tags do not produce
  bulk update candidates. `update --ref <moving-ref>` resumes tracking, and adding `--pin` resolves
  then freezes it. No separate unpin option is added; no-save retains the local marker.
- **Saved before/after scenario:** An unpinned
  `skillsmith install owner/repo//review --ref main` saves `ref = "main"` in the manifest and the
  resolved full SHA in the lock, so `update --check` can report later movement. Running the install
  with `--pin` instead saves that full SHA as manifest intent as well as lock resolution, so bulk
  update skips it. `skillsmith update review --ref main` explicitly resumes branch tracking;
  appending `--pin` resolves main once and freezes the new SHA. Under `--no-save`, only the local
  ledger can retain pin policy because no portable declaration is being written.
- **Rejected alternatives:** A ledger-only pin makes identical portable artifacts behave
  differently across machines. A lock-only pin is redundant because every lock entry is exact.
  Persisting a separate pin boolean duplicates ref state, and a separate unpin command is unnecessary
  when explicit `update --ref` already states the desired transition.
- **Affected sections and validation:** Section 2.1 reference rules, Sections 8.6/8.16;
  EWP-WF09, EWP-CMD-INSTALL-TS05, and EWP-CMD-UPDATE-TS01..10.
- **Recorded:** 2026-07-10

#### EWP-CF-009 — Scope saved-plan invalidation to actual dependencies

- **Evidence:** The sample saved plan carried one `stateHash`, while exact execution must ignore
  unrelated fleet changes yet detect newly introduced entries inside prune/delete/bulk selection.
  An undifferentiated hash cannot satisfy both properties.
- **Precedent assessed:** Exact global-state locking is unnecessarily brittle for independent local
  placements. Purely per-target checks are insufficient for set-derived destructive operations.
- **Accepted resolution:** Saved plans retain exact manifest/lock hashes, per-operation resource
  fingerprints, complete selection-set fingerprints where set membership matters, and only relevant
  capability checks. Producing version is audit data; schema/executor compatibility gates execution.
  Stale errors name dependencies, unrelated state remains valid, and prune/delete/all detect new
  in-scope entries.
- **Saved before/after scenario:** A saved plan updates `review` and prunes undeclared Codex project
  skills. Editing an unrelated user-scoped Claude skill after review should not invalidate the plan;
  changing `review`'s live target must invalidate its resource fingerprint; adding a new in-scope
  Codex project skill must invalidate the prune selection set. Before, one global hash rejects all
  three changes, including the unrelated one; per-target hashes alone accept the dangerous new prune
  member. After, apply names the exact stale dependency and otherwise executes only the reviewed
  operation set.
- **Rejected alternatives:** A global fleet hash is safe but needlessly brittle. Per-operation
  fingerprints alone miss changes to destructive set membership. Skipping revalidation turns a
  saved plan into permission to compute new operations rather than authorization for reviewed work.
- **Affected sections and validation:** Section 2.3 scoped preconditions and Section 9 dependency
  metadata; EWP-WF07, EWP-P4B-T03, EWP-P4B-TS03, EWP-CMD-PLAN-TS07, and
  EWP-CMD-APPLY-TS08..10.
- **Recorded:** 2026-07-10

#### EWP-CF-010 — Make every command and option a testable parser contract

- **Evidence:** Earlier command sections used informal option names and omitted exact shapes,
  defaults, conflicts, current/new/deprecated disposition, mutation behavior, and some live flags.
  The plan therefore could not satisfy its own every-option completion criterion.
- **Precedent assessed:** Current Commander declarations are the live source but repeat validation,
  exit overrides, and option construction per command. Copying that layout would perpetuate drift;
  shared builders plus introspection are the useful precedent to establish.
- **Accepted resolution:** Section 8.20 is normative: shared option families, every command usage,
  alias, argument, exact local option membership/disposition, defaults/conflicts, mutation and exit
  contracts, and test ownership. EWP-OPT-TS01..05 compare it to the live command tree and generated
  help. Canonical color and artifact selector behavior are explicit; unsupported JSON/yes options
  are rejected rather than ignored.
- **Saved before/after scenario:** Before, a summary can say a command “supports JSON and approval”
  while Commander accepts `--json` without a versioned schema or accepts `--yes` even though no
  confirmation exists; short flags, negated defaults, and aliases can also collide unnoticed. After,
  the command's Section 8.20 row is the exact contract: if `--json` or `--yes` is absent, parsing
  rejects it; if present, its default, conflicts, mutation effect, output, and tests are named.
  Introspection compares the registry, generated help, and live command tree so an implementation
  addition cannot silently bypass the design.
- **Rejected alternatives:** Prose-only option lists cannot prove parser behavior. Treating current
  code as the only specification preserves accidental no-ops and inconsistent defaults. Hand-copying
  validation into every command recreates the drift that shared option builders are intended to stop.
- **Affected sections and validation:** Section 8.20 and Section 15; EWP-OPT-TS01..05,
  EWP-P0A-T07, EWP-P0A-TS02..04, and every EWP-CMD range.
- **Recorded:** 2026-07-10

#### EWP-CF-011 — Make export merge idempotently without taking whole-file ownership

- **Evidence:** D-005 required an existing-file policy but did not define matching intent,
  conflicting live state, unselected declarations, comments, requested refs, or deletion authority.
- **Precedent assessed:** Generic force-overwrite behavior is inappropriate for a reverse-state
  capture command that shares a human-authored desired-state file. Idempotent upsert is useful when
  ownership remains selected and explicit.
- **Accepted resolution:** Export creates or merges. Matching entries preserve requested intent and
  refresh exact lock data; unselected/default/comment/order content remains. Conflicts block all
  writes unless force makes selected portable live entries authoritative. Force never deletes,
  replaces the whole file, or bypasses portability. Unchanged reruns are byte-identical.
- **Saved before/after scenario:** An existing manifest contains comments, defaults, an unselected
  `lint` declaration, and `review` tracking `main`; live state observes `review` at a new exact SHA
  and in an additional tool. Before, whole-file export can erase comments/defaults/lint or replace
  requested `main` with an observed SHA. After, export preserves the human `main` intent and all
  unselected content, merges the compatible tool observation, and refreshes only `review`'s exact
  lock resolution. If live `review` instead has an incompatible source/scope, export performs zero
  writes; `--force` updates only that selected portable conflict. A second unchanged export is
  byte-identical.
- **Rejected alternatives:** Always overwriting gives reverse capture ownership of a human file.
  Always refusing an existing file prevents incremental fleet backup. Letting force replace or
  prune the entire file exceeds the selected live-state authority and risks unrelated declarations.
- **Affected sections and validation:** Sections 8.12 and 8.20 export contract; EWP-WF04 and
  EWP-CMD-EXPORT-TS05..07/TS09.
- **Recorded:** 2026-07-10

#### EWP-CF-012 — Do not reuse destructive config serialization for human artifacts

- **Evidence:** Current config save parses to plain objects, fully serializes TOML, and creates an
  empty destination before locking. Accepted manifest/export/default-save behavior requires
  comments/order/permission preservation, byte-identical no-ops, and no residue on refusal.
- **Precedent assessed:** Atomic temp-and-rename is good; target pre-creation and object
  reserialization are not suitable precedent for a human-authored desired-state file.
- **Accepted resolution:** Human TOML uses lossless targeted editing selected through a bounded
  Phase-2 spike and refuses unsafe edits. Generated lock/plan/ledger files remain canonical. One
  absent-file-capable artifact-group lock, mode-preserving staged writes, semantic hashing, and
  journaled two-file recovery replace target pre-creation. Tests cover formatting, permissions,
  no-op identity, contention, crashes, cancellation, and zero residue.
- **Saved before/after scenario:** A mode-0600 `skillsmith.toml` contains explanatory comments,
  deliberate ordering, and unusual valid whitespace. Default-saving install adds one declaration.
  Before, parse-to-object/full-serialize removes comments and formatting; pre-creating a lock target
  can leave an empty file when validation, locking, or cancellation fails. After, a targeted edit
  preserves unrelated bytes and mode, both manifest and canonical lock are staged under one
  absent-file-capable group lock, semantic no-ops write nothing, and a crash journal either completes
  or restores the pair. Unsafe human-file edits refuse with both originals unchanged and no residue.
- **Rejected alternatives:** Reusing the config serializer violates accepted human-file ownership.
  Making the manifest generated-only prevents normal review and comments. Best-effort sequential
  writes cannot provide a truthful manifest/lock commit boundary or deterministic crash recovery.
- **Affected sections and validation:** Section 2.5 artifact write policy; EWP-P2-T04,
  EWP-P2-TS04, EWP-WF03, EWP-WF04, and manifest-writing command crash/no-op suites.
- **Recorded:** 2026-07-10

#### EWP-CF-013 — Keep verbs flat but make workflow groups the information architecture

- **Evidence:** The accepted surface has 23 canonical top-level names, exceeding the older design's
  approximate 12-verb hierarchy review threshold.
- **Precedent assessed:** Namespaces would shorten the root list but lengthen core actions and
  introduce artificial nouns even though Skillsmith still manages one primary resource.
- **Accepted resolution:** The threshold break is intentional. Root help, README orientation,
  generated indexes, and `help workflows` use Discover, Manage, Develop, Declarative, and Maintain
  groups; aliases stay beside canonical commands; `commands` is always labeled installed slash
  commands; suggestions/completion cover all groups. Hierarchy is reconsidered only for a genuine
  second primary resource type. CF-032 adds Develop for the dev-verify-promote loop and moves
  doctor/check to Maintain without adding commands or namespaces.
- **Saved before/after scenario:** Before, an alphabetical 23-command root list makes `plan`,
  `apply`, `export`, `doctor`, and `commands` look unrelated, while adding artificial namespaces
  would turn familiar actions into longer forms such as `skillsmith state apply`. After,
  `skillsmith --help`, README orientation, generated command indexes, completion, and
  `skillsmith help workflows` present five groups: Discover, Manage, Develop, Declarative, and
  Maintain.
  Commands remain short top-level verbs, aliases appear beside their canonical command, and
  `commands` is explicitly described as listing installed slash commands rather than CLI verbs.
- **Rejected alternatives:** Immediate namespaces add syntax without a second primary resource.
  An ungrouped flat list is technically complete but difficult to learn. Showing aliases as separate
  commands inflates the surface and obscures canonical names.
- **Affected sections and validation:** Section 3.2.1 help/documentation groups; EWP-WF16,
  EWP-P1-TS05, and EWP-CMD-HELP-TS01..06.
- **Recorded:** 2026-07-10
- **Amended:** 2026-07-11 by EWP-CF-032 (adds Develop and progressive per-command help)

#### EWP-CF-014 — Keep completion emission pure and defer installer ownership

- **Evidence:** P2-04 left an optional installer undecided even though the 1.0 command contract
  emitted scripts. A CLI installer would need to own shell/framework files and reversibility.
- **Precedent assessed:** Emitting completions while package managers/users place them is good Unix
  precedent and keeps stdout sourceable. Silent startup-file mutation would be a materially new
  lifecycle.
- **Accepted resolution:** 1.0 completion is emit-only and never edits shell files; help contains
  manual instructions and distribution packages may install generated files normally. P3-06 is a
  named follow-up covering install/uninstall ownership, coexistence, dry-run, conflicts, and exact
  rollback before any CLI installer syntax is chosen.
- **Saved before/after scenario:** `skillsmith completion zsh` writes only a sourceable completion
  script to stdout, so `eval "$(skillsmith completion zsh)"` is not corrupted by status text and a
  package manager may place the same generated file using its normal ownership rules. Before, an
  optional in-CLI installer could silently edit `.zshrc`, choose the wrong framework directory, or
  be unable to reverse a pre-existing line. After, 1.0 help documents manual/package installation;
  P3-06 separately requires installer/uninstaller ownership records, coexistence, preview,
  conflicts, and exact rollback before any mutating syntax is accepted.
- **Rejected alternatives:** Silent startup-file editing is unsafe and hard to reverse. Mixing
  installation messages with emitted stdout breaks direct sourcing. Omitting the installer
  follow-up would lose a useful workflow without defining its additional lifecycle responsibly.
- **Affected sections and validation:** P2-04, P3-06, and the Section 8.20 completion row;
  EWP-WF01 and EWP-CMD-COMPLETION-TS01..06.
- **Recorded:** 2026-07-10

#### EWP-CF-015 — Protect saved plans as reviewed artifacts

- **Evidence:** `plan --out` had schema and staleness rules but no behavior for an existing
  destination, stdout, permissions, replacement, or post-apply retention.
- **Precedent assessed:** Silent overwrite is inappropriate for an artifact that may cross an
  approval boundary. Create-only output with explicit replacement is simple and familiar.
- **Accepted resolution:** Out creates an owner-only atomic artifact and refuses existing paths;
  force is valid only with out and authorizes atomic replacement. Stdout remains human/JSON
  description, not an executable plan destination. Apply neither mutates nor deletes its plan file;
  tests cover residue and reporting.
- **Saved before/after scenario:** A reviewed `release.skillsmith.plan` already exists when another
  `skillsmith plan --out release.skillsmith.plan` runs. Before, silent overwrite can replace the
  exact operations awaiting approval. After, creation refuses with no file change; only
  `plan --out release.skillsmith.plan --force` atomically replaces it and reports that replacement.
  New files are owner-only, `--out -` is invalid because stdout remains the human/JSON description,
  and `skillsmith apply --plan release.skillsmith.plan` leaves the reviewed artifact byte-identical
  whether execution succeeds or fails.
- **Rejected alternatives:** Silent overwrite breaks the approval boundary. Treating stdout as both
  report and executable artifact creates format/secret/permission ambiguity. Auto-deleting a plan
  after apply destroys audit/retry evidence, and a global force flag would authorize more than the
  selected output replacement.
- **Affected sections and validation:** Sections 2.3, 8.13, and 8.20 plan contract; EWP-WF07,
  EWP-P4B-T03, EWP-P4B-TS03, and EWP-CMD-PLAN-TS06..12.
- **Recorded:** 2026-07-10

#### EWP-CF-016 — Make GC local, ledger-authoritative, and explicit about stale projects

- **Evidence:** GC promised to protect known lockfiles without defining project discovery. Home-tree
  crawling would be slow/incomplete/private, while portable locks describe reacquirable identity and
  are not necessarily local cache leases.
- **Precedent assessed:** The local placements ledger already records actual store consumers. Missing
  paths cannot safely be inferred obsolete because volumes may be temporarily unavailable.
- **Accepted resolution:** GC uses ledger/live/journal/undo/retention reachability and never crawls.
  Missing projects stay protected and are reported. An exact repeatable forget-project option,
  guarded against current/existing/journaled roots and approval, removes only local registration and
  then recalculates eligibility. It never edits project artifacts, and other references/retention
  continue to protect bytes.
- **Saved before/after scenario:** EWP-WF12 retains the full case: a deleted or moved project at
  `/missing/old-project` remains a ledger consumer of store object `sha256:abc`. Ordinary GC reports
  the missing root and protects the object because the path may be on a detached volume.
  `gc --forget-project /missing/old-project --dry-run` previews the exact registration removal and
  recalculated eligibility; confirmed execution forgets only local registration, then deletes
  `sha256:abc` only if live, journal, undo, other-project, and retention references no longer protect
  it. No project manifest or lock is opened or edited.
- **Rejected alternatives:** Crawling home/project trees is incomplete, slow, and privacy-invasive.
  Treating every missing path as abandoned can delete cache needed by a temporarily unavailable
  project. Treating portable lock entries as permanent local leases prevents useful cleanup, while
  an unrestricted force option bypasses reachability rather than resolving stale registration.
- **Affected sections and validation:** P2-03, Sections 8.18/8.20, EWP-WF12, and
  EWP-CMD-GC-TS01..08.
- **Recorded:** 2026-07-11

#### EWP-CF-017 — Reconcile active documentation before building against it

- **Evidence:** Active research and command pages still advertise the old four-tool write boundary,
  old public-1.0 milestone, repeatable-file apply, imperative install, store cleanup, and schema/flag
  assumptions; current help points users toward that research.
- **Precedent assessed:** Existing specs retain valuable shipped-behavior and crash evidence, but
  leaving conflicting roadmaps simultaneously authoritative invites implementation drift.
- **Accepted resolution:** The plan now defines authority from accepted plan intent through current
  code behavior and historical research. Phase 0 produces a section-level drift ledger and assigns
  update, migration-note, superseded-pointer, or archive disposition while preserving valid details.
  Active-doc claim gates and EWP-WF16 must pass before lifecycle implementation begins.
- **Saved before/after scenario:** Before, an implementer reading active research can build
  repeatable-file apply and four-tool mutation while another follows this plan's singular artifact
  pair and Claude/Codex lifecycle boundary; both can claim documentation support. After, the drift
  ledger identifies each conflicting section and records one disposition: update to the accepted
  contract, retain as an explicitly labeled current-behavior migration note, mark superseded with a
  pointer, or archive. Valid crash evidence and shipped-behavior details remain available, while
  README/help and EWP-WF16 lead users and implementers to one authoritative intended behavior.
- **Rejected alternatives:** Deleting all older research loses useful evidence and history. Leaving
  contradictions with a general disclaimer still forces readers to arbitrate. Updating only README
  or help leaves code-adjacent specs capable of reintroducing rejected behavior.
- **Affected sections and validation:** Sources/authority hierarchy and Sections 13.1/13.5;
  EWP-P0A-T08, EWP-P0A-TS05, EWP-P1-T06, EWP-P1-TS05, and EWP-WF16.
- **Recorded:** 2026-07-11

#### EWP-CF-018 — Make plan status and cross-references mechanically truthful

- **Evidence:** Header counts still described unresolved decisions and the pre-review task count;
  artifact headings retained pending-decision labels; resolved conditionals and one removed phase ID
  remained.
- **Precedent assessed:** Hand-maintained plan metadata naturally drifts as decisions amend a large
  document; relying on visual review alone is not sufficient.
- **Accepted resolution:** Status now reflects post-decision review, counts are recalculated,
  accepted artifact headings and resolved prose replace conditionals, and stale phase references are
  repaired. EWP-P0A-T09 and EWP-P0A-TS06 require a structural validator for decisions, IDs,
  duplicates, counts,
  stale markers, placeholders, and phase references after every amendment.
- **Saved before/after scenario:** Adding Finding 21 previously left a plausible risk that the
  header would still say 20 findings or a traceability row could name a removed phase ID. Before,
  visual review can miss those internally credible but false statements in a long document. After,
  the structural gate recomputes unique priority/finding/task/test totals, requires one full record
  for every register entry, rejects duplicate/undefined EWP IDs and stale pending-decision text,
  checks phase references and placeholders, and runs after every Phase-0 amendment. The Finding-21
  amendment independently resolved to 21 findings, 52 phase tasks, and 43 phase tests.
- **Rejected alternatives:** Manual proofreading alone already allowed drift. Removing all coverage
  counts hides rather than fixes completeness. A heading-only linter cannot catch missing records,
  stale references, or disagreement between the register and normative sections.
- **Affected sections and validation:** Status header, Section 13.0 register/traceability, and
  EWP-P0A-T09, EWP-P0A-T10, and EWP-P0A-TS06..07.
- **Recorded:** 2026-07-11

#### EWP-CF-019 — Use one unique manifest name as portable identity

- **Evidence:** Name, source, ref, scope, and tools were present but no uniqueness rule correlated
  declarations, lock entries, export merges, uninstall writes, or saved-plan operations.
- **Precedent assessed:** Source/ref are mutable and cannot be identity; an additional opaque ID
  would burden the common manifest with two names.
- **Accepted resolution:** Name is required and unique per manifest; one declaration owns one
  source/ref/scope and unique nonempty tools; the paired lock has exactly one matching entry and no
  extras. Compatible export observations merge tools; incompatible same-name observations conflict.
  Portable operation IDs include name/tool/kind; local identity remains tool/scope/path; rename is
  explicit remove-old plus install-new.
- **Saved before/after scenario:** Before, two `[[skills]]` entries named `review`—one for Claude and
  one for Codex, or one pointing at a different source—make `uninstall review`, lock correlation,
  export merge, and saved-plan operation IDs ambiguous. After, one manifest declaration named
  `review` owns one source/ref/scope and a unique tool list such as `["claude-code", "codex"]`; its
  paired lock has exactly one matching entry. Export merges compatible tool observations, refuses
  incompatible same-name observations, and an intentional rename is a visible remove-old plus
  install-new plan. The same leaf name may still exist once in separate user and project manifests,
  with EWP-CF-021 handling owner ambiguity.
- **Rejected alternatives:** Source/ref cannot be identity because updates legitimately change
  them. A `(name, tool)` identity duplicates declarations and leaves source/scope correlation open.
  Adding opaque UUIDs burdens ordinary manifests with a second name without resolving user-facing
  selection semantics.
- **Affected sections and validation:** Section 2.1 identity/lock invariants and Section 9 operation
  IDs; EWP-WF04, EWP-P2-TS01, and EWP-CMD-EXPORT-TS05.
- **Recorded:** 2026-07-11

#### EWP-CF-020 — Define imperative-to-declarative option translation

- **Evidence:** Default-saving install could reproduce a different placement because direct/custom
  path were not represented, while persisting one-time force or verification bypasses would weaken
  future applies.
- **Precedent assessed:** Local ledger facts and command controls are not automatically desired
  project policy; only inputs required to reproduce intended placement belong in the manifest.
- **Accepted resolution:** Save source/name/ref-or-pin/tools/scope/placement/path. Symlink is default;
  direct persists copy. Project/home-contained paths serialize portable tokens; escapes/arbitrary
  absolute paths refuse before default-saving mutation and may use explicit no-save. Gate, force,
  batch, approval, output, and verbosity controls never persist; skipped verification remains a
  local fact. Lockfiles remain source-byte-only.
- **Saved before/after scenario:**
  `skillsmith install owner/repo//review --direct --path ./custom/skills --force --no-verify`
  intends a reproducible copy at a project-relative path but uses force and verification bypass only
  for this execution. Before, saving only source/ref makes a later apply create the default symlink
  at the default root; saving every flag makes force/no-verify permanent policy. After, the manifest
  records `placement = "copy"` and normalized `path = "./custom/skills"` with source/name/ref/tools/
  scope, while force and no-verify are absent; the local ledger records that verification was
  skipped. An escaping/arbitrary absolute path refuses before default-saving mutation and can be
  used only with explicit `--no-save` when otherwise valid. The lock contains source resolution and
  content hashes, never placement paths.
- **Rejected alternatives:** Persisting all CLI flags turns one-time safety overrides into future
  policy. Persisting only source/ref cannot reproduce placement intent. Copying ledger facts into
  the manifest leaks machine state, while putting placement paths in the lock confuses source-byte
  resolution with destination policy.
- **Affected sections and validation:** Section 2.1 translation/path rules and Sections 8.6/8.20;
  EWP-WF14, EWP-CMD-INSTALL-TS03, EWP-CMD-INSTALL-TS05, and EWP-CMD-INSTALL-TS07.
- **Recorded:** 2026-07-11

#### EWP-CF-021 — Select saved artifacts by declaration ownership before placement scope

- **Evidence:** D-006 made install/uninstall save by default but a scope-only destination rule could
  make `install --user` inside a repository either dirty the project unexpectedly or ignore a
  project-owned user-scoped declaration. Uninstall also needs an existing declaration to remove,
  so routing it solely by requested live scope can select the wrong artifact. The same portable
  name may intentionally exist once in each manifest, which makes silent selection unsafe.
- **Precedent assessed:** Explicit file selection is the clearest authority and must remain first.
  Existing declaration ownership is more stable than cwd or placement scope for updates/removals.
  Scope remains the least surprising routing rule only when creating a new declaration. Searching
  and merging multiple manifests in one invocation would contradict the accepted singular-artifact
  contract.
- **Accepted resolution:** Destination precedence is: explicit singular `--file`; after name
  resolution, the one discovered project or user manifest already declaring that name; refusal
  with exit 2 and both candidates when more than one owns it; then, for a new declaration, project
  scope selects the effective project-root manifest and user scope selects the XDG user manifest.
  `init --scope user` creates the XDG user manifest and `init --scope project` creates the effective
  project manifest; no-scope init uses the Git root when present, otherwise user. Explicit
  `--file ./skillsmith.toml --user` is valid and means the project artifact intentionally owns a
  user-scoped declaration. Uninstall never creates an empty manifest to record absence. Every
  successful save names the selected manifest/lock pair; ambiguity and portability refusals happen
  before live or artifact mutation and leave all candidates byte-identical.
- **Saved before/after scenario:** Section 2.1 retains the new-user-inside-repo, explicit
  project-owned user declaration, dual-owner refusal, and output-path examples. EWP-WF14 retains
  those cases as independent fixtures and adds unique-existing-owner behavior plus byte-identity
  assertions.
- **Rejected alternatives:** Always routing by cwd surprises personal installs performed in a
  checkout. Always routing by requested scope breaks project-owned user-scope declarations.
  Updating every matching manifest violates the one-artifact transaction boundary. Adding another
  selector or prompting between owners makes automation nondeterministic; existing `--file` is the
  explicit disambiguator.
- **Affected sections and validation:** 2.1, 8.20.3, 8.20.4, EWP-P0A-T10, EWP-P0A-TS07,
  EWP-P2-T01,
  EWP-P2-TS02, EWP-P4A-T01, EWP-P4A-TS01, EWP-WF14, D-006, EWP-CMD-INSTALL-TS06,
  EWP-CMD-UNINSTALL-TS04, EWP-CMD-INIT-TS01..02.
- **Recorded:** 2026-07-11

#### EWP-CF-022 — Resolve project context once and keep it separate from artifact selection

- **Evidence:** Current install resolves project scope with
  `git -C <cwd> rev-parse --show-toplevel` and realpaths that root, while list/command scanning passes
  raw invocation cwd to Claude/Codex project roots and project config writing appends
  `skillsmith.toml` directly to cwd. Config discovery separately walks for the nearest manifest and
  assumes `.git` is a path boundary. From one repository subdirectory, install can therefore write
  at the Git root while list scans and config writes beneath the subdirectory.
- **Precedent assessed:** Install's Git plumbing and realpath identity are the useful precedent;
  command-specific cwd joining and `.git` directory probing are not. Existing nearest-manifest
  discovery remains useful for configuration/artifact ownership, but an artifact path must not
  silently become a live placement root—especially after EWP-CF-021 separated declaration ownership
  from placement scope.
- **Accepted resolution:** Resolve one immutable `ProjectContext` after global `-C` and before any
  other discovery. It separately records effective cwd, live project root, discovered project
  manifest, explicit artifact pair, and stable realpath identity. Inside Git, project root is the
  real worktree top-level; inside that root, a nearer manifest may own configuration/artifacts but
  does not rebase tool roots. Outside Git, the nearest canonical manifest directory is project root;
  with none, explicit project scope uses effective cwd and an unscoped command retains the user
  default. Explicit `--file` selects artifacts only. Relative CLI paths resolve from effective cwd,
  then project-contained paths serialize relative to project root. Every project-aware command,
  tool-root adapter, ledger key, and path validator consumes the same context.
- **Saved before/after scenario:** From `/work/acme/packages/api`, current install may place
  `review` under `/work/acme/.claude/skills` while list scans
  `/work/acme/packages/api/.claude/skills` and project config writes beside the nested cwd. After,
  all project-aware commands share `/work/acme` as live root and stable identity. A nested
  `/work/acme/packages/api/skillsmith.toml` or explicit `--file ./team-state.toml` may still be the
  selected configuration/artifact pair without relocating live roots; a different live destination
  uses `--path`. EWP-WF14 preserves root/nested/`-C`, worktree, symlink, non-Git, nested-manifest,
  explicit-artifact, and relative-path cases as independent fixtures.
- **Rejected alternatives:** Letting the nearest manifest define live root inside Git makes moving
  or explicitly selecting an artifact relocate placements. Always using raw cwd retains the current
  cross-command mismatch. Adding `--project-root` creates another common selector and precedence
  questions with `-C`, scope, `--file`, and `--path`; defer it unless concrete workflows cannot be
  expressed through the separated context. Letting each command resolve independently preserves the
  defect rather than a useful compatibility contract.
- **Affected sections and validation:** Section 2.1 shared project context, Sections 8.1/8.20,
  D-006, EWP-P1-T01..02, EWP-P1-TS01..02, EWP-P2-T01, EWP-P2-TS02, EWP-P3A-T02, EWP-WF14,
  EWP-CMD-LIST-TS03, EWP-CMD-COMMANDS-TS02, EWP-CMD-STATUS-TS05,
  EWP-CMD-CONFIG-TS03, EWP-CMD-INSTALL-TS03, EWP-CMD-UNINSTALL-TS02,
  EWP-CMD-DOCTOR-TS02, EWP-CMD-INIT-TS01..02, and EWP-CMD-PLAN-TS03.
- **Recorded:** 2026-07-11

#### EWP-CF-023 — Make the current-to-1.0 CLI migration explicit and closed

- **Accepted resolution:** Section 13.1 now stores a dated 0.7.0-to-1.0 migration ledger covering
  every global, current command, alias, argument, option, default/behavior change, new command,
  disposition, compatibility rule, phase owner, and test owner. K/A/C/D/N/R are defined exactly;
  the accepted 1.0 surface has no silent removals and zero R entries. D spellings route to canonical
  target operations, produce human/JSON deprecation data, remain through 1.x, and are removable no
  earlier than 2.0. C items change atomically with code/help/tests and cannot remain accepted no-ops.
  Section 8.20 remains normative; the ledger owns only transition. EWP-P0A-T11, EWP-P0A-TS08, and expanded
  EWP-OPT-TS01 close live parser -> migration ledger -> target registry -> help/test mapping.
- **Saved before/after scenario:** Before, `skillsmith check` succeeds unless `--exit-code` is
  supplied, while the target says failure is default; `promote --yes` parses as a documented no-op;
  local `--no-prompt` declarations do not provide one global contract; install pinning changes only
  the ledger; and `dev/promote --rollback` use verb-specific reversal. After, check fails by default,
  deprecated `--exit-code` routes to that same gate through 1.x, and new `--report-only` explicitly
  requests exit-0 reporting. Yes approves only a known bulk/destructive selection, no-prompt is one
  functional global, pin writes exact portable manifest intent, and rollback compatibility routes to
  undo. Each transition names its implementation phase and EWP-CMD tests in Section 13.1.
- **Affected contracts:** Sections 8.20.1, 8.20.5, and 13.1; EWP-CF-010; EWP-P0A-T02,
  EWP-P0A-T07, EWP-P0A-T11; EWP-P1-T01..08; every affected EWP-CMD contract; and Section 14.
- **Validation:** EWP-P0A-TS02..04, EWP-P0A-TS08, EWP-OPT-TS01..05, and every affected EWP-CMD
  validation range. The gate compares live parser, migration ledger, target registry, generated
  help, JSON/deprecation behavior, and phase ownership.
- **Recorded:** 2026-07-11

#### EWP-CF-024 — Make dev, promote, and undo selection scope-aware

- **Accepted resolution:** Add `-s, --scope <user|project>` plus `--user`/`--project` sugar to
  `dev`, `promote`, and `undo`. Dev/promote accept name or exact placement-path targets; explicit
  scope filters first, a path identifies one placement, a contradictory scope+path exits 2, and an
  unscoped name infers exactly one user/current-project match or refuses ambiguity with candidates.
  Absent `dev --source` creation uses explicit scope, otherwise project inside Git and user outside;
  `--dest` never changes scope. Unscoped `--all` spans eligible user+current-project entries, while
  an explicit scope narrows it; exact preview and normal bulk approval remain mandatory. Human and
  JSON selection output always names tool, scope, canonical path/history identity, and selection
  basis. System/managed remain unsupported mutation scopes.
- **Saved before/after scenario:** With `review` installed for Codex in both user and project scope,
  `skillsmith promote review --tool codex` now exits 2 with both candidates and zero writes;
  `promote review --project --tool codex` selects only project, and
  `dev /work/acme/.agents/skills/review` selects that exact path. `undo review --user` selects only
  user history. `undo --all --dry-run` previews both writable scopes, while adding `--project`
  narrows the preview. An absent `dev review --source ./skills/review` defaults project inside Git
  and user outside Git. EWP-WF05, EWP-WF11, and EWP-WF14 retain these cases.
- **Affected contracts:** Sections 8.8, 8.17, 8.20.3, 8.20.4, 9, 13.1, and 13.2;
  EWP-P1-T03, EWP-P3B-T03, EWP-P5-T05; EWP-WF05, EWP-WF11, EWP-WF14; help/completion; and the dev,
  promote, and undo command contracts.
- **Validation:** EWP-P1-TS03, EWP-P3B-TS03, EWP-P5-TS03, EWP-P5-TS05,
  EWP-CMD-DEV-TS02, EWP-CMD-DEV-TS04, EWP-CMD-PROMOTE-TS01,
  EWP-CMD-PROMOTE-TS04, EWP-CMD-UNDO-TS01, EWP-CMD-UNDO-TS02, and
  EWP-CMD-UNDO-TS06 cover zero/one/two matches, explicit scope, exact path, scope/path disagreement,
  absent-create default, unscoped/scoped all, exit 2 zero-write refusal, and human/JSON identity.
- **Recorded:** 2026-07-11

#### EWP-CF-025 — Bound force to one selected conflict without bypassing safety

- **Accepted resolution:** `-f, --force` authorizes only the command-specific, already-selected
  conflict named in its command contract. It never selects ambiguity, implies yes/no-prompt,
  disables verification/strictness, bypasses portability or lock/saved-plan/capability/journal/
  retention checks, expands prune/delete scope, changes operations after preview, or converts a
  failure to success. Install replaces an unambiguous selected placement; uninstall removes an
  exactly selected dev/unmanaged/edited placement under preservation policy; init replaces only the
  exact manifest; export resolves only selected portable declaration conflicts; plan replaces only
  its exact out path; sync replaces only selected conflicting destination placements while source,
  extra entries, and saved artifacts retain their independent protections. Results report stable
  force-applied, conflict, target, normal/forced behavior, and backup fields; no applicable conflict
  reports force unused.
- **Saved before/after scenario:** `sync review --from user --to project --force --dry-run` shows the
  exact edited destination replacement and backup without selecting unrelated skills or deletions;
  execution still needs yes in noninteractive mode. Install with ambiguous dual manifest owners
  still exits 2 under force. Apply has no force and a stale saved plan still refuses. Sync force does
  not remove extras without delete, and force+delete exposes both independent permissions. EWP-WF04,
  EWP-WF10, EWP-WF14, and EWP-WF15 retain these cases.
- **Affected contracts:** Sections 8.6, 8.7, 8.11, 8.12, 8.13, 8.15, 8.20.1, 8.20.3, 8.20.4, 9,
  13.1, and 13.2; install/uninstall/init/export/plan/sync result schemas; backup/journal policy; and
  EWP-WF04, EWP-WF10, EWP-WF14, EWP-WF15.
- **Validation:** EWP-OPT-TS04; EWP-CMD-INSTALL-TS05..06; EWP-CMD-UNINSTALL-TS03;
  EWP-CMD-UNINSTALL-TS05;
  EWP-CMD-INIT-TS03; EWP-CMD-EXPORT-TS05; EWP-CMD-PLAN-TS09;
  EWP-CMD-SYNC-TS05..08; and cross-command dry-run/execution, force/yes, force/delete,
  ambiguity, portability, capability, verification, saved-plan, backup, JSON, and exit tests.
- **Recorded:** 2026-07-11

#### EWP-CF-026 — Use one deterministic batch scheduler for every multi-target mutator

- **Accepted resolution:** Add `--continue-on-error` to uninstall, dev, promote, and undo, retaining
  it on install, fresh apply, sync, and update. One operation group is a resolved install source,
  uninstall target, dev/promote placement, fresh-apply declaration, sync destination skill, update
  declaration, or undo history target. Invocation-level syntax, state, ambiguity, and approval
  failures abort before writes. Groups run in deterministic identity order; all tool/scope pairs in
  a resolved group report independently and any pair failure fails the group. Default scheduling
  marks later groups skipped-after-failure; continue schedules them but never hides failure or makes
  the batch successful. Cancellation always stops. Dry-run/JSON expose boundaries and policy.
  Saved-plan apply rejects the option because reviewed authorization fixes execution semantics.
- **Saved before/after scenario:** `uninstall alpha beta gamma` stops later groups after alpha fails
  and labels beta/gamma skipped; adding continue removes eligible beta/gamma but still exits nonzero.
  A two-tool promote group reports one success and one failure before scheduling policy affects the
  next skill. `promote --all --continue-on-error --dry-run` and
  `undo --all --continue-on-error --dry-run` show deterministic group order. Applying an exact saved
  plan with continue exits 2. EWP-WF05, EWP-WF09, EWP-WF10, EWP-WF11, EWP-WF13, and EWP-WF15
  retain these cases.
- **Affected contracts:** Sections 8.6, 8.7, 8.8, 8.14, 8.15, 8.16, 8.17, 8.20.1, 8.20.3,
  8.20.4, 9, 13.1, and 13.2; EWP-P3B-T02, Phase 4/5 schedulers; human/JSON result schemas; and every
  multi-target mutation command.
- **Validation:** EWP-OPT-TS04, EWP-P3B-TS03, EWP-P5-TS05, EWP-WF05, EWP-WF09, EWP-WF10,
  EWP-WF13, EWP-WF15, and affected EWP-CMD ranges
  cover invocation-level abort, deterministic ordering, within-group pair reporting, default
  skipped markers, explicit continuation, nonzero error preservation, cancellation, dry-run parity,
  rerun convergence, and saved-plan rejection.
- **Recorded:** 2026-07-11

#### EWP-CF-027 — Define versioned hash domains and canonical inputs

- **Accepted resolution:** Use SHA256 with domain separation over
  `"skillsmith:" + domain + ":v1\0" + canonicalInput`, serialized as
  `sha256:<64 lowercase hex>`. Generated portable artifacts record hash schema version 1. Define
  distinct manifest-semantic, manifest-bytes, lock-canonical, source-content, resource,
  selection-set, and capability domains. Manifest semantic input is the normalized parsed model,
  not presentation bytes. Lock input is exact canonical serialization. Source content is a sorted
  portable-relative tree including entry type, executable bit, bytes, safe internal symlink target,
  and empty directories, with explicit versioned exclusions. Unknown schema versions/domains and
  noncanonical lock bytes refuse rather than being guessed. The exact manifest-byte digest is local
  concurrency protection only: recheck it immediately before replacement and safely replan the
  lossless edit or refuse if another writer changed the file.
- **Saved before/after scenario:** Reformatting or commenting `skillsmith.toml` leaves a saved plan
  valid because its manifest-semantic hash is unchanged; changing a declaration ref invalidates it.
  An editor write after the artifact lock is acquired is caught by the manifest-bytes guard and is
  merged only through a provably safe replan, never overwritten. Adding a member inside a planned
  bulk/prune selection invalidates its selection-set precondition. Equivalent source trees on macOS
  and Linux produce the same source-content digest, while a file-byte, mode, type, symlink-target,
  or empty-directory change produces a different digest.
- **Affected contracts:** Sections 2.2, 2.3, 2.5, 9, and 13.3; portable lock and saved-plan schemas;
  artifact writer/concurrency behavior; source-store identity; Phase 2, Phase 3B, and Phase 4B;
  EWP-WF03, EWP-WF07, and EWP-WF09; and doctor, plan, apply, and update validation contracts.
- **Validation:** EWP-P2-TS01, EWP-P2-TS03..04, EWP-P4B-TS03, EWP-WF03, EWP-WF07, EWP-WF09,
  EWP-CMD-DOCTOR-TS03, EWP-CMD-PLAN-TS04, EWP-CMD-PLAN-TS09,
  EWP-CMD-APPLY-TS07, and EWP-CMD-UPDATE-TS10 cover golden domain vectors, semantic normalization,
  canonical lock bytes, unknown-version/domain refusal, cross-platform trees, concurrent byte
  changes, domain-specific staleness, and selection membership.
- **Recorded:** 2026-07-11

#### EWP-CF-028 — Migrate the local ledger explicitly and never treat corruption as empty state

- **Accepted resolution:** Make schema version 2 the canonical 1.0 `placements.json`, retaining the
  current user/project/pair structure while adding project registrations, coordinator
  transactions, and bounded undo/retention history. Missing alone means empty; an existing empty,
  whitespace, truncated, malformed, or invalid ledger is state error 3. Read-only/dry-run commands
  decode supported version 1 without writing and expose migration pending or a visible
  `migrate-ledger` operation. The first real mutation performs that same operation under the ledger
  lock with semantic-equivalence validation, staged/flushed canonical output, original-byte
  preservation through replacement, and cleanup after the first successful version-2 commit.
  Doctor fix provides the explicit path, so no migrate command is added. Legacy pair journals remain
  recoverable; unknown newer versions refuse with upgrade guidance; a saved migration plan stales if
  another process migrates first.
- **Saved before/after scenario:** With a version-1 ledger, `status review` reports the placement and
  migration pending without changing bytes. `install ... --dry-run` shows migrate-ledger then
  install without writing; execution atomically migrates before installing. A zero-byte ledger now
  exits 3 instead of becoming an empty fleet. A pending version-1 journal survives migration and
  permits only same-operation resume or pending undo. EWP-WF11 retains the command sequence and
  crash matrix; EWP-WF12 proves GC uses explicit version-2 project registrations.
- **Affected contracts:** Sections 2.4, 2.5, 8.10, 9, and 13.3; the local ledger schema and reader;
  Phase 3B coordinator/migration work; status, doctor, plan, apply, undo, GC, and every mutation that
  first encounters version 1; EWP-WF11 and EWP-WF12.
- **Validation:** EWP-P3B-TS04; EWP-CMD-STATUS-TS04; EWP-CMD-DOCTOR-TS03/05/06;
  EWP-CMD-PLAN-TS01/10; EWP-CMD-APPLY-TS07/10; EWP-CMD-UNDO-TS01/09;
  EWP-CMD-GC-TS02; and EWP-WF11..12 cover absent versus corrupt state, read-only byte identity,
  automatic/doctor migration equivalence, canonical version 2, newer-version refusal, saved-plan
  staleness, legacy recovery, project registration, and every migration crash point.
- **Recorded:** 2026-07-11

#### EWP-CF-029 — Define the legacy project-config-to-manifest transition

- **Accepted resolution:** Structurally distinguish canonical files (`version` plus canonical
  sections), exact legacy files (no version and only tool/scope/path/registry), and invalid
  mixed/empty/malformed/unknown shapes. Retain read-only exact-legacy support throughout 1.x with
  migration metadata, but never interpret legacy configuration as empty desired state. Canonical
  writers add a visible migrate-project-config prerequisite; doctor fix exposes the same operation,
  so no migrate command is added. The lossless editor maps tool to defaults.tools, relocates
  scope/portable path, preserves registry/comments/modes/newlines, creates no lock for migration
  alone, and refuses unsafe comment relocation, concurrent edits, nonportable paths, or unsupported
  scopes without dropping values. Config and artifact selectors retain separate roles even when
  they name one path, and a saved migration operation stales after external migration.
- **Saved before/after scenario:** A commented legacy project file containing `tool = "codex"`,
  `scope = "project"`, portable path, and registry becomes version-1 canonical TOML with a
  `[defaults]` tools array and preserved human content. Doctor dry-run and init show the same mapping;
  init can migrate the exact legacy file without force and creates no lock. Read-only commands leave
  the legacy bytes unchanged. Mixed syntax or `/opt/shared/skills` refuses with an exact manual
  remediation. EWP-WF03 stores the bootstrap variants; EWP-WF14 stores config/file dual-role cases;
  EWP-WF16 validates published migration guidance.
- **Affected contracts:** Sections 2.1, 2.5, 8.1, 8.5..8.7, 8.10..8.15, 8.20, 9, and 13.3;
  Phase 1 compatibility reads and Phase 2 writers; config, doctor, init, install, uninstall, export,
  plan, apply, and sync; EWP-WF03, EWP-WF14, and EWP-WF16.
- **Validation:** EWP-P2-TS06; EWP-CMD-CONFIG-TS04; EWP-CMD-DOCTOR-TS03/05/06;
  EWP-CMD-INIT-TS01/03; EWP-CMD-INSTALL-TS06; EWP-CMD-UNINSTALL-TS04;
  EWP-CMD-EXPORT-TS06/07; EWP-CMD-PLAN-TS01/03/10; EWP-CMD-APPLY-TS07/10;
  EWP-CMD-SYNC-TS07/08; EWP-WF03; EWP-WF14; and EWP-WF16 cover exact legacy, canonical,
  mixed, empty, malformed, unknown, nonportable, and unsupported shapes; human-content fidelity;
  read/dry-run identity; automatic/doctor equivalence; dual roles; concurrency/crash; no-lock
  migration; 1.x metadata; and saved-plan staleness.
- **Recorded:** 2026-07-11

#### EWP-CF-030 — Define one portability and secret-redaction boundary

- **Accepted resolution:** Persist only credential-free canonical host/repository/source-relative
  identity with ref separate; literal acquisition arguments and clone URLs are ephemeral. Reject
  HTTP(S) userinfo/password/token/query/fragment credentials and file URLs with local Git-auth or
  dev-source remediation; accept credential-free HTTPS and SSH/scp, retaining only non-secret SSH
  transport metadata where needed. Portable manifest/lock/plan fields allow canonical sources,
  project-relative, allowed home-relative, and source-relative POSIX paths and reject escapes,
  absolute/drive/UNC/store/ledger/dev paths. The ledger remains explicitly local. Saved plans carry
  automatic portable or machine-bound classification and reasons; portable plans have no local
  absolute paths, while machine-bound plans enforce matching local preconditions. One recursive
  redactor precedes every render/persistence boundary and scans credential canaries across output,
  errors, journals, artifacts, temporaries, backups, and crash residue. No command or flag is added.
- **Saved before/after scenario:** Installing
  `https://alice:ghp_example_secret@github.com/acme/private.git//skills/review` now refuses before
  acquisition and recommends `github.com/acme/private//skills/review` with local authentication;
  the canary occurs nowhere in state/output. `file:///work/private-skills//review` redirects to
  `dev review --source /work/private-skills/review`. A managed project plan is portable; a plan
  involving `/Users/alice/src/review` is machine-bound with `local-dev-source` and refuses under a
  different local context. EWP-WF03, EWP-WF04, EWP-WF07, and EWP-WF15 retain these cases.
- **Affected contracts:** Sections 2.1..2.5, 8.1, 8.6, 8.12..8.14, 8.20, 9, 13.1, and 13.3;
  source parser/acquisition DTOs; manifest, lock, plan, ledger, journal, output, and error schemas;
  Phase 2 and Phase 4B; install, export, plan, apply, status, doctor, and debug logging.
- **Validation:** EWP-P2-TS07; EWP-P4B-TS07; EWP-CMD-INSTALL-TS01/07/08;
  EWP-CMD-EXPORT-TS08/09; EWP-CMD-PLAN-TS09; EWP-CMD-APPLY-TS07/14;
  EWP-WF03; EWP-WF04; EWP-WF07; and EWP-WF15 cover credential-free HTTPS/SSH/scp, forbidden
  userinfo/query/fragment/file sources, path token/escape/absolute/drive/UNC/local-state matrices,
  portable/machine-bound plan behavior, cross-machine enforcement, recursive nested redaction, and
  canary scans through debug, partial failure, crash, journal, temporary, backup, and every artifact.
- **Recorded:** 2026-07-11

#### EWP-CF-031 — Make zero-target behavior explicit

- **Accepted resolution:** Dev, promote, mutating/dry-run update, and undo require positional targets
  or explicit all; target-plus-all and missing required selection exit 2 before planning, and
  empty/unmatched targets never widen. Targetless update-check safely covers all eligible
  declarations in the one selected manifest, with all-check equivalent. Status uses its selected
  readable context; plan/fresh apply use the selected manifest; sync uses all source entries between
  mandatory endpoints; GC uses registered ledger objects. Those are named bounded defaults, not
  implicit global all. Delete/prune remain separately explicit. Filters reducing a valid selection
  to zero produce an explained exit-0 no-op. Human/JSON records explicit-targets, explicit-all, or
  bounded-default; help shows target-or-all grammar and completion never injects all. No command or
  option is added.
- **Saved before/after scenario:** Plain `update` exits 2 and recommends a skill or all, while
  `update --check` checks the selected manifest without mutation. Plain undo exits 2 instead of
  guessing the latest operation. Targetless sync reconciles every source entry only because from/to
  bound the set and never implies delete. Plain GC evaluates its ledger-bounded set but still applies
  retention and approval. EWP-WF05, EWP-WF09..12, EWP-WF14, and EWP-WF15 retain the complete matrix.
- **Affected contracts:** Sections 8.4, 8.8, 8.13..8.18, 8.20, 9, 13.1, 13.2, and 13.4;
  selection metadata/help grammar; status, dev, promote, plan, apply, sync, update, undo, and GC.
- **Validation:** EWP-OPT-TS06; EWP-CMD-STATUS-TS05; EWP-CMD-DEV-TS02/04;
  EWP-CMD-PROMOTE-TS01/04; EWP-CMD-PLAN-TS03/05; EWP-CMD-APPLY-TS05;
  EWP-CMD-SYNC-TS01/04/06; EWP-CMD-UPDATE-TS03/04; EWP-CMD-UNDO-TS01/06/07;
  EWP-CMD-GC-TS01/06; EWP-WF05; EWP-WF09..12; EWP-WF14; and EWP-WF15 cover missing targets,
  positional-plus-all, unmatched target/glob, filter-to-zero, bounded defaults, the update-check
  exception, deletion/prune independence, selection provenance, help, completion, JSON, and
  noninteractive behavior.
- **Recorded:** 2026-07-11

#### EWP-CF-032 — Close the complexity budget with primary questions and progressive help

- **Accepted resolution:** Retain all 23 flat canonical commands and add no help-all flag,
  convenience alias, or artificial namespace. Organize root/docs/workflows into five intent groups:
  Discover (agents/list/commands/status), Manage (install/uninstall/update/undo), Develop
  (dev/verify/promote), Declarative (init/export/plan/apply/sync), and Maintain
  (doctor/check/gc/config/completion/version/help). Each command owns one exclusive primary question
  and minimal invocation. Command help is generated from shared metadata in stable sections: primary
  question, usage, common workflows, targets/scope, source/destination/artifacts,
  behavior/verification, safety/approval, automation/output, and inherited globals. Every option
  appears exactly once; advanced controls are separated but never hidden; completion remains full.
  Normal single-resource paths need no optional flags except inherently relational dev-source and
  sync endpoints; explicit bulk/destructive/strict/automation flags remain deliberate authority.
- **Saved before/after scenario:** Root help moves verify beside dev/promote in a Development group
  and doctor/check into Maintain while preserving the earlier four groups. Flat install option output
  becomes a short primary question plus runnable common examples and grouped complete options.
  `help workflows` stores `dev review --source ...`, `verify ... --deep`, and `promote review` as one
  loop. The Section-13.4 matrix retains all 23 command questions/minimal invocations and overlap
  distinctions.
- **Affected contracts:** Sections 3.2.1, P2-05, 8.19, 8.20, 13.1, and 13.4; EWP-CF-013;
  Phase 6; root/command help, topics, completion, README, generated references, and all 23 commands.
- **Validation:** EWP-P6-TS05; EWP-OPT-TS07; EWP-CMD-HELP-TS01/02/05/06;
  EWP-CMD-COMPLETION-TS01/03/05; EWP-WF01; EWP-WF05; EWP-WF15; and EWP-WF16 assert one group and
  exclusive question per command, alias adjacency, every option exactly once in stable category
  order, full completion visibility, runnable common examples, minimal-invocation flag budgets,
  development-loop placement, and no help-all/new aliases/namespaces.
- **Recorded:** 2026-07-11

#### EWP-CF-033 — Add an application-service boundary behind every CLI command

- **Accepted resolution:** Preserve the core/CLI split while replacing command-local runtimes with
  declarative CommandSpec metadata, one shared CLI runtime/renderer/exit adapter, public core
  application services, structured CommandOutcome exit classes, and injected interaction ports.
  Specs single-source parser/help/completion/docs facts. The runtime alone owns global context,
  Commander usage mapping, environment/TTY/signals, prompts/approval, render selection,
  stdout/stderr, numeric exits, redaction, deprecations, and cancellation. Core services own semantic
  use cases and planner/coordinator calls without CLI dependencies or numeric exit policy. Command
  modules cannot write/exit directly, construct independent environments, select renderers, deep
  import core, or duplicate error/interaction policy. ADR 0004 and lint zones enforce direction.
  Architecture docs describe no ambient or CLI-owned I/O, with effects through injected ports.
- **Saved before/after scenario:** Current install/dev modules each define Commander error tables,
  environment/test-seam setup, core invocation, result loops, renderer choice, and process exit.
  After migration, an install CommandSpec declares identity/options/examples/capability and points to
  `runInstallUseCase`; the shared runtime supplies context/interaction and renders its outcome. A
  fixture command joins parser, five-group help, completion, docs, execution, and exits from metadata
  without a new runtime. EWP-WF15 retains behavior parity; EWP-WF16 retains generation parity.
- **Affected contracts:** Section 9.1; Phase 1; ADRs 0001..0003 plus new ADR 0004;
  architecture docs and lint zones; all command registration, help, completion, rendering, exits,
  interaction, public core application exports, and every current/proposed command.
- **Validation:** EWP-P1-TS07, EWP-WF15, EWP-WF16, ADR 0004, and architecture lint gates cover
  human/JSON/error/cancel/noninteractive parity for every migrated command; prohibit direct command
  process output/exit, environment construction, renderer/deep-core imports, and duplicated error
  tables; assert one runtime/exit/redaction/signal/interaction path; and prove the fixture command is
  generated and executable solely from CommandSpec plus an application service.
- **Recorded:** 2026-07-11

#### EWP-CF-034 — Replace the growing ScanEnv interface with capability-scoped ports

- **Accepted resolution:** Compose PlatformPaths, FileRead, FileWrite, Lock, Process, high-level Git,
  HTTP, Clock, and Id ports at the application boundary, but pass each domain service only its named
  required subset. Read-only services cannot receive write/lock/arbitrary-process capability. Raw
  environment is resolved once into typed configuration; Git domain logic uses GitPort; time,
  randomness, and IDs are injected; adapter errors become domain errors. Keep ScanEnv and
  defaultScanEnv as a deprecated compatibility aggregate through 1.x, backed by the same real
  adapters; forbid new aggregate signatures and removal before 2.0. Add ADR 0005 plus static
  least-capability gates without creating one-method port sprawl or duplicate implementations.
- **Consistency amendment (2026-07-12):** `HttpPort` is named explicitly because the current
  doctor network-reach check performs ambient `fetch`. This closes an omitted existing effect under
  the accepted “all effects injected” rule; it does not add a command, network behavior, or later
  capability-registry scope.
- **Saved before/after scenario:** Today a read-only `listSkills(env: ScanEnv)` can rename, remove,
  write, lock, and execute by type, and tests fake unrelated methods. After migration it receives
  FileReadPort plus PlatformPaths only; ledger writes receive FileWrite/Lock/Clock, and update
  resolution receives Git/Clock. Current commands run identically through the compatibility facade
  and focused ports. Compile-time fixtures prove a scanner cannot write/remove/lock/exec, while
  deterministic ports reproduce transaction, migration, undo, and GC results.
- **Affected contracts:** Section 9.1; Phase 1; ADRs 0001..0004 plus ADR 0005; core environment,
  detection, verification, placement, acquisition, config, ledger, artifact, and application APIs;
  public compatibility types; test fakes and lint/import boundaries.
- **Validation:** EWP-P1-TS08, EWP-WF11, EWP-WF15, EWP-WF16, ADR 0005, static signature/import
  gates, and compile-time negative fixtures cover no-new-ScanEnv signatures, no raw process.env in
  domain code, read-only least capability, GitPort/HttpPort ownership, structured errors, compatibility/focus
  parity, deterministic clocks/IDs, typed-config secret isolation, and one real implementation for
  compatibility and new ports.
- **Recorded:** 2026-07-11

#### EWP-CF-035 — Separate immutable state snapshots, pure planning, and repository writes

- **Accepted resolution:** Build one deeply immutable, versioned ObservedStateSnapshot over project,
  manifest, lock, ledger, live, store, and capabilities. Make `createPlan(request, snapshot)` pure,
  port-free, non-rereading, and deterministic for dry-run/plan/fresh-apply/execution. Introduce
  domain-specific manifest/lock/ledger/live/store repositories that own mechanics, not policy; never
  call one another; and stage against expected revisions. Only the transaction coordinator combines
  writes, controls journal/commit/rollback/cleanup, and revalidates referenced revisions. Ledger
  reducers return new models rather than mutating shared state. Status receives read repositories
  only. Partial pairs advance truthful successive revisions without whole-invocation atomic claims.
  Migrate by extracting reducers/state reader/pure planners, wrapping current writes, moving
  coordination, removing mutable contexts, and splitting monolithic runners. Add ADR 0006 plus
  dependency-cycle and module-size ownership gates.
- **Saved before/after scenario:** Current placement execution reads a ledger, plans with it, mutates
  that same object through `setPair`, persists via a closure, and rereads after pair results. After,
  the state reader returns a deep-frozen snapshot, pure planning returns stable operation IDs/order,
  and the coordinator executes against expected revisions. Concurrent changes refuse; dry-run and
  execution share the exact plan; successful/failed multi-tool pairs retain truthful separate
  revisions. EWP-WF06 stores preview/execution identity, EWP-WF11 repository crash injection, and
  EWP-WF13 partial revision behavior.
- **Affected contracts:** Section 9.2; Phase 3A and Phase 3B; ADR 0006; manifest, lock, ledger, live,
  and store ownership; dry-run, plan, apply, sync, update, undo, GC, crash recovery, partial failure,
  application services, and core test architecture.
- **Validation:** EWP-P3B-TS05, EWP-WF06, EWP-WF11, EWP-WF13, ADR 0006, deep-freeze traps,
  determinism/property tests, dry-run/execution operation equality, stale/concurrent expected
  revisions, repository isolation, read-only status capabilities, stage/commit/rollback/cleanup
  fault injection, compatibility parity, dependency-cycle checks, and module-size/ownership gates.
- **Recorded:** 2026-07-11

#### EWP-CF-036 — Make the tool-adapter registry the executable capability authority

- **Accepted resolution:** Replace independent supported/writable arrays and generic tool-name
  conditionals with one validated ToolAdapter registry. Each descriptor owns ID/order/version and
  per-operation support; cohesive inventory and optional verification/placement/adaptation bundles
  provide implementation. Registry construction rejects descriptor/bundle drift, missing write or
  verify implementations, read-only mutation, and duplicate IDs/versions. Derive CLI/completion/
  config/manifest choices, agents capability output, planner checks, exit-4 remediation, help/docs,
  and 1.x compatibility views from the registry; remove independent FLIP_TOOLS. Adapters own roots,
  gate policy, legacy notices, placement, and rendered facts; generic services never branch on known
  IDs. Preserve Claude/Codex static/deep/full lifecycle and Kilo/OpenCode read-only behavior.
  Capability fingerprints include only relevant adapter version/operation/support/mode/scope. Add
  ADR 0007, fixture adapters, and static branch gates.
- **Saved before/after scenario:** Today adding Kilo mutation or another tool requires changing
  SUPPORTED_TOOLS/FLIP_TOOLS, schemas, planners, executor switches, and renderer conditions. After,
  a fixture read-only or write adapter registers without generic workflow changes; registry-derived
  surfaces update together. Claude Code and Codex deep verification remain proven; Kilo/OpenCode
  mutation exits 4. A used capability-version change stales a saved plan, while an unrelated adapter
  change remains valid. EWP-WF01, EWP-WF05, and EWP-WF07 retain these cases.
- **Affected contracts:** P2-06; Sections 8.2..8.10, 8.20, 9.1..9.2, and 13.5; Phase 1 and Phase
  3B; registry, detection, verification, placement, planning, execution, rendering, schemas,
  help/completion, saved-plan capabilities, public compatibility exports, and deferred P3 adapters.
- **Validation:** EWP-P1-TS09, EWP-P3B-TS06, EWP-WF01, EWP-WF05, EWP-WF07,
  EWP-CMD-AGENTS-TS03, EWP-CMD-VERIFY-TS02, ADR 0007, registry consistency tests, static generic
  tool-branch bans, fixture adapter registration, exact four-tool matrix, Claude/Codex deep/full
  lifecycle, Kilo/OpenCode read-only exit 4, structured renderer facts, and relevant/unrelated saved
  capability staleness.
- **Recorded:** 2026-07-11

#### EWP-CF-037 — Make codecs the canonical wire-contract authority

- **Accepted resolution:** Give every persisted artifact and public JSON result exactly one
  canonical versioned codec: manifest, lock, plan, ledger v1/v2, journal, error envelope,
  capability snapshot, and every command output. Infer wire DTO types from codecs; keep immutable
  domain models separate; and require explicit decode/migrate and encode/redact mappings. Artifact
  repositories own parsing, version discrimination, migration, and canonical serialization;
  application services and planners never parse raw bytes. Renderers serialize only validated DTOs
  and never remove internal fields ad hoc. Each codec declares kind, schema version, unknown-field
  policy, canonical form, migrations, and compatibility rules; unknown future versions refuse.
  Stable domain APIs and dedicated versioned contract entry points replace public exposure of
  internal persistence structures. Add ADR 0008 and one complete contract registry.
- **Saved before/after scenario:** Today `LedgerFile` and `LedgerSchema` separately repeat the same
  fields, while install/uninstall/flip JSON schemas repeat core report fields and renderers remove
  core-only `error` properties by destructuring. One edit can make the TypeScript, validator, and
  output disagree. After, `LedgerV2Codec` defines `LedgerV2Dto`; `decodeLedger` accepts supported
  v1/v2 DTOs and returns a domain `LedgerModel`; `encodeLedger` emits only v2. Likewise,
  `toInstallV1Dto(report)` constructs a public DTO, its codec validates it, and the canonical
  serializer emits it. Internal errors cannot serialize because the DTO cannot represent them.
  Existing JSON bytes remain golden-compatible during migration; old ledgers migrate visibly and
  unknown future versions refuse rather than normalize.
- **Affected contracts:** Sections 2.1..2.5, 8.1, 9.1..9.2, and 13.5; Phase 1 and Phase 2; ADR
  0008; manifest, lock, plan, ledger, journal, error envelope, capability snapshot, every command
  JSON schema/renderer, artifact repositories, public core exports, generated contract docs, and
  compatibility/version policy. No command or CLI option is added.
- **Validation:** EWP-P1-TS10, EWP-P2-TS08, ADR 0008, per-version golden fixtures, current JSON
  byte parity, encode/decode round trips, backward migration, unknown-future-version and unknown-key
  refusal, truncated/malformed/fuzzed input, canonical-byte determinism, type-level internal-field
  nonserialization, contract inventory/docs parity, compatibility changelog, and static bans on ad
  hoc renderer field stripping or raw artifact parsing outside codecs/repositories.
- **Recorded:** 2026-07-11

#### EWP-CF-038 — Add operation-scoped structured observability

- **Accepted resolution:** Introduce immutable OperationContext with operation/parent IDs,
  command/workflow, deterministic group/pair identity, and injected clocks. Replace arbitrary
  domain logging with a small typed ObserverPort event union for command, plan, operation, tool
  detection/verification, transaction, and recovery lifecycles. The shared CLI runtime alone maps
  events to normal/verbose/trace/debug stderr after recursive redaction; JSON stdout remains one
  value. Observer sinks are best-effort and cannot affect results, exit codes, or rollback. Errors
  remain structured CommandOutcome/error-envelope data and never only events. Journals remain the
  durable recovery/audit authority and events never calculate state. Retain IDs across resume while
  distinguishing attempts. Add ADR 0009; do not add OpenTelemetry, trace files, a log command, or a
  new 1.0 option.
- **Saved before/after scenario:** Today detection logs `detecting ${tool}` and a free-form warning,
  while commands directly write output and do not uniformly consume global verbosity. A failed
  multi-stage apply cannot reliably correlate its planning, tool, transaction, journal, and
  recovery messages. After, `skillsmith apply --plan release.plan --debug` creates `apply-42`;
  typed plan/verify/place/stage/commit-or-rollback/recovery events and the journal carry that ID,
  while attempts distinguish a resume. Debug renders only redacted stderr and JSON stdout stays
  parseable. A failing observer sink does not change the actual apply/rollback result or exit code.
- **Affected contracts:** Sections 8.1, 8.20, 9.1..9.2, and 13.5; Phase 1 and Phase 3B; ADR 0009;
  CommandOutcome, diagnostics/error envelopes, OperationContext, adapters, planner/coordinator,
  transaction/recovery/journal identity, redaction, and human/JSON verbosity behavior. No command
  or CLI option is added.
- **Validation:** EWP-P1-TS11, EWP-P3B-TS07, ADR 0009, event-registry completeness, causal
  lifecycle sequences, command/group/pair/transaction/journal correlation, fake-clock durations,
  redaction canaries, quiet/verbose/double-verbose/debug human/JSON matrix, one-value JSON stdout,
  observer-sink failure injection, errors-not-only-events, retry/resume attempt identity, static
  direct-domain-logger/direct-command-output bans, and proof events never drive recovery/state.
- **Recorded:** 2026-07-11

#### EWP-CF-039 — Make every planned validation executable and release-blocking

- **Accepted resolution:** Create one machine-readable catalog mapping every phase, command,
  option, and holistic-workflow validation ID to exactly one primary executable test, fixture,
  static gate, or distribution check and one required-PR/supported-platform/release/deferred tier.
  Supporting tests may reference an ID, but duplicates, orphans, prose-only ownership, and skipped
  required suites fail. Keep `just check` as the canonical ordinary-PR recipe and add one
  `just release-check` recipe for exact-SHA distribution and live compatibility; CI calls the same
  recipes. PRs require hermetic fake-tool deep contracts; release candidates additionally require
  non-skipped real Claude/Codex evidence. Release Please may prepare version/changelog changes, but
  publication waits for exact-SHA release-check success, four declared builds, runnable-native and
  clean-install smoke, version consistency, checksums/provenance, generated clean diff, and every
  declared distribution. Use risk/state-transition coverage rather than an arbitrary 100% target.
  Add ADR 0010. No Skillsmith CLI command or option is added.
- **Saved before/after scenario:** Before, EWP-P3B-TS07 can exist only in Markdown while
  `bun test` exits 0 after an important live suite skips; the independent release workflow can
  proceed without proving the exact commit passed the full binary/package/contract/tool matrix.
  After, the catalog maps EWP-P3B-TS07 to its executable required-PR owner and maps EWP-P6-TS06 to
  release-check. A release PR prepares metadata, `just check` closes every PR-tier ID, and the
  merged SHA runs all four builds, native/package clean installs, generated/contract/version gates,
  and real Claude/Codex compatibility. Missing credentials/tools, a skip, an orphan ID, dirty
  generated output, or any failure blocks publication and names the validation ID; verified assets
  and provenance bind to that SHA.
- **Affected contracts:** Section 10 Phase 0A and Phase 6, Sections 13.5 and 14, ADR 0010,
  package scripts/justfile, CI and release workflows, every EWP validation ID, architecture/schema/
  migration/workflow/platform/live-tool tests, version/release metadata, generated docs/help/
  completion/contracts, distribution artifacts, checksums, and provenance. No Skillsmith CLI
  surface changes.
- **Validation:** EWP-P0A-TS09, EWP-P6-TS06, ADR 0010, catalog negative/self-tests,
  plan-to-catalog-to-test round trip, skipped-required refusal, local/PR recipe parity,
  exact-release-SHA enforcement, failure-to-publish injection, four-target build/native smoke,
  package/direct-binary/declared-distribution clean installs, version/metadata agreement, generated
  clean diff, contract/migration compatibility, hermetic fake-tool PR verification, real Claude/
  Codex release verification, checksum/provenance binding, and clean-worktree assertion.
- **Recorded:** 2026-07-11

#### EWP-CF-040 — Keep sibling lock defaults and expose one uniform advanced override

- **Accepted resolution:** Preserve zero-configuration sibling derivation (`team.toml` ->
  `team.lock`) while exposing singular `--lockfile <path>` as an advanced override on every command
  that consumes a manifest/lock pair: status, doctor, check, install, uninstall, export, plan, fresh
  apply, sync with save, and update. Lockfile requires explicit singular file, never persists into
  manifest/config, appears in human/JSON selected-pair output, and must be repeated on later direct
  invocations. No-save conflicts either selector; unsaved sync rejects both; saved-plan apply
  rejects both because the plan already records its exact pair. Init remains manifest-only. A
  portable relative override can remain portable; an absolute local override makes a saved plan
  machine-bound. Help keeps lockfile in advanced artifact controls.
- **Saved before/after scenario:** The incomplete design allowed
  `export --file team.toml --lockfile locks/team.lock`, but a later
  `update --file team.toml --all` silently derived `team.lock`, and doctor/check could not select the
  non-sibling pair. After, ordinary `--file team.toml` still uses `team.lock`. The unusual workflow
  explicitly repeats `--file team.toml --lockfile locks/team.lock` for export, status, doctor,
  check, plan, fresh apply, sync-save, install/uninstall, and update; every result names both paths.
  Omitting the override intentionally returns to sibling derivation. EWP-WF04 retains the
  export-plan-apply sequence with the repeated override.
- **Affected contracts:** Sections 2.1..2.3, 8.4, 8.6..8.7, 8.10, 8.12..8.16, 8.20, 13.1..13.3,
  and 15; CF-003 paired-artifact rules; artifact discovery, ProjectContext separation, saved-plan
  portability/preconditions, help/completion, status, doctor, check, install, uninstall, export,
  plan, apply, sync-save, and update. One advanced option is added consistently; no command is added.
- **Validation:** EWP-OPT-TS08, EWP-P0A-TS04, EWP-P2-TS02, EWP-WF04,
  EWP-CMD-STATUS-TS05, EWP-CMD-DOCTOR-TS03/05, EWP-CMD-CHECK-TS03,
  EWP-CMD-INSTALL-TS06, EWP-CMD-UNINSTALL-TS04, EWP-CMD-EXPORT-TS06,
  EWP-CMD-PLAN-TS03, EWP-CMD-APPLY-TS05/07, EWP-CMD-SYNC-TS07,
  EWP-CMD-UPDATE-TS06, and help/completion inventories cover sibling derivation, requires-file,
  singularity, repetition/non-persistence, conflicts, exact output, portable/machine-bound path
  handling, and saved-plan exact-pair behavior.
- **Recorded:** 2026-07-11

#### EWP-CF-041 — Put init execution behind the shared planner and make it previewable

- **Accepted resolution:** Keep manifest schema, canonical skeleton construction, lossless legacy
  conversion, request validation, artifact repository, and byte round trips in Phase 2, but defer
  CLI registration/execution of init to Phase 4A after shared Operation/application-service
  foundations exist. Init produces exactly one create-manifest, replace-manifest,
  migrate-project-config, noop, or refusal result. Add dry-run; preview and execution use the same
  immutable operation. Absent creation and exact lossless legacy migration need no additional
  approval; replacement requires force but not a redundant yes. Init never creates a lock or
  changes live/ledger state. Narrow config set/unset remains a validated atomic administrative edit,
  explicitly outside fleet reconciliation rather than contradicting the operation promise.
- **Saved before/after scenario:** Before, Phase 2 registered a mutating init command before Phase
  3B defined the shared operation model, and `init --file team.toml --force` could replace a human
  file without a preview mode. After, Phase 2 proves skeleton/repository bytes only; Phase 4A runs
  `init --file team.toml --force --dry-run` through the shared planner and renders one
  replace-manifest operation with exact before/after plus unchanged lock/live/ledger. Removing
  dry-run executes that byte-identical operation under expected-revision/concurrent-writer guards.
  EWP-WF03 runs init dry-run before execution.
- **Affected contracts:** Design principle 3; Sections 8.11, 8.20, 9, 10 Phase 2/3B/4A, 11
  EWP-WF03, 13.1..13.2, and 15; init CommandSpec/application service, artifact repository, help/
  completion, new-command introduction phase, force/dry-run behavior, and config-edit exception.
  No command is added; dry-run is added to init.
- **Validation:** EWP-P2-TS05, EWP-P4A-TS04, EWP-WF03, EWP-CMD-INIT-TS01..05,
  EWP-OPT-TS03..05, skeleton/legacy round trips, dry-run/execution operation equality,
  absent/legacy/existing/force/noop/refusal matrix, expected-revision/concurrent-writer/crash tests,
  lock/live/ledger byte identity, no extra yes requirement, human/JSON parity, and help/completion
  coverage.
- **Recorded:** 2026-07-11

#### EWP-CF-042 — Define exact saved-plan validation modes and option conflicts

- **Accepted resolution:** Saved-plan apply treats the reviewed artifact as prior authorization and
  never replans. With plan, dry-run validates schema/executor/capabilities/preconditions and renders
  exact operations without writes, returning 0 when valid; check performs the same validation and
  returns 0 for no executable operations, 7 for a valid nonempty set, 3 for stale/incompatible
  state, or the actual error. Dry-run/check conflict. Plan allows JSON and inherited output/context
  assertions, but rejects file, lockfile, tool, scope/sugar, locked, prune, yes, and
  continue-on-error. Plain saved apply does not prompt; no-prompt remains a valid assertion. Every
  validation mode leaves the plan and all state byte-identical.
- **Saved before/after scenario:** Before, `apply --plan release.plan --check` could plausibly ignore
  the file and create a fresh plan, reject the combination, or return drift for a stale artifact.
  After, it decodes and validates only `release.plan`: a valid four-operation plan reports the exact
  four and exits 7; dry-run reports them and exits 0; a changed manifest-semantic precondition exits
  3 with no writes. `--plan release.plan --prune` exits 2 rather than changing reviewed operations.
  EWP-WF07 stores dry-run/check/execution together and EWP-WF08 covers CI exits.
- **Affected contracts:** D-001, D-002, and D-014; Sections 2.3, 8.14, 8.20, 13.1..13.2, and 15;
  saved-plan schema/authorization, apply CommandSpec, planner compatibility aliases, exit precedence,
  help/completion, human/JSON output, EWP-WF07, EWP-WF08, and EWP-WF15. No command or option is added.
- **Validation:** EWP-OPT-TS09, EWP-CMD-APPLY-TS06/07/12, EWP-WF07, EWP-WF08, EWP-WF15,
  fresh/saved mode partition, full allowed/conflicting option matrix, dry-run/check exclusion, exact
  operation identity/no-replan proof, plan/state byte identity, valid-empty/nonempty/stale/
  incompatible/malformed/cancelled exits, prior authorization without yes, JSON parity, and
  error-before-drift precedence.
- **Recorded:** 2026-07-11

#### EWP-CF-043 — Close meaningless approval and contradictory preview modes

- **Accepted resolution:** Define dry-run/check as non-mutating modes across every command. Yes
  conflicts either mode because no execution approval exists; inherited no-prompt remains a valid
  assertion. Commands exposing both reject them together. Selection and operation-shaping flags
  remain valid only when they materially change preview: force, prune, delete, ref, pin, strict,
  continue-on-error, targets/tools/scopes/artifacts. Plan check rejects out and therefore force;
  check report-only rejects exit-code; doctor fix dry-run is valid but rejects yes; update check
  rejects dry-run/yes while allowing meaningful ref/pin/strict/batch. CF-042's saved-plan matrix
  remains stricter. Validate every conflict before discovery, network, prompt, or writes.
- **Saved before/after scenario:** Before,
  `install owner/repo//review --dry-run --yes` could silently accept meaningless approval,
  `update --all --check --dry-run` requested two exit policies, and
  `plan --check --out release.plan` contradicted check's no-write promise. After each exits 2 before
  I/O and names the conflict. Conversely,
  `sync review --from user --to project --force --delete --dry-run` remains valid because force and
  delete change the exact preview while no write or approval occurs. EWP-WF09/10/15 retain these
  cases.
- **Affected contracts:** Sections 8.1, 8.6..8.18, 8.20, 13.1..13.2, and 15; shared preview/check,
  approval, conflict, batch, and validation-order families; install, uninstall, dev, promote,
  doctor, check, init, export, plan, apply, sync, update, undo, and GC help/completion and tests;
  EWP-WF06, EWP-WF08..10, EWP-WF12, and EWP-WF15. No command or option is added.
- **Validation:** EWP-OPT-TS10, EWP-P0A-TS04, EWP-WF08..10, EWP-WF15, and affected EWP-CMD tests;
  complete command-by-command mode matrix, yes rejection, no-prompt assertion, dry-run/check
  exclusion, plan check/out/force and check report-only/exit-code conflicts, meaningful
  force/prune/delete/ref/pin/strict/batch previews, validation-before-I/O proof, exit-2 zero-state
  change, human/JSON usage errors, and generated help/completion parity.
- **Recorded:** 2026-07-11

### 13.1 Current-program drift

**Status:** planning-level ledger closed by EWP-CF-023. The current side below is derived from
`buildProgram()` at repository version 0.7.0 on 2026-07-11. Section 8.20 remains the normative 1.0
target; this ledger owns only the transition. EWP-P0A-T11, EWP-P0A-TS08, and EWP-OPT-TS01 fail when live code,
this ledger, target registry, help, or test ownership diverge.

Dispositions:

- **K — keep:** syntax and intended behavior remain; implementation may move behind shared helpers.
- **A — alias:** supported spelling routes to the canonical command without a deprecation warning.
- **C — change:** syntax remains recognizable but documented behavior/default becomes the target
  behavior at its owning phase; it must never remain an accepted no-op.
- **D — deprecate:** compatibility spelling routes to canonical target behavior, emits one
  actionable warning in human mode and a structured deprecation in JSON, remains through 1.x, and
  is removable no earlier than 2.0 with release-note notice.
- **N — new:** absent from 0.7.0 and introduced only in the named implementation phase.
- **R — remove:** current syntax intentionally absent from 1.0. There are no R items in the accepted
  surface; every current spelling is K, A, C, or D.

Compatibility rules:

1. A C item changes atomically with its command tests and help; there is no interval where the flag
   parses but silently retains an undocumented/no-op behavior.
2. A D item cannot recompute a different operation set from its canonical replacement. JSON remains
   one valid value and carries deprecation metadata rather than a stderr-only warning.
3. Stable A aliases are included in help/completion beside the canonical name; they are not counted
   as separate workflow concepts.
4. Any breaking JSON shape increments that command's schema version. Additive fields retain the
   version only when old consumers can safely ignore them; human formatting is not a JSON contract.
5. Commander negated booleans (`--no-verify`, `--no-prompt`) receive explicit defaults and
   global/local collision tests; consolidation never changes the user's spelling accidentally.

#### 13.1.1 Global migration ledger

| Surface | Current 0.7.0 behavior/default | Disposition | 1.0 transition and final behavior | Owner |
|---|---|---|---|---|
| `-h, --help` | Commander help, exit 0 | K | Keep globally and per command; generated grouping/suggestions come from target registry | Phase 1; EWP-CMD-HELP-TS01..06 |
| `-V, --version`; `version` | Both print package version | K/A | `version` remains canonical command and `-V/--version` global alias; no discovery | Phase 1; EWP-CMD-HELP-TS07 |
| repeatable `-v, --verbose` | Parsed globally, default 0; not uniformly consumed | C | One inherited level consumed by every command; `-v` detail, `-vv` trace; conflicts quiet/debug as Section 8.20 defines | Phase 1; EWP-P1-TS01 |
| `-q, --quiet` | Parsed globally, default false; not uniformly consumed | C | Suppress non-error human output everywhere without hiding diagnostics; conflict with verbose/debug | Phase 1; EWP-P1-TS01 |
| `--color <auto\|always\|never>` | Current global default `auto`; pre-action sets environment | C | Keep spelling/default, add consistent NO_COLOR/TTY/JSON rules and conflict handling | Phase 1; EWP-P1-TS01 |
| `--no-color` | Absent | N | Exact alias for `--color never`; conflicting explicit color modes exit 2 | Phase 1; EWP-P1-TS01 |
| `-C, --cd <dir>` | Parsed globally with `.` default but not consistently consumed | C | Resolve once into EWP-CF-022 `ProjectContext` before every discovery or relative path | Phase 1; EWP-P1-TS01, EWP-WF14 |
| `--debug` | Parsed globally, default false; propagation incomplete | C | Trace/stack context on stderr only; never corrupt JSON; conflicts quiet | Phase 1; EWP-P1-TS01, EWP-WF15 |
| `--config <file>` | Absent | N | Select explicit legacy config or canonical defaults layer below CLI and above discovery; never grants desired-state ownership | Phase 1; EWP-P1-TS02, EWP-CMD-CONFIG-TS03 |
| `--no-prompt` | Absent globally; repeated as local negated/no-op option on install/uninstall/dev/promote | C | Consolidate into one functional global option; same existing spelling remains accepted after subcommands and disables interaction without approval | Phase 1; EWP-P1-TS01, EWP-WF15 |

#### 13.1.2 Existing command migration ledger

Every argument and option in the 0.7.0 introspection snapshot appears below. “Shared C” means the
command also adopts functional global context/output/project behavior without redeclaring globals.

| Command | K/A — retained current surface | C/D/R — behavioral migration | N — target additions | Owner |
|---|---|---|---|---|
| `agents` | K: `-t, --tool <name>` repeatable, `--detected-only`, `--format <markdown\|json>` | C: tool validation uses four-tool capability matrix; shared globals. R: none | `--json` format alias, `--capabilities` | Phase 1/3A; EWP-CMD-AGENTS-TS01..03 |
| `config get <key>` | K: required key, `--scope <user\|project\|system>`, `--json` | C: shared context and source reporting. R: none | `--user`, `--project`, `--system` sugar | Phase 1/2; EWP-CMD-CONFIG-TS01..05 |
| `config set <key> <value>` | K: required key/value, `--scope <user\|project\|system>` | C: default user layer and project writes migrate through lossless unified schema. R: none | scope sugar, `--json` | Phase 1/2; EWP-CMD-CONFIG-TS01..05 |
| `config list` | K: `--scope <user\|project\|system>`, `--json` | C: effective values always name source layer; shared context. R: none | scope sugar | Phase 1/2; EWP-CMD-CONFIG-TS01..05 |
| `config unset <key>` | K: required key, `--scope <user\|project\|system>` | C: missing key becomes explicit exit-0 no-op; project writes use the same atomic legacy migration as set. R: none | scope sugar, `--json` | Phase 1/2; EWP-CMD-CONFIG-TS01..05 |
| `list [glob...]` | A: `ls`. K: variadic glob, `-t/--tool`, `-s/--scope`, `--user`, `--project`, `--system`, `--managed`, `--duplicates`, `-l/--long`, `--json`, `--enabled`, `--disabled`, `--unconfigured` | C: shared project context, deterministic compact output, complete JSON, corrected duplicate identity. R: none | `--mode`, `--source`, `--revision`, `--verified`, `--unverified`, `--description` | Phase 1/3A; EWP-CMD-LIST-TS01..07 |
| `commands [glob...]` | K: variadic glob, `-t/--tool`, `-s/--scope`, `--user`, `--project`, `-l/--long`, `--json`, `--enabled`, `--disabled`, `--unconfigured` | C: shared project context and unambiguous “installed slash commands” labeling. R: none | none | Phase 1/3A; EWP-CMD-COMMANDS-TS01..04 |
| `doctor` | K: `-t/--tool`, `-s/--scope`, `--user`, `--project`, `--system`, `--offline`, `--strict`, `--json` | C: deterministic finding model and shared context. R: none | `--file`, `--lockfile`, `--all-tools`, `--fix`, `--dry-run`, `--yes` | Phase 1/6; EWP-CMD-DOCTOR-TS01..06 |
| `check` | K: `-t/--tool`, `-s/--scope`, `--user`, `--project`, `--system`, `--json` | C: errors fail by default. D: `--exit-code` becomes redundant compatibility for default gating through 1.x. R: none | `--file`, `--lockfile`, `--all-tools`, `--report-only` restores explicit report-only exit 0 | Phase 1; EWP-CMD-CHECK-TS01..05 |
| `verify <path>` | K: required path, `-t/--tool`, `--static`, `--deep`, `--strict`, `--json` | C: shared globals; deep means static+deep for Claude and Codex with capability-aware exits. R: none | none | Phase 1/6; EWP-CMD-VERIFY-TS01..04 |
| `promote [skill...]` | K: current variadic name/path target, `--all`, `-t/--tool`, `--strict`, `--no-verify`, `--allow-dirty`, `--dry-run`, `--json` | C: argument grammar becomes target-or-all with no empty widening; `--yes` performs real bulk approval; local `--no-prompt` consolidates globally. D: `--rollback` routes to `undo` through 1.x. R: none | `-s/--scope`, `--user`, `--project`, `--continue-on-error` | Phase 3B/5; EWP-CMD-PROMOTE-TS01..06 |
| `dev [skill...]` | A: `demote`. K: current variadic name/path target, `--all`, `-t/--tool`, `--source <path>`, `--dest <path>`, `--strict`, `--no-verify`, `--dry-run`, `--json` | C: argument grammar becomes target-or-all with no empty widening; `--yes` performs real bulk approval; local `--no-prompt` consolidates globally. D: `--rollback` routes to `undo` through 1.x. R: none | `-s/--scope`, `--user`, `--project`, `--continue-on-error` | Phase 3B/5; EWP-CMD-DEV-TS01..06 |
| `install <source...>` | A: `i`. K: variadic required source, `-t/--tool`, `-s/--scope`, `--user`, `--project`, `--ref <git-ref>`, `--pin`, `--direct`, `-f/--force`, `--strict`, `--no-verify`, `--deep`, `--continue-on-error`, `--dry-run`, `--json`, `-y/--yes`, `--no-prompt` | C: source becomes credential-free remote identity; HTTP(S) credentials and currently accepted file URLs refuse; literal input never persists. Force becomes bounded; pin writes exact intent; deep covers both adapters; yes approves known bulk work; local no-prompt consolidates; default saves manifest+lock. R: none | `--file`, `--lockfile`, `--no-save`, `-p/--path` | Phase 2/3B/4A; EWP-CMD-INSTALL-TS01..08 |
| `uninstall <skill...>` | A: `rm`, `remove`. K: variadic required skill, `-t/--tool`, `-s/--scope`, `--user`, `--project`, `--all-scopes`, `-f/--force`, `--dry-run`, `--json`, `-y/--yes`, `--no-prompt` | C: force becomes a bounded selected-removal override; yes performs real destructive/bulk approval; local no-prompt consolidates globally; default becomes ownership-first manifest+lock save. R: none | `--file`, `--lockfile`, `--no-save`, `--continue-on-error` | Phase 3B/4A; EWP-CMD-UNINSTALL-TS01..07 |
| `completion <shell>` | K: required `bash\|zsh\|fish` argument and emit-only stdout | C: generated content expands with target commands/options; remains non-mutating. R: none | none in 1.0; installer is P3-06 | Phase 6; EWP-CMD-COMPLETION-TS01..06 |
| `help [topic]` | K: optional command/topic argument and command help | C: add workflow topic, five-group information architecture, primary-question/common-workflow/grouped-option help, and unknown-name suggestions without autocorrection. R: none | none | Phase 1/6; EWP-CMD-HELP-TS01..06 |

#### 13.1.3 New command ledger

These commands are wholly N relative to 0.7.0. Their exact syntax remains single-sourced in
Section 8.20; this table owns introduction phase and validation, not a duplicate grammar.

| New command | Target purpose and surface reference | Introduction owner | Validation owner |
|---|---|---|---|
| `status [skill...]` | Correlate selected artifacts, ledger, and live state; targetless selected-context default, artifact/tool/scope filters, check, JSON | Phase 3A | EWP-CMD-STATUS-TS01..06, EWP-WF02, EWP-WF11, EWP-WF14 |
| `init` | Create canonical project/user manifest selected by file/scope/tool defaults; force, dry-run, and JSON | Phase 4A | EWP-P4A-TS04, EWP-CMD-INIT-TS01..05, EWP-WF03 |
| `export` | Classify live state and safely create/merge a portable pair; artifact/tool/scope, strict, force, dry-run, JSON | Phase 4A | EWP-CMD-EXPORT-TS01..09, EWP-WF04 |
| `plan` | Pure desired/current preview; artifact/tool/scope, locked, prune, check, redacted portable/machine-bound saved output, force, JSON | Phase 4B | EWP-CMD-PLAN-TS01..12, EWP-WF06..08 |
| `apply` | Fresh approved or exact saved-plan execution/validation; artifact/plan/tool/scope, locked, prune, saved dry-run/check, local binding checks, approval, batch, JSON | Phase 4B | EWP-CMD-APPLY-TS01..14, EWP-WF06..08 |
| `sync [skill...]` | Direct from/to reconciliation; targetless endpoints bound all source entries; force, delete, optional save/artifacts, preview, approval, batch, JSON | Phase 5 | EWP-CMD-SYNC-TS01..10, EWP-WF10 |
| `update [skill...]` | Mutation target-or-all; targetless check-only bounded default; artifacts/tool/ref/pin/strict/approval/batch/JSON | Phase 5 | EWP-CMD-UPDATE-TS01..10, EWP-WF09 |
| `undo [skill...]` | Required target-or-all abort/reversal; never guess latest; tool/user-project scope/preview/approval/batch/JSON | Phase 5 | EWP-CMD-UNDO-TS01..09, EWP-WF11, EWP-WF14 |
| `gc` | Ledger-bounded store cleanup; dry-run, age, repeatable forget-project, approval, JSON | Phase 5 | EWP-CMD-GC-TS01..08, EWP-WF12 |

#### 13.1.4 Closed-ledger gates

- Live introspection must contain exactly the current side above until its owning phase migrates it.
- Each phase update moves a row from current to target atomically with code, help, deprecation data,
  and EWP tests; the historical 0.7.0 snapshot remains in version control for audit.
- EWP-OPT-TS01..10 compare option types, choices, repeatability, defaults, global permutations,
  conflicts, mutation/prompt/JSON/exit behavior, and generated help—not names alone.
- No target option may be implemented without a ledger disposition, and no current option may
  disappear without A/C/D/R treatment. The accepted 1.0 ledger contains zero R items.
- Current JSON goldens are captured before behavior migrations. Breaking target schemas increment
  their schema version and are cross-linked from the owning EWP-CMD test.

### 13.2 Cross-command consistency

**Status:** closed at command-semantics level. EWP-CF-024 closes scope-aware target selection,
EWP-CF-025 closes force authority, EWP-CF-026 closes batch scheduling, EWP-CF-031 closes
zero-target/bounded-default behavior and selection provenance, and EWP-CF-040 closes uniform
manifest/lock override availability, EWP-CF-041 closes init preview/operation consistency,
EWP-CF-042 closes saved-plan preview/check modes, and EWP-CF-043 closes the shared non-mutating
mode matrix. Artifact write/lock, migration, portability, and redaction proof is completed by
closed Section 13.3.

| Axis | Shared go-forward contract | Explicit command-specific distinction | Closure evidence |
|---|---|---|---|
| Tool | Repeatable selector uses one known-name/capability validator; unknown is 2, known unsupported capability is 4 | Read commands may include Kilo/OpenCode; mutation is Claude/Codex until P3 | EWP-CF-007, EWP-P1-TS03 |
| Scope/target | Scope filters before unique-name/path/history resolution; ambiguity never mutates | Config permits system layer; readable commands may include system/managed; live mutations use user/project | EWP-CF-022, EWP-CF-024, EWP-WF14 |
| `--all` axes | Means all values on the command's primary target axis and conflicts positional targets | `--all-tools` expands detection axis; uninstall `--all-scopes` expands matching scope axis; names remain explicit | Section 8.20, EWP-OPT-TS03 |
| Zero targets | Required-selection mutators exit 2; empty/unmatched never widens; valid filter-to-zero is explained no-op; provenance always named | Status/plan/apply/sync/GC use bounded contexts; update-check alone has safe targetless exception | EWP-CF-031, EWP-OPT-TS06 |
| `--force` | Overrides one named selected conflict and never another safety boundary | Per-command authority is install/uninstall/init/export/plan/sync only | EWP-CF-025, EWP-OPT-TS04 |
| Approval | Yes approves a fully determined displayed executable set and conflicts dry-run/check; no-prompt only asserts no interaction; ambiguity still refuses | Exact saved plan is prior authorization and rejects yes; non-mutating modes never accept approval | D-014, EWP-CF-023, EWP-CF-043, EWP-WF15 |
| Strict/gates | Strict promotes warning/inconclusive to failure; no-verify explicitly skips and records; deep conflicts no-verify | Export strict promotes nonportable skips; doctor strict promotes warning findings | Section 8.20.1, per-command gate tests |
| Preview/check | Dry-run is non-mutating and returns 0; check is non-mutating and returns 7 only after successful drift evaluation; both conflict and validate before I/O | Init previews one manifest operation; plan check cannot write out; health check has report-only semantics; saved apply validates exact operations with 0/7 and stale state 3 | EWP-CF-004, EWP-CF-041..043, EWP-OPT-TS10, EWP-CMD-PLAN-TS07/11 |
| Locked/prune/delete | Locked forbids resolution drift; prune/delete are opt-in destructive selection and fingerprint complete sets | Prune reconciles undeclared selected artifact scope; sync delete reconciles extra destination entries | D-015, EWP-P4B-TS04, EWP-CMD-SYNC-TS06 |
| Save/no-save | Save changes portable desired state only where contracted; no-save explicitly requests a live-only change whose drift is measured later | Install/uninstall save by default and opt out; sync is live-only by default and opts into destination save | D-006, D-007, EWP-WF02, EWP-WF10 |
| JSON | Exactly one versioned stdout value with stderr diagnostics; human verbosity never changes schema | Breaking schema increments version; deprecated syntax is structured metadata | EWP-CF-023, EWP-WF15 |
| Batch | Deterministic groups/pairs, fail-fast default, explicit later-group continuation, nonzero failure preserved | Saved-plan apply rejects continuation; single-group commands omit the flag | EWP-CF-026, EWP-WF13 |
| Artifact pair | File selects a sibling lock by default; advanced lockfile requires explicit file, is never persisted, and every pair consumer reports/reuses the same explicit context | Init is manifest-only; no-save and unsaved sync reject selectors; saved-plan apply uses its recorded pair | EWP-CF-003, EWP-CF-040, EWP-OPT-TS08, EWP-WF04 |
| Artifact writers | One selected pair and shared coordinator prevent command-local write engines | Exact manifest/lock atomicity, hashing, and recovery proof is Section 13.3 work | EWP-CF-001, EWP-CF-003, EWP-CF-005, EWP-CF-012; Section 9 |
| Undo/GC retention | Undo eligibility and GC reachability use the same retained before-state/journal/store references | GC forget removes local registration only and recalculates; it never invokes undo | EWP-CF-016, EWP-WF11, EWP-WF12 |

No additional cross-command recommendation remains after CF-043 and this matrix. Any later
contradiction found while closing complexity or architecture reopens this section explicitly and
receives a new finding.

### 13.3 Artifact consistency

**Status:** closed. EWP-CF-027 closes versioned hash domains and canonical inputs; EWP-CF-028 closes
local-ledger evolution, corruption handling, and project-registration ownership; EWP-CF-029 closes
the legacy project-config-to-manifest transition; EWP-CF-030 closes portable-path, source-identity,
saved-plan portability, and secret-redaction boundaries; EWP-CF-040 closes custom pair selection.

| Axis | Closed contract | Evidence |
|---|---|---|
| Responsibilities | Manifest desired state, lock portable resolution, plan reviewed operations, ledger local state | Sections 2.1..2.4; D-003..D-004 |
| Pair location | Sibling-derived by default; explicit advanced lock override requires file, is invocation-only, uniformly selectable, and exactly reported | EWP-CF-003, EWP-CF-040, EWP-OPT-TS08, EWP-P2-TS02 |
| Hash/canonicalization | Versioned domain-separated inputs and canonical generated bytes | EWP-CF-027; EWP-P2-TS01/03..04 |
| Portable paths/secrets | Canonical credential-free identity, portable path grammar, recursive canary gate | EWP-CF-030; EWP-P2-TS07; EWP-P4B-TS07 |
| Saved-plan safety | Scoped state preconditions, exact execution, explicit portability, local binding checks | EWP-CF-009; EWP-CF-027; EWP-CF-030; EWP-WF07 |
| Current migration | Structural project-file migration and versioned local-ledger migration | EWP-CF-028..029; EWP-P2-TS06; EWP-P3B-TS04 |

No additional artifact-consistency recommendation remains after this matrix. A later contradiction
reopens the section explicitly and receives a new finding.

### 13.4 Complexity budget

**Status:** closed. EWP-CF-031 closes ambiguous zero-target behavior without adding commands or
options. EWP-CF-032 proves that every retained/new top-level command answers one distinct primary
question, has a bounded minimal invocation, and remains approachable through five-group root help
and progressive but complete command help.

| Group | Command | Exclusive primary question | Minimal invocation |
|---|---|---|---|
| Discover | `agents` | Which coding tools are detected and what can Skillsmith do with them? | `skillsmith agents` |
| Discover | `list` | Which skills are installed? | `skillsmith list` |
| Discover | `commands` | Which slash commands are installed? | `skillsmith commands` |
| Discover | `status` | How do desired, locked, ledger, and live states relate? | `skillsmith status` |
| Manage | `install` | How do I acquire and persist a remote skill? | `skillsmith install <source>` |
| Manage | `uninstall` | How do I remove a skill and its desired-state declaration? | `skillsmith uninstall <skill>` |
| Manage | `update` | How do I check or apply source revision changes? | `skillsmith update --check` or `update <skill>` |
| Manage | `undo` | How do I abort or reverse a selected retained operation? | `skillsmith undo <skill>` |
| Develop | `dev` | How do I use a local checkout as the live development source? | `skillsmith dev <skill> --source <path>` |
| Develop | `verify` | Is this skill or plugin valid for the selected tools? | `skillsmith verify <path>` |
| Develop | `promote` | How do I snapshot a development placement into managed state? | `skillsmith promote <skill>` |
| Declarative | `init` | How do I create or migrate the desired-state file? | `skillsmith init` |
| Declarative | `export` | How do I capture the current fleet as portable desired state? | `skillsmith export` |
| Declarative | `plan` | What would convergence change? | `skillsmith plan` |
| Declarative | `apply` | How do I execute the reviewed convergence plan? | `skillsmith apply` |
| Declarative | `sync` | How do I reconcile one live location into another? | `skillsmith sync --from <A> --to <B>` |
| Maintain | `doctor` | What is unhealthy and what deterministic repair is available? | `skillsmith doctor` |
| Maintain | `check` | Are blocking machine/project health checks passing? | `skillsmith check` |
| Maintain | `gc` | Which unreachable local store objects can be reclaimed? | `skillsmith gc` |
| Maintain | `config` | What defaults are active and how do I change them? | `skillsmith config list` |
| Maintain | `completion` | How do I emit completion for a shell? | `skillsmith completion zsh` |
| Maintain | `version` | Which Skillsmith version is running? | `skillsmith version` |
| Maintain | `help` | How do I learn a command, topic, or workflow? | `skillsmith help workflows` |

Overlap proofs:

- List is inventory; status is desired/observed correlation; commands is slash-command inventory.
- Agents is tool capability discovery; doctor is diagnosis/repair; check is the automation health
  gate; verify validates a skill/plugin artifact.
- Install acquires remote state; dev links local state; promote snapshots that development state.
- Export converts live state to portable artifacts; sync reconciles two live locations.
- Plan previews convergence; apply executes it; update advances source resolution within intent.
- Uninstall removes selected desired/live state; undo reverses retained operation history.
- GC reclaims unreachable immutable local storage and never repairs, uninstalls, or edits portable
  desired state.

Progressive command help is generated in this order: primary question, usage, two or three runnable
common workflows, targets/scope, source/destination/artifacts, behavior/verification,
safety/approval, automation/output, and inherited globals. Every supported option appears exactly
once with defaults/conflicts/destructive effects/exits beside its owning family. Advanced options
are separated but not hidden; completion remains complete. Aliases stay beside canonical names.
There is no help-all flag, convenience-alias expansion, or artificial namespace. Except for
relational dev-source and sync endpoints, normal single-resource workflows require no optional
flags; explicit bulk/destructive/strict/automation authority is intentional rather than ergonomic
overhead.

No additional complexity-budget recommendation remains after this matrix. A later overlap or flag
expansion reopens this section and receives a new finding.

### 13.5 Quality and architecture review buckets

**Status:** closed. EWP-CF-033 preserves the good core/CLI precedent while removing duplicated
command-local application runtimes. EWP-CF-034 replaces the overbroad environment dependency with
capability-scoped effects and a compatible migration. EWP-CF-035 separates immutable observation and
pure planning from repository writes and coordinator transactions. EWP-CF-036 makes the validated
tool-adapter registry the single executable capability authority. EWP-CF-037 makes versioned codecs
the sole wire-contract authority and separates public DTOs from domain models. EWP-CF-038 adds one
typed operation-scoped observation boundary without displacing durable journals. EWP-CF-039 closes
executable validation ownership and exact-SHA release promotion. This review bucket is closed; any
later architecture contradiction receives a new finding rather than silently reopening one.

- Following good precedent.
- Following bad precedent requiring old and new refactor.
- Breaking precedent intentionally or accidentally.
- Introducing a new pattern requiring explicit justification.

Every finding is walked individually: accept, modify, skip, or mark intentional. Accepted findings
amend this plan before implementation.

### 13.6 Whole-plan design-review closeout

**Status:** the conversational decision review, accepted-finding backfill, and manual plan-integrity
audit were closed and approved on 2026-07-11. No product decision or finding remains open. At that
design closeout, the Phase 0 executable gates were still open. As of 2026-07-12, documentation
drift, the structural validator, catalog/checklist, executable ownership, and G0-01..G0-05 sign-offs
are closed. Whole-phase adversarial review, catalog recording of standing approval, and exit passed
on 2026-07-12.

- Finding completeness: EWP-CF-001..043 each has one register row, one traceability row, accepted
  go-forward behavior, saved example, affected contracts, validation, and date; `audited=43` and
  `failures=0`.
- Identifier integrity: 65 phase tasks, 61 phase tests, 157 command tests, 10 option gates, 16
  workflows, 16 decisions, and 43 findings have no duplicate definitions, undefined references, or
  malformed IDs.
- Command closure: 23 normative commands equal 23 five-group help entries and partition exactly
  into 14 live commands plus 9 new commands. Every command-test family exists.
- Current-program closure: live Commander command, alias, argument, option, choice/default, and
  global surfaces map to the Section-13.1 current ledger with no unmatched command/argument/option;
  Section 8.20 remains the exact target.
- Cross-command/artifact closure: target selection, force, batch, zero-target behavior, artifact
  pairing/override, init preview, fresh/saved apply, and non-mutating option modes are explicit;
  manifest/lock/plan/ledger responsibilities and writers are non-overlapping and versioned.
- Phase closure: Phases 0..7 each have entry and exit gates; Phase 7 is explicitly outside 1.0.
- Hygiene closure: stale counts/markers and superseded logger/artifact language are absent;
  `git diff --check` passes and the direct untracked-file diff check emits no diagnostics.

This section records the original manual planning-artifact and current-to-target consistency result.
The Phase 0 executable evidence is recorded in `projects/p17/evidence/` and the live catalog;
it does not imply that future commands, tests, recipes, distributions, or release gates are
implemented. Those proofs remain owned by their named phases and may advance only when each exit
gate passes.

---

## 14. Completion criteria for this planning project

This plan is fully articulated only when:

- D-001..D-016 are resolved and recorded;
- every P0-P3 item remains represented or is explicitly rejected with rationale;
- every retained command and option has a contract and test slice;
- every implementation slice has unit/integration ownership;
- EWP-WF01..EWP-WF16 are complete and internally consistent;
- current-program drift ledger is closed against live Commander introspection and the Section-8.20
  target, with no missing disposition/phase/test owner;
- the section-level documentation drift ledger is designed and assigned to Phase 0;
- cross-command/artifact/complexity checks pass;
- architecture/quality findings are resolved;
- phases have explicit entry/exit gates and no circular dependencies;
- every validation ID has one planned catalog owner, tier, and executable target, and the phase
  contracts require active/completed targets to exist, execute, and reject skipped required tests;
- canonical `just check` and `just release-check` recipes gate PR and exact-SHA publication, with
  every declared distribution and required live-tool compatibility represented;
- the final plan receives explicit user approval before implementation.

**Design approval:** accepted by the user on 2026-07-11. The product contract and manual review are
complete; the following Phase 0 mechanical closeout is also complete as recorded below:

- [x] Produce and close the section-level documentation-drift ledger.
- [x] Implement and pass the plan/catalog/checklist structural validator.
- [x] Seed every tracked entity into the machine-readable verification catalog with one primary
  owner, tier, dependency group, executable target, and evidence state.
- [x] Generate the exhaustive human checklist and prove deterministic round-trip parity.
- [x] Run and close the independent adversarial Phase 0 review.
- [x] Record standing Phase 0 approval and sign-off before Phase 1 begins.

P17 owns this execution through `projects/P17-GOAL.md` and `projects/p17/EXECUTION.md`; progress and
evidence are never inferred from this design-approval statement.

P14 remains blocked until P17 Phase 6 and its final sign-off pass. Phase 7 remains deferred and is
not part of P17 or the Skillsmith 1.0 completion set.

---

## 15. Per-command validation registry

These IDs define the ranges referenced in Section 8. A command is not complete until its focused
tests pass, the relevant holistic workflow passes, and the repo's full gate passes.

### `agents`

- **EWP-CMD-AGENTS-TS01:** supported/unknown/repeated tool selection and exit semantics.
- **EWP-CMD-AGENTS-TS02:** detected-only and multiple-install classification in human output.
- **EWP-CMD-AGENTS-TS03:** JSON alias/schema plus the exact four-tool, per-operation capability
  matrix and mutation-refusal accuracy, derived byte-for-byte from the validated adapter registry.

### `list`

- **EWP-CMD-LIST-TS01:** compact default columns, grouping, stable ordering, empty state.
- **EWP-CMD-LIST-TS02:** long output includes path/origin/source/revision/store/verify/description.
- **EWP-CMD-LIST-TS03:** tool/scope/glob/mode/source/revision filters and combinations plus stable
  project-root discovery from root/nested/`-C`/worktree/symlink entry paths.
- **EWP-CMD-LIST-TS04:** duplicate identity, shadowing, and cross-tool non-duplicate regression.
- **EWP-CMD-LIST-TS05:** enabled/disabled/unconfigured exclusivity and display.
- **EWP-CMD-LIST-TS06:** versioned complete JSON independent of human verbosity.
- **EWP-CMD-LIST-TS07:** large-fleet performance and bounded default output.

### `status`

- **EWP-CMD-STATUS-TS01:** manifest-only, lock-only, ledger-only, live-only state products.
- **EWP-CMD-STATUS-TS02:** dev, pinned, store-linked, unmanaged, broken, and absent classification.
- **EWP-CMD-STATUS-TS03:** revision/content/source drift and verify-state reporting.
- **EWP-CMD-STATUS-TS04:** pending/committed journal, version-1 migration-pending without rewrite,
  legacy-journal compatibility, and exact recovery remediation.
- **EWP-CMD-STATUS-TS05:** target/tool/scope filters, cross-scope shadowing, and project identity
  agreement with install/list regardless of invocation subdirectory; targetless bounded context,
  unmatched target behavior, filter-to-zero, selection-source parity, and sibling/explicit custom
  artifact-pair selection with exact path reporting.
- **EWP-CMD-STATUS-TS06:** check exit and versioned JSON.

### `config`

- **EWP-CMD-CONFIG-TS01:** get/set/list/unset round trips at system/user/project with lossless
  comments/order/whitespace and permission preservation.
- **EWP-CMD-CONFIG-TS02:** CLI/env/project/user/system precedence and source labels.
- **EWP-CMD-CONFIG-TS03:** explicit config, `-C` project discovery, nested manifest versus live-root
  separation, non-Git fallback, and malformed layer errors.
- **EWP-CMD-CONFIG-TS04:** exact legacy read support and migration to D-003 in the same lossless
  project set/unset edit; canonical/mixed/empty/malformed/unknown discrimination; portable-value
  mapping, blocked nonportable values, 1.x warning/JSON metadata, and no-write read behavior.
- **EWP-CMD-CONFIG-TS05:** unknown keys/values/scopes and JSON output.

### `install`

- **EWP-CMD-INSTALL-TS01:** source grammar and ambiguity picker/noninteractive refusal, including
  canonical credential-free HTTPS/SSH/scp identity plus HTTP(S) userinfo/query/fragment and
  plain-HTTP/Git-protocol/`file://` refusal with credential-helper/HTTPS/SSH/dev remediation.
- **EWP-CMD-INSTALL-TS02:** auto/explicit tool detection and capability validation.
- **EWP-CMD-INSTALL-TS03:** scope/default/shadowing, shared project-root/ledger identity, and
  project-relative/home-relative path behavior: resolve relative input from effective cwd, serialize
  from project root/home, refuse escaping/nonportable default-save paths, and permit valid no-save.
- **EWP-CMD-INSTALL-TS04:** static/deep/strict/no-verify gate matrix.
- **EWP-CMD-INSTALL-TS05:** symlink/direct/ref/force/noop/update/repair actions plus pin rewriting
  manifest intent to the resolved SHA, direct placement to persistent copy intent, and bounded
  force replacement with edited-content backup.
- **EWP-CMD-INSTALL-TS06:** explicit-file/unique-owner/new-by-scope destination precedence,
  dual-owner exit-2 refusal with zero mutation, selected artifact-pair reporting, resolved
  declaration-group commit, per-tool partial placement behavior, and proof force cannot resolve
  ambiguity; explicit lock override requires file and no-save rejects both selectors; exact legacy
  project ownership adds a visible migrate-project-config prerequisite while mixed/nonportable
  shapes refuse before live or artifact mutation.
- **EWP-CMD-INSTALL-TS07:** no-save, dry-run, JSON, quiet, verbose, and error output contracts;
  execution-only force/strict/deep/no-verify/batch/approval/output never persist, while skipped
  verification remains a local ledger fact; yes conflicts dry-run before acquisition; no-prompt
  remains a valid assertion; literal source/authentication input never persists or renders.
- **EWP-CMD-INSTALL-TS08:** source-group fail-fast/continue, truthful partial results, SIGINT, and
  crash recovery with canary scans across nested/partial failure, journal, temporary, backup,
  ledger, human/JSON, and debug surfaces.

### `uninstall`

- **EWP-CMD-UNINSTALL-TS01:** name/path resolution and not-installed idempotence.
- **EWP-CMD-UNINSTALL-TS02:** tool/scope/all-scopes ambiguity and selection plus project identity
  agreement with install from different invocation subdirectories.
- **EWP-CMD-UNINSTALL-TS03:** managed/dev/unmanaged/edited-copy bounded force and backup safety,
  including source-checkout/store non-deletion.
- **EWP-CMD-UNINSTALL-TS04:** explicit or unique declaration-owner selection, dual-owner zero-write
  refusal, never-create-empty-manifest behavior, declaration/lock retention until all selected pair
  removals succeed, final artifact removal, explicit lock override requires file and conflicts
  no-save, and the distinction between creating an absent empty manifest and converting an existing
  legacy config to canonical defaults-only state.
- **EWP-CMD-UNINSTALL-TS05:** no-save, dry-run, force/confirmation independence, noninteractive,
  yes/dry-run conflict, no-prompt assertion, and JSON force-effect contracts.
- **EWP-CMD-UNINSTALL-TS06:** store-retention and undo eligibility.
- **EWP-CMD-UNINSTALL-TS07:** partial pair failure, crash/same-op resume, and opposite-op refusal.
  Multi-target default fail-fast and explicit continue preserve group results and nonzero exit.

### `dev`

- **EWP-CMD-DEV-TS01:** create/adopt/noop/mismatch/foreign/absent state machine.
- **EWP-CMD-DEV-TS02:** source/dest/name/path/tool/scope validation, unique unscoped inference,
  ambiguity and scope/path disagreement refusal, absent-create default scope, absolute recording,
  and target-or-all requirement with no empty/unmatched widening.
- **EWP-CMD-DEV-TS03:** static verify/strict/no-verify behavior.
- **EWP-CMD-DEV-TS04:** Pinned-to-dev and scoped bulk selection with canonical planned group policy.
  Covers exact confirmation, targets-plus-all refusal, and explicit-all/filter-to-zero metadata.
  Actual fail-fast/continue execution is replayed under EWP-P3B-TS03.
- **EWP-CMD-DEV-TS05:** Dry-run/JSON/rollback inverse-operation identity and pre-I/O approval conflicts.
  Covers yes/no-prompt refusal before discovery or I/O. Public undo equivalence is replayed with the
  G5 undo command tests.
- **EWP-CMD-DEV-TS06:** crash recovery and source/store retention.

### `promote`

- **EWP-CMD-PROMOTE-TS01:** dev/pinned/store-linked/unmanaged selection and convergence across
  explicit scope, unique name, exact path, ambiguous user/project, target-or-all, and unmatched
  no-widening cases.
- **EWP-CMD-PROMOTE-TS02:** clean/dirty/non-Git provenance and allow-dirty.
- **EWP-CMD-PROMOTE-TS03:** per-tool verify mode, strict, inconclusive, no-verify.
- **EWP-CMD-PROMOTE-TS04:** Scoped bulk and partial multi-tool planning with canonical group policy.
  Covers confirmation, targets-plus-all refusal, and explicit-all/filter-to-zero metadata. Actual
  fail-fast/continue execution is replayed under EWP-P3B-TS03.
- **EWP-CMD-PROMOTE-TS05:** Dry-run/JSON/rollback inverse-operation identity and pre-I/O approval conflicts.
  Covers yes/no-prompt refusal before discovery or I/O. Public undo equivalence is replayed with the
  G5 undo command tests.
- **EWP-CMD-PROMOTE-TS06:** content hash, store reuse, crash recovery, residue cleanup.

### `verify`

- **EWP-CMD-VERIFY-TS01:** plugin/bare-skill/missing/invalid target resolution.
- **EWP-CMD-VERIFY-TS02:** auto/explicit tools, absent tool, and Claude/Codex static-plus-deep
  capability coverage through adapter bundles, with Kilo/OpenCode unsupported modes returning the
  registry-defined capability result.
- **EWP-CMD-VERIFY-TS03:** strict severity and 0/1/2/4/130 exits.
- **EWP-CMD-VERIFY-TS04:** JSON/human/global-context and live-version matrix.

### `doctor`

- **EWP-CMD-DOCTOR-TS01:** detected default versus all-tools and tool capability checks.
- **EWP-CMD-DOCTOR-TS02:** scope/config/XDG/network offline checks using the same project context as
  mutation and inspection commands.
- **EWP-CMD-DOCTOR-TS03:** duplicate/legacy/multi-install/journal/manifest-lock findings, including
  missing versus empty/truncated/malformed/newer ledger, pending version-1 migration,
  exact legacy versus canonical/mixed/empty/malformed/nonportable project shapes, noncanonical lock
  bytes, and unknown hash schema/domain remediation through canonical regeneration rather than
  in-place byte repair, ambiguous normalization, or ledger reset; sibling and explicit custom pair
  selection diagnose the same bytes and report both paths.
- **EWP-CMD-DOCTOR-TS04:** strict and human/JSON exit semantics.
- **EWP-CMD-DOCTOR-TS05:** fix dry-run, deterministic ledger and exact-project-config migration,
  automatic-writer equivalence, safe repair allowlist, approval, failed-migration byte identity,
  yes/dry-run conflict before discovery, nonportable/manual-patch reporting, custom-pair exact write
  ownership, and ambiguous refusal.
- **EWP-CMD-DOCTOR-TS06:** remediation commands parse and target the finding; no standalone ledger
  or project-config migrate command is emitted.

### `check`

- **EWP-CMD-CHECK-TS01:** only error-class checks execute.
- **EWP-CMD-CHECK-TS02:** errors fail by default; report-only compatibility and conflict with the
  deprecated exit-code gate.
- **EWP-CMD-CHECK-TS03:** tool/scope/config and sibling/explicit custom artifact-pair selection
  matches doctor; lockfile requires file.
- **EWP-CMD-CHECK-TS04:** JSON and stable exit contracts in CI/non-TTY.
- **EWP-CMD-CHECK-TS05:** no network/advisory-warning noise unless explicitly requested.

### `init`

- **EWP-CMD-INIT-TS01:** default canonical manifest content at shared Git project root when in a
  repo and XDG user path otherwise, including nested-cwd invariance, paired-path reporting, and
  exact legacy lossless migration without force or lock creation.
- **EWP-CMD-INIT-TS02:** explicit file/scope/tool/default selections, including `--scope user`
  inside a repo, `--scope project` outside Git at effective cwd, explicit-file precedence, and proof
  that explicit artifact location does not rebase project placement.
- **EWP-CMD-INIT-TS03:** existing file refusal and force replacement limited to the exact manifest,
  with an explicit exact-legacy migration exception and sibling lock/live/ledger byte identity;
  canonical/mixed/empty/malformed/unknown files retain refusal/force behavior; force dry-run and
  execution use the same replace operation and do not require yes.
- **EWP-CMD-INIT-TS04:** dry-run/execution operation equality, atomic write/SIGINT/concurrent-writer
  refusal, and no lock/live/ledger or live-fleet import.
- **EWP-CMD-INIT-TS05:** human/JSON/help/completion output and immediate parse/plan compatibility.

### `export`

- **EWP-CMD-EXPORT-TS01:** managed remote install exports exact origin/resolution.
- **EWP-CMD-EXPORT-TS02:** clean Git dev placement converts to portable identity.
- **EWP-CMD-EXPORT-TS03:** dirty/non-Git/unmanaged classification and strict behavior.
- **EWP-CMD-EXPORT-TS04:** tool/scope/project/custom-path selection.
- **EWP-CMD-EXPORT-TS05:** compatible same-name cross-tool merge, incompatible
  source/ref/scope/tool conflicts, default refusal, and force-live resolution without deletion or
  nonportable/approval/selection bypass.
- **EWP-CMD-EXPORT-TS06:** safe merge preserves requested refs, comments/order, defaults, unselected
  declarations, byte-identical unchanged output, and exact legacy migration while refreshing valid
  lock resolution; a non-sibling lock requires file, is not persisted, and later direct calls must
  repeat both paths.
- **EWP-CMD-EXPORT-TS07:** dry-run/JSON/no-write behavior including migration preview and blocked
  mixed/nonportable state.
- **EWP-CMD-EXPORT-TS08:** absolute-path/secret scrub and portable schema gate; placement/path uses
  symlink/copy and project/home-relative tokens, while arbitrary absolute paths warn/skip or fail
  strict; credentials, file/store/ledger/dev paths, traversal, drive, and UNC forms never export and
  force cannot override portability.
- **EWP-CMD-EXPORT-TS09:** clean-machine locked round trip using canonical credential-free identity
  and zero local absolute paths/canaries in the portable pair.

### `plan`

- **EWP-CMD-PLAN-TS01:** empty/create/update/remove/move/adapt/migrate-project-config/
  migrate-ledger/noop operation rendering.
- **EWP-CMD-PLAN-TS02:** deterministic ordering and repeated-run byte equality.
- **EWP-CMD-PLAN-TS03:** manifest discovery, custom manifest/paired-lock derivation, filters,
  project-root versus artifact-path separation, config/artifact dual-role parsing, legacy
  configuration-only protection, whole-manifest bounded-default metadata, and
  positional/repeated-file refusal plus singular custom lock requires file and is exactly reported.
- **EWP-CMD-PLAN-TS04:** lock present/missing/stale/noncanonical, default resolve, locked refusal,
  semantic manifest correlation, and unknown hash schema/domain refusal.
- **EWP-CMD-PLAN-TS05:** bounded selected manifest, prune/delete visibility, filter-to-zero no-op,
  and cross-scope safety.
- **EWP-CMD-PLAN-TS06:** conflict/refusal/partial capability representation.
- **EWP-CMD-PLAN-TS07:** check 0/7, check/out/force conflicts before discovery/I/O, and remaining
  usage/environment exits.
- **EWP-CMD-PLAN-TS08:** human/JSON parity and summary counts.
- **EWP-CMD-PLAN-TS09:** saved-plan schema, owner permissions, create-only/force replacement,
  no-stdout artifact, options, redaction, scoped resource/set/capability preconditions, and executor
  compatibility; portable/machine-bound classification and reason codes; versioned domain golden
  hashes; recursive canary scan; force affects only the exact out path and is invalid otherwise.
- **EWP-CMD-PLAN-TS10:** no filesystem/ledger/manifest/lock mutation, including version-1 in-memory
  normalization plus project-config/ledger migration previews.
- **EWP-CMD-PLAN-TS11:** apply-dry-run and apply-check compatibility equivalence.
- **EWP-CMD-PLAN-TS12:** scale/performance on representative fleet.

### `apply`

- **EWP-CMD-APPLY-TS01:** fresh plan/display/confirm/execute pipeline.
- **EWP-CMD-APPLY-TS02:** rejection/cancel/no-prompt/yes behavior and no mutation.
- **EWP-CMD-APPLY-TS03:** idempotent unchanged application.
- **EWP-CMD-APPLY-TS04:** lock update and locked strictness.
- **EWP-CMD-APPLY-TS05:** fresh bounded-manifest/saved-exact selection, prune opt-in,
  filter-to-zero no-op, selected-scope protection, fresh custom-pair selection, and saved-plan
  rejection of file/lock overrides.
- **EWP-CMD-APPLY-TS06:** saved plan exact execution and exact dry-run/check validation without
  replanning; plan file and all state remain byte-identical in validation modes.
- **EWP-CMD-APPLY-TS07:** precise manifest/lock/resource/selection/capability stale-plan refusals,
  comment-only manifest validity, unrelated-state validity, unknown hash-version/domain refusal,
  saved project-config/ledger migration staleness after external migration, and executor
  compatibility plus portable-relative custom-pair and machine-bound absolute-path enforcement;
  saved validation returns state 3 rather than drift 7 for every stale/incompatible case.
- **EWP-CMD-APPLY-TS08:** operation dependency ordering and safe parallelism.
- **EWP-CMD-APPLY-TS09:** per-tool partial failure and rerun convergence.
- **EWP-CMD-APPLY-TS10:** version-1-to-2 migration followed by manifest/lock/ledger atomic commit,
  plus lossless legacy-project migration followed by manifest/lock/ledger atomic commit, with
  original-byte preservation and crash points through every migration/first-version-2 cleanup.
- **EWP-CMD-APPLY-TS11:** continue-on-error and exit precedence.
- **EWP-CMD-APPLY-TS12:** fresh and saved dry-run/check aliases, mutual exclusion, exact allowed/
  conflicting option matrix, fresh preview yes conflict, prior-authorization/no-yes behavior,
  no-prompt assertion, 0/7/3/error exits, and help.
- **EWP-CMD-APPLY-TS13:** human/JSON/quiet/verbose/SIGINT contracts.
- **EWP-CMD-APPLY-TS14:** real manifest with multi-tool, multi-scope, source reuse, portable
  cross-machine identity, machine-bound refusal, and zero credential/local-path leakage.

### `sync`

- **EWP-CMD-SYNC-TS01:** from/to grammar for scopes and paths plus targetless bounded-endpoint and
  explicit-target provenance.
- **EWP-CMD-SYNC-TS02:** user->project and project->user reconciliation.
- **EWP-CMD-SYNC-TS03:** project-A->project-B and -C semantics.
- **EWP-CMD-SYNC-TS04:** tool/scope filtering, unmatched target/filter-to-zero behavior,
  selection-source parity, and capability refusal.
- **EWP-CMD-SYNC-TS05:** selected destination conflicts, bounded force replacement,
  edited/unmanaged backup, force/confirmation independence, yes/dry-run conflict, and stable
  human/JSON effect fields.
- **EWP-CMD-SYNC-TS06:** delete opt-in and exact removal plan, including proof force never implies
  delete or expands its selection and targetless/empty matches never imply deletion.
- **EWP-CMD-SYNC-TS07:** save destination manifest/lock under safe merge even when live force is
  supplied, including an exact-legacy destination migration prerequisite; file/lock selectors
  require save, lock requires file, and the selected pair is exactly reported.
- **EWP-CMD-SYNC-TS08:** dry-run/JSON/source byte-identity and destination migration preview with
  mixed/nonportable refusal; force/delete/batch remain meaningful together while yes conflicts.
- **EWP-CMD-SYNC-TS09:** idempotence/partial failure/continue behavior.
  Assert invocation-level abort, later-group skipped markers, continuation, cancellation, and
  nonzero failure exit.
- **EWP-CMD-SYNC-TS10:** equivalence to planner operations, no duplicate engine.

### `update`

- **EWP-CMD-UPDATE-TS01:** candidate discovery for branches/tags/explicit refs.
- **EWP-CMD-UPDATE-TS02:** moving/fixed/exact candidate policy, `--ref` tracking transition, and
  `--ref --pin` exact-intent transition.
- **EWP-CMD-UPDATE-TS03:** target/all/tool selection, mutation target-or-all requirement,
  target-plus-all refusal, unmatched/filter-zero handling, and selection-source metadata.
- **EWP-CMD-UPDATE-TS04:** targetless check bounded-default, equivalent all-check, targetless
  dry-run refusal, check/dry-run and check/yes conflicts, meaningful ref/pin/strict/batch check, and
  no-write behavior.
- **EWP-CMD-UPDATE-TS05:** verify/strict/deep policy reuse.
- **EWP-CMD-UPDATE-TS06:** new lock-intent commit and per-tool live/ledger drift consistency across
  sibling and explicit custom pair selection; lockfile requires file and is not persisted.
- **EWP-CMD-UPDATE-TS07:** prior-store retention and undo.
- **EWP-CMD-UPDATE-TS08:** offline/fetch/ref failure, partial tools, and default
  fail-fast/explicit-continue declaration-group scheduling.
- **EWP-CMD-UPDATE-TS09:** confirmation/JSON/exit contracts including preview yes rejection and
  no-prompt assertion before discovery/I/O.
- **EWP-CMD-UPDATE-TS10:** manifest requested-ref preservation, explicit tracking change, and
  pin-to-SHA policy plus source-content tree sensitivity to bytes, executable mode, entry type,
  safe symlink target, and empty directories with cross-platform-equivalent digest fixtures.

### `undo`

- **EWP-CMD-UNDO-TS01:** pending transaction abort and before-state restoration for every operation
  family across explicit scope, unique unscoped inference, ambiguous user/project history, and
  preserved version-1 pair journals; targetless invocation never guesses latest.
- **EWP-CMD-UNDO-TS02:** committed promote/dev/install/uninstall reversal where retention permits,
  with identical-name cross-scope isolation.
- **EWP-CMD-UNDO-TS03:** update reversal and lock restoration.
- **EWP-CMD-UNDO-TS04:** pending precedence plus stale/unrestorable expected-state refusal.
- **EWP-CMD-UNDO-TS05:** status labeling and relationship between abort and same-op resume.
- **EWP-CMD-UNDO-TS06:** target/tool/scope/all selection across user+current-project history, exact
  target-or-all requirement, target-plus-all/unmatched refusal, filter-zero no-op, exact bulk
  confirmation, provenance, and deterministic fail-fast/continue history-group scheduling.
- **EWP-CMD-UNDO-TS07:** dry-run/JSON/no-write behavior including yes conflict, no-prompt assertion,
  and zero-target exit 2 before plan or discovery.
- **EWP-CMD-UNDO-TS08:** rollback alias behavioral equivalence/deprecation.
- **EWP-CMD-UNDO-TS09:** migration/undo ordering, crash during either operation, and repeated
  convergence without losing legacy recovery state.

### `gc`

- **EWP-CMD-GC-TS01:** reachability from live placement and ledger as the bounded-default set with
  explicit selection-source reporting.
- **EWP-CMD-GC-TS02:** version-2 project-registration/no-crawl ledger authority, missing-project
  protection, version-1 migration behavior, and proof arbitrary portable locks/saved plans are not
  local store leases.
- **EWP-CMD-GC-TS03:** journal, backup, undo-window retention.
- **EWP-CMD-GC-TS04:** age threshold and boundary timestamps.
- **EWP-CMD-GC-TS05:** exact byte accounting and store/adapted overlays.
- **EWP-CMD-GC-TS06:** dry-run/execution eligible-set equality, yes conflict before ledger reads,
  no-prompt assertion, and explained filter-to-zero no-op.
- **EWP-CMD-GC-TS07:** forget-project exact-path/current/existing/journal refusals plus
  confirmation/noninteractive/JSON contracts.
- **EWP-CMD-GC-TS08:** crash/idempotence and zero reachable deletion invariant.

### `commands`

- **EWP-CMD-COMMANDS-TS01:** compact/long/JSON rendering and ordering.
- **EWP-CMD-COMMANDS-TS02:** tool/scope/glob/enabled-state filters plus shared project-root
  invariance from nested invocation paths.
- **EWP-CMD-COMMANDS-TS03:** invalid capability/input exits.
- **EWP-CMD-COMMANDS-TS04:** plugin/standalone provenance and large-fleet behavior.

### `completion`

- **EWP-CMD-COMPLETION-TS01:** all 23 root commands and adjacent aliases for bash/zsh/fish,
  independent of five-group visual presentation.
- **EWP-CMD-COMPLETION-TS02:** recursive config subcommands.
- **EWP-CMD-COMPLETION-TS03:** every inherited and local flag regardless of common/advanced help
  grouping.
- **EWP-CMD-COMPLETION-TS04:** enum choice completion from registries.
- **EWP-CMD-COMPLETION-TS05:** local skill/path/manifest completion without network; empty target
  completion never injects all or widens selection.
- **EWP-CMD-COMPLETION-TS06:** generated shell syntax validation, help-only manual install
  instructions, package-manager placement, and proof the CLI never edits shell startup/config files.

### `help` and `version`

- **EWP-CMD-HELP-TS01:** root and `help workflows` use
  Discover/Manage/Develop/Declarative/Maintain, include every public command once, place
  dev/verify/promote together and doctor/check under Maintain, and show aliases beside canonical
  names.
- **EWP-CMD-HELP-TS02:** every significant command has usage/options/examples/exits, including
  one exclusive primary question, common workflows before grouped complete options, stable family
  order, and truthful target-or-all versus bounded-default grammar.
- **EWP-CMD-HELP-TS03:** workflows/manifest/lock/plan/source/environment/scope topics are current.
- **EWP-CMD-HELP-TS04:** typo suggestion for commands/topics without unsafe autocorrection.
- **EWP-CMD-HELP-TS05:** examples parse, reference valid options, and preserve zero-target/bulk
  semantics without suggesting accidental mutation; all 23 minimal invocations reach their intended
  primary workflow.
- **EWP-CMD-HELP-TS06:** no stale milestone/internal-only canonical references, four-group wording,
  help-all flag, convenience-alias expansion, or artificial namespace.
- **EWP-CMD-HELP-TS07:** version subcommand and -V agree with package/release metadata.
