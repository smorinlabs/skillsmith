#!/usr/bin/env bun
// Fail if @skillsmith/core imports CLI-only deps or uses process.exit / console.*
import { Glob } from 'bun';

const FORBIDDEN_IMPORTS = ['commander', 'chalk', 'consola', '@clack/prompts'];
const FORBIDDEN_CALLS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'process.exit', pattern: /\bprocess\.exit\s*\(/ },
  { name: 'console.log', pattern: /\bconsole\.(log|info|warn|error|debug)\s*\(/ },
];

const glob = new Glob('packages/core/src/**/*.ts');
const violations: string[] = [];

for await (const file of glob.scan('.')) {
  const src = await Bun.file(file).text();
  for (const dep of FORBIDDEN_IMPORTS) {
    const rx = new RegExp(`from\\s+['"]${dep}['"]`);
    if (rx.test(src)) violations.push(`${file}: imports '${dep}' (CLI-only dep)`);
  }
  for (const { name, pattern } of FORBIDDEN_CALLS) {
    if (pattern.test(src)) violations.push(`${file}: uses ${name}`);
  }
}

if (violations.length > 0) {
  process.stderr.write('core-boundary violations:\n');
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}
process.stdout.write('core boundary OK\n');
