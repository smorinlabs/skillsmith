import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { wellKnownBinDirs } from '../../../core/src/detect/scanners.ts';

/** Test-only subprocess isolation; production discovery and fixture-owned tools are unchanged. */
export const createDetectionIsolation = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  binaries: readonly string[] = ['claude', 'codex', 'kilo', 'opencode'],
) => {
  const directory = await mkdtemp(join(root, '.detection-'));
  const preload = join(directory, 'preload.ts');
  const trace = join(directory, 'trace.txt');
  const externalDirs = wellKnownBinDirs({
    homeDir: environment.HOME ?? homedir(),
    executableSearchPath: (environment.PATH ?? '').split(delimiter).filter(Boolean),
  } as unknown as Parameters<typeof wellKnownBinDirs>[0]).filter(
    (path) => path !== root && !path.startsWith(root + sep),
  );
  const blockedPaths = externalDirs.flatMap((path) => binaries.map((binary) => join(path, binary)));
  const code = [
    "import { mock } from 'bun:test';",
    "import * as fs from 'node:fs/promises';",
    'const blocked = new Set(' + JSON.stringify(blockedPaths) + ');',
    'const trace = ' + JSON.stringify(trace) + ';',
    'const originalStat = fs.stat;',
    'const stat = async (path, options) => {',
    '  const value = String(path);',
    '  if (blocked.has(value)) {',
    "    await fs.appendFile(trace, value + '\\n');",
    "    throw Object.assign(new Error('fixture-owned absent binary'), { code: 'ENOENT' });",
    '  }',
    '  return options === undefined ? originalStat(path) : originalStat(path, options);',
    '};',
    "mock.module('node:fs/promises', () => ({ ...fs, stat }));",
  ].join('\n');
  await writeFile(preload, code + '\n');
  return { preload, trace, blockedPaths };
};
