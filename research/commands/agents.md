# agents

> P17 disposition: shipped command evidence, not future target authority; target: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#82-agents

`skillsmith agents` lists every supported tool SkillSmith can detect on the system — including multiple installs of the same tool at different locations. Purely informational: no health judgments, no drift checks. Think `brew list` or `mise ls`, not `brew doctor`.

## Command

**`skillsmith agents [--tool <name>]... [--detected-only] [--format markdown|json]`** — MVP.

- No arguments: scan for every supported tool at well-known locations.
- `--tool` repeatable: narrow the scan to specific tools (syntax consistent with `doctor` and `check`).
- `--detected-only`: suppress the "Not detected" section for users who only care about what's installed.
- `--format`: `markdown` (default) or `json`. Markdown is the default because the primary use case is humans asking "what's on my machine?" and markdown renders legibly both in terminal and when pasted into issues, PR descriptions, or docs.
- Always exits 0 regardless of what's found. This is an inventory command, not a gate.

## Detection

Each supported tool ships a detection module. These are the same modules that power `doctor`'s tool-detected check and legacy-installer warning — one source of truth for "where does this tool live on a system." A detection module:

1. Scans well-known locations for that tool (e.g. `/opt/homebrew/bin`, `~/.npm/bin`, `~/.local/bin`, `$PATH`, platform-specific app-bundle paths, XDG dirs).
2. Returns zero or more install records, each with:
   - **path** — absolute path to the binary or entrypoint
   - **version** — string if the binary exposes a version flag; otherwise `unknown`
   - **install method** — e.g. `brew`, `npm-global`, `native-installer`, `app-bundle`, `unknown`
3. De-duplicates by resolved path (symlinks collapsed) so the same binary reached via two symlinks doesn't double-count.

Version detection is best-effort. If running the tool with its version flag fails or times out, the entry shows `unknown` rather than being omitted — reporting an install we can't version is more useful than silently dropping it. Timeout is hard-coded (2s) for MVP; promote to a flag only if users ask.

## Output

Default markdown output:

```markdown
# Tools detected

## claude-code

| Path | Version | Install method |
|---|---|---|
| /opt/homebrew/bin/claude | 1.2.3 | brew |
| ~/.npm/bin/claude | 1.1.0 | npm-global |

## codex

| Path | Version | Install method |
|---|---|---|
| /opt/homebrew/bin/codex | 0.5.1 | brew |

## Not detected

- kilo-code
- opencode
```

JSON output emits a structured document with the same data, one entry per tool with a nested array of install records. Schema marked experimental in the first release, consistent with `doctor --format json` and `check --format json`.

## Relationship to `doctor`

`agents` answers "what's here?"; [doctor](./doctor.md) answers "is what's here healthy?" They share detection modules but nothing else. `doctor`'s "multiple installs of the same tool" warning is effectively `agents` run internally plus a rule: raise a warning if any tool has more than one install record. Keeping `agents` as a separate user-facing command means users can answer the inventory question without wading through health findings.

## Open questions

1. **Include not-detected tools by default?** Current spec: yes, under a "Not detected" heading, with `--detected-only` to suppress. Argument for default-on: users want to know what SkillSmith supports, not just what they happen to have installed. Argument against: noisy if the supported-tool list grows large. Your call.
2. **Version-flag timeout as a flag or hard-coded?** Leaning hard-code 2s for MVP and promote to `--timeout` only if users hit real cases where it matters.
3. **`--format markdown|json` vs. the project-wide `--json` boolean.** Other commands use `--json` as a boolean flag (per main-doc [§1.9](../skillsmith-cli-design.md#19-output-format)). `agents` uses `--format` because markdown is a deliberate default content type, not a toggle. Acceptable divergence or should it conform?

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 12.1 | **`skillsmith agents`** — list all detected installs with path, version, install method; `--tool` repeatable, `--format markdown\|json`, `--detected-only` | MVP | Inventory counterpart to `doctor`. Shared detection modules. Markdown default because the primary consumer is humans pasting output into issues and docs. |
