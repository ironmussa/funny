import type { CICheck } from '@funny/shared';

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);
const PASSED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function checkPriority(check: CICheck): number {
  if (check.status !== 'completed') return 1;
  if (check.conclusion && FAILED_CONCLUSIONS.has(check.conclusion)) return 0;
  if (check.conclusion && PASSED_CONCLUSIONS.has(check.conclusion)) return 2;
  return 1;
}

/** Failures first, then pending, then successes, so red is always at the top. */
export function sortChecks(checks: readonly CICheck[]): CICheck[] {
  return checks.toSorted((a, b) => checkPriority(a) - checkPriority(b));
}
