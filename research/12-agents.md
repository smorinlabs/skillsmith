# 12. Agents

`skillsmith agents` lists every supported agent Skill Smith can detect on the system — including multiple installs of the same agent at different locations. Purely informational: no health judgments, no drift checks. Think `brew list` or `mise ls`, not `brew doctor`.

## Command

**`skillsmith agents [--agent <name>]... [--detected-only] [--format markdown|json]`** — MVP.

- No arguments: scan for every supported agent at well-known locations.
- `--agent` repeatable: narrow the scan to specific agents (syntax consistent with `doctor` and `check`).
- `--detected-only`: suppress the "Not detected" section for users who only care about what's installed.
- `--format`: `markdown` (default) or `json`. Markdown is the default because the primary use case is humans asking "what's on my machine?" and markdown renders legibly both in terminal and when pasted into issues, PR descriptions, or docs.
- Always exits 0 regardless of what's found. This is an inventory command, not a gate.

## Detection

Each supported agent ships a detection module. These are the same modules that power `doctor`'s agent-detected check and legacy-installer warning — one source of truth for "where does this agent live on a system." A detection module:

1. Scans well-known locations for that agent (e.g. `/opt/homebrew/bin`, `~/.npm/bin`, `~/.local/bin`, `$PATH`, platform-specific app-bundle paths, XDG dirs).
2. Returns zero or more install records, each with:
   - **path** — absolute path to the binary or entrypoint
   - **version** — string if the binary exposes a version flag; otherwise `unknown`
   - **install method** — e.g. `brew`, `npm-global`, `native-installer`, `app-bundle`, `unknown`
3. De-duplicates by resolved path (symlinks collapsed) so the same binary reached via two symlinks doesn't double-count.

Version detection is best-effort. If running the agent with its version flag fails or times out, the entry shows `unknown` rather than being omitted — reporting an install we can't version is more useful than silently dropping it. Timeout is hard-coded (2s) for MVP; promote to a flag only if users ask.

## Output

Default markdown output:

```markdown
# Agents detected

## claude-code

| Path | Version | Install method |
|---|---|---|
| /opt/homebrew/bin/claude | 1.2.3 | brew |
| ~/.npm/bin/claude | 1.1.0 | npm-global |

## cursor

| Path | Version | Install method |
|---|---|---|
| /Applications/Cursor.app/Contents/MacOS/Cursor | 0.45.2 | app-bundle |

## Not detected

- windsurf
- aider
```

JSON output emits a structured document with the same data, one entry per agent with a nested array of install records. Schema marked experimental in the first release, consistent with `doctor --format json` and `check --format json`.

## Relationship to `doctor`

`agents` answers "what's here?"; `doctor` answers "is what's here healthy?" They share detection modules but nothing else. `doctor`'s "multiple installs of the same agent" warning is effectively `agents` run internally plus a rule: raise a warning if any agent has more than one install record. Keeping `agents` as a separate user-facing command means users can answer the inventory question without wading through health findings.

## Open questions

1. **Include not-detected agents by default?** Current spec: yes, under a "Not detected" heading, with `--detected-only` to suppress. Argument for default-on: users want to know what Skill Smith supports, not just what they happen to have installed. Argument against: noisy if the supported-agent list grows large. Your call.
2. **Version-flag timeout as a flag or hard-coded?** Leaning hard-code 2s for MVP and promote to `--timeout` only if users hit real cases where it matters.

## Feature table

| # | Feature | Phase | Why |
|---|---|---|---|
| 12.1 | **`skillsmith agents`** — list all detected installs with path, version, install method; `--agent` repeatable, `--format markdown\|json`, `--detected-only` | MVP | Inventory counterpart to `doctor`. Shared detection modules. Markdown default because the primary consumer is humans pasting output into issues and docs. |
