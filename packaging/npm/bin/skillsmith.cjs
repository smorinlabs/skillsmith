#!/bin/sh
':' //; runtime="$(command -v bun 2>/dev/null || command -v node 2>/dev/null)" || { echo "skillsmith requires Bun or Node.js" >&2; exit 1; }
':' //; exec "$runtime" "$0" "$@"
'use strict';

const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');

const packages = Object.freeze({
  'darwin/arm64': '@smorinlabs/skillsmith-darwin-arm64',
  'darwin/x64': '@smorinlabs/skillsmith-darwin-x64',
  'linux/arm64': '@smorinlabs/skillsmith-linux-arm64',
  'linux/x64': '@smorinlabs/skillsmith-linux-x64',
});

const platform = `${process.platform}/${process.arch}`;
const packageName = packages[platform];
if (packageName === undefined) {
  console.error(
    `skillsmith does not support ${platform}; supported platforms are macOS and glibc Linux on arm64 or x64`,
  );
  process.exit(1);
}

let binary;
try {
  binary = join(dirname(require.resolve(`${packageName}/package.json`)), 'bin', 'skillsmith');
} catch {
  console.error(
    `skillsmith native payload ${packageName} is missing; reinstall without --omit=optional`,
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map();
for (const signal of forwardedSignals) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

const removeHandlers = () => {
  for (const [signal, handler] of handlers) process.off(signal, handler);
};

child.on('error', (error) => {
  removeHandlers();
  console.error(`skillsmith could not start ${packageName}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  removeHandlers();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
