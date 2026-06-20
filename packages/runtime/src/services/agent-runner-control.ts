import type { AgentModel, AgentProvider, PermissionMode } from '@funny/shared';

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
  mcpServers?: Record<string, unknown>,
  skipMessageInsert?: boolean,
  effort?: string,
  steer?: boolean,
) => Promise<void>;

export interface AgentRunnerControl {
  startAgent: StartAgent;
  stopAgent: (threadId: string) => Promise<void>;
  stopAllAgents: () => Promise<void>;
  isAgentRunning: (threadId: string) => boolean;
  cleanupThreadState: (threadId: string) => void;
  extractActiveAgents: () => Map<string, unknown>;
  getSupportedSlashCommands: (threadId: string) => Set<string> | undefined;
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

export function stopAgent(threadId: string): Promise<void> {
  return currentControl().stopAgent(threadId);
}

export function stopAllAgents(): Promise<void> {
  return currentControl().stopAllAgents();
}

export function isAgentRunning(threadId: string): boolean {
  return currentControl().isAgentRunning(threadId);
}

export function cleanupThreadState(threadId: string): void {
  currentControl().cleanupThreadState(threadId);
}

export function extractActiveAgents(): Map<string, unknown> {
  return currentControl().extractActiveAgents();
}

export function getSupportedSlashCommands(threadId: string): Set<string> | undefined {
  return currentControl().getSupportedSlashCommands(threadId);
}
