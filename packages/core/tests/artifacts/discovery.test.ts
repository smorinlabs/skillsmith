import { describe, expect, test } from 'bun:test';
import { normalize } from 'node:path';
import {
  type ArtifactDiscoveryError,
  type ArtifactDiscoveryPorts,
  type ArtifactDiscoverySnapshot,
  type ManifestCandidate,
  type ManifestDestination,
  discoverArtifactSnapshot,
  selectManifestDestination,
} from '../../src/artifacts/discovery.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type { Result } from '../../src/result.ts';

const ROOT = '/work/repo';
const CWD = '/work/repo/packages/api/src';
const NESTED = '/work/repo/packages/api/skillsmith.toml';
const ROOT_MANIFEST = '/work/repo/skillsmith.toml';
const USER_MANIFEST = '/home/u/.config/skillsmith/skillsmith.toml';
const USER_CONFIG = '/home/u/.config/skillsmith/config.toml';

const manifest = (names: readonly string[], scope: 'project' | 'user' = 'project'): string =>
  `${[
    'version = 1',
    '[defaults]',
    `scope = "${scope}"`,
    'tools = ["codex"]',
    ...names.flatMap((name) => [
      '[[skills]]',
      `name = "${name}"`,
      `source = "github.com/acme/skills//${name}"`,
    ]),
  ].join('\n')}\n`;

const context = (
  effectiveCwd = CWD,
  projectRoot: string | null = ROOT,
  discoveredConfigPath: string | null = NESTED,
): ProjectContext =>
  Object.freeze({
    invocationCwd: effectiveCwd,
    effectiveCwd,
    projectRoot,
    projectIdentity: projectRoot,
    projectKind: projectRoot === null ? 'non-git' : 'git',
    discoveredConfigPath,
    explicitConfigPath: null,
  });

class FakeDiscoveryPorts implements ArtifactDiscoveryPorts {
  readonly xdg = Object.freeze({
    config: '/home/u/.config',
    data: '/home/u/.local/share',
    cache: '/home/u/.cache',
  });
  readonly entries = new Map<
    string,
    Readonly<{ kind: 'file' | 'dir' | 'symlink'; text?: string }>
  >();
  readonly calls = { pathKind: [] as string[], readText: [] as string[] };

  constructor(
    entries: Readonly<
      Record<string, Readonly<{ kind: 'file' | 'dir' | 'symlink'; text?: string }>>
    > = {},
  ) {
    for (const [path, entry] of Object.entries(entries)) this.entries.set(normalize(path), entry);
  }

  async pathKind(path: string): Promise<'absent' | 'file' | 'dir' | 'symlink'> {
    const key = normalize(path);
    this.calls.pathKind.push(key);
    return this.entries.get(key)?.kind ?? 'absent';
  }

  async readText(path: string): Promise<string> {
    const key = normalize(path);
    this.calls.readText.push(key);
    const entry = this.entries.get(key);
    if (entry?.kind !== 'file' || entry.text === undefined) {
      throw new Error(`unexpected manifest read: ${key}`);
    }
    return entry.text;
  }
}

const expectSnapshot = (
  result: Result<ArtifactDiscoverySnapshot, ArtifactDiscoveryError>,
): ArtifactDiscoverySnapshot => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const expectDestination = (
  result: Result<ManifestDestination, ArtifactDiscoveryError>,
): ManifestDestination => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const expectDestinationError = (
  result: Result<ManifestDestination, ArtifactDiscoveryError>,
  code: ArtifactDiscoveryError['code'],
  exitClass: ArtifactDiscoveryError['exitClass'],
): ArtifactDiscoveryError => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected manifest destination refusal');
  expect(result.error).toMatchObject({ code, exitClass });
  return result.error;
};

const candidate = (
  role: ManifestCandidate['role'],
  path: string,
  names: readonly string[],
  shape: ManifestCandidate['shape'] = 'canonical',
): ManifestCandidate =>
  Object.freeze({
    role,
    path,
    existence: 'file',
    shape,
    declaredNames: Object.freeze([...names]),
  });

const snapshot = (
  candidates: readonly ManifestCandidate[],
  explicitArtifactPath: string | null = null,
): ArtifactDiscoverySnapshot =>
  Object.freeze({
    projectContext: context(),
    selectedProjectManifest: NESTED,
    projectRootManifest: ROOT_MANIFEST,
    userManifest: USER_MANIFEST,
    userConfig: USER_CONFIG,
    explicitConfigPath: null,
    explicitArtifactPath,
    candidates: Object.freeze([...candidates]),
  });

describe('artifact discovery and destination ownership', () => {
  test('discovers selected, root, user, and explicit roles with one parse per path', async () => {
    const ports = new FakeDiscoveryPorts({
      [NESTED]: { kind: 'file', text: manifest(['nested']) },
      [ROOT_MANIFEST]: { kind: 'file', text: manifest(['root']) },
      [USER_MANIFEST]: { kind: 'file', text: manifest(['user'], 'user') },
      [USER_CONFIG]: { kind: 'file', text: 'tool = "codex"\n' },
    });
    const result = expectSnapshot(
      await discoverArtifactSnapshot(ports, context(), {
        explicitConfig: '../skillsmith.toml',
        explicitFile: '../skillsmith.toml',
      }),
    );

    expect(result).toMatchObject({
      selectedProjectManifest: NESTED,
      projectRootManifest: ROOT_MANIFEST,
      userManifest: USER_MANIFEST,
      userConfig: USER_CONFIG,
      explicitConfigPath: NESTED,
      explicitArtifactPath: NESTED,
    });
    expect(result.candidates).toEqual([
      candidate('selected-project', NESTED, ['nested']),
      candidate('project-root', ROOT_MANIFEST, ['root']),
      candidate('user', USER_MANIFEST, ['user']),
      candidate('explicit', NESTED, ['nested']),
    ]);
    expect(ports.calls.readText).toEqual([NESTED, ROOT_MANIFEST, USER_MANIFEST]);
    expect(ports.calls.readText).not.toContain(USER_CONFIG);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projectContext)).toBe(true);
    expect(result.candidates.every((item) => Object.isFrozen(item.declaredNames))).toBe(true);
  });

  test('keeps the stable Git root and supports an explicit non-Git project destination', async () => {
    const nested = expectSnapshot(
      await discoverArtifactSnapshot(
        new FakeDiscoveryPorts({ [NESTED]: { kind: 'file', text: manifest(['nested']) } }),
        context(),
      ),
    );
    expect(nested.projectContext.projectRoot).toBe(ROOT);
    expect(nested.projectRootManifest).toBe(ROOT_MANIFEST);

    const nonGitCwd = '/scratch/project';
    const nonGit = expectSnapshot(
      await discoverArtifactSnapshot(new FakeDiscoveryPorts(), context(nonGitCwd, null, null), {
        explicitProjectScope: true,
      }),
    );
    expect(nonGit.projectRootManifest).toBe('/scratch/project/skillsmith.toml');
    expect(
      expectDestination(
        selectManifestDestination(nonGit, {
          names: ['new'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({
      kind: 'new',
      role: 'project-root',
      path: '/scratch/project/skillsmith.toml',
    });
  });

  test('routes to an explicit file or the unique declaration owner before scope defaults', () => {
    const base = snapshot([
      candidate('selected-project', NESTED, ['nested']),
      candidate('project-root', ROOT_MANIFEST, ['root']),
      candidate('user', USER_MANIFEST, ['user']),
    ]);

    expect(
      expectDestination(
        selectManifestDestination(snapshot(base.candidates, '/tmp/team.toml'), {
          names: ['anything'],
          scope: 'project',
          mode: 'save',
          explicitFile: '/tmp/team.toml',
        }),
      ),
    ).toMatchObject({ kind: 'new', role: 'explicit', path: '/tmp/team.toml' });
    for (const [name, role, path] of [
      ['nested', 'selected-project', NESTED],
      ['root', 'project-root', ROOT_MANIFEST],
      ['user', 'user', USER_MANIFEST],
    ] as const) {
      expect(
        expectDestination(
          selectManifestDestination(base, { names: [name], scope: 'project', mode: 'save' }),
        ),
      ).toMatchObject({ kind: 'existing', role, path });
    }
  });

  test('refuses every ambiguous owner set and any split multi-name request', () => {
    for (const candidates of [
      [
        candidate('selected-project', NESTED, ['dupe']),
        candidate('project-root', ROOT_MANIFEST, ['dupe']),
      ],
      [candidate('selected-project', NESTED, ['dupe']), candidate('user', USER_MANIFEST, ['dupe'])],
      [
        candidate('project-root', ROOT_MANIFEST, ['dupe']),
        candidate('user', USER_MANIFEST, ['dupe']),
      ],
    ]) {
      const error = expectDestinationError(
        selectManifestDestination(snapshot(candidates), {
          names: ['dupe'],
          scope: 'project',
          mode: 'save',
        }),
        'manifest-owner-ambiguous',
        'usage',
      );
      expect(new Set(error.paths)).toEqual(new Set(candidates.map((item) => item.path)));
    }

    expectDestinationError(
      selectManifestDestination(
        snapshot([
          candidate('selected-project', NESTED, ['one']),
          candidate('user', USER_MANIFEST, ['two']),
        ]),
        { names: ['one', 'two'], scope: 'project', mode: 'save' },
      ),
      'manifest-owner-split',
      'usage',
    );
  });

  test('preflights invalid candidates and never creates a destination for an absent removal', () => {
    expectDestinationError(
      selectManifestDestination(
        snapshot([
          candidate('selected-project', NESTED, ['owned']),
          candidate('project-root', ROOT_MANIFEST, [], 'malformed'),
        ]),
        { names: ['owned'], scope: 'project', mode: 'save' },
      ),
      'manifest-candidate-invalid',
      'state',
    );

    expect(
      expectDestination(
        selectManifestDestination(snapshot([]), {
          names: ['missing'],
          scope: 'project',
          mode: 'remove',
        }),
      ),
    ).toMatchObject({ kind: 'absent', role: null, path: null });
    expect(
      expectDestination(
        selectManifestDestination(snapshot([]), {
          names: ['new-user'],
          scope: 'user',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'new', role: 'user', path: USER_MANIFEST });
  });

  test('binds explicit selection to the snapshot and treats a preflighted absent removal as absent', () => {
    expectDestinationError(
      selectManifestDestination(snapshot([]), {
        names: ['new'],
        scope: 'project',
        mode: 'save',
        explicitFile: '/tmp/unpreflighted.toml',
      }),
      'manifest-explicit-selector-mismatch',
      'usage',
    );
    expectDestinationError(
      selectManifestDestination(snapshot([], '/tmp/preflighted.toml'), {
        names: ['new'],
        scope: 'project',
        mode: 'save',
        explicitFile: '/tmp/different.toml',
      }),
      'manifest-explicit-selector-mismatch',
      'usage',
    );
    expect(
      expectDestination(
        selectManifestDestination(snapshot([], '/tmp/preflighted.toml'), {
          names: ['new'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toEqual({
      kind: 'new',
      role: 'explicit',
      path: '/tmp/preflighted.toml',
      names: ['new'],
    });
    expect(
      expectDestination(
        selectManifestDestination(snapshot([], '/tmp/preflighted.toml'), {
          names: ['missing'],
          scope: 'project',
          mode: 'remove',
          explicitFile: '/tmp/preflighted.toml',
        }),
      ),
    ).toEqual({ kind: 'absent', role: null, path: null, names: ['missing'] });
  });

  test('marks a structurally canonical but semantically invalid candidate unsafe', async () => {
    const duplicateNames = manifest(['duplicate', 'duplicate']);
    const discovered = expectSnapshot(
      await discoverArtifactSnapshot(
        new FakeDiscoveryPorts({ [ROOT_MANIFEST]: { kind: 'file', text: duplicateNames } }),
        context(ROOT, ROOT, ROOT_MANIFEST),
      ),
    );
    expect(discovered.candidates).toEqual([
      candidate('selected-project', ROOT_MANIFEST, ['duplicate', 'duplicate'], null),
    ]);
    expectDestinationError(
      selectManifestDestination(discovered, {
        names: ['duplicate'],
        scope: 'project',
        mode: 'save',
      }),
      'manifest-candidate-invalid',
      'state',
    );
  });

  test('adds new declarations to an existing scope destination without misreporting a new file', () => {
    expect(
      expectDestination(
        selectManifestDestination(snapshot([candidate('project-root', ROOT_MANIFEST, ['other'])]), {
          names: ['new'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'existing', role: 'project-root', path: ROOT_MANIFEST });
    expect(
      expectDestination(
        selectManifestDestination(snapshot([candidate('user', USER_MANIFEST, ['other'])]), {
          names: ['new'],
          scope: 'user',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'existing', role: 'user', path: USER_MANIFEST });

    expectDestinationError(
      selectManifestDestination(
        snapshot([candidate('explicit', '/tmp/team.toml', [], 'mixed')], '/tmp/team.toml'),
        {
          names: ['new'],
          scope: 'project',
          mode: 'save',
          explicitFile: '/tmp/team.toml',
        },
      ),
      'manifest-candidate-invalid',
      'state',
    );
  });
});
