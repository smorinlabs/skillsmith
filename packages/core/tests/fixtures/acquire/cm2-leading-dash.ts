import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../git-env.ts';
import { buildInTemporaryRoot } from '../temporary-root.ts';

// SC-I60-CM2 shared builder: one real local repository containing an otherwise valid
// leading-dash skill subtree, a regular control skill, and an outside-cone sibling,
// plus a separate root-skill repository for the root control. Shared unchanged by the
// core regression (tests/acquire/fetch.test.ts) and the public CLI regression
// (cli/tests/commands/install-sparse-path.test.ts) so both prove the exact same repo.
// Setup uses no pathspec argv at all (plain `add -A`, `clone`, `rev-parse`), so it
// cannot reproduce the argv shape under test.

export const CM2_HOST = 'cm2-fixture.invalid';
export const CM2_REPO = 'owner/source';
export const CM2_ROOT_REPO = 'owner/cm2root';
export const CM2_SKILL_PATH = '-x/skill';
export const CM2_SKILL_NAME = 'skill';
export const CM2_CONTROL_PATH = 'ordinary/control';
export const CM2_CONTROL_NAME = 'control';
export const CM2_SIBLING_PATH = 'other/sibling';
export const CM2_ROOT_NAME = 'cm2root';

export const CM2_DASH_SKILL_MD =
  '---\nname: skill\ndescription: CM2 leading-dash fixture.\n---\n\n# cm2 leading-dash payload\n';
export const CM2_CONTROL_SKILL_MD =
  '---\nname: control\ndescription: CM2 regular control fixture.\n---\n\n# cm2 regular control payload\n';
export const CM2_SIBLING_SKILL_MD =
  '---\nname: sibling\ndescription: CM2 outside-cone sibling.\n---\n\n# cm2 sibling payload\n';
export const CM2_ROOT_SKILL_MD =
  '---\nname: cm2root\ndescription: CM2 root control fixture.\n---\n\n# cm2 root payload\n';

export interface Cm2Fixture {
  base: string;
  workDir: string;
  bareRepo: string;
  /** file:// URL of the leading-dash bare repo (transport target). */
  cm2Url: string;
  /** Parser-facing HTTPS identity rewritten to cm2Url by the owned gitconfig. */
  cloneUrl: string;
  /** Full 40-hex HEAD SHA of the leading-dash repo. */
  head: string;
  rootBareRepo: string;
  rootUrl: string;
  rootCloneUrl: string;
  rootHead: string;
}

const commitAll = (workDir: string, message: string): void => {
  runGit(workDir, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(workDir, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
};

const toBare = (base: string, workDir: string, name: string): string => {
  const bare = join(base, name);
  runGit(base, ['clone', '-q', '--bare', workDir, bare]);
  runGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
  runGit(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  return bare;
};

const readHead = (workDir: string): string => {
  const sha = runGit(workDir, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid fixture HEAD SHA: ${sha}`);
  return sha;
};

const populateCm2Fixture = async (base: string): Promise<Cm2Fixture> => {
  const workDir = join(base, 'cm2-work');
  await mkdir(join(workDir, '-x', 'skill', 'bin'), { recursive: true });
  await mkdir(join(workDir, 'ordinary', 'control'), { recursive: true });
  await mkdir(join(workDir, 'other', 'sibling'), { recursive: true });

  await writeFile(join(workDir, '-x', 'skill', 'SKILL.md'), CM2_DASH_SKILL_MD);
  await writeFile(join(workDir, '-x', 'skill', 'bin', 'run.sh'), '#!/bin/sh\necho cm2\n');
  await chmod(join(workDir, '-x', 'skill', 'bin', 'run.sh'), 0o755);
  await symlink('SKILL.md', join(workDir, '-x', 'skill', 'link.md'));
  await writeFile(join(workDir, 'ordinary', 'control', 'SKILL.md'), CM2_CONTROL_SKILL_MD);
  await writeFile(join(workDir, 'other', 'sibling', 'SKILL.md'), CM2_SIBLING_SKILL_MD);

  runGit(workDir, ['init', '-q', '-b', 'main']);
  commitAll(workDir, 'fixture: cm2 leading-dash plus controls');
  const head = readHead(workDir);
  const bareRepo = toBare(base, workDir, 'cm2.git');

  const rootWork = join(base, 'cm2-root-work');
  await mkdir(rootWork, { recursive: true });
  await writeFile(join(rootWork, 'SKILL.md'), CM2_ROOT_SKILL_MD);
  runGit(rootWork, ['init', '-q', '-b', 'main']);
  commitAll(rootWork, 'fixture: cm2 root');
  const rootHead = readHead(rootWork);
  const rootBareRepo = toBare(base, rootWork, 'cm2-root.git');

  return {
    base,
    workDir,
    bareRepo,
    cm2Url: `file://${bareRepo}`,
    cloneUrl: `https://${CM2_HOST}/${CM2_REPO}.git`,
    head,
    rootBareRepo,
    rootUrl: `file://${rootBareRepo}`,
    rootCloneUrl: `https://${CM2_HOST}/${CM2_ROOT_REPO}.git`,
    rootHead,
  };
};

export const buildCm2Fixture = async (): Promise<Cm2Fixture> =>
  buildInTemporaryRoot('skillsmith-cm2-', populateCm2Fixture);

export const destroyCm2Fixture = async (f: Cm2Fixture): Promise<void> => {
  await rm(f.base, { recursive: true, force: true });
};
