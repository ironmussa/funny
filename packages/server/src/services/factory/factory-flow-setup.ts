/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Guided factory flow configuration setup (openspec `factory-flow-bootstrap`, D4).
 * This module wires the shared context; the operations live in:
 *   - `factory-flow-setup-start.ts`: `startFlowSetup` (Task 4.2)
 *   - `factory-flow-setup-verification.ts`: `onSetupThreadTerminal`, `pollVerifyOnce` (Task 4.4)
 *   - `factory-flow-setup-confirm.ts`: `confirmFlowSetup`, `openFlowSetupPullRequest`,
 *     `discardFlowSetup` (Task 4.5) and `reconcileFlowSetups` (Task 4.6)
 */

import type { FactoryFlowSetupRow } from '@funny/shared/repositories';
import { err, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type {
  StartThreadInput,
  StartedThread,
  StartThreadError,
} from '../runner-thread-launcher.js';
import { startThreadOnRunner } from '../runner-thread-launcher.js';
import { requestThreadWorkspaceCleanup } from '../thread-workspace-cleanup.js';
import {
  confirmFlowSetupOp,
  discardFlowSetupOp,
  openFlowSetupPullRequestOp,
  reconcileFlowSetupsOp,
} from './factory-flow-setup-confirm.js';
import { startFlowSetupOp } from './factory-flow-setup-start.js';
import type {
  FactoryFlowSetupServiceDeps,
  FlowSetupActivityRecord,
  FlowSetupActor,
  FlowSetupError,
  SetupServiceContext,
  UncoveredScope,
} from './factory-flow-setup-types.js';
import { onSetupThreadTerminalOp, pollVerifyOnceOp } from './factory-flow-setup-verification.js';

export { sha256Hex } from './factory-flow-setup-helpers.js';
export type {
  FactoryFlowSetupServiceDeps,
  FlowSetupActivityRecord,
  FlowSetupActor,
  FlowSetupError,
  FlowSetupRepoReader,
  StoredSetupPromptFile,
  StoredSetupVerdicts,
} from './factory-flow-setup-types.js';

const ns = 'factory-flow-setup';

export function createFactoryFlowSetupService(deps: FactoryFlowSetupServiceDeps) {
  const { repo } = deps;
  const activePollers = new Set<string>();

  async function doCleanup(setup: FactoryFlowSetupRow, deleteBranch: boolean): Promise<void> {
    if (!setup.threadId || !setup.worktreePath) return;
    if (deps.cleanupWorkspace) {
      await deps.cleanupWorkspace({
        userId: setup.userId,
        projectId: setup.projectId,
        threadId: setup.threadId,
        worktreePath: setup.worktreePath,
        branch: setup.branch,
        deleteBranch,
        reason: 'factory-setup',
      });
      return;
    }
    if (deps.ports) {
      await requestThreadWorkspaceCleanup(deps.ports, {
        userId: setup.userId,
        thread: {
          id: setup.threadId,
          projectId: setup.projectId,
          worktreePath: setup.worktreePath,
          branch: setup.branch,
        },
        deleteBranch,
        reason: 'factory-setup',
        origin: 'implicit',
      });
    }
  }

  async function recordAct(record: FlowSetupActivityRecord): Promise<void> {
    if (!deps.recordActivity) return;
    await deps.recordActivity(record).catch((e) => {
      log.warn('Failed to record factory setup activity', {
        namespace: ns,
        kind: record.kind,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  async function launchSetupThread(
    input: StartThreadInput,
  ): Promise<Result<StartedThread, StartThreadError>> {
    if (deps.launchThread) return deps.launchThread(input);
    if (!deps.ports) {
      return err({
        kind: 'runner-unavailable',
        status: 502,
        message: 'Runner ports not configured',
      });
    }
    return startThreadOnRunner(input, deps.ports);
  }

  async function resolveFlowName(
    userId: string,
    projectId: string,
    explicit?: string,
  ): Promise<string> {
    if (explicit) return explicit;
    if (deps.configuredFlowName) return deps.configuredFlowName(userId, projectId);
    return 'issue-to-merge';
  }

  function scheduleVerifyPoll(setupId: string, uncovered: UncoveredScope[]): void {
    if (deps.autoPollVerify === false || activePollers.has(setupId)) return;
    activePollers.add(setupId);
    const intervalMs = deps.verifyPollIntervalMs ?? 3000;

    const tick = async () => {
      try {
        const status = await pollVerifyOnceOp(ctx, setupId, uncovered);
        if (status === 'running') {
          setTimeout(() => void tick(), intervalMs);
          return;
        }
      } catch (e) {
        log.warn('Error polling flow setup verification job', {
          namespace: ns,
          setupId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      activePollers.delete(setupId);
    };

    setTimeout(() => void tick(), intervalMs);
  }

  const ctx: SetupServiceContext = {
    deps,
    emit: (userId, projectId, setupId, state) =>
      deps.emitEvent?.(userId, projectId, setupId, state),
    doCleanup,
    recordAct,
    launchSetupThread,
    resolveFlowName,
    pollVerifyOnce: (setupId, uncoveredOverride) =>
      pollVerifyOnceOp(ctx, setupId, uncoveredOverride),
    scheduleVerifyPoll,
  };

  /** Read the member's current (or most recent) flow setup for a project + flow. */
  async function getFlowSetup(
    actor: FlowSetupActor,
    projectId: string,
    explicitFlowName?: string,
  ): Promise<FactoryFlowSetupRow | null> {
    const flowName = await resolveFlowName(actor.userId, projectId, explicitFlowName);
    const open = await repo.getOpenByUserProjectFlow(actor.userId, projectId, flowName);
    if (open) return open;
    const latest = await repo.getLatestByUserProjectFlow(actor.userId, projectId, flowName);
    return latest ?? null;
  }

  return {
    startFlowSetup: (
      actor: FlowSetupActor,
      projectId: string,
      explicitFlowName?: string,
    ): Promise<Result<FactoryFlowSetupRow, FlowSetupError>> =>
      startFlowSetupOp(ctx, actor, projectId, explicitFlowName),
    onSetupThreadTerminal: (threadId: string, status: string): Promise<void> =>
      onSetupThreadTerminalOp(ctx, threadId, status),
    pollVerifyOnce: ctx.pollVerifyOnce,
    confirmFlowSetup: (
      actor: FlowSetupActor,
      setupId: string,
      fileSha: string,
      variant: 'rules' | 'opt-out',
    ): Promise<Result<FactoryFlowSetupRow, FlowSetupError>> =>
      confirmFlowSetupOp(ctx, actor, setupId, fileSha, variant),
    openFlowSetupPullRequest: (
      actor: FlowSetupActor,
      setupId: string,
    ): Promise<Result<FactoryFlowSetupRow, FlowSetupError>> =>
      openFlowSetupPullRequestOp(ctx, actor, setupId),
    discardFlowSetup: (
      actor: FlowSetupActor,
      setupId: string,
    ): Promise<Result<FactoryFlowSetupRow, FlowSetupError>> =>
      discardFlowSetupOp(ctx, actor, setupId),
    reconcileFlowSetups: (): Promise<void> => reconcileFlowSetupsOp(ctx),
    getFlowSetup,
  };
}

export type FactoryFlowSetupService = ReturnType<typeof createFactoryFlowSetupService>;
