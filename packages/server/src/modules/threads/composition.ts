/**
 * Production wiring for the threads module. This is the only file that
 * assembles concrete adapters. Runner transport and presence are per-request
 * Hono bindings, so composition runs per request (plain closures, no container).
 */

import { runnerAccess } from '../../services/runner-access/index.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../../services/runner-ports.js';
import { makeCreateThread, type CreateThread } from './application/create-thread.js';
import { makeForkThread, type ForkThread } from './application/fork-thread.js';
import {
  threadRegistryAdapter,
  threadRoutingCacheAdapter,
} from './infrastructure/registry-adapters.js';
import {
  createRemoteCreationAdapter,
  createRemoteForkAdapter,
  createRunnerResolutionAdapter,
  createSourceRunnerResolutionAdapter,
  runnerPathFor,
  type RunnerAdapterDeps,
} from './infrastructure/runner-adapters.js';

/** Runner-side creation path for an intent (used by the route for failure logs). */
export { runnerPathFor };

export interface ThreadCreationEnv {
  runnerPresence?: RunnerPresencePort;
  runnerRequests?: RunnerRequestPort;
}

function adapterDeps(env: ThreadCreationEnv | undefined): RunnerAdapterDeps {
  return { presence: env?.runnerPresence, requests: env?.runnerRequests, access: runnerAccess };
}

export function composeCreateThread(env: ThreadCreationEnv | undefined): CreateThread {
  const deps = adapterDeps(env);
  return makeCreateThread({
    runners: createRunnerResolutionAdapter(deps),
    remote: createRemoteCreationAdapter(deps),
    registry: threadRegistryAdapter,
    routingCache: threadRoutingCacheAdapter,
  });
}

export function composeForkThread(env: ThreadCreationEnv | undefined): ForkThread {
  const deps = adapterDeps(env);
  return makeForkThread({
    runners: createSourceRunnerResolutionAdapter(deps),
    remote: createRemoteForkAdapter(deps),
    registry: threadRegistryAdapter,
    routingCache: threadRoutingCacheAdapter,
  });
}
