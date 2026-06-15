import { beforeEach, describe, expect, test } from 'vitest';

import {
  __resetVisualizerRegistry,
  getVisualizerForFence,
  getVisualizerForFileExt,
  hasFileVisualizer,
  registerVisualizer,
  type VisualizerPlugin,
} from '@/lib/visualizer-registry';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

const NOOP_COMPONENT: VisualizerPlugin['Component'] = () => null;

function makePlugin(id: string, contributes: VisualizerPlugin['contributes']): VisualizerPlugin {
  return { id, version: '1.0.0', contributes, Component: NOOP_COMPONENT };
}

beforeEach(() => {
  __resetVisualizerRegistry();
});

describe('visualizer registry', () => {
  test('resolves a registered fence, case-insensitively', () => {
    const plugin = makePlugin('test/foo', { fences: ['Foo'] });
    registerVisualizer(plugin);
    expect(getVisualizerForFence('foo')).toBe(plugin);
    expect(getVisualizerForFence('FOO')).toBe(plugin);
    expect(getVisualizerForFence('bar')).toBeUndefined();
  });

  test('resolves a file extension with or without a leading dot', () => {
    const plugin = makePlugin('test/bar', { fileExtensions: ['.bar'] });
    registerVisualizer(plugin);
    expect(getVisualizerForFileExt('bar')).toBe(plugin);
    expect(getVisualizerForFileExt('.bar')).toBe(plugin);
    expect(hasFileVisualizer('bar')).toBe(true);
    expect(hasFileVisualizer('baz')).toBe(false);
  });

  test('last registration wins for a contested fence', () => {
    const first = makePlugin('test/first', { fences: ['x'] });
    const second = makePlugin('test/second', { fences: ['x'] });
    registerVisualizer(first);
    registerVisualizer(second);
    expect(getVisualizerForFence('x')).toBe(second);
  });
});

describe('built-in visualizers (regression: Mermaid + CSV dispatch)', () => {
  beforeEach(() => {
    registerBuiltinVisualizers();
  });

  test('mermaid fence dispatches to the mermaid visualizer', () => {
    expect(getVisualizerForFence('mermaid')?.id).toBe('@funny/visualizer-mermaid');
  });

  test('mermaid contributes no file extension', () => {
    expect(hasFileVisualizer('mermaid')).toBe(false);
  });

  test('csv is built-in: fence + .csv file preview', () => {
    expect(getVisualizerForFence('csv')?.id).toBe('@funny/visualizer-csv');
    expect(hasFileVisualizer('csv')).toBe(true);
    expect(getVisualizerForFileExt('.csv')?.id).toBe('@funny/visualizer-csv');
  });

  test('re-registering the built-ins is idempotent', () => {
    registerBuiltinVisualizers();
    expect(getVisualizerForFence('mermaid')?.id).toBe('@funny/visualizer-mermaid');
    expect(getVisualizerForFence('csv')?.id).toBe('@funny/visualizer-csv');
  });

  test('video is a built-in binary file visualizer (no fence)', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'mkv']) {
      const plugin = getVisualizerForFileExt(ext);
      expect(plugin?.id).toBe('@funny/visualizer-video');
      expect(plugin?.contributes.binary).toBe(true);
    }
    // Binary visualizers claim file extensions only — never a fenced lang.
    expect(getVisualizerForFence('mp4')).toBeUndefined();
  });

  test('image is a built-in binary file visualizer (no fence)', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']) {
      const plugin = getVisualizerForFileExt(ext);
      expect(plugin?.id).toBe('@funny/visualizer-image');
      expect(plugin?.contributes.binary).toBe(true);
    }
    expect(getVisualizerForFence('png')).toBeUndefined();
  });
});
