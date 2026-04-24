export interface SignalHandle {
  uninstall: () => void;
  wasInterrupted: () => boolean;
  /** Exit code matching the received signal, or undefined if not interrupted. */
  exitCode: () => number | undefined;
}

const EXIT_FOR_SIGNAL = {
  SIGINT: 130,
  SIGTERM: 143,
} as const satisfies Record<string, number>;

type HandledSignal = keyof typeof EXIT_FOR_SIGNAL;

export const installSignalHandler = (controller: AbortController): SignalHandle => {
  const signals: readonly HandledSignal[] = ['SIGINT', 'SIGTERM'];
  let received: HandledSignal | null = null;
  const bindings: Array<[HandledSignal, () => void]> = signals.map((sig) => {
    const fn = (): void => {
      received = sig;
      controller.abort();
      process.exitCode = EXIT_FOR_SIGNAL[sig];
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
