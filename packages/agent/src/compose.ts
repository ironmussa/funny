/**
 * Wires the factory from its real parts. Production passes the real edges
 * (`fetch`, the system clock, the step runner as a child process); the
 * whole-factory tests pass an HTTP-level fake GitHub, a fake clock and an
 * in-process step runner with a fake agent, and nothing else changes.
 */

import { createFactoryAppTokens } from './adapters/factory-app.js';
import { createGithubAppIssueSource } from './adapters/github-app-issue-source.js';
import { createGithubAppPullRequests } from './adapters/github-app-pull-requests.js';
import { createWorktreeWorkspaces } from './adapters/worktree-workspace.js';
import { createFactory, type Factory } from './factory.js';
import type { FactoryLog } from './infrastructure/factory-log.js';
import type { Clock } from './ports/clock.js';
import type { RunStore } from './ports/run-store.js';
import type { StepLauncher } from './ports/workspaces.js';
import type { FactorySettings } from './settings/schema.js';
import type { FactorySecrets } from './settings/secrets.js';

export interface FactoryEdges {
  /** GitHub's REST API is reached through this. */
  fetch?: typeof fetch;
  /** API root; `https://api.github.com` by default. */
  api?: string;
  clock: Clock;
  launchStep: StepLauncher;
  /** The orchestrator's environment (secrets already removed). */
  env: Readonly<Record<string, string | undefined>>;
}

export function composeFactory(
  core: {
    settings: FactorySettings;
    secrets: FactorySecrets;
    store: RunStore;
    log: FactoryLog;
    home: string;
  },
  edges: FactoryEdges,
): Factory {
  const tokens = createFactoryAppTokens({
    app: core.secrets.app,
    fetch: edges.fetch,
    api: edges.api,
    clock: edges.clock,
  });
  return createFactory({
    settings: core.settings,
    store: core.store,
    log: core.log,
    home: core.home,
    clock: edges.clock,
    issues: createGithubAppIssueSource({ tokens, fetch: edges.fetch, api: edges.api }),
    pullRequests: createGithubAppPullRequests({ tokens, fetch: edges.fetch, api: edges.api }),
    workspaces: createWorktreeWorkspaces({
      tokens,
      launchStep: edges.launchStep,
      clock: edges.clock,
      log: core.log,
      env: edges.env,
      modelKey: core.secrets.modelKey,
      author: core.settings.github.author,
    }),
  });
}
