/**
 * The production list of sandbox providers (change thread-sandboxes). This and
 * `providers/` are the only places allowed to import a provider adapter; add a
 * provider here once its adapter passes the shared contract suite.
 */

import { boatProviderEntry } from './providers/boat/boat-provider.js';
import { instaboxProviderEntry } from './providers/instabox/instabox-provider.js';
import { createSandboxProviderRegistry, type SandboxProviderEntry } from './registry.js';

const PROVIDERS: SandboxProviderEntry<any>[] = [boatProviderEntry, instaboxProviderEntry];

/** Registry of every production sandbox provider. */
export function productionSandboxProviders() {
  return createSandboxProviderRegistry(PROVIDERS);
}
