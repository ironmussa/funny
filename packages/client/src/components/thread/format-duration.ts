/** Run duration as "12s", "1m 5s" or "1h 2m" through the `duration.*` strings. */
export function formatDuration(
  ms: number,
  t: (key: string, opts?: { [option: string]: string | number }) => string,
): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('duration.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainingSeconds = seconds % 60;
    return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds });
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return t('duration.hoursMinutes', { hours, minutes: remainingMinutes });
}
