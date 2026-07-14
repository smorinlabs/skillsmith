import { mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchRepo,
  lsTreeSkills,
  resolveRefViaLsRemote,
  sparseCheckoutSkill,
} from '../../../src/acquire/fetch.ts';
import type { InstallSourceTransport } from '../../../src/acquire/types.ts';
import { runGit } from '../git-env.ts';
import { buildInTemporaryRoot } from '../temporary-root.ts';

export interface RemoteFixture {
  base: string; // mkdtemp root
  multiUrl: string; // file://<base>/multi.git — several skills incl. a duplicate basename
  singleUrl: string; // file://<base>/single.git — exactly one skill, nested deep
  rootUrl: string; // file://<base>/root.git — SKILL.md at the repo root
  multiSource: string; // safe parser-facing HTTPS identity (trusted transport maps it locally)
  singleSource: string;
  rootSource: string;
  transport: InstallSourceTransport;
  gitRewriteEnv: Readonly<Record<string, string>>;
  multiWork: string; // <base>/multi-work — the working clone multi.git was made from
  multiHead: string; // full 40-hex HEAD SHA of multi (main)
  multiTagSha: string; // full 40-hex SHA of tag v1.0.0 (the FIRST commit — differs from HEAD)
  multiAnnotatedTag: string; // name of the ANNOTATED tag (v2.0.0) on the first commit
  multiAnnotatedCommit: string; // full 40-hex COMMIT SHA the annotated tag peels to
  multiAnnotatedTagObject: string; // full 40-hex SHA of the tag OBJECT itself (differs from commit)
  singleHead: string;
  rootHead: string;
}

const populateRemoteFixture = async (base: string): Promise<RemoteFixture> => {
  // Create multi-work directory structure
  const multiWork = join(base, 'multi-work');
  await mkdir(join(multiWork, 'plugins', 'web', 'skills', 'review'), { recursive: true });
  await mkdir(join(multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'bin'), { recursive: true });
  await mkdir(join(multiWork, 'plugins', 'api', 'skills', 'review'), { recursive: true });
  await mkdir(join(multiWork, '.internal', 'skills', 'hidden'), { recursive: true });
  await mkdir(join(multiWork, 'docs'), { recursive: true });

  // Commit 1: Create initial structure
  await writeFile(
    join(multiWork, 'plugins', 'web', 'skills', 'review', 'SKILL.md'),
    `---
name: review
description: Web review fixture.
---
`,
  );

  await writeFile(
    join(multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'SKILL.md'),
    `---
name: factor-scan
description: Fixture skill.
---

# factor-scan
`,
  );

  // Initialize git and commit 1
  runGit(multiWork, ['init', '-q', '-b', 'main']);
  runGit(multiWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(multiWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: commit 1',
  ]);

  // Tag the first commit (lightweight — points directly at the commit)
  runGit(multiWork, ['tag', 'v1.0.0']);

  // Annotated tag on the same first commit: its tag-OBJECT SHA differs from the commit it wraps.
  // Used to prove ref resolution peels annotated tags to the underlying commit SHA.
  runGit(multiWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'tag.gpgsign=false',
    'tag',
    '-a',
    'v2.0.0',
    '-m',
    'annotated release',
  ]);

  // Commit 2: Add duplicate review skill, factor-scan enhancements, hidden skill, docs
  await writeFile(
    join(multiWork, 'plugins', 'api', 'skills', 'review', 'SKILL.md'),
    `---
name: review
description: API review fixture.
---
`,
  );

  await writeFile(
    join(multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'bin', 'run.sh'),
    `#!/bin/sh
echo fs
`,
  );
  await chmod(join(multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'bin', 'run.sh'), 0o755);

  await symlink('SKILL.md', join(multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'link.md'));

  await writeFile(join(multiWork, 'docs', 'notes.md'), '# Notes\n');

  await writeFile(
    join(multiWork, '.internal', 'skills', 'hidden', 'SKILL.md'),
    `---
name: hidden
---
`,
  );

  runGit(multiWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(multiWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: commit 2',
  ]);

  // Get SHAs
  const multiHead = runGit(multiWork, ['rev-parse', 'HEAD']).trim();
  const multiTagSha = runGit(multiWork, ['rev-parse', 'v1.0.0^{commit}']).trim();
  const multiAnnotatedTagObject = runGit(multiWork, ['rev-parse', 'v2.0.0']).trim();
  const multiAnnotatedCommit = runGit(multiWork, ['rev-parse', 'v2.0.0^{commit}']).trim();

  if (!/^[0-9a-f]{40}$/.test(multiHead)) {
    throw new Error(`Invalid multiHead SHA: ${multiHead}`);
  }
  if (!/^[0-9a-f]{40}$/.test(multiTagSha)) {
    throw new Error(`Invalid multiTagSha SHA: ${multiTagSha}`);
  }
  if (!/^[0-9a-f]{40}$/.test(multiAnnotatedTagObject)) {
    throw new Error(`Invalid multiAnnotatedTagObject SHA: ${multiAnnotatedTagObject}`);
  }
  if (multiAnnotatedTagObject === multiAnnotatedCommit) {
    throw new Error('annotated tag object SHA must differ from the commit it wraps');
  }

  // Clone to bare repos
  const multiGit = join(base, 'multi.git');
  runGit(base, ['clone', '-q', '--bare', multiWork, multiGit]);

  // Create single-work
  const singleWork = join(base, 'single-work');
  await mkdir(join(singleWork, 'tools', 'deep', 'skills', 'lint'), { recursive: true });
  await writeFile(
    join(singleWork, 'tools', 'deep', 'skills', 'lint', 'SKILL.md'),
    `---
name: lint
---
`,
  );

  runGit(singleWork, ['init', '-q', '-b', 'main']);
  runGit(singleWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(singleWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: lint',
  ]);

  const singleHead = runGit(singleWork, ['rev-parse', 'HEAD']).trim();

  if (!/^[0-9a-f]{40}$/.test(singleHead)) {
    throw new Error(`Invalid singleHead SHA: ${singleHead}`);
  }

  const singleGit = join(base, 'single.git');
  runGit(base, ['clone', '-q', '--bare', singleWork, singleGit]);

  // Create root-work
  const rootWork = join(base, 'root-work');
  await mkdir(rootWork);
  await writeFile(
    join(rootWork, 'SKILL.md'),
    `---
name: rootskill
---
`,
  );
  await writeFile(join(rootWork, 'README.md'), '# Root Skill\n');

  runGit(rootWork, ['init', '-q', '-b', 'main']);
  runGit(rootWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(rootWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: root',
  ]);

  const rootHead = runGit(rootWork, ['rev-parse', 'HEAD']).trim();

  if (!/^[0-9a-f]{40}$/.test(rootHead)) {
    throw new Error(`Invalid rootHead SHA: ${rootHead}`);
  }

  const rootGit = join(base, 'root.git');
  runGit(base, ['clone', '-q', '--bare', rootWork, rootGit]);

  // Configure bare repos
  for (const bareRepo of [multiGit, singleGit, rootGit]) {
    runGit(bareRepo, ['config', 'uploadpack.allowFilter', 'true']);
    runGit(bareRepo, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  }

  const multiUrl = `file://${multiGit}`;
  const singleUrl = `file://${singleGit}`;
  const rootUrl = `file://${rootGit}`;
  const multiSource = 'https://fixture.invalid/acme/multi.git';
  const singleSource = 'https://fixture.invalid/acme/single.git';
  const rootSource = 'https://fixture.invalid/acme/root.git';
  const localByCanonicalClone = new Map([
    [multiSource, multiUrl],
    [singleSource, singleUrl],
    [rootSource, rootUrl],
  ]);
  const localClone = (cloneUrl: string): string =>
    localByCanonicalClone.get(cloneUrl) ?? cloneUrl;
  const transport: InstallSourceTransport = Object.freeze({
    resolveRef: (
      ports: Parameters<InstallSourceTransport['resolveRef']>[0],
      cloneUrl: string,
      ref: string | null,
      signal?: AbortSignal,
    ) =>
      resolveRefViaLsRemote(ports, localClone(cloneUrl), ref, signal),
    fetchRepo: (
      ports: Parameters<InstallSourceTransport['fetchRepo']>[0],
      options: Parameters<InstallSourceTransport['fetchRepo']>[1],
    ) =>
      fetchRepo(ports, { ...options, cloneUrl: localClone(options.cloneUrl) }),
    listSkills: lsTreeSkills,
    materializeSkill: sparseCheckoutSkill,
  });
  const rewrites = [
    [multiSource, multiUrl],
    [singleSource, singleUrl],
    [rootSource, rootUrl],
  ] as const;
  const gitRewriteEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: String(rewrites.length),
    GIT_ALLOW_PROTOCOL: 'file:https',
  };
  for (const [index, [insteadOf, local]] of rewrites.entries()) {
    gitRewriteEnv[`GIT_CONFIG_KEY_${index}`] = `url.${local}.insteadOf`;
    gitRewriteEnv[`GIT_CONFIG_VALUE_${index}`] = insteadOf;
  }

  const fixture: RemoteFixture = {
    base,
    multiUrl,
    singleUrl,
    rootUrl,
    multiSource,
    singleSource,
    rootSource,
    transport,
    gitRewriteEnv: Object.freeze(gitRewriteEnv),
    multiWork,
    multiHead,
    multiTagSha,
    multiAnnotatedTag: 'v2.0.0',
    multiAnnotatedCommit,
    multiAnnotatedTagObject,
    singleHead,
    rootHead,
  };

  return fixture;
};

export const buildRemoteFixture = async (): Promise<RemoteFixture> =>
  buildInTemporaryRoot('skillsmith-remote-', populateRemoteFixture);

export const destroyRemoteFixture = async (f: RemoteFixture): Promise<void> => {
  await rm(f.base, { recursive: true, force: true });
};
