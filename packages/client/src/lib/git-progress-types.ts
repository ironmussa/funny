export type SubItemStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GitProgressSubItem {
  label: string;
  status: SubItemStatus;
  error?: string;
}

export interface GitProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  /** Optional URL to display on completion (e.g., PR link) */
  url?: string;
  /** Optional sub-items with individual status tracking (e.g., individual hook scripts) */
  subItems?: GitProgressSubItem[];
  /** Timestamp (ms) when this step started running — persisted in the store to survive navigation */
  startedAt?: number;
  /** Timestamp (ms) when this step completed/failed — persisted in the store to survive navigation */
  completedAt?: number;
}
