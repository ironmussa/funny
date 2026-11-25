import type { ActiveAgentSnapshot } from '@funny/core/agents';
import type { PermissionDecision } from '@funny/core/agents';
import type { AgentModel, AgentProvider, PermissionMode } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import type { AgentMcpServers } from './agent-startup/load-mcp-servers.js';

type StartAgent = (
  threadId: string,
  prompt: string,
  cwd: string,
  model?: AgentModel,
  permissionMode?: PermissionMode,
  images?: unknown[],
  disallowedTools?: string[],
  allowedTools?: string[],
  provider?: AgentProvider,
  mcpServers?: AgentMcpServers,
  skipMessageInsert?: boolean,
  effort?: string,
  steer?: boolean,
) => ResultAsync<void, DomainError>;

export interface AgentRunnerControl {
  startAgent: StartAgent;
  stopAgent: (threadId: string) => ResultAsync<void, DomainError>;
  stopAllAgents: () => Promise<void>;
  isAgentRunning: (threadId: string) => boolean;
  cleanupThreadState: (threadId: string) => void;
  extractActiveAgentSnapshot: () => ActiveAgentSnapshot;
  extractActiveAgents: () => Map<string, unknown>;
  getSupportedSlashCommands: (threadId: string) => Set<string> | undefined;
  respondToPermission: (
    threadId: string,
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<boolean>;
  getPendingPermission: (
    threadId: string,
    requestId: string,
  ) => { toolName: string; toolInput?: string } | undefined;
}

let control: AgentRunnerControl | undefined;

function currentControl(): AgentRunnerControl {
  if (!control) {
    throw new Error('Agent runner control has not been registered');
  }
  return control;
}

export function registerAgentRunnerControl(next: AgentRunnerControl): void {
  control = next;
}

export const startAgent: StartAgent = (...args) => currentControl().startAgent(...args);

export function stopAgent(threadId: string): ResultAsync<void, DomainError> {
  return currentControl().stopAgent(threadId);
}

export function stopAllAgents(): Promise<void> {
  return currentControl().stopAllAgents();
}

export function isAgentRunning(threadId: string): boolean {
  return currentControl().isAgentRunning(threadId);
}

export function extractActiveAgentSnapshot(): ActiveAgentSnapshot {
  return currentControl().extractActiveAgentSnapshot();
}

export function getSupportedSlashCommands(threadId: string): Set<string> | undefined {
  return currentControl().getSupportedSlashCommands(threadId);
}

export function respondToPermission(
  threadId: string,
  requestId: string,
  decision: PermissionDecision,
): Promise<boolean> {
  return currentControl().respondToPermission(threadId, requestId, decision);
}

export function getPendingPermission(
  threadId: string,
  requestId: string,
): { toolName: string; toolInput?: string } | undefined {
  return currentControl().getPendingPermission(threadId, requestId);
}
