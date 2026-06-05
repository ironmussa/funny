/**
 * opencode model discovery — now a thin shim over the manifest-driven
 * {@link discoverAcpModels}. Kept so existing callers / tests
 * (`opencode-discover.test.ts`) keep importing `discoverOpenCodeModels`.
 */

import { opencodeManifest } from '@funny/shared/provider-manifests';

import {
  discoverAcpModels,
  type DiscoverAcpModelsOptions,
  type DiscoverAcpModelsResult,
  type DiscoveredAcpModel,
} from './acp-discover.js';

export type DiscoveredOpenCodeModel = DiscoveredAcpModel;
export type DiscoverOpenCodeModelsResult = DiscoverAcpModelsResult;

export function discoverOpenCodeModels(
  opts: DiscoverAcpModelsOptions = {},
): Promise<DiscoverAcpModelsResult> {
  return discoverAcpModels(opencodeManifest, opts);
}
