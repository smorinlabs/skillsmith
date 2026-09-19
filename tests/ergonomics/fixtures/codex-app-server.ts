import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The workflow fixtures deliberately model successful skill loading, not Codex's validator. */
export const codexAppServerFixtureDispatch = (): string =>
  `if [ "$#" -eq 3 ] && [ "$1" = "app-server" ] && [ "$2" = "--listen" ] && [ "$3" = "stdio://" ]; then exec ${shellQuote(process.execPath)} ${shellQuote(import.meta.path)}; fi`;

if (import.meta.main) {
  let stage = 0;
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    const message = JSON.parse(line);
    if (stage === 0 && message.method === 'initialize' && message.id === 1) {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      stage = 1;
    } else if (stage === 1 && message.method === 'initialized' && message.id === undefined) {
      stage = 2;
    } else if (
      stage === 2 &&
      message.method === 'skills/list' &&
      message.id === 2 &&
      message.params.forceReload === true
    ) {
      const data = [];
      for (const cwd of message.params.cwds as string[]) {
        const root = join(cwd, '.agents', 'skills');
        const skills = [];
        for (const name of existsSync(root) ? await readdir(root) : []) {
          const path = join(root, name, 'SKILL.md');
          if (existsSync(path)) skills.push({ path: await realpath(path), enabled: true });
        }
        data.push({ cwd, skills, errors: [] });
      }
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { data } })}\n`);
      stage = 3;
    } else {
      throw new Error('unsupported hermetic Codex protocol message');
    }
  }
  if (stage !== 3) process.exitCode = 64;
}
