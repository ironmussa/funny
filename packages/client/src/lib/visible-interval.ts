/**
 * Like `setInterval`, but only while the document is visible: a hidden tab
 * stops polling, and becoming visible again runs `tick` at once (the data may be
 * stale) and resumes the interval. Returns a cleanup function.
 */
export function setVisibleInterval(tick: () => void, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else if (timer === null) {
      tick();
      start();
    }
  };
  if (document.visibilityState !== 'hidden') start();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
