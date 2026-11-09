/**
 * Launch a thread's sandbox (change thread-sandboxes): the checks that must
 * pass before anything is created, then the provisioning itself. Shared by the
 * infra API (sandbox for an existing thread) and sandbox thread creation.
 */

import { ACTIVE_SANDBOX_STATES, type SandboxState } from '@funny/shared/sandbox-machine';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes, threads } from '../../db/schema.js';
import { deriveServerKey } from '../../lib/auth.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../runner-ports.js';
import { issueThreadProvisionToken } from '../runner-provision-tokens.js';
import { sandboxRunnerIdForThread } from '../runner-scope.js';
import type { InfraConnectionService } from './infra-connections.js';
import { withProvisionTracking } from './provision-registry.js';
import { resolvePublicServerUrl } from './public-server-url.js';
import { resolveServerRunnerBuild } from './runner-build.js';
import { chooseRunnerLink, type RunnerLink } from './runner-link.js';
import { createSandboxRunnerCalls } from './sandbox-runner-calls.js';
import { createRunnerTemplateManager, type RunnerTemplateManager } from './template-manager.js';
import { createThreadSandboxService, type ProvisionError } from './thread-sandbox-service.js';
import { sqlThreadSandboxStore, type ThreadSandboxRow } from './thread-sandbox-store.js';

const defaultReverseLinkKey = () => deriveServerKey('reverse-link');

/** One template manager per server build, shared by every launch. */
const templateManagers = new Map<string, RunnerTemplateManager>();

export interface SandboxLaunchRequest {
  userId: string;
  threadId: string;
  projectId: string;
  projectPath: string;
  connectionId: string;
  sizeId?: string;
  /** Repository to clone; defaults to the project's origin, then the last one used. */
  repoUrl?: string;
}

export interface SandboxLaunchPorts {
  connections: Pick<InfraConnectionService, 'providerFor'>;
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
  /** Key of the reverse link's secrets; defaults to one derived from the auth secret. */
  reverseLinkKey?: () => Buffer;
}

/** Why a launch was refused before anything was created (HTTP 409). */
export interface SandboxLaunchRefusal {
  code: string;
  message: string;
}

export interface PreparedSandboxLaunch {
  repoUrl: string;
  provision(): Promise<Result<ThreadSandboxRow, ProvisionError>>;
}

/** The repository the user's last sandbox of this project cloned. */
async function lastRepoUrlForProject(userId: string, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoUrl: threadSandboxes.repoUrl })
    .from(threadSandboxes)
    .innerJoin(threads, eq(threads.id, threadSandboxes.threadId))
    .where(
      and(
        eq(threadSandboxes.userId, userId),
        eq(threads.projectId, projectId),
        isNotNull(threadSandboxes.repoUrl),
      ),
    )
    .orderBy(desc(threadSandboxes.updatedAt))
    .limit(1);
  return row?.repoUrl ?? null;
}

/** Direct when the server is public; otherwise the provider must let the server dial in. */
async function resolveRunnerLink(
  req: SandboxLaunchRequest,
  ports: SandboxLaunchPorts,
): Promise<Result<RunnerLink, SandboxLaunchRefusal>> {
  const publicUrl = resolvePublicServerUrl();
  if (publicUrl.isOk()) return ok({ kind: 'direct', serverUrl: publicUrl.value });
  const provider = await ports.connections.providerFor(req.userId, req.connectionId);
  if (provider.isErr()) return err({ code: 'connection', message: provider.error.message });
  return chooseRunnerLink(
    publicUrl,
    provider.value.provider,
    ports.reverseLinkKey ?? defaultReverseLinkKey,
  );
}

export async function prepareSandboxLaunch(
  req: SandboxLaunchRequest,
  ports: SandboxLaunchPorts,
): Promise<Result<PreparedSandboxLaunch, SandboxLaunchRefusal>> {
  const build = await resolveServerRunnerBuild();
  if (build.isErr()) return err({ code: build.error.kind, message: build.error.message });
  const runnerLink = await resolveRunnerLink(req, ports);
  if (runnerLink.isErr()) return err(runnerLink.error);
  const existing = await sqlThreadSandboxStore.get(req.threadId);
  if (
    existing.isOk() &&
    existing.value &&
    ACTIVE_SANDBOX_STATES.has(existing.value.state as SandboxState)
  ) {
    return err({
      code: 'already-provisioned',
      message: `Thread already has a ${existing.value.state} sandbox`,
    });
  }

  const calls = createSandboxRunnerCalls({ requests: ports.requests, presence: ports.presence });
  let repoUrl = req.repoUrl ?? null;
  if (!repoUrl) {
    const remote = await calls.projectRemoteUrl({ userId: req.userId, projectId: req.projectId });
    repoUrl = remote.isOk() ? remote.value : null;
  }
  repoUrl ??= await lastRepoUrlForProject(req.userId, req.projectId);
  if (!repoUrl) {
    return err({
      code: 'repo-url-unknown',
      message:
        "Could not determine the project's repository URL; pass repoUrl or connect the project's runner.",
    });
  }

  let templates = templateManagers.get(build.value.version);
  if (!templates) {
    templates = createRunnerTemplateManager(build.value);
    templateManagers.set(build.value.version, templates);
  }
  const service = createThreadSandboxService({
    connections: ports.connections,
    templates,
    build: build.value,
    runnerLink: runnerLink.value,
    issueToken: issueThreadProvisionToken,
    sandboxRunnerIdForThread,
    requestCheckout: calls.checkout,
    presence: ports.presence,
    store: sqlThreadSandboxStore,
  });
  const checkout = { path: req.projectPath, repoUrl };
  return ok({
    repoUrl,
    // Tracked so deleting the thread cancels the preparation (provision-registry).
    provision: () =>
      withProvisionTracking(req.threadId, async (signal) =>
        service.provision({
          userId: req.userId,
          threadId: req.threadId,
          connectionId: req.connectionId,
          sizeId: req.sizeId,
          checkout,
          signal,
        }),
      ),
  });
}
