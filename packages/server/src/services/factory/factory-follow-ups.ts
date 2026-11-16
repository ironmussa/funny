/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * Follow-ups the thread's OWNER sent to a factory thread (`POST
 * /api/threads/:id/message`), by thread: a take-over needs one sent after the
 * run parked. A steer sharee's follow-up is never noted, so it cannot move the
 * flow on (toward a merge) in the enabler's name; neither can a duplicate
 * terminal write or an old chat. In memory: after a restart, Retry still works.
 */
const ownerFollowUps = new Map<string, number>();
const FOLLOW_UP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function noteOwnerFollowUp(threadId: string, at = Date.now()): void {
  for (const [id, noted] of ownerFollowUps) {
    if (at - noted > FOLLOW_UP_TTL_MS) ownerFollowUps.delete(id);
  }
  ownerFollowUps.set(threadId, at);
}

/** When the owner last followed up on the thread, if they did (and it was noted). */
export function ownerFollowUpAt(threadId: string): number | undefined {
  return ownerFollowUps.get(threadId);
}

export function forgetOwnerFollowUp(threadId: string): void {
  ownerFollowUps.delete(threadId);
}
