# P16: Hermetic Git Fixtures (#17) Implementation Plan — v2 (final, post cross-evaluation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Provenance:** v1 (Claude) was cross-evaluated against an independent Codex plan and an adversarial Codex review (session 019f4ef9-175c-7c91-a0d6-af1905cd45a1). This v2 merges both. Key changes from v1: scrub list expanded to git's authoritative repo-local set (+4 defensive extras); overrides can no longer reintroduce scrubbed vars; ONE canonical helper (ESLint ignores `packages/*/tests/**` and CLI tests already import core fixtures relatively — the v1 mirror rationale was wrong); NEW preload task closing the in-process production-spawn gap (`defaultScanEnv().exec` → `execCommand` → real git in `fetch.test.ts`, `store.test.ts` etc.); regression tests restructured so the red phase fails on victim-corruption assertions, with exception-safe cleanup; e2e hardened (mktemp sandbox clone, programmatic asserts); PROJECTS.md glyph corrected to this repo's legend (`[-]` = In Progress).

**Goal:** Make every git process reachable from `bun test` — direct fixture spawns AND production spawn paths invoked in-process by tests — hermetic against an inherited hook environment (`GIT_DIR` et al.), so the lefthook pre-push can never again leak fixture commits into the real repo (issue #17), proven by regression tests that build fixtures under a poisoned `GIT_DIR`.

**Architecture:** One canonical test-only helper `packages/core/tests/fixtures/git-env.ts` (exports `GIT_REPO_SCRUB_VARS`, `hermeticGitEnv(overrides?)`, `scrubGitRepoEnv()`, `runGit(cwd, args)`), imported by both packages' tests (precedent: `packages/cli/tests/commands/dev-source.test.ts:4`). Two layers: (1) every direct `Bun.spawn`/`Bun.spawnSync` in tests routes env through `hermeticGitEnv()`; (2) a bun test preload calls `scrubGitRepoEnv()` once at runner startup, so tests that call production `execCommand`/`defaultScanEnv` in-process inherit a clean env — without touching production code. A canary test asserts the runner env stays clean; per-builder regression tests poison `process.env` and assert a victim repo is untouched.

**Tech Stack:** Bun test (sequential, single process — verified: no `--concurrent` anywhere; preload via root `bunfig.toml`), `Bun.spawnSync`, TypeScript.

**Background — the incident mechanism:** lefthook pre-push runs `bun test` with `GIT_DIR` pointing at the real repo's `.git`. When `GIT_DIR` is set without `GIT_WORK_TREE`, git treats the child's **cwd as the worktree**: a fixture's `git init` in a temp dir re-inits the real repo, `git add -A` stages the temp dir's files against the real index, `git commit` lands junk on the branch being pushed (8 commits during P15).

## Global Constraints

- Branch: `test/p16-hermetic-git-fixtures` from `main`, created before Task 0's commit.
- Test-only + config: NO changes under `packages/*/src/**`. The production-side hole (`packages/core/src/env/exec.ts:52` spreads `process.env`; `skillsmith install` run from inside any git hook could corrupt a user's repo) gets a follow-up issue in Task 6 — not code here.
- ONE canonical helper in `packages/core/tests/fixtures/git-env.ts`. No mirror. (ESLint zones ignore `packages/*/tests/**` — `eslint.config.js:12`.)
- Fixture builders stay in their own files; only env construction centralizes.
- Every commit ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8`
- Commit types `test:`/`docs:`/`chore:` → no release (expected; no Release PR will appear).
- Full verification: `bun run check` (biome, eslint boundaries, tsc, actionlint, bun test).
- PROJECTS.md legend (repo-local, overrides global convention): `[-]` = In Progress, `[x]` = Completed, `[~]` = Won't fix.
- SDD model per task (user's matrix): T0 haiku · T1 sonnet · T2 sonnet · T3 haiku · T4 sonnet · T5 haiku · T6 opus-tier closeout run by the main session; implementation subagents drive Codex.

---

### Task 0: Branch + register P16 in PROJECTS.md

**Files:**
- Modify: `PROJECTS.md` (insert immediately ABOVE the first `## [` project heading)

**Interfaces:**
- Produces: the P16 task IDs Task 6 flips to `[x]`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b test/p16-hermetic-git-fixtures
```

- [ ] **Step 2: Insert the P16 entry** (note `[-]` = In Progress in THIS repo's legend)

```markdown
## [-] Project P16: Hermetic git fixtures — scrub inherited GIT_DIR (#17) (v0.7.0)
**Goal**: Every git process reachable from `bun test` — direct fixture spawns and production spawn paths called in-process by tests — must be hermetic regardless of invoking context: scrub git's repo-location env family from child envs (canonical helper) and from the test runner itself (preload), so the lefthook pre-push can never leak fixture commits into the real repo again. Closes #17; retires the `--no-verify` push workaround.

### Tests & Tasks
- [ ] [P16-T01] Canonical hermetic git-env helper `packages/core/tests/fixtures/git-env.ts` (+ unit tests)
- [ ] [P16-TS01] Regression: per-builder poisoned-`GIT_DIR` tests leave a victim repo untouched
- [ ] [P16-T02] Route both fixture builders (`acquire/remote.ts`, `place/fleet.ts`) through the helper
- [ ] [P16-T03] Sweep inline git spawns in core tests through `hermeticGitEnv()`
- [ ] [P16-T04] Test preload scrubbing the runner env (bunfig.toml) + runner-env canary test
- [ ] [P16-T05] Sweep every CLI-test spawn through the canonical helper
- [ ] [P16-TS02] Simulated-hook e2e: suite passes in a sandbox clone with `GIT_DIR` poisoned; clone untouched
- [ ] [P16-T06] Closeout: file production-side follow-up issue, flip PROJECTS.md, PR (`Closes #17`), push without `--no-verify`

### Automated Verification
- `bun test packages/core/tests/fixtures` passes (unit + regression + canary)
- `bun run check` passes
- Sandbox-clone e2e script exits 0 (suite green, clone HEAD/count/status unchanged)

---

```

- [ ] **Step 3: Commit**

```bash
git add PROJECTS.md
git commit -m "docs: register P16 hermetic git fixtures (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

---

### Task 1: Canonical hermetic git-env helper + unit tests

**Files:**
- Create: `packages/core/tests/fixtures/git-env.ts`
- Test: `packages/core/tests/fixtures/git-env.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `GIT_REPO_SCRUB_VARS: readonly string[]`
  - `hermeticGitEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined>` — scrub and config-pin ALWAYS win over overrides.
  - `scrubGitRepoEnv(): void` — deletes the scrub vars from `process.env` (preload entry point).
  - `runGit(cwd: string, args: string[]): string` — throws `Error` with stderr on non-zero exit (same contract as today's per-fixture `runGit`s).

- [ ] **Step 1: Write the failing unit test**

`packages/core/tests/fixtures/git-env.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { GIT_REPO_SCRUB_VARS, hermeticGitEnv, scrubGitRepoEnv } from './git-env.ts';

const withPoisonedProcessEnv = (fn: () => void): void => {
  const saved: Record<string, string | undefined> = {};
  for (const name of GIT_REPO_SCRUB_VARS) {
    saved[name] = process.env[name];
    process.env[name] = '/poisoned';
  }
  try {
    fn();
  } finally {
    for (const name of GIT_REPO_SCRUB_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};

describe('hermeticGitEnv', () => {
  test('scrubs every repo-location variable inherited from the parent env', () => {
    withPoisonedProcessEnv(() => {
      const env = hermeticGitEnv();
      for (const name of GIT_REPO_SCRUB_VARS) {
        expect(env[name]).toBeUndefined();
      }
    });
  });

  test('pins git config to /dev/null like the previous per-fixture envs did', () => {
    const env = hermeticGitEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });

  test('overrides cannot reintroduce scrubbed variables or unpin config', () => {
    const env = hermeticGitEnv({ GIT_DIR: '/explicit/.git', GIT_CONFIG_GLOBAL: '/tmp/cfg' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  test('non-git overrides pass through and unrelated vars are preserved', () => {
    const env = hermeticGitEnv({ HOME: '/tmp/fixture-home', SKILLSMITH_E2E: '1' });
    expect(env.HOME).toBe('/tmp/fixture-home');
    expect(env.SKILLSMITH_E2E).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe('scrubGitRepoEnv', () => {
  test('deletes the scrub vars from process.env itself', () => {
    withPoisonedProcessEnv(() => {
      scrubGitRepoEnv();
      for (const name of GIT_REPO_SCRUB_VARS) {
        expect(process.env[name]).toBeUndefined();
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/tests/fixtures/git-env.test.ts`
Expected: FAIL — `Cannot find module './git-env.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/core/tests/fixtures/git-env.ts`:

```ts
// Hermetic env for spawning git (or the CLI) from tests. Git hooks — e.g. the
// lefthook pre-push that runs `bun test` — export repo-location variables such
// as GIT_DIR; a child git inheriting them writes to the REAL repo instead of
// the fixture temp dir (issue #17).
//
// The first 15 names are `git rev-parse --local-env-vars` (git 2.50); the last
// 4 are defensive extras that also affect repo discovery/writes. Revisit on
// major git upgrades.
export const GIT_REPO_SCRUB_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

// Scrub and config-pinning win over overrides: no test may reintroduce a
// repo-location var, so a poisoned caller can never opt back into the bug.
export const hermeticGitEnv = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  for (const name of GIT_REPO_SCRUB_VARS) delete env[name];
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
};

export const scrubGitRepoEnv = (): void => {
  for (const name of GIT_REPO_SCRUB_VARS) delete process.env[name];
};

export const runGit = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: hermeticGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }

  return new TextDecoder().decode(result.stdout);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/tests/fixtures/git-env.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/tests/fixtures/git-env.ts packages/core/tests/fixtures/git-env.test.ts
git commit -m "test(core): add hermetic git env helper for fixtures (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

---

### Task 2: Per-builder regression tests + make both fixture builders hermetic

**Files:**
- Test: `packages/core/tests/fixtures/hermetic-fixtures.test.ts` (create)
- Modify: `packages/core/tests/fixtures/acquire/remote.ts` (delete local `runGit` at lines 20-39, import shared one)
- Modify: `packages/core/tests/fixtures/place/fleet.ts` (delete local `gitEnv` + `runGit` at lines 135-155, import shared one)

**Interfaces:**
- Consumes: `runGit` from Task 1.
- Produces: `buildRemoteFixture`/`buildFixtureFleet` unchanged in signature — only child env changes. No caller updates needed.

**Red-phase design (from the adversarial review):** pre-fix, the poisoned remote builder advances the victim's HEAD twice and then THROWS at the `git clone` step (the fixture worktree never got a `.git`). So the builder call is wrapped in try/catch and the victim assertions ALWAYS run — red must fail on "victim corrupted", not on an incidental exception. Cleanup is exception-safe; each builder gets its own test so the fleet path is exercised independently.

- [ ] **Step 1: Write the failing regression tests**

`packages/core/tests/fixtures/hermetic-fixtures.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGit } from './git-env.ts';
import { buildRemoteFixture, destroyRemoteFixture } from './acquire/remote.ts';
import { buildFixtureFleet, destroyFixtureFleet } from './place/fleet.ts';

// Reproduces issue #17: lefthook pre-push exports GIT_DIR (no GIT_WORK_TREE),
// so a non-hermetic child git treats its cwd as the worktree of the REAL repo
// and fixture commits land on the branch being pushed.
const POISON_VARS = ['GIT_DIR', 'GIT_INDEX_FILE'] as const;

interface Victim {
  dir: string;
  head: string;
}

const makeVictim = async (): Promise<Victim> => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-victim-'));
  await writeFile(join(dir, 'README.md'), '# victim\n');
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, [
    '-c', 'user.email=victim@skillsmith.test',
    '-c', 'user.name=victim',
    '-c', 'commit.gpgsign=false',
    'add', '-A',
  ]);
  runGit(dir, [
    '-c', 'user.email=victim@skillsmith.test',
    '-c', 'user.name=victim',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'victim: initial',
  ]);
  return { dir, head: runGit(dir, ['rev-parse', 'HEAD']).trim() };
};

const withPoisonedEnv = async <T>(victim: Victim, fn: () => Promise<T>): Promise<T> => {
  const saved: Record<string, string | undefined> = {};
  for (const name of POISON_VARS) saved[name] = process.env[name];
  process.env.GIT_DIR = join(victim.dir, '.git');
  process.env.GIT_INDEX_FILE = join(victim.dir, '.git', 'index');
  try {
    return await fn();
  } finally {
    for (const name of POISON_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};

// The load-bearing assertions: same HEAD, exactly one commit, clean tree.
const assertVictimUntouched = (victim: Victim): void => {
  expect(runGit(victim.dir, ['rev-parse', 'HEAD']).trim()).toBe(victim.head);
  expect(runGit(victim.dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  expect(runGit(victim.dir, ['status', '--porcelain']).trim()).toBe('');
};

test('buildRemoteFixture is hermetic under a poisoned hook environment (#17)', async () => {
  const victim = await makeVictim();
  let fixture: Awaited<ReturnType<typeof buildRemoteFixture>> | null = null;
  let builderError: unknown = null;
  try {
    try {
      fixture = await withPoisonedEnv(victim, () => buildRemoteFixture());
    } catch (e) {
      builderError = e;
    }
    assertVictimUntouched(victim);
    expect(builderError).toBeNull();
    expect(fixture?.multiHead).not.toBe(victim.head);
  } finally {
    if (fixture) await destroyRemoteFixture(fixture);
    await rm(victim.dir, { recursive: true, force: true });
  }
});

test('buildFixtureFleet is hermetic under a poisoned hook environment (#17)', async () => {
  const victim = await makeVictim();
  let fleet: Awaited<ReturnType<typeof buildFixtureFleet>> | null = null;
  let builderError: unknown = null;
  try {
    try {
      fleet = await withPoisonedEnv(victim, () => buildFixtureFleet());
    } catch (e) {
      builderError = e;
    }
    assertVictimUntouched(victim);
    expect(builderError).toBeNull();
    expect(fleet?.headSha).not.toBe(victim.head);
  } finally {
    if (fleet) await destroyFixtureFleet(fleet);
    await rm(victim.dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail on the corruption assertions**

Run: `bun test packages/core/tests/fixtures/hermetic-fixtures.test.ts`
Expected: FAIL, both tests, specifically inside `assertVictimUntouched` (rev-list count `2`/`3` ≠ `1`, or HEAD mismatch) — the victim setup itself uses the already-hermetic Task 1 `runGit`, so setup succeeds and the failure IS the corruption signal. The poison targets only temp victim repos; the real checkout is never at risk.

- [ ] **Step 3: Route `acquire/remote.ts` through the shared helper**

Add to imports:

```ts
import { runGit } from '../git-env.ts';
```

DELETE the local `runGit` block (lines 20-39):

```ts
const runGit = (cwd: string, args: string[]): string => {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: gitEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }

  return new TextDecoder().decode(result.stdout);
};
```

All existing call sites keep working — identical signature and error contract.

- [ ] **Step 4: Route `place/fleet.ts` through the shared helper**

Add to imports:

```ts
import { runGit } from '../git-env.ts';
```

DELETE the local block inside `buildFixtureFleet` (lines 135-155):

```ts
  // Initialize git repo and commit
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  const runGit = (cwd: string, args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd,
      env: gitEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
    }

    return new TextDecoder().decode(result.stdout);
  };
```

- [ ] **Step 5: Run the regression tests to verify they pass**

Run: `bun test packages/core/tests/fixtures/hermetic-fixtures.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full core suite to catch fallout**

Run: `bun test packages/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/tests/fixtures/hermetic-fixtures.test.ts packages/core/tests/fixtures/acquire/remote.ts packages/core/tests/fixtures/place/fleet.ts
git commit -m "test(core): make fixture builders hermetic against inherited GIT_DIR (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

---

### Task 3: Sweep inline git spawns in core tests

**Files (all Modify):**
- `packages/core/tests/acquire/interop-roundtrip.test.ts` (~line 114: own runGit with env spread)
- `packages/core/tests/place/roundtrip.test.ts` (~line 29)
- `packages/core/tests/place/run.test.ts` (~line 43)
- `packages/core/tests/place/store-linked-flip.test.ts` (~line 36)
- `packages/core/tests/acquire/remote-fixture.test.ts` (7 `Bun.spawnSync` sites at ~lines 25, 36, 47, 58, 69, 104, 201 — currently NO env, implicitly inheriting the full poisoned `process.env`)
- `packages/core/tests/place/fleet.test.ts` (2 sites at ~lines 37, 47 — same)

**Interfaces:**
- Consumes: `hermeticGitEnv` from `../fixtures/git-env.ts`.

- [ ] **Step 1: Replace hand-rolled env spreads**

In each of the first four files, add (relative path from `tests/acquire/` or `tests/place/`):

```ts
import { hermeticGitEnv } from '../fixtures/git-env.ts';
```

and transform:

```ts
// before (single-line or split across lines)
env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
// after
env: hermeticGitEnv(),
```

- [ ] **Step 2: Add env to the bare spawns**

In `remote-fixture.test.ts` and `fleet.test.ts`, add the same import, then add `env: hermeticGitEnv(),` to each `Bun.spawnSync` options object:

```ts
// before
const result = Bun.spawnSync(['git', '-C', `${fixture.base}/multi.git`, 'rev-parse', '--is-bare-repository'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
// after
const result = Bun.spawnSync(['git', '-C', `${fixture.base}/multi.git`, 'rev-parse', '--is-bare-repository'], {
  env: hermeticGitEnv(),
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

(Without this, a poisoned `GIT_DIR` makes these read-only assertions inspect the WRONG repo — silent mis-verification.)

- [ ] **Step 3: Run the core suite**

Run: `bun test packages/core`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests
git commit -m "test(core): route inline git spawns through hermeticGitEnv (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

---

### Task 4: Test preload (closes the in-process production-spawn gap) + canary test

**Files:**
- Create: `packages/core/tests/fixtures/preload.ts`
- Create: `packages/core/tests/fixtures/runner-env.test.ts`
- Modify: `bunfig.toml` (root)

**Interfaces:**
- Consumes: `scrubGitRepoEnv`, `GIT_REPO_SCRUB_VARS` from Task 1.

**Why (adversarial-review finding #3):** core tests call PRODUCTION spawn paths in-process — `defaultScanEnv().exec` → `execCommand` (`packages/core/src/env/exec.ts:52`, spreads `process.env`) → real `git init`/`remote add`/`fetch` in `packages/core/src/acquire/fetch.ts`, exercised by e.g. `packages/core/tests/acquire/fetch.test.ts` and `packages/core/tests/place/store.test.ts`. Per-spawn-site scrubbing cannot reach these without touching production code. Scrubbing the RUNNER's own env once at startup means production code spreads a clean env. The canary test makes the invariant observable: under a hook, a missing/broken preload becomes a test failure instead of silent corruption.

- [ ] **Step 1: Write the canary test (fails until the preload is wired — run it under a poisoned env to prove red)**

`packages/core/tests/fixtures/runner-env.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { GIT_REPO_SCRUB_VARS } from './git-env.ts';

// Canary for the bunfig [test].preload: the runner process itself must be
// clean, or tests that call production spawn paths in-process (execCommand,
// defaultScanEnv) re-inherit a hook's GIT_DIR (#17). Under lefthook pre-push
// this test fails loudly if the preload is ever unwired.
test('test runner env carries no git repo-location variables', () => {
  for (const name of GIT_REPO_SCRUB_VARS) {
    expect(process.env[name]).toBeUndefined();
  }
});
```

- [ ] **Step 2: Verify it fails without the preload under a hook-like env**

Run: `GIT_DIR=/nonexistent/.git bun test packages/core/tests/fixtures/runner-env.test.ts`
Expected: FAIL (`GIT_DIR` is defined). Plain `bun test` of the file passes trivially — the poisoned invocation is the meaningful red.

- [ ] **Step 3: Create the preload and wire bunfig**

`packages/core/tests/fixtures/preload.ts`:

```ts
// Loaded once per test-runner process via root bunfig.toml [test].preload,
// BEFORE any test module: strips the git repo-location vars a hook injected
// into the runner itself, so in-process production spawn paths (execCommand,
// defaultScanEnv) inherit a clean env without production changes (#17).
import { scrubGitRepoEnv } from './git-env.ts';

scrubGitRepoEnv();
```

`bunfig.toml` becomes:

```toml
[install]
exact = true

[test]
coverage = false
preload = ["./packages/core/tests/fixtures/preload.ts"]
```

- [ ] **Step 4: Verify the canary passes under the poisoned env, and the suite still runs**

Run: `GIT_DIR=/nonexistent/.git bun test packages/core/tests/fixtures/runner-env.test.ts`
Expected: PASS (preload scrubbed it).
Run: `bun test packages/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/tests/fixtures/preload.ts packages/core/tests/fixtures/runner-env.test.ts bunfig.toml
git commit -m "test: scrub git repo-location env from the bun test runner via preload (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

(No scope — bunfig.toml is a root config; commitlint allows scopeless.)

---

### Task 5: Sweep every CLI-test spawn through the canonical helper

**Files (all Modify; import from `../../../core/tests/fixtures/git-env.ts` in `commands/` and `completion/`, `../../core/tests/fixtures/git-env.ts` from `tests/` root — same precedent as `dev-source.test.ts:4`):**
- Spread-env CLI spawns — replace `env: { ...process.env, ...X }` with `env: hermeticGitEnv(X)`:
  - `packages/cli/tests/commands/config-integration.test.ts` (spawn ~line 7)
  - `packages/cli/tests/commands/uninstall.test.ts` (~line 12)
  - `packages/cli/tests/commands/dev-source.test.ts` (~lines 20 and 165; the second is `hermeticGitEnv(sandboxEnv(f))`)
  - `packages/cli/tests/commands/flip-live.test.ts` (~line 98)
  - `packages/cli/tests/commands/install-live.test.ts` (~line 104)
  - `packages/cli/tests/commands/dev-source-live.test.ts` (~line 44)
  - `packages/cli/tests/commands/install-remote-live.test.ts` (~line 37)
- No-env CLI spawns — add `env: hermeticGitEnv(),` to the options object:
  - `packages/cli/tests/help.test.ts` (~line 7)
  - `packages/cli/tests/completion/integration.test.ts` (~line 5)
  - `packages/cli/tests/commands/promote.test.ts` (~line 6)
  - `packages/cli/tests/commands/dev.test.ts` (~line 6)
  - `packages/cli/tests/commands/install.test.ts` (~line 7)
  - `packages/cli/tests/commands/verify-live.test.ts` (~line 19 — route whatever env shape it has through `hermeticGitEnv(...)`)
- Raw git spawn with no env: `packages/cli/tests/commands/install-remote-live.test.ts` (~line 60) — delete the local `runGit` and import `runGit` from the canonical helper (same signature).

**Interfaces:**
- Consumes: `hermeticGitEnv`, `runGit` from Task 1 (cross-package relative import — allowed: ESLint ignores `packages/*/tests/**`, and CLI tests already import core fixtures this way).

**Why:** these spawn the CLI binary, which internally runs git via production `execCommand` spreading ITS OWN `process.env` — the child CLI process must therefore start clean.

- [ ] **Step 1: Apply the transforms**

Spread-env shape:

```ts
// before
env: { ...process.env, ...env },
// after
env: hermeticGitEnv(env),
```

No-env shape:

```ts
// before
const proc = Bun.spawn(['bun', 'run', BIN, ...args], { stdout: 'pipe', stderr: 'pipe' });
// after
const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
  env: hermeticGitEnv(),
  stdout: 'pipe',
  stderr: 'pipe',
});
```

- [ ] **Step 2: Static sweep — confirm no test spawn remains unrouted**

Run: `grep -rn "Bun.spawn" packages/core/tests packages/cli/tests | grep -v "git-env" | grep -v "hermeticGitEnv"`
Expected: no hits (every remaining spawn call site passes `hermeticGitEnv`).

- [ ] **Step 3: Run the CLI suite**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/tests
git commit -m "test(cli): scrub inherited git repo-location env from all test spawns (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

---

### Task 6: Simulated-hook e2e + closeout

**Files:**
- Modify: `PROJECTS.md` (flip P16)
- No source changes — verification, follow-up issue, PR, push.

**Interfaces:**
- Consumes: everything above, committed on `test/p16-hermetic-git-fixtures`.

- [ ] **Step 1: Full check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 2: End-to-end in a sandbox clone (the P15 incident conditions, programmatically asserted)**

The suite runs INSIDE a disposable clone with `GIT_DIR` pointed at that same clone — exactly what the hook does to the real repo. The real checkout is never involved. Gated `*-live` suites skip without `SKILLSMITH_E2E=1` here, which matches the real pre-push surface (the hook runs plain `bun test`); their spawn sites are covered by Task 5's static sweep.

```bash
set -euo pipefail
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
git clone --quiet /Users/stevemorin/c/skillsmith "$SANDBOX/clone"
git -C "$SANDBOX/clone" checkout --quiet test/p16-hermetic-git-fixtures
(cd "$SANDBOX/clone" && bun install --frozen-lockfile >/dev/null 2>&1)
BEFORE_HEAD=$(git -C "$SANDBOX/clone" rev-parse HEAD)
BEFORE_COUNT=$(git -C "$SANDBOX/clone" rev-list --count HEAD)
(cd "$SANDBOX/clone" && env -u GIT_WORK_TREE -u GIT_INDEX_FILE GIT_DIR="$SANDBOX/clone/.git" bun test)
AFTER_HEAD=$(git -C "$SANDBOX/clone" rev-parse HEAD)
AFTER_COUNT=$(git -C "$SANDBOX/clone" rev-list --count HEAD)
test "$BEFORE_HEAD" = "$AFTER_HEAD"
test "$BEFORE_COUNT" = "$AFTER_COUNT"
test -z "$(git -C "$SANDBOX/clone" status --porcelain)"
echo "E2E HERMETIC: suite green, clone untouched"
```

Expected: exits 0 printing `E2E HERMETIC: suite green, clone untouched`. Any junk commit, dirty status, or suite failure exits non-zero — find the unswept site and fix before proceeding.

- [ ] **Step 3: File the production-side follow-up issue**

```bash
gh issue create \
  --title "acquire: production git spawns inherit hook env (GIT_DIR) — same class as #17" \
  --body "execCommand (packages/core/src/env/exec.ts:52) spreads process.env into every child, including the git processes the acquire pipeline spawns (packages/core/src/acquire/fetch.ts). A user running \`skillsmith install <git-url>\` from inside any git hook (GIT_DIR exported) could corrupt their own repo exactly like #17 did to this one. #17's fix is test-side only (helper + bun test preload); this issue tracks the production decision: scrub git repo-location vars in execCommand/the acquire git runner, or document the constraint. Surfaced during the P16 cross-evaluation review."
```

- [ ] **Step 4: Flip PROJECTS.md**

Flip the P16 header `## [-]` → `## [x]` and all eight task/test checkboxes to `[x]`.

```bash
git add PROJECTS.md
git commit -m "docs: flip P16 tasks — hermetic git fixtures complete (#17)

Claude-Session: https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8"
```

- [ ] **Step 5: Push WITHOUT --no-verify (the live proof)**

```bash
git log --oneline -8   # record tip before push
git push -u origin test/p16-hermetic-git-fixtures
git log --oneline -8   # must be identical — no junk commits appeared
```

Expected: pre-push runs the full `bun test` under its real `GIT_DIR` and passes (the canary test now guards this forever); branch tip identical before/after. First push since P15 that doesn't need the #17 workaround.

- [ ] **Step 6: Open the PR**

```bash
gh pr create \
  --title "test: make test-spawned git hermetic against inherited hook env" \
  --body "$(cat <<'EOF'
Makes every git process reachable from `bun test` hermetic against an inherited
hook environment (issue #17: lefthook pre-push exports GIT_DIR; fixture commits
landed on the real branch during P15).

Two layers, test-only:
- Canonical helper (packages/core/tests/fixtures/git-env.ts): hermeticGitEnv()
  scrubs git's repo-location env family (git rev-parse --local-env-vars + 4
  defensive extras) and pins config; every direct test spawn routes through it.
- bun test preload scrubs the runner's own process.env, so tests that call
  production spawn paths in-process (execCommand/defaultScanEnv → acquire git)
  inherit a clean env. A canary test fails loudly if the preload is unwired.

Proof: per-builder regression tests build fixtures under a poisoned GIT_DIR and
assert a victim repo stays untouched (red phase failed on the corruption
assertions); e2e ran the full suite inside a sandbox clone with GIT_DIR pointed
at itself — clone unchanged; this branch was pushed without --no-verify for the
first time since the incident.

Production-side counterpart (skillsmith run from inside a user's hook) filed
separately.

Closes #17

https://claude.ai/code/session_015J5oHT5UsRB1fG7WKoxFM8
EOF
)"
```

- [ ] **Step 7: Report back** — merging the squash PR is the user's call (title is Conventional `test:` → no release; merge auto-closes #17).

---

## Self-Review Notes (v2)

- Adversarial-review amendments adopted: 1 (in-process gap → Task 4 preload), 2 (red = corruption assertion → Task 2 restructure), 3 (scrub list + override semantics → Task 1), 4 (canonical helper → Tasks 1/5), 5 (e2e hardening → Task 6 Step 2), 6 (exception-safe cleanup → Task 2), 7 (`[-]` glyph → Tasks 0/6).
- From the independent Codex plan: authoritative scrub list, preload mechanism, corrected line numbers, sandbox-clone e2e.
- Rejected from review: fixing production now (user scoped test-only; filed as issue instead — Task 6 Step 3). Rejected from Codex plan: overrides-before-scrub ordering is kept, but WITH scrub-wins semantics (Codex had this right; v1 had overrides-win — removed); nested `bun --eval` regression harness (unnecessary — bun runs test files sequentially in one process, confirmed by the adversarial review, and in-process poison keeps the test simple).
- Type consistency: `runGit(cwd, args): string`, `hermeticGitEnv(overrides?)`, `scrubGitRepoEnv()`, `GIT_REPO_SCRUB_VARS` used identically across all tasks.
