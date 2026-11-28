/**
 * Live singleton wiring for the factory flow setup service (openspec
 * `factory-flow-bootstrap`, D4). Shared between the tRPC port, thread terminal
 * notifications (`data-message-handlers.ts`), and the factory watcher's startup
 * and periodic reconciliation.
 */

import { err, ok } from 'neverthrow';

import { repos } from '../../db/repos.js';
import { recordServerActivity } from '../activities/server-activities.js';
import { relayToUser } from '../browser-events.js';
import { startThreadOnRunner } from '../runner-thread-launcher.js';
import { requestThreadWorkspaceCleanup } from '../thread-workspace-cleanup.js';
import {
  createFactoryFlowSetupRunnerClient,
  type FactoryFlowSetupRunnerClient,
} from './factory-flow-setup-runner.js';
import {
  createFactoryFlowSetupService,
  type FactoryFlowSetupService,
  type FlowSetupRepoReader,
} from './factory-flow-setup.js';
import { createFactorySettingsService } from './factory-settings.js';
import { factoryGithubPort, factoryRunnerPorts } from './factory-watcher.js';

let liveService: FactoryFlowSetupService | null = null;

function unavailableRunnerClient(): FactoryFlowSetupRunnerClient {
  const offline = async () =>
    err({
      kind: 'runner-unavailable' as const,
      message: 'Runner ports are not initialized on this server.',
    });
  return {
    detectStack: offline,
    readSetupFile: offline,
    sendFirstMessage: offline,
    startVerify: offline,
    pollVerify: offline,
    cancelVerify: offline,
    commitAndPush: offline,
    openPullRequest: offline,
  };
}

function dynamicRunnerClient(): FactoryFlowSetupRunnerClient {
  const client = () => {
    const ports = factoryRunnerPorts();
    return ports ? createFactoryFlowSetupRunnerClient(ports) : unavailableRunnerClient();
  };
  return {
    detectStack: (u, t) => client().detectStack(u, t),
    readSetupFile: (u, t, p) => client().readSetupFile(u, t, p),
    sendFirstMessage: (u, t, c, b) => client().sendFirstMessage(u, t, c, b),
    startVerify: (u, t, b) => client().startVerify(u, t, b),
    pollVerify: (u, t, j) => client().pollVerify(u, t, j),
    cancelVerify: (u, t, j) => client().cancelVerify(u, t, j),
    commitAndPush: (u, t, b) => client().commitAndPush(u, t, b),
    openPullRequest: (u, t, b) => client().openPullRequest(u, t, b),
  };
}

function createLiveService(): FactoryFlowSetupService {
  const settings = createFactorySettingsService();

  return createFactoryFlowSetupService({
    repo: repos.factoryFlowSetups(),
    runner: dynamicRunnerClient(),
    launchThread: async (input) => {
      const ports = factoryRunnerPorts();
      if (!ports) {
        return err({
          kind: 'runner-unavailable',
          status: 502,
          message: 'Runner ports are not initialized on this server.',
        });
      }
      return startThreadOnRunner(input, ports);
    },
    cleanupWorkspace: async (req) => {
      const ports = factoryRunnerPorts();
      if (!ports) return;
      await requestThreadWorkspaceCleanup(ports, {
        userId: req.userId,
        thread: {
          id: req.threadId,
          projectId: req.projectId,
          worktreePath: req.worktreePath,
          branch: req.branch,
        },
        deleteBranch: req.deleteBranch,
        reason: req.reason,
        origin: 'implicit',
      });
    },
    configuredFlowName: async (userId, projectId) => {
      const res = await settings.get(userId, projectId);
      return res.isOk() && res.value?.flowName ? res.value.flowName : 'issue-to-merge';
    },
    repoReader: async (userId, projectId): Promise<FlowSetupRepoReader | null> => {
      const github = factoryGithubPort();
      if (!github) return null;
      const repo = await github.resolveRepo(userId, projectId);
      if (!repo) return null;
      const reader = { repo, ownerId: userId, projectId };
      return {
        defaultBranchHead: async () => await github.defaultBranchHead(reader),
        readDefaultBranchFile: async (path) => await github.readDefaultBranchFile(reader, path),
        readFileAt: async (path, ref) => await github.readFileAt(reader, path, ref),
        getPullRequestState: async (prNumber) => {
          const state = await github.pullRequests.prState({
            repo,
            userId,
            projectId,
            number: prNumber,
          });
          if (state.isErr()) {
            return err({ kind: 'http', status: 502, message: state.error.message });
          }
          return ok(state.value);
        },
      };
    },
    getLastAssistantMessage: async (threadId) => {
      const page = await repos.messages().getThreadMessages({ threadId, limit: 50 });
      for (let i = page.messages.length - 1; i >= 0; i -= 1) {
        const msg = page.messages[i];
        if (msg && msg.role === 'assistant' && msg.content.trim().length > 0) {
          return msg.content;
        }
      }
      return null;
    },
    recordActivity: async (record) => {
      await recordServerActivity(
        {
          kind: record.kind,
          userId: record.userId,
          projectId: record.projectId,
          threadId: record.threadId,
          title: record.title,
          input: record.input,
          origin: 'user',
        },
        record.ok ? { ok: true } : { ok: false, error: record.error ?? 'Failed' },
      );
    },
    emitEvent: (userId, projectId, setupId, state) => {
      relayToUser(userId, {
        type: 'factory:setup_updated',
        data: { projectId, setupId, state },
      });
    },
  });
}

export function getLiveFactoryFlowSetupService(): FactoryFlowSetupService {
  liveService ??= createLiveService();
  return liveService;
}

export async function onFactoryFlowSetupThreadTerminal(
  threadId: string,
  status: string,
): Promise<void> {
  await getLiveFactoryFlowSetupService().onSetupThreadTerminal(threadId, status);
}

export async function reconcileFactoryFlowSetups(): Promise<void> {
  await getLiveFactoryFlowSetupService().reconcileFlowSetups();
}
