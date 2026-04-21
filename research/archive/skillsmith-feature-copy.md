# SkillSmith — Feature List (from Research)


## 2. Cross-Tool Adaptation

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 2.2 | **Compat-path fallback** — when possible, install to a path that multiple tools will read (e.g., a path both Kilo and Claude Code recognize) | MVP | Kilo Code pattern; reduces duplication across tools that converge on SKILL.md. | add | Not in spec. Worth adopting as an adapter-level optimization — one symlink into the store from a shared path when tools converge. Low risk. | — |

## 3. Scope & Attribution

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 3.5 | **Scope precedence visualization** — show the resolution order (project > user > system) and any shadowing | P2 | Addresses the contradictory Claude Code scope-shadowing bugs (issues #44207 and #33733). | merge (partial) | `doctor` surfaces cross-scope duplicates (§4.6 mockup) and `list --duplicates` flags them — but neither shows the explicit resolution/shadowing order per skill. | **Why the gap:** spec defines scope semantics (§1.2, §1.3) but never renders the resolution chain in a single view. The data is all present; no view exists. **Should adopt:** yes, at P2 — add to `list --long` or to `skillsmith why <skill>` (3.4) rather than a new verb. Zero new data; only a rendering change. |


## 4. Manifest, Lockfile, Apply

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 4.9 | **Version qualifier in identifier:** `user/repo/skill@version` | MVP | Continue.dev pattern. Needed even in MVP because Git refs exist (tags, branches, SHAs). | merge (partial) | Spec provides the functionality via `--ref <git-ref>` and `--pin` flags (§1.4, §3.2) but not the `@version` suffix in the shorthand itself. | **Why the gap:** spec chose flag-form (`--ref`/`--pin`) over suffix sugar because (a) Git refs can contain characters that collide with parser precedence (§1.4's 4-form shorthand), and (b) flags keep the source ref one-piece-per-concept. **Should adopt:** yes, as sugar — Phase 2 extend the parser to accept `owner/repo/skill@ref` as equivalent to `owner/repo/skill --ref ref`. Not worth the parser-precedence risk in MVP. |

## 5. Sync

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 5.4 | **Never sync user prefs into project/container scopes** — hard guardrail | MVP | VS Code learned this the hard way; bake it in from day one. | add | Not explicit in spec. Recommendation: add as a documented `sync` guardrail — refuse `sync --from user --to project` for values overrides and user-level config. Low-risk addition to §1.12 / §3.3. | — |


## 6. Discovery & Registries

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 6.4 | **Partial/sparse clones** by default for large skill repos | P2 | lazy.nvim pattern; reduces disk and network overhead. | promote | Spec has partial clones MVP (§1.4: `--filter=blob:none` / `--depth=1`). Promote to MVP per spec. | — |
| 6.6 | **Install telemetry → public leaderboard** | P3 | Vercel `skills.sh` discovery pattern. Privacy concerns; opt-in only. | add | Not in spec. Keep as P3; orthogonal to core CLI. | — |
| 6.7 | **Search/browse command:** `skillsmith search <query>` | P2 | Currently no cross-registry search exists; awesome-lists aren't programmatic. | add | Not in spec; would slot alongside `list` in §2. Depends on a registry surface being wired (blocked on 6.3 plugins). | — |
| 6.8 | **Bridge to existing marketplaces** — Claude plugin marketplaces, Smithery skills, Kilo marketplace, Copilot `awesome-copilot` | P2 | Meet users where they are; avoid demanding re-publication. | add | Not in spec. Fits the pluggable-registry surface (§1.17) — each marketplace is a registry client. | — |


## 7. Lifecycle Hooks

| # | Feature | Phase | Why | Merge Path | Notes / Conflicts | Gap Analysis |
|---|---|---|---|---|---|---|
| 7.1 | **Pre-/post- install, update, uninstall hooks** in skill manifests | P2 | Directly requested in Claude Code issues #30138 and #11240. Helm/npm prior art. | promote | Spec has hooks MVP (§1.13, §0.5.9) with full pre/post matrix, `--no-hooks`, documented env. Promote to MVP per spec. | — |
| 7.3 | **Orphan cleanup on uninstall** — remove config entries, cache dirs, symlinks | P2 | Issue #11240 specifically asks for this. | promote | Spec's content-addressed store + symlinks (§1.11) gives clean uninstall in MVP (symlink removal + store GC when no other symlink refs; `--direct` uses file-list tracking). Promote to MVP per spec; richer cleanup (cache dirs outside store) remains P2. | — |
