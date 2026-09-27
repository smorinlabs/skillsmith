# CI checks and sharded tests

Product CI runs the test terminal in four jobs. Each test file still runs in a
fresh Bun process with the serial runner's flags, timeout, and skip policy.
`scripts/test-shard-weights.json` assigns files deterministically using recorded
durations; new files receive the default weight. Weights affect scheduling only.

`Test shard aggregate` independently discovers the test manifest and verifies all
four receipts and their JUnit reports. Every file must appear exactly once, and
the global allowlist must still contain 42 skips across eight files. Missing,
duplicate, failed, or inconsistent evidence fails the check.

`CI result` waits for every product CI job, including the shard matrix, aggregate,
ordinary checks, native build smoke, agent environments, and PR-title lint. Every
result must succeed. Only PR-title lint is allowed to skip, and only for a push
to `main`. The overall job uses `always()` so failed or skipped prerequisites do
not prevent it from reporting failure. It requires no checkout or network call.

Local `just check` retains the serial test terminal and the same seven non-test
checks. CI uses `just check-gates` for those seven checks and runs the tests in
the four shard jobs.

## Rerunning CI

Use **Re-run all jobs**, not **Re-run failed jobs**. Shard artifacts include both
the workflow run ID and attempt number. Aggregation intentionally refuses to
combine evidence from different attempts. A cancelled run cannot produce a
successful overall result; start a complete new attempt.

## Required-check rollout

The workflow adds the stable check name `CI result`. Making it a merge
requirement is a separate repository configuration change after the adoption PR
passes review and CI. Keep the existing required `Scan Git History for
Credentials` check. Add `CI result` from GitHub Actions to the same required
status-check rule; preserve its other settings and all other rulesets.

Before applying that configuration, refresh the ruleset and check-run records.
Confirm that `CI result` refers to the reviewed workflow and its GitHub Actions
app. This PR does not modify repository rules or make individual shard names
required. The separate credential-history workflow remains required independently.
