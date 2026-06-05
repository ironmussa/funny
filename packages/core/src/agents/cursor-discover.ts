/**
 * Cursor model discovery — now a thin shim over the manifest-driven
 * {@link discoverAcpModels}. Kept so existing callers keep importing
 * `discoverCursorModels`.
 */

import { cursorManifest } from '@funny/shared/provider-manifests';

import {
  discoverAcpModels,
  type DiscoverAcpModelsOptions,
  type DiscoverAcpModelsResult,
  type DiscoveredAcpModel,
} from './acp-discover.js';

export type DiscoveredCursorModel = DiscoveredAcpModel;
export type DiscoverCursorModelsResult = DiscoverAcpModelsResult;

export function discoverCursorModels(
  opts: DiscoverAcpModelsOptions = {},
): Promise<DiscoverAcpModelsResult> {
  return discoverAcpModels(cursorManifest, opts);
}
