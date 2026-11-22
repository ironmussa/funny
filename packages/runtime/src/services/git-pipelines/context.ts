import type {
  AgentModel,
  GitWorkflowAction,
  GitWorkflowProgressStep,
  PipelineVerdict,
  WSGitWorkflowProgressData,
} from '@funny/shared';

/** The context threaded through every git workflow pipeline node. */
export interface GitPipelineContext {
  // ── Identity / params ──────────────────────────────────
  contextId: string;
  threadId?: string;
  projectId?: string;
  userId: string;
  cwd: string;
  action: GitWorkflowAction;

  // ── Git operation params ───────────────────────────────
  message?: string;
  filesToStage?: string[];
  filesToUnstage?: string[];
  amend?: boolean;
  noVerify?: boolean;
  prTitle?: string;
  prBody?: string;
  targetBranch?: string;
  cleanup?: boolean;

  // ── Pre-commit hooks ───────────────────────────────────
  hooks: { label: string; command: string }[];

  // ── Pipeline config (for auto-fix + review) ────────────
  pipelineEnabled: boolean;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxReviewIterations: number;

  // ── Custom prompt overrides ──────────────────────────
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testFixerPrompt?: string;

  // ── Test auto-fix config ────────────────────────────────
  testEnabled: boolean;
  testCommand: string | null;
  testFixEnabled: boolean;
  testFixModel: AgentModel;
  testFixMaxIterations: number;

  // ── Test auto-fix tracking ──────────────────────────────
  testOutput: string | null;
  testPassed: boolean;
  testIteration: number;
  testFixerThreadId: string | null;

  // ── Review-fix tracking ────────────────────────────────
  commitSha: string | null;
  iteration: number;
  reviewerThreadId: string | null;
  verdict: PipelineVerdict | null;
  findings: string | null;
  correctorThreadId: string | null;
  patchDiff: string | null;
  noChanges: boolean;

  // ── Progress tracking ──────────────────────────────────
  steps: GitWorkflowProgressStep[];
  prUrl?: string;
  workflowId: string;

  // ── Helpers (bound at creation) ────────────────────────
  emit: (status: WSGitWorkflowProgressData['status']) => void;
  setStep: (stepId: string, update: Partial<GitWorkflowProgressStep>) => void;
}
