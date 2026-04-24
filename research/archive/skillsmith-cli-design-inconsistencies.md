# SkillSmith CLI design — inconsistency audit

Single-doc audit of [`skillsmith-cli-design.md`](./skillsmith-cli-design.md). Each finding has a stable `CID-NNN` identifier, a category, a severity, locations, a description, reasoning, and a recommended fix (with alternatives where the fix isn't obvious).

**Scope:** internal logical consistency of the CLI design doc only. External-doc comparisons, design judgments, and typos are out of scope.

**Critical findings split out.** Three highest-impact findings — **CID-003**, **CID-007**, **CID-008** — live in a sibling doc because each requires a substantive design decision before implementation can proceed: [`skillsmith-cli-design-critical-inconsistencies.md`](./skillsmith-cli-design-critical-inconsistencies.md). Their rows appear in the scan-table below for completeness and their CIDs are reserved (bodies are not duplicated here).

**Severity legend:**
- **definite** — a clear contradiction; one of the statements must change.
- **likely** — two statements are in tension, but a reconciling reading exists.
- **judgment-call** — stylistic, under-specified, or defensible either way; flagged so the team can pick a canonical answer.

---

## Summary scan-table

| CID | Category | Severity | One-liner |
|---|---|---|---|
| CID-001 | Command surface | definite | §0.5 opener says "four core verbs"; §2 and §4.1 show six. |
| CID-002 | Aliases | likely | `i` alias for `install` declared in §5 but absent from command tree and help. |
| **CID-003** | Flag definition | definite | **Critical** — see split doc. Global `-C` has no long form in §3.1, but §4.1 help shows `-C, --path`, colliding with install's `-p, --path`. |
| CID-004 | Flag table | likely | `apply` supports `--json` per §1.9 but §3.5 flag table omits it. |
| CID-005 | Flag coverage | definite | §1.9 says `--json` is supported "on `list` and `apply`"; `doctor` also supports it per §3.7, §4.5, §0.5.6. |
| CID-006 | Mockup arithmetic | definite | Doctor summary says "7 checks" but mockup contains 11. |
| **CID-007** | Store architecture | definite | **Critical** — see split doc. Store keyed by `(owner, repo, sha, skill)` with no tool qualifier, but adaptation "transforms the skill on the way into the store" per tool. |
| **CID-008** | Naming rule | definite | **Critical** — see split doc. §5 rule produces `SKILLSMITH_DEFAULT_TOOL` / `SKILLSMITH_REGISTRY_DEFAULT`; §6.3 uses `SKILLSMITH_TOOL` / `SKILLSMITH_REGISTRY`. |
| CID-009 | Exit code | likely | `apply --check` drift mockup exits 2, but §6.1 defines 2 as usage/cancellation/refused-destructive. |
| CID-010 | Mockup path | definite | Uninstall-ambiguous mockup shows user-scope path for a claude-code skill as the SkillSmith store path, not `~/.claude/skills/…`. |
| CID-011 | Mockup framing | judgment-call | Doctor "Scopes" section lists user scope as `~/.local/share/skillsmith` — SkillSmith's data dir, not a tool install path. |
| CID-012 | Source refs | likely | §1.4 lists 4 source forms; §2 and §4.2 list only 3 (one-part form missing, unflagged). |
| CID-013 | Env var semantics | judgment-call | `SKILLSMITH_VERBOSE=3+` undefined (flag is a count, env is documented as "integer 1=verbose, 2=debug"). |
| CID-014 | Flag semantics | judgment-call | `--force` means different things on install / sync / apply. |
| CID-015 | Prompt semantics | likely | Interaction between global `--no-prompt` and per-command `--yes` is undefined. |
| CID-016 | Cross-scope dup | judgment-call | §0.5.4 says cross-scope duplicates "require `--force`"; §1.6 allows `--yes` to satisfy the prompt in TTY mode. |
| CID-017 | Apply summary | judgment-call | `apply` mockup bundles counts as "3 created/updated" though §1.5 enumerates `created` and `updated` separately. |
| CID-018 | Terminology | judgment-call | `user/repo/skill-name` vs `owner/repo/skill-name` — same concept, different word. |
| CID-020 | Flag defaults | judgment-call | `--tool` default is "auto-detect" (install) vs "all detected" (sync/uninstall/doctor). |
| CID-021 | Flag coverage | likely | `--continue-on-error` exists on install/uninstall but not `apply`, despite `apply` being batch-heavy. |
| CID-022 | Flag coverage | likely | `--user` / `--system` / `--project` sugar flags appear on install and uninstall only; not on sync/apply/list/doctor. |
| CID-023 | Exit code coverage | judgment-call | Exit code 6 (scope/permission) is defined but never illustrated in any mockup. |
| CID-024 | Env var precedence | judgment-call | Relationship between `SKILLSMITH_HOME` and `XDG_DATA_HOME` is undefined. |
| CID-025 | Env var format | judgment-call | `SKILLSMITH_TOKEN` wire format (single token / multi-host map / bearer) is undefined. |
| CID-026 | Help framing | judgment-call | Top-level `--help` lists `-h` and `-V` under INHERITED FLAGS; at the root they are local. |
| CID-027 | Env var precedence | judgment-call | Precedence between `NO_COLOR` and `SKILLSMITH_NO_COLOR` is not stated. |
| CID-029 | Flag description | judgment-call | §3.4 `list --long` says "paths, sources, commit SHAs"; §1.11 claims it shows "symlink path and store path". |
| CID-030 | Env var namespace | judgment-call | Hook env `SKILLSMITH_SCOPE` / `SKILLSMITH_TOOL` collide with user-facing defaults of the same name. |

*(CID numbers are allocated contiguously; CID-019 and CID-028 were candidate findings that resolved as internally consistent on closer reading and are omitted.)*

---

## Findings

### [x] CID-001 — "Four core verbs" vs six

- **Category:** command surface
- **Severity:** definite
- **Location(s):** L3 (intro); §2 command tree (L287–L318); §4.1 help output (L504–L510)
- **Finding:** The doc opens with "The four core verbs — `install`, `sync`, `list`, `apply` — stay at depth 1…" but §2 and §4.1 both present **six** core verbs: `install`, `uninstall`, `sync`, `list`, `apply`, `doctor`.
- **Why it's an inconsistency:** The opening claim is used to justify the flat command structure. It's numerically wrong given the actual surface.
- **Recommended fix:** Change L3 to "The six core verbs — `install`, `uninstall`, `sync`, `list`, `apply`, `doctor` —". (Keeps the argument about flatness intact.)
- **Alternatives:** (a) Recast as "The core verbs stay at depth 1…" with no count; (b) distinguish "primary" verbs (install/sync/list/apply) from "companions" (uninstall/doctor) and keep "four" but name the distinction. Recommendation is (a) or the numeric fix — simplest and truest to the command tree.

DECISION: Yes do recommendation

### [x] CID-002 — `i` alias for `install`

- **Category:** aliases
- **Severity:** likely
- **Location(s):** §5 L888 (declares `i` → `install`); §2 L287 (no `i` line); §4.1 L505 (no alias shown next to `install`); §4.2 (no ALIASES block)
- **Finding:** §5 ships `i` → `install` as a built-in alias "and no more" alongside `ls` and `rm`/`remove`. The command tree and help surfaces show `ls` and `rm`/`remove` but never `i`.
- **Why it's an inconsistency:** Either the alias ships (and help/tree should surface it the same way uninstall's aliases are surfaced) or it doesn't (§5 should drop it).
- **Recommended fix:** Add an `i` line to §2 under `install` (parallel to how `ls`, `rm`, `remove` are listed), and add an ALIASES block to §4.2 similar to §4.4's.
- **Alternatives:** Drop `i` from §5 if the team doesn't want the one-letter alias at MVP.

DECISION: Yes do recommendation

### [x] CID-003 — Global `-C` long form

*Moved to [`skillsmith-cli-design-critical-inconsistencies.md`](./skillsmith-cli-design-critical-inconsistencies.md).*

FIXED

### [x] CID-004 — `apply --json` missing from flag table

- **Category:** flag table
- **Severity:** likely
- **Location(s):** §1.9 L177 ("`--json` boolean flag on `list` and `apply`"); §0.5.11 L113; §3.5 L451–L465 (no `--json` row)
- **Finding:** §1.9 states `apply` supports `--json`, but the apply flag table lacks a `--json` row. Other command flag tables duplicate inherited `--json` (e.g., §3.4 list, §3.7 doctor).
- **Why it's an inconsistency:** Either `--json` is purely inherited (in which case §3.4 and §3.7 should not restate it) or each command that supports it restates it (in which case §3.5 is incomplete). The current mix signals "doesn't support it" by omission.
- **Recommended fix:** Add a `--json` row to §3.5 apply flags, matching the format used in §3.4 and §3.7.
- **Alternatives:** Drop `--json` from §3.4 and §3.7 flag tables and rely on the global-flags listing in §3.1; note support explicitly in §1.9's list.

DECISION: Yes do recommendation

### [x] CID-005 — `--json`: which commands support it?

- **Category:** flag coverage
- **Severity:** definite
- **Location(s):** §1.9 L177 ("on `list` and `apply`"); §3.7 L490 (doctor `--json` in flag table); §4.5 L799 / L812 (doctor help advertises `--json`); §0.5.6 L74 (doctor `--json`)
- **Finding:** §1.9 names **only** `list` and `apply` as the commands that support `--json`. Four other locations in the doc document `--json` on `doctor`.
- **Why it's an inconsistency:** §1.9 is a design-decision statement, not a help snippet; it claims `--json` is scoped narrower than it is.
- **Recommended fix:** Update §1.9 to read "`--json` boolean flag on `list`, `apply`, and `doctor`" (and anywhere else it lands after CID-004 is resolved).
- **Alternatives:** If the intent is that `doctor` should *not* support `--json`, remove it from §3.7, §4.5, and §0.5.6. Unlikely — `doctor --json` is explicitly motivated for CI.

DECISION: Yes do recommendation

### [x] CID-006 — Doctor summary arithmetic

- **Category:** mockup arithmetic
- **Severity:** definite
- **Location(s):** §4.6 L822–L849 (full doctor mockup); L849 summary line "7 checks, 3 warnings, 0 failed."
- **Finding:** The mockup contains 11 check rows: 2 Environment + 4 Target tools + 3 Scopes + 1 Network + 1 Skills. Warnings count (3) is accurate: codex, system scope, cross-scope duplicate. But the total "7 checks" understates by 4.
- **Why it's an inconsistency:** The summary must mirror the body; either is load-bearing for how `doctor` reports results.
- **Recommended fix:** Change L849 to "11 checks, 3 warnings, 0 failed." (keeping same body rows).
- **Alternatives:** Shorten the mockup body to 7 rows (drop, e.g., two tools and two scopes). Recommendation: fix the summary — the rich body is pedagogically valuable.

DECISION: Yes do recommendation

### [x] CID-007 — Store keying vs cross-tool adaptation

*Moved to [`skillsmith-cli-design-critical-inconsistencies.md`](./skillsmith-cli-design-critical-inconsistencies.md).*

FIXED

### [x] CID-008 — Env var naming rule vs actual names

*Moved to [`skillsmith-cli-design-critical-inconsistencies.md`](./skillsmith-cli-design-critical-inconsistencies.md).*

FIXED

### [x] CID-009 — `apply --check` drift exit code

- **Category:** exit code
- **Severity:** likely
- **Location(s):** §3.5 L461 (`--check`: "exit non-zero if any skill would be created/updated/deleted"); §4.3 L734 (drift mockup shows "Exit code: 2"); §6.1 L912 (exit 2 = "Usage error, cancelled action, or refused destructive action without `--force`/`--yes`")
- **Finding:** The drift mockup uses exit 2, but §6.1's semantic for 2 is usage/cancellation, not drift.
- **Why it's an inconsistency:** A CI tool treating exit 2 as "bad invocation" would mishandle drift detection. A CI tool filtering drift vs. usage errors by exit code cannot tell them apart.
- **Recommended fix:** Three defensible options:
  1. Introduce a new exit code (e.g., **7 = drift detected**) and use it in the mockup; update §6.1 to document it.
  2. Route drift through **exit 1** (generic failure); §6.1 already permits "install error, network error, parse error" — drift fits as "state is not what was declared."
  3. Keep exit 2 but widen §6.1's definition to include "drift detected" as a third bullet under code 2.
- **Alternatives with recommendation:** Option **(1)** is cleanest — CI can then distinguish drift from usage error from transient failure. Exit code budget is cheap and `skillsmith help exit-codes` already exists as the reference surface. Recommend (1).

DECISION: Yes do recommendation 1. Introduce a new exit code (e.g., **7 = drift detected**)

### [x] CID-010 — Uninstall-ambiguous mockup path

- **Category:** mockup path
- **Severity:** definite
- **Location(s):** §4.6 L861–L869 (uninstall-ambiguous mockup); §1.2 L128 (scope→path mapping: user = `~/.claude/skills/`); §1.11 L198 (`~/.claude/skills/grep` as user-scope symlink)
- **Finding:** The mockup shows:
  ```
  user      /Users/alice/.local/share/skillsmith/grep     claude-code
  project   ./.claude/skills/grep                         claude-code
  ```
  The user row points to `~/.local/share/skillsmith/grep` — SkillSmith's **store/data** path, not the claude-code user-scope install path. The project row correctly points to `.claude/skills/grep`. For consistency with §1.2 and §1.11, the user row should be `/Users/alice/.claude/skills/grep`.
- **Why it's an inconsistency:** Readers learning scope→path mapping from the mockup get a wrong example for user scope.
- **Recommended fix:** Replace the user row with:
  ```
  user      /Users/alice/.claude/skills/grep              claude-code
  ```
- **Alternatives:** None; this appears to be a copy-paste error.

DECISION: Yes do recommendation

### [x] CID-011 — Doctor "Scopes" section framing

- **Category:** mockup framing
- **Severity:** judgment-call
- **Location(s):** §4.6 L836–L839 ("Scopes" block: user = `/Users/alice/.local/share/skillsmith`, project = `/Users/alice/projects/app/.claude/skills`, system = `/etc/skillsmith`)
- **Finding:** The user-scope path is SkillSmith's own data dir, project-scope is the tool's path, system-scope is SkillSmith's own system path. The "Scopes" block mixes SkillSmith scopes (for its own data/store) with tool scopes (for installed skills). These are distinct: per §6.4, SkillSmith's data lives at `$XDG_DATA_HOME/skillsmith/`, while installed skills land at tool-specific paths (`~/.claude/skills/`).
- **Why it's an inconsistency:** The doctor output reader cannot tell whether the "Scopes" block is reporting on *SkillSmith's* data directories or on *the tools'* skill directories. Probably both are worth checking, but they should be labeled.
- **Recommended fix:** Split the block into two: "SkillSmith data paths" (showing its own XDG dirs) and "Tool install paths" (per tool × scope, showing writability of `~/.claude/skills/` etc.). The latter already overlaps with the "Target tools" block; either merge into Target tools or keep a cleaner separation.
- **Alternatives with recommendation:** Merge tool paths into the existing "Target tools" block (it already shows `~/.claude/skills (writable)`) and retitle "Scopes" → "SkillSmith data directories" with `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_CONFIG_HOME`. Recommend this — cleaner separation of concerns, parallel to the split between `agents` and `doctor`.

DECISION: Yes do recommendation with cleaner separation

### [x] CID-012 — One-part source form missing from command tree and help

- **Category:** source refs
- **Severity:** likely
- **Location(s):** §1.4 L136–L141 (four forms: URL, 3-part, 2-part, 1-part `skill`); §2 L287–L291 (lists three forms: GitHub shorthand, with default org, any Git URL); §4.2 L557–L562 (lists three forms)
- **Finding:** §1.4 enumerates four source forms; the command tree and install help list three (omitting the one-part `skill` form that falls back to "default registry (future)"). Since no default registry ships, the one-part form is effectively non-functional — but the flagship source-ref section (§1.4) presents it as an accepted form.
- **Why it's an inconsistency:** A reader of §1.4 expects `skillsmith install grep` to work; the help text never advertises that it does.
- **Recommended fix:** Update §1.4 to annotate form 4 as "(requires default registry; see §1.17 — not available in MVP)" so the four-form grammar is accurate but scope is honest.
- **Alternatives:** Drop form 4 from §1.4 entirely until the default registry lands (and add back when it does). Current recommendation: annotate, not remove — the grammar is still the intended design.

DECISION: Yes do recommendation

### [x] CID-013 — `SKILLSMITH_VERBOSE` semantic beyond 2

- **Category:** env var semantics
- **Severity:** judgment-call
- **Location(s):** §3.1 L396 (`--verbose`: "count", "repeatable (`-vv` = debug)"); §6.3 L939 (`SKILLSMITH_VERBOSE`: "Integer level (1=verbose, 2=debug)")
- **Finding:** The flag is a count (unbounded in principle: `-vv`, `-vvv`). The env var is documented as accepting only 1 or 2. Behavior for `SKILLSMITH_VERBOSE=0` (falsy?), empty string, negative, or 3+ is undefined.
- **Why it's an inconsistency:** Implementation will have to pick; document doesn't guide.
- **Recommended fix:** State "any integer ≥ 0; values above 2 are treated as 2 for now" in §6.3. Or document that the env var is clamped to {0, 1, 2} and extra `-v`s beyond `-vv` are ignored — matching the env model.
- **Alternatives:** Promote `--verbose` to an enum (`off`, `verbose`, `debug`) to match the env var's finite set; lose POSIX `-vv` stacking. Recommend the first (state clamp behavior) — preserves CLI convention without under-specifying.

DECISION: Yes do recommendation

### [x] CID-014 — `--force` semantic varies

- **Category:** flag semantics
- **Severity:** judgment-call
- **Location(s):** §3.2 L416 (install: "Reinstall if present; override cross-scope duplicates"); §3.3 L436 (sync: "Override cross-scope duplicates"); §3.5 L458 (apply: "Reinstall all"); §1.5 L149; §1.6 L153
- **Finding:** Three commands define `--force` three ways. "Reinstall all" (apply) is especially broad compared to install's compound description.
- **Why it's an inconsistency:** A user building a mental model of `--force` has three definitions. Not strictly contradictory, but loose.
- **Recommended fix:** Unify description template. For each command: "`--force`: treat already-installed entries as install targets; additionally override cross-scope duplicates." Apply specifically: "forces reinstall of all manifest entries regardless of unchanged status; overrides cross-scope duplicates."
- **Alternatives:** Split into two flags: `--force` (override duplicate gates) and `--reinstall` (treat already-present as install targets). More precise but diverges from §1.5/§1.6's combined semantic. Recommend the template unification — cheaper, still clear.

DECISION: Yes do recommendation

### [x] CID-015 — `--no-prompt` × `--yes` interaction

- **Category:** prompt semantics
- **Severity:** likely
- **Location(s):** §3.1 L402 (`--no-prompt`: "Never prompt; fail if input needed"; default auto-from-TTY); §3.2 L417 and §3.6 L477 (`--yes`: "Skip confirmation prompts"); §1.6 L153 (cross-scope prompt gating)
- **Finding:** Global `--no-prompt` auto-activates in non-TTY. Per-command `--yes` suppresses prompts by auto-confirming. Unclear: in non-TTY mode with `--yes` passed, does `--no-prompt`'s "fail if input needed" behavior still fire (since input is still needed before `--yes` auto-confirms), or does `--yes` short-circuit the prompt? And if both are passed explicitly in a TTY, which wins?
- **Why it's an inconsistency:** Every CLI with both eventually has to document precedence; the doc currently doesn't.
- **Recommended fix:** Add a paragraph (naturally in §1.6 or a new §1.8a) stating: "`--yes` auto-confirms a prompt; `--no-prompt` refuses to show one. When both would apply, `--yes` wins — the user has pre-authorized the action, so there is no prompt to suppress. `--no-prompt` only takes over when `--yes` has not been supplied."
- **Alternatives:** Make `--yes` imply `--no-prompt`. Or make `--no-prompt` alone sufficient to auto-fail on prompts without `--yes`. Recommend the first (docs paragraph) — preserves both flags with clear precedence.

DECISION: Yes do recommendation

### [x] CID-016 — Cross-scope duplicate: `--yes` sufficient?

- **Category:** cross-scope dup
- **Severity:** judgment-call
- **Location(s):** §0.5.4 L60 ("require `--force` to proceed; TTY prompts, non-TTY exits 2"); §1.6 L153 ("if a cross-scope hit is detected and neither `--force` nor `--yes` was passed, SkillSmith prompts")
- **Finding:** §0.5.4 says `--force` is required; §1.6 accepts `--force` *or* `--yes` (in TTY, the prompt fires only when both are absent). So in TTY mode, `--yes` alone will satisfy the cross-scope gate — §0.5.4 misrepresents this.
- **Why it's an inconsistency:** Summary statement (§0.5) should match detailed decision (§1.6).
- **Recommended fix:** Update §0.5.4 L60 to "Cross-scope duplicate: list the other-scope installs with paths; in TTY mode, SkillSmith prompts unless `--force` or `--yes` was passed; in non-TTY mode, `--force` is required (without it, exit 2)."
- **Alternatives:** Tighten §1.6 to require `--force` even in TTY when cross-scope, making `--yes` insufficient for this specific gate. More paranoid, slightly less ergonomic. Recommend fixing §0.5.4 to match §1.6 — less friction, explicit prompt still shown.

DECISION: Yes do recommendation

### [x] CID-017 — Apply summary format

- **Category:** apply summary
- **Severity:** judgment-call
- **Location(s):** §1.5 L149 ("print `created`, `updated`, `unchanged`, `skipped` per skill, with aggregate counts at the end"); §4.3 L721 ("5 skills: 3 created/updated, 1 unchanged, 1 skipped, 0 failed.")
- **Finding:** §1.5 enumerates four distinct status labels at aggregate level. The mockup bundles `created` + `updated` into a combined "3 created/updated" count. `failed` is additionally added (not in §1.5's four).
- **Why it's an inconsistency:** Sum is still 5, but the shape differs from the design spec.
- **Recommended fix:** Mockup summary → "5 skills: 2 created, 1 updated, 1 unchanged, 1 skipped, 0 failed." Update §1.5 to include `failed` in the aggregate so the spec matches.
- **Alternatives:** Keep the combined "created/updated" in the mockup and update §1.5 to acknowledge a combined reporting form. Recommend the first (separate counts) — matches kubectl-style and is strictly more information.

DECISION: Yes do recommendation

### [x] CID-018 — `user/repo/skill-name` vs `owner/repo/skill-name`

- **Category:** terminology
- **Severity:** judgment-call
- **Location(s):** §1.4 L139 ("`user/repo/skill-name` → GitHub by default"); §2 L289 (`owner/repo/skill-name`); §4.2 L559 (`owner/repo/skill-name`); §0.5.10 L103 (`owner/repo/skill-name`)
- **Finding:** One section uses `user`; three use `owner`. GitHub's own docs say "owner/repo".
- **Why it's an inconsistency:** Minor; reader has to notice they mean the same thing.
- **Recommended fix:** Replace `user/repo/skill-name` with `owner/repo/skill-name` in §1.4 L139.
- **Alternatives:** None — `owner` is the GitHub convention and matches §2/§4.2/§0.5.10.

DECISION: Yes do recommendation

### [x] CID-020 — `--tool` default phrasing

- **Category:** flag defaults
- **Severity:** judgment-call
- **Location(s):** §3.2 L410 ("(auto-detect)"); §3.3 L434, §3.6 L471, §3.7 L486 ("all detected"); §3.4 L445 ("all"); §3.5 L456 ("from manifest"); §4.2 L566 ("auto-detect installed tools")
- **Finding:** Five flag tables use at least four different phrasings for the default.
- **Why it's an inconsistency:** "auto-detect" (install) and "all detected" (sync/uninstall/doctor) could be the same semantic or different — is install's default "install into each detected tool" or "prompt the user to pick one"? §4.3 interactive mockup suggests the latter.
- **Recommended fix:** Adopt a consistent vocabulary:
  - "all detected tools" — commands that operate across all tools by default (sync, uninstall, doctor, list).
  - "auto-detect; prompts in TTY, uses first detected in non-TTY" — install (clarify semantic).
  - "from manifest" — apply (keep; clear).
- **Alternatives:** Collapse to one phrase across all commands; let each command clarify semantic in its §4.x help. Recommend the per-command clarification, since install's interactive flow is genuinely different.

DECISION: Yes do recommendation

### [x] CID-021 — `--continue-on-error` coverage

- **Category:** flag coverage
- **Severity:** likely
- **Location(s):** §3.2 L426 (install has it); §3.6 L480 (uninstall has it); §3.5 (apply does not); §3.3 (sync does not)
- **Finding:** `apply` is the most batch-heavy command (manifests can list N skills). If an early entry fails, the default is fail-fast. No override is documented.
- **Why it's an inconsistency:** Functional gap, not a direct contradiction, but unlikely to be intentional given that install (smaller batches) has it.
- **Recommended fix:** Add `--continue-on-error` to §3.5 apply flag table with the same semantic ("keep going after per-skill failures"). Consider for sync as well (batch copy).
- **Alternatives:** Document in §1.5 that `apply` is always fail-fast (and failure exit honors the §6.1 batch-max rule). Recommend adding the flag — users running `apply` in CI will want "report everything that failed" at least some of the time.

DECISION: Yes do recommendation

### [x] CID-022 — Scope sugar flags coverage

- **Category:** flag coverage
- **Severity:** likely
- **Location(s):** §3.2 L412–L414 (install has `--user` / `--system` / `--project`); §3.6 L473–L475 (uninstall has them); §3.3/§3.4/§3.5/§3.7 (sync, list, apply, doctor do not); §1.3 L132 (scope sugar flags accepted as equivalents to `--scope=<value>`)
- **Finding:** §1.3 describes the scope sugar flags as a general ergonomic equivalent to `--scope=<value>`. Only two of six core commands actually expose them.
- **Why it's an inconsistency:** Users learning "the sugar flags are always available" will hit errors on sync/list/apply/doctor.
- **Recommended fix:** Expose `--user` / `--system` / `--project` on every command that accepts `--scope`. Update §3.3, §3.4, §3.5, §3.7.
- **Alternatives:** Restrict §1.3's claim to "on install and uninstall" and strike the generality. Recommend uniform coverage — sugar flags are cheap and the current split is arbitrary.

DECISION: Yes do recommendation

### [x] CID-023 — Exit code 6 illustrated nowhere

- **Category:** exit code coverage
- **Severity:** judgment-call
- **Location(s):** §6.1 L916 (exit 6 = "Scope/permission error"); mockups in §4.3 and §4.6 (no example)
- **Finding:** Every other exit code in §6.1 appears in at least one mockup or decision statement. Exit 6 is defined and then never used.
- **Why it's an inconsistency:** Under-specified. Implementer has to infer when exactly this fires — before or after permission-prompt flow, for --system without sudo, for read-only mounted tool paths, etc.
- **Recommended fix:** Add a short error mockup in §4.3 for "cannot write to system scope without privileges", exiting 6. Also surface this as a §4.6 `doctor` warning (already partially shown: L839 "not writable; sudo required for --system" — but no exit code mentioned).
- **Alternatives:** Fold exit 6 into exit 1 (generic failure) and drop it from §6.1. Recommend adding the mockup — scope/permission is a genuinely distinguishable failure mode that CI may want to branch on.

DECISION: Yes do recommendation

### [x] CID-024 — `SKILLSMITH_HOME` vs `$XDG_DATA_HOME`

- **Category:** env var precedence
- **Severity:** judgment-call
- **Location(s):** §6.3 L931 (`SKILLSMITH_HOME`: "Override XDG data dir for installed skills"); §1.11 L190 (store path uses `$XDG_DATA_HOME/skillsmith/store/…`); §6.4 L963 (same); §6.3 L954 (`XDG_DATA_HOME` honored)
- **Finding:** Two override paths exist. Precedence is not stated. If both are set, which wins?
- **Why it's an inconsistency:** Implementer has to pick.
- **Recommended fix:** Document explicitly (in §6.3 or §6.4): "`SKILLSMITH_HOME`, if set, overrides `$XDG_DATA_HOME/skillsmith/` entirely. If unset, the data dir is `$XDG_DATA_HOME/skillsmith/` (default `~/.local/share/skillsmith/`)."
- **Alternatives:** Drop `SKILLSMITH_HOME` entirely — rely on `XDG_DATA_HOME`. Recommend the clarifying text; `SKILLSMITH_HOME` is useful for relocating just this tool's data without affecting all XDG consumers.

DECISION: Yes do recommendation

### [x] CID-025 — `SKILLSMITH_TOKEN` format

- **Category:** env var format
- **Severity:** judgment-call
- **Location(s):** §6.3 L937 (`SKILLSMITH_TOKEN`: "Git/API token for private sources")
- **Finding:** Single string token. Behavior for multi-host setups (GitHub + GitLab + private GitLab) undefined. Scheme (bearer vs basic vs PAT) undefined.
- **Why it's an inconsistency:** Most users today have >1 token.
- **Recommended fix:** Extend to a minimal convention: `SKILLSMITH_TOKEN` is the default token used for any source host. Per-host override via `SKILLSMITH_TOKEN_<HOST>` (e.g., `SKILLSMITH_TOKEN_GITHUB_COM`). Git-credential-helper integration deferred to a later phase.
- **Alternatives:** Rely on Git's own credential helper chain (`git config credential.helper`) and have `SKILLSMITH_TOKEN` be an override. Recommend the per-host env pattern — simpler to reason about for the user and CI, and doesn't couple to Git credential state.

DECISION: Yes do recommendation

### [x] CID-026 — Root-level `-h`/`-V` framed as INHERITED

- **Category:** help framing
- **Severity:** judgment-call
- **Location(s):** §4.1 L526–L536 (top-level help lists `-h --help`, `-V --version` under INHERITED FLAGS)
- **Finding:** At the root command, `-h` and `-V` aren't inherited from anywhere; they're local to the root. They're correctly inherited *by* subcommands, but "INHERITED FLAGS" at the root is framed from the wrong viewpoint.
- **Why it's an inconsistency:** Cosmetic; gh has the same framing. Not strictly wrong.
- **Recommended fix:** Accept as convention — matches gh and Cobra behavior. If a strict fix is desired, rename the root section from "INHERITED FLAGS" to "GLOBAL FLAGS" at the root only.
- **Alternatives:** Leave as-is. Recommend leaving as-is — aligns with gh precedent cited in the doc's opening.

DECISION: Yes do recommendation

### [x] CID-027 — `NO_COLOR` vs `SKILLSMITH_NO_COLOR`

- **Category:** env var precedence
- **Severity:** judgment-call
- **Location(s):** §3.1 L399 (`--no-color` env: "`NO_COLOR`, `SKILLSMITH_NO_COLOR`"); §6.3 L941 (`SKILLSMITH_NO_COLOR`: "Non-empty = disable color (fallback to NO_COLOR)")
- **Finding:** §3.1 lists both env vars in one cell with no precedence. §6.3 says `SKILLSMITH_NO_COLOR` "falls back to" `NO_COLOR`, implying `SKILLSMITH_NO_COLOR` wins (consulted first).
- **Why it's an inconsistency:** The no-color.org standard says `NO_COLOR` wins unconditionally when set. If a user sets `NO_COLOR=1` and `SKILLSMITH_NO_COLOR=` (empty), should color be disabled? By the no-color.org standard: yes.
- **Recommended fix:** Align with no-color.org: "Color is disabled if either `NO_COLOR` or `SKILLSMITH_NO_COLOR` is non-empty. `--color=always` / `FORCE_COLOR` re-enable. `SKILLSMITH_NO_COLOR` has no precedence advantage over `NO_COLOR`."
- **Alternatives:** Invert — `SKILLSMITH_NO_COLOR` wins. Less surprising to SkillSmith users, more surprising to everyone. Recommend no-color.org alignment.

DECISION: Yes do recommendation

### [x] CID-029 — `list --long` description mismatch

- **Category:** flag description
- **Severity:** judgment-call
- **Location(s):** §3.4 L449 (`--long`: "Show paths, sources, commit SHAs"); §1.11 L203 ("`list --long` shows both the symlink path and the store path")
- **Finding:** §3.4 says three columns (paths/sources/SHAs). §1.11 says two paths (symlink + store). The two descriptions aren't contradictory but §3.4 is ambiguous about whether "paths" is one column or two.
- **Why it's an inconsistency:** Minor; affects what a reader builds for the column layout.
- **Recommended fix:** Update §3.4 L449 to "Show symlink path, store path, source, and commit SHA."
- **Alternatives:** Leave §3.4 as-is and have implementation decide. Recommend the explicit fix — matches §1.11 and gives CI consumers a clear schema to parse.

DECISION: Yes do recommendation

### [x] CID-030 — Hook env var namespace collision

- **Category:** env var namespace
- **Severity:** judgment-call
- **Location(s):** §1.13 L227 (hook env: `SKILLSMITH_SKILL_NAME`, `SKILLSMITH_SKILL_PATH`, `SKILLSMITH_SCOPE`, `SKILLSMITH_TOOL`, plus "resolved values"); §6.3 L933–L934 (`SKILLSMITH_TOOL`, `SKILLSMITH_SCOPE` as user-facing defaults)
- **Finding:** The hook env reuses two names (`SKILLSMITH_TOOL`, `SKILLSMITH_SCOPE`) that are also user-facing default-control env vars. In a hook, is `SKILLSMITH_TOOL` "the tool for the current install operation" or "the user's default tool preference"? These can differ when the user explicitly passes `--tool X` to override their default.
- **Why it's an inconsistency:** A skill's hook script that reads `$SKILLSMITH_TOOL` to know the target would be correct. A hook script that spawns a sub-`skillsmith` call would pick up the same value as the user's default — likely fine but potentially surprising.
- **Recommended fix:** Namespace the hook env: `SKILLSMITH_HOOK_TOOL`, `SKILLSMITH_HOOK_SCOPE`, `SKILLSMITH_HOOK_SKILL_NAME`, `SKILLSMITH_HOOK_SKILL_PATH`. Then the user-facing defaults retain their semantic and hook scripts read hook-scoped vars.
- **Alternatives:** Keep the current names and document that within hooks, the two user-facing vars always reflect the current operation (overriding any user default). Recommend the namespaced form — unambiguous and leaves room for future hook-specific env additions (e.g., `SKILLSMITH_HOOK_PHASE=pre-install`).

DECISION: Yes do recommendation

---

## Coverage note

Four dimensions from the audit plan produced no findings worth flagging and are noted here for completeness:

- **Idempotence claims** — §1.5, §0.5.4, §2 command-tree, and mockups are mutually consistent on idempotent-exit-0 behavior.
- **Values-layering precedence** — §0.5.9 and §1.12 describe the same order from different directions (low→high vs. high→low); both match.
- **Help-topic list** — §1.10, §0.5.11, §2 command tree, and §4.1 all enumerate the same six topics in the same order.
- **Cross-reference integrity** — all `§X.Y` pointers in §0.5 resolve to existing sections. Some point to §4 without a subsection (e.g., "apply mockup"); they're vague but not broken.
