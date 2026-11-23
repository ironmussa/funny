/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */
/** `runtime: 'remote'` threads: launch a container and forward the first prompt to it. */

import { log } from '../../lib/logger.js';
import { safeFetchUserUrl } from '../../lib/ssrf-guard.js';
import { launchContainer } from '../podman-service.js';
import { getServices } from '../service-registry.js';
import * as tm from '../thread-manager.js';
import { markThreadFailed, type ProjectThreadContext } from './create-context.js';
import { ThreadServiceError, emitThreadUpdated } from './helpers.js';

/** Validate the launcher config and launch the container in the background. */
export async function startRemoteContainerThread(
  ctx: ProjectThreadContext,
  threadBranch: string | undefined,
  augmentedPrompt: string,
): Promise<void> {
  const { project, params } = ctx;
  if (!project.launcherUrl) {
    throw new ThreadServiceError('Project has no launcher URL configured', 400);
  }

  const branch = threadBranch || 'main';
  const githubToken = await getServices().profile.getGithubToken(params.userId);

  // Launch container in background
  void launchRemoteContainer(ctx, {
    launcherUrl: project.launcherUrl,
    branch,
    githubToken: githubToken ?? undefined,
    augmentedPrompt,
  });
}

async function launchRemoteContainer(
  ctx: ProjectThreadContext,
  launch: { launcherUrl: string; branch: string; githubToken?: string; augmentedPrompt: string },
): Promise<void> {
  const { params, threadId } = ctx;
  await tm.updateThread(threadId, { status: 'setting_up' });
  emitThreadUpdated(params.userId, threadId, { status: 'setting_up' });

  const result = await launchContainer({
    threadId,
    projectPath: ctx.project.path,
    launcherUrl: launch.launcherUrl,
    branch: launch.branch,
    githubToken: launch.githubToken,
  });

  if (result.isErr()) {
    log.error('Failed to launch container', { threadId, error: result.error.message });
    await markThreadFailed(params.userId, threadId);
    return;
  }

  const { containerUrl, containerName } = result.value;
  await tm.updateThread(threadId, {
    containerUrl,
    containerName,
    status: 'running',
  });
  emitThreadUpdated(params.userId, threadId, {
    status: 'running',
    containerUrl,
    containerName,
  });

  await forwardPromptToContainer(ctx, containerUrl, launch.augmentedPrompt);
}

/**
 * Forward the initial prompt to the container's Funny server.
 *
 * Security HI-5: `containerUrl` is returned by the project's launcher (a
 * project-config'd URL), so a compromised launcher response could point at a
 * cloud-metadata endpoint. `safeFetchUserUrl` blocks IMDS ranges while
 * allowing legitimate LAN container URLs.
 */
async function forwardPromptToContainer(
  ctx: ProjectThreadContext,
  containerUrl: string,
  augmentedPrompt: string,
): Promise<void> {
  const { params, defaults, threadId } = ctx;
  try {
    const res = await safeFetchUserUrl(`${containerUrl}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ctx.projectId,
        title: ctx.titleSource,
        mode: params.mode,
        provider: defaults.provider,
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        prompt: augmentedPrompt,
        images: params.images,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      log.error('Container rejected thread creation', { threadId, status: res.status, text });
    }
  } catch (err) {
    log.error('Failed to forward prompt to container', { threadId, error: String(err) });
  }
}
