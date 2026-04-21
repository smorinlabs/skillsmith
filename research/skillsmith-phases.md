# SkillSmith phases

This doc tracks **when** each SkillSmith feature ships. The sibling [`skillsmith-cli-design.md`](./skillsmith-cli-design.md) tracks **what** each feature is. Any statement here about design details is authoritative only for phasing; cross-reference the design doc for the full specification of any feature named below.

MVP is split into five releases (MVP-1 → MVP-5), each an end-to-end milestone that is shippable on its own. After MVP comes Phase 2, then speculative Phase 3.

**Supported agents across the CLI:** `claude-code`, `codex`, `kilo-code`, `opencode`. `agents` detects all four from MVP-1. `install` / `uninstall` / `list` / `doctor` target claude-code only in MVP-2, then extend to all four in MVP-3. Additional agents (Droid, Cursor, Aider, Cline, Continue — TBD) are Phase 2.

Sections: (1) non-goals, (2) MVP-1 inventory, (3) MVP-2 single-tool install, (4) MVP-3 all-adapter coverage, (5) MVP-4 team workflows, (6) MVP-5 packaging extras, (7) Phase 2, (8) Phase 3 (speculative), (9) open phasing questions.

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

- `agents` detects all four supported agents (`claude-code`, `codex`, `kilo-code`, `opencode`) at well-known locations per agent (PATH, brew, npm-global, app bundles, XDG dirs). `--agent` repeatable, `--detected-only`, `--format markdown|json`. Always exits 0 (inventory, not a gate). See [`12-agents.md`](./12-agents.md).
- Detection modules for all four agents are the same modules later reused by `doctor` (MVP-2) and `check` — one source of truth for "where does this agent live."
- Version-flag timeout hard-coded to 2s per detection attempt.
- `version` / `--version` / `-V` prints SkillSmith version.
- `help`, `help <topic>`, `--help` / `-h` on any command or the root (design doc §1.10).

**Explicitly deferred:**

- No `install`, `uninstall`, `list`, `sync`, `apply`, `doctor`, `config`, `completion` yet.
- No store, no symlinks, no adapters beyond detection.

---

## 3. MVP-2 — "Install a skill for one tool"

First release with write semantics. A solo developer can install a skill end-to-end for claude-code, see what they've installed, and remove it.

**Commands added:** `install`, `uninstall`, `list`, `doctor`, `config`, `completion`.

**Scope:**

- `install` / `uninstall` / `list` / `doctor` target **claude-code only**. Single adapter; no cross-tool adaptation path exercised.
- Source resolver: Git URL + GitHub shorthand (`owner/repo/skill-name`, `repo/skill-name`), 4-form parser (design doc §1.4). Partial-clone Git fetch.
- Content-addressed store at `$XDG_DATA_HOME/skillsmith/store/<owner>/<repo>@<sha>/<skill>/` with symlinked entry points (design doc §1.11).
- Scope flags: `--system` / `--user` / `--project`, `--scope`, scope auto-default (design doc §1.2, §1.3).
- Idempotence and cross-scope duplicate detection (design doc §1.5, §1.6). `--force`, `--yes`, `--dry-run`, `--ref`, `--pin`.
- `list` / `ls` with `--tool`, `--scope`, `--duplicates`, `--long`, `--json`.
- `doctor` validates config, detected tools (still all four), scope writability for claude-code, manifest parse, network reach, cross-scope duplicates. `--strict`, `--offline`, `--json` (design doc §3.7, §4.5).
- `config <get|set|list|unset>` for user config.
- `completion <bash|zsh|fish|powershell>` — static completions (subcommands, flag names, enum values).
- Exit codes 0/1/2/3/4/5/6/130 wired.
- `--json` supported on `list` and `doctor` (design doc §6.2).

**Explicitly deferred:**

- Install/uninstall/list/doctor for `codex`, `kilo-code`, `opencode` (→ MVP-3).
- No `sync`, no `apply` (→ MVP-4).
- No cross-tool adaptation; skills authored for a non-claude-code target install as-authored or are refused.
- No `--direct`, no lifecycle hooks, no values layering, no meta-skills, no `[compat]` enforcement (→ MVP-5).
- No dynamic shell completions (→ Phase 2).

---

## 4. MVP-3 — "All four adapters"

No new commands. The MVP-1 and MVP-2 commands extend across all four supported agents. After this release, every same-tool install path works for the full agent set.

**Added:**

- Install/uninstall adapters for `codex`, `kilo-code`, `opencode` (joining `claude-code` from MVP-2). Each adapter knows that agent's install paths per scope, expected frontmatter schema, file-layout conventions, and canonical install command (for the "tool not installed" hint, design doc §4.3).
- `list` state discovery extends to all four adapter paths at every scope.
- `doctor` exercises scope paths, writability, and version checks across all four agents.
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

- `sync` with `--from`, `--to`, `--delete`, `--dry-run`, `--tool`, `--scope`, `--force`, `--yes` (design doc §3.3). Works across all four adapters.
- `apply` reads `./skillsmith.toml` (walks up from CWD). Prints `created` / `updated` / `unchanged` / `skipped` per entry with aggregate counts (design doc §1.5). A single manifest may declare skills for any of the four agents.
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

## 9. Open phasing questions

- **Canonical install commands per supported agent.** The "tool not installed" error (design doc §4.3) hardcodes an install hint per target. Confirm the recommended one-liner for each of the four MVP agents (`claude-code`, `codex`, `kilo-code`, `opencode`).
