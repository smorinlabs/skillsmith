import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import type {
  SearchInteractionPort,
  SearchReport,
  SearchSelection,
  TimerPort,
} from '@skillsmith/core';
import type { InteractionResolution } from '@skillsmith/core';
import { searchDisplayText } from '../output/search-human.ts';

export interface SearchTerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing: boolean | null;
  setRawMode(value: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  off(event: 'error', listener: (error: unknown) => void): unknown;
}
export interface SearchTerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(value: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

const fit = (line: string, columns: number): string => {
  const safe = searchDisplayText(line);
  let text = '';
  let width = 0;
  for (const character of safe) {
    const next = Bun.stringWidth(character);
    if (width + next > columns - 2) return `${text}…`;
    text += character;
    width += next;
  }
  return text;
};

/** The session owns only terminal I/O, scheduling, and a supplied read-only query callback. */
export const createSearchInteraction = (
  input: SearchTerminalInput,
  output: SearchTerminalOutput,
  stdoutIsTTY: boolean,
  timer: TimerPort,
): SearchInteractionPort => ({
  available: Boolean(input.isTTY && output.isTTY && stdoutIsTTY),
  run: (request) =>
    new Promise<InteractionResolution<SearchSelection>>((resolve, reject) => {
      if (!input.isTTY || !output.isTTY || !stdoutIsTTY) {
        resolve({
          status: 'refused',
          reason: 'interactive search requires terminal input and output',
        });
        return;
      }
      if (request.signal?.aborted) {
        resolve({ status: 'cancelled' });
        return;
      }
      const keys = new PassThrough();
      emitKeypressEvents(keys);
      let query = request.initialQuery;
      let report: SearchReport | null = null;
      let selected = 0;
      let generation = 0;
      let ownsScreen = false;
      let message = 'Type at least two characters to search.';
      let pending: AbortController | null = null;
      let stopDebounce = () => {};
      let finished = false;
      const wasRaw = input.isRaw === true;
      const wasFlowing = input.readableFlowing === true;
      const cleanup = () => {
        stopDebounce();
        pending?.abort();
        request.signal?.removeEventListener('abort', cancel);
        input.off('data', forward);
        input.off('end', cancel);
        input.off('error', fail);
        output.off('resize', draw);
        keys.removeAllListeners();
        keys.destroy();
        // A failed terminal operation must not prevent the other restoration steps.
        let failure: unknown;
        for (const restore of [
          () => input.setRawMode(wasRaw),
          () => {
            if (!wasFlowing) input.pause();
          },
          () => {
            if (ownsScreen) {
              ownsScreen = false;
              output.write('\x1b[?1049l');
            }
          },
        ]) {
          try {
            restore();
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure !== undefined) throw failure;
      };
      const finish = (result: InteractionResolution<SearchSelection>) => {
        if (finished) return;
        finished = true;
        try {
          cleanup();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        try {
          cleanup();
        } catch {
          /* preserve the original failure */
        }
        reject(error);
      };
      const cancel = () => finish({ status: 'cancelled' });
      function draw() {
        if (finished) return;
        try {
          const terminalRows = Math.max(2, output.rows ?? 24);
          const height = Math.max(1, Math.min(20, terminalRows - 5));
          const start = Math.max(
            0,
            Math.min(selected - height + 1, Math.max(0, (report?.results.length ?? 0) - height)),
          );
          const rows = (report?.results ?? [])
            .slice(start, start + height)
            .map(
              (hit, index) =>
                `${start + index === selected ? '›' : ' '} ${start + index + 1}. ${hit.name} (${hit.source ?? 'unknown source'})`,
            );
          const lines = [
            'Search skills.sh (experimental; queries are sent to skills.sh)',
            `Query: ${query}`,
            message,
            ...rows,
            '↑/↓ select · Enter details · Esc/Ctrl-C cancel',
          ];
          // Repaint the owned alternate screen so terminal reflow cannot leave stale rows.
          output.write(
            `\x1b[H\x1b[2J${lines
              .slice(0, terminalRows - 1)
              .map((line) => fit(line, Math.max(4, output.columns ?? 80)))
              .join('\n')}\n`,
          );
        } catch (error) {
          fail(error);
        }
      }
      const changed = () => {
        generation++;
        stopDebounce();
        pending?.abort();
        pending = null;
        report = null;
        selected = 0;
        const normalized = query.trim();
        if ([...normalized].length < 2) {
          message = 'Type at least two characters to search.';
          draw();
          return;
        }
        message = 'Waiting to search…';
        draw();
        if (finished) return;
        const current = generation;
        stopDebounce = timer.schedule(250, () => {
          if (finished || generation !== current) return;
          const controller = new AbortController();
          pending = controller;
          message = 'Searching…';
          draw();
          if (finished) return;
          void Promise.resolve()
            .then(() => request.search(normalized, controller.signal))
            .then(
              (result) => {
                if (finished || generation !== current || controller.signal.aborted) return;
                pending = null;
                if (result.ok) {
                  report = result.value;
                  message =
                    report.returned === 0
                      ? 'No matching skills. Edit the query to try again.'
                      : `${report.returned} results · provider order · verification not checked`;
                } else {
                  report = null;
                  message = `Search failed: ${result.error.message}`;
                }
                draw();
              },
              (error) => {
                if (!finished && generation === current && !controller.signal.aborted) fail(error);
              },
            );
        });
      };
      const forward = (chunk: string | Buffer) => {
        keys.write(chunk);
      };
      keys.on(
        'keypress',
        (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
          if (finished) return;
          if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            cancel();
            return;
          }
          if (key.name === 'return' || key.name === 'enter') {
            const hit = report?.results[selected];
            if (report && hit)
              finish({ status: 'resolved', value: { report, catalogId: hit.catalogId } });
            return;
          }
          if (key.name === 'up' || key.name === 'down') {
            selected = Math.max(
              0,
              Math.min((report?.results.length ?? 1) - 1, selected + (key.name === 'up' ? -1 : 1)),
            );
            draw();
            return;
          }
          if (key.name === 'backspace') {
            query = [...query].slice(0, -1).join('');
            changed();
            return;
          }
          if (text && !key.ctrl && !key.meta && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) {
            query += text;
            changed();
          }
        },
      );
      try {
        input.setRawMode(true);
        input.on('data', forward);
        input.on('end', cancel);
        input.on('error', fail);
        output.on('resize', draw);
        request.signal?.addEventListener('abort', cancel, { once: true });
        ownsScreen = true;
        output.write('\x1b[?1049h');
        input.resume();
        changed();
      } catch (error) {
        fail(error);
      }
    }),
});
