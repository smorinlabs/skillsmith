export const installSigintHandler = (controller: AbortController): (() => void) => {
  const handler = () => {
    controller.abort();
    setTimeout(() => process.exit(130), 10);
  };
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
};
