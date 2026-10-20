/** Requests belong to the current page/module instance, including across bfcache restores. */
export function createRequestLifetime(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
) {
  let controller = new AbortController();
  const abort = () => controller.abort();
  const resume = () => {
    if (controller.signal.aborted) controller = new AbortController();
  };
  target.addEventListener('pagehide', abort);
  target.addEventListener('pageshow', resume);
  return {
    signal: () => controller.signal,
    abort,
    dispose() {
      abort();
      target.removeEventListener('pagehide', abort);
      target.removeEventListener('pageshow', resume);
    },
  };
}
