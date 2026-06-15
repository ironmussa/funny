import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { __resetVisualizerRegistry, getVisualizerForFileExt } from '@/lib/visualizer-registry';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

beforeEach(() => {
  __resetVisualizerRegistry();
  registerBuiltinVisualizers();
});

afterEach(cleanup);

const Video = () => {
  const plugin = getVisualizerForFileExt('mp4');
  if (!plugin) throw new Error('video visualizer not registered');
  return plugin.Component;
};

describe('built-in video visualizer', () => {
  test('renders a <video> from the raw-bytes src', () => {
    const Component = Video();
    render(
      createElement(Component, { source: '', src: '/api/files/raw?path=%2Fa.mp4', fill: true }),
    );
    const video = screen.getByTestId('visualizer-video') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(new URL(video.src).searchParams.get('path')).toBe('/a.mp4');
  });

  test('renders nothing without a src (e.g. an inline fenced block)', () => {
    const Component = Video();
    const { container } = render(createElement(Component, { source: '' }));
    expect(container.querySelector('video')).toBeNull();
  });
});
