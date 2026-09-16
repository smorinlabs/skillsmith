import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCommand } from '../../src/env/exec.ts';

const messages = [
  { id: 1, method: 'initialize', params: {} },
  { method: 'initialized', params: {} },
  { id: 2, method: 'skills/list', params: {} },
];
const SERVER = `
import {createInterface} from 'node:readline';
let ready = false;
let acknowledged = false;
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    setTimeout(() => { ready = true; console.log(JSON.stringify({id:1,result:{}})); }, 15);
  } else if (message.method === 'initialized' && ready) {
    acknowledged = true;
  } else if (message.method === 'skills/list' && acknowledged) {
    console.log(JSON.stringify({id:2,result:{data:[]}}));
  } else {
    console.log(JSON.stringify({id:message.id,error:{code:-32000,message:'Not initialized'}}));
  }
});
`;

const descendantFixture = async (launcherExits = false, detachedChild = false) => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-rpc-descendant-'));
  const heartbeat = join(root, 'heartbeat.json');
  const descendant = [
    "const fs = require('node:fs');",
    `const heartbeat = ${JSON.stringify(heartbeat)};`,
    'let tick = 0;',
    'const write = () => {',
    '  fs.writeFileSync(heartbeat + ".next", JSON.stringify({ pid: process.pid, tick: ++tick }));',
    '  fs.renameSync(heartbeat + ".next", heartbeat);',
    '};',
    'write(); const interval = setInterval(write, 20);',
    'setTimeout(() => clearInterval(interval), 10000);',
  ].join('\n');
  const launcher = [
    `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}],`,
    `{ stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: ${detachedChild} });`,
    launcherExits ? 'child.unref();' : 'setInterval(() => {}, 1000);',
  ].join('\n');
  return {
    heartbeat,
    launcher,
    ready: async () => {
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {
        try {
          const value = JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number };
          if (Number.isSafeInteger(value.pid) && value.pid > 1) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await Bun.sleep(10);
      }
      throw new Error('descendant fixture did not become ready within 1500 ms');
    },
    cleanup: async () => {
      try {
        const { pid } = JSON.parse(await readFile(heartbeat, 'utf8')) as { pid: number };
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already stopped */
          }
        }
      } catch {
        /* fixture may have stopped before writing */
      }
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe('bounded JSON-RPC process exchange', () => {
  test.each([false, true])(
    'deadline bounds descendant-held pipes even when launcher exits first: %s',
    async (launcherExits) => {
      const fixture = await descendantFixture(launcherExits);
      const started = performance.now();
      const exchange = execCommand(process.execPath, ['-e', fixture.launcher], {
        jsonRpc: messages,
        timeoutMs: 2000,
      });
      try {
        await fixture.ready();
        expect(performance.now() - started).toBeLessThan(2000);
        const result = await exchange;
        expect(result.timedOut).toBe(true);
        expect(result.protocolError).toContain('deadline');
        expect(performance.now() - started).toBeLessThan(3500);
        const heartbeat = await readFile(fixture.heartbeat, 'utf8');
        await Bun.sleep(100);
        expect(await readFile(fixture.heartbeat, 'utf8')).toBe(heartbeat);
      } finally {
        await exchange;
        await fixture.cleanup();
      }
    },
    15000,
  );

  test('cancellation bounds descendant-held pipes and stops the owned group', async () => {
    const fixture = await descendantFixture();
    const controller = new AbortController();
    const exchange = execCommand(process.execPath, ['-e', fixture.launcher], {
      jsonRpc: messages,
      timeoutMs: 5000,
      signal: controller.signal,
    }).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    try {
      await fixture.ready();
      const started = performance.now();
      controller.abort();
      const outcome = await exchange;
      expect(performance.now() - started).toBeLessThan(1200);
      expect(outcome.result?.protocolError).toBe('cancelled');
      expect(outcome.result?.timedOut).toBe(false);
      const heartbeat = await readFile(fixture.heartbeat, 'utf8');
      await Bun.sleep(100);
      expect(await readFile(fixture.heartbeat, 'utf8')).toBe(heartbeat);
    } finally {
      controller.abort();
      await exchange;
      await fixture.cleanup();
    }
  });

  test('reader cleanup bounds a deliberately detached fixture descendant', async () => {
    const fixture = await descendantFixture(false, true);
    const started = performance.now();
    const exchange = execCommand(process.execPath, ['-e', fixture.launcher], {
      jsonRpc: messages,
      timeoutMs: 2000,
    });
    try {
      await fixture.ready();
      expect(performance.now() - started).toBeLessThan(2000);
      const result = await exchange;
      expect(result.timedOut).toBe(true);
      expect(performance.now() - started).toBeLessThan(3500);
    } finally {
      // An escaped process group is outside transport ownership; this fixture owns its cleanup.
      await exchange;
      await fixture.cleanup();
    }
  }, 15000);
  test('waits for initialize, then notifies, requests, and closes stdin after the result', async () => {
    const result = await execCommand(process.execPath, ['-e', SERVER], {
      jsonRpc: messages,
      timeoutMs: 1000,
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.protocolError).toBeUndefined();
    expect(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).id),
    ).toEqual([1, 2]);
  });

  test.each([
    { output: 'garbage', expected: 'malformed JSON response' },
    { output: '{"id":99,"result":{}}', expected: 'unexpected response id' },
    {
      output: '{"id":1,"error":{"code":-32601,"message":"private detail"}}',
      expected: 'RPC error -32601',
    },
    { output: '{"id":1}', expected: 'missing result' },
  ])('rejects invalid protocol output: %j', async ({ output, expected }) => {
    const result = await execCommand(
      process.execPath,
      ['-e', `console.log(${JSON.stringify(output)}); setInterval(()=>{},1000)`],
      {
        jsonRpc: messages,
        timeoutMs: 1000,
      },
    );
    expect(result.protocolError).toContain(expected);
    expect(result.timedOut).toBe(false);
  });

  test('clean early EOF is not a successful exchange', async () => {
    const result = await execCommand(process.execPath, ['-e', 'void 0'], {
      jsonRpc: messages,
      timeoutMs: 1000,
    });
    expect(result.protocolError).toContain('incomplete');
  });

  test('bounds unterminated output', async () => {
    const result = await execCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(2 ** 21)); setInterval(()=>{},1000)'],
      {
        jsonRpc: messages,
        timeoutMs: 1000,
      },
    );
    expect(result.protocolError).toContain('output limit');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.timedOut).toBe(false);
  });

  test('deadline and cancellation terminate the owned child', async () => {
    const timeout = await execCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      jsonRpc: messages,
      timeoutMs: 100,
    });
    expect(timeout.timedOut).toBe(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      const cancelled = await execCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        jsonRpc: messages,
        timeoutMs: 1000,
        signal: controller.signal,
      });
      expect(cancelled.timedOut).toBe(false);
      expect(cancelled.protocolError).toContain('cancelled');
    } finally {
      clearTimeout(timer);
    }
  });
});
