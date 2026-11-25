// macOS signing mode for release candidates (P24, ADR 0011).
// `apple`: Developer ID signing and notarization through GoReleaser; needs all five values.
// `none`: ad-hoc signatures written by `bun build --compile`; refuses any Apple value so a
// partly configured signing setup cannot silently produce an unsigned release.

import { isAtLeastVersion } from './tool-versions.ts';

export const MACOS_SIGNING_SECRET_NAMES = [
  'MACOS_SIGN_P12',
  'MACOS_SIGN_PASSWORD',
  'MACOS_NOTARY_KEY',
  'MACOS_NOTARY_KEY_ID',
  'MACOS_NOTARY_ISSUER_ID',
] as const;

// oven-sh/bun#32159: Bun before 1.4.1 writes an invalid ad-hoc signature on darwin-arm64.
// Notarized builds overwrite it; unsigned builds ship it, so they need the fixed Bun.
export const UNSIGNED_MINIMUM_BUN_VERSION = '1.4.1';

export type MacosSigning = 'apple' | 'none';
type SecretName = (typeof MACOS_SIGNING_SECRET_NAMES)[number];

export function resolveMacosSigning(input: {
  mode: 'snapshot' | 'release';
  signing: string;
  env: Readonly<Record<string, string | undefined>>;
  bunVersion: string;
}): { signing: MacosSigning; releaseSecrets: Record<SecretName, string> | undefined } {
  if (input.signing !== 'apple' && input.signing !== 'none') {
    throw new Error('--macos-signing must be apple or none');
  }
  const signing: MacosSigning = input.signing;
  if (input.mode === 'snapshot') return { signing, releaseSecrets: undefined };
  if (signing === 'none') {
    for (const name of MACOS_SIGNING_SECRET_NAMES) {
      if ((input.env[name] ?? '') !== '') {
        throw new Error(`--macos-signing none refuses ${name}; remove it or use apple signing`);
      }
    }
    if (!isAtLeastVersion(input.bunVersion, UNSIGNED_MINIMUM_BUN_VERSION)) {
      throw new Error(
        `--macos-signing none requires Bun ${UNSIGNED_MINIMUM_BUN_VERSION} or newer; found ${input.bunVersion}`,
      );
    }
    return { signing, releaseSecrets: undefined };
  }
  const releaseSecrets = Object.fromEntries(
    MACOS_SIGNING_SECRET_NAMES.map((name) => {
      const value = input.env[name];
      if (value === undefined || value.length === 0) {
        throw new Error(`release mode requires ${name}`);
      }
      return [name, value];
    }),
  ) as Record<SecretName, string>;
  return { signing, releaseSecrets };
}

export type MacosLaneStep =
  | 'codesign-verify-deep-strict'
  | 'gatekeeper-assess'
  | 'cask-lifecycle'
  | 'codesign-verify-strict'
  | 'adhoc-signature';

export function macosLanePlan(signing: MacosSigning): readonly MacosLaneStep[] {
  return signing === 'apple'
    ? ['codesign-verify-deep-strict', 'gatekeeper-assess', 'cask-lifecycle']
    : ['codesign-verify-strict', 'adhoc-signature'];
}
