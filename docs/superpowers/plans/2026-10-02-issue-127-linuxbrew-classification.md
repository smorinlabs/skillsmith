# Linuxbrew install-method classification implementation plan (#127)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `classifyInstallMethod` reports `brew` for binaries installed under Homebrew's default Linux prefix, `/home/linuxbrew/.linuxbrew`, exactly as it does for `/opt/homebrew` and `/usr/local`.

**Architecture:** `classifyInstallMethod` (`packages/core/src/detect/scanners.ts:20-33`) labels a binary by its resolved target path. It is called once, from `createBinaryDetect` (`packages/core/src/agents/detect-factory.ts:30`), with the `realpath` of each binary `findOnPath` found. The fix replaces the two separately maintained Homebrew prefix lists (a regex guard at `:26` and a `startsWith` chain at `:28`) with one `homebrewPrefixes` list holding Homebrew's three documented default prefixes, consulted once per call. The rule order is unchanged: Homebrew `Cellar`/`Caskroom` first, then `/lib/node_modules/` as `npm-global`, then any other path under a Homebrew prefix as `brew`.

**Tech Stack:** TypeScript, Bun 1.4.2 test runner (`bun test`), Biome (format and lint, `lineWidth: 100`, single quotes), ESLint import-boundary rules, lefthook hooks, commitlint (Conventional Commits, scope enum `cli | core | main | release`).

**Spec:** GitHub issue [smorinlabs/skillsmith#127](https://github.com/smorinlabs/skillsmith/issues/127), "Classify Linuxbrew (/home/linuxbrew/.linuxbrew) installs as brew", raised by the Copilot review on PR #125 (`packages/core/src/detect/scanners.ts:26`, review comment `r4129666854`). The issue text is quoted in section 1.1.

## Global Constraints

- Work only in the worktree `/Users/stevemorin/c/skillsmith-fix-127-linuxbrew`, branch `fix/linuxbrew-classification`, based on `origin/main` `af7e7ca`.
- The `InstallMethod` enum (`packages/core/src/detect/types.ts:1-7`) is unchanged: `'brew' | 'npm-global' | 'bun-global' | 'native-installer' | 'app-bundle' | 'unknown'`. The `v1` and `v2` agents contracts (`packages/core/src/contracts/v1/agents.ts:9`, `packages/core/src/contracts/v2/agents.ts:12`) therefore need no change.
- `packages/core` is an embeddable library (repo `CLAUDE.md`): no CLI imports, no `console.*`, no `process.exit`. This change touches none of those.
- Commits are Conventional with scope `core` for `packages/core/**`: `fix(core): ...` (patch bump by release-please) and nothing else in this plan bumps the version. Subjects start lowercase.
- Do not hand-edit `CHANGELOG.md`, `package.json` versions or `.release-please-manifest.json`; release-please owns them.
- Do not run the full serial gate (`bun scripts/run-test-files-serial.ts`) or `bun run check` during implementation; focused `bun test ./<file>` runs are the test loop. The full gate runs automatically in the `pre-push` hook (about 30 minutes on macOS, per `CLAUDE.md`).
- Every commit must pass the `pre-commit` hooks in `lefthook.yml`: Biome `check --staged` (a formatting difference is an error), ESLint boundaries on `packages/*/{src,tests}/**/*.ts`, and gitleaks. The `commit-msg` hook runs commitlint.
- Each implementation commit carries the implementing session's own `Claude-Session:` trailer, as that session's harness reminder instructs. Do not copy the planning session's trailer.

## Review Focus

Inputs the issue implies but does not spell out, each pinned by a test in the task named:

1. A sibling directory of the Linux prefix, `/home/linuxbrew/.linuxbrew-extra/bin/codex` (named in Homebrew's Support-Tiers page as a non-default prefix), must stay `unknown`. The prefix match must require a `/` after the prefix. Pinned in Task 1.
2. An npm global installed with Linuxbrew's own `node`, `/home/linuxbrew/.linuxbrew/lib/node_modules/@openai/codex/bin/codex.js`, must stay `npm-global`, mirroring the `/opt/homebrew/lib/node_modules/` case from PR #125. This is the test that proves the three-rule order survived for the new prefix. Pinned in Task 1.
3. When `realpath` throws, `createBinaryDetect` classifies the link path `/home/linuxbrew/.linuxbrew/bin/codex`, which must be `brew`. Pinned in Task 1.
4. A user whose home directory is literally `/home/linuxbrew` but who installs tools elsewhere, for example `/home/linuxbrew/.local/bin/claude`, must stay `unknown`. Pinned in Task 1.
5. The detect-level path on Linux: `findOnPath` only finds `/home/linuxbrew/.linuxbrew/bin/codex` when that directory is on `$PATH`, because `wellKnownBinDirs` gains no Linux fallback in this plan (section 1.4). The detect-level tests must therefore set `executableSearchPath: ['/home/linuxbrew/.linuxbrew/bin']`, `platform: 'linux'` and a `/home/...` `homeDir`; the existing `env()` helper in `codex.test.ts:5-20` hardcodes `darwin` and `/usr/bin`. Pinned in Task 2.

---

## 1. Investigation

### 1.1 The defect

Issue #127, verbatim:

> `classifyInstallMethod` (`packages/core/src/detect/scanners.ts`) recognizes Homebrew only under `/opt/homebrew` and `/usr/local`. Homebrew's default Linux prefix, `/home/linuxbrew/.linuxbrew`, is not recognized:
>
> - A native Linuxbrew formula binary (`/home/linuxbrew/.linuxbrew/Cellar/<formula>/<ver>/bin/...`) is reported as `unknown`. This predates #125.
> - After #125 (classify by resolved target), a node-based Linuxbrew formula (`/home/linuxbrew/.linuxbrew/Cellar/<formula>/<ver>/libexec/lib/node_modules/...`) is reported as `npm-global` instead of `brew`.
>
> Proposed fix: include the Linuxbrew prefix in both the `Cellar`/`Caskroom` guard and the generic Homebrew rule, with classifier test cases for each.

The classifier as it stands on `af7e7ca` (`packages/core/src/detect/scanners.ts:20-33`):

```ts
export const classifyInstallMethod = (absPath: string): InstallMethod => {
  // `absPath` is the resolved target. Order matters:
  // 1. Homebrew's Cellar and Caskroom are Homebrew-owned, even when a formula is itself a
  //    node package (Cellar/<formula>/<ver>/libexec/lib/node_modules/...).
  // 2. Any other lib/node_modules target is an npm global (Homebrew's or a version
  //    manager's node), checked before the generic /opt/homebrew and /usr/local brew rule.
  if (/^(\/opt\/homebrew|\/usr\/local)\/(Cellar|Caskroom)\//u.test(absPath)) return 'brew';
  if (absPath.includes('/lib/node_modules/')) return 'npm-global';
  if (absPath.startsWith('/opt/homebrew/') || absPath.startsWith('/usr/local/')) return 'brew';
  if (absPath.includes('/.bun/install/global/')) return 'bun-global';
  if (absPath.includes('/.npm/') || absPath.includes('node_modules/.bin/')) return 'npm-global';
  if (absPath.includes('.app/Contents/')) return 'app-bundle';
  return 'unknown';
};
```

Trace for the two reported paths, rule by rule:

| Resolved path | `:26` guard | `:27` node_modules | `:28` generic | Result today | Correct |
|---|---|---|---|---|---|
| `/home/linuxbrew/.linuxbrew/Cellar/codex/0.5.0/bin/codex` | no | no | no | `unknown` | `brew` |
| `/home/linuxbrew/.linuxbrew/Cellar/<f>/<v>/libexec/lib/node_modules/...` | no | **yes** | - | `npm-global` | `brew` |
| `/home/linuxbrew/.linuxbrew/bin/codex` (link path, `realpath` failed) | no | no | no | `unknown` | `brew` |
| `/home/linuxbrew/.linuxbrew/lib/node_modules/@openai/codex/bin/codex.js` | no | **yes** | - | `npm-global` | `npm-global` (unchanged) |

The root cause is structural: the guard and the generic rule each carry their own copy of the prefix list, so the lists drift. #125 added the guard with the two macOS prefixes it was scoped to and the Linux prefix was missed in both places.

### 1.2 Every hardcoded Homebrew prefix in `packages/*/src`

`grep -rn -E '/opt/homebrew|/usr/local|linuxbrew|HOMEBREW' packages/*/src --include='*.ts'` finds exactly four lines, all in one file:

| Location | Text | Role |
|---|---|---|
| `packages/core/src/detect/scanners.ts:11` | `'/opt/homebrew/bin',` | `wellKnownBinDirs` detection fallback |
| `packages/core/src/detect/scanners.ts:12` | `'/usr/local/bin',` | `wellKnownBinDirs` detection fallback |
| `packages/core/src/detect/scanners.ts:25` | comment: `generic /opt/homebrew and /usr/local brew rule` | documents rule order |
| `packages/core/src/detect/scanners.ts:26` and `:28` | regex guard; `startsWith` chain | classification |

No other package (`packages/cli/src`) hardcodes a Homebrew prefix. Docs that mention `/opt/homebrew` (`docs/codex-deep-verifier-diagnosis.md`) are captured diagnostic output, not rules, and need no change. `docs/architecture.md:284` names `classifyInstallMethod` and its labels generically and needs no change.

### 1.3 Which prefixes Homebrew documents

Evidence gathered on 2026-10-02 from docs.brew.sh and the Homebrew repositories:

| Source | Statement | Prefix |
|---|---|---|
| [docs.brew.sh/Installation](https://docs.brew.sh/Installation) | "The script installs Homebrew to its default prefix (`/opt/homebrew` for Apple Silicon and `/home/linuxbrew/.linuxbrew` for Linux)" | `/opt/homebrew`, `/home/linuxbrew/.linuxbrew` |
| [docs.brew.sh/Installation](https://docs.brew.sh/Installation) | "The macOS `.pkg` installer supports only Apple Silicon and also installs Homebrew to its default prefix (`/opt/homebrew`)" | `/opt/homebrew` |
| [docs.brew.sh/Homebrew-on-Linux](https://docs.brew.sh/Homebrew-on-Linux) | "The installation script installs Homebrew to `/home/linuxbrew/.linuxbrew`, which allows the use of most binary packages (bottles)." | `/home/linuxbrew/.linuxbrew` |
| [docs.brew.sh/Support-Tiers#custom-prefixes](https://docs.brew.sh/Support-Tiers#custom-prefixes) | "Apple Silicon macOS: `/opt/homebrew` (13 bytes)"; "Intel macOS: `/usr/local` (10 bytes)"; "Linux: `/home/linuxbrew/.linuxbrew` (26 bytes); `/opt/homebrew` fits, but `/home/linuxbrew/.linuxbrew-extra` is too long." | all three defaults named; `/usr/local` is the Intel macOS default |
| `Homebrew/install` `install.sh` lines 175 and 198 | `HOMEBREW_PREFIX_DEFAULT="/opt/homebrew"` (macOS); `HOMEBREW_PREFIX_DEFAULT="/home/linuxbrew/.linuxbrew"` (Linux) | confirms the two script defaults |
| `Homebrew/brew` `bin/brew` lines 98-105 | falls back to `HOMEBREW_PREFIX="/usr/local"` when `/usr/local/bin/brew` is a symlink | confirms `/usr/local` as the legacy Intel macOS prefix |

Two things the documentation does **not** say, which decide the scope:

- No current Homebrew document or the install script mentions `~/.linuxbrew`. A grep of `install.sh`, `Homebrew-on-Linux.md`, `Installation.md` and `Support-Tiers.md` for `~/.linuxbrew` returns nothing. The old "falls back to `~/.linuxbrew` without sudo" behavior is gone; the script now requires a writable prefix or `--path`.
- Custom prefixes exist and are Tier 1 ("Custom prefixes can also use bottles"; Support-Tiers: "these installations qualify for Tier 1 when all other Tier 1 requirements are met ... This support is new and may not yet be fully stable"), but they are set by `--path` or `HOMEBREW_PREFIX` and cannot be recognized from a path alone. Honoring them would need the process environment, and `DetectionPorts` (`packages/core/src/ports/types.ts:14-16`) exposes only `homeDir`, `executableSearchPath` and `platform`; adding an environment port is a new feature, not this bug fix.

**Decision:** support exactly Homebrew's three documented default prefixes: `/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`. Custom prefixes, including `~/.linuxbrew` and `/opt/brew`, are out of scope (section 5).

### 1.4 `wellKnownBinDirs`: no Linuxbrew fallback in this plan

`wellKnownBinDirs` (`packages/core/src/detect/scanners.ts:5-18`) lists `$PATH` first and then fixed fallbacks. Its comment at `:7-8` gives the fallbacks' purpose: "the fixed Homebrew dirs are fallbacks for GUI/launchd contexts with a minimal $PATH", a macOS concern (launchd does not read the user's shell rc files).

Adding `/home/linuxbrew/.linuxbrew/bin` there is **out of scope for #127**, for three reasons:

1. #127 is a classification defect, filed from a review comment on the classifier guard at `scanners.ts:26`. Detection (which binaries are found) is a different function with different consequences.
2. A new fallback changes `skillsmith agents` and `doctor` results for every Linux host with Linuxbrew present but not on `$PATH`: a second install surfaces, and `doctor`'s multi-install check (`packages/core/src/doctor/checks/multi-install.ts:21`) starts warning. That is a behavior change to review on its own merits, with its own tests in the `wellKnownBinDirs` describe block.
3. Homebrew on Linux is only usable after `eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"` puts its `bin` on `$PATH` (Homebrew-on-Linux docs, "Next steps"), so the common case is already found through `env.executableSearchPath`.

Consequence for this plan: the detect-level tests in Task 2 put `/home/linuxbrew/.linuxbrew/bin` on the fake `$PATH` explicitly. Recommendation: file a follow-up issue "Add `/home/linuxbrew/.linuxbrew/bin` to `wellKnownBinDirs` on Linux" and decide it separately (section 5).

### 1.5 Readers of `installMethod` (what users see)

| Reader | File | Effect of this fix |
|---|---|---|
| `skillsmith agents` table | `packages/cli/src/output/agents-markdown.ts:62` | the `installMethod` column |
| `skillsmith agents --json` (`v1`, `v2`) | `packages/core/src/contracts/v1/agents.ts:76`, `packages/core/src/contracts/v2/agents.ts:115` | the `installMethod` field; enum unchanged |
| `doctor` multi-install warning | `packages/core/src/doctor/checks/multi-install.ts:21` | message text `<path> (<installMethod>)` |
| sort order | `packages/cli/src/output/agents-markdown.ts:37`, `packages/core/src/application/read-services.ts:922` | records compare by `installMethod` text; a relabel can reorder rows on Linuxbrew hosts |

## 2. Design options and recommendation

**Option A: add the third literal to both existing lines.** Extend the regex at `:26` to `/^(\/opt\/homebrew|\/usr\/local|\/home\/linuxbrew\/\.linuxbrew)\/(Cellar|Caskroom)\//u` (note the escaped dot in `\.linuxbrew`) and add `absPath.startsWith('/home/linuxbrew/.linuxbrew/')` to the chain at `:28`. Smallest textual diff. Keeps two prefix lists that must be edited together, which is exactly how #127 happened; Biome wraps the 100-plus-character regex line.

**Option B (recommended): one prefix list, consulted once.** A module-level `homebrewPrefixes` array of the three documented defaults; `classifyInstallMethod` finds the matching prefix once and uses it for both the `Cellar`/`Caskroom` guard and the generic rule. One list, no regex, rule order unchanged, the comment cites the documentation. About 15 changed lines. This is the plan's design; exact code in Task 3.

**Option C: platform-aware or environment-driven prefixes.** Branch on `env.platform`, or read `HOMEBREW_PREFIX`. Rejected: `classifyInstallMethod` takes only a path, by design; `DetectionPorts` has no environment port; and the same path has the same meaning on any platform. Larger change for no behavior the issue asks for.

**Recommendation: Option B.** It fixes the reported paths and removes the drift that caused the bug, with a diff a reviewer reads in one screen.

## 3. Tasks

Tasks 1 and 2 write failing tests and deliberately do not commit; Task 3 makes them pass and commits tests and fix together, the same shape as PR #125. Task 4 verifies as the hooks will.

### Task 1: Pin the classifier for the Linuxbrew prefix (tests, red)

**Files:**
- Modify: `packages/core/tests/detect/scanners.test.ts:71-78` (append a nested `describe` inside `describe('classifyInstallMethod')`, after the mise-style test and before the closing `});` at line 78)

**Interfaces:**
- Consumes: `classifyInstallMethod(absPath: string): InstallMethod` from `packages/core/src/detect/scanners.ts` (already imported at line 2).
- Produces: seven test cases Task 3 must turn green without editing them.

- [ ] **Step 1: Add the Linuxbrew describe block**

Insert after line 77 (`).toBe('npm-global');` / `});` of the mise-style test), inside the `classifyInstallMethod` describe:

```ts
  describe('Linuxbrew default prefix (/home/linuxbrew/.linuxbrew)', () => {
    test("classifies a native Linuxbrew Cellar binary as 'brew'", () => {
      expect(classifyInstallMethod('/home/linuxbrew/.linuxbrew/Cellar/codex/0.5.0/bin/codex')).toBe(
        'brew',
      );
    });
    test("classifies a node-based Linuxbrew formula (Cellar/.../libexec/lib/node_modules) as 'brew'", () => {
      expect(
        classifyInstallMethod(
          '/home/linuxbrew/.linuxbrew/Cellar/typescript-language-server/6.0.0/libexec/lib/node_modules/typescript-language-server/lib/cli.mjs',
        ),
      ).toBe('brew');
    });
    test("classifies the Linuxbrew bin link path as 'brew' (the realpath-fallback case)", () => {
      expect(classifyInstallMethod('/home/linuxbrew/.linuxbrew/bin/codex')).toBe('brew');
    });
    test("classifies an npm global under Linuxbrew's node (lib/node_modules) as 'npm-global'", () => {
      expect(
        classifyInstallMethod(
          '/home/linuxbrew/.linuxbrew/lib/node_modules/@openai/codex/bin/codex.js',
        ),
      ).toBe('npm-global');
    });
    test("leaves a sibling directory of the Linuxbrew prefix as 'unknown'", () => {
      expect(classifyInstallMethod('/home/linuxbrew/.linuxbrew-extra/bin/codex')).toBe('unknown');
    });
    test("leaves a non-Homebrew path under /home/linuxbrew as 'unknown'", () => {
      expect(classifyInstallMethod('/home/linuxbrew/.local/bin/claude')).toBe('unknown');
    });
    test("leaves an ordinary /home path as 'unknown'", () => {
      expect(classifyInstallMethod('/home/user/.local/bin/claude')).toBe('unknown');
    });
  });
```

The code above is already in Biome's output format (checked on 2026-10-02); the line-wrapped `expect(` in the fourth test is deliberate.

- [ ] **Step 2: Run the file and confirm exactly three new failures**

Run, from the worktree root:

```bash
bun test ./packages/core/tests/detect/scanners.test.ts
```

Expected (tail of output):

```text
(fail) classifyInstallMethod > Linuxbrew default prefix (/home/linuxbrew/.linuxbrew) > classifies a native Linuxbrew Cellar binary as 'brew'
    Expected: "brew"  Received: "unknown"
(fail) classifyInstallMethod > Linuxbrew default prefix (/home/linuxbrew/.linuxbrew) > classifies a node-based Linuxbrew formula (Cellar/.../libexec/lib/node_modules) as 'brew'
    Expected: "brew"  Received: "npm-global"
(fail) classifyInstallMethod > Linuxbrew default prefix (/home/linuxbrew/.linuxbrew) > classifies the Linuxbrew bin link path as 'brew' (the realpath-fallback case)
    Expected: "brew"  Received: "unknown"

 20 pass
 3 fail
Ran 23 tests across 1 file.
```

The four other new tests (`npm-global` under Linuxbrew's node, the `.linuxbrew-extra` sibling, `/home/linuxbrew/.local`, `/home/user/.local`) pass before and after the fix; they pin behavior that must not change. If any of them fails here, the test text was copied wrongly: fix the test, not the source.

Do not commit yet.

### Task 2: Pin the detect-level Linux path through `createBinaryDetect` (tests, red)

**Files:**
- Modify: `packages/core/tests/agents/codex.test.ts:75-76` (insert two tests before `test('falls back to classifying the link path when realpath throws', ...)` at line 76)

**Interfaces:**
- Consumes: `codexAgent.detect(env: DetectionPorts)` from `packages/core/src/agents/codex/index.ts`; the file's `env(existing: string[])` helper (`codex.test.ts:5-20`), which hardcodes `homeDir: '/Users/u'`, `executableSearchPath: ['/usr/bin']`, `platform: 'darwin'`, `runVersion` returning `'0.5.1'`.
- Produces: two detect-level cases that exercise `detect-factory.ts:21-30` (`realpath` then `classifyInstallMethod`) with Linux-shaped ports.

- [ ] **Step 1: Add two Linux detect cases**

Insert before line 76 (`test('falls back to classifying the link path when realpath throws', async () => {`):

```ts
  test('classifies by the resolved realpath on Linux: a native Linuxbrew formula symlinked under /home/linuxbrew/.linuxbrew/bin reports brew instead of unknown', async () => {
    const r = await codexAgent.detect({
      ...env(['/home/linuxbrew/.linuxbrew/bin/codex']),
      homeDir: '/home/u',
      platform: 'linux',
      executableSearchPath: ['/home/linuxbrew/.linuxbrew/bin'],
      realpath: async () => '/home/linuxbrew/.linuxbrew/Cellar/codex/0.5.0/bin/codex',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({
        path: '/home/linuxbrew/.linuxbrew/bin/codex',
        version: '0.5.1',
        installMethod: 'brew',
      });
    }
  });

  test('classifies by the resolved realpath on Linux: a node-based Linuxbrew formula (Cellar/.../libexec/lib/node_modules) reports brew instead of npm-global', async () => {
    const r = await codexAgent.detect({
      ...env(['/home/linuxbrew/.linuxbrew/bin/codex']),
      homeDir: '/home/u',
      platform: 'linux',
      executableSearchPath: ['/home/linuxbrew/.linuxbrew/bin'],
      realpath: async () =>
        '/home/linuxbrew/.linuxbrew/Cellar/codex/0.5.0/libexec/lib/node_modules/@openai/codex/bin/codex.js',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({
        path: '/home/linuxbrew/.linuxbrew/bin/codex',
        version: '0.5.1',
        installMethod: 'brew',
      });
    }
  });

```

Why the three overrides: `wellKnownBinDirs` puts `env.executableSearchPath` first and has no Linux fallback (section 1.4), so without `executableSearchPath: ['/home/linuxbrew/.linuxbrew/bin']` the binary is never found and `r.value` is empty. `platform: 'linux'` and `homeDir: '/home/u'` make the fixture honest about the host it models; neither affects the result today.

- [ ] **Step 2: Run the file and confirm exactly two new failures**

```bash
bun test ./packages/core/tests/agents/codex.test.ts
```

Expected (tail of output):

```text
(fail) codexAgent > classifies by the resolved realpath on Linux: a native Linuxbrew formula symlinked under /home/linuxbrew/.linuxbrew/bin reports brew instead of unknown
    -   "installMethod": "brew",
    +   "installMethod": "unknown",
(fail) codexAgent > classifies by the resolved realpath on Linux: a node-based Linuxbrew formula (Cellar/.../libexec/lib/node_modules) reports brew instead of npm-global
    -   "installMethod": "brew",
    +   "installMethod": "npm-global",

 6 pass
 2 fail
Ran 8 tests across 1 file.
```

If a failure instead shows `r.value[0]` as `undefined`, the `executableSearchPath` override is missing. Do not commit yet.

### Task 3: Make the classifier recognize Homebrew's three default prefixes (green, commit)

**Files:**
- Modify: `packages/core/src/detect/scanners.ts:20-28`
- Test: `packages/core/tests/detect/scanners.test.ts`, `packages/core/tests/agents/codex.test.ts` (from Tasks 1 and 2)

**Interfaces:**
- Produces: `classifyInstallMethod(absPath: string): InstallMethod`, signature and export unchanged; a module-private `const homebrewPrefixes: string[]` (not exported).

- [ ] **Step 1: Replace lines 20-28 of `scanners.ts`**

Replace this block (lines 20-28 on `af7e7ca`):

```ts
export const classifyInstallMethod = (absPath: string): InstallMethod => {
  // `absPath` is the resolved target. Order matters:
  // 1. Homebrew's Cellar and Caskroom are Homebrew-owned, even when a formula is itself a
  //    node package (Cellar/<formula>/<ver>/libexec/lib/node_modules/...).
  // 2. Any other lib/node_modules target is an npm global (Homebrew's or a version
  //    manager's node), checked before the generic /opt/homebrew and /usr/local brew rule.
  if (/^(\/opt\/homebrew|\/usr\/local)\/(Cellar|Caskroom)\//u.test(absPath)) return 'brew';
  if (absPath.includes('/lib/node_modules/')) return 'npm-global';
  if (absPath.startsWith('/opt/homebrew/') || absPath.startsWith('/usr/local/')) return 'brew';
```

with:

```ts
// Homebrew's documented default prefixes: Apple Silicon macOS, Intel macOS, Linux
// (https://docs.brew.sh/Installation, https://docs.brew.sh/Support-Tiers#custom-prefixes).
// A custom prefix (`--path` / `HOMEBREW_PREFIX`) is not recognisable from a path alone.
const homebrewPrefixes = ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'];

export const classifyInstallMethod = (absPath: string): InstallMethod => {
  // `absPath` is the resolved target. Order matters:
  // 1. Homebrew's Cellar and Caskroom are Homebrew-owned, even when a formula is itself a
  //    node package (Cellar/<formula>/<ver>/libexec/lib/node_modules/...).
  // 2. Any other lib/node_modules target is an npm global (Homebrew's or a version
  //    manager's node), checked before the generic Homebrew-prefix brew rule.
  const brewPrefix = homebrewPrefixes.find((prefix) => absPath.startsWith(`${prefix}/`));
  if (brewPrefix !== undefined) {
    const rest = absPath.slice(brewPrefix.length);
    if (rest.startsWith('/Cellar/') || rest.startsWith('/Caskroom/')) return 'brew';
  }
  if (absPath.includes('/lib/node_modules/')) return 'npm-global';
  if (brewPrefix !== undefined) return 'brew';
```

Lines 29-33 (`bun-global`, the `.npm`/`node_modules/.bin` rule, `app-bundle`, `unknown`) stay as they are. The `${prefix}/` in `startsWith` is what keeps `/home/linuxbrew/.linuxbrew-extra/...` unmatched (Review Focus item 1). `Caskroom` under the Linux prefix never occurs (Homebrew Cask is macOS-only) and is harmless.

- [ ] **Step 2: Run both test files and confirm all green**

```bash
bun test ./packages/core/tests/detect/scanners.test.ts ./packages/core/tests/agents/codex.test.ts
```

Expected:

```text
 31 pass
 0 fail
Ran 31 tests across 2 files.
```

- [ ] **Step 3: Format and lint the three changed files as the pre-commit hook will**

```bash
bunx @biomejs/biome check --write packages/core/src/detect/scanners.ts packages/core/tests/detect/scanners.test.ts packages/core/tests/agents/codex.test.ts
bunx @biomejs/biome check packages/core/src/detect/scanners.ts packages/core/tests/detect/scanners.test.ts packages/core/tests/agents/codex.test.ts
bunx eslint --no-warn-ignored packages/core/src/detect/scanners.ts packages/core/tests/detect/scanners.test.ts packages/core/tests/agents/codex.test.ts
```

Expected: the second Biome command prints `Checked 3 files in <N>ms. No fixes applied.`; ESLint prints nothing and exits 0. If the first command changed anything, re-run Step 2.

- [ ] **Step 4: Commit tests and fix together**

```bash
git add packages/core/src/detect/scanners.ts packages/core/tests/detect/scanners.test.ts packages/core/tests/agents/codex.test.ts
git commit -F - <<'EOF'
fix(core): classify Linuxbrew default-prefix installs as brew

classifyInstallMethod recognised Homebrew only under /opt/homebrew and
/usr/local. Homebrew's documented default Linux prefix,
/home/linuxbrew/.linuxbrew, was reported as unknown for native formulas
and, since #125, as npm-global for node-based formulas whose target
lives under Cellar/<formula>/<ver>/libexec/lib/node_modules.

Hold the three documented default prefixes in one list consulted once,
so the Cellar/Caskroom guard and the generic brew rule cannot drift
again. Rule order is unchanged: Cellar/Caskroom, then lib/node_modules
as npm-global, then any other Homebrew-prefix path as brew. Custom
prefixes (--path / HOMEBREW_PREFIX) stay out of scope.

Closes #127

Claude-Session: <this session's URL from its harness reminder>
EOF
git log -1 --stat
```

Expected: the `pre-commit` hook runs Biome, ESLint boundaries and gitleaks and prints no errors; the `commit-msg` hook (commitlint) accepts `fix(core)`; `git log -1 --stat` shows the new commit with the three files. If `git log -1` still shows `af7e7ca`, the commit did not land: read the hook output and fix what it flagged.

### Task 4: Verify as the pre-push hook will, then hand off

**Files:** none modified.

- [ ] **Step 1: Typecheck the repository**

```bash
bunx tsc --noEmit
```

Expected: no output, exit 0 (about 50 seconds on this Mac).

- [ ] **Step 2: Confirm the branch holds exactly this change**

```bash
git fetch origin
git diff --stat origin/main..HEAD
git log --oneline origin/main..HEAD
```

Expected: four files in the stat, this plan file plus `packages/core/src/detect/scanners.ts` (15 lines), `packages/core/tests/agents/codex.test.ts` (37 lines) and `packages/core/tests/detect/scanners.test.ts` (34 lines), which is `83 insertions(+), 3 deletions(-)` in `packages/core`; and two commits above `origin/main`: the `docs:` plan commit and one `fix(core)` commit.

- [ ] **Step 3: Hand off**

Report the commit SHA, the `31 pass` line from Task 3 Step 2, and the before/after table from section 4. Pushing and opening the PR follow the repo's normal flow: push with hooks enabled (the `pre-push` serial gate takes about 30 minutes; run it in the background), PR title `fix(core): classify Linuxbrew default-prefix installs as brew`, PR body with the section 4 table. Do not use `--no-verify`.

## 4. User-visible output change

Only hosts whose agent binaries resolve under `/home/linuxbrew/.linuxbrew` are affected; macOS output is byte-identical. The `installMethod` enum is unchanged, so `skillsmith agents --json` consumers see a different value in an existing field, never a new value.

| Resolved target | Before | After |
|---|---|---|
| `/home/linuxbrew/.linuxbrew/Cellar/<formula>/<ver>/bin/<bin>` (native formula) | `unknown` | `brew` |
| `/home/linuxbrew/.linuxbrew/Cellar/<formula>/<ver>/libexec/lib/node_modules/...` (node-based formula) | `npm-global` | `brew` |
| `/home/linuxbrew/.linuxbrew/bin/<bin>` (link path, `realpath` failed) | `unknown` | `brew` |
| `/home/linuxbrew/.linuxbrew/lib/node_modules/<pkg>/...` (npm global via Linuxbrew node) | `npm-global` | `npm-global` |
| any `/opt/homebrew/...` or `/usr/local/...` path | as today | unchanged |

Surfaces: the `skillsmith agents` table and `--json` (`v1`, `v2`), and `doctor`'s multi-install message. Because `agents` sorts records by `installMethod` text, row order can change on an affected host.

## 5. Risks and open questions

- **`/usr/local` is platform-blind.** On Linux, `/usr/local/bin/<bin>` is a generic system prefix, yet the generic rule labels it `brew` (pre-existing; the test at `scanners.test.ts:41` even says "on mac paths"). This plan does not change it; fixing it needs `env.platform` in the classifier and is a separate decision.
- **Custom prefixes are not recognized.** `--path` or `HOMEBREW_PREFIX` installs (Tier 1 per Support-Tiers, "may not yet be fully stable") still classify as `unknown` or `npm-global`. Needs an environment port on `DetectionPorts`. Out of scope; file an issue if a user reports it.
- **`wellKnownBinDirs` Linux fallback.** Out of scope here (section 1.4). Open question for the owner: file a follow-up issue to add `/home/linuxbrew/.linuxbrew/bin` as a detection fallback on Linux, with the multi-install consequence weighed.
- **PROJECTS.md.** PR #125 shipped without a `P##` entry; `PROJECTS.md` mentions Homebrew only under P14 (publishing). Open question for the owner: should #127 be tracked as a task on an existing project, or stay issue-only like #125? This plan edits no tracking files.
- **Sort-order change** in `agents` output on Linuxbrew hosts (section 4). Cosmetic; no consumer is known to depend on row order.

## 6. Out of scope

- Recognizing `~/.linuxbrew`, `/opt/brew` or any other custom prefix.
- Changing `wellKnownBinDirs`.
- Platform-aware treatment of `/usr/local`.
- Any change to `InstallMethod`, the `v1`/`v2` contracts, CLI output formats, `CHANGELOG.md` or docs.
