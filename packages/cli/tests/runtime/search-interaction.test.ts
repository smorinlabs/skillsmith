import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SearchInteractionPort, SearchReport } from '@skillsmith/core';
import { parseSkillsShResponse } from '../../../core/src/search/skills-sh.ts';
import {
  encodedSearch,
  searchClock,
  searchRequest,
  settleSearch,
} from '../../../core/tests/fixtures/search.ts';
import { createSearchInteraction } from '../../src/runtime/search-interaction.ts';

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
}
class Output extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 8;
  text = '';
  broken = false;
  write(value: string) {
    if (this.broken) throw new Error('terminal write failed');
    this.text += value;
    return true;
  }
}
const reportFor = (query: string, count = 20): SearchReport => {
  const result = parseSkillsShResponse(
    encodedSearch({
      skills: Array.from({ length: count }, (_, index) => ({
        id: `acme/skills/item-${index + 1}`,
        name: `item-${index + 1}`,
      })),
    }),
    { ...searchRequest, query },
  );
  if (!result.ok) throw new Error('invalid fixture');
  return result.value;
};
type Query = Parameters<SearchInteractionPort['run']>[0]['search'];
const session = (search: Query, initialQuery = '', input = new Input(), output = new Output()) => {
  const clock = searchClock();
  const controller = new AbortController();
  const interaction = createSearchInteraction(input, output, true, clock.timer);
  const result = interaction.run({ initialQuery, search, signal: controller.signal });
  // Tests intentionally exercise rejected callbacks and broken terminal output.
  void result.catch(() => {});
  const type = (value: string) => input.emit('data', Buffer.from(value));
  const issue = async () => {
    clock.advance(250);
    await settleSearch();
  };
  const clean = () => {
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    for (const event of ['data', 'end', 'error']) expect(input.listenerCount(event)).toBe(0);
    expect(output.listenerCount('resize')).toBe(0);
    expect(clock.pending()).toBe(0);
  };
  return { input, output, controller, result, type, issue, clean, clock };
};

describe('live search interaction', () => {
  test('debounces complete Unicode queries and invalidates superseded requests immediately', async () => {
    const calls: {
      query: string;
      signal: AbortSignal;
      resolve: (value: Awaited<ReturnType<Query>>) => void;
    }[] = [];
    const s = session(
      (query, signal) => new Promise((resolve) => calls.push({ query, signal, resolve })),
    );
    try {
      s.type('👩‍💻');
      await s.issue();
      expect(calls[0]?.query).toBe('👩‍💻');
      s.type(' می‌روم');
      expect(calls[0]?.signal.aborted).toBe(true);
      s.clock.advance(249);
      await settleSearch();
      expect(calls).toHaveLength(1);
      s.clock.advance(1);
      await settleSearch();
      expect(calls[1]?.query).toBe('👩‍💻 می‌روم');
      calls[0]?.resolve({ ok: true, value: reportFor('stale') });
      await settleSearch();
      expect(s.output.text).not.toContain('20 results');
      calls[1]?.resolve({ ok: true, value: reportFor('👩‍💻 می‌روم') });
      await settleSearch();
      expect(s.output.text).toContain('20 results');
    } finally {
      s.controller.abort();
      await s.result;
    }
    s.clean();
  });
  test('does not request short queries and clears selectable results while editing', async () => {
    const calls: string[] = [];
    const s = session(async (query) => {
      calls.push(query);
      return { ok: true, value: reportFor(query) };
    });
    s.type('a');
    await s.issue();
    expect(calls).toEqual([]);
    s.type('b');
    await s.issue();
    expect(calls).toEqual(['ab']);
    s.type('\u007f');
    s.type('\r');
    await s.issue();
    expect(calls).toEqual(['ab']);
    s.controller.abort();
    expect((await s.result).status).toBe('cancelled');
    s.clean();
  });
  test('scrolls through all results, repaints on resize, and selects the last entry', async () => {
    const s = session(async (query) => ({ ok: true, value: reportFor(query) }), 'react');
    await s.issue();
    for (let index = 0; index < 19; index++) s.type('\u001b[B');
    s.output.columns = 30;
    s.output.emit('resize');
    expect(s.output.text).toContain('› 20. item-20');
    s.type('\r');
    expect(await s.result).toMatchObject({
      status: 'resolved',
      value: { catalogId: 'acme/skills/item-20' },
    });
    expect(s.output.text).toContain('\u001b[?1049h');
    expect(s.output.text).toEndWith('\u001b[?1049l');
    s.clean();
  });
  test('cancellation stops the flow introduced on initially idle input', async () => {
    const input = new Input();
    expect(input.readableFlowing).toBeNull();
    expect(input.isPaused()).toBe(false);
    const s = session(async (query) => ({ ok: true, value: reportFor(query) }), '', input);
    s.type('\u0003');
    expect((await s.result).status).toBe('cancelled');
    s.clean();
  });
  test('restores preexisting raw mode and flow when input was already active', async () => {
    const input = new Input();
    input.setRawMode(true);
    input.resume();
    const s = session(async (query) => ({ ok: true, value: reportFor(query) }), '', input);
    s.controller.abort();
    await s.result;
    expect(input.isRaw).toBe(true);
    expect(input.readableFlowing).toBe(true);
    input.pause();
    input.destroy();
  });
  test('cleans up callback exceptions and terminal failures', async () => {
    const thrown = session(() => {
      throw new Error('callback failed');
    }, 'react');
    await thrown.issue();
    await expect(thrown.result).rejects.toThrow('callback failed');
    thrown.clean();
    const failed = session(async (query) => ({ ok: true, value: reportFor(query) }));
    failed.output.broken = true;
    failed.type('r');
    await expect(failed.result).rejects.toThrow('terminal write failed');
    failed.clean();
  });
  test('keeps provider errors editable and cancels on input end', async () => {
    let signal: AbortSignal | undefined;
    const s = session(async (_, active) => {
      signal = active;
      return { ok: false, error: { code: 'search-unavailable', message: 'try again' } };
    }, 'react');
    await s.issue();
    expect(s.output.text).toContain('Search failed: try again');
    s.type('x');
    await s.issue();
    s.input.emit('end');
    expect((await s.result).status).toBe('cancelled');
    s.clean();
    expect(signal).toBeDefined();
  });
  test('external cancellation aborts a pending query and restores the terminal', async () => {
    let signal: AbortSignal | undefined;
    const s = session((_, active) => {
      signal = active;
      return new Promise(() => {});
    }, 'react');
    await s.issue();
    expect(signal?.aborted).toBe(false);
    s.controller.abort();
    expect((await s.result).status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    s.clean();
  });
  test('requires three terminal streams and refuses pre-aborted sessions without touching input', async () => {
    for (const tty of [
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ]) {
      const input = new Input();
      const output = new Output();
      input.isTTY = tty[0] ?? false;
      output.isTTY = tty[1] ?? false;
      const ui = createSearchInteraction(input, output, tty[2] ?? false, searchClock().timer);
      expect(ui.available).toBe(false);
      expect(
        (
          await ui.run({
            initialQuery: '',
            search: async (query) => ({ ok: true, value: reportFor(query) }),
          })
        ).status,
      ).toBe('refused');
      expect(output.text).toBe('');
      expect(input.readableFlowing).toBeNull();
    }
    const input = new Input();
    const output = new Output();
    const controller = new AbortController();
    controller.abort();
    const ui = createSearchInteraction(input, output, true, searchClock().timer);
    expect(
      (
        await ui.run({
          initialQuery: '',
          signal: controller.signal,
          search: async (query) => ({ ok: true, value: reportFor(query) }),
        })
      ).status,
    ).toBe('cancelled');
    expect(output.text).toBe('');
    expect(input.readableFlowing).toBeNull();
  });
});
