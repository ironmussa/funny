import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { render, cleanup } from '@testing-library/react';
import { createElement } from 'react';

import { resetVisualizerRegistry, getVisualizerForFileExt } from '@/lib/visualizer-registry';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

import { getByTestIdOfType } from '../helpers/builders-lib';

beforeEach(() => {
  resetVisualizerRegistry();
  registerBuiltinVisualizers();
});

afterEach(cleanup);

const Image = (ext: string) => {
  const plugin = getVisualizerForFileExt(ext);
  if (!plugin) throw new Error(`image visualizer not registered for .${ext}`);
  return plugin.Component;
};

describe('built-in image visualizer', () => {
  test('renders an <img> from the raw-bytes src', () => {
    const Component = Image('png');
    render(
      createElement(Component, { source: '', src: '/api/files/raw?path=%2Fa.png', fill: true }),
    );
    const img = getByTestIdOfType('visualizer-image', HTMLImageElement);
    expect(img.tagName).toBe('IMG');
    expect(new URL(img.src).searchParams.get('path')).toBe('/a.png');
  });

  test('is registered as a binary visualizer for the common image extensions', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']) {
      const plugin = getVisualizerForFileExt(ext);
      expect(plugin?.contributes.binary, `.${ext}`).toBe(true);
    }
  });

  test('renders nothing without a src (e.g. an inline fenced block)', () => {
    const Component = Image('png');
    const { container } = render(createElement(Component, { source: '' }));
    expect(container.querySelector('img')).toBeNull();
  });
});
