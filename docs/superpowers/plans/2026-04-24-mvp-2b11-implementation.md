# SkillSmith MVP-2b.1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `v0.3.1` internally: extend `Scope` with `managed`, add `Origin` tagged union + `enabled` field to `SkillEntry`, introduce the `plugins/` domain that reads `installed_plugins.json` and resolves enablement across four settings layers, add a new `CommandEntry` primitive with a parallel `skillsmith commands` subcommand. Close the gap where `./skillsmith list --tool claude-code` reported 1 skill on a machine with 26 legitimately-active skills + 21 slash commands.

**Architecture:** Plugin discovery is centralized in a new leaf `packages/core/src/plugins/` module. Each agent gets three new methods (`getCommandRoots`, `getPluginSkillDir`, `getPluginCommandDir`) so agent-specific knowledge stays per-folder. `listSkills` / `listCommands` iterate both standalone roots and discovered plugin caches, tagging each entry with `origin` + `enabled`. JSON output bumps to `schemaVersion: 2` (experimental). CLI gains `skillsmith commands` as a sibling of `list`, plus `--managed` / `--enabled` / `--disabled` flags.

**Tech Stack:** no new runtime deps. `zod` (already a dep) validates `installed_plugins.json` and settings files.

**Spec:** `docs/superpowers/specs/2026-04-24-mvp-2b11-design.md`
**Prerequisite:** `v0.3.0` (MVP-2b.1) tagged.

---

## Conventions

- Paths are repo-relative from the workspace root.
- Every task commits with Conventional Commits. Commitlint enforces scopes ∈ `{cli, core, main}`; docs/ci/chore commits omit scope.
- TDD where behavior is added; type/scaffold tasks verify via `tsc --noEmit` + `bun test`.
- `bun test` auto-discovers `*.test.ts`; tests mirror `src/` under `packages/*/tests/`.
- Formatting lands at the end of each task via `bunx @biomejs/biome check --write <paths>`.

---

## Phase A — Type foundations

### Task 1: Add `managed` to `Scope` enum

**Files:**
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/tests/public-api.test.ts`

- [ ] **Step 1: Extend the enum**

In `packages/core/src/config/types.ts`, replace the `SCOPES` constant:

```ts
export const SCOPES = ['system', 'user', 'project', 'managed'] as const;
```

The existing `Scope = (typeof SCOPES)[number]` picks up the new value automatically.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean. Existing `'system' | 'user' | 'project'` switches are exhaustive today because no caller treats them as a closed set — each scope-literal callsite is explicit (`'user'`, `'project'`, `'system'`). New `'managed'` cases are added in later tasks.

- [ ] **Step 3: Verify existing tests still pass**

Run: `bun test packages/core`
Expected: same 76 pass as baseline.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/types.ts
git commit -m "feat(core): add 'managed' to Scope enum"
```

---

### Task 2: Add `Origin` + `PluginProvenanceScope` types

**Files:**
- Modify: `packages/core/src/skills/types.ts`
- Create: `packages/core/tests/skills/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/skills/types.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { Origin, PluginProvenanceScope, SkillEntry } from '../../src/skills/types.ts';

describe('Origin', () => {
  test('standalone variant is constructible', () => {
    const o: Origin = { kind: 'standalone' };
    expect(o.kind).toBe('standalone');
  });

  test('plugin variant carries id / version / scope', () => {
    const o: Origin = {
      kind: 'plugin',
      pluginId: 'foo@bar',
      pluginVersion: '1.2.3',
      pluginScope: 'user',
    };
    if (o.kind === 'plugin') {
      expect(o.pluginId).toBe('foo@bar');
      expect(o.pluginVersion).toBe('1.2.3');
    }
  });

  test('policy variant has no extra data', () => {
    const o: Origin = { kind: 'policy' };
    expect(o.kind).toBe('policy');
  });

  test('all four PluginProvenanceScope values are accepted', () => {
    const scopes: PluginProvenanceScope[] = ['user', 'project', 'managed', 'local'];
    expect(scopes).toHaveLength(4);
  });
});

describe('SkillEntry', () => {
  test('carries origin + enabled', () => {
    const e: SkillEntry = {
      name: 'grep',
      path: '/h/.claude/skills/grep',
      realpath: '/h/.claude/skills/grep',
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
      frontmatter: null,
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.enabled).toBe('on');
    expect(e.origin.kind).toBe('standalone');
  });
});
```

- [ ] **Step 2: Run the test, expect fail**

Run: `bun test packages/core/tests/skills/types.test.ts`
Expected: FAIL — `Origin` / `PluginProvenanceScope` not exported.

- [ ] **Step 3: Extend `packages/core/src/skills/types.ts`**

Replace the file contents:

```ts
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';

export interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
}

export type PluginProvenanceScope = 'user' | 'project' | 'managed' | 'local';

export type Origin =
  | { kind: 'standalone' }
  | {
      kind: 'plugin';
      pluginId: string;
      pluginVersion: string;
      pluginScope: PluginProvenanceScope;
    }
  | { kind: 'policy' };

export interface SkillEntry {
  name: string;
  path: string;
  realpath: string;
  tool: SupportedTool;
  scope: Scope;
  root: string;
  frontmatter: Frontmatter | null;
  origin: Origin;
  enabled: EnabledState;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/core/tests/skills/types.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Typecheck catches existing SkillEntry callers**

Run: `bunx tsc --noEmit`
Expected: errors in `packages/core/src/skills/walk.ts` and `packages/core/src/scan/list-skills.ts` — they construct `SkillEntry` without the new fields. Fix them:

In `packages/core/src/skills/walk.ts`, replace the `results.push({...})` call with:

```ts
    results.push({
      name,
      path,
      realpath,
      tool: opts.tool,
      scope: opts.scope,
      root: opts.root,
      frontmatter,
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
```

- [ ] **Step 6: Re-run typecheck + all tests**

```bash
bunx tsc --noEmit
bun test
```
Expected: clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/skills/types.ts packages/core/src/skills/walk.ts packages/core/tests/skills/types.test.ts
git commit -m "feat(core): add Origin tagged union + enabled to SkillEntry"
```

---

### Task 3: Add `CommandEntry` type

**Files:**
- Create: `packages/core/src/commands/types.ts`
- Create: `packages/core/tests/commands/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/commands/types.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CommandEntry } from '../../src/commands/types.ts';

describe('CommandEntry', () => {
  test('carries all fields parallel to SkillEntry', () => {
    const e: CommandEntry = {
      name: 'ci-audit',
      path: '/h/.claude/commands/ci-audit.md',
      realpath: '/h/.claude/commands/ci-audit.md',
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/commands',
      frontmatter: { description: 'audit CI' },
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.name).toBe('ci-audit');
    expect(e.enabled).toBe('on');
  });

  test('path ends in .md', () => {
    const e: CommandEntry = {
      name: 'foo',
      path: '/x/foo.md',
      realpath: '/x/foo.md',
      tool: 'claude-code',
      scope: 'project',
      root: '/x',
      frontmatter: null,
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.path.endsWith('.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/commands/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/core/src/commands/types.ts`**

```ts
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { Frontmatter, Origin } from '../skills/types.ts';

export interface CommandEntry {
  name: string;
  path: string;
  realpath: string;
  tool: SupportedTool;
  scope: Scope;
  root: string;
  frontmatter: Frontmatter | null;
  origin: Origin;
  enabled: EnabledState;
}
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/commands/types.test.ts
bunx @biomejs/biome check --write packages/core/src/commands packages/core/tests/commands
git add packages/core/src/commands packages/core/tests/commands
git commit -m "feat(core): add CommandEntry type parallel to SkillEntry"
```

---

## Phase B — Plugin registry (`plugins/` domain)

### Task 4: Plugin domain types

**Files:**
- Create: `packages/core/src/plugins/types.ts`

- [ ] **Step 1: Implement the types**

```ts
import type { EnabledState, PluginProvenanceScope } from '../skills/types.ts';

export interface PluginInstallation {
  id: string;                      // "plugin-name@marketplace"
  scope: PluginProvenanceScope;    // user | project | managed | local
  installPath: string;             // absolute path to versioned cache dir
  version: string;
  projectPath?: string;            // required for project/local
}

export interface PluginEnablement {
  enabled: EnabledState;
  source: 'managed' | 'user' | 'project' | 'local' | 'none';
}

export interface DiscoveredPlugin {
  installation: PluginInstallation;
  enablement: PluginEnablement;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/plugins/types.ts
git commit -m "feat(core): add plugin-domain types (Installation, Enablement, DiscoveredPlugin)"
```

---

### Task 5: Read `installed_plugins.json`

**Files:**
- Create: `packages/core/src/plugins/installed.ts`
- Create: `packages/core/tests/plugins/installed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { readInstalledPlugins } from '../../src/plugins/installed.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('readInstalledPlugins', () => {
  test('returns [] when installed_plugins.json does not exist', async () => {
    const r = await readInstalledPlugins(env({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('parses a v2 installed_plugins.json', async () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          {
            scope: 'user',
            installPath: '/h/.claude/plugins/cache/bar/foo/1.0.0',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    const r = await readInstalledPlugins(env({ '/h/.claude/plugins/installed_plugins.json': text }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.id).toBe('foo@bar');
      expect(r.value[0]?.scope).toBe('user');
      expect(r.value[0]?.version).toBe('1.0.0');
    }
  });

  test('returns multiple entries when a plugin has multiple scopes', async () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          { scope: 'user', installPath: '/a', version: '1.0.0' },
          { scope: 'project', projectPath: '/p', installPath: '/b', version: '2.0.0' },
        ],
      },
    });
    const r = await readInstalledPlugins(
      env({ '/h/.claude/plugins/installed_plugins.json': text }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  test('returns config-error for malformed JSON', async () => {
    const r = await readInstalledPlugins(
      env({ '/h/.claude/plugins/installed_plugins.json': 'not json' }),
    );
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/plugins/installed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/plugins/installed.ts`**

```ts
import { join } from 'node:path';
import { z } from 'zod';
import type { ScanEnv } from '../env/types.ts';
import { configError, errorMessage, type SkillSmithError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { PluginInstallation } from './types.ts';

const InstallationEntrySchema = z.object({
  scope: z.enum(['managed', 'user', 'project', 'local']),
  installPath: z.string(),
  version: z.string(),
  projectPath: z.string().optional(),
});

const FileSchema = z.object({
  version: z.number().optional(),
  plugins: z.record(z.array(InstallationEntrySchema)),
});

export const getInstalledPluginsPath = (env: ScanEnv): string =>
  join(env.homeDir, '.claude', 'plugins', 'installed_plugins.json');

export const readInstalledPlugins = async (
  env: ScanEnv,
): Promise<Result<PluginInstallation[], SkillSmithError>> => {
  const path = getInstalledPluginsPath(env);
  if (!(await env.fileExists(path))) return ok([]);

  let text: string;
  try {
    text = await env.readText(path);
  } catch (e) {
    return err(configError(`failed to read ${path}: ${errorMessage(e)}`, { file: path }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(configError(`installed_plugins.json parse error: ${errorMessage(e)}`, { file: path }));
  }

  const validated = FileSchema.safeParse(parsed);
  if (!validated.success) {
    return err(configError(`installed_plugins.json schema error: ${validated.error.issues[0]?.message ?? 'invalid'}`, { file: path }));
  }

  const out: PluginInstallation[] = [];
  for (const [id, entries] of Object.entries(validated.data.plugins)) {
    for (const e of entries) {
      out.push({
        id,
        scope: e.scope,
        installPath: e.installPath,
        version: e.version,
        ...(e.projectPath !== undefined ? { projectPath: e.projectPath } : {}),
      });
    }
  }
  return ok(out);
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/plugins/installed.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write packages/core/src/plugins packages/core/tests/plugins
git add packages/core/src/plugins/installed.ts packages/core/tests/plugins/installed.test.ts
git commit -m "feat(core): read installed_plugins.json into PluginInstallation[]"
```

---

### Task 6: 4-layer enablement resolver

**Files:**
- Create: `packages/core/src/plugins/enablement.ts`
- Create: `packages/core/tests/plugins/enablement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { resolveEnablement } from '../../src/plugins/enablement.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'darwin',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('resolveEnablement', () => {
  test('user: settings.json enabledPlugins[id] = true → enabled', async () => {
    const e = env({ '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) });
    const r = await resolveEnablement(e, { id: 'foo@bar', scope: 'user', installPath: '/x', version: '1' });
    expect(r).toEqual({ enabled: 'on', source: 'user' });
  });

  test('user: missing settings file → unset', async () => {
    const r = await resolveEnablement(env({}), { id: 'foo@bar', scope: 'user', installPath: '/x', version: '1' });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });

  test('user: enabledPlugins[id] = false → disabled with source user', async () => {
    const e = env({ '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': false } }) });
    const r = await resolveEnablement(e, { id: 'foo@bar', scope: 'user', installPath: '/x', version: '1' });
    expect(r).toEqual({ enabled: 'off', source: 'user' });
  });

  test('project: reads <projectPath>/.claude/settings.json', async () => {
    const e = env({ '/p/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'project',
      installPath: '/x',
      version: '1',
      projectPath: '/p',
    });
    expect(r).toEqual({ enabled: 'on', source: 'project' });
  });

  test('local: reads <projectPath>/.claude/settings.local.json', async () => {
    const e = env({ '/p/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'local',
      installPath: '/x',
      version: '1',
      projectPath: '/p',
    });
    expect(r).toEqual({ enabled: 'on', source: 'local' });
  });

  test("managed: reads platform managed-settings.json (darwin = /Library/Application Support/ClaudeCode/...)", async () => {
    const e = env({
      '/Library/Application Support/ClaudeCode/managed-settings.json': JSON.stringify({
        enabledPlugins: { 'foo@bar': true },
      }),
    });
    const r = await resolveEnablement(e, { id: 'foo@bar', scope: 'managed', installPath: '/x', version: '1' });
    expect(r).toEqual({ enabled: 'on', source: 'managed' });
  });

  test('project: missing projectPath → unset', async () => {
    const r = await resolveEnablement(env({}), {
      id: 'foo@bar',
      scope: 'project',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });

  test('user: enabledPlugins object exists but key absent → unset', async () => {
    const e = env({ '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'other@x': true } }) });
    const r = await resolveEnablement(e, { id: 'foo@bar', scope: 'user', installPath: '/x', version: '1' });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/plugins/enablement.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/plugins/enablement.ts`**

```ts
import { join } from 'node:path';
import type { Platform, ScanEnv } from '../env/types.ts';
import type { PluginEnablement, PluginInstallation } from './types.ts';

const MANAGED_SETTINGS_PATH: Record<Platform, string> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
};

const settingsPathForInstallation = (env: ScanEnv, inst: PluginInstallation): string | null => {
  switch (inst.scope) {
    case 'user':
      return join(env.homeDir, '.claude', 'settings.json');
    case 'project':
      return inst.projectPath ? join(inst.projectPath, '.claude', 'settings.json') : null;
    case 'local':
      return inst.projectPath ? join(inst.projectPath, '.claude', 'settings.local.json') : null;
    case 'managed':
      return MANAGED_SETTINGS_PATH[env.platform];
  }
};

const readEnabledPlugins = async (
  env: ScanEnv,
  path: string,
): Promise<Record<string, boolean> | null> => {
  if (!(await env.fileExists(path))) return null;
  try {
    const text = await env.readText(path);
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'enabledPlugins' in parsed) {
      const ep = (parsed as { enabledPlugins?: unknown }).enabledPlugins;
      if (ep && typeof ep === 'object') return ep as Record<string, boolean>;
    }
  } catch {
    // malformed settings files → treat as no enablement data (conservative)
  }
  return null;
};

export const resolveEnablement = async (
  env: ScanEnv,
  installation: PluginInstallation,
): Promise<PluginEnablement> => {
  const path = settingsPathForInstallation(env, installation);
  if (!path) return { enabled: 'unset', source: 'none' };

  const ep = await readEnabledPlugins(env, path);
  if (ep === null) return { enabled: 'unset', source: 'none' };

  const value = ep[installation.id];
  if (value === true) return { enabled: 'on', source: installation.scope };
  if (value === false) return { enabled: 'off', source: installation.scope };
  return { enabled: 'unset', source: 'none' };
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/plugins/enablement.test.ts
bunx @biomejs/biome check --write packages/core/src/plugins packages/core/tests/plugins
git add packages/core/src/plugins/enablement.ts packages/core/tests/plugins/enablement.test.ts
git commit -m "feat(core): resolve plugin enablement across 4 settings layers"
```

---

### Task 7: Plugin discovery — join installations × enablement

**Files:**
- Create: `packages/core/src/plugins/discover.ts`
- Create: `packages/core/tests/plugins/discover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { discoverPlugins } from '../../src/plugins/discover.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'darwin',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('discoverPlugins', () => {
  test('empty system → []', async () => {
    const r = await discoverPlugins(env({}), { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('user-scope install + enabled → returns 1 enabled entry', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [{ scope: 'user', installPath: '/x', version: '1.0' }],
      },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env({
      '/h/.claude/plugins/installed_plugins.json': installed,
      '/h/.claude/settings.json': settings,
    });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.enablement.enabled).toBe('on');
    }
  });

  test('project-scope install for a different project → filtered out', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          { scope: 'project', installPath: '/x', version: '1.0', projectPath: '/other' },
        ],
      },
    });
    const e = env({ '/h/.claude/plugins/installed_plugins.json': installed });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('project-scope install for matching project → included', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          { scope: 'project', installPath: '/x', version: '1.0', projectPath: '/proj' },
        ],
      },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env({
      '/h/.claude/plugins/installed_plugins.json': installed,
      '/proj/.claude/settings.json': settings,
    });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.enablement.enabled).toBe('on');
    }
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/plugins/discover.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/plugins/discover.ts`**

```ts
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { ok, type Result } from '../result.ts';
import { resolveEnablement } from './enablement.ts';
import { readInstalledPlugins } from './installed.ts';
import type { DiscoveredPlugin } from './types.ts';

export interface DiscoverPluginsOpts {
  cwd: string;
}

const appliesToCwd = (
  installation: { scope: string; projectPath?: string | undefined },
  cwd: string,
): boolean => {
  if (installation.scope === 'user' || installation.scope === 'managed') return true;
  // project / local require projectPath to match cwd
  return installation.projectPath !== undefined && installation.projectPath === cwd;
};

export const discoverPlugins = async (
  env: ScanEnv,
  opts: DiscoverPluginsOpts,
): Promise<Result<DiscoveredPlugin[], SkillSmithError>> => {
  const installed = await readInstalledPlugins(env);
  if (!installed.ok) return installed;

  const out: DiscoveredPlugin[] = [];
  for (const installation of installed.value) {
    if (!appliesToCwd(installation, opts.cwd)) continue;
    const enablement = await resolveEnablement(env, installation);
    out.push({ installation, enablement });
  }
  return ok(out);
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/plugins/discover.test.ts
bunx @biomejs/biome check --write packages/core/src/plugins packages/core/tests/plugins
git add packages/core/src/plugins/discover.ts packages/core/tests/plugins/discover.test.ts
git commit -m "feat(core): discoverPlugins joins installations with enablement, filters by cwd"
```

---

## Phase C — Agent interface extensions

### Task 8: Extend `Agent` interface + all four agent implementations

**Files:**
- Modify: `packages/core/src/agents/types.ts`
- Create: `packages/core/src/agents/claude-code/command-roots.ts`
- Create: `packages/core/src/agents/claude-code/plugin-paths.ts`
- Create: `packages/core/src/agents/codex/command-roots.ts`
- Create: `packages/core/src/agents/codex/plugin-paths.ts`
- Create: `packages/core/src/agents/kilo-code/command-roots.ts`
- Create: `packages/core/src/agents/kilo-code/plugin-paths.ts`
- Create: `packages/core/src/agents/opencode/command-roots.ts`
- Create: `packages/core/src/agents/opencode/plugin-paths.ts`
- Modify: `packages/core/src/agents/<tool>/index.ts` ×4
- Modify: `packages/core/src/agents/<tool>/skill-roots.ts` ×4 (handle 'managed')

- [ ] **Step 1: Extend the `Agent` interface**

In `packages/core/src/agents/types.ts`:

```ts
import type { Scope } from '../config/types.ts';
import type { InstallRecord } from '../detect/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { SkillRootsCtx } from './claude-code/skill-roots.ts';

export type { InstallMethod, InstallRecord } from '../detect/types.ts';
export type { SkillRootsCtx };

export const SUPPORTED_TOOLS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;
export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(env: ScanEnv, signal?: AbortSignal): Promise<Result<InstallRecord[], SkillSmithError>>;
  getSkillRoots(env: ScanEnv, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getCommandRoots(env: ScanEnv, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getPluginSkillDir(installPath: string): string | null;
  getPluginCommandDir(installPath: string): string | null;
}
```

- [ ] **Step 2a: Create `claude-code/managed-path.ts`**

Per Claude Code source (`~/c/claude-code/src/utils/settings/managedPath.ts`), managed skills live at platform-dependent paths. Create `packages/core/src/agents/claude-code/managed-path.ts`:

```ts
import { join } from 'node:path';
import type { Platform } from '../../env/types.ts';

const MANAGED_BASE: Record<Platform, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};

export const getManagedSkillsDir = (
  platform: Platform,
  envVars: Record<string, string | undefined>,
): string => {
  // CLAUDE_CODE_DISABLE_POLICY_SKILLS turns off managed-skill loading entirely.
  // Caller checks this env var before calling — we just return the path here.
  const base = envVars.CLAUDE_CODE_MANAGED_SETTINGS_PATH ?? MANAGED_BASE[platform];
  return join(base, '.claude', 'skills');
};

export const isManagedSkillsDisabled = (
  envVars: Record<string, string | undefined>,
): boolean => {
  const v = envVars.CLAUDE_CODE_DISABLE_POLICY_SKILLS;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
};
```

- [ ] **Step 2b: Update `claude-code/skill-roots.ts` to handle `managed`**

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import { getManagedSkillsDir, isManagedSkillsDisabled } from './managed-path.ts';

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
    case 'managed':
      return isManagedSkillsDisabled(ctx.envVars) ? [] : [getManagedSkillsDir(env.platform, ctx.envVars)];
  }
};
```

- [ ] **Step 3: Add `managed` handling to the other three agents' `skill-roots.ts`**

For `packages/core/src/agents/codex/skill-roots.ts`, add `case 'managed': return [];` at the end of the switch. Same for `kilo-code` and `opencode`. Their existing logic for user/project/system stays unchanged.

- [ ] **Step 4: Implement `command-roots.ts` for all four agents**

`packages/core/src/agents/claude-code/command-roots.ts`:

```ts
import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from './skill-roots.ts';

export const getCommandRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const base = ctx.envVars.CLAUDE_CONFIG_DIR ?? join(env.homeDir, '.claude');
      return [join(base, 'commands')];
    }
    case 'project':
      return [join(ctx.cwd, '.claude', 'commands')];
    case 'system':
    case 'managed':
      return [];
  }
};
```

For codex, kilo-code, opencode — each gets a `command-roots.ts` that returns `[]` for every scope (they don't have a standardized slash-command model). Example for codex:

```ts
// packages/core/src/agents/codex/command-roots.ts
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getCommandRoots = (
  _env: ScanEnv,
  _scope: Scope,
  _ctx: SkillRootsCtx,
): readonly string[] => [];
```

Duplicate that pattern (filename appropriate to each folder) for kilo-code and opencode.

- [ ] **Step 5: Implement `plugin-paths.ts` for all four agents**

`packages/core/src/agents/claude-code/plugin-paths.ts`:

```ts
import { join } from 'node:path';

export const getPluginSkillDir = (installPath: string): string | null =>
  join(installPath, 'skills');

export const getPluginCommandDir = (installPath: string): string | null =>
  join(installPath, 'commands');
```

For codex, kilo-code, opencode — each gets a `plugin-paths.ts` that returns `null` for both:

```ts
// packages/core/src/agents/codex/plugin-paths.ts
export const getPluginSkillDir = (_installPath: string): string | null => null;
export const getPluginCommandDir = (_installPath: string): string | null => null;
```

Same for kilo-code, opencode.

- [ ] **Step 6: Wire the new methods in every `index.ts`**

Update `packages/core/src/agents/claude-code/index.ts`:

```ts
import type { Agent } from '../types.ts';
import { getCommandRoots } from './command-roots.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';

export const claudeCodeAgent: Agent = {
  tool: 'claude-code',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
};
```

Do the same for codex, kilo-code, opencode (importing their respective local files).

- [ ] **Step 7: Verify**

```bash
bunx tsc --noEmit
bun test packages/core
```
Expected: all pass; any test using mock Agents may need to add the new methods — most tests use real registry, so fine.

- [ ] **Step 8: Commit**

```bash
bunx @biomejs/biome check --write packages/core
git add packages/core/src/agents
git commit -m "feat(core): add getCommandRoots and plugin path helpers to Agent interface"
```

---

## Phase D — Walker + orchestrator

### Task 9: `walkCommandDir` — scan .md files

**Files:**
- Create: `packages/core/src/commands/walk.ts`
- Create: `packages/core/tests/commands/walk.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { walkCommandDir } from '../../src/commands/walk.ts';

const fakeEnv = (dirs: Record<string, readonly string[]>, files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('walkCommandDir', () => {
  test('returns [] for missing root', async () => {
    const r = await walkCommandDir(fakeEnv({}, {}), {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/commands',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r).toEqual([]);
  });

  test('returns one entry per .md file', async () => {
    const env = fakeEnv(
      { '/r': ['ci-audit.md', 'foo.md', 'README.txt'] },
      {
        '/r/ci-audit.md': '---\ndescription: audit CI\n---\nbody',
        '/r/foo.md': '---\n---\n',
      },
    );
    const r = await walkCommandDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name).sort()).toEqual(['ci-audit', 'foo']);
  });

  test('skips non-.md files and dotfiles', async () => {
    const env = fakeEnv(
      { '/r': ['.hidden.md', 'good.md', 'image.png'] },
      { '/r/good.md': '---\n---\n' },
    );
    const r = await walkCommandDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name)).toEqual(['good']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/commands/walk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/commands/walk.ts`**

```ts
import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import type { Origin } from '../skills/types.ts';
import type { CommandEntry } from './types.ts';

export interface WalkCommandDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
  origin: Origin;
  enabled: EnabledState;
}

export const walkCommandDir = async (
  env: ScanEnv,
  opts: WalkCommandDirOpts,
): Promise<CommandEntry[]> => {
  if (!(await env.fileExists(opts.root))) return [];

  const entries = await env.listDir(opts.root);
  const out: CommandEntry[] = [];

  for (const filename of entries) {
    if (filename.startsWith('.')) continue;
    if (!filename.endsWith('.md')) continue;
    const path = join(opts.root, filename);
    if (!(await env.fileExists(path))) continue;

    let frontmatter: CommandEntry['frontmatter'] = null;
    try {
      const text = await env.readText(path);
      const parsed = parseSkillFrontmatter(text, path);
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

    const name = filename.slice(0, -'.md'.length);
    out.push({
      name,
      path,
      realpath,
      tool: opts.tool,
      scope: opts.scope,
      root: opts.root,
      frontmatter,
      origin: opts.origin,
      enabled: opts.enabled,
    });
  }

  return out;
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/commands/walk.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write packages/core/src/commands packages/core/tests/commands
git add packages/core/src/commands/walk.ts packages/core/tests/commands/walk.test.ts
git commit -m "feat(core): add walkCommandDir — scan .md files with frontmatter + origin/enabled"
```

---

### Task 10: Extend `listSkills` to include plugin-bundled skills

**Files:**
- Modify: `packages/core/src/scan/list-skills.ts`
- Modify: `packages/core/src/skills/walk.ts` — accept origin + enabled parameters
- Create: `packages/core/tests/scan/list-skills-plugins.test.ts`

- [ ] **Step 1: Extend `walkSkillDir` signature**

Replace `packages/core/src/skills/walk.ts`:

```ts
import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { parseSkillFrontmatter } from './frontmatter.ts';
import type { Origin, SkillEntry } from './types.ts';

export interface WalkSkillDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
  origin: Origin;
  enabled: EnabledState;
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
      const text = await env.readText(skillMd);
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
      origin: opts.origin,
      enabled: opts.enabled,
    });
  }

  return results;
};
```

- [ ] **Step 2: Update existing `walk.test.ts`**

Existing tests pass `{ tool, scope, root }` — each call site needs `origin: { kind: 'standalone' }, enabled: true` added. Update every `walkSkillDir(env, { ... })` call in `packages/core/tests/skills/walk.test.ts` to include those two fields.

- [ ] **Step 3: Update `listSkills` to generate plugin-bundled entries**

Replace `packages/core/src/scan/list-skills.ts`:

```ts
import { Glob } from 'bun';
import { getAgent, registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { discoverPlugins } from '../plugins/discover.ts';
import type { DiscoveredPlugin } from '../plugins/types.ts';
import { ok, type Result } from '../result.ts';
import type { Origin, PluginProvenanceScope, SkillEntry } from '../skills/types.ts';
import { walkSkillDir } from '../skills/walk.ts';

export interface ListSkillsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  duplicatesOnly?: boolean;
  enabledFilter?: 'enabled-only' | 'disabled-only' | 'unconfigured-only';
  cwd: string;
  envVars: Record<string, string | undefined>;
  logger?: Logger;
  signal?: AbortSignal;
}

const pluginScopeToScope = (ps: PluginProvenanceScope): Scope =>
  ps === 'local' ? 'project' : ps;

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

// Origin per scope: managed scope under claude-code is policy-pushed (no plugin), all other
// standalone scope/tool combinations are user/project author-placed files.
const standaloneOriginFor = (scope: Scope): Origin =>
  scope === 'managed' ? { kind: 'policy' } : { kind: 'standalone' };

const scanStandalone = async (
  env: ScanEnv,
  tools: readonly SupportedTool[],
  scopes: readonly Scope[],
  ctx: { cwd: string; envVars: Record<string, string | undefined> },
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  for (const tool of tools) {
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getSkillRoots(env, scope, ctx);
      const origin = standaloneOriginFor(scope);
      for (const root of roots) {
        const entries = await walkSkillDir(env, {
          tool,
          scope,
          root,
          origin,
          enabled: 'on',
        });
        out.push(...entries);
      }
    }
  }
  return out;
};

const scanPluginBundled = async (
  env: ScanEnv,
  tools: readonly SupportedTool[],
  discovered: readonly DiscoveredPlugin[],
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  for (const tool of tools) {
    const agent = registry[tool];
    for (const p of discovered) {
      const root = agent.getPluginSkillDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      const entries = await walkSkillDir(env, {
        tool,
        scope: pluginScopeToScope(p.installation.scope),
        root,
        origin,
        enabled: p.enablement.enabled,
      });
      out.push(...entries);
    }
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

  const standalone = await scanStandalone(env, tools, scopes, ctx);
  const discoveredR = await discoverPlugins(env, { cwd: opts.cwd });
  if (!discoveredR.ok) return discoveredR;
  const pluginBundled = await scanPluginBundled(env, tools, discoveredR.value);

  let all = [...standalone, ...pluginBundled];
  all = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) all = applyGlobs(all, opts.globs);
  if (opts.duplicatesOnly) all = filterCrossScopeDuplicates(all);
  if (opts.enabledFilter === 'enabled-only') all = all.filter((e) => e.enabled === 'on');
  if (opts.enabledFilter === 'disabled-only') all = all.filter((e) => e.enabled === 'off');
  if (opts.enabledFilter === 'unconfigured-only') all = all.filter((e) => e.enabled === 'unset');

  // scope filter applies after plugin expansion because plugin-bundled entries
  // have their scope computed from pluginScope
  const scopeSet = new Set(scopes);
  all = all.filter((e) => scopeSet.has(e.scope));

  logger.debug(`listSkills: ${standalone.length} standalone + ${pluginBundled.length} plugin = ${all.length} after filters`);

  // Silence unused-getAgent warning when all we use from the registry module is `registry`
  void getAgent;

  return ok(all);
};
```

- [ ] **Step 4: Write a new test exercising plugin discovery**

Create `packages/core/tests/scan/list-skills-plugins.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { listSkills } from '../../src/scan/list-skills.ts';

const env = (
  dirs: Record<string, readonly string[]>,
  files: Record<string, string>,
): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('listSkills with plugin discovery', () => {
  test('plugin-bundled skill surfaces with origin=plugin and correct enabled', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [{ scope: 'user', installPath: '/pkg', version: '1.0' }],
      },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env(
      {
        '/pkg/skills': ['brainstorm'],
        '/pkg/skills/brainstorm': ['SKILL.md'],
      },
      {
        '/h/.claude/plugins/installed_plugins.json': installed,
        '/h/.claude/settings.json': settings,
        '/pkg/skills/brainstorm/SKILL.md': '---\nname: brainstorm\n---\n',
      },
    );

    const r = await listSkills(e, {
      tools: ['claude-code'],
      cwd: '/proj',
      envVars: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const entry = r.value.find((x) => x.name === 'brainstorm');
      expect(entry).toBeDefined();
      expect(entry?.origin.kind).toBe('plugin');
      if (entry?.origin.kind === 'plugin') {
        expect(entry.origin.pluginId).toBe('foo@bar');
        expect(entry.origin.pluginVersion).toBe('1.0');
        expect(entry.origin.pluginScope).toBe('user');
      }
      expect(entry?.enabled).toBe('on');
      expect(entry?.scope).toBe('user');
    }
  });

  test('disabled plugin → skill surfaces with enabled: false', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'foo@bar': [{ scope: 'user', installPath: '/pkg', version: '1.0' }] },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': false } });
    const e = env(
      {
        '/pkg/skills': ['x'],
        '/pkg/skills/x': ['SKILL.md'],
      },
      {
        '/h/.claude/plugins/installed_plugins.json': installed,
        '/h/.claude/settings.json': settings,
        '/pkg/skills/x/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(e, { tools: ['claude-code'], cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.enabled).toBe('off');
  });

  test('enabledFilter=enabled-only drops disabled plugin skills', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'foo@bar': [{ scope: 'user', installPath: '/pkg', version: '1.0' }] },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': false } });
    const e = env(
      {
        '/pkg/skills': ['x'],
        '/pkg/skills/x': ['SKILL.md'],
      },
      {
        '/h/.claude/plugins/installed_plugins.json': installed,
        '/h/.claude/settings.json': settings,
        '/pkg/skills/x/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(e, {
      tools: ['claude-code'],
      cwd: '/proj',
      envVars: {},
      enabledFilter: 'enabled-only',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
```

- [ ] **Step 5: Verify all tests pass**

Run: `bun test packages/core`
Expected: all pass (includes the updates to existing walk.test.ts and list-skills.test.ts).

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write packages/core
git add packages/core
git commit -m "feat(core): listSkills now includes plugin-bundled entries with origin/enabled"
```

---

### Task 11: `listCommands` orchestrator

**Files:**
- Create: `packages/core/src/scan/list-commands.ts`
- Create: `packages/core/tests/scan/list-commands.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { listCommands } from '../../src/scan/list-commands.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (
  dirs: Record<string, readonly string[]>,
  files: Record<string, string>,
): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('listCommands', () => {
  test('empty → []', async () => {
    const r = await listCommands(env({}, {}), { cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('finds standalone user command', async () => {
    const e = env(
      { '/h/.claude/commands': ['ci-audit.md'] },
      { '/h/.claude/commands/ci-audit.md': '---\ndescription: audit\n---\n' },
    );
    const r = await listCommands(e, {
      tools: ['claude-code'],
      cwd: '/proj',
      envVars: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.name).toBe('ci-audit');
      expect(r.value[0]?.origin.kind).toBe('standalone');
    }
  });

  test('finds plugin-bundled command', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'foo@bar': [{ scope: 'user', installPath: '/pkg', version: '1.0' }] },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env(
      {
        '/pkg/commands': ['do-thing.md'],
      },
      {
        '/h/.claude/plugins/installed_plugins.json': installed,
        '/h/.claude/settings.json': settings,
        '/pkg/commands/do-thing.md': '---\ndescription: a plugin command\n---\n',
      },
    );
    const r = await listCommands(e, { tools: ['claude-code'], cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cmd = r.value.find((x) => x.name === 'do-thing');
      expect(cmd?.origin.kind).toBe('plugin');
      expect(cmd?.enabled).toBe('on');
    }
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/scan/list-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/scan/list-commands.ts`**

```ts
import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { CommandEntry } from '../commands/types.ts';
import { walkCommandDir } from '../commands/walk.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { discoverPlugins } from '../plugins/discover.ts';
import type { DiscoveredPlugin } from '../plugins/types.ts';
import { ok, type Result } from '../result.ts';
import type { Origin, PluginProvenanceScope } from '../skills/types.ts';

export interface ListCommandsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  enabledFilter?: 'enabled-only' | 'disabled-only' | 'unconfigured-only';
  cwd: string;
  envVars: Record<string, string | undefined>;
  logger?: Logger;
  signal?: AbortSignal;
}

const COMMAND_SCOPES: readonly Scope[] = ['user', 'project'];

const pluginScopeToScope = (ps: PluginProvenanceScope): Scope =>
  ps === 'local' ? 'project' : ps;

const applyGlobs = (entries: CommandEntry[], globs: readonly string[]): CommandEntry[] => {
  const compiled = globs.map((g) => new Glob(g));
  return entries.filter((e) => compiled.some((g) => g.match(e.name)));
};

const dedupeByRealpath = (entries: CommandEntry[]): CommandEntry[] => {
  const seen = new Set<string>();
  const out: CommandEntry[] = [];
  for (const e of entries) {
    const key = `${e.tool}|${e.scope}|${e.realpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

const scanStandalone = async (
  env: ScanEnv,
  tools: readonly SupportedTool[],
  scopes: readonly Scope[],
  ctx: { cwd: string; envVars: Record<string, string | undefined> },
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  const origin: Origin = { kind: 'standalone' };
  for (const tool of tools) {
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getCommandRoots(env, scope, ctx);
      for (const root of roots) {
        const entries = await walkCommandDir(env, {
          tool,
          scope,
          root,
          origin,
          enabled: 'on',
        });
        out.push(...entries);
      }
    }
  }
  return out;
};

const scanPluginBundled = async (
  env: ScanEnv,
  tools: readonly SupportedTool[],
  discovered: readonly DiscoveredPlugin[],
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  for (const tool of tools) {
    const agent = registry[tool];
    for (const p of discovered) {
      const root = agent.getPluginCommandDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      const entries = await walkCommandDir(env, {
        tool,
        scope: pluginScopeToScope(p.installation.scope),
        root,
        origin,
        enabled: p.enablement.enabled,
      });
      out.push(...entries);
    }
  }
  return out;
};

export const listCommands = async (
  env: ScanEnv,
  opts: ListCommandsOpts,
): Promise<Result<CommandEntry[], SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const requestedScopes = opts.scopes ?? COMMAND_SCOPES;
  // commands don't exist at system/managed — filter even if caller requested
  const scopes = requestedScopes.filter((s) => s === 'user' || s === 'project');

  const standalone = await scanStandalone(env, tools, scopes, {
    cwd: opts.cwd,
    envVars: opts.envVars,
  });
  const discoveredR = await discoverPlugins(env, { cwd: opts.cwd });
  if (!discoveredR.ok) return discoveredR;
  const pluginBundled = await scanPluginBundled(env, tools, discoveredR.value);

  let all = [...standalone, ...pluginBundled];
  all = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) all = applyGlobs(all, opts.globs);
  if (opts.enabledFilter === 'enabled-only') all = all.filter((e) => e.enabled === 'on');
  if (opts.enabledFilter === 'disabled-only') all = all.filter((e) => e.enabled === 'off');
  if (opts.enabledFilter === 'unconfigured-only') all = all.filter((e) => e.enabled === 'unset');

  const scopeSet = new Set(scopes);
  all = all.filter((e) => scopeSet.has(e.scope));

  logger.debug(`listCommands: ${standalone.length} standalone + ${pluginBundled.length} plugin = ${all.length}`);

  return ok(all);
};
```

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/scan/list-commands.test.ts
bunx @biomejs/biome check --write packages/core
git add packages/core/src/scan/list-commands.ts packages/core/tests/scan/list-commands.test.ts
git commit -m "feat(core): add listCommands orchestrator (standalone + plugin-bundled)"
```

---

## Phase E — CLI

### Task 12: Extend scope-resolver for `--managed`

**Files:**
- Modify: `packages/cli/src/util/scope-resolver.ts`
- Modify: `packages/cli/tests/util/scope-resolver.test.ts`

- [ ] **Step 1: Failing test (add at end of existing file)**

Append to `packages/cli/tests/util/scope-resolver.test.ts`:

```ts
  test('--managed shorthand → managed', () => {
    const r = resolveScopeFlags({ managed: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('managed');
  });

  test('--managed --system → conflict error', () => {
    const r = resolveScopeFlags({ managed: true, system: true });
    expect(r.ok).toBe(false);
  });
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/cli/tests/util/scope-resolver.test.ts`
Expected: FAIL — `managed` not a valid input field.

- [ ] **Step 3: Extend the resolver**

Replace `packages/cli/src/util/scope-resolver.ts`:

```ts
import { err, ok, type Result, type Scope } from '@skillsmith/core';

export interface ScopeFlagOpts {
  scope?: string;
  user?: boolean;
  system?: boolean;
  project?: boolean;
  managed?: boolean;
}

export const resolveScopeFlags = (
  opts: ScopeFlagOpts,
): Result<Scope | null, { code: 'scope-conflict'; message: string }> => {
  const shorthands: Scope[] = [];
  if (opts.user) shorthands.push('user');
  if (opts.system) shorthands.push('system');
  if (opts.project) shorthands.push('project');
  if (opts.managed) shorthands.push('managed');

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
git commit -m "feat(cli): add --managed shorthand to scope-resolver"
```

---

### Task 13: Extend `list` command with `--managed`, `--enabled`, `--disabled`, origin columns

**Files:**
- Modify: `packages/cli/src/commands/list.ts`
- Modify: `packages/cli/src/output/list-human.ts`
- Modify: `packages/cli/src/output/list-json.ts`
- Modify: `packages/cli/tests/output/list-json.test.ts` (if exists)

- [ ] **Step 1: Bump list-json schema to v2**

Replace `packages/cli/src/output/list-json.ts`:

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

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone') }),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string(),
    pluginVersion: z.string(),
    pluginScope: z.enum(['user', 'project', 'managed', 'local']),
  }),
  z.object({ kind: z.literal('policy') }),
]);

const SkillEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  realpath: z.string(),
  tool: z.string(),
  scope: z.string(),
  root: z.string(),
  frontmatter: FrontmatterSchema,
  origin: OriginSchema,
  enabled: z.enum(['on', 'off', 'unset']),
});

export const ListJsonSchema = z.object({
  schemaVersion: z.literal(2),
  experimental: z.literal(true),
  skills: z.array(SkillEntrySchema),
});

export const renderListJson = (entries: readonly SkillEntry[]): string =>
  JSON.stringify({ schemaVersion: 2, experimental: true, skills: entries }, null, 2);
```

- [ ] **Step 2: Update list-human renderer to show origin**

Replace `packages/cli/src/output/list-human.ts`:

```ts
import type { Origin, SkillEntry } from '@skillsmith/core';

export interface ListHumanOpts {
  long: boolean;
}

const formatOrigin = (o: Origin): string => {
  if (o.kind === 'standalone') return 'standalone';
  if (o.kind === 'plugin') return `plugin:${o.pluginId}@${o.pluginVersion}`;
  return 'policy';
};

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
        const status = s.enabled ? '' : ' [disabled]';
        const origin = formatOrigin(s.origin);
        lines.push(
          opts.long
            ? `    ${s.name}  ${origin}${status}  ${s.path}  ${desc}`
            : `    ${s.name}  ${origin}${status}  ${desc}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
};
```

- [ ] **Step 3: Update existing tests for v2 schema**

Find `packages/cli/tests/output/list-json.test.ts` and update the sample data to include `origin: { kind: 'standalone' }` and `enabled: true` on every SkillEntry; change `schemaVersion: 1` assertions to `schemaVersion: 2`. Same for any list-human tests.

- [ ] **Step 4: Extend `list` command with new flags**

Replace `packages/cli/src/commands/list.ts`:

```ts
import {
  defaultScanEnv,
  listSkills,
  SCOPES,
  type Scope,
  SUPPORTED_TOOLS,
  type SupportedTool,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderListHuman } from '../output/list-human.ts';
import { renderListJson } from '../output/list-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const listCommand = (): Command =>
  new Command('list')
    .alias('ls')
    .description('List installed skills across tools and scopes')
    .argument('[glob...]', 'glob filter(s)')
    .option(
      '-t, --tool <name>',
      'Narrow to a specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(
      new Option('-s, --scope <scope>', 'Narrow to a scope').choices([
        'user',
        'project',
        'system',
        'managed',
      ]),
    )
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--managed', 'shorthand for --scope=managed', false)
    .option('--duplicates', 'Show only cross-scope duplicates', false)
    .option('-l, --long', 'Show paths and details', false)
    .option('--json', 'Emit JSON', false)
    .option('--enabled', 'Show only enabled entries', false)
    .option('--disabled', 'Show only disabled entries', false)
    .option('--unconfigured', 'Show only entries that have never been toggled', false)
    .action(
      async (
        globs: string[],
        opts: {
          tool: string[];
          scope?: string;
          user: boolean;
          system: boolean;
          project: boolean;
          managed: boolean;
          duplicates: boolean;
          long: boolean;
          json: boolean;
          enabled: boolean;
          disabled: boolean;
          unconfigured: boolean;
        },
      ) => {
        const filterCount = [opts.enabled, opts.disabled, opts.unconfigured].filter(Boolean).length;
        if (filterCount > 1) {
          process.stderr.write(
            'error: --enabled, --disabled, and --unconfigured are mutually exclusive\n',
          );
          process.exit(2);
        }
        const scopeR = resolveScopeFlags(opts);
        if (!scopeR.ok) {
          process.stderr.write(`error: ${scopeR.error.message}\n`);
          process.exit(2);
        }
        const tools: readonly SupportedTool[] =
          opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
        const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
        const enabledFilter = opts.enabled
          ? ('enabled-only' as const)
          : opts.disabled
            ? ('disabled-only' as const)
            : opts.unconfigured
              ? ('unconfigured-only' as const)
              : undefined;
        const env = await defaultScanEnv();
        const r = await listSkills(env, {
          tools,
          scopes,
          ...(globs.length > 0 ? { globs } : {}),
          duplicatesOnly: opts.duplicates,
          ...(enabledFilter ? { enabledFilter } : {}),
          cwd: process.cwd(),
          envVars: process.env,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(1);
        }
        process.stdout.write(
          opts.json ? renderListJson(r.value) : renderListHuman(r.value, { long: opts.long }),
        );
      },
    );
```

- [ ] **Step 5: Verify**

```bash
bun test packages/cli
```
Expected: passes; update any failing tests to include the new fields in fixtures.

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write packages/cli
git add packages/cli
git commit -m "feat(cli): extend list with --managed, --enabled/--disabled, origin in output"
```

---

### Task 14: `commands` subcommand + renderers

**Files:**
- Create: `packages/cli/src/output/commands-human.ts`
- Create: `packages/cli/src/output/commands-json.ts`
- Create: `packages/cli/src/commands/commands.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/commands/commands-integration.test.ts`

- [ ] **Step 1: Implement renderers**

`packages/cli/src/output/commands-json.ts`:

```ts
import type { CommandEntry } from '@skillsmith/core';
import { z } from 'zod';

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .nullable();

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone') }),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string(),
    pluginVersion: z.string(),
    pluginScope: z.enum(['user', 'project', 'managed', 'local']),
  }),
  z.object({ kind: z.literal('policy') }),
]);

const CommandEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  realpath: z.string(),
  tool: z.string(),
  scope: z.string(),
  root: z.string(),
  frontmatter: FrontmatterSchema,
  origin: OriginSchema,
  enabled: z.enum(['on', 'off', 'unset']),
});

export const CommandsJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  commands: z.array(CommandEntrySchema),
});

export const renderCommandsJson = (entries: readonly CommandEntry[]): string =>
  JSON.stringify({ schemaVersion: 1, experimental: true, commands: entries }, null, 2);
```

`packages/cli/src/output/commands-human.ts`:

```ts
import type { CommandEntry, Origin } from '@skillsmith/core';

export interface CommandsHumanOpts {
  long: boolean;
}

const formatOrigin = (o: Origin): string => {
  if (o.kind === 'standalone') return 'standalone';
  if (o.kind === 'plugin') return `plugin:${o.pluginId}@${o.pluginVersion}`;
  return 'policy';
};

export const renderCommandsHuman = (
  entries: readonly CommandEntry[],
  opts: CommandsHumanOpts,
): string => {
  if (entries.length === 0) return 'No commands installed.\n';
  const grouped = new Map<string, Map<string, CommandEntry[]>>();
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
    for (const [scope, cmds] of byScope) {
      lines.push(`  ${scope}:`);
      for (const c of cmds) {
        const desc = c.frontmatter?.description ?? '';
        const status = c.enabled ? '' : ' [disabled]';
        const origin = formatOrigin(c.origin);
        lines.push(
          opts.long
            ? `    ${c.name}  ${origin}${status}  ${c.path}  ${desc}`
            : `    ${c.name}  ${origin}${status}  ${desc}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
};
```

- [ ] **Step 2: Implement the command handler**

`packages/cli/src/commands/commands.ts`:

```ts
import {
  defaultScanEnv,
  listCommands,
  type Scope,
  SUPPORTED_TOOLS,
  type SupportedTool,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderCommandsHuman } from '../output/commands-human.ts';
import { renderCommandsJson } from '../output/commands-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

const COMMAND_SCOPES: readonly Scope[] = ['user', 'project'];

export const commandsCommand = (): Command =>
  new Command('commands')
    .description('List installed slash commands across tools and scopes')
    .argument('[glob...]', 'glob filter(s)')
    .option(
      '-t, --tool <name>',
      'Narrow to a specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(
      new Option('-s, --scope <scope>', 'Narrow to a scope (user or project only)').choices([
        'user',
        'project',
      ]),
    )
    .option('--user', 'shorthand for --scope=user', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('-l, --long', 'Show paths and details', false)
    .option('--json', 'Emit JSON', false)
    .option('--enabled', 'Show only enabled entries', false)
    .option('--disabled', 'Show only disabled entries', false)
    .option('--unconfigured', 'Show only entries that have never been toggled', false)
    .action(
      async (
        globs: string[],
        opts: {
          tool: string[];
          scope?: string;
          user: boolean;
          project: boolean;
          long: boolean;
          json: boolean;
          enabled: boolean;
          disabled: boolean;
          unconfigured: boolean;
        },
      ) => {
        const filterCount = [opts.enabled, opts.disabled, opts.unconfigured].filter(Boolean).length;
        if (filterCount > 1) {
          process.stderr.write(
            'error: --enabled, --disabled, and --unconfigured are mutually exclusive\n',
          );
          process.exit(2);
        }
        const scopeR = resolveScopeFlags(opts);
        if (!scopeR.ok) {
          process.stderr.write(`error: ${scopeR.error.message}\n`);
          process.exit(2);
        }
        // Reject system/managed explicitly if they slipped in (scope-resolver doesn't constrain per-command)
        if (scopeR.value === 'system' || scopeR.value === 'managed') {
          process.stderr.write(
            `error: scope '${scopeR.value}' is not available for commands (user or project only)\n`,
          );
          process.exit(2);
        }
        const tools: readonly SupportedTool[] =
          opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
        const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : COMMAND_SCOPES;
        const enabledFilter = opts.enabled
          ? ('enabled-only' as const)
          : opts.disabled
            ? ('disabled-only' as const)
            : opts.unconfigured
              ? ('unconfigured-only' as const)
              : undefined;
        const env = await defaultScanEnv();
        const r = await listCommands(env, {
          tools,
          scopes,
          ...(globs.length > 0 ? { globs } : {}),
          ...(enabledFilter ? { enabledFilter } : {}),
          cwd: process.cwd(),
          envVars: process.env,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(1);
        }
        process.stdout.write(
          opts.json ? renderCommandsJson(r.value) : renderCommandsHuman(r.value, { long: opts.long }),
        );
      },
    );
```

- [ ] **Step 3: Register in `buildProgram`**

In `packages/cli/src/program.ts`, add the import near the other command imports:

```ts
import { commandsCommand } from './commands/commands.ts';
```

And register near the other `addCommand` calls:

```ts
  program.addCommand(commandsCommand());
```

- [ ] **Step 4: Failing integration test**

Create `packages/cli/tests/commands/commands-integration.test.ts`:

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

describe('skillsmith commands', () => {
  test('empty system → "No commands installed." exit 0', async () => {
    const d = join('/tmp', `sk-cmds-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run(['commands', '--tool', 'claude-code'], { HOME: d }, d);
      expect(r.code).toBe(0);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--json empty → valid v1 JSON with commands: []', async () => {
    const d = join('/tmp', `sk-cmdsj-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const r = await run(['commands', '--json', '--tool', 'claude-code'], { HOME: d }, d);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.commands).toEqual([]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('finds seeded user command', async () => {
    const d = join('/tmp', `sk-cmdsseed-${Date.now()}`);
    const cmdDir = join(d, '.claude', 'commands');
    await mkdir(cmdDir, { recursive: true });
    await writeFile(join(cmdDir, 'ci-audit.md'), '---\ndescription: audit\n---\n');
    try {
      const r = await run(
        ['commands', '--tool', 'claude-code', '--json'],
        { HOME: d },
        d,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.commands.some((c: { name: string }) => c.name === 'ci-audit')).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('--scope system exits 2', async () => {
    const r = await run(['commands', '--scope=system']);
    expect(r.code).toBe(2);
  });

  test('--enabled --disabled exits 2', async () => {
    const r = await run(['commands', '--enabled', '--disabled']);
    expect(r.code).toBe(2);
  });
});
```

- [ ] **Step 5: Verify and commit**

```bash
bun test packages/cli/tests/commands/commands-integration.test.ts
bunx @biomejs/biome check --write packages/cli
git add packages/cli
git commit -m "feat(cli): add commands subcommand with json+human renderers"
```

---

## Phase F — Public API + Zones + Tag

### Task 15: Export MVP-2b.1.1 public API

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/public-types.ts`
- Modify: `packages/core/tests/public-api.test.ts`

- [ ] **Step 1: Extend `public-types.ts`**

Add exports:

```ts
export type { CommandEntry } from './commands/types.ts';
export type { ListCommandsOpts } from './scan/list-commands.ts';
export type { Origin, PluginProvenanceScope } from './skills/types.ts';
```

- [ ] **Step 2: Extend `index.ts`**

Add runtime exports:

```ts
export { listCommands } from './scan/list-commands.ts';
```

Add to the type-only re-export block:

```ts
  CommandEntry,
  ListCommandsOpts,
  Origin,
  PluginProvenanceScope,
```

- [ ] **Step 3: Update public-api test**

Add `'listCommands'` to the `expected` set.

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/core/tests/public-api.test.ts
git add packages/core
git commit -m "feat(core): export CommandEntry, Origin, listCommands publicly"
```

---

### Task 16: ESLint zones for `plugins/` and `commands/`

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add zones**

Append to the `zones` array in `eslint.config.js`:

```js
            // plugins is a leaf — no imports from domain modules
            { target: './packages/core/src/plugins', from: './packages/core/src/agents' },
            { target: './packages/core/src/plugins', from: './packages/core/src/skills' },
            { target: './packages/core/src/plugins', from: './packages/core/src/commands' },
            { target: './packages/core/src/plugins', from: './packages/core/src/scan' },
            { target: './packages/core/src/plugins', from: './packages/core/src/doctor' },
            // commands domain is agent-agnostic; same rules as skills
            { target: './packages/core/src/commands', from: './packages/core/src/agents' },
            { target: './packages/core/src/commands', from: './packages/core/src/scan' },
            { target: './packages/core/src/commands', from: './packages/core/src/doctor' },
```

- [ ] **Step 2: Verify**

```bash
bun run lint:boundaries
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "ci: add ESLint zones for plugins/** and commands/**"
```

---

### Task 17: Smoke test against real machine

- [ ] **Step 1: Full check**

```bash
bun run check
```
Expected: all green.

- [ ] **Step 2: Build + smoke**

```bash
bun run build
./dist/skillsmith list --tool claude-code --json | bunx jq '.schemaVersion, (.skills | length), (.skills | map(.origin.kind) | group_by(.) | map({kind: .[0], count: length}))'
./dist/skillsmith list --tool claude-code --disabled --json | bunx jq '.skills | length'
./dist/skillsmith commands --tool claude-code --json | bunx jq '.schemaVersion, (.commands | length)'
./dist/skillsmith commands --tool claude-code --json | bunx jq '.commands | map(.name) | .[0:5]'
./dist/skillsmith list --scope=managed --json | bunx jq '.skills | length'
```

Expected on the reporter's machine:
- First command: `2`, a count ≥ 26, `[{kind: "standalone", count: 1}, {kind: "plugin", count: N}]`
- Second: count of disabled plugin-bundled skills (superpowers was disabled → expect ~10)
- Third: `1` (commands schemaVersion) and a count ≥ 21
- Fourth: first 5 command names including `ci-audit`, `commit-and-push`, etc.
- Fifth: `0` (no managed-settings on typical machines)

- [ ] **Step 3: Commit any fixes from smoke**

Fix anything surfaced, commit as `fix(core|cli): …`.

---

### Task 18: Version bump + `v0.3.1` tag

**Files:**
- Modify: `package.json`, `packages/core/package.json`, `packages/cli/package.json`
- Modify: `packages/core/tests/public-api.test.ts` (VERSION assertion)
- Modify: `packages/cli/tests/help.test.ts` (version regex)

- [ ] **Step 1: Bump versions**

```bash
sed -i '' 's/"version": "0.3.0"/"version": "0.3.1"/' package.json packages/core/package.json packages/cli/package.json
```

- [ ] **Step 2: Update version-asserting tests**

In `packages/core/tests/public-api.test.ts`:

```ts
  test('VERSION matches 0.3.1', () => {
    expect(core.VERSION).toBe('0.3.1');
  });
```

In `packages/cli/tests/help.test.ts` change the regex to `/0\.3\.1/`.

- [ ] **Step 3: Full check + build + smoke**

```bash
bun install
bun run check
bun run build
./dist/skillsmith --version    # → 0.3.1
./dist/skillsmith list --tool claude-code --json | bunx jq '.skills | length'
./dist/skillsmith commands --tool claude-code --json | bunx jq '.commands | length'
```

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "chore: bump workspace to v0.3.1"
git tag -a v0.3.1 -m "MVP-2b.1.1: plugin scope + slash commands + origin/enabled"
```

- [ ] **Step 5: Sanity check**

```bash
git log --oneline -25
git tag
```

Expected: clean tree; `v0.1.0`, `v0.2.0`, `v0.3.0`, `v0.3.1` all present.

---

## Post-plan notes

- **JSON schema bump to v2 on `list`** will break any consumer that hard-coded v1. Experimental from inception, so allowed.
- **`origin.kind: 'policy'`** is defined in the type but not emitted by any walker. Phase 2 adds a policy-aware scanner.
- **Project-scope plugin** installations only surface when `cwd` matches `projectPath` — intentional; otherwise we'd leak other repos' installed plugins.
- **Managed-settings reading is minimally tested** — only the happy path on darwin. Linux/Windows managed paths are implemented but exercised only when real managed-settings files exist.
- **`list --duplicates`** now counts plugin-bundled skills for duplicate detection. `doctor`'s `cross-scope-duplicate` check piggybacks on this automatically.
- **Coverage gate from MVP-2b.1 spec** was never wired; this plan doesn't add one. If wanted, add a follow-up task.
