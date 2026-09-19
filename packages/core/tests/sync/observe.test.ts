import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../../src/artifacts/registry.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { resolveProjectContext } from '../../src/context/project.ts';
import { emptyLedgerModel, writeLedger } from '../../src/place/ledger.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { GitPort, RuntimePorts } from '../../src/ports/types.ts';
import { resolveSyncEndpoints } from '../../src/sync/endpoints.ts';
import { observeSyncFleet, syncMembershipHashOf } from '../../src/sync/observe.ts';
import { runGit } from '../fixtures/git-env.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-sync-observe-'));
  roots.push(root);
  const home = join(root, 'home');
  const current = join(root, 'current');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const sourceSkill = join(source, '.agents', 'skills', 'alpha');
  const destinationSkill = join(destination, '.agents', 'skills', 'beta');
  const data = join(root, 'data');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(current, { recursive: true }),
    mkdir(sourceSkill, { recursive: true }),
    mkdir(destinationSkill, { recursive: true }),
    mkdir(data, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceSkill, 'SKILL.md'), '---\nname: alpha\n---\n\n# alpha\n'),
    writeFile(join(destinationSkill, 'SKILL.md'), '---\nname: beta\n---\n\n# beta\n'),
  ]);
  runGit(source, ['init', '-q', '-b', 'main']);
  runGit(source, ['add', '-A']);
  runGit(source, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: source',
  ]);
  runGit(source, ['remote', 'add', 'origin', 'https://fixture.invalid/acme/source.git']);

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
  const configuration = resolveRuntimeConfiguration({ SKILLSMITH_HOME: data });
  const topProject = await resolveProjectContext(ports, { invocationCwd: current });
  if (!topProject.ok) throw new Error(JSON.stringify(topProject.error));
  const baseContext = { ports, configuration } as unknown as CurrentApplicationContext;
  const endpoints = await resolveSyncEndpoints(baseContext, topProject.value, {
    from: source,
    to: destination,
    tools: ['codex'],
  });
  if (!endpoints.ok) throw new Error(JSON.stringify(endpoints.error));

  const pair: LedgerPairV1Dto = Object.freeze({
    placementPath: sourceSkill,
    mode: 'dev',
    dev: Object.freeze({
      sourcePath: sourceSkill,
      resolvedPath: sourceSkill,
      repoRoot: source,
      sourceRelPath: '.agents/skills/alpha',
      remote: 'https://fixture.invalid/acme/source.git',
      recordedAt: '2026-07-21T00:00:00.000Z',
    }),
    pinned: null,
    journal: null,
  });
  const empty = emptyLedgerModel('2026-07-21T00:00:00.000Z');
  const projects: LedgerModel['projects'] = Object.freeze({
    [source]: Object.freeze({
      skills: Object.freeze({
        alpha: Object.freeze({ tools: Object.freeze({ codex: pair }) }),
      }),
    }),
  });
  const ledger: LedgerModel = Object.freeze({
    ...empty,
    projects,
    projectRegistrations: deriveLedgerProjectRegistrations(projects),
  });
  const ledgerWrite = await writeLedger(ports, join(data, 'placements.json'), ledger);
  if (!ledgerWrite.ok) throw new Error(JSON.stringify(ledgerWrite.error));
  return {
    sourceSkill,
    ports,
    configuration,
    endpoints: endpoints.value,
    context: baseContext,
  };
};

const countedGit = (
  delegate: GitPort,
  behavior: 'delegate' | 'throw',
): Readonly<{ git: GitPort; calls: () => number }> => {
  let count = 0;
  const git = new Proxy(delegate, {
    get(target, property, receiver) {
      const selected = Reflect.get(target, property, receiver);
      if (typeof selected !== 'function') return selected;
      return (...args: unknown[]) => {
        count += 1;
        if (behavior === 'throw') throw new Error('portable Git work was not requested');
        return Reflect.apply(selected, target, args);
      };
    },
  });
  return Object.freeze({ git, calls: () => count });
};

describe('sync fleet observation', () => {
  test('live-only freezes exact membership/content facts with zero Git work', async () => {
    const selected = await fixture();
    const git = countedGit(selected.ports.git, 'throw');
    const context = {
      ...selected.context,
      ports: { ...selected.ports, git: git.git },
    } as unknown as CurrentApplicationContext;

    const first = await observeSyncFleet(context, selected.endpoints, { portableProof: 'none' });
    expect(first.ok).toBeTrue();
    expect(git.calls()).toBe(0);
    if (!first.ok) return;
    expect(first.value.source.entries).toHaveLength(1);
    expect(first.value.destination.entries).toHaveLength(1);
    expect(first.value.source.entries[0]).toMatchObject({
      entry: { name: 'alpha', tool: 'codex', scope: 'project', placement: 'copy' },
      pendingJournal: false,
      pendingTransactionIds: [],
      portable: { outcome: 'not-requested' },
    });
    expect(first.value.source.entries[0]?.liveContentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(first.value)).toBeTrue();
    expect(Object.isFrozen(first.value.source.entries)).toBeTrue();
    expect(Object.isFrozen(first.value.source.entries[0])).toBeTrue();
    expect(syncMembershipHashOf(selected.endpoints.from, first.value.source.entries)).toBe(
      first.value.source.membershipHash,
    );

    await writeFile(
      join(selected.sourceSkill, 'SKILL.md'),
      '---\nname: alpha\n---\n\n# changed alpha\n',
    );
    const second = await observeSyncFleet(context, selected.endpoints, { portableProof: 'none' });
    expect(second.ok).toBeTrue();
    expect(git.calls()).toBe(0);
    if (!second.ok) return;
    expect(second.value.source.membershipHash).toBe(first.value.source.membershipHash);
    expect(second.value.source.entries[0]?.liveContentHash).not.toBe(
      first.value.source.entries[0]?.liveContentHash,
    );
  });

  test('exact proof classifies clean Git-dev bytes and dirty bytes without destination Git work', async () => {
    const selected = await fixture();
    const git = countedGit(selected.ports.git, 'delegate');
    const context = {
      ...selected.context,
      ports: { ...selected.ports, git: git.git },
    } as unknown as CurrentApplicationContext;

    const clean = await observeSyncFleet(context, selected.endpoints, { portableProof: 'exact' });
    expect(clean.ok).toBeTrue();
    expect(git.calls()).toBeGreaterThan(0);
    if (!clean.ok) return;
    expect(clean.value.source.entries[0]?.portable).toMatchObject({
      outcome: 'portable',
      candidate: {
        name: 'alpha',
        tools: ['codex'],
        classification: 'portable-dev',
        sourceText: 'fixture.invalid/acme/source//.agents/skills/alpha',
      },
    });
    expect(clean.value.destination.entries[0]?.portable).toEqual({ outcome: 'not-requested' });

    await writeFile(
      join(selected.sourceSkill, 'SKILL.md'),
      '---\nname: alpha\n---\n\n# dirty alpha\n',
    );
    const dirty = await observeSyncFleet(context, selected.endpoints, { portableProof: 'exact' });
    expect(dirty.ok).toBeTrue();
    if (!dirty.ok) return;
    expect(dirty.value.source.entries[0]?.portable).toMatchObject({
      outcome: 'nonportable',
      result: { action: 'skipped', reason: 'dirty-git' },
    });
  });
});
