import { describe, expect, test } from 'bun:test';
import { compileWildcardTarget } from '../../src/selection/wildcard.ts';

const expectMatch = (target: string, candidate: string): void => {
  expect(compileWildcardTarget(target).matches(candidate)).toBeTrue();
};

const expectNoMatch = (target: string, candidate: string): void => {
  expect(compileWildcardTarget(target).matches(candidate)).toBeFalse();
};

describe('shared wildcard target matching', () => {
  test('matches whole strings and fails closed on reserved sentinels', () => {
    expectMatch('literal', 'literal');
    expectNoMatch('literal', 'literal-suffix');
    expectNoMatch('prefix-literal', 'literal');

    for (const sentinel of ['\0', '\u0001']) {
      expectNoMatch(`bad${sentinel}target`, `bad${sentinel}target`);
      expectNoMatch('*', `bad${sentinel}candidate`);
      expectNoMatch('exact', `exact${sentinel}`);
    }
  });

  test('leaves only star and question mark active in Bun glob syntax', () => {
    const target = String.raw`prefix-[ab]-{x,y}-!-,\-*-?`;
    expectMatch(target, String.raw`prefix-[ab]-{x,y}-!-,\-many-Z`);
    expectNoMatch(target, String.raw`prefix-a-x-y-!-,\-many-Z`);
    expectNoMatch(target, String.raw`prefix-[ab]-{x,y}-!-,/-many-Z`);
  });

  test('preserves literal separator identity while wildcards consume either separator', () => {
    expectMatch('*', '/');
    expectMatch('*', '\\');
    expectMatch('?', '/');
    expectMatch('?', '\\');
    expectMatch('root/*/end', 'root/a\\b/end');
    expectMatch(String.raw`root\*\end`, String.raw`root\a/b\end`);
    expectNoMatch('root/literal', String.raw`root\literal`);
    expectNoMatch(String.raw`root\literal`, 'root/literal');
  });

  test('keeps the four JavaScript line terminators distinct and outside wildcards', () => {
    const terminators = ['\n', '\r', '\u2028', '\u2029'] as const;
    for (const terminator of terminators) {
      expectNoMatch('*', `a${terminator}b`);
      expectNoMatch('?', terminator);
      expectMatch(`a${terminator}b*`, `a${terminator}b-tail`);
      for (const other of terminators) {
        if (other !== terminator) expectNoMatch(`a${terminator}b*`, `a${other}b-tail`);
      }
    }
    expectNoMatch('a\nb*', 'a/n/b-tail');
    expectNoMatch('a\rb*', 'a/r/b-tail');
  });

  test('treats question mark as one Unicode code point', () => {
    expectMatch('skill-?', 'skill-😀');
    expectNoMatch('skill-?', 'skill-😀x');
    expectNoMatch('skill-??', 'skill-😀');
    expectMatch('skill-??', 'skill-😀x');
  });

  test('handles large repeated and alternating wildcard near misses deterministically', () => {
    expectNoMatch(`${'*'.repeat(10_000)}z`, `${'a'.repeat(100_000)}y`);
    expectNoMatch(`${'*a'.repeat(10_000)}z`, `${'a'.repeat(10_000)}y`);
    expectNoMatch(`${'?*'.repeat(10_000)}z`, `${'a'.repeat(10_000)}y`);
  });
});
