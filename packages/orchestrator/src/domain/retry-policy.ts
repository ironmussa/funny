/**
 * Retrying infrastructure failures (#275): the configured delay, then twice
 * that, at most twice. Agent failures are never retried (the same prompt
 * would be paid for twice for the same result).
 */

export const MAX_INFRA_RETRIES = 2;

/**
 * When a run that has been retried `retries` times may try again after an
 * infrastructure failure at `now`, or null when its retries are used up.
 */
export function nextInfraRetry(retries: number, delayMinutes: number, now: Date): Date | null {
  if (retries >= MAX_INFRA_RETRIES) return null;
  return new Date(now.getTime() + delayMinutes * 60_000 * 2 ** retries);
}
