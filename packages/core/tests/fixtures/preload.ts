// Loaded once per test-runner process via root bunfig.toml [test].preload,
// BEFORE any test module: strips the git repo-location vars a hook injected
// into the runner itself, so in-process production spawn paths (execCommand,
// defaultScanEnv) inherit a clean env without production changes (#17).
// Package-scoped test runs (bun test with cwd inside packages/core or packages/cli) load this file via that package's own bunfig.toml because a package-level bunfig.toml entirely shadows the root one in Bun; CLI-only test runs execute no canary test—the canary (runner-env.test.ts) lives only in the core test suite.
import { scrubGitRepoEnv } from './git-env.ts';

scrubGitRepoEnv();
