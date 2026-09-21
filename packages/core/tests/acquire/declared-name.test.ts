import { describe, expect, test } from 'bun:test';
import { type ResolveRemoteSourceInput, resolveRemoteSource } from '../../src/acquire/resolve.ts';
import { parseSource } from '../../src/acquire/source.ts';
import type {
  AcquisitionPorts,
  CandidateSkill,
  InstallSourceTransport,
} from '../../src/acquire/types.ts';
import { emptyLedger } from '../../src/place/ledger.ts';
import { ok } from '../../src/result.ts';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.ts';

const SHA = 'a'.repeat(40);
const candidates: CandidateSkill[] = [
  { path: 'skills/review', name: 'review' },
  { path: 'skills/security-review', name: 'security-review' },
];
const documents = {
  'skills/review/SKILL.md': '---\nname: code-review\n---\n',
  'skills/security-review/SKILL.md': '---\nname: review\n---\n',
};

const fixture = (all = candidates, docs: Record<string, string | Uint8Array> = documents) => {
  const parsed = parseSource('acme/repo');
  if (!parsed.ok) throw new Error('invalid fixture');
  const reads: { ref: string; path: string; maxBytes: number }[] = [];
  const calls: string[] = [];
  const ports = {
    pathKind: async () => 'absent',
    git: {
      readBlobBounded: async (request: { ref: string; path: string; maxBytes: number }) => {
        reads.push(request);
        const source = docs[request.path];
        if (source === undefined) throw new Error('fixture read failure');
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
        if (bytes.length > request.maxBytes) throw new Error('fixture exceeds byte limit');
        return bytes;
      },
    },
  } as unknown as AcquisitionPorts;
  const transport: InstallSourceTransport = {
    resolveRef: async () => {
      calls.push('probe');
      return ok(SHA);
    },
    fetchRepo: async () => {
      calls.push('fetch');
      return ok({ sha: SHA });
    },
    listSkills: async (_ports, _dir, _signal, sha) => {
      calls.push(`list:${sha}`);
      return ok({ candidates: all, scanned: all.length });
    },
    materializeSkill: async (_ports, _dir, path, _signal, sha) => {
      calls.push(`materialize:${sha}:${path}`);
      return ok(`/fetch/${path}`);
    },
  };
  const input: ResolveRemoteSourceInput = {
    ports,
    source: parsed.value,
    transport,
    ledger: emptyLedger('2026-09-20T00:00:00Z'),
    scopeKey: null,
    storeRoot: '/store',
    createFetchDirectory: () => '/fetch',
    pick: async () => {
      throw new Error('explicit selector must not invoke picker');
    },
  };
  const run = (name: string, mode: 'directory-first' | 'frontmatter' = 'directory-first') =>
    resolveRemoteSource({ ...input, skillSelection: { name, mode } });
  return { run, input, reads, calls };
};

describe('explicit repository skill selection', () => {
  test('directory wins without metadata reads and binds listing/materialization to the SHA', async () => {
    const f = fixture();
    expect(await f.run('review')).toMatchObject({
      kind: 'resolved',
      materialization: { skillName: 'review', skillPath: 'skills/review', sha: SHA },
    });
    expect(f.reads).toEqual([]);
    expect(f.calls).toEqual(['fetch', `list:${SHA}`, `materialize:${SHA}:skills/review`]);
  });

  test.each(['directory-first', 'frontmatter'] as const)(
    'rejects an injected directory name before %s selection can rename an installation',
    async (mode) => {
      const f = fixture([{ path: 'skills/review', name: 'renamed' }], {
        'skills/review/SKILL.md': '---\nname: renamed\n---\n',
      });
      expect(await f.run('renamed', mode)).toMatchObject({
        kind: 'source-failure',
        error: { code: 'source-unresolvable' },
      });
      expect(f.reads).toEqual([]);
      expect(f.calls.some((call) => call.startsWith('materialize:'))).toBe(false);
    },
  );
  test.each([
    ['code-review', 'directory-first', 'review'],
    ['review', 'frontmatter', 'security-review'],
    ['CODE-REVIEW', 'frontmatter', 'review'],
  ] as const)('%s in %s mode selects directory identity %s', async (name, mode, installed) => {
    const f = fixture();
    expect(await f.run(name, mode)).toMatchObject({
      kind: 'resolved',
      materialization: { skillName: installed, skillPath: `skills/${installed}` },
    });
    expect(f.reads.map((r) => r.ref)).toEqual([SHA, SHA]);
  });
  test('forced frontmatter never falls back to a matching directory', async () => {
    const f = fixture();
    expect(await f.run('security-review', 'frontmatter')).toMatchObject({
      kind: 'no-match',
      searched: 2,
    });
  });
  test('directory ambiguity refuses before frontmatter or a picker', async () => {
    const f = fixture(
      [
        { path: 'a/review', name: 'review' },
        { path: 'b/review', name: 'review' },
      ],
      {},
    );
    expect(await f.run('review')).toMatchObject({
      kind: 'ambiguous',
      candidates: ['acme/repo//a/review', 'acme/repo//b/review'],
    });
    expect(f.reads).toEqual([]);
  });
  test('duplicate declarations refuse after scanning all candidates', async () => {
    const f = fixture(candidates, {
      'skills/review/SKILL.md': '---\nname: duplicate\n---\n',
      'skills/security-review/SKILL.md': '---\nname: DUPLICATE\n---\n',
    });
    expect(await f.run('duplicate')).toMatchObject({ kind: 'ambiguous' });
    expect(f.reads).toHaveLength(2);
  });
  test.each(['---\nname: [\n---\n', new Uint8Array([0xff])])(
    'a late invalid document invalidates an earlier match',
    async (source) => {
      const f = fixture(candidates, { ...documents, 'skills/security-review/SKILL.md': source });
      expect(await f.run('code-review')).toMatchObject({
        kind: 'source-failure',
        error: { code: 'source-unresolvable' },
      });
      expect(f.calls.some((c) => c.startsWith('materialize:'))).toBe(false);
    },
  );
  test('a missing bounded capability fails only for metadata scanning', async () => {
    const f = fixture();
    Reflect.deleteProperty(f.input.ports.git, 'readBlobBounded');
    expect(await f.run('review')).toMatchObject({ kind: 'resolved' });
    expect(await f.run('code-review')).toMatchObject({
      kind: 'source-failure',
      error: { code: 'source-unresolvable' },
    });
  });
  test('metadata scan candidate limit never blocks a directory winner', async () => {
    const all = Array.from({ length: 1001 }, (_, i) => ({
      name: `skill-${i}`,
      path: `skills/skill-${i}`,
    }));
    const f = fixture(all, {});
    expect(await f.run('unknown')).toMatchObject({ kind: 'source-failure' });
    expect(f.reads).toEqual([]);
    expect(await f.run('skill-0')).toMatchObject({ kind: 'resolved' });
  });
});

test.each(
  [
    ['YAML', '---\nname: Code Review\n---\n'],
    ['JSON', '---json\n{"name":"Code Review"}\n---\n'],
  ].flatMap(([format, document]) =>
    [0, 1, 2, 3].map((count) => [format, count, `${'\uFEFF'.repeat(count)}${document}`] as const),
  ),
)(
  '%s with %d leading BOMs has the same direct-parser and scanner result',
  async (_format, count, text) => {
    const parsed = parseSkillFrontmatter(text);
    expect(parsed).toEqual(ok(count < 2 ? { name: 'Code Review' } : {}));
    const f = fixture([{ path: 'skills/fixture', name: 'fixture' }], {
      'skills/fixture/SKILL.md': text,
    });
    expect(await f.run('Code Review', 'frontmatter')).toMatchObject(
      parsed.ok && parsed.value.name === 'Code Review'
        ? {
            kind: 'resolved',
            materialization: { skillName: 'fixture', skillPath: 'skills/fixture' },
          }
        : { kind: 'no-match', searched: 1 },
    );
    expect(f.reads).toHaveLength(1);
    expect(f.calls.some((call) => call.startsWith('materialize:'))).toBe(count < 2);
  },
);

test('repeated BOMs remain inert through byte decoding and metadata parsing', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const marker = '__skillsmithScanBomFixture';
  try {
    for (const count of [1, 2, 3, 4]) {
      const f = fixture([{ path: 'skills/a', name: 'a' }], {
        'skills/a/SKILL.md': `${'\uFEFF'.repeat(count)}---javascript\n({name:(globalThis.${marker}=true,'fixture')})\n---\n`,
      });
      const result = await f.run('fixture');
      expect(result.kind).not.toBe('resolved');
      expect(globals[marker]).toBeUndefined();
    }
  } finally {
    delete globals[marker];
  }
});

test('a missing or unusable declared name is a nonmatch, not an incomplete scan', async () => {
  for (const body of [
    '',
    '---\nname: 4\n---',
    '---\nname: " review "\n---',
    '---\nname: "-review"\n---',
    `---\nname: "${'x'.repeat(257)}"\n---`,
  ]) {
    const f = fixture([{ path: 'a', name: 'a' }], { 'a/SKILL.md': body });
    expect(await f.run('review')).toMatchObject({ kind: 'no-match' });
  }
});

test('directory matching is case sensitive; declared matching preserves complete strings and internal spaces', async () => {
  const f = fixture([{ path: 'Review', name: 'Review' }], {
    'Review/SKILL.md': '---\nname: Code Review\n---\n',
  });
  expect(await f.run('review')).toMatchObject({ kind: 'no-match' });
  expect(await f.run('CODE REVIEW')).toMatchObject({
    kind: 'resolved',
    materialization: { skillName: 'Review' },
  });
  expect(await f.run('Code')).toMatchObject({ kind: 'no-match' });
});

test('metadata byte budgets allow exact limits and empty blobs after exhaustion', async () => {
  const all = Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, path: `s${i}` }));
  const sized = '---\nname: target\n---\n'.padEnd(1_048_576, ' ');
  const docs: Record<string, string> = {};
  for (let i = 0; i < 16; i++) docs[`s${i}/SKILL.md`] = i === 0 ? sized : '#'.repeat(1_048_576);
  docs['s16/SKILL.md'] = '';
  const f = fixture(all, docs);
  expect(await f.run('target')).toMatchObject({
    kind: 'resolved',
    materialization: { skillPath: 's0' },
  });
  expect(f.reads.at(-1)?.maxBytes).toBe(0);
  docs['s16/SKILL.md'] = 'x';
  const over = fixture(all, docs);
  expect(await over.run('target')).toMatchObject({ kind: 'source-failure' });
  expect(over.calls.some((c) => c.startsWith('materialize:'))).toBe(false);
  const perFile = fixture([{ path: 'a', name: 'a' }], { 'a/SKILL.md': `${sized}x` });
  expect(await perFile.run('target')).toMatchObject({ kind: 'source-failure' });
});

test('exact candidate budget is accepted and all candidates are visited', async () => {
  const all = Array.from({ length: 1000 }, (_, i) => ({ name: `s${i}`, path: `s${i}` }));
  const docs = Object.fromEntries(all.map((c) => [`${c.path}/SKILL.md`, '']));
  const f = fixture(all, docs);
  expect(await f.run('absent')).toMatchObject({ kind: 'no-match' });
  expect(f.reads).toHaveLength(1000);
});

test('thrown and returned transport cancellations and permissions preserve their classification', async () => {
  const { portError } = await import('../../src/ports/errors.ts');
  const { err } = await import('../../src/result.ts');
  for (const phase of ['fetchRepo', 'listSkills', 'materializeSkill'] as const)
    for (const code of ['cancelled', 'permission'] as const)
      for (const thrown of [false, true]) {
        const f = fixture();
        const transport = {
          ...f.input.transport,
          [phase]: async () => {
            if (thrown)
              throw portError({
                capability: 'git',
                operation: phase,
                code,
                message: 'fixture operation failed',
                context: {},
              });
            return err({
              code: code === 'permission' ? 'permission-denied' : code,
              message: 'fixture operation failed',
            });
          },
        } as InstallSourceTransport;
        const result = await resolveRemoteSource({
          ...f.input,
          transport,
          skillSelection: { name: 'review', mode: 'directory-first' },
        });
        expect(result).toMatchObject({
          kind: 'source-failure',
          error: { code: code === 'permission' ? 'permission-denied' : code },
        });
      }
});

test('an aborted signal wins over a returned success or ordinary transport failure', async () => {
  for (const phase of ['fetchRepo', 'listSkills', 'materializeSkill'] as const)
    for (const thrown of [false, true]) {
      const controller = new AbortController();
      const f = fixture();
      const original = f.input.transport;
      if (original === undefined) throw new Error('missing fixture transport');
      const transport = {
        ...original,
        [phase]: async (...args: unknown[]) => {
          controller.abort();
          if (thrown) throw new Error('fixture generic transport failure');
          return (original[phase] as (...values: unknown[]) => unknown)(...args);
        },
      } as InstallSourceTransport;
      expect(
        await resolveRemoteSource({
          ...f.input,
          transport,
          signal: controller.signal,
          skillSelection: { name: 'review', mode: 'directory-first' },
        }),
      ).toMatchObject({ kind: 'source-failure', error: { code: 'cancelled' } });
    }
});

test('cancellation during the full metadata scan discards earlier matches', async () => {
  const f = fixture();
  const controller = new AbortController();
  const read = f.input.ports.git.readBlobBounded;
  if (read === undefined) throw new Error('missing fixture reader');
  f.input.ports.git.readBlobBounded = async (request) => {
    const bytes = await read(request);
    controller.abort();
    return bytes;
  };
  expect(
    await resolveRemoteSource({
      ...f.input,
      signal: controller.signal,
      skillSelection: { name: 'code-review', mode: 'frontmatter' },
    }),
  ).toMatchObject({ kind: 'source-failure', error: { code: 'cancelled' } });
  expect(f.reads).toHaveLength(1);
  expect(f.calls.some((c) => c.startsWith('materialize:'))).toBe(false);
});

test('an explicit selector bypasses same-SHA store elision; legacy whole-repository requests still elide', async () => {
  const f = fixture();
  const input = {
    ...f.input,
    allowStoreElision: true,
    ports: { ...f.input.ports, pathKind: async () => 'dir' as const },
    ledger: {
      ...f.input.ledger,
      skills: {
        review: {
          tools: {
            'claude-code': {
              origin: { repo: 'acme/repo', refResolved: SHA, skillPath: 'skills/review' },
            },
          },
        },
      },
    },
  } as unknown as ResolveRemoteSourceInput;
  expect(await resolveRemoteSource(input)).toMatchObject({
    kind: 'resolved',
    cleanupDirectory: null,
    materialization: { skillPath: 'skills/review' },
  });
  expect(f.calls).toEqual(['probe']);
  f.calls.length = 0;
  expect(
    await resolveRemoteSource({
      ...input,
      skillSelection: { name: 'review', mode: 'frontmatter' },
    }),
  ).toMatchObject({ kind: 'resolved', materialization: { skillPath: 'skills/security-review' } });
  expect(f.calls).toEqual(['fetch', `list:${SHA}`, `materialize:${SHA}:skills/security-review`]);
  expect(f.reads).toHaveLength(2);
});

test('real Git enumeration, metadata and materialization remain bound after FETCH_HEAD moves', async () => {
  const { buildSelectorRemote } = await import('../fixtures/acquire/selector-remote.ts');
  const { defaultRuntimePorts } = await import('../../src/ports/default.ts');
  const { fetchRepo, lsTreeSkills, sparseCheckoutSkill } = await import(
    '../../src/acquire/fetch.ts'
  );
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await buildSelectorRemote();
  try {
    await f.put('skills/review', 'Changed Name', 'wrong later bytes');
    await f.put('skills/competitor', 'Code Review', 'wrong later candidate');
    const next = f.commit();
    f.publish();
    const ports = await defaultRuntimePorts();
    const source = parseSource(f.source);
    if (!source.ok) throw new Error('invalid fixture source');
    const transport: InstallSourceTransport = {
      resolveRef: async () => ok(null),
      fetchRepo: async (ports, options) => {
        const original = await fetchRepo(ports, {
          ...options,
          cloneUrl: `file://${f.bare}`,
          ref: f.sha,
        });
        if (!original.ok) return original;
        await ports.git.fetchRef({ repositoryRoot: options.fetchDir, ref: next });
        return original;
      },
      listSkills: lsTreeSkills,
      materializeSkill: sparseCheckoutSkill,
    };
    const result = await resolveRemoteSource({
      ports,
      source: source.value,
      transport,
      ledger: emptyLedger('2026-09-20T00:00:00Z'),
      scopeKey: null,
      storeRoot: join(f.root, 'store'),
      createFetchDirectory: () => join(f.root, 'fetch'),
      skillSelection: { name: 'Code Review', mode: 'frontmatter' },
    });
    expect(result).toMatchObject({
      kind: 'resolved',
      materialization: { sha: f.sha, skillPath: 'skills/review' },
    });
    if (result.kind === 'resolved')
      expect(
        await readFile(join(result.materialization.materializedDir, 'SKILL.md'), 'utf8'),
      ).toContain('initial payload');
  } finally {
    await f.cleanup();
  }
});
