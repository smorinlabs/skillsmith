import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MACOS_SIGNING_SECRET_NAMES,
  UNSIGNED_MINIMUM_BUN_VERSION,
  macosLanePlan,
  resolveMacosSigning,
} from './release-signing';

const ROOT = resolve(import.meta.dir, '..');
const source = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');
const secrets = Object.fromEntries(MACOS_SIGNING_SECRET_NAMES.map((name) => [name, 'value']));

describe('macOS signing mode', () => {
  test('apple signing in release mode requires all five Apple values', () => {
    expect(
      resolveMacosSigning({
        mode: 'release',
        signing: 'apple',
        env: secrets,
        bunVersion: '1.3.14',
      }),
    ).toEqual({ signing: 'apple', releaseSecrets: secrets });
    for (const name of MACOS_SIGNING_SECRET_NAMES) {
      expect(() =>
        resolveMacosSigning({
          mode: 'release',
          signing: 'apple',
          env: { ...secrets, [name]: '' },
          bunVersion: '1.4.2',
        }),
      ).toThrow(`release mode requires ${name}`);
    }
  });

  test('unsigned release mode refuses any Apple value and an old Bun', () => {
    expect(
      resolveMacosSigning({ mode: 'release', signing: 'none', env: {}, bunVersion: '1.4.2' }),
    ).toEqual({ signing: 'none', releaseSecrets: undefined });
    for (const name of MACOS_SIGNING_SECRET_NAMES) {
      expect(() =>
        resolveMacosSigning({
          mode: 'release',
          signing: 'none',
          env: { [name]: 'present' },
          bunVersion: '1.4.2',
        }),
      ).toThrow(`--macos-signing none refuses ${name}`);
    }
    // oven-sh/bun#32159: before 1.4.1 Bun writes an invalid ad-hoc darwin-arm64 signature.
    expect(UNSIGNED_MINIMUM_BUN_VERSION).toBe('1.4.1');
    for (const bunVersion of ['1.3.14', '1.4.0'])
      expect(() =>
        resolveMacosSigning({ mode: 'release', signing: 'none', env: {}, bunVersion }),
      ).toThrow('requires Bun 1.4.1 or newer');
    expect(() =>
      resolveMacosSigning({ mode: 'release', signing: 'none', env: {}, bunVersion: '1.4.1' }),
    ).not.toThrow();
  });

  test('snapshot builds carry no signing values and reject an unknown mode', () => {
    expect(
      resolveMacosSigning({
        mode: 'snapshot',
        signing: 'apple',
        env: secrets,
        bunVersion: '1.3.14',
      }),
    ).toEqual({ signing: 'apple', releaseSecrets: undefined });
    expect(() =>
      resolveMacosSigning({ mode: 'release', signing: 'adhoc', env: {}, bunVersion: '1.4.2' }),
    ).toThrow('--macos-signing must be apple or none');
  });

  test('the darwin lane plan keeps the signed path and checks ad-hoc signatures when unsigned', () => {
    expect(macosLanePlan('apple')).toEqual([
      'codesign-verify-deep-strict',
      'gatekeeper-assess',
      'cask-lifecycle',
    ]);
    expect(macosLanePlan('none')).toEqual(['codesign-verify-strict', 'adhoc-signature']);
  });

  test('the build entry point and the darwin lane use the signing mode', async () => {
    const [build, check] = await Promise.all([
      source('scripts/build-release.ts'),
      source('scripts/release-check.ts'),
    ]);
    expect(build).toContain("argument('--macos-signing')");
    expect(build).toContain('resolveMacosSigning(');
    expect(check).toContain('macosLanePlan(candidate.macosSigning)');
    expect(check).toContain("['brew', '--prefix']");
  });
});
