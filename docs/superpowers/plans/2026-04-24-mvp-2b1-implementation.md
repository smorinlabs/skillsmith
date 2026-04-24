# SkillSmith MVP-2b.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SkillSmith `v0.3.0` (internal milestone): `skillsmith list`, `skillsmith doctor`, and `skillsmith check` — all read-only, `--json`-capable — backed by a skill-scanning foundation (`listSkills`, `SkillEntry`, `Agent.getSkillRoots`) and a mode-parameterized check runner with 8 built-in checks.

**Architecture:** Each agent exposes `getSkillRoots(env, scope): readonly string[]` (pure path computation). A central `walkSkillDir` does filesystem IO; `listSkills` orchestrates tool × scope × root iteration, applying dedup, glob filtering, and `--duplicates` detection. `doctor`/`check` share a single `Check[]` registry; `runChecks(registry, ctx)` filters by `ctx.mode` and aggregates findings. CLI commands are thin: parse args → call core → render JSON or human output → translate errors to exit codes.

**Tech Stack:** adds `gray-matter` (SKILL.md YAML) to `@skillsmith/core`. Introduces `bun test --coverage` ≥ 85% gate on `packages/core/src/doctor/**` and `skills/**`. No new CLI deps.

**Spec:** `docs/superpowers/specs/2026-04-24-mvp-2b1-design.md`
**Prerequisite:** `v0.2.0` (MVP-2a) tagged, including round-1 bug audit and all OSS basics / architecture docs.

---

## Conventions

- All paths are repo-relative from the workspace root.
- Every task commits using Conventional Commits; commitlint enforces `type(scope)?: subject` with scopes ∈ `{cli, core, main}`. Docs/ci/chore commits omit the scope.
- TDD applies to behavior code. Scaffolding tasks (types, deps, config) verify via tool runs.
- `bun test` auto-discovers `*.test.ts`; per-slice tests live under `packages/*/tests/` mirroring `src/`.
- Types in later tasks match earlier declarations (enforced inline via the type references).

---

## Phase A — Foundation

### Task 1: Extend `ScanEnv` with `listDir`

**Files:**
- Modify: `packages/core/src/env/types.ts`
- Modify: `packages/core/src/env/default.ts`
- Create: `packages/core/tests/env/list-dir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/env/list-dir.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';

describe('defaultScanEnv.listDir', () => {
  test('returns entries without . / ..', async () => {
    const env = await defaultScanEnv();
    const d = join('/tmp', `sk-listdir-${Date.now()}`);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'a.txt'), '');
    await mkdir(join(d, 'sub'));
    try {
      const entries = (await env.listDir(d)).sort();
      expect(entries).toEqual(['a.txt', 'sub']);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('returns [] for a missing directory', async () => {
    const env = await defaultScanEnv();
    const entries = await env.listDir('/nope/definitely/not/here');
    expect(entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/env/list-dir.test.ts`
Expected: FAIL — `env.listDir is not a function`.

- [ ] **Step 3: Add `listDir` to the `ScanEnv` interface**

In `packages/core/src/env/types.ts`, extend the `ScanEnv` interface (add after the existing `realpath` method):

```ts
  listDir(path: string): Promise<readonly string[]>;
```

- [ ] **Step 4: Implement `listDir` in `defaultScanEnv`**

In `packages/core/src/env/default.ts`, add to the imports:

```ts
import { readdir } from 'node:fs/promises';
```

And inside the returned `ScanEnv` object (before `runVersion`):

```ts
    listDir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
```

- [ ] **Step 5: Verify the test passes**

Run: `bun test packages/core/tests/env/list-dir.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/env/types.ts packages/core/src/env/default.ts packages/core/tests/env/list-dir.test.ts
git commit -m "feat(core): add ScanEnv.listDir for directory enumeration"
```

---

### Task 2: Add `skill-parse-error` variant

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/tests/errors.test.ts`

- [ ] **Step 1: Extend the failing test**

Append to `packages/core/tests/errors.test.ts`:

```ts
import { skillParseError } from '../src/errors.ts';

describe('skillParseError', () => {
  test('carries message and file', () => {
    const e = skillParseError('bad yaml', '/a/b/SKILL.md');
    expect(e.code).toBe('skill-parse-error');
    if (e.code === 'skill-parse-error') {
      expect(e.message).toBe('bad yaml');
      expect(e.file).toBe('/a/b/SKILL.md');
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/errors.test.ts`
Expected: FAIL — `skillParseError is not a function`.

- [ ] **Step 3: Extend the `SkillSmithError` union**

In `packages/core/src/errors.ts`:

```ts
export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string }
  | { code: 'config-error'; message: string; file?: string; line?: number }
  | { code: 'skill-parse-error'; message: string; file: string };

export const skillParseError = (message: string, file: string): SkillSmithError => ({
  code: 'skill-parse-error',
  message,
  file,
});
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/core/tests/errors.test.ts`
Expected: 3 pass (2 existing + 1 new).

- [ ] **Step 5: Update exit-code mapping**

In `packages/cli/src/util/exit-codes.ts`:

```ts
    case 'skill-parse-error':
      return 1;
```

And add a test in `packages/cli/tests/util/exit-codes.test.ts`:

```ts
  test("'skill-parse-error' → 1", () => {
    const e: SkillSmithError = { code: 'skill-parse-error', message: 'x', file: 'y' };
    expect(exitCodeForError(e)).toBe(1);
  });
```

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/cli/tests/util/exit-codes.test.ts`
Expected: all pass.

```bash
git add packages/core/src/errors.ts packages/core/tests/errors.test.ts packages/cli/src/util/exit-codes.ts packages/cli/tests/util/exit-codes.test.ts
git commit -m "feat(core): add skill-parse-error variant"
```

---

### Task 3: `skills/types.ts` + frontmatter parser

**Files:**
- Create: `packages/core/src/skills/types.ts`
- Create: `packages/core/src/skills/frontmatter.ts`
- Create: `packages/core/tests/skills/frontmatter.test.ts`

- [ ] **Step 1: Add `gray-matter` dep**

Run:
```bash
cd packages/core && bun add gray-matter && cd ../..
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/tests/skills/frontmatter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.ts';

describe('parseSkillFrontmatter', () => {
  test('returns empty frontmatter for a body-only file', () => {
    const r = parseSkillFrontmatter('# Hello\n\nno frontmatter here');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  test('parses name, description, version', () => {
    const r = parseSkillFrontmatter('---\nname: grep\ndescription: search files\nversion: 1.2.3\n---\n\n# body');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('grep');
      expect(r.value.description).toBe('search files');
      expect(r.value.version).toBe('1.2.3');
    }
  });

  test('ignores unknown frontmatter keys', () => {
    const r = parseSkillFrontmatter('---\nname: grep\nbogus: true\n---\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('grep');
  });

  test('returns err for malformed YAML', () => {
    const r = parseSkillFrontmatter('---\nname: [unclosed\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('skill-parse-error');
  });
});
```

- [ ] **Step 3: Verify it fails**

Run: `bun test packages/core/tests/skills/frontmatter.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `packages/core/src/skills/types.ts`**

```ts
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';

export interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
}

export interface SkillEntry {
  name: string;
  path: string;
  realpath: string;
  tool: SupportedTool;
  scope: Scope;
  root: string;
  frontmatter: Frontmatter | null;
  // MVP-2c adds: source?, storePath?, installMethod, commitSha?
}
```

- [ ] **Step 5: Implement `packages/core/src/skills/frontmatter.ts`**

```ts
import matter from 'gray-matter';
import { err, ok, type Result } from '../result.ts';
import { skillParseError, type SkillSmithError } from '../errors.ts';
import type { Frontmatter } from './types.ts';

export const parseSkillFrontmatter = (
  text: string,
  file = '<inline>',
): Result<Frontmatter, SkillSmithError> => {
  try {
    const parsed = matter(text);
    const data = parsed.data as Record<string, unknown>;
    const fm: Frontmatter = {};
    if (typeof data.name === 'string') fm.name = data.name;
    if (typeof data.description === 'string') fm.description = data.description;
    if (typeof data.version === 'string') fm.version = data.version;
    return ok(fm);
  } catch (e) {
    return err(skillParseError(e instanceof Error ? e.message : String(e), file));
  }
};
```

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/core/tests/skills/frontmatter.test.ts`
Expected: 4 pass.

```bash
git add packages/core/src/skills packages/core/tests/skills/frontmatter.test.ts packages/core/package.json bun.lock
git commit -m "feat(core): add SkillEntry type and parseSkillFrontmatter"
```

---

## Phase B — Walker

### Task 4: `walkSkillDir` with full test matrix

**Files:**
- Create: `packages/core/src/skills/walk.ts`
- Create: `packages/core/tests/skills/walk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/skills/walk.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { walkSkillDir } from '../../src/skills/walk.ts';
import type { ScanEnv } from '../../src/env/types.ts';

interface Fake {
  dirs: Record<string, readonly string[]>;
  files: Record<string, string>;
  realpaths: Record<string, string>;
}

const fakeEnv = (fake: Fake): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in fake.files || p in fake.dirs,
  realpath: async (p) => fake.realpaths[p] ?? p,
  listDir: async (p) => fake.dirs[p] ?? [],
  runVersion: async () => 'unknown',
});

describe('walkSkillDir', () => {
  test('returns [] when root does not exist', async () => {
    const env = fakeEnv({ dirs: {}, files: {}, realpaths: {} });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
    });
    expect(r).toEqual([]);
  });

  test('returns one entry per skill directory with SKILL.md', async () => {
    const env = fakeEnv({
      dirs: {
        '/h/.claude/skills': ['grep', 'diff'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/h/.claude/skills/diff': ['SKILL.md'],
      },
      files: {
        '/h/.claude/skills/grep/SKILL.md': '---\nname: grep\n---\n',
        '/h/.claude/skills/diff/SKILL.md': '---\nname: diff\n---\n',
      },
      realpaths: {},
    });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
    });
    expect(r.map((e) => e.name).sort()).toEqual(['diff', 'grep']);
    expect(r.every((e) => e.frontmatter !== null)).toBe(true);
  });

  test('entries with missing SKILL.md are omitted', async () => {
    const env = fakeEnv({
      dirs: {
        '/root': ['real', 'bogus'],
        '/root/real': ['SKILL.md'],
        '/root/bogus': [],
      },
      files: { '/root/real/SKILL.md': '---\nname: real\n---\n' },
      realpaths: {},
    });
    const r = await walkSkillDir(env, { tool: 'claude-code', scope: 'user', root: '/root' });
    expect(r.map((e) => e.name)).toEqual(['real']);
  });

  test('malformed SKILL.md yields frontmatter: null', async () => {
    const env = fakeEnv({
      dirs: { '/r': ['bad'], '/r/bad': ['SKILL.md'] },
      files: { '/r/bad/SKILL.md': '---\nname: [unclosed\n---\n' },
      realpaths: {},
    });
    const r = await walkSkillDir(env, { tool: 'claude-code', scope: 'user', root: '/r' });
    expect(r).toHaveLength(1);
    expect(r[0]?.frontmatter).toBeNull();
  });

  test('populates realpath (symlink collapse)', async () => {
    const env = fakeEnv({
      dirs: { '/r': ['link'], '/r/link': ['SKILL.md'] },
      files: { '/r/link/SKILL.md': '---\n---\n' },
      realpaths: { '/r/link': '/elsewhere/real' },
    });
    const r = await walkSkillDir(env, { tool: 'claude-code', scope: 'user', root: '/r' });
    expect(r[0]?.realpath).toBe('/elsewhere/real');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/core/tests/skills/walk.test.ts`
Expected: FAIL — `walkSkillDir` not found.

- [ ] **Step 3: Implement `packages/core/src/skills/walk.ts`**

```ts
import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { parseSkillFrontmatter } from './frontmatter.ts';
import type { SkillEntry } from './types.ts';

export interface WalkSkillDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
}

export const walkSkillDir = async (
  env: ScanEnv,
  opts: WalkSkillDirOpts,
): Promise<SkillEntry[]> => {
  if (!(await env.fileExists(opts.root))) return [];

  const entries = await env.listDir(opts.root);
  const results: SkillEntry[] = [];

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const path = join(opts.root, name);
    const skillMd = join(path, 'SKILL.md');
    if (!(await env.fileExists(skillMd))) continue;

    let frontmatter: SkillEntry['frontmatter'] = null;
    try {
      const text = await Bun.file(skillMd).text();
      const parsed = parseSkillFrontmatter(text, skillMd);
      if (parsed.ok) frontmatter = parsed.value;
    } catch {
      frontmatter = null;
    }

    let realpath = path;
    try {
      realpath = await env.realpath(path);
    } catch {
      // keep logical path
    }

    results.push({
      name,
      path,
      realpath,
      tool: opts.tool,
      scope: opts.scope,
      root: opts.root,
      frontmatter,
    });
  }

  return results;
};
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/core/tests/skills/walk.test.ts`
Expected: 5 pass.

> Note: the test at "populates realpath" uses `Bun.file(...)` inside the implementation; in a fake filesystem `Bun.file(...)` would miss. Augment the test by pointing it at a real temp file OR by injecting the reader. For MVP-2b.1 the walker uses `Bun.file` for `SKILL.md` reads — the test that exercises realpath also provides a real temp SKILL.md via writeFile, or the walker abstracts the reader through ScanEnv. Simplest: extend ScanEnv with a `readText(p): Promise<string>` method, same dependency-injection pattern as `listDir`. Do that in the next step.

- [ ] **Step 5: Add `readText` to `ScanEnv` and thread through**

In `packages/core/src/env/types.ts` add to the interface:

```ts
  readText(path: string): Promise<string>;
```

In `packages/core/src/env/default.ts`, import:

```ts
import { readFile } from 'node:fs/promises';
```

And inside the returned object (next to `listDir`):

```ts
    readText: async (p) => readFile(p, 'utf8'),
```

Update the walker in `packages/core/src/skills/walk.ts` to use `env.readText(skillMd)` instead of `Bun.file(...).text()`. Update the fake env in the test to include `readText: async (p) => fake.files[p] ?? ''`.

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/core/tests/skills/walk.test.ts`
Expected: 5 pass.

```bash
git add packages/core/src/skills/walk.ts packages/core/src/env/types.ts packages/core/src/env/default.ts packages/core/tests/skills/walk.test.ts
git commit -m "feat(core): add walkSkillDir with injectable readText"
```

---

## Phase C — Per-agent `getSkillRoots`

### Task 5: `claude-code` skill roots

**Files:**
- Create: `packages/core/src/agents/claude-code/skill-roots.ts`
- Create: `packages/core/tests/agents/claude-code/skill-roots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/agents/claude-code/skill-roots.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/claude-code/skill-roots.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (overrides: Partial<ScanEnv> = {}, home = '/h'): ScanEnv => ({
  homeDir: home,
  path: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  ...overrides,
});

describe('claude-code getSkillRoots', () => {
  test('user → ~/.claude/skills', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/proj', envVars: {} })).toEqual([
      '/h/.claude/skills',
    ]);
  });

  test('user honors CLAUDE_CONFIG_DIR', () => {
    expect(
      getSkillRoots(env(), 'user', { cwd: '/proj', envVars: { CLAUDE_CONFIG_DIR: '/custom' } }),
    ).toEqual(['/custom/skills']);
  });

  test('project → <cwd>/.claude/skills', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/proj', envVars: {} })).toEqual([
      '/proj/.claude/skills',
    ]);
  });

  test('system → empty (enterprise delivery is MDM-managed, not a fixed path)', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/proj', envVars: {} })).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/agents/claude-code/skill-roots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/agents/claude-code/skill-roots.ts`**

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';

export interface SkillRootsCtx {
  cwd: string;
  envVars: Record<string, string | undefined>;
}

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const base = ctx.envVars.CLAUDE_CONFIG_DIR ?? join(env.homeDir, '.claude');
      return [join(base, 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.claude', 'skills')];
    case 'system':
      return [];
  }
};
```

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/core/tests/agents/claude-code/skill-roots.test.ts`
Expected: 4 pass.

```bash
git add packages/core/src/agents/claude-code/skill-roots.ts packages/core/tests/agents/claude-code/skill-roots.test.ts
git commit -m "feat(core): add claude-code getSkillRoots"
```

---

### Task 6: `codex` skill roots (current + deprecated)

**Files:**
- Create: `packages/core/src/agents/codex/skill-roots.ts`
- Create: `packages/core/tests/agents/codex/skill-roots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/agents/codex/skill-roots.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/codex/skill-roots.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (home = '/h'): ScanEnv => ({
  homeDir: home,
  path: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
});

describe('codex getSkillRoots', () => {
  test('user → current (~/.agents/skills) + deprecated (~/.codex/skills)', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: {} })).toEqual([
      '/h/.agents/skills',
      '/h/.codex/skills',
    ]);
  });

  test('user honors CODEX_HOME for the deprecated path', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: { CODEX_HOME: '/cc' } })).toEqual([
      '/h/.agents/skills',
      '/cc/skills',
    ]);
  });

  test('project → <cwd>/.agents/skills', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/p', envVars: {} })).toEqual([
      '/p/.agents/skills',
    ]);
  });

  test('system → /etc/codex/skills', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/p', envVars: {} })).toEqual([
      '/etc/codex/skills',
    ]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/agents/codex/skill-roots.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/agents/codex/skill-roots.ts`**

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const deprecatedBase = ctx.envVars.CODEX_HOME ?? join(env.homeDir, '.codex');
      return [join(env.homeDir, '.agents', 'skills'), join(deprecatedBase, 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.agents', 'skills')];
    case 'system':
      return ['/etc/codex/skills'];
  }
};
```

> Note: we re-export `SkillRootsCtx` from the claude-code module rather than duplicating it. That's fine — it's a shared small type.

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/agents/codex/skill-roots.test.ts
git add packages/core/src/agents/codex/skill-roots.ts packages/core/tests/agents/codex/skill-roots.test.ts
git commit -m "feat(core): add codex getSkillRoots (current + deprecated)"
```

---

### Task 7: `kilo-code` skill roots

**Files:**
- Create: `packages/core/src/agents/kilo-code/skill-roots.ts`
- Create: `packages/core/tests/agents/kilo-code/skill-roots.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/kilo-code/skill-roots.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (home = '/h'): ScanEnv => ({
  homeDir: home,
  path: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
});

describe('kilo-code getSkillRoots', () => {
  test('user → .kilo + .claude compat + .agents compat', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: {} })).toEqual([
      '/h/.kilo/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('KILO_DISABLE_EXTERNAL_SKILLS=true drops compat dirs', () => {
    const r = getSkillRoots(env(), 'user', {
      cwd: '/p',
      envVars: { KILO_DISABLE_EXTERNAL_SKILLS: 'true' },
    });
    expect(r).toEqual(['/h/.kilo/skills']);
  });

  test('project → project .kilo + compat', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/p', envVars: {} })).toEqual([
      '/p/.kilo/skills',
      '/p/.claude/skills',
      '/p/.agents/skills',
    ]);
  });

  test('system → empty (no documented system path)', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/p', envVars: {} })).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/agents/kilo-code/skill-roots.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/core/src/agents/kilo-code/skill-roots.ts`:

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

const compatDisabled = (envVars: Record<string, string | undefined>): boolean =>
  envVars.KILO_DISABLE_EXTERNAL_SKILLS === 'true';

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const noCompat = compatDisabled(ctx.envVars);
  switch (scope) {
    case 'user': {
      const base = env.homeDir;
      const primary = [join(base, '.kilo', 'skills')];
      return noCompat
        ? primary
        : [...primary, join(base, '.claude', 'skills'), join(base, '.agents', 'skills')];
    }
    case 'project': {
      const base = ctx.cwd;
      const primary = [join(base, '.kilo', 'skills')];
      return noCompat
        ? primary
        : [...primary, join(base, '.claude', 'skills'), join(base, '.agents', 'skills')];
    }
    case 'system':
      return [];
  }
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/agents/kilo-code/skill-roots.test.ts
git add packages/core/src/agents/kilo-code/skill-roots.ts packages/core/tests/agents/kilo-code/skill-roots.test.ts
git commit -m "feat(core): add kilo-code getSkillRoots with KILO_DISABLE_EXTERNAL_SKILLS"
```

---

### Task 8: `opencode` skill roots

**Files:**
- Create: `packages/core/src/agents/opencode/skill-roots.ts`
- Create: `packages/core/tests/agents/opencode/skill-roots.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/opencode/skill-roots.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (home = '/h'): ScanEnv => ({
  homeDir: home,
  path: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
});

describe('opencode getSkillRoots', () => {
  test('user → XDG opencode + .claude compat + .agents compat', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: {} })).toEqual([
      '/h/.config/opencode/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS drops only .claude/skills', () => {
    const r = getSkillRoots(env(), 'user', {
      cwd: '/p',
      envVars: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' },
    });
    expect(r).toEqual(['/h/.config/opencode/skills', '/h/.agents/skills']);
  });

  test('OPENCODE_CONFIG_DIR overrides the native root', () => {
    expect(
      getSkillRoots(env(), 'user', { cwd: '/p', envVars: { OPENCODE_CONFIG_DIR: '/oc' } }),
    ).toEqual(['/oc/skills', '/h/.claude/skills', '/h/.agents/skills']);
  });

  test('project → three roots', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/p', envVars: {} })).toEqual([
      '/p/.opencode/skills',
      '/p/.claude/skills',
      '/p/.agents/skills',
    ]);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/p', envVars: {} })).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/agents/opencode/skill-roots.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/core/src/agents/opencode/skill-roots.ts`:

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const dropClaude = ctx.envVars.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS === 'true';
  switch (scope) {
    case 'user': {
      const nativeBase = ctx.envVars.OPENCODE_CONFIG_DIR ?? join(env.xdg.config, 'opencode');
      const roots: string[] = [join(nativeBase, 'skills')];
      if (!dropClaude) roots.push(join(env.homeDir, '.claude', 'skills'));
      roots.push(join(env.homeDir, '.agents', 'skills'));
      return roots;
    }
    case 'project': {
      const base = ctx.cwd;
      const roots: string[] = [join(base, '.opencode', 'skills')];
      if (!dropClaude) roots.push(join(base, '.claude', 'skills'));
      roots.push(join(base, '.agents', 'skills'));
      return roots;
    }
    case 'system':
      return [];
  }
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/agents/opencode/skill-roots.test.ts
git add packages/core/src/agents/opencode/skill-roots.ts packages/core/tests/agents/opencode/skill-roots.test.ts
git commit -m "feat(core): add opencode getSkillRoots with three-root compat"
```

---

### Task 9: Extend `Agent` interface + wire per-agent exports

**Files:**
- Modify: `packages/core/src/agents/types.ts`
- Modify: `packages/core/src/agents/<tool>/index.ts` × 4

- [ ] **Step 1: Extend the `Agent` interface**

In `packages/core/src/agents/types.ts`:

```ts
import type { Scope } from '../config/types.ts';
import type { SkillRootsCtx } from './claude-code/skill-roots.ts';

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(
    env: ScanEnv,
    signal?: AbortSignal,
  ): Promise<Result<InstallRecord[], SkillSmithError>>;
  getSkillRoots(env: ScanEnv, scope: Scope, ctx: SkillRootsCtx): readonly string[];
}

export type { SkillRootsCtx };
```

- [ ] **Step 2: Wire claude-code/index.ts**

Replace `packages/core/src/agents/claude-code/index.ts`:

```ts
import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getSkillRoots } from './skill-roots.ts';

export const claudeCodeAgent: Agent = {
  tool: 'claude-code',
  installHint,
  detect,
  getSkillRoots,
};
```

- [ ] **Step 3: Wire the other three indexes**

Apply the same pattern to `packages/core/src/agents/{codex,kilo-code,opencode}/index.ts` — import `./skill-roots.ts`, add `getSkillRoots` to the agent object.

- [ ] **Step 4: Verify typecheck and tests**

```bash
bunx tsc --noEmit
bun test packages/core/tests/agents
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents
git commit -m "feat(core): add getSkillRoots to Agent interface for all four agents"
```

---

## Phase D — List orchestrator

### Task 10: `listSkills`

**Files:**
- Create: `packages/core/src/scan/list-skills.ts`
- Create: `packages/core/tests/scan/list-skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { listSkills } from '../../src/scan/list-skills.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const fakeEnv = (existing: Record<string, readonly string[]>, files: Record<string, string> = {}): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in existing || p in files,
  realpath: async (p) => p,
  listDir: async (p) => existing[p] ?? [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('listSkills', () => {
  test('empty system → []', async () => {
    const r = await listSkills(fakeEnv({}), { cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('finds claude user skill and labels it', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep'],
        '/h/.claude/skills/grep': ['SKILL.md'],
      },
      { '/h/.claude/skills/grep/SKILL.md': '---\nname: grep\n---\n' },
    );
    const r = await listSkills(env, { cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.tool).toBe('claude-code');
      expect(r.value[0]?.scope).toBe('user');
    }
  });

  test('duplicatesOnly filters to cross-scope name collisions', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/proj/.claude/skills': ['grep'],
        '/proj/.claude/skills/grep': ['SKILL.md'],
      },
      {
        '/h/.claude/skills/grep/SKILL.md': '---\n---\n',
        '/proj/.claude/skills/grep/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(env, { cwd: '/proj', envVars: {}, duplicatesOnly: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value.every((e) => e.name === 'grep')).toBe(true);
    }
  });

  test('glob filter narrows result', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep', 'diff'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/h/.claude/skills/diff': ['SKILL.md'],
      },
      {
        '/h/.claude/skills/grep/SKILL.md': '---\n---\n',
        '/h/.claude/skills/diff/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(env, { cwd: '/proj', envVars: {}, globs: ['gr*'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((e) => e.name)).toEqual(['grep']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/scan/list-skills.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/core/src/scan/list-skills.ts`:

```ts
import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { SkillSmithError } from '../errors.ts';
import { ok, type Result } from '../result.ts';
import type { SkillEntry } from '../skills/types.ts';
import { walkSkillDir } from '../skills/walk.ts';

export interface ListSkillsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  duplicatesOnly?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  logger?: Logger;
  signal?: AbortSignal;
}

const applyGlobs = (entries: SkillEntry[], globs: readonly string[]): SkillEntry[] => {
  const compiled = globs.map((g) => new Glob(g));
  return entries.filter((e) => compiled.some((g) => g.match(e.name)));
};

const filterCrossScopeDuplicates = (entries: SkillEntry[]): SkillEntry[] => {
  const byName = new Map<string, Set<Scope>>();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, new Set());
    byName.get(e.name)?.add(e.scope);
  }
  const dupNames = new Set<string>();
  for (const [name, scopes] of byName) {
    if (scopes.size > 1) dupNames.add(name);
  }
  return entries.filter((e) => dupNames.has(e.name));
};

const dedupeByRealpath = (entries: SkillEntry[]): SkillEntry[] => {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const e of entries) {
    const key = `${e.tool}|${e.scope}|${e.realpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

export const listSkills = async (
  env: ScanEnv,
  opts: ListSkillsOpts,
): Promise<Result<SkillEntry[], SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const scopes = opts.scopes ?? SCOPES;
  const ctx = { cwd: opts.cwd, envVars: opts.envVars };

  const all: SkillEntry[] = [];
  for (const tool of tools) {
    if (opts.signal?.aborted) break;
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getSkillRoots(env, scope, ctx);
      for (const root of roots) {
        logger.debug(`scanning ${tool}/${scope}: ${root}`);
        const entries = await walkSkillDir(env, { tool, scope, root });
        all.push(...entries);
      }
    }
  }

  let result = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) result = applyGlobs(result, opts.globs);
  if (opts.duplicatesOnly) result = filterCrossScopeDuplicates(result);
  return ok(result);
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/scan/list-skills.test.ts
git add packages/core/src/scan/list-skills.ts packages/core/tests/scan/list-skills.test.ts
git commit -m "feat(core): add listSkills orchestrator with glob + dedup + duplicates"
```

---

## Phase E — Doctor core

### Task 11: Doctor types

**Files:**
- Create: `packages/core/src/doctor/types.ts`

- [ ] **Step 1: Implement `packages/core/src/doctor/types.ts`**

```ts
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { Logger } from '../env/logger.ts';

export type Severity = 'error' | 'warning' | 'info';
export type CheckRunMode = 'doctor' | 'check';

export interface Finding {
  checkId: string;
  severity: Severity;
  title: string;
  message: string;
  remediation?: string;
  tool?: SupportedTool;
  scope?: Scope;
}

export interface CheckRunContext {
  env: ScanEnv;
  mode: CheckRunMode;
  tools: readonly SupportedTool[];
  scopes: readonly Scope[];
  cwd: string;
  envVars: Record<string, string | undefined>;
  offline: boolean;
  logger: Logger;
  signal?: AbortSignal;
}

export interface Check {
  readonly id: string;
  readonly severity: Severity;
  readonly runsIn: readonly CheckRunMode[];
  run(ctx: CheckRunContext): Promise<Finding[]>;
}

export interface CheckRunResult {
  findings: Finding[];
  counts: { ok: number; warning: number; error: number };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/doctor/types.ts
git commit -m "feat(core): add doctor types (Finding, Check, CheckRunContext)"
```

---

### Task 12: `runChecks` runner

**Files:**
- Create: `packages/core/src/doctor/run.ts`
- Create: `packages/core/tests/doctor/run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { runChecks } from '../../src/doctor/run.ts';
import type { Check, CheckRunContext } from '../../src/doctor/types.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import { noopLogger } from '../../src/env/logger.ts';

const env: ScanEnv = {
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
};

const ctx: CheckRunContext = {
  env,
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  envVars: {},
  offline: false,
  logger: noopLogger,
};

const mkCheck = (id: string, severity: 'error' | 'warning', runsIn: ('doctor' | 'check')[], findings: number): Check => ({
  id,
  severity,
  runsIn,
  run: async () =>
    Array.from({ length: findings }, (_, i) => ({
      checkId: id,
      severity,
      title: `${id}-${i}`,
      message: '',
    })),
});

describe('runChecks', () => {
  test('filters registry by mode', async () => {
    const registry: Check[] = [
      mkCheck('a', 'warning', ['doctor'], 1),
      mkCheck('b', 'error', ['doctor', 'check'], 1),
    ];
    const r = await runChecks(registry, { ...ctx, mode: 'check' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings.map((f) => f.checkId)).toEqual(['b']);
    }
  });

  test('aggregates counts by severity', async () => {
    const registry: Check[] = [
      mkCheck('x', 'error', ['doctor'], 2),
      mkCheck('y', 'warning', ['doctor'], 3),
    ];
    const r = await runChecks(registry, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.counts).toEqual({ ok: 0, warning: 3, error: 2 });
    }
  });

  test('check that throws becomes an error finding', async () => {
    const bad: Check = {
      id: 'bad',
      severity: 'error',
      runsIn: ['doctor'],
      run: async () => {
        throw new Error('boom');
      },
    };
    const r = await runChecks([bad], ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings[0]?.title).toMatch(/bad/);
      expect(r.value.findings[0]?.severity).toBe('error');
    }
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/doctor/run.ts`**

```ts
import { genericError, type SkillSmithError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Check, CheckRunContext, CheckRunResult, Finding } from './types.ts';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const tally = (findings: readonly Finding[]): CheckRunResult['counts'] => {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const f of findings) {
    if (f.severity === 'error') counts.error++;
    else if (f.severity === 'warning') counts.warning++;
    else counts.ok++;
  }
  return counts;
};

export const runChecks = async (
  registry: readonly Check[],
  ctx: CheckRunContext,
): Promise<Result<CheckRunResult, SkillSmithError>> => {
  const applicable = registry.filter((c) => c.runsIn.includes(ctx.mode));
  const findings: Finding[] = [];
  for (const check of applicable) {
    if (ctx.signal?.aborted) return err(genericError('runChecks aborted'));
    try {
      findings.push(...(await check.run(ctx)));
    } catch (e) {
      findings.push({
        checkId: check.id,
        severity: 'error',
        title: `check '${check.id}' threw`,
        message: errorMessage(e),
      });
    }
  }
  return ok({ findings, counts: tally(findings) });
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/doctor/run.test.ts
git add packages/core/src/doctor/run.ts packages/core/tests/doctor/run.test.ts
git commit -m "feat(core): add runChecks with mode filtering and exception handling"
```

---

### Task 13: Doctor registry scaffold

**Files:**
- Create: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Create an empty registry**

```ts
import type { Check } from './types.ts';

// Checks are appended by Tasks 14-21. Keep exports stable so the
// public API surface doesn't churn as individual checks land.
export const builtInChecks: readonly Check[] = [];
```

- [ ] **Step 2: Verify typecheck passes**

```bash
bunx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/doctor/registry.ts
git commit -m "feat(core): add empty doctor registry scaffold"
```

---

## Phase F — Built-in checks (one per task)

Each check file defines a `Check` object and its unit test. After landing, the registry is updated to include it. The check's public face stays identical across all eight — tests assert `id`, `severity`, `runsIn`, and the findings produced for a fixture context.

### Task 14: `xdg-paths` check

**Files:**
- Create: `packages/core/src/doctor/checks/xdg-paths.ts`
- Create: `packages/core/tests/doctor/checks/xdg-paths.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { xdgPaths } from '../../../src/doctor/checks/xdg-paths.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';

const ctx = (xdg: { config: string; data: string; cache: string }): CheckRunContext => ({
  env: {
    homeDir: '/h',
    path: [],
    platform: 'linux',
    xdg,
    fileExists: async () => false,
    realpath: async (p) => p,
    listDir: async () => [],
    readText: async () => '',
    runVersion: async () => 'unknown',
  },
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  envVars: {},
  offline: false,
  logger: noopLogger,
});

describe('xdgPaths check', () => {
  test('all xdg dirs populated → no findings', async () => {
    const findings = await xdgPaths.run(
      ctx({ config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' }),
    );
    expect(findings).toEqual([]);
  });

  test('empty config path → error finding', async () => {
    const findings = await xdgPaths.run(
      ctx({ config: '', data: '/x', cache: '/y' }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
  });

  test('runs in both doctor and check', () => {
    expect(xdgPaths.runsIn).toEqual(['doctor', 'check']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/xdg-paths.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/doctor/checks/xdg-paths.ts`**

```ts
import type { Check } from '../types.ts';

export const xdgPaths: Check = {
  id: 'xdg-paths',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const missing: string[] = [];
    if (!ctx.env.xdg.config) missing.push('XDG_CONFIG_HOME');
    if (!ctx.env.xdg.data) missing.push('XDG_DATA_HOME');
    if (!ctx.env.xdg.cache) missing.push('XDG_CACHE_HOME');
    if (missing.length === 0) return [];
    return [
      {
        checkId: 'xdg-paths',
        severity: 'error',
        title: 'XDG path not resolvable',
        message: `Cannot resolve: ${missing.join(', ')}`,
        remediation: `Set ${missing[0]} or $HOME and rerun.`,
      },
    ];
  },
};
```

- [ ] **Step 4: Register and verify**

In `packages/core/src/doctor/registry.ts`:

```ts
import { xdgPaths } from './checks/xdg-paths.ts';

export const builtInChecks: readonly Check[] = [xdgPaths];
```

Run: `bun test packages/core/tests/doctor/checks/xdg-paths.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/doctor/checks/xdg-paths.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/xdg-paths.test.ts
git commit -m "feat(core): add xdg-paths doctor check"
```

---

### Task 15: `config-parse` check

**Files:**
- Create: `packages/core/src/doctor/checks/config-parse.ts`
- Create: `packages/core/tests/doctor/checks/config-parse.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { configParse } from '../../../src/doctor/checks/config-parse.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const ctx = (files: Record<string, string>, envVars: Record<string, string | undefined> = {}): CheckRunContext => {
  const env: ScanEnv = {
    homeDir: '/h',
    path: [],
    platform: 'linux',
    xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    fileExists: async (p) => p in files,
    realpath: async (p) => p,
    listDir: async () => [],
    readText: async (p) => files[p] ?? '',
    runVersion: async () => 'unknown',
  };
  return {
    env,
    mode: 'doctor',
    tools: [],
    scopes: [],
    cwd: '/p',
    envVars,
    offline: false,
    logger: noopLogger,
  };
};

describe('configParse check', () => {
  test('no config file present → no findings', async () => {
    const findings = await configParse.run(ctx({}));
    expect(findings).toEqual([]);
  });

  test('valid config → no findings', async () => {
    const findings = await configParse.run(
      ctx({ '/h/.config/skillsmith/config.toml': 'tool = "claude-code"\n' }),
    );
    expect(findings).toEqual([]);
  });

  test('malformed config → error finding', async () => {
    const findings = await configParse.run(
      ctx({ '/h/.config/skillsmith/config.toml': 'this is broken = tomLL\n' }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.checkId).toBe('config-parse');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/config-parse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/doctor/checks/config-parse.ts`**

```ts
import { loadConfig } from '../../config/load.ts';
import type { Check } from '../types.ts';

export const configParse: Check = {
  id: 'config-parse',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const r = await loadConfig(ctx.env, {
      envVars: ctx.envVars,
      cwd: ctx.cwd,
      readFile: ctx.env.readText,
    });
    if (r.ok) return [];
    if (r.error.code !== 'config-error') return [];
    return [
      {
        checkId: 'config-parse',
        severity: 'error',
        title: 'config parse failed',
        message: r.error.message,
        remediation: r.error.file
          ? `fix the config at ${r.error.file} and rerun`
          : 'review your SkillSmith config',
      },
    ];
  },
};
```

- [ ] **Step 4: Register and verify**

Append to `packages/core/src/doctor/registry.ts`:

```ts
import { configParse } from './checks/config-parse.ts';

export const builtInChecks: readonly Check[] = [xdgPaths, configParse];
```

Run: `bun test packages/core/tests/doctor/checks/config-parse.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/doctor/checks/config-parse.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/config-parse.test.ts
git commit -m "feat(core): add config-parse doctor check"
```

---

### Task 16: `tool-detected` check

**Files:**
- Create: `packages/core/src/doctor/checks/tool-detected.ts`
- Create: `packages/core/tests/doctor/checks/tool-detected.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { toolDetected } from '../../../src/doctor/checks/tool-detected.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';

const baseEnv = (existing: string[]) => ({
  homeDir: '/h',
  path: ['/usr/bin'],
  platform: 'linux' as const,
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p: string) => existing.includes(p),
  realpath: async (p: string) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '1.0.0',
});

const ctx = (existing: string[], tools: CheckRunContext['tools']): CheckRunContext => ({
  env: baseEnv(existing),
  mode: 'doctor',
  tools,
  scopes: [],
  cwd: '/p',
  envVars: {},
  offline: false,
  logger: noopLogger,
});

describe('toolDetected check', () => {
  test('tool present → no finding for that tool', async () => {
    const findings = await toolDetected.run(ctx(['/opt/homebrew/bin/claude'], ['claude-code']));
    expect(findings).toEqual([]);
  });

  test('tool missing → one warning finding per tool', async () => {
    const findings = await toolDetected.run(ctx([], ['claude-code', 'codex']));
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
  });

  test('runs in doctor only', () => {
    expect(toolDetected.runsIn).toEqual(['doctor']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/tool-detected.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/doctor/checks/tool-detected.ts`**

```ts
import { getAgent } from '../../agents/registry.ts';
import type { Check } from '../types.ts';

export const toolDetected: Check = {
  id: 'tool-detected',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      const r = await a.value.detect(ctx.env, ctx.signal);
      if (!r.ok || r.value.length === 0) {
        findings.push({
          checkId: 'tool-detected',
          severity: 'warning' as const,
          title: `${tool} not installed`,
          message: `no ${tool} binary found on PATH or well-known locations`,
          remediation: a.value.installHint,
          tool,
        });
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Register + verify + commit**

Add `toolDetected` to the registry.

```bash
bun test packages/core/tests/doctor/checks/tool-detected.test.ts
git add packages/core/src/doctor/checks/tool-detected.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/tool-detected.test.ts
git commit -m "feat(core): add tool-detected doctor check"
```

---

### Task 17: `scope-writable` check

**Files:**
- Create: `packages/core/src/doctor/checks/scope-writable.ts`
- Create: `packages/core/tests/doctor/checks/scope-writable.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeWritable } from '../../../src/doctor/checks/scope-writable.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { defaultScanEnv } from '../../../src/env/default.ts';
import { noopLogger } from '../../../src/env/logger.ts';

describe('scopeWritable check', () => {
  test('writable skill-root dir → no finding', async () => {
    const base = await defaultScanEnv();
    const d = join('/tmp', `sk-writable-${Date.now()}`);
    await mkdir(join(d, '.claude', 'skills'), { recursive: true });
    const env = { ...base, homeDir: d };
    const ctx: CheckRunContext = {
      env,
      mode: 'doctor',
      tools: ['claude-code'],
      scopes: ['user'],
      cwd: '/p',
      envVars: {},
      offline: false,
      logger: noopLogger,
    };
    try {
      const findings = await scopeWritable.run(ctx);
      expect(findings).toEqual([]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('runs in both doctor and check', () => {
    expect(scopeWritable.runsIn).toEqual(['doctor', 'check']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/scope-writable.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getAgent } from '../../agents/registry.ts';
import type { Check } from '../types.ts';

export const scopeWritable: Check = {
  id: 'scope-writable',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const findings = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      for (const scope of ctx.scopes) {
        const roots = a.value.getSkillRoots(ctx.env, scope, {
          cwd: ctx.cwd,
          envVars: ctx.envVars,
        });
        for (const root of roots) {
          try {
            await mkdir(root, { recursive: true });
            await access(root, constants.W_OK);
          } catch (e) {
            findings.push({
              checkId: 'scope-writable',
              severity: 'error' as const,
              title: `skill root not writable`,
              message: `${tool}/${scope} root ${root}: ${e instanceof Error ? e.message : String(e)}`,
              remediation: `ensure ${root} exists and is writable, or pass --scope=user`,
              tool,
              scope,
            });
          }
        }
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Register + verify + commit**

```bash
bun test packages/core/tests/doctor/checks/scope-writable.test.ts
git add packages/core/src/doctor/checks/scope-writable.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/scope-writable.test.ts
git commit -m "feat(core): add scope-writable doctor check"
```

---

### Task 18: `cross-scope-duplicate` check

**Files:**
- Create: `packages/core/src/doctor/checks/cross-scope-duplicate.ts`
- Create: `packages/core/tests/doctor/checks/cross-scope-duplicate.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { crossScopeDuplicate } from '../../../src/doctor/checks/cross-scope-duplicate.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const makeCtx = (dirs: Record<string, readonly string[]>, files: Record<string, string>): CheckRunContext => {
  const env: ScanEnv = {
    homeDir: '/h',
    path: [],
    platform: 'linux',
    xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    fileExists: async (p) => p in dirs || p in files,
    realpath: async (p) => p,
    listDir: async (p) => dirs[p] ?? [],
    readText: async (p) => files[p] ?? '',
    runVersion: async () => 'unknown',
  };
  return {
    env,
    mode: 'doctor',
    tools: ['claude-code'],
    scopes: ['user', 'project'],
    cwd: '/proj',
    envVars: {},
    offline: false,
    logger: noopLogger,
  };
};

describe('crossScopeDuplicate check', () => {
  test('no duplicates → no findings', async () => {
    const findings = await crossScopeDuplicate.run(makeCtx({}, {}));
    expect(findings).toEqual([]);
  });

  test('same-name skill in user and project → one warning', async () => {
    const ctx = makeCtx(
      {
        '/h/.claude/skills': ['grep'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/proj/.claude/skills': ['grep'],
        '/proj/.claude/skills/grep': ['SKILL.md'],
      },
      {
        '/h/.claude/skills/grep/SKILL.md': '---\n---\n',
        '/proj/.claude/skills/grep/SKILL.md': '---\n---\n',
      },
    );
    const findings = await crossScopeDuplicate.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/cross-scope-duplicate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { listSkills } from '../../scan/list-skills.ts';
import type { Check } from '../types.ts';

export const crossScopeDuplicate: Check = {
  id: 'cross-scope-duplicate',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const r = await listSkills(ctx.env, {
      tools: ctx.tools,
      scopes: ctx.scopes,
      duplicatesOnly: true,
      cwd: ctx.cwd,
      envVars: ctx.envVars,
      logger: ctx.logger,
    });
    if (!r.ok) return [];
    const byName = new Map<string, string[]>();
    for (const s of r.value) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name)?.push(`${s.scope}:${s.path}`);
    }
    return Array.from(byName.entries()).map(([name, locations]) => ({
      checkId: 'cross-scope-duplicate',
      severity: 'warning' as const,
      title: `'${name}' installed in multiple scopes`,
      message: locations.join(', '),
      remediation: "run 'skillsmith list --duplicates' and remove from the unintended scope",
    }));
  },
};
```

- [ ] **Step 4: Register + verify + commit**

```bash
bun test packages/core/tests/doctor/checks/cross-scope-duplicate.test.ts
git add packages/core/src/doctor/checks/cross-scope-duplicate.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/cross-scope-duplicate.test.ts
git commit -m "feat(core): add cross-scope-duplicate doctor check"
```

---

### Task 19: `multi-install` check

**Files:**
- Create: `packages/core/src/doctor/checks/multi-install.ts`
- Create: `packages/core/tests/doctor/checks/multi-install.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { multiInstall } from '../../../src/doctor/checks/multi-install.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';

const ctx = (existing: string[]): CheckRunContext => ({
  env: {
    homeDir: '/h',
    path: ['/usr/bin'],
    platform: 'linux',
    xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    fileExists: async (p) => existing.includes(p),
    realpath: async (p) => p,
    listDir: async () => [],
    readText: async () => '',
    runVersion: async () => 'unknown',
  },
  mode: 'doctor',
  tools: ['claude-code'],
  scopes: [],
  cwd: '/p',
  envVars: {},
  offline: false,
  logger: noopLogger,
});

describe('multiInstall check', () => {
  test('single install → no finding', async () => {
    const findings = await multiInstall.run(ctx(['/opt/homebrew/bin/claude']));
    expect(findings).toEqual([]);
  });

  test('two installs → one warning', async () => {
    const findings = await multiInstall.run(
      ctx(['/opt/homebrew/bin/claude', '/h/.npm/bin/claude']),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/multi-install.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { getAgent } from '../../agents/registry.ts';
import type { Check } from '../types.ts';

export const multiInstall: Check = {
  id: 'multi-install',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      const r = await a.value.detect(ctx.env, ctx.signal);
      if (!r.ok) continue;
      if (r.value.length > 1) {
        findings.push({
          checkId: 'multi-install',
          severity: 'warning' as const,
          title: `${tool} installed in multiple locations`,
          message: r.value.map((i) => `${i.path} (${i.installMethod})`).join(', '),
          remediation: 'prefer a single install method to avoid version skew',
          tool,
        });
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Register + verify + commit**

```bash
bun test packages/core/tests/doctor/checks/multi-install.test.ts
git add packages/core/src/doctor/checks/multi-install.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/multi-install.test.ts
git commit -m "feat(core): add multi-install doctor check"
```

---

### Task 20: `legacy-install` check (Codex deprecated path)

**Files:**
- Create: `packages/core/src/doctor/checks/legacy-install.ts`
- Create: `packages/core/tests/doctor/checks/legacy-install.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { legacyInstall } from '../../../src/doctor/checks/legacy-install.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const makeCtx = (dirs: Record<string, readonly string[]>, files: Record<string, string> = {}): CheckRunContext => {
  const env: ScanEnv = {
    homeDir: '/h',
    path: [],
    platform: 'linux',
    xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    fileExists: async (p) => p in dirs || p in files,
    realpath: async (p) => p,
    listDir: async (p) => dirs[p] ?? [],
    readText: async () => '',
    runVersion: async () => 'unknown',
  };
  return {
    env,
    mode: 'doctor',
    tools: ['codex'],
    scopes: ['user'],
    cwd: '/p',
    envVars: {},
    offline: false,
    logger: noopLogger,
  };
};

describe('legacyInstall check', () => {
  test('no legacy dir → no finding', async () => {
    const findings = await legacyInstall.run(makeCtx({}));
    expect(findings).toEqual([]);
  });

  test('Codex deprecated ~/.codex/skills populated → warning', async () => {
    const findings = await legacyInstall.run(
      makeCtx({
        '/h/.codex/skills': ['foo'],
        '/h/.codex/skills/foo': ['SKILL.md'],
      }, { '/h/.codex/skills/foo/SKILL.md': '---\n---\n' }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.tool).toBe('codex');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/legacy-install.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { join } from 'node:path';
import type { Check } from '../types.ts';

export const legacyInstall: Check = {
  id: 'legacy-install',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings = [];
    // Codex deprecated path: $CODEX_HOME/skills (default ~/.codex/skills)
    if (ctx.tools.includes('codex')) {
      const base = ctx.envVars.CODEX_HOME ?? join(ctx.env.homeDir, '.codex');
      const legacyDir = join(base, 'skills');
      if (await ctx.env.fileExists(legacyDir)) {
        const entries = await ctx.env.listDir(legacyDir);
        if (entries.length > 0) {
          findings.push({
            checkId: 'legacy-install',
            severity: 'warning' as const,
            title: 'Codex deprecated skills path in use',
            message: `skills present at ${legacyDir}; the current Codex path is ~/.agents/skills`,
            remediation: `migrate to ~/.agents/skills (or $HOME/.agents/skills)`,
            tool: 'codex',
          });
        }
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Register + verify + commit**

```bash
bun test packages/core/tests/doctor/checks/legacy-install.test.ts
git add packages/core/src/doctor/checks/legacy-install.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/legacy-install.test.ts
git commit -m "feat(core): add legacy-install doctor check (Codex deprecated path)"
```

---

### Task 21: `network-reach` check

**Files:**
- Create: `packages/core/src/doctor/checks/network-reach.ts`
- Create: `packages/core/tests/doctor/checks/network-reach.test.ts`
- Modify: `packages/core/src/doctor/registry.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { networkReach } from '../../../src/doctor/checks/network-reach.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';

const base: Omit<CheckRunContext, 'offline'> = {
  env: {
    homeDir: '/h',
    path: [],
    platform: 'linux',
    xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    fileExists: async () => false,
    realpath: async (p) => p,
    listDir: async () => [],
    readText: async () => '',
    runVersion: async () => 'unknown',
  },
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  envVars: {},
  logger: noopLogger,
};

describe('networkReach check', () => {
  test('--offline skips check', async () => {
    const findings = await networkReach.run({ ...base, offline: true });
    expect(findings).toEqual([]);
  });

  test('runs in doctor only', () => {
    expect(networkReach.runsIn).toEqual(['doctor']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/doctor/checks/network-reach.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Check } from '../types.ts';

const TIMEOUT_MS = 3000;

export const networkReach: Check = {
  id: 'network-reach',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    if (ctx.offline) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://github.com', {
        method: 'HEAD',
        signal: ctx.signal ?? controller.signal,
      });
      if (res.ok || res.status === 301 || res.status === 302) return [];
      return [
        {
          checkId: 'network-reach',
          severity: 'warning' as const,
          title: 'github.com HTTP ' + res.status,
          message: `HEAD https://github.com returned ${res.status}`,
        },
      ];
    } catch (e) {
      return [
        {
          checkId: 'network-reach',
          severity: 'warning' as const,
          title: 'github.com unreachable',
          message: e instanceof Error ? e.message : String(e),
          remediation: 'pass --offline or fix connectivity',
        },
      ];
    } finally {
      clearTimeout(timer);
    }
  },
};
```

- [ ] **Step 4: Register + verify + commit**

```bash
bun test packages/core/tests/doctor/checks/network-reach.test.ts
git add packages/core/src/doctor/checks/network-reach.ts packages/core/src/doctor/registry.ts packages/core/tests/doctor/checks/network-reach.test.ts
git commit -m "feat(core): add network-reach doctor check"
```

---

## Phase G — Public API surface

### Task 22: Export MVP-2b.1 public API

**Files:**
- Modify: `packages/core/src/public-types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/tests/public-api.test.ts`

- [ ] **Step 1: Extend `public-types.ts`**

Add these exports:

```ts
export type { Frontmatter, SkillEntry } from './skills/types.ts';
export type { ListSkillsOpts } from './scan/list-skills.ts';
export type { Check, CheckRunContext, CheckRunMode, CheckRunResult, Finding, Severity } from './doctor/types.ts';
```

- [ ] **Step 2: Extend `index.ts`**

Add:

```ts
export { parseSkillFrontmatter } from './skills/frontmatter.ts';
export { listSkills } from './scan/list-skills.ts';
export { runChecks } from './doctor/run.ts';
export { builtInChecks } from './doctor/registry.ts';
export { skillParseError } from './errors.ts';
```

Add to the type-only re-export block:

```ts
  Check,
  CheckRunContext,
  CheckRunMode,
  CheckRunResult,
  Finding,
  Frontmatter,
  ListSkillsOpts,
  Severity,
  SkillEntry,
```

- [ ] **Step 3: Update `packages/core/tests/public-api.test.ts`**

Add to the `expected` set:

```ts
      'parseSkillFrontmatter',
      'listSkills',
      'runChecks',
      'builtInChecks',
      'skillParseError',
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/public-api.test.ts
git add packages/core/src/index.ts packages/core/src/public-types.ts packages/core/tests/public-api.test.ts
git commit -m "feat(core): export MVP-2b.1 public API (listSkills, runChecks, types)"
```

---

## Phase H — CLI scaffolding

### Task 23: `scope-resolver` utility

**Files:**
- Create: `packages/cli/src/util/scope-resolver.ts`
- Create: `packages/cli/tests/util/scope-resolver.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { resolveScopeFlags } from '../../src/util/scope-resolver.ts';

describe('resolveScopeFlags', () => {
  test('no flags → null (means all)', () => {
    const r = resolveScopeFlags({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  test('--scope=user → user', () => {
    const r = resolveScopeFlags({ scope: 'user' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });

  test('--user shorthand → user', () => {
    const r = resolveScopeFlags({ user: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });

  test('--user --system → conflict error', () => {
    const r = resolveScopeFlags({ user: true, system: true });
    expect(r.ok).toBe(false);
  });

  test('--scope=user --project → conflict error', () => {
    const r = resolveScopeFlags({ scope: 'user', project: true });
    expect(r.ok).toBe(false);
  });

  test('--scope=user --user → agrees, returns user', () => {
    const r = resolveScopeFlags({ scope: 'user', user: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/util/scope-resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/cli/src/util/scope-resolver.ts`:

```ts
import type { Scope } from '@skillsmith/core';
import { err, ok, type Result } from '@skillsmith/core';

export interface ScopeFlagOpts {
  scope?: string;
  user?: boolean;
  system?: boolean;
  project?: boolean;
}

export const resolveScopeFlags = (
  opts: ScopeFlagOpts,
): Result<Scope | null, { code: 'scope-conflict'; message: string }> => {
  const shorthands: Scope[] = [];
  if (opts.user) shorthands.push('user');
  if (opts.system) shorthands.push('system');
  if (opts.project) shorthands.push('project');

  if (shorthands.length > 1) {
    return err({
      code: 'scope-conflict',
      message: `conflicting scope shorthand flags: ${shorthands.map((s) => `--${s}`).join(' ')}`,
    });
  }

  const shorthand = shorthands[0];
  const explicit = opts.scope as Scope | undefined;

  if (shorthand && explicit && shorthand !== explicit) {
    return err({
      code: 'scope-conflict',
      message: `--scope=${explicit} conflicts with --${shorthand}`,
    });
  }

  const value = explicit ?? shorthand ?? null;
  return ok(value);
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/cli/tests/util/scope-resolver.test.ts
git add packages/cli/src/util/scope-resolver.ts packages/cli/tests/util/scope-resolver.test.ts
git commit -m "feat(cli): add scope-resolver for --scope + shorthand conflict handling"
```

---

### Task 24: Global `--json` flag + commander wiring

**Files:**
- Modify: `packages/cli/src/program.ts`

- [ ] **Step 1: Add the global flag**

In `packages/cli/src/program.ts`, inside `buildProgram`, add after the existing `.option('--debug', ...)`:

```ts
    .option('--json', 'Emit JSON on stdout (where supported)', false);
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
bun test packages/cli
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/program.ts
git commit -m "feat(cli): add global --json boolean flag"
```

---

## Phase I — `list` command

### Task 25: `list` renderers

**Files:**
- Create: `packages/cli/src/output/list-json.ts`
- Create: `packages/cli/src/output/list-human.ts`
- Create: `packages/cli/tests/output/list-json.test.ts`
- Create: `packages/cli/tests/output/list-human.test.ts`

- [ ] **Step 1: Failing tests**

`packages/cli/tests/output/list-json.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { SkillEntry } from '@skillsmith/core';
import { ListJsonSchema, renderListJson } from '../../src/output/list-json.ts';

const sample: SkillEntry[] = [
  {
    name: 'grep',
    path: '/h/.claude/skills/grep',
    realpath: '/h/.claude/skills/grep',
    tool: 'claude-code',
    scope: 'user',
    root: '/h/.claude/skills',
    frontmatter: { name: 'grep', description: 'search' },
  },
];

describe('renderListJson', () => {
  test('produces schema-valid JSON', () => {
    const j = renderListJson(sample);
    const r = ListJsonSchema.safeParse(JSON.parse(j));
    expect(r.success).toBe(true);
  });
});
```

`packages/cli/tests/output/list-human.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { SkillEntry } from '@skillsmith/core';
import { renderListHuman } from '../../src/output/list-human.ts';

const sample: SkillEntry[] = [
  {
    name: 'grep',
    path: '/h/.claude/skills/grep',
    realpath: '/h/.claude/skills/grep',
    tool: 'claude-code',
    scope: 'user',
    root: '/h/.claude/skills',
    frontmatter: { name: 'grep', description: 'search' },
  },
];

describe('renderListHuman', () => {
  test('empty → "No skills installed."', () => {
    expect(renderListHuman([], { long: false })).toContain('No skills installed');
  });

  test('groups by tool then scope, includes name', () => {
    const out = renderListHuman(sample, { long: false });
    expect(out).toContain('claude-code');
    expect(out).toContain('user');
    expect(out).toContain('grep');
  });

  test('--long shows paths', () => {
    const out = renderListHuman(sample, { long: true });
    expect(out).toContain('/h/.claude/skills/grep');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/output/list-*.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/cli/src/output/list-json.ts`**

```ts
import type { SkillEntry } from '@skillsmith/core';
import { z } from 'zod';

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .nullable();

const SkillEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  realpath: z.string(),
  tool: z.string(),
  scope: z.string(),
  root: z.string(),
  frontmatter: FrontmatterSchema,
});

export const ListJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  skills: z.array(SkillEntrySchema),
});

export const renderListJson = (entries: readonly SkillEntry[]): string =>
  JSON.stringify(
    { schemaVersion: 1, experimental: true, skills: entries },
    null,
    2,
  );
```

- [ ] **Step 4: Implement `packages/cli/src/output/list-human.ts`**

```ts
import type { SkillEntry } from '@skillsmith/core';

export interface ListHumanOpts {
  long: boolean;
}

export const renderListHuman = (entries: readonly SkillEntry[], opts: ListHumanOpts): string => {
  if (entries.length === 0) return 'No skills installed.\n';
  const grouped = new Map<string, Map<string, SkillEntry[]>>();
  for (const e of entries) {
    if (!grouped.has(e.tool)) grouped.set(e.tool, new Map());
    const byScope = grouped.get(e.tool);
    if (!byScope) continue;
    if (!byScope.has(e.scope)) byScope.set(e.scope, []);
    byScope.get(e.scope)?.push(e);
  }
  const lines: string[] = [];
  for (const [tool, byScope] of grouped) {
    lines.push(`# ${tool}`);
    for (const [scope, skills] of byScope) {
      lines.push(`  ${scope}:`);
      for (const s of skills) {
        const desc = s.frontmatter?.description ?? '';
        lines.push(opts.long ? `    ${s.name}  ${s.path}  ${desc}` : `    ${s.name}  ${desc}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};
```

- [ ] **Step 5: Verify and commit**

```bash
bun test packages/cli/tests/output/list-json.test.ts packages/cli/tests/output/list-human.test.ts
git add packages/cli/src/output/list-json.ts packages/cli/src/output/list-human.ts packages/cli/tests/output/list-json.test.ts packages/cli/tests/output/list-human.test.ts
git commit -m "feat(cli): add list renderers (json schema + human grouped output)"
```

---

### Task 26: `list` command handler + commander wiring

**Files:**
- Create: `packages/cli/src/commands/list.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/commands/list-integration.test.ts`

- [ ] **Step 1: Failing integration test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BIN = 'packages/cli/src/index.ts';
const run = async (args: string[], env: Record<string, string> = {}, cwd = process.cwd()) => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
    cwd,
  });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith list', () => {
  test('empty system (isolated HOME + cwd) → "No skills installed", exit 0', async () => {
    const d = join('/tmp', `sk-list-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run([], { HOME: d, XDG_CONFIG_HOME: join(d, '.config') }, d);
      // sanity: the binary actually ran via bun
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--json on empty system returns a schema-valid object with empty skills', async () => {
    const d = join('/tmp', `sk-listj-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run(['list', '--json'], { HOME: d, XDG_CONFIG_HOME: join(d, '.config') }, d);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.skills).toEqual([]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--user --system exits 2', async () => {
    const r = await run(['list', '--user', '--system']);
    expect(r.code).toBe(2);
  });

  test('finds a seeded skill', async () => {
    const d = join('/tmp', `sk-listseed-${Date.now()}`);
    const root = join(d, '.claude', 'skills', 'grep');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'SKILL.md'), '---\nname: grep\ndescription: search\n---\n');
    try {
      const r = await run(['list', '--json'], { HOME: d, XDG_CONFIG_HOME: join(d, '.config') }, d);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.skills.some((s: { name: string }) => s.name === 'grep')).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/commands/list-integration.test.ts`
Expected: FAIL — `list` subcommand not registered.

- [ ] **Step 3: Implement `packages/cli/src/commands/list.ts`**

```ts
import {
  defaultScanEnv,
  listSkills,
  type Scope,
  SUPPORTED_TOOLS,
  type SupportedTool,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderListHuman } from '../output/list-human.ts';
import { renderListJson } from '../output/list-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const listCommand = (): Command => {
  const cmd = new Command('list')
    .alias('ls')
    .description('List installed skills across tools and scopes')
    .argument('[glob...]', 'glob filter(s)')
    .option(
      '-t, --tool <name>',
      'Narrow to a specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(new Option('-s, --scope <scope>', 'Narrow to a scope').choices(['user', 'project', 'system']))
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--duplicates', 'Show only cross-scope duplicates', false)
    .option('-l, --long', 'Show paths and details', false)
    .option('--json', 'Emit JSON', false)
    .action(async (globs: string[], opts: {
      tool: string[];
      scope?: string;
      user: boolean;
      system: boolean;
      project: boolean;
      duplicates: boolean;
      long: boolean;
      json: boolean;
    }) => {
      const scopeR = resolveScopeFlags(opts);
      if (!scopeR.ok) {
        process.stderr.write(`error: ${scopeR.error.message}\n`);
        process.exit(2);
      }
      const tools = opts.tool.length > 0
        ? (opts.tool as SupportedTool[])
        : SUPPORTED_TOOLS;
      const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : (['user', 'project', 'system'] as const);
      const env = await defaultScanEnv();
      const r = await listSkills(env, {
        tools,
        scopes,
        globs: globs.length > 0 ? globs : undefined,
        duplicatesOnly: opts.duplicates,
        cwd: process.cwd(),
        envVars: process.env,
      });
      if (!r.ok) {
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(1);
      }
      process.stdout.write(opts.json ? renderListJson(r.value) : renderListHuman(r.value, { long: opts.long }));
    });
  return cmd;
};
```

Note: `SUPPORTED_TOOLS` export must exist; if not already public, add it via `packages/core/src/index.ts`:

```ts
export { SUPPORTED_TOOLS } from './agents/types.ts';
```

And include it in the public API test's `expected` set.

- [ ] **Step 4: Register in `buildProgram`**

Add to `packages/cli/src/program.ts` imports:

```ts
import { listCommand } from './commands/list.ts';
```

Inside `buildProgram`, after the `agents` command and before `config`:

```ts
  program.addCommand(listCommand());
```

- [ ] **Step 5: Verify and commit**

```bash
bun test packages/cli/tests/commands/list-integration.test.ts
git add packages/cli/src/commands/list.ts packages/cli/src/program.ts packages/cli/tests/commands/list-integration.test.ts packages/core/src/index.ts packages/core/tests/public-api.test.ts
git commit -m "feat(cli): add list command with glob/scope/duplicates/long/json"
```

---

## Phase J — `doctor` + `check` commands

### Task 27: Doctor renderers

**Files:**
- Create: `packages/cli/src/output/doctor-json.ts`
- Create: `packages/cli/src/output/doctor-human.ts`
- Create: `packages/cli/tests/output/doctor-json.test.ts`
- Create: `packages/cli/tests/output/doctor-human.test.ts`

- [ ] **Step 1: Failing tests**

`packages/cli/tests/output/doctor-json.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CheckRunResult } from '@skillsmith/core';
import { DoctorJsonSchema, renderDoctorJson } from '../../src/output/doctor-json.ts';

const result: CheckRunResult = {
  findings: [
    { checkId: 'x', severity: 'warning', title: 't', message: 'm' },
  ],
  counts: { ok: 0, warning: 1, error: 0 },
};

describe('renderDoctorJson', () => {
  test('schema-valid', () => {
    const j = renderDoctorJson(result);
    expect(DoctorJsonSchema.safeParse(JSON.parse(j)).success).toBe(true);
  });
});
```

`packages/cli/tests/output/doctor-human.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CheckRunResult } from '@skillsmith/core';
import { renderDoctorHuman } from '../../src/output/doctor-human.ts';

describe('renderDoctorHuman', () => {
  test('all ok → summary "0 warnings, 0 failed"', () => {
    const out = renderDoctorHuman({ findings: [], counts: { ok: 0, warning: 0, error: 0 } });
    expect(out).toContain('0 warnings, 0 failed');
  });

  test('findings render with ✓ / ⚠ / ✗ markers', () => {
    const out = renderDoctorHuman({
      findings: [{ checkId: 'a', severity: 'warning', title: 'w', message: '' }],
      counts: { ok: 0, warning: 1, error: 0 },
    });
    expect(out).toContain('⚠');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/output/doctor-*.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/output/doctor-json.ts`**

```ts
import type { CheckRunResult } from '@skillsmith/core';
import { z } from 'zod';

const FindingSchema = z.object({
  checkId: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  title: z.string(),
  message: z.string(),
  remediation: z.string().optional(),
  tool: z.string().optional(),
  scope: z.string().optional(),
});

export const DoctorJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  findings: z.array(FindingSchema),
  counts: z.object({ ok: z.number(), warning: z.number(), error: z.number() }),
});

export const renderDoctorJson = (r: CheckRunResult): string =>
  JSON.stringify(
    { schemaVersion: 1, experimental: true, findings: r.findings, counts: r.counts },
    null,
    2,
  );
```

- [ ] **Step 4: Implement `packages/cli/src/output/doctor-human.ts`**

```ts
import type { CheckRunResult, Severity } from '@skillsmith/core';

const MARKER: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' };

export const renderDoctorHuman = (r: CheckRunResult): string => {
  const lines: string[] = [];
  for (const f of r.findings) {
    const remed = f.remediation ? `\n    remediation: ${f.remediation}` : '';
    lines.push(`  ${MARKER[f.severity]} ${f.title}\n    ${f.message}${remed}`);
  }
  const total = r.findings.length;
  lines.push(`\n${total} checks reported, ${r.counts.warning} warnings, ${r.counts.error} failed.`);
  return `${lines.join('\n')}\n`;
};
```

- [ ] **Step 5: Verify and commit**

```bash
bun test packages/cli/tests/output/doctor-json.test.ts packages/cli/tests/output/doctor-human.test.ts
git add packages/cli/src/output/doctor-json.ts packages/cli/src/output/doctor-human.ts packages/cli/tests/output/doctor-json.test.ts packages/cli/tests/output/doctor-human.test.ts
git commit -m "feat(cli): add doctor renderers (json schema + human with severity markers)"
```

---

### Task 28: `doctor` command handler

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/commands/doctor-integration.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BIN = 'packages/cli/src/index.ts';
const run = async (args: string[], env: Record<string, string> = {}, cwd = process.cwd()) => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
    cwd,
  });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith doctor', () => {
  test('--offline --json exits 0 and emits findings/counts shape', async () => {
    const d = join('/tmp', `sk-doc-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run(['doctor', '--offline', '--json'], {
        HOME: d,
        XDG_CONFIG_HOME: join(d, '.config'),
      }, d);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.schemaVersion).toBe(1);
      expect(Array.isArray(parsed.findings)).toBe(true);
      expect(parsed.counts).toHaveProperty('error');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--user --system exits 2', async () => {
    const r = await run(['doctor', '--user', '--system']);
    expect(r.code).toBe(2);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/commands/doctor-integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/commands/doctor.ts`**

```ts
import {
  builtInChecks,
  defaultScanEnv,
  noopLogger,
  runChecks,
  type Scope,
  SUPPORTED_TOOLS,
  type SupportedTool,
  SCOPES,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const doctorCommand = (): Command => {
  return new Command('doctor')
    .description('Diagnose SkillSmith and target-tool readiness')
    .option(
      '-t, --tool <name>',
      'Limit checks to tool(s). Repeatable.',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(new Option('-s, --scope <scope>', 'Limit to scope').choices(['user', 'project', 'system']))
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--offline', 'Skip network checks', false)
    .option('--strict', 'Treat warnings as failures', false)
    .option('--json', 'Emit JSON', false)
    .action(async (opts: {
      tool: string[];
      scope?: string;
      user: boolean;
      system: boolean;
      project: boolean;
      offline: boolean;
      strict: boolean;
      json: boolean;
    }) => {
      const scopeR = resolveScopeFlags(opts);
      if (!scopeR.ok) {
        process.stderr.write(`error: ${scopeR.error.message}\n`);
        process.exit(2);
      }
      const tools: readonly SupportedTool[] = opts.tool.length > 0
        ? (opts.tool as SupportedTool[])
        : SUPPORTED_TOOLS;
      const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
      const env = await defaultScanEnv();
      const r = await runChecks(builtInChecks, {
        env,
        mode: 'doctor',
        tools,
        scopes,
        cwd: process.cwd(),
        envVars: process.env,
        offline: opts.offline,
        logger: noopLogger,
      });
      if (!r.ok) {
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(1);
      }
      process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
      const hadError = r.value.counts.error > 0;
      const hadWarning = r.value.counts.warning > 0;
      if (hadError || (opts.strict && hadWarning)) process.exit(1);
    });
};
```

- [ ] **Step 4: Register + verify + commit**

Add `doctorCommand()` to `buildProgram()`. Also export `SCOPES` and `SUPPORTED_TOOLS` from `@skillsmith/core` if not already.

```bash
bun test packages/cli/tests/commands/doctor-integration.test.ts
git add packages/cli/src/commands/doctor.ts packages/cli/src/program.ts packages/core/src/index.ts packages/cli/tests/commands/doctor-integration.test.ts packages/core/tests/public-api.test.ts
git commit -m "feat(cli): add doctor command with strict/offline/json"
```

---

### Task 29: `check` command handler

**Files:**
- Create: `packages/cli/src/commands/check.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/commands/check-integration.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BIN = 'packages/cli/src/index.ts';
const run = async (args: string[], env: Record<string, string> = {}, cwd = process.cwd()) => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env }, cwd });
  const code = await proc.exited;
  return { stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text(), code };
};

describe('skillsmith check', () => {
  test('clean environment + --exit-code → exit 0', async () => {
    const d = join('/tmp', `sk-check-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run(['check', '--exit-code'], {
        HOME: d,
        XDG_CONFIG_HOME: join(d, '.config'),
      }, d);
      expect(r.code).toBe(0);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--json emits findings schema', async () => {
    const r = await run(['check', '--json']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/commands/check-integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/commands/check.ts`**

```ts
import {
  builtInChecks,
  defaultScanEnv,
  noopLogger,
  runChecks,
  type Scope,
  SUPPORTED_TOOLS,
  type SupportedTool,
  SCOPES,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const checkCommand = (): Command => {
  return new Command('check')
    .description('Error-severity subset of doctor, suitable for CI')
    .option(
      '-t, --tool <name>',
      'Limit checks to tool(s).',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(new Option('-s, --scope <scope>', 'Limit to scope').choices(['user', 'project', 'system']))
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--exit-code', 'Exit non-zero on any error finding', false)
    .option('--json', 'Emit JSON', false)
    .action(async (opts: {
      tool: string[];
      scope?: string;
      user: boolean;
      system: boolean;
      project: boolean;
      exitCode: boolean;
      json: boolean;
    }) => {
      const scopeR = resolveScopeFlags(opts);
      if (!scopeR.ok) {
        process.stderr.write(`error: ${scopeR.error.message}\n`);
        process.exit(2);
      }
      const tools: readonly SupportedTool[] = opts.tool.length > 0
        ? (opts.tool as SupportedTool[])
        : SUPPORTED_TOOLS;
      const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
      const env = await defaultScanEnv();
      const r = await runChecks(builtInChecks, {
        env,
        mode: 'check',
        tools,
        scopes,
        cwd: process.cwd(),
        envVars: process.env,
        offline: false,
        logger: noopLogger,
      });
      if (!r.ok) {
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(1);
      }
      process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
      if (opts.exitCode && r.value.counts.error > 0) process.exit(1);
    });
};
```

- [ ] **Step 4: Register + verify + commit**

Add `checkCommand()` to `buildProgram()` alongside `doctorCommand()`.

```bash
bun test packages/cli/tests/commands/check-integration.test.ts
git add packages/cli/src/commands/check.ts packages/cli/src/program.ts packages/cli/tests/commands/check-integration.test.ts
git commit -m "feat(cli): add check command (error-severity subset for CI)"
```

---

## Phase K — Zones, coverage, tag

### Task 30: ESLint zones for new dirs

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add zones**

Append to the `zones` list in `eslint.config.js`:

```js
            // skills domain is agent-agnostic; do not import from agents/**
            { target: './packages/core/src/skills', from: './packages/core/src/agents' },
            { target: './packages/core/src/skills', from: './packages/core/src/scan' },
            { target: './packages/core/src/skills', from: './packages/core/src/doctor' },
            // doctor checks orchestrate across layers but must not import CLI
            { target: './packages/core/src/doctor', from: './packages/cli' },
```

- [ ] **Step 2: Verify**

```bash
bun run lint:boundaries
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "ci: add ESLint zones for skills/** and doctor/**"
```

---

### Task 31: Coverage gate

**Files:**
- Modify: `bunfig.toml`
- Modify: `package.json`

- [ ] **Step 1: Enable coverage in `bunfig.toml`**

Replace the `[test]` table:

```toml
[test]
coverage = true
coverageThreshold = 0.85
coveragePathIgnorePatterns = [
  "packages/*/tests/**",
  "packages/*/src/index.ts",
]
```

Note: bun test's coverage-threshold syntax may evolve; at minimum enable `coverage = true` so the CLI reports numbers. If bun's threshold gating is not yet per-path, wire a small `scripts/coverage-gate.ts` that parses the lcov/json report and enforces `>=85%` on `packages/core/src/doctor/**` and `packages/core/src/skills/**`.

- [ ] **Step 2: Wire into `check`**

In `package.json`, the `check` script is unchanged — `bun test` now includes coverage output. If programmatic gating is needed, add:

```json
    "coverage-gate": "bun run scripts/coverage-gate.ts",
    "check": "bun run lint && bun run lint:boundaries && bun run typecheck && bun run actions-lint && bun run test && bun run coverage-gate"
```

- [ ] **Step 3: If needed, create `scripts/coverage-gate.ts`**

```ts
#!/usr/bin/env bun
// Enforces >=85% line coverage on doctor/** and skills/**.
// Parses bun test's lcov output at coverage/lcov.info.
import { existsSync } from 'node:fs';

const path = 'coverage/lcov.info';
if (!existsSync(path)) {
  process.stderr.write('coverage report not found; run `bun test --coverage` first\n');
  process.exit(1);
}
const text = await Bun.file(path).text();
const perFile: Record<string, { lines: number; hit: number }> = {};
let current = '';
for (const line of text.split('\n')) {
  if (line.startsWith('SF:')) current = line.slice(3);
  else if (line.startsWith('LF:')) (perFile[current] ??= { lines: 0, hit: 0 }).lines = Number(line.slice(3));
  else if (line.startsWith('LH:')) (perFile[current] ??= { lines: 0, hit: 0 }).hit = Number(line.slice(3));
}
const gate = (prefix: string) => {
  const files = Object.entries(perFile).filter(([f]) => f.includes(prefix));
  const lines = files.reduce((s, [, v]) => s + v.lines, 0);
  const hit = files.reduce((s, [, v]) => s + v.hit, 0);
  return { prefix, pct: lines === 0 ? 1 : hit / lines };
};
const thresholds = [gate('packages/core/src/doctor'), gate('packages/core/src/skills')];
let failed = false;
for (const t of thresholds) {
  const pct = (t.pct * 100).toFixed(1);
  if (t.pct < 0.85) {
    process.stderr.write(`FAIL ${t.prefix} coverage ${pct}% < 85%\n`);
    failed = true;
  } else {
    process.stdout.write(`OK   ${t.prefix} coverage ${pct}%\n`);
  }
}
if (failed) process.exit(1);
```

- [ ] **Step 4: Verify**

```bash
bun test --coverage
bun run coverage-gate
```
Expected: all tests pass; coverage-gate prints OK for both prefixes.

- [ ] **Step 5: Commit**

```bash
git add bunfig.toml package.json scripts/coverage-gate.ts
git commit -m "ci: add coverage gate at 85% for doctor/** and skills/**"
```

---

### Task 32: Version bump + `v0.3.0` tag

**Files:**
- Modify: `package.json`, `packages/core/package.json`, `packages/cli/package.json`
- Modify: `packages/core/tests/public-api.test.ts` (VERSION check)
- Modify: `packages/cli/tests/help.test.ts` (version regex)

- [ ] **Step 1: Bump versions**

Change `"version": "0.2.0"` → `"version": "0.3.0"` in all three `package.json` files.

- [ ] **Step 2: Update version-asserting tests**

In `packages/core/tests/public-api.test.ts`:

```ts
  test('VERSION matches 0.3.0', () => {
    expect(core.VERSION).toBe('0.3.0');
  });
```

In `packages/cli/tests/help.test.ts`:

```ts
    expect(r.stdout).toMatch(/0\.3\.0/);
```

- [ ] **Step 3: Full check + build + smoke**

```bash
bun install
bun run check
bun run build
./dist/skillsmith list --json
./dist/skillsmith doctor --offline --json | bunx jq '.counts'
./dist/skillsmith check --exit-code --json
```
Expected: all pass; `list` returns valid JSON; `doctor` prints `counts` object; `check --exit-code` exits 0 on a clean system.

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "chore: bump workspace to v0.3.0"
git tag -a v0.3.0 -m "MVP-2b.1: list, doctor, check — internal milestone"
```

- [ ] **Step 5: Sanity**

```bash
git log --oneline -20
git tag
```
Expected: clean tree; `v0.1.0`, `v0.2.0`, `v0.3.0` all present.

---

## Post-plan notes

- Public release (npm publish, Homebrew formula, codesign + notarize) is MVP-2b.2, not this plan.
- Windows CI and PowerShell completion are MVP-2c, landing with the install/uninstall write path.
- The coverage gate is our first code-quality floor. If bun test's threshold flags mature before MVP-2c, prefer the built-in flag over the hand-rolled `scripts/coverage-gate.ts`.
- `builtInChecks` is the only public way to obtain the registry. Adding a new check = new file + new import + append to the array. Plugin-contributed checks are P2.
- `Agent.getSkillRoots` is pure path computation. Any filesystem IO in the scan path lives in `walkSkillDir` — kept on purpose so tests can inject fakes.
