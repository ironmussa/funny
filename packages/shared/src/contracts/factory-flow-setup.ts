/**
 * Contracts for guided factory flow configuration setup
 * (openspec `factory-flow-bootstrap`, D4). Re-exported from `factory.ts`.
 */

import { z } from 'zod';

const projectId = z.string().min(1);
const flowName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Flow names use lowercase letters, digits, ".", "_" and "-"',
  );

export const factoryFlowSetupInput = z
  .object({ projectId, flowName: flowName.optional() })
  .strict();

export const factoryConfirmFlowSetupInput = z
  .object({
    projectId,
    setupId: z.string().min(1),
    fileSha: z.string().max(128),
    variant: z.enum(['rules', 'opt-out']),
  })
  .strict();

export const factorySetupIdInput = z.object({ projectId, setupId: z.string().min(1) }).strict();

export type FactoryFlowSetupState =
  | 'generating'
  | 'verifying'
  | 'proposed'
  | 'committing'
  | 'push_rejected'
  | 'pr_open'
  | 'committed'
  | 'discarded'
  | 'failed';

export interface FactoryFlowSetupRuleCheckRun {
  command: string;
  files: string[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The end of the command's output. */
  output: string;
}

export interface FactoryFlowSetupRuleVerdict {
  ruleIndex: number;
  globs: string[];
  command: string;
  cwd?: string;
  accepted: boolean;
  rejectionReason?: string;
  passingCanary?: FactoryFlowSetupRuleCheckRun;
  failingCanary?: FactoryFlowSetupRuleCheckRun;
  existingTest?: FactoryFlowSetupRuleCheckRun;
  twoFileRun?: FactoryFlowSetupRuleCheckRun;
}

export interface FactoryFlowSetupVerdicts {
  /** The end of the setup command's output, when it failed. */
  setupOutput?: string;
  rules: FactoryFlowSetupRuleVerdict[];
  uncovered: Array<{ scope: string; reason: string }>;
  timedOut: boolean;
}

export interface FactoryFlowSetupPackageFacts {
  name: string;
  dir: string;
  runner: string;
  configFiles: string[];
  testPatterns: string[];
}

export interface FactoryFlowSetupFacts {
  packageManager?: string | null;
  recognized: boolean;
  workspaces?: string[];
  packages?: FactoryFlowSetupPackageFacts[];
  infraFiles?: string[];
  error?: string;
}

export interface FactoryFlowSetupView {
  id: string;
  projectId: string;
  flowName: string;
  defaultBranch: string;
  baseSha: string;
  threadId: string | null;
  branch: string;
  state: FactoryFlowSetupState;
  startingFile: string;
  startingSource: 'repo' | 'builtin';
  builtinPrompts: Array<{ path: string; content: string }>;
  proposedFile: string | null;
  proposedFileSha: string | null;
  commitVariant: 'rules' | 'opt-out' | null;
  facts: FactoryFlowSetupFacts | null;
  verdicts: FactoryFlowSetupVerdicts | null;
  error: string | null;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}
