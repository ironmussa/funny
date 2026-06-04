import type { VisualizerContributes, VisualizerManifest } from '@funny/shared';
/**
 * `@funny/host` — the public host SDK for funny visualizer plugins.
 *
 * This is the **stable, frozen contract** third-party authors compile against.
 * A visualizer plugin:
 *   - declares `react` and `@funny/host` as `peerDependencies`,
 *   - builds to ESM that imports those as bare specifiers,
 *   - default-exports a {@link VisualizerPlugin}.
 *
 * At runtime inside the funny host, an import map (see
 * `@funny/shared/visualizer-importmap`) rewrites `react` and `@funny/host` to
 * the host's own module instances, so the plugin shares the host's single React
 * tree (full-trust model) and never bundles a second React.
 *
 * Keep this surface SMALL — every export here is a compatibility commitment.
 */
import type { ComponentType } from 'react';

export type { VisualizerContributes, VisualizerManifest } from '@funny/shared';

/** Props a visualizer component receives. Minimal by design: because plugins
 *  share the host's React tree, they read theme / font size from the host hooks
 *  below rather than via props. */
export interface VisualizerProps {
  /** Source text to render: fenced-block contents, or full file contents. */
  source: string;
  /** True when rendered as a full file-preview pane rather than an inline block. */
  fill?: boolean;
}

/** A visualizer plugin: serializable manifest + its React component. */
export interface VisualizerPlugin extends VisualizerManifest {
  Component: ComponentType<VisualizerProps>;
}

/** The host hooks exposed to plugins at runtime. */
export interface FunnyHostApi {
  /** Host's resolved color scheme, collapsed to light/dark. */
  useFunnyTheme(): 'light' | 'dark';
  /** Host's active prose font size in pixels (respects Settings > Appearance). */
  useFunnyFontSize(): number;
}

function hostApi(): FunnyHostApi {
  const api = (globalThis as { __FUNNY_HOST__?: FunnyHostApi }).__FUNNY_HOST__;
  if (!api) {
    throw new Error(
      '@funny/host was used outside the funny host runtime. Visualizer plugins ' +
        'only run when loaded by funny (the host installs the runtime globals).',
    );
  }
  return api;
}

/** React hook: the host's resolved theme (`'light'` | `'dark'`). */
export function useFunnyTheme(): 'light' | 'dark' {
  return hostApi().useFunnyTheme();
}

/** React hook: the host's active prose font size in pixels. */
export function useFunnyFontSize(): number {
  return hostApi().useFunnyFontSize();
}
