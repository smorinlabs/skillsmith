# Skills install paths across Claude Code, Codex, opencode, and Kilo Code

All four tools now implement a "skills" concept, but their filesystem conventions diverge sharply. **Claude Code, Codex, opencode, and Kilo Code each support named, `SKILL.md`-based capability packages as of April 2026, yet only opencode honors XDG, only Claude Code localizes everything under a single `CLAUDE_CONFIG_DIR`, Codex has deprecated one of its own paths in favor of `~/.agents/skills/`, and Kilo Code ships two incompatible directory conventions simultaneously.** This matters because a naïve cross-tool installer that treats "user skills" as one path will miss at least half the targets.

Agent Skills emerged as a distinct primitive in October 2025 when Anthropic shipped them in Claude Code, then published the format as an open standard at agentskills.io in December 2025. OpenAI followed with experimental Codex support in late 2025 (feature-flagged, now GA), opencode landed native skills in v1.0.190 (PRs #5930/#6000), and Kilo Code adopted the standard across both its legacy VS Code extension and its new OpenCode-forked CLI. The result is a fragmented but partially interoperable landscape: three of the four tools additionally read `.claude/skills/` or `.agents/skills/` for cross-tool compatibility.

Below, each tool gets a dedicated section documenting every scope, every OS path, and every environment variable that influences skills discovery. A side-by-side matrix at the end is the quick-reference an installer's code should key off.

---

## Claude Code

Anthropic's Claude Code CLI loads skills from a **single `~/.claude/` convention on every OS** — there is no XDG fallback, no `~/Library/Application Support/` variant, and no `~/.config/claude/` alternative (third-party blog posts claiming otherwise are incorrect). Only one environment variable — `CLAUDE_CONFIG_DIR` — relocates the tree.

### Scopes

Anthropic's docs name four scopes plus a de-facto fifth:

- **Enterprise** (managed/org-wide)
- **Personal** (user-level / global)
- **Project** (repo-local)
- **Plugin** (bundled inside an installed plugin, auto-namespaced as `plugin-name:skill-name`)
- **Bundled** (ship inside the CLI binary — not installable to disk)

### Paths per scope per OS

| Scope | macOS | Linux (incl. WSL) | Windows (native) |
|---|---|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | `%USERPROFILE%\.claude\skills\<name>\SKILL.md` |
| Project | `<repo>/.claude/skills/<name>/SKILL.md` | same | `<repo>\.claude\skills\<name>\SKILL.md` |
| Plugin (on-disk cache) | `~/.claude/plugins/<…>/skills/<name>/SKILL.md` | same | `%USERPROFILE%\.claude\plugins\<…>\skills\<name>\SKILL.md` |
| Enterprise (managed settings file that drives provisioning) | `/Library/Application Support/ClaudeCode/managed-settings.json` | `/etc/claude-code/managed-settings.json` | `C:\ProgramData\ClaudeCode\managed-settings.json` |
| Added via `--add-dir <path>` | `<path>/.claude/skills/<name>/SKILL.md` | same | `<path>\.claude\skills\<name>\SKILL.md` |

Enterprise skill **content delivery** is not published as a fixed on-disk path — Anthropic provisions enterprise skills through managed-settings + MDM/server push rather than a canonical directory. Installers targeting enterprise distribution should drive through policy, not write to a guessed folder.

### Environment variables

**`CLAUDE_CONFIG_DIR`** is the only variable that relocates skills. Per Anthropic's `.claude` directory reference: *"If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead."* This replaces (does not merge with) the default base and applies to personal skills, plugin cache, everything. Project-level `.claude/skills/` is unaffected — it is always rooted at the project.

**Not honored:** `CLAUDE_HOME` (does not exist), `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, any `CLAUDE_SKILLS_DIR`. Feature requests anthropics/claude-code#22902 and #33957 asking for configurable skills paths remain open in April 2026.

### Precedence

Official docs state: **enterprise > personal > project**, with plugin skills immune because they're namespaced. Higher-priority scopes **shadow** lower ones on name collision; there is no merging. If a skill and a `.claude/commands/*.md` slash command share a name, the skill wins.

### Discovery

Claude Code scans at **session startup** across enterprise → personal → project → plugin → bundled, reading only YAML frontmatter into the system prompt (full SKILL body loads on invocation). There is **no parent-directory walk** toward `/` — but there is **nested auto-discovery** downward: when the session touches `packages/frontend/foo.ts`, Claude Code also scans `packages/frontend/.claude/skills/`. Adding or editing a `SKILL.md` in an already-watched directory takes effect mid-session, but creating a top-level `skills/` directory that didn't exist at startup requires a restart. The `/skills` command lists active skills; `${CLAUDE_SKILL_DIR}` is available inside skill scripts.

### Layout

Each skill is a directory named after the skill, containing `SKILL.md` at minimum plus optional `scripts/`, `references/`, and `assets/` subfolders. Double-nesting (e.g. `my-skill/my-skill/SKILL.md`) is a common unzip pitfall and fails.

---

## Codex (OpenAI Codex CLI)

Codex supports a first-class **"Agent Skills"** feature, documented at developers.openai.com/codex/skills. It is distinct from AGENTS.md, prompts, MCP, plugins, and subagents. The current canonical user path is **`~/.agents/skills/`** — not `~/.codex/skills/`, which is the now-deprecated legacy root that Codex still loads for back-compat.

### Scopes

| Scope | Intended use |
|---|---|
| **REPO** | Skills scoped to cwd and every ancestor directory up to the repo root |
| **USER** (current) | Per-developer skills across repos, at `$HOME/.agents/skills` |
| **USER** (deprecated) | Legacy path `$CODEX_HOME/skills`, default `~/.codex/skills`; still scanned |
| **ADMIN** | Machine/container-wide skills for all users |
| **SYSTEM** | Built-ins bundled with the Codex binary (e.g., `skill-creator`, `plan`) — not user-editable |

### Paths per scope per OS

| Scope | macOS / Linux | Windows |
|---|---|---|
| REPO | `<cwd>/.agents/skills/<name>/SKILL.md` (and every ancestor up to repo root) | `<cwd>\.agents\skills\<name>\SKILL.md` |
| USER (current) | `$HOME/.agents/skills/<name>/SKILL.md` | `%USERPROFILE%\.agents\skills\<name>\SKILL.md` *(inferred — not explicitly enumerated in Codex's skills doc; Codex's Windows home convention is `%USERPROFILE%\.codex`, verify before relying)* |
| USER (deprecated) | `$CODEX_HOME/skills/<name>/SKILL.md` → default `~/.codex/skills/...` | `%USERPROFILE%\.codex\skills\<name>\SKILL.md` |
| ADMIN | `/etc/codex/skills/<name>/SKILL.md` | Not documented on Windows |
| SYSTEM | `~/.codex/skills/.system/<name>/SKILL.md` (managed by Codex) | `%USERPROFILE%\.codex\skills\.system\<name>\SKILL.md` |

Codex does **not** use `%APPDATA%\codex\` anywhere. Open issues openai/codex#142 and #1980 request XDG / `%APPDATA%` conformance — still unresolved.

### Environment variables

- **`CODEX_HOME`** — overrides Codex's home dir (default `~/.codex`), which affects the **deprecated** user skills root `$CODEX_HOME/skills`. Does not affect the current `$HOME/.agents/skills` root. Also the standard knob for WSL users who want to point at their Windows home.
- **`HOME` / `%USERPROFILE%`** — determine the current `$HOME/.agents/skills` root.
- **`XDG_CONFIG_HOME`** — **not honored** by Codex.
- **`AGENTS_HOME`** — **not supported.** PR openai/codex#11289 proposing it was closed unmerged (OpenAI does not accept unsolicited PRs).

Both user roots (`.agents/skills` and `$CODEX_HOME/skills`) are loaded independently.

### Precedence

**Codex does not dedupe or override on collision.** Per the official docs: *"If two skills share the same `name`, Codex doesn't merge them; both can appear in skill selectors."* This is a notable contrast with Claude Code. All four disk scopes (REPO, USER, ADMIN, SYSTEM) contribute in parallel. Skills can be disabled without deletion via `[[skills.config]]` blocks with `enabled = false` in `~/.codex/config.toml`.

### Discovery

Repo discovery is a **parent-directory walk bounded by the Git repo root** — every `.agents/skills/` from cwd up to the repo root is loaded. Static roots (`$HOME/.agents/skills`, `/etc/codex/skills`, bundled SYSTEM, deprecated `$CODEX_HOME/skills`) are scanned in addition. **Symlinked skill folders are followed.** Discovery happens at startup with auto-detect of changes; docs recommend restart if a new skill doesn't appear. Only metadata plus the optional `agents/openai.yaml` loads into context at startup; the full SKILL body is lazy.

### Layout

Directory-per-skill containing `SKILL.md` (required) plus optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml`. Codex searches **recursively** for any directory containing `SKILL.md` under each root — that's how it finds bundled skills nested inside `.system/`.

---

## opencode

opencode has native Agent Skills as of v1.0.190, documented at opencode.ai/docs/skills/. It is the most aggressively cross-compatible of the four: it reads **six** directories per session, combining its own `.opencode/skills/`, Claude Code's `.claude/skills/`, and the generic `.agents/skills/` convention, each at both project and global scope.

### Scopes

opencode doesn't use formal scope names; it documents six discovery locations split by tier (project vs. global) and flavor (opencode-native, Claude-compatible, generic-agents). `OPENCODE_CONFIG_DIR` effectively adds a seventh custom-directory scope mirroring `.opencode/` structure.

### Paths per scope per OS

| Scope | macOS | Linux | Windows (native — WSL recommended) |
|---|---|---|---|
| Project (opencode-native) | `<repo>/.opencode/skills/<name>/SKILL.md` | same | `<repo>\.opencode\skills\<name>\SKILL.md` |
| Project (Claude-compat) | `<repo>/.claude/skills/<name>/SKILL.md` | same | `<repo>\.claude\skills\<name>\SKILL.md` |
| Project (generic agents) | `<repo>/.agents/skills/<name>/SKILL.md` | same | `<repo>\.agents\skills\<name>\SKILL.md` |
| Global (opencode-native) | `~/.config/opencode/skills/<name>/SKILL.md` (XDG default) | `$XDG_CONFIG_HOME/opencode/skills/<name>/SKILL.md`, default `~/.config/opencode/...` | `%USERPROFILE%\.config\opencode\skills\<name>\SKILL.md` (docs; community note: some older code paths used `%APPDATA%\opencode` — confirm) |
| Global (Claude-compat) | `~/.claude/skills/<name>/SKILL.md` | same | `%USERPROFILE%\.claude\skills\<name>\SKILL.md` |
| Global (generic agents) | `~/.agents/skills/<name>/SKILL.md` | same | `%USERPROFILE%\.agents\skills\<name>\SKILL.md` |
| Custom (env-configured) | `$OPENCODE_CONFIG_DIR/skills/<name>/SKILL.md` | same | same |
| Admin-managed (macOS) | `/Library/Application Support/opencode/` | — | — |

Critically, opencode uses `~/.config/opencode/` **on macOS as well** — not `~/Library/Application Support/opencode/`. That macOS `Application Support` path is reserved for **admin-managed system config**, not user skills.

### Environment variables

- **`OPENCODE_CONFIG_DIR`** — overrides the global config directory; `$OPENCODE_CONFIG_DIR/skills/` is discovered and can override global defaults. Not uniformly honored by every consumer (anomalyco/opencode#7003) but it is the documented override.
- **`OPENCODE_CONFIG`** — points to a single config **file** (JSON), not a directory; does not itself relocate skills but affects `permission.skill` rules.
- **`XDG_CONFIG_HOME`** — honored on macOS/Linux; determines the parent of the global `opencode/` directory.
- **`OPENCODE_DISABLE_CLAUDE_CODE`** — when set, disables **all** `.claude/` compat including `.claude/skills/` and `~/.claude/skills/`.
- **`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`** — disables only the `.claude/skills` compat, leaving `CLAUDE.md` rule-file compat intact.

There is **no dedicated `OPENCODE_SKILLS_DIR`** variable.

### Precedence

opencode's docs state skill **names must be unique across all locations** and provide **no tiebreaker** for duplicates. Duplicates are treated as misconfiguration. The general opencode config precedence (remote < global < `OPENCODE_CONFIG` file < project `opencode.json` < `.opencode/` dirs < `OPENCODE_CONFIG_CONTENT` < managed < MDM) governs skill **permission rules** (`permission.skill` allow/deny/ask), not skill discovery.

### Discovery

Project discovery **walks up from cwd to the git worktree root**, collecting `.opencode/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, and `.agents/skills/*/SKILL.md` along the way. Global discovery loads the three global roots at startup. Changes require a **restart**; skill **content** loads lazily via the built-in `skill({ name: "..." })` tool call.

### Layout

One directory per skill with `SKILL.md` required (case-sensitive, uppercase filename). Skill name must match the directory name and conform to `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 characters.

---

## Kilo Code

Kilo Code supports Agent Skills natively, implementing the open agentskills.io specification. Critically, **Kilo Code ships two runtimes with different directory conventions** that an installer must handle separately.

The two runtimes are:
1. **New platform** — "Kilo CLI 1.0" (`@kilocode/cli`, forked from opencode) plus the new VS Code extension rebuilt on top of it. Uses `.kilo/`. Config file is `kilo.jsonc`.
2. **Legacy VS Code extension** — the Roo Code / Cline-forked extension. Uses `.kilocode/`. No `kilo.jsonc`.

Skills **do not live in VS Code's per-extension `globalStorage`** on any OS — they're deliberately in user-visible home and project dirs for portability and version control. Ignore `~/Library/Application Support/Code/User/globalStorage/`, `~/.config/Code/User/globalStorage/`, and `%APPDATA%\Code\User\globalStorage\` entirely.

### Scopes

- **Global / User-Level** — `~/.kilo/skills/` (new) or `~/.kilocode/skills/` (legacy)
- **Project / Workspace-Level** — `<project>/.kilo/skills/` (new) or `<project>/.kilocode/skills/` (legacy)
- **Mode-specific** — `skills-<mode-slug>/` directories (legacy only)
- **Extra directories via `skills.paths`** — absolute, `~/`-relative, or project-relative (new only)
- **Remote via `skills.urls`** — fetched on demand (new only)
- **Cross-tool compat** — `.claude/skills/` and `.agents/skills/` (new only)

### Paths: new platform (`.kilo/`)

| Scope | macOS | Linux | Windows |
|---|---|---|---|
| Global skills | `~/.kilo/skills/<name>/SKILL.md` | same | `C:\Users\<user>\.kilo\skills\<name>\SKILL.md` |
| Project skills | `<project>/.kilo/skills/<name>/SKILL.md` | same | same |
| Claude-compat | `<project>/.claude/skills/<name>/SKILL.md` | same | same |
| Agents-compat | `<project>/.agents/skills/<name>/SKILL.md` | same | same |
| Global config (holds `skills.paths`, `skills.urls`) | `~/.config/kilo/kilo.jsonc` | same | `C:\Users\<user>\.config\kilo\kilo.jsonc` (docs say this literal path, not `%APPDATA%`) |
| Project config | `<project>/kilo.jsonc` or `<project>/.kilo/kilo.jsonc` (latter wins if both exist) | same | same |

### Paths: legacy VS Code extension (`.kilocode/`)

| Scope | macOS / Linux | Windows |
|---|---|---|
| Global generic skills | `~/.kilocode/skills/<name>/SKILL.md` | `C:\Users\<user>\.kilocode\skills\<name>\SKILL.md` |
| Global mode-specific | `~/.kilocode/skills-<mode-slug>/<name>/SKILL.md` (e.g. `skills-code/`, `skills-architect/`, `skills-ask/`, `skills-debug/`) | `C:\Users\<user>\.kilocode\skills-<mode-slug>\<name>\SKILL.md` |
| Project generic | `<project>/.kilocode/skills/<name>/SKILL.md` | same |
| Project mode-specific | `<project>/.kilocode/skills-<mode-slug>/<name>/SKILL.md` | same |

The legacy extension does **not** read `.kilo/`, `.claude/skills/`, `.agents/skills/`, or `skills.paths`/`skills.urls` — those are new-platform-only features. Issue Kilo-Org/kilocode#4779 reported a Windows legacy-extension `~` resolution bug (path becoming `e:\...\~\.kilocode\skills\...`); may be fixed, worth testing.

### Environment variables

- **`KILO_DISABLE_EXTERNAL_SKILLS=true`** — disables the compatibility directories `.claude/skills/` and `.agents/skills/` (new platform/CLI only).
- **No `KILOCODE_HOME` or `KILO_HOME`** documented anywhere for relocating the `.kilo/` or `.kilocode/` root. Symlinks are the documented workaround (and the symlink name must match the skill `name` exactly).
- **No XDG skills support** — the config dir is `~/.config/kilo/` (XDG-ish), but the skills root is `~/.kilo/skills/`, not `~/.config/kilo/skills/`. Discussion Kilo-Org/kilocode#5783 requests `~/.config/agents/skills/` XDG support; unimplemented.

### Precedence

**New platform:** project `.kilo/skills/` overrides global `~/.kilo/skills/` on name collision. Compat dirs (`.claude/skills/`, `.agents/skills/`) and `skills.paths` contribute to the shared pool. `skills.urls` are fetched on demand. **No mode-specific override** — all skills go into one pool and the agent selects via the skill's `description`.

**Legacy:** project overrides global; within scope, mode-specific (`skills-code/foo`) overrides generic (`skills/foo`) when in that mode.

### Discovery

Only YAML frontmatter (`name`, `description`) and the path are read at session start; full body is lazy. Discovery happens when a new session starts or `kilo run` is invoked (new CLI) / when the new VS Code extension connects to the CLI server / on VS Code startup or "Reload Window" (legacy). The agent selects skills by matching the user's task against aggregated `{name, description}` pairs in the system prompt — **no keyword match, no embeddings**. Explicit invocation by name in chat always works. Slash-command invocation (`/my-skill`) is an open feature request (issue #6731), not shipped.

### Layout

Standard Agent Skills spec: directory named after the skill, `SKILL.md` required, optional `scripts/`, `references/`, `assets/`. Skill name constraints: lowercase alphanumeric with hyphens, ≤64 chars, must match the parent directory name.

---

## Side-by-side comparison

### User / global scope

| Tool | macOS | Linux | Windows | Relocation env var |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` | `CLAUDE_CONFIG_DIR` (relocates entire `.claude/` tree) |
| Codex (current) | `~/.agents/skills/` | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` *(inferred)* | None — only `HOME`/`%USERPROFILE%` |
| Codex (deprecated) | `~/.codex/skills/` | `~/.codex/skills/` | `%USERPROFILE%\.codex\skills\` | `CODEX_HOME` |
| opencode (native) | `~/.config/opencode/skills/` | `$XDG_CONFIG_HOME/opencode/skills/` (default `~/.config/opencode/`) | `%USERPROFILE%\.config\opencode\skills\` | `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME` |
| opencode (Claude-compat) | `~/.claude/skills/` | same | `%USERPROFILE%\.claude\skills\` | disable via `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` |
| opencode (agents-compat) | `~/.agents/skills/` | same | `%USERPROFILE%\.agents\skills\` | — |
| Kilo Code (new) | `~/.kilo/skills/` | `~/.kilo/skills/` | `C:\Users\<u>\.kilo\skills\` | None documented |
| Kilo Code (legacy) | `~/.kilocode/skills/` (+ `skills-<mode>/`) | same | `C:\Users\<u>\.kilocode\skills\` (+ `skills-<mode>\`) | None documented |

### Project / repo scope

| Tool | Project path | Walks up? |
|---|---|---|
| Claude Code | `<repo>/.claude/skills/<name>/SKILL.md` | No parent walk; yes, nested-subdir auto-discovery for touched files |
| Codex | `<cwd>/.agents/skills/<name>/SKILL.md` | Yes — every ancestor up to git repo root |
| opencode | `<cwd>/.opencode/skills/`, `/.claude/skills/`, `/.agents/skills/` | Yes — up to git worktree root, each of three flavors |
| Kilo Code (new) | `<project>/.kilo/skills/`, plus `.claude/skills/` and `.agents/skills/` compat | Not documented as walking up |
| Kilo Code (legacy) | `<project>/.kilocode/skills/` (+ `skills-<mode>/`) | Not documented as walking up |

### Environment variables summary

| Tool | Variable | Purpose |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | Relocates entire `~/.claude/` tree including skills |
| Codex | `CODEX_HOME` | Relocates `~/.codex/` — affects only the deprecated skills root |
| opencode | `OPENCODE_CONFIG_DIR` | Overrides global config dir; adds `$OPENCODE_CONFIG_DIR/skills/` to scan set |
| opencode | `OPENCODE_CONFIG` | Points to single config file; does not relocate skills |
| opencode | `XDG_CONFIG_HOME` | Determines parent of global `opencode/` dir |
| opencode | `OPENCODE_DISABLE_CLAUDE_CODE` | Turns off all `.claude/` compat (incl. skills) |
| opencode | `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | Turns off only `.claude/skills/` compat |
| Kilo Code | `KILO_DISABLE_EXTERNAL_SKILLS` | Turns off `.claude/skills/` and `.agents/skills/` compat (new platform) |

### Name-collision behavior

| Tool | Rule |
|---|---|
| Claude Code | enterprise > personal > project; higher shadows lower. Plugin skills namespaced `plugin:skill`. |
| Codex | **No override.** Both duplicates surface in skill selectors. |
| opencode | Docs require globally unique names; no tiebreaker defined. |
| Kilo Code (new) | Project `.kilo/skills/` overrides global `~/.kilo/skills/`. All scopes share one pool. |
| Kilo Code (legacy) | Project overrides global; mode-specific overrides generic within scope. |

## Practical installer takeaways

Three patterns matter for SkillSmith. First, **only Claude Code and opencode offer a clean env-var relocation knob** (`CLAUDE_CONFIG_DIR` and `OPENCODE_CONFIG_DIR` respectively); for Codex the knob only affects the deprecated path, and Kilo Code offers no relocation knob at all — symlinks are the documented workaround.

Second, **three of four tools now read `.claude/skills/` or `.agents/skills/` for cross-compatibility**: opencode reads both at project and global scope, Kilo Code's new CLI reads both at project scope (global not documented), and Codex canonically uses `.agents/skills/` itself. This means an installer writing user-scope skills to **`~/.agents/skills/`** hits Codex natively and opencode via compat — two tools in one write. Writing to **`~/.claude/skills/`** hits Claude Code natively and opencode via compat — two more tools in one write. Kilo Code's new CLI requires a separate write to `~/.kilo/skills/`, and the legacy VS Code extension requires yet another to `~/.kilocode/skills/`.

Third, **Windows paths are least stable**. Claude Code and Kilo Code explicitly use `%USERPROFILE%\.tool\` (not `%APPDATA%`); opencode's docs use `%USERPROFILE%\.config\opencode\` (XDG-style on Windows, unusual); Codex's Windows skills paths are not officially enumerated and must be inferred from its home-dir convention. Any installer should ship empirical verification on Windows for each target tool rather than trust any single doc page.

Finally, two surfaces still have live gaps worth monitoring: Claude Code's enterprise skill content path is undocumented (provisioning goes through managed-settings + MDM), and Codex's Windows paths for USER and ADMIN scopes are inferred rather than canonical. For both, test empirically before depending on a written path.