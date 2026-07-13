import { mkdir, writeFile, symlink, chmod, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import { defaultRuntimePorts } from '../../../src/ports/default.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../../src/ports/types.ts';
import { runGit } from '../git-env.ts';
import { buildInTemporaryRoot } from '../temporary-root.ts';

export interface FixtureFleet {
  base: string; // mkdtemp root; everything lives under it
  home: string; // <base>/home — fake $HOME
  data: string; // <base>/data — $SKILLSMITH_DATA (store + ledger land here)
  checkout: string; // <base>/checkout — a REAL git repo (init + commit at build time)
  alphaSrc: string; // <checkout>/plugins/fh/skills/alpha
  betaSrc: string; // <checkout>/plugins/fh/skills/beta
  gammaSrc: string; // <base>/loose/gamma — non-git skill source
  headSha: string; // full 40-hex HEAD SHA of the checkout
  env: RuntimePorts; // default runtime ports with homeDir overridden to <home>
  envVars: Record<string, string | undefined>; // { SKILLSMITH_HOME: <data> }
  configuration: ResolvedRuntimeConfiguration;
  makeCheckoutDirty(): Promise<void>; // appends a line to alpha's SKILL.md (unstaged change)
  project: string; // <base>/project — a REAL git repo (init + one commit); the project-scope root
  projectReal: string; // realpath of <base>/project (macOS /var → /private/var)
}

const populateFixtureFleet = async (base: string): Promise<FixtureFleet> => {
  const home = join(base, 'home');
  const data = join(base, 'data');
  const checkout = join(base, 'checkout');
  const alphaSrc = join(checkout, 'plugins', 'fh', 'skills', 'alpha');
  const betaSrc = join(checkout, 'plugins', 'fh', 'skills', 'beta');
  const gammaSrc = join(base, 'loose', 'gamma');
  const project = join(base, 'project');

  // Create directory structure
  await mkdir(join(checkout, 'plugins', 'fh', 'skills', 'alpha', 'bin'), { recursive: true });
  await mkdir(join(checkout, 'plugins', 'fh', 'skills', 'beta'), { recursive: true });
  await mkdir(join(base, 'loose', 'gamma'), { recursive: true });
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await mkdir(join(home, '.agents', 'skills'), { recursive: true });
  await mkdir(join(home, '.codex', 'skills'), { recursive: true });
  await mkdir(join(home, '.claude', 'skills', '.system'), { recursive: true });
  await mkdir(data, { recursive: true });

  // Create alpha SKILL.md
  await writeFile(
    join(alphaSrc, 'SKILL.md'),
    `---
name: alpha
description: Fixture skill alpha.
---

# alpha
`,
  );

  // Create alpha/bin/run.sh with exec bit
  await writeFile(
    join(alphaSrc, 'bin', 'run.sh'),
    `#!/bin/sh
echo alpha
`,
  );
  await chmod(join(alphaSrc, 'bin', 'run.sh'), 0o755);

  // Create alpha/link.md as relative symlink to SKILL.md
  await symlink('SKILL.md', join(alphaSrc, 'link.md'));

  // Create beta SKILL.md
  await writeFile(
    join(betaSrc, 'SKILL.md'),
    `---
name: beta
description: Fixture skill beta.
---
`,
  );

  // Create gamma SKILL.md
  await writeFile(
    join(gammaSrc, 'SKILL.md'),
    `---
name: gamma
description: Non-git fixture skill.
---
`,
  );

  // Create home/.claude/skills/alpha (absolute symlink to alphaSrc)
  await symlink(resolve(alphaSrc), join(home, '.claude', 'skills', 'alpha'));

  // Create home/.claude/skills/copied (hand-copied pinned dir)
  await mkdir(join(home, '.claude', 'skills', 'copied'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'skills', 'copied', 'SKILL.md'),
    `---
name: copied
---
`,
  );

  // Create home/.claude/skills/dangler (dangling symlink)
  await symlink(join(checkout, 'plugins', 'fh', 'skills', 'deleted'), join(home, '.claude', 'skills', 'dangler'));

  // Create home/.claude/skills/.system/keep (dot entry)
  await writeFile(join(home, '.claude', 'skills', '.system', 'keep'), 'content');

  // Create home/.agents/skills/beta (absolute symlink to betaSrc)
  await symlink(resolve(betaSrc), join(home, '.agents', 'skills', 'beta'));

  // Create home/.codex/skills/legacy-only (absolute symlink to alphaSrc)
  await symlink(resolve(alphaSrc), join(home, '.codex', 'skills', 'legacy-only'));

  // Create home/.agents/skills/dup (real dir)
  await mkdir(join(home, '.agents', 'skills', 'dup'), { recursive: true });
  await writeFile(
    join(home, '.agents', 'skills', 'dup', 'SKILL.md'),
    `---
name: dup
---
`,
  );

  // Create home/.codex/skills/dup (real dir)
  await mkdir(join(home, '.codex', 'skills', 'dup'), { recursive: true });
  await writeFile(
    join(home, '.codex', 'skills', 'dup', 'SKILL.md'),
    `---
name: dup
---
`,
  );

  // Create home/.codex/skills/gamma (absolute symlink to gammaSrc)
  await symlink(resolve(gammaSrc), join(home, '.codex', 'skills', 'gamma'));

  runGit(checkout, ['init', '-q', '-b', 'main']);
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: initial',
  ]);
  runGit(checkout, ['remote', 'add', 'origin', 'git@github.com:smorinlabs/fixture-harness.git']);

  const headSha = runGit(checkout, ['rev-parse', 'HEAD']).trim();

  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`Invalid HEAD SHA: ${headSha}`);
  }

  // Create project directory — a REAL git repo
  await mkdir(project);
  await writeFile(join(project, 'README.md'), '# project fixture\n');

  runGit(project, ['init', '-q', '-b', 'main']);
  runGit(project, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(project, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: project',
  ]);

  const projectReal = await realpath(project);

  // Create env with overridden homeDir
  const defaultEnv = await defaultRuntimePorts();
  const env: RuntimePorts = {
    ...defaultEnv,
    homeDir: home,
  };

  const fleet: FixtureFleet = {
    base,
    home,
    data,
    checkout,
    alphaSrc,
    betaSrc,
    gammaSrc,
    headSha,
    env,
    envVars: { SKILLSMITH_HOME: data },
    configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: data }),
    makeCheckoutDirty: async () => {
      const skillPath = join(alphaSrc, 'SKILL.md');
      const content = await Bun.file(skillPath).text();
      await writeFile(skillPath, content + '\ndirty edit\n');
    },
    project,
    projectReal,
  };

  return fleet;
};

export const buildFixtureFleet = async (): Promise<FixtureFleet> =>
  buildInTemporaryRoot('skillsmith-fleet-', populateFixtureFleet);

export const destroyFixtureFleet = async (f: FixtureFleet): Promise<void> => {
  await rm(f.base, { recursive: true, force: true });
};
