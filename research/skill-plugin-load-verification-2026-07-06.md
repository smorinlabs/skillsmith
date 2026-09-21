# Skill & Plugin Load Verification — Claude Code + Codex + Muse (empirical)

**Date:** 2026-07-06 · **Verified against:** Claude Code `2.1.201`, `codex-cli 0.142.5`, macOS.
**Muse addendum:** 2026-09-20 · **Verified against:** `muse 1.3.0`, macOS.
All results below were **reproduced live**, not taken from docs. Every load was **ephemeral —
nothing was installed into the real `~/.claude`, `~/.codex`, or `~/.config/muse`.**

> Purpose: establish exactly which skill/plugin load failures each tool detects **deterministically**
> (no model probing), the exact commands, and the exact error strings — so a verifier can assert on them.

---

## TL;DR

- **Both tools deterministically detect broken skills *and* broken plugin manifests — via different surfaces.**
- **Claude Code:** one static command — `claude plugin validate <dir> [--strict]` — catches skill *and*
  plugin-manifest problems with structured messages + exit 1. **No model call, no auth, no install.**
- **Codex:** *no static validator.* Plugin-manifest errors surface at `codex plugin add` (parse error +
  non-zero); skill errors surface as **`ERROR ... failed to load skill`** lines on **stderr** during any
  session (`codex exec`). `codex plugin list --json` enumerates plugin state.
- **Critical asymmetry:** the two tools disagree on *severity* — a skill missing `description` is a
  **warning** in Claude (loads unless `--strict`) but a hard **error** in Codex (dropped). A cross-tool
  verifier cannot have one verdict; it needs a per-tool result.
- **Muse:** one static command — `muse skills validate <dir> --json` — exits 0/4 with per-skill
  reasons on stderr and a structured JSON document (diagnostics + compatibility). Deep confirmation is
  `muse skills list --source user|project --json` against staged skills; broken skills surface as
  **`malformed: <reason>`** loader diagnostics. **No model call, no auth, no install.** Muse is
  **lenient about bad YAML** (valid, with the unknown field merely reported) but strict about missing
  frontmatter/`description`.

---

## Isolation (how "ephemeral, nothing installed" was achieved)

- **Claude:** `--plugin-dir <dir>` loads a local plugin for that session only; `--setting-sources ""`
  disables user/project skill discovery so **only** the plugin under test loads (confirmed: session
  skill count dropped 67 → 16, and only `dummytest:good-skill` from our plugin appeared). Auth is
  retained (credentials are separate from setting-sources). For full isolation use a fresh
  `CLAUDE_CONFIG_DIR` (but that needs re-auth).
- **Codex:** `.agents/skills/<skill>/SKILL.md` in a throwaway project dir (repo-scoped discovery via
  `codex exec -C <dir>`); for plugins, a temp `CODEX_HOME=<tmp>` so `marketplace add` / `plugin add`
  write only to the temp home. Nothing touches real config.

---

## Test fixtures used

A plugin whose **manifest is valid** but which contains a mix of valid/broken **skills** (the
"plugin passes, skill fails" permutation), plus separate **broken-manifest** plugins:

| Fixture | Defect |
|---|---|
| `good-skill/SKILL.md` | none (control) — valid `name` + `description` |
| `bad-yaml/SKILL.md` | malformed YAML frontmatter (unterminated quote + unclosed list) |
| `bad-noframe/SKILL.md` | no `---` frontmatter block at all |
| `bad-nodesc/SKILL.md` | frontmatter present, `description` missing |
| `claude .claude-plugin/plugin.json` (badjson) | JSON syntax error (missing `}`) |
| `claude .claude-plugin/plugin.json` (noname) | valid JSON, required `name` missing |
| `codex .codex-plugin/plugin.json` (badplug) | JSON syntax error (missing `}`) — inside a valid local marketplace |

---

## Deterministic checks — CLAUDE CODE

### 1. Static validation (primary gate — no model call, no auth, no install)

```bash
claude plugin validate <plugin-dir>            # exit 1 on any error
claude plugin validate <plugin-dir> --strict   # also fail on warnings (unrecognized fields, missing metadata)
```

Observed (one plugin, mixed skills) — plugin **passes** (author warning only), each bad skill flagged:

```
Validating skill: .../bad-yaml/SKILL.md
✘ frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected character.
  At runtime this skill loads with empty metadata (all frontmatter fields silently dropped).
Validating skill: .../bad-noframe/SKILL.md
⚠ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...
Validating skill: .../bad-nodesc/SKILL.md
⚠ description: No description in frontmatter. ...
✘ Validation failed   [exit 1]
```

Broken plugin manifest (`.claude-plugin/plugin.json`):

```
# invalid JSON  →  ✘ json: Invalid JSON syntax: JSON Parse error: Expected '}'          [exit 1]
# missing name  →  ✘ name: Invalid input: expected string, received undefined            [exit 1]
```

**Severity tiers:** malformed YAML / bad JSON / missing `name` = **error** (exit 1 always);
missing frontmatter / missing `description` = **warning** (exit 1 **only** with `--strict`).

### 2. Runtime load enumeration (confirms actual availability — needs one cheap model call)

```bash
claude --print --output-format stream-json --setting-sources "" --plugin-dir <dir> "ok"
# parse the first JSON line where type=="system" && subtype=="init":
#   .plugins       -> [{name, path, source}, ...]     (loaded plugins)
#   .skills        -> ["plugin:skill", ...]           (loaded skills, namespaced)
#   .slash_commands
```

Observed: `plugins: ['dummytest']`, `skills` contained **`dummytest:good-skill`** only — the three
broken skills were **silently dropped, with ZERO stderr warning.** So runtime load is a **presence**
check; it never tells you *why* a skill failed. Use `plugin validate` for the reason.

### Also available
`claude plugin details <name>` (component inventory + token cost) · `claude plugin eval <target>`
(run eval cases) · `claude --plugin-url <zip-url>` (remote, session-only).

---

## Deterministic checks — CODEX

### 1. Plugin-manifest validation (at install — no model call)

```bash
export CODEX_HOME=$(mktemp -d)                       # isolate
codex plugin marketplace add <marketplace-root>      # root must contain .agents/plugins/marketplace.json
codex plugin add <plugin>@<marketplace>              # parses .codex-plugin/plugin.json here
codex plugin list --json                             # {installed:[...], available:[...]} — name/version/installed/enabled/source
```

Observed:
```
codex plugin add goodplug@testmkt   →  Added plugin `goodplug` ...                                   [exit 0]
codex plugin add badplug@testmkt    →  Error: failed to parse plugin.json: EOF while parsing an       [non-zero]
                                       object at line 6 column 0
codex plugin marketplace add <bad-layout>  →  Error: invalid marketplace file ...: marketplace root
                                              does not contain a supported manifest
```

Layout that `marketplace add` requires (learned empirically):
```
<root>/.agents/plugins/marketplace.json      # the manifest (NOT <root>/marketplace.json)
<root>/plugins/<name>/.codex-plugin/plugin.json
<root>/plugins/<name>/skills/<skill>/SKILL.md
```
`marketplace.json` plugin source form: `{ "source": { "source": "local", "path": "./plugins/<name>" } }`
(paths relative to `<root>`).

### 2. Skill-load errors (at session start — stderr, deterministic; needs auth + one cheap session)

```bash
codex exec -C <project-with-.agents-skills> --dangerously-bypass-approvals-and-sandbox "ok" 2>stderr.log
grep 'failed to load skill' stderr.log
```

Observed (per-skill ERROR with the specific reason):
```
ERROR codex_core::session::session: failed to load skill .../bad-yaml/SKILL.md:
   invalid YAML: found unexpected end of stream at line 3 column 23 ...
ERROR ... failed to load skill .../bad-noframe/SKILL.md: missing YAML frontmatter delimited by ---
ERROR ... failed to load skill .../bad-nodesc/SKILL.md: missing field `description`
```
The valid `good-skill` loaded into model context; the broken three did not. Codex is **loud** here
(unlike Claude runtime, which is silent).

### 3. Deterministic skill enumeration without the model (experimental)
`codex app-server` (stdio JSON-RPC; `proxy`/`daemon` subcommands) exposes `skills/list` and
`plugin/list` — reason-less **presence** enumeration, no model call. **Experimental, not driven
end-to-end here.** `codex doctor` checks install/config/auth health only — it does **not** validate skills.

### Do NOT rely on
Asking the model "list your skills" (model-probe) — non-deterministic; use it only as a sanity check.

---

## Deterministic checks — MUSE (addendum 2026-09-20, `muse 1.3.0`)

### 1. Static validation (primary gate — no model call, no auth, no install)

```bash
muse skills validate <dir> --json    # validates in place; <dir> holds skills/<name>/SKILL.md
```

Observed (dummytest fixture: good-skill, bad-yaml, bad-noframe, bad-nodesc):
```
exit 0, valid:true   →  clean target (per-skill files[] with sha256/bytes + diagnostics[])
exit 4, valid:false  →  stderr, one pair per bad skill:
   "bad-noframe" is not a valid skill
   Reason: SKILL.md must start with YAML frontmatter
   "bad-nodesc" is not a valid skill
   Reason: SKILL.md frontmatter must include description
```
The JSON document carries `diagnostics[]` (`code`/`severity`/`message`/`path`) and a
`compatibility` block (`profile: agent-skills-common-subset`, `known_fields`, `unknown_fields`,
`unsupported_fields`, `allowed_tools`). Advisory metadata the tool does not enforce surfaces as a
warning diagnostic, e.g. `unsupported-skill-field`: `` `allowed-tools` is recorded as advisory
metadata but is not enforced and grants no tool permissions ``. Unknown frontmatter fields (e.g.
`tags`, `version`) are reported in `unknown_fields`, never fatal.

**YAML leniency:** a skill whose frontmatter fails to parse still reports `valid:true` — the tool
tolerates it and reports whatever fields it recovered. A verifier must treat "muse says valid" as
"loads", not "well-formed".

### 2. Runtime load enumeration (confirms actual availability — no model call, no auth)

```bash
export HOME=$(mktemp -d) XDG_CONFIG_HOME=$HOME/.config   # isolate user scope
# stage skills/<name>/SKILL.md → $HOME/.config/muse/skills/<name>/SKILL.md
muse skills list --source user --json
# stage skills/<name>/SKILL.md → <tmp-proj>/.agents/skills/<name>/SKILL.md
muse skills list --source project --workspace <tmp-proj> --trust-workspace --json
```

Observed (dummytest staged into both scopes; both legs exit 0):
```
skill file at .../.config/muse/skills/bad-nodesc/SKILL.md is malformed:
   SKILL.md frontmatter must include description
skill file at .../.config/muse/skills/bad-noframe/SKILL.md is malformed:
   SKILL.md must start with YAML frontmatter
(+ the same two diagnostics from the project leg → 2 bad skills × 2 legs)
```
Each leg reports its own loader diagnostics (joined by path + scope); the valid `good-skill`
matched in both scopes with no presence warnings, and `bad-yaml` produced no diagnostic (same
leniency as static). Diagnostics are embedded in the JSON transcript — a non-zero exit is *not*
required to conclude failure.

### Do NOT rely on
`--source project` without `--workspace`/`--trust-workspace` (loads the ambient project, not the
staged one), and the bare non-JSON `skills list` table (no diagnostics, no paths to join on).

---

## Failure taxonomy — what "doesn't work" (observed matrix)

| Failure mode | Claude `plugin validate` | Claude runtime load | Codex |
|---|---|---|---|
| Skill: malformed YAML frontmatter | **error**, exit 1 | silent drop | **ERROR** stderr `invalid YAML … line:col` |
| Skill: no frontmatter | **warning** (exit 1 w/ `--strict`) | silent drop | **ERROR** stderr `missing YAML frontmatter delimited by ---` |
| Skill: missing `description` | **warning** | silent drop | **ERROR** stderr `missing field description` |
| Skill: valid | pass (silent) | loads `plugin:skill` | loads into context |
| Plugin manifest: invalid JSON | **error**, exit 1 (`Invalid JSON syntax`) | n/a | `codex plugin add` → `failed to parse plugin.json` (non-zero) |
| Plugin manifest: missing `name` | **error**, exit 1 (`expected string, received undefined`) | n/a | (not separately tested — expect parse/schema error at add) |
| Marketplace manifest: wrong layout/format | validates marketplace manifests too | n/a | `marketplace add` → `does not contain a supported manifest` |

---

## Recommended best practices — by TOOL

### Claude Code
1. **Primary gate: `claude plugin validate <dir> --strict`** in CI/pre-publish — static, no auth, no
   model call, exit code. Catches skill *and* manifest defects with reasons.
2. **Optional load confirmation:** `claude --print --output-format stream-json --setting-sources ""
   --plugin-dir <dir> "ok"` → assert each expected skill appears as `plugin:skill` in the `init` event.
   (Costs one cheap turn; needs auth.)
3. **Isolate** with `--setting-sources ""` (load only the plugin under test) — avoids name collisions
   with already-installed/symlinked skills that can mask namespacing.
4. **Never** treat "runtime loaded fine" as validation — broken skills drop silently.

### Codex
1. **Manifests:** `codex plugin marketplace add <root>` + `codex plugin add <plugin>@<mkt>` under a temp
   `CODEX_HOME`; non-zero + `failed to parse plugin.json` = bad manifest. Requires the
   `.agents/plugins/marketplace.json` layout.
2. **Skills:** a trivial `codex exec -C <dir> "ok"` and **grep stderr for `failed to load skill`** — each
   line names the file + reason. Needs auth + one cheap session. (`codex app-server skills/list` is the
   no-model-call alternative for presence, but experimental.)
3. **Isolate** with temp `CODEX_HOME` + `.agents/skills` in the project dir; set
   `projects.<path>.trust_level = "trusted"` if project-scoped layers are needed.
4. **Watch the format gap:** Codex loads `.agents/skills`, **not** `.claude/skills` — a skill left in
   `.claude/skills` simply never loads (needs a migration step).

### Muse
1. **Primary gate: `muse skills validate <dir> --json`** in CI/pre-publish — static, no auth, no
   model call, exit 0/4. Catches missing frontmatter/`description` with per-skill reasons; parse the
   JSON `diagnostics[]` for warnings (e.g. `unsupported-skill-field`) and `unknown_fields` for
   tolerated-but-unknown frontmatter.
2. **Load confirmation:** stage into a temp `HOME` (`~/.config/muse/skills`) and a temp project
   (`.agents/skills`), then `muse skills list --source user --json` and `muse skills list --source
   project --workspace <tmp> --trust-workspace --json` — assert each expected skill matches by
   (path, scope) and no `malformed:` diagnostic names it. No auth, no model call.
3. **Remember the leniency:** bad YAML is `valid:true` — if well-formedness matters, lint the
   frontmatter yourself; muse only promises loadability.

### Cross-tool
- **Normalize severity per tool** — the same skill can pass Claude (warning) and fail Codex (error).
- Deterministic, **no model call:** `claude plugin validate`, `codex plugin add`, `codex plugin list --json`,
  `codex app-server skills/list`, `muse skills validate --json`, `muse skills list --json`. **Needs a session:** Claude init-event enumeration, Codex `exec` stderr.
- Claude = single static command; Codex = stitch two surfaces (install for manifests, session-stderr for skills); Muse = single static command + two scoped list legs.

---

## Open / not-yet-tested
- Codex `app-server` `skills/list` / `plugin/list` JSON-RPC not driven end-to-end (experimental protocol).
- Codex plugin-manifest `missing name` (only invalid-JSON tested); marketplace-manifest schema errors
  beyond wrong-location.
- **Execution** of a loaded skill (invoking it and observing behavior) — this doc covers *load* verification only.
- Auth/cost model for CI — **RESOLVED (2026-07-07 addendum below): the deep/runtime paths are auth-free
  and model-free; init enumeration (Claude) and `failed to load skill` (Codex) fire at session start
  before any API call. Static paths were already model-free.**

---

## Addendum (2026-07-07) — deep verification is auth-independent; frozen auth-failure signatures

**Verified live against the same tools (Claude Code `2.1.201`, codex-cli `0.142.5`, macOS).** This
**supersedes the "needs auth + one cheap session/turn" qualifiers on the deep/runtime paths above**: both
tools enumerate the plugin/skills **locally at session init, before the first API turn**, so an isolated
(empty-config) session produces the load result and *then* fails auth. That auth failure is the expected,
healthy tail — not a verifier failure.

### Deep mode needs no auth and no model call

- **Claude.** Under an empty `CLAUDE_CONFIG_DIR` with `--plugin-dir <dummy-plugin> --setting-sources ""`,
  the `init` event still enumerated `dummytest:good-skill` and `plugins: ['dummytest']`; the turn then
  failed with `authentication_failed`. So the init/enumeration is available with **no auth and no model
  call** — key success on the `init` event and ignore the tail.
- **Codex.** All three `failed to load skill` stderr errors were emitted in a **fully unauthenticated**
  session that also returned `401 Unauthorized` in the same run — the skill-load surface fires before any
  model call.

### Frozen auth-failure signatures (also the test simulation recipes)

**Claude — simulate an unauthenticated run:**
```bash
CLAUDE_CONFIG_DIR=$(mktemp -d) claude --print --verbose --output-format stream-json "ok"
```
→ **exit 1**; an assistant event carrying the structured field `"error":"authentication_failed"` with
text `Not logged in · Please run /login`; a final `result` event with `is_error: true`.
**Gotcha:** `--verbose` is **required** with `stream-json` under an isolated config dir.

**Codex — simulate an unauthenticated run:**
```bash
CODEX_HOME=$(mktemp -d) codex exec --json --skip-git-repo-check -C <dir> "ok"
```
→ **exit 1**; stdout `{"type":"error","message":"…401 Unauthorized…"}` events; stderr
`ERROR codex_api…: 401 Unauthorized`. **Gotcha:** `--skip-git-repo-check` (or a trusted dir) is required
for temp workdirs.

### Consequence for a verifier

- Run deep under empty config dirs (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); no signed-in session required.
- Treat "`init` received" (Claude) / the `failed to load skill` scan (Codex) as the success signal; treat
  the trailing `authentication_failed` / `401` + exit 1 as the **expected** tail, not a finding.
- There is no auth-skip to detect: the deep skip machinery reduces to tool-missing, timeout, and
  unexpected (unparseable) failure.

**Addendum (2026-07-07):** the parser format above was re-frozen and re-verified against Claude Code
`2.1.202` live output — no shape changes; `VERIFIED_AGAINST['claude-code']` bumped to `2.1.202`.
