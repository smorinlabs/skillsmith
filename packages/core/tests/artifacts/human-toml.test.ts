import { describe, expect, test } from 'bun:test';
import {
  applyHumanTomlReplacements,
  renderHumanTomlString,
  renderHumanTomlStringArray,
  scanHumanToml,
} from '../../src/artifacts/human-toml.ts';

const encoder = new TextEncoder();

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error('expected scanner success');
  return result.value;
};

describe('lossless human TOML scanner', () => {
  test('fatally decodes owned UTF-8 and rejects a BOM', () => {
    expect(scanHumanToml(Uint8Array.of(0xff)).ok).toBeFalse();
    const bom = scanHumanToml(Uint8Array.of(0xef, 0xbb, 0xbf, 0x76));
    expect(bom).toEqual({
      ok: false,
      error: {
        code: 'human-toml',
        reason: 'invalid-utf8',
        message: 'human TOML must not contain a UTF-8 BOM',
      },
    });

    let traps = 0;
    const proxy = new Proxy(encoder.encode('version = 1\n'), {
      getPrototypeOf: () => {
        traps += 1;
        return Uint8Array.prototype;
      },
    });
    expect(scanHumanToml(proxy)).toMatchObject({
      ok: false,
      error: { reason: 'unsafe-human-edit' },
    });
    expect(traps).toBe(0);

    const detached = encoder.encode('version = 1\n');
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => scanHumanToml(detached)).not.toThrow();
    expect(scanHumanToml(detached)).toMatchObject({
      ok: false,
      error: { reason: 'invalid-utf8' },
    });
  });

  test('copies bytes and freezes all structural ranges', () => {
    const input = encoder.encode('version = 1\n["defaults"]\n"scope" = \'project\' # retained\n');
    const scanned = unwrap(scanHumanToml(input));
    expect(scanned.bytes).not.toBe(input);
    expect(scanned.bytes.buffer).not.toBe(input.buffer);
    input.fill(0);
    expect(scanned.source).toStartWith('version = 1');
    expect(Object.isFrozen(scanned)).toBeTrue();
    expect(Object.isFrozen(scanned.lines)).toBeTrue();
    expect(Object.isFrozen(scanned.headers)).toBeTrue();
    expect(Object.isFrozen(scanned.assignments)).toBeTrue();
    expect(scanned.headers[0]?.path).toEqual(['defaults']);
    expect(scanned.assignments[1]).toMatchObject({
      tablePath: ['defaults'],
      keyPath: ['scope'],
      quote: 'literal',
      inlineComment: '# retained',
    });
  });

  test('does not mistake multiline string and array contents for structure', () => {
    const scanned = unwrap(
      scanHumanToml(
        encoder.encode(
          'version = 1\n[defaults]\ntools = [\n "codex", # ] deceptive\n]\nscope = """line\n[registry]\ndefault = \'deceptive\'\n"""\n[registry]\ndefault = "github.com/acme"\n',
        ),
      ),
    );
    expect(scanned.headers.map((header) => header.path)).toEqual([['defaults'], ['registry']]);
    expect(scanned.assignments.map((assignment) => assignment.keyPath[0])).toEqual([
      'version',
      'tools',
      'scope',
      'default',
    ]);
    expect(scanned.assignments[1]?.multiline).toBeTrue();
    expect(scanned.assignments[2]?.multiline).toBeTrue();
    expect(scanned.assignments[1]?.value).toContain('# ] deceptive');
  });

  test('retains valid four-quote multiline closers as immutable assignments', () => {
    for (const source of ['ref = """main""""\n', "ref = '''main''''\n"]) {
      const scanned = unwrap(scanHumanToml(encoder.encode(source)));
      expect(scanned.assignments).toHaveLength(1);
      expect(scanned.assignments[0]).toMatchObject({
        keyPath: ['ref'],
        value: source.slice('ref = '.length, -1),
        multiline: true,
      });
      expect(Object.isFrozen(scanned.assignments[0])).toBeTrue();
      expect(Object.isFrozen(scanned.assignments[0]?.valueRange)).toBeTrue();
    }
  });

  test('identifies dotted and inline-table aliases without normalizing them', () => {
    const scanned = unwrap(
      scanHumanToml(
        encoder.encode(
          'version = 1\ndefaults.scope = "project"\nregistry = { default = "github.com/acme" }\n',
        ),
      ),
    );
    expect(scanned.assignments[1]).toMatchObject({
      keyPath: ['defaults', 'scope'],
      dotted: true,
    });
    expect(scanned.assignments[2]).toMatchObject({ keyPath: ['registry'], dotted: false });
  });

  test('renders bounded values and rejects overlapping range applications', () => {
    expect(renderHumanTomlString('safe', 'literal')).toBe("'safe'");
    expect(renderHumanTomlString("can't", 'literal')).toBe('"can\'t"');
    expect(renderHumanTomlStringArray(['codex'], { quote: 'literal', trailingComma: true })).toBe(
      "['codex',]",
    );
    expect(
      applyHumanTomlReplacements('abcdef', [
        { start: 1, end: 4, text: 'x' },
        { start: 3, end: 5, text: 'y' },
      ]),
    ).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
  });
});
