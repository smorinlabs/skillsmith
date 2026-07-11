// Loaded once per test-runner process via root bunfig.toml [test].preload,
// BEFORE any test module: strips the git repo-location vars a hook injected
// into the runner itself, so in-process production spawn paths (execCommand,
// defaultScanEnv) inherit a clean env without production changes (#17).
import { scrubGitRepoEnv } from './git-env.ts';

scrubGitRepoEnv();
