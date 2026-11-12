/**
 * What the procedures need from the server. The server implements these on
 * top of its repositories and services (`packages/server/src/trpc/ports/`);
 * this package only sees the shapes, so `AppRouter` never drags server
 * modules into a client's typecheck.
 *
 * Each method answers for one user and fails with the status its REST route
 * answers, so both paths behave the same while they coexist.
 */

import type { Automation, AutomationRun, InboxItem, RunTriageStatus } from '@funny/shared';
import type {
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@funny/shared/contracts/automations';
import type { Result } from 'neverthrow';

import type { ApiFailure } from './failure.js';

export type PortResult<T> = Promise<Result<T, ApiFailure>>;

type Ok = { ok: true };

export interface AutomationsPort {
  inbox(
    userId: string,
    query: { projectId?: string; triageStatus?: string },
  ): PortResult<InboxItem[]>;
  list(userId: string, query: { projectId?: string }): PortResult<Automation[]>;
  get(userId: string, id: string): PortResult<Automation>;
  create(userId: string, data: CreateAutomationRequest): PortResult<Automation>;
  update(userId: string, id: string, data: UpdateAutomationRequest): PortResult<Automation>;
  remove(userId: string, id: string): PortResult<Ok>;
  trigger(userId: string, id: string): PortResult<Ok & { runId: string; threadId: string }>;
  runs(userId: string, id: string): PortResult<AutomationRun[]>;
  triageRun(userId: string, runId: string, triageStatus: RunTriageStatus): PortResult<Ok>;
}

export interface ApiPorts {
  automations: AutomationsPort;
}
