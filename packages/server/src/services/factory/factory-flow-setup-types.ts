/**
 * Types shared by the factory flow setup service and its operation modules
 * (openspec `factory-flow-bootstrap`, D4). `factory-flow-setup.ts` re-exports
 * the public ones.
 */

import type { GithubCallError } from '@funny/core/github-app';
import type { WorkspaceCleanupReason } from '@funny/shared/activities';
import type { FactoryFlowSetupRepository, FactoryFlowSetupRow } from '@funny/shared/repositories';
import type { Result } from 'neverthrow';

import type {
  RunnerPorts,
  StartThreadInput,
  StartedThread,
  StartThreadError,
} from '../runner-thread-launcher.js';
import type {
  FactoryFlowSetupRunnerClient,
  VerifyFlowSetupResult,
} from './factory-flow-setup-runner.js';

export interface FlowSetupActor {
  userId: string;
  orgId?: string;
  role?: string;
  orgName?: string;
}

export type FlowSetupError =
  | { kind: 'forbidden'; status: 403; message: string }
  | { kind: 'not-found'; status: 404; message: string }
  | { kind: 'invalid-flow'; status: 409; message: string }
  | { kind: 'already-ready'; status: 409; message: string }
  | { kind: 'invalid-state'; status: 409; message: string }
  | {
      kind: 'file-changed';
      status: 409;
      message: string;
      currentSha: string;
      currentFile: string;
    }
  | { kind: 'unavailable'; status: 503; message: string }
  | { kind: 'runner-offline'; status: 502; message: string };

export interface StoredSetupPromptFile {
  path: string;
  content: string;
}

export interface UncoveredScope {
  scope: string;
  reason: string;
}

export interface StoredSetupVerdicts {
  setupOutput?: string;
  rules: VerifyFlowSetupResult['rules'];
  uncovered: UncoveredScope[];
  timedOut: boolean;
}

export interface FlowSetupRepoReader {
  defaultBranchHead(): Promise<Result<{ branch: string; sha: string }, GithubCallError>>;
  readDefaultBranchFile(path: string): Promise<Result<string | null, GithubCallError>>;
  readFileAt?(path: string, ref: string): Promise<Result<string | null, GithubCallError>>;
  getPullRequestState?(
    prNumber: number,
  ): Promise<Result<'open' | 'merged' | 'closed', GithubCallError>>;
}

export interface FlowSetupActivityRecord {
  kind: 'factory.setup_push' | 'factory.setup_pr';
  userId: string;
  projectId: string;
  threadId?: string;
  title: string;
  input: {
    setupId: string;
    flowName: string;
    branch: string;
    variant?: 'rules' | 'opt-out';
    commitSha?: string;
    base?: string;
    prNumber?: number;
  };
  ok: boolean;
  error?: string;
}

export interface FactoryFlowSetupServiceDeps {
  repo: FactoryFlowSetupRepository;
  runner: FactoryFlowSetupRunnerClient;
  ports?: RunnerPorts;
  /** Optional `steer` capability check (in addition to tRPC `projectProcedure('steer')`). */
  canSteer?: (userId: string, projectId: string) => Promise<boolean>;
  /** Resolve configured flow name for a user's factory on a project (defaults to `'issue-to-merge'`). */
  configuredFlowName?: (userId: string, projectId: string) => Promise<string>;
  /** Resolve the GitHub reader for a project's repository. */
  repoReader: (userId: string, projectId: string) => Promise<FlowSetupRepoReader | null>;
  /** Launch a thread on the member's runner (defaults to `startThreadOnRunner`). */
  launchThread?: (input: StartThreadInput) => Promise<Result<StartedThread, StartThreadError>>;
  /** Read the last assistant message of a thread (for canary manifest extraction). */
  getLastAssistantMessage: (threadId: string) => Promise<string | null>;
  /** Clean up worktree / branch on `committed`, `discarded`, or `pr_open`. */
  cleanupWorkspace?: (req: {
    userId: string;
    projectId: string;
    threadId: string;
    worktreePath: string;
    branch: string;
    deleteBranch: boolean;
    reason: WorkspaceCleanupReason;
  }) => Promise<void>;
  /** Record a background activity for outward writes (push, pull request). */
  recordActivity?: (record: FlowSetupActivityRecord) => Promise<void>;
  /** Notify browsers of setup state changes. */
  emitEvent?: (userId: string, projectId: string, setupId: string, state: string) => void;
  /** Override built-in workflows directory (tests). */
  defaultsDir?: string;
  /** Verification poll interval in ms (defaults to 3000ms). */
  verifyPollIntervalMs?: number;
  /** Whether to auto-poll after starting verification (true in prod; tests can control it). */
  autoPollVerify?: boolean;
}

/** What the operation modules share, built once by `createFactoryFlowSetupService`. */
export interface SetupServiceContext {
  deps: FactoryFlowSetupServiceDeps;
  emit: (userId: string, projectId: string, setupId: string, state: string) => void;
  doCleanup: (setup: FactoryFlowSetupRow, deleteBranch: boolean) => Promise<void>;
  recordAct: (record: FlowSetupActivityRecord) => Promise<void>;
  launchSetupThread: (input: StartThreadInput) => Promise<Result<StartedThread, StartThreadError>>;
  resolveFlowName: (userId: string, projectId: string, explicit?: string) => Promise<string>;
  pollVerifyOnce: (
    setupId: string,
    uncoveredOverride?: UncoveredScope[],
  ) => Promise<'running' | 'done' | 'unreachable'>;
  scheduleVerifyPoll: (setupId: string, uncovered: UncoveredScope[]) => void;
}
