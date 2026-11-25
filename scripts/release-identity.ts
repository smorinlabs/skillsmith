#!/usr/bin/env bun
// Release identity: the release-please manifest, the three package manifests, and both
// workspace entries in bun.lock must name one version. bun.lock allows trailing commas, so
// `jq` cannot read it; this reader removes them outside strings and then parses strict JSON.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKSPACES = { cli: 'packages/cli', core: 'packages/core' } as const;
type WorkspaceVersions = Record<keyof typeof WORKSPACES, string>;

export type IdentityFiles = {
  manifest: string;
  packages: readonly string[];
  lock: string;
};

export function parseBunLock(text: string): unknown {
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (inString) {
      output += character;
      if (character === '\\') {
        output += text[index + 1] ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') inString = true;
    if (character === ',') {
      const next = text.slice(index + 1).match(/^\s*(.)/su)?.[1];
      if (next === '}' || next === ']') continue;
    }
    output += character;
  }
  return JSON.parse(output);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function readLockWorkspaceVersions(text: string): WorkspaceVersions {
  const lock = parseBunLock(text);
  const workspaces = record(lock) ? lock.workspaces : undefined;
  if (!record(workspaces)) throw new Error('bun.lock has no workspaces object');
  const read = (path: string): string => {
    const entry = workspaces[path];
    const version = record(entry) ? entry.version : undefined;
    if (typeof version !== 'string' || version === '') {
      throw new Error(`bun.lock workspace ${path} has no version`);
    }
    return version;
  };
  return { cli: read(WORKSPACES.cli), core: read(WORKSPACES.core) };
}

// Rewrites only the "version" value inside the two workspace entries, so the result is
// byte-identical to what `bun install` writes once it refreshes them.
export function syncLockWorkspaceVersions(text: string, version: string): string {
  let result = text;
  for (const path of Object.values(WORKSPACES)) {
    const header = `\n    "${path}": {\n`;
    const start = result.indexOf(header);
    if (start < 0) throw new Error(`bun.lock workspace ${path} is absent`);
    const end = result.indexOf('\n    },\n', start);
    const entry = result.slice(start, end);
    const versionLine = /\n {6}"version": "[^"\n]*",\n/u;
    if (end < 0 || !versionLine.test(entry)) {
      throw new Error(`bun.lock workspace ${path} has no version line`);
    }
    const updated = entry.replace(versionLine, `\n      "version": "${version}",\n`);
    result = result.slice(0, start) + updated + result.slice(end);
  }
  const check = readLockWorkspaceVersions(result);
  if (check.cli !== version || check.core !== version) {
    throw new Error('bun.lock workspace versions did not sync');
  }
  return result;
}

export function checkReleaseIdentity(version: string, files: IdentityFiles): void {
  const problems: string[] = [];
  const manifest = JSON.parse(files.manifest) as Record<string, unknown>;
  if (manifest['.'] !== version) problems.push(`release-please manifest ${String(manifest['.'])}`);
  files.packages.forEach((text, index) => {
    const actual = (JSON.parse(text) as Record<string, unknown>).version;
    if (actual !== version) problems.push(`package manifest ${index} ${String(actual)}`);
  });
  const lock = readLockWorkspaceVersions(files.lock);
  for (const [name, path] of Object.entries(WORKSPACES) as [keyof WorkspaceVersions, string][]) {
    if (lock[name] !== version) problems.push(`bun.lock ${path} ${lock[name]}`);
  }
  if (problems.length > 0) {
    throw new Error(`release identity is not ${version}: ${problems.join('; ')}`);
  }
}

const PACKAGE_MANIFESTS = [
  'package.json',
  'packages/cli/package.json',
  'packages/core/package.json',
];

function main(argv: readonly string[]): void {
  const [mode, version] = argv;
  const root = resolve(import.meta.dir, '..');
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
  if ((mode !== '--check' && mode !== '--sync-lock') || !version || argv.length !== 2) {
    throw new Error('usage: release-identity.ts --check|--sync-lock <version>');
  }
  if (mode === '--sync-lock') {
    const lock = read('bun.lock');
    const synced = syncLockWorkspaceVersions(lock, version);
    if (synced !== lock) writeFileSync(resolve(root, 'bun.lock'), synced);
    return;
  }
  checkReleaseIdentity(version, {
    manifest: read('.release-please-manifest.json'),
    packages: PACKAGE_MANIFESTS.map(read),
    lock: read('bun.lock'),
  });
  console.log(`release identity: ${version}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
