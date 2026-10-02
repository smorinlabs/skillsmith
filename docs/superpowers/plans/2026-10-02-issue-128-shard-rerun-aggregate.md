# Shard Re-run Aggregate (#128) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub's **Re-run failed jobs** (and a single-job re-run) pass the `Test shard aggregate` job by letting the aggregate see the latest evidence of all four test shards from whichever run attempt produced each.

**Architecture:** Shard artifacts drop `github.run_attempt` from their names and upload with `overwrite: true`, so a re-run shard replaces only its own earlier artifact; the aggregate downloads `test-shard-*-<run_id>` and keeps every existing fail-closed check unchanged. `scripts/aggregate-shard-receipts.ts` additionally recognizes the flat layout `actions/download-artifact` produces for a lone match, so a missing-shard situation is reported as "expected 4 shard evidence sets; found 1" instead of a layout error. A contract test pins the artifact naming in `ci.yml`.

**Tech Stack:** GitHub Actions (`actions/upload-artifact` v7.0.1, `actions/download-artifact` v8.0.1, both pinned by SHA), Bun 1.4.2 (`bun test`, `Bun.YAML`, `Bun.Glob`), TypeScript, lefthook + commitlint.

**Spec:** GitHub issue [smorinlabs/skillsmith#128](https://github.com/smorinlabs/skillsmith/issues/128) ("ci: 'Re-run failed jobs' cannot pass the test-shard aggregate"). There is no separate spec document; the Investigation section below is the evidence base the tasks argue from.

## Global Constraints

- Work only in the worktree `/Users/stevemorin/c/skillsmith-fix-128-shard-rerun` (branch `fix/shard-rerun-aggregate`, based on `origin/main` `af7e7ca`). Do not switch or create branches, run `git config`, push, or open PRs; the orchestrator does that.
- Never run the full serial gate (`bun scripts/run-test-files-serial.ts`) or `bun run check` here. Focused runs (`bun test ./<file>`, `bunx tsc --noEmit`, `bunx biome check <files>`, `actionlint <file>`) are fine.
- Bun version is 1.4.2 (`.github/workflows/ci.yml:26`); the test runner is `bun test`.
- Commit messages follow Conventional Commits. `commitlint.config.js` restricts scopes to `cli`, `core`, `main` (reserved), `release`; scripts, workflows and docs use **no scope**. Header max 100 characters.
- Every commit ends with the line `Claude-Session: https://claude.ai/code/session_01W2JybNuX5mCXWJWvApZHAt` (pass it as a second `-m` so commitlint sees a blank line before the footer).
- lefthook `pre-commit` runs Biome on staged `.ts/.json`, `actionlint` on staged workflows, and `./scripts/check-gitleaks.sh staged`; `commit-msg` runs commitlint. Fix anything they flag; do not bypass hooks.
- Keep the pinned action SHAs unchanged: `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (tag `v7.0.1`) and `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` (tag `v8.0.1`).
- Keep these strings in `ci.yml` exactly, because `tests/ergonomics/phase/EWP-P6-TS06.test.ts:288-289,327-333,340-341` asserts them: the step names `Retain shard evidence`, `Download shard evidence`, `Validate shard union`; the commands `bun scripts/run-test-files-shard.ts --shard-index=${{ matrix.shard }} --shard-total=4 --out-dir="$RUNNER_TEMP/test-shard-${{ matrix.shard }}"` and `bun scripts/aggregate-shard-receipts.ts --receipts="$RUNNER_TEMP/shard-evidence" --shard-total=4`, each exactly once.
- Do not change `SHARD_RECEIPT_SCHEMA_VERSION` (3), `SHARD_RUNNER`, or `RECEIPT_KEYS` (`scripts/run-test-files-shard.ts:46-47`, `scripts/aggregate-shard-receipts.ts:85-101`). No new test files: adding a file changes the test manifest and `scripts/test-shard-weights.json`.
- Scope is #128 only. No other CI refactors (see Out of Scope).

## Review Focus

Input classes the issue implies but no existing test exercises, most likely to bite first. Each is pinned to a test in the task that owns the code.

1. **Exactly one artifact matches the download pattern** (three shards' evidence missing or expired): `actions/download-artifact` extracts it flat into `path` (`src/download-artifact.ts:189-194`, `artifacts.length === 1`). A reader expects the aggregate to say three shards are missing, not `unexpected non-directory evidence entry shard-receipt.json`. → Task 2, test "a flat single shard fails the aggregate for the missing shards, not the layout".
2. **The re-run shard fails again**: its `status: "failed"` receipt (`scripts/run-test-files-shard.ts:290-294`) overwrites the earlier one. The aggregate must still fail: the `Require every shard to succeed` step (`ci.yml:371-378`) fails first, and `parseShardReceipt` rejects any status other than `passed` (`scripts/aggregate-shard-receipts.ts:136-137`). → Already pinned by `scripts/run-test-files-shard.test.ts:357-377` ("parseShardReceipt rejects malformed receipts", the `status` case); Task 1's contract test keeps the `Require every shard to succeed` ordering by asserting step names exist in order.
3. **A stale same-named artifact survives** because upload-artifact's `overwrite` delete is best-effort (`src/upload/upload-artifact.ts:11-23`: non-NotFound errors log at debug and continue). Then the upload hits the server's name-uniqueness check and the shard job fails visibly at `Retain shard evidence`; the aggregate never runs. Not unit-testable locally. → Task 4 Step 6 (the deleted-ID / new-ID match in the re-run shard log), confirmed by the aggregate's `ID: <NEW_ID>` line in Step 7, is the pin.
4. **Someone adds `merge-multiple: true` or renames a step**: four `shard-receipt.json` files would collapse into one directory, or EWP-P6-TS06 would break. → Task 1 contract test asserts `merge-multiple` is absent and the three step names exist.
5. **The matrix grows (5 shards) without `--shard-total` following**: the aggregate would fail on count (`scripts/aggregate-shard-receipts.ts:184-186`), but late. → Task 1 contract test asserts the matrix is `[1, 2, 3, 4]` and the validate command says `--shard-total=4`.

---

## Investigation (evidence, file:line)

### How shards name, upload and retain artifacts

- Matrix: `.github/workflows/ci.yml:245-248` (`shard: [1, 2, 3, 4]`, `fail-fast: false`).
- Shard run: `ci.yml:349-350` writes evidence to `$RUNNER_TEMP/test-shard-<n>` via `--out-dir`.
- Upload: `ci.yml:351-357`, step `Retain shard evidence`, `if: ${{ !cancelled() }}`, `actions/upload-artifact@043fb46d…` with `name: test-shard-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}`, `if-no-files-found: error`, `path: ${{ runner.temp }}/test-shard-${{ matrix.shard }}/`. No `overwrite` input today (defaults to `false`).
- Receipt content (`scripts/run-test-files-shard.ts:211-226`): `schemaVersion` (3), `runner` (`skillsmith-test-shard`), `status`, `shardIndex`, `shardTotal`, `manifestSha256`, `manifestSize`, `assigned`, `files[]` (`file`, `junitFile`, `exitCode`, `tests`, `skipped`, `assertions`, `durationMs`), `executed`, `passed`, `skipped`, `tests`, `assertions`, `durationMs`. **No head SHA, run id, or attempt number.** The receipt is written on failure too, with `status: "failed"` (`:290-294`). JUnit XML goes to `<out-dir>/junit/junit-NNNN.xml`.
- Other artifacts that carry `run_attempt`: `ordinary-agent-tools-…` (`ci.yml:217`) and `agent-environments-…` (`ci.yml:563`). Nothing downloads them; they are out of scope.

### How the aggregate downloads and validates

- Job `test-shard-aggregate` (`ci.yml:362-391`): `needs: [test-shard]`, `if: ${{ !cancelled() }}`; step `Require every shard to succeed` (`:371-378`) exits 1 unless `needs.test-shard.result == success`; step `Download shard evidence` (`:385-389`) uses `actions/download-artifact@3e5f45b2…` with `pattern: test-shard-*-${{ github.run_id }}-${{ github.run_attempt }}` into `${{ runner.temp }}/shard-evidence`; step `Validate shard union` (`:390-391`) runs `bun scripts/aggregate-shard-receipts.ts --receipts="$RUNNER_TEMP/shard-evidence" --shard-total=4`.
- `readShardEvidence` (`scripts/aggregate-shard-receipts.ts:335-364`): fails on **any non-directory entry** at the root (`:337-338`, the message seen in the issue), then requires `<dir>/shard-receipt.json` and `<dir>/junit/` per subdirectory and reads every JUnit file. The directory name becomes `label`, used for diagnostics only (`:53-54`).
- `aggregateShardEvidence` (`:173-329`) fails closed on: evidence count ≠ `shardTotal` (`:184-186`); receipt `shardTotal` mismatch, index out of range, duplicate index (`:194-204`); manifest digest/size ≠ the aggregate's own discovery from its checkout (`:215-219`, this is what binds evidence to the commit's test manifest); foreign, duplicate, missing or out-of-order files (`:221-234`); assigned/executed/passed counts (`:235-243`); JUnit file naming, non-zero exit, missing JUnit, failures, receipt/JUnit disagreement, per-file skip allowlist, cross-shard duplicates, unreferenced JUnit (`:252-291`); per-shard totals (`:292-298`); union coverage and global skip total (`:312-317`). `parseShardReceipt` (`:128-171`) rejects unknown/missing keys, wrong schema or runner, and any `status` other than `passed`.
- Existing tests: `scripts/run-test-files-shard.test.ts:163-355` (aggregate cases), `:379-416` (`readShardEvidence`: round-trip; malformed JSON, missing receipt, stray root file → `/non-directory evidence entry/`), `:418-430` (a cross-file contract test reading the `justfile`, the precedent for Task 1's contract test). `tests/ergonomics/phase/EWP-P6-TS06.test.ts` checks only the two shard commands and step order of the shard prerequisites (`:170-190`), not artifact inputs. `scripts/check-ci-results.test.ts:14-18` parses `ci.yml` for the `ci-result` job only.
- `docs/ci.md:34-39` currently says "Use **Re-run all jobs**, not **Re-run failed jobs**" and that aggregation refuses to combine attempts. Task 3 rewrites it.

### Pinned action behavior (read at the pinned SHAs)

- `actions/upload-artifact@043fb46d…` is tag **v7.0.1** (the `# v4` comment on `ci.yml:215,353,561` is stale; `release.yml:169` says `# v7.0.1`). `action.yml:37-42`: `overwrite` — "If true, an artifact with a matching name will be deleted before a new one is uploaded. If false, the action will fail if an artifact for the given name already exists. Does not fail if the artifact does not exist." README: "Artifact names must be unique since each created artifact is idempotent"; "Overwriting an Artifact … this will give the Artifact a new ID, the previous one will no longer exist." Source `src/upload/upload-artifact.ts:68-70` calls `deleteArtifactIfExists` (`:11-23`), which swallows errors at debug level, so a failed delete surfaces later as an upload conflict. The toolkit logs `Artifact '<name>' (ID: <id>) deleted` (`@actions/artifact` `delete-artifact.ts:104`) and the upload logs `Artifact <name> has been successfully uploaded! Final size is <n> bytes. Artifact ID is <id>` (seen verbatim in job 108993325612, log lines 2465-2466).
- `actions/download-artifact@3e5f45b2…` is tag **v8.0.1**. `src/download-artifact.ts:149-153` lists with `latest: true`; `:157-163` filters by `pattern` with minimatch; `:185-198` extracts to `path` itself when `isSingleArtifactDownload || inputs.mergeMultiple || artifacts.length === 1`, otherwise to `path/<artifact.name>`. README (v5 notes): "Note: This change also applies to patterns that only match a single artifact." `action.yml` `merge-multiple`: "If true, the downloaded artifacts will be in the same directory specified by path" (it would collide four `shard-receipt.json`, so it is not an option).
- `@actions/artifact` `ListArtifactsOptions.latest` (`interfaces.ts:75-81`): "Filter the workflow run's artifacts to the latest by name. In the case of reruns, this can be useful to avoid duplicates." `filterLatest` (`list-artifacts.ts:176-187`) sorts by id descending and keeps the first per name. This is defense in depth, not the mechanism the design relies on.
- GitHub docs: a re-run "will also use the same `GITHUB_SHA` (commit SHA) and `GITHUB_REF`". REST: `POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun` "Re-run a job and its dependent jobs in a workflow run" (201); `POST …/actions/runs/{run_id}/rerun-failed-jobs` "Re-run all of the failed jobs and their dependent jobs" (201); `GET …/runs/{run_id}/jobs?filter=latest|all`.

### What the failing run actually saw (run 36439943396, PR #124, head `9af786c`)

| Attempt | Kind | Aggregate job | Log evidence |
|---|---|---|---|
| 1 | initial | 108992541605 | shard 2 failed; aggregate stopped at `Require every shard to succeed` |
| 2 | Re-run failed jobs | 108997874715 | `Found 8 artifact(s)` (attempt 1's 7 + the re-run shard), `Filtering artifacts by pattern 'test-shard-*-36439943396-2'`, one match `test-shard-2-36439943396-2 (ID: 10979412840)`, `Total of 1 artifact(s) downloaded`, then `unexpected non-directory evidence entry shard-receipt.json` |
| 3 | Re-run all jobs | 109003219009 | `Found 7 artifact(s)`, four `test-shard-*-36439943396-3` downloaded, success |

Two conclusions, labeled by strength:

- **Proven:** in a failed-jobs re-run, `download-artifact` sees the previous attempt's artifacts (8 = 7 + 1). The previous shards' evidence is there; only the attempt-suffixed names hid it.
- **Observed, unexplained:** the full re-run (attempt 3) saw only its own 7, and the REST API now lists only attempt-3 artifacts (`GET …/runs/36439943396/artifacts` → `total_count: 7`; repo-level `?name=test-shard-1-36439943396-1` → 0). Whether a full re-run deletes or merely hides earlier artifacts does not affect the chosen design, because a full re-run re-uploads all four shards. It does mean the remote verification must read **job logs**, not REST artifact listings.

## Design options

| Option | Change | "Re-run failed jobs" outcome | Cost / risk | Verdict |
|---|---|---|---|---|
| **A. Attempt-less names + overwrite** | Upload `name: test-shard-${{ matrix.shard }}-${{ github.run_id }}` with `overwrite: true`; download `pattern: test-shard-*-${{ github.run_id }}` | The re-run shard deletes its own earlier artifact and uploads a new one; the other three artifacts from the earlier attempt still match; the aggregate downloads four directories | Two-line workflow change; every content check in the aggregate unchanged; relies on `overwrite` deleting a prior-attempt artifact (documented in `action.yml`; verified remotely in Task 4). If that delete ever fails, the shard job fails visibly at upload — still fail-closed | **Recommended** |
| B. Keep attempt-suffixed names, aggregate reconciles | Download `pattern: test-shard-*-${{ github.run_id }}-*`; teach the aggregate to parse `<index>-<run>-<attempt>` from directory names and keep the highest attempt per shard | Works, but the aggregate now receives failed-attempt receipts too and must pick among duplicates | Adds parsing and selection logic inside the fail-closed trust boundary; couples the script to the workflow's naming; the label is diagnostics-only today | Rejected |
| C. Document "Re-run all jobs" only | Keep `docs/ci.md:36` | Still fails; every flake costs a full ~12-minute re-run of all four shards | No code | Rejected: does not fix #128 |
| `merge-multiple: true` | Flatten all matches into `path` | Four `shard-receipt.json` collide | Breaks evidence | Not an option |

Why A preserves the fail-closed guarantees: the change only alters **which** artifacts the aggregate sees (the latest per shard within one run). Manifest coverage exactly once, skip totals, foreign/duplicate files, and manifest mismatch are all still enforced on content (`aggregate-shard-receipts.ts:184-317`). Commit binding needs no new receipt field: a run id belongs to one workflow run and every attempt of a run uses the same `GITHUB_SHA`, and the aggregate already fails when a receipt's manifest digest disagrees with its own checkout (`:215-219`). Adding a head-SHA field would bump the receipt schema for no new guarantee, so it is out of scope.

## File structure

- Modify `.github/workflows/ci.yml:351-357` (upload step inputs) and `:385-389` (download pattern). Step names and `uses:` lines unchanged.
- Modify `scripts/aggregate-shard-receipts.ts:22-23` (layout comment) and `:335-364` (`readShardEvidence`, plus a small `readOneShardEvidence` helper used by both layouts).
- Modify `scripts/run-test-files-shard.test.ts`: import `basename`; three tests in `describe('readShardEvidence')`; a new `describe('ci.yml shard evidence contract (#128)')` after `describe('justfile gate split')`.
- Modify `docs/ci.md:34-39` ("Rerunning CI").
- No new files. `scripts/test-shard-weights.json` untouched.

---

### Task 1: Pin the shard artifact contract in `ci.yml`, then change the names

**Files:**
- Test: `scripts/run-test-files-shard.test.ts` (append after `describe('justfile gate split')`, line 431)
- Modify: `.github/workflows/ci.yml:351-357`, `.github/workflows/ci.yml:385-389`

**Interfaces:**
- Consumes: `Bun.YAML.parse` (used the same way in `tests/ergonomics/phase/EWP-P6-TS06.test.ts:298`), `Bun.Glob`.
- Produces: the artifact name `test-shard-<shard>-<run_id>` and download pattern `test-shard-*-<run_id>` that Task 3's docs and Task 4's verification refer to.

- [ ] **Step 1: Write the failing contract test**

Append to `scripts/run-test-files-shard.test.ts` (after the `justfile gate split` describe block):

```ts
describe('ci.yml shard evidence contract (#128)', () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type Workflow = {
    jobs: Record<string, { steps?: Step[]; strategy?: { matrix?: { shard?: number[] } } }>;
  };
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'), 'utf8'),
  ) as Workflow;
  const step = (job: string, name: string): Step => {
    const found = workflow.jobs[job]?.steps?.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`${job} step ${name} is missing`);
    return found;
  };
  const upload = step('test-shard', 'Retain shard evidence');
  const download = step('test-shard-aggregate', 'Download shard evidence');
  const RUN_ID = '36439943396';
  // Render the workflow expressions before matching: Bun.Glob treats `{{ }}` as braces.
  const render = (value: unknown, shard: number): string =>
    String(value)
      .replaceAll('${{ matrix.shard }}', String(shard))
      .replaceAll('${{ github.run_id }}', RUN_ID);

  test('shard artifacts are named per shard and run, never per attempt, and re-runs overwrite', () => {
    expect(upload.uses?.startsWith('actions/upload-artifact@')).toBe(true);
    expect(upload.with?.name).toBe('test-shard-${{ matrix.shard }}-${{ github.run_id }}');
    expect(upload.with?.overwrite).toBe(true);
    expect(upload.with?.['if-no-files-found']).toBe('error');
    expect(download.uses?.startsWith('actions/download-artifact@')).toBe(true);
    expect(download.with?.pattern).toBe('test-shard-*-${{ github.run_id }}');
    expect(download.with?.['merge-multiple']).toBeUndefined();
    expect(download.with?.path).toBe('${{ runner.temp }}/shard-evidence');
    for (const value of [upload.with?.name, download.with?.pattern]) {
      expect(String(value)).not.toContain('run_attempt');
    }
  });

  test('every matrix shard name matches the aggregate download pattern once rendered', () => {
    const shards = workflow.jobs['test-shard']?.strategy?.matrix?.shard ?? [];
    expect(shards).toEqual([1, 2, 3, 4]);
    expect(step('test-shard-aggregate', 'Validate shard union').run).toBe(
      `bun scripts/aggregate-shard-receipts.ts --receipts="$RUNNER_TEMP/shard-evidence" --shard-total=${shards.length}`,
    );
    for (const shard of shards) {
      const name = render(upload.with?.name, shard);
      const pattern = render(download.with?.pattern, shard);
      expect(name).toBe(`test-shard-${shard}-${RUN_ID}`);
      expect(pattern).not.toContain('${{');
      expect(new Bun.Glob(pattern).match(name)).toBe(true);
      // An attempt-suffixed stale name must not satisfy the pattern.
      expect(new Bun.Glob(pattern).match(`${name}-2`)).toBe(false);
    }
  });

  test('the aggregate requires every shard to succeed before it downloads evidence', () => {
    const names = (workflow.jobs['test-shard-aggregate']?.steps ?? []).map((entry) => entry.name);
    const order = [
      'Require every shard to succeed',
      'Download shard evidence',
      'Validate shard union',
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
```

- [ ] **Step 2: Run the test file and confirm the new tests fail for the right reason**

Run: `cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun && bun test ./scripts/run-test-files-shard.test.ts`

Expected: 46 pass, 2 fail (the third new test passes already). The first failure reads:

```
Expected: "test-shard-${{ matrix.shard }}-${{ github.run_id }}"
Received: "test-shard-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}"
```

and the second fails on `expect(name).toBe(...)` with the `-${{ github.run_attempt }}` suffix still present.

- [ ] **Step 3: Change the upload step**

In `.github/workflows/ci.yml`, replace lines 351-357:

```yaml
      - name: Retain shard evidence
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v4
        with:
          name: test-shard-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}
          if-no-files-found: error
          path: ${{ runner.temp }}/test-shard-${{ matrix.shard }}/
```

with:

```yaml
      - name: Retain shard evidence
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v4
        with:
          # Named per shard and run, not per attempt, so "Re-run failed jobs"
          # replaces only the re-run shard's evidence (#128). overwrite deletes
          # the earlier attempt's same-named artifact before uploading.
          name: test-shard-${{ matrix.shard }}-${{ github.run_id }}
          overwrite: true
          if-no-files-found: error
          path: ${{ runner.temp }}/test-shard-${{ matrix.shard }}/
```

Leave the `uses:` line (including its stale `# v4` comment) untouched.

- [ ] **Step 4: Change the download step**

Replace lines 385-389:

```yaml
      - name: Download shard evidence
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          pattern: test-shard-*-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/shard-evidence
```

with:

```yaml
      - name: Download shard evidence
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          # The latest evidence of all four shards, from whichever attempt
          # produced each; every attempt of a run checks out the same GITHUB_SHA.
          pattern: test-shard-*-${{ github.run_id }}
          path: ${{ runner.temp }}/shard-evidence
```

- [ ] **Step 5: Run the contract test, the two other `ci.yml` consumers, and actionlint**

Run:

```bash
cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun
bun test ./scripts/run-test-files-shard.test.ts
bun test ./tests/ergonomics/phase/EWP-P6-TS06.test.ts
bun test ./scripts/check-ci-results.test.ts
actionlint .github/workflows/ci.yml
```

Expected: `48 pass, 0 fail`; `13 pass`; `66 pass`; `actionlint` prints nothing and exits 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun
git add .github/workflows/ci.yml scripts/run-test-files-shard.test.ts
git commit -m "ci: name shard evidence per run so re-run failed jobs can aggregate" \
  -m "Shard artifacts drop github.run_attempt and upload with overwrite: true; the
aggregate downloads test-shard-*-<run_id>, the latest evidence of all four
shards from whichever attempt produced each. A contract test pins the names.

Refs: #128" \
  -m "Claude-Session: https://claude.ai/code/session_01W2JybNuX5mCXWJWvApZHAt"
git log -1 --stat
```

Expected: the hooks run (Biome, actionlint, gitleaks, commitlint) and the commit lands with 2 files changed.

---

### Task 2: Read a flat single-artifact layout so the aggregate names the missing shards

**Files:**
- Test: `scripts/run-test-files-shard.test.ts` (inside `describe('readShardEvidence')`, after `writeEvidence`, lines 380-392)
- Modify: `scripts/aggregate-shard-receipts.ts:22-23` (comment), `:27` (import), `:335-364` (`readShardEvidence`)

**Interfaces:**
- Consumes: `shardEvidence(index, total)`, `root()`, `aggregate(evidence)` helpers already in the test file (`:42-83`, `:388-392`); `aggregateShardEvidence(manifest, shardTotal, evidence)`.
- Produces: `readShardEvidence(root: string): ShardEvidence[]` keeps its signature; a flat root yields one `ShardEvidence` whose `label` is `basename(root)`. New module-private `readOneShardEvidence(directory: string, label: string): ShardEvidence`.

- [ ] **Step 1: Write the failing tests**

Add `basename` to the `node:path` import on line 4 of `scripts/run-test-files-shard.test.ts`:

```ts
import { basename, join } from 'node:path';
```

Inside `describe('readShardEvidence', …)`, directly after the `writeEvidence` function, add:

```ts
  // actions/download-artifact extracts a lone pattern match directly into
  // `path`, with no per-artifact directory (download-artifact.ts, artifacts.length === 1).
  function writeFlatEvidence(root: string, shard: ReturnType<typeof shardEvidence>): void {
    mkdirSync(join(root, 'junit'), { recursive: true });
    writeFileSync(join(root, 'shard-receipt.json'), JSON.stringify(shard.receipt));
    for (const [name, xml] of shard.junit) writeFileSync(join(root, 'junit', name), xml);
  }
```

and after the existing `'fails closed on malformed JSON, a missing receipt, and stray files'` test, add:

```ts
  test('reads a single artifact extracted flat into the root as one evidence set', () => {
    const flat = root();
    writeFlatEvidence(flat, shardEvidence(1, 1));
    const evidence = readShardEvidence(flat);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].label).toBe(basename(flat));
    expect(aggregateShardEvidence(MANIFEST, 1, evidence).executed).toBe(MANIFEST.length);
  });

  test('a flat single shard fails the aggregate for the missing shards, not the layout', () => {
    const flat = root();
    writeFlatEvidence(flat, shardEvidence(2, 4));
    expect(() => aggregate(readShardEvidence(flat))).toThrow(
      /expected 4 shard evidence sets; found 1/,
    );
  });

  test('a flat layout fails closed on a missing JUnit directory or a stray entry', () => {
    const noJunit = root();
    writeFlatEvidence(noJunit, shardEvidence(1, 1));
    rmSync(join(noJunit, 'junit'), { recursive: true });
    expect(() => readShardEvidence(noJunit)).toThrow(/missing JUnit directory/);

    const stray = root();
    writeFlatEvidence(stray, shardEvidence(1, 1));
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect(() => readShardEvidence(stray)).toThrow(/unexpected flat evidence entry notes.txt/);
  });
```

- [ ] **Step 2: Run the test file and confirm the three new tests fail**

Run: `cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun && bun test ./scripts/run-test-files-shard.test.ts`

Expected: 48 pass, 3 fail; each failure's message contains `unexpected non-directory evidence entry shard-receipt.json` (the current root-level check rejects the flat receipt before anything else).

- [ ] **Step 3: Implement the flat-layout branch**

In `scripts/aggregate-shard-receipts.ts`, change the import on line 27 to:

```ts
import { basename, join, resolve } from 'node:path';
```

Replace the header comment lines 22-23:

```ts
 * Layout: --receipts=<dir> contains one subdirectory per shard, each with
 * `shard-receipt.json` and `junit/*.xml` as written by run-test-files-shard.ts.
```

with:

```ts
 * Layout: --receipts=<dir> contains one subdirectory per shard, each with
 * `shard-receipt.json` and `junit/*.xml` as written by run-test-files-shard.ts.
 * When actions/download-artifact matches exactly one artifact it extracts it
 * directly into <dir>; that flat layout is read as a single evidence set so the
 * count check reports the missing shards instead of a layout error.
```

Replace the whole `readShardEvidence` function (lines 335-364) with:

```ts
function readOneShardEvidence(directory: string, label: string): ShardEvidence {
  const receiptPath = join(directory, 'shard-receipt.json');
  const junitRoot = join(directory, 'junit');
  if (!existsSync(receiptPath)) fail(`missing shard receipt: ${receiptPath}`);
  if (!existsSync(junitRoot) || !statSync(junitRoot).isDirectory()) {
    fail(`missing JUnit directory: ${junitRoot}`);
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    fail(
      `malformed shard receipt ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const junit = new Map<string, string>();
  for (const file of readdirSync(junitRoot, { withFileTypes: true })) {
    if (!file.isFile()) fail(`unexpected JUnit entry ${join(junitRoot, file.name)}`);
    junit.set(file.name, readFileSync(join(junitRoot, file.name), 'utf8'));
  }
  return { label, receipt, junit };
}

export function readShardEvidence(root: string): ShardEvidence[] {
  if (existsSync(join(root, 'shard-receipt.json'))) {
    // A lone download-artifact match was extracted flat into the root.
    const extra = readdirSync(root)
      .filter((name) => name !== 'shard-receipt.json' && name !== 'junit')
      .sort();
    if (extra.length > 0) fail(`unexpected flat evidence entry ${extra[0]}`);
    return [readOneShardEvidence(root, basename(root))];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const foreign = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  if (foreign.length > 0) fail(`unexpected non-directory evidence entry ${foreign.sort()[0]}`);
  return entries
    .map((entry) => entry.name)
    .sort()
    .map((name) => readOneShardEvidence(join(root, name), name));
}
```

The nested-layout body is the previous code moved verbatim into `readOneShardEvidence`; messages are unchanged so the existing `/malformed shard receipt/`, `/missing shard receipt/` and `/non-directory evidence entry/` tests keep passing.

- [ ] **Step 4: Run the tests and lint the two files**

```bash
cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun
bun test ./scripts/run-test-files-shard.test.ts
bunx @biomejs/biome check scripts/aggregate-shard-receipts.ts scripts/run-test-files-shard.test.ts
```

Expected: `51 pass, 0 fail`; Biome reports `Checked 2 files … No fixes applied` with no errors (if it reports formatting, run `bunx @biomejs/biome check --write` on the same two files and re-run). `tsconfig.json:3` includes only `packages/*`, so `bunx tsc --noEmit` does not cover `scripts/`; Biome plus the test run are the checks for these files.

- [ ] **Step 5: Commit**

```bash
cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun
git add scripts/aggregate-shard-receipts.ts scripts/run-test-files-shard.test.ts
git commit -m "ci: read flat single-artifact shard evidence so the aggregate reports missing shards" \
  -m "actions/download-artifact extracts a lone pattern match directly into path.
Read that layout as one evidence set so the count check says
'expected 4 shard evidence sets; found 1' instead of rejecting the layout.

Refs: #128" \
  -m "Claude-Session: https://claude.ai/code/session_01W2JybNuX5mCXWJWvApZHAt"
git log -1 --stat
```

Expected: 2 files changed; hooks pass.

---

### Task 3: Document that "Re-run failed jobs" now works

**Files:**
- Modify: `docs/ci.md:34-39`

**Interfaces:**
- Consumes: the artifact name and pattern from Task 1.

- [ ] **Step 1: Check the current wording is what we expect to replace**

Run: `cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun && sed -n '34,39p' docs/ci.md`

Expected output starts with `## Rerunning CI` and contains `Use **Re-run all jobs**, not **Re-run failed jobs**.`

- [ ] **Step 2: Rewrite the section**

Replace lines 34-39 of `docs/ci.md`:

```markdown
## Rerunning CI

Use **Re-run all jobs**, not **Re-run failed jobs**. Shard artifacts include both
the workflow run ID and attempt number. Aggregation intentionally refuses to
combine evidence from different attempts. A cancelled run cannot produce a
successful overall result; start a complete new attempt.
```

with:

```markdown
## Rerunning CI

**Re-run failed jobs** works (#128). Each shard uploads its evidence as
`test-shard-<shard>-<run id>` with `overwrite: true`, so a re-run shard replaces
only its own earlier artifact. `Test shard aggregate` downloads
`test-shard-*-<run id>`: the latest evidence of all four shards, from whichever
attempt produced each. Every attempt of a run checks out the same commit
(`GITHUB_SHA` does not change on re-run), and the aggregate still fails closed
when a receipt's manifest digest disagrees with its own discovery. A cancelled
run cannot produce a successful overall result; start a new attempt.
```

- [ ] **Step 3: Confirm no test or script quotes the old sentence**

Run: `cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun && grep -rn "Re-run all jobs" --include='*.ts' --include='*.md' --include='*.yml' . | grep -v node_modules | grep -v docs/superpowers/plans`

Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /Users/stevemorin/c/skillsmith-fix-128-shard-rerun
git add docs/ci.md
git commit -m "docs: allow re-run failed jobs now that shard evidence is per run" \
  -m "Refs: #128" \
  -m "Claude-Session: https://claude.ai/code/session_01W2JybNuX5mCXWJWvApZHAt"
git log -3 --oneline
```

Expected: three implementation commits on top of the plan commit.

---

### Task 4: Remote verification (orchestrator, after push)

This task is run by the orchestrator, not the implementer. It proves the fix on a live partial re-run. A single-job re-run (`POST …/jobs/{job_id}/rerun`) is the deterministic stand-in for **Re-run failed jobs**: both create a new attempt in which only the re-run jobs and their dependents (`Test shard aggregate`, `CI result`) execute, and there is no failure to feed `rerun-failed-jobs`. Shell is zsh: keep every URL with `?` or `&` quoted. Poll GitHub no more than once every 20 seconds and stop after 45 polls (~15 minutes; a shard takes ~12 minutes).

Suggested PR title (the `lint-pr-title` job runs commitlint on it): `ci: let re-run failed jobs pass the test-shard aggregate`.

- [ ] **Step 1: Find the PR's CI run and wait for attempt 1 to pass**

```bash
REPO=smorinlabs/skillsmith
BRANCH=fix/shard-rerun-aggregate
gh api "repos/$REPO/actions/runs?event=pull_request&branch=$BRANCH&per_page=1" \
  --jq '.workflow_runs[0] | {id, run_attempt, status, conclusion, head_sha}'
```

Expected (after polling): `"run_attempt": 1, "status": "completed", "conclusion": "success"`. Record `id` as `RUN_ID` and `head_sha` as `HEAD_SHA`.

- [ ] **Step 2: Confirm attempt 1 produced four attempt-less shard artifacts**

```bash
gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.name|startswith("test-shard-")) | "\(.id)\t\(.name)"'
```

Expected: exactly four lines, names `test-shard-1-$RUN_ID` … `test-shard-4-$RUN_ID`, no attempt suffix. Record shard 2's id as `OLD_ID`.

- [ ] **Step 3: Re-run only `Test shard (2/4)`**

If attempt 1 happens to contain a genuinely failed shard, prefer the literal #128 scenario instead of this proxy: `gh api --include -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs" | head -1` (expected `HTTP/2.0 201 Created`), then continue from Step 4 with that shard's number in place of 2.

```bash
JOB_ID=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
  --jq '.jobs[] | select(.name=="Test shard (2/4)") | .id')
gh api --include -X POST "repos/$REPO/actions/jobs/$JOB_ID/rerun" | head -1
```

Expected: `HTTP/2.0 201 Created`. The run's `run_attempt` becomes 2.

- [ ] **Step 4: Poll until attempt 2 completes (one-shot command, repeat ≥ 20 s apart, ≤ 45 times)**

```bash
gh api "repos/$REPO/actions/runs/$RUN_ID" --jq '{run_attempt, status, conclusion}'
```

Terminal states: `{"run_attempt":2,"status":"completed","conclusion":"success"}` (pass) or `"conclusion":"failure"` (stop and read the failing job's log). Any API error counts as "no data", not a state change.

- [ ] **Step 5: Confirm only shard 2 and its dependents ran in attempt 2**

```bash
gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/2/jobs?per_page=100" \
  --jq '.jobs[] | "\(.id)\t\(.conclusion)\t\(.started_at)\t\(.name)"'
```

Expected: every job `success`. `Test shard (2/4)`, `Test shard aggregate` and `CI result` have `started_at` after the re-run request; `Test shard (1/4)`, `(3/4)`, `(4/4)` keep their attempt-1 timestamps (GitHub carries successful jobs over). Record the attempt-2 ids of `Test shard (2/4)` as `SHARD2_JOB` and `Test shard aggregate` as `AGG_JOB`.

- [ ] **Step 6: Prove the overwrite replaced the attempt-1 artifact**

```bash
gh api --allow-escape-sequences "repos/$REPO/actions/jobs/$SHARD2_JOB/logs" \
  | grep -a -E "\) deleted|successfully finalized|successfully uploaded"
```

Expected, in this order (timestamps omitted):

```
Artifact 'test-shard-2-<RUN_ID>' (ID: <OLD_ID>) deleted
Artifact test-shard-2-<RUN_ID> successfully finalized. Artifact ID <NEW_ID>
Artifact test-shard-2-<RUN_ID> has been successfully uploaded! Final size is <n> bytes. Artifact ID is <NEW_ID>
```

`<OLD_ID>` must equal the id from Step 2 and `<NEW_ID>` must be larger. If the `deleted` line is absent, the overwrite did not find the earlier artifact (upload-artifact logs that only at debug level); the upload then either failed with a name conflict (the job is red, Step 4 showed failure) or there is an unexplained duplicate. Record the full log and stop.

- [ ] **Step 7: Prove the aggregate used all four shards, with the new shard-2 artifact**

```bash
gh api --allow-escape-sequences "repos/$REPO/actions/jobs/$AGG_JOB/logs" \
  | grep -a -E "Found [0-9]+ artifact|Filtering artifacts|- test-shard-|Total of|AGGREGATE_TEST_FILE_RECEIPT|unexpected non-directory"
```

Expected:

```
Found 7 artifact(s)
Filtering artifacts by pattern 'test-shard-*-<RUN_ID>'
Preparing to download the following artifacts:
- test-shard-1-<RUN_ID> (ID: …)
- test-shard-2-<RUN_ID> (ID: <NEW_ID>, …)
- test-shard-3-<RUN_ID> (ID: …)
- test-shard-4-<RUN_ID> (ID: …)
Total of 4 artifact(s) downloaded
AGGREGATE_TEST_FILE_RECEIPT {"shards":4,…}
```

`Found 7` is the four shards plus `ordinary-agent-tools-…` and the two `agent-environments-…` artifacts; it prints after the toolkit's latest-by-name filter, so the shard-2 `ID: <NEW_ID>` match with Step 6 is the proof that the re-run evidence, not the stale one, was aggregated. `unexpected non-directory` must not appear. For comparison, the pre-fix run 36439943396 attempt 2 logged `Found 8 artifact(s)`, one match, and the non-directory error (job 108997874715).

- [ ] **Step 8: Confirm the required check is green on the PR head**

```bash
gh api "repos/$REPO/commits/$HEAD_SHA/check-runs?check_name=CI%20result&per_page=10" \
  --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion)\t\(.html_url)"'
```

Expected: `CI result	completed	success	…`.

- [ ] **Step 9: Record the evidence**

Paste the Step 6 and Step 7 output (with `RUN_ID`, `OLD_ID`, `NEW_ID`) into a PR comment and reference it from issue #128 before merging. Merge per the repo's merge policy (merge commit).

---

## Out of scope (state, do not act)

- The `# v4` comments on the three `actions/upload-artifact@043fb46d…` lines (`ci.yml:215,353,561`) are stale (the SHA is tag v7.0.1). Leave them; a comment-only fix belongs in its own change.
- `ordinary-agent-tools-…` (`ci.yml:217`) and `agent-environments-…` (`ci.yml:563`) keep `run_attempt` in their names. Nothing downloads them, so the issue does not apply.
- No head-SHA field in the shard receipt (would bump `SHARD_RECEIPT_SCHEMA_VERSION` without adding a guarantee; see Design options).
- No retention-days change and no `merge-multiple`.

## Open questions for the orchestrator

1. **PROJECTS.md registration.** The user's process asks for a `P##` entry per project; this fix is a one-issue CI change. Decide whether to add a `P##` stub before the implementer starts (none is planned here).
2. **Full re-run artifact scoping.** Attempt 3 of run 36439943396 saw only its own 7 artifacts and the REST API no longer lists attempts 1–2. Design A does not depend on the answer, but if a later workflow wants cross-attempt artifacts after a **Re-run all jobs**, this needs its own investigation.
3. **Overwrite across attempts** is documented (`action.yml` `overwrite`) but only proven by Task 4 Step 6. If that step shows no `deleted` line and the upload conflicts, fall back to Option B (attempt-suffixed names with reconciliation in the aggregate) in a new plan.
