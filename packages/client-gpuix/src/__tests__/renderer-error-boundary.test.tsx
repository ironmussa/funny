import { describe, expect, test } from 'bun:test';

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

import {
  NATIVE_RENDERER_ERROR_PALETTE,
  NativeRendererFailureSurface,
} from '../renderer-error-boundary';

interface SurfaceProps {
  children: ReactNode;
  style: Record<string, unknown>;
  testId?: string;
}

interface TextProps {
  children: ReactNode;
  style: { color: string };
}

describe('native renderer failure surface', () => {
  test('uses an explicit high-contrast palette and actionable content', () => {
    const surface = NativeRendererFailureSurface({
      error: 'render exploded',
    }) as ReactElement<SurfaceProps>;
    expect(surface.props.testId).toBe('native-renderer-error');
    expect(surface.props.style).toMatchObject({
      width: '100%',
      height: '100%',
      backgroundColor: NATIVE_RENDERER_ERROR_PALETTE.background,
      color: NATIVE_RENDERER_ERROR_PALETTE.foreground,
      borderColor: NATIVE_RENDERER_ERROR_PALETTE.border,
    });

    const children = Children.toArray(surface.props.children).filter(isValidElement<TextProps>);
    expect(children.map((child) => child.props.children)).toEqual([
      'Native renderer recovered from an error',
      'render exploded',
      'Restart GPUIX or run `bun run dev:client` to use the web renderer.',
    ]);
    expect(children.map((child) => child.props.style.color)).toEqual([
      NATIVE_RENDERER_ERROR_PALETTE.danger,
      NATIVE_RENDERER_ERROR_PALETTE.foreground,
      NATIVE_RENDERER_ERROR_PALETTE.muted,
    ]);
  });
});
