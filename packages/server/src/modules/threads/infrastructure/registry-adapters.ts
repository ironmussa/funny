/**
 * Persistence-facing adapters: the central thread registry (DB) and the
 * in-memory thread→runner routing cache.
 */

import * as runnerResolver from '../../../services/runner-resolver.js';
import * as threadRegistry from '../../../services/thread-registry.js';
import type { ThreadRegistryPort, ThreadRoutingCachePort } from '../application/ports.js';

export const threadRegistryAdapter: ThreadRegistryPort = {
  register: (entry) => threadRegistry.registerThread({ ...entry }),
};

export const threadRoutingCacheAdapter: ThreadRoutingCachePort = {
  remember: (threadId, userId, runnerId) =>
    runnerResolver.cacheThreadRunner(threadId, userId, runnerId),
};
