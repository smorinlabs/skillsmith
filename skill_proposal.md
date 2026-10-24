# Skillsmith skill lifecycle proposal

**Status:** Design recommendation. The commands in the recommended table are proposals, not implemented behavior. This document does not authorize repository, FloxHub, or release changes.

**Purpose:** Give Skillsmith a complete skill lifecycle that works without Flox and gains locked runtime dependencies, environment composition, and team sharing when Flox is available.

**Evidence snapshot:** Skillsmith `cd0715424d3a9ff12347dcec30f9a46eed9e6e27` on `feat/search-discovery`; local Flox `origin/main` `2b330deb6b2a278fec11119a716a5ef1f06a702a` (September 1, 2026). Flox's locally recorded ref may lag its remote. Official Flox and Agent Skills documentation was checked on September 23, 2026.

## Recommendation

Make a **skill environment** the user-facing declarative resource. It is a named, locked selection of skills, target agents, and requirements. A person, repository, or team can own one. A Flox-backed skill environment also refers to a Flox environment for packages and services. The same Skillsmith manifest and skill commands work without Flox.

Make **team** an explicit owner and discovery path. A team owns environments; creating an environment does not create a team. Add a PUBLISH group for versioned skill artifacts. Keep publishing a skill distinct from sharing an environment.

The proposed command paths use a resource followed by an action, as required by [CLI Design Standard v1.4.14, R1.1](https://github.com/smorinlabs/cli-standards/blob/9da70eb351e85ab4bbb1de0d7d3be7c57668b656/cli-design-standard.md). Keep existing flat commands as compatibility aliases during a migration.

## Terms and ownership

| Term | Meaning |
| --- | --- |
| Skill | A directory containing `SKILL.md` and optional scripts, references, or assets. |
| Skill environment | A Skillsmith manifest and lockfile that select skills, agent targets, and requirements. It may include another environment. |
| Flox environment | Flox's manifest and lockfile for packages, variables, services, builds, and composition. |
| Team | An owner namespace with shared environments, membership, and permissions supplied by its provider. |
| Placement | The files or links that make a selected skill discoverable by a target agent in a user or repository scope. |
| Runtime requirement | An executable, package, service, or other capability a skill needs when used. |

A team environment may be addressed as `acme/backend`, where `acme` is the owner and `backend` is the environment. An implementation must retain the provider identity as well when the same short reference could exist in Git and FloxHub.

## Original grouping: current Skillsmith

The following table reproduces the lifecycle group rows in the current [Skillsmith README](README.md). These are help headings, not command namespaces. All commands shown here exist today.

| Current group | Recommended name in README | Existing commands |
| --- | --- | --- |
| DISCOVER | Discover and inspect | `search`, `agents`, `list`, `commands`, `cross-tool-names`, `status` |
| MANAGE | Install, update, and remove | `install`, `update`, `uninstall`, `undo` |
| DEVELOP | Develop and verify | `dev`, `verify`, `promote` |
| DECLARATIVE | Reproduce and synchronize | `init`, `export`, `plan`, `apply`, `sync` |
| MAINTAIN | Configure and troubleshoot | `doctor`, `check`, `gc`, `config`, `completion`, `version`, `help` |

Aliases including `find`, `ls`, and `demote` are omitted from the table because they do not add distinct operations. The README's PUBLISH heading appears under **potential additions**, not in current help.

## New grouping: recommendation

The “existing commands” column assigns each of today's 25 canonical commands once. A path in the “proposed additions” column describes a future interface, not a command to run now. Help headings describe lifecycle jobs; canonical command paths use singular resource nouns.

| Proposed help group | Existing commands to retain or rehome | Proposed additions and canonical paths | User's job |
| --- | --- | --- | --- |
| DISCOVER | `search`, `agents`, `commands`, `cross-tool-names` | `skill search`, `skill view`, `agent list` | Find skills and inspect agent support or naming conflicts. |
| DEVELOP | `dev`, `promote` | `skill create`, `skill link`, `skill diff`, `skill snapshot`, later `skill try` | Create and iterate on an editable local skill, then freeze a local snapshot. |
| VALIDATE | `verify` | `skill verify`, `skill scan`, `skill test`; later `skill eval` for scored comparisons | Check format and native loading, report security findings, and test behavior. |
| PUBLISH | None | `release pack`, `release publish`, `release list`, `release view`; provider-specific `release deprecate` | Make a versioned skill artifact available through a defined destination. |
| INSTALL | `install`, `uninstall`, `update`, `undo`, `list`, `status` | `skill install`, `skill update`, `skill disable`, `skill enable`, `skill uninstall`, `installation history` | Manage discoverable local placements and recover from changes. |
| ENVIRONMENT | `init`, `export`, `plan`, `apply`, `sync` | `environment create`, `list`, `view`, `import`, `include`, `plan`, `apply`, `sync`, `push`, `pull`, `history`, `rollback` | Define, compose, reconcile, share, and recover a locked skill setup. |
| DEPENDENCY | None | `dependency add`, `remove`, `tree`, `why`, `check` | Declare and explain skill and runtime requirements. |
| TEAM | None | `team list`, `team view`, `team environment list`, `team policy view`; membership writes only where the provider supports them | Find a team's environments and understand access and required skills. |
| SYSTEM | `doctor`, `check`, `gc`, `config`, `completion`, `version`, `help` | `auth status` when remote providers require authentication | Configure and diagnose Skillsmith. |

This replaces the broad MANAGE, DECLARATIVE, and MAINTAIN help headings with INSTALL, ENVIRONMENT, and SYSTEM. It also moves `verify` out of DEVELOP so CI validation has a clear home.

## Team environment discovery

FloxHub organizations show environments owned by an organization and apply owner, writer, and reader permissions. In contrast, `flox envs` lists environments known to the local machine. Skillsmith should offer an explicit team inventory in the CLI. [Flox organizations](https://flox.dev/docs/concepts/organizations), [flox envs](https://flox.dev/docs/man/flox-envs).

These **proposed** commands illustrate the navigation, not runnable syntax:

```text
skillsmith team list
skillsmith team view acme
skillsmith team environment list acme
skillsmith environment view acme/backend
```

`team view acme` should include a short environment list immediately. `team environment list acme` should show the complete accessible inventory, with environment name, Git or Flox provider, skill count, supported agents, current locked revision or generation, and the viewer's access level. `environment view acme/backend` should show effective skills, each skill's origin, dependencies, and how to plan adoption.

A provider must enumerate environments the user may access. If a Git host or FloxHub integration cannot enumerate a team, Skillsmith should report that capability gap rather than present locally known environments as a complete team inventory.

### Composition and team policy

A team baseline such as `acme/base` can be included by `acme/backend`; a repository can select `acme/backend` and add project skills; a user can add personal skills. The plan must show the effective result and the source of each entry.

| Policy level | Recommended behavior |
| --- | --- |
| Required team skill | A user or project cannot disable or replace it without an authorized policy change. |
| Optional team default | A user or project may disable or override it when the target agent supports that operation. |
| Name collision | Refuse by default; display both origins and require an explicit permitted override. |
| Included environment update | Keep the pinned revision until an explicit upgrade and reviewed plan. |

Flox `[include]` provides ordered composition and explicit upgrades of included environments. Skillsmith still needs its own skill-level disable and team-policy rules. [Flox manifest reference](https://flox.dev/docs/man/manifest.toml).

## Development naming and missing commands

The current [`dev`](docs/commands.md) operation links an agent placement to an editable local source. The current `promote` operation changes that development placement into a pinned local snapshot. It does not publish the skill or advance a team release.

| Current name | Recommended canonical name | Meaning | Compatibility |
| --- | --- | --- | --- |
| `dev` and `demote` | `skill link` | Use a local checkout as the live development source; reuse the recorded source when returning from a snapshot. | Keep `dev` and `demote` as aliases. |
| `promote` | `skill snapshot` | Freeze the linked source into a managed local copy. | Keep `promote` as an alias. Reserve its plain meaning for a future reviewed team release transition. |
| `verify` | `skill verify` | Check skill structure and optional native agent loading. | Keep the existing flat command. |

Prioritize `skill create` for scaffolding and `skill diff` for comparing the editable source with a snapshot or published revision. Use `skill test` for repeatable examples with expected outcomes. Reserve `skill eval` for scored or repeated behavior comparisons. A temporary `skill try` is a later candidate because each agent's loader must support a reliable short-lived placement.

The author lifecycle is: create, link, edit, diff, verify, scan, test, snapshot, pack, and publish. `verify` is suitable for CI structure and loader checks; behavioral success requires a separate test or evaluation. [Current `verify` contract](docs/commands.md).

## One manifest, two ways to satisfy requirements

The Skillsmith manifest should declare skill identity, source revision, agent targets, placements, included environments, and typed requirements. The lockfile should record exact resolved skill and environment revisions. A Flox binding should record the Flox manifest or lock digest or hosted generation without duplicating Flox's entire package closure.

| Requirement type | Non-Flox environment | Flox-backed environment |
| --- | --- | --- |
| Another skill | Resolve, lock, place, and check it through Skillsmith. | Use the same Skillsmith resolution. |
| Executable or service | Check presence and version; report a missing or unknown requirement for manual setup. | Check the capability in the selected Flox environment. |
| Flox package | Show a provider-specific requirement without claiming it is installed. | Add or resolve it through Flox and lock the Flox environment. |

Skill-to-skill dependencies do not require Flox. Flox adds reproducible package resolution and runtime closure. The [Agent Skills specification](https://agentskills.io/specification) has human-readable compatibility metadata but no structured dependency field; machine-readable dependency edges therefore need a Skillsmith-owned contract.

A non-Flox manual installation can satisfy a requirement, but Skillsmith should label its provenance and reproducibility differently from a locked Flox package. Required unmet or unknown dependencies must appear in the plan. Applying a plan must not silently produce a skill that looks ready but cannot run.

## Import, sync, include, apply, and publish

| Operation | Recommended meaning |
| --- | --- |
| `environment import` | Adopt unmanaged skills or translate an external declaration into a Skillsmith manifest. |
| `environment export` | Capture current portable skill state as a manifest and lockfile; this exists today as `export`. |
| `environment sync` | Reconcile two explicit live locations. It copies a selected state; later source updates are not inherited. |
| `environment include` | Reference a pinned shared environment so updates can be reviewed and pulled in deliberately. |
| `environment plan` | Show exact skill, placement, dependency, and manifest changes; save a plan that can be checked for staleness. |
| `environment apply` | Execute the reviewed plan and materialize skills where selected agents discover them. |
| `environment push` / `pull` | Exchange a tracked environment with a remote provider, using its conflict and permission rules. |
| `release publish` | Distribute a versioned skill artifact. It is separate from pushing an environment. |

Current `sync` reads and writes local user or project endpoints and offers `--dry-run`; current `plan --out` and `apply --plan` cover manifest convergence. Cross-endpoint Flox or team sync needs an exact saved-plan contract that binds source revision, destination state, and authorization. [Current sync and plan reference](docs/commands.md).

### Proposed endpoint coverage

| Source and destination | Current status | Recommendation |
| --- | --- | --- |
| User ↔ repository | Existing local `sync` behavior | Preserve it and add a saved-plan route. |
| Repository ↔ local Flox-backed environment | Proposed | Update Skillsmith declarations; update Flox package requirements only when their mapping is explicit. |
| Team Git environment ↔ user or repository | Proposed | Read a pinned Git revision and preserve its team policy. |
| Team FloxHub environment ↔ user or repository | Proposed | Read a pinned generation and an associated Skillsmith manifest before planning placements. |
| Repository or user → remote team environment | Proposed | Reconcile a working environment first; publish it with a separate guarded `push`. |

A Flox environment's `[install]` package list alone does not identify its skills. The first integration should keep `skillsmith.toml` and `.flox/` together in a Git repository, with a lock binding between them. A later Flox package could carry a skill bundle for consumption from FloxHub without that repository. The first integration must prove that the selected skills load in Codex and Claude Code; Flox activation by itself does not establish agent discovery.

## Delivery sequence and acceptance cases

1. **Specify the model.** Define skill environment identity, owner, backend capability, manifest and lock schema, dependency edges, policy precedence, and exact plan format. This is a schema change from today's user/project-only manifest.
2. **Complete the portable lifecycle.** Add authoring, inspection, scanning, behavioral tests, disable and enable, local environment discovery, and saved sync plans. Verify this works without Flox.
3. **Create a Flox integration repository for the pilot.** Pair Skillsmith and Flox manifests, bind their locks, resolve package requirements through Flox, and prove agent discovery and cleanup for Codex and Claude Code.
4. **Add team discovery and sharing.** List accessible teams and environments, show permissions, include pinned team baselines, and implement guarded remote push, pull, history, and rollback where the provider supports them.
5. **Implement PUBLISH.** Define a reproducible skill artifact and its destinations before adding `release pack` and `release publish`. Flox package publication may be one destination after skill packaging and agent discovery are proven.

Acceptance scenarios should cover a non-Flox author and consumer, a Git-backed team, a Flox-backed team, user-to-repository sync in both directions, Flox-to-user and repository-to-Flox sync, an unmet manual requirement, a conflicting team override, a disabled optional skill, and recovery of a prior environment revision.

## Open implementation questions

- **Remote Flox skill payload:** Recommend the paired Git manifest first. Verify whether a Flox package can carry both skill files and a Skillsmith manifest for FloxHub-only use.
- **Team enumeration:** Verify that the chosen provider exposes a supported way to enumerate accessible environments. The FloxHub organization UI has this inventory, while `flox envs` is local.
- **Session-scoped use:** Determine whether each agent can load skills from a Flox-backed environment for one session without leaving persistent user or repository placements.
- **Release transition:** Define team release channels and approval rules before introducing a new command named `promote`.

## Sources

- [Skillsmith lifecycle groups](README.md) and [command reference](docs/commands.md), snapshot `cd0715424d3a9ff12347dcec30f9a46eed9e6e27`.
- [Skillsmith manifest types](packages/core/src/artifacts/types.ts), showing the current user/project scope and declaration fields.
- [Flox command groups](https://github.com/flox/flox/blob/2b330deb6b2a278fec11119a716a5ef1f06a702a/cli/flox/src/commands/mod.rs), [environment include reference](https://github.com/flox/flox/blob/2b330deb6b2a278fec11119a716a5ef1f06a702a/cli/flox/doc/manifest.toml.md), and [local environment listing](https://github.com/flox/flox/blob/2b330deb6b2a278fec11119a716a5ef1f06a702a/cli/flox/doc/flox-envs.md), checked against local `origin/main` `2b330deb6b2a278fec11119a716a5ef1f06a702a`.
- [FloxHub organizations](https://flox.dev/docs/concepts/organizations), [Flox manifest](https://flox.dev/docs/man/manifest.toml), and [Agent Skills specification](https://agentskills.io/specification).

**Next action:** Review the proposed environment identity and command names before turning this document into an implementation specification. Only the commands in the original grouping table and the “existing commands” column of the new grouping table are available today.
