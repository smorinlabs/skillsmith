import type { ExitCode } from './exit-codes.ts';

export interface SignalHandle {
  uninstall: () => void;
  wasInterrupted: () => boolean;
  /** Exit code matching the received signal, or undefined if not interrupted. */
  exitCode: () => ExitCode | undefined;
}

const EXIT_FOR_SIGNAL = {
  SIGINT: 130,
  SIGTERM: 130,
} as const satisfies Record<string, ExitCode>;

type HandledSignal = keyof typeof EXIT_FOR_SIGNAL;

export const installSignalHandler = (controller: AbortController): SignalHandle => {
  const signals: readonly HandledSignal[] = ['SIGINT', 'SIGTERM'];
  let received: HandledSignal | null = null;
  const bindings: Array<[HandledSignal, () => void]> = signals.map((sig) => {
    const fn = (): void => {
      received ??= sig;
      controller.abort();
      process.exitCode = 130;
    };
    process.on(sig, fn);
    return [sig, fn];
  });
  return {
    uninstall: () => {
      for (const [sig, fn] of bindings) process.off(sig, fn);
    },
    wasInterrupted: () => received !== null,
    exitCode: () => (received === null ? undefined : EXIT_FOR_SIGNAL[received]),
  };
};
