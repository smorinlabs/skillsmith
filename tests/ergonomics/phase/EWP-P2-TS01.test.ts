import { describe, expect, test } from 'bun:test';

const ARTIFACTS_MODULE = '../../../packages/core/src/artifacts/index.ts';
const CORE_MODULE = '../../../packages/core/src/index.ts';

const MANIFEST_SHAPES = [
  'canonical',
  'legacy',
  'mixed',
  'empty',
  'malformed',
  'unknown',
  'future',
] as const;

type ManifestShape = (typeof MANIFEST_SHAPES)[number];

interface ManifestStateError {
  readonly code: string;
  readonly exitCode: number;
  readonly shape?: ManifestShape;
  readonly field?: string;
  readonly message: string;
}

type ManifestResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ManifestStateError };

interface ReadableManifestDocument {
  readonly shape: 'canonical' | 'legacy';
  readonly migrationPending: boolean;
  readonly source: string;
  readonly [key: string]: unknown;
}

interface CanonicalSourceIdentity {
  readonly host: string;
  readonly repository: string;
  readonly path: string | null;
}

interface NormalizedManifestDeclaration {
  readonly name: string;
  readonly source: CanonicalSourceIdentity;
  readonly ref: string | null;
  readonly tools: readonly string[];
  readonly scope: 'user' | 'project';
  readonly placement: 'symlink' | 'copy';
  readonly path: string | null;
}

interface NormalizedManifestV1 {
  readonly version: 1;
  readonly defaults?: {
    readonly tools?: readonly string[];
    readonly scope?: 'user' | 'project';
    readonly path?: string | null;
  };
  readonly registry?: { readonly default?: string } | null;
  readonly skills: readonly NormalizedManifestDeclaration[];
}

type ManifestSemanticProjectionV1 = Readonly<Record<string, unknown>>;

interface ManifestApi {
  readonly MANIFEST_VERSION: number;
  readonly MANIFEST_SHAPES: readonly string[];
  classifyManifestSource(source: string): ManifestShape;
  readManifestSource(source: string): ManifestResult<ReadableManifestDocument>;
  normalizeManifestDocument(
    document: ReadableManifestDocument,
  ): ManifestResult<NormalizedManifestV1>;
  projectManifestSemantics(manifest: NormalizedManifestV1): ManifestSemanticProjectionV1;
}

type ModuleLoad =
  | { readonly ok: true; readonly module: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly message: string };

const loadModule = async (specifier: string): Promise<ModuleLoad> => {
  try {
    return {
      ok: true,
      module: (await import(specifier)) as Readonly<Record<string, unknown>>,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const requireManifestApi = async (): Promise<ManifestApi> => {
  const loaded = await loadModule(ARTIFACTS_MODULE);
  expect(
    loaded.ok,
    loaded.ok ? undefined : `planned public manifest authority is unavailable: ${loaded.message}`,
  ).toBeTrue();
  if (!loaded.ok)
    throw new Error(`planned public manifest authority is unavailable: ${loaded.message}`);

  const required = [
    'classifyManifestSource',
    'readManifestSource',
    'normalizeManifestDocument',
    'projectManifestSemantics',
  ] as const;
  const missing = required.filter((name) => typeof loaded.module[name] !== 'function');
  expect(missing, 'planned public manifest functions are incomplete').toEqual([]);
  expect(loaded.module.MANIFEST_VERSION, 'manifest version authority').toBe(1);
  expect(loaded.module.MANIFEST_SHAPES, 'manifest shape authority').toEqual(MANIFEST_SHAPES);
  return loaded.module as unknown as ManifestApi;
};

const tomlString = (value: string): string => JSON.stringify(value);

const tomlArray = (values: readonly string[]): string =>
  `[${values.map((value) => tomlString(value)).join(', ')}]`;

interface SkillFixture {
  readonly name?: string;
  readonly source?: string;
  readonly ref?: string | null;
  readonly tools?: readonly string[] | null;
  readonly scope?: 'user' | 'project' | null;
  readonly placement?: 'symlink' | 'copy' | null;
  readonly path?: string | null;
  readonly extra?: string;
}

const skillBlock = (input: SkillFixture = {}): string => {
  const lines = [
    '[[skills]]',
    `name = ${tomlString(input.name ?? 'review')}`,
    `source = ${tomlString(input.source ?? 'acme/tools//skills/review')}`,
  ];
  if (input.ref !== undefined && input.ref !== null) lines.push(`ref = ${tomlString(input.ref)}`);
  if (input.tools !== undefined && input.tools !== null)
    lines.push(`tools = ${tomlArray(input.tools)}`);
  if (input.scope !== undefined && input.scope !== null)
    lines.push(`scope = ${tomlString(input.scope)}`);
  if (input.placement !== undefined && input.placement !== null)
    lines.push(`placement = ${tomlString(input.placement)}`);
  if (input.path !== undefined && input.path !== null)
    lines.push(`path = ${tomlString(input.path)}`);
  if (input.extra !== undefined) lines.push(input.extra);
  return `${lines.join('\n')}\n`;
};

interface CanonicalFixture {
  readonly tools?: readonly string[] | null;
  readonly scope?: 'user' | 'project' | null;
  readonly path?: string | null;
  readonly registry?: string | null;
  readonly skills?: readonly SkillFixture[];
  readonly extraRoot?: string;
}

const canonicalManifest = (input: CanonicalFixture = {}): string => {
  const lines = ['version = 1'];
  const tools = input.tools === undefined ? ['codex', 'claude-code'] : input.tools;
  const scope = input.scope === undefined ? 'project' : input.scope;
  const path = input.path === undefined ? null : input.path;
  if (input.extraRoot !== undefined) lines.push(input.extraRoot);
  if (tools !== null || scope !== null || path !== null) {
    lines.push('', '[defaults]');
    if (tools !== null) lines.push(`tools = ${tomlArray(tools)}`);
    if (scope !== null) lines.push(`scope = ${tomlString(scope)}`);
    if (path !== null) lines.push(`path = ${tomlString(path)}`);
  }
  const registry = input.registry === undefined ? 'github.com/acme' : input.registry;
  if (registry !== null) lines.push('', '[registry]', `default = ${tomlString(registry)}`);
  const skills = input.skills ?? [{}];
  for (const entry of skills) lines.push('', skillBlock(entry).trimEnd());
  return `${lines.join('\n')}\n`;
};

const singleSkillManifest = (entry: SkillFixture, defaults = true): string =>
  canonicalManifest({
    ...(defaults ? {} : { tools: null, scope: null }),
    registry: null,
    skills: [entry],
  });

const guardValidToml = (fixtures: readonly string[]): void => {
  for (const source of fixtures) {
    try {
      Bun.TOML.parse(source);
    } catch (error) {
      throw new Error(
        `fixture must be syntactically valid TOML:\n${source}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

const expectStateError = <T>(
  result: ManifestResult<T>,
  shape?: ManifestShape,
): ManifestStateError => {
  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error('expected manifest state error');
  expect(result.error.code.length).toBeGreaterThan(0);
  expect(result.error.exitCode).toBe(3);
  if (shape !== undefined) expect(result.error.shape).toBe(shape);
  return result.error;
};

const read = (api: ManifestApi, source: string): ReadableManifestDocument => {
  const result = api.readManifestSource(source);
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const normalize = (api: ManifestApi, source: string): NormalizedManifestV1 => {
  const result = api.normalizeManifestDocument(read(api, source));
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const assertRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value as Record<string, unknown>))
    assertRecursivelyFrozen(child, seen);
};

const assertJsonValue = (value: unknown, seen = new Set<object>()): void => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  expect(typeof value).toBe('object');
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(value instanceof Map).toBeFalse();
  expect(value instanceof Set).toBeFalse();
  expect(value instanceof Error).toBeFalse();
  for (const child of Object.values(value as Record<string, unknown>)) assertJsonValue(child, seen);
};

describe('EWP-P2-TS01', () => {
  test('publishes one closed public manifest API', async () => {
    const api = await requireManifestApi();
    const core = await loadModule(CORE_MODULE);
    expect(
      core.ok,
      core.ok ? undefined : `public core module failed to load: ${core.message}`,
    ).toBeTrue();
    if (!core.ok) throw new Error(core.message);

    for (const name of [
      'classifyManifestSource',
      'readManifestSource',
      'normalizeManifestDocument',
      'projectManifestSemantics',
    ] as const) {
      expect(core.module[name], `root public export ${name}`).toBe(api[name]);
    }
    expect(core.module.MANIFEST_VERSION).toBe(api.MANIFEST_VERSION);
    expect(core.module.MANIFEST_SHAPES).toBe(api.MANIFEST_SHAPES);
    expect(Object.isFrozen(api.MANIFEST_SHAPES)).toBeTrue();
  });

  test('classifies seven shapes before normalization and reads only canonical v1 or exact legacy', async () => {
    const fixtures: ReadonlyArray<{
      readonly shape: ManifestShape;
      readonly source: string;
      readonly readable: boolean;
    }> = [
      { shape: 'canonical', source: 'version = 1\n', readable: true },
      { shape: 'canonical', source: canonicalManifest(), readable: true },
      { shape: 'legacy', source: 'tool = "codex"\n', readable: true },
      { shape: 'legacy', source: '[registry]\ndefault = "github.com/acme"\n', readable: true },
      { shape: 'mixed', source: 'version = 1\ntool = "codex"\n', readable: false },
      {
        shape: 'mixed',
        source: 'version = 1\ntool = "codex"\n[defaults]\nscope = "project"\n',
        readable: false,
      },
      { shape: 'empty', source: '', readable: false },
      { shape: 'empty', source: ' \n\t# comment only\n', readable: false },
      { shape: 'malformed', source: 'version = [\n', readable: false },
      { shape: 'unknown', source: 'version = "1"\n', readable: false },
      { shape: 'unknown', source: 'version = 1.0\n', readable: false },
      { shape: 'unknown', source: 'version = 1e0\n', readable: false },
      { shape: 'unknown', source: 'version = 2.0\n', readable: false },
      { shape: 'canonical', source: 'version = 0x1\n', readable: true },
      { shape: 'canonical', source: 'version = 0o1\n', readable: true },
      { shape: 'canonical', source: 'version = 0b1\n', readable: true },
      { shape: 'canonical', source: '"version" = 1\n', readable: true },
      { shape: 'canonical', source: "'version' = 0x1\n", readable: true },
      { shape: 'canonical', source: '"ver\\u0073ion" = 0b1\n', readable: true },
      { shape: 'unknown', source: 'mystery = true\n', readable: false },
      {
        shape: 'unknown',
        source: 'version = 1\n[defaults]\nscope = "project"\nmystery = true\n',
        readable: false,
      },
      {
        shape: 'unknown',
        source: 'version = 1\n[defaults]\ntools = "codex"\n',
        readable: false,
      },
      {
        shape: 'unknown',
        source: 'version = 1\n[registry]\ndefault = ["github.com/acme"]\n',
        readable: false,
      },
      {
        shape: 'unknown',
        source: 'version = 1\n[skills]\nname = "review"\nsource = "acme/tools"\n',
        readable: false,
      },
      { shape: 'future', source: 'version = 2\n', readable: false },
      { shape: 'future', source: 'version = 0x2\n', readable: false },
      { shape: 'future', source: 'version = 0o2\n', readable: false },
      { shape: 'future', source: 'version = 0b10\n', readable: false },
      { shape: 'future', source: '"ver\\u0073ion" = 0x2\n', readable: false },
    ];
    guardValidToml(
      fixtures.filter((item) => item.shape !== 'malformed').map((item) => item.source),
    );
    expect(() => Bun.TOML.parse('version = [\n')).toThrow();
    const api = await requireManifestApi();

    for (const fixture of fixtures) {
      expect(api.classifyManifestSource(fixture.source), fixture.source).toBe(fixture.shape);
      const result = api.readManifestSource(fixture.source);
      expect(result.ok, fixture.source).toBe(fixture.readable);
      if (fixture.readable) {
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value).toMatchObject({
          shape: fixture.shape,
          migrationPending: fixture.shape === 'legacy',
          source: fixture.source,
        });
        expect(Object.isFrozen(result.value)).toBeTrue();
      } else {
        expectStateError(result, fixture.shape);
      }
    }
  });

  test('strictly normalizes defaults, declarations, tools, scope, placement, and ownership', async () => {
    const valid = canonicalManifest({
      skills: [
        {},
        {
          name: 'lint',
          source: 'acme/tools//skills/lint',
          ref: 'release/v1',
          tools: ['opencode', 'codex'],
          scope: 'user',
          placement: 'copy',
          path: '~/skills/lint',
        },
      ],
    });
    const invalid = [
      canonicalManifest({ skills: [{}, {}] }),
      canonicalManifest({ skills: [{}] }).replace('name = "review"\n', ''),
      canonicalManifest({ skills: [{}] }).replace('source = "acme/tools//skills/review"\n', ''),
      canonicalManifest({ tools: [] }),
      canonicalManifest({ tools: ['codex', 'codex'] }),
      canonicalManifest({ skills: [{ tools: [] }] }),
      canonicalManifest({ skills: [{ tools: ['codex', 'codex'] }] }),
      canonicalManifest({ tools: ['ghost'] }),
      singleSkillManifest({ tools: null, scope: 'project' }, false),
      singleSkillManifest({ tools: ['codex'], scope: null }, false),
      canonicalManifest().replace('[[skills]]', '[[skills]]\nplacement = "hardlink"'),
    ];
    const unreadable = [
      canonicalManifest({ skills: [{ extra: 'mystery = true' }] }),
      canonicalManifest({ extraRoot: 'mystery = true' }),
    ];
    guardValidToml([valid, ...invalid, ...unreadable]);
    const api = await requireManifestApi();
    const normalized = normalize(api, valid);

    expect(normalized).toMatchObject({ version: 1 });
    expect(normalized.defaults?.tools).toEqual(['claude-code', 'codex']);
    expect(normalized.skills[0]).toMatchObject({
      name: 'review',
      tools: ['claude-code', 'codex'],
      scope: 'project',
      ref: null,
      placement: 'symlink',
      path: null,
    });
    expect(normalized.skills[1]).toMatchObject({
      name: 'lint',
      tools: ['codex', 'opencode'],
      scope: 'user',
      placement: 'copy',
      path: '~/skills/lint',
    });
    assertRecursivelyFrozen(normalized);

    const reordered = canonicalManifest({
      tools: ['claude-code', 'codex'],
      skills: [
        {},
        {
          name: 'lint',
          source: 'acme/tools//skills/lint',
          ref: 'release/v1',
          tools: ['codex', 'opencode'],
          scope: 'user',
          placement: 'copy',
          path: '~/skills/lint',
        },
      ],
    });
    expect(normalize(api, reordered)).toEqual(normalized);
    for (const source of invalid)
      expectStateError(api.normalizeManifestDocument(read(api, source)));
    for (const source of unreadable) {
      expect(api.classifyManifestSource(source)).toBe('unknown');
      expectStateError(api.readManifestSource(source), 'unknown');
    }
  });

  test('enforces exact portable name and requested-ref grammar without Git authority', async () => {
    const positiveNames = ['a', 'review.skill_v2-x', `a${'b'.repeat(127)}`];
    const negativeNames = [
      '',
      `a${'b'.repeat(128)}`,
      '.review',
      '-review',
      'review.',
      '.',
      '..',
      'review skill',
      'review\ncontrol',
      'a/b',
      'a\\b',
      'C:review',
      '\\\\server\\review',
    ];
    const positiveRefs = [
      'main',
      'release/v1',
      'v1.2.3',
      'a'.repeat(40),
      `a${'b'.repeat(254)}`,
      `${'é'.repeat(127)}a`,
    ];
    const negativeRefs = [
      '',
      `a${'b'.repeat(255)}`,
      'é'.repeat(128),
      '-main',
      '/main',
      'main/',
      'main.',
      '@',
      '.foo',
      'foo/.bar',
      'x.lock',
      'foo/x.lock',
      'white space',
      'tab\tref',
      'non\u00a0breaking',
      'control\nref',
      'delete\u007fref',
      'a..b',
      'a@{b',
      'a//b',
      ...['~', '^', ':', '?', '*', '[', '\\'].map((token) => `a${token}b`),
    ];
    const refManifest = (ref: string): string =>
      singleSkillManifest({ ref }).replaceAll('\u007f', '\\u007F');
    const fixtures = [
      ...positiveNames.map((name) => singleSkillManifest({ name })),
      ...negativeNames.map((name) => singleSkillManifest({ name })),
      ...positiveRefs.map((ref) => refManifest(ref)),
      ...negativeRefs.map((ref) => refManifest(ref)),
    ];
    guardValidToml(fixtures);
    expect(new TextEncoder().encode(`${'é'.repeat(127)}a`)).toHaveLength(255);
    expect(new TextEncoder().encode('é'.repeat(128))).toHaveLength(256);
    const api = await requireManifestApi();

    for (const name of positiveNames)
      expect(normalize(api, singleSkillManifest({ name })).skills[0]?.name).toBe(name);
    for (const name of negativeNames)
      expectStateError(api.normalizeManifestDocument(read(api, singleSkillManifest({ name }))));
    for (const ref of positiveRefs)
      expect(normalize(api, refManifest(ref)).skills[0]?.ref).toBe(ref);
    expect(normalize(api, singleSkillManifest({ ref: null })).skills[0]?.ref).toBeNull();
    for (const ref of negativeRefs)
      expectStateError(api.normalizeManifestDocument(read(api, refManifest(ref))));
  });

  test('canonicalizes credential-free source and registry identity without retaining transport input', async () => {
    const equivalent = [
      'https://github.com/acme/tools.git//skills/review',
      'ssh://git@github.com/acme/tools.git//skills/review',
      'git@github.com:acme/tools.git//skills/review',
      'github.com/acme/tools//skills/review',
    ];
    const sensitiveBadSources = [
      'https://P17_SOURCE_USERINFO@example.com/acme/tools//skills/review',
      'https://user:P17_SOURCE_PASSWORD@example.com/acme/tools//skills/review',
      'https://example.com/acme/tools?token=P17_SOURCE_QUERY//skills/review',
      'https://example.com/acme/tools#P17_SOURCE_FRAGMENT//skills/review',
      'https://user%40P17_SOURCE_ENCODED_AT@example.com/acme/tools//skills/review',
      'https://user%3AP17_SOURCE_ENCODED_COLON@example.com/acme/tools//skills/review',
      'https://example.com/acme/tools/%2FP17_SOURCE_ENCODED_SLASH//skills/review',
      'https://example.com/acme/tools/%3FP17_SOURCE_ENCODED_QUERY//skills/review',
      'https://example.com/acme/tools/%23P17_SOURCE_ENCODED_FRAGMENT//skills/review',
    ];
    const badSources = [
      ...sensitiveBadSources,
      'http://example.com/acme/tools//skills/review',
      'git://example.com/acme/tools//skills/review',
      'file:///tmp/tools//skills/review',
      'https:///acme/tools//skills/review',
      'acme/tools//../review',
      'acme/tools//skills/../review',
      'acme/tools//skills//review',
      'acme/tools//./skills/review',
      'acme/tools//C:/review',
      'acme/tools//skills/control\npath',
    ];
    const sensitiveBadRegistries = [
      'https://P17_REGISTRY_USERINFO@github.com/acme',
      'github.com/acme?token=P17_REGISTRY_QUERY',
      'github.com/acme#P17_REGISTRY_FRAGMENT',
      'P17_REGISTRY_ENCODED_AT%40github.com/acme',
      'github.com/acme%2FP17_REGISTRY_ENCODED_SLASH',
      'github.com/acme%3FP17_REGISTRY_ENCODED_QUERY',
      'github.com/acme%23P17_REGISTRY_ENCODED_FRAGMENT',
    ];
    const badRegistries = [
      ...sensitiveBadRegistries,
      'http://github.com/acme',
      'https://github.com/acme',
      'ssh://github.com/acme',
      'github.com/../acme',
    ];
    const fixtures = [
      ...equivalent.map((source) => singleSkillManifest({ source })),
      ...badSources.map((source) => singleSkillManifest({ source })),
      canonicalManifest({ registry: 'github.com/acme' }),
      ...badRegistries.map((registry) => canonicalManifest({ registry })),
    ];
    guardValidToml(fixtures);
    const api = await requireManifestApi();

    const identities = equivalent.map(
      (source) => normalize(api, singleSkillManifest({ source })).skills[0]?.source,
    );
    expect(identities).toEqual(
      Array.from({ length: equivalent.length }, () => ({
        host: 'github.com',
        repository: 'acme/tools',
        path: 'skills/review',
      })),
    );
    for (const source of badSources) {
      const result = api.normalizeManifestDocument(read(api, singleSkillManifest({ source })));
      const error = expectStateError(result);
      if (sensitiveBadSources.includes(source)) {
        const serializedError = JSON.stringify(error);
        expect(serializedError).not.toContain(source);
        const canary = source.match(/P17_[A-Z_]+/)?.[0];
        if (canary !== undefined) expect(serializedError).not.toContain(canary);
      }
    }
    expect(normalize(api, canonicalManifest({ registry: 'github.com/acme' })).registry).toEqual({
      default: 'github.com/acme',
    });
    for (const registry of badRegistries) {
      const error = expectStateError(
        api.normalizeManifestDocument(read(api, canonicalManifest({ registry }))),
      );
      if (sensitiveBadRegistries.includes(registry)) {
        const serializedError = JSON.stringify(error);
        expect(serializedError).not.toContain(registry);
        const canary = registry.match(/P17_[A-Z_]+/)?.[0];
        if (canary !== undefined) expect(serializedError).not.toContain(canary);
      }
    }
  });

  test('validates portable paths independent of host operating system', async () => {
    const positive = [
      canonicalManifest({ scope: 'project', path: './custom/skills' }),
      canonicalManifest({
        scope: 'user',
        path: '~/custom/skills',
        skills: [{ scope: 'user', path: '~/skills/review' }],
      }),
      singleSkillManifest({ source: 'acme/tools//skills/review' }),
    ];
    const negativePaths = [
      '/opt/skills',
      'C:/skills',
      'C:\\skills',
      '\\\\server\\skills',
      '../skills',
      './a/../skills',
      './a//skills',
      './a/./skills',
      './C:relative',
      './.skillsmith/store/x',
      './placements.json',
      './.skillsmith/dev/x',
    ];
    const negative = [
      ...negativePaths.map((path) => canonicalManifest({ scope: 'project', path })),
      ...negativePaths.map((path) => canonicalManifest({ skills: [{ scope: 'project', path }] })),
      canonicalManifest({ scope: 'user', path: './project-only' }),
      canonicalManifest({ scope: 'project', path: '~/user-only' }),
      canonicalManifest({ skills: [{ scope: 'user', path: './project-only' }] }),
      canonicalManifest({ skills: [{ scope: 'project', path: '~/user-only' }] }),
      canonicalManifest({ scope: 'user', path: '~/C:relative' }),
      canonicalManifest({ skills: [{ scope: 'user', path: '~/C:relative' }] }),
    ];
    guardValidToml([...positive, ...negative]);
    const api = await requireManifestApi();

    expect(normalize(api, positive[0] ?? '').defaults?.path).toBe('./custom/skills');
    expect(normalize(api, positive[1] ?? '').defaults?.path).toBe('~/custom/skills');
    expect(normalize(api, positive[2] ?? '').skills[0]?.source.path).toBe('skills/review');
    for (const source of negative)
      expectStateError(api.normalizeManifestDocument(read(api, source)));
  });

  test('purely maps exact legacy documents while blocked migration remains readable', async () => {
    const safe = [
      'tool = "codex"\nscope = "project"\npath = "./custom/skills"\n[registry]\ndefault = "https://github.com/acme"\n',
      '# retained\r\nscope = "project"\r\ntool = "codex"\r\npath = "./custom/skills"\r\n[registry]\r\ndefault = "https://github.com/acme"\r\n',
    ];
    const blocked = [
      'tool = "codex"\nscope = "project"\npath = "/opt/skills"\n',
      'tool = "codex"\nscope = "project"\npath = "../skills"\n',
      'tool = "codex"\nscope = "system"\n',
      'tool = "codex"\nscope = "project"\n[registry]\ndefault = "http://github.com/acme"\n',
      'tool = "codex"\nscope = "project"\n[registry]\ndefault = "https://token@github.com/acme"\n',
    ];
    guardValidToml([...safe, ...blocked]);
    const api = await requireManifestApi();

    const safeDocuments = safe.map((source) => read(api, source));
    safeDocuments.forEach((document, index) => {
      expect(document).toMatchObject({
        shape: 'legacy',
        migrationPending: true,
        source: safe[index],
      });
    });
    const normalized = safeDocuments.map((document) => {
      const result = api.normalizeManifestDocument(document);
      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    expect(api.projectManifestSemantics(normalized[1] as NormalizedManifestV1)).toEqual(
      api.projectManifestSemantics(normalized[0] as NormalizedManifestV1),
    );
    expect(normalized[0]).toMatchObject({
      version: 1,
      defaults: { tools: ['codex'], scope: 'project', path: './custom/skills' },
      registry: { default: 'github.com/acme' },
      skills: [],
    });

    for (const source of blocked) {
      const document = read(api, source);
      expect(document).toMatchObject({ shape: 'legacy', migrationPending: true });
      const error = expectStateError(api.normalizeManifestDocument(document));
      expect(JSON.stringify(error)).not.toContain('token@');
    }
  });

  test('projects semantic equality and valid field mutations without hashing or lock data', async () => {
    const baseSkill: SkillFixture = {
      name: 'review',
      source: 'https://github.com/acme/tools.git//skills/review',
      ref: 'main',
      tools: ['codex', 'claude-code'],
      scope: 'project',
      placement: 'copy',
      path: './custom/review',
    };
    const lintSkill: SkillFixture = {
      name: 'lint',
      source: 'acme/tools//skills/lint',
      ref: 'v1.0.0',
      tools: ['codex'],
      scope: 'project',
      placement: 'symlink',
      path: './custom/lint',
    };
    const base = canonicalManifest({
      tools: ['codex', 'claude-code'],
      scope: 'project',
      path: './defaults',
      registry: 'github.com/acme',
      skills: [baseSkill, lintSkill],
    });
    const formattingEquivalent = [
      canonicalManifest({
        tools: ['claude-code', 'codex'],
        scope: 'project',
        path: './defaults',
        registry: 'github.com/acme',
        skills: [lintSkill, baseSkill],
      }),
      base.replaceAll('\n', '\r\n').replace('version = 1', '# heading\r\nversion = 1'),
    ];
    const mutations = [
      canonicalManifest({ tools: ['codex'], path: './defaults', skills: [baseSkill, lintSkill] }),
      canonicalManifest({ scope: 'user', path: '~/defaults', skills: [baseSkill, lintSkill] }),
      canonicalManifest({ path: './other-defaults', skills: [baseSkill, lintSkill] }),
      canonicalManifest({
        registry: 'git.example.com/acme',
        path: './defaults',
        skills: [baseSkill, lintSkill],
      }),
      canonicalManifest({ path: './defaults', skills: [baseSkill] }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, name: 'review-2' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, source: 'acme/other//skills/review' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, ref: 'release/v2' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, tools: ['codex'] }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, scope: 'user', path: '~/review' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, placement: 'symlink' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [{ ...baseSkill, path: './other-review' }, lintSkill],
      }),
      canonicalManifest({
        path: './defaults',
        skills: [baseSkill, lintSkill, { name: 'extra', source: 'acme/tools//skills/extra' }],
      }),
    ];
    guardValidToml([base, ...formattingEquivalent, ...mutations]);
    const api = await requireManifestApi();
    const projection = api.projectManifestSemantics(normalize(api, base));
    const exactProjection = {
      version: 1,
      defaults: {
        tools: ['claude-code', 'codex'],
        scope: 'project',
        path: './defaults',
      },
      registry: { default: 'github.com/acme' },
      skills: [
        {
          name: 'lint',
          source: {
            host: 'github.com',
            repository: 'acme/tools',
            path: 'skills/lint',
          },
          ref: 'v1.0.0',
          tools: ['codex'],
          scope: 'project',
          placement: 'symlink',
          path: './custom/lint',
        },
        {
          name: 'review',
          source: {
            host: 'github.com',
            repository: 'acme/tools',
            path: 'skills/review',
          },
          ref: 'main',
          tools: ['claude-code', 'codex'],
          scope: 'project',
          placement: 'copy',
          path: './custom/review',
        },
      ],
    };
    expect(projection).toEqual(exactProjection);
    expect(JSON.stringify(projection)).toBe(JSON.stringify(exactProjection));

    for (const source of formattingEquivalent)
      expect(api.projectManifestSemantics(normalize(api, source))).toEqual(projection);
    for (const source of mutations)
      expect(api.projectManifestSemantics(normalize(api, source))).not.toEqual(projection);
    expect(api.projectManifestSemantics(normalize(api, base))).toEqual(projection);
    const codeUnitNames = ['z', 'aa', 'a_b', 'a.b', 'a-b', 'a', 'Z', 'A'];
    const codeUnitProjection = api.projectManifestSemantics(
      normalize(
        api,
        canonicalManifest({
          skills: codeUnitNames.map((name) => ({
            name,
            source: `acme/tools//skills/${name}`,
          })),
        }),
      ),
    );
    expect(
      (codeUnitProjection.skills as readonly NormalizedManifestDeclaration[]).map(
        (skill) => skill.name,
      ),
    ).toEqual(['A', 'Z', 'a', 'a-b', 'a.b', 'a_b', 'aa', 'z']);
    assertRecursivelyFrozen(projection);
    assertJsonValue(projection);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('cloneUrl');
    expect(serialized).not.toContain('manifest_hash');
    expect(serialized).not.toContain('digest');
    expect(serialized).not.toContain('lockfile');
  });

  test('hashes normalized manifest semantics independently from exact manifest bytes', async () => {
    const baseSkill: SkillFixture = {
      name: 'review',
      source: 'https://github.com/acme/tools.git//skills/review',
      ref: 'main',
      tools: ['codex', 'claude-code'],
      scope: 'project',
      placement: 'copy',
      path: './custom/review',
    };
    const lintSkill: SkillFixture = {
      name: 'lint',
      source: 'acme/tools//skills/lint',
      ref: 'v1.0.0',
      tools: ['codex'],
      scope: 'project',
      placement: 'symlink',
      path: './custom/lint',
    };
    const base = canonicalManifest({
      tools: ['codex', 'claude-code'],
      path: './defaults',
      skills: [baseSkill, lintSkill],
    });
    const formattingEquivalent = canonicalManifest({
      tools: ['claude-code', 'codex'],
      path: './defaults',
      skills: [lintSkill, baseSkill],
    })
      .replaceAll('\n', '\r\n')
      .replace('version = 1', '# formatting only\r\nversion = 1');
    const semanticMutations = [
      base.replace('ref = "main"', 'ref = "release/v2"'),
      base.replace('path = "./defaults"', 'path = "./other-defaults"'),
    ];
    guardValidToml([base, formattingEquivalent, ...semanticMutations]);

    const manifestApi = await requireManifestApi();
    const normalized = normalize(manifestApi, base);
    const equivalent = normalize(manifestApi, formattingEquivalent);
    const mutations = semanticMutations.map((source) => normalize(manifestApi, source));
    expect(manifestApi.projectManifestSemantics(equivalent)).toEqual(
      manifestApi.projectManifestSemantics(normalized),
    );
    for (const mutation of mutations)
      expect(manifestApi.projectManifestSemantics(mutation)).not.toEqual(
        manifestApi.projectManifestSemantics(normalized),
      );
    expect(formattingEquivalent).not.toBe(base);

    const loaded = await loadModule(ARTIFACTS_MODULE);
    expect(
      loaded.ok,
      loaded.ok ? undefined : `public artifact module failed to load: ${loaded.message}`,
    ).toBeTrue();
    if (!loaded.ok) throw new Error(loaded.message);
    const required = ['hashManifestSemantics', 'hashManifestBytes'] as const;
    const missing = required.filter((name) => typeof loaded.module[name] !== 'function');
    expect(missing, 'G2-02 manifest hash authority is incomplete').toEqual([]);

    const hashApi = loaded.module as unknown as {
      hashManifestSemantics(manifest: NormalizedManifestV1): string;
      hashManifestBytes(source: string | Uint8Array): string;
    };
    const semanticHash = hashApi.hashManifestSemantics(normalized);
    expect(hashApi.hashManifestSemantics(equivalent)).toBe(semanticHash);
    for (const mutation of mutations)
      expect(hashApi.hashManifestSemantics(mutation)).not.toBe(semanticHash);
    expect(hashApi.hashManifestBytes(formattingEquivalent)).not.toBe(
      hashApi.hashManifestBytes(base),
    );
  });
});
