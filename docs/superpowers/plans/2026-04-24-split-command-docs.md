# Split command docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `research/skillsmith-cli-design.md` into a cross-cutting spec plus one markdown file per command in `research/commands/`, folding in the already-authored `research/11-doctor-health.md` and `research/12-agents.md`, with zero content loss. During the fold-in, reconcile vocabulary and flag-shape mismatches between 11/12 and the main doc — **main-doc conventions win**.

**Architecture:** Main doc keeps §0, §1, §2 (tree + command index), §3.1 (global flags), §4.1 (top-level help), §4.3 cross-cutting mockups only, §5, §6, §7, §8, §9. Each command verb gets its own file under `research/commands/<verb>.md` containing: its argument-order snippet, flag table, help mockup, command-specific error/prompt mockups, open questions, and feature-phase rows (where applicable). `11-doctor-health.md` and `12-agents.md` are folded into `commands/doctor.md` and `commands/agents.md` respectively and deleted from their old paths. The §2 command tree in the main doc is extended to include `check` and `agents` (neither is in the tree today).

## Reconciliation rules (apply during Tasks 2 and 3)

`11-doctor-health.md` and `12-agents.md` use vocabulary the main doc does not. Translate per these rules while folding them in. The main doc is ground truth; 11/12 are drafts that haven't been reconciled yet.

| In 11/12 | In main doc | Action |
|---|---|---|
| `--agent` flag | `--tool` flag | Rename to `--tool` in flag tables, help mockups, and prose. Preserve "repeatable" semantics. |
| Agent names `cursor`, `windsurf`, `aider` | Tool list `claude-code`, `codex`, `kilo-code`, `opencode` | Replace example agent names in mockups and tables with main-doc tools. Pick any two for multi-install examples (e.g., `claude-code` installed via `brew` and `npm-global`). |
| "agent" prose / "supported agent" | "tool" / "target tool" | Straight terminology swap in body text. Keep the command name `agents` as-is — it's the command name, not the noun it operates on. Acceptable phrasing: "`skillsmith agents` lists every supported tool SkillSmith can detect." |
| `--format json` (doctor, check) | `--json` boolean | Replace with `--json`. |
| `--format markdown\|json` (agents) | — | Keep `--format markdown\|json` as-is; this is a genuine content-type choice (markdown default), not a boolean, and has no main-doc equivalent. Flag this distinction in the file's "Open questions" section. |
| `doctor` "always exits 0" (11) | `doctor` "exits 1 on failure" (§4.5) | Main doc wins. Update doctor.md's prose to match main-doc exit semantics. |
| `check` "always exits error-and-above" with `--exit-code` flag (11) | Not present | Preserve `check`'s behavior; it's new. Keep `--exit-code`. |
| `--detected-only` flag on `agents` (12) | Not present | Preserve; it's new. |
| Plugin-contributed healthchecks contract (11) | Not present | Preserve; it's new design content. Keep "P2" phase marker. |

Any remaining mismatch discovered during extraction that isn't covered above: preserve the 11/12 text and add a bullet under that file's `## Open questions` section describing the mismatch for follow-up.

**Tech Stack:** Markdown + git. No build step.

---

## File structure

**New files to create:**
- `research/commands/README.md` — command index
- `research/commands/install.md`
- `research/commands/uninstall.md`
- `research/commands/sync.md`
- `research/commands/list.md`
- `research/commands/apply.md`
- `research/commands/doctor.md` (folds in `11-doctor-health.md` + main-doc extracts for `doctor` and `check`)
- `research/commands/agents.md` (folds in `12-agents.md`)

**Files to modify:**
- `research/skillsmith-cli-design.md` — remove moved sections, add command-index block in §2
- `research/skillsmith-phases.md` — update any cross-refs that break

**Files to delete (via `git mv` where possible so history is preserved):**
- `research/11-doctor-health.md` → merged into `research/commands/doctor.md`
- `research/12-agents.md` → renamed to `research/commands/agents.md`

---

## Convention: content moves

When a task says "move §X.Y from main doc," follow this exact procedure:

1. Open `research/skillsmith-cli-design.md` and find the heading for §X.Y.
2. Copy the entire section (heading + body + any code blocks + any tables) verbatim into the destination file at the location the task specifies.
3. Rewrite any intra-doc cross-references:
   - `§1.N` / `§6.N` / `§8` etc. that still live in the main doc → `[§X.Y](../skillsmith-cli-design.md#section-anchor)` using the GitHub-flavored anchor for that heading.
   - References to other per-command files → `[install](./install.md)` etc.
4. Delete the original section from the main doc. Delete any `---` separator that is now orphaned above or below the hole.
5. Verify before commit: `grep -n "§X.Y " research/skillsmith-cli-design.md` returns nothing for the section number you just moved, and `grep -n` against the destination file returns the content.

**Do not renumber surviving sections.** §1.11 stays §1.11 even after §1.5 moves (if it does). Preserving numbering keeps external references and the audit trail stable. The main doc's §3 "Flag tables" will become a short preamble pointing at per-command files — the numbered subsections themselves just vanish.

---

## Task 0: Baseline commit + tag

**Files:**
- Commit: `research/skillsmith-cli-design.md`, `research/skillsmith-phases.md` (currently modified), plus the two untracked archive files
- Tag: `docs/pre-commands-split`

- [ ] **Step 1: Confirm working tree state**

```bash
git status --short
```

Expected output:
```
 M research/skillsmith-cli-design.md
 M research/skillsmith-phases.md
?? research/archive/skillsmith-cli-design-critical-inconsistencies.md
?? research/archive/skillsmith-cli-design-inconsistencies.md
```

If output differs, stop and surface the difference to the user before proceeding.

- [ ] **Step 2: Stage and commit current state**

```bash
git add research/skillsmith-cli-design.md research/skillsmith-phases.md research/archive/skillsmith-cli-design-critical-inconsistencies.md research/archive/skillsmith-cli-design-inconsistencies.md
git commit -m "docs(research): baseline before commands/ split

Captures the pre-split state of skillsmith-cli-design.md and
skillsmith-phases.md and brings the inconsistency-audit archive
files into git. Tagged as docs/pre-commands-split so the split
transformation can be compared against it."
```

- [ ] **Step 3: Tag the baseline**

```bash
git tag -a docs/pre-commands-split -m "Baseline: monolithic skillsmith-cli-design.md before per-command split"
git tag --list docs/pre-commands-split
```

Expected: the tag name prints.

- [ ] **Step 4: Capture baseline line counts for later verification**

```bash
wc -l research/skillsmith-cli-design.md research/11-doctor-health.md research/12-agents.md | tee /tmp/skillsmith-split-baseline-wc.txt
```

Keep `/tmp/skillsmith-split-baseline-wc.txt` around — Task 10 compares against it.

---

## Task 1: Scaffold `research/commands/`

**Files:**
- Create: `research/commands/README.md`

- [ ] **Step 1: Create the directory and index**

```bash
mkdir -p research/commands
```

- [ ] **Step 2: Write the index**

Write `research/commands/README.md` with this exact content:

```markdown
# SkillSmith command reference

Per-command detail. Cross-cutting design (scopes, exit codes, env vars,
store layout, architecture) lives in [`../skillsmith-cli-design.md`](../skillsmith-cli-design.md);
release phasing lives in [`../skillsmith-phases.md`](../skillsmith-phases.md).

## Core verbs

- [install](./install.md) — install one or more skills from a source ref
- [uninstall](./uninstall.md) — remove installed skills (aliases: `rm`, `remove`)
- [sync](./sync.md) — reconcile skills between scopes or projects
- [list](./list.md) — list installed skills across scopes and tools (alias: `ls`)
- [apply](./apply.md) — install skills declared in a manifest
- [doctor](./doctor.md) — diagnose readiness; also covers `check` (CI subset)
- [agents](./agents.md) — inventory of detected agents on the system

Each file contains: argument order, flag table, help output, error/prompt
mockups, open questions, and feature-phase rows.
```

- [ ] **Step 3: Commit**

```bash
git add research/commands/README.md
git commit -m "docs(research): scaffold commands/ with README index"
```

---

## Task 2: Rename `12-agents.md` → `commands/agents.md`

Simplest task first — `agents` isn't in the main doc, so there's nothing to merge.

**Files:**
- Move: `research/12-agents.md` → `research/commands/agents.md`

- [ ] **Step 1: Move the file preserving history**

```bash
git mv research/12-agents.md research/commands/agents.md
```

- [ ] **Step 2: Apply the reconciliation rules**

Open `research/commands/agents.md` and translate 12's vocabulary to main-doc conventions per the reconciliation table above:

- Replace `--agent` with `--tool` everywhere (flag description line, `## Command` bullets, `## Detection` prose, feature table). "Repeatable" stays.
- Replace `claude-code`, `cursor`, `windsurf`, `aider` example tool names in the `## Output` markdown mockup. Use these rows instead so the example demonstrates a multi-install (the feature that motivates the `agents` command):
  - `claude-code` with two install records: `/opt/homebrew/bin/claude` (brew, 1.2.3) and `~/.npm/bin/claude` (npm-global, 1.1.0) — keep as-is; this row is already valid.
  - `codex` with one install record: `/opt/homebrew/bin/codex` (brew, 0.5.1). Replace the `cursor` / app-bundle row.
  - Under "Not detected", list `kilo-code` and `opencode`. Replace `windsurf`, `aider`.
- Replace the `--format` description: keep `markdown|json` as the two choices; note in an `## Open questions` bullet that this command uses `--format` rather than the project-wide `--json` boolean because markdown-vs-json is a content-type choice. Leave `--format` in the flag description unchanged.
- In the "Relationship to `doctor`" paragraph, wrap `doctor` references so they link: `[doctor](./doctor.md)`.
- Top-level heading: the file currently starts `# 12. Agents`. Rename to `# agents` for consistency with the other command files.

- [ ] **Step 3: Rewrite cross-refs**

`grep -n '§' research/commands/agents.md` and rewrite each hit to the linked form.

- [ ] **Step 4: Verify**

```bash
test ! -e research/12-agents.md && echo "old path gone"
test -e research/commands/agents.md && echo "new path exists"
git log --follow --oneline research/commands/agents.md | head -3
```

Expected: "old path gone", "new path exists", and at least two commits in the log (original creation + this rename).

- [ ] **Step 5: Commit**

```bash
git add -A research/12-agents.md research/commands/agents.md
git commit -m "docs(research): move 12-agents.md to commands/agents.md and reconcile to main-doc conventions"
```

---

## Task 3: Merge `11-doctor-health.md` + main-doc extracts → `commands/doctor.md`

**Files:**
- Create: `research/commands/doctor.md`
- Delete: `research/11-doctor-health.md`
- Modify: `research/skillsmith-cli-design.md` (remove §2.1 `doctor` block, §3.7, §4.5, the `doctor` human-output mockup from §4.6)

- [ ] **Step 1: Seed the new file with `11-doctor-health.md`**

```bash
git mv research/11-doctor-health.md research/commands/doctor.md
```

- [ ] **Step 1b: Apply reconciliation rules to the 11-sourced content**

Before merging in main-doc extracts, translate the content that just came from 11:

- Rename top-level heading `# 11. Doctor / Health` → `# doctor / check`.
- Replace `--agent` with `--tool` in all flag mentions and prose.
- Replace `--format json` with `--json` in both the `doctor` command spec and the `check` command spec.
- Update doctor exit-code prose to match main doc §4.5: `doctor` exits 0 if all checks pass (warnings allowed unless `--strict`), 1 if one or more checks failed. Remove the "Always exits 0" line from the existing `## Commands` block.
- Where the text says "each supported agent" / "every agent" / "supported agents," change to "each supported tool" / "every target tool" / "supported tools." The command name `agents` stays as `agents` (command name, not operand).
- In the built-in checks table, the column header currently says "Agent detected on PATH" — change to "Tool detected on PATH." Same for "Multiple installs of the same agent" → "Multiple installs of the same tool."
- In the Plugin-contributed healthchecks section, rename env vars: `SKILLSMITH_AGENT` → `SKILLSMITH_HOOK_TOOL` (matches the §1.13 hook-env convention of `SKILLSMITH_HOOK_*` prefix and the user-facing default `SKILLSMITH_TOOL`). Similarly `SKILLSMITH_SKILL_DIR` → `SKILLSMITH_HOOK_SKILL_PATH`, `SKILLSMITH_MODE` → `SKILLSMITH_HOOK_MODE`. This aligns with CID-030 resolution.

- [ ] **Step 2: Add an argument-order section**

At the top of `research/commands/doctor.md`, immediately after the `# 11. Doctor / Health` heading (or rename it to `# doctor / check` — your call; recommend renaming for consistency with other command files), insert an `## Argument order` section containing the `doctor` block from the main doc's §2.1:

```
For `doctor`:

\`\`\`
skillsmith doctor [FLAGS]
\`\`\`

No positional arguments.
```

Also add a matching block for `check`:

```
For `check`:

\`\`\`
skillsmith check [FLAGS]
\`\`\`

No positional arguments.
```

- [ ] **Step 3: Merge in the main-doc flag table for `doctor`**

Append a `## Flags` section to `research/commands/doctor.md`. Under it, create two subsections — `### doctor` and `### check`.

In `### doctor`, paste the main doc's §3.7 flag table verbatim. (It already uses main-doc conventions — `--tool`, `--json`, `--strict`, `--scope`, `--offline`, plus the sugar flags — so no translation needed.)

In `### check`, write a fresh flag table in the same 6-column shape as §3.7. Rows:

| Long | Short | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| `--tool` | `-t` | enum/repeatable | all detected tools | `SKILLSMITH_TOOL` | Limit checks to tool(s) |
| `--scope` | `-s` | enum | all | `SKILLSMITH_SCOPE` | Limit checks to scope |
| `--user` | — | bool | — | — | Shorthand for `--scope=user` |
| `--system` | — | bool | — | — | Shorthand for `--scope=system` |
| `--project` | — | bool | — | — | Shorthand for `--scope=project` |
| `--exit-code` | — | bool | false | — | Exit non-zero on any error finding |
| `--json` | — | bool | false | — | JSON output |

This shape matches the doctor flag table but drops `--offline` and `--strict` (not meaningful for `check`, which is always strict-by-design per 11's rationale).

- [ ] **Step 4: Merge in the main-doc `--help` output for `doctor`**

Append a `## Help output` section to `research/commands/doctor.md` and copy §4.5 (`skillsmith doctor --help`) from the main doc. Do not translate flag names.

- [ ] **Step 5: Merge in the `doctor` human-output mockup**

Append an `## Error and prompt mockups` section. Copy the `skillsmith doctor human output` subsection from main doc §4.6 verbatim into it.

- [ ] **Step 6: Rewrite cross-refs**

In `research/commands/doctor.md`, replace every `§N.M` reference with either:
- `[§N.M](../skillsmith-cli-design.md#N-m-section-slug)` if the target is in the main doc
- `[agents](./agents.md)` or similar if the target is a sibling command file

Use `grep -n '§' research/commands/doctor.md` to enumerate them.

- [ ] **Step 7: Delete moved sections from the main doc**

Open `research/skillsmith-cli-design.md` and delete:
- The `For \`doctor\`:` block under §2.1 (lines around `skillsmith doctor [FLAGS]`)
- All of §3.7 `doctor` flags (the `### 3.7 \`doctor\` flags` heading and its table)
- All of §4.5 `skillsmith doctor --help` (the `### 4.5` heading and its body)
- The `**\`skillsmith doctor\` human output:**` subsection under §4.6 (heading plus the fenced mockup)

Leave §4.6's other subsections (uninstall mockups) intact — they move in Task 5.

- [ ] **Step 8: Verify**

```bash
grep -n "### 3.7" research/skillsmith-cli-design.md
grep -n "### 4.5" research/skillsmith-cli-design.md
grep -ni "doctor --help" research/skillsmith-cli-design.md
grep -n "skillsmith doctor human output" research/skillsmith-cli-design.md
```

All four commands should return no matches.

```bash
grep -c "## Flags" research/commands/doctor.md
grep -c "## Help output" research/commands/doctor.md
grep -c "## Error and prompt mockups" research/commands/doctor.md
```

Each should return `1`.

- [ ] **Step 9: Commit**

```bash
git add -A research/11-doctor-health.md research/commands/doctor.md research/skillsmith-cli-design.md
git commit -m "docs(research): merge 11-doctor-health.md + main-doc doctor extracts into commands/doctor.md"
```

---

## Task 4: Extract `install` → `commands/install.md`

**Files:**
- Create: `research/commands/install.md`
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Create the file skeleton**

Write `research/commands/install.md` with this exact opening (placeholders only for sections you will fill in steps 2–5; remove them once filled):

```markdown
# install

Install one or more agent skills from a source reference.

## Argument order

_(filled in Step 2)_

## Flags

_(filled in Step 3)_

## Help output

_(filled in Step 4)_

## Error and prompt mockups

_(filled in Step 5)_
```

- [ ] **Step 2: Copy argument order**

From main doc §2.1, copy the `For \`install\`:` block (including the fenced code and the paragraph that follows about permutation and atomic multi-source) into `## Argument order`. Replace the placeholder line.

- [ ] **Step 3: Copy flag table**

From main doc §3.2 `\`install\` flags`, copy the entire flag table into `## Flags`. Drop the `### 3.2` heading — the table itself is what matters. Replace the placeholder.

- [ ] **Step 4: Copy help output**

From main doc §4.2 `\`skillsmith install --help\``, copy the entire fenced code block (the rendered help text). Replace the placeholder.

- [ ] **Step 5: Copy install-specific mockups from §4.3**

Copy these subsections from main doc §4.3 into `## Error and prompt mockups`, in this order:

1. `**Skill already installed (no --force):**`
2. `**Cross-scope duplicate detected:**`
3. `**Interactive prompt (TTY only, no --yes):**`
4. `**Interactive install (no flags, TTY, in a Git repo):**`
5. `**Cross-tool adaptation (install of a claude-code skill into codex):**`

**Do not copy** these from §4.3 — they are cross-cutting and stay in the main doc:
- `**Tool not installed:**`
- `**Did you mean?:**`
- `**Non-TTY, no \`--yes\`, destructive action:**`
- `**Scope/permission error — system scope not writable:**`

**Do not copy** these — they move in Task 8 (`apply`):
- `**\`apply\` output (kubectl-style):**`
- `**\`apply --check\` (drift detection for CI):**`

- [ ] **Step 6: Rewrite cross-refs**

`grep -n '§' research/commands/install.md` and update each hit to either `[§N.M](../skillsmith-cli-design.md#anchor)` or `[sibling](./sibling.md)`.

- [ ] **Step 7: Delete moved sections from the main doc**

From `research/skillsmith-cli-design.md`, remove:
- The `For \`install\`:` block and the paragraph that follows it under §2.1
- All of §3.2 (heading `### 3.2 \`install\` flags` and its table)
- All of §4.2 (heading `### 4.2` and the fenced help block)
- The five install-specific mockup subsections from §4.3 listed in Step 5

Leave untouched: the §4.3 cross-cutting mockups and the two `apply` mockups.

- [ ] **Step 8: Verify**

```bash
grep -n "### 3.2" research/skillsmith-cli-design.md
grep -n "### 4.2" research/skillsmith-cli-design.md
grep -n "Skill already installed" research/skillsmith-cli-design.md
grep -n "Cross-scope duplicate detected" research/skillsmith-cli-design.md
grep -n "Interactive install" research/skillsmith-cli-design.md
grep -n "Cross-tool adaptation" research/skillsmith-cli-design.md
```

All six should return no matches.

```bash
grep -c "^## Flags$" research/commands/install.md
grep -c "^## Help output$" research/commands/install.md
grep -c "Skill already installed" research/commands/install.md
grep -c "Cross-tool adaptation" research/commands/install.md
```

Each should return `1`.

- [ ] **Step 9: Commit**

```bash
git add research/commands/install.md research/skillsmith-cli-design.md
git commit -m "docs(research): extract install to commands/install.md"
```

---

## Task 5: Extract `uninstall` → `commands/uninstall.md`

**Files:**
- Create: `research/commands/uninstall.md`
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Create skeleton** (same shape as install: `# uninstall`, followed by `## Argument order`, `## Flags`, `## Help output`, `## Error and prompt mockups`, each with a placeholder line).

- [ ] **Step 2: Argument order** — copy the `For \`uninstall\`:` block from main doc §2.1 (including the paragraph about ambiguous names).

- [ ] **Step 3: Flags** — copy the §3.6 flag table.

- [ ] **Step 4: Help output** — copy the §4.4 `skillsmith uninstall --help` fenced block.

- [ ] **Step 5: Mockups** — from main doc §4.6, copy these three subsections into `## Error and prompt mockups`:
  1. `**\`skillsmith uninstall\` idempotent no-op:**`
  2. `**\`skillsmith uninstall\` ambiguous name:**`
  3. `**\`skillsmith uninstall\` summary:**`

- [ ] **Step 6: Cross-refs** — `grep -n '§' research/commands/uninstall.md` and rewrite each hit.

- [ ] **Step 7: Delete from main doc:**
  - The `For \`uninstall\`:` block under §2.1
  - All of §3.6
  - All of §4.4
  - The three `uninstall` subsections from §4.6

Confirm §4.6 is now empty (or contains only its heading — if so, delete the heading too). The doctor output was already removed in Task 3.

- [ ] **Step 8: Verify**

```bash
grep -n "### 3.6" research/skillsmith-cli-design.md
grep -n "### 4.4" research/skillsmith-cli-design.md
grep -n "idempotent no-op" research/skillsmith-cli-design.md
grep -n "ambiguous name" research/skillsmith-cli-design.md
```

All four should return no matches.

- [ ] **Step 9: Commit**

```bash
git add research/commands/uninstall.md research/skillsmith-cli-design.md
git commit -m "docs(research): extract uninstall to commands/uninstall.md"
```

---

## Task 6: Extract `sync` → `commands/sync.md`

**Files:**
- Create: `research/commands/sync.md`
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Create skeleton** (`# sync`, then `## Argument order`, `## Flags`. No `## Help output` section yet — the main doc doesn't author a §4.x block for sync; skip it, and add a `## Help output` section containing just `_TBD: help mockup not yet authored._` so future work has a slot.)

- [ ] **Step 2: Argument order** — copy the `For \`sync\`:` block from §2.1 (including the paragraph about `--from`/`--to` being flag-only).

- [ ] **Step 3: Flags** — copy the §3.3 flag table.

- [ ] **Step 4: Cross-refs** — `grep -n '§' research/commands/sync.md` and rewrite.

- [ ] **Step 5: Delete from main doc:**
  - The `For \`sync\`:` block under §2.1
  - All of §3.3

- [ ] **Step 6: Verify**

```bash
grep -n "### 3.3" research/skillsmith-cli-design.md
grep -n "For \`sync\`:" research/skillsmith-cli-design.md
grep -c "## Flags" research/commands/sync.md
```

First two return nothing; third returns `1`.

- [ ] **Step 7: Commit**

```bash
git add research/commands/sync.md research/skillsmith-cli-design.md
git commit -m "docs(research): extract sync to commands/sync.md"
```

---

## Task 7: Extract `list` → `commands/list.md`

**Files:**
- Create: `research/commands/list.md`
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Create skeleton** (`# list`, `## Argument order`, `## Flags`, `## Help output` with `_TBD_` placeholder).

- [ ] **Step 2: Argument order** — copy the `For \`list\`:` block from §2.1.

- [ ] **Step 3: Flags** — copy the §3.4 flag table.

- [ ] **Step 4: Cross-refs** — rewrite any `§` references.

- [ ] **Step 5: Delete from main doc:**
  - The `For \`list\`:` block under §2.1
  - All of §3.4

- [ ] **Step 6: Verify**

```bash
grep -n "### 3.4" research/skillsmith-cli-design.md
grep -n "For \`list\`:" research/skillsmith-cli-design.md
```

Both return nothing.

- [ ] **Step 7: Commit**

```bash
git add research/commands/list.md research/skillsmith-cli-design.md
git commit -m "docs(research): extract list to commands/list.md"
```

---

## Task 8: Extract `apply` → `commands/apply.md`

**Files:**
- Create: `research/commands/apply.md`
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Create skeleton** (`# apply`, `## Argument order`, `## Flags`, `## Help output` with `_TBD_`, `## Error and prompt mockups`).

- [ ] **Step 2: Argument order** — copy the `For \`apply\`:` block from §2.1.

- [ ] **Step 3: Flags** — copy the §3.5 flag table.

- [ ] **Step 4: Mockups** — from main doc §4.3, copy these two subsections into `## Error and prompt mockups`:
  1. `**\`apply\` output (kubectl-style):**`
  2. `**\`apply --check\` (drift detection for CI):**`

- [ ] **Step 5: Cross-refs** — rewrite.

- [ ] **Step 6: Delete from main doc:**
  - The `For \`apply\`:` block under §2.1
  - All of §3.5
  - The two `apply` mockups from §4.3

- [ ] **Step 7: Verify**

```bash
grep -n "### 3.5" research/skillsmith-cli-design.md
grep -n "apply --check" research/skillsmith-cli-design.md
grep -n "kubectl-style" research/skillsmith-cli-design.md
```

All three should return nothing.

- [ ] **Step 8: Commit**

```bash
git add research/commands/apply.md research/skillsmith-cli-design.md
git commit -m "docs(research): extract apply to commands/apply.md"
```

---

## Task 9: Demote main doc — add command index, tidy headings

After Tasks 3–8, `research/skillsmith-cli-design.md` still contains: §0, §1, §2 intro + command tree (but §2.1 is now empty), §3 intro + §3.1 globals only, §4.1 + cross-cutting §4.3 mockups, §5, §6, §7, §8, §9.

**Files:**
- Modify: `research/skillsmith-cli-design.md`

- [ ] **Step 1: Delete §2.1 entirely**

Remove the `### 2.1 Argument order` heading. All its children were moved in prior tasks; the heading is now empty.

- [ ] **Step 1b: Add `check` and `agents` to the §2 command tree**

The §2 command tree currently lists six core verbs (`install`, `uninstall`, `sync`, `list`, `apply`, `doctor`) plus auxiliaries. Two MVP commands are missing: `check` (from `11-doctor-health.md`) and `agents` (from `12-agents.md`).

Insert these two entries into the `# Core verbs` block of the command tree, after the `skillsmith doctor` entry and before `# Auxiliary commands`:

```
skillsmith check
  # Error-severity subset of doctor, for CI and pre-commit.
  # --exit-code exits non-zero on any error finding. --tool
  # repeatable to scope the run. Warnings are intentionally
  # never run here — check is error-and-above only.

skillsmith agents
  # Inventory of every supported tool SkillSmith can detect
  # on the system, including multiple installs at different
  # locations. Purely informational; always exits 0.
```

Also update §1.1 ("Command structure") if it cites a verb count — change "six core verbs" to "eight core verbs" (or whatever matches the tree after adding `check` and `agents`). Search with `grep -n 'core verbs' research/skillsmith-cli-design.md`.

- [ ] **Step 2: Add a command-index block to §2**

Immediately after the §2 command-tree fenced block, before the `---` separator (if any), insert:

```markdown
### 2.1 Per-command detail

Each command's argument order, flag table, help mockup, and
command-specific error/prompt mockups live in its own file under
[`commands/`](./commands/):

- [`install`](./commands/install.md)
- [`uninstall`](./commands/uninstall.md)
- [`sync`](./commands/sync.md)
- [`list`](./commands/list.md)
- [`apply`](./commands/apply.md)
- [`doctor`](./commands/doctor.md) — also covers the `check` CI subset
- [`agents`](./commands/agents.md)

This doc keeps only cross-cutting material: design decisions (§1),
global flags (§3.1), top-level help (§4.1), shared error patterns
(§4.3), naming (§5), exit codes and env vars (§6), documentation
strategy (§7), architecture (§8), open questions (§9).
```

- [ ] **Step 3: Tidy §3**

Rename §3 to `## 3. Global flags` and keep only §3.1 (rename to just a table with no subheading, or keep §3.1 as-is). Verify the subsections §3.2–§3.7 are all gone.

- [ ] **Step 4: Tidy §4**

Rename §4 to `## 4. Top-level help and cross-cutting mockups`. Keep §4.1 (top-level help), and the `## 4.3` subsection renamed to `### 4.2 Cross-cutting error and prompt mockups` (it should now contain only: Tool not installed, Did you mean, Non-TTY destructive refusal, Scope/permission error). Delete the now-empty §4.2, §4.4, §4.5, §4.6 headings.

- [ ] **Step 5: Update the intro paragraph**

At the top of the file, update the paragraph that says "This doc is organized as: (0) background…" to reflect the new section shape. Specifically, change the "(3) flag tables, (4) help/error mockups" phrasing to something like "(3) global flags, (4) top-level help and cross-cutting mockups," and insert one sentence: "Per-command detail lives in [`commands/`](./commands/)."

Also update the opening sentence's list of core verbs if it no longer matches — at Task 0 baseline it says "six core verbs — install, uninstall, sync, list, apply, doctor." Keep that phrasing.

- [ ] **Step 6: Verify no moved sections remain**

```bash
for h in "### 2.1 Argument" "### 3.2" "### 3.3" "### 3.4" "### 3.5" "### 3.6" "### 3.7" "### 4.2" "### 4.4" "### 4.5" "### 4.6"; do
  echo "-- $h --"
  grep -n "^$h" research/skillsmith-cli-design.md || echo "   (gone)"
done
```

Every line should print `(gone)` except any intentionally renamed headings (e.g., your renamed `### 4.2`). Inspect any unexpected match and fix.

```bash
grep -n "commands/" research/skillsmith-cli-design.md
```

Expected: matches in the intro paragraph + the §2.1 command-index block.

- [ ] **Step 7: Commit**

```bash
git add research/skillsmith-cli-design.md
git commit -m "docs(research): demote main CLI design doc to cross-cutting spec + commands/ index"
```

---

## Task 10: Link audit + line-count reconciliation

**Files:**
- Reference: `/tmp/skillsmith-split-baseline-wc.txt` (from Task 0 Step 4)

- [ ] **Step 1: Enumerate every cross-reference in the new files**

```bash
grep -rn '§\|skillsmith-cli-design.md\|commands/' research/commands/ research/skillsmith-cli-design.md research/skillsmith-phases.md
```

Scan the output. Every `§X.Y` reference in `research/commands/*.md` should be a markdown link, not bare text. Every `../skillsmith-cli-design.md#...` link should resolve to an existing anchor in the main doc. Every `./*.md` link in the commands dir should resolve to a sibling file.

- [ ] **Step 2: Resolve broken anchors**

For each `[...](../skillsmith-cli-design.md#anchor)` link, confirm the anchor exists:

```bash
grep -i "^## \|^### " research/skillsmith-cli-design.md | sed 's/^#* //; s/[^a-zA-Z0-9 -]//g; s/ /-/g; s/.*/\L&/'
```

That produces a list of valid anchors (GitHub's slug rules). Every target fragment you linked to should appear in that list. Any miss = broken link; open the offending file and fix.

- [ ] **Step 3: Line-count reconciliation**

```bash
baseline=$(awk '{sum+=$1} END{print sum-$1}' /tmp/skillsmith-split-baseline-wc.txt)  # subtract the total line that wc prints
current=$(wc -l research/skillsmith-cli-design.md research/commands/*.md | tail -1 | awk '{print $1}')
echo "baseline total: $baseline"
echo "current total:  $current"
echo "delta:          $((current - baseline))"
```

Expected: delta is small and positive (new files add their own headings, cross-ref link syntax adds characters but not many lines, the new index and command-index block add ~20 lines). A delta of roughly +40 to +120 lines across all files is normal. A negative delta is a warning — content was lost. A delta greater than +200 suggests content was duplicated rather than moved.

If the delta is outside the expected band, do a targeted check:

```bash
diff <(git show docs/pre-commands-split:research/skillsmith-cli-design.md | grep -o 'skillsmith [a-z]\+' | sort -u) \
     <(cat research/skillsmith-cli-design.md research/commands/*.md | grep -o 'skillsmith [a-z]\+' | sort -u)
```

Expected output: empty (every command verb from the baseline is still represented somewhere in the new structure).

- [ ] **Step 4: Verify phases doc still makes sense**

```bash
grep -n "research/" research/skillsmith-phases.md
grep -n "#section\|§" research/skillsmith-phases.md
```

Any references to `skillsmith-cli-design.md` should still resolve. If a `§X.Y` reference in the phases doc targeted a section that moved to a command file, rewrite it to point to the command file.

- [ ] **Step 5: Commit any fixes from Steps 1–4**

If any broken links or missing content were found and fixed:

```bash
git add -A research/
git commit -m "docs(research): fix cross-refs and recover content after commands/ split"
```

If everything checked out with no fixes needed, skip this step.

---

## Task 11: Final tag + changelog entry

**Files:**
- Tag: `docs/commands-split-complete`

- [ ] **Step 1: Inspect the full file layout**

```bash
ls -1 research/ research/commands/ research/archive/
```

Expected in `research/`: `skillsmith-cli-design.md`, `skillsmith-phases.md`, plus other pre-existing research files, plus `commands/` and `archive/` directories. No `11-doctor-health.md` or `12-agents.md` at the top level.

Expected in `research/commands/`: `README.md`, `install.md`, `uninstall.md`, `sync.md`, `list.md`, `apply.md`, `doctor.md`, `agents.md`.

- [ ] **Step 2: Render-check with a markdown viewer of your choice**

Open `research/skillsmith-cli-design.md` and each `research/commands/*.md` in a markdown previewer (GitHub web, VS Code preview, `glow`, etc.). Spot-check that:
- The §2.1 command-index list renders as clickable links.
- Each command file's flag table renders (wasn't mangled by the move).
- Code fences opened in the source survived the move (every ` ``` ` has a matching closer).

```bash
for f in research/skillsmith-cli-design.md research/commands/*.md; do
  opens=$(grep -c '^```' "$f")
  if [ $((opens % 2)) -ne 0 ]; then
    echo "UNBALANCED fences in $f: $opens"
  fi
done
```

Expected: no `UNBALANCED` lines.

- [ ] **Step 3: Tag the completed state**

```bash
git tag -a docs/commands-split-complete -m "Split skillsmith-cli-design.md into commands/ per-command files"
git tag --list 'docs/*'
```

Expected: both `docs/pre-commands-split` and `docs/commands-split-complete` listed.

- [ ] **Step 4: Done**

No further commit — the last content commit was Task 10 (or Task 9 if Task 10 required no fixes).

---

## Self-review checklist

Before declaring the plan done, run through:

- [ ] Every command in the main doc's §2 command tree has a corresponding file in `research/commands/` (install, uninstall, sync, list, apply, doctor, agents) — except the auxiliaries (`config`, `completion`, `version`) which have no per-command detail to move and stay described only in the main-doc command tree.
- [ ] Every moved subsection (§3.2–§3.7, §4.2, §4.4, §4.5, all of §4.6, install/apply-specific §4.3 subsections, §2.1 per-command argument blocks) appears in exactly one new file.
- [ ] Every cross-cutting §4.3 mockup (tool-not-installed, did-you-mean, non-TTY refusal, scope/permission) stayed in the main doc.
- [ ] `research/11-doctor-health.md` and `research/12-agents.md` no longer exist at those paths; `git log --follow` shows their history on the new paths.
- [ ] Tags `docs/pre-commands-split` and `docs/commands-split-complete` both exist.
- [ ] No file has fewer characters than expected — run the line-count delta in Task 10 Step 3 as final confirmation.
