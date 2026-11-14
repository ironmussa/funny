/**
 * Wires the factory from its real parts. Production passes the real edges
 * (`fetch`, the system clock, the step runner as a child process); the
 * whole-factory tests pass an HTTP-level fake GitHub, a fake clock and an
 * in-process step runner with a fake agent, and nothing else changes.
 */

import {
  createRunnerTemplateManager,
  productionSandboxProviders,
  resolveServerRunnerBuild,
  type RunnerBuild,
  type RunnerTemplateManager,
  type SandboxError,
  type SandboxProvider,
} from '@funny/sandbox';
import { ok, ResultAsync, type Result } from 'neverthrow';

import { createFactoryAppTokens } from './adapters/factory-app.js';
import { createGithubAppIssueSource } from './adapters/github-app-issue-source.js';
import { createGithubAppPullRequests } from './adapters/github-app-pull-requests.js';
import { createSandboxWorkspaces, type SandboxLayout } from './adapters/sandbox-workspace.js';
import { workspacesByKind } from './adapters/workspace-kinds.js';
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
  /** How long one repository's admission may take per tick. */
  admissionTimeoutMs?: number;
  /** The sandbox provider; default: the configured one from `@funny/sandbox`'s catalog. */
  sandboxProvider?: SandboxProvider;
  /** The build sandboxes get; default: the orchestrator's own commit. */
  runnerBuild?: RunnerBuild;
  sandboxLayout?: Partial<SandboxLayout>;
  /** Between two looks at a step running in a sandbox. */
  sandboxPollMs?: number;
}

/** The configured sandbox provider, from the production catalog. */
function configuredProvider(settings: FactorySettings, secrets: FactorySecrets) {
  const registry = productionSandboxProviders();
  if (registry.isErr() || !settings.sandbox) return null;
  const provider = registry.value.instantiate({
    providerId: settings.sandbox.provider,
    credential: secrets.sandboxCredential ?? '',
    config: {},
  });
  return provider.isOk() ? provider.value : null;
}

/**
 * The runner template manager of the factory's build, resolved the first
 * time a sandbox is needed (the orchestrator's own commit, unless given).
 */
function lazyTemplates(build: RunnerBuild | undefined, log: FactoryLog): RunnerTemplateManager {
  let manager: Promise<Result<RunnerTemplateManager, SandboxError>> | null = null;
  const get = () =>
    (manager ??= (build ? Promise.resolve(ok(build)) : resolveServerRunnerBuild()).then(
      (resolved) =>
        resolved
          .map((b) => createRunnerTemplateManager(b, { log }))
          .mapErr((e): SandboxError => ({ kind: 'template-missing', message: e.message })),
    ));
  const use = <T>(fn: (m: RunnerTemplateManager) => ResultAsync<T, SandboxError>) =>
    new ResultAsync(get()).andThen(fn);
  return {
    current: (provider) => use((m) => m.current(provider)),
    ensure: (accountKey, provider) => use((m) => m.ensure(accountKey, provider)),
    isBuilding: () => false,
  };
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
    admissionTimeoutMs: edges.admissionTimeoutMs,
    issues: createGithubAppIssueSource({ tokens, fetch: edges.fetch, api: edges.api }),
    pullRequests: createGithubAppPullRequests({ tokens, fetch: edges.fetch, api: edges.api }),
    workspaces: workspacesByKind({
      worktree: createWorktreeWorkspaces({
        tokens,
        launchStep: edges.launchStep,
        clock: edges.clock,
        log: core.log,
        env: edges.env,
        modelKey: core.secrets.modelKey,
        author: core.settings.github.author,
      }),
      sandbox: sandboxWorkspaces(core, edges, tokens),
    }),
  });
}

function sandboxWorkspaces(
  core: { settings: FactorySettings; secrets: FactorySecrets; log: FactoryLog },
  edges: FactoryEdges,
  tokens: ReturnType<typeof createFactoryAppTokens>,
) {
  const { settings } = core;
  const provider = edges.sandboxProvider ?? configuredProvider(settings, core.secrets);
  if (!provider || !settings.sandbox) return null;
  const size = provider.capabilities().sizes.find((s) => s.id === settings.sandbox!.size);
  const sizeId = size?.id ?? provider.capabilities().sizes.find((s) => s.default)?.id ?? 'default';
  return createSandboxWorkspaces({
    provider,
    templates: lazyTemplates(edges.runnerBuild, core.log),
    accountKey: `${settings.sandbox.provider}:${settings.github.login}`,
    sizeId,
    tokens,
    clock: edges.clock,
    log: core.log,
    modelKey: core.secrets.modelKey,
    author: settings.github.author,
    layout: edges.sandboxLayout,
    pollIntervalMs: edges.sandboxPollMs,
  });
}
