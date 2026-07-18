import { describe, expect, test } from 'bun:test';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import { mergePortableCandidates, prepareExportArtifacts } from '../../src/export/merge.ts';
import type { ExportObservation } from '../../src/export/observe.ts';
import type { PortableExportCandidate } from '../../src/export/types.ts';

const candidate = (
  tool: PortableExportCandidate['tools'][number],
  overrides: Partial<PortableExportCandidate> = {},
): PortableExportCandidate =>
  Object.freeze({
    name: 'alpha',
    tools: Object.freeze([tool]),
    scope: 'user',
    source: Object.freeze({ host: 'github.com', repository: 'acme/skills', path: 'alpha' }),
    sourceText: 'github.com/acme/skills//alpha',
    requestedRef: 'main',
    resolvedSha: 'a'.repeat(40),
    sourcePath: 'alpha',
    contentHash: `sha256:${'b'.repeat(64)}` as PortableExportCandidate['contentHash'],
    placement: 'symlink',
    path: null,
    classification: 'portable-managed',
    ...overrides,
  });

const existingObservation = (
  manifest: NormalizedManifestV1,
  input: { readonly force?: boolean; readonly resolvedSha?: string } = {},
): ExportObservation => {
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec fixture is unavailable');
  const manifestBytes = manifestCodec.encode(manifest);
  if (!manifestBytes.ok) throw new Error('manifest fixture could not be encoded');
  const declaration = manifest.skills[0];
  if (declaration === undefined) throw new Error('manifest fixture declaration is missing');
  const source = `${declaration.source.host}/${declaration.source.repository}${
    declaration.source.path === null ? '' : `//${declaration.source.path}`
  }`;
  const lock = Object.freeze({
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: hashManifestSemantics(manifest),
    skills: Object.freeze([
      Object.freeze({
        name: declaration.name,
        source,
        requestedRef: declaration.ref,
        resolvedSha: input.resolvedSha ?? 'c'.repeat(40),
        sourcePath: declaration.source.path ?? '.',
        contentHash: `sha256:${'d'.repeat(64)}` as ArtifactDigest,
      }),
    ]),
  });
  const lockSource = serializePortableLock(lock);
  if (!lockSource.ok) throw new Error('lock fixture could not be encoded');
  return {
    manifest: {
      state: 'present',
      sourceVersion: 1,
      source: new TextDecoder().decode(manifestBytes.value),
      model: manifest,
    },
    lock: { state: 'present', sourceVersion: 1, source: lockSource.value, model: lock },
    request: { force: input.force ?? false },
  } as unknown as ExportObservation;
};

describe('portable export merge', () => {
  test('unions compatible default-path tools in registry order', () => {
    const result = mergePortableCandidates([candidate('codex'), candidate('claude-code')]);
    expect(result.ok).toBeTrue();
    expect(result.ok && result.value[0]?.tools).toEqual(['claude-code', 'codex']);
  });

  test('refuses every multi-tool custom-path union', () => {
    const result = mergePortableCandidates([
      candidate('claude-code', { path: '~/shared/alpha' }),
      candidate('codex', { path: '~/shared/alpha' }),
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export-custom-path-conflict', exitClass: 'usage' },
    });
  });

  test('refuses incompatible exact resolution without order-dependent selection', () => {
    const result = mergePortableCandidates([
      candidate('claude-code'),
      candidate('codex', { resolvedSha: 'c'.repeat(40) }),
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export-selected-conflict', exitClass: 'usage' },
    });
  });

  test('bounded force selects the registry-first candidate and retains every selected tool', () => {
    const first = candidate('codex', { resolvedSha: 'b'.repeat(40) });
    const second = candidate('claude-code', { resolvedSha: 'a'.repeat(40) });

    const merged = mergePortableCandidates([first, second], true);

    expect(merged.ok).toBeTrue();
    expect(merged.ok && merged.value).toEqual([
      expect.objectContaining({
        tools: ['claude-code', 'codex'],
        resolvedSha: 'a'.repeat(40),
      }),
    ]);
  });

  test('force never resolves a duplicate same-tool observation or multi-tool custom path', () => {
    const duplicate = candidate('codex');
    expect(mergePortableCandidates([duplicate, duplicate], true)).toMatchObject({
      ok: false,
      error: { code: 'export-duplicate-selected-placement' },
    });
    expect(
      mergePortableCandidates(
        [candidate('claude-code', { path: '~/shared' }), candidate('codex', { path: '~/shared' })],
        true,
      ),
    ).toMatchObject({ ok: false, error: { code: 'export-custom-path-conflict' } });
  });

  test('preserves a compatible human ref while refreshing only exact lock facts', () => {
    const manifest: NormalizedManifestV1 = Object.freeze({
      version: 1,
      skills: Object.freeze([
        Object.freeze({
          name: 'alpha',
          source: Object.freeze({ host: 'github.com', repository: 'acme/skills', path: 'alpha' }),
          ref: 'release',
          tools: Object.freeze(['claude-code'] as const),
          scope: 'user',
          placement: 'symlink',
          path: null,
        }),
      ]),
    });
    const prepared = prepareExportArtifacts(existingObservation(manifest), [
      candidate('claude-code', { requestedRef: 'main' }),
    ]);
    expect(prepared.ok).toBeTrue();
    expect(prepared.ok && prepared.value.manifestChanged).toBeFalse();
    expect(prepared.ok && prepared.value.lockChanged).toBeTrue();
    expect(prepared.ok && prepared.value.candidates[0]?.requestedRef).toBe('release');
    expect(prepared.ok && prepared.value.lock.skills[0]?.requestedRef).toBe('release');
    expect(prepared.ok && prepared.value.candidateActions.alpha).toBe('refresh');
  });

  test('bounded force never rewrites shared fields still owned by an unselected tool', () => {
    const manifest: NormalizedManifestV1 = Object.freeze({
      version: 1,
      skills: Object.freeze([
        Object.freeze({
          name: 'alpha',
          source: Object.freeze({ host: 'github.com', repository: 'other/skills', path: 'alpha' }),
          ref: 'main',
          tools: Object.freeze(['claude-code', 'codex'] as const),
          scope: 'user',
          placement: 'symlink',
          path: null,
        }),
      ]),
    });
    expect(
      prepareExportArtifacts(existingObservation(manifest, { force: true }), [
        candidate('claude-code'),
      ]),
    ).toMatchObject({
      ok: false,
      error: { code: 'export-existing-conflict', exitClass: 'usage' },
    });
  });
});
