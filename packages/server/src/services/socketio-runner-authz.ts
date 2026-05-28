/**
 * Pure helpers for runner → browser Socket.IO tenant checks (Security H2).
 * Extracted so cross-tenant rules are unit-testable without spinning up IO.
 */

export function extractRunnerEventUserId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const userId = (payload as Record<string, unknown>).userId;
  return typeof userId === 'string' ? userId : undefined;
}

/**
 * Returns true when a runner-owned socket may process an event carrying
 * `targetUserId`. Events without an explicit userId are allowed (callers
 * that omit userId must not touch tenant-scoped state).
 */
export function isRunnerEventAllowed(
  runnerUserId: string | null,
  targetUserId: string | undefined,
): boolean {
  if (targetUserId === undefined) return true;
  return !!runnerUserId && runnerUserId === targetUserId;
}
