import { describe, expect, test } from 'bun:test';
import type { BuiltInToolId } from '../../src/agents/registry.ts';
import type { PortableLockSkillV1 } from '../../src/artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import {
  deriveUpdateCandidateV1,
  selectUpdateDeclarationsV1,
} from '../../src/update/candidates.ts';

const manifest: NormalizedManifestV1 = {
  version: 1,
  skills: [
    {
      name: 'factor-scan',
      source: { host: 'fixture.invalid', repository: 'acme/repo', path: 'skills/factor-scan' },
      ref: 'main',
      tools: ['claude-code', 'codex'],
      scope: 'project',
      placement: 'copy',
      path: null,
    },
    {
      name: 'review',
      source: { host: 'fixture.invalid', repository: 'acme/repo', path: 'skills/review' },
      ref: 'v1.0.0',
      tools: ['codex'],
      scope: 'project',
      placement: 'copy',
      path: null,
    },
  ],
};

const order = ['claude-code', 'codex', 'kilo-code', 'opencode'] as BuiltInToolId[];

describe('update candidate policy', () => {
  test('selects declarations before tools and preserves canonical registry order', () => {
    const selected = selectUpdateDeclarationsV1({
      manifest,
      targets: ['factor-*', 'factor-scan'],
      all: false,
      tools: ['codex', 'claude-code'],
      registryOrder: order,
    });
    expect(selected.selectionSource).toBe('explicit-targets');
    expect(selected.selectedNames).toEqual(['factor-scan']);
    expect(selected.declarations[0]?.tools).toEqual(['claude-code', 'codex']);
  });

  test('reports unmatched targets and tool-filter no-ops without widening', () => {
    const unmatched = selectUpdateDeclarationsV1({
      manifest,
      targets: ['missing-*'],
      all: false,
      tools: [],
      registryOrder: order,
    });
    expect(unmatched.selectedNames).toEqual([]);
    expect(unmatched.unmatchedTargets).toEqual(['missing-*']);
    const filtered = selectUpdateDeclarationsV1({
      manifest,
      targets: ['review'],
      all: false,
      tools: ['claude-code'],
      registryOrder: order,
    });
    expect(filtered.selectedNames).toEqual([]);
    expect(filtered.filteredNames).toEqual(['review']);
  });

  test('shares Unicode wildcard semantics and rejects reserved sentinel targets', () => {
    const factorScan = manifest.skills[0];
    if (factorScan === undefined) throw new Error('missing factor-scan fixture');
    const unicodeManifest: NormalizedManifestV1 = {
      ...manifest,
      skills: [{ ...factorScan, name: 'unicode-😀' }],
    };
    const unicode = selectUpdateDeclarationsV1({
      manifest: unicodeManifest,
      targets: ['unicode-?'],
      all: false,
      tools: [],
      registryOrder: order,
    });
    expect(unicode.selectedNames).toEqual(['unicode-😀']);

    for (const sentinel of ['\0', '\u0001']) {
      const invalidName = `invalid${sentinel}name`;
      const invalid = selectUpdateDeclarationsV1({
        manifest: { ...manifest, skills: [{ ...factorScan, name: invalidName }] },
        targets: [invalidName],
        all: false,
        tools: [],
        registryOrder: order,
      });
      expect(invalid.selectedNames).toEqual([]);
      expect(invalid.unmatchedTargets).toEqual([invalidName]);
    }
  });

  test('keeps fixed declarations skipped until an explicit ref and pins moving refs', () => {
    const selected = selectUpdateDeclarationsV1({
      manifest,
      targets: ['review'],
      all: false,
      tools: [],
      registryOrder: order,
    }).declarations[0];
    expect(selected).toBeDefined();
    const lock: PortableLockSkillV1 = {
      name: 'review',
      source: 'fixture.invalid/acme/repo//skills/review',
      requestedRef: 'v1.0.0',
      resolvedSha: '1'.repeat(40),
      sourcePath: 'skills/review',
      contentHash: `sha256:${'1'.repeat(64)}` as PortableLockSkillV1['contentHash'],
    };
    const fixed = deriveUpdateCandidateV1({
      selected: selected as NonNullable<typeof selected>,
      currentLock: lock,
      inspection: { kind: 'tag', requestedRef: 'v1.0.0', resolvedSha: '1'.repeat(40) },
      explicitRef: null,
      pin: false,
    });
    expect(fixed.outcome).toBe('skipped-fixed');
    const bulkPinFixed = deriveUpdateCandidateV1({
      selected: selected as NonNullable<typeof selected>,
      currentLock: lock,
      inspection: { kind: 'tag', requestedRef: 'v1.0.0', resolvedSha: '1'.repeat(40) },
      explicitRef: null,
      pin: true,
    });
    expect(bulkPinFixed).toMatchObject({
      outcome: 'skipped-fixed',
      proposedRequestedRef: 'v1.0.0',
    });
    const pinned = deriveUpdateCandidateV1({
      selected: selected as NonNullable<typeof selected>,
      currentLock: lock,
      inspection: { kind: 'branch', requestedRef: 'main', resolvedSha: '2'.repeat(40) },
      explicitRef: 'main',
      pin: true,
    });
    expect(pinned).toMatchObject({
      transition: 'pin',
      proposedRequestedRef: '2'.repeat(40),
      outcome: 'available',
    });
  });
});
