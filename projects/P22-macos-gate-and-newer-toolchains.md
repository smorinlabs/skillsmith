# P22 — macOS serial gate, PATH-first detection, and newer toolchains

**References**
- **Trunk:** [PROJECTS.md](../PROJECTS.md)
- **Tracking:** [PR #123: serial gate passes on macOS](https://github.com/smorinlabs/skillsmith/pull/123)
- **Tracking:** [PR #124: detect agent binaries on PATH before Homebrew fallbacks](https://github.com/smorinlabs/skillsmith/pull/124)
- **Tracking:** [PR #125: classify install method by the resolved binary path](https://github.com/smorinlabs/skillsmith/pull/125)
- **Tracking:** [PR #126: accept tool releases at or above the minimums; CI tests bun 1.4](https://github.com/smorinlabs/skillsmith/pull/126)
- **Tracking:** [Issue #127: classify Linuxbrew installs as brew (deferred)](https://github.com/smorinlabs/skillsmith/issues/127)
- **Tracking:** [Issue #128: "re-run failed jobs" cannot pass the shard aggregate](https://github.com/smorinlabs/skillsmith/issues/128)
- **Prior art:** [Handoff that started this work](../docs/handoffs/2026-09-22-runner-env-skips.md) (untracked, owner's checkout)

**Status:** Completed 2026-09-29. Recorded after the fact by owner request (loose-ends sweep, 2026-09-30).

## Outcome

The lefthook pre-push serial gate passes on macOS with the developer's everyday tools, agent
detection reports the binary the user actually runs, and the release toolchain accepts newer
bun and GoReleaser releases that per-PR CI now proves.

## Tests & Tasks

- [x] [P22-T01] Serial gate on macOS (#123, merge `9439862`): environment-gated skip contract, resolved `TMPDIR` run root (macOS `/var` symlink), sharded-CI pinned-capability skips, hook-prepended `GIT_EXEC_PATH` removed from test children, and fixture isolation from machine-installed agents
- [x] [P22-T02] Detection lists `$PATH` entries before the fixed Homebrew dirs (#124, merge `a04c05e`)
- [x] [P22-T03] Install method classified by the resolved target; Homebrew `Cellar`/`Caskroom` stays `brew`; CI-T01 expectations follow each agent's install provider (#125, merge `f4abf26`)
- [x] [P22-T04] Bun, GoReleaser, and npm accepted at or above the minimums; bun 1.4 / GoReleaser 2.18 compatibility fixes, including closing leaked `FileHandle`s in `node-coordinator.ts` and `recovery-file.ts`; per-PR CI on bun 1.4.2 and GoReleaser 2.18.2 while release workflows keep the minimums (#126, merge `3cb6e08`)
- [x] [P22-TS01] Full serial gate: 414/414 on bun 1.4.2 + GoReleaser 2.18.2 and on bun 1.3.14 + GoReleaser 2.17.1; per-PR CI green
- [>] [P22-T05] Linuxbrew prefix classification — continued in #127

## Notes

- Follow-up outside this project: #128 ("re-run failed jobs" cannot pass the shard aggregate).
- npm stays at 12.0.1 in CI (owner decision 2026-09-30); CI pins exact current bun and GoReleaser versions.
- The two-lane alternative (minimum and latest on every PR) was considered and not chosen; release
  workflows building with the minimums keep the floor exercised.
