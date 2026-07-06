# SkillSmith P11 design — `skillsmith verify` — "Does this load in each tool?"

**Status:** Draft (2026-07-06) — pending approval. This is the P11-BR deliverable.
**Scope:** One new read-only command, `skillsmith verify <path>`, that loads a plugin under
each target tool's own verifier and reports a **per-tool result matrix** (never one merged verdict).
Static (no-model, no-auth) by default; `--deep` opt-in adds a session-backed load confirmation.
**Release framing:** `v0.4.0` (minor `feat` — new command). Internal milestone; no public release.
**Prerequisite:** `v0.3.2` (P10) tagged; per-agent modules and the `Result`/`Finding` foundations live.
**Consumer contract:** the `--json` output is a versioned public contract consumed by the
smorin-harness skill-fleet `skill-verify` skill (P09). It is versioned here and evolved additively.
**Empirical basis:** `research/skill-plugin-load-verification-2026-07-06.md` — every command, error
string, and severity below was reproduced live against **Claude Code `2.1.201`** and
**codex-cli `0.142.5`** on macOS. This spec does not invent capabilities beyond what that doc proved.

---

## 1. Background and goal

Skills and plugins fail to load in silent, tool-specific ways: malformed frontmatter, a missing
`description`, a broken plugin manifest. The two tools SkillSmith targets first — Claude Code and
Codex — **detect those failures deterministically, but through different surfaces and with different
severities**. The research doc proves the sharpest example: a skill missing `description` is a
**warning** in Claude (loads unless `--strict`) and a hard **error** in Codex (silently dropped).

`skillsmith verify <path>` runs each tool's own verifier against a plugin directory and returns what
each tool actually reports. The command's defining constraint, inherited directly from the research:
**there is no single cross-tool verdict.** The output is a matrix — one result per (tool, mode) — and
the cross-tool severity disagreement is preserved, never collapsed.

`verify` is a sibling of `doctor`/`check`: `doctor` diagnoses *the environment*, `verify` diagnoses
*an artifact*. Both return `Result` from core and let the CLI own exit codes and rendering.

### 1.1 Non-goals (this command)

- **Skill execution.** We verify *load*, not behavior. Invoking a loaded skill is out of scope.
- **kilo-code / opencode.** Neither ships a load verifier we have proven. Their agent slots exist but
  `verify` targets `{claude-code, codex}` only. Requesting them → usage error (exit 2).
- **Agent-SDK mechanism.** We shell out to the `claude`/`codex` CLIs (decision already taken —
  CLI-first). The SDK is a possible follow-up, not part of this spec.
- **Auto-fix.** `verify` is read-only. Remediation is text (per finding), never applied.

---

## 2. The proven surfaces (what each (tool, mode) actually checks)

This table is the load-bearing input to every decision below. It is a condensed restatement of the
research failure taxonomy; the research doc is authoritative.

| Tool · mode | Command (proven) | Auth / model | Covers manifest | Covers skills | Gives reasons |
|---|---|---|---|---|---|
| **claude · static** | `claude plugin validate <dir> [--strict]` | none | ✅ | ✅ | ✅ (`✘`/`⚠` + text) |
| **claude · deep** | `claude --print --output-format stream-json --setting-sources "" --plugin-dir <dir> "ok"` → parse `init` event | auth + 1 model turn | — | presence only | ❌ (broken skills drop **silently**) |
| **codex · static** | temp `CODEX_HOME`; `codex plugin marketplace add <root>`; `codex plugin add <p>@<mkt>`; `codex plugin list --json` | none | ✅ | ❌ | ✅ for manifest (`failed to parse plugin.json`) |
| **codex · deep** | temp `CODEX_HOME`; `codex exec -C <proj> --dangerously-bypass-approvals-and-sandbox "ok" 2>err`; grep `failed to load skill` | auth + 1 session | — | ✅ | ✅ (`ERROR … failed to load skill <file>: <reason>`) |

**Three consequences drive the design:**

1. **Claude static is the whole gate for Claude** (manifest + skills, no auth). Claude deep only adds
   *presence* confirmation and, critically, **cannot say why** a skill failed.
2. **Codex static covers only the manifest.** Codex validates *skills* exclusively at session start
   (deep). So a codex result in `--static` mode has a real coverage gap that must be surfaced, not
   hidden behind a green checkmark.
3. **The same defect earns different severities per tool.** Any model that emits one verdict is wrong.

---

## 3. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Input is a plugin directory** (contains `.claude-plugin/plugin.json` and/or `.codex-plugin/plugin.json`, with skills under `skills/<name>/SKILL.md`). Not a directory → exit 2. | This is exactly what the proven commands consume (`claude plugin validate <dir>`; the codex marketplace wrapper). Bare-skill input is Open Question 1. |
| D2 | **Per-tool matrix, never a merged verdict.** `VerifyReport.tools[]` holds one `ToolVerdict` per tool; each `ToolVerdict.modes[]` holds one `ModeResult` per mode run. | The research proves cross-tool severity disagreement. A single verdict would erase it. |
| D3 | **Default = static, all *detected* tools. `--deep` is additive opt-in (runs static **then** deep).** | Static needs no auth and spends no model call; it is the correct CI default. Deep costs auth + a model turn on Claude, so it is opt-in. Deep implies static (deep confirms load; static supplies the reasons). |
| D4 | **Dual severity per finding: `toolSeverity` (native token, verbatim) + `normalizedSeverity` (SkillSmith 3-level axis).** Findings are nested per (tool, mode); nothing is merged across tools. | Consumers get a stable axis to filter on **without** losing what each tool said. Because findings live under their tool, the disagreement is preserved structurally, not flattened. |
| D5 | **Coverage is explicit per (tool, mode)** via `coverage: {manifest, skills}`, and a coverage gap is surfaced as a prominent notice (e.g. "codex static checks the manifest only; run `--deep` for skill validation"). | Codex static's manifest-only coverage would otherwise read as a false green. Honesty over a clean checkmark. |
| D6 | **Explicit-is-required, default-is-best-effort.** A tool named with `--tool` MUST be available; an auto-detected tool that is absent is a silent skip. `--deep` named explicitly MUST deliver deep coverage for required tools. | Lets the fast default tolerate a machine without codex, while making a deliberate `--tool codex --deep` a real gate. This one principle governs both flag handling and exit codes. |
| D7 | **Exit codes reuse the documented set (§9).** `0` verified · `1` verified-failed · `2` usage · `4` could-not-verify · `130` SIGINT. `1` (a proven defect) **outranks** `4` (an environment gap). | CI must tell "the artifact is broken" from "I couldn't check it" (task requirement). No new numeric codes are minted; code 4's meaning is extended from "tool not installed" to "verification prerequisite unavailable." A proven break is more actionable than a gap, so `1 > 4` — this deliberately overrides the batch-max rule in `skillsmith-cli-design.md §6.1`. |
| D8 | **Shell out; isolate with temp dirs; surface version drift, don't fail on it.** Claude static is read-only; claude deep isolates with `--setting-sources "" --plugin-dir`; codex uses a throwaway `CODEX_HOME`. Observed `claude`/`codex` versions are recorded and compared to the verified-against matrix; drift adds a notice. | Matches the proven isolation. Parsers key on stable substrings, so a version bump degrades to a warning, never a silent misparse. |
| D9 | **`--json` is a versioned contract** (`schemaVersion: 1`, `kind: "skillsmith.verify"`), evolved additively. | It is consumed by another repo's skill (P09). Versioning is mandatory; additive-only keeps the P09 consumer from breaking. |
| D10 | **Checkers live per-agent** (`agents/claude-code/verify.ts`, `agents/codex/verify.ts`); a `verify/` orchestrator assembles the report; core returns `Result`, the CLI owns exit codes + output. | The house per-agent boundary (CLAUDE.md) and the core/CLI split (ADR 0001). |

---

## 4. CLI surface

```
skillsmith verify <path> [--tool claude-code|codex]... [--static | --deep] [--strict] [--json]
```

| Flag | Short | Type | Default | Semantics |
|---|---|---|---|---|
| `<path>` | — | positional (required) | — | Plugin directory to verify (D1). Missing/not-a-dir/not-a-plugin → exit 2. |
| `--tool` | `-t` | enum, repeatable | all **detected** of `{claude-code, codex}` | Restrict to tool(s). A named-but-absent tool is a hard "could-not-verify" (D6 → exit 4). Values other than `claude-code`/`codex` → exit 2. |
| `--static` | — | bool | on | Static mode only (no auth, no model call). This is the default; the flag states it explicitly. |
| `--deep` | — | bool | off | Also run deep mode (session-backed). Implies static (D3). Needs auth + one model turn per tool. |
| `--strict` | — | bool | off | Treat any `warning` finding as a failure (mode verdict `warn` → `fail`); also passed through to `claude plugin validate --strict`. Mirrors doctor `--strict`. |
| `--json` | — | bool | off | Emit the versioned JSON contract on stdout (§8). |

Inherited global flags apply unchanged (`-C/--cd`, `--no-color`/`--color`, `-v/--verbose`, `-q/--quiet`,
`--no-prompt`, `--debug`; see `skillsmith-cli-design.md §3.1`). `verify` never prompts, so `--no-prompt`
is a no-op here. `--static` and `--deep` are not a mutually-exclusive error pair: passing both equals
`--deep` (the mode set is `{static, deep}`); passing neither equals `--static`.

**Mode set resolution:** `--deep` → `{static, deep}`; otherwise → `{static}`.
**Tool set resolution:** `--tool X --tool Y` → `[X, Y]` (required); none → tools detected on PATH (best-effort).

---

## 5. Result model (core types)

Types live in `packages/core/src/verify/types.ts`, exported from `public-types.ts`. Names align with
P11-T01 (`VerifyReport` / `ToolVerdict` / finding). The finding type is `VerifyFinding` (not `Finding`)
to avoid collision with the existing doctor `Finding` already exported from `public-types.ts`.

```ts
export type VerifyMode = 'static' | 'deep';
export type NormalizedSeverity = 'error' | 'warning' | 'info';
export type VerifyOutcome = 'pass' | 'warn' | 'fail';          // a produced verdict
export type SummaryVerdict = VerifyOutcome | 'inconclusive';   // rollup when nothing ran
export type ModeStatus = 'ran' | 'skipped' | 'error';          // did the checker run?

export interface VerifyFinding {
  checkId: string;                    // e.g. 'claude.frontmatter' | 'codex.skill-load' | 'codex.manifest'
  toolSeverity: string | null;        // native token verbatim: 'error' | 'warning' (claude), 'error' (codex);
                                       //   null for synthesized deep-presence findings (tool reports nothing)
  normalizedSeverity: NormalizedSeverity;
  message: string;                    // the tool's own message (verbatim or lightly trimmed)
  file: string | null;                // SKILL.md / plugin.json path, relative to <path> when known
  subject: 'skill' | 'manifest' | 'marketplace' | 'plugin';
  raw?: string;                       // optional: the raw tool line, for --debug and forward-compat
}

export interface ModeResult {
  mode: VerifyMode;
  status: ModeStatus;                 // 'ran' | 'skipped' | 'error'
  skipReason: string | null;          // when status !== 'ran': 'auth-required' | 'timeout' |
                                       //   'not-installed' | 'unsupported' | 'exec-error'
  coverage: { manifest: boolean; skills: boolean };  // what THIS (tool,mode) actually inspected
  verdict: VerifyOutcome | null;      // null unless status === 'ran'
  command: string;                    // the command line run (redacted of temp paths), for auditability
  findings: VerifyFinding[];
}

export interface ToolVerdict {
  tool: 'claude-code' | 'codex';
  available: boolean;                 // detected on PATH
  toolVersion: string | null;         // observed CLI version, or null when unavailable
  versionDrift: boolean;              // observed !== verifiedAgainst[tool]
  skipReason: string | null;          // when !available: 'not-installed'
  verdict: SummaryVerdict;            // overall per-tool verdict = worst of ran modes; 'inconclusive' if none ran
  modes: ModeResult[];                // empty when !available
}

export interface VerifyReport {
  schemaVersion: 1;
  target: { path: string; kind: 'plugin' };
  requested: { tools: ('claude-code' | 'codex')[]; modes: VerifyMode[]; strict: boolean; explicitTools: boolean };
  verifiedAgainst: Record<'claude-code' | 'codex', string>;   // the version matrix this build was proven against
  summary: {
    verdict: SummaryVerdict;
    verified: ('claude-code' | 'codex')[];   // tools with a produced pass/warn verdict
    failed: ('claude-code' | 'codex')[];      // tools with a fail verdict
    skipped: ('claude-code' | 'codex')[];     // tools that could not run
    counts: { error: number; warning: number; info: number };  // normalized-severity totals across all findings
  };
  tools: ToolVerdict[];
}
```

**Verdict rollups** (precedence `fail > warn > pass`):

- `ModeResult.verdict` — `fail` if any finding is `normalizedSeverity: 'error'`, **or** (`--strict` and any
  `warning`); else `warn` if any `warning`; else `pass`. `null` when the mode did not run.
- `ToolVerdict.verdict` — worst of its ran `ModeResult.verdict`s; `inconclusive` if none ran.
- `summary.verdict` — worst across `ToolVerdict.verdict`s that ran; `inconclusive` if nothing ran.

---

## 6. Severity normalization (preserving disagreement)

Normalization maps each tool's **native** severity token into SkillSmith's 3-level axis, **per finding,
under the tool that produced it**. It never merges findings across tools, so cross-tool disagreement is
retained by construction.

| Tool line (proven) | `toolSeverity` | `normalizedSeverity` | Notes |
|---|---|---|---|
| Claude `✘ frontmatter: YAML … failed to parse` | `error` | `error` | malformed YAML / bad JSON / missing `name` = always exit 1 |
| Claude `⚠ description: No description …` | `warning` | `warning` | missing frontmatter / missing `description` = warning (exit 1 only with `--strict`) |
| Codex `ERROR … failed to load skill …: missing field description` | `error` | `error` | Codex drops the skill — a hard error |
| Codex `Error: failed to parse plugin.json: …` | `error` | `error` | manifest parse failure at `plugin add` |
| Codex `Error: … does not contain a supported manifest` | `error` | `error` | marketplace-layout failure at `marketplace add` |
| Claude deep: expected skill absent from `init.skills` | `null` | `warning` | **synthesized.** Claude drops silently, so there is no native token; deep only proves presence, so a gap is a warning, not a fail. |

**Worked example — one skill missing `description`, verified with `--deep`:**

- Under `claude-code`: `{checkId: 'claude.description', toolSeverity: 'warning', normalizedSeverity: 'warning', subject: 'skill'}` → claude `ToolVerdict.verdict = warn`.
- Under `codex`: `{checkId: 'codex.skill-load', toolSeverity: 'error', normalizedSeverity: 'error', message: 'missing field description', subject: 'skill'}` → codex `ToolVerdict.verdict = fail`.

Both live in the report. The matrix shows **claude = warn, codex = fail for the same defect** — the
disagreement is the answer, not a bug to reconcile.

---

## 7. Subprocess strategy

All subprocess execution goes through a new injected primitive on `ScanEnv` (see §10) so core stays
pure and the parsers are unit-testable against canned output. Every checker cleans up its temp dirs in
a `finally`. Nothing writes to the real `~/.claude` or `~/.codex`.

### 7.1 claude-code

- **Static:** `claude plugin validate <path>` (append `--strict` when `verify --strict`). Read-only — no
  temp dir. Parse stdout/stderr lines: `Validating skill: <file>` sets the current file context; `✘
  <check>: <msg>` → error finding; `⚠ <check>: <msg>` → warning finding. Manifest lines (`✘ json:` /
  `✘ name:`) → `subject: 'manifest'`. `coverage = {manifest: true, skills: true}`. We compute the mode
  verdict from parsed findings, not from claude's own exit code (which we still record).
- **Deep:** `claude --print --output-format stream-json --setting-sources "" --plugin-dir <path> "ok"`.
  Read the first JSON line where `type === 'system' && subtype === 'init'`; take `.plugins`, `.skills`
  (namespaced `plugin:skill`), `.slash_commands`. For each skill discovered in `<path>/*/skills` (or the
  plugin's declared skills) that is **absent** from `init.skills`, emit a synthesized presence finding
  (§6). `coverage = {manifest: false, skills: true(presence-only)}`. Auth is retained via inherited
  credentials; `--setting-sources ""` guarantees only the plugin under test loads.

### 7.2 codex

Codex requires **synthesizing the layout it expects** from the plugin under test (proven in research):

- **Static (manifest):** `CODEX_HOME=$(mktemp -d)`. Build a temp marketplace root:
  `<root>/.agents/plugins/marketplace.json` (`{"source":{"source":"local","path":"./plugins/<name>"}}`),
  `<root>/plugins/<name>/.codex-plugin/plugin.json` (copied from `<path>`), skills copied under
  `<root>/plugins/<name>/skills/`. Run `codex plugin marketplace add <root>` then
  `codex plugin add <name>@<mkt>`; a non-zero exit with `failed to parse plugin.json` →
  `{checkId:'codex.manifest', subject:'manifest'}`; `does not contain a supported manifest` →
  `{subject:'marketplace'}`. `codex plugin list --json` confirms installed state.
  `coverage = {manifest: true, skills: false}` — **the codex static coverage gap** (D5): emit a notice
  finding (`normalizedSeverity: 'info'`) that skills were not checked.
- **Deep (skills):** `CODEX_HOME=$(mktemp -d)` + a throwaway project dir with the plugin's skills copied
  to `<proj>/.agents/skills/<name>/SKILL.md` (Codex reads `.agents/skills`, **not** `.claude/skills`).
  `codex exec -C <proj> --dangerously-bypass-approvals-and-sandbox "ok" 2>err.log`; each stderr line
  matching `failed to load skill <file>: <reason>` → `{checkId:'codex.skill-load', toolSeverity:'error',
  normalizedSeverity:'error', file, message:<reason>, subject:'skill'}`. `coverage = {manifest:false,
  skills:true}`.

### 7.3 Timeouts, cancellation, version drift

- **Timeouts** (constants, not flags in MVP): static ≈ 30 s, deep ≈ 120 s (a model turn). On timeout the
  `ModeResult` is `status:'error', skipReason:'timeout'`.
- **Cancellation:** the CLI's `AbortSignal` (SIGINT) is threaded to every subprocess; on abort the process
  is killed, temp dirs are cleaned, and the CLI exits 130.
- **Version drift:** each `ToolVerdict` records `toolVersion` (from `claude --version` / `codex --version`
  via the existing `runVersion`) and `versionDrift = toolVersion !== verifiedAgainst[tool]`. Drift never
  changes a verdict; it emits an `info` notice ("claude 2.3.0 differs from verified 2.1.201; parsing may be
  less reliable"). Parsers match on stable substrings (`✘`, `⚠`, `Invalid JSON syntax`, `failed to load
  skill`, `failed to parse plugin.json`, the `init` event fields), so a bump degrades to a notice rather
  than a silent misparse. `verifiedAgainst` is a single constant kept beside the P14 version matrix.

---

## 8. JSON contract (`--json`)

`schemaVersion: 1`, `kind` field for discriminated parsing by the consumer. **Additive evolution only**:
new optional fields may be added within v1; removing/retyping a field bumps `schemaVersion`. The CLI
validates its own output against a zod schema (`packages/cli/src/output/verify-json.ts`,
`VerifyJsonSchema`) before writing — same pattern as `doctor-json.ts`. Example (plugin with a bad-yaml
skill and a missing-description skill, `--deep`, both tools installed):

```json
{
  "schemaVersion": 1,
  "kind": "skillsmith.verify",
  "target": { "path": "/abs/plugins/dummytest", "kind": "plugin" },
  "requested": { "tools": ["claude-code", "codex"], "modes": ["static", "deep"], "strict": false, "explicitTools": false },
  "verifiedAgainst": { "claude-code": "2.1.201", "codex": "0.142.5" },
  "summary": {
    "verdict": "fail",
    "verified": [],
    "failed": ["claude-code", "codex"],
    "skipped": [],
    "counts": { "error": 3, "warning": 2, "info": 1 }
  },
  "tools": [
    {
      "tool": "claude-code",
      "available": true,
      "toolVersion": "2.1.201",
      "versionDrift": false,
      "skipReason": null,
      "verdict": "fail",
      "modes": [
        {
          "mode": "static",
          "status": "ran",
          "skipReason": null,
          "coverage": { "manifest": true, "skills": true },
          "verdict": "fail",
          "command": "claude plugin validate <path>",
          "findings": [
            { "checkId": "claude.frontmatter", "toolSeverity": "error", "normalizedSeverity": "error",
              "message": "YAML frontmatter failed to parse: YAML Parse error: Unexpected character.",
              "file": "skills/bad-yaml/SKILL.md", "subject": "skill" },
            { "checkId": "claude.description", "toolSeverity": "warning", "normalizedSeverity": "warning",
              "message": "No description in frontmatter.", "file": "skills/bad-nodesc/SKILL.md", "subject": "skill" }
          ]
        },
        {
          "mode": "deep",
          "status": "ran",
          "skipReason": null,
          "coverage": { "manifest": false, "skills": true },
          "verdict": "warn",
          "command": "claude --print --output-format stream-json --setting-sources \"\" --plugin-dir <path> \"ok\"",
          "findings": [
            { "checkId": "claude.load-presence", "toolSeverity": null, "normalizedSeverity": "warning",
              "message": "skill 'bad-yaml' did not load (reason unavailable at runtime — see static validate)",
              "file": "skills/bad-yaml/SKILL.md", "subject": "skill" }
          ]
        }
      ]
    },
    {
      "tool": "codex",
      "available": true,
      "toolVersion": "0.142.5",
      "versionDrift": false,
      "skipReason": null,
      "verdict": "fail",
      "modes": [
        {
          "mode": "static",
          "status": "ran",
          "skipReason": null,
          "coverage": { "manifest": true, "skills": false },
          "verdict": "pass",
          "command": "codex plugin marketplace add <root> && codex plugin add <name>@<mkt>",
          "findings": [
            { "checkId": "codex.static-coverage", "toolSeverity": null, "normalizedSeverity": "info",
              "message": "codex static checked the manifest only; run --deep for skill validation",
              "file": null, "subject": "plugin" }
          ]
        },
        {
          "mode": "deep",
          "status": "ran",
          "skipReason": null,
          "coverage": { "manifest": false, "skills": true },
          "verdict": "fail",
          "command": "codex exec -C <proj> --dangerously-bypass-approvals-and-sandbox \"ok\"",
          "findings": [
            { "checkId": "codex.skill-load", "toolSeverity": "error", "normalizedSeverity": "error",
              "message": "invalid YAML: found unexpected end of stream at line 3 column 23",
              "file": ".agents/skills/bad-yaml/SKILL.md", "subject": "skill" },
            { "checkId": "codex.skill-load", "toolSeverity": "error", "normalizedSeverity": "error",
              "message": "missing field `description`",
              "file": ".agents/skills/bad-nodesc/SKILL.md", "subject": "skill" }
          ]
        }
      ]
    }
  ]
}
```

A **tool skipped** because it is not installed renders as a `ToolVerdict` with `available:false`,
`skipReason:"not-installed"`, `verdict:"inconclusive"`, `modes:[]`. A **deep mode skipped for auth**
renders as a `ModeResult` with `status:"skipped", skipReason:"auth-required", verdict:null`.

---

## 9. Exit codes

`verify` reuses the documented set (`skillsmith-cli-design.md §6.1`). No new numeric codes.

| Code | Meaning for `verify` |
|---|---|
| `0` | Verified. At least one mode ran; every ran-mode verdict is `pass` (or `warn` when not `--strict`); no explicitly-required tool/mode was missing. |
| `1` | **Verification failed** — a proven defect. Some ran mode has verdict `fail` (any `normalizedSeverity:'error'` finding, or a `warning` under `--strict`). |
| `2` | Usage error — missing `<path>`, path not a directory / not a plugin, or `--tool` given a value outside `{claude-code, codex}`. |
| `4` | **Could not verify** — an environment gap, not a defect. Triggered by: nothing ran at all; **or** an explicitly `--tool`-named tool is not installed; **or** `--deep` was explicitly requested and a required tool's deep mode could not run (auth/timeout/exec-error). |
| `130` | Cancelled via SIGINT. |

**Rollup algorithm (authoritative; overrides §6.1 batch-max for this command — D7):**

```
1. Arg/usage error?                         -> 2   (before running anything)
2. Run the matrix (best-effort per D6).
3. summary.verdict === 'fail'?              -> 1   (a proven break outranks any gap)
4. nothing ran
   OR an explicit --tool is unavailable
   OR (--deep explicit AND a required tool's
       deep mode did not run)               -> 4
5. otherwise                                -> 0
   (SIGINT at any point                     -> 130)
```

The three-way split `{0 verified, 1 broken, 4 could-not-verify}` is the core CI contract: a green build,
a real defect, and a can't-check are always distinguishable by exit code alone; the JSON adds the detail.
An auto-detected (not `--tool`-named) tool that is simply absent is a silent skip and never forces `4`;
a `--deep` gap only forces `4` when the user explicitly opted into deep (D6). CI wanting to enforce codex
skill coverage on a static run can read `coverage.skills` from the JSON rather than relying on exit code.

---

## 10. Architecture and where code lives

Follows the per-agent boundary (CLAUDE.md) and the core/CLI split (ADR 0001).

```
packages/core/src/
  verify/
    types.ts        VerifyReport, ToolVerdict, ModeResult, VerifyFinding, verdict enums
    run.ts          verifyPlugin(env, opts): Result<VerifyReport, SkillSmithError> — orchestrator:
                    detect tools, dispatch per-agent checkers, assemble matrix, roll up verdicts
    normalize.ts    tool-native severity -> normalizedSeverity (§6), pure
  agents/claude-code/verify.ts   verifyClaudeCode(env, {path, modes, strict, signal}) -> Result<ToolVerdict, …>
  agents/codex/verify.ts          verifyCodex(env, {path, modes, strict, signal}) -> Result<ToolVerdict, …>
packages/cli/src/
  commands/verify.ts     flag parsing, calls verifyPlugin, computes exit code (§9), renders
  output/verify-human.ts matrix rendering (grouped tool -> mode -> findings)
  output/verify-json.ts  VerifyJsonSchema (zod) + renderVerifyJson (validates before write)
```

**Core stays pure.** The per-agent checkers do not call `child_process` directly; they call a new
injected primitive on `ScanEnv`:

```ts
// added to ScanEnv (env layer — the lowest layer; no boundary violation)
exec(cmd: string, args: readonly string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;   // e.g. { CODEX_HOME: <tmp> }
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
```

`defaultScanEnv()` implements it over `Bun.spawn` (generalizing the existing `env/exec.ts`); tests inject
a fake that returns canned stdout/stderr keyed by command, so parsers are tested without real CLIs. This
is the **one core-interface addition** the feature requires and is called out here for the plan.
`exitCodeForError` is unchanged — `verify`'s exit code is computed by the command from the report (a
verdict rollup), not derived from a `SkillSmithError` code.

Temp-dir helpers and the codex marketplace-wrapper synthesis live inside `agents/codex/verify.ts` (a
codex-specific concern per the per-agent boundary), not in a shared util.

---

## 11. Error handling

| Condition | Handling |
|---|---|
| `<path>` missing / not a directory / no plugin manifest and no `SKILL.md` | core returns `err`; CLI prints `error: …` to stderr, exit `2`. |
| `--tool` value not in `{claude-code, codex}` | commander `.choices([...])` rejects → exit `2`. |
| Named tool not installed | `ToolVerdict.available=false, skipReason:'not-installed'`; contributes to exit `4` (D6). |
| Deep requested, auth missing | deep `ModeResult.status='skipped', skipReason:'auth-required'`; static verdict (if any) stands; exit `4` only if `--deep` was explicit (D6). |
| Subprocess non-zero for a *reason we parse* (e.g. `failed to parse plugin.json`) | **not** an error — it is a finding; mode `status:'ran'`, verdict reflects it. |
| Subprocess crash / unparseable output / timeout | `ModeResult.status='error', skipReason:'exec-error'|'timeout'`, `verdict:null`; a `warning`-level report notice; contributes to could-not-verify (exit 4) for required tools. |
| Version drift | `info` notice; verdict unaffected (§7.3). |
| SIGINT | abort in-flight subprocesses, clean temp dirs, exit `130`. |

Distinguishing a *parsed non-zero* (a finding) from an *unexpected non-zero* (an exec error) is the
central robustness concern: the checker matches known reason substrings first; only output that matches
no known pattern **and** exits non-zero becomes `status:'error'`.

---

## 12. Testing strategy

- **Fixtures (P11-TS01)** — port the research broken-fixture suite into
  `packages/core/tests/fixtures/verify/`: a control plugin `dummytest/` with a valid
  `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` and skills
  `{good-skill, bad-yaml, bad-noframe, bad-nodesc}/SKILL.md`; plus broken-manifest plugins
  `claude-badjson/`, `claude-noname/`, `codex-badplug/`. These byte-for-byte reproduce the defects the
  research exercised.
- **Parser unit tests (deterministic, no real CLIs)** — inject a fake `env.exec` that **replays the exact
  stdout/stderr strings from the research doc** (`✘ frontmatter: YAML frontmatter failed to parse…`,
  `⚠ description: No description…`, `ERROR … failed to load skill …: missing field description`,
  `Error: failed to parse plugin.json: EOF while parsing…`, a sample `init` event). Assert the produced
  findings, `toolSeverity`/`normalizedSeverity`, `coverage`, mode/tool/summary verdicts, and exit code.
  This is where the severity-disagreement invariant (§6 worked example) is locked by test.
- **Schema golden test** — `renderVerifyJson(report)` validates against `VerifyJsonSchema`; a fixed report
  round-trips to a committed golden JSON (guards the P09 contract).
- **Exit-code table test** — drive the rollup (§9) across `{pass, warn, fail, nothing-ran,
  explicit-tool-absent, deep-auth-missing}` and assert `0/1/2/4`.
- **Env-gated live e2e (P11-TS02)** — behind `SKILLSMITH_E2E=1` (and `--deep` paths behind auth), shell out
  to the real `claude`/`codex` against the fixtures and assert the same findings the fakes assert.
  **Skipped in CI** (no CLIs, no auth); run locally. Also serves as the drift canary against new tool
  versions.
- `bun run check` stays green (biome + eslint boundaries + tsc + actionlint + bun test).

---

## 13. Out of scope

- Skill/plugin **execution** verification (this command is load-only).
- `kilo-code` / `opencode` verify (no proven verifier).
- Agent-SDK mechanism (CLI shell-out first).
- Auto-fix / remediation execution (findings carry text only).
- **Bare-skill-directory input** as a first-class target (Open Question 1) — MVP takes plugin dirs.
- Remote/URL inputs — `verify` takes a local path only.
- A `--timeout` flag and a user-facing verified-against version matrix (folded into P14 docs).
- Codex `app-server skills/list` no-model enumeration (experimental in research; not driven end-to-end).

---

## 14. Open questions

1. **Input shape.** MVP takes a **plugin directory** (the only shape the proven commands consume). Does
   the P09 `skill-verify` consumer hand us plugin dirs, or **bare skill dirs**? If bare, `verify` must
   synthesize an ephemeral minimal plugin wrapper around a lone `SKILL.md` (proven for codex's
   marketplace layout; extrapolated for `claude plugin validate`). Needs one confirmation pass with the
   P09 owner + a live claude-wrapper proof before we widen D1.
2. **Deep skip detection.** The research proved the *success* paths but did not pin an exact, stable
   auth-failure signature for either CLI. MVP detects a deep skip by attempting the session and matching
   auth/network error substrings on stderr; if that proves brittle across versions, a pre-flight auth
   probe (`claude`/`codex` whoami-style) may be needed. The exact skip-reason strings are not yet frozen.
