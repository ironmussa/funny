import type { AgentModel } from '../models.js';
import type { AgentProvider, PermissionMode, ThreadMode } from '../primitives.js';
import type { AutomationSource } from './funny-config.js';
import type { Thread } from './thread.js';

// ─── Automations ────────────────────────────────────────

// Cron expression string — e.g. "0 9 * * *" (daily at 9am)
export type AutomationSchedule = string;
export type RunTriageStatus = 'pending' | 'reviewed' | 'dismissed';

export interface Automation {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  provider: AgentProvider;
  model: AgentModel;
  mode: ThreadMode;
  permissionMode: PermissionMode;
  baseBranch?: string;
  enabled: boolean;
  maxRunHistory: number;
  lastRunAt?: string;
  /** Whether this automation was created in the UI or synced from .funny.json */
  source?: AutomationSource;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  threadId: string;
  status: 'running' | 'completed' | 'failed' | 'archived';
  triageStatus: RunTriageStatus;
  hasFindings?: boolean;
  summary?: string;
  startedAt: string;
  completedAt?: string;
}

export interface CreateAutomationRequest {
  projectId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  provider?: AgentProvider;
  model?: AgentModel;
  mode?: ThreadMode;
  permissionMode?: PermissionMode;
  baseBranch?: string;
}

export interface UpdateAutomationRequest {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  provider?: AgentProvider;
  model?: AgentModel;
  mode?: ThreadMode;
  permissionMode?: PermissionMode;
  baseBranch?: string;
  enabled?: boolean;
  maxRunHistory?: number;
}

export interface InboxItem {
  run: AutomationRun;
  automation: Automation;
  thread: Thread;
}
