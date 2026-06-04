import type { VisualizerManifest } from '@funny/shared';
import type { ComponentType } from 'react';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('visualizers');

/** Props a visualizer component receives. Kept minimal — because plugins share
 *  the host's React tree (full-trust model), they read theme / font size from
 *  host hooks rather than via props. (In milestone 2 these types move to the
 *  public `@funny/host` SDK and this file re-exports them.) */
export interface VisualizerProps {
  /** The source text to render (fenced-block contents or file contents). */
  source: string;
  /** True when rendered as a full file-preview pane rather than an inline block. */
  fill?: boolean;
}

/** A registered visualizer: serializable manifest plus its React component. */
export interface VisualizerPlugin extends VisualizerManifest {
  Component: ComponentType<VisualizerProps>;
}

const byFence = new Map<string, VisualizerPlugin>();
const byExt = new Map<string, VisualizerPlugin>();

/** Normalize an extension key: lowercase, no leading dot. */
function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

/**
 * Register a visualizer for its declared fences and file extensions.
 *
 * Conflict resolution: last registration wins (built-ins register first, so an
 * installed extension can override them). Overriding a *different* plugin logs
 * a warning; re-registering the same plugin id (HMR / double-invoke) is silent.
 */
export function registerVisualizer(plugin: VisualizerPlugin): void {
  for (const fence of plugin.contributes.fences ?? []) {
    const key = fence.toLowerCase();
    const existing = byFence.get(key);
    if (existing && existing.id !== plugin.id) {
      log.warn(`visualizer "${plugin.id}" overrides "${existing.id}" for fence "${key}"`);
    }
    byFence.set(key, plugin);
  }
  for (const ext of plugin.contributes.fileExtensions ?? []) {
    const key = normalizeExt(ext);
    const existing = byExt.get(key);
    if (existing && existing.id !== plugin.id) {
      log.warn(`visualizer "${plugin.id}" overrides "${existing.id}" for file ext ".${key}"`);
    }
    byExt.set(key, plugin);
  }
}

/** Visualizer for a fenced-code language (e.g. `'mermaid'`), or undefined. */
export function getVisualizerForFence(lang: string): VisualizerPlugin | undefined {
  return byFence.get(lang.toLowerCase());
}

/** Visualizer for a file extension (leading dot optional), or undefined. */
export function getVisualizerForFileExt(ext: string): VisualizerPlugin | undefined {
  return byExt.get(normalizeExt(ext));
}

/** Whether a file extension has a registered visualizer (gates `canPreview`). */
export function hasFileVisualizer(ext: string): boolean {
  return byExt.has(normalizeExt(ext));
}

/** Test-only: drop all registrations so each test starts from a clean slate. */
export function __resetVisualizerRegistry(): void {
  byFence.clear();
  byExt.clear();
}
