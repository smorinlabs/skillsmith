import { describe, expect, test } from 'bun:test';
import {
  MANIFEST_SHAPES,
  classifyManifestSource,
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from '../../src/artifacts/index.ts';
import {
  fromManifestV1Dto,
  manifestV1Codec,
  toManifestV1Dto,
} from '../../src/artifacts/manifest-codec.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

  test('adapts the exact manifest v1 descriptor and generated canonical TOML', () => {
    expect(manifestV1Codec.descriptor).toEqual({
      id: 'manifest',
      version: 1,
      syntax: 'toml',
      discriminator: {
        kind: 'classifier',
        id: 'manifest-v1-or-legacy-project-config',
      },
      wireKind: null,
      presentation: { decode: 'human', encode: 'canonical' },
      terminalLf: true,
      unknownFields: 'reject-recursive',
      migrations: [
        {
          source: { kind: 'shape', id: 'legacy-project-config' },
          targetVersion: 1,
          mapperId: 'legacy-project-config-to-manifest-v1',
        },
      ],
      compatibility: 'conservative',
    });
    expect(Object.isFrozen(manifestV1Codec.descriptor.migrations[0]?.source)).toBeTrue();

    const canonical = `version = 1

[defaults]
tools = ["claude-code", "codex"]
scope = "project"
path = "./.agents/skills"

[registry]
default = "github.com/acme/skills"

[[skills]]
name = "lint"
source = "github.com/acme/skills//skills/lint"
ref = "v1.2.3"
placement = "copy"
path = "./.agents/lint"

[[skills]]
name = "review"
source = "git.example.com/team/skills//review"
tools = ["codex"]
scope = "user"
`;
    const model = expectNormalized(canonical);
    const dto = toManifestV1Dto(model);
    expect(dto.ok).toBeTrue();
    if (!dto.ok) throw new Error(dto.error.message);
    expect(Object.keys(dto.value)).toEqual(['version', 'defaults', 'registry', 'skills']);
    expect(Object.isFrozen(dto.value.skills?.[0]?.source)).toBeTrue();

    const encoded = manifestV1Codec.encode(model);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(decoder.decode(encoded.value)).toBe(canonical);
    const decoded = manifestV1Codec.decode(encoded.value);
    expect(decoded.ok).toBeTrue();
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value.canonical).toBeTrue();
    expect(decoded.value.source).toEqual({ kind: 'version', version: 1 });
    expect(decoded.value.migration).toBeNull();
    expect(projectManifestSemantics(decoded.value.model)).toEqual(projectManifestSemantics(model));
  });

  test('accepts human canonical presentation and delegates exact legacy migration', () => {
    const human = encoder.encode(`# retained
version = 1

[defaults]
scope = "project"
tools = ["codex"]
`);
    const decodedHuman = manifestV1Codec.decode(human);
    expect(decodedHuman.ok).toBeTrue();
    if (!decodedHuman.ok) throw new Error(decodedHuman.error.message);
    expect(decodedHuman.value.canonical).toBeFalse();
    expect(decodedHuman.value.migration).toBeNull();

    const legacy = manifestV1Codec.decode(
      encoder.encode(
        '# retained\ntool = "codex"\nscope = "project"\npath = "./skills"\n[registry]\ndefault = "https://github.com/acme"\n',
      ),
    );
    expect(legacy.ok).toBeTrue();
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.value).toMatchObject({
      source: { kind: 'shape', id: 'legacy-project-config' },
      canonical: false,
      migration: {
        mapperId: 'legacy-project-config-to-manifest-v1',
        targetVersion: 1,
      },
      model: {
        version: 1,
        defaults: { tools: ['codex'], scope: 'project', path: './skills' },
        registry: { default: 'github.com/acme' },
        skills: [],
      },
    });

    expect(
      manifestV1Codec.decode(encoder.encode('tool = "codex"\r\nscope = "project"\n')),
    ).toMatchObject({
      ok: false,
      error: {
        reason: 'migration-failed',
        requestedVersion: null,
        message: 'artifact migration failed',
      },
    });
  });

  test('owns strict DTOs and returns fixed errors for hostile, future, and sensitive input', () => {
    const cases = [
      [encoder.encode('version = [\n'), 'malformed', null],
      [encoder.encode('version = 2\n'), 'unsupported-version', 2],
      [encoder.encode('version = 0\n'), 'invalid-shape', null],
      [encoder.encode('version = 1\nunknown = true\n'), 'invalid-shape', 1],
      [encoder.encode(' \t\r\n'), 'malformed', null],
      [encoder.encode('version = 1\n# token = ghp_P17SECRET1\n'), 'sensitive-content', 1],
    ] as const;
    for (const [bytes, reason, requestedVersion] of cases) {
      const result = manifestV1Codec.decode(bytes);
      expect(result.ok, reason).toBeFalse();
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: 'artifact-codec',
          artifactId: 'manifest',
          requestedVersion,
          reason,
          exitCode: 3,
        });
        expect(JSON.stringify(result.error)).not.toContain('P17SECRET1');
      }
    }
    expect(
      manifestV1Codec.decode(
        encoder.encode('version = 1\n\n[defaults]\nscope = "project"\npath = "./ghp_P17SECRET1"\n'),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'artifact-codec',
        artifactId: 'manifest',
        requestedVersion: 1,
        reason: 'sensitive-content',
        path: ['defaults', 'path'],
        exitCode: 3,
        message: 'artifact contains sensitive content',
      },
    });

    const accessor = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        throw new Error('ghp_P17SECRET1');
      },
    });
    expect(manifestV1Codec.validate(accessor)).toMatchObject({
      ok: false,
      error: { reason: 'invalid-shape' },
    });
    expect(
      manifestV1Codec.validate({ version: 1, defaults: { scope: 'project', unknown: true } }),
    ).toMatchObject({ ok: false, error: { reason: 'invalid-shape' } });
    expect(
      fromManifestV1Dto({
        version: 1,
        defaults: { tools: ['codex'], scope: 'project' },
        skills: [
          {
            name: 'review',
            source: { host: 'github.com', repository: 'acme/tools', path: 'skills/review' },
            ref: 'ghp_P17SECRET1',
            tools: ['codex'],
            scope: 'project',
            placement: 'symlink',
            path: null,
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { reason: 'sensitive-content' } });
  });

  test('encodes the valid empty model from the literal base without a synthetic edit', () => {
    const mapped = fromManifestV1Dto({ version: 1 });
    expect(mapped.ok).toBeTrue();
    if (!mapped.ok) throw new Error(mapped.error.message);
    expect(mapped.value).toEqual({ version: 1, skills: [] });
    const first = manifestV1Codec.encode(mapped.value);
    const second = manifestV1Codec.encode(mapped.value);
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) return;
    expect(decoder.decode(first.value)).toBe('version = 1\n');
    expect(first.value).toEqual(second.value);
    expect(first.value).not.toBe(second.value);
    expect(first.value.buffer).not.toBe(second.value.buffer);
  });
});
