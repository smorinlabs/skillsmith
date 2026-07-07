# SkillSmith P11 Implementation Plan — `skillsmith verify`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Each task below is self-contained and dispatchable to a
> fresh implementer subagent that has not read the design spec.

**Goal:** Ship `skillsmith verify <path>` (v0.4.0, internal milestone): a read-only command that
loads a plugin **or a bare skill** under each target tool's own verifier (Claude Code, Codex) and
reports a **per-tool result matrix** — never one merged verdict. Static verification is the
default; `--deep` adds a session-backed load confirmation. Both modes are auth-free and
model-free. `--json` emits a versioned public contract consumed by the smorin-harness
`skill-verify` skill.

**Architecture:** Per-agent checkers live in `packages/core/src/agents/claude-code/verify.ts` and
`packages/core/src/agents/codex/verify.ts` (house per-agent boundary — separate files even when
similar). A tool-agnostic orchestrator in `packages/core/src/verify/` resolves the input shape
(wrapping a bare skill in an ephemeral generated plugin), dispatches the checkers, and assembles a
`VerifyReport`. Core returns `Result<T, SkillSmithError>` and never prints or exits; the CLI
(`packages/cli/src/commands/verify.ts`) owns flag parsing, exit codes, and rendering
(`output/verify-human.ts`, `output/verify-json.ts`). All subprocess execution goes through one new
injected primitive, `ScanEnv.exec`, so every parser is unit-testable against canned output — the
frozen error strings from `research/skill-plugin-load-verification-2026-07-06.md` are the test
fixtures.

**Tech stack:** Bun ≥ 1.3.14 workspace; TypeScript; `bun:test`; `zod` (already a dependency in
both packages) for the `--json` schema; `commander` (CLI only). **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-06-verify-design.md`
**Empirical basis:** `research/skill-plugin-load-verification-2026-07-06.md` (incl. 2026-07-07 addendum)
**Command surface:** `research/commands/verify.md`
**Prerequisite:** `v0.3.2` (P10) tagged. Branch: `p11-verify`, squash-merge PR at the end.
**Suggested PR title (becomes the release commit):** `feat(cli): add skillsmith verify cross-tool load verification`

---

## Global Constraints (binding — copy verbatim into every implementer and reviewer prompt)

1. **Core purity.** `@skillsmith/core` (`packages/core/src/**`) must not import `commander`,
   `chalk`, `consola`, `@clack/prompts`, or `node:console`, and must not call `process.exit(...)`
   or `console.{log,info,warn,error,debug}(...)`. Fallible core functions return
   `Result<T, SkillSmithError>`. The CLI alone decides exit codes and output. Enforced by
   `bun run lint:boundaries` (ESLint).
2. **Import direction.** `core/src/env/` is the lowest layer (no sibling deps);
   `detect/` may import `env/`; `agents/` and `scan/` may import `env/` + `detect/`. New
   `core/src/verify/` is a high-level orchestrator (like `doctor/`): it may import `env/`,
   `agents/`, `errors.ts`, `result.ts`; the leaves `skills/`, `plugins/`, `commands/` must NOT
   import `verify/`. In the CLI, `output/`, `help/`, `util/` are leaves that must not import
   `commands/` or `index.ts`; CLI imports core only via the `@skillsmith/core` package entry.
3. **Per-agent boundary.** `agents/claude-code/verify.ts` and `agents/codex/verify.ts` stay
   separate files even where bodies look similar. Do not merge them into a shared table. Codex
   temp-dir/marketplace synthesis lives inside `agents/codex/verify.ts` only.
4. **JSON contract stability.** `--json` emits `{"schemaVersion": 1, "kind": "skillsmith.verify", ...}`.
   The schema is a versioned public contract (consumed by another repo). Evolution is
   **additive only** within v1: new optional fields allowed; renaming, removing, or retyping any
   field requires bumping `schemaVersion`. Copy field names exactly as given in this plan.
5. **skipReason enum.** The only legal `skipReason` values are `'not-installed' | 'timeout' | 'exec-error'`
   (or `null`). There is **no** `auth-required` value — deep mode never skips for auth.
6. **Exit codes (the CI contract):**

   | Code | Meaning for `verify` |
   |---|---|
   | `0` | Verified. At least one mode ran; every ran-mode verdict is `pass` (or `warn` when not `--strict`); no explicitly-required tool/mode was missing. |
   | `1` | Verification failed — a proven defect. Some ran mode has verdict `fail` (any `normalizedSeverity: 'error'` finding, or a `warning` under `--strict`). |
   | `2` | Usage error — missing `<path>`, path not a directory / neither a plugin nor a bare skill, or `--tool` given a value outside `{claude-code, codex}`. |
   | `4` | Could not verify — an environment gap, not a defect. Nothing ran at all; **or** an explicitly `--tool`-named tool is not installed; **or** `--deep` was explicitly requested and a required tool's deep mode could not run (timeout/exec-error). |
   | `130` | Cancelled via SIGINT. |

   Rollup order (authoritative): usage error → `2` before running anything; then
   `summary.verdict === 'fail'` → `1` (a proven break **outranks** any gap); then
   nothing-ran / explicit-tool-absent / explicit-deep-gap → `4`; otherwise `0`.
   An auto-detected (not `--tool`-named) tool that is absent is a **silent skip** and never
   forces `4`. The exit code is computed from the assembled report by the CLI, never from a
   subprocess's own exit status.
7. **"init received = success; auth-failed tail = expected."** Deep mode runs under empty config
   dirs, so each deep subprocess itself exits non-zero **by design**. For Claude, receiving the
   `stream-json` line with `type === 'system' && subtype === 'init'` is the success signal; the
   subsequent event carrying `"error":"authentication_failed"` (text `Not logged in · Please run /login`),
   the `result` event with `is_error: true`, and exit code 1 are the expected, healthy tail. For
   Codex, the `failed to load skill` stderr lines (or their absence) plus the trailing
   `401 Unauthorized` stderr/exit 1 are likewise the expected tail. Neither tail is a finding, a
   skip, nor an error — the mode is `status: 'ran'`.
8. **Isolation recipes (never touch real `~/.claude` / `~/.codex`):**
   - Claude static: `claude plugin validate <path> [--strict]` — read-only, no temp dir.
   - Claude deep: `CLAUDE_CONFIG_DIR=$(mktemp -d) claude --print --verbose --output-format stream-json --setting-sources "" --plugin-dir <path> "ok"`.
     `--verbose` is **required** with `stream-json` under an isolated config dir.
     `--setting-sources ""` guarantees only the plugin under test loads.
   - Codex static: `CODEX_HOME=$(mktemp -d)`; synthesized marketplace root; `codex plugin marketplace add <root>`;
     `codex plugin add <name>@<mkt>`; `codex plugin list --json`.
   - Codex deep: empty `CODEX_HOME=$(mktemp -d)`; throwaway project dir with skills under
     `<proj>/.agents/skills/` (Codex reads `.agents/skills`, **not** `.claude/skills`);
     `codex exec -C <proj> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"`.
     `--skip-git-repo-check` is **required** for temp workdirs.
   - Every temp dir is created with `mkdtemp` and removed in a `finally`.
9. **Commits.** Conventional Commits; commitlint enforces scope ∈ `{cli, core, main}` or **no
   scope** (root configs, docs, cross-package tests, tooling). Body lines ≤ 100 chars. `feat:`
   bumps minor, `test:`/`docs:`/`chore:` bump nothing. `main` scope is reserved for
   release-please.
10. **No hand-edits to release-please-managed files:** root `package.json` version,
    `packages/cli/package.json`, `packages/core/package.json`, `CHANGELOG.md`,
    `.release-please-manifest.json`. The version bump to 0.4.0 happens via the squash-merged PR
    title, not by editing manifests.
11. **Tests first.** Write the failing test, watch it fail, then implement. Verification for every
    task ends with `bunx tsc --noEmit`, `bun run lint:boundaries`, targeted `bun test`, and
    `bunx @biomejs/biome check --write <changed paths>`; the branch must keep `bun run check`
    green.

---

## Conventions

- Paths are repo-relative from the workspace root.
- `bun test` auto-discovers `*.test.ts`; tests mirror `src/` under `packages/*/tests/`.
- Model per task follows PROJECTS.md P11: TS01 = haiku, T01/T02/T04/T06/TS02 = sonnet,
  T03/T05 = opus. Task review after each; final whole-branch review (P11-RV, fable) is outside
  this plan's task list.
- The orchestrator (not the implementer) flips the matching PROJECTS.md checkbox after each task
  is reviewed.

---

## Task 1 [P11-TS01] — Port the broken-fixture suite (model: haiku)

Byte-for-byte reproduce the defects the research exercised, as committed fixtures.

**Files:**
- Create: `packages/core/tests/fixtures/verify/dummytest/.claude-plugin/plugin.json`
- Create: `packages/core/tests/fixtures/verify/dummytest/.codex-plugin/plugin.json`
- Create: `packages/core/tests/fixtures/verify/dummytest/skills/good-skill/SKILL.md`
- Create: `packages/core/tests/fixtures/verify/dummytest/skills/bad-yaml/SKILL.md`
- Create: `packages/core/tests/fixtures/verify/dummytest/skills/bad-noframe/SKILL.md`
- Create: `packages/core/tests/fixtures/verify/dummytest/skills/bad-nodesc/SKILL.md`
- Create: `packages/core/tests/fixtures/verify/claude-badjson/.claude-plugin/plugin.json`
- Create: `packages/core/tests/fixtures/verify/claude-noname/.claude-plugin/plugin.json`
- Create: `packages/core/tests/fixtures/verify/codex-badplug/.codex-plugin/plugin.json`
- Create: `packages/core/tests/fixtures/verify/bare-skill/SKILL.md`
- Create: `packages/core/tests/verify/fixtures.test.ts`
- Modify: `biome.json` (fixture files contain intentionally broken JSON; biome must skip them)

- [ ] **Step 1: Exclude fixtures from biome**

In `biome.json`, extend `files.ignore`:

```json
"files": {
  "ignore": ["dist/**", "node_modules/**", "*.tsbuildinfo", "packages/*/tests/fixtures/**"]
}
```

Without this, `bun run lint` and the lefthook pre-commit biome hook fail on the broken-JSON
fixtures below.

- [ ] **Step 2: Write the failing shape test**

Create `packages/core/tests/verify/fixtures.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'verify');
const read = (...p: string[]) => Bun.file(join(FIXTURES, ...p)).text();

describe('verify fixtures', () => {
  test('dummytest control plugin has both manifests and four skills', async () => {
    const claude = JSON.parse(await read('dummytest', '.claude-plugin', 'plugin.json'));
    const codex = JSON.parse(await read('dummytest', '.codex-plugin', 'plugin.json'));
    expect(claude.name).toBe('dummytest');
    expect(codex.name).toBe('dummytest');
    for (const s of ['good-skill', 'bad-yaml', 'bad-noframe', 'bad-nodesc']) {
      expect(await Bun.file(join(FIXTURES, 'dummytest', 'skills', s, 'SKILL.md')).exists()).toBe(true);
    }
  });

  test('good-skill has name and description frontmatter', async () => {
    const t = await read('dummytest', 'skills', 'good-skill', 'SKILL.md');
    expect(t).toContain('name: good-skill');
    expect(t).toContain('description:');
  });

  test('bad-yaml has an unterminated quote and unclosed list', async () => {
    const t = await read('dummytest', 'skills', 'bad-yaml', 'SKILL.md');
    expect(t).toContain('"unterminated string');
    expect(t).toContain('[one, two');
  });

  test('bad-noframe has no frontmatter delimiters', async () => {
    const t = await read('dummytest', 'skills', 'bad-noframe', 'SKILL.md');
    expect(t).not.toContain('---');
  });

  test('bad-nodesc has frontmatter but no description', async () => {
    const t = await read('dummytest', 'skills', 'bad-nodesc', 'SKILL.md');
    expect(t).toContain('name: bad-nodesc');
    expect(t).not.toContain('description:');
  });

  test('broken manifests are actually broken', async () => {
    await expect(read('claude-badjson', '.claude-plugin', 'plugin.json').then(JSON.parse)).rejects.toThrow();
    await expect(read('codex-badplug', '.codex-plugin', 'plugin.json').then(JSON.parse)).rejects.toThrow();
    const noname = JSON.parse(await read('claude-noname', '.claude-plugin', 'plugin.json'));
    expect(noname.name).toBeUndefined();
  });

  test('bare-skill is a lone valid SKILL.md with no plugin manifest', async () => {
    const t = await read('bare-skill', 'SKILL.md');
    expect(t).toContain('name: bare-skill');
    expect(t).toContain('description:');
    expect(await Bun.file(join(FIXTURES, 'bare-skill', '.claude-plugin', 'plugin.json')).exists()).toBe(false);
  });
});
```

Run: `bun test packages/core/tests/verify/fixtures.test.ts` — expect FAIL (files missing).

- [ ] **Step 3: Create the fixtures (exact contents)**

`dummytest/.claude-plugin/plugin.json` and `dummytest/.codex-plugin/plugin.json` (identical):

```json
{
  "name": "dummytest",
  "description": "SkillSmith verify fixture - control plugin",
  "version": "0.1.0"
}
```

`dummytest/skills/good-skill/SKILL.md`:

```markdown
---
name: good-skill
description: A valid control skill for verify fixtures.
---

# good-skill

Control skill body. No defects.
```

`dummytest/skills/bad-yaml/SKILL.md` (malformed YAML: unterminated quote + unclosed list):

```markdown
---
name: bad-yaml
description: "unterminated string
tags: [one, two
---

# bad-yaml
```

`dummytest/skills/bad-noframe/SKILL.md` (no frontmatter block at all — must not contain `---`):

```markdown
# bad-noframe

This skill has no YAML frontmatter block at all.
```

`dummytest/skills/bad-nodesc/SKILL.md` (frontmatter present, `description` missing):

```markdown
---
name: bad-nodesc
---

# bad-nodesc

Frontmatter present but description missing.
```

`claude-badjson/.claude-plugin/plugin.json` (JSON syntax error — missing closing `}`):

```text
{
  "name": "claude-badjson",
  "description": "manifest with a JSON syntax error",
  "version": "0.1.0"
```

`claude-noname/.claude-plugin/plugin.json` (valid JSON, required `name` missing):

```json
{
  "description": "valid JSON, required name missing",
  "version": "0.1.0"
}
```

`codex-badplug/.codex-plugin/plugin.json` (JSON syntax error — missing closing `}`):

```text
{
  "name": "codex-badplug",
  "description": "manifest with a JSON syntax error",
  "version": "0.1.0"
```

`bare-skill/SKILL.md`:

```markdown
---
name: bare-skill
description: A valid bare skill (no plugin manifest) for wrapper tests.
---

# bare-skill

Used to test the ephemeral-plugin wrap of a lone SKILL.md.
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/verify/fixtures.test.ts` — expect PASS.
Run: `bun run lint` — expect clean (fixtures ignored).

- [ ] **Step 5: Commit**

```bash
git add biome.json packages/core/tests/fixtures/verify packages/core/tests/verify/fixtures.test.ts
git commit -m "test(core): add verify broken-fixture suite" \
  -m "Ports the research fixture matrix (good/bad-yaml/bad-noframe/bad-nodesc skills, broken" \
  -m "manifests x2 formats, bare skill). Excludes tests/fixtures from biome (intentional bad JSON)."
```

**Automated verification:** `bun test packages/core/tests/verify/` · `bun run lint`

---

## Task 2 [P11-T01] — Core types, `ScanEnv.exec`, and report orchestrator (model: sonnet)

**Files:**
- Create: `packages/core/src/verify/types.ts`
- Create: `packages/core/src/verify/normalize.ts`
- Create: `packages/core/src/verify/run.ts`
- Modify: `packages/core/src/env/types.ts` (add `exec` + supporting types)
- Modify: `packages/core/src/env/exec.ts` (add `execCommand`)
- Modify: `packages/core/src/env/default.ts` (wire `exec`)
- Modify: `packages/core/src/public-types.ts`, `packages/core/src/index.ts` (exports)
- Modify: `eslint.config.js` (leaf zones for `verify/`), `docs/adr/0003-eslint-import-boundaries.md` (one-line zone note)
- Create: `packages/core/tests/verify/normalize.test.ts`, `packages/core/tests/verify/run.test.ts`
- Modify: `packages/core/tests/env/exec.test.ts`, `packages/core/tests/public-api.test.ts`
- Modify (mechanical): every existing test file that builds a `ScanEnv` object literal — add the
  `exec` stub. Find them with `grep -rln "runVersion:" packages/core/tests packages/cli/tests`;
  the current list is:
  `packages/cli/tests/commands/agents.test.ts`,
  `packages/core/tests/agents/{claude-code,codex,kilo-code,opencode}.test.ts`,
  `packages/core/tests/agents/{claude-code,codex,kilo-code,opencode}/skill-roots.test.ts`,
  `packages/core/tests/commands/walk.test.ts`,
  `packages/core/tests/config/{load,paths}.test.ts`,
  `packages/core/tests/detect/scanners.test.ts`,
  `packages/core/tests/doctor/checks/built-in.test.ts`, `packages/core/tests/doctor/run.test.ts`,
  `packages/core/tests/plugins/{discover,enablement,installed}.test.ts`,
  `packages/core/tests/scan/{list-commands,list-skills,scan}.test.ts`,
  `packages/core/tests/skills/walk.test.ts`.

**Interfaces produced (exact — these are consumed by every later task):**

`packages/core/src/env/types.ts` additions:

```ts
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>; // merged over process.env, e.g. { CODEX_HOME: '<tmp>' }
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// added member on ScanEnv:
exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
```

`packages/core/src/verify/types.ts` (whole file):

```ts
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export const VERIFY_TOOLS = ['claude-code', 'codex'] as const;
export type VerifyTool = (typeof VERIFY_TOOLS)[number];

export type VerifyMode = 'static' | 'deep';
export type NormalizedSeverity = 'error' | 'warning' | 'info';
export type VerifyOutcome = 'pass' | 'warn' | 'fail'; // a produced verdict
export type SummaryVerdict = VerifyOutcome | 'inconclusive'; // rollup when nothing ran
export type ModeStatus = 'ran' | 'skipped' | 'error'; // did the checker run?
export type SkipReason = 'not-installed' | 'timeout' | 'exec-error';

export interface VerifyFinding {
  checkId: string; // e.g. 'claude.frontmatter' | 'codex.skill-load' | 'codex.manifest'
  toolSeverity: string | null; // native token verbatim; null for synthesized findings
  normalizedSeverity: NormalizedSeverity;
  message: string; // the tool's own message (verbatim or lightly trimmed)
  file: string | null; // path relative to <path> when known
  subject: 'skill' | 'manifest' | 'marketplace' | 'plugin';
  raw?: string; // the raw tool line, for --debug and forward-compat
}

export interface ModeResult {
  mode: VerifyMode;
  status: ModeStatus;
  skipReason: SkipReason | null; // null when status === 'ran'
  coverage: { manifest: boolean; skills: boolean }; // what THIS (tool,mode) actually inspected
  verdict: VerifyOutcome | null; // null unless status === 'ran'
  command: string; // the command line run (temp paths redacted), for auditability
  findings: VerifyFinding[];
}

export interface ToolVerdict {
  tool: VerifyTool;
  available: boolean; // detected on PATH
  toolVersion: string | null; // observed CLI version, or null when unavailable
  versionDrift: boolean; // observed !== VERIFIED_AGAINST[tool]
  skipReason: SkipReason | null; // 'not-installed' when !available
  verdict: SummaryVerdict; // worst of ran modes; 'inconclusive' if none ran
  modes: ModeResult[]; // empty when !available
}

export interface VerifyReport {
  schemaVersion: 1;
  target: { path: string; kind: 'plugin' | 'skill' }; // 'skill' = bare skill dir, wrapped
  requested: {
    tools: VerifyTool[];
    modes: VerifyMode[];
    strict: boolean;
    explicitTools: boolean;
  };
  verifiedAgainst: Record<VerifyTool, string>;
  summary: {
    verdict: SummaryVerdict;
    verified: VerifyTool[]; // tools with a produced pass/warn verdict
    failed: VerifyTool[]; // tools with a fail verdict
    skipped: VerifyTool[]; // tools that could not run
    counts: { error: number; warning: number; info: number }; // normalized totals, all findings
  };
  tools: ToolVerdict[];
}

export interface ToolVerifyOptions {
  path: string; // resolved plugin dir (post bare-skill wrap)
  modes: readonly VerifyMode[];
  strict: boolean;
  signal?: AbortSignal;
}

export type ToolVerifier = (
  env: ScanEnv,
  opts: ToolVerifyOptions,
) => Promise<Result<ToolVerdict, SkillSmithError>>;

/** The version matrix this build's parsers were proven against (research 2026-07-06/07). */
export const VERIFIED_AGAINST: Record<VerifyTool, string> = {
  'claude-code': '2.1.201',
  codex: '0.142.5',
};

export const STATIC_TIMEOUT_MS = 30_000;
export const DEEP_TIMEOUT_MS = 60_000;
```

`packages/core/src/verify/normalize.ts`:

```ts
export const worstOutcome = (outcomes: readonly VerifyOutcome[]): VerifyOutcome; // fail > warn > pass
export const modeVerdictFor = (findings: readonly VerifyFinding[], strict: boolean): VerifyOutcome;
export const toolVerdictFor = (modes: readonly ModeResult[]): SummaryVerdict;
export const summarize = (tools: readonly ToolVerdict[]): VerifyReport['summary'];
export const extractVersionToken = (raw: string): string | null; // first /\d+\.\d+\.\d+\S*/ match
```

`packages/core/src/verify/run.ts`:

```ts
export interface VerifyOptions {
  path: string; // target directory (CLI passes an absolute path)
  tools?: readonly VerifyTool[]; // explicit --tool list; undefined = all of VERIFY_TOOLS (best-effort)
  deep?: boolean; // --deep => modes {static, deep}; otherwise {static}
  strict?: boolean;
  signal?: AbortSignal;
}

export interface ResolvedTarget {
  path: string; // dir to hand to checkers (the wrapper dir for bare skills)
  kind: 'plugin' | 'skill';
  cleanup: () => Promise<void>; // removes the wrapper temp dir; no-op for plugins
}

export const resolveTarget = (
  env: ScanEnv,
  path: string,
): Promise<Result<ResolvedTarget, SkillSmithError>>;

export const runVerify = (
  env: ScanEnv,
  opts: VerifyOptions,
  checkers: Record<VerifyTool, ToolVerifier>,
): Promise<Result<VerifyReport, SkillSmithError>>;
```

- [ ] **Step 1: Failing tests for `execCommand`**

Extend `packages/core/tests/env/exec.test.ts` with a `describe('execCommand', ...)` block (import
`execCommand` from `../../src/env/exec.ts`). Assert:
- `execCommand('/bin/echo', ['hi'])` → `{ code: 0, stdout: 'hi\n', stderr: '', timedOut: false }`.
- Non-zero exit and stderr capture: `execCommand(Bun.which('bun') ?? 'bun', ['-e', 'console.error("boom"); process.exit(3)'])`
  → `code === 3`, `stderr` contains `boom`, `timedOut === false`.
- `env` merge: `execCommand(bun, ['-e', 'console.log(process.env.SKILLSMITH_X)'], { env: { SKILLSMITH_X: 'y' } })`
  → stdout `y\n` **and** the child still sees `PATH` (merge over `process.env`, not replace).
- Timeout: `execCommand(Bun.which('sleep') ?? '/bin/sleep', ['5'], { timeoutMs: 200 })`
  → `timedOut === true` (code value unspecified). Test timeout 5000 ms.
- Abort: pre-aborted `AbortSignal` returns promptly with `timedOut === false` and non-zero `code`.
- Spawn failure (`/nope/definitely/not/here`) does **not** throw; returns `code === -1`, `stderr`
  non-empty, `timedOut === false`.

- [ ] **Step 2: Implement `execCommand` and wire `ScanEnv.exec`**

In `packages/core/src/env/exec.ts` add:

```ts
export const execCommand = async (
  cmd: string,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> => { /* Bun.spawn over stdout/stderr pipes */ };
```

Implementation requirements: `Bun.spawn([cmd, ...args], { cwd, env: { ...process.env, ...opts.env }, stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined, stdout: 'pipe', stderr: 'pipe' })`;
kill on `opts.signal` abort and on `timeoutMs` expiry (set `timedOut = true` only for the timer
path); always await `proc.exited`; catch spawn errors and return
`{ code: -1, stdout: '', stderr: String(e), timedOut: false }`; clear the timer and remove signal
listeners in `finally` (mirror the existing `runVersionCommand` structure). Add `ExecOptions` /
`ExecResult` and the `exec` member to `ScanEnv` in `env/types.ts`; in `env/default.ts` wire
`exec: async (cmd, args, opts) => execCommand(cmd, args, opts)`.

- [ ] **Step 3: Mechanical fixture update**

Add to every existing test `ScanEnv` literal (files listed above, next to each `runVersion:` line):

```ts
exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
```

Run: `bunx tsc --noEmit` — expect clean (this is the check that you found them all).

- [ ] **Step 4: Failing tests for normalize + rollups**

Create `packages/core/tests/verify/normalize.test.ts`. Assert (build minimal literal findings/modes):
- `worstOutcome(['pass','warn','fail'])` → `'fail'`; `worstOutcome(['pass','warn'])` → `'warn'`; `worstOutcome(['pass'])` → `'pass'`.
- `modeVerdictFor`: any `normalizedSeverity:'error'` → `'fail'`; warnings only → `'warn'`;
  warnings only + `strict: true` → `'fail'`; info only or empty → `'pass'`.
- `toolVerdictFor`: worst of `status:'ran'` mode verdicts; all modes skipped/error → `'inconclusive'`.
- `summarize`: verified/failed/skipped partition by tool verdict (`pass|warn` → verified, `fail` →
  failed, `'inconclusive'` → skipped); `counts` totals normalized severities across every finding
  of every mode of every tool; `verdict` = worst across tools that produced verdicts,
  `'inconclusive'` when none did.
- `extractVersionToken('2.1.201 (Claude Code)')` → `'2.1.201'`; `('codex-cli 0.142.5')` → `'0.142.5'`; `('unknown')` → `null`.

- [ ] **Step 5: Failing tests for `resolveTarget` + `runVerify`**

Create `packages/core/tests/verify/run.test.ts`. Use `defaultScanEnv()` (real fs) and the Task-1
fixtures at `packages/core/tests/fixtures/verify/`. Fake checkers are inline:

```ts
const okChecker = (tool: VerifyTool, verdict: VerifyOutcome): ToolVerifier =>
  async (_env, opts) => ok({
    tool, available: true, toolVersion: '9.9.9', versionDrift: true, skipReason: null,
    verdict, modes: opts.modes.map((mode) => ({
      mode, status: 'ran' as const, skipReason: null,
      coverage: { manifest: true, skills: true }, verdict, command: `${tool} fake`, findings: [],
    })),
  });
const absentChecker = (tool: VerifyTool): ToolVerifier =>
  async () => ok({ tool, available: false, toolVersion: null, versionDrift: false,
    skipReason: 'not-installed' as const, verdict: 'inconclusive' as const, modes: [] });
```

Assert:
- `resolveTarget` on `fixtures/verify/dummytest` → `kind: 'plugin'`, `path` unchanged, cleanup is a no-op.
- `resolveTarget` on `fixtures/verify/bare-skill` → `kind: 'skill'`; the returned `path` is a temp
  dir containing `.claude-plugin/plugin.json` (parsable JSON with `name: 'bare-skill'`),
  `.codex-plugin/plugin.json`, and `skills/bare-skill/SKILL.md` byte-equal to the fixture;
  `cleanup()` removes the temp dir.
- `resolveTarget` on an empty temp dir (make one in the test) → `err` with code `'generic'` and a
  message containing `is not a plugin or skill directory`.
- `resolveTarget` on a nonexistent path → `err`.
- `runVerify` on dummytest with both fake checkers passing, `{}` opts →
  `schemaVersion === 1`, `target.kind === 'plugin'`,
  `requested` = `{ tools: ['claude-code','codex'], modes: ['static'], strict: false, explicitTools: false }`,
  `verifiedAgainst` = `{ 'claude-code': '2.1.201', codex: '0.142.5' }`,
  `summary.verdict === 'pass'`, `tools.length === 2`.
- `deep: true` → `requested.modes` = `['static','deep']` and each fake ToolVerdict got both modes.
- `tools: ['codex']` → `explicitTools === true`, only one ToolVerdict.
- One checker fails (`fail`) + one absent → `summary` = `{ verdict: 'fail', verified: [], failed: [<tool>], skipped: [<absent>] }`.
- Bare-skill target: after `runVerify` returns, the wrapper temp dir no longer exists (cleanup ran
  in a `finally`), and `target.kind === 'skill'` while `target.path` is the **original** input path.
- Pre-aborted `signal` → `err` (message contains `aborted`).

- [ ] **Step 6: Implement `verify/types.ts`, `verify/normalize.ts`, `verify/run.ts`**

`resolveTarget` logic (uses `env.fileExists`, `node:fs/promises` for writes — precedent:
`config/save.ts` writes with `node:fs/promises` in core):
1. plugin shape: `<path>/.claude-plugin/plugin.json` or `<path>/.codex-plugin/plugin.json` exists → as-is.
2. else bare skill: `<path>/SKILL.md` exists → `mkdtemp(join(tmpdir(), 'skillsmith-verify-'))`;
   `name = basename(path)`; write both `<tmp>/.claude-plugin/plugin.json` and
   `<tmp>/.codex-plugin/plugin.json` as
   `{ "name": <name>, "description": "skillsmith verify ephemeral wrapper", "version": "0.0.0" }`;
   `cp(path, join(tmp, 'skills', name), { recursive: true })`; cleanup = `rm(tmp, { recursive: true, force: true })`.
3. else → `err(genericError(\`'<path>' is not a plugin or skill directory (expected .claude-plugin/plugin.json, .codex-plugin/plugin.json, or SKILL.md)\`))`.

`runVerify` logic: abort check → `resolveTarget` → tool set = `opts.tools ?? VERIFY_TOOLS`
(`explicitTools = opts.tools !== undefined && opts.tools.length > 0`) → modes =
`opts.deep ? ['static','deep'] : ['static']` → run checkers **sequentially** in tool-set order,
propagating any checker `err` → assemble report (`summary` via `summarize`) → `cleanup()` in
`finally`.

- [ ] **Step 7: Export from the public surface**

`public-types.ts`: export types `VerifyTool`, `VerifyMode`, `NormalizedSeverity`, `VerifyOutcome`,
`SummaryVerdict`, `ModeStatus`, `SkipReason`, `VerifyFinding`, `ModeResult`, `ToolVerdict`,
`VerifyReport`, `ToolVerifyOptions`, `ToolVerifier`, `VerifyOptions`, `ExecOptions`, `ExecResult`.
`index.ts`: export runtime symbols `runVerify`, `resolveTarget`, `VERIFY_TOOLS`,
`VERIFIED_AGAINST` (and re-export the types). Add `runVerify`, `VERIFY_TOOLS`, `VERIFIED_AGAINST`
to the expected set in `packages/core/tests/public-api.test.ts`.

- [ ] **Step 8: ESLint zones + ADR note**

In `eslint.config.js`, after the existing `doctor` zones add (mirrors doctor's leaf protection):

```js
// verify is a high-level orchestrator; leaves must not import it
{ target: './packages/core/src/skills', from: './packages/core/src/verify' },
{ target: './packages/core/src/plugins', from: './packages/core/src/verify' },
{ target: './packages/core/src/commands', from: './packages/core/src/verify' },
```

Append one line to the zone list in `docs/adr/0003-eslint-import-boundaries.md` (Decision §1):
`- packages/core/src/{skills,plugins,commands} ↛ verify (verify is a high-level orchestrator, like doctor).`

- [ ] **Step 9: Verify and commit**

Run: `bun test packages/core` · `bunx tsc --noEmit` · `bun run lint:boundaries` ·
`bunx @biomejs/biome check --write packages/core eslint.config.js`

```bash
git add -A packages/core eslint.config.js docs/adr/0003-eslint-import-boundaries.md packages/cli/tests
git commit -m "feat(core): add verify report types, ScanEnv.exec, and orchestrator" \
  -m "VerifyReport/ToolVerdict/ModeResult/VerifyFinding + rollups; injected exec primitive on" \
  -m "ScanEnv (Bun.spawn, timeout/abort/env-merge); runVerify with injected checkers; bare-skill" \
  -m "ephemeral plugin wrap with finally cleanup; eslint leaf zones for verify/."
```

**Automated verification:** `bun test packages/core` · `bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 3 [P11-T02] — `agents/claude-code/verify.ts`: static validate parser (model: sonnet)

**Consumes (from Task 2, import from `../../verify/types.ts`):** `VerifyFinding`, `ModeResult`,
`ToolVerdict`, `ToolVerifier`, `ToolVerifyOptions`, `STATIC_TIMEOUT_MS`, `VERIFIED_AGAINST`;
`modeVerdictFor`, `toolVerdictFor`, `extractVersionToken` from `../../verify/normalize.ts`;
`detect` from `./detect.ts`; `env.exec` from `ScanEnv`.

**Files:**
- Create: `packages/core/src/agents/claude-code/verify.ts`
- Create: `packages/core/tests/agents/claude-code/verify-static.test.ts`

**Interfaces produced:**

```ts
/** Pure. Parses `claude plugin validate` output into findings. targetPath strips file prefixes. */
export const parseClaudeValidateOutput = (output: string, targetPath: string): VerifyFinding[];

export const verifyClaudeCode: ToolVerifier; // handles modes: ['static'] now; 'deep' added in the next task
```

**Parsing contract** (frozen strings — these exact lines are the canned fixtures):

`claude plugin validate <dir>` output for the mixed-skill control plugin (exit 1):

```text
Validating skill: /work/dummytest/skills/bad-yaml/SKILL.md
✘ frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected character.
  At runtime this skill loads with empty metadata (all frontmatter fields silently dropped).
Validating skill: /work/dummytest/skills/bad-noframe/SKILL.md
⚠ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...
Validating skill: /work/dummytest/skills/bad-nodesc/SKILL.md
⚠ description: No description in frontmatter. ...
✘ Validation failed
```

Broken-manifest lines (exit 1):

```text
✘ json: Invalid JSON syntax: JSON Parse error: Expected '}'
✘ name: Invalid input: expected string, received undefined
```

Rules:
- `Validating skill: <abs-file>` sets the current file context; store it relative to `targetPath`
  (strip `targetPath + '/'` prefix when present).
- `✘ <check>: <msg>` → finding `{ checkId: 'claude.<check>', toolSeverity: 'error', normalizedSeverity: 'error', message: <msg>, raw: <line> }`.
- `⚠ <check>: <msg>` → same with `'warning'`/`'warning'`.
- `<check>` tokens `json` and `name` → `subject: 'manifest'`, `file: '.claude-plugin/plugin.json'`;
  any other token → `subject: 'skill'`, `file: <current file>` (or `null` if none seen yet).
- The bare summary line `✘ Validation failed` has no `<check>:` segment — it must NOT become a finding.
- Indented continuation lines (leading whitespace) are ignored.
- Match on the `✘` / `⚠` marker substrings — these are the stable parse keys (version drift
  degrades to a notice, never a silent misparse).

**Checker behavior (`verifyClaudeCode`):**
1. `detect(env, opts.signal)` → no install records ⇒
   `{ tool: 'claude-code', available: false, toolVersion: null, versionDrift: false, skipReason: 'not-installed', verdict: 'inconclusive', modes: [] }` (wrapped in `ok(...)`).
2. Else `binary` = first record's path; `toolVersion = extractVersionToken(record.version)`;
   `versionDrift = toolVersion !== null && toolVersion !== VERIFIED_AGAINST['claude-code']`.
3. Static mode (when `'static' ∈ opts.modes`):
   `env.exec(binary, ['plugin', 'validate', opts.path, ...(opts.strict ? ['--strict'] : [])], { timeoutMs: STATIC_TIMEOUT_MS, signal: opts.signal })`.
   - `timedOut` ⇒ `status: 'error', skipReason: 'timeout', verdict: null, findings: []`.
   - Else parse `stdout + '\n' + stderr`. Any findings parsed, or exit code 0 ⇒ `status: 'ran'`,
     `verdict = modeVerdictFor(findings, opts.strict)`. Non-zero exit with zero parsed findings
     and no `✘`/`⚠` marker anywhere ⇒ `status: 'error', skipReason: 'exec-error'`.
   - `coverage: { manifest: true, skills: true }`.
   - `command`: `` `claude plugin validate ${opts.path}` `` (+ ` --strict` when strict). No temp
     paths involved, nothing to redact.
   - The mode verdict comes from parsed findings, **never** from claude's exit code.
4. If `versionDrift`, append to the first ran mode's findings:
   `{ checkId: 'claude.version-drift', toolSeverity: null, normalizedSeverity: 'info', message: \`claude ${toolVersion} differs from verified ${VERIFIED_AGAINST['claude-code']}; parsing may be less reliable\`, file: null, subject: 'plugin' }`.
5. `verdict = toolVerdictFor(modes)`. Deep mode is added by the next task — in this task, build the
   mode list from a dispatch table containing only `static`; a requested `'deep'` simply produces
   no ModeResult yet.

- [ ] **Step 1: Failing tests.** Create `verify-static.test.ts`. Build env as the standard test
  literal (copy from `packages/core/tests/doctor/run.test.ts`, include the `exec` stub) and
  override per-test:
  - `parseClaudeValidateOutput` on the frozen mixed-skill block above with
    `targetPath: '/work/dummytest'` → exactly 3 findings:
    `['claude.frontmatter'/error/'skills/bad-yaml/SKILL.md', 'claude.frontmatter'/warning/'skills/bad-noframe/SKILL.md', 'claude.description'/warning/'skills/bad-nodesc/SKILL.md']`,
    messages verbatim (`'YAML frontmatter failed to parse: YAML Parse error: Unexpected character.'` etc.),
    all `subject: 'skill'`; the `✘ Validation failed` line produced no finding.
  - Manifest lines → `checkId 'claude.json'` / `'claude.name'`, `subject: 'manifest'`,
    `file: '.claude-plugin/plugin.json'`.
  - `verifyClaudeCode` with a fake `env.exec` replaying the mixed-skill block (exit 1) and a fake
    `runVersion` returning `'2.1.201 (Claude Code)'`, plus `path: ['/fake']` and
    `fileExists`/`realpath` faked so `detect` finds `/fake/claude`:
    → `available: true`, `toolVersion: '2.1.201'`, `versionDrift: false`, one static ModeResult,
    `status: 'ran'`, `verdict: 'fail'` (the error finding), `coverage {manifest:true, skills:true}`.
  - Warnings only + `strict: true` → mode verdict `'fail'`; strict adds `--strict` to the exec args
    (assert via a capturing fake).
  - Exit 0, empty output → `status: 'ran'`, `verdict: 'pass'`, `findings: []`.
  - `timedOut: true` → `status: 'error'`, `skipReason: 'timeout'`, `verdict: null`.
  - Exit 2 with garbage output (`'segfault'`) → `status: 'error'`, `skipReason: 'exec-error'`.
  - `detect` finds nothing (empty `path`) → `available: false`, `skipReason: 'not-installed'`, `modes: []`.
  - Fake version `'2.3.0 (Claude Code)'` → `versionDrift: true` and an info
    `claude.version-drift` finding appended to the ran mode.
- [ ] **Step 2: Implement** `packages/core/src/agents/claude-code/verify.ts` per the contract.
- [ ] **Step 3: Verify and commit.**

```bash
git add packages/core/src/agents/claude-code/verify.ts packages/core/tests/agents/claude-code/verify-static.test.ts
git commit -m "feat(core): add claude-code static verify parser" \
  -m "Parses claude plugin validate output (marker lines, manifest vs skill subjects); verdict" \
  -m "from findings, never the subprocess exit code."
```

**Automated verification:** `bun test packages/core/tests/agents/claude-code/verify-static.test.ts` ·
`bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 4 [P11-T03] — `agents/claude-code/verify.ts`: deep init-event check (model: opus)

**Consumes:** everything Task 3 produced in `agents/claude-code/verify.ts`; `DEEP_TIMEOUT_MS` from
`../../verify/types.ts`; `env.exec`, `env.listDir`, `env.fileExists`, `env.readText`.

**Files:**
- Modify: `packages/core/src/agents/claude-code/verify.ts`
- Create: `packages/core/tests/agents/claude-code/verify-deep.test.ts`

**Interfaces produced (added exports):**

```ts
/** Pure. First stream-json line with type==='system' && subtype==='init', or null if absent. */
export const parseClaudeInit = (
  stdout: string,
): { plugins: string[]; skills: string[] } | null;
```

**Deep mode contract:**
- Command: create `cfg = mkdtemp(join(tmpdir(), 'skillsmith-claude-cfg-'))`; run
  `env.exec(binary, ['--print', '--verbose', '--output-format', 'stream-json', '--setting-sources', '', '--plugin-dir', opts.path, 'ok'], { env: { CLAUDE_CONFIG_DIR: cfg }, timeoutMs: DEEP_TIMEOUT_MS, signal: opts.signal })`;
  remove `cfg` in a `finally`. `--verbose` is REQUIRED with `stream-json` under an isolated config
  dir. Runs auth-free and model-free: the `init` event fires locally before any API turn.
- Reported `command` string (temp path redacted):
  `CLAUDE_CONFIG_DIR=<tmp> claude --print --verbose --output-format stream-json --setting-sources "" --plugin-dir <opts.path> "ok"`.
- `parseClaudeInit`: split stdout into lines; `JSON.parse` each line that parses; return the first
  object with `type === 'system' && subtype === 'init'` as
  `{ plugins: (init.plugins ?? []).map((p) => p.name), skills: init.skills ?? [] }`.
- Expected skills: subdirectories `n` of `<opts.path>/skills/` where
  `<opts.path>/skills/<n>/SKILL.md` exists (via `env.listDir` + `env.fileExists`).
- Plugin name: `JSON.parse(await env.readText(join(opts.path, '.claude-plugin', 'plugin.json'))).name`;
  on any read/parse failure use `null` (then no expected skill can match, and every expected skill
  is reported missing — the static mode carries the manifest reason).
- For each expected skill `n` where `` `${pluginName}:${n}` `` is NOT in `init.skills`, synthesize:
  `{ checkId: 'claude.load-presence', toolSeverity: null, normalizedSeverity: 'warning', message: \`skill '${n}' did not load (reason unavailable at runtime — see static validate)\`, file: \`skills/${n}/SKILL.md\`, subject: 'skill' }`.
  (Claude drops broken skills **silently** — deep proves presence only and can never say why, so a
  gap is a warning, not a fail. Empirically — research 2026-07-06 — ALL THREE broken fixtures
  including `bad-nodesc` are dropped from `init.skills` at runtime.)
- **Success/failure classification (Global Constraint 7):** `init` line found ⇒ `status: 'ran'`
  regardless of exit code — the `authentication_failed` tail + exit 1 is the expected, healthy
  ending of an isolated session and must not be read as a failure. `timedOut` ⇒
  `status: 'error', skipReason: 'timeout'`. No `init` line and not timed out ⇒
  `status: 'error', skipReason: 'exec-error'`.
- `coverage: { manifest: false, skills: true }` (presence only). Verdict via
  `modeVerdictFor(findings, opts.strict)` — so presence gaps are `warn` (or `fail` under `--strict`).
- Wire `deep` into the mode dispatch table so `verifyClaudeCode` now honors
  `modes: ['static','deep']` in order (static first — it supplies the reasons).

**Canned deep fixture (this exact multi-line stdout + exit code 1 is the unit-test input):**

```text
{"type":"system","subtype":"init","plugins":[{"name":"dummytest","path":"/work/dummytest","source":"plugin-dir"}],"skills":["dummytest:good-skill"],"slash_commands":[]}
{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]}}
{"type":"result","is_error":true}
```

- [ ] **Step 1: Failing tests.** Create `verify-deep.test.ts`:
  - `parseClaudeInit` on the canned block → `{ plugins: ['dummytest'], skills: ['dummytest:good-skill'] }`;
    on output with no init line → `null`; tolerates non-JSON junk lines interleaved.
  - `verifyClaudeCode` with `modes: ['static','deep']`, a fake `env.exec` returning the Task-3
    static block for the `plugin validate` call and the canned deep block (with `code: 1`) for the
    stream-json call, and fake `listDir('<path>/skills')` →
    `['good-skill','bad-yaml','bad-noframe','bad-nodesc']`, `fileExists` true for the four
    `SKILL.md`s, `readText` returning `{"name":"dummytest","version":"0.1.0"}`:
    → two ModeResults in order `[static, deep]`; deep is `status: 'ran'` (despite exit 1) with
    exactly **3** `claude.load-presence` warnings (bad-yaml, bad-noframe, bad-nodesc; good-skill
    absent from findings), `toolSeverity: null` on each, deep verdict `'warn'`, tool verdict
    `'fail'` (worst of static fail / deep warn).
  - Exec fake asserts the deep call carried `env.CLAUDE_CONFIG_DIR` (non-empty) and the exact args
    list including `'--verbose'`, `'--setting-sources', ''`, `'--plugin-dir', <path>`.
  - Deep output WITHOUT an init line, `code: 1` → `status: 'error'`, `skipReason: 'exec-error'`,
    `verdict: null`.
  - `timedOut: true` on the deep call → `skipReason: 'timeout'`.
  - All expected skills present in `init.skills` → deep `verdict: 'pass'`, `findings: []`.
  - Reported deep `command` string starts with `CLAUDE_CONFIG_DIR=<tmp> claude --print --verbose`
    (temp path redacted to the literal `<tmp>`).
- [ ] **Step 2: Implement** the deep mode in `agents/claude-code/verify.ts`.
- [ ] **Step 3: Verify and commit.**

```bash
git add packages/core/src/agents/claude-code/verify.ts packages/core/tests/agents/claude-code/verify-deep.test.ts
git commit -m "feat(core): add claude-code deep init-event verify" \
  -m "Isolated CLAUDE_CONFIG_DIR stream-json session; init event = success signal; the" \
  -m "authentication_failed tail + exit 1 is the expected healthy ending, never a failure." \
  -m "Presence gaps are synthesized warnings (claude drops broken skills silently)."
```

**Automated verification:** `bun test packages/core/tests/agents/claude-code/` ·
`bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 5 [P11-T04] — `agents/codex/verify.ts`: static manifest check, temp `CODEX_HOME` (model: sonnet)

**Consumes:** `VerifyFinding`, `ModeResult`, `ToolVerdict`, `ToolVerifier`, `ToolVerifyOptions`,
`STATIC_TIMEOUT_MS`, `VERIFIED_AGAINST` from `../../verify/types.ts`; `modeVerdictFor`,
`toolVerdictFor`, `extractVersionToken` from `../../verify/normalize.ts`; `detect` from
`./detect.ts`; `env.exec`; `node:fs/promises` (`mkdtemp`, `mkdir`, `writeFile`, `cp`, `rm`) for
wrapper synthesis (a codex-specific concern — it lives in this file, not a shared util).

**Files:**
- Create: `packages/core/src/agents/codex/verify.ts`
- Create: `packages/core/tests/agents/codex/verify-static.test.ts`

**Interfaces produced:**

```ts
/** Pure. Parses `codex plugin marketplace add` / `codex plugin add` output into findings. */
export const parseCodexInstallOutput = (stdout: string, stderr: string): VerifyFinding[];

export const verifyCodex: ToolVerifier; // handles modes: ['static'] now; 'deep' added next task
```

**Wrapper synthesis (codex requires its marketplace layout — proven in research):**

```text
<root>/.agents/plugins/marketplace.json
<root>/plugins/<name>/.codex-plugin/plugin.json   (copied from the target)
<root>/plugins/<name>/skills/...                  (copied from the target)
```

- `name`: `JSON.parse` of `<opts.path>/.codex-plugin/plugin.json` `.name`; if unreadable/unparsable
  (that IS the defect under test) fall back to `basename(opts.path)`.
- `marketplace.json` content (marketplace name constant `skillsmith-mkt`; plugin source form is
  frozen from research — paths relative to `<root>`):

```json
{
  "name": "skillsmith-mkt",
  "plugins": [{ "source": { "source": "local", "path": "./plugins/<name>" } }]
}
```

  The envelope around the frozen `source` form is validated by the live e2e (Task 9); the parser
  contract below does not depend on it.
- Copy the whole target dir to `<root>/plugins/<name>` with `cp(..., { recursive: true })`.
- `home = mkdtemp(join(tmpdir(), 'skillsmith-codex-home-'))`; both temp trees removed in `finally`.

**Static mode contract:**
1. If `<opts.path>/.codex-plugin/plugin.json` does not exist: `status: 'ran'`,
   `coverage: { manifest: false, skills: false }`, `verdict: 'pass'`, single finding
   `{ checkId: 'codex.no-manifest', toolSeverity: null, normalizedSeverity: 'info', message: 'no .codex-plugin/plugin.json found; codex manifest check not applicable', file: null, subject: 'manifest' }`,
   `command: '(skipped: no .codex-plugin/plugin.json)'`. (Bare-skill wrappers always have one.)
2. `env.exec(binary, ['plugin', 'marketplace', 'add', root], { env: { CODEX_HOME: home }, timeoutMs: STATIC_TIMEOUT_MS, signal })`.
   If stdout+stderr contains `does not contain a supported manifest` →
   `{ checkId: 'codex.marketplace', toolSeverity: 'error', normalizedSeverity: 'error', message: <full Error: line>, file: null, subject: 'marketplace' }`;
   mode is `ran`/`fail`; skip the remaining steps.
3. `env.exec(binary, ['plugin', 'add', \`${name}@skillsmith-mkt\`], { env: { CODEX_HOME: home }, ... })`.
   If output contains `failed to parse plugin.json` →
   `{ checkId: 'codex.manifest', toolSeverity: 'error', normalizedSeverity: 'error', message: <text after 'failed to parse plugin.json: '>, file: '.codex-plugin/plugin.json', subject: 'manifest', raw: <line> }`.
4. On successful add (output contains `Added plugin`), confirm with
   `env.exec(binary, ['plugin', 'list', '--json'], { env: { CODEX_HOME: home }, ... })`; the JSON's
   `installed` array must contain `name`. Unparseable list JSON or plugin absent ⇒
   `status: 'error', skipReason: 'exec-error'`.
5. Always append the coverage-gap notice (Design D5 — codex static checks the manifest only):
   `{ checkId: 'codex.static-coverage', toolSeverity: null, normalizedSeverity: 'info', message: 'codex static checked the manifest only; run --deep for skill validation', file: null, subject: 'plugin' }`.
6. `coverage: { manifest: true, skills: false }`. `command` (temp paths redacted):
   `codex plugin marketplace add <root> && codex plugin add <name>@<mkt>`.
7. Classification: known substrings (`does not contain a supported manifest`,
   `failed to parse plugin.json`, `Added plugin`) ⇒ `ran`; `timedOut` ⇒ `timeout`; any other
   non-zero/unrecognized outcome ⇒ `exec-error`. Availability/version/drift handling identical in
   shape to Task 3 (binary `codex`, drift notice
   `codex <observed> differs from verified 0.142.5; parsing may be less reliable`, checkId
   `codex.version-drift`).

**Frozen canned outputs (unit-test inputs, from research):**

```text
Added plugin `dummytest` ...                                                        [exit 0]
Error: failed to parse plugin.json: EOF while parsing an object at line 6 column 0  [exit 1, stderr]
Error: invalid marketplace file /root/.agents/plugins/marketplace.json: marketplace root does not contain a supported manifest  [exit 1, stderr]
{"installed":[{"name":"dummytest","version":"0.1.0","installed":true,"enabled":true,"source":"skillsmith-mkt"}],"available":[]}  [exit 0]
```

- [ ] **Step 1: Failing tests.** Create `verify-static.test.ts` (codex). Use the Task-1 fixtures
  (`fixtures/verify/dummytest`, `fixtures/verify/codex-badplug`) as `opts.path` so wrapper
  synthesis runs against real files; fake `env.exec` with a sequence keyed on `args[1]`
  (`marketplace` / `add` / `list`):
  - Happy path (dummytest): 3 exec calls observed; each carried a non-empty `env.CODEX_HOME`;
    mode `ran`/`pass`; findings = exactly the one `codex.static-coverage` info notice;
    `coverage {manifest: true, skills: false}`; command string equals
    `codex plugin marketplace add <root> && codex plugin add dummytest@<mkt>`.
  - Bad manifest (codex-badplug, canned `failed to parse plugin.json` on the `add` call) → mode
    `ran`/`fail`; findings contain `codex.manifest` error with message
    `EOF while parsing an object at line 6 column 0`, `file: '.codex-plugin/plugin.json'` — plus
    the coverage notice. Wrapper fell back to `basename` name `codex-badplug`.
  - Marketplace-layout failure (canned `does not contain a supported manifest` on the first call)
    → `codex.marketplace` error finding, `subject: 'marketplace'`, mode `fail`, `plugin add` never
    called.
  - `list --json` returns garbage → `status: 'error'`, `skipReason: 'exec-error'`.
  - `timedOut` on any call → `skipReason: 'timeout'`.
  - Target without `.codex-plugin/plugin.json` (use `fixtures/verify/claude-noname`) → `ran`/`pass`
    with the `codex.no-manifest` info finding and `coverage {manifest: false, skills: false}`;
    zero exec calls.
  - `detect` finds nothing → `available: false`, `skipReason: 'not-installed'`, `modes: []`.
  - After each run, the temp `<root>`/`CODEX_HOME` dirs no longer exist (cleanup in `finally` —
    capture the paths via the exec fake and assert with `fs.exists`).
- [ ] **Step 2: Implement** `packages/core/src/agents/codex/verify.ts` (static only; mode dispatch
  table pattern as in Task 3).
- [ ] **Step 3: Verify and commit.**

```bash
git add packages/core/src/agents/codex/verify.ts packages/core/tests/agents/codex/verify-static.test.ts
git commit -m "feat(core): add codex static manifest verify" \
  -m "Synthesizes the marketplace layout under a temp root + throwaway CODEX_HOME; parses" \
  -m "failed-to-parse/unsupported-manifest errors; always emits the manifest-only coverage notice."
```

**Automated verification:** `bun test packages/core/tests/agents/codex/verify-static.test.ts` ·
`bunx tsc --noEmit` · `bun run lint:boundaries`

---

## Task 6 [P11-T05] — `agents/codex/verify.ts`: deep stderr scrape (model: opus)

**Consumes:** Task 5's `agents/codex/verify.ts`; `DEEP_TIMEOUT_MS` from `../../verify/types.ts`;
`env.exec`, `env.listDir`, `env.fileExists`; `node:fs/promises` for the throwaway project dir.

**Files:**
- Modify: `packages/core/src/agents/codex/verify.ts`
- Create: `packages/core/tests/agents/codex/verify-deep.test.ts`

**Interfaces produced (added export):**

```ts
/** Pure. Extracts `failed to load skill` findings from codex exec stderr. projDir strips prefixes. */
export const parseCodexExecStderr = (stderr: string, projDir: string): VerifyFinding[];
```

**Deep mode contract:**
- Setup: `proj = mkdtemp(join(tmpdir(), 'skillsmith-codex-proj-'))`;
  `home = mkdtemp(join(tmpdir(), 'skillsmith-codex-home-'))` (empty — no auth, no model call).
  For each skill subdir `n` of `<opts.path>/skills/` containing `SKILL.md`, copy it to
  `<proj>/.agents/skills/<n>/` (Codex reads `.agents/skills`, NOT `.claude/skills`). No skills dir
  ⇒ still run (zero findings expected). Both temp dirs removed in `finally`.
- Command: `env.exec(binary, ['exec', '-C', proj, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'ok'], { env: { CODEX_HOME: home }, timeoutMs: DEEP_TIMEOUT_MS, signal })`.
  `--skip-git-repo-check` is REQUIRED for temp workdirs. Reported `command` (redacted):
  `codex exec -C <proj> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"`.
- `parseCodexExecStderr`: for each stderr line matching `failed to load skill <file>: <reason>`
  (regex `/failed to load skill (.+?): (.+)$/`), emit
  `{ checkId: 'codex.skill-load', toolSeverity: 'error', normalizedSeverity: 'error', message: <reason>, file: <file with the \`${projDir}/\` prefix stripped>, subject: 'skill', raw: <line> }`
  — e.g. `file: '.agents/skills/bad-yaml/SKILL.md'`.
- **Classification (Global Constraint 7):** `ran` when exit 0, OR any `failed to load skill` line,
  OR the frozen unauthenticated tail is present (stderr contains `401 Unauthorized`). The skill-load
  errors fire at session start before any model call — proven in a fully unauthenticated run whose
  same-run tail was `ERROR codex_api...: 401 Unauthorized` + exit 1; that tail is the expected
  healthy ending and is NOT a finding. `timedOut` ⇒ `timeout`; any other unrecognized non-zero ⇒
  `exec-error`.
- `coverage: { manifest: false, skills: true }` — deep is the ONLY codex surface that validates skills.
- Wire `deep` into the codex mode dispatch table (order static → deep).

**Frozen canned stderr (unit-test input; exit code 1):**

```text
ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-yaml/SKILL.md: invalid YAML: found unexpected end of stream at line 3 column 23
ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-noframe/SKILL.md: missing YAML frontmatter delimited by ---
ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-nodesc/SKILL.md: missing field `description`
ERROR codex_api: 401 Unauthorized
```

- [ ] **Step 1: Failing tests.** Create `verify-deep.test.ts` (codex):
  - `parseCodexExecStderr` on the canned block with `projDir: '/proj'` → exactly 3
    `codex.skill-load` errors with messages
    `invalid YAML: found unexpected end of stream at line 3 column 23`,
    `missing YAML frontmatter delimited by ---`, and `` missing field `description` ``, files
    `.agents/skills/{bad-yaml,bad-noframe,bad-nodesc}/SKILL.md`; the `401 Unauthorized` line
    produced NO finding.
  - `verifyCodex` with `modes: ['static','deep']` against `fixtures/verify/dummytest` (exec fake:
    static happy-path sequence from Task 5, then the canned deep stderr with `code: 1`) → deep
    ModeResult `status: 'ran'` (despite exit 1), `verdict: 'fail'`, 3 findings,
    `coverage {manifest: false, skills: true}`; tool verdict `'fail'`; the deep exec call carried a
    non-empty `env.CODEX_HOME` and args `['exec', '-C', <proj>, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'ok']`;
    before the deep call ran, `<proj>/.agents/skills/good-skill/SKILL.md` existed (assert from
    inside the exec fake).
  - Deep stderr = only the `401 Unauthorized` tail, `code: 1` → `status: 'ran'`, `verdict: 'pass'`,
    `findings: []` (clean skills, unauthenticated tail tolerated).
  - Unrecognized failure (`code: 1`, stderr `'panic: something'`) → `status: 'error'`,
    `skipReason: 'exec-error'`, `verdict: null`.
  - `timedOut` → `skipReason: 'timeout'`.
  - Temp `proj`/`home` dirs removed after the run (capture via fake, assert not exists).
- [ ] **Step 2: Implement** the deep mode in `agents/codex/verify.ts`.
- [ ] **Step 3: Verify and commit.**

```bash
git add packages/core/src/agents/codex/verify.ts packages/core/tests/agents/codex/verify-deep.test.ts
git commit -m "feat(core): add codex deep skill-load verify" \
  -m "Throwaway CODEX_HOME + .agents/skills project; scrapes failed-to-load-skill stderr lines;" \
  -m "the 401 Unauthorized tail + exit 1 is the expected healthy ending, never a finding."
```

**Automated verification:** `bun test packages/core/tests/agents/codex/` · `bunx tsc --noEmit` ·
`bun run lint:boundaries`

---

## Task 7 [P11-T06] — CLI command: matrix rendering, `--json`, exit codes, help topic (model: sonnet)

**Consumes:** `runVerify`, `VerifyReport`, `VerifyTool`, `VerifyOutcome`, `NormalizedSeverity`,
`defaultScanEnv`, `getAgent` from `@skillsmith/core`; `verifyClaudeCode` / `verifyCodex` (core
internal, wired in Step 1); `commander` (`Command`, `Option`, `Argument`, `InvalidArgumentError`);
`zod`.

**Files:**
- Modify: `packages/core/src/verify/run.ts` (+ `packages/core/src/index.ts`,
  `packages/core/tests/public-api.test.ts`) — add the default-wired `verifyPlugin`
- Create: `packages/cli/src/commands/verify.ts`
- Create: `packages/cli/src/output/verify-human.ts`
- Create: `packages/cli/src/output/verify-json.ts`
- Modify: `packages/cli/src/program.ts` (register), `packages/cli/src/help/topics.ts` (exit-codes topic)
- Create: `packages/cli/tests/commands/verify.test.ts`,
  `packages/cli/tests/output/verify-json.test.ts`, `packages/cli/tests/output/verify-human.test.ts`
- Create: `packages/cli/tests/fixtures/verify-report.golden.json`

**Interfaces produced:**

```ts
// packages/core/src/verify/run.ts (addition; imports the two per-agent checkers)
export const verifyPlugin = (
  env: ScanEnv,
  opts: VerifyOptions,
): Promise<Result<VerifyReport, SkillSmithError>>; // = runVerify(env, opts, defaultCheckers)

// packages/cli/src/commands/verify.ts
export const verifyCommand = (signal?: AbortSignal): Command;
export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4; // pure, exported for tests

// packages/cli/src/output/verify-human.ts
export const renderVerifyHuman = (report: VerifyReport, exitCode: number): string;

// packages/cli/src/output/verify-json.ts
export const VerifyJsonSchema: z.ZodType<...>;
export const renderVerifyJson = (report: VerifyReport): string; // validates via zod BEFORE writing
```

- [ ] **Step 1 (core): default checker wiring.** In `verify/run.ts` import
  `{ verifyClaudeCode } from '../agents/claude-code/verify.ts'` and
  `{ verifyCodex } from '../agents/codex/verify.ts'`; add `verifyPlugin` as above; export it from
  `index.ts`; add `'verifyPlugin'` to the public-api test's expected set. Test (append to
  `packages/core/tests/verify/run.test.ts`): `verifyPlugin` on `fixtures/verify/dummytest` with an
  env whose `path: []` (so neither tool detects) → `ok`, both ToolVerdicts
  `available: false, skipReason: 'not-installed'`, `summary.verdict: 'inconclusive'`,
  `summary.skipped: ['claude-code','codex']`. Commit separately:

```bash
git commit -m "feat(core): wire default verify checkers into verifyPlugin"
```

- [ ] **Step 2 (tests first): exit-code table.** `packages/cli/tests/commands/verify.test.ts` —
  build minimal `VerifyReport` literals and assert `verifyExitCode`:

  | Case | Expected |
  |---|---|
  | all ran modes pass | `0` |
  | warn without strict (summary `warn`) | `0` |
  | any tool `fail` (even with another tool skipped) | `1` (**1 outranks 4**) |
  | nothing ran at all (all tools unavailable) | `4` |
  | `explicitTools: true` + any `available: false` tool | `4` |
  | `requested.modes` includes `'deep'` + an available tool whose deep mode is `status: 'error'` (timeout) | `4` |
  | same with `skipReason: 'exec-error'` | `4` |
  | auto (non-explicit) tools, one absent, other passed | `0` (silent skip) |
  | deep requested and every available tool's deep `ran` | `0` |

  Implementation (exact):

  ```ts
  export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4 => {
    if (report.summary.verdict === 'fail') return 1;
    const anyRan = report.tools.some((t) => t.modes.some((m) => m.status === 'ran'));
    if (!anyRan) return 4;
    if (report.requested.explicitTools && report.tools.some((t) => !t.available)) return 4;
    if (report.requested.modes.includes('deep')) {
      const deepGap = report.tools.some(
        (t) => t.available && !t.modes.some((m) => m.mode === 'deep' && m.status === 'ran'),
      );
      if (deepGap) return 4;
    }
    return 0;
  };
  ```

  (Strict is already folded into verdicts by core; deep never fails for auth, so only
  timeout/exec-error can create a deep gap. Usage errors exit 2 before a report exists; SIGINT
  exits 130 — neither goes through this function.)

- [ ] **Step 3 (tests first): JSON contract golden.** Commit
  `packages/cli/tests/fixtures/verify-report.golden.json` containing **exactly** the spec §8
  example document (plugin `/abs/plugins/dummytest`, both tools, `--deep`, summary
  `{"verdict":"fail","verified":[],"failed":["claude-code","codex"],"skipped":[],"counts":{"error":3,"warning":2,"info":1}}` —
  copy it from `docs/superpowers/specs/2026-07-06-verify-design.md` §8 verbatim).
  `verify-json.test.ts`:
  - Build the same report as a TS literal (the golden minus the `kind` field, since `kind` is
    added by the renderer); `renderVerifyJson(report)` → `JSON.parse` deep-equals
    `JSON.parse(goldenText)` (parse-compare, not string-compare — formatting-proof).
  - `VerifyJsonSchema.parse(JSON.parse(rendered))` succeeds.
  - Top-level field set is exactly
    `['schemaVersion','kind','target','requested','verifiedAgainst','summary','tools']` and
    `kind === 'skillsmith.verify'`, `schemaVersion === 1`.
  - A report with `skipReason: 'auth-required'` smuggled in fails schema validation (locks the
    enum `['not-installed','timeout','exec-error']`).
  - A not-installed tool renders as
    `{ available: false, skipReason: 'not-installed', verdict: 'inconclusive', modes: [] }` and
    validates.
  Implement `verify-json.ts` with zod schemas mirroring the Task-2 types field-for-field
  (`z.literal(1)`, `z.literal('skillsmith.verify')`, `z.enum` for every enum above, `.nullable()`
  for the nullable fields, `raw: z.string().optional()`);
  `renderVerifyJson` builds `{ schemaVersion: 1, kind: 'skillsmith.verify', target, requested, verifiedAgainst, summary, tools }`,
  calls `VerifyJsonSchema.parse(payload)`, then `JSON.stringify(payload, null, 2)`.
- [ ] **Step 4 (tests first): human renderer.** `verify-human.test.ts` asserts on
  `renderVerifyHuman(report, code)` output (substring assertions):
  - Header: `Verifying <target.path>  (mode: static · tools: claude-code, codex)` — modes joined
    with `, ` when deep (`mode: static, deep`).
  - Per tool: a line containing `<tool> <toolVersion>` and `verdict: <verdict>`; per mode a line
    `static  manifest ✓  skills ✓` using `✓` for covered, `—` for not covered; claude-code deep
    renders `skills ✓ (presence)`.
  - Per finding: marker by `normalizedSeverity` (`✘` error / `⚠` warning / `ℹ` info), then
    `<checkId>`, then the file when non-null, message indented on the next line (matches the
    mockup in `research/commands/verify.md`).
  - A ran mode with zero findings renders `(no findings)`.
  - Not-installed tool renders `<tool>  not installed (skipped)`.
  - Summary line: failures present →
    `\`${failed} tool failed, ${passed} passed.  (${e} error, ${w} warning, ${i} notice)  Exit code: ${code}\``
    (pluralize counts naturally); no failures → `` `verified: <verified list joined ', '>.  Exit code: ${code}` ``.
    (The mockups' standalone `Exit code: N` lines after stderr error blocks are annotations, NOT
    printed; only this stdout summary line includes it.)
- [ ] **Step 5: the command.** `packages/cli/src/commands/verify.ts`:

  ```ts
  const collectTool = (value: string, prev: string[]): string[] => {
    if (value !== 'claude-code' && value !== 'codex')
      throw new InvalidArgumentError(`--tool must be one of claude-code, codex (got '${value}')`);
    return [...prev, value];
  };

  export const verifyCommand = (signal?: AbortSignal): Command =>
    new Command('verify')
      .description('Verify that a plugin loads under each target tool')
      .addArgument(new Argument('<path>', 'Plugin or bare skill directory'))
      .addOption(
        new Option('-t, --tool <name>', 'Restrict to tool(s): claude-code | codex. Repeatable. Default: all detected.')
          .choices(['claude-code', 'codex'])
          .argParser(collectTool)
          .default([] as string[]),
      )
      .option('--static', 'Static verification only (no auth, no model call). Default.', false)
      .option('--deep', 'Also run session-backed load verification (isolated; no auth, no model call).', false)
      .option('--strict', 'Treat warnings as failures (exit 1 on any warning).', false)
      .option('--json', 'Emit the versioned JSON report on stdout.', false)
      .action(async (pathArg: string, opts) => { /* below */ });
  ```

  Notes: `.choices()` must stay even though `collectTool` re-validates — the completion
  declaration-gate test (`packages/cli/tests/completion/declaration-gate.test.ts`) requires
  `argChoices` on any option whose description contains a pipe-separated enum. `--static` is
  accepted for explicitness but drives nothing: the mode set is `{static, deep}` iff `--deep`,
  else `{static}` (passing both flags equals `--deep`; passing neither equals `--static`).

  Action flow:
  1. `env = await defaultScanEnv()`;
     `r = await verifyPlugin(env, { path: resolve(pathArg), tools: opts.tool.length > 0 ? opts.tool : undefined, deep: opts.deep, strict: opts.strict, ...(signal ? { signal } : {}) })`.
  2. `!r.ok`: if `signal?.aborted` → `process.exit(130)`; else
     `process.stderr.write(\`error: ${r.error.code === 'generic' ? r.error.message : JSON.stringify(r.error)}\n\`)`;
     `process.exit(2)` (the only core-err surface is input-shape validation — usage).
  3. `code = verifyExitCode(r.value)`.
  4. For each explicitly-named tool with `available: false`, write the rich stderr block (matches
     the mockup):

     ```text
     error: cannot verify: target tool '<tool>' is not installed on this system.

       'verify --tool <tool>' requires the <Tool> CLI. To install it:

         <installHint from getAgent(tool)>

       Re-run once installed, or drop --tool <tool> to verify with detected tools only.
     ```

  5. `process.stdout.write(opts.json ? renderVerifyJson(r.value) : renderVerifyHuman(r.value, code));`
  6. `process.exit(signal?.aborted ? 130 : code)`.

  Register in `program.ts`: `program.addCommand(verifyCommand(signal));` after
  `program.addCommand(checkCommand());`.
- [ ] **Step 6: help topic.** In `packages/cli/src/help/topics.ts` update the `exit-codes` topic
  string to:
  `'Exit codes\n  0 success\n  1 generic failure / verification failed\n  2 usage error\n  4 could not verify (verify: required tool or mode unavailable)\n  130 SIGINT\n\nFull reference: research/skillsmith-cli-design.md §6.1'`
  and update `packages/cli/tests/help/topics.test.ts` if it asserts the old text.
- [ ] **Step 7: smoke the built surface.**
  `bun run dev verify packages/core/tests/fixtures/verify/dummytest --json > /tmp/verify.json; echo $?`
  On a machine with claude installed expect exit 1 and schema-valid JSON; on a machine with
  neither tool expect exit 4. `bun run dev verify /tmp 2>&1; echo $?` → `error: ... is not a plugin
  or skill directory ...`, exit 2. `bun run dev verify x --tool nope` → exit 2.
- [ ] **Step 8: Verify and commit.**

```bash
git add packages/cli packages/core/src/verify/run.ts packages/core/src/index.ts packages/core/tests/public-api.test.ts packages/core/tests/verify/run.test.ts
git commit -m "feat(cli): add skillsmith verify command" \
  -m "Per-tool matrix rendering, versioned --json contract (schemaVersion 1, zod-validated before" \
  -m "write), exit codes 0/1/2/4/130 with fail-outranks-gap rollup, exit-codes help topic."
```

**Automated verification:** `bun test packages/cli packages/core` · `bunx tsc --noEmit` ·
`bun run lint:boundaries` · `bun run check`

---

## Task 8 [P11-TS02] — Env-gated live e2e against real `claude`/`codex` (model: sonnet)

**Consumes:** everything shipped in Tasks 1–7; the real `claude` / `codex` CLIs when present.

**Files:**
- Create: `packages/core/tests/verify/live-e2e.test.ts`
- Create: `packages/cli/tests/commands/verify-live.test.ts`

**Gating design (why CI skips):** both files are guarded by
`describe.skipIf(process.env.SKILLSMITH_E2E !== '1')` — CI never sets `SKILLSMITH_E2E` and its
runners don't have the tool CLIs installed, so the suites report as skipped and `bun run check`
stays green. Inside, each tool block is additionally guarded by
`describe.skipIf(!Bun.which('claude'))` / `describe.skipIf(!Bun.which('codex'))` so a machine with
only one CLI still runs half. Deep paths run isolated (empty `CLAUDE_CONFIG_DIR` / `CODEX_HOME`),
so **no auth or API spend is ever needed** — any machine with the CLIs installed can run this.
Per-test timeout 120 000 ms. This suite is also the **drift canary**: when a new tool version
changes an error string, these tests fail while the canned unit tests stay green — update
`VERIFIED_AGAINST` and the research doc together.

- [ ] **Step 1: core live suite** (`packages/core/tests/verify/live-e2e.test.ts`), driving
  `verifyClaudeCode` / `verifyCodex` with `defaultScanEnv()` against the Task-1 fixtures
  (substring assertions only — never full-string, so cosmetic tool changes don't flap):
  - claude static, `dummytest`: mode `ran`/`fail`; an error finding whose message contains
    `YAML frontmatter failed to parse` for `skills/bad-yaml/SKILL.md`; warnings whose messages
    contain `No frontmatter block found` and `No description in frontmatter`.
  - claude static, `claude-badjson`: manifest error containing `Invalid JSON syntax`.
  - claude static, `claude-noname`: manifest error containing `expected string, received undefined`.
  - claude deep, `dummytest`: `status: 'ran'` (the subprocess exits 1 with the auth-failed tail —
    that must NOT surface as skip/error/finding); no `claude.load-presence` finding for
    `good-skill`; presence warnings present for `bad-yaml`, `bad-noframe`, `bad-nodesc`.
  - codex static, `dummytest`: `ran`/`pass` with the `codex.static-coverage` info notice.
  - codex static, `codex-badplug`: error finding containing `failed to parse plugin.json`.
  - codex deep, `dummytest`: `status: 'ran'` despite the unauthenticated `401` tail; exactly 3
    `codex.skill-load` errors whose messages contain `invalid YAML`,
    `missing YAML frontmatter`, and `` missing field `description` ``.
- [ ] **Step 2: CLI live suite** (`packages/cli/tests/commands/verify-live.test.ts`): spawn
  `Bun.spawn(['bun', 'packages/cli/src/index.ts', 'verify', <abs fixture dummytest>, '--deep', '--json'], { cwd: <repo root> })`;
  expect exit code `1` (proven defects), stdout that `JSON.parse`s, `VerifyJsonSchema.parse`
  succeeds, `summary.failed` non-empty, and `schemaVersion === 1`. Second spawn:
  `verify <tmp-empty-dir>` → exit `2`. Third: `verify <fixture> --tool claude-code --tool codex`
  covers the multi-tool static path → exit `1` with a `tools` array of length 2.
- [ ] **Step 3: run locally** (this is the task's acceptance evidence — paste the output):
  `SKILLSMITH_E2E=1 bun test packages/core/tests/verify/live-e2e.test.ts packages/cli/tests/commands/verify-live.test.ts`
  Then confirm CI-mode skip: `bun test packages/core/tests/verify/live-e2e.test.ts` → suite
  skipped, exit 0.
- [ ] **Step 4: Commit.**

```bash
git add packages/core/tests/verify/live-e2e.test.ts packages/cli/tests/commands/verify-live.test.ts
git commit -m "test: add env-gated live verify e2e suite" \
  -m "SKILLSMITH_E2E=1 gates real claude/codex runs (per-tool Bun.which skip). Deep runs isolated" \
  -m "and auth-free. Skipped in CI (no CLIs); doubles as the version-drift canary."
```

**Automated verification:** `bun run check` (suites skip) · locally
`SKILLSMITH_E2E=1 bun test <both files>` (suites pass with both CLIs installed)

---

## Integration verification (whole-branch, before P11-RV)

1. `bun run check` — biome, eslint boundaries, tsc, actionlint, full `bun test` all green with the
   live suites skipped (no `SKILLSMITH_E2E`).
2. `SKILLSMITH_E2E=1 bun test packages/core/tests/verify/live-e2e.test.ts packages/cli/tests/commands/verify-live.test.ts`
   on a workstation with Claude Code ≥ 2.1.201 and codex-cli ≥ 0.142.5 installed — green, no auth
   required. If codex rejects the synthesized `marketplace.json` envelope, fix the envelope in
   `agents/codex/verify.ts` (the frozen parser substrings, JSON contract, and exit codes must not
   change).
3. Manual smoke: `bun run dev verify packages/core/tests/fixtures/verify/dummytest --deep` — human
   matrix shows claude-code fail / codex fail with per-tool findings; echoes exit 1.
   `bun run dev verify packages/core/tests/fixtures/verify/bare-skill --json | head` — a
   `"target":{"kind":"skill"}` report.
4. `bun run dev verify --help` matches the flag surface in `research/commands/verify.md`.
5. Verify nothing wrote to `~/.claude` or `~/.codex` (compare `ls -la` timestamps before/after the
   live run).
6. PR: squash-merge with title `feat(cli): add skillsmith verify cross-tool load verification`
   (this is the commit release-please parses → v0.4.0).

## Out of scope (do not build these)

- Skill/plugin **execution** verification — `verify` is load-only.
- `kilo-code` / `opencode` verify — no proven verifier; `--tool` values other than
  `claude-code`/`codex` are usage errors (exit 2).
- Agent-SDK mechanism — CLI shell-out only in this milestone.
- Auto-fix / applying remediation — findings carry text only.
- Remote/URL inputs — local paths only.
- A `--timeout` flag or a user-facing verified-against docs matrix (→ P14).
- Codex `app-server skills/list` enumeration (experimental; not driven end-to-end).
- `SKILLSMITH_TOOL` env-var wiring for `--tool` (listed in the research flag table, not in the
  spec; sibling commands don't wire it either — defer).
