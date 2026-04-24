# SkillSmith phases

This doc tracks **when** each SkillSmith feature ships. The sibling [`skillsmith-cli-design.md`](./skillsmith-cli-design.md) tracks **what** each feature is. Any statement here about design details is authoritative only for phasing; cross-reference the design doc for the full specification of any feature named below.

MVP is split into five releases (MVP-1 → MVP-5), each an end-to-end milestone that is shippable on its own. MVP-2 is further split into three sub-phases (MVP-2a → MVP-2c, staged simplest → most complex) so each 1–2-command slice can be validated in isolation. After MVP comes Phase 2, speculative Phase 3, and Phase 4 (npm publishing on top of the already-wired release-please automation).

**Supported agents across the CLI:** `claude-code`, `codex`, `kilo-code`, `opencode`. `agents` detects all four from MVP-1. `install` / `uninstall` / `list` / `doctor` target claude-code only in MVP-2, then extend to all four in MVP-3. Additional agents (Droid, Cursor, Aider, Cline, Continue — TBD) are Phase 2.

Sections: (1) non-goals, (2) MVP-1 inventory, (3) MVP-2 single-tool install (split into 2a config/completion, 2b list/doctor, 2c install/uninstall), (4) MVP-3 all-adapter coverage, (5) MVP-4 team workflows, (6) MVP-5 packaging extras, (7) Phase 2, (8) Phase 3 (speculative), (9) Phase 4 npm publishing, (10) open phasing questions.

---

## 1. Non-goals (MVP)

- **Semver version management and upgrade flows.** `install` and `sync` only add a skill if it is not already present at the destination; `--force` overwrites. `--ref` / `--pin` / content-addressed `<sha>` store paths (design doc §1.11) are install-time **identity**, not version management. `[compat]` ranges (design doc §1.14) land in MVP-5 as declarative refusal at install time; upgrade/resolution across alternatives is Phase 2.
- **LLM-based adaptation.** MVP uses deterministic rules only (design doc §1.16). An API-backed LLM fallback is Phase 2.
- **Security / trust layer.** Installing a skill ships instructions an agent will execute — a real trust surface. Out of scope for MVP.
- **Authoring tools.** SkillSmith installs and adapts skills; it does not scaffold new ones.
- **Runtime features.** No execution, sandboxing, or mediation — packaging/placement only.
- **GUI.** CLI-first.

---

## 2. MVP-1 — "What's on my machine?"

Smallest useful release. Pure inventory, no writes beyond the CLI's own config.

**Commands:** `agents`, `version`, `help`.

**Scope:**

- `agents` detects all four supported tools (`claude-code`, `codex`, `kilo-code`, `opencode`) at well-known locations per tool (PATH, brew, npm-global, app bundles, XDG dirs). `--tool` repeatable, `--detected-only`, `--format markdown|json`. Always exits 0 (inventory, not a gate). See [`commands/agents.md`](./commands/agents.md).
- Detection modules for all four tools are the same modules later reused by `doctor` (MVP-2) and `check` — one source of truth for "where does this tool live."
- Version-flag timeout hard-coded to 2s per detection attempt.
- `version` / `--version` / `-V` prints SkillSmith version.
- `help`, `help <topic>`, `--help` / `-h` on any command or the root (design doc §1.10).

**Explicitly deferred:**

- No `install`, `uninstall`, `list`, `sync`, `apply`, `doctor`, `config`, `completion` yet.
- No store, no symlinks, no adapters beyond detection.

---

## 3. MVP-2 — "Install a skill for one tool"

First release with write semantics, split into three sub-phases (MVP-2a → MVP-2c) staged simplest → most complex. Each sub-phase ships 1–2 commands that can be built and validated in isolation. All three remain **claude-code-only**; multi-agent coverage is MVP-3. After MVP-2c, a solo developer can install a skill end-to-end for claude-code, see what they've installed, and remove it.

### 3.1 MVP-2a — "Config and completion (support)"

Ships the two self-contained support utilities first, so the TOML config format and shell-completion plumbing exist before any state-modifying command is built against them.

**Commands added:** `config`, `completion`.

**Scope:**

- `config <get|set|list|unset>` for user config.
- `completion <bash|zsh|fish|powershell>` — static completions (subcommands, flag names, enum values) for commands that exist at each point; regenerated as later sub-phases add commands.
- TOML config file format + XDG-search-path resolution (`SKILLSMITH_CONFIG` honored). Config keys users set now (`tool`, `scope`, `path`, `registry`) persist and take effect once 2b/2c ship.
- Exit code 3 (malformed user config) wired.

**Explicitly deferred:**

- `list`, `doctor` (→ MVP-2b).
- `install`, `uninstall` (→ MVP-2c).
- No dynamic shell completions (→ Phase 2).

### 3.2 MVP-2b — "List and doctor (read path)"

Read-only observability. Ships before any writes so the `list` / `doctor` views are validated against an empty target first; both commands run cleanly against an empty install state.

**Commands added:** `list`, `doctor`.

**Scope:**

- `list` / `ls` with `--tool`, `--scope`, `--duplicates`, `--long`, `--json`. Reports empty until MVP-2c installs exist; `--duplicates` has nothing to surface yet.
- `doctor` validates config parse (from 2a), detected tools (all four via MVP-1 detection modules), scope writability for claude-code, manifest parse, network reach, cross-scope duplicates. `--strict`, `--offline`, `--json` (see [`commands/doctor.md`](./commands/doctor.md)).
- `--json` supported on `list` and `doctor` (design doc §6.2).
- Exit codes 0/1 finalized for read commands.

**Explicitly deferred:**

- `install`, `uninstall` (→ MVP-2c).
- List/doctor for `codex`, `kilo-code`, `opencode` (→ MVP-3).
- No `sync`, no `apply` (→ MVP-4).
- No `--direct`, no lifecycle hooks, no values layering, no meta-skills, no `[compat]` enforcement (→ MVP-5).

### 3.3 MVP-2c — "Install and uninstall (write path)"

The write path — introduces the content-addressed store, symlinks, source resolver, and the claude-code adapter. Paired because uninstall only exists to reverse install; validating them together confirms the install pipeline is clean. By this point 2a/2b already exist to observe and diagnose the writes.

**Commands added:** `install`, `uninstall`.

**Scope:**

- `install` / `uninstall` target **claude-code only**. Single adapter; no cross-tool adaptation path exercised.
- Source resolver: Git URL + GitHub shorthand (`owner/repo/skill-name`, `repo/skill-name`), 4-form parser (design doc §1.4). Partial-clone Git fetch.
- Content-addressed store at `$XDG_DATA_HOME/skillsmith/store/<owner>/<repo>@<sha>/<skill>/` with symlinked entry points (design doc §1.11).
- Scope flags: `--system` / `--user` / `--project`, `--scope`, scope auto-default (design doc §1.2, §1.3).
- Idempotence and cross-scope duplicate detection (design doc §1.5, §1.6). `--force`, `--yes`, `--dry-run`, `--ref`, `--pin`. `--all-scopes` on uninstall.
- Remaining exit codes 2/4/5/6/130 finalized.

**Explicitly deferred:**

- Install/uninstall for `codex`, `kilo-code`, `opencode` (→ MVP-3).
- No `sync`, no `apply` (→ MVP-4).
- No cross-tool adaptation; skills authored for a non-claude-code target install as-authored or are refused.
- No `--direct`, no lifecycle hooks, no values layering, no meta-skills, no `[compat]` enforcement (→ MVP-5).

---

## 4. MVP-3 — "All four adapters"

No new commands. The MVP-1 and MVP-2 commands extend across all four supported agents. After this release, every same-tool install path works for the full agent set.

**Added:**

- Install/uninstall adapters for `codex`, `kilo-code`, `opencode` (joining `claude-code` from MVP-2). Each adapter knows that tool's install paths per scope, expected frontmatter schema, file-layout conventions, and canonical install command (for the "tool not installed" hint, design doc §4.2).
- `list` state discovery extends to all four adapter paths at every scope.
- `doctor` exercises scope paths, writability, and version checks across all four tools.
- `agents` detection from MVP-1 is already broad; no change in this release.

**Scope stays same-tool-only:** installing a skill authored for agent A into agent A. Cross-tool adaptation (installing an agent-A skill into agent B) is MVP-5.

**Explicitly deferred:**

- No `sync`, no `apply` (→ MVP-4).
- No cross-tool adaptation, no packaging extras (→ MVP-5).

---

## 5. MVP-4 — "Team workflows"

Cross-scope sync and manifest-driven install, layered on top of MVP-3's full-coverage foundation. Teams can commit `skillsmith.toml` and have contributors converge across all four agents.

**Commands added:** `sync`, `apply`.

**Scope:**

- `sync` with `--from`, `--to`, `--delete`, `--dry-run`, `--tool`, `--scope`, `--force`, `--yes` (see [`commands/sync.md`](./commands/sync.md)). Works across all four adapters.
- `apply` reads `./skillsmith.toml` (walks up from CWD). Prints `created` / `updated` / `unchanged` / `skipped` per entry with aggregate counts (design doc §1.5). A single manifest may declare skills for any of the four tools.
- `apply --check` — drift detector for CI, exits non-zero on any would-create / would-update / would-delete.
- `apply --prune` — removes installed skills absent from the manifest.
- `apply --file` — repeatable, kubectl-style.
- Project manifest parsing and validation; malformed manifests exit 3.

**Explicitly deferred:**

- Packaging extras — hooks, values, meta-skills, `--direct`, `[compat]`, cross-tool adaptation — all MVP-5.

---

## 6. MVP-5 — "Packaging extras + cross-tool adaptation"

Rounds out the MVP feature matrix. No new commands; existing commands gain optional packaging flags and the cross-tool adaptation engine.

**Added:**

- Cross-tool adaptation engine (design doc §1.16): deterministic per-target-tool transformers for frontmatter renames, file layout changes, and known convention mappings (e.g., Claude Code's `allowed-tools` → Codex's `tools`). Enables installing a skill authored for agent A into agent B. `install --dry-run` shows adapted diff. `install --no-adapt` installs as-authored.
- Lifecycle hooks (design doc §1.13): `pre-install`, `post-install`, `pre-upgrade`, `post-upgrade`, `pre-uninstall`, `post-uninstall`. `--no-hooks` to disable.
- Values layering (design doc §1.12): 5-layer precedence (`--set` > env > project override > user override > skill default). Re-rendered on `sync`/`apply` when any layer changes.
- Meta-skills (design doc §1.15): `[meta] kind = "pack"` with transitive install.
- `--direct` escape hatch (design doc §1.11): file-copy install with recorded file-list manifest for clean uninstall.
- `[compat]` range enforcement (design doc §1.14): refuse install when tool version is outside range; exit 4. `--ignore-compat` for local experimentation, ignored by `apply`.

**Explicitly deferred:** all items below under Phase 2.

---

## 7. Phase 2

- **LLM adaptation fallback** — API-backed, opt-in, gated. Composes with the deterministic pass from MVP-5: deterministic first, LLM only for fields the deterministic pass leaves unresolved (design doc §1.16).
- **Version comparison and upgrade flows** — semver resolution, diff/merge across installed vs. declared `<sha>` (design doc §1.14).
- **Hosted primary registry; multi-registry config** — host a primary registry, keep direct Git URLs as first-class, allow additional registries via `registry.<name>` config entries (design doc §1.17, §8).
- **Additional tool adapters beyond the four MVP agents** — Droid, Cursor, Aider, Cline, Continue — TBD.
- **Conflict resolution beyond "skip if exists"** — diff, merge, prompt, layered on top of existing cross-scope detection (design doc §1.6).
- **Security / trust layer** for third-party skills.
- **Richer manifest features** beyond what MVP needs.
- **Scheme-prefixed source syntax** — `gh:acme/pack/skill`, `jsr:@acme/pack/skill`, `file:./path` (design doc §1.4, §5).
- **`--output yaml|table|text`** (design doc §1.9, §6.2) — only added if demand emerges.
- **Man-page generation** — auto-generated from the Cobra/clap command tree, shipped via Homebrew / apt / other packages. Inline help covers 95% of use cases in MVP (design doc §7).
- **Dynamic shell completions** — completions for skill names and source refs (they require network calls that slow shells) (design doc §7).

---

## 8. Phase 3 (speculative)

- GUI / IDE integration.
- Skill authoring helpers.
- Cross-tool usage analytics.

---

## 9. Phase 4 — npm publishing

Publishes the already-versioned packages to npm. Builds on the release-please pipeline landed in P06 (`release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release-please.yml`), which already handles Conventional-Commits → SemVer, rolling Release PR, root `CHANGELOG.md`, synchronized version bumps across root + `packages/cli/package.json` + `packages/core/package.json`, git tag (`vX.Y.Z`), and GitHub Release. Phase 4 adds **publish** to that same pipeline; nothing else about the release flow changes.

**Added:**

- Publish job in `.github/workflows/release-please.yml` gated on the action's `releases_created` output (`if: ${{ steps.release.outputs.releases_created }}`). Runs only when the Release PR merges, never on ordinary pushes.
- `bun publish` (or `npm publish --provenance --access public`) for both workspace packages. `bun publish` / `npm publish` both rewrite `workspace:*` to a concrete version at pack time, so the CLI's `@skillsmith/core` dep resolves correctly for npm consumers.
- `NPM_TOKEN` stored as a repo secret (automation token, not a personal token); `id-token: write` permission added to the publish job for npm provenance attestation.
- `@skillsmith/core` publishes as source — `"files": ["src", "README.md"]` is already in place; Bun/TS consumers can import directly.
- CLI publish strategy — **decision pending** (see open question below): either (a) publish source + Bun-runtime `bin` (zero transpile, requires Bun on the consumer), or (b) add a prepublish compile step producing a Node-compatible JS entry + `bin: { skillsmith: "./dist/index.js" }`.
- `publishConfig.access = "public"` on both package.jsons (required for the first publish of an unscoped name and for scoped packages in a free npm org).

**Scope:**

- First publish moves both packages from unpublished to `<current version>` on npm; subsequent releases publish whatever version release-please picked (patch/minor/major per the Conventional-Commits rules documented in `docs/releases.md`).
- Linked versioning from P06 is preserved: `skillsmith@X.Y.Z` and `@skillsmith/core@X.Y.Z` always ship together at the same version.
- No behavior change to MVP-1…MVP-5 or the Release PR — this phase is pure distribution plumbing.

**Explicitly deferred:**

- **Native-binary GitHub Release assets** (darwin-arm64, linux-x64 compiled via `bun build --compile`). Related but distinct: a separate workflow keyed off the release tag that uploads binaries to the GitHub Release. Tracked separately; not a blocker for npm publish.
- **Homebrew / apt / other package managers.** Downstream of native-binary artifacts.
- **Provenance signing via Sigstore beyond npm's built-in `--provenance`.**
- **Separate dist-tags** (`next`, `canary`) — everything publishes to `latest` until a pre-1.0 beta process is needed.

**Open questions:**

- **CLI distribution format on npm.** Ship source (Bun-runtime consumers only, simplest) or add a prepublish transpile step so `npm i -g skillsmith` works under Node? The current `bin` points at `./src/index.ts`, which only works under Bun. If the primary distribution channel becomes native binaries (via the deferred GitHub Release asset job), the npm publish of `skillsmith` may be demoted to "library-style — `@skillsmith/core` only" and the CLI package dropped from npm entirely.
- **Package name availability.** Confirm `skillsmith` and `@skillsmith/core` are available (or owned) on npm before first publish. If `skillsmith` is taken, fall back to `@skillsmith/cli`.
- **Pre-1.0 publish policy.** Publish every release from first merge, or hold npm publish until `1.0.0` and rely on native binaries + GitHub Releases until then? Deciding this determines whether Phase 4 lands before or after `1.0.0`.

---

## 10. Open phasing questions

- **Canonical install commands per supported tool.** The "tool not installed" error (design doc §4.2) hardcodes an install hint per target. Confirm the recommended one-liner for each of the four MVP tools (`claude-code`, `codex`, `kilo-code`, `opencode`).
