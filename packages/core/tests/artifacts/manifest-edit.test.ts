import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_TOOLS } from '../../src/agents/registry.ts';
import type { ArtifactMutationErrorReason } from '../../src/artifacts/coordinator-types.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { type ManifestEditTarget, editManifestBytes } from '../../src/artifacts/manifest-edit.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';

const encoder = new TextEncoder();
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../tests/ergonomics/fixtures/p2-ts04/manifest-cases.json'),
    'utf8',
  ),
) as {
  successCases: readonly {
    id: string;
    before: string;
    after: string;
    request: { edits: readonly Record<string, unknown>[] };
    changed: boolean;
    migrated: boolean;
    touchedTargets: readonly ManifestEditTarget[];
  }[];
  unsafeCases: readonly {
    id: string;
    source: string;
    request: { edits: readonly Record<string, unknown>[] };
    reason: ArtifactMutationErrorReason;
  }[];
};

const semantics = (source: string): ArtifactDigest => {
  const read = readManifestSource(source);
  if (!read.ok) throw new Error('fixture was not readable');
  const normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok) throw new Error('fixture was not normalizable');
  return hashManifestSemantics(normalized.value);
};

describe('closed lossless manifest edit algebra', () => {
  for (const item of fixture.successCases) {
    test(`edits fixture exactly: ${item.id}`, () => {
      const input = encoder.encode(item.before);
      const callerCopy = new Uint8Array(input);
      const result = editManifestBytes(input, item.request as never);
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
      if (!result.ok) return;
      expect(input).toEqual(callerCopy);
      expect(result.value.bytes).not.toBe(input);
      expect(result.value.bytes.buffer).not.toBe(input.buffer);
      expect(result.value.source).toBe(item.after);
      expect(result.value.bytes).toEqual(encoder.encode(item.after));
      expect(result.value.changed).toBe(item.changed);
      expect(result.value.migrated).toBe(item.migrated);
      expect(result.value.touchedTargets).toEqual(item.touchedTargets);
      expect(result.value.beforeSemanticHash).toBe(semantics(item.before));
      expect(result.value.afterSemanticHash).toBe(semantics(item.after));
      expect(Object.isFrozen(result.value)).toBeTrue();
      expect(Object.isFrozen(result.value.touchedTargets)).toBeTrue();
    });
  }

  for (const item of fixture.unsafeCases) {
    test(`refuses unsafe fixture without mutation: ${item.id}`, () => {
      const input = encoder.encode(item.source);
      const callerCopy = new Uint8Array(input);
      const result = editManifestBytes(input, item.request as never);
      expect(result.ok).toBeFalse();
      if (result.ok) return;
      expect(result.error.reason).toBe(item.reason);
      expect(input).toEqual(callerCopy);
      expect(Object.isFrozen(result.error)).toBeTrue();
      if (result.error.reason === 'unsafe-human-edit') {
        expect(result.error.manualPatch).toContain('skillsmith.toml');
        expect(result.error.manualPatch).not.toContain(item.source);
      }
    });
  }

  test('accepts every authoritative built-in tool without a duplicated inventory', () => {
    expect(SUPPORTED_TOOLS).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
    const source = 'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n';
    const result = editManifestBytes(encoder.encode(source), {
      edits: [{ kind: 'set-default', field: 'tools', value: [...SUPPORTED_TOOLS] }],
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBeTrue();
    if (result.ok) {
      expect(result.value.source).toContain(
        'tools = ["claude-code", "codex", "kilo-code", "opencode"]',
      );
    }
  });

  test('rejects array holes and accessors without executing them', () => {
    const source = encoder.encode('version = 1\n');
    const hole = new Array(1);
    expect(editManifestBytes(source, { edits: hole } as never)).toMatchObject({
      ok: false,
      error: { reason: 'invalid-request' },
    });
    let calls = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        calls += 1;
        return { kind: 'migrate-legacy' };
      },
    });
    accessor.length = 1;
    expect(editManifestBytes(source, { edits: accessor } as never)).toMatchObject({
      ok: false,
      error: { reason: 'invalid-request' },
    });
    expect(calls).toBe(0);

    const proxy = new Proxy([], {
      getPrototypeOf: () => {
        calls += 1;
        return Array.prototype;
      },
      ownKeys: () => {
        calls += 1;
        return ['length'];
      },
    });
    expect(editManifestBytes(source, { edits: proxy } as never)).toMatchObject({
      ok: false,
      error: { reason: 'invalid-request' },
    });
    expect(calls).toBe(0);
  });

  test('rejects extra keys, symbols, exotic prototypes, duplicates, and remove/update conflicts', () => {
    const source = encoder.encode(
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\n',
    );
    const cases: unknown[] = [
      { edits: [{ kind: 'set-default', field: 'scope', value: 'user', extra: true }] },
      { edits: [Object.assign({ kind: 'unset-default', field: 'path' }, { [Symbol('x')]: 1 })] },
      { edits: [Object.assign(Object.create({}), { kind: 'unset-default', field: 'path' })] },
      {
        edits: [
          { kind: 'set-default', field: 'scope', value: 'user' },
          { kind: 'unset-default', field: 'scope' },
        ],
      },
      {
        edits: [
          { kind: 'remove-skill', name: 'review' },
          { kind: 'set-skill-field', name: 'review', field: 'ref', value: 'main' },
        ],
      },
    ];
    for (const request of cases) {
      expect(editManifestBytes(source, request as never)).toMatchObject({
        ok: false,
        error: { reason: 'invalid-request' },
      });
    }
  });

  test('requires migration exactly once at index zero and permits following edits', () => {
    const legacy = encoder.encode('tool = "codex"\nscope = "project"\n');
    expect(
      editManifestBytes(legacy, {
        edits: [{ kind: 'migrate-legacy' }, { kind: 'set-default', field: 'scope', value: 'user' }],
      }),
    ).toMatchObject({ ok: true, value: { migrated: true } });
    expect(
      editManifestBytes(legacy, {
        edits: [{ kind: 'set-default', field: 'scope', value: 'user' }, { kind: 'migrate-legacy' }],
      }),
    ).toMatchObject({ ok: false, error: { reason: 'invalid-request' } });
  });

  test('applies root edits before existing-skill edits regardless of request interleaving', () => {
    const source = encoder.encode(
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\nscope = "project"\n',
    );
    const result = editManifestBytes(source, {
      edits: [
        { kind: 'unset-skill-field', name: 'review', field: 'scope' },
        { kind: 'set-default', field: 'scope', value: 'user' },
      ],
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBeTrue();
    if (result.ok) {
      expect(result.value.source).toBe(
        'version = 1\n[defaults]\ntools = ["codex"]\nscope = "user"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\n',
      );
    }
  });

  test('separates a missing key inserted after a no-final-newline value', () => {
    const source = 'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"';
    const result = editManifestBytes(encoder.encode(source), {
      edits: [{ kind: 'set-default', field: 'path', value: './skills' }],
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBeTrue();
    if (result.ok) expect(result.value.source).toBe(`${source}\npath = "./skills"`);
  });

  test('refuses declaration removal when any block line has an inline comment', () => {
    const sources = [
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review" # retained\n',
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\ntools = [\n  "codex", # retained\n]\n',
    ];
    for (const source of sources) {
      expect(
        editManifestBytes(encoder.encode(source), {
          edits: [{ kind: 'remove-skill', name: 'review' }],
        }),
      ).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
    }
  });

  test('preserves valid four-quote multiline fields for unrelated edits and refuses targeted rewrites', () => {
    for (const refLine of ['ref = """main""""', "ref = '''main''''"]) {
      const source = `version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\n${refLine}\n`;
      const unrelated = editManifestBytes(encoder.encode(source), {
        edits: [{ kind: 'set-default', field: 'path', value: './skills' }],
      });
      expect(unrelated.ok, unrelated.ok ? undefined : unrelated.error.message).toBeTrue();
      if (unrelated.ok) {
        expect(unrelated.value.source).toContain(refLine);
        expect(unrelated.value.source).toContain('path = "./skills"');
      }

      expect(
        editManifestBytes(encoder.encode(source), {
          edits: [{ kind: 'set-skill-field', name: 'review', field: 'ref', value: 'release' }],
        }),
      ).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit', exitCode: 2 } });
    }
  });

  test('classifies an unclosed string through the strict manifest parser', () => {
    const malformed = encoder.encode(
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project\n',
    );
    expect(
      editManifestBytes(malformed, {
        edits: [{ kind: 'set-registry-default', value: 'github.com/acme' }],
      }),
    ).toMatchObject({ ok: false, error: { reason: 'invalid-manifest', exitCode: 3 } });
  });

  test('keeps malformed sensitive input in the strict invalid-manifest class', () => {
    const canary = 'ghp_P17SECRET2';
    const malformed = encoder.encode(
      `version = 1\n[defaults]\ntools = ["codex"]\nscope = "project\n# token = ${canary}\n`,
    );
    const result = editManifestBytes(malformed, {
      edits: [{ kind: 'set-registry-default', value: 'github.com/acme' }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest', exitCode: 3 },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test('redacts token-shaped target identities in every refusal field and manual patch', () => {
    const tokenName = ['ghp', '12345678'].join('_');
    const source = encoder.encode(
      `version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "${tokenName}"\nsource = "github.com/acme/tools//skills/review"\nref = "main" # retained\n`,
    );
    const result = editManifestBytes(source, {
      edits: [{ kind: 'unset-skill-field', name: tokenName, field: 'ref' }],
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
    expect(JSON.stringify(result)).not.toContain(tokenName);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  test('redacts a credential-bearing value in deterministic unsafe manual patches', () => {
    const source = encoder.encode(
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project" # retained\n',
    );
    const secret = 'https://user:password@example.com/acme/repo?token=P17_SECRET_CANARY';
    const result = editManifestBytes(source, {
      edits: [{ kind: 'set-default', field: 'path', value: secret }],
    });
    // Invalid requested paths fail before a human patch can be proposed and never echo the value.
    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-request' } });
    expect(JSON.stringify(result)).not.toContain('P17_SECRET_CANARY');
  });

  test('refuses to return a changed candidate containing credential syntax in human trivia', () => {
    const source = encoder.encode(
      'version = 1\n# token = P17_SECRET_CANARY\n[defaults]\ntools = ["codex"]\nscope = "project"\n',
    );
    const result = editManifestBytes(source, {
      edits: [{ kind: 'set-default', field: 'scope', value: 'user' }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'unsafe-human-edit',
        field: 'defaults.scope',
      },
    });
    if (!result.ok) expect(result.error.manualPatch).toContain('defaults.scope');
    expect(JSON.stringify(result)).not.toContain('P17_SECRET_CANARY');
  });

  test('rejects sensitive input trivia before removal or migration can delete it', () => {
    const canary = 'ghp_P17SECRET1';
    const canonical = encoder.encode(
      `version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "review"\nsource = "github.com/acme/tools//skills/review"\n# authorization: Bearer ${canary}\n`,
    );
    const removed = editManifestBytes(canonical, {
      edits: [{ kind: 'remove-skill', name: 'review' }],
    });
    expect(removed).toMatchObject({
      ok: false,
      error: {
        reason: 'unsafe-human-edit',
        field: 'skills["review"]',
      },
    });
    if (!removed.ok) expect(removed.error.manualPatch).toContain('skills["review"]');
    expect(JSON.stringify(removed)).not.toContain(canary);

    const legacy = encoder.encode(`tool = "codex"\nscope = "project"\n# token = ${canary}\n`);
    const migrated = editManifestBytes(legacy, { edits: [{ kind: 'migrate-legacy' }] });
    expect(migrated).toMatchObject({
      ok: false,
      error: {
        reason: 'unsafe-human-edit',
        field: 'manifest',
      },
    });
    if (!migrated.ok) expect(migrated.error.manualPatch).toContain('manifest');
    expect(JSON.stringify(migrated)).not.toContain(canary);
  });

  test('gives migration-only candidate sensitivity a redacted manual patch receipt', () => {
    const canary = 'ghp_P17SECRET3';
    const legacy = encoder.encode(
      `tool = "codex"\nscope = "project"\npath = "./token=${canary}"\n`,
    );
    const result = editManifestBytes(legacy, { edits: [{ kind: 'migrate-legacy' }] });
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'unsafe-human-edit',
        exitCode: 2,
        field: 'manifest',
      },
    });
    if (!result.ok) expect(result.error.manualPatch).toContain('manifest');
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test('returns a fixed Result error for detached caller bytes', () => {
    const detached = encoder.encode('version = 1\n');
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() =>
      editManifestBytes(detached, { edits: [{ kind: 'migrate-legacy' }] }),
    ).not.toThrow();
    expect(editManifestBytes(detached, { edits: [{ kind: 'migrate-legacy' }] })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-utf8' },
    });
  });
});
