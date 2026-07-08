import { describe, expect, test } from 'bun:test';
import { parseSource } from '../../src/acquire/source.ts';
import type { SourceSpec } from '../../src/acquire/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';

const FULL_SHA = 'a'.repeat(40);

const expectOk = (
  raw: string,
  expected: Pick<SourceSpec, 'host' | 'repoPath' | 'selector' | 'ref' | 'cloneUrl'>,
): void => {
  const r = parseSource(raw);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.raw).toBe(raw);
  expect(r.value.host).toBe(expected.host);
  expect(r.value.repoPath).toBe(expected.repoPath);
  expect(r.value.selector).toEqual(expected.selector);
  expect(r.value.ref).toBe(expected.ref);
  expect(r.value.cloneUrl).toBe(expected.cloneUrl);
};

const expectReject = (raw: string, messageSubstring: string): void => {
  const r = parseSource(raw);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  const error: SkillSmithError = r.error;
  expect(error.code).toBe('flip-refused');
  expect('message' in error ? error.message : '').toContain(messageSubstring);
};

describe('parseSource — parse table', () => {
  test('#1 GitHub sugar, whole repo', () => {
    expectOk('smorinlabs/smorinlabs-harness', {
      host: 'github.com',
      repoPath: 'smorinlabs/smorinlabs-harness',
      selector: { kind: 'whole-repo' },
      ref: null,
      cloneUrl: 'https://github.com/smorinlabs/smorinlabs-harness.git',
    });
  });

  test('#2 GitHub sugar, name selector', () => {
    expectOk('smorinlabs/smorinlabs-harness/factor-scan', {
      host: 'github.com',
      repoPath: 'smorinlabs/smorinlabs-harness',
      selector: { kind: 'name', name: 'factor-scan' },
      ref: null,
      cloneUrl: 'https://github.com/smorinlabs/smorinlabs-harness.git',
    });
  });

  test('#3 GitHub sugar, name selector + ref', () => {
    expectOk('smorinlabs/smorinlabs-harness/factor-scan@v1.2.0', {
      host: 'github.com',
      repoPath: 'smorinlabs/smorinlabs-harness',
      selector: { kind: 'name', name: 'factor-scan' },
      ref: 'v1.2.0',
      cloneUrl: 'https://github.com/smorinlabs/smorinlabs-harness.git',
    });
  });

  test('#4 GitHub sugar, whole repo + ref', () => {
    expectOk('owner/repo@main', {
      host: 'github.com',
      repoPath: 'owner/repo',
      selector: { kind: 'whole-repo' },
      ref: 'main',
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });

  test('#5 GitHub sugar, path selector via //', () => {
    expectOk('owner/repo//plugins/fh/skills/factor-scan', {
      host: 'github.com',
      repoPath: 'owner/repo',
      selector: { kind: 'path', path: 'plugins/fh/skills/factor-scan' },
      ref: null,
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });

  test('#6 GitHub sugar, path selector via // + full SHA ref', () => {
    expectOk(`owner/repo//plugins/fh/skills/factor-scan@${FULL_SHA}`, {
      host: 'github.com',
      repoPath: 'owner/repo',
      selector: { kind: 'path', path: 'plugins/fh/skills/factor-scan' },
      ref: FULL_SHA,
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });

  test('#7 host-explicit, whole repo', () => {
    expectOk('gitlab.com/acme/tools', {
      host: 'gitlab.com',
      repoPath: 'acme/tools',
      selector: { kind: 'whole-repo' },
      ref: null,
      cloneUrl: 'https://gitlab.com/acme/tools.git',
    });
  });

  test('#8 host-explicit, name selector', () => {
    expectOk('gitlab.com/acme/tools/review', {
      host: 'gitlab.com',
      repoPath: 'acme/tools',
      selector: { kind: 'name', name: 'review' },
      ref: null,
      cloneUrl: 'https://gitlab.com/acme/tools.git',
    });
  });

  test('#9 host-explicit with port, name selector + ref', () => {
    expectOk('git.corp.example:8443/team/kit/lint@release-2', {
      host: 'git.corp.example:8443',
      repoPath: 'team/kit',
      selector: { kind: 'name', name: 'lint' },
      ref: 'release-2',
      cloneUrl: 'https://git.corp.example:8443/team/kit.git',
    });
  });

  test('#10 host-explicit subgroup repo + path selector via //', () => {
    expectOk('gitlab.com/acme/platform/tools//skills/review', {
      host: 'gitlab.com',
      repoPath: 'acme/platform/tools',
      selector: { kind: 'path', path: 'skills/review' },
      ref: null,
      cloneUrl: 'https://gitlab.com/acme/platform/tools.git',
    });
  });

  test('#11 host-explicit subgroup repo + trailing // = whole-repo', () => {
    expectOk('gitlab.com/acme/platform/tools//', {
      host: 'gitlab.com',
      repoPath: 'acme/platform/tools',
      selector: { kind: 'whole-repo' },
      ref: null,
      cloneUrl: 'https://gitlab.com/acme/platform/tools.git',
    });
  });

  test('#12 https URL form, .git + path selector + ref', () => {
    expectOk('https://gitlab.com/acme/platform/tools.git//skills/review@main', {
      host: 'gitlab.com',
      repoPath: 'acme/platform/tools',
      selector: { kind: 'path', path: 'skills/review' },
      ref: 'main',
      cloneUrl: 'https://gitlab.com/acme/platform/tools.git',
    });
  });

  test('#13 scp form, git@ is not a ref separator', () => {
    expectOk('git@github.com:smorinlabs/skillsmith.git//plugins/x/skills/y@main', {
      host: 'github.com',
      repoPath: 'smorinlabs/skillsmith',
      selector: { kind: 'path', path: 'plugins/x/skills/y' },
      ref: 'main',
      cloneUrl: 'git@github.com:smorinlabs/skillsmith.git',
    });
  });

  test('#14 ssh URL form with userinfo', () => {
    expectOk('ssh://git@git.corp/team/kit//skills/lint', {
      host: 'git.corp',
      repoPath: 'team/kit',
      selector: { kind: 'path', path: 'skills/lint' },
      ref: null,
      cloneUrl: 'ssh://git@git.corp/team/kit',
    });
  });

  test('#15 one-part name rejected (reserved for future registry)', () => {
    expectReject(
      'factor-scan',
      "one-part names are reserved for a future registry; use 'owner/repo[/<name>]'",
    );
  });

  test('#16 one-part name after ref-strip rejected', () => {
    expectReject(
      'repo@main',
      "one-part names are reserved for a future registry; use 'owner/repo[/<name>]'",
    );
  });

  test('#17 local paths rejected', () => {
    for (const raw of ['./skills/factor-scan', '/Users/a/c/x', '~/c/x']) {
      expectReject(raw, 'install acquires remote sources only');
      expectReject(raw, "skillsmith dev <skill> --source <path>' then 'skillsmith promote");
    }
  });

  test('#18 ambiguous subgroup path rejected (host-explicit, >=4 segments, no //)', () => {
    expectReject('gitlab.com/acme/platform/tools/review', 'ambiguous subgroup path');
  });

  test("#19 embedded '@' before last '/' rejected, suggests moving it to the end", () => {
    expectReject('owner/repo@v2//path', "place '@v2' after the skill path: 'owner/repo//path@v2'");
  });

  test('#20 ambiguous subgroup path rejected (sugar, >3 segments, no //)', () => {
    expectReject('owner/repo/a/b/c', 'ambiguous subgroup path');
  });
});

describe('parseSource — fuzz edges', () => {
  test('short SHA rejected as source-unresolvable (exit 5, not flip-refused)', () => {
    const r = parseSource('owner/repo@8c1d2e3');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('source-unresolvable');
    expect('message' in r.error ? r.error.message : '').toContain(
      'short SHAs cannot be resolved remotely; use a full 40-hex SHA, a tag, or a branch',
    );
  });

  test('URL userinfo @ is not a ref separator', () => {
    const r = parseSource('https://user@gitlab.com/a/b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ref).toBeNull();
    expect(r.value.host).toBe('gitlab.com');
  });

  test('trailing single slash tolerated as whole-repo', () => {
    expectOk('owner/repo/', {
      host: 'github.com',
      repoPath: 'owner/repo',
      selector: { kind: 'whole-repo' },
      ref: null,
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });

  test('.git stripped from sugar repo path', () => {
    expectOk('owner/repo.git', {
      host: 'github.com',
      repoPath: 'owner/repo',
      selector: { kind: 'whole-repo' },
      ref: null,
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });

  test('second // produces an empty segment, rejected', () => {
    expectReject('owner/repo//a//b', "invalid skill path segment ''");
  });

  test('dot-prefixed name selector rejected', () => {
    expectReject('owner/repo/.hidden', 'dot-prefixed skills are invisible to placement detection');
  });

  test('unsupported scheme rejected, naming the scheme', () => {
    expectReject('ftp://x/y', 'ftp');
  });

  test('file:// URL form accepted (hermetic e2e fixtures)', () => {
    expectOk('file:///tmp/fixtures/multi.git//plugins/x', {
      host: '',
      repoPath: 'tmp/fixtures/multi',
      selector: { kind: 'path', path: 'plugins/x' },
      ref: null,
      cloneUrl: 'file:///tmp/fixtures/multi.git',
    });
  });
});
