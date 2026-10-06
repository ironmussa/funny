/**
 * Production wiring for the threads module. This is the only file that
 * assembles concrete adapters. Runner transport and presence are per-request
 * Hono bindings, so composition runs per request (plain closures, no container).
 */

import type { RunnerPresencePort, RunnerRequestPort } from '../../services/runner-ports.js';
import { makeCreateThread, type CreateThread } from './application/create-thread.js';
import {
  threadRegistryAdapter,
  threadRoutingCacheAdapter,
} from './infrastructure/registry-adapters.js';
import {
  createRemoteCreationAdapter,
  createRunnerResolutionAdapter,
  runnerPathFor,
} from './infrastructure/runner-adapters.js';

/** Runner-side creation path for an intent (used by the route for failure logs). */
export { runnerPathFor };

export interface ThreadCreationEnv {
  runnerPresence?: RunnerPresencePort;
  runnerRequests?: RunnerRequestPort;
}

export function composeCreateThread(env: ThreadCreationEnv | undefined): CreateThread {
  return makeCreateThread({
    runners: createRunnerResolutionAdapter(env?.runnerPresence),
    remote: createRemoteCreationAdapter(env?.runnerRequests),
    registry: threadRegistryAdapter,
    routingCache: threadRoutingCacheAdapter,
  });
}
