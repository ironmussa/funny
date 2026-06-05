/**
 * Pi model discovery — now a thin shim over the manifest-driven
 * {@link discoverAcpModels}. Kept so existing callers keep importing
 * `discoverPiModels`.
 */

import { piManifest } from '@funny/shared/provider-manifests';

import {
  discoverAcpModels,
  type DiscoverAcpModelsOptions,
  type DiscoverAcpModelsResult,
  type DiscoveredAcpModel,
} from './acp-discover.js';

export type DiscoveredPiModel = DiscoveredAcpModel;
export type DiscoverPiModelsResult = DiscoverAcpModelsResult;

export function discoverPiModels(
  opts: DiscoverAcpModelsOptions = {},
): Promise<DiscoverAcpModelsResult> {
  return discoverAcpModels(piManifest, opts);
}
