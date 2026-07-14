/**
 * Transport-aware permission approval state shared by the server, runtime,
 * and client. A request is durable metadata; its provider continuation stays
 * exclusively in the live runner process.
 */

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/** Why an otherwise actionable request can no longer be resumed. */
export type PermissionRecoveryReason = 'runner_lost';

export type PermissionApprovalCapability =
  | { kind: 'structured'; transport: 'codex-acp' }
  | { kind: 'unavailable'; reason: 'codex-sdk-no-interactive-approval' };

export type PendingPermissionStatus = 'active' | 'resolved' | 'expired';

/** Sanitized, client-safe representation of a provider-native request. */
export interface PendingPermissionRequest {
  requestId: string;
  threadId: string;
  runId: string;
  transport: 'codex-acp';
  toolCallId: string;
  toolName: string;
  toolInput?: string;
  canAlwaysAllow: boolean;
  canDeny: boolean;
  requestedAt: string;
}

/** Durable lifecycle fields retained for audit and stale-request checks. */
export interface PermissionRequestRecord extends PendingPermissionRequest {
  status: PendingPermissionStatus;
  resolvedDecision?: PermissionDecision;
  resolvedAt?: string;
  expiredAt?: string;
}

/** Returned when a card refers to a request that no longer owns a live run. */
export interface StalePermissionRequestError {
  code: 'stale_permission_request';
  message: string;
}
