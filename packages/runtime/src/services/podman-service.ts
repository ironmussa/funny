/**
 * @domain subdomain: Remote Runtime
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: Git, Launcher API
 *
 * Orchestrates Podman container lifecycle for remote thread execution.
 * Pushes branches to origin, starts/stops containers via the launcher API,
 * and returns container URLs for direct client connection.
 */

import { push, getRemoteUrl } from '@funny/core/git';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync, errAsync } from 'neverthrow';

import { log } from '../lib/logger.js';
import { safeFetchUserUrl } from '../lib/ssrf-guard.js';

/** The launcher's request to start a container. */
interface LauncherStartRequest {
  containerName: string;
  repoMode: 'clone';
  repoUrl: string;
  repoRef: string;
  enableStreaming: boolean;
  authMode: 'local';
  gitToken: string | undefined;
}

async function launcherPost(url: string, body: LauncherStartRequest): Promise<Response> {
  const res = await safeFetchUserUrl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Launcher returned ${res.status}: ${text}`);
  }
  return res;
}

// ── Types ───────────────────────────────────────────────────────

export interface LaunchContainerOptions {
  threadId: string;
  projectPath: string;
  launcherUrl: string;
  branch: string;
  githubToken?: string;
}

export interface LaunchContainerResult {
  containerUrl: string;
  containerName: string;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Push the branch to origin, then start a Podman container via the launcher API.
 * The container clones the repo at the given branch and starts a Funny server.
 */
export function launchContainer(
  options: LaunchContainerOptions,
): ResultAsync<LaunchContainerResult, DomainError> {
  const { threadId, projectPath, launcherUrl, branch, githubToken } = options;

  if (!launcherUrl) {
    return errAsync(badRequest('Project has no launcher URL configured'));
  }

  // 1. Get remote URL
  return getRemoteUrl(projectPath).andThen((remoteUrl) => {
    if (!remoteUrl) {
      return errAsync(badRequest('Project has no git remote origin configured'));
    }

    // 2. Push branch to origin
    const identity = githubToken ? { githubToken } : undefined;
    return push(projectPath, identity).andThen(() => {
      // 3. Call launcher API to start container
      const containerName = `funny-${threadId}`;

      // Security HI-5: launcherUrl is project-config (anyone with project
      // write access can set it). Without a guard, the runner can be aimed
      // at `http://169.254.169.254/` (cloud-metadata IMDS) to exfiltrate
      // the host's IAM credentials. `safeFetchUserUrl` blocks that range
      // unconditionally while still allowing legitimate LAN launchers.
      return ResultAsync.fromPromise(
        launcherPost(`${launcherUrl}/start`, {
          containerName,
          repoMode: 'clone',
          repoUrl: remoteUrl,
          repoRef: branch,
          enableStreaming: false,
          authMode: 'local',
          gitToken: githubToken || undefined,
        }).then((res) => res.json()),
        (error) => internal(`Failed to start container: ${error}`),
      ).andThen((response: any) => {
        const status = response.container;
        if (!status?.funnyUrl) {
          return errAsync(internal('Launcher did not return a funnyUrl'));
        }

        log.info(`Container started for thread ${threadId}`, {
          namespace: 'podman',
          containerName: status.containerName,
          funnyUrl: status.funnyUrl,
        });

        return ResultAsync.fromSafePromise(
          Promise.resolve({
            containerUrl: status.funnyMachineUrl || status.funnyUrl,
            containerName: status.containerName || containerName,
          }),
        );
      });
    });
  });
}
