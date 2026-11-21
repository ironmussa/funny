import type { AgentPlanUsageWindow } from '@funny/shared';

const WINDOW_LABELS = new Map([
  ['five_hour', 'Current session (5h)'],
  ['seven_day', 'Weekly · all models'],
  ['seven_day_opus', 'Weekly · Opus'],
  ['seven_day_sonnet', 'Weekly · Sonnet'],
  ['seven_day_oauth_apps', 'Weekly · apps'],
]);

/** Display label of a plan usage window. */
export function usageWindowLabel(w: AgentPlanUsageWindow): string {
  if (w.label) return `Weekly · ${w.label}`;
  return WINDOW_LABELS.get(w.key) ?? w.key;
}

/** `Max` for `max`, `Pro` for `pro`, … */
export function planLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** `resets in 2h 13m` / `resets in 3d 4h`; `reset` once the time has passed. */
export function formatResetsIn(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'reset';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${rest}m`;
  return `resets in ${rest}m`;
}

/**
 * The window's utilization (0-100) as of `now`: a window whose reset time has
 * passed since the snapshot is back at 0, whatever the stale snapshot says.
 */
export function currentUtilization(
  w: AgentPlanUsageWindow,
  now: number = Date.now(),
): number | null {
  if (w.resetsAt && Date.parse(w.resetsAt) <= now) return 0;
  if (w.utilization === null) return null;
  return Math.max(0, Math.min(100, w.utilization));
}
