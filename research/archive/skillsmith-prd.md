# SkillSmith — PRD (v0.2, Gathering Draft)

> **Working name:** `SkillSmith` — placeholder, to be replaced.
> **Status:** Early gathering. This document captures intent and scope for a POC; it is not yet a committed spec.
> **Changes from v0.1:** manifest/config file moved into MVP; cross-scope existence check added; `list` command added; LLM-based adaptation deferred to Phase 2; several open questions resolved.

---

## 1. Problem

Agent coding tools (Claude Code, Codex, Kilo Code, Droid, and others) are converging on the idea of "skills" — reusable, packaged capabilities an agent can load. But adoption is fragmented in three painful ways:

1. **Install location differs per tool.** Claude Code, Codex, and Kilo Code each put skills in different paths, and each supports multiple install scopes (system / user / project).
2. **Format differs per tool.** Even when skills follow a nominal standard (e.g., `AGENTS.md`-style conventions), frontmatter fields, file layout, and tool-specific expectations vary.
3. **No scope/lifecycle tooling.** Today there's no easy way to ask "is this skill already installed?", "install this at user scope vs. project scope", or "copy all skills from project A into project B".

The existing `npx`-style experience (Vercel's skills CLI) installs to a single standard location and does not adapt to the target tool. That's the gap.

## 2. Goal

A single CLI that installs agent skills into the *right place, in the right format, at the right scope*, for whichever agent tool the user is targeting — with awareness of what's already installed, cross-project sync, and an optional project manifest for teams.

## 3. Non-Goals (for POC / Day 1)

- **Version management.** POC ignores versions; install and sync only add a skill if it does not already exist at the destination. Version comparison is a Phase 2 concern.
- **LLM-based adaptation.** D1 uses deterministic rules only. An API-backed LLM adapter is valuable but explicitly deferred to Phase 2.
- **Security / trust layer.** Installing a skill ships instructions an agent will execute — a real trust surface. Out of scope for POC; handled post-POC.
- **Authoring tools.** This product installs and adapts skills; it does not scaffold new skills.
- **Runtime features.** No execution, sandboxing, or mediation — packaging/placement only.
- **GUI.** CLI-first for POC.

## 4. Users

Two primary personas at launch, served by the same CLI:

**Solo developer** — juggles multiple agent tools on one machine; wants a skill installed once and working regardless of tool. Uses the CLI imperatively.

**Team / engineering org** — wants consistency across contributors and projects. Uses a project-level TOML manifest (`skillsmith.toml`) that pins the skills a repo depends on, so anyone cloning can `skillsmith apply` and get the same setup.

## 5. Core Capabilities

### 5.1 Tool-aware install
Given a skill and a target tool, place it at the correct path and in the correct format for that tool.

- **MVP target tools:** Claude Code, Codex, Kilo Code.
- **Explicit flags:** `--tool {claude-code|codex|kilo-code}` and `--scope {system|user|project}` select target and scope directly. `--path <dir>` overrides the project directory.
- **Tool install check.** Before writing, the CLI verifies the target tool is installed on the system. If it isn't, the CLI **prints the suggested install command for that tool but does not run it** — the user installs it themselves and retries.
- **Interactive mode (default when flags omitted).** The CLI:
  1. Detects which target tools are installed on the system.
  2. Presents installed tools as the primary choices.
  3. Separately shows *suggested alternatives that are not installed* so users discover what else they could target (clearly visually separated from the installed set, not mixed in).
  4. If inside a Git repo, prompts for scope (project / user / system) with project as the default suggestion.

### 5.2 Skill adaptation
When a skill was authored for tool A but the user is installing into tool B, transform it.

- **MVP: deterministic rules only.** Per-target-tool transformers handle frontmatter renames, file layout changes, and known convention mappings. Fast, reproducible, no API calls.
- **Phase 2: LLM fallback (API-based).** For unusual fields, prose-level expectations, or tool-specific idioms deterministic rules can't cover. Opt-in and gated so users know when it runs.
- **Future CLI features for adaptation — noted, not in POC.** Not committing to any of these now, but worth remembering:
  - Dry-run / preview mode showing the diff before writing.
  - Adapter plugin system so third parties can contribute per-tool transforms.
  - Bidirectional adaptation (normalize to a canonical form, then render to target).
  - Reporting on which rules fired and which fields were unchanged.

### 5.3 Existence detection (same-scope and cross-scope)
Before writing, check whether a skill is already installed — at the requested scope *and* at broader scopes.

- **Same-scope duplicate** → require `--force` to overwrite.
- **Cross-scope duplicate** → also require `--force`. If a user tries to install at project scope but the skill is already at user or system scope, the CLI refuses unless forced. This prevents the same skill silently existing at two layers.
- The `list` command (5.6) surfaces these duplicates proactively so users see them before they conflict.

### 5.4 Cross-project sync
Copy skills from a source project into a target project (or into user scope).

- **POC semantics:** install only if not already present at the destination at any scope. No version comparison, no merging, no overwriting unless `--force`.
- Phase 2 expands this to diff/merge/version-compare flows.

### 5.5 Pluggable registries
Skill sources are pluggable.

- **Default skill reference format:** GitHub-style `user/repo/skill-name` — e.g., `acme/agent-tools/code-review`. Familiar shape; maps cleanly onto Git repos with a skill selector appended.
- **POC:** direct Git repo URLs work out of the box. A default registry is a **parallel research item** — if a suitable existing registry is identified, wire it in; otherwise ship with Git-only and add registry support later.
- **Long-term:** host a primary registry ourselves, plus support (a) other registries and (b) direct Git repo URLs as first-class sources.

### 5.6 List command
`skillsmith list` enumerates installed skills across every scope (system, user, project), grouped by tool and scope. Flags cross-scope duplicates so users can reconcile them. Essential companion to the cross-scope existence check in 5.3.

### 5.7 Manifest / config file (in MVP)
A project-level TOML file (`skillsmith.toml`) lists the skills the project depends on. Acts as a lightweight lockfile for contributors.

- **MVP form:** simple list of skills to check/install.
- `skillsmith apply` reads the manifest and installs any listed skills that aren't already present.
- Solo devs can ignore it; teams use it as the source of truth for the repo.

## 6. Key Flows

### Flow 1: Interactive install in a project
```
$ cd ~/code/my-app
$ skillsmith install acme/agent-tools/code-review

  Detected Git repo.

  Installed tools:
    › claude-code
      codex

  Also available (not installed):
      kilo-code  → install: npm i -g @kilocode/cli

  Install scope?
    › project (./.claude/skills)
      user    (~/.claude/skills)
      system  (/etc/claude/skills)

  ⚠ Skill already installed at user scope.
    Installing at project scope would duplicate across layers.
    Re-run with --force to proceed.
```

### Flow 2: Non-interactive / scripted
```
$ skillsmith install acme/agent-tools/code-review \
    --tool codex --scope user --yes
```

### Flow 3: Target tool not installed
```
$ skillsmith install acme/agent-tools/code-review --tool kilo-code

  kilo-code is not installed on this system.

  To install it, run:
    npm i -g @kilocode/cli

  (not running this for you — install it yourself and retry)
```

### Flow 4: Cross-tool adaptation
```
$ skillsmith install acme/agent-tools/claude-reviewer --tool codex

  Source skill targets: claude-code
  Applying deterministic adapter: claude-code → codex ✓
  Frontmatter 'allowed-tools' → 'tools' ✓
  Installed at ~/.codex/skills/claude-reviewer
```

### Flow 5: Sync across projects
```
$ skillsmith sync --from ~/code/project-a --to .

  Found 7 skills in source.
  5 new, 2 already present (skipped).
  Installed: code-review, lint-fix, commit-msg, changelog, release-notes
```

### Flow 6: List installed skills
```
$ skillsmith list

  claude-code (user):     code-review, commit-msg
  claude-code (project):  lint-fix
  codex (user):           code-review

  ⚠ 'code-review' installed in both claude-code:user and codex:user
```

### Flow 7: Manifest apply
```
$ cat skillsmith.toml
  [skills]
  "acme/agent-tools/code-review" = {}
  "acme/agent-tools/commit-msg"  = {}

$ skillsmith apply

  Reading skillsmith.toml...
  Installing 2 skills at project scope for claude-code...
```

## 7. Architecture Sketch

- **CLI frontend** — argument parsing, interactive prompts, config discovery, tool-install detection.
- **Tool adapters** — one per target tool (claude-code, codex, kilo-code). Each knows: install paths per scope, frontmatter schema, file layout, adaptation rules *from* other tools, canonical install command for that tool.
- **Registry clients** — pluggable. POC: direct Git + optional default registry. Long-term: our registry + others + Git.
- **Adapter engine** — deterministic rules in MVP; LLM fallback in Phase 2.
- **State/index** — per-scope record of installed skills, for existence detection, `list`, and sync.

## 8. Phasing

**POC / MVP (Day 1)**
- CLI with `install`, `sync`, `list`, `apply` commands.
- Adapters for Claude Code, Codex, Kilo Code.
- Deterministic adaptation only.
- Direct Git repo URLs; default registry TBD (parallel research).
- GitHub-style skill identifiers (`user/repo/skill-name`).
- Interactive scope + tool selection; tool-install check with install-command hint (no auto-install).
- Cross-scope existence detection requiring `--force`.
- TOML manifest (`skillsmith.toml`) with basic `apply`.

**Phase 2**
- LLM adaptation fallback (API-based), gated.
- Version comparison and upgrade flows.
- Our own hosted registry.
- Additional tools (Droid, Cursor, Aider, Cline, Continue — TBD).
- Conflict resolution beyond "skip if exists" (diff, merge, prompt).
- Security / trust layer for third-party skills.
- Richer manifest features (per-skill overrides, refs, branches).

**Phase 3 (speculative)**
- GUI / IDE integration.
- Skill authoring helpers.
- Cross-tool usage analytics.

## 9. Open Questions

**Resolved since v0.1:**
- ~~Codex vs. "OpenAI Code"~~ → **collapsed to Codex.**
- ~~LLM adaptation cost/latency~~ → **API-based, deferred to Phase 2.**
- ~~Skill identity format~~ → **GitHub-style `user/repo/skill-name`.**
- ~~Manifest format~~ → **TOML.**
- ~~Security / trust layer~~ → **deferred to post-POC.**
- ~~Default registry for POC~~ → **deferred; Git URLs suffice. Research existing registries as a parallel workstream.**

**Still open:**
1. **Working name** — `SkillSmith` is a placeholder. Decide before any public surface.
2. **Canonical install commands per tool** — capture the install command for each MVP target tool (for Flow 3 error hints). Small research task.
3. **Skill identity collisions** — if two different repos expose skills with the same leaf name, how does `list` disambiguate? Likely always show the full `user/repo/skill-name`, but confirm.
4. **Manifest granularity** — per-skill overrides in the TOML (target tool, scope, ref) or keep minimal for MVP? Leaning minimal.

## 10. Success Criteria (POC)

- A solo dev can run one command and have a skill correctly installed for Claude Code, Codex, or Kilo Code.
- A skill authored for Claude Code installs successfully into Codex via deterministic rules for a curated test set.
- If the target tool isn't installed, the CLI prints the install command without running it.
- `sync` correctly copies new skills between two projects without clobbering existing ones.
- `list` surfaces skills installed at every scope across all supported tools, flagging cross-scope duplicates.
- `apply` correctly reads `skillsmith.toml` and installs listed skills.
- Interactive mode detects Git repos, detects installed tools, offers appropriate scope/tool choices, and separately surfaces not-installed alternatives.
