# P23 — CI wall-clock: six weight-balanced test shards

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Prior art:** `docs/ci.md` (sharded test terminal), `scripts/run-test-files-shard.ts`

**Status:** In progress.

## Goal

Cut the product `CI` workflow's wall-clock time without dropping coverage. Baseline from the
last three successful runs: 9.9 min average wall-clock, 38.8 summed job-minutes. The critical
path is four test shards at 7.9–9.0 min each, whose `Run test shard` step takes 428–491 s.

- Run the test terminal in six shards instead of four.
- Refresh `scripts/test-shard-weights.json` from measured CI per-file durations (median of
  three 4-shard runs) so the greedy longest-first assignment stays balanced.
- Every test file still runs exactly once, in its own fresh `bun test` process, and the
  aggregate still validates the union of all receipts.

**Out of Scope**
- Splitting `tests/ergonomics/phase/EWP-P2-TS04.test.ts` (about 270–290 s alone on CI). It is
  the floor of any shard count and touches coordinator/recovery mechanics.
- Caching the ordinary agent-tool install (about 29 s per shard): the installer requires a
  fresh owned root (non-recursive `mkdir`, `wx` writes), so caching needs an installer change.

## Tests & Tasks

- [x] [P23-T01] Measure per-file CI durations from shard receipts of runs 39551460494,
      39553325607, 39553683768; replay assignments for 4–8 shards (6 shards: worst shard
      289–311 s versus a 271–289 s floor; 7+ shards gain under 20 s)
- [x] [P23-T02] Regenerate `scripts/test-shard-weights.json` from the median durations (rounded up)
- [x] [P23-T03] Move `.github/workflows/ci.yml`, `justfile`, `docs/ci.md`, and the committed-weights
      unit test from four to six shards
- [x] [P23-TS01] `bun test scripts/run-test-files-shard.test.ts` and
      `tests/ergonomics/phase/EWP-P6-TS06.test.ts` pass; actionlint is clean
- [x] [P23-TS03] The union of `--list-only` over the six shards is 415 files with no duplicates,
      identical to the file set the four-shard baseline ran (run 39553325607)
- [ ] [P23-TS02] PR CI green: `Test shard aggregate` validates six receipts covering the full
      manifest once, with the same file, test, and skip totals as the 4-shard baseline

### Automated Verification
- `Test shard aggregate` passes with `--shard-total=6`.
- `CI result` passes.
