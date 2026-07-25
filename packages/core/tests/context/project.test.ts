import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectContext } from '../../src/context/project.ts';
import { errorMessage } from '../../src/errors.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((sandbox) => rm(sandbox, { recursive: true, force: true })),
  );
});

const sandbox = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'skillsmith-project-context-'));
  sandboxes.push(path);
  return path;
};

describe('project context', () => {
  test('uses the nearest non-Git config root without changing invocation identity', async () => {
    const root = await sandbox();
    const project = join(root, 'project');
    const nested = join(project, 'packages', 'api');
    await mkdir(nested, { recursive: true });
    await writeFile(join(project, 'skillsmith.toml'), 'tool = "codex"\n');

    const ports = await defaultRuntimePorts();
    const result = await resolveProjectContext(ports, {
      invocationCwd: root,
      cd: 'project/packages/api',
      explicitConfigPath: '../../team.toml',
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBeTrue();
    expect(result.value).toEqual({
      invocationCwd: root,
      effectiveCwd: nested,
      projectRoot: project,
      projectIdentity: project,
      projectKind: 'non-git',
      discoveredConfigPath: join(project, 'skillsmith.toml'),
      explicitConfigPath: join(project, 'team.toml'),
    });
  });

  test('refuses a non-directory effective cwd before project discovery', async () => {
    const root = await sandbox();
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'fixture\n');

    const ports = await defaultRuntimePorts();
    const result = await resolveProjectContext(ports, { invocationCwd: file });

    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(errorMessage(result.error)).toContain('effective cwd is not a directory');
  });
});
