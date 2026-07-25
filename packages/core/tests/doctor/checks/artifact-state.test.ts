import { describe, expect, test } from 'bun:test';
import { hashManifestBytes } from '../../../src/artifacts/hash.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import { artifactState } from '../../../src/doctor/checks/artifact-state.ts';
import { focusDoctorPorts } from '../../../src/doctor/run.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { ScanEnv } from '../../../src/env/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const LEGACY_SOURCE = '# retained owner\ntool = "codex"\nscope = "project"\npath = "./skills"\n';
const MANIFEST_PATH = '/project/skillsmith.toml';
const LOCK_PATH = '/project/skillsmith.lock';

const env: ScanEnv = {
  homeDir: '/home/tester',
  path: [],
  platform: 'linux',
  xdg: {
    config: '/home/tester/.config',
    data: '/home/tester/.local/share',
    cache: '/home/tester/.cache',
  },
  fileExists: async (path) => path === MANIFEST_PATH,
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async (path) => (path === MANIFEST_PATH ? LEGACY_SOURCE : ''),
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async (path) => (path === MANIFEST_PATH ? 'file' : 'absent'),
  isExecutable: async () => false,
  readBytes: async (path) =>
    path === MANIFEST_PATH ? new TextEncoder().encode(LEGACY_SOURCE) : new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_path, action) => action(),
};

const context: CheckRunContext = {
  env: focusDoctorPorts(runtimePorts(env)),
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/project',
  artifactPair: { file: MANIFEST_PATH, lockfile: LOCK_PATH },
  configuration: resolveRuntimeConfiguration({}),
  offline: true,
  logger: noopLogger,
};

describe('artifactState', () => {
  test('keeps repository revisions generic while manifest operation images use role hashes', async () => {
    const findings = await artifactState.run(context);
    const repair = findings.find(
      (finding) => finding.operation === 'migrate-project-config',
    )?.repair;

    expect(repair?.kind).toBe('migrate-project-config');
    if (
      repair?.kind !== 'migrate-project-config' ||
      repair.projectMigration === undefined ||
      repair.before.state !== 'present' ||
      repair.after.state !== 'present' ||
      repair.beforeImage.kind !== 'manifest' ||
      repair.afterImage.kind !== 'manifest'
    ) {
      throw new Error('exact project migration repair was not produced');
    }

    const migration = repair.projectMigration;
    const beforeRoleHash = hashManifestBytes(LEGACY_SOURCE);
    const afterRoleHash = hashManifestBytes(migration.resultSource);

    expect(repair.before.byteRevision).toBe(migration.expectedByteRevision);
    expect(repair.after.byteRevision).toBe(migration.resultByteRevision);
    expect(migration.expectedByteRevision).not.toBe(beforeRoleHash);
    expect(migration.resultByteRevision).not.toBe(afterRoleHash);

    expect([repair.beforeImage.byteHash, repair.afterImage.byteHash]).toEqual([
      beforeRoleHash,
      afterRoleHash,
    ]);
    expect(repair.beforeImage.semanticHash).toBe(migration.expectedSemanticRevision);
    expect(repair.afterImage.semanticHash).toBe(migration.resultSemanticRevision);
  });
});
