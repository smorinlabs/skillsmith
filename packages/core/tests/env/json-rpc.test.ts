import { describe, expect, test } from 'bun:test';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const { exec: execCommand } = await defaultRuntimePorts();

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

describe('bounded JSON-RPC process exchange', () => {
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
      await expect(
        execCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          jsonRpc: messages,
          timeoutMs: 1000,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ capability: 'process', operation: 'exec', code: 'cancelled' });
    } finally {
      clearTimeout(timer);
    }
  });
});
