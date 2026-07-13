import { describe, expect, test } from 'bun:test';
import {
  MANIFEST_SHAPES,
  classifyManifestSource,
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from '../../src/artifacts/index.ts';

const expectNormalized = (source: string) => {
  const document = readManifestSource(source);
  expect(document.ok).toBe(true);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.error.message);
  return normalized.value;
};

const expectNormalizationError = (source: string) => {
  const document = readManifestSource(source);
  expect(document.ok).toBe(true);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  expect(normalized.ok).toBe(false);
  if (normalized.ok) throw new Error('expected normalization failure');
  expect(normalized.error).toMatchObject({ code: 'manifest-state', exitCode: 3 });
};

describe('manifest authority', () => {
  test('classifies the closed seven-shape set and reads only supported shapes', () => {
    expect(MANIFEST_SHAPES).toEqual([
      'canonical',
      'legacy',
      'mixed',
      'empty',
      'malformed',
      'unknown',
      'future',
    ]);
    expect(Object.isFrozen(MANIFEST_SHAPES)).toBe(true);
    const fixtures = [
      ['canonical', 'version = 1\n'],
      ['legacy', 'tool = "codex"\n'],
      ['mixed', 'version = 1\ntool = "codex"\n'],
      ['empty', '# comment\n'],
      ['malformed', 'version = [\n'],
      ['unknown', 'version = "1"\n'],
      ['unknown', 'version = 1.0\n'],
      ['unknown', 'version = 1e0\n'],
      ['unknown', 'version = 2.0\n'],
      ['canonical', 'version = 0x1\n'],
      ['canonical', 'version = 0o1\n'],
      ['canonical', 'version = 0b1\n'],
      ['canonical', 'version = +1\n'],
      ['canonical', 'version = 0x0_1\n'],
      ['canonical', 'version = 0o0_1\n'],
      ['canonical', 'version = 0b0_1\n'],
      ['canonical', '"version" = 1\n'],
      ['canonical', "'version' = 0x1\n"],
      ['canonical', '"ver\\u0073ion" = 0b1\n'],
      ['future', 'version = 2\n'],
      ['future', 'version = 0x2\n'],
      ['future', 'version = 0o2\n'],
      ['future', 'version = 0b10\n'],
      ['future', 'version = +2\n'],
      ['future', 'version = 1_0\n'],
      ['future', '"ver\\u0073ion" = 0x2\n'],
    ] as const;
    for (const [shape, source] of fixtures) {
      expect(classifyManifestSource(source)).toBe(shape);
      expect(readManifestSource(source).ok).toBe(shape === 'canonical' || shape === 'legacy');
    }
  });

  test('normalizes strict declarations into owned canonical identity', () => {
    const source = `version = 1
[defaults]
tools = ["codex", "claude-code"]
scope = "project"
path = "./skills"
[registry]
default = "github.com/acme"
[[skills]]
name = "review"
source = "ssh://git@github.com/acme/tools.git//skills/review"
ref = "release/v1"
tools = ["opencode", "codex"]
placement = "copy"
`;
    const normalized = expectNormalized(source);
    expect(normalized).toEqual({
      version: 1,
      defaults: {
        tools: ['claude-code', 'codex'],
        scope: 'project',
        path: './skills',
      },
      registry: { default: 'github.com/acme' },
      skills: [
        {
          name: 'review',
          source: { host: 'github.com', repository: 'acme/tools', path: 'skills/review' },
          ref: 'release/v1',
          tools: ['codex', 'opencode'],
          scope: 'project',
          placement: 'copy',
          path: null,
        },
      ],
    });
    expect(Object.isFrozen(normalized.skills[0]?.source)).toBe(true);
  });

  test('rejects duplicate tools, unsafe refs, sources, registries, and paths without leaking input', () => {
    const manifest = (line: string) => `version = 1
[defaults]
tools = ["codex"]
scope = "project"
${line}
[[skills]]
name = "review"
source = "acme/tools//skills/review"
`;
    expectNormalizationError(
      manifest('').replace('tools = ["codex"]', 'tools = ["codex", "codex"]'),
    );
    expectNormalizationError(`${manifest('')}ref = "a..b"\n`);
    expectNormalizationError(manifest('path = "./a/../skills"'));
    expectNormalizationError(manifest('path = "./C:relative"'));
    expectNormalizationError(
      manifest('path = "~/C:relative"').replace('scope = "project"', 'scope = "user"'),
    );
    expectNormalizationError(manifest('[registry]\ndefault = "https://github.com/acme"'));
    expectNormalizationError(
      manifest('').replace(
        'acme/tools//skills/review',
        'https://github.com/acme/tools//skills/../review',
      ),
    );
    expectNormalizationError(
      'tool = "codex"\nscope = "project"\n[registry]\ndefault = "https://github.com/acme/../other"\n',
    );

    const secret = manifest('').replace(
      'acme/tools//skills/review',
      'https://P17_CANARY@example.com/acme/tools',
    );
    const document = readManifestSource(secret);
    if (!document.ok) throw new Error(document.error.message);
    const result = normalizeManifestDocument(document.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_CANARY');
  });

  test('retains exact legacy source and purely migrates safe values', () => {
    const source =
      '# retained\r\ntool = "codex"\r\nscope = "project"\r\npath = "./skills"\r\n[registry]\r\ndefault = "https://github.com/acme"\r\n';
    const document = readManifestSource(source);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    expect(document.value).toMatchObject({
      shape: 'legacy',
      migrationPending: true,
      source,
      declaredNames: [],
    });
    expect(normalizeManifestDocument(document.value)).toEqual({
      ok: true,
      value: {
        version: 1,
        defaults: { tools: ['codex'], scope: 'project', path: './skills' },
        registry: { default: 'github.com/acme' },
        skills: [],
      },
    });
  });

  test('projects formatting-independent, frozen JSON semantics in schema order', () => {
    const first = expectNormalized(`version = 1
[defaults]
tools = ["codex", "claude-code"]
scope = "project"
[[skills]]
name = "zeta"
source = "acme/tools//zeta"
[[skills]]
name = "alpha"
source = "acme/tools//alpha"
`);
    const second = expectNormalized(`version = 1
[defaults]
scope = "project"
tools = ["claude-code", "codex"]
[[skills]]
source = "acme/tools//alpha"
name = "alpha"
[[skills]]
source = "acme/tools//zeta"
name = "zeta"
`);
    const firstProjection = projectManifestSemantics(first);
    const secondProjection = projectManifestSemantics(second);
    expect(firstProjection).toEqual(secondProjection);
    expect(JSON.stringify(firstProjection)).toBe(JSON.stringify(secondProjection));
    expect(firstProjection.skills.map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
    expect(Object.isFrozen(firstProjection.skills[0]?.source)).toBe(true);

    const names = ['z', 'aa', 'a_b', 'a.b', 'a-b', 'a', 'Z', 'A'];
    const ordered = expectNormalized(`version = 1
[defaults]
tools = ["codex"]
scope = "project"
${names
  .map(
    (name) => `[[skills]]
name = "${name}"
source = "acme/tools//skills/${name}"`,
  )
  .join('\n')}
`);
    expect(projectManifestSemantics(ordered).skills.map((skill) => skill.name)).toEqual([
      'A',
      'Z',
      'a',
      'a-b',
      'a.b',
      'a_b',
      'aa',
      'z',
    ]);
  });
});
