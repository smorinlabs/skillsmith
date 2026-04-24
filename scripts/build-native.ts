#!/usr/bin/env bun
const targetFor = (platform: NodeJS.Platform, arch: string): string => {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!os || !cpu) {
    throw new Error(`unsupported host: ${platform}/${arch}`);
  }
  return `bun-${os}-${cpu}`;
};

const target = targetFor(process.platform, process.arch);
const proc = Bun.spawn(
  [
    'bun',
    'build',
    '--compile',
    '--bytecode',
    `--target=${target}`,
    'packages/cli/src/index.ts',
    '--outfile',
    'dist/skillsmith',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await proc.exited);
