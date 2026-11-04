/**
 * Compact elapsed-time label ("now", "5m", "3h", "2d", "4mo", "1y") shared by
 * the web and native sidebars. Future times count as "now".
 */
export function formatCompactElapsed(thenMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - thenMs) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
