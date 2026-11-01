import type { AgentProvider, ImageAttachment } from '@funny/shared';
import type { AgentModel } from '@funny/shared/models';

export type SubmitOpts = {
  provider?: string;
  model: string;
  mode: string;
  effort?: string;
  threadMode?: string;
  runtime?: string;
  baseBranch?: string;
  cwd?: string;
  sendToBacklog?: boolean;
  fileReferences?: { path: string; type?: 'file' | 'folder' }[];
  symbolReferences?: {
    path: string;
    name: string;
    kind: string;
    line: number;
    endLine?: number;
  }[];
};

export type SubmitFn = (
  prompt: string,
  opts: SubmitOpts,
  images?: ImageAttachment[],
) => Promise<boolean | void> | boolean | void;

export interface ThreadOverride {
  provider?: AgentProvider | null;
  model?: AgentModel | null;
  permissionMode?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  contextUsage?: { cumulativeInputTokens?: number } | null;
  queuedCount?: number | null;
  projectId?: string | null;
}
