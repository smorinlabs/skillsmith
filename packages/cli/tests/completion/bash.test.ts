import { describe, expect, test } from 'bun:test';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { generateCompletionScript } from '../../src/completion/adapter.ts';

describe('Bash completion adapter', () => {
  const script = generateCompletionScript('bash');

  test('emits the pinned Bash skeleton and registers Skillsmith', () => {
    expect(script).toMatch(/^# bash completion for skillsmith/m);
    expect(script).toContain('complete -F __skillsmith_complete skillsmith');
  });

  test('invokes the hidden transport as an argv array', () => {
    expect(script).toContain('requestComp=(skillsmith complete -- "${words[@]:1}")');
    expect(script).toContain('out=$("${requestComp[@]}" 2>/dev/null)');
  });

  test('contains no request reparsing boundary', () => {
    expect(script).not.toMatch(/\beval\b/);
    expect(script).not.toContain('requestComp="skillsmith complete --');
  });

  test('preserves an explicit trailing empty argument', () => {
    expect(script).toContain('requestComp+=("")');
  });

  test('handles attached values without filtering against the option prefix', () => {
    expect(script).toContain('completionPrefix="${cur%%=*}="');
    expect(script).toContain('filterCur="${cur#*=}"');
  });

  test('passes the host Bash parser', () => {
    const parsed = Bun.spawnSync(['bash', '-n'], {
      env: hermeticGitEnv(),
      stdin: Buffer.from(script),
    });
    expect(parsed.exitCode, parsed.stderr.toString()).toBe(0);
  });
});
