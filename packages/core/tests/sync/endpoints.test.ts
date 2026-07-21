import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { resolveProjectContext } from '../../src/context/project.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { resolveSyncEndpoints } from '../../src/sync/endpoints.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-sync-endpoints-'));
  roots.push(root);
  const home = join(root, 'home');
  const current = join(root, 'current');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await Promise.all(
    [home, current, source, destination].map((path) => mkdir(path, { recursive: true })),
  );
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = {
    ...base,
    homeDir: home,
    xdg: {
      config: join(root, 'xdg', 'config'),
      data: join(root, 'xdg', 'data'),
      cache: join(root, 'xdg', 'cache'),
    },
  };
  const configuration = resolveRuntimeConfiguration({
    SKILLSMITH_HOME: join(root, 'data'),
    CODEX_HOME: join(home, '.codex'),
  });
  const project = await resolveProjectContext(ports, { invocationCwd: current });
  if (!project.ok) throw new Error(JSON.stringify(project.error));
  const context = { ports, configuration } as unknown as CurrentApplicationContext;
  return { root, home, current, source, destination, ports, project: project.value, context };
};

describe('sync endpoint resolution', () => {
  test('resolves mandatory user/project/path endpoints from one stable cwd', async () => {
    const selected = await fixture();
    const cwdBefore = process.cwd();
    const first = await resolveSyncEndpoints(selected.context, selected.project, {
      from: 'user',
      to: '../destination',
      tools: ['codex', 'codex'],
    });
    const second = await resolveSyncEndpoints(selected.context, selected.project, {
      from: 'user',
      to: selected.destination,
      tools: ['codex'],
    });

    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) return;
    expect(first.value.tools).toEqual(['codex']);
    expect(first.value.from).toMatchObject({ kind: 'user', scope: 'user' });
    expect(first.value.to).toMatchObject({
      kind: 'path',
      scope: 'project',
      canonicalBase: selected.destination,
    });
    expect(first.value.to.identity).toBe(second.value.to.identity);
    expect(first.value.to.roots.map(({ canonicalPath }) => canonicalPath)).toEqual([
      join(selected.destination, '.agents', 'skills'),
    ]);
    expect(process.cwd()).toBe(cwdBefore);
  });

  test('refuses missing values, read-only destinations, unsupported tools, and aliases', async () => {
    const selected = await fixture();
    const alias = join(selected.root, 'source-alias');
    await symlink(selected.source, alias);

    const missing = await resolveSyncEndpoints(selected.context, selected.project, {
      from: '',
      to: selected.destination,
      tools: ['codex'],
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'sync-source-required', exitClass: 'usage' },
    });

    const readOnly = await resolveSyncEndpoints(selected.context, selected.project, {
      from: selected.source,
      to: 'managed',
      tools: ['claude-code'],
    });
    expect(readOnly).toMatchObject({
      ok: false,
      error: { code: 'sync-destination-read-only', exitClass: 'usage' },
    });

    const unsupported = await resolveSyncEndpoints(selected.context, selected.project, {
      from: selected.source,
      to: selected.destination,
      tools: ['kilo-code'],
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'sync-destination-capability', exitClass: 'capability' },
    });

    const aliased = await resolveSyncEndpoints(selected.context, selected.project, {
      from: selected.source,
      to: alias,
      tools: ['codex'],
    });
    expect(aliased).toMatchObject({
      ok: false,
      error: { code: 'sync-endpoint-alias', exitClass: 'usage' },
    });
  });

  test('admits only adapter-exposed read scopes and proves destination writability', async () => {
    const selected = await fixture();
    const system = await resolveSyncEndpoints(selected.context, selected.project, {
      from: 'system',
      to: selected.destination,
      tools: ['codex'],
    });
    expect(system.ok).toBeTrue();
    if (system.ok) {
      expect(system.value.from.roots).toHaveLength(1);
      expect(system.value.from.roots[0]).toMatchObject({
        tool: 'codex',
        scope: 'system',
        path: '/etc/codex/skills',
      });
    }

    const noSystemRoots = await resolveSyncEndpoints(selected.context, selected.project, {
      from: 'system',
      to: selected.destination,
      tools: ['claude-code'],
    });
    expect(noSystemRoots).toMatchObject({
      ok: false,
      error: { code: 'sync-source-scope-unsupported', exitClass: 'capability' },
    });

    const refusingContext = {
      ...selected.context,
      ports: {
        ...selected.ports,
        assertWritableDirectory: async () => {
          throw Object.assign(new Error('private canary'), { code: 'EACCES' });
        },
      },
    } as unknown as CurrentApplicationContext;
    const unwritable = await resolveSyncEndpoints(refusingContext, selected.project, {
      from: selected.source,
      to: selected.destination,
      tools: ['codex'],
    });
    expect(unwritable).toMatchObject({
      ok: false,
      error: {
        code: 'sync-destination-permission',
        message: 'sync destination is not writable',
        exitClass: 'permission',
      },
    });
    expect(JSON.stringify(unwritable)).not.toContain('private canary');
  });
});
