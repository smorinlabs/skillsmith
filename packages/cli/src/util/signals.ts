export interface SigintHandle {
  uninstall: () => void;
  wasInterrupted: () => boolean;
}

export const installSigintHandler = (controller: AbortController): SigintHandle => {
  let interrupted = false;
  const handler = () => {
    interrupted = true;
    controller.abort();
    process.exitCode = 130;
  };
  process.on('SIGINT', handler);
  return {
    uninstall: () => {
      process.off('SIGINT', handler);
    },
    wasInterrupted: () => interrupted,
  };
};
