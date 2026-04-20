# SkillSmith — Feature List (from Research)

> Compiled from the competitive research report. Each feature is tagged with a **phase** — `MVP`, `P2`, `P3`, or `Skeptical` (defer or reconsider) — and a brief **why** tying it to user evidence or competitor prior art.
>
> Phase recommendations are starting points for discussion, not commitments.

---

## 1. Install & Core CLI

| # | Feature | Phase | Why |
|---|---|---|---|
| 1.1 | **Tool-aware install** — correct path + format for Claude Code, Codex, Kilo Code | MVP | Core promise of the product; every competitor does this. |
| 1.2 | **Explicit flags:** `--tool {claude-code\|codex\|kilo-code}` and `--scope {system\|user\|project}` | MVP | Scripting use case. |
| 1.3 | **Directory override:** `--path <dir>` | MVP | Already in PRD. |
| 1.4 | **Target-tool install check** — detect if tool is installed; print install command if not, do not execute | MVP | Cleaner than Vercel/APM, which assume the tool is present. |
| 1.5 | **Interactive mode (default)** — detect installed tools, list them as primary, show not-installed alternatives separately, prompt for scope in Git repos | MVP | Already in PRD; lines up with Neon `add-mcp` auto-detect pattern. |
| 1.6 | **Multi-agent install in one command:** `-a <agent>` and `-a '*'` | MVP | Vercel `npx skills` ergonomics. Low cost, high UX win. |
| 1.7 | **Auto-install only to detected agents by default** | MVP | Neon `add-mcp` pattern — sensible default, reduces "skill installed to tool I don't use" confusion. |
| 1.8 | **Isolated per-skill directories with entry-point symlinks** — each skill lives under `~/.skillsmith/skills/<user>/<repo>@<sha>/`, symlinked into each tool's native dir | P2 | pipx-style isolation. Directly fixes Claude Code issue #30138 ("disable doesn't mean uninstall") and enables guaranteed-clean uninstall. |
| 1.9 | **Ephemeral run:** `skillsmith run owner/skill` — one-shot, no persistent install | P2 | `npx` / `uvx` / `pipx run` pattern. Useful for CI jobs and trial runs. |
| 1.10 | **First-run publisher prompt** — "You haven't installed from `unknown-author` before. Continue? [y/N]" | MVP | npm/npx anti-typosquat precedent; trust layer at lowest cost. |
| 1.11 | **`--dry-run` on every mutating command** | MVP | Table stakes for a tool that writes to multiple directories. |
| 1.12 | **`--yes` / `--no-input` for CI** | MVP | Scripting. |

## 2. Cross-Tool Adaptation

| # | Feature | Phase | Why |
|---|---|---|---|
| 2.1 | **Deterministic adapters per tool pair** (frontmatter rename, file layout, path mapping) | MVP | Already in PRD. Every shipping converter (`rule-porter`, `cursor-rules-to-claude`, Vooster) is deterministic. |
| 2.2 | **Compat-path fallback** — when possible, install to a path that multiple tools will read (e.g., a path both Kilo and Claude Code recognize) | MVP | Kilo Code pattern; reduces duplication across tools that converge on SKILL.md. |
| 2.3 | **"Read whatever exists" detection** — before installing, detect existing rule/skill files (`.cursorrules`, `CLAUDE.md`, `.clinerules`, etc.) and offer to extend rather than duplicate | P2 | Zed's priority-chain pattern; addresses the "Tower of Babel" pain directly. |
| 2.4 | **Kinded skill items** — support `kind: prompt \| agent \| instruction \| skill \| hook` in manifests so a single package can bundle multiple artifact types | P2 | GitHub Copilot plugin pattern; future-proofs as standards converge. |
| 2.5 | **`skillsmith import`** — read existing `.cursorrules`, `.clinerules`, `.windsurfrules`, `CLAUDE.md`, `.github/copilot-instructions.md` and emit canonical SKILL.md + AGENTS.md | P2 | High-leverage user-acquisition wedge; addresses #1 pain (Tower of Babel). |
| 2.6 | **LLM adapter fallback** (API-backed) for cases deterministic rules can't cover | **Skeptical** | Flagged in research: risky, hard to support, and the space of needed conversions is shrinking as AGENTS.md + SKILL.md consolidate under AAIF. Defer until concrete failing test cases exist. |

## 3. Scope & Attribution

| # | Feature | Phase | Why |
|---|---|---|---|
| 3.1 | **`skillsmith list`** across all scopes (system/user/project) grouped by tool | MVP | Already in PRD. |
| 3.2 | **Source-file attribution in `list`** — show which config file declared each installed skill | MVP | asdf `asdf current` pattern. Directly fixes Claude Code issue #8288 ("users can't tell if a skill is at local/project/user scope"). Low effort, high support-burden reduction. |
| 3.3 | **Cross-scope duplicate detection with `--force`** | MVP | Already in PRD. |
| 3.4 | **`skillsmith why <skill>`** — explain why a skill is active: scope, config source, activation triggers fired | P2 | Unique diagnostic; nothing in the market does this. |
| 3.5 | **Scope precedence visualization** — show the resolution order (project > user > system) and any shadowing | P2 | Addresses the contradictory Claude Code scope-shadowing bugs (issues #44207 and #33733). |

## 4. Manifest, Lockfile, Apply

| # | Feature | Phase | Why |
|---|---|---|---|
| 4.1 | **`skillsmith.toml`** — project manifest listing skills | MVP | Already in PRD. TOML choice is a minor differentiator vs. Vercel JSON / APM YAML. |
| 4.2 | **`skillsmith.lock`** — pinned `{user, repo, sha, manifest-hash}` + system fingerprint | MVP | Reproducibility; Cargo.lock / Brewfile.lock.json pattern. |
| 4.3 | **`apply`** — install missing, upgrade outdated | MVP | Already in PRD. |
| 4.4 | **`check`** — dry-run, exits non-zero on drift | MVP | Brewfile / Helm / ArgoCD pattern. Essential for CI pre-commit hooks. |
| 4.5 | **`cleanup`** — prune skills not in manifest, `--force`-gated | P2 | Brewfile `brew bundle cleanup` pattern. |
| 4.6 | **Values layering:** `values.toml` → user overrides → project overrides → env vars → `--set` flags | P2 | Helm pattern. Lets one skill manifest produce different behavior per environment. |
| 4.7 | **Skill inputs / secret refs** — `${{ inputs.foo }}` and `${{ secrets.bar }}` interpolation | P2 | Continue.dev `uses:` pattern; needed for skills that wrap paid services. |
| 4.8 | **Transitive skill dependencies** — skill A declares it requires skill B | P2 | APM pattern. |
| 4.9 | **Version qualifier in identifier:** `user/repo/skill@version` | MVP | Continue.dev pattern. Needed even in MVP because Git refs exist (tags, branches, SHAs). |
| 4.10 | **Compatibility ranges** — `requires: { claude-code: ">=1.2", codex: ">=0.3" }` | P2 | VS Code `engines` / JetBrains `since-build` pattern. |

## 5. Sync

| # | Feature | Phase | Why |
|---|---|---|---|
| 5.1 | **Cross-project sync, GA** — `skillsmith sync --from A --to B` | MVP | Already in PRD. Note: Vercel ships this as "experimental" — SkillSmith should launch it GA. |
| 5.2 | **Install-only-if-missing semantics** (no version diff) | MVP | Already in PRD. |
| 5.3 | **Cross-machine user sync** via optional account-backed storage | P3 | VS Code Settings Sync pattern. Orthogonal to team manifest (which lives in repo). |
| 5.4 | **Never sync user prefs into project/container scopes** — hard guardrail | MVP | VS Code learned this the hard way; bake it in from day one. |
| 5.5 | **Diff / merge / three-way sync** for same-skill-different-version | P2 | Non-goal for POC per PRD; noted for later. |

## 6. Discovery & Registries

| # | Feature | Phase | Why |
|---|---|---|---|
| 6.1 | **GitHub-style identifiers** — `user/repo/skill-name` | MVP | Already in PRD. |
| 6.2 | **Direct Git repo URLs as first-class source** | MVP | Already in PRD. Homebrew taps / lazy.nvim pattern — zero-infrastructure distribution. |
| 6.3 | **Pluggable registry clients** | MVP | Already in PRD. |
| 6.4 | **Partial/sparse clones** by default for large skill repos | P2 | lazy.nvim pattern; reduces disk and network overhead. |
| 6.5 | **Private registry support** with separate auth per registry | P2 | Cargo `[registries]` pattern; enterprise requirement. |
| 6.6 | **Install telemetry → public leaderboard** | P3 | Vercel `skills.sh` discovery pattern. Privacy concerns; opt-in only. |
| 6.7 | **Search/browse command:** `skillsmith search <query>` | P2 | Currently no cross-registry search exists; awesome-lists aren't programmatic. |
| 6.8 | **Bridge to existing marketplaces** — Claude plugin marketplaces, Smithery skills, Kilo marketplace, Copilot `awesome-copilot` | P2 | Meet users where they are; avoid demanding re-publication. |

## 7. Lifecycle Hooks

| # | Feature | Phase | Why |
|---|---|---|---|
| 7.1 | **Pre-/post- install, update, uninstall hooks** in skill manifests | P2 | Directly requested in Claude Code issues #30138 and #11240. Helm/npm prior art. |
| 7.2 | **User approval on first install for hook execution** — explicit consent since hooks run arbitrary code | P2 | Non-negotiable for security. |
| 7.3 | **Orphan cleanup on uninstall** — remove config entries, cache dirs, symlinks | P2 | Issue #11240 specifically asks for this. |

## 8. Activation Triggers *(key differentiator)*

| # | Feature | Phase | Why |
|---|---|---|---|
| 8.1 | **`activationFiletypes`, `activationKeywords`, `activationCommands`, `activationGlobs`** in SKILL.md frontmatter | P2 | lazy.nvim / VS Code `activationEvents` pattern. **Most underappreciated prior art in the research.** |
| 8.2 | **Client-side scope toggling** — enable/disable skill files in active scope based on cwd, open file, or command | P2 | Directly addresses Claude Code's own warning that description budgets get truncated when too many skills are installed. |
| 8.3 | **Context-window budget awareness in `list`** — show total frontmatter cost and warn when high | P2 | Translates abstract "too many skills" into concrete cost. |

## 9. Trust, Security, Verification *(key differentiator)*

| # | Feature | Phase | Why |
|---|---|---|---|
| 9.1 | **Signed releases / provenance attestations** | P2 | npm provenance precedent; directly addresses AuthZed CVE-2025-6514 class of supply-chain risk. |
| 9.2 | **Verified publisher tier** | P2 | Market differentiator no competitor fully owns. |
| 9.3 | **`skillsmith audit`** — diff installed tree against signed manifest hash | P2 | Catches tampering, drift, supply-chain attacks. |
| 9.4 | **Sandbox first-install scripts** | P2 | Hooks run arbitrary code; isolate on first execution. |
| 9.5 | **Supply-chain scanning** — Unicode-injection detection, known malicious patterns | P2 | APM parity; enterprise prerequisite. |
| 9.6 | **SBOM generation per install** | P2 | APM parity; compliance requirement for regulated buyers. |
| 9.7 | **`pack` / `unpack`** for air-gapped/offline delivery | P3 | APM pattern; large enterprise requirement. |
| 9.8 | **Risk scoring on `install`** — flag skills without signatures, with hooks, or with network-calling commands | P2 | Bridges the trust gap quoted in the research (Stacklok, Docker horror stories). |

## 10. Updates

| # | Feature | Phase | Why |
|---|---|---|---|
| 10.1 | **`skillsmith update <skill>`** that actually re-fetches | MVP | Counter to Claude Code issue #46081 ("already at latest" bug). Don't cache wrong. |
| 10.2 | **Explicit cache-busting when upstream SHA changes** | MVP | Same. |
| 10.3 | **Format-incompatibility detection on update** — warn before breaking | P2 | Counter to issue #37679 ("plugins no longer supported after upgrade"). |
| 10.4 | **Pinned vs. floating refs** — default to pinned SHA in lockfile, `--latest` to float | MVP | Standard package-manager hygiene. |

## 11. Doctor / Health

| # | Feature | Phase | Why |
|---|---|---|---|
| 11.1 | **`skillsmith doctor`** — agents detected, skill dirs writable, no orphans, manifest matches lockfile | MVP | Essential for cross-tool tool. Brew `doctor`, mise `doctor`, nvim `:checkhealth` prior art. |
| 11.2 | **Plugin-contributed healthchecks** — skills declare their own checks | P2 | nvim `:checkhealth` pattern; lets skill authors add custom validation. |
| 11.3 | **`check` command with `--exit-code` for CI** | MVP | Pre-commit / PR drift detection. |

## 12. CI & Enterprise Governance

| # | Feature | Phase | Why |
|---|---|---|---|
| 12.1 | **SARIF output** on lint/audit | P3 | APM parity; lets GitHub Code Scanning ingest SkillSmith findings. |
| 12.2 | **Org policy file** — `skillsmith-policy.toml` restricting allowed registries, skills, scopes | P2 | APM pattern; enterprise wedge. |
| 12.3 | **GitHub Rulesets / Actions integration** | P3 | APM pattern. |
| 12.4 | **Audit log** — record every install/update/uninstall with user, time, source | P2 | Compliance requirement; low effort. |

## 13. Authoring Support

| # | Feature | Phase | Why |
|---|---|---|---|
| 13.1 | **`skillsmith lint`** — validate SKILL.md, frontmatter, activation triggers, AGENTS.md | P2 | Build-to-Launch post: "59 broken references in my own 192-file setup." High value. |
| 13.2 | **`skillsmith test`** — dry-run a skill against a harness | P3 | Directly addresses the "skills silently fail" pain cluster. |
| 13.3 | **Skill scaffolding / templates** — `skillsmith init` | P3 | Out of scope for POC per PRD; reconsider if authoring becomes a wedge. |
| 13.4 | **Extension-pack meta-skills** — a skill that is just a list of other skills | P2 | VS Code `extensionPack` pattern; curated bundles. |

## 14. Import & Migration

| # | Feature | Phase | Why |
|---|---|---|---|
| 14.1 | **Import from `.cursorrules`, `.clinerules`, `.windsurfrules`, `CLAUDE.md`, `.github/copilot-instructions.md`** | P2 | Covered in 2.5; listed here for category completeness. User-acquisition wedge. |
| 14.2 | **Convert between formats** — bidirectional, deterministic | P2 | rule-porter prior art; useful standalone subcommand. |

## 15. MCP Awareness *(integration, not ownership)*

| # | Feature | Phase | Why |
|---|---|---|---|
| 15.1 | **Skill manifest can declare MCP server dependencies** | P2 | Skills often assume an MCP server exists; let the manifest express it. |
| 15.2 | **Delegate MCP install to existing tools** (Smithery, `npx add-mcp`) | P2 | Don't rebuild MCP install; partner with the incumbents. Research positions this as an alliance, not a competition. |

## 16. Future Adaptation Features *(noted, not committed)*

From the PRD, kept visible so they aren't forgotten:

| # | Feature | Phase | Why |
|---|---|---|---|
| 16.1 | Adapter plugin system — third parties contribute per-tool transforms | P3 | llm CLI pluggy pattern; unlocks new target tools without SkillSmith releases. |
| 16.2 | Bidirectional adaptation via canonical intermediate form | P3 | Cleaner architecture once 3+ target tools are supported. |
| 16.3 | Rule-firing reporting in adaptation | P3 | Debug aid. |
| 16.4 | Diff preview before writing | MVP | Low cost; fold into `--dry-run`. |

---

## Summary by Phase

**MVP (Day 1) — ~20 features**
Everything already in PRD **plus**: multi-agent flags (1.6), auto-detect default (1.7), first-run publisher prompt (1.10), `--dry-run` everywhere (1.11), source-file attribution in `list` (3.2), version qualifiers in identifiers (4.9), `check` command (4.4), never-sync guardrail (5.4), working `update` with cache-busting (10.1, 10.2, 10.4), `skillsmith doctor` (11.1, 11.3), diff preview in dry-run (16.4).

**Phase 2 — the differentiator bucket**
Isolated skill dirs + clean uninstall (1.8), compat-path fallback (2.2), existing-file detection (2.3), kinded items (2.4), `skillsmith import` (2.5), `why` command (3.4), cleanup + values layering + inputs + deps (4.5–4.8), compatibility ranges (4.10), diff sync (5.5), partial clones + private registries + search + marketplace bridges (6.4–6.8), **all of lifecycle hooks (7.x)**, **all of activation triggers (8.x)**, **all of trust/security (9.x)** except airgap pack/unpack, format-incompatibility warnings (10.3), plugin healthchecks + `check` (11.2), org policy + audit log (12.2, 12.4), lint + extension packs (13.1, 13.4), import (14.x), MCP awareness (15.x).

**Phase 3 — nice-to-have / enterprise / speculative**
Cross-machine sync (5.3), install telemetry/leaderboard (6.6), pack/unpack (9.7), SARIF + GH Rulesets (12.1, 12.3), test harness + scaffolding (13.2, 13.3), adapter plugins + canonical form + reporting (16.1–16.3).

**Skeptical — reconsider**
LLM adapter fallback (2.6).

---

## The Three Proposed Wedges

Per the research report, these three feature clusters are the most defensible differentiators:

1. **Trust & Signed Skills** — §9 as a whole. No shipping competitor does all of signing + SBOM + audit + sandbox.
2. **Activation-Triggered Lazy Loading** — §8 as a whole. lazy.nvim's most underappreciated idea. Directly compresses context-window cost.
3. **Scope-Aware Introspection + Lifecycle Hooks** — §3.2, §3.4, §7 together. Fixes the long tail of Claude Code scope and uninstall bugs that competitors have not addressed.

Anything else in this list is table stakes — necessary to ship, insufficient to win.
