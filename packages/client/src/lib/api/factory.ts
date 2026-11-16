/** The issue factory for a project (change issue-factory): settings + runs. */
import { request } from './_core';

export interface FactorySettings {
  projectId: string;
  enabled: boolean;
  label: string;
  flowName: string;
  maxConcurrent: number;
  updatedAt: string;
}

export interface SaveFactorySettingsInput {
  enabled: boolean;
  label?: string;
  flowName?: string;
  maxConcurrent?: number;
}

type FactoryRunState =
  | 'queued'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'waiting_human'
  | 'merged'
  | 'failed'
  | 'stopped';

interface FactoryRun {
  id: string;
  factoryId: string;
  issueNumber: number;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  startedAt: string;
  completedAt: string | null;
}

export const factoryApi = {
  getSettings: (projectId: string) =>
    request<{ settings: FactorySettings | null }>(`/factory/projects/${projectId}`),
  saveSettings: (projectId: string, data: SaveFactorySettingsInput) =>
    request<{ settings: FactorySettings }>(`/factory/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  listRuns: (projectId: string) =>
    request<{ runs: FactoryRun[] }>(`/factory/projects/${projectId}/runs`),
};
